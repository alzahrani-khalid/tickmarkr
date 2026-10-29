import type { StatusSnapshot } from "../cli/commands/status-snapshot.js";
import { approvalDispositionForRelease, approvalEnactment, approvalRunOwner, releaseForDecision } from "../cli/commands/approve.js";
import { parseBindingToken, physicalLine, visibleControls, type JournalEvent } from "../run/journal.js";

/** Turn-local presentation only. The snapshot admits commands; approve owns their enactment text. */
export function createParkPresentation(cwd: string, runId: string, message: (text: string) => void) {
  const alerted = new Set<string>();
  const opened = new Set<string>();
  let firstSequence: number | undefined;
  let windowAfter: number | undefined;
  const opening = (closesAt: string) => {
    if (opened.has(closesAt)) return;
    opened.add(closesAt);
    message(`Approval window closes at ${closesAt}: nothing is in flight, a task is parked, and every pending task waits transitively behind a park; a failed task does not prevent it. Approvals are swept again after expiry and before final close; the daemon owns the run until it exits.`);
  };

  return {
    render(state: StatusSnapshot): Map<string, string> {
      // Sample ownership on every render, even when the journal has not changed.
      const owner = approvalRunOwner(cwd, runId);
      const blocks = new Map<string, string>();
      for (const park of state.parks) {
        // Diagnostic prose may include CLI hints; only snapshot commands get their own lines.
        const block = [
          visibleControls(`[needs you] ${park.kind ?? "unknown"} — ${park.reason ?? "unknown"}`),
          // The enactment names the lock's run id, which is any string: fold it so only snapshot commands start a line.
          ...park.commands.flatMap(({ verb, command }) => [command,
            visibleControls(approvalEnactment(approvalDispositionForRelease(releaseForDecision(verb, {
              kind: park.kind ?? undefined, failedGate: undefined,
            })), owner))]),
          ...(park.noDecision ? [visibleControls(park.noDecision)] : []),
          ...(state.approvalWindow ? [`Approval window closes at ${state.approvalWindow.closesAt}.`] : []),
        ].join("\n");
        blocks.set(park.taskId, block);
        const key = JSON.stringify(park.token && parseBindingToken(park.token)
          ? [park.taskId, park.token] : [park.taskId, park.kind, park.reason]);
        if (!alerted.has(key)) { message(`${park.taskId}\n${block}`); alerted.add(key); }
      }
      firstSequence ??= state.sequence;
      windowAfter ??= firstSequence;
      if (state.approvalWindow) opening(state.approvalWindow.closesAt);
      return blocks;
    },

    /** Observe rows, never the clock: expiry is a lapse, not a terminal wake. */
    windows(events: readonly JournalEvent[], completeLines: number): void {
      if (windowAfter === undefined) return;
      for (const [index, row] of events.entries()) {
        const line = physicalLine(events, index);
        if (line > completeLines) continue;
        // Only the first snapshot's last row may be an incomplete opening. A lowered
        // complete-line cursor must not revisit an earlier, already-closed window.
        if (line <= windowAfter && !(line === firstSequence && row.event === "approval-window-start")) continue;
        if (row.event === "approval-window-start") {
          const ms = row.data.windowMs;
          const opens = Date.parse(row.ts);
          if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0 && Number.isFinite(opens)
            && Array.isArray(row.data.parked) && row.data.parked.every(id => typeof id === "string")) {
            opening(new Date(opens + ms).toISOString());
          }
        } else if (row.event === "approval-window-expired") {
          message("Approval window lapsed. Expiry does not end the run: approvals are swept again, and a decision landing before final close can still be enacted; the daemon owns the run until it exits.");
        }
      }
      windowAfter = completeLines;
    },
  };
}
