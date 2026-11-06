import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  CAPTURE_CEILING_MS, captureCeilingMs, classifiedFileDurations, effectiveCeilingMs, staleFileCountCommands,
  type Baseline, type BaselineCommand,
} from "../gates/baseline.js";
import type { GateResult } from "../gates/types.js";

/**
 * Queue row 300 / D-2182 (contracts V and C): a standalone verify of a detected manifested Vitest suite with
 * no supplied --baseline captures no merge-base suite. The manifested gate reads only the test entry's
 * per-file durations, longestFile and ceiling, so this module supplies those from records already on disk —
 * read-only, never a capture, verdict, fingerprint, file count or capacity.
 */

export const verdictlessCommands = (baseline: Baseline, commands: Record<string, string>): string[] =>
  Object.keys(commands).filter((name) => baseline.commands[name]?.exitCode === undefined);

export type CeilingSource = "exact-base-cache" | "prior-measurement" | "floor-kill-equivalent";

export interface ManifestedCeiling {
  source: CeilingSource;
  ceilingMs: number;
  /** The record that supplied the ceiling (absent for floor-kill-equivalent). */
  sourcePath?: string;
  /** The reusable exact-base capture, passed to the gates unchanged. */
  exact?: Baseline;
  /** The newest valid matching healthy capture's test entry, for hang budgets only. */
  hangBudgets?: { path: string; entry: BaselineCommand };
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

/** captureCeilingMs' own consumed field (ceilingMs ?? durationMs), validated without coercing an unused one. */
const validMeasurement = (entry: unknown): entry is BaselineCommand => {
  if (!isObject(entry)) return false;
  const measured = entry.ceilingMs ?? entry.durationMs;
  return typeof measured === "number" && Number.isFinite(measured) && measured > 0;
};

const readJson = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
};

function reusableExact(cachePath: string, subset: Record<string, string>, cwd: string): Baseline | undefined {
  const cached = readJson(cachePath);
  if (!isObject(cached) || !isObject(cached.commands)) return undefined;
  const baseline = cached as unknown as Baseline;
  return verdictlessCommands(baseline, subset).length || staleFileCountCommands(baseline, subset, cwd).length ? undefined : baseline;
}

/** capturePriors' suffix match and order (mtime descending, then filename descending), over test only. */
function matchingRecords(cachePath: string): Array<{ path: string; verdictless: boolean; entry: unknown }> {
  const dir = dirname(cachePath);
  const suffix = cachePath.slice(cachePath.lastIndexOf("-", cachePath.lastIndexOf("-") - 1));
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  return files.filter((file) => file.startsWith("baseline-") && (file.endsWith(suffix) || file.endsWith(`${suffix}.verdictless`)))
    .flatMap((file) => { try { return [{ file, modified: statSync(join(dir, file)).mtimeMs }]; } catch { return []; } })
    .sort((a, b) => b.modified - a.modified || b.file.localeCompare(a.file))
    .map(({ file }) => {
      const verdictless = file.endsWith(".verdictless");
      const record = readJson(join(dir, file));
      const measurements = isObject(record) ? (verdictless ? record.measurements : record.commands) : undefined;
      return { path: join(dir, file), verdictless, entry: isObject(measurements) ? measurements.test : undefined };
    });
}

/** Contract C's closed, ordered source table, resolved inside the repository reservation. */
export function resolveManifestedCeiling(cachePath: string, subset: Record<string, string>, cwd: string): ManifestedCeiling {
  const exact = reusableExact(cachePath, subset, cwd);
  if (exact) return { source: "exact-base-cache", ceilingMs: effectiveCeilingMs(exact.commands.test), sourcePath: cachePath, exact };
  const records = matchingRecords(cachePath).filter((record) => validMeasurement(record.entry));
  const healthy = records.filter((record) => !record.verdictless && typeof (record.entry as BaselineCommand).exitCode === "number");
  const budget = healthy.find((record) => record.path === cachePath) ?? healthy[0];
  const hangBudgets = budget ? { hangBudgets: { path: budget.path, entry: budget.entry as BaselineCommand } } : {};
  const prior = records[0];
  return prior
    ? { source: "prior-measurement", ceilingMs: captureCeilingMs(prior.entry), sourcePath: prior.path, ...hangBudgets }
    : { source: "floor-kill-equivalent", ceilingMs: effectiveCeilingMs({ durationMs: CAPTURE_CEILING_MS }), ...hangBudgets };
}

