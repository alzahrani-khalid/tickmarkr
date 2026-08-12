import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import {
  catalogCachePath,
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
});

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

    const ordinary = await doctor(["--"], repo, [adapter], { banner: false });
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
    vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "configured-key");
    const refreshOutput = await doctor(["--refresh-catalog"], repo, [adapter], {
      banner: false,
      catalogNow: () => new Date("2026-08-05T01:00:00.000Z"),
    });
    expect(refreshOutput).toContain("model catalog refreshed");
    expect(network).toHaveBeenCalledTimes(3);
    expect(network.mock.calls[1][1]).toMatchObject({ headers: { "x-api-key": "configured-key" } });
    expect(String(network.mock.calls[1][0])).toContain("/free?page=1");
    expect(String(network.mock.calls[2][0])).toContain("/free?page=2");
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
      { name: "malformed-JSON", fetcher: vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad JSON"); } })) },
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
      await expect(doctor(["--"], repo, [adapter], { banner: false })).resolves.toContain("models.dev id=fake-2");
    }

    const cacheBeforeAaFailure = readFileSync(catalogCachePath(repo), "utf8");
    const aa401 = vi.fn()
      .mockResolvedValueOnce(response(refreshed.modelsDev))
      .mockResolvedValueOnce(response({}, 401));
    const partial = await refreshCatalogCommand({ repoRoot: repo, fetcher: aa401, artificialAnalysisKey: "configured-key" });
    expect(partial.updated).toBe(false);
    expect(partial.warning).toContain("Artificial Analysis HTTP 401");
    expect(readFileSync(catalogCachePath(repo), "utf8")).toBe(cacheBeforeAaFailure);

    writeCache(repo, fakeCatalog("2020-01-01T00:00:00.000Z"));
    const stale = readCachedCatalog(repo, { now: () => new Date("2026-08-05T00:00:00.000Z") });
    expect(stale.stale).toBe(true);
    await expect(doctor(["--"], repo, [adapter], { banner: false, catalogNow: () => new Date("2026-08-05T00:00:00.000Z") })).resolves.toContain("stale cache");

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
    expect(network).toHaveBeenCalledTimes(3);
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
      await doctor(["--"], repo, [adapter], { banner: false });
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
