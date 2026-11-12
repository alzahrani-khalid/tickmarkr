// Queue row 413 (D-2187 add.69, add.99, add.100): a red OPERATOR recheck parks on its first red gate by
// default; --on-red repair and the graph-changed release keep the base repair. Zero tokens: fake adapter,
// subprocess driver, scripted gate commands, through approve and runDaemon (the production seam).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { shq } from "../../../src/adapters/types.js";
import { approve, newestPark, readJournalEvents } from "../../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { formatOwnedName, type ExecutorDriver } from "../../../src/drivers/types.js";
import { graphDefinitionHash, loadGraph, saveGraph } from "../../../src/graph/graph.js";
import { validateGraph } from "../../../src/graph/schema.js";
import { decisionCommands } from "../../../src/run/decision-verbs.js";
import { resetApprovalWindowForTests, runDaemon, setApprovalWindowForTests } from "../../../src/run/daemon.js";
import { gitHead } from "../../../src/run/git.js";
import { Journal, RECHECK_RELEASE, type JournalEvent } from "../../../src/run/journal.js";
import { firstRedGate, recheckParksOnRed } from "../../../src/run/recheck-disposition.js";
import * as stall from "../../../src/run/stall.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

beforeEach(() => setApprovalWindowForTests(1));
afterEach(() => resetApprovalWindowForTests());

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const rows = (repo: string, runId: string) => Journal.open(repo, runId).read();
const afterResume = (all: JournalEvent[]): JournalEvent[] => all.slice(all.map((e) => e.event).lastIndexOf("run-resume") + 1);
const of = (evs: JournalEvent[], event: string) => evs.filter((e) => e.event === event && e.taskId === "T1");
const DISPATCH_ROWS = ["task-dispatch", "repair-attempt", "repair-dispatch", "worker-launch"];
const dispatchRows = (evs: JournalEvent[]) => evs.filter((e) => e.taskId === "T1" && DISPATCH_ROWS.includes(e.event));
const newest = (repo: string, runId: string) => {
  const { events, sourceIndexes } = readJournalEvents(Journal.open(repo, runId));
  return newestPark(events, "T1", sourceIndexes)!;
};
const decision = (repo: string, runId: string) => of(rows(repo, runId), "task-approved").at(-1)!;

/**
 * One task whose test gate is green at baseline and red once t1.txt lands (unless `flag` exists), its
 * judge and review scripted; the first run parks on the red (consult → human).
 */
const redRepo = (opts: { testGreen?: boolean; judgePass?: boolean; review?: object } = {}) => {
  const flag = join(makeTestTempDir("tickmarkr-recheck-park-"), "green");
  const judgePass = opts.judgePass ?? true;
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "acceptance", ...(opts.review ? ["review"] : [])],
      ...(opts.review ? { complexity: 8 } : {}) })],
    {
      ...(opts.review ? { review: opts.review } : {}),
      judge: { pass: judgePass, criteria: [{ criterion: "c1", met: judgePass, reason: judgePass ? "ok" : "t1.txt:1 still wrong" }] },
      consult: { action: "human", notes: "operator decides" },
      tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] },
    },
    `gates: { build: 'true', test: ${shq(opts.testGreen ? "true" : `[ ! -f t1.txt ] || [ -f ${flag} ]`)}, lint: 'true' }\n`,
  );
  return { repo, fake, scriptPath, flag };
};

/** The resumed park: recheck-battery red, a gate-fail park on `gate`, and no dispatch row after it. */
const expectParkedOn = (repo: string, runId: string, gate: string) => {
  const post = afterResume(rows(repo, runId));
  expect(of(post, "recheck-battery").map((e) => e.data.pass), runId).toEqual([false]);
  const parks = of(post, "task-human");
  expect(parks.map((e) => e.data.kind), runId).toEqual(["gate-fail"]);
  expect(parks[0]!.data.firstRedGate, runId).toBe(gate);
  expect(parks[0]!.data.reason, runId).toContain(`recheck red on ${gate}`);
  expect(dispatchRows(post), runId).toEqual([]);
  expect(newest(repo, runId).failedGate, runId).toBe(gate);
  return post;
};

/** A driver whose worker wait throws after the worker committed — the run fails T1 with landed work. */
const wedgedAfterWork = (): ExecutorDriver => {
  const inner = new SubprocessDriver();
  let wedged = false;
  return {
    id: "wedged-after-work",
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    async waitOutput(slot, pattern, timeoutMs, opts) {
      const seen = await inner.waitOutput(slot, pattern, timeoutMs, opts);
      if (!wedged && slot.name.includes("-worker-")) { wedged = true; throw new Error("pane wedged after the worker committed"); }
      return seen;
    },
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  } as ExecutorDriver;
};

