import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { allAdapters, discoverChannels } from "../../src/adapters/registry.js";
import { type AuthHealth, type BillingChannel, channelKey, channelsFromConfig } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, loadConfig, type TickmarkrConfig } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import { disallowedBy, preferRanks } from "../../src/route/preference.js";
import { nextChannel, route, RoutingError } from "../../src/route/router.js";
import { authedModels } from "../helpers/tmprepo.js";

function repoWithOverlay(yaml: string, globalDir?: string) {
  const gDir = globalDir ?? mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return { repo, globalDir: gDir };
}

const emptyRepo = () => ({ repo: mkdtempSync(join(tmpdir(), "tickmarkr-r-")), globalDir: mkdtempSync(join(tmpdir(), "tickmarkr-g-")) });

const channelsOf = (cfg: TickmarkrConfig): BillingChannel[] =>
  allAdapters().map((a) => a.id).filter((id) => id !== "fake").flatMap((id) => channelsFromConfig(id, cfg));

const mkTask = (shape: string, extra: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"], ...extra }],
  }).tasks[0];

const allHealthy = (): Record<string, AuthHealth> =>
  Object.fromEntries(allAdapters().filter((a) => a.id !== "fake").map((a) => [a.id, { installed: true, authed: true, modelAuth: authedModels(a.channels(DEFAULT_CONFIG).map((c) => c.model)) }]));

