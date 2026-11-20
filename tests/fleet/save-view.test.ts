// The save (contract 5.7; queue row 499 (h); D-2187 add.363): s opens YOU ARE SAVING, each change after
// and before, the files the candidate bytes touch and who reads them, UNTOUCHED, THIS ALSO CHANGES; d shows
// the file lines; Enter is the one write. Driven through press() and frame(), and once through the real mount.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadFleetSource } from "../../src/fleet/load.js";
import { derive, initialScreen, lineHomeTargets, press, type ScreenSource, type ScreenState } from "../../src/fleet/screen.js";
import { adapters, setup, terminal } from "../cli/fleet-screen-world.js";
import { arrowsTo, keysFrom, open, text, toItem } from "./drive.js";
import type { NewModel } from "../../src/fleet/needs.js";
import { health, POOL, source } from "./world.js";
import { parsedLayers } from "../../src/fleet/needs.js";
import { changedPaths } from "../../src/fleet/save-view.js";

/** implement in my order, two frontier models; the consult in an order of two. */
const TWO = "routing:\n  map:\n    implement:\n      pool:\n        mode: ordered\n        channels: [codex:gpt-6-astra, claude-code:opus]\n";
const CONSULT = "consult:\n  prefer: [codex:gpt-6-astra, claude-code:opus]\n";
const flat = (rows: string[]) => rows.map((l) => l.trimEnd()).join("\n");
/** implement opened, opus removed with x, and back: one pending change of the line. */
function dropOpus(src: ScreenSource, from: ScreenState = initialScreen()): ScreenState {
  const st = open(src, "implement", from);
  return keysFrom(src, st, ...Array<string>(lineHomeTargets(src, st).indexOf("model:claude-code:opus")).fill("down"), "x", "esc");
}

/** The save's changes, each from its number to the next (or to the blank row after the last). */
function changesOf(shown: string): string[] {
  const rows = shown.split("\n"), from = rows.findIndex((l) => /^ {2}1 {2}/.test(l)), end = rows.indexOf("", from);
  const out: string[][] = [];
  for (const l of rows.slice(from, end)) if (/^ {2}\d+ {2}/.test(l)) out.push([l]); else out.at(-1)!.push(l);
  return out.map((c) => c.join("\n"));
}

