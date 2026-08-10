import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CompileError } from "../../src/compile/common.js";
import { compileSource, type PlanFinalizationHook, type PlanIR } from "../../src/compile/index.js";
import { loadGraph, saveGraph } from "../../src/graph/graph.js";
import { GraphValidationError, SPEC_SOURCES, validateGraph } from "../../src/graph/schema.js";

afterEach(() => vi.restoreAllMocks());

function nativeFixture(frontMatter = "", taskText = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-plan-ir-native-"));
  const file = join(dir, "plan.md");
  writeFileSync(file, `<!-- tickmarkr:spec -->\n${frontMatter}## T1: Canonical plan\n${taskText}- acceptance:\n  - judge: canonical plan is observable\n`);
  return file;
}

const minimalTask = {
  id: "T1",
  title: "Canonical plan",
  goal: "Canonical plan is durable",
  shape: "implement",
  complexity: 3,
  acceptance: ["canonical plan is observable"],
};

test("compileSource four-front-end matrix compiles native, PRD, Spec Kit and GSD fixtures through one canonical finalization hook, preserves each real source identity, and makes the same injected missing consumer fact fail all four, so four independent rule implementations or a native-only seam fail", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const frontEnds = [
    { source: "native", path: "fixtures/sample.native.md", type: "native" },
    { source: "prd", path: "fixtures/sample.prd.md", type: "prd" },
    { source: "speckit", path: "fixtures/speckit-sample", type: "speckit" },
    { source: "gsd", path: "fixtures/gsd-sample/07-live-check", type: "gsd" },
  ] as const;

  for (const fixture of frontEnds) {
    expect(compileSource(fixture.path, fixture.type).spec.source).toBe(fixture.source);
  }

  const finalizedSources: PlanIR["source"][] = [];
  const removeConsumerHash: PlanFinalizationHook = (plan) => {
    finalizedSources.push(plan.source);
    const { hash: _hash, ...missingHash } = plan;
    return missingHash as PlanIR;
  };
  for (const fixture of frontEnds) {
    let error: unknown;
    try {
      compileSource(fixture.path, fixture.type, undefined, removeConsumerHash);
    } catch (caught) {
      error = caught;
    }
    expect(error, `${fixture.source} must reach the shared finalizer`).toBeInstanceOf(GraphValidationError);
    expect((error as Error).message, `${fixture.source} must reject the same missing hash fact`).toMatch(/spec\.hash/);
  }
  expect(finalizedSources).toEqual(frontEnds.map(({ source }) => source));
});

test("native-base round trip compiles a column-zero lower-case base into graph.spec.base and survives shipped save plus load, while no base and an indented documentation example stay absent and a Git-command spy records zero calls, so prose scanning or compile-time repository probing fails", () => {
  const binDir = mkdtempSync(join(tmpdir(), "tickmarkr-plan-ir-git-spy-"));
  const gitLog = join(binDir, "git.calls");
  const gitBin = join(binDir, "git");
  writeFileSync(gitBin, `#!/bin/sh\nprintf call >> '${gitLog}'\nexit 99\n`);
  chmodSync(gitBin, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${priorPath ?? ""}`;

  try {
    const declared = "refs/heads/release-candidate";
    const withBase = compileSource(nativeFixture(`mode: staff-led\nbase: ${declared}\n`), "native");
    expect(withBase.mode).toBe("staff-led");
    expect(withBase.spec.base).toBe(declared);

    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-plan-ir-roundtrip-"));
    saveGraph(repo, withBase);
    expect(loadGraph(repo)).toEqual(withBase);
    expect(loadGraph(repo).spec.base).toBe(declared);

    expect(compileSource(nativeFixture(), "native").spec.base).toBeUndefined();
    expect(compileSource(nativeFixture("  base: documentation-only\n"), "native").spec.base).toBeUndefined();
    expect(existsSync(gitLog)).toBe(false);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
});

test("malformed-source controls reject an empty base and a column-zero prose Base label with a repair naming lower-case base, accept Base inside task text, and reject taskmaster at validateGraph and generated-schema boundaries while all four implemented source members pass", () => {
  for (const frontMatter of ["base:   \n", "Base: release-candidate\n"]) {
    let error: unknown;
    try {
      compileSource(nativeFixture(frontMatter), "native");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CompileError);
    expect((error as Error).message).toMatch(/lower-case base:/);
  }

  const taskProse = compileSource(nativeFixture("", "Base: this remains ordinary task text.\n"), "native");
  expect(taskProse.tasks[0].id).toBe("T1");
  expect(taskProse.spec.base).toBeUndefined();

  const graphWithSource = (source: string) => ({
    version: 1,
    spec: { source, paths: ["plan.md"], hash: "plan-hash" },
    tasks: [minimalTask],
  });
  expect(() => validateGraph(graphWithSource("taskmaster"))).toThrow(GraphValidationError);
  for (const source of SPEC_SOURCES) {
    expect(validateGraph(graphWithSource(source)).spec.source).toBe(source);
  }

  const generated = JSON.parse(readFileSync("schema/rungraph.schema.json", "utf8")) as {
    properties: { spec: { properties: { source: { enum: string[] } } } };
  };
  const generatedSources = generated.properties.spec.properties.source.enum;
  expect(generatedSources).toEqual([...SPEC_SOURCES]);
  expect(generatedSources).not.toContain("taskmaster");
});
