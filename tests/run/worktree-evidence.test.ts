import { execSync } from "node:child_process";
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import {
  NUDGEABLE_ADAPTERS,
  resetDeadChannelFastKillMsForTests,
  resetNudgeTimingForTests,
  resetObserveBudgetBytesForTests,
  runDaemon,
  setDeadChannelFastKillMsForTests,
  setNudgeTimingForTests,
  setObserveBudgetBytesForTests,
} from "../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

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

afterEach(() => {
  NUDGEABLE_ADAPTERS.delete("fake");
  resetDeadChannelFastKillMsForTests();
  resetNudgeTimingForTests();
  resetObserveBudgetBytesForTests();
});

test("the observation runDaemon makes of a worker worktree differs between two reads for a content swap between two untracked files, a chmod +x on an untracked file, an edit inside an already-untracked file, and a git add of a modified tracked file, and is identical across two reads of an untouched tree, so a signature missing path identity, mode, untracked content or index state cannot pass", async () => {
  setDeadChannelFastKillMsForTests(60);

  const run = async (name: string, setup: TreeSetup, act?: TreeAction) => {
    const runId = `run-worktree-signature-${name}`;
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.006 })], STALLED);
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
  expect(untouched.filter((row) => row.event === "worker-dead" && row.taskId === "T1")).toHaveLength(1);
}, 30_000);

test("an observation runDaemon cannot complete is recorded unreadable and never unchanged, exercised with an unreadable path inside the worktree, a symlink whose target lies outside it, and a tree exceeding the observation's own read budget, against a genuinely unchanged tree of the same shape, where all three survive the fast-kill window and only the unchanged one is journaled worker-dead", async () => {
  setDeadChannelFastKillMsForTests(60);

  const run = async (name: string, setup: TreeSetup, budget?: number) => {
    resetObserveBudgetBytesForTests();
    if (budget !== undefined) setObserveBudgetBytesForTests(budget);
    const runId = `run-worktree-unreadable-${name}`;
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.006 })], STALLED);
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
  expect(unchanged.filter((row) => row.event === "worker-dead" && row.taskId === "T1")).toHaveLength(1);
}, 30_000);

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
