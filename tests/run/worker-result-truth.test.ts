import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { parseQwenResult } from "../../src/adapters/qwen.js";
import { trailerPattern } from "../../src/adapters/prompt.js";
import { shq, type Assignment, type Invocation, type WorkerResult } from "../../src/adapters/types.js";
import type { Task } from "../../src/graph/schema.js";
import { MAX_BUF, SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName, type ExecutorDriver, type Slot, type SlotOpts } from "../../src/drivers/types.js";
import {
  EARLY_LAUNCH_LIVENESS_MS,
  resetWorkerStartupWindowMsForTests,
  runDaemon,
  setWorkerStartupWindowMsForTests,
  WORKER_STARTUP_WINDOW_MS,
} from "../../src/run/daemon.js";
import { Journal, WORKER_RESULT_CAUSES } from "../../src/run/journal.js";
import { PANE_READ_ROWS } from "../../src/run/stall.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

interface EnvelopeStep {
  shell: string;
  result?: { ok: boolean; summary: string; deviations?: string[] };
  failure?: string;
  prefixBytes?: number;
}

/** A fake execution surface with qwen's real encoded-result contract. */
class EnvelopeFake extends FakeAdapter {
  private workerAttempt = 0;

  constructor(scriptPath: string, private readonly steps: EnvelopeStep[]) {
    super(scriptPath);
  }

  override invoke(_task: Task, _cwd: string, _assignment: Assignment, ctx: { promptFile: string }): Invocation {
    const step = this.steps[Math.min(this.workerAttempt++, this.steps.length - 1)]!;
    const nonce = /TICKMARKR_RESULT_([0-9a-z]+)/.exec(readFileSync(ctx.promptFile, "utf8"))?.[1] ?? "";
    const events = step.failure === undefined
      ? [
          {
            type: "assistant",
            message: {
              content: [{
                type: "text",
                text: `TICKMARKR_RESULT_${nonce} ${JSON.stringify({ deviations: [], ...step.result })}`,
              }],
            },
          },
          { type: "result", subtype: "success", is_error: false },
        ]
      : [{
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          error: { message: step.failure },
        }];
    const prefix = step.prefixBytes
      ? `node -e ${shq(`process.stdout.write("x".repeat(${step.prefixBytes}) + "\\n")`)}; `
      : "";
    return { command: `${step.shell}; ${prefix}printf '%s\\n' ${shq(JSON.stringify(events))}` };
  }

  override parse(output: string, nonce: string): WorkerResult {
    return parseQwenResult(output, nonce);
  }
}

function wrappedDriver(
  inner: SubprocessDriver,
  overrides: Partial<ExecutorDriver> = {},
): ExecutorDriver {
  return {
    id: "worker-result-truth",
    interactive: false,
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    status: inner.status.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
    ...overrides,
  };
}

afterEach(() => resetWorkerStartupWindowMsForTests());

