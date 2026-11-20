// A shape's line opened (queue rows 499, 501, 502; D-2187 add.363; contract 5.3 and the shape rows of 5.4),
// as the designs LineA-shared and LineA-order draw it: the head (the shape, its job, its bar), the choices
// of how the tasks are given out, then by complexity its table, WHY, NOTE, IF ONE STOPS and the legend;
// in my order its numbered rows, RESULT and APPLIES TO; a line saved before 2.27 its third choice and who
// gets none, with why. Pure: lines of styled segments from the fleet's model of the line, the choice made
// so far and a cursor. The keys and the edits live in screen.ts and hand.ts (T10); nothing here reads a key or a file.
import { channelKey, modelAuthed } from "../adapters/types.js";
import type { Shape } from "../graph/schema.js";
import { S, type Style, width } from "./draw.js";
import { sliceCells } from "../tui/cockpit/width.js";
import { disallowedBy, observedSeat } from "../route/preference.js";
import { invalidConfiguredModels } from "../adapters/registry.js";
import { applyEdits } from "./edits.js";
import { handEdits, namesOf } from "./hand.js";
import { type Line as LineModel, lineOf } from "./lines.js";
import { buildFleetModel, type FleetModel, SAMPLE, splitKey } from "./model.js";
import { holderIn, parsedLayers } from "./needs.js";
import type { OneLine, OneSeg } from "./one-screen.js";

/** A segment the product quotes (a model id, a CLI id, the project's folder): drawn as written, exempt from 5.1. */
export const V = (text: string, style?: Style): OneSeg => ({ ...S(text, style), verbatim: true });
export const pad = (t: string, n: number): string => t + " ".repeat(Math.max(1, n - width(t)));

/** Wrap already-marked segments, retaining every character's style and quote mark (add.402).
 * Only layout space at a break is replaced by the row's continuation indent; no word is cut off. */
export function flow(row: OneLine, w: number, indent: number): OneLine[] {
  const text = row.map((s) => s.text).join("");
  if (width(text) <= w) return [row];
  const spans = row.map((seg) => ({ seg, start: 0, end: 0 }));
  let offset = 0;
  for (const span of spans) { span.start = offset; offset += span.seg.text.length; span.end = offset; }
  const out: OneLine[] = [];
  let cur: OneLine = [], used = 0, last: OneSeg | undefined;
  const put = (start: number, end: number) => {
    for (const span of spans) {
      if (end <= span.start || start >= span.end) continue;
      const t = span.seg.text.slice(Math.max(start, span.start) - span.start, Math.min(end, span.end) - span.start);
      if (!t) continue;
      if (last === span.seg) cur[cur.length - 1].text += t;
      else cur.push({ ...span.seg, text: t });
      last = span.seg;
      used += width(t);
    }
  };
  const next = () => { out.push(cur); cur = [S(" ".repeat(indent))]; used = indent; last = undefined; };
  // The first column is layout, including the cursor's two cells: it is read only from the view's own
  // (unquoted) leading segments, never from a quoted name, identity or refusal (add.404 a). Keep it
  // attached to the first content token even when that token needs a hard wrap; a prefix alone is never a row.
  let prefix = "";
  for (const s of row) { if (s.verbatim) break; prefix += s.text; }
  const leading = /^(?:▸ )? */u.exec(prefix)![0], firstIndent = width(leading);
  put(0, leading.length);
  let space: { start: number; end: number; cells: number } | undefined;
  for (const match of text.slice(leading.length).matchAll(/\s+|\S+/gu)) {
    const start = leading.length + match.index, token = match[0];
    if (/^\s+$/u.test(token)) { space = { start, end: start + token.length, cells: width(token) }; continue; }
    if (used + (space?.cells ?? 0) + width(token) > w) {
      if (used > (out.length ? indent : firstIndent)) next();
      // at a row's start the space is content (a quoted text's own leading spaces), drawn while a glyph
      // still fits after it; otherwise it is the break, so the row's first content stays on the row (add.404 a)
      else if (space && used + space.cells + 2 <= w) put(space.start, space.end);
    } else if (space) put(space.start, space.end);
    space = undefined;
    let rest = token, at = start;
    while (width(rest) > w - used) {
      const cut = sliceCells(rest, w - used);
      if (cut.cells > w - used || !cut.head) { next(); continue; }
      put(at, at + cut.head.length);
      rest = cut.tail; at += cut.head.length;
      if (rest) next();
    }
    if (rest) put(at, at + rest.length);
  }
  if (space && used + space.cells <= w) put(space.start, space.end);
  if (used > indent || !out.length) out.push(cur);
  return out;
}

