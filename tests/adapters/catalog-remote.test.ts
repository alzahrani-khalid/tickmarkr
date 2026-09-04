import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import {
  ARTIFICIAL_ANALYSIS_CATALOG_URL,
  catalogCachePath,
  LIVEBENCH_CATEGORIES_URL,
  LIVEBENCH_TABLE_DATE,
  LIVEBENCH_TABLE_URL,
  MODELS_DEV_CATALOG_URL,
  readCachedCatalog,
  refreshCatalogCommand,
  resolveCatalogModel,
  type CatalogCache,
} from "../../src/adapters/catalog-remote.js";
import { CLAUDE_ALIAS_IDENTITY_STAMPS } from "../../src/adapters/claude-code.js";
import { catalogModelAdvisory, suggestOverlay } from "../../src/adapters/model-lints.js";
import type { AuthHealth, WorkerAdapter } from "../../src/adapters/types.js";
import { channelsFromConfig } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { loadConfig } from "../../src/config/config.js";
import { route } from "../../src/route/router.js";
import { makeRepo } from "../helpers/tmprepo.js";

type ModelFixture = {
  id: string;
  input: number;
  output: number;
  context: number;
  reasoning?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  attachment?: boolean;
  intelligence?: number;
  name?: string;
  family?: string;
};

const catalogFixture = (models: ModelFixture[], fetchedAt = "2026-08-05T00:00:00.000Z"): CatalogCache => ({
  schemaVersion: 1,
  fetchedAt,
  modelsDev: {
    anthropic: {
      id: "anthropic",
      models: Object.fromEntries(models.map((model) => [model.id, {
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        ...(model.family ? { family: model.family } : {}),
        cost: { input: model.input, output: model.output },
        limit: { context: model.context, output: 32_000 },
        reasoning: model.reasoning ?? true,
        tool_call: model.toolCall ?? true,
        structured_output: model.structuredOutput ?? false,
        attachment: model.attachment ?? false,
      }])),
    },
  },
  artificialAnalysis: {
    intelligence_index_version: "2026-08-01",
    data: models.filter((model) => model.intelligence !== undefined).map((model) => ({
      id: `00000000-0000-4000-8000-${model.id.padEnd(12, "0").slice(0, 12)}`,
      slug: model.id,
      model_creator: { slug: "anthropic", name: "Anthropic" },
      evaluations: { artificial_analysis_intelligence_index: model.intelligence },
    })),
  },
});

const writeCache = (repo: string, cache: CatalogCache): void => {
  const path = catalogCachePath(repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2) + "\n");
};

const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

// LiveBench fixtures. The column order is deliberately NOT category order: an aggregate built from
// a hardcoded column list would still look plausible, so the categories file is the only map.
const LIVEBENCH_COLUMNS = ["code_completion", "code_generation", "javascript", "python", "typescript"] as const;
const liveBenchCsv = (rows: { model: string; scores: Record<string, number> }[]): string =>
  [`model,${LIVEBENCH_COLUMNS.join(",")}`, ...rows.map(({ model, scores }) =>
    [model, ...LIVEBENCH_COLUMNS.map((column) => scores[column] ?? "")].join(","))].join("\n") + "\n";

const LIVEBENCH_CATEGORIES = {
  "Agentic Coding": ["javascript", "typescript", "python"],
  Coding: ["code_generation", "code_completion"],
  Reasoning: ["zebra_puzzle"],
};
// python moves from Agentic Coding into Coding — both means must move with it.
const RESHUFFLED_CATEGORIES = {
  "Agentic Coding": ["javascript", "typescript"],
  Coding: ["code_generation", "code_completion", "python"],
  Reasoning: ["zebra_puzzle"],
};
const FAKE_2_SCORES = { code_completion: 96, code_generation: 90, javascript: 60, python: 80, typescript: 70 };

type StubResponse = ReturnType<typeof response>;

/** Routes by URL rather than call order, so a leg that never fires is a missing call, not a shift. */
const routedFetcher = (routes: {
  modelsDev?: () => StubResponse;
  table?: () => StubResponse;
  categories?: () => StubResponse;
  aa?: () => StubResponse;
} = {}) => vi.fn(async (input: string | URL | Request): Promise<StubResponse> => {
  const url = String(input);
  if (url.startsWith(MODELS_DEV_CATALOG_URL)) return (routes.modelsDev ?? (() => response(fakeCatalog().modelsDev)))();
  if (url.startsWith(LIVEBENCH_TABLE_URL)) return (routes.table ?? (() => response(liveBenchCsv([{ model: "fake-2", scores: FAKE_2_SCORES }]))))();
  if (url.startsWith(LIVEBENCH_CATEGORIES_URL)) return (routes.categories ?? (() => response(LIVEBENCH_CATEGORIES)))();
  return (routes.aa ?? (() => response({ pagination: { has_more: false }, data: [] })))();
});

