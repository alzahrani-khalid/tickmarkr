/**
 * OBS-57's per-run no-trailer streak, with queue row 396 (D-2187 add.25): a HARVESTED no-trailer
 * window is decided by its gate round, never at the harvest. Only a round that ends all green
 * (every enabled gate passed and the work merged) leaves the streak as it was: no increment, no
 * reset, never certified. A red round counts. An undetermined round counts, fail closed: one that
 * parks (seatless, infra), one that conflicts, one that never ends (cancelled, killed) and one the
 * run outlives (flushed at run-end). A window with no commits counts at once, as before, and the
 * exempt windows (provider death, a refused pin quota, transient capacity) never reach here.
 *
 * The streak is consecutive in WINDOW order, so a deferred window is decided in the segment of its
 * channel it opened in: a certification that came after it was opened ended that segment, and a late
 * count lands in the cleared segment instead of resurrecting it in the live one.
 */

/** A worker window as the daemon's routing branches classify it, read from the pre-harvest parse. */
export interface NoTrailerWindow {
  /** a parsed ok trailer: the channel is certified and its streak resets */
  certifies: boolean;
  /** a no-trailer window that is not exempt */
  counts: boolean;
  /** the worktree carries commits, so the harvest synthesis sends this window to a gate round */
  harvested: boolean;
}

/** How a task's gate round settled; "regate" means the same round goes on. */
export type RoundEnd = "merged" | "red" | "parked" | "conflict" | "regate";

export class NoTrailerStreak {
  /** channel -> counted windows per certification segment, in window order; the last is the live streak */
  // ponytail: one number per certification per channel for the run's life; prune settled segments if runs grow huge.
  private readonly segments = new Map<string, number[]>();
  /** task id -> its harvested window still waiting on a gate round, and the segment it opened in */
  private readonly deferred = new Map<string, { channel: string; segment: number }>();

  /** `onCount` receives every counted window with the new count of the segment it falls in. */
  constructor(private readonly onCount: (taskId: string, channel: string, streak: number) => void) {}

  window(taskId: string, channel: string, w: NoTrailerWindow): void {
    // A task's earlier harvested window still deferred here never reached an all-green round
    // (merging ends the task): it was routed away before gates, so it counts first.
    this.countDeferred(taskId);
    const segments = this.segmentsOf(channel);
    if (w.certifies) segments.push(0);
    else if (w.counts && w.harvested) this.deferred.set(taskId, { channel, segment: segments.length - 1 }); // row 396: the round decides
    else if (w.counts) this.count(taskId, channel, segments.length - 1);
  }

  /** The task's gate round settled. Only an all-green merged round drops the deferred window. */
  roundEnded(taskId: string, end: RoundEnd): void {
    if (end === "regate") return;
    if (end === "merged") this.deferred.delete(taskId);
    else this.countDeferred(taskId);
  }

  /** Run-end: every window still deferred counts, fail closed. */
  flush(): void {
    for (const taskId of this.deferred.keys()) this.countDeferred(taskId); // deleting the visited key mid-iteration is safe
  }

  private segmentsOf(channel: string): number[] {
    const known = this.segments.get(channel);
    if (known) return known;
    const fresh = [0];
    this.segments.set(channel, fresh);
    return fresh;
  }

  private countDeferred(taskId: string): void {
    const window = this.deferred.get(taskId);
    if (window === undefined) return;
    this.deferred.delete(taskId);
    this.count(taskId, window.channel, window.segment);
  }

  private count(taskId: string, channel: string, segment: number): void {
    const segments = this.segmentsOf(channel);
    const streak = segments[segment]! + 1;
    segments[segment] = streak;
    this.onCount(taskId, channel, streak);
  }
}
