import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { runGates, type GateContext, type GateEvent } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commit = (repo: string) => {
  git(repo, "add", "-A");
  git(repo, "commit", "--no-gpg-sign", "-m", "repair");
};

// The runner records actual executions. Its ignored controls inject failures AFTER the
// green baseline without changing the subject or adding unrelated dirty-tree refusals.
async function fixture(mode: "green" | "selected-red" | "full-red", renameRequired = false) {
  const repo = makeRepo({
    "src/changed.ts": "export const changed = 1;\n",
    "src/separate.ts": "export const separate = 1;\n",
    "tests/changed.test.ts": 'import { changed } from "../src/changed.js";\nchanged;\n',
    "tests/repair.test.ts": 'import { separate } from "../src/separate.js";\nseparate;\n',
    "tests/hidden.test.ts": "// A regression outside the import-based selection.\n",
    ".gitignore": "executions.log\noutcome.flag\n",
    "run.sh": [
      'echo "$*" >> executions.log',
      'mode=$(cat outcome.flag 2>/dev/null || true)',
      'if [ "$mode" = selected-red ] && [ "$#" -gt 0 ]; then',
      "  echo 'FAIL tests/repair.test.ts > known defect'",
      "  exit 1",
      "fi",
      'if [ "$mode" = full-red ] && [ "$#" -eq 0 ]; then',
      "  echo 'FAIL tests/hidden.test.ts > omitted regression'",
      "  exit 1",
      "fi",
      "exit 0",
    ].join("\n"),
  });
  const baseRef = git(repo, "rev-parse", "HEAD");
  const commands = { test: "sh run.sh" };
  const baseline = await captureBaseline(repo, commands);
  writeFileSync(join(repo, "src/changed.ts"), "export const changed = 2;\n");
  if (renameRequired) git(repo, "mv", "tests/repair.test.ts", "tests/renamed.test.ts");
  commit(repo);
  writeFileSync(join(repo, "outcome.flag"), mode);
  const task = validateGraph({
    version: 1, spec: { source: "native", paths: ["spec.md"], hash: "repair-fixture" },
    tasks: [{ id: "T1", title: "repair", goal: "repair a known regression", shape: "implement",
      complexity: 3, files: ["**"], acceptance: ["the defect is fixed"],
      gates: ["build", "test", "lint", "evidence", "scope"] }],
  }).tasks[0];
  const ends: GateEvent[] = [];
  const context: GateContext = {
    worktree: repo, baseRef, commands, baseline, channels: [], adapters: [],
    author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
    result: { ok: true, summary: "repaired", deviations: [], raw: "" },
    cfg: structuredClone(DEFAULT_CONFIG), selectTests: true,
    requiredRepairTests: ["tests/repair.test.ts"], selectionReason: "known-failing-tests",
    onGate: (event) => { if (event.phase === "end") ends.push(event); },
  };
  const run = async (overrides: Partial<GateContext> = {}) => {
    const round = await runGates(task, { ...context, ...overrides });
    const verdict = round.results.find((result) => result.gate === "test")!;
    // Exclude the first logged execution: it belongs to baseline capture.
    const executions = readFileSync(join(repo, "executions.log"), "utf8").split("\n").slice(1, -1);
    const testEnds = ends.filter((event) => event.gate === "test");
    expect(testEnds).toHaveLength(1);
    expect(testEnds[0]).toMatchObject({ result: verdict });
    return { round, verdict, executions };
  };
  return { repo, run };
}

const repairSelection = "tests/changed.test.ts tests/repair.test.ts";

describe("repair selection preserves complete candidate verification", () => {
  test("a selected repair that remains red buys no full-suite execution", async () => {
    const { run } = await fixture("selected-red");
    const { round, verdict, executions } = await run();
    expect(executions).toEqual([repairSelection]);
    expect(verdict.pass).toBe(false);
    expect(verdict.meta?.fullSuite).not.toBe(true);
    expect(verdict.meta?.selectionDecision).toMatchObject({ scope: "selected", reason: "known-failing-tests" });
    expect(round.results.every((result) => result.pass)).toBe(false);
  });

  test("a green selected repair still requires a complete candidate suite", async () => {
    const { run } = await fixture("green");
    const { round, verdict, executions } = await run();
    expect(executions).toEqual([repairSelection, ""]);
    expect(verdict.meta?.fullSuite).toBe(true);
    expect(verdict.meta?.selectedTests).toEqual(repairSelection.split(" "));
    expect(round.results.every((result) => result.pass)).toBe(true);
  });

  test("a known failing file is selected even when no changed import reaches it", async () => {
    const ordinary = await fixture("selected-red");
    const ordinaryRound = await ordinary.run({ requiredRepairTests: [], selectionReason: "affected-tests" });
    expect(ordinaryRound.executions).toEqual(["tests/changed.test.ts"]);
    const repair = await fixture("selected-red");
    const repairedRound = await repair.run();
    expect(repairedRound.executions).toEqual([repairSelection]);
    expect(repairedRound.verdict.meta?.selectionDecision).toMatchObject({ requiredFiles: ["tests/repair.test.ts"] });
  });

  test.each(["missing", "renamed"] as const)("a %s required file falls back to one full suite", async (kind) => {
    const { run } = await fixture("green", kind === "renamed");
    const { verdict, executions } = await run(kind === "missing" ? { requiredRepairTests: ["tests/missing.test.ts"] } : {});
    expect(executions).toEqual([""]);
    expect(verdict.pass).toBe(true);
    expect(verdict.meta?.selectedTests).toBeUndefined();
    expect(verdict.meta?.selectionDecision).toMatchObject({ scope: "full" });
  });

  test("an omitted regression discovered by the full candidate suite prevents a green round", async () => {
    const { run } = await fixture("full-red");
    const { round, verdict, executions } = await run();
    expect(executions).toEqual([repairSelection, ""]);
    expect(verdict.meta?.fullSuite).toBe(true);
    expect(verdict.pass).toBe(false);
    expect(verdict.details).toContain("tests/hidden.test.ts");
    expect(round.results.every((result) => result.pass)).toBe(false);
  });
});
