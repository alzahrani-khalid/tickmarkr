import { spawn, spawnSync } from "node:child_process";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { approvalEnactment, approvalRunOwner, type ApprovalDisposition, type ApprovalStatus, approve } from "../../src/cli/commands/approve.js";
import { COMMANDS, dispatch } from "../../src/cli/index.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { formatSummary, outstandingApprovals, runDaemon } from "../../src/run/daemon.js";
import { GATE_SATISFIED_RELEASE, type JournalEvent, Journal } from "../../src/run/journal.js";
import { runLockOwner } from "../../src/run/lock.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// T14, amended by v2.2 T3: the live daemon sweeps accepted approvals at every task boundary, so an
// approval that lands while the task loop is still turning is enacted by that run. The approval that
// lands after the last boundary, during tip verify, is the one that stays outstanding because no
// further sweep remains before run-end. These tests pin both the disposition at approval time,
// derived from the run lock's recorded owner, and the completion record that names any accepted
// approval left outstanding.
//
// Every test here is TOP-LEVEL with a verbatim title: the acceptance oracle filters with a leaf-anchored
// `-t '(^| )…$'` over vitest's full name (OBS-511 widened it through describe prefixes), so the test's
// OWN title must still equal the criterion — a shortened or decorated leaf stays unmatchable.

const lockPath = (repo: string) => join(tickmarkrDir(repo), "graph.lock");

/** A lock as a daemon leaves it. `agoMs` ages the heartbeat, which is NOT what liveness is read from. */
const plantLock = (repo: string, payload: Record<string, unknown>, { agoMs = 0 } = {}): void => {
  const p = lockPath(repo);
  writeFileSync(p, JSON.stringify(payload));
  if (agoMs > 0) {
    const t = new Date(Date.now() - agoMs);
    utimesSync(p, t, t);
  }
};

/** A reaped child: a real pid that is PROVABLY dead (kill(pid,0) → ESRCH), never a made-up number. */
const deadPid = (): number => spawnSync("true").pid!;

interface PrintedApprovalStatus {
  status: ApprovalStatus;
  disposition: ApprovalDisposition;
  /** Absent on a live owner: the boundary sweep is the enactment, and a resume would contend for its lock. */
  resume?: string;
  ownerPid?: number;
  ownerRunId?: string;
}

// Parse only the registered command's printed protocol line. A typed helper return or a prose token
// cannot satisfy this oracle: JSON.parse consumes the bytes dispatch hands to stdout.
const printedStatus = (result: string): PrintedApprovalStatus => {
  const line = result.split("\n").find((row) => row.startsWith("TICKMARKR_APPROVAL "));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice("TICKMARKR_APPROVAL ".length)) as PrintedApprovalStatus;
};

/** The parked run every approval below is written against — journal only, no worker, no tokens. */
const parkedRun = (runId: string): string => {
  const { repo } = setupRepo([T("T1", { humanGate: true }), T("T2", { humanGate: true })], { tasks: {} });
  const j = Journal.create(repo, runId);
  for (const id of ["T1", "T2"]) j.append("task-human", id, { kind: "human-gate", reason: "approval required" });
  return repo;
};

/**
 * One parked task per disposition token, so the live-vs-finished contract is checked over EVERY
 * message the command can print rather than the one plain-approve message a single park exercises.
 * `enacts` is the clause each message ends on — the half that used to be welded to a resume command.
 */
const DISPOSITION_PARKS: Array<{ taskId: string; flags: string[]; token: ApprovalDisposition; enacts: string }> = [
  { taskId: "plain", flags: [], token: "dispatch", enacts: "dispatch it" },
  { taskId: "cap", flags: [], token: "fresh-budget", enacts: "dispatch it on a fresh attempt budget" },
  { taskId: "waive", flags: ["--waive"], token: "waive-gate", enacts: "continue past the approved gate" },
  { taskId: "recheck", flags: ["--recheck"], token: "re-dispatch", enacts: "re-dispatch against the full gate suite only if re-running the whole declared battery on the parked commit before any worker is red" },
  { taskId: "uphold", flags: ["--uphold"], token: "fund-fixed-attempt", enacts: "dispatch a fixed attempt carrying the findings" },
];

