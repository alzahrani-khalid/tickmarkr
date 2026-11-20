// The fleet screen, as pure functions: frame() draws it as lines of styled segments, press() turns
// a key into the next state and at most one action for the caller. Home is the one screen of
// one-screen.ts (row 499; D-2187 add.363); `fleet --plain` prints it too (plainOne), every section and every item.
// The Ink mount, `fleet --plain` and the tests all drive these two functions.
import { basename, dirname } from "node:path";
import { loadConfigWithMode } from "../config/config.js";
import { SHAPES, type Shape } from "../graph/schema.js";
import { sliceCells } from "../tui/cockpit/width.js";
import { cap, clean, clip, fit, type Line, pct, S, type Seg, type Style, width, wrap } from "./draw.js";
import { applyEdits, combineEdits, type Edit, type Layer, type Texts } from "./edits.js";
import { label, review, saveBody, fileLines, saveKeys, saveWindow } from "./save-view.js";
import { type FloorChoice, floorOf, type HandChoice, handEdits, handLines, namesOf, TIER_LINE } from "./hand.js";
import { cliAt, levelOf, cursorAt, modelColumns, modelsKey, type ModelsState, modelsFrame, modelsLayout, modelsPress } from "./models-view.js";
import { lineParts, lineSlots, lineTargets, type LineViewInput } from "./line-view.js";
import { keptView, type Other, OTHER, otherParts, otherSlots } from "./hand-view.js";
import { ruleList } from "./rules.js";
import { keptOut } from "./kept.js";
import { lineOf } from "./lines.js";
import { itemLayout, type ItemViewInput } from "./item-view.js";
import { cursorTargets, oneScreen, type OneScreenInput, type Pending, smallScreen, tiny } from "./one-screen.js";
import { SAMPLE, STALE_DAYS, buildFleetModel, splitKey, evidenceAgeDays, type FleetInputs, type FleetModel } from "./model.js";
import { type Need, needs, type NeedsContext, needSignature } from "./needs.js";

export type { Line, Seg, Style } from "./draw.js";
/** `paths` are where the two layers are written; `labels` are how the screen names them. */
export interface ScreenSource {
  inputs: FleetInputs; ctx: NeedsContext; paths: Record<Layer, string>; labels?: Record<Layer, string>;
  /** Set in a linked worktree with no config of its own: the main checkout's file the repo layer was read from. A save never writes there. */
  inherited?: string;
}
/** The file a layer was READ from: in a linked worktree with no config of its own, the main checkout's. */
export const readFrom = (src: ScreenSource, layer: Layer): string => (layer === "repo" && src.inherited) || src.paths[layer];
const readLabel = (src: ScreenSource, layer: Layer): string => (layer === "repo" && src.inherited) || label(src, layer);
/**
 * `sel` is the one cursor of the one screen: a place of cursorTargets(), over the mode, every WORKERS
 * row, judge, review, consult, every KEPT OUT row and its + row, then every item (row 499; D-2187
 * add.363). `log` is what was done, in order, for `u`: "y:<id>", "n:<the signature a no is remembered
 * by>" or "h:<the line changed by hand>". `hand` holds the lines changed by hand, one choice a line, in
 * the order they were made; `item` the item opened; `rule` the KEPT OUT rule opened; `choose` the one-row
 * choice of a shape when a row holds several. Every line of the one screen opens to a view of 2.27: a shape's
 * line, the judge, the review, the consult and the mode to `line`, a rule to `rule`, the + of KEPT OUT to the
 * models view in its keep-out form (rows 499, 500; D-2187 add.363); the 2.26.1 tick lists are gone.
 */
export interface ScreenState {
  sel: number; yes: string[]; view: "home" | "item" | "save" | "rule" | "line" | "models" | "help"; scroll: number; msg: string; log: string[];
  hand: HandChoice[];
  /** a KEPT OUT rule opened: its list (as KEPT OUT names it) and the entry (row 500) */
  rule?: { list: string; rule: string; at?: number } | null;
  /** the 2.26.1 tick list is gone (row 499); kept only so a caller that clears it (the Ink mount's q) still compiles */
  pick?: null;
  /** a shape's line opened (line-view.ts; rows 499, 501, 502; D-2187 add.363): its models as they stand, how they are given out, its bar, the cursor */
  line?: LineState | null;
  /** the models view opened from that line (models-view.ts; row 498; D-2187 add.363): its CLI, its model, its search */
  models?: ModelsState | null;
  item: string | null; choose: { ids: string[]; at: number } | null;
  /**
   * The yes an opened item's y staged: the item as the changes not saved asked it then, so what is staged is
   * exactly the AFTER YES the item showed, never the saved item's own edits (row 500; D-2187 add.363, add.421).
   */
  staged?: Record<string, Need>;
  /** the answers' merge order as it stood before a probe, so new probe results cannot reorder them (row 518; D-2187 add.439) */
  order?: string[];
  /** the save opened (5.7): true while `d` shows the file lines (row 499 (h); D-2187 add.363) */
  lines?: boolean;
}
type Way = "any" | "ordered" | "complexity";
/** What a line view is opened on: a shape; the judge, the review, the consult or the mode (5.4); `kept`, the + of KEPT OUT in the models view (5.5). */
export type LineId = Shape | Other | "kept";
const isShape = (id: string): id is Shape => (SHAPES as readonly string[]).includes(id);
export interface LineState { shape: LineId; chosen: string[]; mode: Way; floor?: FloorChoice; at: number; /** the first body row in view */ top?: number;
  /** models the models view added that were not allowed yet: allowed by name in the same save while they stay on the line (row 498) */
  allows?: string[] }
/** How a drawn line is given out, as the mode its pool is written in (a pin is one row in order). */
const WAY: Record<string, Way | undefined> = { complexity: "complexity", order: "ordered", any: "any" };
/** What was answered and changed by hand and not yet saved: carried through a probe, which reopens the screen. */
/** `staged`: the yes each opened item staged, carried whole so a probe keeps the very edits answered (row 500; D-2187 add.421). */
export interface Kept { yes: string[]; hand: HandChoice[]; staged?: Record<string, Need>; order?: string[] }
export type ScreenAction =
  | { kind: "quit"; unsaved: number } | { kind: "probe"; keep?: Kept } | { kind: "dismiss"; id: string } | { kind: "restore"; signature: string }
  | { kind: "save"; texts: Texts; touched: Layer[] };
export const initialScreen = (): ScreenState => ({ sel: 0, yes: [], view: "home", scroll: 0, msg: "", log: [], hand: [], line: null, item: null, choose: null });

export interface Derived {
  /** the loader's refusal of the config as it is: nothing is drawn as if it were true */
  error?: string;
  /** the config files that error is in: the ones that do not load on their own. None when each loads alone. */
  errorIn?: Layer[];
  base?: FleetModel; items: Need[]; said: Need[]; edits: Edit[];
  /** what the lines changed by hand write: each line's own edit, then every deny or allow list they change */
  hand: Edit[];
  /** the lines changed by hand, by id */
  changed: string[];
  /** the team with every yes applied; equals base when nothing is answered */
  full?: FleetModel; refused?: string; texts?: Texts & { touched: Layer[] };
}
/** Asked of the loader itself, one file at a time, so a line number in its message is a line of a named file. */
const brokenIn = (inputs: FleetInputs): Layer[] => (["repo", "user"] as const).filter((layer) => {
  try { loadConfigWithMode("/", layer === "repo" ? { repoOverlayText: inputs.repoText, userOverlayText: "" } : { userOverlayText: inputs.userText, repoOverlayText: "" }); return false; } catch { return true; }
});
/** Where a config that does not load is to be corrected, in a sentence. */
export function errorWhere(src: ScreenSource, layers: readonly Layer[] = []): string {
  const names = layers.map((l) => readLabel(src, l));
  return names.length === 1 ? `It is in ${names[0]}. Correct it there, then open fleet again.`
    : names.length ? `Neither file loads: ${names.join(" and ")}. Correct both, then open fleet again.`
    // (each file loads on its own: which one to change is not known, so both are named as places to look)
    : `Correct that value in ${readLabel(src, "repo")} or in ${readLabel(src, "user")}, then open fleet again.`;
}
/** The files to look in, as paths: the ones that do not load alone, or, when each does, both. */
export const errorFiles = (src: ScreenSource, layers: readonly Layer[] = []): string[] => (layers.length ? layers : (["repo", "user"] as const)).map((l) => readFrom(src, l));
/**
 * A file location, exactly: the cleaned path (what S() shows, nothing else) cut into rows of w cells,
 * never through the word-wrapper, which would fold its spaces (D-2187 add.247). A row never ends in a
 * space, which plain output trims: those spaces start the next row instead.
 */
export function pathRows(path: string, w: number): string[] {
  const out: string[] = [];
  let rest = clean(path);
  while (rest) {
    const cut = sliceCells(rest, Math.max(1, w));
    // (any whitespace, U+00A0 and U+3000 included: a run wider than the row is a row of its own, kept by plainScreen)
    const kept = cut.head.replace(/\s+$/u, "");
    const [row, tail] = kept && cut.tail ? [kept, cut.head.slice(kept.length) + cut.tail] : [cut.head, cut.tail];
    out.push(row);
    rest = tail;
  }
  return out;
}
/** The segments whose every character is shown, trailing whitespace included: a file location's rows. */
const exact = new WeakSet<Seg>();
/** A line as plain text: the frame's padding trimmed, never a character of a file location (D-2187 add.247). */
function plainLine(l: Line): string {
  let last = -1;
  l.forEach((s, i) => { if (exact.has(s)) last = i; });
  return last < 0 ? l.map((s) => s.text).join("").trimEnd() : l.slice(0, last + 1).map((s) => s.text).join("");
}
/** Where a config that does not load is to be corrected, as rows: words wrapped, each file's path on rows of its own. */
function errorWhereRows(src: ScreenSource, layers: readonly Layer[], w: number): Line[] {
  const names = layers.map((l) => readLabel(src, l));
  const [intro, files, outro] = names.length === 1 ? ["It is in:", names, "Correct it there, then open fleet again."]
    : names.length ? ["Neither file loads:", names, "Correct both, then open fleet again."]
    // (each file loads on its own: which one to change is not known, so both are named as places to look)
    : ["It is in one of these files:", [readLabel(src, "repo"), readLabel(src, "user")], "Correct that value there, then open fleet again."];
  const words = (t: string): Line[] => wrap(t, w).map((r): Line => [S("  "), S(r)]);
  return [...words(intro), ...files.flatMap((f) => pathRows(f, w).map((r): Line => { const seg = S(r, "bold"); exact.add(seg); return [S("  "), seg]; })), ...words(outro)];
}
/**
 * The loader's message as rows: one problem a row group, at most `max` problems, the rest counted.
 * The schema's "→ at path" line joins its problem; a YAML error keeps its sentence (it holds the line
 * and the column) and loses the code frame under it, which no wrapped row can draw.
 */
