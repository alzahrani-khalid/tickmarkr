// Changing a line by hand (Enter on its row of the one screen): a line opened, the rules a tick lifts,
// the pool's mode and order, the floor, all through press() and frame().
import { describe, expect, test } from "vitest";
import { derive, frame, initialScreen, lineHomeTargets, plainReview, press, type ScreenSource, type ScreenState, teamRows } from "../../src/fleet/screen.js";
import { handEdit, handLines, namesOf } from "../../src/fleet/hand.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import { health, POOL, source } from "./world.js";
import { keysFrom, moveTo, open, text } from "./drive.js";
import { keptOut } from "../../src/fleet/kept.js";

/** The rule a KEPT OUT place of the one screen opens: `kept:<list>#<n>` is the list's n-th rule (row 500). */
function keptAt(src: ScreenSource, st: ScreenState, target: string): string | undefined {
  const [list, n] = target.slice(5).split("#");
  return keptOut(derive(src, st).full!).filter((r) => r.list === list)[Number(n ?? 0)]?.rule;
}

/** In the models view: search the model's id, bring its CLI under the cursor, and press Enter (row 498). */
function findIn(src: ScreenSource, from: ScreenState, key: string): ScreenState {
  // (down then up holds the first row by its key, in either form: ← is the CLI column in the keep-out form)
  let m = keysFrom(src, from, ...key.slice(key.indexOf(":") + 1).split(""), "down", "up");
  for (let i = 0; i < 20 && m.models!.key !== key; i++) m = press(src, m, "right").state;
  expect(m.models!.key).toBe(key);
  return m;
}
/** In an opened line: the cursor to its + row (or, with none, its first place) and Enter, to the models view. */
function toAdd(src: ScreenSource, st: ScreenState): ScreenState {
  const i = Math.max(0, lineHomeTargets(src, st).indexOf("add"));
  return press(src, keysFrom(src, st, ...Array<string>(i).fill("down")), "enter").state;
}
const pickIn = (src: ScreenSource, from: ScreenState, key: string): ScreenState => press(src, findIn(src, from, key), "enter").state;