/** Each shape's job, in one phrase (closed, 5.3). */
export const JOB: Record<Shape, string> = {
  plan: "who plans the work", spec: "who writes the spec", implement: "who writes the code", tests: "who writes the tests",
  docs: "who writes the docs", migration: "who writes migrations", ui: "who builds the interface", refactor: "who reshapes the code", chore: "who does the chores",
};
/** The verb of RESULT, by shape (closed, 5.4). */
const VERB: Record<Shape, string> = {
  plan: "plans", spec: "writes the spec for", implement: "writes", tests: "tests", docs: "documents",
  migration: "migrates", ui: "builds", refactor: "reshapes", chore: "does",
};
export type Choice = "complexity" | "order" | "any";
const CHOICES: Record<Choice, [string, string]> = {
  complexity: ["By complexity", "hard tasks go to the strongest models, lighter tasks to cheaper ones"],
  order: ["My order", "the first model that works takes every task; the others are backups"],
  any: ["As saved before 2.27", "kept as it was saved; the rows below say who gets its tasks"],
};

export interface LineViewInput {
  M: FleetModel; line: LineModel; project: string;
  /** the choice made so far; none: the line as saved. Another way than the line's is drawn as the line would route
   *  with it (its rows, table, footer and cursor targets); the third choice is never chosen again once left. */
  choice?: Choice;
  /** an index into lineTargets() */
  cursor: number;
  /** one message, drawn above the keys (T10: what a key did, or why it did nothing) */
  note?: string;
}

const choicesOf = (line: LineModel): Choice[] =>
  // the third choice is shown only while the line is still as saved before 2.27 (it cannot be chosen again once left)
  line.givenOut === "any" ? ["complexity", "order", "any"] : ["complexity", "order"];
/** The models of an order or a line saved before 2.27, in the order the config writes them. */
function written(M: FleetModel, shape: Shape): string[] {
  const slot = M.cfg.routing.map[shape];
  return slot?.pool?.channels ? [...slot.pool.channels] : slot?.pin ? [`${slot.pin.via}:${slot.pin.model}`] : [];
}

/**
 * The line as the choice made so far would route it (rows 499, 501): the same models, in the same order, given
 * out the chosen way, over a model of the config with that choice applied. No choice, the line's own way, or
 * the third choice of a line that left it: the line as given.
 */
type Draft = LineViewInput & { refusal?: string };
function drafted(inp: LineViewInput): Draft {
  const { M, line, choice } = inp;
  if (choice === "any" && line.givenOut !== "any") return { ...inp, choice: undefined };
  if (!choice || choice === line.givenOut || choice === "any") return inp;
  const way = choice === "order" ? "order" : "complexity", keys = written(M, line.shape);
  const empty: LineModel = { shape: line.shape, givenOut: way, groups: [], order: { works: null, backups: [] }, why: [], note: [] };
  if (!keys.length) return { ...inp, line: empty };
  try {
    const edits = handEdits(M, [{ line: line.shape, chosen: keys, mode: choice === "order" ? "ordered" : "complexity" }]);
    const { userText, repoText } = applyEdits({ userText: M.inputs.userText, repoText: M.inputs.repoText }, edits);
    const D = buildFleetModel({ ...M.inputs, userText, repoText });
    const l = lineOf(D, line.shape);
    if (l.givenOut !== way) throw new Error("This choice could not be applied; the saved line is shown.");
    return { ...inp, M: D, line: l };
  } catch (err) {
    // An edit refusal is evidence, not an empty routing preview: keep the saved rows and choice.
    return { ...inp, choice: undefined, refusal: err instanceof Error ? err.message : String(err) };
  }
}

/** What the cursor moves over: the choices, the model rows, then the add row (none for a line saved before 2.27). */
export function lineTargets(inp: LineViewInput): string[] {
  return targetsOf(drafted(inp));
}
/** One place of the cursor, structured: a model row carries its key and its position, never read back out of an id. */
export type LineSlot = { kind: "choice"; choice: Choice } | { kind: "model"; key: string; row: number } | { kind: "add" };
/** The cursor's places as structures, in lineTargets() order (T10: a key acts on what the cursor is on, whatever a model id spells). */
export function lineSlots(inp: LineViewInput): LineSlot[] {
  return slotsOf(drafted(inp));
}
function slotsOf(inp: LineViewInput): LineSlot[] {
  const { M, line } = inp;
  const models = line.givenOut === "complexity" ? (line.groups ?? []).flatMap((g) => g.models.map((m) => m.key)) : written(M, line.shape);
  const add: LineSlot[] = line.givenOut === "complexity" || line.givenOut === "order" ? [{ kind: "add" }] : [];
  return [...choicesOf(line).map((choice): LineSlot => ({ kind: "choice", choice })), ...models.map((key, i): LineSlot => ({ kind: "model", key, row: i })), ...add];
}
function targetsOf(inp: LineViewInput): string[] {
  const slots = slotsOf(inp), ids = modelTargets(slots.flatMap((s) => (s.kind === "model" ? [s.key] : [])));
  let m = 0;
  return slots.map((s) => (s.kind === "choice" ? `choice:${s.choice}` : s.kind === "add" ? "add" : ids[m++]));
}

