// The fleet's model of a line (queue rows 499, 501, 502; D-2187 add.363): how a shape's tasks are given
// out, its groups, each model's share in words, who gets none and why. The one source the screens,
// --plain and --json read. Pure: it reads the fleet model and its routed sample, nothing else.
import { invalidConfiguredModels } from "../adapters/registry.js";
import { type BillingChannel, channelKey, modelAuthed } from "../adapters/types.js";
import { isAlias, isMap, isScalar, isSeq, type Node, type Pair, parseDocument, visit, type YAMLMap } from "yaml";
import { DENY_SCOPES, denyEntriesAt, TIER_RANK } from "../config/config.js";
import type { Shape } from "../graph/schema.js";
import { complexityGroups, complexityRanges, modelUnits } from "../route/complexity.js";
import { disallowedBy, observedSeat, routingModelProvider } from "../route/preference.js";
import { marginalCostRank } from "../route/router.js";
import { namesOf } from "./hand.js";
import { holderIn, parsedLayers } from "./needs.js";
import { type FleetModel, sampleComplexity, splitKey } from "./model.js";

export type GivenOut = "complexity" | "order" | "any" | "open";
export interface LineModelRow {
  key: string; name: string; cli: string; model: string;
  score: number | null; priceIn: number | null; priceOut: number | null;
  share: { n: number; of: number }; shareWords: string; standIns: string[];
}
export interface LineGroup { range: [number, number] | null; models: LineModelRow[] }
export interface LineOrder {
  /** order: the first row that can work, and the rest */
  works?: string | null; backups?: string[];
  /** any: who gets tasks of the sample, and who gets none with its one reason */
  gets?: Array<{ key: string; n: number }>; none?: Array<{ key: string; reason: string | null }>;
}
export interface Line {
  shape: Shape; givenOut: GivenOut;
  groups?: LineGroup[]; by?: "score" | "level"; noScore?: string[];
  order?: LineOrder; why: string[]; note: string[];
}

const FRACTIONS: ReadonlyArray<readonly [number, string]> = [
  [1 / 2, "about half"], [1 / 3, "about a third"], [2 / 3, "about two thirds"],
  [1 / 4, "about a quarter"], [3 / 4, "about three quarters"], [1 / 5, "about a fifth"],
];
/** The contract's closed share table (rule 12). A share is words, never a percentage. */
export function shareWords(n: number, of: number): string {
  if (n === 0 || of === 0) return "none";
  if (n === of) return "all of them";
  const s = n / of;
  let best: readonly [number, string] | undefined;
  // (1e-9: a share of 0.55 is within 0.05 of 1/2, which floating point puts at 0.050000000000000044)
  for (const f of FRACTIONS) if (Math.abs(s - f[0]) <= 0.05 + 1e-9 && (!best || Math.abs(s - f[0]) < Math.abs(s - best[0]) - 1e-9)) best = f; // a tie keeps the earlier: 1/3 before 1/4
  return best ? best[1] : `about ${Math.min(9, Math.max(1, Math.round(s * 10)))} in 10`;
}

// D-2187 add.379: compare the recorded decimal list prices exactly. Binary multiplication makes
// 3 * 0.1 exceed 0.3; a tolerance would also admit prices genuinely below the three-times boundary.
function atLeastThreeTimes(price: number, low: number): boolean {
  const decimal = (n: number): [bigint, number] => {
    const [digits, exponent = "0"] = String(n).split("e");
    const [whole, fraction = ""] = digits.split(".");
    return [BigInt(whole + fraction), Number(exponent) - fraction.length];
  };
  const [p, pe] = decimal(price), [l, le] = decimal(low), scale = Math.min(pe, le);
  return p * 10n ** BigInt(pe - scale) >= 3n * l * 10n ** BigInt(le - scale);
}

