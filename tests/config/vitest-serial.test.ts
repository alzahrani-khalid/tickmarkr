import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import config, { DIST_COUPLED_TESTS } from "../../vitest.config.js";

type Project = {
  test: {
    name?: string;
    include?: string[];
    exclude?: string[];
    poolOptions?: { forks?: { singleFork?: boolean } };
  };
};

const projects = ((config as { test?: { projects?: Project[] } }).test?.projects ?? []);
const parallelProject = projects.find((project) => project.test.name === "suite");
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
});