const requestedUrls = (fetcher: { mock: { calls: unknown[][] } }): string[] =>
  fetcher.mock.calls.map((call) => String(call[0]));

const fakeCatalog = (fetchedAt = "2026-08-05T00:00:00.000Z") => catalogFixture([
  { id: "fake-2", input: 0, output: 0, context: 200_000, toolCall: true },
], fetchedAt);

const fakeOverlay = `tiers:
  fake:
    vendor: anthropic
    channel: api
    models:
      fake-1: frontier
routing:
  map:
    implement:
      pin: { via: fake, model: fake-1 }
`;

const installed = (models: string[]): AuthHealth => ({ installed: true, authed: true, models });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("cache-only model capability catalog", () => {
  test("test: a detected model resolves to catalog evidence through its alias identity, proven member by member over the closed set of claude-code aliases — a fable fixture, an opus fixture, a sonnet fixture and a haiku fixture — each landing the cost and context of its resolved id rather than the alias", () => {
    const members = [
      { alias: "fable", identity: CLAUDE_ALIAS_IDENTITY_STAMPS.fable, input: 3, output: 18.5, context: 1_000_000 },
      { alias: "opus", identity: CLAUDE_ALIAS_IDENTITY_STAMPS.opus, input: 1.5, output: 9.25, context: 1_000_000 },
      { alias: "sonnet", identity: CLAUDE_ALIAS_IDENTITY_STAMPS.sonnet, input: 3, output: 15, context: 1_000_000 },
      { alias: "haiku", identity: CLAUDE_ALIAS_IDENTITY_STAMPS.haiku, input: 1.09, output: 5.43, context: 200_000 },
    ] as const;
    const aliases = members.map(({ alias }) => ({ id: alias, input: 99, output: 99, context: 99 }));
    const cache = catalogFixture([...aliases, ...members.map(({ identity: id, input, output, context }) => ({ id, input, output, context }))]);

    for (const member of members) {
      const evidence = resolveCatalogModel(cache, {
        provider: "anthropic",
        model: member.alias,
        resolvedModel: member.identity,
      });
      expect(evidence, member.alias).toMatchObject({
        modelId: member.identity,
        catalogId: `anthropic/${member.identity}`,
        inputCostPerMtok: member.input,
        outputCostPerMtok: member.output,
        contextWindow: member.context,
        features: ["reasoning", "tool-call"],
      });
      expect(evidence?.modelId).not.toBe(member.alias);
    }
  });

  // D-OBS-11 follow-up: the kimi/cursor blanket-uncoverage class. A hint matching NO
  // catalog provider must fall open to the full scan, and CLI-namespaced ids resolve
  // via the bare segment after the last "/".
  test("a provider hint matching no catalog provider falls open to the full scan instead of zeroing coverage", () => {
    const cache = catalogFixture([{ id: "kimi-k3", input: 1, output: 4, context: 1_048_576 }]);
    expect(resolveCatalogModel(cache, { provider: "moonshot", model: "kimi-k3" })?.contextWindow).toBe(1_048_576);
  });

  test("a hint that DOES match a provider still never borrows an identically named model elsewhere", () => {
    const cache = catalogFixture([{ id: "shared-id", input: 1, output: 4, context: 100 }]);
    (cache.modelsDev as Record<string, unknown>)["other"] = { id: "other", models: {} };
    expect(resolveCatalogModel(cache, { provider: "other", model: "shared-id" })).toBeUndefined();
  });

  test("a CLI-namespaced id (kimi-code/k3) resolves through its bare segment", () => {
    const cache = catalogFixture([{ id: "k3", input: 0, output: 0, context: 1_048_576 }]);
    const evidence = resolveCatalogModel(cache, { provider: "kimi-for-coding", model: "kimi-code/k3" });
    expect(evidence?.contextWindow).toBe(1_048_576);
  });

  test("bare-segment retry runs only after full-id lookups miss — a full-id match wins", () => {
    const cache = catalogFixture([
      { id: "ns/model-x", input: 9, output: 9, context: 111 },
      { id: "model-x", input: 1, output: 1, context: 222 },
    ]);
    expect(resolveCatalogModel(cache, { provider: "anthropic", model: "ns/model-x" })?.contextWindow).toBe(111);
  });

  test("test: no suggested tier is ever written into live config, and a suggestion carries its evidence into the provenance note the operator must confirm", () => {
    const repo = makeRepo({ "keep.txt": "x" });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), fakeOverlay);
    writeCache(repo, fakeCatalog());
    const before = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
    const cfg = loadConfig(repo);
    const loaded = readCachedCatalog(repo);
    const advisory = catalogModelAdvisory(cfg, loaded, "fake", "fake-2");
    const health = { fake: installed(["fake-1", "fake-2"]) };
    const adapter = { id: "fake", vendor: "anthropic", listModels: async () => [], probe: async () => installed([]) } as unknown as WorkerAdapter;
    const fragment = suggestOverlay(cfg, health, [adapter], ".tickmarkr", { catalog: loaded });

    expect(advisory.suggestion).toMatchObject({ tier: "cheap", kind: "inference", basis: "price" });
    expect(advisory.suggestion?.provenanceNote).toContain("SUGGESTED cheap");
    expect(advisory.suggestion?.provenanceNote).toContain("inference, not a measurement");
    expect(advisory.suggestion?.provenanceNote).toContain("models.dev id=fake-2");
    expect(advisory.suggestion?.provenanceNote).toContain("cost=$0/$0 per Mtok");
    expect(advisory.suggestion?.provenanceNote).toContain("context=200000");
    expect(advisory.suggestion?.provenanceNote).toContain("operator confirmation required");
    expect(fragment).toContain("SUGGESTED cheap");
    const parsed = parse(fragment) as { tiers: { fake: { models: Record<string, unknown> | null } } };
    expect(parsed.tiers.fake.models?.["fake-2"]).toBeUndefined();
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toBe(before);
  });

  test("test: an ordinary doctor run makes ZERO CATALOG-network calls and resolves every model from the cached catalog, while the named refresh command is the only path that fetches a catalog and the ordinary adapter, auth and model probes are untouched, and catalog failure never fails doctor nor changes a routing verdict, proven over the closed set of failure shapes — an offline fixture, a 401 fixture, a 500 fixture, a timeout fixture, a malformed-JSON fixture, and a stale-cache fixture", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), fakeOverlay);
    writeCache(repo, fakeCatalog());
    const probe = vi.fn(async () => installed([]));
    const listModels = vi.fn(async () => ["fake-1", "fake-2"]);
    const headlessCommand = vi.fn(() => "printf OK");
    const adapter = {
      id: "fake",
      vendor: "anthropic",
      probe,
      listModels,
      channels: (cfg: ReturnType<typeof loadConfig>) => channelsFromConfig("fake", cfg),
      headlessCommand,
    } as WorkerAdapter;
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const cfgBefore = loadConfig(repo);
    const task = { id: "T17", title: "catalog", goal: "catalog", shape: "implement", complexity: 4, acceptance: ["catalog"] } as const;
    const routeBefore = route(task, cfgBefore, adapter.channels!(cfgBefore));

    const ordinary = await doctor(["--"], repo, [adapter], { banner: false, catalogNow: () => new Date("2026-08-05T00:00:00.000Z") });
    expect(network).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledOnce();
    expect(listModels).toHaveBeenCalledOnce();
    expect(headlessCommand).toHaveBeenCalled();
    expect(ordinary).toContain("catalog · fake-2");
    expect(ordinary).toContain("models.dev id=fake-2");

    const refreshed = catalogFixture([
      { id: "fake-2", input: 0, output: 0, context: 200_000, toolCall: true, intelligence: 72 },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", input: 1, output: 5, context: 200_000 },
    ], "2026-08-05T01:00:00.000Z");
    network.mockResolvedValueOnce(response(refreshed.modelsDev));
    network.mockResolvedValueOnce(response({
      pagination: { page: 1, page_size: 1, total_pages: 2, has_more: true },
      data: [{ id: "00000000-0000-4000-8000-other0000000", slug: "other-model", evaluations: { artificial_analysis_intelligence_index: 1 } }],
    }));
    network.mockResolvedValueOnce(response({
      pagination: { page: 2, page_size: 1, total_pages: 2, has_more: false },
      intelligence_index_version: "2026-08-01",
      data: [
        ...(refreshed.artificialAnalysis as { data: unknown[] }).data,
        {
          id: "0198cafe-7a2d-7c36-87db-30f9d0f3d83c",
          slug: "claude-haiku-4-5",
          name: "Claude Haiku 4.5 (2025)",
          model_creator: { slug: "anthropic", name: "Anthropic" },
          evaluations: { artificial_analysis_intelligence_index: 61 },
        },
      ],
    }));
    network.mockResolvedValueOnce(response(liveBenchCsv([{ model: "fake-2", scores: FAKE_2_SCORES }])));
    network.mockResolvedValueOnce(response(LIVEBENCH_CATEGORIES));
    vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "configured-key");
    const refreshOutput = await doctor(["--refresh-catalog"], repo, [adapter], {
      banner: false,
      catalogNow: () => new Date("2026-08-05T01:00:00.000Z"),
    });
    expect(refreshOutput).toContain("model catalog refreshed");
    expect(network).toHaveBeenCalledTimes(5);
    expect(network.mock.calls[1][1]).toMatchObject({ headers: { "x-api-key": "configured-key" } });
    expect(String(network.mock.calls[1][0])).toContain("/api/v2/data/llms/models?page=1");
    expect(String(network.mock.calls[2][0])).toContain("/api/v2/data/llms/models?page=2");
    expect(String(network.mock.calls[3][0])).toBe(LIVEBENCH_TABLE_URL);
    expect(String(network.mock.calls[4][0])).toBe(LIVEBENCH_CATEGORIES_URL);
    expect(probe).toHaveBeenCalledOnce();
    expect(listModels).toHaveBeenCalledOnce();
    expect(resolveCatalogModel(readCachedCatalog(repo).catalog, { provider: "anthropic", model: "fake-2" })?.intelligenceIndex).toBe(72);
    expect(resolveCatalogModel(readCachedCatalog(repo).catalog, {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    })).toMatchObject({ intelligenceIndex: 61, intelligenceIndexVersion: "2026-08-01" });

    const failures = [
      { name: "offline", fetcher: vi.fn(async () => { throw new Error("offline"); }) },
      { name: "401", fetcher: vi.fn(async () => response({}, 401)) },
      { name: "500", fetcher: vi.fn(async () => response({}, 500)) },
      { name: "timeout", fetcher: vi.fn(() => new Promise<never>(() => {})), timeoutMs: 5 },
      { name: "malformed-JSON", fetcher: vi.fn(async () => ({ ok: true, status: 200, text: async () => "", json: async () => { throw new SyntaxError("bad JSON"); } })) },
    ] as const;
    for (const failure of failures) {
      const cacheBefore = readFileSync(catalogCachePath(repo), "utf8");
      const refreshing = refreshCatalogCommand({ repoRoot: repo, fetcher: failure.fetcher, timeoutMs: "timeoutMs" in failure ? failure.timeoutMs : undefined });
      const result = failure.name === "timeout"
        ? await Promise.race([refreshing, new Promise<{ updated: "unsettled"; warning: string }>((resolve) => setTimeout(() => resolve({ updated: "unsettled", warning: "did not settle" }), 100))])
        : await refreshing;
      expect(result.updated, failure.name).toBe(false);
      expect(result.warning, failure.name).toContain(failure.name === "malformed-JSON" ? "bad JSON" : failure.name === "timeout" ? "timed out" : failure.name);
      expect(readFileSync(catalogCachePath(repo), "utf8"), failure.name).toBe(cacheBefore);
      await expect(doctor(["--"], repo, [adapter], { banner: false, catalog: readCachedCatalog(repo) })).resolves.toContain("models.dev id=fake-2");
    }

    const cacheBeforeAaFailure = readFileSync(catalogCachePath(repo), "utf8");
    const aa401 = vi.fn()
      .mockResolvedValueOnce(response(refreshed.modelsDev))
      .mockResolvedValueOnce(response({}, 401));
    const partial = await refreshCatalogCommand({ repoRoot: repo, fetcher: aa401, artificialAnalysisKey: "configured-key" });
    expect(partial.updated).toBe(true);
    expect(partial.warning).toContain("Artificial Analysis HTTP 401");
    expect(readFileSync(catalogCachePath(repo), "utf8")).toBe(cacheBeforeAaFailure);

    writeCache(repo, fakeCatalog("2020-01-01T00:00:00.000Z"));
    const stale = readCachedCatalog(repo, { now: () => new Date("2026-08-05T00:00:00.000Z") });
    expect(stale.stale).toBe(true);
    await expect(doctor(["--"], repo, [adapter], { banner: false, catalog: stale })).resolves.toContain("stale cache");

    writeCache(repo, { schemaVersion: 1, fetchedAt: "2026-08-05T00:00:00.000Z", modelsDev: {} });
    const emptyCache = readCachedCatalog(repo, { now: () => new Date("2026-08-05T00:00:00.000Z") });
    expect(emptyCache.source).toBe("vendored");
    expect(emptyCache.warning).toContain("catalog cache schema is invalid");
    expect(resolveCatalogModel(emptyCache.catalog, {
      provider: "anthropic",
      model: "fable",
      resolvedModel: CLAUDE_ALIAS_IDENTITY_STAMPS.fable,
    })?.modelId).toBe(CLAUDE_ALIAS_IDENTITY_STAMPS.fable);

    const cfgAfter = loadConfig(repo);
    expect(network).toHaveBeenCalledTimes(5);
    expect(cfgAfter).toEqual(cfgBefore);
    expect(route(task, cfgAfter, adapter.channels!(cfgAfter))).toEqual(routeBefore);
  });

  test("test: a subscription-billed channel reporting zero cost yields no price-derived tier suggestion, while a metered channel with the same measured context does yield one", () => {
    const repo = makeRepo({ "keep.txt": "x" });
    writeCache(repo, fakeCatalog());
    const cached = readCachedCatalog(repo);
    const cfg = loadConfig(repo);
    // D-OBS-11: a vendor hint matching NO catalog provider fails OPEN to the full scan
    // (the old uncovered-by-construction contract blanket-hid whole adapters — kimi, cursor).
    // The no-borrow rule is preserved for hints that DO match: see the shared-id test above.
    cfg.tiers.fake = { vendor: "not-a-catalog-provider", channel: "api", models: {} };
    expect(catalogModelAdvisory(cfg, cached, "fake", "fake-2").coverage).toBe("covered");
    cfg.tiers.fake = { vendor: "anthropic", channel: "sub", models: {} };
    const subscription = catalogModelAdvisory(cfg, cached, "fake", "fake-2");
    cfg.tiers.fake = { ...cfg.tiers.fake, channel: "api" };
    const metered = catalogModelAdvisory(cfg, cached, "fake", "fake-2");

    expect(subscription.evidence?.contextWindow).toBe(200_000);
    expect(subscription.suggestion).toBeUndefined();
    expect(subscription.display).toContain("subscription billing; no price-derived suggestion");
    expect(metered.evidence?.contextWindow).toBe(subscription.evidence?.contextWindow);
    expect(metered.suggestion).toMatchObject({ tier: "cheap", basis: "price" });
  });

  test("test: a model absent from every catalog yields no suggestion and is reported as uncovered rather than as cheap", () => {
    const repo = makeRepo({ "keep.txt": "x" });
    writeCache(repo, fakeCatalog());
    const cfg = loadConfig(repo);
    cfg.tiers.fake = { vendor: "anthropic", channel: "api", models: {} };
    const advisory = catalogModelAdvisory(cfg, readCachedCatalog(repo), "fake", "not-in-any-catalog");

    expect(advisory.coverage).toBe("uncovered");
    expect(advisory.evidence).toBeUndefined();
    expect(advisory.suggestion).toBeUndefined();
    expect(advisory.display).toContain("uncovered by cached catalogs");
    expect(advisory.display).not.toContain("cheap");
  });

  test("no SUGGESTED tier reaches config without an operator keystroke, and no suggestion presents an inference as a measurement", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), fakeOverlay);
    writeCache(repo, fakeCatalog());
    const configBefore = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
    const adapter = {
      id: "fake",
      vendor: "anthropic",
      probe: async () => installed([]),
      listModels: async () => ["fake-1", "fake-2"],
      channels: (cfg: ReturnType<typeof loadConfig>) => channelsFromConfig("fake", cfg),
      headlessCommand: () => "printf OK",
    } as WorkerAdapter;
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const noColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    try {
      await doctor(["--"], repo, [adapter], { banner: false, catalog: readCachedCatalog(repo) });
    } finally {
      if (noColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = noColor;
      if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }

    const suggestion = readFileSync(join(repo, ".tickmarkr", "doctor-overlay.yaml"), "utf8");
    expect(suggestion).toContain("SUGGESTED cheap");
    expect(suggestion).toContain("inference, not a measurement");
    expect(suggestion).toMatch(/^\s*# fake-2: \?\?\?/m);
    expect(suggestion).not.toMatch(/^\s*fake-2:\s*(cheap|mid|frontier)/m);
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toBe(configBefore);
  });
});