/** (a) the exact-base Baseline unchanged, or (b) an in-memory timing-only Baseline: never persisted, no verdict. */
export function manifestedBaseline(ceiling: ManifestedCeiling): Baseline {
  if (ceiling.exact) return ceiling.exact;
  const entry = ceiling.hangBudgets?.entry;
  const files = classifiedFileDurations(entry);
  // ponytail: no fingerprints/exitCode by design — the manifested gate reads only these measurement fields.
  const test = {
    ceilingMs: ceiling.ceilingMs,
    ...(Array.isArray(files) ? { fileDurations: files, fileOutcomes: true as const } : {}),
    ...(entry?.longestFile !== undefined ? { longestFile: entry.longestFile } : {}),
  } as BaselineCommand;
  return { commands: { test } };
}

/** The row metadata and stderr naming the source; provenance lives only here and in the artifact. */
export function ceilingMeta(ceiling: ManifestedCeiling): Record<string, unknown> {
  return {
    baselineCapture: "not-required-manifested-vitest", ceilingSource: ceiling.source, ceilingMs: ceiling.ceilingMs,
    ...(ceiling.sourcePath ? { ceilingSourcePath: ceiling.sourcePath } : {}),
    ...(!ceiling.exact && ceiling.hangBudgets ? { hangBudgetSourcePath: ceiling.hangBudgets.path } : {}),
  };
}

export function ceilingLine(ceiling: ManifestedCeiling): string {
  return `verify: base suite not required for manifested Vitest — ceiling source ${ceiling.source}`
    + `${ceiling.sourcePath ? ` (${basename(ceiling.sourcePath)})` : ""}, armed ceiling ${ceiling.ceilingMs}ms`;
}

/** Contract C's actual candidate ceiling kill observable: the test row's span when it qualifies, else undefined. */
export function ceilingKillDurationMs(row: GateResult, ceilingMs: number): number | undefined {
  const meta = row.meta ?? {};
  const span = meta.durationMs;
  if (row.gate !== "test" || row.pass || typeof span !== "number" || !Number.isFinite(span) || span <= 0) return undefined;
  const killed = meta.kind === "hang"
    ? meta.hangBudgetMs === ceilingMs
    : (meta.missingCertificate === true || meta.missingReport === true) && span >= ceilingMs;
  return killed ? span : undefined;
}

/**
 * Stamp a manifested test row with its ceiling provenance. A qualifying candidate ceiling kill under a
 * prior-measurement or floor-kill-equivalent ceiling publishes baselineFor's verdictless marker shape with
 * only its own span, so the next verify's prior grows from it; an exact-base cache keeps priority and
 * re-arms as today, writing none. The row stays failed/infra either way.
 */
export function manifestedRow(row: GateResult, ceiling: ManifestedCeiling, cachePath: string, base: string): GateResult {
  const meta = { ...row.meta, ...ceilingMeta(ceiling) };
  const killMs = ceiling.source === "exact-base-cache" ? undefined : ceilingKillDurationMs(row, ceiling.ceilingMs);
  if (killMs === undefined) return { ...row, meta };
  const marker = `${cachePath}.verdictless`;
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ base, commands: ["test"], measurements: { test: { durationMs: killMs, ceilingMs: effectiveCeilingMs({ durationMs: killMs }) } } }) + "\n");
    console.error(`verify: candidate suite killed at its ${ceiling.ceilingMs}ms ceiling after ${killMs}ms; verdictless timing marker written at ${marker}`);
    return { ...row, meta: { ...meta, ceilingMarker: marker } };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.error(`verify: candidate suite killed at its ${ceiling.ceilingMs}ms ceiling; verdictless timing marker not published at ${marker} (${why})`);
    return { ...row, meta: { ...meta, ceilingMarkerError: why } };
  }
}
