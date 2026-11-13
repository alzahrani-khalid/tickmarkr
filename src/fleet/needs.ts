// NEEDS YOU: the closed list of things the fleet screen asks a yes or a no about. Each item is one
// sentence and one question; a yes is a list of config edits. Built from the config as it is, so
// the list does not shift while the user answers.
import { parse } from "yaml";
import { DENY_SCOPES, TIER_RANK, type Tier } from "../config/config.js";
import { SHAPES, type Shape } from "../graph/schema.js";
import { entryMatchesChannel, disallowedBy, observedSeat } from "../route/preference.js";
import { channelKey } from "../adapters/types.js";
import { CLI_CATALOG } from "../adapters/catalog.js";
import { evidenceAgeDays, STALE_DAYS, buildFleetModel, type FleetModel, type Sample, type Seat } from "./model.js";
import type { Edit, Layer } from "./edits.js";
import { freeSeat, othersOf, ruleEdits } from "./rules.js";

export interface NewModel {
  id: string; name: string; provider: string;
  /** one entry per CLI path that lists it; `score` is its benchmark score at that path's effort */
  paths: Array<{ adapter: string; model: string; score?: number }>;
  score: number; best: { score: number; model: string };
  /** the tier its one dated benchmark gives, and the share of the best score that tier needs */
  tier: Tier; needs: number; firstSeen: string;
}
export interface RunDeath { runId: string; seat: string; shapes: Shape[]; tasks: string[] }
/** What a no is remembered by: the item's id and its words, so the item returns when its words change. */
export const needSignature = (n: Pick<Need, "id" | "title" | "ask">): string => `${n.id}\u0000${n.title}\u0000${n.ask}`;
/** `dismissed` holds the signatures the user answered no to. */
export interface NeedsContext { newModels?: readonly NewModel[]; lastRun?: readonly RunDeath[]; dismissed?: ReadonlySet<string> }
export interface Need {
  id: string; title: string; ask: string; detail: string[];
  /** absent: nothing a yes could write; the user acts and probes again */
  edits?: Edit[];
  /** seats a yes adds that have no probe yet: previewed as if their first probe passes */
  assume?: string[];
}

