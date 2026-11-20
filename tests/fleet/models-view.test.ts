// Allowing a model (queue row 498; D-2187 add.348, add.363; contract 5.5, design LineA-models): the CLIs on
// the left, that CLI's models with their facts and one state word on the right, type to search, and its level.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ModelFacts } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { width } from "../../src/fleet/draw.js";
import { loadFleetSource } from "../../src/fleet/load.js";
import { levelEvidence, modelColumns, modelsKey, modelsParts, STATE_WORDS, usesOf } from "../../src/fleet/models-view.js";
import { derive, frame, initialScreen, lineHomeTargets, press, type ScreenSource, type ScreenState } from "../../src/fleet/screen.js";
import { keysFrom, open } from "./drive.js";
import { adapters, health, NOW, source } from "./world.js";

const Q = "omp:alibaba/qwen3.8-max", CARBON = "omp:google/gemini-4-carbon", IRON = "omp:google/gemini-4-iron", AG = "omp:google-antigravity/gemini-3-pro";
const FACTS: Record<string, Partial<ModelFacts>> = {
  "google/gemini-4-carbon": { score: 60, priceIn: 2, priceOut: 10, speed: 94, name: "Gemini 4 Carbon" }, "alibaba/qwen3.8-max": { score: 55, priceIn: 0, priceOut: 0 },
  "zai/glm-5.3": { score: 52 }, "google/gemini-4-argon": { score: 50.4, priceIn: 2, priceOut: 10, speed: 88 }, "google/gemini-4-iron": { score: 45 },
  "google/gemini-3.8-flash": { score: 30.8, priceIn: 0.75, priceOut: 3.75, speed: 127 },
};
function world(extra: string[] = [], tail = "", facts: Record<string, Partial<ModelFacts>> = {}, allow = `${Q}, omp:zai/glm-5.3, omp:google/gemini-4-argon, codex:gpt-6-astra`): ScreenSource {
  const h = health(["omp:zai/glm-5.3"], { omp: ["google/gemini-4-carbon", "google/gemini-4-argon", "google/gemini-4-iron", "google-antigravity/gemini-3-pro", ...extra] });
  h.omp = { ...h.omp, modelFacts: Object.fromEntries(Object.entries({ ...FACTS, ...facts }).map(([m, f]) => [m, { as: m, ...f }])) };
  const repoText = `tiers:\n  omp:\n    models:\n      google/gemini-4-argon: frontier\n      google/gemini-4-iron: frontier\nrouting:\n  mode: partner-led\n`
    + `  allow:\n    models: [${allow}]\n  deny:\n    models: [${AG}]\n`
    + `  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n` + tail;
  return source({ repoText, health: h });
}
const text = (src: ScreenSource, st: ScreenState, cols = 120, rows = 40) => frame(src, st, cols, rows).map((l) => l.map((s) => s.text).join("").trimEnd());
/** The implement line opened and its + allow a model pressed. */
function models(src: ScreenSource, from?: ScreenState): ScreenState {
  const st = open(src, "implement", from), ts = lineHomeTargets(src, st);
  return press(src, keysFrom(src, st, ...Array<string>(ts.indexOf("add")).fill("down")), "enter").state;
}
/** The cursor on `key`: right to its CLI, down to its row. */
function on(src: ScreenSource, st: ScreenState, key: string): ScreenState {
  const cols = modelColumns(derive(src, st).base!, "implement", st.line!.chosen), ci = cols.findIndex((c) => c.rows.some((r) => r.key === key));
  const st0 = { ...st, models: { ...st.models!, cli: 0, at: 0, key: undefined } };
  return keysFrom(src, st0, ...Array<string>(ci).fill("right"), ...Array<string>(cols[ci].rows.findIndex((r) => r.key === key)).fill("down"));
}

/**
 * Every row the view reaches at a size, PgDn pressed until it stops, each put back at its place: while the columns stay put
 * only the foot (the note, the detail and the legend) scrolls; when they move too, the columns and the foot are one page.
 * As one string, the right column alone where the columns are drawn, whitespace gone.
 */
function seen(src: ScreenSource, st: ScreenState, cols: number, rows: number): string {
  const frames: Array<{ at: number; now: string[] }> = [];
  for (let i = 0, prev = -1; i < 80; i++) {
    const now = text(src, st, cols, rows), at = st.models?.foot ?? 0;
    expect(now, `${cols}x${rows}`).toHaveLength(rows);
    if (at === prev) break;
    frames.push({ at, now });
    prev = at;
    st = press(src, st, "pgdown", { cols, rows }).state;
  }
  const cut = (r: string) => (r.includes("│") ? r.slice(r.indexOf("│") + 1) : r);
  const body = (now: string[]) => now.filter((r) => r.includes("│")).join("\n");
  const one = frames.some((f) => body(f.now) !== body(frames[0].now)), head = frames[0].now.findIndex((r) => r.includes("│"));
  const f0 = frames[0].now, out = f0.slice(0, one ? head : f0.reduce((n, r, k) => (r.includes("│") ? k : n), 0) + 1).map(cut);
  const foot: string[] = [];
  for (const { at, now } of frames) {
    const keys = now.findIndex((r, k) => k >= head && r.startsWith("↑↓")), last = now.reduce((n, r, k) => (r.includes("│") ? k : n), 0);
    now.slice(one ? head : last + 2, keys).forEach((r, k) => { foot[at + k] = cut(r); });
  }
  return [...out, ...foot].join("").replace(/\s+/gu, "");
}
const flat = (t: string) => t.replace(/\s+/gu, "");
const LEGEND = ["● answers   ○ does not answer; its row says why   ✕ kept out",
  "score = Artificial Analysis Intelligence · price = list price in US dollars per million tokens, in / out (models.dev, else Artificial Analysis) · tok/s = output tokens per second"];

