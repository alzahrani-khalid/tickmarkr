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

/**
 * An adapter's models in a prior doctor record a version before 2.26.0 wrote (no first-seen key):
 * only a non-empty list of strings counts; any other shape is no list, so the adapter stays a baseline
 * (queue row 461; D-2187 add.256).
 */
const priorList = (priorDoctor: unknown, adapter: string): Set<string> | undefined => {
  const models = record(record(priorDoctor)?.[adapter])?.models;
  return Array.isArray(models) && models.length && models.every((m) => typeof m === "string") ? new Set(models as string[]) : undefined;
};

/**
 * Pure: the record after a probe. A model already recorded keeps its date. `priorDoctor` is the doctor
 * record on disk before this write: when it holds no first-seen key, an adapter's prior models list is
 * its baseline, so a model it did not list is dated now (queue row 461; D-2187 add.256). When the key is
 * present, whatever its value, the key decides alone.
 */
export function withFirstSeen(recorded: unknown, health: Record<string, AuthHealth>, now: Date, priorDoctor?: unknown): FirstSeen {
  const prior = wellFormed(recorded);
  const doctor = record(priorDoctor);
  const fromLists = doctor !== undefined && !(FIRST_SEEN_KEY in doctor);
  const out: FirstSeen = { ...prior };
  for (const [adapter, h] of Object.entries(health)) {
    if (!h || typeof h !== "object" || !Array.isArray(h.models) || !h.models.length) continue;
    const before = prior[adapter];
    const listed = before || !fromLists ? undefined : priorList(doctor, adapter);
    const seen = { ...before };
    for (const model of h.models) {
      if (typeof model === "string" && !(model in seen)) seen[model] = before || (listed && !listed.has(model)) ? now.toISOString() : "";
    }
    out[adapter] = seen;
  }
  return out;
}
