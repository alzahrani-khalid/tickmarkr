import { expect, test } from "vitest";
import { foldActivity, projectActivity, type ActivityTask } from "../../src/run/activity.js";
import { COMMAND_RECEIPT_OUTCOMES, trackJournalRows, type CommandReceipt } from "../../src/run/protocol.js";
import type { JournalEvent } from "../../src/run/journal.js";

const task: ActivityTask = { id: "T1", gates: ["build", "test", "acceptance", "review"], deps: [], status: "pending" };
const event = (name: string, data: Record<string, unknown> = {}): JournalEvent =>
  ({ event: name, ts: "2026-07-22T08:00:00.000Z", taskId: "T1", data });
const dispatch = event("task-dispatch", { attempt: 0, assignment: { adapter: "fake", model: "fake-1" } });
const returned = event("worker-result", { ok: true, finished: true });
const start = (gate: string) => event("phase-start", { phase: `gate:${gate}`, gate });
const result = (gate: string) => event("gate-result", { gate, pass: true });
const receipt = (outcome: CommandReceipt["outcome"], invocation = "a", extra: Record<string, unknown> = {}) => event("build-receipt", {
  gate: "build", outcome, confirmedStart: ["started", "completed", "timed-out", "cancelled"].includes(outcome),
  attribution: { runId: "run", taskId: "T1", attempt: 0, gateRound: 0, invocation, ...extra },
});
const tracked = (events: readonly JournalEvent[], runId = "run") =>
  trackJournalRows(runId, events.map((raw, sourceIndex) => ({ raw, sourceIndex })));
const project = (events: readonly JournalEvent[]) => projectActivity("run", tracked(events), [task]).get("T1")!;

test("test: a task-dispatch row alone projects preparing and only a worker-launch row moves the task to implementing, so a projection that reads a dispatch as a working agent fails", () => {
  expect(project([dispatch]).state).toBe("preparing");
  expect(project([dispatch, event("phase-start", { phase: "worker" })]).state).toBe("preparing");
  expect(project([dispatch, event("worker-launch", { attempt: 0 })]).state).toBe("implementing");
  expect(project([dispatch, event("role-invocation-start", { attempt: 0, role: "worker" })]).state).toBe("preparing");
});

test("test: a worker-result row projects returned for verification until a gate phase-start names a gate, whose entry projects validating or reviewing without claiming a build subprocess started, and a green gate-result leaves the next phase unconfirmed until its own phase-start or a merge phase-start, so a projection that predicts the next gate running or infers merging from all-green fails", () => {
  const rows = [dispatch, returned];
  expect(project(rows).state).toBe("returned-for-verification");
  rows.push(event("phase-start", { phase: "gates" }));
  expect(project(rows).state).toBe("returned-for-verification");
  expect(project([...rows, start("build")])).toMatchObject({ state: "validating", build: { state: "awaiting-command" } });
  rows.push(start("build"), result("build"));
  expect(project(rows)).toMatchObject({ state: "unconfirmed", phases: [] });
  expect(project([...rows, start("test")]).phases).toEqual([{ gate: "test", state: "validating" }]);
  const review = event("gate-phase-start", { attempt: 0, gate: "review" });
  expect(project([...rows, review])).toMatchObject({ state: "reviewing", build: { state: "start-unrecorded" } });
  rows.push(...task.gates.map(result));
  expect(project(rows).state).toBe("unconfirmed");
  expect(project([...rows, event("phase-start", { phase: "merge" })]).state).toBe("merging");
});

test("test: build receipts project started completed spawn-failed timed-out cancelled reused-result skipped and refused distinctly for the current invocation while gate entry alone projects awaiting command, a journal with no receipts projects start unrecorded, and a confirmed start with no terminal after a run-resume or run-end row projects unresolved rather than dead, so a projection that asserts no build ran from missing rows or reads unknown liveness as death fails", () => {
  expect(project([dispatch, returned]).build).toEqual({ state: "start-unrecorded" });
  expect(project([dispatch, returned, start("build")]).build).toEqual({ state: "awaiting-command" });
  const legacy = [dispatch, returned, event("phase-start", { phase: "gates" }), start("build"), result("build")];
  expect(project(legacy).build).toEqual({ state: "start-unrecorded" });
  legacy.push(...task.gates.slice(1).flatMap((gate) => [start(gate), result(gate)]),
    event("phase-start", { phase: "merge" }));
  expect(project(legacy)).toMatchObject({ state: "merging", build: { state: "start-unrecorded" } });
  expect(project([...legacy, event("task-done")])).toMatchObject({ state: "terminal", build: { state: "start-unrecorded" } });
  for (const outcome of COMMAND_RECEIPT_OUTCOMES) {
    const rows = [dispatch, returned, start("build")];
    if (["completed", "timed-out", "cancelled"].includes(outcome)) rows.push(receipt("started"));
    rows.push(receipt(outcome));
    expect(project(rows).build).toMatchObject({ state: outcome, receipt: { outcome } });
  }
  for (const boundary of ["run-resume", "run-end"]) {
    const end = boundary === "run-resume" ? event(boundary) : event(boundary, {
      runId: "run", branch: "main", done: [], failed: [], human: [],
    });
    delete end.taskId;
    const rows = [dispatch, start("build"), receipt("started"), end];
    expect(project(rows)).toMatchObject({ state: "unconfirmed", phases: [], build: { state: "unresolved" } });
    expect(project([...rows, receipt("completed")]).build.state).toBe("completed");
    if (boundary === "run-resume") {
      const resumed = [...rows, event("resume-restore", { attempts: 1 }),
        event("phase-start", { phase: "gates" }), start("build")];
      expect(project([...resumed, receipt("completed", "a")]).build.state).toBe("awaiting-command");
      resumed.push(receipt("started", "c", { attempt: 1, gateRound: 1 }),
        receipt("completed", "c", { attempt: 1, gateRound: 1 }),
        event("gate-result", { gate: "build", pass: true, attempt: 1 }));
      expect(project(resumed)).toMatchObject({ attempt: 1, build: { state: "completed" }, phases: [] });
      resumed.push(start("test"), event("gate-result", { gate: "test", pass: true, attempt: 1 }));
      expect(project(resumed)).toMatchObject({ state: "unconfirmed", phases: [] });
      expect(project([...resumed, receipt("started", "old", { attempt: 0, gateRound: 1 }),
        event("gate-phase-start", { gate: "review", attempt: 0 })])).toEqual(project(resumed));

      // A resumed battery may skip build: the gate result then supplies the round's label.
      const withoutBuild = [...rows, event("phase-start", { phase: "gates" }), start("test"),
        event("gate-result", { gate: "test", pass: true, attempt: 1 })];
      expect(project(withoutBuild)).toMatchObject({ attempt: 1, state: "unconfirmed", phases: [] });
    }
  }
});

