// Allowing a model (queue row 498; D-2187 add.348, add.363; contract 5.5, design LineA-models): every CLI on
// the left, whether it answers and how many of its models this line can use; the CLI under the cursor's
// models on the right with their level, score, list price, speed and ONE state word; one detail row for the
// model under the cursor; the legend; the keys. Pure: rows from the fleet's model (pending changes applied),
// the line's models so far and the search. The keys live in screen.ts; nothing here reads a key or a file.
import { discoverChannels } from "../adapters/registry.js";
import { type AuthHealth, channelKey } from "../adapters/types.js";
import { DENY_SCOPES, TIER_RANK, type Tier } from "../config/config.js";
import { SHAPES, type Shape } from "../graph/schema.js";
import { BENCHMARK_BANDS } from "../route/benchmark-tier.js";
import { disallowedBy, exclusionCollector, observedSeat, type PreferenceRole } from "../route/preference.js";
import { sliceCells } from "../tui/cockpit/width.js";
import { cap, clip, type Line, S, type Style, width } from "./draw.js";
import { recordedVendor, TIER_LINE } from "./hand.js";
import { type FleetModel, shortName, splitKey, verdictOf } from "./model.js";
import type { OneLine } from "./one-screen.js";
import type { LineState, ScreenState } from "./screen.js";

/** The state words, closed, in the order they are read: the first that applies is the row's (contract 5.5). */
export const STATE_WORDS = ["kept out · your guard", "no level yet", "does not answer", "below the bar", "not allowed yet", "on this line", "can be used"] as const;
/** The characters a search takes: letters ALWAYS search, so no letter has another meaning in this view (k, j, t, x included). */
export const SEARCHES = /^[A-Za-z0-9./:-]$/u;

export interface ModelsState {
  /** the CLI under the cursor, by its place in the left column; the model under it, by its place in that CLI's rows as filtered */
  cli: number; at: number; query: string;
  /** the model under the cursor by its key: it stays selected whatever re-sorts the rows (a level moved, a probe); `at` is used only when it is gone */
  key?: string;
  /** opened from a row of a line in my order: Enter puts the model in that row instead of after the last */
  row?: number;
  /** the first row of the detail and legend in view, when they are longer than their room: PgUp and PgDn move it (row 498; D-2187 add.408) */
  foot?: number;
  /** opened from the + row of KEPT OUT: the keep-out form, where Enter keeps a model or a CLI out (row 500; D-2187 add.363) */
  keep?: true;
  /** in the keep-out form, the cursor is on the CLI in the left column (reached with ←): Enter acts on the whole CLI */
  onCli?: boolean;
}
export interface ModelRow {
  key: string; cli: string; model: string; level?: Tier; score: number | null; priceIn: number | null; priceOut: number | null; speed: number | null; name?: string;
  state: string;
  /** the rule that keeps it out (an entry of a deny list), when one does */
  rule?: string;
  /** under the shape's bar; and kept out by not being in routing.allow (each checked whatever the state word says) */
  below: boolean; notAllowed: boolean;
}
export interface CliColumn { id: string; mark: "●" | "○" | "✕"; rows: ModelRow[]; count: number; vendors: string[]; signIn?: string }

/**
 * The CLI health records of doctor.json: an entry with its `installed` verdict. Its other keys (the gateway record,
 * modelsFirstSeen, aaKeyPrompt, anything a later version adds) are not CLIs and never become one (row 498; D-2187 add.409).
 */
