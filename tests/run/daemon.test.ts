import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { kimiSessionId } from "../../src/adapters/kimi.js";
import { type BillingChannel, shq } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { renderMarkdownRecord } from "../../src/cli/commands/report.js";
import { DEFAULT_CONFIG, TIER_RANK, type Tier } from "../../src/config/config.js";
import { DeliveryReadinessError } from "../../src/drivers/herdr.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName, type ExecutorDriver, type Slot } from "../../src/drivers/types.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { extractPromptNonce, gatePaneName } from "../../src/gates/llm.js";
import { graphDefinitionHash, loadGraph, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { NO_TRAILER_SUMMARY } from "../../src/adapters/prompt.js";
import { EARLY_LAUNCH_LIVENESS_MS, HARVESTED_RESULT_SUMMARY, harvestCpuFlatWindowMs, NUDGEABLE_ADAPTERS, resetDeadChannelFastKillMsForTests, resetEarlyLaunchLivenessMsForTests, resetHarvestCpuFlatMsForTests, resetHarvestSilentMsForTests, resetNudgeTimingForTests, resetPageRepeatMsForTests, resetQuotaBannerSilentMsForTests, runDaemon, setDeadChannelFastKillMsForTests, setEarlyLaunchLivenessMsForTests, setHarvestCpuFlatMsForTests, setHarvestSilentMsForTests, setNudgeTimingForTests, setPageRepeatMsForTests, setQuotaBannerSilentMsForTests, WORKER_NUDGE_MESSAGE, workerTreeCpuMs } from "../../src/run/daemon.js";
import { gitHead, sanitizeBranch, shOk, worktreePath, WORKTREES_DIR } from "../../src/run/git.js";
import { activeRetryBan, GATE_FINGERPRINT_CAP, journaledFailureBrief, Journal, normalizeGateFailure, pendingRepairFindings, recordedTaskFailureKind, reviewRoundsSinceApproval, runHasEnded, structuredFindings, UNIDENTIFIED, type JournalEvent } from "../../src/run/journal.js";
import { PANE_READ_ROWS, resetRowRearmTokenFlatMsForTests, setRowRearmTokenFlatMsForTests } from "../../src/run/stall.js";
import { COMMIT, authedModels, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

/**
 * A FakeAdapter wearing another adapter's id and vendor, so a fixture fleet can carry a second vendor
 * without a second script format. One definition, three call sites (it was copied three times).
 *
 * NONCE (OBS-186 collateral): llm.ts binds a scripted fake verdict to the call nonce only when
 * `adapter.id === "fake"` (augmentFakeVerdictOutput) — and a renamed fake is a different adapter to
 * that guard, so its review verdict arrived UNBOUND and every gate reaching it failed closed on
 * cause `no-verdict`. Path-keyed participation is what routes real reviews here for the first time.
 * The fix is the FIXTURE's, not the check's: this adapter emits its own VERDICT_NONCE-bound copy,
 * exactly as a real reviewer CLI does. Widening llm.ts's guard to `instanceof FakeAdapter` was
 * measured and turns tests/gates/review-retry.test.ts red — that suite uses the same rename to
 * produce a nonce-less verdict ON PURPOSE. Review only: a judge verdict served this way would miss
 * the per-criterion evidence injectFakeEvidence adds, and no fixture routes a judge to a NamedFake.
 */
class NamedFake extends FakeAdapter {
  constructor(private sp: string, public id: string, private models: string[], public vendor: string, private ch: "sub" | "api") {
    super(sp);
  }
  async probe() {
    return { installed: true, authed: true, version: "fake", models: this.models, modelAuth: authedModels(this.models) };
  }
  channels() {
    return this.models.map((model) => ({
      adapter: this.id, vendor: this.vendor, model, channel: this.ch, tier: "frontier" as const,
    }));
  }
  headlessCommand(promptFile: string, model: string): string {
    const base = super.headlessCommand(promptFile, model);
    const prompt = readFileSync(promptFile, "utf8");
    const nonce = extractPromptNonce(prompt);
    if (!nonce || !/TICKMARKR-REVIEW/.test(prompt)) return base;
    const scripted = (JSON.parse(readFileSync(this.sp, "utf8")) as { review?: unknown }).review;
    if (!scripted || typeof scripted !== "object") return base;
    return `${base}; echo ${shq(JSON.stringify({ ...scripted, nonce }))}`;
  }
}

const addGateScripts = (repo: string, testCmd: string) => {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: testCmd } }));
};

const runWorktreeDirs = (repo: string, branch: string): string[] => {
  const root = join(tickmarkrDir(repo), WORKTREES_DIR);
  if (!existsSync(root)) return [];
  const prefix = sanitizeBranch(branch);
  return readdirSync(root).filter((d) => d === prefix || d.startsWith(`${prefix}--`)).sort();
};

const interactiveDriver = () => {
  const inner = new SubprocessDriver();
  return {
    id: "interactive-test",
    interactive: true,
    status: inner.status.bind(inner),
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  };
};

async function seedGateSatisfiedResume(
  runId: string,
  opts: {
    gates: string[];
    priorResults: Array<{ gate: string; pass: boolean; fullSuite?: boolean; selectedTests?: string[] }>;
    script: object;
  },
) {
  const suiteLog = join(makeTestTempDir("tickmarkr-approved-suite-"), "suite.log");
  const testCmd = `printf 'argc=%s args=%s\\n' "$#" "$*" >> ${shq(suiteLog)}`;
  const { repo, fake } = setupRepo(
    [T("T1", { complexity: 8, files: ["**"], gates: opts.gates })],
    { tasks: {}, ...opts.script },
    `gates: { test: ${JSON.stringify(testCmd)} }\n`,
  );
  const baseRef = await gitHead(repo);
  const branch = `tickmarkr/${runId}`;
  const taskBranch = `${branch}--T1`;
  const driver = new SubprocessDriver();
  const priorWt = await driver.worktree(repo, taskBranch, baseRef);
  writeFileSync(join(priorWt, "work.txt"), "landed\n");
  await shOk("git add work.txt && git commit --no-gpg-sign -m work", priorWt);

  const commands = { test: testCmd };
  const baseline = await captureBaseline(repo, commands);
  writeFileSync(suiteLog, ""); // baseline execution is not part of the resumed gate round
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, {
    baseRef, commands, branch, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
  });
  journal.append("task-dispatch", "T1", {
    assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
    attempt: 0,
  });
  journal.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [] });
  journal.phaseStart("T1", "gates");
  for (const result of opts.priorResults) {
    journal.append("gate-result", "T1", {
      gate: result.gate, pass: result.pass, details: result.pass ? "passed" : "failed",
      ...(result.fullSuite === undefined ? {} : { fullSuite: result.fullSuite }),
      ...(result.selectedTests === undefined ? {} : { selectedTests: result.selectedTests }),
    });
  }
  journal.append("task-human", "T1", { reason: "gate failed", kind: "gate-fail" });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(baseline));
  await approve([runId, "T1", "--by", "test"], repo);
  return { repo, fake, suiteLog };
}