describe("allowing a model", () => {
  test("the view draws the design's rows; each model row ends in its state word, in the closed order", () => {
    const src = world(), st = on(src, models(src), Q);
    expect(st.view).toBe("models");
    const shown = text(src, st, 160);
    expect(shown[0]).toMatch(/^implement · allow a model\s+type to search$/);
    expect(shown.some((r) => /^CLIS\s+│\s+omp · models of several vendors · sign-in: subscription$/.test(r))).toBe(true);
    expect(shown.some((r) => /│\s+MODEL\s+LEVEL\s+SCORE\s+\$ IN \/ OUT\s+TOK\/S$/.test(r))).toBe(true);
    expect(shown.some((r) => /^ ● claude-code\s+\d/.test(r))).toBe(true);
    expect(shown).toContain("● answers   ○ does not answer; its row says why   ✕ kept out");
    expect(text(src, st, 200).join("\n")).toContain("score = Artificial Analysis Intelligence · price = list price in US dollars per million tokens, in / out (models.dev, else Artificial Analysis) · tok/s = output tokens per second");
    expect(shown.at(-1)).toBe("↑↓ model · ←→ CLI · Enter allow it for implement · Tab change its level · Esc back");
    // strongest first, unscored last; each row ends in ONE state word, the first of the closed list that applies
    const rows = shown.filter((r) => /│  [▸ ] (alibaba|google|zai)/.test(r));
    const want = [["google/gemini-4-carbon", "no level yet"], ["alibaba/qwen3.8-max", "on this line"], ["zai/glm-5.3", "does not answer: no answer"],
      ["google/gemini-4-argon", "can be used"], ["google/gemini-4-iron", "not allowed yet"], ["google/gemini-3.8-flash", "below the bar"], ["google-antigravity/gemini-3-pro", "kept out · your guard"]];
    expect(rows.map((r) => want.find(([m]) => r.includes(` ${m} `))?.[0])).toEqual(want.map(([m]) => m));
    rows.forEach((r, i) => expect(r.endsWith(want[i][1]), r).toBe(true));
    expect(rows[0]).toMatch(/google\/gemini-4-carbon\s+—\s+60\.0\s+2 \/ 10\s+94\s+no level yet$/);
    // a list price of zero is shown as recorded, never "free"
    expect(rows[1]).toMatch(/55\.0\s+0 \/ 0\s+—\s+on this line$/);
    // the closed order: flash is below the bar AND not allowed yet, antigravity kept out AND has no level: the first applies
    expect(STATE_WORDS).toEqual(["kept out · your guard", "no level yet", "does not answer", "below the bar", "not allowed yet", "on this line", "can be used"]);
    expect(shown.some((r) => r.includes("qwen3.8-max · answers, checked 1 day ago · on implement"))).toBe(true);
    // the left column: whether each CLI answers and how many of its models this line can use; omp: qwen and argon
    expect(shown.some((r) => /^▸● omp\s+2\s+│/.test(r))).toBe(true);
  });

  test("typing filters the models of every CLI; a name containing t stages nothing; Backspace and Esc undo the search", () => {
    const src = world(), st = models(src);
    const typed = keysFrom(src, st, ..."gpt-6-astra");
    expect(typed).toMatchObject({ view: "models", hand: st.hand, line: st.line, models: { query: "gpt-6-astra" } });
    const M = derive(src, st).base!;
    expect(modelColumns(M, "implement", [Q], "gpt-6-astra").flatMap((c) => c.rows.map((r) => r.key))).toEqual(["codex:gpt-6-astra"]);
    const shown = text(src, typed);
    expect(shown[0]).toContain("search: gpt-6-astra");
    // the counts follow the search: omp has none left, codex one
    expect(shown.some((r) => /omp\s+0\s+│/.test(r))).toBe(true);
    expect(shown.some((r) => /codex\s+1\s+│/.test(r))).toBe(true);
    // k, j, t and x are letters here: they search, they move nothing and stage nothing
    const letters = keysFrom(src, st, "k", "j", "t", "x");
    expect(letters).toMatchObject({ view: "models", hand: [], log: [], line: st.line, models: { query: "kjtx", at: 0, cli: 0 } });
    expect(keysFrom(src, typed, "backspace").models!.query).toBe("gpt-6-astr");
    const cleared = press(src, typed, "esc").state;
    expect(cleared).toMatchObject({ view: "models", models: { query: "" } });
    expect(press(src, cleared, "esc").state).toMatchObject({ view: "line", models: null, line: { chosen: [Q] } });
  });

  test("Enter allows a model as part of the line's pending change; one not allowed yet is allowed in the same save by name", () => {
    const src = world(), before = { ...src.inputs };
    let st = on(src, models(src), IRON);
    expect(text(src, st).join("\n")).toContain("Enter allows it for implement and adds it to the models your settings allow");
    st = press(src, st, "enter").state;
    expect(st).toMatchObject({ view: "line", models: null, line: { chosen: [Q, IRON], allows: [IRON] } });
    expect(st.msg).toContain(`also allows ${IRON}`);
    const home = press(src, st, "esc").state;
    expect(home.hand).toEqual([{ line: "implement", chosen: [Q, IRON], mode: "ordered", allows: [IRON] }]);
    const edits = derive(src, home).hand.map((e) => [e.path.join("."), e.value]);
    expect(edits).toContainEqual(["routing.map.implement", { pool: { mode: "ordered", channels: [Q, IRON] } }]);
    // that model alone, never a whole CLI
    expect(edits).toContainEqual(["routing.allow.models", [Q, "omp:zai/glm-5.3", "omp:google/gemini-4-argon", "codex:gpt-6-astra", IRON]]);
    const shown = text(src, home, 120, 60).join("\n");
    expect(shown).toMatch(/also allows\s+omp:google\/gemini-4-iron\s+routing\.allow\.models/);
    expect(derive(src, home).texts!.repoText).toContain(IRON);
    // removed again before the save: the allow goes with it
    const re = open(src, "implement", home), ts = lineHomeTargets(src, re);
    const gone = press(src, press(src, keysFrom(src, re, ...Array<string>(ts.indexOf(`model:${IRON}`)).fill("down")), "x").state, "esc").state;
    expect(gone.hand).toEqual([]);
    expect(derive(src, gone).hand).toEqual([]);
    expect(src.inputs).toEqual(before);
  });

  test("Enter refuses a model a rule keeps out; it refuses one below the bar: each by its reason", () => {
    const src = world(), st = models(src);
    const kept = press(src, on(src, st, AG), "enter").state;
    expect(kept).toMatchObject({ view: "models", hand: [], line: { chosen: [Q] } });
    expect(kept.msg).toBe(`${AG} is kept out by the rule ${AG}. Nothing was added: a rule is removed only from its own line of KEPT OUT.`);
    expect(derive(src, kept).hand).toEqual([]);
    const below = press(src, on(src, st, "omp:google/gemini-3.8-flash"), "enter").state;
    expect(below).toMatchObject({ view: "models", hand: [], line: { chosen: [Q] } });
    expect(below.msg).toBe("omp:google/gemini-3.8-flash is mid, below the bar for implement: frontier. Nothing was added.");
  });

  test("Tab gives a model the config has not named a level; it shows the evidence; the model can be allowed in the same sitting", () => {
    const src = world();
    let st = on(src, models(src), CARBON);
    expect(press(src, st, "enter").state.msg).toContain("has no level yet: Tab gives it one");
    st = press(src, st, "tab").state;
    expect(st.hand).toEqual([{ line: `tier:${CARBON}`, chosen: ["frontier"] }]);
    const shown = text(src, st, 200).join("\n");
    expect(shown).toMatch(/google\/gemini-4-carbon\s+frontier\s+60\.0.*not allowed yet/);
    // the evidence: its score, the best the config uses, the share against the 2.26 bands, one benchmark of two
    expect(shown).toContain("It scores 60.0; the best model your settings use scores 60.0; 1.00 of it reads frontier against the bands 0.90 and 0.75.");
    expect(shown).toContain("This rests on one benchmark of two.");
    // round the levels and back to none, then frontier again
    expect(keysFrom(src, st, "tab", "tab", "tab").hand).toEqual([]);
    st = press(src, st, "enter").state;
    expect(st).toMatchObject({ view: "line", line: { chosen: [Q, CARBON], allows: [CARBON] } });
    const home = press(src, st, "esc").state, edits = derive(src, home).hand.map((e) => [e.path.join("."), e.value]);
    expect(edits).toContainEqual(["tiers.omp.models.google/gemini-4-carbon", "frontier"]);
    expect(edits).toContainEqual(["routing.map.implement", { pool: { mode: "ordered", channels: [Q, CARBON] } }]);
    expect(edits.find(([p]) => p === "routing.allow.models")?.[1]).toContain(CARBON);
    expect(derive(src, home).refused).toBeUndefined();
    expect(text(src, home, 120, 60).join("\n")).toMatch(/level\s+omp:google\/gemini-4-carbon frontier\s+tiers\.omp\.models\.google\/gemini-4-carbon/);
  });

  // the review of ff05cf9a (row 498; D-2187 add.363): each finding's consequence through press and frame
  test("q searches in the models view and never quits; the detail and its evidence stay in view however far the list scrolls", () => {
    const src = world(), st = models(src);
    expect(press(src, st, "q").action).toBeUndefined();
    expect(keysFrom(src, st, ..."qwen").models!.query).toBe("qwen");
    const many = world(Array.from({ length: 30 }, (_, i) => `review/model-${String(i).padStart(2, "0")}`));
    for (const n of ["00", "29"]) {
      const at = press(many, on(many, models(many), `omp:review/model-${n}`), "tab").state, shown = text(many, at, 120, 24).join("\n");
      expect(shown).toContain(`▸ review/model-${n}`);
      expect(shown).toContain(`model-${n} · answers, checked 1 day ago · not in your team yet`);
      expect(shown).toContain("This rests on one benchmark of two.");
    }
  });

  test("an allowance two lines share stays in the save when one line drops the model", () => {
    const src = world(), plan = (st: ScreenState) => open(src, "plan", st);
    let home = press(src, press(src, on(src, models(src), IRON), "enter").state, "esc").state;
    const p = plan(home), ts = lineHomeTargets(src, p);
    const pm = press(src, keysFrom(src, p, ...Array<string>(ts.indexOf("add")).fill("down")), "enter").state;
    expect(pm.view).toBe("models");
    const cols = modelColumns(derive(src, pm).base!, "plan", pm.line!.chosen), ci = cols.findIndex((c) => c.rows.some((r) => r.key === IRON));
    home = press(src, press(src, keysFrom(src, { ...pm, models: { ...pm.models!, cli: 0, at: 0 } }, ...Array<string>(ci).fill("right"),
      ...Array<string>(cols[ci].rows.findIndex((r) => r.key === IRON)).fill("down")), "enter").state, "esc").state;
    expect(home.hand.find((c) => c.line === "plan")?.allows).toEqual([IRON]);
    const re = open(src, "implement", home), rt = lineHomeTargets(src, re);
    const gone = press(src, press(src, keysFrom(src, re, ...Array<string>(rt.indexOf(`model:${IRON}`)).fill("down")), "x").state, "esc").state;
    expect(gone.hand.map((c) => c.line)).toEqual(["plan"]);
    const allow = derive(src, gone).hand.find((e) => e.path.join(".") === "routing.allow.models");
    expect(allow?.value).toContain(IRON);
  });

  // the review of T11 (row 498; D-2187 add.408): each finding's consequence through press, derive and frame
  test("a model counts as usable only in the worker pool after discovery: probe, servable and validated lists, hidden models, unverified", () => {
    const A = "codex:gpt-6-astra", base = health();
    const NOW_ISO = "2026-11-10T00:00:00Z";
    const cases: Array<[string, Record<string, unknown> | null, boolean, string]> = [
      ["probed and served", base, false, "can be used"],
      ["servable empty", { ...base, codex: { ...base.codex, servable: [] } }, false, "does not answer: codex does not offer it"],
      ["validated list without it", { ...base, codex: { ...base.codex, models: base.codex.models!.filter((m) => m !== "gpt-6-astra"), modelsDetectedAt: NOW_ISO } }, false, "does not answer: codex does not offer it"],
      ["hidden", { ...base, codex: { ...base.codex, models: base.codex.models!.filter((m) => m !== "gpt-6-astra"), modelsHidden: ["gpt-6-astra"] } }, false, "does not answer: codex does not offer it"],
      ["no probe at all, unverified routed", null, true, "does not answer: not checked yet"],
      ["no codex record, unverified routed", Object.fromEntries(Object.entries(base).filter(([k]) => k !== "codex")), true, "does not answer: not checked yet"],
      ["never probed, unverified not routed", { ...base, codex: { ...base.codex, modelAuth: {} } }, false, "does not answer: not checked yet"],
      ["never probed, unverified routed", { ...base, codex: { ...base.codex, modelAuth: {} } }, true, "can be used"],
    ];
    for (const [name, h, unverified, word] of cases) {
      const src = source({ repoText: `routing:\n  allowUnverifiedModels: ${unverified}\n`, health: h as never }), M = derive(src, initialScreen()).base!;
      const codex = modelColumns(M, "implement", []).find((c) => c.id === "codex")!, row = codex.rows.find((r) => r.key === A)!;
      expect(row.state, name).toBe(word);
      // the count is the rows that are on this line or can be used, and each of those is in the worker pool
      const counted = codex.rows.filter((r) => r.state === "can be used" || r.state === "on this line");
      expect(codex.count, name).toBe(counted.length);
      for (const r of counted) expect(M.pools.worker.some((c) => `${c.adapter}:${c.model}` === r.key), `${name} ${r.key}`).toBe(true);
      if (word !== "can be used") expect(counted.map((r) => r.key), name).not.toContain(A);
    }
  });

  test("a model already on the line that the allow list lacks: Enter stages its allowance; a saved deny does not stand in for it", () => {
    const A = "codex:gpt-6-astra";
    // implement already names it; the allow list does not
    const src = world([], "", {}, Q).inputs;
    const named = source({ ...src, repoText: src.repoText.replace(`channels: [${Q}]`, `channels: [${Q}, ${A}]`) });
    let st = on(named, models(named), A);
    expect(text(named, st, 160).join("\n")).toContain(`routing.allow.models: ${A}`);
    st = press(named, st, "enter").state;
    expect(st).toMatchObject({ view: "line", line: { chosen: [Q, A], allows: [A] } });
    const home = press(named, st, "esc").state;
    expect(derive(named, home).hand.find((e) => e.path.join(".") === "routing.allow.models")?.value).toEqual([Q, A]);
    // a saved deny of the same model, removed in KEPT OUT, then the model added: the allowance is staged all the same
    const denied = source({ ...src, repoText: src.repoText.replace(`models: [${AG}]`, `models: [${AG}, ${A}]`) });
    const freed: ScreenState = { ...initialScreen(), hand: [{ line: "deny.models", chosen: [AG] }], log: ["h:deny.models"] };
    const added = press(denied, press(denied, on(denied, models(denied, freed), A), "enter").state, "esc").state;
    expect(added.hand.find((c) => c.line === "implement")?.allows).toEqual([A]);
    expect(derive(denied, added).hand.find((e) => e.path.join(".") === "routing.allow.models")?.value).toEqual([Q, A]);
  });

  test("after Tab the same model stays selected whatever the re-sort: its evidence shows and Enter allows it", () => {
    const tie = world(["review/a", "review/b"], "", { "review/a": { score: 60 }, "review/b": { score: 60 } });
    let st = press(tie, on(tie, models(tie), "omp:review/b"), "tab").state;
    expect(text(tie, st, 200).join("\n")).toMatch(/▸ review\/b /);
    expect(text(tie, st, 200).join("\n")).toContain("This rests on one benchmark of two.");
    st = press(tie, st, "enter").state;
    expect(st.line!.chosen).toEqual([Q, "omp:review/b"]);
    const ids = Array.from({ length: 30 }, (_, i) => `review/model-${String(i).padStart(2, "0")}`);
    const many = world(ids, "", Object.fromEntries(ids.map((m) => [m, { score: 40 }])));
    const last = press(many, on(many, models(many), "omp:review/model-29"), "tab").state;
    expect(text(many, last, 200).join("\n")).toMatch(/▸ review\/model-29 /);
    expect(press(many, last, "enter").state.line!.chosen).toEqual([Q, "omp:review/model-29"]);
  });

  test("at 80 by 20 and larger the headers, the CLI column and the selected model's facts down to its state word stay in view; every row is reached", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `review/model-${String(i).padStart(2, "0")}`);
    const many = world(ids, "", Object.fromEntries(ids.map((m, i) => [m, { score: 40 - i / 10, priceIn: 2, priceOut: 10, speed: 94 }])));
    for (const [cols, rows] of [[80, 20], [120, 24]]) {
      const st = press(many, on(many, models(many), "omp:review/model-29"), "tab").state;
      const shown = text(many, st, cols, rows), all = shown.join("\n");
      expect(shown, `${cols}x${rows}`).toHaveLength(rows);
      expect(shown[0]).toContain("implement · allow a model");
      expect(all).toMatch(/CLIS\s+│\s+omp · models of several vendors/);
      expect(all).toMatch(/● claude-code/);
      expect(all).toMatch(/MODEL\s+LEVEL/);
      // the selected row whole: its name, level, score, price, speed and state word
      const at = shown.findIndex((r) => r.includes("▸ review/model-29")), row = shown.slice(at, at + 3).map((r) => r.split("│")[1] ?? "").join(" ");
      expect(at, `${cols}x${rows}`).toBeGreaterThan(0);
      expect(row).toMatch(/frontier\s+37\.1\s+2 \/ 10\s+94\s+not allowed yet/);
      expect(shown.slice(-2).join(" ")).toMatch(/Esc\s+back$/);
      // every row of omp is reached with the arrows, each drawn with the cursor on it
      let walk: ScreenState = { ...st, models: { ...st.models!, at: 0, key: undefined } };
      const omp = modelColumns(derive(many, walk).base!, "implement", walk.line!.chosen).find((c) => c.id === "omp")!;
      for (const r of omp.rows) {
        expect(text(many, walk, cols, rows).some((l) => l.includes(`▸ ${r.model} `)), `${r.model} ${cols}x${rows}`).toBe(true);
        walk = press(many, walk, "down", { cols, rows }).state;
      }
    }
  });

  test("the detail names every use the config gives the model: a line, the judge, review and consult", () => {
    const A = "codex:gpt-6-astra";
    const src = world([], `    plan:\n      prefer: [${A}]\njudge:\n  adapter: codex\n  model: gpt-6-astra\nreview:\n  prefer: [${A}]\nconsult:\n  adapter: claude-code\n  model: claude-opus-5-5\n  prefer: [${A}]\n`);
    const st = models(src);
    expect(usesOf(derive(src, st).base!, A)).toEqual(["plan", "judge", "review", "consult"]);
    expect(text(src, on(src, st, A), 160).join("\n")).toContain("on plan, judge, review, consult");
  });

  // the review of T11, second round (row 498; D-2187 add.408): every text wrapped, never cut; what is longer than its room scrolls

  test("at 80 by 20 a long model id, a long search and a long refusal are wrapped, never cut: the header, the evidence, the legend and the note are all reached", () => {
    for (const n of [0, 60, 80, 100, 120, 160]) {
      const id = n ? `google/${"m".repeat(n - 7)}` : "google/gemini-4-carbon", K = `omp:${id}`;
      const src = world(n ? [id] : [], "", { [id]: { score: 60, priceIn: 2, priceOut: 10, speed: 94 } });
      for (const [cols, rows] of [[80, 20], [120, 24]]) {
        const st = press(src, on(src, models(src), K), "tab").state, all = seen(src, st, cols, rows), where = `${n} ${cols}x${rows}`;
        expect(st.hand, where).toEqual([{ line: `tier:${K}`, chosen: ["frontier"] }]);
        expect(text(src, st, cols, rows).join("\n"), where).toMatch(/MODEL\s+LEVEL\s+SCORE\s+\$ IN \/ OUT[\s│]+TOK\/S/u);
        const row = modelColumns(derive(src, st).full!, "implement", [Q]).flatMap((c) => c.rows).find((r) => r.key === K)!;
        for (const t of [`${K}: level frontier, not saved yet.`, levelEvidence(derive(src, st).full!, row), ...LEGEND,
          `Enter allows it for implement and adds it to the models your settings allow (routing.allow.models: ${K}).`]) expect(all, `${where}: ${t}`).toContain(flat(t));
        expect(text(src, st, cols, rows).at(-1), where).toMatch(/Esc back$/u);
      }
      // a model kept out by its full key: the refusal is whole
      const denied = source({ ...src.inputs, repoText: src.inputs.repoText.replace(`models: [${AG}]`, `models: [${AG}, ${K}]`) });
      const refused = press(denied, on(denied, models(denied), K), "enter").state;
      expect(refused.msg).toContain("Nothing was added");
      expect(seen(denied, refused, 80, 20), `${n} refused`).toContain(flat(refused.msg));
    }
    const src = world(), q = "google/gemini-4-carbon-preview-experimental-reasoning-2026", st = keysFrom(src, models(src), ...q);
    const first = modelColumns(derive(src, st).base!, "implement", [Q])[0].id, all = seen(src, st, 80, 20);
    expect(all).toContain(flat(`search: ${q}`));
    expect(all).toContain(flat(`no model of ${first} has the search in its id`));
  });

  test("Tab announces a level only when the config it makes validates: an unnamed model of a CLI of several vendors gets its vendor; a refusal is said and stages nothing", () => {
    const codex = Object.keys(DEFAULT_CONFIG.tiers.codex.models).map((m) => `      ${m}: { vendor: openai }`).join("\n");
    const mk = (model: string) => {
      const h = health([], { codex: [model] });
      return source({ repoText: `tiers:\n  codex:\n    vendor: null\n    modelOverrides:\n${codex}\nrouting:\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`, health: h });
    };
    const src = mk("gpt-review-new"), K = "codex:gpt-review-new";
    let st = press(src, on(src, models(src), K), "tab").state;
    expect(st.msg).toBe(`${K}: level frontier, not saved yet.`);
    expect(derive(src, st).refused).toBeUndefined();
    expect(derive(src, st).hand.map((e) => [e.path.join("."), e.value])).toEqual([["tiers.codex.models.gpt-review-new", "frontier"], ["tiers.codex.modelOverrides.gpt-review-new.vendor", "openai"]]);
    st = press(src, st, "enter").state;
    expect(st).toMatchObject({ view: "line", line: { chosen: expect.arrayContaining([K]) } });
    expect(derive(src, press(src, st, "esc").state).refused).toBeUndefined();
    // an id that names no vendor: the config would be refused, so nothing is staged and the view says why
    const odd = mk("mystery-x"), M = "codex:mystery-x", o = on(odd, models(odd), M), refused = press(odd, o, "tab").state;
    expect(refused.hand).toEqual([]);
    expect(refused).toMatchObject({ view: "models", models: { key: M } });
    expect(refused.msg).toMatch(/^Nothing was changed: the level would make a config tickmarkr refuses: .*vendor/u);
    expect(refused.msg).not.toContain("not saved yet");
  });

  test("a CLI the settings removed: Tab gives its model a level and puts the CLI back with that model alone; Enter allows it in the same sitting", () => {
    const src = source({ repoText: `tiers:\n  codex: null\nrouting:\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`,
      health: health([], { codex: ["gpt-review-new"] }) });
    const K = "codex:gpt-review-new", st = on(src, models(src), K);
    expect(press(src, st, "enter").state.msg).toBe(`${K} has no level yet: Tab gives it one, then Enter allows it.`);
    let t = press(src, st, "tab", { cols: 80, rows: 20 }).state;
    expect(t.msg).toBe(`${K}: level frontier, not saved yet.`);
    expect(t.hand).toEqual([{ line: `tier:${K}`, chosen: ["frontier"] }]);
    expect(derive(src, t).refused).toBeUndefined();
    // the CLI's other models stay out of the settings: nothing but this model comes back
    expect(Object.keys(derive(src, t).full!.cfg.tiers.codex.models)).toEqual(["gpt-review-new"]);
    t = press(src, t, "enter", { cols: 80, rows: 20 }).state;
    // no allow list here, so nothing more to allow
    expect(t.msg).toBe(`${K} added to implement. Esc keeps the line as a pending change.`);
    expect(t).toMatchObject({ view: "line", line: { chosen: [Q, K] } });
    const home = press(src, t, "esc").state;
    expect(derive(src, home).refused).toBeUndefined();
    expect(derive(src, home).full!.cfg.routing.map.implement.pool?.channels).toEqual([Q, K]);
  });

  test("an alias the probe resolved to an identity: Tab reads the vendor from that identity", () => {
    const codex = Object.keys(DEFAULT_CONFIG.tiers.codex.models).map((m) => `      ${m}: { vendor: openai }`).join("\n");
    const h = health([], { codex: ["new-alias"] }) as Record<string, { modelAuth?: Record<string, unknown> }>;
    h.codex.modelAuth = { ...h.codex.modelAuth, "new-alias": { ...(h.codex.modelAuth?.["gpt-6-astra"] as object), identity: "gpt-review-new" } };
    const src = source({ repoText: `tiers:\n  codex:\n    vendor: null\n    modelOverrides:\n${codex}\nrouting:\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`, health: h as never });
    const K = "codex:new-alias", t = press(src, on(src, models(src), K), "tab", { cols: 80, rows: 20 }).state;
    expect(t.msg).toBe(`${K}: level frontier, not saved yet.`);
    expect(derive(src, t).hand.map((e) => [e.path.join("."), e.value])).toContainEqual(["tiers.codex.modelOverrides.new-alias.vendor", "openai"]);
  });

  // the review of T11, third round (row 498; D-2187 add.408): what overflows never takes the cursor, the header or a sentence's end
  /** The selected row as drawn: the cursor and the model's beginning on one row, the header above it. */
  function selectedShown(src: ScreenSource, st: ScreenState, model: string, cols = 80, rows = 20): void {
    const shown = text(src, st, cols, rows), at = shown.findIndex((r) => r.includes(`▸ ${model.slice(0, 20)}`));
    expect(at, shown.join("\n")).toBeGreaterThan(0);
    expect(shown.slice(0, at).join("\n")).toMatch(/MODEL\s+LEVEL\s+SCORE/u);
    expect(shown.every((r) => width(r) <= cols)).toBe(true);
  }
  test("a model id of any length, a long search or a long CLI name never hides the selected row's cursor, the header or a sentence's end", () => {
    for (const n of [160, 200, 240, 280, 320, 400]) {
      const id = `google/${"m".repeat(n - 7)}`, K = `omp:${id}`, f = { [id]: { score: 60, priceIn: 2, priceOut: 10, speed: 94 } };
      const src = world([id], "", f), t = press(src, on(src, models(src), K), "tab", { cols: 80, rows: 20 }).state;
      selectedShown(src, t, id);
      expect(seen(src, t, 80, 20), `${n} tab`).toContain(flat(t.msg));
      const denied = source({ ...src.inputs, repoText: src.inputs.repoText.replace(`models: [${AG}]`, `models: [${AG}, ${K}]`) });
      const refused = press(denied, on(denied, models(denied), K), "enter", { cols: 80, rows: 20 }).state;
      expect(refused.msg).toContain("Nothing was added");
      selectedShown(denied, refused, id);
      expect(seen(denied, refused, 80, 20), `${n} refused`).toContain(flat(refused.msg));
      if (n === 160) {
        const ci = modelColumns(derive(denied, models(denied)).base!, "implement", [Q]).findIndex((c) => c.id === "omp");
        const typed = press(denied, keysFrom(denied, models(denied), ...id, ...Array<string>(ci).fill("right")), "enter", { cols: 80, rows: 20 }).state;
        selectedShown(denied, typed, id);
        expect(seen(denied, typed, 80, 20)).toContain(flat(typed.msg));
      }
    }
    for (const q of ["z".repeat(240), "z".repeat(400)]) {
      const src = world(), st = keysFrom(src, models(src), ...q), all = seen(src, st, 80, 20), first = modelColumns(derive(src, st).base!, "implement", [Q])[0].id;
      expect(all).toContain(flat(`no model of ${first} has the search in its id`));
      expect(text(src, st, 80, 20).join("").replace(/[\s│]+/gu, "")).toContain(q.slice(0, 60));
    }
    for (const cli of ["review-production-cli-name-with-45-characters-x", `review-${"cli-".repeat(13)}`]) {
      const h = health([], { [cli]: ["gpt-review-new"] }) as Record<string, unknown>;
      h[cli] = { ...(h.codex as object), models: ["gpt-review-new"], modelAuth: {} };
      const src = source({ repoText: `tiers:\n  ${cli}:\n    vendor: openai\n    channel: api\n    models:\n      gpt-review-new: frontier\nrouting:\n  allowUnverifiedModels: true\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`, health: h as never });
      const st = on(src, models(src), `${cli}:gpt-review-new`), shown = text(src, st, 80, 20);
      expect(flat(shown.map((r) => r.slice(r.indexOf("│") + 1)).join(""))).toContain(flat(`${cli} · OpenAI models · sign-in: API key, paid per use`));
      selectedShown(src, st, "gpt-review-new");
    }
  }, 60_000); // queue row 527: CI under coverage runs this drive ~4x slower than a laptop
});

