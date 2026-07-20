import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, type TickmarkrConfig, TIER_RANK } from "../../src/config/config.js";
import { type AuthHealth, type BillingChannel, channelKey, type WorkerAdapter } from "../../src/adapters/types.js";
import { discoverChannels } from "../../src/adapters/registry.js";
import { rankCandidates } from "../../src/route/candidates.js";
import { disallowedBy } from "../../src/route/preference.js";
import { marginalCostRank, nextChannel, route, RoutingError, type RoutingPreferContext } from "../../src/route/router.js";
import { validateGraph } from "../../src/graph/schema.js";

const CH: BillingChannel[] = [
  { adapter: "claude-code", vendor: "anthropic", model: "fable", channel: "sub", tier: "frontier" },
  { adapter: "claude-code", vendor: "anthropic", model: "sonnet", channel: "sub", tier: "mid" },
  { adapter: "codex", vendor: "openai", model: "gpt-5.6-terra", channel: "sub", tier: "mid" },
  { adapter: "cursor-agent", vendor: "cursor", model: "composer-2", channel: "sub", tier: "mid" },
  { adapter: "opencode", vendor: "mixed", model: "moonshotai/kimi-k2", channel: "api", tier: "cheap" },
];

const cfg: TickmarkrConfig = structuredClone(DEFAULT_CONFIG);

const mkTask = (over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 5, acceptance: ["a"], ...over }],
  }).tasks[0];

describe("route resolution order", () => {
  test("1: per-task pin wins over everything", () => {
    const t = mkTask({ shape: "implement", routingHints: { pin: { via: "claude-code", model: "fable" } } });
    expect(route(t, cfg, CH).assignment).toMatchObject({ adapter: "claude-code", model: "fable" });
  });

  test("1b: task pin beats a conflicting map pin", () => {
    // shape "plan" carries a map pin (claude-code:fable per seed); the task-level pin must win
    const t = mkTask({ shape: "plan", routingHints: { pin: { via: "codex", model: "gpt-5.6-terra" } } });
    expect(route(t, cfg, CH).assignment).toMatchObject({ adapter: "codex", model: "gpt-5.6-terra" });
  });

  test("2: map pin (plan → claude-code fable per seed)", () => {
    expect(route(mkTask({ shape: "plan" }), cfg, CH).assignment).toMatchObject({ adapter: "claude-code", model: "fable" });
  });

  test("3+4: map tier+prefer — implement prefers cursor-agent at mid", () => {
    expect(route(mkTask({ shape: "implement" }), cfg, CH).assignment).toMatchObject({ adapter: "cursor-agent", tier: "mid" });
  });

  test("4: unmapped shape → floor + marginal-cost + cheapest-sufficient-tier order", () => {
    // chore floor cheap; subs tie at marginal-cost 0, so the new tier key picks the lowest-tier sub.
    // CH has no cheap sub, so the lowest is mid; three mid subs tie → discovery order → claude-code:sonnet.
    const r = route(mkTask({ shape: "chore" }), cfg, CH);
    expect(r.assignment).toMatchObject({ adapter: "claude-code", model: "sonnet" });
  });

  test("floor lint: pin below floor routes but lints loudly", () => {
    const t = mkTask({ shape: "migration", routingHints: { pin: { via: "opencode", model: "moonshotai/kimi-k2" } } });
    const r = route(t, cfg, CH);
    expect(r.assignment.adapter).toBe("opencode");
    expect(r.lints.join()).toMatch(/below.*floor/i);
  });

  test("task pin to a channel doctor didn't find degrades with a lint (no throw)", () => {
    const t = mkTask({ routingHints: { pin: { via: "gemini", model: "flash" }, source: "02-03-PLAN.md" } });
    const r = route(t, cfg, CH);
    expect(r.assignment.adapter).toBeTruthy(); // still routed via the remaining priority order
    expect(r.lints.join()).toMatch(/gemini:flash.*unavailable/);
    expect(r.lints.join()).toContain("02-03-PLAN.md"); // lint carries the hint's source
    expect(r.provenance).toMatch(/unavailable/);
  });

  test("config routing.map pin to an absent channel still throws RoutingError", () => {
    const c2 = structuredClone(cfg);
    c2.routing.map.plan = { pin: { via: "gemini", model: "flash" } };
    expect(() => route(mkTask({ shape: "plan" }), c2, CH)).toThrow(RoutingError);
  });

  test("no eligible channel at all → RoutingError", () => {
    expect(() => route(mkTask({ shape: "migration" }), cfg, [CH[4]])).toThrow(RoutingError); // only cheap available, floor frontier, no pin match
  });
});

