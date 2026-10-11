// v2.7.8 T1 — the coverage-floor recheck (queue row 118, specs/v2.7.8-sharded-ci.spec.md).
// Vitest 3.2.7 checks each coverage.thresholds glob over relative(root, file) with picomatch at
// default options and istanbul's percent, whose percent(0, 0) is 100 — so a floor glob matching
// nothing, or only statement-free files, passes silently. This module re-derives the verdict from
// the json-summary vitest wrote and fails those cases as first-class defects.
// Library law: pure module — no CLI, no process.exit, no printing; named errors map to UNREADABLE.
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import picomatch from "picomatch";
import { isRecord, jsonLine } from "./json.js";

export const FLOOR_METRICS = ["lines", "statements", "functions", "branches"] as const;
export type FloorMetric = (typeof FLOOR_METRICS)[number];
export type FloorSubset = Partial<Record<FloorMetric, number>>;
export type Floors = Record<string, FloorSubset>;

/**
 * Threshold keys vitest treats as global machinery; the recheck supports glob keys only. A static
 * null-prototype lookup table with own-property membership — never a plain-record subscript,
 * which answers through inherited Object.prototype members, so a literal glob named "constructor",
 * "toString", "hasOwnProperty" or "__proto__" must not read as unsupported: it is ordinary key data.
 */
const UNSUPPORTED_THRESHOLD_KEYS: Record<string, true> = Object.assign(Object.create(null), {
  perFile: true,
  autoUpdate: true,
  "100": true,
});

export class ThresholdsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThresholdsError";
  }
}

export class SummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryError";
  }
}

/**
 * istanbul-lib-coverage/lib/percent.js verbatim semantics (floor to hundredths, 100 on total 0) —
 * the exact number vitest's own threshold check compares, so a recheck can never be looser.
 */
export const percent = (covered: number, total: number): number =>
  total > 0 ? Math.floor((1000 * 100 * covered) / total / 10) / 100 : 100;

/**
 * ONE SOURCE: the floors come from the working directory's vitest.config.ts — the very
 * test.coverage.thresholds object vitest enforces — never from a second glob list carried here.
 * The import is dynamic by necessity: the specifier is the caller's working directory resolved at
 * runtime, and loading executes the config module exactly as a vitest run would.
 */
