import { Box } from "ink";
import { useContext, type ReactElement } from "react";
import { GLYPHS } from "../../brand.js";
import type { ApprovalRunOwner } from "../../cli/commands/approve.js";
import { formatOwnedName, parseOwnedName } from "../../drivers/types.js";
import { GATE_NAMES, type GateName, type RunGraph } from "../../graph/schema.js";
import { projectActivity } from "../../run/activity.js";
import type { JournalEvent } from "../../run/journal.js";
import { projectOperatorSummary } from "../../run/operator-summary.js";
import { trackJournalRows } from "../../run/protocol.js";
import { normalizeGateOutcome, type GateOutcome } from "../../run/outcome.js";
import type { OperatorGateState, OperatorSnapshot, OperatorTask } from "../../run/operator-state.js";
import { BOARD_KEYS, boardFooter, clipBoard, renderBoardLines } from "./board.js";
import { BodyText, Panel, ShellTheme } from "./components.js";
import {
  applyDecisionKey,
  decisionConfirmLines,
  decisionKeybar,
  decisionReceiptLines,
  initialDecisionSession,
  type DecisionCommand,
  type DecisionPreview,
  type DecisionSession,
  type RunDecision,
} from "./decision-actions.js";
import { fitCells, wrapCells } from "./width.js";

/* ------------------------------------------------------------------------ */
/* C4 — the Run body C1 mounts (FINAL §3.4 view 4; R21, R25, R39, R48, R50). */
/*                                                                           */
/* Facts come from C2's OperatorSnapshot; every label a cell wears is read   */
/* from the journal row the snapshot names as that cell's evidence. Nothing  */
/* here infers a pass, a tier or an infra verdict from prose or policy.      */
/* ------------------------------------------------------------------------ */

/** A journal line as C2's store exposes it — physical line, parsed event when readable. */
export interface RunEvidenceRow { readonly line: number; readonly event?: JournalEvent; readonly error?: string }
export type EvidencePage = (firstLine: number, count?: number) => readonly RunEvidenceRow[];
export interface EvidenceLookup {
  (line: number): RunEvidenceRow | undefined;
  /** All known later rows, filling the evicted gap through the store's page accessor. */
  later(line: number): readonly RunEvidenceRow[];
}

/** Bounded history first, then the store's page accessor for an evicted line. */
export function evidenceLookup(rows: readonly RunEvidenceRow[], page?: EvidencePage): EvidenceLookup {
  const retained = [...rows].sort((a, b) => a.line - b.line);
  const recovered = new Map<number, RunEvidenceRow>();
  const safelyPage = (firstLine: number, count: number): readonly RunEvidenceRow[] => {
    try { return page?.(firstLine, count) ?? []; } catch { return []; }
  };
  const lookup = ((line: number) => retained.find((row) => row.line === line) ?? recovered.get(line) ?? safelyPage(line, 1)[0]) as EvidenceLookup;
  lookup.later = (line: number): readonly RunEvidenceRow[] => {
    const later = retained.filter((row) => row.line > line);
    const firstRetained = later[0]?.line;
    // If the evidence itself is retained, every later row is retained too: history is a tail.
    // Otherwise page only the evicted gap. This recovers durable reuse/approval markers without
    // retaining the journal or repeatedly scanning the live tail on ordinary renders.
    if (!page || retained.some((row) => row.line === line)) return later;
    let candidate = line + 1;
    while (firstRetained === undefined || candidate < firstRetained) {
      const count = firstRetained === undefined ? 256 : Math.min(256, firstRetained - candidate);
      const batch = safelyPage(candidate, count);
      if (batch.length === 0) break;
      for (const row of batch) recovered.set(row.line, row);
      const next = batch[batch.length - 1]!.line + 1;
      if (next <= candidate) break;
      candidate = next;
    }
    return [...recovered.values(), ...later]
      .filter((row) => row.line > line)
      .sort((a, b) => a.line - b.line);
  };
  return lookup;
}

export const GATE_CELL_LETTERS: Record<OperatorGateState, string> = {
  passed: "P", failed: "F", queued: "Q", running: "R", "not-run": "-", disabled: "D", unknown: "?",
};

/** The outcome selector's vocabulary — a classification of the row, never a word search. */
export const OUTCOME_FILTERS = ["all", "infra failure", "work failure", "pass", "unknown"] as const;
export type OutcomeFilter = (typeof OUTCOME_FILTERS)[number];
export type OutcomeClass = Exclude<OutcomeFilter, "all"> | "not a verdict";

