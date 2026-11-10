// Queue row 367 Phase 1 R1 (D-2187 condition 1): the ONE seat resolver. The run's acceptance judge
// (primary, failover and adjudicating seat), the review gate's reviewer pick, the escalation consult's
// seat walk and `tickmarkr fleet --pick` (pickRole) all rank through resolveSeats; no other ranking of
// those seats remains at those seams. Pure: it reads the pool, the configuration and the doctor cache it
// is handed and imports nothing from src/gates, src/run or src/cli. Behaviour-preserving: every seat
// order is the one each seam had at the base (tests/fixtures/seat-resolver/goldens.base.json).
import type { Assignment, AuthHealth, BillingChannel, WorkerAdapter } from "../adapters/types.js";
import { channelKey } from "../adapters/types.js";
import { type TickmarkrConfig, TIER_RANK, type Tier } from "../config/config.js";
import { type Disallowed, disallowedBy, modelProvider, observedSeat, type PreferenceRole } from "./preference.js";
import { marginalCostRank, preferIndex, rankPreferredChannels, reviewPreferenceTieBreak } from "./router.js";

/** A seat a role can draw: a pool channel, or a configured pin that may sit outside the pool. */
export interface Seat { adapter: string; model: string; identity?: string; vendor?: string }

// Row 367 R1: the closed skip reasons, in the order they are checked; the first that applies is reported.
export const SKIP_REASONS = [
  "denied", "not-configured", "not-installed", "adapter-unauthed", "model-unavailable",
  "excluded-vendor", "unknown-vendor", "author", "below-floor", "excluded",
] as const;
export type SkipReason = typeof SKIP_REASONS[number];
export interface SeatSkip { entry: string; channel?: string; reason: SkipReason; detail?: string }

export interface SeatResolution<S> {
  pick: S | null;
  /** The role's seats in the order the role draws from them; the pick is first. */
  ranked: S[];
  /** Preference entries the pick passed over (review and consult only; needs `adapters`). */
  skips: SeatSkip[];
  /** Review gate: the pick's 1-based place in the preference ranking and that ranking's size. */
  seat?: { seat: number; count: number };
  /** Judge: the configured judge the operator's routing disallows — the base refusal, no pick. */
  disallowed?: Disallowed;
}

/** The configured view skip rows read: without adapters no skip row is computed. */
interface ConfiguredView { cfg?: TickmarkrConfig; adapters?: readonly WorkerAdapter[]; health?: Record<string, AuthHealth> | null }

export interface WorkerSeatRequest { role: "worker"; pool: readonly BillingChannel[] }

/**
 * Review. With `author` it is the review gate's reviewer (pickReviewer): cross-vendor, cross-provider
 * and cross-base-model against every author, a known vendor, the author-tier floor, then preference,
 * demotion and rotation. Without one it is the strict preference pick fleet --pick review makes.
 */
export interface ReviewSeatRequest extends ConfiguredView {
  role: "review";
  pool: readonly BillingChannel[];
  prefer: readonly string[];
  author?: Assignment;
  authors?: readonly string[];
  floor?: Tier;
  exclude?: readonly string[];
  history?: readonly string[];
  demoted?: ReadonlySet<string>;
  excludeVendors?: ReadonlySet<string>;
  eligible?: (c: BillingChannel) => boolean;
}

/** Consult: strict preference order; the run's configured pin is appended last (Q-b). */
export interface ConsultSeatRequest<C extends Seat> extends ConfiguredView {
  role: "consult";
  cfg: TickmarkrConfig;
  pool: readonly C[];
  pin?: { adapter: string; model: string };
  excludeVendors?: ReadonlySet<string>;
  eligible?: (c: C) => boolean;
}

