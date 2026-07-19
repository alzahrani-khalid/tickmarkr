import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, Invocation } from "../../src/adapters/types.js";
import type { Task } from "../../src/graph/schema.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { classifyWorkerResultCause } from "../../src/run/journal.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

function idriver(overrides: Record<string, unknown> = {}): ExecutorDriver {
  const inner = new SubprocessDriver();
  return {
    id: "interactive-fake", interactive: true,
    slot: inner.slot.bind(inner), run: inner.run.bind(inner),
    waitOutput: inner.waitOutput.bind(inner), waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner), notify: inner.notify.bind(inner), close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner), status: async () => "unknown",
    ...overrides,
  } as ExecutorDriver;
}

class MalformedTrailerFake extends FakeAdapter {
  invoke(task: Task, _cwd: string, _a: Assignment, ctx: { promptFile: string }): Invocation {
    const nonce = /TICKMARKR_RESULT_([0-9a-f]+)/.exec(readFileSync(ctx.promptFile, "utf8"))?.[1] ?? "";
    // trailerPattern matches "ok":true, but JSON.parse fails on the truncated summary string
    return { command: `bash -c 'echo TICKMARKR_RESULT_${nonce} {"ok":true, "summary":}'` };
  }
}

describe("classifyWorkerResultCause (OBS-53 unit)", () => {
  test("provider-death when output contains provider-outage signature", () => {
    expect(classifyWorkerResultCause({
      output: "committing…\nUnable to reach the model provider\n",
      ok: false, finished: false, exitCode: null, summary: "worker produced no TICKMARKR_RESULT trailer", timedOut: false,
    })).toBe("provider-death");
  });

  test("stall-timeout when timed out without trailer", () => {
    expect(classifyWorkerResultCause({
      output: "still working…", ok: false, finished: false, exitCode: null,
      summary: "worker produced no TICKMARKR_RESULT trailer", timedOut: true,
    })).toBe("stall-timeout");
  });

  test("malformed-trailer when trailer token present but unparseable", () => {
    expect(classifyWorkerResultCause({
      output: 'TICKMARKR_RESULT_abcd {"ok":true broken', ok: false, finished: true, exitCode: null,
      summary: "unparseable TICKMARKR_RESULT trailer", timedOut: false,
    })).toBe("malformed-trailer");
  });

  test("clean-exit-no-trailer when process exits without trailer", () => {
    expect(classifyWorkerResultCause({
      output: "done\n", ok: false, finished: false, exitCode: 0,
      summary: "worker produced no TICKMARKR_RESULT trailer", timedOut: false,
    })).toBe("clean-exit-no-trailer");
  });
});

