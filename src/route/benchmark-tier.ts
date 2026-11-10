// Queue row 367 Phase 2 (D-2187 add.15, add.20, add.21; standing D-1518 bands): the benchmark tier of a
// NEW model. Pure: no file, network or clock read — the caller hands in the catalog, the Terminal-Bench
// evidence and `now`. A model with an existing tier (configured or seeded) is never computed.
import { DEFAULT_CONFIG, type TickmarkrConfig, type Tier } from "../config/config.js";
import { CATALOG_CACHE_MAX_AGE_MS, type CatalogReadResult } from "../adapters/catalog-remote.js";
import { catalogEvidenceFor } from "../adapters/model-lints.js";
import { terminalBenchScore, type TerminalBenchEvidence } from "./terminal-bench.js";

/** D-1518 standing bands: each benchmark's ratio to its fleet top must clear its own threshold. */
export const BENCHMARK_BANDS = {
  frontier: { aa: 0.90, tb: 0.85 },
  mid: { aa: 0.75, tb: 0.50 },
} as const;

export interface BenchmarkTierRecord {
  tier: Tier;
  provisional: boolean;
  reason: string;
  aa?: { score: number; top: number; version: string; fetchedAt: string };
  tb?: { score: number; top: number; version: string; retrievedAt: string };
}

export type BenchmarkTier =
  /** The exact id already has a tier: kept as is, and no record is made. */
  | { kind: "existing"; tier: Tier }
  /** A missing or stale leg gives `provisional: true` at cheap, its reason naming that leg (never a guessed band). */
  | { kind: "computed"; record: BenchmarkTierRecord };

export interface BenchmarkTierCandidate {
  adapter: string;
  model: string;
  /** The route's launch effort, which picks the Terminal-Bench row. */
  effort?: string;
  /** The catalog spelling of an alias, as catalogTierRanking takes it. */
  resolvedModel?: string;
}

export interface BenchmarkTierInputs {
  cfg: TickmarkrConfig;
  catalog: CatalogReadResult;
  terminalBench: TerminalBenchEvidence;
  now: Date;
  resolvedModel?: (adapter: string, model: string) => string | undefined;
}

type TierTable = TickmarkrConfig["tiers"];

/** Configured tiers first (explicit config wins), then the seeds; the candidate's own adapter first in each. */
export function existingTier(cfg: TickmarkrConfig, adapter: string, model: string): Tier | undefined {
  for (const tiers of [cfg.tiers, DEFAULT_CONFIG.tiers]) {
    for (const entry of [tiers[adapter], ...Object.values(tiers)]) {
      const tier = entry?.models[model];
      if (tier !== undefined) return tier;
    }
  }
  return undefined;
}

type FleetEntry = { adapter: string; model: string; effort?: string };

/** One entry per adapter:model, configured first: a seed joins only where the pair is not configured, so a
 * seed's own (or absent) effort never shadows the configured launch effort that picks the TB row. */
function fleetOf(cfg: TickmarkrConfig): FleetEntry[] {
  const fleet = new Map<string, FleetEntry>();
  for (const tiers of [cfg.tiers, DEFAULT_CONFIG.tiers] as TierTable[]) {
    for (const [adapter, entry] of Object.entries(tiers)) {
      for (const model of Object.keys(entry?.models ?? {})) {
        const key = `${adapter}:${model}`;
        if (!fleet.has(key)) fleet.set(key, { adapter, model, effort: entry?.modelOverrides?.[model]?.effort });
      }
    }
  }
  return [...fleet.values()];
}

/** The conjunction: one benchmark's ratio never carries the other's. */
function band(aaRatio: number, tbRatio: number): Tier {
  for (const tier of ["frontier", "mid"] as const) {
    if (aaRatio >= BENCHMARK_BANDS[tier].aa && tbRatio >= BENCHMARK_BANDS[tier].tb) return tier;
  }
  return "cheap";
}

const ratioNote = (name: string, score: number, top: number, leg: "aa" | "tb") =>
  `${name} ${score}/${top} = ${score / top} (frontier >= ${BENCHMARK_BANDS.frontier[leg]}, mid >= ${BENCHMARK_BANDS.mid[leg]})`;