describe("v1.85 gate-satisfied resume preserves parallel AND and full-suite authority", () => {
  test("approving review re-runs an unapproved failed acceptance sibling and cannot merge it", async () => {
    const runId = "run-approved-parallel-red";
    const { repo, fake, suiteLog } = await seedGateSatisfiedResume(runId, {
      gates: ["build", "test", "lint", "evidence", "scope", "acceptance", "review"],
      // The selected test screen passed, then BOTH parallel verdicts failed. Plain approval satisfies
      // the last one (review) only; acceptance remains red and must be asked again.
      priorResults: [
        { gate: "test", pass: true, selectedTests: ["tests/a.test.ts"] },
        { gate: "acceptance", pass: false },
        { gate: "review", pass: false },
      ],
      script: {
        judge: { pass: false, criteria: [{ criterion: "done", met: false, reason: "still red" }] },
        review: { approve: true, issues: [] },
      },
    });

    const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expect(summary.done).not.toContain("T1");
    expect(summary.human).toContain("T1");
    const events = Journal.open(repo, runId).read();
    const resumeAt = events.findLastIndex((e) => e.event === "run-resume");
    const post = events.slice(resumeAt + 1);
    expect(post.some((e) => e.event === "gate-result" && e.taskId === "T1"
      && e.data.gate === "acceptance" && e.data.pass === false)).toBe(true);
    expect(post.some((e) => e.event === "merge" && e.taskId === "T1")).toBe(false);
    expect(readFileSync(suiteLog, "utf8").trim().split("\n")).toContain("argc=0 args=");
  }, 60_000);

  test("approving acceptance after a selected-only screen forces a full test gate before merge", async () => {
    const runId = "run-approved-selected-screen";
    const { repo, fake, suiteLog } = await seedGateSatisfiedResume(runId, {
      gates: ["build", "test", "lint", "evidence", "scope", "acceptance", "review"],
      priorResults: [
        { gate: "test", pass: true, selectedTests: ["tests/a.test.ts"] },
        { gate: "acceptance", pass: false },
        { gate: "review", pass: true },
      ],
      script: { review: { approve: true, issues: [] } },
    });

    const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expect(summary.done).toContain("T1");
    const events = Journal.open(repo, runId).read();
    const resumeAt = events.findLastIndex((e) => e.event === "run-resume");
    const post = events.slice(resumeAt + 1);
    const testAt = post.findIndex((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "test");
    const mergeAt = post.findIndex((e) => e.event === "merge" && e.taskId === "T1");
    expect(testAt).toBeGreaterThanOrEqual(0);
    expect(mergeAt).toBeGreaterThan(testAt);
    expect(post[testAt]!.data.pass).toBe(true);
    // One full gate run plus the strict integration-tip verify. No filtered argv can appear here.
    expect(readFileSync(suiteLog, "utf8").trim().split("\n")).toEqual([
      "argc=0 args=",
      "argc=0 args=",
    ]);
  }, 60_000);
});

const readinessFailingDriver = (failures: number, waitedMs = 875, transcript = "cold pane still painting") => {
  const inner = new SubprocessDriver();
  let workerRuns = 0;
  return {
    id: "readiness-test",
    interactive: false,
    status: inner.status.bind(inner),
    slot: inner.slot.bind(inner),
    async run(slot: Slot, cmd: string) {
      if ((slot.name.startsWith("tickmarkr:worker:") || slot.name.includes("-worker-")) && workerRuns++ < failures) {
        throw new DeliveryReadinessError(waitedMs, transcript);
      }
      await inner.run(slot, cmd);
    },
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  };
};

describe("daemon integration (fake adapter, zero tokens)", () => {
  const tipMovingDriver = (moves: number, file = "payload.txt") => {
    const inner = new SubprocessDriver();
    let wt = "";
    let moved = 0;
    return {
      driver: {
        id: "tip-moving",
        interactive: false,
        status: inner.status.bind(inner),
        slot: inner.slot.bind(inner),
        run: inner.run.bind(inner),
        waitOutput: inner.waitOutput.bind(inner),
        waitAgentStatus: inner.waitAgentStatus.bind(inner),
        read: inner.read.bind(inner),
        notify: inner.notify.bind(inner),
        async close(slot: { id: string; name: string; cwd: string }) {
          const output = await inner.read(slot, 400);
          await inner.close(slot);
          if (moved < moves && /^(?:tickmarkr|tickmarkr):(judge|review):/.test(slot.name) && /"pass":\s*true/.test(output)) { // T2: canonical owned names
            writeFileSync(join(wt, file), `rewrite-${++moved}\n`);
            await shOk(`git add ${file} && git commit --amend --no-edit --no-gpg-sign`, wt);
          }
        },
        async worktree(repo: string, branch: string, baseRef: string) {
          wt = await inner.worktree(repo, branch, baseRef);
          return wt;
        },
      },
    };
  };

  test("happy path: dep chain → merged integration branch + evidence bundles", async () => {
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2", { deps: ["T1"], complexity: 8 })], // T2 exercises cross-vendor review
      { tasks: {
        T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
        T2: [{ shell: `test -f t1.txt && echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
      } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-happy" });
    expect(s.done).toEqual(["T1", "T2"]);
    expect(s.failed).toEqual([]);
    expect(s.branch).toBe("tickmarkr/run-happy");
    // both merged, in order, on the integration branch — main untouched
    const log = await shOk(`git log --oneline ${s.branch}`, repo);
    expect(log).toContain("merge T1");
    expect(log).toContain("merge T2");
    expect((await shOk("git log --oneline main", repo)).trim().split("\n")).toHaveLength(1);
    // T2's worktree saw T1's merged output (the `test -f t1.txt` would have failed otherwise)
    // evidence bundle on the graph
    const g = JSON.parse(readFileSync(join(tickmarkrDir(repo), "graph.json"), "utf8"));
    const t1 = g.tasks.find((t: { id: string }) => t.id === "T1");
    expect(t1.evidence.commits.length).toBeGreaterThan(0);
    expect(t1.evidence.gateResults.some((r: { gate: string }) => r.gate === "acceptance")).toBe(true);
    // journal exists with dispatch/done events
    const evs = Journal.open(repo, "run-happy").read().map((e) => e.event);
    expect(evs).toContain("run-start");
    expect(evs).toContain("task-dispatch");
    expect(evs.filter((e) => e === "task-done")).toHaveLength(2);
    expect(evs).toContain("run-end");
    const merges = Journal.open(repo, "run-happy").read().filter((e) => e.event === "merge");
    expect(merges).toHaveLength(2);
    expect(merges.map((m) => m.data.branch)).toEqual(["tickmarkr/run-happy--T1", "tickmarkr/run-happy--T2"]);
    expect(merges.every((m) => typeof m.data.commit === "string" && (m.data.commit as string).length > 0)).toBe(true);
    expect(merges.every((m) => Object.keys(m.data).sort().join(",") === "branch,commit")).toBe(true);
  });

  test("test: a run's journal contains a phase-start event naming the task and phase for the worker dispatch and for each verification phase that ran", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );

    await runDaemon(repo, { adapters: [fake], runId: "run-phase-starts" });

    const events = Journal.open(repo, "run-phase-starts").read();
    const starts = events.filter((event) => event.event === "phase-start");
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.every((event) => event.taskId === "T1" && typeof event.data.phase === "string")).toBe(true);
    expect(starts.map((event) => event.data.phase)).toEqual([
      "worker",
      "gates",
      "gate:build",
      "gate:test",
      "gate:lint",
      "gate:evidence",
      "gate:scope",
      "judge",
      "review",
      "merge",
    ]);
    const gateStarts = starts.filter((event) => typeof event.data.gate === "string");
    expect(gateStarts.map((event) => event.data.gate)).toEqual(
      events.filter((event) => event.event === "gate-result").map((event) => event.data.gate),
    );
  });

  test("test: phase-start events are appended when a phase begins rather than batched with that phase's outcome", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const observed: Array<{ phase: unknown; outcomeAlreadyPresent: boolean }> = [];

    await runDaemon(repo, {
      adapters: [fake],
      runId: "run-phase-timing",
      narrate: (event) => {
        if (event.event !== "phase-start") return;
        const persisted = Journal.open(repo, "run-phase-timing").read();
        const gate = event.data.gate;
        const outcomeAlreadyPresent =
          event.data.phase === "worker"
            ? persisted.some((row) => row.event === "worker-result" && row.taskId === event.taskId)
            : event.data.phase === "gates"
              ? persisted.some((row) => row.event === "gate-result" && row.taskId === event.taskId)
              : event.data.phase === "merge"
                ? persisted.some((row) => row.event === "merge" && row.taskId === event.taskId)
                : persisted.some((row) =>
                    row.event === "gate-result" &&
                    row.taskId === event.taskId &&
                    row.data.gate === gate
                  );
        observed.push({ phase: event.data.phase, outcomeAlreadyPresent });
      },
    });

    expect(observed.map((entry) => entry.phase)).toContain("worker");
    expect(observed.map((entry) => entry.phase)).toContain("judge");
    expect(observed.map((entry) => entry.phase)).toContain("review");
    expect(observed.map((entry) => entry.phase)).toContain("merge");
    expect(observed.every((entry) => entry.outcomeAlreadyPresent === false)).toBe(true);
  });

  test("gate fail → retry with feedback → done (ladder step 1)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "lied — committed nothing" } }, // evidence gate kills it
        { shell: `echo fixed > f.txt && ${COMMIT} fix`, result: { ok: true, summary: "actually worked" } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-retry" });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-retry").read();
    expect(evs.filter((e) => e.event === "task-dispatch")).toHaveLength(2);
    expect(evs.some((e) => e.event === "gate-result" && e.data.gate === "evidence" && e.data.pass === false)).toBe(true);
    expect(evs.some((e) => e.event === "escalation" && e.data.step === "retry")).toBe(true);
  });

  test("a timed-out subprocess is dead before its retry recreates the worktree", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "tickmarkr-timeout-")), "prior.pid");
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: { T1: [
          { shell: `sleep 30 & printf '%s\\n' $! > ${shq(pidFile)}; wait` },
          { shell: `echo clean > clean.txt && ${COMMIT} clean`, result: { ok: true, summary: "retry" } },
        ] },
        consult: { action: "retry", notes: "retry after timeout" },
      },
      "taskTimeoutMinutes: 0.005\nvisibility:\n  keepPanes: forever\n",
    );
    const inner = new SubprocessDriver();
    const slots: Array<{ id: string; name: string; cwd: string }> = [];
    let worktrees = 0;
    let aliveAtRetry: boolean | undefined;
    const driver = {
      id: "subprocess",
      interactive: false,
      status: inner.status.bind(inner),
      async slot(cwd: string, name: string) {
        const slot = await inner.slot(cwd, name);
        slots.push(slot);
        return slot;
      },
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      async worktree(root: string, branch: string, baseRef: string) {
        if (++worktrees === 2) {
          const prior = Number(readFileSync(pidFile, "utf8"));
          try { process.kill(prior, 0); aliveAtRetry = true; } catch { aliveAtRetry = false; }
        }
        return inner.worktree(root, branch, baseRef);
      },
    };

    try {
      const summary = await runDaemon(repo, { adapters: [fake], runId: "run-timeout-tree", driver });
      expect(summary.done).toEqual(["T1"]);
      expect(aliveAtRetry).toBe(false);
    } finally {
      for (const slot of slots) await inner.close(slot);
      if (existsSync(pidFile)) {
        const prior = Number(readFileSync(pidFile, "utf8"));
        try { process.kill(prior, "SIGKILL"); } catch { /* already dead */ }
      }
    }
  }, 30_000);

  test("two gate fails → escalate switches channel fresh after a same-channel resume", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        // This fixture tests a recoverable escalation. Make that verdict explicit: an absent or
        // unparseable consult verdict is terminal and must not be used to reach attempt three.
        consult: { action: "retry", notes: "the next channel may recover" },
        tasks: { T1: [
          { shell: "true", result: { ok: true, summary: "nothing 1" } },
          { shell: "true", result: { ok: true, summary: "nothing 2" } },
          { shell: `echo third > f.txt && ${COMMIT} third`, result: { ok: true, summary: "third time lucky" } },
        ] },
      },
    );
    fake.contextUsage = () => ({ tokens: 500 });
    const originalResume = fake.resumeCommand.bind(fake);
    const resumed: string[] = [];
    fake.resumeCommand = (sessionId, promptFile, model) => {
      resumed.push(sessionId);
      return originalResume(sessionId, promptFile, model);
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-esc", driver: interactiveDriver() });
    expect(s.done).toEqual(["T1"]);
    const dispatches = Journal.open(repo, "run-esc").read().filter((e) => e.event === "task-dispatch");
    expect(dispatches).toHaveLength(3);
    const models = dispatches.map((e) => (e.data.assignment as { model: string }).model);
    expect(models[2]).toBe("fake-2"); // escalated off the original channel
    expect(dispatches.map((e) => e.data.retryMode)).toEqual(["fresh", "resume", "fresh"]);
    expect(resumed).toHaveLength(1); // only the same-channel retry resumed
  });

  test("humanGate task parks without dispatch; dependents stay pending", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true }), T("T2", { deps: ["T1"] })],
      { tasks: {} },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-human" });
    expect(s.human).toEqual(["T1"]);
    expect(s.done).toEqual([]);
    expect(s.blocked).toEqual(["T2"]); // VIS-01: dependent stranded behind a parked task is blocked, not lost
    expect(s.pending).toEqual([]);
    const evs = Journal.open(repo, "run-human").read();
    expect(evs.some((e) => e.event === "task-human" && e.taskId === "T1")).toBe(true);
    expect(evs.some((e) => e.event === "task-dispatch")).toBe(false); // never dispatched
  });

  test("VIS-01: run-end journal event carries pending/blocked; five buckets sum to total", async () => {
    // T1 humanGates (→ human); T2 deps on T1 (→ blocked); T3 deps on T2 (→ also blocked, transitively).
    // At run-end quiescence the daemon has drained, so done+failed+human+blocked+pending must equal total.
    const { repo, fake } = setupRepo(
      [
        T("T1", { humanGate: true }),
        T("T2", { deps: ["T1"] }),
        T("T3", { deps: ["T2"] }),
        T("T4", { deps: ["T1"] }), // another stranded descendant — counted once even with a shared parked root
      ],
      { tasks: {} },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-vis01" });
    expect(s.human).toEqual(["T1"]);
    expect(s.done).toEqual([]);
    expect(s.failed).toEqual([]);
    expect(s.blocked.map((id) => id).sort()).toEqual(["T2", "T3", "T4"]);
    expect(s.pending).toEqual([]);
    // sum invariant (D-01): every task is in exactly one of the five buckets
    const total = s.done.length + s.failed.length + s.human.length + s.blocked.length + s.pending.length;
    expect(total).toBe(4);

    // the run-end journal event spreads {...summary}, so it inherits pending/blocked by construction
    const endEvent = Journal.open(repo, "run-vis01").read().find((e) => e.event === "run-end");
    expect(endEvent).toBeDefined();
    const data = endEvent!.data as { blocked?: unknown[]; pending?: unknown[]; done?: unknown[]; human?: unknown[] };
    expect(data.blocked).toEqual(s.blocked);
    expect(data.pending).toEqual(s.pending);
    expect(data.done).toEqual(s.done);
    expect(data.human).toEqual(s.human);
  });

  test("VIS-02: run-end notification names each blocked subtree by its nearest parked root", async () => {
    // T1 humanGates (→ human, the parked root); T2 and T3 chain behind it → both blocked.
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true }), T("T2", { deps: ["T1"] }), T("T3", { deps: ["T2"] })],
      { tasks: {} },
    );
    const inner = new SubprocessDriver();
    const notified: string[] = [];
    const driver = {
      id: "notify-spy",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      async notify(msg: string, opts?: { sound?: string }) { notified.push(msg); return inner.notify(msg, opts); },
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-attrib", driver });
    expect(s.human).toEqual(["T1"]);
    expect(s.blocked.sort()).toEqual(["T2", "T3"]);
    const runEndBody = notified[notified.length - 1];
    expect(runEndBody).toContain("2 blocked behind T1");
  });

  test("resume: replayed done task is not re-dispatched", async () => {
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2", { deps: ["T1"] })],
      { tasks: {
        T1: [{ shell: "echo SHOULD-NOT-RUN && exit 1", result: { ok: false, summary: "must not run" } }],
        T2: [{ shell: `echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
      } },
    );
    // hand-craft a prior interrupted run: T1 done and merged to its recorded legacy branch.
    const legacyPrefix = ["dro", "vr"].join("");
    await shOk(`git branch ${legacyPrefix}/run-resume`, repo);
    appendFileSync(join(tickmarkrDir(repo), "config.yaml"), "integrationBranchPrefix: tickmarkr/\n");
    const j = Journal.create(repo, "run-resume");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "T1");
    j.append("task-done", "T1");
    j.append("merge", "T1", { branch: `${legacyPrefix}/run-resume--T1` });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-resume", resume: true });
    expect(s.done).toContain("T2");
    expect(s.branch).toBe(`${legacyPrefix}/run-resume`);
    const events = Journal.open(repo, "run-resume").read();
    expect(events.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1); // only the pre-existing event
    expect(events.findLast((e) => e.event === "merge" && e.taskId === "T2")?.data.branch).toBe(`${legacyPrefix}/run-resume--T2`);
    expect((await shOk("git branch --list tickmarkr/run-resume", repo)).trim()).toBe("");
  });

  test("narration receives each event appended by run and resume", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const runEvents: ReturnType<Journal["read"]> = [];
    await runDaemon(repo, { adapters: [fake], runId: "run-narrate", narrate: (event) => runEvents.push(event) });
    const journal = Journal.open(repo, "run-narrate");
    expect(runEvents).toEqual(journal.read());

    const resumeEvents: ReturnType<Journal["read"]> = [];
    const beforeResume = journal.read().length;
    await runDaemon(repo, { adapters: [fake], runId: "run-narrate", resume: true, narrate: (event) => resumeEvents.push(event) });
    expect(resumeEvents).toEqual(Journal.open(repo, "run-narrate").read().slice(beforeResume));
    expect(resumeEvents.map((event) => event.event)).toEqual(["run-resume", "run-end"]);
  });

  test("cfg.setup runs in the worktree before dispatch; setup failure parks as human", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `test -f setup-ran.txt && echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "saw setup file" } }] } },
    );
    appendFileSync(join(tickmarkrDir(repo), "config.yaml"), "setup: touch setup-ran.txt\n");
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-setup" });
    expect(s.done).toEqual(["T1"]); // worker saw the setup artifact → setup ran first, inside the worktree

    const { repo: r2, fake: f2 } = setupRepo([T("T9")], { tasks: { T9: [{ shell: "true", result: { ok: true, summary: "unreachable" } }] } });
    appendFileSync(join(tickmarkrDir(r2), "config.yaml"), "setup: exit 7\n");
    const s2 = await runDaemon(r2, { adapters: [f2], runId: "run-setup-fail" });
    expect(s2.human).toEqual(["T9"]);
    expect(Journal.open(r2, "run-setup-fail").read().some((e) => e.event === "worktree-setup" && e.data.code === 7)).toBe(true);
  });

  test("a setup failure between the run start append and worker dispatch leaves a journal whose last event is terminal and names the failure", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    await shOk("git branch tickmarkr", repo); // refs/heads/tickmarkr blocks refs/heads/tickmarkr/run-*

    await expect(runDaemon(repo, { adapters: [fake], runId: "run-setup-fatal" })).rejects.toThrow(/tickmarkr\/run-setup-fatal|cannot lock ref|command failed/);

    const events = Journal.open(repo, "run-setup-fatal").read();
    expect(events.map((e) => e.event)).not.toContain("task-dispatch");
    const last = events.at(-1)!;
    expect(last.event).toBe("run-end");
    expect(last.data.phase).toBe("setup");
    expect(last.data.error).toMatch(/tickmarkr\/run-setup-fatal|cannot lock ref|command failed/);
  });

  test("a healthy run start path journals no terminal event before the task loop", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );

    await runDaemon(repo, { adapters: [fake], runId: "run-healthy-start" });

    const events = Journal.open(repo, "run-healthy-start").read();
    const dispatchIdx = events.findIndex((e) => e.event === "task-dispatch");
    expect(dispatchIdx).toBeGreaterThan(events.findIndex((e) => e.event === "run-start"));
    expect(events.slice(0, dispatchIdx).some((e) => e.event === "run-end")).toBe(false);
  });

  test("no fatal path between the run start append and the task loop can exit the daemon without appending a terminal journal event", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    await shOk("git branch tickmarkr", repo);

    await expect(runDaemon(repo, { adapters: [fake], runId: "run-preloop-fatal" })).rejects.toThrow();

    const events = Journal.open(repo, "run-preloop-fatal").read();
    expect(events.find((e) => e.event === "run-start")).toBeDefined();
    expect(events.find((e) => e.event === "task-dispatch")).toBeUndefined();
    expect(events.at(-1)?.event).toBe("run-end");
    expect(events.at(-1)?.data.error).toEqual(expect.any(String));
  });

  test("a baseline where every configured command is missing produces a journaled warning naming the commands", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "unreachable" } }] } },
      "gates:\n  build: definitely-missing-tickmarkr-build\n  test: definitely-missing-tickmarkr-test\n",
    );

    await runDaemon(repo, { adapters: [fake], runId: "run-missing-baseline" });

    const warning = Journal.open(repo, "run-missing-baseline").read().find((e) => e.event === "baseline-warning");
    expect(warning).toBeDefined();
    expect(warning!.data.kind).toBe("wrong-environment");
    expect(warning!.data.commands).toEqual(["build", "test"]);
    expect(warning!.data.reason).toMatch(/wrong environment/i);
    expect(warning!.data.reason).toContain("build");
    expect(warning!.data.reason).toContain("test");
  });

  test("a command oracle that passes at baseline capture produces a journaled warning naming the task and the oracle", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { acceptance: ["done", { oracle: "command", command: "test -f base.txt" }] })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );

    await runDaemon(repo, { adapters: [fake], runId: "run-vacuous-oracle" });

    const warning = Journal.open(repo, "run-vacuous-oracle").read()
      .find((e) => e.event === "baseline-warning" && e.data.kind === "vacuous-oracle");
    expect(warning).toBeDefined();
    expect(warning!.taskId).toBe("T1");
    expect(warning!.data.oracles).toEqual(["test -f base.txt"]);
    expect(warning!.data.reason).toContain("T1");
    expect(warning!.data.reason).toContain("test -f base.txt");
  });

  test("the vacuous warning never changes any gate outcome or task state", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { acceptance: ["done", { oracle: "command", command: "test -f base.txt" }] })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-vacuous-inert" });

    const evs = Journal.open(repo, "run-vacuous-inert").read();
    expect(evs.some((e) => e.event === "baseline-warning" && e.data.kind === "vacuous-oracle")).toBe(true);
    // observational only: every gate still passes, the task still lands done, nothing parks or fails
    expect(s.done).toEqual(["T1"]);
    expect(s.failed).toEqual([]);
    expect(evs.filter((e) => e.event === "gate-result").length).toBeGreaterThan(0);
    expect(evs.filter((e) => e.event === "gate-result").every((e) => e.data.pass === true)).toBe(true);
    const g = JSON.parse(readFileSync(join(tickmarkrDir(repo), "graph.json"), "utf8"));
    expect(g.tasks.find((t: { id: string }) => t.id === "T1").status).toBe("done");
  });

  test("v1.4: task-pin miss journals a routing-lint through the existing seam and the task still runs", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { routingHints: { pin: { via: "gemini", model: "flash" }, source: "02-03-PLAN.md" } })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-pinmiss" });
    expect(s.done).toEqual(["T1"]); // pin miss degrades — never a task failure
    const lint = Journal.open(repo, "run-pinmiss").read().find((e) => e.event === "routing-lint" && e.taskId === "T1");
    expect(lint).toBeDefined();
    expect(String((lint!.data as { lint?: string }).lint)).toMatch(/unavailable/);
  });

  test("v1.4: quota failover under a task floor lands at/above the floor (hint-blind ladder)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { routingHints: { floor: "mid" } })],
      { tasks: { T1: [
        { shell: "echo 'usage limit reached for this model'; exit 1" }, // no trailer + quota text → channel failover
        { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-floor-quota" });
    expect(s.done).toEqual(["T1"]); // hints never freeze the ladder
    const evs = Journal.open(repo, "run-floor-quota").read();
    expect(evs.some((e) => e.event === "quota-failover")).toBe(true);
    const dispatches = evs.filter((e) => e.event === "task-dispatch");
    expect(dispatches.length).toBeGreaterThanOrEqual(2);
    for (const d of dispatches) {
      const a = (d.data as { assignment: { tier: Tier } }).assignment;
      expect(TIER_RANK[a.tier]).toBeGreaterThanOrEqual(TIER_RANK.mid);
    }
  });

  test("exit-0 output mentioning rate limits does NOT trigger quota failover", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo 'note: upstream 429 rate limit handled in code' > n.txt && ${COMMIT} n`, result: { ok: true, summary: "mentions rate limit harmlessly" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-noquota" });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-noquota").read();
    expect(evs.some((e) => e.event === "quota-failover")).toBe(false);
    expect(evs.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
  });

  test("operator release: graph.json edited back to pending beats a replayed human park on resume", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "released and done" } }] } },
    );
    const s1 = await runDaemon(repo, { adapters: [fake], runId: "run-rel" });
    expect(s1.human).toEqual(["T1"]);
    // operator reviews, releases: humanGate off + status back to pending (locked decision 12). T3: turning
    // humanGate off is a task-DEFINITION change (not just status), so resume sees a graph-changed
    // journal and needs the audited --graph-changed release — exactly the stop-amend-resume path it tests.
    const gp = join(tickmarkrDir(repo), "graph.json");
    const g = JSON.parse(readFileSync(gp, "utf8"));
    g.tasks[0].humanGate = false;
    g.tasks[0].status = "pending";
    writeFileSync(gp, JSON.stringify(g, null, 2));
    const s2 = await runDaemon(repo, { adapters: [fake], runId: "run-rel", resume: true, graphChanged: true });
    expect(s2.done).toEqual(["T1"]);
  });

  test("OBS-15: a post-gate history rewrite is refused and the new tip is re-gated once", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo gated > payload.txt && ${COMMIT} gated`, result: { ok: true, summary: "gated" } }] } },
      "visibility:\n  llm: pane\n",
    );
    const { driver } = tipMovingDriver(1);

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-tip-moved", driver });

    expect(s.done).toEqual(["T1"]);
    expect((await shOk(`git show ${s.branch}:payload.txt`, repo)).trim()).toBe("rewrite-1");
    const events = Journal.open(repo, "run-tip-moved").read();
    const moved = events.filter((e) => e.event === "tip-moved" && e.taskId === "T1");
    expect(moved).toHaveLength(1);
    expect(moved[0].data.gatedCommit).not.toBe(moved[0].data.branchTip);
    expect(events.filter((e) => e.event === "gate-result" && e.data.gate === "evidence")).toHaveLength(2);
    expect(events.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
  });

  test("OBS-15: a second post-gate tip move parks without merging", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo gated > payload.txt && ${COMMIT} gated`, result: { ok: true, summary: "gated" } }] } },
      "visibility:\n  llm: pane\n",
    );
    const { driver } = tipMovingDriver(2);

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-tip-moved-twice", driver });

    expect(s.human).toEqual(["T1"]);
    const events = Journal.open(repo, "run-tip-moved-twice").read();
    expect(events.filter((e) => e.event === "tip-moved" && e.taskId === "T1")).toHaveLength(2);
    expect(events.filter((e) => e.event === "gate-result" && e.data.gate === "evidence")).toHaveLength(2);
    expect(events.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
    expect(events.some((e) => e.event === "merge" && e.taskId === "T1")).toBe(false);
    expect(events.some((e) => e.event === "task-human" && /tip moved twice/.test(String(e.data.reason)))).toBe(true);
    expect((await shOk(`git ls-tree -r --name-only ${s.branch}`, repo))).not.toContain("payload.txt");
  });

  test("OBS-15: the one re-gate allowance does not reset on a worker retry", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { files: ["allowed.txt"], gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] })],
      { judge: [
        { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
        { pass: false, criteria: [{ criterion: "c1", met: false, reason: "force worker retry" }] },
        { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
      ], tasks: { T1: [
        { shell: `echo gated > allowed.txt && ${COMMIT} gated`, result: { ok: true, summary: "gated" } },
        { shell: `echo retry > allowed.txt && ${COMMIT} retry`, result: { ok: true, summary: "retry" } },
      ] } },
      "visibility:\n  llm: pane\n",
    );
    const { driver } = tipMovingDriver(2, "allowed.txt");

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-tip-moved-retry", driver });

    expect(s.human).toEqual(["T1"]);
    const events = Journal.open(repo, "run-tip-moved-retry").read();
    expect(events.filter((e) => e.event === "tip-moved" && e.taskId === "T1")).toHaveLength(2);
    expect(events.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(2);
    expect(events.some((e) => e.event === "merge" && e.taskId === "T1")).toBe(false);
  });

  test("merge conflict → consult verdict applied (human): loser parks, integration stays clean", async () => {
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2")],
      {
        consult: { action: "human", notes: "conflicting edits need a person" },
        tasks: {
          T1: [{ shell: `sleep 0.3 && echo A > shared.txt && ${COMMIT} ta`, result: { ok: true, summary: "ta" } }],
          T2: [{ shell: `sleep 0.3 && echo B > shared.txt && ${COMMIT} tb`, result: { ok: true, summary: "tb" } }],
        },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-conflict" });
    expect(s.done).toHaveLength(1); // whichever merged first
    expect(s.human).toHaveLength(1); // the conflict loser, parked by the consult verdict
    const evs = Journal.open(repo, "run-conflict").read();
    expect(evs.some((e) => e.event === "merge-conflict")).toBe(true);
    expect(evs.some((e) => e.event === "consult-verdict" && e.data.action === "human")).toBe(true);
    // the aborted merge left the integration worktree clean
    const intWt = worktreePath(repo, s.branch);
    expect((await shOk("git status --porcelain", intWt)).trim()).toBe("");
  });

  test("ladder reaches consult; retry verdict feeds notes back and task completes", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: { action: "retry", notes: "commit something real this time" },
        tasks: {
          T1: [
            { shell: "true", result: { ok: true, summary: "nothing 1" } },
            { shell: "true", result: { ok: true, summary: "nothing 2" } },
            { shell: "true", result: { ok: true, summary: "nothing 3" } },
            { shell: `echo done > f.txt && ${COMMIT} f`, result: { ok: true, summary: "finally" } },
          ],
        },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-ladder" });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-ladder").read();
    expect(evs.filter((e) => e.event === "task-dispatch")).toHaveLength(4);
    expect(evs.filter((e) => e.event === "escalation").map((e) => e.data.step)).toEqual(["retry", "escalate", "consult"]);
    expect(evs.some((e) => e.event === "consult-verdict" && e.data.action === "retry")).toBe(true);
  });

  // v1.54 T1: a scripted consult seat with its own adapter id — failover needs live adapters distinct
  // from the pinned fake. Emits a nonce-bound verdict through a real shell command; records the models
  // it was invoked with so a skipped seat is provable as never-invoked.
  class SeatFake extends FakeAdapter {
    consultModels: string[] = [];
    constructor(scriptPath: string, id: string, private verdict: unknown) {
      super(scriptPath);
      this.id = id;
      this.vendor = id;
    }
    channels(): BillingChannel[] {
      // cheap: below the implement floor, so the seat never enters WORKER routing/failover — the
      // scripted step sequence must stay on the base fake while the consult seat proves liveness.
      return [{ adapter: this.id, vendor: this.vendor, model: "fake-9", channel: "sub", tier: "cheap" }];
    }
    headlessCommand(promptFile: string, model: string): string {
      this.consultModels.push(model);
      const js = `const fs=require("fs");const n=/VERDICT_NONCE: ([0-9a-f]+)/.exec(fs.readFileSync(${JSON.stringify(promptFile)},"utf8"))[1];console.log(JSON.stringify({nonce:n,...${JSON.stringify(this.verdict)}}))`;
      return `node -e ${shq(js)}`;
    }
  }

  test("the daemon passes its doctor filtered channels to consult", async () => {
    // Pin's scripted verdict PARKS the task; the fake2 prefer seat's verdict retries it. done=["T1"]
    // therefore proves consult received the daemon's channel list (an unpassed list ⇒ empty live set ⇒
    // pin answers ⇒ human park), and the doctor-unauthed fake3 seat must be skipped without invocation.
    const { repo, fake, scriptPath } = setupRepo(
      [T("T1")],
      {
        consult: { action: "human", notes: "pin seat must not answer" },
        tasks: {
          T1: [
            { shell: "true", result: { ok: true, summary: "nothing 1" } },
            { shell: "true", result: { ok: true, summary: "nothing 2" } },
            { shell: "true", result: { ok: true, summary: "nothing 3" } },
            { shell: `echo done > f.txt && ${COMMIT} f`, result: { ok: true, summary: "finally" } },
          ],
        },
      },
    );
    writeFileSync(
      join(tickmarkrDir(repo), "config.yaml"),
      'judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1, prefer: ["fake3:f-1", "fake2:fake-9"] }\n',
    );
    // doctor.json is the daemon's health source: fake3 is adapter-unauthed, so discoverChannels drops
    // its channels — a consult rebuilding candidates from config instead would have invoked it.
    writeFileSync(join(tickmarkrDir(repo), "doctor.json"), JSON.stringify({
      fake: { installed: true, authed: true, models: ["fake-1", "fake-2"], modelAuth: authedModels(["fake-1", "fake-2"]) },
      fake2: { installed: true, authed: true, models: ["fake-9"], modelAuth: authedModels(["fake-9"]) },
      fake3: { installed: true, authed: false, models: ["f-1"], modelAuth: authedModels(["f-1"]) },
    }));
    const fake2 = new SeatFake(scriptPath, "fake2", { action: "retry", notes: "seat fake2 answered" });
    const fake3 = new SeatFake(scriptPath, "fake3", { action: "retry", notes: "unauthed seat must not answer" });
    const s = await runDaemon(repo, { adapters: [fake, fake2, fake3], runId: "run-consult-channels" });
    expect(s.done).toEqual(["T1"]);
    expect(s.human).toEqual([]);
    // every consult this run drew — the fingerprint cap forces one of its own when the same failure
    // repeats — reached the live prefer seat, with its entry's model, and only that seat.
    expect(fake2.consultModels.length).toBeGreaterThan(0);
    expect(new Set(fake2.consultModels)).toEqual(new Set(["fake-9"]));
    expect(fake3.consultModels).toEqual([]); // doctor-filtered seat skipped without an invocation
    const verdict = Journal.open(repo, "run-consult-channels").read().find((e) => e.event === "consult-verdict")!;
    expect(verdict.data.action).toBe("retry");
    expect(verdict.data.notes).toBe("seat fake2 answered");
  });

  test("v1.39 OBS-37a: consult retry prompt gets bullet guidance, not raw consult prose; journal keeps full verdict", async () => {
    const distinctive = "CONSULT VERDICT: herdr must never see this distinctive prose echoed in a worker prompt";
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: {
          action: "retry",
          reason: "evidence gate empty twice",
          guidance: "Commit a real file.\nStay inside declared paths.",
          notes: distinctive,
        },
        tasks: {
          T1: [
            { shell: "true", result: { ok: true, summary: "nothing 1" } },
            { shell: "true", result: { ok: true, summary: "nothing 2" } },
            { shell: "true", result: { ok: true, summary: "nothing 3" } },
            { shell: `echo done > f.txt && ${COMMIT} f`, result: { ok: true, summary: "finally" } },
          ],
        },
      },
    );
    const runId = "run-consult-bullets";
    const s = await runDaemon(repo, { adapters: [fake], runId });
    expect(s.done).toEqual(["T1"]);
    const retryPrompt = readFileSync(join(tickmarkrDir(repo), "runs", runId, "prompts", "T1-a3.md"), "utf8");
    expect(retryPrompt).toContain("- Action: retry");
    expect(retryPrompt).toContain("- Reason: evidence gate empty twice");
    expect(retryPrompt).toContain("- Commit a real file.");
    expect(retryPrompt).toContain("- Stay inside declared paths.");
    expect(retryPrompt).not.toContain(distinctive);
    const verdict = Journal.open(repo, runId).read().find((e) => e.event === "consult-verdict" && e.taskId === "T1")!;
    expect(verdict.data).toEqual({
      action: "retry",
      reason: "evidence gate empty twice",
      guidance: "Commit a real file.\nStay inside declared paths.",
      notes: distinctive,
    });
  });

  test("v1.1: pane-mode runs judge/review via named driver slots; keepPanes=run closes all by run end", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
      "visibility:\n  llm: pane\n",
    );
    const inner = new SubprocessDriver();
    const names: string[] = [];
    const closed: string[] = [];
    const slotOpts: { name: string; opts?: unknown }[] = [];
    const driver = {
      id: "spy",
      interactive: false,
      status: inner.status.bind(inner),
      async slot(cwd: string, name: string, opts?: unknown) { names.push(name); slotOpts.push({ name, opts }); return inner.slot(cwd, name); },
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      async close(s: { id: string; name: string; cwd: string }) { closed.push(s.name); return inner.close(s); },
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-panes", driver });
    expect(s.done).toEqual(["T1"]);
    // T2 ownership contract: judge/review pane names are canonical; the worker keeps its legacy name
    // param but carries the canonical identity in opts.owned (herdr resolves it to the pane name).
    const judgeName = formatOwnedName({ role: "judge", taskId: "T1", attempt: 0, runId: "run-panes" });
    const reviewName = formatOwnedName({ role: "review", taskId: "T1", attempt: 0, runId: "run-panes" });
    expect(names.some((n) => n.startsWith("T1-worker-fake-a0"))).toBe(true);
    expect(names).toContain(judgeName);
    expect(names).toContain(reviewName);
    // SUP-01/02: the worker slot carries the WORKERS group; judge/review carry role-first labels (non-vacuous — opts is forwarded)
    expect(slotOpts.find((o) => o.name.startsWith("T1-worker-fake-a0"))?.opts).toEqual({ group: "workers", owned: { role: "worker", taskId: "T1", attempt: 0, runId: "run-panes" } });
    expect(slotOpts.find((o) => o.name === judgeName)?.opts).toEqual({ label: "JUDGE T1" });
    expect(slotOpts.find((o) => o.name === reviewName)?.opts).toEqual({ label: "REVIEW T1" });
    // default keepPanes "run": every slot was kept open and closed exactly once by run end
    expect(closed.sort()).toEqual(names.slice().sort());
  });

  test("v1.1: a reviewer that produced garbage is excluded on the task's next review", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      {
        review: "garbage — not a verdict",
        consult: { action: "human", notes: "no working cross-vendor reviewer" },
        tasks: { T1: [
          { shell: `echo one > f.txt && ${COMMIT} one`, result: { ok: true, summary: "1" } },
          { shell: `echo two >> f.txt && ${COMMIT} two`, result: { ok: true, summary: "2" } },
        ] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-revfail" });
    expect(s.human).toEqual(["T1"]);
    const details = Journal.open(repo, "run-revfail").read()
      .filter((e) => e.event === "gate-result" && (e.data as { gate?: string }).gate === "review")
      .map((e) => String((e.data as { details?: string }).details));
    expect(details.some((d) => /unparseable/.test(d))).toBe(true); // first review: garbage, fail-closed
    expect(details.some((d) => /no cross-vendor reviewer available/.test(d))).toBe(true); // retry: corpse excluded
  });

  test("v1.1: retried gates get attempt-unique pane names (herdr agent_name_taken regression)", async () => {
    // OBS-189 (park-economics patch): review rejections now converge via forced same-channel retries
    // and park at the engagement round cap WITHOUT consulting — so this test's consult-label guard
    // (WR-01) rides a judge rejection instead, which still walks retry → escalate → consult → park.
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      {
        judge: { pass: false, criteria: [{ criterion: "a", met: false, reason: "not met" }] }, // rejection every attempt
        review: { approve: true, issues: [] }, // unreached — acceptance fails first
        consult: { action: "human", notes: "stop" },
        tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
      },
      "visibility:\n  llm: pane\n",
    );
    const inner = new SubprocessDriver();
    const open = new Set<string>();
    const names: string[] = [];
    const slotOpts: { name: string; opts?: unknown }[] = [];
    const driver = {
      id: "unique-spy",
      interactive: false,
      status: inner.status.bind(inner),
      async slot(cwd: string, name: string, opts?: unknown) {
        // herdr semantics: an agent name still in use cannot be re-registered
        if (open.has(name)) throw new Error(`agent name ${name} is already used`);
        open.add(name);
        names.push(name);
        slotOpts.push({ name, opts });
        return inner.slot(cwd, name);
      },
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      async close(s: { id: string; name: string; cwd: string }) { open.delete(s.name); return inner.close(s); },
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-uniq", driver });
    expect(s.failed).toEqual([]); // a name collision would crash the task into "failed"
    expect(s.human).toEqual(["T1"]); // the legitimate path: judge rejections → consult → park
    // D-07: judge panes self-clean between attempts — canonical names reuse safely (no agent_name_taken)
    expect(names.filter((n) => n === formatOwnedName({ role: "judge", taskId: "T1", attempt: 0, runId: "run-uniq" })).length).toBeGreaterThanOrEqual(2);
    expect(names).toContain(gatePaneName("consult", "T1")); // consult pane named + kept too
    // WR-01: consult routes through the dedicated-tab label path (guards run-104447 mislabel regression);
    // T2: the canonical identity rides opts.owned (the legacy name param stays for subprocess spies)
    expect(slotOpts.find((o) => o.name === gatePaneName("consult", "T1"))?.opts).toEqual({ label: "CONSULT T1", owned: { role: "consult", taskId: "T1", attempt: 0, runId: "run-uniq" } });
  });

  // v1.70 T5 (review-convergence) + OBS-189 (park-economics patch): a task whose review keeps drawing
  // material findings converges via forced same-channel fix retries (no ladder, no consult) and parks
  // at the engagement round cap with BOTH human decisions named — accept the diff, or uphold and fund
  // one fixed attempt.
  test("a task that has already reached the review round cap is parked for a human decision instead of dispatching another review round", async () => {
    const { repo, fake } = setupRepo(
      // deterministic command oracle for acceptance: the review gate is the one under test, so this
      // isolates it and avoids spawning a fake-judge subprocess on every round.
      [T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })],
      {
        review: { approve: false, findings: [{ note: "blocking bug", severity: "material" }] }, // material every round
        consult: { action: "retry", notes: "keep going" }, // must never fire — review-fix retries bypass the ladder
        tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-revcap" });
    expect(s.human).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-revcap").read();
    const humanEv = evs.find((e) => e.event === "task-human" && e.taskId === "T1");
    expect(String(humanEv?.data.reason)).toMatch(/review round cap/i);
    expect(String(humanEv?.data.reason)).toMatch(/--uphold/); // both verbs offered at the park
    // exactly REVIEW_ROUND_CAP failing review rounds ran, then the cap parked it before another round
    const reviewRounds = evs.filter((e) =>
      e.event === "gate-result" &&
      (e.data as { gate?: string }).gate === "review" &&
      (e.data as { pass?: boolean }).pass === false,
    ).length;
    expect(reviewRounds).toBe(2);
    // OBS-189/G3: the fix attempts were forced same-channel retries — no ladder rung, no consult
    expect(evs.filter((e) => e.event === "escalation" && e.data.reviewFix === true).length).toBeGreaterThanOrEqual(1);
    expect(evs.some((e) => e.event === "consult-verdict")).toBe(false);
    // parked by the review round cap, NOT the global attempt cap (10) — review non-convergence is caught early
    expect(evs.some((e) => e.event === "task-human" && /attempt cap/.test(String(e.data.reason ?? "")))).toBe(false);
  });

  // ── Phase 11 wave 2: TEL-02 counter population + park discrimination ──
  const telem = (repo: string, runId: string) => Journal.open(repo, runId).readTelemetry();

  test("TEL-02 clean run: attempts:1, firstAttemptOk:true, gateFails:0, consults:0", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "clean" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-tel-clean" });
    expect(s.done).toEqual(["T1"]);
    const row = telem(repo, "run-tel-clean").find((r) => r.taskId === "T1")!;
    expect(row.outcome).toBe("done");
    expect(row.attempts).toBe(1);
    expect(row.firstAttemptOk).toBe(true);
    expect(row.gateFails).toBe(0);
    expect(row.consults).toBe(0);
  });

  test("TEL-02 eventually-passed: attempts:2, firstAttemptOk:false, gateFails:1 (retry ladder step)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "lied — committed nothing" } }, // evidence gate kills attempt 0
        { shell: `echo fixed > f.txt && ${COMMIT} fix`, result: { ok: true, summary: "actually worked" } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-tel-retry" });
    expect(s.done).toEqual(["T1"]);
    const row = telem(repo, "run-tel-retry").find((r) => r.taskId === "T1")!;
    expect(row.outcome).toBe("done");
    expect(row.attempts).toBe(2);
    expect(row.firstAttemptOk).toBe(false);
    expect(row.gateFails).toBe(1); // one gate-failed attempt — its own counter, NOT derived from attempts
    expect(row.consults).toBe(0);
  });

  test("TEL-02 consult path: gate-fails reach the consult step, retry verdict → pass writes the consult count", async () => {
    // ladder [retry, escalate, consult, human]: three gate-fails walk to the consult step, whose retry
    // verdict feeds a fourth passing attempt. Every consult drawn on the way — the ladder's own, plus
    // the one the fingerprint cap forces when these three identical evidence failures repeat — is
    // counted and persisted onto the done row.
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: { action: "retry", notes: "commit something real this time" },
        tasks: { T1: [
          { shell: "true", result: { ok: true, summary: "nothing 1" } },
          { shell: "true", result: { ok: true, summary: "nothing 2" } },
          { shell: "true", result: { ok: true, summary: "nothing 3" } },
          { shell: `echo done > f.txt && ${COMMIT} f`, result: { ok: true, summary: "finally" } },
        ] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-tel-consult" });
    expect(s.done).toEqual(["T1"]);
    const row = telem(repo, "run-tel-consult").find((r) => r.taskId === "T1")!;
    expect(row.outcome).toBe("done");
    expect(row.consults).toBe(2); // every consult across the attempt loop, persisted onto the done row
    expect(row.gateFails).toBe(3); // three gate-failed attempts before the consult-fed pass
    expect(row.firstAttemptOk).toBe(false);
  });

  test("TEL-02 park discrimination: quota exhaustion writes parkKind:'quota' (availability, not quality)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "echo 'usage limit reached for this model'; exit 1" }] } }, // no trailer + quota text, every channel
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-tel-quota" });
    expect(s.human).toEqual(["T1"]);
    // the parked row — NOT the earlier mid-task failover row (quotaFailover:true, outcome:failed) that
    // now precedes it once a channel is thrown away FROM before the final channel parks (v1.8 TEL-05)
    const row = telem(repo, "run-tel-quota").find((r) => r.taskId === "T1" && r.parkKind === "quota")!;
    expect(row.outcome).toBe("human");
    expect(row.parkKind).toBe("quota");
  });

  test("TEL-05 mid-task failover: FROM-channel row (quotaFailover:true, failed, durationMs:0); winning row unmarked", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "echo 'usage limit reached for this model'; exit 1" }, // quota on channel A → failover to B
        { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "worked on next channel" } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-tel-failover" });
    expect(s.done).toEqual(["T1"]);
    // FROM channel is the one named in the quota-failover event, NOT the winning channel
    const from = (Journal.open(repo, "run-tel-failover").read()
      .find((e) => e.event === "quota-failover")!.data as { from: string }).from;
    const rows = telem(repo, "run-tel-failover").filter((r) => r.taskId === "T1");
    const failover = rows.find((r) => r.quotaFailover === true)!;
    expect(failover).toBeDefined();
    expect(failover.outcome).toBe("failed");
    expect(failover.durationMs).toBe(0);
    expect(failover.attempts).toBe(1);
    expect(`${failover.adapter}:${failover.model}`).toBe(from); // channelKey shape: adapter:model
    const done = rows.find((r) => r.outcome === "done")!;
    expect(done.quotaFailover).toBeUndefined(); // winning row is never marked
  });

  test("TEL-05 non-double-count: the parked channel is NEVER also counted as a quotaFailover (park branch stays clean)", async () => {
    // quota on EVERY channel: the daemon fails over A→B once (one quotaFailover:true row for A), then
    // parks on B (parkKind:"quota"). Those are two DIFFERENT channels — legitimate. The double-count
    // guard for Phase 26 ROUTE-12 is: no SINGLE channel carries BOTH signals. If the park branch also
    // wrote quotaFailover:true, channel B would carry both → this test turns red.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "echo 'usage limit reached for this model'; exit 1" }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-tel-nodouble" });
    expect(s.human).toEqual(["T1"]);
    const rows = telem(repo, "run-tel-nodouble").filter((r) => r.taskId === "T1");
    const key = (r: { adapter: string; model: string }) => `${r.adapter}:${r.model}`;
    const parked = rows.filter((r) => r.parkKind === "quota");
    const failovers = rows.filter((r) => r.quotaFailover === true);
    expect(parked).toHaveLength(1);
    expect(failovers).toHaveLength(1);
    // the parked channel is park-only; no channel is double-counted
    expect(parked[0].quotaFailover).toBeUndefined();
    expect(key(parked[0])).not.toBe(key(failovers[0]));
  });

  test("TEL-02 park discrimination: ladder exhaustion writes parkKind:'ladder-exhausted' (verified failure)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: { action: "retry", notes: "keep trying" }, // consult step doesn't terminate → ladder runs to its "human" step
        tasks: { T1: [{ shell: "true", result: { ok: true, summary: "nothing ever committed" } }] }, // evidence gate fails every attempt
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-tel-ladder" });
    expect(s.human).toEqual(["T1"]);
    const row = telem(repo, "run-tel-ladder").find((r) => r.taskId === "T1")!;
    expect(row.outcome).toBe("human");
    expect(row.parkKind).toBe("ladder-exhausted");
    expect(row.gateFails).toBeGreaterThanOrEqual(1); // park rows carry the verified gate-failure count
  });

  test("TEL-02 exception row (pre-assignment throw) keeps the '-' sentinel and NO new fields", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "never runs" } }] } },
      "routing:\n  map:\n    implement:\n      pin:\n        via: ghost\n        model: none\n", // fail-loud map pin miss → route() throws pre-assignment
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-tel-exc" });
    expect(s.failed).toEqual(["T1"]);
    const row = telem(repo, "run-tel-exc").find((r) => r.taskId === "T1")!;
    expect(row.outcome).toBe("failed");
    expect(row.adapter).toBe("-"); // the "-" sentinel excludes it from any channel's quality signal
    expect(row.firstAttemptOk).toBeUndefined();
    expect(row.gateFails).toBeUndefined();
    expect(row.consults).toBeUndefined();
    expect(row.parkKind).toBeUndefined();
  });

  test("test: a first-attempt readiness failure re-dispatches a fresh attempt rather than failing the task", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "readiness prevents this command" } },
        { shell: `echo ready > ready.txt && ${COMMIT} ready`, result: { ok: true, summary: "fresh retry" } },
      ] } },
    );

    const s = await runDaemon(repo, {
      adapters: [fake],
      runId: "run-readiness-retry",
      driver: readinessFailingDriver(1),
    });

    expect(s.done).toEqual(["T1"]);
    expect(s.failed).toEqual([]);
    const events = Journal.open(repo, "run-readiness-retry").read();
    const dispatches = events.filter((e) => e.event === "task-dispatch");
    expect(dispatches.map((e) => e.data.attempt)).toEqual([0, 1]);
    expect(dispatches.map((e) => e.data.retryMode)).toEqual(["fresh", "fresh"]);
    expect(events.filter((e) => e.event === "escalation").map((e) => e.data.step)).toEqual(["retry"]);
    expect(events.some((e) => e.event === "task-failed")).toBe(false);
  });

  test("test: readiness failures that exhaust the attempt ladder park the task under the existing failure taxonomy", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: { action: "retry", notes: "spend the next existing ladder rung" },
        tasks: { T1: [{ shell: "true", result: { ok: true, summary: "never delivered" } }] },
      },
    );

    const s = await runDaemon(repo, {
      adapters: [fake],
      runId: "run-readiness-exhausted",
      driver: readinessFailingDriver(Number.POSITIVE_INFINITY),
    });

    expect(s.human).toEqual(["T1"]);
    expect(s.failed).toEqual([]);
    const events = Journal.open(repo, "run-readiness-exhausted").read();
    expect(events.filter((e) => e.event === "escalation").map((e) => e.data.step)).toEqual([
      "retry",
      "escalate",
      "consult",
      "human",
    ]);
    expect(events.filter((e) => e.event === "task-dispatch")).toHaveLength(4);
    expect(events.find((e) => e.event === "task-human")?.data.kind).toBe("ladder-exhausted");
    expect(events.some((e) => e.event === "task-failed")).toBe(false);
  });

  test("test: a structural driver error still fails the task immediately without consuming the ladder", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "never runs" } }] } },
    );
    const inner = new SubprocessDriver();
    const driver = {
      id: "dispatch-refusal",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      async run() { throw new Error("delivery refused"); },
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-dispatch-refusal", driver });

    expect(s.failed).toEqual(["T1"]);
    const events = Journal.open(repo, "run-dispatch-refusal").read();
    const event = events.find((e) => e.event === "task-failed")!;
    expect(event.data).toMatchObject({ kind: "dispatch", attempts: 0 });
    expect(events.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
    expect(events.some((e) => e.event === "escalation")).toBe(false);
  });

  // OBS-206: a failed gate in an EARLIER attempt must not relabel this attempt's infra death. The
  // whole-history scan made every task that ever failed one gate permanently ineligible for
  // `resume --retry-failed` (which releases kind === "dispatch" only) — measured on
  // run-20260728-110135, where T1 attempt 6 died on delivery corruption having run no gate at all.
  test("test: a dispatch death after an earlier gate failure is recorded as dispatch, not gate-fail", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "lied — committed nothing" } }, // evidence gate kills attempt 1
        { shell: "true", result: { ok: true, summary: "never runs — delivery dies first" } },
      ] } },
    );
    const inner = new SubprocessDriver();
    let runs = 0;
    const driver = {
      id: "late-dispatch-refusal",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      async run(...args: Parameters<SubprocessDriver["run"]>) {
        if (++runs > 1) throw new Error("delivery corrupted after 2 submit attempts");
        return inner.run(...args);
      },
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-late-dispatch", driver });

    expect(s.failed).toEqual(["T1"]);
    const events = Journal.open(repo, "run-late-dispatch").read();
    // the earlier attempt really did fail a gate — that is the condition that used to poison the label
    expect(events.some((e) => e.event === "gate-result" && e.data.pass === false)).toBe(true);
    expect(events.find((e) => e.event === "task-failed")!.data).toMatchObject({ kind: "dispatch" });
    expect(recordedTaskFailureKind(events, "T1")).toBe("dispatch");
  });

  test("test: a readiness failure journals how long delivery waited and what the pane showed", async () => {
    const transcript = "welcome banner\ninput box not listening";
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "readiness prevents this command" } },
        { shell: `echo ready > ready.txt && ${COMMIT} ready`, result: { ok: true, summary: "fresh retry" } },
      ] } },
    );

    await runDaemon(repo, {
      adapters: [fake],
      runId: "run-readiness-evidence",
      driver: readinessFailingDriver(1, 1_375, transcript),
    });

    const event = Journal.open(repo, "run-readiness-evidence").read()
      .find((e) => e.event === "delivery-readiness-failed");
    expect(event?.data).toMatchObject({
      attempt: 0,
      waitedMs: 1_375,
      transcript,
    });
  });

  test("TEL-01 liar-positive: trailer ok:true but gates fail ⇒ outcome !== 'done'", async () => {
    // the worker lies success every attempt while committing nothing; the evidence gate never lets it merge.
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: { action: "human", notes: "worker keeps lying — needs a person" },
        tasks: { T1: [{ shell: "true", result: { ok: true, summary: "lied — committed nothing" } }] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-liar-pos" });
    expect(s.done).toEqual([]);
    expect(s.human).toEqual(["T1"]);
    const row = telem(repo, "run-liar-pos").find((r) => r.taskId === "T1")!;
    expect(row.outcome).not.toBe("done"); // ok:true never becomes a merge — the trailer can't set the verdict
    expect(row.parkKind).toBe("gate-fail"); // parked on the gate-fail consult trigger
  });

  test("TEL-01 liar-negative: trailer ok:false but work commits + gates pass ⇒ outcome === 'done'", async () => {
    // the worker falsely claims failure while committing real, gate-passing work; the trailer influences
    // timing (finished), never the verdict.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo real > f.txt && ${COMMIT} real`, result: { ok: false, summary: "i falsely claim failure" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-liar-neg" });
    expect(s.done).toEqual(["T1"]);
    const row = telem(repo, "run-liar-neg").find((r) => r.taskId === "T1")!;
    expect(row.outcome).toBe("done");
    expect(row.firstAttemptOk).toBe(true);
  });

  test("OBS-47: a worktree whose node_modules link was removed gets it re-asserted before gates run", async () => {
    // the worker claims ok:true while deleting the provisioned node_modules link; without a harness
    // re-assert the test gate (which needs node_modules/marker.txt) would mask a real red as an
    // environmental failure. The harness restores the link BEFORE gates, never on worker say-so.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `rm -f node_modules && echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "removed the provisioned link" } }] } },
      "gates:\n  test: test -f node_modules/marker.txt\n",
    );
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "marker.txt"), "root\n");
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-obs47-reassert" });
    expect(s.done).toEqual(["T1"]); // re-assert restored the link the worker removed → test gate passed
  });

  test("OBS-47: a worker-replaced node_modules directory is restored to the provisioned link before gates", async () => {
    // the worker replaces the symlink with a real directory (the OBS-47 incident shape); the harness
    // restores the provisioned link before gates so the marker is visible again.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `rm -rf node_modules && mkdir node_modules && echo real > real.txt && ${COMMIT} real`, result: { ok: true, summary: "replaced the link with a real dir" } }] } },
      "gates:\n  test: test -f node_modules/marker.txt\n",
    );
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "marker.txt"), "root\n");
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-obs47-realdir" });
    expect(s.done).toEqual(["T1"]); // real dir was replaced with the provisioned link → marker visible again
  });

  test("test: an attempt that adds a dependency to its manifest triggers an install into the gate-visible module tree before the first gate runs", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: {
          T1: [{
            shell: [
              `node -e ${shq(`const fs=require("node:fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.dependencies={"added-dep":"file:./fixture-dep"};fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\\n")`)}`,
              `${COMMIT} dependency`,
            ].join(" && "),
            result: { ok: true, summary: "added dependency" },
          }],
        },
      },
      "gates:\n  build: test -f node_modules/added-dep/marker.txt\n",
    );
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "dependency-install-fixture",
      version: "1.0.0",
      private: true,
    }, null, 2) + "\n");
    mkdirSync(join(repo, "fixture-dep"), { recursive: true });
    writeFileSync(join(repo, "fixture-dep", "package.json"), JSON.stringify({ name: "added-dep", version: "1.0.0" }));
    writeFileSync(join(repo, "fixture-dep", "marker.txt"), "dependency\n");
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    await shOk("git add package.json fixture-dep && git commit --no-gpg-sign -m fixture", repo);

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-dependency-install" });

    expect(s.done).toEqual(["T1"]);
    expect(readFileSync(join(repo, "node_modules", "added-dep", "marker.txt"), "utf8")).toBe("dependency\n");
    const gateResults = Journal.open(repo, "run-dependency-install").read().filter((e) => e.event === "gate-result");
    expect(gateResults[0]?.data).toMatchObject({ gate: "build", pass: true });
  });

  test("test: an attempt with an unchanged dependency manifest runs its gates without any install step", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "manifest unchanged" } }] } },
      "gates:\n  build: test -f node_modules/stale-dep/marker.txt\n",
    );
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "unchanged-dependency-fixture",
      version: "1.0.0",
      private: true,
      dependencies: {
        "must-not-install": "file:./missing-dependency",
      },
    }, null, 2) + "\n");
    mkdirSync(join(repo, "node_modules", "stale-dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "stale-dep", "marker.txt"), "stale\n");
    await shOk("git add package.json && git commit --no-gpg-sign -m fixture", repo);

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-dependency-unchanged" });

    expect(s.done).toEqual(["T1"]);
    expect(existsSync(join(repo, "node_modules", "must-not-install"))).toBe(false);
    const gateResults = Journal.open(repo, "run-dependency-unchanged").read().filter((e) => e.event === "gate-result");
    expect(gateResults[0]?.data).toMatchObject({ gate: "build", pass: true });
  });

  test("test: a failing install marks the attempt failed rather than letting gates run against a stale module tree", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: {
          T1: [{
            shell: [
              `node -e ${shq(`const fs=require("node:fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.dependencies={"must-fail":"file:./missing-dependency"};fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\\n")`)}`,
              `${COMMIT} dependency`,
            ].join(" && "),
            result: { ok: true, summary: "install will fail" },
          }],
        },
      },
      "gates:\n  build: test -f node_modules/stale-dep/marker.txt\n",
    );
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "failing-dependency-fixture",
      version: "1.0.0",
      private: true,
    }, null, 2) + "\n");
    mkdirSync(join(repo, "node_modules", "stale-dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "stale-dep", "marker.txt"), "stale\n");
    await shOk("git add package.json && git commit --no-gpg-sign -m fixture", repo);

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-dependency-install-fail" });

    expect(s.failed).toEqual(["T1"]);
    const events = Journal.open(repo, "run-dependency-install-fail").read();
    expect(events.some((e) => e.event === "gate-result")).toBe(false);
    expect(events.find((e) => e.event === "task-failed")?.data.error).toMatch(/dependency install failed/i);
  });

  test("OBS-47: the composed worker prompt states the worktree layout contract", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const runId = "run-obs47-contract";
    await runDaemon(repo, { adapters: [fake], runId });
    const prompt = readFileSync(join(tickmarkrDir(repo), "runs", runId, "prompts", "T1-a0.md"), "utf8");
    expect(prompt).toContain("Worktree layout contract");
    expect(prompt).toMatch(/node_modules.*symlink/i);
    expect(prompt).toMatch(/never commit, delete, or replace/i);
  });
}, 120000);

describe("SPEND-02/05 metered done rows (fake adapter, zero tokens)", () => {
  test("SPEND-02: scripted usage lands byte-exact on the done telemetry row", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" }, usage: { input: 1200, output: 340, cacheRead: 9000 } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-usage" });
    expect(s.done).toEqual(["T1"]);
    const row = Journal.open(repo, "run-usage").readTelemetry().find((r) => r.taskId === "T1")!;
    // the record's write-time stamp is >= this attempt's dispatch ⇒ passes the sinceMs cursor
    expect(row.tokens).toEqual({ input: 1200, output: 340, cacheRead: 9000 });
  });

  test("SPEND-05: a step without usage leaves NO tokens key on the raw telemetry line", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-nousage" });
    expect(s.done).toEqual(["T1"]);
    const line = readFileSync(join(tickmarkrDir(repo), "runs", "run-nousage", "telemetry.jsonl"), "utf8").trim();
    expect(/"tokens"/.test(line)).toBe(false); // absent on disk — reddens the moment anyone writes zeros
    expect(/"meteredAttempts"/.test(line)).toBe(false); // SPEND-02: no metered count without tokens (Test E)
  });

  // Test C — SPEND-02 accumulation across attempts. A failed metered attempt + a passing metered attempt
  // bill the SUM, with meteredAttempts counting them. The fake's per-attempt worktree store cannot show
  // the 3A+2B+C cumulative-reader bug (that's pinned in 17-03 against the real claude reader); this proves
  // the fold arithmetic + meteredAttempts, not the cursor.
  test("SPEND-02: usage accumulates across a failed+passing attempt (sum + meteredAttempts)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "committed nothing" }, usage: { input: 100, output: 10 } }, // evidence gate fails ⇒ retry
        { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "real work" }, usage: { input: 200, output: 20 } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-accum" });
    expect(s.done).toEqual(["T1"]);
    const row = Journal.open(repo, "run-accum").readTelemetry().find((r) => r.taskId === "T1")!;
    expect(row.attempts).toBe(2);
    expect(row.tokens).toEqual({ input: 300, output: 30 }); // NOT the last attempt's 200/20 — the sum
    expect(row.meteredAttempts).toBe(2);
  });

  test("HARD-08: daemon fails a task whose worker edits out of scope and declares it", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { files: ["src/**"], gates: ["build", "test", "lint", "evidence", "scope"] })],
      { tasks: {
        T1: [{
          shell: `mkdir -p src && echo in > src/ok.ts && echo oos > README.md && ${COMMIT} oos`,
          result: { ok: true, summary: "edited README out of scope", deviations: ["README.md"] },
        }],
      } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-h08-scope" });
    expect(s.done).toEqual([]);
    const evs = Journal.open(repo, "run-h08-scope").read();
    expect(evs.some((e) => e.event === "gate-result" && e.data.gate === "scope" && e.data.pass === false)).toBe(true);
  });

  // Test D — parked spend is still spend. A ladder-exhausted task carries the sum over its metered
  // attempts on the park row. attempts is read from the row so the assertion is ladder-length-agnostic.
  test("SPEND-02: a parked (ladder-exhausted) task carries accumulated usage on its park row", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: { action: "retry", notes: "keep trying" }, // consult never terminates → ladder runs to its human step
        tasks: { T1: [{ shell: "true", result: { ok: true, summary: "never commits" }, usage: { input: 50, output: 5 } }] }, // evidence fails every attempt
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-park-spend" });
    expect(s.human).toEqual(["T1"]);
    const row = Journal.open(repo, "run-park-spend").readTelemetry().find((r) => r.taskId === "T1")!;
    expect(row.outcome).toBe("human");
    expect(row.parkKind).toBe("ladder-exhausted");
    expect(row.attempts).toBeGreaterThanOrEqual(1);
    expect(row.tokens).toEqual({ input: 50 * row.attempts, output: 5 * row.attempts }); // parked spend is real spend
    expect(row.meteredAttempts).toBe(row.attempts);
  });
}, 120000);

