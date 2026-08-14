import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";
export const ARTIFICIAL_ANALYSIS_CATALOG_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
// LiveBench ships one dated CSV per question-set release plus the category->task map that defines
// the aggregates. Fetch the deployed site, NEVER raw.githubusercontent.com: same filename, 15 fewer
// models on raw. ponytail: hand-bumped constant; doctor lints its age against the release listing.
export const LIVEBENCH_TABLE_DATE = "2026_06_25";
export const LIVEBENCH_TABLE_URL = `https://livebench.ai/table_${LIVEBENCH_TABLE_DATE}.csv`;
export const LIVEBENCH_CATEGORIES_URL = `https://livebench.ai/categories_${LIVEBENCH_TABLE_DATE}.json`;
export const CATALOG_CACHE_MAX_AGE_MS = 30 * 86_400_000;
export const CATALOG_REFRESH_TIMEOUT_MS = 10_000;
const ARTIFICIAL_ANALYSIS_PAGE_SIZE = 100;
const ARTIFICIAL_ANALYSIS_MAX_PAGES = 100;

export interface CatalogCache {
  schemaVersion: 1;
  fetchedAt: string;
  modelsDev: unknown;
  artificialAnalysis?: unknown;
  // Optional, so schemaVersion stays 1 and validCache still requires only modelsDev.
  liveBench?: unknown;
}

export interface CatalogReadResult {
  catalog: CatalogCache;
  source: "cache" | "vendored";
  stale: boolean;
  warning?: string;
}

export interface CatalogModelEvidence {
  modelId: string;
  catalogId: string;
  inputCostPerMtok?: number;
  outputCostPerMtok?: number;
  contextWindow?: number;
  outputWindow?: number;
  features: string[];
  intelligenceIndex?: number;
  intelligenceIndexVersion?: string;
  codingIndex?: number;
  agenticCodingScore?: number;
  codingScore?: number;
  evidenceDate?: string;
}

type CatalogResponse = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
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

type ModelsDevProvider = { providerKey: string; models: Record<string, unknown> };
type ModelsDevMatch = ModelsDevProvider & { recordId: string; model: Record<string, unknown> };

function providerModels(modelsDev: unknown, preferred?: string): ModelsDevProvider[] {
  const providers = record(modelsDev);
  if (!providers) return [];
  const entries = Object.entries(providers);
  const preferredEntries = preferred
    ? entries.filter(([key, value]) => key === preferred || record(value)?.id === preferred)
    : [];
  // Price is provider-specific. A provider-qualified query must never borrow an identically named
  // model from another provider, where subscription and metered costs can differ materially.
  // D-OBS-11 follow-up: that rule presumes the hinted provider EXISTS in the catalog. A hint that
  // matches nothing (kimi's "moonshot" vs the catalog's "moonshotai"/"kimi-for-coding"; cursor has
  // no provider at all) used to ZERO the search space and blanket-uncover the whole adapter.
  // Fail open to the full scan instead — advisory evidence with a visible models.dev id beats none.
  const selected = preferred && preferredEntries.length > 0 ? preferredEntries : entries;
  return selected.flatMap(([providerKey, provider]) => {
    const models = record(record(provider)?.models);
    return models ? [{ providerKey, models }] : [];
  });
}

function findModelsDevModel(catalog: CatalogCache, provider: string | undefined, modelId: string): ModelsDevMatch | undefined {
  // CLI namespaces prefix their catalog ids (kimi-code/k3 vs catalog key k3; omp's openai/gpt-4):
  // after exact key/id misses, retry with the bare segment after the last "/". Deterministic
  // provider order; first hit wins — acceptable for advisory evidence, never routing.
  const bare = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : undefined;
  for (const { providerKey, models } of providerModels(catalog.modelsDev, provider)) {
    const direct = record(models[modelId]);
    if (direct) return { providerKey, models, recordId: modelId, model: direct };
    for (const [recordId, value] of Object.entries(models)) {
      const candidate = record(value);
      if (candidate?.id === modelId) return { providerKey, models, recordId, model: candidate };
    }
  }
  if (bare) {
    for (const { providerKey, models } of providerModels(catalog.modelsDev, provider)) {
      const direct = record(models[bare]);
      if (direct) return { providerKey, models, recordId: bare, model: direct };
    }
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
): { index: number; version?: string; codingIndex?: number } | undefined {
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
        const coding = [
          evaluations?.artificial_analysis_coding_index,
          row.artificial_analysis_coding_index,
        ].map(nonNegative).find((value) => value !== undefined);
        return {
          index: n,
          ...((typeof version === "string" || typeof version === "number") ? { version: String(version) } : {}),
          ...(coding !== undefined ? { codingIndex: coding } : {}),
        };
      }
    }
  }
  return undefined;
}

/**
 * LiveBench ships the table as CSV and the category->task map as JSON. Every aggregate is derived
 * from that map, never from a task-column list written here: a category reshuffle upstream must
 * re-score us, not silently mis-score us.
 */