describe("FLEET-06/07 preference oracles (V-3..V-8)", () => {
  const adapters = allAdapters().filter((a) => a.id !== "fake");
  const health = allHealthy();

  test("V-3: deny adapters filters discovery; allow adapters keeps only that adapter", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  deny:\n    adapters: [pi]\n");
    const cfg = loadConfig(repo, { globalDir });
    const baseline = channelsOf(cfg);
    const filtered = discoverChannels(cfg, adapters, health);
    expect(filtered).toEqual(baseline.filter((c) => c.adapter !== "pi"));
    expect(filtered.every((c) => c.adapter !== "pi")).toBe(true);

    const { repo: repo2, globalDir: g2 } = repoWithOverlay("routing:\n  allow:\n    adapters: [claude-code]\n");
    const cfg2 = loadConfig(repo2, { globalDir: g2 });
    const allowed = discoverChannels(cfg2, adapters, health);
    expect(allowed.every((c) => c.adapter === "claude-code")).toBe(true);
    expect(allowed.length).toBeGreaterThan(0);
  });

  test("V-4: denied task pin THROWS RoutingError (never degrades)", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  deny:\n    models: [codex:gpt-5.5]\n");
    const cfg = loadConfig(repo, { globalDir });
    const channels = discoverChannels(cfg, adapters, health);
    const t = mkTask("implement", { routingHints: { pin: { via: "codex", model: "gpt-5.5" } } });
    expect(() => route(t, cfg, channels)).toThrow(RoutingError);
    try {
      route(t, cfg, channels);
    } catch (e) {
      const msg = (e as RoutingError).message;
      expect(msg).toMatch(/codex:gpt-5\.5/);
      expect(msg).toMatch(/routing\.deny/);
      expect(msg).not.toMatch(/degrading/);
    }
    const r = (() => { try { return route(t, cfg, channels); } catch { return null; } })();
    expect(r).toBeNull();
  });

  test("V-5: denied map pin throws with routing.deny (not doctor-found alone)", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  deny:\n    adapters: [claude-code]\n");
    const cfg = loadConfig(repo, { globalDir });
    const channels = discoverChannels(cfg, adapters, health);
    expect(() => route(mkTask("plan"), cfg, channels)).toThrow(RoutingError);
    try {
      route(mkTask("plan"), cfg, channels);
    } catch (e) {
      const msg = (e as RoutingError).message;
      expect(msg).toMatch(/claude-code:fable/);
      expect(msg).toMatch(/routing\.deny/);
    }
  });

  test("V-6: denied prefer entries throw; unknown prefer stays silent no-op", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  deny:\n    adapters: [cursor-agent, codex]\n");
    const cfg = loadConfig(repo, { globalDir });
    const channels = discoverChannels(cfg, adapters, health);
    expect(() => route(mkTask("implement"), cfg, channels)).toThrow(RoutingError);
    try {
      route(mkTask("implement"), cfg, channels);
    } catch (e) {
      expect((e as RoutingError).message).toMatch(/routing\.deny/);
    }

    const { repo: repo0, globalDir: g0 } = emptyRepo();
    const cfgNoDeny = loadConfig(repo0, { globalDir: g0 });
    const c2 = structuredClone(cfgNoDeny);
    c2.routing.map.implement = { tier: "mid", prefer: ["gemini", "cursor-agent"] };
    expect(() => route(mkTask("implement"), c2, channelsOf(c2))).not.toThrow();
  });

  test("V-7: allowed pin still routes when deny misses the pin", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  deny:\n    models: [something-else]\n");
    const cfg = loadConfig(repo, { globalDir });
    const channels = discoverChannels(cfg, adapters, health);
    const t = mkTask("implement", { routingHints: { pin: { via: "codex", model: "gpt-5.5" } } });
    expect(route(t, cfg, channels).assignment).toMatchObject({ adapter: "codex", model: "gpt-5.5" });

    const { repo: repo2, globalDir: g2 } = repoWithOverlay("routing:\n  allow:\n    adapters: [codex]\n");
    const cfg2 = loadConfig(repo2, { globalDir: g2 });
    const channels2 = discoverChannels(cfg2, adapters, health);
    expect(route(t, cfg2, channels2).assignment).toMatchObject({ adapter: "codex", model: "gpt-5.5" });
  });

  test("V-8: empty allow fail-closed — discovery empty, route names routing.allow", () => {
    for (const yaml of ["routing:\n  allow: {}\n", "routing:\n  allow:\n    adapters: []\n"]) {
      const { repo, globalDir } = repoWithOverlay(yaml);
      const cfg = loadConfig(repo, { globalDir });
      expect(discoverChannels(cfg, adapters, health)).toEqual([]);
      expect(() => route(mkTask("chore"), cfg, [])).toThrow(RoutingError);
      try {
        route(mkTask("chore"), cfg, []);
      } catch (e) {
        const msg = (e as RoutingError).message;
        expect(msg).toMatch(/routing\.allow|routing\.deny|excluded/);
      }
    }
  });

  test("containment: nextChannel never returns a denied channel on filtered list", () => {
    const { repo, globalDir } = emptyRepo();
    const cfgBase = loadConfig(repo, { globalDir });
    const unfiltered = adapters.flatMap((a) => channelsFromConfig(a.id, cfgBase));
    const current = { adapter: "claude-code", model: "haiku", channel: "sub" as const, tier: "cheap" as const };
    const tried = [channelKey(current)];
    const nextUnfiltered = nextChannel(current, mkTask("implement"), cfgBase, unfiltered, tried);
    expect(nextUnfiltered).toBeTruthy();
    const denied = channelKey(nextUnfiltered!);
    const { repo: repo2, globalDir: g2 } = repoWithOverlay(`routing:\n  deny:\n    models: [${denied}]\n`);
    const cfg = loadConfig(repo2, { globalDir: g2 });
    const filtered = discoverChannels(cfg, adapters, health);
    expect(filtered.some((c) => channelKey(c) === denied)).toBe(false);
    const nextFiltered = nextChannel(current, mkTask("implement"), cfg, filtered, tried);
    if (nextFiltered) expect(disallowedBy(nextFiltered, cfg.routing)).toBeNull();
    expect(channelKey(nextFiltered ?? { adapter: "", model: "" })).not.toBe(denied);
  });

  test("parity: unset allow/deny — discoverChannels and route byte-identical to baseline", () => {
    const { repo, globalDir } = emptyRepo();
    const cfg = loadConfig(repo, { globalDir });
    const baseline = adapters.flatMap((a) => channelsFromConfig(a.id, cfg));
    expect(discoverChannels(cfg, adapters, health)).toEqual(baseline);
    const channels = discoverChannels(cfg, adapters, health);
    expect(route(mkTask("implement"), cfg, channels).assignment).toEqual(
      route(mkTask("implement"), cfg, channelsOf(cfg)).assignment,
    );
  });
});

