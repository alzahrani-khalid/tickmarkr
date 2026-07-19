import { describe, expect, test } from "vitest";
import { type BillingChannel, channelKey } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, type TickmarkrConfig, type Tier } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { ProfileCell, RoutingProfile } from "../../src/route/profile.js";
import { marginalCostRank, nextChannel } from "../../src/route/router.js";

// ROUTE-13 behavioral oracles for the FAILURE path. These are the successors of the retired ROUTE-10
// learning-blind grep-pin (learned.test.ts): learnedScore is the STRICTLY-LAST nextChannel sort key —
// it reorders only WITHIN an equal-(tier, marginalCostRank) band, never moves which band absorbs a
// failover, and an absent profile reproduces the v1.7 candidate order byte-identically.
// parity.test.ts is NEVER cited here — a symmetric routing inversion is invisible to a differential oracle.

const cfg: TickmarkrConfig = structuredClone(DEFAULT_CONFIG); // nextChannel ignores cfg; any config is fine

const mkTask = (shape: string) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"] }],
  }).tasks[0];

const cur = (tier: Tier): { adapter: string; model: string; channel: "sub"; tier: Tier } =>
  ({ adapter: "x", model: "x", channel: "sub", tier });

const cellKey = (shape: string, chKey: string, channel: string) => `${shape}|${chKey}|${channel}`;

// ── BAND-INVARIANCE MATRIX fixture ──
// A mixed fleet spanning {cheap, mid, frontier} × {sub, api}. W1 (plan-check): the {cheap-sub, cheap-api}
// and {mid-sub, mid-api} SAME-TIER pairs make the marginalCostRank band key non-vacuous under Drill B.
const FLEET: BillingChannel[] = [
  { adapter: "ca", vendor: "v", model: "cheap-sub", channel: "sub", tier: "cheap" },
  { adapter: "cb", vendor: "v", model: "cheap-api", channel: "api", tier: "cheap" },
  { adapter: "ma", vendor: "v", model: "mid-sub", channel: "sub", tier: "mid" },
  { adapter: "mb", vendor: "v", model: "mid-api", channel: "api", tier: "mid" },
  { adapter: "fa", vendor: "v", model: "front-sub", channel: "sub", tier: "frontier" },
  { adapter: "fb", vendor: "v", model: "front-api", channel: "api", tier: "frontier" },
];

// max achievable score (clean + fast, no throttle): quality (23/26−0.5)=+0.3846, perf +0.025 ⇒ ≈+0.4096
const HOSTILE_HI: ProfileCell = { n: 20, qSum: 20, dispatches: 20, doneCount: 20, quotaHits: 0, doneMedianMs: 1 };
// worst achievable score (all failed + fully throttled): quality (3/26−0.5)=−0.3846, avail −0.05 ⇒ ≈−0.4346
const HOSTILE_LO: ProfileCell = { n: 20, qSum: 0, dispatches: 20, doneCount: 0, quotaHits: 20 };

// A maximally-hostile warm profile: the highest-tier/highest-cost channel (front-api — a DIFFERENT tier
// AND cost class than every static sub winner) gets the best score; every sub (the static winners) the worst.
// If learnedScore leaked above the band keys, the pick would jump to front-api; the band keys forbid it.
const hostileProfile = (shapes: string[]): RoutingProfile => {
  const cells = new Map<string, ProfileCell>();
  for (const shape of shapes) {
    for (const c of FLEET) {
      cells.set(cellKey(shape, channelKey(c), c.channel), channelKey(c) === "fb:front-api" ? HOSTILE_HI : HOSTILE_LO);
    }
  }
  return { cells };
};

describe("ROUTE-13 oracle 1 — band-invariance matrix (a hostile profile never moves the tier/cost band)", () => {
  const shapes = ["implement", "chore"];
  const hostile = hostileProfile(shapes);
  // absolute expected band per current.tier (static winner is always the lowest-tier lowest-cost sub in pool)
  const rows: Array<{ tier: Tier; expTier: Tier; expCost: number }> = [
    { tier: "cheap", expTier: "cheap", expCost: 0 },     // pool: all 6 → cheap-sub
    { tier: "mid", expTier: "mid", expCost: 0 },         // pool: tier≥mid → mid-sub
    { tier: "frontier", expTier: "frontier", expCost: 0 }, // pool: tier≥frontier → front-sub
  ];

  for (const shape of shapes) {
    for (const r of rows) {
      test(`${shape} @ current=${r.tier}: chosen band is (${r.expTier}, cost ${r.expCost}) with AND without the hostile profile`, () => {
        const withP = nextChannel(cur(r.tier), mkTask(shape), cfg, FLEET, [], hostile)!;
        const without = nextChannel(cur(r.tier), mkTask(shape), cfg, FLEET, [])!;
        // absolute band literals (not only a differential equality)
        expect(withP.tier).toBe(r.expTier);
        expect(marginalCostRank(withP)).toBe(r.expCost);
        // and the band is byte-identical to the profile-free pick
        expect(withP.tier).toBe(without.tier);
        expect(marginalCostRank(withP)).toBe(marginalCostRank(without));
      });
    }
  }
});

// ── WITHIN-BAND fixture: two same-tier sub channels (equal tier AND equal marginalCostRank) ──
const A: BillingChannel = { adapter: "fake", vendor: "v", model: "aa", channel: "sub", tier: "mid" };
const B: BillingChannel = { adapter: "fake", vendor: "v", model: "bb", channel: "sub", tier: "mid" };
const PAIR = [A, B]; // discovery order: A first — without a score, A wins the tie
const WARM: ProfileCell = { n: 6, qSum: 6, dispatches: 6, doneCount: 0, quotaHits: 0 }; // quality (9/12−0.5)=+0.25
const warmOne = (shape: string, ch: BillingChannel): RoutingProfile =>
  ({ cells: new Map([[cellKey(shape, channelKey(ch), ch.channel), WARM]]) });

