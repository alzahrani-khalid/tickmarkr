// The two views of changing a line by hand: the list of lines, and one line opened with the models
// that may take it. Drawn from the model; the keys and the state live in screen.ts.
import { cap, clip, fit, type Line, S, width, windowFrom, wrap } from "./draw.js";
import { DENY_SCOPES } from "../config/config.js";
import { ruleList } from "./rules.js";
import { type FloorChoice, floorOf, type HandLine, handLines, liftReach, MODE_SAYS, namesOf } from "./hand.js";
import type { FleetModel } from "./model.js";

/** CHANGE A LINE: every line a hand can change, with who is on it now. */
export function linesView(M: FleetModel, changed: ReadonlySet<string>, cursor: number, w: number, h: number): Line[] {
  const lines = handLines(M);
  // one row is kept for the heading that sets the deny lists apart from the team's lines
  const at = Math.min(cursor, lines.length - 1), room = Math.max(1, h - 3), from = windowFrom(at, lines.length, room);
  const out: Line[] = [[S(" CHANGE A LINE", "bold"), S("  Enter opens one   × not working now", "dim")]];
  const idw = Math.max(...lines.map((l) => width(l.id))) + 1;
  lines.slice(from, from + room).forEach((l, k) => {
    const on = from + k === at;
    if (l.deny && k > 0 && !lines[from + k - 1].deny) out.push([S("   deny lists", "head"), S("  what is ticked on one is kept out", "dim")]);
    // what the config names on the line, in its order; a model that is not working for that role is marked, not hidden
    const names = namesOf(M, l.current);
    // a deny list is shown as it is written: an entry there is a rule, not a model at work
    const who: Line = l.setting ? [S(l.current.join(" · "))] : l.deny ? [S(l.current.join(" · ") || "nothing", "dim")]
      : l.current.length ? l.current.flatMap((x, i): Line => { const works = !!M.seat(x)?.live[l.role]; return [...(i ? [S(" · ", "dim")] : []), S(works ? names[i] : `×${names[i]}`, works ? undefined : "warn")]; }).concat(l.pinned ? [S("  pinned", "dim")] : [])
      // a line that names nobody says why in a few words; the opened line says the rest
      : [S(l.note.split(";")[0], "dim")];
    const row = clip([S(on ? " ▸ " : "   ", "accent"), S(fit(l.id, idw), on ? "bold" : undefined), S(changed.has(l.id) ? "• " : "  ", "ok"), ...who], w);
    out.push(on ? row.map((x) => ({ ...x, selected: true })) : row);
  });
  if (lines.length > from + room) out.push([S(`     … ${lines.length - from - room} more below`, "dim")]);
  return out;
}

/** Why a model on an opened line is not simply there to tick: a few words for its row, and the whole of it for the row under the cursor. */
function reason(M: FleetModel, line: HandLine, k: string, ticked: boolean, under = false): { tag: string; full: string; calm?: true } {
  const seat = M.seat(k);
  // a key written as an alias says which model it is, where the whole of a row is said
  const r = why(M, line, k, ticked, under), is = seat && seat.name !== k.slice(Math.max(k.indexOf(":"), k.lastIndexOf("/")) + 1) ? seat.name : "";
  return !is ? r : r.full ? { tag: r.tag, full: r.full.replace(k, `${k} (${is})`) } : { tag: r.tag, full: `${k} is ${is}.`, calm: true };
}
function why(M: FleetModel, line: HandLine, k: string, ticked: boolean, under: boolean): { tag: string; full: string; calm?: true } {
  const seat = M.seat(k);
  // (under the cursor a setting says what it does in full as well: on a narrow terminal its row has no room for it)
  if (line.setting) { const says = (MODE_SAYS as Record<string, string>)[k] ?? ""; return { tag: says, full: under && says ? `${k}: ${says}.` : "", calm: true }; }
  if (line.deny) {
    // another entry of the list already covers it (a list for every seat is asked as a judge would be: the workers' lists do not reach a judge)
    const rule = ticked ? null : seat?.denied[line.path[2] === "workers" ? "worker" : "judge"];
    if (rule?.by !== "deny") return { tag: "", full: "" };
    const there = DENY_SCOPES.find((sc) => ruleList(M.cfg.routing, sc.path).includes(rule.entry))?.path.slice(1).join(".") ?? "another list";
    return { tag: `denied in ${there}`, full: `${k} is already denied${rule.entry === k ? "" : ` by the entry ${rule.entry}`} in ${there}.` };
  }
  if (!seat) return { tag: "not a configured model", full: `${k} is named on this line, and no CLI in the config lists it.` };
  if (seat.live[line.role]) return { tag: "", full: "" };
  const kept = line.barred[k];
  if (!kept) return seat.denied[line.role] ? { tag: "kept out by a rule", full: `${k} is kept out by a rule, and does not answer either: ${seat.verdict.text}.` } : { tag: seat.verdict.text, full: `${k}: ${seat.verdict.text}.` };
  const tag = seat.denied[line.role]?.by === "allow" ? "not on the allowlist" : "denied";
  // named on the line in the config already: a tick here did not put it there, and lifts nothing
  if (line.current.includes(k)) return { tag, full: `${k} is named on this line and answers, and is kept out by ${kept.why}. Untick it on its deny line to let it work here.` };
  if (!kept.liftable) return { tag: `${tag} by a wider rule`, full: `${k} answers, and is kept out by ${kept.why}. Change that on its deny line.` };
  // said before the tick, not found out in the review: the lift reaches every other line that names the model
  if (ticked) return { tag, full: `${k}: this tick lifts the rule that kept it out, in the same save.` };
  const { named, open, seats } = under ? liftReach(M, line, k) : { named: [], open: [], seats: [] };
  return { tag, full: `${k} answers, and is kept out by ${kept.why}. A tick lifts that in the same save.`
    + (named.length ? ` It comes back on ${named.join(", ")} too, which ${named.length === 1 ? "names" : "name"} it.` : "")
    + (open.length ? ` It may also take ${open.join(", ")}: no pool there.` : "")
    + (seats.length ? ` It may then ${seats.join(", ").replace(/, ([^,]*)$/, " and $1")} too: no rule keeps it from one seat alone.` : "") };
}

