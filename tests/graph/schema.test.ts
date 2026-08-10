import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { finalizePlan, type PlanIR } from "../../src/compile/index.js";
import { graphPath, loadGraph, saveGraph } from "../../src/graph/graph.js";
import { GATE_NAMES, GRAPH_ROUTING_MODES, GraphValidationError, SPEC_SOURCES, renderAcceptanceItem, validateGraph } from "../../src/graph/schema.js";

const task = (over: Record<string, unknown> = {}) => ({
  id: "T1",
  title: "do a thing",
  goal: "the thing is done",
  shape: "implement",
  complexity: 5,
  deps: [],
  files: ["src/**"],
  context: [],
  acceptance: ["thing observable"],
  ...over,
});

const graph = (tasks: unknown[]) => ({
  version: 1,
  spec: { source: "prd", paths: ["fixtures/sample.prd.md"], hash: "abc" },
  tasks,
});

describe("validateGraph", () => {
  test("accepts a minimal valid graph and applies defaults", () => {
    const g = validateGraph(graph([task()]));
    expect(g.tasks[0].status).toBe("pending");
    expect(g.tasks[0].humanGate).toBe(false);
    expect(g.tasks[0].gates).toContain("acceptance");
    expect(g.tasks[0].evidence).toEqual({ commits: [], artifacts: [], gateResults: [] });
  });

  test.each(["build", "test", "lint", "evidence", "scope"] as const)(
    "rejects task gates missing mandatory %s",
    (missing) => {
      const gates = GATE_NAMES.filter((gate) => gate !== missing);
      expect(() => validateGraph(graph([task({ gates })]))).toThrow(
        `${missing} is a mandatory fail-closed gate invariant`,
      );
    },
  );

  test("accepts the default gates list unchanged", () => {
    const gates = [...GATE_NAMES];
    expect(validateGraph(graph([task({ gates })])).tasks[0].gates).toEqual(gates);
  });

  test("acceptance and review remain optional gate participants", () => {
    const gates = GATE_NAMES.filter((gate) => gate !== "acceptance" && gate !== "review");
    expect(validateGraph(graph([task({ gates })])).tasks[0].gates).toEqual(gates);
  });

  test("rejects empty acceptance — non-negotiable", () => {
    expect(() => validateGraph(graph([task({ acceptance: [] })]))).toThrow(GraphValidationError);
    try {
      validateGraph(graph([task({ acceptance: [] })]));
    } catch (e) {
      expect((e as GraphValidationError).issues.join()).toMatch(/acceptance/);
    }
  });

  test("rejects duplicate ids, unknown deps, and cycles", () => {
    expect(() => validateGraph(graph([task(), task()]))).toThrow(/duplicate/i);
    expect(() => validateGraph(graph([task({ deps: ["T9"] })]))).toThrow(/unknown task T9/);
    expect(() =>
      validateGraph(graph([task({ deps: ["T2"] }), task({ id: "T2", deps: ["T1"] })])),
    ).toThrow(/cycle/i);
  });

  test("rejects bad shape, complexity out of range, bad status", () => {
    expect(() => validateGraph(graph([task({ shape: "yolo" })]))).toThrow(GraphValidationError);
    expect(() => validateGraph(graph([task({ complexity: 11 })]))).toThrow(GraphValidationError);
    expect(() => validateGraph(graph([task({ status: "paused" })]))).toThrow(GraphValidationError);
  });

  test("accepts routingHints with floor: mid (valid tier)", () => {
    const g = validateGraph(graph([task({ routingHints: { floor: "mid" } })]));
    expect(g.tasks[0].routingHints?.floor).toBe("mid");
  });

  test("accepts routingHints with floor + source both set", () => {
    const g = validateGraph(graph([task({ routingHints: { floor: "cheap", source: "02-01-PLAN.md" } })]));
    expect(g.tasks[0].routingHints?.floor).toBe("cheap");
    expect(g.tasks[0].routingHints?.source).toBe("02-01-PLAN.md");
  });

  test("accepts routingHints absent (backward compat)", () => {
    const g = validateGraph(graph([task()]));
    expect(g.tasks[0].routingHints).toBeUndefined();
  });

  test("accepts existing routingHints shapes (pin, escalate)", () => {
    const g1 = validateGraph(graph([task({ routingHints: { pin: { via: "claude-code", model: "fable" } } })]));
    expect(g1.tasks[0].routingHints?.pin?.via).toBe("claude-code");
    const g2 = validateGraph(graph([task({ routingHints: { escalate: true } })]));
    expect(g2.tasks[0].routingHints?.escalate).toBe(true);
  });

  test("rejects routingHints with unknown tier floor: ultra", () => {
    expect(() => validateGraph(graph([task({ routingHints: { floor: "ultra" } })]))).toThrow(GraphValidationError);
  });

  test("rejects graph with version 2 — literal(1) enforces backward compat", () => {
    expect(() => validateGraph({ ...graph([task()]), version: 2 })).toThrow(GraphValidationError);
  });

  // ── v1.19: typed acceptance oracles + advisory scopeHints ──
  test("accepts typed acceptance oracles: command, test, judge", () => {
    const g = validateGraph(graph([task({ acceptance: [
      { oracle: "command", command: "npm test" },
      { oracle: "test", test: "auth suite" },
      { oracle: "judge", text: "behaves under load" },
    ] })]));
    expect(g.tasks[0].acceptance).toEqual([
      { oracle: "command", command: "npm test" },
      { oracle: "test", test: "auth suite" },
      { oracle: "judge", text: "behaves under load" },
    ]);
  });

  test("a plain-string acceptance (pre-v1.19 graph) still validates unchanged — backward compat", () => {
    const g = validateGraph(graph([task({ acceptance: ["thing observable", "another"] })]));
    expect(g.tasks[0].acceptance).toEqual(["thing observable", "another"]);
  });

  test("rejects a typed acceptance entry naming an unknown oracle — fails loudly", () => {
    expect(() => validateGraph(graph([task({ acceptance: [{ oracle: "deploy", command: "x" }] })]))).toThrow(GraphValidationError);
  });

  test("rejects a typed command oracle carrying an empty command", () => {
    expect(() => validateGraph(graph([task({ acceptance: [{ oracle: "command", command: "" }] })]))).toThrow(GraphValidationError);
  });

  test("accepts optional scopeHints with {paths, confidence, reason}", () => {
    const g = validateGraph(graph([task({ scopeHints: [{ paths: ["src/**"], confidence: 0.8, reason: "touches auth" }] })]));
    expect(g.tasks[0].scopeHints?.[0]).toEqual({ paths: ["src/**"], confidence: 0.8, reason: "touches auth" });
  });

  test("scopeHints absent is valid (purely advisory, optional)", () => {
    expect(validateGraph(graph([task()])).tasks[0].scopeHints).toBeUndefined();
  });

  test("scopeHints with paths only (partial) validates", () => {
    const g = validateGraph(graph([task({ scopeHints: [{ paths: ["src/a.ts"] }] })]));
    expect(g.tasks[0].scopeHints?.[0].confidence).toBeUndefined();
  });

  test("rejects scopeHints confidence out of [0,1]", () => {
    expect(() => validateGraph(graph([task({ scopeHints: [{ paths: ["src/**"], confidence: 1.5 }] })]))).toThrow(GraphValidationError);
  });

  // v1.39 OBS-37b: optional per-task timeout override
  test("accepts optional timeoutMinutes (positive number)", () => {
    const g = validateGraph(graph([task({ timeoutMinutes: 45 })]));
    expect(g.tasks[0].timeoutMinutes).toBe(45);
  });

  test("timeoutMinutes absent is valid (pre-v1.39 graph compat)", () => {
    expect(validateGraph(graph([task()])).tasks[0].timeoutMinutes).toBeUndefined();
  });

  test("rejects timeoutMinutes ≤ 0", () => {
    expect(() => validateGraph(graph([task({ timeoutMinutes: 0 })]))).toThrow(GraphValidationError);
    expect(() => validateGraph(graph([task({ timeoutMinutes: -5 })]))).toThrow(GraphValidationError);
  });
});

