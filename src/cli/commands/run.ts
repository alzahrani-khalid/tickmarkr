import { parseArgs } from "node:util";
import { allAdapters, discoverChannels, probeAll, readDoctor } from "../../adapters/registry.js";
import { ROUTING_MODES, type RoutingMode } from "../../config/config.js";
import { parseDriverOverride, pickDriver } from "../../drivers/index.js";
import type { ExecutorDriver } from "../../drivers/types.js";
import { loadGraph } from "../../graph/graph.js";
import { type TaskStatus } from "../../graph/schema.js";
import { type RunSummary, formatSummary, resolveRunMode, runDaemon } from "../../run/daemon.js";
import { isRunLockLive } from "../../run/lock.js";
import { route, type ExploreContext, NO_EXPLORE_ENV } from "../../route/router.js";
import { formatJournalNarration, loadRoutingProfile, newRunId, type JournalEvent } from "../../run/journal.js";
import { normalizeGateOutcome } from "../../run/outcome.js";
import { GLYPHS, LIVE } from "../../brand.js";
import { cellWidth, fitCells } from "../../tui/cockpit/width.js";

// ── the operator event rail (v1.99 T2) ──────────────────────────────────────────────────────────
// A run's TTY narration is an operator EVENT RAIL, not the journal dump it used to echo. The
// repetitive worker-contact / worker-status polls and the ungated phase-start rows are the bulk of
// that dump and say nothing an operator acts on, so the rail never draws them; everything that IS a
// decision, a worker result, a gate start or verdict, a repair, an escalation, a merge or a run
// lifecycle step becomes ONE compact line — semantic glyph, task/run identity, short label, clipped
// detail — measured through the cockpit width authority and coloured in the live palette.
//
// A pipe sees none of it: off a TTY every event returns formatJournalNarration's exact bytes, so the
// machine-consumable surface is byte-identical to the raw journal formatter, suppression included.

const onTty = (): boolean => process.stdout.isTTY === true;

/** Closed repetitive set the rail suppresses on a TTY. An ungated `phase-start` joins them below —
 *  it is a phase counter, while a phase-start CARRYING a gate is the gate start the rail draws. */
export const TTY_NOISE_EVENTS = ["worker-contact", "worker-status"] as const;

type RailTone = "pass" | "fail" | "attention" | "active" | "neutral";

/** The quiet hierarchy: one distinct glyph SHAPE per tone (colour is never the only signal), each
 *  painted in the operator live palette — no sixth colour, no glyph outside the brand vocabulary. */
const RAIL_TONES: Record<RailTone, { glyph: string; paint: (s: string) => string }> = {
  fail: { glyph: GLYPHS.fail, paint: LIVE.failure },
  attention: { glyph: GLYPHS.attention, paint: LIVE.attention },
  pass: { glyph: GLYPHS.pass, paint: LIVE.pass },
  active: { glyph: GLYPHS.pointer, paint: LIVE.running },
  neutral: { glyph: GLYPHS.neutral, paint: LIVE.chrome },
};

/** Closed retained set: the short operator label and the row's default tone. Labels are the rail's
 *  own vocabulary — a raw journal event name is what this surface exists to stop printing. A `pass`
 *  or `ok` datum on the event overrides the default tone, so one gate row can read either way.
 *
 *  MEMBERSHIP RULE — the daemon journals far more than this, and an allowlist built from whatever
 *  the tests happened to cover masks real events. An event earns a row when it changes what the run
 *  will DO next or reports an OUTCOME of it: a routing decision, a worker result, a gate start or
 *  verdict, a repair, an escalation, a merge, a run lifecycle step. Everything else — how the daemon
 *  got there (worktree setup, launch mechanics, baseline and routing lints) and every poll-time
 *  observation (contact reads, quota banners, held dead-verdicts, context samples) — stays off the
 *  rail and on the pipe, where it is byte-identical to the raw journal.
 *
 *  Applying that rule is what put `graph-rehash` and the worker-nudge family here: a rehash is the
 *  operator's audited `--graph-changed` release, journaled by the resumed run through THIS sink, and
 *  a nudge is a decision the daemon takes on the operator's behalf (it contacts the worker and arms a
 *  grace deadline that force-concludes the wait), whose answered/failed/expired rows are that
 *  decision's outcome. Neither is mechanics, and both reach this process's narrate callback. */
