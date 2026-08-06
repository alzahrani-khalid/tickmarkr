import { expect, test } from "vitest";
import type { BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, loadConfigWithMode, type TickmarkrConfig, type Tier } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import { route } from "../../src/route/router.js";

const CHANNELS: BillingChannel[] = [
  { adapter: "opencode", vendor: "mixed", model: "cheap", channel: "sub", tier: "cheap" },
  { adapter: "codex", vendor: "openai", model: "mid", channel: "sub", tier: "mid" },
  { adapter: "claude-code", vendor: "anthropic", model: "frontier", channel: "sub", tier: "frontier" },
];

const task = (over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 5, acceptance: ["a"], ...over }],
  }).tasks[0];

function configWithMapPin(floor?: Tier): TickmarkrConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.routing.map = { implement: { pin: { via: "opencode", model: "cheap" } } };
  cfg.routing.floors = floor ? { implement: floor } : {};
  return cfg;
}

test("a map pin overrides the floors below it and the advisory-floor lint names the floor it overrode, proven member by member over the closed set of floor sources with the expected floor named per fixture — a task-hint fixture naming the task floor, a config-floor fixture naming the config floor and no task floor, and a both-floors fixture naming the task floor as the overridden one", () => {
  const fixtures: Array<{ name: string; configFloor?: Tier; taskFloor?: Tier; expected: string }> = [
    {
      name: "task hint",
      taskFloor: "frontier",
      expected: "T1 (implement): map pin routes cheap, below task floor frontier — map pins are supreme",
    },
    {
      name: "config floor",
      configFloor: "mid",
      expected: "T1 (implement): map pin routes cheap, below config floor mid — map pins are supreme",
    },
    {
      name: "both floors",
      configFloor: "mid",
      taskFloor: "frontier",
      expected: "T1 (implement): map pin routes cheap, below task floor frontier — map pins are supreme",
    },
  ];

  for (const fixture of fixtures) {
    const routed = route(
      task(fixture.taskFloor ? { routingHints: { floor: fixture.taskFloor } } : {}),
      configWithMapPin(fixture.configFloor),
      CHANNELS,
    );
    expect(JSON.stringify(routed.assignment), fixture.name).toBe(
      '{"adapter":"opencode","model":"cheap","channel":"sub","tier":"cheap"}',
    );
    expect(routed.lints, fixture.name).toEqual([fixture.expected]);
    if (!fixture.taskFloor) expect(routed.lints.join("\n"), fixture.name).not.toContain("task floor");
  }
});

test("routing verdicts are byte-identical to the pre-change router across the closed set of precedence cases — a task-pin fixture, a map-pin fixture, a floor-only fixture and an auto fixture", () => {
  const taskPinCfg = configWithMapPin("mid");
  const floorOnlyCfg = configWithMapPin("mid");
  floorOnlyCfg.routing.map = {};
  const autoCfg = configWithMapPin();
  autoCfg.routing.map = {};

  const fixtures = [
    {
      name: "task pin",
      actual: route(task({ routingHints: { pin: { via: "claude-code", model: "frontier" }, floor: "frontier" } }), taskPinCfg, CHANNELS),
      expected: '{"adapter":"claude-code","model":"frontier","channel":"sub","tier":"frontier"}',
    },
    {
      name: "map pin",
      actual: route(task({ routingHints: { floor: "frontier" } }), configWithMapPin("mid"), CHANNELS),
      expected: '{"adapter":"opencode","model":"cheap","channel":"sub","tier":"cheap"}',
    },
    {
      name: "floor only",
      actual: route(task(), floorOnlyCfg, CHANNELS),
      expected: '{"adapter":"codex","model":"mid","channel":"sub","tier":"mid"}',
    },
    {
      name: "auto",
      actual: route(task(), autoCfg, CHANNELS),
      expected: '{"adapter":"opencode","model":"cheap","channel":"sub","tier":"cheap"}',
    },
  ];

  for (const fixture of fixtures) {
    // Assignment bytes are the routing verdict; lints are excluded because this task intentionally corrects their text.
    expect(JSON.stringify(fixture.actual.assignment), fixture.name).toBe(fixture.expected);
  }
});

test("both runtime texts in the map-pin truth contract state map-pin supremacy, proven member by member over that closed set — the advisory-floor lint exercised through the map-pin routing path, and the integrity lint exercised through mode resolution — each asserted on the string its own production path emits rather than on any source text", () => {
  const routed = route(task({ routingHints: { floor: "frontier" } }), configWithMapPin("mid"), CHANNELS);
  const { mode } = loadConfigWithMode("/nonexistent-tickmarkr-t10-repo", {
    globalDir: "/nonexistent-tickmarkr-t10-global",
    repoOverlayText: "routing:\n  floors:\n    migration: mid\n",
  });
  const runtimeTexts = [
    {
      name: "map-pin routing path",
      actual: routed.lints[0],
      expected: "T1 (implement): map pin routes cheap, below task floor frontier — map pins are supreme",
    },
    {
      name: "mode-resolution path",
      actual: mode.lints[0],
      expected: "floors.migration: mid is below integrity minimum frontier — integrity class plan/spec/migration/ui is advisory to explicit floors and map pins; map pins are supreme",
    },
  ];

  for (const runtimeText of runtimeTexts) {
    expect(runtimeText.actual, runtimeText.name).toBe(runtimeText.expected);
    expect(runtimeText.actual, runtimeText.name).toContain("map pins are supreme");
  }
});
