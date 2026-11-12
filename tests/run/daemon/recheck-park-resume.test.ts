// Queue row 413 (D-2187 add.151): a recheck's recorded disposition is in force from its decision row until the
// first settlement. Each case runs a recheck live through runDaemon, cuts the journal at the named boundary (the
// crash), and resumes through runDaemon. Zero tokens: fake adapter, subprocess driver, scripted gate commands.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { shq } from "../../../src/adapters/types.js";
import { approve, newestPark, readJournalEvents } from "../../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { formatOwnedName } from "../../../src/drivers/types.js";
import * as gates from "../../../src/gates/run-gates.js";
import type { GateResult } from "../../../src/gates/types.js";
import { graphDefinitionHash, loadGraph } from "../../../src/graph/graph.js";
import { resetApprovalWindowForTests, runDaemon, setApprovalWindowForTests } from "../../../src/run/daemon.js";
import { gitHead, worktreePath } from "../../../src/run/git.js";
import { Journal, RECHECK_RELEASE, type JournalEvent } from "../../../src/run/journal.js";
import { recheckParkInForce } from "../../../src/run/recheck-disposition.js";
import * as stall from "../../../src/run/stall.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

beforeEach(() => setApprovalWindowForTests(1));
afterEach(() => { resetApprovalWindowForTests(); vi.restoreAllMocks(); });

const rows = (repo: string, runId: string) => Journal.open(repo, runId).read();
const afterResume = (all: JournalEvent[]): JournalEvent[] => all.slice(all.map((e) => e.event).lastIndexOf("run-resume") + 1);
const of = (evs: JournalEvent[], event: string) => evs.filter((e) => e.event === event && e.taskId === "T1");
const DISPATCH_ROWS = ["task-dispatch", "repair-attempt", "repair-dispatch", "worker-launch"];
const dispatchRows = (evs: JournalEvent[]) => evs.filter((e) => e.taskId === "T1" && DISPATCH_ROWS.includes(e.event));
const MATERIAL = { approve: false, findings: [{ note: "`t1.txt` line 1 says one where the spec wants two", severity: "material" }] };

type RepoOpts = { judgePass?: boolean; review?: object; config?: string; tasks?: object };
/** One task whose test gate is red once t1.txt lands unless `flag` exists; the first run parks (consult → human). */
const redRepo = (opts: RepoOpts = {}) => {
  const flag = join(makeTestTempDir("tickmarkr-recheck-resume-"), "green");
  const judgePass = opts.judgePass ?? true;
  const { repo, fake } = setupRepo(
    [T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "acceptance", ...(opts.review ? ["review"] : [])],
      ...(opts.review ? { complexity: 8 } : {}), ...opts.tasks })],
    {
      ...(opts.review ? { review: opts.review } : {}),
      judge: { pass: judgePass, criteria: [{ criterion: "c1", met: judgePass, reason: judgePass ? "ok" : "t1.txt:1 still wrong" }] },
      consult: { action: "human", notes: "operator decides" },
      tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] },
    },
    `gates: { build: 'true', test: ${shq(`[ ! -f t1.txt ] || [ -f ${flag} ]`)}, lint: 'true' }\n${opts.config ?? ""}`,
  );
  return { repo, fake, flag };
};

/** The crash: the journal keeps rows [0, index] and nothing after reached the ledger. */
const cutAfter = (repo: string, runId: string, index: number) => {
  const j = Journal.open(repo, runId);
  writeFileSync(join(j.dir, "journal.jsonl"), j.read().slice(0, index + 1).map((e) => JSON.stringify(e)).join("\n") + "\n");
};
const lastIndex = (evs: JournalEvent[], pred: (e: JournalEvent) => boolean) => evs.map(pred).lastIndexOf(true);

