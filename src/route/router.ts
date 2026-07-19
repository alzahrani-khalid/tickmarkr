import { type Assignment, type BillingChannel, channelKey, channelsFromConfig } from "../adapters/types.js";
import { type TickmarkrConfig, TIER_RANK, type Tier } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { disallowedBy } from "./preference.js";
import { cellOf, EXPLORE_CAP, explorationBonus, learnedScore, MIN_SAMPLES, type RoutingProfile } from "./profile.js";

export type LadderStep = "retry" | "escalate" | "consult" | "human";
export interface RouteDeviation { static: string; chosen: string; score: number; staticScore: number; n: number; explore?: true }
export interface Route { assignment: Assignment; ladder: LadderStep[]; lints: string[]; provenance: string; deviation?: RouteDeviation }

export interface RoutingPreferContext {
  autoPrefer?: { derivedAt: string; [shape: string]: string[] | string };
  doctorFresh: boolean;
  overlayPreferShapes: ReadonlySet<string>;
}

export interface ExploreContext { noExplore?: boolean; quality?: boolean }
export const NO_EXPLORE_ENV = "TICKMARKR_NO_EXPLORE";
export const QUALITY_ENV = "TICKMARKR_QUALITY";
// OBS-74: every routing env seam, in one list — the spawn seam (src/run/git.ts) scrubs exactly
// these from child env so gate/baseline/tip-verify children are hermetic by construction.
export const ROUTING_ENV_SEAMS = [QUALITY_ENV, NO_EXPLORE_ENV] as const;

const exploreCap = (cfg: TickmarkrConfig) => cfg.routing.explore?.cap ?? EXPLORE_CAP;

const qualityOn = (exploreCtx?: ExploreContext): boolean =>
  !!exploreCtx?.quality || process.env[QUALITY_ENV] === "1";

export const raiseTier = (tier: Tier): Tier =>
  tier === "cheap" ? "mid" : tier === "mid" ? "frontier" : "frontier";

const exploreOff = (task: Task, cfg: TickmarkrConfig, exploreCtx?: ExploreContext): boolean => {
  if (qualityOn(exploreCtx) || exploreCtx?.noExplore || process.env[NO_EXPLORE_ENV] === "1") return true;
  const e = cfg.routing.explore;
  if (!e) return false;
  if (e.mode === "off") return true;
  if (e.excludeShapes?.includes(task.shape)) return true;
  const thr = e.excludeComplexityAtOrAbove;
  if (thr != null && task.complexity >= thr) return true;
  return false;
};

const autoPreferList = (doc: RoutingPreferContext["autoPrefer"], shape: string): string[] | undefined => {
  const v = doc?.[shape];
  return Array.isArray(v) ? v : undefined;
};

const preferFromAuto = (shape: string, preferCtx?: RoutingPreferContext): boolean =>
  !!preferCtx?.doctorFresh && !!preferCtx.autoPrefer && !preferCtx.overlayPreferShapes.has(shape) &&
  autoPreferList(preferCtx.autoPrefer, shape) !== undefined;

const effectivePrefer = (shape: string, entry: { prefer?: string[] } | undefined, preferCtx?: RoutingPreferContext): string[] | undefined => {
  if (preferCtx?.overlayPreferShapes.has(shape)) return entry?.prefer;
  if (preferCtx?.doctorFresh && preferCtx.autoPrefer) return autoPreferList(preferCtx.autoPrefer, shape) ?? entry?.prefer;
  return entry?.prefer;
};

export class RoutingError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RoutingError";
  }
}

export function marginalCostRank(c: BillingChannel): number {
  if (c.channel === "sub") return 0; // flat-rate: ~zero marginal cost until quota
  return TIER_RANK[c.tier] + 1;      // metered API: cheap 1, mid 2, frontier 3
}

const toAssignment = (c: BillingChannel): Assignment => ({
  adapter: c.adapter, model: c.model, channel: c.channel, tier: c.tier,
});