describe("the save", () => {
  // the review of attempt 1 (row 499 (h); D-2187 add.363): every change says its after AND its before, a moved bar says
  // both bars, and any measure that moves the wrong way opens THIS ALSO CHANGES, a bar measure too
  test("every pending change says after and before, a moved bar both bars, and a worse measure is listed even when a bar moved", () => {
    const consult = "consult:\n  prefer: [codex:gpt-6-astra]\n", pool = source({ repoText: `${POOL}${consult}` });
    const bare = source({ health: health(["claude-code:fable"]) });
    const docs = source({ repoText: `${TWO}  floors:\n    docs: frontier\n${CONSULT}` });
    const opened = dropOpus(docs);
    const cases: Array<[string, ScreenSource, ScreenState]> = [
      ["setup", bare, { ...initialScreen(), yes: ["setup"], log: ["y:setup"] }],
      ["implement bar", pool, keysFrom(pool, open(pool, "implement"), "f", "f", "esc")],
      ["mode", source({ repoText: POOL.replace("partner-led", "risk-based") + consult }), { ...initialScreen(), hand: [{ line: "mode", chosen: ["partner-led"] }] }],
      ["docs bar removed", docs, { ...opened, hand: [...opened.hand, { line: "docs", chosen: [], floor: "mode" }] }],
    ];
    const shot: Record<string, string> = {};
    for (const [name, src, st] of cases) {
      const save = press(src, { ...st, view: "home" }, "s").state;
      expect(save.view, name).toBe("save");
      shot[name] = flat(text(src, save, 100, 80));
      const changes = changesOf(shot[name]);
      expect(changes.length, name).toBeGreaterThan(0);
      for (const c of changes) {
        expect(c, `${name}\n${c}`).toMatch(/^ +after +\S/m);
        expect(c, `${name}\n${c}`).toMatch(/^ +before +\S/m);
      }
    }
    // the consult a yes sets: after it, before it nothing, by its key
    expect(shot.setup).toMatch(/ +before +plan: nobody +backup fable; pinned +routing\.map\.plan\n/);
    expect(shot.setup).toMatch(/^ +consult: nobody +consult\.prefer$/m);
    // f, f on implement: the bar after and before, never workers alone
    expect(shot["implement bar"]).toMatch(/after[\s\S]*bar +mid, this shape's own, held in this project's settings\n +before[^\n]*\n +bar +frontier, from the mode/);
    // partner-led raises every bar: the counts it makes worse are listed, worse, and the bar named
    expect(shot.mode).toMatch(/THIS ALSO CHANGES[\s\S]*tasks below their bar +0 → 400 +worse; the bar moved/);
    // an unrelated bar removed in the same batch never hides the worse count opus's removal makes
    expect(shot["docs bar removed"]).toMatch(/2 {2}docs[\s\S]*bar +cheap, from the mode\n +before[^\n]*\n +bar +frontier, this shape's own, held in this project's settings\n/);
    expect(shot["docs bar removed"]).toMatch(/THIS ALSO CHANGES[\s\S]*shapes with fewer than two models at their bar +0 → 1 +worse/);
  });

  // the review of attempt 2 (row 499 (h); D-2187 add.417): an answer a later change by hand supersedes never says the answer's words
  test("an answered yes that a change by hand supersedes says so and shows what Enter writes, never the answer's own words", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    const afterOf = (st: ScreenState) => {
      const save = press(src, { ...st, view: "home" }, "s").state;
      expect(save.view).toBe("save");
      return { d: derive(src, save), shown: flat(text(src, save, 120, 60)) };
    };
    // complexity said yes, then My order on implement (the reviewer's reproducer)
    let st = press(src, toItem(src, derive(src, initialScreen()).items.findIndex((x) => x.id === "complexity")), "y").state;
    st = open(src, "implement", st);
    st = keysFrom(src, st, ...Array<string>(lineHomeTargets(src, st).indexOf("choice:order")).fill("down"), "enter", "esc");
    const order = afterOf(st);
    expect(order.d.full!.cfg.routing.map.implement!.pool!.mode).toBe("ordered");
    expect(order.shown).not.toMatch(/after +implement: by complexity/);
    expect(order.shown).toMatch(/after +superseded by change 2; written: implement: /);
    // complexity said yes, then implement held to opus alone by hand
    const opus = afterOf({ ...initialScreen(), yes: ["complexity"], log: ["y:complexity", "h:implement"], hand: [{ line: "implement", chosen: ["claude-code:opus"] }] });
    expect(opus.d.full!.cfg.routing.map.implement!.pool?.mode).not.toBe("complexity");
    expect(opus.shown).not.toMatch(/after +implement: by complexity/);
    expect(opus.shown).toMatch(/after +superseded by change 2; written: implement: /);
    // the consult said yes, then reordered: the after row is the order written, never the answer's
    const bare = source({ repoText: POOL });
    const consult = derive(bare, initialScreen()).items.find((x) => x.id === "consult")!;
    const yes = { ...initialScreen(), yes: [consult.id], log: [`y:${consult.id}`] };
    const reordered = keysFrom(bare, open(bare, "consult", yes), "]", "esc", "s");
    const dc = derive(bare, reordered), shownC = flat(text(bare, reordered, 120, 60));
    expect(dc.full!.cfg.consult.prefer).not.toEqual(consult.edits![0].value);
    expect(shownC).not.toContain(`after    ${consult.edits![0].label}`);
    expect(shownC).toMatch(/after +superseded by change 2; written: consult: /);
    // bounded, over every item of these worlds: an answer's own words stand only where the candidate holds what it set
    for (const w of [src, bare, source({ health: health(["claude-code:fable"]) })]) for (const item of derive(w, initialScreen()).items) {
      for (const e of item.edits ?? []) {
        const row = e.path[0] === "routing" ? e.path[2] : e.path[0];
        if (!row || !["implement", "plan", "judge", "review", "consult"].includes(row)) continue;
        const ys = { ...initialScreen(), yes: [item.id], log: [`y:${item.id}`] };
        const hand = keysFrom(w, open(w, row, ys), "]", "esc");
        const save = press(w, { ...hand, view: "home" }, "s").state;
        if (save.view !== "save") continue;
        const d = derive(w, save), shownW = flat(text(w, save, 160, 120));
        const held = JSON.stringify(e.path.reduce<unknown>((c, k) => (c as Record<string, unknown> | undefined)?.[k], d.full?.cfg)) === JSON.stringify(e.value);
        if (!held) expect(shownW, `${item.id} ${row}`).not.toMatch(new RegExp(`after +${e.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
      }
    }
  });

  // the review of attempt 3 (row 499 (h); D-2187 add.417): every after row is what the candidate holds, every setting the
  // batch writes has its before and after, and an order is said in the order written
  test("the after rows are the candidate's: an answer another change overlaps, a companion setting and an order with a model down", () => {
    const shotOf = (src: ScreenSource, st: ScreenState) => {
      const save = press(src, { ...st, view: "home" }, "s").state;
      expect(save.view).toBe("save");
      return { d: derive(src, save), shown: flat(text(src, save, 140, 120)) };
    };
    const ord = (rows: string) => source({ repoText: `routing:\n  map:\n    implement:\n      pool:\n        mode: ordered\n        channels: [${rows}]\nconsult:\n  prefer: [codex:gpt-6-astra]\n` });
    const astraDown = (src: ScreenSource, from: ScreenState = initialScreen()) => {
      const st = open(src, "implement", from);
      return keysFrom(src, st, ...Array<string>(lineHomeTargets(src, st).indexOf("model:codex:gpt-6-astra")).fill("down"), "]", "esc");
    };
    // tidy said yes after implement reordered by hand: the candidate keeps nosuch:gone, so the save never says it removes it
    const gone = ord("codex:gpt-6-astra, nosuch:gone, claude-code:opus");
    let st = astraDown(gone);
    st = press(gone, toItem(gone, derive(gone, st).items.findIndex((x) => x.id === "tidy"), st), "y").state;
    const tidy = shotOf(gone, st);
    expect(tidy.d.full!.cfg.routing.map.implement!.pool!.channels).toContain("nosuch:gone");
    expect(tidy.shown).not.toMatch(/after +removes nosuch:gone/);
    expect(tidy.shown).toMatch(/after +superseded by change 1; written: implement: /);
    expect(tidy.shown).toMatch(/after +nosuch:gone, codex:gpt-6-astra, claude-code:opus +routing\.map\.implement\.pool\.channels\n +before +codex:gpt-6-astra, nosuch:gone, claude-code:opus/);
    // the order written, never the working model first: [gone, astra, opus]
    expect(tidy.shown).toMatch(/1 {2}implement\n +after +in order +gone, gpt-6-astra, opus\n/);
    // opus down, astra moved below it: the order written is opus, then astra
    const down = source({ repoText: ord("codex:gpt-6-astra, claude-code:opus").inputs.repoText, health: health(["claude-code:opus"]) });
    const order = shotOf(down, astraDown(down));
    expect(order.d.full!.cfg.routing.map.implement!.pool!.channels).toEqual(["claude-code:opus", "codex:gpt-6-astra"]);
    expect(order.shown).toMatch(/after +in order +opus, gpt-6-astra\n/);
    // floor and the new model both said yes: implement is written with both, and the floor's own words are not the after row
    const fresh: NewModel = { id: "gemini-4-carbon", name: "Gemini 4 Carbon", provider: "google", paths: [{ adapter: "omp", model: "google/gemini-4-carbon", score: 60 }],
      score: 60, best: { score: 59.1, model: "opus5.5" }, tier: "frontier", needs: 0.9, firstSeen: "2026-11-10" };
    const carbon = source({ repoText: POOL, health: health([], { omp: ["google/gemini-4-carbon"] }) }, { newModels: [fresh] });
    const ids = derive(carbon, initialScreen()).items.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["floor", "new:gemini-4-carbon"]));
    const both = shotOf(carbon, { ...initialScreen(), yes: ["floor", "new:gemini-4-carbon"], log: ["y:floor", "y:new:gemini-4-carbon"] });
    const written = both.d.full!.cfg.routing.map.implement!.pool!.channels;
    expect(written).toEqual(expect.arrayContaining(["codex:gpt-6-astra", "omp:google/gemini-4-carbon"]));
    for (const e of derive(carbon, { ...initialScreen(), yes: ["floor"] }).said[0].edits!) expect(both.shown).not.toMatch(new RegExp(`after +${e.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    expect(both.shown).toMatch(new RegExp(`after +${written.join(", ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+routing\\.map\\.implement\\.pool\\.channels`));
    // a level given a model of a CLI the settings do not have: the CLI's billing and vendor are written too, each after and before
    const cli = source({ repoText: "tiers:\n  codex: null\nconsult:\n  prefer: [claude-code:opus]\n", health: health([], { codex: ["gpt-review-new"] }) });
    const level = shotOf(cli, { ...initialScreen(), hand: [{ line: "tier:codex:gpt-review-new", chosen: ["mid"] }], log: ["h:tier:codex:gpt-review-new"] });
    expect(level.d.edits.map((e) => e.path.join("."))).toEqual(expect.arrayContaining(["tiers.codex.channel", "tiers.codex.vendor"]));
    expect(level.shown).toMatch(/after +sub +tiers\.codex\.channel\n +before +nothing/);
    expect(level.shown).toMatch(/after +openai +tiers\.codex\.vendor\n +before +nothing/);
    // bounded, over these batches: every setting the candidate changes is named by its key or its line in the save
    for (const [src, x] of [[gone, tidy], [down, order], [carbon, both], [cli, level]] as const) {
      for (const e of x.d.edits) {
        const read = (cfg: unknown) => JSON.stringify(e.path.reduce<unknown>((c, k) => (c as Record<string, unknown> | undefined)?.[k], cfg) ?? null);
        if (read(x.d.full!.cfg) === read(derive(src, initialScreen()).base!.cfg)) continue;
        const name = e.path[0] === "routing" && e.path[1] === "map" ? e.path[2] : e.path.join(".");
        expect(x.shown, e.path.join(".")).toContain(name);
      }
    }
  });

  // the review of attempt 4 (row 499 (h); D-2187 add.417): a change of the routing method alone, and a bar override removed
  // while another file still holds the same bar, are each said after and before
  test("a routing method changed and a project's bar removed under the user's same bar are each said after and before", () => {
    const c = "consult:\n  prefer: [codex:gpt-6-astra]\n";
    const shotOf = (src: ScreenSource, st: ScreenState) => {
      const save = press(src, { ...st, view: "home" }, "s").state;
      expect(save.view).toBe("save");
      return { d: derive(src, save), shown: flat(text(src, save, 140, 80)) };
    };
    // floor and complexity both said yes: implement goes from shared to by complexity, and both rows say so
    const pool = source({ repoText: POOL + c });
    const both = shotOf(pool, { ...initialScreen(), yes: ["floor", "complexity"], log: ["y:floor", "y:complexity"] });
    expect(both.d.full!.cfg.routing.map.implement!.pool!.mode).toBe("complexity");
    expect(both.shown).toMatch(/after +with change \d; written: implement: gpt-6-astra does every task; by complexity/);
    expect(both.shown).toMatch(/before +implement: gpt-5\.6-terra does every task +no tasks: gpt-6-astra; as saved before 2\.27/);
    // the method is the only change: after and before differ by it, never two identical rows
    const esc = source({ repoText: POOL.replace("tier: null", "escalate: true") + c });
    const only = shotOf(esc, { ...initialScreen(), yes: ["complexity"], log: ["y:complexity"] });
    const after = only.shown.match(/after +(.*)/)![1], before = only.shown.match(/before +(.*)/)![1];
    expect(after.replace(/^written: /, "")).not.toBe(before);
    expect(after).toContain("by complexity; escalate true");
    // the user's and the project's settings both hold implement at a bar; any f clears the project's: the bar rows say which file holds it
    for (const [tier, n] of [["frontier", 1], ["mid", 2], ["cheap", 3]] as const) {
      const src = source({ userText: `routing:\n  floors:\n    implement: ${tier}\n`,
        repoText: `routing:\n  floors:\n    implement: ${tier}\n${TWO.slice("routing:\n".length)}${c}` });
      const x = shotOf(src, keysFrom(src, open(src, "implement"), ...Array<string>(n).fill("f"), "esc"));
      expect(x.d.texts!.repoText, tier).not.toMatch(/implement: (frontier|mid|cheap)/);
      expect(x.shown, tier).toMatch(new RegExp(`after[\\s\\S]*bar +${tier}, this shape's own, held in your settings\n +before[^\n]*\n +bar +${tier}, this shape's own, held in this project's settings over your settings`));
    }
  });

  // the review of attempt 5 (row 499 (h); D-2187 add.418): the save's rows are a diff of the saved files against the candidate
  // bytes, per file and key path, so a routing method, a removed member, a removed preference and a line's real routing are said
  test("every key path the candidate bytes change is named by a row of the save, after and before", () => {
    const c = "consult:\n  prefer: [codex:gpt-6-astra]\n";
    const shotOf = (src: ScreenSource, st: ScreenState) => {
      const save = press(src, { ...st, view: "home" }, "s").state;
      expect(save.view).toBe("save");
      return { d: derive(src, save), shown: flat(text(src, save, 200, 200)) };
    };
    const yes = (...ids: string[]): ScreenState => ({ ...initialScreen(), yes: ids, log: ids.map((x) => `y:${x}`) });
    /** the cursor of an opened line on `t`, from its top */
    const on = (src: ScreenSource, st: ScreenState, t: string): ScreenState => {
      const ts = lineHomeTargets(src, st), i = ts.indexOf(t);
      expect(i, `${t} in ${ts.join(" | ")}`).toBeGreaterThanOrEqual(0);
      return keysFrom(src, st, ...Array<string>(ts.length).fill("up"), ...Array<string>(i).fill("down"));
    };
    /** implement opened, My order, x on `gone`, By complexity, Esc: the reviewer's keys */
    const removing = (src: ScreenSource, gone: string): ScreenState => {
      let st = press(src, on(src, open(src, "implement"), "choice:order"), "enter").state;
      st = press(src, on(src, st, `model:${gone}`), "x").state;
      st = press(src, on(src, st, "choice:complexity"), "enter").state;
      return press(src, st, "esc").state;
    };
    const cx = (rows: string) => `routing:\n  map:\n    implement:\n      pool:\n        mode: complexity\n        channels: [${rows}]\n${c}`;
    const fable = health(["claude-code:fable"]);
    const worlds: Array<[string, ScreenSource, ScreenState]> = [
      ["setup", source({ health: fable }), yes("setup")],
      ["noseat pin", source({ repoText: `routing:\n  map:\n    implement:\n      pin: { via: claude-code, model: fable }\n${c}`, health: fable }), yes("noseat")],
      ["noseat floor", source({ repoText: `routing:\n  floors:\n    implement: frontier\n${c}`, health: fable }), yes("noseat")],
      ["gone", source({ repoText: cx("codex:gpt-6-astra, nosuch:gone, claude-code:opus") }), initialScreen()],
      ["opus down", source({ repoText: cx("codex:gpt-6-astra, claude-code:opus"), health: health(["claude-code:opus"]) }), initialScreen()],
      ["opus kept out", source({ repoText: cx("codex:gpt-6-astra, claude-code:opus").replace("routing:\n", "routing:\n  deny:\n    models: [claude-code:opus]\n") }), initialScreen()],
      ["omp", source({ repoText: cx("pi:zai/glm-5.3, omp:zai/glm-5.3, codex:gpt-6-astra") }), initialScreen()],
      ["prefer", source({ repoText: `routing:\n  map:\n    implement:\n      prefer: [codex, claude-code]\n${c}` }), initialScreen()],
      ["pool floor", source({ repoText: POOL + c }), yes("floor", "complexity")],
      ["pool tidy", source({ repoText: POOL.replace("codex:gpt-5.6-terra", "nosuch:gone") + c }), yes("tidy", "complexity")],
      ["pool escalate", source({ repoText: POOL.replace("tier: null", "escalate: true") + c }), yes("complexity")],
    ];
    const drive: Record<string, (src: ScreenSource, st: ScreenState) => ScreenState> = {
      gone: (s) => removing(s, "nosuch:gone"), "opus down": (s) => removing(s, "claude-code:opus"), "opus kept out": (s) => removing(s, "claude-code:opus"),
      omp: (s) => removing(s, "omp:zai/glm-5.3"), prefer: (s) => keysFrom(s, open(s, "implement"), "enter", "o", "p", "u", "s", "enter", "esc", "esc"),
    };
    const shot: Record<string, string> = {};
    for (const [name, src, st0] of worlds) {
      for (const id of st0.yes) expect(derive(src, initialScreen()).items.map((x) => x.id), name).toContain(id);
      const x = shotOf(src, drive[name]?.(src, st0) ?? st0);
      shot[name] = x.shown;
      // bounded and general: every key path of every file Enter writes, read from the candidate bytes, is named by a row
      expect(x.d.texts, name).toBeDefined();
      const was = parsedLayers(src.inputs), now = parsedLayers(x.d.texts!);
      const paths = x.d.texts!.touched.flatMap((l) => changedPaths(was[l] ?? {}, now[l] ?? {}));
      expect(paths.length, name).toBeGreaterThan(0);
      for (const p of paths) expect(x.shown, `${name}: ${p.join(".")}\n${x.shown}`).toMatch(new RegExp(`(after|before) [^\\n]*  ${p.join(".").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( in |$)`, "m"));
    }
    // the routing method a held answer writes
    expect(shot.setup).toMatch(/after +complexity +routing\.map\.plan\.pool\.mode\n +before +nothing +routing\.map\.plan\.pool\.mode/);
    expect(shot["noseat pin"]).toMatch(/after +complexity +routing\.map\.implement\.pool\.mode/);
    expect(shot["noseat pin"]).toMatch(/after +nothing +routing\.map\.implement\.pin\.model\n +before +fable +routing\.map\.implement\.pin\.model/);
    expect(shot["noseat floor"]).toMatch(/after +complexity +routing\.map\.spec\.pool\.mode/);
    // a member removed by hand, whatever the line showed of it
    for (const [name, gone] of [["gone", "nosuch:gone"], ["opus down", "claude-code:opus"], ["opus kept out", "claude-code:opus"], ["omp", "omp:zai/glm-5.3"]]) {
      const after = shot[name].match(/after +(.*)  routing\.map\.implement\.pool\.channels/)?.[1], before = shot[name].match(/before +(.*)  routing\.map\.implement\.pool\.channels/)?.[1];
      expect(before?.split(", "), name).toContain(gone);
      expect(after?.split(", "), name).not.toContain(gone);
    }
    // a preference list replaced by a line
    expect(shot.prefer).toMatch(/after +nothing +routing\.map\.implement\.prefer\n +before +codex, claude-code +routing\.map\.implement\.prefer/);
    // the line as saved, as the one screen routes it: a model that gets no task is never said to share every task
    for (const name of ["pool floor", "pool tidy", "pool escalate"]) {
      expect(shot[name], name).not.toMatch(/share every task/);
      expect(shot[name], name).toMatch(/before +implement: \S+ does every task +no tasks: /);
    }
  });

  test("the save draws the design's rows: each change after and before; the file it is written to; who reads it; what is untouched", () => {
    const src = source({ repoText: TWO + CONSULT });
    const st = press(src, dropOpus(src), "s").state;
    expect(st.view).toBe("save");
    const shown = flat(text(src, st, 100, 30));
    expect(shown).toMatch(/YOU ARE SAVING {2}1 change +nothing is written yet/);
    expect(shown).toMatch(/ {2}1 {2}implement\n +after +in order +gpt-6-astra\n +before +gpt-6-astra did every task +backup opus/);
    expect(shown).toMatch(/WRITTEN TO +this project's settings: \/r\/\.tickmarkr\/config\.yaml/);
    expect(shown).toContain("read by this project only");
    expect(shown).toMatch(/UNTOUCHED +every other line, KEPT OUT, judge, review, consult, mode/);
    expect(shown).toMatch(/Enter save · d show the file lines · Esc back, nothing written$/);
    // UNTOUCHED is read from the candidate bytes: the consult reordered leaves it off the list
    const consult = keysFrom(src, open(src, "consult", { ...st, view: "home" }), "]", "esc");
    const both = flat(text(src, press(src, { ...consult, view: "home" }, "s").state, 100, 40));
    expect(both).toMatch(/2 {2}consult\n +after +claude-code:opus, codex:gpt-6-astra +consult\.prefer\n +before +codex:gpt-6-astra, claude-code:opus/);
    expect(both).toMatch(/UNTOUCHED +every other line, KEPT OUT, judge, review, mode\n/);
    // Esc goes back and writes nothing
    expect(press(src, st, "esc")).toEqual({ state: expect.objectContaining({ view: "home" }) });
  });

  test("a change held in the project's settings says this project only; one in the user's says every project that has no line of its own", () => {
    const repo = source({ repoText: TWO });
    const inRepo = flat(text(repo, press(repo, dropOpus(repo), "s").state, 100, 30));
    expect(inRepo).toMatch(/this project's settings: \/r\/\.tickmarkr\/config\.yaml\n +read by this project only/);
    expect(inRepo).not.toContain("your settings");
    const user = source({ userText: TWO });
    const inUser = flat(text(user, press(user, dropOpus(user), "s").state, 100, 30));
    expect(inUser).toMatch(/your settings: \/u\/config\.yaml\n +read by every project with no implement line of its own; r has none/);
    expect(inUser).not.toContain("this project only");
  });

  test("d shows the file lines beside their numbers and returns; a measure that moves the wrong way is listed before the save", () => {
    const src = source({ repoText: TWO });
    const st = press(src, dropOpus(src), "s").state;
    // one model left on implement: fewer than two models at its bar, said before the save, with `bar` for floor
    const save = flat(text(src, st, 100, 30));
    expect(save).toMatch(/THIS ALSO CHANGES\n +shapes with fewer than two models at their bar +0 → 1 +worse/);
    expect(save).not.toMatch(/\bfloor\b/);
    const lines = press(src, st, "d").state;
    const shown = flat(text(src, lines, 100, 30));
    expect(shown).toContain("TO BE SAVED IN /r/.tickmarkr/config.yaml");
    expect(shown).toMatch(/^ 6 +- +channels: \[codex:gpt-6-astra, claude-code:opus\]$/m);
    expect(shown).toMatch(/^ +\+ +channels: \[codex:gpt-6-astra\]$/m);
    expect(shown).toMatch(/Enter save · d back to the save · Esc back, nothing written$/);
    expect(press(src, lines, "d").state).toMatchObject({ view: "save", lines: false });
    expect(flat(text(src, press(src, lines, "d").state, 100, 30))).toBe(save);
    // a change that moves no measure the wrong way draws no such block
    const fine = source({ repoText: CONSULT });
    const reorder = keysFrom(fine, open(fine, "consult"), "]", "esc", "s");
    expect(reorder.view).toBe("save");
    expect(flat(text(fine, reorder, 100, 30))).not.toContain("THIS ALSO CHANGES");
  });

  test("both config files keep their bytes after every key of every view until the save's Enter", async () => {
    const repoText = `routing:\n  deny:\n    adapters: [agy]\n  map:\n    implement:\n      pool:\n        mode: ordered\n        channels: [codex:gpt-6-astra, claude-code:opus]\n`;
    const w = setup({ repo: repoText });
    const userText = "# saved user settings\n";
    writeFileSync(join(w.globalDir, "config.yaml"), userText);
    const bytes = () => [join(w.cwd, ".tickmarkr", "config.yaml"), join(w.globalDir, "config.yaml")].map((p) => (existsSync(p) ? readFileSync(p, "utf8") : null));
    const src = loadFleetSource(w.cwd, { globalDir: w.globalDir, adapters });
    const item = derive(src, initialScreen()).items[0];
    const t = terminal();
    const done = w.run([], { input: t.input as never, output: t.output as never });
    await t.frame("NEEDS YOU");
    let checked = 0;
    // every key, one at a time, each its own chunk: after each one both files hold the bytes they had; the last
    // key of a step waits for its frame
    const step = async (keys: string, marker: string) => {
      const each = keys.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g)!;
      for (const [i, k] of each.entries()) {
        const next = i === each.length - 1 ? t.frame(marker) : new Promise((r) => setTimeout(r, 15));
        t.burst(k);
        await next;
        expect(bytes(), `${JSON.stringify(k)} of ${JSON.stringify(keys)} → ${marker}`).toEqual([repoText, userText]);
        checked++;
      }
      total += each.length;
    };
    let total = 0;
    const top = "\x1b[A".repeat(60), to = (is: (id: string) => boolean) => top + arrowsTo(src, is);
    await step("?", "this help");
    await step("\x1b", "Enter change the line");
    await step(`${to((id) => id.startsWith("shapes:") && id.slice(7).split(",").includes("implement"))}\r`, "How are the tasks given out?");
    await step("\x1b[B\x1b[B\x1b[Bx", "My order");
    await step("\x1b", "Enter change the line");
    await step(`${to((id) => id === "kept:routing.deny.adapters")}\r`, "x remove this rule");
    await step("\x1b", "Enter change the line");
    await step(`${to((id) => id === "kept+")}\r`, "keep it out");
    await step("x", "keep it out");
    await step("\x1b", "keep it out");
    await step("\x1b", "Enter change the line");
    await step(`${to((id) => id === `item:${item.id}`)}\r`, item.title.slice(0, 30));
    await step("\x1b", "Enter change the line");
    await step("s", "YOU ARE SAVING");
    await step("\x1b[B", "YOU ARE SAVING");
    await step("d", "TO BE SAVED IN");
    await step("d", "YOU ARE SAVING");
    await step("\x1b", "Enter change the line");
    await step("s", "YOU ARE SAVING");
    // the save's Enter is the one write
    const saved = t.frame("Saved to .tickmarkr/config.yaml.");
    t.input.write("\r");
    await saved;
    const [repoAfter, userAfter] = bytes();
    expect(repoAfter).not.toBe(repoText);
    expect(repoAfter).toContain("channels: [codex:gpt-6-astra]");
    expect(userAfter).toBe(userText);
    t.input.write("q");
    expect(await done).toBe("fleet: saved .tickmarkr/config.yaml");
    expect(checked).toBe(total);
    expect(checked).toBeGreaterThan(40);
  }, 60_000);
});
