import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";
export const ARTIFICIAL_ANALYSIS_CATALOG_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
export const CATALOG_CACHE_MAX_AGE_MS = 30 * 86_400_000;
export const CATALOG_REFRESH_TIMEOUT_MS = 10_000;
const ARTIFICIAL_ANALYSIS_PAGE_SIZE = 100;
const ARTIFICIAL_ANALYSIS_MAX_PAGES = 100;

export interface CatalogCache {
  schemaVersion: 1;
  fetchedAt: string;
  modelsDev: unknown;
  artificialAnalysis?: unknown;
}

export interface CatalogReadResult {
  catalog: CatalogCache;
  source: "cache" | "vendored";
  stale: boolean;
  warning?: string;
}

export interface CatalogModelEvidence {
  modelId: string;
  inputCostPerMtok?: number;
  outputCostPerMtok?: number;
  contextWindow?: number;
  outputWindow?: number;
  features: string[];
  intelligenceIndex?: number;
  intelligenceIndexVersion?: string;
}

type CatalogResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
export type CatalogFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<CatalogResponse>;

export interface RefreshCatalogOptions {
  repoRoot: string;
  fetcher?: CatalogFetcher;
  artificialAnalysisKey?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export interface RefreshCatalogResult {
  updated: boolean;
  catalog: CatalogReadResult;
  warning?: string;
}

const VENDORED_CATALOG: CatalogCache = {
  schemaVersion: 1,
  // Package fallback copied from https://models.dev/api.json on 2026-08-05. It is deliberately
  // small: an explicit refresh owns broad/current coverage, while doctor remains cache-only.
  fetchedAt: "2026-08-05T20:00:05.000Z",
  modelsDev: {
    anthropic: {
      id: "anthropic",
      models: {
        "claude-fable-5": { id: "claude-fable-5", cost: { input: 10, output: 50 }, limit: { context: 1_000_000, output: 128_000 }, reasoning: true, tool_call: true, structured_output: true, attachment: true },
        "claude-opus-4-8": { id: "claude-opus-4-8", cost: { input: 5, output: 25 }, limit: { context: 1_000_000, output: 128_000 }, reasoning: true, tool_call: true, structured_output: true, attachment: true },
        "claude-sonnet-5": { id: "claude-sonnet-5", cost: { input: 2, output: 10 }, limit: { context: 1_000_000, output: 128_000 }, reasoning: true, tool_call: true, structured_output: true, attachment: true },
        "claude-haiku-4-5-20251001": { id: "claude-haiku-4-5-20251001", cost: { input: 1, output: 5 }, limit: { context: 200_000, output: 64_000 }, reasoning: true, tool_call: true, structured_output: true, attachment: true },
      },
    },
  },
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const nonNegative = (value: unknown): number | undefined => {
  const n = finite(value);
  return n !== undefined && n >= 0 ? n : undefined;
};

const positive = (value: unknown): number | undefined => {
  const n = finite(value);
  return n !== undefined && n > 0 ? n : undefined;
};

const validCache = (value: unknown): value is CatalogCache => {
  const root = record(value);
  return root?.schemaVersion === 1
    && typeof root.fetchedAt === "string"
    && Number.isFinite(Date.parse(root.fetchedAt))
    && validModelsDevCatalog(root.modelsDev);
};

const validModelsDevCatalog = (value: unknown): boolean => {
  const providers = record(value);
  if (!providers || Object.keys(providers).length === 0) return false;
  return Object.values(providers).some((provider) => {
    const models = record(record(provider)?.models);
    return models !== undefined && Object.keys(models).length > 0;
  });
};

const staleAt = (fetchedAt: string, now: Date): boolean => {
  const age = now.getTime() - Date.parse(fetchedAt);
  return !Number.isFinite(age) || age > CATALOG_CACHE_MAX_AGE_MS;
};

export const catalogCachePath = (repoRoot: string): string => join(repoRoot, ".tickmarkr", "catalog-cache.json");

/**
 * Doctor's catalog seam: one synchronous local read with a vendored fail-open fallback.
 * This function deliberately has no callback, promise, fetch, or adapter dependency.
 */
export function readCachedCatalog(repoRoot: string, opts: { now?: () => Date } = {}): CatalogReadResult {
  const now = (opts.now ?? (() => new Date()))();
  try {
    const parsed: unknown = JSON.parse(readFileSync(catalogCachePath(repoRoot), "utf8"));
    if (!validCache(parsed)) throw new Error("catalog cache schema is invalid");
    return { catalog: parsed, source: "cache", stale: staleAt(parsed.fetchedAt, now) };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      catalog: VENDORED_CATALOG,
      source: "vendored",
      stale: staleAt(VENDORED_CATALOG.fetchedAt, now),
      ...(!missing ? { warning: error instanceof Error ? error.message : String(error) } : {}),
    };
  }
}

function providerModels(modelsDev: unknown, preferred?: string): Record<string, unknown>[] {
  const providers = record(modelsDev);
  if (!providers) return [];
  const entries = Object.entries(providers);
  const preferredEntries = preferred
    ? entries.filter(([key, value]) => key === preferred || record(value)?.id === preferred)
    : [];
  // Price is provider-specific. A provider-qualified query must never borrow an identically named
  // model from another provider, where subscription and metered costs can differ materially.
  const selected = preferred ? preferredEntries : entries;
  return selected
    .map(([, provider]) => record(record(provider)?.models))
    .filter((models): models is Record<string, unknown> => models !== undefined);
}

function findModelsDevModel(catalog: CatalogCache, provider: string | undefined, modelId: string): Record<string, unknown> | undefined {
  for (const models of providerModels(catalog.modelsDev, provider)) {
    const direct = record(models[modelId]);
    if (direct) return direct;
    const byId = Object.values(models).map(record).find((candidate) => candidate?.id === modelId);
    if (byId) return byId;
  }
  return undefined;
}

function artificialAnalysisRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const root = record(value);
  for (const key of ["data", "models", "results"]) {
    if (Array.isArray(root?.[key])) return root[key] as unknown[];
  }
  return [];
}

