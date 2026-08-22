import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "../../src/cli/commands/compile.js";
import { loadGraph, taskContentDigest } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal, structuredFindings } from "../../src/run/journal.js";
import { COMMIT, makeRepo, setupRepo, T } from "../helpers/tmprepo.js";

const ORIGINAL_CRITERION = "the result remains observable";

function prd(criterion = ORIGINAL_CRITERION): string {
  return `# History fixture

## T1: Preserve a result
- goal: Keep the result stable.
- shape: implement
- complexity: 3
- files: result.txt
- acceptance:
  - ${criterion}
`;
}

function commit(repo: string, message: string): string {
  execSync(`git add -A && git commit --no-gpg-sign -m ${JSON.stringify(message)}`, { cwd: repo });
  return execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
}

function appendFinding(repo: string, runId: string, digest: string, note: string): void {
  const details = `- [material] ${note}`;
  const journal = Journal.create(repo, runId);
  journal.append("gate-result", "T1", {
    gate: "review",
    pass: false,
    details,
    taskContentDigest: digest,
    findings: structuredFindings("review", details),
  });
}

function prompt(repo: string, runId: string): string {
  return readFileSync(join(repo, ".tickmarkr", "runs", runId, "prompts", "T1-a0.md"), "utf8");
}

async function historyRepo(currentCriterion = ORIGINAL_CRITERION) {
  const fixture = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `echo result > result.txt && ${COMMIT} result`, result: { ok: true, summary: "result" } }] } },
  );
  writeFileSync(join(fixture.repo, "feature.prd.md"), prd());
  commit(fixture.repo, "add spec");
  await compile(["feature.prd.md"], fixture.repo);
  const digest = taskContentDigest(loadGraph(fixture.repo).tasks[0]!);
  appendFinding(fixture.repo, "run-history-prior", digest, "result.txt:1 — preserve the prior finding exactly");
  if (currentCriterion !== ORIGINAL_CRITERION) {
    writeFileSync(join(fixture.repo, "feature.prd.md"), prd(currentCriterion));
    commit(fixture.repo, "edit criterion");
  }
  return fixture;
}

describe("compile and fresh-run journal history", () => {
  test("test: the fresh-worker prompt and compile diagnostics mirror an unresolved prior finding exactly when the task content digest matches, whereas editing one criterion makes that mirrored pair empty", async () => {
    const matching = await historyRepo();
    const matchingCompile = await compile(["feature.prd.md"], matching.repo);
    expect(matchingCompile).toContain("Prior-run EVIDENCE (not a verdict) from run-history-prior review: result.txt:1 — preserve the prior finding exactly");
    await runDaemon(matching.repo, { adapters: [matching.fake], runId: "run-history-match" });
    expect(prompt(matching.repo, "run-history-match")).toContain(
      "Prior-run EVIDENCE (not a verdict) from run-history-prior review: result.txt:1 — preserve the prior finding exactly",
    );

    const edited = await historyRepo("the edited result remains observable");
    const editedCompile = await compile(["feature.prd.md"], edited.repo);
    expect(editedCompile).not.toContain("preserve the prior finding exactly");
    await runDaemon(edited.repo, { adapters: [edited.fake], runId: "run-history-edited" });
    expect(prompt(edited.repo, "run-history-edited")).not.toContain("preserve the prior finding exactly");
  }, 120_000);

  test("test: the shared prior-journal walk reads only its documented recent-run bound and feeds both compile and fresh-run feedback; an unbounded second reader or a finding older than that bound reaching either surface fails", async () => {
    const fixture = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo result > result.txt && ${COMMIT} result`, result: { ok: true, summary: "result" } }] } },
    );
    writeFileSync(join(fixture.repo, "feature.prd.md"), prd());
    commit(fixture.repo, "add bounded spec");
    await compile(["feature.prd.md"], fixture.repo);
    const digest = taskContentDigest(loadGraph(fixture.repo).tasks[0]!);
    appendFinding(fixture.repo, "run-0000", digest, "finding older than the shared bound");
    for (let i = 1; i < 50; i++) {
      Journal.create(fixture.repo, `run-${String(i).padStart(4, "0")}`).append("run-start");
    }
    appendFinding(fixture.repo, "run-0050", digest, "finding inside the shared bound");

    const output = await compile(["feature.prd.md"], fixture.repo);
    expect(output).toContain("finding inside the shared bound");
    expect(output).not.toContain("finding older than the shared bound");
    await runDaemon(fixture.repo, { adapters: [fixture.fake], runId: "run-9999" });
    const freshPrompt = prompt(fixture.repo, "run-9999");
    expect(freshPrompt).toContain("finding inside the shared bound");
    expect(freshPrompt).not.toContain("finding older than the shared bound");
  }, 120_000);

  test("test: a pending task whose prior journaled merge commit is an ancestor of the current base gets one information line naming that run; a non-ancestor merge or a task already marked done prints nothing", async () => {
    const tasks = `# Tasks
- [ ] T1 ancestor pending
  - goal: stable ancestor task
  - files: ancestor.txt
  - acceptance: ancestor criterion
- [ ] T2 side pending
  - goal: stable side task
  - files: side.txt
  - acceptance: side criterion
- [x] T3 ancestor done
  - goal: stable done task
  - files: done.txt
  - acceptance: done criterion
`;
    const repo = makeRepo({ "spec/tasks.md": tasks, "base.txt": "base\n" });
    await compile(["spec"], repo);
    const graph = loadGraph(repo);
    writeFileSync(join(repo, "ancestor.txt"), "ancestor\n");
    const ancestor = commit(repo, "ancestor work");
    execSync("git checkout -b side", { cwd: repo });
    writeFileSync(join(repo, "side.txt"), "side\n");
    const nonAncestor = commit(repo, "side work");
    execSync("git checkout main", { cwd: repo });

    const journal = Journal.create(repo, "run-merge-proof");
    for (const [taskId, mergeCommit] of [["T1", ancestor], ["T2", nonAncestor], ["T3", ancestor]] as const) {
      const digest = taskContentDigest(graph.tasks.find((task) => task.id === taskId)!);
      journal.append("task-done", taskId, { taskContentDigest: digest });
      journal.append("merge", taskId, { commit: mergeCommit, branch: `tickmarkr/run-merge-proof--${taskId}` });
    }

    const output = await compile(["spec"], repo);
    expect(output.match(/T1: merged in run run-merge-proof/g)).toHaveLength(1);
    expect(output).toContain("compiles as pending (plan not marked done) — this dispatch rebuilds it");
    expect(output).not.toContain("T2: merged in run");
    expect(output).not.toContain("T3: merged in run");

    writeFileSync(join(repo, "spec/tasks.md"), tasks.replace("ancestor criterion", "changed ancestor criterion"));
    commit(repo, "change ancestor criterion");
    const changed = await compile(["spec"], repo);
    expect(changed).not.toContain("T1: merged in run");
  }, 120_000);
});
