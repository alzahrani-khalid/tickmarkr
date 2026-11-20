// The one screen's keys (queue row 499; D-2187 add.357, add.363; contract 5.2): one cursor over one list,
// Enter opens what it is on, y and n answer an item, s opens the save, u undoes, r probes, q reports, and
// the CHANGE A LINE list behind e is gone. Nothing is written before the save's own key.
import { describe, expect, test } from "vitest";
import { derive, frame, homeTargets, initialScreen, press, type ScreenAction, type ScreenSource, type ScreenState } from "../../src/fleet/screen.js";
import { tooSmall } from "../../src/fleet/one-screen.js";
import { arrowsTo, keysFrom, moveTo, open, text, toItem } from "./drive.js";
import { health, source } from "./world.js";
import { setup, strip, terminal } from "../cli/fleet-screen-world.js";

const repoText = "routing:\n  deny:\n    # keep this seat out\n    adapters: [agy]\n    models: [codex:gpt-6-luna]\n";
const world = () => source({ repoText, health: health(["claude-code:fable"]) });
const BIG = { cols: 120, rows: 80 };
const KEYS = ["up", "down", "k", "j", "enter", "esc", "y", "n", "s", "u", "r", "?", "e", "d", " ", "x", "o", "f", "[", "]"];

describe("the one screen's keys", () => {
  test("tickmarkr fleet opens the one screen; the list of lines behind e is gone", async () => {
    // the command on a real (Ink) mount opens the one screen, named by its sections and its keys
    const { run } = setup();
    const t = terminal();
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("WORKERS");
    expect(t.text()).toContain("who does each shape of work, by how complex the task is");
    expect(t.text()).toContain("Enter change the line");
    expect(t.text()).not.toContain("YOUR TEAM");
    // e opens nothing: no list of lines is ever drawn
    t.input.write("e");
    await new Promise((r) => setTimeout(r, 100));
    expect(t.text()).not.toContain("CHANGE A LINE");
    t.input.write("q");
    expect(await done).toBe("fleet: nothing changed");
    // and as pure functions: no key from any view reaches a list of lines, and every frame is the one screen or a view it opened
    const src = world();
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let st = initialScreen();
    for (let i = 0; i < 300; i++) {
      st = press(src, st, KEYS[Math.floor(rnd() * KEYS.length)], BIG).state;
      expect(["home", "rule", "line", "models", "item", "save", "help"]).toContain(st.view);
      expect(text(src, st, 120, 40).join("\n")).not.toContain("CHANGE A LINE");
    }
    expect(press(src, initialScreen(), "e", BIG).state).toEqual(initialScreen());
  });

  test("one cursor moves over the mode; every line; every kept out row; every item: Enter opens what it is on", () => {
    const src = world();
    const targets = homeTargets(src, initialScreen(), BIG);
    // one list, in the screen's order: the mode, the WORKERS rows, judge, review, consult, KEPT OUT and its +, the items
    expect(targets).toEqual(["mode", "shapes:plan,spec", "shapes:implement,tests,docs,migration,ui,refactor,chore", "judge", "review", "consult",
      "kept:routing.deny.adapters", "kept:routing.deny.models", "kept+", "item:noseat", "item:judge", "item:consult", "item:fix:fable:timeout"]);
    // down walks it to its end and stops there; up walks it back; k and j are up and down
    let st = initialScreen();
    for (let i = 1; i < targets.length + 2; i++) { st = press(src, st, "down", BIG).state; expect(st.sel).toBe(Math.min(i, targets.length - 1)); }
    expect(press(src, st, "k", BIG).state.sel).toBe(targets.length - 2);
    expect(press(src, initialScreen(), "j", BIG).state.sel).toBe(1);
    expect(press(src, initialScreen(), "up", BIG).state.sel).toBe(0);
    // the cursor is drawn on the row it is on, and on no other
    const on = (s: ScreenState) => frame(src, s, 120, 80).filter((l) => l.some((x) => x.selected)).map((l) => l.map((x) => x.text).join(""));
    expect(on(initialScreen())).toHaveLength(1);
    expect(on(initialScreen())[0]).toContain("tickmarkr fleet");
    expect(on({ ...initialScreen(), sel: 3 })[0]).toContain("acceptance (judge)");
    expect(on({ ...initialScreen(), sel: 6 })[0]).toContain("agy");
    // Enter opens what it is on
    const enter = (sel: number) => press(src, { ...initialScreen(), sel }, "enter", BIG).state;
    // every line opens to a view of 2.27 (rows 499, 500): the mode, judge, review and consult to theirs, a KEPT OUT row to its rule
    expect(enter(0)).toMatchObject({ view: "line", line: { shape: "mode" } });
    for (const [sel, line] of [[3, "judge"], [4, "review"], [5, "consult"]] as const) expect(enter(sel), line).toMatchObject({ view: "line", line: { shape: line } });
    expect(enter(6)).toMatchObject({ view: "rule", rule: { list: "routing.deny.adapters", rule: "agy" } });
    expect(enter(7)).toMatchObject({ view: "rule", rule: { list: "routing.deny.models" } });
    // a row of several shapes asks which first, on one row; Enter there opens that shape
    const choose = enter(1);
    expect(choose).toMatchObject({ view: "home", choose: { ids: ["plan", "spec"], at: 0 } });
    expect(text(src, choose, 120, 80).filter((l) => l.includes("open which?"))).toHaveLength(1);
    expect(keysFrom(src, choose, "down", "enter")).toMatchObject({ view: "line", line: { shape: "spec" } });
    expect(press(src, choose, "esc", BIG).state).toMatchObject({ view: "home", choose: null });
    // + opens the models view in its keep-out form (row 500)
    expect(enter(8)).toMatchObject({ view: "models", models: { keep: true }, choose: null });
    // an item opens (5.8); Esc comes back to the same place
    for (const [sel, id] of [[9, "noseat"], [12, "fix:fable:timeout"]] as const) {
      const d = enter(sel);
      expect(d).toMatchObject({ view: "item", item: id });
      expect(press(src, d, "esc", BIG).state).toMatchObject({ view: "home", sel });
    }
    // on a window too short for the whole screen the same list is walked: every stop is a place, pages in between
    const short = homeTargets(src, initialScreen(), { cols: 80, rows: 20 });
    expect(short.filter((t, i) => t !== short[i - 1])).toEqual(targets);
    // the drive helpers reach a line the way a user does
    expect(open(src, "implement")).toMatchObject({ view: "line", line: { shape: "implement" } });
    expect(arrowsTo(src, (t) => t === "judge", BIG)).toBe("\x1b[B".repeat(3));
  });

  test("y and n answer the item under the cursor; on a line they say in one row that they answer an item", () => {
    const src = world();
    // on a line: one row of words, no answer and no action
    for (const sel of [0, 1, 3, 6, 8]) for (const key of ["y", "n"]) {
      const out = press(src, { ...initialScreen(), sel }, key, BIG);
      expect(out.action, `${sel} ${key}`).toBeUndefined();
      expect(out.state.yes).toEqual([]);
      expect(out.state.msg).toBe("y and n answer an item: move the cursor down to NEEDS YOU.");
      expect(text(src, out.state, 120, 80).filter((l) => l.includes("y and n answer an item"))).toHaveLength(1);
    }
    // on an item: y answers it (it joins NOT SAVED, marked ✓) and the cursor moves on to the next item
    const first = toItem(src, 0, initialScreen());
    const yes = press(src, first, "y").state;
    expect(yes.yes).toEqual(["noseat"]);
    expect(homeTargets(src, yes)[yes.sel]).toBe("item:judge");
    const shown = text(src, yes, 120, 80).join("\n");
    expect(shown).toMatch(/✓1 /);
    expect(shown).toContain("NOT SAVED  1 change");
    // n answers the item under the cursor: not now, remembered by the caller
    const no = press(src, toItem(src, 1), "n");
    expect(no.action).toEqual({ kind: "dismiss", id: "judge" });
    // an item that is yours to do has no yes
    expect(press(src, toItem(src, 3), "y").state).toMatchObject({ yes: [], msg: "This one is yours to do; then press r." });
    // the opened item answers too, and comes back home on the item
    const opened = press(src, first, "enter").state;
    expect(press(src, opened, "y").state).toMatchObject({ view: "home", yes: ["noseat"] });
    expect(press(src, opened, "n").action).toEqual({ kind: "dismiss", id: "noseat" });
  });

  test("s opens the save's view; u undoes the last change; r probes and keeps what is pending; q reports what is not saved", () => {
    const src = world();
    // s with nothing pending says so; with a yes it opens the save's view (the 2.26.1 review until a later task replaces it)
    expect(press(src, initialScreen(), "s").state).toMatchObject({ view: "home", msg: "Nothing to save." });
    const yes = press(src, toItem(src, 0), "y").state;
    expect(press(src, yes, "s").state.view).toBe("save");
    // a line changed by hand is a change too
    const judge = open(src, "judge");
    // Enter on its row picks the model in the models view (row 499), Esc keeps it as a pending change
    const picked = press(src, keysFrom(src, press(src, judge, "enter").state, "down", "enter"), "esc").state;
    expect(picked.hand[0].chosen).not.toEqual(judge.line!.chosen);
    const changed = picked;
    expect(changed).toMatchObject({ view: "home", hand: [{ line: "judge" }] });
    expect(changed.msg).toContain("s shows what changes and saves it.");
    expect(press(src, changed, "s").state.view).toBe("save");
    // u undoes the last change, newest first
    const both = press(src, toItem(src, 0, changed), "y").state;
    const once = press(src, both, "u").state;
    expect(once).toMatchObject({ yes: [], hand: [{ line: "judge" }], msg: "Last yes undone." });
    expect(press(src, once, "u").state).toMatchObject({ hand: [], msg: "Last change by hand undone." });
    // r probes and carries what is pending
    // a home-row yes carries the item it answered, so the probe keeps its very edits (row 518; D-2187 add.439)
    expect(Object.keys(both.staged ?? {})).toEqual(both.yes);
    expect(press(src, both, "r").action).toEqual({ kind: "probe", keep: { yes: both.yes, hand: both.hand, staged: both.staged } });
    // q reports what is not saved
    expect(press(src, both, "q").action).toEqual({ kind: "quit", unsaved: 2 });
    expect(press(src, initialScreen(), "q").action).toEqual({ kind: "quit", unsaved: 0 });
    // ? shows every key, and Esc comes back
    const help = press(src, initialScreen(), "?").state;
    expect(text(src, help, 100, 30).join("\n")).toMatch(/Enter[\s\S]*y n[\s\S]*s[\s\S]*u[\s\S]*r[\s\S]*q[\s\S]*complexity = the 1-10 number/);
    expect(press(src, help, "esc").state.view).toBe("home");
    // until the save's own key (Enter in the save's view) nothing is written: no key of the one screen, an opened line, an item or the help asks for a save
    const review = press(src, yes, "s").state;
    expect(press(src, review, "y")).toEqual({ state: review });
    expect(press(src, review, "enter").action).toMatchObject({ kind: "save", touched: ["repo"] });
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let st = toItem(src, 0);
    const actions: ScreenAction[] = [];
    for (let i = 0; i < 400; i++) {
      const was = st.view, key = KEYS[Math.floor(rnd() * KEYS.length)], out = press(src, st, key, BIG);
      if (out.action) actions.push(out.action);
      if (out.action?.kind === "save") expect([was, key]).toEqual(["save", "enter"]);
      st = out.state;
    }
    expect(actions.some((a) => a.kind === "probe")).toBe(true);
    // a window below 80 by 20 asks for a larger one, and no key but q does anything
    for (const key of ["down", "enter", "y", "s", "u", "r", "?"]) expect(press(src, yes, key, { cols: 79, rows: 30 })).toEqual({ state: yes });
    expect(press(src, yes, "q", { cols: 30, rows: 8 }).action).toEqual({ kind: "quit", unsaved: 1 });
    expect(strip(text(src, yes, 79, 30).join(" ")).replace(/\s+/g, " ").trim()).toBe("tickmarkr fleet needs a window of at least 80 columns by 20 rows; this one is 79 by 30. q quit");
    expect(moveTo(src, (t) => t === "kept+").sel).toBe(8);
  });

  // The repair of D-2187 add.363's review (row 499): the findings, each through press() and frame().
  test("Enter opens what the drawn cursor is on, whatever message is drawn above the keys", () => {
    // a KEPT OUT comment of 600 characters makes the screen taller than the window, so it scrolls in places
    const long = source({ repoText: `routing:\n  deny:\n    # ${"a long reason ".repeat(43)}\n    adapters: [agy]\n    models: [codex:gpt-6-luna]\n`, health: health(["claude-code:fable"]) });
    const msgs = ["", "Nothing to save.", "Not saved: .tickmarkr/config.yaml changed while this screen was open. This is the new file: answer again, then press s.",
      `Not saved: ${"the file could not be written because ".repeat(16)}it moved.`];
    const selected = (src: ScreenSource, st: ScreenState, size: { cols: number; rows: number }) =>
      frame(src, st, size.cols, size.rows).filter((l) => l.some((x) => x.selected)).map((l) => l.map((x) => x.text).join(""));
    let checked = 0;
    for (const src of [world(), long]) for (const size of [{ cols: 80, rows: 20 }, { cols: 80, rows: 24 }, { cols: 100, rows: 30 }]) {
      const places = homeTargets(src, initialScreen(), size);
      for (const msg of msgs) for (let sel = 0; sel < places.length; sel++) {
        const st = { ...initialScreen(), sel, msg }, quiet = { ...st, msg: "" }, where = `${size.cols}x${size.rows} ${msg.length} ${sel}`;
        // a message never moves the cursor's places: what is drawn under ▸ is what is drawn without it
        expect(homeTargets(src, st, size), where).toEqual(places);
        expect(selected(src, st, size), where).toEqual(selected(src, quiet, size));
        // and Enter opens that, the same with the message or without it
        const opened = press(src, st, "enter", size).state, on = places[sel];
        expect(opened, where).toEqual(press(src, quiet, "enter", size).state);
        if (on.startsWith("item:")) expect(opened, where).toMatchObject({ view: "item", item: on.slice(5) });
        else if (on.startsWith("kept:")) expect(opened.rule?.list, where).toBe(on.slice(5).split("#")[0]);
        else if (on === "kept+") expect(opened.models?.keep, where).toBe(true);
        else if (on.startsWith("shapes:")) expect(on.slice(7).split(","), where).toContain(opened.line?.shape ?? opened.choose?.ids[0]);
        else if (!on) expect(opened, where).toEqual(quiet);
        else expect(opened.line?.shape, where).toBe(on);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("below 80 by 20 every view is the one sentence, no key but q does anything, and nothing pending is lost", () => {
    const src = world();
    const yes = press(src, toItem(src, 0), "y").state;
    const views: Array<[string, ScreenSource, ScreenState]> = [["home", src, yes], ["help", src, press(src, yes, "?").state], ["judge", src, open(src, "judge", yes)],
      ["item", src, press(src, toItem(src, 1, yes), "enter").state], ["save", src, press(src, yes, "s").state], ["choose", src, press(src, { ...yes, sel: 1 }, "enter", BIG).state],
      ["error", source({ repoText: "routing:\n  mode: partner-lead\n" }), initialScreen()]];
    for (const [name, s, st] of views) {
      expect(frame(s, st, 100, 30).map((l) => l.map((x) => x.text).join("")).join(" "), name).not.toContain("needs a window");
      for (const [cols, rows] of [[30, 8], [79, 30], [80, 19], [40, 12]] as const) {
        const where = `${name} ${cols}x${rows}`, shown = frame(s, st, cols, rows).map((l) => l.map((x) => x.text).join(""));
        expect(shown, where).toHaveLength(rows);
        expect(strip(shown.join(" ")).replace(/\s+/g, " ").trim(), where).toBe(`${tooSmall(cols, rows)} q quit`);
        for (const key of KEYS) expect(press(s, st, key, { cols, rows }), `${where} ${key}`).toEqual({ state: st });
        expect(press(s, st, "q", { cols, rows }).action, where).toEqual({ kind: "quit", unsaved: s === src ? 1 : 0 });
      }
    }
  });

  test("? shows every key's sentence whole at 80 columns", () => {
    const src = world();
    const sentences = ["move the cursor over the mode, the lines, KEPT OUT and the items", "opens what the cursor is on: a line, or an item",
      "answer the item under the cursor: a yes joins NOT SAVED, a no is not asked again", "opens the save; with nothing pending, Nothing to save.",
      "undoes the last answer or change", "checks every model again, keeping what is not saved", "this help", "quits, saying what is not saved",
      "complexity = the 1-10 number a task gets when its spec is compiled"];
    const help = press(src, initialScreen(), "?").state;
    for (const rows of [20, 21, 24]) {
      const shown = text(src, help, 80, rows).map((l) => l.trim().replace(/^(↑↓ k j|Enter|y n|s|u|r|\?|q) {2,}/, "")).join(" ").replace(/\s+/g, " ");
      for (const t of sentences) expect(shown, `80x${rows}: ${t}`).toContain(t);
      expect(shown).not.toContain("…");
    }
  });

  test("the cursor (▸) is drawn on the mode in the header, through the real mount too", async () => {
    const src = world();
    expect(text(src, initialScreen(), 100, 30)[0]).toMatch(/^▸ tickmarkr fleet /);
    expect(text(src, { ...initialScreen(), sel: 1 }, 100, 30)[0]).toMatch(/^ {2}tickmarkr fleet /);
    const { run } = setup();
    const t = terminal();
    Object.assign(t.output, { columns: 80, rows: 20 });
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("tickmarkr fleet");
    expect(t.text()).toMatch(/▸ tickmarkr fleet /);
    t.input.write("q");
    expect(await done).toBe("fleet: nothing changed");
  });
  test("a place whose frame shows no ▸ is on nothing: Enter, y and n act only on what the drawn cursor is on", () => {
    // the review's reproducers (D-2187 add.363): a KEPT OUT reason taller than the window, and NOT SAVED longer than it
    const long = source({ repoText: `routing:\n  deny:\n    # ${"a long reason ".repeat(150)}\n    adapters: [agy]\n    models: [codex:gpt-6-luna]\n`, health: health(["claude-code:fable"]) });
    const plain = source();
    let pending = initialScreen();
    for (const id of ["plan", "spec", "implement", "tests", "docs", "migration", "ui", "refactor", "chore"]) pending = keysFrom(plain, open(plain, id, pending), "f", "esc");
    expect(pending.hand).toHaveLength(9);
    let blind = 0, shown = 0;
    for (const [src, base] of [[world(), initialScreen()], [long, initialScreen()], [plain, pending]] as Array<[ScreenSource, ScreenState]>) {
      for (const size of [{ cols: 80, rows: 20 }, { cols: 80, rows: 24 }, { cols: 100, rows: 30 }, { cols: 120, rows: 40 }]) {
        const ts = homeTargets(src, base, size);
        let st = { ...base, sel: 0 };
        for (let sel = 0; sel < ts.length; sel++, st = press(src, st, "down", size).state) {
          const where = `${size.cols}x${size.rows} ${sel} ${ts[sel]}`;
          expect(st.sel, where).toBe(sel);
          const drawn = frame(src, st, size.cols, size.rows).map((l) => l.map((x) => x.text).join("")).filter((l) => l.includes("▸"));
          const quiet = { ...st, msg: "" };
          if (!drawn.length) {
            blind++;
            expect(ts[sel], where).toBe("");
            expect(press(src, st, "enter", size).state, where).toEqual(quiet);
            for (const key of ["y", "n"]) {
              const out = press(src, st, key, size);
              expect(out.action, where).toBeUndefined();
              expect([out.state.yes, out.state.view], where).toEqual([st.yes, "home"]);
            }
          } else {
            shown++;
            expect(drawn, where).toHaveLength(1);
            expect(ts[sel], where).not.toBe("");
            const item = derive(src, st).items.find((i) => `item:${i.id}` === ts[sel]);
            if (item) expect(drawn[0], where).toContain(item.title.slice(0, 15));
          }
        }
      }
    }
    expect(blind).toBeGreaterThan(5);
    expect(shown).toBeGreaterThan(50);
  });
});