export function errorRows(error: string, w: number, max = 6): string[] {
  const problems = error.split("\n\n")[0].split("\n").filter((l) => l.trim())
    .reduce<string[]>((out, l) => (/^\s+→/.test(l) && out.length ? [...out.slice(0, -1), `${out.at(-1)} ${l.trim()}`] : [...out, l.replace(/:$/, "")]), []);
  const shown = problems.slice(0, max).flatMap((p) => wrap(p, w));
  return problems.length > max ? [...shown, `… and ${problems.length - max} more`] : shown;
}
/** The screen of a config that does not load, every row of it: wrapped, never cut. */
function errorBody(src: ScreenSource, d: Derived, cols: number): Line[] {
  return [[S("")], [S(" THE CONFIG DOES NOT LOAD", "fail")], [S("")], ...errorRows(d.error ?? "", cols - 4).map((t): Line => [S("  "), S(t, "fail")]), [S("")],
    // (a long path takes more rows; a body taller than the terminal scrolls)
    ...errorWhereRows(src, d.errorIn ?? [], cols - 4), [S("")],
    ...wrap("A run refuses to start on this config for the same reason. Nothing was changed.", cols - 4).map((t): Line => [S("  "), S(t, "dim")])];
}
const cache = new WeakMap<ScreenSource, { base?: FleetModel; error?: string; errorIn?: Layer[]; items: Need[]; full: Map<string, Pick<Derived, "full" | "refused" | "texts" | "edits" | "hand">> }>();
export function derive(src: ScreenSource, st: ScreenState): Derived {
  let c = cache.get(src);
  if (!c) {
    try { const base = buildFleetModel(src.inputs); c = { base, items: needs(base, src.ctx), full: new Map() }; }
    catch (e) { c = { error: e instanceof Error ? e.message : String(e), errorIn: brokenIn(src.inputs), items: [], full: new Map() }; }
    cache.set(src, c);
  }
  if (!c.base) return { error: c.error, errorIn: c.errorIn, items: [], said: [], edits: [], hand: [], changed: [] };
  const base = c.base;
  // a staged yes is kept whole even when the items asked no longer hold its id (a probe moved them): r keeps it (add.422)
  const said = [...c.items.filter((i) => st.yes.includes(i.id)).map((i) => st.staged?.[i.id] ?? i),
    ...st.yes.filter((id) => !c!.items.some((i) => i.id === id)).flatMap((id) => (st.staged?.[id] ? [st.staged[id]] : []))].filter((i) => i.edits)
    // after a probe the answers merge in the order they merged before it; answers given since follow in the items' order (row 518; D-2187 add.439)
    .map((i, k) => ({ i, k: st.order?.includes(i.id) ? st.order.indexOf(i.id) : (st.order?.length ?? 0) + k }))
    .sort((a, b) => a.k - b.k).map((x) => x.i);
  const choices = st.hand ?? [];
  const id = `${said.map((i) => (st.staged?.[i.id] ? `${i.id}=${JSON.stringify(i.edits)}` : i.id)).join("\u0000")}\u0001${JSON.stringify(choices)}`;
  let f = c.full.get(id);
  if (!f) {
    // a line changed by hand is the operator's exact choice: it is made on top of the answers, and
    // replaces whatever an answer would write in the same place
    const answered = combineEdits(base.cfg, said.flatMap((i) => i.edits ?? []));
    const hand = handEdits(base, choices, answered);
    const at = (e: Edit) => `${e.layer}|${e.path.join("\u0000")}`;
    const byHand = new Set(hand.map(at));
    const edits = [...answered.filter((e) => !byHand.has(at(e))), ...hand];
    if (!edits.length) f = { full: base, edits, hand };
    else {
      try {
        const texts = applyEdits(src.inputs, edits);
        f = { edits, hand, texts, full: buildFleetModel({ ...src.inputs, userText: texts.userText, repoText: texts.repoText, assume: said.flatMap((i) => i.assume ?? []) }) };
      } catch (e) { f = { edits, hand, full: base, refused: e instanceof Error ? e.message : String(e) }; }
    }
    // every set of ticks tried on an opened line is a team of its own, held whole: keep a few dozen, not all of a long session
    if (c.full.size >= 32) c.full.clear();
    c.full.set(id, f);
  }
  // the opened item is the item as NOW asks it, so n remembers what it shows; an item whose NOW form was
  // answered no is not shown again (row 500; D-2187 add.363, add.421)
  // the dismissal is read from the very item shown, its placeholder included, so a no takes it off at once (add.422)
  const now = f.full ?? base, dismissed = src.ctx.dismissed;
  // an n of this screen holds while its signature is remembered, though withdrawing its own yes changed NOW (add.422)
  const noIds = new Set(st.log.filter((e) => e.startsWith("n:") && dismissed?.has(e.slice(2))).map((e) => e.slice(2).split("\u0000")[0]));
  let items = dismissed?.size ? c.items.filter((i) => !noIds.has(i.id) && !dismissed.has(needSignature(shownItem(src, st, now, i)))) : c.items;
  if (st.view === "item" && st.item) items = items.map((i) => (i.id === st.item ? shownItem(src, st, now, i) : i));
  return { base, items, said, changed: choices.map((x) => x.line), ...f };
}
/** The items as a team asks them (its question and reasons), each team read once. */
const askedIn = new WeakMap<FleetModel, Need[]>();
const askedAt = (src: ScreenSource, M: FleetModel): Need[] => {
  if (!askedIn.has(M)) askedIn.set(M, needs(M, { ...src.ctx, dismissed: undefined }));
  return askedIn.get(M)!;
};
/**
 * An opened item as it is shown: as NOW (every change not saved applied, its own yes too) asks it; when NOW
 * asks it no more, the yes it was answered with, else the saved item with no yes (row 500; D-2187 add.421).
 */
function shownItem(src: ScreenSource, st: ScreenState, now: FleetModel, saved: Need): Need {
  return askedAt(src, now).find((n) => n.id === saved.id)
    ?? (st.yes.includes(saved.id) ? st.staged?.[saved.id] ?? saved : { ...saved, ...GONE, detail: [], edits: undefined, removes: undefined });
}
/** What an item NOW asks no more says: rendered, and remembered by n, as exactly this (row 500; D-2187 add.422). */
export const GONE = { title: "Asked of the saved config, before the changes not saved.", ask: "Nothing is left to do here: n or Esc." } as const;
/**
 * The yes an opened item stages: its edits as NOW asks them, added to those this item's earlier yes staged.
 * An edit it no longer shows is kept, never reverted; one it shows again replaces the earlier (row 500; D-2187 add.422).
 */
function restaged(item: Need, prior?: Need): Need {
  if (!prior?.edits || !item.edits) return item;
  const at = (e: Edit) => `${e.layer}|${e.path.join("\u0000")}`, mine = new Set(item.edits.map(at));
  return { ...item, edits: [...item.edits, ...prior.edits.filter((e) => !mine.has(at(e)))] };
}

/** A yes withdrawn (n or u) leaves the pre-probe merge order, so answering it again merges it as an answer given since (row 518). */
function unordered(st: ScreenState, id: string): ScreenState {
  const { order, ...rest } = st, left = order?.filter((x) => x !== id);
  return left?.length ? { ...rest, order: left } : rest;
}

/**
 * The screen as it reopens after a probe: what was answered and changed by hand before it is still
 * there, unsaved, as far as it still applies. A yes to an item the probe made go away, and a change
 * of a line that no longer exists, are dropped, and the note says how many.
 */
export function resumeScreen(src: ScreenSource, keep?: Kept): { state: ScreenState; note: string } {
  const d = derive(src, initialScreen());
  if (!keep || !d.base) return { state: initialScreen(), note: "" };
  // a staged yes carries its own edits, so it stays whether or not the new probe results still ask it (add.422)
  const yes = keep.yes.filter((id) => keep.staged?.[id]?.edits || d.items.some((n) => n.id === id && n.edits));
  const staged = Object.fromEntries(Object.entries(keep.staged ?? {}).filter(([id]) => yes.includes(id)));
  const lines = handLines(d.base), hand = keep.hand.filter((c) => c.line === "hardFrom" || c.line.startsWith(TIER_LINE) || lines.some((l) => l.id === c.line));
  // one answer carried alone has no keep.order, yet it still merged before any answer given since the probe (row 518)
  const order = (keep.order ?? yes).filter((id) => yes.includes(id));
  const state: ScreenState = { ...initialScreen(), yes, hand, ...(Object.keys(staged).length ? { staged } : {}), ...(order.length ? { order } : {}), log: [...yes.map((id) => `y:${id}`), ...hand.map((c) => `h:${c.line}`)] };
  const kept = pending(derive(src, state)), lost = keep.yes.length - yes.length + keep.hand.length - hand.length;
  return { state, note: [kept ? `${cap(kept)}: kept through the probe, not saved yet.` : "",
    lost ? `${lost} ${lost === 1 ? "no longer applies and was" : "no longer apply and were"} dropped.` : ""].filter(Boolean).join(" ") };
}

/** What is waiting to be saved, in words: "2 answered yes, 1 changed by hand". Empty when nothing is. */
const pending = (d: Derived): string => [d.said.length ? `${d.said.length} answered yes` : "", d.changed.length ? `${d.changed.length} changed by hand` : ""].filter(Boolean).join(", ");

