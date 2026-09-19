import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../../src/drivers/types.js";
import * as daemon from "../../../src/run/daemon.js";
import * as stall from "../../../src/run/stall.js";
import * as git from "../../../src/run/git.js";
import { Journal } from "../../../src/run/journal.js";
import { loadGraph } from "../../../src/graph/graph.js";
import { COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

const STALL = 600;
afterEach(() => {
  vi.restoreAllMocks();
  daemon.resetAttemptHardTimeoutMsForTests();
  daemon.resetNudgeTimingForTests();
  daemon.resetQuotaBannerSilentMsForTests();
  daemon.resetDeadChannelFastKillMsForTests();
  stall.resetHarvestCpuFlatMsForTests();
  daemon.NUDGEABLE_ADAPTERS.delete("fake");
});

type Scenario = {
  cpu?: "flat" | "accruing" | "unavailable";
  saturated?: boolean; banner?: boolean; trailerAt?: number; nudge?: boolean;
  transportError?: boolean; dirtyRetry?: boolean; sibling?: boolean; dispatchError?: boolean;
  repeat?: boolean; halt?: boolean;
  cleanupFailure?: "survivors" | "reaper" | "driver";
};
async function scenario(options: Scenario = {}) {
  vi.restoreAllMocks();
  const realNow = Date.now.bind(Date);
  let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
  // Nudge redelivery spends two real seconds as well as this fixture's accelerated polls.
  daemon.setAttemptHardTimeoutMsForTests(options.nudge ? 8_000 : 3_600);
  daemon.setQuotaBannerSilentMsForTests(100);
  daemon.setDeadChannelFastKillMsForTests(100_000);
  stall.setHarvestCpuFlatMsForTests(1);
  if (options.nudge) {
    daemon.NUDGEABLE_ADAPTERS.add("fake");
    daemon.setNudgeTimingForTests(0, 100);
  }
  vi.spyOn(stall.WorkerTreeCpuAccountant.prototype, "start").mockResolvedValue();
  vi.spyOn(stall.WorkerTreeCpuAccountant.prototype, "stop").mockResolvedValue();
  vi.spyOn(stall.WorkerTreeCpuAccountant.prototype, "read").mockImplementation(function (this: { marker: string }) { return {
    cpu: options.cpu === "unavailable" ? undefined : { ms: options.cpu === "accruing" || this.marker.includes("T2-") ? elapsed : 10, resolutionMs: 1 }, gaps: 0,
  }; });
  const { repo, fake } = setupRepo(
    [T("T1", { routingHints: { pin: { via: "fake", model: "fake-1" } } }), ...(options.sibling ? [T("T2")] : [])],
    { tasks: {}, consult: options.repeat || options.dirtyRetry ? { action: "retry", notes: "retry same seat" } : { action: "human", notes: "fixture stop" } },
    "taskTimeoutMinutes: 0.01\nconcurrency: 2\nvisibility:\n  worker: interactive\n",
  );
  Reflect.deleteProperty(fake, "busyFrameMarkers");
  const inner = new SubprocessDriver();
  const workers = new Map<string, { nonce: string; start: number; attempt: number; task: string; group: number; painted?: number }>();
  const alive = new Set<number>();
  const kills: number[] = [];
  const carries: string[] = [];
  let nextGroup = 40_000;
  let statusThrown = false;
  let polls = 0;
  let harvestedPoll: number | undefined;
  const groupFiles = new Map<string, number>();
  let cleanupFailed = false;
  vi.spyOn(stall, "readOwnedProcessGroup").mockImplementation((path) => groupFiles.get(path));
  vi.spyOn(stall, "reapOwnedProcessGroup").mockImplementation(async (group) => {
    if (!cleanupFailed && options.cleanupFailure !== "driver" && options.cleanupFailure
        && [...workers.values()].some((worker) => worker.task === "T1" && worker.group === group)) {
      cleanupFailed = true;
      if (options.cleanupFailure === "reaper") throw new Error("reaper probe failed");
      return [group!];
    }
    if (group !== undefined) { kills.push(group); alive.delete(group); }
    return [];
  });
  const priorHandlers = process.listeners("SIGTERM");
  let halted = false;
  let exited = false;
  const driver: ExecutorDriver = {
    id: "liveness-fixture", interactive: true,
    slot: inner.slot.bind(inner), worktree: inner.worktree.bind(inner), notify: async () => {},
    async run(slot, cmd) {
      if (!slot.name.includes("-worker-")) return inner.run(slot, cmd);
      const script = /^bash '(.+)'$/.exec(cmd)![1]!;
      const prompt = readFileSync(script.replace(/\.sh$/, ".md"), "utf8");
      const nonce = /TICKMARKR_RESULT_([a-z0-9]+)/.exec(prompt)![1]!;
      const attempt = Number(/-a(\d+)-/.exec(slot.name)![1]);
      const task = slot.name.startsWith("T2-") ? "T2" : "T1";
      const group = ++nextGroup;
      workers.set(slot.id, { nonce, start: elapsed, attempt, task, group });
      const groupFile = / > '([^']+\.pgid)'/.exec(readFileSync(script, "utf8"))![1]!;
      groupFiles.set(groupFile, group);
      alive.add(group);
      if (options.dirtyRetry && task === "T1") {
        if (attempt === 0) writeFileSync(`${slot.cwd}/rescue.txt`, "uncommitted rescue bytes\n");
        else carries.push(readFileSync(`${slot.cwd}/rescue.txt`, "utf8"));
      }
      if (options.dispatchError && task === "T1") throw new Error("dispatch transport failure");
    },
    async waitOutput(slot, pattern, ms, opts) {
      if (!workers.has(slot.id)) return inner.waitOutput(slot, pattern, ms, opts);
      if (options.halt && workers.size === 2 && !halted) {
        halted = true;
        const handler = process.listeners("SIGTERM").find((candidate) => !priorHandlers.includes(candidate));
        expect(handler).toBeDefined();
        handler!("SIGTERM"); // invoke only this daemon's actor, never the test runner's signal listeners
      }
      elapsed += Math.max(ms, 100);
      polls++;
      return false; // screen-only completion: the transport wake never sees it
    },
    async read(slot: Slot, lines?: number) {
      const worker = workers.get(slot.id);
      if (!worker) return inner.read(slot, lines);
      const trailerAt = worker.task === "T2" ? 1_200 : options.dirtyRetry && worker.attempt > 0 ? 0 : options.trailerAt;
      if (trailerAt !== undefined && elapsed - worker.start >= trailerAt) {
        expect(alive.has(worker.group)).toBe(true);
        if (worker.painted === undefined) {
          worker.painted = polls;
          execSync(`echo done > ${worker.task}.txt && ${COMMIT} done`, { cwd: slot.cwd, stdio: "ignore" });
        }
        harvestedPoll ??= polls;
        return `TICKMARKR_RESULT_${worker.nonce} {"ok":true,"summary":"fixture finished","deviations":[]}`;
      }
      return options.saturated ? Array.from({ length: 2_000 }, (_, i) => `PASS test ${i}`).join("\n")
        : options.banner ? "Rate limit exceeded; try again later" : "quiet worker";
    },
    async status(slot) {
      if (options.transportError && workers.has(slot.id) && !statusThrown) { statusThrown = true; throw new Error("transport unavailable"); }
      return "working";
    },
    waitAgentStatus: async () => true,
    nudge: async () => false,
    async close(slot) {
      if (!cleanupFailed && options.cleanupFailure === "driver" && workers.get(slot.id)?.task === "T1") {
        cleanupFailed = true;
        throw new Error("driver close failed");
      }
      await inner.close(slot);
    },
  };
  const run = daemon.runDaemon(repo, { adapters: [fake], driver, runId: "run-liveness", exit: (code) => {
    expect(code).toBe(143);
    exited = true;
  } });
  const summary = options.halt
    ? await run.then(() => { throw new Error("halt must reject the run"); }, (error) => {
      expect(String(error)).toContain("terminated by SIGTERM");
      return { done: [] };
    }) : await run;
  if (options.halt) {
    await vi.waitFor(() => expect(exited).toBe(true));
    // The injected exit returns; wait for both fake task actors to unwind as well.
    await vi.waitFor(() => expect(Journal.open(repo, "run-liveness").read()
      .filter((e) => e.event === "task-failed")).toHaveLength(2));
  }
  const events = Journal.open(repo, "run-liveness").read();
  return { repo, summary, events, kills, alive, carries, workers, harvestedPoll, polls };
}