/** A journal parked five ways — one park per row above, each with the gate result its flag requires. */
const fiveDispositionRun = (runId: string): string => {
  const { repo } = setupRepo(DISPOSITION_PARKS.map((p) => T(p.taskId)), { tasks: {} });
  const j = Journal.create(repo, runId);
  j.append("task-human", "plain", { kind: "human-gate", reason: "approval required" });
  j.append("task-human", "cap", { kind: "attempt-cap", reason: "attempt cap (10) reached" });
  for (const taskId of ["waive", "recheck"]) {
    j.append("gate-result", taskId, { gate: "acceptance", pass: false, details: "judge failed" });
    j.append("task-human", taskId, { kind: "gate-fail", reason: "gate failed" });
  }
  j.append("gate-result", "uphold", { gate: "review", pass: false, details: "changes requested" });
  j.append("task-human", "uphold", { kind: "gate-fail", reason: "review failed" });
  return repo;
};

const approvalBytes = (repo: string, runId: string): string[] =>
  Journal.open(repo, runId).read().filter((e) => e.event === "task-approved").map((e) => JSON.stringify(e.data));

const runEnd = (repo: string, runId: string): JournalEvent =>
  Journal.open(repo, runId).read().filter((e) => e.event === "run-end").at(-1)!;

const dispatchesOf = (events: JournalEvent[], taskId: string): number =>
  events.filter((e) => e.event === "task-dispatch" && e.taskId === taskId).length;

// The PRODUCTION path, end to end: the real dispatcher, over the real `approve` export — the same
// function object src/cli/index.ts registers (asserted below), reached the way the binary reaches it.
// The command map only re-binds cwd, which argv cannot carry into a temp repo.
const viaCli = (repo: string, argv: string[]) =>
  dispatch("approve", argv, { approve: (a: string[]) => approve(a, repo) });

// Two humanGate tasks with real (fake-adapter) work behind them: an approved gate dispatches, an
// unapproved one parks. The shells commit, so the evidence/scope gates see landed work.
const twoGateRepo = (extraCfg = "") => setupRepo(
  [T("A", { humanGate: true }), T("B", { humanGate: true })],
  {
    tasks: {
      A: [{ shell: `echo a > a.txt && ${COMMIT} a`, result: { ok: true, summary: "a" } }],
      B: [{ shell: `echo b > b.txt && ${COMMIT} b`, result: { ok: true, summary: "b" } }],
    },
  },
  extraCfg,
);

// A gate command is what makes the run reach tip verify, and tip verify is the ONE window this run
// still owns after its last task boundary: an approval accepted there can never be swept, which is
// the only way to produce a real `outstanding` record now that live approvals are enacted.
const TIP_VERIFY_GATE = `gates: { test: "true" }\n`;

test("test: approve against a run whose repository lock is held by a live daemon owning a different run prints a third enactment sentence naming that other run as the reason the release waits for resume after it ends so its status record carries no deferred-live token or resume command whereas the shipped two-state owner that prints run tickmarkr resume there fails", async () => {
  const runId = "run-awaiting-owner";
  const ownerRunId = "run-live-owner";
  const repo = parkedRun(runId);
  plantLock(repo, { pid: process.pid, runId: ownerRunId, startedAt: Date.now() });

  const out = await approve([runId, "T1", "--by", "operator"], repo);

  expect(out).toContain(`release recorded; live run \`${ownerRunId}\` holds the repository lock`);
  expect(out).toContain(`resume \`${runId}\` after it ends to dispatch it`);
  expect(out).not.toContain(`tickmarkr resume ${runId}`);
  expect(printedStatus(out)).toEqual({
    status: "recorded-no-owner",
    disposition: "dispatch",
    ownerPid: process.pid,
    ownerRunId,
  });
  expect(approvalBytes(repo, runId)).toHaveLength(1);
});

