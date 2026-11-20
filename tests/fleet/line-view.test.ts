// A shape's line opened (queue rows 499, 501, 502; D-2187 add.363): the contract's 5.3 and the shape rows of 5.4,
// drawn as the designs LineA-shared and LineA-order draw them.
import { describe, expect, test } from "vitest";
import type { ModelFacts } from "../../src/adapters/types.js";
import { clean, width } from "../../src/fleet/draw.js";
import { applyEdits } from "../../src/fleet/edits.js";
import { handEdits, namesOf } from "../../src/fleet/hand.js";
import { lineTargets, lineView, type LineViewInput } from "../../src/fleet/line-view.js";
import { lineOf } from "../../src/fleet/lines.js";
import { buildFleetModel } from "../../src/fleet/model.js";
import type { OneLine } from "../../src/fleet/one-screen.js";
import { health, source } from "./world.js";

const F = "claude-code:claude-fable-5-2", O = "claude-code:claude-opus-5-5", A = "codex:gpt-6-astra", S = "codex:gpt-6.1-sol";
const TERRA = "codex:gpt-5.6-terra";
const EXTRA = { "claude-code": ["claude-fable-5-2", "claude-opus-5-5"], codex: ["gpt-6.1-sol"] };
const TIERS = "tiers:\n  claude-code:\n    models:\n      claude-fable-5-2: frontier\n      claude-opus-5-5: frontier\n  codex:\n    models:\n      gpt-6.1-sol: frontier\n";
const BASE: Record<string, Partial<ModelFacts>> = { [F]: { score: 64.6, priceIn: 8, priceOut: 40 }, [O]: { score: 59.1, priceIn: 4, priceOut: 20 }, [A]: { score: 56.9, priceIn: 10, priceOut: 50 }, [S]: { score: 54.6, priceIn: 2, priceOut: 10 } };

function view(opts: { channels?: readonly string[]; mode?: string; facts?: Record<string, Partial<ModelFacts>>; routing?: string; repo?: boolean; choice?: LineViewInput["choice"]; cursor?: number; tiers?: string; extra?: Record<string, string[]> } = {}) {
  const h = health([], opts.extra ?? EXTRA);
  for (const [key, f] of Object.entries(opts.facts ?? BASE)) {
    const a = key.slice(0, key.indexOf(":")), m = key.slice(key.indexOf(":") + 1);
    h[a] = { ...h[a], modelFacts: { ...h[a].modelFacts, [m]: { as: m, ...f } } };
  }
  const map = `routing:\n  mode: partner-led\n${opts.routing ?? ""}  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ${opts.mode ?? "complexity"}\n        channels: [${(opts.channels ?? [F, O, A, S]).join(", ")}]\n`;
  const M = buildFleetModel(source(opts.repo ? { userText: opts.tiers ?? TIERS, repoText: map, health: h } : { userText: `${opts.tiers ?? TIERS}${map}`, health: h }).inputs);
  const inp: LineViewInput = { M, line: lineOf(M, "implement"), project: "my-project", choice: opts.choice, cursor: opts.cursor ?? 0 };
  const rows = lineView(inp);
  return { inp, rows, text: rows.map((r) => r.map((s) => s.text).join("").trimEnd()) };
}
// 5.1: the words the product writes never say these (a quoted id or folder is exempt)
const BANNED = /\b(pool|tier|floor|seat|channel|allowlist)\b|any pool|mode any|\(any\)/i;
const writtenBanned = (rows: OneLine[]) => rows.flat().filter((s) => !s.verbatim && BANNED.test(s.text)).map((s) => s.text);
const textOf = (rows: OneLine[]) => rows.map((r) => r.map((s) => s.text).join("").trimEnd());
const words = (rows: OneLine[]) => textOf(rows).join(" ").replace(/\s+/g, " ").trim();
function input(userText: string, h = health()): LineViewInput {
  const M = buildFleetModel(source({ userText, health: h }).inputs);
  return { M, line: lineOf(M, "implement"), project: "my-project", cursor: 0 };
}
const saved = (mode: string, entries: string) => `routing:\n  map:\n    implement:\n      prefer: null\n      pool: {mode: ${mode}, channels: [${entries}]}\n`;
function scored(mode: string, facts: Record<string, Partial<ModelFacts>>): LineViewInput {
  const extra: Record<string, string[]> = {};
  for (const key of Object.keys(facts)) {
    const at = key.indexOf(":"), cli = key.slice(0, at);
    (extra[cli] ??= []).push(key.slice(at + 1));
  }
  const tiers = `tiers:\n${Object.entries(extra).map(([cli, models]) => `  ${cli}:\n    models:\n${models.map((m) => `      ? ${JSON.stringify(m)}\n      : frontier\n`).join("")}`).join("")}`;
  return view({ mode, channels: Object.keys(facts), facts, tiers, extra }).inp;
}
// Read the rendered characters, ignoring layout spaces, to inspect a quote even across a hard wrap.
function marked(rows: OneLine[], quote: string) {
  // String search reports UTF-16 offsets; keep the mark mask in the same units, including emoji.
  // Each run of one mark is read on its own (add.404 b): a quote can never be matched across an unmarked
  // character and a marked one, so every occurrence found lies in one run, and that run must be marked.
  const chars = rows.flatMap((r) => r.flatMap((s) => s.text.split("").filter((c) => !/\s/.test(c)).map((c) => ({ c, mark: !!s.verbatim }))));
  const runs: Array<{ text: string; mark: boolean }> = [];
  for (const x of chars) {
    const last = runs[runs.length - 1];
    if (last && last.mark === x.mark) last.text += x.c; else runs.push({ text: x.c, mark: x.mark });
  }
  const sought = clean(quote).replace(/\s/g, "");
  let found = 0;
  for (const run of runs) if (run.text.includes(sought)) { expect(run.mark, quote).toBe(true); found++; }
  expect(found, quote).toBeGreaterThan(0);
}