/**
 * What the one screen draws (row 499; D-2187 add.363): the team with every change applied, the items,
 * KEPT OUT, and the changes not saved in the order made. Nothing here writes.
 */
function oneInput(src: ScreenSource, st: ScreenState, d: Derived, note = ""): OneScreenInput {
  const base = d.base as FleetModel, M = d.full ?? base;
  const pend: Pending[] = [];
  const seen = new Set<string>();
  for (const e of [...st.log, ...st.yes.map((id) => `y:${id}`), ...st.hand.map((c) => `h:${c.line}`)]) {
    const id = e.slice(2);
    if (seen.has(e) || !/^[yh]:/.test(e)) continue;
    seen.add(e);
    const item = e.startsWith("y:") && d.said.find((i) => i.id === id);
    if (item) pend.push({ kind: "yes", item });
    else if (!e.startsWith("h:") || !d.changed.includes(id)) continue;
    else if ((SHAPES as readonly string[]).includes(id)) {
      pend.push({ kind: "line", after: lineOf(M, id as Shape), before: lineOf(base, id as Shape) });
      // the line's change ends with each model it also allows, by name (row 498; D-2187 add.363)
      for (const k of st.hand.find((c) => c.line === id)?.allows ?? []) pend.push({ kind: "setting", label: "also allows", after: k, before: "not allowed", key: "routing.allow.models", marks: id });
    } else if (id.startsWith(TIER_LINE)) {
      const [a, m] = splitKey(id.slice(TIER_LINE.length));
      pend.push({ kind: "setting", label: "level", after: `${a}:${m} ${levelOf(M.cfg, a, m) ?? "none"}`, before: levelOf(base.cfg, a, m) ?? "no level", key: `tiers.${a}.models.${m}` });
    }
    // c: one setting for every line by complexity, and the pending change says so (rows 501, 502)
    else if (id === "hardFrom") pend.push({ kind: "setting", label: "very complex", after: `starts at ${M.cfg.routing.hardFrom}, for every line given out by complexity`,
      before: `starts at ${base.cfg.routing.hardFrom}`, key: "routing.hardFrom" });
    // a KEPT OUT list: one row for each rule kept out or removed, by name (5.6; row 500)
    else if (id.startsWith("deny.")) {
      const path = ["routing", ...id.split(".")], now = ruleList(M.cfg.routing, path), was = ruleList(base.cfg.routing, path);
      for (const r of was.filter((x) => !now.includes(x))) pend.push({ kind: "setting", label: "no longer kept out", after: r, before: "kept out", key: path.join(".") });
      for (const r of now.filter((x) => !was.includes(x))) pend.push({ kind: "setting", label: "kept out", after: r, before: "not kept out", key: path.join("."), marks: r });
    } else {
      const [a, b] = [M, base].map((X) => handLines(X).find((l) => l.id === id));
      const allows = st.hand.find((c) => c.line === id)?.allows ?? [];
      // an allowance-only change has no row of its own values: the line reads as it did, so only its allowances are said
      if (!allows.length || !same(a?.current ?? [], b?.current ?? [])) pend.push({ kind: "setting", label: id, after: a?.current.join(", ") || "nothing", before: b?.current.join(", ") || "nothing",
        ...(["judge", "review", "consult", "mode"].includes(id) ? { marks: id } : {}), ...((a ?? b) ? { key: (a ?? b)!.path.join(".") } : {}) });
      // the judge, the review and the consult name each model they also allow, as a shape's line does (rows 498, 499; D-2187 add.363)
      for (const k of allows) pend.push({ kind: "setting", label: "also allows", after: k, before: "not allowed", key: "routing.allow.models", marks: id });
    }
  }
  return { M, project: projectOf(src), items: d.items, yes: st.yes, kept: keptOut(M), pending: pend, cursor: st.sel, note };
}
const projectOf = (src: ScreenSource): string => basename(dirname(dirname(src.paths.repo)));
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A shape's line as its view stands, against the line without it (the config, the answers and the other
 * lines changed by hand): its choice, or null when it is as it was. The screen writes a line only in
 * mode complexity or ordered; a line saved as any keeps any only while its models are left as they are.
 */
function lineDraft(src: ScreenSource, st: ScreenState, lv: LineState): { rest: HandChoice[]; choice: HandChoice | null } {
  const rest = st.hand.filter((x) => x.line !== lv.shape), w = derive(src, { ...st, hand: rest }), W = (w.full ?? w.base) as FleetModel;
  const was = handLines(W).find((l) => l.id === lv.shape);
  if (!was) return { rest, choice: null };
  // the judge, the review, the consult and the mode are an order or a value: their models (or value) are the change
  if (!isShape(lv.shape)) {
    const allows = (lv.allows ?? []).filter((k) => lv.chosen.includes(k)), ticks = lv.chosen.length > 0 && !same(was.current, lv.chosen);
    return { rest, choice: ticks || allows.length ? { line: lv.shape, chosen: ticks ? [...lv.chosen] : [], ...(allows.length ? { allows } : {}) } : null };
  }
  const ticks = lv.chosen.length > 0 && lv.mode !== "any" && !(same(was.current, lv.chosen) && lv.mode === WAY[lineOf(W, lv.shape).givenOut]);
  const floored = lv.floor !== undefined && lv.floor !== floorOf(was);
  // a model the line names that the save must allow is a change on its own, while the model stays on the line (row 498)
  const allows = (lv.allows ?? []).filter((k) => lv.chosen.includes(k));
  if (!ticks && !floored && !allows.length) return { rest, choice: null };
  return { rest, choice: { line: lv.shape, chosen: ticks ? [...lv.chosen] : [], ...(ticks ? { mode: lv.mode } : {}), ...(floored ? { floor: lv.floor } : {}), ...(allows.length ? { allows } : {}) } };
}
/** What the line view draws: the team with the line's choice so far applied, the line as it then routes. */
function lineInput(src: ScreenSource, st: ScreenState, lv: LineState): { inp: LineViewInput; refused?: string } {
  const { rest, choice } = lineDraft(src, st, lv);
  const d = derive(src, { ...st, hand: choice ? [...rest, choice] : rest }), M = (d.full ?? d.base) as FleetModel;
  // (the other lines draw from M and their own rows: they have no line of a shape)
  return { inp: { M, line: isShape(lv.shape) ? lineOf(M, lv.shape) : (undefined as never), project: projectOf(src), cursor: lv.at }, refused: d.refused };
}
/** A line view's parts: a shape's (5.3, 5.4) or one of the other lines' (5.4). */
function partsOf(inp: LineViewInput, lv: LineState, at: number, note: string | undefined, cols: number) {
  return isShape(lv.shape) ? lineParts({ ...inp, cursor: at, note }, cols)
    : otherParts({ M: inp.M, id: lv.shape as Other, chosen: lv.chosen, project: inp.project, cursor: at, note }, cols);
}
/**
 * A shape's line at a size: its body, its footer (the note and the keys), the rows the body gets, the
 * first body row in view (`top`, kept in the state and clamped here) and the body row a cursor place
 * is drawn on. The body scrolls to its last line, prose after the last place included (D-2187 add.406).
 */
function lineWindow(src: ScreenSource, st: ScreenState, lv: LineState, cols: number, rows: number, msg = st.msg) {
  const { inp, refused } = lineInput(src, st, lv), note = [msg, refused].filter(Boolean).join(" ") || undefined;
  const parts = (at: number) => partsOf(inp, lv, at, note, cols);
  const p = parts(lv.at), keys = note ? partsOf(inp, lv, lv.at, undefined, cols).footer.length : p.footer.length;
  // a note too long for the foot is read in the body after its last row, and scrolls like it (D-2187 add.406)
  const inBody = p.footer.length > Math.floor(rows / 2);
  const body = inBody ? [...p.body, ...p.footer.slice(0, -keys)] : p.body, footer = inBody ? p.footer.slice(-keys) : p.footer;
  const h = Math.max(1, rows - footer.length), max = Math.max(0, body.length - h);
  const rowOf = (at: number) => parts(at).body.findIndex((r) => r.some((x) => x.selected));
  return { body, footer, h, max, top: Math.max(0, Math.min(lv.top ?? 0, max)), rowOf, inBody, noteAt: p.body.length };
}
/**
 * After a key that is not an arrow, the window as drawn: a note read in the body shows from its first
 * row; otherwise the cursor's row stays in view however many rows the note at the foot takes (add.406).
 */
function settle(src: ScreenSource, st: ScreenState, size: { cols: number; rows: number }): ScreenState {
  const lv = st.line!, w = lineWindow(src, st, lv, size.cols, size.rows), r = w.rowOf(lv.at);
  const top = w.inBody ? Math.min(w.noteAt, w.max) : r < 0 || (r >= w.top && r < w.top + w.h) ? w.top : Math.max(0, Math.min(w.max, r < w.top ? r : r - w.h + 1));
  return top === w.top ? st : { ...st, line: { ...lv, top } };
}
/** The line view in exactly `rows` rows: the body from `top`, the note and the keys always at the foot. */
function lineFrame(src: ScreenSource, st: ScreenState, lv: LineState, cols: number, rows: number): Line[] {
  const { body, footer, h, top } = lineWindow(src, st, lv, cols, rows);
  const shown = [...body.slice(top, top + h), ...Array.from({ length: Math.max(0, h - body.slice(top).length) }, (): Line => [S("")]), ...footer];
  return shown.slice(-rows).map((l) => clip(l, cols));
}
/** What each place of an opened shape's cursor is on, as its view draws it (line-view.ts lineTargets). */
export const lineHomeTargets = (src: ScreenSource, st: ScreenState): string[] => (!st.line ? [] : isShape(st.line.shape) ? lineTargets(lineInput(src, st, st.line).inp)
  : otherSlots({ id: st.line.shape as Other, chosen: st.line.chosen }).map((s) => (s.kind === "value" ? `value:${s.value}` : s.kind === "model" ? `model:${s.key}` : "add")));

/** The one-row choice of a row that opens several lines: which one, the cursor on it. */
const chooseRow = (c: NonNullable<ScreenState["choose"]>): string =>
  `open which? ${c.ids.map((id, i) => (i === c.at ? `▸ ${id}` : `  ${id}`)).join("  ")}   ↑↓ Enter · Esc back`;
