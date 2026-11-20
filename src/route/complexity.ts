// Queue rows 501 and 502 (D-2187 add.363): a pool line by complexity — the hardest tasks to the strongest
// models, the rest shared by turns among models with similar scores. Pure: no file, no network, no clock.
import { type BillingChannel, channelKey } from "../adapters/types.js";
import type { Task } from "../graph/schema.js";

export const HARD_FROM_DEFAULT = 8;
export const SIMILAR_WITHIN_DEFAULT = 5;

/** One model of a line: its first written member, then its stand-ins in written order. */
export interface ModelUnit { entries: BillingChannel[]; score?: number }

// Scores compare in tenths, for the order and for the cut alike: floating point never decides.
const tenths = (n: number): number => Math.round(n * 10);
const tail = (c: BillingChannel): string => c.model.slice(c.model.lastIndexOf("/") + 1);

/** The closed identity rule: equal probed identities; or neither has one and the ids after the last `/`
 *  are equal; or one has an identity and it equals the other's id after the last `/`. Never otherwise. */
export function sameModel(a: BillingChannel, b: BillingChannel): boolean {
  if (a.identity && b.identity) return a.identity === b.identity;
  if (!a.identity && !b.identity) return tail(a) === tail(b);
  return a.identity ? a.identity === tail(b) : b.identity === tail(a);
}

export function modelUnits(members: readonly BillingChannel[]): ModelUnit[] {
  const units: ModelUnit[] = [];
  for (const m of members) {
    const u = units.find((u) => u.entries.some((e) => sameModel(e, m)));
    if (u) u.entries.push(m);
    else units.push({ entries: [m] });
  }
  return units.map((u) => {
    const score = u.entries.find((e) => typeof e.score === "number" && Number.isFinite(e.score))?.score;
    return score === undefined ? u : { ...u, score };
  });
}

/** Groups, strongest first: by score in tenths, or by level when any model has no score. */
export function complexityGroups(units: readonly ModelUnit[], similarWithin: number): { groups: ModelUnit[][]; byLevel: boolean } {
  if (units.some((u) => u.score === undefined)) {
    const groups = (["frontier", "mid", "cheap"] as const)
      .map((tier) => units.filter((u) => u.entries[0].tier === tier))
      .filter((g) => g.length);
    return { groups, byLevel: true };
  }
  const sorted = [...units].sort((a, b) => tenths(b.score!) - tenths(a.score!)); // stable: ties in written order
  const groups: ModelUnit[][] = [];
  for (const u of sorted) {
    const g = groups[groups.length - 1];
    if (g && tenths(g[0].score!) - tenths(u.score!) <= tenths(similarWithin)) g.push(u);
    else groups.push([u]);
  }
  return { groups, byLevel: false };
}

/** One [low, high] per group, group 1 first; null for a group left with no range. */
export function complexityRanges(n: number, hardFrom: number): ([number, number] | null)[] {
  if (n <= 1) return [[1, 10]];
  const out: ([number, number] | null)[] = [[hardFrom, 10]];
  const m = n - 1;
  const rest = hardFrom - 1;
  const base = Math.floor(rest / m);
  const extra = rest % m;
  let high = hardFrom - 1;
  for (let i = 0; i < m; i++) {
    const size = base + (i < extra ? 1 : 0);
    out.push(size ? [high - size + 1, high] : null);
    high -= size;
  }
  return out;
}

export const ownGroup = (ranges: readonly ([number, number] | null)[], complexity: number): number =>
  ranges.findIndex((r) => r !== null && complexity >= r[0] && complexity <= r[1]);

function rangeWords(i: number, n: number, ranges: readonly ([number, number] | null)[], hardFrom: number): string {
  if (n === 1) return "every task 1-10";
  if (i === 0) return `very complex ${hardFrom}-10`;
  if (n === 2) return `the rest 1-${hardFrom - 1}`;
  const r = ranges[i];
  if (!r) return "no range"; // ponytail: a group with no range only takes moved tasks
  return r[0] === r[1] ? `complexity ${r[0]}` : `complexity ${r[0]}-${r[1]}`;
}

export interface ComplexityPick { chosen: BillingChannel; phrase: string }