test("test: rows from another run id an older attempt a completed phase or a late terminal for a stale invocation never revive current activity, and concurrent acceptance and review phase-starts stay visible together, so a stale row that revives activity or a concurrent phase that hides the other fails", () => {
  const rows = [dispatch, returned, start("build"), receipt("started", "a"), receipt("started", "b")];
  expect(project([...rows, receipt("completed", "a")]).build).toMatchObject({ state: "started", receipt: { attribution: { invocation: "b" } } });
  expect(project([...rows, receipt("completed", "b", { runId: "other" })])).toEqual(project(rows));
  expect(project([...rows, result("build"), start("build"), receipt("started", "c")]).phases).toEqual([]);
  expect(project([...rows, result("build"), start("build"), receipt("started", "c")]).build).toEqual(project(rows).build);
  const next = [...rows, event("task-dispatch", { attempt: 1 })];
  expect(project([...next, dispatch, event("worker-launch", { attempt: 0 }), receipt("completed", "b")])).toEqual(project(next));
  const mixed = [...tracked(next), ...tracked([event("worker-launch", { attempt: 1 })], "other")];
  expect(projectActivity("run", mixed, [task]).get("T1")).toEqual(project(next));
  const concurrent = [...next, returned, start("acceptance"), event("gate-phase-start", { attempt: 1, gate: "review" })];
  expect(project(concurrent).phases).toEqual([{ gate: "acceptance", state: "validating" }, { gate: "review", state: "reviewing" }]);
  expect(project([...concurrent, result("acceptance")]).phases).toEqual([{ gate: "review", state: "reviewing" }]);
  const retry = [dispatch, returned, event("phase-start", { phase: "gates" }), start("acceptance"), start("review"),
    event("gate-result", { gate: "review", skipped: true, infra: true }),
    event("review-infra-retry", { reviewer: "fake:fake-1", cause: "timeout" })];
  expect(project(retry).phases).toEqual([{ gate: "acceptance", state: "validating" }]);
  retry.push(start("review"));
  expect(project(retry).phases).toEqual([{ gate: "acceptance", state: "validating" }, { gate: "review", state: "reviewing" }]);
  expect(project([...retry, result("acceptance")]).state).toBe("reviewing");
  expect(project([...retry, result("review"), start("review")]).phases).toEqual([{ gate: "acceptance", state: "validating" }]);
  expect(project([...concurrent, event("task-done"), start("test")]).state).toBe("terminal");
  const newRound = [...rows, event("phase-start", { phase: "gates" }), start("build")];
  expect(project([...newRound, receipt("completed", "b")]).build.state).toBe("awaiting-command");
  expect(project([...newRound, receipt("started", "c", { gateRound: 1 })]).build.state).toBe("started");
});

test("test: identical inputs yield deep-equal projections with the input arrays and task objects unmodified, and the legacy activity cells for the v2.5.6 status fixtures are byte-identical to before, so a mutation or a changed legacy cell fails", () => {
  const rows = tracked([dispatch, returned, start("build"), receipt("started")]);
  const tasks = [task];
  const before = JSON.stringify({ rows, tasks });
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(rows); freeze(tasks);
  expect(projectActivity("run", rows, tasks)).toEqual(projectActivity("run", rows, tasks));
  expect(JSON.stringify({ rows, tasks })).toBe(before);
  const fixtures: [JournalEvent[], string | undefined][] = [
    [[dispatch], "attempt 1 in flight on fake:fake-1 since 08:00:00"],
    [[dispatch, returned], "gate build running"],
    [[dispatch, returned, result("build")], "gate test running"],
    [[dispatch, returned, ...task.gates.map(result)], "merging"],
    [[dispatch, event("task-human", { kind: "attempt-cap" }), event("run-resume")], "parked (attempt-cap)"],
    [[dispatch, event("task-done")], undefined],
  ];
  for (const [events, expected] of fixtures) expect(foldActivity(events, tasks).cells.get("T1")).toBe(expected);
});