/** `?`: every key of the one screen with its sentence (contract 5.2), and the three legend rows of 5.3. */
const HELP: Array<[string, string]> = [
  ["↑↓ k j", "move the cursor over the mode, the lines, KEPT OUT and the items"], ["Enter", "opens what the cursor is on: a line, or an item"],
  ["y n", "answer the item under the cursor: a yes joins NOT SAVED, a no is not asked again"], ["s", "opens the save; with nothing pending, Nothing to save."],
  ["u", "undoes the last answer or change"], ["r", "checks every model again, keeping what is not saved"], ["?", "this help"], ["q", "quits, saying what is not saved"],
];
const LEGEND = ["complexity = the 1-10 number a task gets when its spec is compiled", "score = Artificial Analysis Intelligence · price = list price per million tokens, in / out",
  `share = counted over ${SAMPLE} sample tasks, ${SAMPLE / 10} at each complexity`];

export interface TeamRow { section: "workers" | "gates" | "consult"; label: string; models: string[]; note?: string; status: string; style: Style }
/** YOUR TEAM as data: the workers by shape, the gates in their declared order, the consult. */
export function teamRows(M: FleetModel): TeamRow[] {
  const sim = M.sample();
  const rows: TeamRow[] = [];
  for (const shape of SHAPES) {
    const r = sim.rows[shape];
    // a floor lowered for this shape is met at that floor, not at the mode's: the line says which bar it is ok against
    const [status, style]: [string, Style] = r.unstaffed ? ["NO MODEL", "fail"] : r.under ? [`${pct(r.under)} below ${r.floor}`, "warn"] : M.lowered[shape] ? [`ok, floor ${M.lowered[shape].own}`, "ok"] : ["ok", "ok"];
    const models = r.shares.map((x) => x.key);
    // shapes the same models take, with the same status, share one line
    const g = rows.find((x) => x.status === status && [...x.models].sort().join() === [...models].sort().join());
    if (g) g.label += `, ${shape}`; else rows.push({ section: "workers", label: shape, models, status, style });
  }
  // a line that names most shapes names the few it leaves out instead, so the label is never cut
  for (const r of rows) {
    const named = r.label.split(", "), rest = SHAPES.filter((x) => !named.includes(x));
    if (!rest.length) r.label = "every shape";
    else if (r.label.length > 30 && rest.join(", ").length + 8 < r.label.length) r.label = `all but ${rest.join(", ")}`;
  }
  const judges = sim.judges.map((x) => x.key), reviewers = sim.reviewers.map((x) => x.key);
  const judgeDown = judges.length > 0 && !M.seat(judges[0])?.live.judge;
  // by count, not by the rounded share: three unreviewed tasks in 3,600 are not "ok"
  const routed = Math.max(1, sim.routed);
  const own = sim.ownVendor ? `${pct((100 * sim.ownVendor) / routed)} own vendor` : "", bare = sim.noReviewer ? `${pct((100 * sim.noReviewer) / routed)} unreviewed` : "";
  rows.push(
    { section: "gates", label: "build, test, lint", models: [], note: "your commands", status: "ok", style: "ok" },
    { section: "gates", label: "evidence, scope", models: [], note: "built in", status: "ok", style: "ok" },
    { section: "gates", label: "acceptance (judge)", models: judges.slice(0, 3),
      status: !judges.length ? "NO MODEL" : judgeDown ? "does not answer" : own || "ok", style: !judges.length || judgeDown ? "fail" : own ? "warn" : "ok" },
    { section: "gates", label: "review (another vendor)", models: reviewers.slice(0, 3),
      status: !reviewers.length ? "NO MODEL" : bare || "ok", style: !reviewers.length ? "fail" : bare ? "warn" : "ok" },
    // The overseer skill launches its orchestrator with `tickmarkr fleet --pick consult` and its checkers
    // with `--pick review`: with no consult model it cannot start.
    { section: "consult", label: "consult", models: M.consult ? [M.consult] : [], status: M.consult ? "ok" : "NO MODEL", style: M.consult ? "ok" : "fail" },
    { section: "consult", label: "overseer skill", models: [], note: M.consult ? "uses consult and review" : "needs the consult", status: M.consult ? "ok" : "CANNOT START", style: M.consult ? "ok" : "fail" },
  );
  return rows;
}

const SECTIONS: Record<TeamRow["section"], [string, string]> = {
  workers: [" WORKERS", "  who takes each shape of work"], gates: [" GATES", "  in order; the first five need no model"],
  consult: [" CONSULT", "  asked when a task stalls or the gates conflict"],
};
/**
 * The team, drawn to fit. Columns size themselves to the terminal's width. When the whole team would
 * leave no room for what needs the user (`room` lines), only the lines that are not ok are drawn,
 * under one line that counts the rest.
 */
function team(M: FleetModel, w: number, room: number): Line[] {
  const rows = teamRows(M);
  const stw = Math.min(21, Math.max(...rows.map((r) => r.status.length)) + 1);
  let lw = Math.min(34, Math.max(...rows.map((r) => r.label.length)) + 3);
  if (w - lw - stw - 1 < 10) lw = Math.max(12, w - stw - 11);
  const sw = Math.max(4, w - lw - stw - 1);
  const names = (keys: string[]): Line => {
    const out: Line = [];
    let used = 0, shown = 0;
    const called = namesOf(M, keys);
    for (const [i] of keys.entries()) {
      const n = called[i];
      if (shown && used + 3 + n.length + (shown < keys.length - 1 ? 3 : 0) > sw) break;
      if (shown) out.push(S(" · ", "dim"));
      out.push(S(n));
      used += n.length + (shown ? 3 : 0);
      shown++;
    }
    return shown < keys.length ? [...out, S(` +${keys.length - shown}`, "dim")] : out;
  };
  const draw = (r: TeamRow): Line => {
    const who: Line = r.note ? [S(r.note, r.style === "fail" ? undefined : "dim")] : r.models.length ? names(r.models) : [S("nobody", "fail")];
    return [S(fit(`  ${r.label}`, lw - 1), "bold"), S(" "), ...clip(who, sw), S(" "), S(fit(r.status, stw), r.style)];
  };
  if (rows.length + 3 > room) {
    // a line ok only against a floor set apart from the mode is drawn too (D12, amended): folded into the count, its mark would be lost
    const bad = rows.filter((r) => !r.status.startsWith("ok")), own = rows.filter((r) => r.status.startsWith("ok,"));
    const wrong = [...bad, ...own];
    const fits = Math.max(0, room - 1);
    // the floor notice comes first after YOUR TEAM: a row cut at any width loses what follows it, never the notice
    const floorNote = own.length ? `  ${own.length} on ${own.length === 1 ? "its" : "their"} own floor;` : "";
    const head = floorNote + (bad.length ? `  ${rows.length - bad.length} of ${rows.length} lines ok; these are not${own.length ? ", or have their own floor" : ""}:`
      : own.length ? `  all ${rows.length} lines ok; these have their own floor:` : `  all ${rows.length} lines ok`);
    return [[S(" YOUR TEAM", "head"), S(head, bad.length || own.length ? "dim" : "ok")],
      ...wrong.slice(0, wrong.length > fits ? Math.max(0, fits - 1) : fits).map(draw),
      ...(wrong.length > fits ? [[S(`  … ${wrong.length - Math.max(0, fits - 1)} more: a taller terminal shows them`, "dim")]] : [])];
  }
  const out: Line[] = [];
  let section = "";
  for (const r of rows) {
    if (r.section !== section) { section = r.section; out.push([S(SECTIONS[r.section][0], "head"), S(SECTIONS[r.section][1], "dim")]); }
    out.push(draw(r));
  }
  return out;
}

/**
 * The opened item (5.8; row 500; D-2187 add.363, add.420, add.421). NOW is the effective team, every change not
 * saved applied, this item's own yes included. The item shown and offered is the item as NOW asks it (derive):
 * its question, its reasons and its yes. AFTER YES is that yes staged on top of NOW, a line changed by hand
 * keeping its precedence: the very state y stages. It says a yes changes nothing more only when AFTER YES is
 * NOW. A change a hand edit already decides (its value AFTER YES is NOW's) is said as not made.
 */
function itemInput(src: ScreenSource, st: ScreenState, d: Derived): (ItemViewInput & { yes?: ScreenState }) | undefined {
  const at = d.base ? d.items.findIndex((i) => i.id === st.item) : -1;
  if (!d.base || at < 0) return undefined;
  const item = d.items[at], now = d.full ?? d.base, others = st.yes.filter((id) => id !== item.id);
  const yes = item.edits ? { ...st, yes: [...others, item.id], staged: { ...st.staged, [item.id]: restaged(item, d.said.find((i) => i.id === item.id)) } } : undefined;
  const cand = yes && derive(src, yes), after = cand && !cand.refused ? cand.full : undefined;
  const answered = !!after && st.yes.includes(item.id) && JSON.stringify(after.cfg) === JSON.stringify(now.cfg);
  const key = (e: Edit) => `${e.layer}|${e.path.join("\u0000")}`, byHand = new Set(d.hand.map(key));
  const val = (M: FleetModel, p: readonly string[]) => JSON.stringify(p.reduce<unknown>((c, k) => (c !== null && typeof c === "object" ? (c as Record<string, unknown>)[k] : undefined), M.cfg) ?? null);
  const held = (item.edits ?? []).filter((e) => byHand.has(key(e)) && (!after || val(now, e.path) === val(after, e.path))).map((e) => e.label);
  const asked = askedAt(src, now).some((n) => n.id === item.id);
  const given = st.yes.includes(item.id);
  return { item, gone: !asked, given, yes, place: at + 1, of: d.items.length, project: projectOf(src), before: now, after,
    answered, refused: cand?.refused, held, note: st.msg, scroll: st.scroll };
}