export interface RunGateCell {
  readonly gate: GateName;
  readonly state: OperatorGateState;
  readonly letter: string;
  readonly line?: number;
  readonly outcome?: GateOutcome;
  readonly outcomeClass: OutcomeClass;
  readonly labels: readonly string[];
  /** The verdict text the evidence row carries, split into lines for paging. */
  readonly verdict: readonly string[];
}

const BASELINE_GATES: ReadonlySet<string> = new Set(["build", "test", "lint"]);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

function outcomeClassOf(outcome: GateOutcome | undefined, state: OperatorGateState): OutcomeClass {
  if (!outcome) return state === "passed" || state === "failed" ? "unknown" : "not a verdict";
  switch (outcome.kind) {
    case "infra": return "infra failure";
    case "failed": return "work failure";
    case "passed": return "pass";
    case "unavailable": return "unknown";
    default: return "not a verdict";
  }
}

function outcomeLabel(outcome: GateOutcome): string {
  switch (outcome.kind) {
    case "passed": return "passed";
    case "failed": return "failed (work)";
    case "infra": return `infra failure — ${outcome.reason} (${outcome.retryable ? "retryable" : "terminal"})`;
    case "skipped": return `skipped — ${outcome.reason}`;
    case "declined": return `declined — ${outcome.reason}`;
    case "held": return `held — ${outcome.reason}`;
    case "unavailable": return `unknown — ${outcome.reason}`;
  }
}

/** Current-attempt cells in declaration order; later task rows supply inherited/satisfied labels.
 * Only rows after each cell's own evidence line count. */
export function runGateCells(task: OperatorTask, evidence: EvidenceLookup, rows: readonly RunEvidenceRow[] = []): readonly RunGateCell[] {
  return GATE_NAMES.map((gate): RunGateCell => {
    const cell = task.gates[gate] ?? { state: "unknown" as const };
    const line = cell.evidence?.line;
    const row = line === undefined ? undefined : evidence(line);
    const data = row?.event?.data;
    const labels: string[] = [];
    let outcome: GateOutcome | undefined;
    if (data === undefined) {
      labels.push(line === undefined ? { "not-run": "not run", disabled: "disabled by policy", queued: "queued", running: "running", unknown: "unknown", passed: "passed", failed: "failed" }[cell.state] : `evidence #L${line} unavailable`);
    } else if (cell.state === "queued") {
      labels.push(`queued — ${row?.event?.event ?? "wait"}${typeof data.count === "number" ? ` (${data.count} suites)` : ""}`);
    } else if (data.disabled === true) {
      labels.push("disabled by policy");
    } else if (["gate-start", "gate-phase-start", "phase-start"].includes(row?.event?.event ?? "")) {
      labels.push("running");
    } else {
      outcome = normalizeGateOutcome(data);
      labels.push(outcomeLabel(outcome));
      // Baseline forgiveness is recorded only in the battery's own details text (baseline.ts); read it
      // from that row alone, for the three gates that battery runs, never from any other prose.
      if (BASELINE_GATES.has(gate) && data.pass === true && /\(forgiven\)/u.test(String(data.details ?? ""))) labels.push("baseline-forgiven (pre-existing failures)");
      if (data.replayMeasurement === true) labels.push("replayed measurement");
      if (gate === "review") {
        labels.push(`reviewer ${str(data.reviewer) ?? "unknown"}`, `reviewer tier ${str(data.reviewerTier) ?? "unknown"}`, `author tier ${str(data.authorTier) ?? "unknown"}`, `reviewer floor ${str(data.reviewerFloor) ?? "unknown"}`);
      }
    }
    for (const later of line === undefined ? rows : evidence.later(line)) {
      if (line === undefined || later.line <= line || later.event?.taskId !== task.id) continue;
      const e = later.event;
      if (e.event === "gate-reused" && e.data.gate === gate) labels.push(`inherited from ${str(e.data.commit) ?? "unknown commit"} · #L${later.line}`);
      if (e.event === "task-approved" && e.data.release === "gate-satisfied" && e.data.gate === gate) labels.push(`satisfied by approval #L${later.line}`);
    }
    const verdict = row?.event?.event === "gate-result" && typeof data?.details === "string" ? data.details.split("\n") : [];
    return { gate, state: cell.state, letter: GATE_CELL_LETTERS[cell.state], ...(line === undefined ? {} : { line }), ...(outcome ? { outcome } : {}), outcomeClass: outcomeClassOf(outcome, cell.state), labels, verdict };
  });
}

export const VERDICT_WINDOW = 10;

