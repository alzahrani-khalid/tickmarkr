// NEEDS YOU: the closed list of things the fleet screen asks a yes or a no about. Each item is one
// sentence and one question; a yes is a list of config edits. Built from the config as it is, so
// the list does not shift while the user answers.
import { parse } from "yaml";
import { TIER_RANK, type Tier } from "../config/config.js";
import { SHAPES, type Shape } from "../graph/schema.js";
import { type Disallowed, disallowedBy, observedSeat } from "../route/preference.js";
import { channelKey } from "../adapters/types.js";
import { CLI_CATALOG } from "../adapters/catalog.js";
import { evidenceAgeDays, STALE_DAYS, buildFleetModel, type FleetModel, type Sample, type Seat } from "./model.js";
import type { Edit, Layer } from "./edits.js";
import { lineOf } from "./lines.js";

export interface NewModel {
  id: string; name: string; provider: string;
  /** one entry per CLI path that lists it; `score` is its benchmark score at that path's effort */
  paths: Array<{ adapter: string; model: string; score?: number }>;
  score: number; best: { score: number; model: string };
  /** the tier its one dated benchmark gives, and the share of the best score that tier needs */
  tier: Tier; needs: number; firstSeen: string;
}
export interface RunDeath { runId: string; seat: string; shapes: Shape[]; tasks: string[] }
/**
 * What a no is remembered by (rows 500, 501; D-2187 add.363, contract K7): the item's id and its CONTENT,
 * the sorted list of what a yes would change (each edit's layer, path and value, and each name it removes
 * from which lines) or, with no yes, its title and ask. A count in the words is not the content: other
 * names under the same count are asked, though the line a yes leaves may read the same.
 */
export const needSignature = (n: Pick<Need, "id" | "title" | "ask" | "edits" | "removes">): string => `${n.id}\u0000${n.edits?.length
  ? [...n.edits.map((e) => JSON.stringify([e.layer, e.path, e.value ?? null])), ...(n.removes ?? []).map((r) => JSON.stringify(["removes", r.what, r.from]))].sort().join("\u0000")
  : `${n.title}\u0000${n.ask}`}`;
/** `dismissed` holds the signatures the user answered no to. */
export interface NeedsContext { newModels?: readonly NewModel[]; lastRun?: readonly RunDeath[]; dismissed?: ReadonlySet<string> }
export interface Need {
  id: string; title: string; ask: string; detail: string[];
  /** absent: nothing a yes could write; the user acts and probes again */
  edits?: Edit[];
  /** seats a yes adds that have no probe yet: previewed as if their first probe passes */
  assume?: string[];
  /** the tidy item (contract K5): each model a yes removes, the lines it leaves, and why it cannot work */
  removes?: Array<{ what: string; from: Shape[]; why: string }>;
  /** the complexity item (contract K6): for each line saved as any, who gets its tasks and who gets none, with the reason */
  given?: Array<{ line: Shape; gets: Array<{ key: string; n: number }>; none: Array<{ key: string; reason: string | null }> }>;
}

