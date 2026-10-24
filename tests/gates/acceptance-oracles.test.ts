import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { acceptanceGate, type OracleFailure } from "../../src/gates/acceptance.js";
import type { GateResult } from "../../src/gates/types.js";
import { validateGraph, type AcceptanceItem } from "../../src/graph/schema.js";
import { resetLiveSuiteCountForTests, runDaemon, setLiveSuiteCountForTests } from "../../src/run/daemon.js";
import { resetHostLatencySampleForTests, setHostLatencySampleForTests } from "../../src/run/host-health.js";
import { Journal } from "../../src/run/journal.js";
import { classifyRepairDisposition } from "../../src/run/repair-disposition.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

// Queue rows 234(b)/235 (D-2134): real runner evidence, ordered aggregation and zero-token judging.
// Queue rows 234(b)/235 (D-2134): admission is healthy and idle in these oracle fixtures;
// spawning host probes per command adds unrelated process pressure to deadline-sensitive suites.
beforeEach(() => {
  setHostLatencySampleForTests(async () => 20);
  setLiveSuiteCountForTests(async () => 0);
});
afterEach(() => {
  resetHostLatencySampleForTests();
  resetLiveSuiteCountForTests();
});

const named = (title: string, landing: string): AcceptanceItem => ({ oracle: "test", test: title, landing });
const records = (red: GateResult) => red.meta?.oracles as OracleFailure[];
function realRepo(files: Record<string, string> = {}) {
  const repo = makeRepo({
    ".gitignore": "node_modules/\n*.receipt\n",
    "package.json": JSON.stringify({ type: "module", scripts: { test: "vitest run --globals --configLoader runner" } }),
    "vitest.config.mjs": 'import { appendFileSync } from "node:fs";\nappendFileSync("started.receipt", "runner\\n");\nexport default {};\n',
    "owned.txt": "before\n",
    ...files,
  });
  symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"), "dir");
  return repo;
}
function judge() {
  const path = join(makeTestTempDir("oracle-judge-"), "script.json");
  writeFileSync(path, JSON.stringify({ tasks: {}, judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] } }));
  const adapter = new FakeAdapter(path);
  return { adapter, dispatched: vi.spyOn(adapter, "headlessCommand"), model: "fake-1" };
}
function gate(repo: string, acceptance: AcceptanceItem[], seat = judge(), testCmd: string | undefined = "npm test", baseRef = "HEAD") {
  const task = validateGraph({ version: 1, spec: { source: "native", paths: ["p"], hash: "h" },
    tasks: [T("T1", { acceptance })] }).tasks[0]!;
  return acceptanceGate(task, repo, baseRef, seat, undefined, { testCmd });
}

test("test: the acceptance gate over a real runner with two test oracles whose suite files are both absent, and with an oracle whose suite holds no test of its title beside one whose suite is absent, returns one red naming every failing oracle with its own cause and starts no runner for an absent suite, so a gate that stops at the first failing oracle fails", async () => {
  const repo = realRepo({ "tests/present.test.ts": 'test("another title", () => expect(1).toBe(1));\n' });
  const a = named("first title", "tests/first.test.ts");
  const b = named("second title", "tests/second.test.ts");
  const seat = judge();
  const single = await gate(repo, [a], seat);
  expect(single.details).toBe('oracle failed: test "first title" in tests/first.test.ts — suite file tests/first.test.ts is absent from the worktree or is not a regular file; the test command never started');
  const absent = await gate(repo, [a, { oracle: "judge", text: "looks right" }, b], seat);
  expect(absent.pass).toBe(false);
  expect(absent.details).toBe(single.details + '\noracle failed: test "second title" in tests/second.test.ts — suite file tests/second.test.ts is absent from the worktree or is not a regular file; the test command never started');
  expect(records(absent)).toEqual([
    { index: 0, kind: "test", criterion: "first title", landing: "tests/first.test.ts", failure: "absent", output: "" },
    { index: 2, kind: "test", criterion: "second title", landing: "tests/second.test.ts", failure: "absent", output: "" },
  ]);
  expect(existsSync(join(repo, "started.receipt"))).toBe(false);
  const untitled = await gate(repo, [named("missing title", "tests/present.test.ts"), b, "judge this"], seat);
  expect(untitled.pass).toBe(false);
  expect(records(untitled).map((o) => [o.index, o.failure])).toEqual([[0, "untitled"], [1, "absent"]]);
  expect(untitled.details).toContain("no passing test of that title in tests/present.test.ts");
  expect(untitled.details).toContain('test "second title" in tests/second.test.ts');
  expect(readFileSync(join(repo, "started.receipt"), "utf8")).toBe("runner\n");
  expect(seat.dispatched).not.toHaveBeenCalled();
}, 60_000);

