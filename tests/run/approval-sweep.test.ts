import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, SlotOpts } from "../../src/drivers/types.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { approve } from "../../src/cli/commands/approve.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead, shOk } from "../../src/run/git.js";
import { ATTEMPT_CAP_RELEASE, GATE_SATISFIED_RELEASE, Journal, RECHECK_RELEASE, REVIEW_UPHELD_RELEASE, type JournalEvent } from "../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const dispatches = (events: JournalEvent[], taskId: string) =>
  events.filter((e) => e.event === "task-dispatch" && e.taskId === taskId);
const afterApproval = (events: JournalEvent[], taskId: string) =>
  events.slice(events.findIndex((e) => e.event === "task-approved" && e.taskId === taskId) + 1);

function liveApprovalRepo() {
  return setupRepo(
    [T("A", { humanGate: true }), T("B")],
    { tasks: {
      A: [{ shell: `echo a > a.txt && ${COMMIT} a`, result: { ok: true, summary: "a" } }],
      B: [{ shell: `sleep 0.8; echo b > b.txt && ${COMMIT} b`, result: { ok: true, summary: "b" } }],
    } },
  );
}

test("test: a task-approved row appended while a slot is free and no in-flight task has settled dispatches the released task within one poll interval whereas the shipped loop that consumes it only at the next task boundary fails", async () => {
  const runId = "run-live-approval-boundary";
  const { repo, fake } = liveApprovalRepo();
  const summary = await runDaemon(repo, {
    adapters: [fake],
    runId,
    concurrency: 2,
    narrate: (e) => {
      if (e.event === "task-dispatch" && e.taskId === "B") {
        Journal.open(repo, runId).append("task-approved", "A", { by: "test", via: "test" });
      }
    },
  });
  const events = Journal.open(repo, runId).read();
  const approvedAt = events.findIndex((e) => e.event === "task-approved" && e.taskId === "A");
  const dispatchAt = events.findIndex((e, i) => i > approvedAt && e.event === "task-dispatch" && e.taskId === "A");
  const siblingSettledAt = events.findIndex((e) => e.event === "worker-result" && e.taskId === "B");
  expect(summary.done.sort()).toEqual(["A", "B"]);
  expect(dispatchAt).toBeGreaterThan(approvedAt);
  expect(dispatchAt).toBeLessThan(siblingSettledAt);
});

async function seededReleaseRun(runId: string) {
  const suiteLog = join(makeTestTempDir("tickmarkr-approval-suite-"), "suite.log");
  const testCmd = `printf '%s argc=%s args=%s\\n' "$(basename "$PWD")" "$#" "$*" >> ${shq(suiteLog)}`;
  const tasks = [
    T("H", { humanGate: true, files: ["**"], status: "human" }),
    T("G", { files: ["**"], status: "human" }),
    T("R", { files: ["**"], status: "human" }),
    T("U", { files: ["**"], status: "human" }),
    T("C", { files: ["**"], status: "human" }),
    T("S", { files: ["**"] }),
  ];
  const { repo, fake } = setupRepo(tasks, { tasks: {
    H: [{ shell: `echo h > h.txt && ${COMMIT} h`, result: { ok: true, summary: "h" } }],
    R: [{ shell: `echo r > r.txt && ${COMMIT} r`, result: { ok: true, summary: "r" } }],
    U: [{ shell: `echo u > u.txt && ${COMMIT} u`, result: { ok: true, summary: "u" } }],
    C: [{ shell: `echo c > c.txt && ${COMMIT} c`, result: { ok: true, summary: "c" } }],
    S: [{ shell: `sleep 0.15; echo s > s.txt && ${COMMIT} s`, result: { ok: true, summary: "s" } }],
  } }, `gates: { test: ${JSON.stringify(testCmd)} }\n`);

  const baseRef = await gitHead(repo);
  const branch = `tickmarkr/${runId}`;
  const driver = new SubprocessDriver();
  const priorCommits = new Map<string, string>();
  for (const taskId of ["H", "G", "R", "U", "C"]) {
    const priorWt = await driver.worktree(repo, `${branch}--${taskId}`, baseRef);
    const file = `${taskId.toLowerCase()}-prior.txt`;
    writeFileSync(join(priorWt, file), `${taskId}\n`);
    await shOk(`git add ${shq(file)} && git commit --no-gpg-sign -m ${shq(`${taskId} prior`)}`, priorWt);
    priorCommits.set(taskId, await gitHead(priorWt));
  }

  const commands = { test: testCmd };
  const baseline = await captureBaseline(repo, commands);
  writeFileSync(suiteLog, "");
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { baseRef, commands, branch, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  for (const taskId of ["H", "G", "R", "U", "C"]) {
    const commit = priorCommits.get(taskId)!;
    if (taskId !== "H") {
      const times = taskId === "C" ? 10 : 1;
      for (let i = 0; i < times; i++) journal.append("task-dispatch", taskId, { assignment, attempt: i });
    }
    journal.append("worker-result", taskId, { ok: true, summary: taskId.toLowerCase(), deviations: [] });
    journal.phaseStart(taskId, "gates");
    journal.append("gate-result", taskId, { gate: "test", pass: true, details: "prior green", commit, fullSuite: true });
    if (taskId === "G") journal.append("gate-result", taskId, { gate: "acceptance", pass: false, details: "operator accepted", commit });
    if (taskId === "U") journal.append("gate-result", taskId, { gate: "review", pass: false, details: "reviewer finding: fix the board", commit });
    journal.append("task-human", taskId, { kind: taskId === "H" ? "human-gate" : taskId === "C" ? "attempt-cap" : "gate-fail", reason: taskId === "H" ? "approval required" : "parked" });
  }
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(baseline));
  return { repo, fake, suiteLog };
}