/** Rows are positions, even when the same key is written twice. Keep existing ids for distinct keys. */
function modelTargets(keys: readonly string[]): string[] {
  const reserved = new Set(keys.map((k) => `model:${k}`)), seen = new Set<string>();
  return keys.map((k, i) => {
    let id = `model:${k}`;
    if (seen.has(k)) {
      id += `:row:${i + 1}`;
      while (reserved.has(id)) id += ":";
      reserved.add(id);
    }
    seen.add(k);
    return id;
  });
}

export function facts(M: FleetModel, key: string): { score: number | null; priceIn: number | null; priceOut: number | null } {
  const [a, m] = splitKey(key);
  const f = M.health?.[a]?.modelFacts?.[m];
  // facts belong to the identity the probe observed, else the full requested id (row 502), never a shortened one
  const ok = f && f.as === (observedSeat(M.health, a, m).identity ?? m);
  const num = (v: unknown) => (ok && typeof v === "number" && Number.isFinite(v) ? v : null);
  return { score: num(f?.score), priceIn: num(f?.priceIn), priceOut: num(f?.priceOut) };
}
export const score = (n: number | null): string => (n === null ? "—" : n.toFixed(1));
// a list price is shown as the source records it, a zero as $0 (rule 14); nothing recorded reads —
export const price = (i: number | null, o: number | null): string => (i === null && o === null ? "—" : `${i === null ? "—" : `$${i}`} / ${o === null ? "—" : `$${o}`}`);

function rangeWords(range: [number, number] | null, i: number, n: number): string {
  if (!range) return "backup group";
  if (n === 1) return `every task ${range[0]}-${range[1]}`;
  if (n === 2) return i === 0 ? `very complex ${range[0]}-${range[1]}` : `the rest ${range[0]}-${range[1]}`;
  return range[0] === range[1] ? `complexity ${range[0]}` : `complexity ${range[0]}-${range[1]}`;
}

/** The line opened, `w` cells wide; every row wraps under its first column from 80 cells up. */
export function lineView(given: LineViewInput, w = 100): OneLine[] {
  const { body, footer } = lineParts(given, w);
  return [...body, ...footer];
}
/** The line opened, as its body and its footer (the note and the keys), so a short window scrolls the body only. */
export function lineParts(given: LineViewInput, w = 100): { body: OneLine[]; footer: OneLine[] } {
  const inp = drafted(given), { M, line } = inp;
  const shape = line.shape, targets = targetsOf(inp);
  const at = targets[Math.max(0, Math.min(inp.cursor, targets.length - 1))];
  // the cursor takes the row's first two cells only: a row's number and words stay
  const mark = (id: string, row: OneLine): OneLine => (id !== at ? row : [{ ...S("▸ ", "accent"), selected: true },
    ...[{ ...row[0], text: row[0].text.slice(2) }, ...row.slice(1)].filter((s) => s.text !== "").map((s) => ({ ...s, selected: true }))]);
  const blank: OneLine = [S(" ")];
  // Prose is segmented at insertion. Finished model sentences and diagnostics are quoted whole;
  // this module never searches inside a handed-in sentence for names (add.402).
  const said: Said = (head, ind, texts, headStyle = "head") => texts.flatMap((t, i) =>
    flow([i === 0 && head ? S(pad(`  ${head}`, ind), headStyle) : S(" ".repeat(ind)), ...t], w, ind));

  const tier = M.cfg.routing.floors[shape];
  // A removed bar has no provenance entry: only an explicit mode provenance attributes it to the mode.
  const from = M.mode.provenance[shape] === `mode ${M.mode.mode}` ? [S("mode ", "dim"), V(M.mode.mode, "dim")]
    : [S("set for this shape", "dim")];
  const out: OneLine[] = [
    ...flow([S(shape, "head"), S(pad(`  ${JOB[shape]}`, 40), "dim"), S(`bar for ${shape}: `, "dim"),
      ...(tier ? [V(tier, "dim")] : [S("none", "dim")]), S(" (", "dim"), ...from, S(")", "dim")], w, 0),
    blank,
    [S("  How are the tasks given out?", "head")],
  ];
  const chosen: Choice | undefined = inp.choice ?? (line.givenOut === "open" ? undefined : line.givenOut);
  const choices = choicesOf(line), lw = Math.max(...choices.map((c) => width(CHOICES[c][0]))) + 3;
  for (const c of choices) {
    const on = c === chosen;
    out.push(...flow(mark(`choice:${c}`, [S("  "), S(pad(`${on ? "(•)" : "( )"} ${CHOICES[c][0]}`, lw + 4), on ? "ok" : "dim"), S(CHOICES[c][1], on ? undefined : "dim")]), w, 2));
  }
  out.push(blank);

  if (line.givenOut === "complexity") out.push(...complexity(inp, mark, said, w));
  else if (line.givenOut === "order" || line.givenOut === "any") out.push(...ordered(inp, mark, said, w));
  else out.push([S("  the cheapest model at the bar takes each task", "dim")], blank);

  if (inp.refusal) out.push(...said("", 2, [[V(inp.refusal, "warn")]]), blank);
  const footer = inp.note ? said("", 2, [[S(inp.note, "accent")]]) : [];
  footer.push(...flow([S(line.givenOut === "complexity" ? "↑↓ move · Enter allow or remove a model · c what counts as very complex · f bar · Esc back"
    : line.givenOut === "order" ? "↑↓ move · Enter pick the model for a row · [ ] move the row · x remove · Esc back"
    : "↑↓ move · Enter choose · Esc back", "dim")], w, 0));
  return { body: out, footer };
}

