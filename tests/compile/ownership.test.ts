import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
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

describe("cross-task ownership", () => {
  test("replayed against the frozen eight-task graph in the fixture bundle, the checker reports the outcome-projection test as a dedicated test of an owned source that no task owns", () => {
    const finding = ownershipFindings(frozen.tasks, replayRepo()).find(
      (item) => item.code === "unowned-test" && item.test === "tests/run/outcome-projections.test.ts",
    );

    expect(finding).toMatchObject({ code: "unowned-test", taskIds: expect.arrayContaining(["T4"]) });
  });

  test("replayed against that same frozen graph, the checker also reports the status watch-alive test as unowned, so a family named by a hand-typed list is caught as well as a single omission", () => {
    const finding = ownershipFindings(frozen.tasks, replayRepo()).find(
      (item) => item.code === "unowned-test" && item.test === "tests/cli/status-watch-alive.test.ts",
    );

    expect(finding).toMatchObject({ code: "unowned-test", taskIds: expect.arrayContaining(["T1"]) });
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
});
