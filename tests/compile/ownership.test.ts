import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { CompileError } from "../../src/compile/common.js";
import { compileSource } from "../../src/compile/index.js";
import { ownershipFindings } from "../../src/compile/ownership.js";
import { type RunGraph, validateGraph } from "../../src/graph/schema.js";

const FIXTURES = "tests/fixtures/graphs";
const frozen = validateGraph(JSON.parse(readFileSync(`${FIXTURES}/run-3010-partial.graph.json`, "utf8")));

function replayRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-ownership-"));
  const captures: Record<string, string> = {
    "tests/run/outcome-projections.test.ts": "run-3010-outcome-projections.test.txt",
    "tests/cli/status-watch-alive.test.ts": "run-3010-status-watch-alive.test.txt",
    "tests/watch-context.test.ts": "run-3010-watch-context.test.txt",
  };
  for (const [path, capture] of Object.entries(captures)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), readFileSync(`${FIXTURES}/${capture}`, "utf8"));
  }
  return repo;
}

function put(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function compileRepo(repo: string, tasks: string) {
  const spec = join(repo, "milestone.spec.md");
  writeFileSync(spec, `<!-- tickmarkr:spec -->\n${tasks}`);
  return compileSource(spec, "native", repo);
}

describe("cross-task ownership", () => {
  test("replayed against the frozen eight-task graph in the fixture bundle, the checker reports the outcome-projection test as a dedicated test of an owned source that no task owns", () => {
    const finding = ownershipFindings(frozen.tasks, replayRepo()).find(
      (item) => item.code === "unowned-test" && item.test === "tests/run/outcome-projections.test.ts",
    );

    expect(finding).toMatchObject({
      code: "unowned-test",
      taskIds: expect.arrayContaining(["T4"]),
      corroboration: { kind: "direct-import", source: "src/run/outcome.ts" },
    });
  });

  test("replayed against that same frozen graph, the checker also reports the status watch-alive test as unowned, so a family named by a hand-typed list is caught as well as a single omission", () => {
    const finding = ownershipFindings(frozen.tasks, replayRepo()).find(
      (item) => item.code === "unowned-test" && item.test === "tests/cli/status-watch-alive.test.ts",
    );

    expect(finding).toMatchObject({
      code: "unowned-test",
      taskIds: expect.arrayContaining(["T1"]),
      corroboration: {
        kind: "command-entry-spawn",
        source: "src/cli/commands/status.ts",
        entry: "src/cli/index.ts",
      },
    });
  });

  test("replayed against that same frozen graph together with the captured watcher test source, the checker reports that owned test referencing an installed-tree path outside its owner's allowlist", () => {
    const finding = ownershipFindings(frozen.tasks, replayRepo()).find(
      (item) => item.code === "test-path-outside-allowlist"
        && item.test === "tests/watch-context.test.ts"
        && item.path === ".claude/skills/tickmarkr-overseer/scripts/watch-context.sh",
    );

    expect(finding).toMatchObject({ code: "test-path-outside-allowlist", taskId: "T8" });
  });

  test("replayed against that same frozen graph, the checker reports the supervision task naming in context a script the watcher task owns while neither is ordered after the other", () => {
    const finding = ownershipFindings(frozen.tasks, replayRepo()).find(
      (item) => item.code === "unordered-context-write"
        && item.taskId === "T5"
        && item.ownerTaskId === "T8"
        && item.path === "skills/tickmarkr-overseer/scripts/watch-context.sh",
    );

    expect(finding).toBeDefined();
  });

  test("a graph whose dedicated tests are all owned, whose owned tests reference only their own allowlist, and whose context entries are dependency-ordered yields an empty finding list distinguishable from a check that did not run", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-ownership-clean-"));
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "tests/feature.test.ts"), "const source = 'src/feature.ts';\nvoid source;\n");
    const graph: RunGraph = validateGraph({
      version: 1,
      spec: { source: "native", paths: ["spec.md"], hash: "hash" },
      tasks: [
        {
          id: "T1", title: "feature", goal: "feature", shape: "implement", complexity: 2,
          files: ["src/feature.ts", "tests/feature.test.ts"], acceptance: ["feature"],
        },
        {
          id: "T2", title: "producer", goal: "producer", shape: "implement", complexity: 2,
          files: ["scripts/generated.sh"], acceptance: ["producer"],
        },
        {
          id: "T3", title: "consumer", goal: "consumer", shape: "implement", complexity: 2,
          deps: ["T2"], files: ["src/consumer.ts"], context: ["scripts/generated.sh"], acceptance: ["consumer"],
        },
      ],
    });

    const findings = ownershipFindings(graph.tasks, repo);
    expect(findings).toEqual([]);
    expect(findings).not.toBeUndefined();
  });

  test("test: an unowned test that matches an owned source by name and imports that source directly aborts the compile", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-ownership-import-"));
    put(repo, "tests/feature.test.ts", [
      'import { test } from "vitest";',
      'import { feature } from "../src/feature.js";',
      'test("feature", () => void feature);',
    ].join("\n"));
    const spec = `## T1: Feature\n- files: src/feature.ts\n- acceptance:\n  - judge: behavior holds\n`;

    expect(() => compileRepo(repo, spec)).toThrow(CompileError);
    expect(() => compileRepo(repo, spec)).toThrow(/ownership-lint\[unowned-test].*imports src\/feature\.ts directly/s);
  });

  test("test: an unowned test that matches an owned source by name and spawns the command entry point aborts the compile, while one matching by name alone warns without aborting", () => {
    const spawned = mkdtempSync(join(tmpdir(), "tickmarkr-ownership-spawn-"));
    put(spawned, "tests/cli/plan-watch.test.ts", [
      'import { spawn } from "node:child_process";',
      'import { join } from "node:path";',
      'import { test } from "vitest";',
      'const entry = join(process.cwd(), "src", "cli", "index.ts");',
      'test("plan", () => spawn(process.execPath, [entry, "plan"]));',
    ].join("\n"));
    expect(() => compileRepo(spawned, `## T1: Plan\n- files: src/cli/commands/plan.ts\n- acceptance:\n  - judge: behavior holds\n`))
      .toThrow(/ownership-lint\[unowned-test].*spawns src\/cli\/index\.ts/s);

    const nameOnly = mkdtempSync(join(tmpdir(), "tickmarkr-ownership-name-"));
    put(nameOnly, "tests/cli/plan-format.test.ts", 'test("plan output", () => {});\n');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => compileRepo(nameOnly, `## T1: Plan\n- files: src/cli/commands/plan.ts\n- acceptance:\n  - judge: behavior holds\n`))
        .not.toThrow();
      expect(warn.mock.calls.flat().join("\n")).toMatch(/ownership-lint\[unowned-test].*plan-format\.test\.ts/s);
    } finally {
      warn.mockRestore();
    }
  });

  test("test: a test matching an owned source by name that some task already owns compiles without aborting, so the refusal keys on unowned tests alone", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-ownership-owned-"));
    put(repo, "tests/feature.test.ts", [
      'import { test } from "vitest";',
      'import { feature } from "../src/feature.js";',
      'test("feature", () => void feature);',
    ].join("\n"));

    expect(() => compileRepo(repo, [
      "## T1: Feature source",
      "- files: src/feature.ts",
      "- acceptance:",
      "  - judge: source behavior holds",
      "",
      "## T2: Feature test",
      "- deps: T1",
      "- files: tests/feature.test.ts",
      "- acceptance:",
      "  - judge: test behavior holds",
      "",
    ].join("\n"))).not.toThrow();
  });

  test("a name-matched test whose source edge exists only through an imported helper warns without following the transitive closure", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-ownership-transitive-"));
    put(repo, "tests/feature.test.ts", [
      'import { test } from "vitest";',
      'import { feature } from "./feature-helper.js";',
      'test("feature", () => void feature);',
    ].join("\n"));
    put(repo, "tests/feature-helper.ts", 'export { feature } from "../src/feature.js";\n');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => compileRepo(repo, `## T1: Feature\n- files: src/feature.ts\n- acceptance:\n  - judge: behavior holds\n`))
        .not.toThrow();
      expect(warn.mock.calls.flat().join("\n")).toMatch(/ownership-lint\[unowned-test].*feature\.test\.ts/s);
    } finally {
      warn.mockRestore();
    }
  });

  test("the allowlist and unordered-context findings remain warnings even when a corroborated unowned test aborts", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-ownership-advisory-"));
    put(repo, "tests/feature.test.ts", [
      'import { test } from "vitest";',
      'import { feature } from "../src/feature.js";',
      'test("feature", () => void feature);',
    ].join("\n"));
    put(repo, "tests/consumer.test.ts", 'const outside = "src/outside.ts";\nvoid outside;\n');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => compileRepo(repo, [
        "## T1: Feature",
        "- files: src/feature.ts, tests/consumer.test.ts",
        "- context: scripts/shared.sh",
        "- acceptance:",
        "  - judge: feature behavior holds",
        "",
        "## T2: Shared producer",
        "- files: scripts/shared.sh",
        "- acceptance:",
        "  - judge: producer behavior holds",
        "",
      ].join("\n"))).toThrow(/ownership-lint\[unowned-test]/);
      const warnings = warn.mock.calls.flat().join("\n");
      expect(warnings).toMatch(/ownership-lint\[test-path-outside-allowlist]/);
      expect(warnings).toMatch(/ownership-lint\[unordered-context-write]/);
    } finally {
      warn.mockRestore();
    }
  });
});
