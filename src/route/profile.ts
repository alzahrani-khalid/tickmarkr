// v1.6 self-learning routing — Phase 12: pure profile derivation + total scoring.
// pure: no I/O, no clock, no RNG (grep-pinned by tests/route/profile.test.ts); structural
// mirror of TelemetryRow & { runId } — route/ must NOT import run/ (layer DAG: run → route).
// Phase 13 wires learnedScore in as the 4th (last) router sort key; this file only produces it.
import { channelKey } from "../adapters/types.js";

// Structural row type: TelemetryRow & { runId } satisfies it, so tests feed literal arrays and
// the reader's output flows straight in — without a run/ import.
export interface ProfileRow {
  shape: string; adapter: string; model: string; channel: string;
  attempts: number; outcome: "done" | "failed" | "human"; durationMs: number;
  firstAttemptOk?: boolean; gateFails?: number; consults?: number; parkKind?: string;
  runId?: string; // present from readAllTelemetry; unused by v1.6 policy (window already applied)
  taskId?: string; // present from readAllTelemetry; hygiene discount match only (v1.46 T5)
  quotaFailover?: true; // v1.8 TEL-05 mirror (journal.ts:41 — z.literal(true).optional): absent =
                        // unobserved, NEVER false. Branch on `=== true` only; feeds quotaHits (ROUTE-12).
  overrun?: true;        // ROUTE-18 mirror (48-03's TelemetryRowSchema.overrun, daemon.ts !finished branch):
                        // absent = unobserved, NEVER false. Branch on `=== true` only; feeds overruns (OBS-04).
}

export interface ProfileCell {
  n: number;              // weighted effective sample count (n_eff) — post-decay quality obs (CLEAN+DEGRADED+FAIL)
  qSum: number;           // sum of q·w, q ∈ {0, 0.5, 1}, w a dyadic decay weight — exact FP, order-insensitive
  dispatches: number;     // every row with a real channel — Phase 14's utilization input (UNDECAYED)
  doneCount: number;      // done rows contributing a sanitized (finite, ≥0) duration
  quotaHits: number;      // undecayed integer throttle counter (like dispatches — EXP-04 pattern); fed by
                          // quotaFailover fact rows AND parkKind:"quota" parks. REQUIRED so crafted cells must
                          // state it (compile-time totality). ceiling: undecayed in v1.8, matching dispatches.
  doneMedianMs?: number;  // finalized at build time so learnedScore never sorts
  nRaw?: number;          // integer, undecayed quality-observation count — Phase 28/VIS-05 renders raw n
                          // beside n_eff. OPTIONAL so pre-existing fully-typed cell literals (e.g.
                          // tests/route/explore.test.ts:57) stay valid under tsc strict; buildProfile always sets it.
  overruns?: number;      // ROUTE-18 undecayed integer no-trailer counter (like dispatches — EXP-04 pattern);
                          // fed by overrun:true fact rows. OPTIONAL (NOT required like quotaHits) deliberately:
                          // quotaHits is REQUIRED to force crafted-cell totality, but making overruns required would
                          // churn tests/route/{explore,failover,parity,prefer-explore}.test.ts +
                          // tests/cli/report-learning.test.ts crafted-cell literals across parallel worktrees for zero
                          // behavioral gain — the nRaw optional-but-always-set precedent is the deliberate match.
                          // buildProfile always initializes/updates it; coalesced `?? 0` once at the learnedScore read.
  discounted?: number;    // v1.46 T5: rows with hygiene h<1 folded into this cell — optional-but-always-set (nRaw precedent)
}

export interface RoutingProfile { cells: Map<string, ProfileCell> } // key: `${shape}|${adapter}:${model}|${channel}`

