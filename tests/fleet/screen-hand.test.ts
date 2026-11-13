// Changing a line by hand (the e key): the list of lines, a line opened, the rules a tick lifts,
// the pool's mode and order, the floor, all through press() and frame().
import { describe, expect, test } from "vitest";
import { derive, frame, initialScreen, press, teamRows } from "../../src/fleet/screen.js";
import { handEdit, handLines, liftReach, namesOf } from "../../src/fleet/hand.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import { health, POOL, source } from "./world.js";
import { keysFrom, text } from "./drive.js";

describe("answers and the one write path", () => {
  test("e changes a line by hand: the lines, the models that may take one, the ticks in order, and the same review and save", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    // the home view names the key, and with nothing to answer it says so in words
    expect(text(src, initialScreen(), 100, 30).at(-1)).toMatch(/e\s+change a line/);
    const quiet = source({ repoText: "consult:\n  prefer: [codex:gpt-6-astra]\nreview:\n  required: true\n" });
    expect(derive(quiet, initialScreen()).items).toEqual([]);
    expect(text(quiet, initialScreen(), 100, 30).join("\n")).toContain("e changes a line by hand: shapes, judge, review, consult, mode, deny lists.");
    // e: every shape, then the judge, review and consult
    let st = press(src, initialScreen(), "e").state;
    expect(st.view).toBe("lines");
    const list = text(src, st, 100, 30).join("\n");
    for (const name of ["plan", "implement", "chore", "judge", "review", "consult", "deny.models", "deny.workers.models"]) expect(list, name).toMatch(new RegExp(`^ . ${name} `, "m"));
    // the heading and its legend are whole on the narrowest terminal the screen is drawn for
    expect(text(src, st, 60, 16)[1].trimEnd()).toBe(" CHANGE A LINE  Enter opens one   × not working now");
    expect(list).toContain("no pool: the router picks by cost within the floor");
    // down to implement (third line), Enter opens it: its pool is ticked in its order
    st = keysFrom(src, st, "down", "down", "enter");
    expect(st.view).toBe("pick");
    expect(st.pick).toMatchObject({ line: "implement", chosen: ["codex:gpt-6-astra", "codex:gpt-5.6-terra"] });
    const open = text(src, st, 100, 30).join("\n");
    expect(open).toMatch(/\[1\] +codex:gpt-6-astra +frontier/);
    expect(open).toMatch(/\[2\] +codex:gpt-5.6-terra +mid/);
    expect(open).toMatch(/\[ \] +claude-code:opus +frontier/);
    // untick terra, tick opus: the candidates are strongest first, so move to each by name
    const cands = () => handLines(derive(src, st).full ?? derive(src, st).base!).find((l) => l.id === "implement")!.candidates;
    const goto = (key: string) => { const at = cands().indexOf(key); st = { ...st, pick: { ...st.pick!, at } }; };
    goto("codex:gpt-5.6-terra"); st = press(src, st, " ").state;
    goto("claude-code:opus"); st = press(src, st, " ").state;
    expect(st.pick!.chosen).toEqual(["codex:gpt-6-astra", "claude-code:opus"]);
    st = press(src, st, "enter").state;
    expect(st).toMatchObject({ view: "home", pick: null, msg: "implement changed. Enter shows what changes and saves it." });
    expect(st.hand).toEqual([{ line: "implement", chosen: ["codex:gpt-6-astra", "claude-code:opus"], mode: "any" }]);
    expect(derive(src, st).hand).toEqual([{ layer: "repo", path: ["routing", "map", "implement"], value: { pool: { mode: "any", channels: ["codex:gpt-6-astra", "claude-code:opus"] } }, label: "implement: add opus; remove gpt-5.6-terra" }]);
    // the team redraws at once, the change is counted, and it is not saved
    const d = derive(src, st);
    expect(d.full!.cfg.routing.map.implement!.pool!.channels).toEqual(["codex:gpt-6-astra", "claude-code:opus"]);
    expect(text(src, st, 100, 30).join("\n")).toContain("1 changed by hand");
    expect(press(src, st, "q").action).toEqual({ kind: "quit", unsaved: 1 });
    // the review names it and shows the lines of the file; y saves exactly that
    const review = press(src, st, "enter").state;
    expect(review.view).toBe("review");
    const shown = text(src, review, 100, 40).join("\n");
    expect(shown).toContain("YOU CHANGED BY HAND");
    expect(shown).toContain("implement: add opus; remove gpt-5.6-terra");
    expect(shown).toMatch(/- +- codex:gpt-5.6-terra/);
    expect(shown).toMatch(/\+ +- claude-code:opus/);
    const saved = press(src, review, "y");
    expect(saved.action).toMatchObject({ kind: "save", touched: ["repo"] });
    expect((saved.action as { texts: { repoText: string } }).texts.repoText).toContain("          # the frontier worker\n          - codex:gpt-6-astra\n          - claude-code:opus\n");
    // u takes the change back
    expect(press(src, st, "u").state).toMatchObject({ hand: [], msg: "Last change by hand undone." });
  });
  test("changing a line by hand: the judge is one model, nothing ticked is not a choice, and the same choice again is no change", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    const lines = handLines(derive(src, initialScreen()).base!);
    const at = (id: string) => lines.findIndex((l) => l.id === id);
    // the judge: ticking another model replaces the one that was ticked
    let st = { ...initialScreen(), view: "lines" as const, line: at("judge") };
    st = press(src, st, "enter").state;
    expect(st.pick!.chosen).toEqual(["claude-code:fable"]);
    const judge = lines[at("judge")];
    st = { ...st, pick: { ...st.pick!, at: judge.candidates.indexOf("codex:gpt-6-astra") } };
    st = press(src, st, " ").state;
    expect(st.pick!.chosen).toEqual(["codex:gpt-6-astra"]);
    st = press(src, st, "enter").state;
    expect(st.hand).toEqual([{ line: "judge", chosen: ["codex:gpt-6-astra"] }]);
    expect(derive(src, st).hand[0]).toMatchObject({ path: ["judge"], value: { adapter: "codex", model: "gpt-6-astra" }, label: "judge: gpt-6-astra" });
    expect(derive(src, st).full!.cfg.judge).toMatchObject({ adapter: "codex", model: "gpt-6-astra" });
    // nothing ticked is refused, and the line is still open
    let empty = press(src, { ...initialScreen(), view: "lines" as const, line: at("implement") }, "enter").state;
    for (const _ of [0, 1]) empty = press(src, { ...empty, pick: { ...empty.pick!, at: lines[at("implement")].candidates.indexOf(empty.pick!.chosen[0]) } }, " ").state;
    expect(empty.pick!.chosen).toEqual([]);
    expect(press(src, empty, "enter").state).toMatchObject({ view: "pick", hand: [], msg: "Tick at least one model, or Esc leaves the line as it is." });
    // Enter with the ticks as they were changes nothing; Esc leaves without a change
    const untouched = press(src, { ...initialScreen(), view: "lines" as const, line: at("implement") }, "enter").state;
    expect(press(src, untouched, "enter").state).toMatchObject({ view: "lines", hand: [], msg: "Nothing changed." });
    expect(press(src, untouched, "esc").state).toMatchObject({ view: "lines", pick: null, hand: [] });
    // a line changed and then put back by hand is withdrawn, not saved as a change that changes nothing
    const back = keysFrom(src, st, "e");
    const again = press(src, { ...back, line: at("judge") }, "enter").state;
    const restored = press(src, press(src, { ...again, pick: { ...again.pick!, at: judge.candidates.indexOf("claude-code:fable") } }, " ").state, "enter").state;
    expect(restored).toMatchObject({ hand: [], msg: "judge is back to what the config says." });
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
    let st = { ...initialScreen(), view: "lines" as const, line: lines.indexOf(line) };
    expect(text(src, st, 100, 30).join("\n")).toMatch(/deny\.workers\.models +codex:gpt-5\.6-terra · claude-code:opus/);
    st = press(src, st, "enter").state;
    const open = text(src, st, 200, 30).join("\n");
    expect(open).toContain("tick what is denied");
    expect(open).toContain("kept from all work (every shape, plan and spec too), and may still judge, review and consult: routing.deny.workers.models");
    expect(open).toMatch(/\[x\] +codex:gpt-5\.6-terra *$/m);
    // untick the first, tick fable, then untick and tick opus again: opus keeps its place in the file
    const tick = (key: string) => { st = press(src, { ...st, pick: { ...st.pick!, at: line.candidates.indexOf(key) } }, " ").state; };
    tick("codex:gpt-5.6-terra"); tick("claude-code:fable"); tick("claude-code:opus"); tick("claude-code:opus");
    st = press(src, st, "enter").state;
    expect(st.hand).toEqual([{ line: "deny.workers.models", chosen: ["claude-code:opus", "claude-code:fable"] }]);
    const d = derive(src, st);
    expect(d.hand.map((e) => e.label)).toEqual(["codex:gpt-5.6-terra: no longer denied for all work (every shape, plan and spec too); claude-code:fable: denied for all work (every shape, plan and spec too)"]);
    expect(d.full!.seat("claude-code:fable")!.denied).toMatchObject({ worker: { by: "deny" }, judge: null });
    expect(d.full!.seat("codex:gpt-5.6-terra")!.denied.worker).toBeNull();
    expect(d.texts!.repoText).toContain("        # too slow\n        - claude-code:opus\n        - claude-code:fable\n");
    expect(text(src, { ...st, view: "lines" }, 100, 30).join("\n")).toMatch(/deny\.workers\.models +• claude-code:opus · claude-code:fable/);
    // nothing ticked is a choice here: the list is emptied, and the config still loads
    let none = press(src, { ...initialScreen(), view: "lines" as const, line: lines.indexOf(line) }, "enter").state;
    for (const key of ["codex:gpt-5.6-terra", "claude-code:opus"]) none = press(src, { ...none, pick: { ...none.pick!, at: line.candidates.indexOf(key) } }, " ").state;
    none = press(src, none, "enter").state;
    expect(none.hand).toEqual([{ line: "deny.workers.models", chosen: [] }]);
    const dn = derive(src, none);
    expect(dn.refused).toBeUndefined();
    expect(dn.full!.seat("claude-code:opus")!.denied.worker).toBeNull();
    // a model another entry already covers says so on its row and, under the cursor, in full
    const wide = source({ repoText: "routing:\n  deny:\n    adapters: [claude-code]\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    const wl = handLines(derive(wide, initialScreen()).base!), wm = wl.find((l) => l.id === "deny.workers.models")!;
    const shown = text(wide, { ...initialScreen(), view: "pick", pick: { line: wm.id, chosen: [], at: wm.candidates.indexOf("claude-code:fable") } }, 110, 40).join("\n");
    expect(shown).toMatch(/\[ \] +claude-code:fable +denied in deny\.adapters/);
    // the reason is whole on an 80-column terminal
    expect(text(wide, { ...initialScreen(), view: "pick", pick: { line: wm.id, chosen: [], at: 0 } }, 80, 24).join("\n")).toMatch(/claude-code:fable +denied in deny\.adapters *$/m);
    expect(shown).toContain("claude-code:fable is already denied by the entry claude-code in deny.adapters.");
  });
  test("a model a rule keeps out is on the line with the reason, and a tick lifts that rule in the same save, as far as the line needs", () => {
    // fable is denied for all work and named on two pools; opus is denied for every seat; sonnet only through its whole CLI
    const repoText = "routing:\n  deny:\n    models:\n      - claude-code:opus\n    workers:\n      models:\n        - claude-code:fable\n  map:\n    plan:\n      pool:\n        mode: any\n        channels: [codex:gpt-6-astra]\n"
      + "    tests:\n      pool:\n        mode: any\n        channels: [codex:gpt-6-astra, claude-code:fable]\nconsult:\n  prefer: [codex:gpt-6-astra]\n";
    const src = source({ repoText });
    const base = derive(src, initialScreen()).base!, lines = handLines(base), plan = lines.find((l) => l.id === "plan")!;
    // kept out by a rule, not by the probe: listed after the working models, never just missing
    expect(plan.barred).toEqual({ "claude-code:fable": { why: "the deny rule claude-code:fable for all work (every shape, plan and spec too)", liftable: true },
      "claude-code:opus": { why: "the deny rule claude-code:opus, which covers every seat", liftable: true } });
    expect(plan.candidates.indexOf("claude-code:fable")).toBeGreaterThan(plan.candidates.indexOf("codex:gpt-6-astra"));
    // before the tick: the row says denied, and under the cursor how far the lift reaches
    let st = press(src, { ...initialScreen(), view: "lines" as const, line: lines.indexOf(plan) }, "enter").state;
    st = { ...st, pick: { ...st.pick!, at: plan.candidates.indexOf("claude-code:fable") } };
    const open = text(src, st, 110, 40).join("\n");
    expect(open).toMatch(/\[ \] +claude-code:fable +frontier +denied/);
    expect(open).toContain("A tick lifts that in the same save. It comes back on spec, tests too, which name it.");
    expect(liftReach(base, plan, "claude-code:fable")).toEqual({ seats: [], named: ["spec", "tests"], open: ["spec", "implement", "docs", "migration", "ui", "refactor", "chore"].filter((sh) => !base.cfg.routing.map[sh]?.pool && !base.cfg.routing.map[sh]?.pin) });
    // a rule for every seat, lifted for a shape, lets the model take the other seats too, and that is said before the tick
    expect(liftReach(base, plan, "claude-code:opus").seats).toEqual(["judge", "review", "consult"]);
    expect(text(src, { ...st, pick: { ...st.pick!, at: plan.candidates.indexOf("claude-code:opus") } }, 220, 40).map((l) => l.trim()).join(" ")).toContain("A tick lifts that in the same save. It may also take");
    expect(text(src, { ...st, pick: { ...st.pick!, at: plan.candidates.indexOf("claude-code:opus") } }, 220, 40).map((l) => l.trim()).join(" ")).toContain("It may then judge, review and consult too: no rule keeps it from one seat alone.");
    // lifted for the judge's line, it is denied for all work in the same answer, and may review and consult
    expect(liftReach(base, lines.find((l) => l.id === "judge")!, "claude-code:opus").seats).toEqual(["review", "consult"]);
    st = press(src, press(src, st, " ").state, "enter").state;
    expect(st.msg).toBe("plan changed, and the rule that kept claude-code:fable out is lifted. Enter shows what changes and saves it.");
    expect(st.hand).toEqual([{ line: "plan", chosen: ["codex:gpt-6-astra", "claude-code:fable"], mode: "any" }]);
    const d = derive(src, st);
    expect(d.hand.map((e) => e.label)).toEqual(["plan: add fable", "claude-code:fable: no longer denied for all work (every shape, plan and spec too)"]);
    expect(d.full!.seat("claude-code:fable")!.live.worker).toBe(true);
    // only fable's rule: opus stays denied for every seat
    expect(d.full!.seat("claude-code:opus")!.denied.worker).not.toBeNull();
    expect(d.changed).toEqual(["plan"]);
    expect(text(src, { ...st, view: "review" }, 110, 40).join("\n")).toContain("  ·  claude-code:fable: no longer denied for all work (every shape, plan and spec too)");
    // unticking it again withdraws the change, and the rule with it
    let back = press(src, { ...st, view: "lines" as const, line: lines.indexOf(plan) }, "enter").state;
    const now = handLines(d.full!).find((l) => l.id === "plan")!;
    back = press(src, press(src, { ...back, pick: { ...back.pick!, at: now.candidates.indexOf("claude-code:fable") } }, " ").state, "enter").state;
    expect(back).toMatchObject({ hand: [], msg: "plan is back to what the config says." });
    expect(derive(src, back).edits).toEqual([]);
    // denying it again on the deny line after the tick is kept, not taken for "back to the config": the later choice wins
    const deny = lines.find((l) => l.id === "deny.workers.models")!;
    let again = press(src, { ...st, view: "lines" as const, line: lines.indexOf(deny) }, "enter").state;
    expect(again.pick!.chosen).toEqual([]);
    again = press(src, press(src, { ...again, pick: { ...again.pick!, at: handLines(d.full!).find((l) => l.id === deny.id)!.candidates.indexOf("claude-code:fable") } }, " ").state, "enter").state;
    expect(again.hand.map((x) => x.line)).toEqual(["plan", "deny.workers.models"]);
    expect(derive(src, again).full!.seat("claude-code:fable")!.denied.worker).not.toBeNull();
    // a judge's line narrows a rule for every seat to all work: opus may judge, and still takes no task
    const judge = derive(src, { ...initialScreen(), hand: [{ line: "judge", chosen: ["claude-code:opus"] }] });
    expect(judge.hand.map((e) => e.label)).toEqual(["judge: opus", "claude-code:opus: no longer denied for every seat", "claude-code:opus: denied for all work (every shape, plan and spec too)"]);
    expect(judge.full!.seat("claude-code:opus")!.denied).toMatchObject({ judge: null, worker: { by: "deny" } });
    // a rule on a whole CLI is not lifted by a tick: the tick is refused and names that CLI (RULING-T5 rule 5)
    const wide = source({ repoText: "routing:\n  deny:\n    adapters: [claude-code]\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    const wl = handLines(derive(wide, initialScreen()).base!), wp = wl.find((l) => l.id === "plan")!;
    expect(wp.barred["claude-code:opus"]).toEqual({ why: "the deny rule claude-code, which covers the whole claude-code CLI", liftable: false });
    const refused = press(wide, { ...initialScreen(), view: "pick", pick: { line: "plan", chosen: ["codex:gpt-6-astra"], at: wp.candidates.indexOf("claude-code:opus") } }, " ").state;
    expect(refused.pick!.chosen).toEqual(["codex:gpt-6-astra"]);
    expect(refused.msg).toBe("claude-code:opus is kept out by the deny rule claude-code, which covers the whole claude-code CLI. Change that on its deny line first (Esc, then the deny lines below).");
    expect(text(wide, { ...refused, msg: "" }, 110, 40).join("\n")).toMatch(/claude-code:opus +frontier +denied by a wider rule/);
    const bare = handLines(derive(source({ repoText: "routing:\n  deny:\n    workers:\n      models: [zai/glm-5.3, gpt-6-astra]\nconsult:\n  prefer: [codex:gpt-6-sol]\n" }), initialScreen()).base!).find((l) => l.id === "plan")!;
    expect(bare.barred["pi:zai/glm-5.3"]).toEqual({ why: "the deny rule zai/glm-5.3, which covers more than this model", liftable: false });
    expect(bare.barred["omp:zai/glm-5.3"]).toMatchObject({ liftable: false });
    expect(bare.barred["codex:gpt-6-astra"]).toEqual({ why: "the deny rule gpt-6-astra for all work (every shape, plan and spec too)", liftable: true });
    // and a choice that names it anyway (no key makes one) lifts nothing
    expect(derive(wide, { ...initialScreen(), hand: [{ line: "plan", chosen: ["codex:gpt-6-astra", "claude-code:opus"] }] }).hand.map((e) => e.path.join("."))).toEqual(["routing.map.plan"]);
    // a model the config already names on a line and a rule keeps out stays kept out: reordering the line lifts nothing
    const tests = lines.find((l) => l.id === "tests")!;
    expect(tests.current).toEqual(["codex:gpt-6-astra", "claude-code:fable"]);
    const reordered = derive(src, { ...initialScreen(), hand: [{ line: "tests", chosen: ["claude-code:fable", "codex:gpt-6-astra"] }] });
    expect(reordered.hand.map((e) => e.label)).toEqual(["tests: a new order"]);
    expect(reordered.full!.seat("claude-code:fable")!.denied.worker).not.toBeNull();
    const named = text(src, { ...initialScreen(), view: "pick", pick: { line: "tests", chosen: [...tests.current], at: tests.candidates.indexOf("claude-code:fable") } }, 200, 40).map((l) => l.trim()).join(" ");
    expect(named).toContain("claude-code:fable is named on this line and answers, and is kept out by the deny rule claude-code:fable for all work (every shape, plan and spec too). Untick it on its deny line to let it work here.");
  });
  test("a line changed by hand is made on top of the answers: the consult's yes and a tick on a shape end in one list each", () => {
    const repoText = "routing:\n  deny:\n    models:\n      - claude-code:fable\n      - claude-code:opus\nconsult:\n  prefer: [claude-code:fable]\n";
    const src = source({ repoText });
    // yes: fable may consult, denied for all work. Then by hand: opus on plan, which lifts opus for every seat
    const d = derive(src, { ...initialScreen(), yes: ["consult"], hand: [{ line: "plan", chosen: ["claude-code:opus"] }] });
    expect(d.refused).toBeUndefined();
    const routing = d.full!.cfg.routing;
    expect(routing.deny?.models ?? []).toEqual([]);
    expect(routing.deny?.workers?.models).toEqual(["claude-code:fable"]);
    expect(d.full!.consult).toBe("claude-code:fable");
    expect(d.full!.seat("claude-code:opus")!.live.worker).toBe(true);
    // one edit for each list, and the hand's label says only what the hand did
    expect(d.edits.filter((e) => e.path.join(".") === "routing.deny.models")).toHaveLength(1);
    expect(d.hand.map((e) => e.label)).toEqual(["plan: add opus; remove fable; the pin becomes a pool", "claude-code:opus: no longer denied for every seat"]);
  });
  test("an opened shape shows who takes its tasks with the ticks as they stand; o turns the pool's mode and [ ] move a tick in the order", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    const lines = handLines(derive(src, initialScreen()).base!), impl = lines.find((l) => l.id === "implement")!;
    // only a shape has a mode
    expect(impl.mode).toBe("any");
    expect(lines.filter((l) => l.mode).map((l) => l.id)).toEqual(["plan", "spec", "implement", "tests", "docs", "migration", "ui", "refactor", "chore"]);
    let st = press(src, { ...initialScreen(), view: "lines" as const, line: lines.indexOf(impl) }, "enter").state;
    expect(st.pick).toMatchObject({ mode: "any", chosen: ["codex:gpt-6-astra", "codex:gpt-5.6-terra"] });
    const rows = (s = st) => text(src, s, 100, 60).join("\n");
    // the mode in the router's words, and each ticked model's part of the shape's tasks: the cheaper one takes them all
    expect(rows()).toContain("Pool mode any: the cheapest takes each task; vendors at one cost take turns;");
    expect(rows()).toMatch(/\[1\] +codex:gpt-6-astra +frontier +takes none/);
    expect(rows()).toMatch(/\[2\] +codex:gpt-5\.6-terra +mid +takes all 400/);
    expect(rows()).toMatch(/\[ \] +claude-code:opus +frontier *$/m);
    // under the cursor, a ticked model that takes nothing says why
    const on = (k: string) => { st = { ...st, pick: { ...st.pick!, at: impl.candidates.indexOf(k) } }; };
    on("codex:gpt-6-astra");
    expect(text(src, st, 200, 60).map((l) => l.trim()).join(" ")).toContain("codex:gpt-6-astra takes none of implement's tasks with these ticks: an any pool gives each task to the cheapest, and of one vendor's models to the first ticked. To give it the work, o makes the pool ordered and [ moves it first.");
    // a tick shows its effect at once, before Enter: opus shares the work with terra
    on("claude-code:opus"); st = press(src, st, " ").state;
    expect(rows()).toMatch(/\[3\] +claude-code:opus +frontier +takes \d+ of 400/);
    // [ moves it earlier, ] later; at either end the key does nothing
    st = press(src, press(src, st, "[").state, "[").state;
    expect(st.pick!.chosen).toEqual(["claude-code:opus", "codex:gpt-6-astra", "codex:gpt-5.6-terra"]);
    expect(press(src, st, "[").state.pick!.chosen).toEqual(st.pick!.chosen);
    expect(press(src, st, "]").state.pick!.chosen).toEqual(["codex:gpt-6-astra", "claude-code:opus", "codex:gpt-5.6-terra"]);
    // an unticked model has no place to move
    on("claude-code:fable"); expect(press(src, st, "]").state.pick!.chosen).toEqual(st.pick!.chosen); on("claude-code:opus");
    // o: ordered, and the first that works takes every task
    st = press(src, st, "o").state;
    expect(st.pick!.mode).toBe("ordered");
    expect(rows()).toContain("Pool mode ordered: the first that works takes every task, the rest stand by. o makes it any.");
    expect(rows()).toMatch(/\[1\] +claude-code:opus +frontier +takes all 400/);
    expect(rows()).toMatch(/\[3\] +codex:gpt-5\.6-terra +mid +takes none/);
    on("codex:gpt-5.6-terra");
    expect(text(src, st, 200, 60).map((l) => l.trim()).join(" ")).toContain("codex:gpt-5.6-terra takes none of implement's tasks with these ticks: an ordered pool gives every task to the first that works. To give it the work, [ moves it first.");
    // and it is true: moved first in the ordered pool, terra takes every task
    const first = press(src, press(src, st, "[").state, "[").state;
    expect(first.pick!.chosen[0]).toBe("codex:gpt-5.6-terra");
    expect(text(src, first, 100, 60).join("\n")).toMatch(/\[1\] +codex:gpt-5\.6-terra +mid +takes all 400/);
    // the keys are named, whole, on an 80-column terminal
    expect(text(src, st, 80, 24).at(-1)!.trimEnd()).toBe("  Space  tick   [ ]  order   o  mode   f  floor   Enter  done   Esc  cancel");
    // Enter: the choice carries the mode, the edit writes it, the label says it
    const done = press(src, st, "enter").state;
    expect(done.hand).toEqual([{ line: "implement", chosen: ["claude-code:opus", "codex:gpt-6-astra", "codex:gpt-5.6-terra"], mode: "ordered" }]);
    const d = derive(src, done);
    expect(d.hand).toEqual([{ layer: "repo", path: ["routing", "map", "implement"], value: { pool: { mode: "ordered", channels: ["claude-code:opus", "codex:gpt-6-astra", "codex:gpt-5.6-terra"] } }, label: "implement: add opus; a new order; mode ordered" }]);
    expect(d.full!.sample().rows.implement.shares.map((x) => [x.key, x.pct])).toEqual([["claude-code:opus", 100]]);
    // the mode alone is a change; put back, the change is withdrawn
    const only = press(src, press(src, press(src, { ...initialScreen(), view: "lines" as const, line: lines.indexOf(impl) }, "enter").state, "o").state, "enter").state;
    expect(only.hand).toEqual([{ line: "implement", chosen: ["codex:gpt-6-astra", "codex:gpt-5.6-terra"], mode: "ordered" }]);
    expect(derive(src, only).hand[0].label).toBe("implement: mode ordered");
    const again = press(src, { ...only, view: "lines" as const, line: lines.indexOf(impl) }, "enter").state;
    expect(again.pick!.mode).toBe("ordered");
    expect(press(src, press(src, again, "o").state, "enter").state).toMatchObject({ hand: [], msg: "implement is back to what the config says." });
    // the judge, a prefer list and a deny list have no mode: o does nothing there, and the judge has no order to move in
    const judge = press(src, { ...initialScreen(), view: "lines" as const, line: lines.findIndex((l) => l.id === "judge") }, "enter").state;
    expect(press(src, judge, "o").state.pick).toEqual(judge.pick);
    expect(text(src, judge, 100, 30).at(-1)!.trimEnd()).toBe("  ↑↓  move   Space  tick   Enter  done   Esc  cancel");
  });
  test("the routing mode is a line: one of three, each saying what it does, and the review shows what the floors then do", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    const lines = handLines(derive(src, initialScreen()).base!), mode = lines.find((l) => l.id === "mode")!;
    expect(mode).toMatchObject({ setting: true, one: true, path: ["routing", "mode"], current: ["partner-led"], candidates: ["partner-led", "risk-based", "staff-led"] });
    // after the team's lines, before the deny lists
    expect(lines.map((l) => l.id).slice(11, 14)).toEqual(["consult", "mode", "deny.adapters"]);
    expect(text(src, { ...initialScreen(), view: "lines" }, 80, 24).find((l) => /^ {3}mode /.test(l))!.trimEnd()).toBe("   mode                    partner-led");
    let st = press(src, { ...initialScreen(), view: "lines" as const, line: lines.indexOf(mode) }, "enter").state;
    const open = text(src, st, 100, 30).join("\n");
    expect(open).toContain(" mode  choose one");
    expect(open).toMatch(/\(•\) +partner-led +every shape needs a frontier model/);
    expect(open).toMatch(/\( \) +risk-based +each shape keeps its own floor \(the default\)/);
    expect(open).toMatch(/\( \) +staff-led +one tier lower; plan, spec, migration, ui stay frontier/);
    // each says what it does, whole, on an 80-column terminal
    for (const l of text(src, st, 80, 24)) expect(l, l).not.toContain("…");
    // at 60 columns the rows have no room for it: they name the mode, and the one under the cursor says it whole below
    for (const at2 of [0, 1, 2]) {
      const narrow = text(src, { ...st, pick: { ...st.pick!, at: at2 } }, 60, 16);
      for (const l of narrow) expect(l, l).not.toContain("…");
      expect(narrow.map((l) => l.trim()).join(" ")).toContain(`${mode.candidates[at2]}: ${["every shape needs a frontier model", "each shape keeps its own floor (the default)", "one tier lower; plan, spec, migration, ui stay frontier"][at2]}.`);
    }
    // no pool mode, no order, no tier and no "not a configured model" on a setting
    expect(open).not.toContain("Pool mode");
    expect(open).not.toContain("not a configured model");
    expect(text(src, st, 100, 30).at(-1)!.trimEnd()).toBe("  ↑↓  move   Space  tick   Enter  done   Esc  cancel");
    // one is chosen: a tick replaces the one before
    st = press(src, { ...st, pick: { ...st.pick!, at: 1 } }, " ").state;
    expect(st.pick!.chosen).toEqual(["risk-based"]);
    st = press(src, st, "enter").state;
    expect(st.hand).toEqual([{ line: "mode", chosen: ["risk-based"] }]);
    const d = derive(src, st);
    expect(d.hand).toEqual([{ layer: "repo", path: ["routing", "mode"], value: "risk-based", label: "mode: risk-based" }]);
    expect(d.full!.mode.mode).toBe("risk-based");
    expect(d.texts!.repoText).toContain("routing:\n  mode: risk-based\n");
    // the header names the mode before anything is saved. What the floors then do is in the review, and only on its floor rows.
    const header = text(src, st, 100, 30)[0];
    expect(header).toContain("mode risk-based");
    expect(header).not.toContain("the floor moved");
    const review = press(src, st, "enter").state;
    expect(review.view).toBe("review");
    const rows = text(src, review, 100, 40);
    expect(rows.filter((l) => !/floor/.test(l)).join("\n")).not.toContain("the floor moved");
    // partner-led held every shape at frontier. risk-based returns each shape's own floor, and the review says the bar moved.
    const floorRows = rows.map((l) => l.trim().replace(/\s+/g, " ")).filter((l) => /floor/.test(l));
    expect(floorRows).toEqual([
      "shapes at their floor 8 → 9 the floor moved",
      "tasks below their floor 400 → 0 the floor moved",
      "shapes with fewer than two models at their floor 1 → 0 the floor moved",
    ]);
    // the same mode again is no change
    const again = press(src, { ...initialScreen(), view: "lines" as const, line: lines.indexOf(mode) }, "enter").state;
    expect(press(src, again, "enter").state).toMatchObject({ view: "lines", hand: [], msg: "Nothing changed." });
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
      let st = press(src, { ...initialScreen(), view: "lines" as const, line: lines.indexOf(modeLine) }, "enter").state;
      st = press(src, { ...st, pick: { ...st.pick!, at: modeLine.candidates.indexOf(to) } }, " ").state;
      st = press(src, st, "enter").state;
      const review = press(src, st, "enter").state;
      expect(review.view, `${from} → ${to}`).toBe("review");
      const floorRows = text(src, review, 100, 40).map((l) => l.trim().replace(/\s+/g, " ")).filter((l) => /floor/.test(l));
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
    let st = press(src, { ...initialScreen(), view: "lines" as const, line: lines.indexOf(impl) }, "enter").state;
    const head = (s = st) => text(src, s, 100, 40).join("\n");
    expect(head()).toContain("Floor: what mode partner-led says (frontier). f sets one for this shape.");
    // f: cheap, mid, frontier, and back to what the mode says
    st = press(src, st, "f").state;
    expect(head()).toContain("Floor: cheap, set for this shape; it beats the mode. f changes it.");
    expect(keysFrom(src, st, "f", "f", "f").pick!.floor).toBe("mode");
    expect(press(src, keysFrom(src, st, "f", "f", "f"), "enter").state).toMatchObject({ view: "lines", hand: [], msg: "Nothing changed." });
    st = press(src, st, "f").state;
    expect(st.pick!.floor).toBe("mid");
    // Enter: the floor alone. The models are not part of the change, so no pool is rewritten
    const done = press(src, st, "enter").state;
    expect(done.hand).toEqual([{ line: "implement", chosen: [], floor: "mid" }]);
    const d = derive(src, done);
    expect(d.hand).toEqual([{ layer: "repo", path: ["routing", "floors", "implement"], value: "mid", label: "implement: floor mid, where mode partner-led said frontier" }]);
    expect(d.full!.cfg.routing.floors.implement).toBe("mid");
    expect(d.full!.mode.provenance.implement).toBe("config floors");
    expect(d.texts!.repoText).toContain("  floors:\n    implement: mid\n");
    // the closed screen does not read "ok" under "mode partner-led" for a bar that was lowered: it names the bar
    expect(d.full!.lowered).toEqual({ implement: { own: "mid", mode: "frontier" } });
    expect(teamRows(d.full!).find((r) => r.label.includes("implement"))!.status).toBe("ok, floor mid");
    expect(text(src, done, 100, 30).join("\n")).toMatch(/implement +gpt-5\.6-terra +ok, floor mid/);
    expect(text(src, done, 100, 30)[0]).toContain("mode partner-led");
    // on a short terminal such a line is not listed among the lines that are not ok
    expect(text(src, done, 60, 16).join("\n")).not.toMatch(/these are not:[\s\S]*implement/);
    // a floor raised above the mode's, or set to what the mode says, is a bar met: plain ok, and nothing is called lowered
    for (const [floors, mode] of [["implement: frontier", "risk-based"], ["implement: mid", "risk-based"], ["docs: frontier", "partner-led"]] as const) {
      const m = derive(source({ repoText: `routing:\n  mode: ${mode}\n  floors:\n    ${floors}\nconsult:\n  prefer: [codex:gpt-6-astra]\n` }), initialScreen()).base!;
      expect(m.lowered, floors).toEqual({});
    }
    // under risk-based a floor below the shape's default is lowered too
    expect(derive(source({ repoText: "routing:\n  floors:\n    implement: cheap\nconsult:\n  prefer: [codex:gpt-6-astra]\n" }), initialScreen()).base!.lowered).toEqual({ implement: { own: "cheap", mode: "mid" } });
    // the review does not call a lowered floor better: the same tasks against another bar
    const review = text(src, { ...done, view: "review" }, 100, 40).join("\n");
    expect(review).toMatch(/tasks below their floor +400 → 0 +the floor moved/);
    expect(review).not.toMatch(/floor.*better/);
    // reopened, the line says the floor is this shape's own; ticks and a floor travel in one choice
    const again = press(src, { ...done, view: "lines" as const, line: lines.indexOf(impl) }, "enter").state;
    expect(text(src, again, 100, 40).join("\n")).toContain("Floor: mid, set for this shape; it beats the mode. f changes it.");
    const both = press(src, press(src, { ...again, pick: { ...again.pick!, at: impl.candidates.indexOf("claude-code:opus") } }, " ").state, "enter").state;
    expect(both.hand).toEqual([{ line: "implement", chosen: ["codex:gpt-6-astra", "codex:gpt-5.6-terra", "claude-code:opus"], mode: "any", floor: "mid" }]);
    expect(derive(src, both).hand.map((e) => e.label)).toEqual(["implement: floor mid, where mode partner-led said frontier", "implement: add opus"]);
    // put back to what the mode says, the change is withdrawn
    const back = press(src, { ...done, view: "lines" as const, line: lines.indexOf(impl) }, "enter").state;
    expect(press(src, keysFrom(src, back, "f", "f"), "enter").state).toMatchObject({ hand: [], msg: "implement is back to what the config says." });
    // a floor a config sets for one shape: "mode" takes it away, and the file loses the line
    const own = source({ repoText: "routing:\n  floors:\n    docs: frontier # the docs are the product\n    ui: frontier\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    const ol = handLines(derive(own, initialScreen()).base!), docs = ol.find((l) => l.id === "docs")!;
    expect(docs.floor).toEqual({ tier: "frontier", own: true });
    const opened = press(own, { ...initialScreen(), view: "lines" as const, line: ol.indexOf(docs) }, "enter").state;
    expect(text(own, opened, 100, 40).join("\n")).toContain("Floor: frontier, set for this shape; it beats the mode. f changes it.");
    // docs has no pool: nothing ticked and a floor is a choice; nothing ticked and no floor is not
    expect(press(own, opened, "enter").state.msg).toBe("Tick at least one model, or Esc leaves the line as it is.");
    const freed = press(own, press(own, opened, "f").state, "enter").state;
    expect(freed.hand).toEqual([{ line: "docs", chosen: [], floor: "mode" }]);
    const fd = derive(own, freed);
    expect(fd.hand).toEqual([{ layer: "repo", path: ["routing", "floors", "docs"], value: undefined, label: "docs: floor as mode risk-based says, was frontier for this shape" }]);
    expect(fd.texts!.repoText).toBe("routing:\n  floors:\n    ui: frontier\nconsult:\n  prefer: [codex:gpt-6-astra]\n");
    expect(fd.full!.cfg.routing.floors.docs).toBe("cheap");
    expect(fd.full!.cfg.routing.map.docs?.pool).toBeUndefined();
    // the judge has no floor: f does nothing there
    const judge = press(src, { ...initialScreen(), view: "lines" as const, line: lines.findIndex((l) => l.id === "judge") }, "enter").state;
    expect(press(src, judge, "f").state.pick).toEqual(judge.pick);
  });
  test("a line kept in the user config says so when it is opened, before the change and not only in the review", () => {
    // the judge and the consult are set for every repository; implement's pool is this repository's
    const src = source({ userText: "judge:\n  adapter: codex\n  model: gpt-6-astra\nconsult:\n  prefer: [codex:gpt-6-astra]\n", repoText: POOL });
    const lines = handLines(derive(src, initialScreen()).base!);
    expect(Object.fromEntries(lines.filter((l) => ["judge", "consult", "implement", "review", "deny.models"].includes(l.id)).map((l) => [l.id, l.layer])))
      .toEqual({ judge: "user", consult: "user", implement: "repo", review: "repo", "deny.models": "repo" });
    const open = (id: string, cols = 100, rows = 30) => text(src, press(src, { ...initialScreen(), view: "lines" as const, line: lines.findIndex((l) => l.id === id) }, "enter").state, cols, rows).map((l) => l.trim()).join(" ");
    expect(open("judge")).toContain("This line is in your user config: every repository on this machine reads it.");
    expect(open("consult")).toContain("This line is in your user config");
    expect(open("implement")).not.toContain("your user config");
    // whole on the smallest terminal too
    expect(open("judge", 60, 16)).toContain("This line is in your user config: every repository on this machine reads it.");
    // and the change is written there: what the line said is what the review says
    const d = derive(src, { ...initialScreen(), hand: [{ line: "judge", chosen: ["claude-code:opus"] }] });
    expect(d.texts!.touched).toEqual(["user"]);
    expect(text(src, { ...initialScreen(), hand: [{ line: "judge", chosen: ["claude-code:opus"] }], view: "review" }, 100, 40).join("\n")).toContain("Your user config: every repository on this machine reads it.");
  });
  test("a pinned shape names its model on the line; a choice makes the pin a pool, and a line that names nobody says why in a few words", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    const lines = handLines(derive(src, initialScreen()).base!), plan = lines.find((l) => l.id === "plan")!;
    expect(plan).toMatchObject({ current: ["claude-code:fable"], pinned: true, mode: "any" });
    // the list of lines, whole on an 80-column terminal: nothing ends in an ellipsis
    const list = text(src, { ...initialScreen(), view: "lines" }, 80, 24);
    expect(list.find((l) => / plan /.test(l))!.trimEnd()).toBe(" ▸ plan                    fable  pinned");
    expect(list.find((l) => / tests /.test(l))!.trimEnd()).toBe("   tests                   prefers opencode");
    expect(list.find((l) => / docs /.test(l))!.trimEnd()).toBe("   docs                    no pool: the router picks by cost within the floor");
    expect(list.find((l) => / review /.test(l))!.trimEnd()).toBe("   review                  not set: a reviewer from another vendor is picked");
    for (const l of list) expect(l, l).not.toContain("…");
    // the deny lists are set apart from the team's lines by one heading
    expect(list[list.findIndex((l) => / deny\.adapters /.test(l)) - 1].trimEnd()).toBe("   deny lists  what is ticked on one is kept out");
    expect(list.filter((l) => /^ {3}deny lists /.test(l))).toHaveLength(1);
    // opened: the pinned model is ticked, and takes every task; Enter as it is changes nothing
    const open = press(src, { ...initialScreen(), view: "lines" as const, line: lines.indexOf(plan) }, "enter").state;
    expect(open.pick!.chosen).toEqual(["claude-code:fable"]);
    const shown = text(src, open, 100, 30).join("\n");
    expect(shown).toContain("Today: claude-code:fable. A pin: that one model takes every task of this shape; a choice here");
    expect(shown).toMatch(/\[1\] +claude-code:fable +frontier +takes all 400/);
    expect(press(src, open, "enter").state).toMatchObject({ view: "lines", hand: [], msg: "Nothing changed." });
    // a shape with no pool, opened: who takes it today is said before anything is ticked, and the mode is not, until a tick makes a pool
    const docs = lines.find((l) => l.id === "docs")!;
    const bare = press(src, { ...initialScreen(), view: "lines" as const, line: lines.indexOf(docs) }, "enter").state;
    const today = text(src, bare, 100, 60).join("\n");
    expect(today).toMatch(/\[ \] +\S+ +\w+ +takes (all 400|\d+ of 400) today/);
    expect(today).not.toContain("Pool mode any");
    const one = press(src, { ...bare, pick: { ...bare.pick!, at: docs.candidates.indexOf("codex:gpt-6-astra") } }, " ").state;
    expect(text(src, one, 100, 60).join("\n")).toContain("Pool mode any: the cheapest takes each task");
    expect(text(src, one, 100, 60).join("\n")).toMatch(/\[1\] +codex:gpt-6-astra +frontier +takes all 400 *$/m);
    expect(text(src, one, 100, 60).join("\n")).not.toContain("today");
    // the label says what the pool takes the place of: nothing, a prefer list, a pin
    expect(derive(src, press(src, one, "enter").state).hand[0].label).toBe("docs: add gpt-6-astra; it gets a pool: only these take it");
    expect(lines.find((l) => l.id === "tests")).toMatchObject({ prefers: true, current: [] });
    expect(derive(src, { ...initialScreen(), hand: [{ line: "tests", chosen: ["codex:gpt-6-astra"] }] }).hand[0].label).toBe("tests: add gpt-6-astra; its prefer list becomes a pool");
    // a second model: the pin becomes a pool of the two, and the label says so
    const two = press(src, press(src, { ...open, pick: { ...open.pick!, at: plan.candidates.indexOf("codex:gpt-6-astra") } }, " ").state, "enter").state;
    const d = derive(src, two);
    expect(d.hand).toEqual([{ layer: "repo", path: ["routing", "map", "plan"], value: { pool: { mode: "any", channels: ["claude-code:fable", "codex:gpt-6-astra"] } }, label: "plan: add gpt-6-astra; the pin becomes a pool" }]);
    expect(d.refused).toBeUndefined();
    expect(d.full!.cfg.routing.map.plan).toMatchObject({ pool: { channels: ["claude-code:fable", "codex:gpt-6-astra"] } });
    expect(d.full!.cfg.routing.map.plan!.pin).toBeUndefined();
  });
  test("a model written as an alias says which model it is, and a ticked model whose rule the tick lifts shows its part like any other", () => {
    // the probe saw that claude-code:fable is claude-fable-5-2
    const h = health();
    h["claude-code"] = { ...h["claude-code"], modelAuth: { ...h["claude-code"].modelAuth, fable: { authed: true, probedAt: "2026-11-10T00:00:00Z", identity: "claude-fable-5-2" } } };
    const src = source({ health: h, repoText: "routing:\n  deny:\n    workers:\n      models: [claude-code:fable]\n  map:\n    plan:\n      pool:\n        mode: any\n        channels: [codex:gpt-6-astra]\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    const base = derive(src, initialScreen()).base!, plan = handLines(base).find((l) => l.id === "plan")!;
    expect(base.name("claude-code:fable")).toBe("claude-fable-5-2");
    const at = plan.candidates.indexOf("claude-code:fable");
    let st: ReturnType<typeof initialScreen> = { ...initialScreen(), view: "pick", pick: { line: "plan", chosen: ["codex:gpt-6-astra"], at, mode: "any" } };
    const said = (s = st) => text(src, s, 220, 60).map((l) => l.trim()).join(" ");
    expect(said()).toContain("claude-code:fable (claude-fable-5-2) answers, and is kept out by the deny rule claude-code:fable for all work (every shape, plan and spec too). A tick lifts that in the same save.");
    // a working model that is an alias, with nothing else to say, says only which model it is
    expect(said({ ...st, pick: { ...st.pick!, at: plan.candidates.indexOf("claude-code:opus") } })).not.toContain("claude-code:opus is");
    // which model an alias is, and nothing else to say: said calmly, not as a warning
    const calm = source({ health: h, repoText: "consult:\n  prefer: [codex:gpt-6-astra]\n" });
    const cl = handLines(derive(calm, initialScreen()).base!).find((l) => l.id === "docs")!;
    const frame1 = frame(calm, { ...initialScreen(), view: "pick", pick: { line: "docs", chosen: [], at: cl.candidates.indexOf("claude-code:fable"), mode: "any" } }, 110, 40);
    const row = frame1.find((l) => l.map((x) => x.text).join("").includes("claude-code:fable is claude-fable-5-2."))!;
    expect(row.map((x) => x.style)).toContain("dim");
    expect(row.map((x) => x.style)).not.toContain("warn");
    // ticked: the row shows its part of the tasks with the rule lifted, not "denied", and the words under it say the tick lifts the rule
    st = press(src, st, " ").state;
    expect(text(src, st, 110, 60).join("\n")).toMatch(/\[2\] +claude-code:fable +frontier +takes \d+ of 400/);
    expect(said()).toContain("claude-code:fable (claude-fable-5-2): this tick lifts the rule that kept it out, in the same save.");
    // however narrow the terminal, what is said under the list is said to its last word
    for (const cols of [60, 80]) expect(text(src, st, cols, 24).map((l) => l.trim()).join(" "), String(cols)).toContain("in the same save.");
    // the smallest terminal the screen is drawn for: the row still says its part of the work, three rows of the list are in view,
    // and the words under it are whole, before the tick and after it
    const before = { ...st, pick: { ...st.pick!, chosen: ["codex:gpt-6-astra"] } };
    const small = text(src, before, 60, 16);
    expect(small.find((l) => l.includes("claude-code:fable "))!.trimEnd()).toMatch(/\[ \] +claude-code:fable +denied$/);
    expect(small.map((l) => l.trim()).join(" ")).toContain("A tick lifts that in the same save.");
    expect(small.filter((l) => /^ . \[/.test(l)).length).toBeGreaterThanOrEqual(3);
    const after = text(src, st, 60, 16);
    expect(after.find((l) => l.includes("claude-code:fable "))!.trimEnd()).toMatch(/\[2\] +claude-code:fable +\d+ of 400$/);
    // the line's own heading is whole at 60 columns
    expect(small[1].trimEnd()).toBe(" plan  tick its models, in order");
    // the header keeps the age of the probe at 60 columns
    expect(small[0].trimEnd()).toMatch(/^ fleet {2}mode risk-based {2}\d+ working · probed 1 day ago$/);
    // every row in view is whole at 60 columns, with the longest key the config has in view or not
    for (let at2 = 0; at2 < plan.candidates.length; at2 += 3) for (const l of text(src, { ...before, pick: { ...before.pick!, at: at2 } }, 60, 16).filter((x) => /^ . \[/.test(x))) expect(l, l).not.toContain("…");
    expect(after.map((l) => l.trim()).join(" ")).toContain("this tick lifts the rule that kept it out, in the same save.");
  });
  test("two CLI paths to one model are told apart by their CLI, and a model not working on a line is marked in the list of lines", () => {
    const repoText = "routing:\n  map:\n    docs:\n      pool:\n        mode: any\n        channels: [pi:zai/glm-5.3, omp:zai/glm-5.3, codex:gpt-6-astra, qwen:qwen3.8-max]\nconsult:\n  prefer: [codex:gpt-6-astra]\n";
    const src = source({ repoText, health: health(["qwen:qwen3.8-max"]) });
    const M = derive(src, initialScreen()).base!;
    expect(namesOf(M, ["pi:zai/glm-5.3", "omp:zai/glm-5.3", "codex:gpt-6-astra"])).toEqual(["glm-5.3 (pi)", "glm-5.3 (omp)", "gpt-6-astra"]);
    const docs = text(src, { ...initialScreen(), view: "lines" }, 120, 30).find((l) => /^ . docs /.test(l))!;
    expect(docs).toContain("glm-5.3 (pi) · glm-5.3 (omp) · gpt-6-astra · ×qwen3.8-max");
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
    const shown = text(src, { ...initialScreen(), yes: ["floor"], hand, view: "review" }, 100, 40).join("\n");
    expect(shown).toContain("YOU SAID YES TO");
    expect(shown).toContain("YOU CHANGED BY HAND");
    // every frame of the two new views is exactly the terminal's size, at every size
    for (const [cols, rows] of [[60, 16], [80, 24], [120, 36], [40, 12]] as const) {
      for (const st of [{ ...initialScreen(), view: "lines" as const, line: 11 }, { ...initialScreen(), view: "pick" as const, pick: { line: "implement", chosen: ["codex:gpt-6-astra"], at: 30 } }]) {
        const lines = frame(src, st, cols, rows);
        expect(lines.length, `${st.view} ${cols}x${rows}`).toBe(rows);
        for (const l of lines) expect(cellWidth(l.map((x) => x.text).join("")), `${st.view} ${cols}x${rows}`).toBe(cols);
      }
    }
  });
});