test("test: approvalEnactment renders three distinct sentences from one owner object for a live owner of this run or a live owner of another run or no owner so every surface calling it agrees whereas an enactment that collapses the other-run case into no owner fails", () => {
  const runId = "run-enactment";
  const liveRepo = parkedRun(runId);
  const blockedRepo = parkedRun(runId);
  const finishedRepo = parkedRun(runId);
  plantLock(liveRepo, { pid: process.pid, runId, startedAt: Date.now() });
  plantLock(blockedRepo, { pid: process.pid, runId: "run-blocking", startedAt: Date.now() });

  const live = approvalRunOwner(liveRepo, runId);
  const blocked = approvalRunOwner(blockedRepo, runId);
  const finished = approvalRunOwner(finishedRepo, runId);
  const sentences = [live, blocked, finished].map((owner) => approvalEnactment("dispatch", owner));

  expect(new Set(sentences).size).toBe(3);
  expect(sentences[0]).toContain("the live daemon enacts this at its next task boundary");
  expect(sentences[1]).toContain("live run `run-blocking` holds the repository lock");
  expect(sentences[1]).toContain(`resume \`${runId}\` after it ends`);
  expect(sentences[2]).toContain(`run \`tickmarkr resume ${runId}\``);
});

test("`tickmarkr approve` run while the run's lock pid is ALIVE prints that the live daemon enacts the release at the next task boundary and prints NO `tickmarkr resume` instruction in any of its five disposition messages, while the same command against a finished run (no live owner) still prints the `tickmarkr resume <runId>` instruction — one test drives both branches through the real approve entrypoint and fails if either message is wrong or if a live approval is told to resume", async () => {
  const runId = "run-disposition";
  const liveRepo = fiveDispositionRun(runId);
  const deadRepo = fiveDispositionRun(runId);
  const gonePid = deadPid();
  plantLock(liveRepo, { pid: process.pid, runId, startedAt: Date.now() });
  plantLock(deadRepo, { pid: gonePid, runId, startedAt: Date.now() });
  // a presence-only check cannot tell these apart: both repos hold a lock FILE
  expect(existsSync(lockPath(liveRepo))).toBe(true);
  expect(existsSync(lockPath(deadRepo))).toBe(true);
  // The real registered command through the production dispatcher: these returned bytes are what
  // the binary prints to stdout. No typed outcome helper participates.
  expect(COMMANDS.approve).toBe(approve);

  for (const { taskId, flags, token, enacts } of DISPOSITION_PARKS) {
    const argv = [runId, taskId, ...flags, "--by", "operator"];
    const liveCli = await viaCli(liveRepo, [...argv]);
    const deadCli = await viaCli(deadRepo, [...argv]);
    expect(liveCli.code).toBe(0);
    expect(deadCli.code).toBe(0);

    // LIVE OWNER: the boundary sweep is the enactment, and the resume command appears NOWHERE in the
    // printed bytes — neither in the prose nor in the machine record. Following it would start a
    // second run in this repository, contending for the live daemon's graph.lock over an approval
    // that daemon has already scheduled.
    expect(liveCli.out).toContain(`approval disposition ${token}: `);
    expect(liveCli.out).toContain(`the live daemon enacts this at its next task boundary — it will ${enacts}`);
    expect(liveCli.out).not.toContain("tickmarkr resume");
    expect(printedStatus(liveCli.out)).toEqual({
      status: "deferred-live", disposition: token, ownerPid: process.pid, ownerRunId: runId,
    });

    // FINISHED RUN: the identical decision, and resume is still the command that enacts it
    expect(deadCli.out).toContain(`approval disposition ${token}: `);
    expect(deadCli.out).toContain(`run \`tickmarkr resume ${runId}\` to ${enacts}`);
    expect(printedStatus(deadCli.out)).toEqual({
      status: "recorded-no-owner", disposition: token, resume: `tickmarkr resume ${runId}`, ownerPid: gonePid, ownerRunId: runId,
    });
    expect(liveCli.out).not.toBe(deadCli.out);
  }

  // identical accepted decision bytes on both pids: only the liveness disclosure differs
  expect(approvalBytes(liveRepo, runId)).toHaveLength(DISPOSITION_PARKS.length);
  expect(approvalBytes(liveRepo, runId)).toEqual(approvalBytes(deadRepo, runId));
});