/** One frame: exactly `rows` lines of exactly `cols` cells. */
export function frame(src: ScreenSource, st: ScreenState, cols = 80, rows = 24, plain = false): Line[] {
  const d = derive(src, st);
  const M = d.full ?? d.base;
  // below 80 by 20 the one screen and every view it opens are one sentence (5.2); `--plain` is unchanged
  if (!plain && tiny(cols, rows)) return smallScreen(cols, rows);
  // home is the one screen; `plain` is the 2.26 text of plainScreen (the command prints plainOne: the one screen)
  if (d.base && st.view === "models" && st.line && st.models && !plain) return modelsFrame(lineInput(src, st, st.line).inp.M, st, st.line, st.models, cols, rows);
  if (d.base && st.view === "line" && st.line && !plain) return lineFrame(src, st, st.line, cols, rows);
  if (d.base && st.view === "rule" && st.rule && !plain) {
    const win = ruleWindow(d, st, cols, rows);
    if (win) return win.lines;
  }
  if (d.base && st.view === "save" && !plain) return saveFrame(src, st, d, cols, rows).lines;
  // an item opened with Enter (5.8; row 500; D-2187 add.363): the 2.26.1 details view is gone
  const opened = st.view === "item" && !plain ? itemInput(src, st, d) : undefined;
  if (opened) return itemLayout(opened, cols, rows).lines;
  if (d.base && (st.view === "home" || st.view === "item") && !plain) return oneScreen(oneInput(src, st, d, st.choose ? chooseRow(st.choose) : st.msg), cols, rows);
  // a message too long for one row takes a second one from the body, so its end is never cut off
  const said = st.msg ? wrap(st.msg, cols - 4) : [];
  const note = said.length > 2 ? [said[0], `${said[1]} …`] : said;
  const h = Math.max(3, rows - 3 - Math.max(0, note.length - 1));
  const out: Line[] = [];
  let body: Line[] = [];
  let keys: Array<[string, string]> = [["q", "quit"]];
  if (!d.base || !M) {
    out.push([S(" tickmarkr fleet", "bold"), S("  the config does not load", "fail")]);
    const all = errorBody(src, d, cols), max = Math.max(0, all.length - h);
    body = all.slice(Math.min(st.scroll, max), Math.min(st.scroll, max) + h);
    if (max) keys = [["↑↓", "scroll"], ["q", "quit"]];
  } else {
    const age = evidenceAgeDays(d.base);
    // a narrow terminal says the same in fewer words: the age of the probe is what a team rests on, and is never cut off
    out.push([S(cols < 80 ? " fleet" : " tickmarkr fleet", "bold"), S("  mode ", "dim"), S(M.mode.mode, "accent"),
      ...(d.base.hasProbe ? [S(cols < 80 ? `  ${M.working} working` : `  ${M.working} ${M.working === 1 ? "model" : "models"} working`, M.working ? undefined : "fail"),
        ...(age === undefined ? [] : [S(age < 1 ? " · probed today" : ` · probed ${Math.floor(age)} ${Math.floor(age) === 1 ? "day" : "days"} ago`, age > STALE_DAYS ? "warn" : "dim")])] : [S("  not probed yet", "warn")])]);
    if (st.view === "help") {
      // each key's sentence wraps beside its key, whole at 80 columns
      body = [[S(" KEYS", "bold")], ...HELP.flatMap(([k, t]) => wrap(t, cols - 12).map((r, i): Line => [S(`  ${fit(i ? "" : k, 8)}`, "bold"), S(r)])), [S("")], ...LEGEND.flatMap((t) => wrap(t, cols - 4).map((r): Line => [S("  "), S(r, "dim")]))];
      keys = [["Esc", "back"]];
    } else {
      const sel = Math.min(st.sel, Math.max(0, d.items.length - 1));
      // At 80 columns and wider a title too long for its row takes a second one: what is wrong is said to
      // its last word. (Narrower, an item stays two rows so that two items always fit; Enter opens it whole.)
      const titles = d.items.map((it, i) => { const t = cols >= 80 ? wrap(it.title, cols - 4 - String(i + 1).length) : [it.title]; return t.length > 2 ? [t[0], `${t[1].slice(0, -2)} …`] : t; });
      // ... and so does a question: "Add a, b, c, d as fallbacks for implement?" names every model it adds
      // (up to three rows: an instruction such as "add them to routing.allow …, then press r" is read to its last word)
      const asks = d.items.map((it) => { const t = cols >= 80 ? wrap(it.ask, cols - 5) : [it.ask]; return t.length > 3 ? [t[0], t[1], `${t[2].slice(0, -2)} …`] : t; });
      const tall = (i: number) => titles[i].length + asks[i].length;
      // The selected item is shown whole — its title rows and every question row, up to three — in any
      // frame that can hold it once the team gives up rows, however many items there are. One item used
      // to keep two rows, so a four-row question was cut. The pending count shares the NEEDS YOU line
      // (and the footer); it is not a row of its own. A question is cut only when the frame cannot hold
      // the item even with the team at its smallest, and that cut ends in " …".
      const reserve = Math.min(4, 2 * d.items.length || 1);
      const selectedRows = d.items.length ? tall(sel) : 0;
      body = [...team(M, cols, h - 2 - Math.max(reserve, selectedRows)), [S("")], [S(` NEEDS YOU (${d.items.filter((i) => !st.yes.includes(i.id)).length})`, "head"), ...(pending(d) ? [S(`  ${pending(d)}`, "ok")] : [])]];
      if (!d.items.length) body.push([S("  Nothing. Every shape, gate and the consult has a working model.", "ok")]);
      const rowsFor = (f: number, avail: number) => { let used = 0, n = 0; for (let i = f; i < d.items.length && used + tall(i) <= avail; i++) { used += tall(i); n++; } return n; };
      const two = Math.max(1, Math.floor((h - body.length) / 2));
      let from = Math.max(0, Math.min(sel - two + 1, d.items.length - two));
      while (from < sel && from + rowsFor(from, h - body.length) <= sel) from++;
      const room = Math.max(1, rowsFor(from, h - body.length));
      d.items.slice(from, from + room).forEach((it, k) => {
        const i = from + k, on = i === sel && !plain, yes = st.yes.includes(it.id);
        const hint: Line = yes ? [S("          ✓ yes", "ok")] : !on ? [S("")] : it.edits ? [S(" y ", "key"), S(" yes ", "dim"), S(" n ", "key"), S(" no", "dim")] : [S("    "), S(" n ", "key"), S(" not now", "dim")];
        const mark = (line: Line): Line => (on ? line.map((s) => ({ ...s, selected: true })) : line);
        // a question cut by the rows left keeps the marked cut: its last row shown ends " …", never a silent drop
        const left = Math.max(1, h - body.length - titles[i].length);
        const ask = asks[i].length > left ? [...asks[i].slice(0, left - 1), `${asks[i][left - 1].slice(0, -2)} …`] : asks[i];
        body.push(...titles[i].map((t, n) => mark(clip([S(n ? "  " : on ? " ▸" : "  ", "accent"), S(n ? " ".repeat(String(i + 1).length + 2) : `${i + 1}  `, "dim"), S(t, yes ? "dim" : on ? "bold" : undefined)], cols))),
          // only a row that shows its keys or its answer gives up room for them
          // (a question too long to share the row keeps it whole: its keys are named on the screen's last row as
          // well, and an answer of yes is marked before the question instead of after it)
          ...((yes || on) && width(it.ask) + 5 <= cols - 17 ? [mark([...clip([S("     "), S(it.ask, yes ? "dim" : "accent")], cols - 17), ...clip(hint, 17)])]
            : ask.map((t, n) => mark(clip([yes && !n ? S("  ✓  ", "ok") : S("     "), S(t, yes ? "dim" : "accent")], cols)))));
      });
      if (d.items.length > from + room) body.push([S(`     … ${d.items.length - from - room} more below`, "dim")]);
      // (this branch draws only `--plain`, which prints no keys row)
    }
  }
  for (let i = 0; i < h; i++) out.push(body[i] ?? [S("")]);
  if (note.length) note.forEach((t, k) => out.push([S(k ? "   " : " ▌ ", "accent"), S(t, "bold")]));
  else out.push([S("")]);
  const gap = cols < 80 ? " " : "  ";
  // A narrow terminal loses hints, never the row's end: the keys to answer, save and quit stay named.
  // A key whose hint is dropped still works.
  const wide = (ks: Array<[string, string]>) => 1 + ks.reduce((n, [k, label]) => n + width(k) + width(label) + 3 + gap.length, 0);
  let shown = keys;
  for (const hint of ["scroll", "move", "order"]) if (wide(shown) > cols) shown = shown.filter(([, label]) => label !== hint);
  out.push([S(" "), ...shown.flatMap(([k, label]): Line => [S(` ${k} `, "key"), S(` ${label}${gap}`, "dim")])]);
  return out.slice(0, rows).map((l) => clip(l, cols));
}

/** The KEPT OUT rule opened, as the team with every pending change reads it; gone once x staged its removal. */
// by its place in its list, so a rule written twice opens its own occurrence and reason (row 500; D-2187 add.413)
const ruleOf = (d: Derived, r: { list: string; rule: string; at?: number }) => {
  const of = keptOut((d.full ?? d.base) as FleetModel).filter((x) => x.list === r.list), x = of[r.at ?? -1];
  return x?.rule === r.rule ? x : of.find((y) => y.rule === r.rule);
};
/**
 * One KEPT OUT list set to `next` as a pending change of its own (line `deny.<…>`), against the list without
 * this change: back to it, the change is withdrawn. The only writers are x on a rule's own line and the
 * keep-out form of the models view (rows 499, 500; D-2187 add.363; K2).
 */
function stageList(src: ScreenSource, st: ScreenState, id: string, next: readonly string[]): ScreenState {
  const rest = st.hand.filter((x) => x.line !== id), log = st.log.filter((e) => e !== `h:${id}`);
  const w = derive(src, { ...st, hand: rest }), W = (w.full ?? w.base) as FleetModel;
  if (same(ruleList(W.cfg.routing, ["routing", ...id.split(".")]), next)) return { ...st, hand: rest, log };
  return { ...st, hand: [...rest, { line: id, chosen: [...next] }], log: [...log, `h:${id}`] };
}
const listOf = (M: FleetModel, id: string): string[] => ruleList(M.cfg.routing, ["routing", ...id.split(".")]);
/**
 * A KEPT OUT rule opened at a size: its body from `st.scroll`, as much as the room holds, and the footer (the note and
 * x) always whole at the foot; `max` is the furthest the body scrolls, so a long reason never hides LIST or KEEPS OUT (row 500).
 */
