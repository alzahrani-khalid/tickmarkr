// YOUR TEAM and NEEDS YOU as the screen derives and draws them, through the product's own router
// with stub adapters and hand-written doctor results. No model is called.
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { buildFleetModel, consequence, verdictOf } from "../../src/fleet/model.js";
import { needs, needSignature, type NewModel } from "../../src/fleet/needs.js";
import { derive, errorFiles, errorWhere, frame, initialScreen, plainScreen, press, type ScreenSource, teamRows } from "../../src/fleet/screen.js";
import { layerDiff } from "../../src/fleet/edits.js";
import { width } from "../../src/fleet/draw.js";
import { health, NOW, POOL, source } from "./world.js";
import { keys, text } from "./drive.js";

describe("YOUR TEAM", () => {
  test("names the workers by shape, the seven gates in order, and the consult", () => {
    const rows = teamRows(buildFleetModel(source().inputs));
    expect(rows.filter((r) => r.section === "gates").map((r) => r.label)).toEqual(["build, test, lint", "evidence, scope", "acceptance (judge)", "review (another vendor)"]);
    expect(rows.filter((r) => r.section === "consult").map((r) => r.label)).toEqual(["consult", "overseer skill"]);
    // every team line is whole on an 80-column terminal: nothing in the middle column is cut
    for (const l of text(source({ health: health(["claude-code:fable"]) }), initialScreen(), 80, 30).slice(1, 15)) expect(l, l).not.toMatch(/…\s+(ok|NO MODEL|CANNOT START|does not answer)\s*$/);
    const shapes = rows.filter((r) => r.section === "workers").flatMap((r) => r.label.split(", "));
    expect(shapes.sort()).toEqual(["chore", "docs", "implement", "migration", "plan", "refactor", "spec", "tests", "ui"]);
  });
  test("a line says what is wrong: a pinned model that did not answer leaves its shapes with NO MODEL", () => {
    const rows = teamRows(buildFleetModel(source({ health: health(["claude-code:fable"]) }).inputs));
    expect(rows.find((r) => r.label.includes("plan"))).toMatchObject({ status: "NO MODEL", models: [] });
    expect(rows.find((r) => r.label === "consult")).toMatchObject({ status: "NO MODEL" });
    expect(rows.find((r) => r.label.startsWith("acceptance"))).toMatchObject({ status: "does not answer" });
  });
  test("every frame is exactly the terminal's size, in every view and state", () => {
    const srcs = [source(), source({ health: health(["claude-code:fable"]) }), source({ health: null }), source({ repoText: "routing:\n  mode: partner-lead\n" })];
    for (const src of srcs) for (const [cols, rows] of [[80, 24], [120, 36], [60, 16]]) for (const ks of [[], ["d"], ["y", "enter"], ["down", "n"]]) {
      const lines = text(src, keys(src, ...ks), cols, rows);
      expect(lines).toHaveLength(rows);
      for (const l of lines) expect([...l]).toHaveLength(cols);
    }
  });
  test("a short terminal draws only the team lines that are not ok, so what needs you is never pushed off the screen", () => {
    const src = source({ health: health(["claude-code:fable"]) });
    const small = text(src, initialScreen(), 60, 16).join("\n");
    expect(small).toMatch(/YOUR TEAM {2}\d+ of \d+ lines ok; these are not:/);
    expect(small).toContain("NO MODEL");
    expect(small).toContain("NEEDS YOU (");
    expect(small).toContain("First setup:");
    expect(small).not.toContain("build, test, lint");
    // the full team returns as soon as it fits
    expect(text(src, initialScreen(), 80, 24).join("\n")).toContain("build, test, lint");
  });
  test("a short terminal keeps a lowered floor's mark: a line ok against its own floor is drawn, never folded into the ok count", () => {
    const repoText = "routing:\n  mode: partner-led\n  floors:\n    implement: cheap\nconsult:\n  prefer: [claude-code:fable]\n";
    // the whole input class: healthy and failing teams, every size that folds the team or not
    for (const dead of [[], ["claude-code:fable"]]) for (const [cols, rows] of [[60, 16], [80, 24], [120, 36], [60, 20]]) {
      const src = source({ repoText, health: health(dead) });
      expect(teamRows(derive(src, initialScreen()).base!).some((r) => r.status === "ok, floor cheap")).toBe(true);
      const out = text(src, initialScreen(), cols, rows).join("\n");
      expect(out, `${dead} ${cols}x${rows}`).toContain("ok, floor cheap");
      expect(out).not.toMatch(/all \d+ lines ok\s*$/m);
    }
  });
  test("a lowered floor is always named on the closed screen, at every size and however many lines are wrong", () => {
    // the reviewer's world: six warning rows before the lowered floor's row at 60x16
    const low = [["implement", "codex:gpt-6-luna"], ["tests", "claude-code:haiku"], ["docs", "grok:grok-composer-2.5-fast"]];
    const bad = [["plan", "codex:gpt-5.6-terra"], ["spec", "claude-code:sonnet"], ["migration", "cursor-agent:composer-2.5"], ["ui", "opencode:zai-coding-plan/glm-5.2"], ["refactor", "grok:grok-4.5"], ["chore", "kimi:kimi-code/kimi-for-coding"]];
    const pool = ([s, m]: string[]) => `    ${s}:\n      pool: { mode: any, channels: [${m}] }\n`;
    for (const L of [0, 1, 3]) for (const W of [0, 6, 9]) {
      const lo = low.slice(0, L), ba = bad.slice(0, Math.min(W, 6)), map = [...lo, ...ba];
      const repoText = `routing:\n  mode: partner-led\n${L ? `  floors:\n${lo.map(([s]) => `    ${s}: cheap\n`).join("")}` : ""}${map.length ? `  map:\n${map.map(pool).join("")}` : ""}consult:\n  prefer: [${W === 9 ? "claude-code:fable" : "codex:gpt-6-astra"}]\n`;
      const src = source({ repoText, health: health(W === 9 ? ["claude-code:fable"] : []) });
      const rows = teamRows(derive(src, initialScreen()).base!);
      expect(rows.filter((r) => !r.status.startsWith("ok")).length, `${L} ${W}`).toBe(W);
      expect(rows.filter((r) => r.status.startsWith("ok,")).length, `${L} ${W}`).toBe(L);
      for (const cols of [40, 60, 80, 120]) for (const h of [10, 16, 24, 40]) {
        const out = text(src, initialScreen(), cols, h).join("\n"), at = `${L} lowered, ${W} wrong, ${cols}x${h}\n${out}`;
        const notice = /YOUR TEAM {2}\d+ on (its|their) own floor;/.test(out);
        if (L) expect(notice || /ok, floor cheap/.test(out), at).toBe(true);
        else expect(notice, at).toBe(false);
      }
    }
    expect(width(" YOUR TEAM  3 on their own floor;")).toBeLessThanOrEqual(40);
  });
  test("a config that does not load draws no team and says where to look", () => {
    const out = text(source({ repoText: "routing:\n  mode: partner-lead\n" })).join("\n");
    expect(out).toContain("THE CONFIG DOES NOT LOAD");
    expect(out).not.toContain("WORKERS");
    // the file the error is in is named: a line number in the loader's message is a line of that file
    expect(out).toMatch(/ It is in:\s*\n {2}\/r\/\.tickmarkr\/config\.yaml\s*\n {2}Correct it there, then open fleet again\./);
    expect(out).not.toContain("/u/config.yaml");
  });
  test("a config that does not load names the file the error is in: the user's, or both; a long path wraps and is never cut", () => {
    const bad = "routing:\n  mode: partner-lead\n";
    const said = (src: ScreenSource, cols = 100) => text(src, initialScreen(), cols, 24).map((l) => l.trim()).join(" ");
    // in the user config only: the repository's file is not named, and a syntax error is placed the same way
    for (const userText of [bad, "routing: [unclosed\n"]) {
      const user = source({ userText, repoText: "review:\n  required: true\n" });
      expect(derive(user, initialScreen()).errorIn).toEqual(["user"]);
      expect(said(user)).toContain("It is in: /u/config.yaml Correct it there, then open fleet again.");
      expect(said(user)).not.toContain("/r/.tickmarkr/config.yaml");
    }
    // in both
    const both = source({ userText: bad, repoText: bad });
    expect(derive(both, initialScreen()).errorIn).toEqual(["repo", "user"]);
    expect(said(both)).toContain("Neither file loads: /r/.tickmarkr/config.yaml /u/config.yaml Correct both, then open fleet again.");
    expect(said(source({ repoText: bad }))).toContain("It is in: /r/.tickmarkr/config.yaml Correct it there, then open fleet again.");
    // when neither file fails on its own, no file is blamed: both are named as places to look
    expect(errorWhere(both, [])).toBe("Correct that value in /r/.tickmarkr/config.yaml or in /u/config.yaml, then open fleet again.");
    // a path longer than the terminal is wide takes more rows: every character of it is on the screen, and no row ends in a cut mark
    const long = `/Users/someone/${"a-long-folder-name/".repeat(6)}tickmarkr/config.yaml`;
    const far = { ...source({ userText: bad }), paths: { user: long, repo: "/r/.tickmarkr/config.yaml" } };
    for (const cols of [60, 80, 100]) {
      const rows = text(far, initialScreen(), cols, 24);
      expect(rows.map((l) => l.trim()).join(""), String(cols)).toContain(long);
      expect(rows.filter((l) => l.includes("…")), String(cols)).toEqual([]);
    }
  });
  test("a config error taller than the terminal scrolls to its end, and the plain output prints all of it", () => {
    const bad = "routing:\n  mode: partner-lead\n";
    for (const [n, cols, rows] of [[24, 60, 16], [50, 60, 24], [50, 100, 24]] as const) {
      const long = `/Users/someone/${"a-long-folder-name/".repeat(n)}tickmarkr/config.yaml`;
      const far = { ...source({ userText: bad }), paths: { user: long, repo: "/r/.tickmarkr/config.yaml" } };
      // every row of every scroll position, in order, each new row once: down until the frame stops changing
      let st = initialScreen(), seen: string[] = [], last = "";
      for (let i = 0; i < 200; i++) {
        const body = text(far, st, cols, rows).slice(1, rows - 2);
        if (body.join("\n") === last) break;
        seen = i ? [...seen, body[body.length - 1]] : body; last = body.join("\n");
        st = press(far, st, "down", { cols, rows }).state;
      }
      const all = seen.map((l) => l.trim()).join("");
      expect(all, `${n} ${cols}x${rows}`).toContain(long);
      expect(all, `${n} ${cols}x${rows}`).toContain("then open fleet again.A run refuses");
      expect(plainScreen(far, cols).split("\n").map((l) => l.trim()).join(""), `${n} plain ${cols}`).toContain(long);
    }
  });
  test("a file location is shown exactly, never through the word-wrapper: repeated spaces and a path longer than three rows come back byte for byte", () => {
    const bad = "routing:\n  mode: partner-lead\n";
    const spaced = `/Users/someone/${"a  folder/".repeat(7)}tickmarkr/config.yaml`;
    const tall = `/Users/someone/${"a long  folder name/".repeat(12)}tickmarkr/config.yaml`;
    for (const path of [spaced, tall]) {
      const worlds: Array<[string, ScreenSource]> = [
        ["user", { ...source({ userText: bad }), paths: { user: path, repo: "/r/.tickmarkr/config.yaml" } }],
        ["repo", { ...source({ repoText: bad }), paths: { user: "/u/config.yaml", repo: path }, labels: undefined }],
        ["inherited", { ...source({ repoText: bad }), inherited: path }],
      ];
      for (const [where, src] of worlds) for (const cols of [40, 60, 100]) {
        // the rows between "It is in:" and the sentence after it, each without its two-cell margin
        const between = (rows: string[]) => { const a = rows.findIndex((l) => l.trim() === "It is in:"), b = rows.findIndex((l) => l.trim().startsWith("Correct it there"));
          return rows.slice(a + 1, b).map((l) => l.slice(2).replace(/ +$/, "")).join(""); };
        const framed = text(src, initialScreen(), cols, 200);
        if (path === tall) expect(between(framed).length, `${where} ${cols}`).toBe(path.length);
        expect(framed.findIndex((l) => l.trim() === "It is in:"), `${where} ${cols}`).toBeGreaterThan(0);
        expect(between(framed), `${where} ${cols}`).toBe(path);
        expect(between(plainScreen(src, cols).split("\n")), `${where} plain ${cols}`).toBe(path);
        if (path === tall && cols === 40) expect(framed.filter((l) => /^ {2}\/Users|^ {2}[a-z ]/.test(l)).length).toBeGreaterThan(3);
      }
    }
  });
  test("a file location keeps its significant whitespace in plain output: a run of spaces wider than a row, U+00A0 and U+3000 at a row's end", () => {
    const bad = "routing:\n  mode: partner-lead\n";
    // the reviewer's paths (D-2187 add.247 review): a whitespace-only row, and Unicode whitespace that trimEnd() would drop
    const paths = ["/tmp/a" + " ".repeat(120) + "b/config.yaml", "/u" + " ".repeat(60) + "/config.yaml",
      "/tmp/" + "a".repeat(90) + "\u00a0b/config.yaml", "/tmp/" + "a".repeat(89) + "\u3000b/config.yaml"];
    const between = (rows: string[]) => { const a = rows.findIndex((l) => l.trim() === "It is in:"), b = rows.findIndex((l) => l.trim().startsWith("Correct it there"));
      return rows.slice(a + 1, b).map((l) => l.slice(2)).join(""); };
    for (const path of paths) {
      const worlds: ScreenSource[] = [{ ...source({ userText: bad }), paths: { user: path, repo: "/r/.tickmarkr/config.yaml" } },
        { ...source({ repoText: bad }), paths: { user: "/u/config.yaml", repo: path }, labels: undefined }, { ...source({ repoText: bad }), inherited: path }];
      for (const src of worlds) for (const cols of [40, 60, 100]) expect(between(plainScreen(src, cols).split("\n")), `${JSON.stringify(path)} ${cols}`).toBe(path);
    }
    // the rest of the plain output is still trimmed of the frame's padding
    expect(plainScreen(source({ userText: bad }), 100).split("\n").filter((l) => !l.includes("/u/") && / $/.test(l))).toEqual([]);
  });
  test("a config error names the file it was read from, and both files when neither fails on its own", () => {
    const bad = "routing:\n  mode: partner-lead\n";
    // a linked worktree reads the main checkout's file: that file is named, never the worktree's own that does not exist
    const linked: ScreenSource = { ...source({ repoText: bad }), inherited: "/main/.tickmarkr/config.yaml" };
    const d = derive(linked, initialScreen());
    expect(errorWhere(linked, d.errorIn)).toBe("It is in /main/.tickmarkr/config.yaml. Correct it there, then open fleet again.");
    expect(errorFiles(linked, d.errorIn)).toEqual(["/main/.tickmarkr/config.yaml"]);
    expect(text(linked, initialScreen(), 100, 24).join(" ")).not.toContain("/r/.tickmarkr/config.yaml");
    // each file loads alone and their merge does not: both are named, as paths too
    const merged = source({ userText: "tiers:\n  codex:\n    models:\n      my-private-model: mid\n",
      repoText: `tiers:\n  codex:\n    vendor: null\n    modelOverrides:\n${Object.keys(DEFAULT_CONFIG.tiers.codex.models).map((m) => `      ${JSON.stringify(m)}: { vendor: openai }\n`).join("")}` });
    const m = derive(merged, initialScreen());
    if (m.base) return expect.fail("this merge was expected not to load");
    expect(m.errorIn).toEqual([]);
    expect(errorFiles(merged, m.errorIn)).toEqual(["/r/.tickmarkr/config.yaml", "/u/config.yaml"]);
  });
});

