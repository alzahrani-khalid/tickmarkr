import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import * as gateRunner from "../../../src/gates/run-gates.js";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../../src/adapters/types.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import { graphDefinitionHash, loadGraph, saveGraph, tickmarkrDir } from "../../../src/graph/graph.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal, repairsSinceApproval, type JournalEvent } from "../../../src/run/journal.js";
import { authedModels, COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const redJudge = { pass: false, criteria: [{ criterion: "c1", met: false, reason: "work.txt still contains the broken rule" }] };
const greenJudge = { pass: true, criteria: [{ criterion: "c1", met: true, reason: "work.txt now implements the rule" }] };
const UPHELD = "work.txt must apply the configured limit to every row";
const funding = (rows: JournalEvent[]) => rows.filter((e) => e.event === "repair-attempt");
const dispatches = (rows: JournalEvent[]) => rows.filter((e) => e.event === "task-dispatch");
const prompt = (repo: string, runId: string, attempt: number) => readFileSync(join(tickmarkrDir(repo), "runs", runId, "prompts", `T1-a${attempt}.md`), "utf8");

// A separate vendor remains independent of every worker whose patches the carry contains.
class Reviewer extends FakeAdapter {
  override id = "repair-review";
  override vendor = "repair-review-vendor";
  green = true;
  conditional = false;
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
  override headlessCommand(file: string): string {
    const text = readFileSync(file, "utf8");
    const prior = [...text.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]);
    const approve = this.conditional ? text.includes("+fixed") : this.green;
    return `printf '%s\\n' ${shq(JSON.stringify({ nonce: extractPromptNonce(text), approve,
      resolved: approve ? prior : [], reraised: approve ? [] : prior,
      findings: approve ? [] : [{ note: UPHELD, severity: "material" }],
    }))}`;
  }
}
const cfg = "approvalWindowMs: 1\nreview: { prefer: [repair-review:repair-review] }\nrouting: { escalateTier: off, deny: { workers: { adapters: [repair-review] } } }\n";

function ordinary(judge: unknown, mixed = false, oracle = false) {
  const f = setupRepo([T("T1", { complexity: mixed ? 8 : 3, files: ["work.txt"],
    ...(oracle ? { acceptance: [{ oracle: "command", command: "cat work.txt; grep -q fixed work.txt" }] } : {}),
  })], {
    judge,
    consult: { action: "human", notes: "bounded fixture" },
    tasks: { T1: [
      { shell: `echo broken > work.txt && ${COMMIT} broken`, result: { ok: true, summary: "landed" } },
      { shell: `echo fixed > work.txt && ${COMMIT} fixed`, result: { ok: true, summary: "repaired" } },
    ] },
  }, cfg);
  const reviewer = new Reviewer(f.scriptPath);
  reviewer.conditional = mixed;
  return { ...f, reviewer };
}