function ruleWindow(d: Derived, st: ScreenState, cols: number, rows: number): { lines: Line[]; max: number } | null {
  const r = st.rule && ruleOf(d, st.rule);
  if (!r) return null;
  const M = (d.full ?? d.base) as FleetModel, note = st.msg || undefined;
  let v = keptView({ M, rule: r, note }, cols);
  if (v.body.length > rows - v.footer.length) v = keptView({ M, rule: r, note, more: true }, cols);
  const room = Math.max(1, rows - v.footer.length), max = Math.max(0, v.body.length - room), top = Math.min(Math.max(0, st.scroll), max);
  const shown = v.body.slice(top, top + room);
  return { lines: [...shown, ...Array.from({ length: Math.max(0, room - shown.length) }, (): Line => [S("")]), ...v.footer].slice(-rows).map((l) => clip(l, cols)), max };
}
/** A KEPT OUT rule opened: x removes that rule alone, as a pending change; ↑↓ PgUp PgDn scroll it; Esc goes back (5.4; row 500; K2). */
function ruleKey(src: ScreenSource, st: ScreenState, d: Derived, key: string, size: { cols: number; rows: number }): { state: ScreenState } {
  const back = { ...st, view: "home" as const, rule: null, scroll: 0 };
  const r = st.rule && ruleOf(d, st.rule);
  if (key === "esc" || !r) return { state: back };
  const step = { up: -1, down: 1, k: -1, j: 1, pgup: -(size.rows - 2), pgdown: size.rows - 2 }[key];
  if (step) {
    const max = ruleWindow(d, st, size.cols, size.rows)?.max ?? 0;
    return { state: { ...st, scroll: Math.max(0, Math.min(max, Math.min(st.scroll, max) + step)) } };
  }
  if (key !== "x") return { state: st };
  // x is the only way the one screen removes a rule: that entry alone, from its own list; nothing is written
  const id = r.list.replace(/^routing\./, ""), now = listOf((d.full ?? d.base) as FleetModel, id);
  // the opened occurrence of the entry: the n-th time it is written, n counted among the list's rules before it
  const of = keptOut((d.full ?? d.base) as FleetModel).filter((x) => x.list === r.list), occ = of.slice(0, of[st.rule!.at ?? -1]?.rule === r.rule ? st.rule!.at : 0).filter((x) => x.rule === r.rule).length;
  const i = now.findIndex((x, j) => x === r.rule && now.slice(0, j).filter((y) => y === r.rule).length === occ);
  return { state: { ...stageList(src, back, id, now.filter((_, j) => j !== i)), msg: `${r.rule} is no longer kept out, once saved. s shows what changes and saves it; u undoes.` } };
}
/**
 * The models view in its keep-out form (5.5; row 500): Enter on a model keeps it out of all work, Enter again out
 * of everything, Enter again lifts what this view added; on a CLI in the left column (reached with ←) the same for
 * the whole CLI. A rule that was there when the screen opened is left alone: Enter never removes one. Every other
 * key is the models view's own (letters search).
 */
function keepKey(src: ScreenSource, st: ScreenState, ms: ModelsState, d: Derived, key: string): ScreenState {
  const base = d.base as FleetModel, M = (d.full ?? base) as FleetModel;
  if (key === "esc" && !ms.query) return { ...st, view: "home", line: null, models: null };
  if (ms.onCli && key === "right") return { ...st, models: { ...ms, onCli: false } };
  if (!ms.onCli && key === "left") return { ...st, models: { ...ms, onCli: true } };
  if (key === "tab" || (ms.onCli && key === "left")) return st;
  if (key !== "enter") {
    // on the CLI column up and down move over the CLIs
    const r = modelsKey({ M, shape: "kept", chosen: [], allows: [], saved: base, state: ms }, ms.onCli && key === "up" ? "left" : ms.onCli && key === "down" ? "right" : key);
    return { ...st, models: r.models && { ...r.models, keep: true, ...(ms.onCli ? { onCli: true } : {}) }, msg: r.msg };
  }
  const cols = modelColumns(M, "kept", [], ms.query), cli = cols[cliAt(cols, ms)];
  const t = ms.onCli ? cli?.id : cli?.rows[cursorAt(cli.rows, ms)]?.key;
  if (!t) return st;
  const kind = ms.onCli ? "adapters" : "models", work = `deny.workers.${kind}`, all = `deny.${kind}`;
  if (listOf(base, work).includes(t) || listOf(base, all).includes(t))
    return { ...st, msg: `${t} is kept out by a rule that was there when the screen opened: it is left alone. x on its own line of KEPT OUT removes it.` };
  if (listOf(M, all).includes(t)) return { ...stageList(src, st, all, listOf(M, all).filter((x) => x !== t)), msg: `${t}: what this view added is lifted.` };
  if (listOf(M, work).includes(t)) {
    const next = stageList(src, st, work, listOf(M, work).filter((x) => x !== t));
    return { ...stageList(src, next, all, [...listOf(M, all), t]), msg: `${t} kept out of everything, not saved yet.` };
  }
  return { ...stageList(src, st, work, [...listOf(M, work), t]), msg: `${t} kept out of all work, not saved yet.` };
}

/** The save opened (5.7; row 499 (h); D-2187 add.363): its body, or with `d` the file lines, at a size; nothing here writes. */
function saveFrame(src: ScreenSource, st: ScreenState, d: Derived, cols: number, rows: number) {
  const refused = !!d.refused || !d.texts, lines = !!st.lines && !refused;
  const body = lines ? [[S("tickmarkr fleet", "bold"), S("  the file lines, as they are written", "dim")], [S("")], ...fileLines(src, d, cols)]
    : saveBody(src, d, oneInput(src, st, d).pending, projectOf(src), cols);
  return saveWindow(body, saveKeys(refused, lines), st.msg, cols, rows, st.scroll);
}

/** What each place of the home cursor is on, at this size: the one screen's cursorTargets (row 499; D-2187 add.363). */
export function homeTargets(src: ScreenSource, st: ScreenState, size: { cols: number; rows: number } = { cols: 80, rows: 24 }): string[] {
  const d = derive(src, st);
  return d.base ? cursorTargets(oneInput(src, st, d, st.msg), size.cols, size.rows) : [];
}

