// Frozen at c9cd491620673b50b87d0b7eb6208010b8eb58f0 by the AUTHOR, before A/B/C.
// All test reds execute NON-Vitest scripts; diagnostic metadata is injected after the gate.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { expect, test, vi } from "vitest";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { gitHead, shGitOk, verificationProtocol } from "../../../src/run/git.js";
import * as merges from "../../../src/run/merge.js";
import * as gates from "../../../src/gates/run-gates.js";
import { loadConfig } from "../../../src/config/config.js";
import { graphDefinitionHash, loadGraph } from "../../../src/graph/graph.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

const BASE = "c9cd491620673b50b87d0b7eb6208010b8eb58f0";
const fixture = new URL("../../fixtures/settle-sequences.json", import.meta.url);
const scenarios = ["merged", "tip-once", "tip-twice", "conflict", "no-eligible", "no-eligible-and-infra", "infra", "diff-cap", "shaped-passed", "shaped-reproduced", "outside-scope", "authoring", "ordinary-red"] as const;
const SLOW = "tests/slow.test.ts";
const diagnostic = "\nclassification: regression; runner-level diagnostic: never-started 5; reporter errors 1; runner vitest\nError: [vitest-worker]: Timeout calling onTaskUpdate";
const names = new Set(["gate-result", "gate-fresh-forced", "gate-reobserved", "task-human", "task-done", "tip-moved", "merge-conflict", "merge", "consult", "consult-verdict", "scope-authoring", "repair-attempt", "escalation", "gate-fingerprint-cap"]);
function project(rows: JournalEvent[]) {
  return rows.filter(e => e.taskId === "T1" && names.has(e.event)).map(e => ({
    event: e.event,
    ...(e.event === "task-human" ? { kind: e.data.kind } : {}),
    ...(e.event === "gate-result" ? { gate: e.data.gate, pass: e.data.pass } : {}),
    ...(e.event === "gate-fresh-forced" ? { reason: e.data.reason } : {}),
    ...(e.event === "gate-reobserved" ? { outcome: e.data.outcome } : {}),
  }));
}

