import { graphDefinitionHash } from "../graph/graph.js";
import { GATE_NAMES, type RunGraph } from "../graph/schema.js";
import { engagementComparable, type JournalEvent } from "./journal.js";

/** An evidence identity is a physical journal line, never a filtered row ordinal. */
export interface EvidenceIdentity { source: string; line: number; id: string; generation?: number }
export interface OperatorRecord extends EvidenceIdentity { event: JournalEvent }
export type OperatorTaskState = "unknown" | "pending" | "running" | "completed" | "merged" | "failed" | "human" | "blocked";
export type OperatorGateState = "unknown" | "not-run" | "disabled" | "running" | "passed" | "failed";
export interface OperatorGate { state: OperatorGateState; evidence?: EvidenceIdentity }
export interface OperatorTask {
  id: string; title?: string; state: OperatorTaskState; merged: boolean;
  dispatches: number; attempt?: number; path?: string; pane?: string; alarmMs?: number;
  parkKind?: string; evidence?: EvidenceIdentity; mergeEvidence?: EvidenceIdentity;
  gates: Record<string, OperatorGate>;
}
export interface OperatorSnapshot {
  sequence: number; observedAt: number; lastEventAt?: string;
  lifecycle: "PENDING" | "RUNNING" | "PARTIAL" | "APPROVED" | "COMPLETE" | "UNKNOWN";
  label: string; green: boolean; currentTip: "passed" | "not required" | "pending" | "failed" | "unknown";
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
  private passed = 0;
  private total = 0;

  apply(record: OperatorRecord): void {
    const { event: e } = record;
    this.lastEventAt = e.ts;
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
      t.state = "running"; t.dispatches++; t.parkKind = undefined; t.gates = emptyGates();
      t.attempt = typeof e.data.attempt === "number" ? e.data.attempt : undefined;
      // These are recorded values only: no guessed directory or universal silence threshold.
      t.path = typeof e.data.worktree === "string" ? e.data.worktree : typeof e.data.cwd === "string" ? e.data.cwd : undefined;
      t.pane = typeof e.data.pane === "string" ? e.data.pane : undefined;
      t.alarmMs = typeof e.data.alarmMs === "number" ? e.data.alarmMs : undefined;
    }
    if (e.event === "task-done") t.state = "completed";
    if (e.event === "merge") { t.state = "merged"; t.merged = true; t.mergeEvidence = ref; t.parkKind = undefined; }
    if (e.event === "task-failed") t.state = "failed";
    if (e.event === "task-human") { t.state = "human"; t.parkKind = typeof e.data.kind === "string" ? e.data.kind : undefined; }
    if (e.event === "task-blocked") t.state = "blocked";
    if (e.event === "task-approved") { t.state = "pending"; t.parkKind = undefined; this.approved = !this.active; }
    const gate = e.data.gate;
    if (typeof gate === "string" && (GATE_NAMES as readonly string[]).includes(gate)) {
      if (e.event === "gate-start") t.gates[gate] = { state: "running", evidence: ref };
      if (e.event === "gate-result") t.gates[gate] = {
        state: e.data.disabled === true ? "disabled" : e.data.skipped === true ? "not-run" : e.data.pass === true ? "passed" : e.data.pass === false ? "failed" : "unknown", evidence: ref,
      };
    }
  }
  private task(id: string): OperatorTask {
    let t = this.tasks.get(id);
    if (!t) { t = { id, state: "unknown", merged: false, dispatches: 0, gates: emptyGates() }; this.tasks.set(id, t); }
    return t;
  }
  snapshot({ graph, sequence = 0, observedAt = Date.now(), readable = true }: {
    graph?: RunGraph; sequence?: number; observedAt?: number; readable?: boolean;
  } = {}): OperatorSnapshot {
    const hash = graph && graphDefinitionHash(graph);
    const comparable = this.comparableTo(hash);
    const ids = comparable ? [...graph!.tasks.map(t => t.id), ...[...this.tasks.keys()].filter(id => !graph!.tasks.some(t => t.id === id))] : [...this.tasks.keys()];
    const tasks = ids.map(id => {
      const t = this.tasks.get(id) ?? { id, state: "unknown" as const, merged: false, dispatches: 0, gates: emptyGates() };
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
      sequence, observedAt, lastEventAt: this.lastEventAt, lifecycle,
      label: this.approved ? "approved; resume required" : lifecycle,
      green, currentTip, comparable, comparison: comparable ? "matching graph" : "not comparable",
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
