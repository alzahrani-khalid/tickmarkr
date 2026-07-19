import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_CONFIG, INTEGRITY_FLOOR_SHAPES, loadConfig, ROUTING_MODES, TIER_RANK, type TickmarkrConfig,
} from "../../src/config/config.js";
import { type AuthHealth, type BillingChannel, channelsFromConfig } from "../../src/adapters/types.js";
import { allAdapters, discoverChannels } from "../../src/adapters/registry.js";
import { route } from "../../src/route/router.js";
import { validateGraph } from "../../src/graph/schema.js";
import { authedModels } from "../helpers/tmprepo.js";

// derive channels from ALL real adapters (incl. pi) via allAdapters() — a sixth adapter enrolls automatically.
// !== "fake" filter is mandatory: TICKMARKR_FAKE_SCRIPT prepends a FakeAdapter (registry.ts:17) — keep the oracle env-independent.
const channelsOf = (cfg: TickmarkrConfig): BillingChannel[] =>
  allAdapters().map((a) => a.id).filter((id) => id !== "fake").flatMap((id) => channelsFromConfig(id, cfg));

// copied verbatim from tests/config/config.test.ts:7-13 (not exported)
function repoWithOverlay(yaml: string, globalDir?: string) {
  const gDir = globalDir ?? mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return { repo, globalDir: gDir };
}

const emptyRepo = () => ({ repo: mkdtempSync(join(tmpdir(), "tickmarkr-r-")), globalDir: mkdtempSync(join(tmpdir(), "tickmarkr-g-")) });

const mkTask = (shape: string) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"] }],
  }).tasks[0];

describe("TEST-01 oracle roster — matrix derives all real adapters", () => {
  const { repo, globalDir } = emptyRepo();
  const cfg = loadConfig(repo, { globalDir }); // pure defaults
  const expectedRoster = allAdapters().map((a) => a.id).filter((id) => id !== "fake");

  test("roster pin: channelsOf enumerates every real adapter id", () => {
    const seen = [...new Set(channelsOf(cfg).map((c) => c.adapter))].sort();
    expect(seen).toEqual([...expectedRoster].sort());
  });

  // Both sides above derive from allAdapters(), so the pin is tautological w.r.t. removal — deleting an
  // adapter shrinks the quantified set too. Only a registry-INDEPENDENT constant bites. This floor does:
  // it enrolls a 6th adapter automatically but goes red if the fleet ever shrinks below five.
  test("roster floor: the fleet never silently shrinks below five real adapters", () => {
    expect(expectedRoster.length).toBeGreaterThanOrEqual(5);
  });

  test("pi bites: matrix contains pi's zai/glm-5.2 channel", () => {
    expect(channelsOf(cfg)).toContainEqual(expect.objectContaining({ adapter: "pi", model: "zai/glm-5.2" }));
  });
});

describe("ROUTE-05 defaults shape→channel matrix", () => {
  const { repo, globalDir } = emptyRepo();
  const cfg = loadConfig(repo, { globalDir }); // pure defaults
  const channels = channelsOf(cfg);

  // Finding 5 expected matrix (reseeded defaults, all four adapters healthy)
  const cases: [string, { adapter: string; model: string }][] = [
    ["plan", { adapter: "claude-code", model: "fable" }],
    ["spec", { adapter: "claude-code", model: "fable" }],
    ["implement", { adapter: "cursor-agent", model: "composer-2.5" }],
    ["tests", { adapter: "opencode", model: "zai-coding-plan/glm-5.2" }],
    ["docs", { adapter: "claude-code", model: "haiku" }],
    ["chore", { adapter: "claude-code", model: "haiku" }],
    ["ui", { adapter: "claude-code", model: "sonnet" }],
    ["refactor", { adapter: "claude-code", model: "sonnet" }],
    // v1.58 frontier spread: the 5-way frontier sub tie no longer falls to discovery order (fable);
    // the task-keyed rotation lands this fixture task on opus — a different task lands elsewhere
    ["migration", { adapter: "claude-code", model: "opus" }],
  ];

  test.each(cases)("%s → %o", (shape, expected) => {
    expect(route(mkTask(shape), cfg, channels).assignment).toMatchObject(expected);
  });
});

