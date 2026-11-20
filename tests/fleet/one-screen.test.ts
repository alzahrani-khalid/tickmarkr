// The one screen drawn (queue row 499; D-2187 add.363; contract 5.1, 5.2, 5.6): its sections in order, each
// kind of line in words, NOT SAVED with after and saved now, the words of 5.1 and the frame's exact size.
import { describe, expect, test } from "vitest";
import { channelKey } from "../../src/adapters/types.js";
import { SHAPES, type Shape } from "../../src/graph/schema.js";
import { resolveSeats } from "../../src/route/seat-resolver.js";
import { width } from "../../src/fleet/draw.js";
import { keptOut } from "../../src/fleet/kept.js";
import { lineOf } from "../../src/fleet/lines.js";
import { buildFleetModel, type FleetModel } from "../../src/fleet/model.js";
import { type Need, needs } from "../../src/fleet/needs.js";
import { type OneLine, type OneScreenInput, oneScreen, type Pending, tooSmall } from "../../src/fleet/one-screen.js";
import { health, source } from "./world.js";

const F = "claude-code:claude-fable-5-2", O = "claude-code:claude-opus-5-5", A = "codex:gpt-6-astra", S = "codex:gpt-6.1-sol";
const EXTRA = { "claude-code": ["claude-fable-5-2", "claude-opus-5-5"], codex: ["gpt-6.1-sol"] };
const SCORES: Record<string, number> = { [F]: 64.6, [O]: 59.1, [A]: 56.9, [S]: 54.6 };
const split = (k: string): [string, string] => [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];

/** implement by complexity [F, O, A, S]; migration, chore one group of two; docs one model; plan, spec in order; tests saved as any. */
function world(opts: { implement?: string[]; plan?: string[]; consult?: string[]; extra?: Record<string, string[]>; frontier?: string[]; dead?: string[]; deny?: string } = {}): FleetModel {
  const h = health(opts.dead ?? [], opts.extra ?? EXTRA);
  for (const [k, score] of Object.entries({ ...SCORES, ...Object.fromEntries((opts.frontier ?? []).map((k) => [k, 60])) })) { const [a, m] = split(k); h[a] = { ...h[a], modelFacts: { ...h[a].modelFacts, [m]: { as: m, score } } }; }
  const pool = (mode: string, ch: string[]) => `      prefer: null\n      pool:\n        mode: ${mode}\n        channels: [${ch.join(", ")}]\n`;
  const map = { implement: pool("complexity", opts.implement ?? [F, O, A, S]), migration: pool("complexity", [O, S]), chore: pool("complexity", [O, S]),
    docs: pool("complexity", [S]), plan: pool("ordered", opts.plan ?? [F, O]), spec: pool("ordered", [F, O]), tests: pool("any", [F, O, A, S]) };
  const more = (a: string) => (opts.frontier ?? []).filter((k) => k.startsWith(`${a}:`)).map((k) => `      ${split(k)[1]}: frontier\n`).join("");
  const userText = `tiers:\n  claude-code:\n    models:\n      claude-fable-5-2: frontier\n      claude-opus-5-5: frontier\n${more("claude-code")}  codex:\n    models:\n      gpt-6.1-sol: frontier\n${more("codex")}`
    + `routing:\n  mode: partner-led\n  deny:\n${opts.deny ?? "    # keep this seat out\n    adapters: [agy]\n"}  map:\n${Object.entries(map).map(([k, v]) => `    ${k}:\n${v}`).join("")}`
    + `consult:\n  prefer: [${(opts.consult ?? [F, A]).join(", ")}]\n`;
  return buildFleetModel(source({ userText, health: h }).inputs);
}
const input = (M: FleetModel, over: Partial<OneScreenInput> = {}): OneScreenInput => ({ M, project: "my-project", items: needs(M), kept: keptOut(M), pending: [], cursor: 0, ...over });
const text = (l: OneLine): string => l.map((s) => s.text).join("");
const rows = (ls: OneLine[]): string[] => ls.map((l) => text(l).trimEnd());
const row = (rs: string[], start: string): string => rs.find((r) => r.trimStart().replace(/^▸ /, "").startsWith(start)) ?? "";
const words = (rs: string[]): string[] => rs.join(" ").split(/\s+/).filter(Boolean).sort();
const withLines = (M: FleetModel, lines: Partial<Record<Shape, { mode: string; keys: string[] }>>, judge?: string): FleetModel =>
  buildFleetModel({ ...M.inputs, repoText: `routing:\n  map:\n${Object.entries(lines).map(([shape, l]) => `    ${shape}:\n      prefer: null\n      pool:\n        mode: ${l.mode}\n        channels: [${l.keys.join(", ")}]\n`).join("")}`
    + (judge ? `judge:\n  adapter: ${split(judge)[0]}\n  model: ${split(judge)[1]}\n` : "") });

