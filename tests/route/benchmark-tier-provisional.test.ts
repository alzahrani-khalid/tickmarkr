// Queue row 367 Phase 2 (D-2187 add.15, add.20, add.21): the provisional rows of the benchmark-tier
// contract. A missing or stale score on either leg gives cheap, provisional, its reason naming that leg and
// only that leg — never a guessed band. Every cell goes through benchmarkTier with an in-memory catalog whose
// AA leg is dated, and the committed Terminal-Bench fixture copy.
// Fixture Terminal-Bench at effort high: tb-top 60, tb-54 54, tb-stale 70 (retrieved 2026-09-01, maxAgeDays 30).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, type TickmarkrConfig, type Tier } from "../../src/config/config.js";
import {
  CATALOG_CACHE_MAX_AGE_MS, catalogCachePath, LIVEBENCH_CATEGORIES_URL, LIVEBENCH_TABLE_URL, MODELS_DEV_CATALOG_URL,
  readCachedCatalog, refreshCatalogCommand, type CatalogFetcher, type CatalogReadResult,
} from "../../src/adapters/catalog-remote.js";
import { benchmarkTier, type BenchmarkTier, type BenchmarkTierRecord } from "../../src/route/benchmark-tier.js";
import { parseTerminalBench, readTerminalBench, type TerminalBenchEvidence } from "../../src/route/terminal-bench.js";

const CELLS = join(import.meta.dirname, "../fixtures/benchmarks/terminal-bench-cells.json");
const NOW = new Date("2026-11-08T12:00:00Z");
const TB = readTerminalBench(CELLS);
const AA_FRESH = "2026-11-07T06:00:00.000Z";

/** An in-memory fetched catalog: one openai models.dev record and one AA row per scored model, AA leg dated. */
const catalog = (
  aa: Record<string, number>, { aaFetchedAt = AA_FRESH, source = "cache" }: { aaFetchedAt?: string; source?: "cache" | "vendored" } = {},
): CatalogReadResult => ({
  source,
  stale: false,
  catalog: {
    schemaVersion: 1,
    fetchedAt: "2026-11-07T00:00:00.000Z",
    legFetchedAt: { artificialAnalysis: aaFetchedAt },
    modelsDev: { openai: { id: "openai", models: Object.fromEntries(Object.keys(aa).map((id) => [id, { id, name: id }])) } },
    artificialAnalysis: {
      intelligence_index_version: "4.0",
      data: Object.entries(aa).map(([slug, index]) => ({
        slug, model_creator: { slug: "openai" }, evaluations: { artificial_analysis_intelligence_index: index },
      })),
    },
  },
});

/** The seeded config with extra codex tiers, each launched at effort high. */
const cfgWith = (models: Record<string, Tier>): TickmarkrConfig => ({
  ...DEFAULT_CONFIG,
  tiers: {
    ...DEFAULT_CONFIG.tiers,
    codex: {
      ...DEFAULT_CONFIG.tiers.codex,
      models: { ...DEFAULT_CONFIG.tiers.codex.models, ...models },
      modelOverrides: Object.fromEntries(Object.keys(models).map((m) => [m, { effort: "high" as const }])),
    },
  },
});

const FLEET = cfgWith({ "tb-top": "frontier" });

const tierOf = (
  model: string, aa: Record<string, number>,
  { cfg = FLEET, tb = TB, aaFetchedAt, source }: {
    cfg?: TickmarkrConfig; tb?: TerminalBenchEvidence; aaFetchedAt?: string; source?: "cache" | "vendored";
  } = {},
): BenchmarkTier => benchmarkTier(
  { adapter: "codex", model, effort: "high" },
  { cfg, catalog: catalog(aa, { aaFetchedAt, source }), terminalBench: tb, now: NOW },
);

const record = (r: BenchmarkTier): BenchmarkTierRecord | undefined => {
  expect(r.kind).toBe("computed");
  return r.kind === "computed" ? r.record : undefined;
};

/** Cheap, provisional, the named leg in the reason and the other leg absent from it. */
const provisional = (r: BenchmarkTier, names: RegExp, notNamed?: RegExp): BenchmarkTierRecord | undefined => {
  const rec = record(r);
  expect(rec?.tier).toBe("cheap");
  expect(rec?.provisional).toBe(true);
  expect(rec?.reason).toMatch(names);
  if (notNamed) expect(rec?.reason).not.toMatch(notNamed);
  return rec;
};

