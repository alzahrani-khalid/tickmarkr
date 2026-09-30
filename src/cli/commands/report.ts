import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ttyVisual } from "../../adapters/model-lints.js";
import { addUsage, type TokenUsage } from "../../adapters/types.js";
import { dim, rule, title } from "../../brand.js";
import { loadConfig } from "../../config/config.js";
import type { BaselineCommand } from "../../gates/baseline.js";
import { modelProvider } from "../../gates/review.js";
import { buildProofBundle, gateDeclined } from "../../report/bundle.js";
import { compareRuns } from "../../report/compare.js";
import { estimateCosts, type ChannelCost } from "../../report/cost.js";
import {
  assignmentChannel,
  buildOperatorRecord,
  formatChannelMoney,
  formatChannelTokens,
  formatTokenUsage as fields,
  totalTokens as total,
} from "../../report/operator-record.js";
import { cellsOf, cellSummary } from "../../route/profile.js";
import {
  effectiveEvents, foldOwedChecks, Journal, loadRoutingProfile, OWED_DISCHARGE_EVENT, type JournalEvent, type OwedFold, type TelemetryRow,
} from "../../run/journal.js";
import {
  baselineProvenanceOf, fingerprintsOf, forgivenFingerprints, forgivenGateRow, formatBaselineProvenance, formatFingerprints,
  formatForgiven, formatTipProof, runEndTipProof,
} from "../../run/daemon.js";
import { formatSpan, WALL_PRIORITY, WALL_PRIORITY_TEXT, wallBudget, wallBudgetFacts } from "../../run/wall-budget.js";
import { deriveRunCockpitData } from "../../tui/cockpit/derive.js";
import { cellWidth, wrapCells } from "../../tui/cockpit/width.js";

const n = (x: number) => x.toLocaleString("en-US"); // explicit locale — CI/darwin flake guard
const EM = "—";

const firstLine = (s: unknown): string => {
  if (typeof s !== "string" || !s) return EM;
  const i = s.indexOf("\n");
  return (i < 0 ? s : s.slice(0, i)) || EM;
};

const channelLabel = (data: Record<string, unknown>): string => assignmentChannel(data) ?? EM;

const modelFromChannel = (channel: string): string => channel.slice(channel.indexOf(":") + 1);

const reviewerIdentity = (data: Record<string, unknown>): { reviewer: string; provider: string; vendor?: string } | undefined => {
  const details = typeof data.details === "string" ? data.details : "";
  const fromDetails = /reviewer\s+([^\s;()]+:[^\s;()]+)/i.exec(details)?.[1];
  const reviewer = typeof data.reviewer === "string" ? data.reviewer : fromDetails;
  if (!reviewer || !reviewer.includes(":")) return undefined;
  const vendor = typeof data.vendor === "string"
    ? data.vendor
    : /vendor:\s*([^;()]+)/i.exec(details)?.[1]?.trim()
      ?? /\(([^;:()]+)\):/.exec(details)?.[1]?.trim();
  const provider = typeof data.provider === "string"
    ? data.provider
    : modelProvider(modelFromChannel(reviewer), vendor ?? "unknown");
  return { reviewer, provider, ...(vendor ? { vendor } : {}) };
};

const priceLine = (row: ChannelCost): string => {
  const windows = row.channel === "sub" && row.subPlan ? `windows: ${n(row.attempts)}` : `attempts/windows: ${n(row.attempts)}`;
  const tokenText = `tokens: ${formatChannelTokens(row)}`;
  const { prices, bases } = formatChannelMoney(row);
  return `- **${row.adapter}:${row.model}** — ${windows}; ${tokenText}; ${prices.join("; ")}; basis: ${bases.join("; ")}`;
};

const journalUsage = (events: JournalEvent[], known: Set<string>): string[] => {
  const groups = new Map<string, { channel: string; label: string; attempts: number }>();
  for (const e of events) {
    if (e.event !== "task-dispatch") continue;
    const channel = typeof (e.data.assignment as { channel?: unknown } | undefined)?.channel === "string"
      ? (e.data.assignment as { channel: string }).channel
      : EM;
    const label = channelLabel(e.data);
    if (channel === EM || label === EM) continue;
    const key = `${channel}:${label}`;
    if (known.has(key)) continue;
    const group = groups.get(key);
    if (group) group.attempts++;
    else groups.set(key, { channel, label, attempts: 1 });
  }
  return [...groups.values()].map((group) =>
    `- **${group.label}** — attempts/windows: ${n(group.attempts)}; tokens: not measurable; price: not measurable; basis: no telemetry row`,
  );
};