function resolvePin(pin: { via: string; model: string }, channels: BillingChannel[]): BillingChannel {
  const c = channels.find((c) => c.adapter === pin.via && c.model === pin.model);
  if (!c) {
    throw new RoutingError(
      `pinned ${pin.via}:${pin.model} not available — doctor found: ${channels.map(channelKey).join(", ") || "(nothing)"}`,
    );
  }
  return c;
}

function preferIndex(c: BillingChannel, prefer: string[] = []): number {
  const i = prefer.findIndex((p) => p === c.adapter || p === channelKey(c));
  return i === -1 ? prefer.length : i;
}

function ladderFor(task: Task, entry?: { escalate?: boolean }): LadderStep[] {
  const escalate = task.routingHints?.escalate ?? entry?.escalate ?? true;
  return escalate ? ["retry", "escalate", "consult", "human"] : ["retry", "consult", "human"];
}

// v1.58 frontier spread (operator ruling .planning/rulings/2026-07-18-frontier-spread-credits.md):
// every sub channel marginal-cost-ranks 0, so tier-equal frontier ties fell through all sort keys
// to discovery order — the first sub channel (claude-code:fable) served every frontier auto pick,
// and same-day quota exhaustion on that one channel interrupted two live pipeline agents. A
// deterministic task-keyed rotation now spreads each residual frontier tie across its whole tie
// group, so sol/k3-class channels serve frontier work as first-class candidates. Strictly the LAST
// tiebreak: it permutes only maximal runs already tied on every key above it (prefer band,
// marginal cost, tier — plus exploration bonus and learned score on the learned path), and only
// runs of zero-marginal-cost frontier SUB channels outside any prefer entry. Pins return upstream,
// denies filter upstream, prefer order is operator-explicit — none are touched.
// ponytail: frontier runs only — the ruled scope (ruling §1); spreading mid/cheap ties too = drop
// the tier guard. Rotation, not utilization: profile-driven spread would be inert exactly where
// the concentration bites (cold profiles, plan-time static routing, learned:off).
const spreadOffset = (task: Task): number => {
  let h = 0;
  for (const ch of `${task.id}\n${task.goal}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};

function spreadFrontierTies(
  sorted: readonly BillingChannel[],
  task: Task,
  prefer: string[] | undefined,
  tied: (a: BillingChannel, b: BillingChannel) => boolean,
): BillingChannel[] {
  const out = [...sorted];
  const preferLen = prefer?.length ?? 0;
  let i = 0;
  while (i < out.length) {
    let j = i + 1;
    while (j < out.length && tied(out[i], out[j])) j++;
    const len = j - i;
    if (len > 1 && out[i].tier === "frontier" && marginalCostRank(out[i]) === 0 && preferIndex(out[i], prefer) === preferLen) {
      const run = out.slice(i, j);
      const k = spreadOffset(task) % len;
      out.splice(i, len, ...run.slice(k), ...run.slice(0, k));
    }
    i = j;
  }
  return out;
}

function withoutExcluded(channels: BillingChannel[], exclude?: ReadonlySet<string>): BillingChannel[] {
  if (!exclude?.size) return channels;
  // OBS-57: in-run demotion after consecutive no-trailer windows — route around poisoned channels for the rest of the run.
  return channels.filter((c) => !exclude.has(channelKey(c)));
}

const qualityBound = (quality: boolean, configFloor: Tier | undefined, taskFloor: Tier | undefined): string | undefined => {
  if (!quality) return undefined;
  if (configFloor) return `floor ${configFloor}→${raiseTier(configFloor)} (--quality)`;
  if (taskFloor) return `floor ${taskFloor}→${raiseTier(taskFloor)} (--quality)`;
  return undefined;
};

const maybeSlaLint = (
  lints: string[], task: Task, profile: RoutingProfile | undefined, slaMinutes: number | undefined, c: BillingChannel,
): void => {
  if (slaMinutes === undefined || !profile) return;
  const cell = cellOf(profile, task.shape, channelKey(c), c.channel);
  if (!cell?.doneMedianMs || cell.doneCount < MIN_SAMPLES) return;
  const slaMs = slaMinutes * 60_000;
  if (cell.doneMedianMs <= slaMs) return;
  const medianMin = Math.round(cell.doneMedianMs / 60_000);
  lints.push(
    `${task.id} (${task.shape}): median ${medianMin}m exceeds sla ${slaMinutes}m — learned perf term references sla ${slaMinutes}m ref`,
  );
};

export function route(task: Task, cfg: TickmarkrConfig, channels: BillingChannel[], profile?: RoutingProfile, preferCtx?: RoutingPreferContext, exclude?: ReadonlySet<string>, exploreCtx?: ExploreContext): Route {
  channels = withoutExcluded(channels, exclude);
  const lints: string[] = [];
  const advisoryFloor = cfg.routing.floors[task.shape];
  const quality = qualityOn(exploreCtx);
  const floor = advisoryFloor;
  const slaMinutes = cfg.routing.sla?.[task.shape];
  // ponytail: sla is plan-time advisory only — never thread into learnedScore (would reroute warm rivals).
  const scoreOpts = { availWeight: cfg.routing.learnedTuning?.availWeight };
  const entry = cfg.routing.map[task.shape];
  const prefer = effectivePrefer(task.shape, entry, preferCtx);
  const prefActive = !!(cfg.routing.allow || cfg.routing.deny);
  const disallowedPin = (via: string, model: string, kind: string) => {
    const d = disallowedBy({ adapter: via, model }, cfg.routing);
    if (d) {
      throw new RoutingError(
        `${task.id}: ${kind} ${via}:${model} is disallowed by routing.${d.by} (${d.entry}) — remove the ${d.by} entry or re-pin to an allowed channel`,
      );
    }
  };
  const preflightPrefer = (p: string) => {
    if (p.includes(":")) {
      const i = p.indexOf(":");
      disallowedPin(p.slice(0, i), p.slice(i + 1), `prefer entry ${p}`);
      return;
    }
    if (cfg.tiers[p]) {
      const expanded = channelsFromConfig(p, cfg);
      if (expanded.length && expanded.every((c) => disallowedBy(c, cfg.routing) !== null)) {
        const d = disallowedBy(expanded[0], cfg.routing)!;
        throw new RoutingError(
          `${task.id}: prefer entry ${p} is disallowed by routing.${d.by} (${d.entry}) — remove the ${d.by} entry or re-pin to an allowed channel`,
        );
      }
      return;
    }
    const d = disallowedBy({ adapter: "", model: p }, cfg.routing);
    if (d) {
      throw new RoutingError(
        `${task.id}: prefer entry ${p} is disallowed by routing.${d.by} (${d.entry}) — remove the ${d.by} entry or re-pin to an allowed channel`,
      );
    }
  };
  const lintFloor = (tier: Tier, what: string) => {
    if (advisoryFloor && TIER_RANK[tier] < TIER_RANK[advisoryFloor]) {
      lints.push(`${task.id} (${task.shape}): ${what} routes ${tier}, below advisory floor ${advisoryFloor}`);
    }
  };

  const taskFloorRaw = task.routingHints?.floor;
  const taskFloor = taskFloorRaw && quality ? raiseTier(taskFloorRaw) : taskFloorRaw;
  const source = task.routingHints?.source;
  const src = source ? `, ${source}` : ""; // never interpolate a possibly-undefined source

  // task pin: planner-authored, try-first — degrades on miss or below-floor (D-05, research A3), never throws
  let degraded = "";
  const taskPin = task.routingHints?.pin;
  if (taskPin) {
    disallowedPin(taskPin.via, taskPin.model, "task pin");
    const c = channels.find((c) => c.adapter === taskPin.via && c.model === taskPin.model);
    if (c && (!taskFloor || TIER_RANK[c.tier] >= TIER_RANK[taskFloor])) {
      lintFloor(c.tier, "task pin");
      maybeSlaLint(lints, task, profile, slaMinutes, c);
      return { assignment: toAssignment(c), ladder: ladderFor(task, entry), lints, provenance: `pin ${taskPin.via}:${taskPin.model} (task hint${src})` };
    }
    const why = c ? `below task floor ${taskFloor}` : "unavailable";
    lints.push(`${task.id}: pinned ${taskPin.via}:${taskPin.model} ${why} — degrading to floor/auto (task hint${src})`);
    degraded = `pin ${taskPin.via}:${taskPin.model} ${why} → `;
  }

  // map pin: operator-authored config — a miss stays fail-loud (D-05)
  if (entry?.pin) {
    disallowedPin(entry.pin.via, entry.pin.model, "map pin (config routing.map)");
    const c = resolvePin(entry.pin, channels);
    lintFloor(c.tier, "map pin");
    maybeSlaLint(lints, task, profile, slaMinutes, c);
    return { assignment: toAssignment(c), ladder: ladderFor(task, entry), lints, provenance: `${degraded}pin ${entry.pin.via}:${entry.pin.model} (config routing.map)` };
  }

  const baseTier: Tier = floor ?? "cheap";
  let minTier: Tier = taskFloor && TIER_RANK[taskFloor] > TIER_RANK[baseTier] ? taskFloor : baseTier; // task floor is a hard >= constraint in all paths (D-04)
  if (quality && advisoryFloor) {
    const raised = raiseTier(advisoryFloor);
    if (TIER_RANK[raised] > TIER_RANK[minTier]) minTier = raised;
  }
  if (prefActive) for (const p of prefer ?? []) preflightPrefer(p);
  // key order is a contract: prefer > marginal cost > tier (cheapest sufficient) > learned score (v1.6 ROUTE-06)
  // > frontier spread (v1.58) > discovery order (same-tier fairness, D2). The learned score decides only the
  // discovery-order tail, never a pin/floor/prefer/cost/tier boundary (they all sort above it, ROUTE-08);
  // the spread rotates only what would otherwise fall to discovery order.
  const staticCmp = (a: BillingChannel, b: BillingChannel) =>
    preferIndex(a, prefer) - preferIndex(b, prefer) || marginalCostRank(a) - marginalCostRank(b) || TIER_RANK[a.tier] - TIER_RANK[b.tier];
  const eligibleRaw = channels.filter((c) => TIER_RANK[c.tier] >= TIER_RANK[minTier]);
  if (!eligibleRaw.length) {
    let msg = `${task.id}: no channel at tier>=${minTier}; available: ${channels.map(channelKey).join(", ") || "(none)"}`;
    if (prefActive) {
      const excluded = Object.keys(cfg.tiers).flatMap((id) => channelsFromConfig(id, cfg))
        .filter((c) => disallowedBy(c, cfg.routing) !== null && TIER_RANK[c.tier] >= TIER_RANK[minTier])
        .map(channelKey);
      if (excluded.length) msg += `; ${excluded.length} channel(s) excluded by routing.allow/deny: ${excluded.join(", ")}`;
    }
    throw new RoutingError(msg);
  }

  let eligible: BillingChannel[];
  let deviation: RouteDeviation | undefined;
  let learnedChosen = "";
  let spreadDecided = false;
  // v1.58: the spread is applied identically on both sort paths (and to the deviation baseline), so
  // an empty/cold profile stays byte-identical to the 3-arg call (ROUTE-07) and a deviation always
  // means learned evidence moved the pick — never the spread mislabeled as learning.
  const spreadStatic = (sorted: BillingChannel[]) => spreadFrontierTies(sorted, task, prefer, (a, b) => staticCmp(a, b) === 0);
  if (profile) {
    // scores precomputed ONCE over the eligible set — never inside the comparator (Pitfall 1).
    // ponytail: no epsilon — two finite scores subtract to a finite number (Phase 12 totality); an
    // epsilon would be intransitive. Upgrade path if warm cells ever tie near-exactly: quantize the score.
    // PROF-04: cells are split by channel class, so pass c.channel explicitly (tsc-required). This map
    // is keyed by channelKey alone, which would collide only if a fleet exposed the same adapter:model on
    // both classes at once — impossible under today's scalar TierEntrySchema.channel.
    // ROUTE-15: availWeight threads from config as a pure param; undefined ⇒ module default (byte-identical).
    const scores = new Map(eligibleRaw.map((c) => [channelKey(c), learnedScore(profile, task.shape, channelKey(c), c.channel, scoreOpts)]));
    const scoreOf = (c: BillingChannel) => scores.get(channelKey(c))!;
    // v1.6 Phase 14: exploration bonus precomputed ONCE (Pitfall 5), a new key ABOVE the score. EXP-01 needs
    // it above the score (a warm-good incumbent can't permanently outrank an under-cap rival in a static tie);
    // magnitude-free as its own lexicographic key. EXP-02 holds structurally: pins returned at :67/:78 and the
    // floor filtered eligibleRaw at :89, all upstream of this block, so the bonus decides only within a static tie.
    const cap = exploreCap(cfg);
    const off = exploreOff(task, cfg, exploreCtx);
    const bonuses = new Map(eligibleRaw.map((c) => [channelKey(c), off ? 0 : explorationBonus(cellOf(profile, task.shape, channelKey(c), c.channel), cap)]));
    const bonusOf = (c: BillingChannel) => bonuses.get(channelKey(c))!;
    const staticWinner = spreadStatic([...eligibleRaw].sort(staticCmp))[0];
    // Phase 34 ROUTE-17: prefer becomes a BAND + group-rep keys so exploration fires ACROSS prefer
    // entries, while intra-entry order (cost > tier > bonus > score) and every cold path stay byte-identical.
    // Cold reduces to preferIndex || cost || tier ≡ staticCmp (proof P1); rep keys use the group HEAD so
    // the probed group's budget self-extinguishes at EXPLORE_CAP (P4); flat lexicographic K is total (P5).
    const preferBands = prefer ?? [];
    const groupCmp = (a: BillingChannel, b: BillingChannel) =>
      marginalCostRank(a) - marginalCostRank(b) || TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
      bonusOf(b) - bonusOf(a) || scoreOf(b) - scoreOf(a);
    const heads = new Map<number, BillingChannel>();
    for (const c of [...eligibleRaw].sort(groupCmp)) {
      const g = preferIndex(c, preferBands);
      if (!heads.has(g)) heads.set(g, c);
    }
    const keyOf = new Map(eligibleRaw.map((c) => {
      const g = preferIndex(c, preferBands);
      const rep = heads.get(g)!;
      return [channelKey(c), [g < preferBands.length ? 0 : 1, -bonusOf(rep), -scoreOf(rep), g,
        marginalCostRank(c), TIER_RANK[c.tier], -bonusOf(c), -scoreOf(c)]] as const;
    }));
    const kOf = (c: BillingChannel) => keyOf.get(channelKey(c))!;
    const firstDiff = (a: BillingChannel, b: BillingChannel) => kOf(a).findIndex((v, i) => v !== kOf(b)[i]);
    const sortedByKey = [...eligibleRaw].sort((a, b) => { const i = firstDiff(a, b); return i === -1 ? 0 : kOf(a)[i] - kOf(b)[i]; });
    // spread runs tied on the FULL learned key (bonus/score included) — a warm score or live probe
    // bonus still decides its tie exactly as before; the spread rotates only the residual all-equal runs.
    eligible = spreadFrontierTies(sortedByKey, task, prefer, (a, b) => firstDiff(a, b) === -1);
    spreadDecided = channelKey(eligible[0]) !== channelKey(sortedByKey[0]);
    const w = eligible[0];
    const ru = channelKey(staticWinner) !== channelKey(w) ? staticWinner : eligible[1];
    // Phase 34 ROUTE-17: first-differing-key markers — probe when a rep or intra bonus key decided.
    const diffKey = ru ? firstDiff(w, ru) : -1;
    const probe = diffKey === 1 || diffKey === 6;
    if (probe) {
      learnedChosen = `via exploration probe (dispatches=${cellOf(profile, task.shape, channelKey(w), w.channel)?.dispatches ?? 0} < ${cap})`;
    } else if (diffKey === 2 || diffKey === 7) {
      const n = cellOf(profile, task.shape, channelKey(w), w.channel)?.n ?? 0;
      learnedChosen = `via learned score ${scoreOf(w).toFixed(3)} (n=${n}) over ${channelKey(ru)} ${scoreOf(ru).toFixed(3)}`;
    }
    if (channelKey(staticWinner) !== channelKey(w)) {
      deviation = { static: channelKey(staticWinner), chosen: channelKey(w), score: scoreOf(w), staticScore: scoreOf(staticWinner), n: cellOf(profile, task.shape, channelKey(w), w.channel)?.n ?? 0, ...(probe ? { explore: true as const } : {}) };
    }
  } else {
    const sortedStatic = eligibleRaw.sort(staticCmp); // ROUTE-07/09: the v1.5 key order, spread applied as the last key
    eligible = spreadStatic(sortedStatic);
    spreadDecided = channelKey(eligible[0]) !== channelKey(sortedStatic[0]);
  }
  const bound =
    qualityBound(quality, advisoryFloor, taskFloorRaw) ??
    (taskFloor && TIER_RANK[taskFloor] >= TIER_RANK[baseTier] ? `floor ${taskFloor} (task hint${src})` :
    floor ? `floor ${floor} (config floors)` :
    "tier cheap (default)");
  // name the key that actually broke the tie: prefer outranks the marginal-cost/tier keys, so if the
  // winner matched a prefer entry, prefer decided it — not "cheapest sufficient tier" (ROUTE-03, WR-01)
  const preferVia = preferFromAuto(task.shape, preferCtx)
    ? `via prefer (auto-modernized ${preferCtx!.autoPrefer!.derivedAt.slice(0, 10)})`
    : "via prefer";
  // a spread-decided winner is never inside a prefer band (the spread skips those runs), so the
  // three arms below are mutually exclusive by construction
  const chosenBy = learnedChosen || (spreadDecided ? "via frontier spread"
    : prefer && preferIndex(eligible[0], prefer) < prefer.length ? preferVia : "cheapest sufficient tier");
  maybeSlaLint(lints, task, profile, slaMinutes, eligible[0]);
  return { assignment: toAssignment(eligible[0]), ladder: ladderFor(task, entry), lints, provenance: `${degraded}${bound}, marginal-cost auto (${chosenBy})`, ...(deviation ? { deviation } : {}) };
}

export function nextChannel(
  current: Assignment,
  task: Task,
  cfg: TickmarkrConfig,
  channels: BillingChannel[],
  tried: string[],
  profile?: RoutingProfile,
  exclude?: ReadonlySet<string>,
): Assignment | null {
  channels = withoutExcluded(channels, exclude);
  // already cheapest-sufficient: TIER_RANK asc is the PRIMARY key so escalation climbs one band at a time.
  // Do NOT "unify" this onto route()'s key order (marginal-cost first) — that reverses climb-one-band on mixed fleets (ROUTE-02, D2).
  // ROUTE-13: learnedScore is the STRICTLY-LAST key — within-band tiebreak only. Precomputed
  // outside the comparator (Pitfall 1), never arithmetic-combined with the band keys, no
  // profile-dependent filter. NO exploration bonus here (route():110 has one; a probe on the
  // failure path would spend a real retry). Absent profile ⇒ every score is 0 ⇒ third key
  // all-ties ⇒ the stable sort preserves the exact v1.7 candidate ORDER.
  const pool = channels.filter((c) => !tried.includes(channelKey(c)) && TIER_RANK[c.tier] >= TIER_RANK[current.tier]);
  const scores = new Map(pool.map((c) => [channelKey(c), profile ? learnedScore(profile, task.shape, channelKey(c), c.channel, { availWeight: cfg.routing.learnedTuning?.availWeight }) : 0]));
  const scoreOf = (c: BillingChannel) => scores.get(channelKey(c))!;
  const candidates = pool.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || marginalCostRank(a) - marginalCostRank(b) || scoreOf(b) - scoreOf(a));
  return candidates.length ? toAssignment(candidates[0]) : null;
}