describe("the one screen", () => {
  test("WORKERS keeps same-named models on different CLIs on separate, distinguishable rows", () => {
    const M = withLines(world({ extra: { ...EXTRA, codex: ["gpt-6.1-sol", "shared"], "claude-code": [...EXTRA["claude-code"], "shared"] },
      frontier: ["codex:shared", "claude-code:shared"], plan: ["codex:shared"] }), { spec: { mode: "ordered", keys: ["claude-code:shared"] } });
    const rs = rows(oneScreen(input(M), 160, 60));
    expect(row(rs, "plan")).toMatch(/^  plan +shared \(codex\) does every task$/);
    expect(row(rs, "spec")).toMatch(/^  spec +shared \(claude-code\) does every task$/);
  });

  test("the configured judge stays first when most tasks use its independent judge", () => {
    const M = withLines(world(), Object.fromEntries(SHAPES.map((shape) => [shape, { mode: "ordered", keys: [shape === "docs" ? A : shape === "tests" ? "qwen:qwen3.8-max" : "claude-code:fable"] }])), "claude-code:fable");
    // The reproducer deliberately gives the independent judge most sample tasks.
    expect(M.sample().judges[0].key).toBe(A);
    expect(row(rows(oneScreen(input(M), 160, 60)), "acceptance (judge)"))
      .toMatch(/^  acceptance \(judge\) +fable +gpt-6-astra when Claude wrote the task$/);
  });

  test("real item titles and edit labels are drawn whole without recognizing identifiers inside them", () => {
    // D-2187 add.386 closes the quotation finding at the ITEM boundary: the producer owns its words.
    const dead = world({ extra: { ...EXTRA, codex: ["gpt-6.1-sol", "seat"] }, frontier: ["codex:seat"], plan: ["codex:seat"], dead: ["codex:seat"] });
    const restored = needs(dead).find((n) => n.title === "seat does not work: no answer (codex).")!;
    expect(restored).toBeDefined();
    const M = world();
    const fresh = needs(M, { newModels: [{ id: "seat", name: "seat", provider: "openai", paths: [{ adapter: "codex", model: "seat", score: 70 }],
      score: 70, best: { score: 64.6, model: "fable" }, tier: "frontier", needs: 0.9, firstSeen: "2026-11-11" }] }).find((n) => n.id === "new:seat")!;
    expect(fresh.title).toBe("New model: seat (openai), on codex.");
    expect(fresh.edits?.some((e) => e.label === "implement: add seat to the line")).toBe(true);
    const f = oneScreen(input(M, { items: [restored, fresh], pending: [{ kind: "yes", item: fresh }] }), 200, 100);
    const segs = f.flat();
    expect(segs.filter((s) => s.text === restored.title)).toHaveLength(1);
    expect(segs.filter((s) => s.text === fresh.title)).toHaveLength(2);
    for (const e of fresh.edits ?? []) expect(segs).toContainEqual({ text: e.label });
    // Config-like text is also owned by the item, not split by a recognizer in the drawing module.
    const item: Need = { id: "literal", title: "See codex:seat and routing.floors.", ask: "", detail: [],
      edits: [{ layer: "user", path: ["review", "floor"], value: "frontier", label: "Keep review.floor as written." }] };
    const literal = oneScreen(input(M, { items: [item], pending: [{ kind: "yes", item }] }), 200, 100).flat();
    expect(literal.filter((s) => s.text === item.title)).toHaveLength(2);
    expect(literal).toContainEqual({ text: item.edits![0].label });
  });

  test("row identity and judge roles survive bounded changes of routing method, CLI and task distribution", () => {
    const twin = world({ extra: { ...EXTRA, codex: ["gpt-6.1-sol", "shared"], "claude-code": [...EXTRA["claude-code"], "shared"] },
      frontier: ["codex:shared", "claude-code:shared"] });
    for (const [first, second] of [["ordered", "complexity"], ["complexity", "any"], ["any", "ordered"]]) {
      const M = withLines(twin, { plan: { mode: first, keys: ["codex:shared"] }, spec: { mode: second, keys: ["codex:shared"] },
        docs: { mode: first, keys: ["claude-code:shared"] } });
      const rs = rows(oneScreen(input(M), 200, 100));
      for (const shape of ["plan", "spec", "docs"]) expect(row(rs, shape)).toMatch(new RegExp(`^  ${shape} +shared \\(${shape === "docs" ? "claude-code" : "codex"}\\) does every task$`));
    }
    // the judge's row is the product's own answer, whichever way the tasks are spread
    for (const [primary, other] of [[F, A], [A, F]]) {
      for (const count of [0, 4, 9]) {
        const M = withLines(world(), Object.fromEntries(SHAPES.map((shape, i) => [shape, { mode: "ordered", keys: [i < count ? primary : other] }])), primary);
        expect(judgeNames(M)).toEqual(resolvedJudges(M));
      }
    }
  });

  // Row 499; D-2187 add.390 (1): who judges is asked of the resolution a run uses, per worker on the lines.
  const resolvedJudges = (M: FleetModel): string[] => [...new Set(M.sample().workers.map((w) => w.key).flatMap((a) => {
    const r = resolveSeats({ role: "judge", cfg: M.cfg, pool: M.pools.judge, authorPool: M.pools.review, health: M.health, authors: [a] });
    return r.pick && !r.disallowed ? [M.name(channelKey(r.pick))] : [];
  }))].sort();
  const judgeRow = (M: FleetModel): string => row(rows(oneScreen(input(M), 200, 100)), "acceptance (judge)").trim().replace(/ +/g, " ");
  const judgeNames = (M: FleetModel): string[] => {
    const segs = oneScreen(input(M), 200, 100).find((l) => text(l).trimStart().startsWith("acceptance (judge)"))!;
    return [...new Set(segs.filter((s) => s.verbatim).map((s) => s.text.trim()))].filter((t) => !/ (does not answer|kept out)$/.test(t)).sort();
  };

  test("the judge's row names only judges the product's resolution picks, and never an unknown vendor as a trigger", () => {
    const all = (k: string) => Object.fromEntries(SHAPES.map((shape) => [shape, { mode: "ordered", keys: [k] }]));
    // reproducer: the configured judge fails its probe; the resolution still gives every Claude task to it
    const dead = withLines(world({ dead: ["claude-code:fable"] }), all("claude-code:opus"), "claude-code:fable");
    expect(resolvedJudges(dead)).toEqual(["fable"]);
    expect(judgeRow(dead)).toBe("acceptance (judge) fable does not answer");
    // reproducer: a configured judge of a vendor the product calls unknown judges nothing
    const base = world({ extra: { ...EXTRA, "claude-code": [...EXTRA["claude-code"], "mystery-1"] } });
    const mystery = buildFleetModel({ ...base.inputs, repoText: `tiers:\n  claude-code:\n    models:\n      mystery-1: frontier\n    modelOverrides:\n      mystery-1:\n        vendor: unknown\n`
      + withLines(base, { ...all(A), docs: { mode: "ordered", keys: ["cursor-agent:claude-fable-5-1"] } }, "claude-code:mystery-1").inputs.repoText });
    expect(mystery.seat("claude-code:mystery-1")?.vendor).toBe("unknown");
    expect(judgeRow(mystery)).not.toMatch(/Unknown/);
    expect(judgeNames(mystery)).toEqual(resolvedJudges(mystery));
    expect(judgeNames(mystery)).not.toContain("mystery-1");
    // bounded: every spread of two vendors' workers over the lines, under three configured judges
    for (const j of ["claude-code:fable", A, "claude-code:opus"]) {
      for (const count of [0, 3, 9]) {
        const M = withLines(world(), Object.fromEntries(SHAPES.map((shape, i) => [shape, { mode: "ordered", keys: [i < count ? "claude-code:opus" : A] }])), j);
        expect(judgeNames(M), `${j} ${count}`).toEqual(resolvedJudges(M));
        expect(judgeRow(M)).not.toMatch(/Unknown/);
      }
    }
  });

  // Row 499; D-2187 add.391: the authors asked about are the workers that write sample tasks, open lines
  // included, never a dead or idle backup; each with its worker channel's vendor.
  test("the judge's row asks about the workers that write tasks, open lines included, never a dead backup", () => {
    const def = buildFleetModel(source().inputs);
    expect(judgeRow(def)).toContain("fable");
    expect(judgeNames(def)).toEqual(resolvedJudges(def));
    const hDeadFable = health(["claude-code:fable"]);
    const defDead = buildFleetModel(source({ health: hDeadFable }).inputs);
    expect(judgeRow(defDead)).toBe("acceptance (judge) fable does not answer");
    const hOnlyClaude = structuredClone(hDeadFable);
    for (const k of Object.keys(hOnlyClaude)) if (k !== "claude-code") hOnlyClaude[k].authed = false;
    expect(judgeRow(buildFleetModel(source({ health: hOnlyClaude }).inputs))).toBe("acceptance (judge) fable does not answer");
    // all shapes open: Claude's workers still write tasks, so the independent judge is named for them
    const open = buildFleetModel({ ...def.inputs, repoText: "routing:\n  map:\n    plan: null\n    spec: null\n" });
    expect(judgeNames(open)).toEqual(resolvedJudges(open));
    expect(judgeNames(open).length).toBeGreaterThan(1);
    // a dead backup writes nothing: opus writes every task, fable judges every one
    const dead = withLines(world({ dead: ["claude-code:fable"] }), Object.fromEntries(SHAPES.map((shape) => [shape, { mode: "ordered", keys: ["claude-code:opus", "claude-code:fable"] }])), "claude-code:fable");
    expect(judgeRow(dead)).toBe("acceptance (judge) fable does not answer");
  });

  test("one set of names for the whole screen: a pending change between two same-named models reads differently after and saved now", () => {
    const P = "pi:zai/glm-5.3", Q = "omp:zai/glm-5.3";
    const M = world({ frontier: [P, Q] });
    for (const [mode, before, after] of [["complexity", [P], [Q]], ["complexity", [F, P], [F, Q]], ["ordered", [P], [Q]]] as const) {
      const was = withLines(M, { plan: { mode, keys: [...before] } }), now = withLines(M, { plan: { mode, keys: [...after] } });
      const rs = rows(oneScreen(input(was, { pending: [{ kind: "line", after: lineOf(now, "plan"), before: lineOf(was, "plan") }] }), 200, 100));
      const at = rs.findIndex((r) => r.startsWith("NOT SAVED")), block = rs.slice(at + 1);
      const saved = block.find((r) => r.trimStart().startsWith("saved now"))!, afterRows = block.slice(0, block.indexOf(saved)).join("\n");
      expect(saved, mode).toMatch(/glm-5\.3 \(pi\)/);
      expect(saved, mode).not.toMatch(/\(omp\)/);
      expect(afterRows, mode).toMatch(/glm-5\.3 \(omp\)/);
      expect(afterRows, mode).not.toMatch(/\(pi\)/);
    }
  });

  test("the one screen draws the design's sections in order: header; workers in two columns; gates; consult; kept out; needs you; keys", () => {
    const M = world();
    const rs = rows(oneScreen(input(M), 160, 60));
    const at = (p: RegExp) => rs.findIndex((r) => p.test(r));
    const order = [/^[▸ ] tickmarkr fleet {2}my-project · \d+ models work · checked (today|\d+ days? ago|not checked yet) · mode partner-led \(frontier models only\)/,
      /^WORKERS {2}who does each shape of work, by how complex the task is/, /^ +VERY COMPLEX 8-10 +THE REST 1-7$/, /^ {2}implement /,
      /^GATES {2}in order; the first five need no model/, /^ {2}build, test, lint +your commands/, /^ {2}evidence, scope +built in/, /^ {2}acceptance \(judge\) /, /^ {2}review \(another vendor\) /,
      /^CONSULT {2}asked when a task stalls or the gates conflict/, /^ {2}consult /, /^ {2}overseer skill /,
      /^KEPT OUT {2}never used, whatever is ticked; no yes\/no item removes these/, /^ {2}agy +# keep this seat out$/, /^ {2}\+ keep a model or a CLI out$/,
      /^NEEDS YOU \(\d+\)$/, /^↑↓ move · Enter change the line · y n answer · s save · u undo · r check again · \? help · q quit$/];
    const found = order.map(at);
    expect(found.every((i) => i >= 0), JSON.stringify(found)).toBe(true);
    expect(found).toEqual([...found].sort((a, b) => a - b));
    // two columns: the very complex group under its head, the rest under theirs
    const headRow = rs[found[2]], impl = row(rs, "implement");
    expect(impl.indexOf("claude-fable-5-2")).toBe(headRow.indexOf("VERY COMPLEX"));
    expect(impl.indexOf("claude-opus-5-5 + gpt-6-astra + gpt-6.1-sol")).toBe(headRow.indexOf("THE REST"));
    // the judge's second column names the independent judge; the consult the first, then the rest
    expect(row(rs, "acceptance (judge)")).toMatch(/wrote the task/);
    expect(row(rs, "consult")).toMatch(/claude-fable-5-2 +then gpt-6-astra/);
    // with no item the head is drawn too, over its one sentence
    const none = rows(oneScreen(input(M, { items: [] }), 160, 60));
    expect(none[none.indexOf("NEEDS YOU (0)") + 1]).toBe("  Nothing. Every shape, gate and the consult has a working model.");
    // the cursor stands on one row: the first WORKERS row after the mode
    expect(rows(oneScreen(input(M, { cursor: 1 }), 160, 60)).filter((r) => r.startsWith("▸ "))).toEqual([expect.stringMatching(/^▸ plan, spec /)]);
  });

  test("each kind of line reads as the contract says: by complexity; one group; in order beside its backups; saved as any", () => {
    const M = world();
    const rs = rows(oneScreen(input(M), 160, 60));
    expect(row(rs, "implement")).toMatch(/^ {2}implement +claude-fable-5-2 +claude-opus-5-5 \+ gpt-6-astra \+ gpt-6\.1-sol$/);
    expect(row(rs, "migration, chore")).toMatch(/^ {2}migration, chore +claude-opus-5-5 \+ gpt-6\.1-sol share every task$/);
    expect(row(rs, "docs")).toMatch(/^ {2}docs +gpt-6\.1-sol does every task$/);
    expect(row(rs, "plan, spec")).toMatch(/^ {2}plan, spec +claude-fable-5-2 does every task {3}backup claude-opus-5-5$/);
    // saved as any: as it routes, beside the models that get no tasks, never as by complexity
    const tests = row(rs, "tests");
    expect(tests).toMatch(/^ {2}tests +claude-fable-5-2 \+ gpt-6-astra share every task {3}no tasks: claude-opus-5-5, gpt-6\.1-sol$/);
    const seg = oneScreen(input(M), 160, 60).find((l) => text(l).trimStart().startsWith("tests"))!;
    expect(seg.find((s) => s.text.includes("no tasks"))?.style).toBe("warn");
    // two models of one name are told apart beside each other, in a line and in the consult
    const twin = world({ extra: { ...EXTRA, codex: ["gpt-6.1-sol", "shared"], "claude-code": [...EXTRA["claude-code"], "shared"] },
      frontier: ["codex:shared", "claude-code:shared"], plan: ["codex:shared", "claude-code:shared"], consult: ["codex:shared", "claude-code:shared"] });
    const tw = rows(oneScreen(input(twin), 160, 60));
    expect(row(tw, "plan")).toMatch(/shared \(codex\) does every task {3}backup shared \(claude-code\)$/);
    expect(row(tw, "consult")).toMatch(/shared \(codex\) +then shared \(claude-code\)$/);
    expect(row(rs, "ui, refactor")).toMatch(/the cheapest model at the bar takes each task$/);
    // a status word is drawn only on a line that is not ok
    expect(rs.filter((r) => /\bok\b/.test(r))).toEqual([]);
    const dead = rows(oneScreen(input(world({ dead: [S] })), 160, 60));
    expect(row(dead, "docs")).toMatch(/NO MODEL$/);
    expect(row(dead, "implement")).not.toMatch(/NO MODEL/);
  });

  test("not saved lists every pending change after and saved now; a mark stands on each changed line", () => {
    const M = world(), B = world({ implement: [O, S] });
    const item: Need = { id: "complexity", title: "tests is given out the way it was saved before 2.27. Give it out by complexity?", ask: "", detail: [],
      edits: [{ layer: "user", path: ["routing", "map", "tests", "pool", "mode"], value: "complexity", label: "tests: given out by complexity" }] };
    const pending: Pending[] = [
      { kind: "line", after: lineOf(M, "implement"), before: lineOf(B, "implement") },
      { kind: "yes", item },
      { kind: "setting", label: "mode", after: "staff-led", before: "partner-led", marks: "mode" },
    ];
    const rs = rows(oneScreen(input(M, { pending }), 160, 60));
    const at = rs.findIndex((r) => r.startsWith("NOT SAVED"));
    expect(rs[at]).toBe("NOT SAVED  3 changes  ● marks the line · nothing is written until you press s");
    expect(rs.slice(at + 1, at + 8)).toEqual([
      "  1  implement              very complex   claude-fable-5-2",
      "                            the rest       claude-opus-5-5 + gpt-6-astra + gpt-6.1-sol",
      "                            saved now      claude-opus-5-5 + gpt-6.1-sol share every task",
      "  2  tests is given out the way it was saved before 2.27. Give it out by complexity?",
      "                            tests: given out by complexity",
      "  3  mode                   staff-led",
      "                            saved now      partner-led",
    ]);
    // the mark: on each changed row (the line, the line an answered yes gives out anew, the mode's header), nowhere else
    expect(row(rs, "implement")).toMatch(/ {3}●$/);
    expect(row(rs, "tests")).toMatch(/ {3}●$/);
    expect(rs[0]).toMatch(/ {3}●$/);
    expect(rs.slice(0, at).filter((r) => r.includes("●"))).toHaveLength(3);
    // the real complexity item, answered yes alone, marks every line it gives out anew
    const real = needs(M).find((n) => n.id === "complexity")!;
    const yesOnly = rows(oneScreen(input(M, { pending: [{ kind: "yes", item: real }] }), 160, 60));
    expect(row(yesOnly, "tests")).toMatch(/ {3}●$/);
    // nothing pending: no NOT SAVED block and no mark
    const clean = rows(oneScreen(input(M), 160, 60));
    expect(clean.some((r) => r.startsWith("NOT SAVED") || r.includes("●"))).toBe(false);
    // one change: the head counts it, unnumbered, as the design draws it
    const one = rows(oneScreen(input(M, { pending: pending.slice(0, 1) }), 160, 60));
    expect(one.find((r) => r.startsWith("NOT SAVED"))).toBe("NOT SAVED  1 change  ● marks the line · nothing is written until you press s");
    expect(one).toContain("  implement                 very complex   claude-fable-5-2");
  });

  test("no written word is pool; tier; floor; seat; channel; allowlist: a quoted comment or config key is drawn as it is written", () => {
    const M = world({ deny: "    # keep this seat out\n    adapters: [agy]\n    workers:\n      models:\n        # the floor tier pool channel allowlist\n        - codex:gpt-6-luna\n" });
    const pending: Pending[] = [{ kind: "line", after: lineOf(M, "implement"), before: lineOf(M, "tests") },
      { kind: "setting", label: "the bar for review", after: "frontier", before: "mid", key: "review.floor" }];
    const banned = /\b(pool|tier|floor|seat|channel|allowlist)\b|any pool|mode any|\(any\)/i;
    for (const [c, r] of [[160, 60], [80, 20], [80, 40]] as const) {
      for (let cursor = 0; cursor < 20; cursor++) {
        const segs = oneScreen(input(M, { pending, cursor }), c, r).flat();
        expect(segs.filter((s) => !s.verbatim && banned.test(s.text)).map((s) => s.text)).toEqual([]);
      }
    }
    const segs = oneScreen(input(M, { pending }), 160, 60).flat();
    expect(segs.filter((s) => s.verbatim).map((s) => s.text)).toEqual(expect.arrayContaining(["# keep this seat out", "review.floor", "# the floor tier pool channel allowlist"]));
    // the bait is caught: the same scan over every segment finds the quoted words
    expect(segs.some((s) => banned.test(s.text))).toBe(true);
    // The drawing module owns the saved model, setting values and config key; all stay quoted.
    const X = world({ extra: { ...EXTRA, codex: ["gpt-6.1-sol", "seat", "channel"] }, frontier: ["codex:seat", "codex:channel"], plan: ["codex:seat", O] });
    const quoted: Pending[] = [{ kind: "line", after: lineOf(M, "plan"), before: lineOf(X, "plan") },
      { kind: "setting", label: "the judge", after: "codex:seat", before: "codex:channel", key: "review.floor" }];
    const frame = oneScreen(input(X, { pending: quoted, items: [] }), 160, 80), qs = frame.flat();
    expect(qs.filter((s) => !s.verbatim && banned.test(s.text)).map((s) => s.text)).toEqual([]);
    expect(qs.filter((s) => s.verbatim).map((s) => s.text)).toEqual(expect.arrayContaining(["codex:seat", "codex:channel", "review.floor"]));
    expect(frame.find((l) => /saved now +seat does every task/.test(text(l))))
      .toContainEqual({ text: "seat", style: "dim", verbatim: true });
    const rs = rows(oneScreen(input(M, { pending }), 160, 60));
    expect(row(rs, "codex:gpt-6-luna")).toMatch(/# the floor tier pool channel allowlist · workers only$/);
  });

  test("every frame is exactly the size asked for; below 80 columns or 20 rows it is the one sentence asking for a larger window", () => {
    const M = world();
    const pending: Pending[] = [{ kind: "line", after: lineOf(M, "implement"), before: lineOf(world({ implement: [O, S] }), "implement") }];
    for (const [c, r] of [[80, 20], [80, 24], [100, 30], [120, 50], [160, 60], [200, 10], [79, 20], [80, 19], [30, 8], [40, 12], [79, 100]] as const) {
      for (const cursor of [0, 5, 12, 30]) {
        const f = oneScreen(input(M, { pending, cursor }), c, r);
        expect(f, `${c}x${r}`).toHaveLength(r);
        expect(f.map((l) => l.reduce((n, s) => n + width(s.text), 0)), `${c}x${r}`).toEqual(Array(r).fill(c));
      }
    }
    for (const [c, r] of [[79, 20], [80, 19], [30, 8], [40, 12]] as const) {
      const rs = rows(oneScreen(input(M), c, r)).filter(Boolean);
      expect(rs.join(" ").replace(/\s+/g, " ")).toBe(`${tooSmall(c, r)} q quit`);
      expect(tooSmall(c, r)).toBe(`tickmarkr fleet needs a window of at least 80 columns by 20 rows; this one is ${c} by ${r}.`);
    }
    // no row is cut silently: at 80 columns every word of the wide frame is there, wrapped
    const wide = rows(oneScreen(input(M, { pending }), 200, 200)), narrow = rows(oneScreen(input(M, { pending }), 80, 200));
    expect(words(narrow)).toEqual(words(wide));
    // a short window scrolls with the cursor and counts what it does not show
    const short = rows(oneScreen(input(M, { pending, cursor: 13 }), 80, 20));
    expect(short.some((r) => r.startsWith("▸ "))).toBe(true);
    expect(short.some((r) => /^↑ \d+ more above$/.test(r))).toBe(true);
    // every line of the tall frame is on some frame of a short window: NOT SAVED at the end, and the
    // head, middle and end of a row taller than the window
    const long = keptOut(M).map((k, i) => (i ? k : { ...k, reason: Array.from({ length: 500 }, (_, j) => `word${String(j).padStart(3, "0")}`).join(" ") }));
    for (const inp of [input(M, { pending, items: [] }), input(M, { pending, kept: long })]) {
      const tall = rows(oneScreen(inp, 80, 400)).map((r) => r.replace(/^▸ /, "  ")).filter((r) => r.trim() && !r.startsWith("↑↓ move"));
      const seen = new Set<string>();
      for (let cursor = 0; cursor < 200; cursor++) for (const r of rows(oneScreen({ ...inp, cursor }, 80, 20))) seen.add(r.replace(/^▸ /, "  "));
      expect(tall.filter((r) => !seen.has(r))).toEqual([]);
    }
  });
});
