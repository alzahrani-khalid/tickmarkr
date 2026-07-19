import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  buildProfile, cellOf, classify, learnedScore, learnedScoreTerms,
  NEUTRAL, MIN_SAMPLES, PRIOR_K, PERF_WEIGHT, REF_MS, EXPLORE_CAP, AVAIL_WEIGHT,
  decayWeight, explorationBonus,
  type ProfileRow, type RoutingProfile,
} from "../../src/route/profile.js";
import { channelKey, channelsFromConfig } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { SHAPES } from "../../src/graph/schema.js";
import { PARK_KINDS, readAllTelemetry } from "../../src/run/journal.js";

// house pattern (matrix.test.ts:11-13) — derive channels, never hand-code them
const ADAPTERS = ["claude-code", "codex", "cursor-agent", "opencode"];
const CHANNELS = ADAPTERS.flatMap((id) => channelsFromConfig(id, DEFAULT_CONFIG));

// one row builder: v1.5 clean-done by default (gateFails undefined, attempts 1 ⇒ classify 1)
const mkRow = (o: Partial<ProfileRow> = {}): ProfileRow => ({
  shape: "implement", adapter: "claude-code", model: "sonnet", channel: "sub",
  attempts: 1, outcome: "done", durationMs: 1000, ...o,
});
const keyOf = (r: ProfileRow) => `${r.shape}|${channelKey(r)}|${r.channel}`;
const cell = (p: RoutingProfile, r: ProfileRow) => p.cells.get(keyOf(r));

const FAIL_PARKS = ["ladder-exhausted", "attempt-cap", "gate-fail"];

// ── inline seeded PRNG (fast-check MUST NOT be installed; RNG stays test-only) ──
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe("12-02-01 policy table (classify)", () => {
  const cases: [string, ProfileRow, 1 | 0.5 | 0 | null][] = [
    ["clean done v1.6 (gateFails 0, consults 0)", mkRow({ outcome: "done", gateFails: 0, consults: 0 }), 1],
    ["degraded done via gateFails>0", mkRow({ outcome: "done", gateFails: 2, consults: 0 }), 0.5],
    ["degraded done via consults>0", mkRow({ outcome: "done", gateFails: 0, consults: 1 }), 0.5],
    ["v1.5 done attempts=1 (no gateFails)", mkRow({ outcome: "done", attempts: 1 }), 1],
    ["v1.5 done attempts=3 (quota-vs-retry ambiguous)", mkRow({ outcome: "done", attempts: 3 }), null],
    ["v1.5 human no parkKind (absent ≠ gate-fail)", mkRow({ outcome: "human", parkKind: undefined }), null],
    ["failed exception row", mkRow({ outcome: "failed", adapter: "-", model: "-" }), null],
  ];
  test.each(cases)("%s → %s", (_n, row, expected) => {
    expect(classify(row)).toBe(expected);
  });

  test.each(PARK_KINDS)("human parkKind %s", (pk) => {
    const expected = FAIL_PARKS.includes(pk) ? 0 : null;
    expect(classify(mkRow({ outcome: "human", parkKind: pk }))).toBe(expected);
  });

  test("excluded quota row still bumps dispatches, not n", () => {
    const r = mkRow({ outcome: "human", parkKind: "quota" });
    const c = cell(buildProfile([r]), r);
    expect(c?.dispatches).toBe(1);
    expect(c?.n).toBe(0);
  });

  test("channel '-' (adapter '-') row is structurally excluded — bumps nothing", () => {
    const p = buildProfile([mkRow({ adapter: "-", model: "-", outcome: "failed" })]);
    expect(p.cells.size).toBe(0);
  });
});

describe("12-01-01 buildProfile cells", () => {
  test("correct key, n, qSum, dispatches, doneCount, odd median", () => {
    const rows = [10, 20, 30].map((d) => mkRow({ outcome: "done", gateFails: 0, consults: 0, durationMs: d }));
    const p = buildProfile(rows);
    const c = cell(p, rows[0])!;
    expect(p.cells.has("implement|claude-code:sonnet|sub")).toBe(true);
    expect(c.n).toBe(3);
    expect(c.qSum).toBe(3);
    expect(c.dispatches).toBe(3);
    expect(c.doneCount).toBe(3);
    expect(c.doneMedianMs).toBe(20);
  });

  test("even median averages the two midpoints", () => {
    const rows = [10, 20, 30, 40].map((d) => mkRow({ outcome: "done", gateFails: 0, consults: 0, durationMs: d }));
    expect(cell(buildProfile(rows), rows[0])!.doneMedianMs).toBe(25);
  });

  test("garbage/negative/Infinity durations classify but contribute no duration", () => {
    const rows = [
      mkRow({ outcome: "done", gateFails: 0, consults: 0, durationMs: -1 }),
      mkRow({ outcome: "done", gateFails: 0, consults: 0, durationMs: NaN }),
      mkRow({ outcome: "done", gateFails: 0, consults: 0, durationMs: Infinity }),
    ];
    const c = cell(buildProfile(rows), rows[0])!;
    expect(c.n).toBe(3);
    expect(c.doneCount).toBe(0);
    expect(c.doneMedianMs).toBeUndefined();
  });
});