async function recheckPark(kind: "gate-fail" | "infra") {
  const runId = `run-recheck-${kind}`;
  const testCmd = "test ! -f broken.txt";
  const { repo, fake } = setupRepo(
    [T("T1", { status: "human", files: ["**"] })],
    { tasks: { T1: [{
      shell: `git rm -q broken.txt && ${COMMIT} fixed`,
      result: { ok: true, summary: "fixed" },
    }] } },
    `gates: { test: ${JSON.stringify(testCmd)} }\n`,
  );
  const baseRef = await gitHead(repo);
  const branch = `tickmarkr/${runId}`;
  const driver = new SubprocessDriver();
  const wt = await driver.worktree(repo, `${branch}--T1`, baseRef);
  writeFileSync(join(wt, "broken.txt"), "broken\n");
  await shOk(`git add broken.txt && git commit --no-gpg-sign -m broken`, wt);
  const commit = await gitHead(wt);
  const baseline = await captureBaseline(repo, { test: testCmd });
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, {
    baseRef, commands: { test: testCmd }, branch,
    graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
  });
  journal.append("task-dispatch", "T1", { assignment, attempt: 0 });
  journal.append("worker-launch", "T1", { attempt: 0, retryMode: "fresh" });
  journal.append("worker-result", "T1", { ok: true, summary: "parked commit", deviations: [] });
  journal.phaseStart("T1", "gates");
  journal.append("gate-result", "T1", {
    gate: "test", pass: false, details: kind === "infra" ? "signal exit" : "assertion failed", commit,
    ...(kind === "infra" ? { infra: true } : {}),
  });
  journal.append("gate-fingerprint-cap", "T1", {
    gate: "test", channel: "fake:fake-1", fingerprint: "parked red", occurrences: 2,
  });
  journal.append("task-human", "T1", { kind, reason: "parked" });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(baseline));
  await approve([runId, "T1", "--recheck", "--by", "test"], repo);
  await runDaemon(repo, { adapters: [fake], runId, resume: true });
  return { events: journal.read(), declared: loadGraph(repo).tasks[0]!.gates };
}

test("test: a recheck release of a gate-fail park and of an infra park each re-run the whole declared battery on the parked commit before any worker with a recheck-battery journal row and no worker-launch and a red battery then dispatches on the banned channel's alternative with the fingerprint ban spent by the release whereas the shipped path that journals retry-same-banned before any gate-result or refuses the infra park fails", async () => {
  for (const kind of ["gate-fail", "infra"] as const) {
    const { events, declared } = await recheckPark(kind);
    const approvedAt = events.findIndex((e) => e.event === "task-approved" && e.taskId === "T1");
    const recheckAt = events.findIndex((e, i) => i > approvedAt && e.event === "recheck-battery" && e.taskId === "T1");
    const launchAt = events.findIndex((e, i) => i > approvedAt && e.event === "worker-launch" && e.taskId === "T1");
    expect(recheckAt).toBeGreaterThan(approvedAt);
    expect(launchAt).toBeGreaterThan(recheckAt);
    expect(events.slice(approvedAt + 1, recheckAt).some((e) => e.event === "worker-launch")).toBe(false);
    expect(events[recheckAt]!.data).toMatchObject({ pass: false, gates: declared });
    const dispatch = events.slice(recheckAt + 1).find((e) => e.event === "task-dispatch" && e.taskId === "T1")!;
    expect((dispatch.data.assignment as typeof assignment).model).toBe("fake-2");
    expect(events.slice(approvedAt).some((e) => e.event === "retry-same-banned")).toBe(false);
  }
}, 240_000);

