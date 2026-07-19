import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { allAdapters } from "../../src/adapters/registry.js";
import { type BillingChannel, channelKey, channelsFromConfig } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, type TickmarkrConfig, loadConfig } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import { buildProfile, cellOf, explorationBonus, learnedScore, type ProfileCell, type ProfileRow, type RoutingProfile } from "../../src/route/profile.js";
import { route } from "../../src/route/router.js";

const channelsOf = (cfg: TickmarkrConfig): BillingChannel[] =>
  allAdapters().map((a) => a.id).filter((id) => id !== "fake").flatMap((id) => channelsFromConfig(id, cfg));
const emptyRepo = () => ({ repo: mkdtempSync(join(tmpdir(), "tickmarkr-r-")), globalDir: mkdtempSync(join(tmpdir(), "tickmarkr-g-")) });
const cfgOf = () => { const { repo, globalDir } = emptyRepo(); return loadConfig(repo, { globalDir }); };

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

// ROUTE-08 spy: cellOf → profile.cells.get(...) is the ONLY read path, so reads===0 proves non-consultation.
class CountingCells extends Map<string, ProfileCell> {
  reads = 0;
  override get(k: string) { this.reads++; return super.get(k); }
}
const spyProfile = (cells?: [string, ProfileCell][]) => {
  const m = new CountingCells(cells);
  return { profile: { cells: m } as RoutingProfile, m };
};
const warmSpy = (shape: string, adapter: string, model: string) =>
  spyProfile([...buildProfile(warmRows(shape, adapter, model)).cells]);

describe("ROUTE-08: pins/maps never consult the profile (spy-proven)", () => {
  test("Row 1 — task pin: assignment = pin AND reads === 0", () => {
    const cfg = cfgOf();
    const { profile, m } = warmSpy("chore", "codex", "gpt-5.6-luna"); // hostile: favors a non-pin channel
    const t = mkTask("chore", { routingHints: { pin: { via: "claude-code", model: "haiku" } } });
    const r = route(t, cfg, channelsOf(cfg), profile);
    expect(channelKey(r.assignment)).toBe("claude-code:haiku");
    expect(m.reads).toBe(0);
  });

  test("Row 2 — map pin: assignment = claude-code:fable AND reads === 0", () => {
    const cfg = cfgOf();
    const { profile, m } = warmSpy("plan", "codex", "gpt-5.6-luna");
    const r = route(mkTask("plan"), cfg, channelsOf(cfg), profile);
    expect(channelKey(r.assignment)).toBe("claude-code:fable");
    expect(m.reads).toBe(0);
  });
});

describe("ROUTE-08: floors / prefer / cost / tier all outrank the learned score", () => {
  test("Row 3 — floor: migration stays frontier despite a warm cheap channel", () => {
    const cfg = cfgOf();
    const profile = buildProfile(warmRows("migration", "claude-code", "haiku", 20)); // cheap, warm
    const r = route(mkTask("migration"), cfg, channelsOf(cfg), profile);
    expect(r.assignment.tier).toBe("frontier");
  });

  test("Row 4 — prefer beats score: implement stays cursor-agent:composer-2.5", () => {
    const cfg = cfgOf();
    const profile = buildProfile(warmRows("implement", "claude-code", "sonnet", 20)); // non-preferred, warm
    const r = route(mkTask("implement"), cfg, channelsOf(cfg), profile);
    expect(channelKey(r.assignment)).toBe("cursor-agent:composer-2.5");
  });

  test("Row 5 — cost beats score: sub wins over a warm api channel", () => {
    const cfg = cfgOf();
    const channels: BillingChannel[] = [
      { adapter: "a", vendor: "v", model: "m1", channel: "sub", tier: "cheap" },
      { adapter: "b", vendor: "v", model: "m2", channel: "api", tier: "cheap" },
    ];
    const profile = buildProfile(warmRows("chore", "b", "m2", 20)); // favors the api channel
    const r = route(mkTask("chore"), cfg, channels, profile);
    expect(channelKey(r.assignment)).toBe("a:m1"); // sub (marginal-cost 0) still wins
  });

  test("Row 6 — tier beats score: cheapest sufficient tier wins over a warm higher tier", () => {
    const cfg = cfgOf();
    const channels: BillingChannel[] = [
      { adapter: "a", vendor: "v", model: "m1", channel: "sub", tier: "cheap" },
      { adapter: "b", vendor: "v", model: "m2", channel: "sub", tier: "mid" },
    ];
    const profile = buildProfile(warmRows("chore", "b", "m2", 20)); // favors the mid channel
    const r = route(mkTask("chore"), cfg, channels, profile);
    expect(channelKey(r.assignment)).toBe("a:m1"); // cheap tier still wins
  });
});

describe("ROUTE-06 (Row 7): learned score decides the cheap-sub discovery tie", () => {
  test("warm codex:gpt-5.6-luna beats the discovery-first claude-code:haiku", () => {
    const cfg = cfgOf();
    const channels = channelsOf(cfg);
    // static: chore ties claude-code:haiku vs codex:gpt-5.6-luna on all 3 keys ⇒ discovery picks haiku
    expect(channelKey(route(mkTask("chore"), cfg, channels).assignment)).toBe("claude-code:haiku");
    const profile = buildProfile(warmRows("chore", "codex", "gpt-5.6-luna"));
    const r = route(mkTask("chore"), cfg, channels, profile);
    expect(channelKey(r.assignment)).toBe("codex:gpt-5.6-luna");
    expect(r.provenance).toMatch(/via learned score \d\.\d{3} \(n=\d+\) over \S+ \d\.\d{3}/);
    expect(r.deviation).toEqual({
      static: "claude-code:haiku", chosen: "codex:gpt-5.6-luna",
      score: expect.any(Number), staticScore: expect.any(Number), n: expect.any(Number),
    });
    // insurance: both scores are finite (Phase 12 totality)
    expect(Number.isFinite(learnedScore(profile, "chore", "codex:gpt-5.6-luna", "sub"))).toBe(true);
    expect(Number.isFinite(learnedScore(profile, "chore", "claude-code:haiku", "sub"))).toBe(true);
  });
});