test("the liveness answer is derived from the run lock's own recorded owner pid rather than from the lock file's presence, exercised against a stale lock whose recorded pid is dead as well as a lock whose pid is live, because a presence check reports both as live", async () => {
  const runId = "run-owner-pid";
  const staleRepo = parkedRun(runId);
  const liveRepo = parkedRun(runId);
  const stalePid = deadPid();
  const child = spawn("sleep", ["30"]); // a FOREIGN live pid — not this process, not a guess
  try {
    // stale: the heartbeat expired ten minutes ago and the recorded owner is dead
    plantLock(staleRepo, { pid: stalePid, runId, startedAt: Date.now() - 600_000 }, { agoMs: 600_000 });
    plantLock(liveRepo, { pid: child.pid, runId, startedAt: Date.now() });
    // the presence oracle: identical for both, which is exactly why it cannot be the answer
    expect(existsSync(lockPath(staleRepo))).toBe(true);
    expect(existsSync(lockPath(liveRepo))).toBe(true);

    // the recorded pid is what is read — and it is the one carried back
    expect(runLockOwner(staleRepo)).toEqual({ pid: stalePid, runId, live: false });
    expect(runLockOwner(liveRepo)).toEqual({ pid: child.pid, runId, live: true });

    const stale = printedStatus(await approve([runId, "T1", "--by", "operator"], staleRepo));
    const live = printedStatus(await approve([runId, "T1", "--by", "operator"], liveRepo));
    expect(stale).toMatchObject({ status: "recorded-no-owner", ownerPid: stalePid });
    expect(live).toMatchObject({ status: "deferred-live", ownerPid: child.pid });
  } finally {
    child.kill();
  }
});

// v2.2 T3 moved this fixture's promise: both approvals land WHILE the loop is turning, so the
// boundary sweep enacts them and the record is `complete`. The outstanding half of the disclosure is
// pinned by the disposition-records test above, which lands its approval after the last boundary.
test("an approval accepted against the live daemon is enacted at the next task boundary over both kinds of park, and the run's completion record reports complete rather than naming it outstanding", async () => {
  // T1/T2 park BEFORE dispatch (humanGate); T3/T4 park after a failed acceptance gate the consult
  // sends to a human (gate-fail). One of each kind is approved while the daemon is live — that
  // approval cannot be enacted by this run, and the record has to say so.
  const { repo, fake } = setupRepo(
    [T("T1", { humanGate: true }), T("T2", { humanGate: true }), T("T3"), T("T4")],
    {
      judge: { pass: false, criteria: [{ criterion: "c1", met: false, reason: "operator override required" }] },
      review: { approve: true, issues: [] },
      consult: { action: "human", notes: "operator must decide" },
      tasks: {
        T3: [{ shell: `echo t3 > t3.txt && ${COMMIT} t3`, result: { ok: true, summary: "t3" } }],
        T4: [{ shell: `echo t4 > t4.txt && ${COMMIT} t4`, result: { ok: true, summary: "t4" } }],
      },
    },
  );
  const runId = "run-outstanding-parks";
  const approvedMidRun = new Set(["T1", "T3"]);
  const summary = await runDaemon(repo, {
    adapters: [fake],
    runId,
    // the operator approving against the LIVE daemon, at the moment each park is journaled
    narrate: (e) => {
      if (e.event !== "task-human" || !e.taskId || !approvedMidRun.has(e.taskId)) return;
      void approve([runId, e.taskId, ...(e.taskId === "T3" ? ["--waive"] : []), "--by", "operator"], repo).catch(() => { /* asserted below */ });
    },
  });

  const events = Journal.open(repo, runId).read();
  const parkKind = (taskId: string) => events.find((e) => e.event === "task-human" && e.taskId === taskId)?.data.kind;
  expect(parkKind("T1")).toBe("human-gate");
  expect(parkKind("T2")).toBe("human-gate");
  expect(parkKind("T3")).toBe("gate-fail"); // the second kind of park, same disclosure
  expect(parkKind("T4")).toBe("gate-fail");
  expect(events.filter((e) => e.event === "task-approved").map((e) => e.taskId).sort()).toEqual(["T1", "T3"]);

  // Live approvals are now enacted at task boundaries, even when the task later parks again for a new reason.
  expect(summary.human.sort()).toEqual(["T1", "T2", "T4"]);
  expect(summary.done).toContain("T3");
  expect(summary.approvalDisposition).toBe("complete");
  expect(runEnd(repo, runId).data.approvalDisposition).toBe("complete");
  expect(formatSummary(summary)).not.toContain("approvals outstanding");
  const approvedAt = events.findIndex((e) => e.event === "task-approved" && e.taskId === "T1");
  expect(approvedAt).toBeGreaterThan(-1);
  expect(dispatchesOf(events.slice(approvedAt + 1), "T1")).toBeGreaterThan(0);
}, 240_000);

