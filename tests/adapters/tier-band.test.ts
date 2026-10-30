import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { CatalogReadResult } from "../../src/adapters/catalog-remote.js";
import { catalogModelAdvisory, catalogTierRanking, suggestOverlay, tierBandOf } from "../../src/adapters/model-lints.js";
import type { WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { DEFAULT_CONFIG, loadConfig, type TickmarkrConfig, type Tier } from "../../src/config/config.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

type Model = { id: string; aa?: number; liveBench?: number; output?: number };

const catalogOf = (models: readonly Model[]): CatalogReadResult => ({
  source: "cache",
  stale: false,
  catalog: {
    schemaVersion: 1,
    fetchedAt: "2026-10-29T00:00:00.000Z",
    modelsDev: {
      fixture: {
        models: Object.fromEntries(models.map(({ id, output = 1 }) => [id, {
          id, cost: { input: 0, output }, limit: { context: 200_000 },
        }])),
      },
    },
    artificialAnalysis: {
      intelligence_index_version: "4.1.1",
      data: models.filter((m) => m.aa !== undefined).map((m) => ({ id: m.id, intelligence_index: m.aa })),
    },
    liveBench: {
      tableDate: "2026_06_25",
      categories: { "Agentic Coding": ["agentic"], Coding: ["coding"] },
      rows: models.filter((m) => m.liveBench !== undefined).map((m) => ({
        model: m.id, agentic: m.liveBench, coding: 50,
      })),
    },
  },
});

const configOf = (models: Record<string, Tier> = {}): TickmarkrConfig => ({
  ...structuredClone(DEFAULT_CONFIG),
  tiers: { fake: { vendor: "fixture", channel: "api", models } },
});

const rowsOf = (models: readonly Model[]) => models.map(({ id }) => ({ adapter: "fake", model: id }));

test("test: closed table — with an AA top of 58.4, 52.57 bands frontier and 52.55 mid, 43.80 bands mid and 43.79 cheap, so a rank-thirds or rounded band fails", () => {
  const cases: Array<[number, Tier]> = [
    [58.4, "frontier"], [52.57, "frontier"], [52.56, "frontier"],
    [52.55, "mid"], [43.80, "mid"], [43.79, "cheap"], [0, "cheap"],
  ];
  const listed = cases.map(([aa], i) => ({ id: `candidate-${i}`, aa }));
  const catalog = catalogOf([
    { id: "configured-leader", aa: 58.4 }, ...listed,
    { id: "outside-the-fleet", aa: 100 },
  ]);
  const cfg = configOf({ "configured-leader": "frontier" });
  const ranking = catalogTierRanking(cfg, catalog, rowsOf(listed));
  expect(ranking[0].basis).toBe("intelligence");
  expect(ranking[0].scores[0]).toBe(58.4);
  for (const [i, [score, tier]] of cases.entries()) {
    expect(tierBandOf(score, 58.4), String(score)).toBe(tier);
    const suggestion = catalogModelAdvisory(cfg, catalog, "fake", listed[i].id, undefined, ranking).suggestion;
    expect(suggestion).toMatchObject({ tier, basis: "intelligence" });
    expect(suggestion?.provenanceNote).toContain(`score=${score}; top=58.4; ratio=${score / 58.4}; D-1518`);
    expect(suggestion?.provenanceNote).toContain("Artificial Analysis Intelligence Index");
    expect(suggestion?.provenanceNote).toContain("Terminal-Bench's 15% half awaits a catalog source");
  }
  // Overlay display filtering must not discard a listed leader from the denominator.
  const overlayCfg = configOf({ "p/anchor": "frontier" });
  const overlayCatalog = catalogOf([
    { id: "anchor", aa: 58.4 }, { id: "target", aa: 52.55 }, { id: "leader", aa: 100 },
  ]);
  const fragment = suggestOverlay(overlayCfg, {
    fake: { installed: true, authed: true, models: ["p/anchor", "p/target", "other/leader"] },
  }, [{ id: "fake", listModels: async () => [] } as unknown as WorkerAdapter], ".tickmarkr", { catalog: overlayCatalog });
  expect(fragment).toContain("SUGGESTED cheap (intelligence inference");
  expect(fragment).toContain(`score=52.55; top=100; ratio=${52.55 / 100}; D-1518`);
  expect(fragment).toContain("1 other detected id");
});

test("test: closed table — a LiveBench-only model bands against the top LiveBench score, a basis with fewer than three scored models gives no benchmark band, and a model with neither score keeps the price-derived suggestion, so a cross-basis denominator or a dropped price fallback fails", () => {
  const fleet: Model[] = [
    { id: "aa-leader", aa: 58.4 }, { id: "aa-first", aa: 52.55, liveBench: 100 },
    { id: "aa-third", aa: 43.8 },
    { id: "live-frontier", liveBench: 90 }, { id: "live-mid", liveBench: 75 },
    { id: "live-cheap", liveBench: 74.99 }, { id: "price-only", output: 1 },
  ];
  const cfg = configOf();
  const catalog = catalogOf([...fleet, { id: "not-listed", aa: 1000, liveBench: 1000 }]);
  const ranking = catalogTierRanking(cfg, catalog, rowsOf(fleet));
  expect(ranking.map((r) => r.basis)).toEqual(["intelligence", "agentic-coding"]);
  const cases = [
    ["aa-first", "mid", "intelligence", 52.55, 58.4],
    ["live-frontier", "frontier", "agentic-coding", 90, 100],
    ["live-mid", "mid", "agentic-coding", 75, 100],
    ["live-cheap", "cheap", "agentic-coding", 74.99, 100],
  ] as const;
  for (const [id, tier, basis, score, top] of cases) {
    const suggestion = catalogModelAdvisory(cfg, catalog, "fake", id, undefined, ranking).suggestion;
    expect(suggestion).toMatchObject({ tier, basis });
    expect(suggestion?.provenanceNote).toContain(`score=${score}; top=${top}; ratio=${score / top}; D-1518`);
    if (basis === "agentic-coding") expect(suggestion?.provenanceNote).toContain("LiveBench table 2026_06_25");
  }
  expect(catalogModelAdvisory(cfg, catalog, "fake", "price-only", undefined, ranking).suggestion)
    .toMatchObject({ tier: "cheap", basis: "price" });

  // The sample floor and positive-top rule apply independently to each benchmark basis.
  for (const basis of ["aa", "liveBench"] as const) {
    for (const scores of [[100, 90], [0, 0, 0]]) {
      const sparse = scores.map((score, i) => ({ id: `sample-${i}`, [basis]: score, output: 1 }));
      const smallCatalog = catalogOf(sparse);
      const smallRanking = catalogTierRanking(cfg, smallCatalog, rowsOf(sparse));
      expect(smallRanking, `${basis}: ${scores}`).toEqual([]);
      expect(catalogModelAdvisory(cfg, smallCatalog, "fake", sparse[0].id, undefined, smallRanking).suggestion)
        .toMatchObject({ tier: "cheap", basis: "price" });
      const sub = configOf();
      sub.tiers.fake.channel = "sub";
      expect(catalogModelAdvisory(sub, smallCatalog, "fake", sparse[0].id, undefined, smallRanking).suggestion)
        .toBeUndefined();
    }
  }
  // An undersampled AA basis can still yield to a sufficiently populated LiveBench basis.
  const fallbackFleet = fleet.filter((m) => m.id !== "aa-third");
  const fallbackCatalog = catalogOf(fallbackFleet);
  const fallbackRanking = catalogTierRanking(cfg, fallbackCatalog, rowsOf(fallbackFleet));
  expect(fallbackRanking.map((r) => r.basis)).toEqual(["agentic-coding"]);
  expect(catalogModelAdvisory(cfg, fallbackCatalog, "fake", "aa-first", undefined, fallbackRanking).suggestion)
    .toMatchObject({ tier: "frontier", basis: "agentic-coding" });
  for (const top of [0, -1, NaN, Infinity]) expect(tierBandOf(0, top)).toBeUndefined();
});

test("test: doctor models flags a configured tier that differs from its band with the score, top and ratio and stays silent for a matching tier, and no config file changes, so silent drift or a written suggestion fails", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  const globalDir = makeTestTempDir("tier-band-global-");
  const globalPath = join(globalDir, "config.yaml");
  writeFileSync(globalPath, "# operator global settings\nrouting:\n  deny:\n    models: []\n");
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  const configPath = join(repo, ".tickmarkr", "config.yaml");
  const overlay = [
    "tiers:", ...Object.keys(DEFAULT_CONFIG.tiers).map((id) => `  ${id}: null`),
    "  fake:", "    vendor: fixture", "    channel: api", "    models:",
    "      grok-4.7: mid", "      qwen3.8-max: frontier", "      matches: mid", "      price-only: frontier",
    "  absent:", "    vendor: fixture", "    channel: sub", "    models:", "      offline-model: frontier", "",
  ].join("\n");
  writeFileSync(configPath, overlay);
  const fleet: Model[] = [
    { id: "listed-leader", aa: 58.4 }, { id: "grok-4.7", aa: 34.3 },
    { id: "qwen3.8-max", aa: 33.6 }, { id: "matches", aa: 43.8 },
    { id: "price-only", output: 1 }, { id: "offline-model", aa: 52.55 },
  ];
  const adapter = {
    id: "fake", vendor: "fixture",
    probe: async () => ({ installed: true, authed: true, models: [] }),
    listModels: async () => fleet.filter((m) => m.id !== "offline-model").map((m) => m.id),
    headlessCommand: () => "printf OK",
  } as unknown as WorkerAdapter;
  const globalBefore = readFileSync(globalPath, "utf8");
  const configBefore = loadConfig(repo, { globalDir });
  const output = await doctor(["--models"], repo, [adapter], {
    banner: false, globalDir, catalog: catalogOf(fleet), resolveOrcaBinary: () => undefined,
  });
  const drifts = output.split("\n").filter((line) => line.includes("tier drift:"));
  expect(drifts).toHaveLength(4);
  for (const [adapterId, id, configured, score, tier] of [
    ["fake", "grok-4.7", "mid", 34.3, "cheap"],
    ["fake", "qwen3.8-max", "frontier", 33.6, "cheap"],
    ["absent", "offline-model", "frontier", 52.55, "mid"],
  ] as const) {
    const line = drifts.find((row) => row.includes(`${adapterId}:${id} `));
    expect(line).toContain(`configured ${configured}; SUGGESTED ${tier} (intelligence inference`);
    expect(line).toContain(`score=${score}; top=58.4; ratio=${score / 58.4}; D-1518`);
    expect(tierBandOf(score, 58.4)).toBe(tier);
    expect(line).toContain("operator confirmation required");
    expect(line).toContain("routing unchanged");
  }
  expect(drifts.find((line) => line.includes("fake:price-only "))).toContain("SUGGESTED cheap (price inference");
  expect(drifts.join("\n")).not.toContain("fake:matches");
  expect(readFileSync(configPath, "utf8")).toBe(overlay);
  expect(readFileSync(globalPath, "utf8")).toBe(globalBefore);
  expect(loadConfig(repo, { globalDir })).toEqual(configBefore);
});
