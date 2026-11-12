// Queue row 417; D-2187 add.78 G: an approve --recheck release whose battery includes review re-probes every review
// seat retired in this run, ONCE each and in order, before that battery — never from a cached doctor answer. First the
// endpoint probe (provider-endpoint.ts) when the seat's adapter has a configured endpoint, and only if it answers, the
// adapter's doctor probe of that seat's model. A seat readmits only when every probe it needs answers: it gets one
// `review-seat-readmit {seat, probe}` row and its earlier strikes stop counting — live (the caller drops them from the
// run tally run-gates reads) and when a later session seeds the tally (readmittedSeat). A failing, throwing or
// unreadable probe leaves the seat retired. A plain resume or a recheck without review probes nothing (the caller).
import { configuredEndpoints, probeEndpoint } from "../adapters/provider-endpoint.js";
import { probeModels, readDoctor, writeDoctor } from "../adapters/registry.js";
import type { AuthHealth, ModelAuth, WorkerAdapter } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";
import type { JournalEvent } from "./journal.js";

export const SEAT_READMIT_EVENT = "review-seat-readmit";

export interface SeatProbes {
  /** The seat adapter's configured endpoint probe; undefined when the adapter has no configured endpoint. */
  endpoint(adapter: string): Promise<{ listening: boolean } | undefined>;
  /** The adapter's doctor probe of one model: its fresh verdict (or true) only when it answered. */
  model(adapter: string, model: string): Promise<ModelAuth | boolean>;
}

/** Production probes: a fresh endpoint connect and a fresh doctor model probe, never a cached doctor.json verdict. */
export function productionSeatProbes(cfg: TickmarkrConfig, repoRoot: string, adapters: readonly WorkerAdapter[],
  health: Record<string, AuthHealth>): SeatProbes {
  return {
    endpoint: async (adapter) => {
      const configured = configuredEndpoints().find((e) => e.adapter === adapter);
      return configured === undefined ? undefined : probeEndpoint(configured.url);
    },
    model: async (adapter, model) => {
      const a = adapters.find((x) => x.id === adapter);
      if (!a) return false;
      // installed true: a cached installed:false must never suppress the fresh measurement (probeModels skips it)
      const scratch: Record<string, AuthHealth> = { [adapter]: { ...(health[adapter] ?? { authed: true, models: [] }), installed: true } };
      let fresh = false;
      // The progress callback fires only for a verdict THIS call measured; probeModels merges prior doctor.json
      // verdicts into health, and a resource error (EMFILE…) keeps the PRIOR authed flag — so an answer needs
      // both: a fresh "ok" verdict and that verdict carrying no probe error.
      await probeModels(cfg, repoRoot, [a], scratch, (id, m, status) => {
        if (id === adapter && m === model) fresh = status === "ok";
      }, { model: [`${adapter}:${model}`] });
      const verdict = scratch[adapter]?.modelAuth?.[model];
      return fresh && verdict?.authed === true && verdict.probeError === undefined ? verdict : false;
    },
  };
}

/** The retired seats of a run tally (two or more strikes), in tally order. */
export const retiredSeats = (tally: ReadonlyMap<string, readonly string[]>): string[] =>
  [...tally].filter(([, causes]) => causes.length >= 2).map(([seat]) => seat);

/**
 * Records a readmitted seat's fresh verdict where probe verdicts live (D-2187 add.132): merged into doctor.json for
 * that one model through the doctor writer, exactly as a doctor probe scoped to that model merges it. The record
 * handed over is the CACHED adapter record (the live one when uncached) with installed true and only that model's
 * verdict replaced (its observed identity kept), so every other field, model and adapter survives and the writer's
 * containment applies. No doctor.json yet: the live fleet is written first, so a later resume reads the whole fleet
 * plus this verdict. A failed write THROWS (the caller journals nothing). Returns the merged adapter record.
 */
export function recordReadmitVerdict(repoRoot: string, live: Record<string, AuthHealth>, seat: string, verdict: ModelAuth): AuthHealth {
  const at = seat.indexOf(":");
  const adapter = seat.slice(0, at), model = seat.slice(at + 1);
  let doctor = readDoctor(repoRoot);
  if (!doctor) {
    writeDoctor(repoRoot, live);
    doctor = readDoctor(repoRoot) ?? {};
  }
  const cached: AuthHealth = doctor[adapter] ?? live[adapter] ?? { installed: true, authed: true, models: [] };
  const identity = verdict.identity ?? cached.modelAuth?.[model]?.identity;
  const record: AuthHealth = { ...cached, installed: true,
    modelAuth: { ...cached.modelAuth, [model]: { ...verdict, ...(identity !== undefined ? { identity } : {}) } } };
  writeDoctor(repoRoot, { [adapter]: record }, [{ adapter, model }]);
  const merged = readDoctor(repoRoot)?.[adapter];
  if (merged?.modelAuth?.[model]?.authed !== true) throw new Error(`doctor.json did not record ${seat}'s fresh verdict`);
  return merged;
}

/**
 * Probe each retired seat once, in order. For each readmitted seat `readmit` runs BEFORE the next seat is probed,
 * so the caller journals the row and clears that seat's strikes synchronously: a strike a concurrent review records
 * after the row keeps counting, live as on replay. Returns the readmitted seats.
 */
export async function readmitRetiredSeats(
  retired: readonly string[],
  probes: SeatProbes,
  readmit: (seat: string, row: { event: string; data: Record<string, unknown> }, verdict: ModelAuth) => void,
): Promise<string[]> {
  const readmitted: string[] = [];
  for (const seat of retired) {
    const at = seat.indexOf(":");
    if (at <= 0) continue; // unreadable seat key: stays retired
    const adapter = seat.slice(0, at), model = seat.slice(at + 1);
    try {
      const endpoint = await probes.endpoint(adapter);
      if (endpoint !== undefined && endpoint?.listening !== true) continue; // dead endpoint: no model probe
      const answer = await probes.model(adapter, model);
      // Only a fresh error-free answer readmits; `true` (a probe with no verdict to record) stamps one now.
      const verdict: ModelAuth | undefined = answer === true ? { authed: true, probedAt: new Date().toISOString() }
        : typeof answer === "object" && answer !== null && answer.authed === true && answer.probeError === undefined ? answer : undefined;
      if (!verdict) continue;
      readmit(seat, { event: SEAT_READMIT_EVENT, data: { seat, probe: endpoint === undefined ? "model" : "endpoint+model" } }, verdict);
      readmitted.push(seat);
    } catch {
      // a throwing probe is no answer: the seat stays retired
    }
  }
  return readmitted;
}

/** Seeding: the seat a readmit row clears (its earlier strikes stop counting), else undefined. */
export const readmittedSeat = (event: JournalEvent): string | undefined =>
  event.event === SEAT_READMIT_EVENT && typeof event.data.seat === "string" ? event.data.seat : undefined;
