import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { approve } from "../../../src/cli/commands/approve.js";
import { DEFAULT_CONFIG } from "../../../src/config/config.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import * as baselineModule from "../../../src/gates/baseline.js";
import { runGates, type GateContext } from "../../../src/gates/run-gates.js";
import { graphDefinitionHash, loadGraph } from "../../../src/graph/graph.js";
import { validateGraph } from "../../../src/graph/schema.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { gitHead, shOk } from "../../../src/run/git.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

const author = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } as const;
const receipts = (rows: JournalEvent[]) => rows.filter((row) => row.event === "build-receipt");

function assertPair(rows: JournalEvent[], runId: string, attempt: number) {
  const resultAt = rows.findIndex((row) => row.event === "gate-result" && row.data.gate === "build");
  expect(resultAt).toBeGreaterThanOrEqual(0);
  const pair = receipts(rows.slice(0, resultAt));
  expect(pair.map((row) => row.data.outcome)).toEqual(["started", "completed"]);
  expect(pair.every((row) => row.taskId === "T1" && row.data.confirmedStart === true)).toBe(true);
  const identity = pair[0]!.data.attribution;
  expect(identity).toMatchObject({ runId, taskId: "T1", attempt, gateRound: expect.any(Number), invocation: expect.any(String) });
  expect(pair[1]!.data.attribution).toEqual(identity);
  expect(rows[resultAt]!.data.attempt).toBe(attempt);
}

async function fixture() {
  const repo = makeRepo({ "a.txt": "before", ".gitignore": ".tickmarkr/\n" });
  const baseRef = await gitHead(repo);
  writeFileSync(join(repo, "a.txt"), "after");
  await shOk("git add a.txt && git commit --no-gpg-sign -m work", repo);
  const journal = Journal.create(repo, "run-receipts");
  const task = validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1")] }).tasks[0]!;
  task.gates = ["build"];
  const ctx: GateContext = {
    worktree: repo, baseRef, author, commands: { build: "true" },
    baseline: { commands: {} }, result: { ok: true, summary: "done", deviations: [], raw: "" },
    channels: [], adapters: [], cfg: DEFAULT_CONFIG,
    stateDir: makeTestTempDir("receipt-store-"),
    buildReceiptIdentity: { runId: "run-receipts", taskId: "T1", attempt: 2, gateRound: 1 },
    onGate: async (event) => {
      // Exercise an asynchronous sink: the result must not overtake queued receipt writes.
      await Promise.resolve();
      if (event.phase === "note") journal.append(event.name, task.id, event.payload);
      if (event.phase === "end") journal.append("gate-result", task.id, event.result);
    },
  };
  return { repo, journal, task, ctx };
}