const canonicalCatalogIdentity = (identity: string): string =>
  identity.trim().toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/(?:19|20)\d{6}$/, "");

function artificialAnalysisIndex(
  value: unknown,
  identities: string[],
  provider?: string,
): { index: number; version?: string } | undefined {
  const root = record(value);
  const wanted = identities.map(canonicalCatalogIdentity).filter(Boolean);
  for (const raw of artificialAnalysisRows(value)) {
    const row = record(raw);
    if (!row) continue;
    const nestedModel = record(row.model);
    const creator = record(row.model_creator) ?? record(row.creator);
    const creatorIds = [row.provider, creator?.id, creator?.slug, creator?.name]
      .filter((candidate): candidate is string => typeof candidate === "string")
      .map(canonicalCatalogIdentity);
    if (provider && creatorIds.length > 0 && !creatorIds.includes(canonicalCatalogIdentity(provider))) continue;
    const ids = [row.id, row.model_id, row.slug, row.name, nestedModel?.id, nestedModel?.slug, nestedModel?.name]
      .filter((candidate): candidate is string => typeof candidate === "string")
      .map(canonicalCatalogIdentity);
    if (!ids.some((identity) => wanted.includes(identity))) continue;
    const evaluations = record(row.evaluations);
    for (const candidate of [
      evaluations?.artificial_analysis_intelligence_index,
      evaluations?.intelligence_index,
      row.artificial_analysis_intelligence_index,
      row.intelligence_index,
    ]) {
      const n = nonNegative(candidate);
      if (n !== undefined) {
        const version = root?.intelligence_index_version;
        return {
          index: n,
          ...((typeof version === "string" || typeof version === "number") ? { version: String(version) } : {}),
        };
      }
    }
  }
  return undefined;
}

/** Resolve the alias identity first; the floating alias is only a fallback when identity is unknown. */
export function resolveCatalogModel(
  catalog: CatalogCache,
  query: { provider?: string; model: string; resolvedModel?: string },
): CatalogModelEvidence | undefined {
  const modelId = query.resolvedModel ?? query.model;
  const model = findModelsDevModel(catalog, query.provider, modelId);
  if (!model) return undefined;
  const cost = record(model.cost);
  const limit = record(model.limit);
  const intelligence = artificialAnalysisIndex(catalog.artificialAnalysis, [
    modelId,
    ...(typeof model.name === "string" ? [model.name] : []),
  ], query.provider);
  const features = [
    ["reasoning", model.reasoning],
    ["tool-call", model.tool_call],
    ["structured-output", model.structured_output],
    ["attachment", model.attachment],
    ["open-weights", model.open_weights],
  ].filter((entry) => entry[1] === true).map((entry) => entry[0] as string);
  return {
    modelId,
    ...(nonNegative(cost?.input) !== undefined ? { inputCostPerMtok: nonNegative(cost?.input) } : {}),
    ...(nonNegative(cost?.output) !== undefined ? { outputCostPerMtok: nonNegative(cost?.output) } : {}),
    ...(positive(limit?.context) !== undefined ? { contextWindow: positive(limit?.context) } : {}),
    ...(positive(limit?.output) !== undefined ? { outputWindow: positive(limit?.output) } : {}),
    features,
    ...(intelligence !== undefined ? {
      intelligenceIndex: intelligence.index,
      ...(intelligence.version ? { intelligenceIndexVersion: intelligence.version } : {}),
    } : {}),
  };
}