const valueAt = (obj: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((cur, seg) => (cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined), obj);
const list = (xs: readonly string[]): string => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/**
 * A model a rule keeps from a seat, in one form for the judge and the consult (contract K1): no yes. A rule
 * of KEPT OUT is named and removed only from its own line, by the user; a model not allowed yet is allowed.
 */
const keptBy = (d: Disallowed): string => (d.by === "allow" ? "is not allowed yet" : `is kept out by ${d.entry}`);
const keptAsk = (d: Disallowed, key: string, seat: string): string => (d.by === "allow"
  ? `Allow ${key} (routing.allow in the config), or pick another model for ${seat}, then press r.`
  : `Remove ${d.entry} from its own line of KEPT OUT, or pick another model for ${seat}, then press r.`);
const NO_LIFT = "No yes here: an item never removes a rule that keeps a model out.";
// K8 / 5.1 (rows 500, 501; D-2187 add.363, add.384): the same screen words in every consult form.
const CONSULT_UNSET = "The consult's model is picked from consult.prefer, and no config sets it.";
/**
 * The rule that keeps the model a key names from a seat, read from the key itself: a model the config
 * has no seat for (its tier set to null, or its CLI's tiers removed) is still under the routing rules,
 * and the rule is named the same (K1, row 500; D-2187 add.363).
 */
const ruleOn = (M: FleetModel, key: string, role: "judge" | "consult"): Disallowed | null => {
  const seat = M.seat(key);
  if (seat) return seat.denied[role] ?? null;
  const i = key.indexOf(":");
  return i < 1 ? null : disallowedBy(observedSeat(M.health, key.slice(0, i), key.slice(i + 1)), M.cfg.routing, role);
};
/** What else is wrong with a kept-out model: it does not answer, or the config has no seat for it. */
const alsoWrong = (seat: Seat | undefined): string => (!seat ? " It is not in the config either: give it a level under tiers."
  : seat.verdict.state === "pass" ? "" : ` It does not answer either: ${seat.verdict.text}.`);

const FLEET_KEYS = ["routing", "tiers", "judge", "review", "consult"] as const;
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
    if (ch.length) out.push({ layer, path: ["routing", "map", shape], value: { pool: { mode: "complexity", channels: ch } }, label: `${shape}: ${ch.map((k) => M.name(k)).join(", ")}` });
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
  const many = es.length > 1, rules = many ? `the KEPT OUT rules ${list(es.length > 3 ? [...es.slice(0, 3), `${es.length - 3} more`] : es)}` : `the KEPT OUT rule ${es[0]}`;
  const change = many ? "remove them from their own lines of KEPT OUT" : "remove it from its own line of KEPT OUT";
  // a model whose CLI is missing AND that a rule keeps out: installing the CLI alone brings nothing back
  const d = g.map((s) => s.denied[role]).find(Boolean);
  const also = !d ? "" : d.by === "deny" ? ` ${cap(rules)} ${many ? "keep" : "keeps"} ${them} out too: ${change}.`
    : ` ${n === 1 ? "It is" : "They are"} not among the models your settings allow, too: add ${them} to routing.allow in the file that holds it.`;
  const [kind, rest] = [key.slice(0, 1), key.slice(2)];
  if (kind === "1") return rest === "gateway" ? `${cap(what)}: ${n === 1 ? "its" : "their"} CLI is not installed. Install a second vendor's CLI, then press r.${also}`
    : `${cap(what)}: ${n === 1 ? "its" : "their"} CLI, ${rest}, is not installed. Install ${rest}, then press r.${also}`;
  if (kind === "2") return `${cap(what)} does not answer: ${g[0].name}, ${g[0].verdict.text}. ${howToNamed(g[0])}`;
  if (kind === "3") return `${cap(what)}: ${rules} ${many ? "keep" : "keeps"} ${them} out: ${change}, then press r.`;
  // (the vendor works, and its models sit below these tasks' review floor: the vendor is there, its tier is not)
  if (kind === "5") return `${cap(what)} answer${n === 1 ? "s" : ""} and ${n === 1 ? "is" : "are"} below these tasks' review bar, ${floor} (the worker's level, or review.floor: ${M.cfg.review.floor}): give the review a model of another vendor at ${floor} or above (a model's level is set under tiers in the config), then press r.`;
  if (kind === "4") return `${cap(what)}: ${n === 1 ? "it is" : "they are"} not among the models your settings allow. Add ${them} to routing.allow in the file that holds it, then press r.`;
  return role === "review" ? `${cap(what)} answer${n === 1 ? "s" : ""} and ${n === 1 ? "is" : "are"} not offered to review: below the review's bar (review.floor: ${M.cfg.review.floor}) or not served by ${n === 1 ? "its" : "their"} CLI.`
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
  // An id its CLI no longer serves does not come back by anything done in that CLI. Where the CLI's own
  // list of models still offers the id, the probe's word is worth asking again; where it does not, there
  // is nothing to get back, and no item promises it (the entries to remove are tidy's).
  const listed = (s: Seat): boolean => (M.health?.[s.adapter]?.models ?? []).includes(s.model);
  const dead = M.seats.filter((s) => s.status === "dead" && s.verdict.state === "fail" && named.has(s.key) && !(s.verdict.kind === "retired" && !listed(s)));
  const groups = new Map<string, Seat[]>();
  // A CLI that is signed out is one thing to do, however many of its models the team names: one item for the CLI.
  const signedOut = (s: Seat): boolean => M.health?.[s.adapter]?.authed === false;
  const groupOf = (s: Seat): string => (signedOut(s) ? `cli|${s.adapter}` : `${s.identity}|${s.verdict.fix}`);
  for (const s of dead) groups.set(groupOf(s), [...(groups.get(groupOf(s)) ?? []), s]);
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
    if (base.under > sim.under) gains.push([`${(base.under - sim.under).toLocaleString("en-US")} fewer sample tasks below their bar`, (100 * (base.under - sim.under)) / base.total]);
    if (!gains.length) continue;
    const s = seats[0], v = s.verdict, names = [...new Set(seats.map((x) => x.name))];
    out.push({ id: signedOut(s) ? `fix:${s.adapter}:signed-out` : `fix:${s.identity}:${v.kind}`, score: gains.reduce((t, g) => t + g[1], 0),
      title: signedOut(s) ? `${s.adapter} is signed out: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} ${names.length === 1 ? "does" : "do"} not work.`
        : `${s.name} does not work: ${v.text} (${[...new Set(seats.map((x) => x.adapter))].join(", ")}).`,
      ask: `${v.kind === "timeout" ? "Press r to probe it again" : v.kind === "retired" ? "Its CLI still lists that id: press r to probe it again" : `${cap(v.fix)}, then press r`}. You get: ${gains[0][0]}.`,
      detail: [...(v.raw ? [`The probe said: ${v.raw.slice(0, 240)}`] : []), ...gains.map((g) => `You get: ${g[0]}.`)] });
  }
  return out.sort((a, b) => b.score - a.score).map(({ score: _score, ...need }) => need);
}

