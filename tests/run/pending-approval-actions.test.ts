import { describe, expect, test } from "vitest";
import { ATTEMPT_CAP_RELEASE, GATE_SATISFIED_RELEASE, pendingApprovalActions, RECHECK_RELEASE, type JournalEvent } from "../../src/run/journal.js";

// Pure fold test (OBS-1075): events in, typed actions out — no daemon, no git.
let tick = 0;
const ev = (event: string, taskId?: string, data: Record<string, unknown> = {}): JournalEvent =>
  ({ ts: `2026-09-21T00:00:${String(tick++).padStart(2, "0")}.000Z`, event, ...(taskId ? { taskId } : {}), data });
// OBS-1178: a decision binds to the task's newest park in `rows` by line (in memory: index + 1) and timestamp.
const approval = (rows: JournalEvent[], taskId: string, data: Record<string, unknown> = {}): JournalEvent => {
  const i = rows.map((e) => e.event === "task-human" && e.taskId === taskId).lastIndexOf(true);
  return ev("task-approved", taskId, { ...data, park: { line: i + 1, ts: rows[i]!.ts } });
};

describe("pendingApprovalActions", () => {
  test("a plain approval journaled after a task's last dispatch stays pending when the run ends abnormally before any launch, so a fold that drops it at the run boundary fails", () => {
    const parked = [ev("task-dispatch", "T1"), ev("worker-launch", "T1"), ev("task-human", "T1")];
    const events = [
      ...parked,
      approval(parked, "T1"),
      ev("run-end", undefined, { reason: "abnormal" }), ev("run-start"), ev("resume-restore"),
    ];
    const action = pendingApprovalActions(events).get("T1");
    expect(action).toMatchObject({ taskId: "T1", authority: "worker", release: "plain", ts: events[3]!.ts });
  });

  test("a dispatch that follows the approval consumes it exactly once whereas a launch crash before any dispatch row leaves it pending, so a fold that consumes on acceptance alone fails", () => {
    const park = [ev("task-human", "T1")];
    const crashed = [...park, approval(park, "T1"), ev("run-end", undefined, { reason: "launch-crash" })];
    expect(pendingApprovalActions(crashed).get("T1")?.authority).toBe("worker");

    const dispatched = [...crashed, ev("task-dispatch", "T1"), ev("worker-launch", "T1")];
    expect(pendingApprovalActions(dispatched).has("T1")).toBe(false);

    // exactly once: the consumed dispatch does not pre-consume the NEXT approval, and another task's
    // dispatch consumes nothing here.
    const reparked = [...dispatched, ev("task-human", "T1")];
    const second = approval(reparked, "T1");
    const again = [...reparked, second, ev("task-dispatch", "T2")];
    expect(pendingApprovalActions(again).get("T1")?.ts).toBe(second.ts);
    expect(pendingApprovalActions([...again, ev("task-dispatch", "T1")]).size).toBe(0);
  });

  test("a recheck release is reported as battery-only authority that a recheck battery row consumes, so a recheck read as worker funding fails", () => {
    const park = [ev("task-human", "T1")];
    const events = [...park, approval(park, "T1", { release: RECHECK_RELEASE })];
    expect(pendingApprovalActions(events).get("T1")).toMatchObject({ authority: "battery", release: RECHECK_RELEASE });
    // worker-funding rows are not its enactment
    expect(pendingApprovalActions([...events, ev("task-dispatch", "T1"), ev("worker-launch", "T1")]).get("T1")?.authority).toBe("battery");
    expect(pendingApprovalActions([...events, ev("recheck-battery", "T1")]).has("T1")).toBe(false);
  });

  test("a waiver release satisfies only its named gate until the worktree recreation row enacts it, so a waiver that satisfies a second gate fails", () => {
    const park = [ev("gate-result", "T1", { gate: "scope", pass: false }), ev("task-human", "T1")];
    const events = [...park, approval(park, "T1", { release: GATE_SATISFIED_RELEASE, gate: "scope" })];
    const action = pendingApprovalActions(events).get("T1");
    expect(action).toMatchObject({ authority: "waiver", gate: "scope" });
    expect(Object.values(action!).filter((v) => v === "review" || v === "lint")).toEqual([]);
    expect(pendingApprovalActions([...events, ev("task-dispatch", "T1")]).get("T1")).toEqual(action);
    expect(pendingApprovalActions([...events, ev("worktree-recreation", "T1")]).has("T1")).toBe(false);
  });

  test("an attempt cap release keeps its typed budget meaning across replay whereas an unknown release value is reported inert, so an unknown value read as fresh worker funding fails", () => {
    const parks = [ev("task-human", "T1"), ev("task-human", "T2"), ev("task-human", "T3")];
    const events = [
      ...parks,
      approval(parks, "T1", { release: ATTEMPT_CAP_RELEASE }),
      approval(parks, "T2", { release: "attempt-capp" }),
      approval(parks, "T3", { release: GATE_SATISFIED_RELEASE, gate: "not-a-gate" }),
      ev("run-end"), ev("run-start"),
    ];
    const first = pendingApprovalActions(events);
    expect(first.get("T1")).toMatchObject({ authority: "worker", release: ATTEMPT_CAP_RELEASE });
    expect(pendingApprovalActions(events)).toEqual(first);
    expect(first.get("T2")).toMatchObject({ authority: "inert", release: "attempt-capp" });
    // OBS-1178: a waive naming a gate its park never failed does not bind, so it is no action at all
    expect(first.has("T3")).toBe(false);
    // inert authorises nothing, so no row enacts it
    expect(pendingApprovalActions([...events, ev("task-dispatch", "T2")]).get("T2")?.authority).toBe("inert");
  });
});
