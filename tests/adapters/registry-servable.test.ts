import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { allAdapters, discoverChannels, doctorAgeMs, servabilityLine, servableExclusions, writeDoctor } from "../../src/adapters/registry.js";
import { type AuthHealth } from "../../src/adapters/types.js";
import { loadConfig } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import { pickReviewer } from "../../src/gates/review.js";
import { route, RoutingError } from "../../src/route/router.js";
import { authedModels } from "../helpers/tmprepo.js";

function emptyRepo() {
  return { repo: mkdtempSync(join(tmpdir(), "tickmarkr-r-")), globalDir: mkdtempSync(join(tmpdir(), "tickmarkr-g-")) };
}

function repoWithOverlay(yaml: string) {
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return { repo, globalDir };
}

const mkTask = (shape: string) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"] }],
  }).tasks[0];

const piHealthServable = (cfg: ReturnType<typeof loadConfig>): Record<string, AuthHealth> => {
  const adapters = allAdapters().filter((a) => a.id !== "fake");
  return Object.fromEntries(adapters.map((a) => [
    a.id,
    a.id === "pi"
      ? { installed: true, authed: true, models: [], servable: ["zai/glm-5.2"], modelAuth: authedModels(a.channels(cfg).map((c) => c.model)) }
      : { installed: true, authed: true, models: [], modelAuth: authedModels(a.channels(cfg).map((c) => c.model)) },
  ]));
};

const piOverlayCfg = () => {
  const { repo, globalDir } = repoWithOverlay(`tiers:
  pi:
    vendor: zhipu
    channel: sub
    models:
      zai/glm-5.2: mid
      anthropic/claude-opus-4-5: frontier
`);
  return { cfg: loadConfig(repo, { globalDir }), repo, globalDir };
};

describe("HYG-05 discoverChannels servable intersection", () => {
  const adapters = allAdapters().filter((a) => a.id !== "fake");

  test("HYG-05: an unservable pi channel is never advertised", () => {
    const { cfg } = piOverlayCfg();
    const health = piHealthServable(cfg);
    const channels = discoverChannels(cfg, adapters, health);
    const piChannels = channels.filter((c) => c.adapter === "pi");
    expect(piChannels).toHaveLength(1);
    expect(piChannels[0]).toMatchObject({ adapter: "pi", model: "zai/glm-5.2" });
    expect(piChannels.some((c) => c.model === "anthropic/claude-opus-4-5")).toBe(false);
  });

  test("HYG-05: pin to unservable pi model throws RoutingError before dispatch", () => {
    const { repo, globalDir } = repoWithOverlay(`routing:
  map:
    plan:
      pin:
        via: pi
        model: anthropic/claude-opus-4-5
tiers:
  pi:
    vendor: zhipu
    channel: sub
    models:
      zai/glm-5.2: mid
      anthropic/claude-opus-4-5: frontier
`);
    const cfg = loadConfig(repo, { globalDir });
    const health = piHealthServable(cfg);
    const channels = discoverChannels(cfg, adapters, health);
    expect(() => route(mkTask("plan"), cfg, channels)).toThrow(RoutingError);
    try {
      route(mkTask("plan"), cfg, channels);
    } catch (e) {
      expect((e as RoutingError).message).toMatch(/pinned pi:anthropic\/claude-opus-4-5 not available/);
    }
  });

  test("HYG-05: pickReviewer still resolves pi under realistic servable", () => {
    const { repo, globalDir } = repoWithOverlay(`routing:
  deny:
    adapters: [codex, cursor-agent, opencode, grok, kimi]
tiers:
  pi:
    vendor: zhipu
    channel: sub
    models:
      zai/glm-5.2: mid
      anthropic/claude-opus-4-5: frontier
`);
    const cfg = loadConfig(repo, { globalDir });
    const health = piHealthServable(cfg);
    const channels = discoverChannels(cfg, adapters, health);
    expect(channels.some((c) => c.adapter === "pi" && c.model === "zai/glm-5.2")).toBe(true);
    const author = { adapter: "claude-code", model: "sonnet", channel: "sub" as const, tier: "mid" as const };
    const reviewer = pickReviewer(author, channels);
    expect(reviewer).not.toBeNull();
    expect(reviewer?.adapter).toBe("pi");
    expect(reviewer?.model).toBe("zai/glm-5.2");
  });

  test("HYG-05: blast radius zero — other adapters unchanged without servable", () => {
    const { repo, globalDir } = emptyRepo();
    const cfg = loadConfig(repo, { globalDir });
    const healthNoServable: Record<string, AuthHealth> = Object.fromEntries(
      adapters.map((a) => [a.id, { installed: true, authed: true, models: [], modelAuth: authedModels(a.channels(cfg).map((c) => c.model)) }]),
    );
    const healthWithServable: Record<string, AuthHealth> = {
      ...healthNoServable,
      pi: { ...healthNoServable.pi, servable: ["zai/glm-5.2"] },
    };
    const baseline = discoverChannels(cfg, adapters, healthNoServable);
    const nonPiBaseline = baseline.filter((c) => c.adapter !== "pi");
    const nonPiWithServable = discoverChannels(cfg, adapters, healthWithServable).filter((c) => c.adapter !== "pi");
    expect(nonPiWithServable).toEqual(nonPiBaseline);
  });
});