const valueAt = (obj: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((cur, seg) => (cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined), obj);
const list = (xs: readonly string[]): string => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const FLEET_KEYS = ["routing", "tiers", "judge", "review", "consult"] as const;
interface Rule { path: string[]; entry: string; idle: boolean; why: string; workersOnly: boolean }
/** Every deny entry, and whether removing it alone would let any seat back in. */
function denyRules(M: FleetModel): Rule[] {
  const routing = M.cfg.routing;
  const obs = (s: Seat) => observedSeat(M.health, s.adapter, s.model);
  return DENY_SCOPES.flatMap((scope) => ((valueAt(M.cfg, scope.path) as string[] | undefined) ?? []).map((entry) => {
    const workersOnly = scope.path[2] === "workers";
    const roles = workersOnly ? ["worker" as const] : ["worker" as const, "judge" as const, "review" as const, "consult" as const];
    const without = structuredClone(routing);
    const parent = valueAt(without, scope.path.slice(1, -1)) as Record<string, string[]>;
    parent[scope.path[scope.path.length - 1]] = parent[scope.path[scope.path.length - 1]].filter((e) => e !== entry);
    const matched = M.seats.filter((s) => entryMatchesChannel(entry, obs(s), true));
    const bites = matched.some((s) => roles.some((r) => disallowedBy(obs(s), without, r) === null));
    const cover = matched.length && !bites ? disallowedBy(obs(matched[0]), without, roles[0]) : null;
    const why = bites ? "" : !matched.length ? "matches no configured model" : cover?.by === "allow" ? "the allowlist already keeps it out" : "a broader rule already covers it";
    return { path: scope.path, entry, idle: !bites, why, workersOnly };
  }));
}

/**
 * The team built from models that answered: each shape gets the working models at or above its
 * floor, one per vendor first, at most six; where none reaches the floor, the best working tier.
 */
export function recommendedPools(M: FleetModel): Record<string, string[]> {
  const rank = (t: Tier) => TIER_RANK[t];
  const live = [...M.pools.worker].sort((a, b) => rank(b.tier) - rank(a.tier));
  const out: Record<string, string[]> = {};
  for (const shape of SHAPES) {
    const floor = M.cfg.routing.floors[shape] ?? "cheap";
    let cand = live.filter((c) => rank(c.tier) >= rank(floor));
    if (!cand.length && live.length) cand = live.filter((c) => c.tier === live[0].tier);
    const seen = new Set<string>();
    const first = cand.filter((c) => { const p = M.provider(channelKey(c)); if (seen.has(p)) return false; seen.add(p); return true; });
    out[shape] = [...first, ...cand.filter((c) => !first.includes(c))].slice(0, 6).map(channelKey);
  }
  return out;
}

const judgeEdit = (M: FleetModel, key: string, layer: Layer): Edit => {
  const i = key.indexOf(":");
  return { layer, path: ["judge"], value: { adapter: key.slice(0, i), model: key.slice(i + 1) }, label: `judge: ${M.name(key)}` };
};

/** The two config layers as data, for asking which of them holds a path. */
export const parsedLayers = (inputs: { userText: string; repoText: string }): { user: unknown; repo: unknown } =>
  ({ user: parse(inputs.userText || "{}") as unknown, repo: parse(inputs.repoText || "{}") as unknown });
/**
 * Queue row 456 / D-2187 add.215: a layer holds a path when it has a value there, or a null (the
 * loader's tombstone) at an ancestor of it below the root, so an edit beneath a repository tombstone is
 * written where the tombstone is lifted. A null beside the path, or a root null (an empty or
 * comment-only file), says nothing about it.
 */
const holds = (doc: unknown, path: readonly string[]): boolean =>
  valueAt(doc, path) !== undefined || path.slice(0, -1).some((_, i) => valueAt(doc, path.slice(0, i + 1)) === null);
/**
 * An edit goes to the layer that holds what it changes, the product's rule for membership edits
 * applied to every edit: a pool, a tier or a judge kept in the user config is changed there, not
 * copied into the repository's. Held by both, or by neither: the repository's.
 */
export const holderIn = (layers: { user: unknown; repo: unknown }) => (path: readonly string[]): Layer =>
  (holds(layers.repo, path) || !holds(layers.user, path) ? "repo" : "user");

/** Shape names for a title: all nine are "every shape", so a title stays on one row. */
const shapesOf = (shapes: readonly string[]): string[] => (shapes.length === SHAPES.length ? ["every shape"] : [...shapes]);

/**
 * The strongest working models that may take a role, one per provider: the frontier ones, or, on a
 * machine where no frontier model answers, the best tier that does (as the pools do for a floor
 * nobody reaches). Without that the screen could never offer such a machine a judge or a consult.
 */
function strongestFor(M: FleetModel, role: "judge" | "review" | "consult") {
  const able = [...M.pools[role]].filter((c) => c.vendor !== "unknown").sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
  const seen = new Set<string>();
  return able.filter((c) => c.tier === able[0].tier)
    .filter((c) => { const p = M.provider(channelKey(c)); if (seen.has(p)) return false; seen.add(p); return true; });
}

/**
 * A first setup changes what is missing and nothing else (DECISIONS D9): a pool for a shape nobody
 * can take, a judge when the built-in one cannot judge or would judge its own vendor's work, reviewers
 * when tasks have none, a consult model when there is none. A shape that already has
 * a working model keeps it.
 */
function firstSetup(M: FleetModel, layer: Layer): Edit[] {
  const pools = recommendedPools(M), sim = M.sample();
  const out: Edit[] = [];
  const use = new Map<string, number>();
  for (const shape of SHAPES) for (const k of pools[shape]) use.set(M.provider(k), (use.get(M.provider(k)) ?? 0) + 1);
  for (const shape of sim.noSeat) {
    const ch = pools[shape];
    if (ch.length) out.push({ layer, path: ["routing", "map", shape], value: { pool: { mode: "any", channels: ch } }, label: `${shape}: ${ch.map((k) => M.name(k)).join(", ")}` });
  }
  const strongest = (role: "judge" | "review" | "consult") => strongestFor(M, role);
  const judge = strongest("judge").sort((a, b) => (use.get(M.provider(channelKey(a))) ?? 0) - (use.get(M.provider(channelKey(b))) ?? 0))[0];
  if (judge && channelKey(judge) !== channelKey(M.cfg.judge) && (!M.seat(channelKey(M.cfg.judge))?.live.judge || sim.ownVendor > 0)) out.push(judgeEdit(M, channelKey(judge), layer));
  const review = strongest("review").slice(0, 3).map(channelKey);
  if (review.length && !M.cfg.review.prefer?.length && (sim.noReviewer > 0 || !sim.reviewers.length)) out.push({ layer, path: ["review", "prefer"], value: review, label: `review: ${review.map((k) => M.name(k)).join(", ")}` });
  const consult = strongest("consult").slice(0, 2).map(channelKey);
  if (consult.length && !M.cfg.consult.prefer?.length && !M.consult) out.push({ layer, path: ["consult", "prefer"], value: consult, label: `consult: ${consult.map((k) => M.name(k)).join(", ")}` });
  return out;
}

/**
 * A CLI that carries several vendors (or none known): nobody is sent to install one they have not heard of.
 * Decided by the CLI's OWN built-in catalog entry, never by a config's tiers.<adapter>.vendor (D-2187
 * add.246): a "mixed" or null entry, or a CLI the catalog does not list, is a gateway.
 */
const ONE_VENDOR = new Set(CLI_CATALOG.filter((e) => e.vendor && e.vendor !== "mixed").map((e) => e.id));
const gateway = (_M: FleetModel, adapter: string): boolean => !ONE_VENDOR.has(adapter);
/** What brings back a model that does not answer, as an item's instruction. */
const howTo = (M: FleetModel, s: Seat | undefined): string => (!s ? "Add it to the config, then press r."
  : s.verdict.state === "never" || s.verdict.kind === "timeout" ? "Press r to probe it."
  // (a gateway's own CLI is never named to install: a model of one vendor's own CLI is named in its place)
  : s.verdict.state === "missing" && gateway(M, s.adapter) ? "Its CLI is not installed: install one vendor's own agent CLI, name one of its models here, then press r."
  : `${cap(s.verdict.fix)}, then press r.`);

/**
 * The same, for an item whose title does not name the model. A remedy that names its CLI ("install
 * codex", "sign in to codex") stands alone; any other ("recharge the account", "probe it again") is
 * about one model, so the model and what is wrong with it come first.
 */
const howToNamed = (s: Seat): string => (s.verdict.state === "never" || s.verdict.kind === "timeout" ? `Press r to probe ${s.name}.`
  : s.verdict.fix.endsWith(` ${s.adapter}`) ? `${cap(s.verdict.fix)}, then press r.` : `${s.name}: ${s.verdict.text}. ${cap(s.verdict.fix)}, then press r.`);

/**
 * For a line that reads wrong and that no yes can change: the models that do not answer, grouped by
 * what brings them back (install one CLI, sign in to one), and the group whose return gives the
 * team the most, measured by routing with it alive. A CLI that is not installed counts here, as it
 * does not among the models to restore: nobody is told to install a CLI while every line reads ok.
 */
function comeback(M: FleetModel, role: "worker" | "judge" | "review", gain: (sim: Sample) => number): { seat: Seat; n: number } | undefined {
  const prefer = role === "review" ? M.cfg.review.prefer ?? [] : [];
  const named = (s: Seat): number => (prefer.some((e) => e === s.key || e === s.adapter) ? 1 : 0);
  const groups = new Map<string, Seat[]>();
  // A CLI that is not installed is named only when it is one vendor's own: nobody is sent to install a
  // gateway they have not heard of because it carries several vendors and so scores best.
  for (const s of M.seats) if (!s.live[role] && !s.denied[role] && s.verdict.state !== "pass" && !(s.verdict.state === "missing" && gateway(M, s.adapter))) groups.set(`${s.adapter}|${s.verdict.fix}`, [...(groups.get(`${s.adapter}|${s.verdict.fix}`) ?? []), s]);
  const lead = (g: Seat[]): Seat => [...g].sort((a, b) => named(b) - named(a) || TIER_RANK[b.tier] - TIER_RANK[a.tier])[0];
  // ponytail: the six likeliest groups are routed, not every one: each costs a whole sample. More CLIs than that is not a machine this screen has met.
  const tried = [...groups.values()].sort((a, b) => named(lead(b)) - named(lead(a)) || TIER_RANK[lead(b).tier] - TIER_RANK[lead(a).tier]).slice(0, 6);
  let best: { seat: Seat; n: number } | undefined;
  for (const g of tried) {
    const n = gain(buildFleetModel({ ...M.inputs, assume: [...(M.inputs.assume ?? []), ...g.map((s) => s.key)] }).sample());
    if (n > 0 && (!best || n > best.n)) best = { seat: lead(g), n };
  }
  return best;
}

/**
 * For a line that reads wrong and that no yes and no single model's return can change: why the models
 * that could fill it do not, from the same seats the line is drawn from (D-2187 add.244). Each model
 * counts once, under the FIRST reason in a closed order: its CLI is not installed; it does not answer;
 * a deny rule keeps it out; the allowlist keeps it out; anything else. The most common reason is said
 * with its count and the action for it; with no model to count, the line needs another vendor's model
 * that the config does not have. Nobody is sent to a view that does not show the reason.
 */
function cause(M: FleetModel, role: "worker" | "judge" | "review" | "consult", cands: readonly Seat[], floor?: Tier): string {
  if (!cands.length) return role === "judge" || role === "review"
    ? "There is no model of another vendor than the workers' in the config: install a second vendor's CLI, then press r."
    : "No model in the config could take it: install an agent CLI, then press r.";
  const groups = new Map<string, Seat[]>();
  for (const s of cands) {
    const d = s.denied[role];
    const key = s.verdict.state === "missing" ? (gateway(M, s.adapter) ? "1|gateway" : `1|${s.adapter}`)
      : s.verdict.state !== "pass" ? `2|${s.key}` : d?.by === "deny" ? "3|deny" : d ? "4|allow"
      : floor && TIER_RANK[s.tier] < TIER_RANK[floor] ? "5|floor" : "6|other";
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const [key, g] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  const n = g.length, them = n === 1 ? "it" : "them", what = `${plural(n, "model")} that could take this`;
  // the deny rules that keep these models out, named: one rule is "it", several are "them"
  const es = [...new Set(g.flatMap((s) => (s.denied[role]?.by === "deny" ? [s.denied[role]!.entry] : [])))];
  const many = es.length > 1, rules = many ? `the deny rules ${list(es.length > 3 ? [...es.slice(0, 3), `${es.length - 3} more`] : es)}` : `the deny rule ${es[0]}`;
  const change = many ? "change them on their deny lines" : "change it on that deny line";
  // a model whose CLI is missing AND that a rule keeps out: installing the CLI alone brings nothing back
  const d = g.map((s) => s.denied[role]).find(Boolean);
  const also = !d ? "" : d.by === "deny" ? ` ${cap(rules)} ${many ? "keep" : "keeps"} ${them} out too: ${change} under e.`
    : ` The allowlist keeps ${them} out too: add ${them} to routing.allow in the file that holds it.`;
  const [kind, rest] = [key.slice(0, 1), key.slice(2)];
  if (kind === "1") return rest === "gateway" ? `${cap(what)}: ${n === 1 ? "its" : "their"} CLI is not installed. Install a second vendor's CLI, then press r.${also}`
    : `${cap(what)}: ${n === 1 ? "its" : "their"} CLI, ${rest}, is not installed. Install ${rest}, then press r.${also}`;
  if (kind === "2") return `${cap(what)} does not answer: ${g[0].name}, ${g[0].verdict.text}. ${howToNamed(g[0])}`;
  if (kind === "3") return `${cap(what)}: ${rules} ${many ? "keep" : "keeps"} ${them} out. Press e and ${change}.`;
  // (the vendor works, and its models sit below these tasks' review floor: the vendor is there, its tier is not)
  if (kind === "5") return `${cap(what)} answer${n === 1 ? "s" : ""} and ${n === 1 ? "is" : "are"} below these tasks' review floor, ${floor} (the worker's tier, or review.floor: ${M.cfg.review.floor}): give the review a model of another vendor at ${floor} or above (a model's tier is set under tiers in the config), then press r.`;
  if (kind === "4") return `${cap(what)}: the allowlist keeps ${them} out. Add ${them} to routing.allow in the file that holds it (it has no line under e), then press r.`;
  return role === "review" ? `${cap(what)} answer${n === 1 ? "s" : ""} and ${n === 1 ? "is" : "are"} not offered to review: below the review floor (review.floor: ${M.cfg.review.floor}) or not served by ${n === 1 ? "its" : "their"} CLI.`
    : `${cap(what)} answer${n === 1 ? "s" : ""} and ${n === 1 ? "is" : "are"} not offered for it: ${n === 1 ? "its" : "their"} CLI does not serve ${them}.`;
}

/**
 * The models that could fill a judge's or a reviewer's line for the tasks that lack one: of another
 * vendor than THOSE tasks' workers, not filling it now. A vendor working other tasks stays a candidate
 * for these: its models that a rule keeps out are what the item names.
 */
const otherVendors = (M: FleetModel, sim: Sample, role: "judge" | "review"): { cands: Seat[]; floor?: Tier } => {
  const picks = SHAPES.flatMap((sh) => sim.rows[sh].picks).filter(([w, j, r]) => w !== "none" && (role === "review" ? r === "none" : j !== "none" && M.provider(j) === M.provider(w)));
  const mine = new Set(picks.map(([w]) => M.provider(w)));
  const other = (s: Seat): boolean => !mine.size || [...mine].some((p) => p !== s.provider);
  // A reviewer is at least the worker's tier and review.floor: the lowest such floor among these tasks.
  // A model of another vendor that reviews other tasks and sits below it is a candidate too, held out by
  // its tier, never "no model of another vendor".
  const fl = (w: string): Tier => { const t = M.seat(w)?.tier ?? "cheap", f = M.cfg.review.floor; return f !== "worker" && TIER_RANK[f] > TIER_RANK[t] ? f : t; };
  const floor = role === "review" && picks.length ? picks.map(([w]) => fl(w)).sort((a, b) => TIER_RANK[a] - TIER_RANK[b])[0] : undefined;
  // (no task has a worker: every model that does not fill the line could)
  return { cands: M.seats.filter((s) => other(s) && (!s.live[role] || (!!floor && s.verdict.state === "pass" && TIER_RANK[s.tier] < TIER_RANK[floor]))), floor };
};

/** A model that does not work, and what the team gets back when it does: measured by routing with it alive. */
function restorable(M: FleetModel): Need[] {
  const named = new Set<string>([...SHAPES.flatMap((s) => M.cfg.routing.map[s]?.pool?.channels ?? []), ...(M.cfg.consult.prefer ?? []), ...(M.cfg.review.prefer ?? []),
    channelKey(M.cfg.judge), channelKey(M.cfg.consult), ...SHAPES.flatMap((s) => { const p = M.cfg.routing.map[s]?.pin; return p ? [`${p.via}:${p.model}`] : []; })]);
  const dead = M.seats.filter((s) => s.status === "dead" && s.verdict.state === "fail" && named.has(s.key));
  const groups = new Map<string, Seat[]>();
  for (const s of dead) groups.set(`${s.identity}|${s.verdict.fix}`, [...(groups.get(`${s.identity}|${s.verdict.fix}`) ?? []), s]);
  const base = M.sample();
  const out: Array<Need & { score: number }> = [];
  for (const seats of groups.values()) {
    const W = buildFleetModel({ ...M.inputs, assume: [...(M.inputs.assume ?? []), ...seats.map((s) => s.key)] });
    const sim = W.sample();
    const gains: Array<[string, number]> = [];
    const staffed = base.noSeat.length - sim.noSeat.length;
    if (staffed > 0) gains.push([`${plural(staffed, "shape gets", "shapes get")} a working model`, 100 * staffed]);
    if (!M.consult && W.consult) gains.push(["the consult gets its model", 80]);
    const vendors = sim.frontierVendors.length - base.frontierVendors.length;
    if (vendors > 0) gains.push([`+${plural(vendors, "frontier vendor")}`, 30]);
    if (base.noReviewer > sim.noReviewer) gains.push([`${(base.noReviewer - sim.noReviewer).toLocaleString("en-US")} more sample tasks get a reviewer`, (100 * (base.noReviewer - sim.noReviewer)) / base.total]);
    if (base.under > sim.under) gains.push([`${(base.under - sim.under).toLocaleString("en-US")} fewer sample tasks below their floor`, (100 * (base.under - sim.under)) / base.total]);
    if (!gains.length) continue;
    const s = seats[0], v = s.verdict;
    out.push({ id: `fix:${s.identity}:${v.kind}`, score: gains.reduce((t, g) => t + g[1], 0),
      title: `${s.name} does not work: ${v.text} (${[...new Set(seats.map((x) => x.adapter))].join(", ")}).`,
      ask: `${v.kind === "timeout" ? "Press r to probe it again" : `${cap(v.fix)}, then press r`}. You get: ${gains[0][0]}.`,
      detail: [...(v.raw ? [`The probe said: ${v.raw.slice(0, 240)}`] : []), ...gains.map((g) => `You get: ${g[0]}.`)] });
  }
  return out.sort((a, b) => b.score - a.score).map(({ score: _score, ...need }) => need);
}

/** What needs a yes or a no, most urgent first. */
export function needs(M: FleetModel, ctx: NeedsContext = {}): Need[] {
  const out: Need[] = [];
  const { cfg } = M;
  if (!M.hasProbe) {
    return [{ id: "probe", title: "No probe yet: tickmarkr does not know which models answer.", ask: "Press r to probe them.",
      detail: ["A probe asks each configured model one short question and records who answered.", "Nothing is proposed for a model that has not answered."] }];
  }
  const layers = parsedLayers(M.inputs);
  const holder = holderIn(layers);
  // A first install: neither layer says anything about the fleet yet. `init` writes a config file
  // before the screen opens, so "no file" is not the test; "no fleet key in it" is.
  const declares = (layer: unknown) => FLEET_KEYS.some((k) => valueAt(layer, [k]) !== undefined);
  const fresh = !declares(layers.user) && !declares(layers.repo);
  const sim = M.sample();
  const pools = recommendedPools(M);
  // A line that reads wrong always has an item. Where no yes can change it, the item says what to do.
  const installed = Object.values(M.health ?? {}).some((h) => h.installed), answers = M.seats.some((s) => s.verdict.state === "pass");
  const noConsult = answers ? `No working model may consult. ${cause(M, "consult", M.seats.filter((s) => !s.live.consult))}` : "Nothing to do here yet: once a model answers the probe, this item offers it.";
  const nobody = (): Need => {
    const them = sim.noSeat.length === 1 ? "it" : "them";
    const back = installed ? comeback(M, "worker", (w) => sim.noSeat.length - w.noSeat.length) : undefined;
    return { id: "noseat", title: `${list(shapesOf(sim.noSeat))}: no working model.`,
      ask: !installed ? "No agent CLI is installed. Install one, then press r."
        : back ? `${howToNamed(back.seat)} You get: a working model for ${back.n === sim.noSeat.length ? them : plural(back.n, "shape")}.`
        : `No working model may take ${them}. ${cause(M, "worker", M.seats.filter((s) => !s.live.worker))}`,
      detail: ["No working model can take this work, so its tasks cannot start.", "There is nothing a yes could change: no model that answers the probe may take it.",
        ...(back ? [`${back.seat.key}: ${back.seat.verdict.text}.`] : [])] };
  };
  const unreviewed = (): Need | undefined => {
    if (sim.reviewers.length && !sim.noReviewer) return undefined;
    // No task has a worker (a rule keeps every model from work, or no pool names one that answers):
    // the review has nothing to check, and its remedy is the workers', never a reviewer's rule.
    const able = M.seats.filter((s) => s.live.review).length;
    if (!sim.routed && able) return { id: "review", title: `The review has no work: ${plural(able, "working model")} may review, and no task has a worker for ${able === 1 ? "it" : "them"} to check.`,
      ask: "It follows the workers: once a shape has a working model, the review has work. The item about the shapes says what to do.",
      detail: ["A task is reviewed after its worker is done; with no worker for any shape, no task reaches a reviewer.", "No reviewer needs changing: the shapes' item says what keeps the workers out."] };
    const reviewed = (s: Sample): number => s.routed - s.noReviewer;
    const back = comeback(M, "review", (w) => reviewed(w) - reviewed(sim));
    return { id: "review", title: sim.reviewers.length ? `${sim.noReviewer.toLocaleString("en-US")} of ${sim.routed.toLocaleString("en-US")} sample tasks have no reviewer.` : "The review has no model: no working model may review this team's work.",
      ask: back ? `${howToNamed(back.seat)} You get: ${back.n.toLocaleString("en-US")} more sample tasks get a reviewer.`
        : installed ? `No working model of another vendor may review${sim.reviewers.length ? " them" : ""}. ${(({ cands, floor }) => cause(M, "review", cands, floor))(otherVendors(M, sim, "review"))}` : "A reviewer is from another vendor than the worker's: install a second vendor's CLI too, then press r.",
      detail: [`A reviewer is a working model from another vendor than the task's worker, at the review floor (review.floor: ${M.cfg.review.floor}).`,
        ...(M.cfg.review.required ? ["Review is required (review.required): a task with no reviewer cannot pass its review gate."] : []),
        // (true of every task and of some alike: where others are reviewed, a model of another vendor works and may not review these)
        "There is nothing a yes could change: for these tasks no working model that may review them is from another vendor than their worker.", ...(back ? [`${back.seat.key}: ${back.seat.verdict.text}.`] : [])] };
  };

  const ownVendor = (): Need | undefined => {
    if (!sim.ownVendor) return undefined;
    const back = comeback(M, "judge", (w) => sim.ownVendor - w.ownVendor);
    return { id: "ownvendor", title: `The judge checks its own vendor's work on ${sim.ownVendor.toLocaleString("en-US")} of ${sim.routed.toLocaleString("en-US")} sample tasks.`,
      ask: back ? `${howToNamed(back.seat)} You get: ${back.n.toLocaleString("en-US")} more sample tasks get a judge of another vendor.` : `No working model of another vendor may judge them. ${cause(M, "judge", otherVendors(M, sim, "judge").cands)}`,
      detail: ["Acceptance is judged by a model from another vendor than the task's worker wherever one works.", "For these tasks none does, so the judge is from the worker's own vendor.",
        "There is nothing a yes could change: for these tasks no working model that may judge them is from another vendor than their worker.", ...(back ? [`${back.seat.key}: ${back.seat.verdict.text}.`] : [])] };
  };

  if (fresh) {
    const es = firstSetup(M, "repo");
    const judgeDown = !M.seat(channelKey(cfg.judge))?.live.judge;
    const lacks = [...shapesOf(sim.noSeat), ...(judgeDown ? ["the judge"] : []), ...(M.consult ? [] : ["the consult"])];
    if (es.length) {
      out.push({ id: "setup",
        title: lacks.length ? `First setup: nobody for ${list(lacks)}.`
          : sim.noReviewer ? "First setup: some tasks have no reviewer from another vendor." : "First setup: the judge would check its own vendor's work.",
        ask: "Use models that answered for what is missing?", edits: es,
        detail: ["The built-in defaults name models that did not answer on this machine.", "Yes changes only what is missing, with models that answered the probe.",
          "A shape that already has a working model keeps it."] });
    }
    // what the setup cannot fill is still said, with what to do: a line that reads wrong always has an item
    if (sim.noSeat.length && !es.some((e) => e.path[1] === "map")) out.push(nobody());
    if (judgeDown && !es.some((e) => e.path[0] === "judge")) out.push({ id: "judge", title: `The judge (acceptance) does not answer: ${channelKey(cfg.judge)}, ${M.seat(channelKey(cfg.judge))?.verdict.text ?? "not configured"}.`,
      ask: `No other working model may judge. ${howTo(M, M.seat(channelKey(cfg.judge)))}`, detail: [`The built-in judge is ${channelKey(cfg.judge)}.`] });
    const own = judgeDown || es.some((e) => e.path[0] === "judge") ? undefined : ownVendor();
    if (own) out.push(own);
    // (the setup's own reviewers are a preference among working models: where none is from another vendor, the item still says so)
    const review = unreviewed();
    if (review) out.push(review);
    if (!M.consult && !es.some((e) => e.path[0] === "consult")) out.push({ id: "consult", title: "The consult has no model: consult.prefer is not set.",
      ask: noConsult, detail: ["The consult seat is picked from consult.prefer, and no config sets it.", "No model that answered the probe is allowed to consult."] });
  } else {
    if (sim.noSeat.length) {
      // A pool that is there keeps its entries and its mode: its models may only be out for a day. A PIN
      // is kept the same way: the pinned model stays first, in an ordered pool, so the others take the
      // work while it does not answer and it takes all of it again the day it does.
      // (only a pinned model that can come back: one the config itself keeps out, or that no CLI lists,
      // would sit in the pool as an entry that does nothing, and be asked about again by the tidy item)
      const pinOf = (s: string) => { const slot = cfg.routing.map[s], key = slot?.pin && !slot.pool ? `${slot.pin.via}:${slot.pin.model}` : undefined; const seat = key ? M.seat(key) : undefined; return seat && !seat.denied.worker ? key : undefined; };
      const withOld = (s: string) => {
        const old = cfg.routing.map[s]?.pool, pin = pinOf(s), kept = old?.channels ?? (pin ? [pin] : []);
        return { mode: old?.mode ?? (pin ? "ordered" as const : "any" as const), channels: [...kept, ...pools[s].filter((k) => !kept.includes(k))] };
      };
      const fill = sim.noSeat.filter((s) => pools[s].length);
      const es = fill.map((s): Edit => ({ layer: holder(["routing", "map", s]), path: ["routing", "map", s], value: { pool: withOld(s) },
        label: `${s}: ${pinOf(s) ? `keep ${M.name(pinOf(s)!)} first; while it does not answer, ` : cfg.routing.map[s]?.pool ? "add " : ""}${pools[s].filter((k) => k !== pinOf(s)).map((k) => M.name(k)).join(", ")}` }));
      // Where no working model reaches a shape's floor, the best there is goes below it: the question
      // and the details say so, as the review's count of tasks below their floor does.
      const under = fill.filter((s) => { const floor = cfg.routing.floors[s]; return !!floor && pools[s].every((k) => TIER_RANK[M.seat(k)?.tier ?? "cheap"] < TIER_RANK[floor]); });
      const them = sim.noSeat.length === 1 ? "it" : "them";
      if (es.length) out.push({ id: "noseat", title: `${list(shapesOf(sim.noSeat))}: no working model.`,
        ask: `Use ${pools[fill[0]].filter((k) => k !== pinOf(fill[0])).slice(0, 3).map((k) => M.name(k)).join(", ")} for ${them}?${under.length ? ` ${under.length === fill.length ? "That is" : `For ${list(under)} that is`} below the floor: no working model reaches it.` : ""}`, edits: es,
        detail: ["No working model can take this work, so its tasks cannot start.",
          under.length === fill.length ? `No working model reaches ${under.length === 1 ? "its floor" : "their floors"}: yes gives ${them} the best that work, below the floor, and the review counts the tasks that then run below it.`
            : under.length ? `Yes gives ${them} the working models at the floor; for ${list(under)} none reaches it, so those get the best that work, below the floor.` : `Yes gives ${them} the working models at ${sim.noSeat.length === 1 ? "its floor" : "their floors"}.`,
          ...(fill.some((s) => pinOf(s)) ? [`${list(fill.filter((s) => pinOf(s)))} ${fill.filter((s) => pinOf(s)).length === 1 ? "is" : "are"} pinned to one model: it stays first, in an ordered pool, and takes the work again when it answers.`] : [])] });
      else out.push(nobody());
    }
    // The judge: a pinned judge that does not answer is still the one a run would send the work to.
    const pinned = channelKey(cfg.judge);
    if (!M.seat(pinned)?.live.judge) {
      const next = [...M.pools.judge].filter((c) => c.vendor !== "unknown").sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0];
      // two different faults: the model answers but a rule keeps it from judging, or it does not answer
      const seat = M.seat(pinned), barred = seat?.verdict.state === "pass" ? seat.denied.judge : null;
      const title = barred ? `The judge (acceptance) is ${barred.by === "allow" ? "not on the allowlist" : "kept out by a deny rule"}: ${pinned}.`
        : `The judge (acceptance) does not answer: ${pinned}, ${seat?.verdict.text ?? "not configured"}.`;
      out.push(next
        ? { id: "judge", title, ask: `Use ${M.name(channelKey(next))} as the judge?`, edits: [judgeEdit(M, channelKey(next), holder(["judge"]))],
          detail: [`The config's judge is ${pinned}. A run sends every acceptance check to it first.`, `Yes makes ${channelKey(next)} the judge: the strongest working model that may judge.`,
            "Where the judge shares a worker's vendor, a run still picks an independent one for that task."] }
        : { id: "judge", title, ask: `No other working model may judge. ${!barred ? howTo(M, seat) : barred.by === "allow" ? `It is not on the allowlist: add ${pinned} to routing.allow in the config, then press r.` : `The deny rule ${barred.entry} keeps it out: press e and change it on that deny line.`}`, detail: [`The config's judge is ${pinned}.`] });
    } else {
      const own = ownVendor();
      if (own) out.push(own);
    }
    const review = unreviewed();
    if (review) out.push(review);
    if (!M.consult) {
      const chain = [...new Set([...(cfg.consult.prefer ?? []), channelKey(cfg.consult)])];
      const blocked = chain.map((k) => M.seat(k)).find((s): s is Seat => !!s && s.verdict.state === "pass" && !!s.denied.consult);
      if (!cfg.consult.prefer?.length) {
        // The seat picker reads consult.prefer and nothing else: with none set, nobody can be picked,
        // whatever works and whatever a rule allows. Narrowing a deny rule would change nothing.
        const able = strongestFor(M, "consult").slice(0, 2).map(channelKey);
        out.push(able.length
          ? { id: "consult", title: "The consult has no model: consult.prefer is not set.", ask: `Use ${able.map((k) => M.name(k)).join(", ")} for it?`,
            edits: [{ layer: holder(["consult", "prefer"]), path: ["consult", "prefer"], value: able, label: `consult: ${able.map((k) => M.name(k)).join(", ")}` }],
            detail: ["The consult seat is picked from consult.prefer, and no config sets it.", `Yes sets it to ${list(able)}: the strongest working models that may consult, one per vendor.`,
              "Until then a stalled task goes straight to you, and the overseer skill cannot start: it picks its orchestrator from the consult."] }
          : { id: "consult", title: "The consult has no model: consult.prefer is not set.", ask: noConsult,
            detail: ["The consult seat is picked from consult.prefer, and no config sets it.", "No model that answered the probe is allowed to consult."] });
      } else if (blocked) {
        // Free the seat for consulting, and nothing more: every rule of its own in its way is lifted (a
        // model can be kept out by a deny rule and the allowlist at once), and it still takes no task.
        // A rule wider than the model is not a yes about this model: it is named, and changed by hand.
        const routing = structuredClone(cfg.routing) as typeof cfg.routing;
        const { freed, why } = freeSeat(routing, observedSeat(M.health, blocked.adapter, blocked.model), blocked.key, "consult", othersOf(M, blocked.key));
        const edits: Edit[] = freed ? ruleEdits(cfg.routing, routing, holder) : [];
        if (!freed) out.push({ id: "consult", title: `The consult has no model: ${blocked.key} is under a wider rule.`, ask: "Press e and change that rule on its deny line.",
          detail: [`consult.prefer names ${blocked.key}. It answered the last probe.`, `It is kept out by ${list(why)}.`,
            "A yes here would lift that rule for every model it covers, so there is none: e lists the deny lists, and what you untick there is shown before it is saved.",
            "Until then a stalled task goes straight to you, and the overseer skill cannot start: it picks its orchestrator from the consult."] });
        else if (edits.length) out.push({ id: "consult", title: "The consult has no model.", ask: `Let ${blocked.key} consult, judge and review? It still takes no task of any shape.`, edits,
          detail: [`consult.prefer names ${blocked.key}. It answered the last probe.`, `It is kept out by ${list(why)}.`,
            "Yes lets it consult, and also judge and review, and keeps it under routing.deny.workers: it takes no task of any shape, plan and spec included.", "To let it take a shape as well, press e and tick it on that shape's line.",
            "Until then a stalled task goes straight to you, and the overseer skill cannot start: it picks its orchestrator from the consult."] });
      } else if (chain.length) {
        const s = M.seat(chain[0]);
        const answers = s?.verdict.state === "pass";
        out.push({ id: "consult", title: answers ? `The consult has no model: ${chain[0]} answers but cannot take the consult seat.` : `The consult has no model: ${chain[0]}, ${s ? s.verdict.text : "not configured"}.`,
          ask: answers ? "Name another model in consult.prefer, then press r." : howTo(M, s),
          detail: [`consult.prefer names ${chain[0]}.`, "A stalled task goes straight to you until this is fixed."] });
      }
    }
  }
  // A judge that answers has nothing to check while no task has a worker: its line reads NO MODEL too,
  // and the item says it follows the workers.
  if (!sim.judges.length && M.seat(channelKey(cfg.judge))?.live.judge && !out.some((n) => n.id === "judge" || (n.id === "setup" && n.edits?.some((e) => e.path[1] === "map")))) {
    out.push({ id: "judge", title: `The judge (acceptance) has no work: ${channelKey(cfg.judge)} answers, and no task has a worker for it to check.`,
      ask: "It follows the workers: once a shape has a working model, the judge has work. The item about the shapes says what to do.",
      detail: [`The config's judge is ${channelKey(cfg.judge)}, and it answers.`, "A task is judged after its worker is done; with no worker for any shape, no task reaches the judge."] });
  }

  for (const d of fresh ? [] : ctx.lastRun ?? []) {
    const es = d.shapes.flatMap((sh): Edit[] => {
      const slot = cfg.routing.map[sh];
      // "at that shape's floor" is the promise: a fallback below the floor would put tasks under it
      const floor = cfg.routing.floors[sh];
      const add = pools[sh].filter((k) => !(slot?.pool?.channels ?? []).includes(k) && (!floor || TIER_RANK[M.seat(k)?.tier ?? "cheap"] >= TIER_RANK[floor]));
      return slot?.pool && add.length ? [{ layer: holder(["routing", "map", sh]), path: ["routing", "map", sh], value: { pool: { mode: slot.pool.mode, channels: [...slot.pool.channels, ...add] } }, label: `${sh}: add ${add.map((k) => M.name(k)).join(", ")} as fallbacks` }] : [];
    });
    if (es.length) out.push({ id: `run:${d.runId}:${d.seat}`, title: `Last run: ${M.name(d.seat)} hit its limit and no other model could take over.`,
      ask: `Add ${es[0].label.replace(/^.*: add /, "").replace(" as fallbacks", "")} as fallbacks for ${list(d.shapes)}?`, edits: es,
      detail: [`Run ${d.runId}: ${d.seat} ran out of quota and nothing else could take the work${d.tasks.length ? ` (${d.tasks.join(", ")})` : ""}.`,
        "Yes adds the other working models at that shape's floor to its pool, so a task that needs the floor has somewhere to go.",
        "Everyday tasks may keep their worker: inside one vendor the cheapest model still goes first."] });
  }

  for (const n of ctx.newModels ?? []) {
    // Once one path to it holds a tier, the model is no longer new: its other paths are not nagged about.
    // A configured alias counts by the model it was probed as: claude-code:fable is claude-fable-5-2.
    const bare = (id: string) => id.slice(id.lastIndexOf("/") + 1).replace(/-(low|medium|high|xhigh|max)(-fast)?$/, "");
    if (M.seats.some((s) => bare(s.model) === n.id || bare(s.identity) === n.id)) continue;
    const best = new Map<string, NewModel["paths"][number]>();
    for (const p of n.paths) { const cur = best.get(p.adapter); if (!cur || (p.score ?? 0) > (cur.score ?? 0)) best.set(p.adapter, p); }
    // Only through a CLI the team already works through: a new model is not a reason to start using
    // another CLI. Where none of them lists it, its single strongest path is offered.
    const inUse = new Set(M.seats.filter((s) => s.status === "live").map((s) => s.adapter));
    const unlisted = [...best.values()].filter((p) => !M.seat(`${p.adapter}:${p.model}`));
    const known = unlisted.filter((p) => inUse.has(p.adapter));
    const paths = known.length ? known : unlisted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 1);
    if (!paths.length) continue;
    const keys = paths.map((p) => `${p.adapter}:${p.model}`);
    const edits: Edit[] = paths.flatMap((p): Edit[] => [
      { layer: holder(["tiers", p.adapter]), path: ["tiers", p.adapter, "models", p.model], value: n.tier, label: `${p.adapter}:${p.model} is ${n.tier}` },
      ...(["mixed", "unknown", null, undefined].includes(cfg.tiers[p.adapter]?.vendor) ? [{ layer: holder(["tiers", p.adapter]), path: ["tiers", p.adapter, "modelOverrides", p.model, "vendor"], value: n.provider, label: `${p.adapter}:${p.model} is served by ${n.provider}` }] : []),
    ]);
    // the allowlist gains only what it leaves out: a model whose CLI is allowed whole needs no entry
    const shut = paths.filter((p) => disallowedBy({ adapter: p.adapter, model: p.model }, cfg.routing, "worker")?.by === "allow").map((p) => `${p.adapter}:${p.model}`);
    if (shut.length) edits.push({ layer: holder(["routing", "allow", "models"]), path: ["routing", "allow", "models"], value: [...(cfg.routing.allow?.models ?? []), ...shut], label: `allow ${shut.join(", ")}` });
    const joined: string[] = [];
    for (const sh of SHAPES) {
      const slot = cfg.routing.map[sh];
      if (!slot?.pool || TIER_RANK[n.tier] < TIER_RANK[cfg.routing.floors[sh] ?? "cheap"]) continue;
      joined.push(sh);
      edits.push({ layer: holder(["routing", "map", sh]), path: ["routing", "map", sh], value: { pool: { mode: slot.pool.mode, channels: [...slot.pool.channels, ...keys.filter((k) => !slot.pool!.channels.includes(k))] } }, label: `${sh}: add ${n.name} to the pool` });
    }
    out.push({ id: `new:${n.id}`, title: `New model: ${n.name} (${n.provider}), on ${list(paths.map((p) => p.adapter))}.`, ask: `Add it as ${n.tier}? That rests on one benchmark of two: Artificial Analysis ${n.score} (your best: ${n.best.score}); it has no Terminal-Bench score.`, edits, assume: keys,
      detail: [`A probe first listed it on ${n.firstSeen}.`,
        `Artificial Analysis Intelligence ${n.score}; the best model you use, ${n.best.model}, scores ${n.best.score}. A ${n.tier} model needs ${Math.round(n.needs * 100)}% of that.`,
        `That one benchmark places it; the standing rule places a model on two, and Terminal-Bench has no score for it. Nothing looks at its tier again after a yes: ${n.tier} stands until you change it.`,
        `Yes adds ${list(keys)} as ${n.tier}${shut.length ? `, allows ${shut.length === keys.length ? "them" : list(shut)},` : ""}${joined.length ? ` and puts them in the pools of ${list(joined)}` : ""}.`,
        "It is shown as not probed until its first probe passes."] });
  }

  if (!fresh) {
    const under = SHAPES.filter((s) => sim.rows[s].under > 0 && !sim.rows[s].unstaffed && sim.rows[s].pool);
    const es = under.flatMap((s): Edit[] => {
      const r = sim.rows[s], floor = r.floor!;
      // The question is about tier. A model at the floor that only failed its probe keeps its place;
      // when none of those left is working, the working models at the floor join them.
      const at = (k: string) => { const seat = M.seat(k); return !!seat && !seat.denied.worker && TIER_RANK[seat.tier] >= TIER_RANK[floor]; };
      const works = (k: string) => !!M.seat(k)?.live.worker;
      const keep = r.pool!.filter(at);
      const ch = keep.some(works) ? keep : [...keep, ...pools[s].filter((k) => at(k) && !keep.includes(k))];
      // the pool keeps its mode: the question is which models, not in what order they are tried
      return ch.some(works) ? [{ layer: holder(["routing", "map", s]), path: ["routing", "map", s], value: { pool: { mode: cfg.routing.map[s]?.pool?.mode ?? "any", channels: ch } }, label: `${s}: ${ch.map((k) => M.name(k)).join(", ")} only` }] : [];
    });
    if (es.length) {
      const floor = sim.rows[under[0]].floor!;
      out.push({ id: "floor", title: `${plural(under.length, "shape runs", "shapes run")} below ${floor}, though the mode is ${M.mode.mode}.`, ask: `Use only ${floor} models for ${under.length === 1 ? "it" : "them"}?`, edits: es,
        detail: [`${under.map((s) => `${s} ${sim.rows[s].under > 0 && sim.rows[s].under < 1 ? "<1" : Math.round(sim.rows[s].under)}%`).join(", ")} of their tasks go to a lower tier.`, `${M.mode.mode} sets the floor of these shapes to ${floor}.`,
          "Each has a pool, and a pool is not filtered by the floor, so lower-tier models in it take work.", "Yes keeps only the models at the floor in those pools.",
          "No leaves them as they are; the team keeps showing the gap."] });
    }
  }

  out.push(...restorable(M));

  if (!fresh) {
    const unprobed = M.seats.filter((s) => s.verdict.state === "never" && !s.denied.worker && SHAPES.some((sh) => cfg.routing.map[sh]?.pool?.channels.includes(s.key)));
    if (unprobed.length) out.push({ id: `unprobed:${unprobed.map((s) => s.key).join()}`, title: `${plural(unprobed.length, "model")} in the team ${unprobed.length === 1 ? "was" : "were"} never probed: ${unprobed.map((s) => s.name).join(", ")}.`,
      ask: "Press r to probe.", detail: [`${list(unprobed.map((s) => s.key))} ${unprobed.length === 1 ? "is" : "are"} named in a pool and allowed, but no probe has asked ${unprobed.length === 1 ? "it" : "them"} yet.`, "A model takes no work before it has answered a probe."] });

    const idle = denyRules(M).filter((r) => r.idle);
    const byPath = new Map<string, Rule[]>();
    for (const r of idle) byPath.set(r.path.join("."), [...(byPath.get(r.path.join(".")) ?? []), r]);
    const es: Edit[] = [...byPath.values()].map((rs) => ({ layer: holder(rs[0].path), path: rs[0].path, value: (valueAt(cfg, rs[0].path) as string[]).filter((e) => !rs.some((r) => r.entry === e)),
      label: `remove ${plural(rs.length, "deny rule")} that ${rs.length === 1 ? "keeps" : "keep"} nothing out` }));
    let dead = 0;
    for (const s of SHAPES) {
      const slot = cfg.routing.map[s];
      if (!slot?.pool) continue;
      // Dead means the config itself keeps the entry out: it names a model no CLI lists, or one denied
      // for workers. A model that failed its probe (signed out, out of quota, timed out) or was never
      // probed is not dead: it comes back, and a pool's other entries are there for exactly that day.
      const keep = slot.pool.channels.filter((c) => { const seat = M.seat(c); return !!seat && !seat.denied.worker; });
      if (!keep.some((c) => M.seat(c)?.live.worker) || keep.length === slot.pool.channels.length) continue;
      dead += slot.pool.channels.length - keep.length;
      es.push({ layer: holder(["routing", "map", s]), path: ["routing", "map", s], value: { pool: { mode: slot.pool.mode, channels: keep } }, label: `${s}: drop ${plural(slot.pool.channels.length - keep.length, "pool entry", "pool entries")} the config keeps out` });
    }
    if (es.length) out.push({ id: "tidy", title: `${[idle.length ? plural(idle.length, "deny rule") : "", dead ? plural(dead, "pool entry", "pool entries") : ""].filter(Boolean).join(" and ")} ${idle.length + dead === 1 ? "does" : "do"} nothing.`,
      ask: `Remove ${idle.length + dead === 1 ? "it" : "them"}? No task changes worker.`, edits: es,
      detail: [...(dead ? [`${plural(dead, "pool entry names", "pool entries name")} a model that the rules keep from all work, or that no CLI lists. A model that only failed its probe keeps its place.`] : []), ...idle.map((r) => `deny ${r.entry}: ${r.why}`)] });
  }
  // Old results come first: every line above and every item below rests on them. Without this the
  // screen could say "Nothing. Every shape … has a working model." on what was true weeks ago.
  const age = evidenceAgeDays(M);
  if (age !== undefined && age > STALE_DAYS) {
    const old = age < 7 ? `${Math.floor(age)} days` : plural(Math.floor(age / 7), "week");
    out.unshift({ id: "stale", title: `The team rests on probe results over ${old} old.`, ask: "Press r to probe again: what works may have changed.",
      detail: ["A probe asks each configured model one short question and records who answered.", "Sign-ins expire, quotas run out and models are retired, so an old result says little about today.",
        "Everything this screen shows is as of that probe."] });
  }
  return out.filter((n) => !ctx.dismissed?.has(needSignature(n)));
}