const wallClock = (start?: JournalEvent, end?: JournalEvent): string => {
  const from = Date.parse(start?.ts || "");
  const to = Date.parse(end?.ts || "");
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "not measurable";
  const seconds = Math.round((to - from) / 1_000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
};

// OBS-1201: the disjoint wall budget, or why the journal cannot give one — never a zeroed table.
const wallFacts = (events: JournalEvent[]): Array<[string, string]> => {
  const budget = wallBudget(events);
  if (!budget) return [["window", "not measurable — the journal names no run-start with a readable timestamp"]];
  return [["window", `${formatSpan(budget.wallMs)} — each instant counted once, by priority ${WALL_PRIORITY_TEXT}; task-time sums concurrent spans`], ...wallBudgetFacts(budget)];
};

// OBS-634: the four numbers the baseline capture already measured for the test command. A capture that
// measured nothing says so; a missing number is not measurable, never a zero.
const suiteTelemetry = (entry: BaselineCommand | undefined): string => {
  if (!entry) return "not recorded — this run's baseline holds no test capture";
  if (entry.infra) return `not measurable — the baseline capture returned no verdict (${entry.invalidCause ?? "infra"})`;
  if (typeof entry.durationMs !== "number" || !Number.isFinite(entry.durationMs)) return "not recorded — the baseline predates capture timing";
  const unmeasured = "not measurable (the runner named no per-file durations)";
  const sum = entry.fileDurationSumMs;
  const parallelism = entry.impliedParallelism;
  const longest = entry.longestFile;
  return [
    `wall ${formatSpan(entry.durationMs)}`,
    `file-sum ${typeof sum === "number" ? formatSpan(sum) : unmeasured}`,
    `implied parallelism ${typeof parallelism === "number" ? parallelism.toFixed(2) : unmeasured}`,
    `longest file ${longest ? `${longest.file} ${formatSpan(longest.durationMs)}` : unmeasured}`,
    ...(typeof entry.fileCount === "number" ? [`${entry.fileCount} files`] : []),
  ].join(" · ");
};

/** The run's own baseline.json test entry; absent or unreadable reads as not recorded. */
const baselineTestEntry = (runDir: string): BaselineCommand | undefined => {
  try {
    const baseline = JSON.parse(readFileSync(join(runDir, "baseline.json"), "utf8")) as { commands?: Record<string, BaselineCommand> };
    return baseline.commands?.test;
  } catch {
    return undefined;
  }
};

const detail = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : EM;

// T11: a gate that declined never ran. Drop those before the comparison metrics so the pass rate
// counts only gates that actually ran — a declined gate is never a pass and never pads the base.
// Declines are pass:true, so the gate-failure count is untouched. Reporting only: the unfiltered
// events still feed the record and the proof bundle, and no gate outcome changes.
const ranGatesOnly = (events: JournalEvent[]): JournalEvent[] =>
  events.filter((e) => e.event !== "gate-result" || !gateDeclined(e.data));

// v1.53 T5: supersession is derived from the run's OWN journal only — `superseded by` from the
// appended superseded event (last wins), `supersedes` from the run-start stamp. No cross-run scan.
const supersession = (events: JournalEvent[]): { supersededBy?: string; supersedes?: string } => {
  const by = [...events].reverse().find((e) => e.event === "superseded" && typeof e.data.by === "string")?.data.by;
  const start = events.find((e) => e.event === "run-start");
  const supersedes = typeof start?.data.supersedes === "string" ? start.data.supersedes : undefined;
  return { ...(typeof by === "string" ? { supersededBy: by } : {}), ...(supersedes ? { supersedes } : {}) };
};

// ── CG1 (v2.6.4): the lead — what finished, where the wall went, what needs you NOW ──────────────
// Status and report open with the same three lines, folded here once. Finished work and first pass
// come from this journal's own lineage; time is the existing disjoint wall partition (never summed
// task-time); outstanding is the CURRENT owed-check fold, re-read on every call, never the run-end copy.

// Rows that prove a task's lineage was not one uninterrupted dispatch: a park, an approval, a failure,
// a repair, or a restart restoring it.
const INTERRUPTED = new Set(["task-human", "task-failed", "task-approved", "repair-dispatch", "resume-restore"]);

export interface FirstPass { passed: number; known: number; unknown: number }

/**
 * End-to-end first pass over the finished tasks of the SELECTED journal (no cross-run scan). A task
 * closed done, merged, or named done by the newest run-end passes only as one dispatch at attempt 0
 * straight to its merge. A task whose predecessor or dispatch evidence is missing — no run-start, a run
 * that supersedes another, no dispatch, a first dispatch not at attempt 0 or not recording lifetime
 * worker dispatch ordinal 0 — is unknown whatever else it shows: attempts reset at every release, so
 * only the lifetime ordinal proves no earlier dispatch is missing. Otherwise any park, approval, failure, repair, restore or second dispatch is a known miss — a
 * run-end summary's park or a restart before its merge included — and a would-be pass with no merge is
 * unknown, never counted as a pass.
 */
export function endToEndFirstPass(events: readonly JournalEvent[]): FirstPass {
  const start = events.find((e) => e.event === "run-start");
  const predecessorUnread = !start || typeof start.data.supersedes === "string";
  const runEnd = [...events].reverse().find((e) => e.event === "run-end");
  const finished = new Set([
    ...events.flatMap((e) => e.taskId && (e.event === "task-done" || e.event === "merge") ? [e.taskId] : []),
    ...(Array.isArray(runEnd?.data.done) ? runEnd.data.done.map(String) : []),
  ]);
  const fp: FirstPass = { passed: 0, known: 0, unknown: 0 };
  const names = (e: JournalEvent, buckets: readonly string[], taskId: string): boolean => e.event === "run-end"
    && buckets.some((b) => Array.isArray(e.data[b]) && (e.data[b] as unknown[]).map(String).includes(taskId));
  for (const taskId of finished) {
    const own = events.filter((e) => e.taskId === taskId);
    const dispatches = own.filter((e) => e.event === "task-dispatch");
    // Run-level rows name the task too: a run-end summary parking or failing it is a park wherever it
    // sits, and between its first dispatch and its merge any not-done bucket or a restart means the
    // lineage crossed an engagement boundary — never one uninterrupted dispatch.
    const at = events.findIndex((e) => e.taskId === taskId && e.event === "task-dispatch");
    const end = events.findIndex((e) => e.taskId === taskId && e.event === "merge");
    const span = at < 0 ? [] : events.slice(at, end < 0 ? undefined : end);
    const crossed = events.some((e) => names(e, ["human", "failed"], taskId))
      || span.some((e) => e.event === "run-resume" || names(e, ["blocked", "pending"], taskId));
    // Missing predecessor or dispatch evidence is unknown BEFORE any outcome is classified: a park read
    // without its initial dispatch (none, a first one past attempt 0, or one whose lifetime ordinal is
    // unrecorded or past 0), or in a run continuing an unread predecessor, is no known miss either.
    const origin = dispatches[0]?.data;
    if (predecessorUnread || origin?.attempt !== 0 || origin.workerDispatchOrdinal !== 0) fp.unknown++;
    else if (dispatches.length > 1 || crossed || own.some((e) => INTERRUPTED.has(e.event))) fp.known++;
    else if (!own.some((e) => e.event === "merge")) fp.unknown++;
    else { fp.passed++; fp.known++; }
  }
  return fp;
}

export const firstPassText = ({ passed, known, unknown }: FirstPass): string =>
  known === 0 && unknown > 0
    ? `end-to-end first pass unknown (${unknown} without lineage)`
    : `end-to-end first pass ${passed}/${known}${unknown ? ` + ${unknown} unknown` : ""}`;

/** The CURRENT owed-check fold. `cwd` is any checkout of the run's repository. */
export const currentOwed = (events: readonly JournalEvent[], cwd = process.cwd()): OwedFold => foldOwedChecks(events, cwd);

export const outstandingText = (fold: OwedFold): string => fold.known
  ? `outstanding ${fold.debt}${fold.outstanding.length ? ` (${fold.outstanding.map((o) => `${o.taskId} ${o.gate}`).join(", ")})` : ""}`
  : "outstanding unknown";

// A run-end summary's buckets read as the lifecycle row each names; later effective rows move them on.
const SUMMARY_STATE: Record<string, string> = { done: "task-done", failed: "task-failed", human: "task-human", blocked: "task-blocked", pending: "task-pending" };

/**
 * Tasks the CURRENT lifecycle leaves waiting on the operator: every run-end summary sets the tasks its
 * buckets name, and each effective lifecycle row after it moves its task on — so a summary naming a
 * park or failure the task rows never wrote still counts, and a later approval or merge clears it.
 */
const waitingOnYou = (events: readonly JournalEvent[]): { parked: number; failed: number } => {
  const last = new Map<string, string>();
  for (const e of effectiveEvents(events)) {
    if (e.event === "run-end") {
      for (const [bucket, state] of Object.entries(SUMMARY_STATE)) {
        if (Array.isArray(e.data[bucket])) for (const id of e.data[bucket] as unknown[]) last.set(String(id), state);
      }
    } else if (e.taskId && ["task-dispatch", "task-done", "task-failed", "task-human", "task-approved", "merge"].includes(e.event)) last.set(e.taskId, e.event);
  }
  const states = [...last.values()];
  return { parked: states.filter((s) => s === "task-human").length, failed: states.filter((s) => s === "task-failed").length };
};

export const needsYouText = (events: readonly JournalEvent[], owed: OwedFold): string => {
  const { parked, failed } = waitingOnYou(events);
  const why = owed.known ? "" : ` · unknown: ${owed.unknown[0]?.reason ?? "owed checks unreadable"}`;
  return `needs you: ${outstandingText(owed)} · ${parked} parked · ${failed} failed${why}`;
};

/** The wall window alone, for the one-line form: the same partition, never task-time. */
export const wallText = (events: readonly JournalEvent[]): string => {
  const budget = wallBudget(events);
  return budget ? `${formatSpan(budget.wallMs)} wall` : "wall not measurable";
};

/** Time: the existing disjoint wall partition's window and its largest exposed buckets — never task-time. */
const timeLead = (events: readonly JournalEvent[]): string => {
  const budget = wallBudget(events);
  if (!budget) return "time not measurable — the journal names no run-start with a readable timestamp";
  const top = [...WALL_PRIORITY.map((bucket) => [bucket, budget.exposedMs[bucket]] as const), ["residual", budget.residualMs] as const]
    .filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return `time ${formatSpan(budget.wallMs)} wall, each instant once${top.length ? `: ${top.map(([bucket, ms]) => `${bucket} ${formatSpan(ms)}`).join(" · ")}` : ""}`;
};

/**
 * The three lead lines. `finished` is the surface's own done tally and tip reading (plus any
 * comparability or supersession note); the rest is folded here from the journal and the current fold.
 */
export function leadLines(events: readonly JournalEvent[], owed: OwedFold, finished: { tally: string; tip: string; notes?: string[] }): [string, string, string] {
  return [
    `finished ${[finished.tally, finished.tip, firstPassText(endToEndFirstPass(events)), ...(finished.notes ?? [])].join(" · ")}`,
    timeLead(events),
    needsYouText(events, owed),
  ];
}

/**
 * A lead line packed into `columns` at its ` · ` fact boundaries: a fact that does not fit beside the
 * last moves whole to a `prefix`ed continuation row, so narrowing costs rows and never drops a fact.
 */
const wrapFacts = (line: string, columns: number, prefix: string): string[] => {
  const rows: string[] = [];
  // Read fact by fact without a hand-split (the learning-section source pin forbids one here).
  for (const [, fact] of line.matchAll(/(?:^| · )(.+?)(?= · |$)/gu)) {
    const last = rows.at(-1);
    if (last !== undefined && cellWidth(`${last} · ${fact}`) <= columns) rows[rows.length - 1] = `${last} · ${fact}`;
    else rows.push(...wrapCells(last === undefined ? fact : `${prefix}${fact}`, columns, { continuationPrefix: "  " }));
  }
  return rows;
};

const LEAD_LABELS = ["finished", "time", "needs you"] as const;

/**
 * The lead at `columns`: the first row of finished, time and needs you are the first three physical
 * lines, and every continuation follows them, naming the lead it continues.
 */
export const leadRows = (lead: readonly string[], columns: number): string[] => {
  const wrapped = lead.map((line, i) => wrapFacts(line, columns, `  ${LEAD_LABELS[i]}: `));
  return [...wrapped.map((rows) => rows[0]!), ...wrapped.flatMap((rows) => rows.slice(1))];
};

/**
 * The discharge rows the current fold validates ON THEIR OWN: each is folded alone, at its own journal
 * position among every non-discharge row, so one valid proof never lends its validity to a refused
 * sibling naming the same check, and a proof written before its obligation is never validated by it.
 */
const validatedDischarges = (events: readonly JournalEvent[], cwd?: string): Array<{ row: JournalEvent; gates: string[] }> => {
  return events.filter((e) => e.event === OWED_DISCHARGE_EVENT).flatMap((row) => {
    const ids = Array.isArray(row.data.ids) ? row.data.ids.map(String) : [];
    // In journal order: a discharge that precedes its obligation stays where it was written, never moved after it.
    const fold = currentOwed(events.filter((e) => e.event !== OWED_DISCHARGE_EVENT || e === row), cwd);
    if (!ids.length || !ids.every((id) => fold.discharged.includes(id))) return [];
    return [{ row, gates: ids.map((id) => fold.acceptedRisk.find((o) => o.id === id)?.gate ?? "unknown") }];
  });
};

/** A leg2 row's own reviewer fact: top-level, or under the verify gate row's meta it spreads. */
const leg2Seat = (data: Record<string, unknown>, key: "reviewer" | "vendor"): unknown =>
  data[key] ?? (typeof data.meta === "object" && data.meta !== null ? (data.meta as Record<string, unknown>)[key] : undefined);

/**
 * A review-leg2 row supersedes the daemon review only through its OWN validated discharge of a review
 * check: a passing row whose artifact was captured, bound to that discharge's artifact and range, and
 * naming the very reviewer seat (key and vendor) the discharge validated. A failed or capture-failed
 * row, or one naming another seat, never borrows a sibling's proof.
 */
const leg2Discharge = (leg2: JournalEvent, validated: ReturnType<typeof validatedDischarges>): JournalEvent | undefined => {
  const d = leg2.data;
  if (d.pass !== true || d.artifactAvailability !== "available" || typeof d.artifactSha256 !== "string") return undefined;
  return validated.find(({ row, gates }) => {
    const seat = row.data.reviewer as { key?: unknown; vendor?: unknown } | undefined;
    return row.taskId === leg2.taskId && gates.includes("review")
      && row.data.artifactSha256 === d.artifactSha256 && row.data.artifactPath === d.artifactPath
      && row.data.head === d.head && row.data.mergeBase === d.mergeBase
      && typeof seat?.key === "string" && leg2Seat(d, "reviewer") === seat.key && leg2Seat(d, "vendor") === seat.vendor;
  })?.row;
};

const RUN_END_BUCKETS = ["done", "failed", "human", "blocked", "pending"] as const;

/** The record's done tally: tasks closed done in the journal or its newest run-end, over every task it names. */
const recordTally = (events: readonly JournalEvent[]): string => {
  const runEnd = [...events].reverse().find((e) => e.event === "run-end");
  const bucket = (key: string): string[] => Array.isArray(runEnd?.data[key]) ? (runEnd!.data[key] as unknown[]).map(String) : [];
  const done = new Set([...bucket("done"), ...events.flatMap((e) => e.taskId && (e.event === "task-done" || e.event === "merge") ? [e.taskId] : [])]);
  const all = new Set([...done, ...RUN_END_BUCKETS.flatMap(bucket), ...events.flatMap((e) => e.taskId && e.event.startsWith("task-") ? [e.taskId] : [])]);
  return `${done.size}/${all.size} done`;
};

const taskIds = (events: JournalEvent[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of events) {
    if (!e.taskId || seen.has(e.taskId)) continue;
    seen.add(e.taskId);
    out.push(e.taskId);
  }
  return out;
};

const outcomeFor = (events: JournalEvent[], taskId: string, runEnd?: JournalEvent): string => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.taskId !== taskId) continue;
    if (e.event === "task-done") return "unqualified opinion";
    if (e.event === "task-failed") return "qualified opinion";
    if (e.event === "task-human") return "human";
  }
  if (runEnd) {
    const d = runEnd.data;
    if (Array.isArray(d.done) && d.done.includes(taskId)) return "unqualified opinion";
    if (Array.isArray(d.failed) && d.failed.includes(taskId)) return "qualified opinion";
    if (Array.isArray(d.human) && d.human.includes(taskId)) return "human";
  }
  return "not recorded";
};

