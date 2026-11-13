// Changing one line by hand: which lines can be changed (the team's, then the deny lists), which
// models each can take, and the config edits a set of choices becomes. A hand change joins the same review and the same save as a yes: this
// file only says what the choice writes.
import { channelKey } from "../adapters/types.js";
import { DENY_SCOPES, ROUTING_MODES, type RoutingMode, type Tier, TIER_RANK } from "../config/config.js";
import { SHAPES } from "../graph/schema.js";
import { disallowedBy, observedSeat, type PreferenceRole } from "../route/preference.js";
import type { Edit } from "./edits.js";
import type { FleetModel } from "./model.js";
import { holderIn, parsedLayers } from "./needs.js";
import { freeSeat, othersOf, putRule, ruleEdits, ruleList, WORK } from "./rules.js";

export interface HandLine {
  /** "implement" … "chore", "judge", "review", "consult"; then each deny list by its config path: "deny.models", "deny.workers.models" … */
  id: string;
  /** the config a change of this line is written to: the layer that holds it today */
  layer?: "user" | "repo";
  /** a deny list: what is ticked is denied, the order means nothing, and nothing ticked is a choice */
  deny?: true;
  /** a setting, not a list of models: the routing mode. Its candidates are its values, and one is chosen. */
  setting?: true;
  role: PreferenceRole;
  /**
   * A shape's pool mode, and only a shape has one. "any": the cheapest takes each task, vendors at
   * one cost take turns, and of one vendor's models the first named. "ordered": the first that works
   * takes every task. A shape with no pool yet reads "any", which is what a choice gives it.
   */
  mode?: "any" | "ordered";
  /**
   * A shape's floor, and only a shape has one: the tier in force (none when the config removed it),
   * and whether a config sets it for this shape (`own`) or the routing mode gives it.
   */
  floor?: { tier: Tier | undefined; own: boolean };
  /** a shape pinned to one model: that model is what the line names today, and a choice makes the pin a pool */
  pinned?: true;
  /** a shape with a prefer list and no pool: a choice replaces the list with a pool */
  prefers?: true;
  /** the judge is one model; a pool and the two prefer lists are several */
  one: boolean;
  path: string[];
  /** what the config names on this line today, in its order */
  current: string[];
  /**
   * Working models that may take the line, strongest first; then what the config names that does not
   * work; then models that answered the probe and that a rule keeps from this line.
   */
  candidates: string[];
  /** Those last ones: what keeps each out, and whether a tick may lift it (a rule for this model alone, or the allowlist). */
  barred: Record<string, { why: string; liftable: boolean }>;
  /** what the line is today when it is not a list of models, and what choosing writes */
  note: string;
}