describe("a shape's line opened", () => {
  // D-2187 add.402: owned consequences of the review's flow, bar and stale-choice reproducers.
  test("a long model keeps its cursor and first content on the same row", () => {
    for (const w of [80, 100]) {
      const id = "m".repeat(w - 21);
      // 59.1 puts this model second in its group, as in the finding; 62 puts it first.
      for (const score of [59.1, 62]) {
        const inp = scored("complexity", { [F]: { score: 64.6 }, [S]: { score }, [`codex:${id}`]: { score: 58 } });
        const cursor = lineTargets(inp).indexOf(`model:codex:${id}`);
        const rows = lineView({ ...inp, cursor }, w), text = textOf(rows);
        const selected = text.filter((r) => r.startsWith("▸"));
        expect(selected).toHaveLength(1);
        expect(selected[0]).toMatch(score === 59.1 ? /^▸ {21}m/ : /^▸ the rest 1-7(?: +m|$)/);
        expect(text).not.toContain("▸");
        marked(rows, id);
      }
    }
  });

  test("a long later model stays under MODEL on its first and continued rows", () => {
    for (const w of [80, 100]) {
      const id = "m".repeat(w - 21);
      const inp = scored("complexity", { [F]: { score: 64.6 }, [S]: { score: 59.1 }, [`codex:${id}`]: { score: 58 } });
      const rows = lineView(inp, w), text = textOf(rows), at = text.findIndex((r) => r.includes(id.slice(0, 10)));
      expect(text[at]).toBe(" ".repeat(22) + id.slice(0, w - 22));
      expect(text[at + 1]).toMatch(/^ {22}m +codex/);
      marked(rows, id);
    }
  });

  test("a long stand-in stays under its model on its first and continued rows", () => {
    for (const w of [80, 100]) {
      const id = "s".repeat(w - 33), key = `claude-code:${id}`;
      const inp = scored("complexity", { [`codex:${id}`]: { score: 56.9 }, [key]: { score: 56.9 } });
      const rows = lineView(inp, w), text = textOf(rows), at = text.findIndex((r) => r.includes("claude-code:"));
      expect(text[at]).toBe(" ".repeat(22) + key.slice(0, w - 22));
      expect(text[at + 1]).toMatch(/^ {22}s +backup:/);
      marked(rows, key);
    }
  });

  test("a long saved-any denial stays under RESULT on its first and continued rows", () => {
    for (const w of [80, 100]) {
      const id = "b".repeat(w - 13);
      const inp = scored("any", { [S]: { score: 62 }, [`codex:${id}`]: { score: 55 } });
      const rows = lineView(inp, w), text = textOf(rows), result = text.findIndex((r) => r.startsWith("  RESULT"));
      const at = text.findIndex((r, i) => i > result && r.includes(id.slice(0, 10)));
      expect(text[at]).toBe(" ".repeat(14) + id.slice(0, w - 14));
      expect(text[at + 1]).toMatch(/^ {14}b gets no tasks:/);
      marked(rows, id);
    }
  });

  test("long WHY and NOTE rows keep their prose column through wrapping", () => {
    for (const w of [80, 100]) {
      const id = "d".repeat(w - 8), key = `codex:${id}`;
      for (const [head, inp, suffix] of [
        ["WHY", scored("complexity", { [key]: { score: 64.6 }, [S]: { score: 59.1 } }), "scores"],
        ["NOTE", scored("complexity", { [S]: { score: 62, priceOut: 10 }, [key]: { score: 60, priceOut: 50 }, "codex:cheap-1": { score: 58, priceOut: 2 } }), "costs"],
      ] as const) {
        const rows = lineView(inp, w), text = textOf(rows), section = text.findIndex((r) => r.startsWith(`  ${head}`));
        const at = text.findIndex((r, i) => i > section && r.includes(id.slice(0, 10)));
        expect(text[at]).toBe(" ".repeat(9) + id.slice(0, w - 9));
        expect(text[at + 1]).toMatch(new RegExp(`^ {9}d ${suffix} `));
        marked(rows, id);
      }
    }
  });

  // D-2187 add.404: the reviewer's reproducers, each landed as an owned consequence.
  test("a quoted name's leading spaces never widen the first column, overflow a row or leave the cursor alone", () => {
    for (const w of [80, 100]) for (const [n, unit] of [[w - 22, "m"], [w - 21, "m"], [w - 23, "界"], [w - 8, "m"], [w - 13, "m"]] as const) {
      const id = `org/${" ".repeat(n)}${unit}`, key = `codex:${id}`;
      for (const [mode, facts] of [
        ["complexity", { [A]: { score: 64.6 }, [S]: { score: 54 }, [key]: { score: 50 } }],
        ["complexity", { [key]: { score: 64.6 }, [S]: { score: 59.1 } }],
        ["any", { [A]: { score: 64.6 }, [key]: { score: 50 } }],
        ["ordered", { [A]: { score: 64.6 }, [key]: { score: 50 } }],
      ] as const) {
        const inp = scored(mode, facts), targets = lineTargets(inp);
        for (let cursor = 0; cursor < targets.length; cursor++) {
          const text = textOf(lineView({ ...inp, cursor }, w));
          expect(text.every((r) => width(r) <= w), `${mode} ${n} ${w} ${cursor}`).toBe(true);
          const on = text.filter((r) => r.startsWith("▸"));
          expect(on).toHaveLength(1);
          expect(on[0], `${mode} ${n} ${w} ${cursor}`).toMatch(/^▸ +\S/);
        }
      }
    }
  });

  test("a later position of a model that takes the tasks of a line saved as any gets none and says why", () => {
    const T = "codex:seat-x";
    for (const [entries, h, takers] of [
      [`${A}, ${A}`, health(), ["gpt-6-astra"]],
      [`${F}, ${A}, ${A}`, health(), null],
      [`${T}, ${T}, ${A}, ${TERRA}`, health([TERRA], { codex: ["seat-x"] }), null],
    ] as const) {
      const tiers = `tiers:\n  claude-code:\n    models:\n      claude-fable-5-2: frontier\n  codex:\n    models:\n      seat-x: frontier\n`;
      const inp = input(`${tiers}${saved("any", entries)}`, h);
      const keys = inp.M.cfg.routing.map.implement!.pool!.channels;
      const sample = [...new Set(inp.M.sample().rows.implement.picks.map((p) => p[0]).filter((k) => k !== "none"))];
      for (const w of [80, 100]) {
        const text = textOf(lineView(inp, w)), all = words(lineView(inp, w));
        const rowOf = (i: number) => text.find((r) => new RegExp(`^  ${i + 1}  `).test(r))!;
        keys.forEach((k, i) => {
          const first = keys.indexOf(k) === i && sample.includes(k);
          expect(rowOf(i), `${entries} ${i}`).toContain(first ? "shares the tasks" : "gets none");
        });
        const shown = namesOf(inp.M, keys), nm = (k: string) => shown[keys.indexOf(k)];
        const names = sample.map(nm);
        if (takers) expect(sample.map((k) => inp.M.name(k))).toEqual(takers);
        expect(all).toContain(`${names.join(" and ")} ${names.length === 1 ? "does every task." : "share every task."}`);
        const dup = keys.find((k, i) => keys.indexOf(k) !== i && sample.includes(k));
        if (dup) expect(all).toContain(`${nm(dup)} gets no tasks: ${nm(dup)}, of the same vendor, is written before it.`);
        expect((all.match(/gets no tasks/g) ?? []).length).toBe(keys.filter((k, i) => !(keys.indexOf(k) === i && sample.includes(k))).length);
      }
    }
  });

  test("an ordered line's JOB reason follows the router's order of checks", () => {
    const job = (o: Parameters<typeof view>[0], row: number) => textOf(lineView(view({ mode: "ordered", ...o }).inp))
      .find((r) => new RegExp(`^  ${row}  `).test(r))!;
    const nullTerra = `${TIERS}      gpt-5.6-terra: null\n`;
    expect(job({ channels: [A, TERRA], routing: `  allow:\n    models: [${A}]\n` }, 2)).toMatch(/not allowed yet/);
    expect(job({ channels: [A, F], routing: "  deny:\n    adapters: [claude-code]\n" }, 2)).toMatch(/kept out/);
    expect(job({ channels: [A, TERRA], tiers: nullTerra, routing: `  deny:\n    models: [${TERRA}]\n` }, 2)).toMatch(/kept out/);
    expect(job({ channels: [A, TERRA], tiers: nullTerra, routing: `  allow:\n    models: [${A}]\n` }, 2)).toMatch(/not allowed yet/);
    expect(job({ channels: [A, TERRA], tiers: nullTerra }, 2)).toMatch(/not listed/);
    // allowed without a probe, but the CLI does not serve it: not offered, never not probed
    const h = health();
    delete h.codex.modelAuth;
    h.codex.servable = ["gpt-5.6-terra"];
    const M = buildFleetModel(source({ userText: `${saved("ordered", `${TERRA}, ${A}`).replace("routing:\n", "routing:\n  allowUnverifiedModels: true\n")}`, health: h }).inputs);
    const rows = textOf(lineView({ M, line: lineOf(M, "implement"), project: "p", cursor: 0 }));
    expect(rows.find((r) => /^  1  /.test(r))).toMatch(/does the work/);
    expect(rows.find((r) => /^  2  /.test(r))).toMatch(/not offered/);
  });

  test("a removed bar is set for this shape in either config layer under every routing mode", () => {
    for (const mode of ["partner-led", "risk-based", "staff-led"]) for (const layer of ["user", "repo"]) {
      const base = saved("ordered", A).replace("routing:\n", `routing:\n  mode: ${mode}\n`);
      const floors = "  floors:\n    implement: null\n";
      const M = buildFleetModel(source({ userText: layer === "user" ? base.replace("  map:\n", `${floors}  map:\n`) : base,
        repoText: layer === "repo" ? `routing:\n${floors}` : "", health: health() }).inputs);
      const inp = { M, line: lineOf(M, "implement"), project: "my-project", cursor: 0 };
      for (const w of [80, 100]) {
        const head = words(lineView(inp, w).slice(0, 2));
        expect(head).toContain("bar for implement: none (set for this shape)");
        expect(head).not.toContain(`(mode ${mode})`);
      }
    }
  });

  test("a stale any choice leaves the saved complexity, order, pin or open view and its active choice intact", () => {
    for (const config of [saved("complexity", A), saved("ordered", A),
      "routing:\n  map:\n    implement:\n      pin: {via: codex, model: gpt-6-astra}\n", "", saved("any", A)]) {
      const inp = input(config), pending = { ...inp, choice: "any" as const };
      expect(lineTargets(pending)).toEqual(lineTargets(inp));
      for (const w of [80, 100]) {
        const rows = lineView(pending, w);
        expect(rows).toEqual(lineView(inp, w));
        const selected = textOf(rows).filter((r) => r.includes("(•)"));
        if (inp.line.givenOut === "open") expect(selected).toEqual([]);
        else expect(selected[0]).toContain(inp.line.givenOut === "complexity" ? "(•) By complexity"
          : inp.line.givenOut === "order" ? "(•) My order" : "(•) As saved before 2.27");
      }
    }
  });

  test("bounded first-column lengths preserve layout, content and marks at every cursor target", () => {
    const ink = (rows: OneLine[]) => rows.flatMap((r) => r.flatMap((s) => [...s.text].filter((c) => !/\s/.test(c))
      .map((c) => ({ c, verbatim: !!s.verbatim, style: s.style, selected: !!s.selected }))));
    for (const w of [80, 100]) for (const n of [w - 23, w - 22, w - 21, 2 * w + 3]) {
      for (const unit of ["m", "界👩🏽‍💻é"]) {
        const id = unit.repeat(n), key = `codex:${id}`;
        for (const mode of ["complexity", "ordered", "any"]) {
          const inp = scored(mode, { [F]: { score: 64.6 }, [S]: { score: 59.1 }, [key]: { score: 58 } });
          const targets = lineTargets(inp);
          for (let cursor = 0; cursor < targets.length; cursor++) {
            const chosen = { ...inp, cursor }, rows = lineView(chosen, w), text = textOf(rows);
            expect(rows.every((r) => width(r.map((s) => s.text).join("")) <= w)).toBe(true);
            expect(ink(rows)).toEqual(ink(lineView(chosen, 4000)));
            expect(text.filter((r) => r.startsWith("▸"))).toHaveLength(1);
            expect(text).not.toContain("▸");
            if (mode === "complexity") {
              const row = text.find((r) => r.includes(id.slice(0, 10)))!;
              expect(row.startsWith(targets[cursor] === `model:${key}` ? `▸ ${" ".repeat(20)}` : " ".repeat(22))).toBe(true);
            }
            marked(rows, id);
          }
        }
      }
    }
  });

  test("each repeated model position has its own cursor and number in my order and as saved", () => {
    for (const mode of ["ordered", "any"]) {
      const inp = input(saved(mode, `${A}, ${A}, ${TERRA}`));
      const first = mode === "ordered" ? 2 : 3;
      for (let pos = 0; pos < 3; pos++) {
        const rows = lineView({ ...inp, cursor: first + pos });
        const selected = textOf(rows).filter((r) => r.startsWith("▸"));
        expect(selected, `${mode} position ${pos + 1}`).toHaveLength(1);
        expect(selected[0]).toMatch(new RegExp(`^▸ ${pos + 1} +`));
      }
      expect(new Set(lineTargets(inp)).size).toBe(lineTargets(inp).length);
    }
  });

  test("only the first working position does the work and a later equal model is a backup", () => {
    for (const [entries, first, backup, h] of [
      [`${A}, ${A}, ${TERRA}`, 1, 2, health()],
      [`${TERRA}, ${A}, ${A}`, 2, 3, health([TERRA])],
    ] as const) {
      const rows = textOf(lineView(input(saved("ordered", entries), h)));
      expect(rows.filter((r) => r.includes("does the work"))).toHaveLength(1);
      expect(rows.find((r) => r.includes("does the work"))).toMatch(new RegExp(`^  ${first} +`));
      expect(rows.find((r) => new RegExp(`^  ${backup} +`).test(r))).toMatch(/backup +codex:gpt-6-astra/);
    }
  });

  for (const [label, mode, entries, docs] of [
    ["saved-any alias item", "any", `*first, ${TERRA}`, true],
    ["saved-any duplicate list", "any", `${A}, ${A}, ${TERRA}`, false],
    ["saved-any duplicate with an alias", "any", `${A}, *first, ${TERRA}`, true],
    ["saved-ordered duplicate list", "ordered", `${A}, ${A}, ${TERRA}`, false],
    ["saved-complexity duplicate list", "complexity", `${A}, ${A}, ${TERRA}`, false],
  ] as const) {
    test(`a pending choice refused for a ${label} quotes the refusal and keeps the saved view`, () => {
      const userText = saved(mode, entries).replace("  map:\n", `  map:\n${docs ? `    docs:\n      pool: {mode: ordered, channels: [&first ${A}]}\n` : ""}`);
      const inp = input(userText), before = lineView(inp);
      for (const choice of ["order", "complexity"] as const) {
        if (choice === inp.line.givenOut) continue;
        let refusal = "";
        try {
          applyEdits(inp.M.inputs, handEdits(inp.M, [{ line: "implement", chosen: inp.M.cfg.routing.map.implement!.pool!.channels, mode: choice === "order" ? "ordered" : "complexity" }]));
        } catch (err) { refusal = (err as Error).message; }
        expect(refusal).not.toBe("");
        const pending = { ...inp, choice }, rows = lineView(pending);
        expect(words(rows)).toContain(refusal);
        marked(rows, refusal);
        expect(lineTargets(pending)).toEqual(lineTargets(inp));
        expect(textOf(rows).slice(0, before.length - 1)).toEqual(textOf(before).slice(0, -1));
        expect(words(rows)).not.toContain("No model on this line works");
        expect(textOf(rows).find((r) => r.includes("(•)"))).toBe(textOf(before).find((r) => r.includes("(•)")));
        expect(words(rows)).toContain(mode === "any" ? "As saved before 2.27" : mode === "ordered" ? "does the work" : "WHY");
        for (const why of inp.line.why) expect(words(rows)).toContain(why);
      }
    });
  }

  test("a finished denial reason is quoted whole even when the observed model has another name", () => {
    const h = health([], { codex: ["pool"] });
    h.codex.modelAuth!.pool.identity = "renamed";
    const inp = input(`tiers:\n  codex:\n    models:\n      pool: frontier\n${saved("any", `${A}, codex:pool`).replace("  map:\n", "  deny:\n    models: [pool]\n  map:\n")}`, h);
    const rows = lineView(inp);
    expect(words(rows)).toContain("renamed gets no tasks: kept out by pool.");
    expect(rows.flat().some((s) => s.verbatim && s.text.includes("kept out by pool"))).toBe(true);
    expect(writtenBanned(rows)).toEqual([]);
  });

  test("names inserted in RESULT retain their marks on both sides of a wrap", () => {
    const long = "a".repeat(64), h = health([], { codex: [long, "pool"], "claude-code": ["pool"] });
    const inp = input(`tiers:\n  codex:\n    models:\n      ${long}: frontier\n      pool: frontier\n  claude-code:\n    models:\n      pool: frontier\n${saved("any", `codex:${long}, claude-code:pool, codex:pool`)}`, h);
    const rows = lineView(inp, 100);
    expect(words(rows)).toContain(`${long} and pool (claude-code) share every task.`);
    marked(rows, "pool (claude-code)");
    marked(rows, long);
  });

  test("every kind of row fits at 80 and 100 columns without cutting its content", () => {
    const cases = [view().inp, view({ mode: "ordered" }).inp, view({ mode: "any" }).inp];
    for (const inp of cases) for (const w of [80, 100]) {
      const rows = lineView(inp, w);
      expect(rows.every((r) => width(r.map((s) => s.text).join("")) <= w), `${inp.line.givenOut}, ${w}`).toBe(true);
      expect(words(rows)).toBe(words(lineView(inp, 500)));
    }
    const rows = textOf(lineView(cases[0], 80));
    const table = rows.findIndex((r) => r.includes("very complex 8-10"));
    expect(rows[table + 1]).toMatch(/^  \S/);
    const why = rows.findIndex((r) => r.startsWith("  WHY"));
    expect(rows[why + 1]).toMatch(/^ {9}\S/);
  });

  test("bounded lists keep positions, quoted characters and all content across widths and pending choices", () => {
    // Vary routing, equal positions, failed probes, hard wraps and multi-cell graphemes through the public entries.
    const ink = (rows: OneLine[]) => rows.flatMap((r) => r.flatMap((s) => [...s.text].filter((c) => !/\s/.test(c))
      .map((c) => ({ c, verbatim: !!s.verbatim, style: s.style, selected: !!s.selected }))));
    for (const mode of ["complexity", "ordered", "any"]) for (const size of [1, 18]) {
      const id = `seat-${"界👩🏽‍💻é".repeat(size)}`, key = `codex:${id}`;
      const h = health([TERRA], { codex: [id] });
      const inp = input(`tiers:\n  codex:\n    models:\n      ${id}: frontier\n${saved(mode, `${key}, ${key}, ${A}, ${TERRA}`)}`, h);
      inp.project = "my-" + "project-".repeat(20);
      for (const choice of [undefined, "order", "complexity"] as const) {
        const pending = { ...inp, choice }, targets = lineTargets(pending);
        expect(new Set(targets).size).toBe(targets.length);
        for (const cursor of [0, targets.length - 2, targets.length - 1]) {
          const chosen = { ...pending, cursor }, full = lineView(chosen, 1000);
          for (const w of [80, 100]) {
            const rows = lineView(chosen, w);
            expect(rows.every((r) => width(r.map((s) => s.text).join("")) <= w)).toBe(true);
            expect(ink(rows)).toEqual(ink(full));
            expect(rows.filter((r) => r[0].text === "▸ ")).toHaveLength(1);
            marked(rows, id);
            marked(rows, inp.M.cfg.routing.floors.implement!);
            marked(rows, inp.M.mode.mode);
          }
        }
      }
    }
  });

  test("a line by complexity draws the design's rows: the two choices; the table of scores, list prices, shares; why; the note; if one stops; the legend", () => {
    const { rows, text } = view();
    expect(text).toEqual([
      "implement  who writes the code                   bar for implement: frontier (mode partner-led)",
      "",
      "  How are the tasks given out?",
      "▸ (•) By complexity   hard tasks go to the strongest models, lighter tasks to cheaper ones",
      "  ( ) My order        the first model that works takes every task; the others are backups",
      "",
      "  TASKS               MODEL               CLI           SCORE   PRICE IN / OUT   SHARE",
      "  very complex 8-10   claude-fable-5-2    claude-code   64.6    $8 / $40         all of them",
      "  the rest 1-7        claude-opus-5-5     claude-code   59.1    $4 / $20         about a third",
      "                      gpt-6-astra         codex         56.9    $10 / $50        about a third",
      "                      gpt-6.1-sol         codex         54.6    $2 / $10         about a third",
      "  + allow a model",
      "",
      "  WHY    Scores within 5 points count as similar, and similar models share the same tasks.",
      "         claude-fable-5-2 scores 5.5 above the next model, so it is kept for the hardest tasks.",
      "  NOTE   gpt-6-astra costs 5 times gpt-6.1-sol for a similar score.",
      "  IF ONE STOPS   the others in its group take its tasks; an empty group passes them to the next.",
      "",
      "  complexity = the 1-10 number a task gets when its spec is compiled",
      "  score = Artificial Analysis Intelligence · price = list price per million tokens, in / out",
      "  share = counted over 400 sample tasks, 40 at each complexity",
      "↑↓ move · Enter allow or remove a model · c what counts as very complex · f bar · Esc back",
    ]);
    // a share is words, never a percentage
    expect(text.some((t) => t.includes("%"))).toBe(false);
    expect(writtenBanned(rows)).toEqual([]);
    // the cursor moves over the two choices, the model rows and + allow a model
    expect(lineTargets(view().inp)).toEqual(["choice:complexity", "choice:order", `model:${F}`, `model:${O}`, `model:${A}`, `model:${S}`, "add"]);
    const on = view({ cursor: 6 });
    expect(on.text.find((t) => t.startsWith("▸"))).toBe("▸ + allow a model");
    expect(on.rows.find((r) => r[0].text === "▸ ")!.every((s) => s.selected)).toBe(true);
  });

  test("a line in my order draws its numbered rows: the job of each; the result; where it applies", () => {
    const { rows, text } = view({ mode: "ordered", channels: [F, O] });
    expect(text.slice(3)).toEqual([
      "▸ ( ) By complexity   hard tasks go to the strongest models, lighter tasks to cheaper ones",
      "  (•) My order        the first model that works takes every task; the others are backups",
      "",
      "     JOB             MODEL               CLI           SCORE   PRICE IN / OUT",
      "  1  does the work   claude-fable-5-2    claude-code   64.6    $8 / $40",
      "  2  backup          claude-opus-5-5     claude-code   59.1    $4 / $20",
      "  3  backup          + add a model",
      "",
      "  RESULT      claude-fable-5-2 writes every task, whatever its complexity.",
      "              If it stops working, claude-opus-5-5 takes over.",
      "  APPLIES TO  every project with no implement line of its own; my-project has none",
      "",
      "↑↓ move · Enter pick the model for a row · [ ] move the row · x remove · Esc back",
    ]);
    expect(writtenBanned(rows)).toEqual([]);
    // one model: no backup; a line the project holds applies to this project only
    const one = view({ mode: "ordered", channels: [F], repo: true }).text;
    expect(one).toContain("              There is no backup: if it stops, implement has no model.");
    expect(one).toContain("  APPLIES TO  this project only");
  });

  test("a line saved as any draws its third choice selected; each model that gets no tasks has a row that says why", () => {
    const { rows, text, inp } = view({ mode: "any" });
    expect(text.slice(3)).toEqual([
      "▸ ( ) By complexity          hard tasks go to the strongest models, lighter tasks to cheaper ones",
      "  ( ) My order               the first model that works takes every task; the others are backups",
      "  (•) As saved before 2.27   kept as it was saved; the rows below say who gets its tasks",
      "",
      "     JOB               MODEL               CLI           SCORE   PRICE IN / OUT",
      "  1  shares the tasks  claude-fable-5-2    claude-code   64.6    $8 / $40",
      "  2  gets none         claude-opus-5-5     claude-code   59.1    $4 / $20",
      "  3  shares the tasks  gpt-6-astra         codex         56.9    $10 / $50",
      "  4  gets none         gpt-6.1-sol         codex         54.6    $2 / $10",
      "",
      "  RESULT      claude-fable-5-2 and gpt-6-astra share every task.",
      "              claude-opus-5-5 gets no tasks: claude-fable-5-2, of the same vendor, is written before",
      "              it.",
      "              gpt-6.1-sol gets no tasks: gpt-6-astra, of the same vendor, is written before it.",
      "  APPLIES TO  every project with no implement line of its own; my-project has none",
      "",
      "↑↓ move · Enter choose · Esc back",
    ]);
    // never drawn as by complexity: no table of ranges, no share column
    expect(text.some((t) => /very complex|SHARE|about a third/.test(t))).toBe(false);
    expect(writtenBanned(rows)).toEqual([]);
    expect(lineTargets(inp).slice(0, 3)).toEqual(["choice:complexity", "choice:order", "choice:any"]);
  });

  test("three or more groups read their ranges; a group that has no range reads backup group; a model that has no score is named in why", () => {
    const facts = { [F]: { score: 64.6 }, [A]: { score: 56.9 }, [TERRA]: { score: 41 } };
    const three = view({ channels: [F, A, TERRA], facts }).text;
    expect(three.filter((t) => /^ {2}(complexity \d|very|the rest|backup)/.test(t)).map((t) => t.slice(0, 20).trimEnd())).toEqual(["  complexity 8-10", "  complexity 4-7", "  complexity 1-3"]);
    // with hardFrom 2 the third group has no range left
    const backup = view({ channels: [F, A, TERRA], facts, routing: "  hardFrom: 2\n" }).text;
    expect(backup.filter((t) => /^ {2}(complexity \d|backup group)/.test(t)).map((t) => t.slice(0, 20).trimEnd())).toEqual(["  complexity 2-10", "  complexity 1", "  backup group"]);
    expect(backup.join("\n").replace(/\s+/g, " ")).toContain("IF ONE STOPS the others in its group take its tasks; an empty group passes them to the next. The backup group gets tasks only then.");
    // a model with no score: why names it, and it is grouped by level; its score and price read —
    const level = view({ channels: [F, O, A, TERRA], facts }).text;
    expect(level.join("\n").replace(/\s+/g, " ")).toContain("WHY claude-opus-5-5 has no score, so the models are grouped by level: frontier, then mid, then cheap.");
    expect(level.find((t) => t.includes("claude-opus-5-5    "))).toMatch(/claude-code {3}— {7}— {16}/);
  });

  test("the cursor, a model's facts, the ids in prose and a choice not yet saved hold over every line", () => {
    const unmarked = (t: string) => `  ${t.slice(2)}`;
    // every cursor position on every way: the marked row keeps its number and words, only its first two cells change
    for (const opts of [{}, { mode: "ordered", channels: [A, TERRA] }, { mode: "any" }] as const) {
      const n = lineTargets(view(opts).inp).length;
      for (let c = 0; c < n; c++) {
        const on = view({ ...opts, cursor: c }).text, off = view({ ...opts, cursor: c === 0 ? 1 : 0 }).text;
        const i = on.findIndex((t) => t.startsWith("▸"));
        expect(on.filter((t) => t.startsWith("▸")), `${opts.mode} ${c}`).toHaveLength(1);
        expect(unmarked(on[i]), `${opts.mode} ${c}`).toBe(off[i].startsWith("▸") ? unmarked(off[i]) : off[i]);
      }
    }
    expect(view({ mode: "ordered", channels: [A, TERRA], cursor: 4 }).text).toContain("▸ 3  backup          + add a model");

    // facts belong to the observed identity, else the full requested id: never the shortened one
    const G = "omp:zai/glm-5.3", gt = `${TIERS}  omp:\n    models:\n      zai/glm-5.3: frontier\n`, gx = { ...EXTRA, omp: ["zai/glm-5.3"] };
    for (const mode of ["ordered", "any"]) {
      const full = view({ mode, channels: [F, G], tiers: gt, extra: gx, facts: { ...BASE, [G]: { as: "zai/glm-5.3", score: 40, priceIn: 1, priceOut: 2 } } }).text;
      expect(full.find((t) => t.includes("glm-5.3 "))).toMatch(/40\.0 +\$1 \/ \$2/);
      const short = view({ mode, channels: [F, G], tiers: gt, extra: gx, facts: { ...BASE, [G]: { as: "glm-5.3", score: 40, priceIn: 1, priceOut: 2 } } }).text;
      expect(short.find((t) => t.includes("glm-5.3 "))).toMatch(/— +—$/);
    }

    // a configured id that is a banned word is quoted wherever the product's prose names it: WHY, NOTE, a stand-in, RESULT
    const P = "codex:pool", T = "codex:seat", CP = "claude-code:pool";
    const qt = "tiers:\n  claude-code:\n    models:\n      claude-fable-5-2: frontier\n      pool: frontier\n  codex:\n    models:\n      gpt-6.1-sol: frontier\n      pool: frontier\n      seat: frontier\n";
    const qx = { ...EXTRA, codex: [...EXTRA.codex, "pool", "seat"], "claude-code": [...EXTRA["claude-code"], "pool"] };
    const worlds = [
      view({ channels: [P, T], tiers: qt, extra: qx, facts: { [P]: { score: 64 }, [T]: { score: 50 } } }),
      view({ channels: [P, T], tiers: qt, extra: qx, facts: { [P]: { score: 64 } } }),
      view({ channels: [P, T], tiers: qt, extra: qx, facts: { [P]: { score: 60, priceIn: 1, priceOut: 50 }, [T]: { score: 60, priceIn: 1, priceOut: 10 } } }),
      view({ channels: [P, CP], tiers: qt, extra: qx, facts: { [P]: { score: 60 }, [CP]: { score: 60 } } }),
      view({ mode: "any", channels: [P, T], tiers: qt, extra: qx }),
      view({ mode: "ordered", channels: [P, T], tiers: qt, extra: qx }),
    ];
    const prose = /^ +(WHY|NOTE|RESULT)? +(pool|seat) (scores|has|costs|does|writes|gets)|backup: used when pool stops|If it stops working, seat takes over/;
    for (const v of worlds) {
      expect(v.text.some((t) => prose.test(t))).toBe(true);
      expect(writtenBanned(v.rows)).toEqual([]);
    }

    // a choice made but not saved draws the line as it would route that way: its table, rows, footer and cursor
    const as = (o: Parameters<typeof view>[0]) => { const v = view(o); return { text: v.text, targets: lineTargets(v.inp) }; };
    expect(as({ choice: "order" })).toEqual(as({ mode: "ordered" }));
    expect(as({ mode: "ordered", choice: "complexity" })).toEqual(as({}));
    expect(as({ mode: "any", choice: "complexity" })).toEqual(as({}));
    expect(as({ mode: "any", choice: "order" })).toEqual(as({ mode: "ordered" }));
  });
});
