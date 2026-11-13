// The fleet screen's model: who takes each shape of work and who runs each gate, measured by
// routing the same sample tasks through route() and the seat resolver. Pure: the caller hands in
// the two config layers as text, the doctor results and the adapters; nothing here reads a file.
import { type AuthHealth, type BillingChannel, channelKey, quotaSignal, type WorkerAdapter } from "../adapters/types.js";
import { rolePools } from "../adapters/registry.js";
import { loadConfigWithMode, type ModeResolution, TIER_RANK, type Tier, type TickmarkrConfig } from "../config/config.js";
import { gateReviewerFloor } from "../gates/review.js";
import { SHAPES, type Shape, type Task } from "../graph/schema.js";
import { type Disallowed, disallowedBy, modelProvider, observedSeat, type PreferenceRole } from "../route/preference.js";
import { pickRole } from "../route/role-pick.js";
import { route } from "../route/router.js";
import { carriedAuthorVendors, isIndependentJudge, resolveSeats } from "../route/seat-resolver.js";

export const ROLES: readonly PreferenceRole[] = ["worker", "judge", "review", "consult"];
/** Sample tasks routed per shape. The ids and goals are fixed, so two models compare pick by pick. */
export const SAMPLE = 400;
const DAY = 86_400_000;
export const splitKey = (k: string): [string, string] => { const i = k.indexOf(":"); return [k.slice(0, i), k.slice(i + 1)]; };

/**
 * The name a model is shown by: its own id, as the operator types it, without the provider path a
 * gateway puts in front (`zai/glm-5.3` → `glm-5.3`). Never a rearranged or abbreviated form: a
 * name the screen makes up is one more thing to translate.
 */