function cliHealth(M: FleetModel, cli: string): AuthHealth | undefined {
  const d = drawn(M), h: unknown = d && Object.hasOwn(d, cli) ? d[cli] : undefined;
  return h && typeof h === "object" && typeof (h as { installed?: unknown }).installed === "boolean" ? h as AuthHealth : undefined;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/**
 * What the probe RECORDED for a model, never the stand-in a pending new-model yes assumes (that one has no identity and is
 * dated now): its identity, so its facts, vendor and rules read as recorded; its verdict, when one was recorded (row 515; D-2187 add.442).
 */
const recorded = (M: FleetModel) => M.inputs.health ?? M.health;
const seen = (M: FleetModel, cli: string, model: string) => observedSeat(recorded(M), cli, model);
/**
 * The verdict and its age as the probe recorded them, never the seat's: beside a pending new-model yes the seat reads the
 * stand-in (installed, signed in, passed now), so a pass of yesterday, a timeout, no record, a CLI signed out or not
 * installed would all read "answers, checked today". A model the probe never listed has no record: "not checked yet" (row 515; D-2187 add.444).
 */
const verdictAt = (M: FleetModel, cli: string, model: string) => verdictOf(ownRecord(M, cli, model), cli, model, M.inputs.now);
/**
 * The recorded CLI entry and the model's verdict as own keys only, on null-prototype holders: a model named like an Object
 * property (constructor, toString, __proto__) without a record of its own reads "not checked yet", never an inherited "probe failed" (row 515; D-2187 add.444).
 */
function recordedCli(M: FleetModel, cli: string): AuthHealth | undefined {
  const h = recorded(M), c: unknown = h && Object.hasOwn(h, cli) ? h[cli] : undefined;
  return c && typeof c === "object" && typeof (c as { installed?: unknown }).installed === "boolean" ? c as AuthHealth : undefined;
}
function ownRecord(M: FleetModel, cli: string, model: string): Record<string, AuthHealth> | null {
  const h = recorded(M);
  if (!h) return null;
  const out = Object.create(null) as Record<string, AuthHealth>, c = recordedCli(M, cli);
  if (!c) return out;
  const auth = Object.create(null) as NonNullable<AuthHealth["modelAuth"]>;
  if (c.modelAuth && Object.hasOwn(c.modelAuth, model)) Object.defineProperty(auth, model, { enumerable: true, value: c.modelAuth[model] });
  Object.defineProperty(out, cli, { enumerable: true, value: { ...c, modelAuth: auth } });
  return out;
}
/**
 * The probe's record as the view draws it: only a model the probe never listed takes the pending yes's stand-in, and only
 * on a CLI the probe did not record signed out or not installed (there it is listed, never drawn as answering) (row 515; D-2187 add.444).
 */
const drawnOf = new WeakMap<FleetModel, Record<string, AuthHealth> | null>();
function drawn(M: FleetModel): Record<string, AuthHealth> | null {
  const rec = M.inputs.health, keys = M.inputs.assume ?? [];
  if (!rec || !keys.length || !M.health) return M.health;
  if (drawnOf.has(M)) return drawnOf.get(M)!;
  const out: Record<string, AuthHealth> = { ...rec };
  for (const k of keys) {
    const [a, m] = splitKey(k), prev = Object.hasOwn(out, a) ? out[a] : undefined, listed = prev?.models ?? [];
    if (prev && (listed.includes(m) || (prev.modelAuth && Object.hasOwn(prev.modelAuth, m)))) continue;
    const up = !prev || (prev.installed && prev.authed !== false), sa = Object.hasOwn(M.health, a) ? M.health[a].modelAuth : undefined, stand = sa && Object.hasOwn(sa, m) ? sa[m] : undefined;
    const base = prev ?? { installed: true, authed: true, models: [] };
    // defined, not assigned: a CLI named __proto__ is an own key (row 522)
    Object.defineProperty(out, a, { enumerable: true, writable: true, configurable: true, value: { ...base, models: [...listed, m],
      ...(up && base.servable ? { servable: [...base.servable, m] } : {}),
      ...(up && stand ? { modelAuth: { ...base.modelAuth, [m]: stand } } : {}) } });
  }
  drawnOf.set(M, out);
  return out;
}
/** The facts the probe recorded for a model: they belong to the identity it observed, else the full id (row 502). */
function factsOf(M: FleetModel, cli: string, model: string) {
  const f = cliHealth(M, cli)?.modelFacts?.[model];
  const ok = !!f && f.as === (seen(M, cli, model).identity ?? model);
  return { score: ok ? num(f!.score) : null, priceIn: ok ? num(f!.priceIn) : null, priceOut: ok ? num(f!.priceOut) : null, speed: ok ? num(f!.speed) : null, name: ok ? f!.name : undefined };
}
/**
 * The models that answer as a worker after discovery, rules aside: installed and signed in, probed (or the
 * config routes unverified models), served and listed (servable, the validated list, hidden models). Only a
 * model in this pool can be "on this line" or "can be used"; the rules are read by their own state words (row 498).
 */
const open = new WeakMap<FleetModel, Set<string>>();
function answering(M: FleetModel): Set<string> {
  let s = open.get(M);
  if (!s) {
    const { allow: _a, deny: _d, ...routing } = M.cfg.routing;
    const h = drawn(M);
    s = new Set(h ? discoverChannels({ ...M.cfg, routing: routing as typeof M.cfg.routing }, M.inputs.adapters, h).map(channelKey) : []);
    open.set(M, s);
  }
  return s;
}
/** Whether routing.allow lacks the model, read on its own: a deny rule that also names it does not hide the allowance it needs (row 498). */
export const allowLacks = (M: FleetModel, cli: string, model: string, role: PreferenceRole = "worker"): boolean =>
  exclusionCollector(seen(M, cli, model), M.cfg.routing, role).some((e) => e.by === "allow");
/** The role a line's models are read for: the judge, the review and the consult as themselves, a workers' rule does not reach them (row 499); every other line as a worker. */
export const roleOf = (shape: string): PreferenceRole => (shape === "judge" || shape === "review" || shape === "consult" ? shape : "worker");
/** The model under the cursor: by its key while it is in the rows, else by its place. */
export const cursorAt = (rows: readonly ModelRow[], st: ModelsState): number => {
  const i = st.key ? rows.findIndex((r) => r.key === st.key) : -1;
  return i >= 0 ? i : Math.max(0, Math.min(st.at, rows.length - 1));
};
/** The CLI under the cursor: the one of the model held by its key (a CLI put back in the settings moves in the list), else by its place. */
export const cliAt = (cols: readonly CliColumn[], st: ModelsState): number => {
  const i = st.key ? cols.findIndex((c) => st.key!.startsWith(`${c.id}:`) && c.rows.some((r) => r.key === st.key)) : -1;
  return i >= 0 ? i : Math.max(0, Math.min(st.cli, cols.length - 1));
};
const keptCli = (M: FleetModel, cli: string, role: PreferenceRole = "worker"): boolean => DENY_SCOPES.some((sc) => {
  if (sc.path[2] === "workers" && role !== "worker") return false;
  const list = (sc.path.slice(1).reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), M.cfg.routing) ?? []) as string[];
  // a rule names the whole CLI by the CLI's own id, in an adapters list or a models list; workers' lists keep it from the line's work too
  return Array.isArray(list) && list.includes(cli);
});