/** The cost notes of one group (rule 13): only prices above zero are compared; 3 times the lowest or more is named. */
export function costNotes(rows: ReadonlyArray<{ name: string; priceOut: number | null }>): string[] {
  const priced = rows.filter((r): r is { name: string; priceOut: number } => r.priceOut !== null && Number.isFinite(r.priceOut) && r.priceOut > 0);
  if (priced.length < 2) return [];
  const low = priced.reduce((a, b) => (b.priceOut < a.priceOut ? b : a));
  return priced.filter((r) => atLeastThreeTimes(r.priceOut, low.priceOut))
    .map((r) => `${r.name} costs ${Math.round(r.priceOut / low.priceOut)} times ${low.name} for a similar score.`);
}

const facts = (M: FleetModel, c: BillingChannel) => {
  const f = M.health?.[c.adapter]?.modelFacts?.[c.model];
  return f && f.as === (c.identity ?? c.model) ? f : undefined;
};
const num = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fmt = (n: number): string => String(Math.round(n * 10) / 10);

/** The line of one shape, as it routes over the fleet's sample. */
export function lineOf(M: FleetModel, shape: Shape): Line {
  const slot = M.cfg.routing.map[shape];
  const picks = M.sample().rows[shape].picks.map((p) => p[0]);
  if (slot?.pool?.mode === "complexity") return byComplexity(M, shape, slot.pool.channels, picks);
  if (slot?.pool?.mode === "ordered" || (!slot?.pool && slot?.pin)) {
    const rows = slot.pool?.channels ?? [`${slot.pin!.via}:${slot.pin!.model}`];
    const live = new Set(M.pools.worker.map(channelKey));
    const works = rows.find((k) => live.has(k) && !disallowed(M, k)) ?? null;
    return { shape, givenOut: "order", order: { works, backups: rows.filter((k) => k !== works) }, why: [], note: [] };
  }
  if (slot?.pool?.mode === "any") return { shape, givenOut: "any", order: anyOrder(M, slot.pool.channels, picks), why: [], note: [] };
  return { shape, givenOut: "open", why: [], note: [] };
}

// the identity the probe recorded (row 499): a denied or failed seat is not in the worker pool, but its
// recorded identity still decides which rule keeps it out, as route() and the seat rows read it
function disallowed(M: FleetModel, key: string) {
  const [adapter, model] = splitKey(key);
  return M.cfg.routing.allow || M.cfg.routing.deny ? disallowedBy(observedSeat(M.health, adapter, model), M.cfg.routing) : null;
}

function byComplexity(M: FleetModel, shape: Shape, written: readonly string[], picks: readonly string[]): Line {
  const { hardFrom, similarWithin } = M.cfg.routing;
  // the members route() reads: admitted, offered by the probe; the sample carries no bar of its own
  const members = written.filter((k) => !disallowed(M, k)).flatMap((k) => M.pools.worker.find((c) => channelKey(c) === k) ?? []);
  const { groups, byLevel } = complexityGroups(modelUnits(members), similarWithin);
  const ranges = complexityRanges(groups.length, hardFrom);
  const firsts = groups.flat().map((u) => channelKey(u.entries[0]));
  const names = new Map(firsts.map((k, i) => [k, namesOf(M, firsts)[i]]));
  const out: LineGroup[] = groups.map((g, gi) => {
    const range = ranges[gi] ?? null;
    // a share is counted over the tasks of the group's OWN range in the routed sample, never over all of it
    const inRange = picks.map((k, i) => ({ k, c: sampleComplexity(i) })).filter(({ c }) => range !== null && c >= range[0] && c <= range[1]);
    return { range, models: g.map((u) => {
      const c = u.entries[0], f = facts(M, c), keys = new Set(u.entries.map(channelKey));
      const n = inRange.filter(({ k }) => keys.has(k)).length;
      return { key: channelKey(c), name: names.get(channelKey(c))!, cli: c.adapter, model: c.model,
        score: num(u.score), priceIn: num(f?.priceIn), priceOut: num(f?.priceOut),
        share: { n, of: inRange.length }, shareWords: shareWords(n, inRange.length), standIns: u.entries.slice(1).map(channelKey) };
    }) };
  });
  const noScore = byLevel ? out.flatMap((g) => g.models.filter((m) => m.score === null).map((m) => m.key)) : [];
  const why: string[] = [];
  if (byLevel) {
    const who = noScore.map((k) => names.get(k)!);
    why.push(`${who.join(", ")} ${who.length === 1 ? "has" : "have"} no score, so the models are grouped by level: frontier, then mid, then cheap.`);
  } else {
    why.push(`Scores within ${similarWithin} points count as similar, and similar models share the same tasks.`);
    if (out.length >= 2) {
      const first = out[0].models, lowest = first[first.length - 1].score!, next = out[1].models[0].score!;
      why.push(`${first.map((m) => m.name).join(" and ")} ${first.length === 1 ? "scores" : "score"} ${fmt((Math.round(lowest * 10) - Math.round(next * 10)) / 10)} above the next model, so ${first.length === 1 ? "it is" : "they are"} kept for the hardest tasks.`);
    } else if (out.length === 1) why.push(`Every model is within ${similarWithin} points of the strongest, so they share every task.`);
  }
  return { shape, givenOut: "complexity", groups: out, by: byLevel ? "level" : "score", noScore, why, note: out.flatMap((g) => costNotes(g.models)) };
}

