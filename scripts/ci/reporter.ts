// v2.7.8 T2 — the CI record reporter; v2.8.2 T1 (ANL-022 §7.1) moves it to FORMAT F3. vitest.config.ts adds
// it only when TICKMARKR_CI_RECORD is set at config load, passing the resolved path as `outputFile`.
// At onTestRunEnd(modules, unhandledErrors, reason) it writes ONE JSON document atomically (temp, then rename):
//   {"schema": "tickmarkr-ci-record/2", "head": <HEAD sha|null>, "shard": {"index","count"}|null,
//    "files": [{"file","project","state","durationMs"}], "reason": "passed"|"failed"|"interrupted",
//    "unhandled": [{"name","message","type"}], "tests": [{"file","project","name","state"}]}
// files sorted by file, then project; unhandled in Vitest's order, each error's name and type (null when
// absent) and its WHOLE message; tests one entry per test case (TestCase.fullName, result().state), sorted
// by file, project, then name. Every reader reads F3 only: an F2 document is another schema.
// durationMs sums the five module diagnostics and rounds ONCE; an absent diagnostic counts 0, and a
// negative or non-finite one throws RecordError — a record is never written over a corrupt duration.
// Library law (SHARED CONVENTIONS): no CLI; readers and writers throw the named errors below.
import { execFileSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import type { SerializedError, TestModule, TestRunEndReason, Vitest } from "vitest/node";
import { isRecord, jsonLine } from "./json.js";
import { isCanonicalPath, rootRelative } from "./shard.js";

export const RECORD_SCHEMA = "tickmarkr-ci-record/2";
export const RECORD_STATES = ["passed", "failed", "skipped", "pending", "queued"] as const;
export type RecordState = (typeof RECORD_STATES)[number];
export const TEST_STATES = ["passed", "failed", "skipped", "pending"] as const;
export type TestState = (typeof TEST_STATES)[number];
export const RUN_REASONS = ["passed", "failed", "interrupted"] as const;
export type RunReason = (typeof RUN_REASONS)[number];
export type RecordFile = { file: string; project: string; state: RecordState; durationMs: number };
export type RecordTest = { file: string; project: string; name: string; state: TestState };
export type RecordUnhandled = { name: string | null; message: string; type: string | null };
export type CiRecord = {
  schema: typeof RECORD_SCHEMA;
  head: string | null;
  shard: { index: number; count: number } | null;
  files: RecordFile[];
  reason: RunReason;
  unhandled: RecordUnhandled[];
  tests: RecordTest[];
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
const isTestState = (value: unknown): value is TestState => (TEST_STATES as readonly unknown[]).includes(value);
const isReason = (value: unknown): value is RunReason => (RUN_REASONS as readonly unknown[]).includes(value);
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const isShard = (value: unknown): value is { index: number; count: number } =>
  isRecord(value) && Object.keys(value).sort().join(",") === "count,index"
  && Number.isSafeInteger(value.index) && Number.isSafeInteger(value.count)
  && (value.index as number) >= 1 && (value.index as number) <= (value.count as number);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byFileThenProject = (a: { file: string; project: string }, b: { file: string; project: string }) =>
  compare(a.file, b.file) || compare(a.project, b.project);
const byFileProjectName = (a: RecordTest, b: RecordTest) => byFileThenProject(a, b) || compare(a.name, b.name);

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

/** One unhandled error as F3 holds it: name and type when they are strings (else null), the WHOLE message. */
export function recordUnhandled(error: SerializedError): RecordUnhandled {
  const { name, message, type } = error as SerializedError & { type?: unknown };
  return { name: typeof name === "string" ? name : null, message: typeof message === "string" ? message : String(message), type: typeof type === "string" ? type : null };
}

/** The FORMAT F3 document for a finished run. Throws RecordError on any value the format cannot hold. */
export function buildRecord(
  root: string, head: string | null, shard: { index: number; count: number } | undefined, modules: readonly TestModule[],
  unhandledErrors: readonly SerializedError[] = [], reason: RunReason = "passed",
): CiRecord {
  if (!isReason(reason)) throw new RecordError(`unknown run reason ${JSON.stringify(reason)}`);
  const tests: RecordTest[] = [];
  const files = modules.map((module): RecordFile => {
    const file = rootRelative(root, module.moduleId);
    if (!isCanonicalPath(file)) throw new RecordError(`${module.moduleId}: not a canonical path under ${root}`);
    const project = module.project.name;
    if (project === "") throw new RecordError(`${file}: empty project name`);
    const state = module.state();
    if (!isState(state)) throw new RecordError(`${file}: unknown state ${JSON.stringify(state)}`);
    for (const testCase of module.children.allTests()) {
      const testState = testCase.result().state;
      if (!isTestState(testState)) throw new RecordError(`${file} > ${testCase.fullName}: unknown test state ${JSON.stringify(testState)}`);
      tests.push({ file, project, name: testCase.fullName, state: testState });
    }
    return { file, project, state, durationMs: recordDurationMs(module.diagnostic(), file) };
  }).sort(byFileThenProject);
  const record: CiRecord = {
    schema: RECORD_SCHEMA, head, shard: shard ? { index: shard.index, count: shard.count } : null, files,
    reason, unhandled: unhandledErrors.map(recordUnhandled), tests: tests.sort(byFileProjectName),
  };
  if (record.shard && !isShard(record.shard)) throw new RecordError(`shard ${JSON.stringify(record.shard)} is not index <= count positive integers`);
  return record;
}

/** Validate a parsed FORMAT F3 document; `source` names it in every error. Consumers accept any order. */
export function parseRecord(doc: unknown, source: string): CiRecord {
  const fail = (why: string): never => { throw new RecordError(`${source}: ${why}`); };
  if (!isRecord(doc)) return fail("not a JSON object");
  if (Object.keys(doc).sort().join(",") !== "files,head,reason,schema,shard,tests,unhandled") fail("keys must be exactly schema, head, shard, files, reason, unhandled and tests");
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
  if (!isReason(doc.reason)) fail(`reason ${JSON.stringify(doc.reason)} is not passed, failed or interrupted`);
  if (!Array.isArray(doc.unhandled)) return fail("unhandled must be an array");
  const unhandled = doc.unhandled.map((entry, i): RecordUnhandled => {
    if (!isRecord(entry) || Object.keys(entry).sort().join(",") !== "message,name,type") return fail(`unhandled[${i}] must hold exactly name, message and type`);
    const { name, message, type } = entry;
    if (!isNullableString(name) || typeof message !== "string" || !isNullableString(type)) fail(`unhandled[${i}] needs a string message and a string or null name and type`);
    return { name: name as string | null, message: message as string, type: type as string | null };
  });
  if (!Array.isArray(doc.tests)) return fail("tests must be an array");
  const tests = doc.tests.map((entry, i): RecordTest => {
    if (!isRecord(entry) || Object.keys(entry).sort().join(",") !== "file,name,project,state") return fail(`tests[${i}] must hold exactly file, project, name and state`);
    const { file, project, name, state } = entry;
    if (typeof file !== "string" || !isCanonicalPath(file)) fail(`tests[${i}].file is not a canonical path`);
    if (typeof project !== "string" || project === "") fail(`tests[${i}].project must be a nonempty string`);
    if (typeof name !== "string") fail(`tests[${i}].name must be a string`);
    if (!isTestState(state)) fail(`tests[${i}].state ${JSON.stringify(state)} is not a test state`);
    return { file: file as string, project: project as string, name: name as string, state: state as TestState };
  });
  return {
    schema: RECORD_SCHEMA, head: doc.head as string | null, shard: doc.shard as CiRecord["shard"], files,
    reason: doc.reason as RunReason, unhandled, tests,
  };
}

export default class CiRecordReporter {
  private ctx: Vitest | undefined;
  constructor(private readonly options: { outputFile?: string } = {}) {}

  onInit(ctx: Vitest): void {
    this.ctx = ctx;
  }

  onTestRunEnd(modules: readonly TestModule[], unhandledErrors: readonly SerializedError[] = [], reason: TestRunEndReason = "passed"): void {
    const path = this.options.outputFile;
    if (!path) throw new RecordError("the CI record reporter needs an outputFile");
    const root = this.ctx!.config.root;
    const record = buildRecord(root, headOf(root), this.ctx!.config.shard, modules, unhandledErrors, reason);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${jsonLine(record)}\n`);
    renameSync(temp, path);
  }
}
