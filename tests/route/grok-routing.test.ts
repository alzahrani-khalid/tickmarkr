import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { allAdapters, discoverChannels } from "../../src/adapters/registry.js";
import { type AuthHealth, channelKey } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config/config.js";
import { grok } from "../../src/adapters/grok.js";
import { validateGraph } from "../../src/graph/schema.js";
import { route, RoutingError } from "../../src/route/router.js";
import { authedModels } from "../helpers/tmprepo.js";

// GROK-04 routing oracles. All fixture-only — the real grok binary is never spawned (zero-token).

function repoWithOverlay(yaml: string, globalDir?: string) {
  const gDir = globalDir ?? mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return { repo, globalDir: gDir };
}

const emptyRepo = () => ({ repo: mkdtempSync(join(tmpdir(), "tickmarkr-r-")), globalDir: mkdtempSync(join(tmpdir(), "tickmarkr-g-")) });

const mkTask = (shape: string) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"] }],
  }).tasks[0];

const adapters = allAdapters().filter((a) => a.id !== "fake");
const allHealthy = (): Record<string, AuthHealth> =>
  Object.fromEntries(adapters.map((a) => [a.id, { installed: true, authed: true, modelAuth: authedModels(a.channels(DEFAULT_CONFIG).map((c) => c.model)) }]));

describe("GROK-04 routing — discovery, deny, pin, coexistence, vendor, routability", () => {
  test("R1: all-healthy defaults ⇒ discovery contains grok:grok-4.5 (mid) + grok:grok-composer-2.5-fast (cheap)", () => {
    const { repo, globalDir } = emptyRepo();
    const cfg = loadConfig(repo, { globalDir });
    const channels = discoverChannels(cfg, adapters, allHealthy());
    expect(channels).toContainEqual(expect.objectContaining({ adapter: "grok", model: "grok-4.5", tier: "mid", channel: "sub" }));
    expect(channels).toContainEqual(expect.objectContaining({ adapter: "grok", model: "grok-composer-2.5-fast", tier: "cheap", channel: "sub" }));
  });

  test("R2: routing.deny adapters:[grok] ⇒ zero grok channels in discovery", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  deny:\n    adapters: [grok]\n");
    const cfg = loadConfig(repo, { globalDir });
    const channels = discoverChannels(cfg, adapters, allHealthy());
    expect(channels.filter((c) => c.adapter === "grok")).toEqual([]);
    // sanity: other adapters still present
    expect(channels.some((c) => c.adapter === "claude-code")).toBe(true);
  });

  test("R3: denying grok + a map pin to grok/grok-4.5 ⇒ route() throws RoutingError (fails LOUD)", () => {
    const { repo, globalDir } = repoWithOverlay(
      "routing:\n  deny:\n    adapters: [grok]\n  map:\n    chore:\n      pin: { via: grok, model: grok-4.5 }\n",
    );
    const cfg = loadConfig(repo, { globalDir });
    const channels = discoverChannels(cfg, adapters, allHealthy());
    expect(() => route(mkTask("chore"), cfg, channels)).toThrow(RoutingError);
    try {
      route(mkTask("chore"), cfg, channels);
    } catch (e) {
      expect((e as RoutingError).message).toMatch(/grok:grok-4\.5/);
      expect((e as RoutingError).message).toMatch(/routing\.deny/);
    }
  });

  test("R4: coexistence — cursor-agent xhigh seeds retired; native grok:grok-4.5 remains (D-06)", () => {
    const { repo, globalDir } = emptyRepo();
    const cfg = loadConfig(repo, { globalDir });
    const channels = discoverChannels(cfg, adapters, allHealthy());
    // v1.25 T3: cursor-agent no longer seeds grok-4.5-xhigh / grok-4.5-fast-xhigh (CLI dropped the ids)
    expect(channels.find((c) => c.adapter === "cursor-agent" && c.model === "grok-4.5-xhigh")).toBeUndefined();
    expect(channels.find((c) => c.adapter === "cursor-agent" && c.model === "grok-4.5-fast-xhigh")).toBeUndefined();
    expect("grok-4.5-xhigh" in DEFAULT_CONFIG.tiers["cursor-agent"].models).toBe(false);
    expect("grok-4.5-fast-xhigh" in DEFAULT_CONFIG.tiers["cursor-agent"].models).toBe(false);
    // native grok adapter seeds are a DIFFERENT channel and stay
    const native = channels.find((c) => c.adapter === "grok" && c.model === "grok-4.5");
    expect(native).toBeTruthy();
    expect(channelKey(native!)).toBe("grok:grok-4.5");
    expect(DEFAULT_CONFIG.tiers.grok.models["grok-4.5"]).toBe("mid");
    // cursor-agent still has its own mid seed
    expect(channels.find((c) => c.adapter === "cursor-agent" && c.model === "composer-2.5")).toBeTruthy();
  });

  test("R5: vendor honesty — grok.vendor === 'xai' === DEFAULT_CONFIG.tiers.grok.vendor (FLEET-04)", () => {
    expect(grok.vendor).toBe("xai");
    expect(DEFAULT_CONFIG.tiers.grok.vendor).toBe("xai");
    expect(grok.vendor).toBe(DEFAULT_CONFIG.tiers.grok.vendor);
  });

  test("R6: routability — map implement prefer:[grok] ⇒ route assigns grok:grok-4.5 (SC-4)", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  map:\n    implement:\n      prefer: [grok]\n");
    const cfg = loadConfig(repo, { globalDir });
    const channels = discoverChannels(cfg, adapters, allHealthy());
    const r = route(mkTask("implement"), cfg, channels);
    expect(r.assignment).toMatchObject({ adapter: "grok", model: "grok-4.5" });
  });
});
