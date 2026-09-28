import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { configDefaults } from "vitest/config";
import config, {
  createVitestConfig,
  DIST_COUPLED_TESTS,
  KEYS_LEDGER_TESTS,
  SIGNAL_REAPER_TESTS,
  SYNC_HEAVY_TESTS,
  SYNC_HEAVY_TIMEOUT_MS,
} from "../../vitest.config.js";
import { DEFAULT_FORK_CAP } from "../../src/run/git.js";
import { ownedFailures, runOwned } from "../helpers/owned-process.js";

type Project = {
  test: {
    name?: string;
    include?: string[];
    exclude?: string[];
    testTimeout?: number;
    poolOptions?: { forks?: { singleFork?: boolean; maxForks?: number } };
  };
};

const projectsOf = (candidate: unknown): Project[] =>
  ((candidate as { test?: { projects?: Project[] } }).test?.projects ?? []);
const projectNamed = (candidate: unknown, name: string): Project | undefined =>
  projectsOf(candidate).find((project) => project.test.name === name);
// vitest 3.2.7 sizes its one forks pool from the ROOT config, so that is where the cap must live.
const rootForkCap = (candidate: unknown): number | undefined =>
  (candidate as { test?: { poolOptions?: { forks?: { maxForks?: number } } } }).test?.poolOptions?.forks?.maxForks;

const projects = projectsOf(config);
const parallelProject = projects.find((project) => project.test.name === "suite");
const syncHeavyProject = projects.find((project) => project.test.name === "sync-heavy");
const builtCliProject = projects.find((project) => project.test.name === "built-cli");
const signalReaperProject = projects.find((project) => project.test.name === "signal-reaper");
const keysLedgerProject = projectNamed(config, "keys-ledger");
const SIGNAL_REAPER_TEST = "tests/run/reconcile-live.test.ts";