// ── GATE-08: human gate approval (D-02 shape — journal event + replay mapping + the daemon guard) ──
// All three cases use ONLY HEAD-present API (Journal.append("task-approved", id, {...})) — no import of a
// not-yet-existing approve command — so they run and color RED against unfixed src while the rest stays green.
describe("GATE-08: human gate approval (fake adapter, zero tokens)", () => {
  test("GATE-08: an approved human gate dispatches and completes on resume", async () => {
    // THE ORACLE (D-06): humanGate task → run → PARKS → approval → resume → DISPATCHES AND COMPLETES.
    // RED on HEAD: replayStatuses has no approval concept, so T1 replays to "human" and the resume
    // quiesces with done=[] (readyTasks keeps only status==='pending'). GREEN needs BOTH the replay
    // mapping (task-approved → pending) AND the daemon guard consulting the approved set.
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    const s1 = await runDaemon(repo, { adapters: [fake], runId: "run-g08-oracle" });
    expect(s1.human).toEqual(["T1"]);
    expect(s1.done).toEqual([]);
    const j1 = Journal.open(repo, "run-g08-oracle").read();
    expect(j1.some((e) => e.event === "task-dispatch")).toBe(false); // parked, never dispatched

    // approval is a JOURNAL EVENT carrying who/when — never a graph.json mutation (D-02: recompile erases it)
    Journal.open(repo, "run-g08-oracle").append("task-approved", "T1", { by: "test" });

    const s2 = await runDaemon(repo, { adapters: [fake], runId: "run-g08-oracle", resume: true });
    expect(s2.done).toEqual(["T1"]); // RED on HEAD: [] — the approval takes effect
    expect(s2.human).toEqual([]);
    const j2 = Journal.open(repo, "run-g08-oracle").read();
    expect(j2.filter((e) => e.event === "task-dispatch" && e.taskId === "T1").length).toBeGreaterThanOrEqual(1);
    expect(j2.some((e) => e.event === "task-done" && e.taskId === "T1")).toBe(true);
  });

  test("GATE-08: an unapproved human gate stays parked while an approved one completes", async () => {
    // bucket assertion, NOT the guard pin: two independent humanGate tasks, approve only T1.
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true }), T("T2", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    const s1 = await runDaemon(repo, { adapters: [fake], runId: "run-g08-bucket" });
    expect(s1.human.sort()).toEqual(["T1", "T2"]);

    // approve ONLY T1
    Journal.open(repo, "run-g08-bucket").append("task-approved", "T1", { by: "test" });

    const s2 = await runDaemon(repo, { adapters: [fake], runId: "run-g08-bucket", resume: true });
    expect(s2.done).toEqual(["T1"]);
    expect(s2.human).toEqual(["T2"]); // unapproved gate still parks — the feature is not globally disarmed
    const j = Journal.open(repo, "run-g08-bucket").read();
    expect(j.some((e) => e.event === "task-dispatch" && e.taskId === "T2")).toBe(false); // T2 never dispatched
  });

  // REDNESS PROFILE: RED under a global disarm (`if (false)`), RED under a resume-scoped disarm
  // (`if (t.humanGate && !opts.resume)` — which passes the dispatch oracle AND the entire existing suite),
  // GREEN only under `!approved.has(t.id)`. This is the ONLY test in the suite that reaches the guard on
  // the resume path: a task parked in run 1 is filtered out by readyTasks() (graph.ts keeps only
  // status==='pending') and therefore NEVER re-enters execTask on resume. T_GATE here has NO journal
  // events and status 'pending' when the resume begins, so it becomes ready DURING the resume and hits
  // the guard for the first time — the one shape a park-then-resume 'pin' cannot exercise.
  test("GATE-08 resume-path guard pin: an unapproved human gate that first becomes ready DURING a resume still parks", async () => {
    const { repo, fake } = setupRepo(
      [T("T_DEP")],
      { tasks: { T_DEP: [{ shell: `echo dep > dep.txt && ${COMMIT} dep`, result: { ok: true, summary: "dep done" } }] } },
    );
    const s1 = await runDaemon(repo, { adapters: [fake], runId: "run-g08-pin" });
    expect(s1.done).toEqual(["T_DEP"]);

    // between runs: add T_GATE — humanGate, deps [T_DEP] (done), status pending, ZERO journal events
    // (exactly like a gate whose dep completes mid-resume). House pattern: saveGraph + validateGraph.
    // T3: adding a task is a task-DEFINITION change, so resume sees a graph-changed journal and needs
    // the audited --graph-changed release — the test still pins the GATE-08 park-on-resume behavior.
    saveGraph(repo, validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [
        T("T_DEP", { status: "done" }),
        T("T_GATE", { humanGate: true, deps: ["T_DEP"], status: "pending" }),
      ],
    }));

    const s2 = await runDaemon(repo, { adapters: [fake], runId: "run-g08-pin", resume: true, graphChanged: true });
    expect(s2.human).toEqual(["T_GATE"]); // unapproved → parks even though it first became ready during the resume
    const j = Journal.open(repo, "run-g08-pin").read();
    expect(j.some((e) => e.event === "task-human" && e.taskId === "T_GATE")).toBe(true); // park() ran — reachable on resume
    expect(j.some((e) => e.event === "task-dispatch" && e.taskId === "T_GATE")).toBe(false); // never dispatched
  });
}, 120000);

// VIS-09 safety (43-02): the per-attempt completion nonce. A run-scoped nonce is a latent hazard —
// HerdrDriver.read() is `pane read --lines 1000` over scrollback and SubprocessDriver never clears
// s.buf, so a retained prior-attempt trailer could let attempt N harvest attempt N-1's TICKMARKR_RESULT
// as its OWN completion, silently lying about a worker's outcome. This oracle models that retention
// (a shared, never-cleared buffer across attempts) and proves attempt 1 completes on ITS OWN trailer.
// RED if the nonce is hoisted to run scope: attempt 0 and 1 would share a nonce, so attempt 1's first
// waitOutput poll matches attempt 0's retained marker before attempt 1's own output lands (the delayed
// delivery below) and harvests the STALE-A0 result as attempt 1's outcome.
describe("VIS-09 per-attempt nonce (stale-trailer oracle)", () => {
  test("a retained prior-attempt trailer cannot complete a retry", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "STALE-A0" } }, // commits nothing → evidence gate fails → retry
        { shell: `echo fresh > f.txt && ${COMMIT} fresh`, result: { ok: true, summary: "FRESH-A1" } },
      ] } },
    );
    // shared, never-cleared buffer across attempts — the honest model of BOTH real drivers' retention
    // (herdr scrollback / subprocess buf). Output is delivered after a short delay so a prior attempt's
    // retained marker is visible to the next attempt's first waitOutput poll before its own output lands
    // (the deterministic shape of the hazard: a stale marker matches before the live agent finishes).
    let buf = "";
    const inner = new SubprocessDriver();
    const driver = {
      id: "retaining",
      interactive: false,
      async slot(cwd: string, name: string) { return inner.slot(cwd, name); },
      async run(s: { id: string; name: string; cwd: string }, cmd: string) {
        const p = spawn("bash", ["-lc", cmd], { cwd: s.cwd, stdio: ["ignore", "pipe", "pipe"] });
        let acc = "";
        p.stdout.on("data", (d) => (acc += d));
        p.stderr.on("data", (d) => (acc += d));
        p.on("close", () => { setTimeout(() => { buf += acc; }, 25); }); // delayed delivery to the SHARED buf
      },
      async waitOutput(_s: unknown, pattern: string, timeoutMs: number, opts?: { regex?: boolean }) {
        const re = opts?.regex ? new RegExp(pattern) : null;
        const hit = re ? (b: string) => re.test(b) : (b: string) => b.includes(pattern);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (hit(buf)) return true;
          await new Promise((r) => setTimeout(r, 15));
        }
        return hit(buf);
      },
      async read(_s: unknown, lines: number) { return buf.split("\n").slice(-lines).join("\n"); },
      async waitAgentStatus() { return true; },
      async status() { return "unknown"; },
      async notify() {},
      async close() {},
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-nonce", driver });
    expect(s.done).toEqual(["T1"]);
    const results = Journal.open(repo, "run-nonce").read()
      .filter((e) => e.event === "worker-result" && e.taskId === "T1")
      .map((e) => String((e.data as { summary?: string }).summary));
    expect(results).toHaveLength(2); // two attempts ran
    expect(results[0]).toBe("STALE-A0");
    expect(results[1]).toBe("FRESH-A1"); // attempt 1 completes on ITS OWN trailer, not the retained attempt-0 one
  });
}, 120000);