describe("ROUTE-13 oracle 2 — within-band value (higher learnedScore wins an equal-tier equal-cost tie)", () => {
  const shape = "implement";
  test("warm B ⇒ nextChannel picks fake:bb over the discovery-first fake:aa", () => {
    expect(channelKey(nextChannel(cur("mid"), mkTask(shape), cfg, PAIR, [], warmOne(shape, B))!)).toBe("fake:bb");
  });
  test("reflection — warm A ⇒ nextChannel picks fake:aa (kills a hardcoded-winner false green)", () => {
    expect(channelKey(nextChannel(cur("mid"), mkTask(shape), cfg, PAIR, [], warmOne(shape, A))!)).toBe("fake:aa");
  });
});

// Cold-parity fixture: s1/s2 are a SAME-(tier, cost) sub pair, so discovery order is load-bearing —
// a stability break (e.g. pool.reverse pre-sort, Drill D) swaps them and turns the oracle RED.
const CP: BillingChannel[] = [
  { adapter: "s1", vendor: "v", model: "cheap-sub-1", channel: "sub", tier: "cheap" },
  { adapter: "s2", vendor: "v", model: "cheap-sub-2", channel: "sub", tier: "cheap" }, // same band as s1
  { adapter: "cb", vendor: "v", model: "cheap-api", channel: "api", tier: "cheap" },
  { adapter: "ma", vendor: "v", model: "mid-sub", channel: "sub", tier: "mid" },
  { adapter: "mb", vendor: "v", model: "mid-api", channel: "api", tier: "mid" },
  { adapter: "fa", vendor: "v", model: "front-sub", channel: "sub", tier: "frontier" },
];

describe("ROUTE-13 oracle 3 — cold-parity of the FULL candidate order (absent profile ⇒ byte-identical v1.7)", () => {
  // Reconstruct the entire failover sequence by looping nextChannel, pushing each pick into `tried`.
  const seq = (call: (tried: string[]) => ReturnType<typeof nextChannel>, tried0: string[]): string[] => {
    const tried = [...tried0];
    const out: string[] = [];
    for (let pick = call(tried); pick; pick = call(tried)) {
      out.push(channelKey(pick));
      tried.push(channelKey(pick));
    }
    return out;
  };
  const task = mkTask("implement");
  // Hardcoded v1.7 order — derived BY HAND from CP via (tier asc, marginalCostRank asc, discovery order), never computed.
  const scenarios: Array<{ name: string; tier: Tier; tried0: string[]; expected: string[] }> = [
    {
      name: "escalation: current cheap, climb from bottom (exercises the s1/s2 same-band tie)",
      tier: "cheap", tried0: [],
      expected: ["s1:cheap-sub-1", "s2:cheap-sub-2", "cb:cheap-api", "ma:mid-sub", "mb:mid-api", "fa:front-sub"],
    },
    {
      name: "quota-failover: current mid, 2 already tried",
      tier: "mid", tried0: ["ma:mid-sub", "mb:mid-api"],
      expected: ["fa:front-sub"],
    },
    {
      name: "consult-reroute: current cheap, 1 already tried",
      tier: "cheap", tried0: ["s1:cheap-sub-1"],
      expected: ["s2:cheap-sub-2", "cb:cheap-api", "ma:mid-sub", "mb:mid-api", "fa:front-sub"],
    },
  ];
  for (const s of scenarios) {
    test(`${s.name} — full order equals the hardcoded v1.7 sequence (5-arg AND 6-arg-undefined)`, () => {
      const fiveArg = seq((tried) => nextChannel(cur(s.tier), task, cfg, CP, tried), s.tried0);
      const sixArgUndef = seq((tried) => nextChannel(cur(s.tier), task, cfg, CP, tried, undefined), s.tried0);
      expect(fiveArg).toEqual(s.expected);
      expect(sixArgUndef).toEqual(s.expected);
    });
  }
});

describe("ROUTE-13 oracle 4 — no exploration bonus on the failure path (score-only within a band)", () => {
  // Candidate A is UNDER EXPLORE_CAP (dispatches 1 < 5): route()'s exploration bonus would be 1−1/5 = 0.8,
  // but its learnedScore is exactly NEUTRAL 0 (n<MIN gates quality, dispatches<MIN gates avail). Candidate B
  // is warm (dispatches ≥ EXPLORE_CAP ⇒ bonus 0) with a POSITIVE score. Under route()'s bonus-above-score
  // key, A (0.8) would win; nextChannel is score-only, so B wins. That flip is the discriminator.
  const shape = "implement";
  const UNDER_CAP: ProfileCell = { n: 0, qSum: 0, dispatches: 1, doneCount: 0, quotaHits: 0 }; // score 0, bonus 0.8
  const profile: RoutingProfile = {
    cells: new Map([
      [cellKey(shape, "fake:aa", "sub"), UNDER_CAP],
      [cellKey(shape, "fake:bb", "sub"), WARM], // score +0.25, bonus 0
    ]),
  };
  test("nextChannel picks the warm B, never the under-cap A a route() probe would prefer", () => {
    expect(channelKey(nextChannel(cur("mid"), mkTask(shape), cfg, PAIR, [], profile)!)).toBe("fake:bb");
  });
});
