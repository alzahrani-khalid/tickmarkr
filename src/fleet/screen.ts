// The fleet screen, as pure functions: frame() draws it as lines of styled segments, press() turns
// a key into the next state and at most one action for the caller. YOUR TEAM in the product's own
// names, then NEEDS YOU. The Ink mount, `fleet --plain` and the tests all drive these two functions.
import { loadConfigWithMode } from "../config/config.js";
import { SHAPES, type Shape } from "../graph/schema.js";
import { sliceCells } from "../tui/cockpit/width.js";
import { cap, clean, clip, fit, fmt, type Line, pct, S, type Seg, type Style, width, wrap } from "./draw.js";
import { applyEdits, combineEdits, type Edit, layerDiff, type Layer, type Texts } from "./edits.js";
import { type FloorChoice, floorOf, type HandChoice, handEdits, handLines, namesOf } from "./hand.js";
import { linesView, pickView } from "./hand-view.js";
import { STALE_DAYS, buildFleetModel, consequence, evidenceAgeDays, type FleetInputs, type FleetModel } from "./model.js";
import { type Need, needs, type NeedsContext, needSignature } from "./needs.js";

export type { Line, Seg, Style } from "./draw.js";
/** `paths` are where the two layers are written; `labels` are how the screen names them. */
export interface ScreenSource {
  inputs: FleetInputs; ctx: NeedsContext; paths: Record<Layer, string>; labels?: Record<Layer, string>;
  /** Set in a linked worktree with no config of its own: the main checkout's file the repo layer was read from. A save never writes there. */
  inherited?: string;
}
const label = (src: ScreenSource, layer: Layer): string => src.labels?.[layer] ?? src.paths[layer];
/** The file a layer was READ from: in a linked worktree with no config of its own, the main checkout's. */
export const readFrom = (src: ScreenSource, layer: Layer): string => (layer === "repo" && src.inherited) || src.paths[layer];
const readLabel = (src: ScreenSource, layer: Layer): string => (layer === "repo" && src.inherited) || label(src, layer);
/**
 * `log` is what was done, in order, for `u`: "y:<id>", "n:<the signature a no is remembered by>" or
 * "h:<the line changed by hand>". `hand` holds the lines changed by hand, one choice a line, in the
 * order they were made; `line` is the cursor in the list of lines; `pick` is the line being changed
 * and what is ticked.
 */
export interface ScreenState {
  sel: number; yes: string[]; view: "home" | "detail" | "review" | "lines" | "pick"; scroll: number; msg: string; log: string[];
  hand: HandChoice[]; line: number; pick: { line: string; chosen: string[]; at: number; mode?: "any" | "ordered"; floor?: FloorChoice } | null;
}
/** What was answered and changed by hand and not yet saved: carried through a probe, which reopens the screen. */
export interface Kept { yes: string[]; hand: HandChoice[] }
export type ScreenAction =
  | { kind: "quit"; unsaved: number } | { kind: "probe"; keep?: Kept } | { kind: "dismiss"; id: string } | { kind: "restore"; signature: string }
  | { kind: "save"; texts: Texts; touched: Layer[] };