describe("NEEDS YOU", () => {
  test("first setup changes what is missing and nothing else: a shape that has a working model keeps it", () => {
    // plan and spec have nobody, the judge does not answer, the consult has nobody
    const src = source({ health: health(["claude-code:fable"]) });
    const item = derive(src, initialScreen()).items[0];
    expect(item).toMatchObject({ id: "setup", title: "First setup: nobody for plan, spec, the judge and the consult.", ask: "Use models that answered for what is missing?" });
    expect(item.edits!.map((e) => e.path.join("."))).toEqual(["routing.map.plan", "routing.map.spec", "judge", "consult.prefer"]);
    const d = derive(src, { ...initialScreen(), yes: ["setup"] });
    // the 800 sample tasks of plan and spec get a worker; no other task changes worker
    expect(consequence(d.base!, d.full!).workers).toBe(800);
    for (const shape of ["implement", "tests", "docs", "migration", "ui", "refactor", "chore"] as const) {
      expect(d.full!.sample().rows[shape].picks.map((p) => p[0]), shape).toEqual(d.base!.sample().rows[shape].picks.map((p) => p[0]));
      expect(d.full!.cfg.routing.map[shape]?.pool, shape).toBeUndefined();
    }
    expect(teamRows(d.full!).every((r) => r.status === "ok")).toBe(true);
    // a file that did not exist is all additions: no row for a line it never had
    const rows = text(src, { ...initialScreen(), yes: ["setup"], view: "review" }, 100, 80);
    const from = rows.findIndex((l) => l.includes("TO BE SAVED IN"));
    const diff = rows.slice(from + 1).filter((l) => l.trim());
    expect(diff.slice(0, -1).every((l) => /^ {5}\+ /.test(l)), diff.join("\n")).toBe(true);
  });
  test("first setup: a yes builds the team from the models that answered, and leaves no line without a model", () => {
    const src = source({ health: health(["claude-code:fable"]) });
    const d = derive(src, keys(src, "y"));
    expect(d.items[0].id).toBe("setup");
    expect(d.full!.sample().noSeat).toEqual([]);
    expect(d.full!.consult).not.toBeNull();
    expect(teamRows(d.full!).every((r) => r.status === "ok")).toBe(true);
    // a model that did not answer is never proposed
    expect(d.edits.flatMap((e) => JSON.stringify(e.value))).not.toContain("claude-code:fable");
  });
  test("a first install is one with no fleet key in either layer: the config file init writes does not end it", () => {
    const template = "# tickmarkr config overlay\nconcurrency: 3\nvisibility:\n  llm: pane\n# routing:\n#   mode: partner-led\n";
    const first = derive(source({ repoText: template, health: health(["claude-code:fable"]) }), initialScreen()).items;
    expect(first[0].id).toBe("setup");
    // one fleet key and the same repository is no longer a first install: it is asked item by item
    const later = derive(source({ repoText: `${template}review:\n  required: true\n`, health: health(["claude-code:fable"]) }), initialScreen()).items;
    expect(later.map((n) => n.id)).not.toContain("setup");
    expect(later.map((n) => n.id)).toEqual(expect.arrayContaining(["noseat", "judge", "consult"]));
  });
  test("the judge: a judge that does not answer is replaced, on a yes, by the strongest working model that may judge", () => {
    const src = source({ repoText: "review:\n  required: true\n", health: health(["claude-code:fable"]) });
    const d0 = derive(src, initialScreen());
    expect(teamRows(d0.base!).find((r) => r.label.startsWith("acceptance"))).toMatchObject({ status: "does not answer" });
    const item = d0.items.find((n) => n.id === "judge")!;
    expect(item.title).toBe("The judge (acceptance) does not answer: claude-code:fable, no answer.");
    expect(item.ask).toMatch(/^Use \S+ as the judge\?$/);
    const d = derive(src, { ...initialScreen(), yes: ["judge"] });
    expect(teamRows(d.full!).find((r) => r.label.startsWith("acceptance"))!.status).not.toBe("does not answer");
    expect(d.full!.seat(`${d.full!.cfg.judge.adapter}:${d.full!.cfg.judge.model}`)!.live.judge).toBe(true);
    expect(d.items.some((n) => n.id === "judge")).toBe(true); // the list is stable while you answer
    // a judge that answers is never asked about
    expect(derive(source({ repoText: "review:\n  required: true\n" }), initialScreen()).items.some((n) => n.id === "judge")).toBe(false);
  });
  test("the judge: a judge that answers but is kept out by a rule is said to be kept out, not to be silent", () => {
    const barred = derive(source({ repoText: "routing:\n  deny:\n    models: [claude-code:fable]\nreview:\n  required: true\n" }), initialScreen());
    const item = barred.items.find((n) => n.id === "judge")!;
    expect(item.title).toBe("The judge (acceptance) is kept out by a deny rule: claude-code:fable.");
    expect(item.title).not.toContain("passed");
    expect(item.title.length).toBeLessThanOrEqual(75); // whole on an 80-column row
    expect(teamRows(barred.base!).find((r) => r.label.startsWith("acceptance"))!.status).not.toBe("does not answer");
    const listed = derive(source({ repoText: "routing:\n  allow:\n    adapters: [codex]\nreview:\n  required: true\n" }), initialScreen());
    expect(listed.items.find((n) => n.id === "judge")!.title).toBe("The judge (acceptance) is not on the allowlist: claude-code:fable.");
  });
  test("the consult: a model that answers but is denied for every seat is offered, denied for workers only", () => {
    const repoText = "routing:\n  deny:\n    models:\n      # never writes code\n      - claude-code:fable\nconsult:\n  prefer: [claude-code:fable]\n";
    const src = source({ repoText });
    const d0 = derive(src, initialScreen());
    expect(d0.base!.consult).toBeNull();
    const item = d0.items.find((n) => n.id === "consult")!;
    expect(item.ask).toBe("Let claude-code:fable consult, judge and review? It still takes no task of any shape.");
    const d = derive(src, { ...initialScreen(), yes: ["consult"] });
    expect(d.full!.consult).toBe("claude-code:fable");
    expect(d.full!.seat("claude-code:fable")!.denied.worker).not.toBeNull();
    expect(d.texts!.repoText).toContain("workers:");
    expect(d.texts!.repoText).toContain("# never writes code");
  });
  test("the consult: a model that did not answer is not offered; the item says what to do", () => {
    const src = source({ repoText: "consult:\n  prefer: [claude-code:fable]\n", health: health(["claude-code:fable"]) });
    const item = derive(src, initialScreen()).items.find((n) => n.id === "consult")!;
    expect(item.edits).toBeUndefined();
    expect(item.title).toContain("claude-code:fable, no answer");
  });
  test("shapes below their floor: a yes changes which models are in the pool, never the pool's mode", () => {
    // an ordered pool that tries the model below the floor first, so every task lands there
    const pool = "routing:\n  mode: partner-led\n  map:\n    implement:\n      pool:\n        mode: ordered\n        channels:\n          - codex:gpt-5.6-terra\n          - codex:gpt-6-astra\n";
    const ordered = source({ repoText: `${pool}consult:\n  prefer: [claude-code:fable]\n` });
    expect(derive(ordered, initialScreen()).items.some((n) => n.id === "floor")).toBe(true);
    const d = derive(ordered, { ...initialScreen(), yes: ["floor"] });
    expect(d.full!.cfg.routing.map.implement!.pool).toEqual({ mode: "ordered", channels: ["codex:gpt-6-astra"] });
    expect(d.texts!.repoText).toContain("mode: ordered");
    // every answer that edits an existing pool, at once: still ordered
    const all = derive(ordered, initialScreen()).items.filter((n) => n.edits).map((n) => n.id);
    expect(derive(ordered, { ...initialScreen(), yes: all }).full!.cfg.routing.map.implement!.pool!.mode).toBe("ordered");
  });
  test("shapes below their floor: a yes keeps only the models at the floor, and no is remembered by its words", () => {
    const src = source({ repoText: `${POOL}consult:\n  prefer: [claude-code:fable]\n` });
    const d0 = derive(src, initialScreen());
    const floor = d0.items.find((n) => n.id === "floor")!;
    expect(floor.title).toBe("1 shape runs below frontier, though the mode is partner-led.");
    const d = derive(src, { ...initialScreen(), yes: ["floor"] });
    expect(d.full!.sample().rows.implement.under).toBe(0);
    expect(d.texts!.repoText).toContain("tier: null");
    expect(d.texts!.repoText).toContain("# the frontier worker");
    const dismissed = new Set([`${floor.id}\u0000${floor.title}\u0000${floor.ask}`]);
    expect(needs(d0.base!, { dismissed }).some((n) => n.id === "floor")).toBe(false);
    expect(needs(d0.base!, { dismissed: new Set([`${floor.id}\u0000other words\u0000${floor.ask}`]) }).some((n) => n.id === "floor")).toBe(true);
  });
  test("a new model: a yes gives it a tier and a place in the pools, previewed as if its first probe passes", () => {
    const fresh: NewModel = { id: "gemini-4-carbon", name: "gemini-4-carbon", provider: "google", paths: [{ adapter: "omp", model: "google/gemini-4-carbon", score: 60 }],
      score: 60, best: { score: 59.1, model: "opus5.5" }, tier: "frontier", needs: 0.9, firstSeen: "2026-11-10" };
    const src = source({ repoText: `${POOL}consult:\n  prefer: [claude-code:fable]\n`, health: health([], { omp: ["google/gemini-4-carbon"] }) }, { newModels: [fresh] });
    const item = derive(src, initialScreen()).items.find((n) => n.id === "new:gemini-4-carbon")!;
    expect(item.ask).toBe("Add it as frontier? That rests on one benchmark of two: Artificial Analysis 60 (your best: 59.1); it has no Terminal-Bench score.");
    // and the details promise no re-check that nothing makes: after the yes the model holds a tier and is not looked at again
    expect(item.detail.join(" ")).toContain("Nothing looks at its tier again after a yes: frontier stands until you change it.");
    expect(item.detail.join(" ")).not.toContain("provisional");
    const d = derive(src, { ...initialScreen(), yes: [item.id] });
    expect(d.full!.seat("omp:google/gemini-4-carbon")).toMatchObject({ tier: "frontier", provider: "google" });
    expect(d.full!.sample().rows.implement.shares.map((s) => s.key)).toContain("omp:google/gemini-4-carbon");
    expect(consequence(d.base!, d.full!).changes.find((c) => c.label === "frontier vendors among the workers")).toMatchObject({ better: true });
  });
  test("once one path to a new model is added it is not offered again, and the clean-up leaves it alone until it is probed", () => {
    const fresh: NewModel = { id: "gemini-4-carbon", name: "Gemini 4 Carbon", provider: "google", score: 60, best: { score: 59.1, model: "opus5.5" }, tier: "frontier", needs: 0.9, firstSeen: "2026-11-10",
      paths: [{ adapter: "omp", model: "google/gemini-4-carbon", score: 60 }, { adapter: "omp", model: "google-antigravity/gemini-4-carbon", score: 60 }, { adapter: "cursor-agent", model: "gemini-4-carbon-high", score: 60 }] };
    const listed = { omp: ["google/gemini-4-carbon", "google-antigravity/gemini-4-carbon"], "cursor-agent": ["gemini-4-carbon-high"] };
    // nothing answered for the new ids yet: the probe only listed them
    const h = health(["grok:grok-4.5", "codex:gpt-5.6-terra"], listed);
    for (const [a, ms] of Object.entries(listed)) for (const m of ms) delete h[a].modelAuth![m];
    // The implement pool also names a model the config denies for workers: that entry is dead. The new
    // one is only waiting, and terra only failed its probe: both keep their place.
    const src = source({ repoText: `${POOL}          - grok:grok-4.5\n  deny:\n    workers:\n      models: [grok:grok-4.5]\nconsult:\n  prefer: [claude-code:fable]\n`, health: h }, { newModels: [fresh] });
    const item = derive(src, initialScreen()).items.find((n) => n.id === "new:gemini-4-carbon")!;
    // one path per CLI, and only through the CLIs the team already works through
    expect(item.assume).toEqual(["omp:google/gemini-4-carbon", "cursor-agent:gemini-4-carbon-high"]);
    const saved = derive(src, { ...initialScreen(), yes: [item.id] }).texts!;
    const after = source({ repoText: saved.repoText, health: h }, { newModels: [fresh] });
    const items = derive(after, initialScreen()).items;
    expect(items.some((n) => n.id.startsWith("new:"))).toBe(false);
    expect(items.find((n) => n.id.startsWith("unprobed:"))!.title).toContain("never probed");
    const kept = JSON.stringify(items.find((n) => n.id === "tidy")!.edits!.find((e) => e.path[2] === "implement")!.value);
    expect(kept).toContain("omp:google/gemini-4-carbon");
    expect(kept).toContain("codex:gpt-5.6-terra");
    expect(kept).not.toContain("grok:grok-4.5");
    expect(items.find((n) => n.id === "tidy")!.detail[0]).toBe("1 pool entry names a model that the rules keep from all work, or that no CLI lists. A model that only failed its probe keeps its place.");
    // a pool whose only fault is a model that failed its probe has nothing to tidy
    const failedOnly = source({ repoText: POOL, health: health(["codex:gpt-5.6-terra"]) });
    expect(derive(failedOnly, initialScreen()).items.some((n) => n.id === "tidy")).toBe(false);
  });
  test("a team line that names most shapes names the few it leaves out, and one for all nine says every shape", () => {
    const all = teamRows(buildFleetModel(source({ repoText: "routing:\n  mode: partner-led\n  map:\n" + ["plan", "spec", "implement", "tests", "docs", "migration", "ui", "refactor", "chore"].map((s) => `    ${s}:\n      pool: { mode: any, channels: [codex:gpt-6-astra] }\n`).join("") }).inputs));
    expect(all.filter((r) => r.section === "workers").map((r) => r.label)).toEqual(["every shape"]);
    const most = teamRows(buildFleetModel(source({ repoText: "routing:\n  mode: partner-led\n  map:\n" + ["plan", "spec", "implement", "tests", "ui", "refactor", "chore"].map((s) => `    ${s}:\n      pool: { mode: any, channels: [codex:gpt-6-astra] }\n`).join("") }).inputs));
    expect(most.filter((r) => r.section === "workers").map((r) => r.label)).toContain("all but docs, migration");
    for (const r of [...all, ...most]) expect(r.label.length, r.label).toBeLessThanOrEqual(33);
  });
  test("an edit goes to the layer that holds what it changes: pools and tiers kept in the user config are changed there, not copied into the repository's", () => {
    const fresh: NewModel = { id: "gemini-4-carbon", name: "gemini-4-carbon", provider: "google", paths: [{ adapter: "omp", model: "google/gemini-4-carbon", score: 60 }],
      score: 60, best: { score: 59.1, model: "opus5.5" }, tier: "frontier", needs: 0.9, firstSeen: "2026-11-10" };
    const held = `${POOL}tiers:\n  omp:\n    models:\n      google/gemini-3.8-flash: cheap\n`;
    const h = health([], { omp: ["google/gemini-4-carbon"] });
    const layersOf = (src: ScreenSource) => [...new Set(derive(src, initialScreen()).items.find((n) => n.id === "new:gemini-4-carbon")!.edits!.map((e) => e.layer))];
    // held by the user config, and the repository's says nothing about it
    const user = source({ userText: held, repoText: "review:\n  required: true\n", health: h }, { newModels: [fresh] });
    expect(layersOf(user)).toEqual(["user"]);
    const d = derive(user, { ...initialScreen(), yes: ["new:gemini-4-carbon"] });
    expect(d.texts!.touched).toEqual(["user"]);
    expect(d.texts!.repoText).toBe("review:\n  required: true\n");
    expect(d.texts!.userText).toContain("          - codex:gpt-5.6-terra\n          - omp:google/gemini-4-carbon\n");
    // the review says whose file it is, and the count stays on the row however long the path
    const long = { ...user, labels: { user: `/a/very/long/path/${"x".repeat(90)}/tickmarkr/config.yaml`, repo: ".tickmarkr/config.yaml" } };
    const review = text(long, { ...initialScreen(), yes: ["new:gemini-4-carbon"], view: "review" }, 80, 40);
    expect(review.find((l) => l.includes("TO BE SAVED IN"))).toMatch(/TO BE SAVED IN ….*tickmarkr\/config\.yaml {2}\+\d+ −0\s*$/);
    expect(review.join("\n")).toContain("Your user config: every repository on this machine reads it.");
    // held by the repository's config: the same answer goes there, as before
    expect(layersOf(source({ repoText: held, health: h }, { newModels: [fresh] }))).toEqual(["repo"]);
    // held by both: the repository's, which is the one that wins
    expect(layersOf(source({ userText: held, repoText: held, health: h }, { newModels: [fresh] }))).toEqual(["repo"]);
  });
  test("the review keeps a save's file name and +N −M count on its row, however wide the path's characters", () => {
    // the whole input class: narrow and wide characters, short and long paths, every width the review is drawn at
    for (const seg of ["/x", "/项目", "/🙂a"]) for (const n of [1, 30, 80]) for (const cols of [60, 80, 120]) {
      const src = source({ health: health(["claude-code:fable"]) });
      const named = { ...src, labels: { user: "~/.config/tickmarkr/config.yaml", repo: `${seg.repeat(n)}/.tickmarkr/config.yaml` } };
      const st = { ...initialScreen(), yes: ["setup"], view: "review" as const };
      const diff = layerDiff(named.inputs.repoText, derive(named, st).texts!.repoText);
      const row = text(named, st, cols, 80).find((l) => l.includes("TO BE SAVED IN"))!;
      expect(row, row).toContain(`config.yaml  +${diff.added} −${diff.removed}`);
      expect(width(row.trimEnd())).toBeLessThanOrEqual(cols);
    }
  });
  test("the review keeps a save's +N −M count on its row whatever the path holds: tabs, control characters, combining marks", () => {
    const paths = [`/${"a".repeat(200)}`, "/项目".repeat(30), "/a\tb".repeat(15), "/\t".repeat(20), "/x\u0001\u001b[31m\u007f".repeat(12), "/e\u0301".repeat(40)];
    for (const p of paths) for (const cols of [40, 60, 80, 120]) {
      const src = { ...source({ health: health(["claude-code:fable"]) }), labels: { user: "~/u.yaml", repo: `${p}/.tickmarkr/config.yaml` } };
      const st = { ...initialScreen(), yes: ["setup"], view: "review" as const };
      const diff = layerDiff(src.inputs.repoText, derive(src, st).texts!.repoText);
      const row = frame(src, st, cols, 80).map((l) => l.map((s) => s.text).join("")).find((l) => l.includes("TO BE SAVED IN"))!;
      expect(row.trimEnd(), JSON.stringify({ p, cols, row })).toMatch(new RegExp(`\\+${diff.added} −${diff.removed}$`));
      expect(width(row), row).toBeLessThanOrEqual(cols);
    }
  });
  test("no yes removes a model for a passing outage: one that only failed its probe keeps its place in the pool", () => {
    // qwen is at the floor and signed out; terra is working and below the floor
    const pool = `${POOL}          - qwen:qwen3.8-max\nconsult:\n  prefer: [claude-code:fable]\n`;
    const out = source({ repoText: pool, health: health(["qwen:qwen3.8-max"]) });
    const floor = derive(out, { ...initialScreen(), yes: ["floor"] });
    const kept = floor.full!.cfg.routing.map.implement!.pool!.channels;
    expect(kept).toEqual(["codex:gpt-6-astra", "qwen:qwen3.8-max"]);
    expect(floor.full!.sample().rows.implement.under).toBe(0);
    // a shape with no working model: its pool keeps what it names and gains models that work
    const dark = source({ repoText: "routing:\n  map:\n    docs:\n      pool:\n        mode: ordered\n        channels:\n          - qwen:qwen3.8-max   # the docs writer\nreview:\n  required: true\n", health: health(["qwen:qwen3.8-max"]) });
    const item = derive(dark, initialScreen()).items.find((n) => n.id === "noseat")!;
    expect(item.title).toBe("docs: no working model.");
    const fixed = derive(dark, { ...initialScreen(), yes: ["noseat"] });
    const docs = fixed.full!.cfg.routing.map.docs!.pool!;
    expect(docs.mode).toBe("ordered");
    expect(docs.channels[0]).toBe("qwen:qwen3.8-max");
    expect(docs.channels.length).toBeGreaterThan(1);
    expect(fixed.full!.sample().noSeat).toEqual([]);
    expect(fixed.texts!.repoText).toContain("          - qwen:qwen3.8-max   # the docs writer\n");
  });
  test("no working model: a pinned model stays first in an ordered pool, and where nothing reaches the floor the question says so", () => {
    // OBSERVER's world: every frontier model is dead. The repository is not a first install (it sets a consult),
    // plan and spec are pinned to one frontier model by the defaults, implement is pinned to another
    const frontier = Object.entries(DEFAULT_CONFIG.tiers).flatMap(([a, t]) => Object.entries(t.models).filter(([, tier]) => tier === "frontier").map(([m]) => `${a}:${m}`));
    const repoText = "routing:\n  map:\n    implement:\n      pin: { via: codex, model: gpt-6-astra }\nconsult:\n  prefer: [codex:gpt-5.6-terra]\n";
    const src = source({ health: health(frontier), repoText });
    const d0 = derive(src, initialScreen()), item = d0.items.find((n) => n.id === "noseat")!;
    expect(item.title).toMatch(/no working model\.$/);
    const impl = item.edits!.find((e) => e.path.join(".") === "routing.map.implement")!;
    const pool = (impl.value as { pool: { mode: string; channels: string[] } }).pool;
    // F-1: the pin is not replaced: the pinned model is first, the pool is ordered, the working models follow
    expect(pool.mode).toBe("ordered");
    expect(pool.channels[0]).toBe("codex:gpt-6-astra");
    expect(pool.channels.length).toBeGreaterThan(1);
    expect(impl.label).toMatch(/^implement: keep gpt-6-astra first; while it does not answer, /);
    expect(item.detail.join(" ")).toMatch(/pinned to one model: it stays first, in an ordered pool, and takes the work again when it answers\./);
    // F-2: nothing that works reaches a frontier floor, and the question and the details say it, as the review does
    expect(item.ask).toMatch(/\? .*below the floor: no working model reaches it\.$/);
    expect(item.detail.join(" ")).toMatch(/below the floor/);
    expect(item.detail.join(" ")).not.toContain("Yes gives it the working models at its floor.");
    const yes = derive(src, { ...initialScreen(), yes: ["noseat"] });
    expect(yes.refused).toBeUndefined();
    expect(yes.full!.sample().noSeat).toEqual([]);
    expect(yes.full!.sample().under).toBeGreaterThan(0);
    // the day the pinned model answers again, on the saved config, it takes every implement task once more
    const back = derive(source({ repoText: yes.texts!.repoText }), initialScreen()).base!;
    expect(back.sample().rows.implement.shares.map((x) => [x.key, x.n])).toEqual([["codex:gpt-6-astra", 400]]);
    // a pinned model the config itself keeps out cannot come back: it is not carried into the pool, where it would do nothing
    const denied = derive(source({ health: health(frontier), repoText: `routing:\n  deny:\n    workers:\n      models: [codex:gpt-6-astra]\n${repoText.slice(repoText.indexOf("  map:"))}` }), initialScreen()).items.find((n) => n.id === "noseat")!;
    expect((denied.edits!.find((e) => e.path.join(".") === "routing.map.implement")!.value as { pool: { mode: string; channels: string[] } }).pool).toMatchObject({ mode: "any" });
    expect((denied.edits!.find((e) => e.path.join(".") === "routing.map.implement")!.value as { pool: { channels: string[] } }).pool.channels).not.toContain("codex:gpt-6-astra");
    // where a working model does reach the floor, nothing is said about being below it
    const fine = derive(source({ health: health(["claude-code:fable"]), repoText: "consult:\n  prefer: [codex:gpt-6-astra]\n" }), initialScreen()).items.find((n) => n.id === "noseat")!;
    expect(fine.ask).not.toContain("below the floor");
    expect(fine.detail.join(" ")).toMatch(/Yes gives (it|them) the working models at (its floor|their floors)\./);
  });
  test("an item that is not selected uses the whole row for its question", () => {
    const src = source({ health: health(["claude-code:fable"]) });
    const second = derive(src, initialScreen()).items[1];
    const row = (st: ReturnType<typeof initialScreen>) => text(src, st, 80, 30).find((l) => l.includes(second.ask.slice(0, 30)))!;
    expect(second.ask.length).toBeGreaterThan(80 - 17 - 5);
    expect(second.ask.length).toBeLessThanOrEqual(80 - 5);
    // whole, selected or not: a question too long to share the row with its keys keeps the row, and the last row names the keys
    expect(row(initialScreen())).toContain(second.ask);
    expect(row({ ...initialScreen(), sel: 1 })).toContain(second.ask);
    expect(row({ ...initialScreen(), sel: 1 })).not.toContain("…");
    expect(text(src, { ...initialScreen(), sel: 1 }, 80, 30).at(-1)).toMatch(/n +no/);
  });
  test("probe results older than three days are the first item, so the screen never reassures on old news", () => {
    const at = (days: number) => source({ repoText: POOL, now: Date.parse("2026-11-10T00:00:00Z") + days * 86400000 });
    expect(derive(at(2), initialScreen()).items.some((n) => n.id === "stale")).toBe(false);
    const five = derive(at(5), initialScreen()).items[0];
    expect(five).toMatchObject({ id: "stale", title: "The team rests on probe results over 5 days old.", ask: "Press r to probe again: what works may have changed." });
    expect(five.edits).toBeUndefined();
    expect(derive(at(16), initialScreen()).items[0].title).toBe("The team rests on probe results over 2 weeks old.");
    expect(derive(at(8), initialScreen()).items[0].title).toBe("The team rests on probe results over 1 week old.");
    // the header warns from the same day on
    expect(frame(at(5), initialScreen(), 100, 30)[0].find((x) => x.text.includes("probed 5 days ago"))!.style).toBe("warn");
    // a no is remembered until the age reads differently
    const no = new Set([needSignature(five)]);
    expect(derive({ ...at(5), ctx: { dismissed: no } }, initialScreen()).items.some((n) => n.id === "stale")).toBe(false);
    expect(derive({ ...at(8), ctx: { dismissed: no } }, initialScreen()).items[0].id).toBe("stale");
  });
  test("the consult: a yes lifts every rule that keeps the model from consulting, and it still never writes code", () => {
    const after = (repoText: string) => {
      const src = source({ repoText });
      const d0 = derive(src, initialScreen());
      expect(d0.base!.consult, repoText).toBeNull();
      const item = d0.items.find((n) => n.id === "consult")!;
      expect(item.ask, repoText).toBe("Let claude-code:fable consult, judge and review? It still takes no task of any shape.");
      const d = derive(src, { ...initialScreen(), yes: ["consult"] });
      expect(d.full!.consult, repoText).toBe("claude-code:fable");
      expect(d.full!.seat("claude-code:fable")!.denied.worker, repoText).not.toBeNull();
      expect(derive(source({ repoText: d.texts!.repoText }), initialScreen()).items.some((n) => n.id === "consult"), repoText).toBe(false);
      return { item, text: d.texts!.repoText };
    };
    // a deny rule alone
    expect(after("routing:\n  deny:\n    models: [claude-code:fable]\nconsult:\n  prefer: [claude-code:fable]\n").item.detail[1]).toBe("It is kept out by the deny rule claude-code:fable, which covers every seat.");
    // the allowlist alone: letting it in would also let it write code, so it is denied as a worker in the same answer
    const allow = after("routing:\n  allow:\n    adapters: [codex]\nconsult:\n  prefer: [claude-code:fable]\n");
    expect(allow.item.detail[1]).toBe("It is kept out by the allowlist.");
    expect(allow.text).toMatch(/allow:\n {4}adapters: \[codex\]\n {4}models:\n {6}- claude-code:fable/);
    expect(allow.text).toMatch(/workers:\n {6}models:\n {8}- claude-code:fable/);
    // both at once, and a deny on the whole CLI
    expect(after("routing:\n  allow:\n    adapters: [codex]\n  deny:\n    models: [claude-code:fable]\nconsult:\n  prefer: [claude-code:fable]\n").item.detail[1]).toBe("It is kept out by the deny rule claude-code:fable, which covers every seat and the allowlist.");
    // a rule wider than the model (the whole CLI) is not a yes about this model: it is named, and left to the hand
    const wide = derive(source({ repoText: "routing:\n  deny:\n    adapters: [claude-code]\n    models: [claude-code:fable]\nconsult:\n  prefer: [claude-code:fable]\n" }), initialScreen());
    const item = wide.items.find((n) => n.id === "consult")!;
    expect(item.edits).toBeUndefined();
    expect(item.title).toBe("The consult has no model: claude-code:fable is under a wider rule.");
    // whole on an 80-column terminal
    expect(`  4  ${item.title}`.length).toBeLessThanOrEqual(80);
    expect(item.ask).toBe("Press e and change that rule on its deny line.");
    expect(item.detail[1]).toContain("the deny rule claude-code, which covers the whole claude-code CLI");
    // so no other model of that CLI is let in to judge or review by a yes that named one
    expect(wide.base!.seat("claude-code:opus")!.denied.judge).not.toBeNull();
  });
  test("the consult with no consult.prefer set: a yes sets it, because the seat picker reads nothing else", () => {
    // a config that is not a first install, sets no consult.prefer, and denies the pinned consult for every seat
    const src = source({ repoText: "routing:\n  deny:\n    models: [claude-code:fable]\nreview:\n  required: true\n" });
    const d0 = derive(src, initialScreen());
    expect(d0.base!.consult).toBeNull();
    const item = d0.items.find((n) => n.id === "consult")!;
    expect(item.title).toBe("The consult has no model: consult.prefer is not set.");
    expect(item.ask).toMatch(/^Use \S+(, \S+)? for it\?$/);
    expect(item.edits!.map((e) => e.path.join("."))).toEqual(["consult.prefer"]);
    // the answer does what it says, and does not touch the deny rule
    const d = derive(src, { ...initialScreen(), yes: ["consult"] });
    expect(d.full!.consult).not.toBeNull();
    expect(d.full!.consult).not.toBe("claude-code:fable");
    expect(d.texts!.repoText).toContain("models: [claude-code:fable]");
    expect(derive(source({ repoText: d.texts!.repoText }), initialScreen()).items.some((n) => n.id === "consult")).toBe(false);
  });
  test("the last run's dead model: the fallbacks a yes adds are at the shape's floor, or the item is not offered", () => {
    const lastRun = [{ runId: "run-1", seat: "codex:gpt-6-astra", shapes: ["implement"], tasks: ["T7"] }] as never;
    const src = source({ repoText: POOL }, { lastRun });
    const item = derive(src, initialScreen()).items.find((n) => n.id.startsWith("run:"))!;
    expect(item.title).toBe("Last run: gpt-6-astra hit its limit and no other model could take over.");
    const d = derive(src, { ...initialScreen(), yes: [item.id] });
    const pool = d.full!.cfg.routing.map.implement!.pool!.channels;
    const added = pool.filter((k) => !["codex:gpt-6-astra", "codex:gpt-5.6-terra"].includes(k));
    expect(added.length).toBeGreaterThan(0);
    for (const k of added) expect(d.full!.seat(k)!.tier, k).toBe("frontier");
    expect(d.full!.sample().rows.implement.under).toBeLessThanOrEqual(d.base!.sample().rows.implement.under);
    // every other frontier model is out: nothing at the floor is left to add, so nothing is offered
    const frontier = Object.entries(DEFAULT_CONFIG.tiers).flatMap(([a, t]) => Object.entries(t.models).filter(([, tier]) => tier === "frontier").map(([m]) => `${a}:${m}`)).filter((k) => k !== "codex:gpt-6-astra");
    const thin = derive(source({ repoText: POOL, health: health(frontier) }, { lastRun }), initialScreen());
    expect(thin.items.some((n) => n.id.startsWith("run:"))).toBe(false);
    // no frontier model answers at all, the dead one included: the models that do answer are below the
    // floor, and none of them is offered as a fallback
    const below = source({ repoText: POOL, health: health([...frontier, "codex:gpt-6-astra"]) }, { lastRun });
    expect(buildFleetModel(below.inputs).seats.some((x) => x.live.worker && x.tier !== "frontier")).toBe(true);
    expect(derive(below, initialScreen()).items.some((n) => n.id.startsWith("run:"))).toBe(false);
  });
  test("a machine where no frontier model answers still gets a judge, reviewers and a consult model from the screen", () => {
    const frontier = Object.entries(DEFAULT_CONFIG.tiers).flatMap(([a, t]) => Object.entries(t.models).filter(([, tier]) => tier === "frontier").map(([m]) => `${a}:${m}`));
    const src = source({ health: health(frontier) });
    const d0 = derive(src, initialScreen());
    expect(d0.base!.seats.filter((x) => x.live.worker).every((x) => x.tier !== "frontier")).toBe(true);
    const item = d0.items.find((n) => n.id === "setup")!;
    expect(item.edits!.map((e) => e.path[0])).toEqual(expect.arrayContaining(["judge", "consult"]));
    const d = derive(src, { ...initialScreen(), yes: ["setup"] });
    expect(d.full!.consult).not.toBeNull();
    expect(d.full!.seat(`${d.full!.cfg.judge.adapter}:${d.full!.cfg.judge.model}`)!.live.judge).toBe(true);
    // the best tier that answers, not just anything that does
    expect(d.full!.seat(d.full!.consult!)!.tier).toBe("mid");
  });
  test("a new model joins the allowlist only when the allowlist leaves it out", () => {
    const fresh: NewModel = { id: "gemini-4-carbon", name: "Gemini 4 Carbon", provider: "google", paths: [{ adapter: "omp", model: "google/gemini-4-carbon", score: 60 }],
      score: 60, best: { score: 59.1, model: "opus5.5" }, tier: "frontier", needs: 0.9, firstSeen: "2026-11-10" };
    const allowing = (allow: string) => derive(source({ repoText: `${POOL}  allow:\n${allow}consult:\n  prefer: [codex:gpt-6-astra]\n`, health: health([], { omp: ["google/gemini-4-carbon"] }) }, { newModels: [fresh] }), initialScreen())
      .items.find((n) => n.id === "new:gemini-4-carbon")!;
    // its CLI is allowed whole: nothing to add, and the details do not say it was allowed
    const whole = allowing("    adapters: [codex, omp]\n");
    expect(whole.edits!.some((e) => e.path[1] === "allow")).toBe(false);
    expect(whole.detail.join(" ")).not.toContain("allows");
    // its CLI is not on the list: the model is added to it
    const shut = allowing("    adapters: [codex]\n");
    expect(shut.edits!.find((e) => e.path[1] === "allow")!.value).toEqual(["omp:google/gemini-4-carbon"]);
    expect(shut.detail.join(" ")).toContain("allows them");
  });
  test("a probe failure is named by what to do about it: quota is a wait, a 429 for an empty balance is billing", () => {
    const of = (reason: string, failure?: string) => verdictOf({ codex: { installed: true, authed: true, models: ["m"], modelAuth: { m: { authed: false, reason, ...(failure ? { failure } : {}) } as never } } }, "codex", "m", NOW);
    expect(of("You have hit your usage limit. Try again at 6pm.")).toMatchObject({ kind: "quota", text: "out of quota", fix: "wait for the quota to reset" });
    expect(of("rate limit exceeded")).toMatchObject({ kind: "quota" });
    expect(of('429 {"type":"error","error":{"type":"rate_limit_error","message":"Insufficient balance or no resource package. Please recharge."}}')).toMatchObject({ kind: "billing" });
    expect(of("[API Error: 401 invalid access token or token expired]")).toMatchObject({ kind: "login" });
    expect(of("probe timed out (60000ms)")).toMatchObject({ kind: "timeout" });
    expect(of("anything", "timeout")).toMatchObject({ kind: "timeout" });
    expect(of("something nobody mapped")).toMatchObject({ kind: "other", fix: "probe it again" });
    // and the item says it in words that read
    const h = health();
    h["claude-code"].modelAuth!.fable = { authed: false, reason: "You have hit your usage limit.", probedAt: "2026-11-10T00:00:00Z" } as never;
    const src = source({ repoText: "consult:\n  prefer: [claude-code:fable]\n", health: h });
    const item = derive(src, initialScreen()).items.find((n) => n.id.startsWith("fix:"))!;
    expect(item.title).toMatch(/^fable\S* does not work: out of quota \(claude-code\)\.$/);
    expect(item.ask).toMatch(/^Wait for the quota to reset, then press r\. You get: /);
  });
  test("a model that does not work is listed only when fixing it gives something back", () => {
    const src = source({ repoText: "consult:\n  prefer: [claude-code:fable]\n", health: health(["claude-code:fable", "grok:grok-4.5"]) });
    const items = derive(src, initialScreen()).items;
    expect(items.some((n) => n.id.startsWith("fix:claude-fable") || n.id.startsWith("fix:fable"))).toBe(true);
    expect(items.some((n) => n.id.includes("grok"))).toBe(false);
  });
});
