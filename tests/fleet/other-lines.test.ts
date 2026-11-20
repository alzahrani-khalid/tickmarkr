// The other lines of the one screen opened (queue rows 499, 500; D-2187 add.363; contract 5.4 and the keep-out
// form of 5.5): the judge, the review and the consult as an order, the mode as its three values, a KEPT OUT rule
// with x to remove it alone, and the + of KEPT OUT opening the models view in its keep-out form. Zero tokens.
import { describe, expect, test } from "vitest";
import { derive, frame, lineHomeTargets, press, type ScreenState } from "../../src/fleet/screen.js";
import { MODE_SAYS } from "../../src/fleet/hand.js";
import { ROUTING_MODES } from "../../src/config/config.js";
import { SHAPES } from "../../src/graph/schema.js";
import { health, POOL, source } from "./world.js";
import { keysFrom, moveTo, open, text } from "./drive.js";

const BANNED = /\b(pool|tier|floor|seat|channel|allowlist)\b/i;
/** The words the product writes on a frame: every segment it does not quote. */
const written = (src: ReturnType<typeof source>, st: ScreenState, cols = 100, rows = 40) =>
  frame(src, st, cols, rows).flatMap((l) => l.filter((s) => !(s as { verbatim?: true }).verbatim).map((s) => s.text)).join("\n");

const RULES = `routing:
  deny:
    # keep this seat out
    models: [codex:gpt-6-luna, claude-code:haiku]
    workers:
      adapters: [agy]
`;
const openRule = (src: ReturnType<typeof source>, n: number): ScreenState => {
  const st = moveTo(src, (t) => t.startsWith("kept:"));
  return press(src, keysFrom(src, st, ...Array<string>(n).fill("down")), "enter").state;
};

