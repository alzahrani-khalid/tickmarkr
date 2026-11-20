// The save of `tickmarkr fleet` (queue row 499 (h); D-2187 add.363; contract 5.7), as the design Save
// draws it: YOU ARE SAVING, each pending change after and before, the files the candidate bytes touch and
// who reads them, what this save leaves UNTOUCHED, THIS ALSO CHANGES where a measure moves the wrong way,
// and a refusal in its own words. `d` shows the file lines beside their numbers. Pure: nothing here reads
// a key or writes a file; the one write is the save's Enter, in press() (screen.ts), through the guarded
// save of 2.26.0, unchanged. The review text `--yes` and `--set` print (review()) lives here too, unchanged.
import { SHAPES, type Shape } from "../graph/schema.js";
import { sliceCells } from "../tui/cockpit/width.js";
import { clean, clip, fit, fmt, type Line, S, type Style, width, wrap } from "./draw.js";
import { type Edit, layerDiff, type Layer } from "./edits.js";
import { handLines } from "./hand.js";
import { lineOf } from "./lines.js";
import { consequence, type FleetModel } from "./model.js";
import { parsedLayers } from "./needs.js";
import { afterRows, flow, nameIn, type OneLine, type OneSeg, type Pending, rowOfPath, savedNow, V, workerKeys } from "./one-screen.js";
import type { Derived, ScreenSource } from "./screen.js";

/** How the screen names a layer's file: its label, else its path. */
export const label = (src: ScreenSource, layer: Layer): string => src.labels?.[layer] ?? src.paths[layer];
const pad = (t: string, n: number): string => t + " ".repeat(Math.max(1, n - width(t)));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** The closed list of UNTOUCHED, in the design's order. */
export const UNTOUCHED = ["every other line", "KEPT OUT", "judge", "review", "consult", "mode"] as const;

/**
 * Of UNTOUCHED, the members this save does not change, read from the candidate bytes (the team they
 * load as) against the config as saved: never a fixed list (row 499; D-2187 add.363).
 */
export function untouched(base: FleetModel, after: FleetModel): string[] {
  const A = base.cfg, B = after.cfg;
  const lines = SHAPES.filter((s) => !same(A.routing.map[s], B.routing.map[s]) || !same(A.routing.floors[s], B.routing.floors[s]));
  const kept: Record<(typeof UNTOUCHED)[number], boolean> = {
    "every other line": lines.length < SHAPES.length && A.routing.hardFrom === B.routing.hardFrom,
    "KEPT OUT": same(A.routing.deny, B.routing.deny), judge: same(A.judge, B.judge), review: same(A.review, B.review),
    consult: same(A.consult, B.consult), mode: same(A.routing.mode, B.routing.mode),
  };
  return UNTOUCHED.filter((m) => kept[m]);
}

/** A row of the line as it was saved, in the past tense (`shared every task`). */
const past = (segs: readonly OneSeg[]): OneSeg[] => segs.map((s) => ({ ...s, text: s.text.replace(/ share every task/, " shared every task")
  .replace(/ does every task/, " did every task").replace(/takes each task/, "took each task") }));

/** A config value in one row: a list by its members, nothing as `nothing`. */
/** (an empty list and a null, the loader's tombstone, are told apart from a key not set: each is a value written) */
const shown = (v: unknown): string => v === undefined ? "nothing" : v === null ? "null" : Array.isArray(v) && !v.length ? "an empty list"
  : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