/**
 * Every CLI the config or the probe knows, and the rows of each: the models the config gives a level on that
 * CLI and the models the CLI lists, strongest score first, unscored last by name; filtered by `query` (a
 * substring of the id). `chosen` is the line's models so far.
 */
/** A CLI's settings and a model's level read by own key only: a CLI or model named like an Object property (constructor) is not one (row 515). */
export const tierOf = (cfg: FleetModel["cfg"], cli: string) => (Object.hasOwn(cfg.tiers, cli) ? cfg.tiers[cli] : undefined);
export const levelOf = (cfg: FleetModel["cfg"], cli: string, model: string) => {
  const t = tierOf(cfg, cli);
  return t?.models && Object.hasOwn(t.models, model) ? t.models[model] : undefined;
};
const ownOverride = (t: FleetModel["cfg"]["tiers"][string] | undefined, model: string) =>
  t?.modelOverrides && Object.hasOwn(t.modelOverrides, model) ? t.modelOverrides[model] : undefined;

export function modelColumns(M: FleetModel, shape: string, chosen: readonly string[], query = ""): CliColumn[] {
  const clis = [...new Set([...Object.keys(M.cfg.tiers), ...Object.keys(drawn(M) ?? {}).filter((id) => cliHealth(M, id))])];
  const bar = M.cfg.routing.floors[shape as Shape], q = query.toLowerCase(), pool = answering(M), role = roleOf(shape);
  return clis.map((cli): CliColumn => {
    // the CLI's mark reads the probe's record, never the stand-in a pending yes draws for an unrecorded CLI (row 515; D-2187 add.444)
    const t = tierOf(M.cfg, cli), h = cliHealth(M, cli), r = recordedCli(M, cli);
    const ids = [...new Set([...Object.keys(t?.models ?? {}), ...(Array.isArray(h?.models) ? h.models : []).filter((m): m is string => typeof m === "string")])];
    const all = ids.map((model): ModelRow => {
      // own keys only: a probe may list a model named like an Object property (constructor, toString) (row 515; D-2187 add.437)
      const key = `${cli}:${model}`, f = factsOf(M, cli, model), level = levelOf(M.cfg, cli, model);
      const d = disallowedBy(seen(M, cli, model), M.cfg.routing, role);
      const v = verdictAt(M, cli, model);
      const below = !!level && !!bar && TIER_RANK[level] < TIER_RANK[bar], notAllowed = allowLacks(M, cli, model, role);
      // the closed order (contract 5.5): "on this line" and "can be used" only for a model in the worker pool after discovery (row 498)
      const state = d && d.by === "deny" ? STATE_WORDS[0] : !level ? STATE_WORDS[1]
        : !pool.has(key) ? `${STATE_WORDS[2]}: ${v.state === "fail" || v.state === "missing" ? v.text : v.state === "never" ? "not checked yet" : `${cli} does not offer it`}`
        : below ? STATE_WORDS[3] : notAllowed ? STATE_WORDS[4] : chosen.includes(key) ? STATE_WORDS[5] : STATE_WORDS[6];
      return { key, cli, model, level, ...f, state, ...(d?.by === "deny" ? { rule: d.entry } : {}), below, notAllowed };
    }).sort((a, b) => (a.score === null ? (b.score === null ? 0 : 1) : b.score === null ? -1 : b.score - a.score) || a.model.localeCompare(b.model));
    const rows = q ? all.filter((r) => r.model.toLowerCase().includes(q)) : all;
    // the vendor reads the identity the probe recorded, configured model or not; the config's vendor is only the fallback (row 498; D-2187 add.409)
    // a qualified identity (vendor/model) is read before the config's vendor (D-2187 add.410)
    const vendors = [...new Set(ids.map((m) => recordedVendor(M, cli, m)
      || (M.seat(`${cli}:${m}`)?.vendor ?? ownOverride(t, m)?.vendor ?? t?.vendor ?? "unknown")))];
    // billing is per model: a model override's channel wins over the CLI's, so a CLI whose models bill both ways says so (row 515)
    const kinds = t ? [...new Set(ids.map((m) => ownOverride(t, m)?.channel ?? t.channel))] : [];
    return { id: cli, mark: keptCli(M, cli, role) ? "✕" : r?.installed && r.authed ? "●" : "○", rows,
      count: rows.filter((r) => r.state === STATE_WORDS[5] || r.state === STATE_WORDS[6]).length, vendors,
      // the sign-in kind is how the config bills the route; whose sign-in it is, is not known (row 497)
      ...(t ? { signIn: kinds.length > 1 ? "subscription for some models, API key for others" : (kinds[0] ?? t.channel) === "sub" ? "subscription" : "API key, paid per use" } : {}) };
  });
}