// A1 tuning knobs (module constants; promotion to routing.learned.* config is Phase 13's call).
// Every value preserves totality and exact-neutrality — each is a one-line edit.
export const NEUTRAL = 0;
export const MIN_SAMPLES = 5;   // n below this ⇒ score exactly 0 ⇒ static sort keys decide (ROUTE-07)
export const PRIOR_K = 3;       // α=β=3 pseudo-count; denom = n + 2·PRIOR_K ≥ 6 > 0 always
export const PERF_WEIGHT = 0.05; // perf term ∈ (−0.025, +0.025] — strictly below one quality quantum
export const AVAIL_WEIGHT = 0.05; // conservative default, NOT data-derived; penalty-only — avail ∈ [−AVAIL_WEIGHT, 0],
                                  // ≤ one quality quantum; a quotaHits=0 cell contributes exactly 0 (pre-ROUTE-12
                                  // byte-identity for no-throttle profiles)
export const OVERRUN_WEIGHT = 0.05; // ROUTE-18 (OBS-04): conservative default, NOT data-derived; penalty-only —
                                  // overrunPen ∈ [−OVERRUN_WEIGHT, 0], ≤ one quality quantum (twin of AVAIL_WEIGHT);
                                  // an overruns=0 cell contributes exactly 0 (byte-identity for overrun-free profiles).
export const REF_MS = 600_000;  // 10 min; REF_MS/(REF_MS+m) is a total monotone map into (0,1]
export const EXPLORE_CAP = MIN_SAMPLES; // Phase 14 probe budget in dispatches per (shape × channel); A1 knob (2*MIN_SAMPLES = one edit)

// ROUTE-11 evidence decay (v1.8). Quality evidence loses influence by run-recency RANK, so a
// warm-but-bad channel whose luck changed no longer waits the whole RUNS_WINDOW to roll.
export const HALF_LIFE_RUNS = 5; // conservative default, NOT data-derived (real journal: 18 pre-v1.6 rows — cannot tune)
// conservative default, NOT data-derived. TWO-part exactness argument:
//  (granularity) caps weights at ≥ 2^-30 — every weight is an exact dyadic, no underflow;
//  (magnitude)  weights are multiples of 2^-31 ⇒ qSum stays bit-exact while row-count ≪ 2^21
//               (= 2^(51-DECAY_CAP)); raising DECAY_CAP past ~40 would need a canonical fold order.
export const DECAY_CAP = 30;

// w = 2 ** -min(floor(age/halfLife), DECAY_CAP). age/Infinity = 0 ⇒ weight 1 ⇒ decay-off degenerates
// to v1.7 exactly. Dyadic power-of-two weights are the load-bearing exactness property: w·q (q dyadic)
// and every partial sum stay exact in IEEE-754, so the fold is order-insensitive by construction.
export function decayWeight(age: number, halfLife = HALF_LIFE_RUNS): number {
  return 2 ** -Math.min(Math.floor(age / halfLife), DECAY_CAP);
}

// v1.46 T5 evidence hygiene — operator-filed discounts on poisoned runs/tasks. h ∈ {0, 0.5, 1} is dyadic
// so h·w (w a power of two) and every partial sum stay exact; magnitude headroom loses one bit (2^-32 floor).
export const HYGIENE_WEIGHTS = [0, 0.5, 1] as const;
export type HygieneWeight = (typeof HYGIENE_WEIGHTS)[number];

export interface ProfileDiscount {
  runId: string;
  taskId?: string;
  weight: 0 | 0.5;
  reason: string;
}

// Resolve h for one row: run-level marks (no taskId) apply to every row in the run; task-level marks are
// selective. Multiple marks ⇒ minimum weight (most aggressive discount wins).
export function resolveHygieneWeight(row: ProfileRow, discounts: readonly ProfileDiscount[] = []): HygieneWeight {
  if (!discounts.length || row.runId === undefined) return 1;
  let h: HygieneWeight = 1;
  for (const d of discounts) {
    if (d.runId !== row.runId) continue;
    if (d.taskId !== undefined && d.taskId !== row.taskId) continue;
    if (d.weight < h) h = d.weight;
  }
  return h;
}

