import { spawn } from "node:child_process";
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
} from "../../vitest.config.js";
import { DEFAULT_FORK_CAP } from "../../src/run/git.js";

type Project = {
  test: {
    name?: string;
    include?: string[];
    exclude?: string[];
    poolOptions?: { forks?: { singleFork?: boolean; maxForks?: number } };
  };
};

const projectsOf = (candidate: unknown): Project[] =>
  ((candidate as { test?: { projects?: Project[] } }).test?.projects ?? []);
const projectNamed = (candidate: unknown, name: string): Project | undefined =>
  projectsOf(candidate).find((project) => project.test.name === name);

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
    const project = projectNamed(createVitestConfig(undefined), "suite");

    expect(packageJson.scripts?.test).toBe("vitest run");
    expect(project?.test.poolOptions?.forks?.maxForks).toBe(Number(DEFAULT_FORK_CAP));
  });

  test("test: an explicitly supplied fork-cap value still decides the cap and is not overridden by the new default, so the lanes pinning a different value keep getting it; a default applied unconditionally overrides those lanes and: it fails", () => {
    const project = projectNamed(createVitestConfig("2"), "suite");

    expect(project?.test.poolOptions?.forks?.maxForks).toBe(2);
    expect(project?.test.poolOptions?.forks?.maxForks).not.toBe(Number(DEFAULT_FORK_CAP));
  });

  test("test: a supplied value that is absent, empty or not a positive number falls back to the default rather than to the runner's core-count behaviour, so a malformed override cannot silently restore the unpinned fan-out; a fallback to the runner default on a malformed value: it fails", () => {
    for (const value of [undefined, "", "0", "-1", "not-a-number", "Infinity"]) {
      const project = projectNamed(createVitestConfig(value), "suite");
      expect(project?.test.poolOptions?.forks?.maxForks, `fork cap for ${String(value)}`)
        .toBe(Number(DEFAULT_FORK_CAP));
    }
  });

  test("test: the serialized projects keep the memberships and single-fork settings they carry today, so this changes only the parallel project's fan-out; an edit moving a suite between projects: it fails", () => {
    expect(projects.map((project) => project.test.name)).toEqual([
      "suite",
      "sync-heavy",
      "keys-ledger",
      "built-cli",
      "signal-reaper",
    ]);
    expect(parallelProject?.test.include).toEqual(["tests/**/*.test.ts"]);
    expect(parallelProject?.test.exclude).toEqual([
      ...configDefaults.exclude,
      ...DIST_COUPLED_TESTS,
      ...SIGNAL_REAPER_TESTS,
      ...SYNC_HEAVY_TESTS,
      ...KEYS_LEDGER_TESTS,
    ]);
    expect(parallelProject?.test.poolOptions?.forks?.singleFork).toBeUndefined();

    expect(keysLedgerProject?.test.include).toEqual([
      "tests/cockpit/keys.test.ts",
      "tests/e2e/forced-stall.e2e.test.ts",
    ]);
    expect(keysLedgerProject?.test.exclude).toEqual([...configDefaults.exclude, ...DIST_COUPLED_TESTS]);
    expect(keysLedgerProject?.test.poolOptions?.forks?.singleFork).toBe(true);
    expect(syncHeavyProject?.test.include).toEqual(SYNC_HEAVY_TESTS);
    expect(syncHeavyProject?.test.exclude).toEqual([...configDefaults.exclude, ...DIST_COUPLED_TESTS]);
    expect(syncHeavyProject?.test.poolOptions?.forks?.singleFork).toBe(true);
    expect(builtCliProject?.test.include).toEqual(DIST_COUPLED_TESTS);
    expect(builtCliProject?.test.poolOptions?.forks?.singleFork).toBe(true);
    expect(signalReaperProject?.test.include).toEqual(SIGNAL_REAPER_TESTS);
    expect(signalReaperProject?.test.exclude).toEqual([...configDefaults.exclude, ...DIST_COUPLED_TESTS]);
    expect(signalReaperProject?.test.poolOptions?.forks?.singleFork).toBe(true);
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
    for (const file of ["package.json", "tsconfig.json", "vitest.config.ts"]) {
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
