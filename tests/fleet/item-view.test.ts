// An item opened with Enter (queue row 500; D-2187 add.355, add.363; contract 5.8), driven through the
// screen's press() and frame(): the design Item's rows, its keys, and an item that has no yes.
import { describe, expect, test } from "vitest";
import { keptOut } from "../../src/fleet/kept.js";
import { needs, needSignature } from "../../src/fleet/needs.js";
import { derive, initialScreen, press, resumeScreen, type ScreenSource, type ScreenState } from "../../src/fleet/screen.js";
import { whoWorks } from "../../src/fleet/item-view.js";
import { keysFrom, moveTo, open, text, toItem } from "./drive.js";
import { health, source } from "./world.js";
import type { NewModel } from "../../src/fleet/needs.js";

// two rules of KEPT OUT, a line naming a model a rule keeps out and one no CLI lists: the tidy item removes both names from the line
const TIDY = "routing:\n  deny:\n    models: [omp:google-antigravity/x]\n    workers:\n      models: [prime-agent:prime-inference/z-ai/glm-5.2]\n  map:\n    implement:\n      pool:\n        mode: ordered\n        channels: [codex:gpt-6-astra, prime-agent:prime-inference/z-ai/glm-5.2, nosuch:gone]\nconsult:\n  prefer: [codex:gpt-6-astra]\n";
const opened = (src: ScreenSource, id: string) => {
  const n = derive(src, initialScreen()).items.findIndex((i) => i.id === id);
  expect(n, id).toBeGreaterThanOrEqual(0);
  const st = press(src, toItem(src, n), "enter").state;
  expect(st).toMatchObject({ view: "item", item: id });
  return st;
};
const words = (rows: string[]) => rows.map((l) => l.trim()).join(" ").replace(/ +/g, " ");

