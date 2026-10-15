// v2.7.8 T2 acceptance — duration-balanced shards from a committed, deterministic partition
// (specs/v2.7.8-sharded-ci.spec.md). Real Vitest children run only where a criterion says real or
// production-config, each in a scratch copy of the production configuration that copies the WHOLE
// scripts/ directory (SHARED CONVENTION); everything else drives the pure modules directly.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { TestModule, Vitest } from "vitest/node";
import { readJson } from "../../scripts/ci/json.js";
import CiRecordReporter, { headOf, parseRecord } from "../../scripts/ci/reporter.js";
import LptSequencer, { DURATIONS_FILE, lptShards, readDurations, renderDurations } from "../../scripts/ci/shard.js";
import { CI_RECORD_ENV, CI_RECORD_REPORTER, createVitestConfig } from "../../vitest.config.js";
import { ownedFailures, runOwned } from "../helpers/owned-process.js";

// this file lives in tests/scripts/ — the repo root is two levels up
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const VITEST = join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const passing = (name: string) => `import { test } from "vitest";\ntest(${JSON.stringify(name)}, () => {});\n`;

/** A scratch copy of the production configuration (whole scripts/, the real setup file) over `fixtures`. */
function makeScratch(fixtures: Record<string, string>): string {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ci-shard-")));
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
  return scratch;
}

/** One owned Vitest child in `scratch`: one fork, default reporters, no inherited Vitest or CI variables. */
async function vitestChild(scratch: string, args: readonly string[], extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("VITEST") && key !== CI_RECORD_ENV && key !== "TICKMARKR_CI_LEAN_REPORTERS"));
  const run = await runOwned(process.execPath, [VITEST, "run", ...args], {
    cwd: scratch,
    ms: 120_000,
    // the scratch is no repository: git discovery stops at it, so HEAD reads null and no lease is keyed
    env: { ...env, VITEST_MAX_FORKS: "1", NO_COLOR: "1", FORCE_COLOR: "0", GIT_CEILING_DIRECTORIES: dirname(scratch), ...extra },
  });
  const failures = ownedFailures(run, "vitest child");
  if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${run.out}\n${run.err}`);
  return { status: run.exitCode, output: `${run.out}\n${run.err}` };
}

const cliChild = async (args: readonly string[]) => {
  const run = await runOwned(join(repoRoot, "node_modules", ".bin", "tsx"), [join(repoRoot, "scripts/ci/cli.ts"), ...args], {
    cwd: repoRoot, ms: 120_000, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const failures = ownedFailures(run, "cli child");
  if (failures.length > 0) throw new Error(failures.join("; "));
  return { status: run.exitCode, stdout: run.out, stderr: run.err };
};

const PROBE_NAMES = ["heavy", "a", "b", "c", "d", "e", "f"] as const;
const probe = (name: string) => `tests/probe/${name}.test.ts`;

test("test: a real production-config run sharded one of three over seven fixtures with durations heavy 100000 and a through f 1 each runs heavy alone in shard one and a c e in shard two as lptShards assigns versus Vitest's native equal-count split whose shard one always holds three files", { timeout: 300_000 }, async () => {
  const durations = Object.fromEntries(PROBE_NAMES.map((name) => [probe(name), name === "heavy" ? 100_000 : 1]));
  const scratch = makeScratch(Object.fromEntries(PROBE_NAMES.map((name) => [probe(name), passing(name)])));
  try {
    writeFileSync(join(scratch, DURATIONS_FILE), renderDurations(durations));
    // the same production config with only the sequencer swapped back to Vitest's own
    writeFileSync(join(scratch, "vitest.native.config.ts"), `import { BaseSequencer } from "vitest/node";