// the review of T11, fourth round (row 498; D-2187 add.409): doctor metadata is never a CLI; the vendor reads the probed identity;
// up to 120 characters, at 80 by 20, every header, the selected row down to its state word, the legend and every sentence are reached
describe("allowing a model: what doctor.json holds besides CLIs, and inputs up to 120 characters", () => {
  test("doctor metadata never becomes a CLI: a gateway listing, a failed one, aaKeyPrompt and modelsFirstSeen, through the normal loading path", () => {
    const now = new Date(NOW).toISOString();
    const gate = { host: "127.0.0.1:8317", baseUrl: "http://127.0.0.1:8317", source: "env" };
    const extras: Record<string, Record<string, unknown>> = {
      "a gateway listing": { gateway: { ...gate, listing: { status: "succeeded", checkedAt: now }, models: [{ id: "gpt-review-new", vendor: "openai" }] } },
      "a failed gateway listing": { gateway: { ...gate, listing: { status: "failed", failure: "down", checkedAt: now }, models: [] } },
      "the key prompt skipped": { aaKeyPrompt: { skippedAt: "2026-11-10T00:00:00Z" } },
      "first-seen dates": { modelsFirstSeen: { omp: { "google/gemini-4-carbon": "2026-11-01T00:00:00Z" } } },
    };
    for (const [name, extra] of Object.entries(extras)) {
      const cwd = mkdtempSync(join(tmpdir(), "tickmarkr-models-view-")), globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-models-view-g-"));
      mkdirSync(join(cwd, ".tickmarkr"));
      writeFileSync(join(cwd, ".tickmarkr", "doctor.json"), JSON.stringify({ ...health(), ...extra }));
      writeFileSync(join(cwd, ".tickmarkr", "config.yaml"), `routing:\n  mode: partner-led\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`);
      const src = loadFleetSource(cwd, { globalDir, adapters }), st = models(src);
      const ids = modelColumns(derive(src, st).base!, "implement", [Q]).map((c) => c.id);
      expect(ids, name).toEqual(Object.keys(DEFAULT_CONFIG.tiers));
      // every CLI is walked with the arrows and drawn, and nothing throws
      let walk = st;
      for (const id of ids) {
        expect(text(src, walk, 80, 20).some((r) => r.includes(`${id} · `)), `${name} ${id}`).toBe(true);
        walk = press(src, walk, "right", { cols: 80, rows: 20 }).state;
      }
      for (const k of Object.keys(extra)) expect(text(src, walk, 120, 24).join("\n"), name).not.toMatch(new RegExp(`[▸ ][●○✕] ${k}`, "u"));
    }
  });

  test("the header's vendors read the identity the probe recorded for an alias", () => {
    const codex = Object.keys(DEFAULT_CONFIG.tiers.codex.models).map((m) => `      ${m}: { vendor: openai }`).join("\n");
    const h = health([], { codex: ["new-alias"] }) as Record<string, { modelAuth?: Record<string, unknown> }>;
    h.codex.modelAuth = { ...h.codex.modelAuth, "new-alias": { ...(h.codex.modelAuth?.["gpt-6-astra"] as object), identity: "gpt-review-new" } };
    const src = source({ repoText: `tiers:\n  codex:\n    vendor: null\n    modelOverrides:\n${codex}\nrouting:\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`, health: h as never });
    const st = on(src, models(src), "codex:new-alias");
    expect(modelColumns(derive(src, st).base!, "implement", [Q]).find((c) => c.id === "codex")!.vendors).toEqual(["openai"]);
    expect(text(src, st, 120, 24).join("\n")).toContain("codex · OpenAI models");
  });

  /** Each row as drawn, its right column alone, whitespace gone. */
  const rightOf = (src: ScreenSource, st: ScreenState) => text(src, st, 80, 20).map((r) => (r.includes("│") ? r.slice(r.indexOf("│") + 1) : r));
  test("up to 120 characters at 80 by 20: a long model id keeps its speed and state word; a long search keeps the header, the sentence and the keys; a long CLI name keeps the cursor", () => {
    for (const n of [60, 100, 120]) {
      const id = `google/${"m".repeat(n - 7)}`, K = `omp:${id}`, f = { [id]: { score: 60, priceIn: 2, priceOut: 10, speed: 94 } };
      const src = world([id], "", f), t = press(src, on(src, models(src), K), "tab", { cols: 80, rows: 20 }).state;
      const right = rightOf(src, t), at = right.findIndex((r) => r.includes("▸ google/"));
      expect(at, `${n} tab`).toBeGreaterThan(0);
      // the selected row whole: its id, level, score, price, speed and state word, below the header
      expect(flat(right.slice(at).join(" ")), `${n} tab`).toContain(flat(`${id} frontier 60.0 2 / 10 94 not allowed yet`));
      expect(right.slice(0, at).join("\n")).toMatch(/MODEL\s+LEVEL\s+SCORE/u);
      const denied = source({ ...src.inputs, repoText: src.inputs.repoText.replace(`models: [${AG}]`, `models: [${AG}, ${K}]`) });
      const refused = press(denied, on(denied, models(denied), K), "enter", { cols: 80, rows: 20 }).state, rr = rightOf(denied, refused);
      const ra = rr.findIndex((r) => r.includes("▸ google/"));
      expect(flat(rr.slice(ra).join(" ")), `${n} refused`).toContain(flat(`${id} — 60.0 2 / 10 94 kept out · your guard`));
      expect(seen(denied, refused, 80, 20)).toContain(flat(refused.msg));
    }
    for (const n of [60, 100, 120]) {
      const q = "z".repeat(n), src = world(), st = keysFrom(src, models(src), ...q), shown = text(src, st, 80, 20), all = seen(src, st, 80, 20);
      const first = modelColumns(derive(src, st).base!, "implement", [Q])[0].id;
      expect(shown.join("").replace(/[\s│]+/gu, ""), `${n}`).toContain(`search:${q}`);
      expect(shown.join("\n")).toMatch(/CLIS/u);
      expect(all).toContain(flat(`no model of ${first} has the search in its id`));
      for (const t of LEGEND) expect(all).toContain(flat(t));
      expect(flat(shown.slice(-2).join(" "))).toMatch(/Escback$/u);
    }
    for (const n of [60, 100, 120]) {
      const cli = `review-${"c".repeat(n - 7)}`, h = health() as Record<string, unknown>;
      h[cli] = { ...(h.codex as object), models: ["gpt-review-new"], modelAuth: {} };
      const src = source({ repoText: `tiers:\n  ${cli}:\n    vendor: openai\n    channel: api\n    models:\n      gpt-review-new: frontier\nrouting:\n  allowUnverifiedModels: true\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`, health: h as never });
      const st = on(src, models(src), `${cli}:gpt-review-new`), right = rightOf(src, st);
      expect(flat(right.join("")), `${n}`).toContain(flat(`${cli} · OpenAI models · sign-in: API key, paid per use`));
      const at = right.findIndex((r) => r.includes("▸ gpt-review-new"));
      expect(at, `${n}`).toBeGreaterThan(0);
      expect(flat(right.slice(at).join(" "))).toContain(flat("gpt-review-new frontier — — — does not answer: not checked yet"));
    }
  });
});