describe("ROUTE-01 cheapest-sufficient-tier tiebreak (all-sub fleet)", () => {
  const allSub: BillingChannel[] = [
    { adapter: "claude-code", vendor: "anthropic", model: "fable", channel: "sub", tier: "frontier" },
    { adapter: "claude-code", vendor: "anthropic", model: "sonnet", channel: "sub", tier: "mid" },
    { adapter: "claude-code", vendor: "anthropic", model: "haiku", channel: "sub", tier: "cheap" },
  ];

  test("unmapped cheap-floor shape → lowest sufficient tier (haiku), not fable by discovery order", () => {
    const r = route(mkTask({ shape: "chore" }), cfg, allSub);
    expect(r.assignment).toMatchObject({ adapter: "claude-code", model: "haiku" });
  });

  test("prefer seniority still wins over the tier key", () => {
    // codex mid sub is senior via prefer despite haiku being a cheaper tier
    const withCodex: BillingChannel[] = [
      ...allSub,
      { adapter: "codex", vendor: "openai", model: "gpt-5.6-terra", channel: "sub", tier: "mid" },
    ];
    const c2 = structuredClone(cfg);
    c2.routing.map.chore = { prefer: ["codex"] };
    const r = route(mkTask({ shape: "chore" }), c2, withCodex);
    expect(r.assignment).toMatchObject({ adapter: "codex", model: "gpt-5.6-terra" });
  });
});

describe("task floor (routingHints.floor) as hard constraint", () => {
  test("floor 'mid' on a cheap-floored shape narrows to tier >= mid", () => {
    const r = route(mkTask({ shape: "chore", routingHints: { floor: "mid" } }), cfg, CH);
    expect(TIER_RANK[r.assignment.tier]).toBeGreaterThanOrEqual(TIER_RANK.mid);
  });

  test("task floor beats a LOWER map tier (max, not fallback)", () => {
    // tests shape maps to tier cheap + prefer opencode; floor mid must exclude the cheap channel
    const r = route(mkTask({ shape: "tests", routingHints: { floor: "mid" } }), cfg, CH);
    expect(TIER_RANK[r.assignment.tier]).toBeGreaterThanOrEqual(TIER_RANK.mid);
    expect(r.assignment.adapter).not.toBe("opencode");
  });

  test("map tier above the task floor still applies (max governs)", () => {
    // implement maps to mid; task floor cheap must not lower the bar
    const r = route(mkTask({ shape: "implement", routingHints: { floor: "cheap" } }), cfg, CH);
    expect(TIER_RANK[r.assignment.tier]).toBeGreaterThanOrEqual(TIER_RANK.mid);
  });

  test("no channel at/above the task floor → RoutingError naming the tier", () => {
    expect(() => route(mkTask({ shape: "chore", routingHints: { floor: "frontier" } }), cfg, [CH[4]])).toThrow(/frontier/);
  });

  test("task pin below the task's own floor degrades like a miss (A3): lint + floor path", () => {
    const t = mkTask({ shape: "chore", routingHints: { pin: { via: "opencode", model: "moonshotai/kimi-k2" }, floor: "frontier" } });
    const r = route(t, cfg, CH);
    expect(TIER_RANK[r.assignment.tier]).toBeGreaterThanOrEqual(TIER_RANK.frontier);
    expect(r.lints.join()).toMatch(/below.*floor/i);
    expect(r.provenance).toMatch(/below/);
  });
});

