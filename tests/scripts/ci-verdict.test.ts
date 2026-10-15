// v2.8.2 T1 acceptance (ANL-022 §7.1 as amended by §9 P1/P2, D-1974) — the record verdict, the named release
// leaves, the proof reader and the floors sidecar. `tsx scripts/ci/cli.ts verdict|proof|floors` runs over fixture
// records and a scratch repository; the named-leaf case also runs real Vitest over a scratch copy of the
// production configuration, as tests/scripts/ci-oracle.test.ts does.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { readJson } from "../../scripts/ci/json.js";
import { parseRecord } from "../../scripts/ci/reporter.js";
import { ownedFailures, runOwned } from "../helpers/owned-process.js";

// this file lives in tests/scripts/ — the repo root is two levels up
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const TSX = join(repoRoot, "node_modules/.bin/tsx");
const CLI = join(repoRoot, "scripts/ci/cli.ts");
const VITEST = join(repoRoot, "node_modules/vitest/vitest.mjs");
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratchDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
};
/** No inherited Vitest, record, lean-reporter, git-location or lease variables. */
const childEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !key.startsWith("GIT_")
    && !["TICKMARKR_CI_RECORD", "TICKMARKR_CI_LEAN_REPORTERS", "TICKMARKR_REPOSITORY_LEASE_TOKEN", "TICKMARKR_TEST_FORCE_STALL"].includes(key))),
  NO_COLOR: "1", FORCE_COLOR: "0", ...extra,
});
async function owned(cmd: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = childEnv()) {
  const run = await runOwned(cmd, args, { cwd, env, ms: 240_000 });
  const failures = ownedFailures(run, `${cmd} child`);
  if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${run.out}\n${run.err}`);
  return { status: run.exitCode, stdout: run.out, stderr: run.err };
}
const defectsOf = (stdout: string, prefix: string) => stdout.split("\n")
  .filter((line) => line.startsWith(`${prefix} `)).map((line) => readJson(line.slice(prefix.length + 1)) as Record<string, unknown>);

// ---- F3 fixture records
const HEAD = "c".repeat(40);
const RPC = { name: "Error", message: '[vitest-worker]: Timeout calling "onTaskUpdate"', type: "Unhandled Error" };
type Unhandled = { name: string | null; message: string; type: string | null };
type Doc = {
  head?: string | null; reason?: string; unhandled?: Unhandled[];
  files?: [file: string, state?: string][]; tests?: [file: string, name: string, state?: string][];
};
const FILES: [string, string][] = [["tests/a.test.ts", "passed"], ["tests/b.test.ts", "passed"]];
const TESTS: [string, string, string][] = [["tests/a.test.ts", "a > one", "passed"], ["tests/b.test.ts", "b > two", "passed"]];
const recordText = (doc: Doc = {}): string => `${JSON.stringify({
  schema: "tickmarkr-ci-record/2", head: doc.head === undefined ? HEAD : doc.head, shard: null,
  files: (doc.files ?? FILES).map(([file, state = "passed"]) => ({ file, project: "suite", state, durationMs: 1 })),
  reason: doc.reason ?? "passed", unhandled: doc.unhandled ?? [],
  tests: (doc.tests ?? TESTS).map(([file, name, state = "passed"]) => ({ file, project: "suite", name, state })),
})}\n`;

function verdictRunner() {
  const dir = scratchDir("ci-verdict-");
  let n = 0;
  return async (texts: readonly string[], required: readonly string[] = []) => {
    const paths = texts.map((text) => {
      const path = join(dir, `r${n++}.record.json`);
      writeFileSync(path, text);
      return path;
    });
    const run = await owned(TSX, [CLI, "verdict", ...required.flatMap((r) => ["--require-test", r]), ...paths], dir);
    const lines = run.stdout.split("\n").slice(0, -1);
    expect(lines.filter((line) => line.startsWith("RECORD_VERDICT ")), run.stdout).toHaveLength(1);
    return { status: run.status, last: lines.at(-1)!, kinds: defectsOf(run.stdout, "RECORD_DEFECT").map((d) => d.kind), defects: defectsOf(run.stdout, "RECORD_DEFECT"), paths };
  };
}

test("test: the record verdict reads CLEAN for a passing run and RPC ONLY when its only unhandled errors carry the observed shape, name Error, the exact worker timeout message and type Unhandled Error, with the reason still passed, and RED for a failed or unfinished state, an interrupted reason, a timeout beside a failed assertion, each near-miss shape including another type and a failed reason nothing explains, including across the records one invocation wrote, where a record whose reason is failed beside another record holding only exact RPC timeouts reads RED and never RPC ONLY (R-P1 R-P2 R-F1 R-F2 R-F3 R-F4 R-F9)", { timeout: 240_000 }, async () => {
  const verdict = verdictRunner();

  // R-P1: a passing run
  const clean = await verdict([recordText()]);
  expect([clean.status, clean.last, clean.kinds]).toEqual([0, "RECORD_VERDICT verdict=CLEAN files=2 tests=2 failed=0 unfinished=0 unhandled=0 rpc=0 reason=passed", []]);
  // R-P2: every file and test passed, the reason still passed, the only unhandled errors exact RPC timeouts
  const rpc = await verdict([recordText({ unhandled: [RPC, { ...RPC, message: '[vitest-worker]: Timeout calling "onAfterSuiteRun"' }] })]);
  expect([rpc.status, rpc.last, rpc.kinds]).toEqual([0, "RECORD_VERDICT verdict=RPC_ONLY files=2 tests=2 failed=0 unfinished=0 unhandled=2 rpc=2 reason=passed", []]);
  // across the two records of one proof, one of them RPC-only
  expect((await verdict([recordText(), recordText({ unhandled: [RPC] })])).last).toBe("RECORD_VERDICT verdict=RPC_ONLY files=4 tests=4 failed=0 unfinished=0 unhandled=1 rpc=1 reason=passed");

  // R-F1: a test that ran past its timeout is a failed test in a failed file
  const timedOut = await verdict([recordText({ reason: "failed", files: [["tests/a.test.ts", "failed"], ["tests/b.test.ts"]], tests: [["tests/a.test.ts", "a > one", "failed"], ["tests/b.test.ts", "b > two"]] })]);
  expect([timedOut.status, timedOut.last]).toEqual([1, "RECORD_VERDICT verdict=RED files=2 tests=2 failed=2 unfinished=0 unhandled=0 rpc=0 reason=failed"]);
  expect(timedOut.defects).toEqual([ // sorted lines: the test's entry continues (",") where its file's closes ("}")
    { kind: "failed", source: timedOut.paths[0], file: "tests/a.test.ts", project: "suite", name: "a > one" },
    { kind: "failed", source: timedOut.paths[0], file: "tests/a.test.ts", project: "suite" },
  ]);
  // a failed test alone (its file's state unset by a crash) is still failed
  expect((await verdict([recordText({ reason: "failed", tests: [["tests/a.test.ts", "a > one", "failed"]] })])).kinds).toEqual(["failed"]);
  // R-F2: one failed assertion plus an RPC timeout — row 2 before row 8
  const mixed = await verdict([recordText({ reason: "failed", unhandled: [RPC], files: [["tests/a.test.ts", "failed"], ["tests/b.test.ts"]], tests: [["tests/a.test.ts", "a > one", "failed"]] })]);
  expect([mixed.status, mixed.last]).toEqual([1, "RECORD_VERDICT verdict=RED files=2 tests=1 failed=2 unfinished=0 unhandled=1 rpc=1 reason=failed"]);
  expect(mixed.kinds).toEqual(["failed", "failed"]);
  // unfinished: a pending or queued file, a pending test
  for (const [doc, state] of [
    [{ files: [["tests/a.test.ts", "pending"], ["tests/b.test.ts"]] }, "pending"],
    [{ files: [["tests/a.test.ts", "queued"], ["tests/b.test.ts"]] }, "queued"],
    [{ tests: [["tests/a.test.ts", "a > one", "pending"], ["tests/b.test.ts", "b > two"]] }, "pending"],
  ] as [Doc, string][]) {
    const unfinished = await verdict([recordText({ ...doc, unhandled: [RPC] })]);
    expect([unfinished.status, unfinished.kinds], state).toEqual([1, ["unfinished"]]);
    expect(unfinished.defects[0]).toMatchObject({ kind: "unfinished", state });
  }
  // an interrupted run, even with every file passed and an RPC-only error list
  const interrupted = await verdict([recordText({ reason: "interrupted", unhandled: [RPC] })]);
  expect([interrupted.status, interrupted.kinds, interrupted.last]).toEqual([1, ["interrupted"], "RECORD_VERDICT verdict=RED files=2 tests=2 failed=0 unfinished=0 unhandled=1 rpc=1 reason=interrupted"]);

  // R-F3 and R-F4: an ordinary unhandled error, and every near miss of the exact shape, beside the real one
  for (const near of [
    { name: "TypeError", message: "boom", type: "Unhandled Error" },
    { ...RPC, name: "TypeError" },
    { ...RPC, message: `${RPC.message}\nsecond line` },
    { ...RPC, message: `AssertionError: expected ${RPC.message}` },
    { ...RPC, message: `Error: ${RPC.message}` },
    { ...RPC, message: `${RPC.message} ` },
    { ...RPC, message: '[vitest-worker]: Timeout calling "on_Task"' },
    { ...RPC, message: '[vitest-worker]: Timeout calling ""' },
    { ...RPC, type: "Unhandled Rejection" },
    { ...RPC, type: "Uncaught Exception" },
    { ...RPC, type: null },
    { ...RPC, name: null },
  ]) {
    const red = await verdict([recordText({ unhandled: [RPC, near] })]);
    expect([red.status, red.kinds], JSON.stringify(near)).toEqual([1, ["unhandled"]]);
    expect(red.defects[0]).toEqual({ kind: "unhandled", source: red.paths[0], ...near });
    expect(red.last).toBe("RECORD_VERDICT verdict=RED files=2 tests=2 failed=0 unfinished=0 unhandled=2 rpc=1 reason=passed");
  }
  // R-F9: a failed reason nothing in the record explains
  const unexplained = await verdict([recordText({ reason: "failed" })]);
  expect([unexplained.status, unexplained.defects]).toEqual([1, [{ kind: "unexplained-failure", source: unexplained.paths[0] }]]);
  expect(unexplained.last).toBe("RECORD_VERDICT verdict=RED files=2 tests=2 failed=0 unfinished=0 unhandled=0 rpc=0 reason=failed");
  // only a record's own unhandled entries explain its failed reason: another record's RPC timeout never clears it
  const laundered = await verdict([recordText({ reason: "failed" }), recordText({ unhandled: [RPC] })]);
  expect([laundered.status, laundered.defects]).toEqual([1, [{ kind: "unexplained-failure", source: laundered.paths[0] }]]);
  expect(laundered.last).toBe("RECORD_VERDICT verdict=RED files=4 tests=4 failed=0 unfinished=0 unhandled=1 rpc=1 reason=mixed");

  // row 1: an absent, unparsable or F2 record, a null head and unequal heads are UNREADABLE, never CLEAN
  const UNKNOWN = "RECORD_VERDICT verdict=UNREADABLE files=UNREADABLE tests=UNREADABLE failed=UNREADABLE unfinished=UNREADABLE unhandled=UNREADABLE rpc=UNREADABLE reason=UNREADABLE";
  const f2 = `${JSON.stringify({ schema: "tickmarkr-ci-record/1", head: HEAD, shard: null, files: [{ file: "tests/a.test.ts", project: "suite", state: "passed", durationMs: 1 }] })}\n`;
  for (const [texts, kinds] of [
    [["{"], ["unreadable"]], [[f2], ["unreadable"]], [[recordText({ head: null })], ["wrong-head"]],
    [[recordText(), recordText({ head: "d".repeat(40) })], ["wrong-head", "wrong-head"]],
  ] as [string[], string[]][]) {
    const unreadable = await verdict(texts);
    expect([unreadable.status, unreadable.last, unreadable.kinds]).toEqual([2, UNKNOWN, kinds]);
  }
  const dir = scratchDir("ci-verdict-absent-");
  const absent = await owned(TSX, [CLI, "verdict", join(dir, "absent.record.json")], dir);
  expect([absent.status, absent.stdout.trimEnd().split("\n").at(-1)]).toEqual([2, UNKNOWN]);
});

// ---- the named release leaves (ANL-022 §7.1 L1, L2): mimics at the real paths and titles, run by real Vitest
const L1_FILE = "tests/e2e/forced-stall.e2e.test.ts";
const L2_FILE = "tests/e2e/orca-smoke.e2e.test.ts";
const titleIn = (file: string, pattern: RegExp): string => {
  const match = pattern.exec(readFileSync(join(repoRoot, file), "utf8"));
  if (!match) throw new Error(`${file}: ${pattern} not found`);
  return JSON.parse(match[1]!) as string;
};
const L1_TITLE = titleIn(L1_FILE, /test\.skipIf\(process\.env\.TICKMARKR_TEST_FORCE_STALL !== "1"\)\(("[^"]+")/);
const L1_CONTROL = titleIn(L1_FILE, /\ntest\(("test: the enabled forced-stall release proof returns[^"]+")/);
const L2_DESCRIBE = titleIn(L2_FILE, /\ndescribe\(("e2e: orca driver smoke")/);
const L2_TITLE = titleIn(L2_FILE, /const LIVE_TITLE = ("[^"]+")/);
const L1 = `${L1_FILE}::${L1_TITLE}`;
const L2 = `${L2_FILE}::${L2_DESCRIBE} > ${L2_TITLE}`;

/** A scratch copy of the production configuration (whole scripts/, the real setup file) over `fixtures`, committed. */
async function productionScratch(fixtures: Record<string, string>): Promise<string> {
  const scratch = scratchDir("ci-verdict-production-");
  for (const directory of ["src", "scripts"]) cpSync(join(repoRoot, directory), join(scratch, directory), { recursive: true });
  for (const file of ["package.json", "tsconfig.json", "vitest.config.ts", "tests/setup.ts", "tests/helpers/tmprepo.ts"]) {
    mkdirSync(dirname(join(scratch, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(scratch, file));
  }
  symlinkSync(realpathSync(join(repoRoot, "node_modules")), join(scratch, "node_modules"), "dir");
  for (const [file, source] of Object.entries(fixtures)) {
    mkdirSync(dirname(join(scratch, file)), { recursive: true });
    writeFileSync(join(scratch, file), source);
  }
  const env = childEnv({ GIT_CEILING_DIRECTORIES: dirname(scratch) });
  for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "scratch"]]) {
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: scratch, env, stdio: "ignore" });
  }
  return scratch;
}

test("test: a required release leaf counts only when its test entry is recorded passed, so the forced-stall leaf skipped by its environment gate, the live Orca leg skipped by ctx skip, and a filter matching nothing that records every leaf skipped with reason passed and exit zero each read RED, a required name the record lacks reads RED, and the passed leaf reads CLEAN (R-P7 R-F10 R-F11 R-F12 R-F16)", { timeout: 300_000 }, async () => {
  const scratch = await productionScratch({
    // L1: the always-running control beside the leaf its environment gate skips (skipIf)
    [L1_FILE]: `import { test } from "vitest";
test(${JSON.stringify(L1_CONTROL)}, () => {});
test.skipIf(process.env.TICKMARKR_TEST_FORCE_STALL !== "1")(${JSON.stringify(L1_TITLE)}, () => {});
`,
    // L2: always-running controls beside the live leg, which skips itself through ctx.skip() without its gate
    [L2_FILE]: `import { describe, test } from "vitest";
describe(${JSON.stringify(L2_DESCRIBE)}, () => {
  test("control: the pure leg", () => {});
  test(${JSON.stringify(L2_TITLE)}, (ctx) => { if (process.env.LIVE_GATE !== "1") ctx.skip(); });
});
`,
  });
  const vitest = async (name: string, args: readonly string[], extra: NodeJS.ProcessEnv = {}) => {
    const path = join(scratch, `${name}.record.json`);
    const run = await owned(process.execPath, [VITEST, "run", ...args], scratch,
      childEnv({ VITEST_MAX_FORKS: "1", GIT_CEILING_DIRECTORIES: dirname(scratch), TICKMARKR_CI_RECORD: path, ...extra }));
    return { status: run.status, output: `${run.stdout}${run.stderr}`, path, record: parseRecord(readJson(readFileSync(path, "utf8")), path) };
  };
  const verdict = async (path: string, required: readonly string[]) => {
    const run = await owned(TSX, [CLI, "verdict", ...required.flatMap((r) => ["--require-test", r]), path], scratch);
    return { status: run.status, last: run.stdout.trimEnd().split("\n").at(-1)!, defects: defectsOf(run.stdout, "RECORD_DEFECT") };
  };
  const stateOf = (record: ReturnType<typeof parseRecord>, file: string, name: string) =>
    record.tests.filter((t) => t.file === file && t.name === name).map((t) => t.state);

  // gates unset: every file passed by its controls, both leaves skipped — a file-level reading would accept it
  const gated = await vitest("gated", []);
  expect(gated.status, gated.output).toBe(0);
  expect(gated.record.reason).toBe("passed");
  expect(gated.record.files.map(({ file, state }) => [file, state])).toEqual([[L1_FILE, "passed"], [L2_FILE, "passed"]]);
  expect(stateOf(gated.record, L1_FILE, L1_TITLE)).toEqual(["skipped"]);
  expect(stateOf(gated.record, L1_FILE, L1_CONTROL)).toEqual(["passed"]);
  expect(stateOf(gated.record, L2_FILE, `${L2_DESCRIBE} > ${L2_TITLE}`)).toEqual(["skipped"]);
  expect((await verdict(gated.path, [])).status).toBe(0);
  // R-F11 (skipIf) and R-F10 / R-F16 (ctx.skip)
  for (const [leaf, file, project, name] of [
    [L1, L1_FILE, "keys-ledger", L1_TITLE], [L2, L2_FILE, "suite", `${L2_DESCRIBE} > ${L2_TITLE}`],
  ] as const) {
    const red = await verdict(gated.path, [leaf]);
    expect([red.status, red.defects], leaf).toEqual([1, [{ kind: "required-not-passed", source: gated.path, file, project, name, state: "skipped" }]]);
    expect(red.last).toMatch(/^RECORD_VERDICT verdict=RED .* reason=passed$/);
  }
  // R-F12: a required fullName that drifted from the file — the record holds no such entry
  const drifted = await verdict(gated.path, [`${L1_FILE}::${L1_TITLE} (renamed)`]);
  expect([drifted.status, drifted.defects]).toEqual([1, [{ kind: "required-absent", file: L1_FILE, name: `${L1_TITLE} (renamed)` }]]);

  // R-P7: both gates set, both leaves recorded passed
  const enabled = await vitest("enabled", [], { TICKMARKR_TEST_FORCE_STALL: "1", LIVE_GATE: "1" });
  expect(enabled.status, enabled.output).toBe(0);
  const both = await verdict(enabled.path, [L1, L2]);
  expect([both.status, both.defects]).toEqual([0, []]);
  expect(both.last).toBe("RECORD_VERDICT verdict=CLEAN files=2 tests=4 failed=0 unfinished=0 unhandled=0 rpc=0 reason=passed");

  // R-F12: a -t filter that selects nothing — every leaf recorded skipped, reason passed, exit 0 — reads RED
  const filtered = await vitest("filtered", ["-t", "no test carries this title"], { TICKMARKR_TEST_FORCE_STALL: "1", LIVE_GATE: "1" });
  expect(filtered.status, filtered.output).toBe(0);
  expect(filtered.record.reason).toBe("passed");
  expect(filtered.record.tests.map(({ state }) => state)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
  const none = await verdict(filtered.path, [L1, L2]);
  expect(none.status).toBe(1);
  expect(none.defects.map(({ kind, file }) => [kind, file])).toEqual([[`required-not-passed`, L1_FILE], [`required-not-passed`, L2_FILE]]);
});

// ---- the proof reader over a downloaded proof group, and the floors producer's own sidecar
const SRC_DIRS = ["graph", "route", "gates", "run", "config", "compile", "adapters", "drivers", "cli"];
const counters = (pct: number) => ({ total: 100, covered: pct, skipped: 0, pct });
const summaryFor = (pct: number) => JSON.stringify(Object.fromEntries([
  ["total", { lines: counters(pct), statements: counters(pct), functions: counters(pct), branches: counters(pct) }],
  ...SRC_DIRS.map((dir) => [join(repoRoot, `src/${dir}/a.ts`), { lines: counters(pct), statements: counters(pct), functions: counters(pct), branches: counters(pct) }]),
]));

test("test: the proof reader recomputes the set from the commit's own manifest over the downloaded records and reads a green group GREEN with expected equal to actual, reds a missing, duplicated or unknown file, an RPC-only group whose stranded module is absent and a red floors sidecar, and reads a record of another commit and a floors sidecar that is absent, disagrees with its own counters or carries a floor line with empty or malformed metrics UNREADABLE, while the floors producer writes that sidecar itself with its exit status unchanged (R-P0 R-F13 R-F14 R-F15)", { timeout: 300_000 }, async () => {
  // the floors producer: the same lines on stdout and in its own --out file, its exit status the verdict's
  const work = scratchDir("ci-proof-work-");
  const floorsRun = async (summary: string, extra: readonly string[] = []) => {
    const summaryPath = join(work, `summary-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(summaryPath, summary);
    const out = join(work, `floors-${Math.random().toString(36).slice(2)}.out`);
    const run = await owned(TSX, [CLI, "floors", summaryPath, "--out", out, ...extra], repoRoot);
    return { status: run.status, stdout: run.stdout, out };
  };
  const green = await floorsRun(summaryFor(99));
  expect(green.status, green.stdout).toBe(0);
  expect(readFileSync(green.out, "utf8")).toBe(green.stdout);
  expect(green.stdout.trimEnd().split("\n")).toHaveLength(7);
  expect(green.stdout.trimEnd().split("\n").at(-1)).toBe("COVERAGE_FLOORS verdict=GREEN floors=6 failing=0");
  const redFloors = await floorsRun(summaryFor(50));
  expect(redFloors.status).toBe(1);
  expect(readFileSync(redFloors.out, "utf8")).toBe(redFloors.stdout);
  expect(redFloors.stdout.trimEnd().split("\n").at(-1)).toBe("COVERAGE_FLOORS verdict=RED floors=6 failing=6");
  const brokenFloors = await floorsRun("{");
  expect(brokenFloors.status).toBe(2);
  expect(readFileSync(brokenFloors.out, "utf8")).toBe("COVERAGE_FLOORS verdict=UNREADABLE floors=UNREADABLE failing=UNREADABLE\n");

  // the commit: ten tracked tests/**/*.test.ts files beside a helper and a source test outside the manifest
  const repo = scratchDir("ci-proof-repo-");
  const manifest = Array.from({ length: 10 }, (_, i) => (i < 6 ? `tests/t${i}.test.ts` : `tests/sub/deep/t${i}.test.ts`));
  for (const file of [...manifest, "tests/helper.ts", "src/x.test.ts", "tests/fixture.test.tsx"]) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), "");
  }
  const env = childEnv({ GIT_CEILING_DIRECTORIES: dirname(repo) });
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env, encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "proof subject");
  const sha = git("rev-parse", "HEAD");
  // a later commit and an untracked file never change the subject's manifest
  writeFileSync(join(repo, "tests/later.test.ts"), "");
  git("add", "-A");
  git("commit", "-qm", "later");
  writeFileSync(join(repo, "tests/untracked.test.ts"), "");
  const later = git("rev-parse", "HEAD");

  const fileRows = (files: readonly string[]): [string][] => files.map((file) => [file]);
  const testRows = (files: readonly string[]): [string, string][] => files.map((file) => [file, `${file} > case`]);
  const group = (records: Record<string, Doc>, floors: string | null = green.stdout): string => {
    const dir = scratchDir("ci-proof-group-");
    for (const [name, doc] of Object.entries(records)) writeFileSync(join(dir, `${name}.record.json`), recordText({ head: sha, ...doc }));
    if (floors !== null) writeFileSync(join(dir, "floors.out"), floors);
    return dir;
  };
  const split = (files: readonly string[], extra: Doc = {}): Record<string, Doc> => ({
    coverage: { files: fileRows(files.slice(0, 7)), tests: testRows(files.slice(0, 7)), ...extra },
    singlefork: { files: fileRows(files.slice(7)), tests: testRows(files.slice(7)) },
  });
  const proof = async (dirs: readonly string[], head = sha) => {
    const run = await owned(TSX, [CLI, "proof", "--head", head, "--repo", repo, ...dirs], work);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines.at(-1), run.stdout).toMatch(/^PROOF_RUN verdict=(GREEN|RED|UNREADABLE)$/);
    return { status: run.status, proofs: lines.filter((line) => line.startsWith("PROOF ")), run: lines.at(-1), defects: defectsOf(run.stdout, "PROOF_DEFECT") };
  };

  // R-P0: two OS groups, each two original invocation records (one RPC-only) and its producer's own sidecar
  const linux = group(split(manifest, { unhandled: [RPC] }));
  const macos = group(split(manifest));
  const allGreen = await proof([linux, macos]);
  expect([allGreen.status, allGreen.run, allGreen.defects]).toEqual([0, "PROOF_RUN verdict=GREEN", []]);
  expect(allGreen.proofs).toEqual([
    `PROOF dir=${linux} verdict=GREEN head=${sha} expected=10 actual=10 records=2 record=RPC_ONLY floors=GREEN`,
    `PROOF dir=${macos} verdict=GREEN head=${sha} expected=10 actual=10 records=2 record=CLEAN floors=GREEN`,
  ]);
  // the later commit's own manifest holds eleven files: the same records read RED there (and their head is not its)
  expect((await proof([macos], later)).proofs[0]).toMatch(/ verdict=UNREADABLE .* expected=11 actual=10 /);

  // R-F13: nine of ten, one file in two records, an unknown file, a record of another commit
  const nine = await proof([group(split(manifest.slice(0, 9)))]);
  expect([nine.status, nine.defects.map((d) => [d.kind, d.file])]).toEqual([1, [["missing", manifest[9]]]]);
  expect(nine.proofs[0]).toMatch(/ verdict=RED .* expected=10 actual=9 records=2 record=CLEAN floors=GREEN$/);
  const twice = await proof([group({ ...split(manifest), again: { files: fileRows([manifest[0]!]), tests: [] } })]);
  expect([twice.status, twice.defects.map((d) => [d.kind, d.file])]).toEqual([1, [["duplicate", manifest[0]]]]);
  expect(twice.proofs[0]).toMatch(/ expected=10 actual=11 records=3 /);
  const unknown = await proof([group({ ...split(manifest), stray: { files: fileRows(["tests/later.test.ts"]), tests: [] } })]);
  expect([unknown.status, unknown.defects.map((d) => [d.kind, d.file])]).toEqual([1, [["unknown", "tests/later.test.ts"]]]);
  const other = await proof([group({ coverage: { head: later, files: fileRows(manifest.slice(0, 7)) }, singlefork: { head: later, files: fileRows(manifest.slice(7)) } })]);
  expect([other.status, other.run]).toEqual([2, "PROOF_RUN verdict=UNREADABLE"]);
  expect(new Set(other.defects.map((d) => d.kind))).toEqual(new Set(["wrong-head"]));
  // R-F15: an RPC timeout stranded a module the reporter never saw — the record verdict alone reads RPC_ONLY
  const stranded = await proof([group(split(manifest.filter((_, i) => i !== 8), { unhandled: [RPC] }))]);
  expect([stranded.status, stranded.defects.map((d) => [d.kind, d.file])]).toEqual([1, [["missing", manifest[8]]]]);
  expect(stranded.proofs[0]).toMatch(/ verdict=RED .* record=RPC_ONLY floors=GREEN$/);
  // a RED record verdict reds the group
  expect((await proof([group(split(manifest, { reason: "failed" }))])).status).toBe(1);
  // one record's unexplained failure beside the other record's RPC timeout, the set complete: RED, never GREEN
  const laundered = await proof([group({ ...split(manifest, { reason: "failed" }), singlefork: { ...split(manifest).singlefork!, unhandled: [RPC] } })]);
  expect([laundered.status, laundered.defects.map((d) => d.kind)]).toEqual([1, ["unexplained-failure"]]);
  expect(laundered.proofs[0]).toMatch(/ verdict=RED .* expected=10 actual=10 records=2 record=RED floors=GREEN$/);

  // R-F14: a red sidecar, an absent one, one whose floors= or failing= disagrees with its own lines
  const floorsVerdict = async (text: string | null) => {
    const result = await proof([group(split(manifest), text)]);
    return [result.status, /floors=(\w+)$/.exec(result.proofs[0]!)?.[1]];
  };
  expect(await floorsVerdict(redFloors.stdout)).toEqual([1, "RED"]);
  expect(await floorsVerdict(null)).toEqual([2, "UNREADABLE"]);
  expect(await floorsVerdict(green.stdout.replace("floors=6", "floors=5"))).toEqual([2, "UNREADABLE"]);
  expect(await floorsVerdict(redFloors.stdout.replace("failing=6", "failing=5"))).toEqual([2, "UNREADABLE"]);
  expect(await floorsVerdict(redFloors.stdout.replace("verdict=RED", "verdict=GREEN").replace("failing=6", "failing=0"))).toEqual([2, "UNREADABLE"]);
  expect(await floorsVerdict(brokenFloors.stdout)).toEqual([2, "UNREADABLE"]);
  expect(await floorsVerdict(green.stdout.split("\n").slice(1).join("\n"))).toEqual([2, "UNREADABLE"]);
  // a COVERAGE_FLOOR line must agree with itself: its metrics, its counters and its defects
  const doctored = (text: string, edit: (entry: Record<string, unknown>) => Record<string, unknown>, footer?: string) => text.split("\n").map((line) =>
    line.startsWith("COVERAGE_FLOOR ") ? `COVERAGE_FLOOR ${JSON.stringify(edit(JSON.parse(line.slice("COVERAGE_FLOOR ".length)) as Record<string, unknown>))}`
    : footer !== undefined && line.startsWith("COVERAGE_FLOORS ") ? footer : line).join("\n");
  expect(await floorsVerdict(doctored(green.stdout, (entry) => entry))).toEqual([0, "GREEN"]);
  for (const [label, text] of [
    ["empty metrics", doctored(green.stdout, (entry) => ({ ...entry, metrics: {} }))],
    ["a metric that is not a check", doctored(green.stdout, (entry) => ({ ...entry, metrics: { lines: "garbage" } }))],
    ["an unknown metric", doctored(green.stdout, (entry) => ({ ...entry, metrics: { ...(entry.metrics as object), mutants: { pct: 99, floor: 80, ok: true } } }))],
    ["ok that disagrees with pct and floor", doctored(green.stdout, (entry) => ({ ...entry, metrics: { lines: { pct: 50, floor: 80, ok: true } } }))],
    ["a red line's defects removed, footer GREEN", doctored(redFloors.stdout, (entry) => ({ ...entry, defects: [] }), "COVERAGE_FLOORS verdict=GREEN floors=6 failing=0")],
    ["no file and no defect", doctored(green.stdout, (entry) => ({ ...entry, files: 0, statements: 0 }))],
    ["zero statements and no defect", doctored(green.stdout, (entry) => ({ ...entry, statements: 0 }))],
    ["an unknown defect kind", doctored(redFloors.stdout, (entry) => ({ ...entry, defects: ["slow"] }))],
  ] as const) expect(await floorsVerdict(text), label).toEqual([2, "UNREADABLE"]);
  // one UNREADABLE group makes the whole proof UNREADABLE beside a green one
  const mixedRun = await proof([linux, group(split(manifest), null)]);
  expect([mixedRun.status, mixedRun.run]).toEqual([2, "PROOF_RUN verdict=UNREADABLE"]);
});