// the review of T11, fifth round (row 498; D-2187 add.409): a long CLI name and a long model id or search together, each up to
// 120 characters, at 80 by 20; and a configured alias's vendor read from the identity the probe recorded
describe("allowing a model: long names together, and a configured alias's vendor", () => {
  /** Every frame PgDn reaches at 80 by 20, each with the keys whole at its foot. */
  function page(src: ScreenSource, st: ScreenState): string {
    for (let i = 0, prev = -1; i < 80 && (st.models?.foot ?? 0) !== prev; i++) {
      expect(flat(text(src, st, 80, 20).slice(-2).join(" "))).toMatch(/Escback$/u);
      prev = st.models?.foot ?? 0;
      st = press(src, st, "pgdown", { cols: 80, rows: 20 }).state;
    }
    return seen(src, { ...st, models: { ...st.models!, foot: undefined } }, 80, 20);
  }
  function longWorld(c: number, m: number): { src: ScreenSource; C: string; M: string } {
    const C = `review-${"c".repeat(c - 7)}`, M = `google/${"m".repeat(m - 7)}`, h = health() as Record<string, unknown>;
    h[C] = { ...(h.codex as object), models: [M], modelAuth: {}, modelFacts: { [M]: { as: M, score: 60, priceIn: 2, priceOut: 10, speed: 94 } } };
    const repoText = `tiers:\n  ${C}:\n    vendor: google\n    channel: api\n    models:\n      ${M}: frontier\nrouting:\n  mode: partner-led\n  allow:\n    models: [${Q}]\n`
      + `  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`;
    return { src: source({ repoText, health: h as never }), C, M };
  }
  const toCli = (src: ScreenSource, st: ScreenState, C: string) =>
    keysFrom(src, st, ...Array<string>(modelColumns(derive(src, st).base!, "implement", [Q], st.models!.query).findIndex((c) => c.id === C)).fill("right"));

  test("a long CLI name with a long model id or search, up to 120 characters each, at 80 by 20: the selected row to its state word and the empty search's sentence are reached", () => {
    for (const c of [60, 100, 120]) for (const m of [20, 60, 100, 120]) for (const typed of [false, true]) {
      const { src, C, M } = longWorld(c, m), where = `${c} ${m} ${typed}`;
      const st = toCli(src, typed ? keysFrom(src, models(src), ...M) : models(src), C);
      const row = modelColumns(derive(src, st).base!, "implement", [Q], st.models!.query).find((x) => x.id === C)!.rows.find((r) => r.model === M)!;
      const all = page(src, st);
      expect(all, where).toContain(flat(`${C} · Google models · sign-in: API key, paid per use`));
      expect(all, where).toContain(flat(`▸ ${M} frontier 60.0 2 / 10 94 ${row.state}`));
      for (const t of LEGEND) expect(all, where).toContain(flat(t));
    }
    for (const c of [100, 120]) {
      const { src, C } = longWorld(c, 20), st = toCli(src, keysFrom(src, models(src), ..."z".repeat(120)), C), all = page(src, st);
      expect(all, `${c}`).toContain(flat(`no model of ${C} has the search in its id`));
    }
  }, 60_000); // queue row 527: CI under coverage runs this drive ~4x slower than a laptop

  test("a configured alias: the header's vendors read the identity the probe recorded, not the config's vendor", () => {
    const h = health([], { codex: ["new-alias"] }) as Record<string, { modelAuth?: Record<string, unknown> }>;
    h.codex.modelAuth = { ...h.codex.modelAuth, "new-alias": { ...(h.codex.modelAuth?.["gpt-6-astra"] as object), identity: "gemini-review-new" } };
    const src = source({ repoText: `tiers:\n  codex:\n    models:\n      new-alias: frontier\nrouting:\n  mode: partner-led\n  allow:\n    models: [${Q}]\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`, health: h as never });
    const st = on(src, models(src), "codex:new-alias");
    expect(modelColumns(derive(src, st).base!, "implement", [Q]).find((c) => c.id === "codex")!.vendors).toContain("google");
    expect(text(src, st, 80, 20).join("\n")).toContain("models of several vendors");
  });
});

