import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type OracleFailure } from "../../src/gates/acceptance.js";
import * as gateRunner from "../../src/gates/run-gates.js";
import type { GateResult } from "../../src/gates/types.js";
import { type AcceptanceItem } from "../../src/graph/schema.js";
import { resetLiveSuiteCountForTests, runDaemon, setLiveSuiteCountForTests } from "../../src/run/daemon.js";
import { resetHostLatencySampleForTests, setHostLatencySampleForTests } from "../../src/run/host-health.js";
import { Journal, readableExcerpt, type JournalEvent } from "../../src/run/journal.js";
import { classifyRepairDisposition } from "../../src/run/repair-disposition.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// Queue rows 234(b)/235 (D-2134): the declared criterion never supplies a diagnostic path.
// Queue rows 234(b)/235 (D-2134): admission is healthy and idle in these disposition fixtures;
// spawning host probes per command adds unrelated process pressure to deadline-sensitive suites.
beforeEach(() => {
  setHostLatencySampleForTests(async () => 20);
  setLiveSuiteCountForTests(async () => 0);
});
afterEach(() => {
  resetHostLatencySampleForTests();
  resetLiveSuiteCountForTests();
});

const files = ["owned.txt", "tests/owned.test.ts"];
const inventory = ["owned.txt", "package.json", "tests/owned.test.ts", "tests/outside.test.ts"];
const of = (rows: JournalEvent[], event: string) => rows.filter((e) => e.taskId === "T1" && e.event === event);
function fixture(acceptance: AcceptanceItem[], judgment?: object) {
  const made = setupRepo([T("T1", { files, acceptance })], {
    ...(judgment ? { judge: judgment } : {}),
    consult: { action: "human", notes: "needs repair" },
    tasks: { T1: [
      { shell: `echo changed > owned.txt && ${COMMIT} landed`, result: { ok: true, summary: "landed" } },
      { shell: "true", result: { ok: false, summary: "cannot repair" } },
    ] },
  }, 'routing: { escalateTier: off }\ngates: { build: "true", lint: "true", test: "true" }\n');
  writeFileSync(join(made.repo, "package.json"), "{}\n");
  execFileSync("git", ["add", "package.json"], { cwd: made.repo });
  execFileSync("git", ["commit", "--no-gpg-sign", "-qm", "tracked"], { cwd: made.repo });
  return made;
}
async function run(acceptance: AcceptanceItem[], runId: string) {
  const made = fixture(acceptance);
  await runDaemon(made.repo, { adapters: [made.fake], runId });
  const journal = Journal.open(made.repo, runId);
  return { ...made, journal, rows: journal.read(), telemetry: journal.readTelemetry().find((r) => r.taskId === "T1")! };
}
function ordinary(rows: JournalEvent[], telemetry: { attempts: number; gateFails: number }) {
  expect(of(rows, "scope-authoring")).toHaveLength(0);
  expect(of(rows, "scope-request")).toHaveLength(0);
  expect(telemetry.attempts).toBeGreaterThan(0);
  expect(telemetry.gateFails).toBeGreaterThan(0);
}
function disposition(result: GateResult) {
  return classifyRepairDisposition({ results: [result], files, inventory });
}

test("test: a daemon task whose test criterion title names a tracked file outside its scope and whose suite the worker never wrote is charged as an ordinary red with no scope-authoring row, while a task whose criterion suite lies outside its scope parks as an authoring defect naming exactly that suite, so a disposition reading paths from the quoted criterion fails", async () => {
  const missing = await run([{ oracle: "test", test: "checks package.json version", landing: "tests/owned.test.ts" }], "run-title-path");
  ordinary(missing.rows, missing.telemetry);
  expect(of(missing.rows, "gate-result").some((e) => e.data.gate === "acceptance" && e.data.pass === false && String(e.data.details).includes("package.json"))).toBe(true);
  expect(of(missing.rows, "scope-hint-unresolved")).toHaveLength(0);
  const outside = await run([{ oracle: "test", test: "checks package.json version", landing: "tests/outside.test.ts" }], "run-landing-path");
  expect(of(outside.rows, "scope-authoring").map((e) => e.data.paths)).toEqual([["tests/outside.test.ts"]]);
  expect(of(outside.rows, "task-human")[0]?.data.kind).toBe("authoring");
  expect(outside.telemetry).toMatchObject({ attempts: 0, gateFails: 0 });
  expect(of(outside.rows, "scope-hint-unresolved")).toHaveLength(0);
  for (const failure of ["absent", "untitled", "elsewhere"] as const) {
    const oracle: OracleFailure = { index: 0, kind: "test", criterion: "checks package.json", landing: "tests/owned.test.ts", failure, output: "" };
    expect(disposition({ gate: "acceptance", pass: false, details: 'oracle failed: test "checks package.json"', meta: { oracles: [oracle] } })).toMatchObject({ kind: "none", diagnostics: [] });
    oracle.landing = "tests/outside.test.ts";
    expect(disposition({ gate: "acceptance", pass: false, details: "package.json", meta: { oracles: [oracle] } })).toMatchObject({ kind: "authoring", paths: ["tests/outside.test.ts"] });
  }
}, 120_000);