test("the production daemon funds a repair with the class contract for a judged acceptance red over landed commits whose unmet criterion cites a path, while a parsed judged red with no recorded judgment dispatches fresh and an unreadable judge verdict still parks infrastructure without a repair, so a judged red that buys a fresh worker fails", async () => {
  for (const kind of ["judged", "inconsistent", "unreadable"] as const) {
    const first = kind === "judged" ? redJudge : kind === "inconsistent"
      ? { ...redJudge, criteria: [{ criterion: "unknown", met: false, reason: "work.txt needs correction" }] }
      : "unreadable verdict";
    const f = ordinary(kind === "unreadable" ? first : [first, greenJudge]);
    let judgeCalls = 0;
    for (const adapter of [f.fake, f.reviewer] as FakeAdapter[]) {
      const headless = adapter.headlessCommand.bind(adapter);
      adapter.headlessCommand = (file, model) => {
        if (readFileSync(file, "utf8").startsWith("TICKMARKR-JUDGE")) judgeCalls++;
        return headless(file, model);
      };
    }
    const runId = `run-admit-${kind}`;
    const summary = await runDaemon(f.repo, { adapters: [f.fake, f.reviewer], runId });
    const rows = Journal.open(f.repo, runId).read();
    if (kind === "judged") {
      expect(summary.done).toEqual(["T1"]);
      expect(funding(rows)).toHaveLength(1);
      expect(funding(rows)[0]!.data).toMatchObject({ gates: ["acceptance"], contract: "class", commits: 1 });
      expect(dispatches(rows).map((e) => e.data.retryMode)).toEqual(["fresh", "repair"]);
      const judgment = rows.find((e) => e.event === "gate-result" && e.data.gate === "acceptance" && e.data.pass === false)!.data.judgment;
      expect(judgment).toMatchObject({ criteria: [{ met: false, paths: ["work.txt"] }] });
      expect(prompt(f.repo, runId, 1)).toContain("### Repair contract — the whole input class");
      expect(prompt(f.repo, runId, 1)).toContain("+broken");
    } else {
      expect(funding(rows)).toHaveLength(0);
      if (kind === "inconsistent") {
        expect(summary.done).toEqual(["T1"]);
        expect(dispatches(rows).map((e) => e.data.retryMode)).toEqual(["fresh", "fresh"]);
        expect(rows.find((e) => e.event === "gate-result" && e.data.gate === "acceptance" && e.data.pass === false)!.data.judgment).toBeUndefined();
      } else {
        expect(summary.human).toEqual(["T1"]);
        expect(dispatches(rows)).toHaveLength(1);
        expect(rows.find((e) => e.event === "task-human")!.data.kind).toBe("infra");
        expect(rows.find((e) => e.event === "gate-result" && e.data.gate === "acceptance")!.data).toMatchObject({ infra: true });
        expect(judgeCalls).toBe(2);
      }
    }
  }
}, 90_000);

test("the production daemon funds exactly one repair carrying both findings for a round red on acceptance and on review, judged or oracle alike, while a round red on scope and on review dispatches fresh, so a battery that drops the review or funds two repairs fails", async () => {
  for (const replay of [false, true]) for (const oracle of [false, true]) {
    const f = ordinary([redJudge, greenJudge], true, oracle);
    const runId = `run-pair-${oracle}-${replay}`;
    let before = 0;
    if (replay) {
      const baseRef = git(f.repo, "rev-parse", "HEAD");
      const wt = await new SubprocessDriver().worktree(f.repo, `tickmarkr/${runId}--T1`, baseRef);
      writeFileSync(join(wt, "work.txt"), "broken\n");
      git(wt, "add", "work.txt");
      git(wt, "commit", "--no-gpg-sign", "-qm", "landed");
      const j = Journal.create(f.repo, runId);
      j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(f.repo)) });
      j.append("task-dispatch", "T1", { base: baseRef, attempt: 0, assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } });
      j.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [] });
      j.append("gate-result", "T1", { gate: "review", pass: false, details: UPHELD });
      j.append("task-human", "T1", { kind: "gate-fail", reason: "recheck this subject" });
      writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
      await approve([runId, "T1", "--recheck"], f.repo);
      before = j.read().length;
      const script = JSON.parse(readFileSync(f.scriptPath, "utf8"));
      script.tasks.T1.shift();
      writeFileSync(f.scriptPath, JSON.stringify(script));
      f.fake = new FakeAdapter(f.scriptPath);
    }
    expect((await runDaemon(f.repo, { adapters: [f.fake, f.reviewer], runId, resume: replay })).done).toEqual(["T1"]);
    const rows = Journal.open(f.repo, runId).read().slice(before);
    expect(funding(rows)).toHaveLength(1);
    expect(funding(rows)[0]!.data).toMatchObject({ gates: ["acceptance", "review"], contract: "class" });
    const brief = String(funding(rows)[0]!.data.findings);
    expect(brief).toContain("acceptance:");
    expect(brief).toContain(`review:`);
    expect(brief).toContain(UPHELD);
    expect(dispatches(rows).map((e) => e.data.retryMode)).toEqual(replay ? ["repair"] : ["fresh", "repair"]);
    const repaired = dispatches(rows).at(-1)!;
    expect(prompt(f.repo, runId, Number(repaired.data.attempt))).toContain(UPHELD);
    expect(prompt(f.repo, runId, Number(repaired.data.attempt))).toContain("+broken");
  }
  // A real scope violation never qualifies for repair, even with an outstanding review red.
  const f = ordinary([greenJudge, greenJudge], true);
  const graph = loadGraph(f.repo);
  graph.tasks[0]!.files = ["other.txt"];
  saveGraph(f.repo, graph);
  const runId = "run-scope-review";
  const j = Journal.create(f.repo, runId);
  j.append("run-start", undefined, { baseRef: git(f.repo, "rev-parse", "HEAD"), commands: {}, graphDefinitionHash: graphDefinitionHash(graph) });
  j.append("gate-result", "T1", { gate: "review", pass: false, details: UPHELD });
  writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  const original = gateRunner.runGates;
  const mixed = vi.spyOn(gateRunner, "runGates").mockImplementation(async (task, ctx) => {
    const round = await original(task, ctx);
    if (!round.results.some((g) => g.gate === "scope" && !g.pass)) return round;
    const review = { gate: "review", pass: false, details: UPHELD };
    await ctx.onGate?.({ phase: "end", gate: "review", result: review });
    return { ...round, results: [...round.results, review] };
  });
  try { await runDaemon(f.repo, { adapters: [f.fake, f.reviewer], runId, resume: true }); }
  finally { mixed.mockRestore(); }
  const rows = j.read();
  expect(rows.some((e) => e.event === "gate-result" && e.data.gate === "scope" && e.data.pass === false)).toBe(true);
  expect(funding(rows)).toHaveLength(0);
  expect(dispatches(rows).every((e) => e.data.retryMode === "fresh")).toBe(true);
}, 90_000);