/** One line opened: the models that may take it, ticked in the order they are tried. */
export function pickView(M: FleetModel, p: { line: string; chosen: string[]; at: number; mode?: "any" | "ordered"; floor?: FloorChoice }, w: number, h: number, takes?: { n: ReadonlyMap<string, number>; of: number; today?: true }): Line[] {
  const line = handLines(M).find((l) => l.id === p.line);
  if (!line) return [[S(" That line is gone.", "warn")]];
  const title: Line = [S(` ${line.id}`, "bold"), S(line.setting ? "  choose one" : line.deny ? "  tick what is denied" : line.one ? "  choose the model" : w < 80 ? "  tick its models, in order" : "  tick the models for it; the numbers are the order", "dim")];
  const today = wrap(`Today: ${line.current.length ? line.current.join(", ") : line.deny ? "nothing" : "nobody named"}. ${cap(line.note)}.`, w - 3).map((t): Line => [S("  "), S(t, "dim")]);
  // what the mode does, in the words of the router: it decides who takes the work more than the ticks do
  // (said once there is a pool to speak of: one in the config, or a tick that makes one)
  const says: Line[] = (line.mode && (line.current.length || p.chosen.length) ? wrap((p.mode ?? line.mode) === "ordered" ? "Pool mode ordered: the first that works takes every task, the rest stand by. o makes it any."
      : "Pool mode any: the cheapest takes each task; vendors at one cost take turns; of one vendor's models, the first ticked. o makes it ordered.", w - 3).map((t): Line => [S("  "), S(t, "accent")]) : []);
  // the shape's floor: what the mode says, or a tier set for this shape; a task routed below it is counted on the team's line
  const fl = p.floor ?? floorOf(line);
  const floor: Line[] = !line.floor || !fl ? [] : wrap(fl === "mode" ? `Floor: what mode ${M.mode.mode} says${!line.floor.own && line.floor.tier ? ` (${line.floor.tier})` : ""}. f sets one for this shape.`
    : `Floor: ${fl}, set for this shape; it beats the mode. f changes it.`, w - 3).map((t): Line => [S("  "), S(t, "dim")]);
  // a line kept in the user config is every repository's: said on the line, before the change, as the review says it after
  const reach: Line[] = line.layer === "user" ? wrap("This line is in your user config: every repository on this machine reads it.", w - 3).map((t): Line => [S("  "), S(t, "warn")]) : [];
  const whole: Line[] = [title, ...today, ...reach, ...says, ...floor, [S("")]];
  if (!line.candidates.length) return [...whole, [S(line.deny ? "  The config has no model to deny." : "  No working model may take this line. Fix one, then Esc and r to probe.", "warn")]];
  const at = Math.min(p.at, line.candidates.length - 1);
  // a model ticked on a shape that gets none of its tasks says why: "I added it and nothing changed" is answered here
  // (a model ticked here whose own rule the tick lifts is working as far as these ticks go)
  const part = (k: string) => (takes && !takes.today && p.chosen.includes(k) && (M.seat(k)?.live[line.role] || (line.barred[k]?.liftable && !line.current.includes(k))) ? takes.n.get(k) ?? 0 : undefined);
  const cur = line.candidates[at], about = reason(M, line, cur, p.chosen.includes(cur), true), told = about.full;
  // ... and what to press: in an ordered pool the first that works takes every task, so this is always true
  const none = part(cur) === 0 ? `${told ? "It" : cur} takes none of ${line.id}'s tasks with these ticks: ${(p.mode ?? line.mode) === "ordered" ? "an ordered pool gives every task to the first that works. To give it the work, [ moves it first"
    : "an any pool gives each task to the cheapest, and of one vendor's models to the first ticked. To give it the work, o makes the pool ordered and [ moves it first"}.` : "";
  // said whole: four rows are kept for it, and it takes more from the list when it needs them
  const said = wrap([told, none].filter(Boolean).join(" "), w - 3);
  // A short terminal keeps, in this order: three rows of the list, the words under the cursor, the
  // pool's mode, the floor, the reminder of what the config says. That the line is every repository's goes last.
  const head = [whole, [title, ...reach, ...says, ...floor, [S("")]], [title, ...reach, ...says, [S("")]], [title, ...reach, [S("")]], [title, [S("")]]].find((x) => h - x.length - 1 - Math.max(4, said.length) >= 3) ?? [title, [S("")]];
  const room = Math.max(1, h - head.length - 1 - Math.max(4, said.length)), from = windowFrom(at, line.candidates.length, room);
  // words that still do not fit end in a mark, never silently
  const fits = Math.max(1, h - head.length - 1 - room), under = said.length > fits ? [...said.slice(0, fits - 1), `${said[fits - 1].slice(0, Math.max(0, w - 6))} …`] : said;
  // a narrow terminal gives the row's last column (its part of the work, or why not) the room: keys as wide as the rows in view, and no tier
  const narrow = w < 80;
  const kw = Math.min(46, Math.max(...(narrow ? line.candidates.slice(from, from + room) : line.candidates).map((k) => width(k))) + (narrow ? 1 : 2));
  // ... and says it in fewer words: the count alone, "not allowed", "wider rule". The words under the list are the long form.
  const brief = (t: string) => (narrow ? t.replace(/^takes (?=\d|all )/, "").replace(/ today$/, "").replace("not on the allowlist", "not allowed").replace(/^(denied|not allowed) by a wider rule$/, "wider rule") : t);
  const rows = line.candidates.slice(from, from + room).map((k, n): Line => {
    const on = from + n === at, order = p.chosen.indexOf(k);
    const mark = line.one ? (order >= 0 ? "(•)" : "( )") : order >= 0 ? (line.deny ? "[x]" : `[${order + 1}]`) : "[ ]";
    // one column says the one thing about the row: its part of the shape's tasks when ticked and working, or why it is not simply there to tick
    const last = takes?.today && takes.n.get(k) ? S(brief(takes.n.get(k) === takes.of ? `takes all ${takes.of} today` : `takes ${takes.n.get(k)} of ${takes.of} today`), "dim")
      : part(k) === undefined ? S(brief(reason(M, line, k, order >= 0).tag), line.setting ? "dim" : "warn") : S(brief(!part(k) ? "takes none" : part(k) === takes?.of ? `takes all ${takes?.of}` : `takes ${part(k)} of ${takes?.of}`), part(k) ? "ok" : "warn");
    // On a narrow terminal a last column that still does not fit beside its key gives way to a short word
    // (nothing, for a setting), and the row under the cursor says it whole: no row ends in an ellipsis.
    if (narrow && 8 + kw + width(last.text) > w) last.text = line.setting ? "" : /^denied in /.test(last.text) ? "denied" : last.text === "kept out by a rule" ? "kept out" : last.text === "not a configured model" ? "not listed" : "not working";
    // (and a key so long that even the short word has no room keeps the row for the key)
    if (narrow && 8 + kw + width(last.text) > w) last.text = "";
    // a deny list has no use for the tier; a narrow terminal has no room for it; and on any terminal a row whose
    // last column would not fit beside the tier gives the tier up: why a model does not work matters more than its tier
    const tier = !(line.deny || line.setting || narrow) && 8 + kw + 10 + width(last.text) <= w;
    const row = clip([S(on ? " ▸ " : "   ", "accent"), S(fit(mark, 5), order >= 0 ? "ok" : "dim"), S(fit(k, kw), on ? "bold" : undefined), ...(tier ? [S(fit(M.seat(k)?.tier ?? "", 10), "dim")] : []), last], w);
    return on ? row.map((x) => ({ ...x, selected: true })) : row;
  });
  const more = line.candidates.length - from - room;
  return [...head, ...rows, [S(more > 0 ? `     … ${more} more below` : "", "dim")], ...under.map((t): Line => [S("  "), S(t, about.calm && !none ? "dim" : "warn")])];
}
