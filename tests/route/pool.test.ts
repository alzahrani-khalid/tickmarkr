import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BillingChannel } from "../../src/adapters/types.js";
import { ConfigError, DEFAULT_CONFIG, loadConfig, type TickmarkrConfig } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { route, RoutingError } from "../../src/route/router.js";

// v1.92 pool routing — the shape's OWN closed candidate set (local://pool-contract.md).
// Fixture style mirrors tests/route/router.test.ts: static channels, structuredClone(DEFAULT_CONFIG).

const CH: BillingChannel[] = [
  { adapter: "codex", vendor: "openai", model: "gpt-5.5", channel: "api", tier: "frontier" },
  { adapter: "claude-code", vendor: "anthropic", model: "fable", channel: "sub", tier: "frontier" },
  { adapter: "claude-code", vendor: "anthropic", model: "sonnet", channel: "sub", tier: "mid" },
  { adapter: "codex", vendor: "openai", model: "gpt-5.6-terra", channel: "sub", tier: "mid" },
  { adapter: "opencode", vendor: "mixed", model: "zai/glm-5.2", channel: "sub", tier: "cheap" },
];

const mkTask = (over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 5, acceptance: ["a"], ...over }],
  }).tasks[0];

const poolCfg = (mode: "any" | "ordered", channels: string[], shape = "implement"): TickmarkrConfig => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.routing.map[shape] = { pool: { mode, channels } };
  return cfg;
};

describe("pool mode any — economy engine inside the pool", () => {
  test("a cheap sub beats a frontier api within the pool (cost, then tier)", () => {
    const cfg = poolCfg("any", ["codex:gpt-5.5", "opencode:zai/glm-5.2"]);
    const r = route(mkTask(), cfg, CH);
    expect(r.assignment).toMatchObject({ adapter: "opencode", model: "zai/glm-5.2" });
    expect(r.provenance).toBe("pool any opencode:zai/glm-5.2 (config routing.map)");
  });

  test("cost+tier ties resolve by pool declaration order (stable sort)", () => {
    // two mid subs tie on every key — the pool's declared order decides, not discovery order
    const cfg = poolCfg("any", ["codex:gpt-5.6-terra", "claude-code:sonnet"]);
    expect(route(mkTask(), cfg, CH).assignment).toMatchObject({ adapter: "codex", model: "gpt-5.6-terra" });
  });
});

describe("pool mode ordered — first live wins", () => {
  test("returns the first declared channel when it is live", () => {
    const cfg = poolCfg("ordered", ["codex:gpt-5.5", "opencode:zai/glm-5.2"]);
    const r = route(mkTask(), cfg, CH);
    expect(r.assignment).toMatchObject({ adapter: "codex", model: "gpt-5.5" });
    expect(r.provenance).toBe("pool ordered codex:gpt-5.5 (config routing.map)");
  });

  test("falls to the second when the first is absent from doctor's channels", () => {
    const cfg = poolCfg("ordered", ["codex:gpt-5.5", "opencode:zai/glm-5.2"]);
    const withoutFirst = CH.filter((c) => c.model !== "gpt-5.5");
    expect(route(mkTask(), cfg, withoutFirst).assignment).toMatchObject({ adapter: "opencode", model: "zai/glm-5.2" });
  });
});

describe("pool exhaustion — fail-loud, pin precedent", () => {
  test("a pool with zero live channels throws RoutingError naming the declared ids", () => {
    const cfg = poolCfg("any", ["gemini:flash", "grok:g4"]);
    let err: unknown;
    try {
      route(mkTask(), cfg, CH);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RoutingError);
    const msg = (err as RoutingError).message;
    expect(msg).toContain("routing.map.implement.pool has no live channel");
    expect(msg).toContain("gemini:flash, grok:g4");
  });
});

describe("pool vs floors — lint, never block", () => {
  test("a pool routing below the advisory floor lints 'map pools are supreme' and still routes", () => {
    // migration carries a frontier floor in the seed config; the pool's cheap pick must proceed
    const cfg = poolCfg("any", ["opencode:zai/glm-5.2"], "migration");
    const r = route(mkTask({ shape: "migration" }), cfg, CH);
    expect(r.assignment).toMatchObject({ adapter: "opencode", model: "zai/glm-5.2" });
    expect(r.lints.join()).toContain("map pool routes cheap, below config floor frontier — map pools are supreme");
  });
});