export const initialScreen = (): ScreenState => ({ sel: 0, yes: [], view: "home", scroll: 0, msg: "", log: [], hand: [], line: 0, pick: null });

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
/** The screen of a config that does not load, every row of it: wrapped, never cut. */
function errorBody(src: ScreenSource, d: Derived, cols: number): Line[] {
  return [[S("")], [S(" THE CONFIG DOES NOT LOAD", "fail")], [S("")], ...wrap(d.error ?? "", cols - 4).map((t): Line => [S("  "), S(t, "fail")]), [S("")],
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
  const said = c.items.filter((i) => st.yes.includes(i.id) && i.edits);
  const choices = st.hand ?? [];
  const id = `${said.map((i) => i.id).join("\u0000")}\u0001${JSON.stringify(choices)}`;
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
  return { base, items: c.items, said, changed: choices.map((x) => x.line), ...f };
}

/**
 * On an opened shape, with the ticks and the mode as they stand: how many of that shape's sample
 * tasks each model takes, through the real router. What a tick does is seen before Enter, not found
 * out after. Counts, not shares: two rounded halves read 51% and 50%.
 */
function takes(src: ScreenSource, st: ScreenState): { n: Map<string, number>; of: number; today?: true } | undefined {
  const p = st.pick, d0 = derive(src, st), line = p && d0.base && handLines(d0.full ?? d0.base).find((l) => l.id === p.line);
  if (!p || !line?.mode || !d0.base) return undefined;
  const counts = (M: FleetModel) => { const row = M.sample().rows[p.line as Shape]; return { n: new Map(row.shares.map((s) => [s.key, s.n])), of: row.picks.length }; };
  // nothing ticked yet (a shape with no pool, just opened): who takes it as things stand
  if (!p.chosen.length) return { ...counts(d0.full ?? d0.base), today: true };
  const d = derive(src, { ...st, hand: [...st.hand.filter((x) => x.line !== p.line), { line: p.line, chosen: p.chosen, mode: p.mode ?? line.mode, floor: p.floor }] });
  return d.refused || !d.full ? undefined : counts(d.full);
}

/**
 * The screen as it reopens after a probe: what was answered and changed by hand before it is still
 * there, unsaved, as far as it still applies. A yes to an item the probe made go away, and a change
 * of a line that no longer exists, are dropped, and the note says how many.
 */
export function resumeScreen(src: ScreenSource, keep?: Kept): { state: ScreenState; note: string } {
  const d = derive(src, initialScreen());
  if (!keep || !d.base) return { state: initialScreen(), note: "" };
  const yes = keep.yes.filter((id) => d.items.some((n) => n.id === id && n.edits));
  const lines = handLines(d.base), hand = keep.hand.filter((c) => lines.some((l) => l.id === c.line));
  const state: ScreenState = { ...initialScreen(), yes, hand, log: [...yes.map((id) => `y:${id}`), ...hand.map((c) => `h:${c.line}`)] };
  const kept = pending(derive(src, state)), lost = keep.yes.length - yes.length + keep.hand.length - hand.length;
  return { state, note: [kept ? `${cap(kept)}: kept through the probe, not saved yet.` : "",
    lost ? `${lost} ${lost === 1 ? "no longer applies and was" : "no longer apply and were"} dropped.` : ""].filter(Boolean).join(" ") };
}

/** What is waiting to be saved, in words: "2 answered yes, 1 changed by hand". Empty when nothing is. */
const pending = (d: Derived): string => [d.said.length ? `${d.said.length} answered yes` : "", d.changed.length ? `${d.changed.length} changed by hand` : ""].filter(Boolean).join(", ");

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

function review(src: ScreenSource, d: Derived, w: number): Line[] {
  // what was answered and what was changed is said whole, on as many rows as it takes: a name cut off is a change not shown
  const whole = (mark: string, words: string): Line[] => wrap(words, w - 6).map((t, k): Line => [S(k ? "     " : mark, "dim"), S(t)]);
  const out: Line[] = [
    ...(d.said.length ? [[S(" YOU SAID YES TO", "head")], ...d.said.flatMap((i, n) => whole(`  ${n + 1}  `, i.title))] : []),
    ...(d.hand.length ? [[S(" YOU CHANGED BY HAND", "head")], ...d.hand.flatMap((e) => whole("  ·  ", e.label))] : []),
    [S("")]];
  if (d.refused || !d.base || !d.full || !d.texts) {
    return [...out, [S(" REFUSED: the config would not load, so nothing can be saved", "fail")], ...wrap(d.refused ?? "", w - 4).map((t) => [S("  "), S(t, "fail")])];
  }
  const cq = consequence(d.base, d.full);
  // A measure's number, and the word after it, are what the row is for: on a narrow terminal, or
  // beside a long value, they take their room from the padding after the label, never the reverse.
  const lead = (label: string, rest: string) => Math.max(width(label) + 3, Math.min(52, w - width(rest)));
  out.push([S(" WHAT CHANGES", "head"), S(`  every one of ${fmt(cq.total)} sample tasks routed before and after`, "dim")],
    [S(fit("  tasks that change worker", lead("tasks that change worker", `${fmt(cq.workers)} of ${fmt(cq.total)}`))), S(`${fmt(cq.workers)} of ${fmt(cq.total)}`, "bold")]);
  if (cq.judges || cq.reviewers) out.push([S(fit("  tasks that change judge or reviewer", lead("tasks that change judge or reviewer", `${fmt(cq.judges)} and ${fmt(cq.reviewers)}`))), S(`${fmt(cq.judges)} and ${fmt(cq.reviewers)}`, "bold")]);
  // A floor that was moved (for a shape, or by the mode) is not better or worse work: the same tasks,
  // measured against another bar. Those lines say so instead of praising a lowered floor.
  const moved = d.edits.some((e) => e.path[0] === "routing" && (e.path[1] === "floors" || e.path[1] === "mode"));
  for (const c of cq.changes) {
    const bar = moved && /floor/.test(c.label);
    const value = `${c.before} → ${c.after}`, word = bar ? "   the floor moved" : c.better ? "   better" : "   worse";
    out.push([S(fit(`  ${c.label}`, lead(c.label, value + word))), S(value, bar ? undefined : c.better ? "ok" : "fail"), S(word, bar ? "dim" : c.better ? "ok" : "fail")]);
  }
  out.push([S("")]);
  for (const layer of d.texts.touched) {
    const diff = layerDiff(layer === "repo" ? src.inputs.repoText : src.inputs.userText, layer === "repo" ? d.texts.repoText : d.texts.userText);
    // the count is never pushed off the row: a path too long for it loses its start, not its file name
    // cleaned first, so the text measured is the text drawn; then the prefix and the counts take their cells, and the path what is left
    const counts = `  +${diff.added} −${diff.removed}`, name = clean(label(src, layer)), room = w - width(" TO BE SAVED IN ") - width(counts);
    // measured in terminal cells, whole clusters cut from the start behind an ellipsis; under 8 cells the path is dropped
    const tail = [...new Intl.Segmenter().segment(name)].map((x) => x.segment);
    while (tail.length && 1 + width(tail.join("")) > room) tail.shift();
    const path = width(name) <= room ? ` ${name}` : room < 8 ? "" : ` …${tail.join("")}`;
    out.push([S(` TO BE SAVED IN${path}`, "head"), S(counts, "dim")]);
    if (layer === "user") out.push([S("  Your user config: every repository on this machine reads it.", "warn")]);
    // The one case where the file written is not the file read. Said before the save, not found out after.
    if (layer === "repo" && src.inherited) {
      out.push(...wrap(`This checkout has no config of its own: it reads ${src.inherited}. Saving writes a full copy here with these changes; after that, a change to that file no longer reaches this checkout.`, w - 3).map((t): Line => [S("  "), S(t, "warn")]));
    }
    for (const l of diff.lines) {
      const style: Style = l.op === "+" ? "ok" : l.op === "-" ? "fail" : "dim";
      // line numbers are the file's as it is on disk today; a line that does not exist yet has none
      const gutter = l.op === "…" ? "   ⋮" : ` ${fit(l.op === "+" ? "" : String(l.line), 4)}${l.op} `;
      // a changed line is shown whole, on as many rows as it takes: what changed may sit past the edge
      const room = Math.max(8, w - gutter.length - 1), parts: string[] = [];
      if ((l.op === "+" || l.op === "-") && width(clean(l.text)) > room) for (let rest = clean(l.text); rest;) { const cut = sliceCells(rest, room); parts.push(cut.head); rest = cut.tail; }
      else parts.push(l.text);
      parts.forEach((t, k) => out.push(clip([S(k ? " ".repeat(gutter.length) : gutter, style), S(t, style)], w)));
    }
  }
  return out;
}

/** One frame: exactly `rows` lines of exactly `cols` cells. */
export function frame(src: ScreenSource, st: ScreenState, cols = 80, rows = 24, plain = false): Line[] {
  const d = derive(src, st);
  const M = d.full ?? d.base;
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
    const item = d.items[Math.min(st.sel, d.items.length - 1)];
    if (st.view === "review") {
      const all = review(src, d, cols);
      const max = Math.max(0, all.length - (h - 1));
      body = [[S(" REVIEW", "bold"), S("  nothing is saved until you press y", "dim")], ...all.slice(Math.min(st.scroll, max), Math.min(st.scroll, max) + h - 1)];
      keys = [...(d.refused ? [] : [["y", "save"] as [string, string]]), ["Esc", "back"], ...(max ? [["↑↓", "scroll"] as [string, string]] : [])];
    } else if (st.view === "lines") {
      body = linesView(M, new Set(d.changed), st.line, cols, h);
      keys = [["↑↓", "choose"], ["Enter", "open"], ["r", "probe"], ["Esc", "back"]];
    } else if (st.view === "pick" && st.pick) {
      body = pickView(M, st.pick, cols, h, takes(src, st));
      const open = handLines(M).find((l) => l.id === st.pick?.line);
      keys = [["↑↓", "move"], ["Space", "tick"], ...(open && !open.deny && !open.one ? [["[ ]", "order"] as [string, string]] : []), ...(open?.mode ? [["o", "mode"] as [string, string]] : []),
        ...(open?.floor ? [["f", "floor"] as [string, string]] : []), ["Enter", "done"], ["Esc", "cancel"]];
    } else if (st.view === "detail" && item) {
      body = [[S("")], ...wrap(item.title, cols - 2).map((t): Line => [S(" "), S(t, "bold")]), ...wrap(item.ask, cols - 2).map((t): Line => [S(" "), S(t, "accent")]), [S("")],
        ...item.detail.flatMap((line) => wrap(line, cols - 4).map((t): Line => [S("  "), S(t)]))];
      // what a yes changes: as many as there is room for (eight at most), the rest counted; the review lists every one
      // (each change is said whole, on as many rows as it takes: a name cut off is a change not shown)
      const edits = item.edits ?? [], room = h - body.length - 2;
      const said = edits.map((e) => wrap(e.label, cols - 6).map((t, k): Line => [S(k ? "     " : "   · ", "dim"), S(t)]));
      const rows = (n: number) => said.slice(0, n).reduce((t, x) => t + x.length, 0);
      let show = Math.min(edits.length, 8);
      while (show > 0 && rows(show) > (show === edits.length ? room : room - 1)) show--;
      if (edits.length && show >= 1) {
        body.push([S("")], [S("  Yes changes:", "head")], ...said.slice(0, show).flat(),
          ...(edits.length > show ? [[S(`   · and ${edits.length - show} more: the review lists every change`, "dim")]] : []));
      } else if (edits.length) {
        body.push([S(`  The review lists the ${edits.length} ${edits.length === 1 ? "change" : "changes"} a yes makes.`, "dim")]);
      }
      // details that do not fit say so; what a yes changes is shown in full by the review
      if (body.length > h) body = [...body.slice(0, h - 1), [S(`  … ${body.length - h + 1} more ${body.length - h + 1 === 1 ? "line" : "lines"}: a taller terminal shows them`, "dim")]];
      keys = [...(item.edits ? [["y", "yes"], ["n", "no"]] as Array<[string, string]> : [["n", "not now"] as [string, string]]), ["Esc", "back"]];
    } else {
      const sel = Math.min(st.sel, Math.max(0, d.items.length - 1));
      // what needs the user always keeps room for two items, however short the terminal
      body = [...team(M, cols, h - 2 - Math.min(4, 2 * d.items.length || 1)), [S("")], [S(` NEEDS YOU (${d.items.filter((i) => !st.yes.includes(i.id)).length})`, "head"), ...(pending(d) ? [S(`  ${pending(d)}`, "ok")] : [])]];
      if (!d.items.length) body.push([S("  Nothing. Every shape, gate and the consult has a working model.", "ok")], [S("  e changes a line by hand: shapes, judge, review, consult, mode, deny lists.", "dim")]);
      // At 80 columns and wider a title too long for its row takes a second one: what is wrong is said to
      // its last word. (Narrower, an item stays two rows so that two items always fit; d shows it whole.)
      const titles = d.items.map((it, i) => { const t = cols >= 80 ? wrap(it.title, cols - 4 - String(i + 1).length) : [it.title]; return t.length > 2 ? [t[0], `${t[1].slice(0, -2)} …`] : t; });
      // ... and so does a question: "Add a, b, c, d as fallbacks for implement?" names every model it adds
      const asks = d.items.map((it) => { const t = cols >= 80 ? wrap(it.ask, cols - 5) : [it.ask]; return t.length > 2 ? [t[0], `${t[1].slice(0, -2)} …`] : t; });
      const tall = (i: number) => titles[i].length + asks[i].length;
      const rowsFor = (f: number, avail: number) => { let used = 0, n = 0; for (let i = f; i < d.items.length && used + tall(i) <= avail; i++) { used += tall(i); n++; } return n; };
      const two = Math.max(1, Math.floor((h - body.length) / 2));
      let from = Math.max(0, Math.min(sel - two + 1, d.items.length - two));
      while (from < sel && from + rowsFor(from, h - body.length) <= sel) from++;
      const room = Math.max(1, rowsFor(from, h - body.length));
      d.items.slice(from, from + room).forEach((it, k) => {
        const i = from + k, on = i === sel && !plain, yes = st.yes.includes(it.id);
        const hint: Line = yes ? [S("          ✓ yes", "ok")] : !on ? [S("")] : it.edits ? [S(" y ", "key"), S(" yes ", "dim"), S(" n ", "key"), S(" no", "dim")] : [S("    "), S(" n ", "key"), S(" not now", "dim")];
        const mark = (line: Line): Line => (on ? line.map((s) => ({ ...s, selected: true })) : line);
        body.push(...titles[i].map((t, n) => mark(clip([S(n ? "  " : on ? " ▸" : "  ", "accent"), S(n ? " ".repeat(String(i + 1).length + 2) : `${i + 1}  `, "dim"), S(t, yes ? "dim" : on ? "bold" : undefined)], cols))),
          // only a row that shows its keys or its answer gives up room for them
          // (a question too long to share the row keeps it whole: its keys are named on the screen's last row as
          // well, and an answer of yes is marked before the question instead of after it)
          ...((yes || on) && width(it.ask) + 5 <= cols - 17 ? [mark([...clip([S("     "), S(it.ask, yes ? "dim" : "accent")], cols - 17), ...clip(hint, 17)])]
            : asks[i].map((t, n) => mark(clip([yes && !n ? S("  ✓  ", "ok") : S("     "), S(t, yes ? "dim" : "accent")], cols)))));
      });
      if (d.items.length > from + room) body.push([S(`     … ${d.items.length - from - room} more below`, "dim")]);
      keys = [...(d.items.length ? [["↑↓", "choose"], ["y", "yes"], ["n", "no"], ["d", "details"]] as Array<[string, string]> : []), ["e", "change a line"], ["r", "probe"],
        ...(d.said.length || d.changed.length ? [["Enter", "review and save"]] as Array<[string, string]> : []), ...(d.said.length || d.changed.length || st.log.length ? [["u", "undo"]] as Array<[string, string]> : []), ["q", "quit"]];
    }
  }
  for (let i = 0; i < h; i++) out.push(body[i] ?? [S("")]);
  if (note.length) note.forEach((t, k) => out.push([S(k ? "   " : " ▌ ", "accent"), S(t, "bold")]));
  else out.push(pending(d) && st.view === "home" ? [S(" ▌ ", "accent"), S(`${cap(pending(d))}. `, "bold"), S("Enter", "bold"), S(cols < 80 ? " reviews. Nothing is saved yet." : " shows what changes and saves it. Nothing is saved yet.", "dim")] : [S("")]);
  const gap = cols < 80 ? " " : "  ";
  // A narrow terminal loses hints, never the row's end: the keys to answer, save and quit stay named.
  // A key whose hint is dropped still works.
  const wide = (ks: Array<[string, string]>) => 1 + ks.reduce((n, [k, label]) => n + width(k) + width(label) + 3 + gap.length, 0);
  let shown = wide(keys) > cols ? keys.map(([k, label]): [string, string] => [k, label === "review and save" ? "review" : label]) : keys;
  if (wide(shown) > cols) shown = shown.map(([k, label]): [string, string] => [k, label === "change a line" ? "change" : label]);
  for (const hint of ["probe", "undo", "choose", "change", "details", "scroll", "move", "order", "mode", "floor"]) if (wide(shown) > cols) shown = shown.filter(([, label]) => label !== hint);
  out.push([S(" "), ...shown.flatMap(([k, label]): Line => [S(` ${k} `, "key"), S(` ${label}${gap}`, "dim")])]);
  return out.slice(0, rows).map((l) => clip(l, cols));
}

