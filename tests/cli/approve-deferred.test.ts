import { spawn, spawnSync } from "node:child_process";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type ApprovalStatus, approve } from "../../src/cli/commands/approve.js";
import { COMMANDS, dispatch } from "../../src/cli/index.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { formatSummary, outstandingApprovals, runDaemon } from "../../src/run/daemon.js";
import { GATE_SATISFIED_RELEASE, type JournalEvent, Journal } from "../../src/run/journal.js";
import { runLockOwner } from "../../src/run/lock.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// T14: an approval the runtime ACCEPTS against a live daemon may be inert for that run — daemon.ts
// builds its approved set once at startup and never re-reads it (deliberate: replay determinism).
// These tests pin the two disclosures that were missing: the disposition at the moment of approval,
// derived from the run lock's own recorded owner pid; and the run's completion record naming every
// accepted approval that never reached a dispatch, with a recovery command claimed only over the ids
// it can actually release.
//
// Every test here is TOP-LEVEL, never inside a describe(): the acceptance oracle filters with an
// ANCHORED `-t '^…$'` over vitest's full name (enclosing describe titles space-joined onto the test
// title), so a wrapper makes a verbatim criterion unmatchable.

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
  resume: string;
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
const twoGateRepo = () => setupRepo(
  [T("A", { humanGate: true }), T("B", { humanGate: true })],
  {
    tasks: {
      A: [{ shell: `echo a > a.txt && ${COMMIT} a`, result: { ok: true, summary: "a" } }],
      B: [{ shell: `echo b > b.txt && ${COMMIT} b`, result: { ok: true, summary: "b" } }],
    },
  },
);

test("the production approve command prints to stdout a machine-parseable status — \"deferred-live\" with the enactment resume command when the lock owner pid is live, \"recorded-no-owner\" when it is dead — parsed by the exact-title test from the command's own printed output against identical approval bytes on both pids; the status is printed output rather than a typed return, so a presence-only liveness check, a missing-status distinction, or a status only an internal helper prints while the command itself prints a bare string all fail", async () => {
  const runId = "run-disposition";
  const liveRepo = parkedRun(runId);
  const deadRepo = parkedRun(runId);
  const gonePid = deadPid();
  plantLock(liveRepo, { pid: process.pid, runId, startedAt: Date.now() });
  plantLock(deadRepo, { pid: gonePid, runId, startedAt: Date.now() });
  // a presence-only check cannot tell these apart: both repos hold a lock FILE
  expect(existsSync(lockPath(liveRepo))).toBe(true);
  expect(existsSync(lockPath(deadRepo))).toBe(true);

  // The real registered command through the production dispatcher: these returned bytes are what
  // the binary prints to stdout. No typed outcome helper participates.
  expect(COMMANDS.approve).toBe(approve);
  const argv = [runId, "T1", "--by", "operator"];
  const liveCli = await viaCli(liveRepo, [...argv]);
  const deadCli = await viaCli(deadRepo, [...argv]);
  expect(liveCli.code).toBe(0);
  expect(deadCli.code).toBe(0);
  expect(printedStatus(liveCli.out)).toEqual({
    status: "deferred-live", resume: `tickmarkr resume ${runId}`, ownerPid: process.pid, ownerRunId: runId,
  });
  expect(printedStatus(deadCli.out)).toEqual({
    status: "recorded-no-owner", resume: `tickmarkr resume ${runId}`, ownerPid: gonePid, ownerRunId: runId,
  });
  expect(liveCli.out).not.toBe(deadCli.out);
  // identical accepted decision bytes: only the liveness disclosure differs
  expect(approvalBytes(liveRepo, runId)).toHaveLength(1);
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

test("a run ending with an accepted approval that never reached a dispatch names that approval in its completion record, distinctly from a task parked without one, exercised over both kinds of park", async () => {
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
      void approve([runId, e.taskId, "--by", "operator"], repo).catch(() => { /* asserted below */ });
    },
  });

  const events = Journal.open(repo, runId).read();
  const parkKind = (taskId: string) => events.find((e) => e.event === "task-human" && e.taskId === taskId)?.data.kind;
  expect(parkKind("T1")).toBe("human-gate");
  expect(parkKind("T2")).toBe("human-gate");
  expect(parkKind("T3")).toBe("gate-fail"); // the second kind of park, same disclosure
  expect(parkKind("T4")).toBe("gate-fail");
  expect(events.filter((e) => e.event === "task-approved").map((e) => e.taskId).sort()).toEqual(["T1", "T3"]);

  // every one of the four is parked — the buckets alone cannot tell the approved from the unapproved
  expect(summary.human.sort()).toEqual(["T1", "T2", "T3", "T4"]);
  expect(summary.outstandingApprovals).toEqual(["T1", "T3"]);
  expect(runEnd(repo, runId).data.outstandingApprovals).toEqual(["T1", "T3"]);
  // the rendered record names them too — not only the structured field
  expect(formatSummary(summary)).toContain("approvals outstanding: T1, T3");
  // and the approvals really did reach no dispatch afterwards
  for (const taskId of ["T1", "T3"]) {
    const approvedAt = events.findIndex((e) => e.event === "task-approved" && e.taskId === taskId);
    expect(approvedAt).toBeGreaterThan(-1);
    expect(dispatchesOf(events.slice(approvedAt + 1), taskId)).toBe(0);
  }
}, 240_000);