export const RAIL_ROWS: Record<string, { label: string; tone: RailTone }> = {
  // run lifecycle
  "run-start": { label: "started", tone: "active" },
  "run-resume": { label: "resumed", tone: "active" },
  "resume-restore": { label: "restored", tone: "neutral" },
  // the operator's audited --graph-changed release: the resumed run journals it through this sink
  "graph-rehash": { label: "graph rehashed", tone: "attention" },
  "lock-reclaimed": { label: "lock reclaimed", tone: "neutral" },
  "run-end": { label: "finished", tone: "neutral" },
  "tip-verify": { label: "tip verify", tone: "pass" },
  "tip-verify-failed": { label: "tip verify", tone: "fail" },
  "tip-verify-start": { label: "tip verify", tone: "active" },
  "tip-verify-cached": { label: "tip verify", tone: "pass" },
  "exit-cause": { label: "exit cause", tone: "neutral" },
  // decisions — every routing decision the daemon makes on the operator's behalf, not just dispatch
  "task-dispatch": { label: "dispatch", tone: "active" },
  "dispatch-retry": { label: "redispatch", tone: "attention" },
  "route-deviation": { label: "reroute", tone: "attention" },
  "failover-deviation": { label: "reroute", tone: "attention" },
  "quota-failover": { label: "failover", tone: "attention" },
  "dead-channel-failover": { label: "failover", tone: "attention" },
  "provider-death-requeue": { label: "requeue", tone: "attention" },
  "channel-demotion": { label: "channel demoted", tone: "attention" },
  "channel-exclusion": { label: "channel excluded", tone: "attention" },
  "consult-verdict": { label: "consult", tone: "attention" },
  // NOT on this rail: `task-approved`. It is an operator decision and it reads like a rail row, but
  // its only producer is `tickmarkr approve` — a SEPARATE CLI process appending through its own
  // Journal (src/cli/commands/approve.ts), and the daemon reads that event back without ever
  // re-appending it, so no `narrate` callback in this process can ever see it. A retained row for it
  // renders only for a synthetic event. It belongs here the day `approve` delivers to the live run
  // instead of only to the file — see the producer-reachability guard in tests/cli/brand-surfaces.
  // the daemon ACCEPTED a trust dialog on the operator's behalf and the worker now runs with
  // whatever that dialog was granting. It is a decision, it is automatic, and it is the one the
  // operator is least likely to expect — it is on the rail for exactly the reason the rest are.
  "trust-auto-answer": { label: "trust accepted", tone: "attention" },
  "channel-recycle": { label: "channel recycled", tone: "attention" },
  "retry-same-banned": { label: "retry banned", tone: "attention" },
  // an identical gate failure hit the fingerprint cap: the daemon forces a consult and bans the
  // identical retry — a decision that changes the next dispatch, not an observation of this one
  "gate-fingerprint-cap": { label: "repeat capped", tone: "attention" },
  // a scope red every collateral prediction already named: the daemon parks the task WITHOUT
  // charging an attempt, which is the most consequential unchargeable decision it makes
  "scope-authoring": { label: "authoring defect", tone: "attention" },
  "session-reset": { label: "session reset", tone: "attention" },
  "worker-mode-fallback": { label: "dispatch mode", tone: "attention" },
  "delivery-readiness-failed": { label: "delivery failed", tone: "fail" },
  // worker results
  "worker-result": { label: "worker", tone: "active" },
  // the daemon SYNTHESIZED this result from committed work because the worker claimed nothing — it
  // carries no `ok` to read, and it is never a routine worker result: it wants the operator's eye
  "worker-result-harvested": { label: "worker", tone: "attention" },
  // the nudge decision and its three outcomes: the daemon contacted a silent worker and armed a
  // grace deadline, and the answered/failed/expired row says what that contact bought
  "worker-nudge": { label: "nudged", tone: "attention" },
  "worker-nudge-answered": { label: "nudge answered", tone: "pass" },
  "worker-nudge-failed": { label: "nudge undelivered", tone: "attention" },
  "worker-nudge-expired": { label: "nudge expired", tone: "attention" },
  "worker-dead": { label: "worker dead", tone: "fail" },
  "worker-harvest": { label: "harvested", tone: "attention" },
  "work-loss": { label: "work lost", tone: "fail" },
  "task-done": { label: "done", tone: "pass" },
  "task-failed": { label: "failed", tone: "fail" },
  "task-human": { label: "parked", tone: "attention" },
  // gate starts and verdicts
  "phase-start": { label: "gate start", tone: "active" },
  "gate-result": { label: "gate", tone: "pass" },
  "gate-reused": { label: "gate reused", tone: "neutral" },
  "judge-retry": { label: "judge retry", tone: "attention" },
  "review-retry": { label: "review retry", tone: "attention" },
  // repairs and escalations
  "repair-dispatch": { label: "repair", tone: "attention" },
  "repair-attempt": { label: "repair", tone: "attention" },
  "repair-cancelled": { label: "repair off", tone: "attention" },
  "repair-exhausted": { label: "repair spent", tone: "fail" },
  "escalation": { label: "escalated", tone: "attention" },
  "operator-page": { label: "page", tone: "attention" },
  "tip-moved": { label: "tip moved", tone: "attention" },
  // merges
  "merge": { label: "integrated", tone: "pass" },
  "merge-conflict": { label: "conflict", tone: "fail" },
};