describe("provenance", () => {
  test("resolvable task pin: provenance names the pin, task-hint origin, and source", () => {
    const t = mkTask({ routingHints: { pin: { via: "claude-code", model: "fable" }, source: "02-01-PLAN.md" } });
    const r = route(t, cfg, CH);
    expect(r.provenance).toContain("claude-code:fable");
    expect(r.provenance).toContain("task hint");
    expect(r.provenance).toContain("02-01-PLAN.md");
  });

  test("every path yields non-empty provenance without 'undefined'", () => {
    const auto = route(mkTask({ shape: "chore" }), cfg, CH); // no hints, no map entry
    expect(auto.provenance).toMatch(/auto/);
    expect(auto.provenance).toContain("cheapest sufficient tier"); // ROUTE-03: tie key broke it, so name it
    expect(auto.provenance).not.toContain("via prefer");
    const mapPrefer = route(mkTask({ shape: "implement" }), cfg, CH); // implement maps prefer:[cursor-agent, codex]
    expect(mapPrefer.provenance).toMatch(/config floors/); // v1.51 T3: the band bound is the floor authority now
    expect(mapPrefer.provenance).toContain("via prefer"); // WR-01: prefer picked the winner, not the tier key
    expect(mapPrefer.provenance).not.toContain("cheapest sufficient tier");
    const mapPin = route(mkTask({ shape: "plan" }), cfg, CH);
    expect(mapPin.provenance).toContain("claude-code:fable");
    const taskFloor = route(mkTask({ shape: "chore", routingHints: { floor: "mid", source: "02-09-PLAN.md" } }), cfg, CH);
    expect(taskFloor.provenance).toContain("mid");
    expect(taskFloor.provenance).toContain("02-09-PLAN.md");
    const floorOnlyNoSource = route(mkTask({ shape: "chore", routingHints: { floor: "mid" } }), cfg, CH); // hand-authored graph without source
    for (const r of [auto, mapPrefer, mapPin, taskFloor, floorOnlyNoSource]) {
      expect(r.provenance.length).toBeGreaterThan(0);
      expect(r.provenance).not.toContain("undefined");
    }
  });
});

describe("ladder + escalation", () => {
  test("default ladder; escalate:false drops the escalate step", () => {
    expect(route(mkTask({ shape: "implement" }), cfg, CH).ladder).toEqual(["retry", "escalate", "consult", "human"]);
    const c2 = structuredClone(cfg);
    c2.routing.map.implement = { ...c2.routing.map.implement, escalate: false };
    expect(route(mkTask({ shape: "implement" }), c2, CH).ladder).toEqual(["retry", "consult", "human"]);
  });

  test("nextChannel climbs one band up, skips tried, exhausts to null", () => {
    const cur = { adapter: "cursor-agent", model: "composer-2", channel: "sub" as const, tier: "mid" as const };
    const n1 = nextChannel(cur, mkTask(), cfg, CH, ["cursor-agent:composer-2"]);
    expect(n1?.tier).toBe("mid"); // other mid channels before jumping to frontier
    const allTried = CH.map((c) => `${c.adapter}:${c.model}`);
    expect(nextChannel(cur, mkTask(), cfg, CH, allTried)).toBeNull();
  });

  test("ROUTE-02: nextChannel returns lowest sufficient tier on an all-sub fleet, not frontier", () => {
    const allSub: BillingChannel[] = [
      { adapter: "claude-code", vendor: "anthropic", model: "fable", channel: "sub", tier: "frontier" },
      { adapter: "claude-code", vendor: "anthropic", model: "sonnet", channel: "sub", tier: "mid" },
      { adapter: "claude-code", vendor: "anthropic", model: "haiku", channel: "sub", tier: "cheap" },
    ];
    const cur = { adapter: "claude-code", model: "haiku", channel: "sub" as const, tier: "cheap" as const };
    const n = nextChannel(cur, mkTask(), cfg, allSub, ["claude-code:haiku"]);
    expect(n).toMatchObject({ model: "sonnet", tier: "mid" }); // climbs one band, not straight to fable
  });

  test("marginalCostRank: sub < cheap api < frontier api", () => {
    expect(marginalCostRank(CH[0])).toBe(0);
    expect(marginalCostRank(CH[4])).toBe(1);
    expect(marginalCostRank({ ...CH[0], channel: "api" })).toBe(3);
  });
});