/** A key name: "up", "down", "enter", "esc", or one character. */
export function press(src: ScreenSource, st0: ScreenState, key: string, size: { cols: number; rows: number } = { cols: 80, rows: 24 }): { state: ScreenState; action?: ScreenAction } {
  const st: ScreenState = { ...st0, msg: "" };
  const d = derive(src, st);
  // the models view first: letters ALWAYS search there, q included (row 498; D-2187 add.363); Ctrl+C keeps its quit, and below 80 by 20 q still quits
  if (st.view === "models" && st.line && st.models?.keep && d.base && key !== "ctrl-c" && !tiny(size.cols, size.rows)) return { state: keepKey(src, st, st.models, d, key) };
  if (st.view === "models" && st.line && st.models && d.base && key !== "ctrl-c" && !tiny(size.cols, size.rows)) {
    // the team without any Tab level of this sitting: where a Tab round starts (row 515; D-2187 add.442)
    const answered = key === "tab" ? derive(src, { ...st, hand: st.hand.filter((c) => !c.line.startsWith(TIER_LINE)) }).full : undefined;
    const was = lineInput(src, st, st.line), next = modelsPress(was.inp.M, d.base, st, st.line, st.models, key, answered);
    // a level is announced only once the config it makes validates; a refusal is said in the view and nothing is staged (row 498; D-2187 add.408)
    if (next.hand !== st.hand && next.line) {
      const now = lineInput(src, next, next.line).refused;
      if (now && now !== was.refused) return { state: { ...st, msg: `Nothing was changed: the level would make a config tickmarkr refuses: ${now}` } };
    }
    // PgUp and PgDn scroll the message of the last key with the detail and legend, so they keep it; they stop at the last row
    if (key === "pgup" || key === "pgdown") next.msg = st0.msg;
    if (next.models?.foot) next.models.foot = Math.min(next.models.foot, modelsLayout(lineInput(src, next, next.line!).inp.M, next, next.line!, next.models, size.cols, size.rows).footMax);
    return { state: next };
  }
  if (key === "q" || key === "ctrl-c") return { state: st, action: { kind: "quit", unsaved: d.said.length + d.changed.length } };
  // below 80 by 20, in every view, no key but q does anything; what is pending is kept for the larger window
  if (tiny(size.cols, size.rows)) return { state: st0 };
  if (!d.base) {
    const max = Math.max(0, errorBody(src, d, size.cols).length - Math.max(3, size.rows - 3));
    if (key === "up" || key === "k") return { state: { ...st, scroll: Math.max(0, Math.min(st.scroll, max) - 1) } };
    if (key === "down" || key === "j") return { state: { ...st, scroll: Math.min(max, st.scroll + 1) } };
    return { state: st };
  }
  // a change that grows or shrinks the screen (NOT SAVED, an item answered) keeps the cursor on what it was on, or on `id`
  const stay = (r: { state: ScreenState; action?: ScreenAction }, id: string): { state: ScreenState; action?: ScreenAction } => {
    const ts = homeTargets(src, r.state, size), i = ts.indexOf(id);
    return !id || r.state.view !== "home" || ts[r.state.sel] === id || i < 0 ? r : { ...r, state: { ...r.state, sel: i } };
  };
  // an answer to one item: a yes joins NOT SAVED, a no is remembered (contract 5.2)
  const answer = (item: Need, next: Partial<ScreenState> = {}): { state: ScreenState; action?: ScreenAction } => {
    if (key === "y") {
      if (!item.edits) return { state: { ...st, msg: "This one is yours to do; then press r." } };
      // a yes from the home row stages the item as it was asked, as an opened item's y does, so a probe keeps the
      // very edits answered (row 518; D-2187 add.439)
      return { state: st.yes.includes(item.id) ? st : { ...st, ...next, yes: [...st.yes, item.id], log: [...st.log, `y:${item.id}`], staged: { ...st.staged, [item.id]: item } } };
    }
    return { state: { ...unordered(st, item.id), ...next, yes: st.yes.filter((x) => x !== item.id), log: [...st.log.filter((e) => e !== `y:${item.id}`), `n:${needSignature(item)}`],
      msg: "Left as it is: not asked again until something changes. u undoes." }, action: { kind: "dismiss", id: item.id } };
  };
  if (st.view === "save") {
    if (key === "esc") return { state: { ...st, view: "home", scroll: 0, lines: false } };
    const max = saveFrame(src, st, d, size.cols, size.rows).max;
    if (key === "up" || key === "k") return { state: { ...st, scroll: Math.max(0, Math.min(st.scroll, max) - 1) } };
    if (key === "down" || key === "j") return { state: { ...st, scroll: Math.min(max, st.scroll + 1) } };
    // d shows the file lines beside their numbers, and d again returns (5.7)
    if (key === "d" && !d.refused && d.texts) return { state: { ...st, lines: !st.lines, scroll: 0 } };
    // the save's own key is Enter (5.7), the one write: until it, both config files keep their bytes
    if (key === "enter" && !d.refused && d.texts) return { state: initialScreen(), action: { kind: "save", texts: { userText: d.texts.userText, repoText: d.texts.repoText }, touched: d.texts.touched } };
    return { state: st };
  }
  const M = d.full ?? d.base;
  if (st.view === "line" && st.line) return lineKey(src, st, st.line, key, d, size, st0.msg);
  if (st.view === "item") {
    // y adds it to NOT SAVED, n is remembered (it is not shown again), Esc leaves it for later (5.8)
    // the scroll limit is read from the frame drawn, its message included (row 500; D-2187 add.420)
    const item = d.items.find((i) => i.id === st.item), inp = itemInput(src, { ...st, msg: st0.msg }, d);
    if (!item || !inp || key === "esc") return { state: { ...st, view: "home", item: null, scroll: 0 } };
    // ↑↓ PgUp PgDn reach every row that does not fit: nothing of the item is cut (row 500; D-2187 add.363)
    const step = ({ up: -1, down: 1, k: -1, j: 1, pgup: -(size.rows - 4), pgdown: size.rows - 4 } as Record<string, number>)[key];
    if (step) {
      const { max, top } = itemLayout(inp, size.cols, size.rows);
      return { state: { ...st, msg: st0.msg, scroll: Math.max(0, Math.min(max, top + step)) } };
    }
    // y stages exactly the AFTER YES the item shows: the yes NOW asks, never the saved item's (row 500; D-2187 add.421)
    if (key === "y" && inp.yes) return stay({ state: { ...inp.yes, view: "home", item: null, scroll: 0, msg: "",
      log: st.yes.includes(item.id) ? st.log : [...st.log, `y:${item.id}`] } }, `item:${item.id}`);
    if (key === "y") return { state: { ...st, msg: "This one is yours to do; then press r." } };
    return key === "n" ? stay(answer(item, { view: "home", item: null, scroll: 0 }), `item:${item.id}`) : { state: st };
  }
  if (st.view === "help") return key === "esc" || key === "?" ? { state: { ...st, view: "home" } } : { state: st };
  if (st.view === "rule") return ruleKey(src, st, d, key, size);
  // a line opened as it stands: a shape's in its own view (5.3, 5.4), the judge, the review, the consult and the mode in theirs (5.4)
  const open = (id: string): ScreenState => {
    const l = handLines(M).find((x) => x.id === id);
    if (l && id in OTHER) {
      const had = st.hand.find((x) => x.line === id);
      return { ...st, choose: null, view: "line", line: { shape: id as Other, chosen: had?.chosen.length ? [...had.chosen] : [...l.current], mode: "ordered", at: 0,
        ...(had?.allows ? { allows: [...had.allows] } : {}) } };
    }
    if (l && isShape(id)) {
      // a pending choice of this line reopens as it was made: the drawn line cannot say "mode" when a bar
      // below the removed one shows through, and Esc must keep that choice, not rewrite or drop it
      const had = st.hand.find((x) => x.line === id), ticks = !!had?.chosen.length;
      return { ...st, choose: null, view: "line", line: { shape: id as Shape, chosen: ticks ? [...had!.chosen] : [...l.current],
        mode: (ticks && had!.mode) || (WAY[lineOf(M, id as Shape).givenOut] ?? "complexity"), floor: had?.floor ?? floorOf(l), at: 0, ...(had?.allows ? { allows: [...had.allows] } : {}) } };
    }
    return { ...st, choose: null };
  };
  if (st.choose) {
    const c = st.choose, end = c.ids.length - 1;
    if (key === "esc") return { state: { ...st, choose: null } };
    if (key === "up" || key === "k" || key === "left") return { state: { ...st, choose: { ...c, at: Math.max(0, c.at - 1) } } };
    if (key === "down" || key === "j" || key === "right") return { state: { ...st, choose: { ...c, at: Math.min(end, c.at + 1) } } };
    return key === "enter" ? { state: open(c.ids[c.at]) } : { state: st };
  }
  // The one screen (row 499; D-2187 add.363): ONE cursor over one list, the mode, every WORKERS row,
  // judge, review, consult, every KEPT OUT row and its + row, then every item. There is no second
  // list of lines to move over, and no key here writes: a change waits in NOT SAVED for the save.
  const targets = homeTargets(src, st, size);
  // below 80 by 20 no key but q (and a resize) does anything; what is pending is kept
  if (!targets.length) return { state: st0 };
  const at = Math.max(0, Math.min(st.sel, targets.length - 1)), on = targets[at];
  if (key === "up" || key === "k") return { state: { ...st, sel: Math.max(0, at - 1) } };
  if (key === "down" || key === "j") return { state: { ...st, sel: Math.min(targets.length - 1, at + 1) } };
  // a probe reopens the screen: what is answered and changed and not yet saved goes with it
  if (key === "r") return { state: st, action: { kind: "probe", keep: { yes: st.yes, hand: st.hand, ...(st.staged ? { staged: st.staged } : {}), ...(d.said.length > 1 ? { order: d.said.map((i) => i.id) } : {}) } } };
  if (key === "?") return { state: { ...st, view: "help" } };
  if (key === "s") return d.said.length || d.changed.length ? { state: { ...st, view: "save", scroll: 0, lines: false } } : { state: { ...st, msg: "Nothing to save." } };
  if (key === "u") {
    // the last answer, yes or no; a state built without a log still undoes its last yes
    const last = st.log.at(-1) ?? (st.yes.length ? `y:${st.yes.at(-1)}` : undefined);
    if (!last) return { state: st };
    const log = st.log.slice(0, -1);
    if (last.startsWith("y:")) return stay({ state: { ...unordered(st, last.slice(2)), log, yes: st.yes.filter((x) => x !== last.slice(2)), msg: "Last yes undone." } }, on);
    if (last.startsWith("h:")) return stay({ state: { ...st, log, hand: st.hand.filter((x) => x.line !== last.slice(2)), msg: "Last change by hand undone." } }, on);
    return { state: { ...st, log, msg: "Last no undone: it is asked again." }, action: { kind: "restore", signature: last.slice(2) } };
  }
  const item = on.startsWith("item:") ? d.items.find((i) => i.id === on.slice(5)) : undefined;
  if (key === "y" || key === "n") {
    if (!item) return { state: { ...st, msg: "y and n answer an item: move the cursor down to NEEDS YOU." } };
    // a yes moves on to the next item; a no takes its item off the list, so the cursor is on the next already
    const next = key === "y" ? targets.find((t, i) => i > at && t.startsWith("item:")) : undefined;
    return key === "y" ? stay(answer(item), next ?? on) : answer(item);
  }
  // a place that shows no ▸ (a page of NOT SAVED, a later page of a taller row) opens nothing
  if (key !== "enter" || !on) return { state: st };
  if (item) return { state: { ...st, view: "item", item: item.id, scroll: 0 } };
  if (on.startsWith("shapes:")) {
    const ids = on.slice(7).split(",");
    return { state: ids.length > 1 ? { ...st, choose: { ids, at: 0 } } : open(ids[0]) };
  }
  // a KEPT OUT row opens its rule: `kept:<list>#<n>` is the list's n-th rule (row 500)
  if (on.startsWith("kept:")) {
    const [list, n] = on.slice(5).split("#"), nth = Number(n ?? 0);
    const r = keptOut(M).filter((x) => x.list === list)[nth];
    return { state: r ? { ...st, view: "rule", rule: { list, rule: r.rule, at: nth }, scroll: 0 } : st };
  }
  // + opens the models view in its keep-out form (5.5; row 500)
  if (on === "kept+") return { state: { ...st, view: "models", line: { shape: "kept", chosen: [], mode: "ordered", at: 0 }, models: { cli: 0, at: 0, query: "", keep: true } } };
  return { state: open(on) };
}

/**
 * The keys of a shape's line opened (contract 5.3, 5.4; rows 499, 501, 502; D-2187 add.363). Up and down
 * move over the choices, the model rows and + ; Enter on a choice selects it, on a model row by complexity
 * removes it (never the last); x removes a row, [ ] move one in my order; c raises hardFrom for every line
 * by complexity, as a change of its own; f moves the shape's bar. Esc keeps the choices as one pending
 * change of the line; a line left as it was is none. No key here writes a file.
 */