export async function loadFloors(root: string): Promise<Floors> {
  const configPath = join(root, "vitest.config.ts");
  if (!existsSync(configPath)) throw new ThresholdsError(`${configPath} not found`);
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(configPath).href);
  } catch (error) {
    throw new ThresholdsError(`failed to load ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const config = isRecord(mod) ? mod.default : undefined;
  const test = isRecord(config) ? config.test : undefined;
  const coverage = isRecord(test) ? test.coverage : undefined;
  const thresholds = isRecord(coverage) ? coverage.thresholds : undefined;
  return validateThresholds(thresholds, configPath);
}

/** CLOSED INPUT on thresholds: nonempty object, glob keys only, nonempty metric subsets, floors finite in (0, 100]. */
export function validateThresholds(value: unknown, source = "thresholds"): Floors {
  if (!isRecord(value)) throw new ThresholdsError(`${source}: absent — expected a nonempty thresholds object`);
  const entries = Object.entries(value);
  if (entries.length === 0) throw new ThresholdsError(`${source}: empty thresholds object`);
  // Null prototype: a literal "__proto__" glob lands as own data instead of rewriting this
  // record's prototype, and own-entry iteration never reads an inherited member — a floor glob
  // cannot silently vanish or be smuggled in through the prototype chain.
  const out: Floors = Object.create(null);
  for (const [glob, subset] of entries) {
    if (Object.hasOwn(UNSUPPORTED_THRESHOLD_KEYS, glob)) {
      throw new ThresholdsError(`${source}: unsupported key ${JSON.stringify(glob)} — only glob keys are supported`);
    }
    if (!isRecord(subset)) {
      throw new ThresholdsError(
        `${source}: ${JSON.stringify(glob)} carries a ${typeof subset} — numeric global thresholds are unsupported, only glob keys mapping metric subsets`,
      );
    }
    const metricKeys = Object.keys(subset);
    if (metricKeys.length === 0) throw new ThresholdsError(`${source}: metric subset of ${JSON.stringify(glob)} is empty`);
    const floors: FloorSubset = {};
    for (const metric of metricKeys) {
      if (!(FLOOR_METRICS as readonly string[]).includes(metric)) {
        throw new ThresholdsError(`${source}: unknown metric ${JSON.stringify(metric)} under ${JSON.stringify(glob)}`);
      }
      const floor = subset[metric];
      if (typeof floor !== "number" || !Number.isFinite(floor) || floor <= 0 || floor > 100) {
        throw new ThresholdsError(
          `${source}: floor ${JSON.stringify(metric)} under ${JSON.stringify(glob)} must be a finite number in (0, 100], got ${String(floor)}`,
        );
      }
      floors[metric as FloorMetric] = floor;
    }
    out[glob] = floors;
  }
  return out;
}

export interface MetricCounters {
  total: number;
  covered: number;
}

export interface SummaryEntry {
  /** Absolute path key exactly as the json-summary wrote it. */
  path: string;
  metrics: Record<FloorMetric, MetricCounters>;
}

const counter = (value: unknown, entry: string, metric: FloorMetric): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new SummaryError(`counter ${metric} of ${entry} is not a nonnegative safe integer`);
  }
  return value;
};

/**
 * CLOSED INPUT on an istanbul json-summary: `total` is ignored, every other key is an absolute path
 * mapping all four metrics to total/covered; counters are nonnegative safe integers with
 * covered ≤ total. Counters beyond those (skipped, pct) are not read and not trusted.
 */
export function parseSummary(value: unknown): SummaryEntry[] {
  if (!isRecord(value)) throw new SummaryError("summary is not a JSON object");
  const entries: SummaryEntry[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key === "total") continue;
    if (!key.startsWith("/") || key.includes("\0")) {
      throw new SummaryError(`summary key ${JSON.stringify(key)} is not an absolute path`);
    }
    if (!isRecord(entry)) throw new SummaryError(`summary entry ${key} is not an object`);
    const metrics = {} as Record<FloorMetric, MetricCounters>;
    for (const metric of FLOOR_METRICS) {
      const raw = entry[metric];
      if (!isRecord(raw)) throw new SummaryError(`summary entry ${key} is missing its ${metric} counters`);
      const total = counter(raw.total, key, metric);
      const covered = counter(raw.covered, key, metric);
      if (covered > total) throw new SummaryError(`summary entry ${key} has ${metric} covered ${covered} above total ${total}`);
      metrics[metric] = { total, covered };
    }
    entries.push({ path: key, metrics });
  }
  return entries;
}

export type FloorDefectKind = "no-file" | "zero-statements" | "below-floor";

export interface FloorMetricCheck {
  pct: number;
  floor: number;
  ok: boolean;
}

export interface FloorCheck {
  glob: string;
  files: number;
  statements: number;
  metrics: Partial<Record<FloorMetric, FloorMetricCheck>>;
  defects: FloorDefectKind[];
}

const safeSum = (sum: number, addend: number, what: string): number => {
  const next = sum + addend;
  if (!Number.isSafeInteger(next)) throw new SummaryError(`${what} leaves the safe integer range`);
  return next;
};

/**
 * A glob owns the entries whose root-relative POSIX path picomatch (default options, as vitest)
 * accepts — `pm(glob)` with no options, exactly vitest's resolveThresholds. A metric's pct is
 * istanbul's percent over the SUMMED covered and total (never an average of per-file pcts), so a
 * glob that averages to a pass but sums to a miss reds.
 */
export function checkFloors(floors: Floors, entries: readonly SummaryEntry[], root: string): FloorCheck[] {
  return Object.entries(floors).map(([glob, subset]) => {
    const matcher = picomatch(glob);
    const owned = entries.filter((entry) => matcher(relative(root, entry.path).replaceAll("\\", "/")));
    const defects: FloorDefectKind[] = [];
    if (owned.length === 0) defects.push("no-file");
    let statements = 0;
    for (const entry of owned) statements = safeSum(statements, entry.metrics.statements.total, `${glob} statements total`);
    // zero functions or branches beside statements above 0 stay legitimate — only statements gate
    if (owned.length > 0 && statements === 0) defects.push("zero-statements");
    const metrics: Partial<Record<FloorMetric, FloorMetricCheck>> = {};
    for (const metric of FLOOR_METRICS) {
      const floor = subset[metric];
      if (floor === undefined) continue;
      let covered = 0;
      let total = 0;
      for (const entry of owned) {
        covered = safeSum(covered, entry.metrics[metric].covered, `${glob} ${metric} covered`);
        total = safeSum(total, entry.metrics[metric].total, `${glob} ${metric} total`);
      }
      const pct = percent(covered, total);
      const ok = pct >= floor;
      if (!ok) defects.push("below-floor");
      metrics[metric] = { pct, floor, ok };
    }
    return { glob, files: owned.length, statements, metrics, defects };
  });
}

export interface FloorsOutcome {
  /** stdout, one line per entry — the closed COVERAGE_FLOOR / COVERAGE_FLOORS format. */
  lines: string[];
  exitCode: number;
}

export const UNREADABLE_FLOORS_LINE = "COVERAGE_FLOORS verdict=UNREADABLE floors=UNREADABLE failing=UNREADABLE";

export function renderFloors(checks: readonly FloorCheck[]): FloorsOutcome {
  // CLOSED INPUT preamble: producers write sorted output — consumers accept any order and order
  // never changes a verdict — so the COVERAGE_FLOOR lines render in one deterministic order, by
  // glob, whatever order the thresholds object listed its keys in.
  const ordered = [...checks].sort((a, b) => (a.glob < b.glob ? -1 : a.glob > b.glob ? 1 : 0));
  const lines = ordered.map((check) =>
    `COVERAGE_FLOOR ${jsonLine({ glob: check.glob, files: check.files, statements: check.statements, metrics: check.metrics, defects: check.defects })}`
  );
  const failing = ordered.filter((check) => check.defects.length > 0).length;
  lines.push(`COVERAGE_FLOORS verdict=${failing === 0 ? "GREEN" : "RED"} floors=${ordered.length} failing=${failing}`);
  return { lines, exitCode: failing === 0 ? 0 : 1 };
}
