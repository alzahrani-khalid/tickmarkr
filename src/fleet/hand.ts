// Changing one line by hand: which lines can be changed (the team's, then the deny lists), which
// models each can take, and the config edits a set of choices becomes. A hand change joins the same review and the same save as a yes: this
// file only says what the choice writes.
import { channelKey } from "../adapters/types.js";
import { DEFAULT_CONFIG, DENY_SCOPES, ROUTING_MODES, type RoutingMode, type Tier, TIER_RANK } from "../config/config.js";
import { SHAPES } from "../graph/schema.js";
import { modelProvider, type PreferenceRole } from "../route/preference.js";
import { type Edit, reservedIn } from "./edits.js";
import type { FleetModel } from "./model.js";
import { parsedLayers } from "./needs.js";
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
  mode?: "any" | "ordered" | "complexity";
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

/** What each routing mode does, as the loader compiles it into bars, in the screen's words (5.1: `bar`, `level`; row 499; D-2187 add.363). */
export const MODE_SAYS: Record<RoutingMode, string> = {
  "partner-led": "every shape needs a frontier model",
  "risk-based": "each shape keeps its own bar (the default)",
  "staff-led": "one level lower; plan, spec, migration, ui stay frontier",
};
const built = new WeakMap<FleetModel, HandLine[]>();
/** Every line a hand can change, as the config stands in `M`: the team's, then the deny lists. Built once for a model. */
export function handLines(M: FleetModel): HandLine[] {
  let lines = built.get(M);
  if (!lines) {
    // which config a change of the line is written to: the one that holds it, the repository's when neither does
    const holder = ownHolder(parsedLayers(M.inputs));
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
      const lift = freeSeat(structuredClone(cfg.routing) as typeof cfg.routing, ownSeat(M.health, seat.adapter, seat.model), seat.key, role, othersOf(M, seat.key));
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
 * Two keys on ONE CLI can be the same model too (an alias and its full id: `claude-code:opus` and
 * `claude-code:claude-opus-5-5`): the CLI does not tell those apart, so each is shown as its key.
 */
export function namesOf(M: FleetModel, keys: readonly string[]): string[] {
  const tally = (xs: readonly string[]): Map<string, number> => { const n = new Map<string, number>(); for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1); return n; };
  const count = tally(keys.map((k) => M.name(k)));
  const byCli = keys.map((k) => ((count.get(M.name(k)) ?? 0) > 1 ? `${M.name(k)} (${k.slice(0, k.indexOf(":"))})` : M.name(k)));
  const again = tally(byCli);
  return keys.map((k, i) => ((again.get(byCli[i]) ?? 0) > 1 ? k : byCli[i]));
}

/** The edit a choice on a line of the team becomes. `chosen` is never empty: a line with nobody on it is not a choice. */
export function handEdit(M: FleetModel, line: HandLine, chosen: readonly string[], mode = line.mode): Edit {
  const layer = ownHolder(parsedLayers(M.inputs))(line.path);
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

/** What a shape's floor is set to by hand: a tier for this shape, or "mode" for what the routing mode says. */
export type FloorChoice = Tier | "mode";
/** How a line's floor stands, in the same terms. */
export const floorOf = (line: HandLine): FloorChoice | undefined => (line.floor ? (line.floor.own && line.floor.tier ? line.floor.tier : "mode") : undefined);
const at = (obj: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((cur, seg) => (cur !== null && typeof cur === "object" && Object.hasOwn(cur, seg) ? (cur as Record<string, unknown>)[seg] : undefined), obj);
/**
 * holderIn's rule (needs.ts) read through own keys only: a CLI or model named toString or __proto__ is held by a
 * layer only when that layer names it, never because every object inherits it (row 522; D-2187 add.444).
 */
const ownHolds = (doc: unknown, path: readonly string[]): boolean =>
  at(doc, path) !== undefined || path.slice(0, -1).some((_, i) => at(doc, path.slice(0, i + 1)) === null);
const ownHolder = (layers: { user: unknown; repo: unknown }) => (path: readonly string[]): Edit["layer"] =>
  (ownHolds(layers.repo, path) || !ownHolds(layers.user, path) ? "repo" : "user");
/** observedSeat (route/preference.ts) read through own keys: an identity is a string the probe recorded for this model, nothing inherited (row 522). */
function ownSeat(health: unknown, adapter: string, model: string): { adapter: string; model: string; identity?: string } {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const identity = str(at(health, [adapter, "modelAuth", model, "identity"])) ?? str(at(health, [adapter, "modelIdentities", model]));
  return identity ? { adapter, model, identity } : { adapter, model };
}
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
export interface HandChoice {
  line: string; chosen: string[]; mode?: "any" | "ordered" | "complexity"; floor?: FloorChoice;
  /** models this line's change also allows: each added by name to routing.allow.models, never a whole CLI (row 498; D-2187 add.363) */
  allows?: string[];
}
/** A level moved in the models view is a choice of its own, on the line `tier:<cli>:<model>` (row 498; D-2187 add.363). */
export const TIER_LINE = "tier:";
/**
 * The vendor the identity the probe recorded for a model names, else its id: the vendor
 * of a qualified identity first, then the known families (one vendor/model, such as alibaba/qwen3.8-max); "" when it names none (row 498; D-2187 add.410).
 */
export function recordedVendor(M: FleetModel, cli: string, model: string): string {
  const id = ownSeat(M.inputs.health ?? M.health, cli, model).identity ?? model, q = /^\s*([^/\s]+)\/[^/]+$/u.exec(id);
  // the qualified vendor wins over the family its model name reads as (anthropic/gpt-oss-120b is anthropic's); a known
  // alias of a vendor (zai, openai-codex) reads as that vendor (row 498; D-2187 add.410)
  if (q) { const v = q[1].toLowerCase(); return modelProvider(`${v}/`, v); }
  return modelProvider(id, "");
}

/**
 * The edits a set of choices becomes, taken in the order they were made: a line of the team is its
 * own edit, a shape's written in the mode chosen, and a shape with no line of its own yet given one by
 * complexity; a deny list is set to what is ticked; `hardFrom` is the one number every line by
 * complexity reads. A model added to a line lifts no rule (rule K2; rows 499, 501, 502; D-2187 add.363):
 * a rule is removed only from its own line of KEPT OUT. The rules start from `answered`, the edits the
 * yes answers make, so a hand change is made on top of them. One edit comes back for each list that
 * ends up different.
 */
const ALLOW = ["routing", "allow", "models"];
export function handEdits(M: FleetModel, choices: readonly HandChoice[], answered: readonly Edit[] = []): Edit[] {
  const all = handLines(M), layers = parsedLayers(M.inputs), holder = ownHolder(layers);
  // Review labels describe the saved batch, including a mode choice made after a floor choice.
  const batchMode = choices.reduce<string>((mode, c) => c.line === "mode" && c.chosen.length ? c.chosen[0] : mode, M.mode.mode);
  const floorFromMode = `as mode ${batchMode} says`;
  const start = structuredClone(M.cfg.routing) as typeof M.cfg.routing;
  // only a rule list's own path is walked here: putRule writes through whatever its steps lead to, so a path through
  // __proto__, constructor, prototype or any other inherited key (toString, hasOwnProperty…) would reach a shared object.
  // Any other path is left for the write path to refuse by name (row 522; D-2187 add.444)
  const isRuleList = (p: readonly string[]) => [ALLOW, ...DENY_SCOPES.map((sc) => sc.path)].some((l) => l.length === p.length && l.every((s, i) => s === p[i]));
  for (const e of answered) if (Array.isArray(e.value) && reservedIn(e.path) === undefined && isRuleList(e.path)) putRule(start, e.path, [...(e.value as string[])]);
  const routing = structuredClone(start);
  const lines: Edit[] = [];
  for (const c of choices) {
    // c on a line by complexity: one setting for every such line, never a line's own (rows 501, 502)
    if (c.line === "hardFrom") {
      const path = ["routing", "hardFrom"];
      lines.push({ layer: holder(path), path, value: Number(c.chosen[0]), label: `very complex starts at ${c.chosen[0]}, for every line given out by complexity` });
      continue;
    }
    // a level from the models view: tiers.<cli>.models.<model> (row 498)
    if (c.line.startsWith(TIER_LINE)) {
      const key = c.line.slice(TIER_LINE.length), i = key.indexOf(":"), path = ["tiers", key.slice(0, i), "models", key.slice(i + 1)];
      lines.push({ layer: holder(path), path, value: c.chosen[0], label: `level of ${key}: ${c.chosen[0]}` });
      // a CLI or model named __proto__, constructor or prototype: the level alone goes on, for the write path to refuse by
      // name; no channel, vendor or override is read or written for it (row 522; D-2187 add.444)
      if (reservedIn(path) !== undefined) continue;
      // the vendor a model id reads as is read from the identity the probe recorded for it, else its id; never invented:
      // an id that names none is left for validation to refuse, by its reason (row 498; D-2187 add.408)
      const cli = path[1], model = path[3], t = Object.hasOwn(M.cfg.tiers, cli) ? M.cfg.tiers[cli] : undefined,
        seed = (Object.hasOwn(DEFAULT_CONFIG.tiers, cli) ? DEFAULT_CONFIG.tiers[cli] : undefined) as typeof t | undefined;
      const vendor = recordedVendor(M, cli, model);
      const put = (p: string[], value: string, label: string) => lines.push({ layer: holder(p), path: p, value, label });
      // a CLI the settings do not have (removed, or never named): its entry is written with this model alone, billed as
      // shipped, else per use; none of its other models comes back (row 498; D-2187 add.408)
      if (!t) {
        put(["tiers", cli, "channel"], seed?.channel ?? "api", `${cli} back in your settings, billed ${(seed?.channel ?? "api") === "sub" ? "by subscription" : "per use"}`);
        const v = seed ? seed.vendor : vendor;
        if (v) put(["tiers", cli, "vendor"], v, `vendor of ${cli}: ${v}`);
      }
      // a CLI of several vendors (vendor: null) needs each named model's vendor
      const was = t ?? seed;
      // a CLI of several vendors is written vendor: null, or with a placeholder (mixed, unknown): each named model needs its own (row 515; D-2187 add.442)
      if (was && (was.vendor === null || was.vendor === "mixed" || was.vendor === "unknown") && !(t?.modelOverrides && Object.hasOwn(t.modelOverrides, model) && t.modelOverrides[model]?.vendor) && vendor) put(["tiers", cli, "modelOverrides", model, "vendor"], vendor, `vendor of ${key}: ${vendor}`);
      continue;
    }
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
    // a model not allowed yet that this line names is allowed by name, in the same save, with or without a change of
    // its models (the screen keeps `allows` to models on the line); a deny rule is never lifted (row 498; K2)
    for (const k of c.allows ?? []) if (!ruleList(routing, ALLOW).includes(k)) putRule(routing, ALLOW, [...ruleList(routing, ALLOW), k]);
    if (!c.chosen.length) continue;
    // a shape with no line of its own yet gets one by complexity (row 502); a model added lifts no rule (K2)
    lines.push(handEdit(M, line, c.chosen, line.mode && (c.mode ?? (M.cfg.routing.map[line.id]?.pool ? line.mode : "complexity"))));
  }
  return [...lines, ...ruleEdits(start, routing, holder)];
}