// the review of T11, sixth round (row 498; D-2187 add.410): a qualified recorded identity (vendor/model) names the vendor before the config's
describe("allowing a model: a qualified recorded identity names the vendor", () => {
  const IDS = [["alibaba/qwen3.8-max", "alibaba", "Alibaba"], ["deepseek/deepseek-v3.2", "deepseek", "Deepseek"], ["mistral/mistral-large", "mistral", "Mistral"]] as const;
  const aliased = (identity: string, tiers: string) => {
    const h = health([], { codex: ["new-alias"] }) as Record<string, { modelAuth?: Record<string, unknown> }>;
    h.codex.modelAuth = { ...h.codex.modelAuth, "new-alias": { ...(h.codex.modelAuth?.["gpt-6-astra"] as object), identity } };
    return source({ repoText: `tiers:\n  codex:\n${tiers}routing:\n  mode: partner-led\n  allow:\n    models: [${Q}]\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`, health: h as never });
  };
  test("a configured alias: the header's vendors read the qualified identity, not the config's vendor", () => {
    for (const [identity, vendor] of IDS) {
      const src = aliased(identity, `    models:\n      new-alias: frontier\n`), st = on(src, models(src), "codex:new-alias");
      expect(modelColumns(derive(src, st).base!, "implement", [Q]).find((c) => c.id === "codex")!.vendors, identity).toContain(vendor);
      expect(text(src, st, 80, 20).join("\n"), identity).toContain("models of several vendors");
    }
  });
  test("an unnamed alias on a CLI of several vendors: Tab writes the qualified identity's vendor, and the model is levelled and allowed in one sitting", () => {
    const codex = Object.keys(DEFAULT_CONFIG.tiers.codex.models).map((m) => `      ${m}: { vendor: openai }`).join("\n");
    for (const [identity, vendor] of IDS) {
      const src = aliased(identity, `    vendor: null\n    modelOverrides:\n${codex}\n`), K = "codex:new-alias";
      let st = press(src, on(src, models(src), K), "tab", { cols: 80, rows: 20 }).state;
      expect(st.msg, identity).toBe(`${K}: level frontier, not saved yet.`);
      expect(derive(src, st).hand.map((e) => [e.path.join("."), e.value]), identity).toContainEqual(["tiers.codex.modelOverrides.new-alias.vendor", vendor]);
      st = press(src, press(src, st, "enter", { cols: 80, rows: 20 }).state, "esc").state;
      expect(derive(src, st).refused, identity).toBeUndefined();
      expect(derive(src, st).full!.cfg.routing.allow.models, identity).toContain(K);
    }
  });
});

