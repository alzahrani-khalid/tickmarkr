// An item of NEEDS YOU opened with Enter (queue row 500; D-2187 add.355, add.363; contract 5.8), as the
// design Item draws it: its place among the items, its question, what a yes removes (from where and why)
// or changes, BY NAME, what a yes leaves alone (every KEPT OUT rule in force, by name), who does the work
// after it, and its keys. It replaces the 2.26.1 details view. Pure: lines of styled segments.
import { SHAPES, type Shape } from "../graph/schema.js";
import { S, width } from "./draw.js";
import { keptOut, type KeptRule } from "./kept.js";
import { namesOf } from "./hand.js";
import { lineOf } from "./lines.js";
import type { FleetModel } from "./model.js";
import type { Need } from "./needs.js";
import { flow, nameIn, type OneLine, type OneSeg, savedNow, smallScreen, tiny, V, workerKeys } from "./one-screen.js";

export interface ItemViewInput {
  /**
   * The item as NOW asks it (its own yes left out): its question, its reasons and the yes it offers, the very
   * yes y stages (row 500; D-2187 add.421). When NOW asks it no more, the saved item with no yes, and `gone`.
   */
  item: Need;
  /** NOW asks this item no more */
  gone?: boolean;
  /**
   * this item is answered yes, in NOT SAVED: n withdraws that yes. When NOW asks it no more, the item's own
   * question describes the team before its yes, so the view draws NOW, the yes included, instead (row 518; D-2187 add.444)
   */
  given?: boolean;
  /** the item's place among the items shown: 1-based, and how many there are */
  place: number; of: number;
  project: string;
  /**
   * NOW, the effective team (the saved config with every change not saved applied, rules added and removed
   * by hand included), and AFTER YES, the team this item's yes makes from NOW, a hand's choice keeping its
   * precedence (absent for an item that has no yes). Every row of the item is read from these two and
   * nothing else: never the saved config, never the item's own data of it (row 500; D-2187 add.363, add.420).
   */
  before: FleetModel; after?: FleetModel;
  /** this item is answered yes and its yes changes nothing more: AFTER YES is NOW (row 500; D-2187 add.421) */
  answered?: boolean;
  /** the config the yes would make is refused: why (who does the work is then not known) */
  refused?: string;
  /** the labels of this item's changes a line changed by hand replaces: a yes does not make them */
  held?: readonly string[];
  /** one message, drawn on the row above the keys */
  note?: string;
  /** the first body row shown: what does not fit is reached with the arrows, never cut (row 500; D-2187 add.363) */
  scroll?: number;
}

const LABEL = 24;
const pad = (t: string, n: number): string => t + " ".repeat(Math.max(1, n - width(t)));
/** The design's keys row; an item with no yes cannot be said yes to (5.8). */
export const itemKeys = (item: Pick<Need, "edits">, given = false): string => (given
  ? "your yes is given · n withdraw it, and do not ask again for these · Esc later"
  : item.edits ? "y yes, added to NOT SAVED · n no, and do not ask again for these · Esc later" : "n not now · Esc later");

/** Who does the work after a yes (5.8, from the routed sample): the same for every shape, or the shapes whose worker moves. */
export function whoWorks(before: FleetModel, after?: FleetModel, refused?: string, consult = false): string {
  if (refused) return `not known: tickmarkr refuses the config a yes would make: ${refused}`;
  if (!after) return "the same for every shape";
  const a = before.sample(), b = after.sample();
  const moved = SHAPES.filter((s) => a.rows[s].picks.some((p, n) => p[0] !== b.rows[s].picks[n]?.[0]));
  const shapes = moved.length ? `changes for ${moved.join(", ")}` : "the same for every shape";
  // the consult after the yes, when the yes writes it or moves it (row 500; D-2187 add.420)
  if (!consult && before.consult === after.consult) return shapes;
  return `${shapes}; the consult: ${after.consult ? after.name(after.consult) : "nobody, so a stalled task goes straight to you"}`;
}
/** A row of what a yes leaves alone: every rule of KEPT OUT in force, by name, never a count (row 500; D-2187 add.363). */
export const neverTouches = (kept: readonly KeptRule[]): OneSeg[] => (kept.length
  ? [S("KEPT OUT: "), V([...new Set(kept.map((r) => r.rule))].join(", "))] : [S("nothing is kept out")]);

/** The names a line holds in a team: its pool, or its pin. */
const channels = (M: FleetModel, s: Shape): string[] => {
  const slot = M.cfg.routing.map[s];
  return slot?.pool?.channels ?? (slot?.pin ? [`${slot.pin.via}:${slot.pin.model}`] : []);
};