/** A line saved as any: who gets the sample's tasks, and for each model that gets none its one reason (rule 9). */
function anyOrder(M: FleetModel, written: readonly string[], picks: readonly string[]): LineOrder {
  const count = new Map<string, number>();
  for (const k of picks) if (k !== "none") count.set(k, (count.get(k) ?? 0) + 1);
  const gets = written.filter((k) => count.get(k)).map((k) => ({ key: k, n: count.get(k)! }));
  const live = (k: string) => M.pools.worker.find((c) => channelKey(c) === k);
  const getters = gets.flatMap((g) => live(g.key) ?? []);
  const name = (k: string) => namesOf(M, [...written])[written.indexOf(k)] ?? M.name(k);
  const reason = (k: string, i: number): string | null => {
    const d = disallowed(M, k);
    if (d) return d.by === "allow" ? "not allowed yet" : `kept out by ${d.entry}`;
    const [adapter, model] = splitKey(k);
    if (!M.cfg.tiers[adapter]?.models[model]) return "no CLI in your settings lists it";
    const c = live(k);
    if (!c) {
      // D-2187 add.379 / rows 499, 501, 502: mirror every discovery gate before ranking. A
      // passed probe is not a failed answer when the CLI's list or its channel factory excludes it.
      const a = M.inputs.adapters.find((a) => a.id === adapter), h = M.health?.[adapter];
      const v = M.seat(k)?.verdict;
      const notOffered = `${adapter} does not offer this model for worker tasks`;
      const probe = !v || v.state === "never" ? "does not answer: not checked yet"
        : v.state === "pass" ? notOffered : `does not answer: ${v.text}`;
      if (!a) return `no ${adapter} adapter is loaded`;
      if (!h?.installed || !h.authed) return probe;
      if (!a.channels(M.cfg).some((c) => channelKey(c) === k)) return notOffered;
      if (invalidConfiguredModels(M.cfg, adapter, h).includes(model)) {
        return h.modelsHidden?.includes(model) && !h.models.includes(model)
          ? `hidden from ${adapter}'s model list` : `not in ${adapter}'s validated model list`;
      }
      if (!modelAuthed(h, model, M.cfg.routing.allowUnverifiedModels)) return probe;
      if (h.servable && !h.servable.includes(model)) return `not in ${adapter}'s served model list`;
      // An unrecognised missing offer still names the observed cause; never infer a failed probe.
      return notOffered;
    }
    const cheaper = getters.find((g) => marginalCostRank(g) < marginalCostRank(c));
    if (cheaper) return `it costs more than ${name(channelKey(cheaper))}`;
    const kin = written.flatMap((w) => live(w) ?? []).filter((o) => channelKey(o) !== k && marginalCostRank(o) === marginalCostRank(c)
      && routingModelProvider(o.model, o.vendor) === routingModelProvider(c.model, c.vendor));
    const lighter = kin.find((o) => TIER_RANK[o.tier] < TIER_RANK[c.tier]);
    if (lighter) return `${name(channelKey(lighter))}, a lighter model of the same vendor, comes first`;
    const before = kin.find((o) => o.tier === c.tier && written.indexOf(channelKey(o)) < i);
    if (before) return `${name(channelKey(before))}, of the same vendor, is written before it`;
    return null; // a defect of the contract's table: the tests over its fixtures fail on it
  };
  return { gets, none: written.flatMap((k, i) => (count.get(k) ? [] : [{ key: k, reason: reason(k, i) }])) };
}