test("the run-end disposition test produces and asserts a REAL `outstanding` record — an approval accepted by a live daemon that cannot be enacted before run-end (no task boundary remains after it) ends the run with `approvalDisposition: \"outstanding\"` and `outstandingApprovals` naming that task in both the summary and the journaled run-end row, alongside the `complete` record for an approval enacted at a boundary — and a daemon that never records `outstanding`, or a test that only asserts `complete`, fails", async () => {
  // FIXTURE 1 — `complete`: B is approved while the task loop is still turning, so the boundary
  // sweep enacts it inside this run and nothing is left over to name.
  const swept = twoGateRepo();
  const sweptRun = "run-disposition-complete";
  expect((await runDaemon(swept.repo, { adapters: [swept.fake], runId: sweptRun })).human.sort()).toEqual(["A", "B"]);
  await approve([sweptRun, "A", "--by", "operator"], swept.repo); // against the finished first run
  const complete = await runDaemon(swept.repo, {
    adapters: [swept.fake],
    runId: sweptRun,
    resume: true,
    narrate: (e) => {
      if (e.event !== "task-dispatch" || e.taskId !== "A") return;
      void approve([sweptRun, "B", "--by", "operator"], swept.repo).catch(() => { /* asserted below */ });
    },
  });
  expect(complete.done.sort()).toEqual(["A", "B"]);
  expect(complete.approvalDisposition).toBe("complete");
  expect(complete.outstandingApprovals).toBeUndefined();
  expect(runEnd(swept.repo, sweptRun).data.approvalDisposition).toBe("complete");
  expect(formatSummary(complete)).not.toContain("approvals outstanding");
  const sweptEvents = Journal.open(swept.repo, sweptRun).read();
  expect(sweptEvents.filter((e) => e.event === "task-approved")).toHaveLength(2); // the record covered real approvals
  expect(dispatchesOf(sweptEvents, "B")).toBe(1);

  // FIXTURE 2 — `outstanding`: a DISTINCT run where B's approval lands after the task loop has
  // exited, in the tip-verify window. The daemon accepts it (its lock is still live, so the command
  // even prints the boundary disposition) but no boundary remains to sweep it, and the run-end record
  // is the only place that can say so. This is the live path the boundary sweep does not cover.
  const late = twoGateRepo(TIP_VERIFY_GATE);
  const lateRun = "run-disposition-outstanding";
  expect((await runDaemon(late.repo, { adapters: [late.fake], runId: lateRun })).human.sort()).toEqual(["A", "B"]);
  await approve([lateRun, "A", "--by", "operator"], late.repo);
  let lateApproval: Promise<string> | undefined;
  const outstanding = await runDaemon(late.repo, {
    adapters: [late.fake],
    runId: lateRun,
    resume: true,
    // approve takes the shared approval serializer synchronously inside this callback, so the
    // daemon's own run-end sample waits behind the append rather than racing it.
    narrate: (e) => {
      if (e.event !== "tip-verify-start" || lateApproval) return;
      lateApproval = approve([lateRun, "B", "--by", "operator"], late.repo);
    },
  });
  expect(printedStatus((await lateApproval)!).status).toBe("deferred-live"); // accepted by the live run
  expect(outstanding.done).toEqual(["A"]);
  expect(outstanding.approvalDisposition).toBe("outstanding");
  expect(outstanding.outstandingApprovals).toEqual(["B"]);
  expect(runEnd(late.repo, lateRun).data.approvalDisposition).toBe("outstanding");
  expect(runEnd(late.repo, lateRun).data.outstandingApprovals).toEqual(["B"]);
  expect(formatSummary(outstanding)).toContain("approvals outstanding: B");
  const lateEvents = Journal.open(late.repo, lateRun).read();
  expect(lateEvents.filter((e) => e.event === "task-approved")).toHaveLength(2);
  expect(dispatchesOf(lateEvents, "B")).toBe(0); // named because it never reached a dispatch

  // the resume the record's own recovery command names enacts B — and closes the collection
  const enacted = await runDaemon(late.repo, { adapters: [late.fake], runId: lateRun, resume: true });
  expect(enacted.done.sort()).toEqual(["A", "B"]);
  expect(enacted.approvalDisposition).toBe("complete");
  expect(dispatchesOf(Journal.open(late.repo, lateRun).read(), "B")).toBe(1);
}, 300_000);