/** The level a score reads as against the 2.26 bands: its share of the best score among the models the config uses. */
export function levelEvidence(M: FleetModel, row: ModelRow): string {
  const best = Math.max(-Infinity, ...M.seats.map((s) => factsOf(M, s.adapter, s.model).score ?? -Infinity));
  const caveat = "This rests on one benchmark of two.";
  if (row.score === null || !Number.isFinite(best) || best <= 0) return `No score is recorded for it, so no level can be read from one. ${caveat}`;
  const share = row.score / best, reads: Tier = share >= BENCHMARK_BANDS.frontier.aa ? "frontier" : share >= BENCHMARK_BANDS.mid.aa ? "mid" : "cheap";
  return `It scores ${row.score.toFixed(1)}; the best model your settings use scores ${best.toFixed(1)}; ${share.toFixed(2)} of it reads ${reads} against the bands ${BENCHMARK_BANDS.frontier.aa.toFixed(2)} and ${BENCHMARK_BANDS.mid.aa.toFixed(2)}. ${caveat}`;
}

export interface ModelsViewInput {
  M: FleetModel; shape: string; chosen: readonly string[]; state: ModelsState;
  /** the models whose level was moved with Tab and is not saved: the evidence is shown under such a model's detail row */
  levelled?: readonly string[]; note?: string;
}

/** Every place the config names a model: a shape's pool, pin or prefer; the judge; review.prefer; the consult seat and consult.prefer (row 498). */
export function usesOf(M: FleetModel, key: string): string[] {
  const c = M.cfg;
  const shapes = SHAPES.filter((sh) => { const s = c.routing.map[sh]; return [...(s?.pool?.channels ?? []), ...(s?.pin ? [`${s.pin.via}:${s.pin.model}`] : []), ...(s?.prefer ?? [])].includes(key); });
  return [...shapes, ...(`${c.judge.adapter}:${c.judge.model}` === key ? ["judge"] : []), ...((c.review.prefer ?? []).includes(key) ? ["review"] : []),
    ...(`${c.consult.adapter}:${c.consult.model}` === key || (c.consult.prefer ?? []).includes(key) ? ["consult"] : [])];
}
/** Fill to n cells. */
const pad = (t: string, n: number): string => t + " ".repeat(Math.max(1, n - width(t)));
/** Fill to exactly n cells, adding no space past them: a CLI's cell is LEFT wide, "kept out" included (row 498; D-2187 add.410). */
const fill = (t: string, n: number): string => t + " ".repeat(Math.max(0, n - width(t)));
/** Pieces packed onto rows of `w` cells, a continuation indented: a piece wider than a row is cut across rows, never dropped. */
function pack(pieces: readonly string[], w: number, indent = 2): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (!cur || width(cur) + width(p) <= w) { cur += p; } else { out.push(cur.trimEnd()); cur = " ".repeat(indent) + p.trimStart(); }
    while (width(cur) > w) { const c = sliceCells(cur, w); out.push(c.head); cur = " ".repeat(indent) + c.tail; }
  }
  return [...out, cur.trimEnd()];
}
const price = (i: number | null, o: number | null): string => (i === null && o === null ? "—" : `${i ?? "—"} / ${o ?? "—"}`);

/** The view's parts, `w` cells wide (contract 5.5): the head, the CLI column, the CLI's header, its model rows (each its wrapped lines), the detail and the legend with the keys. */
export interface ModelsParts { head: OneLine[]; left: OneLine[]; rightHead: OneLine[]; rows: Array<{ lines: OneLine[]; sel: boolean }>; detail: OneLine[]; legend: OneLine[];
  /** the message of the last key, kept whole at the foot; the keys, and the keys when the detail and legend scroll */
  note: OneLine[]; keys: OneLine[]; keysMore: OneLine[]; leftAt: number }
