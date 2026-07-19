import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { allAdapters } from "../../src/adapters/registry.js";
import { type BillingChannel, channelKey, channelsFromConfig } from "../../src/adapters/types.js";
import { type TickmarkrConfig, loadConfig } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import {
  buildProfile, cellOf, EXPLORE_CAP, explorationBonus, learnedScore,
  type ProfileCell, type ProfileRow, type RoutingProfile,
} from "../../src/route/profile.js";
import { route } from "../../src/route/router.js";

// ── helpers copied from learned.test.ts (house convention: test helpers are not exported) ──
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

// under-cap HOSTILE evidence: n gate-fail parks ⇒ classify=0, dispatches=n, score exactly 0 while n<MIN_SAMPLES
const badRows = (shape: string, adapter: string, model: string, n: number): ProfileRow[] =>
  Array.from({ length: n }, () => ({
    shape, adapter, model, channel: "sub", attempts: 1, outcome: "human" as const,
    parkKind: "gate-fail", durationMs: 1000, gateFails: 1, consults: 0,
  }));

const doneRow = (shape: string, adapter: string, model: string): ProfileRow => ({
  shape, adapter, model, channel: "sub", attempts: 1, outcome: "done",
  durationMs: 1000, gateFails: 0, consults: 0,
});
const badRow = (shape: string, adapter: string, model: string): ProfileRow => badRows(shape, adapter, model, 1)[0];

// ROUTE-08 spy: cellOf → profile.cells.get(...) is the ONLY read path, so reads===0 proves non-consultation.
class CountingCells extends Map<string, ProfileCell> {
  reads = 0;
  override get(k: string) { this.reads++; return super.get(k); }
}
const spyProfile = (cells?: [string, ProfileCell][]) => {
  const m = new CountingCells(cells);
  return { profile: { cells: m } as RoutingProfile, m };
};

const cell = (dispatches: number): ProfileCell => ({ n: 0, qSum: 0, dispatches, doneCount: 0, quotaHits: 0 });

