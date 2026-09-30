import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { approve } from "../../src/cli/commands/approve.js";
import { plan } from "../../src/cli/commands/plan.js";
import { resume } from "../../src/cli/commands/resume.js";
import { run } from "../../src/cli/commands/run.js";
import { graphDefinitionHash, loadGraph, saveGraph, setStatus, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { resetApprovalWindowForTests, runDaemon, setApprovalWindowForTests } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal, OWED_DISCHARGE_EVENT, type OwedCheck } from "../../src/run/journal.js";
import { COMMIT, authedModels, makeRepo, setupRepo, T } from "../helpers/tmprepo.js";

const FAKE_ONLY_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

const SINGLE_VENDOR_DOCTOR = {
  "claude-code": { installed: true, authed: true, models: [], modelAuth: authedModels(["fable", "opus", "sonnet", "haiku"]) },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

// OBS-147 (v1.79 T3): every run/resume test dispatches through the real daemon, so each carries
// an explicit 120s load-proof budget — the vitest default timeout is a real-time bound this
// suite does not control, and a starved release runner exceeded it on healthy runs.
describe("run/resume greenness exit contract", () => {
  afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; });

  test("all-green run summary exits 0 via dispatch", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const r = await run(["--concurrency", "1", "--driver", "subprocess"], repo);
    expect(r.out).toMatch(/finished/);
    expect(r.out).toMatch(/failed: 0/);
    expect(r.code).toBe(0);
  }, 120_000);

  test("a fresh run over an all-terminal graph refuses instead of minting a summary", async () => {
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: {} });
    saveGraph(repo, setStatus(loadGraph(repo), "T1", "failed"));
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    // Q150s (dossier GATE-FIX family): a run that can dispatch nothing must not journal a
    // run-end that reads as completion — it refuses, naming the counts and both remedies.
    // Failure exit taxonomy for runs that FINISH with failures is pinned by the sibling tests.
    await expect(run(["--driver", "subprocess"], repo)).rejects.toThrow(/nothing to dispatch[\s\S]*failed 1/);
  }, 120_000);

  test("run summary with a non-green parked task exits 2", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "echo fail && exit 1", result: { ok: false, summary: "boom" } }] } },
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const r = await run(["--driver", "subprocess"], repo);
    expect(r.out).toMatch(/finished/);
    expect(r.out).toMatch(/human: 1/);
    expect(r.code).toBe(2);
  }, 120_000);

  test("resume applies the same greenness exit contract as run", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    saveGraph(repo, setStatus(loadGraph(repo), "T1", "failed"));
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    const j = Journal.create(repo, "run-red");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "T1");
    j.append("task-failed", "T1", { error: "boom" });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));

    const r = await resume(["run-red"], repo);
    expect(r.out).toMatch(/resumed run-red/);
    expect(r.out).toMatch(/failed: 1/);
    expect(r.code).toBe(2);
  }, 120_000);
});