test("test: a failing command oracle followed by an oracle whose present suite fails, a second failing command oracle and a judge criterion runs all three deterministic oracles and yields one red naming each with its own output in declaration order without dispatching the judge, while a red with a single failing oracle keeps its details byte-identical to the base rendering, so a loop that stops after the first runnable red, falls through into the judge or rewrites a single red fails", async () => {
  const repo = realRepo({ "tests/red.test.ts": 'import { appendFileSync } from "node:fs";\ntest("suite fails", () => { appendFileSync("order.receipt", "suite\\n"); expect("suite-output").toBe("expected"); });\n' });
  const first: AcceptanceItem = { oracle: "command", command: "echo first >> order.receipt; echo first-output; exit 7" };
  const last: AcceptanceItem = { oracle: "command", command: "echo last >> order.receipt; echo last-output >&2; exit 9" };
  const seat = judge();
  const red = await gate(repo, [first, named("suite fails", "tests/red.test.ts"), last, "judge this"], seat);
  expect(red.pass).toBe(false);
  expect(records(red).map((o) => [o.index, o.kind, o.failure])).toEqual([[0, "command", "red"], [1, "test", "red"], [2, "command", "red"]]);
  expect(records(red).map((o) => o.output)).toEqual(["first-output\n", expect.stringContaining("suite-output"), "last-output\n"]);
  expect(readFileSync(join(repo, "order.receipt"), "utf8")).toBe("first\nsuite\nlast\n");
  expect(red.details.indexOf("first-output")).toBeLessThan(red.details.indexOf("suite-output"));
  expect(red.details.indexOf("suite-output")).toBeLessThan(red.details.indexOf("last-output"));
  expect(seat.dispatched).not.toHaveBeenCalled();
  const single = await gate(repo, [first], seat);
  expect(single.details).toBe(`oracle failed: $ ${first.command} (exit 7)\nfirst-output`);
  const missingRunner = await gate(repo, [named("no runner", "tests/red.test.ts"), last, "judge this"], seat, "");
  expect(records(missingRunner).map((o) => o.failure)).toEqual(["no-runner", "red"]);
  expect(missingRunner.details).toContain('oracle failed: test "no runner" — no test command configured to run it (failing closed)');
  expect(seat.dispatched).not.toHaveBeenCalled();

  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "owned.txt"), "after\n");
  writeFileSync(join(repo, "tests/red.test.ts"), 'test("suite passes", () => expect(1).toBe(1));\n');
  execFileSync("git", ["add", "owned.txt", "tests/red.test.ts"], { cwd: repo });
  execFileSync("git", ["commit", "--no-gpg-sign", "-qm", "change"], { cwd: repo });
  const green = await gate(repo, [{ oracle: "command", command: "true" }, named("suite passes", "tests/red.test.ts"), "judge this"], seat, "npm test", base);
  expect(green.pass).toBe(true);
  expect(seat.dispatched).toHaveBeenCalledTimes(1);
}, 60_000);

test("test: a red holding an oracle whose per-file report could not be forwarded, whether it precedes or follows a misplaced oracle, is classified as infrastructure that charges nothing and still names both oracles, so an aggregate keeping only the first failure's classification fails", async () => {
  for (const infraFirst of [true, false]) {
    const acceptance = [named("unverified title", "tests/present.test.ts"), named("absent title", "tests/absent.test.ts")];
    if (!infraFirst) acceptance.reverse();
    const repo = realRepo({ "tests/present.test.ts": 'test("unverified title", () => expect(1).toBe(1));\n' });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "vitest run && echo done" } }));
    const seat = judge();
    const red = await gate(repo, [...acceptance, "judge this"], seat);
    expect(red.meta).toMatchObject({ infra: true, classification: "infra", retryable: false });
    expect(records(red).map((o) => o.failure)).toEqual(infraFirst ? ["unverified", "absent"] : ["absent", "unverified"]);
    expect(red.details).toContain("per-file reporter cannot be forwarded");
    expect(red.details).toContain("tests/absent.test.ts is absent");
    expect(existsSync(join(repo, "started.receipt"))).toBe(false);
    expect(seat.dispatched).not.toHaveBeenCalled();
    expect(classifyRepairDisposition({ results: [red], files: ["owned.txt"], inventory: ["package.json"] })).toMatchObject({ kind: "none", blocker: "infra" });

    const made = setupRepo([T("T1", { files: ["owned.txt", "tests/*.test.ts"], acceptance })], {
      tasks: { T1: [{ shell: `mkdir -p tests && echo '// present suite' > tests/present.test.ts && echo landed > owned.txt && ${COMMIT} landed`, result: { ok: true, summary: "landed" } }] },
    }, 'gates: { build: "true", lint: "true", test: "npm test" }\n');
    writeFileSync(join(made.repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run && echo done" } }));
    execFileSync("git", ["add", "package.json"], { cwd: made.repo });
    execFileSync("git", ["commit", "--no-gpg-sign", "-qm", "runner"], { cwd: made.repo });
    const runId = `run-oracle-infra-${infraFirst}`;
    await runDaemon(made.repo, { adapters: [made.fake], runId });
    const journal = Journal.open(made.repo, runId);
    expect(journal.read().find((e) => e.event === "gate-result" && e.data.gate === "acceptance")?.data).toMatchObject({ infra: true, retryable: false });
    expect(journal.read().filter((e) => e.event === "task-dispatch")).toHaveLength(1);
    expect(journal.readTelemetry().find((r) => r.taskId === "T1")).toMatchObject({ gateFails: 0 });
    expect(journal.read().some((e) => e.event === "scope-authoring" || e.event === "repair-attempt")).toBe(false);
  }
}, 120_000);
