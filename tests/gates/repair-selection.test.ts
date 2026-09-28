import { execFileSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline, type Baseline } from "../../src/gates/baseline.js";
import { computeVerificationIdentity, getVerdictStore, resolveStateDir } from "../../src/gates/cache.js";
import { runGates, testCommandForFiles, type GateContext, type GateEvent } from "../../src/gates/run-gates.js";
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
  const logged = () => readFileSync(join(repo, "executions.log"), "utf8").split("\n").slice(0, -1);
  const run = async (overrides: Partial<GateContext> = {}) => {
    // Only this round's executions: the first run excludes baseline capture's line.
    const seen = logged().length;
    ends.length = 0;
    const round = await runGates(task, { ...context, ...overrides });
    const verdict = round.results.find((result) => result.gate === "test")!;
    const executions = logged().slice(seen);
    const testEnds = ends.filter((event) => event.gate === "test");
    expect(testEnds).toHaveLength(1);
    expect(testEnds[0]).toMatchObject({ result: verdict });
    return { round, verdict, executions };
  };
  return { repo, run, baseline, commands };
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

const timed = (baseline: Baseline, durations: Record<string, number>): Baseline => ({ ...baseline, commands: { ...baseline.commands,
  test: { ...baseline.commands.test!, fileDurations: Object.entries(durations).map(([file, durationMs]) => ({ file, durationMs })) } } });

test("runGates uses one full invocation at a trusted cost ratio of 0.75 versus screen then full at 0.74 or unknown timing and uses a qualified full-green hit before any screen, so a selected-only hit authorizing merge fails", async () => {
  // Harness-measured baseline timing: the screen (changed + repair) costs exactly 75 % of the suite.
  const promoted = await fixture("green");
  const at75 = await promoted.run({ baseline: timed(promoted.baseline,
    { "tests/changed.test.ts": 40, "tests/repair.test.ts": 35, "tests/hidden.test.ts": 25 }) });
  expect(at75.executions).toEqual([""]);
  expect(at75.verdict.pass).toBe(true);
  expect(at75.verdict.meta?.selectedTests).toBeUndefined();
  expect(at75.verdict.meta?.selectionDecision).toMatchObject({ scope: "full", reason: "screen-cost-promoted", costRatio: 0.75 });
  expect(at75.round.results.every((result) => result.pass)).toBe(true);

  for (const durations of [{ "tests/changed.test.ts": 40, "tests/repair.test.ts": 34, "tests/hidden.test.ts": 26 }, // 0.74
    { "tests/changed.test.ts": 40, "tests/hidden.test.ts": 60 }, // a selected file without a measurement: unknown
    undefined]) { // no per-file timing at all: unknown
    const screened = await fixture("green");
    const round = await screened.run(durations ? { baseline: timed(screened.baseline, durations) } : {});
    expect({ durations, executions: round.executions }).toEqual({ durations, executions: [repairSelection, ""] });
    expect(round.verdict.meta?.fullSuite).toBe(true);
  }

  // A full green already measured on this exact identity answers before any screen is bought.
  const cached = await fixture("green");
  expect((await cached.run({ selectTests: false })).executions).toEqual([""]);
  const hit = await cached.run();
  expect(hit.executions).toEqual([]);
  expect(hit.verdict.pass).toBe(true);
  expect(hit.verdict.meta).toMatchObject({ reused: true, selectionDecision: { scope: "full", reason: "full-green-cache" } });

  // A green recorded only for the selection is not full evidence: the full suite still runs and reds.
  const selectedOnly = await fixture("full-red");
  const selection = repairSelection.split(" ");
  const identity = await computeVerificationIdentity({ worktree: selectedOnly.repo, gate: "test",
    command: testCommandForFiles(selectedOnly.commands.test, selection), baseline: selectedOnly.baseline, selectedSet: selection });
  expect(getVerdictStore(resolveStateDir(selectedOnly.repo)).set(identity, { gate: "test", pass: true, details: "selected green" })).toBe(true);
  const refused = await selectedOnly.run();
  expect(refused.executions).toEqual([""]);
  expect(refused.verdict.pass).toBe(false);
  expect(refused.verdict.meta?.fullSuite).toBe(true);
  expect(refused.round.results.every((result) => result.pass)).toBe(false);

  // A manifested runner: a full green qualifies only for the manifest it certified. An ignored
  // generated test the runner now collects moves no tree or environment identity, so the hit no
  // longer answers — its one timed file then promotes by cost, and a fresh full suite certifies the larger manifest.
  for (const generated of [false, true]) {
    const repo = makeRepo({
      ".gitignore": "node_modules/\ntests/generated.test.ts\n",
      "src/a.ts": "export const a = 1;\n",
      "tests/a.test.ts": 'import { a } from "../src/a"; test("alpha", () => expect(a).toBeGreaterThan(0));\n',
      "package.json": JSON.stringify({ type: "module", scripts: { test: "vitest run --globals" } }),
    });
    symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"), "dir");
    const baseRef = git(repo, "rev-parse", "HEAD");
    const commands = { test: "vitest run --globals" };
    const baseline = await captureBaseline(repo, commands);
    writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
    commit(repo);
    const task = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "manifest" }, tasks: [{ id: "T1", title: "m",
      goal: "m", shape: "implement", complexity: 3, files: ["**"], acceptance: ["done"], gates: ["build", "test", "lint", "evidence", "scope"] }] }).tasks[0];
    const round = async (selectTests: boolean) => (await runGates(task, { worktree: repo, baseRef, commands, baseline, channels: [], adapters: [],
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, result: { ok: true, summary: "", deviations: [], raw: "" },
      cfg: structuredClone(DEFAULT_CONFIG), selectTests, selectionReason: "known-failing-files" })).results.find((r) => r.gate === "test")!;
    expect((await round(false)).meta?.manifest).toEqual(["tests/a.test.ts"]);
    if (generated) writeFileSync(join(repo, "tests/generated.test.ts"), 'test("generated", () => expect(1).toBe(1));\n');
    const verdict = await round(true);
    expect({ generated, pass: verdict.pass, reused: verdict.meta?.reused, manifest: verdict.meta?.manifest, reason: (verdict.meta?.selectionDecision as { reason?: string })?.reason })
      .toEqual(generated
        ? { generated, pass: true, reused: undefined, manifest: ["tests/a.test.ts", "tests/generated.test.ts"], reason: "screen-cost-promoted" }
        : { generated, pass: true, reused: true, manifest: ["tests/a.test.ts"], reason: "full-green-cache" });
  }
}, 120_000);