function parseLiveBenchTable(csv: string): Record<string, unknown>[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = lines.shift()?.split(",").map((cell) => cell.trim());
  if (header?.[0] !== "model") return [];
  return lines.flatMap((line) => {
    const cells = line.split(",").map((cell) => cell.trim());
    const model = cells[0];
    if (!model) return [];
    const row: Record<string, unknown> = { model };
    header.forEach((column, i) => {
      const score = i > 0 && cells[i] !== "" ? finite(Number(cells[i])) : undefined;
      if (score !== undefined) row[column] = score;
    });
    // A scoreless row (truncated payload, blank cells) carries no evidence — it is not a fleet member.
    return Object.keys(row).length > 1 ? [row] : [];
  });
}

/**
 * A probe is usable only if it can actually score the two categories we read: both must be arrays
 * naming at least one task column the table really scored. Otherwise throw — an unusable probe must
 * never overwrite the cached section (a truncated table plus `{}` categories is a failed fetch).
 */
function assertUsableLiveBench(rows: Record<string, unknown>[], categories: Record<string, unknown>): void {
  const scored = new Set(rows.flatMap((row) => Object.keys(row).filter((key) => key !== "model")));
  for (const name of ["Agentic Coding", "Coding"]) {
    const tasks = categories[name];
    if (!Array.isArray(tasks) || !tasks.some((task) => typeof task === "string" && scored.has(task))) {
      throw new Error(`LiveBench categories name no scored "${name}" task`);
    }
  }
}

// LiveBench splits one model across reasoning-effort rows (`-max-effort`, `-xhigh`,
// `-thinking-auto-medium-effort`); the highest effort is the model at its best. Rank by
// hyphen-delimited token so `xhigh` never reads as `high`.
const LIVEBENCH_EFFORT_RANK: Record<string, number> = { max: 5, xhigh: 4, high: 3, medium: 2, low: 1 };

const liveBenchEffortRank = (residue: string): number =>
  residue.split("-").reduce((rank, token) => Math.max(rank, LIVEBENCH_EFFORT_RANK[token] ?? 0), 0);

const liveBenchCategoryMean = (row: Record<string, unknown>, tasks: unknown): number | undefined => {
  const scores = (Array.isArray(tasks) ? tasks : [])
    .map((task) => (typeof task === "string" ? finite(row[task]) : undefined))
    .filter((score): score is number => score !== undefined);
  return scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : undefined;
};

/** LiveBench hyphenates where models.dev spaces: `Kimi K3` is `kimi-k3` in the table. */
const liveBenchIdentity = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, "-");

function liveBenchIndex(
  value: unknown,
  identities: string[],
): { agenticCodingScore?: number; codingScore?: number; tableDate?: string } | undefined {
  const root = record(value);
  if (!root || !Array.isArray(root.rows)) return undefined;
  const wanted = identities.map(liveBenchIdentity).filter(Boolean);
  let best: { row: Record<string, unknown>; rank: number } | undefined;
  for (const raw of root.rows) {
    const row = record(raw);
    const model = typeof row?.model === "string" ? liveBenchIdentity(row.model) : undefined;
    if (!row || !model) continue;
    // Bare startsWith is a false-positive machine: `glm-5` would claim `glm-5.2`. The residue after
    // the fleet id must be empty or an effort suffix.
    const residue = wanted.map((identity) => model.startsWith(identity) ? model.slice(identity.length) : undefined)
      .find((rest) => rest === "" || rest?.startsWith("-"));
    if (residue === undefined) continue;
    const rank = liveBenchEffortRank(residue);
    if (!best || rank > best.rank) best = { row, rank };
  }
  if (!best) return undefined;
  const categories = record(root.categories);
  const agenticCodingScore = liveBenchCategoryMean(best.row, categories?.["Agentic Coding"]);
  const codingScore = liveBenchCategoryMean(best.row, categories?.["Coding"]);
  return {
    ...(agenticCodingScore !== undefined ? { agenticCodingScore } : {}),
    ...(codingScore !== undefined ? { codingScore } : {}),
    ...(typeof root.tableDate === "string" ? { tableDate: root.tableDate } : {}),
  };
}