// ── 14-01-02: totality (EXP-04 / T-14-02) ──
describe("14-01-02 explorationBonus is total and exact", () => {
  test("finite for every dispatch count, no cell ⇒ exactly 0, exact 0 at/after cap, range [0,1]", () => {
    for (const d of [0, 1, EXPLORE_CAP - 1, EXPLORE_CAP, EXPLORE_CAP + 1, 1e9]) {
      const b = explorationBonus(cell(d));
      expect(Number.isFinite(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
    expect(Object.is(explorationBonus(undefined), 0)).toBe(true);
    expect(Object.is(explorationBonus(cell(EXPLORE_CAP)), 0)).toBe(true);
    expect(Object.is(explorationBonus(cell(EXPLORE_CAP + 1)), 0)).toBe(true);
    expect(explorationBonus(cell(0))).toBe(1);
  });

  test("strictly decreasing on [0, CAP)", () => {
    for (let d = 0; d < EXPLORE_CAP - 1; d++) {
      expect(explorationBonus(cell(d))).toBeGreaterThan(explorationBonus(cell(d + 1)));
    }
  });
});

// ── 14-01-03: grep-pin (EXP-04) ──
describe("14-01-03 no RNG / no clock in the routing decision path", () => {
  test("neither router.ts nor profile.ts references Math.random/Date.now/new Date/process.hrtime/crypto", () => {
    for (const f of ["../../src/route/router.ts", "../../src/route/profile.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
      expect(src).not.toMatch(/Math\.random/);
      expect(src).not.toMatch(/Date\.now/);
      expect(src).not.toMatch(/new Date/);
      expect(src).not.toMatch(/process\.hrtime/);
      expect(src).not.toMatch(/crypto\./);
    }
  });
});

// ── 14-01-04: reproducibility (EXP-04) ──
describe("14-01-04 same profile + same graph ⇒ deep-equal assignments", () => {
  const cfg = cfgOf();
  const channels = channelsOf(cfg);
  // mixed: warm haiku + under-cap codex + cold everything else
  const profile = buildProfile([
    ...warmRows("chore", "claude-code", "haiku", 6),
    ...badRows("chore", "codex", "gpt-5.6-luna", 2),
  ]);

  test("route() is deterministic per shape", () => {
    for (const s of ["chore", "implement", "plan", "tests", "docs", "migration", "spec", "ui", "refactor"]) {
      const t = mkTask(s);
      expect(route(t, cfg, channels, profile)).toEqual(route(t, cfg, channels, profile));
    }
  });

  test("a whole-graph pass is identical on repeat", () => {
    const graph = validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: ["chore", "implement", "tests", "migration"].map((shape, i) => ({
        id: `T${i}`, title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"],
      })),
    });
    const pass = () => graph.tasks.map((t) => route(t, cfg, channels, profile));
    expect(pass()).toEqual(pass());
  });
});

// ── 14-01-05: immunity matrix (EXP-02 / T-14-03) ──
describe("14-01-05 an under-cap hostile cell never crosses a static boundary", () => {
  test("(a) task pin: assignment = pin AND profile never consulted (reads === 0)", () => {
    const cfg = cfgOf();
    const { profile, m } = spyProfile([...buildProfile(badRows("chore", "codex", "gpt-5.6-luna", 2)).cells]);
    const t = mkTask("chore", { routingHints: { pin: { via: "claude-code", model: "haiku" } } });
    const r = route(t, cfg, channelsOf(cfg), profile);
    expect(channelKey(r.assignment)).toBe("claude-code:haiku");
    expect(m.reads).toBe(0);
  });

  test("(b) map pin: assignment = claude-code:fable AND reads === 0", () => {
    const cfg = cfgOf();
    const { profile, m } = spyProfile([...buildProfile(badRows("plan", "codex", "gpt-5.6-luna", 2)).cells]);
    const r = route(mkTask("plan"), cfg, channelsOf(cfg), profile);
    expect(channelKey(r.assignment)).toBe("claude-code:fable");
    expect(m.reads).toBe(0);
  });

  test("(c) floor: migration stays frontier despite an under-cap cheap channel", () => {
    const cfg = cfgOf();
    const profile = buildProfile(badRows("migration", "claude-code", "haiku", 1));
    const r = route(mkTask("migration"), cfg, channelsOf(cfg), profile);
    expect(r.assignment.tier).toBe("frontier");
  });

  test("(d) prefer beats an under-cap non-preferred cell: implement stays cursor-agent:composer-2.5", () => {
    const cfg = cfgOf();
    const profile = buildProfile(badRows("implement", "claude-code", "sonnet", 2));
    const r = route(mkTask("implement"), cfg, channelsOf(cfg), profile);
    expect(channelKey(r.assignment)).toBe("cursor-agent:composer-2.5");
  });

  test("(e) marginal cost beats an under-cap api cell: sub wins", () => {
    const cfg = cfgOf();
    const channels: BillingChannel[] = [
      { adapter: "a", vendor: "v", model: "m1", channel: "sub", tier: "cheap" },
      { adapter: "b", vendor: "v", model: "m2", channel: "api", tier: "cheap" },
    ];
    const profile = buildProfile(badRows("chore", "b", "m2", 2));
    expect(channelKey(route(mkTask("chore"), cfg, channels, profile).assignment)).toBe("a:m1");
  });

  test("(f) tier beats an under-cap higher-tier cell: cheapest sufficient tier wins", () => {
    const cfg = cfgOf();
    const channels: BillingChannel[] = [
      { adapter: "a", vendor: "v", model: "m1", channel: "sub", tier: "cheap" },
      { adapter: "b", vendor: "v", model: "m2", channel: "sub", tier: "mid" },
    ];
    const profile = buildProfile(badRows("chore", "b", "m2", 2));
    expect(channelKey(route(mkTask("chore"), cfg, channels, profile).assignment)).toBe("a:m1");
  });

  test("(g) health: a cell for a channel not in the fleet is never chosen and route() doesn't throw", () => {
    const cfg = cfgOf();
    const channels: BillingChannel[] = [{ adapter: "a", vendor: "v", model: "m1", channel: "sub", tier: "cheap" }];
    const profile = buildProfile(badRows("chore", "ghost", "gmodel", 2));
    expect(channelKey(route(mkTask("chore"), cfg, channels, profile).assignment)).toBe("a:m1");
  });

  test("positive control: within a static tie the under-cap channel wins; below a floor it loses", () => {
    const cfg = cfgOf();
    const tied: BillingChannel[] = [
      { adapter: "a", vendor: "v", model: "m1", channel: "sub", tier: "cheap" },
      { adapter: "b", vendor: "v", model: "m2", channel: "sub", tier: "cheap" },
    ];
    const winProfile = buildProfile(badRows("chore", "b", "m2", 2)); // b is discovery-second, under-cap
    expect(channelKey(route(mkTask("chore"), cfg, tied, winProfile).assignment)).toBe("b:m2");

    const floored: BillingChannel[] = [
      { adapter: "a", vendor: "v", model: "m1", channel: "sub", tier: "frontier" },
      { adapter: "b", vendor: "v", model: "m2", channel: "sub", tier: "cheap" },
    ];
    const loseProfile = buildProfile(badRows("migration", "b", "m2", 2)); // b under-cap but below the frontier floor
    expect(channelKey(route(mkTask("migration"), cfg, floored, loseProfile).assignment)).toBe("a:m1");
  });
});

// ── 14-01-06: starved channel recovers (EXP-01 clean branch, pure loop) ──
describe("14-01-06 an under-cap channel is probed past a warm-good incumbent and recovers on merit", () => {
  test("probed each rebuild under cap; after cap the win is score-decided (bonus spent)", () => {
    const cfg = cfgOf();
    const channels = channelsOf(cfg);
    const shape = "chore";
    const Akey = "claude-code:haiku";   // warm-good AND the static discovery winner (Pitfall 2)
    const Bkey = "codex:gpt-5.6-luna";  // early bad luck: 2 gate-fails then it must be probed
    const aRows = warmRows(shape, "claude-code", "haiku", 6);
    const bRows: ProfileRow[] = [...badRows(shape, "codex", "gpt-5.6-luna", 2)];
    const build = () => buildProfile([...aRows, ...bRows]);
    const dispB = (p: RoutingProfile) => cellOf(p, shape, Bkey, "sub")!.dispatches;

    // first route: B probed DESPITE A's positive score, marked as a probe, deviation carries explore
    const r0 = route(mkTask(shape), cfg, channels, build());
    expect(channelKey(r0.assignment)).toBe(Bkey);
    expect(r0.provenance).toMatch(/via exploration probe \(dispatches=2 < 5\)/);
    expect(r0.deviation).toMatchObject({ static: Akey, chosen: Bkey, explore: true });

    // close the loop: each rebuild the probe succeeds; while under cap, B keeps being probed
    for (const expected of [2, 3, 4]) {
      const p = build();
      expect(dispB(p)).toBe(expected);
      expect(explorationBonus(cellOf(p, shape, Bkey, "sub"))).toBeGreaterThan(0);
      expect(channelKey(route(mkTask(shape), cfg, channels, p).assignment)).toBe(Bkey);
      bRows.push(doneRow(shape, "codex", "gpt-5.6-luna"));
    }

    // at cap: the bonus is exactly 0 — probing no longer decides
    const pCap = build();
    expect(dispB(pCap)).toBe(EXPLORE_CAP);
    expect(explorationBonus(cellOf(pCap, shape, Bkey, "sub"))).toBe(0);

    // recover on merit: feed clean rows until B's EARNED score beats A, then B wins by score alone
    while (learnedScore(build(), shape, Bkey, "sub") <= learnedScore(build(), shape, Akey, "sub")) {
      bRows.push(doneRow(shape, "codex", "gpt-5.6-luna"));
    }
    const pWin = build();
    expect(explorationBonus(cellOf(pWin, shape, Bkey, "sub"))).toBe(0); // win is not bonus-driven
    const rWin = route(mkTask(shape), cfg, channels, pWin);
    expect(channelKey(rWin.assignment)).toBe(Bkey);
    expect(rWin.provenance).toMatch(/via learned score/);
  });
});

// ── 14-01-07: self-limiting (EXP-01 bad branch, T-14-05) ──
describe("14-01-07 a channel that keeps failing decays to bonus 0 and probing stops", () => {
  test("bonus reaches exactly 0 at cap, the incumbent wins, and B is never re-probed", () => {
    const cfg = cfgOf();
    const channels = channelsOf(cfg);
    const shape = "chore";
    const Akey = "claude-code:haiku";
    const Bkey = "codex:gpt-5.6-luna";
    const aRows = warmRows(shape, "claude-code", "haiku", 6);
    const bRows: ProfileRow[] = [...badRows(shape, "codex", "gpt-5.6-luna", 2)];
    const build = () => buildProfile([...aRows, ...bRows]);
    const dispB = (p: RoutingProfile) => cellOf(p, shape, Bkey, "sub")!.dispatches;

    // while under cap B is probed — but every probe fails again
    for (const expected of [2, 3, 4]) {
      const p = build();
      expect(dispB(p)).toBe(expected);
      expect(channelKey(route(mkTask(shape), cfg, channels, p).assignment)).toBe(Bkey);
      bRows.push(badRow(shape, "codex", "gpt-5.6-luna"));
    }

    // at cap, all-bad: bonus 0, earned score negative ⇒ the warm-good incumbent wins, NOT a probe
    const pCap = build();
    expect(dispB(pCap)).toBe(EXPLORE_CAP);
    expect(explorationBonus(cellOf(pCap, shape, Bkey, "sub"))).toBe(0);
    expect(learnedScore(pCap, shape, Bkey, "sub")).toBeLessThan(0);
    const rCap = route(mkTask(shape), cfg, channels, pCap);
    expect(channelKey(rCap.assignment)).toBe(Akey);
    expect(rCap.provenance).not.toMatch(/exploration probe/);

    // further rebuilds keep the incumbent — exploration is not an infinite tax
    bRows.push(badRow(shape, "codex", "gpt-5.6-luna"));
    const rMore = route(mkTask(shape), cfg, channels, build());
    expect(channelKey(rMore.assignment)).toBe(Akey);
    expect(rMore.provenance).not.toMatch(/exploration probe/);
  });
});

// ── 14-01-08: provenance precedence (EXP-03 / T-14-04 / Pitfall 3) ──
describe("14-01-08 the probe marker fires only when the bonus key decided", () => {
  test("warm profile, all-zero bonuses ⇒ Phase-13 learned-score provenance and the exact 5-field deviation", () => {
    const cfg = cfgOf();
    const profile = buildProfile(warmRows("chore", "codex", "gpt-5.6-luna", 6)); // dispatches 6 ⇒ bonus 0
    const r = route(mkTask("chore"), cfg, channelsOf(cfg), profile);
    expect(channelKey(r.assignment)).toBe("codex:gpt-5.6-luna");
    expect(r.provenance).toMatch(/via learned score \d\.\d{3} \(n=\d+\) over \S+ \d\.\d{3}/);
    expect("explore" in (r.deviation as object)).toBe(false);
    expect(r.deviation).toEqual({
      static: "claude-code:haiku", chosen: "codex:gpt-5.6-luna",
      score: expect.any(Number), staticScore: expect.any(Number), n: expect.any(Number),
    });
  });

  test("a probe targeting the static winner itself still prints probe provenance with NO deviation", () => {
    const cfg = cfgOf();
    const profile = buildProfile(badRows("chore", "claude-code", "haiku", 2)); // haiku is discovery-first AND under-cap
    const r = route(mkTask("chore"), cfg, channelsOf(cfg), profile);
    expect(channelKey(r.assignment)).toBe("claude-code:haiku");
    expect(r.provenance).toMatch(/via exploration probe \(dispatches=2 < 5\)/);
    expect(r.deviation).toBeUndefined();
  });
});

// ── 14-01-11: cold gate (EXP-01 / ROUTE-09) ──
describe("14-01-11 an empty profile is inert — byte-identical to the no-profile call", () => {
  test("empty profile ⇒ assignment/provenance/deviation identical to the 3-arg call", () => {
    const cfg = cfgOf();
    const channels = channelsOf(cfg);
    const t = mkTask("chore");
    const withEmpty = route(t, cfg, channels, buildProfile([]));
    const without = route(t, cfg, channels);
    expect(withEmpty.assignment).toEqual(without.assignment);
    expect(withEmpty.provenance).toBe(without.provenance);
    expect(withEmpty.deviation).toBeUndefined();
    expect(without.deviation).toBeUndefined();
  });
});