// The four named-test oracles below live at TOP LEVEL, titled verbatim: the acceptance gate anchors
// its -t filter (^…$) to the runner-visible full name, so a describe title would prefix them out of
// their own criterion (src/gates/acceptance.ts testFilterPattern).
test("a refresh against stubbed LiveBench endpoints stores liveBench tableDate categories and rows and resolveCatalogModel returns agenticCodingScore codingScore and evidenceDate whose values move when a reshuffled categories fixture reassigns tasks between categories, so aggregates from a hardcoded column list fail", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  // No key: the LiveBench leg is unconditional and carries evidence on its own (D-1).
  vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "");
  const fetcher = routedFetcher();
  const refreshed = await refreshCatalogCommand({ repoRoot: repo, fetcher });

  expect(refreshed.updated).toBe(true);
  expect(refreshed.warning).toBeUndefined();
  expect(requestedUrls(fetcher)).toEqual(expect.arrayContaining([
    "https://livebench.ai/table_2026_06_25.csv",
    "https://livebench.ai/categories_2026_06_25.json",
  ]));
  expect(requestedUrls(fetcher).some((url) => url.includes("artificialanalysis.ai"))).toBe(false);

  const stored = readCachedCatalog(repo).catalog.liveBench as { tableDate: string; categories: unknown; rows: unknown[] };
  expect(stored.tableDate).toBe(LIVEBENCH_TABLE_DATE);
  expect(stored.categories).toEqual(LIVEBENCH_CATEGORIES);
  expect(stored.rows).toEqual([{ model: "fake-2", ...FAKE_2_SCORES }]);

  const evidence = resolveCatalogModel(readCachedCatalog(repo).catalog, { provider: "anthropic", model: "fake-2" });
  expect(evidence?.agenticCodingScore).toBeCloseTo(70, 6); // mean(javascript 60, typescript 70, python 80)
  expect(evidence?.codingScore).toBeCloseTo(93, 6); // mean(code_generation 90, code_completion 96)
  expect(evidence?.evidenceDate).toBe(LIVEBENCH_TABLE_DATE);

  const reshuffled = await refreshCatalogCommand({
    repoRoot: repo,
    fetcher: routedFetcher({ categories: () => response(RESHUFFLED_CATEGORIES) }),
  });
  expect(reshuffled.updated).toBe(true);
  const moved = resolveCatalogModel(readCachedCatalog(repo).catalog, { provider: "anthropic", model: "fake-2" });
  // Same table, same row, same code: only the categories file moved python across.
  expect(moved?.agenticCodingScore).toBeCloseTo(65, 6); // mean(60, 70)
  expect(moved?.codingScore).toBeCloseTo(88.6667, 3); // mean(90, 96, 80)
  expect(moved?.evidenceDate).toBe(LIVEBENCH_TABLE_DATE);
});

