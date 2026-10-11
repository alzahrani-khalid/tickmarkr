// v2.7.8 T2 — the CI record reporter (FORMAT F2, specs/v2.7.8-sharded-ci.spec.md). vitest.config.ts adds
// it only when TICKMARKR_CI_RECORD is set at config load, passing the resolved path as `outputFile`.
// At onTestRunEnd it writes ONE JSON document atomically (temp file, then rename):
//   {"schema": "tickmarkr-ci-record/1", "head": <HEAD sha|null>, "shard": {"index","count"}|null,
//    "files": [{"file","project","state","durationMs"}]}  — files sorted by file, then project.
// durationMs sums the five module diagnostics and rounds ONCE; an absent diagnostic counts 0, and a
// negative or non-finite one throws RecordError — a record is never written over a corrupt duration.
// Library law (SHARED CONVENTIONS): no CLI; readers and writers throw the named errors below.
import { execFileSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import type { TestModule, Vitest } from "vitest/node";
import { isRecord, jsonLine } from "./json.js";
import { isCanonicalPath, rootRelative } from "./shard.js";

export const RECORD_SCHEMA = "tickmarkr-ci-record/1";
export const RECORD_STATES = ["passed", "failed", "skipped", "pending", "queued"] as const;
export type RecordState = (typeof RECORD_STATES)[number];
export type RecordFile = { file: string; project: string; state: RecordState; durationMs: number };
export type CiRecord = {
  schema: typeof RECORD_SCHEMA;
  head: string | null;
  shard: { index: number; count: number } | null;
  files: RecordFile[];
};

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordError";
  }
}

const DIAGNOSTICS = ["environmentSetupDuration", "prepareDuration", "collectDuration", "setupDuration", "duration"] as const;
type Diagnostic = Partial<Record<(typeof DIAGNOSTICS)[number], number>>;
const HEAD = /^[0-9a-f]{40}$/;
const isState = (value: unknown): value is RecordState => (RECORD_STATES as readonly unknown[]).includes(value);
const isShard = (value: unknown): value is { index: number; count: number } =>
  isRecord(value) && Object.keys(value).sort().join(",") === "count,index"
  && Number.isSafeInteger(value.index) && Number.isSafeInteger(value.count)
  && (value.index as number) >= 1 && (value.index as number) <= (value.count as number);
const byFileThenProject = (a: RecordFile, b: RecordFile) =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.project < b.project ? -1 : a.project > b.project ? 1 : 0;

/** One module's durationMs: the five diagnostics summed, then rounded once. */
export function recordDurationMs(diagnostic: Diagnostic, file: string): number {
  let sum = 0;
  for (const key of DIAGNOSTICS) {
    const value = diagnostic[key] ?? 0;
    if (!Number.isFinite(value) || value < 0) throw new RecordError(`${file}: diagnostic ${key} is ${value}, not a finite nonnegative number`);
    sum += value;
  }
  const ms = Math.round(sum);
  if (!Number.isSafeInteger(ms)) throw new RecordError(`${file}: durationMs ${ms} is not a safe integer`);
  return ms;
}

/** HEAD of the repository at `root`, or null outside one. */
export function headOf(root: string): string | null {
  try {
    const head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return HEAD.test(head) ? head : null;
  } catch {
    return null;
  }
}

/** The FORMAT F2 document for a finished run. Throws RecordError on any value the format cannot hold. */
export function buildRecord(root: string, head: string | null, shard: { index: number; count: number } | undefined, modules: readonly TestModule[]): CiRecord {
  const files = modules.map((module): RecordFile => {
    const file = rootRelative(root, module.moduleId);
    if (!isCanonicalPath(file)) throw new RecordError(`${module.moduleId}: not a canonical path under ${root}`);
    const project = module.project.name;
    if (project === "") throw new RecordError(`${file}: empty project name`);
    const state = module.state();
    if (!isState(state)) throw new RecordError(`${file}: unknown state ${JSON.stringify(state)}`);
    return { file, project, state, durationMs: recordDurationMs(module.diagnostic(), file) };
  }).sort(byFileThenProject);
  const record: CiRecord = { schema: RECORD_SCHEMA, head, shard: shard ? { index: shard.index, count: shard.count } : null, files };
  if (record.shard && !isShard(record.shard)) throw new RecordError(`shard ${JSON.stringify(record.shard)} is not index <= count positive integers`);
  return record;
}

/** Validate a parsed FORMAT F2 document; `source` names it in every error. Consumers accept any order. */
export function parseRecord(doc: unknown, source: string): CiRecord {
  const fail = (why: string): never => { throw new RecordError(`${source}: ${why}`); };
  if (!isRecord(doc)) return fail("not a JSON object");
  if (Object.keys(doc).sort().join(",") !== "files,head,schema,shard") fail("keys must be exactly schema, head, shard and files");
  if (doc.schema !== RECORD_SCHEMA) fail(`schema must be ${JSON.stringify(RECORD_SCHEMA)}`);
  if (doc.head !== null && !(typeof doc.head === "string" && HEAD.test(doc.head))) fail("head must be 40 lowercase hex characters or null");
  if (doc.shard !== null && !isShard(doc.shard)) fail("shard must be null or {index, count} with 1 <= index <= count");
  if (!Array.isArray(doc.files)) return fail("files must be an array");
  const files = doc.files.map((entry, i): RecordFile => {
    if (!isRecord(entry) || Object.keys(entry).sort().join(",") !== "durationMs,file,project,state") return fail(`files[${i}] must hold exactly file, project, state and durationMs`);
    const { file, project, state, durationMs } = entry;
    if (typeof file !== "string" || !isCanonicalPath(file)) fail(`files[${i}].file is not a canonical path`);
    if (typeof project !== "string" || project === "") fail(`files[${i}].project must be a nonempty string`);
    if (!isState(state)) fail(`files[${i}].state ${JSON.stringify(state)} is not a record state`);
    if (!Number.isSafeInteger(durationMs) || (durationMs as number) < 0) fail(`files[${i}].durationMs must be a nonnegative safe integer`);
    return { file: file as string, project: project as string, state: state as RecordState, durationMs: durationMs as number };
  });
  return { schema: RECORD_SCHEMA, head: doc.head as string | null, shard: doc.shard as CiRecord["shard"], files };
}

export default class CiRecordReporter {
  private ctx: Vitest | undefined;
  constructor(private readonly options: { outputFile?: string } = {}) {}

  onInit(ctx: Vitest): void {
    this.ctx = ctx;
  }

  onTestRunEnd(modules: readonly TestModule[]): void {
    const path = this.options.outputFile;
    if (!path) throw new RecordError("the CI record reporter needs an outputFile");
    const root = this.ctx!.config.root;
    const record = buildRecord(root, headOf(root), this.ctx!.config.shard, modules);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${jsonLine(record)}\n`);
    renameSync(temp, path);
  }
}
