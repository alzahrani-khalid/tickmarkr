import { graphDefinitionHash } from "../graph/graph.js";
import { GATE_NAMES, type RunGraph } from "../graph/schema.js";
import { engagementComparable, type JournalEvent } from "./journal.js";

/** An evidence identity is a physical journal line, never a filtered row ordinal. */
export interface EvidenceIdentity { source: string; line: number; id: string; generation?: number }
export interface OperatorRecord extends EvidenceIdentity { event: JournalEvent }
export type OperatorTaskState = "unknown" | "pending" | "running" | "completed" | "merged" | "failed" | "human" | "blocked";
export type OperatorGateState = "unknown" | "not-run" | "disabled" | "queued" | "running" | "passed" | "failed";
export interface OperatorGate { state: OperatorGateState; evidence?: EvidenceIdentity }
export interface GateActivity {
  state: "queued" | "running"; gate?: string; reason?: "suite-wait" | "host-degraded";
  count?: number; evidence: EvidenceIdentity;
}
export interface OperatorTask {
  id: string; title?: string; state: OperatorTaskState; merged: boolean;
  dispatches: number; attempt?: number; path?: string; pane?: string; alarmMs?: number;
  parkKind?: string; evidence?: EvidenceIdentity; mergeEvidence?: EvidenceIdentity;
  gates: Record<string, OperatorGate>;
  gateActivity?: GateActivity;
  /** BD-1: the board's per-task counters — latest dispatch channel, review verdicts drawn, human parks. */
  channel?: string; reviewRounds: number; parks: number;
  /** Distinct producing channels of the merged subject from task-done; "unknown" names unattributed preserved work.
   * Kept apart from `channel`: the last-dispatched seat may have authored nothing. */
  authors?: readonly string[];
}
export interface OperatorSnapshot {
  sequence: number; observedAt: number; lastEventAt?: string; firstEventAt?: string;
  /** BD-1 header counts: run-resume and escalation rows seen. */
  resumes: number; escalations: number;
  lifecycle: "PENDING" | "RUNNING" | "PARTIAL" | "APPROVED" | "COMPLETE" | "UNKNOWN";
  label: string; green: boolean; currentTip: "passed" | "not required" | "pending" | "failed" | "unknown";
  graphAvailability?: { status: "readable" | "absent" | "unreadable"; error?: string };
  comparable: boolean; comparison: "matching graph" | "not comparable";
  merged: number; planned?: number; tasks: readonly OperatorTask[];
  buckets: Record<"failed" | "human" | "blocked" | "pending", readonly string[] | undefined>;
  gatesRan: { passed: number; total: number }; latestRunEnd?: EvidenceIdentity;
  approvedResumeRequired: boolean;
}
const bucketNames = ["failed", "human", "blocked", "pending"] as const;
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(v => typeof v === "string") ? [...value] : undefined;
const identity = ({ source, line, id, generation }: EvidenceIdentity): EvidenceIdentity => ({ source, line, id, generation });
const emptyGates = (): Record<string, OperatorGate> => Object.fromEntries(GATE_NAMES.map(g => [g, { state: "not-run" }]));
/** Author channels recorded on a task-done row. A row written before authors were recorded carries none and
 * projects nothing (never the dispatch); unattributed preserved work arrives as an explicit "unknown" entry. */
export const doneAuthors = (data: Record<string, unknown>): string[] | undefined => strings(data.authors);
/** The note a status row or board row shows beside the last-dispatched channel when the merged
 * authors are not exactly that channel (a carry-only seat, a mixed subject, or legacy unknown). */
export const authorsNote = (authors: readonly string[] | undefined, channel: string | undefined): string | undefined =>
  authors === undefined || (authors.length === 1 && authors[0] === channel) ? undefined : `authors ${authors.join("+")}`;

/** Incremental pure lifecycle fold. Retains facts per task/gate, never verdict bodies or event history. */
export class OperatorStateFold {
  private tasks = new Map<string, OperatorTask>();
  private start?: OperatorRecord;
  private startEvent?: JournalEvent;
  private rehashes: JournalEvent[] = [];
  private end?: { evidence: EvidenceIdentity; buckets: OperatorSnapshot["buckets"]; tip: OperatorSnapshot["currentTip"] };
  private active = false;
  private approved = false;
  private tipFailed = false;
  private lastEventAt?: string;
  private firstEventAt?: string;
  private resumes = 0;
  private escalations = 0;
  private passed = 0;
  private total = 0;