/** What each routing mode does, as the loader compiles it into floors. */
export const MODE_SAYS: Record<RoutingMode, string> = {
  "partner-led": "every shape needs a frontier model",
  "risk-based": "each shape keeps its own floor (the default)",
  "staff-led": "one tier lower; plan, spec, migration, ui stay frontier",
};
const built = new WeakMap<FleetModel, HandLine[]>();
/** Every line a hand can change, as the config stands in `M`: the team's, then the deny lists. Built once for a model. */
export function handLines(M: FleetModel): HandLine[] {
  let lines = built.get(M);
  if (!lines) {
    // which config a change of the line is written to: the one that holds it, the repository's when neither does
    const holder = holderIn(parsedLayers(M.inputs));
    built.set(M, lines = buildLines(M).map((l) => ({ ...l, layer: holder(l.path) })));
  }
  return lines;
}
function buildLines(M: FleetModel): HandLine[] {
  const { cfg } = M;
  const able = (role: PreferenceRole, current: string[]): Pick<HandLine, "candidates" | "barred"> => {
    const live = [...M.pools[role]].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]).map(channelKey);
    const named = [...live, ...current.filter((k) => !live.includes(k))];
    // Kept out by a rule, not by the probe: listed with the reason, so a model is never just missing.
    const barred: HandLine["barred"] = {};
    for (const seat of [...M.seats].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])) {
      if (seat.verdict.state !== "pass" || !seat.denied[role] || live.includes(seat.key)) continue;
      const lift = freeSeat(structuredClone(cfg.routing) as typeof cfg.routing, observedSeat(M.health, seat.adapter, seat.model), seat.key, role, othersOf(M, seat.key));
      barred[seat.key] = { why: lift.why.join(" and ") || "a rule", liftable: lift.freed };
    }
    return { candidates: [...named, ...Object.keys(barred).filter((k) => !named.includes(k))], barred };
  };
  const shapes = SHAPES.map((shape): HandLine => {
    const slot = cfg.routing.map[shape];
    const current = slot?.pool?.channels ?? (slot?.pin ? [`${slot.pin.via}:${slot.pin.model}`] : []);
    const note = slot?.pool ? `its pool (${slot.pool.mode})`
      : slot?.pin ? "a pin: that one model takes every task of this shape; a choice here makes it a pool"
      : slot?.prefer?.length ? `prefers ${slot.prefer.join(", ")}; a choice here replaces that with a pool`
      : "no pool: the router picks by cost within the floor; a choice here gives it a pool";
    return { id: shape, role: "worker", floor: { tier: cfg.routing.floors[shape], own: M.mode.provenance[shape] === "config floors" }, mode: slot?.pool?.mode ?? "any", ...(slot?.pin && !slot.pool ? { pinned: true as const } : {}), ...(slot?.prefer?.length && !slot.pool && !slot.pin ? { prefers: true as const } : {}), one: false, path: ["routing", "map", shape], current: [...current], ...able("worker", [...current]), note };
  });
  // The deny lists, one line for each the schema has: what is written there first, then every model
  // (or CLI) that could be, strongest first.
  const ranked = [...M.seats].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
  const deny = DENY_SCOPES.map((sc): HandLine => {
    const current = ruleList(cfg.routing, sc.path), all = sc.path.at(-1) === "adapters" ? [...new Set(ranked.map((s) => s.adapter))] : ranked.map((s) => s.key);
    return { id: sc.path.slice(1).join("."), deny: true, role: "worker", one: false, path: [...sc.path], current: [...current], candidates: [...current, ...all.filter((k) => !current.includes(k))], barred: {},
      note: `what is ticked is kept from ${sc.path[2] === "workers" ? `${WORK}, and may still judge, review and consult` : "every seat"}: ${sc.dotted}` };
  });
  const judge = channelKey(cfg.judge), review = cfg.review.prefer ?? [], consult = cfg.consult.prefer ?? [];
  return [...shapes,
    { id: "judge", role: "judge", one: true, path: ["judge"], current: [judge], ...able("judge", [judge]), note: "the acceptance judge" },
    { id: "review", role: "review", one: false, path: ["review", "prefer"], current: [...review], ...able("review", [...review]), note: review.length ? "review.prefer, in order" : "not set: a reviewer from another vendor is picked" },
    { id: "consult", role: "consult", one: false, path: ["consult", "prefer"], current: [...consult], ...able("consult", [...consult]), note: consult.length ? "consult.prefer, in order" : "not set: nobody can consult" },
    // the posture the header names: one of three presets the loader turns into floors
    { id: "mode", setting: true, role: "worker", one: true, path: ["routing", "mode"], current: [M.mode.mode], candidates: [...ROUTING_MODES], barred: {},
      note: "a preset that sets the floor of every shape; a floor written for one shape still beats it: routing.mode" },
    ...deny,
  ];
}

/**
 * Names for a set of models shown together. A model reached through two CLIs has one name, so where
 * two keys in the set share a name each says which CLI it is: `grok-4.7 (grok)`, `grok-4.7 (omp)`.
 */
export function namesOf(M: FleetModel, keys: readonly string[]): string[] {
  const count = new Map<string, number>();
  for (const k of keys) count.set(M.name(k), (count.get(M.name(k)) ?? 0) + 1);
  return keys.map((k) => ((count.get(M.name(k)) ?? 0) > 1 ? `${M.name(k)} (${k.slice(0, k.indexOf(":"))})` : M.name(k)));
}