/** Cells below which a detail is dropped rather than clipped to an unreadable stub. */
const RAIL_MIN_DETAIL_CELLS = 8;

const bucket = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/**
 * `run-end` is the LAST row the operator reads and the one they act on, and its record states none
 * of its outcome in `pass` or `ok` — the generic verdict read finds nothing and the row rendered
 * neutral over a crashed run, a red tip and a park alike. The tone is derived from what the record
 * actually says, in the order `summaryGreen` (below) and `formatSummary` already agree on:
 *
 *   a fatal crash, a failed task or a failed integration tip is a FAILURE;
 *   an incomplete run — parked, blocked or still-pending work — wants ATTENTION;
 *   only a run with none of those is a pass.
 *
 * A rail that paints the terminal record by the same predicate the exit code uses can never show a
 * green tickmark over a run whose exit code is 2.
 */
const runEndTone = (data: Record<string, unknown>): RailTone => {
  if (data.fatal === true || bucket(data.failed) > 0 || data.tipVerify === "failed") return "fail";
  if (bucket(data.human) + bucket(data.blocked) + bucket(data.pending) > 0) return "attention";
  return "pass";
};

/** A gate row's non-failure is spelled across `pass`, `skipped`, `verdict` and `infra`, and a row may
 *  state NONE of them (src/run/outcome.ts) — so the rail reads the canonical outcome rather than
 *  collapsing a decline, a held screen or a dead runner into the green a bare `pass` read gives them. */
const GATE_OUTCOME_TONES: Record<string, RailTone> = {
  passed: "pass", failed: "fail", skipped: "neutral", declined: "neutral",
  held: "attention", unavailable: "attention", infra: "attention",
};

const railTone = (event: JournalEvent, fallback: RailTone): RailTone => {
  if (event.event === "run-end") return runEndTone(event.data);
  // `gate-result` is the one event whose data IS a gate result; every other row carrying a `gate`
  // names a gate without reporting one (a start, a reuse, a retry) and keeps its declared tone.
  if (event.event === "gate-result") return GATE_OUTCOME_TONES[normalizeGateOutcome(event.data).kind] ?? fallback;
  const verdict = event.data.pass ?? event.data.ok;
  return verdict === true ? "pass" : verdict === false ? "fail" : fallback;
};

/**
 * Task rows are their task; run rows are THEIR RUN — the run id the journal names on the event when
 * it carries one, otherwise the id of the run this sink was bound to.
 *
 * There is no generic fallback and there must not be one: `run-start`, `run-resume`, `lock-reclaimed`
 * and every tip-verification row journal no `runId` of their own, so a constant here rendered every
 * run's lifecycle rows identically and an operator reading two rails (or one journal replayed beside
 * a live run) could not tell which run they were watching. The id is threaded in from the command
 * that owns the run — `narrationSink` below, `run()` minting it and `resume` carrying its argument.
 */
const railIdentity = (event: JournalEvent, runId: string): string =>
  event.taskId ?? (typeof event.data.runId === "string" && event.data.runId !== "" ? event.data.runId : runId);