test("a fleet id resolves the highest-effort LiveBench row among its suffix variants while glm-5 resolves nothing from a table containing only glm-5.2, so a bare startsWith prefix match or a lowest-effort pick fails", () => {
  // Row order defeats both "first row wins" and "last row wins": the max-effort row is neither.
  // `family: "glm"` is verbatim real models.dev (zhipuai carries it on EVERY glm-*): a matcher that
  // admits family as an identity resolves glm-5 straight into glm-5.2's row.
  const cache: CatalogCache = {
    ...catalogFixture([
      { id: "glm-5.2", input: 1, output: 4, context: 200_000, family: "glm" },
      { id: "glm-5", input: 1, output: 4, context: 200_000, family: "glm" },
    ]),
    liveBench: {
      tableDate: LIVEBENCH_TABLE_DATE,
      categories: LIVEBENCH_CATEGORIES,
      rows: [
        { model: "glm-5.2-low", javascript: 10, typescript: 10, python: 10, code_generation: 10, code_completion: 10 },
        { model: "glm-5.2-max-effort", javascript: 90, typescript: 90, python: 90, code_generation: 80, code_completion: 80 },
        { model: "glm-5.2-thinking-auto-medium-effort", javascript: 50, typescript: 50, python: 50, code_generation: 50, code_completion: 50 },
      ],
    },
  };

  const best = resolveCatalogModel(cache, { provider: "anthropic", model: "glm-5.2" });
  expect(best?.agenticCodingScore).toBeCloseTo(90, 6);
  expect(best?.codingScore).toBeCloseTo(80, 6);
  expect(best?.evidenceDate).toBe(LIVEBENCH_TABLE_DATE);

  // "glm-5" is a bare-startsWith prefix of "glm-5.2" — the residue ".2" is not an effort suffix.
  const shorter = resolveCatalogModel(cache, { provider: "anthropic", model: "glm-5" });
  expect(shorter?.modelId).toBe("glm-5");
  expect(shorter?.agenticCodingScore).toBeUndefined();
  expect(shorter?.codingScore).toBeUndefined();
  expect(shorter?.evidenceDate).toBeUndefined();

  // Real fleet member, verbatim real models.dev shape (kimi-for-coding/k3): the id is the bare
  // suffix `k3` and LiveBench spells the row `kimi-k3`. The per-model `name` bridges them; the
  // model's real `family` is a LINEAGE label and must not be what carries the match.
  const kimi: CatalogCache = {
    schemaVersion: 1,
    fetchedAt: "2026-08-05T00:00:00.000Z",
    modelsDev: {
      "kimi-for-coding": {
        id: "kimi-for-coding",
        models: { k3: { id: "k3", name: "Kimi K3", cost: { input: 1, output: 4 }, limit: { context: 256_000, output: 32_000 } } },
      },
    },
    liveBench: {
      tableDate: LIVEBENCH_TABLE_DATE,
      categories: LIVEBENCH_CATEGORIES,
      rows: [{ model: "kimi-k3", javascript: 40, typescript: 50, python: 60, code_generation: 30, code_completion: 20 }],
    },
  };
  const k3 = resolveCatalogModel(kimi, { provider: "kimi-for-coding", model: "k3" });
  expect(k3?.agenticCodingScore).toBeCloseTo(50, 6); // mean(40, 50, 60)
  expect(k3?.codingScore).toBeCloseTo(25, 6); // mean(30, 20)
  expect(k3?.evidenceDate).toBe(LIVEBENCH_TABLE_DATE);

  // Broad-family negative: `family: "gpt"` is verbatim real models.dev on openai/gpt-4o, and the
  // table benchmarks a DIFFERENT model. Admitting family as an identity hands this unbenchmarked
  // model gpt-5.6's scores and evidenceDate; only its own id and name may speak for it.
  const broadFamily: CatalogCache = {
    schemaVersion: 1,
    fetchedAt: "2026-08-05T00:00:00.000Z",
    modelsDev: {
      openai: {
        id: "openai",
        models: { "gpt-4o": { id: "gpt-4o", name: "GPT-4o", family: "gpt", cost: { input: 2.5, output: 10 }, limit: { context: 128_000, output: 16_384 } } },
      },
    },
    liveBench: {
      tableDate: LIVEBENCH_TABLE_DATE,
      categories: LIVEBENCH_CATEGORIES,
      rows: [{ model: "gpt-5.6-max-effort", javascript: 95, typescript: 95, python: 95, code_generation: 95, code_completion: 95 }],
    },
  };
  const unbenchmarked = resolveCatalogModel(broadFamily, { provider: "openai", model: "gpt-4o" });
  expect(unbenchmarked?.contextWindow).toBe(128_000); // resolved, just not LiveBench-scored
  expect(unbenchmarked?.agenticCodingScore).toBeUndefined();
  expect(unbenchmarked?.codingScore).toBeUndefined();
  expect(unbenchmarked?.evidenceDate).toBeUndefined();
});