import config from "./vitest.config.ts";
export default { ...config, test: { ...config.test, sequence: { sequencer: BaseSequencer } } };\n`);
    const ran = async (config: string, index: number, loader = "bundle"): Promise<string[]> => {
      const report = join(scratch, `report-${config}-${index}.json`);
      const run = await vitestChild(scratch, [
        "--configLoader", loader, "--config", config, "--project", "suite", `--shard=${index}/3`, "--reporter=json", `--outputFile=${report}`,
      ]);
      expect(run.status, run.output).toBe(0);
      const { testResults } = JSON.parse(readFileSync(report, "utf8")) as { testResults: { name: string }[] };
      return testResults.map((result) => relative(scratch, result.name).split("\\").join("/")).sort();
    };
    const planned = lptShards(PROBE_NAMES.map((name) => ({ file: probe(name), project: "suite" })), durations, 3)
      .map((shard) => shard.map((item) => item.file).sort());
    expect(planned).toEqual([[probe("heavy")], [probe("a"), probe("c"), probe("e")], [probe("b"), probe("d"), probe("f")]]);
    expect(await ran("vitest.config.ts", 1)).toEqual(planned[0]);
    // both config loaders: the runner loader's own module runner is closed once the config has loaded
    expect(await ran("vitest.config.ts", 2, "runner")).toEqual(planned[1]);
    // native: sha1 order sliced into ceil(7/3) = 3 files per shard, whatever the durations say
    const native = await ran("vitest.native.config.ts", 1);
    expect(native).toHaveLength(3);
    expect(native).not.toEqual(planned[0]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("test: lptShards assigns longest first to the least-loaded shard with ties by path then lowest index and weighs an unknown file at the lower median of known weights identically for reversed input versus a discovery-order or zero-weight assignment", () => {
  const items = (files: readonly string[], project = "suite") => files.map((file) => ({ file, project }));
  const sets = (shards: { file: string }[][]) => shards.map((shard) => shard.map((item) => item.file).sort());
  const both = (files: readonly string[], durations: Record<string, number>, count: number) => {
    const forward = sets(lptShards(items(files), durations, count));
    expect(sets(lptShards(items([...files].reverse()), durations, count))).toEqual(forward);
    return forward;
  };

  // nothing known: every file weighs 1, so path order (f1 < f10 < f2 …) alternates from the lowest index
  const ten = Array.from({ length: 10 }, (_, i) => `tests/suite/f${i + 1}.test.ts`);
  expect(both(ten, {}, 2)).toEqual([
    ["tests/suite/f1.test.ts", "tests/suite/f2.test.ts", "tests/suite/f4.test.ts", "tests/suite/f6.test.ts", "tests/suite/f8.test.ts"],
    ["tests/suite/f10.test.ts", "tests/suite/f3.test.ts", "tests/suite/f5.test.ts", "tests/suite/f7.test.ts", "tests/suite/f9.test.ts"],
  ]); // discovery order would give f1 f3 f5 f7 f9 | f2 f4 f6 f8 f10
  // longest first, each to the least-loaded shard: 10 | 7 → 7+5 → 10+4 → 12+3
  expect(both(["w10", "w7", "w5", "w4", "w3"], { w10: 10, w7: 7, w5: 5, w4: 4, w3: 3 }, 2)).toEqual([["w10", "w4"], ["w3", "w5", "w7"]]);
  // unknown e weighs the lower median of 40 50 60 100 = 50 and sorts after c (50) by path: a e | b c d.
  // A zero weight would give a d | b c e.
  expect(both(["e", "d", "c", "b", "a"], { a: 100, b: 60, c: 50, d: 40 }, 2)).toEqual([["a", "e"], ["b", "c", "d"]]);
  // a known weight of an absent item is no item weight: only the items' own known weights form the median
  expect(both(["x", "y", "z"], { x: 9, absent: 1000 }, 3)).toEqual([["x"], ["y"], ["z"]]);
  // equal weight and path: the project breaks the tie, and every remaining tie goes to the lowest index
  const tied = lptShards([{ file: "t", project: "suite" }, { file: "t", project: "keys-ledger" }, { file: "t", project: "built-cli" }], {}, 3);
  expect(tied.map((shard) => shard.map((item) => item.project))).toEqual([["built-cli"], ["keys-ledger"], ["suite"]]);
  expect(lptShards(items(["only"]), {}, 3)).toEqual([[{ file: "only", project: "suite" }], [], []]);
  for (const count of [0, -1, 1.5, Number.NaN]) expect(() => lptShards(items(["x"]), {}, count)).toThrow(RangeError);
});

test("test: a sharded run with a malformed or missing durations file fails closed naming the file and the durations command prints the rounded mean of finished entries per path in the closed format byte for byte versus a malformed record exiting 2 with empty stdout", { timeout: 300_000 }, async () => {
  const scratch = makeScratch(Object.fromEntries(["a", "b", "c"].map((name) => [probe(name), passing(name)])));
  const durationsPath = join(scratch, DURATIONS_FILE);
  try {
    // the production seed shards; a malformed or missing table stops the sharded run before any test body
    expect(readDurations(repoRoot)).toEqual({});
    const sharded = () => vitestChild(scratch, ["--project", "suite", "--shard=1/2"]);
    const seeded = await sharded();
    expect(seeded.status, seeded.output).toBe(0);
    for (const [label, write] of [
      ["malformed", () => writeFileSync(durationsPath, '{"schema": "tickmarkr-ci-durations/1", "durationsMs": {"tests/probe/a.test.ts": 0}}\n')],
      ["missing", () => rmSync(durationsPath)],
    ] as const) {
      write();
      const run = await sharded();
      expect(run.status, `${label}\n${run.output}`).not.toBe(0);
      expect(run.output, label).toContain("DurationsError");
      expect(run.output, label).toContain(durationsPath);
      expect(run.output, label).not.toMatch(/Test Files\s+\d+ passed/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // the library reader names the file for every shape F1 refuses
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ci-durations-")));
  try {
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    for (const bad of [
      "", "[]", '{"schema": "tickmarkr-ci-durations/1"}', '{"schema": "tickmarkr-ci-durations/2", "durationsMs": {}}',
      '{"schema": "tickmarkr-ci-durations/1", "durationsMs": {}, "extra": 1}',
      '{"schema": "tickmarkr-ci-durations/1", "durationsMs": {"a": 1.5}}', '{"schema": "tickmarkr-ci-durations/1", "durationsMs": {"/a": 1}}',
      '{"schema": "tickmarkr-ci-durations/1", "durationsMs": {"a/../b": 1}}', '{"schema": "tickmarkr-ci-durations/1", "durationsMs": {"a": 1, "a": 2}}',
    ]) {
      writeFileSync(join(root, DURATIONS_FILE), bad);
      expect(() => readDurations(root), bad).toThrow(expect.objectContaining({ name: "DurationsError", message: expect.stringContaining(join(root, DURATIONS_FILE)) }));
    }
    // consumers accept any key order and whitespace
    writeFileSync(join(root, DURATIONS_FILE), '{"durationsMs":{"b":2,"a":1},"schema":"tickmarkr-ci-durations/1"}');
    expect(readDurations(root)).toEqual({ a: 1, b: 2 });

    // `durations`: per path the rounded mean over passed, failed and skipped entries, minimum 1, keys sorted
    const entry = (file: string, state: string, durationMs: number, project = "suite") => ({ file, project, state, durationMs });
    const record = (files: object[], shard: object | null = null) =>
      `${JSON.stringify({ schema: "tickmarkr-ci-record/2", head: null, shard, files, reason: "passed", unhandled: [], tests: [] })}\n`;
    const one = join(root, "one.record.json");
    const two = join(root, "two.record.json");
    writeFileSync(one, record([
      entry("tests/b.test.ts", "failed", 7), entry("tests/a.test.ts", "passed", 100), entry("tests/c.test.ts", "pending", 999),
      entry("tests/d.test.ts", "queued", 5), entry("tests/e.test.ts", "passed", 0),
    ], { index: 1, count: 2 }));
    writeFileSync(two, record([entry("tests/a.test.ts", "skipped", 101, "keys-ledger"), entry("tests/b.test.ts", "passed", 8)], { index: 2, count: 2 }));
    const table = '{\n  "schema": "tickmarkr-ci-durations/1",\n  "durationsMs": {\n    "tests/a.test.ts": 101,\n    "tests/b.test.ts": 8,\n    "tests/e.test.ts": 1\n  }\n}\n';
    expect(table).toBe(`${JSON.stringify({ schema: "tickmarkr-ci-durations/1", durationsMs: { "tests/a.test.ts": 101, "tests/b.test.ts": 8, "tests/e.test.ts": 1 } }, null, 2)}\n`);
    for (const order of [[one, two], [two, one]]) {
      const run = await cliChild(["durations", ...order]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toBe(table);
    }
    // the printed table is itself a readable F1 file
    writeFileSync(join(root, DURATIONS_FILE), table);
    expect(readDurations(root)).toEqual({ "tests/a.test.ts": 101, "tests/b.test.ts": 8, "tests/e.test.ts": 1 });

    for (const [label, text] of [
      ["syntax", "{"],
      ["repeated key", '{"schema": "tickmarkr-ci-record/2", "schema": "tickmarkr-ci-record/2", "head": null, "shard": null, "files": [], "reason": "passed", "unhandled": [], "tests": []}'],
      // an F2 document is another schema: no F2 record persists across versions
      ["format F2", '{"schema": "tickmarkr-ci-record/1", "head": null, "shard": null, "files": []}'],
      ["unknown reason", record([]).replace('"reason":"passed"', '"reason":"done"')],
      ["test entry without a name", record([]).replace('"tests":[]', '"tests":[{"file":"tests/a.test.ts","project":"suite","state":"passed"}]')],
      ["unhandled entry without a type", record([]).replace('"unhandled":[]', '"unhandled":[{"name":"Error","message":"boom"}]')],
      ["negative duration", record([entry("tests/a.test.ts", "passed", -1)])],
      ["unknown state", record([entry("tests/a.test.ts", "done", 1)])],
      ["noncanonical path", record([entry("./tests/a.test.ts", "passed", 1)])],
      ["shard index above count", record([], { index: 3, count: 2 })],
    ] as const) {
      const bad = join(root, "bad.record.json");
      writeFileSync(bad, text);
      const run = await cliChild(["durations", one, bad]);
      expect(run.status, label).toBe(2);
      expect(run.stdout, label).toBe("");
    }
    const absent = await cliChild(["durations", join(root, "absent.record.json")]);
    expect([absent.status, absent.stdout]).toEqual([2, ""]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The nested runner a fixture starts: its own minimal config, one fork, the fixture's environment minus
// Vitest's per-worker variables — so a record variable the outer fork carried would reach its test body.
const NESTED_FIXTURE = `import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
test("starts a nested runner", async () => {
  const root = process.cwd();
  const observed = join(root, "observed");
  const nested = join(root, "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(observed, "fork.txt"), String(process.env.TICKMARKR_CI_RECORD));
  writeFileSync(join(nested, "vitest.nested.config.mjs"), "export default { test: { include: ['probe.test.mjs'] } };\\n");
  writeFileSync(join(nested, "probe.test.mjs"), 'import { writeFileSync } from "node:fs";\\nimport { test } from "vitest";\\n'
    + "test('probe', () => writeFileSync(" + JSON.stringify(join(observed, "nested.txt")) + ", String(process.env.TICKMARKR_CI_RECORD)));\\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.nested.config.mjs"],
      { cwd: nested, env: { ...env, VITEST_MAX_FORKS: "1" }, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  expect(code).toBe(0);
}, 60_000);
`;

test("test: a production-config run under the record variable writes one record naming its failing fixture failed, rounds fractional diagnostics once after summing and throws by name on a negative one, while a nested runner a test starts inherits no record variable, versus no record with the variable unset", { timeout: 300_000 }, async () => {
  const scratch = makeScratch({
    [probe("pass")]: passing("passes"),
    [probe("fail")]: 'import { test } from "vitest";\ntest("fails", () => { throw new Error("deliberate"); });\n',
    [probe("nested")]: NESTED_FIXTURE,
  });
  const out = join(scratch, "out");
  const observed = join(scratch, "observed");
  const reset = () => {
    for (const dir of [out, observed]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
    }
  };
  try {
    reset();
    const marked = await vitestChild(scratch, [], { [CI_RECORD_ENV]: "out/ci.record.json" }); // relative: resolved at config load
    expect(marked.status, marked.output).toBe(1);
    expect(readdirSync(out)).toEqual(["ci.record.json"]); // one document, no temporary left beside it
    const text = readFileSync(join(out, "ci.record.json"), "utf8");
    expect(text.endsWith("\n") && !text.slice(0, -1).includes("\n")).toBe(true);
    const record = parseRecord(readJson(text), "ci.record.json");
    expect(record).toMatchObject({ schema: "tickmarkr-ci-record/2", head: null, shard: null, reason: "failed", unhandled: [] });
    expect(record.tests.map(({ file, name, state }) => ({ file, name, state }))).toEqual([
      { file: probe("fail"), name: "fails", state: "failed" },
      { file: probe("nested"), name: "starts a nested runner", state: "passed" },
      { file: probe("pass"), name: "passes", state: "passed" },
    ]);
    expect(record.files.map(({ file, project, state }) => ({ file, project, state }))).toEqual([
      { file: probe("fail"), project: "suite", state: "failed" },
      { file: probe("nested"), project: "suite", state: "passed" },
      { file: probe("pass"), project: "suite", state: "passed" },
    ]);
    for (const file of ["fork.txt", "nested.txt"]) expect(readFileSync(join(observed, file), "utf8"), file).toBe("undefined");

    reset();
    const unmarked = await vitestChild(scratch, []);
    expect(unmarked.status, unmarked.output).toBe(1);
    expect(readdirSync(out)).toEqual([]);
    expect(readdirSync(scratch).filter((name) => name.includes("record"))).toEqual([]);
    for (const file of ["fork.txt", "nested.txt"]) expect(readFileSync(join(observed, file), "utf8"), file).toBe("undefined");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // reporters and order with the variable unset are the base's; set, the record reporter joins them
  for (const lean of [false, true]) {
    const unset = createVitestConfig(undefined, lean, undefined).test!;
    expect(unset.reporters).toEqual(lean ? ["dot"] : undefined);
    expect(unset.sequence?.sequencer).toBe(LptSequencer);
    expect(createVitestConfig(undefined, lean, "/r/ci.record.json").test!.reporters)
      .toEqual([lean ? "dot" : "default", [CI_RECORD_REPORTER, { outputFile: "/r/ci.record.json" }]]);
  }
  expect(process.env[CI_RECORD_ENV]).toBeUndefined();
  expect(headOf(repoRoot)).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim());

  // the writer sums the five diagnostics, then rounds once; absent counts 0; negative or non-finite throws by name
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ci-record-")));
  try {
    const module = (file: string, state: string, diagnostic: Record<string, number | undefined>, tests: [string, string][] = []) => ({
      moduleId: join(root, file), project: { name: "suite" }, state: () => state, diagnostic: () => diagnostic,
      children: { allTests: () => tests.map(([fullName, testState]) => ({ fullName, result: () => ({ state: testState }) })) },
    }) as unknown as TestModule;
    const fifths = { environmentSetupDuration: 0.4, prepareDuration: 0.4, collectDuration: 0.4, setupDuration: 0.4, duration: 0.4 };
    const write = (path: string, modules: TestModule[]) => {
      const reporter = new CiRecordReporter({ outputFile: path });
      reporter.onInit({ config: { root, shard: { index: 2, count: 3 } } } as unknown as Vitest);
      reporter.onTestRunEnd(modules, [{ name: "Error", message: "line one\nline two", type: "Unhandled Error", stack: "at x" }, { message: "bare" }], "passed");
    };
    const good = join(root, "good.record.json");
    write(good, [module("tests/z.test.ts", "skipped", { duration: 1.6 }, [["b", "skipped"], ["a", "skipped"]]), module("tests/y.test.ts", "passed", fifths, [["only", "passed"]])]);
    expect(parseRecord(readJson(readFileSync(good, "utf8")), good)).toEqual({
      schema: "tickmarkr-ci-record/2", head: null, shard: { index: 2, count: 3 },
      files: [ // 5 × 0.4 rounds to 2 once summed (0 per diagnostic); an absent diagnostic counts 0
        { file: "tests/y.test.ts", project: "suite", state: "passed", durationMs: 2 },
        { file: "tests/z.test.ts", project: "suite", state: "skipped", durationMs: 2 },
      ],
      // Vitest's order and each WHOLE message; an absent name or type is null, a stack is never kept
      reason: "passed",
      unhandled: [{ name: "Error", message: "line one\nline two", type: "Unhandled Error" }, { name: null, message: "bare", type: null }],
      tests: [ // sorted by file, project, then full name
        { file: "tests/y.test.ts", project: "suite", name: "only", state: "passed" },
        { file: "tests/z.test.ts", project: "suite", name: "a", state: "skipped" },
        { file: "tests/z.test.ts", project: "suite", name: "b", state: "skipped" },
      ],
    });
    for (const broken of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const path = join(root, `broken-${broken}.record.json`);
      expect(() => write(path, [module("tests/y.test.ts", "passed", { ...fifths, prepareDuration: broken })]))
        .toThrow(expect.objectContaining({ name: "RecordError", message: expect.stringContaining("prepareDuration") }));
      expect(existsSync(path)).toBe(false);
    }
    expect(readdirSync(root).sort()).toEqual(["good.record.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
