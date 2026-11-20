// A shape's line opened from the one screen, and its keys (queue rows 499, 501, 502; D-2187 add.363;
// contract 5.3 and the shape rows of 5.4): the choices, a model removed, c and f, Esc as one pending change.
import { describe, expect, test } from "vitest";
import type { ModelFacts } from "../../src/adapters/types.js";
import { lineOf } from "../../src/fleet/lines.js";
import { lineParts } from "../../src/fleet/line-view.js";
import { derive, frame, lineHomeTargets, press, type ScreenSource, type ScreenState } from "../../src/fleet/screen.js";
import { health, source } from "./world.js";
import { keysFrom, open } from "./drive.js";

const F = "claude-code:claude-fable-5-2", O = "claude-code:claude-opus-5-5", A = "codex:gpt-6-astra", S = "codex:gpt-6.1-sol";
const EXTRA = { "claude-code": ["claude-fable-5-2", "claude-opus-5-5"], codex: ["gpt-6.1-sol"] };
const TIERS = "tiers:\n  claude-code:\n    models:\n      claude-fable-5-2: frontier\n      claude-opus-5-5: frontier\n  codex:\n    models:\n      gpt-6.1-sol: frontier\n";
const FACTS: Record<string, Partial<ModelFacts>> = { [F]: { score: 64.6, priceIn: 8, priceOut: 40 }, [O]: { score: 59.1, priceIn: 4, priceOut: 20 }, [A]: { score: 56.9, priceIn: 10, priceOut: 50 }, [S]: { score: 54.6, priceIn: 2, priceOut: 10 } };

function world(mode: string, channels: readonly string[], more = "", extra: Record<string, string[]> = EXTRA): ScreenSource {
  const h = health([], extra);
  for (const [key, f] of Object.entries(FACTS)) {
    const a = key.slice(0, key.indexOf(":")), m = key.slice(key.indexOf(":") + 1);
    h[a] = { ...h[a], modelFacts: { ...h[a].modelFacts, [m]: { as: m, ...f } } };
  }
  const repoText = `${TIERS}routing:\n  mode: partner-led\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ${mode}\n        channels: [${channels.join(", ")}]\n${more}consult:\n  prefer: [codex:gpt-6-astra]\n`;
  return source({ repoText, health: h });
}
const text = (src: ScreenSource, st: ScreenState, cols = 100, rows = 40) => frame(src, st, cols, rows).map((l) => l.map((s) => s.text).join("")).join("\n");
const targets = (src: ScreenSource, st: ScreenState) => lineHomeTargets(src, st);
/** The cursor moved with up and down to `id`. */
function to(src: ScreenSource, st: ScreenState, id: string): ScreenState {
  const ts = targets(src, st), i = ts.indexOf(id);
  if (i < 0) throw new Error(`no ${id}: ${ts.join(" | ")}`);
  return keysFrom(src, { ...st, line: { ...st.line!, at: 0 } }, ...Array<string>(i).fill("down"));
}