/**
 * The TTY-ONLY salient projection — a closed table, applied to every retained event alike.
 *
 * `formatJournalNarration` picks exactly ONE detail off a fixed ladder (summary, reason, error,
 * step, action, lint, branch, from…), so on most rows the datum an operator actually acts on is not
 * on the line at all: `worker-dead` states a slot and a cpu reading and renders NOTHING, `exit-cause`
 * never says the cause, `work-loss` never says how much was lost, `channel-demotion` never names the
 * channel it demoted. The pipe cannot be widened — its bytes are the raw formatter's, byte for byte
 * — so the rail projects these fields ITSELF, inside `narrationRow`, after the formatter's detail.
 *
 * A field is here when it is the fact the row exists to report and the ladder cannot reach it.
 */
const RAIL_SALIENT: readonly { key: string; render: (value: unknown) => string | undefined }[] = [
  // the conflicting paths a merge died on: `merge-conflict` journals `{conflict}` and NOTHING on the
  // ladder reaches it, so without this the operator's worst merge row reads only "conflict"
  { key: "conflict", render: (v) => (typeof v === "string" ? v : undefined) },
  // which gates a repair is being spent on (repair-attempt) or was spent on (repair-exhausted) —
  // both journal `gates: string[]` and neither states a scalar the ladder can pick up
  { key: "gates", render: (v) => (Array.isArray(v) && v.length > 0 ? `gates ${v.join(", ")}` : undefined) },
  { key: "channel", render: (v) => (typeof v === "string" ? `channel ${v}` : undefined) },
  { key: "status", render: (v) => (typeof v === "string" ? `status ${v}` : undefined) },
  { key: "cause", render: (v) => (typeof v === "string" ? `cause ${v}` : undefined) },
  { key: "silentMs", render: (v) => (typeof v === "number" ? `silent ${Math.round(v / 1000)}s` : undefined) },
  { key: "tokens", render: (v) => (typeof v === "number" ? `tokens ${v}` : undefined) },
  { key: "lost", render: (v) => (Array.isArray(v) ? `lost ${v.length}` : undefined) },
  { key: "transcript", render: (v) => (typeof v === "string" ? v : undefined) },
];

const railSalient = (data: Record<string, unknown>): string[] =>
  RAIL_SALIENT.flatMap(({ key, render }) => {
    const projected = Object.prototype.hasOwnProperty.call(data, key) ? render(data[key]) : undefined;
    return projected === undefined ? [] : [projected];
  });

/**
 * The raw formatter's OWN detail ladder — the same fields in the same order, deliberately WITHOUT its
 * trailing `.slice(0, 120)`.
 *
 * The rail used to re-read `formatJournalNarration()` and split its line apart, which meant the TTY
 * projection was cut by a UTF-16 code-unit slice BEFORE the cockpit width authority ever saw it: at a
 * terminal wide enough that the rail clips nothing, a summary of 119 ASCII characters followed by an
 * emoji arrived already halved, an unpaired surrogate on the end of the row. Only the width authority
 * may cut this text, and it cuts on grapheme clusters (`clipCells` below).
 *
 * This is one detail vocabulary stated twice, so `brand-surfaces.test.ts` pins the two against each
 * other over the whole event corpus: the pipe's bytes must equal event/taskId/THIS detail put through
 * the formatter's legacy squeeze-and-slice. A ladder that drifts fails there rather than in a tab.
 */
const formatterDetail = ({ event, data }: JournalEvent): string | undefined => {
  const assignment = data.assignment as Record<string, unknown> | undefined;
  const direct = [data.summary, data.reason, data.error, data.step, data.action, data.lint, data.branch, data.from]
    .find((value) => typeof value === "string" || typeof value === "number");
  if (Array.isArray(data.done)) {
    return `done ${data.done.length}, failed ${Array.isArray(data.failed) ? data.failed.length : 0}`;
  }
  if (typeof data.gate === "string") {
    if (event === "tip-verify-failed") {
      return `${data.gate} failed${typeof data.lastMergedTask === "string" ? ` after ${data.lastMergedTask}` : ""}`;
    }
    if (event === "tip-verify") return `${data.gate} passed`;
    return `${data.gate}${data.pass === true ? " passed" : data.pass === false ? " failed" : ""}`;
  }
  if (typeof data.code === "number") return `exit ${data.code}`;
  if (typeof data.pid === "number") return `pid ${data.pid}`;
  if (typeof data.baseRef === "string") return `base ${data.baseRef.slice(0, 12)}`;
  if (direct !== undefined) return String(direct);
  return typeof assignment?.adapter === "string" && typeof assignment.model === "string"
    ? `${assignment.adapter}:${assignment.model}`
    : undefined;
};