const at = (obj: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((cur, seg) => (cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined), obj);
/** What a path held as saved: a line (a shape, judge, review, consult) as the team read it, by name; else the value. */
const wasIn = (X: FleetModel) => (path: readonly string[]): string => {
  const id = rowOfPath(path)[0], line = id && path.length <= 3 ? handLines(X).find((l) => l.id === id) : undefined;
  if (!line) return shown(at(X.cfg, path));
  if (!(SHAPES as readonly string[]).includes(id)) return `${id}: ${line.current.join(", ") || "nobody"}`;
  // a shape's line as the one screen routes it, the models that get no task beside it (row 499 (h); D-2187 add.418)
  const l = lineOf(X, id as Shape), sample = savedNow(nameIn(X, workerKeys(l)), l).map((x) => x.text).join("").trim();
  return `${id}: ${sample}${way(X, id)}`;
};
/**
 * A shape's line: how its tasks are given out, in the words of 5.1, and any other key its slot sets, as typed: a
 * change of the routing method alone is a change said after and before (row 499 (h); D-2187 add.363, add.417).
 */
const way = (X: FleetModel, shape: string): string => {
  const slot = X.cfg.routing.map[shape as keyof typeof X.cfg.routing.map] as Record<string, unknown> | undefined;
  const mode = (slot?.pool as { mode?: string } | undefined)?.mode;
  const word = mode === "complexity" ? "by complexity" : mode === "ordered" ? "in my order" : mode ? "as saved before 2.27"
    : slot?.pin ? "pinned" : "the cheapest model at the bar takes each task";
  const rest = Object.entries(slot ?? {}).filter(([k, v]) => k !== "pool" && k !== "pin" && v !== undefined).map(([k, v]) => `${k} ${shown(v)}`);
  return `; ${[word, ...rest].join("; ")}`;
};
/** A shape's bar as the team reads it, whose it is, and the file that holds it: a bar moved, set or removed in either file is a change. */
const barOf = (X: FleetModel, shape: string): string => {
  const f = handLines(X).find((l) => l.id === shape)?.floor, layers = parsedLayers(X.inputs), path = ["routing", "floors", shape];
  const files = [at(layers.repo, path) !== undefined ? "this project's settings" : "", at(layers.user, path) !== undefined ? "your settings" : ""].filter(Boolean);
  return `${f?.tier ?? "none"}, ${f?.own ? "this shape's own" : "from the mode"}${files.length ? `, held in ${files.join(" over ")}` : ""}`;
};

const obj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
/**
 * Every key path a file's candidate bytes change against its saved bytes: a value changed, added or removed, a list
 * by its members and their order. The save names each one, so nothing Enter writes goes unsaid (row 499 (h); D-2187 add.418).
 */
export function changedPaths(a: unknown, b: unknown, path: readonly string[] = []): string[][] {
  const A = a == null && obj(b) ? {} : a, B = b == null && obj(a) ? {} : b;
  if (obj(A) && obj(B)) return [...new Set([...Object.keys(A), ...Object.keys(B)])].flatMap((k) => changedPaths(A[k], B[k], [...path, k]));
  return a === undefined ? (b === undefined ? [] : [[...path]]) : b !== undefined && JSON.stringify(a) === JSON.stringify(b) ? [] : [[...path]];
}
/** A file the save writes: its layer and the settings it holds as saved and as Enter writes them. */
export interface Written { layer: Layer; before: unknown; after: unknown }

/** The config keys a pending change speaks for: its line and its bar, an answer's edits, a setting's key. */
const keysOf = (p: Pending): string[] => p.kind === "line" ? [`routing.map.${p.after.shape}`, `routing.floors.${p.after.shape}`]
  : p.kind === "yes" ? (p.item.edits ?? []).map((e) => e.path.join(".")) : p.key ? [p.key] : [];
/** How many leading segments of `path` a key shares with it (a key is dotted; a model id may hold a dot). */
const shared = (path: readonly string[], key: string): number => {
  let k = 0;
  while (k < path.length && (key === path.slice(0, k + 1).join(".") || key.startsWith(`${path.slice(0, k + 1).join(".")}.`))) k++;
  return k;
};
/** A key speaks for a path when one holds the other. */
const covers = (key: string, path: readonly string[]): boolean => { const j = path.join("."); return key === j || key.startsWith(`${j}.`) || j.startsWith(`${key}.`); };

/**
 * The changes, each after and before (5.7; the rows of 5.6), read from the config as saved and the candidate:
 * what Enter writes, never an answer's own words where the candidate holds something else, and every setting the
 * batch writes, a companion one too, under the change it comes with (row 499 (h); D-2187 add.363, add.417).
 */
function changeRows(base: FleetModel, M: FleetModel, pending: readonly Pending[], files: readonly Written[], w: number): OneLine[] {
  const nm = nameIn(M, pending.flatMap((p) => (p.kind === "line" ? [...workerKeys(p.after), ...workerKeys(p.before)] : [])));
  const IND = 7, TAG = 9, SUB = 15;
  const row = (tag: string, segs: OneSeg[], sub?: string): OneLine[] =>
    flow([S(" ".repeat(IND)), S(pad(tag, TAG), tag === "after" ? "ok" : "dim"), ...(sub !== undefined ? [S(pad(sub, SUB))] : []), ...segs], w, IND + TAG + (sub !== undefined ? SUB : 0));
  const keyed = (v: string, path: readonly string[], style?: Style): OneSeg[] => [V(v, style), S("  "), V(path.join("."), "dim")];
  // every key path the candidate bytes change, per file, goes under the change sharing most of its key, after and before;
  // only a setting's own row, which names its key, is not said twice (row 499 (h); D-2187 add.418)
  const named = (p: Pending, j: string): boolean => p.kind !== "line" && p.kind !== "yes" && p.key === j;
  const extra = new Map<number, Array<{ path: string[]; f: Written }>>();
  for (const f of files) for (const path of changedPaths(f.before, f.after)) {
    if (!pending.length || pending.some((p) => named(p, path.join(".")))) continue;
    const score = pending.map((p) => Math.max(0, ...keysOf(p).map((k) => shared(path, k))));
    const to = score.lastIndexOf(Math.max(...score));
    extra.set(to, [...(extra.get(to) ?? []), { path, f }]);
  }
  const where = (f: Written): OneSeg[] => (files.length > 1 ? [S(` in ${f.layer === "user" ? "your settings" : "this project's settings"}`, "dim")] : []);
  return pending.flatMap((p, i): OneLine[] => {
    const lead = (name: string): OneLine[] => flow([S(`  ${i + 1}  `, "bold"), S(name, "bold")], w, 5);
    const more = (extra.get(i) ?? []).flatMap(({ path, f }) => [...row("after", [...keyed(shown(at(f.after, path)), path), ...where(f)]),
      ...row("before", [...keyed(shown(at(f.before, path)), path, "dim"), ...where(f)])]);
    if (p.kind === "line") {
      const subs = afterRows(nm, p.after, M), [barA, barB] = [M, base].map((X) => barOf(X, p.after.shape));
      const bar = (b: string): OneLine[] => (barA === barB ? [] : row("", [S(b)], "bar"));
      return [...lead(p.after.shape), ...subs.flatMap(([l, s], k) => row(k ? "" : "after", s, l || undefined)), ...bar(barA),
        ...row("before", past(savedNow(nm, p.before))), ...bar(barB), ...more];
    }
    if (p.kind === "yes") {
      const own: readonly Edit[] = p.item.edits ?? [], was = wasIn(base);
      // the answer's own words only where the candidate holds what it set; else what Enter writes, and which change made it so
      const held = (e: Edit) => same(at(M.cfg, e.path), e.value);
      const after = p.item.removes?.length && own.every(held) ? p.item.removes.map((r): OneSeg[] => [S("removes "), V(r.what), S(` from ${r.from.join(", ")}`)])
        : own.map((e): OneSeg[] => {
          if (held(e)) return [S(e.label)];
          const by = pending.findIndex((q) => q !== p && keysOf(q).some((k) => covers(k, e.path)));
          const why = by < 0 ? "" : pending[by].kind === "yes" ? `with change ${by + 1}; ` : `superseded by change ${by + 1}; `;
          return [S(`${why}written: `), ...keyed(wasIn(M)(e.path), e.path)];
        });
      const before = p.item.removes?.length && own.every(held) ? p.item.removes.map((r): OneSeg[] => [V(r.what), S(` on ${r.from.join(", ")}`)])
        : own.map((e): OneSeg[] => keyed(was(e.path), e.path));
      return [...lead(p.item.title), ...after.flatMap((s, k) => row(k ? "" : "after", s)), ...before.flatMap((s, k) => row(k ? "" : "before", s)), ...more];
    }
    return [...lead(p.label), ...row("after", [V(p.after), ...(p.key ? [S("  "), V(p.key, "dim")] : [])]), ...row("before", [V(p.before, "dim")]), ...more];
  });
}

/** Who reads a file this save writes, in words (5.7). */
function readBy(src: ScreenSource, d: Derived, layer: Layer, project: string): string {
  if (layer === "repo") return src.inherited
    ? `This checkout has no config of its own: it reads ${src.inherited}. Saving writes a full copy here with these changes; after that, a change to that file no longer reaches this checkout.`
    : "read by this project only";
  const lines = [...new Set(d.edits.filter((e) => e.layer === "user").flatMap((e) => rowOfPath(e.path)).filter((x) => x !== "mode"))];
  return lines.length ? `read by every project with no ${lines.join(", ")} line of its own; ${project} has none` : "read by every project that has no line of its own";
}

/** The save's body (5.7): every row of the design that has a value, then THIS ALSO CHANGES, or the refusal. */
export function saveBody(src: ScreenSource, d: Derived, pending: readonly Pending[], project: string, w: number): OneLine[] {
  const base = d.base as FleetModel, M = d.full ?? base, n = pending.length;
  // the files Enter writes, each read as saved and as the candidate bytes load
  const was = parsedLayers(src.inputs), now = d.texts ? parsedLayers(d.texts) : was;
  const files: Written[] = (d.texts?.touched ?? []).map((layer) => ({ layer, before: was[layer] ?? {}, after: now[layer] ?? {} }));
  const out: OneLine[] = [[S("tickmarkr fleet", "bold"), S("  "), V(project, "dim")], [S("")],
    [S("YOU ARE SAVING", "head"), S(`  ${n} change${n === 1 ? "" : "s"}`, "accent"), S("      nothing is written yet", "dim")], [S("")],
    ...changeRows(base, M, pending, files, w), [S("")]];
  if (d.refused || !d.full || !d.texts) {
    // the loader's or the write path's own words, quoted
    return [...out, [S("REFUSED: nothing can be saved", "fail")], ...wrap(d.refused ?? "", w - 4).map((t): OneLine => [S("  "), V(t, "fail")])];
  }
  const HEAD = 15;
  d.texts.touched.forEach((layer, k) => {
    out.push(...flow([S(pad(k ? "" : "  WRITTEN TO", HEAD), "bold"), S(`${layer === "user" ? "your settings" : "this project's settings"}: `), V(label(src, layer))], w, HEAD),
      ...flow([S(" ".repeat(HEAD)), S(readBy(src, d, layer, project), layer === "repo" && src.inherited ? "warn" : "dim")], w, HEAD));
  });
  const kept = untouched(base, M);
  if (kept.length) out.push(...flow([S(pad("  UNTOUCHED", HEAD), "bold"), S(kept.join(", "))], w, HEAD));
  // silent in the design, so ruled (5.7): where a measure moves the wrong way, every measure that moves, before and after, with `bar` for floor
  const cq = consequence(base, M);
  const barMoved = d.edits.some((e) => e.path[0] === "routing" && (e.path[1] === "floors" || e.path[1] === "mode"));
  const bar = (label: string) => barMoved && /floor/.test(label);
  // any measure that moves the wrong way opens the block, a bar measure too: a moved bar never hides a worse count
  if (cq.changes.some((c) => !c.better)) {
    const lw = Math.max(...cq.changes.map((c) => width(c.label.replace(/floor/g, "bar")))) + 4;
    out.push([S("")], [S("THIS ALSO CHANGES", "head")], ...cq.changes.flatMap((c) => {
      const style: Style | undefined = c.better ? (bar(c.label) ? undefined : "ok") : "fail";
      const word = c.better ? (bar(c.label) ? "the bar moved" : "better") : bar(c.label) ? "worse; the bar moved" : "worse";
      return flow([S(pad(`  ${c.label.replace(/floor/g, "bar")}`, lw)), S(`${c.before} → ${c.after}`, style), S(`   ${word}`, c.better && bar(c.label) ? "dim" : style)], w, lw);
    }));
  }
  return out;
}

/** The file lines (5.7 `d`): each file the save writes, its changed lines beside their numbers, as the 2.26 review drew them. */
export function fileLines(src: ScreenSource, d: Derived, w: number): Line[] {
  const out: Line[] = [];
  for (const layer of d.texts?.touched ?? []) {
    const diff = layerDiff(layer === "repo" ? src.inputs.repoText : src.inputs.userText, layer === "repo" ? d.texts!.repoText : d.texts!.userText);
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

/** The text `--yes` and `--set` print: the 2.26.1 review, unchanged until T15 (5.7; contract 7). */
export function review(src: ScreenSource, d: Derived, w: number): Line[] {
  // what was answered and what was changed is said whole, on as many rows as it takes: a name cut off is a change not shown
  const whole = (mark: string, words: string): Line[] => wrap(words, w - 6).map((t, k): Line => [S(k ? "     " : mark, "dim"), S(t)]);
  const out: Line[] = [
    ...(d.said.length ? [[S(" YOU SAID YES TO", "head")], ...d.said.flatMap((i, n) => whole(`  ${n + 1}  `, i.title))] : []),
    ...(d.hand.length ? [[S(" YOU CHANGED BY HAND", "head")], ...d.hand.flatMap((e) => whole("  ·  ", e.label))] : []),
    [S("")]];
  if (d.refused || !d.base || !d.full || !d.texts) {
    // (the reason under it says why: a config that would not load, or a form the write path does not write through)
    return [...out, [S(" REFUSED: nothing can be saved", "fail")], ...wrap(d.refused ?? "", w - 4).map((t) => [S("  "), S(t, "fail")])];
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
  return [...out, ...fileLines(src, d, w)];
}

/** The save's keys (5.7): Enter only where there is something to save, `d` to the file lines and back. */
export const saveKeys = (refused: boolean, lines: boolean): string =>
  refused ? "Esc back, nothing written" : `Enter save · d ${lines ? "back to the save" : "show the file lines"} · Esc back, nothing written`;

/**
 * The save in exactly `rows` rows: the body from `top`, then the message's row and the keys at the foot.
 * A body taller than the window says what is above and below; ↑↓ scroll it. `max` is the furthest top.
 */
export function saveWindow(body: readonly OneLine[], keys: string, note: string, cols: number, rows: number, top: number): { lines: OneLine[]; max: number } {
  const foot = [...(note ? wrap(note, cols - 4).slice(0, 2).map((t, k): OneLine => [S(k ? "   " : " ▌ ", "accent"), S(t, "bold")]) : [[S("")]]), ...flow([S(keys, "dim")], cols, 0)];
  const room = Math.max(1, rows - foot.length), fits = body.length <= room, h = fits ? room : Math.max(1, room - 1);
  const max = fits ? 0 : body.length - h, from = Math.max(0, Math.min(top, max));
  const shown = body.slice(from, from + h);
  const more = fits ? [] : [[S(`↑↓ ${from ? `${from} more above · ` : ""}${body.length - from - shown.length} more below`, "dim")] as OneLine];
  return { lines: [...shown, ...Array.from({ length: Math.max(0, h - shown.length) }, (): OneLine => [S("")]), ...more, ...foot].slice(0, rows).map((l) => clip(l, cols)), max };
}