test("start runDaemon with approval A, append approval B while it runs, and record that both dispatch before run-end. Contrast with A and B present before start, where both dispatch, so a daemon that never reloads live approvals fails", async () => {
  const mid = twoGateRepo();
  const midRun = "run-midrun-approval";
  expect((await runDaemon(mid.repo, { adapters: [mid.fake], runId: midRun })).human.sort()).toEqual(["A", "B"]);
  await approve([midRun, "A", "--by", "operator"], mid.repo); // approval A: present before the run starts

  await runDaemon(mid.repo, {
    adapters: [mid.fake],
    runId: midRun,
    resume: true,
    // approval B: appended WHILE the daemon runs. The startup-built approved set cannot see it.
    narrate: (e) => {
      if (e.event !== "task-dispatch" || e.taskId !== "A") return;
      void approve([midRun, "B", "--by", "operator"], mid.repo).catch(() => { /* asserted below */ });
    },
  });

  const afterMid = Journal.open(mid.repo, midRun).read();
  const bApprovedAt = afterMid.findIndex((e) => e.event === "task-approved" && e.taskId === "B");
  expect(bApprovedAt).toBeGreaterThan(-1);
  expect(dispatchesOf(afterMid, "A")).toBe(1);
  expect(dispatchesOf(afterMid, "B")).toBe(1);
  const bDispatchAt = afterMid.findIndex((e, i) => i > bApprovedAt && e.event === "task-dispatch" && e.taskId === "B");
  const runEndAt = afterMid.findLastIndex((e) => e.event === "run-end");
  expect(bDispatchAt).toBeGreaterThan(bApprovedAt);
  expect(bDispatchAt).toBeLessThan(runEndAt);

  // on resume, B must not dispatch a second time
  const resumed = await runDaemon(mid.repo, { adapters: [mid.fake], runId: midRun, resume: true });
  expect(resumed.done.sort()).toEqual(["A", "B"]);
  expect(dispatchesOf(Journal.open(mid.repo, midRun).read(), "B")).toBe(1);

  // CONTRAST: both approvals present before the run starts — both dispatch in the same run
  const both = twoGateRepo();
  const bothRun = "run-both-approved";
  expect((await runDaemon(both.repo, { adapters: [both.fake], runId: bothRun })).human.sort()).toEqual(["A", "B"]);
  await approve([bothRun, "A", "--by", "operator"], both.repo);
  await approve([bothRun, "B", "--by", "operator"], both.repo);
  const bothDone = await runDaemon(both.repo, { adapters: [both.fake], runId: bothRun, resume: true });
  expect(bothDone.done.sort()).toEqual(["A", "B"]);
  const bothEvents = Journal.open(both.repo, bothRun).read();
  expect(dispatchesOf(bothEvents, "A")).toBe(1);
  expect(dispatchesOf(bothEvents, "B")).toBe(1);
  expect(bothDone.approvalDisposition).toBe("complete");
}, 300_000);

// Independent terminal observer: an approval that already owns the serializer must land before the
// sample; one invoked by the run-end append cannot land behind that sample while graph.lock is live.
test("approval append and run-end sampling are serialized across the terminalization boundary", async () => {
  const { repo, fake } = twoGateRepo();
  const runId = "run-terminalization";
  let before: Promise<string> | undefined;
  let boundary: Promise<string> | undefined;

  const summary = await runDaemon(repo, {
    adapters: [fake],
    runId,
    narrate: (e) => {
      if (e.event === "task-human" && e.taskId === "A") {
        before = approve([runId, "A", "--by", "operator"], repo);
      }
      if (e.event === "run-end") {
        boundary = approve([runId, "B", "--by", "operator"], repo);
      }
    },
  });
  await before;
  const boundaryOutput = await boundary;

  const events = Journal.open(repo, runId).read();
  expect(events.filter((e) => e.event === "task-approved").map((e) => e.taskId)).toEqual(["A", "B"]);
  expect(summary.approvalDisposition).toBe("complete");
  expect(summary.outstandingApprovals).toBeUndefined();
  expect(runEnd(repo, runId).data.approvalDisposition).toBe("complete");
  expect(printedStatus(boundaryOutput!).status).toBe("recorded-no-owner");
  const bApprovedAt = events.findIndex((e) => e.event === "task-approved" && e.taskId === "B");
  expect(events.slice(0, bApprovedAt).some((e) => e.event === "run-end")).toBe(true);
  expect(dispatchesOf(events, "B")).toBe(0);
}, 240_000);