describe("Vitest project membership", () => {
  test("test: the vitest project layout places the signal reaper suite in a serialized single fork project", () => {
    expect(signalReaperProject).toBeDefined();
    expect(signalReaperProject!.test.include).toContain(SIGNAL_REAPER_TEST);
    expect(signalReaperProject!.test.poolOptions?.forks?.singleFork).toBe(true);
  });

  test("test: the serialized project keeps the dist coupled suites it already carried", () => {
    expect(builtCliProject).toBeDefined();
    expect(builtCliProject!.test.include).toEqual(DIST_COUPLED_TESTS);
    expect(builtCliProject!.test.poolOptions?.forks?.singleFork).toBe(true);
  });

  test("test: the parallel project excludes every suite the serialized project includes", () => {
    expect(parallelProject).toBeDefined();
    const serializedFiles = [
      ...(builtCliProject?.test.include ?? []),
      ...(keysLedgerProject?.test.include ?? []),
      ...(syncHeavyProject?.test.include ?? []),
      ...(signalReaperProject?.test.include ?? []),
    ];
    for (const file of serializedFiles) expect(parallelProject!.test.exclude).toContain(file);
  });

  test("the serialization mechanism reuses the existing project split rather than introducing a second configuration surface", () => {
    const source = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");
    expect(source.match(/projects\s*:/g)).toHaveLength(1);
    expect(source).toContain("poolOptions: { forks: { singleFork: true } }");
    expect(source).toContain("DIST_COUPLED_TESTS");
  });

  test("test: with no fork-cap value in the environment the parallel project resolves the daemon's own default cap rather than the runner's core-count default, so a bare invocation divides the machine the way every lane does; a configuration leaving the cap unset without an environment value: it fails", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.test).toBe("vitest run");
    expect(rootForkCap(createVitestConfig(undefined))).toBe(Number(DEFAULT_FORK_CAP));
  });

  test("test: an explicitly supplied fork-cap value still decides the cap and is not overridden by the new default, so the lanes pinning a different value keep getting it; a default applied unconditionally overrides those lanes and: it fails", () => {
    const cap = rootForkCap(createVitestConfig("2"));

    expect(cap).toBe(2);
    expect(cap).not.toBe(Number(DEFAULT_FORK_CAP));
  });

  test("test: a supplied value that is absent, empty or not a positive number falls back to the default rather than to the runner's core-count behaviour, so a malformed override cannot silently restore the unpinned fan-out; a fallback to the runner default on a malformed value: it fails", () => {
    for (const value of [undefined, "", "0", "-1", "not-a-number", "Infinity"]) {
      expect(rootForkCap(createVitestConfig(value)), `fork cap for ${String(value)}`)
        .toBe(Number(DEFAULT_FORK_CAP));
    }
  });

  test("test: the serialized projects keep the memberships and single-fork settings they carry today, so this changes only the parallel project's fan-out; an edit moving a suite between projects: it fails", () => {
    // OBS-634 add: the CI guard keeps today's five-project layout; locally the sync-heavy members
    // move into the parallel project and nothing else moves.
    const layouts = { ci: createVitestConfig(undefined, true), local: createVitestConfig(undefined, false) };
    expect(projectsOf(layouts.ci).map((project) => project.test.name)).toEqual([
      "suite",
      "sync-heavy",
      "keys-ledger",
      "built-cli",
      "signal-reaper",
    ]);
    expect(projectsOf(layouts.local).map((project) => project.test.name)).toEqual([
      "suite",
      "keys-ledger",
      "built-cli",
      "signal-reaper",
    ]);
    for (const [mode, layout] of Object.entries(layouts)) {
      const suite = projectNamed(layout, "suite");
      const keysLedger = projectNamed(layout, "keys-ledger");
      const builtCli = projectNamed(layout, "built-cli");
      const signalReaper = projectNamed(layout, "signal-reaper");
      expect(suite?.test.include, mode).toEqual(["tests/**/*.test.ts"]);
      expect(suite?.test.exclude, mode).toEqual([
        ...configDefaults.exclude,
        ...DIST_COUPLED_TESTS,
        ...SIGNAL_REAPER_TESTS,
        ...(mode === "ci" ? SYNC_HEAVY_TESTS : []),
        ...KEYS_LEDGER_TESTS,
      ]);
      expect(suite?.test.poolOptions?.forks?.singleFork, mode).toBeUndefined();

      expect(keysLedger?.test.include, mode).toEqual([
        "tests/cockpit/keys.test.ts",
        "tests/e2e/forced-stall.e2e.test.ts",
      ]);
      expect(keysLedger?.test.exclude, mode).toEqual([...configDefaults.exclude, ...DIST_COUPLED_TESTS]);
      expect(keysLedger?.test.poolOptions?.forks?.singleFork, mode).toBe(true);
      expect(builtCli?.test.include, mode).toEqual(DIST_COUPLED_TESTS);
      expect(builtCli?.test.poolOptions?.forks?.singleFork, mode).toBe(true);
      expect(signalReaper?.test.include, mode).toEqual(SIGNAL_REAPER_TESTS);
      expect(signalReaper?.test.exclude, mode).toEqual([...configDefaults.exclude, ...DIST_COUPLED_TESTS]);
      expect(signalReaper?.test.poolOptions?.forks?.singleFork, mode).toBe(true);
    }
    const syncHeavy = projectNamed(layouts.ci, "sync-heavy");
    expect(syncHeavy?.test.include).toEqual(SYNC_HEAVY_TESTS);
    expect(syncHeavy?.test.exclude).toEqual([...configDefaults.exclude, ...DIST_COUPLED_TESTS]);
    expect(syncHeavy?.test.poolOptions?.forks?.singleFork).toBe(true);
    expect(syncHeavy?.test.testTimeout).toBe(SYNC_HEAVY_TIMEOUT_MS);
  });
});