/** How many single-letter changes turn one word into another: a misspelled shape is one or two away from the shape it was meant for. */
function distance(a: string, b: string): number {
  let row = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
const nearestShape = (key: string): string | undefined => SHAPES.map((s) => [s, distance(key, s)] as const).filter(([, d]) => d <= 2).sort((x, y) => x[1] - y[1])[0]?.[0];

/** What needs a yes or a no, most urgent first. */
export function needs(M: FleetModel, ctx: NeedsContext = {}): Need[] {
  const out: Need[] = [];
  const { cfg } = M;
  if (!M.hasProbe) {
    // (a no to it is remembered like any other: K7, rows 500, 501; D-2187 add.363)
    return [{ id: "probe", title: "No probe yet: tickmarkr does not know which models answer.", ask: "Press r to probe them.",
      detail: ["A probe asks each configured model one short question and records who answered.", "Nothing is proposed for a model that has not answered."] }]
      .filter((n) => !ctx.dismissed?.has(needSignature(n)));
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
      detail: [`A reviewer is a working model from another vendor than the task's worker, at the review's bar (review.floor: ${M.cfg.review.floor}).`,
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
      ask: noConsult, detail: [CONSULT_UNSET, "No model that answered the probe is allowed to consult."] });
  } else {
    if (sim.noSeat.length) {
      // A pool that is there keeps its entries and its mode: its models may only be out for a day. A PIN
      // is kept the same way: the pinned model stays on the line, written first, so the others take the
      // work while it does not answer and it is back on the line the day it does.
      // (only a pinned model that can come back: one the config itself keeps out, or that no CLI lists,
      // would sit in the pool as an entry that does nothing, and be asked about again by the tidy item)
      const pinOf = (s: string) => { const slot = cfg.routing.map[s], key = slot?.pin && !slot.pool ? `${slot.pin.via}:${slot.pin.model}` : undefined; const seat = key ? M.seat(key) : undefined; return seat && !seat.denied.worker ? key : undefined; };
      const withOld = (s: string) => {
        const old = cfg.routing.map[s]?.pool, pin = pinOf(s), kept = old?.channels ?? (pin ? [pin] : []);
        // a line a yes creates is by complexity, a pin's included (row 501; D-2187 add.363); a pool that is there keeps its mode
        return { mode: old?.mode ?? ("complexity" as const), channels: [...kept, ...pools[s].filter((k) => !kept.includes(k))] };
      };
      const fill = sim.noSeat.filter((s) => pools[s].length);
      const es = fill.map((s): Edit => ({ layer: holder(["routing", "map", s]), path: ["routing", "map", s], value: { pool: withOld(s) },
        label: `${s}: ${pinOf(s) ? `keep ${M.name(pinOf(s)!)} on the line; add ` : cfg.routing.map[s]?.pool ? "add " : ""}${pools[s].filter((k) => k !== pinOf(s)).map((k) => M.name(k)).join(", ")}` }));
      // Where no working model reaches a shape's floor, the best there is goes below it: the question
      // and the details say so, as the review's count of tasks below their floor does.
      const under = fill.filter((s) => { const floor = cfg.routing.floors[s]; return !!floor && pools[s].every((k) => TIER_RANK[M.seat(k)?.tier ?? "cheap"] < TIER_RANK[floor]); });
      const them = sim.noSeat.length === 1 ? "it" : "them";
      if (es.length) out.push({ id: "noseat", title: `${list(shapesOf(sim.noSeat))}: no working model.`,
        ask: `Use ${pools[fill[0]].filter((k) => k !== pinOf(fill[0])).slice(0, 3).map((k) => M.name(k)).join(", ")} for ${them}?${under.length ? ` ${under.length === fill.length ? "That is" : `For ${list(under)} that is`} below the bar: no working model reaches it.` : ""}`, edits: es,
        detail: ["No working model can take this work, so its tasks cannot start.",
          under.length === fill.length ? `No working model reaches ${under.length === 1 ? "its bar" : "their bars"}: yes gives ${them} the best that work, below the bar, and the review counts the tasks that then run below it.`
            : under.length ? `Yes gives ${them} the working models at the bar; for ${list(under)} none reaches it, so those get the best that work, below the bar.` : `Yes gives ${them} the working models at ${sim.noSeat.length === 1 ? "its bar" : "their bars"}.`,
          ...(fill.some((s) => pinOf(s)) ? [`${list(fill.filter((s) => pinOf(s)))} ${fill.filter((s) => pinOf(s)).length === 1 ? "is" : "are"} pinned to one model: it stays on the line, written first, given out by complexity, and takes work again when it answers.`] : [])] });
      else out.push(nobody());
    }
    // The judge: a pinned judge that does not answer is still the one a run would send the work to.
    const pinned = channelKey(cfg.judge);
    if (!M.seat(pinned)?.live.judge) {
      const next = [...M.pools.judge].filter((c) => c.vendor !== "unknown").sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0];
      // two different faults: the model answers but a rule keeps it from judging, or it does not answer
      // (a rule is named whether or not the model answers: K1, row 500; D-2187 add.363)
      const seat = M.seat(pinned), barred = ruleOn(M, pinned, "judge"), silent = barred ? alsoWrong(seat) : "";
      const title = barred ? `The judge (acceptance) ${keptBy(barred)}: ${pinned}.`
        : `The judge (acceptance) does not answer: ${pinned}, ${seat?.verdict.text ?? "not configured"}.`;
      out.push(next
        ? { id: "judge", title, ask: `Use ${M.name(channelKey(next))} as the judge?`, edits: [judgeEdit(M, channelKey(next), holder(["judge"]))],
          detail: [`The config's judge is ${pinned}. A run sends every acceptance check to it first.`, `Yes makes ${channelKey(next)} the judge: the strongest working model that may judge.`,
            "Where the judge shares a worker's vendor, a run still picks an independent one for that task."] }
        : { id: "judge", title, ask: `No other working model may judge. ${!barred ? howTo(M, seat) : `${keptAsk(barred, pinned, "the judge")}${silent}`}`, detail: [`The config's judge is ${pinned}.`, ...(barred ? [NO_LIFT] : [])] });
    } else {
      const own = ownVendor();
      if (own) out.push(own);
    }
    const review = unreviewed();
    if (review) out.push(review);
    if (!M.consult) {
      // the seat picker reads consult.prefer alone: a legacy consult model is never named as what it names;
      // a rule that keeps one of its models out is named whether or not that model answers (K1, row 500; D-2187 add.363)
      const chain = [...new Set(cfg.consult.prefer ?? [])];
      const blockedKey = chain.find((k) => ruleOn(M, k, "consult"));
      const blocked = blockedKey ? { key: blockedKey, rule: ruleOn(M, blockedKey, "consult")!, seat: M.seat(blockedKey) } : undefined;
      if (!cfg.consult.prefer?.length) {
        // The seat picker reads consult.prefer and nothing else: with none set, nobody can be picked,
        // whatever works and whatever a rule allows. Narrowing a deny rule would change nothing.
        const able = strongestFor(M, "consult").slice(0, 2).map(channelKey);
        out.push(able.length
          ? { id: "consult", title: "The consult has no model: consult.prefer is not set.", ask: `Use ${able.map((k) => M.name(k)).join(", ")} for it?`,
            edits: [{ layer: holder(["consult", "prefer"]), path: ["consult", "prefer"], value: able, label: `consult: ${able.map((k) => M.name(k)).join(", ")}` }],
            detail: [CONSULT_UNSET, `Yes sets it to ${list(able)}: the strongest working models that may consult, one per vendor.`,
              "Until then a stalled task goes straight to you, and the overseer skill cannot start: it picks its orchestrator from the consult."] }
          : { id: "consult", title: "The consult has no model: consult.prefer is not set.", ask: noConsult,
            detail: [CONSULT_UNSET, "No model that answered the probe is allowed to consult."] });
      } else if (blocked) {
        // K1 (row 500; D-2187 add.365): no item lifts a rule. What consult.prefer names is kept out, so
        // the item has no yes: it names the rule and says where the user removes it, or to pick another.
        out.push({ id: "consult", title: `The consult has no model: ${blocked.key} ${blocked.rule.by === "allow" ? "is not allowed yet" : "is kept out"}.`, ask: `${keptAsk(blocked.rule, blocked.key, "the consult")}${alsoWrong(blocked.seat)}`,
          detail: [`consult.prefer names ${blocked.key}.${blocked.seat?.verdict.state === "pass" ? " It answered the last probe." : ""}`, NO_LIFT,
            "Until then a stalled task goes straight to you, and the overseer skill cannot start: it picks its orchestrator from the consult."] });
      } else if (chain.length) {
        const s = M.seat(chain[0]);
        const answers = s?.verdict.state === "pass";
        out.push({ id: "consult", title: answers ? `The consult has no model: ${chain[0]} answers but cannot be the consult's model.` : `The consult has no model: ${chain[0]}, ${s ? s.verdict.text : "not configured"}.`,
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
      // The question is whether a task that needs the floor has somewhere to go. With another working
      // model at the floor already in the pool it has: the item does not keep asking for one more each
      // time a model joins the machine or the floor moves.
      const covered = (slot?.pool?.channels ?? []).some((k) => k !== d.seat && !!M.seat(k)?.live.worker && (!floor || TIER_RANK[M.seat(k)?.tier ?? "cheap"] >= TIER_RANK[floor]));
      return slot?.pool && add.length && !covered ? [{ layer: holder(["routing", "map", sh]), path: ["routing", "map", sh], value: { pool: { mode: slot.pool.mode, channels: [...slot.pool.channels, ...add] } }, label: `${sh}: add ${add.map((k) => M.name(k)).join(", ")} as fallbacks` }] : [];
    });
    if (es.length) out.push({ id: `run:${d.runId}:${d.seat}`, title: `Last run: ${M.name(d.seat)} hit its limit and no other model could take over.`,
      ask: `Add ${es[0].label.replace(/^.*: add /, "").replace(" as fallbacks", "")} as fallbacks for ${list(d.shapes)}?`, edits: es,
      detail: [`Run ${d.runId}: ${d.seat} ran out of quota and nothing else could take the work${d.tasks.length ? ` (${d.tasks.join(", ")})` : ""}.`,
        "Yes adds the other working models at that shape's bar to its line, so a task that needs the bar has somewhere to go.",
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
      edits.push({ layer: holder(["routing", "map", sh]), path: ["routing", "map", sh], value: { pool: { mode: slot.pool.mode, channels: [...slot.pool.channels, ...keys.filter((k) => !slot.pool!.channels.includes(k))] } }, label: `${sh}: add ${n.name} to the line` });
    }
    out.push({ id: `new:${n.id}`, title: `New model: ${n.name} (${n.provider}), on ${list(paths.map((p) => p.adapter))}.`, ask: `Add it as ${n.tier}? That rests on one benchmark of two: Artificial Analysis ${n.score} (your best: ${n.best.score}); it has no Terminal-Bench score.`, edits, assume: keys,
      detail: [`A probe first listed it on ${n.firstSeen}.`,
        `Artificial Analysis Intelligence ${n.score}; the best model you use, ${n.best.model}, scores ${n.best.score}. A ${n.tier} model needs ${Math.round(n.needs * 100)}% of that.`,
        `That one benchmark places it; the standing rule places a model on two, and Terminal-Bench has no score for it. Nothing looks at its level again after a yes: ${n.tier} stands until you change it.`,
        `Yes adds ${list(keys)} as ${n.tier}${shut.length ? `, allows ${shut.length === keys.length ? "them" : list(shut)},` : ""}${joined.length ? ` and puts them on the lines of ${list(joined)}` : ""}.`,
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
      // the line keeps its mode: the question is which models, not how they are given out
      return ch.some(works) ? [{ layer: holder(["routing", "map", s]), path: ["routing", "map", s], value: { pool: { mode: cfg.routing.map[s]?.pool?.mode ?? "complexity", channels: ch } }, label: `${s}: ${ch.map((k) => M.name(k)).join(", ")} only` }] : [];
    });
    if (es.length) {
      const floor = sim.rows[under[0]].floor!;
      out.push({ id: "floor", title: `${plural(under.length, "shape runs", "shapes run")} below ${floor}, though the mode is ${M.mode.mode}.`, ask: `Use only ${floor} models for ${under.length === 1 ? "it" : "them"}?`, edits: es,
        detail: [`${under.map((s) => `${s} ${sim.rows[s].under > 0 && sim.rows[s].under < 1 ? "<1" : Math.round(sim.rows[s].under)}%`).join(", ")} of their tasks go to a lower level.`, `${M.mode.mode} sets the bar of these shapes to ${floor}.`,
          "Each has a line of its own, and a line is not filtered by the bar, so lower-level models on it take work.", "Yes keeps only the models at the bar on those lines.",
          "No leaves them as they are; the team keeps showing the gap."] });
    }
  }

  out.push(...restorable(M));

  if (!fresh) {
    const unprobed = M.seats.filter((s) => s.verdict.state === "never" && !s.denied.worker && SHAPES.some((sh) => cfg.routing.map[sh]?.pool?.channels.includes(s.key)));
    if (unprobed.length) out.push({ id: `unprobed:${unprobed.map((s) => s.key).join()}`, title: `${plural(unprobed.length, "model")} in the team ${unprobed.length === 1 ? "was" : "were"} never probed: ${unprobed.map((s) => s.name).join(", ")}.`,
      ask: "Press r to probe.", detail: [`${list(unprobed.map((s) => s.key))} ${unprobed.length === 1 ? "is" : "are"} named on a line and allowed, but no probe has asked ${unprobed.length === 1 ? "it" : "them"} yet.`, "A model takes no work before it has answered a probe."] });

    // A key under routing.map or routing.floors that is no shape is read and never used: a misspelled
    // shape loads without a word, and the shape it was meant for keeps what it had. Nothing else in the
    // product says so. No yes: which shape was meant is the user's to say, so the nearest is a question.
    const notShape = (k: string): boolean => !(SHAPES as readonly string[]).includes(k);
    const strays = [...Object.keys(cfg.routing.map).filter(notShape).map((k) => `routing.map.${k}`), ...Object.keys(cfg.routing.floors).filter(notShape).map((k) => `routing.floors.${k}`)];
    if (strays.length) {
      const meant = [...new Set(strays.map((k) => nearestShape(k.slice(k.lastIndexOf(".") + 1))).filter((s): s is string => !!s))];
      out.push({ id: "notshape", title: `${list(strays)} ${strays.length === 1 ? "names no shape: it does nothing" : "name no shape: they do nothing"}.`,
        ask: `${meant.length ? `Did you mean ${list(meant)}?` : `The shapes are ${SHAPES.join(", ")}.`} Correct ${strays.length === 1 ? "it" : "them"} in the config, then open fleet again.`,
        detail: [`A shape is one of ${SHAPES.join(", ")}.`, "An entry under any other name loads and is never used: the shape it was meant for keeps what it had.", "There is no yes here: which shape was meant is yours to say."] });
    }

    // K4 (row 500; D-2187 add.363): the tidy item offers only NAMES ON LINES, never a rule of KEPT OUT, not
    // even one that keeps nothing out today (it is a guard for the day its model becomes routable). A name
    // the config's rules keep from all work, that no CLI lists, or an id its CLI no longer serves and does
    // not list, in a line that keeps a working model. A model out for a passing outage keeps its place.
    // (an id counts as retired only when the CLI's own list does not offer it either; where a CLI lists
    // nothing, the verdict rests on the probe's answer alone, and the reason says so: queue row 454)
    const retiredBy = (c: string): "list" | "probe" | undefined => {
      const seat = M.seat(c);
      if (!seat || seat.verdict.kind !== "retired") return undefined;
      const listed = M.health?.[seat.adapter]?.models ?? [];
      return listed.includes(seat.model) ? undefined : listed.length ? "list" : "probe";
    };
    const whyNot = (c: string): string | undefined => {
      const seat = M.seat(c);
      if (!seat) return "no CLI in your settings lists it";
      if (seat.denied.worker) return seat.denied.worker.by === "allow" ? "it is not allowed yet" : `kept out by ${seat.denied.worker.entry}`;
      const by = retiredBy(c);
      return by === "list" ? "its CLI no longer serves this id, and its own list of models does not offer it"
        : by === "probe" ? "its CLI answered that it no longer serves this id; that CLI lists no models, so this rests on the probe's answer alone" : undefined;
    };
    const removes = new Map<string, { what: string; from: Shape[]; why: string }>();
    const es: Edit[] = [];
    for (const s of SHAPES) {
      const slot = cfg.routing.map[s];
      if (!slot?.pool) continue;
      const keep = slot.pool.channels.filter((c) => !whyNot(c));
      if (!keep.some((c) => M.seat(c)?.live.worker) || keep.length === slot.pool.channels.length) continue;
      const gone = slot.pool.channels.filter((c) => !keep.includes(c));
      for (const c of gone) removes.set(c, { what: c, from: [...(removes.get(c)?.from ?? []), s], why: whyNot(c)! });
      es.push({ layer: holder(["routing", "map", s]), path: ["routing", "map", s], value: { pool: { mode: slot.pool.mode, channels: keep } }, label: `${s}: remove ${gone.join(", ")}` });
    }
    const rm = [...removes.values()];
    if (es.length) out.push({ id: "tidy", title: `${plural(rm.length, "model")} named on your lines cannot take work now.`,
      ask: `Remove ${rm.length === 1 ? "it" : "them"} from ${es.length === 1 ? "that line" : "those lines"}? No task changes worker.`, edits: es, removes: rm,
      detail: [...rm.map((r) => `${r.what}, from ${list(r.from)}: ${r.why}.`),
        "A model that is signed out, out of credit or slow keeps its place: it comes back.", "No rule of KEPT OUT changes: a yes removes names from lines only."] });
    // K6 (rows 500, 501; D-2187 add.363): the lines saved as any, named, with no mechanism quoted. A yes
    // sets exactly their mode to complexity and changes no member; who gets their tasks is the data.
    // Last of the items that edit a line, after the items about lines with no model: answers combine in
    // the list's order, so the members other yeses change are kept and this one's mode is the one saved.
    const old = SHAPES.filter((s) => cfg.routing.map[s]?.pool?.mode === "any");
    if (old.length) {
      const given = old.map((s) => { const o = lineOf(M, s).order; return { line: s, gets: o?.gets ?? [], none: o?.none ?? [] }; });
      const they = old.length === 1 ? "it" : "them", one = shapesOf(old).length === 1;
      out.push({ id: "complexity", title: `${list(shapesOf(old))} ${one ? "is" : "are"} given out the way ${one ? "it was" : "they were"} saved before 2.27.`,
        ask: `Give ${old.length === SHAPES.length ? "every shape" : they} out by complexity?`, given,
        edits: old.map((s): Edit => ({ layer: holder(["routing", "map", s]), path: ["routing", "map", s], value: { pool: { mode: "complexity", channels: [...cfg.routing.map[s]!.pool!.channels] } }, label: `${s}: by complexity` })),
        detail: [...given.map((g) => `${g.line}: ${g.gets.length ? `${g.gets.map((x) => `${M.name(x.key)} gets ${x.n.toLocaleString("en-US")}`).join(", ")} of the sample tasks` : "nobody gets its tasks"}${g.none.map((x) => `; ${M.name(x.key)} gets none${x.reason ? `: ${x.reason}` : ""}`).join("")}.`),
          `Yes gives ${they} out by complexity and keeps every model on ${old.length === 1 ? "it" : "them"}.`] });
    }
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