// the review of T11, seventh round (row 498; D-2187 add.410): a qualified vendor wins over the family its model name reads as;
// a kept-out CLI's cell is exactly as wide as the others, so the right column is never pushed past its room
describe("allowing a model: conflicting qualified identities, and a kept-out CLI's width", () => {
  const codex = Object.keys(DEFAULT_CONFIG.tiers.codex.models).map((m) => `      ${m}: { vendor: openai }`).join("\n");
  const aliased = (identity: string) => {
    const h = health([], { codex: ["new-alias"] }) as Record<string, { modelAuth?: Record<string, unknown> }>;
    h.codex.modelAuth = { ...h.codex.modelAuth, "new-alias": { ...(h.codex.modelAuth?.["gpt-6-astra"] as object), identity } };
    return source({ repoText: `tiers:\n  codex:\n    vendor: null\n    modelOverrides:\n${codex}\nrouting:\n  mode: partner-led\n  allow:\n    models: [${Q}]\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`, health: h as never });
  };
  test("a qualified identity whose model name reads as another vendor: the header and Tab's override take the qualified vendor", () => {
    for (const [identity, vendor] of [["anthropic/gpt-oss-120b", "anthropic"], ["alibaba/gpt-oss-120b", "alibaba"], ["mistral/claude-review-new", "mistral"], ["google/claude-review-new", "google"]]) {
      const src = aliased(identity), K = "codex:new-alias", st = on(src, models(src), K);
      expect(modelColumns(derive(src, st).base!, "implement", [Q]).find((c) => c.id === "codex")!.vendors, identity).toContain(vendor);
      const t = press(src, st, "tab", { cols: 80, rows: 20 }).state;
      expect(derive(src, t).hand.map((e) => [e.path.join("."), e.value]), identity).toContainEqual(["tiers.codex.modelOverrides.new-alias.vendor", vendor]);
    }
  });
  test("a CLI kept out by a rule takes no more width than the others: the header keeps TOK/S and the selected row is whole at 80 by 20", () => {
    for (const denied of ["codex", "cursor-agent"]) for (const n of [20, 60, 80]) {
      const id = `google/${"m".repeat(n - 7)}`, K = `omp:${id}`, base = world([id], "", { [id]: { score: 60, priceIn: 2, priceOut: 10, speed: 94 } });
      const src = source({ ...base.inputs, repoText: base.inputs.repoText.replace("  deny:\n", `  deny:\n    adapters: [${denied}]\n`) });
      const st = on(src, models(src), K), shown = text(src, st, 80, 20), where = `${denied} ${n}`;
      expect(shown.every((r) => width(r) <= 80), where).toBe(true);
      expect(shown.join("\n"), where).not.toContain("…");
      expect(shown.join("\n"), where).toMatch(/TOK\/S/u);
      const right = shown.map((r) => (r.includes("│") ? r.slice(r.indexOf("│") + 1) : r)), at = right.findIndex((r) => r.includes("▸ google/"));
      expect(flat(right.slice(at).join(" ")), where).toContain(flat(`${id} — 60.0 2 / 10 94`));
    }
  });
});