/** A fixture copy with extra or edited rows (the reader and the committed fixture stay untouched). */
const fixtureWith = (edit: (rows: Record<string, unknown>[]) => Record<string, unknown>[]): TerminalBenchEvidence => {
  const doc = JSON.parse(readFileSync(CELLS, "utf8")) as { rows: Record<string, unknown>[] };
  return parseTerminalBench(JSON.stringify({ ...doc, rows: edit(doc.rows) }));
};

const AA_LEG = /Artificial Analysis/;
const TB_LEG = /Terminal-Bench/;
const TB_54 = { score: 54, top: 60, version: "4.0", retrievedAt: "2026-11-01" };

describe("provisional benchmark tier (row 367: a missing or stale leg is cheap, provisional, and named)", () => {
  test("a missing artificial analysis score gives a provisional cheap tier naming that leg", () => {
    // Control: with an AA score these legs band frontier (95/100, 54/60), so cheap below is no guess.
    expect(record(tierOf("tb-54", { "tb-top": 100, "tb-54": 95 }))?.tier).toBe("frontier");
    // No AA row for the candidate: the frontier-band Terminal-Bench leg never carries it.
    const rec = provisional(tierOf("tb-54", { "tb-top": 100 }), /no Artificial Analysis score for tb-54/, TB_LEG);
    expect(rec).toEqual({
      tier: "cheap", provisional: true, reason: "provisional, cheap floor only: no Artificial Analysis score for tb-54", tb: TB_54,
    });
    // A vendored catalog is a shipped default, never fetched evidence: AA missing.
    provisional(tierOf("tb-54", { "tb-top": 100, "tb-54": 95 }, { source: "vendored" }), /no Artificial Analysis score for tb-54/, TB_LEG);
    // No fleet model has an AA score: no AA fleet top, so no ratio.
    const noTop = provisional(tierOf("tb-54", { "tb-54": 95 }), /no Artificial Analysis fleet top/, TB_LEG);
    expect(noTop?.aa).toBeUndefined();
    // Both legs missing: both named.
    provisional(tierOf("tb-unlisted", { "tb-top": 100 }), /no Artificial Analysis score for tb-unlisted; no Terminal-Bench row for tb-unlisted/);
  });

  test("a missing terminal bench score gives a provisional cheap tier naming that leg", () => {
    const aa = { "tb-top": 100, "tb-unlisted": 99, "tb-agentless": 99, "tb-twin": 99 };
    const AA_99 = { score: 99, top: 100, version: "4.0", fetchedAt: AA_FRESH };
    // No row for the model at its launch effort (or with no effort): the frontier-band AA leg never carries it.
    const rec = provisional(tierOf("tb-unlisted", aa), /no Terminal-Bench row for tb-unlisted at effort high/, AA_LEG);
    expect(rec).toEqual({
      tier: "cheap", provisional: true,
      reason: "provisional, cheap floor only: no Terminal-Bench row for tb-unlisted at effort high", aa: AA_99,
    });
    // The evidence file absent: Terminal-Bench missing for every model, never a throw.
    const absent = readTerminalBench(join(import.meta.dirname, "../fixtures/benchmarks/absent-terminal-bench.json"));
    provisional(tierOf("tb-54", { "tb-top": 100, "tb-54": 95 }, { tb: absent }), /Terminal-Bench evidence unavailable/, AA_LEG);
    // A row with no agent, or an empty one: an invalid row, so that model's score is missing.
    provisional(tierOf("tb-agentless", aa), /Terminal-Bench row for tb-agentless is invalid: agent missing or empty/, AA_LEG);
    const emptyAgent = fixtureWith((rows) => [...rows, { ...rows[1], model: "tb-blank", agent: "" }]);
    provisional(tierOf("tb-blank", { "tb-top": 100, "tb-blank": 99 }, { tb: emptyAgent }), /tb-blank is invalid: agent missing or empty/, AA_LEG);
    // Two rows for one model and effort under two different agents: ambiguous, never pick one.
    provisional(tierOf("tb-twin", aa), /Terminal-Bench ambiguous for tb-twin effort high: 2 rows/, AA_LEG);
    // No fleet model has a fresh Terminal-Bench score: no Terminal-Bench fleet top.
    const staleFleet = cfgWith({ "tb-stale": "frontier" });
    const noTop = provisional(tierOf("tb-54", { "tb-stale": 100, "tb-54": 95 }, { cfg: staleFleet }), /no Terminal-Bench fleet top/, AA_LEG);
    expect(noTop?.aa).toEqual({ score: 95, top: 100, version: "4.0", fetchedAt: AA_FRESH });
    expect(noTop?.tb).toBeUndefined();
  });

  test("a stale artificial analysis score gives a provisional cheap tier naming that leg", () => {
    const scores = { "tb-top": 100, "tb-54": 95 };
    const at = (ageMs: number) => new Date(NOW.getTime() - ageMs).toISOString();
    // Boundary control: 1 ms under CATALOG_CACHE_MAX_AGE_MS the same frontier-band scores band frontier.
    expect(record(tierOf("tb-54", scores, { aaFetchedAt: at(CATALOG_CACHE_MAX_AGE_MS - 1) }))?.tier).toBe("frontier");
    // At exactly the bound the AA leg is stale: cheap, provisional, never frontier.
    const stale = at(CATALOG_CACHE_MAX_AGE_MS);
    const rec = provisional(tierOf("tb-54", scores, { aaFetchedAt: stale }), /Artificial Analysis score for tb-54 is stale/, TB_LEG);
    expect(rec).toEqual({
      tier: "cheap", provisional: true,
      reason: `provisional, cheap floor only: Artificial Analysis score for tb-54 is stale: fetched ${stale}, at least 7 days old`,
      tb: TB_54,
    });
    // Well past the bound, and an unreadable fetch date (fail closed): stale.
    provisional(tierOf("tb-54", scores, { aaFetchedAt: at(30 * 86_400_000) }), /Artificial Analysis score for tb-54 is stale/, TB_LEG);
    provisional(tierOf("tb-54", scores, { aaFetchedAt: "not a date" }), /Artificial Analysis score for tb-54 is stale/, TB_LEG);

    // Closed date-provenance table for the AA leg: only a dated AA leg inside the bound, or a legacy cache
    // with no per-leg record and a fresh fetchedAt, proves the AA score fresh. A per-leg record that lacks
    // the AA date never borrows fetchedAt (dated by the models.dev spine), however fresh.
    const base = catalog(scores);
    const old = "2026-10-01T00:00:00.000Z";
    const dates: [string, Partial<CatalogReadResult["catalog"]>, "fresh" | RegExp][] = [
      ["legacy, fresh fetchedAt", { fetchedAt: AA_FRESH, legFetchedAt: undefined }, "fresh"],
      ["legacy, stale fetchedAt", { fetchedAt: old, legFetchedAt: undefined }, /stale: fetched 2026-10-01T00:00:00.000Z/],
      ["per-leg, AA fresh", { fetchedAt: old, legFetchedAt: { artificialAnalysis: AA_FRESH } }, "fresh"],
      ["per-leg, AA stale", { fetchedAt: NOW.toISOString(), legFetchedAt: { artificialAnalysis: old } }, /stale: fetched 2026-10-01/],
      ["per-leg, no AA date", { fetchedAt: NOW.toISOString(), legFetchedAt: { modelsDev: NOW.toISOString(), liveBench: NOW.toISOString() } }, /stale: no fetch date recorded for that leg/],
      ["per-leg empty, no AA date", { fetchedAt: NOW.toISOString(), legFetchedAt: {} }, /stale: no fetch date recorded for that leg/],
      ["per-leg, AA date empty", { fetchedAt: NOW.toISOString(), legFetchedAt: { artificialAnalysis: "" } }, /Artificial Analysis score for tb-54 is stale/],
    ];
    for (const [cell, over, want] of dates) {
      const r = benchmarkTier(
        { adapter: "codex", model: "tb-54", effort: "high" },
        { cfg: FLEET, catalog: { ...base, catalog: { ...base.catalog, ...over } }, terminalBench: TB, now: NOW },
      );
      if (want === "fresh") expect(record(r)?.tier, cell).toBe("frontier");
      else expect(provisional(r, want, TB_LEG)?.aa, cell).toBeUndefined();
    }
  });

  test("a skipped artificial analysis refresh keeps the old scores undated, so they stay stale and never band the model", async () => {
    // Row 367 (D-2187 add.15): refreshCatalogCommand with no AA key keeps the previous AA scores, drops
    // their date from legFetchedAt and moves fetchedAt to the fresh models.dev stamp. Those scores must read
    // stale through the production read, never as fresh evidence banding tb-54 frontier.
    const repo = mkdtempSync(join(tmpdir(), "tkr-row367-"));
    try {
      const old = "2026-10-01T00:00:00.000Z";
      const prior = catalog({ "tb-top": 100, "tb-54": 95 }).catalog;
      mkdirSync(dirname(catalogCachePath(repo)), { recursive: true });
      writeFileSync(catalogCachePath(repo), JSON.stringify({
        ...prior, fetchedAt: old, legFetchedAt: { modelsDev: old, artificialAnalysis: old, liveBench: old },
      }));
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => String(body) });
      const fetcher: CatalogFetcher = async (input) => {
        const url = String(input);
        if (url.startsWith(MODELS_DEV_CATALOG_URL)) return ok(prior.modelsDev);
        if (url.startsWith(LIVEBENCH_TABLE_URL)) return ok("model,javascript\ntb-top,60\n");
        if (url.startsWith(LIVEBENCH_CATEGORIES_URL)) return ok({ "Agentic Coding": ["javascript"], Coding: ["javascript"] });
        throw new Error(`unexpected fetch ${url}`);
      };
      const refreshed = await refreshCatalogCommand({ repoRoot: repo, fetcher, artificialAnalysisKey: "", now: () => NOW });
      expect(refreshed.legs).toContainEqual(expect.objectContaining({ leg: "Artificial Analysis", status: "skipped" }));

      const read = readCachedCatalog(repo, { now: () => NOW });
      // The shape the finding names: fresh fetchedAt, a per-leg record without an AA date, AA scores kept.
      expect(read.source).toBe("cache");
      expect(read.catalog.fetchedAt).toBe(NOW.toISOString());
      expect(read.catalog.legFetchedAt).toEqual({ modelsDev: NOW.toISOString(), liveBench: NOW.toISOString() });
      expect(read.catalog.artificialAnalysis).toEqual(prior.artificialAnalysis);

      const r = benchmarkTier({ adapter: "codex", model: "tb-54", effort: "high" }, { cfg: FLEET, catalog: read, terminalBench: TB, now: NOW });
      expect(provisional(r, /Artificial Analysis score for tb-54 is stale: no fetch date recorded for that leg/, TB_LEG)).toEqual({
        tier: "cheap", provisional: true,
        reason: "provisional, cheap floor only: Artificial Analysis score for tb-54 is stale: no fetch date recorded for that leg",
        tb: TB_54,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a stale terminal bench score gives a provisional cheap tier naming that leg", () => {
    const aa = { "tb-top": 100, "tb-stale": 99 };
    // Control: the same row retrieved inside maxAgeDays bands frontier (99/100, 70/60).
    const fresh = fixtureWith((rows) => rows.map((r) => (r.model === "tb-stale" ? { ...r, retrievedAt: "2026-11-01" } : r)));
    expect(record(tierOf("tb-stale", aa, { tb: fresh }))?.tier).toBe("frontier");
    // Retrieved 2026-09-01 with maxAgeDays 30: stale at NOW, so its 70 never bands the model above cheap.
    const rec = provisional(tierOf("tb-stale", aa), /Terminal-Bench row for tb-stale effort high is stale: retrieved 2026-09-01/, AA_LEG);
    expect(rec).toEqual({
      tier: "cheap", provisional: true,
      reason: "provisional, cheap floor only: Terminal-Bench row for tb-stale effort high is stale: retrieved 2026-09-01, older than maxAgeDays 30",
      aa: { score: 99, top: 100, version: "4.0", fetchedAt: AA_FRESH },
    });
    // Both legs stale: both named.
    const both = provisional(
      tierOf("tb-stale", aa, { aaFetchedAt: "2026-10-01T00:00:00.000Z" }),
      /Artificial Analysis score for tb-stale is stale: .*; Terminal-Bench row for tb-stale effort high is stale/,
    );
    expect(both?.aa).toBeUndefined();
    expect(both?.tb).toBeUndefined();
  });
});
