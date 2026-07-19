// v1.51 T1: routing.mode — presets compile to floors with provenance at config load.
// The router never sees the mode; it receives resolved floors only.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import type { BillingChannel } from "../../src/adapters/types.js";
import { plan } from "../../src/cli/commands/plan.js";
import {
  ConfigError, configTemplate, DEFAULT_CONFIG, INTEGRITY_FLOOR_SHAPES, loadConfig, loadConfigWithMode, ROUTING_MODES,
} from "../../src/config/config.js";
import { saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { SHAPES, validateGraph } from "../../src/graph/schema.js";
import { route } from "../../src/route/router.js";
import { authedModels, makeRepo } from "../helpers/tmprepo.js";

function repoWithOverlay(yaml: string, globalYaml?: string) {
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-mode-g-"));
  if (globalYaml) writeFileSync(join(globalDir, "config.yaml"), globalYaml);
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-mode-r-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  if (yaml) writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return { repo, globalDir };
}

const load = (yaml: string, globalYaml?: string) => {
  const { repo, globalDir } = repoWithOverlay(yaml, globalYaml);
  return loadConfigWithMode(repo, { globalDir });
};

// one channel per tier so every floor is satisfiable, plus the seeded map pins/prefers resolve
const CH: BillingChannel[] = [
  { adapter: "claude-code", vendor: "anthropic", model: "fable", channel: "sub", tier: "frontier" },
  { adapter: "claude-code", vendor: "anthropic", model: "sonnet", channel: "sub", tier: "mid" },
  { adapter: "claude-code", vendor: "anthropic", model: "haiku", channel: "sub", tier: "cheap" },
  { adapter: "cursor-agent", vendor: "cursor", model: "composer-2.5", channel: "sub", tier: "mid" },
  { adapter: "opencode", vendor: "mixed", model: "zai-coding-plan/glm-5.2", channel: "sub", tier: "mid" },
];

const mkTask = (shape: string) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"] }],
  }).tasks[0];

describe("v1.51 T1 mode resolution core", () => {
  test("absent mode routes byte-identically to before this change", () => {
    const { cfg, mode } = load("");
    expect(mode.mode).toBe("risk-based");
    // DEFAULT_CONFIG predates the mode layer — it IS the pre-change routing input, and the
    // loaded config must equal it byte-for-byte (floors, explore, map, everything).
    expect(cfg).toEqual(DEFAULT_CONFIG);
    for (const shape of SHAPES) {
      expect(route(mkTask(shape), cfg, CH)).toEqual(route(mkTask(shape), DEFAULT_CONFIG, CH));
    }
  });

  test("partner-led resolves every shape floor to frontier", () => {
    const { cfg } = load("routing:\n  mode: partner-led\n");
    for (const shape of SHAPES) expect(cfg.routing.floors[shape]).toBe("frontier");
  });

  test("staff-led resolves implement and refactor to cheap", () => {
    const { cfg } = load("routing:\n  mode: staff-led\n");
    expect(cfg.routing.floors.implement).toBe("cheap");
    expect(cfg.routing.floors.refactor).toBe("cheap");
    // non-integrity shapes already at cheap stay there (one band down clamps at cheap)
    expect(cfg.routing.floors.tests).toBe("cheap");
    expect(cfg.routing.floors.docs).toBe("cheap");
    expect(cfg.routing.floors.chore).toBe("cheap");
  });

  test("staff-led resolves plan spec migration and ui to frontier", () => {
    const { cfg } = load("routing:\n  mode: staff-led\n");
    for (const shape of INTEGRITY_FLOOR_SHAPES) expect(cfg.routing.floors[shape]).toBe("frontier");
  });

  test("an explicit overlay floor beats the mode delta and draws a lint naming the shadowed delta", () => {
    const { cfg, mode } = load("routing:\n  mode: staff-led\n  floors:\n    implement: frontier\n");
    expect(cfg.routing.floors.implement).toBe("frontier"); // explicit wins unconditionally
    const lint = mode.lints.join("\n");
    expect(lint).toMatch(/floors\.implement: frontier \(config floors\) overrides mode staff-led/);
    expect(lint).toMatch(/shadowed delta: implement mid→cheap/);
    // a mode with no delta for that shape draws no shadow lint
    const agree = load("routing:\n  floors:\n    implement: frontier\n");
    expect(agree.mode.lints).toEqual([]);
  });

  test("an operator floor below the integrity minimum draws a standing lint", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  floors:\n    migration: mid\n");
    const first = loadConfigWithMode(repo, { globalDir });
    expect(first.cfg.routing.floors.migration).toBe("mid"); // operator wins — linted, never blocked
    const lint = first.mode.lints.join("\n");
    expect(lint).toMatch(/floors\.migration: mid is below integrity minimum frontier/);
    expect(lint).toMatch(/integrity class plan\/spec\/migration\/ui/);
    // standing: every subsequent load re-draws it, and a mode cannot silence it
    expect(loadConfigWithMode(repo, { globalDir }).mode.lints).toEqual(first.mode.lints);
    const underMode = load("routing:\n  mode: partner-led\n  floors:\n    ui: cheap\n");
    expect(underMode.cfg.routing.floors.ui).toBe("cheap");
    expect(underMode.mode.lints.join("\n")).toMatch(/floors\.ui: cheap is below integrity minimum frontier/);
  });

  test("partner-led resolves exploration off and staff-led keeps exploration on", () => {
    const p = load("routing:\n  mode: partner-led\n");
    expect(p.cfg.routing.explore?.mode).toBe("off");
    // absent explore block under staff-led stays absent = exploration on (the saving mechanism)
    const s = load("routing:\n  mode: staff-led\n");
    expect(s.cfg.routing.explore).toBeUndefined();
    // the round-2 explore fence rides through staff-led untouched
    const fenced = load(
      "routing:\n  mode: staff-led\n  explore:\n    mode: on\n    excludeShapes: [plan, spec, migration, ui]\n    excludeComplexityAtOrAbove: 7\n",
    );
    expect(fenced.cfg.routing.explore).toEqual({
      mode: "on", excludeShapes: ["plan", "spec", "migration", "ui"], excludeComplexityAtOrAbove: 7,
    });
  });

  test("every mode-derived floor carries provenance naming the mode", () => {
    const { mode } = load("routing:\n  mode: staff-led\n");
    for (const shape of SHAPES) expect(mode.provenance[shape]).toBe("mode staff-led");
    // an explicit floor is attributed to config, never the mode
    const mixed = load("routing:\n  mode: partner-led\n  floors:\n    tests: cheap\n");
    expect(mixed.mode.provenance.tests).toBe("config floors");
    for (const shape of SHAPES.filter((sh) => sh !== "tests")) {
      expect(mixed.mode.provenance[shape]).toBe("mode partner-led");
    }
  });
});