export function modelsParts(inp: ModelsViewInput, w = 100): ModelsParts {
  const { M, shape, chosen, state } = inp;
  const cols = modelColumns(M, shape, chosen, state.query);
  const ci = cliAt(cols, state), cli = cols[ci];
  const rows = cli?.rows ?? [], at = state.onCli ? -1 : cursorAt(rows, state), under = rows[at];
  // the CLI column is at most 18 cells of id wide: a longer id ends in … there, and is drawn whole in its own header on the right (row 498; D-2187 add.408)
  const IW = Math.min(18, Math.max(8, ...cols.map((c) => width(c.id)))), iw = IW + 2, LEFT = iw + 3 + 8, rw = Math.max(20, w - LEFT - 3);
  const idOf = (id: string): string => (width(id) <= IW ? id : `${sliceCells(id, IW - 1).head}…`);
  // every text is wrapped, never cut: a long search, header, model id or message takes more rows (row 498; D-2187 add.408)
  const head: OneLine[] = [...pack([state.keep ? "KEPT OUT · keep a model or a CLI out" : `${shape} · allow a model`, state.query ? `      search: ${state.query}` : "      type to search"], w)
    .map((t, i): OneLine => [S(t, i ? "accent" : "head")]), [S(" ")]];
  const vendorWords = !cli ? "" : cli.vendors.length === 1 ? `${cap(cli.vendors[0] === "openai" ? "OpenAI" : cli.vendors[0])} models` : "models of several vendors";
  const rightHead: OneLine[] = [], right: ModelsParts["rows"] = [];
  if (cli) {
    rightHead.push(...pack([cli.id, ` · ${vendorWords}`, ...(cli.signIn ? [` · sign-in: ${cli.signIn}`] : [])], rw).map((t): OneLine => [S(t, "head")]));
    // the model column narrows on a narrow window so a row's facts and state word take as few lines as they can (row 498)
    const mw = Math.min(40, Math.max(12, ...rows.map((r) => width(r.model) + 2)), Math.max(12, rw - 37));
    rightHead.push(...pack([pad("  MODEL", mw + 2), pad("LEVEL", 10), pad("SCORE", 7), pad("$ IN / OUT", 13), "TOK/S"], rw, 4).map((t): OneLine => [S(t, "dim")]));
    rows.forEach((r, i) => {
      const style: Style | undefined = r.state === STATE_WORDS[6] || r.state === STATE_WORDS[5] ? "ok" : r.state === STATE_WORDS[0] ? "fail" : "warn";
      const lines = pack([`${i === at ? "▸ " : "  "}${pad(r.model, mw)}`, pad(r.level ?? "—", 10), pad(r.score === null ? "—" : r.score.toFixed(1), 7),
        pad(price(r.priceIn, r.priceOut), 13), pad(r.speed === null ? "—" : String(Math.round(r.speed)), 7), r.state], rw, 4)
        .map((t): OneLine => [i === at ? { ...S(t, style), selected: true } : S(t, style)]);
      right.push({ lines, sel: i === at });
    });
    // the search itself is drawn whole in the head: the sentence does not repeat it, so it is never longer than its room
    if (!rows.length) right.push({ lines: pack((state.query ? `  no model of ${cli.id} has the search in its id` : `  ${cli.id} lists no model`).split(/(?<= )/u), rw, 2)
      .map((t): OneLine => [S(t, "dim")]), sel: false });
  }
  const left: OneLine[] = [[S(fill("CLIS", LEFT), "head")], ...cols.map((c, i): OneLine =>
    [S(fill(`${i === ci ? "▸" : " "}${c.mark} ${pad(idOf(c.id), iw)}${c.mark === "✕" ? "kept out" : c.count}`, LEFT), c.mark === "✕" ? "fail" : c.mark === "○" ? "dim" : undefined)])];
  const detail: OneLine[] = [];
  if (under) {
    const lines = usesOf(M, under.key);
    const v = verdictAt(M, under.cli, under.model);
    const age = v.ageDays === undefined ? "" : v.ageDays < 1 ? ", checked today" : `, checked ${Math.floor(v.ageDays)} ${Math.floor(v.ageDays) === 1 ? "day" : "days"} ago`;
    const verdict = v.state === "pass" ? `answers${age}` : v.state === "never" ? "not checked yet" : `does not answer: ${v.text}${age}`;
    const text = [shortName(under.model), ...(under.name ? [under.name] : []), verdict, lines.length ? `on ${lines.join(", ")}` : "not in your team yet"].join(" · ");
    for (const t of pack(text.split(/(?= · )/u), w - 2)) detail.push([S(`  ${t}`)]);
    const why = state.keep ? (under.rule ? `Kept out by the rule ${under.rule}. A rule that was there when the screen opened is left alone: x on its own line of KEPT OUT removes it.`
      : "Enter keeps it out of all work; Enter again, out of everything; Enter again lifts what this view added.")
      : under.rule ? `Kept out by the rule ${under.rule}: a tick lifts no rule; it is removed only from its own line of KEPT OUT.`
      : under.below ? `Its level, ${under.level}, is below the bar for ${shape}: ${M.cfg.routing.floors[shape as Shape]}.`
      : !under.level ? (tierOf(M.cfg, under.cli) ? "It has no level yet: Tab gives it one." : `It has no level yet: Tab gives it one, and puts ${under.cli} back in your settings with this model alone.`)
      : under.notAllowed ? `Enter allows it for ${shape} and adds it to the models your settings allow (routing.allow.models: ${under.key}).` : "";
    for (const t of why ? pack(why.split(/(?<= )/u), w - 2) : []) detail.push([S(`  ${t}`, "dim")]);
    if (inp.levelled?.includes(under.key)) for (const t of pack(levelEvidence(M, under).split(/(?<= )/u), w - 2)) detail.push([S(`  ${t}`, "dim")]);
  }
  // the keep-out form with the cursor on a CLI in the left column: Enter acts on the whole CLI (row 500)
  else if (state.onCli && cli) for (const t of pack(`${cli.id}, the whole CLI: Enter keeps it out of all work; Enter again, out of everything; Enter again lifts what this view added.`.split(/(?<= )/u), w - 2)) detail.push([S(`  ${t}`)]);
  const note = inp.note ? pack(inp.note.split(/(?<= )/u), w - 2).map((t): OneLine => [S(`  ${t}`, "accent")]) : [];
  const legend: OneLine[] = [];
  for (const t of ["● answers   ○ does not answer; its row says why   ✕ kept out",
    "score = Artificial Analysis Intelligence · price = list price in US dollars per million tokens, in / out (models.dev, else Artificial Analysis) · tok/s = output tokens per second"]) for (const r of pack(t.split(/(?<= )/u), w)) legend.push([S(r, "dim")]);
  const keysOf = (more: string) => pack((state.keep ? `↑↓ model · ←→ CLI · Enter keep it out${more} · Esc back` : `↑↓ model · ←→ CLI · Enter allow it for ${shape} · Tab change its level${more} · Esc back`).split(/(?<= )/u), w).map((r): OneLine => [S(r, "dim")]);
  return { head, left, rightHead, rows: right, detail, legend, note, keys: keysOf(""), keysMore: keysOf(" · PgUp PgDn more"), leftAt: ci + 1 };
}

