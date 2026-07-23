import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { kimiSessionId } from "../../src/adapters/kimi.js";
import { type BillingChannel, shq } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { TIER_RANK, type Tier } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName, type Slot } from "../../src/drivers/types.js";
import { gatePaneName } from "../../src/gates/llm.js";
import { graphDefinitionHash, loadGraph, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon, resetEarlyLaunchLivenessMsForTests, setEarlyLaunchLivenessMsForTests } from "../../src/run/daemon.js";
import { gitHead, sanitizeBranch, shOk, worktreePath, WORKTREES_DIR } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, authedModels, setupRepo, T } from "../helpers/tmprepo.js";

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
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "nothing 1" } },
        { shell: "true", result: { ok: true, summary: "nothing 2" } },
        { shell: `echo third > f.txt && ${COMMIT} third`, result: { ok: true, summary: "third time lucky" } },
      ] } },
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
    expect(fake2.consultModels).toEqual(["fake-9"]); // the live prefer seat answered, with its entry's model
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
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      {
        review: { approve: false, issues: ["not good enough"] }, // legitimate rejection every attempt
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
    expect(s.human).toEqual(["T1"]); // the legitimate path: review rejections → consult → park
    // D-07: judge panes self-clean between attempts — canonical names reuse safely (no agent_name_taken)
    expect(names.filter((n) => n === formatOwnedName({ role: "judge", taskId: "T1", attempt: 0, runId: "run-uniq" })).length).toBeGreaterThanOrEqual(2);
    expect(names).toContain(gatePaneName("consult", "T1")); // consult pane named + kept too
    // WR-01: consult routes through the dedicated-tab label path (guards run-104447 mislabel regression);
    // T2: the canonical identity rides opts.owned (the legacy name param stays for subprocess spies)
    expect(slotOpts.find((o) => o.name === gatePaneName("consult", "T1"))?.opts).toEqual({ label: "CONSULT T1", owned: { role: "consult", taskId: "T1", attempt: 0, runId: "run-uniq" } });
  });

  // v1.70 T5 (review-convergence): a task whose review keeps drawing material findings must not cycle
  // through review rounds forever. With consult answering "retry" the escalation ladder would loop until
  // the global attempt cap; the review round cap stops it far earlier and parks for a human decision.
  test("a task that has already reached the review round cap is parked for a human decision instead of dispatching another review round", async () => {
    const { repo, fake } = setupRepo(
      // deterministic command oracle for acceptance: the review gate is the one under test, so this
      // isolates it and avoids spawning a fake-judge subprocess on every one of the (up to 4) rounds.
      [T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })],
      {
        review: { approve: false, findings: [{ note: "blocking bug", severity: "material" }] }, // material every round
        consult: { action: "retry", notes: "keep going" }, // never parks via consult — only the cap can stop it
        tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-revcap" });
    expect(s.human).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-revcap").read();
    const humanEv = evs.find((e) => e.event === "task-human" && e.taskId === "T1");
    expect(String(humanEv?.data.reason)).toMatch(/review round cap/i);
    // exactly REVIEW_ROUND_CAP failing review rounds ran, then the cap parked it before a 4th round
    const reviewRounds = evs.filter((e) =>
      e.event === "gate-result" &&
      (e.data as { gate?: string }).gate === "review" &&
      (e.data as { pass?: boolean }).pass === false,
    ).length;
    expect(reviewRounds).toBe(3);
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

  test("TEL-02 consult path: gate-fails reach the consult step, retry verdict → pass writes consults:1", async () => {
    // ladder [retry, escalate, consult, human]: three gate-fails walk to the consult step, whose retry
    // verdict feeds a fourth passing attempt. One consult ⇒ consults:1 on the done row.
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
    expect(row.consults).toBe(1); // one consult across the attempt loop, persisted onto the done row
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

  test("a zero-attempt dispatch exception is journaled with a typed non-quality cause", async () => {
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
    const event = Journal.open(repo, "run-dispatch-refusal").read().find((e) => e.event === "task-failed")!;
    expect(event.data).toMatchObject({ kind: "dispatch", attempts: 0 });
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
    class NamedFake extends FakeAdapter {
      constructor(sp: string, public id: string, private models: string[], public vendor: string, private ch: "sub" | "api") {
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
    }

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

    class NamedFake extends FakeAdapter {
      constructor(sp: string, public id: string, private models: string[], public vendor: string, private ch: "sub" | "api") {
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
    }

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

    class NamedFake extends FakeAdapter {
      constructor(sp: string, public id: string, private models: string[], public vendor: string, private ch: "sub" | "api") {
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
    }

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
            T1: [{ shell: `sleep 0.3 && echo A > shared.txt && ${COMMIT} ta`, result: { ok: true, summary: "ta" } }],
            T2: [{ shell: `sleep 0.3 && echo B > shared.txt && ${COMMIT} tb`, result: { ok: true, summary: "tb" } }],
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

describe("OBS-117 early-launch liveness (fake adapter, zero tokens)", () => {
  const SETUP_FAIL = "echo 'zsh: command not found: codex'; exit 1";

  test("the early classification records the same typed dead-channel reason and failover behavior a stall-window classification records today", async () => {
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

  test("the early check adds no new polling timer beyond the existing stall-wait poll cadence", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src/run/daemon.ts"), "utf8");
    expect(src).not.toMatch(/\bsetInterval\s*\(/);
    expect(src).toMatch(/earlyLaunchLivenessMs/);
    expect(src).toMatch(/!everHadOutput && Date\.now\(\) - attemptStart >= earlyLaunchLivenessMs/);
    expect(src).not.toMatch(/setTimeout\([^)]*earlyLaunch/);
  });
});