// Execute the real keys file with a cheap leaf selected; project membership is file-level.
// The reporter observes resolved runtime projects, not a reimplementation of their globs.
test("test: a real Vitest invocation using the production Vitest configuration records the keys file exactly once in a single-fork project while an ordinary fixture remains parallel, so duplicate scheduling or parallel ledger execution fails", async () => {
  const repoRoot = join(import.meta.dirname, "../..");
  const scratch = mkdtempSync(join(tmpdir(), "tickmarkr-ledger-scheduling-"));
  const ordinary = "tests/config/ordinary-scheduling.test.ts";
  const forcedStall = "tests/e2e/forced-stall.e2e.test.ts";
  try {
    for (const directory of ["src", "tests", "fixtures"]) {
      cpSync(join(repoRoot, directory), join(scratch, directory), { recursive: true });
    }
    mkdirSync(join(scratch, "scripts"));
    for (const file of ["package.json", "tsconfig.json", "vitest.config.ts", "scripts/vitest-lease.ts"]) {
      copyFileSync(join(repoRoot, file), join(scratch, file));
    }
    symlinkSync(join(repoRoot, "node_modules"), join(scratch, "node_modules"), "dir");
    for (const file of [ordinary, forcedStall]) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      writeFileSync(join(scratch, file), `import { test, expect } from "vitest";
        test("OBS-1141 scheduling probe", () => expect(1 + 1).toBe(2));\n`);
    }
    writeFileSync(join(scratch, "scheduling-reporter.mjs"), `
      import { writeFileSync } from "node:fs";
      import { relative } from "node:path";
      export default class SchedulingReporter {
        records = [];
        onTestModuleEnd(module) {
          this.records.push({
            file: relative(process.cwd(), module.moduleId).replaceAll("\\\\", "/"),
            project: module.project.name,
            pool: module.project.config.pool,
            singleFork: module.project.config.poolOptions?.forks?.singleFork === true,
            parallel: module.project.config.fileParallelism === true && module.project.config.poolOptions?.forks?.singleFork !== true,
            passed: [...module.children.allTests()].filter(test => test.result().state === "passed").length,
          });
        }
        onTestRunEnd() {
          writeFileSync("scheduling.json", JSON.stringify(this.records));
        }
      }
    `);
    const result = await new Promise<{ status: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        join(repoRoot, "node_modules/vitest/vitest.mjs"), "run",
        "--configLoader", "runner", "--config", "vitest.config.ts",
        "tests/cockpit/keys.test.ts", ordinary, forcedStall,
        "--testNamePattern", "OBS-1141 scheduling probe|test: the ledger covers every module either surface declares",
        "--reporter", "./scheduling-reporter.mjs",
      ], {
        cwd: scratch,
        // Keep the ordinary project genuinely parallel-capable in the child, even in serial CI.
        env: { ...process.env, VITEST_MAX_FORKS: "2", NO_COLOR: "1", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (status) => { clearTimeout(timer); resolve({ status, output }); });
    });
    expect(result.status, result.output).toBe(0);
    const records = JSON.parse(readFileSync(join(scratch, "scheduling.json"), "utf8"));
    expect(records).toHaveLength(3);
    for (const file of ["tests/cockpit/keys.test.ts", forcedStall]) {
      expect(records.filter((record: { file: string }) => record.file === file)).toEqual([
        { file, project: "keys-ledger", pool: "forks", singleFork: true, parallel: false, passed: 1 },
      ]);
    }
    expect(records.filter((record: { file: string }) => record.file === ordinary)).toEqual([
      { file: ordinary, project: "suite", pool: "forks", singleFork: false, parallel: true, passed: 1 },
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);

// OBS-634 add (v2.6.3 T1): one scratch copy of the production configuration and the real
// tests/setup.ts, run once per mode. Fixture files stand at the real member paths so the
// production membership lists decide their projects; the reporter observes the resolved pool,
// each file's run interval, and the leaf ceiling each test was bound to at collection.
type PoolingMode = "local" | "ci";
type PoolingRecord = {
  file: string;
  project: string;
  singleFork: boolean;
  states: string[];
  timeouts: number[];
  start: number;
  end: number;
};
type PoolingRun = { maxForks: number; records: PoolingRecord[] };

const POOLING_ORDINARY = Array.from({ length: 7 }, (_, index) => `tests/pooling/ordinary-${index + 1}.test.ts`);
const POOLING_ISOLATED: Readonly<Record<string, readonly string[]>> = {
  "keys-ledger": KEYS_LEDGER_TESTS,
  "built-cli": DIST_COUPLED_TESTS,
  "signal-reaper": SIGNAL_REAPER_TESTS,
};
const POOLING_FILES = [...POOLING_ORDINARY, ...SYNC_HEAVY_TESTS, ...Object.values(POOLING_ISOLATED).flat()];
const POOLED_HOLD_MS = 1_500;
const ISOLATED_HOLD_MS = 300;

const poolingProbe = (holdMs: number) => `import { test } from "vitest";
test("pooling probe", async ({ task }) => {
  task.meta.timeout = task.timeout;
  await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
});
`;

const poolingReporter = `
  import { writeFileSync } from "node:fs";
  import { relative } from "node:path";
  export default class PoolingReporter {
    records = [];
    onInit(vitest) { this.vitest = vitest; }
    onTestModuleEnd(module) {
      const tests = [...module.children.allTests()];
      const times = tests.map((test) => test.diagnostic()).filter(Boolean);
      this.records.push({
        file: relative(process.cwd(), module.moduleId).replaceAll("\\\\", "/"),
        project: module.project.name,
        singleFork: module.project.config.poolOptions?.forks?.singleFork === true,
        states: tests.map((test) => test.result().state),
        timeouts: tests.map((test) => test.meta().timeout),
        start: Math.min(...times.map((time) => time.startTime)),
        end: Math.max(...times.map((time) => time.startTime + time.duration)),
      });
    }
    onTestRunEnd() {
      writeFileSync(process.env.POOLING_RECORD, JSON.stringify({
        maxForks: this.vitest.config.poolOptions?.forks?.maxForks,
        records: this.records,
      }));
    }
  }
`;

// Each mode's child sees only its own guard; the configured cap decides the fan-out in BOTH modes
// (no VITEST_MAX_FORKS), so CI-mode isolation is proven with a parallel pool beside it.
function modeEnv(mode: PoolingMode, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...extra };
  for (const key of ["TICKMARKR_CI_LEAN_REPORTERS", "VITEST_MAX_FORKS", "TICKMARKR_DOCS_TRUTH_MUTATION_CHILD"]) delete env[key];
  if (mode === "ci") env.TICKMARKR_CI_LEAN_REPORTERS = "1";
  return env;
}

async function vitestChild(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const repoRoot = join(import.meta.dirname, "../..");
  const run = await runOwned(process.execPath, [join(repoRoot, "node_modules/vitest/vitest.mjs"), ...args], {
    cwd, env, ms: 120_000,
  });
  if (run.unresolved || run.survivors.length > 0) throw new Error(ownedFailures(run, "vitest child").join("; "));
  return run;
}

let poolingRuns: Promise<Record<PoolingMode, PoolingRun>> | undefined;
const runPoolingFixtures = () => (poolingRuns ??= (async () => {
  const repoRoot = join(import.meta.dirname, "../..");
  const scratch = mkdtempSync(join(tmpdir(), "tickmarkr-pooling-"));
  try {
    cpSync(join(repoRoot, "src"), join(scratch, "src"), { recursive: true });
    for (const file of ["package.json", "tsconfig.json", "vitest.config.ts", "scripts/vitest-lease.ts", "tests/setup.ts", "tests/helpers/tmprepo.ts"]) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      copyFileSync(join(repoRoot, file), join(scratch, file));
    }
    symlinkSync(join(repoRoot, "node_modules"), join(scratch, "node_modules"), "dir");
    const isolated = new Set(Object.values(POOLING_ISOLATED).flat());
    for (const file of POOLING_FILES) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      writeFileSync(join(scratch, file), poolingProbe(isolated.has(file) ? ISOLATED_HOLD_MS : POOLED_HOLD_MS));
    }
    writeFileSync(join(scratch, "pooling-reporter.mjs"), poolingReporter);
    const runs: Partial<Record<PoolingMode, PoolingRun>> = {};
    for (const mode of ["local", "ci"] as const) {
      const record = join(scratch, `pooling-${mode}.json`);
      const run = await vitestChild(scratch, [
        "run", "--configLoader", "runner", "--config", "vitest.config.ts", "--reporter", "./pooling-reporter.mjs",
      ], modeEnv(mode, { POOLING_RECORD: record }));
      expect(run.exitCode, `${mode}\n${run.out}\n${run.err}`).toBe(0);
      runs[mode] = JSON.parse(readFileSync(record, "utf8")) as PoolingRun;
    }
    return runs as Record<PoolingMode, PoolingRun>;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
})());