/** Who gets a line's tasks in a team, and who gets none with its reason (K6), read from the line as it routes. */
export function allocation(M: FleetModel, s: Shape): string {
  const l = lineOf(M, s), n = (x: number) => x.toLocaleString("en-US");
  // names as contract 5.1 gives them: two CLIs offering a model of the same name are told apart by CLI, read
  // against every model the team knows, so NOW and AFTER YES name the same model the same way (row 518; D-2187 add.442)
  const keys = [...new Set([...M.seats.map((x) => `${x.adapter}:${x.model}`), ...channels(M, s)])], names = namesOf(M, keys);
  const name = (k: string) => { const i = keys.indexOf(k); return i >= 0 ? names[i] : namesOf(M, [...keys, k])[keys.length]; };
  if (l.groups) {
    const ms = l.groups.flatMap((g) => g.models);
    return ms.length ? ms.map((m) => `${name(m.key)} gets ${m.share.n ? n(m.share.n) : "none"}`).join("; ") : "nobody gets its tasks";
  }
  const o = l.order;
  if (o?.gets || o?.none) {
    const said = [...(o.gets ?? []).map((x) => `${name(x.key)} gets ${n(x.n)}`), ...(o.none ?? []).map((x) => `${name(x.key)} gets none${x.reason ? `: ${x.reason}` : ""}`)];
    return said.length ? said.join("; ") : "nobody gets its tasks";
  }
  if (o) return o.works ? `${name(o.works)} gets every task` : "nobody gets its tasks";
  return "open to the whole team";
}

