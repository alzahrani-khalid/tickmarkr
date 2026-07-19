import { describe, expect, test } from "vitest";
import { graphDefinitionHash } from "../../src/graph/graph.js";
import { validateGraph, type RunGraph } from "../../src/graph/schema.js";

// T3 (Sol #2 / Fable F2): graphDefinitionHash is the canonical engagement identity — one hash shared by
// status and resume. The defining properties: invariant under status/evidence mutation (runtime state),
// sensitive to any compiled-task-definition change. "Computed over compiled task definitions only."
const baseGraph = (): RunGraph =>
  validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [
      {
        id: "T1", title: "original title", goal: "original goal", shape: "implement", complexity: 3,
        acceptance: ["ships the feature"], gates: ["build", "test", "lint", "evidence", "scope"],
      },
    ],
  });

describe("graphDefinitionHash (T3 engagement identity)", () => {
  test("invariant when only a task status field mutates", () => {
    const g = baseGraph();
    const before = graphDefinitionHash(g);
    const flipped = { ...g, tasks: g.tasks.map((t) => ({ ...t, status: "done" as const })) };
    expect(graphDefinitionHash(flipped)).toBe(before);
  });

  test("invariant when only evidence accumulates", () => {
    const g = baseGraph();
    const before = graphDefinitionHash(g);
    const grown = {
      ...g,
      tasks: g.tasks.map((t) => ({
        ...t,
        evidence: { commits: ["abc", "def"], artifacts: ["x.txt"], gateResults: [{ pass: true }] },
      })),
    };
    expect(graphDefinitionHash(grown)).toBe(before);
  });

  test("changes when a compiled task definition changes (goal)", () => {
    const g = baseGraph();
    const before = graphDefinitionHash(g);
    const edited = { ...g, tasks: g.tasks.map((t) => ({ ...t, goal: "a different goal" })) };
    expect(graphDefinitionHash(edited)).not.toBe(before);
  });

  test("changes when a compiled task definition changes (acceptance)", () => {
    const g = baseGraph();
    const before = graphDefinitionHash(g);
    const edited = {
      ...g,
      tasks: g.tasks.map((t) => ({ ...t, acceptance: ["a different oracle"] })),
    };
    expect(graphDefinitionHash(edited)).not.toBe(before);
  });

  test("changes when a task is added or removed", () => {
    const g = baseGraph();
    const before = graphDefinitionHash(g);
    const two = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [
        g.tasks[0]!,
        { id: "T2", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["a"] },
      ],
    });
    expect(graphDefinitionHash(two)).not.toBe(before);
  });

  test("two graphs with identical definitions share a hash regardless of status/evidence divergence", () => {
    const a = baseGraph();
    const b = {
      ...a,
      tasks: a.tasks.map((t) => ({
        ...t,
        status: "failed" as const,
        evidence: { commits: ["x"], artifacts: [], gateResults: [] },
      })),
    };
    expect(graphDefinitionHash(b)).toBe(graphDefinitionHash(a));
  });
});