/** A stall park that recorded a reapFailure over finished work whose test gate is red (OBS-1202's shape). */
const stallPark = async (runId: string) => {
  const reapFailure = "worker group 4242 cleanup unknown";
  const fake2 = { adapter: "fake", model: "fake-2", channel: "api" as const, tier: "frontier" as const };
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{ shell: `echo redo > redo.txt && ${COMMIT} redo`, result: { ok: true, summary: "redone" } }] } },
    `gates: { build: 'true', test: ${shq("[ ! -f harvest.txt ]")}, lint: 'true' }\n`);
  const base = await gitHead(repo);
  const wt = await new SubprocessDriver().worktree(repo, `tickmarkr/${runId}--T1`, base);
  writeFileSync(join(wt, "harvest.txt"), "finished before the park\n");
  git(wt, "add", "-A");
  git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--no-gpg-sign", "-qm", "finished work");
  const j = Journal.create(repo, runId);
  j.append("run-start", undefined, { baseRef: base, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  const nonce = "5ea1ed00";
  const dispatchScript = join(j.dir, "T1-a0.sh");
  writeFileSync(`${dispatchScript}.${nonce}.pgid`, "4242\n");
  const slot = { id: "sub-1", name: formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId }), cwd: wt };
  j.append("task-dispatch", "T1", { assignment: fake2, attempt: 0, workerDispatchOrdinal: 0, retryMode: "fresh" });
  j.append("worker-launch", "T1", { attempt: 0, retryMode: "fresh", nonce, dispatchScript, driver: "subprocess", slot });
  j.append("worker-result", "T1", { ok: true, summary: "t1 finished", deviations: [], finished: true, exitCode: null, mode: "interactive" });
  j.append("worker-process-reaped", "T1", { slot: slot.name, attempt: 0, processGroup: 4242, strays: [43190], survivors: null, error: reapFailure });
  j.append("task-human", "T1", { kind: "stall", reason: `worker could not be reaped before harvest: ${reapFailure}`, reapFailure });
  return { repo, fake };
};
const resumeWithEmptyCensus = async (repo: string, fake: ReturnType<typeof setupRepo>["fake"], runId: string) => {
  const reap = vi.spyOn(stall, "reapOwnedProcessGroup").mockResolvedValue([]);
  try {
    return await runDaemon(repo, { adapters: [fake], runId, resume: true, driver: new SubprocessDriver() });
  } finally {
    reap.mockRestore();
  }
};

test("a red recheck of a park or a failed task or a stall parks on its first red gate by default and writes no dispatch row", async () => {
  // ---- a gate-fail park, recheck with no flag: the decision records park; the red battery parks ---------
  {
    const { repo, fake } = redRepo();
    const runId = "run-park-default";
    expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    expect(decision(repo, runId).data).toMatchObject({ release: RECHECK_RELEASE, onRed: "park" });
    expect((await runDaemon(repo, { adapters: [fake], runId, resume: true })).human).toEqual(["T1"]);
    const post = expectParkedOn(repo, runId, "test");
    // nothing else runs, so the run-level approval window opens by itself on the park
    expect(post.some((e) => e.event === "approval-window-start")).toBe(true);
  }
  // ---- a review gate-fail park whose recheck reds on review parks on review with uphold offered ---------
  {
    const { repo, fake } = redRepo({ testGreen: true, review: { approve: false, findings: [{ note: "`t1.txt` line 1 says one where the spec wants two", severity: "material" }] } });
    const runId = "run-park-review";
    expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
    expect(newest(repo, runId).failedGate).toBe("review");
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    expect((await runDaemon(repo, { adapters: [fake], runId, resume: true })).human).toEqual(["T1"]);
    expectParkedOn(repo, runId, "review");
  }
  // ---- a failed task's recheck (failure token), red, no flag ---------------------------------------------
  {
    const { repo, fake } = redRepo();
    const runId = "run-park-failed";
    expect((await runDaemon(repo, { adapters: [fake], runId, driver: wedgedAfterWork() })).failed).toEqual(["T1"]);
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    expect(decision(repo, runId).data).toMatchObject({ release: RECHECK_RELEASE, onRed: "park" });
    expect((await runDaemon(repo, { adapters: [fake], runId, resume: true })).human).toEqual(["T1"]);
    expectParkedOn(repo, runId, "test");
  }
  // ---- a stall recheck (recorded reapFailure, empty census), red, no flag --------------------------------
  {
    const runId = "run-park-stall";
    const { repo, fake } = await stallPark(runId);
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    expect(decision(repo, runId).data).toMatchObject({ release: RECHECK_RELEASE, onRed: "park" });
    expect((await resumeWithEmptyCensus(repo, fake, runId)).human).toEqual(["T1"]);
    const post = afterResume(rows(repo, runId));
    expect(of(post, "worker-process-reaped")[0]?.data).toMatchObject({ survivors: [] });
    expectParkedOn(repo, runId, "test");
  }
}, 300_000);