/** A config value at a path. */
const at = (obj: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((cur, seg) => (cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined), obj);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** What a path holds in a team: a shape's line as the one screen routes it (savedNow), else its value. */
const said = (M: FleetModel, path: readonly string[]): string => {
  const s = path[2] as Shape;
  if (path[0] === "routing" && path[1] === "map" && path.length === 3 && (SHAPES as readonly string[]).includes(s)) {
    const l = lineOf(M, s);
    return `${s}: ${savedNow(nameIn(M, workerKeys(l)), l).map((x) => x.text).join("").trim()}`;
  }
  const v = at(M.cfg, path);
  return `${path.join(".")}: ${v === undefined ? "nothing" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)}`;
};
const FROM_NOW = "the changes not saved give no reason to remove it";

/**
 * The body rows of the opened item, before they are fitted to a window. Every row of what a yes does is the
 * difference between NOW and AFTER YES, read by the one screen's own functions (lineOf, savedNow, keptOut):
 * never the saved config, never the item's own data of it (row 500; D-2187 add.363, add.420).
 */
export function itemRows(inp: ItemViewInput, w: number): { head: OneLine[]; changes: OneLine[]; tail: OneLine[] } {
  const { item } = inp;
  // the question is NOW's own, asking exactly the yes y stages; an item NOW asks no more promises nothing (row 500; D-2187 add.421)
  // (the item NOW asks no more arrives as its placeholder, the very content n remembers: screen.ts GONE; add.422)
  // answered yes and asked no more by NOW: the item's own words describe the team before its yes, so NOW is drawn (row 518; D-2187 add.444)
  const done = !!inp.given && !!inp.gone;
  const q: Pick<Need, "title" | "ask" | "detail"> = done
    ? { title: "You said yes: it is in NOT SAVED.", ask: "The team now, with your yes, is below. n withdraws your yes.", detail: [] } : item;
  const row = (segs: OneSeg[], indent = 2): OneLine[] => flow(segs, w, indent);
  const blank = (): OneLine[] => flow([], w, 0);
  const head = [...row([S("tickmarkr fleet", "bold"), S("  "), V(inp.project, "dim")], 0), ...blank(),
    ...row([S("NEEDS YOU", "head"), S(`  ${inp.place} of ${inp.of}`, "dim")], 0), ...blank(),
    ...row([S("  "), S(q.title, "bold")], 2), ...row([S("  "), S(q.ask, "accent")], 2),
    ...(done ? [] : inp.answered ? row([S("  "), S("You said yes: it is in NOT SAVED, and a yes again changes nothing more. n withdraws your yes.", "dim")], 2)
      : inp.given ? row([S("  "), S("You said yes before: it is in NOT SAVED. y adds what is asked now; n withdraws your yes.", "dim")], 2)
      : inp.gone ? row([S("  "), S("With the changes not saved this is no longer asked.", "warn")], 2) : [])];
  const changes: OneLine[] = [];
  const { before: now, after } = inp;
  const made = (item.edits ?? []).filter((e) => !inp.held?.includes(e.label));
  if (done) {
    // each place the yes wrote, as NOW holds it; a shape's line also says who gets its tasks NOW
    const paths = [...new Map((item.edits ?? []).map((e) => [e.path.join("\u0000"), e.path])).values()];
    if (paths.length) changes.push(...blank(), ...row([S("  "), S("NOW, WITH YOUR YES", "dim")], 2));
    for (const p of paths) {
      changes.push(...row([S("  "), V(said(now, p))], 4));
      const s = p[2] as Shape;
      if (p[1] === "map" && p.length === 3 && (SHAPES as readonly string[]).includes(s)) changes.push(...row([S("    "), S(`now: ${allocation(now, s)}`, "dim")], 6));
    }
  } else if (!item.edits) {
    // no yes: what the item says to do is the user's; its reasons are shown as written
    changes.push(...blank(), ...q.detail.flatMap((t) => row([S("  "), S(t, "dim")], 2)));
  } else if (!after) {
    // the config a yes would make is refused: what the yes asks to write, as it asks it
    if (made.length) changes.push(...blank(), ...row([S("  "), S("A YES WOULD CHANGE", "dim")], 2), ...made.flatMap((e) => row([S("  "), V(e.label)], 4)));
  } else if (item.removes) {
    // the tidy item (K5): each name NOW holds on a line and AFTER YES does not, and why it cannot work, as NOW says
    const rm = new Map<string, Shape[]>();
    for (const s of SHAPES) for (const c of channels(now, s)) if (!channels(after, s).includes(c)) rm.set(c, [...(rm.get(c) ?? []), s]);
    if (rm.size) {
      const fw = Math.max(20, ...[...rm.values()].map((f) => width(f.join(", ")) + 2));
      changes.push(...blank(), ...row([S("  "), S(pad("A YES REMOVES", LABEL), "dim"), S(pad("FROM", fw), "dim"), S("WHY IT CANNOT WORK", "dim")], 2));
      for (const [what, from] of rm) changes.push(...row([S("  "), V(pad(what, LABEL)), S(pad(from.join(", "), fw)), S(item.removes.find((r) => r.what === what)?.why ?? FROM_NOW, "warn")], 2 + LABEL));
    }
  } else {
    // each place the yes changes: its own words where AFTER YES holds what it sets, else what AFTER YES holds;
    // a shape's line also says who gets its tasks NOW and AFTER YES, and who gets none, with the reason (K6)
    const moved = made.filter((e) => !same(at(now.cfg, e.path), at(after.cfg, e.path)));
    if (moved.length) changes.push(...blank(), ...row([S("  "), S("A YES CHANGES", "dim")], 2));
    for (const e of moved) {
      changes.push(...row([S("  "), V(same(at(after.cfg, e.path), e.value) ? e.label : `written with the changes not saved: ${said(after, e.path)}`)], 4));
      const s = e.path[2] as Shape;
      if (e.path[1] === "map" && e.path.length === 3 && (SHAPES as readonly string[]).includes(s)) {
        changes.push(...row([S("    "), S(`now: ${allocation(now, s)}`, "dim")], 6), ...row([S("    "), S(`after yes: ${allocation(after, s)}`, "dim")], 6));
      }
    }
  }
  // a change a line changed by hand replaces is not promised: the hand's choice is what is saved
  if (inp.held?.length) changes.push(...blank(), ...row([S("  "), S("NOT MADE: A LINE YOU CHANGED BY HAND KEEPS YOUR CHOICE", "dim")], 2),
    ...inp.held.flatMap((l) => row([S("    "), S(l, "dim")], 4)));
  const tail = [...blank(), ...row([S("  "), S(pad("A YES NEVER TOUCHES", LABEL), "dim"), ...neverTouches(keptOut(now))], 2 + LABEL),
    ...row([S("  "), S(pad("WHO DOES THE WORK", LABEL), "dim"), S(whoWorks(now, after, inp.refused, !inp.answered && made.some((e) => e.path[0] === "consult")))], 2 + LABEL)];
  return { head, changes, tail };
}

/**
 * The opened item at a size: its rows from `scroll`, as many as fit, and `max`, the furthest they scroll.
 * Nothing is cut: a row says how many rows are above or below and the arrows reach them (row 500; D-2187 add.363).
 */
export function itemLayout(inp: ItemViewInput, cols: number, rows: number): { lines: OneLine[]; max: number; top: number } {
  if (tiny(cols, rows)) return { lines: smallScreen(cols, rows), max: 0, top: 0 };
  const w = cols, h = rows;
  const { head, changes, tail } = itemRows(inp, w);
  const all = [...head, ...changes, ...tail];
  const note = inp.note ? flow([S(" ▌ ", "accent"), S(inp.note, "bold")], w, 3) : [];
  const keys = [...note, ...flow([S(itemKeys(inp.item, !!inp.given && (!!inp.answered || !!inp.gone)), "dim")], w, 0)];
  const room = Math.max(1, h - keys.length - 1);
  if (all.length <= room) {
    const fill = Array.from({ length: Math.max(0, h - keys.length - all.length) }, (): OneLine => [S(" ".repeat(w))]);
    return { lines: [...all, ...fill, ...keys].slice(0, h), max: 0, top: 0 };
  }
  // one row is the marker of what is above and below; the window is the rest
  const win = Math.max(1, room - 1), max = all.length - win, top = Math.min(Math.max(0, inp.scroll ?? 0), max);
  const above = top, below = all.length - top - win;
  const marker = flow([S(`    ${[above ? `↑ ${above} more above` : "", below ? `↓ ${below} more below` : ""].filter(Boolean).join(" · ")}: ↑↓ PgUp PgDn scroll`, "dim")], w, 4).slice(0, 1);
  const body = [...all.slice(top, top + win), ...marker];
  const fill = Array.from({ length: Math.max(0, h - keys.length - body.length) }, (): OneLine => [S(" ".repeat(w))]);
  return { lines: [...body, ...fill, ...keys].slice(0, h), max, top };
}

/** The opened item: exactly `rows` rows of exactly `cols` cells. */
export const itemView = (inp: ItemViewInput, cols: number, rows: number): OneLine[] => itemLayout(inp, cols, rows).lines;