test("test: a fake worker pane flat for the whole stall window over a flat worktree while its owned process group accrues cpu is not reaped when fixture time passes the stall window and harvests the valid trailer it paints afterwards within the hard timeout, the same pane with flat cpu is reaped at the window as stall-timeout, a pane showing a rate-limit banner in its chrome-filtered tail is journaled quota-banner naming the matched excerpt and its regex while a quiet pane with no banner text never is, and a reap over a dirty worktree preserves the edits on a ref whose bytes the next attempt's tree carries, so a stall reap over accruing cpu, a quota reap without banner text, or discarded dirty edits fails", async () => {
  const live = await scenario({ cpu: "accruing", trailerAt: STALL * 2 });
  expect(live.summary.done).toEqual(["T1"]);
  expect(live.events.some((e) => e.event === "worker-reaped-before-harvest")).toBe(false);
  expect(live.events.some((e) => e.event === "quota-banner")).toBe(false);
  const flat = await scenario({ cpu: "flat" });
  expect(flat.events.find((e) => e.event === "worker-reaped-before-harvest")?.data.cause).toBe("stall-timeout");
  expect(flat.events.some((e) => e.event === "worker-hard-timeout")).toBe(false);
  const banner = await scenario({ banner: true, trailerAt: undefined });
  const evidence = banner.events.find((e) => e.event === "quota-banner")!.data;
  expect(evidence.excerpt).toContain("Rate limit exceeded");
  expect(new RegExp(String(evidence.regex), "i").test(String(evidence.matched))).toBe(true);
  const dirty = await scenario({ dirtyRetry: true });
  expect(dirty.carries).toEqual(["uncommitted rescue bytes\n"]);
  const ref = dirty.events.find((e) => e.event === "worktree-preserved")!.data.ref;
  expect(execSync(`git show '${ref}:rescue.txt'`, { cwd: dirty.repo, encoding: "utf8" })).toBe(dirty.carries[0]);

  // Exercise the real accountant too: the dispatch root has gone away, but one
  // reparented member of its recorded group continues to consume CPU.
  vi.restoreAllMocks();
  const realSh = git.shGit;
  let sample = 0;
  vi.spyOn(git, "shGit").mockImplementation(async (cmd, cwd, timeout) => {
    if (cmd === "ps -Awwo pid=,ppid=,time=,command=") return { code: 0, stderr: "", stdout:
      `900001 1 0:00.${String(++sample).padStart(2, "0")} orphaned-tool\n900002 1 0:09.00 sibling-tool` };
    if (cmd === "ps -Awwo pid=,pgid=") return { code: 0, stderr: "", stdout: "900001 81000\n900002 82000" };
    return realSh(cmd, cwd, timeout);
  });
  const accountant = new stall.WorkerTreeCpuAccountant("absent-dispatch-root", dirty.repo, () => 81_000);
  try {
    await accountant.start();
    const first = accountant.read().cpu!.ms;
    await vi.waitFor(() => expect(accountant.read().cpu!.ms).toBeGreaterThan(first));
    expect(accountant.read().cpu!.ms).toBeLessThan(1_000); // sibling's nine seconds never enter this ledger
  } finally { await accountant.stop(); }

}, 60_000);

