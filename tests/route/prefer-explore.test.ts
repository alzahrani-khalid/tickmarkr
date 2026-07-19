// Phase 34 ROUTE-17 wave-0 invariant oracles — GREEN baselines against the UNMODIFIED router.
// These are the contracts Plan 02's comparator diff runs against: every test here must stay green
// after the within-prefer exploration fix. Protected files (parity/matrix/learned/explore/router/failover)
// are NOT edited; all new oracles live here (house convention: helpers copied verbatim, not exported).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { allAdapters, discoverChannels, writeDoctor } from "../../src/adapters/registry.js";
import { plan } from "../../src/cli/commands/plan.js";
import { saveGraph } from "../../src/graph/graph.js";
import { type BillingChannel, channelKey, channelsFromConfig } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, type TickmarkrConfig, loadConfig } from "../../src/config/config.js";
import { SHAPES, validateGraph } from "../../src/graph/schema.js";
import {
  buildProfile, cellOf, EXPLORE_CAP, explorationBonus, learnedScore,
  type ProfileCell, type ProfileRow, type RoutingProfile,
} from "../../src/route/profile.js";
import { route } from "../../src/route/router.js";
import { authedModels } from "../helpers/tmprepo.js";

// ── helpers copied verbatim from tests/route/explore.test.ts + tests/route/parity.test.ts ──
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