/** What a key of the models view does, for screen.ts to apply: the view's next state (null: back to the line), the line's models, the levels moved, a message. */
export interface ModelsKeyResult { models: ModelsState | null; chosen?: string[]; allows?: string[]; level?: { line: string; tier?: Tier }; msg: string }
const LEVELS: readonly Tier[] = ["frontier", "mid", "cheap"];
/**
 * A key of the models view (contract 5.5): up and down over the models, left and right over the CLIs; a letter,
 * digit, `.`, `-`, `/` or `:` searches (letters ALWAYS: no letter key has another meaning here); Backspace removes
 * a character; Esc clears a search, then goes back. Enter adds the model to the line, allowing one not allowed
 * yet by name, and refuses one a rule keeps out or one below the bar, each by its reason. Tab moves the level
 * through frontier, mid, cheap and back to what `saved` (the config as saved) has; `M` holds the level so far. Nothing is written here.
 */
export function modelsKey(inp: { M: FleetModel; shape: string; chosen: readonly string[]; allows: readonly string[]; saved: FleetModel; state: ModelsState;
  /** the team with every pending yes and no Tab level: where Tab's round starts and ends (row 515; D-2187 add.442) */
  answered?: FleetModel }, key: string): ModelsKeyResult {
  const { M, shape, chosen, state } = inp, cols = modelColumns(M, shape, chosen, state.query);
  const ci = cliAt(cols, state), rows = cols[ci]?.rows ?? [];
  const at = cursorAt(rows, state), r = rows[at];
  // the cursor is held by the model's key, so a re-sort keeps the same model selected (row 498)
  const put = (next: Partial<ModelsState>, msg = ""): ModelsKeyResult => {
    // the detail and legend start from their top again for each key but PgUp and PgDn
    const s = { ...state, cli: ci, at, key: r?.key, foot: undefined, ...next };
    if ("at" in next && !("key" in next)) s.key = ("cli" in next ? cols[s.cli]?.rows : rows)?.[s.at]?.key;
    return { models: s, msg };
  };
  if (key === "pgup" || key === "pgdown") return put({ foot: Math.max(0, (state.foot ?? 0) + (key === "pgup" ? -3 : 3)) });
  if (key === "up") return put({ at: Math.max(0, at - 1) });
  if (key === "down") return put({ at: Math.min(Math.max(0, rows.length - 1), at + 1) });
  if (key === "left" || key === "right") return put({ cli: Math.max(0, Math.min(cols.length - 1, ci + (key === "left" ? -1 : 1))), at: 0 });
  if (key === "backspace") return put({ query: state.query.slice(0, -1), at: 0, key: undefined });
  if (key === "esc") return state.query ? put({ query: "", at: 0, key: undefined }) : { models: null, msg: "" };
  if (SEARCHES.test(key)) return put({ query: state.query + key, at: 0, key: undefined });
  if (!r || (key !== "enter" && key !== "tab")) return put({});
  if (key === "tab") {
    // Tab starts from the level the model has without a Tab of this sitting: as saved, or as a pending yes gave it, so the
    // round reaches every level and comes back to that one, announced as it is (row 515; D-2187 add.442)
    const was = levelOf((inp.answered ?? inp.saved).cfg, r.cli, r.model), cycle: Array<Tier | undefined> = [was, ...LEVELS.filter((t) => t !== was)];
    const as = inp.answered && levelOf(inp.answered.cfg, r.cli, r.model) !== levelOf(inp.saved.cfg, r.cli, r.model) ? "as answered" : "as saved";
    const next = cycle[(cycle.indexOf(r.level) + 1) % cycle.length];
    return { ...put({}, next === was ? `${r.key} is back to ${was ?? "no level"}, ${as}.` : `${r.key}: level ${next}, not saved yet.`), level: { line: `${TIER_LINE}${r.key}`, ...(next === was ? {} : { tier: next }) } };
  }
  // a rule is never lifted here: it is removed only from its own line of KEPT OUT (K2)
  if (r.rule) return put({}, `${r.key} is kept out by the rule ${r.rule}. Nothing was added: a rule is removed only from its own line of KEPT OUT.`);
  if (!r.level) return put({}, `${r.key} has no level yet: Tab gives it one, then Enter allows it.`);
  if (r.below) return put({}, `${r.key} is ${r.level}, below the bar for ${shape}: ${M.cfg.routing.floors[shape as Shape]}. Nothing was added.`);
  // judged against the allow list AS SAVED, on its own: another line's pending allowance may be withdrawn before the save,
  // and a saved deny of the same model does not stand in for the allowance it needs (row 498)
  const notSaved = allowLacks(inp.saved, r.cli, r.model, roleOf(shape));
  const allows = notSaved ? [...new Set([...inp.allows, r.key])] : [...inp.allows];
  // opened from a row of a line in my order, Enter puts the model in that row: rows are positions, so a model may be
  // named twice (row 515; D-2187 add.402 (3), add.441)
  const atRow = state.row !== undefined && state.row < chosen.length;
  if (!atRow && chosen.includes(r.key)) {
    if (!notSaved || inp.allows.includes(r.key)) return put({}, `${r.key} is on this line already.`);
    // on the line already but not allowed: the line's pending change is its allowance alone
    return { models: null, chosen: [...chosen], allows, msg: `${r.key} is on ${shape} already; the change also allows ${r.key}. Esc keeps the line as a pending change.` };
  }
  const next = atRow ? chosen.map((k, i) => (i === state.row ? r.key : k)) : [...chosen, r.key];
  return { models: null, chosen: next, allows, msg: `${r.key} added to ${shape}${notSaved ? `; it also allows ${r.key}` : ""}. Esc keeps the line as a pending change.` };
}

