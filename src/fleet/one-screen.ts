// The one screen of `tickmarkr fleet` (queue row 499; D-2187 add.363; contract 5.1, 5.2, 5.6), as the
// design Main draws it: the header, WORKERS in two columns by how complex the task is, GATES, CONSULT,
// KEPT OUT with its reasons, NEEDS YOU, NOT SAVED and the keys. Pure: lines of styled segments from the
// fleet's model, the items, the KEPT OUT data, the pending changes and a cursor. Nothing here reads a
// key or a file; press() in screen.ts moves the cursor over cursorTargets() (row 499; D-2187 add.363).
import { channelKey } from "../adapters/types.js";
import { SHAPES, type Shape } from "../graph/schema.js";
import { resolveSeats } from "../route/seat-resolver.js";
import { head, pct, S, type Seg, type Style, width, windowFrom, wrap } from "./draw.js";
import { namesOf } from "./hand.js";
import type { KeptRule } from "./kept.js";
import { type Line as LineModel, lineOf } from "./lines.js";
import { evidenceAgeDays, type FleetModel, STALE_DAYS } from "./model.js";
import type { Need } from "./needs.js";

/** A segment the product quotes (a model id, a rule, its comment, a config key, a folder name): drawn as written, exempt from 5.1. */
export interface OneSeg extends Seg { verbatim?: true }
export type OneLine = OneSeg[];
export const V = (text: string, style?: Style): OneSeg => ({ ...S(text, style), verbatim: true });

/**
 * A change not saved yet (contract 5.6), in the order made. A line: what it is after and what is saved
 * now. An answered yes: its item. A level, the bar, hardFrom, the mode or a rule: one row, after and
 * saved now, and `key` the config key it writes, quoted; `marks` names the row of the one screen it changes (a shape, judge, review, consult, mode or a rule).
 */
export type Pending =
  | { kind: "line"; after: LineModel; before: LineModel }
  | { kind: "yes"; item: Need }
  | { kind: "setting"; label: string; after: string; before: string; marks?: string; key?: string };

export interface OneScreenInput {
  M: FleetModel; project: string; items: readonly Need[]; yes?: readonly string[];
  kept: readonly KeptRule[]; pending: readonly Pending[];
  /** over the mode, each WORKERS row, judge, review, consult, each KEPT OUT row and its + row, then each item; on a window too short, a page of a taller row and the lines below the last item take places too */
  cursor: number;
  /** one message, drawn on the row above the keys */
  note?: string;
}

export const MIN_COLS = 80, MIN_ROWS = 20;
const MODE_WORDS: Record<string, string> = {
  "partner-led": "frontier models only", "risk-based": "each shape keeps its own bar", "staff-led": "one level lower; plan, spec, migration, ui stay frontier",
};
const KEYS = "↑↓ move · Enter change the line · y n answer · s save · u undo · r check again · ? help · q quit";
const LABEL = 28, SUB = 15;
const pad = (t: string, n: number): string => t + " ".repeat(Math.max(1, n - width(t)));

/**
 * A row of segments flowed into rows of exactly `w` cells: a row too wide wraps onto continuation rows
 * indented by `indent` cells and is never cut (contract 5.2, the smallest window). A word wider than a
 * row is split across rows, never dropped.
 */
export function flow(segs: readonly OneSeg[], w: number, indent = LABEL): OneLine[] {
  const ind = Math.min(indent, Math.floor(w / 2));
  const out: OneLine[] = [];
  let cur: OneLine = [], used = 0, from: OneSeg | null = null;
  const push = () => { out.push(used < w ? [...cur, S(" ".repeat(w - used))] : cur); cur = [S(" ".repeat(ind))]; used = ind; from = null; };
  // tokens of one segment on one row stay one segment: a quoted comment is drawn, and found, whole
  const put = (seg: OneSeg, t: string) => {
    if (from === seg) cur[cur.length - 1] = { ...cur[cur.length - 1], text: cur[cur.length - 1].text + t };
    else cur.push({ ...seg, text: t });
    from = seg; used += width(t);
  };
  for (const seg of segs) {
    for (const tok of seg.text.split(/(\s+)/).filter(Boolean)) {
      const blank = /^\s+$/.test(tok);
      if (used + width(tok) > w) {
        if (blank) { push(); continue; }
        if (used > ind) push();
        let rest = tok;
        while (used + width(rest) > w) { const h = head(rest, w - used) || [...rest][0]; put(seg, h); rest = rest.slice(h.length); push(); }
        if (rest) put(seg, rest);
        continue;
      }
      if (blank && used === ind && out.length) continue;
      put(seg, tok);
    }
  }
  push();
  return out;
}