const overlaps = (a: PoolingRecord, b: PoolingRecord) => a.start < b.end && b.start < a.end;
const maxConcurrent = (records: readonly PoolingRecord[]) =>
  Math.max(...records.map((at) => records.filter((other) => other.start <= at.start && at.start < other.end).length));
const recordFor = (run: PoolingRun, file: string) => {
  const matches = run.records.filter((record) => record.file === file);
  expect(matches, `${file} must be scheduled exactly once`).toHaveLength(1);
  return matches[0]!;
};

// The real members' own mutation controls: each must be listed (vitest list omits skipped cases).
const MUTATION_CONTROLS = [
  /both falsification levers exercising a planted violation/,
  /each property falsified by mutating renderer-drawn bytes/,
  /every retained assertion still FAILS when the thing it guards is broken/,
  /each suite re-run against the perturbed tree in a child process/,
];

async function listProduction(mode: PoolingMode, args: string[]): Promise<{ name?: string; file: string; projectName?: string }[]> {
  const repoRoot = join(import.meta.dirname, "../..");
  const out = mkdtempSync(join(tmpdir(), "tickmarkr-pooling-list-"));
  try {
    const json = join(out, "listing.json");
    const run = await vitestChild(repoRoot, ["list", "--configLoader", "runner", `--json=${json}`, ...args], modeEnv(mode));
    expect(run.exitCode, `${mode}\n${run.out}\n${run.err}`).toBe(0);
    return JSON.parse(readFileSync(json, "utf8"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

describe("OBS-634 add: sync-heavy pools locally, isolated under the CI guard", () => {
  test("test: the production Vitest configuration pools sweep plus docs-truth at configured local cap six versus isolation under TICKMARKR_CI_LEAN_REPORTERS=1 without losing any manifest member or mutation control, so a seventh fork or skipped case fails", async () => {
    const runs = await runPoolingFixtures();
    for (const mode of ["local", "ci"] as const) {
      const run = runs[mode];
      expect(run.maxForks, mode).toBe(Number(DEFAULT_FORK_CAP));
      expect(Number(DEFAULT_FORK_CAP)).toBe(6);
      // every fixture file ran once and every case passed — none skipped, none lost
      expect(run.records.map((record) => record.file).sort(), mode).toEqual([...POOLING_FILES].sort());
      for (const record of run.records) expect(record.states, `${mode} ${record.file}`).toEqual(["passed"]);
      expect(maxConcurrent(run.records), `${mode}: a seventh concurrent fork`).toBeLessThanOrEqual(6);
    }

    const local = runs.local;
    const pooled = [...POOLING_ORDINARY, ...SYNC_HEAVY_TESTS].map((file) => recordFor(local, file));
    expect(maxConcurrent(pooled), "the local pool fans out").toBeGreaterThan(1);
    for (const file of SYNC_HEAVY_TESTS) {
      const member = recordFor(local, file);
      expect(member, file).toMatchObject({ project: "suite", singleFork: false });
      expect(POOLING_ORDINARY.some((other) => overlaps(member, recordFor(local, other))), `${file} ran inside the pool`).toBe(true);
    }
    const ci = runs.ci;
    for (const file of SYNC_HEAVY_TESTS) {
      const member = recordFor(ci, file);
      expect(member, file).toMatchObject({ project: "sync-heavy", singleFork: true });
      for (const other of ci.records.filter((record) => record.file !== file)) {
        expect(overlaps(member, other), `${file} overlapped ${other.file} under the CI guard`).toBe(false);
      }
    }

    // The real tree: every tracked test file is listed exactly once in both modes, and the real
    // members' mutation controls are listed (not skipped) in the project each mode assigns them.
    const repoRoot = join(import.meta.dirname, "../..");
    const manifest = execFileSync("git", ["ls-files", "tests/*.test.ts"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n").filter(Boolean).map((file) => join(repoRoot, file));
    expect(manifest.length).toBeGreaterThan(300);
    const inventories: string[][] = [];
    for (const mode of ["local", "ci"] as const) {
      const files = (await listProduction(mode, ["--filesOnly"])).map((entry) => entry.file);
      for (const file of manifest) expect(files.filter((listed) => listed === file), `${mode} ${file}`).toHaveLength(1);

      const members = await listProduction(mode, SYNC_HEAVY_TESTS);
      expect(new Set(members.map((entry) => entry.projectName)), mode).toEqual(new Set([mode === "ci" ? "sync-heavy" : "suite"]));
      for (const control of MUTATION_CONTROLS) {
        expect(members.filter((entry) => control.test(entry.name ?? "")), `${mode} ${control}`).toHaveLength(1);
      }
      inventories.push(members.map((entry) => `${entry.file} :: ${entry.name}`).sort());
    }
    expect(inventories[0]).toEqual(inventories[1]);
  }, 300_000);

  test("test: the production Vitest runner preserves isolation of keys-ledger built-cli signal-reaper in both environments, so a pooled excluded suite fails despite faster completion", async () => {
    const runs = await runPoolingFixtures();
    for (const mode of ["local", "ci"] as const) {
      const run = runs[mode];
      for (const [project, files] of Object.entries(POOLING_ISOLATED)) {
        for (const file of files) {
          const record = recordFor(run, file);
          expect(record, `${mode} ${file}`).toMatchObject({ project, singleFork: true, states: ["passed"] });
          for (const other of run.records.filter((candidate) => candidate.file !== file)) {
            expect(overlaps(record, other), `${mode}: ${file} overlapped ${other.file}`).toBe(false);
          }
        }
      }
    }
  }, 300_000);

  test("test: the production Vitest configuration keeps the 1200-second leaf ceiling on sweep and docs-truth inside the pooled local project while an ordinary pooled file keeps the 20-second default, so a pooled member inheriting the default ceiling fails", async () => {
    const { local, ci } = await runPoolingFixtures();
    expect(SYNC_HEAVY_TIMEOUT_MS).toBe(1_200_000);
    for (const file of SYNC_HEAVY_TESTS) {
      expect(recordFor(local, file), file).toMatchObject({ project: "suite", singleFork: false, timeouts: [1_200_000] });
      expect(recordFor(ci, file), file).toMatchObject({ project: "sync-heavy", timeouts: [1_200_000] });
    }
    for (const file of POOLING_ORDINARY) {
      expect(recordFor(local, file), file).toMatchObject({ project: "suite", singleFork: false, timeouts: [20_000] });
    }
  }, 300_000);
});