/**
 * The models view in exactly `rows` rows (row 498; D-2187 add.408): the head, the CLI column and the CLI's header
 * stay in view; the model rows scroll, always far enough that the selected model's every line, down to its state
 * word, is drawn (from its first line when it is longer than its room); the keys stay whole at the foot. The note of
 * the last key, the detail and the legend are never cut: when they are longer than their room they scroll with PgUp
 * and PgDn, and the keys say so. `footMax` is the furthest they scroll.
 */
export function modelsLayout(M: FleetModel, st: ScreenState, lv: LineState, ms: ModelsState, cols: number, rows: number): { lines: Line[]; footMax: number } {
  const levelled = st.hand.flatMap((c) => (c.line.startsWith(TIER_LINE) ? [c.line.slice(TIER_LINE.length)] : []));
  const p = modelsParts({ M, shape: lv.shape, chosen: lv.chosen, state: ms, levelled, note: st.msg || undefined }, cols);
  // the selected row's lines; with no row, the sentence that says why: either is kept whole (row 498; D-2187 add.409)
  const sel = p.rows.find((r) => r.sel)?.lines.length ?? Math.max(1, p.rows.reduce((n, r) => n + r.lines.length, 0));
  // the note of the last key leads the foot: it, the detail and the legend scroll together with PgUp and PgDn, so none is
  // ever cut and none takes the selected row's room (row 498; D-2187 add.408)
  const foot = [...p.note, ...p.detail, ...p.legend];
  // the least the columns need: the CLI's header and the selected row; with the foot long, about half the rest, enough for
  // the CLI column. The foot keeps at least 3 rows while it has any, the step of PgUp and PgDn, so no row of it is skipped
  const bodyMin = Math.max(2, p.rightHead.length + sel);
  const roomOf = (keys: OneLine[]) => {
    const avail = rows - p.head.length - keys.length - 1;
    return Math.max(Math.min(foot.length, 3), avail - Math.max(bodyMin, Math.min(p.left.length, Math.ceil(avail / 2))));
  };
  // the columns `h` rows tall: the right one's header fixed, then the model rows from `top`, scrolled to keep the selected
  // row whole; a selected row longer than its room is drawn from its first line, so its cursor and its beginning come first
  const bodyOf = (h: number): Line[] => {
    const lines = p.rows.flatMap((r) => r.lines), first = p.rows.findIndex((r) => r.sel);
    const start = first < 0 ? 0 : p.rows.slice(0, first).reduce((n, r) => n + r.lines.length, 0), space = Math.max(1, h - p.rightHead.length);
    const top = Math.max(0, start + Math.min(sel, space) - space);
    const shownRight = [...p.rightHead, ...lines.slice(top, top + space)];
    // the CLI column: from the top, or scrolled to keep the CLI under the cursor in view
    const ltop = Math.max(0, Math.min(p.left.length - h, p.leftAt - h + 1));
    const shownLeft = p.left.length > h ? [p.left[0], ...p.left.slice(Math.max(1, ltop + 1), Math.max(1, ltop + 1) + h - 1)] : p.left;
    const pad0 = shownLeft[0] ? width(shownLeft[0].map((s) => s.text).join("")) : 0;
    return Array.from({ length: h }, (_, i): Line => [...(shownLeft[i] ?? [S(" ".repeat(pad0))]), S("│  ", "dim"), ...(shownRight[i] ?? [S("")])]);
  };
  const out = (shown: Line[]) => [...shown, ...Array.from({ length: Math.max(0, rows - shown.length) }, (): Line => [S("")])].slice(0, rows).map((l) => clip(l, cols));
  // the headers and the selected row whole do not fit above the foot's least room (long ids and searches, up to 120
  // characters, on a small window): the columns and the foot then scroll together, one page, with PgUp and PgDn, so the
  // selected row down to its state word, the sentence of an empty search and every row of the foot are each reached
  // (row 498; D-2187 add.409)
  if (bodyMin > rows - p.head.length - p.keysMore.length - 1 - Math.min(foot.length, 3)) {
    const avail = Math.max(1, rows - p.head.length - p.keysMore.length), page = [...bodyOf(bodyMin), [S(" ")], ...foot];
    const footMax = Math.max(0, page.length - avail), ftop = Math.min(ms.foot ?? 0, footMax);
    return { lines: out([...p.head, ...page.slice(ftop, ftop + avail), ...p.keysMore]), footMax };
  }
  let keys = p.keys, room = roomOf(keys);
  if (foot.length > room) { keys = p.keysMore; room = roomOf(keys); }
  const footMax = Math.max(0, foot.length - room), ftop = Math.min(ms.foot ?? 0, footMax);
  const shownFoot = foot.slice(ftop, ftop + room), gap = shownFoot.length ? 1 : 0;
  const h = Math.max(2, rows - p.head.length - shownFoot.length - keys.length - gap);
  return { lines: out([...p.head, ...bodyOf(h), ...(gap ? [[S(" ")]] : []), ...shownFoot, ...keys]), footMax };
}
export const modelsFrame = (M: FleetModel, st: ScreenState, lv: LineState, ms: ModelsState, cols: number, rows: number): Line[] => modelsLayout(M, st, lv, ms, cols, rows).lines;
/** A key of the models view applied to the screen: the line's models and what it allows; a level as a pending change of its own. `M` is the team with the line so far. */
export function modelsPress(M: FleetModel, saved: FleetModel, st: ScreenState, lv: LineState, ms: ModelsState, key: string, answered?: FleetModel): ScreenState {
  const r = modelsKey({ M, shape: lv.shape, chosen: lv.chosen, allows: lv.allows ?? [], saved, state: ms, ...(answered ? { answered } : {}) }, key);
  if (r.level) {
    const id = r.level.line, hand = st.hand.filter((c) => c.line !== id), log = st.log.filter((e) => e !== `h:${id}`);
    return { ...st, models: r.models, msg: r.msg, ...(r.level.tier ? { hand: [...hand, { line: id, chosen: [r.level.tier] }], log: [...log, `h:${id}`] } : { hand, log }) };
  }
  if (!r.models) return { ...st, view: "line", models: null, msg: r.msg, line: { ...lv, ...(r.chosen ? { chosen: r.chosen, allows: r.allows } : {}) } };
  return { ...st, models: r.models, msg: r.msg };
}
