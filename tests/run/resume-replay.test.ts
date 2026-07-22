import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { channelKey } from "../../src/adapters/types.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName, parseOwnedName, type ExecutorDriver, type Slot, type SlotOpts } from "../../src/drivers/types.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { COMMIT, makeRepo, setupRepo, T } from "../helpers/tmprepo.js";

// Phase 46 (RES-01/RES-02 daemon half): zero-token daemon-level oracles through the REAL runDaemon on
// the FakeAdapter. Assertions read JOURNAL EVENTS (task-dispatch/resume-restore data), never internals.
// Incident analog: fake:fake-1 is route()'s static marginal-cost pick (sub = flat-rate rank 0, the
// "banned" channel); fake:fake-2 is the consult-chosen failover. Both tier "frontier" ⇒ tier filtering
// is inert, so the only exclusion mechanism in play is the replayed `tried` list + restored assignment.
const fake1 = { adapter: "fake", model: "fake-1", channel: "sub" as const, tier: "frontier" as const };
const fake2 = { adapter: "fake", model: "fake-2", channel: "api" as const, tier: "frontier" as const };
const AUTH_FAIL = "echo 'Not logged in. Please run /login to authenticate.'; exit 1";

// One-task repo + fake script whose step 0 commits a file and returns ok — the resumed dispatch completes
// and merges, proving the seeded state flows through gates unharmed. A fresh FakeAdapter instance resets
// its invoke counter to 0, so the first real (resumed) dispatch maps to script step 0 regardless of the
// replayed attempt number.
const setupResumeRepo = () => {
  const repo = makeRepo({ "base.txt": "base\n" });
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1")] }));
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n");
  const sdir = mkdtempSync(join(tmpdir(), "tickmarkr-rr-"));
  const scriptPath = join(sdir, "s.json");
  writeFileSync(scriptPath, JSON.stringify({
    judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
    review: { approve: true, issues: [] },
    consult: { action: "retry", notes: "retry" },
    tasks: { T1: [{ shell: `echo done > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1 done" } }] },
  }));
  return { repo, fake: new FakeAdapter(scriptPath) };
};

// Pre-write a journal: run-start (REAL baseRef, required by the resume path) + the given events, then
// baseline.json next to the journal (daemon.ts reads it on resume). Mirrors fixture-resume.test.ts.
const seedJournal = async (repo: string, runId: string, events: Array<{ event: string; taskId?: string; data?: object }>) => {
  const j = Journal.create(repo, runId);
  const baseRef = await gitHead(repo);
  j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  for (const e of events) j.append(e.event, e.taskId, e.data ?? {});
  writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
};

// Slice the re-read journal at run-resume: everything AFTER is post-resume (the daemon appends run-resume
// at the start of the resume path, daemon.ts resume block).
const postResume = (all: JournalEvent[]): JournalEvent[] => {
  const idx = all.findIndex((e) => e.event === "run-resume");
  return idx >= 0 ? all.slice(idx + 1) : all;
};

const dispatchAssignment = (e: JournalEvent) => (e.data as { assignment: { adapter: string; model: string } }).assignment;

describe("Phase 46 resume-replay (RES-01/RES-02 daemon oracles, zero tokens)", () => {
  test("RES-01/RES-02: resume continues the escalation ladder (incident analog)", async () => {
    const { repo, fake } = setupResumeRepo();
    await seedJournal(repo, "run-rr1", [
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 0 } },
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 1 } },
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 2 } },
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 3 } },
      { event: "consult-verdict", taskId: "T1", data: { action: "reroute", notes: "banned" } },
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake2, attempt: 4 } },
    ]);
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-rr1", resume: true });
    expect(s.done).toEqual(["T1"]);

    const dispatches = postResume(Journal.open(repo, "run-rr1").read())
      .filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches.length).toBeGreaterThanOrEqual(1);
    const first = dispatches[0]!.data as { attempt: number };

    // a → SC1 (RES-01): first post-resume dispatch carries attempt 5 (5 dispatches burned ⇒ resume at 5)
    expect(first.attempt).toBe(5);
    // b → SC2 (RES-02): the consult-chosen assignment survived the restart (channelKey fake:fake-2)
    expect(channelKey(dispatchAssignment(dispatches[0]!))).toBe("fake:fake-2");
    // c → SC2 (RES-02): the banned channel is NEVER re-dispatched post-resume, across the whole run
    for (const d of dispatches) expect(channelKey(dispatchAssignment(d))).not.toBe("fake:fake-1");
    // d → SC2 oracle: one resume-restore event, tried deep-equals the pre-kill ordered dedup, attempts === 5
    const restores = postResume(Journal.open(repo, "run-rr1").read())
      .filter((e) => e.event === "resume-restore" && e.taskId === "T1");
    expect(restores).toHaveLength(1);
    const rd = restores[0]!.data as { attempts: number; tried: string[] };
    expect(rd.attempts).toBe(5);
    expect(rd.tried).toEqual(["fake:fake-1", "fake:fake-2"]);
  });

  test("trailing reroute edge: kill between verdict and dispatch resumes on the failover", async () => {
    const { repo, fake } = setupResumeRepo();
    await seedJournal(repo, "run-rr2", [
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 0 } },
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 1 } },
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 2 } },
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 3 } },
      { event: "consult-verdict", taskId: "T1", data: { action: "reroute", notes: "banned last channel" } },
    ]);
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-rr2", resume: true });
    expect(s.done).toEqual(["T1"]);

    const dispatches = postResume(Journal.open(repo, "run-rr2").read())
      .filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches.length).toBeGreaterThanOrEqual(1);
    const first = dispatches[0]!.data as { attempt: number };
    // 4 burned ⇒ resume at attempt 4; banned last-dispatched channel excluded, failover picked via
    // nextChannel(..., replayed tried) — the existing router.ts exclusion parameter, zero router changes
    expect(first.attempt).toBe(4);
    expect(channelKey(dispatchAssignment(dispatches[0]!))).toBe("fake:fake-2");
    for (const d of dispatches) expect(channelKey(dispatchAssignment(d))).not.toBe("fake:fake-1");
  });

  // D-03 no-perturbation pin: GREEN on both sides by design — reddens only if a seed ever leaks onto the
  // fresh path. A resume:false run emits NO resume-restore, its first dispatch carries attempt 0.
  test("fresh-run path untouched (D-03): no resume-restore, first dispatch attempt 0", async () => {
    const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-rr3" });
    expect(s.done).toEqual(["T1"]);
    const all = Journal.open(repo, "run-rr3").read();
    expect(all.filter((e) => e.event === "resume-restore")).toHaveLength(0);
    const first = all.find((e) => e.event === "task-dispatch" && e.taskId === "T1")!;
    expect((first.data as { attempt: number }).attempt).toBe(0);
  });

  // Pins the third seed branch (nextChannel-null fallback) so its coverage is planned, not reactive.
  // GREEN on both sides — the assertion is "a post-resume dispatch EXISTS" (no deadlock/crash). The
  // documented ponytail ceiling: when every channel is already tried and no assignment is restorable,
  // the daemon proceeds on the static route() pick rather than deadlocking a resumed run.
  test("nextChannel-null fallback: no deadlock when every channel is already tried", async () => {
    const { repo, fake } = setupResumeRepo();
    await seedJournal(repo, "run-rr4", [
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 0 } },
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake2, attempt: 1 } },
      { event: "consult-verdict", taskId: "T1", data: { action: "reroute", notes: "all tried" } },
    ]);
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-rr4", resume: true });
    expect(s.done).toEqual(["T1"]);
    const post = postResume(Journal.open(repo, "run-rr4").read());
    expect(post.some((e) => e.event === "task-dispatch" && e.taskId === "T1")).toBe(true);
  });
}, 120000);

// OBS-103: after a stop→resume cycle the run-end sweep must retire the prior daemon instance's
// narrator too — the v1.63 run left it open and the operator closed it by hand. The pane world
// below mirrors the herdr contract at the two seams that matter: narrator() ADOPTS an already-open
// watch by its owned name (never learning which instance split the pane), and the driver sweep
// NEVER closes watch panes (panesToClose spares role "watch") — so zero survivors proves the
// daemon's own name-keyed close retired the narrator, not a fantasy sweep.
describe("OBS-103 run-end narrator sweep across daemon instances (fake adapter, zero tokens)", () => {
  test("a resumed run reaching run end leaves zero run-tagged panes open including a narrator opened by the prior daemon instance", async () => {
    const { repo, fake } = setupResumeRepo();
    const runId = "run-rr5";
    await seedJournal(repo, runId, [
      // Replay a completed task so this oracle exercises only resume reconciliation → run-end.
      // Dispatch/gates/merge are covered above and only add child-process pressure to the suite.
      { event: "task-done", taskId: "T1", data: { attempts: 1, assignment: fake1 } },
    ]);
    const watchName = formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId });
    const orphanWorker = formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId });
    // the prior (killed) daemon instance's leftovers: its narrator pane and its worker pane
    const live = new Set<string>([watchName, orphanWorker]);
    const inner = new SubprocessDriver();
    const byId = new Map<string, string>();
    const driver: ExecutorDriver = {
      id: "pane-world",
      interactive: false,
      async slot(cwd: string, name: string, o?: SlotOpts) {
        const s = await inner.slot(cwd, name);
        const paneName = o?.owned ? formatOwnedName(o.owned) : name;
        live.add(paneName);
        byId.set(s.id, paneName);
        return s;
      },
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      status: inner.status.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      async close(s: Slot) {
        live.delete(byId.get(s.id) ?? s.name);
        return inner.close(s); // no-op for the adopted pane — inner never created it
      },
      worktree: inner.worktree.bind(inner),
      // herdr contract: the resumed daemon finds the already-running watch by its owned name and
      // adopts it — the pane predates this process, so no inner slot backs it.
      async narrator(cwd: string, _command: string, rid?: string) {
        const name = formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId: rid! });
        live.add(name); // idempotent: already live when adopting the prior instance's pane
        const s = { id: `adopted-${name}`, name, cwd };
        byId.set(s.id, name);
        return s;
      },
      // herdr contract (panesToClose): the sweep closes owned-but-undesired panes but NEVER a
      // watch pane — only the daemon's name-keyed close can retire the narrator.
      async reconcile(desired: Set<string>) {
        for (const name of live) {
          const owned = parseOwnedName(name);
          if (owned && owned.role !== "watch" && !desired.has(name)) live.delete(name);
        }
      },
    };
    expect(live.has(watchName)).toBe(true); // seed: the narrator the prior instance opened
    const s = await runDaemon(repo, { adapters: [fake], runId, resume: true, driver });
    expect(s.done).toEqual(["T1"]); // the resumed run reached run-end green
    const replayDispatched = postResume(Journal.open(repo, runId).read()).some((e) => e.event === "task-dispatch");
    expect(replayDispatched).toBe(false); // boundary-only: no worker/gate/merge child-process burst
    const runTagged = [...live].filter((n) => parseOwnedName(n)?.runId === runId);
    expect(runTagged).toEqual([]); // zero survivors — the prior instance's narrator included
  });
}, 120000);

// v1.71 T4 (OBS-119 second gap): dead-channel exclusions survive resume via journal replay.
describe("OBS-119 dead-channel exclusion resume (v1.71 T4, zero tokens)", () => {
  test("a channel excluded mid-run after a dead-channel failure is recorded in the journal as a typed exclusion event", async () => {
    const { repo } = setupResumeRepo();
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n");
    const sdir = mkdtempSync(join(tmpdir(), "tickmarkr-de-"));
    const scriptPath = join(sdir, "s.json");
    writeFileSync(scriptPath, JSON.stringify({
      judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
      review: { approve: true, issues: [] },
      consult: { action: "retry", notes: "retry" },
      tasks: { T1: [
        { shell: AUTH_FAIL },
        { shell: `echo done > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1 done" } },
      ] },
    }));
    const fakeDead = new FakeAdapter(scriptPath);
    const runId = "run-de-excl";
    const s = await runDaemon(repo, { adapters: [fakeDead], runId });
    expect(s.done).toEqual(["T1"]);
    const excl = Journal.open(repo, runId).read().filter((e) => e.event === "channel-exclusion");
    expect(excl).toHaveLength(1);
    expect(excl[0]!.data).toMatchObject({ channel: "fake:fake-1", reason: "auth-required", kind: "dead-channel" });
  }, 30_000);

  test("resuming a run whose journal recorded a dead-channel exclusion re-seeds that exclusion before the daemon dispatches any task", async () => {
    const { repo, fake } = setupResumeRepo();
    await seedJournal(repo, "run-de-seed", [
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 0 } },
      { event: "channel-exclusion", taskId: "T1", data: { channel: "fake:fake-1", reason: "auth-required", kind: "dead-channel" } },
    ]);
    await runDaemon(repo, { adapters: [fake], runId: "run-de-seed", resume: true });
    const all = Journal.open(repo, "run-de-seed").read();
    const resumeIdx = all.findIndex((e) => e.event === "run-resume");
    const dispatchIdx = all.findIndex((e, i) => i > resumeIdx && e.event === "task-dispatch");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(dispatchIdx).toBeGreaterThan(resumeIdx);
    expect((all[resumeIdx]!.data as { excludedChannels: string[] }).excludedChannels).toEqual(["fake:fake-1"]);
  }, 30_000);

  test("a channel with no recorded exclusion event is not present in the replayed exclusion set", async () => {
    const { repo, fake } = setupResumeRepo();
    await seedJournal(repo, "run-de-absent", [
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 0 } },
    ]);
    expect([...Journal.open(repo, "run-de-absent").replayExcludedChannels()]).toEqual([]);
    await runDaemon(repo, { adapters: [fake], runId: "run-de-absent", resume: true });
    const runResume = Journal.open(repo, "run-de-absent").read().find((e) => e.event === "run-resume")!;
    expect(runResume.data).not.toHaveProperty("excludedChannels");
  }, 30_000);

  test("a task whose only prior attempt landed on the now-excluded channel picks a different channel on resume rather than re-dispatching onto it", async () => {
    const { repo, fake } = setupResumeRepo();
    await seedJournal(repo, "run-de-reroute", [
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 0 } },
      { event: "channel-exclusion", taskId: "T1", data: { channel: "fake:fake-1", reason: "auth-required", kind: "dead-channel" } },
    ]);
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-de-reroute", resume: true });
    expect(s.done).toEqual(["T1"]);
    const post = postResume(Journal.open(repo, "run-de-reroute").read())
      .filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(post.length).toBeGreaterThanOrEqual(1);
    expect(channelKey(dispatchAssignment(post[0]!))).toBe("fake:fake-2");
    for (const d of post) expect(channelKey(dispatchAssignment(d))).not.toBe("fake:fake-1");
  }, 30_000);

  test("the exclusion replay is seeded from the journal the same way attempt counts and tried channels already are on resume, not a second recovery mechanism", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1")] }));
    const j = Journal.create(repo, "run-de-fold");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "T1", { assignment: fake1, attempt: 0 });
    j.append("dead-channel-failover", "T1", { reason: "auth-required", from: "fake:fake-1", to: "fake:fake-2" });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    // pre-v1.71 compat: failover.from alone replays; channel-exclusion is additive, not a second store
    expect([...j.replayExcludedChannels()]).toEqual(["fake:fake-1"]);
    j.append("channel-exclusion", "T1", { channel: "fake:fake-1", reason: "auth-required", kind: "dead-channel" });
    expect([...j.replayExcludedChannels()]).toEqual(["fake:fake-1"]);
    const resumeState = j.replayResumeState().get("T1")!;
    expect(resumeState.attempts).toBe(1);
    expect(resumeState.tried).toEqual(["fake:fake-1"]);
  });
});