describe("worker-result cause journaling (v1.46 T1, zero tokens)", () => {
  test("a dead worker whose output contains a provider-outage signature journals cause provider-death", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: { T1: [{ shell: "echo 'Unable to reach the model provider'; exit 1" }] },
        consult: { action: "human", notes: "stop" },
      },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-prov-death", driver: idriver() });
    const wr = Journal.open(repo, "run-prov-death").read().find((e) => e.event === "worker-result");
    expect(wr?.data.cause).toBe("provider-death");
  }, 30_000);

  test("a stall reap journals cause stall-timeout", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "sleep 999" }] }, consult: { action: "human", notes: "stop" } },
      "taskTimeoutMinutes: 1\n",
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-stall", driver: idriver() });
    const wr = Journal.open(repo, "run-stall").read().find((e) => e.event === "worker-result");
    expect(wr?.data.cause).toBe("stall-timeout");
    // T5: the dispatch banner is a one-time pane-output burst; if it lands after the detector's first
    // read it legitimately resets inactivity detection by one poll slice — the budget must cover it.
  }, 150_000);

  test("a finished worker with an unparseable trailer journals cause malformed-trailer", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { consult: { action: "human", notes: "stop" } },
      "visibility:\n  worker: print\n",
    );
    const fake = new MalformedTrailerFake(scriptPath);
    await runDaemon(repo, { adapters: [fake], runId: "run-malformed", driver: idriver() });
    const wr = Journal.open(repo, "run-malformed").read().find((e) => e.event === "worker-result");
    expect(wr?.data.cause).toBe("malformed-trailer");
  }, 30_000);

  test("a clean exit with no trailer journals cause clean-exit-no-trailer", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "echo done; exit 0" }] }, consult: { action: "human", notes: "stop" } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-clean-exit", driver: idriver() });
    const wr = Journal.open(repo, "run-clean-exit").read().find((e) => e.event === "worker-result");
    expect(wr?.data.cause).toBe("clean-exit-no-trailer");
  }, 30_000);

  test("a provider-death requeues the same assignment without incrementing the attempt counter", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: {
          T1: [
            { shell: "echo 'Unable to reach the model provider'; exit 1" },
            { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "recovered" } },
          ],
        },
      },
      "visibility:\n  worker: print\n", // print mode advances the fake step counter across provider requeues
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-requeue", driver: idriver() });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-requeue").read().filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(evs).toHaveLength(2); // initial + one successful retry, not three
    expect(evs.every((e) => (e.data.assignment as { model: string }).model === "fake-1")).toBe(true);
    const requeues = Journal.open(repo, "run-requeue").read().filter((e) => e.event === "provider-death-requeue");
    expect(requeues).toHaveLength(1);
    expect(requeues[0].data.attempt).toBe(0);
  }, 30_000);

  test("the third consecutive provider-death on one attempt falls through to the normal failure ladder", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: { T1: [{ shell: "echo 'Unable to reach the model provider'; exit 1" }] },
        consult: { action: "human", notes: "infra exhausted" },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-prov-cap", driver: idriver() });
    expect(s.human).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-prov-cap").read();
    const requeues = evs.filter((e) => e.event === "provider-death-requeue");
    expect(requeues).toHaveLength(2);
    expect(evs.some((e) => e.event === "consult-verdict")).toBe(true);
    const dispatches = evs.filter((e) => e.event === "task-dispatch");
    expect(dispatches).toHaveLength(3); // 1 initial + 2 requeues, then consult on 3rd death
    expect(dispatches.every((e) => e.data.attempt === 0)).toBe(true);
  }, 30_000);

  test("a channel with two consecutive no-trailer windows in one run is not selected for later attempts in that run", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: {
          T1: [
            { shell: "echo stall1; exit 0" },
            { shell: "echo stall2; exit 0" },
            { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "on fake-2" } },
          ],
        },
        consult: { action: "retry", notes: "try again" },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-demote", driver: idriver() });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-demote").read();
    expect(evs.some((e) => e.event === "channel-demotion" && e.data.channel === "fake:fake-1")).toBe(true);
    const dispatches = evs.filter((e) => e.event === "task-dispatch");
    const models = dispatches.map((e) => (e.data.assignment as { model: string }).model);
    expect(models[0]).toBe("fake-1");
    expect(models[1]).toBe("fake-1");
    expect(models[2]).toBe("fake-2"); // demoted fake-1 after two no-trailer windows
  }, 30_000);

  test("every failure path still writes a journal event", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "echo stall; exit 0" }] }, consult: { action: "human", notes: "park" } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-journal", driver: idriver() });
    const evs = Journal.open(repo, "run-journal").read();
    expect(evs.filter((e) => e.event === "worker-result")).toHaveLength(1);
    expect(evs.some((e) => e.event === "consult-verdict")).toBe(true);
    expect(evs.some((e) => e.event === "task-human")).toBe(true);
  }, 30_000);
});

describe("OBS-53/OBS-57 citations in source", () => {
  test("OBS-53 is cited at the classification site", async () => {
    const src = readFileSync(new URL("../../src/run/journal.ts", import.meta.url), "utf8");
    expect(src).toMatch(/OBS-53/);
    expect(src).toContain("classifyWorkerResultCause");
  });

  test("OBS-57 is cited at the in-run demotion site", async () => {
    const daemon = readFileSync(new URL("../../src/run/daemon.ts", import.meta.url), "utf8");
    const router = readFileSync(new URL("../../src/route/router.ts", import.meta.url), "utf8");
    expect(daemon).toMatch(/OBS-57/);
    expect(router).toMatch(/OBS-57/);
  });
});