test("test and lint repairs keep the instance contract when review is excluded from the repair battery, including on recheck", async () => {
  for (const replay of [false, true]) for (const gate of ["test", "lint"] as const) {
    const command = "test ! -f work.txt || grep -q fixed work.txt";
    const f = setupRepo([T("T1", { files: ["work.txt"], complexity: 3,
      acceptance: [{ oracle: "command", command: "true" }],
    })], {
      consult: { action: "human", notes: "bounded fixture" },
      tasks: { T1: [
        ...(!replay ? [{ shell: `echo broken > work.txt && ${COMMIT} broken`, result: { ok: true, summary: "landed" } }] : []),
        { shell: `echo fixed > work.txt && ${COMMIT} fixed`, result: { ok: true, summary: "repaired" } },
      ] },
    }, `gates: { ${gate}: ${JSON.stringify(command)} }\napprovalWindowMs: 1\n`);
    const runId = `run-instance-${gate}-${replay}`;
    if (replay) {
      const baseRef = git(f.repo, "rev-parse", "HEAD");
      const wt = await new SubprocessDriver().worktree(f.repo, `tickmarkr/${runId}--T1`, baseRef);
      writeFileSync(join(wt, "work.txt"), "broken\n");
      git(wt, "add", "work.txt");
      git(wt, "commit", "--no-gpg-sign", "-qm", "landed");
      const j = Journal.create(f.repo, runId);
      j.append("run-start", undefined, { baseRef, commands: { [gate]: command }, graphDefinitionHash: graphDefinitionHash(loadGraph(f.repo)) });
      j.append("task-dispatch", "T1", { base: baseRef, attempt: 0, assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } });
      j.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [] });
      j.append("gate-result", "T1", { gate: "review", pass: false, details: UPHELD });
      j.append("task-human", "T1", { kind: "gate-fail", reason: "recheck this subject" });
      writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
      await approve([runId, "T1", "--recheck"], f.repo);
    }
    // Supply a mixed round at the gate boundary, retaining the real test/lint red.
    const original = gateRunner.runGates;
    const mixed = vi.spyOn(gateRunner, "runGates").mockImplementation(async (task, ctx) => {
      const round = await original(task, ctx);
      if (!round.results.some((g) => g.gate === gate && !g.pass)) return round;
      const review = { gate: "review", pass: false, details: UPHELD };
      await ctx.onGate?.({ phase: "end", gate: "review", result: review });
      return { ...round, results: [...round.results.filter((g) => g.gate !== "review"), review] };
    });
    try { await runDaemon(f.repo, { adapters: [f.fake], runId, resume: replay }); }
    finally { mixed.mockRestore(); }
    const rows = Journal.open(f.repo, runId).read();
    expect(rows.some((e) => e.event === "gate-result" && e.data.gate === "review" && e.data.pass === false)).toBe(true);
    expect(funding(rows)).toHaveLength(1);
    expect(funding(rows)[0]!.data).toMatchObject({ contract: "instance", gates: expect.arrayContaining([gate, "review"]) });
    const repair = dispatches(rows).find((e) => e.data.retryMode === "repair")!;
    const brief = prompt(f.repo, runId, Number(repair.data.attempt));
    expect(brief).toContain("## Repair attempt — fix ONLY what these findings name");
    expect(brief).not.toContain("### Repair contract — the whole input class");
  }
}, 90_000);