// Phase 14 exploration bonus: an under-observed channel keeps gathering evidence so early bad luck can't
// starve it permanently (EXP-01). Total by construction — dispatches is a finite non-negative integer counter,
// the denominator is a compile-time positive constant; no ln/sqrt/data-dependent divide, so none of the
// NaN/Infinity hazards that killed UCB and inverse-dispatch. No cell ⇒ 0: an UNKNOWN channel is not
// "under-observed", it is UNOBSERVED — bonusing it would be a discovery-order fairness scheduler (D2 forbids
// it) and would flip learned.test.ts Row 7. Fund from dispatches, not n: a channel that dispatched but
// yielded no quality obs (quota parks) has spent its budget — stop probing it, don't probe it forever.
// ponytail: rank-decay ships in v1.8 (buildProfile below); remaining ceiling = doneMedianMs staleness
// (perf term is undecayed) and per-cell EWMA as the finer upgrade path.
// ROUTE-15 PARAM-SHAPE: optional cap threads from routing.explore.cap; undefined ⇒ module default (byte-identical).
export function explorationBonus(cell: ProfileCell | undefined, cap = EXPLORE_CAP): number {
  if (!cell) return 0;
  return Math.max(0, 1 - cell.dispatches / cap); // ∈ [0,1]; exactly 0 once dispatches ≥ cap
}

const QUALITY_FAIL_PARKS = new Set(["ladder-exhausted", "attempt-cap", "gate-fail"]);

// Quality observation per row: 1 clean, 0.5 degraded, 0 verified failure, null excluded/unobserved.
// Uses gateFails/consults, NOT firstAttemptOk/attempts: firstAttemptOk is `attempt===0` at the global
// loop counter (daemon.ts:347), which quota failovers bump — it would blame the final channel for
// another channel's quota. gateFails/consults are the quota-immune "merged clean" signals. A future
// session must NOT "fix" this back to firstAttemptOk.
// v1.5 rows: optional fields undefined = UNOBSERVED, never 0/false (journal.ts:21-22 — the poisoning bug).
export function classify(r: ProfileRow): 1 | 0.5 | 0 | null {
  if (r.outcome === "done") {
    if (r.gateFails === undefined) return r.attempts === 1 ? 1 : null; // v1.5: >1 attempt = quota-vs-retry ambiguous
    // consults ?? 0 is the ONE deliberate coalesce — safe ONLY behind gateFails !== undefined, because
    // both fields ship together from the same v1.6 write sites (daemon.ts:120,347). Not the banned pattern.
    return r.gateFails === 0 && (r.consults ?? 0) === 0 ? 1 : 0.5;
  }
  if (r.outcome === "human") return r.parkKind !== undefined && QUALITY_FAIL_PARKS.has(r.parkKind) ? 0 : null;
  return null; // "failed" exception rows carry channel "-" — structurally excluded below anyway
}

// PROF-04/05a: SYMMETRIC channel-class split — `channel` is a REQUIRED param (no default, no api
// special-casing) so a forgotten arg is a tsc compile error, not a silent "sub". Ceiling: splitting
// doubles cells per model reachable on both classes; per-cell EXPLORE_CAP/MIN_SAMPLES then means a
// warm model's evidence can dilute below MIN_SAMPLES per class once api channels warm and fall back to
// the exactly-neutral score — that is the correct separated-evidence behavior, not a regression.
const cellKey = (shape: string, chKey: string, channel: string) => `${shape}|${chKey}|${channel}`;