// T2 (2026-07-13): a model doctor marked unauthed (modelAuth[model].authed===false) must advertise no
// BillingChannel, and a floor satisfiable only by such models must fail route() fail-closed — the v1.10
// scenario where a listed-but-unauthed model reached dispatch and hit a 403. router.ts itself is unchanged
// (the filter is upstream in discoverChannels); these tests pin both ends of that contract.
describe("T2 unauthed-model exclusion (2026-07-13)", () => {
  const t2cfg: TickmarkrConfig = structuredClone(DEFAULT_CONFIG);
  // a stub adapter whose channels() reports a frontier + a mid model — the real adapters build channels
  // from cfg.tiers, but discoverChannels only needs a.channels(cfg) to exercise its filter logic.
  const stub = {
    id: "claude-code",
    channels: (): BillingChannel[] => [
      { adapter: "claude-code", vendor: "anthropic", model: "fable", channel: "sub", tier: "frontier" },
      { adapter: "claude-code", vendor: "anthropic", model: "sonnet", channel: "sub", tier: "mid" },
    ],
  } as unknown as WorkerAdapter;

  test("an unauthed model produces no BillingChannel", () => {
    const health: Record<string, AuthHealth> = {
      "claude-code": {
        installed: true, authed: true, models: ["fable", "sonnet"],
        modelAuth: {
          fable: { authed: false, reason: "HTTP 403: forbidden", probedAt: "2026-07-13T09:12:00Z" },
          sonnet: { authed: true, probedAt: "2026-07-13T09:12:00Z" },
        },
      },
    };
    const ch = discoverChannels(t2cfg, [stub], health);
    expect(ch.map((c) => c.model)).toEqual(["sonnet"]);
    expect(ch.find((c) => c.model === "fable")).toBeUndefined();
  });

  test("missing verdicts fail closed unless legacy mode is enabled", () => {
    const none: Record<string, AuthHealth> = { "claude-code": { installed: true, authed: true, models: [] } };
    const allAuthed: Record<string, AuthHealth> = {
      "claude-code": { installed: true, authed: true, models: [], modelAuth: {
        fable: { authed: true, probedAt: "2026-07-13T09:12:00Z" },
        sonnet: { authed: true, probedAt: "2026-07-13T09:12:00Z" },
      } },
    };
    const legacy = structuredClone(t2cfg);
    legacy.routing.allowUnverifiedModels = true;
    expect(discoverChannels(t2cfg, [stub], none)).toEqual([]);
    expect(discoverChannels(legacy, [stub], none).map((c) => c.model))
      .toEqual(discoverChannels(t2cfg, [stub], allAuthed).map((c) => c.model));
  });

  test("a floor satisfiable only by unauthed models fails route() fail-closed (no dispatch)", () => {
    // discoverChannels drops the unauthed frontier model; only the mid model survives. migration's floor is
    // frontier ⇒ eligibleRaw empty ⇒ RoutingError. The unauthed model never reaches an Assignment.
    const health: Record<string, AuthHealth> = {
      "claude-code": {
        installed: true, authed: true, models: ["fable", "sonnet"],
        modelAuth: {
          fable: { authed: false, reason: "HTTP 403: forbidden", probedAt: "2026-07-13T09:12:00Z" },
          sonnet: { authed: true, probedAt: "2026-07-13T09:12:00Z" },
        },
      },
    };
    const ch = discoverChannels(t2cfg, [stub], health);
    expect(ch.map((c) => c.model)).toEqual(["sonnet"]);
    expect(() => route(mkTask({ shape: "migration" }), t2cfg, ch)).toThrow(RoutingError);
    expect(() => route(mkTask({ shape: "migration" }), t2cfg, ch)).toThrow(/tier>=frontier/);
  });
});

