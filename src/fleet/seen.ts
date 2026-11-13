// When each CLI first listed each model. A probe records it in doctor.json under one top-level key,
// beside the adapters and never inside them: an adapter a scoped probe did not touch stays
// byte-identical. The fleet screen calls a model "new" from this record.
// An adapter's first record is a baseline: it dates nothing, so an existing fleet, or a CLI that was
// just installed, never reads as a list of new models.
import type { AuthHealth } from "../adapters/types.js";

export const FIRST_SEEN_KEY = "modelsFirstSeen";
/** adapter → model → the ISO time a probe first listed it; "" for the baseline. */
export type FirstSeen = Record<string, Record<string, string>>;

const record = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
/**
 * The record as far as it is well formed: adapters that map models to strings. Anything else is
 * read in the direction that dates nothing: an adapter whose record is not a map, or is empty,
 * starts again from a baseline, and a model whose date is not a string is on the baseline. A
 * malformed record must never make an old model read as new.
 */
const wellFormed = (prior: unknown): FirstSeen => Object.fromEntries(Object.entries(record(prior) ?? {}).flatMap(([adapter, models]) => {
  const m = record(models);
  return m && Object.keys(m).length ? [[adapter, Object.fromEntries(Object.entries(m).map(([model, at]) => [model, typeof at === "string" ? at : ""]))]] : [];
}));

/** Pure: the record after a probe. A model already recorded keeps its date. */
export function withFirstSeen(recorded: unknown, health: Record<string, AuthHealth>, now: Date): FirstSeen {
  const prior = wellFormed(recorded);
  const out: FirstSeen = { ...prior };
  for (const [adapter, h] of Object.entries(health)) {
    if (!h || typeof h !== "object" || !Array.isArray(h.models) || !h.models.length) continue;
    const before = prior[adapter];
    const seen = { ...before };
    for (const model of h.models) if (typeof model === "string" && !(model in seen)) seen[model] = before ? now.toISOString() : "";
    out[adapter] = seen;
  }
  return out;
}