/**
 * Event-specific projections, for retained rows that the formatter's ladder and the shared salient
 * table BOTH miss entirely.
 *
 * `RAIL_SALIENT` above is keyed by field name and so has to stay generic; these rows state their
 * one meaningful fact in fields that mean nothing on any other event (`chosen`, `diffBytes`,
 * `gatedCommit`). Without them the row is identity plus label and nothing else at any width: a
 * reroute that never says where to, a repair dispatch that never says how much diff it carried, a
 * moved tip that never names either commit, an auto-answered trust dialog that never names the
 * adapter it answered for.
 */
// The nudge family states its whole payload in `{slot, attempt}` (+ `graceMs` on the expiry) and the
// ladder reaches none of it: which attempt was nudged, and how long the grace it spent was.
const nudgeDetail = (d: Record<string, unknown>): string | undefined =>
  typeof d.attempt === "number"
    ? `attempt ${d.attempt}${typeof d.graceMs === "number" ? `, grace ${Math.round(d.graceMs / 1000)}s` : ""}`
    : undefined;

const RAIL_PROJECTION: Record<string, (data: Record<string, unknown>) => string | undefined> = {
  "worker-nudge": nudgeDetail,
  "worker-nudge-answered": nudgeDetail,
  "worker-nudge-failed": nudgeDetail,
  "worker-nudge-expired": nudgeDetail,
  "failover-deviation": (d) =>
    typeof d.chosen === "string"
      ? `to ${d.chosen}${typeof d.static === "string" ? ` over ${d.static}` : ""}`
      : undefined,
  // both rehash hashes: the ladder reaches `from` (null on an unbound journal) and never `to`
  "graph-rehash": (d) => (typeof d.to === "string" ? `to ${d.to.slice(0, 12)}` : undefined),
  "repair-dispatch": (d) =>
    typeof d.diffBytes === "number" ? `diff ${d.diffBytes}B${d.capped === true ? ", capped" : ""}` : undefined,
  "tip-moved": (d) =>
    typeof d.gatedCommit === "string" && typeof d.branchTip === "string"
      ? `gated ${d.gatedCommit.slice(0, 12)}, tip ${d.branchTip.slice(0, 12)}`
      : undefined,
  "trust-auto-answer": (d) =>
    typeof d.adapter === "string" ? `${d.adapter}${typeof d.phase === "string" ? ` ${d.phase}` : ""}` : undefined,
};

// The row's text: the formatter's detail first, then the salient fields that detail could not carry.
// Appending (never prefixing) keeps the operator's prose at the front of the row, so the clip a
// narrow terminal applies takes the projection and leaves the sentence.
const railDetail = (event: JournalEvent): string =>
  [formatterDetail(event) ?? "", RAIL_PROJECTION[event.event]?.(event.data) ?? "", ...railSalient(event.data)]
    .filter((part) => part !== "").join(", ");

/**
 * Journal detail is WORKER-CONTROLLED text - a summary, an error, a transcript line the worker
 * chose. `cellWidth` charges a terminal control zero cells (correctly: the terminal advances no
 * column for it), so an unsanitized cursor-forward, erase-screen or OSC string measures as FITTING
 * while it walks the cursor across the board the rail sits under, and an embedded SGR repaints the
 * quiet palette from inside a row. Every control byte - C0, DEL and C1, which is every escape and
 * every CSI/OSC introducer there is - becomes a space BEFORE the row is measured or styled, so what
 * the rail paints is exactly what it measured and the only escapes on the line are the palette's own.
 */
const railPrintable = (text: string): string =>
  text.replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ").replace(/\s+/gu, " ").trim();

/** Clip to `cells` through the width authority - cluster-safe, and marked when it cut. */
const clipCells = (text: string, cells: number): string =>
  cells <= 0 ? "" : cellWidth(text) <= cells ? text : `${fitCells(text, cells - 1).trimEnd()}…`;

/**
 * One rail row, or null when the TTY rail suppresses this event. Never wider than `columns`: the
 * identity and the label are clipped SEPARATELY and the detail takes only what they leave, so a row
 * can never wrap into a second line and can never lose its meaning to a long identity.
 */
