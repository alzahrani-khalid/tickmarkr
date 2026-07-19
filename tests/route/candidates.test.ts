import { describe, expect, test } from "vitest";
import { type BillingChannel, channelKey } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, type TickmarkrConfig } from "../../src/config/config.js";
import { SHAPES, validateGraph } from "../../src/graph/schema.js";
import { rankCandidates } from "../../src/route/candidates.js";
import { buildProfile, type ProfileRow } from "../../src/route/profile.js";
import { route } from "../../src/route/router.js";

const CH: BillingChannel[] = [
  { adapter: "claude-code", vendor: "anthropic", model: "fable", channel: "sub", tier: "frontier" },
  { adapter: "claude-code", vendor: "anthropic", model: "sonnet", channel: "sub", tier: "mid" },
  { adapter: "codex", vendor: "openai", model: "gpt-5.6-terra", channel: "sub", tier: "mid" },
  { adapter: "cursor-agent", vendor: "cursor", model: "composer-2.5", channel: "sub", tier: "mid" },
  { adapter: "opencode", vendor: "mixed", model: "moonshotai/kimi-k2", channel: "api", tier: "cheap" },
];

const cfg: TickmarkrConfig = structuredClone(DEFAULT_CONFIG);

const mkTask = (shape: string, over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"], ...over }],
  }).tasks[0];

// house convention (learned.test.ts): warm = done rows, n ≥ MIN_SAMPLES so the learned score is live
const warmRows = (shape: string, adapter: string, model: string, n = 6): ProfileRow[] =>
  Array.from({ length: n }, () => ({
    shape, adapter, model, channel: "sub" as const, attempts: 1, outcome: "done" as const,
    durationMs: 1000, gateFails: 0, consults: 0,
  }));

// under-cap evidence (explore.test.ts convention): gate-fail parks ⇒ score 0, dispatches=n < cap ⇒ probe-worthy
const badRows = (shape: string, adapter: string, model: string, n: number): ProfileRow[] =>
  Array.from({ length: n }, () => ({
    shape, adapter, model, channel: "sub" as const, attempts: 1, outcome: "human" as const,
    parkKind: "gate-fail" as const, durationMs: 1000, gateFails: 1, consults: 0,
  }));

describe("rankCandidates: production-route iteration seam (v1.56 T1)", () => {
  test("the first ranked candidate equals the routed winner for every shape", () => {
    for (const shape of SHAPES) {
      const t = mkTask(shape);
      const ranked = rankCandidates(t, cfg, CH);
      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked[0].assignment).toEqual(route(t, cfg, CH).assignment);
    }
  });

  test("every ranked candidate carries a why line from route provenance", () => {
    for (const shape of SHAPES) {
      const t = mkTask(shape);
      const ranked = rankCandidates(t, cfg, CH);
      for (const c of ranked) {
        // provenance lines always name the deciding authority: a pin, a floor bound, or the auto path
        expect(c.why).toMatch(/pin |marginal-cost auto/);
      }
      expect(ranked[0].why).toBe(route(t, cfg, CH).provenance);
    }
  });

  test("channels below the advisory floor rank after all eligible candidates and are marked below floor", () => {
    // ui floor is mid; the lone cheap channel (opencode kimi) is below it
    const ranked = rankCandidates(mkTask("ui"), cfg, CH);
    expect(ranked).toHaveLength(CH.length);
    const firstBelow = ranked.findIndex((c) => c.belowFloor);
    expect(firstBelow).toBeGreaterThan(0);
    for (const [i, c] of ranked.entries()) expect(c.belowFloor).toBe(i >= firstBelow);
    expect(ranked.at(-1)!.assignment).toMatchObject({ adapter: "opencode", model: "moonshotai/kimi-k2" });
    expect(ranked.at(-1)!.belowFloor).toBe(true);
  });

  test("ranking disables exploration so repeated calls return the same order", () => {
    // warm haiku vs under-cap luna in a static tie (both cheap subs on chore): with exploration ON
    // the under-cap channel probes ahead; the ranking must instead pin the no-explore winner.
    const cheap: BillingChannel[] = [
      { adapter: "claude-code", vendor: "anthropic", model: "haiku", channel: "sub", tier: "cheap" },
      { adapter: "codex", vendor: "openai", model: "gpt-5.6-luna", channel: "sub", tier: "cheap" },
    ];
    const profile = buildProfile([
      ...warmRows("chore", "claude-code", "haiku", 6),
      ...badRows("chore", "codex", "gpt-5.6-luna", 2),
    ]);
    const t = mkTask("chore");
    const explored = route(t, cfg, cheap, profile);
    const noExplore = route(t, cfg, cheap, profile, undefined, undefined, { noExplore: true });
    // the fixture is only probative if exploration would actually flip the winner
    expect(explored.assignment).not.toEqual(noExplore.assignment);
    const ranked = rankCandidates(t, cfg, cheap, profile);
    expect(ranked[0].assignment).toEqual(noExplore.assignment);
    expect(ranked).toEqual(rankCandidates(t, cfg, cheap, profile));
    expect(ranked.map((c) => channelKey(c.assignment))).toEqual(["claude-code:haiku", "codex:gpt-5.6-luna"]);
  });

  test("a map-pinned shape ranks the pin first with pin provenance", () => {
    // plan carries the claude-code:fable map pin per seed; excluding a map pin is fail-loud in
    // route, so ranking stops after the pinned winner — the picker still shows the operator truth
    const ranked = rankCandidates(mkTask("plan"), cfg, CH);
    expect(ranked[0].assignment).toMatchObject({ adapter: "claude-code", model: "fable" });
    expect(ranked[0].why).toMatch(/pin claude-code:fable/);
  });
});