describe("12-01-02 purity grep", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/route/profile.ts", import.meta.url)), "utf8");
  test("no node:fs, no clock, no RNG, no run/ import", () => {
    expect(src).not.toMatch(/node:fs/);
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/from ["']\.\.\/run\//);
    expect(src).not.toMatch(/from ["']\.\.\/\.\.\/src\/run\//);
  });
});

describe("12-01-03 seam integration (readAllTelemetry → buildProfile)", () => {
  test("real reader output satisfies ProfileRow; garbage degrades to dropped rows", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-prof-"));
    const runDir = join(repo, ".tickmarkr", "runs", "run-20260101-000000");
    mkdirSync(runDir, { recursive: true });
    const good = (o: Record<string, unknown>) => JSON.stringify({
      taskId: "T1", shape: "implement", adapter: "claude-code", model: "sonnet", channel: "sub",
      attempts: 1, outcome: "done", durationMs: 1000, gateFails: 0, consults: 0, ...o,
    });
    const lines = [
      good({}),
      good({ durationMs: 2000 }),
      '{"taskId":"bad"',            // torn trailing-style line — dropped by readJsonl
      '{"not":"a valid row"}',      // fails safeParse — dropped
    ];
    writeFileSync(join(runDir, "telemetry.jsonl"), lines.join("\n") + "\n");
    const rows = readAllTelemetry(repo, 50);
    expect(rows.length).toBe(2);
    const p = buildProfile(rows);
    expect(p.cells.get("implement|claude-code:sonnet|sub")?.n).toBe(2);
  });
});

// ── totality fixtures ──
const failRows = (n: number) => Array.from({ length: n }, () => mkRow({ outcome: "human", parkKind: "gate-fail" }));
const cleanRows = (n: number, dur = 1000) => Array.from({ length: n }, () => mkRow({ outcome: "done", gateFails: 0, consults: 0, durationMs: dur }));
const garbageRows = () => [
  mkRow({ outcome: "failed", adapter: "-", model: "-", durationMs: NaN }),
  mkRow({ outcome: "human", parkKind: "quota", durationMs: -Infinity }),
  mkRow({ outcome: "done", gateFails: 0, consults: 0, durationMs: Infinity }),
  mkRow({ shape: "a|b", model: "x:y:z", durationMs: -5 }),
];

describe("12-03-01 totality — adversarial matrix", () => {
  const profiles: [string, RoutingProfile | undefined][] = [
    ["undefined", undefined],
    ["empty", buildProfile([])],
    ["single-row", buildProfile([mkRow()])],
    ["all-fail n=6", buildProfile(failRows(6))],
    ["all-clean n=6", buildProfile(cleanRows(6))],
    ["n=4 boundary", buildProfile(cleanRows(4))],
    ["n=5 boundary", buildProfile(cleanRows(5))],
    ["zero-duration", buildProfile(cleanRows(5, 0))],
    ["identical-durations", buildProfile(cleanRows(5, 12345))],
    ["garbage-built", buildProfile(garbageRows())],
  ];
  const shapes = [...SHAPES, "", "unknown", "a|b"];
  const keys = ["claude-code:fable", "", "x:y:z", "no-colon", " "];
  for (const [pn, p] of profiles) {
    test(`${pn}: finite for every shape × key`, () => {
      for (const s of shapes) for (const k of keys) {
        expect(Number.isFinite(learnedScore(p, s, k, "sub"))).toBe(true);
      }
    });
  }
});

describe("12-03-02 totality — seeded fuzz", () => {
  const OUTCOMES = ["done", "failed", "human"] as const;
  const DURS = [0, -1, 1000, 5_000, NaN, Infinity, -Infinity, 999_999_999, 1];
  const rng = mulberry32(0xc0ffee);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];
  const maybe = <T>(v: T): T | undefined => (rng() < 0.5 ? v : undefined);
  const randRow = (): ProfileRow => ({
    shape: pick([...SHAPES, "", "weird|shape"]),
    adapter: pick(["claude-code", "codex", "-", "opencode"]),
    model: pick(["sonnet", "fable", "x:y", "glm"]),
    channel: pick(["sub", "api"]) as "sub" | "api",
    attempts: Math.floor(rng() * 5),
    outcome: pick(OUTCOMES),
    durationMs: pick(DURS),
    firstAttemptOk: maybe(rng() < 0.5),
    gateFails: maybe(Math.floor(rng() * 3)),
    consults: maybe(Math.floor(rng() * 3)),
    parkKind: maybe(pick(PARK_KINDS)),
  });
  const probeKeys = ["claude-code:sonnet", "codex:x:y", "", "no-colon", "-:-"];

  test("~1000 random arrays: every score finite", () => {
    for (let i = 0; i < 1000; i++) {
      const rows = Array.from({ length: Math.floor(rng() * 12) }, randRow);
      const p = buildProfile(rows);
      for (const s of [...SHAPES, "", pick(["a|b", "weird|shape"])]) for (const k of probeKeys) {
        expect(Number.isFinite(learnedScore(p, s, k, "sub"))).toBe(true);
      }
    }
  });
});

describe("12-05-01 determinism — order-insensitive aggregation", () => {
  const rng = mulberry32(0x1234);
  const OUTCOMES = ["done", "failed", "human"] as const;
  const DURS = [0, -1, 1000, 5_000, 42, 999];
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];
  const maybe = <T>(v: T): T | undefined => (rng() < 0.5 ? v : undefined);
  const randRow = (): ProfileRow => ({
    shape: pick([...SHAPES]), adapter: pick(["claude-code", "codex", "opencode"]),
    model: pick(["sonnet", "fable"]), channel: "sub", attempts: Math.floor(rng() * 4),
    outcome: pick(OUTCOMES), durationMs: pick(DURS),
    gateFails: maybe(Math.floor(rng() * 3)), consults: maybe(Math.floor(rng() * 2)),
    parkKind: maybe(pick(PARK_KINDS)),
  });

  test("buildProfile(rows) deep-equals buildProfile(shuffle(rows))", () => {
    for (let i = 0; i < 50; i++) {
      const rows = Array.from({ length: 30 }, randRow);
      expect(buildProfile(rows)).toEqual(buildProfile(seededShuffle(rows, rng)));
    }
  });

  test("repeated learnedScore on same input is ===-identical", () => {
    const p = buildProfile(cleanRows(8));
    const a = learnedScore(p, "implement", "claude-code:sonnet", "sub");
    expect(learnedScore(p, "implement", "claude-code:sonnet", "sub")).toBe(a);
  });

  test("learnedScoreTerms sums exactly to learnedScore", () => {
    const p = buildProfile(cleanRows(8));
    const t = learnedScoreTerms(p, "implement", "claude-code:sonnet", "sub");
    expect(t.quality + t.perf + t.avail + t.overrun).toBe(learnedScore(p, "implement", "claude-code:sonnet", "sub"));
    expect(learnedScoreTerms(undefined, "implement", "claude-code:sonnet", "sub")).toEqual(
      { quality: NEUTRAL, perf: NEUTRAL, avail: NEUTRAL, overrun: NEUTRAL },
    );
  });
});

describe("12-04-01 neutrality — n < MIN_SAMPLES scores exactly 0", () => {
  test("2-of-3 failure cell → toBe(0), never toBeCloseTo (ROUTE-07 tie parity)", () => {
    const rows = [
      mkRow({ outcome: "human", parkKind: "gate-fail" }),
      mkRow({ outcome: "human", parkKind: "gate-fail" }),
      mkRow({ outcome: "done", gateFails: 0, consults: 0 }),
    ];
    const p = buildProfile(rows);
    expect(learnedScore(p, "implement", "claude-code:sonnet", "sub")).toBe(0);
  });
  test("NEUTRAL constant is 0", () => expect(NEUTRAL).toBe(0));
});

describe("12-04-02 shrinkage above the gate", () => {
  test("n=4 → toBe(0) (below MIN_SAMPLES)", () => {
    expect(learnedScore(buildProfile(cleanRows(4)), "implement", "claude-code:sonnet", "sub")).toBe(0);
  });
  test("n=5 all-fail → exactly (0+PRIOR_K)/(5+2·PRIOR_K)−0.5, negative, > −0.5", () => {
    const p = buildProfile(failRows(5)); // human gate-fail: no done rows ⇒ perf term 0
    const s = learnedScore(p, "implement", "claude-code:sonnet", "sub");
    expect(s).toBe((0 + PRIOR_K) / (5 + 2 * PRIOR_K) - 0.5);
    expect(s).toBeLessThan(0);
    expect(s).toBeGreaterThan(-0.5);
  });
  test("perf contribution bounded by PERF_WEIGHT/2", () => {
    const p = buildProfile(cleanRows(6, 3000));
    const s = learnedScore(p, "implement", "claude-code:sonnet", "sub");
    const quality = (6 + PRIOR_K) / (6 + 2 * PRIOR_K) - 0.5;
    expect(Math.abs(s - quality)).toBeLessThanOrEqual(PERF_WEIGHT / 2);
  });
});

describe("12-04-03 empty/undefined profile ≡ static (toBe(0) across matrix)", () => {
  const empty = buildProfile([]);
  test.each(SHAPES)("shape %s → 0 for every default channel", (shape) => {
    for (const c of CHANNELS) {
      expect(learnedScore(empty, shape, channelKey(c), c.channel)).toBe(0);
      expect(learnedScore(undefined, shape, channelKey(c), c.channel)).toBe(0);
    }
  });
  test("constants exported (A1 tuning knobs)", () => {
    expect(MIN_SAMPLES).toBe(5);
    expect(PRIOR_K).toBe(3);
    expect(PERF_WEIGHT).toBe(0.05);
    expect(REF_MS).toBe(600_000);
    expect(AVAIL_WEIGHT).toBe(0.05); // ROUTE-12 penalty weight (sub-quantum: ≤ PERF_WEIGHT)
  });
});