function lineKey(src: ScreenSource, st: ScreenState, lv: LineState, key: string, d: Derived, size: { cols: number; rows: number }, shown: string): { state: ScreenState; action?: ScreenAction } {
  const { inp } = lineInput(src, st, lv);
  const targets = isShape(lv.shape) ? lineSlots(inp) : otherSlots({ id: lv.shape as Other, chosen: lv.chosen }), way = isShape(lv.shape) ? inp.line.givenOut : undefined;
  const at = Math.max(0, Math.min(lv.at, targets.length - 1)), on = targets[at];
  const put = (next: Partial<LineState>, msg = ""): { state: ScreenState } => ({ state: settle(src, { ...st, line: { ...lv, at, ...next }, msg }, size) });
  // up and down move to the next place in view; with none in view the body pages, so every row of it,
  // the prose after the last place included, is reached and the keys stay at the foot (D-2187 add.406)
  if (key === "up" || key === "k" || key === "down" || key === "j") {
    // a note read in the body stays while the arrows scroll through it; a note at the foot goes
    const wn = lineWindow(src, st, lv, size.cols, size.rows, shown), keep = wn.inBody ? shown : "";
    const w = keep ? wn : lineWindow(src, st, lv, size.cols, size.rows, ""), dir = key === "up" || key === "k" ? -1 : 1;
    const put = (next: Partial<LineState>): { state: ScreenState } => ({ state: { ...st, line: { ...lv, at, ...next }, msg: keep } });
    const next = at + dir, r = next >= 0 && next < targets.length ? w.rowOf(next) : -1;
    const seen = (top: number) => r >= 0 && r >= top && r < top + w.h;
    if (seen(w.top)) return put({ at: next, top: w.top });
    // the next place is above or below the window: page towards it, never past the body's ends
    const top = Math.max(0, Math.min(w.max, w.top + dir * Math.max(1, w.h - 1)));
    if (top !== w.top) return put({ top, ...(seen(top) ? { at: next } : {}) });
    return r >= 0 ? put({ at: next, top: dir < 0 ? Math.min(top, r) : Math.max(top, r - w.h + 1) }) : put({ top });
  }
  if (key === "esc") {
    const { rest, choice } = lineDraft(src, st, lv), had = st.hand.find((x) => x.line === lv.shape);
    const back = { ...st, view: "home" as const, line: null };
    if (choice && JSON.stringify(choice) === JSON.stringify(had)) return { state: back };
    const log = st.log.filter((e) => e !== `h:${lv.shape}`);
    if (!choice) return { state: { ...back, hand: rest, log, msg: had ? `${lv.shape} is back to what it was before you changed it.` : "" } };
    return { state: { ...back, hand: [...rest, choice], log: [...log, `h:${lv.shape}`], msg: `${lv.shape} changed. s shows what changes and saves it.` } };
  }
  if ((key === "f" || key === "c") && !isShape(lv.shape)) return put({});
  if (key === "f") {
    // the shape's bar, as it moved before: what the mode says, then cheap, mid, frontier
    const steps: FloorChoice[] = ["mode", "cheap", "mid", "frontier"], now = lv.floor ?? "mode";
    return put({ floor: steps[(steps.indexOf(now) + 1) % steps.length] });
  }
  if (key === "c") {
    if (way !== "complexity") return put({}, "c sets what counts as very complex for the lines given out by complexity; this line is not.");
    // ONE number for every line by complexity, from 10 back to 2; the pending change says so (rows 501, 502)
    const saved = (d.base as FleetModel).cfg.routing.hardFrom, cur = Number(st.hand.find((x) => x.line === "hardFrom")?.chosen[0] ?? saved);
    const next = cur >= 10 ? 2 : cur + 1, hand = st.hand.filter((x) => x.line !== "hardFrom"), log = st.log.filter((e) => e !== "h:hardFrom");
    if (next === saved) return { state: settle(src, { ...st, line: { ...lv, at }, hand, log, msg: `very complex starts at ${next} again, as saved.` }, size) };
    return { state: settle(src, { ...st, line: { ...lv, at }, hand: [...hand, { line: "hardFrom", chosen: [String(next)] }], log: [...log, "h:hardFrom"],
      msg: `very complex starts at ${next}, for every line given out by complexity.` }, size) };
  }
  // the cursor's place as a structure: a model id that ends in ":row:2" is a model, not a row number
  const model = on?.kind === "model" ? on : undefined;
  // the row's own position when it holds that key, else the key's first place (by complexity the rows are grouped, not written order)
  const indexOf = (m: { key: string; row: number }) => (lv.chosen[m.row] === m.key ? m.row : lv.chosen.indexOf(m.key));
  const asSaved = "Choose By complexity or My order first: a line saved before 2.27 keeps its models as it was saved.";
  const remove = (): { state: ScreenState } => {
    const k = model!.key, i = indexOf(model!);
    if (i < 0) return put({});
    // a line never loses its last model
    if (lv.chosen.length <= 1) return put({}, `A line never loses its last model: ${namesOf(inp.M, [k])[0]} stays.`);
    return put({ chosen: lv.chosen.filter((_, j) => j !== i), at: Math.min(at, targets.length - 2) });
  };
  // a place out of view in the frame as drawn (its note included) is not under the cursor: Enter, x, [ and ] do nothing there
  if (["enter", "x", "[", "]"].includes(key)) {
    const w = lineWindow(src, st, lv, size.cols, size.rows, shown), r = w.rowOf(at);
    if (r < w.top || r >= w.top + w.h) return { state: { ...st, msg: shown } };
  }
  // + allow a model, a row in my order, or a line with no model yet opens the models view (row 498)
  const models = (row?: number, next: Partial<LineState> = {}): { state: ScreenState } => ({ state: { ...st, view: "models", line: { ...lv, at, ...next }, models: { cli: 0, at: 0, query: "", ...(row !== undefined && row >= 0 ? { row } : {}) } } });
  // the judge, the review and the consult: an order (Enter picks the model for a row, + adds one, x removes,
  // [ ] move); the mode: Enter chooses a value (5.4; row 499)
  if (!isShape(lv.shape)) {
    if (key === "enter" && on?.kind === "value") return put({ chosen: [on.value] });
    if (key === "enter" && on?.kind === "add") return models();
    if (key === "enter" && model) return models(model.row);
    if (key === "x" && model) return remove();
    if ((key === "[" || key === "]") && model) {
      const i = model.row, j = i + (key === "[" ? -1 : 1);
      if (j < 0 || j >= lv.chosen.length) return put({});
      const chosen = [...lv.chosen];
      [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
      return put({ chosen, at: at + (j - i) });
    }
    return put({});
  }
  if (key === "enter") {
    if (on?.kind === "choice") {
      const c = on.choice;
      // the third choice is the line as saved; once left it is not offered again
      if (c === "any") return put({});
      if (!lv.chosen.length) return models(undefined, { mode: c === "order" ? "ordered" : "complexity" });
      return put({ mode: c === "order" ? "ordered" : "complexity" });
    }
    if (on?.kind === "add") return models();
    if (!model) return put({});
    if (way === "any") return put({}, asSaved);
    if (way === "order") return models(indexOf(model));
    return remove();
  }
  if (key === "x" && model) return way === "any" ? put({}, asSaved) : remove();
  if ((key === "[" || key === "]") && model && way === "order") {
    const i = indexOf(model), j = i + (key === "[" ? -1 : 1);
    if (i < 0 || j < 0 || j >= lv.chosen.length) return put({});
    const chosen = [...lv.chosen];
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
    return put({ chosen, at: at + (j - i) });
  }
  if ((key === "[" || key === "]" || key === "x") && model && way === "any") return put({}, asSaved);
  return put({});
}

/** The 2.26 review as text, however long (its suites read it); the command prints plainSave, the save of 5.7. */
export function plainReview(src: ScreenSource, yes: readonly string[], hand: readonly HandChoice[] = [], cols = 100): string {
  const d = derive(src, { ...initialScreen(), yes: [...yes], hand: [...hand] });
  return review(src, d, cols).map((l) => l.map((s) => s.text).join("").trimEnd()).join("\n").replace(/\n+$/, "");
}

/** The 2.26 YOUR TEAM and NEEDS YOU as text (its suites read it); the command prints plainOne, the one screen. */
export function plainScreen(src: ScreenSource, cols = 100): string {
  const d = derive(src, initialScreen());
  // room for every item at its tallest: a title and a question wider than the terminal take two rows each
  const rows = 3 + (d.base ? 13 + SHAPES.length + 4 * d.items.length : errorBody(src, d, cols).length);
  return frame(src, initialScreen(), cols, rows, true).slice(0, -1).map(plainLine).join("\n").replace(/\n+$/, "");
}

/**
 * `tickmarkr fleet --yes <id>…` and `--set`: the save of 5.7 as text, however long, then each file's changed
 * lines (its `d`). What is saved is never more than what this prints (rows 499, 502; D-2187 add.363).
 */
export function plainSave(src: ScreenSource, yes: readonly string[], hand: readonly HandChoice[] = [], cols = 100): string {
  const st = { ...initialScreen(), yes: [...yes], hand: [...hand] }, d = derive(src, st);
  const text = (ls: readonly Line[]) => ls.map((l) => l.map((s) => s.text).join("").trimEnd());
  const body = d.base ? text(saveBody(src, d, oneInput(src, st, d).pending, projectOf(src), cols)) : [];
  const files = d.texts && !d.refused ? ["", ...text(fileLines(src, d, cols))] : [];
  return [...body, ...files].join("\n").replace(/\n+$/, "");
}

/**
 * `tickmarkr fleet --plain`, and a run with no terminal: the one screen as text, every section and every
 * item, the cursor drawn on nothing; a config that does not load is said as on a terminal (row 499; D-2187 add.363).
 */
export function plainOne(src: ScreenSource, cols = 100): string {
  const d = derive(src, initialScreen());
  if (!d.base) {
    const rows = 3 + errorBody(src, d, cols).length;
    return frame(src, initialScreen(), cols, rows, true).slice(0, -1).map(plainLine).join("\n").replace(/\n+$/, "");
  }
  const inp = oneInput(src, initialScreen(), d);
  // the keys are for a terminal: a pipe has none to press; the blank rows above them are trimmed
  const at = (rows: number) => oneScreen(inp, cols, rows).slice(0, -1)
    .map((l) => l.map((x) => (x.selected && x.text === "▸ " ? "  " : x.text)).join("").trimEnd()).join("\n").replace(/\n+$/, "");
  // content-sized, never cut: a height the screen fits in draws the same as twice that height, and one it
  // overflows draws a "more below" row that twice the height does not
  let rows = 256, text = at(rows);
  for (let next = at(rows * 2); next !== text; next = at(rows * 2)) { rows *= 2; text = next; }
  return text;
}