// under-cap HOSTILE evidence: n gate-fail parks ⇒ classify=0, dispatches=n, score exactly 0 while n<MIN_SAMPLES
const badRows = (shape: string, adapter: string, model: string, n: number): ProfileRow[] =>
  Array.from({ length: n }, () => ({
    shape, adapter, model, channel: "sub", attempts: 1, outcome: "human" as const,
    parkKind: "gate-fail", durationMs: 1000, gateFails: 1, consults: 0,
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

const DOCTOR5 = Object.fromEntries(
  ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map((id) => [id, { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers[id]?.models ?? {})) }]),
);
const seedTelemetry = (repo: string, runId: string, rows: ProfileRow[]) => {
  const dir = join(repo, ".tickmarkr", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const line = (r: ProfileRow) => JSON.stringify({ taskId: "T1", ...r });
  writeFileSync(join(dir, "telemetry.jsonl"), rows.map(line).join("\n") + "\n");
};

// ═══════════════════════════════════════════════════════════════════════════
// O-1 STARVATION (ROUTE-17): under-observed codex within prefer must be explored.
// RED vs pre-Phase-34 router: preferIndex 0 beats 1 before bonus is ever consulted (v1.9 starvation).
// ═══════════════════════════════════════════════════════════════════════════
describe("O-1 starvation: under-observed codex within prefer routes to terra with probe provenance", () => {
  const cfg = cfgOf();
  const channels = channelsOf(cfg);
  const profile = buildProfile(badRows("implement", "codex", "gpt-5.6-terra", 2));

  test("codex:gpt-5.6-terra wins with explore:true deviation over static cursor-agent:composer-2.5", () => {
    const r = route(mkTask("implement"), cfg, channels, profile);
    expect(channelKey(r.assignment)).toBe("codex:gpt-5.6-terra");
    expect(r.provenance).toMatch(/via exploration probe \(dispatches=2 < 5\)/);
    expect(r.deviation).toMatchObject({
      static: "cursor-agent:composer-2.5",
      chosen: "codex:gpt-5.6-terra",
      explore: true,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O-7 PREVIEW + MARKER PRECISION (ROUTE-17): plan names the within-prefer probe;
// warm score-only deviation must NOT fire explore (marker precision).
// ═══════════════════════════════════════════════════════════════════════════
describe("O-7 preview: plan output names the within-prefer exploration pick before a run", () => {
  test("plan() shows probe provenance and the ⇄ deviation line", async () => {
    // preview-before-bite: guards the marker rewrite — a sort-only fix with the old staticCmp(w,ru)===0
    // probe condition leaves this red (Pitfall 3).
    const { repo } = emptyRepo();
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 5, acceptance: ["a"] }],
    }));
    writeDoctor(repo, DOCTOR5);
    seedTelemetry(repo, "run-1", badRows("implement", "codex", "gpt-5.6-terra", 2));
    const out = await plan([], repo);
    expect(out).toMatch(/via exploration probe \(dispatches=2 < 5\)/);
    expect(out).toContain("⇄ static would pick cursor-agent:composer-2.5 — learned picked codex:gpt-5.6-terra");
  });
});

describe("O-7 marker precision: warm within-prefer score difference without explore", () => {
  const cfg = cfgOf();
  const channels = channelsOf(cfg);
  const profile = buildProfile(warmRows("implement", "codex", "gpt-5.6-terra", 6));

  test("deviation has no explore property and provenance says via learned score", () => {
    const r = route(mkTask("implement"), cfg, channels, profile);
    expect(r.provenance).toMatch(/via learned score/);
    expect(r.deviation).toBeDefined();
    expect(r.deviation).not.toHaveProperty("explore");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O-2 CONTAINMENT (ROUTE-17): an off-prefer channel with maximal exploration bonus AND positive
// learned score never beats an in-prefer channel. Red-capable: delete the band/prefer key from the
// comparator ⇒ this reddens. Three legs cover bonus, score, and the maximally-hostile hand-crafted cell.
// ═══════════════════════════════════════════════════════════════════════════
describe("O-2 containment: a hostile off-prefer channel never beats an in-prefer channel (implement: prefer [cursor-agent, codex])", () => {
  const cfg = cfgOf();
  const channels = channelsOf(cfg);
  const hostileKey = "claude-code:sonnet"; // off-prefer (preferIndex 2), mid ⇒ eligible under implement's mid floor

  test("(a) positive learned score, bonus 0: sonnet warm-good still loses to cursor-agent:composer-2.5", () => {
    const rows = warmRows("implement", "claude-code", "sonnet", 6);
    const { profile, m } = spyProfile([...buildProfile(rows).cells]);
    // prove the hostile cell genuinely carries the property under test
    expect(explorationBonus(cellOf(profile, "implement", hostileKey, "sub"))).toBe(0); // dispatches 6 ⇒ cap reached
    expect(learnedScore(profile, "implement", hostileKey, "sub")).toBeGreaterThan(0); // warm-good ⇒ positive score
    const r = route(mkTask("implement"), cfg, channels, profile);
    expect(channelKey(r.assignment)).toBe("cursor-agent:composer-2.5"); // band 0 (in-prefer) wins
    expect(m.reads).toBeGreaterThan(0); // profile WAS consulted — containment held despite consultation
  });

  test("(b) under-cap bonus 0.6, score 0: sonnet under-observed still loses to cursor-agent:composer-2.5", () => {
    const rows = badRows("implement", "claude-code", "sonnet", 2);
    const { profile, m } = spyProfile([...buildProfile(rows).cells]);
    expect(explorationBonus(cellOf(profile, "implement", hostileKey, "sub"))).toBeCloseTo(0.6, 10);
    expect(learnedScore(profile, "implement", hostileKey, "sub")).toBe(0); // n<MIN ⇒ exactly neutral
    const r = route(mkTask("implement"), cfg, channels, profile);
    expect(channelKey(r.assignment)).toBe("cursor-agent:composer-2.5");
    expect(m.reads).toBeGreaterThan(0);
  });

  test("(c) maximally hostile hand-crafted cell (bonus 1 AND positive score): still loses", () => {
    // dispatches 0 ⇒ bonus exactly 1; n/qSum/doneCount ≥ MIN ⇒ positive score — impossible from natural
    // rows (n ≤ dispatches), so hand-craft the cell to combine both hostile properties simultaneously.
    const hostileCell: ProfileCell = { n: 6, qSum: 6, dispatches: 0, doneCount: 6, quotaHits: 0, doneMedianMs: 1000 };
    const { profile, m } = spyProfile([["implement|claude-code:sonnet|sub", hostileCell]]);
    expect(explorationBonus(cellOf(profile, "implement", hostileKey, "sub"))).toBe(1); // bonus maximized
    expect(learnedScore(profile, "implement", hostileKey, "sub")).toBeGreaterThan(0); // AND positive score
    const r = route(mkTask("implement"), cfg, channels, profile);
    expect(channelKey(r.assignment)).toBe("cursor-agent:composer-2.5"); // in-prefer band 0 contains the hostile off-prefer cell
    expect(m.reads).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O-3 COLD BYTE-IDENTICAL (ROUTE-07): an empty profile routes prefer[0], byte-identical to the 3-arg
// call. (a) is the load-bearing tier-asymmetric overlay that REJECTS the flat `band||cost||tier||...`
// comparator (it would pick codex:luna cheap over claude-code:fable frontier on a cold tie, breaking
// ROUTE-07); (b) sweeps every shape under the default config.
// ═══════════════════════════════════════════════════════════════════════════
describe("O-3(a) cold byte-identical: tier-asymmetric overlay prefer:[claude-code:fable, codex] ⇒ prefer[0] wins, 4-arg ≡ 3-arg", () => {
  // fable is frontier; codex's cheapest channel gpt-5.6-luna is cheap — tier-asymmetric ON PURPOSE
  // (RESEARCH §Rejected Design). A flat band||cost||tier||bonus||score||preferIndex order would tie on
  // band+cost and let tier pick luna (cheap<frontier) on a COLD profile ⇒ ROUTE-07 broken. This test
  // rejects that design: cold must stay prefer[0]=fable, byte-identical to the 3-arg call.
  const { repo, globalDir } = repoWithOverlay(
    "routing:\n  map:\n    chore:\n      prefer: [\"claude-code:fable\", \"codex\"]\n",
  );
  const cfg = loadConfig(repo, { globalDir });
  const channels = channelsOf(cfg);

  test("empty profile deep-equals the 3-arg call AND the winner is prefer[0] claude-code:fable", () => {
    const t = mkTask("chore");
    const four = route(t, cfg, channels, buildProfile([]));
    const three = route(t, cfg, channels);
    expect(four).toEqual(three); // full Route deep-equal — ROUTE-07 cold identity for an arbitrary overlay
    expect(four.assignment.adapter).toBe("claude-code");
    expect(four.assignment.model).toBe("fable"); // prefer[0], NOT codex:gpt-5.6-luna (cheap)
    expect(four.deviation).toBeUndefined();
  });
});

describe("O-3(b) cold byte-identical: every shape under the DEFAULT config deep-equals the 3-arg call", () => {
  const cfg = cfgOf();
  const channels = channelsOf(cfg);

  test.each([...SHAPES])("%s: empty profile full Route deep-equals the 3-arg call", (shape) => {
    const t = mkTask(shape);
    expect(route(t, cfg, channels, buildProfile([]))).toEqual(route(t, cfg, channels));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O-4 NON-PREFER WARM PIN: a warm non-prefer shape reproduces TODAY's exact Route object — Plan 02
// must not change a byte of this. chore has no prefer entry under the default config; warming
// codex:gpt-5.6-luna lets the learned score decide within the cheap static tie (haiku discovery-first).
// ═══════════════════════════════════════════════════════════════════════════
describe("O-4 non-prefer warm pin: warm chore reproduces today's exact Route object", () => {
  const cfg = cfgOf();
  const channels = channelsOf(cfg);
  const profile = buildProfile(warmRows("chore", "codex", "gpt-5.6-luna", 6));

  test("full Route literal snapshot (assignment, ladder, lints, provenance, deviation at full float precision)", () => {
    const r = route(mkTask("chore"), cfg, channels, profile);
    expect(r).toEqual({
      assignment: { adapter: "codex", model: "gpt-5.6-luna", channel: "sub", tier: "cheap" },
      ladder: ["retry", "escalate", "consult", "human"],
      lints: [],
      provenance: "floor cheap (config floors), marginal-cost auto (via learned score 0.275 (n=6) over claude-code:haiku 0.000)",
      deviation: {
        static: "claude-code:haiku",
        chosen: "codex:gpt-5.6-luna",
        score: 0.2749168053244592, // full float precision of the warm-good learned score (n=6 clean rows)
        staticScore: 0,
        n: 6,
      },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O-5 PIN/FLOOR unaffected (ROUTE-08): task AND map pins return before the profile is consulted
// (reads === 0); the floor filters below-tier channels before the learned sort. The map pin is a
// DISTINCT early-return path (router.ts `if (entry?.pin)`) from the task pin — both must be pinned.
// ═══════════════════════════════════════════════════════════════════════════
describe("O-5(a) task pin: assignment = pin AND profile never consulted (reads === 0)", () => {
  const cfg = cfgOf();
  const channels = channelsOf(cfg);

  test("implement task pin claude-code:fable wins and the profile is never read", () => {
    const { profile, m } = spyProfile([...buildProfile(badRows("implement", "codex", "gpt-5.6-terra", 2)).cells]);
    const t = mkTask("implement", { routingHints: { pin: { via: "claude-code", model: "fable" } } });
    const r = route(t, cfg, channels, profile);
    expect(channelKey(r.assignment)).toBe("claude-code:fable");
    expect(m.reads).toBe(0); // task-pin return is upstream of the learned block
  });
});

describe("O-5(b) map pin: assignment = map pin AND profile never consulted (reads === 0)", () => {
  const cfg = cfgOf();
  const channels = channelsOf(cfg);

  test("plan (config routing.map pin claude-code:fable) wins and the profile is never read", () => {
    // plan's map pin is the entry?.pin return path (distinct from the task-pin path). A Phase 34 change
    // that consulted the profile before this return would break reads===0 — this pins that it does not.
    const { profile, m } = spyProfile([...buildProfile(badRows("plan", "codex", "gpt-5.6-luna", 2)).cells]);
    const r = route(mkTask("plan"), cfg, channels, profile);
    expect(channelKey(r.assignment)).toBe("claude-code:fable");
    expect(m.reads).toBe(0); // map-pin return is upstream of the learned block
  });
});

describe("O-5(c) floor: a below-floor under-cap mid channel is filtered before the learned sort", () => {
  test("migration (frontier floor, no map entry) ⇒ winner tier is frontier despite an under-cap mid codex cell", () => {
    // migration has NO map entry, so minTier = the frontier floor (the floor actually filters here — a map
    // tier would take precedence and make the floor advisory-only). terra=mid is below frontier ⇒ filtered
    // upstream of the learned sort, so its under-cap bonus (0.6) can never be consulted.
    const cfg = cfgOf();
    const channels = channelsOf(cfg);
    const profile = buildProfile(badRows("migration", "codex", "gpt-5.6-terra", 2)); // terra=mid, dispatches 2 ⇒ bonus 0.6
    expect(explorationBonus(cellOf(profile, "migration", "codex:gpt-5.6-terra", "sub"))).toBeCloseTo(0.6, 10);
    const r = route(mkTask("migration"), cfg, channels, profile);
    expect(r.assignment.tier).toBe("frontier"); // the under-cap mid channel was filtered at the floor, upstream of any learned key
    expect(channelKey(r.assignment)).not.toBe("codex:gpt-5.6-terra");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O-6 INTRA-GROUP cost/tier outrank bonus/score (ROUTE-08 within one prefer entry): with prefer:[codex]
// for chore (one group), marginal cost and tier still decide BEFORE bonus and score. Two legs: the
// BONUS leg (under-cap frontier sol, bonus 0.6, score 0) and the SCORE leg (warm sol, bonus 0, score>0)
// — together they pin that NEITHER learned key can promote an expensive channel within a prefer group.
// Goes red under a comparator that places bonus OR score above cost/tier inside a prefer entry.
// ═══════════════════════════════════════════════════════════════════════════
describe("O-6 intra-group: within one prefer entry, marginal cost and tier outrank bonus AND score", () => {
  test("(a) BONUS leg: under-cap frontier codex:gpt-5.6-sol (bonus 0.6) loses to cheap codex:gpt-5.6-luna", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  map:\n    chore:\n      prefer: [\"codex\"]\n");
    const cfg = loadConfig(repo, { globalDir });
    const channels = channelsOf(cfg);
    const profile = buildProfile(badRows("chore", "codex", "gpt-5.6-sol", 2)); // sol=frontier, dispatches 2 ⇒ bonus 0.6
    // prove the hostile frontier cell genuinely carries an exploration bonus
    expect(explorationBonus(cellOf(profile, "chore", "codex:gpt-5.6-sol", "sub"))).toBeCloseTo(0.6, 10);
    const r = route(mkTask("chore"), cfg, channels, profile);
    expect(channelKey(r.assignment)).toBe("codex:gpt-5.6-luna"); // cheap (cost/tier) outranks bonus within the prefer group
  });

  test("(b) SCORE leg: warm-good frontier codex:gpt-5.6-sol (score>0, bonus 0) loses to cheap codex:gpt-5.6-luna", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  map:\n    chore:\n      prefer: [\"codex\"]\n");
    const cfg = loadConfig(repo, { globalDir });
    const channels = channelsOf(cfg);
    const profile = buildProfile(warmRows("chore", "codex", "gpt-5.6-sol", 6)); // sol=frontier, dispatches 6 ⇒ bonus 0, score>0
    // prove the hostile frontier cell genuinely carries a POSITIVE learned score (the leg the gate required)
    expect(explorationBonus(cellOf(profile, "chore", "codex:gpt-5.6-sol", "sub"))).toBe(0);
    expect(learnedScore(profile, "chore", "codex:gpt-5.6-sol", "sub")).toBeGreaterThan(0);
    const r = route(mkTask("chore"), cfg, channels, profile);
    expect(channelKey(r.assignment)).toBe("codex:gpt-5.6-luna"); // cheap (cost/tier) outranks the score key within the prefer group
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O-8 DETERMINISM + BUDGET CLOSE-OUT (ROUTE-17): repeated route() deep-equal;
// probe budget self-extinguishes at EXPLORE_CAP and cold order resumes.
// Transitivity: lexicographic over fixed precomputed vectors is total (P5) — no per-pair
// conditional comparator, so no 3-cycle; determinism below is the runnable check.
// ═══════════════════════════════════════════════════════════════════════════
describe("O-8 determinism + budget close-out on implement/prefer", () => {
  const cfg = cfgOf();
  const channels = channelsOf(cfg);

  test("(a) three identical route() calls deep-equal (no RNG, no clock)", () => {
    const profile = buildProfile(badRows("implement", "codex", "gpt-5.6-terra", 2));
    const t = mkTask("implement");
    const r1 = route(t, cfg, channels, profile);
    const r2 = route(t, cfg, channels, profile);
    const r3 = route(t, cfg, channels, profile);
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });

  test("(b) dispatches 2..4 keep probing terra; at EXPLORE_CAP cold order resumes", () => {
    for (const d of [2, 3, 4]) {
      const r = route(mkTask("implement"), cfg, channels, buildProfile(badRows("implement", "codex", "gpt-5.6-terra", d)));
      expect(channelKey(r.assignment)).toBe("codex:gpt-5.6-terra");
      expect(r.provenance).toMatch(/via exploration probe/);
    }
    const rCap = route(mkTask("implement"), cfg, channels, buildProfile(badRows("implement", "codex", "gpt-5.6-terra", EXPLORE_CAP)));
    expect(channelKey(rCap.assignment)).toBe("cursor-agent:composer-2.5");
    expect(rCap.provenance).not.toMatch(/exploration probe/);
    expect(rCap.deviation).toBeUndefined();
  });
});

// v1.10 cross-phase seam (FLEET-06 × FLEET-07 × ROUTE-17): a warm exploration profile can NEVER
// resurrect a denied channel. Two containment paths, both pinned here:
//  (1) a denied channel that IS a prefer entry → FLEET-07 fails LOUD at route time, even when the
//      profile screams "explore it" (deny wins over the exploration budget — the stronger outcome).
//  (2) a denied channel that is OFF the prefer list → filtered from discovery, so it is not even a
//      candidate; route succeeds within prefer and never probes it.
// Belt-and-suspenders against a future refactor that passes an unfiltered list into route().
describe("exploration is contained to the allowed set (FLEET-PREF × exploration-within-prefer)", () => {
  test("(1) a warm profile cannot override a deny on a prefer-listed channel — FLEET-07 fails loud", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  deny:\n    adapters: [codex]\n"); // codex ∈ implement prefer
    const cfg = loadConfig(repo, { globalDir });
    const allowed = discoverChannels(cfg, allAdapters(), DOCTOR5);
    expect(allowed.some((c) => c.adapter === "codex")).toBe(false); // filtered from discovery
    const profile = buildProfile(badRows("implement", "codex", "gpt-5.6-terra", 2)); // "explore codex"
    expect(() => route(mkTask("implement"), cfg, allowed, profile)).toThrow(/codex is disallowed by routing\.deny/);
  });

  test("(2) a denied OFF-prefer channel with max budget is never probed; route stays within prefer", () => {
    // deny opencode (NOT in the implement prefer [cursor-agent, codex]); give it a fat exploration budget.
    const { repo, globalDir } = repoWithOverlay("routing:\n  deny:\n    adapters: [opencode]\n");
    const cfg = loadConfig(repo, { globalDir });
    const allowed = discoverChannels(cfg, allAdapters(), DOCTOR5);
    expect(allowed.some((c) => c.adapter === "opencode")).toBe(false);
    const profile = buildProfile(badRows("implement", "opencode", "zai-coding-plan/glm-5.2", 2));
    const r = route(mkTask("implement"), cfg, allowed, profile);
    expect(channelKey(r.assignment)).not.toContain("opencode");
    expect(channelKey(r.assignment)).toBe("cursor-agent:composer-2.5"); // prefer[0], allowed
  });
});