  apply(record: OperatorRecord): void {
    const { event: e } = record;
    this.lastEventAt = e.ts;
    this.firstEventAt ??= e.ts;
    if (e.event === "run-resume") this.resumes++;
    if (e.event === "escalation") this.escalations++;
    const ref = identity(record);
    if (e.event === "run-start" || e.event === "run-resume") {
      if (e.event === "run-start" && !this.start) {
        const startEvent = { ...e, data: { graphDefinitionHash: e.data.graphDefinitionHash } };
        this.start = { ...ref, event: startEvent };
        this.startEvent = startEvent;
      }
      this.end = undefined;
      this.active = true;
      this.approved = false;
      this.tipFailed = false;
    }
    if (e.event === "graph-rehash") this.rehashes = [...this.rehashes, { ...e, data: { from: e.data.from, to: e.data.to } }];
    if (e.event === "tip-verify-failed" || (e.event === "tip-verify" && e.data.pass === false)) this.tipFailed = true;
    if (e.event === "run-end") {
      const tip = e.data.tipVerify;
      this.end = {
        evidence: ref,
        buckets: Object.fromEntries(bucketNames.map(k => [k, strings(e.data[k])])) as OperatorSnapshot["buckets"],
        tip: tip === "passed" ? "passed" : tip === "failed" ? "failed" : tip === "not required" || tip === "not-required" || tip === "skipped" ? "not required" : "unknown",
      };
      this.active = false;
      this.approved = false;
      for (const key of bucketNames) for (const id of this.end.buckets[key] ?? []) {
        const task = this.task(id);
        task.state = key;
        task.evidence = ref;
      }
    }
    if (e.event === "gate-result" && e.data.skipped !== true && e.data.disabled !== true && typeof e.data.pass === "boolean") {
      this.total++;
      if (e.data.pass) this.passed++;
    }
    if (!e.taskId) return;
    const t = this.task(e.taskId);
    t.evidence = ref;
    if (e.event === "task-dispatch") {
      t.state = "running"; t.dispatches++; t.parkKind = undefined; t.gates = emptyGates(); t.gateActivity = undefined;
      t.attempt = typeof e.data.attempt === "number" ? e.data.attempt : undefined;
      // These are recorded values only: no guessed directory or universal silence threshold.
      t.path = typeof e.data.worktree === "string" ? e.data.worktree : typeof e.data.cwd === "string" ? e.data.cwd : undefined;
      t.pane = typeof e.data.pane === "string" ? e.data.pane : undefined;
      t.alarmMs = typeof e.data.alarmMs === "number" ? e.data.alarmMs : undefined;
      const a = e.data.assignment as { adapter?: unknown; model?: unknown } | undefined;
      if (a && typeof a.adapter === "string" && typeof a.model === "string") t.channel = `${a.adapter}:${a.model}`;
    }
    if (e.event === "task-done") { t.state = "completed"; t.authors = doneAuthors(e.data); }
    if (e.event === "merge") { t.state = "merged"; t.merged = true; t.mergeEvidence = ref; t.parkKind = undefined; }
    if (e.event === "task-failed") t.state = "failed";
    if (e.event === "task-human") { t.state = "human"; t.parks++; t.parkKind = typeof e.data.kind === "string" ? e.data.kind : undefined; }
    if (e.event === "task-blocked") t.state = "blocked";
    if (e.event === "task-approved") {
      t.state = "pending"; t.parkKind = undefined; t.gateActivity = undefined; this.approved = !this.active;
      if (e.data.release === "recheck") t.gates = emptyGates();
    }
    if (e.event === "phase-start" && e.data.phase === "gates") t.gateActivity = undefined;
    if (e.event === "suite-wait" || e.event === "host-degraded") {
      // Only this row's attribution is authority. Legacy task-only waits must not borrow a red gate.
      const gate = typeof e.data.gate === "string" && (GATE_NAMES as readonly string[]).includes(e.data.gate) ? e.data.gate : undefined;
      t.gateActivity = { state: "queued", gate, reason: e.event, evidence: ref,
        ...(typeof e.data.count === "number" ? { count: e.data.count } : {}) };
      if (gate) t.gates[gate] = { state: "queued", evidence: ref };
    }
    if (e.event === "suite-admitted") t.gateActivity = undefined;
    if (["task-done", "merge", "task-failed", "task-human", "task-blocked"].includes(e.event)) t.gateActivity = undefined;
    const phaseGate = e.event === "phase-start" && typeof e.data.phase === "string"
      ? e.data.phase.startsWith("gate:") ? e.data.phase.slice(5) : e.data.phase === "judge" ? "acceptance" : e.data.phase === "review" ? "review" : undefined
      : undefined;
    const gate = e.data.gate ?? phaseGate;
    if ((e.event === "phase-start" && (phaseGate !== undefined || e.data.gate !== undefined)) || e.event === "gate-start" || e.event === "gate-phase-start") {
      t.gateActivity = { state: "running", evidence: ref };
    }
    if (typeof gate === "string" && (GATE_NAMES as readonly string[]).includes(gate)) {
      if (e.event === "gate-start" || e.event === "gate-phase-start" || e.event === "phase-start") {
        t.gates[gate] = { state: "running", evidence: ref };
        t.gateActivity = { state: "running", gate, evidence: ref };
      }
      if (e.event === "gate-result" && t.gateActivity?.gate === gate) t.gateActivity = undefined;
      if (e.event === "gate-result" && gate === "review") t.reviewRounds++;
      if (e.event === "gate-result") t.gates[gate] = {
        state: e.data.disabled === true ? "disabled" : e.data.skipped === true ? "not-run" : e.data.pass === true ? "passed" : e.data.pass === false ? "failed" : "unknown", evidence: ref,
      };
    }
  }
  private task(id: string): OperatorTask {
    let t = this.tasks.get(id);
    if (!t) { t = { id, state: "unknown", merged: false, dispatches: 0, reviewRounds: 0, parks: 0, gates: emptyGates() }; this.tasks.set(id, t); }
    return t;
  }
  snapshot({ graph, sequence = 0, observedAt = Date.now(), readable = true, graphAvailability }: {
    graph?: RunGraph; sequence?: number; observedAt?: number; readable?: boolean; graphAvailability?: OperatorSnapshot["graphAvailability"];
  } = {}): OperatorSnapshot {
    const hash = graph && graphDefinitionHash(graph);
    const comparable = this.comparableTo(hash);
    const ids = comparable ? [...graph!.tasks.map(t => t.id), ...[...this.tasks.keys()].filter(id => !graph!.tasks.some(t => t.id === id))] : [...this.tasks.keys()];
    const tasks = ids.map(id => {
      const t = this.tasks.get(id) ?? { id, state: "unknown" as const, merged: false, dispatches: 0, reviewRounds: 0, parks: 0, gates: emptyGates() };
      return { ...t, title: comparable ? graph!.tasks.find(g => g.id === id)?.title : undefined, gates: Object.fromEntries(Object.entries(t.gates).map(([g, cell]) => [g, { ...cell }])) };
    });
    const buckets = Object.fromEntries(bucketNames.map(k => [k, this.end?.buckets[k] === undefined ? undefined : [...this.end.buckets[k]!]])) as OperatorSnapshot["buckets"];
    // A matching graph contributes planned tasks even when the journal has never named them.
    // Their silence is unknown evidence, not completion. Comparison itself is also required for
    // green: without the recorded graph identity there is no trustworthy planned denominator.
    const merged = tasks.filter(t => t.merged && (!comparable || graph!.tasks.some(g => g.id === t.id))).length;
    const planned = comparable ? graph!.tasks.length : undefined;
    const unresolved = tasks.some(t => ["unknown", "failed", "human", "blocked", "pending", "running"].includes(t.state));
    const allPlannedMerged = comparable && merged === planned;
    const currentTip = this.active ? "pending" : this.tipFailed ? "failed" : this.end?.tip ?? "unknown";
    const green = readable && comparable && allPlannedMerged && !!this.start && !!this.end && !this.approved && !unresolved
      && (currentTip === "passed" || currentTip === "not required")
      && bucketNames.every(k => buckets[k]?.length === 0);
    const lifecycle: OperatorSnapshot["lifecycle"] = !readable || !this.start ? "UNKNOWN" : this.active ? "RUNNING" : this.approved ? "APPROVED" : green ? "COMPLETE" : this.end ? "PARTIAL" : "PENDING";
    return {
      sequence, observedAt, lastEventAt: this.lastEventAt, firstEventAt: this.firstEventAt, resumes: this.resumes, escalations: this.escalations, lifecycle,
      label: this.approved ? "approved; resume required" : lifecycle,
      green, currentTip, graphAvailability, comparable, comparison: comparable ? "matching graph" : "not comparable",
      merged,
      planned, tasks, buckets,
      gatesRan: { passed: this.passed, total: this.total }, latestRunEnd: this.end?.evidence,
      approvedResumeRequired: this.approved,
    };
  }
  private comparableTo(hash: string | undefined): boolean {
    if (!hash) return false;
    // The shared comparator audits the rehash chain; the fold keeps only the rows it reads.
    const events = [this.startEvent, ...this.rehashes].filter((e): e is JournalEvent => e !== undefined);
    return engagementComparable(events, hash).comparable;
  }
}

/** C1/C6 share this pure reader; callers supply the same observation and journal snapshot. */
export function readOperatorState({ events, source = "journal.jsonl", ...options }: {
  events: readonly (JournalEvent | OperatorRecord)[]; source?: string; graph?: RunGraph;
  sequence?: number; observedAt?: number; readable?: boolean;
}): OperatorSnapshot {
  const fold = new OperatorStateFold();
  events.forEach((event, i) => fold.apply(typeof event.event === "object" ? event as OperatorRecord : {
    source, line: i + 1, id: `${source}#L${i + 1}`, event: event as JournalEvent,
  }));
  return fold.snapshot(options);
}
