// The daemon suite is partitioned across this file and tests/run/daemon/*.test.ts so the runner,
// which schedules by file, stops serialising the whole suite behind one 400s+ file. This file keeps
// the `daemon integration` block and stays the path the shipped testing guide cites; the retry,
// stall, harvest and fleet/gate blocks moved beside it unchanged — same describe and test titles.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { type BillingChannel, shq } from "../../src/adapters/types.js";
import { TIER_RANK, type Tier } from "../../src/config/config.js";
import { DeliveryReadinessError } from "../../src/drivers/herdr.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName, type Slot } from "../../src/drivers/types.js";
import { gatePaneName } from "../../src/gates/llm.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead, shOk, worktreePath } from "../../src/run/git.js";
import { Journal, recordedTaskFailureKind } from "../../src/run/journal.js";
import { normalizeGateOutcome } from "../../src/run/outcome.js";
import { COMMIT, authedModels, setupRepo, T } from "../helpers/tmprepo.js";


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

  // Both infra criteria inspect independent seams of the same terminal verdict. Reuse one completed
  // daemon run so this coverage does not double the suite's process fan-out under constrained hosts.
  let oracleInfraFixture: Promise<{ repo: string; summary: Awaited<ReturnType<typeof runDaemon>> }> | undefined;
  const runOracleInfraFixture = () => oracleInfraFixture ??= (async () => {
    const command = "printf '%s\\n' 'Token not found in system keyring' >&2; exit 1";
    const { repo, fake } = setupRepo(
      [T("T1", { acceptance: [{ oracle: "command", command }] })],
      { tasks: { T1: [{ shell: `echo landed > landed.txt && ${COMMIT} landed`, result: { ok: true, summary: "landed" } }] } },
    );
    const summary = await runDaemon(repo, { adapters: [fake], runId: "run-oracle-infra" });
    return { repo, summary };
  })();

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

  test("an infra-caused verdict neither increments the gate-failure count nor spends a ladder rung in the daemon's attempt loop, so an infra red that funds a retry fails", async () => {
    const { repo, summary } = await runOracleInfraFixture();
    expect(summary.human).toEqual(["T1"]);
    const events = Journal.open(repo, "run-oracle-infra").read();
    expect(events.filter((event) => event.event === "task-dispatch" && event.taskId === "T1")).toHaveLength(1);
    expect(events.some((event) => event.event === "escalation" && event.taskId === "T1")).toBe(false);
    expect(events.find((event) => event.event === "task-human" && event.taskId === "T1")?.data.kind).toBe("infra");
    const row = telem(repo, "run-oracle-infra").find((entry) => entry.taskId === "T1")!;
    expect(row.parkKind).toBe("infra");
    expect(row.gateFails).toBe(0);
  });

  test("a judge refusal that evaluated the diff still charges its attempt as a quality failure even when its prose mentions credentials, secrets, tokens or a keyring, so a classifier that reads a judge's reason text fails", async () => {
    const reason = "the login handler accepts the credentials but the error banner is missing; its secret and token copy also names the system keyring";
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        judge: [
          { pass: false, criteria: [{ criterion: "c1", met: false, reason }] },
          { pass: true, criteria: [{ criterion: "c1", met: true, reason: "the repaired diff satisfies the criterion" }] },
        ],
        review: { approve: true, issues: [] },
        tasks: { T1: [{ shell: `echo landed > landed.txt && ${COMMIT} landed`, result: { ok: true, summary: "landed" } }] },
      },
    );

    const summary = await runDaemon(repo, { adapters: [fake], runId: "run-judge-prose-quality" });
    expect(summary.done).toEqual(["T1"]);
    const events = Journal.open(repo, "run-judge-prose-quality").read();
    const refusals = events.filter((event) =>
      event.event === "gate-result" && event.taskId === "T1" && event.data.gate === "acceptance" && event.data.pass === false
    );
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.every((event) => event.data.infra === undefined)).toBe(true);
    expect(refusals.every((event) => String(event.data.details).includes(reason))).toBe(true);
    expect(events.some((event) => event.event === "escalation" && event.taskId === "T1")).toBe(true);
    const row = telem(repo, "run-judge-prose-quality").find((entry) => entry.taskId === "T1")!;
    expect(row.gateFails).toBe(1);
  });

  test("the journal row for an infra verdict carries its retryable field so a reader reconstructs the verdict as recorded, so a seam that forwards infra and drops retryable fails", async () => {
    const { repo } = await runOracleInfraFixture();
    const row = Journal.open(repo, "run-oracle-infra").read().find((event) =>
      event.event === "gate-result" && event.taskId === "T1" && event.data.gate === "acceptance"
    )!;
    expect(row.data).toMatchObject({ pass: false, infra: true, retryable: false });
    expect(normalizeGateOutcome(row.data)).toEqual({
      kind: "infra",
      reason: row.data.details,
      retryable: false,
    });
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
