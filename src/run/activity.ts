import { formatJournalNarration, type JournalEvent } from "./journal.js";

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