test("test: a worker whose trailer arrives inside a JSON envelope the adapter decodes journals worker-result finished true with no cause and no harvest row and names the on-disk stream file in its stream field whereas a daemon that waits on the raw stream alone narrates no-trailer beside a parsed trailer", async () => {
  const { repo, scriptPath } = setupRepo([T("T1")], { tasks: {} }, "visibility:\n  worker: print\n");
  const adapter = new EnvelopeFake(scriptPath, [{
    shell: `echo decoded > decoded.txt && ${COMMIT} decoded`,
    result: { ok: true, summary: "decoded from envelope" },
    prefixBytes: MAX_BUF + 4_096,
  }]);
  const inner = new SubprocessDriver();
  const readDepths: number[] = [];
  const driver = wrappedDriver(inner, {
    read(slot, lines) {
      readDepths.push(lines);
      return inner.read(slot, lines);
    },
  });

  const summary = await runDaemon(repo, { adapters: [adapter], runId: "run-envelope-finished", driver });
  expect(summary.done).toEqual(["T1"]);
  const events = Journal.open(repo, "run-envelope-finished").read();
  const result = events.find((event) => event.event === "worker-result")!;
  expect(result.data).toMatchObject({ ok: true, finished: true, summary: "decoded from envelope", stream: "prompts/T1-a0.out" });
  expect(result.data.cause).toBeUndefined();
  expect(events.filter((event) => event.event === "worker-result-harvested")).toEqual([]);

  const streamPath = join(Journal.open(repo, "run-envelope-finished").dir, String(result.data.stream));
  expect(existsSync(streamPath)).toBe(true);
  expect(statSync(streamPath).size).toBeLessThanOrEqual(MAX_BUF);
  const stream = readFileSync(streamPath, "utf8");
  expect(parseQwenResult(stream, /TICKMARKR_RESULT_([0-9a-z]+)/.exec(stream)?.[1] ?? "").ok).toBe(true);
  expect(new RegExp(trailerPattern(/TICKMARKR_RESULT_([0-9a-z]+)/.exec(stream)?.[1] ?? "")).test(stream)).toBe(false);
  expect(JSON.stringify(events)).not.toContain("transcript");
  expect(Math.max(...readDepths)).toBe(PANE_READ_ROWS);

  // The persisted/parsed capture is wider than the classifier tail. A provider phrase outside the
  // latter must remain evidence on disk without rerouting a committed no-trailer harvest.
  const scoped = setupRepo([T("T1")], { tasks: { T1: [{
    shell: `node -e ${shq('console.log("Unable to reach the model provider"); for (let i = 0; i < 600; i++) console.log(`ordinary line ${i}`)')} && echo scoped > scoped.txt && ${COMMIT} scoped`,
  }] } }, "visibility:\n  worker: print\n");
  const scopedSummary = await runDaemon(scoped.repo, { adapters: [scoped.fake], runId: "run-bounded-classifiers" });
  expect(scopedSummary.done).toEqual(["T1"]);
  const scopedEvents = Journal.open(scoped.repo, "run-bounded-classifiers").read();
  expect(scopedEvents.some((event) => event.event === "provider-death-requeue")).toBe(false);
  expect(scopedEvents.some((event) => event.event === "dead-channel-failover")).toBe(false);
}, 30_000);

test("test: a worker whose envelope decodes to a no-auth API failure journals worker-result cause startup-failure and reroutes without a repair charge while the recovered attempt merges whereas a daemon that reads only its own banner detector journals clean-exit-no-trailer", async () => {
  const { repo, scriptPath } = setupRepo([T("T1")], { tasks: {} }, "visibility:\n  worker: print\n");
  const adapter = new EnvelopeFake(scriptPath, [
    { shell: "true", failure: "No auth type is selected. Configure an auth type before non-interactive use." },
    { shell: `echo recovered > recovered.txt && ${COMMIT} recovered`, result: { ok: true, summary: "recovered" } },
  ]);

  const summary = await runDaemon(repo, { adapters: [adapter], runId: "run-envelope-auth" });
  expect(summary.done).toEqual(["T1"]);
  const journal = Journal.open(repo, "run-envelope-auth");
  const events = journal.read();
  const results = events.filter((event) => event.event === "worker-result");
  expect(results[0]!.data).toMatchObject({ ok: false, finished: false, cause: "startup-failure", stream: "prompts/T1-a0.out" });
  expect(results[1]!.data).toMatchObject({ ok: true, finished: true, summary: "recovered", stream: "prompts/T1-a1.out" });
  expect(existsSync(join(journal.dir, "prompts/T1-a0.out"))).toBe(true);
  expect(existsSync(join(journal.dir, "prompts/T1-a1.out"))).toBe(true);
  expect(events.filter((event) => event.event === "task-dispatch").map((event) => event.data.attempt)).toEqual([0, 0]);
  expect(events.filter((event) => event.event === "repair-attempt" || event.event === "escalation" || event.event === "consult-verdict")).toEqual([]);
  expect(journal.readTelemetry().find((row) => row.taskId === "T1")?.attempts).toBe(1);
  expect(events.some((event) => event.event === "merge" && event.taskId === "T1")).toBe(true);
}, 30_000);