// ── HYG-09 (D-07) fleet hygiene: ephemeral panes self-clean, done means gone, close only what you own ──
// Every test uses a recording stub driver that logs an ORDERED op stream (slot/close/notify) so timing
// of the close vs. downstream ops is assertable. The shipped default is llm: headless — these tests opt
// into llm: pane explicitly to exercise the pane close path. RED on unfixed HEAD: today keepLlm tracks
// keepOpen (true under "run"), so judge/review/consult panes stay open until the run-end sweep and a
// merged task's worker pane persists to run end.
describe("HYG-09 fleet hygiene (fake adapter, zero tokens)", () => {
  // records an ordered op stream while delegating execution to a real SubprocessDriver
  function orderedDriver() {
    const inner = new SubprocessDriver();
    const ops: { kind: string; name?: string; msg?: string }[] = [];
    const driver = {
      id: "ordered",
      interactive: false,
      status: inner.status.bind(inner),
      async slot(cwd: string, name: string) { ops.push({ kind: "slot", name }); return inner.slot(cwd, name); },
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      async notify(msg: string, opts?: { sound?: string }) { ops.push({ kind: "notify", msg }); return inner.notify(msg, opts); },
      async close(s: { id: string; name: string; cwd: string }) { ops.push({ kind: "close", name: s.name }); return inner.close(s); },
      worktree: inner.worktree.bind(inner),
    };
    return { driver, ops };
  }

  test("HYG-09: judge/review pane closes when its result is read, before the run-end notification", async () => {
    // D-07 ephemeral-panes-self-clean (leftover-judge-pane incident): under default keepPanes "run" with
    // llm pane opted in, the judge/review slot closes INSIDE runGates (verdict read), BEFORE the
    // run-end notification fires. RED on HEAD: keepLlm=keepOpen keeps the pane to the sweep.
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
      "visibility:\n  llm: pane\n  keepPanes: run\n",
    );
    const { driver, ops } = orderedDriver();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-hyg09-judge", driver });
    expect(s.done).toEqual(["T1"]);
    const judgeClose = ops.findIndex((o) => o.kind === "close" && o.name === formatOwnedName({ role: "judge", taskId: "T1", attempt: 0, runId: "run-hyg09-judge" }));
    const runEndNotify = ops.findIndex((o) => o.kind === "notify" && /integration branch/.test(o.msg ?? ""));
    expect(judgeClose).toBeGreaterThanOrEqual(0);
    expect(runEndNotify).toBeGreaterThanOrEqual(0);
    expect(judgeClose).toBeLessThan(runEndNotify);
  });

  test("HYG-09: consult pane closes when its verdict is read, before the next attempt dispatches", async () => {
    // D-07: the consult pane self-cleans when the verdict is read, BEFORE attempt 3's worker slot is
    // created. RED on HEAD: consult tracked keepOpen → closed in the run-end sweep, after attempt 3.
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: { action: "retry", notes: "commit something real this time" },
        tasks: { T1: [
          { shell: "true", result: { ok: true, summary: "nothing 1" } },
          { shell: "true", result: { ok: true, summary: "nothing 2" } },
          { shell: "true", result: { ok: true, summary: "nothing 3" } }, // ladder reaches consult → retry
          { shell: `echo done > f.txt && ${COMMIT} f`, result: { ok: true, summary: "finally" } },
        ] },
      },
      "visibility:\n  llm: pane\n  keepPanes: run\n",
    );
    const { driver, ops } = orderedDriver();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-hyg09-consult", driver });
    expect(s.done).toEqual(["T1"]);
    const consultClose = ops.findIndex((o) => o.kind === "close" && o.name === gatePaneName("consult", "T1"));
    const nextWorkerSlot = ops.findIndex((o) => o.kind === "slot" && /T1-worker-fake-a3-/.test(o.name ?? ""));
    expect(consultClose).toBeGreaterThanOrEqual(0);
    expect(nextWorkerSlot).toBeGreaterThanOrEqual(0);
    expect(consultClose).toBeLessThan(nextWorkerSlot);
  });

  test("HYG-09: done means gone — a merged task's worker pane closes on done, exactly once", async () => {
    // D-07 done-means-gone (merged-P42-01-worker incident): T1 → T2 (dep). T1 merges first and its worker
    // pane closes on the done path BEFORE T2 dispatches; the slot is closed EXACTLY once (the run-end
    // sweep skips it — it was removed from keptSlots). RED on HEAD: the merged worker persists to run end.
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2", { deps: ["T1"] })],
      { tasks: {
        T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
        T2: [{ shell: `test -f t1.txt && echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
      } },
      "visibility:\n  keepPanes: run\n",
    );
    const { driver, ops } = orderedDriver();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-hyg09-done", driver, concurrency: 1 });
    expect(s.done).toEqual(["T1", "T2"]);
    const t1WorkerClose = ops.findIndex((o) => o.kind === "close" && /T1-worker-fake-a0-/.test(o.name ?? ""));
    const t2WorkerSlot = ops.findIndex((o) => o.kind === "slot" && /T2-worker-fake-a0-/.test(o.name ?? ""));
    expect(t1WorkerClose).toBeGreaterThanOrEqual(0);
    expect(t2WorkerSlot).toBeGreaterThanOrEqual(0);
    expect(t1WorkerClose).toBeLessThan(t2WorkerSlot); // closed on done, before T2 even dispatches
    const t1WorkerName = ops.find((o) => o.kind === "slot" && /T1-worker-fake-a0-/.test(o.name ?? ""))?.name;
    expect(ops.filter((o) => o.kind === "close" && o.name === t1WorkerName)).toHaveLength(1); // no double-close
  });

  test("HYG-09: keepPanes forever keeps everything — zero closes", async () => {
    // Non-regression pin: forever is the keep-everything debug override. Green on HEAD and after.
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
      "visibility:\n  llm: pane\n  keepPanes: forever\n",
    );
    const { driver, ops } = orderedDriver();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-hyg09-forever", driver });
    expect(s.done).toEqual(["T1"]);
    expect(ops.filter((o) => o.kind === "close")).toHaveLength(0);
  });

  test("HYG-09: close only what you own — task A's done-close never closes task B's slot", async () => {
    // Pitfall 5 (anonymous-live-daemon trap): the done-close targets the slot handle the closer itself
    // created, never a scan/label. Two concurrent tasks; T1 (instant shell) merges first — its done-close
    // targets ONLY its own worker name. A scan would close T2's worker too (double-close for T2 ⇒ RED).
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2")],
      { tasks: {
        T1: [{ shell: `echo a > a.txt && ${COMMIT} a`, result: { ok: true, summary: "a" } }],
        T2: [{ shell: `sleep 0.4 && echo b > b.txt && ${COMMIT} b`, result: { ok: true, summary: "b" } }],
      } },
      "visibility:\n  keepPanes: run\n",
    );
    const { driver, ops } = orderedDriver();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-hyg09-own", driver, concurrency: 2 });
    expect(s.done.sort()).toEqual(["T1", "T2"]);
    const t1Name = ops.find((o) => o.kind === "slot" && /T1-worker-fake-a0-/.test(o.name ?? ""))?.name;
    const t2Name = ops.find((o) => o.kind === "slot" && /T2-worker-fake-a0-/.test(o.name ?? ""))?.name;
    expect(t1Name).toBeDefined();
    expect(t2Name).toBeDefined();
    // T1 (instant) finishes first; the first worker close targets T1's own name, never T2's
    const firstWorkerClose = ops.find((o) => o.kind === "close" && /-worker-fake-a0-/.test(o.name ?? ""));
    expect(firstWorkerClose?.name).toBe(t1Name);
    // each task's worker slot closed exactly once — a scan that hit T2 during T1's done-close would
    // double-close T2 (the sweep would also reap it), so this count guards the own-slot-only invariant.
    expect(ops.filter((o) => o.kind === "close" && o.name === t1Name)).toHaveLength(1);
    expect(ops.filter((o) => o.kind === "close" && o.name === t2Name)).toHaveLength(1);
  });

  test("HYG-09: failed attempts keep context — prior attempt's worker slot is NOT closed on done", async () => {
    // D-07: only the SUCCESSFUL attempt's slot closes on the done path; a prior failed attempt's slot
    // stays governed by keepPanes (it holds failure context the operator may need) and waits for the sweep.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "lied — committed nothing" } }, // evidence gate fails
        { shell: `echo ok > f.txt && ${COMMIT} fix`, result: { ok: true, summary: "actually worked" } },
      ] } },
      "visibility:\n  keepPanes: run\n",
    );
    const { driver, ops } = orderedDriver();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-hyg09-failedctx", driver });
    expect(s.done).toEqual(["T1"]);
    const a0Name = ops.find((o) => o.kind === "slot" && /T1-worker-fake-a0-/.test(o.name ?? ""))?.name;
    const a1Name = ops.find((o) => o.kind === "slot" && /T1-worker-fake-a1-/.test(o.name ?? ""))?.name;
    expect(a0Name).toBeDefined(); // the failed attempt's worker slot was created
    expect(a1Name).toBeDefined(); // the successful attempt's worker slot was created
    // the successful attempt's slot (a1) is closed exactly once on done; the failed attempt's slot (a0)
    // is NOT closed on the done path — it waits for the run-end sweep (both close exactly once total).
    expect(ops.filter((o) => o.kind === "close" && o.name === a1Name)).toHaveLength(1);
    expect(ops.filter((o) => o.kind === "close" && o.name === a0Name)).toHaveLength(1);
    // and the failed attempt's close comes AFTER the successful attempt's done-close (sweep, not done path)
    const a1Close = ops.findIndex((o) => o.kind === "close" && o.name === a1Name);
    const a0Close = ops.findIndex((o) => o.kind === "close" && o.name === a0Name);
    expect(a0Close).toBeGreaterThan(a1Close);
  });
}, 120000);

// ── narrator pane: one live status surface per run (herdr only; subprocess unaffected) ──
// A narrator-capable driver gets exactly one "watch" pane opened at run start (before any worker
// dispatch) and leaves it to the operator after run end. A narrator that fails to open is swallowed
// — the run is unaffected. Drivers without the narrator method (subprocess, every stub above) spawn
// nothing: driver.narrator?.() is a no-op there (criterion 3 = the whole suite above).
describe("narrator pane (fake adapter, zero tokens)", () => {
  test("herdr-style driver: opens exactly one watch pane at run start and never closes it", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const inner = new SubprocessDriver();
    const ops: { kind: string; name?: string; cmd?: string; msg?: string }[] = [];
    const driver = {
      id: "herdr",
      interactive: true,
      status: inner.status.bind(inner),
      async slot(cwd: string, name: string) { ops.push({ kind: "slot", name }); return inner.slot(cwd, name); },
      async run(s: { id: string; name: string; cwd: string }, cmd: string) {
        ops.push({ kind: "run", name: s.name, cmd });
        if (cmd.includes("status --watch")) return; // the narrator is a live loop — never actually run it
        return inner.run(s, cmd);
      },
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      async notify(msg: string, o?: { sound?: string }) { ops.push({ kind: "notify", msg }); return inner.notify(msg, o); },
      async close(s: { id: string; name: string; cwd: string }) { ops.push({ kind: "close", name: s.name }); return inner.close(s); },
      worktree: inner.worktree.bind(inner),
      async narrator(cwd: string, command: string) {
        ops.push({ kind: "narrator-open", cmd: command });
        return inner.slot(cwd, "narrator-watch");
      },
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-narr", driver });
    expect(s.done).toEqual(["T1"]);
    // exactly one narrator open, with the watch command
    const opens = ops.filter((o) => o.kind === "narrator-open");
    expect(opens).toHaveLength(1);
    expect(opens[0]!.cmd).toBe("tickmarkr status --watch");
    // opened at run START — before the first worker slot is created
    const openIdx = ops.findIndex((o) => o.kind === "narrator-open");
    const firstWorker = ops.findIndex((o) => o.kind === "slot" && /-worker-/.test(o.name ?? ""));
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(firstWorker).toBeGreaterThan(openIdx);
    expect(ops.filter((o) => o.kind === "close" && o.name === "narrator-watch")).toHaveLength(0);
  });

  test("a narrator that fails to open never affects the run (cosmetic-only, swallowed)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const inner = new SubprocessDriver();
    const driver = {
      id: "herdr",
      interactive: true,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      async narrator() { throw new Error("herdr tab create failed"); },
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-narr-fail", driver });
    expect(s.done).toEqual(["T1"]); // the run succeeded despite the narrator failure
  });

  test("a driver without narrator (subprocess-style) spawns nothing new", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const inner = new SubprocessDriver();
    const names: string[] = [];
    const driver = {
      id: "subprocess",
      interactive: false,
      status: inner.status.bind(inner),
      async slot(cwd: string, name: string) { names.push(name); return inner.slot(cwd, name); },
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      // no narrator method — the daemon's optional-chain call must be a no-op
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-narr-none", driver });
    expect(s.done).toEqual(["T1"]);
    expect(names.every((n) => !n.startsWith("narrator"))).toBe(true); // no narrator pane created
  });
}, 120000);

// v1.23 T2: context sampling piggybacks on interactive poll seams; threshold → one journal + one notify.
describe("v1.23 context-sample (fake adapter, zero tokens)", () => {
  test("crossing the threshold journals one context-sample and notifies once per attempt (no spam)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo hi > a.txt && ${COMMIT} a`, result: { ok: true, summary: "done" } }] } },
      "contextWarnTokens: 1000\n",
    );
    // High context every sample; proves the once-per-attempt latch (not "notify every poll").
    fake.contextUsage = () => ({ tokens: 50_000 });
    const inner = new SubprocessDriver();
    const notified: string[] = [];
    let polls = 0;
    const driver = {
      id: "interactive-ctx",
      interactive: true,
      status: async () => "unknown",
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      // Force ≥3 poll slices while context stays high, then accept the real trailer wait.
      async waitOutput(slot: { id: string; name: string; cwd: string }, pattern: string, timeoutMs: number, opts?: { regex?: boolean }) {
        polls++;
        if (polls < 3) return false;
        return inner.waitOutput(slot, pattern, timeoutMs, opts);
      },
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      async notify(msg: string, opts?: { sound?: string }) {
        notified.push(msg);
        return inner.notify(msg, opts);
      },
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-ctx-once", driver });
    expect(s.done).toEqual(["T1"]);
    expect(polls).toBeGreaterThanOrEqual(3); // multiple samples attempted
    const samples = Journal.open(repo, "run-ctx-once").read().filter((e) => e.event === "context-sample");
    expect(samples).toHaveLength(1); // one journal event per attempt
    expect(samples[0]!.data.tokens).toBe(50_000);
    expect(samples[0]!.data.threshold).toBe(1000);
    const ctxNotifies = notified.filter((m) => /context .*tokens/.test(m));
    expect(ctxNotifies).toHaveLength(1); // one notify — no spam while high
  }, 30_000);

  test("old journals without context-sample events still resume (replay compatibility)", async () => {
    // Resume path must tolerate pre-v1.23 journals: no context-sample events, no schema migration.
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2", { deps: ["T1"] })],
      { tasks: {
        T1: [{ shell: "echo SHOULD-NOT-RUN && exit 1", result: { ok: false, summary: "must not run" } }],
        T2: [{ shell: `echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
      } },
    );
    const j = Journal.create(repo, "run-ctx-resume");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0 });
    j.append("task-done", "T1", { attempts: 1 });
    // Explicitly NO context-sample events — the pre-v1.23 shape.
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    // replayStatuses/replayResumeState ignore absent retryMode; old journals need no migration.
    expect(j.replayStatuses().get("T1")).toBe("done");
    expect(j.replayResumeState().get("T1")).toMatchObject({ attempts: 1, tried: ["fake:fake-1"] });
    expect(j.read().find((e) => e.event === "task-dispatch")!.data.retryMode).toBeUndefined();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-ctx-resume", resume: true });
    expect(s.done).toContain("T2");
    expect(s.done).toContain("T1");
    // Resume must not invent context-sample events for the already-done task.
    const samples = Journal.open(repo, "run-ctx-resume").read().filter((e) => e.event === "context-sample" && e.taskId === "T1");
    expect(samples).toHaveLength(0);
  });
});

// v1.23 T3: over-threshold context on a failed/timed-out attempt ⇒ fresh-session retry + session-reset journal.
// Decision is retry-boundary only (never mid-attempt kill). Unknown/below ⇒ no event (byte-identical).
describe("v1.23 session hygiene on retry (fake adapter, zero tokens)", () => {
  test("under-threshold same-channel gate retry resumes with failure feedback", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "resumed ok" } },
      ] } },
      "contextWarnTokens: 1000\n",
    );
    fake.contextUsage = () => ({ tokens: 500 });
    const originalResume = fake.resumeCommand.bind(fake);
    const resumes: { sessionId: string; prompt: string }[] = [];
    fake.resumeCommand = (sessionId, promptFile, model) => {
      resumes.push({ sessionId, prompt: readFileSync(promptFile, "utf8") });
      return originalResume(sessionId, promptFile, model);
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-sess-resume", driver: interactiveDriver() });

    expect(s.done).toEqual(["T1"]);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.sessionId).toContain("-a0-");
    expect(resumes[0]!.prompt).toContain("Previous attempt failed gates");
    expect(resumes[0]!.prompt).toContain("evidence:");
    const dispatches = Journal.open(repo, "run-sess-resume").read().filter((e) => e.event === "task-dispatch");
    expect(dispatches.map((e) => e.data.retryMode)).toEqual(["fresh", "resume"]);
    expect(Journal.open(repo, "run-sess-resume").readTelemetry().find((r) => r.taskId === "T1")!.retryMode).toBe("resume");
  }, 30_000);

  test("over-threshold prior attempt dispatches fresh and journals session-reset with token count", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        // attempt 0: finishes (trailer) but commits nothing → evidence gate fails → ladder retry
        { shell: "true", result: { ok: true, summary: "bloated nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "fresh retry" } },
      ] } },
      "contextWarnTokens: 1000\n",
    );
    fake.contextUsage = () => ({ tokens: 50_000 });
    const originalResume = fake.resumeCommand.bind(fake);
    const resumed: string[] = [];
    fake.resumeCommand = (sessionId, promptFile, model) => {
      resumed.push(sessionId);
      return originalResume(sessionId, promptFile, model);
    };
    const inner = new SubprocessDriver();
    let polls = 0;
    const driver = {
      id: "interactive-ctx-retry",
      interactive: true,
      status: async () => "unknown",
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      // Force a poll slice so sampleContext can fire on attempt 0 before the trailer is accepted.
      async waitOutput(slot: { id: string; name: string; cwd: string }, pattern: string, timeoutMs: number, opts?: { regex?: boolean }) {
        polls++;
        if (polls === 1) return false; // first slice: sample high context, no trailer yet
        return inner.waitOutput(slot, pattern, timeoutMs, opts);
      },
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-sess-reset", driver });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-sess-reset").read();
    const samples = evs.filter((e) => e.event === "context-sample" && e.taskId === "T1");
    expect(samples.length).toBeGreaterThanOrEqual(1);
    expect(samples[0]!.data.tokens).toBe(50_000);
    // session-reset at the retry boundary, naming the measured over-threshold count
    const resets = evs.filter((e) => e.event === "session-reset" && e.taskId === "T1");
    expect(resets).toHaveLength(1);
    expect(resets[0]!.data.tokens).toBe(50_000);
    expect(resets[0]!.data.threshold).toBe(1000);
    expect(resets[0]!.data.attempt).toBe(1); // the fresh attempt about to dispatch
    // reset is journaled before the retry's task-dispatch (retry-boundary, not mid-attempt)
    const resetIdx = evs.findIndex((e) => e.event === "session-reset" && e.taskId === "T1");
    const dispatch1Idx = evs.findIndex((e) => e.event === "task-dispatch" && e.taskId === "T1" && e.data.attempt === 1);
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(dispatch1Idx).toBeGreaterThan(resetIdx);
    // two dispatches — attempt 1 is the fresh session (new nonce/slot; no resume of the bloated one)
    const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches).toHaveLength(2);
    expect(dispatches.map((e) => e.data.retryMode)).toEqual(["fresh", "fresh"]);
    expect(resumed).toHaveLength(0);
    expect(Journal.open(repo, "run-sess-reset").readTelemetry().find((r) => r.taskId === "T1")!.retryMode).toBe("fresh");
  }, 30_000);

  test("an adapter without resumeCommand keeps an under-threshold retry fresh", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "fresh ok" } },
      ] } },
      "contextWarnTokens: 1000\n",
    );
    fake.contextUsage = () => ({ tokens: 500 });
    fake.resumeCommand = undefined;

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-sess-no-hook", driver: interactiveDriver() });

    expect(s.done).toEqual(["T1"]);
    const dispatches = Journal.open(repo, "run-sess-no-hook").read().filter((e) => e.event === "task-dispatch");
    expect(dispatches.map((e) => e.data.retryMode)).toEqual(["fresh", "fresh"]);
    expect(Journal.open(repo, "run-sess-no-hook").readTelemetry().find((r) => r.taskId === "T1")!.retryMode).toBe("fresh");
  }, 30_000);

  test("with no context data recorded, retry dispatch is unchanged from current behavior", async () => {
    // Default fake.contextUsage → null (unknown). No context-sample, no session-reset; retry is today.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "nothing" } }, // evidence fails → retry
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "retry ok" } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-sess-none" });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-sess-none").read();
    expect(evs.some((e) => e.event === "session-reset")).toBe(false);
    expect(evs.some((e) => e.event === "context-sample")).toBe(false);
    expect(evs.some((e) => e.event === "escalation" && e.data.step === "retry")).toBe(true);
    const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches).toHaveLength(2);
    for (const d of dispatches) {
      expect(Object.keys(d.data).sort()).toEqual(["assignment", "attempt", "provenance", "retryMode"]);
      expect(d.data.retryMode).toBe("fresh");
    }
  });

  // v1.24 T1 / OBS-20: consult reroute can ban a whole adapter via the existing tried-list (D-03).
  // Two-adapter fleet — cursor-agent ships two models (the OBS-20 shape); fake is the escape hatch
  // and also judge/consult. Per-adapter attempt counters mean separate scripts per instance.
  test("OBS-20: consult excludeAdapter bans every channel of that adapter on the next dispatch", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1", {
        // pin to cursor-agent; escalate:false so the ladder hits consult before another model is tried
        // (otherwise escalate would already leave the first model before the exclusion can prove itself)
        routingHints: { pin: { via: "cursor-agent", model: "composer" }, escalate: false },
      })],
      {
        consult: { action: "reroute", notes: "trust dialog blocks the CLI", excludeAdapter: "cursor-agent" },
        tasks: {
          // cursor-agent instance: two evidence fails → retry → consult
          T1: [
            { shell: "true", result: { ok: true, summary: "nothing 1" } },
            { shell: "true", result: { ok: true, summary: "nothing 2" } },
          ],
        },
      },
    );
    // fake adapter script: first (and only) attempt succeeds after the adapter-scoped reroute
    const fakeScript = join(tmpdir(), `tickmarkr-fake-esc-${Date.now()}.json`);
    writeFileSync(fakeScript, JSON.stringify({
      judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
      review: { approve: true, issues: [] },
      consult: { action: "reroute", notes: "trust dialog blocks the CLI", excludeAdapter: "cursor-agent" },
      tasks: {
        T1: [{ shell: `echo ok > f.txt && ${COMMIT} ok`, result: { ok: true, summary: "escaped cursor" } }],
      },
    }));

    // cursor models are both `sub` so channel-level nextChannel prefers composer-2.5 over fake (`api`)
    // — that is the OBS-20 failure mode the exclusion must prevent.
    const cursor = new NamedFake(scriptPath, "cursor-agent", ["composer", "composer-2.5"], "cursor", "sub");
    const fake = new NamedFake(fakeScript, "fake", ["fake-1"], "fake-a", "api");
    const s = await runDaemon(repo, { adapters: [cursor, fake], runId: "run-obs20-excl" });
    expect(s.done).toEqual(["T1"]);

    const evs = Journal.open(repo, "run-obs20-excl").read();
    const verdict = evs.find((e) => e.event === "consult-verdict" && e.taskId === "T1");
    expect(verdict?.data).toMatchObject({ action: "reroute", excludeAdapter: "cursor-agent" });

    const dispatches = evs
      .filter((e) => e.event === "task-dispatch" && e.taskId === "T1")
      .map((e) => e.data.assignment as { adapter: string; model: string });
    // first two on cursor-agent:composer (initial + retry); post-consult must leave the adapter entirely
    expect(dispatches[0]).toMatchObject({ adapter: "cursor-agent", model: "composer" });
    expect(dispatches[1]).toMatchObject({ adapter: "cursor-agent", model: "composer" });
    const postConsult = dispatches.slice(2);
    expect(postConsult.length).toBeGreaterThanOrEqual(1);
    // OBS-20 invariant: reroute away from cursor-agent can never land on another cursor-agent model
    expect(postConsult.every((a) => a.adapter !== "cursor-agent")).toBe(true);
    expect(postConsult.some((a) => a.adapter === "fake")).toBe(true);
    // specifically never the second model that pre-v1.24 nextChannel would have preferred
    expect(dispatches.some((a) => a.model === "composer-2.5")).toBe(false);
  });

  test("v1.24: adapter exclusion is task-scoped — a sibling task can still use the excluded adapter", async () => {
    const { repo, scriptPath } = setupRepo(
      [
        T("T1", { routingHints: { pin: { via: "cursor-agent", model: "composer" }, escalate: false } }),
        // T2 depends on T1 so it starts after T1's exclusion fired — still free to pin cursor-agent
        T("T2", { deps: ["T1"], routingHints: { pin: { via: "cursor-agent", model: "composer-2.5" } } }),
      ],
      {
        consult: { action: "reroute", notes: "ban cursor for T1 only", excludeAdapter: "cursor-agent" },
        tasks: {
          T1: [
            { shell: "true", result: { ok: true, summary: "n1" } },
            { shell: "true", result: { ok: true, summary: "n2" } },
          ],
          // T2 runs on the cursor-agent instance — first step succeeds
          T2: [{ shell: `echo t2 > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2 on cursor" } }],
        },
      },
    );
    const fakeScript = join(tmpdir(), `tickmarkr-fake-scope-${Date.now()}.json`);
    writeFileSync(fakeScript, JSON.stringify({
      judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
      review: { approve: true, issues: [] },
      consult: { action: "reroute", notes: "ban cursor for T1 only", excludeAdapter: "cursor-agent" },
      tasks: {
        T1: [{ shell: `echo t1 > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1 escaped" } }],
      },
    }));

    const cursor = new NamedFake(scriptPath, "cursor-agent", ["composer", "composer-2.5"], "cursor", "sub");
    const fake = new NamedFake(fakeScript, "fake", ["fake-1"], "fake-a", "api");
    const s = await runDaemon(repo, { adapters: [cursor, fake], runId: "run-excl-scope", concurrency: 1 });
    expect(s.done).toEqual(["T1", "T2"]);

    const evs = Journal.open(repo, "run-excl-scope").read();
    const t2 = evs
      .filter((e) => e.event === "task-dispatch" && e.taskId === "T2")
      .map((e) => e.data.assignment as { adapter: string; model: string });
    // T2 still routes to the adapter T1 banned — exclusion is per-task tried-list, not run-global
    expect(t2.length).toBeGreaterThanOrEqual(1);
    expect(t2[0].adapter).toBe("cursor-agent");
    expect(t2[0].model).toBe("composer-2.5");
  });

  test("v1.24: unknown excludeAdapter degrades to channel-level reroute (no crash, not human)", async () => {
    // Unknown adapter id → zero tried expansion → ordinary nextChannel over the current channel only.
    // With escalate:false and two cursor models + fake, post-consult lands on composer-2.5 (same adapter).
    const { repo, scriptPath } = setupRepo(
      [T("T1", { routingHints: { pin: { via: "cursor-agent", model: "composer" }, escalate: false } })],
      {
        consult: { action: "reroute", notes: "typo'd adapter", excludeAdapter: "not-a-real-adapter" },
        tasks: {
          T1: [
            { shell: "true", result: { ok: true, summary: "n1" } },
            { shell: "true", result: { ok: true, summary: "n2" } },
            // third dispatch (post-consult, still on cursor-agent:composer-2.5) succeeds on cursor instance
            { shell: `echo ok > f.txt && ${COMMIT} ok`, result: { ok: true, summary: "same-adapter model" } },
          ],
        },
      },
    );
    const fakeScript = join(tmpdir(), `tickmarkr-fake-unk-${Date.now()}.json`);
    writeFileSync(fakeScript, JSON.stringify({
      judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
      review: { approve: true, issues: [] },
      consult: { action: "reroute", notes: "typo'd adapter", excludeAdapter: "not-a-real-adapter" },
      tasks: { T1: [{ shell: "true", result: { ok: true, summary: "unused" } }] },
    }));

    const cursor = new NamedFake(scriptPath, "cursor-agent", ["composer", "composer-2.5"], "cursor", "sub");
    const fake = new NamedFake(fakeScript, "fake", ["fake-1"], "fake-a", "api");
    const s = await runDaemon(repo, { adapters: [cursor, fake], runId: "run-excl-unknown" });
    expect(s.done).toEqual(["T1"]);
    expect(s.human).toEqual([]); // never silently forced to human

    const dispatches = Journal.open(repo, "run-excl-unknown").read()
      .filter((e) => e.event === "task-dispatch" && e.taskId === "T1")
      .map((e) => e.data.assignment as { adapter: string; model: string });
    // channel-level only: post-consult stays on cursor-agent (composer-2.5) — the OBS-20 failure mode
    // when exclusion is absent/unknown. Proves we did NOT ban the whole adapter on a bad name.
    expect(dispatches.some((a) => a.adapter === "cursor-agent" && a.model === "composer-2.5")).toBe(true);
  });

  // v1.24 T2 / OBS-18: approve of an attempt-cap park must grant a fresh attempt budget so resume
  // dispatches instead of re-parking in the same tick. Tried-list survives — a channel burned before
  // the park is not re-tried first. Journal is seeded (10 dispatches at cap) so the suite stays zero-token.
  test("OBS-18: approve of attempt-cap park + resume dispatches with fresh budget, keeps tried", async () => {
    const fake1 = { adapter: "fake", model: "fake-1", channel: "sub" as const, tier: "frontier" as const };
    const fake2 = { adapter: "fake", model: "fake-2", channel: "api" as const, tier: "frontier" as const };
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "post-release done" } }] } },
    );

    // seed: 10 dispatches (attempt cap), first channel burned, last on fake-2, then park at cap
    const j = Journal.create(repo, "run-obs18-cap");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    for (let i = 0; i < 9; i++) j.append("task-dispatch", "T1", { assignment: fake1, attempt: i });
    j.append("consult-verdict", "T1", { action: "reroute", notes: "ban fake-1" });
    j.append("task-dispatch", "T1", { assignment: fake2, attempt: 9 });
    j.append("task-human", "T1", { reason: "attempt cap (10) reached", kind: "attempt-cap" });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));

    // without release: resume would re-park — pin the bug shape via replay (attempts ≥ 10)
    expect(Journal.open(repo, "run-obs18-cap").replayResumeState().get("T1")!.attempts).toBe(10);

    // real approve command stamps release:attempt-cap
    await approve(["run-obs18-cap", "T1", "--by", "test"], repo);
    const approved = Journal.open(repo, "run-obs18-cap").read().find((e) => e.event === "task-approved")!;
    expect(approved.data.release).toBe("attempt-cap");
    expect(Journal.open(repo, "run-obs18-cap").replayResumeState().get("T1")!.attempts).toBe(0);
    expect(Journal.open(repo, "run-obs18-cap").replayResumeState().get("T1")!.tried).toEqual([
      "fake:fake-1",
      "fake:fake-2",
    ]);

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-obs18-cap", resume: true });
    expect(s.done).toEqual(["T1"]); // RED on HEAD: re-parks as human in the same tick
    expect(s.human).toEqual([]);

    const all = Journal.open(repo, "run-obs18-cap").read();
    const resumeIdx = all.findIndex((e) => e.event === "run-resume");
    const post = all.slice(resumeIdx + 1);
    // no re-park at the attempt cap
    expect(post.some((e) => e.event === "task-human" && /attempt cap/.test(String(e.data.reason ?? "")))).toBe(false);
    const restores = post.filter((e) => e.event === "resume-restore" && e.taskId === "T1");
    expect(restores).toHaveLength(1);
    expect((restores[0]!.data as { attempts: number }).attempts).toBe(0); // fresh budget
    expect((restores[0]!.data as { tried: string[] }).tried).toEqual(["fake:fake-1", "fake:fake-2"]);

    const dispatches = post.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches.length).toBeGreaterThanOrEqual(1);
    expect((dispatches[0]!.data as { attempt: number }).attempt).toBe(0);
    // burned channels not re-tried first: both fake-1 and fake-2 are in tried ⇒ nextChannel null
    // falls back to static route (fake-1). That is the ponytail ceiling when the ladder is fully
    // burned — the invariant we pin is "tried survived" (above) and "dispatched" (done), not that
    // a third channel exists. When only one of two is burned, nextChannel skips it:
    // re-seed with only fake-1 burned for the skip oracle below.
  });

  test("OBS-18: released task does not re-try a burned channel first", async () => {
    // only fake-1 burned; fake-2 free — post-release nextChannel must skip fake-1
    const fake1 = { adapter: "fake", model: "fake-1", channel: "sub" as const, tier: "frontier" as const };
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "escaped burned" } }] } },
    );
    const j = Journal.create(repo, "run-obs18-tried");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    for (let i = 0; i < 10; i++) j.append("task-dispatch", "T1", { assignment: fake1, attempt: i });
    j.append("task-human", "T1", { reason: "attempt cap (10) reached", kind: "attempt-cap" });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));

    await approve(["run-obs18-tried", "T1", "--by", "test"], repo);

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-obs18-tried", resume: true });
    expect(s.done).toEqual(["T1"]);

    const all = Journal.open(repo, "run-obs18-tried").read();
    const resumeIdx = all.findIndex((e) => e.event === "run-resume");
    const post = all.slice(resumeIdx + 1);
    const first = post.find((e) => e.event === "task-dispatch" && e.taskId === "T1")!;
    const a = first.data.assignment as { adapter: string; model: string };
    // tried = [fake:fake-1]; lastAssignment cleared by release ⇒ nextChannel skips fake-1 ⇒ fake-2
    expect(`${a.adapter}:${a.model}`).toBe("fake:fake-2");
    // resume-restore seeds attempts:0 + the burned list; the chosen assignment is then appended
    // (pre-kill invariant: tried always contains the current assignment)
    const rd = post.find((e) => e.event === "resume-restore")!.data as { tried: string[]; attempts: number };
    expect(rd.attempts).toBe(0);
    expect(rd.tried[0]).toBe("fake:fake-1"); // burned channel remembered first — never forgotten
    expect(rd.tried).toContain("fake:fake-2"); // current (post-release) assignment also present
  });
});

// v1.53 T3: kimi resume through the daemon retry seam — adapter-declared session-id capture
// (sessionIdFrom) replaces the slot-name retry id, and the adapter-declared unknown-context opt-in
// (resumeUnknownContext) is what lets a contextUsage-less adapter (kimi, KIMI-03) resume at all.
// The fake is configured with kimi's exact declaration shape; kimiSessionId is the real capture fn.
describe("v1.53 kimi resume at the daemon retry seam (fake adapter, zero tokens)", () => {
  const KIMI_TRAILER = "To resume this session: kimi -r session_25e8efca-cc09-4dd6-9dee-1951aec28581";

  test("a captured session id replaces the slot name in the stored retry session", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        // attempt 0 echoes the kimi resume trailer, finishes, but commits nothing → evidence gate fails
        { shell: `echo ${shq(KIMI_TRAILER)}`, result: { ok: true, summary: "nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "resumed ok" } },
      ] } },
      "contextWarnTokens: 1000\n",
    );
    fake.contextUsage = () => ({ tokens: 500 }); // known under threshold — existing eligibility path
    fake.sessionIdFrom = kimiSessionId;
    const originalResume = fake.resumeCommand.bind(fake);
    const resumes: string[] = [];
    fake.resumeCommand = (sessionId, promptFile, model) => {
      resumes.push(sessionId);
      return originalResume(sessionId, promptFile, model);
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-kimi-capture", driver: interactiveDriver() });
    expect(s.done).toEqual(["T1"]);
    // the retry carried the id captured from attempt 0's output — not the harness slot name
    expect(resumes).toEqual(["session_25e8efca-cc09-4dd6-9dee-1951aec28581"]);
  }, 30_000);

  test("a gate-failed kimi retry on the same channel dispatches the resume command", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: `echo ${shq(KIMI_TRAILER)}`, result: { ok: true, summary: "nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "resumed ok" } },
      ] } },
    );
    // kimi's declaration shape: no contextUsage surface (KIMI-03), resume + capture + opt-in declared
    fake.contextUsage = undefined;
    fake.sessionIdFrom = kimiSessionId;
    fake.resumeUnknownContext = true;
    const originalResume = fake.resumeCommand.bind(fake);
    const resumes: string[] = [];
    fake.resumeCommand = (sessionId, promptFile, model) => {
      resumes.push(sessionId);
      return originalResume(sessionId, promptFile, model);
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-kimi-resume", driver: interactiveDriver() });
    expect(s.done).toEqual(["T1"]);
    expect(resumes).toEqual(["session_25e8efca-cc09-4dd6-9dee-1951aec28581"]); // resume command dispatched once
    const dispatches = Journal.open(repo, "run-kimi-resume").read().filter((e) => e.event === "task-dispatch");
    expect(dispatches.map((e) => e.data.retryMode)).toEqual(["fresh", "resume"]);
    expect(Journal.open(repo, "run-kimi-resume").readTelemetry().find((r) => r.taskId === "T1")!.retryMode).toBe("resume");
  }, 30_000);

  test("an adapter without the unknown context declaration still requires a known under threshold context to resume", async () => {
    // Unknown context + resumeCommand but NO resumeUnknownContext ⇒ both dispatches stay fresh.
    const noDecl = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "fresh ok" } },
      ] } },
    );
    noDecl.fake.contextUsage = undefined; // context unknowable, declaration absent
    const freshResumes: string[] = [];
    const originalNoDecl = noDecl.fake.resumeCommand.bind(noDecl.fake);
    noDecl.fake.resumeCommand = (sessionId, promptFile, model) => {
      freshResumes.push(sessionId);
      return originalNoDecl(sessionId, promptFile, model);
    };
    const s1 = await runDaemon(noDecl.repo, { adapters: [noDecl.fake], runId: "run-no-decl", driver: interactiveDriver() });
    expect(s1.done).toEqual(["T1"]);
    expect(freshResumes).toEqual([]); // never resumed without a known context
    const d1 = Journal.open(noDecl.repo, "run-no-decl").read().filter((e) => e.event === "task-dispatch");
    expect(d1.map((e) => e.data.retryMode)).toEqual(["fresh", "fresh"]);

    // Same declaration-less adapter WITH a known under-threshold context still resumes (unchanged v1.29 path).
    const known = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "resumed ok" } },
      ] } },
      "contextWarnTokens: 1000\n",
    );
    known.fake.contextUsage = () => ({ tokens: 500 });
    const s2 = await runDaemon(known.repo, { adapters: [known.fake], runId: "run-known-ctx", driver: interactiveDriver() });
    expect(s2.done).toEqual(["T1"]);
    const d2 = Journal.open(known.repo, "run-known-ctx").read().filter((e) => e.event === "task-dispatch");
    expect(d2.map((e) => e.data.retryMode)).toEqual(["fresh", "resume"]);
  }, 60_000);
});

// v1.25 T1: trust-dialog auto-answer is journaled (taskId + slot + adapter) so a live run proves the
// dialog appeared and was answered. Control flow (once-per-slot latch, sendKey, no-page) unchanged.
describe("v1.25 trust-auto-answer journal (fake adapter, zero tokens)", () => {
  test("matching trust dialog journals exactly one trust-auto-answer and does not page the operator", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: {
          T1: [{ shell: "true", result: { ok: true, summary: "done after trust" } }],
        },
        consult: { action: "human", notes: "ok" },
      },
      "taskTimeoutMinutes: 0.2\n",
    );
    const dialog = { fingerprint: "Workspace Trust Required", key: "Enter" };
    (fake as { trustDialog?: typeof dialog }).trustDialog = dialog;

    let phase: "dialog" | "working" = "dialog";
    let nonce = "";
    const keys: string[] = [];
    const notified: string[] = [];
    const inner = new SubprocessDriver();
    let answeredSlot = "";

    const driver = {
      id: "trust-scripted",
      interactive: true,
      slot: async (cwd: string, name: string) => ({ id: "p1", name, cwd }),
      run: async (_s: { id: string; name: string; cwd: string }, cmd: string) => {
        // v1.62 T1: the delivered line is a nonce-free script invocation — the trailer lives in the script
        const p = /^bash '(.+)'$/.exec(cmd)?.[1];
        const m = p ? /TICKMARKR_RESULT_([0-9a-z]+)/i.exec(readFileSync(p, "utf8")) : null;
        if (m) nonce = m[1];
      },
      waitOutput: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return phase === "working";
      },
      waitAgentStatus: async () => true,
      read: async () => {
        if (phase === "dialog") return "Workspace Trust Required\nTrust this folder?";
        return `working\nTICKMARKR_RESULT_${nonce} {"ok":true,"summary":"done after trust","deviations":[]}\n`;
      },
      status: async () => (phase === "dialog" ? "blocked" : "working"),
      sendKey: async (s: { id: string; name: string; cwd: string }, key: string) => {
        keys.push(key);
        answeredSlot = s.name; // the slot the daemon auto-answered — journal must name this exact pane
        phase = "working";
      },
      notify: async (msg: string) => { notified.push(msg); },
      close: async () => {},
      worktree: inner.worktree.bind(inner),
    };

    await runDaemon(repo, { adapters: [fake], runId: "run-trust-journal", driver });
    expect(keys).toEqual(["Enter"]);
    expect(notified.filter((m) => /blocked on a prompt|looks idle/.test(m))).toHaveLength(0);

    const events = Journal.open(repo, "run-trust-journal").read().filter((e) => e.event === "trust-auto-answer");
    expect(events).toHaveLength(1);
    expect(events[0]!.taskId).toBe("T1");
    expect(events[0]!.data.adapter).toBe("fake");
    expect(events[0]!.data.slot).toBe(answeredSlot);
    expect(answeredSlot).toMatch(/T1-worker-fake-/);
  }, 30_000);

  test("a run with no trust dialog journals zero trust-auto-answer events", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-no-trust-journal" });
    expect(s.done).toEqual(["T1"]);
    const events = Journal.open(repo, "run-no-trust-journal").read().filter((e) => e.event === "trust-auto-answer");
    expect(events).toHaveLength(0);
  });

  describe("OBS-28 run-end worktree cleanup", () => {
    test("a green run-end leaves zero worktrees for that runId under the state dir", async () => {
      const { repo, fake } = setupRepo(
        [T("T1"), T("T2", { deps: ["T1"] })],
        { tasks: {
          T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
          T2: [{ shell: `test -f t1.txt && echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
        } },
      );
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-wt-green" });
      expect(s.done).toEqual(["T1", "T2"]);
      expect(runWorktreeDirs(repo, s.branch)).toEqual([]);
    });

    test("with visibility.keepPanes: forever, run-end removes nothing", async () => {
      const { repo, fake } = setupRepo(
        [T("T1")],
        { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
        "visibility:\n  keepPanes: forever\n",
      );
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-wt-forever" });
      expect(s.done).toEqual(["T1"]);
      expect(runWorktreeDirs(repo, s.branch)).toEqual([
        sanitizeBranch(s.branch),
        `${sanitizeBranch(s.branch)}--T1`,
      ]);
      expect(existsSync(worktreePath(repo, s.branch))).toBe(true);
      expect(existsSync(worktreePath(repo, `${s.branch}--T1`))).toBe(true);
    });

    test("a run ending with a failed/blocked task keeps that task's worktree and removes only merged-done ones", async () => {
      const { repo, fake } = setupRepo(
        [T("T1"), T("T2")],
        {
          consult: { action: "human", notes: "conflicting edits need a person" },
          tasks: {
            // Keep both worktrees based on the same integration tip, but make the first merge
            // deterministic under full-suite load so this remains a cleanup oracle, not a race.
            T1: [{ shell: `sleep 0.2 && echo A > shared.txt && ${COMMIT} ta`, result: { ok: true, summary: "ta" } }],
            T2: [{ shell: `sleep 1.2 && echo B > shared.txt && ${COMMIT} tb`, result: { ok: true, summary: "tb" } }],
          },
        },
      );
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-wt-partial" });
      expect(s.done).toHaveLength(1);
      expect(s.human).toHaveLength(1);
      const doneId = s.done[0]!;
      const parkedId = s.human[0]!;
      expect(runWorktreeDirs(repo, s.branch)).toEqual([
        sanitizeBranch(s.branch),
        `${sanitizeBranch(s.branch)}--${parkedId}`,
      ]);
      expect(existsSync(worktreePath(repo, s.branch))).toBe(true);
      expect(existsSync(worktreePath(repo, `${s.branch}--${doneId}`))).toBe(false);
      expect(existsSync(worktreePath(repo, `${s.branch}--${parkedId}`))).toBe(true);
    });

    test("resume of a prior run whose worktrees were cleaned re-creates what it needs and completes", async () => {
      const { repo, fake, scriptPath } = setupRepo(
        [T("T1"), T("T2")],
        {
          consult: { action: "human", notes: "conflicting edits need a person" },
          tasks: {
            T1: [{ shell: `sleep 0.3 && echo A > shared.txt && ${COMMIT} ta`, result: { ok: true, summary: "ta" } }],
            T2: [{ shell: `sleep 0.3 && echo B > shared.txt && ${COMMIT} tb`, result: { ok: true, summary: "tb" } }],
          },
        },
      );
      const first = await runDaemon(repo, { adapters: [fake], runId: "run-wt-resume" });
      expect(first.done).toHaveLength(1);
      expect(first.human).toHaveLength(1);
      const parkedId = first.human[0]!;
      expect(existsSync(worktreePath(repo, `${first.branch}--${first.done[0]}`))).toBe(false);

      const script = JSON.parse(readFileSync(scriptPath, "utf8"));
      script.tasks[parkedId] = [{ shell: `echo fixed > other.txt && ${COMMIT} fix`, result: { ok: true, summary: "fixed" } }];
      writeFileSync(scriptPath, JSON.stringify(script));
      const graph = loadGraph(repo);
      saveGraph(repo, validateGraph({
        ...graph,
        tasks: graph.tasks.map((t) => t.id === parkedId ? { ...t, status: "pending" as const } : t),
      }));

      const resumed = await runDaemon(repo, { adapters: [new FakeAdapter(scriptPath)], runId: "run-wt-resume", resume: true });
      expect(resumed.done.sort()).toEqual(["T1", "T2"]);
      expect(runWorktreeDirs(repo, resumed.branch)).toEqual([]);
    });

    test("only worktrees recorded for THIS runId are touched — never another run's", async () => {
      const { repo, fake } = setupRepo(
        [T("T1"), T("T2")],
        {
          consult: { action: "human", notes: "conflicting edits need a person" },
          tasks: {
            T1: [{ shell: `sleep 0.3 && echo A > shared.txt && ${COMMIT} ta`, result: { ok: true, summary: "ta" } }],
            T2: [{ shell: `sleep 0.3 && echo B > shared.txt && ${COMMIT} tb`, result: { ok: true, summary: "tb" } }],
          },
        },
      );
      const partial = await runDaemon(repo, { adapters: [fake], runId: "run-wt-keep" });
      expect(partial.done).toHaveLength(1);
      expect(partial.human).toHaveLength(1);
      const keptDirs = runWorktreeDirs(repo, partial.branch);
      expect(keptDirs.length).toBeGreaterThan(0);

      saveGraph(repo, validateGraph({
        version: 1,
        spec: { source: "prd", paths: ["p"], hash: "h2" },
        tasks: [T("T1")],
      }));
      const green = await runDaemon(repo, { adapters: [fake], runId: "run-wt-clean" });
      expect(green.done).toEqual(["T1"]);
      expect(runWorktreeDirs(repo, green.branch)).toEqual([]);
      expect(runWorktreeDirs(repo, partial.branch)).toEqual(keptDirs);
    });
  });

  describe("OBS-34 integration-tip verify", () => {
    const passTest = "node -e \"process.exit(0)\"";
    const failOutput = `integration tip error\n${"x".repeat(20_000)}\n`;
    const failTest = `node -e ${shq(`process.stderr.write(${JSON.stringify(failOutput)}); process.exit(1);`)}`;

    test("merged tip passing emits tip-verify events then a green run-end", async () => {
      const { repo, fake } = setupRepo(
        [T("T1"), T("T2", { deps: ["T1"] })],
        { tasks: {
          T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
          T2: [{ shell: `test -f t1.txt && echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
        } },
      );
      addGateScripts(repo, passTest);
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-tip-pass" });
      expect(s.done).toEqual(["T1", "T2"]);
      expect(s.tipVerify).toBe("passed");
      const events = Journal.open(repo, "run-tip-pass").read();
      expect(events.filter((e) => e.event === "tip-verify")).toHaveLength(1);
      expect(events.some((e) => e.event === "tip-verify-failed")).toBe(false);
      expect(readdirSync(Journal.open(repo, "run-tip-pass").dir).filter((name) => name.startsWith("tip-verify-"))).toEqual([]);
      const end = events.find((e) => e.event === "run-end");
      expect(end?.data.tipVerify).toBe("passed");
      expect(events.findIndex((e) => e.event === "tip-verify")).toBeLessThan(events.findIndex((e) => e.event === "run-end"));
    });

    test("merged tip failing emits tip-verify-failed and run-end carries tipVerify failed with last-merged task", async () => {
      const { repo, fake } = setupRepo(
        [T("T1"), T("T2", { deps: ["T1"] })],
        { tasks: {
          T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
          T2: [{ shell: `echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
        } },
      );
      addGateScripts(repo, failTest);
      const notifies: string[] = [];
      const driver = new SubprocessDriver();
      driver.notify = async (msg) => { notifies.push(msg); };
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-tip-fail", driver });
      expect(s.done).toEqual(["T1", "T2"]);
      expect(s.tipVerify).toBe("failed");
      expect(s.lastMergedTask).toBe("T2");
      const events = Journal.open(repo, "run-tip-fail").read();
      const fail = events.find((e) => e.event === "tip-verify-failed");
      expect(fail).toBeDefined();
      expect(fail!.data.gate).toBe("test");
      expect(fail!.data.cmd).toContain("npm run");
      expect(Array.isArray(fail!.data.fingerprints)).toBe(true);
      expect((fail!.data.fingerprints as string[]).length).toBeGreaterThan(0);
      expect(fail!.data.lastMergedTask).toBe("T2");
      const artifact = join(Journal.open(repo, "run-tip-fail").dir, "tip-verify-test.log");
      expect(readFileSync(artifact, "utf8")).toBe(`\n${failOutput}`);
      expect(fail!.data.artifact).toBe(artifact);
      const end = events.find((e) => e.event === "run-end");
      expect(end?.data.tipVerify).toBe("failed");
      expect(end?.data.lastMergedTask).toBe("T2");
      expect(notifies.some((m) => /TIP VERIFY FAILED/i.test(m) && /T2/.test(m))).toBe(true);
      expect(events.filter((e) => e.event === "gate-result" && e.data.gate === "test" && e.data.pass === true).length).toBeGreaterThan(0);
    });

    test("resume after tip-verify-failed re-runs tip verify only and ends green", async () => {
      const { repo, fake } = setupRepo(
        [T("T1")],
        { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
      );
      addGateScripts(repo, failTest);
      const first = await runDaemon(repo, { adapters: [fake], runId: "run-tip-resume" });
      expect(first.tipVerify).toBe("failed");
      addGateScripts(worktreePath(repo, first.branch), passTest);
      const resumed = await runDaemon(repo, { adapters: [fake], runId: "run-tip-resume", resume: true });
      expect(resumed.tipVerify).toBe("passed");
      const slice = Journal.open(repo, "run-tip-resume").read();
      const resumeIdx = slice.findIndex((e) => e.event === "run-resume");
      const afterResume = slice.slice(resumeIdx);
      expect(afterResume.some((e) => e.event === "task-dispatch")).toBe(false);
      expect(afterResume.filter((e) => e.event === "tip-verify")).toHaveLength(1);
      expect(afterResume.find((e) => e.event === "run-end")?.data.tipVerify).toBe("passed");
    });

    test("zero merged tasks skips tip verify", async () => {
      const { repo, fake } = setupRepo(
        [T("T1", { humanGate: true })],
        { tasks: {} },
      );
      addGateScripts(repo, passTest);
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-tip-skip" });
      expect(s.done).toEqual([]);
      expect(s.tipVerify).toBeUndefined();
      const events = Journal.open(repo, "run-tip-skip").read();
      expect(events.some((e) => e.event === "tip-verify" || e.event === "tip-verify-failed")).toBe(false);
      expect(events.find((e) => e.event === "run-end")?.data.tipVerify).toBeUndefined();
    });
  });
});

// v1.39 OBS-37b: per-task timeoutMinutes overrides config taskTimeoutMinutes for that task only.
describe("per-task timeout override (OBS-37b)", () => {
  test("shorter task override times out before the config default would", async () => {
    const t0 = Date.now();
    const { repo, fake } = setupRepo(
      [T("T1", { timeoutMinutes: 0.02 })],
      { tasks: { T1: [{ shell: "sleep 30" }] }, consult: { action: "human", notes: "stalled" } },
      "taskTimeoutMinutes: 5\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-timeout-short" });
    expect(s.human).toEqual(["T1"]);
    expect(Date.now() - t0).toBeLessThan(5_000); // config default 5m would not fire this fast
    const row = Journal.open(repo, "run-timeout-short").readTelemetry().find((r) => r.taskId === "T1")!;
    expect(row.overrun).toBe(true);
  }, 30_000);

  test("longer task override completes when config default would have timed out", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { timeoutMinutes: 0.15 })],
      { tasks: { T1: [{ shell: `sleep 3 && echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "slow but ok" } }] } },
      "taskTimeoutMinutes: 0.02\nvisibility:\n  worker: print\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-timeout-long" });
    expect(s.done).toEqual(["T1"]);
    const wr = Journal.open(repo, "run-timeout-long").read().find((e) => e.event === "worker-result");
    expect(wr?.data.finished).toBe(true);
  }, 30_000);

  test("tasks without override keep config-default timeout behavior", async () => {
    const t0 = Date.now();
    const { repo, fake } = setupRepo(
      [T("T1", { timeoutMinutes: 0.02 }), T("T2")],
      {
        tasks: {
          T1: [{ shell: "sleep 30" }],
          T2: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "default window" } }],
        },
        consult: { action: "human", notes: "stalled" },
      },
      "taskTimeoutMinutes: 5\nvisibility:\n  worker: print\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-timeout-default" });
    expect(s.human).toEqual(["T1"]);
    expect(s.done).toEqual(["T2"]);
    expect(Date.now() - t0).toBeLessThan(8_000); // T1 short override; T2 uses 5m default and finishes quickly
  }, 30_000);

  test("OBS-58: a retry worktree recreation carries a prior attempt's cleanly-applying commit forward", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: `echo carried > kept.txt && ${COMMIT} carry && echo 'usage limit reached for this model'; exit 1` },
        { shell: `test -f kept.txt && echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-obs58-carry" });
    expect(s.done).toEqual(["T1"]);
    const recreation = Journal.open(repo, "run-obs58-carry").read().find((e) => e.event === "worktree-recreation");
    expect(recreation).toBeDefined();
    expect(recreation!.data.carried).toEqual(recreation!.data.attempted);
    expect((recreation!.data.carried as string[]).length).toBe(1);
  });

  test("OBS-58: the retry brief names prior attempt commits by hash", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: `echo carried > kept.txt && ${COMMIT} carry && echo 'usage limit reached for this model'; exit 1` },
        { shell: `test -f kept.txt && echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } },
      ] } },
    );
    const runId = "run-obs58-hash";
    const s = await runDaemon(repo, { adapters: [fake], runId });
    expect(s.done).toEqual(["T1"]);
    const carried = (Journal.open(repo, runId).read().find((e) => e.event === "worktree-recreation")!.data.carried as string[])[0];
    const retryPrompt = readFileSync(join(tickmarkrDir(repo), "runs", runId, "prompts", "T1-a1.md"), "utf8");
    expect(retryPrompt).toContain("## Prior attempt commits (by hash)");
    expect(retryPrompt).toContain(carried);
    expect(retryPrompt).toContain("— present in this worktree");
  });

  test("OBS-58: a brief premise asserting a commit that the fresh worktree lacks is corrected before dispatch", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: { T1: [
          { shell: `echo v1 > impl.txt && ${COMMIT} impl && sleep 30` },
          { shell: `echo v2 > impl.txt && ${COMMIT} done`, result: { ok: true, summary: "ok" } },
        ] },
        consult: { action: "retry", guidance: "The src implementation is already committed — verify and emit the trailer." },
      },
      "taskTimeoutMinutes: 0.005\n",
    );
    const inner = new SubprocessDriver();
    const runId = "run-obs58-premise";
    const intBranch = `tickmarkr/${runId}`;
    let closed = 0;
    const driver = {
      id: "subprocess",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      async close(slot: { id: string; name: string; cwd: string }) {
        await inner.close(slot);
        if (++closed === 1) {
          const intWt = worktreePath(repo, intBranch);
          writeFileSync(join(intWt, "impl.txt"), "conflict\n");
          await shOk(`git add impl.txt && ${COMMIT} integration-conflict`, intWt);
        }
      },
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId, driver });
    expect(s.done).toEqual(["T1"]);
    const recreation = Journal.open(repo, runId).read().find((e) => e.event === "worktree-recreation")!;
    expect(recreation.data.carried).toEqual([]);
    expect((recreation.data.attempted as string[]).length).toBeGreaterThan(0);
    const retryPrompt = readFileSync(join(tickmarkrDir(repo), "runs", runId, "prompts", "T1-a1.md"), "utf8");
    expect(retryPrompt).toContain("could not be carried forward");
    expect(retryPrompt).not.toMatch(/already committed/i);
  }, 30_000);
});

// v1.54 T2 (OBS-71): the termination reaper's handlers are scoped to one runDaemon call — this suite
// runs the daemon dozens of times in one process, so a leaked handler would close a later run's slots.
test("the signal handlers are removed after a normal run end", async () => {
  const { repo, fake } = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
  );
  const count = () => ({ int: process.listeners("SIGINT").length, term: process.listeners("SIGTERM").length });
  const before = count();
  const inner = new SubprocessDriver();
  let during: ReturnType<typeof count> | undefined;
  const driver = {
    id: "listener-spy",
    interactive: false,
    status: inner.status.bind(inner),
    async slot(cwd: string, name: string) {
      during ??= count(); // sampled mid-run, at the first worker dispatch
      return inner.slot(cwd, name);
    },
    run: inner.run.bind(inner),
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  };
  const s = await runDaemon(repo, { adapters: [fake], runId: "run-sig-removed", driver });
  expect(s.done).toEqual(["T1"]);
  expect(during).toEqual({ int: before.int + 1, term: before.term + 1 }); // registered while the run was live
  expect(count()).toEqual(before); // and removed after the normal run end
});

describe("OBS-82 spinner-blind stall, headless site (fake adapter, zero tokens)", () => {
  // Mirror of the interactive test in daemon-interactive.test.ts: every poll returns a raw-unique
  // frame (glyph + elapsed-time repaint) that normalizes constant, so the headless inactivity
  // budget must expire. Only the worker slot is scripted — consult reads stay real.
  test("spinner only repaints do not reset the headless stall clock", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "sleep 30" }] }, consult: { action: "human", notes: "spinner wedge" } },
      "taskTimeoutMinutes: 0.02\nvisibility:\n  worker: print\n",
    );
    const inner = new SubprocessDriver();
    const glyphs = ["⠋", "⠙", "⠸", "⠴", "⠦", "⠇"];
    let n = 0;
    const driver = {
      id: "subprocess",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: (slot: Slot, lines?: number) =>
        slot.name.includes("-worker-")
          ? Promise.resolve(`${glyphs[++n % glyphs.length]} Starting MCP servers (5/7): context7, sites-design-picker · ${n}s · esc to interrupt`)
          : inner.read(slot, lines),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-spin-print", driver });
    expect(s.human).toEqual(["T1"]);
    expect(Journal.open(repo, "run-spin-print").read().find((e) => e.event === "worker-result")?.data.cause).toBe("stall-timeout");
  }, 30_000);
});

describe("v1.76 progress-based stall watchdog (fake adapter, zero tokens)", () => {
  test("test: a worker pane emitting only cursor and status-bar repaints past the stall threshold triggers the stall escalation", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "sleep 30" }] }, consult: { action: "human", notes: "repaint-only pane" } },
      "taskTimeoutMinutes: 0.005\nvisibility:\n  worker: print\n",
    );
    const inner = new SubprocessDriver();
    let workerReads = 0;
    const driver = {
      id: "subprocess",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: async (slot: Slot, pattern: string, ms: number, opts?: { regex?: boolean }) => {
        if (!slot.name.includes("-worker-")) return inner.waitOutput(slot, pattern, ms, opts);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return false;
      },
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: (slot: Slot, lines?: number) => {
        if (!slot.name.includes("-worker-")) return inner.read(slot, lines);
        workerReads++;
        const repaint = Math.min(workerReads, 20);
        return Promise.resolve([
          "seed accepted",
          "────────────────────────",
          `agent idle · context 0% · cursor row ${repaint}`,
        ].join("\n"));
      },
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };

    const summary = await runDaemon(repo, { adapters: [fake], runId: "run-chrome-repaint", driver });

    expect(summary.human).toEqual(["T1"]);
    expect(workerReads).toBeLessThan(20); // watchdog fired while the repaint stream was still changing
    expect(Journal.open(repo, "run-chrome-repaint").read().find((e) => e.event === "worker-result")?.data.cause).toBe("stall-timeout");
  }, 30_000);

  test("test: a worker making real transcript progress at the same cadence does not trigger it", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{
        shell: `for n in 1 2 3 4 5; do echo "completed transcript step $n"; sleep 0.15; done; echo done > done.txt && ${COMMIT} done`,
        result: { ok: true, summary: "transcript kept growing" },
      }] } },
      "taskTimeoutMinutes: 0.005\nvisibility:\n  worker: print\n",
    );

    const summary = await runDaemon(repo, { adapters: [fake], runId: "run-transcript-progress" });

    expect(summary.done).toEqual(["T1"]);
    const result = Journal.open(repo, "run-transcript-progress").read().find((e) => e.event === "worker-result");
    expect(result?.data.finished).toBe(true);
    expect(result?.data.cause).toBeUndefined();
  }, 30_000);
});

describe("OBS-117 early-launch liveness (fake adapter, zero tokens)", () => {
  const SETUP_FAIL = "echo 'zsh: command not found: codex'; exit 1";

  test("test: the silent-launch fast path keeps its existing shorter deadline and error", async () => {
    setEarlyLaunchLivenessMsForTests(50);
    try {
      const stall = setupRepo(
        [T("T1")],
        {
          tasks: {
            T1: [
              { shell: SETUP_FAIL },
              { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "recovered" } },
            ],
          },
        },
        "taskTimeoutMinutes: 5\nvisibility:\n  worker: print\n",
      );
      await runDaemon(stall.repo, { adapters: [stall.fake], runId: "run-stall-setup" });
      const stallFo = Journal.open(stall.repo, "run-stall-setup").read()
        .find((e) => e.event === "dead-channel-failover")!.data;

      const early = setupRepo(
        [T("T1")],
        {
          tasks: {
            T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "recovered" } }],
          },
        },
        "taskTimeoutMinutes: 5\nvisibility:\n  worker: print\n",
      );
      const inner = new SubprocessDriver();
      let workerRuns = 0;
      const driver = {
        id: "subprocess",
        interactive: false,
        status: inner.status.bind(inner),
        slot: inner.slot.bind(inner),
        run: async (slot: Slot, cmd: string) => {
          if (slot.name.includes("-worker-")) workerRuns++;
          return inner.run(slot, cmd);
        },
        waitOutput: async (slot: Slot, pattern: string, ms: number, opts?: { regex?: boolean }) =>
          workerRuns > 1 ? inner.waitOutput(slot, pattern, ms, opts) : false,
        waitAgentStatus: inner.waitAgentStatus.bind(inner),
        read: (slot: Slot, lines?: number) =>
          slot.name.includes("-worker-") && workerRuns === 1
            ? Promise.resolve("")
            : inner.read(slot, lines),
        notify: inner.notify.bind(inner),
        close: inner.close.bind(inner),
        worktree: inner.worktree.bind(inner),
      };
      await runDaemon(early.repo, { adapters: [early.fake], runId: "run-early-setup", driver });
      const earlyFo = Journal.open(early.repo, "run-early-setup").read()
        .find((e) => e.event === "dead-channel-failover")!.data;

      expect(earlyFo.reason).toBe(stallFo.reason);
      expect(earlyFo.reason).toBe("setup-required");
      expect(earlyFo.from).toBe(stallFo.from);
      expect(earlyFo.to).toBe(stallFo.to);
      expect(Object.keys(earlyFo).sort()).toEqual(Object.keys(stallFo).sort());
    } finally {
      resetEarlyLaunchLivenessMsForTests();
    }
  }, 30_000);

  test("stall thresholds and their configuration surface are unchanged", () => {
    expect(EARLY_LAUNCH_LIVENESS_MS).toBe(60_000);
    expect(DEFAULT_CONFIG.taskTimeoutMinutes).toBe(30);
    expect(DEFAULT_CONFIG.consult.stallMinutes).toBe(15);
    expect(Object.keys(DEFAULT_CONFIG).filter((key) => /stall|timeout/i.test(key))).toEqual(["taskTimeoutMinutes"]);
  });

  test("the early check adds no new polling timer beyond the existing stall-wait poll cadence", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src/run/daemon.ts"), "utf8");
    expect(src).not.toMatch(/\bsetInterval\s*\(/);
    expect(src).toMatch(/earlyLaunchLivenessMs/);
    expect(src).toMatch(/!everHadOutput && Date\.now\(\) - attemptStart >= earlyLaunchLivenessMs/);
    expect(src).not.toMatch(/setTimeout\([^)]*earlyLaunch/);
  });
});

// T1 (OBS-262/263, speed-spec §2): stall detection notices a dead or silent worker in minutes.
// Interactive-driver integration tests over the scripted fake adapter — zero tokens, real worktrees.
describe("T1 stall detection (OBS-262/263, fake adapter, zero tokens)", () => {
  // a stalled interactive TUI: prints once (early-launch liveness passes), never emits a trailer
  const STALLED = {
    consult: { action: "human", notes: "stalled worker" },
    tasks: { T1: [{ shell: "echo working-on-it" }] },
  };
  const idriver = (overrides: Record<string, unknown> = {}): ExecutorDriver => {
    const inner = new SubprocessDriver();
    return {
      id: "t1-stall-fake",
      interactive: true,
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: async () => { await new Promise((r) => setTimeout(r, 50)); return false; },
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: async () => "working-on-it",
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      status: async () => "working",
      ...overrides,
    } as ExecutorDriver;
  };

  test("test: a worker silent on the monotonic tracker for ten minutes is nudged even while its herdr status reads working, and the nudge is journaled", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(200, 400); // seam for the 10m gate / 4m grace — behavior under test is status-blindness
    // Both seams scale TOGETHER so the ordering is what is proven: the fast-kill window sits BELOW
    // the nudge gate (its shipped 5m is below the nudge's 10m too), and a nudgeable pane must still
    // be nudged first — the kill holds while the daemon has an action of its own pending.
    setDeadChannelFastKillMsForTests(50);
    try {
      const nudges: string[] = [];
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED);
      const driver = idriver({
        status: async () => "working", // the reading that used to hold the nudge gate hostage
        nudge: async (_slot: unknown, message: string) => { nudges.push(message); return true; },
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-nudge-working", driver });
      expect(s.human).toEqual(["T1"]); // unanswered nudge → grace expiry → stall consult parks human
      expect(nudges).toEqual([WORKER_NUDGE_MESSAGE]); // one nudge per attempt, fired under "working"
      const evs = Journal.open(repo, "run-t1-nudge-working").read();
      expect(evs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-nudge-expired" && e.taskId === "T1")).toHaveLength(1);
      // the fast-kill seam expired long before the nudge gate — and never fired: the nudge got first crack
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0);
      // status is journaled on change (T1 review — per-slice appends flooded the live surface),
      // and every journaled sample read "working"
      const samples = evs.filter((e) => e.event === "worker-status" && e.taskId === "T1");
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every((e) => e.data.status === "working")).toBe(true);
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
      resetNudgeTimingForTests();
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  test("test: a second page fires after a first — deleting the paged latch is proven by two journaled pages in one attempt", async () => {
    // adapter "fake" is NOT nudge-allowlisted and the driver has no nudge surface: an idle pane is
    // the operator's to unblock, so the page fires — journaled every slice AND delivered again on
    // the repeat cadence. The status never changes here, so a status latch would deliver once.
    setPageRepeatMsForTests(500); // seam for the 2m operator-spam cadence (shipped 2m sits below the 5m fast-kill)
    try {
      const notifies: string[] = [];
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED);
      const driver = idriver({
        status: async () => "idle",
        notify: async (msg: string) => { notifies.push(msg); },
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-pages", driver });
      expect(s.human).toEqual(["T1"]);
      const pages = Journal.open(repo, "run-t1-pages").read()
        .filter((e) => e.event === "operator-page" && e.taskId === "T1");
      expect(pages.length).toBeGreaterThanOrEqual(2); // a second page fired after a first …
      expect(new Set(pages.map((e) => e.data.attempt)).size).toBe(1); // … within ONE attempt
      // … and the second page reached the operator, not just the journal (the latch is gone)
      expect(notifies.filter((m) => /looks idle without finishing/.test(m)).length).toBeGreaterThanOrEqual(2);
    } finally {
      resetPageRepeatMsForTests();
    }
  }, 120_000);

  test("test: a quota banner matched on two consecutive slices with three minutes of tracker silence fails the attempt over without waiting out the window", async () => {
    setQuotaBannerSilentMsForTests(1_500); // seam for the 3m silence gate
    try {
      const { repo, fake } = setupRepo(
        [T("T1", { timeoutMinutes: 5 })], // a 5m window: finishing inside the 120s test timeout proves the window was NOT waited out
        { tasks: { T1: [
          { shell: "echo 'usage limit reached for this model'" }, // channel A: quota banner, no trailer
          { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "recovered on B" } },
        ] } },
      );
      const inner = new SubprocessDriver();
      let workerRuns = 0;
      let bannerReads = 0;
      const driver = {
        id: "t1-quota-fake",
        interactive: true,
        slot: inner.slot.bind(inner),
        run: async (slot: Slot, cmd: string) => {
          if (slot.name.includes("-worker-")) workerRuns++;
          return inner.run(slot, cmd);
        },
        waitOutput: async (slot: Slot, pattern: string, ms: number, opts?: { regex?: boolean }) =>
          workerRuns > 1 ? inner.waitOutput(slot, pattern, ms, opts) : false,
        waitAgentStatus: inner.waitAgentStatus.bind(inner),
        read: (slot: Slot, lines?: number) => {
          // the banner printed AFTER a benign launch frame classifies; the mirror test below
          // proves arrival order no longer matters — chrome is filtered by identity, not novelty
          if (slot.name.includes("-worker-") && workerRuns === 1) {
            bannerReads++;
            return Promise.resolve(bannerReads <= 2
              ? "composing a plan for the task"
              : "claude ai usage limit reached for this model\nresets at 5pm"); // the banner IS output
          }
          return inner.read(slot, lines);
        },
        notify: inner.notify.bind(inner),
        close: inner.close.bind(inner),
        worktree: inner.worktree.bind(inner),
        status: async () => "working",
      };
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-quota", driver });
      expect(s.done).toEqual(["T1"]); // channel B carried it to done — A failed over, not consulted
      const evs = Journal.open(repo, "run-t1-quota").read();
      expect(evs.filter((e) => e.event === "quota-banner" && e.taskId === "T1")).toHaveLength(1);
      const failover = evs.find((e) => e.event === "quota-failover" && e.taskId === "T1");
      expect(failover).toBeDefined();
      expect(failover!.data.from).not.toBe(failover!.data.to);
    } finally {
      resetQuotaBannerSilentMsForTests();
    }
  }, 120_000);

  // Mirror of the criterion above (T1 review, material): the banner is on screen from the FIRST
  // read the daemon ever makes — a channel throttled at launch paints it before the first poll.
  // A novelty baseline anchored on that first frame exculpated exactly this case forever (proven
  // by execution: this driver shape yields {done:["T1"], quotaFailover:1} on shipped 843328b0 and
  // {human:["T1"], quotaFailover:0} under the baseline). Chrome is filtered by identity now, so
  // the banner classifies however early it arrived — quota failover is free and never waits the
  // rolling window out (criterion 6).
  test("a quota banner present from the first loop read fails the attempt over — the launch-time-throttle mirror", async () => {
    setQuotaBannerSilentMsForTests(1_500); // seam for the 3m silence gate
    try {
      const { repo, fake } = setupRepo(
        [T("T1", { timeoutMinutes: 5 })], // 5m window: finishing inside the 120s timeout proves it was NOT waited out
        { tasks: { T1: [
          { shell: "echo 'usage limit reached for this model'" }, // channel A: throttled at launch, no trailer
          { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "recovered on B" } },
        ] } },
      );
      const inner = new SubprocessDriver();
      let workerRuns = 0;
      const driver = {
        id: "t1-quota-launch-fake",
        interactive: true,
        slot: inner.slot.bind(inner),
        run: async (slot: Slot, cmd: string) => {
          if (slot.name.includes("-worker-")) workerRuns++;
          return inner.run(slot, cmd);
        },
        waitOutput: async (slot: Slot, pattern: string, ms: number, opts?: { regex?: boolean }) =>
          workerRuns > 1 ? inner.waitOutput(slot, pattern, ms, opts) : false,
        waitAgentStatus: inner.waitAgentStatus.bind(inner),
        read: (slot: Slot, lines?: number) =>
          // the banner IS the launch frame and every frame after — the exact shape a baseline
          // anchored on the first rendered frame swallowed
          slot.name.includes("-worker-") && workerRuns === 1
            ? Promise.resolve("claude ai usage limit reached for this model\nresets at 5pm")
            : inner.read(slot, lines),
        notify: inner.notify.bind(inner),
        close: inner.close.bind(inner),
        worktree: inner.worktree.bind(inner),
        status: async () => "working",
      };
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-quota-launch", driver });
      expect(s.done).toEqual(["T1"]); // channel B carried it to done — the shipped behavior the baseline regressed
      const evs = Journal.open(repo, "run-t1-quota-launch").read();
      expect(evs.filter((e) => e.event === "quota-banner" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.some((e) => e.event === "quota-failover" && e.taskId === "T1")).toBe(true);
      expect(Journal.open(repo, "run-t1-quota-launch").readTelemetry().filter((r) => r.quotaFailover === true)).toHaveLength(1);
    } finally {
      resetQuotaBannerSilentMsForTests();
    }
  }, 120_000);

  test("test: a worker with no trailer, no worktree delta and no output growth for five minutes is concluded dead and journaled as such", async () => {
    setDeadChannelFastKillMsForTests(1_500); // seam for the 5m fast-kill window
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], STALLED); // 5m window; the 120s test timeout proves the kill was fast
      const driver = idriver({ status: async () => "working" }); // constant pane text: zero output growth
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-dead", driver });
      expect(s.human).toEqual(["T1"]); // concluded dead → stall consult parks human
      const evs = Journal.open(repo, "run-t1-dead").read();
      const dead = evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1");
      expect(dead).toHaveLength(1);
      expect(dead[0]!.data.attempt).toBe(0);
      // the dead conclusion precedes the worker-result harvest in the stream
      expect(evs.findIndex((e) => e.event === "worker-dead" && e.taskId === "T1"))
        .toBeLessThan(evs.findIndex((e) => e.event === "worker-result" && e.taskId === "T1"));
    } finally {
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // The fast-kill's growth signal is the monotonic tracker, never raw pane bytes. This is the
  // exact OBS-262 blindness in miniature: the pane below is FROZEN — its only change per slice is
  // the elapsed counter ticking inside one repainting row, which lengthens the raw read while the
  // transcript occupies no new rows. A fast-kill clocked on raw pane length would read that tick
  // as growth and hold the window open forever; the tracker normalizes the elapsed token away and
  // condemns it. Behavioral on purpose — a source grep pins the spelling, not the property.
  test("a pane whose only change is a ticking elapsed counter is still fast-killed — raw byte growth is not progress", async () => {
    setDeadChannelFastKillMsForTests(1_500);
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], STALLED); // 5m window; the kill lands in seconds
      let tick = 0;
      const driver = idriver({
        status: async () => "working",
        // one row, same width class, strictly longer bytes each read: "⠋ thinking (9s)" → "(10s)" → …
        read: async () => `⠋ thinking (${9 + tick++}s • esc to interrupt)`,
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-tick", driver });
      expect(s.human).toEqual(["T1"]);
      const evs = Journal.open(repo, "run-t1-tick").read();
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(1);
      expect(tick).toBeGreaterThan(1); // the pane really did repaint a longer line between slices
    } finally {
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // The dead-channel triad has no status exemption. A `blocked` reading is exactly the status a
  // wedged TUI scrapes as, so exempting it would let the worst stall class wait the rolling window
  // out on a status reading — the blindness T1 exists to delete. The operator is still paged; the
  // page and the kill are not alternatives.
  test("a blocked pane holding the dead-channel triad is fast-killed too, and paged on the way out", async () => {
    setDeadChannelFastKillMsForTests(1_500);
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], STALLED); // 5m window; the kill lands in seconds
      const driver = idriver({ status: async () => "blocked", notify: async () => {} });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-blocked", driver });
      expect(s.human).toEqual(["T1"]);
      const evs = Journal.open(repo, "run-t1-blocked").read();
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(1);
      const pages = evs.filter((e) => e.event === "operator-page" && e.taskId === "T1");
      expect(pages.length).toBeGreaterThan(0);
      expect(pages.every((e) => e.data.status === "blocked")).toBe(true);
    } finally {
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // T1 review (read-ceiling blindness): the tracker's row signal saturates once a sample FILLS
  // the bounded read on RAW lines (blanks and chrome-only rows included) — past that, a flat
  // tracker means "unmeasurable", not "dead". For UNMETERED adapters (no contextUsage: codex,
  // cursor-agent, grok, opencode — the exact non-nudgeable set this kill governs) rows are the
  // only liveness signal, so a live worker past the ceiling would be concluded dead mid-work.
  // The kill must stand down on a saturated row signal (journaled once) and let the rolling
  // window own the pane, as pre-T1.
  test("a saturated row signal stands the fast-kill down — a live pane past the read ceiling is never concluded dead", async () => {
    setDeadChannelFastKillMsForTests(1_500); // kill seam far below the 6s window: without the stand-down, worker-dead fires
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED);
      // a constant FULL read window in the shape a production `read(slot, PANE_READ_ROWS)`
      // actually returns: exactly PANE_READ_ROWS raw lines, blank rows included (measured
      // 730 non-empty of 1000 on the codex-mcp-spinner fixture). Frozen-looking to the row
      // high-water, but only because the signal is blind — and the non-empty count sits BELOW
      // the ceiling, so only a raw-window saturation check can stand the kill down here.
      const saturatedPane = Array.from({ length: PANE_READ_ROWS }, (_, i) =>
        i % 4 === 3 ? "" : `exploring module ${i}`).join("\n");
      const driver = idriver({ status: async () => "working", read: async () => saturatedPane });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-saturated", driver });
      expect(s.human).toEqual(["T1"]); // the rolling window concluded it — the stall consult parks human
      const evs = Journal.open(repo, "run-t1-saturated").read();
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0); // never killed on a blind signal
      const held = evs.filter((e) => e.event === "worker-dead-held" && e.taskId === "T1");
      expect(held).toHaveLength(1); // the stand-down is journaled exactly once per attempt
      expect(held[0]!.data.reason).toBe("row-signal-saturated");
    } finally {
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // Adversarial pair to the quota criterion: the classifier must fire on a live banner and stay
  // silent on a transcript that merely QUOTES one. Same silence, same two slices, same regex —
  // only the banner's position in the transcript differs. The quoting text is printed AFTER a
  // benign launch frame, so it is genuinely NEW output — novelty cannot be what saves it; only
  // its place above the tail can.
  test("a quota mention above the transcript tail is not a banner and never fails the attempt over", async () => {
    setQuotaBannerSilentMsForTests(500);
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED);
      const harmless = [
        "$ git diff",
        "+  // handle the provider rate limit banner: usage limit reached → failover",
        "+  if (QUOTA_RE.test(out)) return quotaFailover();",
        ...Array.from({ length: 14 }, (_, i) => `  reading src/run/module-${i}.ts`),
      ].join("\n");
      let reads = 0;
      const driver = idriver({
        status: async () => "working",
        read: async () => (++reads <= 2 ? "composing a plan for the task" : harmless),
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-quota-mention", driver });
      expect(s.human).toEqual(["T1"]); // window expiry → stall consult …
      const evs = Journal.open(repo, "run-t1-quota-mention").read();
      expect(evs.filter((e) => e.event === "quota-banner" && e.taskId === "T1")).toHaveLength(0);
      expect(evs.filter((e) => e.event === "quota-failover" && e.taskId === "T1")).toHaveLength(0); // … never a failover
    } finally {
      resetQuotaBannerSilentMsForTests();
    }
  }, 120_000);

  // T1 review (material, fixture-overfit class): codex pins "• You have 3 usage limit resets
  // available." in the composer chrome of EVERY rendered frame (tests/fixtures/codex-mcp-spinner),
  // so a raw-tail QUOTA_RE match fails a wedged worker over for a quota it never hit. The daemon
  // filters that KNOWN chrome by identity — never by novelty against an anchor frame, which is
  // what swallowed the launch-time banner (see the mirror test above). This test feeds the daemon
  // the hostile shape: a pre-render launch read (a shell pane holding the dispatch line — what
  // driver.run() + an immediate read produce for every adapter without interactiveSeed), then the
  // captured wedged-MCP frames — tracker-silent, chrome pinned inside the tail.
  test("codex welcome chrome painted after a pre-render launch read is never classified as a quota banner", async () => {
    setQuotaBannerSilentMsForTests(500); // the silence gate passes quickly — only the chrome filter can save the pane
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED);
      const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-mcp-spinner");
      const frames = readdirSync(fixtureDir)
        .filter((f) => /^frame-\d+\.txt$/.test(f))
        .sort()
        .map((f) => readFileSync(join(fixtureDir, f), "utf8"));
      expect(frames.length).toBeGreaterThanOrEqual(8);
      let reads = 0;
      const driver = idriver({
        status: async () => "working",
        // read #1 is the daemon's launch read: the pre-render shell pane. Every later read is a
        // rendered frame from the wedged-MCP capture — chrome pinned in the tail, zero progress.
        read: async () => (++reads === 1
          ? "$ bash /tmp/tickmarkr-dispatch-T1.sh"
          : frames[(reads - 2) % frames.length]),
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-quota-chrome", driver });
      expect(s.human).toEqual(["T1"]); // window expiry → stall consult: the pane was wedged, not throttled
      const evs = Journal.open(repo, "run-t1-quota-chrome").read();
      expect(reads).toBeGreaterThan(3); // the loop really polled rendered frames past the launch read
      expect(evs.filter((e) => e.event === "quota-banner" && e.taskId === "T1")).toHaveLength(0);
      expect(evs.filter((e) => e.event === "quota-failover" && e.taskId === "T1")).toHaveLength(0);
    } finally {
      resetQuotaBannerSilentMsForTests();
    }
  }, 120_000);

  // A nudge that could not be DELIVERED says only that the daemon lost contact. The worker's real
  // worktree delta remains independent evidence and keeps the fast-kill from condemning the pane;
  // the short rolling window owns its eventual conclusion instead.
  // "Could not be delivered" means BOTH attempts failed — one in-slice retry (T1 review) filters a
  // driver flake, so a single false return never reaches this path.
  test("an undeliverable nudge does not condemn a pane whose worktree changed — delivery failure is not worker evidence", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(200, 400);
    setDeadChannelFastKillMsForTests(1_500);
    try {
      const { repo, fake } = setupRepo(
        [T("T1", { timeoutMinutes: 0.05 })], // 3s window owns the conclusion after the delta is observed
        { consult: { action: "human", notes: "stalled worker" },
          tasks: { T1: [{ shell: "echo scratch > scratch.txt && echo working-on-it" }] } }, // uncommitted delta
      );
      const driver = idriver({
        status: async () => "working", // never pageable
        nudge: async () => false, // the pane cannot be reached
        notify: async () => {}, // keep expected consult/page delivery inside this fixture, not suite stdout
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-nudge-fail", driver });
      expect(s.human).toEqual(["T1"]);
      const evs = Journal.open(repo, "run-t1-nudge-fail").read();
      expect(evs.filter((e) => e.event === "worker-nudge-failed" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-contact" && e.data.evidence === "worktree")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0);
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
      resetNudgeTimingForTests();
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // T1 review: a false return from driver.nudge is a driver-delivery outcome (missing pin,
  // readiness timeout, read-back hiccup), not proof of an unreachable channel — so ONE failed
  // delivery must not condemn a pane holding uncommitted work. The daemon retries once in-slice;
  // here the first delivery flakes and the retry lands, and the pane must live to see its grace.
  test("a nudge that fails once then delivers does not condemn the pane — one driver flake is not a dead channel", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(200, 400);
    setDeadChannelFastKillMsForTests(1_500); // below the window: if the flake latched, the kill would fire
    try {
      const { repo, fake } = setupRepo(
        [T("T1", { timeoutMinutes: 30 })], // 30m window; the 120s test timeout proves it was not waited out
        { consult: { action: "human", notes: "stalled worker" },
          tasks: { T1: [{ shell: "echo scratch > scratch.txt && echo working-on-it" }] } }, // uncommitted delta
      );
      let calls = 0;
      const driver = idriver({
        status: async () => "working", // never pageable — the kill is the only path that could condemn
        nudge: async () => ++calls >= 2, // first delivery flakes, the in-slice retry lands
        notify: async () => {},
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-nudge-flake", driver });
      expect(s.human).toEqual(["T1"]); // delivered-but-unanswered nudge → grace expiry → stall consult
      expect(calls).toBe(2); // the retry really happened, inside the same nudge sequence
      const evs = Journal.open(repo, "run-t1-nudge-flake").read();
      expect(evs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-nudge-failed" && e.taskId === "T1")).toHaveLength(0);
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0); // the flake never condemned it
      expect(evs.filter((e) => e.event === "worker-nudge-expired" && e.taskId === "T1")).toHaveLength(1);
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
      resetNudgeTimingForTests();
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // The other half of that claim: with the nudge never attempted (adapter off the allowlist), the
  // same worktree delta still protects the pane for the whole window — the delta clause is intact.
  test("a worktree delta still disables the fast-kill when no nudge has failed", async () => {
    setDeadChannelFastKillMsForTests(1_500);
    try {
      const { repo, fake } = setupRepo(
        [T("T1", { timeoutMinutes: 0.1 })], // 6s window — the whole of it elapses without a kill
        { consult: { action: "human", notes: "stalled worker" },
          tasks: { T1: [{ shell: "echo scratch > scratch.txt && echo working-on-it" }] } },
      );
      const driver = idriver({ status: async () => "working", notify: async () => {} });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-delta-alive", driver });
      expect(s.human).toEqual(["T1"]); // window expiry → stall consult, not a dead-channel kill
      const evs = Journal.open(repo, "run-t1-delta-alive").read();
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0);
    } finally {
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // T1 review fix (material): the nudge grace deadline used to arm once and never disarm — a
  // worker that ANSWERED the nudge and resumed was force-concluded at its next quiet patch ≥ the
  // grace (measured off the rolling lastProgressAt), journaled worker-nudge-expired as if it had
  // ignored the nudge. Post-nudge progress must disarm the deadline and hand the pane back to the
  // rolling window. Here: silence → nudge → the worker replies (real new rows) → a quiet patch
  // longer than the grace → the attempt ends on the WINDOW, never on worker-nudge-expired.
  test("a worker that answers the nudge and resumes disarms the grace deadline — the next quiet patch is owned by the rolling window", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(200, 400); // 200ms silence → nudge; 400ms grace
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.05 })], STALLED); // 3s window — the conclusion must be the window's
      let nudged = false;
      let replyRows = 0;
      const driver = idriver({
        status: async () => "working",
        nudge: async () => { nudged = true; return true; },
        read: async () => {
          // once the nudge lands the worker replies and resumes: real new transcript rows for a
          // few slices (post-nudge progress), then a quiet patch far longer than the grace
          if (nudged && replyRows < 3) replyRows++;
          return ["working-on-it", ...Array.from({ length: replyRows + 1 }, (_, i) => `resumed row ${i}`)].join("\n");
        },
        notify: async () => {},
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-nudge-answered", driver });
      expect(s.human).toEqual(["T1"]); // the rolling window concluded it — stall consult parks human
      const evs = Journal.open(repo, "run-t1-nudge-answered").read();
      expect(evs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(1);
      // the answer was seen and disarmed the grace …
      expect(evs.filter((e) => e.event === "worker-nudge-answered" && e.taskId === "T1")).toHaveLength(1);
      // … so the false "ignored the nudge" conclusion never fires
      expect(evs.filter((e) => e.event === "worker-nudge-expired" && e.taskId === "T1")).toHaveLength(0);
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0);
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
      resetNudgeTimingForTests();
    }
  }, 120_000);

  // T1 review (answer-then-die, criterion 6): the disarm test above proves the answered pane
  // survives to the window; this one proves it does not survive UNWATCHED. The fast-kill hold used
  // to key on `nudgeable` — a per-slice adapter/status property — so once a worker answered the
  // nudge and then froze, the one-per-attempt nudge latch, the disarmed expiry branch, and the
  // nudgeable-gated kill and page left it with NO watchdog at all: the dead-channel triad was met
  // at the fast-kill window and the pane still rode the whole rolling window in silence. The hold
  // is on a PENDING daemon action now (un-nudged, or grace armed), so the kill owns this pane.
  test("a worker that answers the nudge and then freezes with no delta is fast-killed — the rolling window does not own it", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(200, 400); // 200ms silence → nudge; 400ms grace
    setDeadChannelFastKillMsForTests(1_500); // kill seam far below the 30m window: the kill owns the conclusion
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 30 })], STALLED); // 30m window, no worktree delta
      let nudged = false;
      let replyRows = 0;
      const driver = idriver({
        status: async () => "working", // never pageable — the kill is the only watchdog left
        nudge: async () => { nudged = true; return true; },
        read: async () => {
          // the worker answers the nudge (real new rows — the grace disarms), then freezes for good
          if (nudged && replyRows < 3) replyRows++;
          return ["working-on-it", ...Array.from({ length: replyRows + 1 }, (_, i) => `resumed row ${i}`)].join("\n");
        },
        notify: async () => {},
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-answer-die", driver });
      expect(s.human).toEqual(["T1"]); // concluded dead → stall consult parks human
      const evs = Journal.open(repo, "run-t1-answer-die").read();
      expect(evs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-nudge-answered" && e.taskId === "T1")).toHaveLength(1);
      // the answer was genuine, so the "ignored the nudge" conclusion never fires …
      expect(evs.filter((e) => e.event === "worker-nudge-expired" && e.taskId === "T1")).toHaveLength(0);
      // … but the subsequent freeze meets the dead-channel triad and is killed on the fast-kill
      // window — seconds into a 30m rolling window, not at the end of it
      const dead = evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1");
      expect(dead).toHaveLength(1);
      expect(evs.findIndex((e) => e.event === "worker-nudge-answered" && e.taskId === "T1"))
        .toBeLessThan(evs.findIndex((e) => e.event === "worker-dead" && e.taskId === "T1"));
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
      resetNudgeTimingForTests();
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // T1 review fix (material): the fast-kill's "no output growth" leg used to clock off
  // lastProgressAt, which the flat-token rule deliberately suppresses — and contextTokens is
  // sticky across read misses. A METERED, non-nudgeable adapter (pi's shape: contextUsage present,
  // off the nudge allowlist) streaming rows under a stale counter was journaled worker-dead while
  // its pane was visibly printing. The kill now reads the tracker's raw row-growth clock: rows
  // advancing is output growth, suppressed or not.
  test("a metered non-nudgeable worker streaming rows under a flat token counter is never fast-killed", async () => {
    setDeadChannelFastKillMsForTests(300); // kill seam far below the 6s window: the old composition kills in ~1s
    setRowRearmTokenFlatMsForTests(200); // seam for the 15m flat-token cap: suppression engages mid-test
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED); // the 6s window owns the conclusion
      fake.contextUsage = () => ({ tokens: 500 }); // metered — and permanently FLAT (the sticky counter)
      let reads = 0;
      const driver = idriver({
        status: async () => "working", // never pageable; "fake" is not nudge-allowlisted → the kill is the only early exit
        read: async () => ["working-on-it", ...Array.from({ length: Math.min(reads++, 50) }, (_, i) => `suite output row ${i}`)].join("\n"),
        notify: async () => {},
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-flat-tokens", driver });
      expect(s.human).toEqual(["T1"]); // the rolling window concluded it, not the kill
      const evs = Journal.open(repo, "run-t1-flat-tokens").read();
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0); // streaming rows ARE output growth
      expect(reads).toBeGreaterThan(2); // the pane really did keep streaming past the suppression point
    } finally {
      resetDeadChannelFastKillMsForTests();
      resetRowRearmTokenFlatMsForTests();
    }
  }, 120_000);
});

// ── T2 (OBS-264): finished work is harvested, never redone ─────────────────────────────────────
// Every case here rides a worker that COMMITS and then goes quiet without a trailer — the exact
// shape of all 18 observed stalls, each of which carried 2-33 commits that the next attempt then
// re-bought at full price. The pane is frozen by construction (constant text, no exit marker ever
// seen), so the only thing that can end a wait early is the liveness triad itself.
// Lives here rather than in its own tests/run/ file: the shipped testing guide states the per
// directory *.test.ts counts and docs-truth-testing.test.ts asserts them, so a new file under
// tests/run/ is a documentation change this task's file scope does not cover.
describe("harvest: finished work is gated, never redispatched (OBS-264)", () => {
  const hdriver = (overrides: Record<string, unknown> = {}): ExecutorDriver => {
    const inner = new SubprocessDriver();
    const { useRealRead = false, ...driverOverrides } = overrides;
    return {
      id: "harvest-fake",
      interactive: true,
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: async () => { await new Promise((r) => setTimeout(r, 50)); return false; },
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: useRealRead ? inner.read.bind(inner) : async () => "working-on-it",
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      status: async () => "working",
      ...driverOverrides,
    } as ExecutorDriver;
  };

  const evsOf = (repo: string, runId: string) => Journal.open(repo, runId).read();

  // A worker that keeps burning CPU at `dutyPct` of one core. BOUNDED and self-terminating: a
  // spinner that outlives the test run it was spawned for is an orphan pegging a core forever, so
  // the burn carries its own deadline instead of trusting anything to kill it (the daemon's
  // closeSlot SIGKILLs the process group too — the deadline is the belt to that suspenders).
  // It is a GRANDCHILD of the dispatch script — the matched root's own CPU time never moves, so
  // only the probe's descendant walk can see it. Sleeping between bursts is Atomics.wait, not a
  // child `sleep`: a spawned sleep would be another process in the very tree under measurement.
  const burnFor = (ms: number, dutyPct = 100) => `node -e ${shq(
    `const idle = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + ${ms};`
    + ` while (Date.now() < end) { const s = Date.now(); while (Date.now() - s < 10) { /* burn */ }`
    + ` if (${dutyPct} < 100) Atomics.wait(idle, 0, 0, 10 * (100 - ${dutyPct}) / ${dutyPct}); }`,
  )}`;

  // Review regression: the worker's persistent shell stays almost idle while each CPU-heavy tool
  // is a short-lived child. The 800ms gaps line up with the daemon's sparse harvest observations,
  // so summing only processes alive in those observations reads flat even though a new burner runs
  // between them. A retained descendant ledger sees the CPU before each child exits.
  const burnInShortChildren = (iterations = 12) =>
    `for i in {1..${iterations}}; do node -e ${shq("const end = Date.now() + 120; while (Date.now() < end) { /* burn */ }")}; sleep 0.8; done`;

  // The managed macOS test sandbox denies `ps` even to child processes. Production and ordinary CI
  // use the live process tree; only that named environmental gap gets a deterministic snapshot
  // source with the same shape: a persistent root plus 120ms child burners that disappear between
  // the daemon's ~1s observations. The fast accountant's 100ms samples see and retain them.
  const cpuProbeFallback = async (repo: string, runId: string, mode: "flat" | "bursty" = "bursty"): Promise<() => void> => {
    if (await workerTreeCpuMs("tickmarkr-cpu-probe-capability", repo) !== undefined) return () => {};
    const dir = makeTestTempDir("tickmarkr-ps-fallback-");
    const script = join(dir, "ps.mjs");
    const bashEnv = join(dir, "bash-env");
    const state = join(dir, "state");
    const marker = join(tickmarkrDir(repo), "runs", runId, "prompts", "T1-a0.sh");
    writeFileSync(script, [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      'const now = Date.now();',
      'const started = existsSync(process.env.TICKMARKR_TEST_PS_STATE) ? Number(readFileSync(process.env.TICKMARKR_TEST_PS_STATE, "utf8")) : now;',
      'writeFileSync(process.env.TICKMARKR_TEST_PS_STATE, String(started));',
      'const phase = (now - started) % 1000;',
      mode === "bursty"
        ? 'const rows = [`100 1 0:00.00 ${process.env.TICKMARKR_TEST_PS_MARKER}`, "101 100 0:00.00 fake-agent"];'
        : 'const rows = ["999 1 0:00.00 unrelated-process"];',
      mode === "bursty"
        ? 'if (phase >= 400 && phase <= 700) rows.push("102 101 0:00.20 short-lived-burner");'
        : "",
      'process.stdout.write(rows.join("\\n") + "\\n");',
    ].join("\n"));
    writeFileSync(bashEnv, `ps() { node ${shq(script)}; }\n`);
    const prior = {
      bashEnv: process.env.BASH_ENV,
      marker: process.env.TICKMARKR_TEST_PS_MARKER,
      state: process.env.TICKMARKR_TEST_PS_STATE,
    };
    process.env.BASH_ENV = bashEnv;
    process.env.TICKMARKR_TEST_PS_MARKER = marker;
    process.env.TICKMARKR_TEST_PS_STATE = state;
    return () => {
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore("BASH_ENV", prior.bashEnv);
      restore("TICKMARKR_TEST_PS_MARKER", prior.marker);
      restore("TICKMARKR_TEST_PS_STATE", prior.state);
    };
  };

  // Both harvest seams at once. Tests that assert a CONCLUSION pin the flat window so they need not
  // sit through a real one; tests that assert a worker is NOT concluded leave it at its real,
  // resolution-derived value — pinning it there would be the fixture answering its own question.
  const withSeams = async (silentMs: number, flatMs: number | undefined, body: () => Promise<void>) => {
    setHarvestSilentMsForTests(silentMs);
    if (flatMs !== undefined) setHarvestCpuFlatMsForTests(flatMs);
    try {
      await body();
    } finally {
      resetHarvestSilentMsForTests();
      resetHarvestCpuFlatMsForTests();
    }
  };

  test("the flat-CPU window is sized against the host's own CPU-clock quantum", () => {
    // darwin `ps` prints hundredths, linux whole seconds. Equality across a window shorter than the
    // quantum is not evidence: a throttled worker accrues less than one tick per sample and reads
    // flat while working. 30 ticks of the clock in use, floored — never a fixed two seconds.
    expect(harvestCpuFlatWindowMs(10)).toBe(3_000);
    expect(harvestCpuFlatWindowMs(1_000)).toBe(30_000);
    expect(harvestCpuFlatWindowMs(1_000)).toBeGreaterThan(harvestCpuFlatWindowMs(10));
  });

  test("an absent process tree reads as zero CPU, never as an unreadable snapshot", async () => {
    // The probe's two "no number" readings are opposites, and the triad turns on telling them
    // apart: 0 means nothing of this worker is running — the strongest at-rest signal there is, and
    // what every concluded harvest actually sees — while undefined means UNMEASURABLE and is
    // journaled rather than concluded on. A marker matching no process must produce the first; were
    // it ever to produce undefined, the triad would fall silent on exactly the finished, exited
    // workers OBS-264 is about, and the feature would be gone with only a journal line to say so.
    const restoreProbe = await cpuProbeFallback(process.cwd(), "unused", "flat");
    let cpu: Awaited<ReturnType<typeof workerTreeCpuMs>>;
    try {
      const marker = `tickmarkr-no-live-process-${randomBytes(16).toString("hex")}`;
      cpu = await workerTreeCpuMs(marker, process.cwd());
    } finally {
      restoreProbe();
    }
    expect(cpu).toBeDefined();
    expect(cpu!.ms).toBe(0);
    expect([10, 1_000]).toContain(cpu!.resolutionMs); // the quantum is read off the rows, not assumed
  });

  test("test: a silent worker with commits ahead of base and a flat CPU delta is concluded and its worktree goes to gates without a redispatch", async () => {
    await withSeams(500, 200, async () => {
      // 5m stall window: if the triad did not conclude this wait, the 120s test budget would expire
      // long before the window did. The worker commits, prints no trailer, and exits — flat CPU.
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], {
        consult: { action: "human", notes: "a harvested attempt must never reach a consult" },
        tasks: { T1: [{ shell: `echo harvested > h.txt && ${COMMIT} h` }] },
      });
      const restoreProbe = await cpuProbeFallback(repo, "run-harvest-ok", "flat");
      let s: Awaited<ReturnType<typeof runDaemon>>;
      try {
        s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-ok", driver: hdriver() });
      } finally {
        restoreProbe();
      }

      expect(s.done).toEqual(["T1"]); // gated and merged on the harvested worktree
      const evs = evsOf(repo, "run-harvest-ok");
      const concluded = evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1");
      expect(concluded).toHaveLength(1); // the triad ended the wait, not the window
      expect(concluded[0]!.data.commits).toBe(1);
      expect(concluded[0]!.data.cpuMs).toBe(0); // the worker's process tree was gone
      // the carried worktree went to gates on THIS attempt — one dispatch, no fresh worker
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.some((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "evidence" && e.data.pass === true)).toBe(true);
      expect(evs.some((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "acceptance" && e.data.pass === true)).toBe(true);
      expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0); // no stall consult was bought
      expect(evs.findIndex((e) => e.event === "worker-harvest"))
        .toBeLessThan(evs.findIndex((e) => e.event === "gate-result"));
    });
  }, 120_000);

  test("test: a concluded harvest with failing gates falls into the existing retry ladder exactly as a trailered failure does", async () => {
    await withSeams(500, 200, async () => {
      // Same task, same red judge, same worker diff — the ONLY difference is whether the worker
      // emitted a trailer. The transcript must stay CLEAN of every pre-gate routing signature
      // (quota banner, provider outage, CLI-death text): a committed attempt whose tail carries
      // one now routes BEFORE gates by design — that precedence is pinned by the dedicated
      // routing tests below, and seeding a signature here would reroute instead of laddering.
      const red = {
        judge: { pass: false, criteria: [{ criterion: "done", met: false, reason: "not met" }] },
        consult: { action: "human", notes: "gates stayed red" },
      };
      const shell = `node -e ${shq('require("fs").appendFileSync("w.txt", `${Date.now()}-${process.pid}\\n`)')} && ${COMMIT} w`;

      const trailered = setupRepo([T("T1", { timeoutMinutes: 0.02 })], {
        ...red, tasks: { T1: [{ shell, result: { ok: true, summary: "claimed" } }] },
      });
      const claimed = await runDaemon(trailered.repo, { adapters: [trailered.fake], runId: "run-ladder-claimed" });

      const silent = setupRepo([T("T1", { timeoutMinutes: 0.02 })], {
        ...red, tasks: { T1: [{ shell }] }, // no trailer — harvested
      });
      const harvested = await runDaemon(silent.repo, { adapters: [silent.fake], runId: "run-ladder-harvested", driver: hdriver({ useRealRead: true }) });

      const ladder = (repo: string, runId: string) =>
        evsOf(repo, runId).filter((e) => e.event === "escalation").map((e) => e.data.step);
      expect(ladder(silent.repo, "run-ladder-harvested")).toEqual(ladder(trailered.repo, "run-ladder-claimed"));
      expect(ladder(silent.repo, "run-ladder-harvested")).toEqual(["retry", "escalate", "consult"]);
      expect(harvested.human).toEqual(claimed.human); // same terminal decision
      expect(harvested.human).toEqual(["T1"]);
      const parks = (repo: string, runId: string) =>
        evsOf(repo, runId).filter((e) => e.event === "task-human").map((e) => e.data.kind);
      expect(parks(silent.repo, "run-ladder-harvested")).toEqual(parks(trailered.repo, "run-ladder-claimed"));
      // every harvested attempt really was harvested — none of them was a stall consult
      expect(evsOf(silent.repo, "run-ladder-harvested").filter((e) => e.event === "worker-result-harvested")).toHaveLength(3);
      expect(evsOf(trailered.repo, "run-ladder-claimed").filter((e) => e.event === "worker-result-harvested")).toHaveLength(0);
      const assignments = (repo: string, runId: string) => evsOf(repo, runId)
        .filter((e) => e.event === "task-dispatch")
        .map((e) => e.data.assignment);
      expect(assignments(silent.repo, "run-ladder-harvested"))
        .toEqual(assignments(trailered.repo, "run-ladder-claimed"));
    });
  }, 180_000);

  test("a committed attempt that walls on quota still fails over — its commits ride the carry-forward, not a gate run", async () => {
    // T2 review (material, routing precedence): the harvest synthesis used to set ok:true and
    // finished:true BEFORE the quota branch, and the branch's `!finished` guard then made quota
    // failover unreachable for ANY harvested attempt — including one the loop already broke on a
    // journaled quota-banner. A worker that committed partial work and hit the wall bought a full
    // gate run (baseline+evidence+scope+judge+review) on throttled work, burned a ladder step
    // spec §4 says quota must not consume, and retried on the same throttled channel. The branch
    // now classifies the PRE-HARVEST outcome (workerFinished + the pre-synthesis parse): the
    // walled attempt fails over exactly like a commit-less one, and its commits survive via the
    // existing commitsToCarry/cherryPickCommits carry-forward into the next attempt's worktree.
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.02 })], {
      consult: { action: "human", notes: "a quota-routed attempt must never reach a consult" },
      tasks: { T1: [
        { shell: `echo partial > p.txt && ${COMMIT} p && printf '%s\\n' 'usage limit reached for this model'` }, // commits, then walls — no trailer
        { shell: "test -f p.txt", result: { ok: true, summary: "carried work verified" } },
      ] },
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-quota-route", driver: hdriver({ useRealRead: true }) });

    expect(s.done).toEqual(["T1"]); // the other channel carried it to done
    const evs = evsOf(repo, "run-harvest-quota-route");
    // the walled attempt's commits WERE recognized — harvest journaling is not the defect — …
    expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
    // … but the attempt routed on its PRE-HARVEST outcome instead of buying a gate run
    const failover = evs.filter((e) => e.event === "quota-failover" && e.taskId === "T1");
    expect(failover).toHaveLength(1);
    expect(failover[0]!.data.from).not.toBe(failover[0]!.data.to);
    expect(evs.findIndex((e) => e.event === "gate-result"))
      .toBeGreaterThan(evs.findIndex((e) => e.event === "quota-failover")); // gates ran only on the failover attempt
    expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(2);
    // the landed commit survived the reroute through the existing carry-forward — never re-earned
    const recreations = evs.filter((e) => e.event === "worktree-recreation" && e.taskId === "T1");
    expect(recreations).toHaveLength(1);
    expect((recreations[0]!.data.attempted as string[]).length).toBe(1);
    expect(recreations[0]!.data.carried).toEqual(recreations[0]!.data.attempted);
    expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);
  }, 120_000);

  test("a committed attempt on a dead channel is excluded and failed over — the synthesis cannot swallow auth-required", async () => {
    // Same precedence defect, dead-channel leg: classifyDeadChannel bails on any ok:true result,
    // so reading the SYNTHESIZED harvest result swallowed auth-required / setup-required /
    // provider-outage for every committed-but-walled attempt in BOTH modes — the channel stayed
    // eligible and the next attempt retried on a CLI that could never answer. Classification now
    // reads the pre-harvest parse, so the dead channel demotes and fails over while the commits
    // ride the same carry-forward as the quota case above.
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.02 })], {
      consult: { action: "human", notes: "a dead-channel-routed attempt must never reach a consult" },
      tasks: { T1: [
        { shell: `echo partial > p.txt && ${COMMIT} p && printf '%s\\n' 'Please run /login'` }, // commits, then the CLI reports it is dead — no trailer
        { shell: "test -f p.txt", result: { ok: true, summary: "carried work verified" } },
      ] },
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-dead-route", driver: hdriver({ useRealRead: true }) });

    expect(s.done).toEqual(["T1"]);
    const evs = evsOf(repo, "run-harvest-dead-route");
    expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
    expect(evs.filter((e) => e.event === "channel-exclusion" && e.data.reason === "auth-required")).toHaveLength(1);
    const failover = evs.filter((e) => e.event === "dead-channel-failover" && e.data.reason === "auth-required");
    expect(failover).toHaveLength(1);
    expect(failover[0]!.data.from).not.toBe(failover[0]!.data.to);
    expect(evs.findIndex((e) => e.event === "gate-result"))
      .toBeGreaterThan(evs.findIndex((e) => e.event === "dead-channel-failover"));
    expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(2);
    const recreations = evs.filter((e) => e.event === "worktree-recreation" && e.taskId === "T1");
    expect(recreations).toHaveLength(1);
    expect((recreations[0]!.data.attempted as string[]).length).toBe(1);
    expect(recreations[0]!.data.carried).toEqual(recreations[0]!.data.attempted);
    expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);
  }, 120_000);

  test("a committed attempt that then dies on a provider outage still requeues in place — the harvest cannot null the routing signature", async () => {
    await withSeams(500, 200, async () => {
      // T2 review (material, third routing branch): the harvest synthesis used to null the
      // pre-harvest cause for ANY harvested attempt, which made the v1.46 same-channel requeue
      // unreachable whenever commits landed — control fell through to classifyDeadChannel, whose
      // OUTAGE_RE matched the same banner and demoted the channel for every later attempt AND
      // every later task in the run, breaking the documented "a transient blip still recovers in
      // place" invariant. Every existing provider-death fixture exits, so workerFinished is true
      // and the harvest never fires — this worker COMMITS, prints the outage banner, and HANGS
      // (no exit, no trailer), the exact OBS-264 shape. The cause must survive synthesis: the
      // capped same-channel requeue fires, the channel is never demoted, and the commits ride
      // the carry-forward into the requeued attempt. The free requeue does not burn the attempt
      // counter, so the SAME scripted step replays — p.txt's presence in the recreated worktree
      // (carried forward) is what turns the replay into a trailer-emitting finisher.
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.05 })], {
        consult: { action: "human", notes: "a provider-death requeue must never reach a consult" },
        tasks: { T1: [
          { shell: `if [ -f p.txt ]; then test -s p.txt; else echo partial > p.txt && ${COMMIT} p && printf '%s\\n' 'Unable to reach the model provider' && sleep 60; fi`, result: { ok: true, summary: "carried work verified" } },
        ] },
      });
      const restoreProbe = await cpuProbeFallback(repo, "run-harvest-provider-death", "flat");
      let s: Awaited<ReturnType<typeof runDaemon>>;
      try {
        s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-provider-death", driver: hdriver({ useRealRead: true }) });
      } finally {
        restoreProbe();
      }

      expect(s.done).toEqual(["T1"]); // the free same-channel requeue carried it to done
      const evs = evsOf(repo, "run-harvest-provider-death");
      // the harvest still recognized and journaled the committed work — recognition is not the defect
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
      // the worker's OWN outcome keeps its provider-death signature through the synthesis …
      expect(evs.filter((e) => e.event === "worker-result" && e.data.cause === "provider-death")).toHaveLength(1);
      // … so the capped same-channel requeue fires BEFORE any gate run …
      const requeues = evs.filter((e) => e.event === "provider-death-requeue" && e.taskId === "T1");
      expect(requeues).toHaveLength(1);
      expect(evs.findIndex((e) => e.event === "gate-result"))
        .toBeGreaterThan(evs.findIndex((e) => e.event === "provider-death-requeue"));
      // … and the transient blip never demotes the channel — no dead-channel classification at all
      expect(evs.filter((e) => e.event === "channel-exclusion")).toHaveLength(0);
      expect(evs.filter((e) => e.event === "dead-channel-failover")).toHaveLength(0);
      // the requeue kept the same assignment and did not burn the attempt counter
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(2);
      const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
      expect(dispatches[1]!.data.assignment).toEqual(dispatches[0]!.data.assignment);
      // the landed commit survived the requeue through the existing carry-forward — never re-earned
      const recreations = evs.filter((e) => e.event === "worktree-recreation" && e.taskId === "T1");
      expect(recreations).toHaveLength(1);
      expect((recreations[0]!.data.attempted as string[]).length).toBe(1);
      expect(recreations[0]!.data.carried).toEqual(recreations[0]!.data.attempted);
      expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);
    });
  }, 120_000);

  test("a silent retry that only carries a prior attempt's commits is gated on the spot, never redispatched to re-earn them", async () => {
    // T2 review (material): harvest eligibility was measured against THIS attempt's post-carry
    // HEAD, so a retry that produced nothing of its own — while its worktree already held the
    // entire deliverable, cherry-picked forward — was invisible to both the triad and the
    // synthesis. Reproduced exactly: attempt 0 commits and walls on quota; attempt 1 receives that
    // commit and goes silent WITHOUT COMMITTING ANYTHING ITSELF. Before the fix the journal showed
    // worktree-recreation, then a stall consult, with no gate-result and no worker-result-harvested
    // — finished work sitting unverified in a worktree that was eligible to be bought again. The
    // commit-less retry is the whole point of this fixture: every other harvest case here lands a
    // fresh commit, which is exactly what hid this defect.
    await withSeams(300, 200, async () => {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.05 })], {
        consult: { action: "human", notes: "a carried-only retry must never reach a stall consult" },
        tasks: { T1: [
          { shell: `echo carried > c.txt && ${COMMIT} c && printf '%s\\n' 'usage limit reached for this model'` },
          { shell: "sleep 30" }, // silent, flat CPU, and not one commit of its own
        ] },
      });
      const restoreProbe = await cpuProbeFallback(repo, "run-harvest-carried-only", "flat");
      let s: Awaited<ReturnType<typeof runDaemon>>;
      try {
        s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-carried-only", driver: hdriver({ useRealRead: true }) });
      } finally {
        restoreProbe();
      }

      expect(s.done).toEqual(["T1"]);
      const evs = evsOf(repo, "run-harvest-carried-only");
      // attempt 0 routed on quota, as its own dedicated case pins …
      expect(evs.filter((e) => e.event === "quota-failover" && e.taskId === "T1")).toHaveLength(1);
      // … and its commit rode the carry-forward into attempt 1's recreated worktree
      const recreations = evs.filter((e) => e.event === "worktree-recreation" && e.taskId === "T1");
      expect(recreations).toHaveLength(1);
      expect(recreations[0]!.data.carried).toEqual(recreations[0]!.data.attempted);
      expect((recreations[0]!.data.carried as string[]).length).toBe(1);
      // the carried-only retry was harvested and GATED — the assertion that was red before the fix
      const harvested = evs.filter((e) => e.event === "worker-result-harvested" && e.data.attempt === 1);
      expect(harvested).toHaveLength(1);
      expect((harvested[0]!.data.commits as string[]).length).toBe(1); // the carried one; the worker made none
      const from = evs.indexOf(harvested[0]!);
      expect(evs.slice(from).some((e) => e.event === "gate-result" && e.taskId === "T1")).toBe(true);
      // and nothing was redispatched to re-produce work the worktree already held
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(2);
      expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);
    });
  }, 120_000);

  test("a carried-only silent retry on a dead channel still routes first — the harvest gates a worktree, it never certifies a channel", async () => {
    // The same carried-only retry, with a routing signature on it. Recognizing carried work must
    // not cost the pre-harvest routing precedence the closed-set constraint pins: attempt 1 lands
    // no commit of its own, is harvestable purely on the carry-forward, and STILL fails its dead
    // channel over before any gate runs on it. Both features are live in this one fixture — the
    // harvested event proves the harvest fired, the exclusion proves routing outranked it.
    await withSeams(100, 100, async () => {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.01 })], {
        judge: [
          { pass: false, criteria: [{ criterion: "done", met: false, reason: "retry once" }] },
          { pass: true, criteria: [{ criterion: "done", met: true, reason: "carried work is valid" }] },
        ],
        consult: { action: "human", notes: "unexpected gate failure" },
        tasks: { T1: [
          { shell: `echo landed > landed.txt && ${COMMIT} landed`, result: { ok: true, summary: "landed" } },
          { shell: "printf '%s\\n' 'Please run /login'; sleep 2" },
          { shell: "true", result: { ok: true, summary: "verified carried work" } },
        ] },
      });

      await runDaemon(repo, {
        adapters: [fake],
        runId: "run-harvest-attempt-base",
        driver: hdriver({ useRealRead: true }),
      });
      const evs = evsOf(repo, "run-harvest-attempt-base");

      const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
      expect(dispatches.length).toBeGreaterThanOrEqual(3);
      // the carried-only retry IS recognized as holding work …
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.data.attempt === 1)).toHaveLength(1);
      // … and still routes on its PRE-HARVEST outcome, before any gate sees that worktree
      expect(evs.filter((e) => e.event === "channel-exclusion" && e.data.reason === "auth-required")).toHaveLength(1);
      const failover = evs.filter((e) => e.event === "dead-channel-failover" && e.data.reason === "auth-required");
      expect(failover).toHaveLength(1);
      const attempt1 = evs.indexOf(dispatches[1]!);
      const attempt2 = evs.indexOf(dispatches[2]!);
      const window = evs.slice(attempt1, attempt2);
      expect(window.some((e) => e.event === "dead-channel-failover")).toBe(true);
      expect(window.some((e) => e.event === "gate-result")).toBe(false);
      const recreations = evs.filter((e) => e.event === "worktree-recreation" && e.taskId === "T1");
      expect(recreations.length).toBeGreaterThanOrEqual(2);
      expect(recreations.every((e) => (e.data.carried as string[]).length === 1)).toBe(true);
    });
  }, 120_000);

  test("a wait-loop exception always stops the worker CPU accountant", async () => {
    const probeDir = makeTestTempDir("tickmarkr-accountant-cleanup-");
    const probe = join(probeDir, "probe.ts");
    const daemonUrl = new URL("../../src/run/daemon.ts", import.meta.url).href;
    const driverUrl = new URL("../../src/drivers/subprocess.ts", import.meta.url).href;
    const helperUrl = new URL("../helpers/tmprepo.ts", import.meta.url).href;
    writeFileSync(probe, [
      `import { runDaemon, resetHarvestCpuFlatMsForTests, resetHarvestSilentMsForTests, setHarvestCpuFlatMsForTests, setHarvestSilentMsForTests } from ${JSON.stringify(daemonUrl)};`,
      `import { SubprocessDriver } from ${JSON.stringify(driverUrl)};`,
      `import { COMMIT, setupRepo, T } from ${JSON.stringify(helperUrl)};`,
      "async function main() {",
      'const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], { tasks: { T1: [{ shell: `echo landed > landed.txt && ${COMMIT} landed` }] } });',
      "const inner = new SubprocessDriver();",
      "let reads = 0;",
      "const driver = {",
      '  id: "accountant-cleanup-probe", interactive: true,',
      "  slot: inner.slot.bind(inner), run: inner.run.bind(inner),",
      "  waitOutput: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return false; },",
      '  read: async () => { if (++reads >= 3) throw new Error("probe read failure"); return "working-on-it"; },',
      '  waitAgentStatus: inner.waitAgentStatus.bind(inner), status: async () => "working",',
      "  notify: inner.notify.bind(inner), close: inner.close.bind(inner), worktree: inner.worktree.bind(inner),",
      "};",
      "setHarvestSilentMsForTests(0); setHarvestCpuFlatMsForTests(60_000);",
      "try {",
      '  const summary = await runDaemon(repo, { adapters: [fake], runId: "run-accountant-cleanup", driver });',
      '  if (!summary.failed.includes("T1")) throw new Error(`unexpected summary: ${JSON.stringify(summary)}`);',
      "} finally { resetHarvestSilentMsForTests(); resetHarvestCpuFlatMsForTests(); }",
      'process.stdout.write("accountant-cleanup-settled\\n");',
      "}",
      "main().catch((error) => { console.error(error); process.exitCode = 1; });",
    ].join("\n"));

    const child = spawn(process.execPath, ["--import", "tsx", probe], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let killedForLeak = false;
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        killedForLeak = true;
        child.kill("SIGKILL");
      }, 4_000);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(killedForLeak, stderr).toBe(false);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("accountant-cleanup-settled");
  }, 15_000);

  test("test: a worker still burning CPU is not concluded however silent its tracker is", async () => {
    // Pin three seconds, not one sparse observation: the window crosses three complete burner/gap
    // cycles on both CPU-clock resolutions, so only retained exited-child CPU can hold it open.
    await withSeams(300, 3_000, async () => {
      // Commits ahead of base AND a frozen tracker: two of the three legs are satisfied from the
      // first slice. The worker then burns, so the CPU leg alone must hold the wait open.
      // The persistent worker launches CPU-heavy tool children for 120ms, then waits 800ms. Every
      // child exits before the next sparse daemon observation; the persistent shell itself is idle.
      const runId = "run-harvest-busy";
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.12 })], {
        consult: { action: "human", notes: "stalled" },
        tasks: { T1: [{ shell: `echo busy > b.txt && ${COMMIT} b && ${burnInShortChildren()}` }] },
      });
      const restoreProbe = await cpuProbeFallback(repo, runId);
      let s: Awaited<ReturnType<typeof runDaemon>>;
      let waited = 0;
      try {
        const startedAt = Date.now();
        s = await runDaemon(repo, { adapters: [fake], runId, driver: hdriver() });
        waited = Date.now() - startedAt;
      } finally {
        restoreProbe();
      }

      const evs = evsOf(repo, "run-harvest-busy");
      // the triad never concluded this wait — the CPU leg alone held it, since the other two were
      // satisfied from the first slice
      expect(evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(0);
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0); // nor killed
      expect(waited).toBeGreaterThanOrEqual(7_200); // it rode the whole 0.12m window out
      expect(evs.find((e) => e.event === "worker-result" && e.taskId === "T1")!.data.cause).toBe("stall-timeout");
      // The CPU leg governs WHEN a wait ends, never whether landed work is gated: once the window
      // itself expired, the same carried worktree was still gated rather than redispatched — a busy
      // worker buys the full window it is entitled to, and not one redundant attempt after it.
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
      expect(s.done).toEqual(["T1"]);
    });
  }, 120_000);

  test("test: the synthesized no-trailer result is journaled as harvested, distinct from a worker-claimed ok", async () => {
    await withSeams(500, 200, async () => {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], {
        tasks: { T1: [{ shell: `echo silent > s.txt && ${COMMIT} s` }] },
      });
      const restoreProbe = await cpuProbeFallback(repo, "run-harvest-journal", "flat");
      try {
        await runDaemon(repo, { adapters: [fake], runId: "run-harvest-journal", driver: hdriver() });
      } finally {
        restoreProbe();
      }
      const evs = evsOf(repo, "run-harvest-journal");

      // the parsed truth is recorded first and stays truthful: the worker claimed nothing
      const parsed = evs.filter((e) => e.event === "worker-result" && e.taskId === "T1");
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.data.ok).toBe(false);
      expect(parsed[0]!.data.finished).toBe(false);
      expect(parsed[0]!.data.summary).toBe(NO_TRAILER_SUMMARY);
      // the synthesis is its OWN event — a worker-claimed ok can never produce this row
      const synthesized = evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1");
      expect(synthesized).toHaveLength(1);
      expect(synthesized[0]!.data.source).toBe("harvest");
      expect(synthesized[0]!.data.summary).toBe(HARVESTED_RESULT_SUMMARY);
      expect((synthesized[0]!.data.commits as string[]).length).toBe(1);
      expect(evs.findIndex((e) => e.event === "worker-result"))
        .toBeLessThan(evs.findIndex((e) => e.event === "worker-result-harvested"));

      // and a genuine worker-claimed ok never mints one
      const claimed = setupRepo([T("T1")], {
        tasks: { T1: [{ shell: `echo claimed > c.txt && ${COMMIT} c`, result: { ok: true, summary: "claimed" } }] },
      });
      await runDaemon(claimed.repo, { adapters: [claimed.fake], runId: "run-claimed-journal" });
      const claimedEvs = evsOf(claimed.repo, "run-claimed-journal");
      expect(claimedEvs.filter((e) => e.event === "worker-result-harvested")).toHaveLength(0);
      expect(claimedEvs.some((e) => e.event === "worker-result" && e.data.ok === true && e.data.finished === true)).toBe(true);
    });
  }, 120_000);

  test("no attempt whose worktree already carries the work is redispatched from scratch", async () => {
    await withSeams(500, 200, async () => {
      // A permanently red gate, so the ladder runs its full length and every attempt is a silent
      // worker that has already landed a commit. The invariant under test is per-attempt: whatever
      // the ladder decides next, the attempt that HOLDS the work is the attempt that gets verified.
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], {
        judge: { pass: false, criteria: [{ criterion: "done", met: false, reason: "not met" }] },
        consult: { action: "human", notes: "gates stayed red" },
        tasks: { T1: [{ shell: `echo work >> w.txt && ${COMMIT} w` }] },
      });
      const restoreProbe = await cpuProbeFallback(repo, "run-harvest-never-redone", "flat");
      try {
        await runDaemon(repo, { adapters: [fake], runId: "run-harvest-never-redone", driver: hdriver() });
      } finally {
        restoreProbe();
      }
      const evs = evsOf(repo, "run-harvest-never-redone");

      const harvests = evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1");
      expect(harvests.length).toBeGreaterThan(1); // several attempts, every one of them carrying work
      // every harvest reaches gates BEFORE any next dispatch: the carried worktree is what got
      // verified, so no attempt was ever spent re-producing work the worktree already held.
      for (const h of harvests) {
        const from = evs.indexOf(h);
        const next = evs.findIndex((e, i) => i > from && e.event === "task-dispatch");
        const window = evs.slice(from, next === -1 ? evs.length : next);
        expect(window.some((e) => e.event === "gate-result")).toBe(true);
      }
      // one harvest per attempt: no attempt ended in the stall consult that buys a fresh worker
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(harvests.length);
      // and the landed commits ride every worktree recreation intact — nothing is ever re-earned
      const recreations = evs.filter((e) => e.event === "worktree-recreation" && e.taskId === "T1");
      expect(recreations.length).toBeGreaterThan(0);
      for (const r of recreations) {
        expect((r.data.attempted as string[]).length).toBeGreaterThan(0);
        expect(r.data.carried).toEqual(r.data.attempted);
      }
    });
  }, 180_000);

  test("a burning seeded worker is never concluded: its launch is outside the probed tree, so it has no CPU leg at all", async () => {
    // Review finding: interactiveSeed adapters (kimi) are launched by runInteractiveSeed, NOT by the
    // dispatch script — so a probe keyed to the script found nothing, read 0, called it FLAT, and
    // could harvest a worker that was mid-turn. tickmarkr does not own that launch line (the adapter
    // does, and it must be delivered verbatim), so the seeded path has no measurable CPU leg and is
    // never concluded by the triad; it keeps the no-redispatch half of OBS-264 through the tail.
    // Both seams are pinned SHORT on purpose: that removes "the window was too long" as an
    // explanation, so a probe that trusted its own zero would conclude this worker within seconds.
    await withSeams(300, 200, async () => {
      const { repo, scriptPath } = setupRepo([T("T1", { timeoutMinutes: 0.15 })], {
        consult: { action: "human", notes: "stalled" },
        tasks: { T1: [{ shell: "unused — the seed launch is the dispatch" }] },
      });
      const ready = "SEED-READY";
      // a tenth of a core, not a whole one: what this case needs is a worker that is ALIVE and
      // quiet with commits landed, and the suite runs test files in parallel forks — every
      // core-second here is charged to whatever else is running (tests/cockpit/live.test.ts sweeps
      // the frame-contract domain single-threaded and sits ~3% under its own timeout).
      const seedLaunch = `echo ${ready} && echo seeded > s.txt && ${COMMIT} s && ${burnFor(12_000, 10)}`;
      const fake = new FakeAdapter(scriptPath) as FakeAdapter & { interactiveSeed?: unknown };
      fake.interactiveCommand = () => null; // kimi's shape: no argv-seeding surface at all
      fake.interactiveSeed = {
        launch: () => seedLaunch,
        readinessMatch: ready,
        seedLine: (promptFile: string) => `Read ${promptFile} and do exactly what it says.`,
      };

      // Only the FIRST delivery spawns: a real seeded TUI receives the seed line as typed input, so
      // spawning a second process for it would both lie about the tree and drop the launch's handle.
      let launched: string | undefined;
      const inner = new SubprocessDriver();
      const driver = hdriver({
        waitOutput: inner.waitOutput.bind(inner), // real: readiness must be genuinely observed
        read: inner.read.bind(inner),
        run: async (slot: Slot, cmd: string) => {
          if (launched !== undefined) return;
          launched = cmd;
          await inner.run(slot, cmd);
        },
        slot: inner.slot.bind(inner), close: inner.close.bind(inner), worktree: inner.worktree.bind(inner),
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-seeded", driver });

      // the burning seeded worker was NOT concluded — the assertion that goes red the moment the
      // probe treats "my marker matched nothing" as "this worker is at rest"
      const evs = evsOf(repo, "run-harvest-seeded");
      expect(evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(0);
      // the launch really did bypass the dispatch script (the gap is structural, not incidental)
      // and the daemon says so out loud rather than leaving a silent hole in the feature
      expect(launched).toBe(seedLaunch);
      const unmeasurable = evs.filter((e) => e.event === "worker-harvest-unmeasurable" && e.taskId === "T1");
      expect(unmeasurable).toHaveLength(1); // once per attempt, not once per slice
      expect(unmeasurable[0]!.data.reason).toContain("interactive-seed");
      // and the other half of OBS-264 still holds on this path: the window expiry gates the commits
      // the seeded worker landed instead of buying a fresh worker to re-produce them
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
      expect(s.done).toEqual(["T1"]); // and the window expiry still gates the work it landed
    });
  }, 120_000);

  test("a headless worker that committed and went quiet is harvested without riding out its window", async () => {
    // Review finding: the triad lived only in the interactive wait loop, so a print-mode worker —
    // the fallback EVERY adapter without a TUI surface lands in — still paid the full stall window.
    // A real SubprocessDriver (runDaemon's default), a real 5m window, and a worker that commits and
    // then sleeps: alive, zero CPU, silent. It must be concluded in seconds, not minutes.
    await withSeams(500, 200, async () => {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], {
        consult: { action: "human", notes: "a harvested attempt must never reach a consult" },
        tasks: { T1: [{ shell: `echo headless > h.txt && ${COMMIT} h && sleep 20` }] },
      });
      const restoreProbe = await cpuProbeFallback(repo, "run-harvest-headless", "flat");
      const startedAt = Date.now();
      let s: Awaited<ReturnType<typeof runDaemon>>;
      try {
        s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-headless" });
      } finally {
        restoreProbe();
      }
      const waited = Date.now() - startedAt;

      expect(s.done).toEqual(["T1"]);
      expect(waited).toBeLessThan(60_000); // the 5m window was never ridden out
      const evs = evsOf(repo, "run-harvest-headless");
      const concluded = evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1");
      expect(concluded).toHaveLength(1);
      expect(concluded[0]!.data.commits).toBe(1);
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);
    });
  }, 120_000);

  test("a headless worker that commits and exits cleanly without a trailer is harvested, never counted as completion", async () => {
    // T2 review (material): print mode set `finished` from the EXIT MARKER, so a worker that
    // committed and exited normally without a trailer entered the tail as finished:true — the
    // synthesis is gated on !workerFinished, so it never fired: gates ran on the worker's own
    // ok:false with no HARVESTED_RESULT_SUMMARY and no worker-result-harvested row. That is the
    // natural exit path every headless adapter takes; the other headless case here keeps its
    // process alive until the triad breaks the loop, which is exactly what hid this. `finished`
    // now means the trailer in BOTH modes, and the cause taxonomy's "clean-exit-no-trailer" —
    // unreachable in print mode until now — names the shape.
    const shell = `echo exited > e.txt && ${COMMIT} e`; // exits immediately; no trailer at all
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], {
      consult: { action: "human", notes: "a harvested attempt must never reach a consult" },
      tasks: { T1: [{ shell }] },
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-print-exit" });

    expect(s.done).toEqual(["T1"]);
    const evs = evsOf(repo, "run-harvest-print-exit");
    // the exit marker ended the wait — the triad never ran, so this is the natural-exit path
    expect(evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(0);
    // the parsed worker truth stays truthful: it exited, it claimed nothing
    const parsed = evs.filter((e) => e.event === "worker-result" && e.taskId === "T1");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.data.finished).toBe(false);
    expect(parsed[0]!.data.exitCode).toBe(0);
    expect(parsed[0]!.data.summary).toBe(NO_TRAILER_SUMMARY);
    expect(parsed[0]!.data.cause).toBe("clean-exit-no-trailer");
    // and the committed worktree reached gates through the synthesis, on this same attempt
    const synthesized = evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1");
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]!.data.summary).toBe(HARVESTED_RESULT_SUMMARY);
    expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
    expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);

    // the SAME shell with a trailer is a worker-claimed completion — no synthesis, finished:true.
    // Both outcomes are reachable in this fixture; only the trailer differs.
    const claimed = setupRepo([T("T1", { timeoutMinutes: 5 })], {
      tasks: { T1: [{ shell, result: { ok: true, summary: "claimed" } }] },
    });
    await runDaemon(claimed.repo, { adapters: [claimed.fake], runId: "run-harvest-print-claimed" });
    const claimedEvs = evsOf(claimed.repo, "run-harvest-print-claimed");
    expect(claimedEvs.filter((e) => e.event === "worker-result-harvested")).toHaveLength(0);
    expect(claimedEvs.some((e) => e.event === "worker-result" && e.data.finished === true && e.data.ok === true)).toBe(true);
  }, 120_000);

  test("an unreadable ps stops the CPU accountant instead of forking one every 100ms for the rest of the window", async () => {
    // T2 review (material): the accountant samples at 10Hz and each sample forks bash + ps. Where
    // ps is unsupported or DENIED — the managed-sandbox class, and the named fail-open path — every
    // sample fails, so it kept forking for the remainder of the stall window: tens of thousands of
    // processes per silent attempt, multiplied by daemon concurrency, for a probe that can never
    // conclude anything. Persistent failure is structural, so the sampler stops. This shims `ps`
    // itself (a bash function via BASH_ENV, the same seam the sandbox fallback uses) to fail and
    // COUNT its calls, then measures the count against a window long enough that an unbounded
    // sampler would have forked ~90 times.
    const dir = makeTestTempDir("tickmarkr-ps-denied-");
    const counter = join(dir, "calls");
    const bashEnv = join(dir, "bash-env");
    writeFileSync(counter, "");
    writeFileSync(bashEnv, 'ps() { printf x >> "$TICKMARKR_TEST_PS_CALLS"; return 1; }\n');
    const prior = { bashEnv: process.env.BASH_ENV, calls: process.env.TICKMARKR_TEST_PS_CALLS };

    await withSeams(200, 200, async () => {
      // commits, then stays alive and silent for the whole 9s window — the accountant's own
      // population, and the one it must not keep forking through
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.15 })], {
        consult: { action: "human", notes: "an unmeasurable probe must never reach a consult" },
        tasks: { T1: [{ shell: `echo denied > d.txt && ${COMMIT} d && sleep 20` }] },
      });
      let s: Awaited<ReturnType<typeof runDaemon>>;
      process.env.BASH_ENV = bashEnv;
      process.env.TICKMARKR_TEST_PS_CALLS = counter;
      try {
        s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-ps-denied", driver: hdriver() });
      } finally {
        if (prior.bashEnv === undefined) delete process.env.BASH_ENV;
        else process.env.BASH_ENV = prior.bashEnv;
        if (prior.calls === undefined) delete process.env.TICKMARKR_TEST_PS_CALLS;
        else process.env.TICKMARKR_TEST_PS_CALLS = prior.calls;
      }

      const calls = readFileSync(counter, "utf8").length;
      expect(calls).toBeGreaterThan(0); // the accountant really did start — otherwise this proves nothing
      expect(calls).toBeLessThanOrEqual(25); // bounded by the cap, NOT by the 9s window
      const evs = evsOf(repo, "run-harvest-ps-denied");
      // it fails open exactly as before: nothing is concluded on an unreadable snapshot, the gap is
      // named once, and the window expiry still gates the work the worker landed
      expect(evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(0);
      const unmeasurable = evs.filter((e) => e.event === "worker-harvest-unmeasurable" && e.taskId === "T1");
      expect(unmeasurable).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
      expect(s.done).toEqual(["T1"]);
    });
  }, 120_000);

  // ── the harvest's precedence over every sibling guard in the wait loop ───────────────────────
  // The closed set is: the routing branches (quota + dead-channel classification — the two cases
  // above), the dead-channel fast-kill, the liveness nudge, and the noTrailerStreak accounting.
  // Each member below gets a fixture in which BOTH the harvest and that member can genuinely fire:
  // a fixture where only one of them is reachable proves precedence for neither, so every case
  // here carries a second run of the SAME fixture, differing only in the seam that decides which
  // member wins, and asserts the other one really was live in it.

  // Member: the liveness nudge (T1/OBS-262). A worker that COMMITS and goes quiet is harvestable
  // from the first slice, at seams pinned BELOW the nudge gate exactly as the shipped harvest 5m
  // sits below the shipped nudge 10m — and the adapter here is on the nudge allowlist, claude-code's
  // shape and the only member of it. Before the hold, the harvest concluded such an attempt at the
  // harvest gate and closed its slot, so the nudge was unreachable for every committed claude-code
  // worker: the CPU leg cannot tell "idle because finished" from "idle while holding an unsubmitted
  // turn in the input box" — both read flat CPU under a silent tracker — and the nudge is the one
  // signal that can. Holding concludes at nudge+grace instead of the whole window, and the landed
  // commits still go to gates through the same synthesis.
  test("a committed worker on a nudgeable adapter is nudged first — the harvest holds, then gates the same work", async () => {
    const fixture = (runId: string) => setupRepo([T("T1", { timeoutMinutes: 5 })], {
      consult: { action: "human", notes: `${runId}: a harvested attempt must never reach a consult` },
      tasks: { T1: [{ shell: `echo nudgeable > n.txt && ${COMMIT} n` }] }, // commits, then exits: flat CPU, silent tracker
    });
    await withSeams(200, 200, async () => {
      setNudgeTimingForTests(1_500, 600); // harvest gate (200ms) strictly below the nudge gate, as 5m < 10m
      try {
        // 1) the nudgeable run: the harvest is eligible from the first slice and must NOT take it
        const held = fixture("run-harvest-nudge-held");
        NUDGEABLE_ADAPTERS.add("fake");
        let nudges = 0;
        let s: Awaited<ReturnType<typeof runDaemon>>;
        let waited = 0;
        const restoreProbe = await cpuProbeFallback(held.repo, "run-harvest-nudge-held", "flat");
        try {
          const startedAt = Date.now();
          s = await runDaemon(held.repo, {
            adapters: [held.fake], runId: "run-harvest-nudge-held",
            driver: hdriver({ nudge: async () => { nudges++; return true; }, notify: async () => {} }),
          });
          waited = Date.now() - startedAt;
        } finally {
          NUDGEABLE_ADAPTERS.delete("fake");
          restoreProbe();
        }
        const evs = evsOf(held.repo, "run-harvest-nudge-held");
        // the rescue was reachable: it fired, and the harvest never preempted it
        expect(nudges).toBe(1);
        expect(evs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(1);
        expect(evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(0);
        // the hold is bounded by the nudge's own grace, never by the 5m window
        expect(evs.filter((e) => e.event === "worker-nudge-expired" && e.taskId === "T1")).toHaveLength(1);
        expect(waited).toBeLessThan(60_000);
        // and the OBS-264 win survives the hold: the committed work is still gated on THIS attempt
        expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
        expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
        expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);
        expect(s.done).toEqual(["T1"]);

        // 2) the SAME fixture with the adapter off the allowlist — nothing else changed. It
        // harvests at these very seams, which is what makes run 1's silence a HOLD rather than a
        // fixture in which the triad could never have concluded anything.
        const free = fixture("run-harvest-nudge-free");
        const restoreFree = await cpuProbeFallback(free.repo, "run-harvest-nudge-free", "flat");
        try {
          await runDaemon(free.repo, {
            adapters: [free.fake], runId: "run-harvest-nudge-free",
            driver: hdriver({ nudge: async () => true, notify: async () => {} }),
          });
        } finally {
          restoreFree();
        }
        const freeEvs = evsOf(free.repo, "run-harvest-nudge-free");
        expect(freeEvs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(1);
        expect(freeEvs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(0);
      } finally {
        resetNudgeTimingForTests();
      }
    });
  }, 120_000);

  // Member: the dead-channel fast-kill. Its worktree clause and the harvest are mutually exclusive
  // by construction: committed work changes the launch tree, irrespective of whether a nudge can
  // reach the pane. An unreachable pane holding commits is therefore concluded by the harvest and
  // its existing work goes straight to gates instead of being misclassified as a dead empty tree.
  test("an unreachable pane holding commits is harvested rather than condemned by failed delivery, and its work still gated", async () => {
    const fixture = () => setupRepo([T("T1", { timeoutMinutes: 30 })], { // 30m window: the 120s budget proves it was never ridden
      consult: { action: "human", notes: "an unreachable pane must never reach a consult" },
      tasks: { T1: [{ shell: `echo unreachable > u.txt && ${COMMIT} u` }] },
    });
    await withSeams(300, 200, async () => {
      NUDGEABLE_ADAPTERS.add("fake");
      setNudgeTimingForTests(300, 400);
      try {
        // 1) failed delivery does not erase the committed tree evidence; the harvest concludes it
        const killed = fixture();
        const restoreProbe = await cpuProbeFallback(killed.repo, "run-harvest-unreachable", "flat");
        setDeadChannelFastKillMsForTests(1_500);
        let s: Awaited<ReturnType<typeof runDaemon>>;
        let waited = 0;
        try {
          const startedAt = Date.now();
          s = await runDaemon(killed.repo, {
            adapters: [killed.fake], runId: "run-harvest-unreachable",
            driver: hdriver({ nudge: async () => false, notify: async () => {} }), // both deliveries fail → nudgeFailed
          });
          waited = Date.now() - startedAt;
        } finally {
          restoreProbe();
        }
        const evs = evsOf(killed.repo, "run-harvest-unreachable");
        expect(evs.filter((e) => e.event === "worker-nudge-failed" && e.taskId === "T1")).toHaveLength(1);
        expect(evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(1);
        expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0);
        expect(waited).toBeLessThan(60_000); // seconds into a 30m window — the harvest owns the bound
        // the conclusion is still not a redispatch: the same worktree went to gates
        expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
        expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
        expect(s.done).toEqual(["T1"]);

        // 2) the SAME fixture with the kill window out of reach reaches the identical conclusion,
        // proving the fast-kill window cannot override worktree evidence after failed delivery.
        const harvested = fixture();
        const restoreHarvest = await cpuProbeFallback(harvested.repo, "run-harvest-unreachable-triad", "flat");
        setDeadChannelFastKillMsForTests(10 * 60_000);
        try {
          await runDaemon(harvested.repo, {
            adapters: [harvested.fake], runId: "run-harvest-unreachable-triad",
            driver: hdriver({ nudge: async () => false, notify: async () => {} }),
          });
        } finally {
          restoreHarvest();
        }
        const triadEvs = evsOf(harvested.repo, "run-harvest-unreachable-triad");
        expect(triadEvs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(1);
        expect(triadEvs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0);
      } finally {
        NUDGEABLE_ADAPTERS.delete("fake");
        resetNudgeTimingForTests();
        resetDeadChannelFastKillMsForTests();
      }
    });
  }, 120_000);

  // Member: the noTrailerStreak accounting (OBS-57). A harvested attempt is a no-trailer window —
  // gates are the truth about its WORKTREE, never about its CHANNEL. Reading the synthesized
  // ok/finished here reset the streak on every harvest, so a CLI that produces commits and swallows
  // every trailer was immune to the two-window demotion and stayed first pick for the whole run.
  test("a harvested attempt still burns a no-trailer window — the channel is demoted, never certified", async () => {
    const red = {
      judge: { pass: false, criteria: [{ criterion: "done", met: false, reason: "not met" }] },
      consult: { action: "human", notes: "gates stayed red" },
    };
    const shell = `echo work >> w.txt && ${COMMIT} w`;
    await withSeams(300, 200, async () => {
      // 1) silent worker, red gates: every attempt is harvested, and the channel demotes on the second
      const silent = setupRepo([T("T1", { timeoutMinutes: 5 })], { ...red, tasks: { T1: [{ shell }] } });
      const restoreProbe = await cpuProbeFallback(silent.repo, "run-harvest-streak", "flat");
      try {
        await runDaemon(silent.repo, { adapters: [silent.fake], runId: "run-harvest-streak", driver: hdriver() });
      } finally {
        restoreProbe();
      }
      const evs = evsOf(silent.repo, "run-harvest-streak");
      const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
      const key = (a: unknown) => `${(a as { adapter: string }).adapter}:${(a as { model: string }).model}`;

      // both features live in this one fixture: the attempts really were harvested and gated …
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1").length).toBeGreaterThanOrEqual(2);
      expect(evs.some((e) => e.event === "gate-result" && e.taskId === "T1")).toBe(true);
      // … and the missing trailers still accumulated into the OBS-57 demotion
      const demotions = evs.filter((e) => e.event === "channel-demotion" && e.taskId === "T1");
      expect(demotions).toHaveLength(1);
      expect(demotions[0]!.data.streak).toBe(2);
      expect(demotions[0]!.data.channel).toBe(key(dispatches[0]!.data.assignment));
      // the demotion is not cosmetic: no later attempt was dispatched back onto that channel
      const after = evs.slice(evs.indexOf(demotions[0]!)).filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((e) => key(e.data.assignment) !== demotions[0]!.data.channel)).toBe(true);

      // 2) the SAME fixture, same red gates, same diff — the worker merely emits a trailer. No
      // demotion, so run 1's demotion came from the missing trailers and not from the red ladder.
      const trailered = setupRepo([T("T1", { timeoutMinutes: 5 })], {
        ...red, tasks: { T1: [{ shell, result: { ok: true, summary: "claimed" } }] },
      });
      await runDaemon(trailered.repo, { adapters: [trailered.fake], runId: "run-harvest-streak-claimed" });
      const claimedEvs = evsOf(trailered.repo, "run-harvest-streak-claimed");
      expect(claimedEvs.filter((e) => e.event === "worker-result-harvested")).toHaveLength(0);
      expect(claimedEvs.filter((e) => e.event === "channel-demotion")).toHaveLength(0);
    });
  }, 180_000);

  // ── v1.85 T3: the repair seam, composed with this suite's own fixture ────────────────────────
  // The repair decision reads `commits` and `lostCommits` from an attempt the HARVEST concluded, so
  // it is proven here rather than beside a trailer-emitting worker: the same run must show T1's
  // liveness nudge firing on a worker holding commits ahead of base BEFORE anything concludes it,
  // and the review-only failure that follows must buy a repair instead of a fresh re-onboarding.
  test("test: a review-only failure with fully carried commits dispatches a repair attempt whose prompt carries the diff content and the findings verbatim, and in the same composed fixture a nudge-eligible worker with commits ahead of base still receives the merged liveness nudge before any conclude", async () => {
    const { repo, fake } = setupRepo(
      // complexity 8 puts the task above review.complexityThreshold; the command oracle keeps
      // acceptance deterministic so REVIEW is the only gate that can fail.
      [T("T1", { complexity: 8, timeoutMinutes: 5, acceptance: [{ oracle: "command", command: "true" }] })],
      {
        review: {
          approve: false,
          findings: [{ note: "`renderRow` in src/ui/row.ts drops the last column", severity: "material" }],
          comments: [{ path: "src/ui/row.ts", line: 88, body: "off-by-one in `renderRow`" }],
        },
        consult: { action: "human", notes: "a repair fixture must never reach a consult" },
        // commits, then goes quiet without a trailer — the OBS-264 shape, carrying real work
        tasks: { T1: [{ shell: `echo carried > repairable.txt && ${COMMIT} carried` }] },
      },
    );
    await withSeams(200, 200, async () => {
      setNudgeTimingForTests(1_500, 600); // harvest gate (200ms) strictly below the nudge gate, as 5m < 10m
      NUDGEABLE_ADAPTERS.add("fake");
      let nudges = 0;
      const restoreProbe = await cpuProbeFallback(repo, "run-repair-review", "flat");
      try {
        await runDaemon(repo, {
          adapters: [fake], runId: "run-repair-review",
          driver: hdriver({ nudge: async () => { nudges++; return true; }, notify: async () => {} }),
        });
      } finally {
        NUDGEABLE_ADAPTERS.delete("fake");
        resetNudgeTimingForTests();
        restoreProbe();
      }
      const evs = evsOf(repo, "run-repair-review");

      // ── the merged liveness nudge still runs, and still runs FIRST ──
      expect(nudges).toBeGreaterThanOrEqual(1);
      const firstNudge = evs.findIndex((e) => e.event === "worker-nudge" && e.taskId === "T1");
      expect(firstNudge).toBeGreaterThanOrEqual(0);
      const concludes = ["worker-harvest", "worker-result-harvested", "worker-result"];
      const firstConclude = evs.findIndex((e) => concludes.includes(e.event) && e.taskId === "T1");
      expect(firstConclude).toBeGreaterThan(firstNudge); // nudged before any conclude, never after
      // the worker really did hold commits ahead of base, and that work reached the gates
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1").length).toBeGreaterThanOrEqual(1);

      // ── review-only failure over fully carried commits → a REPAIR attempt ──
      const reviewFail = evs.find((e) => e.event === "gate-result" && e.taskId === "T1"
        && e.data.gate === "review" && e.data.pass === false)!;
      expect(reviewFail).toBeDefined();
      // both review rounds this engagement earned a repair (the budget is 2); the second one's
      // dispatch never happens because the review round cap parks the task first.
      const repairs = evs.filter((e) => e.event === "repair-attempt" && e.taskId === "T1");
      expect(repairs.length).toBeGreaterThanOrEqual(1);
      expect(repairs[0]!.data.gates).toEqual(["review"]);
      expect(String(repairs[0]!.data.findings)).toContain("renderRow"); // the findings ride the ledger
      const sent = evs.filter((e) => e.event === "repair-dispatch" && e.taskId === "T1");
      expect(Number(sent[0]!.data.diffBytes)).toBeGreaterThan(0);
      const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
      expect(dispatches.length).toBeGreaterThanOrEqual(2);
      expect(dispatches[1]!.data.retryMode).toBe("repair"); // not a fresh re-onboarding

      // ── the repair prompt carries the diff CONTENT and the findings VERBATIM ──
      const prompt = readFileSync(join(tickmarkrDir(repo), "runs", "run-repair-review", "prompts", "T1-a1.md"), "utf8");
      expect(prompt).toContain("## Repair attempt — fix ONLY what these findings name");
      expect(prompt).toContain(String(reviewFail.data.details)); // the journal's own bytes, unabridged
      expect(prompt).toContain("`renderRow` in src/ui/row.ts drops the last column");
      expect(prompt).toContain("diff --git"); // real diff content, not a hash manifest
      expect(prompt).toContain("+carried");
    });
  }, 240_000);

});


// ── v1.85 T3 (speed dive): retries repair with the findings in hand ────────────────────────────
// Measured losses this suite pins: 62 of 68 re-dispatches were FRESH (~20m of onboarding re-bought
// each time) and ~663m across 5 runs went to loops of normalized-identical failures. Lives beside
// the rest of the daemon suite rather than in its own tests/run/ file: the shipped testing guide
// states the per-directory *.test.ts counts and docs-truth-testing.test.ts asserts them, so a new
// file under tests/run/ is a documentation change this task's file scope does not cover.
describe("T3 retry economics (fake adapter, zero tokens)", () => {
  const evsOf = (repo: string, runId: string) => Journal.open(repo, runId).read();
  const promptOf = (repo: string, runId: string, attempt: number) =>
    readFileSync(join(tickmarkrDir(repo), "runs", runId, "prompts", `T1-a${attempt}.md`), "utf8");

  // a driver whose WORKER dispatch never registers — the OBS-253 shape: the pane wedges before the
  // agent ever runs, so the attempt dies with no worker-result at all.
  const dispatchDeathDriver = (): ExecutorDriver => {
    const inner = new SubprocessDriver();
    return {
      id: "dispatch-death",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      async run(slot: Slot, cmd: string) {
        if (slot.name.startsWith("tickmarkr:worker:") || slot.name.includes("-worker-")) {
          throw new Error("pane wedged: dispatch never registered");
        }
        await inner.run(slot, cmd);
      },
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    } as ExecutorDriver;
  };

  test("test: the third repair-eligible failure in one engagement falls back to the fresh ladder", async () => {
    // The budget is spent on the deterministic oracle, and the THIRD repair-eligible failure is a
    // REVIEW-only one — the case with its own same-channel fix retry (OBS-189). That retry is exactly
    // the round the spent budget declared too expensive to repeat, so the ladder must own it: a
    // fixture made only of oracle failures would leave that override untested.
    // Each round's failure carries different assertion content, so the failures stay repair-eligible
    // without tripping the normalized-identical fingerprint cap (the other half of this seam, below).
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "cat marker.txt; test -f pass.txt" }] })],
      {
        review: {
          approve: false,
          findings: [{ note: "`applyMarker` in src/mark.ts writes the wrong column", severity: "material" }],
        },
        consult: { action: "human", notes: "the ladder ran out" },
        tasks: { T1: [
          { shell: `echo one > marker.txt && ${COMMIT} m1`, result: { ok: true, summary: "a0" } },
          { shell: `echo two > marker.txt && ${COMMIT} m2`, result: { ok: true, summary: "a1" } },
          // the oracle is satisfied from here on, so REVIEW becomes the only failing gate
          { shell: `echo three > marker.txt && touch pass.txt && ${COMMIT} m3`, result: { ok: true, summary: "a2" } },
          { shell: `echo four > marker.txt && ${COMMIT} m4`, result: { ok: true, summary: "a3" } },
          { shell: `echo five > marker.txt && ${COMMIT} m5`, result: { ok: true, summary: "a4" } },
        ] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-repair-budget" });
    expect(s.human).toEqual(["T1"]);
    const evs = evsOf(repo, "run-repair-budget");

    // the first two failures really were repair-eligible (same narrow battery, work carried)
    const oracleFails = evs.filter((e) => e.event === "gate-result" && e.taskId === "T1"
      && e.data.gate === "acceptance" && e.data.pass === false);
    expect(oracleFails).toHaveLength(2);
    // …and no two of them were normalized-identical, so nothing here is the fingerprint cap acting
    const shapes = new Set(oracleFails.map((e) => normalizeGateFailure(String(e.data.details))));
    expect(shapes.size).toBe(oracleFails.length);

    // exactly two repairs were funded, and exactly two dispatches carried the repair mode
    expect(evs.filter((e) => e.event === "repair-attempt" && e.taskId === "T1")).toHaveLength(2);
    const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches.filter((e) => e.data.retryMode === "repair")).toHaveLength(2);
    expect(dispatches[1]!.data.retryMode).toBe("repair");
    expect(dispatches[2]!.data.retryMode).toBe("repair");

    // the THIRD repair-eligible failure — review-only, the case that has its own fix retry — is
    // refused a repair AND refused that retry: the fresh ladder takes the rung instead.
    const exhausted = evs.filter((e) => e.event === "repair-exhausted" && e.taskId === "T1");
    expect(exhausted.length).toBeGreaterThanOrEqual(1);
    expect(exhausted[0]!.data.gates).toEqual(["review"]);      // …and it is the review round
    const escalations = evs.filter((e) => e.event === "escalation" && e.taskId === "T1");
    expect(escalations[0]!.data.repair).toBe(1);
    expect(escalations[1]!.data.repair).toBe(2);
    expect(escalations[2]!.data.repair).toBeUndefined();       // the fresh ladder owns this one
    expect(escalations[2]!.data.reviewFix).toBeUndefined();    // NOT the free same-channel review round
    expect(escalations[2]!.data.step).toBe("retry");           // ladder rung 0 …
    // … which it really did CONSUME: a review-fix round would have left the ladder standing at rung
    // 0 and drawn another free same-channel round instead of walking on.
    expect(escalations[3]!.data.step).toBe("escalate");

    // the ladder attempt is a FRESH brief: no diff content, no fix-only contract
    expect(promptOf(repo, "run-repair-budget", 1)).toContain("## Repair attempt");
    expect(promptOf(repo, "run-repair-budget", 2)).toContain("## Repair attempt");
    expect(promptOf(repo, "run-repair-budget", 3)).not.toContain("## Repair attempt");
    expect(promptOf(repo, "run-repair-budget", 3)).not.toContain("diff --git");
    expect(dispatches[3]!.data.retryMode).not.toBe("repair");
    // …and it still carries WHY the last attempt failed — a ladder rung is not an amnesia rung
    expect(promptOf(repo, "run-repair-budget", 3)).toContain("applyMarker");
  }, 180_000);

  test("a single failing test gate over landed commits earns a repair, though the evidence gate never ran", async () => {
    // runGates returns at the first red gate, so a failing test gate never reaches the evidence
    // stage and its commit list comes back empty. The repair decision must measure the landed work
    // itself, or the ruling's own test/lint case is unreachable by construction.
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: { action: "human", notes: "unused" },
        tasks: { T1: [
          { shell: `echo boom > broken.txt && ${COMMIT} b1`, result: { ok: true, summary: "a0" } },
          { shell: `echo ok > fixed.txt && git rm -q broken.txt && ${COMMIT} b2`, result: { ok: true, summary: "a1" } },
        ] },
      },
      "gates: { test: 'test ! -f broken.txt' }\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-repair-test-gate" });
    expect(s.done).toEqual(["T1"]);
    const evs = evsOf(repo, "run-repair-test-gate");

    const testFail = evs.find((e) => e.event === "gate-result" && e.taskId === "T1"
      && e.data.gate === "test" && e.data.pass === false)!;
    expect(testFail).toBeDefined();
    const repairs = evs.filter((e) => e.event === "repair-attempt" && e.taskId === "T1");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.data.gates).toEqual(["test"]);
    expect(repairs[0]!.data.commits).toBe(1); // measured from the worktree, not from runGates' output
    const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches[1]!.data.retryMode).toBe("repair");
    const prompt = promptOf(repo, "run-repair-test-gate", 1);
    expect(prompt).toContain("## Repair attempt — fix ONLY what these findings name");
    expect(prompt).toContain("diff --git");
    expect(prompt).toContain("+boom");
  }, 180_000);

  test("a funded repair and a retry ban are read back from the journal, so the next dispatch keeps them across a stop", () => {
    // Both decisions govern exactly one dispatch: the next one. They are therefore journal-derived
    // rather than process-local — a stop between the decision and the dispatch (OBS-254's shape one
    // layer up) must not send a normal prompt with the findings gone, or re-run a banned assignment.
    const ev = (event: string, data: Record<string, unknown> = {}, taskId = "T1"): JournalEvent =>
      ({ ts: "2026-08-01T00:00:00.000Z", event, taskId, data });
    const funded = [ev("gate-result", { gate: "review", pass: false }), ev("repair-attempt", { findings: "review: the cap is never applied" })];
    expect(pendingRepairFindings(funded, "T1")).toBe("review: the cap is never applied");
    expect(pendingRepairFindings(funded, "T2")).toBeUndefined();                     // task-scoped
    expect(pendingRepairFindings([...funded, ev("task-dispatch")], "T1")).toBe("review: the cap is never applied"); // a dispatch that never launched keeps it
    expect(pendingRepairFindings([...funded, ev("worker-launch")], "T1")).toBeUndefined(); // spent at launch

    const capped = [ev("gate-fingerprint-cap", { gate: "acceptance", channel: "fake:fake-1" })];
    expect(activeRetryBan(capped, "T1", "fake:fake-1")).toBe("acceptance");
    expect(activeRetryBan(capped, "T1", "other:model-2")).toBeUndefined();           // channel-bound
    // and never latched: once the worker it governed has LAUNCHED, a later unrelated failure — a
    // stall, a merge conflict, a different fingerprint — is not refused under a stale ban. Expiry
    // hangs off the launch, not the pre-launch task-dispatch event: a dispatch that dies before the
    // worker starts has spent nothing, so the decision must still be there for the retry.
    expect(activeRetryBan([...capped, ev("task-dispatch")], "T1", "fake:fake-1")).toBe("acceptance");
    expect(activeRetryBan([...capped, ev("worker-launch")], "T1", "fake:fake-1")).toBeUndefined();

    // The ordinary gate-fail brief expires on the same event, for the same reason: a dispatch that
    // dies BETWEEN task-dispatch and worker-launch (readiness, setup, slot allocation) has shown the
    // worker nothing, so `--retry-failed` must still carry why the last attempt failed — and the
    // dead dispatch is itself part of that answer, not a reason to forget the rest of it.
    const gated = [
      ev("gate-result", { gate: "test", pass: false, details: "1 failed | 3 passed" }),
      ev("gate-result", { gate: "review", pass: true, details: "approved" }),
      ev("task-dispatch"),
      ev("delivery-readiness-failed", { waitedMs: 9000, transcript: "pane never came up" }),
    ];
    expect(journaledFailureBrief(gated, "T1")).toEqual([
      "test: 1 failed | 3 passed",
      "dispatch: delivery readiness failed after 9000ms; pane transcript:\npane never came up",
    ]);
    expect(journaledFailureBrief(gated, "T2")).toEqual([]);                       // task-scoped
    expect(journaledFailureBrief([...gated, ev("worker-launch")], "T1")).toEqual([]); // spent at launch
    expect(journaledFailureBrief([...gated, ev("task-approved")], "T1")).toEqual([]); // and by an approval

    // The ONE pre-launch invariant covers the terminal exception path too: task-dispatch does not
    // spend information, task-failed contributes its exact dispatch error, and only an actual launch
    // spends it. A non-dispatch task failure is not manufactured into dispatch guidance.
    const dispatchError = "Error: pane wedged: dispatch never registered";
    const died = [
      ev("task-dispatch"),
      ev("task-failed", { kind: "dispatch", error: dispatchError }),
    ];
    expect(journaledFailureBrief(died, "T1")).toEqual([`dispatch: ${dispatchError}`]);
    expect(journaledFailureBrief([...died, ev("worker-launch")], "T1")).toEqual([]);
    expect(journaledFailureBrief([
      ev("task-dispatch"),
      ev("task-failed", { kind: "gate-fail", error: dispatchError }),
    ], "T1")).toEqual([]);
  });

  test("test: every blocking review and judge result journals structured findings with class, path and symbol", async () => {
    // 1) a blocking JUDGE verdict
    const judged = setupRepo([T("T1")], {
      judge: {
        pass: false,
        criteria: [{ criterion: "c1", met: false, reason: "src/a.ts must define `parseThing`" }],
        comments: [{ path: "src/a.ts", line: 12, body: "`parseThing` is missing" }],
      },
      consult: { action: "human", notes: "judge rejected" },
      tasks: { T1: [{ shell: `echo x > x.txt && ${COMMIT} x`, result: { ok: true, summary: "x" } }] },
    });
    await runDaemon(judged.repo, { adapters: [judged.fake], runId: "run-findings-judge" });
    const judgeFail = evsOf(judged.repo, "run-findings-judge").find((e) => e.event === "gate-result"
      && e.taskId === "T1" && e.data.gate === "acceptance" && e.data.pass === false)!;
    expect(judgeFail).toBeDefined();
    const judgeFindings = judgeFail.data.findings as Array<Record<string, string>>;
    // exact identities, never "a string is present": class, path and symbol each name something real
    expect(judgeFindings.map((f) => f.fingerprint)).toEqual([
      "acceptance:unmet|src/a.ts|parseThing",
      "acceptance:anchored|src/a.ts|parseThing",
    ]);
    for (const f of judgeFindings) expect(f.note.length).toBeGreaterThan(0); // the judge's own bytes survive

    // 2) a blocking REVIEW verdict
    const reviewed = setupRepo([T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })], {
      review: {
        approve: false,
        findings: [{ note: "`renderRow` in src/ui/row.ts drops the last column", severity: "material" }],
        comments: [{ path: "src/ui/row.ts", line: 88, body: "off-by-one in `renderRow`" }],
      },
      consult: { action: "human", notes: "review rejected" },
      tasks: { T1: [{ shell: `echo y > y.txt && ${COMMIT} y`, result: { ok: true, summary: "y" } }] },
    });
    await runDaemon(reviewed.repo, { adapters: [reviewed.fake], runId: "run-findings-review" });
    const reviewFail = evsOf(reviewed.repo, "run-findings-review").find((e) => e.event === "gate-result"
      && e.taskId === "T1" && e.data.gate === "review" && e.data.pass === false)!;
    expect(reviewFail).toBeDefined();
    const reviewFindings = reviewFail.data.findings as Array<Record<string, string>>;
    expect(reviewFindings.map((f) => f.fingerprint)).toEqual([
      "review:material|src/ui/row.ts|renderRow",
      "review:anchored|src/ui/row.ts|renderRow",
    ]);
    for (const f of reviewFindings) expect(f.note.length).toBeGreaterThan(0); // the reviewer's own bytes survive

    // a PASSING result carries no findings — the structure exists to describe blocking ones
    const passed = evsOf(reviewed.repo, "run-findings-review").find((e) => e.event === "gate-result"
      && e.taskId === "T1" && e.data.pass === true)!;
    expect(passed.data.findings).toBeUndefined();

    // Rule: a finding's path is its OWN evidence path. An inline path therefore resolves; an anchor
    // belonging to another finding and the task's declared scope never substitute for a pathless row.
    // The latter fails closed as the explicit non-empty UNIDENTIFIED sentinel.
    const pathless = "✗ c2: the brief is never carried\njudge verdict pass=false";
    expect(structuredFindings("acceptance", "✗ c2: src/a.ts never carries the brief")[0])
      .toMatchObject({ class: "acceptance:unmet", path: "src/a.ts", symbol: "c2" });
    const unrelatedEvidence = structuredFindings("acceptance",
      `${pathless}\n\n## Anchored review\n- src/b.ts:42 — another finding in \`renderB\``, ["src/a.ts", "src/b.ts"]);
    expect(unrelatedEvidence.find((f) => f.class === "acceptance:unmet"))
      .toMatchObject({ path: UNIDENTIFIED, symbol: "c2" });
    expect(unrelatedEvidence.filter((f) => f.class === "acceptance:unmet")).toHaveLength(1);
    expect(unrelatedEvidence.find((f) => f.class === "acceptance:anchored"))
      .toMatchObject({ path: "src/b.ts", symbol: "renderB" });
    // a review note naming no code identity still gets a stable symbol of its own — its own words,
    // volatile tokens swept out, so the same note one line lower is still the same finding
    const bare = (line: number) => structuredFindings("review",
      `- [material] this silently drops the operator's brief, see src/run/daemon.ts:${line}`, ["src/run/daemon.ts"])[0]!;
    expect(bare(42).path).toBe("src/run/daemon.ts");
    expect(bare(42).symbol).not.toBe(UNIDENTIFIED);
    expect(bare(42).fingerprint).toBe(bare(913).fingerprint);
    // UNIDENTIFIED survives for the one residual it describes: nothing, anywhere, names a file
    expect(structuredFindings("acceptance", pathless)[0]!.path).toBe(UNIDENTIFIED);
    // the criterion id survives a rephrased reason — the same unmet criterion is the same finding
    expect(structuredFindings("acceptance", "✗ c2: put another way, nothing carries the brief", ["src/a.ts"])[0]!.fingerprint)
      .toBe(structuredFindings("acceptance", pathless, ["src/a.ts"])[0]!.fingerprint);

    // R4 identity: line numbers are EVIDENCE, not identity — the same finding one line lower keeps
    // its fingerprint, while a different symbol in the same file is a different finding.
    const at = (line: number, symbol = "renderRow") => structuredFindings("review", [
      "reviewer x:y (v): requested changes (1 material)",
      `- [material] \`${symbol}\` in src/ui/row.ts drops the last column`,
      "",
      "## Anchored review",
      `- src/ui/row.ts:${line} — off-by-one in \`${symbol}\``,
    ].join("\n"));
    expect(at(88).map((f) => f.fingerprint)).toEqual(at(412).map((f) => f.fingerprint));
    expect(at(88, "renderCell").map((f) => f.fingerprint)).not.toEqual(at(88).map((f) => f.fingerprint));
  }, 180_000);

  test("test: two normalized-identical failures of one gate on one task force a consult and ban an identical retry, with normalization proven across a fixture corpus of >=6 volatile-token classes — absolute and tmp paths, line and column numbers, durations and timestamps, ANSI styling, run and worktree identifiers, memory addresses — and a failure differing in assertion content never normalizing identical", async () => {
    // ── part 1: the corpus. Each pair differs ONLY in one class of volatile token. ──
    const corpus: Array<{ volatile: string; a: string; b: string }> = [
      {
        volatile: "absolute and tmp paths",
        a: "AssertionError: expected true to be false at /private/var/folders/9j/T/tickmarkr-repo-Ab3xY/src/run/daemon.ts",
        b: "AssertionError: expected true to be false at /tmp/tickmarkr-repo-Zq7Kd/src/run/daemon.ts",
      },
      {
        volatile: "line and column numbers",
        a: "FAIL tests/run/daemon.test.ts:412:9 — expected 3 to be 4",
        b: "FAIL tests/run/daemon.test.ts:87:31 — expected 3 to be 4",
      },
      {
        volatile: "durations",
        a: "Tests 1 failed | 146 passed (147) in 7.41s",
        b: "Tests 1 failed | 146 passed (147) in 12.02s",
      },
      {
        volatile: "timestamps",
        a: "worker-result 2026-08-01T12:21:55.109Z — no trailer",
        b: "worker-result 2026-07-31T19:29:21.884Z — no trailer",
      },
      {
        volatile: "quoted ordinary diagnostic paths",
        a: "ENOENT: no such file, open '/tmp/wt-a/src/a.ts'",
        b: "ENOENT: no such file, open '/tmp/wt-b/src/a.ts'",
      },
      {
        volatile: "absolute paths outside marker roots with the same file",
        a: "ENOENT: no such file, open '/Users/k/repo/lib/parse.js'",
        b: "ENOENT: no such file, open '/home/runner/project/pkg/parse.js'",
      },
      {
        volatile: "quoted ordinary diagnostic timestamps with offsets",
        a: "worker died at '2026-08-01T12:21:55.109+03:00' before launch",
        b: "worker died at '2026-07-31T19:29:21.884-04:00' before launch",
      },
      {
        volatile: "ANSI styling",
        a: "\u001b[31mFAIL\u001b[39m evidence: worker committed nothing",
        b: "FAIL evidence: worker committed nothing",
      },
      {
        volatile: "run and worktree identifiers",
        a: "ran in /w/tickmarkr-run-20260801-122155--T1 for run-20260801-122155 at 4d48a1163fce",
        b: "ran in /w/tickmarkr-run-20260731-192921--T1 for run-20260731-192921 at 27cf0685aa91",
      },
      {
        volatile: "memory addresses",
        a: "Segmentation fault at 0x00007ffee3b2a180 while linking node_modules",
        b: "Segmentation fault at 0x00007fb41c0e9d40 while linking node_modules",
      },
    ];
    expect(corpus.length).toBeGreaterThanOrEqual(6);
    for (const { volatile, a, b } of corpus) {
      expect(normalizeGateFailure(a), volatile).toBe(normalizeGateFailure(b));
    }
    // the guard on the other side: assertion CONTENT is never normalized away — including content
    // that is itself path-shaped or line-shaped, which is where a naive volatile-token sweep turns
    // two different defects into one and bans a retry that was never redundant.
    const differs: Array<[string, string, string]> = [
      ["numbers", "AssertionError: expected 3 to be 4", "AssertionError: expected 3 to be 5"],
      ["exit codes", "oracle failed: $ npm test (exit 1)", "oracle failed: $ npm test (exit 2)"],
      ["symbols", "- [material] `renderRow` drops the last column", "- [material] `renderCell` drops the last column"],
      ["path-VALUED assertions", "AssertionError: expected '/api/v1/users' to be '/api/v2/orders'", "AssertionError: expected '/api/v3/carts' to be '/api/v4/items'"],
      ["unquoted path-valued assertions", "expected /api/v1/users to be /api/v2/orders", "expected /api/v3/carts to be /api/v4/items"],
      ["line-VALUED assertions", "AssertionError: expected 'src/a.ts:12' to be 'src/a.ts:34'", "AssertionError: expected 'src/a.ts:56' to be 'src/a.ts:78'"],
      ["quoted absolute paths asserted as payload",
        "AssertionError: expected '/tmp/actual-a/src/a.ts' to be '/tmp/want/src/a.ts'",
        "AssertionError: expected '/tmp/actual-b/src/a.ts' to be '/tmp/want/src/a.ts'"],
      ["which file failed", "FAIL tests/run/daemon.test.ts:412 — expected 3 to be 4", "FAIL tests/run/journal.test.ts:412 — expected 3 to be 4"],
      ["absolute paths outside the marker roots",
        "ENOENT: no such file or directory, open '/Users/k/repo/lib/parse.js'",
        "ENOENT: no such file or directory, open '/Users/k/repo/lib/render.js'"],
      // whitespace INSIDE a payload is asserted content: a collapse applied to the whole line erased
      // it, so a formatter defect and an alignment defect became one identity and banned a retry
      ["whitespace inside an asserted value", 'expected "a  b" to be "c"', 'expected "a b" to be "c"'],
      ["asserted indentation", "expected '  indented' to equal '\tindented'", "expected ' indented' to equal '\tindented'"],
    ];
    for (const [what, a, b] of differs) {
      expect(normalizeGateFailure(a), what).not.toBe(normalizeGateFailure(b));
    }
    // …and an English contraction does not open a quoted span that swallows the volatile half
    expect(normalizeGateFailure("the worker's diff at /tmp/wt-aaa/src/a.ts and the judge's verdict"))
      .toBe(normalizeGateFailure("the worker's diff at /tmp/wt-bbb/src/a.ts and the judge's verdict"));

    // ── part 2: the live seam. The same defect twice, wearing different volatile tokens. ──
    const { repo, fake } = setupRepo(
      [T("T1", { acceptance: [{ oracle: "command", command: "cat boom.txt; exit 1" }] })],
      {
        consult: { action: "retry", notes: "try that again" }, // a retry verdict the ban must refuse
        tasks: { T1: [
          // attempt 0 commits nothing: the evidence gate fails and the LADDER spends its rung 0, so
          // the identical pair below is judged from a rung the ladder has already walked past — the
          // cap tests the shape of the next move, never which rung the task happens to stand on.
          { shell: "true", result: { ok: true, summary: "nothing" } },
          { shell: `printf 'expected true at /tmp/wt-1111/src/a.ts:12:3 in 1.1s\\n' > boom.txt && ${COMMIT} b1`, result: { ok: true, summary: "a1" } },
          { shell: `printf 'expected true at /tmp/wt-2222/src/a.ts:99:7 in 9.9s\\n' > boom.txt && ${COMMIT} b2`, result: { ok: true, summary: "a2" } },
        ] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-fingerprint-cap" });
    expect(s.human).toEqual(["T1"]);
    const evs = evsOf(repo, "run-fingerprint-cap");

    const fails = evs.filter((e) => e.event === "gate-result" && e.taskId === "T1"
      && e.data.gate === "acceptance" && e.data.pass === false);
    expect(fails.length).toBeGreaterThanOrEqual(2);
    // the raw bytes really did differ — otherwise this fixture proves nothing about normalization
    expect(String(fails[0]!.data.details)).not.toBe(String(fails[1]!.data.details));
    expect(normalizeGateFailure(String(fails[0]!.data.details)))
      .toBe(normalizeGateFailure(String(fails[1]!.data.details)));

    // the cap fired on the second identical one, taking the round the ladder was about to buy
    const cap = evs.filter((e) => e.event === "gate-fingerprint-cap" && e.taskId === "T1");
    expect(cap).toHaveLength(1);
    expect(cap[0]!.data.gate).toBe("acceptance");
    expect(cap[0]!.data.occurrences).toBe(GATE_FINGERPRINT_CAP);
    expect(cap[0]!.data.retrySameBanned).toBe(true);
    // it forced a consult of its own, immediately, and that consult's retry verdict was refused:
    // escalation (the rung the cap spent) → consult-verdict → retry-same-banned, back to back.
    const capAt = evs.indexOf(cap[0]!);
    expect(evs.slice(capAt + 1, capAt + 4).map((e) => e.event))
      .toEqual(["escalation", "consult-verdict", "retry-same-banned"]);
    expect(evs[capAt + 2]!.data.action).toBe("retry");   // the consult DID say retry …

    // … and the ban refused an identical one: the next dispatch is a different channel, never the
    // same channel on the same brief.
    const banned = evs.filter((e) => e.event === "retry-same-banned" && e.taskId === "T1");
    expect(banned).toHaveLength(cap.length);            // every cap banned exactly one identical retry
    expect(banned.every((e) => e.data.gate === "acceptance")).toBe(true);
    expect(banned[0]!.data.to).not.toBe(banned[0]!.data.from);
    const afterBan = evs.slice(evs.indexOf(banned[0]!)).find((e) => e.event === "task-dispatch" && e.taskId === "T1")!;
    const key = (a: unknown) => `${(a as { adapter: string }).adapter}:${(a as { model: string }).model}`;
    expect(key(afterBan.data.assignment)).toBe(banned[0]!.data.to);

    // The cap SPENDS the rung the ladder would have spent rather than skipping it, so a task that
    // cannot converge still reaches exhaustion on exactly the budget it always had — the cap can
    // never hand a stuck task extra rounds. Rung 0 went to the evidence failure before any of this,
    // so the cap fired from rung 1: a mid-ladder position, not the ladder's starting one.
    const rungs = evs.filter((e) => e.event === "escalation" && e.taskId === "T1");
    expect(rungs.map((e) => e.data.step)).toEqual(["retry", "retry", "escalate", "retry", "consult", "human"]);
    expect(rungs[0]!.data.repair).toBeUndefined();       // ladder rung 0 (the evidence failure)
    expect(rungs[1]!.data.repair).toBe(1);               // a repair — it consumes no rung
    expect(rungs[2]!.data.fingerprintCap).toBe(true);    // the cap took rung 1 (escalate) and spent it
    expect(rungs[3]!.data.repair).toBe(2);               // the second and last funded repair
    // then the ladder's own end, on its own budget — the cap bought nothing extra
    expect(evs.filter((e) => e.taskId === "T1").at(-1)!.event).toBe("task-human");

    // ── and the rerouted retry still knows WHY the last attempt failed ──
    // The consult's guidance is ADDED to the brief the journal already holds, never swapped for it:
    // no retry discards information the journal already holds about the previous failure.
    const rerouted = promptOf(repo, "run-fingerprint-cap", 3);
    expect(rerouted).toContain("## Previous attempt failed gates — fix these specifically");
    expect(rerouted).toContain(String(fails[1]!.data.details));  // the journalled failure bytes …
    expect(rerouted).toContain("try that again");                // … alongside the consult guidance
  }, 180_000);

  test("a terminal cap consult vetoes an identical retry but not a rung that already changes channel", async () => {
    // Rule: a terminal cap consult vetoes a same-channel retry, but it cannot veto an `escalate`
    // rung that already satisfies the cap's ban by changing channel. These two fixtures assert both
    // directions at the boundary: retry parks; escalate continues on a different assignment.
    const { repo, fake } = setupRepo(
      [T("T1", { acceptance: [{ oracle: "command", command: "cat boom.txt; exit 1" }] })],
      {
        consult: { action: "human", notes: "cannot adjudicate" }, // terminal: neither retry nor reroute
        tasks: { T1: [
          { shell: `printf 'expected true at /tmp/wt-1111/src/a.ts:12:3 in 1.1s\\n' > boom.txt && ${COMMIT} b1`, result: { ok: true, summary: "a0" } },
          { shell: `printf 'expected true at /tmp/wt-2222/src/a.ts:99:7 in 9.9s\\n' > boom.txt && ${COMMIT} b2`, result: { ok: true, summary: "a1" } },
        ] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-cap-terminal" });
    expect(s.human).toEqual(["T1"]);
    const evs = evsOf(repo, "run-cap-terminal");

    const cap = evs.filter((e) => e.event === "gate-fingerprint-cap" && e.taskId === "T1");
    expect(cap).toHaveLength(1);
    const capAt = evs.indexOf(cap[0]!);
    // The dangerous shape really is the one under test: rung `retry`, then a TERMINAL verdict.
    expect(evs[capAt + 1]!.data.step).toBe("retry");
    expect(evs[capAt + 1]!.data.fingerprintCap).toBe(true);
    expect(evs[capAt + 2]!.event).toBe("consult-verdict");
    expect(evs[capAt + 2]!.data.action).toBe("human");
    expect(evs[capAt + 2]!.data.capAdvisory).toBeUndefined();
    expect(evs[capAt + 3]!.event).toBe("task-human");
    expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(2);
    expect(evs.slice(capAt).some((e) => e.event === "retry-same-banned" && e.taskId === "T1")).toBe(false);

    const escalated = setupRepo(
      [T("T1")],
      {
        consult: { action: "human", notes: "cannot adjudicate" },
        tasks: { T1: [
          { shell: "true", result: { ok: true, summary: "no commit one" } },
          { shell: "true", result: { ok: true, summary: "no commit two" } },
          { shell: `echo fixed > fixed.txt && ${COMMIT} fixed`, result: { ok: true, summary: "different channel fixed it" } },
        ] },
      },
    );
    const moved = await runDaemon(escalated.repo, { adapters: [escalated.fake], runId: "run-cap-terminal-escalate" });
    expect(moved.done).toEqual(["T1"]);
    const movedEvents = evsOf(escalated.repo, "run-cap-terminal-escalate");
    const movedCap = movedEvents.find((e) => e.event === "gate-fingerprint-cap" && e.taskId === "T1")!;
    const movedCapAt = movedEvents.indexOf(movedCap);
    expect(movedEvents[movedCapAt + 1]!.data.step).toBe("escalate");
    expect(movedEvents[movedCapAt + 2]).toMatchObject({
      event: "consult-verdict",
      data: { action: "human", capAdvisory: true },
    });
    expect(movedEvents.slice(movedCapAt).some((e) => e.event === "task-human" && e.taskId === "T1")).toBe(false);
    const movedDispatches = movedEvents.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(movedDispatches).toHaveLength(3);
    const assignmentKey = (e: JournalEvent) => {
      const a = e.data.assignment as { adapter: string; model: string };
      return `${a.adapter}:${a.model}`;
    };
    expect(assignmentKey(movedDispatches[2]!)).not.toBe(assignmentKey(movedDispatches[1]!));
  }, 180_000);

  test("a repair is cancelled when the recreated worktree loses the commits it was funded on", async () => {
    // Repair eligibility is decided one attempt BEFORE the carry that has to hold it. When the
    // recreation drops a landed commit — a concurrently advanced integration tip, a cherry-pick
    // conflict — a fix-only contract would quote a diff whose implementation is missing and forbid
    // the worker from rebuilding the rest. The precondition is therefore re-validated after the
    // carry, and the fresh ladder owns that dispatch instead.
    const { repo, fake } = setupRepo(
      [T("T1", { acceptance: [{ oracle: "command", command: "test -f pass.txt" }] })],
      {
        consult: { action: "human", notes: "a cancelled repair must not need a consult" },
        tasks: { T1: [
          { shell: `echo impl > impl.txt && ${COMMIT} impl`, result: { ok: true, summary: "a0" } },
          { shell: `touch pass.txt && ${COMMIT} pass`, result: { ok: true, summary: "a1" } },
        ] },
      },
    );
    const inner = new SubprocessDriver();
    let recreations = 0;
    const carryLosingDriver = {
      id: "carry-loss",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      async worktree(root: string, branch: string, base: string) {
        const wt = await inner.worktree(root, branch, base);
        // the RETRY's recreation lands a conflicting commit first, so cherry-picking attempt 0's
        // landed work onto it fails — the OBS-212 shape, reproduced deterministically
        if (branch.endsWith("--T1") && recreations++ === 1) {
          execSync("printf 'clobber\\n' > impl.txt && git add -A && git commit -q --no-gpg-sign -m clobber", { cwd: wt });
        }
        return wt;
      },
    } as unknown as ExecutorDriver;

    await runDaemon(repo, { adapters: [fake], runId: "run-repair-carry-loss", driver: carryLosingDriver });
    const evs = evsOf(repo, "run-repair-carry-loss");

    // the repair really was funded, and the carry really did lose the commit it was funded on
    expect(evs.filter((e) => e.event === "repair-attempt" && e.taskId === "T1")).toHaveLength(1);
    const loss = evs.find((e) => e.event === "work-loss" && e.taskId === "T1")!;
    expect(loss).toBeDefined();
    expect((loss.data.lost as string[]).length).toBeGreaterThan(0);

    // …so no fix-only prompt was built over the incomplete tree
    const cancelled = evs.filter((e) => e.event === "repair-cancelled" && e.taskId === "T1");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.data.lost).toEqual(loss.data.lost);
    expect(evs.filter((e) => e.event === "repair-dispatch" && e.taskId === "T1")).toHaveLength(0);
    const prompt = promptOf(repo, "run-repair-carry-loss", 1);
    expect(prompt).not.toContain("## Repair attempt");
    expect(prompt).not.toContain("### The work under review");
    // the launch event names what the worker actually received, not the mode intended before the carry
    const launch = evs.filter((e) => e.event === "worker-launch" && e.taskId === "T1");
    expect(launch[1]!.data.retryMode).toBe("fresh");
    // …and the retry still knows why the last attempt failed — cancelling a repair is not amnesia
    expect(prompt).toContain("## Previous attempt failed gates — fix these specifically");
    expect(prompt).toContain("oracle failed");
  }, 180_000);

  test("no retry discards information the journal already holds about why the last attempt failed", async () => {
    // One run that walks EVERY kind of re-dispatch this seam can produce — repair, repair, the fresh
    // ladder's retry, an escalate onto another channel, and a consult verdict of retry — and asserts
    // the same thing of each: the prompt reproduces the gate-result bytes the journal already holds
    // for the attempt before it. The consult round is the one that used to lose them, by replacing
    // the brief with its own guidance rather than adding to it.
    const { repo, fake } = setupRepo(
      [T("T1", { acceptance: [{ oracle: "command", command: "cat marker.txt; test -f pass.txt" }] })],
      {
        consult: { action: "retry", notes: "commit the marker file this time" },
        tasks: { T1: [
          { shell: `echo one > marker.txt && ${COMMIT} m1`, result: { ok: true, summary: "a0" } },
          { shell: `echo two > marker.txt && ${COMMIT} m2`, result: { ok: true, summary: "a1" } },
          { shell: `echo three > marker.txt && ${COMMIT} m3`, result: { ok: true, summary: "a2" } },
          { shell: `echo four > marker.txt && ${COMMIT} m4`, result: { ok: true, summary: "a3" } },
          { shell: `echo five > marker.txt && ${COMMIT} m5`, result: { ok: true, summary: "a4" } },
          { shell: `touch pass.txt && ${COMMIT} pass`, result: { ok: true, summary: "a5" } },
        ] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-no-amnesia" });
    expect(s.done).toEqual(["T1"]);
    const evs = evsOf(repo, "run-no-amnesia");

    // every kind of re-dispatch really did occur in this one run
    const modes = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1").map((e) => e.data.retryMode);
    expect(modes.slice(1, 3)).toEqual(["repair", "repair"]);
    const steps = evs.filter((e) => e.event === "escalation" && e.taskId === "T1").map((e) => e.data.step);
    expect(steps).toEqual(["retry", "retry", "retry", "escalate", "consult"]);
    expect(evs.filter((e) => e.event === "consult-verdict" && e.data.action === "retry")).toHaveLength(1);

    // …and not one of them dropped the failure bytes the journal was already holding
    const fails = evs.filter((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.pass === false);
    expect(fails).toHaveLength(5);
    fails.forEach((f, i) => {
      expect(promptOf(repo, "run-no-amnesia", i + 1), `attempt ${i + 1}`).toContain(String(f.data.details));
    });
    // the consult round carries its guidance ON TOP of them, never instead of them
    expect(promptOf(repo, "run-no-amnesia", 5)).toContain("commit the marker file this time");
  }, 180_000);

  test("test: a dispatch death before worker-result followed by retry-failed reproduces the upheld finding bytes exactly", async () => {
    const runId = "run-obs254";
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })],
      {
        review: {
          approve: false,
          findings: [{ note: "`applyBudget` in src/run/budget.ts ignores the configured cap", severity: "material" }],
          comments: [{ path: "src/run/budget.ts", line: 42, body: "cap is read but never applied in `applyBudget`" }],
        },
        consult: { action: "human", notes: "review park" },
        tasks: { T1: [{ shell: `echo v > v.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
      },
    );
    // 1) the reviewer requests changes until the engagement's round cap parks the task
    const first = await runDaemon(repo, { adapters: [fake], runId });
    expect(first.human).toEqual(["T1"]);
    const upheldDetails = String([...evsOf(repo, runId)].reverse().find((e) => e.event === "gate-result"
      && e.taskId === "T1" && e.data.gate === "review" && e.data.pass === false)!.data.details);
    expect(upheldDetails).toContain("applyBudget");

    // This is also where an identically-repeating REVIEW failure lands, and why the fingerprint cap
    // leaves that one gate to REVIEW_ROUND_CAP: the rounds here are normalized-identical, so an
    // uncapped review WOULD be the loop the cap exists to stop — but the round cap already stopped it
    // in two, and stopped it at the OPERATOR rather than at a consult. Pre-empting a strictly tighter
    // bound would trade a human decision for an LLM round, which is the trade backwards.
    const reviewFails = evsOf(repo, runId).filter((e) => e.event === "gate-result"
      && e.taskId === "T1" && e.data.gate === "review" && e.data.pass === false);
    expect(reviewFails).toHaveLength(2); // REVIEW_ROUND_CAP
    expect(new Set(reviewFails.map((e) => normalizeGateFailure(String(e.data.details)))).size).toBe(1);
    expect(evsOf(repo, runId).some((e) => e.event === "gate-fingerprint-cap")).toBe(false);

    // 2) the operator sides WITH the reviewer and funds one fixed attempt
    await approve([runId, "T1", "--by", "test", "--uphold"], repo);

    // 3) that funded attempt dies at dispatch — the dangerous case: BEFORE any worker-result
    await runDaemon(repo, { adapters: [fake], runId, resume: true, driver: dispatchDeathDriver() });
    const afterDeath = evsOf(repo, runId);
    expect(recordedTaskFailureKind(afterDeath, "T1")).toBe("dispatch");
    const lastDispatch = afterDeath.map((e) => e.event).lastIndexOf("task-dispatch");
    expect(afterDeath.slice(lastDispatch).some((e) => e.event === "worker-result")).toBe(false);

    // a stale prompt must not be able to answer for the retry
    const promptPath = join(tickmarkrDir(repo), "runs", runId, "prompts", "T1-a0.md");
    writeFileSync(promptPath, "STALE — no dispatch happened\n");
    const dispatchesBefore = afterDeath.filter((e) => e.event === "task-dispatch" && e.taskId === "T1").length;

    // 4) the prescribed recovery
    await runDaemon(repo, { adapters: [fake], runId, resume: true, retryFailed: true });
    const evs = evsOf(repo, runId);
    expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1").length).toBeGreaterThan(dispatchesBefore);

    // the retry reproduces the upheld finding BYTES — never a heading over an empty section
    const prompt = readFileSync(promptPath, "utf8");
    expect(prompt).not.toContain("STALE");
    expect(prompt).toContain("## Previous attempt failed gates — fix these specifically");
    expect(prompt).toContain("The operator UPHELD the reviewer's findings");
    expect(prompt).toContain(upheldDetails);
    expect(prompt).toContain("`applyBudget` in src/run/budget.ts ignores the configured cap");
    const dispatchError = String([...afterDeath].reverse().find((e) => e.event === "task-failed"
      && e.taskId === "T1")!.data.error);
    expect(dispatchError).toBe("Error: pane wedged: dispatch never registered");
    expect(prompt).toContain(`dispatch: ${dispatchError}`);
  }, 240_000);
});

// ── R3 (OBS-186): a declined review is journal truth, and an honest decline is not a failed gate ──
// The retired branch returned `pass: true` on a complexity comparison, so a review that never ran was
// indistinguishable in the ledger from one that ran and approved. Participation is path-keyed now, the
// decline says so, and the merge decision had to learn that an unrun gate is not a red one — otherwise
// honesty alone would have parked every judge-only task at the merge it was never asked to review.

/** A task whose declared paths are ALL leaf-class, and whose one commit stays inside that class. */
const leafTaskRepo = () => setupRepo(
  [T("T1", { files: ["docs/**", "CHANGELOG.md"] })],
  { tasks: { T1: [{
    shell: `mkdir -p docs && echo '# guide' > docs/guide.md && ${COMMIT} docs`,
    result: { ok: true, summary: "documented the thing" },
  }] } },
);

describe("R3 declined review — journal truth and merge (OBS-186)", () => {
  test("test: a skipped review journals verdict skipped with a policy id and never pass true", async () => {
    const { repo, fake } = leafTaskRepo();
    await runDaemon(repo, { adapters: [fake], runId: "run-r3-journal" });

    const evs = Journal.open(repo, "run-r3-journal").read();
    const review = evs.filter((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "review");
    expect(review).toHaveLength(1);
    const data = review[0]!.data;
    expect(data.pass).not.toBe(true); // a gate that never ran cannot claim a pass
    expect(data.skipped).toBe(true);
    expect(data.verdict).toBe("skipped");
    expect(data.policy).toBe("judge-only"); // the policy id that declined it
    expect(String(data.reason)).toMatch(/leaf/i); // …and why
    expect(String(data.details)).toMatch(/^skipped\b/);
    // the row is legible without the details prose: policy + reason are structured fields
    expect(Object.keys(data)).toEqual(expect.arrayContaining(["verdict", "policy", "reason", "skipped"]));

    // …and it does not claim a FAILURE either. `pass:false` for a decline is one boolean, but it is
    // the boolean five folds outside the daemon key on, and none of them can see `skipped`: the
    // engagement round budget, the operator's failed-gate list, the record's gate-failure total, the
    // retry brief. Assert the REAL consumers on the REAL journal, not a hand-built row.
    expect(data.pass).toBeUndefined(); // the ledger states no verdict it does not have
    expect(reviewRoundsSinceApproval(evs, "T1")).toBe(0); // a skip never spends a review round
    expect(journaledFailureBrief(evs, "T1")).toEqual([]); // …and never becomes "fix this" feedback
    expect(evs.filter((e) => e.event === "gate-result" && e.data.pass === false)).toEqual([]);
    // …and structured findings are never synthesised from a decline's prose
    expect(data.findings).toBeUndefined();

    // the engagement record: declined is its own state, counted in neither total
    const md = renderMarkdownRecord("run-r3-journal", evs);
    expect(md).toContain("review: declined");
    expect(md).not.toContain("review: pass");
    expect(md).not.toContain("review: fail");
    expect(md).toMatch(/\*\*gate failures:\*\* none recorded/);
  }, 60_000);

  test("test: merge treats a review verdict of pass false with skipped true as non-failure and the task can merge", async () => {
    const { repo, fake } = leafTaskRepo();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-r3-merge" });

    expect(s.done).toEqual(["T1"]); // the honest decline did not park the task
    expect(s.human).toEqual([]);
    const evs = Journal.open(repo, "run-r3-merge").read();
    const review = evs.find((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "review")!;
    // the exact shape the merge predicate has to accept: a GateResult carrying pass:false AND
    // skipped:true (the ledger row drops the verdict it does not have — see the journal test above).
    expect(review.data.skipped).toBe(true);
    expect(review.data.pass).not.toBe(true);
    expect(evs.some((e) => e.event === "merge" && e.taskId === "T1")).toBe(true);
    expect(evs.some((e) => e.event === "task-done" && e.taskId === "T1")).toBe(true);
    // …and it is the SKIP that is forgiven, never a red verdict: a review that RAN and failed still
    // blocks, so the predicate cannot be read as "review no longer gates".
    const { repo: red, fake: redFake } = setupRepo(
      [T("T2", { files: ["src/run/daemon.ts"] })],
      {
        consult: { action: "human", notes: "reviewer blocked it" },
        review: { approve: false, issues: ["the retry loop drops its last iteration"] },
        tasks: { T2: [{ shell: `mkdir -p src/run && echo 'export const x = 1;' > src/run/daemon.ts && ${COMMIT} src`, result: { ok: true, summary: "changed source" } }] },
      },
    );
    const blocked = await runDaemon(red, { adapters: [redFake], runId: "run-r3-red" });
    expect(blocked.done).toEqual([]);
    const redEvs = Journal.open(red, "run-r3-red").read();
    const redReview = redEvs.find((e) => e.event === "gate-result" && e.taskId === "T2" && e.data.gate === "review")!;
    expect(redReview.data.pass).toBe(false);
    expect(redReview.data.skipped).toBeUndefined(); // a verdict, not a decline
    expect(redEvs.some((e) => e.event === "merge" && e.taskId === "T2")).toBe(false);
  }, 120_000);
});

describe("v1.86 T7 the fatal handler cannot eat the error it reports", () => {
  // A node-style errno exception, as appendFileSync/readFileSync throw them.
  const fault = (code: string, message: string) => Object.assign(new Error(message), { code });

  // A repo whose run dies in the fatal window (after run-start, before the task loop):
  // refs/heads/tickmarkr blocks refs/heads/tickmarkr/<runId>, so ensureIntegration throws.
  const setupFatalRepo = async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    await shOk("git branch tickmarkr", repo);
    return { repo, fake };
  };
  const originalErrorResembles = (runId: string) => new RegExp(`tickmarkr/${runId}|cannot lock ref|command failed`);

  const rejectionOf = async (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => { throw new Error("expected runDaemon to reject"); },
      (e) => e,
    );

  // Faults injected at the journal's only durable sink, scoped to run-end appends so run-start and
  // the rest of the setup path write normally. Returns the run-end attempt count.
  const failRunEndAppends = (implant: (call: number, journal: Journal) => void) => {
    const real = Journal.prototype.append;
    let calls = 0;
    vi.spyOn(Journal.prototype, "append").mockImplementation(function (this: Journal, event: string, taskId?: string, data?: Record<string, unknown>) {
      if (event === "run-end") {
        calls += 1;
        implant(calls, this); // throws to simulate the sink fault; returns to write through
      }
      return real.call(this, event, taskId, data);
    });
    return { count: () => calls };
  };

  const captureConsoleErrors = () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    return { lines: () => spy.mock.calls.map((args) => args.map(String).join(" ")) };
  };

  const journalPathOf = (repo: string, runId: string) => join(Journal.open(repo, runId).dir, "journal.jsonl");

  test("test: a failing journal append during fatal handling surfaces both the original error and the append failure, proven member by member over the closed set of append failures — a full-disk fixture, a permission fixture and a closed-handle fixture", async () => {
    const members = [
      { name: "full-disk", make: () => fault("ENOSPC", "ENOSPC: no space left on device, write") },
      { name: "permission", make: () => fault("EACCES", "EACCES: permission denied, open") },
      { name: "closed-handle", make: () => fault("EBADF", "EBADF: bad file descriptor, write") },
    ];
    for (const member of members) {
      const runId = `run-t7-append-${member.name}`;
      const { repo, fake } = await setupFatalRepo();
      const sink = member.make();
      failRunEndAppends(() => { throw sink; });
      const consoleErrors = captureConsoleErrors();

      const err = await rejectionOf(runDaemon(repo, { adapters: [fake], runId }));
      const reported = consoleErrors.lines();
      vi.restoreAllMocks();

      // the original error reaches the caller — never replaced by the append failure
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBe(sink);
      expect((err as Error).message).toMatch(originalErrorResembles(runId));
      expect((err as Error).message).not.toContain(sink.message);
      // and the append failure is surfaced ALONGSIDE the original error, not instead of it
      expect(reported.some((line) => line.includes(sink.message) && line.includes((err as Error).message))).toBe(true);
    }
  });

  test("test: a journal read that throws inside the fatal handler is reported alongside the original error rather than replacing it, and the original error still reaches the caller when the read and the append fail independently", async () => {
    const runId = "run-t7-read-fatal";
    const { repo, fake } = await setupFatalRepo();
    const readFault = fault("EIO", "EIO: i/o error, read");
    const realRead = Journal.prototype.read;
    vi.spyOn(Journal.prototype, "read").mockImplementation(function (this: Journal) {
      const events = realRead.call(this);
      // only the fatal handler reads this journal after run-start in this scenario
      if (events.some((e) => e.event === "run-start")) throw readFault;
      return events;
    });
    const appendFault = fault("ENOSPC", "ENOSPC: no space left on device, write");
    failRunEndAppends(() => { throw appendFault; });
    const consoleErrors = captureConsoleErrors();

    const err = await rejectionOf(runDaemon(repo, { adapters: [fake], runId }));
    const reported = consoleErrors.lines();
    vi.restoreAllMocks();

    // the original error reaches the caller even with the read and the append failing independently
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(originalErrorResembles(runId));
    expect((err as Error).message).not.toContain(readFault.message);
    expect((err as Error).message).not.toContain(appendFault.message);
    // the read failure is reported alongside the original error, never replacing it
    expect(reported.some((line) => line.includes(readFault.message) && line.includes((err as Error).message))).toBe(true);
    // …and the independently-failing append is reported too, naming the journal path
    expect(reported.some((line) => line.includes(appendFault.message) && line.includes(journalPathOf(repo, runId)))).toBe(true);
  });

  test("test: an append that fails once and succeeds on retry writes run-end and the journal replays to a terminal state, proven over the closed set of one-shot faults — a transient-EIO fixture, a first-call-throws fixture, and a partial-write fixture that leaves a malformed trailing prefix on disk rather than throwing before any bytes land", async () => {
    const members: Array<{ name: string; implant: (journal: Journal) => void }> = [
      { name: "transient-eio", implant: () => { throw fault("EIO", "EIO: i/o error, write"); } },
      { name: "first-call-throws", implant: () => { throw new Error("simulated first-call failure"); } },
      {
        name: "partial-write",
        implant: (journal) => {
          // bytes land BEFORE the failure: a torn, malformed fragment with no terminating newline
          appendFileSync(join(journal.dir, "journal.jsonl"), '{"ts":"TORN-PARTIAL-WRITE');
          throw fault("EIO", "EIO: i/o error, write");
        },
      },
    ];
    for (const member of members) {
      const runId = `run-t7-retry-${member.name}`;
      const { repo, fake } = await setupFatalRepo();
      const attempts = failRunEndAppends((call, journal) => {
        if (call === 1) member.implant(journal);
      });

      const err = await rejectionOf(runDaemon(repo, { adapters: [fake], runId }));
      vi.restoreAllMocks();

      expect((err as Error).message).toMatch(originalErrorResembles(runId));
      expect(attempts.count()).toBe(2); // failed once, retried ONCE, succeeded
      const events = Journal.open(repo, runId).read();
      expect(runHasEnded(events)).toBe(true); // the journal replays to a terminal state
      const runEnds = events.filter((e) => e.event === "run-end");
      expect(runEnds).toHaveLength(1);
      expect(runEnds[0]!.data.fatal).toBe(true);
      expect(runEnds[0]!.data.phase).toBe("setup");
      expect(runEnds[0]!.data.error).toBe((err as Error).message);
      if (member.name === "partial-write") {
        // the torn fragment stays on disk as a dropped malformed line — recovery never truncates
        expect(readFileSync(journalPathOf(repo, runId), "utf8")).toContain("TORN-PARTIAL-WRITE");
      }
    }
  });

  test("test: a persistently unwritable sink reports a crash carrying no terminal record and naming the journal path, rather than reporting an ended run, proven member by member over the closed set of persistent sinks — a permission-denied fixture, a full-disk fixture and a read-only-filesystem fixture", async () => {
    const members = [
      { name: "permission-denied", make: () => fault("EACCES", "EACCES: permission denied, open") },
      { name: "full-disk", make: () => fault("ENOSPC", "ENOSPC: no space left on device, write") },
      { name: "read-only-filesystem", make: () => fault("EROFS", "EROFS: read-only file system, open") },
    ];
    for (const member of members) {
      const runId = `run-t7-dead-${member.name}`;
      const { repo, fake } = await setupFatalRepo();
      const sink = member.make();
      const attempts = failRunEndAppends(() => { throw sink; });
      const consoleErrors = captureConsoleErrors();

      const err = await rejectionOf(runDaemon(repo, { adapters: [fake], runId }));
      const reported = consoleErrors.lines();
      vi.restoreAllMocks();

      // the original error reaches the caller
      expect((err as Error).message).toMatch(originalErrorResembles(runId));
      expect((err as Error).message).not.toContain(sink.message);
      // retried ONCE, then fail-closed: no terminal record on evidence the harness could not write
      expect(attempts.count()).toBe(2);
      const events = Journal.open(repo, runId).read();
      expect(events.some((e) => e.event === "run-end")).toBe(false);
      expect(runHasEnded(events)).toBe(false);
      // the crash report names the journal path and both failures — and never claims an ended run
      const crash = reported.find((line) => line.includes(journalPathOf(repo, runId)));
      expect(crash).toBeDefined();
      expect(crash!).toContain(sink.message);
      expect(crash!).toContain((err as Error).message);
      expect(crash!).not.toMatch(/\brun ended\b/i);
    }
  });

  test("test: the original error's message and stack survive verbatim on the thrown object and its cause, while the operator-visible line stays the one-line dispatcher form carrying no raw stack, proven by routing the rejection through the dispatcher", async () => {
    const runId = "run-t7-verbatim";
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "unreachable" } }] } },
      "gates:\n  build: definitely-missing-tickmarkr-build\n  test: definitely-missing-tickmarkr-test\n",
    );
    const cause = new Error("root cause fixture");
    const sentinel = new Error("sentinel original failure", { cause });
    const real = Journal.prototype.append;
    // missing baseline commands produce baseline-warning appends INSIDE the fatal window (after
    // run-start, before the task loop); the first one throws our sentinel, becoming the run's fatal
    vi.spyOn(Journal.prototype, "append").mockImplementation(function (this: Journal, event: string, taskId?: string, data?: Record<string, unknown>) {
      if (event === "baseline-warning") throw sentinel;
      return real.call(this, event, taskId, data);
    });

    const err = await rejectionOf(runDaemon(repo, { adapters: [fake], runId }));
    vi.restoreAllMocks();

    // the thrown object IS the original error: message, stack and cause survive verbatim
    expect(err).toBe(sentinel);
    expect((err as Error).message).toBe("sentinel original failure");
    expect((err as Error).stack).toBe(sentinel.stack);
    expect((err as Error).cause).toBe(cause);
    expect(((err as Error).cause as Error).message).toBe("root cause fixture");
    expect(((err as Error).cause as Error).stack).toBe(cause.stack);
    // the fatal run-end still records the original error's message
    const events = Journal.open(repo, runId).read();
    expect(events.at(-1)?.event).toBe("run-end");
    expect(events.at(-1)?.data.error).toBe("sentinel original failure");
    // routed through the dispatcher, the operator-visible line is the one-line form — no raw stack
    // Load the eager CLI entrypoint only at the assertion that needs its dispatcher. A static import
    // makes daemon.test collection load every command (including Ink) while app.test is observing
    // its first rendered frame, turning that production-path oracle into a suite-load race.
    const { dispatch } = await import("../../src/cli/index.js");
    const result = await dispatch("run", [], { run: () => Promise.reject(err) });
    expect(result.code).toBe(1);
    expect(result.out).toBe("tickmarkr run: sentinel original failure");
    expect(result.out).not.toContain("\n");
    expect(result.out).not.toContain("    at ");
  });
});