test("test: resolveCatalogModel for zai/glm-5.3 against a cache whose gateway record is named GLM-5.3 (Z AI) resolves the glm-5.3 LiveBench row and anthropic/claude-fable-5-1 resolves the claude-fable-5-1 models.dev record and the claude-fable-5-1-max-effort LiveBench row while zai/glm-5 resolves none whereas a resolver that offers only the full id and the display name fails", () => {
  const cache: CatalogCache = {
    schemaVersion: 1,
    fetchedAt: "2026-09-03T00:00:00.000Z",
    modelsDev: {
      anthropic: {
        id: "anthropic",
        models: {
          "claude-fable-5-1": { id: "claude-fable-5-1", name: "Claude Fable 5.1", cost: { input: 2, output: 10 }, limit: { context: 200_000 } },
        },
      },
      zhipuai: {
        id: "zhipuai",
        models: {
          "glm-5.3": { id: "glm-5.3", name: "GLM-5.3 (Z AI)", cost: { input: 1, output: 4 }, limit: { context: 200_000 } },
          "glm-5": { id: "glm-5", name: "GLM 5", cost: { input: 1, output: 4 }, limit: { context: 200_000 } },
        },
      },
    },
    liveBench: {
      tableDate: LIVEBENCH_TABLE_DATE,
      categories: LIVEBENCH_CATEGORIES,
      rows: [
        { model: "glm-5-3", javascript: 61, typescript: 62, python: 63, code_generation: 70, code_completion: 72 },
        { model: "claude-fable-5-1-max-effort", javascript: 81, typescript: 82, python: 83, code_generation: 90, code_completion: 92 },
      ],
    },
  };

  expect(resolveCatalogModel(cache, { provider: "zai", model: "zai/glm-5.3" })).toMatchObject({
    catalogId: "zhipuai/glm-5.3",
    agenticCodingScore: 62,
  });
  expect(resolveCatalogModel(cache, { provider: "anthropic", model: "anthropic/claude-fable-5-1" })).toMatchObject({
    catalogId: "anthropic/claude-fable-5-1",
    agenticCodingScore: 82,
  });
  expect(resolveCatalogModel(cache, { provider: "zai", model: "zai/glm-5" })?.agenticCodingScore).toBeUndefined();

  const legacyOffers = ["zai/glm-5.3", "GLM-5.3 (Z AI)"].map((id) => id.toLowerCase().replace(/\s+/g, "-"));
  expect(legacyOffers.some((id) => "glm-5-3".startsWith(id))).toBe(false);
});