// ROUTE-15 PARAM-SHAPE: optional trailing opts (not PROF-05 required-param) — default is PROVABLY the module
// constant and oracle (a) Object.is byte-identity drill guards a wrong default; zero churn on callers.
export function buildProfile(rows: ProfileRow[], opts: { halfLifeRuns?: number; discounts?: readonly ProfileDiscount[] } = {}): RoutingProfile {
  const halfLife = opts.halfLifeRuns ?? HALF_LIFE_RUNS;
  const cells = new Map<string, ProfileCell>();
  const durs = new Map<string, number[]>();
  // ROUTE-11 pre-pass: rank the DISTINCT defined runIds present. String sort of run-YYYYMMDD-HHMMSS
  // IS chronological — runId content is NEVER parsed. age = numDistinct-1-ascIndex (newest = 0);
  // runId undefined ⇒ age = numDistinct (strictly oldest, least influence — ROUTE-11a, fail toward
  // least influence). numDistinct = 0 (no row carries a runId) ⇒ every age = 0 ⇒ every weight = 1 ⇒
  // byte-identical v1.7 for runId-free inputs. Ranks are relative to the rows present at build time;
  // a profile is built once per route call from readAllTelemetry, so ages cannot drift within one
  // in-memory profile object.
  const sorted = [...new Set(rows.map((r) => r.runId).filter((id): id is string => id !== undefined))].sort();
  const numDistinct = sorted.length;
  const ascIndex = new Map(sorted.map((id, i) => [id, i]));
  const ageOf = (runId: string | undefined): number =>
    runId === undefined ? numDistinct : numDistinct - 1 - ascIndex.get(runId)!;
  for (const r of rows) {
    if (r.adapter === "-") continue; // exception row (daemon.ts:387): no real channel, skip entirely
    const key = cellKey(r.shape, channelKey(r), r.channel);
    let c = cells.get(key);
    if (!c) { c = { n: 0, qSum: 0, dispatches: 0, doneCount: 0, quotaHits: 0, nRaw: 0, overruns: 0 }; cells.set(key, c); durs.set(key, []); }
    c.dispatches++; // utilization axis: every real-channel row, regardless of classification (UNDECAYED — EXP-04)
    if (r.quotaFailover === true || r.parkKind === "quota") c.quotaHits++; // availability fact, never a quality input (ROUTE-12); || not +: a both-marked row counts once
    if (r.overrun === true) c.overruns = (c.overruns ?? 0) + 1; // ROUTE-18 no-trailer fact (OBS-04), never a quality input; === true only — absent = unobserved (48-03's write side feeds this)
    const q = classify(r);
    // w is a power of two and q dyadic ({0, 0.5, 1}) ⇒ every product q·w and every partial sum is EXACT
    // in IEEE-754 ⇒ the fold stays order-insensitive (v1.7's invariant EXTENDED, not abandoned). Magnitude
    // headroom: weights are multiples of 2^-31, so exactness holds while row-count ≪ 2^21. nRaw is the
    // integer undecayed observation count (Phase 28) — never enters the score arithmetic.
    // SINGLE evidence-fold site — hygiene h multiplies quality evidence ONLY (n, qSum), never dispatches/quotaHits/overruns.
    if (q !== null) {
      const h = resolveHygieneWeight(r, opts.discounts);
      const w = decayWeight(ageOf(r.runId), halfLife) * h;
      if (h < 1) c.discounted = (c.discounted ?? 0) + 1;
      c.n += w; c.qSum += q * w; c.nRaw = (c.nRaw ?? 0) + 1;
    }
    if (r.outcome === "done" && Number.isFinite(r.durationMs) && r.durationMs >= 0) {
      c.doneCount++; durs.get(key)!.push(r.durationMs);
    }
  }
  for (const [key, list] of durs) {
    if (list.length === 0) continue;
    const s = list.slice().sort((a, b) => a - b); // median from a sorted copy ⇒ order-insensitive
    const mid = s.length >> 1;
    cells.get(key)!.doneMedianMs = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  return { cells };
}

// The one keyed lookup helper — Phase 13's provenance never hand-builds Map keys.
export function cellOf(profile: RoutingProfile | undefined, shape: string, chKey: string, channel: string): ProfileCell | undefined {
  return profile?.cells.get(cellKey(shape, chKey, channel));
}

// Phase 28/VIS-05: the ONLY place besides cellKey that knows the key format. report.ts iterates cells
// via this and NEVER hand-splits a raw key. PROF-04: chKey is `${adapter}:${model}` (contains ":",
// never "|"); parse channel from the RIGHT (lastIndexOf "|"), shape from the left.
export function* cellsOf(profile: RoutingProfile): Generator<{ shape: string; chKey: string; channel: string; cell: ProfileCell }> {
  for (const key of [...profile.cells.keys()].sort()) {
    const ci = key.lastIndexOf("|");
    const channel = key.slice(ci + 1);
    const rest = key.slice(0, ci);
    const si = rest.indexOf("|");
    yield { shape: rest.slice(0, si), chKey: rest.slice(si + 1), channel, cell: profile.cells.get(key)! };
  }
}

export interface CellSummary {
  nRaw: number; nEff: number; dispatches: number; quality?: number;
  quotaHits: number; cold: boolean; exploreRemaining: number; discounted: number;
}

// Phase 28/VIS-05: the single arithmetic source for the report — report.ts renders, never derives.
// nRaw ?? 0 coalesces HERE (report.ts bans `?? 0`); cold/exploreRemaining reuse the router thresholds.
export function cellSummary(cell: ProfileCell): CellSummary {
  return {
    nRaw: cell.nRaw ?? 0,
    nEff: cell.n,
    dispatches: cell.dispatches,
    quality: cell.n > 0 ? cell.qSum / cell.n : undefined,
    quotaHits: cell.quotaHits,
    cold: cell.n < MIN_SAMPLES,
    exploreRemaining: Math.max(0, EXPLORE_CAP - cell.dispatches),
    discounted: cell.discounted ?? 0,
  };
}

export interface LearnedScoreTerms {
  quality: number;
  perf: number;
  avail: number;
  overrun: number;
}

// Per-term decomposition of learnedScore — the single arithmetic source for profile --explain.
export function learnedScoreTerms(
  profile: RoutingProfile | undefined, shape: string, chKey: string, channel: string,
  opts: { availWeight?: number; slaMinutes?: number } = {},
): LearnedScoreTerms {
  const availWeight = opts.availWeight ?? AVAIL_WEIGHT;
  const refMs = opts.slaMinutes !== undefined ? opts.slaMinutes * 60_000 : REF_MS;
  const cell = cellOf(profile, shape, chKey, channel);
  if (!cell) return { quality: NEUTRAL, perf: NEUTRAL, avail: NEUTRAL, overrun: NEUTRAL };
  // Cold-start proof (ROUTE-07): n ≤ nRaw ≤ dispatches and doneCount ≤ dispatches by construction, so a
  // thin-dispatch cell (dispatches < MIN_SAMPLES) gates ALL THREE terms to literal +0 ⇒ exactly NEUTRAL.
  // Each term is gated INDEPENDENTLY (no early-exit) so a dispatch-warm/quality-cold HIGH-throttle cell can
  // still reach the negative avail term the old `n < MIN ⇒ NEUTRAL` exit suppressed.
  const quality = cell.n < MIN_SAMPLES ? 0 : (cell.qSum + PRIOR_K) / (cell.n + 2 * PRIOR_K) - 0.5; // denom ≥ 2·PRIOR_K > 0
  // REF_MS/(REF_MS+m), NOT range-normalization (x−min)/(max−min): the latter is 0/0 when all durations
  // are identical. median ≥ 0 by the build-time filter ⇒ denom ≥ REF_MS > 0. The leading `cell.n < MIN_SAMPLES ||`
  // is LOAD-BEARING: a null-classified done row bumps doneCount but NOT n (the `n<MIN ⇏ doneCount<MIN` lemma), so
  // without it a {quotaHits=0, n<MIN, doneCount≥MIN} cell would score a nonzero perf where the old early-exit scored
  // 0 — a silent ROUTE-07 break. With it, every quotaHits=0 cell is byte-identical to pre-ROUTE-12.
  const perf = cell.n < MIN_SAMPLES || cell.doneMedianMs === undefined || cell.doneCount < MIN_SAMPLES
    ? 0
    : PERF_WEIGHT * (refMs / (refMs + cell.doneMedianMs) - 0.5);
  // PENALTY-ONLY availability (ROUTE-12): a throttling channel is less available — deprioritize it without ever
  // treating quota as a quality signal, ejecting it, or predicting quota. quotaHits=0 ⇒ avail 0 (no-throttle
  // byte-identity). Gated on dispatches (≥ MIN_SAMPLES > 0 ⇒ positive denominator, no divide-by-zero) INDEPENDENTLY
  // of n, so the perf n-gate never suppresses the throttle penalty. NOT the symmetric (0.5 − ratio) form.
  // ROUTE-16: penalty-only CONFIRMED v1.9 (see .overseer/DECISIONS.md 2026-07-11) — Option B (symmetric
  // 0.5−ratio availability) NOT adopted: no evidence of over-penalization in the real dogfood;
  // PREFER-STARVATION is an orthogonal hint/exploration finding, not an availability defect.
  const avail = cell.dispatches < MIN_SAMPLES ? 0 : -availWeight * (cell.quotaHits / cell.dispatches); // ∈ [−availWeight, 0]
  // PENALTY-ONLY no-trailer overrun (ROUTE-18, OBS-04): a channel that repeatedly burns a whole dispatch
  // window without ever emitting a trailer is less reliable — deprioritize it without ever treating the overrun
  // fact as a quality signal, ejecting it, or predicting it. overruns=0 ⇒ overrunPen 0 (overrun-free byte-identity).
  // Gated on dispatches (≥ MIN_SAMPLES > 0 ⇒ positive denominator, no divide-by-zero) INDEPENDENTLY of n, mirroring
  // the ROUTE-12 avail term exactly. NOT the symmetric (0.5 − ratio) form (the v1.9 ROUTE-16 penalty-only precedent).
  const overrun = cell.dispatches < MIN_SAMPLES ? 0 : -OVERRUN_WEIGHT * ((cell.overruns ?? 0) / cell.dispatches); // ∈ [−OVERRUN_WEIGHT, 0]
  return { quality, perf, avail, overrun };
}

// v1.51 T5 staff-led economics guard (round-3 Fable §3.3): ONE comparison over existing warm cells,
// consumed by plan as an ADVISORY lint only. Evidence display, never a floor input — no routing path
// reads this (anticipatory raises are refused house law: bands move on declarations, structural
// signals, or the failure ladder — never on the profile's prediction).
export const STAFF_LED_MARGIN = 0.1; // "materially below" = two quality quanta (2 × the 0.05 term weights)

export interface StaffLedEvidence { cheapBest: number; midBest: number; n: number }

// Best WARM learned score per band (cold cells — n < MIN_SAMPLES — are not evidence; the warm best is
// the band's incumbent proxy). Null unless BOTH bands are warm AND the mid incumbent leads by at least
// STAFF_LED_MARGIN: silence is the default, so a cold profile can never fire the lint.
export function staffLedEvidence(
  profile: RoutingProfile | undefined,
  shape: string,
  channels: readonly { adapter: string; model: string; channel: string; tier: string }[],
): StaffLedEvidence | null {
  if (!profile) return null;
  const best = (tier: string): { score: number; nRaw: number } | null => {
    let top: { score: number; nRaw: number } | null = null;
    for (const c of channels) {
      if (c.tier !== tier) continue;
      const cell = cellOf(profile, shape, channelKey(c), c.channel);
      if (!cell || cell.n < MIN_SAMPLES) continue;
      const score = learnedScore(profile, shape, channelKey(c), c.channel);
      if (!top || score > top.score) top = { score, nRaw: cell.nRaw ?? 0 };
    }
    return top;
  };
  const cheap = best("cheap");
  const mid = best("mid");
  if (!cheap || !mid || mid.score - cheap.score < STAFF_LED_MARGIN) return null;
  return { cheapBest: cheap.score, midBest: mid.score, n: cheap.nRaw + mid.nRaw };
}

// Total by construction: every miss returns the explicit NEUTRAL constant; every denominator is a
// compile-time-positive constant sum; no Record indexing by row strings (the TIER_RANK[typo] scar).
// Score 0 defers to the static sort keys, which already encode the benchmark-dated tier seeds — a
// per-channel numeric prior would give differing n=0 scores and break ROUTE-07's byte-identical cold
// start. Shrinking toward 0 IS shrinking toward the static prior.
export function learnedScore(
  profile: RoutingProfile | undefined, shape: string, chKey: string, channel: string,
  opts: { availWeight?: number; slaMinutes?: number } = {},
): number {
  const cell = cellOf(profile, shape, chKey, channel);
  if (!cell) return NEUTRAL; // unknown channel ⇒ exactly neutral (empty-profile / cold-start leg, ROUTE-07)
  const t = learnedScoreTerms(profile, shape, chKey, channel, opts);
  return t.quality + t.perf + t.avail + t.overrun; // score ∈ (−0.625, +0.525), finite for every input
}