describe("cellOf — Phase 13 provenance hook", () => {
  test("keyed lookup returns the cell; undefined profile → undefined", () => {
    const r = mkRow({ outcome: "done", gateFails: 0, consults: 0 });
    expect(cellOf(buildProfile([r]), r.shape, channelKey(r), r.channel)?.n).toBe(1);
    expect(cellOf(undefined, "implement", "claude-code:sonnet", "sub")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 25 — evidence decay (ROUTE-11, ROUTE-11a). Rank-weighted dyadic decay:
//   w = 2 ** -min(floor(age / HALF_LIFE_RUNS), DECAY_CAP)
//   age = run-recency rank over the DISTINCT runIds present (newest = 0);
//   runId undefined ⇒ age = numDistinct (strictly oldest, least influence).
// Applied ONLY at c.n / c.qSum. dispatches / doneMedianMs UNDECAYED.
// ═══════════════════════════════════════════════════════════════════════════

// 8 distinct chronological ids + undefined. string sort of run-YYYYMMDD-HHMMSS
// IS chronological — never parsed. numDistinct=8 ⇒ ages 7..0 for the defined ids,
// age=8 for undefined ⇒ weights {0.5 for ages 5-8, 1 for ages 0-4} — a genuine
// mix of dyadic weights so the concentrated corpus below folds thick cells.
const RUN_POOL: (string | undefined)[] = [
  undefined,
  "run-20260101-000000", "run-20260201-000000", "run-20260301-000000",
  "run-20260401-000000", "run-20260501-000000", "run-20260601-000000",
  "run-20260701-000000", "run-20260801-000000",
];

// concentrated corpus: a HANDFUL of cells (4), each receiving many rows across
// EVERY distinct runId + undefined, mixed clean (q=1) / degraded (q=0.5) so the
// per-cell qSum fold genuinely differs under non-dyadic weights. This thickness
// is what makes the rank-preserving 0.9**rank drill (1b) red — a thin
// <1-row-per-cell corpus would let a rank-preserving non-dyadic fold stay green.
const DECAY_CELLS: [string, string][] = [
  ["implement", "sonnet"], ["implement", "fable"],
  ["chore", "sonnet"], ["tests", "fable"],
];
const concentratedCorpus = (): ProfileRow[] => {
  const rows: ProfileRow[] = [];
  for (const [shape, model] of DECAY_CELLS) {
    RUN_POOL.forEach((runId, i) => {
      // clean (q=1) + degraded (q=0.5) row per runId per cell ⇒ mixed-q fold
      rows.push(mkRow({ shape, model, runId, outcome: "done", gateFails: 0, consults: 0, durationMs: 1000 + i * 7 }));
      rows.push(mkRow({ shape, model, runId, outcome: "done", gateFails: 2, consults: 0, durationMs: 1500 + i * 7 }));
    });
  }
  return rows; // 4 cells × 9 runId-groups × 2 = 72 rows, ≥2 distinct-runId rows/cell with mixed q
};

// drill 2026-07-10 (1a): weight = 0.9**rawIndex (row's array position, not rank) → 25-01 RED
//   (non-dyadic + order-dependent index ⇒ shuffle changes every cell's fold; N toEqual mismatches).
// drill 2026-07-10 (1b): weight = 0.9**ageOf(runId) (SAME rank order, dyadic base lost) → 25-01 RED
//   (0.9^k weights are inexact ⇒ Σ q·w reorders to a different ULP across shuffles; the concentrated
//   72-row corpus folds ≥2 distinct-runId rows/cell so the non-associative sum diverges). Both RED
//   confirms shuffle-invariance is load-bearing on the DYADIC weight, not merely on rank stability.
describe("25-01 decayed shuffle-invariance (bit-identical fold under any row order)", () => {
  const rng = mulberry32(0x25_01);
  const probeKey = "claude-code:sonnet";
  test("buildProfile(rows) toEqual buildProfile(shuffle(rows)) AND Object.is scores, ≥50 shuffles", () => {
    const rows = concentratedCorpus();
    const base = buildProfile(rows);
    for (let i = 0; i < 50; i++) {
      const shuffled = buildProfile(seededShuffle(rows, rng));
      expect(base).toEqual(shuffled);
      expect(Object.is(
        learnedScore(base, "implement", probeKey, "sub"),
        learnedScore(shuffled, "implement", probeKey, "sub"),
      )).toBe(true);
    }
  });
});

// drill 2026-07-10 (4): apply decayWeight to the dispatches increment (c.dispatches += w) → 25-04 RED
//   (weighted dispatches 5×0.5=2.5 < EXPLORE_CAP ⇒ explorationBonus > 0, reopening a spent budget).
describe("25-04 dispatches undecayed (EXP-04 preserved)", () => {
  test("EXPLORE_CAP quota-park rows on the OLDEST run ⇒ dispatches integer, explorationBonus exactly 0", () => {
    // park cell (codex:gpt-5.6-luna) — all rows on the oldest runId
    const parkRuns = "run-20260101-000000";
    const parkRows = Array.from({ length: EXPLORE_CAP }, () =>
      mkRow({ shape: "chore", adapter: "codex", model: "gpt-5.6-luna", runId: parkRuns,
        outcome: "human", parkKind: "quota", durationMs: 1000 }));
    // 5 NEWER distinct runIds via a different cell ⇒ numDistinct=6, park run at age 5 (weight 0.5)
    const newer = ["run-20260201-000000", "run-20260301-000000", "run-20260401-000000",
      "run-20260501-000000", "run-20260601-000000"];
    const filler = newer.map((runId) =>
      mkRow({ shape: "chore", adapter: "claude-code", model: "sonnet", runId,
        outcome: "done", gateFails: 0, consults: 0, durationMs: 1000 }));
    const p = buildProfile([...parkRows, ...filler]);
    const c = cellOf(p, "chore", "codex:gpt-5.6-luna", "sub")!;
    expect(c.dispatches).toBe(EXPLORE_CAP);          // integer, undecayed
    expect(c.n).toBe(0);                             // quota parks classify null ⇒ no quality obs
    expect(Object.is(explorationBonus(c), 0)).toBe(true);
  });
});

// drill 2026-07-10 (4-inf): decayWeight default halfLife → 1 (aggressive) → 25-02 integer-n leg RED.
describe("25-02 HALF_LIFE=Infinity ⇒ v1.7 byte-identity", () => {
  test("(a) decayWeight(age, Infinity) === 1 for every age", () => {
    for (const age of [0, 1, 5, 30, 1000]) expect(decayWeight(age, Infinity)).toBe(1);
  });

  test("(b) ≤4 distinct runIds (all ages < HALF_LIFE_RUNS ⇒ weight 1) ⇒ INTEGER n + exact v1.7 score", () => {
    const runs4 = ["run-20260101-000000", "run-20260201-000000", "run-20260301-000000", "run-20260401-000000"];
    const rows = Array.from({ length: 6 }, (_, i) =>
      mkRow({ shape: "implement", model: "sonnet", runId: runs4[i % 4],
        outcome: "done", gateFails: 0, consults: 0, durationMs: 3000 }));
    const c = cell(buildProfile(rows), rows[0])!;
    expect(c.n).toBe(6);          // integer — every weight 1
    expect(c.qSum).toBe(6);
    expect(c.doneMedianMs).toBe(3000);
    const s = learnedScore(buildProfile(rows), "implement", "claude-code:sonnet", "sub");
    const quality = (6 + PRIOR_K) / (6 + 2 * PRIOR_K) - 0.5;
    const perf = PERF_WEIGHT * (REF_MS / (REF_MS + 3000) - 0.5);
    expect(s).toBe(quality + perf);
  });

  test("(c) no-runId corpus (existing fixture style) ⇒ integer n — the numDistinct=0 degeneracy pin", () => {
    const c = cell(buildProfile(cleanRows(6)), mkRow())!;
    expect(c.n).toBe(6);
    expect(c.qSum).toBe(6);
  });
});

// drill 2026-07-10 (3): ageOf parses runId digits instead of sort rank → 25-05c opaque-rename RED.
describe("25-03 runId-undefined = oldest rank (ROUTE-11a pin)", () => {
  test("5 distinct-runId rows (weight 1) + 1 undefined (age=5 ⇒ weight 0.5) ⇒ n=5.5, qSum=5.5, nRaw=6", () => {
    // newest-policy would give the undefined row weight 1 ⇒ n === 6; that is what this pin rejects —
    // 5.5 ≠ 6 discriminates oldest-vs-newest undefined policy. HALF_LIFE_RUNS=5 makes the undefined
    // row (age = numDistinct = 5) the ONLY decayed row; the 5 defined ranks (ages 0..4) all weight 1.
    const runs5 = ["run-20260101-000000", "run-20260201-000000", "run-20260301-000000",
      "run-20260401-000000", "run-20260501-000000"];
    // durationMs NaN ⇒ no done duration ⇒ perf term 0 ⇒ closed-form one-liner
    const defined = runs5.map((runId) =>
      mkRow({ shape: "implement", model: "sonnet", runId, outcome: "done", gateFails: 0, consults: 0, durationMs: NaN }));
    const undef = mkRow({ shape: "implement", model: "sonnet", runId: undefined, outcome: "done", gateFails: 0, consults: 0, durationMs: NaN });
    const c = cell(buildProfile([...defined, undef]), defined[0])!;
    expect(c.n).toBe(5.5);
    expect(c.qSum).toBe(5.5);
    expect(c.nRaw).toBe(6);
    const s = learnedScore(buildProfile([...defined, undef]), "implement", "claude-code:sonnet", "sub");
    expect(s).toBe((5.5 + PRIOR_K) / (5.5 + 2 * PRIOR_K) - 0.5);
  });
});

describe("25-05 decayed-thin neutrality + totality", () => {
  const fillerOn = (runIds: string[]): ProfileRow[] =>
    runIds.map((runId) => mkRow({ shape: "chore", model: "fable", runId, outcome: "done", gateFails: 0, consults: 0, durationMs: NaN }));

  test("(a) 6 clean rows on the OLDEST of 6 distinct runs ⇒ n_eff=3 < MIN_SAMPLES ⇒ score === NEUTRAL", () => {
    const oldest = "run-20260101-000000";
    const filler = fillerOn(["run-20260201-000000", "run-20260301-000000", "run-20260401-000000",
      "run-20260501-000000", "run-20260601-000000"]); // 5 newer ⇒ numDistinct 6, oldest age 5 ⇒ weight 0.5
    const clean = Array.from({ length: 6 }, () =>
      mkRow({ shape: "implement", model: "sonnet", runId: oldest, outcome: "done", gateFails: 0, consults: 0, durationMs: NaN }));
    const c = cell(buildProfile([...clean, ...filler]), clean[0])!;
    expect(c.n).toBe(3);            // 6 × 0.5
    expect(learnedScore(buildProfile([...clean, ...filler]), "implement", "claude-code:sonnet", "sub")).toBe(NEUTRAL);
  });

  test("(a-counter) identical 6 rows on the NEWEST run ⇒ weight 1 ⇒ n=6 ⇒ score !== NEUTRAL (decay, not corpus, gated (a))", () => {
    const newest = "run-20260601-000000";
    const filler = fillerOn(["run-20260101-000000", "run-20260201-000000", "run-20260301-000000",
      "run-20260401-000000", "run-20260501-000000"]); // newest reserved for the clean cell ⇒ age 0
    const clean = Array.from({ length: 6 }, () =>
      mkRow({ shape: "implement", model: "sonnet", runId: newest, outcome: "done", gateFails: 0, consults: 0, durationMs: NaN }));
    const c = cell(buildProfile([...clean, ...filler]), clean[0])!;
    expect(c.n).toBe(6);
    expect(learnedScore(buildProfile([...clean, ...filler]), "implement", "claude-code:sonnet", "sub")).not.toBe(NEUTRAL);
  });

  test("(b) fuzz — randRow gains arbitrary runId; every score finite over ~1000 arrays", () => {
    const rng = mulberry32(0xdecaf7);
    const OUTCOMES = ["done", "failed", "human"] as const;
    const DURS = [0, -1, 1000, 5_000, NaN, Infinity, -Infinity, 999_999_999, 1];
    const RUNS = [undefined, "", "run-", "😀", "zzz", "run-20260101-000000", "run-20261231-235959"];
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];
    const maybe = <T>(v: T): T | undefined => (rng() < 0.5 ? v : undefined);
    const randRow = (): ProfileRow => ({
      shape: pick([...SHAPES, "", "weird|shape"]),
      adapter: pick(["claude-code", "codex", "-", "opencode"]),
      model: pick(["sonnet", "fable", "x:y", "glm"]),
      channel: pick(["sub", "api"]) as "sub" | "api",
      attempts: Math.floor(rng() * 5), outcome: pick(OUTCOMES), durationMs: pick(DURS),
      gateFails: maybe(Math.floor(rng() * 3)), consults: maybe(Math.floor(rng() * 3)),
      parkKind: maybe(pick(PARK_KINDS)), runId: pick(RUNS),
      quotaFailover: rng() < 0.3 ? (true as const) : undefined, // ROUTE-12: quota garbage in the fuzz
    });
    const probeKeys = ["claude-code:sonnet", "codex:x:y", "", "no-colon"];
    for (let i = 0; i < 1000; i++) {
      const p = buildProfile(Array.from({ length: Math.floor(rng() * 12) }, randRow));
      for (const s of [...SHAPES, ""]) for (const k of probeKeys) {
        expect(Number.isFinite(learnedScore(p, s, k, "sub"))).toBe(true);
      }
    }
  });

  test("(c) never-parsed: sort-order-preserving opaque rename ⇒ toEqual profiles, Object.is scores", () => {
    // date-shaped runId confers NOTHING beyond its sort position: a bijection preserving sort order
    // (run-20260101→aaa, run-20260301→bbb, run-20260601→ccc) must produce an identical profile.
    const dated = ["run-20260101-000000", "run-20260301-000000", "run-20260601-000000"];
    const opaque = ["aaa", "bbb", "ccc"];
    const build = (ids: string[]) => buildProfile(
      DECAY_CELLS.flatMap(([shape, model]) =>
        ids.flatMap((runId, i) => [
          mkRow({ shape, model, runId, outcome: "done", gateFails: 0, consults: 0, durationMs: 1000 + i }),
          mkRow({ shape, model, runId, outcome: "done", gateFails: 1, consults: 0, durationMs: 2000 + i }),
        ])));
    const pDated = build(dated), pOpaque = build(opaque);
    expect(pDated).toEqual(pOpaque);
    expect(Object.is(
      learnedScore(pDated, "implement", "claude-code:sonnet", "sub"),
      learnedScore(pOpaque, "implement", "claude-code:sonnet", "sub"),
    )).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 26 — scored utilization axis (ROUTE-12). A new UNDECAYED ProfileCell.quotaHits
// counter (fed by quotaFailover fact rows AND parkKind:"quota" parks) drives a bounded
// PENALTY-ONLY availability term: avail = dispatches<MIN ? 0 : -AVAIL_WEIGHT*(quotaHits/dispatches).
// Quota NEVER enters n/qSum — classify() is unchanged. A quotaHits=0 cell scores byte-identically
// to pre-ROUTE-12 (penalty-only), so ZERO existing pins move.
// ═══════════════════════════════════════════════════════════════════════════

// quota-source helpers: two independent sources that both bump quotaHits.
const quotaFactRow = (o: Partial<ProfileRow> = {}): ProfileRow =>
  mkRow({ outcome: "failed", durationMs: 0, quotaFailover: true, ...o }); // fact row (daemon TEL-05)
const quotaParkRow = (o: Partial<ProfileRow> = {}): ProfileRow =>
  mkRow({ outcome: "human", parkKind: "quota", durationMs: 0, ...o }); // parked FROM quota

// null-classified DONE rows (v1.5: attempts>1, gateFails undefined ⇒ classify null) still bump
// dispatches + doneCount + doneMedianMs but NOT n ⇒ the `n<MIN ⇏ doneCount<MIN` lemma (rev #2).
const nullDoneRows = (n: number, o: Partial<ProfileRow> = {}): ProfileRow[] =>
  Array.from({ length: n }, () => mkRow({ outcome: "done", attempts: 2, durationMs: 1000, ...o }));

// drill 2026-07-10 (4): source quotaHits with `+` instead of `||` (a both-marked row counts twice)
//   ⇒ 26-01(d) RED (quotaHits 2, not 1). The `||` once-only guard is load-bearing.
describe("26-01 quotaHits sourcing (both sources, once-only)", () => {
  test("(a) quotaFailover fact row ⇒ dispatches:1, quotaHits:1, n:0, nRaw:0", () => {
    const r = quotaFactRow();
    const c = cell(buildProfile([r]), r)!;
    expect(c.dispatches).toBe(1);
    expect(c.quotaHits).toBe(1);
    expect(c.n).toBe(0);
    expect(c.nRaw).toBe(0);
  });
  test("(b) parkKind:'quota' park row ⇒ dispatches:1, quotaHits:1, n:0, nRaw:0", () => {
    const r = quotaParkRow();
    const c = cell(buildProfile([r]), r)!;
    expect(c.dispatches).toBe(1);
    expect(c.quotaHits).toBe(1);
    expect(c.n).toBe(0);
    expect(c.nRaw).toBe(0);
  });
  test("(c) clean done row + gate-fail park row ⇒ quotaHits:0 (neither source)", () => {
    const rows = [
      mkRow({ outcome: "done", gateFails: 0, consults: 0 }),
      mkRow({ outcome: "human", parkKind: "gate-fail" }),
    ];
    const c = cell(buildProfile(rows), rows[0])!;
    expect(c.dispatches).toBe(2);
    expect(c.quotaHits).toBe(0);
  });
  test("(d) a row marked BOTH quotaFailover AND parkKind:'quota' ⇒ quotaHits:1 (|| not +)", () => {
    const r = mkRow({ outcome: "human", parkKind: "quota", quotaFailover: true, durationMs: 0 });
    const c = cell(buildProfile([r]), r)!;
    expect(c.dispatches).toBe(1);
    expect(c.quotaHits).toBe(1); // ONCE — drill (4)
  });
});

// drill 2026-07-10 (1): drop the `dispatches ≥ MIN` gate on avail ⇒ this goes RED at
//   −AVAIL_WEIGHT (ratio 4/4 = 1), not 0. The thin-dispatch cold-start gate is load-bearing.
describe("26-02 cold-start thin-dispatch ⇒ score exactly 0", () => {
  test("4 quota rows (both kinds) ⇒ dispatches:4 < MIN, quotaHits:4 ⇒ Object.is(score, 0)", () => {
    const rows = [quotaFactRow(), quotaParkRow(), quotaFactRow(), quotaParkRow()];
    const p = buildProfile(rows);
    const c = cell(p, rows[0])!;
    expect(c.dispatches).toBe(4);
    expect(c.quotaHits).toBe(4);
    expect(Object.is(learnedScore(p, "implement", "claude-code:sonnet", "sub"), 0)).toBe(true);
  });
});

// drill 2026-07-10 (2): perturb AVAIL_WEIGHT 0.05→0.06 on scratch ⇒ the THROTTLED closed form goes
//   RED (term is live — no coverage theater). Penalty-only makes the no-throttle 0 immune to any
//   AVAIL_WEIGHT value, so the drill MUST target the throttled cell.
// This block also pins the guard restructure: the OLD `n<MIN ⇒ return NEUTRAL` early-exit would
// score the all-throttle cell 0, not −0.05.
describe("26-03 warm high-throttle strictly below no-throttle (deprioritized, never ejected)", () => {
  test("all-throttle −AVAIL_WEIGHT·(6/6) < no-throttle 0 = NEUTRAL", () => {
    // all-throttle: 6 quotaFailover rows on claude-code:sonnet ⇒ dispatches 6, quotaHits 6, n 0
    const throttle = buildProfile(Array.from({ length: 6 }, () => quotaFactRow({ model: "sonnet" })));
    const sThrottle = learnedScore(throttle, "implement", "claude-code:sonnet", "sub");
    // no-throttle dispatch-warm/quality-cold: 6 null-classified done rows ⇒ dispatches 6, quotaHits 0, n 0
    const noThrottle = buildProfile(nullDoneRows(6, { model: "fable" }));
    const sNoThrottle = learnedScore(noThrottle, "implement", "claude-code:fable", "sub");
    expect(sThrottle).toBe(-0.05); // HARD literal (NOT -AVAIL_WEIGHT): drill (2) perturbs the constant ⇒ this
                                   // catches it; also the guard-restructure pin (old n<MIN early-exit ⇒ 0)
    expect(sThrottle).toBe(-AVAIL_WEIGHT * (6 / 6)); // and it IS the −AVAIL_WEIGHT·ratio closed form
    expect(sNoThrottle).toBe(0); // NEUTRAL — nothing to penalize (quality 0 + perf 0 [n<MIN] + avail 0)
    expect(sThrottle).toBeLessThan(sNoThrottle); // strictly deprioritized
  });
});

// drill 2026-07-10 (3): make classify() map quota to a quality number ⇒ this n===0 pin goes RED
//   (double-count guard is real — quota must NEVER enter n/qSum).
describe("26-04 quota quality-isolation (classify null, quota never in n/qSum)", () => {
  test("classify() returns null for both quota sources", () => {
    expect(classify(mkRow({ outcome: "human", parkKind: "quota" }))).toBe(null);
    expect(classify(mkRow({ outcome: "failed", quotaFailover: true }))).toBe(null);
  });
  test("a quota-heavy cell keeps n===0 && nRaw===0 while quotaHits > 0", () => {
    const rows = [quotaFactRow(), quotaParkRow(), quotaFactRow()];
    const c = cell(buildProfile(rows), rows[0])!;
    expect(c.n).toBe(0);
    expect(c.nRaw).toBe(0);
    expect(c.quotaHits).toBe(3);
  });
});

describe("26-05 totality — availability term finite and bounded", () => {
  test("hostile hand-built cell (quotaHits > dispatches) stays finite, closed-form value", () => {
    const key = "implement|claude-code:sonnet|sub";
    const profile: RoutingProfile = {
      cells: new Map([[key, { n: 0, qSum: 0, dispatches: 6, doneCount: 0, quotaHits: 9, nRaw: 0 }]]),
    };
    const s = learnedScore(profile, "implement", "claude-code:sonnet", "sub");
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBe(-AVAIL_WEIGHT * (9 / 6));
  });
  test("bounds: ratio 1 ⇒ −AVAIL_WEIGHT, ratio 0 ⇒ 0; AVAIL_WEIGHT ≤ PERF_WEIGHT (sub-quantum)", () => {
    const at = (dispatches: number, quotaHits: number) => {
      const key = "implement|claude-code:sonnet|sub";
      const profile: RoutingProfile = {
        cells: new Map([[key, { n: 0, qSum: 0, dispatches, doneCount: 0, quotaHits, nRaw: 0 }]]),
      };
      return learnedScore(profile, "implement", "claude-code:sonnet", "sub");
    };
    expect(at(6, 6)).toBe(-AVAIL_WEIGHT); // ratio 1
    expect(at(6, 0)).toBe(0);             // ratio 0
    expect(AVAIL_WEIGHT).toBeLessThanOrEqual(PERF_WEIGHT);
  });
});

// drill 2026-07-10 (5): remove `cell.n < MIN_SAMPLES ||` from the perf gate ⇒ this pin goes RED at
//   ~+0.0249 (PERF_WEIGHT·(REF_MS/(REF_MS+1000) − 0.5)) — a quality-cold cell would earn a perf
//   score. The n-gate on perf is load-bearing (the `n<MIN ⇏ doneCount<MIN` lemma; ROUTE-07 byte-
//   identity for quotaHits=0 cells). Same cell shape as parity Test D(1) at :106.
// NOTE: GREEN against unmodified profile.ts (old early-exit already scores it 0); it is the
// regression pin that only goes RED under drill (5)'s mutation.
describe("26-06 doneCount>n cold-start regression pin (perf n-gate load-bearing)", () => {
  test("≥5 null-classified done rows ⇒ n<MIN, doneCount≥MIN, quotaHits:0 ⇒ Object.is(score, 0)", () => {
    const rows = nullDoneRows(6, { model: "sonnet" });
    const p = buildProfile(rows);
    const c = cell(p, rows[0])!;
    expect(c.n).toBe(0);                          // every row classified null
    expect(c.quotaHits).toBe(0);
    expect(c.doneCount).toBe(6);                  // ≥ MIN_SAMPLES — doneCount > n
    expect(c.doneMedianMs).toBe(1000);            // perf term WOULD fire if not n-gated
    expect(Object.is(learnedScore(p, "implement", "claude-code:sonnet", "sub"), 0)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 30 — ROUTE-15 learnedTuning plumbing + ROUTE-16 penalty-only resolution
// ═══════════════════════════════════════════════════════════════════════════

const twoRunFixture = (): ProfileRow[] => [
  mkRow({ runId: "run-20260101-000000", outcome: "done", gateFails: 0, consults: 0, durationMs: NaN }),
  mkRow({ runId: "run-20260201-000000", outcome: "done", gateFails: 0, consults: 0, durationMs: NaN }),
];

const twoRunWarmFixture = (): ProfileRow[] => [
  ...Array.from({ length: 3 }, () =>
    mkRow({ runId: "run-20260101-000000", outcome: "done", gateFails: 0, consults: 0, durationMs: NaN })),
  ...Array.from({ length: 3 }, () =>
    mkRow({ runId: "run-20260201-000000", outcome: "done", gateFails: 0, consults: 0, durationMs: NaN })),
];

// drill: changing HALF_LIFE_RUNS default or the param default reddens oracle (a).
describe("30-02 ROUTE-15 (a) config-absent parity — Object.is-identical to module constants", () => {
  test("two-run fixture: default halfLife ⇒ n=2, qSum=2 (decay fold literals)", () => {
    const p = buildProfile(twoRunFixture());
    const c = cell(p, twoRunFixture()[0])!;
    expect(c.n).toBe(2);
    expect(c.qSum).toBe(2);
    expect(c.nRaw).toBe(2);
  });

  test("six-row warm fixture: default halfLife ⇒ n=6; score closed form Object.is-identical", () => {
    const rows = twoRunWarmFixture();
    const p = buildProfile(rows);
    const c = cell(p, rows[0])!;
    expect(c.n).toBe(6);
    expect(c.qSum).toBe(6);
    const s = learnedScore(p, "implement", "claude-code:sonnet", "sub");
    const quality = (6 + PRIOR_K) / (6 + 2 * PRIOR_K) - 0.5;
    expect(Object.is(s, quality)).toBe(true);
  });
});

// drill: hardcoding the constant past the config read (ignoring the param) reddens oracle (b).
describe("30-02 ROUTE-15 (b) override-reaches-formula — plumbing is not inert", () => {
  test("halfLifeRuns:1 ⇒ older run weight 0.5 ⇒ n=1.5 ≠ default n=2", () => {
    const rows = twoRunFixture();
    const def = buildProfile(rows);
    const tuned = buildProfile(rows, { halfLifeRuns: 1 });
    expect(tuned.cells.get(keyOf(rows[0]))!.n).toBe(1.5);
    expect(tuned.cells.get(keyOf(rows[0]))!.qSum).toBe(1.5);
    expect(tuned).not.toEqual(def);
  });

  test("availWeight:0.5 on warm-throttled cell ⇒ score ≠ default −AVAIL_WEIGHT", () => {
    const throttle = buildProfile(Array.from({ length: 6 }, () => quotaFactRow({ model: "sonnet" })));
    const def = learnedScore(throttle, "implement", "claude-code:sonnet", "sub");
    const tuned = learnedScore(throttle, "implement", "claude-code:sonnet", "sub", { availWeight: 0.5 });
    expect(def).toBe(-AVAIL_WEIGHT);
    expect(tuned).toBe(-0.5);
    expect(tuned).not.toBe(def);
  });
});

describe("30-02 ROUTE-16 — penalty-only resolution grep pin", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/route/profile.ts", import.meta.url)), "utf8");
  // drill: deleting the resolution comment reddens this pin.
  test("ROUTE-16 penalty-only CONFIRMED comment present at avail term", () => {
    expect(/ROUTE-16: penalty-only CONFIRMED/.test(src)).toBe(true);
  });
});

// ── Phase 28 / VIS-05: cellsOf iterator + cellSummary single-source derivation ──
import { cellsOf, cellSummary } from "../../src/route/profile.js";

describe("28-01 cellsOf — decomposes cellKey inside profile.ts (report never hand-splits)", () => {
  test("yields decomposed identity + the SAME cell reference cellOf returns", () => {
    const rows = [
      mkRow({ shape: "implement", adapter: "claude-code", model: "fable", channel: "sub" }),
      mkRow({ shape: "test", adapter: "codex", model: "gpt-5.5-codex", channel: "api" }),
    ];
    const p = buildProfile(rows);
    const got = [...cellsOf(p)];
    expect(got.length).toBe(2);
    const fable = got.find((x) => x.chKey === "claude-code:fable")!;
    expect({ shape: fable.shape, chKey: fable.chKey, channel: fable.channel }).toEqual({
      shape: "implement", chKey: "claude-code:fable", channel: "sub",
    });
    // identity: cellsOf yields the exact cell object cellOf resolves (no copy)
    expect(fable.cell).toBe(cellOf(p, "implement", "claude-code:fable", "sub"));
    const codex = got.find((x) => x.chKey === "codex:gpt-5.5-codex")!;
    expect(codex.channel).toBe("api");
    expect(codex.cell).toBe(cellOf(p, "test", "codex:gpt-5.5-codex", "api"));
  });
});

describe("28-01 cellSummary — the single arithmetic source (exact, never toBeCloseTo)", () => {
  test("warm cell", () => {
    expect(cellSummary({ n: 5.5, qSum: 5.5, dispatches: 6, doneCount: 6, quotaHits: 0, nRaw: 6 })).toEqual({
      nRaw: 6, nEff: 5.5, dispatches: 6, quality: 1, quotaHits: 0, cold: false, exploreRemaining: 0, discounted: 0,
    });
  });
  test("cold cell", () => {
    expect(cellSummary({ n: 1, qSum: 0.5, dispatches: 1, doneCount: 1, quotaHits: 0, nRaw: 1 })).toEqual({
      nRaw: 1, nEff: 1, dispatches: 1, quality: 0.5, quotaHits: 0, cold: true, exploreRemaining: 4, discounted: 0,
    });
  });
  test("quota-only cell (nRaw ABSENT — old-literal case ⇒ coalesced to 0 HERE, not in cli)", () => {
    expect(cellSummary({ n: 0, qSum: 0, dispatches: 2, doneCount: 0, quotaHits: 2 })).toEqual({
      nRaw: 0, nEff: 0, dispatches: 2, quality: undefined, quotaHits: 2, cold: true, exploreRemaining: 3, discounted: 0,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 48 / ROUTE-18 — no-trailer overrun penalty (penalty-only, OBS-04).
// A channel that repeatedly burns a whole dispatch window without ever emitting a trailer
// ("worker-result ok:false, finished:false" — the daemon held the pane open, real verified work
// happened, but no machine-parseable result ever landed) must score LOWER, on a dedicated
// penalty-only axis that mirrors the v1.8 ROUTE-12 quotaFailover shape exactly:
//   ProfileRow.overrun?: true   — fact field; absent = UNOBSERVED, never false (=== true only)
//   ProfileCell.overruns        — undecayed integer counter, OPTIONAL like nRaw (always set by buildProfile)
//   OVERRUN_WEIGHT (= 0.05)     — sub-quantum constant, twin of AVAIL_WEIGHT
//   overrunPen                  — dispatches-gated negative ratio term in learnedScore
// Evidence base: pi:zai/glm-5.2 burned 3 windows on P43-03 + 2 on P45-01 doing real, verified
// work but never finishing (OBS-04) — learned routing kept liking it because overruns were
// invisible to the profile. Write side (daemon !finished branch + TelemetryRowSchema.overrun)
// is plan 48-03's; this plan declares the structural mirror field, compiles, and proves behavior
// from literal ProfileRow arrays with zero journal.ts dependence.
// ═══════════════════════════════════════════════════════════════════════════

// overrun fact row — the OBS-04 telemetry shape (daemon.ts !finished branch, 48-03's write side):
// outcome:failed, durationMs:0, overrun:true. The cast lands the RED test on unfixed HEAD (Task 2
// declares `overrun?: true`); the spread preserves the runtime key for buildProfile to count once
// the read side lands, and the cast becomes a harmless no-op. classify(failed)=null ⇒ the row bumps
// dispatches ONLY, never n/qSum — the penalty lives on its own axis, mirroring quotaFailover (ROUTE-12).
const overrunFactRow = (o: Partial<ProfileRow> = {}): ProfileRow =>
  ({ ...mkRow({ outcome: "failed", durationMs: 0, ...o }), overrun: true }) as ProfileRow;

// BYTE-IDENTITY fixture: ≥2 channels, all four outcome kinds, runIds for genuine decay; NO overrun
// facts. The literals in test (1) were captured on unfixed HEAD via an honest tsx print (NOT
// hand-computed) — they MUST stay Object.is-identical after Task 2 adds the overrun term, because
// an overrun-free cell contributes exactly 0 to it. A symmetric (0.5−ratio) overrun rewrite would
// reward EVERY cell by +0.5·OVERRUN_WEIGHT ⇒ reddens (1); a quality-axis leak reddens (7).
const pin48XRuns = ["run-20260101-000000", "run-20260201-000000", "run-20260301-000000",
  "run-20260401-000000", "run-20260501-000000", "run-20260601-000000"];
const pin48Rows = (): ProfileRow[] => [
  // channel X — claude-code:sonnet|sub: 6 clean done across 6 DISTINCT runs (oldest age 5 ⇒ weight
  //   0.5, so n = 5·1 + 1·0.5 = 5.5) + 1 quotaFailover fact ⇒ quality + perf + avail + decay ALL live.
  ...pin48XRuns.map((runId) => mkRow({ runId, outcome: "done", gateFails: 0, consults: 0, durationMs: 3000 })),
  mkRow({ runId: "run-20260601-000000", outcome: "failed", durationMs: 0, quotaFailover: true }),
  // channel Y — codex:gpt-5.5-codex|sub: 4 clean done (q=1) + 2 human gate-fail (q=0) + 1 quota park
  //   ⇒ a distinct nonzero score exercising both quota sources and the gate-fail quality path.
  ...Array.from({ length: 4 }, () => mkRow({ adapter: "codex", model: "gpt-5.5-codex", runId: "run-20260601-000000", outcome: "done", gateFails: 0, consults: 0, durationMs: 5000 })),
  ...Array.from({ length: 2 }, () => mkRow({ adapter: "codex", model: "gpt-5.5-codex", runId: "run-20260601-000000", outcome: "human", parkKind: "gate-fail", durationMs: 0 })),
  mkRow({ adapter: "codex", model: "gpt-5.5-codex", runId: "run-20260601-000000", outcome: "human", parkKind: "quota", durationMs: 0 }),
];

// SC1 fixture — the OBS-04 evidence shape (pi:zai/glm-5.2: 3 P43-03 + 2 P45-01 overrun windows).
// A and B carry IDENTICAL warm evidence (5 clean done each); A additionally carries the 5 OBS-04
// overrun fact rows on its own cell. On unfixed HEAD both score exactly equal (overruns invisible)
// ⇒ the lower-score assertion (2) is RED; after Task 2, A's overrunPen bites and A < B.
const SC1_A = "pi:zai/glm-5.2";  // the OBS-04 channel (overrun-prone)
const SC1_B = "pi:zai/glm-4.9";  // sibling model, identical evidence, no overruns
const sc1Warm = (model: string): ProfileRow[] =>
  Array.from({ length: 5 }, () => mkRow({ adapter: "pi", model, outcome: "done", gateFails: 0, consults: 0, durationMs: 2000 }));
const sc1Rows = (withOverruns: boolean): ProfileRow[] => [
  ...sc1Warm("zai/glm-5.2"),
  ...sc1Warm("zai/glm-4.9"),
  // the 5 OBS-04 overrun windows, split 3+2 to cite the evidence shape precisely (P43-03 + P45-01)
  ...(withOverruns ? [
    ...Array.from({ length: 3 }, () => overrunFactRow({ adapter: "pi", model: "zai/glm-5.2" })),
    ...Array.from({ length: 2 }, () => overrunFactRow({ adapter: "pi", model: "zai/glm-5.2" })),
  ] : []),
];

describe("48-01 ROUTE-18: no-trailer overrun penalty (penalty-only, OBS-04)", () => {
  // (1) BYTE-IDENTITY PINS — captured on unfixed HEAD, must not move after Task 2. OVERRUN_WEIGHT
  //     is referenced conceptually here (Task 2 exports it at 0.05); the literals are the proof.
  test("(1) overrun-free profile scores Object.is-identical to the pinned literals", () => {
    const p = buildProfile(pin48Rows());
    expect(Object.is(learnedScore(p, "implement", "claude-code:sonnet", "sub"), 0.25673882142084603)).toBe(true);
    expect(Object.is(learnedScore(p, "implement", "codex:gpt-5.5-codex", "sub"), 0.07619047619047623)).toBe(true);
  });

  // (2) SC1 lower-score — RED on unfixed HEAD (scores Object.is-equal at 0.25210661431591663),
  //     GREEN after Task 2 (A earns a −OVERRUN_WEIGHT·(5/10) penalty). The load-bearing red.
  test("(2) SC1: a channel with 5 OBS-04 overrun facts scores STRICTLY LOWER than its clean twin", () => {
    const p = buildProfile(sc1Rows(true));
    const a = learnedScore(p, "implement", SC1_A, "sub");
    const b = learnedScore(p, "implement", SC1_B, "sub");
    expect(a).toBeLessThan(b);
  });

  // (3) NEVER-REWARDS — adding A's overrun rows leaves B Object.is-unchanged (penalty is local to
  //     A's cell); the A−B delta is ∈ [−OVERRUN_WEIGHT, 0) (0 excluded — it NEVER rewards).
  //     HARD literal 0.05 mirrors the 26-03 drill pattern: catches an OVERRUN_WEIGHT perturbation.
  test("(3) penalty-only: overrun facts on A leave B Object.is-unchanged; A−B ∈ [−0.05, 0)", () => {
    const bClean = learnedScore(buildProfile(sc1Rows(false)), "implement", SC1_B, "sub");
    const bWithAOverruns = learnedScore(buildProfile(sc1Rows(true)), "implement", SC1_B, "sub");
    expect(Object.is(bClean, bWithAOverruns)).toBe(true);
    const a = learnedScore(buildProfile(sc1Rows(true)), "implement", SC1_A, "sub");
    expect(a - bWithAOverruns).toBeGreaterThanOrEqual(-0.05);  // −OVERRUN_WEIGHT floor
    expect(a - bWithAOverruns).toBeLessThan(0);                // NEVER rewards (0 excluded)
  });

  // (4) NEVER-EJECTS — the penalized channel's score stays finite and its cell stays in the profile.
  test("(4) never-ejects: A's score is finite (> −1) and cellOf still returns A's cell", () => {
    const p = buildProfile(sc1Rows(true));
    const a = learnedScore(p, "implement", SC1_A, "sub");
    expect(Number.isFinite(a)).toBe(true);
    expect(a).toBeGreaterThan(-1);
    expect(cellOf(p, "implement", SC1_A, "sub")).toBeDefined();
  });

  // (5) COLD-GATE (ROUTE-07) — a cell with dispatches < MIN_SAMPLES contributes an overrun term of
  //     exactly 0; thin evidence still defers to static sort keys. Dropping the dispatches gate on
  //     the overrun term ⇒ this pin REDS at −0.05·(4/4).
  test("(5) cold-gate: 4 overrun facts ⇒ dispatches<MIN ⇒ Object.is(score, 0)", () => {
    const rows = Array.from({ length: 4 }, () => overrunFactRow({ adapter: "pi", model: "zai/glm-5.2" }));
    const p = buildProfile(rows);
    expect(cellOf(p, "implement", SC1_A, "sub")!.dispatches).toBe(4);  // < MIN_SAMPLES
    expect(Object.is(learnedScore(p, "implement", SC1_A, "sub"), 0)).toBe(true);
  });

  // (6) ===true DOCTRINE — `overrun` absent means UNOBSERVED, never false; the counter branches on
  //     `=== true` only. A truthy-but-not-`true` garbage value ("yes") and an absent key both score
  //     byte-identical to the clean baseline (a `?? false` / `!== undefined` / `!== false` mutation
  //     would treat the garbage value as present ⇒ increment ⇒ reddens this pin). The fixture is a
  //     CLEAN quotaHits=0 cell so only dispatches moves on the extra failed row — with quotaHits=0
  //     and overruns=0 the avail + overrunPen terms stay 0 regardless of dispatches ⇒ byte-identical.
  test("(6) ===true doctrine: absent key and truthy-garbage value both score byte-identical to clean", () => {
    const doctrineWarm = (): ProfileRow[] =>
      Array.from({ length: 6 }, () => mkRow({ outcome: "done", gateFails: 0, consults: 0, durationMs: 3000 }));
    const v15Row = mkRow({ outcome: "failed", durationMs: 0 });                                       // v1.5: no overrun key
    const garbageRow = { ...mkRow({ outcome: "failed", durationMs: 0 }), overrun: "yes" } as unknown as ProfileRow;  // truthy, !== true
    const score = (extra: ProfileRow): number =>
      learnedScore(buildProfile([...doctrineWarm(), extra]), "implement", "claude-code:sonnet", "sub");
    expect(Object.is(score(v15Row), 0.2747512437810945)).toBe(true);
    expect(Object.is(score(garbageRow), 0.2747512437810945)).toBe(true);
  });

  // (7) QUALITY ISOLATION — an overrun fact row (outcome:failed) contributes NOTHING to n/qSum
  //     (classify returns null for failed); the penalty lives on its own axis, mirroring quotaHits,
  //     never inside the quality quotient. Only dispatches moves (by exactly the 5 fact rows).
  test("(7) quality isolation: failed overrun rows never enter n/qSum (penalty on its own axis)", () => {
    const cClean = cellOf(buildProfile(sc1Rows(false)), "implement", SC1_A, "sub")!;
    const cOverrun = cellOf(buildProfile(sc1Rows(true)), "implement", SC1_A, "sub")!;
    expect(cOverrun.n).toBe(cClean.n);          // 5 — failed rows classify null
    expect(cOverrun.qSum).toBe(cClean.qSum);    // 5
    expect(cOverrun.doneCount).toBe(cClean.doneCount);
    expect(cOverrun.dispatches).toBe(cClean.dispatches + 5);  // ONLY the utilization axis moves
  });
});