async function upheldFixture(lost = false) {
  const runId = `run-uphold-${lost}`;
  const f = setupRepo([T("T1", { files: ["work.txt"], complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })], {
    consult: { action: "human", notes: "stop after budget" },
    tasks: { T1: [{ shell: `echo fixed >> work.txt && ${COMMIT} fix`, result: { ok: true, summary: "fixed" } }] },
  }, cfg);
  const baseRef = git(f.repo, "rev-parse", "HEAD");
  const branch = `tickmarkr/${runId}`;
  const wt = await new SubprocessDriver().worktree(f.repo, `${branch}--T1`, baseRef);
  writeFileSync(join(wt, "work.txt"), "broken\n");
  git(wt, "add", "work.txt");
  git(wt, "commit", "--no-gpg-sign", "-qm", "landed");
  const j = Journal.create(f.repo, runId);
  j.append("run-start", undefined, { baseRef, branch, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(f.repo)) });
  j.append("task-dispatch", "T1", { base: baseRef, attempt: 0, assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } });
  j.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [] });
  for (let n = 1; n <= 2; n++) {
    j.append("repair-attempt", "T1", { repair: n, gates: ["review"], findings: `review: ${UPHELD}` });
    j.append("worker-launch", "T1", {});
    j.phaseStart("T1", "gates");
    j.append("gate-result", "T1", { gate: "review", pass: false, details: UPHELD });
  }
  j.append("repair-exhausted", "T1", { repairs: 2, of: 2, gates: ["review"] });
  j.append("task-human", "T1", { kind: "gate-fail", reason: "repair budget spent" });
  writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  expect(repairsSinceApproval(j.read(), "T1")).toBe(2);
  if (lost) {
    const sibling = join(makeTestTempDir("uphold-sibling-"), "wt");
    git(f.repo, "worktree", "add", "--detach", sibling, baseRef);
    writeFileSync(join(sibling, "work.txt"), "conflicting sibling\n");
    git(sibling, "add", "work.txt");
    git(sibling, "commit", "--no-gpg-sign", "-qm", "sibling");
    const head = git(sibling, "rev-parse", "HEAD");
    git(f.repo, "update-ref", `refs/heads/${branch}`, head);
    j.append("merge", "T0", { from: baseRef, commit: head, branch: `${branch}--T0` });
    git(f.repo, "worktree", "remove", "--force", sibling);
  }
  await approve([runId, "T1", "--uphold", "--review-rounds", "10"], f.repo);
  const reviewer = new Reviewer(f.scriptPath);
  return { ...f, runId, j, reviewer, before: j.read().length };
}

