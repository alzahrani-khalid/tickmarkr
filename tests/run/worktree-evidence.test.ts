import { execSync } from "node:child_process";
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import {
  NUDGEABLE_ADAPTERS,
  resetDeadChannelFastKillMsForTests,
  resetHarvestCpuFlatMsForTests,
  resetHarvestSilentMsForTests,
  resetNudgeTimingForTests,
  resetObserveBudgetBytesForTests,
  runDaemon,
  setDeadChannelFastKillMsForTests,
  setHarvestCpuFlatMsForTests,
  setHarvestSilentMsForTests,
  setNudgeTimingForTests,
  setObserveBudgetBytesForTests,
} from "../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

// OBS-548: the fast-kill now has a CPU leg, so every case that asserts a kill (or its absence)
// needs a reading it did not have to negotiate with the host for. `ps` is denied outright in the
// managed macOS sandbox and merely noisy everywhere else, and neither is this file's question —
// these cases discriminate on WORKTREE evidence and nudge delivery, with CPU held constant. One
// unrelated row: the marker matches nothing, so the worker tree is empty and reads a flat zero,
// which is the probe's documented "nothing of this worker is running". Installed for EVERY case in
// the file (review: a fixture applied only where it was newly needed leaves its siblings
// host-dependent), so no case can pass merely because this host could not answer `ps`.
let cpuProbeCalls = (): number => 0;
function flatCpuProbe(): () => void {
  const dir = makeTestTempDir("tickmarkr-ps-flat-");
  const bashEnv = join(dir, "bash-env");
  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  writeFileSync(bashEnv, "ps() { printf x >> \"$TICKMARKR_TEST_PS_CALLS\"; echo '1 1 0:00.00 unrelated-process'; }\n");
  const prior = { bashEnv: process.env.BASH_ENV, calls: process.env.TICKMARKR_TEST_PS_CALLS };
  process.env.BASH_ENV = bashEnv;
  process.env.TICKMARKR_TEST_PS_CALLS = calls;
  cpuProbeCalls = () => readFileSync(calls, "utf8").length;
  return () => {
    if (prior.bashEnv === undefined) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = prior.bashEnv;
    if (prior.calls === undefined) delete process.env.TICKMARKR_TEST_PS_CALLS;
    else process.env.TICKMARKR_TEST_PS_CALLS = prior.calls;
    cpuProbeCalls = () => 0;
  };
}

// OBS-607: the fast-kill cannot conclude inside ONE poll slice — slice one arms the CPU
// accountant (which reads `cpu-accruing`, never flat) and only slice two can read it flat. A slice
// is pinned to stallWindowMs/2 (daemon.ts:2300), so a two-slice verdict costs the WHOLE window and
// the only slack is whatever is left of the first half after slice one's own work: four `git`
// observation spawns, the accountant's start, a `ps` snapshot, a status read and a pane read.
// Measured on an idle host, the verdict lands at 391ms of a 360ms window with the accountant armed
// at 218ms — 142ms of slack for six process spawns. Under the suite's fork pressure that slack is
// spent, slice two never starts, and the control reports "expected [] to have a length of 1" as if
// the daemon had refused to kill a dead channel. 0.02min holds the same two-slice shape with ~560ms
// of slack (measured: armed 639ms, verdict 1234ms). The DISCRIMINATORS are untouched — the kill
// still fires at 60ms of silence against a 50ms flat-CPU window, both far below this window — so a
// change in the daemon's verdict still fails here; only the room to reach the verdict grew.
const FAST_KILL_WINDOW_MINUTES = 0.02;

const STALLED = {
  consult: { action: "human", notes: "controlled stalled worker" },
  tasks: { T1: [{ shell: "echo working-on-it; sleep 5" }] },
};

type TreeSetup = (worktree: string, repo: string) => void;
type TreeAction = (worktree: string) => void;