test("test: a pane read carrying a parseable nonce-bound trailer harvests within one poll after a failed nudge instead of waiting for the rolling window, and the trailer is sampled on the pane read for an interactive adapter that declares no busy markers, so a harvest held by the nudge latch or a pane sample gated on busy markers fails", async () => {
  const result = await scenario({ nudge: true, trailerAt: STALL * 2 });
  expect(result.events.some((e) => e.event === "worker-nudge-failed")).toBe(true);
  expect(result.summary.done, JSON.stringify(result.events)).toEqual(["T1"]);
  expect(result.events.some((e) => e.event === "worker-hard-timeout")).toBe(false);
  const worker = [...result.workers.values()][0]!;
  // The only subsequent transport wait is the normal post-trailer exit-marker drain.
  expect(result.polls - worker.painted!).toBeLessThanOrEqual(1);
}, 30_000);

test("test: a driver whose status probe throws a transport error once during the wait loop journals contact-unreadable with source driver and concludes false and the attempt harvests normally; with two attempts live, reaping one kills only the terminating attempt's recorded process group while the sibling's group stays alive and harvests, the task-failed cleanup after a dispatch error on one attempt kills only that attempt's recorded group while the surviving sibling harvests, a controlled halt driven through isolated fake actors kills exactly the owned groups, and every reap row names the group and every survivor it found; two consecutive stall reaps of one pinned seat with no gate reached park the task kind stall naming the seat, so a transport error that fails the task, a reap or task failure that kills a sibling, an orphan left behind, or a same-seat reap loop fails", async () => {
  const transport = await scenario({ transportError: true, cpu: "accruing", trailerAt: STALL * 2 });
  expect(transport.summary.done).toEqual(["T1"]);
  expect(transport.events.find((e) => e.event === "contact-unreadable")?.data).toMatchObject({ source: "driver", concludes: false });
  for (const dispatchError of [false, true]) {
    const pair = await scenario({ sibling: true, dispatchError });
    expect(pair.summary.done).toContain("T2");
    expect(pair.alive.size).toBe(0);
    expect(new Set(pair.kills).size).toBe(pair.kills.length);
    for (const event of pair.events.filter((e) => /worker-(?:process-reaped|reaped-before-harvest)/.test(e.event))) {
      expect(event.data.processGroup).toEqual(expect.any(Number));
      expect(event.data.survivors).toEqual([]);
    }
  }
  const halted = await scenario({ sibling: true, halt: true, cpu: "accruing" });
  expect(halted.alive.size).toBe(0);
  expect(halted.kills.sort()).toEqual([...halted.workers.values()].map((worker) => worker.group).sort());
  expect(halted.events.find((e) => e.event === "exit-cause")?.data).toMatchObject({ cause: "deliberate", signal: "SIGTERM" });
  const repeated = await scenario({ repeat: true });
  const park = repeated.events.find((e) => e.event === "task-human");
  expect(park?.data).toMatchObject({ kind: "stall", seat: "fake:fake-1" });
  expect(repeated.events.filter((e) => e.event === "task-dispatch")).toHaveLength(2);

  // Isolated signal actors exercise the same close claims as the daemon's halt sweep.
  vi.restoreAllMocks();
  const groups = new Set([81_001, 81_002, 99_999]);
  const slots = new Set<Slot>([{ id: "81001", name: "T1", cwd: "/tmp" }, { id: "81002", name: "T2", cwd: "/tmp" }]);
  const realSh = git.shGit;
  vi.spyOn(git, "shGit").mockImplementation(async (cmd, cwd, timeout) => cmd.startsWith("ps ")
    ? { code: 0, stdout: cmd.includes("-p ") ? "70000\n" : [...groups].map((g) => `${g} ${g} S`).join("\n"), stderr: "" }
    : realSh(cmd, cwd, timeout));
  vi.spyOn(process, "kill").mockImplementation((pid) => { groups.delete(-pid); return true; });
  const actor = { close: async (slot: Slot) => { expect(await stall.reapOwnedProcessGroup(Number(slot.id), slot.cwd)).toEqual([]); } };
  await Promise.all([...slots].map((slot) => daemon.closeLiveSlot(slots, actor, slot)));
  expect(groups).toEqual(new Set([99_999]));
  expect(slots.size).toBe(0);
  groups.add(81_003);
  vi.mocked(process.kill).mockImplementation(() => true); // signal accepted, process still present
  expect(await stall.reapOwnedProcessGroup(81_003, "/tmp")).toEqual([81_003]);
}, 60_000);

