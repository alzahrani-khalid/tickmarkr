// Queue row 367 Phase 2 (D-2187 add.15, add.20, add.21; standing D-1518 bands): the band rows of the
// benchmark-tier contract. Every cell goes through benchmarkTier with an in-memory catalog (its AA leg
// matched through model-lints' catalogEvidenceFor) and the committed Terminal-Bench fixture copy.
// Fixture Terminal-Bench scores at effort high: tb-top 60, tb-54 54, tb-effort 50.25, tb-42 42, tb-36 36, tb-24 24.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, type TickmarkrConfig, type Tier } from "../../src/config/config.js";
import type { CatalogReadResult } from "../../src/adapters/catalog-remote.js";
import { benchmarkTier, type BenchmarkTier } from "../../src/route/benchmark-tier.js";
import { parseTerminalBench, readTerminalBench, type TerminalBenchEvidence } from "../../src/route/terminal-bench.js";

const CELLS = join(import.meta.dirname, "../fixtures/benchmarks/terminal-bench-cells.json");
const NOW = new Date("2026-11-08T12:00:00Z");
const TB = readTerminalBench(CELLS);

/** An in-memory fetched catalog: one openai models.dev record and one AA row per scored model. */
const catalog = (aa: Record<string, number>): CatalogReadResult => ({
  source: "cache",
  stale: false,
  catalog: {
    schemaVersion: 1,
    fetchedAt: "2026-11-07T00:00:00.000Z",
    legFetchedAt: { artificialAnalysis: "2026-11-07T06:00:00.000Z" },
    modelsDev: { openai: { id: "openai", models: Object.fromEntries(Object.keys(aa).map((id) => [id, { id, name: id }])) } },
    artificialAnalysis: {
      intelligence_index_version: "4.0",
      data: Object.entries(aa).map(([slug, index]) => ({
        slug, model_creator: { slug: "openai" }, evaluations: { artificial_analysis_intelligence_index: index },
      })),
    },
  },
});

/** The seeded config with extra codex tiers; each configured model launches at `effort` unless set to none. */
const cfgWith = (models: Record<string, Tier>, effort: Record<string, "high" | undefined> = {}): TickmarkrConfig => {
  const codex = DEFAULT_CONFIG.tiers.codex;
  return {
    ...DEFAULT_CONFIG,
    tiers: {
      ...DEFAULT_CONFIG.tiers,
      codex: {
        ...codex,
        models: { ...codex.models, ...models },
        modelOverrides: Object.fromEntries(Object.keys(models).filter((m) => !(m in effort) || effort[m])
          .map((m) => [m, { effort: effort[m] ?? "high" }])),
      },
    },
  };
};

const FLEET = cfgWith({ "tb-top": "frontier" });

const tierOf = (
  model: string, aa: Record<string, number>,
  { cfg = FLEET, tb = TB, adapter = "codex" }: { cfg?: TickmarkrConfig; tb?: TerminalBenchEvidence; adapter?: string } = {},
): BenchmarkTier => benchmarkTier({ adapter, model, effort: "high" }, { cfg, catalog: catalog(aa), terminalBench: tb, now: NOW });

const computed = (r: BenchmarkTier) => {
  expect(r.kind).toBe("computed");
  return r.kind === "computed" ? r.record : undefined;
};