/**
 * Whether the run verified itself — the half of tip-verify-before-green the record used to omit
 * entirely (a v1.87 report read four tasks done over a tip verify that had failed, and the close
 * had to say so by hand). The state is READ from the cockpit's derivation, never re-derived here:
 * `deriveRunCockpitData` folds the latest verification cycle in derive.ts `tipVerificationPassed`
 * and surfaces it as the `tip-verify` status item, in three states — pass, fail, and absent — so a
 * second implementation cannot drift from the surface the operator watches live.
 */
type Verification = "passed" | "cached" | "failed" | "absent";

const tipStatusItem = (runId: string, events: JournalEvent[]) => {
  try {
    return deriveRunCockpitData(
      { fileName: runId, raw: events.map((e) => JSON.stringify(e)).join("\n") },
      "", // binaryVersion — unread here; the tip-verify status item is all this asks for
      { isDaemonAlive: () => false }, // a record is read after the fact: no daemon pid to probe
    ).statusItems.find((item) => item.text.startsWith("tip-verify "));
  } catch {
    // A capture the cockpit refuses (empty, or no run-start) verified nothing. Absent, never a pass.
    return undefined;
  }
};

/**
 * The events the cockpit's verdict speaks for: a verification cycle ends at the `run-end` that
 * closes it (derive.ts tipVerificationPassed slices to `lastRunEnd + 1`), so verify events a later
 * resume appended belong to a cycle nothing has closed. Both readings below take THIS one slice, so
 * the record can never name a cache that belongs to a cycle the state never judged.
 */