test("the production daemon dispatches an uphold released after the repair budget was spent as a repair carrying the upheld sentence once and the diff, while the same uphold over a worktree that lost a landed commit dispatches fresh, so an upheld attempt without the diff fails", async () => {
  for (const lost of [false, true]) {
    const f = await upheldFixture(lost);
    expect((await runDaemon(f.repo, { adapters: [f.fake, f.reviewer], runId: f.runId, resume: true })).done).toEqual(["T1"]);
    const rows = f.j.read().slice(f.before);
    const dispatch = dispatches(rows)[0]!;
    const brief = prompt(f.repo, f.runId, Number(dispatch.data.attempt));
    expect(brief.split(UPHELD)).toHaveLength(2);
    expect(brief.match(/The operator UPHELD/g)).toHaveLength(1);
    expect(dispatch.data.retryMode).toBe(lost ? "fresh" : "repair");
    expect(rows.find((e) => e.event === "worker-launch")!.data.retryMode).toBe(lost ? "fresh" : "repair");
    if (lost) {
      expect(funding(rows)).toHaveLength(0);
      expect(rows.find((e) => e.event === "repair-cancelled")!.data.reason).toBe("carry incomplete");
      expect(brief).not.toContain("## Repair attempt");
    } else {
      expect(funding(rows)).toHaveLength(1);
      expect(brief).toContain("## Repair attempt");
      expect(brief).toContain("diff --git a/work.txt b/work.txt");
      expect(brief).toContain("+broken");
    }
  }
}, 90_000);

test("the repair an uphold funds records the class contract and the review gate and is the first repair of the new engagement, so one more repair follows its red and the next red is repair-exhausted, also across a resume, so a repair funded twice from one uphold or charged nowhere fails", async () => {
  for (const resume of [false, true]) {
    const f = await upheldFixture();
    f.reviewer.green = false;
    const inner = new SubprocessDriver();
    let launches = 0;
    const delivered: string[] = [];
    // Stop after the first charged battery funds its successor. That intent must survive resume.
    const driver = Object.assign(inner, { run: async (slot: Parameters<SubprocessDriver["run"]>[0], command: string) => {
      if (slot.name.includes("-worker-")) {
        const current = dispatches(f.j.read()).at(-1)!;
        delivered.push(prompt(f.repo, f.runId, Number(current.data.attempt)));
      }
      if (resume && slot.name.includes("-worker-") && ++launches === 2) throw new Error("fixture stops before second launch");
      return SubprocessDriver.prototype.run.call(inner, slot, command);
    } });
    await runDaemon(f.repo, { adapters: [f.fake, f.reviewer], runId: f.runId, resume: true, driver });
    if (resume) await runDaemon(f.repo, { adapters: [new FakeAdapter(f.scriptPath), f.reviewer], runId: f.runId, resume: true, retryFailed: true });
    const rows = f.j.read().slice(f.before);
    expect(funding(rows)).toHaveLength(2);
    expect(funding(rows).map((e) => e.data)).toEqual([
      expect.objectContaining({ repair: 1, charge: 1, gates: ["review"], contract: "class", findings: `review: ${UPHELD}` }),
      expect.objectContaining({ repair: 2, charge: 2, gates: ["review"], contract: "class" }),
    ]);
    expect(repairsSinceApproval(f.j.read(), "T1")).toBe(2);
    const exhausted = rows.find((e) => e.event === "repair-exhausted")!;
    expect(exhausted.data.repairs).toBe(2);
    expect(exhausted.data.reached).toEqual([
      expect.objectContaining({ repair: 1, funded: ["review"], charged: true }),
      expect.objectContaining({ repair: 2, funded: ["review"], charged: true }),
    ]);
    const repairDispatches = rows.filter((e) => e.event === "repair-dispatch");
    expect(repairDispatches.length).toBeGreaterThanOrEqual(2);
    expect(delivered[0]!.split(UPHELD)).toHaveLength(2);
  }
}, 120_000);
