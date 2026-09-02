import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { captureBaseline } from "../../src/gates/baseline.js";
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
      B: [{ shell: `sleep 0.15; echo b > b.txt && ${COMMIT} b`, result: { ok: true, summary: "b" } }],
    } },
  );
}

test("test: a task-approved event appended while a sibling is in flight dispatches the released task at the next task boundary before run-end while a daemon that consumes approvals only at startup and leaves the approved task idle until resume fails", async () => {
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
  const runEndAt = events.findIndex((e) => e.event === "run-end");
  expect(summary.done.sort()).toEqual(["A", "B"]);
  expect(dispatchAt).toBeGreaterThan(approvedAt);
  expect(dispatchAt).toBeLessThan(runEndAt);
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

test("test: each of the five release encodings appended live — absent release, gate-satisfied, recheck, review-upheld and attempt-cap — reaches its own resume-time production path at a task boundary with the uphold funding a worker carrying the findings, recheck re-dispatching against the full suite and attempt-cap resetting the attempt budget, while a sweep that special-cases some encodings and leaves the rest deferred to run-end fails", async () => {
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
  expect(dispatches(afterApproval(events, "R"), "R")).toHaveLength(1);
  expect(readFileSync(suiteLog, "utf8").split("\n").some((line) => line.includes("--R") && line.includes("argc=0 args="))).toBe(true);
  expect(dispatches(afterApproval(events, "U"), "U")).toHaveLength(1);
  expect(readFileSync(join(Journal.open(repo, runId).dir, "prompts", "U-a0.md"), "utf8")).toContain("reviewer finding: fix the board");
  expect(dispatches(afterApproval(events, "C"), "C")[0]?.data.attempt).toBe(0);
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