/** Judge: the configured judge, then an independent automatic pick, then the annotated same-vendor fallback. */
export interface JudgeSeatRequest {
  role: "judge";
  cfg: TickmarkrConfig;
  pool: readonly BillingChannel[];
  health?: Record<string, AuthHealth> | null;
  /** Further channels that resolve author keys (the review pool). */
  authorPool?: readonly BillingChannel[];
  authors: readonly string[];
  stage?: JudgeStage;
}

/** The judge's draw: the primary, or the seat a failover (the flaked judge) or an adjudication (the primary) must avoid. */
export type JudgeStage = { kind: "primary" } | { kind: "failover" | "adjudicate"; avoid: string };

// FLEET-05: canonical base-model identity = the segment after the last "/".
export function modelId(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

/** OBS-1033: the vendors of the seats that authored commits inside the accumulated diff. */
export function carriedAuthorVendors(channels: readonly BillingChannel[], carriedAuthors: readonly string[] = []): Set<string> {
  const vendors = new Set<string>();
  for (const key of carriedAuthors) {
    for (const c of channels.filter((c) => channelKey(c) === key)) vendors.add(c.vendor);
  }
  return vendors;
}

export function isIndependentJudge(seat: BillingChannel, authorVendors: ReadonlySet<string>, authors: readonly string[]): boolean {
  return !!seat.vendor && seat.vendor !== "unknown"
    && !authorVendors.has(seat.vendor) && !authors.includes(channelKey(seat));
}

/** Which axis a reviewer shares with an author; null when the two are diverse. */
function sharedAxis(c: BillingChannel, a: BillingChannel): string | null {
  if (c.vendor === a.vendor) return `vendor ${c.vendor}`;
  if (modelProvider(c.model, c.vendor) === modelProvider(a.model, a.vendor)) return `provider ${modelProvider(c.model, c.vendor)}`;
  if (modelId(c.model) === modelId(a.model)) return `base model ${modelId(c.model)}`;
  return null;
}

const dedupe = <S extends Seat>(seats: readonly S[]): S[] => {
  const seen = new Set<string>();
  return seats.filter((s) => {
    if (seen.has(channelKey(s))) return false;
    seen.add(channelKey(s));
    return true;
  });
};

export function resolveSeats(req: WorkerSeatRequest): SeatResolution<BillingChannel>;
export function resolveSeats(req: ReviewSeatRequest): SeatResolution<BillingChannel>;
export function resolveSeats<C extends Seat>(req: ConsultSeatRequest<C>): SeatResolution<C | Seat>;
export function resolveSeats(req: JudgeSeatRequest): SeatResolution<BillingChannel | Seat>;
export function resolveSeats(
  req: WorkerSeatRequest | ReviewSeatRequest | ConsultSeatRequest<Seat> | JudgeSeatRequest,
): SeatResolution<Seat> {
  switch (req.role) {
    // Worker seats are routed per task by route(); the resolver lists the pool and picks none.
    case "worker": return { pick: null, ranked: [...req.pool], skips: [] };
    case "review": return resolveReview(req);
    case "consult": return resolveConsult(req);
    case "judge": return resolveJudge(req);
  }
}

interface Eligibility { reason: SkipReason; detail?: string }

function resolveReview(req: ReviewSeatRequest): SeatResolution<BillingChannel> {
  const { pool, prefer, author } = req;
  const exclude = req.exclude ?? [];
  const excludeVendors = req.excludeVendors ?? new Set<string>();
  if (!author) {
    // fleet --pick review at the base: strict preference, no author, no floor.
    const ranked = rankPreferredChannels(
      pool.filter((c) => !excludeVendors.has(c.vendor) && (req.eligible?.(c) ?? true)), prefer,
      { tieBreak: reviewPreferenceTieBreak },
    );
    const pick = ranked[0] ?? null;
    return {
      pick, ranked,
      skips: skipRows(req, pool, "review", prefer, pick, pick ? preferIndex(pick, prefer) : prefer.length,
        pick ? (c) => reviewPreferenceTieBreak(c, pick) : undefined, (c) => strictIneligible(c, excludeVendors)),
    };
  }
  const authors = req.authors ?? [channelKey(author)];
  // Resolve every actual author, never guess a vendor from an adapter id.
  const authorChannels = authors.map((key) => pool.find((c) => channelKey(c) === key));
  // RF-1: a reviewer is never seated below its author.
  const floor: Tier = req.floor !== undefined && TIER_RANK[req.floor] > TIER_RANK[author.tier] ? req.floor : author.tier;
  // The diversity filter runs BEFORE preference ranking, so prefer cannot resurrect an excluded channel.
  const ineligible = (c: BillingChannel): Eligibility | null => {
    if (excludeVendors.has(c.vendor)) return { reason: "excluded-vendor", detail: c.vendor };
    if (c.vendor === "unknown") return { reason: "unknown-vendor" };
    for (const [i, a] of authorChannels.entries()) {
      const axis = a ? sharedAxis(c, a) : null;
      if (axis) return { reason: "author", detail: `shares ${axis} with author ${authors[i]}` };
    }
    if (TIER_RANK[c.tier] < TIER_RANK[floor]) return { reason: "below-floor", detail: `${c.tier} below the ${floor} floor` };
    if (exclude.includes(channelKey(c))) return { reason: "excluded" };
    return null;
  };
  if (authorChannels.some((c) => !c)) {
    return { pick: null, ranked: [], skips: skipRows(req, pool, "review", prefer, null, prefer.length, undefined, ineligible) };
  }
  const byPreference = rankPreferredChannels(pool.filter((c) => ineligible(c) === null), prefer, {
    includeUnpreferred: true,
    tieBreak: reviewPreferenceTieBreak,
  });
  const demoted = req.demoted ?? new Set<string>();
  const history = req.history ?? [];
  // Demotion, then run-scoped rotation (least recently picked first), then preference.
  const ranked = [...byPreference].sort((a, b) =>
    Number(demoted.has(channelKey(a))) - Number(demoted.has(channelKey(b)))
    || history.lastIndexOf(channelKey(a)) - history.lastIndexOf(channelKey(b))
    || byPreference.indexOf(a) - byPreference.indexOf(b));
  const pick = ranked[0] ?? null;
  return {
    pick, ranked,
    skips: skipRows(req, pool, "review", prefer, pick, pick ? preferIndex(pick, prefer) : prefer.length,
      pick ? (c) => reviewPreferenceTieBreak(c, pick) : undefined, ineligible),
    ...(pick ? { seat: { seat: byPreference.indexOf(pick) + 1, count: byPreference.length } } : {}),
  };
}

const strictIneligible = (c: Seat, excludeVendors?: ReadonlySet<string>): Eligibility | null =>
  c.vendor !== undefined && excludeVendors?.has(c.vendor) ? { reason: "excluded-vendor", detail: c.vendor } : null;

function resolveConsult(req: ConsultSeatRequest<Seat>): SeatResolution<Seat> {
  const { cfg } = req;
  const prefer = cfg.consult.prefer ?? [];
  const allowed = (s: Seat) => disallowedBy(s, cfg.routing, "consult") === null;
  // Rank only exact live models from the role-scoped pool, strictly by preference.
  const preferred = rankPreferredChannels(
    req.pool.filter((c) => !strictIneligible(c, req.excludeVendors) && (req.eligible?.(c) ?? true) && allowed(c)), prefer,
  );
  // The pin carries its cached identity and passes the same policy check as every prefer entry.
  const ranked = [...preferred, ...(req.pin ? [observedSeat(req.health, req.pin.adapter, req.pin.model)] : [])].filter(allowed);
  const pick = ranked[0] ?? null;
  // A pin pick means every preference entry was passed over.
  const fromPrefer = preferred.length ? pick : null;
  const at = fromPrefer ? preferIndex(fromPrefer, prefer) : prefer.length;
  return { pick, ranked, skips: skipRows(req, req.pool, "consult", prefer, fromPrefer, at, undefined, (c) => strictIneligible(c, req.excludeVendors)) };
}

function resolveJudge(req: JudgeSeatRequest): SeatResolution<BillingChannel | Seat> {
  const { cfg } = req;
  const judgeKey = channelKey(cfg.judge);
  // v1.87 T2 / OBS-1186: the configured judge is checked against the operator's policy under its cached
  // identity BEFORE any seat is drawn; a disallowed one is the base refusal — no pick, no dispatch.
  const judgeSeat = observedSeat(req.health, cfg.judge.adapter, cfg.judge.model);
  const denied = disallowedBy(judgeSeat, cfg.routing, "judge");
  if (denied) return { pick: null, ranked: [], skips: [], disallowed: denied };
  // Queue row 34(a) (D-2134 R5): resolve every lifetime author through both role pools.
  const channels = [...req.pool, ...(req.authorPool ?? [])];
  const authors = req.authors;
  const authorVendors = carriedAuthorVendors(channels, authors);
  const independent = (seat: BillingChannel) => isIndependentJudge(seat, authorVendors, authors);
  const judgePool = req.pool.filter((c) => c.vendor !== "unknown" && disallowedBy(c, cfg.routing, "judge") === null);
  const rank = (pool: BillingChannel[]) => [...pool]
    .sort((x, y) => TIER_RANK[y.tier] - TIER_RANK[x.tier] || marginalCostRank(x) - marginalCostRank(y));
  // A different adapter first when the pool has one, then the avoided adapter's own channels.
  const draw = (pool: BillingChannel[], adapter: string) =>
    [...rank(pool.filter((c) => c.adapter !== adapter)), ...rank(pool.filter((c) => c.adapter === adapter))];
  const configured = channels.find((c) => channelKey(c) === judgeKey);
  // Pin-then-auto: the configured judge unless it is an author or not independent of one; then an
  // independent seat; then the configured judge again, or (for an unknown-vendor pin) any known-vendor seat.
  const primaryChain: Seat[] = authors.includes(judgeKey) || (configured && !independent(configured))
    ? [...draw(judgePool.filter(independent), cfg.judge.adapter),
      ...(configured?.vendor === "unknown" ? draw(judgePool, cfg.judge.adapter) : [cfg.judge])]
    : [cfg.judge];
  const primary = primaryChain[0];
  // GATE-09 failover: never the flaked channel, a different adapter first, independent first, then the
  // primary (unknown-vendor pin) or the configured judge so a single-seat fleet still retries.
  const failoverChain = (avoid: string): Seat[] => {
    const pool = judgePool.filter((c) => channelKey(c) !== avoid);
    const adapter = avoid.slice(0, avoid.indexOf(":"));
    const fallback = configured?.vendor === "unknown" ? primary : judgeSeat;
    return [...draw(pool.filter(independent), adapter), ...draw(pool, adapter), ...(fallback ? [fallback] : [])];
  };
  const stage = req.stage ?? { kind: "primary" };
  let chain: Seat[];
  if (stage.kind === "primary") chain = primary ? [...primaryChain, ...failoverChain(channelKey(primary))] : [];
  else if (stage.kind === "failover") chain = failoverChain(stage.avoid);
  else {
    // OBS-1151: one DISTINCT adjudicating seat, never the primary channel and no configured fallback.
    const pool = judgePool.filter((c) => channelKey(c) !== stage.avoid);
    const adapter = stage.avoid.slice(0, stage.avoid.indexOf(":"));
    chain = [...draw(pool.filter(independent), adapter), ...draw(pool, adapter)];
  }
  const ranked = dedupe(chain);
  return { pick: ranked[0] ?? null, ranked, skips: [] };
}

/**
 * Row 367 R1 typed skips: one row per preference entry and configured channel it matches (one row with
 * no channel when it matches none) for every entry ranked before the pick that a closed reason excludes.
 * Entries ranked after the pick are not skips; a channel passed over by rotation alone carries no row.
 */
function skipRows<C extends Seat>(
  view: ConfiguredView,
  pool: readonly C[],
  role: "review" | "consult",
  prefer: readonly string[],
  pick: Seat | null,
  pickAt: number,
  // Review's in-band tie-break against the pick (< 0: the channel ranks first); consult keeps pool order.
  tie: ((c: BillingChannel) => number) | undefined,
  ineligible: (c: C) => Eligibility | null,
): SeatSkip[] {
  const { cfg, adapters, health } = view;
  if (!cfg || !adapters) return [];
  const configured = adapters.flatMap((a) => a.channels(cfg));
  const order = (c: Seat) => configured.findIndex((x) => channelKey(x) === channelKey(c));
  const before = (c: BillingChannel, i: number) => {
    if (!pick) return true;
    if (channelKey(c) === channelKey(pick)) return false;
    if (i !== pickAt) return i < pickAt;
    const t = tie?.(c) ?? 0;
    return t !== 0 ? t < 0 : order(c) < order(pick);
  };
  const rows: SeatSkip[] = [];
  for (const [i, entry] of prefer.entries()) {
    if (pick && i > pickAt) break;
    const matched = configured.filter((c) => preferIndex(c, [entry]) === 0);
    if (!matched.length) {
      if (!pick || i < pickAt) rows.push({ entry, reason: "not-configured", detail: `no configured channel matches ${entry}` });
      continue;
    }
    for (const c of matched.filter((c) => before(c, i))) {
      const key = channelKey(c);
      const live = pool.find((p) => channelKey(p) === key);
      const why = channelSkip(cfg, health, role, c, live !== undefined) ?? (live ? ineligible(live) : null);
      if (why) rows.push({ entry, channel: key, ...why });
    }
  }
  return rows;
}

function channelSkip(
  cfg: TickmarkrConfig, health: Record<string, AuthHealth> | null | undefined, role: PreferenceRole,
  c: BillingChannel, live: boolean,
): Eligibility | null {
  const d = disallowedBy(observedSeat(health, c.adapter, c.model), cfg.routing, role);
  if (d) return { reason: "denied", detail: `routing.${d.by} (${d.entry})` };
  const h = health?.[c.adapter];
  if (!h?.installed) return { reason: "not-installed", detail: c.adapter };
  if (!h.authed) return { reason: "adapter-unauthed", detail: c.adapter };
  if (!live) {
    const verdict = h.modelAuth?.[c.model];
    return {
      reason: "model-unavailable",
      detail: verdict?.reason ?? (!verdict ? "no model auth verdict" : verdict.authed ? "outside the served or listed models" : "unauthenticated"),
    };
  }
  return null;
}

export interface DeadPreference { role: "review" | "consult"; entry: string; disallowed: Disallowed }

/**
 * Row 367 R2: a review.prefer or consult.prefer entry is DEAD when every configured channel it matches is
 * disallowed for that role by the merged routing, read under the doctor cache's observed identity. Health
 * never makes an entry dead and never revives one; an entry matching no configured channel is not dead.
 */
export function deadPreferences(
  cfg: TickmarkrConfig, adapters: readonly WorkerAdapter[], health?: Record<string, AuthHealth> | null,
): DeadPreference[] {
  const configured = adapters.flatMap((a) => a.channels(cfg));
  const out: DeadPreference[] = [];
  for (const role of ["review", "consult"] as const) {
    for (const entry of cfg[role].prefer ?? []) {
      const verdicts = configured.filter((c) => preferIndex(c, [entry]) === 0)
        .map((c) => disallowedBy(observedSeat(health, c.adapter, c.model), cfg.routing, role));
      if (verdicts.length && verdicts.every((d) => d !== null)) out.push({ role, entry, disallowed: verdicts[0]! });
    }
  }
  return out;
}
