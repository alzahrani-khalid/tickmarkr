import { describe, expect, test } from "vitest";
import { boardSummaryText, storyNext, supervisionQuiet, type StoryNextInput } from "../../src/cli/commands/status-story.js";
import type { OperatorBlocker, OperatorTaskSummary } from "../../src/run/operator-summary.js";
import type { TierLiveness } from "../../src/run/supervision.js";

const blank = (taskId: string): OperatorTaskSummary => ({
  taskId, phase: null, lastEvidenceAt: null, responsible: null, blocker: null,
});
const blocker = (over: Partial<OperatorBlocker> = {}): OperatorBlocker => ({
  kind: "human-decision", permittedActions: [], humanInterventionRequired: true,
  decisionRequired: false, nextAction: null, ...over,
});
const task = (id: string, over: Partial<OperatorTaskSummary> = {}, merged = false) =>
  ({ id, merged, summary: { ...blank(id), ...over } });
const base = (over: Partial<StoryNextInput> = {}): StoryNextInput =>
  ({ tasks: [], daemonAlive: false, allDone: false, tipPassed: false, ...over });

const WATCH = "next: follow it live — tickmarkr status --watch";
const MERGE = "next: review the work on tickmarkr/run-1 and merge it yourself — tickmarkr never merges to main";

describe("storyNext", () => {
  test("the next-action rule returns the first unmerged task whose blocker requires a decision and records a next action, ahead of a live daemon; then the watch line for a live daemon; then the review-and-merge line naming the branch only for an ended run whose tasks are all done and whose tip passed; and nothing otherwise, including a parked task without a decision or next action, so a rule that offers merging over an eligible park or a failed tip fails", () => {
    const eligible = blocker({ decisionRequired: true, nextAction: "Choose a decision: approve: tkr approve T2" });
    const ended = { runEnd: { branch: "tickmarkr/run-1" }, allDone: true, tipPassed: true };

    // decision first, in task order, ahead of a live daemon and an ended green run
    expect(storyNext(base({
      daemonAlive: true, ...ended,
      tasks: [
        task("T1", { blocker: eligible }, true), // merged: skipped
        task("T2", { blocker: eligible }),
        task("T3", { blocker: blocker({ decisionRequired: true, nextAction: "other" }) }),
      ],
    }))).toBe("next: T2 needs you — Choose a decision: approve: tkr approve T2");
    // an eligible park beats the merge line even with no daemon
    expect(storyNext(base({ ...ended, tasks: [task("T2", { blocker: eligible })] })))
      .toBe("next: T2 needs you — Choose a decision: approve: tkr approve T2");

    // parks without a decision or without a next action do not qualify
    const ineligible = [
      task("T4", { blocker: blocker({ decisionRequired: false, nextAction: "look" }) }),
      task("T5", { blocker: blocker({ decisionRequired: true, nextAction: null }) }),
      task("T6"),
    ];
    expect(storyNext(base({ daemonAlive: true, tasks: ineligible }))).toBe(WATCH);
    expect(storyNext(base({ daemonAlive: true, ...ended }))).toBe(WATCH);

    // merge line only for ended + all done + tip passed
    expect(storyNext(base({ ...ended, tasks: ineligible }))).toBe(MERGE);
    expect(storyNext(base({ ...ended, tipPassed: false }))).toBeUndefined();
    expect(storyNext(base({ ...ended, allDone: false }))).toBeUndefined();
    expect(storyNext(base({ allDone: true, tipPassed: true }))).toBeUndefined();
    expect(storyNext(base({ tasks: ineligible }))).toBeUndefined();
    expect(storyNext(base())).toBeUndefined();
  });
});

describe("boardSummaryText", () => {
  test("merged tasks and all-null summaries give an empty evidence text; other summaries emit the specified facts in order and never generate a placeholder for an absent fact (phase unrecorded, last evidence unrecorded, responsible unrecorded, blocker none, next action unrecorded or human-decision no), while recorded values that contain those words stay; responsibility joins role and agent with a slash and no dangling separator", () => {
    const full: OperatorTaskSummary = {
      taskId: "T1", phase: "gates", lastEvidenceAt: "2026-11-02T10:00:00.000Z",
      responsible: { role: "worker", agent: "claude-code" },
      blocker: blocker({ decisionRequired: true, nextAction: "Choose a decision: retry: tkr approve T1" }),
    };
    expect(boardSummaryText(full, true)).toBe("");
    expect(boardSummaryText(blank("T1"), false)).toBe("");
    expect(boardSummaryText(blank("T1"), true)).toBe("");
    expect(boardSummaryText(full, false)).toBe(
      "phase gates · last evidence 2026-11-02T10:00:00.000Z · responsible worker / claude-code"
      + " · blocker human-decision · next action Choose a decision: retry: tkr approve T1 · needs your decision",
    );

    const placeholders = /unrecorded|blocker none|human-decision no|human-decision yes/u;
    const partials: OperatorTaskSummary[] = [
      { ...blank("T1"), phase: "gates" },
      { ...blank("T1"), lastEvidenceAt: "2026-11-02T10:00:00.000Z" },
      { ...blank("T1"), responsible: { role: "worker" } },
      { ...blank("T1"), responsible: { agent: "codex" } },
      { ...blank("T1"), responsible: { role: "", agent: "" } },
      { ...blank("T1"), blocker: blocker({ kind: "retry", humanInterventionRequired: false }) },
    ];
    for (const summary of partials) expect(boardSummaryText(summary, false)).not.toMatch(placeholders);
    expect(partials.map(s => boardSummaryText(s, false))).toEqual([
      "phase gates",
      "last evidence 2026-11-02T10:00:00.000Z",
      "responsible worker",
      "responsible codex",
      "",
      "blocker retry",
    ]);

    // recorded values containing the placeholder words survive verbatim
    expect(boardSummaryText({
      ...blank("T1"), phase: "unrecorded",
      responsible: { role: "unrecorded", agent: "none" },
      blocker: blocker({ nextAction: "human-decision no" }),
    }, false)).toBe("phase unrecorded · responsible unrecorded / none · blocker human-decision · next action human-decision no");
  });
});

describe("supervisionQuiet", () => {
  test("supervision is quiet only for absent or disarmed tiers without a clear obligation; an armed, stale or unreadable tier, or a recorded or unreadable clear obligation even on an absent or disarmed tier, makes it not quiet", () => {
    const absent: TierLiveness = { tier: "orchestrator", state: "ABSENT" };
    const disarmed: TierLiveness = { tier: "overseer", state: "DISARMED", seat: "w1:p1" };
    expect(supervisionQuiet([])).toBe(true);
    expect(supervisionQuiet([absent, disarmed])).toBe(true);

    for (const state of ["ARMED", "STALE", "UNREADABLE"] as const) {
      expect(supervisionQuiet([absent, { tier: "watch", state, beatAgeMs: 1 }])).toBe(false);
    }
    for (const tier of [absent, disarmed]) {
      expect(supervisionQuiet([{ ...tier, clearOwedSince: "2026-11-02T10:00:00.000Z" }])).toBe(false);
      expect(supervisionQuiet([{ ...tier, clearOwedUnreadable: true }])).toBe(false);
    }
  });
});
