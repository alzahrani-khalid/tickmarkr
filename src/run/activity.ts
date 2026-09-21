import { formatJournalNarration, type JournalEvent } from "./journal.js";
import { readCommandReceipt, type CommandReceipt, type TrackedJournalRow } from "./protocol.js";

// OBS-104: pure journal→activity fold — names what every task is doing RIGHT NOW. No filesystem,
// process, clock, or environment access: callers supply the events (Journal.read()) and task
// metadata; the status surface renders the cells today and the v1.68 cockpit Runs view consumes
// the same fold unchanged. Inputs are never mutated.

export interface ActivityTask {
  id: string;
  gates: readonly string[];
  deps: readonly string[];
  /** the surface's effective status for the task (replayed ?? graph) */
  status: string;
}

export interface ActivitySnapshot {
  /** run-level now line naming the most recent journal event; absent when there are no events */
  now?: string;
  /** taskId → current-activity phrase; absent = idle (terminal, or queued with met deps) */
  cells: Map<string, string>;
}

type Live =
  | { kind: "worker"; attempt: number; channel: string; since: string }
  | { kind: "gates"; results: Map<string, boolean> }
  | { kind: "retrying" }
  | { kind: "parked"; note?: string };

const channelOf = (assignment: unknown): string => {
  const a = assignment as { adapter?: unknown; model?: unknown } | undefined;
  return typeof a?.adapter === "string" && typeof a.model === "string" ? `${a.adapter}:${a.model}` : "unknown channel";
};

const cellText = (st: Live, task: ActivityTask): string => {
  switch (st.kind) {
    case "worker":
      // since is the dispatch event's own ISO ts — sliced, never re-clocked (purity)
      return `attempt ${st.attempt} in flight on ${st.channel} since ${st.since.slice(11, 19)}`;
    case "gates": {
      const next = task.gates.find((g) => !st.results.has(g));
      if (next) return `gate ${next} running`;
      // every declared gate has a result: all pass ⇒ the daemon is merging; any fail ⇒ a retry decision is next
      return [...st.results.values()].every(Boolean) ? "merging" : "retrying";
    }
    case "retrying":
      return "retrying";
    case "parked":
      return st.note ? `parked (${st.note})` : "parked";
  }
};

export function foldActivity(events: JournalEvent[], tasks: readonly ActivityTask[]): ActivitySnapshot {
  const live = new Map<string, Live>();
  // a daemon (re)start or run-end means no attempt/gate is in flight — mirror reconcile.ts; parks persist
  const clearTransient = () => {
    // deleting the current entry mid-iteration is well-defined for Map
    for (const [id, st] of live) if (st.kind !== "parked") live.delete(id);
  };
  for (const e of events) {
    if (e.event === "run-start" || e.event === "run-resume" || e.event === "run-end") {
      clearTransient();
      continue;
    }
    const id = e.taskId;
    if (!id) continue;
    switch (e.event) {
      case "task-dispatch":
        live.set(id, {
          kind: "worker",
          attempt: (Number.isInteger(e.data.attempt) ? (e.data.attempt as number) : 0) + 1,
          channel: channelOf(e.data.assignment),
          since: e.ts,
        });
        break;
      case "worker-result":
        // a clean trailer moves the task into gating; anything else is heading for a retry decision
        live.set(id, e.data.ok === true && e.data.finished === true ? { kind: "gates", results: new Map() } : { kind: "retrying" });
        break;
      case "gate-result": {
        const prev = live.get(id);
        const results = prev?.kind === "gates" ? prev.results : new Map<string, boolean>();
        if (typeof e.data.gate === "string") results.set(e.data.gate, e.data.pass === true || e.data.skipped === true);
        live.set(id, { kind: "gates", results });
        break;
      }
      case "escalation":
      case "consult-verdict":
      case "quota-failover":
      case "provider-death-requeue":
      case "merge-conflict":
        live.set(id, { kind: "retrying" });
        break;
      case "task-human":
        live.set(id, { kind: "parked", ...(typeof e.data.kind === "string" ? { note: e.data.kind } : {}) });
        break;
      case "task-done":
      case "task-failed":
      case "task-approved":
        live.delete(id);
        break;
    }
  }
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  const cells = new Map<string, string>();
  for (const t of tasks) {
    const st = live.get(t.id);
    if (st) {
      cells.set(t.id, cellText(st, t));
      continue;
    }
    if (t.status !== "pending") continue;
    // dep-waiting is reserved for genuinely unmet deps — a bare pending task gets no cell (OBS-104 fix 1)
    const unmet = t.deps.filter((d) => status.get(d) !== "done");
    if (unmet.length) cells.set(t.id, `dep-waiting on ${unmet.join(", ")}`);
  }
  const last = events.at(-1);
  return { ...(last ? { now: formatJournalNarration(last) } : {}), cells };
}