describe("VIS-01 negatives: score-irrelevant routes keep today's exact provenance", () => {
  test("warm profile but prefer decided ⇒ provenance equals the 3-arg call", () => {
    const cfg = cfgOf();
    const channels = channelsOf(cfg);
    const base = route(mkTask("implement"), cfg, channels);
    const profile = buildProfile(warmRows("implement", "claude-code", "sonnet", 20));
    const r = route(mkTask("implement"), cfg, channels, profile);
    expect(r.provenance).toBe(base.provenance);
    expect(r.assignment).toEqual(base.assignment);
    expect(r.deviation).toBeUndefined();
  });
});

describe("PROF-04: sub and api cells split", () => {
  const shape = "chore";
  const adapter = "codex";
  const model = "gpt-5.6-luna";
  const chKey = "codex:gpt-5.6-luna";
  const cleanRow = (channel: "sub" | "api"): ProfileRow => ({
    shape, adapter, model, channel, attempts: 1, outcome: "done",
    durationMs: 1000, gateFails: 0, consults: 0,
  });

  test("Test A — same shape+model, one sub + one api ⇒ two cells, each n=1 dispatches=1", () => {
    const p = buildProfile([cleanRow("sub"), cleanRow("api")]);
    expect(p.cells.size).toBe(2);
    expect(cellOf(p, shape, chKey, "sub")!.n).toBe(1);
    expect(cellOf(p, shape, chKey, "sub")!.dispatches).toBe(1);
    expect(cellOf(p, shape, chKey, "api")!.n).toBe(1);
    expect(cellOf(p, shape, chKey, "api")!.dispatches).toBe(1);
  });

  test("Test B — sub quota parks do NOT drain the api sibling's exploration budget", () => {
    const subQuota: ProfileRow[] = Array.from({ length: 5 }, () => ({
      shape, adapter, model, channel: "sub" as const, attempts: 1,
      outcome: "human" as const, parkKind: "quota", durationMs: 1000,
    }));
    const p = buildProfile([...subQuota, cleanRow("api")]);
    expect(p.cells.size).toBe(2);
    const apiCell = cellOf(p, shape, chKey, "api")!;
    const subCell = cellOf(p, shape, chKey, "sub")!;
    expect(apiCell.dispatches).toBe(1);
    expect(explorationBonus(apiCell)).toBe(0.8); // 1 - 1/5
    expect(subCell.dispatches).toBe(5);
    expect(Object.is(explorationBonus(subCell), 0)).toBe(true); // budget spent
    expect(cellOf(p, shape, chKey, "sub")).not.toBe(cellOf(p, shape, chKey, "api"));
  });

  test("Test C — warm sub coexists with a neutral cold api sibling of the same model", () => {
    const subRows = Array.from({ length: 6 }, () => cleanRow("sub"));
    const p = buildProfile([...subRows, cleanRow("api")]);
    expect(learnedScore(p, shape, chKey, "sub")).toBeGreaterThan(0);
    expect(Object.is(learnedScore(p, shape, chKey, "api"), 0)).toBe(true); // n=1 < MIN_SAMPLES ⇒ neutral
    expect(cellOf(p, shape, chKey, "sub")).not.toBe(cellOf(p, shape, chKey, "api"));
  });

  test("Test D — DEFAULT_CONFIG has no (adapter,model) pair on BOTH classes (dilution unpaid today)", () => {
    const chans = allAdapters().map((a) => a.id).filter((id) => id !== "fake")
      .flatMap((id) => channelsFromConfig(id, DEFAULT_CONFIG));
    expect(chans.length).toBeGreaterThan(0); // non-vacuous
    const classes = new Map<string, Set<string>>();
    for (const c of chans) {
      const k = channelKey(c);
      if (!classes.has(k)) classes.set(k, new Set());
      classes.get(k)!.add(c.channel);
    }
    for (const [k, set] of classes) {
      expect(set.size, `${k} appears under both sub and api`).toBe(1);
    }
  });
});

// ROUTE-10 pin retired by ROUTE-13 (v1.8): nextChannel is now learning-AWARE within bands.
// Successor oracles: tests/route/failover.test.ts — band-invariance matrix (bands unmovable)
// + within-band value test + cold-parity full-order + no-bonus pin.
describe("ROUTE-13: nextChannel stays exploration-blind (grep-pin successor of ROUTE-10)", () => {
  test("source slice from `export function nextChannel` never references explorationBonus", () => {
    const src = readFileSync(fileURLToPath(new URL("../../src/route/router.ts", import.meta.url)), "utf8");
    const slice = src.slice(src.indexOf("export function nextChannel"));
    expect(slice).not.toMatch(/explorationBonus/);
    expect(slice).not.toMatch(/bonusOf/);
  });
});