test("test: a daemon task whose command oracle prints the name of an unowned tracked file still parks as an authoring defect with that hint, while one whose command text alone names a tracked file and prints nothing, and one whose judge reasons name files while its unmet criteria cite owned evidence, are charged as ordinary reds, so a fix that drops output lexing or keeps lexing criterion text fails", async () => {
  const output = await run([{ oracle: "command", command: "printf '\\033]0;owned.txt\\007\\033[31mpackage.json\\033[0m\\n'; exit 1" }], "run-output-path");
  expect(of(output.rows, "scope-authoring").map((e) => e.data.paths)).toEqual([["package.json"]]);
  expect(output.telemetry).toMatchObject({ attempts: 0, gateFails: 0 });
  expect(of(output.rows, "scope-hint-unresolved")).toHaveLength(0);
  const command = await run([{ oracle: "command", command: ": package.json; exit 1" }], "run-command-path");
  ordinary(command.rows, command.telemetry);

  const made = fixture(["check package.json without editing it"], { pass: false, criteria: [{ criterion: "c1", met: false,
    reason: "package.json needs attention", evidence: { path: "owned.txt", line: 1 } }] });
  await runDaemon(made.repo, { adapters: [made.fake], runId: "run-judge-path" });
  const journal = Journal.open(made.repo, "run-judge-path");
  ordinary(journal.read(), journal.readTelemetry().find((r) => r.taskId === "T1")!);
  const judged = of(journal.read(), "gate-result").find((e) => e.data.gate === "acceptance" && e.data.pass === false)!;
  expect(judged.data.judgment).toMatchObject({ criteria: [{ met: false, paths: ["owned.txt"] }] });
  expect(judged.data.details).toContain("package.json needs attention");
  for (const judgment of [[{ met: false, paths: ["package.json"] }, { met: true, paths: ["owned.txt"] }],
    { criteria: [{ met: false, paths: ["package.json"] }, { met: true, paths: ["owned.txt"] }] }]) {
    expect(disposition({ gate: "acceptance", pass: false, details: "owned.txt", meta: { judgment } }))
      .toMatchObject({ kind: "authoring", paths: ["package.json"] });
  }
}, 180_000);

test("test: the daemon journals every failing oracle's record on the acceptance gate row and a replayed round of that red reaches the same disposition as the live round, while an acceptance red row carrying no oracle records hints nothing, so oracle records kept only in memory fail", async () => {
  const made = fixture([
    { oracle: "command", command: ": package.json; echo owned.txt; exit 7" },
    { oracle: "test", test: "checks package.json version", landing: "tests/owned.test.ts" },
    { oracle: "command", command: "echo second-output; exit 9" },
  ]);
  const measured: GateResult[] = [];
  const original = gateRunner.runGates;
  const spy = vi.spyOn(gateRunner, "runGates").mockImplementation(async (...args) => {
    const round = await original(...args);
    measured.push(...round.results.filter((g) => g.gate === "acceptance"));
    return round;
  });
  try {
    await runDaemon(made.repo, { adapters: [made.fake], runId: "run-oracle-replay" });
  } finally { spy.mockRestore(); }
  const journal = Journal.open(made.repo, "run-oracle-replay");
  const rows = journal.read();
  const reds = of(rows, "gate-result").filter((e) => e.data.gate === "acceptance" && e.data.pass === false);
  const live = reds.find((e) => e.data.attempt === 0)!;
  const replayed = reds.find((e) => e.data.attempt === 1)!;
  expect(live.data.oracles).toEqual(measured[0]!.meta?.oracles);
  expect((live.data.oracles as OracleFailure[]).map((o) => [o.index, o.kind, o.failure, o.output])).toEqual([
    [0, "command", "red", "owned.txt\n"], [1, "test", "absent", ""], [2, "command", "red", "second-output\n"],
  ]);
  expect(replayed.data.oracles).toEqual(live.data.oracles);
  expect(replayed.data.replayedFromAttempt).toBe(0);
  expect(of(rows, "gate-replayed").some((e) => e.data.gate === "acceptance" && e.data.attempt === 1)).toBe(true);
  const restore = (e: JournalEvent): GateResult => ({ gate: "acceptance", pass: false, details: readableExcerpt(String(e.data.details)), meta: e.data });
  expect(disposition(restore(replayed))).toEqual(disposition(restore(live)));
  ordinary(rows, journal.readTelemetry().find((r) => r.taskId === "T1")!);
  const repairs = of(rows, "repair-attempt");
  expect(repairs.slice(0, 2).map((e) => e.data.charge)).toEqual([1, 2]);
  expect(disposition({ gate: "acceptance", pass: false, details: "expected true in package.json" })).toMatchObject({ kind: "none", paths: [], diagnostics: [] });
}, 120_000);