export interface RunViewSession {
  readonly selection: number;
  /** Index into GATE_NAMES of the gate whose verdict is open. */
  readonly verdictGate: number;
  readonly verdictOffset: number;
  readonly outcomeFilter: OutcomeFilter;
  readonly decisions: DecisionSession;
}

export const initialRunViewSession = (): RunViewSession => ({ selection: 0, verdictGate: GATE_NAMES.indexOf("review"), verdictOffset: 0, outcomeFilter: "all", decisions: initialDecisionSession() });

export interface RunViewKeyEvent {
  readonly input: string;
  readonly key: { readonly upArrow?: boolean; readonly downArrow?: boolean; readonly leftArrow?: boolean; readonly rightArrow?: boolean; readonly return?: boolean; readonly escape?: boolean; readonly pageUp?: boolean; readonly pageDown?: boolean };
}

export interface RunViewKeyResult { readonly session: RunViewSession; readonly open?: DecisionCommand; readonly confirm?: DecisionPreview }

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * ↑↓ select a task, ←→ choose the verdict gate, PageUp/PageDown page the verdict, x cycles the
 * outcome selector, and a/Enter/y/n/Esc are the decision flow's. A digit is never a view switch here.
 */
export function applyRunViewKey(session: RunViewSession, event: RunViewKeyEvent, ctx: { tasks: readonly OperatorTask[]; decisions: readonly RunDecision[]; verdictLines: number }): RunViewKeyResult {
  const task = ctx.tasks[session.selection];
  const selected = task === undefined ? undefined : ctx.decisions.find((d) => d.taskId === task.id);
  const decided = applyDecisionKey(session.decisions, event, selected);
  if (decided.handled) return { session: { ...session, decisions: decided.session }, ...(decided.open ? { open: decided.open } : {}), ...(decided.confirm ? { confirm: decided.confirm } : {}) };
  if (event.key.upArrow === true || event.key.downArrow === true) {
    const selection = clamp(session.selection + (event.key.upArrow === true ? -1 : 1), 0, Math.max(0, ctx.tasks.length - 1));
    return { session: { ...session, selection, verdictOffset: 0 } };
  }
  if (event.key.leftArrow === true || event.key.rightArrow === true) {
    return { session: { ...session, verdictGate: clamp(session.verdictGate + (event.key.leftArrow === true ? -1 : 1), 0, GATE_NAMES.length - 1), verdictOffset: 0 } };
  }
  if (event.key.pageUp === true || event.key.pageDown === true) {
    const last = Math.max(0, ctx.verdictLines - VERDICT_WINDOW);
    return { session: { ...session, verdictOffset: clamp(session.verdictOffset + (event.key.pageUp === true ? -VERDICT_WINDOW : VERDICT_WINDOW), 0, last) } };
  }
  if (event.input === "x") {
    return { session: { ...session, outcomeFilter: OUTCOME_FILTERS[(OUTCOME_FILTERS.indexOf(session.outcomeFilter) + 1) % OUTCOME_FILTERS.length]! } };
  }
  return { session };
}

const UNRESOLVED = ["failed", "human", "blocked", "pending"] as const;

/**
 * The one-line lifecycle summary drawn above the matrix. Unresolved members come from the tasks'
 * current recorded states (the run-end buckets are C2's green authority, invalidated by a resume);
 * a closed run whose record lacks a bucket says so rather than reading absence as empty.
 */
export function runSummaryLine(s: OperatorSnapshot): string {
  const members = UNRESOLVED.map((k) => { const ids = s.tasks.filter((t) => t.state === k).map((t) => t.id); return ids.length === 0 ? "" : `${k} ${ids.join(",")}`; }).filter(Boolean);
  const unknownBuckets = s.latestRunEnd === undefined ? [] : UNRESOLVED.filter((k) => s.buckets[k] === undefined);
  return [
    `${s.merged}/${s.planned ?? "?"} merged`,
    ...members,
    ...(unknownBuckets.length === 0 ? [] : [`run-end bucket ${unknownBuckets.join("/")} unknown`]),
    `current-cycle tip ${s.currentTip.toUpperCase()}`,
    s.label, s.comparison, `snapshot #${s.sequence}`,
  ].join(" | ");
}

const attemptLabel = (t: OperatorTask): string => (t.attempt !== undefined ? `attempt ${t.attempt}` : t.dispatches === 0 ? "never dispatched" : "attempt unknown");
const parkOf = (t: OperatorTask): string => (t.state === "human" ? `human · ${t.parkKind ?? "unknown kind"}` : t.state);


/* ------------------------------------------------------------------------ */
/* T9 — the shared projection per task, each field naming the journal line   */
/* it was read from; and the pane locator, which only ever reads.             */
/* ------------------------------------------------------------------------ */

