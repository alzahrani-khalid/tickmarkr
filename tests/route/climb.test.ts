import { describe, expect, test } from "vitest";
import { type BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, type TickmarkrConfig, type Tier } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { ProfileCell, RoutingProfile } from "../../src/route/profile.js";
import { climbChannel, nextChannel } from "../../src/route/router.js";

const cfg: TickmarkrConfig = structuredClone(DEFAULT_CONFIG);

const mkTask = (shape = "implement") =>
  validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"] }],
  }).tasks[0];

const cur = (tier: Tier, adapter = "ma", model = "mid-sub"): { adapter: string; model: string; channel: "sub"; tier: Tier } =>
  ({ adapter, model, channel: "sub", tier });

// Fleet spanning tiers with distinct vendors so an adapter exclusion isolates only its own provider
const FLEET: BillingChannel[] = [
  { adapter: "ca", vendor: "v-ca", model: "cheap-sub", channel: "sub", tier: "cheap" },
  { adapter: "cb", vendor: "v-cb", model: "cheap-api", channel: "api", tier: "cheap" },
  { adapter: "ma", vendor: "v-ma", model: "mid-sub", channel: "sub", tier: "mid" },
  { adapter: "mb", vendor: "v-mb", model: "mid-api", channel: "api", tier: "mid" },
  { adapter: "fa", vendor: "v-fa", model: "front-sub", channel: "sub", tier: "frontier" },
  { adapter: "fb", vendor: "v-fb", model: "front-api", channel: "api", tier: "frontier" },
];