describe("allowing a model: models named like Object properties, and a CLI that bills its models both ways (row 515; D-2187 add.437)", () => {
  const line = `routing:\n  mode: partner-led\n  allow:\n    models: [${Q}]\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`;
  test("a probe listing models named constructor, toString, __proto__, hasOwnProperty or valueOf draws them as models with no level, at 80 by 20, without throwing", () => {
    const names = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "toLocaleString", "isPrototypeOf"];
    const src = source({ repoText: line, health: health([], { codex: names }) });
    const st = models(src), cols = modelColumns(derive(src, st).base!, "implement", [Q]), codex = cols.find((c) => c.id === "codex")!;
    for (const n of names) {
      const row = codex.rows.find((r) => r.key === `codex:${n}`);
      expect(row, n).toBeDefined();
      expect(row!.level, n).toBeUndefined();
      expect(row!.state, n).toBe(STATE_WORDS[1]);
    }
    const ci = cols.findIndex((c) => c.id === "codex");
    const at = keysFrom(src, { ...st, models: { ...st.models!, cli: 0, at: 0, key: undefined } }, ...Array<string>(ci).fill("right"));
    expect(() => text(src, at, 80, 20)).not.toThrow();
  });
  test("the header says how the CLI bills its models: one way when every model bills alike, both ways when a model override differs", () => {
    const tiers = (channel: string, over: string) => `tiers:\n  codex:\n    channel: ${channel}\n${over ? `    modelOverrides:\n      gpt-6-astra: { channel: ${over} }\n` : ""}`;
    const signIn = (repo: string) => {
      const src = source({ repoText: repo + line });
      return modelColumns(derive(src, models(src)).base!, "implement", [Q]).find((c) => c.id === "codex")!.signIn;
    };
    expect(signIn(tiers("sub", ""))).toBe("subscription");
    expect(signIn(tiers("api", ""))).toBe("API key, paid per use");
    expect(signIn(tiers("sub", "api"))).toBe("subscription for some models, API key for others");
    expect(signIn(tiers("api", "sub"))).toBe("subscription for some models, API key for others");
    expect(signIn(tiers("sub", "sub"))).toBe("subscription");
  });
});

describe("allowing a model: CLIs and models named like Object properties, and Enter on a row of my order (row 515; D-2187 add.441)", () => {
  const PROTO = ["constructor", "__defineGetter__", "hasOwnProperty", "isPrototypeOf", "toString", "valueOf", "__proto__", "toLocaleString"];
  const line = (channels: string) => `routing:\n  mode: partner-led\n  allow:\n    models: [${Q}]\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${channels}]\n`;
  test("Tab on a probe-listed model named like an Object property stages a level for it", () => {
    // __proto__, constructor and prototype are refused by name instead (row 522; D-2187 add.444)
    for (const n of PROTO.filter((k) => !["__proto__", "constructor", "prototype"].includes(k))) {
      const src = source({ repoText: line(Q), health: health([], { codex: [n] }) }), st = on(src, models(src), `codex:${n}`);
      const t = press(src, st, "tab", { cols: 80, rows: 20 }).state;
      expect(derive(src, t).hand.map((e) => e.path.join(".")), n).toContain(`tiers.codex.models.${n}`);
    }
  });
  test("a CLI only the probe knows, named like an Object property, is drawn at 80 by 20 without throwing", () => {
    for (const n of PROTO) {
      const h = health();
      // an own key, as JSON.parse makes it from doctor.json (an assignment to __proto__ would set the prototype instead)
      Object.defineProperty(h, n, { value: { installed: true, authed: true, models: ["gpt-review-new"], modelAuth: { "gpt-review-new": { authed: true, probedAt: "2026-11-10T00:00:00Z" } } }, enumerable: true, writable: true, configurable: true });
      const src = source({ repoText: line(Q), health: h }), st = models(src);
      const cols = modelColumns(derive(src, st).base!, "implement", [Q]);
      expect(cols.some((c) => c.id === n), n).toBe(true);
      expect(() => text(src, st, 80, 20), n).not.toThrow();
    }
  });
  test("Enter on a row of my order, then on a model already further down the line, puts it in that row: rows are positions", () => {
    const A = "codex:gpt-6-astra", src = source({ repoText: line(`${Q}, ${A}`).replace(`models: [${Q}]`, `models: [${Q}, ${A}]`) });
    let st = open(src, "implement");
    const ts = lineHomeTargets(src, st), i = ts.indexOf(`model:${Q}`);
    expect(i, ts.join(" | ")).toBeGreaterThanOrEqual(0);
    st = press(src, keysFrom(src, { ...st, line: { ...st.line!, at: 0 } }, ...Array<string>(i).fill("down")), "enter", { cols: 80, rows: 20 }).state;
    expect(st.view).toBe("models");
    st = press(src, on(src, st, A), "enter", { cols: 80, rows: 20 }).state;
    expect(st.models ?? null).toBeNull();
    expect(st.line!.chosen).toEqual([A, A]);
  });
});