describe("the other lines opened (rows 499, 500)", () => {
  test("the judge; the review; the consult: each opens to the order view only", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra, claude-code:opus]\nreview:\n  prefer: [codex:gpt-6-astra]\n` });
    for (const id of ["judge", "review", "consult"]) {
      const st = open(src, id), shown = text(src, st, 100, 40).join("\n");
      expect(st, id).toMatchObject({ view: "line", line: { shape: id } });
      // no choice rows: by complexity is for a shape's line only
      expect(shown, id).not.toContain("How are the tasks given out?");
      expect(shown, id).not.toMatch(/By complexity|My order/);
      expect(shown, id).toMatch(/JOB +MODEL +CLI +SCORE +PRICE IN \/ OUT/);
      expect(shown, id).toContain("RESULT");
      expect(written(src, st), id).not.toMatch(BANNED);
    }
    // the judge is one row, with no + row; its RESULT names who judges as the one screen does
    const judge = open(src, "judge"), shown = text(src, judge, 100, 40).join("\n");
    expect(shown).toMatch(/1 +judges +fable/);
    expect(shown).not.toContain("+ add a model");
    expect(shown).toMatch(/RESULT +fable judges/);
    expect(shown.split("\n").at(-1)!.trim()).toBe("↑↓ move · Enter pick the model · Esc back");
    // the consult in order: the first is asked first, the second is its backup; [ moves a row, Esc keeps it as a pending change
    let c = open(src, "consult");
    expect(text(src, c, 100, 40).join("\n")).toMatch(/1 +asked first +gpt-6-astra[\s\S]*2 +backup +opus[\s\S]*3 +backup +\+ add a model/);
    expect(text(src, c, 100, 40).at(-1)!.trim()).toBe("↑↓ move · Enter pick the model for a row · [ ] move the row · x remove · Esc back");
    c = keysFrom(src, c, "down", "[");
    expect(c.line!.chosen).toEqual(["claude-code:opus", "codex:gpt-6-astra"]);
    c = press(src, c, "esc").state;
    expect(c.hand).toEqual([{ line: "consult", chosen: ["claude-code:opus", "codex:gpt-6-astra"] }]);
    expect(derive(src, c).full!.cfg.consult.prefer).toEqual(["claude-code:opus", "codex:gpt-6-astra"]);
    // x removes a row, never the last; Enter on a row opens the models view for it
    const one = keysFrom(src, open(src, "review"), "x");
    expect(one.line!.chosen).toEqual(["codex:gpt-6-astra"]);
    expect(one.msg).toMatch(/never loses its last model/);
    expect(press(src, open(src, "judge"), "enter").state).toMatchObject({ view: "models", models: { row: 0 } });
    // no tick list remains: the 2.26.1 pick view is gone
    expect(open(src, "judge").view).not.toBe("pick");
  });

  test("the mode opens to its three values; each says what it does in the screen's words", () => {
    const src = source({ repoText: POOL });
    let st = open(src, "mode");
    expect(st).toMatchObject({ view: "line", line: { shape: "mode", chosen: ["partner-led"] } });
    const shown = text(src, st, 100, 30).join("\n");
    for (const m of ROUTING_MODES) expect(shown).toContain(`${m}`);
    expect(shown).toMatch(/\(•\) partner-led +every shape needs a frontier model/);
    expect(shown).toMatch(/\( \) risk-based +each shape keeps its own bar \(the default\)/);
    expect(shown).toMatch(/\( \) staff-led +one level lower; plan, spec, migration, ui stay frontier/);
    expect(Object.values(MODE_SAYS).join(" ")).not.toMatch(BANNED);
    expect(written(src, st)).not.toMatch(BANNED);
    // Enter chooses a value; Esc keeps it as one pending change of the mode
    st = keysFrom(src, st, "down", "down", "enter");
    expect(st.line!.chosen).toEqual(["staff-led"]);
    expect(text(src, st, 100, 30).join("\n")).toMatch(/\(•\) staff-led/);
    st = press(src, st, "esc").state;
    expect(st.hand).toEqual([{ line: "mode", chosen: ["staff-led"] }]);
    expect(derive(src, st).full!.mode.mode).toBe("staff-led");
    // choosing the saved value again is no change
    expect(press(src, keysFrom(src, open(src, "mode"), "enter"), "esc").state.hand).toEqual([]);
  });

  test("a kept out rule opens to its reason and the models it keeps out; x removes that rule alone as a pending change", () => {
    const src = source({ repoText: RULES });
    const st = openRule(src, 0);
    expect(st).toMatchObject({ view: "rule", rule: { list: "routing.deny.models", rule: "codex:gpt-6-luna" } });
    const shown = text(src, st, 100, 30).join("\n");
    expect(shown).toContain("KEPT OUT  codex:gpt-6-luna");
    expect(shown).toMatch(/REASON +# keep this seat out/);
    expect(shown).toMatch(/KEEPS OUT +gpt-6-luna/);
    expect(text(src, st, 100, 30).at(-1)!.trim()).toBe("x remove this rule · Esc back");
    // the second rule of the same list opens to itself, not the first
    expect(openRule(src, 1).rule).toMatchObject({ list: "routing.deny.models", rule: "claude-code:haiku" });
    // Enter, y and n do nothing here; Esc goes back with nothing pending
    for (const k of ["enter", "y", "n", " "]) expect(press(src, st, k).state.hand, k).toEqual([]);
    expect(press(src, st, "esc").state).toMatchObject({ view: "home", hand: [] });
    // x removes that rule alone, as a pending change: the other rules stay, nothing is written
    const x = press(src, st, "x");
    expect(x.action).toBeUndefined();
    expect(x.state).toMatchObject({ view: "home", hand: [{ line: "deny.models", chosen: ["claude-code:haiku"] }] });
    const d = derive(src, x.state);
    expect(d.full!.cfg.routing.deny!.models).toEqual(["claude-code:haiku"]);
    expect(d.full!.cfg.routing.deny!.workers!.adapters).toEqual(["agy"]);
    const home = text(src, x.state, 100, 40).join("\n");
    expect(home).toContain("NOT SAVED  1 change");
    expect(home).toMatch(/no longer kept out +codex:gpt-6-luna/);
    // u takes it back
    expect(press(src, x.state, "u").state.hand).toEqual([]);
  });

  test("in the keep-out form Enter keeps a model or a whole CLI out as a pending change; a rule that was there is left alone", () => {
    const src = source({ repoText: RULES });
    let st = press(src, moveTo(src, (t) => t === "kept+"), "enter").state;
    expect(st).toMatchObject({ view: "models", models: { keep: true } });
    const shown = text(src, st, 100, 30).join("\n");
    expect(shown).toContain("KEPT OUT · keep a model or a CLI out");
    expect(shown).toContain("↑↓ model · ←→ CLI · Enter keep it out · Esc back");
    // letters search: k is a letter here and writes no rule
    expect(keysFrom(src, st, "k").hand).toEqual([]);
    // the model under the cursor: Enter out of all work, again out of everything, again lifts what this view added
    st = press(src, st, "enter").state;
    const k = st.hand[0]?.chosen.at(-1);
    expect(k).toMatch(/^claude-code:/);
    expect(st.hand).toEqual([{ line: "deny.workers.models", chosen: [k] }]);
    expect(st.view).toBe("models");
    st = press(src, st, "enter").state;
    expect(st.hand).toEqual([{ line: "deny.models", chosen: ["codex:gpt-6-luna", "claude-code:haiku", k] }]);
    st = press(src, st, "enter").state;
    expect(st.hand).toEqual([]);
    // on a CLI in the left column (reached with ←): the same for the whole CLI
    st = keysFrom(src, st, "left", "enter");
    const cli = st.hand[0]?.chosen.at(-1);
    expect(cli).toBe("claude-code");
    expect(st.hand).toEqual([{ line: "deny.workers.adapters", chosen: ["agy", cli] }]);
    st = press(src, st, "enter").state;
    expect(st.hand).toEqual([{ line: "deny.adapters", chosen: [cli] }]);
    // nothing is written; Esc goes home with the change pending
    const back = press(src, st, "esc");
    expect(back.action).toBeUndefined();
    expect(back.state).toMatchObject({ view: "home", hand: [{ line: "deny.adapters", chosen: [cli] }] });
    expect(text(src, back.state, 100, 40).join("\n")).toMatch(/kept out +[\w-]+\s/);
    // a rule that was there when the screen opened is left alone: Enter on it changes nothing, and says so
    let luna = press(src, moveTo(src, (t) => t === "kept+"), "enter").state;
    luna = keysFrom(src, luna, ..."gpt-6-luna".split(""));
    while (!luna.models!.key?.startsWith("codex:") && luna.models!.cli < 20) luna = press(src, luna, "right").state;
    expect(luna.models!.key).toBe("codex:gpt-6-luna");
    for (let i = 0; i < 3; i++) {
      luna = press(src, luna, "enter").state;
      expect(luna.hand).toEqual([]);
      expect(luna.msg).toMatch(/was there when the screen opened: it is left alone/);
    }
    expect(derive(src, luna).full!.cfg.routing.deny!.models).toEqual(["codex:gpt-6-luna", "claude-code:haiku"]);
  });

  // the reviewer's four findings, each as its consequence through press() and frame() (rows 499, 500)
  test("each opened line reads a model for its own role, a rule by its own list, a long reason by scrolling, and asked first as the role resolves it", () => {
    // a workers' rule does not keep a model from the judge, the review or the consult: the models view adds it there
    const src = source({ repoText: `routing:\n  deny:\n    workers:\n      models: [codex:gpt-6-astra]\nconsult:\n  prefer: [claude-code:opus]\nreview:\n  prefer: [claude-code:opus]\n` });
    for (const id of ["judge", "review", "consult"]) {
      const m = press(src, open(src, id), "enter").state;
      let at = keysFrom(src, m, ..."gpt-6-astra".split(""), "down", "up");
      for (let i = 0; i < 20 && at.models!.key !== "codex:gpt-6-astra"; i++) at = press(src, at, "right").state;
      expect(at.models!.key, id).toBe("codex:gpt-6-astra");
      const added = press(src, at, "enter").state;
      expect(added.line!.chosen, id).toContain("codex:gpt-6-astra");
      expect(added.msg, id).not.toMatch(/kept out by the rule/);
    }
    // ... and a shape's line still refuses it: the rule keeps it from all work
    const planLine = keysFrom(src, open(src, "plan"), "down", "enter");
    let plan = press(src, keysFrom(src, planLine, ...Array<string>(Math.max(0, lineHomeTargets(src, planLine).indexOf("add"))).fill("down")), "enter").state;
    expect(plan.view).toBe("models");
    plan = keysFrom(src, plan, ..."gpt-6-astra".split(""), "down", "up");
    for (let i = 0; i < 20 && plan.models!.key !== "codex:gpt-6-astra"; i++) plan = press(src, plan, "right").state;
    expect(press(src, plan, "enter").state.msg).toMatch(/kept out by the rule codex:gpt-6-astra/);

    // two rules that both keep a model out: each rule's own view names it
    const both = source({ repoText: "routing:\n  deny:\n    adapters: [claude-code]\n    models: [claude-code:fable]\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    for (const list of ["routing.deny.adapters", "routing.deny.models"]) {
      const st = press(both, moveTo(both, (t) => t === `kept:${list}`), "enter").state;
      expect(st.rule!.list).toBe(list);
      expect(text(both, st, 100, 30).join("\n"), list).toMatch(/KEEPS OUT +.*fable/);
    }

    // a long reason at 80 by 20: x stays at the foot, and down reaches LIST and KEEPS OUT
    const comments = Array.from({ length: 24 }, (_, i) => `    # reason line ${i + 1}: a long account of why this model is kept out of the work`).join("\n");
    const long = source({ repoText: `routing:\n  deny:\n${comments}\n    models: [codex:gpt-6-luna]\n` });
    const S2 = { cols: 80, rows: 20 };
    let r = press(long, moveTo(long, (t) => t.startsWith("kept:")), "enter", S2).state;
    expect(r.view).toBe("rule");
    const first = frame(long, r, 80, 20).map((l) => l.map((x) => x.text).join(""));
    expect(first).toHaveLength(20);
    expect(first.at(-1)!.trim()).toBe("x remove this rule · ↑↓ PgUp PgDn more · Esc back");
    expect(first.join("\n")).not.toContain("KEEPS OUT");
    for (let i = 0; i < 40; i++) r = press(long, r, "down", S2).state;
    const end = frame(long, r, 80, 20).map((l) => l.map((x) => x.text).join("")).join("\n");
    expect(end).toMatch(/LIST +routing\.deny\.models/);
    expect(end).toMatch(/KEEPS OUT +gpt-6-luna/);
    expect(end).toContain("x remove this rule");
    // up from the end moves at once (the scroll stops at the end), PgUp goes back to the top
    expect(press(long, r, "up", S2).state.scroll).toBe(r.scroll - 1);
    expect(keysFrom(long, r, "pgup", "pgup", "pgup").scroll).toBe(0);
    // x still removes it from there
    expect(press(long, r, "x", S2).state.hand).toEqual([{ line: "deny.models", chosen: [] }]);

    // a first entry that cannot work: the row the role resolves to is asked first, the rows after it its backups
    for (const id of ["consult", "review"]) {
      const dead = source({ health: health(["codex:gpt-6-astra"]), repoText: `${id}:\n  prefer: [codex:gpt-6-astra, claude-code:opus, claude-code:fable]\n` });
      const shown = text(dead, open(dead, id), 120, 40).join("\n");
      expect(shown, id).toMatch(/1 +no answer +gpt-6-astra/);
      expect(shown, id).toMatch(/2 +asked first +opus/);
      expect(shown, id).toMatch(/3 +backup +fable/);
      expect(shown.match(/\d +asked first/g), id).toHaveLength(1);
      if (id === "consult") expect(shown).toMatch(/opus is asked first\.[\s\S]*If it stops working, fable is asked\./);
    }
  });

  // the reviewer's three findings of round 3 (D-2187 add.413), each replayed as its consequence through press() and frame()
  test("a rule's view names every model it matches by the probe's identity; a CLI-wide order reads as the run resolves it; a pending allowance is named", () => {
    const find = (src: ReturnType<typeof source>, from: ScreenState, key: string): ScreenState => {
      let m = keysFrom(src, from, ...key.slice(key.indexOf(":") + 1).split(""), "down", "up");
      for (let i = 0; i < 20 && m.models!.key !== key; i++) m = press(src, m, "right").state;
      expect(m.models!.key).toBe(key);
      return m;
    };
    // (b) a qualified or bare alias rule with no recorded identity, alone or beside a rule on its whole CLI
    for (const deny of ["models: [claude-code:claude-fable-5-2]", "models: [claude-fable-5-2]", "adapters: [claude-code]\n    models: [claude-code:claude-fable-5-2]"]) {
      const src = source({ repoText: `routing:\n  deny:\n    ${deny}\n` });
      const st = press(src, moveTo(src, (t) => t === "kept:routing.deny.models"), "enter").state;
      expect(st.view, deny).toBe("rule");
      expect(text(src, st, 100, 30).join("\n"), deny).toMatch(/KEEPS OUT +.*fable/);
    }
    // ... and a model the probe alone lists, kept out in the keep-out form, is named on its rule's own line
    const probe = source({ health: health([], { codex: ["gpt-7-new"] }) });
    const kept = keysFrom(probe, find(probe, press(probe, moveTo(probe, (t) => t === "kept+"), "enter").state, "codex:gpt-7-new"), "enter", "esc", "esc");
    expect(kept).toMatchObject({ view: "home", hand: [{ line: "deny.workers.models", chosen: ["codex:gpt-7-new"] }] });
    const rule = press(probe, moveTo(probe, (t) => t === "kept:routing.deny.workers.models", kept), "enter").state;
    expect(text(probe, rule, 100, 30).join("\n")).toMatch(/KEEPS OUT +gpt-7-new/);

    // (d) CLI-wide entries read as the run resolves them per writer: codex is asked first for the tasks claude writes and
    // claude-code for the tasks codex writes, so both are asked first; the CLI cell is whole; unchanged is no change
    const wide = source({ repoText: "routing:\n  deny:\n    adapters: [grok]\nreview:\n  prefer: [codex, claude-code]\n" });
    const review = text(wide, open(wide, "review"), 100, 40).join("\n");
    expect(review).toMatch(/1 +asked first +every model +codex /);
    expect(review).toMatch(/2 +asked first +every model +claude-code/);
    expect(review).not.toContain("not listed");
    expect(press(wide, open(wide, "review"), "esc").state.hand).toEqual([]);
    // ... a first entry that cannot work is passed over, as the run passes it over (consult entries are models only: the loader refuses a CLI there)
    const passed = source({ repoText: "routing:\n  deny:\n    adapters: [grok]\nreview:\n  prefer: [grok, codex, claude-code]\n" });
    const over = text(passed, open(passed, "review"), 100, 40).join("\n");
    expect(over).toMatch(/1 +kept out +every model +grok/);
    expect(over).toMatch(/2 +asked first +every model +codex /);
    expect(over).toMatch(/3 +asked first +every model +claude-code/);

    // (e) the judge, the review and the consult: each allowance a pending change adds is named, an allowance-only change included
    const only = source({ repoText: "routing:\n  allow:\n    models: [claude-code:opus, claude-code:fable]\n" });
    for (const id of ["judge", "review", "consult"]) {
      const picked = press(only, find(only, press(only, open(only, id), "enter").state, "codex:gpt-6-astra"), "enter").state;
      const home = keysFrom(only, picked, "esc");
      expect(home.view, id).toBe("home");
      expect(derive(only, home).full!.cfg.routing.allow!.models, id).toContain("codex:gpt-6-astra");
      expect(text(only, home, 120, 60).join("\n"), id).toMatch(/also allows +codex:gpt-6-astra/);
    }
    const astra = source({ repoText: "routing:\n  allow:\n    models: [codex:gpt-6-astra]\njudge:\n  adapter: claude-code\n  model: fable\n" });
    const same = keysFrom(astra, press(astra, find(astra, press(astra, open(astra, "judge"), "enter").state, "claude-code:fable"), "enter").state, "esc");
    expect(same.hand).toEqual([{ line: "judge", chosen: [], allows: ["claude-code:fable"] }]);
    const shown = text(astra, same, 120, 60).join("\n");
    expect(shown).toMatch(/also allows +claude-code:fable/);
    // no row whose before and after read the same
    expect(shown).not.toMatch(/judge +fable.*fable/);
  });

  // the reviewer's two findings of round 4 (D-2187 add.413), each replayed as its consequence through press() and frame()
  test("an opened order reads each entry through the run's own resolution; a rule written twice opens its own reason", () => {
    const row = (src: ReturnType<typeof source>, id: string) => text(src, open(src, id), 120, 40).join("\n");
    // the writers are all codex: a codex reviewer is never independent, and the claude model at the writer's level is asked first
    const allow = "routing:\n  allow:\n    models: [codex:gpt-6-astra, claude-code:opus, claude-code:haiku]\n  deny:\n    workers:\n      adapters: [claude-code]\n";
    for (const prefer of ["[codex, claude-code]", "[codex:gpt-6-astra, claude-code:opus]"]) {
      const shown = row(source({ repoText: `${allow}review:\n  prefer: ${prefer}\n` }), "review");
      expect(shown, prefer).toMatch(/1 +not independent of its writer/);
      expect(shown, prefer).toMatch(/2 +asked first/);
    }
    const low = row(source({ repoText: `${allow}review:\n  prefer: [claude-code:haiku, claude-code:opus]\n` }), "review");
    expect(low).toMatch(/1 +below its writer's level +haiku/);
    expect(low).toMatch(/2 +asked first +opus/);
    // a vendor the product cannot name never reviews: nobody is asked first
    const unknown = row(source({ repoText: `${allow}tiers:\n  claude-code:\n    vendor: unknown\nreview:\n  prefer: [claude-code:opus, codex:gpt-6-astra]\n` }), "review");
    expect(unknown).toMatch(/1 +vendor unknown +opus/);
    expect(unknown).not.toContain("asked first");
    // every model of a CLI kept out reads kept out
    const denied = row(source({ repoText: "routing:\n  deny:\n    models: [claude-code:fable, claude-code:opus, claude-code:sonnet, claude-code:haiku]\nreview:\n  prefer: [claude-code, codex]\n" }), "review");
    expect(denied).toMatch(/1 +kept out +every model +claude-code/);
    // an allowed model whose probe failed reads the failure, not "not allowed yet"; codex, its own writer's vendor, is not asked first
    const timed = row(source({ health: health(["claude-code:opus"]), repoText: "routing:\n  allow:\n    models: [claude-code:opus, codex:gpt-6-astra]\nreview:\n  prefer: [claude-code, codex]\n" }), "review");
    expect(timed).toMatch(/1 +probe timed out|1 +no answer/);
    expect(timed).not.toContain("not allowed yet");
    expect(timed).toMatch(/2 +not independent of its writer +every model +codex/);
    // a model the CLI no longer offers reads not offered on all three lines, never its cached pass
    const h = health();
    h["claude-code"] = { ...h["claude-code"], servable: ["opus"] } as never;
    const offered = source({ health: h, repoText: "judge:\n  adapter: claude-code\n  model: fable\nreview:\n  prefer: [claude-code:fable, codex:gpt-6-astra]\nconsult:\n  prefer: [claude-code:fable, codex:gpt-6-astra]\n" });
    for (const id of ["judge", "review", "consult"]) {
      const shown = row(offered, id);
      expect(shown, id).toMatch(/1 +not offered +fable/);
      expect(shown, id).not.toMatch(/passed/);
    }
    // a rule written twice: each occurrence opens its own reason, and x removes that occurrence alone
    for (const list of ["models", "workers.models", "adapters", "workers.adapters"]) {
      const e = list.endsWith("adapters") ? "codex" : "codex:gpt-6-luna", path = list.split(".");
      const ind = "  ".repeat(path.length + 1);
      const repoText = `routing:\n  deny:\n${path.length > 1 ? "    workers:\n" : ""}${ind}${path.at(-1)}:\n${ind}  # first reason\n${ind}  - ${e}\n${ind}  # second reason\n${ind}  - ${e}\n`;
      const src = source({ repoText });
      for (const [cols, rows] of [[80, 20], [100, 40]] as const) {
        const st = press(src, moveTo(src, (t) => t === `kept:routing.deny.${list}#1`), "enter", { cols, rows }).state;
        expect(st.view, list).toBe("rule");
        const shown = frame(src, st, cols, rows).map((l) => l.map((x) => x.text).join("")).join("\n");
        expect(shown, `${list} ${cols}x${rows}`).toMatch(/REASON +# second reason/);
        expect(press(src, openRule(src, 0), "esc").state.hand, list).toEqual([]);
      }
      const first = text(src, press(src, moveTo(src, (t) => t === `kept:routing.deny.${list}`), "enter").state, 100, 40).join("\n");
      expect(first, list).toMatch(/REASON +# first reason/);
    }
  });
  // the reviewer's four findings of round 5 (D-2187 add.413), each replayed as its consequence through press() and frame()
  test("an opened order names the bar that refuses a reviewer, says not checked without a probe, asks nobody first without a writer, and reads a repeated entry once", () => {
    const row = (src: ReturnType<typeof source>, id: string) => text(src, open(src, id), 120, 40).join("\n");
    const floors = `  floors:\n${SHAPES.map((x) => `    ${x}: cheap`).join("\n")}\n`;
    const cheap = (allow: string, bar: string, prefer: string) => source({ repoText:
      `routing:\n${floors}  allow:\n    models: [${allow}]\n  deny:\n    workers:\n      adapters: [claude-code]\nreview:\n  floor: ${bar}\n  prefer: [${prefer}]\n` });
    // review.floor raised the bar, not the writer (luna, cheap): the row names the review bar
    for (const [m, bar] of [["sonnet", "frontier"], ["haiku", "mid"]]) {
      const shown = row(cheap(`codex:gpt-6-luna, claude-code:${m}, claude-code:opus`, bar, `claude-code:${m}, claude-code:opus`), "review");
      expect(shown, m).toMatch(new RegExp(`1 +below the review bar +${m}`));
      expect(shown, m).not.toContain("below its writer's level");
    }
    // no probe at all: nothing was checked, so nothing reads not installed
    const unprobed = source({ health: null as never, repoText: "review:\n  prefer: [claude-code:opus, codex:gpt-6-astra]\nconsult:\n  prefer: [claude-code:opus, codex:gpt-6-astra]\n" });
    for (const id of ["review", "consult"]) {
      const shown = row(unprobed, id);
      expect(shown, id).not.toContain("not installed");
      // (with no probe nothing writes the tasks either: the review reads that first)
      expect(shown, id).toMatch(id === "review" ? /1 +no task to review +opus/ : /1 +not checked yet +opus/);
    }
    // no model writes the tasks: no task is reviewed, nobody is asked first, an unknown vendor included
    for (const tiers of ["", "tiers:\n  claude-code:\n    vendor: unknown\n"]) {
      const shown = row(source({ repoText: `routing:\n  allow:\n    models: [codex:gpt-6-astra, claude-code:opus]\n  deny:\n    workers:\n      adapters: [codex, claude-code]\n${tiers}review:\n  prefer: [claude-code:opus, codex:gpt-6-astra]\n` }), "review");
      expect(shown, tiers).not.toContain("asked first");
      expect(shown, tiers).toMatch(/1 +no task to review +opus/);
    }
    // an entry written twice is one entry: the second row says so, never backup of itself
    for (const id of ["review", "consult"]) {
      const shown = row(source({ repoText: `${id}:\n  prefer: [claude-code:opus, claude-code:opus, codex:gpt-6-astra]\n` }), id);
      expect(shown, id).toMatch(/2 +same as row 1 +(claude-code:)?opus/);
    }
    const twice = row(source({ repoText: "consult:\n  prefer: [claude-code:opus, claude-code:opus]\n" }), "consult");
    expect(twice).toMatch(/2 +same as row 1 +(claude-code:)?opus/);
    expect(twice).not.toMatch(/\d +backup +opus/);
    expect(twice).toContain("There is no backup");
  });
  // the reviewer's finding of round 6 (D-2187 add.414): a row is a backup only when it adds a channel no earlier row resolves to
  test("a preference row that resolves only to channels an earlier row already takes adds nothing, in either order of a CLI and its model", () => {
    const allow = "routing:\n  allow:\n    models: [codex:gpt-6-astra, claude-code:opus]\n  deny:\n    workers:\n      adapters: [claude-code]\n";
    for (const prefer of ["[claude-code, claude-code:opus]", "[claude-code:opus, claude-code]"]) {
      const src = source({ repoText: `${allow}review:\n  prefer: ${prefer}\n` });
      const shown = text(src, open(src, "review"), 120, 40).join("\n");
      expect(shown, prefer).toMatch(/1 +asked first/);
      expect(shown, prefer).toMatch(/2 +same as row 1/);
      expect(shown, prefer).not.toMatch(/2 +backup/);
    }
  });
});