/** One projected reading and the physical journal line it came from; no line means no row says it. */
export interface ProjectionField { readonly label: string; readonly line?: number }
export interface TaskProjection {
  readonly taskId: string;
  readonly identity: ProjectionField;
  readonly phase: ProjectionField;
  readonly build: ProjectionField;
  readonly blocker: ProjectionField;
  readonly nextAction: ProjectionField;
  /** OBS-1048: present only when the newest launched attempt has failed nudges, pages and no worker-result. */
  readonly stalled?: ProjectionField;
}

export const STALL_MARKER = "⚠ stalled harvest suspected";
const ordinal = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const slotNameOf = (data: Record<string, unknown>): string | undefined => {
  const slot = data.slot;
  return str(data.slotName) ?? (typeof slot === "object" && slot !== null ? str((slot as Record<string, unknown>).name) : str(slot));
};
const NO_ROW = "no journal row";
const readLabel = (f: ProjectionField): string => `${f.label} ${f.line === undefined ? `(${NO_ROW})` : `#L${f.line}`}`;

/**
 * The evidence-only projection status renders (run/activity.ts, run/operator-summary.ts), folded
 * over the journal rows this view was handed, with the physical line each reading was taken from.
 * Nothing is inferred from a title, a provider or a task id: an unrecorded field says so.
 */