type Mark = (id: string, row: OneLine) => OneLine;
type Said = (head: string, ind: number, texts: readonly OneLine[], headStyle?: Style) => OneLine[];

function complexity(inp: LineViewInput, mark: Mark, said: Said, w: number): OneLine[] {
  const { line } = inp;
  const groups = line.groups ?? [];
  const out = flow([S(`  ${pad("TASKS", 20)}${pad("MODEL", 20)}${pad("CLI", 14)}${pad("SCORE", 8)}${pad("PRICE IN / OUT", 17)}SHARE`, "dim")], w, 2);
  const ids = modelTargets(groups.flatMap((g) => g.models.map((m) => m.key)));
  let position = 0;
  groups.forEach((g, gi) => g.models.forEach((m, mi) => {
    out.push(...flow(mark(ids[position++], [S("  "), S(pad(mi === 0 ? rangeWords(g.range, gi, groups.length) : "", 20), "head"),
      V(pad(m.name, 20)), V(pad(m.cli, 14)), S(pad(score(m.score), 8)), S(pad(price(m.priceIn, m.priceOut), 17)),
      // a share is words over its group's own range, never a percentage (rule 12)
      S(m.shareWords, "ok")]), w, mi === 0 ? 2 : 22));
    // a stand-in: the same model on another CLI, under its model
    for (const k of m.standIns) out.push(...flow([S(`  ${" ".repeat(20)}`), V(pad(k, 34)), S("backup: used when ", "dim"), V(m.name, "dim"), S(" stops", "dim")], w, 22));
  }));
  out.push(mark("add", [S("  "), S("+ allow a model", "dim")]), [S(" ")]);
  // WHY comes from line.why; SHARE above comes from m.shareWords, never a percent (rows 499, 501, 502).
  out.push(...said("WHY", 9, line.why.map((t) => [V(t)])));
  out.push(...said("NOTE", 9, line.note.map((t) => [V(t, "warn")]), "warn"));
  const backupGroup = groups.some((g) => g.range === null);
  out.push(...said("IF ONE STOPS", 17, [[S(`the others in its group take its tasks; an empty group passes them to the next.${backupGroup ? " The backup group gets tasks only then." : ""}`)]]));
  out.push([S(" ")]);
  for (const t of ["complexity = the 1-10 number a task gets when its spec is compiled",
    "score = Artificial Analysis Intelligence · price = list price per million tokens, in / out",
    `share = counted over ${SAMPLE} sample tasks, ${SAMPLE / 10} at each complexity`]) {
    out.push(...flow([S(`  ${t}`, "dim")], w, 2));
  }
  return out;
}

