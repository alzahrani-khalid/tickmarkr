import { describe, expect, test } from "vitest";
import { graphDefinitionHash } from "../../src/graph/graph.js";
import { boardFrame } from "../../src/tui/cockpit/board.js";
import { evidenceLookup, runGateCells } from "../../src/tui/cockpit/run-view.js";
import { readOperatorState } from "../../src/run/operator-state.js";
import { graph, partial, approved, resumed, complete, ev } from "../fixtures/operator-state/fixture.js";

test("The exported operator-state reader required by C1 and C6 replays the three-task partial→approved→resumed→complete fixture with a matching graph with merged numerator 1 then 3 and planned denominator 3. Green requires the latest run-end, tip not failed and empty failed/human/blocked/pending buckets. One human or blocked member remains PARTIAL despite historical tip pass, resume makes current tip PENDING, and a mismatched graph says not comparable. Borrowing denominator 2 from observed tasks, using an old run-end or treating unknown evidence as green fails.", () => {
  const read = (events = partial) => readOperatorState({ events, graph, sequence: 34, observedAt: 1000 });
  expect(read()).toMatchObject({ lifecycle: "PARTIAL", green: false, currentTip: "passed", merged: 1, planned: 3, sequence: 34, observedAt: 1000 });
  expect(read(approved)).toMatchObject({ lifecycle: "APPROVED", green: false, approvedResumeRequired: true, label: "approved; resume required" });
  expect(read(resumed)).toMatchObject({ lifecycle: "RUNNING", currentTip: "pending", merged: 1, planned: 3, latestRunEnd: undefined });
  expect(read(resumed).tasks[1]).toMatchObject({ attempt: 0, dispatches: 1, path: "/recorded/T2", pane: "p2", alarmMs: 45000 });
  expect(read(complete)).toMatchObject({ lifecycle: "COMPLETE", green: true, merged: 3, planned: 3, buckets: { failed: [], human: [], blocked: [], pending: [] } });
  const foreign = structuredClone(graph); foreign.tasks[0]!.goal = "a different definition";
  expect(readOperatorState({ events: partial, graph: foreign })).toMatchObject({ comparable: false, comparison: "not comparable", planned: undefined, merged: 1 });
  const foreignHash = graphDefinitionHash(foreign);
  expect(readOperatorState({ events: [partial[0]!, ev("graph-rehash", { from: partial[0]!.data.graphDefinitionHash, to: foreignHash }), ...partial.slice(1)], graph: foreign })).toMatchObject({ comparable: true, planned: 3 });
  expect(readOperatorState({ events: [ev("run-start", {}), ev("graph-rehash", { from: null, to: graphDefinitionHash(graph) }), ...complete.slice(1)], graph })).toMatchObject({ comparable: true, lifecycle: "COMPLETE", green: true, planned: 3 });
  expect(readOperatorState({ events: [partial[0]!, ev("graph-rehash", { from: "unrelated", to: graphDefinitionHash(graph) }), ...partial.slice(1)], graph })).toMatchObject({ comparable: false, comparison: "not comparable" });
  expect(readOperatorState({ events: partial })).toMatchObject({ comparable: false, planned: undefined });
  for (const key of ["human", "blocked", "failed", "pending"]) {
    const end = complete.at(-1)!;
    const events = [...complete.slice(0, -1), ev("run-end", { ...end.data, [key]: ["T3"] })];
    expect(read(events), key).toMatchObject({ lifecycle: "PARTIAL", green: false });
    const missing = { ...end.data }; delete missing[key];
    expect(read([...complete.slice(0, -1), ev("run-end", missing)]).green, key).toBe(false);
    expect(read([...complete.slice(0, -1), ev("run-end", { ...end.data, [key]: "garbage" })]).green).toBe(false);
  }
  for (const tipVerify of [undefined, "unknown", "failed"]) expect(read([...complete.slice(0, -1), ev("run-end", { ...complete.at(-1)!.data, tipVerify })]).green).toBe(false);
  expect(read([...complete, ev("run-resume")])).toMatchObject({ green: false, currentTip: "pending", latestRunEnd: undefined });
  expect(readOperatorState({ events: complete, graph, readable: false })).toMatchObject({ green: false, lifecycle: "UNKNOWN" });
  expect(read([ev("run-start", partial[0]!.data), ev("task-done", {}, "T1")]).merged).toBe(0);
  const unknownEvidence = [
    partial[0]!,
    ev("tip-verify", { pass: true }),
    ev("run-end", { done: [], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" }),
  ];
  expect(read(unknownEvidence)).toMatchObject({
    comparable: true,
    lifecycle: "PARTIAL",
    green: false,
    merged: 0,
    planned: 3,
    tasks: [
      expect.objectContaining({ id: "T1", state: "unknown" }),
      expect.objectContaining({ id: "T2", state: "unknown" }),
      expect.objectContaining({ id: "T3", state: "unknown" }),
    ],
  });
  expect(readOperatorState({ events: complete, graph: foreign })).toMatchObject({ comparable: false, lifecycle: "PARTIAL", green: false });
  expect(readOperatorState({ events: complete })).toMatchObject({ comparable: false, lifecycle: "PARTIAL", green: false });
  expect(read([
    partial[0]!,
    ev("task-done", {}, "T1"),
    ev("task-done", {}, "T2"),
    ev("task-done", {}, "T3"),
    ev("tip-verify", { pass: true }),
    ev("run-end", { done: ["T1", "T2", "T3"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" }),
  ])).toMatchObject({ lifecycle: "PARTIAL", green: false, merged: 0, planned: 3 });
});

describe("current attempt gate evidence", () => {
  test("declaration order is independent of result order and skipped or missing results never pass", () => {
    const events = [partial[0]!, ev("task-dispatch", { attempt: 3 }, "T1"), ev("gate-result", { gate: "review", pass: true, skipped: true }, "T1"), ev("gate-result", { gate: "acceptance", disabled: true }, "T1"), ev("gate-result", { gate: "test" }, "T1"), ev("gate-start", { gate: "build" }, "T1")];
    const s = readOperatorState({ events, graph });
    expect(Object.keys(s.tasks[0]!.gates)).toEqual(["build", "test", "lint", "evidence", "scope", "acceptance", "review"]);
    expect(s.tasks[0]!.gates).toMatchObject({ build: { state: "running" }, test: { state: "unknown" }, lint: { state: "not-run" }, acceptance: { state: "disabled" }, review: { state: "not-run" } });
    expect(s.gatesRan).toEqual({ passed: 0, total: 0 });
    expect(readOperatorState({ events: [...events, ev("task-dispatch", { attempt: 4 }, "T1")], graph }).tasks[0]!.gates.review).toEqual({ state: "not-run" });
  });
});


test("gate waits retain their own attribution and host context without borrowing old failures", () => {
  const events = [partial[0]!, ev("gate-result", { gate: "test", pass: false }, "T1"), ev("task-approved", { release: "recheck" }, "T1")];
  for (const event of ["suite-wait", "host-degraded"]) {
    const snapshot = readOperatorState({ events: [...events, ev(event, { count: 2 }, "T1")], graph });
    const task = snapshot.tasks[0]!;
    expect(task.gateActivity).toMatchObject({ state: "queued", reason: event, count: 2 });
    expect(task.gateActivity?.gate).toBeUndefined();
    const board = boardFrame({ runId: "run-test", snapshot, graph, now: 0, colour: false }, 180);
    expect(board.rows[0]!.note).toContain(`queued · gate unknown · ${event} (2 suites)`);
    expect(Object.values(task.gates).every(cell => cell.state === "not-run" && cell.evidence === undefined)).toBe(true);
    const attributed = readOperatorState({ events: [...events, ev(event, { count: 2, gate: "test" }, "T1")], graph }).tasks[0]!;
    expect(attributed.gates.test?.state).toBe("queued");
    const rows = [...events, ev(event, { count: 2, gate: "test" }, "T1")].map((event, i) => ({ event, line: i + 1 }));
    const cell = runGateCells(attributed, evidenceLookup(rows)).find(c => c.gate === "test")!;
    expect(cell.labels).toEqual([`queued — ${event} (2 suites)`]);
    expect(cell.verdict).toEqual([]);
  }
  const parallel = readOperatorState({ events: [...events,
    ev("phase-start", { phase: "judge", gate: "acceptance", parallel: true }, "T1"),
    ev("phase-start", { phase: "review", gate: "review", parallel: true }, "T1"),
    ev("suite-wait", { count: 1 }, "T1"),
  ], graph }).tasks[0]!;
  expect(parallel.gates.acceptance?.state).toBe("running");
  expect(parallel.gates.review?.state).toBe("running");
  expect(parallel.gateActivity?.gate).toBeUndefined();
});