/** Names told apart over every model drawn together (5.1): two models of one name never read as one. */
export type Names = (keys: readonly string[], sep?: string) => string;
export const nameIn = (M: FleetModel, all: readonly string[]): Names => {
  const unique = [...new Set(all)], n = namesOf(M, unique);
  return (keys: readonly string[], sep = " + "): string => keys.map((k) => n[unique.indexOf(k)]).join(sep);
};
export const workerKeys = (l: LineModel): string[] => l.givenOut === "complexity" ? (l.groups ?? []).flatMap((g) => g.models.map((m) => m.key))
  : l.givenOut === "order" ? [...(l.order?.works ? [l.order.works] : []), ...(l.order?.backups ?? [])]
  : [...(l.order?.gets ?? []).map((m) => m.key), ...(l.order?.none ?? []).map((m) => m.key)];
/** Row 499; D-2187 add.363, add.386: group by routing method and model keys, never by their printed names. */
const workerRoute = (l: LineModel): unknown => [l.givenOut, l.givenOut === "complexity"
  ? (l.groups ?? []).map((g) => [g.range, g.models.map((m) => m.key)]) : l.givenOut === "order"
    ? [l.order?.works ?? null, l.order?.backups ?? []]
    : [(l.order?.gets ?? []).map((m) => m.key), (l.order?.none ?? []).map((m) => m.key)]];
/** A line of WORKERS as the contract says (5.2): its two columns, or one sentence across both. */
function workersText(nm: Names, l: LineModel): { col1?: OneSeg[]; rest: OneSeg[] } {
  if (l.givenOut === "complexity") {
    const g = (l.groups ?? []).filter((x) => x.models.length);
    if (!g.length) return { rest: [S("nobody", "fail")] };
    const names = (i: number) => nm(g[i].models.map((m) => m.key));
    if (g.length === 1) return { rest: [V(names(0)), S(g[0].models.length > 1 ? " share every task" : " does every task")] };
    // three or more groups: the other groups joined ` / `, strongest first
    return { col1: [V(names(0))], rest: [V(g.slice(1).map((_, i) => names(i + 1)).join(" / "))] };
  }
  if (l.givenOut === "order") {
    const works = l.order?.works ?? null, backups = l.order?.backups ?? [];
    return { rest: [...(works ? [V(nm([works])), S(" does every task")] : [S("nobody", "fail")]),
      ...(backups.length ? [S("   backup ", "dim"), V(nm(backups, ", "), "dim")] : [])] };
  }
  if (l.givenOut === "any") {
    // saved before 2.27: shown as it routes, beside the models that get no tasks (as ruled), never as by complexity
    const gets = (l.order?.gets ?? []).map((x) => x.key), none = (l.order?.none ?? []).map((x) => x.key);
    return { rest: [...(gets.length ? [V(nm(gets)), S(gets.length > 1 ? " share every task" : " does every task")] : [S("nobody", "fail")]),
      ...(none.length ? [S("   no tasks: ", "warn"), V(nm(none, ", "), "warn")] : [])] };
  }
  return { rest: [S("the cheapest model at the bar takes each task", "dim")] };
}
const plain = (segs: readonly OneSeg[]): string => segs.map((s) => s.text).join("").trim();

/** A shape's status word, only where the line is not ok (contract 5.2, ruled). */
function shapeStatus(M: FleetModel, shape: Shape): [string, Style] | null {
  const r = M.sample().rows[shape];
  return r.unstaffed ? ["NO MODEL", "fail"] : r.under ? [`${pct(r.under)} below the bar`, "warn"] : null;
}

/** The row of the one screen an edit at this config path changes: a shape's line, judge, review, consult or the mode. */
export function rowOfPath(path: readonly string[]): string[] {
  if (path[0] === "routing" && path[1] === "map" && path[2]) return [path[2]];
  if (path[0] === "routing" && path[1] === "mode") return ["mode"];
  return ["judge", "review", "consult"].includes(path[0]) ? [path[0]] : [];
}

