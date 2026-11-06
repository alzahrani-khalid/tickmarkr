import { expect, test } from "vitest";
import { summarize } from "../../src/board/summarize.js";

const start = Date.parse("2026-11-02T10:00:00.000Z") / 1000;
const at = (seconds: number, event: string, data: object = {}, taskId?: string) => ({
  ts: new Date((start + seconds) * 1000).toISOString(), event, data, ...(taskId ? { taskId } : {}),
});
const graph = { tasks: [{ id: "T1", title: "Task one" }] };
const firstEnd = { runId: "run-s7", done: [], failed: [], human: ["T1"], blocked: [], pending: [],
  tipVerify: "first leg", owedChecks: { known: true, outstanding: ["check"] } };
const laterEnd = { runId: "run-s7", done: ["T1"], failed: [], human: [], blocked: [], pending: [],
  tipVerify: "later leg", owedChecks: { known: true, outstanding: [] } };
const events = [
  at(0, "run-start", { runId: "run-s7" }),
  at(10, "task-dispatch", { attempt: 0 }, "T1"),
  at(20, "phase-start", { phase: "worker" }, "T1"),
  at(30, "task-human", { kind: "review", reason: "needs approval" }, "T1"),
  at(40, "approval-window-start", { windowMs: 120_000, parked: ["T1"] }),
  at(60, "run-end", firstEnd),
  at(90, "run-resume", { effectivePolicy: { concurrency: 2 } }),
  at(100, "approval-window-start", { windowMs: 30_000, parked: ["T1"] }),
  at(110, "task-dispatch", { attempt: 1 }, "T1"),
  at(120, "phase-start", { phase: "worker" }, "T1"),
  at(180, "run-end", laterEnd),
];
const cut = (count: number) => summarize(events.slice(0, count), graph, 123, true, start + 600,
  { worker: 60, semantics: 60, test: 60 });

test("a resumed run summarizes with ended null endEpoch null and atEpoch at now until a later run-end whose record and time it then reports (contract R rows)", () => {
  const neverEnded = cut(5);
  expect([neverEnded.ended, neverEnded.endEpoch, neverEnded.atEpoch]).toEqual([null, null, start + 600]);
  expect(neverEnded.approvalWindow).toEqual({ closesAt: start + 160, parked: ["T1"] });

  const firstLeg = cut(6);
  expect(firstLeg.ended).toStrictEqual({ done: [], failed: [], human: ["T1"], blocked: [], pending: [], tipVerify: "first leg", owed: 1 });
  expect([firstLeg.endEpoch, firstLeg.atEpoch, firstLeg.elapsedMin]).toEqual([start + 60, start + 60, 1]);
  expect(firstLeg.approvalWindow).toBeNull();
  expect(firstLeg.tasks[0].history[0].parts.some((part) => part.text.startsWith("worker"))).toBe(true);

  const reopened = cut(7);
  expect([reopened.ended, reopened.endEpoch, reopened.atEpoch, reopened.elapsedMin]).toEqual([null, null, start + 600, 10]);
  expect(reopened.approvalWindow).toBeNull(); // the first leg's window cannot outlive the reopening resume
  expect(reopened.needsYou).toHaveLength(1); // run-end's unresolved park stays closed until released

  const newWindow = cut(8);
  expect(newWindow.approvalWindow).toEqual({ closesAt: start + 130, parked: ["T1"] });
  const working = cut(10);
  expect([working.ended, working.endEpoch, working.atEpoch]).toEqual([null, null, start + 600]);
  expect(working.needsYou).toEqual([]); // dispatch after resume releases the old park
  expect(working.eta).not.toBeNull();

  const endedAgain = cut(11);
  expect(endedAgain.ended).toStrictEqual({ done: ["T1"], failed: [], human: [], blocked: [], pending: [], tipVerify: "later leg", owed: 0 });
  expect([endedAgain.endEpoch, endedAgain.atEpoch, endedAgain.elapsedMin]).toEqual([start + 180, start + 180, 3]);
  expect(endedAgain.approvalWindow).toBeNull();
  expect(endedAgain.eta).toBeNull();
});
