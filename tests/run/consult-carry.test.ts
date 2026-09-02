import { describe, expect, test } from "vitest";
import { renderRetryGuidance } from "../../src/run/consult.js";
import { outstandingConsultGuidance, type JournalEvent } from "../../src/run/journal.js";

const ev = (event: string, taskId: string, data: Record<string, unknown> = {}): JournalEvent => ({
  ts: "2026-09-01T00:00:00.000Z",
  event,
  taskId,
  data,
});

const rendered = (events: JournalEvent[], taskId = "T1"): string => {
  const carry = outstandingConsultGuidance(events, taskId);
  return carry ? renderRetryGuidance({ ...carry, notes: "" }) : "";
};

describe("consult guidance carry", () => {
  test("test: the carry uses the newest consult verdict for the task and a task whose consult verdict precedes its own merge carries nothing while a carry resurrecting guidance from a concluded engagement or from another task fails", () => {
    const older = ev("consult-verdict", "T1", {
      action: "human",
      reason: "old reason",
      guidance: "old guidance",
      notes: "old raw notes",
    });
    const sibling = ev("consult-verdict", "T2", {
      action: "human",
      reason: "other task reason",
      guidance: "other task guidance",
    });
    const newest = ev("consult-verdict", "T1", {
      action: "decompose",
      reason: "amended spec still misses the file scope",
      guidance: "Add the generated file to the task files list.",
      notes: "raw consult prose must stay out of the carry",
    });

    expect(outstandingConsultGuidance([older, sibling, newest], "T1")).toEqual({
      action: "decompose",
      reason: "amended spec still misses the file scope",
      guidance: "Add the generated file to the task files list.",
    });
    expect(rendered([sibling], "T1")).toBe("");
    expect(rendered([older, ev("task-done", "T1"), ev("task-dispatch", "T1")])).toBe("");
    expect(rendered([older, ev("merge", "T1"), ev("task-dispatch", "T1")])).toBe("");
  });

  test("test: the carry sources only the verdict's structured guidance and reason fields so a protocol-normal row whose notes were aliased from guidance still carries exactly once while a carry that reads the notes field as its source fails", () => {
    const aliased = ev("consult-verdict", "T1", {
      action: "human",
      reason: "scope declaration is still stale",
      guidance: "Add src/run/consult-carry.ts to the task files list.",
      notes: "Add src/run/consult-carry.ts to the task files list.",
    });
    const carry = outstandingConsultGuidance([aliased], "T1");
    expect(carry).toEqual({
      action: "human",
      reason: "scope declaration is still stale",
      guidance: "Add src/run/consult-carry.ts to the task files list.",
    });
    expect(JSON.stringify(carry)).not.toContain("notes");
    expect(rendered([aliased]).match(/Add src\/run\/consult-carry\.ts/g)).toHaveLength(1);

    const notesOnly = ev("consult-verdict", "T1", {
      action: "human",
      notes: "raw consult note only",
    });
    expect(outstandingConsultGuidance([aliased, notesOnly], "T1")).toBeUndefined();
    expect(rendered([notesOnly])).toBe("");
  });
});