/** A key name: "up", "down", "enter", "esc", or one character. */
export function press(src: ScreenSource, st0: ScreenState, key: string, size: { cols: number; rows: number } = { cols: 80, rows: 24 }): { state: ScreenState; action?: ScreenAction } {
  const st: ScreenState = { ...st0, msg: "" };
  const d = derive(src, st);
  if (key === "q") return { state: st, action: { kind: "quit", unsaved: d.said.length + d.changed.length } };
  if (!d.base) {
    const max = Math.max(0, errorBody(src, d, size.cols).length - Math.max(3, size.rows - 3));
    if (key === "up" || key === "k") return { state: { ...st, scroll: Math.max(0, Math.min(st.scroll, max) - 1) } };
    if (key === "down" || key === "j") return { state: { ...st, scroll: Math.min(max, st.scroll + 1) } };
    return { state: st };
  }
  const last = Math.max(0, d.items.length - 1);
  const item = d.items[Math.min(st.sel, last)];
  if (st.view === "review") {
    if (key === "esc") return { state: { ...st, view: "home", scroll: 0 } };
    // the scroll stops at the review's end: scrolled past it, one "up" would otherwise do nothing for as many presses
    const max = Math.max(0, review(src, d, size.cols).length - (Math.max(3, size.rows - 3) - 1));
    if (key === "up" || key === "k") return { state: { ...st, scroll: Math.max(0, Math.min(st.scroll, max) - 1) } };
    if (key === "down" || key === "j") return { state: { ...st, scroll: Math.min(max, st.scroll + 1) } };
    if (key === "y" && !d.refused && d.texts) return { state: initialScreen(), action: { kind: "save", texts: { userText: d.texts.userText, repoText: d.texts.repoText }, touched: d.texts.touched } };
    return { state: st };
  }
  const M = d.full ?? d.base;
  if (st.view === "lines") {
    const lines = handLines(M), end = lines.length - 1, at = Math.min(st.line, end);
    if (key === "esc") return { state: { ...st, view: "home" } };
    if (key === "up" || key === "k") return { state: { ...st, line: Math.max(0, at - 1) } };
    if (key === "down" || key === "j") return { state: { ...st, line: Math.min(end, at + 1) } };
    if (key === "r") return { state: st, action: { kind: "probe", keep: { yes: st.yes, hand: st.hand } } };
    if (key === "enter") return { state: { ...st, line: at, view: "pick", pick: { line: lines[at].id, chosen: [...lines[at].current], at: 0, mode: lines[at].mode, floor: floorOf(lines[at]) } } };
    return { state: st };
  }
  if (st.view === "pick" && st.pick) {
    const p = st.pick, line = handLines(M).find((l) => l.id === p.line);
    if (!line || key === "esc") return { state: { ...st, view: "lines", pick: null } };
    const end = Math.max(0, line.candidates.length - 1), under = line.candidates[Math.min(p.at, end)];
    if (key === "up" || key === "k") return { state: { ...st, pick: { ...p, at: Math.max(0, Math.min(p.at, end) - 1) } } };
    if (key === "down" || key === "j") return { state: { ...st, pick: { ...p, at: Math.min(end, p.at + 1) } } };
    // a shape's pool is any or ordered: o turns it, and the shares beside the ticks show what that does
    // a shape's floor: what the mode says, or a tier for this shape, which beats the mode
    if (key === "f" && line.floor) {
      const steps: FloorChoice[] = ["mode", "cheap", "mid", "frontier"];
      return { state: { ...st, pick: { ...p, floor: steps[(steps.indexOf(p.floor ?? floorOf(line) ?? "mode") + 1) % steps.length] } } };
    }
    if (key === "o" && line.mode) return { state: { ...st, pick: { ...p, mode: (p.mode ?? line.mode) === "ordered" ? "any" : "ordered" } } };
    // the order is the order ticked; [ and ] move the ticked model under the cursor one place earlier or later
    if ((key === "[" || key === "]") && under && !line.deny && !line.one) {
      const i = p.chosen.indexOf(under), j = i + (key === "[" ? -1 : 1);
      if (i < 0 || j < 0 || j >= p.chosen.length) return { state: st };
      const chosen = [...p.chosen];
      [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
      return { state: { ...st, pick: { ...p, chosen } } };
    }
    if ((key === " " || key === "x") && under) {
      // a model kept out by a rule that covers more than it is not ticked: lifting that is a choice about the others too
      const kept = line.barred[under];
      if (kept && !kept.liftable && !p.chosen.includes(under)) return { state: { ...st, msg: `${under} is kept out by ${kept.why}. Change that on its deny line first (Esc, then the deny lines below).` } };
      // one model for the judge; for a list a tick joins at the end and a second tick takes it out, so the order is the order ticked
      const chosen = line.one ? [under] : p.chosen.includes(under) ? p.chosen.filter((x) => x !== under) : [...p.chosen, under];
      return { state: { ...st, pick: { ...p, chosen } } };
    }
    if (key === "enter") {
      const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
      const floor = line.floor && (p.floor ?? floorOf(line));
      // nothing ticked is not a choice of models; on a shape that names nobody it can still be a choice of floor
      if (!p.chosen.length && !line.deny && (line.current.length || floor === floorOf(line))) return { state: { ...st, msg: "Tick at least one model, or Esc leaves the line as it is." } };
      // a deny list has no order: what stays ticked keeps its place in the file, what is new goes after it
      const chosen = line.deny ? [...line.current.filter((k) => p.chosen.includes(k)), ...p.chosen.filter((k) => !line.current.includes(k))] : p.chosen;
      const mode = line.mode && (p.mode ?? line.mode);
      if (same(line.current, chosen) && mode === line.mode && floor === floorOf(line)) return { state: { ...st, view: "lines", pick: null, msg: "Nothing changed." } };
      const rest = st.hand.filter((x) => x.line !== line.id), log = st.log.filter((e) => e !== `h:${line.id}`);
      // Back to what the line is without this change (the config, the answers and the other lines
      // changed by hand): the change is withdrawn, not kept as a change that changes nothing.
      const without = derive(src, { ...st, hand: rest });
      const was = handLines(without.full ?? d.base).find((l) => l.id === line.id);
      const ticks = !(same(was?.current ?? [], chosen) && mode === was?.mode), floored = !!was && floor !== floorOf(was);
      if (!ticks && !floored) return { state: { ...st, view: "home", pick: null, hand: rest, log, msg: `${line.id} is back to what ${rest.length || d.said.length ? "it was before you changed it" : "the config says"}.` } };
      // a tick on a model a rule kept out lifts that rule in the same save: said here, shown in the review
      const lifted = chosen.filter((k) => line.barred[k]?.liftable && !line.current.includes(k));
      return { state: { ...st, view: "home", pick: null, // (the floor alone: the models are not part of the change, so an answer about them still stands)
        hand: [...rest, { line: line.id, chosen: ticks ? [...chosen] : [], ...(ticks && mode ? { mode } : {}), ...(floored && floor ? { floor } : {}) }], log: [...log, `h:${line.id}`],
        msg: `${line.id} changed${lifted.length ? `, and the rule that kept ${lifted.join(", ")} out is lifted` : ""}. Enter shows what changes and saves it.` } };
    }
    return { state: st };
  }
  if (key === "esc") return { state: { ...st, view: "home" } };
  if (key === "e") return { state: { ...st, view: "lines" } };
  // a probe reopens the screen: what is answered and changed and not yet saved goes with it
  if (key === "r") return { state: st, action: { kind: "probe", keep: { yes: st.yes, hand: st.hand } } };
  if (key === "up" || key === "k") return { state: { ...st, sel: Math.max(0, Math.min(st.sel, last) - 1) } };
  if (key === "down" || key === "j") return { state: { ...st, sel: Math.min(last, st.sel + 1) } };
  if (key === "enter") return d.said.length || d.changed.length ? { state: { ...st, view: "review", scroll: 0 } } : { state: { ...st, msg: "Nothing to save yet: answer yes to something, or change a line with e." } };
  if (key === "u") {
    // the last answer, yes or no; a state built without a log still undoes its last yes
    const last = st.log.at(-1) ?? (st.yes.length ? `y:${st.yes.at(-1)}` : undefined);
    if (!last) return { state: st };
    const log = st.log.slice(0, -1);
    if (last.startsWith("y:")) return { state: { ...st, log, yes: st.yes.filter((x) => x !== last.slice(2)), msg: "Last yes undone." } };
    if (last.startsWith("h:")) return { state: { ...st, log, hand: st.hand.filter((x) => x.line !== last.slice(2)), msg: "Last change by hand undone." } };
    return { state: { ...st, log, msg: "Last no undone: it is asked again." }, action: { kind: "restore", signature: last.slice(2) } };
  }
  if (!item) return { state: st };
  if (key === "d") return { state: { ...st, view: st.view === "detail" ? "home" : "detail" } };
  if (key === "y") {
    if (!item.edits) return { state: { ...st, msg: "This one is yours to do; then press r." } };
    return { state: st.yes.includes(item.id) ? st : { ...st, view: "home", yes: [...st.yes, item.id], log: [...st.log, `y:${item.id}`], sel: Math.min(st.sel + 1, last) } };
  }
  if (key === "n") {
    return { state: { ...st, view: "home", yes: st.yes.filter((x) => x !== item.id), log: [...st.log.filter((e) => e !== `y:${item.id}`), `n:${needSignature(item)}`],
      sel: Math.min(st.sel, Math.max(0, last - 1)), msg: "Left as it is: not asked again until something changes. u undoes." }, action: { kind: "dismiss", id: item.id } };
  }
  return { state: st };
}

/** `tickmarkr fleet --yes <id>…`: the whole review as text, however long. What is saved is never more than what this prints. */
export function plainReview(src: ScreenSource, yes: readonly string[], hand: readonly HandChoice[] = [], cols = 100): string {
  const d = derive(src, { ...initialScreen(), yes: [...yes], hand: [...hand] });
  return review(src, d, cols).map((l) => l.map((s) => s.text).join("").trimEnd()).join("\n").replace(/\n+$/, "");
}

/** `tickmarkr fleet --plain`: the home screen as text, every item shown. */
export function plainScreen(src: ScreenSource, cols = 100): string {
  const d = derive(src, initialScreen());
  // room for every item at its tallest: a title and a question wider than the terminal take two rows each
  const rows = 3 + (d.base ? 13 + SHAPES.length + 4 * d.items.length : errorBody(src, d, cols).length);
  return frame(src, initialScreen(), cols, rows, true).slice(0, -1).map(plainLine).join("\n").replace(/\n+$/, "");
}