test("a LiveBench fetch that fails and one that parses to zero rows each preserve the previous liveBench section while modelsDev still updates and the warning names LiveBench, so reading an empty probe as an empty fleet or losing the models.dev refresh fails", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "");
  await refreshCatalogCommand({ repoRoot: repo, fetcher: routedFetcher() });
  const priorLiveBench = readCachedCatalog(repo).catalog.liveBench;
  expect(priorLiveBench).toBeDefined();

  const laterModelsDev = () => response({
    anthropic: {
      id: "anthropic",
      models: { "later-model": { id: "later-model", cost: { input: 2, output: 8 }, limit: { context: 4_096, output: 512 } } },
    },
  });
  const legs = [
    { name: "fetch failure", routes: { modelsDev: laterModelsDev, table: () => response("", 500) } },
    { name: "zero rows", routes: { modelsDev: laterModelsDev, table: () => response(`model,${LIVEBENCH_COLUMNS.join(",")}\n`) } },
    // Truncated payload: a model-only row scores nothing, so it is zero rows, not a one-model fleet.
    { name: "scoreless rows", routes: { modelsDev: laterModelsDev, table: () => response("model,javascript\nfoo,\n") } },
    // Scores present but the categories file cannot address them — nothing to aggregate.
    { name: "unusable categories", routes: { modelsDev: laterModelsDev, categories: () => response({}) } },
  ] as const;

  for (const leg of legs) {
    const result = await refreshCatalogCommand({ repoRoot: repo, fetcher: routedFetcher(leg.routes) });
    expect(result.updated, leg.name).toBe(true);
    expect(String(result.warning), leg.name).toContain("LiveBench");
    const after = readCachedCatalog(repo).catalog;
    expect(after.liveBench, leg.name).toEqual(priorLiveBench);
    expect(resolveCatalogModel(after, { provider: "anthropic", model: "later-model" })?.outputCostPerMtok, leg.name).toBe(8);
  }
});