describe("an item opened (5.8)", () => {
  test("an opened item draws the design's rows: what a yes removes; from where; why; what a yes leaves alone; who does the work; its keys", () => {
    const src = source({ repoText: TIDY });
    const d = derive(src, initialScreen()), item = d.items.find((i) => i.id === "tidy")!;
    const rows = text(src, opened(src, "tidy"), 100, 30), all = words(rows);
    // its place and its question
    expect(all).toContain(`NEEDS YOU ${d.items.indexOf(item) + 1} of ${d.items.length}`);
    expect(all).toContain(item.title);
    expect(all).toContain(item.ask);
    // what a yes removes, from where, and why, by name
    expect(rows.some((l) => /A YES REMOVES +FROM +WHY IT CANNOT WORK/.test(l))).toBe(true);
    expect(item.removes!.length).toBe(2);
    for (const r of item.removes!) {
      const row = rows.find((l) => l.includes(r.what))!;
      expect(row, r.what).toContain(r.from.join(", "));
      expect(all).toContain(r.why);
    }
    // what a yes leaves alone: every rule of KEPT OUT in force, by name, never a count
    const kept = keptOut(d.base!).map((r) => r.rule);
    expect(kept).toEqual(["omp:google-antigravity/x", "prime-agent:prime-inference/z-ai/glm-5.2"]);
    expect(all).toContain(`A YES NEVER TOUCHES KEPT OUT: ${kept.join(", ")}`);
    // who does the work after the yes: no task changes worker
    expect(all).toContain("WHO DOES THE WORK the same for every shape");
    expect(rows.at(-1)!.trim()).toBe("y yes, added to NOT SAVED · n no, and do not ask again for these · Esc later");
    // with no rule in force it says so; an item that changes something names each change and the shapes it moves
    const bare = source();
    const first = derive(bare, initialScreen()).items.find((i) => i.edits && !i.removes)!;
    const shown = words(text(bare, opened(bare, first.id), 100, 40));
    expect(shown).toContain("A YES NEVER TOUCHES nothing is kept out");
    expect(shown).toContain("A YES CHANGES");
    for (const e of first.edits!) expect(shown).toContain(e.label);
    expect(shown).toMatch(/WHO DOES THE WORK (the same for every shape|changes for \w+)/);
    // the 2.26.1 details view and its words are gone
    expect(shown).not.toContain("Yes changes:");
    expect(shown).not.toMatch(/Esc\s+back/);
  });

  test("y adds the item to not saved; n is remembered so the item is not shown again; Esc leaves it for later", () => {
    const src = source({ repoText: TIDY });
    const st = opened(src, "tidy");
    // y: back on the one screen, the item in NOT SAVED
    const yes = press(src, st, "y").state;
    expect(yes).toMatchObject({ view: "home", yes: ["tidy"] });
    expect(text(src, yes, 100, 40).join("\n")).toContain("NOT SAVED");
    // n: remembered by the item's content; the screen opened again does not show it
    const no = press(src, st, "n");
    expect(no.action).toEqual({ kind: "dismiss", id: "tidy" });
    expect(no.state).toMatchObject({ view: "home", yes: [] });
    const item = derive(src, initialScreen()).items.find((i) => i.id === "tidy")!;
    const again = source({ repoText: TIDY }, { dismissed: new Set([needSignature(item)]) });
    expect(derive(again, initialScreen()).items.map((i) => i.id)).not.toContain("tidy");
    // Esc: back, nothing answered, nothing remembered; the item is still there to open later
    const later = press(src, st, "esc");
    expect(later.action).toBeUndefined();
    expect(later.state).toMatchObject({ view: "home", yes: [] });
    expect(keysFrom(src, later.state, "enter")).toMatchObject({ view: "item", item: "tidy" });
  });

  test("an item that has no yes reads n not now; y on it says it is the user's to do", () => {
    // the consult's model is kept out by a rule: no yes, never a lift (K1)
    const src = source({ repoText: "routing:\n  deny:\n    models: [claude-code:fable]\nconsult:\n  prefer: [claude-code:fable]\n" });
    const item = derive(src, initialScreen()).items.find((i) => i.id === "consult")!;
    expect(item.edits).toBeUndefined();
    const st = opened(src, "consult");
    const rows = text(src, st, 80, 24);
    expect(rows.at(-1)!.trim()).toBe("n not now · Esc later");
    expect(words(rows)).toContain("A YES NEVER TOUCHES KEPT OUT: claude-code:fable");
    const y = press(src, st, "y");
    expect(y.action).toBeUndefined();
    expect(y.state).toMatchObject({ view: "item", item: "consult", yes: [] });
    expect(words(text(src, y.state, 80, 24))).toContain("This one is yours to do; then press r.");
    // n: not now, remembered as any no is
    expect(press(src, st, "n").action).toEqual({ kind: "dismiss", id: "consult" });
  });

  // every row of an opened item is reached at 80 by 24: Down walks to the last one, nothing is dropped behind a count (row 500; D-2187 add.363)
  const walked = (src: ScreenSource, st: ScreenState): string => {
    const seen: string[] = [];
    for (let i = 0; i < 200; i++) {
      seen.push(...text(src, st, 80, 24).map((l) => l.trim()));
      const next = press(src, st, "down").state;
      if (next.scroll === st.scroll) break;
      st = next;
    }
    return seen.join(" ").replace(/ +/g, " ");
  };
  test("every KEPT OUT rule and who does the work are reached at 80 by 24, however many rules there are", () => {
    for (const n of [2, 20, 40]) {
      const rules = Array.from({ length: n }, (_, i) => `other:model-${i}-which-we-want-to-leave-alone`);
      const src = source({ repoText: `routing:\n  deny:\n    models: [${rules.join(", ")}]\n  map:\n    implement:\n      pool:\n        mode: ordered\n        channels: [codex:gpt-6-astra, nosuch:gone]\nconsult:\n  prefer: [codex:gpt-6-astra]\n` });
      const st = opened(src, "tidy"), all = walked(src, st);
      for (const r of rules) expect(all, `${n}: ${r}`).toContain(r);
      expect(all, String(n)).toContain("WHO DOES THE WORK");
      expect(all, String(n)).not.toContain("the save lists every change");
      // the keys stay on the last row while it scrolls, and Esc leaves it for later from anywhere
      const down = press(src, st, "pgdown").state;
      expect(text(src, down, 80, 24).at(-1)!.trim()).toBe("y yes, added to NOT SAVED · n no, and do not ask again for these · Esc later");
      expect(press(src, down, "esc").state).toMatchObject({ view: "home", scroll: 0 });
    }
  });
  test("the complexity item's reasons for each line are reached at 80 by 24", () => {
    const nine = `routing:\n  mode: partner-led\n  map:\n${["plan", "spec", "implement", "tests", "docs", "migration", "ui", "refactor", "chore"].map((x) => `    ${x}:\n      pool: { mode: any, channels: [codex:gpt-6-astra, codex:gpt-6-luna] }\n`).join("")}consult:\n  prefer: [codex:gpt-6-astra]\n`;
    const src = source({ repoText: nine });
    const item = derive(src, initialScreen()).items.find((i) => i.id === "complexity")!;
    expect(item.given!.length).toBe(9);
    const all = walked(src, opened(src, "complexity"));
    for (const e of item.edits!) expect(all, e.label).toContain(e.label);
    expect(all).toContain(" now: ");
    for (const g of item.given!) for (const x of g.none) if (x.reason) expect(all, `${g.line}: ${x.reason}`).toContain(x.reason);
    expect(all).toContain("WHO DOES THE WORK");
  });
  test("an opened item says what its yes makes on top of the changes not saved: a line changed by hand keeps its choice", () => {
    const src = source({ repoText: "routing:\n  mode: partner-led\n  map:\n    implement:\n      pool: { mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra] }\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    let luna = open(src, "implement");
    for (const k of ["down", "down", "down", "x", "esc"]) luna = press(src, luna, k).state;
    expect(luna.hand).toMatchObject([{ line: "implement", chosen: ["codex:gpt-6-luna"] }]);
    // NOW (the luna alone by hand) asks the floor item again: its yes is NOW's, and the hand's line keeps its choice
    const asked = needs(derive(src, luna).full!, {}).find((n) => n.id === "floor")!;
    const st = press(src, toItem(src, derive(src, luna).items.findIndex((i) => i.id === "floor"), luna), "enter").state;
    const shown = words(text(src, st, 100, 30)), d = derive(src, press(src, st, "y").state);
    expect(d.refused).toBeUndefined();
    expect(whoWorks(derive(src, st).full!, d.full)).toBe("the same for every shape");
    expect(shown).toContain(asked.ask);
    expect(shown).not.toContain("A YES CHANGES");
    expect(shown).toContain(`NOT MADE: A LINE YOU CHANGED BY HAND KEEPS YOUR CHOICE ${asked.edits![0].label}`);
    expect(shown).toContain("WHO DOES THE WORK the same for every shape");
    // the same line changed by hand to the astra alone: NOW no longer asks it, so it offers no yes
    const astra = { ...luna, hand: [{ ...luna.hand[0], chosen: ["codex:gpt-6-astra"] }] };
    const no = press(src, toItem(src, derive(src, astra).items.findIndex((i) => i.id === "floor"), astra), "enter").state;
    const rows = text(src, no, 100, 30);
    expect(words(rows)).toContain("With the changes not saved this is no longer asked.");
    expect(rows.at(-1)!.trim()).toBe("n not now · Esc later");
    expect(press(src, no, "y").state).toMatchObject({ view: "item", yes: [] });
  });

  // every row is read from NOW (the changes not saved applied) and AFTER YES, never the saved config (row 500; D-2187 add.420)
  const PL = (line: string) => `routing:\n  mode: partner-led\n  map:\n    implement:\n      pool: { ${line} }\nconsult:\n  prefer: [codex:gpt-6-astra]\n`;
  const openId = (src: ScreenSource, from: ScreenState, id: string) => {
    const n = derive(src, from).items.findIndex((i) => i.id === id);
    expect(n, id).toBeGreaterThanOrEqual(0);
    return press(src, toItem(src, n, from), "enter").state;
  };
  test("a removal a hand's choice overrides is said only as not made, never as what a yes removes", () => {
    const src = source({ repoText: PL("mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]") });
    // the astra unticked on the implement line by hand: nosuch:gone stays on it, the hand's choice
    let st = open(src, "implement");
    const at = (s: ScreenState) => text(src, s, 100, 30).findIndex((l) => l.includes("▸"));
    for (let i = 0; i < 10 && !text(src, st, 100, 30)[at(st)].includes("astra"); i++) st = press(src, st, "down").state;
    st = keysFrom(src, press(src, st, "x").state, "esc");
    expect(st.hand).toMatchObject([{ line: "implement", chosen: ["codex:gpt-6-luna", "nosuch:gone"] }]);
    const item = openId(src, st, "tidy"), shown = words(text(src, item, 100, 30));
    expect(derive(src, press(src, item, "y").state).full!.cfg.routing.map.implement!.pool!.channels).toContain("nosuch:gone");
    expect(shown).not.toContain("A YES REMOVES");
    expect(shown).toContain("NOT MADE: A LINE YOU CHANGED BY HAND KEEPS YOUR CHOICE implement: remove nosuch:gone");
  });
  test("the complexity item says who gets each line's tasks now from the changes not saved", () => {
    const src = source({ repoText: PL("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra]") });
    const floor = derive(src, initialScreen()).items.find((i) => i.id === "floor");
    expect(floor?.edits).toBeTruthy();
    const yes = press(src, openId(src, initialScreen(), "floor"), "y").state;
    const now = derive(src, yes).full!.cfg.routing.map.implement!.pool!.channels;
    expect(now).toEqual(["codex:gpt-6-astra"]);
    const shown = words(text(src, openId(src, yes, "complexity"), 100, 30));
    expect(shown).not.toMatch(/now: [^]*Luna gets [1-9]/);
    expect(shown).toMatch(/now: [^ ]*.*Astra gets 400/i);
  });
  test("what a yes leaves alone is every rule of KEPT OUT in the changes not saved, added and removed by hand", () => {
    const pick = (src: ScreenSource, from: ScreenState, key: string) => {
      let m = keysFrom(src, from, ...key.slice(key.indexOf(":") + 1).split(""), "down", "up");
      for (let i = 0; i < 20 && m.models!.key !== key; i++) m = press(src, m, "right").state;
      expect(m.models!.key).toBe(key);
      return press(src, m, "enter").state;
    };
    const tidy = "  map:\n    implement:\n      pool: { mode: ordered, channels: [codex:gpt-6-astra, nosuch:gone] }\nconsult:\n  prefer: [codex:gpt-6-astra]\n";
    // a rule added by hand through KEPT OUT +: named, though no saved rule is
    const bare = source({ repoText: `routing:\n${tidy}` });
    const added = keysFrom(bare, pick(bare, press(bare, moveTo(bare, (t) => t === "kept+"), "enter").state, "claude-code:fable"), "esc", "esc");
    expect(added.hand.length).toBe(1);
    const a = words(text(bare, openId(bare, added, "tidy"), 100, 30));
    expect(a).toContain("A YES NEVER TOUCHES KEPT OUT: claude-code:fable");
    expect(a).not.toContain("nothing is kept out");
    // the one saved rule removed by hand with x on its own line: nothing is kept out
    const one = source({ repoText: `routing:\n  deny:\n    models: [other:kept-rule]\n${tidy}` });
    const gone = press(one, press(one, moveTo(one, (t) => t.startsWith("kept:routing.deny.models")), "enter").state, "x").state;
    expect(gone.hand).toMatchObject([{ chosen: [] }]);
    const g = words(text(one, openId(one, gone, "tidy"), 100, 30));
    expect(g).toContain("A YES NEVER TOUCHES nothing is kept out");
    expect(g).not.toContain("other:kept-rule");
  });
  test("every row of an opened item is read from the changes not saved and the yes on top of them, for every item and any changes", () => {
    // bounded: each item of a world, opened with and without every other yes pending; the rows match NOW and AFTER YES
    const src = source({ repoText: TIDY });
    const all = derive(src, initialScreen()).items.filter((i) => i.edits).map((i) => i.id);
    const rules = [[], [{ line: "deny.models", chosen: [] }], [{ line: "deny.models", chosen: ["omp:google-antigravity/x", "claude-code:fable"] }]];
    for (const hand of rules) for (const others of [[], all]) for (const id of all) {
      const st = { ...initialScreen(), hand, yes: others.filter((x) => x !== id) };
      const now = derive(src, st).full!, shown = words(text(src, openId(src, st, id), 120, 60));
      const k = keptOut(now).map((r) => r.rule);
      expect(shown, id).toContain(k.length ? `KEPT OUT: ${k.join(", ")}` : "nothing is kept out");
      for (const r of derive(src, st).items.find((i) => i.id === id)!.removes ?? []) for (const s of r.from) {
        const held = !now.cfg.routing.map[s]?.pool?.channels.includes(r.what);
        if (held) expect(shown, `${id} ${r.what}`).not.toMatch(new RegExp(`${r.what} +${s}`));
      }
    }
  });

  // the reviewers' reproducers (D-2187 add.420): each through press() and frame()
  test("an item already answered yes, opened again, says a yes changes nothing more and no worker moves", () => {
    const src = source({ repoText: PL("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra]") });
    const yes = press(src, openId(src, initialScreen(), "floor"), "y").state;
    const shown = words(text(src, openId(src, yes, "floor"), 100, 30));
    expect(derive(src, yes).full!.cfg.routing.map.implement!.pool!.channels).toEqual(["codex:gpt-6-astra"]);
    expect(shown).toContain("WHO DOES THE WORK the same for every shape");
    expect(shown).not.toContain("A YES CHANGES");
    expect(shown).toContain("You said yes: it is in NOT SAVED");
  });
  test("a removal the changes not saved no longer justify is not given the saved reason, nor offered", () => {
    const src = source({ repoText: "routing:\n  deny:\n    workers:\n      models: [codex:gpt-6-luna]\n  mode: partner-led\n  map:\n    implement:\n      pool: { mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra] }\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    expect(words(text(src, openId(src, initialScreen(), "tidy"), 100, 30))).toContain("kept out by codex:gpt-6-luna");
    const gone = press(src, press(src, moveTo(src, (t) => t.startsWith("kept:routing.deny.workers")), "enter").state, "x").state;
    expect(gone.hand).toMatchObject([{ chosen: [] }]);
    const st = openId(src, gone, "tidy"), rows = text(src, st, 100, 30), shown = words(rows);
    expect(shown).not.toContain("kept out by codex:gpt-6-luna");
    expect(shown).not.toContain("A YES REMOVES");
    expect(shown).toContain("With the changes not saved this is no longer asked");
    expect(shown).toContain("WHO DOES THE WORK the same for every shape");
    expect(rows.at(-1)!.trim()).toBe("n not now · Esc later");
    expect(press(src, st, "y").state.yes).toEqual([]);
  });

  test("a change merged with another yes says what the yes writes, as NOW asks it", () => {
    const fresh: NewModel = { id: "gemini-4-carbon", name: "Gemini 4 Carbon", provider: "google", paths: [{ adapter: "omp", model: "google/gemini-4-carbon", score: 60 }],
      score: 60, best: { score: 59.1, model: "opus5.5" }, tier: "frontier", needs: 0.9, firstSeen: "2026-11-10" };
    const src = source({ repoText: PL("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra]"), health: health([], { omp: ["google/gemini-4-carbon"] }) }, { newModels: [fresh] });
    const y = press(src, openId(src, initialScreen(), "new:gemini-4-carbon"), "y").state;
    const floor = openId(src, y, "floor"), shown = words(text(src, floor, 100, 40));
    const after = derive(src, press(src, floor, "y").state).full!.cfg.routing.map.implement!.pool!.channels;
    expect(after).toEqual(["codex:gpt-6-astra", "omp:google/gemini-4-carbon"]);
    expect(shown).not.toContain("implement: gpt-6-astra only");
    expect(shown).toMatch(/A YES CHANGES implement: [^ ]*gpt-6-astra, gemini-4-carbon only/);
  });

  test("with a message on the screen, Down still reaches the last row of an opened item at 80 by 24", () => {
    const rules = ["claude-code:fable", ...Array.from({ length: 20 }, (_, i) => `other:model-${i}-which-we-want-to-leave-alone`)];
    const src = source({ repoText: `routing:\n  deny:\n    models: [${rules.join(", ")}]\nconsult:\n  prefer: [claude-code:fable]\n` });
    const st = press(src, opened(src, "consult"), "y").state;
    expect(st.msg).toContain("This one is yours to do");
    const all = walked(src, st);
    expect(all).toContain("WHO DOES THE WORK");
    for (const r of rules) expect(all).toContain(r);
  });
  test("for every item and any changes not saved, what a yes changes is the difference of NOW and AFTER YES", () => {
    // bounded: each item with a yes, the others answered or not, itself answered or not
    const src = source({ repoText: PL("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]") });
    const ids = derive(src, initialScreen()).items.filter((i) => i.edits).map((i) => i.id);
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) for (const others of [[], ids.filter((x) => x !== id)]) for (const own of [false, true]) {
      const st = { ...initialScreen(), yes: [...others, ...(own ? [id] : [])] };
      const now = derive(src, st).full!, after = derive(src, { ...st, yes: [...others, id] }).full!, shown = words(text(src, openId(src, st, id), 120, 80));
      expect(shown, id).toContain(`WHO DOES THE WORK ${whoWorks(now, after)}`);
      const moved = JSON.stringify(now.cfg.routing) !== JSON.stringify(after.cfg.routing);
      expect(/A YES (CHANGES|REMOVES)/.test(shown), `${id} ${others.length} ${own}`).toBe(moved);
      if (own) expect(moved).toBe(false);
    }
  });

  // the reviewers' reproducers (D-2187 add.420, third round): the question never promises what the yes does not make
  const removeRule = (src: ScreenSource, prefix: string) => press(src, press(src, moveTo(src, (t) => t.startsWith(prefix)), "enter").state, "x").state;
  test("a question NOW asks differently is the one shown, and y makes exactly it: the tidy item removes only what NOW cannot use", () => {
    const src = source({ repoText: "routing:\n  deny:\n    workers:\n      models: [codex:gpt-6-luna]\n  mode: partner-led\n  map:\n    implement:\n      pool: { mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone] }\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    const gone = removeRule(src, "kept:routing.deny.workers"), asked = needs(derive(src, gone).full!, {}).find((n) => n.id === "tidy")!;
    const st = openId(src, gone, "tidy"), shown = words(text(src, st, 100, 40));
    expect(derive(src, press(src, st, "y").state).full!.cfg.routing.map.implement!.pool!.channels).toEqual(["codex:gpt-6-luna", "codex:gpt-6-astra"]);
    expect(shown).toContain(asked.ask);
    expect(shown).toMatch(/nosuch:gone +implement/);
    expect(shown).not.toMatch(/codex:gpt-6-luna +implement/);
    expect(shown).toContain("WHO DOES THE WORK the same for every shape");
  });
  test("an item with no yes that NOW no longer asks does not say its model is kept out or the consult is missing", () => {
    const src = source({ repoText: "routing:\n  deny:\n    models: [claude-code:fable]\nconsult:\n  prefer: [claude-code:fable]\n" });
    const st = openId(src, removeRule(src, "kept:routing.deny.models"), "consult");
    expect(derive(src, st).full!.consult).toBe("claude-code:fable");
    const shown = words(text(src, st, 100, 40));
    expect(shown).not.toMatch(/claude-code:fable is kept out/);
    expect(shown).not.toMatch(/Until then a stalled task goes straight to you/);
    expect(shown).toContain("With the changes not saved this is no longer asked.");
    expect(shown).toContain("A YES NEVER TOUCHES nothing is kept out");
  });
  test("a consult item whose models are kept out by hand asks NOW's question, and y writes exactly its consult", () => {
    const src = source({ repoText: "routing:\n  mode: partner-led\nconsult:\n  prefer: []\n" });
    let st = initialScreen();
    for (const key of ["codex:gpt-6-astra", "claude-code:fable"]) {
      st = open(src, "kept", st);
      st = keysFrom(src, st, ...key.slice(key.indexOf(":") + 1).split(""), "down", "up");
      for (let i = 0; i < 25 && st.models!.key !== key; i++) st = press(src, st, "right").state;
      expect(st.models!.key).toBe(key);
      st = keysFrom(src, st, "enter", "enter", "esc", "esc");
    }
    const asked = needs(derive(src, st).full!, {}).find((n) => n.id === "consult")!;
    expect(asked.edits).toBeTruthy();
    st = openId(src, st, "consult");
    const shown = words(text(src, st, 100, 40)), y = derive(src, press(src, st, "y").state).full!;
    expect(shown).toContain(asked.ask);
    expect(y.cfg.consult.prefer).toEqual(asked.edits!.find((e) => e.path.join(".") === "consult.prefer")!.value);
    expect(y.cfg.consult.prefer).not.toContain("codex:gpt-6-astra");
    expect(shown).toContain(`the consult: ${y.name(y.consult!)}`);
  });
  test("for every item and any rules changed by hand, the question shown asks exactly the yes the item makes", () => {
    // bounded: each item of a world, the KEPT OUT lists as saved, emptied by hand, or with Fable added; others answered or not
    const src = source({ repoText: TIDY });
    const ids = derive(src, initialScreen()).items.map((i) => i.id);
    const hands = [[], [{ line: "deny.models", chosen: [] }], [{ line: "deny.workers.models", chosen: [] }], [{ line: "deny.models", chosen: ["omp:google-antigravity/x", "claude-code:fable"] }]];
    for (const hand of hands) for (const others of [false, true]) for (const id of ids) {
      const st = { ...initialScreen(), hand, yes: others ? ids.filter((x) => x !== id) : [] };
      const asked = needs(derive(src, st).full!, { dismissed: undefined }).find((n) => n.id === id);
      const rows = text(src, openId(src, st, id), 120, 80), shown = words(rows);
      if (asked) expect(shown, id).toContain(asked.ask);
      else expect(shown, id).toContain("With the changes not saved this is no longer asked.");
      expect(rows.at(-1)!.trim(), id).toBe(asked?.edits ? "y yes, added to NOT SAVED · n no, and do not ask again for these · Esc later" : "n not now · Esc later");
    }
  });

  // the reviewers' reproducers (D-2187 add.421): what y stages is what the item shows
  test("after a rule is removed by hand, the consult, judge and noseat items offer NOW's yes and y makes it", () => {
    const src = source({ repoText: "routing:\n  allow:\n    adapters: [codex]\n  deny:\n    adapters: [codex]\n  map:\n    implement:\n      pool: { mode: ordered, channels: [nosuch:gone] }\nconsult:\n  prefer: []\n" });
    for (const id of ["consult", "judge", "noseat"]) expect(derive(src, initialScreen()).items.find((i) => i.id === id)!.edits, id).toBeUndefined();
    const gone = removeRule(src, "kept:routing.deny.adapters");
    const consult = openId(src, gone, "consult");
    expect(words(text(src, consult, 100, 40))).toContain("A YES CHANGES consult: gpt-6-astra");
    expect(derive(src, press(src, consult, "y").state).full!.cfg.consult.prefer).toEqual(["codex:gpt-6-astra"]);
    const judge = openId(src, gone, "judge");
    expect(words(text(src, judge, 100, 40))).toContain("A YES CHANGES judge: gpt-6-astra");
    expect(derive(src, press(src, judge, "y").state).full!.cfg.judge).toMatchObject({ adapter: "codex", model: "gpt-6-astra" });
    const noseat = openId(src, gone, "noseat"), shown = words(text(src, noseat, 100, 60));
    const after = derive(src, press(src, noseat, "y").state).full!;
    expect(shown).toContain(`WHO DOES THE WORK ${whoWorks(derive(src, gone).full!, after)}`);
    expect(whoWorks(derive(src, gone).full!, after)).toMatch(/^changes for /);
  });
  test("an allowance merged with a line's own allowance by hand is a change a yes makes, never not made", () => {
    const fresh: NewModel = { id: "gemini-4-carbon", name: "Gemini 4 Carbon", provider: "google", paths: [{ adapter: "omp", model: "google/gemini-4-carbon", score: 60 }],
      score: 60, best: { score: 59.1, model: "opus5.5" }, tier: "frontier", needs: 0.9, firstSeen: "2026-11-10" };
    const src = source({ repoText: "routing:\n  allow:\n    adapters: [codex]\n  mode: partner-led\n  map:\n    implement:\n      pool: { mode: ordered, channels: [codex:gpt-6-astra] }\nconsult:\n  prefer: [codex:gpt-6-astra]\n", health: health([], { omp: ["google/gemini-4-carbon"] }) }, { newModels: [fresh] });
    const hand: ScreenState = { ...initialScreen(), hand: [{ line: "implement", chosen: ["codex:gpt-6-astra", "claude-code:fable"], mode: "ordered", allows: ["claude-code:fable"] }] };
    const st = openId(src, hand, "new:gemini-4-carbon"), shown = words(text(src, st, 100, 40));
    expect(derive(src, press(src, st, "y").state).full!.cfg.routing.allow.models).toContain("omp:google/gemini-4-carbon");
    expect(shown).toMatch(/A YES CHANGES .*allow omp:google\/gemini-4-carbon .*NOT MADE/);
    expect(shown.slice(shown.indexOf("NOT MADE"))).not.toContain("allow omp:google/gemini-4-carbon");
  });
  test("for every item kind, y stages exactly the AFTER YES the opened item rendered", () => {
    // bounded: every item of three worlds, with and without a rule removed by hand and the other yeses pending
    const fresh: NewModel = { id: "gemini-4-carbon", name: "Gemini 4 Carbon", provider: "google", paths: [{ adapter: "omp", model: "google/gemini-4-carbon", score: 60 }],
      score: 60, best: { score: 59.1, model: "opus5.5" }, tier: "frontier", needs: 0.9, firstSeen: "2026-11-10" };
    const worlds = [source({ repoText: TIDY }),
      source({ repoText: "routing:\n  allow:\n    adapters: [codex]\n  deny:\n    adapters: [codex]\n  map:\n    implement:\n      pool: { mode: ordered, channels: [nosuch:gone] }\nconsult:\n  prefer: []\n" }),
      source({ repoText: PL("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]"), health: health([], { omp: ["google/gemini-4-carbon"] }) }, { newModels: [fresh] })];
    let kinds = 0;
    for (const src of worlds) for (const hand of [[], [{ line: "deny.models", chosen: [] }], [{ line: "deny.adapters", chosen: [] }]]) {
      const ids = derive(src, initialScreen()).items.map((i) => i.id);
      for (const others of [false, true]) for (const id of ids) {
        const st0 = { ...initialScreen(), hand, yes: others ? ids.filter((x) => x !== id) : [] };
        if (derive(src, st0).refused) continue;
        const now = derive(src, st0).full!, asked = needs(now, { ...src.ctx, dismissed: undefined }).find((n) => n.id === id);
        const st = openId(src, st0, id), rows = text(src, st, 120, 120), shown = words(rows), y = press(src, st, "y");
        if (!asked?.edits) {
          expect(rows.at(-1)!.trim(), id).toBe("n not now · Esc later");
          expect(y.state.yes, id).toEqual(st0.yes);
          continue;
        }
        kinds++;
        const after = derive(src, y.state);
        expect(y.state.yes, id).toContain(id);
        if (after.refused) continue;
        // the item names its yes as NOW asks it, says who does the work in the very team y staged, and every change
        // it says a yes makes is in that team; what it says is not made is NOW's value there
        expect(shown, id).toContain(asked.ask);
        expect(shown, id).toContain(`WHO DOES THE WORK ${whoWorks(now, after.full, undefined, asked.edits.some((e) => e.path[0] === "consult"))}`);
        const val = (M: typeof now, p: string[]) => JSON.stringify(p.reduce<unknown>((c, k) => (c && typeof c === "object" ? (c as Record<string, unknown>)[k] : undefined), M.cfg) ?? null);
        const made = shown.indexOf("NOT MADE") < 0 ? shown : shown.slice(0, shown.indexOf("NOT MADE"));
        for (const e of asked.edits) if (shown.includes("A YES CHANGES") && made.includes(e.label)) expect(val(after.full!, e.path), `${id} ${e.label}`).toBe(JSON.stringify(e.value));
        for (const e of asked.edits) if (shown.includes(`NOT MADE: A LINE YOU CHANGED BY HAND KEEPS YOUR CHOICE`) && shown.slice(shown.indexOf("NOT MADE")).includes(e.label)) expect(val(after.full!, e.path), `${id} ${e.label}`).toBe(val(now, e.path));
      }
    }
    expect(kinds).toBeGreaterThan(4);
  });

  // the reviewers' reproducers (D-2187 add.421, second cap): NOW includes the item's own yes; r keeps the staged yes; n remembers what is shown
  const CODEX = "routing:\n  allow:\n    adapters: [codex]\n  deny:\n    adapters: [codex]\n  map:\n    implement:\n      pool: { mode: ordered, channels: [nosuch:gone] }\nconsult:\n  prefer: []\n";
  const WORKER = "routing:\n  deny:\n    workers:\n      models: [codex:gpt-6-luna]\n  mode: partner-led\n  map:\n    implement:\n      pool: { mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone] }\nconsult:\n  prefer: [codex:gpt-6-astra]\n";
  const keepOut = (src: ScreenSource, from: ScreenState, key: string): ScreenState => {
    let st = keysFrom(src, open(src, "kept", from), ...key.slice(key.indexOf(":") + 1).split(""), "down", "up");
    for (let i = 0; i < 25 && st.models!.key !== key; i++) st = press(src, st, "right").state;
    expect(st.models!.key).toBe(key);
    return keysFrom(src, st, "enter", "enter", "esc", "esc");
  };
  /** The opened item promises what y does: NOW's question, and "changes nothing more" only when y changes nothing. */
  const honest = (src: ScreenSource, st: ScreenState, id: string) => {
    const now = derive(src, st).full!, asked = needs(now, { ...src.ctx, dismissed: undefined }).find((n) => n.id === id);
    const shown = words(text(src, st, 100, 60)), after = derive(src, press(src, st, "y").state).full!;
    if (asked) expect(shown, id).toContain(asked.ask);
    const same = JSON.stringify(after.cfg) === JSON.stringify(now.cfg);
    if (shown.includes("a yes again changes nothing more")) expect(same, id).toBe(true);
    if (/A YES (CHANGES|REMOVES)/.test(shown)) expect(same, id).toBe(false);
    expect(shown, id).toContain(`WHO DOES THE WORK ${whoWorks(now, after, undefined, !same && !!asked?.edits?.some((e) => e.path[0] === "consult"))}`);
  };
  test("an answered item reopened after the changes not saved moved asks NOW's question, and promises no more than y makes", () => {
    const src = source({ repoText: CODEX }), gone = removeRule(src, "kept:routing.deny.adapters");
    for (const id of ["consult", "judge", "noseat"]) {
      const yes = press(src, openId(src, gone, id), "y").state;
      expect(yes.yes, id).toContain(id);
      honest(src, openId(src, keepOut(src, yes, "codex:gpt-6-astra"), id), id);
    }
    // floor y, complexity y, floor n: complexity reopened says what y makes from NOW
    const pl = source({ repoText: PL("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]") });
    let st = press(pl, openId(pl, initialScreen(), "floor"), "y").state;
    st = press(pl, openId(pl, st, "complexity"), "y").state;
    st = press(pl, openId(pl, st, "floor"), "n").state;
    honest(pl, openId(pl, st, "complexity"), "complexity");
  });
  test("r keeps every staged yes through the probe: the team reopened is the team answered", () => {
    const src = source({ repoText: CODEX }), gone = removeRule(src, "kept:routing.deny.adapters");
    const worker = source({ repoText: WORKER }), wgone = removeRule(worker, "kept:routing.deny.workers");
    for (const [s, from, id] of [[src, gone, "consult"], [src, gone, "judge"], [src, gone, "noseat"], [worker, wgone, "tidy"]] as const) {
      const yes = press(s, openId(s, from, id), "y").state, r = press(s, yes, "r");
      expect(r.action?.kind, id).toBe("probe");
      const back = resumeScreen(s, (r.action as { keep?: Parameters<typeof resumeScreen>[1] }).keep).state;
      expect(back.yes, id).toContain(id);
      expect(derive(s, back).full!.cfg, id).toEqual(derive(s, yes).full!.cfg);
    }
  });
  test("n remembers the item as shown: after the changes are saved it is not asked again", () => {
    const src = source({ repoText: CODEX }), gone = removeRule(src, "kept:routing.deny.adapters");
    const worker = source({ repoText: WORKER }), wgone = removeRule(worker, "kept:routing.deny.workers");
    for (const [s, from, id] of [[src, gone, "consult"], [src, gone, "judge"], [src, gone, "noseat"], [worker, wgone, "tidy"]] as const) {
      const shown = needs(derive(s, from).full!, { ...s.ctx, dismissed: undefined }).find((n) => n.id === id)!;
      const st = openId(s, from, id), no = press(s, st, "n");
      expect(no.action, id).toEqual({ kind: "dismiss", id });
      // the screen's consumer reads the item from the state the n was pressed in: the one shown
      const sig = needSignature(derive(s, st).items.find((n) => n.id === id)!);
      expect(sig, id).toBe(needSignature(shown));
      expect(no.state.log, id).toContain(`n:${sig}`);
      // with the rule removal saved, the remembered item is not asked again
      const saved = source({ repoText: derive(s, from).texts!.repoText }, { dismissed: new Set([sig]) });
      expect(derive(saved, initialScreen()).items.map((n) => n.id), id).not.toContain(id);
      // nor on the one screen before the save
      expect(derive({ ...s, ctx: { ...s.ctx, dismissed: new Set([sig]) } }, no.state).items.map((n) => n.id), id).not.toContain(id);
    }
  });

  // the reviewers' sequences (D-2187 add.422): a yes adds to the one pending set; n remembers the item as rendered
  const TWO = (line: string) => `routing:\n  mode: partner-led\n  map:\n    implement:\n      pool: { ${line} }\n    tests:\n      pool: { ${line} }\nconsult:\n  prefer: [codex:gpt-6-astra]\n`;
  /** y on the opened item, then the item opened again and y again: the second y changes only what it then shows. */
  const twice = (src: ScreenSource, from: ScreenState, id: string) => {
    const one = press(src, openId(src, from, id), "y").state;
    const again = openId(src, one, id), shown = derive(src, again).items.find((i) => i.id === id)!;
    const two = press(src, again, "y").state;
    const a = derive(src, one).full!.cfg, b = derive(src, two).full!.cfg;
    const paths = new Set((shown.edits ?? []).map((e) => e.path.join(".")));
    for (const s of Object.keys({ ...a.routing.map, ...b.routing.map })) {
      if (!paths.has(`routing.map.${s}`)) expect((b.routing.map as Record<string, unknown>)[s], `${id} ${s}`).toEqual((a.routing.map as Record<string, unknown>)[s]);
    }
    if (!paths.has("consult.prefer")) expect(b.consult, id).toEqual(a.consult);
    // what the item opened again said a yes changes is all the second yes changed
    if (JSON.stringify(a) !== JSON.stringify(b)) expect(words(text(src, again, 120, 80)), id).toMatch(/A YES (CHANGES|REMOVES)/);
    return { one, two, a, b };
  };
  const ASTRA_OFF = (luna: boolean): ScreenState => ({ ...initialScreen(), hand: [{ line: "implement", chosen: [...(luna ? ["codex:gpt-6-luna"] : []), "nosuch:gone"], mode: "ordered" }] });
  test("an item answered again changes only what it now shows: the floor and tidy items keep their earlier yes on tests", () => {
    const src = source({ repoText: TWO("mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]") });
    for (const id of ["floor", "tidy"]) {
      if (!derive(src, ASTRA_OFF(true)).items.some((i) => i.id === id)) continue;
      const { a, b } = twice(src, ASTRA_OFF(true), id);
      expect(b.routing.map.tests, id).toEqual(a.routing.map.tests);
      expect(a.routing.map.tests!.pool?.channels ?? [], id).not.toContain("nosuch:gone");
    }
  });
  test("the noseat and run items answered again keep every model their earlier yes added to tests", () => {
    const src = source({ repoText: TWO("mode: ordered, channels: [nosuch:gone]") });
    const hand: ScreenState = { ...initialScreen(), hand: [{ line: "implement", chosen: ["codex:gpt-6-astra", "codex:gpt-6-luna"], mode: "complexity" }] };
    const lastRun = [{ runId: "r1", seat: "codex:gpt-6-astra", shapes: ["implement", "tests"], tasks: ["T1"] }] as never;
    const run = source({ repoText: TWO("mode: ordered, channels: [codex:gpt-6-astra]") }, { lastRun });
    let tried = 0;
    for (const [s, id] of [[src, "noseat"], [run, "run"], [run, "fallbacks"]] as const) {
      const at = derive(s, hand).items.find((i) => i.id === id || i.id.startsWith(`${id}:`));
      if (!at?.edits) continue;
      tried++;
      const { a, b } = twice(s, hand, at.id);
      expect(b.routing.map.tests, at.id).toEqual(a.routing.map.tests);
    }
    expect(tried).toBeGreaterThan(0);
  });
  test("for every item and any changes not saved, a second yes reverts nothing the first made", () => {
    // bounded: every item with a yes of three worlds, with and without a line changed by hand
    const worlds = [source({ repoText: TWO("mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]") }), source({ repoText: TWO("mode: ordered, channels: [nosuch:gone]") }), source({ repoText: TIDY })];
    const hands = [initialScreen(), ASTRA_OFF(true), ASTRA_OFF(false), { ...initialScreen(), hand: [{ line: "implement", chosen: ["codex:gpt-6-astra", "codex:gpt-6-luna"], mode: "complexity" as const }] }];
    let n = 0;
    for (const src of worlds) for (const from of hands) {
      if (derive(src, from).refused) continue;
      for (const it of derive(src, from).items.filter((i) => i.edits)) {
        const one = press(src, openId(src, from, it.id), "y").state;
        if (derive(src, one).refused) continue;
        twice(src, from, it.id);
        n++;
      }
    }
    expect(n).toBeGreaterThan(5);
  });
  test("r after a yes answered again keeps every pending change byte for byte", () => {
    const src = source({ repoText: TWO("mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]") });
    const { two } = twice(src, ASTRA_OFF(true), "floor");
    const r = press(src, two, "r");
    const back = resumeScreen(src, (r.action as { keep?: Parameters<typeof resumeScreen>[1] }).keep).state;
    expect(derive(src, back).texts).toEqual(derive(src, two).texts);
  });
  test("n on an item NOW asks no more remembers the placeholder shown, and the item leaves the list at once", () => {
    const fable = source({ repoText: "routing:\n  deny:\n    models: [claude-code:fable]\nconsult:\n  prefer: [claude-code:fable]\n" });
    const worker = source({ repoText: "routing:\n  deny:\n    workers:\n      models: [codex:gpt-6-luna]\n  mode: partner-led\n  map:\n    implement:\n      pool: { mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra] }\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    let tried = 0;
    for (const [s, rule, ids] of [[fable, "kept:routing.deny.models", ["noseat", "judge", "consult"]], [worker, "kept:routing.deny.workers", ["tidy"]]] as const) {
      const gone = removeRule(s, rule);
      for (const id of ids) {
        if (!derive(s, gone).items.some((i) => i.id === id)) continue;
        const st = openId(s, gone, id), rows = text(s, st, 100, 40), shown = words(rows);
        if (!shown.includes("Nothing is left to do here")) continue;
        tried++;
        // the consumer reads the item from the state n was pressed in: the placeholder rendered, not the saved question
        const item = derive(s, st).items.find((i) => i.id === id)!;
        expect(shown, id).toContain(item.title);
        expect(shown, id).toContain(item.ask);
        expect(item.ask, id).toBe("Nothing is left to do here: n or Esc.");
        const no = press(s, st, "n"), sig = needSignature(item);
        expect(no.state.log, id).toContain(`n:${sig}`);
        const after = { ...s, ctx: { ...s.ctx, dismissed: new Set([...(s.ctx.dismissed ?? []), sig]) } };
        expect(derive(after, no.state).items.map((i) => i.id), id).not.toContain(id);
        // the saved question is not what was answered: without the changes it is still asked
        expect(derive(after, initialScreen()).items.map((i) => i.id), id).toContain(id);
      }
    }
    expect(tried).toBeGreaterThan(1);
  });

  // the reviewers' sequences (D-2187 add.422, last round): n after a yes leaves the list at once; r keeps a staged yes through changed health
  const dismissedBy = (s: ScreenSource, st: ScreenState) => {
    const no = press(s, st, "n"), sig = needSignature(derive(s, st).items.find((i) => i.id === st.item)!);
    expect(no.state.log).toContain(`n:${sig}`);
    return { no, after: { ...s, ctx: { ...s.ctx, dismissed: new Set([...(s.ctx.dismissed ?? []), sig]) } } };
  };
  test("n on an item answered yes before takes it off the list at once, though withdrawing the yes changes NOW", () => {
    const lastRun = [{ runId: "r1", seat: "codex:gpt-6-astra", shapes: ["implement", "tests"], tasks: ["T1"] }] as never;
    const worlds = [source({ repoText: TWO("mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]") }), source({ repoText: TWO("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]") }),
      source({ repoText: TWO("mode: ordered, channels: [codex:gpt-6-astra]") }, { lastRun })];
    const hands: ScreenState[] = [ASTRA_OFF(true), { ...initialScreen(), hand: [{ line: "implement", chosen: ["codex:gpt-6-astra", "codex:gpt-6-luna"], mode: "complexity" }] }];
    let n = 0;
    for (const s of worlds) for (const from of hands) for (const id of ["floor", "tidy", "run:r1:codex:gpt-6-astra"]) {
      if (!derive(s, from).items.find((i) => i.id === id)?.edits) continue;
      const yes = press(s, openId(s, from, id), "y").state;
      if (derive(s, yes).refused) continue;
      n++;
      const { no, after } = dismissedBy(s, openId(s, yes, id));
      expect(no.state.yes, id).not.toContain(id);
      expect(derive(after, no.state).items.map((i) => i.id), id).not.toContain(id);
      // u brings it back
      const u = press(after, no.state, "u");
      expect(u.action?.kind).toBe("restore");
    }
    expect(n).toBeGreaterThan(3);
  });
  test("r keeps a staged yes whose item the new probe results no longer ask, with its removals", () => {
    const cases: Array<[string, string, string[][]]> = [
      [PL("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra]"), "floor", [["codex:gpt-6-luna"]]],
      [TWO("mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]"), "floor", [["codex:gpt-6-luna"], ["codex:gpt-6-luna", "codex:gpt-6-astra"]]],
      [TWO("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]"), "floor", [["codex:gpt-6-luna"], ["codex:gpt-6-luna", "codex:gpt-6-astra"]]],
      [TWO("mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]"), "tidy", [["codex:gpt-6-luna", "codex:gpt-6-astra"]]],
      [TWO("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]"), "tidy", [["codex:gpt-6-luna", "codex:gpt-6-astra"]]]];
    let n = 0;
    for (const [repoText, id, deads] of cases) {
      const src = source({ repoText });
      if (!derive(src, initialScreen()).items.find((i) => i.id === id)?.edits) continue;
      const yes = press(src, openId(src, initialScreen(), id), "y").state, r = press(src, yes, "r");
      const keep = (r.action as { keep?: Parameters<typeof resumeScreen>[1] }).keep;
      for (const dead of deads) {
        n++;
        const probed = source({ repoText, health: health(dead) });
        const back = resumeScreen(probed, keep).state;
        expect(back.yes, `${id} ${dead}`).toContain(id);
        expect(derive(probed, back).texts, `${id} ${dead}`).toEqual(derive(src, yes).texts);
      }
    }
    expect(n).toBeGreaterThan(4);
  });
});

describe("r keeps every answer through changed probe results (row 518; D-2187 add.439)", () => {
  const PL = (line: string) => `routing:\n  mode: partner-led\n  map:\n    implement:\n      pool: { ${line} }\nconsult:\n  prefer: [codex:gpt-6-astra]\n`;
  const TWO = (line: string) => `routing:\n  mode: partner-led\n  map:\n    implement:\n      pool: { ${line} }\n    tests:\n      pool: { ${line} }\nconsult:\n  prefer: [codex:gpt-6-astra]\n`;
  const openId = (src: ScreenSource, from: ScreenState, id: string) => {
    const n = derive(src, from).items.findIndex((i) => i.id === id);
    expect(n, id).toBeGreaterThanOrEqual(0);
    return press(src, toItem(src, n, from), "enter").state;
  };
  const homeYes = (src: ScreenSource, from: ScreenState, id: string) => press(src, moveTo(src, (t) => t === `item:${id}`, from), "y").state;
  const probe = (src: ScreenSource, st: ScreenState) => (press(src, st, "r").action as { keep?: Parameters<typeof resumeScreen>[1] }).keep;
  test("a yes given on the home row is kept with its own edits when the new probe results no longer ask it", () => {
    const cases: Array<[string, string, string[][]]> = [
      [PL("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra]"), "floor", [["codex:gpt-6-luna"], ["codex:gpt-6-astra"]]],
      [TWO("mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]"), "floor", [["codex:gpt-6-luna"], ["codex:gpt-6-luna", "codex:gpt-6-astra"]]],
      [TWO("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]"), "floor", [["codex:gpt-6-luna"], ["codex:gpt-6-luna", "codex:gpt-6-astra"]]],
      [TWO("mode: ordered, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]"), "tidy", [["codex:gpt-6-luna", "codex:gpt-6-astra"]]],
      [TWO("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]"), "tidy", [["codex:gpt-6-luna", "codex:gpt-6-astra"]]]];
    let n = 0;
    for (const [repoText, id, deads] of cases) {
      const src = source({ repoText });
      if (!derive(src, initialScreen()).items.find((i) => i.id === id)?.edits) continue;
      const yes = homeYes(src, initialScreen(), id), keep = probe(src, yes);
      for (const dead of deads) {
        n++;
        const probed = source({ repoText, health: health(dead) }), back = resumeScreen(probed, keep).state, where = `${id} ${dead.join(",")}`;
        expect(back.yes, where).toContain(id);
        expect(derive(probed, back).texts, where).toEqual(derive(src, yes).texts);
      }
    }
    expect(n).toBeGreaterThan(5);
  });
  test("two answers keep the order they were given through a probe: a later yes still wins where both write", () => {
    const cases: Array<[string, string, string[][]]> = [
      [TWO("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra]"), "floor", [["codex:gpt-6-luna"], ["codex:gpt-6-luna", "codex:gpt-6-astra"]]],
      [TWO("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]"), "floor", [["codex:gpt-6-luna"], ["codex:gpt-6-luna", "codex:gpt-6-astra"]]],
      [TWO("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]"), "tidy", [["codex:gpt-6-luna", "codex:gpt-6-astra"]]]];
    let n = 0;
    for (const [repoText, first, deads] of cases) {
      const src = source({ repoText }), items = derive(src, initialScreen()).items;
      if (!items.find((i) => i.id === first)?.edits || !items.find((i) => i.id === "complexity")?.edits) continue;
      const a = press(src, openId(src, initialScreen(), first), "y").state;
      const home = press(src, a, "esc").state, b = press(src, openId(src, home, "complexity"), "y").state;
      const keep = probe(src, b);
      for (const dead of deads) {
        n++;
        const probed = source({ repoText, health: health(dead) }), back = resumeScreen(probed, keep).state, where = `${first} then complexity, ${dead.join(",")}`;
        expect(back.yes, where).toEqual(b.yes);
        expect(derive(probed, back).texts, where).toEqual(derive(src, b).texts);
      }
    }
    expect(n).toBeGreaterThan(2);
  });
  // one answer carried alone, or one withdrawn after a probe, still merges as given: a later yes wins (row 518 repair)
  test("an answer given since a probe wins over one given before it, and a withdrawn answer given again merges last", () => {
    const ONE = (line: string) => `routing:\n  mode: partner-led\n  map:\n    implement:\n      pool: { ${line} }\n`;
    const mode = (src: ScreenSource, st: ScreenState) => derive(src, st).full?.cfg.routing.map.implement?.pool?.mode;
    let n = 0;
    // a single answer before r (no keep.order), then complexity after it: home-row y and Enter then y alike
    for (const [repoText, first, dead] of [[PL("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra]"), "floor", ["codex:gpt-6-luna"]],
      [TWO("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]"), "tidy", ["codex:gpt-6-luna", "codex:gpt-6-astra"]]] as Array<[string, string, string[]]>) {
      const src = source({ repoText });
      if (!derive(src, initialScreen()).items.find((i) => i.id === first)?.edits) continue;
      const probed = source({ repoText, health: health(dead) }), back = resumeScreen(probed, probe(src, homeYes(src, initialScreen(), first))).state;
      if (!derive(probed, back).items.find((i) => i.id === "complexity")?.edits) continue;
      n++;
      expect(mode(probed, homeYes(probed, back, "complexity")), first).toBe("complexity");
      const opened = openId(probed, back, "complexity");
      expect(text(probed, opened, 100, 30).join("\n"), first).toContain("A YES CHANGES");
      expect(mode(probed, press(probed, opened, "y").state), first).toBe("complexity");
    }
    // two answers through a probe, the later withdrawn by u or by n, then another answered and the withdrawn one again
    const src = source({ repoText: ONE("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra, nosuch:gone]") });
    const both = homeYes(src, homeYes(src, initialScreen(), "consult"), "complexity");
    const back = resumeScreen(src, probe(src, both)).state;
    for (const withdraw of ["u", "n"]) {
      n++;
      const out = withdraw === "u" ? press(src, back, "u").state : press(src, moveTo(src, (t) => t === "item:complexity", back), "n").state;
      expect(out.yes, withdraw).not.toContain("complexity");
      const again = homeYes(src, homeYes(src, withdraw === "n" ? press(src, out, "u").state : out, "tidy"), "complexity");
      expect(mode(src, again), withdraw).toBe("complexity");
    }
    expect(n).toBeGreaterThan(2);
  });
});

describe("an opened item names each model as contract 5.1 does (row 518; D-2187 add.442)", () => {
  test("two CLIs offering a model of the same name are told apart by CLI in who gets a line's tasks", async () => {
    const { allocation } = await import("../../src/fleet/item-view.js");
    const repoText = "tiers:\n  codex:\n    models:\n      shared: frontier\n  claude-code:\n    models:\n      shared: frontier\nrouting:\n  mode: partner-led\n  map:\n    implement:\n      pool: { mode: any, channels: [codex:shared, claude-code:shared] }\n    tests:\n      pool: { mode: ordered, channels: [codex:shared] }\n";
    const src = source({ repoText, health: health([], { codex: ["shared"], "claude-code": ["shared"] }) }), M = derive(src, initialScreen()).base!;
    expect(M.name("codex:shared")).toBe(M.name("claude-code:shared"));
    const both = allocation(M, "implement");
    expect(both).toMatch(/\(codex\)/u);
    expect(both).toMatch(/\(claude-code\)/u);
    // a line holding one of them still names it apart from the other the team knows
    expect(allocation(M, "tests")).toMatch(/\(codex\)/u);
  });
});

describe("an item answered yes and opened again describes NOW, its own yes included (row 518; D-2187 add.444)", () => {
  const PL = (line: string) => `routing:\n  mode: partner-led\n  map:\n    implement:\n      pool: { ${line} }\nconsult:\n  prefer: [codex:gpt-6-astra]\n`;
  const CODEX = "routing:\n  allow:\n    adapters: [codex]\n  deny:\n    adapters: [codex]\n  map:\n    implement:\n      pool: { mode: ordered, channels: [nosuch:gone] }\nconsult:\n  prefer: []\n";
  const openId = (src: ScreenSource, from: ScreenState, id: string) => {
    const n = derive(src, from).items.findIndex((i) => i.id === id);
    expect(n, id).toBeGreaterThanOrEqual(0);
    return press(src, toItem(src, n, from), "enter").state;
  };
  const removeRule = (src: ScreenSource, prefix: string) => press(src, press(src, moveTo(src, (t) => t.startsWith(prefix)), "enter").state, "x").state;
  const at = (cfg: unknown, p: readonly string[]): unknown => p.reduce<unknown>((c, k) => (c && typeof c === "object" ? (c as Record<string, unknown>)[k] : undefined), cfg);
  // every kind the row names, each answered yes from a world that asks it
  const cases = (): Array<[string, ScreenSource, ScreenState]> => {
    const codex = source({ repoText: CODEX }), gone = removeRule(codex, "kept:routing.deny.adapters");
    return [["floor", source({ repoText: PL("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra]") }), initialScreen()],
      ["tidy", source({ repoText: TIDY }), initialScreen()],
      ["complexity", source({ repoText: PL("mode: any, channels: [codex:gpt-6-luna, codex:gpt-6-astra]") }), initialScreen()],
      ["consult", codex, gone], ["judge", codex, gone], ["noseat", codex, gone],
      ["setup", source({ health: health(["claude-code:fable"]) }), initialScreen()]];
  };

  test("an item answered yes and opened again describes the team with that yes, for floor, tidy, complexity, consult, judge, noseat and setup", () => {
    for (const [id, src, from] of cases()) {
      // the item as the team before the yes asks it
      const before = needs(derive(src, from).full!, { ...src.ctx, dismissed: undefined }).find((i) => i.id === id)!;
      expect(before?.edits, id).toBeTruthy();
      const yes = press(src, openId(src, from, id), "y").state;
      expect(yes.yes, id).toContain(id);
      const now = derive(src, yes).full!, asked = needs(now, { ...src.ctx, dismissed: undefined }).find((n) => n.id === id);
      const shown = words(text(src, openId(src, yes, id), 120, 80));
      // with its own yes NOW asks it no more
      expect(asked, id).toBeUndefined();
      // never the question asked of the team before the yes, nor its reasons
      expect(shown, id).not.toContain(before.title);
      expect(shown, id).not.toContain(before.ask);
      for (const t of before.detail) expect(shown, id).not.toContain(t);
      expect(shown, id).toContain("You said yes: it is in NOT SAVED.");
      expect(shown, id).toContain("NOW, WITH YOUR YES");
      // each place the yes wrote, as NOW holds it
      for (const e of before.edits!) {
        const v = at(now.cfg, e.path);
        if (e.path[1] === "map") for (const k of (v as { pool?: { channels: string[] } }).pool?.channels ?? []) expect(shown, `${id} ${k}`).toContain(now.name(k));
        else if (Array.isArray(v)) expect(shown, `${id} ${e.path.join(".")}`).toContain(`${e.path.join(".")}: ${v.join(", ")}`);
        else expect(shown, `${id} ${e.path.join(".")}`).toContain(`${e.path.join(".")}: `);
      }
      expect(shown, id).toContain("WHO DOES THE WORK the same for every shape");
    }
    // the named defects: the floor's shape no longer runs below the bar, the tidy name removed is not named, the consult is set
    const [floor, tidy, , consult] = cases();
    const reopened = ([id, src, from]: [string, ScreenSource, ScreenState]) => words(text(src, openId(src, press(src, openId(src, from, id), "y").state, id), 120, 80));
    expect(reopened(floor)).not.toMatch(/below frontier/);
    expect(reopened(tidy)).not.toContain("nosuch:gone");
    expect(reopened(consult)).not.toContain("consult.prefer is not set");
  });

  test("an item answered yes and opened again says its yes is given and n withdraws it, and n there restores the team before that yes", () => {
    for (const [id, src, from] of cases()) {
      const yes = press(src, openId(src, from, id), "y").state, st = openId(src, yes, id), rows = text(src, st, 120, 80);
      expect(words(rows), id).toMatch(/You said yes/);
      expect(rows.at(-1)!.trim(), id).toBe("your yes is given · n withdraw it, and do not ask again for these · Esc later");
      const no = press(src, st, "n");
      expect(no.action, id).toEqual({ kind: "dismiss", id });
      expect(no.state.yes, id).not.toContain(id);
      expect(derive(src, no.state).full!.cfg, id).toEqual(derive(src, from).full!.cfg);
    }
  });
});
