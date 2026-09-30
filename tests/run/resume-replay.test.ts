import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { channelKey } from "../../src/adapters/types.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { canonicalizeLegacyName, formatOwnedName, parseOwnedName, type ExecutorDriver, type Slot, type SlotOpts } from "../../src/drivers/types.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import * as journalModule from "../../src/run/journal.js";
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
const setupResumeRepo = (judge: unknown = { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }) => {
  const repo = makeRepo({ "base.txt": "base\n" });
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1")] }));
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n");
  const sdir = mkdtempSync(join(tmpdir(), "tickmarkr-rr-"));
  const scriptPath = join(sdir, "s.json");
  writeFileSync(scriptPath, JSON.stringify({
    judge,
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

describe("OBS-1089 lifetime worker dispatch identity", () => {
  test("consecutive dispatches after a budget release advance the lifetime ordinal within the same engagement", async () => {
    const { repo, fake } = setupRepo([T("T1")], {
      tasks: { T1: [
        { shell: AUTH_FAIL },
        { shell: `echo done > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1 done" } },
      ] },
    });
    const runId = "run-ordinal-failover";
    await seedJournal(repo, runId, [
      ...Array.from({ length: 5 }, (_, attempt) => ({
        event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt },
      })),
      { event: "task-human", taskId: "T1", data: { kind: "attempt-cap" } },
    ]);
    const journal = Journal.open(repo, runId);
    journal.append("task-approved", "T1", { release: "attempt-cap", park: journal.newestBinding("T1") }); // OBS-1178: bound
    const result = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expect(result.done).toEqual(["T1"]);
    const rows = postResume(journal.read());
    expect(rows.some((e) => e.event === "dead-channel-failover")).toBe(true);
    expect(rows.filter((e) => e.event === "task-dispatch").map((e) => ({
      attempt: e.data.attempt, ordinal: e.data.workerDispatchOrdinal,
    }))).toEqual([
      { attempt: 0, ordinal: 5 },
      { attempt: 1, ordinal: 6 },
    ]);
    // Only the two new dispatches consume the released budget.
    expect(journal.replayResumeState().get("T1")!.attempts).toBe(2);
  });

  test("test: every task dispatch row the daemon writes carries a zero based worker dispatch ordinal counted from that task's prior task dispatch rows across this run's engagements which an attempt cap or upheld release never resets, so a row reading attempt zero with no ordinal after five dispatches fails", async () => {
    for (const release of ["attempt-cap", "review-upheld"]) {
      const { repo, fake } = setupResumeRepo();
      const runId = `run-ordinal-${release}`;
      const graph = loadGraph(repo);
      saveGraph(repo, validateGraph({ ...graph, tasks: [...graph.tasks, T("other", { status: "done" })] }));
      const hash = graphDefinitionHash(loadGraph(repo));
      await seedJournal(repo, runId, [
        { event: "task-dispatch", taskId: "other", data: { attempt: 0 } },
        { event: "task-done", taskId: "other" },
        ...["attempt-cap", "review-upheld", "recheck", "gate-satisfied", "scope-request"].flatMap((priorRelease) => [
          { event: "run-resume" },
          { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 0 } },
          { event: "task-approved", taskId: "T1", data: {
            release: priorRelease, gate: "review",
            ...(priorRelease === "scope-request" ? { amendment: {
              from: hash, to: hash, beforeFiles: [], files: [], parkLine: 1,
            } } : {}),
          } },
          ...(priorRelease === "recheck" ? [{ event: "recheck-battery", taskId: "T1" }] : []),
        ]),
        { event: "task-human", taskId: "T1", data: { kind: release === "attempt-cap" ? "attempt-cap" : "gate-fail" } },
      ]);
      const seeded = Journal.open(repo, runId);
      seeded.append("task-approved", "T1", { release, park: seeded.newestBinding("T1") }); // OBS-1178: bound
      const before = seeded.read().length;
      const result = await runDaemon(repo, { adapters: [fake], runId, resume: true });
      expect(result.done).toContain("T1");
      const journal = Journal.open(repo, runId);
      const rows = journal.read().slice(before).filter((e) => e.event === "task-dispatch");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data).toMatchObject({ attempt: 0, workerDispatchOrdinal: 5 });
      expect(journal.replayResumeState().get("T1")!.attempts).toBe(1);
    }
  });

  test("test: a repair dispatch row carries the same ordinal as its worker attempt and a resume restore names the restored dispatch's ordinal while legacy rows without one stay valid, so an annotation that increments the ordinal fails", async () => {
    for (const legacy of [false, true]) {
      const { repo, fake } = setupResumeRepo();
      const runId = `run-ordinal-repair-${legacy}`;
      await seedJournal(repo, runId, [
        { event: "task-dispatch", taskId: "T1", data: {
          assignment: fake1, attempt: 0, ...(legacy ? {} : { workerDispatchOrdinal: 0 }),
        } },
        { event: "repair-dispatch", taskId: "T1", data: legacy ? {} : { workerDispatchOrdinal: 0 } },
        { event: "resume-restore", taskId: "T1", data: legacy ? {} : { workerDispatchOrdinal: 0 } },
        { event: "repair-attempt", taskId: "T1", data: { findings: "Fix the outstanding finding" } },
      ]);
      const before = Journal.open(repo, runId).read().length;
      const result = await runDaemon(repo, { adapters: [fake], runId, resume: true });
      expect(result.done).toEqual(["T1"]);
      const journal = Journal.open(repo, runId);
      const rows = journal.read().slice(before);
      const dispatch = rows.find((e) => e.event === "task-dispatch")!;
      expect(dispatch.data).toMatchObject({ attempt: 1, workerDispatchOrdinal: 1 });
      const repairs = rows.filter((e) => e.event === "repair-dispatch");
      expect(repairs).toHaveLength(1);
      expect(repairs[0]!.data.workerDispatchOrdinal).toBe(dispatch.data.workerDispatchOrdinal);
      const restores = rows.filter((e) => e.event === "resume-restore");
      expect(restores).toHaveLength(1);
      expect(restores[0]!.data.workerDispatchOrdinal).toBe(legacy ? null : 0);
      expect(journal.replayResumeState().get("T1")!.attempts).toBe(2);
    }
  });

  test("test: the budget attempt field beside the ordinal keeps its reset on an attempt cap release and its count across a recheck exactly as before, so an ordinal that replaces the budget count fails", async () => {
    const { repo, fake } = setupResumeRepo();
    const runId = "run-ordinal-budget";
    await seedJournal(repo, runId, [
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 0, workerDispatchOrdinal: 0 } },
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 1, workerDispatchOrdinal: 1 } },
      { event: "task-human", taskId: "T1", data: { kind: "attempt-cap", reason: "attempt cap" } },
    ]);
    const journal = Journal.open(repo, runId);
    journal.append("task-approved", "T1", { release: "attempt-cap", park: journal.newestBinding("T1") }); // OBS-1178: bound to its park
    expect(journal.replayResumeState().get("T1")!.attempts).toBe(0);
    journal.append("task-dispatch", "T1", { assignment: fake1, attempt: 0, workerDispatchOrdinal: 2 });
    journal.append("task-approved", "T1", { release: "recheck" });
    expect(journal.replayResumeState().get("T1")!.attempts).toBe(1);
    // The recheck battery has already been enacted before interruption; the resumed worker
    // still inherits its budget count, independently of the lifetime dispatch identity.
    journal.append("recheck-battery", "T1", {});
    const before = journal.read().length;
    const result = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expect(result.done).toEqual(["T1"]);
    const dispatches = journal.read().slice(before).filter((e) => e.event === "task-dispatch");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.data).toMatchObject({ attempt: 1, workerDispatchOrdinal: 3 });
    expect(journal.replayResumeState().get("T1")!.attempts).toBe(2);
  });
}, 120000);

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
    expect(first.data.workerDispatchOrdinal).toBe(0);
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
// below mirrors the herdr contract at the two seams that matter: narrator() leaves the run's board
// live under its canonical owned name whatever it did to get there (HerdrDriver retires the
// survivor it finds and re-splits, so the live command is run-bound; the name is the same either
// way), and the driver sweep NEVER closes watch panes (panesToClose spares role "watch") — so zero
// survivors proves the daemon's own name-keyed close retired the narrator, not a fantasy sweep.
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
      // herdr contract: whatever the driver did with the pane it found, the run ends with one board
      // under this owned name — the pane predates this process, so no inner slot backs it.
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
    const dispatches = Journal.open(repo, runId).read().filter((e) => e.event === "task-dispatch");
    expect(dispatches.map((e) => e.data.workerDispatchOrdinal)).toEqual([0, 1]);
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

// W (D-718): resume restores lastAssignment under the router's one exclusion meaning. fake-alias ranks
// ahead of fake-2 in failover order and shares fake-1's probed identity, so only that identity can move a
// restore of fake-alias onto fake-2; with an unrelated exclusion the restore still wins over route()'s
// static pick (fake-1, the flat-rate seat).
describe("W (D-718) identity-aware resume restore (fake adapter, zero tokens)", () => {
  const aliasRestore = async (runId: string, last: "fake-1" | "fake-alias", excluded: string) => {
    const { repo, fake } = setupResumeRepo();
    fake.channels = () => [
      { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
      { adapter: "fake", vendor: "fake-a", model: "fake-alias", channel: "api", tier: "frontier" },
      { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
    ];
    const identities: Record<string, string> = { "fake-1": "fake-served-1", "fake-alias": "fake-served-1", "fake-2": "fake-served-2" };
    fake.probe = async () => ({
      installed: true, authed: true, version: "fake", models: Object.keys(identities),
      modelAuth: Object.fromEntries(Object.entries(identities).map(([model, identity]) =>
        [model, { authed: true, probedAt: "2026-09-29T00:00:00.000Z", identity }])),
    });
    await seedJournal(repo, runId, [
      { event: "task-dispatch", taskId: "T1", data: { assignment: { ...(last === "fake-1" ? fake1 : fake2), model: last }, attempt: 0 } },
      { event: "channel-exclusion", taskId: "T1", data: { channel: excluded, reason: "auth-required", kind: "dead-channel" } },
    ]);
    const s = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expect(s.done).toEqual(["T1"]);
    const post = postResume(Journal.open(repo, runId).read());
    const restored = post.find((e) => e.event === "resume-restore" && e.taskId === "T1")!;
    return {
      restored: channelKey(dispatchAssignment(restored)),
      dispatched: post.filter((e) => e.event === "task-dispatch" && e.taskId === "T1").map((e) => channelKey(dispatchAssignment(e))),
    };
  };

  test("resumed runDaemon dispatches fake-2 when lastAssignment is either excluded fake-1 or its probed fake-alias identity while a nonexcluded restored assignment remains eligible", async () => {
    const direct = await aliasRestore("run-w-restore-direct", "fake-1", "fake:fake-1");
    expect(direct).toEqual({ restored: "fake:fake-2", dispatched: ["fake:fake-2"] });

    const alias = await aliasRestore("run-w-restore-alias", "fake-alias", "fake:fake-1");
    expect(alias).toEqual({ restored: "fake:fake-2", dispatched: ["fake:fake-2"] });

    const eligible = await aliasRestore("run-w-restore-eligible", "fake-alias", "fake:fake-2");
    expect(eligible).toEqual({ restored: "fake:fake-alias", dispatched: ["fake:fake-alias"] });
  }, 240_000);
});

test("test: every task-dispatch row after a ladder move names the dispatched channel in its provenance with the abandoned pin marked not re-tried and the channels the ladder skipped listed on the row, and a resume whose loaded graph pins a channel the recorded graph did not dispatches that pin journaling restore-rerouted, so a row claiming a pin it did not run on fails", async () => {
  for (const change of ["ladder", "pin", "floor"] as const) {
    const { repo, fake } = setupResumeRepo();
    const original = loadGraph(repo);
    original.tasks[0]!.routingHints = change === "ladder" ? { pin: { via: "fake", model: "fake-1" } } : { floor: "mid" };
    saveGraph(repo, original);
    const runId = `run-es2-restore-${change}`;
    await seedJournal(repo, runId, [
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 0 } },
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake2, attempt: 1 } },
    ]);
    const journal = Journal.open(repo, runId);
    writeFileSync(join(journal.dir, "graph.json"), JSON.stringify(original));
    if (change !== "ladder") {
      const loaded = loadGraph(repo);
      loaded.tasks[0]!.routingHints = change === "pin" ? { pin: { via: "fake", model: "fake-1" } } : { floor: "frontier" };
      saveGraph(repo, loaded);
    }
    await runDaemon(repo, { adapters: [fake], runId, resume: true, graphChanged: change !== "ladder" });
    const rows = postResume(journal.read());
    const dispatches = rows.filter((e) => e.event === "task-dispatch");
    expect(dispatches).toHaveLength(1);
    for (const row of dispatches) {
      const key = channelKey(dispatchAssignment(row));
      expect(row.data.provenance).toContain(`dispatch ${key}`);
      if (change === "ladder") {
        expect(key).toBe("fake:fake-2");
        expect(row.data.provenance).toContain("pin fake:fake-1 not re-tried");
        expect(row.data.provenance).not.toContain("pin bypasses mode");
        expect(row.data.excludedChannels).toContain("fake:fake-1");
        expect(row.data.exclusionReasons).toMatchObject({ "fake:fake-1": "already tried" });
      } else {
        expect(key).toBe("fake:fake-1");
        expect(rows.find((e) => e.event === "restore-rerouted")?.data).toEqual({ from: "fake:fake-2", to: "fake:fake-1", reason: `${change} changed` });
      }
    }
  }
}, 60_000);

test("a tier climb committed before interruption reaches the next restored dispatch with its provenance", async () => {
  const { repo, fake } = setupResumeRepo();
  const originalChannels = fake.channels.bind(fake);
  fake.channels = (cfg) => originalChannels(cfg).map((c) => c.model === "fake-1" ? { ...c, tier: "mid" } : c);
  const runId = "run-es2-pending-climb";
  await seedJournal(repo, runId, [
    { event: "task-dispatch", taskId: "T1", data: { assignment: { ...fake1, tier: "mid" }, attempt: 0, routingHints: {} } },
    { event: "tier-escalated", taskId: "T1", data: { attempt: 1, cause: "repair-exhausted", gate: "test", fingerprint: "expected true", from: "fake:fake-1", to: "fake:fake-2", fromTier: "mid", toTier: "frontier", poolBefore: ["fake:fake-2"], costDelta: 3 } },
  ]);
  await runDaemon(repo, { adapters: [fake], runId, resume: true });
  const rows = Journal.open(repo, runId).read();
  const dispatch = postResume(rows).find((e) => e.event === "task-dispatch")!;
  expect(dispatch.data.assignment).toEqual(fake2);
  expect(dispatch.data.attempt).toBe(1);
  expect(dispatch.data.provenance).toContain("tier-escalated fake:fake-1 → fake:fake-2 (repair-exhausted)");
  expect(dispatch.data.excludedChannels).toEqual(["fake:fake-1"]);
  expect(rows.filter((e) => e.event === "tier-escalated")).toHaveLength(1);
});

// OBS-1109: an attempt a dead daemon left between worker-launch and worker-result. It is written as a
// live daemon writes it (the launch carries the attempt's nonce, dispatch script and slot); the pane
// text and the task branch decide whether it finished. The fake script would commit t1.txt if the
// task were dispatched again.
describe("OBS-1109 resume harvest across repeated resumes (fake adapter, zero tokens)", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const nonce = "0badc0de";
  // A terminal host that outlives daemon instances. Every driver instance starts EMPTY, as production
  // drivers do after a restart: the journaled slot is unknown to it until the daemon restores the
  // owned pane by name through its read-only adopt, and its reconcile closes every owned pane the
  // journal fold no longer desires. A name the host does not hold cannot be adopted; a pane holding
  // an Error is one the driver cannot read.
  class PaneHost { panes = new Map<string, string | Error>(); closed: string[] = []; }
  const hostDriver = (host: PaneHost): ExecutorDriver => {
    const inner = new SubprocessDriver();
    const adopted = new Map<string, string>(); // slot id → pane name
    let n = 0;
    return {
      id: "pane-host", interactive: false,
      slot: inner.slot.bind(inner),
      // a read-only binding to the pane the host still holds under the owned name — never an allocation
      adopt: async (s: Slot) => {
        if (!host.panes.has(s.name)) throw new Error(`no pane ${s.name} to adopt`);
        const id = `host-${++n}`;
        adopted.set(id, s.name);
        return { id, name: s.name, cwd: s.cwd };
      },
      run: inner.run.bind(inner), waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner), status: inner.status.bind(inner),
      read: async (s: Slot, lines: number) => {
        const name = adopted.get(s.id);
        if (!name) return inner.read(s, lines);
        const p = host.panes.get(name);
        if (p === undefined) throw new Error(`pane ${name} is closed`);
        if (p instanceof Error) throw p;
        return p;
      },
      notify: inner.notify.bind(inner),
      close: async (s: Slot) => { if (adopted.has(s.id)) host.panes.delete(adopted.get(s.id)!); else await inner.close(s); },
      worktree: inner.worktree.bind(inner),
      reconcile: async (desired, runId) => {
        for (const name of Array.from(host.panes.keys())) {
          if (desired.has(formatOwnedName(canonicalizeLegacyName(name, runId)))) continue;
          host.panes.delete(name);
          host.closed.push(name);
        }
      },
    } as ExecutorDriver;
  };
  const seedInterrupted = async (runId: string, pane: string | Error | undefined, committed: boolean, benchAuthor = false, judge?: unknown) => {
    const { repo, fake } = setupResumeRepo(judge);
    const base = await gitHead(repo);
    const wt = await new SubprocessDriver().worktree(repo, `tickmarkr/${runId}--T1`, base);
    if (committed) {
      writeFileSync(join(wt, "harvest.txt"), "finished\n");
      git(wt, "add", "-A");
      git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--no-gpg-sign", "-qm", "finished work");
    }
    const slot = { id: `pane-${runId}`, name: formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId }), cwd: wt };
    await seedJournal(repo, runId, [
      { event: "task-dispatch", taskId: "T1", data: { assignment: fake2, attempt: 0, workerDispatchOrdinal: 0 } },
      { event: "worker-launch", taskId: "T1", data: { attempt: 0, nonce, dispatchScript: join(repo, ".tickmarkr", "T1-a0.sh"), slot } },
      // a sibling's failover benched the producing seat: the resumed route no longer lands on the author
      ...(benchAuthor ? [{ event: "channel-exclusion", data: { channel: "fake:fake-2", reason: "auth-required", kind: "dead-channel" } }] : []),
    ]);
    const host = new PaneHost();
    if (pane !== undefined) host.panes.set(slot.name, pane);
    let interruptAt: string | undefined;
    // a FRESH driver per daemon instance, as production restarts get: nothing of the last one survives
    const driver = (): ExecutorDriver => ({
      ...hostDriver(host),
      // the daemon is killed at the named projection: the process stops here
      project: async (_id: string, state: string) => {
        if (state !== interruptAt) return;
        process.emit("SIGTERM", "SIGTERM");
        await new Promise(() => {});
      },
    });
    return { repo, fake, driver, host, interruptAt: (state: string) => { interruptAt = state; }, resumeNormally: () => { interruptAt = undefined; } };
  };
  const rowsAfterLastResume = (rows: JournalEvent[]) => rows.slice(rows.map((e) => e.event).lastIndexOf("run-resume") + 1);
  const finishedPane = `TICKMARKR_RESULT_${nonce} {"ok":true,"summary":"t1 finished","deviations":[]}\n`;
  const killed = async (repo: string, fake: FakeAdapter, runId: string, driver: () => ExecutorDriver) => {
    let exited!: (code: number) => void;
    const exitCode = new Promise<number>((resolve) => { exited = resolve; });
    await expect(runDaemon(repo, { adapters: [fake], runId, resume: true, driver: driver(), exit: exited })).rejects.toThrow("terminated by SIGTERM");
    expect(await exitCode).toBe(143);
  };
  // the second resume gates the one recorded harvest under its producer: nothing is redone or recorded twice
  const gatesHarvestUnderProducer = async (repo: string, fake: FakeAdapter, runId: string, driver: () => ExecutorDriver) => {
    const s = await runDaemon(repo, { adapters: [fake], runId, resume: true, driver: driver() });
    expect(s.done).toEqual(["T1"]);
    const all = Journal.open(repo, runId).read();
    expect(all.filter((e) => e.event === "worker-result-harvested")).toHaveLength(1);
    expect(all.filter((e) => e.event === "worker-result")).toHaveLength(1);
    const second = rowsAfterLastResume(all);
    expect(second.filter((e) => ["task-dispatch", "worker-launch", "worker-result"].includes(e.event))).toEqual([]);
    expect(second.some((e) => e.event === "gate-result")).toBe(true);
    const done = second.find((e) => e.event === "task-done")!;
    expect(done.data.assignment).toEqual(fake2);
    expect(done.data.authors).toEqual(["fake:fake-2"]);
    expect(git(repo, "show", `tickmarkr/${runId}:harvest.txt`)).toBe("finished");
    expect(() => git(repo, "show", `tickmarkr/${runId}:t1.txt`)).toThrow();
    return all;
  };

  test("test: repeated production resumes preserve one harvest and its original author versus recovering an unfinished or foreign-nonce attempt, so double harvesting or trusting the foreign trailer fails", async () => {
    // (a) finished: the first resume harvests and dies before gating; the second gates that same harvest
    {
      const runId = "run-harvest-repeated";
      const { repo, fake, driver, interruptAt, resumeNormally } = await seedInterrupted(runId, finishedPane, true, true);
      interruptAt("in-review"); // after recording the harvest, before its first gate
      await killed(repo, fake, runId, driver);
      const first = rowsAfterLastResume(Journal.open(repo, runId).read());
      expect(first.filter((e) => e.event === "worker-result-harvested")).toHaveLength(1);
      expect(first.filter((e) => ["task-dispatch", "gate-result", "task-done"].includes(e.event))).toEqual([]);
      resumeNormally();
      await gatesHarvestUnderProducer(repo, fake, runId, driver);
    }
    // (a2) killed BETWEEN the harvest's worker-result and its harvest row: the next resume finishes that
    // one record from the result it wrote, and never falls back to redispatching the finished attempt
    {
      const runId = "run-harvest-torn";
      const { repo, fake, driver } = await seedInterrupted(runId, finishedPane, true, true);
      // the process dies AT the harvest row: that write and every later one never reach the journal
      const write = Journal.prototype.append as (...args: unknown[]) => void;
      let dead = false;
      const crash = vi.spyOn(Journal.prototype, "append").mockImplementation(function (this: Journal, ...args: unknown[]) {
        if (dead) return;
        if (args[0] === "worker-result-harvested") {
          dead = true;
          throw new Error("killed between the harvest's rows");
        }
        write.apply(this, args);
      } as typeof Journal.prototype.append);
      try {
        await runDaemon(repo, { adapters: [fake], runId, resume: true, driver: driver() });
      } finally {
        crash.mockRestore();
      }
      expect(dead).toBe(true);
      const first = rowsAfterLastResume(Journal.open(repo, runId).read());
      expect(first.filter((e) => e.event === "worker-result")).toHaveLength(1);
      expect(first.filter((e) => e.event === "worker-result-harvested")).toEqual([]);
      const all = await gatesHarvestUnderProducer(repo, fake, runId, driver);
      expect(all.find((e) => e.event === "worker-result-harvested")!.data).toMatchObject({
        attempt: 0, source: "resume", trailer: true, summary: "t1 finished",
      });
    }
    // (a3) killed AFTER the harvest's gates recorded a result (a red judge, so the resume moved on to a
    // new dispatch and died before it), with the producing seat benched and rerouted off: the next resume replays those
    // recorded gates and still gates — and credits — the harvest under its producer, not the new route
    {
      const runId = "run-harvest-gated";
      const { repo, fake, driver, interruptAt, resumeNormally } = await seedInterrupted(runId, finishedPane, true, true, [
        { pass: false, criteria: [{ criterion: "c1", met: false, reason: "not yet" }] },
        { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
      ]);
      interruptAt("in-progress"); // after the gate results, before any new dispatch
      await killed(repo, fake, runId, driver);
      const first = rowsAfterLastResume(Journal.open(repo, runId).read());
      expect(first.filter((e) => e.event === "worker-result-harvested")).toHaveLength(1);
      expect(first.some((e) => e.event === "gate-result" && e.data.gate === "acceptance" && e.data.pass === false)).toBe(true);
      expect(first.filter((e) => ["task-dispatch", "task-done"].includes(e.event))).toEqual([]);
      // ...and its consult had rerouted off the producing seat: the replayed seat memory is cleared, so
      // only the harvest's own record can still name its author
      Journal.open(repo, runId).append("consult-verdict", "T1", { action: "reroute", notes: "reroute", adapter: "fake", model: "fake-1", vendor: "fake-a" });
      resumeNormally();
      await gatesHarvestUnderProducer(repo, fake, runId, driver);
    }
    // (a4) a LIVE daemon recorded the worker's own result and died before gating it (no harvest row,
    // no gate result): the next resume finishes that record and gates it — it never redispatches
    {
      const runId = "run-harvest-live-result";
      const { repo, fake, driver } = await seedInterrupted(runId, undefined, true, true);
      Journal.open(repo, runId).append("worker-result", "T1", { ok: true, summary: "t1 finished", deviations: [], finished: true, exitCode: 0, mode: "print" });
      const all = await gatesHarvestUnderProducer(repo, fake, runId, driver);
      expect(all.find((e) => e.event === "worker-result-harvested")!.data).toMatchObject({ attempt: 0, source: "resume", trailer: true, summary: "t1 finished" });
    }
    // (b) unfinished — no trailer, nothing committed — (c) a pane holding ANOTHER attempt's trailer over
    // committed work, and (d) a pane the fresh driver cannot read at all, committed or not: an unread pane
    // proves neither a matching trailer nor the absence of a foreign one. None is harvested or gated as
    // trailerless; each is declined, its spared pane swept, and the ordinary recovery dispatch takes over
    for (const [label, pane, committed, reason] of [
      ["unfinished", "still working…\n", false, "unfinished"],
      ["foreign", `TICKMARKR_RESULT_deadbeef {"ok":true,"summary":"another attempt's claim","deviations":[]}\n`, true, "foreign-nonce"],
      ["unreadable", new Error("terminal handle lost"), true, "pane unreadable: terminal handle lost"],
      ["unreadable-unfinished", new Error("terminal handle lost"), false, "pane unreadable: terminal handle lost"],
    ] as const) {
      const runId = `run-harvest-${label}`;
      const { repo, fake, driver, host } = await seedInterrupted(runId, pane, committed);
      const s = await runDaemon(repo, { adapters: [fake], runId, resume: true, driver: driver() });
      expect(s.done).toEqual(["T1"]);
      const post = rowsAfterLastResume(Journal.open(repo, runId).read());
      expect(post.filter((e) => e.event === "worker-result-harvested")).toEqual([]);
      expect(post.filter((e) => e.event === "worker-result" && e.data.source === "resume")).toEqual([]);
      expect(post.find((e) => e.event === "resume-harvest-declined")!.data).toEqual({ attempt: 0, reason });
      expect(host.closed).toEqual([formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId })]);
      const dispatches = post.filter((e) => e.event === "task-dispatch");
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]!.data.attempt).toBe(1);
      expect(git(repo, "show", `tickmarkr/${runId}:t1.txt`)).toBe("done");
    }
  }, 120_000);

  // OBS-1204: the resume spare is frozen ONCE from the rows before this daemon's run-resume. A task
  // launched after it (T2) is this daemon's own work: it is never scanned as interrupted, and its pane
  // retires at its terminal sweep exactly as in a fresh run. Every sweep is recorded with the journal
  // it was computed from; the host opens a pane under each owned worker name the daemon allocates.
  test("a resumed production daemon spares only attempts launched before its own run-resume row and retires post-resume terminal panes as a fresh daemon does, so scanning and sparing every new launch as interrupted fails", async () => {
    const sweepsOf = async (mode: "resumed" | "fresh") => {
      const runId = `run-freeze-${mode}`;
      const { repo, fake } = setupRepo([T("T1"), T("T2", { deps: ["T1"] })], { tasks: {
        T1: [{ shell: `echo done > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1 done" } }],
        T2: [{ shell: `echo done > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2 done" } }],
      } });
      const base = await gitHead(repo);
      const host = new PaneHost();
      const t1 = formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId });
      if (mode === "resumed") {
        const wt = await new SubprocessDriver().worktree(repo, `tickmarkr/${runId}--T1`, base);
        writeFileSync(join(wt, "harvest.txt"), "finished\n");
        git(wt, "add", "-A");
        git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--no-gpg-sign", "-qm", "finished work");
        await seedJournal(repo, runId, [
          { event: "task-dispatch", taskId: "T1", data: { assignment: fake2, attempt: 0, workerDispatchOrdinal: 0 } },
          { event: "worker-launch", taskId: "T1", data: { attempt: 0, nonce, dispatchScript: join(repo, ".tickmarkr", "T1-a0.sh"), slot: { id: "pane-t1", name: t1, cwd: wt } } },
        ]);
        host.panes.set(t1, finishedPane);
      }
      const sweeps: Array<{ desired: Set<string>; rows: JournalEvent[] }> = [];
      const inner = hostDriver(host);
      const driver: ExecutorDriver = {
        ...inner,
        slot: async (cwd: string, name: string, o?: SlotOpts) => {
          const allocated = await inner.slot(cwd, name, o);
          const owned = o?.owned ? formatOwnedName(o.owned) : name;
          if (parseOwnedName(owned)?.role === "worker") host.panes.set(owned, "working…\n");
          return allocated;
        },
        reconcile: async (desired, id, opts) => {
          sweeps.push({ desired: new Set(desired), rows: Journal.open(repo, runId).read() });
          await inner.reconcile!(desired, id, opts);
        },
      };
      const scans = vi.spyOn(journalModule, "interruptedAttempt");
      let t2Scans: JournalEvent[][];
      try {
        const s = await runDaemon(repo, { adapters: [fake], runId, resume: mode === "resumed", driver });
        expect(s.done.sort()).toEqual(["T1", "T2"]);
      } finally {
        t2Scans = scans.mock.calls.filter(([, id]) => id === "T2").map(([rows]) => rows);
        scans.mockRestore();
      }
      const t2 = formatOwnedName({ role: "worker", taskId: "T2", attempt: 0, runId });
      const has = (rows: JournalEvent[], event: string, taskId: string) => rows.some((e) => e.event === event && e.taskId === taskId);
      // T2's terminal sweep: the first one whose journal carries T2's task-done
      const t2Done = sweeps.find((w) => has(w.rows, "task-done", "T2"))!;
      return { host, t1, t2, sweeps, t2Done, has, t2Scans };
    };

    const resumed = await sweepsOf("resumed");
    // the pre-resume attempt is spared at the startup sweep, harvested, and never redone
    expect(resumed.sweeps[0]!.desired.has(resumed.t1)).toBe(true);
    // ...and its spare lapses once the harvest is journaled: no later sweep keeps it
    const afterHarvest = resumed.sweeps.filter((w) => w.rows.some((e) => e.event === "worker-result-harvested"));
    expect(afterHarvest.length).toBeGreaterThan(0);
    expect(afterHarvest.every((w) => !w.desired.has(resumed.t1))).toBe(true);
    // the post-resume launch is never scanned as interrupted: T2 is folded ONCE, at the freeze, before it launched
    expect(resumed.t2Scans).toHaveLength(1);
    expect(resumed.t2Scans.every((rows) => !resumed.has(rows, "worker-launch", "T2"))).toBe(true);
    // no sweep after T2's launch desires its pane through a spare once the fold retires it
    expect(resumed.t2Done.desired.has(resumed.t2)).toBe(false);
    expect(resumed.host.closed).toContain(resumed.t2);

    const fresh = await sweepsOf("fresh");
    // parity with a fresh daemon: T2's pane retires at the same terminal sweep, and a fresh run scans nothing
    expect(fresh.t2Done.desired.has(fresh.t2)).toBe(false);
    expect(fresh.host.closed).toContain(fresh.t2);
    expect(fresh.t2Scans).toEqual([]);
  }, 120_000);
});