test("test: a stall-timeout harvest reaps the still-running worker before it reads the tree so a commit the worker would have made two seconds later never lands and the journal carries one worker-reaped-before-harvest row and no tip-moved row whereas a harvest that reads the tree with the worker alive fails", async () => {
  const { repo, fake } = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `echo first > late.txt && ${COMMIT} first && sleep 2 && echo late >> late.txt && ${COMMIT} late` }] } },
    "taskTimeoutMinutes: 0.01\nvisibility:\n  worker: print\n",
  );
  const inner = new SubprocessDriver();
  const driver = wrappedDriver(inner);

  const summary = await runDaemon(repo, { adapters: [fake], runId: "run-reap-before-harvest", driver });
  expect(summary.done).toEqual(["T1"]);
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  expect(execSync(`git show ${shq(summary.branch)}:late.txt`, { cwd: repo, encoding: "utf8" })).toBe("first\n");
  const events = Journal.open(repo, "run-reap-before-harvest").read();
  const reaped = events.filter((event) => event.event === "worker-reaped-before-harvest");
  expect(reaped).toHaveLength(1);
  expect(events.filter((event) => event.event === "tip-moved")).toEqual([]);
  expect(events.findIndex((event) => event.event === "worker-reaped-before-harvest"))
    .toBeLessThan(events.findIndex((event) => event.event === "worker-result-harvested"));
}, 30_000);

test("test: a worker whose driver cannot stop it at harvest parks stall naming the failure instead of gating a moving tip and a task's second dispatch sweeps its first attempt's pane before the new worker launches whereas a daemon that gates the unstopped tree or leaves the superseded pane until task-done fails", async () => {
  const stuck = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `echo first > partial.txt && ${COMMIT} partial && sleep 30` }] } },
    "taskTimeoutMinutes: 0.005\nvisibility:\n  worker: print\n",
  );
  const stuckInner = new SubprocessDriver();
  const stuckSlots: Slot[] = [];
  const stuckDriver = wrappedDriver(stuckInner, {
    async slot(cwd: string, name: string, opts?: SlotOpts) {
      const slot = await stuckInner.slot(cwd, name, opts);
      stuckSlots.push(slot);
      return slot;
    },
    async close(slot: Slot) {
      if (slot.name.includes("-worker-")) throw new Error("driver refused to stop worker");
      return stuckInner.close(slot);
    },
  });
  try {
    const summary = await runDaemon(stuck.repo, { adapters: [stuck.fake], runId: "run-unstoppable-harvest", driver: stuckDriver });
    expect(summary.human).toEqual(["T1"]);
    const events = Journal.open(stuck.repo, "run-unstoppable-harvest").read();
    expect(events.find((event) => event.event === "task-human")?.data).toMatchObject({ kind: "stall" });
    expect(String(events.find((event) => event.event === "task-human")?.data.reason)).toContain("driver refused to stop worker");
    expect(events.some((event) => event.event === "phase-start" && event.data.phase === "gates")).toBe(false);
    expect(events.some((event) => event.event === "tip-moved")).toBe(false);
  } finally {
    for (const slot of stuckSlots) await stuckInner.close(slot);
  }

  const retry = setupRepo([T("T1")], { tasks: { T1: [
    { shell: "true", result: { ok: true, summary: "claimed without a commit" } },
    { shell: `echo fixed > fixed.txt && ${COMMIT} fixed`, result: { ok: true, summary: "fixed" } },
  ] } });
  const retryInner = new SubprocessDriver();
  const operations: string[] = [];
  const retryDriver = wrappedDriver(retryInner, {
    async slot(cwd: string, name: string, opts?: SlotOpts) {
      const slot = await retryInner.slot(cwd, name, opts);
      operations.push(`slot:${opts?.owned ? formatOwnedName(opts.owned) : name}`);
      return slot;
    },
    async close(slot: Slot) {
      operations.push(`close:${slot.name}`);
      return retryInner.close(slot);
    },
  });
  const retried = await runDaemon(retry.repo, { adapters: [retry.fake], runId: "run-sweep-before-redispatch", driver: retryDriver });
  expect(retried.done).toEqual(["T1"]);
  const closeFirst = operations.findIndex((operation) => operation.startsWith("close:") && operation.includes("-a0-"));
  const launchSecond = operations.findIndex((operation) => operation.startsWith("slot:") && operation.includes(":1:run-sweep-before-redispatch"));
  expect(closeFirst).toBeGreaterThanOrEqual(0);
  expect(launchSecond).toBeGreaterThanOrEqual(0);
  expect(closeFirst).toBeLessThan(launchSecond);
}, 30_000);