test("the AA leg requests the documented data llms models route and resolved evidence carries codingIndex from artificial_analysis_coding_index beside the intelligence index, so the legacy language models free route or a dropped coding index fails", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  const fetcher = routedFetcher({
    aa: () => response({
      pagination: { page: 1, page_size: 100, has_more: false },
      intelligence_index_version: "4.1.1",
      data: [{
        id: "00000000-0000-4000-8000-fake20000000",
        slug: "fake-2",
        model_creator: { slug: "anthropic", name: "Anthropic" },
        evaluations: { artificial_analysis_intelligence_index: 63.05, artificial_analysis_coding_index: 48.5 },
      }],
    }),
  });
  const result = await refreshCatalogCommand({ repoRoot: repo, fetcher, artificialAnalysisKey: "configured-key" });

  expect(result.updated).toBe(true);
  expect(ARTIFICIAL_ANALYSIS_CATALOG_URL).toBe("https://artificialanalysis.ai/api/v2/data/llms/models");
  const aaUrls = requestedUrls(fetcher).filter((url) => url.includes("artificialanalysis.ai"));
  expect(aaUrls[0]).toContain("/api/v2/data/llms/models?page=1");
  expect(aaUrls.some((url) => url.includes("/language/models/free"))).toBe(false);

  const evidence = resolveCatalogModel(readCachedCatalog(repo).catalog, { provider: "anthropic", model: "fake-2" });
  expect(evidence).toMatchObject({
    intelligenceIndex: 63.05,
    intelligenceIndexVersion: "4.1.1",
    codingIndex: 48.5,
  });
});