/** A stop of the cursor names what Enter opens: `mode`, `shapes:<a,b>`, `judge`, `review`, `consult`, `kept:<list>` (`kept:<list>#<n>` for a list's later rules), `kept+` or `item:<id>`. */
interface Row { segs: OneSeg[]; stop?: true; id?: string; indent?: number }
const titled = (name: string, words: string, style: Style = "head"): Row => ({ segs: [S(name, style), S(`  ${words}`, "dim")] });

/**
 * Row 499; D-2187 add.390, add.391: who judges, as the product's own answer. Ask the resolution a run uses
 * who judges a task written by each worker that takes sample tasks (open lines included; a dead or idle
 * backup writes none), with the vendor of its worker channel, and group the answers by judge, the most
 * vendors first. `when(k)` says when `k` judges: ` when <vendors> wrote the task`, or ` on the other tasks`.
 * The one screen's GATES row and the judge's opened view (row 499; D-2187 add.363) both read this.
 */
export function judgesOf(M: FleetModel): { judges: string[]; when: (k: string) => string } {
  const judge = channelKey(M.cfg.judge);
  const byJudge = new Map<string, Set<string>>();
  const writers = M.sample().workers.map((x) => x.key);
  for (const author of writers.length ? writers : [null]) {
    const r = resolveSeats({ role: "judge", cfg: M.cfg, pool: M.pools.judge, authorPool: M.pools.review, health: M.health, authors: author ? [author] : [] });
    if (r.disallowed || !r.pick) continue;
    const k = channelKey(r.pick), v = (author && M.pools.worker.find((c) => channelKey(c) === author)?.vendor) || "unknown";
    byJudge.set(k, (byJudge.get(k) ?? new Set()).add(v));
  }
  const judges = [...byJudge.keys()].sort((a, b) => byJudge.get(b)!.size - byJudge.get(a)!.size || Number(b === judge) - Number(a === judge));
  const vendor = (p: string) => (p === "anthropic" ? "Claude" : p === "openai" ? "OpenAI" : p[0]?.toUpperCase() + p.slice(1));
  // a vendor the product calls unknown is never named as a trigger
  const when = (k: string): string => {
    const vs = [...(byJudge.get(k) ?? [])].filter((v) => v !== "unknown").map(vendor);
    return vs.length ? ` when ${vs.length > 1 ? `${vs.slice(0, -1).join(", ")} or ${vs[vs.length - 1]}` : vs[0]} wrote the task` : " on the other tasks";
  };
  return { judges, when };
}