describe("OBS-986: router climbChannel (ES-1)", () => {
  test("test: climbChannel from a mid assignment with untried frontier channels returns the cheapest frontier channel flagged climbed, from a frontier assignment returns the router's existing same-or-higher failover pick flagged not climbed naming no higher tier, and with every frontier channel already tried returns the same-band pick flagged not climbed, so a climb that stays in band without saying so fails", () => {
    const task = mkTask("implement");
    const currentMid = cur("mid", "ma", "mid-sub");

    // 1. Mid assignment with untried frontier channels: climbs to cheapest frontier channel
    const climbedRes = climbChannel(currentMid, task, cfg, FLEET, ["ma:mid-sub"]);
    expect(climbedRes).not.toBeNull();
    expect(climbedRes!.climbed).toBe(true);
    expect(climbedRes!.tier).toBe("frontier");
    expect(climbedRes!.model).toBe("front-sub"); // sub (cost 0) < api (cost 3)
    expect(climbedRes!.adapter).toBe("fa");
    expect(climbedRes!.reason).toBeUndefined();
    expect(climbedRes!.assignment).toEqual({
      adapter: "fa",
      model: "front-sub",
      channel: "sub",
      tier: "frontier",
    });

    // 2. From a frontier assignment: returns existing same-or-higher failover pick flagged not climbed naming no higher tier
    const currentFrontier = cur("frontier", "fa", "front-sub");
    const existingFrontierFailover = nextChannel(currentFrontier, task, cfg, FLEET, ["fa:front-sub"]);
    expect(existingFrontierFailover).not.toBeNull();
    expect(existingFrontierFailover!.model).toBe("front-api");

    const frontierRes = climbChannel(currentFrontier, task, cfg, FLEET, ["fa:front-sub"]);
    expect(frontierRes).not.toBeNull();
    expect(frontierRes!.climbed).toBe(false);
    expect(frontierRes!.adapter).toBe(existingFrontierFailover!.adapter);
    expect(frontierRes!.model).toBe(existingFrontierFailover!.model);
    expect(frontierRes!.tier).toBe(existingFrontierFailover!.tier);
    expect(frontierRes!.reason).toMatch(/no higher tier/i);

    // 3. With every frontier channel already tried: returns same-band pick flagged not climbed
    const triedAllFrontier = ["ma:mid-sub", "fa:front-sub", "fb:front-api"];
    const existingSameBand = nextChannel(currentMid, task, cfg, FLEET, triedAllFrontier);
    expect(existingSameBand).not.toBeNull();
    expect(existingSameBand!.tier).toBe("mid");
    expect(existingSameBand!.model).toBe("mid-api");

    const sameBandRes = climbChannel(currentMid, task, cfg, FLEET, triedAllFrontier);
    expect(sameBandRes).not.toBeNull();
    expect(sameBandRes!.climbed).toBe(false);
    expect(sameBandRes!.adapter).toBe(existingSameBand!.adapter);
    expect(sameBandRes!.model).toBe(existingSameBand!.model);
    expect(sameBandRes!.tier).toBe("mid");
    expect(sameBandRes!.reason).toMatch(/no higher tier/i);
  });

  test("test: climbChannel with routing.escalateTier off returns exactly the router's existing same-or-higher failover pick flagged not climbed naming the knob while the same fleet with the knob on climbs to frontier, so a knob that does not gate the climb fails", () => {
    const task = mkTask("implement");
    const currentMid = cur("mid", "ma", "mid-sub");
    const tried = ["ma:mid-sub"];

    const cfgOff: TickmarkrConfig = {
      ...cfg,
      routing: { ...cfg.routing, escalateTier: "off" },
    };
    const cfgOn: TickmarkrConfig = {
      ...cfg,
      routing: { ...cfg.routing, escalateTier: "on" },
    };

    // With knob off: returns existing same-or-higher failover pick flagged not climbed naming the knob
    const existingPick = nextChannel(currentMid, task, cfgOff, FLEET, tried);
    expect(existingPick).not.toBeNull();
    expect(existingPick!.tier).toBe("mid"); // nextChannel stays in mid band

    const offRes = climbChannel(currentMid, task, cfgOff, FLEET, tried);
    expect(offRes).not.toBeNull();
    expect(offRes!.climbed).toBe(false);
    expect(offRes!.adapter).toBe(existingPick!.adapter);
    expect(offRes!.model).toBe(existingPick!.model);
    expect(offRes!.channel).toBe(existingPick!.channel);
    expect(offRes!.tier).toBe(existingPick!.tier);
    expect(offRes!.reason).toMatch(/escalateTier|knob/i);

    // With knob on: same fleet climbs to frontier
    const onRes = climbChannel(currentMid, task, cfgOn, FLEET, tried);
    expect(onRes).not.toBeNull();
    expect(onRes!.climbed).toBe(true);
    expect(onRes!.tier).toBe("frontier");
    expect(onRes!.model).toBe("front-sub");
  });

  test("climbChannel from cheap climbs to cheapest mid channel", () => {
    const task = mkTask("implement");
    const currentCheap = cur("cheap", "ca", "cheap-sub");
    const res = climbChannel(currentCheap, task, cfg, FLEET, ["ca:cheap-sub"]);
    expect(res).not.toBeNull();
    expect(res!.climbed).toBe(true);
    expect(res!.tier).toBe("mid");
    expect(res!.model).toBe("mid-sub");
  });

  test("climbChannel learnedScore tie-break within equal higher-tier and equal marginal cost", () => {
    const shape = "implement";
    const task = mkTask(shape);
    const f1: BillingChannel = { adapter: "fake", vendor: "v-f1", model: "f1", channel: "sub", tier: "frontier" };
    const f2: BillingChannel = { adapter: "fake", vendor: "v-f2", model: "f2", channel: "sub", tier: "frontier" };
    const fleetWithEqualFrontier: BillingChannel[] = [
      { adapter: "m", vendor: "v-m", model: "m1", channel: "sub", tier: "mid" },
      f1,
      f2,
    ];

    // Discovery order is f1 first. With warm score on f2, f2 wins
    const warm: ProfileCell = { n: 6, qSum: 6, dispatches: 6, doneCount: 0, quotaHits: 0 };
    const profile: RoutingProfile = {
      cells: new Map([[`${shape}|fake:f2|sub`, warm]]),
    };

    const res = climbChannel(cur("mid", "m", "m1"), task, cfg, fleetWithEqualFrontier, ["m:m1"], profile);
    expect(res).not.toBeNull();
    expect(res!.climbed).toBe(true);
    expect(res!.model).toBe("f2");
  });

  test("climbChannel respects exclude set", () => {
    const task = mkTask("implement");
    const currentMid = cur("mid", "ma", "mid-sub");
    const exclude = new Set(["fa:front-sub"]);
    const res = climbChannel(currentMid, task, cfg, FLEET, ["ma:mid-sub"], undefined, exclude);
    expect(res).not.toBeNull();
    expect(res!.climbed).toBe(true);
    expect(res!.model).toBe("front-api"); // fa:front-sub was excluded, picks fb:front-api
  });

  test("climbChannel returns null when no channels exist in fleet", () => {
    const task = mkTask("implement");
    const currentMid = cur("mid", "ma", "mid-sub");
    const currentFrontier = cur("frontier", "fa", "front-sub");
    const cfgOff: TickmarkrConfig = {
      ...cfg,
      routing: { ...cfg.routing, escalateTier: "off" },
    };
    expect(climbChannel(currentMid, task, cfg, [], [])).toBeNull();
    expect(climbChannel(currentFrontier, task, cfg, [], [])).toBeNull();
    expect(climbChannel(currentMid, task, cfgOff, [], [])).toBeNull();
  });
});
