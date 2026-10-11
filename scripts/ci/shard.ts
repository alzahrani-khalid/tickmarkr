// v2.7.8 T2 — duration-balanced shards from a committed, deterministic partition
// (specs/v2.7.8-sharded-ci.spec.md). Vitest's native `--shard` slices a sha1 order into equal-COUNT
// shards; this module plans them by LPT over FORMAT F1 `scripts/ci/durations.json` instead, and its
// default export is the root `sequence.sequencer` of vitest.config.ts. Test workers import that
// config, so nothing here may load `vitest/node` at import time: sort() reaches BaseSequencer lazily.
// Library law (SHARED CONVENTIONS): no CLI here; readers throw the named errors below.
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { TestSequencer, TestSpecification, Vitest } from "vitest/node";
import { isRecord, readJson } from "./json.js";

export const DURATIONS_SCHEMA = "tickmarkr-ci-durations/1";
export const DURATIONS_FILE = "scripts/ci/durations.json";

export class DurationsError extends Error {
  constructor(file: string, why: string) {
    super(`${file}: ${why}`);
    this.name = "DurationsError";
  }
}

export type ShardItem = { readonly file: string; readonly project: string };
export type Durations = Readonly<Record<string, number>>;

const isPositiveSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** CLOSED INPUT: a canonical repository-relative POSIX path — no leading `/`, no empty, `.` or `..` segment, no NUL. */
export const isCanonicalPath = (path: string): boolean =>
  !path.includes("\0") && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

/** Root-relative POSIX path of an absolute module id. */
export const rootRelative = (root: string, moduleId: string): string => relative(root, moduleId).split(sep).join("/");

/**
 * CLOSED LPT RULE. Weight is durationsMs[file]; an unknown file weighs the lower median of the items' known
 * weights (1 when none is known). Items go heaviest first — ties by file, then project, in JS string order —
 * each to the least-loaded shard, ties to the lowest index. Returns `count` arrays; index 0 is shard 1.
 */
export function lptShards<T extends ShardItem>(items: readonly T[], durationsMs: Durations, count: number): T[][] {
  if (!isPositiveSafeInteger(count)) throw new RangeError(`shard count must be a positive safe integer, got ${count}`);
  const known = (file: string) => Object.hasOwn(durationsMs, file);
  const weights = items.filter((item) => known(item.file)).map((item) => durationsMs[item.file]!).sort((a, b) => a - b);
  const unknownWeight = weights.length > 0 ? weights[(weights.length - 1) >> 1]! : 1;
  const weighed = items.map((item) => ({ item, weight: known(item.file) ? durationsMs[item.file]! : unknownWeight }));
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  weighed.sort((a, b) => b.weight - a.weight || cmp(a.item.file, b.item.file) || cmp(a.item.project, b.item.project));
  const shards: T[][] = Array.from({ length: count }, () => []);
  const loads: number[] = Array.from({ length: count }, () => 0);
  for (const { item, weight } of weighed) {
    let least = 0;
    for (let k = 1; k < count; k++) if (loads[k]! < loads[least]!) least = k;
    shards[least]!.push(item);
    loads[least]! += weight;
    if (!Number.isSafeInteger(loads[least])) throw new RangeError(`shard ${least + 1} load exceeds a safe integer`);
  }
  return shards;
}

/** Validate a parsed FORMAT F1 document; `file` names the source in every error. Consumers accept any key order. */
export function parseDurations(doc: unknown, file: string): Record<string, number> {
  if (!isRecord(doc)) throw new DurationsError(file, "not a JSON object");
  const keys = Object.keys(doc).sort();
  if (keys.join(",") !== "durationsMs,schema") throw new DurationsError(file, `keys must be exactly schema and durationsMs, got ${JSON.stringify(keys)}`);
  if (doc.schema !== DURATIONS_SCHEMA) throw new DurationsError(file, `schema must be ${JSON.stringify(DURATIONS_SCHEMA)}`);
  if (!isRecord(doc.durationsMs)) throw new DurationsError(file, "durationsMs must be an object");
  const out: Record<string, number> = Object.create(null);
  for (const [path, ms] of Object.entries(doc.durationsMs)) {
    if (!isCanonicalPath(path)) throw new DurationsError(file, `path ${JSON.stringify(path)} is not canonical`);
    if (!isPositiveSafeInteger(ms)) throw new DurationsError(file, `durationsMs[${JSON.stringify(path)}] must be a positive safe integer`);
    out[path] = ms;
  }
  return out;
}

/** FORMAT F1 from `<root>/scripts/ci/durations.json`; a missing, unreadable or malformed file throws DurationsError naming it. */
export function readDurations(root: string): Record<string, number> {
  const file = join(root, DURATIONS_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new DurationsError(file, `unreadable (${error instanceof Error ? error.message : String(error)})`);
  }
  let doc: unknown;
  try {
    doc = readJson(text);
  } catch (error) {
    throw new DurationsError(file, error instanceof Error ? error.message : String(error));
  }
  return parseDurations(doc, file);
}

/** FORMAT F1 bytes: keys sorted, two-space indent, trailing newline (= JSON.stringify(doc, null, 2) + "\n"), U+2028/9 escaped. */
export function renderDurations(durationsMs: Durations): string {
  const paths = Object.keys(durationsMs).sort();
  for (const path of paths) {
    if (!isCanonicalPath(path) || !isPositiveSafeInteger(durationsMs[path])) throw new DurationsError("durations", `invalid entry ${JSON.stringify(path)}`);
  }
  const body = paths.map((path) => `    ${JSON.stringify(path)}: ${durationsMs[path]}`).join(",\n");
  const text = `{\n  "schema": ${JSON.stringify(DURATIONS_SCHEMA)},\n  "durationsMs": ${paths.length ? `{\n${body}\n  }` : "{}"}\n}\n`;
  return text.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/** Root `sequence.sequencer`: shards by lptShards over Vitest's own `config.shard`, orders as Vitest's BaseSequencer does. */
export default class LptSequencer implements TestSequencer {
  constructor(private readonly ctx: Vitest) {}

  async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const items = files.map((spec) => ({ file: rootRelative(root, spec.moduleId), project: spec.project.name, spec }));
    return lptShards(items, readDurations(root), shard.count)[shard.index - 1]!.map((item) => item.spec);
  }

  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    // A lazy import of vitest/node through Vitest's own module runner, which lives as long as the run. A bare
    // `import()` here would go through the CONFIG loader's runner under `--configLoader runner`, and that
    // runner is closed once the config has loaded ("Vite module runner has been closed").
    const { BaseSequencer } = await this.ctx.import<typeof import("vitest/node")>("vitest/node");
    return new BaseSequencer(this.ctx).sort(files);
  }
}