test("test: a journal with task-approved then resume-restore then green gates then merge reports outstandingApprovals empty at run-end while the run-230 fixture with two upheld approvals and no later enactment still reports both outstanding whereas a fold that ignores resume-restore or counts any later event fails", () => {
  const at = (event: string, taskId: string, data: Record<string, unknown> = {}): JournalEvent =>
    ({ ts: "2026-09-03T00:00:00.000Z", event, taskId, data }) as JournalEvent;
  expect(outstandingApprovals([
    at("task-approved", "T1"), at("resume-restore", "T1"),
    at("gate-result", "T1", { pass: true }), at("merge", "T1"),
  ])).toEqual([]);
  expect(outstandingApprovals([
    at("task-approved", "T1", { release: "review-upheld" }),
    at("task-approved", "T2", { release: "review-upheld" }),
    at("gate-result", "T1", { pass: true }), at("merge", "T1"),
  ])).toEqual(["T1", "T2"]);
});

// Finding 3: task-failed is not proof of dispatch. An approved human gate can fail in routing BEFORE
// task-dispatch; treating the catch's task-failed as enactment reports "complete" over an approval
// that never ran — the exact silent completion this task exists to kill. And because that failure
// replays as `failed` (classifyTaskFailure → "infra" with no preceding dispatch, which
// `--retry-failed` skips), the completion line must not advertise resume over it either.
test("an approved task that fails before any dispatch stays outstanding, and the completion line never advertises a command that cannot enact it", () => {
  const at = (event: string, taskId: string, data: Record<string, unknown> = {}): JournalEvent =>
    ({ ts: "2026-08-08T00:00:00.000Z", event, taskId, data }) as unknown as JournalEvent;

  // approved, then failed with NO dispatch in between — routing died before it could buy a worker
  expect(outstandingApprovals([at("task-approved", "T1"), at("task-failed", "T1", { cause: "routing" })])).toEqual(["T1"]);
  // the same approval, dispatched and then failed: enacted — the run acted on the decision
  expect(outstandingApprovals([at("task-approved", "T1"), at("task-dispatch", "T1"), at("task-failed", "T1")])).toEqual([]);
  // gate-satisfied is the one release that enacts with NO worker: it resumes the persisted task branch
  expect(outstandingApprovals([at("task-approved", "T2", { release: GATE_SATISFIED_RELEASE }), at("worktree-recreation", "T2")])).toEqual([]);
  // ...and that no-worker proof is scoped to that release — an ordinary approval still needs a dispatch
  expect(outstandingApprovals([at("task-approved", "T3"), at("worktree-recreation", "T3")])).toEqual(["T3"]);

  const base = { runId: "r", branch: "b", done: [], pending: [], blocked: [], approvalDisposition: "outstanding" as const };
  // T1 failed pre-dispatch, T2 is still parked: the command is claimed over T2 and withheld from T1
  const mixed = formatSummary({ ...base, failed: ["T1"], human: ["T2"], outstandingApprovals: ["T1", "T2"] });
  expect(mixed).toContain("approvals outstanding: T1, T2");
  expect(mixed).toContain("`tickmarkr resume r` enacts T2");
  expect(mixed).toContain("T1 failed before any dispatch");
  expect(mixed).not.toContain("enacts T1");
  // when every outstanding approval IS resumable, the command covers all of them and nothing is stalled
  const parked = formatSummary({ ...base, failed: [], human: ["T1", "T2"], outstandingApprovals: ["T1", "T2"] });
  expect(parked).toContain("`tickmarkr resume r` enacts T1, T2");
  expect(parked).not.toContain("failed before any dispatch");
});
