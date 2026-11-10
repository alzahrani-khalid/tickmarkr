// Queue row 367 Phase 2 (D-2187 add.15, add.17 (1), add.19, add.20, add.21): the Terminal-Bench evidence
// reader. Pure apart from one guarded file read; it never throws. Every failure reads as a MISSING score
// for its scope: an absent, unreadable or invalid file → every model; an invalid row → that model.
import { readFileSync } from "node:fs";

export interface TerminalBenchRow {
  model: string;
  /** Present only where the leaderboard publishes one. */
  effort?: string;
  /** The measuring harness exactly as published (D-2187 add.19). Required; never part of the key. */
  agent: string;
  score: number;
  sourceUrl: string;
  retrievedAt: string;
}

export type TerminalBenchEvidence =
  | {
    ok: true;
    version: string;
    maxAgeDays: number;
    rows: readonly TerminalBenchRow[];
    /** Models with at least one invalid row, with the first reason: their score is missing. */
    invalid: ReadonlyMap<string, string>;
  }
  | { ok: false; error: string };

/** Only a fresh row carries a score; a stale row is missing (with `stale` set so doctor can name the leg). */
export type TerminalBenchScore =
  | { status: "fresh"; row: TerminalBenchRow; version: string }
  | { status: "missing"; reason: string; stale?: true };

const DAY_MS = 86_400_000;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const dayStart = (v: string) => Date.parse(`${v}T00:00:00Z`);
// A real calendar day: month 13 or day 32 parse to NaN (checked before toISOString, which would throw), and
// Feb 30 rolls over to another day (the round-trip check).
const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = dayStart(v);
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(v);
};

function rowProblem(r: Record<string, unknown>): string | undefined {
  if (!nonEmpty(r.agent)) return "agent missing or empty";
  if (r.effort !== undefined && !nonEmpty(r.effort)) return "effort empty or not a string";
  if (typeof r.score !== "number" || !Number.isFinite(r.score)) return "score not a number";
  if (!nonEmpty(r.sourceUrl)) return "sourceUrl missing";
  if (!isDate(r.retrievedAt)) return "retrievedAt not a YYYY-MM-DD date";
  return undefined;
}

export function parseTerminalBench(text: string): TerminalBenchEvidence {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, error: "evidence file is not JSON" }; }
  const d = (doc ?? {}) as Record<string, unknown>;
  if (d.source !== "Terminal-Bench") return { ok: false, error: "source is not Terminal-Bench" };
  if (!nonEmpty(d.version)) return { ok: false, error: "version missing" };
  if (!Number.isInteger(d.maxAgeDays) || (d.maxAgeDays as number) <= 0) return { ok: false, error: "maxAgeDays not a positive integer" };
  if (!Array.isArray(d.rows)) return { ok: false, error: "rows not an array" };
  const rows: TerminalBenchRow[] = [];
  const invalid = new Map<string, string>();
  for (const [i, raw] of d.rows.entries()) {
    const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    // ponytail: a row with no readable model names no scope, so it fails the whole file closed.
    if (!nonEmpty(r.model)) return { ok: false, error: `row ${i} has no model` };
    const problem = rowProblem(r);
    if (problem) { if (!invalid.has(r.model)) invalid.set(r.model, problem); continue; }
    rows.push({
      model: r.model, agent: r.agent as string, score: r.score as number,
      sourceUrl: r.sourceUrl as string, retrievedAt: r.retrievedAt as string,
      ...(r.effort === undefined ? {} : { effort: r.effort as string }),
    });
  }
  return { ok: true, version: d.version, maxAgeDays: d.maxAgeDays as number, rows, invalid };
}

/** Absent or unreadable reads as a failed result, never a throw. */
export function readTerminalBench(path: string): TerminalBenchEvidence {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) {
    return { ok: false, error: `evidence file unreadable (${(e as NodeJS.ErrnoException).code ?? "read error"})` };
  }
  return parseTerminalBench(text);
}

const effortLabel = (effort: string | undefined) => (effort === undefined ? "no effort" : `effort ${effort}`);

/**
 * The score for one model at the route's launch effort. The key is model × effort, never the agent:
 * a row with the launch effort is preferred over one with no effort; any model × effort carried by two
 * rows (whatever their agents) leaves the model's score missing rather than picking one.
 */
export function terminalBenchScore(
  ev: TerminalBenchEvidence, model: string, launchEffort: string | undefined, now: Date,
): TerminalBenchScore {
  if (!ev.ok) return { status: "missing", reason: `Terminal-Bench evidence unavailable: ${ev.error}` };
  const bad = ev.invalid.get(model);
  if (bad) return { status: "missing", reason: `Terminal-Bench row for ${model} is invalid: ${bad}` };
  const mine = ev.rows.filter((r) => r.model === model);
  const byEffort = new Map<string | undefined, TerminalBenchRow[]>();
  for (const r of mine) byEffort.set(r.effort, [...(byEffort.get(r.effort) ?? []), r]);
  for (const [effort, group] of byEffort) {
    if (group.length > 1) {
      return {
        status: "missing",
        reason: `Terminal-Bench ambiguous for ${model} ${effortLabel(effort)}: ${group.length} rows (${group.map((r) => r.agent).join(", ")})`,
      };
    }
  }
  const row = (launchEffort === undefined ? undefined : byEffort.get(launchEffort)?.[0]) ?? byEffort.get(undefined)?.[0];
  if (!row) return { status: "missing", reason: `no Terminal-Bench row for ${model} at ${effortLabel(launchEffort)}` };
  const expires = dayStart(row.retrievedAt) + ev.maxAgeDays * DAY_MS;
  // Fail closed: an unreadable clock (NaN) cannot prove the row fresh.
  if (!(now.getTime() <= expires)) {
    return {
      status: "missing", stale: true,
      reason: `Terminal-Bench row for ${model} ${effortLabel(row.effort)} is stale: retrieved ${row.retrievedAt}, older than maxAgeDays ${ev.maxAgeDays}`,
    };
  }
  return { status: "fresh", row, version: ev.version };
}

/** The one evidence line doctor prints for a scored row (contract form, D-2187 add.19). */
export function terminalBenchLine(row: TerminalBenchRow): string {
  const effort = row.effort === undefined ? "" : `, effort ${row.effort}`;
  return `Terminal-Bench ${row.score}% (${row.agent}${effort}, retrieved ${row.retrievedAt})`;
}