/** Park, approve a recheck (`onRed` flag, or a hand-written row with none), and run that recheck live to its end. */
const liveRecheck = async (runId: string, onRed: "park" | "repair" | "unrecorded", opts: RepoOpts & {
  narrate?: (repo: string, flag: string) => (e: JournalEvent) => void; green?: boolean; beforeRecheck?: () => void; setup?: () => ReturnType<typeof redRepo>;
} = {}) => {
  const { repo, fake, flag } = opts.setup ? opts.setup() : redRepo(opts);
  expect((await runDaemon(repo, { adapters: [fake], runId })).human, runId).toEqual(["T1"]);
  if (opts.green) writeFileSync(flag, "green\n");
  opts.beforeRecheck?.();
  if (onRed === "unrecorded") {
    const { events, sourceIndexes } = readJournalEvents(Journal.open(repo, runId));
    const p = newestPark(events, "T1", sourceIndexes)!;
    Journal.open(repo, runId).append("task-approved", "T1", { by: "op", via: "cli", release: RECHECK_RELEASE, park: { line: p.line, ts: p.ts }, failedGate: "test" });
  } else {
    await approve([runId, "T1", "--recheck", "--on-red", onRed, "--by", "op"], repo);
  }
  await runDaemon(repo, { adapters: [fake], runId, resume: true, ...(opts.narrate ? { narrate: opts.narrate(repo, flag) } : {}) });
  return { repo, fake, flag };
};
const resume = async (repo: string, fake: ReturnType<typeof setupRepo>["fake"], runId: string, extra: { retryFailed?: true } = {}) => {
  await runDaemon(repo, { adapters: [fake], runId, resume: true, ...extra });
  return afterResume(rows(repo, runId));
};

/** The resumed park: gate-fail on `gate`, no second battery row, and no dispatch row. */
const expectResumedPark = (post: JournalEvent[], gate: string, runId: string) => {
  const parks = of(post, "task-human");
  expect(parks.map((e) => e.data.kind), runId).toEqual(["gate-fail"]);
  expect(parks[0]!.data.firstRedGate, runId).toBe(gate);
  expect(parks[0]!.data.reason, runId).toContain(`recheck red on ${gate}`);
  expect(of(post, "recheck-battery"), runId).toEqual([]);
  expect(dispatchRows(post), runId).toEqual([]);
};

test("a park recheck resumed after its red battery or its red regate parks on the first red gate and writes no dispatch row", async () => {
  // ---- the journal ends right after the red recheck-battery, before any park row -------------------------
  {
    const runId = "run-resume-after-battery";
    const { repo, fake } = await liveRecheck(runId, "park");
    const all = rows(repo, runId);
    const battery = lastIndex(all, (e) => e.taskId === "T1" && e.event === "recheck-battery");
    expect(all[battery]!.data.pass).toBe(false);
    cutAfter(repo, runId, battery);
    // the approval the battery consumed is gone; the fold still holds the park disposition
    expect(recheckParkInForce(rows(repo, runId), "T1")).toBe(true);
    expectResumedPark(await resume(repo, fake, runId), "test", runId);
    expect(recheckParkInForce(rows(repo, runId), "T1")).toBe(false);
  }
  // ---- first battery green, the tip moves once before merge, the regate is red; the journal ends there ----
  {
    const runId = "run-resume-after-regate";
    let moved = false;
    const { repo, fake } = await liveRecheck(runId, "park", {
      green: true,
      narrate: (repo, flag) => (e) => {
        if (moved || e.taskId !== "T1" || e.event !== "recheck-battery") return;
        moved = true;
        const wt = worktreePath(repo, `tickmarkr/${runId}--T1`);
        execFileSync("rm", ["-f", flag]);
        writeFileSync(join(wt, "t1.txt"), "two\n");
        execFileSync("sh", ["-c", `git add -A && ${COMMIT} moved`], { cwd: wt });
      },
    });
    expect(moved).toBe(true);
    const all = rows(repo, runId);
    expect(of(all, "recheck-battery").at(-1)!.data.pass).toBe(true);
    expect(of(all, "tip-moved")).toHaveLength(1);
    const regateRed = lastIndex(all, (e) => e.taskId === "T1" && e.event === "gate-result" && e.data.pass === false);
    expect(regateRed).toBeGreaterThan(lastIndex(all, (e) => e.taskId === "T1" && e.event === "tip-moved"));
    cutAfter(repo, runId, regateRed);
    expectResumedPark(await resume(repo, fake, runId), "test", runId);
  }
}, 300_000);

/** Rewrites each gate result as it ends (before the daemon journals it) while `rewrite` is set. */
let rewrite: ((r: GateResult) => void) | undefined;
const rewriteGates = () => {
  const original = gates.runGates;
  vi.spyOn(gates, "runGates").mockImplementation((task, ctx, ...rest) => original(task, {
    ...ctx,
    onGate: async (event) => {
      if (event.phase === "end" && rewrite) rewrite(event.result);
      await ctx.onGate?.(event);
    },
  }, ...rest));
};
const cutAfterBattery = (repo: string, runId: string) => {
  const all = rows(repo, runId);
  const battery = lastIndex(all, (e) => e.taskId === "T1" && e.event === "recheck-battery");
  expect(all[battery]?.data.pass, runId).toBe(false);
  cutAfter(repo, runId, battery);
  expect(recheckParkInForce(rows(repo, runId), "T1"), runId).toBe(true);
};
/** The base park of `kind` after the resume, with no dispatch row and no generic recheck gate-fail. */
const expectBasePark = (post: JournalEvent[], kind: string, runId: string) => {
  const parks = of(post, "task-human");
  expect(parks.map((e) => e.data.kind), runId).toEqual([kind]);
  expect(parks[0]!.data.firstRedGate, runId).toBeUndefined();
  expect(String(parks[0]!.data.reason), runId).not.toContain("recheck red on");
  expect(dispatchRows(post), runId).toEqual([]);
  return parks[0]!;
};

