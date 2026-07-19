// E3 (v1.45-T3): routing.explore fence + --no-explore run flag oracles.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { allAdapters } from "../../src/adapters/registry.js";
import { type BillingChannel, channelsFromConfig } from "../../src/adapters/types.js";
import { type TickmarkrConfig, loadConfig } from "../../src/config/config.js";
import { SHAPES, validateGraph } from "../../src/graph/schema.js";
import {
  buildProfile, cellOf, EXPLORE_CAP, explorationBonus,
  type ProfileRow, type RoutingProfile,
} from "../../src/route/profile.js";
import { NO_EXPLORE_ENV, route } from "../../src/route/router.js";

const channelsOf = (cfg: TickmarkrConfig): BillingChannel[] =>
  allAdapters().map((a) => a.id).filter((id) => id !== "fake").flatMap((id) => channelsFromConfig(id, cfg));
const emptyRepo = () => ({ repo: mkdtempSync(join(tmpdir(), "tickmarkr-r-")), globalDir: mkdtempSync(join(tmpdir(), "tickmarkr-g-")) });
const cfgOf = () => { const { repo, globalDir } = emptyRepo(); return loadConfig(repo, { globalDir }); };
function repoWithOverlay(yaml: string, globalDir?: string) {
  const gDir = globalDir ?? mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return { repo, globalDir: gDir };
}

const mkTask = (shape: string, over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"], ...over }],
  }).tasks[0];

const warmRows = (shape: string, adapter: string, model: string, n = 6): ProfileRow[] =>
  Array.from({ length: n }, () => ({
    shape, adapter, model, channel: "sub", attempts: 1, outcome: "done" as const,
    durationMs: 1000, gateFails: 0, consults: 0,
  }));

const badRows = (shape: string, adapter: string, model: string, n: number): ProfileRow[] =>
  Array.from({ length: n }, () => ({
    shape, adapter, model, channel: "sub", attempts: 1, outcome: "human" as const,
    parkKind: "gate-fail", durationMs: 1000, gateFails: 1, consults: 0,
  }));

// Probe fixture: warm cursor-agent incumbent + under-cap hostile codex (ROUTE-17 starvation shape).
const probeProfile = (shape = "implement"): RoutingProfile => buildProfile([
  ...warmRows(shape, "cursor-agent", "composer-2.5", 6),
  ...badRows(shape, "codex", "gpt-5.6-terra", 2),
]);

const routeFields = (r: ReturnType<typeof route>) => ({
  assignment: r.assignment,
  provenance: r.provenance,
  deviation: r.deviation,
  lints: r.lints,
});

describe("E3 explore scoping", () => {
  afterEach(() => { delete process.env[NO_EXPLORE_ENV]; });

  test("absent explore config routes byte-identically to before this change", () => {
    const { repo, globalDir } = emptyRepo();
    const cfgAbsent = loadConfig(repo, { globalDir });
    const cfgExplicit = loadConfig(
      repoWithOverlay("routing:\n  explore:\n    mode: on\n    excludeShapes: []\n    cap: 5", globalDir).repo,
      { globalDir },
    );
    const channels = channelsOf(cfgAbsent);
    const profile = probeProfile();
    for (const shape of SHAPES) {
      const t = mkTask(shape);
      expect(routeFields(route(t, cfgExplicit, channels, profile))).toEqual(
        routeFields(route(t, cfgAbsent, channels, profile)),
      );
    }
  });

  test("explore mode off dispatches no exploration probe", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  explore:\n    mode: off");
    const cfg = loadConfig(repo, { globalDir });
    const r = route(mkTask("implement"), cfg, channelsOf(cfg), probeProfile());
    expect(r.provenance).not.toMatch(/exploration probe/);
    expect(r.deviation?.explore).toBeUndefined();
  });

  test("an excluded shape never receives an exploration probe", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  explore:\n    excludeShapes: [implement]");
    const cfg = loadConfig(repo, { globalDir });
    const r = route(mkTask("implement"), cfg, channelsOf(cfg), probeProfile("implement"));
    expect(r.provenance).not.toMatch(/exploration probe/);
    expect(r.deviation?.explore).toBeUndefined();
    // control: non-excluded shape still probes under the same config
    const choreProfile = buildProfile([
      ...warmRows("chore", "claude-code", "haiku", 6),
      ...badRows("chore", "codex", "gpt-5.6-luna", 2),
    ]);
    const rChore = route(mkTask("chore"), cfg, channelsOf(cfg), choreProfile);
    expect(rChore.provenance).toMatch(/exploration probe/);
  });

  test("a task at or above the excluded complexity never receives an exploration probe", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  explore:\n    excludeComplexityAtOrAbove: 7");
    const cfg = loadConfig(repo, { globalDir });
    const rHigh = route(mkTask("implement", { complexity: 7 }), cfg, channelsOf(cfg), probeProfile());
    expect(rHigh.provenance).not.toMatch(/exploration probe/);
    expect(rHigh.deviation?.explore).toBeUndefined();
    const rLow = route(mkTask("implement", { complexity: 6 }), cfg, channelsOf(cfg), probeProfile());
    expect(rLow.provenance).toMatch(/exploration probe/);
  });

  test("the cap bounds exploration dispatches per channel", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  explore:\n    cap: 2");
    const cfg = loadConfig(repo, { globalDir });
    const shape = "implement";
    const Bkey = "codex:gpt-5.6-terra";
    const aRows = warmRows(shape, "cursor-agent", "composer-2.5", 6);
    const bRows = badRows(shape, "codex", "gpt-5.6-terra", 2);
    const p = buildProfile([...aRows, ...bRows]);
    expect(explorationBonus(cellOf(p, shape, Bkey, "sub"), 2)).toBe(0);
    const r = route(mkTask(shape), cfg, channelsOf(cfg), p);
    expect(r.provenance).not.toMatch(/exploration probe/);
    expect(r.deviation?.explore).toBeUndefined();
    // control: default cap still probes at dispatches=2
    const cfgDefault = cfgOf();
    const rDefault = route(mkTask(shape), cfgDefault, channelsOf(cfgDefault), p);
    expect(rDefault.provenance).toMatch(/exploration probe \(dispatches=2 < 5\)/);
    expect(explorationBonus(cellOf(p, shape, Bkey, "sub"), EXPLORE_CAP)).toBeGreaterThan(0);
  });

  test("the no-explore run flag disables exploration for that run", () => {
    const cfg = cfgOf();
    const channels = channelsOf(cfg);
    const profile = probeProfile();
    const baseline = route(mkTask("implement"), cfg, channels, profile);
    expect(baseline.provenance).toMatch(/exploration probe/);
    process.env[NO_EXPLORE_ENV] = "1";
    const blocked = route(mkTask("implement"), cfg, channels, profile);
    expect(blocked.provenance).not.toMatch(/exploration probe/);
    expect(blocked.deviation?.explore).toBeUndefined();
    const blockedCtx = route(mkTask("implement"), cfg, channels, profile, undefined, undefined, { noExplore: true });
    expect(blockedCtx.provenance).toBe(blocked.provenance);
  });
});