function ordered(inp: LineViewInput, mark: Mark, said: Said, w: number): OneLine[] {
  const { M, line, project } = inp;
  const shape = line.shape, keys = written(M, shape), names = namesOf(M, keys);
  const nameOf = (k: string) => names[keys.indexOf(k)] ?? M.name(k);
  const any = line.givenOut === "any";
  const gets = new Set((line.order?.gets ?? []).map((g) => g.key)), works = line.order?.works ?? null;
  const worksAt = works === null ? -1 : keys.indexOf(works), ids = modelTargets(keys);
  const working = (k: string) => !!M.pools.worker.find((c) => channelKey(c) === k) && !M.seat(k)?.denied.worker;
  // a model that cannot work reads its reason in place of its job, in the router's own order of checks
  // (add.404 d): a rule that keeps it out, then not allowed yet, then not listed, then not probed or not offered
  const unable = (k: string): string => {
    const [a, m] = splitKey(k), seat = M.seat(k);
    const d = disallowedBy(observedSeat(M.health, a, m), M.cfg.routing, "worker");
    if (d) return d.by === "allow" ? "not allowed yet" : "kept out";
    if (!seat || !M.cfg.tiers[a]?.models[m]) return "not listed";
    const adapter = M.inputs.adapters.find((x) => x.id === a), h = M.health?.[a];
    if (!adapter) return "not offered";
    if (!h?.installed || !h.authed) return seat.verdict.text;
    if (!adapter.channels(M.cfg).some((c) => channelKey(c) === k) || invalidConfiguredModels(M.cfg, a, h).includes(m)) return "not offered";
    return modelAuthed(h, m, M.cfg.routing.allowUnverifiedModels) ? "not offered" : seat.verdict.text;
  };
  // rows are positions (add.404 c): in a line saved as any only the first position of a model takes its tasks
  const takes = (k: string, i: number) => gets.has(k) && keys.indexOf(k) === i;
  const job = (k: string, i: number): [string, Style | undefined] => any ? (takes(k, i) ? ["shares the tasks", "ok"] : ["gets none", "warn"])
    : i === worksAt ? ["does the work", "ok"] : working(k) ? ["backup", undefined] : [unable(k), "warn"];
  const jw = Math.max(16, ...keys.map((k, i) => width(job(k, i)[0]) + 2));
  const out = flow([S(`     ${pad("JOB", jw)}${pad("MODEL", 20)}${pad("CLI", 14)}${pad("SCORE", 8)}PRICE IN / OUT`, "dim")], w, 5);
  keys.forEach((k, i) => {
    const [j, st] = job(k, i), f = facts(M, k);
    out.push(...flow(mark(ids[i], [S(`  ${pad(String(i + 1), 3)}`), S(pad(j, jw), st), V(pad(nameOf(k), 20)), V(pad(splitKey(k)[0], 14)), S(pad(score(f.score), 8)), S(price(f.priceIn, f.priceOut))]), w, 2));
  });
  if (!any) out.push(...flow(mark("add", [S(`  ${pad(String(keys.length + 1), 3)}${pad("backup", jw)}+ add a model`, "dim")]), w, 2));
  out.push([S(" ")]);

  const result: OneLine[] = [];
  if (any) {
    const g = keys.filter(takes).map(nameOf);
    if (g.length) result.push([...g.flatMap((name, i) => [...(i ? [S(" and ")] : []), V(name)]), S(g.length === 1 ? " does every task." : " share every task.")]);
    // one row for each position that gets none, in row order, with its one reason (section 4); a later
    // position of a model that takes tasks gets none because the same model is written before it
    const none = [...(line.order?.none ?? [])];
    keys.forEach((k, i) => {
      if (takes(k, i)) return;
      const why: OneSeg[] = gets.has(k) ? [V(nameOf(k)), S(", of the same vendor, is written before it")]
        : (() => { const n = none.shift(); return n?.reason ? [V(n.reason)] : []; })();
      result.push([V(nameOf(k)), S(" gets no tasks"), ...(why.length ? [S(": "), ...why] : []), S(".")]);
    });
  } else if (works) {
    result.push([V(nameOf(works)), S(` ${VERB[shape]} every task, whatever its complexity.`)]);
    const next = keys.find((k) => k !== works && working(k));
    result.push(next ? [S("If it stops working, "), V(nameOf(next)), S(" takes over.")] : [S(`There is no backup: if it stops, ${shape} has no model.`)]);
  } else result.push([S(`No model on this line works: ${shape} has no model.`)]);
  out.push(...said("RESULT", 14, result));
  const held = holderIn(parsedLayers(M.inputs))(["routing", "map", shape]);
  out.push(...flow(held === "user"
    ? [S(pad("  APPLIES TO", 14), "head"), S(`every project with no ${shape} line of its own; `, "dim"), V(project, "dim"), S(" has none", "dim")]
    : [S(pad("  APPLIES TO", 14), "head"), S("this project only", "dim")], w, 14));
  out.push([S(" ")]);
  return out;
}