/** The edit a choice on a line of the team becomes. `chosen` is never empty: a line with nobody on it is not a choice. */
export function handEdit(M: FleetModel, line: HandLine, chosen: readonly string[], mode = line.mode): Edit {
  const layer = holderIn(parsedLayers(M.inputs))(line.path);
  if (line.setting) return { layer, path: line.path, value: chosen[0], label: `${line.id}: ${chosen[0]}` };
  // the label says what the hand did to the line, not the whole line: what joined, what left
  const all = [...new Set([...line.current, ...chosen])], name = new Map(all.map((k, i) => [k, namesOf(M, all)[i]]));
  const added = chosen.filter((k) => !line.current.includes(k)), removed = line.current.filter((k) => !chosen.includes(k));
  const did = [added.length ? `add ${added.map((k) => name.get(k)).join(", ")}` : "", removed.length ? `remove ${removed.map((k) => name.get(k)).join(", ")}` : "",
    // what stays is in another order, or what joined did not join at the end
    [...line.current.filter((k) => chosen.includes(k)), ...added].some((k, i) => k !== chosen[i]) ? "a new order" : "",
    mode !== line.mode ? `mode ${mode}` : "", // a pool is the whole list for its shape: where there was none, the review says what it takes the place of
    line.pinned ? "the pin becomes a pool" : line.prefers ? "its prefer list becomes a pool" : line.mode && !line.current.length ? "it gets a pool: only these take it" : ""].filter(Boolean).join("; ") || "a new order";
  if (line.id === "judge") {
    const i = chosen[0].indexOf(":");
    return { layer, path: line.path, value: { adapter: chosen[0].slice(0, i), model: chosen[0].slice(i + 1) }, label: `judge: ${M.name(chosen[0])}` };
  }
  if (line.role === "worker") return { layer, path: line.path, value: { pool: { mode: mode ?? "any", channels: [...chosen] } }, label: `${line.id}: ${did}` };
  return { layer, path: line.path, value: [...chosen], label: `${line.id}: ${did}` };
}

/**
 * How far lifting the rule that keeps `key` from `line` reaches beyond that line: the other lines of
 * the team that name the model and get it back, the shapes with no pool or pin, which any worker
 * the rules allow may take, and the other seats it may then take (a rule for every seat, lifted for a
 * shape, lets the model judge, review and consult as well). The config has no rule for one shape or
 * one seat, so a lift for one line is a lift for these too.
 */
export function liftReach(M: FleetModel, line: HandLine, key: string): { named: string[]; open: string[]; seats: string[] } {
  const seat = M.seat(key), observed = seat && observedSeat(M.health, seat.adapter, seat.model);
  const after = structuredClone(M.cfg.routing) as typeof M.cfg.routing;
  if (!observed || line.deny || !freeSeat(after, observed, key, line.role, othersOf(M, key)).freed) return { named: [], open: [], seats: [] };
  const back = (role: PreferenceRole) => !!disallowedBy(observed, M.cfg.routing, role) && !disallowedBy(observed, after, role);
  const others = handLines(M).filter((l) => !l.deny && !l.setting && l.id !== line.id && back(l.role));
  return { named: others.filter((l) => l.current.includes(key)).map((l) => l.id),
    open: others.filter((l) => l.role === "worker" && !M.cfg.routing.map[l.id]?.pool && !M.cfg.routing.map[l.id]?.pin).map((l) => l.id),
    seats: (["judge", "review", "consult"] as const).filter((r) => r !== line.role && back(r)) };
}