test("test: a fake worker pane saturated past the read window by two thousand rows of test output with no quota text over a flat worktree with its group's cpu unavailable is journaled contact-unreadable naming row-signal-saturated concluding false and is held past the stall window by neither the quota nor the stall leg, harvests the valid trailer it paints afterwards within one poll, and when it paints nothing ends only at the attempt's hard timeout naming the held legs, so a quota or stall reap concluded over a saturated row signal, or a saturated pane that never ends, fails", async () => {
  const live = await scenario({ saturated: true, cpu: "unavailable", trailerAt: STALL * 2 });
  expect(live.summary.done).toEqual(["T1"]);
  expect(live.events.find((e) => e.event === "contact-unreadable" && e.data.reason === "row-signal-saturated")?.data.concludes).toBe(false);
  expect(live.events.some((e) => e.event === "quota-banner" || e.event === "worker-reaped-before-harvest")).toBe(false);
  expect(live.polls - [...live.workers.values()][0]!.painted!).toBeLessThanOrEqual(1);
  const silent = await scenario({ saturated: true, cpu: "unavailable" });
  const timeout = silent.events.find((e) => e.event === "worker-hard-timeout");
  expect(timeout?.data.heldLegs).toEqual(expect.arrayContaining(["quota:row-signal-saturated", "stall:row-signal-saturated"]));
  expect(silent.events.find((e) => e.event === "worker-reaped-before-harvest")?.data.cause).toBe("hard-timeout");
  expect(silent.events.some((e) => e.event === "quota-banner")).toBe(false);
}, 30_000);

test.each(["survivors", "reaper", "driver"] as const)("failed-task cleanup records %s errors without aborting a sibling", async (cleanupFailure) => {
  const result = await scenario({ sibling: true, dispatchError: true, cleanupFailure });
  expect(result.summary.done).toContain("T2");
  expect(loadGraph(result.repo).tasks.find((task) => task.id === "T1")?.status).toBe("failed");
  const failed = result.events.find((event) => event.event === "task-failed" && event.taskId === "T1");
  expect(failed?.data.error).toContain("dispatch transport failure");
  const group = [...result.workers.values()].find((worker) => worker.task === "T1")!.group;
  expect(failed?.data.cleanupErrors).toEqual([{
    slot: expect.stringContaining("T1-worker-"), attempt: 0,
    error: cleanupFailure === "survivors" ? `Error: worker group ${group} survivors: ${group}`
      : cleanupFailure === "reaper" ? "Error: reaper probe failed" : "Error: driver close failed",
  }]);
  if (cleanupFailure === "survivors") {
    expect(result.events.find((event) => event.event === "worker-process-reaped" && event.taskId === "T1")?.data)
      .toMatchObject({ processGroup: group, survivors: [group] });
  }
}, 30_000);