describe("HYG-07(a) servable exclusion attribution", () => {
  const adapters = allAdapters().filter((a) => a.id !== "fake");
  test("servableExclusions names EXACTLY the channels discoverChannels dropped (parity)", () => {
    const { cfg } = piOverlayCfg();
    const health = piHealthServable(cfg);
    const channels = discoverChannels(cfg, adapters, health);
    const excluded = servableExclusions(cfg, adapters, health);
    // the dropped set is precisely: pi channels minus what survived the filter
    const piAll = adapters.find((a) => a.id === "pi")!.channels(cfg).filter((c) => c.adapter === "pi");
    const piServed = channels.filter((c) => c.adapter === "pi").map((c) => c.model);
    const droppedModels = piAll.map((c) => c.model).filter((m) => !piServed.includes(m));
    expect(excluded.map((e) => e.key)).toEqual(droppedModels.map((m) => `pi:${m}`));
    expect(excluded).toContainEqual({ key: "pi:anthropic/claude-opus-4-5", adapter: "pi" });
  });

  test("servabilityLine formats in the exclusionLine voice", () => {
    const { cfg } = piOverlayCfg();
    const health = piHealthServable(cfg);
    const line = servabilityLine(servableExclusions(cfg, adapters, health));
    expect(line).toMatch(/^servability: 1 channel\(s\) unservable — /);
    expect(line).toContain("pi:anthropic/claude-opus-4-5");
    expect(line).toContain("not in pi's served model list");
  });

  test("no servable field (pre-v1.11 doctor.json) → zero attribution, zero errors (compat)", () => {
    const { repo, globalDir } = emptyRepo();
    const cfg = loadConfig(repo, { globalDir });
    const health: Record<string, AuthHealth> = Object.fromEntries(
      adapters.map((a) => [a.id, { installed: true, authed: true, models: [], modelAuth: authedModels(a.channels(cfg).map((c) => c.model)) }]),
    );
    expect(servableExclusions(cfg, adapters, health)).toEqual([]);
    expect(servabilityLine([])).toMatch(/^servability: 0 channel\(s\) unservable/);
    // and discoverChannels list is unchanged
    expect(discoverChannels(cfg, adapters, health).length).toBeGreaterThan(0);
  });

  test("discoverChannels returned list unchanged for the servable fixture (routing decision byte-identical)", () => {
    const { cfg } = piOverlayCfg();
    const health = piHealthServable(cfg);
    const channels = discoverChannels(cfg, adapters, health);
    // exactly one pi channel survives; the unservable one is absent — the DECISION is unchanged
    expect(channels.filter((c) => c.adapter === "pi")).toHaveLength(1);
    expect(channels.some((c) => c.adapter === "pi" && c.model === "anthropic/claude-opus-4-5")).toBe(false);
  });
});

describe("HYG-07(b) doctorAgeMs mtime staleness signal", () => {
  test("null when doctor.json is absent (probeAll fallback path is fresh by construction)", () => {
    const { repo } = emptyRepo();
    expect(doctorAgeMs(repo)).toBeNull();
  });

  test("a non-negative age when doctor.json exists", () => {
    const { repo } = piOverlayCfg();
    writeDoctor(repo, { "claude-code": { installed: true, authed: true, models: [] } });
    expect(doctorAgeMs(repo)).toBeGreaterThanOrEqual(0);
  });
});