test("each live release encoding reaches its production path, including a worker-free recheck battery", async () => {
  const runId = "run-live-release-kinds";
  const { repo, fake, suiteLog } = await seededReleaseRun(runId);
  await runDaemon(repo, {
    adapters: [fake],
    runId,
    resume: true,
    concurrency: 2,
    narrate: (e) => {
      if (e.event !== "task-dispatch" || e.taskId !== "S") return;
      const journal = Journal.open(repo, runId);
      journal.append("task-approved", "H", { by: "test", via: "test" });
      journal.append("task-approved", "G", { by: "test", via: "test", release: GATE_SATISFIED_RELEASE, gate: "acceptance" });
      journal.append("task-approved", "R", { by: "test", via: "test", release: RECHECK_RELEASE });
      journal.append("task-approved", "U", { by: "test", via: "test", release: REVIEW_UPHELD_RELEASE, gate: "review" });
      journal.append("task-approved", "C", { by: "test", via: "test", release: ATTEMPT_CAP_RELEASE });
    },
  });

  const events = Journal.open(repo, runId).read();
  expect(dispatches(afterApproval(events, "H"), "H")).toHaveLength(1);
  expect(dispatches(afterApproval(events, "G"), "G")).toHaveLength(0);
  expect(afterApproval(events, "G").some((e) => e.event === "worktree-recreation" && e.taskId === "G")).toBe(true);
  expect(dispatches(afterApproval(events, "R"), "R")).toHaveLength(0);
  expect(afterApproval(events, "R").some((e) => e.event === "recheck-battery" && e.taskId === "R")).toBe(true);
  expect(readFileSync(suiteLog, "utf8").split("\n").some((line) => line.includes("--R") && line.includes("argc=0 args="))).toBe(true);
  expect(dispatches(afterApproval(events, "U"), "U")).toHaveLength(1);
  expect(readFileSync(join(Journal.open(repo, runId).dir, "prompts", "U-a0.md"), "utf8")).toContain("reviewer finding: fix the board");
  expect(dispatches(afterApproval(events, "C"), "C")[0]?.data.attempt).toBe(0);
});

test("test: the daemon's worker slot request carries the assignment's adapter id in its agent field so the orca driver's hook table applies to it whereas a slot request without the agent field fails", async () => {
  const { repo, fake } = setupRepo([T("T1")], { tasks: {
    T1: [{ shell: `echo slot > slot.txt && ${COMMIT} slot`, result: { ok: true, summary: "slot" } }],
  } });
  const inner = new SubprocessDriver();
  const agents: Array<string | undefined> = [];
  const driver: ExecutorDriver = {
    id: "slot-agent-spy", interactive: false,
    async slot(cwd: string, name: string, opts?: SlotOpts) {
      if (name.includes("-worker-")) agents.push(opts?.agent);
      return inner.slot(cwd, name);
    },
    run: inner.run.bind(inner), waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner), status: inner.status.bind(inner),
    read: inner.read.bind(inner), notify: inner.notify.bind(inner), close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  };
  await runDaemon(repo, { adapters: [fake], runId: "run-worker-agent-slot", driver });
  expect(agents).toEqual(["fake"]);
});

test("test: a run whose live approvals were all consumed at task boundaries ends with approvalDisposition complete while the shipped run ending outstanding over an approval accepted hours before run-end fails", async () => {
  const runId = "run-live-approval-complete";
  const { repo, fake } = liveApprovalRepo();
  const summary = await runDaemon(repo, {
    adapters: [fake],
    runId,
    concurrency: 2,
    narrate: (e) => {
      if (e.event === "task-dispatch" && e.taskId === "B") {
        Journal.open(repo, runId).append("task-approved", "A", { by: "test", via: "test" });
      }
    },
  });
  expect(summary.approvalDisposition).toBe("complete");
  expect(summary.outstandingApprovals).toBeUndefined();
  expect(Journal.open(repo, runId).read().find((e) => e.event === "run-end")?.data.approvalDisposition).toBe("complete");
});

test("test: a boundary sweep with no new approvals changes nothing and a resume replay of a run that consumed approvals mid-run reconstructs the same task statuses from the journal alone while a sweep that double-consumes an approval on replay fails", async () => {
  const runId = "run-live-approval-replay";
  const { repo, fake } = liveApprovalRepo();
  const first = await runDaemon(repo, {
    adapters: [fake],
    runId,
    concurrency: 2,
    narrate: (e) => {
      if (e.event === "task-dispatch" && e.taskId === "B") {
        Journal.open(repo, runId).append("task-approved", "A", { by: "test", via: "test" });
      }
    },
  });
  expect(first.done.sort()).toEqual(["A", "B"]);
  const before = Journal.open(repo, runId).read();
  const replay = Journal.open(repo, runId).replayStatuses();
  expect(replay.get("A")).toBe("done");
  expect(replay.get("B")).toBe("done");

  const second = await runDaemon(repo, { adapters: [fake], runId, resume: true });
  const after = Journal.open(repo, runId).read();
  expect(second.done.sort()).toEqual(["A", "B"]);
  expect(dispatches(after, "A")).toHaveLength(1);
  expect(dispatches(after, "B")).toHaveLength(1);
  expect(after.filter((e) => e.event === "task-approved" && e.taskId === "A")).toHaveLength(1);
  expect(after.length).toBeGreaterThan(before.length); // run-resume/run-end only; no second A dispatch
  expect(after.slice(before.length).some((e) => e.taskId === "A")).toBe(false);
});
