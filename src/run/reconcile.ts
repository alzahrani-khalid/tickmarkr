import { formatOwnedName, isForeignName, panesToClose, parseOwnedName } from "../drivers/types.js";
import type { JournalEvent } from "./journal.js";

export { isForeignName, panesToClose, parseOwnedName };

// T1: pure fold over journal rows — the exact set of tickmarkr-owned pane/tab names that SHOULD exist
// right now for a live run. No I/O: the caller supplies rows (Journal.read()) and a live pane listing
// separately. Anything owned (parseOwnedName succeeds) but not in this set is garbage to close;
// anything foreign (parseOwnedName fails) is never a candidate, no matter what state it's in.
export function desiredPanes(rows: JournalEvent[], runId: string): Set<string> {
  const desired = new Set<string>();
  const worker = new Map<string, string>();
  const judge = new Map<string, string>();
  const review = new Map<string, string>();

  const clearTask = (taskId: string) => {
    for (const m of [worker, judge, review]) {
      const name = m.get(taskId);
      if (name) desired.delete(name);
      m.delete(taskId);
    }
  };

  for (const row of rows) {
    switch (row.event) {
      case "run-start":
      case "run-resume": {
        // OBS-17 fix (2): a killed daemon can't close its slots — nothing tracked before this
        // point is still live once the daemon (re)starts; resume re-dispatches at a fresh attempt.
        for (const taskId of new Set([...worker.keys(), ...judge.keys(), ...review.keys()])) clearTask(taskId);
        desired.add(formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId }));
        break;
      }
      case "task-dispatch": {
        const taskId = row.taskId!;
        const attempt = Number(row.data.attempt ?? 0);
        // OBS-17 fix (1): a new dispatch (retry, escalation, OR quota-failover) supersedes the
        // old attempt's pane — the failover path re-dispatches through this same event.
        const prev = worker.get(taskId);
        if (prev) desired.delete(prev);
        const name = formatOwnedName({ role: "worker", taskId, attempt, runId });
        worker.set(taskId, name);
        desired.add(name);
        break;
      }
      case "worker-result": {
        const taskId = row.taskId!;
        const name = formatOwnedName({ role: "judge", taskId, attempt: 0, runId });
        judge.set(taskId, name);
        desired.add(name);
        break;
      }
      case "judge-retry": {
        const taskId = row.taskId!;
        const prev = judge.get(taskId);
        if (prev) desired.delete(prev);
        const name = formatOwnedName({ role: "judge", taskId, attempt: 1, runId });
        judge.set(taskId, name);
        desired.add(name);
        break;
      }
      case "gate-result": {
        const taskId = row.taskId!;
        if (row.data.gate === "acceptance") {
          const j = judge.get(taskId);
          if (j) { desired.delete(j); judge.delete(taskId); }
          if (row.data.pass) {
            const name = formatOwnedName({ role: "review", taskId, attempt: 0, runId });
            review.set(taskId, name);
            desired.add(name);
          }
        } else if (row.data.gate === "review") {
          const r = review.get(taskId);
          if (r) { desired.delete(r); review.delete(taskId); }
        }
        break;
      }
      case "task-done":
      case "task-failed":
      case "task-human":
        clearTask(row.taskId!);
        break;
      case "run-end":
        desired.clear();
        desired.add(formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId }));
        break;
    }
  }
  return desired;
}