const closedCycle = (events: JournalEvent[]): JournalEvent[] => {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === "run-end") return events.slice(0, i + 1);
  }
  return events;
};

const verificationOf = (runId: string, events: JournalEvent[]): Verification => {
  const cycle = closedCycle(events);
  const tip = tipStatusItem(runId, cycle);
  if (tip?.state === "fail") return "failed";
  if (tip?.state !== "pass") return "absent";
  // A cached green is a verified green of an EARLIER tip (daemon.ts verifyIntegrationTipCached
  // stamps `cached` on every gate it replays), so the record names it instead of folding it into a
  // plain pass. Still no second window: the cockpit reports "pass" only when the closed cycle
  // carried verdicts, so the last `tip-verify` IN THAT CYCLE is the one it passed on.
  const last = [...cycle].reverse().find((e) => e.event === "tip-verify");
  return last?.data.cached === true ? "cached" : "passed";
};

// Absent is a state to render, never a zero to invent — and no reading here calls a run green.
// NOTE: every reading below is byte-pinned by tests/fixtures/brand-surfaces/report-md.md — the
// golden freezes the WHOLE markdown record, so changing a reading (or the line that renders it)
// means regenerating that fixture in the same commit.
const VERIFICATION_READING: Record<Verification, string> = {
  passed: "passed — tickmarkr verified this run's integration tip",
  cached: "cached — carried forward from an earlier verified tip, not re-run for this one",
  failed: "FAILED — the run did not verify its own tip",
  absent: "absent — no tip verification recorded: neither passed nor failed",
};