function body(inp: OneScreenInput): Row[] {
  const { M, pending } = inp;
  const marked = new Set(pending.flatMap((p) => (p.kind === "line" ? [p.after.shape] : p.kind === "setting" ? (p.marks ? [p.marks] : [])
    : [...(p.item.edits ?? []).flatMap((e) => rowOfPath(e.path)), ...(p.item.removes ?? []).flatMap((r) => r.from)])));
  const mark = (ids: readonly string[]): OneSeg[] => (ids.some((x) => marked.has(x)) ? [S("   ●", "accent")] : []);
  const status = (s: [string, Style] | null): OneSeg[] => (s ? [S(`   ${s[0]}`, s[1])] : []);
  const rows: Row[] = [];

  // the header: the project, the models that work, when they were checked, the mode in words
  const age = evidenceAgeDays(M);
  const checked = age === undefined ? "not checked yet" : age < 1 ? "checked today" : `checked ${Math.floor(age)} day${Math.floor(age) === 1 ? "" : "s"} ago`;
  // the cursor's place ("  ", "▸ " when on it) leads the header as it leads every row it stops on
  rows.push({ stop: true, id: "mode", indent: 2, segs: [S("  "), S("tickmarkr fleet", "bold"), S("  "), V(inp.project, "dim"),
    // old evidence warns from the day it is stale, as the 2.26 header did
    S(` · ${M.working} model${M.working === 1 ? " works" : "s work"} · `, "dim"), S(checked, age !== undefined && age > STALE_DAYS ? "warn" : "dim"), S(" · mode ", "dim"), V(M.mode.mode, "accent"),
    S(` (${MODE_WORDS[M.mode.mode] ?? ""})`, "dim"), ...mark(["mode"])] }, { segs: [] });

  // WORKERS: group keys and way first; only then name the models over all rows shown together.
  const hard = M.cfg.routing.hardFrom;
  const lines = SHAPES.map((shape) => ({ shape, line: lineOf(M, shape), st: shapeStatus(M, shape) }));
  const grouped: Array<{ shapes: Shape[]; line: LineModel; st: [string, Style] | null; key: string }> = [];
  for (const l of lines) {
    const key = JSON.stringify([workerRoute(l.line), l.st, marked.has(l.shape)]);
    const g = grouped.find((x) => x.key === key);
    if (g) g.shapes.push(l.shape); else grouped.push({ shapes: [l.shape], line: l.line, st: l.st, key });
  }
  const allWorkers = [...new Set(grouped.flatMap((g) => workerKeys(g.line)))];
  const judge = channelKey(M.cfg.judge), { judges, when } = judgesOf(M);
  // Row 499; D-2187 add.390: one set of names for the whole screen, pending and saved together.
  const sim = M.sample();
  const reviewers = sim.reviewers.map((x) => x.key);
  const consultOthers = (M.cfg.consult.prefer ?? []).filter((k) => k !== M.consult);
  const nm = nameIn(M, [...allWorkers, judge, ...judges, ...reviewers, ...(M.consult ? [M.consult] : []), ...consultOthers,
    ...pending.flatMap((p) => (p.kind === "line" ? [...workerKeys(p.after), ...workerKeys(p.before)] : []))]);
  const groups = grouped.map((g) => ({ ...g, text: workersText(nm, g.line) }));
  const labelOf = (shapes: Shape[]): string => {
    const rest = SHAPES.filter((x) => !shapes.includes(x)), named = shapes.join(", ");
    return !rest.length ? "every shape" : named.length > 24 && rest.join(", ").length + 8 < named.length ? `all but ${rest.join(", ")}` : named;
  };
  const lw = Math.max(LABEL, ...groups.map((g) => width(labelOf(g.shapes)) + 4));
  const c1 = Math.max(22, ...groups.map((g) => (g.text.col1 ? width(plain(g.text.col1)) + 2 : 0)));
  rows.push(titled("WORKERS", "who does each shape of work, by how complex the task is"),
    { segs: [S(" ".repeat(lw)), S(pad(`VERY COMPLEX ${hard}-10`, c1), "dim"), S(`THE REST 1-${hard - 1}`, "dim")] });
  for (const g of groups) {
    const first = g.text.col1 ? [...g.text.col1, S(" ".repeat(Math.max(1, c1 - width(plain(g.text.col1)))))] : [];
    rows.push({ stop: true, id: `shapes:${g.shapes.join(",")}`, indent: lw, segs: [S("  "), S(pad(labelOf(g.shapes), lw - 2)), ...first, ...g.text.rest, ...status(g.st), ...mark(g.shapes)] });
  }

  // GATES and CONSULT keep their rows
  const routed = Math.max(1, sim.routed);
  // the configured judge's own state; drawn beside the judges resolution uses when it is not one of them
  const cfgSeat = M.seat(judge);
  const cfgWord = cfgSeat?.denied.judge ? "kept out" : !cfgSeat?.live.judge ? "does not answer" : null;
  const judgeSt: [string, Style] | null = !judges.length ? ["NO MODEL", "fail"]
    : cfgWord ? [judges.includes(judge) ? cfgWord : `${nm([judge])} ${cfgWord}`, "fail"]
    : sim.ownVendor ? [`${pct((100 * sim.ownVendor) / routed)} own vendor`, "warn"] : null;
  const reviewSt: [string, Style] | null = !reviewers.length ? ["NO MODEL", "fail"] : sim.noReviewer ? [`${pct((100 * sim.noReviewer) / routed)} unreviewed`, "warn"] : null;
  const gate = (label: string, segs: OneSeg[], id?: string, st: [string, Style] | null = null): Row =>
    ({ ...(id ? { stop: true as const, id } : {}), indent: lw, segs: [S("  "), S(pad(label, lw - 2)), ...segs, ...status(st), ...mark(id ? [id] : [])] });
  const judgeSegs: OneSeg[] = !judges.length ? [S("nobody", "fail")] : [V(judges.length > 1 ? pad(nm([judges[0]]), c1) : nm([judges[0]])),
    ...judges.slice(1).flatMap((k, i) => [...(i ? [S("; ", "dim")] : []), V(nm([k]), "dim"), S(when(k), "dim")])];
  rows.push(titled("GATES", "in order; the first five need no model"),
    gate("build, test, lint", [S("your commands", "dim")]), gate("evidence, scope", [S("built in", "dim")]),
    gate("acceptance (judge)", judgeSegs, "judge", judgeSt),
    gate("review (another vendor)", reviewers.length ? [V(nm(reviewers))] : [S("nobody", "fail")], "review", reviewSt),
    titled("CONSULT", "asked when a task stalls or the gates conflict"),
    gate("consult", M.consult ? [V(pad(nm([M.consult]), c1)), ...(consultOthers.length ? [S("then ", "dim"), V(nm(consultOthers, ", "), "dim")] : [])] : [S("nobody", "fail")],
      "consult", M.consult ? null : ["NO MODEL", "fail"]),
    gate("overseer skill", [S(M.consult ? "uses consult and review" : "needs the consult", M.consult ? "dim" : undefined)], undefined, M.consult ? null : ["CANNOT START", "fail"]));

  // KEPT OUT: every rule beside its reason, as written; then its + row
  rows.push(titled("KEPT OUT", "never used, whatever is ticked; no yes/no item removes these"));
  // a rule's place names its list and, after the first rule of that list, its place in it: `kept:<list>#<n>` (row 500)
  const nth = new Map<string, number>();
  for (const r of inp.kept) {
    const n = nth.get(r.list) ?? 0;
    nth.set(r.list, n + 1);
    const reason: OneSeg[] = r.reason === null ? (r.says ? [S(r.says, "dim")] : []) : [V(r.reason, "dim"), ...(r.workersOnly ? [S(" · workers only", "dim")] : [])];
    rows.push({ stop: true, id: `kept:${r.list}${n ? `#${n}` : ""}`, indent: lw, segs: [S("  "), V(pad(r.rule, lw - 2)), ...reason, ...mark([r.rule])] });
  }
  rows.push({ stop: true, id: "kept+", indent: lw, segs: [S("  "), S("+ keep a model or a CLI out", "accent")] }, { segs: [] });

  // NEEDS YOU: its head is drawn when there is none too
  const yes = new Set(inp.yes ?? []);
  rows.push({ segs: [S(`NEEDS YOU (${inp.items.length})`, "head")] });
  if (!inp.items.length) rows.push({ indent: 2, segs: [S("  Nothing. Every shape, gate and the consult has a working model.")] });
  // Items own their wording (D-2187 add.386): draw it whole, without recognizing ids inside it.
  inp.items.forEach((n, i) => rows.push({ stop: true, id: `item:${n.id}`, indent: 5, segs: [S("  "), S(yes.has(n.id) ? "✓" : " ", "ok"), S(pad(String(i + 1), 3)), S(n.title)] }));

  // NOT SAVED: every pending change in words, after and saved now; absent when nothing is pending
  if (pending.length) {
    rows.push({ segs: [] }, { segs: [S("NOT SAVED", "head"), S(`  ${pending.length} change${pending.length === 1 ? "" : "s"}`, "accent"),
      S("  ● marks the line · nothing is written until you press s", "dim")] });
    const sub = (label: string, segs: OneSeg[], style?: Style): Row => ({ indent: lw + SUB, segs: [S(" ".repeat(lw)), S(pad(label, SUB), style), ...segs] });
    pending.forEach((p, i) => {
      const num = pending.length > 1 ? `${i + 1}  ` : "";
      const lead = (name: string, segs: OneSeg[]): Row => ({ indent: lw + SUB, segs: [S("  "), S(pad(`${num}${name}`, lw - 2)), ...segs] });
      if (p.kind === "line") {
        const subs = afterRows(nm, p.after, inp.M);
        rows.push(lead(p.after.shape, [S(pad(subs[0][0], SUB)), ...subs[0][1]]), ...subs.slice(1).map(([l, s]) => sub(l, s)),
          sub("saved now", savedNow(nm, p.before), "dim"));
      } else if (p.kind === "yes") {
        rows.push({ indent: lw, segs: [S("  "), S(num), S(p.item.title)] },
          ...(p.item.removes?.length ? p.item.removes.map((r) => ({ indent: lw, segs: [S(" ".repeat(lw)), S("removes "), V(r.what), S(` from ${r.from.join(", ")}`)] }))
            : (p.item.edits ?? []).map((e) => ({ indent: lw, segs: [S(" ".repeat(lw)), S(e.label)] }))));
      } else {
        rows.push({ indent: lw, segs: [S("  "), S(pad(`${num}${p.label}`, lw - 2)), V(p.after), ...(p.key ? [S("  "), V(p.key, "dim")] : [])] }, sub("saved now", [V(p.before, "dim")], "dim"));
      }
    });
  }
  return rows;
}

/** A pending line's rows after the change (5.6): very complex and the rest, one row a group past two, in order, or the one sentence. */
export function afterRows(nm: Names, l: LineModel, M?: FleetModel): Array<[string, OneSeg[]]> {
  const g = (l.groups ?? []).filter((x) => x.models.length);
  if (l.givenOut === "complexity" && g.length >= 2) {
    const names = (i: number): OneSeg[] => [V(nm(g[i].models.map((m) => m.key)))];
    if (g.length === 2 && g[0].range && g[1].range) return [["very complex", names(0)], ["the rest", names(1)]];
    return g.map((x, i) => [x.range ? `complexity ${x.range[0]}-${x.range[1]}` : "backup group", names(i)]);
  }
  if (l.givenOut === "order") {
    // the order as it is written, never the working model first: a model down keeps its place (row 499 (h); D-2187 add.417)
    // (read from M only when M is the team this line was read from: the same models, in any order)
    const slot = M?.cfg.routing.map[l.shape], line = [...(l.order?.works ? [l.order.works] : []), ...(l.order?.backups ?? [])];
    const written = slot?.pool?.channels ?? (slot?.pin ? [`${slot.pin.via}:${slot.pin.model}`] : []);
    const all = written.length === line.length && line.every((k) => written.includes(k)) ? written : line;
    return [["in order", [V(nm(all, ", "))]]];
  }
  const t = workersText(nm, l);
  return [[l.givenOut === "complexity" ? "by complexity" : "", t.rest]];
}
/** The line as the one screen showed it before, in one row of words; its names stay quoted. */
export function savedNow(nm: Names, l: LineModel): OneSeg[] {
  const t = workersText(nm, l), dim = (xs: readonly OneSeg[]) => xs.map((x) => ({ ...x, style: "dim" as Style }));
  return t.col1 ? [S("very complex ", "dim"), ...dim(t.col1), S("; the rest ", "dim"), ...dim(t.rest.map((x, i) => (i === 0 ? { ...x, text: x.text.trimStart() } : x)))] : dim(t.rest);
}

/** The sentence the frame is below 80 columns or 20 rows, read from the terminal's real size (5.2). */
export const tooSmall = (cols: number, rows: number): string =>
  `tickmarkr fleet needs a window of at least ${MIN_COLS} columns by ${MIN_ROWS} rows; this one is ${cols} by ${rows}.`;

/**
 * Where the cursor can stand, in order: each stop, and on a window too short for the whole screen also
 * each page of a stop taller than the window and each step over lines no stop reaches (a gap, the NOT
 * SAVED block at the end), so every line is on some frame. `places` is null when the whole screen fits:
 * then the cursor moves over the stops alone.
 */
function layout(inp: OneScreenInput, w: number, h: number) {
  const all = body(inp);
  const stops = all.flatMap((r, i) => (r.stop ? [i] : []));
  const draw = (at: number): OneLine[][] => all.map((r, i) => {
    const segs = i !== at ? r.segs : r.segs.map((s, k): OneSeg => ({ ...s, selected: true, ...(k === 0 && s.text === "  " ? { text: "▸ ", style: "accent" as Style } : {}) }));
    return flow(segs, w, r.indent ?? 2);
  });
  // Two rows above the keys are the message's, blank or not, so no message ever moves the cursor's
  // places: what Enter opens is what the frame on screen shows (row 499; D-2187 add.363). A message
  // longer than two rows ends its second in " …", as the 2.26 frame did.
  const said = inp.note ? wrap(inp.note, w - 6) : [];
  const note = [0, 1].map((k): OneLine => (said[k] === undefined ? [S(" ".repeat(w))]
    : flow([S(k ? "   " : " ▌ ", "accent"), S(k && said.length > 2 ? `${said[1]} …` : said[k], "bold")], w, 3)[0]));
  const keys = [...note, ...flow([S(KEYS, "dim")], w, 0)];
  const plainRows = draw(-1), total = plainRows.reduce((n, d) => n + d.length, 0), avail = h - keys.length;
  if (total <= avail) return { all, stops, draw, keys, avail, total, plainRows, places: null };
  const inner = avail - 2, top = total - inner;
  const start: number[] = [];
  plainRows.reduce((n, d, i) => ((start[i] = n), n + d.length), 0);
  const places: Array<{ row: number; from: number }> = [];
  let seen = 0;
  const reach = (row: number, from: number) => {
    while (from > seen) { places.push({ row, from: Math.min(seen, top) }); seen = Math.min(seen, top) + inner; }
    places.push({ row, from }); seen = Math.max(seen, from + inner);
  };
  for (const s of stops) {
    const d = plainRows[s].length;
    if (d <= inner) reach(s, windowFrom(start[s] + d - 1, total, inner));
    else for (let p = 0; p < d; p += inner) reach(s, Math.min(start[s] + p, top));
  }
  const last = stops.length ? stops[stops.length - 1] : -1;
  while (seen < total) { places.push({ row: last, from: Math.min(seen, top) }); seen = Math.min(seen, top) + inner; }
  return { all, stops, draw, keys, avail, total, plainRows, places, inner, start };
}

/** Below 80 columns or 20 rows, read from the terminal's real size: the frame of the one screen and of every view it opens (5.2). */
export const tiny = (cols: number, rows: number): boolean => cols < MIN_COLS || rows < MIN_ROWS;
/** That frame: the sentence and `q quit`, nothing else, exactly `rows` rows of `cols` cells. */
export function smallScreen(cols: number, rows: number): OneLine[] {
  const w = Math.max(1, cols), h = Math.max(0, rows);
  // ponytail: below 1 row there is nothing to draw; a window too small for the sentence shows its head
  const ls = [...wrap(tooSmall(cols, rows), w).flatMap((t) => flow([S(t)], w, 0)), ...flow([S("q quit", "dim")], w, 0)];
  return [...ls, ...Array.from({ length: Math.max(0, h - ls.length) }, () => [S(" ".repeat(w))])].slice(0, h);
}
/**
 * What each place of the cursor is on (row 499; D-2187 add.363): the id of its row, one entry a place,
 * in the order up and down move. Empty on a window below 80 by 20, where no key but q does anything.
 */
export function cursorTargets(inp: OneScreenInput, cols: number, rows: number): string[] {
  if (tiny(cols, rows)) return [];
  const l = layout(inp, Math.max(1, cols), Math.max(0, rows));
  if (!l.places) return l.stops.map((row) => l.all[row]?.id ?? "");
  // A place whose frame does not show the row's ▸ (a later page of a taller row, a step over NOT SAVED
  // or a gap) is on nothing: Enter, y and n act only on what the drawn cursor is on (row 499; D-2187 add.363).
  return l.places.map((p) => (l.start[p.row] >= p.from && l.start[p.row] < p.from + l.inner ? l.all[p.row]?.id ?? "" : ""));
}

/** The one screen: exactly `rows` rows of exactly `cols` cells. */
export function oneScreen(inp: OneScreenInput, cols: number, rows: number): OneLine[] {
  const w = Math.max(1, cols), h = Math.max(0, rows);
  const fill = (ls: OneLine[]): OneLine[] => [...ls, ...Array.from({ length: Math.max(0, h - ls.length) }, () => [S(" ".repeat(w))])].slice(0, h);
  if (tiny(cols, rows)) return smallScreen(cols, rows);
  const { stops, draw, keys, avail, total, places, inner = 0 } = layout(inp, w, h);
  if (!places) {
    const flat = draw(stops.length ? stops[Math.max(0, Math.min(inp.cursor, stops.length - 1))] : -1).flat();
    return fill([...flat, ...Array.from({ length: avail - flat.length }, () => [S(" ".repeat(w))]), ...keys]);
  }
  // too short for the whole screen: the sections keep their order and the screen scrolls with the
  // cursor; what is above or below is counted, never cut silently (the 2.26.0 rule).
  const place = places[Math.max(0, Math.min(inp.cursor, places.length - 1))];
  const flat = draw(place.row).flat(), from = place.from;
  const above = from, below = total - from - inner;
  const note = (t: string): OneLine => flow([S(t, "dim")], w, 0)[0];
  return fill([note(above ? `↑ ${above} more above` : ""), ...flat.slice(from, from + inner), note(below > 0 ? `↓ ${below} more below` : ""), ...keys]);
}