function evidenceDriver(options: {
  setup?: TreeSetup;
  actAfterLaunch?: TreeAction;
  nudge?: (slot: Slot) => Promise<boolean>;
} = {}): ExecutorDriver {
  const inner = new SubprocessDriver();
  let acted = false;
  return {
    id: "worktree-evidence-fake",
    interactive: true,
    slot: inner.slot.bind(inner),
    async run(slot, command) {
      await inner.run(slot, command);
      if (!acted && options.actAfterLaunch) {
        acted = true;
        options.actAfterLaunch(slot.cwd);
      }
    },
    waitOutput: async (_slot, _pattern, timeoutMs) => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      return false;
    },
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: async () => "working-on-it",
    notify: async () => {},
    close: inner.close.bind(inner),
    async worktree(repo, branch, base) {
      const worktree = await inner.worktree(repo, branch, base);
      options.setup?.(worktree, repo);
      return worktree;
    },
    status: async () => "working",
    ...(options.nudge ? { nudge: options.nudge } : {}),
  };
}

const eventsOf = (repo: string, runId: string): JournalEvent[] => Journal.open(repo, runId).read();
const taskEventTime = (events: JournalEvent[], event: string): number =>
  Date.parse(events.find((row) => row.event === event && row.taskId === "T1")!.ts);

// OBS-607: the two control cases below assert that a readable, UNCHANGED tree is journaled
// worker-dead. Two of the kill's four legs are SUBPROCESS readings — the tree observation (four
// `git` spawns per slice) and the CPU accountant (a `ps` snapshot per sample) — and under the
// suite's own fork pressure either can fail to spawn (EAGAIN). The daemon then stands down
// FAIL-CLOSED and names the reason: an unreadable tree is not an unchanged one, and unmeasurable
// CPU is not a resting worker. Both stand-downs leave the control with NO worker-dead — byte for
// byte the empty array a genuine regression leaves — so the premise is asserted first and the two
// can never again be confused. `cpu-accruing` is the ordinary first-slice reading (the accountant
// has just been armed and has not yet proven flat), not a stand-down.
const infraStandDowns = (events: JournalEvent[]): string[] => events
  .filter((row) => row.taskId === "T1"
    && (row.event === "contact-unreadable"
      || (row.event === "worker-dead-held" && (row.data as { reason?: string }).reason !== "cpu-accruing")))
  .map((row) => (row.data as { reason?: string }).reason ?? row.event);
const PREMISE = "the fast-kill stood down on an unreadable or unmeasurable probe: this repetition never "
  + "observed the tree it is asserting about, so this is a spawn/resource failure, NOT the invariant";

let restoreCpuProbe: () => void = () => {};
beforeEach(() => { restoreCpuProbe = flatCpuProbe(); });

afterEach(() => {
  restoreCpuProbe();
  NUDGEABLE_ADAPTERS.delete("fake");
  resetDeadChannelFastKillMsForTests();
  resetHarvestCpuFlatMsForTests();
  resetHarvestSilentMsForTests();
  resetNudgeTimingForTests();
  resetObserveBudgetBytesForTests();
});

test("the observation runDaemon makes of a worker worktree differs between two reads for a content swap between two untracked files, a chmod +x on an untracked file, an edit inside an already-untracked file, and a git add of a modified tracked file, and is identical across two reads of an untouched tree, so a signature missing path identity, mode, untracked content or index state cannot pass", async () => {
  setDeadChannelFastKillMsForTests(60);
  setHarvestCpuFlatMsForTests(50); // the kill's CPU leg, pinned: this case discriminates on the TREE

  const run = async (name: string, setup: TreeSetup, act?: TreeAction) => {
    const runId = `run-worktree-signature-${name}`;
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: FAST_KILL_WINDOW_MINUTES })], STALLED);
    await runDaemon(repo, {
      adapters: [fake],
      runId,
      driver: evidenceDriver({ setup, actAfterLaunch: act }),
    });
    return eventsOf(repo, runId);
  };

  const swap = await run(
    "swap",
    (worktree) => {
      writeFileSync(join(worktree, "left.txt"), "left\n");
      writeFileSync(join(worktree, "right.txt"), "rght\n");
    },
    (worktree) => {
      const left = readFileSync(join(worktree, "left.txt"));
      const right = readFileSync(join(worktree, "right.txt"));
      writeFileSync(join(worktree, "left.txt"), right);
      writeFileSync(join(worktree, "right.txt"), left);
    },
  );
  const chmod = await run(
    "chmod",
    (worktree) => writeFileSync(join(worktree, "script.sh"), "exit 0\n", { mode: 0o644 }),
    (worktree) => chmodSync(join(worktree, "script.sh"), 0o755),
  );
  const untrackedEdit = await run(
    "untracked-edit",
    (worktree) => writeFileSync(join(worktree, "scratch.txt"), "aaaa\n"),
    (worktree) => writeFileSync(join(worktree, "scratch.txt"), "bbbb\n"),
  );
  const staged = await run(
    "staged",
    (worktree) => writeFileSync(join(worktree, "base.txt"), "modified but unstaged\n"),
    (worktree) => execSync("git add -- base.txt", { cwd: worktree }),
  );
  const untouched = await run(
    "untouched",
    (worktree) => {
      writeFileSync(join(worktree, "left.txt"), "left\n");
      writeFileSync(join(worktree, "right.txt"), "rght\n");
    },
  );

  for (const [name, events] of Object.entries({ swap, chmod, untrackedEdit, staged })) {
    expect(events.some((row) => row.event === "worker-contact" && row.data.evidence === "worktree"), name).toBe(true);
    expect(events.some((row) => row.event === "worker-dead" && row.taskId === "T1"), name).toBe(false);
  }
  expect(untouched.some((row) => row.event === "worker-contact" && row.data.evidence === "worktree")).toBe(false);
  expect(infraStandDowns(untouched), PREMISE).toEqual([]);
  expect(untouched.filter((row) => row.event === "worker-dead" && row.taskId === "T1")).toHaveLength(1);
}, 60_000);