describe("allowing a model: what the probe recorded beside a pending new model, Tab after an answered level, and a mixed CLI's vendors (row 515; D-2187 add.442)", () => {
  const ALIAS = "codex:new-alias", ID = "alibaba/qwen-review-new";
  const aliased = (deny = "") => {
    const h = health([], { codex: ["new-alias"] }) as Record<string, { modelAuth?: Record<string, unknown>; modelFacts?: Record<string, unknown> }>;
    h.codex.modelAuth = { ...h.codex.modelAuth, "new-alias": { authed: true, probedAt: "2026-11-10T00:00:00Z", identity: ID } };
    h.codex.modelFacts = { "new-alias": { as: ID, score: 60, priceIn: 2, priceOut: 10, speed: 94 } };
    const repoText = `routing:\n  mode: partner-led\n  allow:\n    models: [${Q}]\n${deny}  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`;
    return source({ repoText, health: h as never, assume: [ALIAS] });
  };
  test("a model a pending yes assumes keeps the identity, facts, vendor and rules its probe recorded", () => {
    const src = aliased(), M = derive(src, initialScreen()).base!, codex = modelColumns(M, "implement", [Q]).find((c) => c.id === "codex")!;
    const row = codex.rows.find((r) => r.key === ALIAS)!;
    expect([row.score, row.priceIn, row.priceOut, row.speed]).toEqual([60, 2, 10, 94]);
    expect(codex.vendors).toContain("alibaba");
    const denied = aliased(`  deny:\n    models: [${ID}]\n`), Md = derive(denied, initialScreen()).base!;
    expect(modelColumns(Md, "implement", [Q]).find((c) => c.id === "codex")!.rows.find((r) => r.key === ALIAS)!.state).toBe(STATE_WORDS[0]);
  });
  test("after a yes gave a model a level, Tab goes round all three levels and comes back to that one, said as answered", () => {
    const base = world(), saved = derive(base, initialScreen()).base!;
    const answered = derive(source({ ...base.inputs, repoText: base.inputs.repoText.replace("      google/gemini-4-iron: frontier\n", "      google/gemini-4-iron: frontier\n      google/gemini-4-carbon: mid\n") }), initialScreen()).base!;
    const cols = modelColumns(answered, "implement", [Q]), ci = cols.findIndex((c) => c.rows.some((r) => r.key === CARBON));
    const state = { cli: ci, at: cols[ci].rows.findIndex((r) => r.key === CARBON), query: "" };
    const seenLevels: Array<string | undefined> = [];
    let M = answered;
    for (let i = 0; i < 3; i++) {
      const r = modelsKey({ M, shape: "implement", chosen: [Q], allows: [], saved, answered, state }, "tab");
      seenLevels.push(r.level?.tier);
      if (i === 2) expect(r.msg).toContain("back to mid, as answered");
      const tier = r.level?.tier ?? "mid";
      M = derive(source({ ...base.inputs, repoText: base.inputs.repoText.replace("      google/gemini-4-iron: frontier\n", `      google/gemini-4-iron: frontier\n      google/gemini-4-carbon: ${tier}\n`) }), initialScreen()).base!;
    }
    expect(seenLevels).toEqual(["frontier", "cheap", undefined]);
  });
  test("Tab and Enter on a model of a CLI written with a placeholder vendor (mixed, unknown) write that model's own vendor", () => {
    for (const vendor of ["unknown", "mixed"]) {
      const base = world(), repoText = `tiers:\n  omp:\n    vendor: ${vendor}\n${base.inputs.repoText.replace(/^tiers:\n  omp:\n/u, "")}`;
      const src = source({ ...base.inputs, repoText });
      let st = press(src, on(src, models(src), CARBON), "tab").state;
      st = press(src, press(src, st, "enter").state, "esc").state;
      expect(derive(src, st).hand.map((e) => [e.path.join("."), e.value]), String(vendor)).toContainEqual(["tiers.omp.modelOverrides.google/gemini-4-carbon.vendor", "google"]);
    }
  });
});

describe("no edit writes through an object prototype (row 522; D-2187 add.444)", () => {
  const line = `routing:\n  mode: partner-led\n  allow:\n    models: [${Q}]\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ordered\n        channels: [${Q}]\n`;
  const probeOnly = (n: string) => {
    const h = health();
    Object.defineProperty(h, n, { value: { installed: true, authed: true, models: ["gpt-review-new"], modelAuth: { "gpt-review-new": { authed: true, probedAt: "2026-11-10T00:00:00Z" } } }, enumerable: true, writable: true, configurable: true });
    return source({ repoText: line, health: h });
  };
  const clean = () => { for (const k of ["models", "channel", "vendor", "modelOverrides"]) expect(({} as Record<string, unknown>)[k], k).toBeUndefined(); };
  test("Tab on a model or a probe-only CLI whose name is a reserved object key stages nothing, and the screen says why", () => {
    for (const n of ["__proto__", "constructor", "prototype"]) {
      for (const [src, K] of [[probeOnly(n), `${n}:gpt-review-new`], [source({ repoText: line, health: health([], { codex: [n] }) }), `codex:${n}`]] as const) {
        const st = on(src, models(src), K), t = press(src, st, "tab", { cols: 80, rows: 20 }).state;
        clean();
        expect(t.hand, K).toEqual([]);
        expect(t.msg, K).toMatch(/^Nothing was changed: the level would make a config tickmarkr refuses: /u);
        expect(t.msg, K).toContain(n);
        expect(text(src, t, 120, 40).join("\n").replace(/\s+/gu, ""), K).toContain(t.msg.replace(/\s+/gu, "").slice(0, 40));
      }
    }
  });
  test("Tab on a probe-only CLI named like a built-in property of every object stages its level as a change to that CLI", () => {
    for (const n of ["toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "toLocaleString", "__defineGetter__"]) {
      const src = probeOnly(n), K = `${n}:gpt-review-new`, t = press(src, on(src, models(src), K), "tab", { cols: 80, rows: 20 }).state;
      expect(t.msg, n).toBe(`${K}: level frontier, not saved yet.`);
      const d = derive(src, t);
      expect(d.refused, n).toBeUndefined();
      expect(d.hand.map((e) => e.path.join(".")), n).toContain(`tiers.${n}.models.gpt-review-new`);
      expect(d.texts?.repoText, n).toContain(`${n}:`);
      clean();
    }
  });
});

describe("beside a pending new-model yes the view draws what the probe recorded (row 515; D-2187 add.444)", () => {
  const LISTED = Object.keys(DEFAULT_CONFIG.tiers.codex.models)[0];
  const pending = (cli: Partial<{ installed: boolean; authed: boolean }>, assume: string[]) => {
    const h = health(["codex:slow"], { codex: ["old", "slow", "bare"] });
    const auth = { ...h.codex.modelAuth };
    delete auth.bare;
    h.codex = { ...h.codex, ...cli, modelAuth: auth };
    return source({ repoText: `routing:\n  mode: partner-led\n  allow:\n    models: [${Q}, codex:${LISTED}]\n`, health: h, assume });
  };
  const detailOf = (src: ScreenSource, key: string) => {
    const M = derive(src, initialScreen()).base!, cols = modelColumns(M, "implement", []), ci = cols.findIndex((c) => c.id === "codex");
    const parts = modelsParts({ M, shape: "implement", chosen: [], state: { cli: ci, at: 0, key, query: "" } }, 200);
    return { col: cols[ci], row: cols[ci].rows.find((r) => r.key === key)!, detail: parts.detail.map((l) => l.map((s) => s.text).join("")).join("\n") };
  };
  test("beside a pending new-model yes a model's verdict and age read as its probe recorded them: passed yesterday, timed out, no record", () => {
    const src = pending({}, ["codex:old", "codex:slow", "codex:bare", "codex:brand-new"]);
    expect(detailOf(src, "codex:old").detail).toContain("answers, checked 1 day ago");
    const slow = detailOf(src, "codex:slow").detail;
    expect(slow).toContain("does not answer: ");
    expect(slow).toContain(", checked 1 day ago");
    for (const k of ["codex:bare", "codex:brand-new"]) {
      const d = detailOf(src, k).detail;
      expect(d, k).toContain("not checked yet");
      expect(d, k).not.toContain("answers");
    }
  });
  test("beside a pending new-model yes a CLI signed out or not installed is not drawn as answering", () => {
    for (const cli of [{ authed: false }, { installed: false }]) {
      const src = pending(cli, [`codex:${LISTED}`, "codex:brand-new"]);
      for (const k of [`codex:${LISTED}`, "codex:brand-new"]) {
        const { col, row, detail } = detailOf(src, k);
        expect(col.mark, JSON.stringify(cli)).toBe("○");
        expect(row.state, k).not.toBe(STATE_WORDS[5]);
        expect(row.state, k).not.toBe(STATE_WORDS[6]);
        expect(detail, k).not.toMatch(/ · answers/u);
      }
      expect(detailOf(src, `codex:${LISTED}`).row.state).toMatch(/^does not answer: CLI (signed out|not installed)/u);
    }
  });
  test("a CLI the probe never recorded is not marked answering because a pending yes names one of its models", () => {
    const h = health();
    delete (h as Record<string, unknown>).codex;
    const M = derive(source({ health: h, assume: ["codex:brand-new"] }), initialScreen()).base!;
    expect(modelColumns(M, "implement", []).find((c) => c.id === "codex")!.mark).toBe("○");
  });
  test("a pending model named like an Object property with no record of its own reads not checked yet", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      const h = health([], { codex: [name] });
      delete h.codex.modelAuth![name];
      const key = `codex:${name}`, M = derive(source({ health: h, assume: [key] }), initialScreen()).base!;
      const detail = modelsParts({ M, shape: "implement", chosen: [], state: { cli: 0, at: 0, key, query: "" } }, 200).detail.flat().map((x) => x.text).join("");
      expect(detail, key).toContain(" · not checked yet · ");
    }
  });
});