describe("ROUTE-04 reseeded DEFAULT_CONFIG tiers", () => {
  const { repo, globalDir } = emptyRepo();
  const cfg = loadConfig(repo, { globalDir });

  test("codex seeds: gpt-5.6 refresh, frontier-first insertion order, no gpt-5.4", () => {
    expect(cfg.tiers.codex.models).toEqual({
      "gpt-5.6-sol": "frontier",
      "gpt-5.5": "frontier",
      "gpt-5.6-terra": "mid",
      "gpt-5.6-luna": "cheap",
    });
    // insertion order is the same-tier tiebreak (channelsFromConfig preserves Object.entries order), so pin it
    expect(Object.keys(cfg.tiers.codex.models)).toEqual(["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect("gpt-5.4" in cfg.tiers.codex.models).toBe(false);
    expect("gpt-5.4-mini" in cfg.tiers.codex.models).toBe(false);
  });

  // MODEL-08 (23-LIVE-CHECK.md Finding 1): the codex frontier seed gpt-5.6-sol was live-probed OK on codex
  // 0.144.1, 2026-07-10 (the v1.7 refusal was a 0.143.0 client-version gate the upgrade closed). Value-pinned
  // here (NOT read from the codex client cache / home dir) so npm test stays hermetic — no network, no fs.
  // Distinct from ROUTE-04's full-map toEqual above: this pins the frontier-seed INVARIANT (tier + first-key
  // insertion order = the routing tiebreak) as a standalone regression guard against a stale-bug reseed.
  test("MODEL-08: codex frontier seed gpt-5.6-sol stays frontier + frontier-first (live-probed 2026-07-10)", () => {
    expect(cfg.tiers.codex.models["gpt-5.6-sol"]).toBe("frontier");
    expect(Object.keys(cfg.tiers.codex.models)[0]).toBe("gpt-5.6-sol");
  });

  // GLM-5.2 → mid per benchmark policy: SWE-bench Pro 62.1 (unchanged by the opencode 1.17.15 prefix rename).
  test("zai-coding-plan/glm-5.2 is mid, not cheap", () => {
    expect(cfg.tiers.opencode.models["zai-coding-plan/glm-5.2"]).toBe("mid");
  });

  test("cheap band is exactly haiku + gpt-5.6-luna + composer-2.5-fast + grok-composer-2.5-fast + kimi-for-coding-highspeed; cheap-floor tie → haiku (discovery order, D2 non-goal)", () => {
    const cheap = channelsOf(cfg).filter((c) => c.tier === "cheap").map((c) => `${c.adapter}:${c.model}`);
    // v1.25 T3: cursor-agent:grok-4.5-fast-xhigh retired (CLI dropped the id); native grok cheap seed stays
    // 2026-07-16: cursor-agent:composer-2.5-fast seeded cheap (fast variant, no independent scores → floor tier)
    // 2026-07-17: kimi:kimi-code/kimi-for-coding-highspeed seeded cheap (K2.7 fast variant)
    expect(cheap.sort()).toEqual(["claude-code:haiku", "codex:gpt-5.6-luna", "cursor-agent:composer-2.5-fast", "grok:grok-composer-2.5-fast", "kimi:kimi-code/kimi-for-coding-highspeed"]);
    expect(route(mkTask("chore"), cfg, channelsOf(cfg)).assignment).toMatchObject({ adapter: "claude-code", model: "haiku" });
  });
});

describe("ROUTE-05 overlay matrix (real loadConfig merge path)", () => {
  const overlay = [
    "tiers:",
    "  opencode:",
    "    models:",
    "      zai-coding-plan/glm-5.2: frontier",
    "routing:",
    "  map:",
    "    implement:",
    "      prefer: [codex, cursor-agent]",
    "",
  ].join("\n");
  const { repo, globalDir } = repoWithOverlay(overlay);
  const cfg = loadConfig(repo, { globalDir });
  const channels = channelsOf(cfg);

  test("implement: prefer group first, tiebreak picks terra mid over sol/5.5 frontier", () => {
    expect(route(mkTask("implement"), cfg, channels).assignment).toMatchObject({ adapter: "codex", model: "gpt-5.6-terra" });
  });

  test("tests: prefer opencode survives the retier → opencode:zai-coding-plan/glm-5.2", () => {
    expect(route(mkTask("tests"), cfg, channels).assignment).toMatchObject({ adapter: "opencode", model: "zai-coding-plan/glm-5.2" });
  });

  test("docs: still claude-code:haiku (cheap tie, discovery order)", () => {
    expect(route(mkTask("docs"), cfg, channels).assignment).toMatchObject({ adapter: "claude-code", model: "haiku" });
  });
});

describe("MODEL-04 detection is advisory — routing byte-identical with models on/off", () => {
  const { repo, globalDir } = emptyRepo();
  const cfg = loadConfig(repo, { globalDir }); // pure defaults
  const adapters = allAdapters();
  // every adapter installed+authed so discoverChannels' installed/authed filter never masks the models-diff we're guarding
  const mkHealth = (models: (id: string) => string[], stamp?: boolean): Record<string, AuthHealth> =>
    Object.fromEntries(adapters.map((a) => [a.id, { installed: true, authed: true, models: models(a.id), modelAuth: authedModels(a.channels(cfg).map((c) => c.model)), ...(stamp ? { modelsDetectedAt: new Date().toISOString() } : {}) }]));
  const healthEmpty = mkHealth(() => []);
  // populated incl. ids that are NOT in cfg.tiers — the exact leak Pitfall 1 warns about (a NaN-tier channel)
  const healthDetected = mkHealth((id) => [`${id}/detected-frontier-x`, `${id}/detected-cheap-y`], true);

  const shapes = ["plan", "spec", "implement", "tests", "docs", "chore", "ui", "refactor", "migration"];

  test("discoverChannels output deep-equals with detection present vs absent", () => {
    expect(discoverChannels(cfg, adapters, healthDetected)).toEqual(discoverChannels(cfg, adapters, healthEmpty));
  });

  test.each(shapes)("%s → identical assignment regardless of health.models", (shape) => {
    const chansEmpty = discoverChannels(cfg, adapters, healthEmpty);
    const chansDetected = discoverChannels(cfg, adapters, healthDetected);
    const t = mkTask(shape);
    expect(route(t, cfg, chansDetected).assignment).toEqual(route(t, cfg, chansEmpty).assignment);
  });
});

describe("FLEET-06 parity baseline (V-1/V-2) — pinned pre-implementation", () => {
  const { repo, globalDir } = emptyRepo();
  const cfg = loadConfig(repo, { globalDir }); // pure defaults
  const adapters = allAdapters().filter((a) => a.id !== "fake");
  const mkHealth = (): Record<string, AuthHealth> =>
    Object.fromEntries(adapters.map((a) => [a.id, { installed: true, authed: true, modelAuth: authedModels(a.channels(cfg).map((c) => c.model)) }]));
  const allHealthy = mkHealth();
  const channels = discoverChannels(cfg, adapters, allHealthy);

  test("V-1 discovery parity: discoverChannels deep-equals channelsFromConfig-derived baseline", () => {
    const expected = adapters.flatMap((a) => channelsFromConfig(a.id, cfg));
    expect(discoverChannels(cfg, adapters, allHealthy)).toEqual(expected);
  });

  const matrixCases: [string, { adapter: string; model: string; channel: string; tier: string }, string][] = [
    ["plan", { adapter: "claude-code", model: "fable", channel: "sub", tier: "frontier" }, "pin claude-code:fable (config routing.map)"],
    ["spec", { adapter: "claude-code", model: "fable", channel: "sub", tier: "frontier" }, "pin claude-code:fable (config routing.map)"],
    // v1.51 T3: map tiers migrated into floors — same assignments, provenance now names the floor authority
    ["implement", { adapter: "cursor-agent", model: "composer-2.5", channel: "sub", tier: "mid" }, "floor mid (config floors), marginal-cost auto (via prefer)"],
    ["tests", { adapter: "opencode", model: "zai-coding-plan/glm-5.2", channel: "sub", tier: "mid" }, "floor cheap (config floors), marginal-cost auto (via prefer)"],
    ["docs", { adapter: "claude-code", model: "haiku", channel: "sub", tier: "cheap" }, "floor cheap (config floors), marginal-cost auto (cheapest sufficient tier)"],
    ["chore", { adapter: "claude-code", model: "haiku", channel: "sub", tier: "cheap" }, "floor cheap (config floors), marginal-cost auto (cheapest sufficient tier)"],
    ["ui", { adapter: "claude-code", model: "sonnet", channel: "sub", tier: "mid" }, "floor mid (config floors), marginal-cost auto (cheapest sufficient tier)"],
    ["refactor", { adapter: "claude-code", model: "sonnet", channel: "sub", tier: "mid" }, "floor mid (config floors), marginal-cost auto (cheapest sufficient tier)"],
    // v1.58: the frontier spread breaks the 5-way frontier sub tie (was fable by discovery order)
    ["migration", { adapter: "claude-code", model: "opus", channel: "sub", tier: "frontier" }, "floor frontier (config floors), marginal-cost auto (via frontier spread)"],
  ];

  test.each(matrixCases)("V-2 route-matrix parity: %s", (shape, assignment, provenance) => {
    const r = route(mkTask(shape), cfg, channels);
    expect(r.assignment).toEqual(assignment);
    expect(r.provenance).toBe(provenance);
    expect(r.lints).toEqual([]);
  });
});

// v1.58 frontier spread — ruling constraint 3: the v1.51 integrity floors are UNTOUCHED. The spread
// changes who SERVES frontier, never what REQUIRES frontier.
describe("v1.58 frontier spread × v1.51 integrity floors", () => {
  test("integrity floor shapes never resolve below frontier in any mode", () => {
    for (const mode of ROUTING_MODES) {
      const { repo, globalDir } = repoWithOverlay(`routing:\n  mode: ${mode}\n`);
      const cfg = loadConfig(repo, { globalDir });
      const channels = channelsOf(cfg);
      for (const shape of INTEGRITY_FLOOR_SHAPES) {
        const resolved = cfg.routing.floors[shape];
        const dflt = DEFAULT_CONFIG.routing.floors[shape];
        // v1.51 clamp semantics: a mode either leaves the operator/default floor in place or
        // resolves it to frontier — no mode ever resolves an integrity floor downward
        expect(TIER_RANK[resolved]).toBeGreaterThanOrEqual(TIER_RANK[dflt]);
        if (resolved !== dflt) expect(resolved).toBe("frontier");
        // and with the spread live, every frontier-floored integrity shape still routes frontier —
        // the rotation permutes the frontier tie, it never admits a below-floor channel
        if (resolved === "frontier") {
          expect(route(mkTask(shape), cfg, channels).assignment.tier).toBe("frontier");
        }
      }
    }
  });
});