describe("a shape's line opened, and its keys", () => {
  test("Enter on a shape opens its line; a choice and a removed model are one pending change; a line left as it was is none", () => {
    const src = world("complexity", [F, O, A, S]);
    const before = { ...src.inputs };
    let st = open(src, "implement");
    expect(st).toMatchObject({ view: "line", line: { shape: "implement", chosen: [F, O, A, S], mode: "complexity" } });
    const shown = text(src, st);
    expect(shown).toContain("How are the tasks given out?");
    expect(shown).toContain("very complex 8-10");
    // left as it was: Esc is no change
    expect(press(src, st, "esc").state).toMatchObject({ view: "home", line: null, hand: [], log: [] });
    // a choice there and back is no change either
    const there = press(src, to(src, st, "choice:order"), "enter").state;
    expect(there.line!.mode).toBe("ordered");
    const back = press(src, to(src, there, "choice:complexity"), "enter").state;
    expect(press(src, back, "esc").state).toMatchObject({ view: "home", hand: [] });
    // a model removed (Enter on its row by complexity) and then My order: ONE pending change of the line
    st = press(src, to(src, st, `model:${O}`), "enter").state;
    expect(st.line!.chosen).toEqual([F, A, S]);
    expect(text(src, st)).not.toContain("claude-opus-5-5");
    st = press(src, to(src, st, "choice:order"), "enter").state;
    const home = press(src, st, "esc");
    expect(home.action).toBeUndefined();
    expect(home.state).toMatchObject({ view: "home", line: null, hand: [{ line: "implement", chosen: [F, A, S], mode: "ordered" }], log: ["h:implement"],
      msg: "implement changed. s shows what changes and saves it." });
    expect(derive(src, home.state).hand.map((e) => [e.path.join("."), e.value])).toEqual([["routing.map.implement", { pool: { mode: "ordered", channels: [F, A, S] } }]]);
    expect(text(src, home.state)).toContain("NOT SAVED  1 change");
    // reopened and left again: still one change, in its place
    const again = press(src, open(src, "implement", home.state), "esc").state;
    expect(again.hand).toEqual(home.state.hand);
    expect(again.log).toEqual(["h:implement"]);
    // nothing is written before the save's Enter
    expect(src.inputs).toEqual(before);
  });

  test("a line saved as any that is given a choice is a pending change; the screen cannot turn it back into any", () => {
    const src = world("any", [F, O, A, S]);
    let st = open(src, "implement");
    expect(st.line!.mode).toBe("any");
    expect(targets(src, st).slice(0, 3)).toEqual(["choice:complexity", "choice:order", "choice:any"]);
    expect(text(src, st)).toContain("As saved before 2.27");
    // a model of a line saved as any is not removed until a choice is made
    const kept = press(src, to(src, st, `model:${O}`), "enter").state;
    expect(kept.line!.chosen).toEqual([F, O, A, S]);
    expect(kept.msg).toMatch(/^Choose By complexity or My order first/);
    // Enter on By complexity: the third choice is gone at once, so nothing on the screen can choose any again
    st = press(src, to(src, st, "choice:complexity"), "enter").state;
    expect(st.line!.mode).toBe("complexity");
    expect(targets(src, st)).not.toContain("choice:any");
    expect(text(src, st)).not.toContain("As saved before 2.27");
    const home = press(src, st, "esc").state;
    expect(home.hand).toEqual([{ line: "implement", chosen: [F, O, A, S], mode: "complexity" }]);
    expect(derive(src, home).hand[0].value).toEqual({ pool: { mode: "complexity", channels: [F, O, A, S] } });
    // reopened, it offers by complexity and my order only; every key there leaves mode any unwritten
    const re = open(src, "implement", home);
    expect(targets(src, re)).not.toContain("choice:any");
    let walk = re;
    for (const k of ["down", "enter", "up", "enter", "down", "down", "enter", "x", "[", "]", "c", "f"]) walk = press(src, walk, k).state;
    const after = press(src, walk, "esc").state;
    for (const e of derive(src, after).edits) expect(JSON.stringify(e.value)).not.toContain('"mode":"any"');
  });

  test("c raises what counts as very complex for every line; the table shows the new ranges; f moves the shape's bar", () => {
    const plan = "    plan:\n      prefer: null\n      pin: null\n      pool:\n        mode: complexity\n        channels: [" + [F, O, A, S].join(", ") + "]\n";
    const src = world("complexity", [F, O, A, S], plan);
    let st = open(src, "implement");
    expect(text(src, st)).toMatch(/very complex 8-10[\s\S]*the rest 1-7/);
    st = press(src, st, "c").state;
    expect(st.msg).toBe("very complex starts at 9, for every line given out by complexity.");
    expect(text(src, st)).toMatch(/very complex 9-10[\s\S]*the rest 1-8/);
    expect(st.hand).toEqual([{ line: "hardFrom", chosen: ["9"] }]);
    // one setting, for every line by complexity: plan's ranges move too, and the edit is routing.hardFrom alone
    const d = derive(src, st);
    expect(d.hand.map((e) => [e.path.join("."), e.value])).toEqual([["routing.hardFrom", 9]]);
    expect(lineOf(d.full!, "plan").groups![0].range).toEqual([9, 10]);
    expect(lineOf(d.full!, "implement").groups![0].range).toEqual([9, 10]);
    // from 10 back to 2, and back at the saved 8 it is no change
    st = keysFrom(src, st, "c");
    expect(text(src, st)).toContain("very complex 10-10");
    st = keysFrom(src, st, "c");
    expect(st.hand).toEqual([{ line: "hardFrom", chosen: ["2"] }]);
    expect(text(src, st)).toMatch(/very complex 2-10[\s\S]*the rest 1-1/);
    st = keysFrom(src, st, "c", "c", "c", "c", "c");
    expect(st.hand).toEqual([{ line: "hardFrom", chosen: ["7"] }]);
    const eight = press(src, st, "c").state;
    expect(eight).toMatchObject({ hand: [], msg: "very complex starts at 8 again, as saved." });
    // the pending change of its own, named on the one screen
    st = press(src, press(src, st, "c").state, "c").state;
    const home = press(src, st, "esc").state;
    expect(home.hand).toEqual([{ line: "hardFrom", chosen: ["9"] }]);
    const one = text(src, home, 100, 60);
    expect(one).toContain("NOT SAVED  1 change");
    expect(one).toMatch(/very complex +starts at 9, for every line given out by complexity/);
    // f moves the shape's bar: what the mode says, then cheap, mid, frontier
    let f = open(src, "implement");
    expect(text(src, f)).toContain("bar for implement: frontier (mode partner-led)");
    f = press(src, f, "f").state;
    expect(f.line!.floor).toBe("cheap");
    expect(text(src, f)).toContain("bar for implement: cheap (set for this shape)");
    const barred = press(src, f, "esc").state;
    expect(barred.hand).toEqual([{ line: "implement", chosen: [], floor: "cheap" }]);
    expect(derive(src, barred).hand.map((e) => [e.path.join("."), e.value])).toEqual([["routing.floors.implement", "cheap"]]);
  });

  test("Enter removes a model from the line; the last model stays and one row says why", () => {
    const src = world("complexity", [F, O]);
    let st = open(src, "implement");
    st = press(src, to(src, st, `model:${O}`), "enter").state;
    expect(st.line!.chosen).toEqual([F]);
    st = press(src, to(src, st, `model:${F}`), "enter").state;
    expect(st.line!.chosen).toEqual([F]);
    expect(st.msg).toBe("A line never loses its last model: claude-fable-5-2 stays.");
    const rows = frame(src, st, 100, 40).map((l) => l.map((s) => s.text).join(""));
    expect(rows.filter((r) => r.includes("A line never loses its last model")).length).toBe(1);
    expect(rows.some((r) => r.includes("claude-fable-5-2") && r.includes("all of them"))).toBe(true);
    expect(press(src, st, "esc").state.hand).toEqual([{ line: "implement", chosen: [F], mode: "complexity" }]);
  });

  test("+ allow a model and a row's Enter in my order open the models view; o is gone", () => {
    const src = world("ordered", [F, O]);
    const st = open(src, "implement");
    expect(press(src, st, "o").state.line).toEqual(st.line);
    // row 498 (D-2187 add.363): the models view, its search empty; a row's Enter puts the pick in that row
    const add = press(src, to(src, st, "add"), "enter").state;
    expect(add).toMatchObject({ view: "models", models: { cli: 0, at: 0, query: "" } });
    expect(add.models!.row).toBeUndefined();
    expect(add.line!.chosen).toEqual([F, O]);
    const row = press(src, to(src, st, `model:${O}`), "enter").state;
    expect(row).toMatchObject({ view: "models", models: { row: 1 } });
    // x removes a row, [ moves it, in my order
    const x = press(src, to(src, st, `model:${O}`), "x").state;
    expect(x.line!.chosen).toEqual([F]);
    const moved = press(src, to(src, st, `model:${O}`), "[").state;
    expect(moved.line!.chosen).toEqual([O, F]);
  });

  test("a pending bar choice reopened and left with Esc stays the same pending change, whatever bar shows through below it", () => {
    const h = health([], EXTRA);
    const layered = (user: string, repo: string) => source({ health: h, userText: `routing:\n  floors:\n    implement: ${user}\n`,
      repoText: `routing:\n  mode: partner-led\n  floors:\n    implement: ${repo}\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: complexity\n        channels: [${A}, ${S}]\nconsult:\n  prefer: [codex:gpt-6-astra]\n` });
    let checked = 0;
    for (const [user, repo] of [["cheap", "frontier"], ["cheap", "cheap"], ["frontier", "cheap"]]) {
      const src = layered(user, repo);
      for (const floor of ["mode", "cheap", "mid", "frontier"] as const) {
        const pending: ScreenState = { ...press(src, open(src, "implement"), "esc").state, hand: [{ line: "implement", chosen: [], floor }], log: ["h:implement"] };
        const edits = derive(src, pending).edits;
        // a bar it already has is no pending change at all
        if (!derive(src, pending).hand.length) continue;
        checked++;
        const again = press(src, open(src, "implement", pending), "esc").state;
        expect(again.hand, `${user}/${repo}/${floor}`).toEqual(pending.hand);
        expect(derive(src, again).edits, `${user}/${repo}/${floor}`).toEqual(edits);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  test("a model whose id ends in :row:2 is the row the cursor is on: Enter, x and [ act on it, not on the model it looks like", () => {
    const R = `${A}:row:2`, extra = { ...EXTRA, codex: [...EXTRA.codex, "gpt-6-astra:row:2"] };
    const at = (mode: string) => {
      const w = world(mode, [A, R], "", extra);
      // a tier for it, so by complexity it is a row of its own
      return { src: { ...w, inputs: { ...w.inputs, repoText: w.inputs.repoText.replace("      gpt-6.1-sol: frontier\n", "      gpt-6.1-sol: frontier\n      \"gpt-6-astra:row:2\": frontier\n") } } };
    };
    const c = at("complexity").src;
    const cx = open(c, "implement");
    expect(targets(c, cx), targets(c, cx).join(" | ")).toContain(`model:${R}`);
    expect(press(c, to(c, cx, `model:${R}`), "enter").state.line!.chosen).toEqual([A]);
    expect(press(c, to(c, cx, `model:${A}`), "enter").state.line!.chosen).toEqual([R]);
    const o = at("ordered").src;
    const ox = open(o, "implement");
    expect(press(o, to(o, ox, `model:${R}`), "x").state.line!.chosen).toEqual([A]);
    expect(press(o, to(o, ox, `model:${R}`), "[").state.line!.chosen).toEqual([R, A]);
    expect(press(o, to(o, ox, `model:${A}`), "]").state.line!.chosen).toEqual([R, A]);
  });

  test("at 80 by 20 every row of the opened line is reached with the arrows, the keys stay at the foot, and Enter does nothing on a row scrolled past", () => {
    const SMALL = { cols: 80, rows: 20 };
    const seven = ["claude-code:fable", "claude-code:opus", "claude-code:sonnet", "codex:gpt-6-astra", "codex:gpt-6-sol", "codex:gpt-5.6-terra", "codex:gpt-6-luna"];
    const fixtures: Array<[string, ScreenSource]> = [
      ["two by complexity", world("complexity", [F, O])], ["four by complexity", world("complexity", [F, O, A, S])], ["four in my order", world("ordered", [F, O, A, S])],
      ["saved as any", source({ repoText: `routing:\n  map:\n    implement:\n      prefer: null\n      pool: {mode: any, channels: [${seven.join(", ")}]}\n` })],
    ];
    const rowsOf = (src: ScreenSource, st: ScreenState) => frame(src, st, 80, 20).map((r) => r.map((x) => x.text).join("").trimEnd());
    // a row is reached whether or not the cursor is on it
    const bare = (r: string) => r.replace(/^▸/, " ");
    for (const [name, src] of fixtures) {
      let st = open(src, "implement");
      const M = derive(src, st).full!, { body, footer } = lineParts({ M, line: lineOf(M, "implement"), project: "r", cursor: 0 }, 80);
      const keys = footer.at(-1)!.map((x) => x.text).join("").trimEnd(), seen = new Set<string>();
      let last = "";
      for (let i = 0; i < 60; i++) {
        const shown = rowsOf(src, st);
        expect(shown, name).toHaveLength(20);
        expect(shown.at(-1), name).toBe(keys);
        shown.forEach((r) => seen.add(bare(r)));
        const now = JSON.stringify(st.line);
        if (now === last) break;
        last = now;
        st = press(src, st, "down", SMALL).state;
      }
      const missing = body.map((r) => r.map((x) => x.text).join("").trimEnd()).filter((r) => r.trim() && !seen.has(bare(r)));
      expect(missing, name).toEqual([]);
      // scrolled past every place: Enter, x, [ and ] change nothing
      if (!rowsOf(src, st).some((r) => r.startsWith("▸"))) for (const k of ["enter", "x", "[", "]"]) expect(press(src, st, k, SMALL).state.line, `${name} ${k}`).toEqual(st.line);
      // and up comes back to the first choice
      for (let i = 0; i < 60; i++) st = press(src, st, "up", SMALL).state;
      expect(st.line, name).toMatchObject({ at: 0, top: 0 });
    }
  });
  test("at 80 by 20 a note too long for the foot starts in view and the arrows scroll through it to its end", () => {
    for (const n of [1400, 1800]) {
      const id = "x".repeat(n), key = `codex:${id}`;
      const src = source({ health: health([], { codex: [id] }), repoText: `tiers:\n  codex:\n    models:\n      ? ${id}\n      : frontier\nrouting:\n  map:\n    implement:\n      prefer: null\n      pool: {mode: ordered, channels: [${key}]}\n` });
      let st = open(src, "implement");
      for (const k of ["down", "down", "x"]) st = press(src, st, k, { cols: 80, rows: 20 }).state;
      expect(st.msg.startsWith("A line never loses its last model:")).toBe(true);
      const rows = () => frame(src, st, 80, 20).map((r) => r.map((x) => x.text).join(""));
      expect(rows().join(""), String(n)).toContain("A line never loses its last model:");
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) { rows().forEach((r) => seen.add(r)); st = press(src, st, "down", { cols: 80, rows: 20 }).state; }
      expect([...seen].some((r) => r.includes("stays.")), String(n)).toBe(true);
      expect(rows().at(-1)!.trim()).toMatch(/back$/);
    }
  });

  test("at 80 by 20 after any key, Enter, x, [ and ] change a line only through the row the cursor is drawn on", () => {
    const SMALL = { cols: 80, rows: 20 };
    const seven = ["claude-code:fable", "claude-code:opus", "claude-code:sonnet", "codex:gpt-6-astra", "codex:gpt-6-sol", "codex:gpt-5.6-terra", "codex:gpt-6-luna"];
    let checked = 0;
    for (const mode of ["complexity", "ordered", "any"]) {
      const src = source({ repoText: `routing:\n  map:\n    implement:\n      prefer: null\n      pool: {mode: ${mode}, channels: [${seven.join(", ")}]}\n` });
      let st = open(src, "implement");
      for (let d = 0; d < 25; d++) {
        for (const msgKey of ["c", "enter", "f"]) {
          const s0 = press(src, st, msgKey, SMALL).state;
          if (s0.view !== "line") continue;
          const cur = frame(src, s0, 80, 20).map((r) => r.map((x) => x.text).join("")).filter((r) => r.startsWith("▸"));
          for (const k of ["enter", "x", "[", "]"]) {
            const after = press(src, s0, k, SMALL).state.line!;
            if (JSON.stringify(after.chosen) === JSON.stringify(s0.line!.chosen)) continue;
            checked++;
            expect(cur.length, `${mode} ${d} ${msgKey} ${k}`).toBeGreaterThan(0);
            const gone = s0.line!.chosen.filter((m) => !after.chosen.includes(m));
            const moved = gone.length ? gone : s0.line!.chosen.filter((m, i) => after.chosen[i] !== m);
            expect(moved.some((m) => cur.join(" ").includes(m.slice(m.indexOf(":") + 1))), `${mode} ${d} ${msgKey} ${k}: ${moved}`).toBe(true);
          }
        }
        st = press(src, st, "down", SMALL).state;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