describe("T4 deny.models + prefer rank", () => {
  const adapters = allAdapters().filter((a) => a.id !== "fake");
  const health = allHealthy();

  test("deny.models benches one model while its tier entry stays intact (round-trips; re-enable is one-line deletion)", () => {
    // bench a single channel key without touching the tiers entry
    const { repo, globalDir } = repoWithOverlay("routing:\n  deny:\n    models: [pi:zai/glm-5.2]\n");
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.tiers.pi.models["zai/glm-5.2"]).toBe("mid"); // tier entry intact
    expect(disallowedBy({ adapter: "pi", model: "zai/glm-5.2" }, cfg.routing)).toEqual({ by: "deny", entry: "pi:zai/glm-5.2" });
    const filtered = discoverChannels(cfg, adapters, health);
    expect(filtered.some((c) => c.adapter === "pi" && c.model === "zai/glm-5.2")).toBe(false); // no BillingChannel
    expect(filtered.some((c) => c.adapter !== "pi" || c.model !== "zai/glm-5.2")).toBe(true); // fleet still alive

    // re-enable = a one-line deletion of the deny block; tier entry was never touched, so routing restores
    const { repo: repo2, globalDir: g2 } = emptyRepo();
    const cfg2 = loadConfig(repo2, { globalDir: g2 });
    expect(cfg2.tiers.pi.models["zai/glm-5.2"]).toBe("mid");
    expect(disallowedBy({ adapter: "pi", model: "zai/glm-5.2" }, cfg2.routing)).toBeNull();
    expect(discoverChannels(cfg2, adapters, health).some((c) => c.adapter === "pi" && c.model === "zai/glm-5.2")).toBe(true);
  });

  test("deny.models composes with deny.adapters; both kinds excluded", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  deny:\n    adapters: [codex]\n    models: [pi:zai/glm-5.2]\n");
    const cfg = loadConfig(repo, { globalDir });
    const filtered = discoverChannels(cfg, adapters, health);
    expect(filtered.every((c) => c.adapter !== "codex")).toBe(true);
    expect(filtered.every((c) => !(c.adapter === "pi" && c.model === "zai/glm-5.2"))).toBe(true);
    // other adapters survive both rules
    expect(filtered.some((c) => c.adapter === "claude-code")).toBe(true);
  });

  test("preferRanks: shapes+indices where a channel is preferred; empty when not a prefer target", () => {
    const { repo, globalDir } = emptyRepo();
    const cfg = loadConfig(repo, { globalDir });
    // default map: implement prefer [cursor-agent, codex], tests prefer [opencode]
    expect(preferRanks({ adapter: "cursor-agent", model: "composer-2.5" }, cfg)).toEqual([{ shape: "implement", rank: 0 }]);
    expect(preferRanks({ adapter: "codex", model: "gpt-5.5" }, cfg)).toEqual([{ shape: "implement", rank: 1 }]);
    expect(preferRanks({ adapter: "opencode", model: "zai-coding-plan/glm-5.2" }, cfg)).toEqual([{ shape: "tests", rank: 0 }]);
    // claude-code:fable is PINNED (plan/spec), never preferred → empty
    expect(preferRanks({ adapter: "claude-code", model: "fable" }, cfg)).toEqual([]);
    // a channel-key prefer entry matches too
    const c2 = structuredClone(cfg);
    c2.routing.map.implement = { tier: "mid", prefer: ["pi:zai/glm-5.2"] };
    expect(preferRanks({ adapter: "pi", model: "zai/glm-5.2" }, c2)).toEqual([{ shape: "implement", rank: 0 }]);
  });
});