/** Recorded evidence, not a probe of whether a subprocess is still alive. */
export type BuildActivity =
  | { state: "start-unrecorded" | "awaiting-command" }
  | { state: CommandReceipt["outcome"] | "unresolved"; receipt: CommandReceipt };

export interface TaskActivityProjection {
  taskId: string;
  /** Journal attempt label (zero based), absent until an attempt is recorded. */
  attempt?: number;
  state: "unconfirmed" | "preparing" | "implementing" | "returned-for-verification"
    | "validating" | "reviewing" | "merging" | "terminal";
  /** Concurrent gates retain separate entries; state alone is only a summary. */
  phases: { gate: string; state: "validating" | "reviewing" }[];
  build: BuildActivity;
}

const activityRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const activityOrdinal = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * Pure, evidence-only successor to foldActivity. Feed Journal.readTracked() and the owning run ID;
 * sourceIndex supplies journal order, never wall time. Unattributed legacy rows belong to their
 * tracked run and current attempt/round. They cannot prove identities absent from the journal.
 * A new gates phase opens a round; completed gates cannot reopen within that round. No declared
 * gate order, graph status, or successful verdict predicts a later phase.
 */
export function projectActivity(
  runId: string,
  rows: readonly TrackedJournalRow[],
  tasks: readonly ActivityTask[],
): Map<string, TaskActivityProjection> {
  const states = new Map(tasks.map((task) => [task.id, {
    projection: { taskId: task.id, state: "unconfirmed", phases: [], build: { state: "start-unrecorded" } } as TaskActivityProjection,
    round: 0,
    closed: new Set<string>(),
    invocations: new Set<string>(),
    workerReturned: false,
    suspended: false,
    redispatch: false,
    dispatchedSinceRound: false,
    adoptRoundAttempt: false,
  }]));
  for (const row of [...rows].sort((a, b) => a.sourceIndex - b.sourceIndex)) {
    if (row.runId !== runId || row.kind === "protocol-issue") continue;
    // Compatibility readers normalize missing legacy attempts to zero. Retain the physical
    // payload here so that absence still means the currently recorded attempt.
    const raw = row.raw;
    if (!activityRecord(raw) || typeof raw.event !== "string" || !activityRecord(raw.data)) continue;
    const data = raw.data;
    if (typeof data.runId === "string" && data.runId !== runId) continue;
    if (raw.event === "run-resume" || raw.event === "run-end") {
      for (const st of states.values()) {
        const p = st.projection;
        if (p.build.state === "started" && "receipt" in p.build) {
          p.build = { state: "unresolved", receipt: p.build.receipt };
        }
        for (const phase of p.phases) st.closed.add(phase.gate);
        p.phases = [];
        if (p.state !== "terminal") p.state = "unconfirmed";
        st.suspended = true;
        st.redispatch = raw.event === "run-resume";
        st.dispatchedSinceRound = false;
        st.adoptRoundAttempt = false;
      }
      continue;
    }
    if (typeof raw.taskId !== "string") continue;
    const st = states.get(raw.taskId);
    if (!st) continue;
    const p = st.projection;
    const attempt = activityOrdinal(data.attempt);
    if (attempt !== undefined && p.attempt !== undefined && attempt < p.attempt) continue;
    if (raw.event === "task-dispatch") {
      const nextAttempt = attempt ?? 0;
      if (p.attempt === nextAttempt && !st.redispatch) continue;
      p.attempt = nextAttempt;
      p.state = "preparing";
      p.phases = [];
      p.build = { state: "start-unrecorded" };
      st.closed.clear();
      st.workerReturned = false;
      st.suspended = false;
      st.redispatch = false;
      st.dispatchedSinceRound = true;
      st.adoptRoundAttempt = false;
      continue;
    }
    const round = activityOrdinal(data.gateRound);
    if (round !== undefined && round !== st.round) continue;
    const roundGate = (raw.event === "gate-result" || raw.event === "gate-phase-start"
      || raw.event === "phase-start") && typeof data.gate === "string"
      && !st.suspended && !st.closed.has(data.gate);
    if (attempt !== undefined && p.attempt !== undefined && attempt !== p.attempt
        && !(st.adoptRoundAttempt && roundGate)) continue;
    if (st.adoptRoundAttempt && roundGate && attempt !== undefined) {
      p.attempt = attempt;
      st.adoptRoundAttempt = false;
    }
    if (p.attempt === undefined && attempt !== undefined) p.attempt = attempt;
    if (["task-done", "task-failed", "task-human", "task-approved", "merge"].includes(raw.event)) {
      p.state = "terminal";
      p.phases = [];
      st.suspended = true;
      continue;
    }
    // Only an explicit new battery may re-enter verification after a resume or completed task.
    if (raw.event === "phase-start" && data.phase === "gates") {
      st.round++;
      // Resume verification has no dispatch and labels the round with the dispatch count,
      // rather than the last worker's attempt. Its first attributed gate/receipt owns the label.
      st.adoptRoundAttempt = !st.dispatchedSinceRound;
      st.dispatchedSinceRound = false;
      st.closed.clear();
      p.phases = [];
      p.build = { state: "start-unrecorded" };
      if (p.state === "terminal") p.state = "unconfirmed";
      st.suspended = false;
      continue;
    }
    if (raw.event === "build-receipt" || raw.event === "build-result") {
      // The emitter adds gate/reason metadata beside the strict command receipt.
      const { gate: _gate, reason: _reason, freshBuildRan: _fresh, ...payload } = data;
      const parsed = readCommandReceipt(payload);
      if (parsed.kind !== "receipt") continue;
      const receipt = parsed.receipt;
      if (receipt.outcome === "started" && !receipt.confirmedStart) continue;
      const identity = receipt.attribution;
      if (identity.runId !== runId || identity.taskId !== p.taskId
          || identity.gateRound !== st.round) continue;
      if (identity.attempt < (p.attempt ?? 0)
          || (!st.adoptRoundAttempt && identity.attempt !== (p.attempt ?? 0))) continue;
      const previous = "receipt" in p.build ? p.build.receipt : undefined;
      const same = previous?.attribution.invocation === identity.invocation;
      if (same) {
        if (p.build.state !== "started" && p.build.state !== "unresolved") continue;
        if (receipt.outcome === "started") continue;
      } else {
        if (st.suspended || st.closed.has("build") || st.invocations.has(identity.invocation)) continue;
        // A late terminal cannot displace a newer invocation. No-start outcomes are themselves
        // complete receipts and need no preceding start; a first terminal remains useful evidence.
        if (previous && receipt.confirmedStart && receipt.outcome !== "started") continue;
      }
      st.invocations.add(identity.invocation);
      if (st.adoptRoundAttempt) {
        p.attempt = identity.attempt;
        st.adoptRoundAttempt = false;
      }
      p.build = { state: receipt.outcome, receipt };
      continue;
    }
    if (st.suspended) continue;
    if (raw.event === "worker-launch" && !st.workerReturned && p.phases.length === 0
        && (p.state === "preparing" || p.state === "unconfirmed")) p.state = "implementing";
    if (raw.event === "worker-result" && !st.workerReturned && p.phases.length === 0) {
      st.workerReturned = true;
      p.state = "returned-for-verification";
    }
    if (raw.event === "phase-start" && data.phase === "merge") {
      for (const phase of p.phases) st.closed.add(phase.gate);
      p.phases = [];
      p.state = "merging";
      st.workerReturned = true;
      continue;
    }
    if (raw.event === "gate-result" && typeof data.gate === "string") {
      st.workerReturned = true;
      // Infrastructure skips have no verdict; a retry may start again in this round.
      if (typeof data.pass === "boolean" || (data.skipped !== true && data.infra !== true)) st.closed.add(data.gate);
      if (data.gate === "build" && p.build.state === "awaiting-command") p.build = { state: "start-unrecorded" };
      p.phases = p.phases.filter((phase) => phase.gate !== data.gate);
      if (p.state !== "merging") p.state = p.phases[0]?.state ?? "unconfirmed";
    }
    if ((raw.event === "phase-start" || raw.event === "gate-phase-start")
        && typeof data.gate === "string" && !st.closed.has(data.gate) && p.state !== "merging") {
      const gate = data.gate;
      if (!p.phases.some((phase) => phase.gate === gate)) {
        p.phases.push({ gate, state: gate === "review" ? "reviewing" : "validating" });
      }
      st.workerReturned = true;
      p.state = p.phases[0]!.state;
      if (gate === "build" && p.build.state === "start-unrecorded") p.build = { state: "awaiting-command" };
    }
  }
  return new Map([...states].map(([id, st]) => [id, st.projection]));
}