async function fetchJson(
  fetcher: CatalogFetcher,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`catalog request timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const request = (async () => {
      const response = await fetcher(url, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`${url === MODELS_DEV_CATALOG_URL ? "models.dev" : "Artificial Analysis"} HTTP ${response.status}`);
      return response.json();
    })();
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeCatalogCache(repoRoot: string, catalog: CatalogCache): void {
  const path = catalogCachePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(catalog, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

async function fetchArtificialAnalysis(
  fetcher: CatalogFetcher,
  apiKey: string,
  timeoutMs: number,
): Promise<unknown> {
  const rows: unknown[] = [];
  let first: Record<string, unknown> | undefined;
  let lastPagination: Record<string, unknown> | undefined;
  let intelligenceIndexVersion: string | number | undefined;
  for (let page = 1; page <= ARTIFICIAL_ANALYSIS_MAX_PAGES; page++) {
    const url = `${ARTIFICIAL_ANALYSIS_CATALOG_URL}?page=${page}&page_size=${ARTIFICIAL_ANALYSIS_PAGE_SIZE}`;
    const value = await fetchJson(fetcher, url, { headers: { "x-api-key": apiKey } }, timeoutMs);
    const root = record(value);
    if (!root || !Array.isArray(root.data)) throw new Error("Artificial Analysis catalog schema is invalid");
    first ??= root;
    if (typeof root.intelligence_index_version === "string" || typeof root.intelligence_index_version === "number") {
      intelligenceIndexVersion ??= root.intelligence_index_version;
    }
    rows.push(...root.data);
    lastPagination = record(root.pagination);
    if (lastPagination?.has_more !== true) {
      return {
        ...first,
        ...(intelligenceIndexVersion !== undefined ? { intelligence_index_version: intelligenceIndexVersion } : {}),
        data: rows,
        ...(lastPagination ? { pagination: { ...lastPagination, has_more: false } } : {}),
      };
    }
  }
  throw new Error(`Artificial Analysis catalog exceeds ${ARTIFICIAL_ANALYSIS_MAX_PAGES} pages`);
}

/**
 * The named, explicit refresh path. No other function in this module can reach fetch.
 * A failed refresh preserves the previous cache byte-for-byte and returns it fail-open.
 */
export async function refreshCatalogCommand(opts: RefreshCatalogOptions): Promise<RefreshCatalogResult> {
  const now = opts.now ?? (() => new Date());
  const current = readCachedCatalog(opts.repoRoot, { now });
  try {
    const fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis) as CatalogFetcher;
    const timeoutMs = opts.timeoutMs ?? CATALOG_REFRESH_TIMEOUT_MS;
    const modelsDev = await fetchJson(fetcher, MODELS_DEV_CATALOG_URL, {}, timeoutMs);
    if (!validModelsDevCatalog(modelsDev)) throw new Error("models.dev catalog schema is invalid");

    const apiKey = opts.artificialAnalysisKey ?? process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim();
    const artificialAnalysis = apiKey
      ? await fetchArtificialAnalysis(fetcher, apiKey, timeoutMs)
      : undefined;

    const catalog: CatalogCache = {
      schemaVersion: 1,
      fetchedAt: now().toISOString(),
      modelsDev,
      ...(artificialAnalysis !== undefined ? { artificialAnalysis } : {}),
    };
    writeCatalogCache(opts.repoRoot, catalog);
    return { updated: true, catalog: readCachedCatalog(opts.repoRoot, { now }) };
  } catch (error) {
    return {
      updated: false,
      catalog: current,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}