export function projectRunTasks(snapshot: OperatorSnapshot, rows: readonly RunEvidenceRow[], graph: RunGraph | undefined, decisions: readonly RunDecision[], runId: string): readonly TaskProjection[] {
  const ordered = [...rows].filter((r) => r.event !== undefined).sort((a, b) => a.line - b.line);
  const graphTask = (id: string) => graph?.tasks.find((t) => t.id === id);
  const activityTasks = snapshot.tasks.map((t) => ({ id: t.id, gates: graphTask(t.id)?.gates ?? [...GATE_NAMES], deps: graphTask(t.id)?.deps ?? [], status: t.state }));
  const tracked = trackJournalRows(runId, ordered.map((r) => ({ raw: r.event, sourceIndex: r.line })));
  const activity = projectActivity(runId, tracked, activityTasks);
  const byTask = (id: string) => ordered.filter((r) => r.event?.taskId === id);
  const summaries = new Map(projectOperatorSummary(snapshot.tasks.map((t) => {
    const own = byTask(t.id);
    const responsibility = [...own].reverse().find((r) => str(r.event!.data.role) !== undefined || str(r.event!.data.agent) !== undefined);
    // The summary's own vocabulary (derive.ts reads the graph status for an unmentioned task): a task the
    // operator fold holds as blocked, or a graph task the journal never mentions, is pending on its prerequisites.
    const status = t.state === "blocked" || (t.state === "unknown" && graphTask(t.id) !== undefined) ? "pending" : t.state;
    return {
      id: t.id, status, deps: graphTask(t.id)?.deps ?? [],
      ...(own.length === 0 ? {} : { phase: activity.get(t.id)?.state, lastEvidenceAt: own.at(-1)!.event!.ts }),
      ...(responsibility ? { responsible: { role: str(responsibility.event!.data.role), agent: str(responsibility.event!.data.agent) } } : {}),
    };
  }), decisions.map((d) => ({ taskId: d.taskId, park: { kind: d.park.kind, tombstone: d.park.tombstone, ...(d.park.reason === undefined ? {} : { reason: d.park.reason }) }, verbs: d.verbs, ...(d.diagnostic === undefined ? {} : { diagnostic: d.diagnostic }) }))).map((s) => [s.taskId, s]));
  return snapshot.tasks.map((t): TaskProjection => {
    const own = byTask(t.id);
    const act = activity.get(t.id);
    const summary = summaries.get(t.id);
    // identity: the newest row that recorded a role, an agent, an owned slot name or a dispatch assignment
    const identityRow = [...own].reverse().find((r) => { const d = r.event!.data; if (act?.attempt !== undefined && ordinal(d.attempt) !== undefined && ordinal(d.attempt) !== act.attempt) return false; return str(d.role) !== undefined || str(d.agent) !== undefined || slotNameOf(d) !== undefined || (r.event!.event === "task-dispatch" && d.assignment !== undefined); });
    let identity: ProjectionField = { label: "identity unrecorded" };
    if (identityRow) {
      const d = identityRow.event!.data;
      const name = slotNameOf(d);
      const owned = name === undefined ? null : parseOwnedName(name);
      const role = str(d.role) ?? owned?.role ?? (identityRow.event!.event === "worker-launch" ? "worker" : "role unrecorded");
      const a = d.assignment as { adapter?: unknown; model?: unknown } | undefined;
      const agent = str(d.agent) ?? name ?? (typeof a?.adapter === "string" && typeof a.model === "string" ? `${a.adapter}:${a.model}` : "agent unrecorded");
      identity = { label: `${role} ${agent}`, line: identityRow.line };
    }
    // Finding 2: the reference is the row whose acceptance CHANGED the projected value — a rejected
    // receipt or a delayed old-attempt result changes nothing and so is never cited. The task's rows
    // and the run-level resets are re-folded prefix by prefix through projectActivity itself.
    // ponytail: O(k²) in the task's own rows; memoize the fold if journals reach thousands of rows per task.
    const changes = acceptedChanges(runId, tracked, t.id, activityTasks.find((a) => a.id === t.id)!);
    const phase: ProjectionField = { label: `phase ${summary?.phase ?? act?.state ?? "unrecorded"}`, ...(own.length > 0 && changes.state !== undefined ? { line: changes.state } : {}) };
    const b = act?.build;
    const receipt = b !== undefined && "receipt" in b ? b.receipt : undefined;
    const build: ProjectionField = { label: `build ${b?.state ?? "start-unrecorded"}${receipt ? ` exit ${receipt.exitCode ?? "-"}` : ""}`, ...(changes.build !== undefined ? { line: changes.build } : {}) };
    const decision = decisions.find((d) => d.taskId === t.id);
    const blockerRow = decision ? { line: decision.park.line } : [...own].reverse().find((r) => r.event!.event === "task-human" || r.event!.event === "task-failed");
    const blk = summary?.blocker;
    const blocker: ProjectionField = { label: `blocker ${blk ? `${blk.kind}${blk.diagnostic ? ` · ${blk.diagnostic}` : ""}` : "none"}`, ...(blk && blockerRow ? { line: blockerRow.line } : {}) };
    const nextAction: ProjectionField = { label: `next ${blk?.nextAction ?? "none"}`, ...(blk?.nextAction && blockerRow ? { line: blockerRow.line } : {}) };
    // OBS-1048 harvest, chronological: the newest worker-launch opens the attempt; a later worker-result retires it.
    let launched: number | undefined, launchedAttempt: number | undefined, returned = false;
    const nudges: number[] = [], pages: number[] = [];
    // Finding 1: only rows of the launched attempt count; a row without an attempt belongs to it (derive.ts attemptHarvests).
    const ofLaunched = (d: Record<string, unknown>) => launched !== undefined && (ordinal(d.attempt) ?? launchedAttempt) === launchedAttempt;
    for (const r of own) {
      const e = r.event!;
      switch (e.event) {
        case "worker-launch": launched = r.line; launchedAttempt = ordinal(e.data.attempt); returned = false; nudges.length = 0; pages.length = 0; break;
        case "worker-nudge-failed": if (ofLaunched(e.data)) nudges.push(r.line); break;
        case "operator-page": if (ofLaunched(e.data)) pages.push(r.line); break;
        case "worker-result": if (ofLaunched(e.data)) returned = true; break;
      }
    }
    const stalled = launched !== undefined && !returned && nudges.length > 0 && pages.length > 0
      ? { label: `${STALL_MARKER} · launch #L${launched} · nudge failed ${nudges.map((l) => `#L${l}`).join(",")} · paged ${pages.map((l) => `#L${l}`).join(",")} · no worker-result`, line: launched }
      : undefined;
    return { taskId: t.id, identity, phase, build, blocker, nextAction, ...(stalled ? { stalled } : {}) };
  });
}

/** The line at which each projected value last changed, folding the task's rows (and run-level resets) prefix by prefix. */
function acceptedChanges(runId: string, tracked: ReturnType<typeof trackJournalRows>, taskId: string, task: Parameters<typeof projectActivity>[2][number]): { state?: number; build?: number } {
  const rows = tracked.filter((r) => { const raw = r.raw as { taskId?: unknown; event?: unknown }; return raw.taskId === taskId || (raw.taskId === undefined && (raw.event === "run-resume" || raw.event === "run-end")); });
  const buildKey = (p: ReturnType<typeof projectActivity> extends Map<string, infer P> ? P : never) => `${p.build.state}|${"receipt" in p.build ? `${p.build.receipt.attribution.invocation}|${p.build.receipt.exitCode ?? ""}` : ""}`;
  // Seeded from the empty fold: the initial reading is no row's doing, so only a change is cited.
  const initial = projectActivity(runId, [], [task]).get(taskId);
  let state: string | undefined = initial?.state, build: string | undefined = initial === undefined ? undefined : buildKey(initial);
  const out: { state?: number; build?: number } = {};
  for (let i = 0; i < rows.length; i++) {
    const p = projectActivity(runId, rows.slice(0, i + 1), [task]).get(taskId);
    if (!p) continue;
    const line = rows[i]!.sourceIndex;
    if (p.state !== state) { state = p.state; out.state = line; }
    if (buildKey(p) !== build) { build = buildKey(p); out.build = line; }
  }
  return out;
}

/** One wrapped line per task: every field with its line, and the stall marker when the harvest is suspect. */
export const projectionLine = (p: TaskProjection): string => [p.taskId, readLabel(p.identity), readLabel(p.phase), readLabel(p.build), readLabel(p.blocker), readLabel(p.nextAction), ...(p.stalled ? [p.stalled.label] : [])].join(" · ");

export interface PaneLocator {
  readonly status: "recorded" | "unavailable";
  readonly reason: string;
  /** The worker-launch row the reading stands on, when one exists. */
  readonly line?: number;
}

/**
 * Where the current attempt's pane is recorded — and only that. The reading is exact-name: the
 * launch row's slot name must be the owned name of THIS task, attempt and run. No terminal is ever
 * chosen by title, provider or task id; a missing, foreign, stale or ambiguous record reads
 * unavailable with the rows it was read from, and reading never touches a host.
 */
export function paneLocator(task: OperatorTask, rows: readonly RunEvidenceRow[], runId: string): PaneLocator {
  const ordered = [...rows].filter((r) => r.event !== undefined).sort((a, b) => a.line - b.line);
  // The dispatch-recorded pane field stays reachable beside every reading, with the row it stands on.
  const recorded = task.pane === undefined ? "" : ` · recorded pane ${task.pane}${task.evidence ? ` · evidence #L${task.evidence.line}` : ""}`;
  if (task.attempt === undefined) return { status: "unavailable", reason: `no recorded attempt${recorded}` };
  const launches = ordered.filter((r) => r.event!.event === "worker-launch" && r.event!.taskId === task.id && ordinal(r.event!.data.attempt) === task.attempt);
  if (launches.length === 0) return { status: "unavailable", reason: `no worker-launch for attempt ${task.attempt}${recorded}` };
  const ids = new Set(launches.map((r) => { const s = r.event!.data.slot as { id?: unknown } | undefined; return str(s?.id) ?? `#L${r.line}`; }));
  if (ids.size > 1) return { status: "unavailable", reason: `ambiguous: ${launches.length} launches ${launches.map((r) => `#L${r.line}`).join(",")}${recorded}` };
  const launch = launches.at(-1)!;
  const d = launch.event!.data;
  const slot = d.slot as { id?: unknown; cwd?: unknown; name?: unknown } | undefined;
  const expected = formatOwnedName({ role: "worker", taskId: task.id, attempt: task.attempt, runId });
  if (str(d.driver) === undefined || str(slot?.id) === undefined || str(slot?.cwd) === undefined) return { status: "unavailable", reason: `launch #L${launch.line} lacks driver or slot identity${recorded}`, line: launch.line };
  if (slot?.name !== expected) return { status: "unavailable", reason: `launch #L${launch.line} names ${slotNameOf(d) ?? "no pane"}, not this attempt's owned pane${recorded}`, line: launch.line };
  // Finding 3: only a host whose focus capability VERIFIES the recorded identity can ever confirm it —
  // herdr needs the launch's workspace (HerdrDriver.focus rejects a target without one), orca verifies
  // ownership but cannot focus, subprocess and unknown drivers verify nothing. Reading asks no host.
  const driver = String(d.driver);
  if (driver === "herdr" && str(d.workspace) === undefined) return { status: "unavailable", reason: `launch #L${launch.line} records no workspace; herdr cannot verify the pane${recorded}`, line: launch.line };
  if (driver !== "herdr" && driver !== "orca") return { status: "unavailable", reason: `launch #L${launch.line} driver ${driver} cannot verify a pane${recorded}`, line: launch.line };
  const stale = ordered.find((r) => {
    if (r.line <= launch.line) return false;
    const event = r.event!;
    if (event.event === "run-resume" || event.event === "run-end") return true;
    if (event.taskId !== task.id) return false;
    if (event.event === "worker-result") return (ordinal(event.data.attempt) ?? task.attempt) === task.attempt;
    if (event.event === "pane-close") return str(event.data.paneId) === str(slot?.id);
    return event.event === "merge";
  });
  if (stale) return { status: "unavailable", reason: `launch #L${launch.line} is stale: ${stale.event!.event} #L${stale.line} followed it${recorded}`, line: launch.line };
  // A journal launch is evidence of what was opened, not a live-host observation. This pure read
  // deliberately performs no focus/list operation, so it cannot upgrade the locator to recorded:
  // the pane may have been closed outside the journal. The explicit `o` action owns verification.
  return { status: "unavailable", reason: `launch #L${launch.line} records ${driver} ${String(slot!.id)}, but live host verification is required${recorded}`, line: launch.line };
}

/** The board's footer keys merged with the cockpit's own — every one of them handled by this view or the shell. */
export const RUN_VIEW_KEYS: readonly string[] = [...BOARD_KEYS.slice(0, 2), "←→ verdict gate", "PgUp/PgDn page", "x outcome", "a actions", "o pane", "Tab focus", "? keys", BOARD_KEYS[2]];

export interface RunViewProps {
  readonly snapshot: OperatorSnapshot;
  /** Journal rows the store retains (C2 `journal.history`); evidence outside them reaches `page`. */
  readonly rows: readonly RunEvidenceRow[];
  readonly page?: EvidencePage;
  readonly graph?: RunGraph;
  readonly decisions: readonly RunDecision[];
  readonly session: RunViewSession;
  readonly columns: number;
  readonly run: ApprovalRunOwner;
  /** The clock the board header reads; injectable so a pinned frame does not drift. */
  readonly now?: () => number;
}

/** The Run body: the approved board (BD-1) over the fold, then the selected task's detail panels. */
export function RunView({ snapshot, rows, page, graph, decisions, session, columns, run, now = Date.now }: RunViewProps): ReactElement {
  const inner = Math.max(1, Math.floor(columns) - 4);
  const colour = useContext(ShellTheme).mode !== "none";
  const width = Math.max(1, Math.floor(columns));
  const fit = (text: string): string => fitCells(text, inner);
  const decisionLines = (lines: readonly string[]): string[] => lines.flatMap((line) => wrapCells(line, inner));
  const lookup = evidenceLookup(rows, page);
  const wrap = (text: string): string[] => wrapCells(text, inner);
  // The whole journal, not the retained tail: the projection and the locator read every row.
  const allRows = lookup.later(0);
  const projections = projectRunTasks(snapshot, allRows, graph, decisions, run.runId);
  const tasks = snapshot.tasks;
  const selection = Math.min(session.selection, Math.max(0, tasks.length - 1));
  const task = tasks[selection];
  const cells = task === undefined ? [] : runGateCells(task, lookup, rows);
  const shown = cells.filter((c) => session.outcomeFilter === "all" || c.outcomeClass === session.outcomeFilter);
  const verdictCell = cells[session.verdictGate];
  const verdict = verdictCell?.verdict ?? [];
  const from = Math.min(session.verdictOffset, Math.max(0, verdict.length - 1));
  const window = verdict.slice(from, from + VERDICT_WINDOW);
  const decision = task === undefined ? undefined : decisions.find((d) => d.taskId === task.id);
  const { menu, confirming, receipt, notice } = session.decisions;
  const blocked = task === undefined ? [] : graph?.tasks.filter((g) => g.deps.includes(task.id)).map((g) => g.id) ?? decision?.blocks ?? [];
  const board = renderBoardLines({ runId: run.runId, snapshot, graph, now: now(), live: run.live, selection: task?.id, keys: false, colour }, width);
  return (
    <Box flexDirection="column" width={columns}>
      <BodyText emphasis="dim">{fitCells(`RUN / ${snapshot.lifecycle} · ${runSummaryLine(snapshot)}`, width)}</BodyText>
      {/* an empty Text has no height in Ink; the prototype's blank rows are one space so they keep their row */}
      {board.map((line, i) => <BodyText key={`${i}:${line}`}>{line || " "}</BodyText>)}
      {tasks.length === 0 && <BodyText>{fitCells("no tasks recorded — no plan", width)}</BodyText>}
      {task !== undefined && (
        <Panel title={`SELECTED / ${task.id}${task.title ? ` · ${task.title}` : ""}`}>
          {wrap(`state ${parkOf(task)} · ${attemptLabel(task)} · dispatches ${task.dispatches} · path ${task.path ?? "unknown"} · pane ${task.pane ?? "unknown"} · alarm ${task.alarmMs === undefined ? "unknown" : `${task.alarmMs}ms`}${task.mergeEvidence ? ` · merged #L${task.mergeEvidence.line}` : ""} · locator ${(() => { const l = paneLocator(task, allRows, run.runId); return l.status === "recorded" ? `recorded ${l.reason}` : `unavailable — ${l.reason}`; })()}`).map((line, i) => <BodyText key={`${i}:${line}`}>{line}</BodyText>)}
          <BodyText emphasis="dim">{fit(`outcome filter ${session.outcomeFilter} (x cycles) · ${shown.length} of ${cells.length} gates shown`)}</BodyText>
          {shown.map((c) => (
            <BodyText key={c.gate}>{fit(`${c.letter} ${c.gate.padEnd(10)} ${c.labels.join(" · ")}${c.line === undefined ? "" : ` · #L${c.line}`}`)}</BodyText>
          ))}
        </Panel>
      )}
      {projections.length > 0 && (
        <Panel title="PROJECTION / every task · identity · phase · build · blocker · next action, each with its journal line">
          {projections.flatMap((p) => wrap(projectionLine(p)).map((line, i) => <BodyText key={`${p.taskId}:${i}`} emphasis={p.stalled && i === 0 ? "strong" : "normal"}>{line}</BodyText>))}
        </Panel>
      )}
      {verdictCell !== undefined && (
        <Panel title={`VERDICT / ${verdictCell.gate}${verdictCell.line === undefined ? "" : ` #L${verdictCell.line}`} · ${verdict.length === 0 ? "no verdict text" : `lines ${from + 1}–${from + window.length} of ${verdict.length}`}`}>
          {window.map((line, i) => <BodyText key={`${from + i}:${line}`}>{fit(`${String(from + i + 1).padStart(4)} ${line}`)}</BodyText>)}
          <BodyText emphasis="dim">{fit("←→ gate · PageUp/PageDown page")}</BodyText>
        </Panel>
      )}
      {task?.state === "human" && (
        <Panel title={`PARK / ${task.id}`}>
          {decision === undefined
            ? <BodyText>{fit("park evidence unavailable — refresh before deciding")}</BodyText>
            : (
              <>
                {wrap(`#L${decision.park.line} ${decision.park.kind ?? "unknown kind"}${decision.park.failedGate ? ` · failed gate ${decision.park.failedGate}` : ""} · ${decision.park.reason ?? "no reason recorded"}`).map((line, i) => <BodyText key={`park:${i}`}>{line}</BodyText>)}
                <BodyText>{fit(`blocks ${blocked.length === 0 ? "nothing" : blocked.join(", ")} · attempts ${decision.attempts}`)}</BodyText>
                {wrap(decision.verbs.length === 0 ? `diagnostic: ${decision.diagnostic ?? "no verb"}` : `decisions: ${decision.verbs.join(" · ")} (a Actions)`).map((line, i) => <BodyText key={`verbs:${i}`}>{line}</BodyText>)}
                <BodyText emphasis="dim">{fit(run.live ? "matching live daemon enacts a release at its next task boundary" : run.blockingRunId ? `other live run ${run.blockingRunId} holds the lock; resume after it ends` : "no live owner: a release records permission; resume dispatches")}</BodyText>
              </>
            )}
        </Panel>
      )}
      {menu !== null && (
        <Panel title={`ACTIONS / ${menu.taskId}`} focused>
          {menu.verbs.length === 0
            ? <BodyText>{fit(`no decision — ${decision?.diagnostic ?? "no verb for this park"}`)}</BodyText>
            : menu.verbs.map((verb, i) => <BodyText key={verb} emphasis={i === menu.selection ? "strong" : "normal"}>{fit(`${i === menu.selection ? `${GLYPHS.pointer} ` : "  "}${verb}`)}</BodyText>)}
        </Panel>
      )}
      {confirming !== null && (
        <Panel title={`CONFIRM ${confirming.command.verb.toUpperCase()}`} focused>
          {decisionLines(decisionConfirmLines(confirming)).map((line, i) => <BodyText key={`${i}:${line}`}>{line}</BodyText>)}
        </Panel>
      )}
      {receipt !== null && (
        <Panel title={receipt.ok ? "RECEIPT · appended" : "RECEIPT · refused"}>
          {decisionLines(decisionReceiptLines(receipt)).map((line, i) => <BodyText key={`${i}:${line}`}>{line}</BodyText>)}
        </Panel>
      )}
      {notice !== null && <BodyText>{notice}</BodyText>}
      <BodyText emphasis="dim">{clipBoard(boardFooter([...RUN_VIEW_KEYS, decisionKeybar(session.decisions, decision)].filter(Boolean), colour), width)}</BodyText>
    </Box>
  );
}