describe("build receipt journal", () => {
  test("test: an ordinary verification round journals for the build gate a confirmed-start row then a terminal row correlated by run task attempt gate round and invocation before its gate-result row, and a resumed verification round journals the same pair under the resumed attempt, so a build gate-result with no receipt pair fails", async () => {
    const ordinary = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })], {
      tasks: { T1: [{ shell: `echo work > work.txt; ${COMMIT} work`, result: { ok: true, summary: "landed" } }] },
    }, 'gates: { build: "true" }\n');
    const runId = "run-ordinary-receipts";
    const summary = await runDaemon(ordinary.repo, { adapters: [ordinary.fake], runId });
    expect(summary.done).toContain("T1");
    assertPair(Journal.open(ordinary.repo, runId).read(), runId, 0);

    const resumed = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "review"] })], { tasks: {} }, 'gates: { build: "true" }\n');
    const resumedId = "run-resumed-receipts";
    const baseRef = await gitHead(resumed.repo);
    const branch = `tickmarkr/${resumedId}`;
    const wt = await new SubprocessDriver().worktree(resumed.repo, `${branch}--T1`, baseRef);
    writeFileSync(join(wt, "work.txt"), "landed\n");
    await shOk(`${COMMIT} work`, wt);
    const journal = Journal.create(resumed.repo, resumedId);
    journal.append("run-start", undefined, {
      baseRef, branch, commands: { build: "true" }, graphDefinitionHash: graphDefinitionHash(loadGraph(resumed.repo)),
    });
    journal.append("task-dispatch", "T1", { assignment: author, attempt: 0 });
    journal.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [] });
    journal.phaseStart("T1", "gates");
    journal.append("gate-result", "T1", { gate: "build", pass: false, details: "failed" });
    journal.append("gate-result", "T1", { gate: "review", pass: false, details: "failed" });
    journal.append("task-human", "T1", { reason: "gate failed", kind: "gate-fail" });
    writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(await baselineModule.captureBaseline(resumed.repo, { build: "true" })));
    await approve([resumedId, "T1", "--waive", "--by", "test"], resumed.repo);
    const offset = journal.read().length;
    await runDaemon(resumed.repo, { adapters: [resumed.fake], runId: resumedId, resume: true });
    assertPair(journal.read().slice(offset), resumedId, 1);
    expect(journal.read().slice(offset).some((row) => row.event === "task-dispatch")).toBe(false);
  }, 60_000);

  test("test: a build verdict reused from the verdict store journals a reused-result receipt stating that no fresh build ran in this invocation, a missing build command journals a skipped receipt, and a dirty-tree refusal journals a refused receipt with no confirmed start, so a reuse skip or refusal that claims a confirmed build fails", async () => {
    const { repo, journal, task, ctx } = await fixture();
    await runGates(task, ctx);
    const before = journal.read().length;
    const reused = await runGates(task, ctx);
    expect(reused.results[0]!.meta?.reused).toBe(true);
    const reuse = receipts(journal.read().slice(before));
    expect(reuse).toHaveLength(1);
    expect(reuse[0]!.data).toMatchObject({ outcome: "reused-result", confirmedStart: false, reason: expect.stringContaining("no fresh build ran in this invocation"), freshBuildRan: false });
    ctx.commands = {};
    const skipAt = journal.read().length;
    const skipped = await runGates(task, ctx);
    expect(skipped.results[0]!.meta?.skipped).toBe(true);
    expect(receipts(journal.read().slice(skipAt)).map((row) => row.data)).toMatchObject([{ outcome: "skipped", confirmedStart: false }]);
    writeFileSync(join(repo, "a.txt"), "dirty");
    const refusalAt = journal.read().length;
    const refused = await runGates(task, ctx);
    expect(refused.results[0]!.pass).toBe(false);
    expect(receipts(journal.read().slice(refusalAt)).map((row) => row.data)).toMatchObject([{ outcome: "refused", confirmedStart: false }]);
  });

  test("test: repeated gate rounds and an infrastructure rerun inside one attempt journal distinct invocation identities, and a terminal receipt naming a stale invocation is journaled as unattributed rather than closing the current start, so a terminal row attributed across invocations fails", async () => {
    const { journal, task, ctx } = await fixture();
    await runGates(task, ctx);
    const first = receipts(journal.read())[0]!.data.attribution;
    ctx.buildReceiptIdentity!.gateRound = 2;
    ctx.commands.build = "printf second";
    // Inject the existing baseline seam's retry lifecycle, including a late first terminal.
    // The local invocation counter resets on a new shell call inside a baseline rerun.
    const spy = vi.spyOn(baselineModule, "compareToBaseline").mockImplementation(async (_cwd, _commands, _baseline, _enabled, opts) => {
      const stale = opts!.taskBuildAttribution!(1);
      opts!.onReceipt!({ attribution: stale, outcome: "started", confirmedStart: true });
      opts!.onReceipt!({ attribution: stale, outcome: "completed", confirmedStart: true, exitCode: 1 });
      const current = opts!.taskBuildAttribution!(1);
      expect(current.invocation).not.toBe(stale.invocation);
      opts!.onReceipt!({ attribution: current, outcome: "started", confirmedStart: true });
      opts!.onReceipt!({ attribution: stale, outcome: "completed", confirmedStart: true, exitCode: 1 });
      opts!.onReceipt!({ attribution: current, outcome: "completed", confirmedStart: true, exitCode: 0 });
      return [{ gate: "build", pass: true, details: "exit 0" }];
    });
    try { await runGates(task, ctx); } finally { spy.mockRestore(); }
    const rows = receipts(journal.read());
    const starts = rows.filter((row) => row.data.outcome === "started");
    expect(starts).toHaveLength(3);
    expect(new Set(starts.map((row) => (row.data.attribution as { invocation: string }).invocation)).size).toBe(3);
    expect(starts[1]!.data.attribution).toMatchObject({ attempt: 2, gateRound: 2 });
    expect(starts[1]!.data.attribution).not.toEqual(first);
    expect(rows.at(-2)!.data).toMatchObject({ attributionStatus: "unattributed", reportedAttribution: starts[1]!.data.attribution });
    expect(rows.at(-2)!.data).not.toHaveProperty("attribution");
    expect(rows.at(-1)!.data.attribution).toEqual(starts[2]!.data.attribution);
  });
});