test("an observation runDaemon cannot complete is recorded unreadable and never unchanged, exercised with an unreadable path inside the worktree, a symlink whose target lies outside it, and a tree exceeding the observation's own read budget, against a genuinely unchanged tree of the same shape, where all three survive the fast-kill window and only the unchanged one is journaled worker-dead", async () => {
  setDeadChannelFastKillMsForTests(60);
  setHarvestCpuFlatMsForTests(50); // as above: CPU held flat so the READABILITY of the tree is the variable

  const run = async (name: string, setup: TreeSetup, budget?: number) => {
    resetObserveBudgetBytesForTests();
    if (budget !== undefined) setObserveBudgetBytesForTests(budget);
    const runId = `run-worktree-unreadable-${name}`;
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: FAST_KILL_WINDOW_MINUTES })], STALLED);
    await runDaemon(repo, { adapters: [fake], runId, driver: evidenceDriver({ setup }) });
    return eventsOf(repo, runId);
  };

  const unreadablePath = await run("mode", (worktree) => {
    const path = join(worktree, "sealed.bin");
    writeFileSync(path, "sealed\n");
    chmodSync(path, 0o000);
  });
  const outsideSymlink = await run("outside-link", (worktree, repo) => {
    symlinkSync(join(repo, "base.txt"), join(worktree, "outside.link"));
  });
  const overBudget = await run(
    "budget",
    (worktree) => writeFileSync(join(worktree, "artifact.bin"), Buffer.alloc(4_096, 0x61)),
    1_024,
  );
  const unchanged = await run(
    "unchanged",
    (worktree) => writeFileSync(join(worktree, "artifact.bin"), Buffer.alloc(4_096, 0x61)),
  );

  for (const [name, events] of Object.entries({ unreadablePath, outsideSymlink, overBudget })) {
    expect(events.some((row) => row.event === "contact-unreadable" && row.data.source === "worktree"), name).toBe(true);
    expect(events.some((row) => row.event === "worker-dead" && row.taskId === "T1"), name).toBe(false);
    expect(taskEventTime(events, "worker-result") - taskEventTime(events, "worker-launch"), name).toBeGreaterThan(250);
  }
  expect(unchanged.some((row) => row.event === "contact-unreadable")).toBe(false);
  expect(infraStandDowns(unchanged), PREMISE).toEqual([]);
  expect(unchanged.filter((row) => row.event === "worker-dead" && row.taskId === "T1")).toHaveLength(1);
}, 60_000);