/**
 * Rules 1 to 7 of the contract. `members` are the line's admitted entries the probe offered, in written
 * order, read BEFORE the in-run exclusion; `excluded` is that exclusion. `graph` gives the task's rank
 * among its peers; with none (or a task not in it) `hash` stands for the rank. Null when no member can
 * take the task (the caller refuses with the pool's own errors).
 */
export function pickByComplexity(opts: {
  task: Task; members: readonly BillingChannel[]; excluded: (c: BillingChannel) => boolean;
  hardFrom: number; similarWithin: number; graph?: readonly Task[]; hash: number;
}): ComplexityPick | null {
  const { task, excluded, hardFrom } = opts;
  const { groups, byLevel } = complexityGroups(modelUnits(opts.members), opts.similarWithin);
  const ranges = complexityRanges(groups.length, hardFrom);
  const own = ownGroup(ranges, task.complexity);
  const firstLive = (u: ModelUnit) => u.entries.find((e) => !excluded(e));
  const order = [own, ...Array.from({ length: own }, (_, k) => own - 1 - k), ...Array.from({ length: groups.length - own - 1 }, (_, k) => own + 1 + k)];
  const at = order.find((i) => groups[i].some((u) => firstLive(u)));
  if (at === undefined) return null;
  const g = groups[at];
  const usable = g.filter((u) => firstLive(u));
  const r = rankOf(task, opts.graph, ranges, own) ?? opts.hash;
  const turn = g[r % g.length];
  const unit = firstLive(turn) ? turn : usable[Math.floor(r / g.length) % usable.length];
  const parts = [`by complexity: ${rangeWords(at, groups.length, ranges, hardFrom)}, group ${at + 1} of ${groups.length}`];
  if (usable.length >= 2) parts[0] += `, one of ${usable.length} that take turns`;
  if (at !== own) parts.push(`group ${own + 1} has no model that can take it, moved ${at < own ? "up" : "down"}`);
  if (byLevel) {
    const none = groups.flat().filter((u) => u.score === undefined).map((u) => channelKey(u.entries[0]));
    parts.push(`grouped by level: ${none.join(", ")} has no score`);
  }
  return { chosen: firstLive(unit)!, phrase: parts.join("; ") };
}

// The task's place among its peers in graph order: same shape, same own bar, a complexity in the same
// range; a task with a pin of its own is no peer of another. Undefined when the graph does not hold it.
function rankOf(task: Task, graph: readonly Task[] | undefined, ranges: readonly ([number, number] | null)[], own: number): number | undefined {
  if (!graph?.some((t) => t.id === task.id)) return undefined;
  if (task.routingHints?.pin) return 0;
  const bar = task.routingHints?.floor;
  const peers = graph.filter((t) => t.id === task.id || (t.shape === task.shape && t.routingHints?.floor === bar
    && !t.routingHints?.pin && ownGroup(ranges, t.complexity) === own));
  return peers.findIndex((t) => t.id === task.id);
}

/**
 * Rule 8 (row 502; D-2187 add.363): the groups a later choice of the router (`nextChannel`, `climbChannel`)
 * may draw from, in order. The bound is the task's OWN group — a function of the task and the line, never of
 * the attempt before. The own group, then the stronger groups nearest first, while either has a model that
 * can take the task (offered and not `excluded`: a model only tried still counts); else only the nearest
 * weaker group that has one. Each group holds, per model, its first entry not excluded, in group order.
 */
export function retryGroups(opts: {
  task: Task; members: readonly BillingChannel[]; excluded: (c: BillingChannel) => boolean;
  hardFrom: number; similarWithin: number;
}): BillingChannel[][] {
  const { groups } = complexityGroups(modelUnits(opts.members), opts.similarWithin);
  if (!groups.length) return [];
  const own = ownGroup(complexityRanges(groups.length, opts.hardFrom), opts.task.complexity);
  const live = groups.map((g) => g.flatMap((u) => u.entries.find((e) => !opts.excluded(e)) ?? []));
  const up = Array.from({ length: own + 1 }, (_, k) => own - k).filter((i) => live[i].length);
  if (up.length) return up.map((i) => live[i]);
  const down = Array.from({ length: groups.length - own - 1 }, (_, k) => own + 1 + k).find((i) => live[i].length);
  return down === undefined ? [] : [live[down]];
}