describe("OBS-30 autoPrefer routing", () => {
  const autoChannels: BillingChannel[] = [
    { adapter: "grok", vendor: "xai", model: "grok-4.5", channel: "sub", tier: "mid" },
    { adapter: "cursor-agent", vendor: "cursor", model: "composer-2.5", channel: "sub", tier: "mid" },
    { adapter: "codex", vendor: "openai", model: "gpt-5.6-terra", channel: "sub", tier: "mid" },
    { adapter: "opencode", vendor: "mixed", model: "zai-coding-plan/glm-5.2", channel: "sub", tier: "mid" },
  ];

  const freshAuto: RoutingPreferContext = {
    doctorFresh: true,
    overlayPreferShapes: new Set(),
    autoPrefer: {
      derivedAt: "2026-07-15T12:00:00.000Z",
      implement: ["grok", "cursor-agent"],
      tests: ["pi", "opencode"],
    },
  };

  test("autoPrefer for implement orders grok ahead of cursor-agent and omits codex", () => {
    const r = route(mkTask({ shape: "implement" }), cfg, autoChannels, undefined, freshAuto);
    expect(r.assignment).toMatchObject({ adapter: "grok", model: "grok-4.5" });
  });

  test("operator overlay prefer suppresses autoPrefer for that shape only", () => {
    const c2 = structuredClone(cfg);
    c2.routing.map.implement = { tier: "mid", prefer: ["codex", "cursor-agent"] };
    const preferCtx: RoutingPreferContext = {
      ...freshAuto,
      overlayPreferShapes: new Set(["implement"]),
    };
    const implement = route(mkTask({ shape: "implement" }), c2, autoChannels, undefined, preferCtx);
    expect(implement.assignment).toMatchObject({ adapter: "codex", model: "gpt-5.6-terra" });
    const tests = route(mkTask({ shape: "tests" }), c2, autoChannels, undefined, preferCtx);
    expect(tests.assignment.adapter).toBe("opencode");
  });

  test("absent or stale doctor context is byte-identical to seed routing", () => {
    const seed = route(mkTask({ shape: "implement" }), cfg, CH);
    const absent = route(mkTask({ shape: "implement" }), cfg, CH, undefined, { doctorFresh: false, overlayPreferShapes: new Set() });
    const stale = route(mkTask({ shape: "implement" }), cfg, CH, undefined, { doctorFresh: false, overlayPreferShapes: new Set(), autoPrefer: freshAuto.autoPrefer });
    expect(absent).toEqual(seed);
    expect(stale).toEqual(seed);
  });

  test("pins and deny behave exactly as before autoPrefer", () => {
    const pinned = route(mkTask({ shape: "plan" }), cfg, CH, undefined, freshAuto);
    expect(pinned.assignment).toMatchObject({ adapter: "claude-code", model: "fable" });
    const c2 = structuredClone(cfg);
    c2.routing.deny = { adapters: ["grok"] };
    expect(() => route(mkTask({ shape: "implement", routingHints: { pin: { via: "grok", model: "grok-4.5" } } }), c2, autoChannels, undefined, freshAuto))
      .toThrow(/disallowed/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v1.58 frontier spread (operator ruling 2026-07-18-frontier-spread-credits.md): tier-equal
// zero-marginal-cost frontier sub ties no longer fall to discovery order (fable-first) — a
// deterministic task-keyed rotation spreads them, and sol/k3-class channels serve frontier work
// as first-class candidates. Pins, denies, and explicit prefers keep precedence.
// ═══════════════════════════════════════════════════════════════════════════
describe("v1.58 frontier spread", () => {
  // the live frontier sub roster shape: two anthropic + two openai + one moonshot channel
  const FR: BillingChannel[] = [
    { adapter: "claude-code", vendor: "anthropic", model: "fable", channel: "sub", tier: "frontier" },
    { adapter: "claude-code", vendor: "anthropic", model: "opus", channel: "sub", tier: "frontier" },
    { adapter: "codex", vendor: "openai", model: "gpt-5.6-sol", channel: "sub", tier: "frontier" },
    { adapter: "codex", vendor: "openai", model: "gpt-5.5", channel: "sub", tier: "frontier" },
    { adapter: "kimi", vendor: "moonshot", model: "kimi-code/k3", channel: "sub", tier: "frontier" },
  ];
  const FR_KEYS = FR.map(channelKey).sort();

  test("frontier work spreads across tier equal sub channels instead of concentrating on one", () => {
    const winners = Array.from({ length: 12 }, (_, i) =>
      route(mkTask({ shape: "migration", id: `T${i + 1}`, goal: `migrate table ${i + 1}` }), cfg, FR).assignment);
    for (const w of winners) {
      expect(w.tier).toBe("frontier"); // the spread permutes the tie — it never leaves the floor
      expect(w.channel).toBe("sub");
    }
    const distinctChannels = new Set(winners.map(channelKey));
    const distinctAdapters = new Set(winners.map((w) => w.adapter));
    expect(distinctChannels.size).toBeGreaterThan(1); // no longer first-sub-channel-wins-every-time
    expect(distinctAdapters.size).toBeGreaterThan(1); // and the spread crosses vendors, not just models
  });

  test("every live frontier tier sub channel is admitted where a frontier floor applies", () => {
    // a below-floor mid channel rides along to prove admission ends exactly at the floor
    const withMid = [...FR, { adapter: "claude-code", vendor: "anthropic", model: "sonnet", channel: "sub", tier: "mid" } as BillingChannel];
    const ranked = rankCandidates(mkTask({ shape: "migration" }), cfg, withMid);
    expect(ranked).toHaveLength(withMid.length);
    const admitted = ranked.filter((c) => !c.belowFloor).map((c) => channelKey(c.assignment));
    expect(admitted.sort()).toEqual(FR_KEYS); // all five frontier subs admitted, nothing else
    // sol and k3 rank as first-class frontier candidates in the routed plan, ahead of any below-floor row
    expect(admitted).toContain("codex:gpt-5.6-sol");
    expect(admitted).toContain("kimi:kimi-code/k3");
    expect(ranked.at(-1)!).toMatchObject({ belowFloor: true, assignment: { model: "sonnet" } });
  });

  test("pins and denies and explicit prefers override the spread", () => {
    // precondition: the spread would NOT pick fable for this fixture task (otherwise the pin legs are vacuous)
    const unpinned = route(mkTask({ shape: "migration" }), cfg, FR).assignment;
    expect(channelKey(unpinned)).not.toBe("claude-code:fable");

    // task pin beats the spread
    const taskPin = route(mkTask({ shape: "migration", routingHints: { pin: { via: "claude-code", model: "fable" } } }), cfg, FR);
    expect(channelKey(taskPin.assignment)).toBe("claude-code:fable");
    // map pin beats the spread
    const c2 = structuredClone(cfg);
    c2.routing.map.migration = { pin: { via: "claude-code", model: "fable" } };
    expect(channelKey(route(mkTask({ shape: "migration" }), c2, FR).assignment)).toBe("claude-code:fable");

    // deny: a denied channel never serves, spread or not (deny filters discovery, as in production)
    const c3 = structuredClone(cfg);
    c3.routing.deny = { adapters: ["claude-code"] };
    const allowed = FR.filter((c) => disallowedBy(c, c3.routing) === null);
    const denied = route(mkTask({ shape: "migration" }), c3, allowed).assignment;
    expect(denied.adapter).not.toBe("claude-code");
    expect(denied.tier).toBe("frontier");

    // explicit prefer beats the spread: the preferred adapter wins, in the operator's entry order —
    // the spread never reorders inside a prefer band
    const c4 = structuredClone(cfg);
    c4.routing.map.migration = { prefer: ["kimi"] };
    const preferred = route(mkTask({ shape: "migration" }), c4, FR);
    expect(channelKey(preferred.assignment)).toBe("kimi:kimi-code/k3");
    expect(preferred.provenance).toContain("via prefer");
    const c5 = structuredClone(cfg);
    c5.routing.map.migration = { prefer: ["codex"] };
    // codex's two frontier subs tie inside the band; insertion order (sol first) holds, not the rotation
    expect(channelKey(route(mkTask({ shape: "migration" }), c5, FR).assignment)).toBe("codex:gpt-5.6-sol");
  });

  test("the spread reorders only frontier sub ties: mid ties and api ties keep discovery order", () => {
    // mid sub tie (three mid subs in CH): every task lands on the discovery-first channel
    for (let i = 1; i <= 5; i++) {
      const r = route(mkTask({ shape: "refactor", id: `T${i}`, goal: `refactor pass ${i}` }), cfg, CH);
      expect(channelKey(r.assignment)).toBe("claude-code:sonnet");
      expect(r.provenance).not.toContain("frontier spread");
    }
    // frontier API tie: metered channels are never zero marginal cost — no rotation
    const apis: BillingChannel[] = [
      { adapter: "a", vendor: "v", model: "m1", channel: "api", tier: "frontier" },
      { adapter: "b", vendor: "v", model: "m2", channel: "api", tier: "frontier" },
    ];
    for (let i = 1; i <= 5; i++) {
      expect(channelKey(route(mkTask({ shape: "migration", id: `T${i}`, goal: `migrate ${i}` }), cfg, apis).assignment)).toBe("a:m1");
    }
  });

  test("a spread-decided auto pick names the spread in provenance", () => {
    const r = route(mkTask({ shape: "migration" }), cfg, FR);
    expect(r.provenance).toContain("marginal-cost auto (via frontier spread)");
  });
});

describe("OBS-89 (v1.60): the retired quality env is inert in route()", () => {
  test("setting the quality environment variable before calling route directly has no effect on the resolved tier or floor", () => {
    // pre-rip, TICKMARKR_QUALITY=1 raised the advisory floor a band (implement mid→frontier) and
    // raised a task-hint floor too — every case below would have routed a higher tier with a
    // "→…(--quality)" bound in provenance
    const tasks = [
      mkTask({ shape: "implement" }), // advisory floor mid — the raise target the rip deleted
      mkTask({ shape: "migration" }), // advisory floor frontier — already top band
      mkTask({ shape: "chore", routingHints: { floor: "mid", source: "obs-89 fixture" } }), // task-hint floor
    ];
    const baseline = tasks.map((t) => route(t, cfg, CH));
    process.env.TICKMARKR_QUALITY = "1";
    try {
      tasks.forEach((t, i) => {
        const r = route(t, cfg, CH);
        expect(r.assignment.tier).toBe(baseline[i].assignment.tier);
        expect(r.provenance).toBe(baseline[i].provenance); // the floor bound is named here — no raise, no (--quality)
        expect(r).toEqual(baseline[i]);
      });
    } finally {
      delete process.env.TICKMARKR_QUALITY;
    }
  });

  test("no source file references the quality environment variable name outside of a historical comment or test fixture", () => {
    // Sweep every file under src/ with comments stripped. After the OBS-89 rip nothing READS the
    // retired TICKMARKR_QUALITY variable; the sole surviving non-comment reference in src is the
    // inert scrub-target constant declaration in src/route/router.ts, kept only so the spawn seam
    // (src/run/git.ts) goes on erasing a stale operator shell's legacy export from child
    // environments — a retired-seam contract pinned by test fixtures (tests/run/git.test.ts,
    // tests/setup.ts, tests/gates/baseline.test.ts) that import the constant. Anything beyond that
    // single declaration — above all any process.env read of the name — fails this sweep.
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const srcFiles = readdirSync("src", { recursive: true })
      .map(String).filter((f) => f.endsWith(".ts")).map((f) => join("src", f));
    const stripped = new Map(srcFiles.map((f) => [f, stripComments(readFileSync(f, "utf8"))]));
    // (a) no src file reads the variable — neither by literal nor through the constant
    for (const [f, code] of stripped) {
      expect(code, f).not.toMatch(/process\.env\s*(\.\s*TICKMARKR_QUALITY|\[\s*(QUALITY_ENV|["']TICKMARKR_QUALITY["'])\s*\])/);
    }
    // (b) outside comments the name survives in exactly one place: the scrub-target declaration
    const refs = [...stripped].filter(([, code]) => code.includes("TICKMARKR_QUALITY")).map(([f]) => f);
    expect(refs).toEqual([join("src", "route", "router.ts")]);
    const routerCode = stripped.get(join("src", "route", "router.ts"))!;
    expect(routerCode.match(/TICKMARKR_QUALITY/g)).toHaveLength(1);
    expect(routerCode).toContain(`export const QUALITY_ENV = "TICKMARKR_QUALITY";`);
  });
});