/** Resolve the alias identity first; the floating alias is only a fallback when identity is unknown. */
export function resolveCatalogModel(
  catalog: CatalogCache,
  query: { provider?: string; model: string; resolvedModel?: string },
): CatalogModelEvidence | undefined {
  const modelId = query.resolvedModel ?? query.model;
  const match = findModelsDevModel(catalog, query.provider, modelId);
  if (!match) return undefined;
  const { model } = match;
  const catalogId = `${match.providerKey}/${match.recordId}`;
  const cost = record(model.cost);
  const limit = record(model.limit);
  // LiveBench spells rows with the vendor-prefixed model name (`k3` is `kimi-k3` there), so
  // models.dev `name` bridges a fleet id that is only the bare suffix. `family` must NEVER join
  // this list: it is a LINEAGE label many models share — real models.dev has `glm` on every GLM and
  // `gpt` on gpt-4o — so through it glm-5 would claim glm-5.2's row and an unbenchmarked gpt-4o
  // would inherit a gpt-5.6 row's scores and evidenceDate. `name` is per-model; `family` is not.
  const identities = [
    modelId,
    query.model,
    ...(typeof model.name === "string" ? [model.name] : []),
  ];
  const intelligence = artificialAnalysisIndex(catalog.artificialAnalysis, [
    modelId,
    ...(typeof model.name === "string" ? [model.name] : []),
  ], query.provider);
  const liveBench = liveBenchIndex(catalog.liveBench, identities);
  const features = [
    ["reasoning", model.reasoning],
    ["tool-call", model.tool_call],
    ["structured-output", model.structured_output],
    ["attachment", model.attachment],
    ["open-weights", model.open_weights],
  ].filter((entry) => entry[1] === true).map((entry) => entry[0] as string);
  return {
    modelId,
    catalogId,
    ...(nonNegative(cost?.input) !== undefined ? { inputCostPerMtok: nonNegative(cost?.input) } : {}),
    ...(nonNegative(cost?.output) !== undefined ? { outputCostPerMtok: nonNegative(cost?.output) } : {}),
    ...(positive(limit?.context) !== undefined ? { contextWindow: positive(limit?.context) } : {}),
    ...(positive(limit?.output) !== undefined ? { outputWindow: positive(limit?.output) } : {}),
    features,
    ...(intelligence !== undefined ? {
      intelligenceIndex: intelligence.index,
      ...(intelligence.version ? { intelligenceIndexVersion: intelligence.version } : {}),
      ...(intelligence.codingIndex !== undefined ? { codingIndex: intelligence.codingIndex } : {}),
    } : {}),
    ...(liveBench !== undefined ? {
      ...(liveBench.agenticCodingScore !== undefined ? { agenticCodingScore: liveBench.agenticCodingScore } : {}),
      ...(liveBench.codingScore !== undefined ? { codingScore: liveBench.codingScore } : {}),
      ...(liveBench.tableDate !== undefined ? { evidenceDate: liveBench.tableDate } : {}),
    } : {}),
  };
}

const catalogSourceLabel = (url: string): string =>
  url.startsWith(MODELS_DEV_CATALOG_URL) ? "models.dev"
    : url.startsWith(LIVEBENCH_TABLE_URL) || url.startsWith(LIVEBENCH_CATEGORIES_URL) ? "LiveBench"
      : "Artificial Analysis";

async function fetchCatalog<T>(
  fetcher: CatalogFetcher,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  read: (response: CatalogResponse) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`catalog request timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const request = (async () => {
      const response = await fetcher(url, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`${catalogSourceLabel(url)} HTTP ${response.status}`);
      return read(response);
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
    const value = await fetchCatalog(fetcher, url, { headers: { "x-api-key": apiKey } }, timeoutMs, (r) => r.json());
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

/** Keyless leg: one CSV plus the category map. Both URLs are pinned to the deployed livebench.ai. */
async function fetchLiveBench(fetcher: CatalogFetcher, timeoutMs: number): Promise<unknown> {
  const csv = await fetchCatalog(fetcher, LIVEBENCH_TABLE_URL, {}, timeoutMs, (r) => r.text());
  const categories = record(await fetchCatalog(fetcher, LIVEBENCH_CATEGORIES_URL, {}, timeoutMs, (r) => r.json()));
  if (!categories) throw new Error("LiveBench categories schema is invalid");
  const rows = parseLiveBenchTable(csv);
  // Orca import #3, write site: an empty probe is a failed probe, never an empty fleet.
  if (rows.length === 0) throw new Error("LiveBench table parsed to zero rows");
  assertUsableLiveBench(rows, categories);
  return { tableDate: LIVEBENCH_TABLE_DATE, categories, rows };
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
    const modelsDev = await fetchCatalog(fetcher, MODELS_DEV_CATALOG_URL, {}, timeoutMs, (r) => r.json());
    if (!validModelsDevCatalog(modelsDev)) throw new Error("models.dev catalog schema is invalid");

    const apiKey = opts.artificialAnalysisKey ?? process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim();
    const artificialAnalysis = apiKey
      ? await fetchArtificialAnalysis(fetcher, apiKey, timeoutMs)
      : undefined;

    // The LiveBench leg is keyless and never costs the models.dev refresh: a failure keeps the
    // previous section verbatim and names the leg in the warning.
    let liveBench = current.catalog.liveBench;
    let warning: string | undefined;
    try {
      liveBench = await fetchLiveBench(fetcher, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warning = message.startsWith("LiveBench") ? message : `LiveBench refresh failed: ${message}`;
    }

    const catalog: CatalogCache = {
      schemaVersion: 1,
      fetchedAt: now().toISOString(),
      modelsDev,
      ...(artificialAnalysis !== undefined ? { artificialAnalysis } : {}),
      ...(liveBench !== undefined ? { liveBench } : {}),
    };
    writeCatalogCache(opts.repoRoot, catalog);
    return {
      updated: true,
      catalog: readCachedCatalog(opts.repoRoot, { now }),
      ...(warning !== undefined ? { warning } : {}),
    };
  } catch (error) {
    return {
      updated: false,
      catalog: current,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}