export function shortName(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

export interface Verdict { state: "pass" | "fail" | "never" | "missing"; kind?: string; text: string; fix: string; ageDays?: number; raw?: string }
// The remedy a probe failure calls for, read from the failure's own words.
const REMEDIES: ReadonlyArray<readonly [RegExp, string, string, string]> = [
  [/insufficient balance|recharge|add funds/i, "billing", "out of credit", "recharge the account"],
  [/does not have access|upgrade your plan/i, "plan", "plan lacks access", "upgrade the plan"],
  [/token expired|invalid access token|\b401\b/i, "login", "sign-in expired", "sign in again"],
  [/api-key|api key|invalid_api_key/i, "key", "invalid API key", "replace the API key"],
  [/unknown model id|unknown-model|not served/i, "retired", "id no longer served", "remove the id"],
  [/timed out|timeout/i, "timeout", "no answer", "probe it again"],
];
const TIMEOUT = REMEDIES[REMEDIES.length - 1];
// Quota is read by the product's own detector (the one a run's failover uses), after the remedies
// above: "insufficient balance" behind a 429 is a billing matter, not a wait.
const QUOTA = [/$^/, "quota", "out of quota", "wait for the quota to reset"] as const;
export function verdictOf(health: Record<string, AuthHealth> | null, adapter: string, model: string, now: number): Verdict {
  if (!health) return { state: "never", text: "not probed", fix: "probe" };
  const h = health[adapter];
  if (!h) return { state: "never", text: "CLI never checked", fix: "probe" };
  if (!h.installed) return { state: "missing", text: "CLI not installed", fix: `install ${adapter}` };
  const v = h.modelAuth?.[model];
  const ageDays = v?.probedAt ? (now - Date.parse(v.probedAt)) / DAY : undefined;
  if (h.authed === false) return { state: "fail", kind: "login", text: "CLI signed out", fix: `sign in to ${adapter}`, ageDays, raw: h.note };
  if (!v) return { state: "never", text: "not probed", fix: "probe" };
  if (v.authed) return { state: "pass", text: "passed", fix: "", ageDays };
  const reason = v.reason ?? "";
  const hit = v.failure === "timeout" ? TIMEOUT
    : REMEDIES.slice(0, -1).find(([re]) => re.test(reason)) ?? (quotaSignal(reason) ? QUOTA : TIMEOUT[0].test(reason) ? TIMEOUT : undefined);
  return hit ? { state: "fail", kind: hit[1], text: hit[2], fix: hit[3], ageDays, raw: reason }
    : { state: "fail", kind: "other", text: "probe failed", fix: "probe it again", ageDays, raw: reason };
}

export interface Seat {
  key: string; adapter: string; model: string; tier: Tier; vendor: string; provider: string; identity: string; name: string;
  denied: Record<PreferenceRole, Disallowed | null>; live: Record<PreferenceRole, boolean>;
  status: "live" | "dead" | "denied"; verdict: Verdict;
}
export interface Share { key: string; n: number; pct: number; tier: Tier }
export interface ShapeRow {
  shape: Shape; floor: Tier | undefined; pool: readonly string[] | undefined; shares: Share[];
  /** percent of this shape's sample tasks routed below its floor, and percent that could not be routed */
  under: number; unstaffed: number; error: string;
  /** per sample task: [worker, judge, reviewer] channel keys, "none" where there is none */
  picks: Array<[string, string, string]>;
}
export interface Sample {
  /** `total` sample tasks, of which `routed` have a worker */
  rows: Record<Shape, ShapeRow>; total: number; routed: number; noSeat: Shape[]; atFloor: number;
  /** Counts of sample tasks, never rounded shares: a number moves only when tasks do, and "some" never rounds to "none". */
  noReviewer: number; ownVendor: number; under: number; frontierVendors: string[];
  /** shapes with fewer than two working models at their floor: a task that needs the floor has no failover */
  thin: Shape[];
  workers: Array<{ key: string; n: number }>; judges: Array<{ key: string; n: number }>; reviewers: Array<{ key: string; n: number }>;
}
export interface FleetInputs {
  userText: string; repoText: string;
  health: Record<string, AuthHealth> | null;
  adapters: WorkerAdapter[];
  now: number;
  /** seats shown as if their first probe had passed: a new model the user just said yes to */
  assume?: readonly string[];
}
export interface FleetModel {
  inputs: FleetInputs;
  cfg: TickmarkrConfig; mode: ModeResolution;
  health: Record<string, AuthHealth> | null; hasProbe: boolean;
  pools: Record<PreferenceRole, BillingChannel[]>;
  seats: Seat[]; seat(key: string): Seat | undefined; name(key: string): string; provider(key: string): string;
  sample(): Sample;
  /**
   * Shapes whose floor a config sets below what the routing mode says: the shape's own floor, and
   * the mode's. A lowered bar is the operator's to set, and must not read as the mode's bar met.
   */
  lowered: Partial<Record<Shape, { own: Tier; mode: Tier }>>;
  /** the model `fleet --pick consult` returns, or null */
  consult: string | null;
  working: number;
}

const sampleTask = (shape: Shape, i: number): Task => ({
  id: `T${i + 1}`, title: shape, goal: `simulated ${shape} task ${i * 7919}`, shape, complexity: 3, acceptance: ["simulated"], deps: [], files: [], context: [],
  gates: ["build", "test", "lint", "evidence", "scope", "acceptance", "review"], humanGate: false, status: "pending", evidence: { commits: [], artifacts: [], gateResults: [] },
});

function assumed(health: Record<string, AuthHealth> | null, keys: readonly string[], now: number): Record<string, AuthHealth> | null {
  if (!health || !keys.length) return health;
  const out = { ...health };
  for (const k of keys) {
    const [a, m] = splitKey(k);
    const prev = out[a] ?? { installed: true, authed: true, models: [] };
    // (a record of a CLI that is not installed may carry no list of models at all)
    const listed = prev.models ?? [];
    out[a] = { ...prev, installed: true, authed: true, models: listed.includes(m) ? listed : [...listed, m],
      ...(prev.servable && !prev.servable.includes(m) ? { servable: [...prev.servable, m] } : {}),
      modelAuth: { ...prev.modelAuth, [m]: { authed: true, probedAt: new Date(now).toISOString() } } };
  }
  return out;
}

/**
 * The floors a routing mode gives by itself, asked of the loader with that mode alone: a config that
 * sets `routing.mode` and nothing else (RULING-T5 rule 4). No document of the user's is edited or
 * inspected, so the answer is the same however the file writes its floors (an alias, a merge key).
 */
function modeFloors(mode: string): Record<string, Tier> {
  try { return loadConfigWithMode("/", { userOverlayText: `routing:\n  mode: ${JSON.stringify(mode)}\n`, repoOverlayText: "" }).cfg.routing.floors; } catch { return {}; }
}

/** Throws the loader's ConfigError when the two layers do not load: the caller shows it and draws nothing. */
export function buildFleetModel(inputs: FleetInputs): FleetModel {
  const { cfg, mode } = loadConfigWithMode("/", { userOverlayText: inputs.userText, repoOverlayText: inputs.repoText });
  const health = assumed(inputs.health, inputs.assume ?? [], inputs.now);
  const pools = health ? rolePools(cfg, inputs.adapters, health)
    : { worker: [], judge: [], review: [], consult: [] } as Record<PreferenceRole, BillingChannel[]>;
  const inPool = Object.fromEntries(ROLES.map((r) => [r, new Set(pools[r].map(channelKey))])) as Record<PreferenceRole, Set<string>>;
  const seats: Seat[] = Object.entries(cfg.tiers).flatMap(([adapter, t]) => Object.entries(t.models).map(([model, tier]) => {
    const vendor = t.modelOverrides?.[model]?.vendor ?? t.vendor ?? "unknown";
    const observed = observedSeat(health, adapter, model);
    const key = `${adapter}:${model}`;
    const identity = observed.identity ?? model.slice(model.lastIndexOf("/") + 1);
    const denied = Object.fromEntries(ROLES.map((r) => [r, disallowedBy(observed, cfg.routing, r)])) as Seat["denied"];
    const live = Object.fromEntries(ROLES.map((r) => [r, inPool[r].has(key)])) as Seat["live"];
    const anyLive = ROLES.some((r) => live[r]);
    return { key, adapter, model, tier, vendor, provider: modelProvider(model, vendor), identity, name: shortName(identity), denied, live,
      status: anyLive ? "live" : ROLES.every((r) => denied[r]) ? "denied" : "dead", verdict: verdictOf(health, adapter, model, inputs.now) } satisfies Seat;
  }));
  const byKey = new Map(seats.map((s) => [s.key, s]));
  const consultPick = pickRole("consult", cfg, inputs.adapters, health ?? {});
  let cached: Sample | undefined;
  // only a floor a config sets for a shape can differ from the mode's: the second load is made only then
  const own = SHAPES.filter((sh) => mode.provenance[sh] === "config floors" && cfg.routing.floors[sh]);
  const byMode = own.length ? modeFloors(mode.mode) : {};
  const lowered: FleetModel["lowered"] = {};
  for (const sh of own) { const o = cfg.routing.floors[sh], m = byMode[sh]; if (m && TIER_RANK[o] < TIER_RANK[m]) lowered[sh] = { own: o, mode: m }; }
  const model: FleetModel = {
    inputs, cfg, mode, health, hasProbe: health !== null, pools, seats, lowered,
    seat: (k) => byKey.get(k),
    name: (k) => byKey.get(k)?.name ?? shortName(splitKey(k)[1]),
    provider: (k) => byKey.get(k)?.provider ?? modelProvider(splitKey(k)[1], "unknown"),
    sample: () => (cached ??= routeSample(model)),
    consult: consultPick.ok ? channelKey(consultPick.channel) : null,
    working: seats.filter((s) => s.live.worker).length,
  };
  return model;
}

/** The judge and the reviewer one worker's task gets, by the calls `fleet --pick judge|review --author` makes. */
function checkers(M: FleetModel, author: BillingChannel): { judge: string | null; independent: boolean; reviewer: string | null } {
  const { cfg, pools, health } = M;
  const authors = [channelKey(author)];
  const seats = [...pools.judge, ...pools.review];
  let judge: string | null = null, independent = false, reviewer: string | null = null;
  const j = resolveSeats({ role: "judge", cfg, pool: pools.judge, authorPool: pools.review, health, authors });
  if (!j.disallowed && j.pick) {
    judge = channelKey(j.pick);
    const s = seats.find((c) => channelKey(c) === judge);
    independent = !!s && isIndependentJudge(s, carriedAuthorVendors(seats, authors), authors);
  }
  const { floor } = gateReviewerFloor({}, cfg, author, pools.review);
  const r = resolveSeats({ role: "review", pool: pools.review, prefer: cfg.review.prefer ?? [], author, authors, floor, cfg, adapters: M.inputs.adapters, health });
  if (r.pick) reviewer = channelKey(r.pick);
  return { judge, independent, reviewer };
}

function routeSample(M: FleetModel): Sample {
  const { cfg } = M;
  const worker = M.pools.worker;
  const channel = new Map(worker.map((c) => [channelKey(c), c]));
  const memo = new Map<string, ReturnType<typeof checkers>>();
  const rows = {} as Record<Shape, ShapeRow>;
  const tally = { workers: new Map<string, number>(), judges: new Map<string, number>(), reviewers: new Map<string, number>() };
  const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
  let total = 0, under = 0, unstaffed = 0, noReviewer = 0, ownVendor = 0;
  for (const shape of SHAPES) {
    const floor = cfg.routing.floors[shape];
    const counts = new Map<string, number>();
    const picks: ShapeRow["picks"] = [];
    let none = 0, error = "";
    for (let i = 0; i < SAMPLE; i++) {
      let k: string;
      try { k = channelKey(route(sampleTask(shape, i), cfg, worker).assignment); } catch (e) { none++; error ||= e instanceof Error ? e.message : String(e); picks.push(["none", "none", "none"]); continue; }
      bump(counts, k);
      const c = channel.get(k);
      const ch = c ? (memo.get(k) ?? memo.set(k, checkers(M, c)).get(k)!) : { judge: null, independent: false, reviewer: null };
      if (ch.judge) bump(tally.judges, ch.judge);
      if (ch.reviewer) bump(tally.reviewers, ch.reviewer); else noReviewer++;
      if (ch.judge && !ch.independent) ownVendor++;
      picks.push([k, ch.judge ?? "none", ch.reviewer ?? "none"]);
    }
    const shares: Share[] = [...counts].map(([key, n]) => ({ key, n, pct: (100 * n) / SAMPLE, tier: channel.get(key)?.tier ?? "cheap" })).sort((a, b) => b.n - a.n);
    const below = floor ? shares.filter((s) => TIER_RANK[s.tier] < TIER_RANK[floor]).reduce((t, s) => t + s.n, 0) : 0;
    rows[shape] = { shape, floor, pool: cfg.routing.map[shape]?.pool?.channels, shares, under: (100 * below) / SAMPLE, unstaffed: (100 * none) / SAMPLE, error, picks };
    total += SAMPLE; under += below; unstaffed += none;
    for (const s of shares) bump(tally.workers, s.key, s.n);
  }
  const routed = total - unstaffed;
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n }));
  return {
    rows, total, routed, noSeat: SHAPES.filter((s) => rows[s].unstaffed > 0),
    atFloor: SHAPES.filter((s) => rows[s].under === 0 && rows[s].unstaffed === 0).length,
    noReviewer, ownVendor, under,
    frontierVendors: [...new Set(worker.filter((c) => c.tier === "frontier").map((c) => modelProvider(c.model, c.vendor)))],
    thin: SHAPES.filter((s) => {
      const floor = cfg.routing.floors[s] ?? "cheap", pool = cfg.routing.map[s]?.pool?.channels;
      return worker.filter((c) => TIER_RANK[c.tier] >= TIER_RANK[floor] && (!pool || pool.includes(channelKey(c)))).length < 2;
    }),
    workers: top(tally.workers), judges: top(tally.judges), reviewers: top(tally.reviewers),
  };
}

