// Answers, the review and the one write path, driven through the screen's two pure functions:
// press() for a key and frame() for what is drawn.
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { applyLayer } from "../../src/fleet/edits.js";
import { buildFleetModel, verdictOf } from "../../src/fleet/model.js";
import { needSignature, type NewModel, recommendedPools } from "../../src/fleet/needs.js";
import { derive, frame, initialScreen, plainScreen, press, resumeScreen, type ScreenSource, teamRows } from "../../src/fleet/screen.js";
import { handLines } from "../../src/fleet/hand.js";
import { withFirstSeen } from "../../src/fleet/seen.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import { health, NOW, POOL, source } from "./world.js";
import { keys, text } from "./drive.js";

describe("answers and the one write path", () => {
  test("a list put in a new order keeps the comment above every item it keeps, and the comment moves with its item", () => {
    const repoText = "routing:\n  map:\n    plan:\n      pool:\n        mode: any\n        channels:\n          # first, because it is the cheapest\n          - codex:gpt-6-astra\n          # - codex:gpt-5.6-sol   # removed 2026-09-25, and why\n          - claude-code:opus\n          - codex:gpt-6-sol # the spare\nconsult:\n  prefer: [codex:gpt-6-astra]\n";
    const src = source({ repoText });
    // a new model first, the last one second, and one removed: nothing a hand wrote about a kept item is lost
    const d = derive(src, { ...initialScreen(), hand: [{ line: "plan", chosen: ["claude-code:fable", "codex:gpt-6-sol", "claude-code:opus"] }] });
    expect(d.refused).toBeUndefined();
    expect(d.texts!.repoText).toBe("routing:\n  map:\n    plan:\n      pool:\n        mode: any\n        channels:\n          # first, because it is the cheapest\n          - claude-code:fable\n          - codex:gpt-6-sol # the spare\n          # - codex:gpt-5.6-sol   # removed 2026-09-25, and why\n          - claude-code:opus\nconsult:\n  prefer: [codex:gpt-6-astra]\n");
    // a flow list in a new order stays a flow list
    const flow = derive(source({ repoText: "review:\n  prefer: [codex:gpt-6-astra, claude-code:opus] # two vendors\nconsult:\n  prefer: [codex:gpt-6-astra]\n" }), { ...initialScreen(), hand: [{ line: "review", chosen: ["claude-code:opus", "codex:gpt-6-astra"] }] });
    expect(flow.texts!.repoText).toBe("review:\n  prefer: [claude-code:opus, codex:gpt-6-astra] # two vendors\nconsult:\n  prefer: [codex:gpt-6-astra]\n");
  });
  test("a narrow terminal drops key hints, never the end of the row: yes, no, review and quit stay named", () => {
    const src = source();
    const yes = keys(src, "y");
    const row = (st: ReturnType<typeof initialScreen>, cols: number) => text(src, st, cols, 16).at(-1)!;
    for (const cols of [48, 60, 72]) {
      for (const st of [initialScreen(), yes, { ...yes, view: "review" as const }, { ...initialScreen(), view: "detail" as const }]) {
        expect(row(st, cols), `${cols} ${st.view}`).not.toContain("…");
      }
      expect(row(yes, cols)).toMatch(/y\s+yes.*n\s+no.*Enter\s+review.*q\s+quit/);
    }
    // details is the last hint to go: a narrow terminal is where an item's text is cut short
    expect(row(yes, 60)).toMatch(/d\s+details/);
    // a terminal with the room names every key in full
    expect(row(yes, 120)).toMatch(/choose.*details.*change a line.*probe.*review and save.*undo.*quit/);
    expect(row(yes, 100)).not.toContain("…");
  });
  test("a save changes only the lines the review shows: every other line keeps its bytes", () => {
    // what a hand-kept overlay looks like: a wide gap before a note, an unpadded list, a list over several lines
    const before = [
      "# kept by hand", "tiers:", "  codex:", "    models:", "      gpt-6-astra: frontier  # frontier — fleet 2026-10-02",
      "review:", "  prefer: [codex:gpt-6-astra, claude-code:opus]   # both", "routing:", "  deny:", "    workers:", "      models:", "        [", "          grok:grok-4.6,", "          codex:gpt-6-luna,",
      "          omp:anthropic/claude-opus-5,", "          omp:xai-oauth/grok-4.6,", "          claude-code:claude-opus-5", "        ]",
      "    models:", "      # never writes code", "      - claude-code:fable   # the operator's rule", "      - claude-code:haiku", "",
    ].join("\n");
    const after = applyLayer(before, [{ layer: "repo", path: ["routing", "deny", "models"], value: ["claude-code:fable"], label: "" }]);
    expect(after.split("\n")).toEqual(before.split("\n").filter((l) => !l.includes("haiku")));
    // an edit that changes nothing changes no byte
    expect(applyLayer(before, [{ layer: "repo", path: ["routing", "deny", "models"], value: ["claude-code:fable", "claude-code:haiku"], label: "" }])).toBe(before);
    // The review counts exactly the file's changed lines, whatever the serialiser does: here it also
    // closes a hand-made gap after a key and joins a short list a hand had broken, and both are shown.
    const odd = before.replace("  prefer: [", "  prefer:   [").replace("    models:\n      # never", "    adapters:\n      [\n        kimi\n      ]\n    models:\n      # never");
    const src = source({ repoText: `${odd}consult:\n  prefer: [claude-code:fable]\n` });
    const d = derive(src, { ...initialScreen(), yes: ["consult"] });
    const was = src.inputs.repoText.split("\n"), now = d.texts!.repoText.split("\n");
    const gone = was.filter((l) => !now.includes(l)).length, come = now.filter((l) => !was.includes(l)).length;
    const review = text(src, { ...initialScreen(), yes: ["consult"], view: "review" }, 100, 80).join("\n");
    expect(review).toMatch(new RegExp(`TO BE SAVED IN \\S+  \\+${come} −${gone}\\b`));
    expect(review).toMatch(/- {3}prefer: {3}\[codex:gpt-6-astra, claude-code:opus\] {3}# both/);
    expect(review).toMatch(/\+\s+adapters: \[kimi\]/);
  });
  test("details that do not fit the terminal say how much is missing", () => {
    // an item with more than eight changes: a new model joining the pools of all nine shapes
    const fresh: NewModel = { id: "gemini-4-carbon", name: "Gemini 4 Carbon", provider: "google", paths: [{ adapter: "omp", model: "google/gemini-4-carbon", score: 60 }],
      score: 60, best: { score: 59.1, model: "opus5.5" }, tier: "frontier", needs: 0.9, firstSeen: "2026-11-10" };
    const nine = `routing:\n  mode: partner-led\n  map:\n${["plan", "spec", "implement", "tests", "docs", "migration", "ui", "refactor", "chore"].map((x) => `    ${x}:\n      pool: { mode: any, channels: [codex:gpt-6-astra] }\n`).join("")}consult:\n  prefer: [codex:gpt-6-astra]\n`;
    const src = source({ repoText: nine, health: health([], { omp: ["google/gemini-4-carbon"] }) }, { newModels: [fresh] });
    const sel = derive(src, initialScreen()).items.findIndex((n) => n.id === "new:gemini-4-carbon");
    const detail = { ...initialScreen(), sel, view: "detail" as const };
    const edits = derive(src, detail).items[sel].edits!.length;
    const tall = text(src, detail, 60, 60).join("\n");
    expect(edits).toBeGreaterThan(8);
    // with the room: eight changes and the rest counted
    expect(tall).toContain(`· and ${edits - 8} more: the review lists every change`);
    expect(tall).not.toContain("a taller terminal shows them");
    // with less room the list shrinks to what fits, and still counts the rest
    expect(text(src, detail, 60, 30).filter((l) => /^ {3}· (?!and )/.test(l)).length).toBeGreaterThan(0);
    for (const rows of [30, 26, 22]) {
      const lines = text(src, detail, 60, rows);
      const shown = lines.filter((l) => /^ {3}· (?!and )/.test(l)).length;
      // no room for even one: one line still says the review has them, or the cut is marked
      if (shown) expect(lines.join("\n"), `${rows} rows`).toContain(`· and ${edits - shown} more: the review lists every change`);
      else expect(lines.join("\n"), `${rows} rows`).toMatch(new RegExp(`The review lists the ${edits} changes a yes makes\\.|… \\d+ more lines?: a taller terminal shows them`));
      expect(lines.at(-1)).toMatch(/y\s+yes.*Esc\s+back/);
    }
    // too short even for the explanation: the cut is marked
    expect(text(src, detail, 60, 8).at(-3)).toMatch(/… \d+ more lines?: a taller terminal shows them/);
  });
  test("wide characters, combining marks, tabs and escape sequences in outside text never break a row", () => {
    const note = "顾问模型：只做咨询，不写代码（操作员规定）顾问模型：只做咨询，不写代码";
    const repoText = `routing:\n  deny:\n    models:\n      # لا يكتب الكود أبدًا\n      - claude-code:fable   # ${note}\n      - claude-code:haiku\t# tab\x1b[31m red\x1b[0m\nconsult:\n  prefer: [claude-code:fable]\n`;
    const src = source({ repoText });
    const st = { ...initialScreen(), yes: ["consult"], view: "review" as const };
    for (const [cols, rows] of [[60, 40], [80, 40], [120, 40]] as const) {
      const lines = frame(src, st, cols, rows);
      for (const [i, l] of lines.entries()) {
        const row = l.map((x) => x.text).join("");
        expect(cellWidth(row), `${cols} columns, row ${i}: ${row}`).toBe(cols);
        expect(row, `${cols} columns, row ${i}`).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      }
      // the removed line is on screen whole, over as many rows as its cells need
      const shown = lines.map((l) => l.map((x) => x.text).join("").slice(7).trimEnd()).join("");
      expect(shown, `${cols} columns`).toContain(note);
      expect(shown, `${cols} columns`).toContain("لا يكتب الكود أبدًا");
    }
    // a message and an item's words from outside are cleaned the same way
    const dirty = frame(source(), { ...initialScreen(), msg: "Not saved: \x1b[2Jbad\tpath" }, 80, 24).map((l) => l.map((x) => x.text).join("")).join("\n");
    expect(dirty).toContain("Not saved: bad path");
    expect(dirty).not.toContain("\x1b");
  });
  test("every set of answers, in every order, loads, gives the same config, and is not asked again", () => {
    // answers that edit the same pools and the same deny list: a shape with nobody, the judge, the consult, the clean-up
    const repoText = `${POOL}          - grok:grok-4.5\n  deny:\n    workers:\n      models: [grok:grok-4.5]\n    models:\n      - claude-code:fable\nconsult:\n  prefer: [claude-code:fable]\n`;
    const src = source({ repoText });
    const ids = derive(src, initialScreen()).items.filter((n) => n.edits).map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["noseat", "consult", "tidy"]));
    expect(ids.length).toBeGreaterThanOrEqual(4);
    const orders = (xs: string[]): string[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
    let sequences = 0;
    for (let mask = 1; mask < 1 << ids.length; mask++) {
      const subset = ids.filter((_, i) => mask & (1 << i));
      const configs = new Set<string>();
      // every order of up to three answers; of more, the order asked and its reverse
      for (const order of subset.length <= 3 ? orders(subset) : [subset, [...subset].reverse()]) {
        sequences++;
        const d = derive(src, { ...initialScreen(), yes: order });
        expect(d.refused, order.join()).toBeUndefined();
        configs.add(JSON.stringify(parse(d.texts!.repoText)));
        const after = derive(source({ repoText: d.texts!.repoText }), initialScreen());
        expect(after.items.filter((n) => order.includes(n.id)).map((n) => n.id), `asked again after ${order.join()}`).toEqual([]);
      }
      expect(configs.size, `the order of ${subset.join()} changes the result`).toBe(1);
    }
    expect(sequences).toBeGreaterThan(50);
  });
  test("random keys never break the screen: every frame fits, every yes is for a listed item, a save always loads", () => {
    let seed = 4242;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const KEYS = ["up", "down", "j", "k", "y", "y", "n", "u", "u", "d", "enter", "esc", "r", "q", "x", " ", "é", "\u0000", ""];
    const repoText = `${POOL}          - grok:grok-4.5\n  deny:\n    workers:\n      models: [grok:grok-4.5]\n    models:\n      - claude-code:fable\nconsult:\n  prefer: [claude-code:fable]\n`;
    let saves = 0, undone = 0;
    for (let run = 0; run < 15; run++) {
      let src = source({ repoText }), st = initialScreen();
      for (let i = 0; i < 30; i++) {
        const key = pick(KEYS), where = `run ${run}, key ${i} (${JSON.stringify(key)})`;
        const out = press(src, st, key);
        st = out.state;
        const a = out.action;
        if (a?.kind === "dismiss") src = { ...src, ctx: { ...src.ctx, dismissed: new Set([...(src.ctx.dismissed ?? []), needSignature(derive(src, st).items.find((n) => n.id === a.id)!)]) } };
        if (a?.kind === "restore") { undone++; expect(src.ctx.dismissed?.has(a.signature), where).toBe(true); src = { ...src, ctx: { ...src.ctx, dismissed: new Set([...(src.ctx.dismissed ?? [])].filter((x) => x !== a.signature)) } }; }
        if (a?.kind === "save") { saves++; expect(a.touched.length, where).toBeGreaterThan(0); src = source({ repoText: a.texts.repoText, userText: a.texts.userText }, src.ctx); expect(derive(src, st).base, where).toBeDefined(); }
        const d = derive(src, st);
        if (a?.kind === "quit") expect(a.unsaved, where).toBe(d.said.length);
        const ids = d.items.map((n) => n.id);
        expect(st.yes.every((id) => ids.includes(id)), where).toBe(true);
        expect(new Set(st.yes).size, where).toBe(st.yes.length);
        const [cols, rows] = pick([[80, 24], [60, 16], [120, 36], [40, 12]] as const);
        const lines = frame(src, st, cols, rows);
        expect(lines.length, where).toBe(rows);
        for (const l of lines) expect(cellWidth(l.map((x) => x.text).join("")), where).toBe(cols);
      }
    }
    // the run reached the paths it is here for
    expect(saves).toBeGreaterThan(0);
    expect(undone).toBeGreaterThan(0);
  });
  test("a team line never reads ok, or 0%, on a share that is small but not zero", () => {
    const M = buildFleetModel(source({ repoText: POOL }).inputs);
    const a = M.sample();
    const rows = { ...a.rows, implement: { ...a.rows.implement, under: 0.25 } };
    const few = { ...M, sample: () => ({ ...a, rows, noReviewer: 3, ownVendor: 2 }) } as typeof M;
    const line = (label: string) => teamRows(few).find((r) => r.label.startsWith(label))!;
    expect(line("review")).toMatchObject({ status: "<1% unreviewed", style: "warn" });
    expect(line("acceptance")).toMatchObject({ status: "<1% own vendor", style: "warn" });
    expect(teamRows(few).find((r) => r.section === "workers" && r.status.includes("below"))!.status).toBe("<1% below frontier");
    // none at all is ok
    const none = { ...M, sample: () => ({ ...a, noReviewer: 0, ownVendor: 0 }) } as typeof M;
    expect(teamRows(none).find((r) => r.label.startsWith("review"))!.status).toBe("ok");
  });
  test("the review's scroll stops at its end, so one up after many downs moves it", () => {
    const src = source({ health: health(["claude-code:fable"]) });
    let st = { ...initialScreen(), yes: ["setup"], view: "review" as const };
    const size = { cols: 80, rows: 16 };
    const shot = () => text(src, st, size.cols, size.rows).join("\n");
    const top = shot();
    for (let i = 0; i < 300; i++) st = press(src, st, "down", size).state;
    const bottom = shot();
    expect(bottom).not.toBe(top);
    expect(st.scroll).toBeLessThan(300);
    // one more down changes nothing; one up does
    expect(press(src, st, "down", size).state.scroll).toBe(st.scroll);
    st = press(src, st, "up", size).state;
    expect(shot()).not.toBe(bottom);
    for (let i = 0; i < 300; i++) st = press(src, st, "k", size).state;
    expect(shot()).toBe(top);
  });
  // The rules below were found unpinned by mutation drills: each worked, and no test would have noticed it break.
  test("first setup picks the judge from the vendor that does the least field work", () => {
    // anthropic answers through two CLIs and openai through one model, so anthropic does more field work
    const src = source({ health: health(["claude-code:fable", "codex:gpt-6-sol", "codex:gpt-5.6-sol"]) });
    const d0 = derive(src, initialScreen());
    const M = d0.base!;
    const judge = d0.items[0].edits!.find((e) => e.path[0] === "judge")!.value as { adapter: string; model: string };
    const use = new Map<string, number>();
    for (const ch of Object.values(recommendedPools(M))) for (const k of ch) use.set(M.provider(k), (use.get(M.provider(k)) ?? 0) + 1);
    const candidates = M.pools.judge.filter((c) => c.tier === "frontier" && c.vendor !== "unknown").map((c) => use.get(M.provider(`${c.adapter}:${c.model}`)) ?? 0);
    // the first candidate in the config's order is not the answer: it does more field work than another
    expect(candidates[0]).toBeGreaterThan(Math.min(...candidates));
    expect(use.get(M.provider(`${judge.adapter}:${judge.model}`)) ?? 0).toBe(Math.min(...candidates));
  });
  test("models that do not work are listed by what fixing them gives back, most first", () => {
    // In the config's order fable comes before qwen. Fixing fable gives one shape a worker and the
    // consult its model; fixing qwen gives three shapes a worker, which is more, so qwen is first.
    const pool = (shape: string) => `    ${shape}:\n      pool:\n        mode: any\n        channels: [qwen:qwen3.8-max]\n`;
    const src = source({ repoText: `routing:\n  map:\n${pool("plan")}${pool("docs")}${pool("tests")}consult:\n  prefer: [claude-code:fable]\n`, health: health(["claude-code:fable", "qwen:qwen3.8-max"]) });
    const fixes = derive(src, initialScreen()).items.filter((n) => n.id.startsWith("fix:"));
    expect(fixes.map((n) => n.id.split(":")[1])).toEqual(["qwen3.8-max", "fable"]);
    expect(fixes[0].ask).toContain("You get: 3 shapes get a working model.");
    expect(fixes[1].detail.join(" ")).toContain("the consult gets its model");
  });
  test("a new model is not offered when a configured alias was probed as that model", () => {
    const h = health();
    (h["claude-code"].modelAuth!.fable as { identity?: string }).identity = "claude-fable-9";
    const fresh: NewModel = { id: "claude-fable-9", name: "Claude Fable 9", provider: "anthropic", paths: [{ adapter: "omp", model: "anthropic/claude-fable-9", score: 70 }],
      score: 70, best: { score: 59.1, model: "opus5.5" }, tier: "frontier", needs: 0.9, firstSeen: "2026-11-10" };
    h.omp.models = [...h.omp.models, "anthropic/claude-fable-9"];
    expect(derive(source({ repoText: POOL, health: h }, { newModels: [fresh] }), initialScreen()).items.some((n) => n.id.startsWith("new:"))).toBe(false);
    // without that alias it is offered
    expect(derive(source({ repoText: POOL, health: health([], { omp: ["anthropic/claude-fable-9"] }) }, { newModels: [fresh] }), initialScreen()).items.some((n) => n.id === "new:claude-fable-9")).toBe(true);
  });
  test("a new model is offered only through a CLI the team already works through, and only in pools it is strong enough for", () => {
    const paths = [{ adapter: "omp", model: "google/gemini-4-carbon", score: 60 }, { adapter: "agy", model: "gemini-4-carbon", score: 60 }];
    const mk = (tier: "frontier" | "mid"): NewModel => ({ id: "gemini-4-carbon", name: "Gemini 4 Carbon", provider: "google", paths, score: 60, best: { score: 59.1, model: "opus5.5" }, tier, needs: 0.9, firstSeen: "2026-11-10" });
    const h = health([], { omp: ["google/gemini-4-carbon"] });
    const item = (n: NewModel) => derive(source({ repoText: POOL, health: h }, { newModels: [n] }), initialScreen()).items.find((x) => x.id === "new:gemini-4-carbon")!;
    // agy lists it too, but nobody on the team works through agy
    expect(item(mk("frontier")).assume).toEqual(["omp:google/gemini-4-carbon"]);
    expect(item(mk("frontier")).edits!.some((e) => e.path.join(".") === "routing.map.implement")).toBe(true);
    // a mid model does not join a pool whose floor is frontier
    expect(item(mk("mid")).edits!.some((e) => e.path[0] === "routing" && e.path[1] === "map")).toBe(false);
  });
  test("the clean-up never empties a pool: one whose entries are all kept out is left for the item that names it", () => {
    const src = source({ repoText: "routing:\n  map:\n    docs:\n      pool:\n        mode: any\n        channels: [grok:grok-4.5]\n  deny:\n    workers:\n      models: [grok:grok-4.5]\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    const items = derive(src, initialScreen()).items;
    const tidy = items.find((n) => n.id === "tidy");
    expect((tidy?.edits ?? []).some((e) => e.path.join(".") === "routing.map.docs")).toBe(false);
    expect(items.some((n) => n.id === "noseat")).toBe(true);
  });
  test("a signed-out CLI is a failure of every model on it, and the age of the evidence is its oldest result", () => {
    expect(verdictOf({ codex: { installed: true, authed: false, models: ["m"], note: "not signed in", modelAuth: { m: { authed: true, probedAt: "2026-11-10T00:00:00Z" } } } }, "codex", "m", NOW))
      .toMatchObject({ state: "fail", kind: "login", text: "CLI signed out", fix: "sign in to codex" });
    // one model the team uses was probed ten days ago, the rest yesterday: the team rests on the old one
    const h = health();
    h.codex.modelAuth!["gpt-6-astra"] = { authed: true, probedAt: "2026-11-01T00:00:00Z" };
    const items = derive(source({ repoText: POOL, health: h }), initialScreen()).items;
    expect(items[0]).toMatchObject({ id: "stale", title: "The team rests on probe results over 1 week old." });
  });
  test("shapes the same models take are one line only when they also read the same", () => {
    const M = buildFleetModel(source({ repoText: POOL }).inputs);
    const a = M.sample();
    const same = { ...a.rows.implement, unstaffed: 0 };
    const rows = { ...a.rows, plan: { ...same, shape: "plan" as const, under: 0 }, spec: { ...same, shape: "spec" as const, under: 25 } };
    const lines = teamRows({ ...M, sample: () => ({ ...a, rows }) } as typeof M).filter((r) => r.section === "workers");
    expect(lines.find((r) => r.label.split(", ").includes("plan"))!.label.split(", ")).not.toContain("spec");
    expect(lines.find((r) => r.label.split(", ").includes("spec"))!.status).toBe("25% below frontier");
  });
  test("y on an item that is yours to do answers nothing, and a refused review cannot be saved", () => {
    const src = source({ repoText: "consult:\n  prefer: [claude-code:fable]\n", health: health(["claude-code:fable"]) });
    const items = derive(src, initialScreen()).items;
    const sel = items.findIndex((n) => !n.edits);
    expect(sel).toBeGreaterThanOrEqual(0);
    const out = press(src, { ...initialScreen(), sel }, "y");
    expect(out.state.yes).toEqual([]);
    expect(out.state.msg).toBe("This one is yours to do; then press r.");
    // an answer that cannot land: the repository's config gives tiers.omp its keys through a YAML 1.1 merge key,
    // and the new model goes under it, so the write path refuses it in refuseMerge's words (D-2187 add.222)
    const fresh: NewModel = { id: "gemini-4-carbon", name: "Gemini 4 Carbon", provider: "google", paths: [{ adapter: "omp", model: "google/gemini-4-carbon", score: 60 }],
      score: 60, best: { score: 59.1, model: "opus5.5" }, tier: "frontier", needs: 0.9, firstSeen: "2026-11-10" };
    const stuck = source({ repoText: `%YAML 1.1\n---\n${POOL}tiers:\n  omp:\n    <<: { vendor: mixed }\n    models:\n      google/gemini-3.8-flash: mid\n`, health: health([], { omp: ["google/gemini-4-carbon"] }) }, { newModels: [fresh] });
    const st = { ...initialScreen(), yes: ["new:gemini-4-carbon"], view: "review" as const };
    const d = derive(stuck, st);
    expect(d.refused).toBeDefined();
    expect(d.refused).toContain("takes keys through the YAML merge key `<<: { vendor: mixed }` in tiers.omp — Fleet does not write through merge keys");
    expect(text(stuck, st, 100, 30).join("\n")).toContain("REFUSED");
    expect(text(stuck, st, 100, 30).at(-1)).not.toMatch(/y\s+save/);
    expect(press(stuck, st, "y").action).toBeUndefined();
  });
  test("the review says each answer whole: a title wider than the terminal takes another row and is never cut", () => {
    const src = source({ health: health(["claude-code:fable"]) });
    const st = keys(src, "y", "enter");
    expect(st.view).toBe("review");
    const title = derive(src, st).said[0].title;
    expect(title.length).toBeGreaterThan(40);
    const rows = text(src, st, 44, 60).map((l) => l.trimEnd());
    const from = rows.indexOf(" YOU SAID YES TO"), to = rows.indexOf("", from);
    expect(to - from).toBeGreaterThan(2);
    expect(rows.slice(from + 1, to).map((l) => l.replace(/^ +\d? +/, "")).join(" ")).toBe(title);
    for (const l of rows.slice(from, to)) expect(l).not.toContain("…");
  });
  test("a question is never cut at 80 columns: one too long to share its row with the y and n keys keeps the row", () => {
    const worlds = [source(), source({ health: health(["claude-code:fable"]) }), source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` }),
      source({ repoText: "routing:\n  deny:\n    models: [claude-code:fable]\nconsult:\n  prefer: [claude-code:fable]\n" }),
      source({ repoText: "routing:\n  deny:\n    adapters: [claude-code]\nconsult:\n  prefer: [claude-code:fable]\n" }),
      // nearly nothing answers; and a judge with a long key that does not answer: titles wider than the terminal
      source({ health: health(Object.entries(DEFAULT_CONFIG.tiers).flatMap(([a, t]) => Object.keys(t.models).map((m) => `${a}:${m}`)).filter((k) => !k.startsWith("grok:"))) }),
      source({ health: health(["prime-agent:prime-inference/z-ai/glm-5.2"]), repoText: "judge:\n  adapter: prime-agent\n  model: prime-inference/z-ai/glm-5.2\n" }),
      // a shape nobody can take, and many models that can: the question names several long ones
      source({ health: health(["claude-code:fable"]), repoText: "routing:\n  map:\n    plan:\n      pool:\n        mode: any\n        channels: [claude-code:fable]\nconsult:\n  prefer: [codex:gpt-6-astra]\n" })];
    // a model out of quota that much rests on: what fixing it gives back makes a long question
    const quota = health();
    quota["claude-code"].modelAuth!.fable = { authed: false, reason: "You have hit your usage limit.", probedAt: "2026-11-10T00:00:00Z" } as never;
    worlds.push(source({ health: quota, repoText: "consult:\n  prefer: [claude-code:fable]\n" }));
    let asked = 0, alone = 0, long = 0, wide = 0;
    for (const src of worlds) {
      const items = derive(src, initialScreen()).items;
      for (const [i, it] of items.entries()) {
        // an item is found by its number: two items can open with the same words
        const mine = (st: ReturnType<typeof initialScreen>) => {
          const rows = text(src, st, 80, 24 + 4 * items.length);
          const from = rows.findIndex((l) => new RegExp(`^ [▸ ]${i + 1} {2}`).test(l));
          const next = rows.findIndex((l, n) => n > from && (/^ [▸ ]\d+ {2}/.test(l) || !l.trim()));
          return rows.slice(from, next < 0 ? from + 4 : next);
        };
        const rows = mine({ ...initialScreen(), sel: i });
        expect(rows.length, it.title).toBeGreaterThanOrEqual(2);
        // the title and the question, to their last character: each on one row, or on two when wider than the terminal
        const words = rows.map((l) => l.replace(/^ [▸ ]\d* +/, "").replace(/ {2,}(y +yes +n +no|n +not now) *$/, "").trim()).join(" ");
        expect(words, it.title).toContain(it.title);
        expect(words, it.ask).toContain(it.ask);
        if (it.ask.length > 75) wide++;
        if (it.title.length > 75) long++;
        asked++;
        if (!rows.some((l) => / y +yes +n +no| n +not now/.test(l))) alone++;
        // answered yes, the question is still whole, and the answer is marked: after it when there is room, before it when not
        if (it.edits) {
          const said = mine({ ...initialScreen(), sel: i, yes: [it.id] });
          expect(said.map((l) => l.replace(/^ +✓? */, "").replace(/ {2,}✓ yes *$/, "").trim()).join(" "), it.ask).toContain(it.ask);
          expect(said.some((l) => /✓ yes *$|^ {2}✓ {2}/.test(l)), it.ask).toBe(true);
        }
      }
    }
    expect(asked).toBeGreaterThanOrEqual(10);
    expect(long).toBeGreaterThan(0);
    expect(wide).toBeGreaterThan(0);
    // the consult's question is one of the long ones: whole, and its keys are still on the last row
    expect(alone).toBeGreaterThan(0);
    const consult = worlds[3], ci = derive(consult, initialScreen()).items.findIndex((n) => n.id === "consult");
    const shown = text(consult, { ...initialScreen(), sel: ci }, 80, 30);
    // the consult's question names every seat its yes frees (consult, judge and review), so it is wider than
    // 80 columns: it takes two rows, whole, and its keys are on the last row
    const at = shown.findIndex((l) => l.includes("Let claude-code:fable consult, judge and review?"));
    expect([shown[at], shown[at + 1]].map((l) => l.trim()).join(" ")).toBe("Let claude-code:fable consult, judge and review? It still takes no task of any shape.");
    expect(shown.at(-1)).toMatch(/y +yes +n +no/);
    const said = text(consult, { ...initialScreen(), sel: ci, yes: ["consult"] }, 80, 30);
    expect(said.find((l) => l.includes("Let claude-code:fable consult, judge and review?"))!).toMatch(/^ {2}✓ {2}Let claude-code:fable consult, judge and review\?/);
  });
  test("an opened line's row gives up its tier before it cuts why a model is not simply there to tick", () => {
    // the longest key of the config sets the key column; beside it, 80 columns do not hold a tier and a long reason
    const src = source({ repoText: "routing:\n  map:\n    docs:\n      pool:\n        mode: any\n        channels: [nosuch:a-model-no-cli-lists, codex:gpt-6-astra]\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    const docs = handLines(derive(src, initialScreen()).base!).find((l) => l.id === "docs")!;
    const shown = text(src, { ...initialScreen(), view: "pick", pick: { line: "docs", chosen: [...docs.current], at: docs.candidates.indexOf("nosuch:a-model-no-cli-lists"), mode: "any" } }, 80, 60);
    expect(shown.find((l) => /^ . \[1\] +nosuch:a-model-no-cli-lists/.test(l))!.trimEnd()).toMatch(/nosuch:a-model-no-cli-lists +not a configured model$/);
    // a row with room keeps its tier
    expect(shown.find((l) => l.includes("codex:gpt-6-astra "))!).toMatch(/codex:gpt-6-astra +frontier +takes all 400/);
    for (const l of shown.filter((x) => /^ . [[(]/.test(x))) expect(l, l).not.toContain("…");
    // at 60 columns the long reason gives way to a short word on the row, and is whole under the cursor
    const narrow = text(src, { ...initialScreen(), view: "pick", pick: { line: "docs", chosen: [...docs.current], at: docs.candidates.indexOf("nosuch:a-model-no-cli-lists"), mode: "any" } }, 60, 16);
    for (const l of narrow.filter((x) => /^ . [[(]/.test(x))) expect(l, l).not.toContain("…");
    expect(narrow.find((l) => l.includes("nosuch:a-model-no-cli-lists "))!.trimEnd()).toMatch(/nosuch:a-model-no-cli-lists +not listed$/);
    expect(narrow.map((l) => l.trim()).join(" ")).toContain("nosuch:a-model-no-cli-lists is named on this line, and no CLI in the config lists it.");
  });
  test("the details say each change a yes makes whole: a label wider than the terminal takes another row", () => {
    // a long key makes the label for the workers' deny wider than 80 columns
    const src = source({ repoText: "routing:\n  deny:\n    models: [prime-agent:prime-inference/z-ai/glm-5.2]\nconsult:\n  prefer: [prime-agent:prime-inference/z-ai/glm-5.2]\n" });
    const d = derive(src, initialScreen()), i = d.items.findIndex((n) => n.id === "consult");
    const label = d.items[i].edits!.find((e) => e.label.includes("denied for all work"))!.label;
    expect(label.length).toBeGreaterThan(80 - 5);
    for (const cols of [80, 60]) {
      const shown = text(src, { ...initialScreen(), sel: i, view: "detail" }, cols, 40);
      const from = shown.findIndex((l) => l.includes("Yes changes:"));
      expect(shown.slice(from).map((l) => l.replace(/^ +·? */, "").trimEnd()).join(" "), String(cols)).toContain(label);
      for (const l of shown.slice(from, from + 6)) expect(l, l).not.toContain("…");
    }
  });
  test("the review's better and worse are never pushed off the row, and the config error says its last word, at 80 and 60 columns", () => {
    // the consult gets a model with a long name: the value is long, and the word after it is the row's meaning
    const src = source({ repoText: "routing:\n  deny:\n    models: [cursor-agent:claude-fable-5-1]\nconsult:\n  prefer: [cursor-agent:claude-fable-5-1]\n" });
    const st = { ...initialScreen(), yes: ["consult"], view: "review" as const };
    for (const cols of [80, 60]) {
      const row = text(src, st, cols, 40).find((l) => l.includes("consult model"))!;
      expect(row.trimEnd(), `${cols}: ${row}`).toMatch(/nobody → claude-fable-5-1 {3}better$/);
      // and the counts above it are whole too
      expect(text(src, st, cols, 40).find((l) => l.includes("tasks that change worker"))!.trimEnd()).toMatch(/\d of 3,600$/);
    }
    const broken = source({ repoText: "routing:\n  mode: partner-lead\n" });
    for (const cols of [80, 60]) expect(text(broken, initialScreen(), cols, 24).map((l) => l.trim()).join(" "), String(cols)).toContain("for the same reason. Nothing was changed.");
  });
  test("a message longer than the terminal is wide takes a second row instead of losing its end", () => {
    const src = source();
    const msg = "Not saved: .tickmarkr/config.yaml changed while this screen was open. This is the new file: answer again.";
    for (const [cols, rows] of [[60, 16], [80, 24], [120, 36]] as const) {
      const lines = frame(src, { ...initialScreen(), msg }, cols, rows).map((l) => l.map((x) => x.text).join(""));
      expect(lines.length, `${cols}x${rows}`).toBe(rows);
      expect(lines.every((l) => [...l].length === cols), `${cols}x${rows}`).toBe(true);
      expect(lines.join(" ").replace(/\s+/g, " "), `${cols}x${rows}`).toContain(msg);
      // the keys stay on the last row, and what needs the user is still on screen
      expect(lines[rows - 1]).toContain("quit");
      expect(lines.join("\n")).toContain("NEEDS YOU");
    }
  });
  test("the review shows a changed line whole, on as many rows as it takes, at any width", () => {
    // the deny list is one long line, and the answer removes its last entry: past the edge at 80 columns
    const filler = Array.from({ length: 6 }, (_, i) => `omp:vendor/some-long-model-name-${i}`).join(", ");
    const repoText = `routing:\n  deny:\n    models: [${filler}, claude-code:fable]\nconsult:\n  prefer: [claude-code:fable]\n`;
    const src = source({ repoText });
    const st = { ...initialScreen(), yes: ["consult"], view: "review" as const };
    for (const cols of [60, 80, 120]) {
      const lines = frame(src, st, cols, 60).map((l) => l.map((x) => x.text).join(""));
      const from = lines.findIndex((l) => l.includes("TO BE SAVED IN"));
      const diff = lines.slice(from).join("\n");
      expect(diff, `${cols} columns`).toContain("claude-code:fable");
      expect(lines.every((l) => [...l].length === cols), `${cols} columns`).toBe(true);
      // the removed line reads back whole once its rows are joined
      const shown = lines.slice(from + 1).map((l) => l.slice(7)).join("").replace(/\s/g, "");
      expect(shown, `${cols} columns`).toContain(`models:[${filler},claude-code:fable]`.replace(/\s/g, ""));
      expect(shown, `${cols} columns`).toContain(`models:[${filler}]`.replace(/\s/g, ""));
      // what goes is listed before what comes
      const ops = lines.slice(from + 1).map((l) => l[5]).filter((c) => c === "+" || c === "-").join("");
      expect(ops, `${cols} columns`).toMatch(/^-\+/);
    }
  });
  test("keys: y answers, u undoes, Enter reviews, y saves the candidate bytes, n dismisses, q reports what is unsaved", () => {
    const src = source({ health: health(["claude-code:fable"]) });
    expect(press(src, initialScreen(), "enter").state.msg).toContain("Nothing to save yet");
    const yes = press(src, initialScreen(), "y").state;
    expect(yes.yes).toEqual(["setup"]);
    expect(press(src, yes, "u").state.yes).toEqual([]);
    expect(press(src, yes, "q").action).toEqual({ kind: "quit", unsaved: 1 });
    const review = press(src, yes, "enter").state;
    expect(review.view).toBe("review");
    expect(text(src, review).join("\n")).toMatch(/shapes with no model\s+2 → 0\s+better/);
    // the review names the file before it is written, and never calls it saved
    expect(text(src, review).join("\n")).toMatch(/nothing is saved until you press y[\s\S]*TO BE SAVED IN /);
    expect(text(src, review).join("\n")).not.toContain("SAVED TO");
    const saved = press(src, review, "y");
    expect(saved.action).toMatchObject({ kind: "save", touched: ["repo"] });
    expect(saved.state).toEqual(initialScreen());
    expect(press(src, initialScreen(), "n").action).toEqual({ kind: "dismiss", id: "setup" });
    expect(press(src, initialScreen(), "r").action).toEqual({ kind: "probe", keep: { yes: [], hand: [] } });
  });
  test("u undoes the last answer, a no as well as a yes, newest first", () => {
    const src = source({ health: health(["claude-code:fable"]) });
    const [first, second] = derive(src, initialScreen()).items;
    // yes to the first item, then no to the second
    const yes = press(src, initialScreen(), "y").state;
    const no = press(src, yes, "n");
    expect(no.action).toEqual({ kind: "dismiss", id: second.id });
    expect(no.state.msg).toBe("Left as it is: not asked again until something changes. u undoes.");
    const refused: ScreenSource = { ...src, ctx: { dismissed: new Set([needSignature(second)]) } };
    expect(derive(refused, no.state).items.map((n) => n.id)).not.toContain(second.id);
    expect(text(refused, no.state, 100).at(-1)).toMatch(/u\s+undo/);
    // the first u takes back the no: the caller is told which, and the item is asked again
    const back = press(refused, no.state, "u");
    expect(back.action).toEqual({ kind: "restore", signature: needSignature(second) });
    expect(back.state.msg).toBe("Last no undone: it is asked again.");
    expect(back.state.yes).toEqual([first.id]);
    // the second u takes back the yes; a third has nothing left
    const none = press(src, back.state, "u");
    expect(none.action).toBeUndefined();
    expect(none.state.yes).toEqual([]);
    expect(press(src, none.state, "u")).toEqual({ state: { ...none.state, msg: "" } });
    // a no to an item already answered yes withdraws that yes, and one u brings the item back unanswered
    const both = press(src, press(src, initialScreen(), "y").state, "up").state;
    const withdrawn = press(src, both, "n").state;
    expect(withdrawn.yes).toEqual([]);
    expect(withdrawn.log).toEqual([`n:${needSignature(first)}`]);
  });
  test("a config with a pin and a pool in one slot does not load, and the screen reports the loader's own message", () => {
    const d = derive(source({ repoText: "routing:\n  map:\n    spec:\n      pin: { via: codex, model: gpt-6-astra }\n      pool: { mode: any, channels: [codex:gpt-6-astra] }\n" }), initialScreen());
    expect(d.base).toBeUndefined();
    expect(d.error).toContain("pin and pool are one declaration");
  });
  test("the plain screen shows every item whole, the ones wider than the terminal on a second row", () => {
    // a judge and a consult with a long key that do not answer, and a model out of quota that much rests on:
    // two titles and a question wider than 80 columns, which is one row more than two rows an item leave spare
    const h = health(["prime-agent:prime-inference/z-ai/glm-5.2"]);
    h["claude-code"].modelAuth!.fable = { authed: false, reason: "You have hit your usage limit.", probedAt: "2026-11-10T00:00:00Z" } as never;
    // ... and nine shapes each with a pool of its own, so the team is as tall as it gets and nothing is left spare
    // (plan rests on the model that is out of quota, which is what makes that item's question long)
    const nine = ["claude-code:fable", "codex:gpt-6-sol", "codex:gpt-5.6-sol", "codex:gpt-5.6-terra", "cursor-agent:composer-2.5", "pi:zai/glm-5.3", "pi:zai/glm-5.2", "grok:grok-4.5", "claude-code:opus"];
    const pools = ["plan", "spec", "implement", "tests", "docs", "migration", "ui", "refactor", "chore"].map((sh, i) => `    ${sh}:\n      pool:\n        mode: any\n        channels: [${nine[i]}]\n`).join("");
    const src = source({ health: h, repoText: `judge:\n  adapter: prime-agent\n  model: prime-inference/z-ai/glm-5.2\nconsult:\n  prefer: [prime-agent:prime-inference/z-ai/glm-5.2]\nrouting:\n  map:\n${pools}` });
    expect(teamRows(derive(src, initialScreen()).base!).filter((r) => r.section === "workers")).toHaveLength(9);
    const items = derive(src, initialScreen()).items;
    expect(items.filter((it) => it.title.length > 75 || it.ask.length > 75).length).toBeGreaterThanOrEqual(3);
    for (const cols of [80, 100]) {
      const out = plainScreen(src, cols), flat = out.split("\n").map((l) => l.trim()).join(" ");
      expect(out, String(cols)).not.toContain("more below");
      for (const it of items) {
        expect(flat, it.title).toContain(it.title);
        expect(flat, it.ask).toContain(it.ask);
      }
    }
  });
  test("a probe keeps what was answered and changed by hand and not yet saved, and drops only what no longer applies", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [codex:gpt-6-astra]\n` });
    const items = derive(src, initialScreen()).items;
    const floor = items.find((n) => n.id === "floor")!;
    // one yes and one line changed by hand, then r: the action carries both
    const st = { ...initialScreen(), sel: items.indexOf(floor), yes: ["floor"], hand: [{ line: "judge", chosen: ["codex:gpt-6-astra"] }], log: ["y:floor", "h:judge"] };
    const pressed = press(src, st, "r");
    expect(pressed.action).toEqual({ kind: "probe", keep: { yes: ["floor"], hand: [{ line: "judge", chosen: ["codex:gpt-6-astra"] }] } });
    // r from the list of lines probes too; inside an opened line it does nothing
    expect(press(src, { ...st, view: "lines" }, "r").action).toMatchObject({ kind: "probe", keep: { yes: ["floor"] } });
    const opened = press(src, { ...initialScreen(), view: "lines" }, "enter").state;
    expect(press(src, opened, "r")).toEqual({ state: opened });
    expect(text(src, { ...initialScreen(), view: "lines" }, 80, 24).at(-1)).toMatch(/r +probe/);
    // the screen reopens on the same source: both are still there, counted, undoable, and not saved
    const same = resumeScreen(src, pressed.action!.kind === "probe" ? pressed.action.keep : undefined);
    expect(same.state).toMatchObject({ view: "home", yes: ["floor"], hand: [{ line: "judge", chosen: ["codex:gpt-6-astra"] }], log: ["y:floor", "h:judge"] });
    expect(same.note).toBe("1 answered yes, 1 changed by hand: kept through the probe, not saved yet.");
    expect(press(src, same.state, "u").state).toMatchObject({ hand: [], yes: ["floor"] });
    // an item the probe made go away, and a line that no longer exists: dropped, and said; the hand change that still applies stays
    const fixed = source({ repoText: "routing:\n  mode: partner-led\n  map:\n    implement:\n      pool:\n        mode: any\n        channels: [codex:gpt-6-astra]\nconsult:\n  prefer: [codex:gpt-6-astra]\n" });
    expect(derive(fixed, initialScreen()).items.some((n) => n.id === "floor")).toBe(false);
    expect(resumeScreen(fixed, { yes: ["floor"], hand: [] })).toEqual({ state: initialScreen(), note: "1 no longer applies and was dropped." });
    const gone = resumeScreen(fixed, { yes: ["no-such-item"], hand: [{ line: "judge", chosen: ["codex:gpt-6-astra"] }, { line: "no-such-line", chosen: ["codex:gpt-6-astra"] }] });
    expect(gone.state).toMatchObject({ yes: [], hand: [{ line: "judge", chosen: ["codex:gpt-6-astra"] }] });
    expect(gone.note).toBe("1 changed by hand: kept through the probe, not saved yet. 2 no longer apply and were dropped.");
    // nothing pending: the screen opens as it always did, with nothing more to say
    expect(resumeScreen(src, { yes: [], hand: [] })).toEqual({ state: initialScreen(), note: "" });
    expect(resumeScreen(src)).toEqual({ state: initialScreen(), note: "" });
  });
  test("the plain screen carries no selection and no keys", () => {
    const out = plainScreen(source({ health: health(["claude-code:fable"]) }));
    expect(out).toContain(" NEEDS YOU (");
    expect(out).not.toContain("▸");
    expect(out).not.toMatch(/ y {2}yes/);
  });
});

describe("new models", () => {
  test("a malformed first-seen record is not carried into the next probe's write, and never dates a model as new", () => {
    const at = new Date("2026-11-10T00:00:00Z");
    for (const bad of ["yesterday", 7, [1, 2], { omp: "soon", codex: ["a"], qwen: null, grok: {} }, { omp: { "google/gemini-3.8-flash": 12345 } }]) {
      const next = withFirstSeen(bad, health(), at);
      // only adapters that map models to strings, and every model on its baseline
      for (const [adapter, models] of Object.entries(next)) {
        expect(Object.keys(DEFAULT_CONFIG.tiers), JSON.stringify(bad)).toContain(adapter);
        // a date appears only for a model the adapter's own well-formed record did not have
        const held = (bad as Record<string, unknown>)?.[adapter];
        const dated = Object.entries(models).filter(([, v]) => v !== "").map(([m]) => m);
        if (!(held && typeof held === "object" && !Array.isArray(held) && Object.keys(held).length)) expect(dated, `${JSON.stringify(bad)} ${adapter}`).toEqual([]);
      }
    }
    // a date that is not a string is the baseline, not "now": the model it belongs to is not new
    expect(withFirstSeen({ omp: { "google/gemini-3.8-flash": 12345 } }, health(), at).omp["google/gemini-3.8-flash"]).toBe("");
    // the well-formed part of a record survives beside the malformed part
    const mixed = withFirstSeen({ codex: { "gpt-6-astra": "2026-10-01T00:00:00.000Z" }, omp: "soon" }, health(), at);
    expect(mixed.codex["gpt-6-astra"]).toBe("2026-10-01T00:00:00.000Z");
    expect(mixed.codex["gpt-6-sol"]).toBe("2026-11-10T00:00:00.000Z");
    expect(new Set(Object.values(mixed.omp))).toEqual(new Set([""]));
  });
});