test("an explicit park with acceptance and review both red parks on acceptance and its printed approve command reopens the park", async () => {
  const { repo, fake } = redRepo({ testGreen: true, judgePass: false, review: { approve: false, findings: [{ note: "`t1.txt` line 1 says one where the spec wants two", severity: "material" }] } });
  const runId = "run-park-first-red";
  expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
  await approve([runId, "T1", "--recheck", "--on-red", "park", "--by", "op"], repo);
  expect(decision(repo, runId).data.onRed).toBe("park");
  expect((await runDaemon(repo, { adapters: [fake], runId, resume: true })).human).toEqual(["T1"]);
  const post = afterResume(rows(repo, runId));
  // both semantic gates red in the battery; review's row is journaled AFTER acceptance's
  const reds = of(post, "gate-result").filter((e) => e.data.pass === false).map((e) => e.data.gate);
  expect(reds).toEqual(expect.arrayContaining(["acceptance", "review"]));
  expect(firstRedGate(reds.map((gate) => ({ gate: String(gate) })))).toBe("acceptance");
  expectParkedOn(repo, runId, "acceptance");
  const park = of(post, "task-human")[0]!;
  // the park's own verbs are acceptance's: waive or recheck, never review's uphold
  expect(park.data.reason).not.toContain("--uphold");
  // the printed decision command (bound to the park token and acceptance) reopens it through approve
  const parked = newest(repo, runId);
  const { commands } = decisionCommands(runId, "T1", parked);
  expect(commands.map((c) => c.verb)).toEqual(["waive", "recheck"]);
  const printed = commands.find((c) => c.verb === "recheck")!.command;
  expect(printed).toBe(`tickmarkr approve ${runId} T1 --recheck --gate acceptance --park ${parked.line}@${parked.ts}`);
  const out = await approve([...printed.split(" ").slice(2), "--by", "op"], repo);
  expect(out).toContain("failed gate acceptance");
  expect(decision(repo, runId).data).toMatchObject({ release: RECHECK_RELEASE, onRed: "park", failedGate: "acceptance", park: { line: parked.line } });
  expect(Journal.open(repo, runId).replayStatuses().get("T1")).toBe("pending");
  // an explicit park whose ONLY red is review parks on review
  {
    const { repo: r3, fake: f3 } = redRepo({ testGreen: true, review: { approve: false, findings: [{ note: "`t1.txt` line 1 says one where the spec wants two", severity: "material" }] } });
    const run3 = "run-park-explicit-review";
    expect((await runDaemon(r3, { adapters: [f3], runId: run3 })).human).toEqual(["T1"]);
    await approve([run3, "T1", "--recheck", "--on-red", "park", "--by", "op"], r3);
    expect(decision(r3, run3).data.onRed).toBe("park");
    expect((await runDaemon(r3, { adapters: [f3], runId: run3, resume: true })).human).toEqual(["T1"]);
    expect(of(afterResume(rows(r3, run3)), "gate-result").filter((e) => e.data.pass === false).map((e) => e.data.gate)).toEqual(["review"]);
    expectParkedOn(r3, run3, "review");
  }
  // a command bound to the later-declared review is refused, appending nothing
  const { repo: repo2, fake: fake2 } = redRepo({ testGreen: true, judgePass: false, review: { approve: false, findings: [{ note: "`t1.txt` line 1 says one where the spec wants two", severity: "material" }] } });
  const runId2 = "run-park-first-red-mismatch";
  await runDaemon(repo2, { adapters: [fake2], runId: runId2 });
  await approve([runId2, "T1", "--recheck", "--by", "op"], repo2);
  await runDaemon(repo2, { adapters: [fake2], runId: runId2, resume: true });
  const p2 = newest(repo2, runId2);
  const before = rows(repo2, runId2).length;
  await expect(approve([runId2, "T1", "--uphold", "--gate", "review", "--park", `${p2.line}@${p2.ts}`], repo2)).rejects.toThrow(/mismatched gate/);
  expect(rows(repo2, runId2).length).toBe(before);
}, 300_000);