test("test: a daemon gate result row for each of build test and lint carries the receipt the producer returned including its invocation id artifact references hashes counts and availability, so a writer that copies its closed key list without the receipt fails", async () => {
  const produced: Awaited<ReturnType<typeof baselineModule.compareToBaseline>> = [];
  const original = baselineModule.compareToBaseline;
  const spy = vi.spyOn(baselineModule, "compareToBaseline").mockImplementation(async (...args) => {
    const rows = await original(...args);
    produced.push(...rows);
    return rows;
  });
  try {
    const { repo, fake } = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })], {
      tasks: { T1: [{ shell: `echo work > work.txt; ${COMMIT} work`, result: { ok: true, summary: "landed" } }] },
    }, 'gates: { build: "printf build", test: "printf test", lint: "printf lint" }\n');
    const runId = "run-gate-evidence";
    expect((await runDaemon(repo, { adapters: [fake], runId })).done).toContain("T1");
    const rows = Journal.open(repo, runId).read().filter(row => row.event === "gate-result");
    for (const gate of ["build", "test", "lint"]) {
      const result = produced.find(row => row.gate === gate)!;
      expect(result.evidenceReceipt).toMatchObject({
        invocationId: expect.any(String), availability: "available",
        stdout: { sha256: expect.any(String), retainedBytes: expect.any(Number), droppedBytes: 0 },
        stderr: { sha256: expect.any(String), retainedBytes: 0, availability: "available" },
      });
      const row = rows.find(row => row.data.gate === gate)!;
      expect(row.data.evidenceReceipt).toEqual(result.evidenceReceipt);
      expect(row.data.evidenceReceipts).toEqual(result.evidenceReceipts);
    }
  } finally { spy.mockRestore(); }
}, 60_000);

test("test: the production daemon rechecking a recreated same-path same-commit checkout records a fresh build receipt before tests observe dist versus build reuse in the unchanged checkout, so cached success without outputs fails", async () => {
  vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z");
  try {
    const { existsSync, readFileSync } = await import("node:fs");
    const { worktreePath } = await import("../../../src/run/git.js");
    const flag = join(makeTestTempDir("recheck-build-output-"), "allow-test");
    const commands = {
      build: "mkdir -p dist; echo built > dist/output",
      test: `[ ! -f work.txt ] || { test -f dist/output && test -f '${flag}'; }`,
    };
    const { repo, fake } = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })], {
      consult: { action: "human", notes: "operator recheck" },
      tasks: { T1: [{ shell: `echo work > work.txt; ${COMMIT} work`, result: { ok: true, summary: "landed" } }] },
    }, `gates: ${JSON.stringify(commands)}\n`);
    writeFileSync(join(repo, ".gitignore"), ".tickmarkr/\ndist/\n");
    await shOk(`${COMMIT} ignore-build-output`, repo);
    const runId = "run-recreated-build";
    expect((await runDaemon(repo, { adapters: [fake], runId })).human).toContain("T1");
    const journal = Journal.open(repo, runId);
    const worktree = worktreePath(repo, `tickmarkr/${runId}--T1`);
    const head = await gitHead(worktree);
    const notes: string[] = [];
    const liveContext: GateContext = {
      worktree, baseRef: journal.read().find(e => e.event === "run-start")!.data.baseRef as string,
      author, commands, baseline: JSON.parse(readFileSync(join(journal.dir, "baseline.json"), "utf8")),
      result: { ok: true, summary: "done", deviations: [], raw: "" }, channels: [], adapters: [], cfg: DEFAULT_CONFIG,
      stateDir: join(repo, ".tickmarkr"),
      onGate: e => { if (e.phase === "note" && e.name === "build-receipt") notes.push(e.payload.outcome as string); },
    };
    const priorBuild = (await runGates(T("T1", { gates: ["build"] }), liveContext)).results[0]!;
    expect(existsSync(join(worktree, "dist/output"))).toBe(true);
    notes.length = 0;
    const live = await runGates(T("T1", { gates: ["build"] }), liveContext);
    expect(live.results[0]?.meta?.reused).toBe(true);
    expect(notes).toEqual(["reused-result"]);
    writeFileSync(flag, "go");
    await approve([runId, "T1", "--recheck", "--by", "test"], repo);
    const offset = journal.read().length;
    expect((await runDaemon(repo, { adapters: [fake], runId, resume: true })).done).toContain("T1");
    const rows = journal.read().slice(offset).filter(e => e.taskId === "T1");
    expect(rows.some(e => e.event === "worktree-recreation")).toBe(true);
    const pair = receipts(rows);
    expect(pair.map(e => e.data.outcome)).toEqual(["started", "completed"]);
    expect(pair[1]?.data).toMatchObject({ confirmedStart: true, exitCode: 0 });
    const testAt = rows.findIndex(e => e.event === "gate-result" && e.data.gate === "test");
    expect(testAt).toBeGreaterThan(rows.indexOf(pair[1]!));
    expect(rows[testAt]?.data.pass).toBe(true);
    const build = rows.find(e => e.event === "gate-result" && e.data.gate === "build")!;
    expect(build.data.evidenceReceipt).not.toEqual(priorBuild.evidenceReceipt);
    expect((build.data.evidenceReceipt as { subject: { subjectCommit: string } }).subject.subjectCommit).toBe(head);
  } finally { vi.unstubAllEnvs(); }
}, 60_000);