function forgivenLines(events: JournalEvent[]): string[] {
  const forgiven = forgivenFingerprints(closedCycle(events));
  return forgiven.length ? ["- **forgiven vs baseline:**", ...forgiven.map((f) => `  - ${formatForgiven(f)}`)] : [];
}

function verificationReading(runId: string, events: JournalEvent[]): string {
  const state = verificationOf(runId, events);
  const proof = runEndTipProof(closedCycle(events));
  if ((state === "passed" || state === "cached") && proof.gates?.length) {
    const allCarried = proof.gates.every(({ kind }) => kind === "reused");
    return `${allCarried ? "cached" : "passed"} — ${formatTipProof(proof)}`;
  }
  return VERIFICATION_READING[state];
}

// OBS-1123: a battery row that carried baseline reds names them apart from any red it introduced, so a
// new regression can never read as forgiven. Rows without the structured fields render as before.
const fingerprintClauses = (data: Record<string, unknown>): string => {
  const fresh = fingerprintsOf(data.freshFingerprints) ?? [];
  const forgiven = fingerprintsOf(data.forgivenFingerprints);
  if (!forgiven && !forgivenGateRow(data)) return "";
  return `${fresh.length ? `; new red (not in baseline): ${formatFingerprints(fresh)}` : ""}`
    + `; forgiven vs baseline: ${formatFingerprints(forgiven)} — ${formatBaselineProvenance(baselineProvenanceOf(data.baselineProvenance))}`;
};