export interface Change { label: string; before: string; after: string; better: boolean }
export interface Consequence { total: number; workers: number; judges: number; reviewers: number; changes: Change[] }
/** What a candidate config changes, over the same sample tasks: only the measures that move. */
export function consequence(A: FleetModel, B: FleetModel): Consequence {
  const a = A.sample(), b = B.sample();
  const moved = (i: 0 | 1 | 2) => SHAPES.reduce((t, s) => t + a.rows[s].picks.filter((p, n) => p[i] !== b.rows[s].picks[n][i]).length, 0);
  // Counts, not shares of the tasks that have a worker: a yes that gives more tasks a worker changes
  // that share without changing a single task's reviewer, and would read "better" or "worse" for nothing.
  const n = (x: number) => x.toLocaleString("en-US");
  const rows: Array<[string, number | string, number | string, "more" | "less" | "seat"]> = [
    ["working models", A.working, B.working, "more"],
    ["frontier vendors among the workers", a.frontierVendors.length, b.frontierVendors.length, "more"],
    ["shapes at their floor", a.atFloor, b.atFloor, "more"],
    ["tasks below their floor", a.under, b.under, "less"],
    ["shapes with no model", a.noSeat.length, b.noSeat.length, "less"],
    ["shapes with fewer than two models at their floor", a.thin.length, b.thin.length, "less"],
    ["tasks with no reviewer", a.noReviewer, b.noReviewer, "less"],
    ["tasks judged by the worker's vendor", a.ownVendor, b.ownVendor, "less"],
    ["consult model", A.consult ? A.name(A.consult) : "nobody", B.consult ? B.name(B.consult) : "nobody", "seat"],
  ];
  const changes = rows.filter(([, x, y]) => x !== y).map(([label, x, y, want]) => ({
    label, before: typeof x === "number" ? n(x) : x, after: typeof y === "number" ? n(y) : y,
    better: want === "seat" ? y !== "nobody" : want === "more" ? parseFloat(String(y)) > parseFloat(String(x)) : parseFloat(String(y)) < parseFloat(String(x)),
  }));
  return { total: a.total, workers: moved(0), judges: moved(1), reviewers: moved(2), changes };
}

/** Probe results older than this are old news: the header warns and the screen asks for a probe. */
export const STALE_DAYS = 3;
/** Days since the oldest probe result the team rests on (the models that take sample work); undefined when none is dated. */
export function evidenceAgeDays(M: FleetModel): number | undefined {
  if (!M.hasProbe) return undefined;
  const used = new Set<string>();
  const sample = M.sample();
  for (const s of SHAPES) for (const p of sample.rows[s].picks) for (const k of p) if (k !== "none") used.add(k);
  const ages = [...used].map((k) => M.seat(k)?.verdict.ageDays).filter((a): a is number => a !== undefined);
  return ages.length ? Math.max(...ages) : undefined;
}