test("run-end records approvalDisposition \"complete\" when every accepted approval dispatched and \"outstanding\" with task ids when one did not; exercise both records so an empty collection, an always-silent completion, or an always-outstanding implementation cannot satisfy the criterion", async () => {
  const { repo, fake } = twoGateRepo();
  const runId = "run-disposition-records";
  const parked = await runDaemon(repo, { adapters: [fake], runId });
  expect(parked.human.sort()).toEqual(["A", "B"]);

  // A is approved against a finished run; B against the live daemon of the resume below
  await approve([runId, "A", "--by", "operator"], repo);
  const outstanding = await runDaemon(repo, {
    adapters: [fake],
    runId,
    resume: true,
    narrate: (e) => {
      if (e.event !== "task-dispatch" || e.taskId !== "A") return;
      void approve([runId, "B", "--by", "operator"], repo).catch(() => { /* asserted below */ });
    },
  });
  // A's approval was enacted, B's was not — the record names B rather than reporting a finished run
  expect(outstanding.done).toEqual(["A"]);
  expect(outstanding.approvalDisposition).toBe("outstanding");
  expect(outstanding.outstandingApprovals).toEqual(["B"]);
  expect(runEnd(repo, runId).data.approvalDisposition).toBe("outstanding");
  expect(runEnd(repo, runId).data.outstandingApprovals).toEqual(["B"]);

  // the resume that enacts B: now every accepted approval has dispatched — a NON-empty collection
  const complete = await runDaemon(repo, { adapters: [fake], runId, resume: true });
  expect(complete.done.sort()).toEqual(["A", "B"]);
  expect(complete.approvalDisposition).toBe("complete");
  expect(complete.outstandingApprovals).toBeUndefined();
  expect(runEnd(repo, runId).data.approvalDisposition).toBe("complete");
  const events = Journal.open(repo, runId).read();
  expect(events.filter((e) => e.event === "task-approved")).toHaveLength(2); // both records covered real approvals
}, 240_000);

test("start runDaemon with approval A, append approval B while it runs, and record that only A dispatches; on resume record B dispatching. Contrast with A and B present before start, where both dispatch, so a mid-run reread or a daemon that never reloads on resume fails", async () => {
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
  // B landed mid-run: this resume's run-end is still ahead of it in the journal
  expect(afterMid.slice(bApprovedAt).some((e) => e.event === "run-end")).toBe(true);
  expect(dispatchesOf(afterMid, "A")).toBe(1); // only A dispatched
  expect(dispatchesOf(afterMid, "B")).toBe(0);

  // on resume, the reloaded approved set carries B — it dispatches now
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
  expect(summary.approvalDisposition).toBe("outstanding");
  expect(summary.outstandingApprovals).toEqual(["A"]);
  expect(runEnd(repo, runId).data.outstandingApprovals).toEqual(["A"]);
  expect(printedStatus(boundaryOutput!).status).toBe("recorded-no-owner");
  const bApprovedAt = events.findIndex((e) => e.event === "task-approved" && e.taskId === "B");
  expect(events.slice(0, bApprovedAt).some((e) => e.event === "run-end")).toBe(true);
  expect(dispatchesOf(events, "B")).toBe(0);
}, 240_000);

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