export function narrationRow(event: JournalEvent, runId: string, columns = process.stdout.columns ?? 80): string | null {
  if ((TTY_NOISE_EVENTS as readonly string[]).includes(event.event)) return null;
  const row = RAIL_ROWS[event.event];
  if (!row) return null;
  if (event.event === "phase-start" && typeof event.data.gate !== "string") return null;
  const tone = RAIL_TONES[railTone(event, row.tone)];
  const glyph = tone.paint(tone.glyph);
  const headCells = Math.max(1, columns - 2); // the glyph and its space
  // The rail's contract is identity AND a short label, so the label reserves its cells FIRST: task
  // ids are operator-authored and a legal long one used to swallow the whole head, leaving a narrow
  // terminal a row carrying an identity and no meaning. The label is short by construction and is
  // never given more than half the head; the identity is clipped separately into what remains.
  const label = clipCells(row.label, Math.floor(headCells / 2));
  const identity = clipCells(railPrintable(railIdentity(event, runId)), headCells - cellWidth(label) - 1);
  const painted = `${glyph} ${LIVE.text(identity)} ${LIVE.chrome(label)}`;
  const detail = railPrintable(railDetail(event));
  const detailCells = headCells - cellWidth(identity) - cellWidth(label) - 4; // the head's space and " — "
  return detail && detailCells >= RAIL_MIN_DETAIL_CELLS
    ? `${painted} ${LIVE.chrome(`— ${clipCells(detail, detailCells)}`)}`
    : painted;
}

/** The narration line for one event of the run named by `runId`: the raw journal formatter on a pipe
 *  (byte-identical, every event), the quiet rail on a TTY. Null means the rail suppressed it — the
 *  caller prints nothing. */
export const narrationLine = (event: JournalEvent, runId: string): string | null =>
  onTty() ? narrationRow(event, runId) : formatJournalNarration(event);

/**
 * The daemon's narration sink, BOUND TO THE RUN IT NARRATES: the rail on a TTY, the raw journal
 * formatter on a pipe, and nothing at all for an event the rail suppressed. EVERY command that drives
 * a daemon owes its narration to this sink - a second call site that prints `formatJournalNarration`
 * itself is a surface where the rail does not exist, and the operator meets the old unfiltered dump
 * under the newly stacked board.
 *
 * The binding is what puts a real identity on the run-scoped rows: the daemon's `narrate` callback is
 * handed one event and nothing else, and the lifecycle events carry no run id of their own, so the
 * run id can only come from the command that owns the run. Both daemon-driving commands supply it:
 * `run` below mints the id it then passes to the daemon, and `resume` (src/cli/commands/resume.ts)
 * carries the id the operator named.
 */
export const narrationSink = (runId: string) => (event: JournalEvent): void => {
  const row = narrationLine(event, runId);
  if (row !== null) console.log(row);
};

/**
 * The run's driver, BOUND to the run's narration sink.
 *
 * A driver journals events of its own that the daemon never sees: `dispatch-retry` is appended by
 * HerdrDriver from inside a pane recovery, through a Journal it opens itself (src/drivers/herdr.ts).
 * Unbound, that event lands in the file and on the pipe while the rail — the operator's only live
 * surface — stays silent about a redispatch that already happened. Both daemon-driving commands
 * wrap their driver here so neither can forget the binding.
 */
export function bindNarration<D extends ExecutorDriver>(driver: D, narrate: (event: JournalEvent) => void): D {
  driver.narrateWith?.(narrate);
  return driver;
}

const summaryGreen = (s: RunSummary) =>
  s.failed.length === 0 && s.human.length === 0 && s.blocked.length === 0 && s.pending.length === 0
  && s.tipVerify !== "failed";

// v1.51 T2: --quality is a pure compatibility alias for `--mode partner-led` (this run only). It
// carries no one-band floor raise of its own — and since the OBS-89 rip (v1.60) route() no longer
// reads the retired TICKMARKR_QUALITY env at all, so no downstream code can raise a floor on its
// behalf (proven in mode-sources).
const QUALITY_ALIAS_NOTICE =
  "tickmarkr: --quality is a compatibility alias for --mode partner-led (this run only) — "
  + "the v1.47 one-band floor raise is retired (deprecated); use --mode partner-led";