export function benchmarkTier(candidate: BenchmarkTierCandidate, inputs: BenchmarkTierInputs): BenchmarkTier {
  const { cfg, catalog, terminalBench, now } = inputs;
  const kept = existingTier(cfg, candidate.adapter, candidate.model);
  if (kept !== undefined) return { kind: "existing", tier: kept };

  // The fleet: every model with an existing tier. Its top on each benchmark is its highest score there.
  const fleet = fleetOf(cfg);
  // Orca import #1: the vendored catalog is a shipped default, never fetched evidence.
  const aaOf = (adapter: string, model: string, resolvedModel?: string) => catalog.source === "vendored" ? undefined
    : catalogEvidenceFor(cfg, catalog, { adapter, model, ...(resolvedModel ? { resolvedModel } : {}) });
  const aaTop = Math.max(...fleet.flatMap(({ adapter, model }) => {
    const n = aaOf(adapter, model, inputs.resolvedModel?.(adapter, model))?.intelligenceIndex;
    return n === undefined ? [] : [n];
  }));
  const tbTop = Math.max(...fleet.flatMap(({ model, effort }) => {
    const s = terminalBenchScore(terminalBench, model, effort, now);
    return s.status === "fresh" ? [s.row.score] : [];
  }));

  const aa = aaOf(candidate.adapter, candidate.model, candidate.resolvedModel);
  const tb = terminalBenchScore(terminalBench, candidate.model, candidate.effort, now);
  // Row 367 (D-2187 add.15): the AA leg is stale once its fetch age reaches CATALOG_CACHE_MAX_AGE_MS. Fail
  // closed: an unreadable fetch date (NaN) cannot prove it fresh, and neither can a per-leg record with no AA
  // date — a skipped-AA refresh keeps the old scores but drops their date, while fetchedAt moves to models.dev.
  // Only a legacy cache with no per-leg record dates every leg by fetchedAt.
  const legAt = catalog.catalog.legFetchedAt;
  const aaFetchedAt = legAt ? legAt.artificialAnalysis : catalog.catalog.fetchedAt;
  const aaStale = aaFetchedAt === undefined || !(now.getTime() - Date.parse(aaFetchedAt) < CATALOG_CACHE_MAX_AGE_MS);
  const aaScore = aa?.intelligenceIndex;
  const aaLeg = aaScore !== undefined && aaFetchedAt !== undefined && !aaStale && aaTop > 0
    ? { score: aaScore, top: aaTop, version: aa?.intelligenceIndexVersion ?? "not reported", fetchedAt: aaFetchedAt }
    : undefined;
  const tbLeg = tb.status === "fresh" && tbTop > 0
    ? { score: tb.row.score, top: tbTop, version: tb.version, retrievedAt: tb.row.retrievedAt }
    : undefined;

  if (!aaLeg || !tbLeg) {
    // Every failing leg is named; a leg that did score is still recorded, but never bands the model.
    const gaps = [
      aaLeg ? undefined
        : aaScore === undefined ? `no Artificial Analysis score for ${candidate.model}`
        : aaFetchedAt === undefined ? `Artificial Analysis score for ${candidate.model} is stale: no fetch date recorded for that leg`
        : aaStale ? `Artificial Analysis score for ${candidate.model} is stale: fetched ${aaFetchedAt}, at least ${CATALOG_CACHE_MAX_AGE_MS / 86_400_000} days old`
        : "no Artificial Analysis fleet top",
      tbLeg ? undefined : tb.status === "fresh" ? "no Terminal-Bench fleet top" : tb.reason,
    ].filter((gap) => gap !== undefined);
    return {
      kind: "computed",
      record: {
        tier: "cheap", provisional: true, reason: `provisional, cheap floor only: ${gaps.join("; ")}`,
        ...(aaLeg ? { aa: aaLeg } : {}), ...(tbLeg ? { tb: tbLeg } : {}),
      },
    };
  }

  const tier = band(aaLeg.score / aaLeg.top, tbLeg.score / tbLeg.top);
  return {
    kind: "computed",
    record: {
      tier,
      provisional: false,
      reason: `D-1518 bands: ${ratioNote("Artificial Analysis", aaLeg.score, aaLeg.top, "aa")}; ${ratioNote("Terminal-Bench", tbLeg.score, tbLeg.top, "tb")} → ${tier}`,
      aa: aaLeg,
      tb: tbLeg,
    },
  };
}
