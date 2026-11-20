// Queue row 502; D-2187 add.363: doctor snapshots fetched evidence; routing reads only that record.
import type { TickmarkrConfig } from "../config/config.js";
import type { CatalogReadResult } from "./catalog-remote.js";
import { catalogEvidenceFor } from "./model-lints.js";
import type { AuthHealth, ModelFacts } from "./types.js";

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const MODEL_FACT_EFFORT = /-(low|medium|high|xhigh|max)(-fast)?$/;
type TableFacts = Omit<ModelFacts, "as">;

/** The fleet's slug rule, shared with doctor. scoredOnly preserves the new-model reader's results. */
export function artificialAnalysisFacts(catalog: unknown, scoredOnly = false): (id: string) => TableFacts | undefined {
  const data = record(record(catalog)?.artificialAnalysis)?.data;
  const bySlug = new Map((Array.isArray(data) ? data : []).flatMap((raw) => {
    const row = record(raw), score = record(row?.evaluations)?.artificial_analysis_intelligence_index;
    if (!row || typeof row.slug !== "string" || !row.slug || (scoredOnly && !finite(score))) return [];
    const prices = record(row.pricing);
    return [[row.slug, {
      ...(finite(score) ? { score } : {}),
      ...(finite(prices?.price_1m_input_tokens) ? { priceIn: prices.price_1m_input_tokens } : {}),
      ...(finite(prices?.price_1m_output_tokens) ? { priceOut: prices.price_1m_output_tokens } : {}),
      ...(finite(row.median_output_tokens_per_second) ? { speed: row.median_output_tokens_per_second } : {}),
      // The fleet historically falls back to the slug; the probe records only a sourced display name.
      ...(typeof row.name === "string" || scoredOnly
        ? { name: (typeof row.name === "string" ? row.name : row.slug).replace(/\s*\(.*$/, "") } : {}),
    }] as const];
  }));
  const slug = (id: string): string => id.slice(id.lastIndexOf("/") + 1).replace(/\./g, "-");
  return (id) => {
    const key = slug(id), exact = bySlug.get(key);
    if (exact) return exact;
    const effort = MODEL_FACT_EFFORT.exec(key);
    return effort?.[1] === "high" ? bySlug.get(key.slice(0, effort.index)) : undefined;
  };
}

/** No I/O: the probe hands over its final catalog and identity snapshot before writeDoctor. */
export function recordModelFacts(cfg: TickmarkrConfig, catalog: CatalogReadResult, health: Record<string, AuthHealth>): void {
  if (catalog.source === "vendored") return;
  const table = artificialAnalysisFacts(catalog.catalog);
  for (const [adapter, entry] of Object.entries(health)) {
    const facts: Record<string, ModelFacts> = {};
    for (const model of new Set([...Object.keys(cfg.tiers[adapter]?.models ?? {}), ...entry.models])) {
      const as = entry.modelAuth?.[model]?.identity ?? entry.modelIdentities?.[model] ?? model;
      const evidence = catalogEvidenceFor(cfg, catalog, { adapter, model: as });
      const row = table(as);
      const score = evidence?.intelligenceIndex ?? row?.score;
      const priceIn = evidence?.inputCostPerMtok ?? row?.priceIn;
      const priceOut = evidence?.outputCostPerMtok ?? row?.priceOut;
      const value: TableFacts = {
        ...(finite(score) ? { score } : {}),
        ...(finite(priceIn) ? { priceIn } : {}),
        ...(finite(priceOut) ? { priceOut } : {}),
        ...(row?.speed !== undefined ? { speed: row.speed } : {}),
        ...(row?.name !== undefined ? { name: row.name } : {}),
      };
      if (Object.keys(value).length) facts[model] = { as, ...value };
    }
    if (Object.keys(facts).length) entry.modelFacts = facts;
    else delete entry.modelFacts;
  }
}
