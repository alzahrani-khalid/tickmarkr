import { Box } from "ink";
import type { ReactElement } from "react";
import { GLYPHS } from "../../brand.js";
import type { ApprovalRunOwner } from "../../cli/commands/approve.js";
import { GATE_NAMES, type GateName, type RunGraph } from "../../graph/schema.js";
import type { JournalEvent } from "../../run/journal.js";
import { normalizeGateOutcome, type GateOutcome } from "../../run/outcome.js";
import type { OperatorGateState, OperatorSnapshot, OperatorTask } from "../../run/operator-state.js";
import { BodyText, Panel } from "./components.js";
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
  passed: "P", failed: "F", running: "R", "not-run": "-", disabled: "D", unknown: "?",
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

/**
 * The current attempt's seven cells in declaration order. `rows` supplies the later journal rows
 * that give a cell its inherited/satisfied label; only rows for this task after the evidence line count.
 */
export function runGateCells(task: OperatorTask, evidence: EvidenceLookup, rows: readonly RunEvidenceRow[] = []): readonly RunGateCell[] {
  return GATE_NAMES.map((gate): RunGateCell => {
    const cell = task.gates[gate] ?? { state: "unknown" as const };
    const line = cell.evidence?.line;
    const row = line === undefined ? undefined : evidence(line);
    const data = row?.event?.data;
    const labels: string[] = [];
    let outcome: GateOutcome | undefined;
    if (data === undefined) {
      labels.push(line === undefined ? { "not-run": "not run", disabled: "disabled by policy", running: "running", unknown: "unknown", passed: "passed", failed: "failed" }[cell.state] : `evidence #L${line} unavailable`);
    } else if (data.disabled === true) {
      labels.push("disabled by policy");
    } else if (row?.event?.event === "gate-start") {
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
    const verdict = typeof data?.details === "string" ? data.details.split("\n") : [];
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

/** One matrix row: id, state, the seven letters in declaration order, the recorded attempt. */
export function runTaskRow(t: OperatorTask, cells: readonly Pick<RunGateCell, "letter">[]): string {
  return `${t.id.padEnd(4)} ${parkOf(t).padEnd(20)} ${cells.map((c) => c.letter).join("  ")}  ${attemptLabel(t)}`;
}

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
}

const MATRIX_HEADER = `${"Task".padEnd(4)} ${"state".padEnd(20)} ${GATE_NAMES.map((g) => g.slice(0, 2)).join(" ")}  latest attempt`;
const MATRIX_LEGEND = "P pass · F fail · R running · - not run · D disabled · ? unknown | declaration order, not a timeline · acceptance/review concurrent, optional";

/** The Run body. Every line is measured through the width module; nothing overflows its column. */
export function RunView({ snapshot, rows, page, graph, decisions, session, columns, run }: RunViewProps): ReactElement {
  const inner = Math.max(1, Math.floor(columns) - 4);
  const fit = (text: string): string => fitCells(text, inner);
  const decisionLines = (lines: readonly string[]): string[] => lines.flatMap((line) => wrapCells(line, inner));
  const lookup = evidenceLookup(rows, page);
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
  return (
    <Box flexDirection="column" width={columns}>
      <Panel title={`RUN / ${snapshot.lifecycle}`} focused>
        <BodyText emphasis="dim">{fit(runSummaryLine(snapshot))}</BodyText>
        <BodyText emphasis="dim">{fit(`  ${MATRIX_HEADER}`)}</BodyText>
        {tasks.map((t, i) => (
          <BodyText key={t.id} emphasis={i === selection ? "strong" : "normal"}>
            {fit(`${i === selection ? `${GLYPHS.pointer} ` : "  "}${runTaskRow(t, GATE_NAMES.map((gate) => ({ letter: GATE_CELL_LETTERS[t.gates[gate].state] })))}`)}
          </BodyText>
        ))}
        {tasks.length === 0 && <BodyText>{fit("no tasks recorded — no plan")}</BodyText>}
        <BodyText emphasis="dim">{fit(MATRIX_LEGEND)}</BodyText>
      </Panel>
      {task !== undefined && (
        <Panel title={`SELECTED / ${task.id}${task.title ? ` · ${task.title}` : ""}`}>
          <BodyText>{fit(`state ${parkOf(task)} · ${attemptLabel(task)} · dispatches ${task.dispatches} · path ${task.path ?? "unknown"} · pane ${task.pane ?? "unknown"} · alarm ${task.alarmMs === undefined ? "unknown" : `${task.alarmMs}ms`}${task.mergeEvidence ? ` · merged #L${task.mergeEvidence.line}` : ""}`)}</BodyText>
          <BodyText emphasis="dim">{fit(`outcome filter ${session.outcomeFilter} (x cycles) · ${shown.length} of ${cells.length} gates shown`)}</BodyText>
          {shown.map((c) => (
            <BodyText key={c.gate}>{fit(`${c.letter} ${c.gate.padEnd(10)} ${c.labels.join(" · ")}${c.line === undefined ? "" : ` · #L${c.line}`}`)}</BodyText>
          ))}
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
                <BodyText>{fit(`#L${decision.park.line} ${decision.park.kind ?? "unknown kind"}${decision.park.failedGate ? ` · failed gate ${decision.park.failedGate}` : ""} · ${decision.park.reason ?? "no reason recorded"}`)}</BodyText>
                <BodyText>{fit(`blocks ${blocked.length === 0 ? "nothing" : blocked.join(", ")} · attempts ${decision.attempts}`)}</BodyText>
                <BodyText>{fit(decision.verbs.length === 0 ? `diagnostic: ${decision.diagnostic ?? "no verb"}` : `decisions: ${decision.verbs.join(" · ")} (a Actions)`)}</BodyText>
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
      <BodyText emphasis="dim">{fitCells(["↑↓ Task", "←→ Verdict gate", "PgUp/PgDn Page", "x Outcome", decisionKeybar(session.decisions, decision)].filter(Boolean).join(" · "), Math.max(1, Math.floor(columns)))}</BodyText>
    </Box>
  );
}