describe("benchmark tier bands (D-1518: AA >= 0.90 / 0.75, Terminal-Bench >= 0.85 / 0.50)", () => {
  test("both ratios at or above the frontier thresholds give frontier", () => {
    // Ratios 0.95 / 0.90.
    expect(computed(tierOf("tb-54", { "tb-top": 100, "tb-54": 95 }))).toEqual({
      tier: "frontier",
      provisional: false,
      reason: expect.stringMatching(/Artificial Analysis 95\/100 = 0\.95 .*Terminal-Bench 54\/60 = 0\.9 .*→ frontier$/),
      aa: { score: 95, top: 100, version: "4.0", fetchedAt: "2026-11-07T06:00:00.000Z" },
      tb: { score: 54, top: 60, version: "4.0", retrievedAt: "2026-11-01" },
    });
    // At exactly the AA threshold (0.90 / 0.90).
    expect(computed(tierOf("tb-54", { "tb-top": 100, "tb-54": 90 }))?.tier).toBe("frontier");
    // Terminal-Bench just above its threshold: fleet top tb-42, so tb-36 reads 36/42 = 0.857.
    expect(computed(tierOf("tb-36", { "tb-42": 100, "tb-36": 90 }, { cfg: cfgWith({ "tb-42": "mid" }) }))?.tier).toBe("frontier");
  });

  test("a frontier artificial analysis ratio with only a mid terminal bench ratio gives mid", () => {
    // 0.95 / 0.70: the AA ratio never carries the Terminal-Bench one.
    expect(computed(tierOf("tb-42", { "tb-top": 100, "tb-42": 95 }))?.tier).toBe("mid");
    // Terminal-Bench just below its frontier threshold: 50.25/60 = 0.8375.
    expect(computed(tierOf("tb-effort", { "tb-top": 100, "tb-effort": 99 }))?.tier).toBe("mid");
  });

  test("both ratios at or above the mid thresholds and not frontier give mid", () => {
    // 0.80 / 0.60.
    expect(computed(tierOf("tb-36", { "tb-top": 100, "tb-36": 80 }))?.tier).toBe("mid");
    // At exactly the AA mid threshold (0.75 / 0.60).
    expect(computed(tierOf("tb-36", { "tb-top": 100, "tb-36": 75 }))?.tier).toBe("mid");
    // The converse conjunction, 0.80 / 0.90 and 0.8999 / 0.90: a frontier Terminal-Bench ratio never carries AA.
    expect(computed(tierOf("tb-54", { "tb-top": 100, "tb-54": 80 }))?.tier).toBe("mid");
    expect(computed(tierOf("tb-54", { "tb-top": 100, "tb-54": 89.99 }))?.tier).toBe("mid");
    // Terminal-Bench just above its mid threshold: fleet top tb-effort with no launch effort (45), so 24/45 = 0.533.
    const top45 = cfgWith({ "tb-effort": "mid" }, { "tb-effort": undefined });
    expect(computed(tierOf("tb-24", { "tb-effort": 100, "tb-24": 95 }, { cfg: top45 }))?.tier).toBe("mid");
  });

  test("either ratio below its mid threshold gives cheap", () => {
    // 0.80 / 0.40 and 0.60 / 0.90.
    expect(computed(tierOf("tb-24", { "tb-top": 100, "tb-24": 80 }))?.tier).toBe("cheap");
    expect(computed(tierOf("tb-54", { "tb-top": 100, "tb-54": 60 }))?.tier).toBe("cheap");
    // AA just below its mid threshold with a frontier Terminal-Bench ratio (0.7499 / 0.90).
    expect(computed(tierOf("tb-54", { "tb-top": 100, "tb-54": 74.99 }))?.tier).toBe("cheap");
    // Terminal-Bench just below its mid threshold with a frontier AA ratio: fleet top tb-effort at high, 24/50.25 = 0.478.
    const top5025 = cfgWith({ "tb-effort": "mid" });
    expect(computed(tierOf("tb-24", { "tb-effort": 100, "tb-24": 95 }, { cfg: top5025 }))?.tier).toBe("cheap");
  });

  test("the fleet top reads a configured model at its configured launch effort, never at its seed's", () => {
    // codex:gpt-6-sol is seeded with no effort and configured here at effort high; it is the only scored
    // fleet model. Its high row (40) is its launch score; its no-effort row (60) must not become the top.
    const fixture = JSON.parse(readFileSync(CELLS, "utf8")) as { rows: unknown[] };
    const solRows = (high: number, none: number) => parseTerminalBench(JSON.stringify({
      ...fixture,
      rows: [
        ...fixture.rows,
        { model: "gpt-6-sol", effort: "high", agent: "Codex", score: high, sourceUrl: "https://www.tbench.ai/", retrievedAt: "2026-11-01" },
        { model: "gpt-6-sol", agent: "Codex", score: none, sourceUrl: "https://www.tbench.ai/", retrievedAt: "2026-11-01" },
      ],
    }));
    expect(DEFAULT_CONFIG.tiers.codex.modelOverrides?.["gpt-6-sol"]?.effort).toBeUndefined();
    const aa = { "gpt-6-sol": 100, "tb-36": 95 };
    const atHigh = cfgWith({ "gpt-6-sol": "frontier" });
    const r = computed(tierOf("tb-36", aa, { cfg: atHigh, tb: solRows(40, 60) }));
    expect(r?.tb).toEqual({ score: 36, top: 40, version: "4.0", retrievedAt: "2026-11-01" });
    expect(r?.tier).toBe("frontier");
    // Bounded over the class: whichever of the two rows is higher, the top is the configured effort's row,
    // and a model configured with no effort reads its no-effort row.
    const atNone = cfgWith({ "gpt-6-sol": "frontier" }, { "gpt-6-sol": undefined });
    for (const [cfg, high, none, top] of [
      [atHigh, 40, 60, 40], [atHigh, 60, 40, 60], [atHigh, 40, 40, 40],
      [atNone, 40, 60, 60], [atNone, 60, 40, 40],
    ] as const) {
      expect(computed(tierOf("tb-36", aa, { cfg, tb: solRows(high, none) }))?.tb?.top).toBe(top);
    }
  });

  test("a model with an existing tier and frontier band scores keeps its existing tier and gets no record", () => {
    const scores = { "tb-top": 100, "tb-54": 95 };
    // Control: with no tier, these scores band frontier.
    expect(computed(tierOf("tb-54", scores))?.tier).toBe("frontier");
    // Configured on the candidate's own adapter: kept, no record, and the config is not touched.
    const cfg = cfgWith({ "tb-top": "frontier", "tb-54": "cheap" });
    const before = structuredClone(cfg);
    expect(tierOf("tb-54", scores, { cfg })).toEqual({ kind: "existing", tier: "cheap" });
    expect(cfg).toEqual(before);
    // Configured under another adapter: the exact id's tier is inherited.
    const elsewhere: TickmarkrConfig = {
      ...FLEET,
      tiers: { ...FLEET.tiers, opencode: { ...FLEET.tiers.opencode, models: { ...FLEET.tiers.opencode.models, "tb-54": "mid" } } },
    };
    expect(tierOf("tb-54", scores, { cfg: elsewhere, adapter: "cliproxy" })).toEqual({ kind: "existing", tier: "mid" });
    // Seeded only (absent from this config's tiers): a frontier-band seed keeps its seeded tier.
    const fixture = JSON.parse(readFileSync(CELLS, "utf8")) as { rows: unknown[] };
    const tb = parseTerminalBench(JSON.stringify({
      ...fixture,
      rows: [...fixture.rows, { model: "gpt-6-luna", effort: "high", agent: "Codex", score: 59, sourceUrl: "https://www.tbench.ai/", retrievedAt: "2026-11-01" }],
    }));
    const unseeded: TickmarkrConfig = {
      ...DEFAULT_CONFIG,
      tiers: { codex: { vendor: "openai", channel: "sub", models: { "tb-top": "frontier" }, modelOverrides: { "tb-top": { effort: "high" } } } },
    };
    expect(DEFAULT_CONFIG.tiers.codex.models["gpt-6-luna"]).toBe("cheap");
    expect(tierOf("gpt-6-luna", { "tb-top": 100, "gpt-6-luna": 99 }, { cfg: unseeded, tb })).toEqual({ kind: "existing", tier: "cheap" });
  });
});