// VIS-07 / REC-01: derived only from the run journal, telemetry, and local configuration.
export function renderMarkdownRecord(runId: string, events: JournalEvent[], prices: ChannelCost[] = [], rows: TelemetryRow[] = [], suite?: BaselineCommand, cwd?: string): string {
  const runStart = events.find((e) => e.event === "run-start");
  const runEnd = [...events].reverse().find((e) => e.event === "run-end");
  const baseRef = typeof runStart?.data.baseRef === "string" ? runStart.data.baseRef : EM;
  const branch = typeof runEnd?.data.branch === "string" ? runEnd.data.branch : EM;
  const count = (key: string) => {
    const v = runEnd?.data[key];
    return Array.isArray(v) ? String(v.length) : EM;
  };
  const gateFailures = new Map<string, number>();
  for (const event of events) {
    if (event.event !== "gate-result" || event.data.pass !== false || typeof event.data.gate !== "string") continue;
    gateFailures.set(event.data.gate, (gateFailures.get(event.data.gate) || 0) + 1);
  }
  const firstAttemptRows = rows.filter((row) => row.firstAttemptOk !== undefined);
  const firstAttemptRate = firstAttemptRows.length
    ? `${firstAttemptRows.filter((row) => row.firstAttemptOk).length}/${firstAttemptRows.length} (${Math.round((100 * firstAttemptRows.filter((row) => row.firstAttemptOk).length) / firstAttemptRows.length)}%)`
    : "not measurable";
  const usageLines = prices.map(priceLine);
  usageLines.push(...journalUsage(events, new Set(prices.map((row) => `${row.channel}:${row.adapter}:${row.model}`))));
  if (!usageLines.length) usageLines.push("- **not recorded:** attempts/windows: not measurable; tokens: not measurable; price: not measurable");

  const sup = supersession(events);
  const owed = currentOwed(events, cwd);
  const validated = validatedDischarges(events, cwd);
  const lines = [
    ...leadLines(events, owed, { tally: recordTally(events), tip: `tip verify ${verificationOf(runId, events)}` }).map((line) => `- ${line}`),
    "",
    `# tickmarkr engagement`,
    "",
    `- **runId:** ${runId}`,
    ...(sup.supersededBy ? [`- **superseded by:** ${sup.supersededBy}`] : []),
    ...(sup.supersedes ? [`- **supersedes:** ${sup.supersedes}`] : []),
    `- **base ref:** ${baseRef}`,
    `- **branch:** ${branch}`,
    `- **done:** ${count("done")}`,
    `- **failed:** ${count("failed")}`,
    `- **human:** ${count("human")}`,
    `- **verification:** ${verificationReading(runId, events)}`,
    // OBS-1123: the same fold the run-end record states, over the same closed cycle as verification.
    ...forgivenLines(events),
    "",
    "## Usage & efficiency",
    "",
    ...usageLines,
    `- **wall-clock:** ${wallClock(runStart, runEnd)}`,
    `- **end-to-end first pass:** ${firstPassText(endToEndFirstPass(events)).replace("end-to-end first pass ", "")} — this journal's dispatch, park, approval and merge lineage`,
    `- **first-attempt rate (engagement-local telemetry):** ${firstAttemptRate} — attempts restart at every resume`,
    `- **gate failures:** ${[...gateFailures.entries()].map(([gate, failures]) => `${gate}: ${failures}`).join(", ") || "none recorded"}`,
    `- **consults:** ${events.filter((e) => e.event === "consult-verdict").length}`,
    `- **escalations:** ${events.filter((e) => e.event === "escalation").length}`,
    "",
    "## Wall budget",
    "",
    ...wallFacts(events).map(([label, fact]) => `- **${label}:** ${fact}`),
    `- **suite telemetry (baseline test capture):** ${suiteTelemetry(suite)}`,
    "",
  ];
  lines.push("## Channels", "");
  const operatorRecords = buildOperatorRecord(events, prices);
  if (operatorRecords.length) {
    for (const row of operatorRecords) {
      lines.push(`- **${row.channel}** — worker: ${row.worker}, review: ${row.review}, consult: ${row.consult}; tokens: ${row.tokens}; money: ${row.money}`);
    }
  } else {
    lines.push("- no channel activity recorded");
  }
  lines.push("");

  lines.push("## Audit trail", "");

  for (const taskId of taskIds(events)) {
    const dispatches = events.filter((e) => e.taskId === taskId && e.event === "task-dispatch");
    const channels = dispatches.map((e) => channelLabel(e.data));
    const gates = events.filter((e) => e.taskId === taskId && e.event === "gate-result");
    const leg2 = events.filter((e) => e.taskId === taskId && e.event === "review-leg2");
    const consults = events.filter((e) => e.taskId === taskId && e.event === "consult-verdict");
    const deviations = events.filter((e) => e.taskId === taskId && e.event === "route-deviation");
    const merge = [...events].reverse().find((e) => e.taskId === taskId && e.event === "merge");
    const provenance = dispatches
      .map((e) => typeof e.data.provenance === "string" ? e.data.provenance : "")
      .filter(Boolean);

    lines.push(`## ${taskId}`, "");
    lines.push(`- **opinion:** ${outcomeFor(events, taskId, runEnd)}`);
    lines.push(`- **attempts:** ${dispatches.length || EM}`);
    lines.push(`- **channels tried:** ${channels.length ? channels.join(", ") : EM}`);
    lines.push(`- **routing:** ${provenance.length ? provenance.join(" | ") : EM}`);
    if (deviations.length) {
      for (const deviation of deviations) {
        lines.push(`- **route deviation:** ${detail(deviation.data.chosen)} learned score ${detail(deviation.data.score)} (n=${detail(deviation.data.n)}) vs static ${detail(deviation.data.static)} ${detail(deviation.data.staticScore)}`);
      }
    } else lines.push(`- **route deviation:** ${EM}`);
    lines.push("- **tickmarks:**");
    if (gates.length) {
      for (const g of gates) {
        // T11: a declined gate never ran — report it as declined, never as a pass.
        let pass = gateDeclined(g.data) ? "declined" : g.data.pass === true ? "pass" : g.data.pass === false ? "fail" : EM;
        const gate = typeof g.data.gate === "string" ? g.data.gate : EM;
        if (gate === "review" && pass === "pass") {
          const reviewer = reviewerIdentity(g.data);
          const before = events.slice(0, events.indexOf(g) + 1).reverse()
            .find((e) => e.taskId === taskId && e.event === "task-dispatch");
          const author = channelLabel(before?.data ?? {});
          const authorProvider = author === EM ? "unknown" : modelProvider(modelFromChannel(author));
          if (reviewer && authorProvider !== "unknown" && authorProvider === reviewer.provider) {
            pass = "pass (same-provider — independence not established)";
          }
        }
        const resolved = gate === "review" && g.data.pass === true && Array.isArray(g.data.resolved)
          ? g.data.resolved.filter((id): id is string => typeof id === "string") : [];
        lines.push(`  - ${gate}: ${pass} — ${firstLine(g.data.details)}${resolved.length ? `; resolved: ${resolved.join(", ")}` : ""}${fingerprintClauses(g.data)}`);
      }
      for (const row of leg2) {
        const pass = row.data.pass === true ? "pass" : row.data.pass === false ? "fail" : EM;
        const identity = reviewerIdentity(row.data);
        const identityText = identity
          ? `reviewer ${identity.reviewer}${identity.vendor ? ` (vendor: ${identity.vendor}; provider: ${identity.provider})` : ` (provider: ${identity.provider})`}`
          : firstLine(row.data.details);
        // CG1: only this row's own validated discharge of a review check lets it supersede the daemon review.
        const discharge = leg2Discharge(row, validated);
        const claim = discharge
          ? `supersedes daemon review — validated discharge ${(discharge.data.ids as unknown[]).map(String).join(", ")}`
          : "unvalidated — no validated owed-check discharge; the daemon review stands";
        lines.push(`  - review-leg2: ${pass} (${claim}) — ${identityText}`);
      }
    } else lines.push(`  - ${EM}`);
    lines.push("- **National Office:**");
    if (consults.length) {
      for (const c of consults) {
        const action = typeof c.data.action === "string" ? c.data.action : EM;
        lines.push(`  - ${action} — ${firstLine(c.data.notes)}`);
      }
    } else lines.push(`  - ${EM}`);
    const mergedBranch = typeof merge?.data.branch === "string" ? merge.data.branch : EM;
    const mergedCommit = typeof merge?.data.commit === "string" ? merge.data.commit : EM;
    lines.push(`- **consolidation branch:** ${mergedBranch}`);
    lines.push(`- **consolidation commit:** ${mergedCommit}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function textReport(runId: string, events: JournalEvent[], rows: TelemetryRow[], cwd: string, suite?: BaselineCommand): string {
  // one group per adapter:model, carrying channel + the folded usage across its rows
  const groups = new Map<string, { channel: string; rows: TelemetryRow[] }>();
  for (const r of rows) {
    const k = `${r.adapter}:${r.model}`;
    const g = groups.get(k) ?? { channel: r.channel, rows: [] };
    g.rows.push(r);
    groups.set(k, g);
  }

  // TOKENS axis (channel-agnostic): tokens present ⇒ measured, absent ⇒ unmetered (never 0).
  const tokenLines = [...groups.entries()].map(([k, g]) => {
    const usage = g.rows.filter((r) => r.tokens).reduce<TokenUsage | undefined>((a, r) => addUsage(a, r.tokens!), undefined);
    if (!usage) return `  ${k.padEnd(24)} unmetered (adapter reports no usage)`;
    // exact iff EVERY row is metered to completion; a degraded (tokens but meteredAttempts undefined) row ⇒ floor
    const exact = g.rows.every((r) => r.tokens && r.meteredAttempts === r.attempts);
    if (exact) {
      const tasks = g.rows.length;
      return `  ${k.padEnd(24)} ${fields(usage)}   (${n(total(usage))} tokens, ${tasks} task${tasks === 1 ? "" : "s"})`;
    }
    const metered = g.rows.reduce((s, r) => (r.meteredAttempts === undefined ? s : s + r.meteredAttempts), 0);
    const attempts = g.rows.reduce((s, r) => s + r.attempts, 0);
    return `  ${k.padEnd(24)} ≥ ${fields(usage)}   (floor: ${metered}/${attempts} attempts metered)`;
  });

  // MONEY axis (orthogonal — branches on channel, NOT tokens): sub ⇒ subscription (no price ever),
  // api ⇒ operator price × tokens; no prices configured ⇒ `price unset`, never a dollar figure.
  const subs = [...groups].filter(([, g]) => g.channel === "sub").map(([k]) => k);
  const apis = [...groups].filter(([, g]) => g.channel === "api").map(([k]) => k);
  const apiLine = apis.length ? apis.map((k) => `${k} — price unset`).join(" · ") : "none configured";

  // VIS-05 learning axis: render the PREVIEW-mode profile (preview bypasses routing.learned:off) so the
  // operator audits per-cell confidence before ever flipping learning on. profile.ts owns every number
  // (cellSummary); this section only formats. probes = this run's exploratory route-deviation events.
  const cfg = loadConfig(cwd);
  const off = cfg.routing.learned === "off";
  const p = loadRoutingProfile(cwd, cfg, { preview: true });
  const probes = events.filter((e) => e.event === "route-deviation" && e.data.explore === true).length;
  const learningLines = !p || p.cells.size === 0
    ? ["  no telemetry yet"]
    : [...cellsOf(p)].map(({ shape, chKey, channel, cell }) => {
        const s = cellSummary(cell);
        return `  ${shape.padEnd(10)} ${chKey.padEnd(28)} ${channel.padEnd(4)} raw=${s.nRaw} n_eff=${s.nEff} disp=${s.dispatches} q=${s.quality === undefined ? "-" : s.quality.toFixed(2)} quota=${s.quotaHits} explore-left=${s.exploreRemaining}${s.cold ? "  cold (neutral)" : ""}`;
      });

  const gateResults = events.filter((e) => e.event === "gate-result");
  // T11: gates that declined never ran — out of both the pass count and the rate base.
  const declinedCount = gateResults.filter((e) => gateDeclined(e.data)).length;
  const gateRan = gateResults.length - declinedCount;
  const gatePass = gateResults.filter((e) => e.data.pass && !gateDeclined(e.data)).length;
  const escalations = events.filter((e) => e.event === "escalation").length;
  const consults = events.filter((e) => e.event === "consult-verdict").length;
  const failovers = events.filter((e) => e.event === "quota-failover").length;

  const sup = supersession(events);
  // CG1: at a configured terminal width the lead wraps its continuations after the three lead lines;
  // report() fits every other row of the complete output (fitColumns).
  const lead = leadLines(events, currentOwed(events, cwd), { tally: recordTally(events), tip: `tip verify ${verificationOf(runId, events)}` });
  const columns = process.stdout.columns;
  return [
    ...(columns ? leadRows(lead, columns) : lead),
    `tickmarkr engagement — ${runId}`,
    ...(sup.supersededBy ? [`superseded by ${sup.supersededBy}`] : []),
    ...(sup.supersedes ? [`supersedes ${sup.supersedes}`] : []),
    "",
    // CG1: the telemetry rows are engagement-local — attempts restart at every resume; the lead's
    // end-to-end first pass is the lineage reading.
    "engagement summary — audit trail: engagement-local telemetry, attempts restart at every resume",
    ...[...groups.entries()].map(([k, g]) =>
      `  ${k.padEnd(30)} tasks ${g.rows.length}, attempts ${g.rows.reduce((s, r) => s + r.attempts, 0)}, done ${g.rows.filter((r) => r.outcome === "done").length}`,
    ),
    "",
    `tickmark rate: ${gateRan ? Math.round((100 * gatePass) / gateRan) : 0}% (${gatePass}/${gateRan})${declinedCount ? ` · declined: ${declinedCount}` : ""}`,
    `escalations: ${escalations} · National Office consults: ${consults} · quota failovers: ${failovers}`,
    "",
    "wall budget — exposed wall, disjoint:",
    ...wallFacts(events).map(([label, fact]) => `  ${label.padEnd(14)} ${fact}`),
    `  ${"suite".padEnd(14)} ${suiteTelemetry(suite)}`,
    "",
    "spend — tokens (measured where observed):",
    ...tokenLines,
    "spend — money:",
    `  subscription channels (no marginal spend): ${subs.length ? subs.join(", ") : "none"}`,
    `  api channels: ${apiLine}`,
    "",
    `learning (routing.learned: ${cfg.routing.learned}${off ? " — preview" : ""}):`,
    ...learningLines,
    `  probes this run (route-deviation explore): ${probes}`,
  ].join("\n");
}

/**
 * CG1: at a configured terminal width EVERY row of the complete text output fits it — the lead, the
 * body, a --bundle receipt and --compare output alike: a row that overflows wraps beneath its own
 * indent, no fact dropped; a row that already fits (the lead's own layout) is untouched.
 */
const fitColumns = (out: string, columns = process.stdout.columns): string => columns
  ? out.replace(/^.*$/gmu, (line) => wrapCells(line, columns, { continuationPrefix: `${/^ */u.exec(line)![0]}  ` }).join("\n"))
  : out;

// T4 (v1.50): TTY-only brand pass over the text report — title frame + dim section chrome; row
// text and alignment untouched (the doctor/status system). Gated on ttyVisual(): the non-TTY
// surface returns untouched, and --md never styles (the record is a document surface).
const stylizeReport = (out: string): string => {
  if (!ttyVisual()) return out;
  return out
    .replace(/^tickmarkr engagement — .*$/m, (head) => `${title(head)}\n${rule()}`) // non-global /m ⇒ the title line only
    .replace(/^(engagement summary — audit trail:[^\n]*|wall budget — [^\n]*|spend — tokens[^\n]*|spend — money:|learning \([^\n]*)$/gm, (l) => dim(l));
};

export async function report(argv: string[], cwd = process.cwd()): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      md: { type: "boolean" },
      // v1.70 T3: baseline run id for cost/gate/duration delta + environment comparability guard
      compare: { type: "string" },
      // v1.70 T4: write a portable, schema-versioned proof packet (local file only — no network)
      bundle: { type: "string" },
    },
    allowPositionals: true,
  });
  const runId = positionals[0] ?? Journal.latestRunId(cwd, { withJournal: true });
  if (!runId) throw new Error("no runs found — usage: tickmarkr report <run-id> [--md] [--compare <baseline-run-id>] [--bundle <path>]");
  const j = Journal.open(cwd, runId);
  const events = j.read();
  const rows = j.readTelemetry();
  const cfg = loadConfig(cwd);
  const suite = baselineTestEntry(j.dir);

  let bundleNote = "";
  if (values.bundle) {
    // Local-only write of the pure proof packet — no network path exists in buildProofBundle.
    const packet = buildProofBundle(runId, events);
    writeFileSync(values.bundle, JSON.stringify(packet, null, 2) + "\n");
    bundleNote = `wrote proof bundle → ${values.bundle}\n`;
  }

  let comparison = "";
  if (values.compare) {
    const baselineRunId = values.compare;
    const baseline = Journal.open(cwd, baselineRunId);
    const outcome = compareRuns({
      runId,
      baselineRunId,
      events: ranGatesOnly(events),
      baselineEvents: ranGatesOnly(baseline.read()),
      rows,
      baselineRows: baseline.readTelemetry(),
      cost: cfg.cost,
    });
    // Fail closed: missing run-start yields a clear reason, never a partial table.
    if (!outcome.ok) throw new Error(outcome.reason);
    comparison = "\n" + outcome.text;
  }

  // CG1: the bundle receipt follows the three lead lines and their wrapped continuations, never above
  // them (in markdown, after the blank line that closes the lead list, so it never joins its last item).
  const afterLead = (out: string, at = 3): string => bundleNote
    ? out.replace(new RegExp(`^(?:[^\\n]*\\n){${at}}(?:  [^\\n]*\\n)*`, "u"), (lead) => `${lead}${bundleNote.trimEnd()}\n`)
    : out;
  if (values.md) {
    return afterLead(renderMarkdownRecord(runId, events, estimateCosts(rows, cfg.cost), rows, suite, cwd), 4) + comparison;
  }
  return fitColumns(afterLead(stylizeReport(textReport(runId, events, rows, cwd, suite))) + comparison);
}
