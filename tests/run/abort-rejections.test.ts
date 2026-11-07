import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { consult, type ConsultInvocation } from "../../src/run/consult.js";
import { runDaemon, setApprovalWindowForTests, resetApprovalWindowForTests } from "../../src/run/daemon.js";
import { ExecutionBudgetExceeded } from "../../src/run/execution-budget.js";
import { gitHead, sh, shell, shGitOk } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { WorkerTreeCpuAccountant } from "../../src/run/stall.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

vi.mock("../../src/run/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/git.js")>();
  return { ...actual, sh: vi.fn(actual.sh), shell: vi.fn(actual.shell) };
});

afterEach(() => {
  resetApprovalWindowForTests();
  vi.restoreAllMocks();
});

test("row 364 r9 worker: exhausting a print worker's budget emits no unhandled rejection and preserves its sibling", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    setApprovalWindowForTests(1);
    const gates = ["build", "test", "lint", "evidence", "scope"];
    const { repo, fake } = setupRepo([T("T1", { gates, files: ["first.txt"] }), T("T2", { gates, files: ["second.txt"] })], {
      tasks: {
        T1: [{ shell: "echo waiting > first.txt; sleep 30", result: { ok: true, summary: "late" } }],
        T2: [{ shell: `sleep 1.1; echo survived > second.txt && ${COMMIT} second`, result: { ok: true, summary: "second done" } }],
      },
    });
    const journal = Journal.create(repo, "run-abort-sibling");
    journal.append("run-start", undefined, { baseRef: await gitHead(repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
      effectivePolicy: { config: { executionPolicy: { boundedInfrastructure: true, taskExecutionLimitMs: 10_000 } } } });
    journal.append("execution-budget-reserved", "T1", { id: "prior", limitMs: 10_000, reservedMs: 9_200 });
    writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    const summary = await runDaemon(repo, { runId: journal.runId, resume: true, concurrency: 2, adapters: [fake], driver: new SubprocessDriver() });
    await nextTurn();
    expect(summary.human).toEqual(["T1"]);
    expect(summary.done).toEqual(["T2"]);
    const rows = journal.read();
    const firstPark = rows.findIndex((e) => e.event === "task-human" && e.taskId === "T1");
    expect(rows[firstPark].data.disposition).toBe("execution-budget-exhausted");
    expect(rows.findIndex((e) => e.event === "worker-launch" && e.taskId === "T1")).toBeGreaterThanOrEqual(0);
    expect(rows.findIndex((e) => e.event === "worker-launch" && e.taskId === "T2")).toBeLessThan(firstPark);
    expect(rows.findIndex((e) => e.event === "task-done" && e.taskId === "T2")).toBeGreaterThan(firstPark);
    expect(await shGitOk(`git show ${summary.branch}:second.txt`, repo)).toContain("survived");
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
}, 30_000);

test("row 364 r9 consult: late abort rejections after both races lose stay handled and the original seat error still surfaces", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    // Exercise the shared sampler rejection and the pending-only rejection independently.
    for (const samplerRejects of [true, false]) {
      const dir = makeTestTempDir("tkr-abort-consult-");
      const { fake } = setupRepo([T("T1")], { tasks: {} });
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.visibility.llm = "headless";
      cfg.consult = { adapter: "fake", model: "fake-1", stallMinutes: 15 };
      const error = new ExecutionBudgetExceeded("T1", "consult late abort");
      const samplerAbort = new AbortController();
      let rejectPending!: (reason: unknown) => void;
      let pendingRejected = false;
      let samples = 0;
      let sleeps = 0;
      const pending = new Promise<Awaited<ReturnType<typeof sh>>>((_resolve, reject) => { rejectPending = reject; });
      vi.mocked(sh).mockImplementationOnce((_cmd, _cwd, _timeout, options) => {
        options?.onSpawn?.(undefined);
        return pending;
      });
      vi.mocked(shell).mockImplementation(async () => {
        samples++;
        samplerAbort.signal.throwIfAborted();
        return { code: 0, stdout: "123 1 123 0:00.00 fixture-unowned\n", stderr: "" };
      });
      const stopped = vi.spyOn(WorkerTreeCpuAccountant.prototype, "stop");
      const invocations: ConsultInvocation[] = [];
      const verdict = await consult({ taskId: "T1", trigger: "gate-fail", journalTail: "", transcript: "", diff: "", gates: [] },
        cfg, [fake], new SubprocessDriver(), dir, dir, {
          onInvocation: (invocation) => invocations.push(invocation),
          time: {
            now: () => Date.now(),
            sleep: async () => {
              if (++sleeps === 1) return; // The first polling race loses before pending rejects.
              if (samplerRejects) samplerAbort.abort(error);
              // Let the real accountant loop reject before cleanup can await it.
              await new Promise((resolve) => setTimeout(resolve, 250));
              pendingRejected = true;
              rejectPending(error);
              await nextTurn();
            },
          },
        });
      await nextTurn();
      expect(sleeps).toBe(2);
      expect(samples).toBeGreaterThanOrEqual(2);
      expect(pendingRejected).toBe(true);
      expect(verdict.action).toBe("human");
      expect(invocations).toEqual([expect.objectContaining({ outcome: "failed", reason: "seat error: T1: consult late abort" })]);
      expect(stopped).toHaveBeenCalledTimes(1);
      if (samplerRejects) await expect(stopped.mock.results[0].value).rejects.toBe(error);
      else await expect(stopped.mock.results[0].value).resolves.toBeUndefined();
      expect(unhandled).not.toHaveBeenCalled();
      stopped.mockRestore();
      vi.mocked(shell).mockReset();
    }
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});