// CG2 (v2.6.4): the D-660 shape — every execution bucket empty, one accepted-risk check owed. The exit
// code stays execution-based (users' scripts read it); the final rail reads the CURRENT owed-check fold
// and says "verified" only when outstanding is empty AND known.
describe("CG2 debt-aware final rail", () => {
  afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; resetApprovalWindowForTests(); });

  /** T1's acceptance judge is red and the consult parks it: the one gate an operator waive can satisfy. */
  const judgeRedRepo = () => {
    const { repo, fake, scriptPath } = setupRepo(
      [T("T1", { acceptance: ["done", "the approved file exists"] })],
      {
        judge: { pass: false, criteria: [{ criterion: "c1", met: false, reason: "operator override required" }] },
        consult: { action: "human", notes: "operator must decide" },
        tasks: { T1: [{ shell: `echo approved > approved.txt && ${COMMIT} approved`, result: { ok: true, summary: "implemented" } }] },
      },
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;
    return { repo, fake };
  };
  const parked = async (runId: string) => {
    const { repo, fake } = judgeRedRepo();
    expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
    return repo;
  };
  const waive = (repo: string, runId: string) =>
    approve([runId, "T1", "--waive", "--by", "operator", "--reason", "D-660 accepts the judge red"], repo);
  const rail = (out: string) => out.split("\n").at(-1)!;

  test("run and resume return execution exit 0 for empty execution buckets despite one owed check; the final rail names 1 outstanding or unknown legacy debt rather than verified", async () => {
    // run: the operator waives inside the live run's approval window, through the real approve command.
    const { repo } = judgeRedRepo();
    setApprovalWindowForTests(120_000);
    let waived: Promise<string> | undefined;
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      if (waived === undefined && /approval.window/u.test(String(line))) waived = waive(repo, Journal.latestRunId(repo)!);
    });
    // the window closes with this run: the parks below must end their runs, not wait out 120 s each
    const ran = await run(["--driver", "subprocess"], repo).finally(() => { log.mockRestore(); resetApprovalWindowForTests(); });
    expect(await waived).toContain("owes acceptance check");
    expect(ran.code).toBe(0);
    expect(ran.out).toMatch(/done: 1, failed: 0, human: 0, blocked: 0, pending: 0/u);
    expect(rail(ran.out)).toBe("execution complete; outstanding 1 (T1 acceptance) — not green until outstanding is empty and known");
    expect(ran.out).not.toMatch(/^verified/mu);

    // resume: the same waive after the park, then an explicit resume.
    const owedRepo = await parked("run-cg2-owed");
    await waive(owedRepo, "run-cg2-owed");
    const resumed = await resume(["run-cg2-owed"], owedRepo);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toMatch(/done: 1, failed: 0, human: 0, blocked: 0, pending: 0/u);
    expect(rail(resumed.out)).toBe("execution complete; outstanding 1 (T1 acceptance) — not green until outstanding is empty and known");
    expect(resumed.out).not.toMatch(/^verified/mu);

    // a legacy waive (no obligation on the row) is debt nobody can count: unknown, never zero.
    const legacyRepo = await parked("run-cg2-legacy");
    const j = Journal.open(legacyRepo, "run-cg2-legacy");
    const events = j.read();
    const park = events.findLastIndex((e) => e.event === "task-human" && e.taskId === "T1");
    j.append("task-approved", "T1", { by: "operator", release: "gate-satisfied", gate: "acceptance", park: { line: park + 1, ts: events[park]!.ts } });
    const legacy = await resume(["run-cg2-legacy"], legacyRepo);
    expect(legacy.code).toBe(0);
    expect(rail(legacy.out)).toBe("execution complete; outstanding unknown (legacy waiver without an owed-check obligation) — not green until outstanding is empty and known");
    expect(legacy.out).not.toMatch(/^verified/mu);
  }, 240_000);

  test("run and resume retain partial failed and tip-failed outcomes while a current known empty debt fold permits green after discharge even though the old run-end record still carried debt", async () => {
    const notGreen = (out: string) => {
      expect(out).not.toMatch(/^verified/mu);
      expect(out).not.toContain("execution complete");
    };
    // partial: a human-gated task parks before dispatch.
    const partial = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
    writeDoctor(partial.repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = partial.scriptPath;
    const parkedRun = await run(["--driver", "subprocess"], partial.repo);
    expect(parkedRun.code).toBe(2);
    expect(parkedRun.out).toMatch(/human: 1/u);
    notGreen(parkedRun.out);

    // tip-failed: the task merges green and only the integration tip's command is red.
    const tip = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > task.txt && echo fail > tip.txt && ${COMMIT} work`, result: { ok: true, summary: "done" } }] } },
      "gates:\n  test: sh -c 'exit 0'\n  tipTest: sh -c 'test -f tip.txt && grep -q fail tip.txt && exit 1 || exit 0'\n",
    );
    writeDoctor(tip.repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = tip.scriptPath;
    const tipRun = await run(["--driver", "subprocess"], tip.repo);
    expect(tipRun.code).toBe(2);
    expect(tipRun.out).toMatch(/done: 1, failed: 0/u);
    expect(tipRun.out).toContain("tip verify: FAILED");
    notGreen(tipRun.out);

    // failed: resume keeps a failed task red.
    const failedRepo = setupRepo([T("T1")], { tasks: {} }).repo;
    saveGraph(failedRepo, setStatus(loadGraph(failedRepo), "T1", "failed"));
    writeDoctor(failedRepo, FAKE_ONLY_DOCTOR);
    const fj = Journal.create(failedRepo, "run-cg2-red");
    fj.append("run-start", undefined, { baseRef: await gitHead(failedRepo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(failedRepo)) });
    fj.append("task-dispatch", "T1");
    fj.append("task-failed", "T1", { error: "boom" });
    writeFileSync(join(fj.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    const red = await resume(["run-cg2-red"], failedRepo);
    expect(red.code).toBe(2);
    expect(red.out).toMatch(/failed: 1/u);
    notGreen(red.out);

    // discharge after run-end: the owed run ends execution-green with 1 outstanding ...
    const repo = await parkedWithWaive();
    const owed = await resume(["run-cg2-discharge"], repo);
    expect(owed.code).toBe(0);
    expect(rail(owed.out)).toContain("outstanding 1 (T1 acceptance)");
    const j = Journal.open(repo, "run-cg2-discharge");
    const o = j.read().find((e) => e.event === "task-approved")!.data.obligation as OwedCheck;
    // ... then verify --record's hash-bound proof of the exact waived range lands after that run-end.
    const artifact = Buffer.from(JSON.stringify({ base: o.base, head: o.head, mergeBase: o.base, green: true, files: o.files, criteria: o.criteria, gateRows: [{ gate: "acceptance", pass: true }] }));
    const artifactPath = join(j.dir, "verify-results.json");
    writeFileSync(artifactPath, artifact);
    j.append(OWED_DISCHARGE_EVENT, "T1", {
      ids: [o.id], gates: [o.gate], mapping: "exact", mergeBase: o.base, head: o.head, criteria: o.criteria,
      artifactPath, artifactSha256: createHash("sha256").update(artifact).digest("hex"), authorChannels: [],
    });
    const green = await resume(["run-cg2-discharge"], repo);
    expect(green.code).toBe(0);
    expect(rail(green.out)).toBe("verified — execution complete, outstanding 0");
    // the old run-end record is history: it still carries the debt the discharge later paid.
    const ends = j.read().filter((e) => e.event === "run-end");
    expect(ends.length).toBeGreaterThanOrEqual(2);
    expect(ends.at(-2)!.data.owedChecks).toMatchObject({ known: true, debt: 1 });
  }, 240_000);

  const parkedWithWaive = async () => {
    const repo = await parked("run-cg2-discharge");
    await waive(repo, "run-cg2-discharge");
    return repo;
  };
});

describe("run --concurrency validation", () => {
  test("refuses zero, negative, and non-numeric values before dispatch", async () => {
    const repo = makeRepo({ "a.txt": "x" });
    for (const bad of [["--concurrency", "0"], ["--concurrency", "foo"], ["--concurrency=-5"]]) {
      await expect(run(bad, repo)).rejects.toThrow(/positive integer/);
      expect(existsSync(join(tickmarkrDir(repo), "runs"))).toBe(false);
    }
  });
});

describe("plan review fleet lint", () => {
  test("single-vendor fleet under review.required names the waiver", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
    }));
    writeDoctor(repo, SINGLE_VENDOR_DOCTOR);
    const out = await plan([], repo);
    expect(out).toContain("routing lints:");
    expect(out).toMatch(/review:.*cross-vendor reviewer pair/);
    expect(out).toContain("review.required: false");
  });
});