test("a resumed park recheck keeps the base park for a diff cap a collateral scope red or an infra review row", async () => {
  // ---- the journal ends after a red diff-cap battery -------------------------------------------------------
  {
    const runId = "run-resume-diff-cap";
    const { repo, fake } = await liveRecheck(runId, "park", { setup: () => {
      const { repo, fake } = setupRepo([T("T1", { files: ["t1.txt"] })],
        { tasks: { T1: [{ shell: `head -c 3000 /dev/zero | tr '\\0' 'x' > t1.txt && ${COMMIT} big`, result: { ok: true, summary: "big" } }] } },
        "gates: { diffCap: 500 }\n");
      return { repo, fake, flag: "" };
    } });
    cutAfterBattery(repo, runId);
    const park = expectBasePark(await resume(repo, fake, runId), "diff-cap", runId);
    expect(String(park.data.reason)).toMatch(/diff exceeds verifiable cap/);
  }
  // ---- the journal ends after a predicted collateral scope red ---------------------------------------------
  {
    const runId = "run-resume-collateral";
    rewriteGates();
    const predicted = (r: GateResult) => {
      if (r.gate !== "scope") return;
      r.pass = false;
      r.details = "out of scope: outside.txt";
      r.meta = { ...r.meta, collateral: { authoring: true, predicted: ["outside.txt"], missed: [], repair: "own outside.txt" } };
    };
    const { repo, fake } = await liveRecheck(runId, "park", { beforeRecheck: () => { rewrite = predicted; } }); // the recheck's battery is the first to see it
    expect(of(rows(repo, runId), "task-human").at(-1)!.data.kind).toBe("authoring");
    cutAfterBattery(repo, runId);
    expectBasePark(await resume(repo, fake, runId), "authoring", runId);
    rewrite = undefined;
    vi.restoreAllMocks();
  }
  // ---- acceptance red beside an infra review row with no pass field; the journal ends there ----------------
  {
    const runId = "run-resume-infra-review";
    rewriteGates();
    const infraReview = (r: GateResult) => {
      if (r.gate !== "review") return;
      delete (r as { pass?: boolean }).pass;
      r.details = "review: no eligible reviewer answered";
      r.meta = { ...r.meta, infra: true, classification: "infra" };
    };
    const { repo, fake } = await liveRecheck(runId, "park", { green: true, judgePass: false, review: MATERIAL, beforeRecheck: () => { rewrite = infraReview; } });
    const all = rows(repo, runId);
    const battery = lastIndex(all, (e) => e.taskId === "T1" && e.event === "recheck-battery");
    const round = all.slice(lastIndex(all.slice(0, battery), (e) => e.event === "task-approved"), battery);
    expect(of(round, "gate-result").find((e) => e.data.gate === "acceptance")?.data.pass).toBe(false);
    expect(of(round, "gate-result").find((e) => e.data.gate === "review")?.data).not.toHaveProperty("pass");
    cutAfterBattery(repo, runId);
    expectBasePark(await resume(repo, fake, runId), "infra", runId);
    rewrite = undefined;
  }
}, 300_000);

test("a park recheck resumed before its battery row completes the battery under the same disposition", async () => {
  const runId = "run-resume-before-battery";
  const { repo, fake } = await liveRecheck(runId, "park");
  const all = rows(repo, runId);
  const decisionRow = lastIndex(all, (e) => e.taskId === "T1" && e.event === "task-approved");
  const battery = lastIndex(all, (e) => e.taskId === "T1" && e.event === "recheck-battery");
  // some of the battery's gate results are journaled, the battery row is not
  const firstResult = all.findIndex((e, i) => i > decisionRow && e.taskId === "T1" && e.event === "gate-result");
  expect(firstResult).toBeGreaterThan(decisionRow);
  expect(firstResult).toBeLessThan(battery);
  cutAfter(repo, runId, firstResult);
  expect(recheckParkInForce(rows(repo, runId), "T1")).toBe(true);
  const post = await resume(repo, fake, runId);
  expect(of(post, "recheck-battery").map((e) => e.data.pass)).toEqual([false]);
  const parks = of(post, "task-human");
  expect(parks.map((e) => e.data.kind)).toEqual(["gate-fail"]);
  expect(parks[0]!.data.firstRedGate).toBe("test");
  expect(dispatchRows(post)).toEqual([]);
}, 300_000);