test("a worktree change runDaemon detects rearms the stall window and not only the journal, with a stall window shorter than the nudge grace a worker whose tree changes once just before the old deadline is concluded only at a new deadline measured from that change, while the identical worker whose tree never changes is concluded at the old deadline, so a contact row written without moving the progress clock fails", async () => {
  NUDGEABLE_ADAPTERS.add("fake");
  setNudgeTimingForTests(100, 1_000);
  setDeadChannelFastKillMsForTests(5_000);

  const run = async (changed: boolean) => {
    const runId = `run-worktree-rearm-${changed ? "changed" : "unchanged"}`;
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.01 })], STALLED);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await runDaemon(repo, {
        adapters: [fake],
        runId,
        driver: evidenceDriver({
          nudge: async (slot) => {
            if (changed && timer === undefined) {
              timer = setTimeout(() => writeFileSync(join(slot.cwd, "late.txt"), "late change\n"), 220);
            }
            return true;
          },
        }),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    return eventsOf(repo, runId);
  };

  const unchanged = await run(false);
  const changed = await run(true);
  // OBS-688: the premise, asserted BEFORE the first subtraction and not after it. Two of this
  // case's legs are subprocess readings, and a refused spawn makes the daemon stand down
  // fail-closed — leaving no worker-result/worker-contact row at all, so `taskEventTime` would
  // throw an anonymous type error off `undefined.ts` and bury an infrastructure failure as a
  // nameless crash. The sibling cases above were guarded and this one was missed; a guard placed
  // after the arithmetic is already too late, because the throw has happened.
  expect(infraStandDowns(unchanged), PREMISE).toEqual([]);
  expect(infraStandDowns(changed), PREMISE).toEqual([]);
  const unchangedDuration = taskEventTime(unchanged, "worker-result") - taskEventTime(unchanged, "worker-launch");
  const changedContact = taskEventTime(changed, "worker-contact");
  const changedEnd = taskEventTime(changed, "worker-result");

  expect(unchangedDuration).toBeGreaterThanOrEqual(500);
  expect(unchangedDuration).toBeLessThan(1_000);
  expect(changedContact - taskEventTime(changed, "worker-launch")).toBeGreaterThanOrEqual(450);
  expect(changedEnd - changedContact).toBeGreaterThanOrEqual(500);
  expect(changedEnd - taskEventTime(changed, "worker-launch")).toBeGreaterThan(unchangedDuration + 400);
}, 30_000);

test("with every worker-side input held constant, the same worktree delta, the same pane frames and a status held at working, runDaemon reaches the identical survive-or-die decision whether the nudge was delivered and unanswered or failed both delivery attempts, while the failed-delivery row is journaled only in the second, so a delivery outcome standing in for worktree evidence fails", async () => {
  NUDGEABLE_ADAPTERS.add("fake");
  setNudgeTimingForTests(80, 200);
  setDeadChannelFastKillMsForTests(100);

  const run = async (delivered: boolean) => {
    const runId = `run-worktree-delivery-${delivered ? "delivered" : "failed"}`;
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.008 })], STALLED);
    let nudgeCalls = 0;
    const summary = await runDaemon(repo, {
      adapters: [fake],
      runId,
      driver: evidenceDriver({
        actAfterLaunch: (worktree) => writeFileSync(join(worktree, "worker-delta.txt"), "same delta\n"),
        nudge: async () => { nudgeCalls++; return delivered; },
      }),
    });
    return { summary, events: eventsOf(repo, runId), nudgeCalls };
  };

  const delivered = await run(true);
  const failed = await run(false);
  const died = (events: JournalEvent[]) => events.some((row) => row.event === "worker-dead" && row.taskId === "T1");
  const deliveryFailed = (events: JournalEvent[]) => events.filter((row) => row.event === "worker-nudge-failed" && row.taskId === "T1");

  expect(delivered.summary.human).toEqual(["T1"]);
  expect(failed.summary.human).toEqual(delivered.summary.human);
  expect(died(delivered.events)).toBe(false);
  expect(died(failed.events)).toBe(died(delivered.events));
  expect(delivered.events.some((row) => row.event === "worker-contact" && row.data.evidence === "worktree")).toBe(true);
  expect(failed.events.some((row) => row.event === "worker-contact" && row.data.evidence === "worktree")).toBe(true);
  expect(deliveryFailed(delivered.events)).toHaveLength(0);
  expect(deliveryFailed(failed.events)).toHaveLength(1);
  expect(delivered.nudgeCalls).toBe(1);
  expect(failed.nudgeCalls).toBe(2);
}, 30_000);

