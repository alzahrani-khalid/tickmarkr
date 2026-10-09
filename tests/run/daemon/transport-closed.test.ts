import { expect, test } from "vitest";
import { HerdrDriver } from "../../../src/drivers/herdr.js";
import { OrcaDriver } from "../../../src/drivers/orca.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../../src/drivers/types.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

// Queue row 108 (D-1619): a subprocess 'exit' precedes its stdio 'close', so a worker that just finished can look gone —
// no pane bytes, no process, an unchanged worktree — while its trailer is still in flight. This driver holds the
// worker's bytes back for its first reads after the process is gone (the state between 'exit' and 'close') and reports
// its transport OPEN meanwhile. The worker finished; it must be harvested, never parked as dead.
const HELD_READS = 6;

function inFlightDriver(): ExecutorDriver {
  const inner = new SubprocessDriver();
  const served = new Map<string, number>();
  const gone = (slot: Slot) => inner.waitAgentStatus(slot, "done", 0);
  const inFlight = async (slot: Slot) => (await gone(slot)) && (served.get(slot.id) ?? 0) < HELD_READS;
  return {
    id: "in-flight-after-exit",
    interactive: true,
    status: async () => "unknown",
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    async read(slot, lines) {
      if (await inFlight(slot)) { served.set(slot.id, (served.get(slot.id) ?? 0) + 1); return ""; }
      return inner.read(slot, lines);
    },
    async waitOutput(slot, pattern, timeoutMs, opts) {
      // the trailer stays in flight until the process is gone and HELD_READS reads have come back empty
      const until = Date.now() + timeoutMs;
      while (!(await gone(slot)) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      if (await inFlight(slot)) return false;
      return inner.waitOutput(slot, pattern, timeoutMs, opts);
    },
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    async transportState(slot) {
      const state = await inner.transportState!(slot);
      return (await inFlight(slot)) ? { ...state, closed: false } : state;
    },
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  } as ExecutorDriver;
}

test("a worker whose output is still in flight after its process is gone is never parked as dead", async () => {
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [
    // finishes with a trailer but commits nothing (evidence fails → the ladder retries), so its worktree is unchanged
    { shell: "true", result: { ok: true, summary: "finished, nothing committed" } },
    { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "retry commits" } },
  ] } });
  const s = await runDaemon(repo, { adapters: [fake], runId: "run-in-flight", driver: inFlightDriver() });
  expect(s.done).toEqual(["T1"]);
  const evs = Journal.open(repo, "run-in-flight").read().filter((e) => e.taskId === "T1");
  expect(evs.filter((e) => e.event === "worktree-preserved")).toEqual([]);
  // the guard is what held it: the open transport is journaled once, by name
  expect(evs.filter((e) => e.event === "worker-dead-held" && e.data.reason === "transport-open").length).toBe(1);
});

test("the subprocess transport is open while its worker runs and closed with its exit code once every byte is read", async () => {
  const driver = new SubprocessDriver();
  const slot = await driver.slot(makeTestTempDir("tickmarkr-transport-"), "t");
  await driver.run(slot, "sleep 1; echo done");
  expect((await driver.transportState!(slot)).closed).toBe(false);
  expect(await driver.waitAgentStatus(slot, "done", 10_000)).toBe(true);
  const state = await driver.transportState!(slot);
  expect([state.closed, state.exitCode, state.signal]).toEqual([true, 0, null]);
  expect(state.bytes).toBeGreaterThan(0);
});

test("a subprocess worker killed by a signal reads closed with that signal", async () => {
  const driver = new SubprocessDriver();
  const slot = await driver.slot(makeTestTempDir("tickmarkr-transport-"), "t");
  await driver.run(slot, "kill -KILL $$");
  expect(await driver.waitAgentStatus(slot, "done", 10_000)).toBe(true);
  const state = await driver.transportState!(slot);
  expect([state.closed, state.signal]).toEqual([true, "SIGKILL"]);
  expect(typeof state.bytes).toBe("number"); // a login shell may print before the kill; the signal is the fact
});

test("pane drivers answer their transport closed, since their closure is the pane being gone, which a park already requires", async () => {
  const slot = { id: "p", name: "p", cwd: "/" } as Slot;
  expect((await new HerdrDriver("herdr").transportState!(slot)).closed).toBe(true);
  expect((await new OrcaDriver({}).transportState!(slot)).closed).toBe(true);
});

// D-1622: the transport state belongs to the CURRENT invocation, and only that invocation's stdio 'close' closes it (or a
// spawn that never started — nothing to drain). The slot's long-lived `exited` flag is not that fact.
type Internals = { slots: Map<string, { proc?: import("node:child_process").ChildProcess }> };
test("a subprocess error event while its worker runs leaves the transport open", async () => {
  const driver = new SubprocessDriver();
  const slot = await driver.slot(makeTestTempDir("tickmarkr-transport-"), "t");
  await driver.run(slot, "sleep 2");
  (driver as unknown as Internals).slots.get(slot.id)!.proc!.emit("error", new Error("late transport error"));
  expect((await driver.transportState!(slot)).closed).toBe(false);
});

test("a subprocess that never started reads closed, with its error in the pane", async () => {
  const driver = new SubprocessDriver();
  const slot = await driver.slot(`${makeTestTempDir("tickmarkr-transport-")}/missing-dir`, "t");
  await driver.run(slot, "echo never");
  await new Promise((r) => setTimeout(r, 200));
  expect((await driver.transportState!(slot)).closed).toBe(true);
  expect(await driver.read(slot, 20)).toContain("[tickmarkr subprocess error]");
});

test("a reused subprocess slot answers for its current worker, not the one that exited before it", async () => {
  const driver = new SubprocessDriver();
  const slot = await driver.slot(makeTestTempDir("tickmarkr-transport-"), "t");
  await driver.run(slot, "exit 7");
  expect(await driver.waitAgentStatus(slot, "done", 10_000)).toBe(true);
  await driver.run(slot, "sleep 2");
  const state = await driver.transportState!(slot);
  expect([state.closed, state.exitCode]).toEqual([false, null]);
});

test("a delayed close from a previous worker never closes the current one", async () => {
  const driver = new SubprocessDriver();
  const slot = await driver.slot(makeTestTempDir("tickmarkr-transport-"), "t");
  await driver.run(slot, "sleep 0.3; echo first");
  await driver.run(slot, "sleep 3");
  await new Promise((r) => setTimeout(r, 900)); // the first worker has exited and closed by now
  expect((await driver.transportState!(slot)).closed).toBe(false);
});
