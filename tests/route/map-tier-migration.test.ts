import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { modelLints } from "../../src/adapters/model-lints.js";
import { allAdapters, deriveAutoPrefer } from "../../src/adapters/registry.js";
import { type AuthHealth, type BillingChannel, channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { ConfigError, DEFAULT_CONFIG, loadConfig, MapEntrySchema, type TickmarkrConfig } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { SHAPES, validateGraph } from "../../src/graph/schema.js";
import { route } from "../../src/route/router.js";

// derive channels from ALL real adapters — !== "fake" keeps the oracle env-independent (matrix.test.ts:14)
const channelsOf = (cfg: TickmarkrConfig): BillingChannel[] =>
  allAdapters().map((a) => a.id).filter((id) => id !== "fake").flatMap((id) => channelsFromConfig(id, cfg));

const emptyRepo = () => ({ repo: mkdtempSync(join(tmpdir(), "tickmarkr-r-")), globalDir: mkdtempSync(join(tmpdir(), "tickmarkr-g-")) });

const mkTask = (shape: string) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"] }],
  }).tasks[0];

describe("v1.52 T5 — map-entry tier removed: floors become the only band authority", () => {
  test("a map entry carrying a tier value fails config load naming the floors key", () => {
    const { repo, globalDir } = emptyRepo();
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "routing:\n  map:\n    implement:\n      tier: mid\n");
    let err: unknown;
    try {
      loadConfig(repo, { globalDir });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain("routing.floors");
  });

  test("a tier null tombstone parses and is stripped without error", () => {
    const direct = MapEntrySchema.safeParse({ tier: null, prefer: ["opencode"] });
    expect(direct.success).toBe(true);
    expect(direct.data?.tier).toBeUndefined();
    expect(direct.data?.prefer).toEqual(["opencode"]);

    // full pipeline: a global layer sets a legacy tier, the repo layer tombstones it — deepMerge
    // deletes the key before the schema ever runs, so loadConfig must not throw either.
    const { repo, globalDir } = emptyRepo();
    writeFileSync(join(globalDir, "config.yaml"), "routing:\n  map:\n    tests:\n      tier: cheap\n");
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "routing:\n  map:\n    tests:\n      tier: null\n");
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.routing.map.tests?.tier).toBeUndefined();
    expect(cfg.routing.map.tests?.prefer).toEqual(["opencode"]); // only the tier died, not the entry
  });

  test("default routing is byte-identical after the schema removal", () => {
    const { repo, globalDir } = emptyRepo();
    const cfg = loadConfig(repo, { globalDir }); // parses DEFAULT_CONFIG straight through the new schema
    const channels = channelsOf(cfg);
    for (const shape of SHAPES) {
      const viaLoad = route(mkTask(shape), cfg, channels);
      const viaDefault = route(mkTask(shape), DEFAULT_CONFIG, channels);
      expect(JSON.stringify(viaLoad)).toBe(JSON.stringify(viaDefault));
    }
  });

  test("no built-in default map entry carries a tier and floors alone express the band policy", () => {
    for (const entry of Object.values(DEFAULT_CONFIG.routing.map)) expect(entry.tier).toBeUndefined();
    expect(DEFAULT_CONFIG.routing.floors).toMatchObject({ implement: "mid", tests: "cheap", docs: "cheap" });
  });

  test("auto prefer derivation reads floors and never a map tier", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    expect(cfg.routing.floors.implement).toBe("mid");
    // Even if a stray tier ever survived on an in-memory map entry (the schema now forbids this
    // from any real config load — see the fail-closed test above), deriveAutoPrefer must still
    // resolve its qualifying-tier gate from routing.floors alone, never from the map entry.
    (cfg.routing.map.implement as unknown as { tier: string }).tier = "frontier";
    const codexStub = {
      id: "codex",
      vendor: "openai",
      probe: async () => ({ installed: true, authed: true, models: [] }),
      channels: (c: TickmarkrConfig) => channelsFromConfig("codex", c),
    } as unknown as WorkerAdapter;
    const health: Record<string, AuthHealth> = {
      codex: {
        installed: true, authed: true, models: [],
        modelAuth: { "gpt-5.6-terra": { authed: true, probedAt: "2026-07-18T00:00:00.000Z" } },
      },
    };
    const out = deriveAutoPrefer(cfg, [codexStub], health);
    // gpt-5.6-terra is tier "mid" — qualifies against the floor "mid", but would be excluded if the
    // bogus map tier "frontier" were honored instead.
    expect(out.implement).toContain("codex");
  });

  test("plan and doctor emit no map tier deprecation lint", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    // a stray in-memory tier (never producible by a real config load, see the fail-closed test
    // above) must not resurrect the v1.51 T3 deprecation lint that this task deletes — modelLints
    // is the single function plan.ts and doctor.ts both call, so proving it here covers both.
    (cfg.routing.map.implement as unknown as { tier: string }).tier = "mid";
    const lints = modelLints(cfg, {}, []);
    expect(lints.some((l) => l.includes("deprecated"))).toBe(false);
    expect(lints.some((l) => l.includes("routing.map") && l.includes("tier"))).toBe(false);
  });
});
