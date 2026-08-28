import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { configDefaults } from "vitest/config";
import config, {
  createVitestConfig,
  DIST_COUPLED_TESTS,
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
      "built-cli",
      "signal-reaper",
    ]);
    expect(parallelProject?.test.include).toEqual(["tests/**/*.test.ts"]);
    expect(parallelProject?.test.exclude).toEqual([
      ...configDefaults.exclude,
      ...DIST_COUPLED_TESTS,
      ...SIGNAL_REAPER_TESTS,
      ...SYNC_HEAVY_TESTS,
    ]);
    expect(parallelProject?.test.poolOptions?.forks?.singleFork).toBeUndefined();

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
