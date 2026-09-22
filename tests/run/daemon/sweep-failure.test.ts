import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { loadGraph, tickmarkrDir } from "../../../src/graph/graph.js";
import { recordFatalRunEnd, runDaemon } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import * as locks from "../../../src/run/lock.js";
import * as merge from "../../../src/run/merge.js";
import { trackJournalRows } from "../../../src/run/protocol.js";
import { COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

afterEach(() => vi.restoreAllMocks());

async function failedResume(refuseAppend = false, setupFailure = false) {
  const { repo, fake } = setupRepo([
    T("done"), T("parked", { humanGate: true }), T("blocked", { deps: ["parked"] }),
  ], { tasks: { done: [{ shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "done" } }] } });
  const runId = "run-sweep-failure";
  await runDaemon(repo, { adapters: [fake], runId, approvalWindowMs: 1 });
  const journal = Journal.open(repo, runId);
  const before = journal.read();
  expect(before.at(-1)?.event).toBe("run-end");
  journal.append("worktree-preserved", "parked", { ref: "refs/tickmarkr/preserved/parked" });
  const original = new Error(setupFailure ? "resumed integration setup exploded" : "scheduler approval sweep exploded");
  const realRead = Journal.prototype.read;
  let armed = false;
  let threw = false;
  if (setupFailure) {
    vi.spyOn(merge, "ensureIntegration").mockImplementationOnce(async () => {
      threw = true;
      throw original;
    });
  }
  vi.spyOn(Journal.prototype, "read").mockImplementation(function (this: Journal) {
    if (armed && !threw) { threw = true; throw original; }
    return realRead.call(this);
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const realAppend = Journal.prototype.append;
  let fatalAttempts = 0;
  let lockedAtAppend = false;
  vi.spyOn(Journal.prototype, "append").mockImplementation(function (this: Journal, event, taskId, data) {
    if (event === "run-end" && data?.fatal) {
      fatalAttempts++;
      lockedAtAppend = existsSync(join(tickmarkrDir(repo), "graph.lock"));
      if (refuseAppend) throw new Error("ENOSPC fatal sink refused");
    }
    return realAppend.call(this, event, taskId, data);
  });
  const realRelease = locks.releaseRunLock;
  let rowsAtRelease = before;
  vi.spyOn(locks, "releaseRunLock").mockImplementation((root) => {
    rowsAtRelease = realRead.call(journal);
    realRelease(root);
  });
  await expect(runDaemon(repo, {
    adapters: [fake], runId, resume: true, approvalWindowMs: 1,
    narrate: (event) => {
      if (event.event === "approval-window-start") {
        // A successful sweep would release this task: teardown must not dispatch its funded work.
        journal.append("task-approved", "parked", { by: "operator" });
        armed = true;
      }
    },
  })).rejects.toBe(original);
  expect(threw).toBe(true);
  const events = journal.read();
  return { repo, runId, journal, original, before, events, rowsAtRelease, lockedAtAppend, fatalAttempts,
    errors: errors.mock.calls.flat().join("\n") };
}

test("test: a resumed engagement whose scheduler sweep throws journals its own fatal run end after the earlier engagement's run end, so a boundary that stays silent because an older terminal row exists fails", async () => {
  const { repo, runId, journal, original, events, before } = await failedResume();
  const ends = events.filter((e) => e.event === "run-end");
  expect(ends).toHaveLength(2);
  expect(events.slice(0, before.length)).toEqual(before);
  expect(events.findIndex((e) => e.event === "run-resume")).toBeGreaterThan(before.length - 1);
  expect(ends[1]!.data).toMatchObject({ fatal: true, phase: "scheduler", error: original.message });
  recordFatalRunEnd(journal, runId, "ignored", original, loadGraph(repo), "scheduler");
  expect(journal.read()).toEqual(events); // only the current engagement deduplicates
});

test("test: that fatal run end names the done tasks plus the parked tasks as the graph held them, so a fatal close reporting empty buckets or a green outcome fails", async () => {
  const { events, runId } = await failedResume();
  expect(events.at(-1)?.data).toMatchObject({
    done: ["done"], human: ["parked"], blocked: ["blocked"], failed: [], pending: [],
    fatal: true, phase: "scheduler", error: "scheduler approval sweep exploded",
    preservedRefs: [{ taskId: "parked", ref: "refs/tickmarkr/preserved/parked" }],
  });
  expect(trackJournalRows(runId, events.map((raw, sourceIndex) => ({ raw, sourceIndex }))).at(-1)).toMatchObject({
    kind: "decision", event: { event: "run-end", data: { outcome: "failed" } },
  });
});

test("a resumed setup failure retains replayed done and parked tasks in its fatal run end", async () => {
  const { events, original, rowsAtRelease, lockedAtAppend } = await failedResume(false, true);
  expect(events.filter((e) => e.event === "run-end")).toHaveLength(2);
  expect(events.at(-1)?.data).toMatchObject({
    done: ["done"], human: ["parked"], blocked: ["blocked"], failed: [], pending: [],
    fatal: true, phase: "setup", error: original.message,
  });
  expect(lockedAtAppend).toBe(true);
  expect(rowsAtRelease).toEqual(events);
  const resumed = events.slice(events.findIndex((e) => e.event === "run-resume"));
  expect(resumed.some((e) => e.event === "task-dispatch")).toBe(false);
});

test("test: the fatal run end is the last row the engagement journals before its run lock is released, so a teardown that dispatches another task after the failure fails", async () => {
  const { repo, events, rowsAtRelease, lockedAtAppend, before } = await failedResume();
  expect(lockedAtAppend).toBe(true);
  expect(rowsAtRelease).toEqual(events);
  expect(rowsAtRelease.at(-1)?.data.fatal).toBe(true);
  expect(events.slice(before.length).filter((e) => e.event === "task-dispatch")).toEqual([]);
  expect(existsSync(join(tickmarkrDir(repo), "graph.lock"))).toBe(false);
});

test("test: a journal sink that refuses the fatal append reports the original sweep error beside the sink failure while claiming no terminal record, so a report that swallows the original error fails", async () => {
  const { events, before, errors, fatalAttempts } = await failedResume(true);
  expect(fatalAttempts).toBe(2);
  expect(events.slice(before.length).some((e) => e.event === "run-end")).toBe(false);
  expect(errors).toContain("no terminal record written");
  expect(errors).toContain("ENOSPC fatal sink refused");
  expect(errors).toContain("original error: scheduler approval sweep exploded");
});