test("test: a model-not-found banner that first appears after the startup window concludes nothing while the same banner inside the window concludes startup-failure within one poll and the worker-result causes vocabulary lists startup-failure beside the five prior causes whereas a detector that reads every slice or a vocabulary without the word fails", async () => {
  setWorkerStartupWindowMsForTests(100);
  const late = setupRepo(
    [T("T1")],
    { tasks: { T1: [{
      shell: `echo working; sleep 0.3; echo 'model-not-found appears in a late diagnostic'; sleep 0.3; echo late-ok > late-ok.txt && ${COMMIT} late`,
      result: { ok: true, summary: "late banner was ordinary output" },
    }] } },
    "taskTimeoutMinutes: 0.05\nvisibility:\n  worker: print\n",
  );
  const lateInner = new SubprocessDriver();
  const lateDriver = wrappedDriver(lateInner, {
    waitOutput: (slot, pattern, timeoutMs, opts) => lateInner.waitOutput(slot, pattern, Math.min(timeoutMs, 50), opts),
  });
  const lateSummary = await runDaemon(late.repo, { adapters: [late.fake], runId: "run-late-startup-banner", driver: lateDriver });
  expect(lateSummary.done).toEqual(["T1"]);
  const lateEvents = Journal.open(late.repo, "run-late-startup-banner").read();
  expect(lateEvents.find((event) => event.event === "worker-result")?.data.cause).toBeUndefined();
  expect(lateEvents.some((event) => event.event === "dead-channel-failover")).toBe(false);

  setWorkerStartupWindowMsForTests(500);
  const early = setupRepo(
    [T("T1")],
    { tasks: { T1: [
      { shell: "echo 'requested model deployment was not found (404)'; sleep 30" },
      { shell: `echo early-ok > early-ok.txt && ${COMMIT} early`, result: { ok: true, summary: "recovered" } },
    ] } },
    "taskTimeoutMinutes: 0.05\nvisibility:\n  worker: print\n",
  );
  const earlyInner = new SubprocessDriver();
  let firstAttemptPolls = 0;
  let firstAttemptActive = true;
  let firstLaunch = true;
  const earlyDriver = wrappedDriver(earlyInner, {
    async run(slot, command) {
      // Prompt/slot/readiness work may outlast a short test window before the worker launches.
      if (firstLaunch && slot.name.includes("-worker-")) {
        firstLaunch = false;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      return earlyInner.run(slot, command);
    },
    waitOutput: (slot, pattern, timeoutMs, opts) => {
      if (firstAttemptActive && slot.name.includes("-worker-")) firstAttemptPolls++;
      return earlyInner.waitOutput(slot, pattern, Math.min(timeoutMs, 50), opts);
    },
    close: async (slot) => {
      if (slot.name.includes("-worker-")) firstAttemptActive = false;
      return earlyInner.close(slot);
    },
  });
  const earlySummary = await runDaemon(early.repo, { adapters: [early.fake], runId: "run-early-startup-banner", driver: earlyDriver });
  expect(earlySummary.done).toEqual(["T1"]);
  expect(firstAttemptPolls).toBeLessThanOrEqual(1);
  expect(Journal.open(early.repo, "run-early-startup-banner").read()
    .find((event) => event.event === "worker-result")?.data.cause).toBe("startup-failure");
  expect(WORKER_STARTUP_WINDOW_MS).toBeGreaterThanOrEqual(EARLY_LAUNCH_LIVENESS_MS);
  expect(WORKER_RESULT_CAUSES).toEqual([
    "provider-death", "dead-channel", "stall-timeout", "malformed-trailer", "clean-exit-no-trailer", "startup-failure",
  ]);
}, 30_000);