describe("answers and the one write path", () => {
  test("Enter on a line changes it by hand: the models that may take one, the ticks in order, and the same review and save", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    // the one screen names Enter for a line; e and its list of lines are gone
    expect(text(src, initialScreen(), 100, 30).at(-1)).toMatch(/Enter change the line/);
    expect(press(src, initialScreen(), "e").state).toMatchObject({ view: "home", line: null });
    const quiet = source({ repoText: "consult:\n  prefer: [codex:gpt-6-astra]\nreview:\n  required: true\n" });
    expect(derive(quiet, initialScreen()).items).toEqual([]);
    expect(text(quiet, initialScreen(), 100, 30).join("\n")).toContain("Nothing. Every shape, gate and the consult has a working model.");
    // the cursor on implement's row, Enter opens its line (row 499): its models in the order written
    let st = open(src, "implement");
    expect(st).toMatchObject({ view: "line", line: { shape: "implement", chosen: ["codex:gpt-6-astra", "codex:gpt-5.6-terra"], mode: "any" } });
    const opened = text(src, st, 100, 30).join("\n");
    expect(opened).toContain("How are the tasks given out?");
    expect(opened).toMatch(/2 +shares the tasks +gpt-5\.6-terra/);
    // My order, then terra moved first with [
    st = keysFrom(src, st, "down", "enter", "down", "down", "[");
    expect(st.line).toMatchObject({ chosen: ["codex:gpt-5.6-terra", "codex:gpt-6-astra"], mode: "ordered" });
    st = press(src, st, "esc").state;
    expect(st).toMatchObject({ view: "home", line: null, msg: "implement changed. s shows what changes and saves it." });
    expect(st.hand).toEqual([{ line: "implement", chosen: ["codex:gpt-5.6-terra", "codex:gpt-6-astra"], mode: "ordered" }]);
    expect(derive(src, st).hand).toEqual([{ layer: "repo", path: ["routing", "map", "implement"], value: { pool: { mode: "ordered", channels: ["codex:gpt-5.6-terra", "codex:gpt-6-astra"] } }, label: "implement: a new order; mode ordered" }]);
    // the team redraws at once, the change is counted, and it is not saved
    const d = derive(src, st);
    expect(d.full!.cfg.routing.map.implement!.pool!.channels).toEqual(["codex:gpt-5.6-terra", "codex:gpt-6-astra"]);
    expect(text(src, st, 100, 30).join("\n")).toContain("NOT SAVED  1 change");
    expect(press(src, st, "q").action).toEqual({ kind: "quit", unsaved: 1 });
    // s opens the review, which names it and shows the lines of the file; y saves exactly that
    const review = press(src, st, "s").state;
    expect(review.view).toBe("save");
    // the save names the change after and before; d shows the file's lines
    const shown = [...text(src, review, 100, 40), ...text(src, press(src, review, "d").state, 100, 40)].join("\n");
    expect(shown).toMatch(/1 {2}implement *\n +after +in order +gpt-5\.6-terra, gpt-6-astra/);
    expect(shown).toMatch(/- +mode: any/);
    expect(shown).toMatch(/\+ +mode: ordered/);
    // y does not save; the save's own Enter does
    expect(press(src, review, "y").action).toBeUndefined();
    const saved = press(src, review, "enter");
    expect(saved.action).toMatchObject({ kind: "save", touched: ["repo"] });
    expect((saved.action as { texts: { repoText: string } }).texts.repoText).toMatch(/mode: ordered\n[\s\S]*- codex:gpt-5\.6-terra\n[\s\S]*- codex:gpt-6-astra\n/);
    // u takes the change back
    expect(press(src, st, "u").state).toMatchObject({ hand: [], msg: "Last change by hand undone." });
  });
  test("changing a line by hand: the judge is one model, nothing ticked is not a choice, and the same choice again is no change", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    // the judge is one row: Enter picks its model in the models view (rows 499, 498), which replaces the one there
    let st = open(src, "judge");
    expect(st.line!.chosen).toEqual(["claude-code:fable"]);
    st = pickIn(src, press(src, st, "enter").state, "codex:gpt-6-astra");
    expect(st.line!.chosen).toEqual(["codex:gpt-6-astra"]);
    st = press(src, st, "esc").state;
    expect(st.hand).toEqual([{ line: "judge", chosen: ["codex:gpt-6-astra"] }]);
    expect(derive(src, st).hand[0]).toMatchObject({ path: ["judge"], value: { adapter: "codex", model: "gpt-6-astra" }, label: "judge: gpt-6-astra" });
    expect(derive(src, st).full!.cfg.judge).toMatchObject({ adapter: "codex", model: "gpt-6-astra" });
    // a shape's line never loses its last model, and the line is still open
    const empty = keysFrom(src, open(src, "implement"), "down", "enter", "down", "x", "x");
    expect(empty.line!.chosen).toEqual(["codex:gpt-5.6-terra"]);
    expect(empty).toMatchObject({ view: "line", hand: [], msg: "A line never loses its last model: gpt-5.6-terra stays." });
    // Esc with the line as it was leaves without a change
    expect(press(src, open(src, "implement"), "esc").state).toMatchObject({ view: "home", line: null, hand: [] });
    // a line changed and then put back by hand is withdrawn, not saved as a change that changes nothing
    const restored = press(src, pickIn(src, press(src, open(src, "judge", st), "enter").state, "claude-code:fable"), "esc").state;
    expect(restored).toMatchObject({ hand: [], msg: "judge is back to what it was before you changed it." });
  });
  test("the deny lists are lines too: what is ticked is denied, nothing ticked is a choice, and the file keeps its order", () => {
    const repoText = "routing:\n  deny:\n    workers:\n      models:\n        # too slow\n        - codex:gpt-5.6-terra\n        - claude-code:opus\nconsult:\n  prefer: [codex:gpt-6-astra]\n";
    const src = source({ repoText });
    const lines = handLines(derive(src, initialScreen()).base!);
    // one line for each deny list the schema has, by the path typed in the config, after the team's lines
    expect(lines.filter((l) => l.deny).map((l) => l.id)).toEqual(["deny.adapters", "deny.models", "deny.workers.adapters", "deny.workers.models"]);
    expect(lines.findIndex((l) => l.deny)).toBe(13);
    const line = lines.find((l) => l.id === "deny.workers.models")!;
    // what is written comes first, then every model that could be
    expect(line.candidates.slice(0, 2)).toEqual(["codex:gpt-5.6-terra", "claude-code:opus"]);
    expect(line.candidates).toContain("claude-code:fable");
    expect(lines.find((l) => l.id === "deny.adapters")!.candidates).toContain("codex");
    // the list shows the entries as written, and the opened line says what the list covers: plan and spec too
    // KEPT OUT shows each entry as written beside its comment; Enter on one opens its list
    expect(text(src, initialScreen(), 100, 60).join("\n")).toMatch(/codex:gpt-5\.6-terra +# too slow · workers only/);
    // a rule opened from its own row of KEPT OUT: its list's reach, and x removes it alone (rows 499, 500)
    const rule = (from: ScreenState, r: string) => press(src, moveTo(src, (t) => t.startsWith("kept:routing.deny.workers.models") && keptAt(src, from, t) === r, from), "enter").state;
    let st = rule(initialScreen(), "codex:gpt-5.6-terra");
    const opened = text(src, st, 200, 30).join("\n");
    expect(opened).toMatch(/REASON +# too slow/);
    expect(opened).toContain("routing.deny.workers.models · workers only: kept from all work; it may still judge, review and consult");
    st = press(src, st, "x").state;
    // then fable kept out of all work in the keep-out form of the models view: opus keeps its place in the file
    st = keysFrom(src, pickIn(src, press(src, moveTo(src, (t) => t === "kept+", st), "enter").state, "claude-code:fable"), "esc", "esc");
    expect(st.hand).toEqual([{ line: "deny.workers.models", chosen: ["claude-code:opus", "claude-code:fable"] }]);
    const d = derive(src, st);
    expect(d.hand.map((e) => e.label)).toEqual(["codex:gpt-5.6-terra: no longer denied for all work (every shape, plan and spec too); claude-code:fable: denied for all work (every shape, plan and spec too)"]);
    expect(d.full!.seat("claude-code:fable")!.denied).toMatchObject({ worker: { by: "deny" }, judge: null });
    expect(d.full!.seat("codex:gpt-5.6-terra")!.denied.worker).toBeNull();
    expect(d.texts!.repoText).toContain("        # too slow\n        - claude-code:opus\n        - claude-code:fable\n");
    // NOT SAVED says each rule kept out or removed, by name
    const pend = text(src, st, 100, 60).join("\n");
    expect(pend).toMatch(/no longer kept out +codex:gpt-5\.6-terra/);
    expect(pend).toMatch(/kept out +claude-code:fable/);
    // every rule removed, each by x on its own line: the list is emptied, and the config still loads
    let none = press(src, rule(initialScreen(), "codex:gpt-5.6-terra"), "x").state;
    none = press(src, rule(none, "claude-code:opus"), "x").state;
    expect(none.hand).toEqual([{ line: "deny.workers.models", chosen: [] }]);
    const dn = derive(src, none);
    expect(dn.refused).toBeUndefined();
    expect(dn.full!.seat("claude-code:opus")!.denied.worker).toBeNull();
    // a model another entry already covers says so in the keep-out form, under the cursor
    const wide = source({ repoText: "routing:\n  deny:\n    adapters: [claude-code]\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    const k = findIn(wide, press(wide, moveTo(wide, (t) => t === "kept+"), "enter").state, "claude-code:fable");
    const shown = text(wide, k, 110, 40).join("\n");
    expect(shown).toMatch(/fable .*kept out · your guard/);
    expect(shown).toContain("Kept out by the rule claude-code.");
  });
  test("a model a rule keeps out is on the line with the reason, and a tick lifts no rule: the rule goes only from its own line of KEPT OUT", () => {
    // fable is denied for all work and named on two pools; opus is denied for every seat; sonnet only through its whole CLI
    const repoText = "routing:\n  deny:\n    models:\n      - claude-code:opus\n    workers:\n      models:\n        - claude-code:fable\n  map:\n    plan:\n      pool:\n        mode: any\n        channels: [codex:gpt-6-astra]\n"
      + "    tests:\n      pool:\n        mode: any\n        channels: [codex:gpt-6-astra, claude-code:fable]\nconsult:\n  prefer: [codex:gpt-6-astra]\n";
    const src = source({ repoText });
    const base = derive(src, initialScreen()).base!, lines = handLines(base), plan = lines.find((l) => l.id === "plan")!;
    // kept out by a rule, not by the probe: listed after the working models, never just missing
    expect(plan.barred).toEqual({ "claude-code:fable": { why: "the deny rule claude-code:fable for all work (every shape, plan and spec too)", liftable: true },
      "claude-code:opus": { why: "the deny rule claude-code:opus, which covers every seat", liftable: true } });
    expect(plan.candidates.indexOf("claude-code:fable")).toBeGreaterThan(plan.candidates.indexOf("codex:gpt-6-astra"));
    // a list opened, + to the models view: the row says kept out, and under the cursor that a tick lifts no rule (K2)
    let st = findIn(src, toAdd(src, open(src, "review")), "claude-code:opus");
    const opened = text(src, st, 160, 40).map((l) => l.trim()).join(" ");
    expect(opened).toMatch(/opus +frontier .*kept out · your guard/);
    expect(opened).toContain("Kept out by the rule claude-code:opus: a tick lifts no rule; it is removed only from its own line of KEPT OUT.");
    // Enter is refused, names the rule, and nothing changes
    const refusedTick = press(src, st, "enter").state;
    expect(refusedTick).toMatchObject({ view: "models", hand: [] });
    expect(refusedTick.line!.chosen).toEqual(st.line!.chosen);
    expect(refusedTick.msg).toBe("claude-code:opus is kept out by the rule claude-code:opus. Nothing was added: a rule is removed only from its own line of KEPT OUT.");
    // a choice that names a kept-out model anyway (--set until T15) writes the line and lifts nothing
    const named = derive(src, { ...initialScreen(), hand: [{ line: "plan", chosen: ["codex:gpt-6-astra", "claude-code:fable"], mode: "ordered" }] });
    expect(named.hand.map((e) => e.path.join("."))).toEqual(["routing.map.plan"]);
    expect(named.full!.seat("claude-code:fable")!.denied.worker).not.toBeNull();
    const judge = derive(src, { ...initialScreen(), hand: [{ line: "judge", chosen: ["claude-code:opus"] }] });
    expect(judge.hand.map((e) => e.label)).toEqual(["judge: opus"]);
    expect(judge.full!.seat("claude-code:opus")!.denied.judge).not.toBeNull();
    // the rule's own line of KEPT OUT is the one place a rule changes: x there
    let again = press(src, moveTo(src, (t) => t === "kept:routing.deny.workers.models"), "enter").state;
    expect(again.rule).toMatchObject({ list: "routing.deny.workers.models", rule: "claude-code:fable" });
    again = press(src, again, "x").state;
    expect(again.hand.map((x) => x.line)).toEqual(["deny.workers.models"]);
    expect(derive(src, again).full!.seat("claude-code:fable")!.denied.worker).toBeNull();
    // a rule on a whole CLI: the tick is refused and names that CLI (RULING-T5 rule 5)
    const wide = source({ repoText: "routing:\n  deny:\n    adapters: [claude-code]\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    const wl = handLines(derive(wide, initialScreen()).base!), wp = wl.find((l) => l.id === "plan")!;
    expect(wp.barred["claude-code:opus"]).toEqual({ why: "the deny rule claude-code, which covers the whole claude-code CLI", liftable: false });
    const wplan = toAdd(wide, open(wide, "plan"));
    const refused = press(wide, findIn(wide, wplan, "claude-code:opus"), "enter").state;
    expect(refused.line!.chosen).toEqual(wplan.line!.chosen);
    expect(refused.msg).toBe("claude-code:opus is kept out by the rule claude-code. Nothing was added: a rule is removed only from its own line of KEPT OUT.");
    const bare = handLines(derive(source({ repoText: "routing:\n  deny:\n    workers:\n      models: [zai/glm-5.3, gpt-6-astra]\nconsult:\n  prefer: [codex:gpt-6-sol]\n" }), initialScreen()).base!).find((l) => l.id === "plan")!;
    expect(bare.barred["pi:zai/glm-5.3"]).toEqual({ why: "the deny rule zai/glm-5.3, which covers more than this model", liftable: false });
    expect(bare.barred["omp:zai/glm-5.3"]).toMatchObject({ liftable: false });
    expect(bare.barred["codex:gpt-6-astra"]).toEqual({ why: "the deny rule gpt-6-astra for all work (every shape, plan and spec too)", liftable: true });
    expect(derive(wide, { ...initialScreen(), hand: [{ line: "plan", chosen: ["codex:gpt-6-astra", "claude-code:opus"] }] }).hand.map((e) => e.path.join("."))).toEqual(["routing.map.plan"]);
    // a model the config already names on a line and a rule keeps out stays kept out: reordering the line lifts nothing
    const tests = lines.find((l) => l.id === "tests")!;
    expect(tests.current).toEqual(["codex:gpt-6-astra", "claude-code:fable"]);
    const reordered = derive(src, { ...initialScreen(), hand: [{ line: "tests", chosen: ["claude-code:fable", "codex:gpt-6-astra"] }] });
    expect(reordered.hand.map((e) => e.label)).toEqual(["tests: a new order"]);
    expect(reordered.full!.seat("claude-code:fable")!.denied.worker).not.toBeNull();
    // the line opened names it with what keeps it out, in place of its job (5.4)
    const told = text(src, keysFrom(src, open(src, "tests"), "down", "enter"), 200, 40).map((l) => l.trim()).join(" ");
    expect(told).toMatch(/2 +kept out +claude-code:fable|2 +kept out +fable/);
  });
  test("a line changed by hand is made on top of the answers: the consult's yes and the consult's line changed by hand end in one list", () => {
    // consult.prefer is not set, so the consult's yes sets it; no answer writes a rule of KEPT OUT (row 500)
    const repoText = "routing:\n  deny:\n    models: [claude-code:fable]\nreview:\n  required: true\n";
    const src = source({ repoText });
    const d = derive(src, { ...initialScreen(), yes: ["consult"], hand: [{ line: "consult", chosen: ["codex:gpt-6-astra"] }] });
    expect(d.refused).toBeUndefined();
    // one edit for the list, and it is the hand's exact choice
    expect(d.edits.filter((e) => e.path.join(".") === "consult.prefer")).toHaveLength(1);
    expect(d.full!.cfg.consult.prefer).toEqual(["codex:gpt-6-astra"]);
    expect(d.full!.cfg.routing.deny?.models).toEqual(["claude-code:fable"]);
    expect(d.edits.some((e) => e.path[1] === "deny")).toBe(false);
  });
  test("an opened shape is given out by a choice, not o: in my order [ ] move a row, and the choice carries the way", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    const lines = handLines(derive(src, initialScreen()).base!), impl = lines.find((l) => l.id === "implement")!;
    // only a shape has a mode
    expect(impl.mode).toBe("any");
    expect(lines.filter((l) => l.mode).map((l) => l.id)).toEqual(["plan", "spec", "implement", "tests", "docs", "migration", "ui", "refactor", "chore"]);
    let st = open(src, impl.id);
    expect(st.line).toMatchObject({ mode: "any", chosen: ["codex:gpt-6-astra", "codex:gpt-5.6-terra"] });
    // o is gone for a shape: it does nothing
    expect(press(src, st, "o").state.line).toEqual(st.line);
    // My order: the first that works takes every task
    st = keysFrom(src, st, "down", "enter");
    expect(st.line!.mode).toBe("ordered");
    const rows = (x = st) => text(src, x, 100, 40).join("\n");
    expect(rows()).toMatch(/1 +does the work +gpt-6-astra/);
    expect(rows()).toContain("If it stops working, gpt-5.6-terra takes over.");
    // [ moves the row under the cursor earlier, ] later; at either end the key does nothing
    st = keysFrom(src, st, "down", "down");
    const first = press(src, st, "[").state;
    expect(first.line!.chosen).toEqual(["codex:gpt-5.6-terra", "codex:gpt-6-astra"]);
    expect(press(src, first, "[").state.line!.chosen).toEqual(first.line!.chosen);
    expect(press(src, st, "]").state.line!.chosen).toEqual(st.line!.chosen);
    expect(rows(first)).toMatch(/1 +does the work +gpt-5\.6-terra/);
    // the keys are named, whole, on an 80-column terminal (wrapped, never cut)
    expect(text(src, st, 80, 24).slice(-2).map((l) => l.trim()).join(" ")).toBe("↑↓ move · Enter pick the model for a row · [ ] move the row · x remove · Esc back");
    // Esc: the choice carries the way, the edit writes it, the label says it
    const done = press(src, first, "esc").state;
    expect(done.hand).toEqual([{ line: "implement", chosen: ["codex:gpt-5.6-terra", "codex:gpt-6-astra"], mode: "ordered" }]);
    const d = derive(src, done);
    expect(d.hand).toEqual([{ layer: "repo", path: ["routing", "map", "implement"], value: { pool: { mode: "ordered", channels: ["codex:gpt-5.6-terra", "codex:gpt-6-astra"] } }, label: "implement: a new order; mode ordered" }]);
    expect(d.full!.sample().rows.implement.shares.map((x) => [x.key, x.pct])).toEqual([["codex:gpt-5.6-terra", 100]]);
    // the way alone is a change; reopened, it is drawn as chosen, and u takes it back
    const only = keysFrom(src, open(src, impl.id), "down", "enter", "esc");
    expect(only.hand).toEqual([{ line: "implement", chosen: ["codex:gpt-6-astra", "codex:gpt-5.6-terra"], mode: "ordered" }]);
    expect(derive(src, only).hand[0].label).toBe("implement: mode ordered");
    expect(open(src, impl.id, only).line!.mode).toBe("ordered");
    expect(press(src, only, "u").state).toMatchObject({ hand: [], msg: "Last change by hand undone." });
    // the judge, a prefer list and a deny list have no mode: o does nothing there, and the judge has no order to move in
    const judge = open(src, "judge");
    expect(press(src, judge, "o").state.line).toEqual(judge.line);
    expect(press(src, judge, "[").state.line).toEqual(judge.line);
    expect(text(src, judge, 100, 30).at(-1)!.trim()).toBe("↑↓ move · Enter pick the model · Esc back");
  });
  test("the routing mode is a line: one of three, each saying what it does, and the review shows what the floors then do", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    const lines = handLines(derive(src, initialScreen()).base!), mode = lines.find((l) => l.id === "mode")!;
    expect(mode).toMatchObject({ setting: true, one: true, path: ["routing", "mode"], current: ["partner-led"], candidates: ["partner-led", "risk-based", "staff-led"] });
    // after the team's lines, before the deny lists
    expect(lines.map((l) => l.id).slice(11, 14)).toEqual(["consult", "mode", "deny.adapters"]);
    // the mode is the first place of the one cursor: the header names it, and Enter opens it
    expect(text(src, initialScreen(), 100, 30)[0]).toContain("mode partner-led (frontier models only)");
    let st = open(src, mode.id);
    const opened = text(src, st, 100, 30).join("\n");
    expect(opened).toMatch(/^mode  the bar every shape keeps/m);
    expect(opened).toMatch(/\(•\) partner-led +every shape needs a frontier model/);
    expect(opened).toMatch(/\( \) risk-based +each shape keeps its own bar \(the default\)/);
    expect(opened).toMatch(/\( \) staff-led +one level lower; plan, spec, migration, ui stay frontier/);
    // each says what it does, whole, on an 80-column terminal and on the smallest window (80 by 20), wherever the cursor is
    for (const at2 of [0, 1, 2]) for (const [c, r] of [[80, 24], [80, 20]]) {
      const narrow = text(src, { ...st, line: { ...st.line!, at: at2 } }, c, r).map((l) => l.trim()).join(" ");
      expect(narrow).not.toContain("…");
      expect(narrow).toContain(["every shape needs a frontier model", "each shape keeps its own bar (the default)", "one level lower; plan, spec, migration, ui stay frontier"][at2]);
    }
    // no way of giving out tasks, no order, no level and no "not a configured model" on a setting
    expect(opened).not.toContain("How are the tasks given out?");
    expect(opened).not.toContain("not a configured model");
    expect(text(src, st, 100, 30).at(-1)!.trim()).toBe("↑↓ move · Enter choose · Esc back");
    // one is chosen: Enter replaces the one before, Esc keeps it as a pending change
    st = keysFrom(src, st, "down", "enter");
    expect(st.line!.chosen).toEqual(["risk-based"]);
    st = press(src, st, "esc").state;
    expect(st.hand).toEqual([{ line: "mode", chosen: ["risk-based"] }]);
    const d = derive(src, st);
    expect(d.hand).toEqual([{ layer: "repo", path: ["routing", "mode"], value: "risk-based", label: "mode: risk-based" }]);
    expect(d.full!.mode.mode).toBe("risk-based");
    expect(d.texts!.repoText).toContain("routing:\n  mode: risk-based\n");
    // the header names the mode before anything is saved. What the floors then do is in the review, and only on its floor rows.
    const header = text(src, st, 100, 30)[0];
    expect(header).toContain("mode risk-based");
    expect(header).not.toContain("the floor moved");
    const review = press(src, st, "s").state;
    expect(review.view).toBe("save");
    // the floors' rows are the review text --yes and --set print (unchanged until T15); the save lists a measure only when it moves the wrong way
    const rows = plainReview(src, review.yes, review.hand).split("\n");
    expect(rows.filter((l) => !/floor/.test(l)).join("\n")).not.toContain("the floor moved");
    // partner-led held every shape at frontier. risk-based returns each shape's own floor, and the review says the bar moved.
    const floorRows = rows.map((l) => l.trim().replace(/\s+/g, " ")).filter((l) => /floor/.test(l));
    expect(floorRows).toEqual([
      "shapes at their floor 8 → 9 the floor moved",
      "tasks below their floor 400 → 0 the floor moved",
      "shapes with fewer than two models at their floor 1 → 0 the floor moved",
    ]);
    // the same mode again is no change
    expect(keysFrom(src, open(src, mode.id), "enter", "esc")).toMatchObject({ view: "home", hand: [], msg: "" });
  });
  test("every routing mode shows the floors that then move in the review, and a raised floor is not called worse", () => {
    // the whole input class: each of the three modes chosen from each of the others, on one pool.
    // a count that moves says "the floor moved"; raising the bar is not worse; a mode whose counts stay still invents no floor row.
    const consult = "consult:\n  prefer: [codex:gpt-6-astra]\n";
    const map = "  map:\n    implement:\n      tier: null\n      pool:\n        mode: any\n        channels:\n          - codex:gpt-6-astra\n          - codex:gpt-5.6-terra\n";
    const modes = ["partner-led", "risk-based", "staff-led"] as const;
    const moved = [
      "shapes at their floor 8 → 9 the floor moved",
      "tasks below their floor 400 → 0 the floor moved",
      "shapes with fewer than two models at their floor 1 → 0 the floor moved",
    ];
    const raised = [
      "shapes at their floor 9 → 8 the floor moved",
      "tasks below their floor 0 → 400 the floor moved",
      "shapes with fewer than two models at their floor 0 → 1 the floor moved",
    ];
    const floors: Record<string, string[]> = {
      "partner-led→risk-based": moved, "partner-led→staff-led": moved,
      "risk-based→partner-led": raised, "staff-led→partner-led": raised,
      "risk-based→staff-led": [], "staff-led→risk-based": [],
    };
    for (const from of modes) for (const to of modes) {
      if (from === to) continue;
      const src = source({ repoText: `routing:\n  mode: ${from}\n${map}${consult}` });
      const lines = handLines(derive(src, initialScreen()).base!);
      const modeLine = lines.find((l) => l.id === "mode")!;
      const st = keysFrom(src, open(src, modeLine.id), ...Array<string>(modeLine.candidates.indexOf(to)).fill("down"), "enter", "esc");
      const review = press(src, st, "s").state;
      expect(review.view, `${from} → ${to}`).toBe("save");
      const floorRows = plainReview(src, review.yes, review.hand).split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter((l) => /floor/.test(l));
      expect(floorRows, `${from} → ${to}`).toEqual(floors[`${from}→${to}`]);
    }
  });
  test("a shape's floor is set on its opened line: f moves it, it beats the mode, and the review says the floor moved", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    const lines = handLines(derive(src, initialScreen()).base!), impl = lines.find((l) => l.id === "implement")!;
    // under partner-led the mode says frontier, and the cheaper model of the pool takes every task below it
    expect(impl.floor).toEqual({ tier: "frontier", own: false });
    expect(lines.filter((l) => l.floor).map((l) => l.id)).toEqual(["plan", "spec", "implement", "tests", "docs", "migration", "ui", "refactor", "chore"]);
    expect(teamRows(derive(src, initialScreen()).base!).find((r) => r.label.includes("implement"))!.status).toBe("100% below frontier");
    let st = open(src, impl.id);
    const head = (s = st) => text(src, s, 100, 40).join("\n");
    expect(head()).toContain("bar for implement: frontier (mode partner-led)");
    // f: cheap, mid, frontier, and back to what the mode says
    st = press(src, st, "f").state;
    expect(head()).toContain("bar for implement: cheap (set for this shape)");
    expect(keysFrom(src, st, "f", "f", "f").line!.floor).toBe("mode");
    expect(press(src, keysFrom(src, st, "f", "f", "f"), "esc").state).toMatchObject({ view: "home", hand: [] });
    st = press(src, st, "f").state;
    expect(st.line!.floor).toBe("mid");
    // Esc: the floor alone. The models are not part of the change, so no pool is rewritten
    const done = press(src, st, "esc").state;
    expect(done.hand).toEqual([{ line: "implement", chosen: [], floor: "mid" }]);
    const d = derive(src, done);
    expect(d.hand).toEqual([{ layer: "repo", path: ["routing", "floors", "implement"], value: "mid", label: "implement: floor mid, where mode partner-led said frontier" }]);
    expect(d.full!.cfg.routing.floors.implement).toBe("mid");
    expect(d.full!.mode.provenance.implement).toBe("config floors");
    expect(d.texts!.repoText).toContain("  floors:\n    implement: mid\n");
    // the closed screen does not read "ok" under "mode partner-led" for a bar that was lowered: it names the bar
    expect(d.full!.lowered).toEqual({ implement: { own: "mid", mode: "frontier" } });
    expect(teamRows(d.full!).find((r) => r.label.includes("implement"))!.status).toBe("ok, floor mid");
    // (YOUR TEAM is what `--plain` prints; the one screen names a status only where a line is not ok)
    const team = (cols: number, rows: number) => frame(src, done, cols, rows, true).map((l) => l.map((x) => x.text).join("")).join("\n");
    expect(team(100, 30)).toMatch(/implement +gpt-5\.6-terra +ok, floor mid/);
    expect(text(src, done, 100, 30)[0]).toContain("mode partner-led");
    expect(text(src, done, 100, 60).join("\n")).not.toMatch(/implement +gpt-5\.6-terra +\d+% below/);
    // on a short terminal such a line is not listed among the lines that are not ok
    expect(team(60, 16)).not.toMatch(/these are not:[\s\S]*implement/);
    // a floor raised above the mode's, or set to what the mode says, is a bar met: plain ok, and nothing is called lowered
    for (const [floors, mode] of [["implement: frontier", "risk-based"], ["implement: mid", "risk-based"], ["docs: frontier", "partner-led"]] as const) {
      const m = derive(source({ repoText: `routing:\n  mode: ${mode}\n  floors:\n    ${floors}\nconsult:\n  prefer: [codex:gpt-6-astra]\n` }), initialScreen()).base!;
      expect(m.lowered, floors).toEqual({});
    }
    // under risk-based a floor below the shape's default is lowered too
    expect(derive(source({ repoText: "routing:\n  floors:\n    implement: cheap\nconsult:\n  prefer: [codex:gpt-6-astra]\n" }), initialScreen()).base!.lowered).toEqual({ implement: { own: "cheap", mode: "mid" } });
    // the review does not call a lowered floor better: the same tasks against another bar
    const review = plainReview(src, done.yes, done.hand);
    expect(review).toMatch(/tasks below their floor +400 → 0 +the floor moved/);
    expect(review).not.toMatch(/floor.*better/);
    // reopened, the line says the floor is this shape's own; ticks and a floor travel in one choice
    const again = open(src, impl.id, done);
    expect(text(src, again, 100, 40).join("\n")).toContain("bar for implement: mid (set for this shape)");
    const both = keysFrom(src, again, "enter", "esc");
    expect(both.hand).toEqual([{ line: "implement", chosen: ["codex:gpt-6-astra", "codex:gpt-5.6-terra"], mode: "complexity", floor: "mid" }]);
    expect(derive(src, both).hand.map((e) => e.label)).toEqual(["implement: floor mid, where mode partner-led said frontier", "implement: mode complexity"]);
    // put back to what the mode says, the change is withdrawn
    const back = open(src, impl.id, done);
    expect(press(src, keysFrom(src, back, "f", "f"), "esc").state).toMatchObject({ hand: [], msg: "implement is back to what it was before you changed it." });
    // a floor a config sets for one shape: "mode" takes it away, and the file loses the line
    const own = source({ repoText: "routing:\n  floors:\n    docs: frontier # the docs are the product\n    ui: frontier\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    const ol = handLines(derive(own, initialScreen()).base!), docs = ol.find((l) => l.id === "docs")!;
    expect(docs.floor).toEqual({ tier: "frontier", own: true });
    const opened = open(own, docs.id);
    expect(text(own, opened, 100, 40).join("\n")).toContain("bar for docs: frontier (set for this shape)");
    // docs has no line of its own: a choice with no model opens the models view (row 498), staging nothing; a bar alone is a change
    expect(press(own, opened, "enter").state).toMatchObject({ view: "models", hand: [] });
    expect(press(own, opened, "esc").state.hand).toEqual([]);
    const freed = press(own, press(own, opened, "f").state, "esc").state;
    expect(freed.hand).toEqual([{ line: "docs", chosen: [], floor: "mode" }]);
    const fd = derive(own, freed);
    expect(fd.hand).toEqual([{ layer: "repo", path: ["routing", "floors", "docs"], value: undefined, label: "docs: floor as mode risk-based says, was frontier for this shape" }]);
    expect(fd.texts!.repoText).toBe("routing:\n  floors:\n    ui: frontier\nconsult:\n  prefer: [codex:gpt-6-astra]\n");
    expect(fd.full!.cfg.routing.floors.docs).toBe("cheap");
    expect(fd.full!.cfg.routing.map.docs?.pool).toBeUndefined();
    // the judge has no floor: f does nothing there
    const judge = open(src, "judge");
    expect(press(src, judge, "f").state.line).toEqual(judge.line);
  });
  test("a line kept in the user config says so when it is opened, before the change and not only in the review", () => {
    // the judge and the consult are set for every repository; implement's pool is this repository's
    const src = source({ userText: "judge:\n  adapter: codex\n  model: gpt-6-astra\nconsult:\n  prefer: [codex:gpt-6-astra]\n", repoText: POOL });
    const lines = handLines(derive(src, initialScreen()).base!);
    expect(Object.fromEntries(lines.filter((l) => ["judge", "consult", "implement", "review", "deny.models"].includes(l.id)).map((l) => [l.id, l.layer])))
      .toEqual({ judge: "user", consult: "user", implement: "repo", review: "repo", "deny.models": "repo" });
    const view = (id: string, cols = 100, rows = 30) => text(src, open(src, id), cols, rows).map((l) => l.trim()).join(" ");
    // APPLIES TO says where the line is held (5.4): the user's settings read by every project with none of its own
    expect(view("judge")).toMatch(/APPLIES TO +every project with no acceptance \(judge\) of its own; r has none/);
    expect(view("consult")).toMatch(/APPLIES TO +every project with no consult of its own; r has none/);
    expect(view("implement")).toMatch(/APPLIES TO +this project only/);
    // whole on the smallest terminal too
    expect(view("judge", 80, 20)).toMatch(/APPLIES TO +every project with no acceptance \(judge\) of its own; r has none/);
    // and the change is written there: what the line said is what the review says
    const d = derive(src, { ...initialScreen(), hand: [{ line: "judge", chosen: ["claude-code:opus"] }] });
    expect(d.texts!.touched).toEqual(["user"]);
    expect(text(src, { ...initialScreen(), hand: [{ line: "judge", chosen: ["claude-code:opus"] }], view: "save", lines: true }, 100, 40).join("\n")).toContain("Your user config: every repository on this machine reads it.");
  });
  test("a pinned shape names its model on the line; a choice makes the pin a line of its own, and a line that names nobody says who takes it", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    const lines = handLines(derive(src, initialScreen()).base!), plan = lines.find((l) => l.id === "plan")!;
    expect(plan).toMatchObject({ current: ["claude-code:fable"], pinned: true, mode: "any" });
    // opened: the pinned model is the one row of an order, and takes every task; Esc as it is changes nothing
    const opened = open(src, plan.id);
    expect(opened.line).toMatchObject({ chosen: ["claude-code:fable"], mode: "ordered" });
    const shown = text(src, opened, 100, 30).join("\n");
    expect(shown).toMatch(/1 +does the work +fable/);
    expect(shown).toContain("There is no backup: if it stops, plan has no model.");
    expect(press(src, opened, "esc").state).toMatchObject({ view: "home", hand: [] });
    // a shape with no line of its own, opened: who takes it is said before a model is named
    const docs = lines.find((l) => l.id === "docs")!;
    const bare = open(src, docs.id);
    expect(text(src, bare, 100, 60).join("\n")).toContain("the cheapest model at the bar takes each task");
    expect(docs.current).toEqual([]);
    // the label says what the pool takes the place of: nothing, a prefer list, a pin
    expect(derive(src, { ...initialScreen(), hand: [{ line: "docs", chosen: ["codex:gpt-6-astra"] }] }).hand[0].label).toBe("docs: add gpt-6-astra; mode complexity; it gets a pool: only these take it");
    expect(lines.find((l) => l.id === "tests")).toMatchObject({ prefers: true, current: [] });
    expect(derive(src, { ...initialScreen(), hand: [{ line: "tests", chosen: ["codex:gpt-6-astra"] }] }).hand[0].label).toBe("tests: add gpt-6-astra; mode complexity; its prefer list becomes a pool");
    // By complexity: the pin becomes a line of its own, and the label says so
    const two = keysFrom(src, opened, "enter", "esc");
    const d = derive(src, two);
    expect(d.hand).toEqual([{ layer: "repo", path: ["routing", "map", "plan"], value: { pool: { mode: "complexity", channels: ["claude-code:fable"] } }, label: "plan: mode complexity; the pin becomes a pool" }]);
    expect(d.refused).toBeUndefined();
    expect(d.full!.cfg.routing.map.plan).toMatchObject({ pool: { mode: "complexity", channels: ["claude-code:fable"] } });
    expect(d.full!.cfg.routing.map.plan!.pin).toBeUndefined();
  });
  test("a model written as an alias says which model it is, and a model a rule keeps out says a tick lifts no rule, whole on the smallest window", () => {
    // the probe saw that claude-code:fable is claude-fable-5-2
    const h = health();
    h["claude-code"] = { ...h["claude-code"], modelAuth: { ...h["claude-code"].modelAuth, fable: { authed: true, probedAt: "2026-11-10T00:00:00Z", identity: "claude-fable-5-2" } } };
    const src = source({ health: h, repoText: "routing:\n  deny:\n    models: [claude-code:fable]\nreview:\n  prefer: [codex:gpt-6-astra]\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    const base = derive(src, initialScreen()).base!, review = handLines(base).find((l) => l.id === "review")!;
    expect(base.name("claude-code:fable")).toBe("claude-fable-5-2");
    expect(review.candidates).toContain("claude-code:fable");
    // + of the review to the models view: the model kept out says which model it is and that a tick lifts no rule
    const on = findIn(src, toAdd(src, open(src, "review")), "claude-code:fable");
    const said = (x = on, c = 220, r = 60) => text(src, x, c, r).map((l) => l.trim()).join(" ");
    expect(said()).toContain("Kept out by the rule claude-code:fable: a tick lifts no rule; it is removed only from its own line of KEPT OUT.");
    // however narrow the terminal, down to the smallest window, what is said under the list is said to its last word
    for (const [c, r] of [[80, 24], [100, 24], [80, 20]]) {
      expect(said(on, c, r), `${c}x${r}`).toContain("removed only from its own line of KEPT OUT.");
      for (const l of text(src, on, c, r)) expect(l, l).not.toContain("…");
    }
    // an alias on an opened line is named as the model it is, beside the CLI written in the config
    const calm = source({ health: h, repoText: "review:\n  prefer: [claude-code:fable]\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    expect(text(calm, open(calm, "review"), 110, 40).join("\n")).toMatch(/1 +asked first +claude-fable-5-2 +claude-code/);
  });
  test("two CLI paths to one model are told apart by their CLI", () => {
    const repoText = "routing:\n  map:\n    docs:\n      pool:\n        mode: any\n        channels: [pi:zai/glm-5.3, omp:zai/glm-5.3, codex:gpt-6-astra, qwen:qwen3.8-max]\nconsult:\n  prefer: [codex:gpt-6-astra]\n";
    const src = source({ repoText, health: health(["qwen:qwen3.8-max"]) });
    const M = derive(src, initialScreen()).base!;
    expect(namesOf(M, ["pi:zai/glm-5.3", "omp:zai/glm-5.3", "codex:gpt-6-astra"])).toEqual(["glm-5.3 (pi)", "glm-5.3 (omp)", "gpt-6-astra"]);
    // two keys on one CLI with one name (an alias and its full id) are not told apart by their CLI: each is shown as its key
    expect(namesOf(M, ["omp:zai/glm-5.3", "omp:other/glm-5.3", "codex:gpt-6-astra"])).toEqual(["omp:zai/glm-5.3", "omp:other/glm-5.3", "gpt-6-astra"]);
    const docs = text(src, initialScreen(), 120, 60).find((l) => /^ {2}docs /.test(l))!;
    expect(docs).toContain("glm-5.3 (pi)");
    expect(docs).toContain("glm-5.3 (omp)");
    // the label of a change names the CLI where the name alone would not say which
    const line = handLines(M).find((l) => l.id === "docs")!;
    expect(handEdit(M, line, ["omp:zai/glm-5.3", "codex:gpt-6-astra", "qwen:qwen3.8-max"]).label).toBe("docs: remove glm-5.3 (pi)");
    expect(handEdit(M, line, [...line.current].reverse()).label).toBe("docs: a new order");
  });
  test("a line opened by hand offers the strongest models first, and a change keeps the pool's mode", () => {
    const repoText = "routing:\n  mode: partner-led\n  map:\n    implement:\n      pool:\n        mode: ordered\n        channels:\n          - codex:gpt-5.6-terra\n          - codex:gpt-6-astra\nconsult:\n  prefer: [codex:gpt-6-astra]\n";
    const M = derive(source({ repoText }), initialScreen()).base!;
    const line = handLines(M).find((l) => l.id === "implement")!;
    const rank = { cheap: 0, mid: 1, frontier: 2 };
    const tiers = line.candidates.filter((k) => M.seat(k)?.live.worker).map((k) => rank[M.seat(k)!.tier]);
    expect(new Set(tiers).size).toBeGreaterThan(1);
    expect(tiers).toEqual([...tiers].sort((a, b) => b - a));
    expect(handEdit(M, line, ["codex:gpt-6-astra", "codex:gpt-5.6-terra"]).value).toEqual({ pool: { mode: "ordered", channels: ["codex:gpt-6-astra", "codex:gpt-5.6-terra"] } });
  });
  test("a line changed by hand wins over an answer on the same line, and both are in one review", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    const hand = [{ line: "implement", chosen: ["claude-code:opus"] }];
    const d = derive(src, { ...initialScreen(), yes: ["floor"], hand });
    expect(d.full!.cfg.routing.map.implement!.pool!.channels).toEqual(["claude-code:opus"]);
    const shown = text(src, { ...initialScreen(), yes: ["floor"], hand, view: "save" }, 100, 40).join("\n");
    expect(shown).toContain("YOU ARE SAVING  2 changes");
    expect(shown).toMatch(/ 2 {2}implement *\n +after/);
    // every frame of the two new views is exactly the terminal's size, at every size
    for (const [cols, rows] of [[60, 16], [80, 20], [80, 24], [120, 36], [40, 12]] as const) {
      // (the opened views of 2.27: a shape's line with its cursor past its end, and the review as an order; the 2.26.1 tick list is gone)
      const impl = open(src, "implement");
      for (const st of [initialScreen(), { ...impl, line: { ...impl.line!, at: 30 } }, open(src, "review")]) {
        const lines = frame(src, st, cols, rows);
        expect(lines.length, `${st.view} ${cols}x${rows}`).toBe(rows);
        for (const l of lines) expect(cellWidth(l.map((x) => x.text).join("")), `${st.view} ${cols}x${rows}`).toBe(cols);
      }
    }
  });
});