describe("v1.51 T1 mode edges", () => {
  test("an invalid mode name throws ConfigError naming the three modes", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  mode: economy\n");
    expect(() => loadConfigWithMode(repo, { globalDir })).toThrow(ConfigError);
    try {
      loadConfigWithMode(repo, { globalDir });
    } catch (e) {
      const msg = (e as ConfigError).message;
      expect(msg).toContain("economy");
      for (const m of ROUTING_MODES) expect(msg).toContain(m);
    }
  });

  test("explicit risk-based is identity: floors equal the defaults", () => {
    const { cfg, mode } = load("routing:\n  mode: risk-based\n");
    expect(mode.mode).toBe("risk-based");
    expect(cfg.routing.floors).toEqual(DEFAULT_CONFIG.routing.floors);
    expect(cfg.routing.explore).toBeUndefined();
  });

  test("repo mode overrides global mode through the existing layering", () => {
    const { cfg } = load("routing:\n  mode: partner-led\n", "routing:\n  mode: staff-led\n");
    expect(cfg.routing.mode).toBe("partner-led");
    for (const shape of SHAPES) expect(cfg.routing.floors[shape]).toBe("frontier");
  });

  test("a null floor tombstone stays removed — a mode never resurrects it", () => {
    const { cfg, mode } = load("routing:\n  mode: staff-led\n  floors:\n    tests: null\n");
    expect("tests" in cfg.routing.floors).toBe(false);
    expect("tests" in mode.provenance).toBe(false);
  });

  test("configTemplate documents the mode key and its three names", () => {
    const t = configTemplate();
    expect(t).toContain("mode: risk-based");
    for (const m of ROUTING_MODES) expect(t).toContain(m);
  });

  test("plan surfaces mode-resolution lints in the routing lints section", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 2, acceptance: ["a"] }],
    }));
    writeFileSync(
      join(tickmarkrDir(repo), "config.yaml"),
      "routing:\n  mode: staff-led\n  floors:\n    implement: frontier\n    migration: mid\n",
    );
    const verified = (id: string) => authedModels(Object.keys(loadConfig(repo).tiers[id]?.models ?? {}));
    writeDoctor(repo, Object.fromEntries(
      ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map((id) => [
        id, { installed: true, authed: true, models: [], modelAuth: verified(id) },
      ]),
    ));
    const out = await plan([], repo);
    expect(out).toContain("routing lints:");
    expect(out).toMatch(/overrides mode staff-led — shadowed delta: implement mid→cheap/);
    expect(out).toMatch(/floors\.migration: mid is below integrity minimum frontier/);
  });
});