/** What a shape's floor is set to by hand: a tier for this shape, or "mode" for what the routing mode says. */
export type FloorChoice = Tier | "mode";
/** How a line's floor stands, in the same terms. */
export const floorOf = (line: HandLine): FloorChoice | undefined => (line.floor ? (line.floor.own && line.floor.tier ? line.floor.tier : "mode") : undefined);
const at = (obj: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((cur, seg) => (cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined), obj);
/**
 * The floor a "mode" choice leaves when both layers name it. The edit removes the repository's only —
 * a second removal of the same path is refused — so the user config's floor holds, not the mode's.
 * Undefined: one layer, or neither, and the mode's words stay.
 */
function floorLeftByUser(layers: { user: unknown; repo: unknown }, shape: string): Tier | null | undefined {
  const path = ["routing", "floors", shape];
  const user = at(layers.user, path), repo = at(layers.repo, path);
  if (user === undefined || repo === undefined) return undefined;
  return user === "cheap" || user === "mid" || user === "frontier" ? user : null;
}
/**
 * One line changed by hand: the line, what is ticked on it, in order, and for a shape its pool's
 * mode and its floor. A shape with nothing ticked and a floor is a change of the floor alone: its
 * models stay as they are.
 */
export interface HandChoice { line: string; chosen: string[]; mode?: "any" | "ordered"; floor?: FloorChoice }

/**
 * The edits a set of choices becomes, taken in the order they were made: a line of the team is its
 * own edit, and each model ADDED to it that a rule of its own keeps out has that rule lifted, as far
 * as the line's role needs and no further (a model the config already named there and a rule keeps
 * out stays kept out: reordering a line lifts nothing); a deny list is set to what is ticked. The rules start from
 * `answered`, the edits the yes answers make, so a hand change is made on top of them. One edit comes
 * back for each list that ends up different.
 */
export function handEdits(M: FleetModel, choices: readonly HandChoice[], answered: readonly Edit[] = []): Edit[] {
  const all = handLines(M), layers = parsedLayers(M.inputs), holder = holderIn(layers);
  // Review labels describe the saved batch, including a mode choice made after a floor choice.
  const batchMode = choices.reduce<string>((mode, c) => c.line === "mode" && c.chosen.length ? c.chosen[0] : mode, M.mode.mode);
  const floorFromMode = `as mode ${batchMode} says`;
  const start = structuredClone(M.cfg.routing) as typeof M.cfg.routing;
  for (const e of answered) if (e.path[0] === "routing" && (e.path[1] === "deny" || e.path[1] === "allow") && Array.isArray(e.value)) putRule(start, e.path, [...(e.value as string[])]);
  let routing = structuredClone(start);
  const lines: Edit[] = [];
  for (const c of choices) {
    const line = all.find((l) => l.id === c.line);
    if (!line) continue;
    if (line.deny) { putRule(routing, line.path, [...c.chosen]); continue; }
    // a floor for this shape beats the mode. "mode" takes that floor away where one layer holds it, so the
    // mode's holds again. Where both hold it, the user config's floor is what a save leaves.
    if (c.floor !== undefined && line.floor && c.floor !== floorOf(line)) {
      const path = ["routing", "floors", line.id];
      const left = c.floor === "mode" ? floorLeftByUser(layers, line.id) : undefined;
      const phrase = c.floor !== "mode" ? c.floor : left === undefined ? floorFromMode : left === null ? "removed, the user config's" : `${left}, the user config's`;
      lines.push({ layer: holder(path), path, value: c.floor === "mode" ? undefined : c.floor, // the label says where the bar was: a floor that moves changes what "below the floor" counts
        label: `${line.id}: floor ${phrase}${line.floor.tier ? (line.floor.own ? `, was ${line.floor.tier} for this shape` : `, where mode ${M.mode.mode} said ${line.floor.tier}`) : ""}` });
    }
    if (!c.chosen.length) continue;
    lines.push(handEdit(M, line, c.chosen, line.mode && (c.mode ?? line.mode)));
    for (const key of c.chosen.filter((k) => !line.current.includes(k))) {
      const seat = M.seat(key), observed = seat && observedSeat(M.health, seat.adapter, seat.model);
      if (!observed || !disallowedBy(observed, routing, line.role)) continue;
      // on a copy: a rule that covers more than this model stops the lift, and nothing half done is kept
      const trial = structuredClone(routing);
      if (freeSeat(trial, observed, key, line.role, othersOf(M, key)).freed) routing = trial;
    }
  }
  return [...lines, ...ruleEdits(start, routing, holder)];
}