/** A stall park that recorded a reapFailure over finished work whose test gate is red (OBS-1202's shape). */
const stallPark = async (runId: string) => {
  const reapFailure = "worker group 4242 cleanup unknown";
  const fake2 = { adapter: "fake", model: "fake-2", channel: "api" as const, tier: "frontier" as const };
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{ shell: `echo redo > redo.txt && ${COMMIT} redo`, result: { ok: true, summary: "redone" } }] } },
    `gates: { build: 'true', test: ${shq("[ ! -f harvest.txt ]")}, lint: 'true' }\n`);
  const base = await gitHead(repo);
  const wt = await new SubprocessDriver().worktree(repo, `tickmarkr/${runId}--T1`, base);
  writeFileSync(join(wt, "harvest.txt"), "finished before the park\n");
  execFileSync("sh", ["-c", `${COMMIT} finished`], { cwd: wt });
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

test("a repair or unrecorded disposition resumes into the base repair while an uphold or a retried failure ends the park", async () => {
  // ---- onRed repair, and a decision row with no onRed: the journal ends after the red battery; a repair is funded
  for (const onRed of ["repair", "unrecorded"] as const) { // each a control: the fold reads no park
    const runId = `run-resume-${onRed}`;
    const { repo, fake } = await liveRecheck(runId, onRed);
    const all = rows(repo, runId);
    const battery = lastIndex(all, (e) => e.taskId === "T1" && e.event === "recheck-battery");
    expect(all[battery]!.data.pass, onRed).toBe(false);
    cutAfter(repo, runId, battery);
    expect(recheckParkInForce(rows(repo, runId), "T1"), onRed).toBe(false);
    const post = await resume(repo, fake, runId);
    expect(of(post, "task-dispatch").length + of(post, "repair-attempt").length, onRed).toBeGreaterThanOrEqual(1);
    expect(of(post, "task-human").every((e) => e.data.firstRedGate === undefined), onRed).toBe(true);
  }
  // ---- park in force, the park is written, then approve --uphold: the repair the uphold funds is dispatched
  {
    const runId = "run-resume-uphold";
    const { repo, fake } = await liveRecheck(runId, "park", { green: true, review: MATERIAL });
    const park = of(rows(repo, runId), "task-human").at(-1)!;
    expect(park.data.firstRedGate).toBe("review");
    expect(recheckParkInForce(rows(repo, runId), "T1")).toBe(false);
    await approve([runId, "T1", "--uphold", "--by", "op"], repo);
    expect(recheckParkInForce(rows(repo, runId), "T1")).toBe(false);
    const post = await resume(repo, fake, runId);
    expect(of(post, "task-dispatch").length).toBeGreaterThanOrEqual(1);
  }
  // ---- a stall recheck whose battery throws before any red gate result: task-failed (dispatch kind), then
  // resume --retry-failed is the base retry dispatch
  {
    const runId = "run-resume-retry-failed";
    const { repo, fake } = await stallPark(runId);
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    expect(recheckParkInForce(rows(repo, runId), "T1")).toBe(true);
    vi.spyOn(stall, "reapOwnedProcessGroup").mockResolvedValue([]);
    const battery = vi.spyOn(gates, "runGates").mockRejectedValue(new Error("battery interrupted before any gate"));
    await runDaemon(repo, { adapters: [fake], runId, resume: true, driver: new SubprocessDriver() });
    expect(battery).toHaveBeenCalled();
    battery.mockRestore();
    const failed = of(rows(repo, runId), "task-failed");
    expect(failed).toHaveLength(1);
    expect(of(afterResume(rows(repo, runId)), "gate-result").filter((e) => e.data.pass === false)).toEqual([]);
    expect(recheckParkInForce(rows(repo, runId), "T1")).toBe(false);
    // the retry re-runs the unconsumed recheck under the base: its red funds a worker, never a park
    const post = await resume(repo, fake, runId, { retryFailed: true });
    expect(of(post, "task-dispatch").length).toBeGreaterThanOrEqual(1);
    expect(of(post, "task-human").every((e) => e.data.firstRedGate === undefined)).toBe(true);
  }
}, 300_000);