/** One rule in force per entry of every deny list, in the lists' order, with its comment as its reason (or null). */
export function keptOut(M: FleetModel): Array<{ rule: string; list: string; reason: string | null }> {
  const holder = holderIn(parsedLayers(M.inputs));
  return DENY_SCOPES.flatMap((sc) => {
    const rules = denyEntriesAt(M.cfg.routing, sc) ?? [];
    const text = holder(sc.path) === "repo" ? M.inputs.repoText : M.inputs.userText;
    return rules.map((rule, i) => ({ rule, list: sc.dotted, reason: reasonOf(text, sc.path, rule, rules.slice(0, i).filter((r) => r === rule).length) }));
  });
}

/** The comment lines directly above the line holding `offset`, no blank line between: joined, or null. */
function linesAbove(text: string, offset: number | undefined): string | null {
  if (offset === undefined) return null;
  const above = text.slice(0, offset).split("\n").slice(0, -1);
  const got: string[] = [];
  for (let k = above.length - 1; k >= 0 && above[k].trim().startsWith("#"); k--) got.unshift(above[k].trim());
  return got.length ? got.join(" ") : null;
}

/**
 * An entry's reason (rule 15; D-2187 add.382), read only in the ONE layer that holds the list's path:
 * the comment lines directly above the entry's own line, else directly above the list's key line, else
 * nothing. A blank line, a same-line comment, a flow collection, another entry's comment (each duplicate
 * reads its own) or any other layer never gives one; a path not tied to the text by plain keys (an aliased
 * key, a merge key) gives none. A list, entry or map reached through an alias is read where it is written.
 */
function reasonOf(text: string, path: readonly string[], entry: string, occurrence: number): string | null {
  const doc = parseDocument(text || "{}");
  const res = (n: unknown): unknown => (isAlias(n) ? n.resolve(doc) : n);
  let node: unknown = doc.contents;
  const keys: Array<{ map: YAMLMap; pair: Pair }> = [];
  for (const key of path) {
    const map = res(node);
    const pair = isMap(map) ? map.items.find((p) => isScalar(p.key) && p.key.value === key) : undefined;
    if (!pair) return null;
    keys.push({ map: map as YAMLMap, pair: pair as Pair });
    node = pair.value;
  }
  const seq = res(node);
  if (!isSeq(seq)) return null;
  const item = seq.items.filter((i) => { const v = res(i); return isScalar(v) && v.value === entry; })[occurrence] as Node | undefined;
  if (!item) return null;
  const own = seq.flow ? null : linesAbove(text, item.range?.[0]);
  if (own) return own;
  // the list's key line: where it is used, then (an aliased list) the pair where it is written
  const keyLine = (map: YAMLMap | undefined, pair: Pair | undefined) => (map && pair && !map.flow ? linesAbove(text, (pair.key as Node).range?.[0]) : null);
  const last = keys.at(-1);
  if (keyLine(last?.map, last?.pair)) return keyLine(last?.map, last?.pair);
  if (!isAlias(node)) return null;
  let found: string | null = null;
  visit(doc, { Pair: (_, pair, up) => { const map = up.at(-1); if (found === null && pair.value === seq && isMap(map) && isScalar(pair.key)) found = keyLine(map, pair as Pair); } });
  return found;
}