describe("renderAcceptanceItem (shared text rendering — v1.19)", () => {
  test("plain string renders bare (byte-identical to a typed judge)", () => {
    expect(renderAcceptanceItem("observable outcome")).toBe("observable outcome");
  });
  test("command/test/judge oracles render as readable text", () => {
    expect(renderAcceptanceItem({ oracle: "command", command: "npm test" })).toBe("$ npm test");
    expect(renderAcceptanceItem({ oracle: "test", test: "auth suite" })).toBe("test: auth suite");
    expect(renderAcceptanceItem({ oracle: "judge", text: "behaves" })).toBe("behaves");
  });
});

test("schema parity serializes a canonical plan containing source, paths, hash, optional base and admission facts through validateGraph, generated rungraph schema and disk reload byte-equivalently, while deleting each durable field before reload produces the documented compatible-optional or fail-closed result", () => {
  const plan: PlanIR = {
    version: 1,
    mode: "staff-led",
    source: "native",
    paths: ["specs/canonical.spec.md"],
    hash: "canonical-source-hash",
    base: "refs/heads/canonical-base",
    tasks: [
      {
        id: "T1",
        title: "Preserve admission facts",
        goal: "Canonical plan facts reach every durable consumer",
        shape: "implement",
        complexity: 4,
        deps: [],
        files: ["src/graph/schema.ts"],
        context: [],
        acceptance: ["canonical facts survive"],
        gates: [...GATE_NAMES],
        routingHints: { floor: "frontier", source: "canonical.spec.md" },
        humanGate: true,
        status: "pending",
        evidence: { commits: [], artifacts: [], gateResults: [] },
      },
    ],
  };
  const canonical = finalizePlan(plan, "canonical-plan");
  expect(validateGraph(canonical)).toEqual(canonical);
  expect(canonical).toMatchObject({
    mode: plan.mode,
    spec: { source: plan.source, paths: plan.paths, hash: plan.hash, base: plan.base },
    tasks: [{ humanGate: true, routingHints: { floor: "frontier", source: "canonical.spec.md" } }],
  });

  const generated = JSON.parse(readFileSync("schema/rungraph.schema.json", "utf8")) as {
    properties: {
      mode: { enum: string[] };
      spec: {
        properties: { source: { enum: string[] }; base: { type: string; minLength: number } };
        required: string[];
      };
    };
    required: string[];
  };
  expect(generated.properties.mode.enum).toEqual([...GRAPH_ROUTING_MODES]);
  expect(generated.properties.spec.properties.source.enum).toEqual([...SPEC_SOURCES]);
  expect(generated.properties.spec.properties.base).toEqual({ type: "string", minLength: 1 });
  expect(generated.properties.spec.required).toEqual(["source", "paths", "hash"]);
  expect(generated.required).toEqual(["version", "spec", "tasks"]);

  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-schema-parity-"));
  saveGraph(repo, canonical);
  expect(readFileSync(graphPath(repo), "utf8")).toBe(`${JSON.stringify(canonical, null, 2)}\n`);
  expect(loadGraph(repo)).toEqual(canonical);

  type MutableGraph = Record<string, unknown> & { spec?: Record<string, unknown> };
  const deletionContract: Array<{
    field: string;
    result: "compatible-optional" | "fail-closed";
    remove: (graph: MutableGraph) => void;
  }> = [
    { field: "version", result: "fail-closed", remove: (g) => { delete g.version; } },
    { field: "mode", result: "compatible-optional", remove: (g) => { delete g.mode; } },
    { field: "spec.source", result: "fail-closed", remove: (g) => { delete g.spec?.source; } },
    { field: "spec.paths", result: "fail-closed", remove: (g) => { delete g.spec?.paths; } },
    { field: "spec.hash", result: "fail-closed", remove: (g) => { delete g.spec?.hash; } },
    { field: "spec.base", result: "compatible-optional", remove: (g) => { delete g.spec?.base; } },
    { field: "tasks", result: "fail-closed", remove: (g) => { delete g.tasks; } },
  ];
  for (const contract of deletionContract) {
    const changed = structuredClone(canonical) as MutableGraph;
    contract.remove(changed);
    writeFileSync(graphPath(repo), `${JSON.stringify(changed, null, 2)}\n`);
    if (contract.result === "compatible-optional") {
      const loaded = loadGraph(repo);
      if (contract.field === "mode") expect(loaded.mode, contract.field).toBeUndefined();
      else expect(loaded.spec.base, contract.field).toBeUndefined();
    } else {
      expect(() => loadGraph(repo), contract.field).toThrow(GraphValidationError);
    }
  }
});
