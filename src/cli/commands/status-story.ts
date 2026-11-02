import type { OperatorTaskSummary } from "../../run/operator-summary.js";
import type { TierLiveness } from "../../run/supervision.js";

// Pure story projections for the TTY status board: no file, clock or environment reads.
// Callers supply already-read state; these only decide what the board says about it.

export interface StoryNextInput {
  tasks: { id: string; merged: boolean; summary: OperatorTaskSummary }[];
  daemonAlive: boolean;
  runEnd?: { branch: string };
  allDone: boolean;
  tipPassed: boolean;
}

/** At most one next-action line, by closed precedence: a decision owed, a live daemon, an ended green run. */
export function storyNext(input: StoryNextInput): string | undefined {
  for (const { id, merged, summary } of input.tasks) {
    const blocker = summary.blocker;
    if (!merged && blocker?.decisionRequired && blocker.nextAction !== null) {
      return `next: ${id} needs you — ${blocker.nextAction}`;
    }
  }
  if (input.daemonAlive) return "next: follow it live — tickmarkr status --watch";
  if (input.runEnd && input.allDone && input.tipPassed) {
    return `next: review the work on ${input.runEnd.branch} and merge it yourself — tickmarkr never merges to main`;
  }
  return undefined;
}

/** Only recorded facts, in order; an absent fact is omitted, never rendered as a placeholder. */
export function boardSummaryText(summary: OperatorTaskSummary, merged: boolean): string {
  if (merged) return "";
  const { phase, lastEvidenceAt, responsible, blocker } = summary;
  const who = [responsible?.role, responsible?.agent].filter((part): part is string => !!part).join(" / ");
  return [
    phase !== null ? `phase ${phase}` : undefined,
    lastEvidenceAt !== null ? `last evidence ${lastEvidenceAt}` : undefined,
    who ? `responsible ${who}` : undefined,
    blocker ? `blocker ${blocker.kind}` : undefined,
    blocker && blocker.nextAction !== null ? `next action ${blocker.nextAction}` : undefined,
    blocker?.decisionRequired ? "needs your decision" : undefined,
  ].filter((part): part is string => part !== undefined).join(" · ");
}

/** Quiet exactly when every tier is absent or stood down and no clear obligation is recorded or unreadable. */
export function supervisionQuiet(tiers: readonly TierLiveness[]): boolean {
  return tiers.every(tier =>
    (tier.state === "ABSENT" || tier.state === "DISARMED")
    && tier.clearOwedSince === undefined
    && tier.clearOwedUnreadable !== true);
}