describe("pool vs allow/deny — preflight when prefActive", () => {
  test("a disallowed pool entry throws with the drop-it remedy", () => {
    const cfg = poolCfg("any", ["codex:gpt-5.5", "opencode:zai/glm-5.2"]);
    cfg.routing.deny = { adapters: ["codex"] };
    expect(() => route(mkTask(), cfg, CH)).toThrow(
      "T1: pool entry codex:gpt-5.5 is disallowed by routing.deny (codex) — remove the deny entry or drop it from the pool",
    );
  });
});

describe("pin/pool/prefer exclusivity — config load fails loud", () => {
  const loadOverlay = (yaml: string): unknown => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-pool-r-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-pool-g-"));
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), yaml);
    try {
      loadConfig(repo, { globalDir });
      return undefined;
    } catch (e) {
      return e;
    }
  };

  // shape refactor has NO default map entry — the overlay alone owns the merged entry, so the
  // superRefine sees exactly the declared collision (default implement carries a seed prefer).
  test("pin+pool together fails: a pin is a one-channel ordered pool", () => {
    const err = loadOverlay(
      "routing:\n  map:\n    refactor:\n      pin: { via: codex, model: gpt-5.5 }\n      pool:\n        mode: ordered\n        channels: [codex:gpt-5.5]\n",
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain(
      "routing.map.refactor: pin and pool are one declaration — a pin is pool {mode: ordered, channels:[one]}; keep one",
    );
  });

  test("pool+prefer together fails: pool already decides the candidate set", () => {
    const err = loadOverlay(
      "routing:\n  map:\n    refactor:\n      prefer: [codex]\n      pool:\n        mode: any\n        channels: [codex:gpt-5.5]\n",
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain(
      "routing.map.refactor: pool already decides the candidate set — prefer is the OPEN bias; keep one",
    );
  });

  // The seed default map DOES carry implement.prefer — an overlay pool on the same shape must
  // override the whole pin/pool/prefer declaration slot at merge, never stack beside the seed
  // into a conflict the author never wrote (the field defect this test pins: the fleet editor's
  // written pool bounced off the reload guard with the pool+prefer error).
  test("an overlay pool on a shape with a seed prefer loads clean and owns the slot", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-pool-slot-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-pool-slot-g-"));
    writeFileSync(
      join(tickmarkrDir(repo), "config.yaml"),
      "routing:\n  map:\n    implement:\n      pool:\n        mode: any\n        channels: [codex:gpt-5.5]\n",
    );
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.routing.map.implement.pool).toEqual({ mode: "any", channels: ["codex:gpt-5.5"] });
    expect(cfg.routing.map.implement.prefer).toBeUndefined();
    expect(cfg.routing.map.implement.pin).toBeUndefined();
  });

  test("an overlay prefer still replaces a seed prefer wholesale and a bare tombstone still deletes without nuking the slot", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-pool-slot2-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-pool-slot2-g-"));
    writeFileSync(
      join(tickmarkrDir(repo), "config.yaml"),
      "routing:\n  map:\n    implement:\n      prefer: [codex:gpt-5.5]\n",
    );
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.routing.map.implement.prefer).toEqual(["codex:gpt-5.5"]);
    const repo2 = mkdtempSync(join(tmpdir(), "tickmarkr-pool-slot3-"));
    writeFileSync(
      join(tickmarkrDir(repo2), "config.yaml"),
      "routing:\n  map:\n    implement:\n      prefer: null\n",
    );
    const cfg2 = loadConfig(repo2, { globalDir });
    expect(cfg2.routing.map.implement?.prefer).toBeUndefined();
  });
});

describe("pin branch untouched", () => {
  test("a bare map pin still routes byte-identically", () => {
    // shape plan carries the seed map pin claude-code:fable — no pool anywhere near it
    const r = route(mkTask({ shape: "plan" }), structuredClone(DEFAULT_CONFIG), CH);
    expect(r.assignment).toMatchObject({ adapter: "claude-code", model: "fable" });
    expect(r.provenance).toBe("pin claude-code:fable (config routing.map)");
  });
});
