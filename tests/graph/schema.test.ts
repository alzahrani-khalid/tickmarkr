import { describe, expect, test } from "vitest";
import { GATE_NAMES, GraphValidationError, renderAcceptanceItem, validateGraph } from "../../src/graph/schema.js";

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