// OBS-548: the nudge inversion, and it is what set the timing of the measured false death — the
// kill fired 2.2 seconds after `worker-nudge-failed`. `nudgeFailed` LIFTED the hold, so a delivery
// failure was the trigger; and the population that cannot accept a nudge (a worker inside one long
// foreground command has no input box) is exactly the population most likely to be legitimately
// silent. The hold is on the daemon still having an ACTION to take, and an undelivered action is
// still owed. What must NOT change is the pane nobody was ever going to steer: a non-nudgeable
// adapter has no hold to lift, so its flat evidence legs conclude exactly as before.
test("test: an undeliverable nudge leaves the fast-kill and harvest holds standing while a non-nudgeable pane whose evidence legs are all flat still concludes; a delivery failure that lifts either hold fails", async () => {
  setNudgeTimingForTests(80, 200); // nudge gate below the kill window: the nudge always gets first crack
  setDeadChannelFastKillMsForTests(300);
  setHarvestSilentMsForTests(150);
  setHarvestCpuFlatMsForTests(50);
  // one committing worker for the harvest hold, one silent worker for the fast-kill hold
  const COMMITTED = {
    consult: { action: "human", notes: "controlled committed worker" },
    tasks: { T1: [{ shell: `echo carried > carried.txt && ${COMMIT} carried` }] },
  };

  const run = async (name: string, config: typeof STALLED, nudgeable: boolean) => {
    const runId = `run-nudge-hold-${name}`;
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.08 })], config);
    let nudgeCalls = 0;
    if (nudgeable) NUDGEABLE_ADAPTERS.add("fake"); else NUDGEABLE_ADAPTERS.delete("fake");
    const cpuCallsBefore = cpuProbeCalls();
    try {
      await runDaemon(repo, {
        adapters: [fake],
        runId,
        driver: evidenceDriver(nudgeable ? { nudge: async () => { nudgeCalls++; return false; } } : {}),
      });
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
    }
    return { events: eventsOf(repo, runId), nudgeCalls, cpuCalls: cpuProbeCalls() - cpuCallsBefore };
  };

  const killHeld = await run("kill-undeliverable", STALLED, true);
  const killConcludes = await run("kill-nonnudgeable", STALLED, false);
  const harvestHeld = await run("harvest-undeliverable", COMMITTED, true);
  const harvestConcludes = await run("harvest-nonnudgeable", COMMITTED, false);

  const rows = (r: { events: JournalEvent[] }, event: string) =>
    r.events.filter((row) => row.event === event && row.taskId === "T1");

  // the delivery really did fail, twice, in both nudgeable runs — the latch under test is armed
  expect(killHeld.nudgeCalls).toBe(2);
  expect(harvestHeld.nudgeCalls).toBe(2);
  expect(rows(killHeld, "worker-nudge-failed")).toHaveLength(1);
  expect(rows(harvestHeld, "worker-nudge-failed")).toHaveLength(1);
  expect(rows(killHeld, "worker-nudge")).toHaveLength(0);

  // both holds stand: the failure is a delivery outcome, never proof the channel is dead
  expect(rows(killHeld, "worker-dead")).toHaveLength(0);
  expect(rows(harvestHeld, "worker-harvest")).toHaveLength(0);
  // A hold gates the shared instrument too: neither reader is eligible, so a long held window
  // must not fork the accountant's shell + ps sampler ten times a second for no possible reader.
  expect(killHeld.cpuCalls).toBe(0);
  expect(harvestHeld.cpuCalls).toBe(0);
  // and holding costs only the window, never the work — the trailer-less tail still gates the commits
  expect(rows(harvestHeld, "worker-result-harvested")).toHaveLength(1);

  // the pane that was never nudgeable has no hold to lift and concludes on the same flat legs
  expect(killConcludes.cpuCalls).toBeGreaterThan(0);
  expect(harvestConcludes.cpuCalls).toBeGreaterThan(0);
  expect(rows(killConcludes, "worker-dead")).toHaveLength(1);
  expect(rows(killConcludes, "worker-nudge-failed")).toHaveLength(0);
  expect(rows(harvestConcludes, "worker-harvest")).toHaveLength(1);
  expect(rows(harvestConcludes, "worker-harvest")[0]!.data.commits).toBe(1);
}, 120_000);