export async function run(argv: string[], cwd = process.cwd()): Promise<{ out: string; code: number }> {
  const { values } = parseArgs({
    args: argv,
    options: {
      concurrency: { type: "string" },
      driver: { type: "string" },
      "route-strict": { type: "boolean" },
      "no-explore": { type: "boolean" },
      mode: { type: "string" },
      quality: { type: "boolean" },
      supersedes: { type: "string" },
    },
  });
  if (values.concurrency !== undefined) {
    const n = Number(values.concurrency);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--concurrency must be a positive integer (got ${values.concurrency})`);
  }
  // Keep invalid input at the argv boundary. In particular, do not cast a string into the closed
  // driver union and accidentally turn an unknown explicit choice into auto-selection.
  const driverOverride = parseDriverOverride(values.driver);
  if (values.quality && values.mode !== undefined) {
    throw new Error("--quality is a compatibility alias for --mode partner-led and cannot be combined with an explicit --mode — pass one or the other");
  }
  if (values.mode !== undefined && !(ROUTING_MODES as readonly string[]).includes(values.mode)) {
    throw new Error(`--mode must be one of ${ROUTING_MODES.join(" | ")} (got ${values.mode})`);
  }
  if (values.quality) console.warn(QUALITY_ALIAS_NOTICE);
  const flagMode = (values.mode as RoutingMode | undefined) ?? (values.quality ? "partner-led" : undefined);
  const graph = loadGraph(cwd);
  const { cfg, conflict } = resolveRunMode(cwd, { flag: flagMode, spec: graph.mode });
  if (conflict) {
    // Loud, never silent: live intent (the flag) may override compiled intent (the spec) — strict refuses.
    if (values["route-strict"]) throw new Error(`--route-strict: refusing to dispatch — ${conflict}`);
    console.warn(`tickmarkr: !! ${conflict}`);
  }
  // OBS-107 (v1.67 T5): advisory only — a stale compiled graph with prior terminal statuses and no
  // live daemon will otherwise confuse the operator. The recompile remedy is named; dispatch
  // proceeds unchanged when anything is still dispatchable. When NOTHING is (all-terminal graph),
  // runDaemon's no-op refusal (GATE-FIX-4 defect 4) turns the old zero-work "finished" into an error.
  const TERMINAL_STATUSES: TaskStatus[] = ["done", "failed", "human"];
  if (graph.tasks.some((t) => TERMINAL_STATUSES.includes(t.status)) && !isRunLockLive(cwd)) {
    console.warn(
      "tickmarkr: compiled graph carries terminal statuses from a prior run and no daemon is active — "
      + "run `tickmarkr compile <src>` to recompile; proceeding with stale graph",
    );
  }
  const noExplore = !!values["no-explore"];
  const exploreCtx: ExploreContext | undefined = noExplore ? { noExplore } : undefined;
  if (noExplore) process.env[NO_EXPLORE_ENV] = "1";
  try {
    if (values["route-strict"]) {
      const adapters = allAdapters();
      const health = readDoctor(cwd) ?? (await probeAll(adapters));
      const channels = discoverChannels(cfg, adapters, health);
      // no preview: the strict pre-flight routes through exactly what the daemon will use (honors the switch)
      const profile = loadRoutingProfile(cwd, cfg);
      const lints = graph.tasks.flatMap((t) => route(t, cfg, channels, profile, undefined, undefined, exploreCtx).lints);
      if (lints.length) throw new Error(`--route-strict: routing lints present, refusing to dispatch:\n${lints.join("\n")}`);
    }
    // The run id is minted HERE rather than inside the daemon, because the narration sink has to know
    // which run it is narrating before the first event arrives (the daemon's `narrate` callback is
    // handed an event and nothing else, and `run-start` carries no run id). `runDaemon` uses the id
    // it is given exactly as it would use the one it would otherwise mint itself.
    const runId = newRunId();
    const narrate = narrationSink(runId);
    const s = await runDaemon(cwd, {
      runId,
      concurrency: values.concurrency ? Number(values.concurrency) : undefined,
      driver: bindNarration(pickDriver(cfg, driverOverride), narrate),
      mode: flagMode,
      supersedes: values.supersedes,
      narrate,
    });
    const out = `run ${s.runId} finished — ${formatSummary(s)} (merge to main is a human decision)`;
    return { out, code: summaryGreen(s) ? 0 : 2 };
  } finally {
    if (noExplore) delete process.env[NO_EXPLORE_ENV];
  }
}