// SLOWEST-RUNNER: 3-core macOS under coverage; ceiling is cleanup protection, never an oracle.
test("frozen production runDaemon settlement sequences preserve every nonempty fresh and resume outcome at the recorded base", async () => {
  expect(scenarios.length).toBe(13);
  const captured: Record<string, ReturnType<typeof project>> = {};
  for (const path of ["fresh", "resume"] as const) for (const scenario of scenarios) {
    vi.restoreAllMocks();
    const red = !["merged", "tip-once", "tip-twice", "conflict", "authoring"].includes(scenario);
    const dir = makeTestTempDir("tkr-settle-script-");
    const script = join(dir, "gate.sh");
    writeFileSync(script, `[ -f work.txt ] || exit 0\n${red ? `echo 'FAIL ${SLOW} > slow'\necho '${scenario.startsWith("shaped") ? "Error: Test timed out in 5000ms." : "AssertionError: expected 1 to be 2"}'\nexit 1` : "exit 0"}\n`);
    const commands = { build: "true", lint: "true", test: `sh '${script}'` };
    const shell = `echo work > work.txt${scenario === "authoring" ? " && echo outside > outside.txt" : ""} && ${COMMIT} work`;
    const { repo, fake } = setupRepo([T("T1", { files: ["work.txt", ...(scenario === "outside-scope" ? [] : [SLOW])], gates: ["build", "test", "lint", "evidence", "scope"] })], {
      consult: { action: "human", notes: "frozen fixture conflict policy" },
      tasks: { T1: [{ shell, result: { ok: true, summary: "landed work" } }, ...Array.from({ length: 5 }, () => ({ shell: "true", result: { ok: true, summary: "same tree" } }))] },
    }, stringify({ gates: commands }));
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, SLOW), "// attributed scripted gate failure\n");
    await shGitOk(`git add tests && git commit --no-gpg-sign -m fixture`, repo);
    const runId = `run-settle-${path}-${scenario}`;
    const originalGate = gates.runGates;
    vi.spyOn(gates, "runGates").mockImplementation((task, ctx, ...rest) => originalGate(task, {
      ...ctx,
      onGate: async (event) => {
        if (event.phase === "end") {
          const r = event.result;
          if (r.gate === "test" && !r.pass) {
            r.meta = { ...r.meta, classification: "regression", failingFiles: [SLOW], fullSuite: true };
            if (scenario.startsWith("shaped")) r.details += diagnostic;
            if (scenario === "outside-scope") r.details += "\nclassification: regression; runner-level diagnostic: never-started 0; reporter errors 0; runner vitest";
            if (scenario.startsWith("no-eligible")) r.meta.noEligibleReviewer = true;
            if (scenario === "infra" || scenario === "no-eligible-and-infra") r.meta.infra = true;
            if (scenario === "diff-cap") { r.meta.parkKind = "diff-cap"; r.details = "diff exceeds verifiable cap"; }
          }
          if (r.gate === "scope" && !r.pass && scenario === "authoring") {
            r.meta = { ...r.meta, collateral: { authoring: true, predicted: ["outside.txt"], repair: "own outside.txt" } };
          }
        }
        await ctx.onGate?.(event);
      },
    }, ...rest));
    if (scenario.startsWith("shaped")) vi.spyOn(gates, "reobserveTestFiles").mockResolvedValue(scenario === "shaped-passed"
      ? { gate: "test", pass: true, details: "isolated measurement passed", meta: { manifest: [SLOW], failingFiles: [] } }
      : { gate: "test", pass: false, details: `FAIL ${SLOW} > slow\nAssertionError: expected 1 to be 2`, meta: { classification: "regression", manifest: [SLOW], failingFiles: [SLOW], failingTests: [`${SLOW} > slow`] } });
    const originalMerge = merges.mergeTask;
    let mergeCalls = 0;
    if (["tip-once", "tip-twice", "conflict"].includes(scenario)) vi.spyOn(merges, "mergeTask").mockImplementation(async (...args) => {
      mergeCalls++;
      if (scenario === "conflict") return { ok: false, conflict: "frozen merge conflict" };
      if (mergeCalls <= (scenario === "tip-once" ? 1 : 2)) return { ok: false, tipMoved: { gatedCommit: args[3] ?? "", branchTip: "fixture-moved-tip" } };
      return originalMerge(...args);
    });
    let startLine = 0;
    if (path === "resume") {
      const baseRef = await gitHead(repo);
      const branch = merges.integrationBranch(loadConfig(repo), runId);
      await merges.ensureIntegration(repo, branch, baseRef);
      const wt = await new SubprocessDriver().worktree(repo, `${branch}--T1`, baseRef);
      await shGitOk(shell, wt);
      const journal = Journal.create(repo, runId);
      journal.append("run-start", undefined, { pid: 111111, baseRef, commands, branch, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
      journal.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0, retryMode: "fresh" });
      journal.append("worker-launch", "T1", {});
      journal.append("worker-result", "T1", { ok: true, summary: "landed work", deviations: [], finished: true, exitCode: 0 });
      journal.phaseStart("T1", "gates");
      journal.append("gate-result", "T1", { gate: "build", pass: true, attempt: 0, commit: await gitHead(wt), verification: verificationProtocol(process.env, wt) });
      writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: Object.fromEntries(Object.keys(commands).map(g => [g, { exitCode: 0, fingerprints: [] }])) }));
      startLine = journal.read().length;
    }
    await runDaemon(repo, { adapters: [fake], runId, ...(path === "resume" ? { resume: true } : {}) });
    const rows = Journal.open(repo, runId).read().slice(startLine);
    const sequence = project(rows);
    expect(sequence.length, `${path}/${scenario}`).toBeGreaterThan(0);
    // Positive collection checks make accidental early exits distinguishable from settlement.
    expect(sequence.some(e => ["task-done", "task-human"].includes(e.event)), `${path}/${scenario}`).toBe(true);
    const expectedPark = ({ "tip-twice": "tip-moved", conflict: path === "resume" ? "merge-conflict" : "consult-human", "no-eligible": "gate-fail", "no-eligible-and-infra": "gate-fail", infra: "infra", "diff-cap": "diff-cap", "shaped-passed": "infra", authoring: "authoring", "outside-scope": "gate-fail" } as Record<string, string>)[scenario];
    if (expectedPark) {
      const park = sequence.filter(e => e.event === "task-human").at(-1);
      // Fresh consult verdicts carry the trigger kind; pin the observed conflict authority below.
      if (scenario !== "conflict" || path === "resume") expect(park?.kind, `${path}/${scenario}`).toBe(expectedPark);
    }
    if (["merged", "tip-once"].includes(scenario)) expect(sequence.at(-1)?.event, `${path}/${scenario}`).toBe("merge");
    if (scenario === "conflict") expect(sequence.filter(e => e.event === "consult-verdict").length, `${path}/${scenario}`).toBe(path === "fresh" ? 1 : 0);
    if (scenario === "outside-scope") expect(sequence.some(e => e.event === "gate-fresh-forced"), `${path}/${scenario}`).toBe(true);
    if (scenario.startsWith("shaped")) expect(sequence.some(e => e.event === "gate-reobserved" && e.outcome === (scenario === "shaped-passed" ? "passed" : "reproduced")), `${path}/${scenario}`).toBe(true);
    captured[`${path}/${scenario}`] = sequence;
  }
  vi.restoreAllMocks();
  expect(Object.keys(captured)).toHaveLength(26);
  if (process.env.TKR_RECORD_SETTLE === "1") writeFileSync(fixture, JSON.stringify({ base: BASE, scenarios: captured }, null, 2) + "\n");
  else {
    const expected = JSON.parse(readFileSync(fixture, "utf8"));
    expect(expected.base).toBe(BASE);
    expect(Object.keys(expected.scenarios)).toHaveLength(26);
    expect(captured).toEqual(expected.scenarios);
  }
}, 600_000);