test("the repair disposition and the graph changed release each fund a repair as before and a green recheck merges", async () => {
  // ---- --on-red repair: the red battery funds a worker exactly as at the base -----------------------------
  {
    const { repo, fake } = redRepo();
    const runId = "run-repair-explicit";
    expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
    await approve([runId, "T1", "--recheck", "--on-red", "repair", "--by", "op"], repo);
    expect(decision(repo, runId).data.onRed).toBe("repair");
    await runDaemon(repo, { adapters: [fake], runId, resume: true });
    const post = afterResume(rows(repo, runId));
    expect(of(post, "recheck-battery")[0]?.data.pass).toBe(false);
    expect(of(post, "task-dispatch").length).toBeGreaterThanOrEqual(1);
    expect(of(post, "task-human").every((e) => e.data.firstRedGate === undefined)).toBe(true);
  }
  // ---- a stall recheck (recorded reapFailure, empty census) with --on-red repair funds a repair as at the base
  {
    const runId = "run-repair-stall";
    const { repo, fake } = await stallPark(runId);
    await approve([runId, "T1", "--recheck", "--on-red", "repair", "--by", "op"], repo);
    expect(decision(repo, runId).data).toMatchObject({ release: RECHECK_RELEASE, onRed: "repair" });
    await resumeWithEmptyCensus(repo, fake, runId);
    const post = afterResume(rows(repo, runId));
    expect(of(post, "recheck-battery")[0]?.data.pass).toBe(false);
    expect(of(post, "task-dispatch").length).toBeGreaterThanOrEqual(1);
    expect(of(post, "task-human").every((e) => e.data.firstRedGate === undefined)).toBe(true);
  }
  // ---- a recheck decision row with no onRed (a journal written before this version) is the base repair ---
  {
    const { repo, fake } = redRepo();
    const runId = "run-repair-legacy";
    expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
    const p = newest(repo, runId);
    Journal.open(repo, runId).append("task-approved", "T1", { by: "op", via: "cli", release: RECHECK_RELEASE, park: { line: p.line, ts: p.ts }, failedGate: "test" });
    expect(recheckParksOnRed(decision(repo, runId))).toBe(false);
    await runDaemon(repo, { adapters: [fake], runId, resume: true });
    const post = afterResume(rows(repo, runId));
    expect(of(post, "recheck-battery")[0]?.data.pass).toBe(false);
    expect(of(post, "task-dispatch").length).toBeGreaterThanOrEqual(1);
  }
  // ---- the graph-changed release records repair explicitly, never the operator default -------------------
  {
    const { repo, fake } = redRepo();
    const runId = "run-repair-generated";
    expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
    // the operator changes the parked task's spec and resumes with --graph-changed
    const g = loadGraph(repo);
    saveGraph(repo, validateGraph({ ...g, tasks: g.tasks.map((t) => ({ ...t, goal: `${t.goal} (amended)` })) }));
    await runDaemon(repo, { adapters: [fake], runId, resume: true, graphChanged: true });
    const post = afterResume(rows(repo, runId));
    const released = of(post, "task-approved").find((e) => e.data.via === "resume")!;
    expect(released.data).toMatchObject({ by: "resume --graph-changed", release: RECHECK_RELEASE, onRed: "repair" });
    expect(of(post, "recheck-battery")[0]?.data.pass).toBe(false);
    expect(of(post, "task-dispatch").length).toBeGreaterThanOrEqual(1);
    expect(of(post, "task-human").every((e) => e.data.firstRedGate === undefined)).toBe(true);
  }
  // ---- a green battery merges under either value ---------------------------------------------------------
  for (const onRed of ["park", "repair"] as const) {
    const { repo, fake, flag } = redRepo();
    const runId = `run-green-${onRed}`;
    expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
    writeFileSync(flag, "green\n");
    await approve([runId, "T1", "--recheck", "--on-red", onRed, "--by", "op"], repo);
    expect((await runDaemon(repo, { adapters: [fake], runId, resume: true })).done, onRed).toEqual(["T1"]);
    const post = afterResume(rows(repo, runId));
    expect(of(post, "recheck-battery")[0]?.data.pass, onRed).toBe(true);
    expect(dispatchRows(post), onRed).toEqual([]);
  }
}, 300_000);
