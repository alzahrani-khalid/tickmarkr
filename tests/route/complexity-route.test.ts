import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type BillingChannel, channelKey } from "../../src/adapters/types.js";
import { loadConfigWithMode, type TickmarkrConfig } from "../../src/config/config.js";
import { type Task, validateGraph } from "../../src/graph/schema.js";
import { route, RoutingError, spreadOffset } from "../../src/route/router.js";

// Rows 501, 502 (D-2187 add.363): the contract's closed case tables (iii), (iv) and (vii), executed through
// route() on a config loadConfigWithMode loaded; and the two routing keys.

type Tier = BillingChannel["tier"];
const ch = (key: string, score?: number, tier: Tier = "frontier"): BillingChannel => {
  const i = key.indexOf(":");
  return { adapter: key.slice(0, i), vendor: "v", model: key.slice(i + 1), channel: "sub", tier, ...(score === undefined ? {} : { score }) };
};

const repo = mkdtempSync(join(tmpdir(), "tkr-cx-route-r-"));
const globalDir = mkdtempSync(join(tmpdir(), "tkr-cx-route-g-"));
const load = (text: string) => loadConfigWithMode(repo, { globalDir, repoOverlayText: text });
const cfgFor = (channels: readonly BillingChannel[]): TickmarkrConfig =>
  load(`routing:\n  map:\n    implement:\n      pool:\n        mode: complexity\n        channels: [${channels.map(channelKey).join(", ")}]\n`).cfg;

type Spec = { complexity: number; goal?: string; floor?: Tier };
const graphOf = (specs: Spec[]): Task[] =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: specs.map((s, k) => ({
      id: `T${k + 1}`, title: "t", goal: s.goal ?? `simulated implement task ${k * 7919}`, shape: "implement",
      complexity: s.complexity, acceptance: ["a"], ...(s.floor ? { routingHints: { floor: s.floor } } : {}),
    })),
  }).tasks;
const allOf = (n: number, complexity: number) => graphOf(Array.from({ length: n }, () => ({ complexity })));

const picks = (cfg: TickmarkrConfig, channels: BillingChannel[], graph: Task[], exclude?: ReadonlySet<string>, withGraph = true) =>
  graph.map((t) => channelKey(route(t, cfg, channels, undefined, undefined, exclude, undefined, withGraph ? graph : undefined).assignment));
const tally = (keys: string[]) => keys.reduce<Record<string, number>>((n, k) => ({ ...n, [k]: (n[k] ?? 0) + 1 }), {});

const F = ch("claude-code:claude-fable-5-2", 64.6);
const O = ch("claude-code:claude-opus-5-5", 59.1);
const A = ch("codex:gpt-6-astra", 56.9);
const S = ch("codex:gpt-6.1-sol", 54.6);
const M = ch("codex:mid-model", 48.0, "mid");
const [f, o, a, s, m] = [F, O, A, S, M].map(channelKey);

describe("rows 501, 502: a line by complexity routes by the closed case tables", () => {
  test("the cells S1 to S6; B1; B2; U1 to U4; U6 to U9 route as the contract's closed case tables say", () => {
    // (iii) line F | O, A, S | M: ranges 8-10, 4-7, 1-3
    const line = [F, O, A, S, M];
    const cfg = cfgFor(line);
    const c9 = allOf(400, 9), c5 = allOf(400, 5), c2 = allOf(400, 2);
    const run = (g: Task[], ex?: string[]) => tally(picks(cfg, line, g, ex && new Set(ex)));
    const mid = { [o]: 134, [a]: 133, [s]: 133 };
    // S1 nobody stopped
    expect(run(c9)).toEqual({ [f]: 400 });
    expect(run(c5)).toEqual(mid);
    expect(run(c2)).toEqual({ [m]: 400 });
    // S2 the only model of the first group: no stronger group, the nearest weaker
    expect(run(c9, [f])).toEqual(mid);
    expect(run(c5, [f])).toEqual(mid);
    expect(run(c2, [f])).toEqual({ [m]: 400 });
    const moved = route(c9[0], cfg, line, undefined, undefined, new Set([f]), undefined, c9).provenance;
    expect(moved).toBe("by complexity: complexity 4-7, group 2 of 3, one of 3 that take turns; group 1 has no model that can take it, moved down (config routing.map)");
    // S3 the whole middle group: the nearest stronger
    expect(run(c9, [o, a, s])).toEqual({ [f]: 400 });
    expect(run(c5, [o, a, s])).toEqual({ [f]: 400 });
    expect(run(c2, [o, a, s])).toEqual({ [m]: 400 });
    // S4 the last group: the nearest stronger, not two groups up
    expect(run(c9, [m])).toEqual({ [f]: 400 });
    expect(run(c5, [m])).toEqual(mid);
    expect(run(c2, [m])).toEqual(mid);
    expect(route(c2[0], cfg, line, undefined, undefined, new Set([m]), undefined, c2).provenance).toContain("; group 3 has no model that can take it, moved up");
    // S5 one model of the middle group: only A's tasks move, shared 67 and 66
    const before = picks(cfg, line, c5);
    const after = picks(cfg, line, c5, new Set([a]));
    expect(tally(after)).toEqual({ [o]: 201, [s]: 199 });
    before.forEach((k, i) => { if (k !== a) expect(after[i]).toBe(k); });
    expect(tally(after.filter((_, i) => before[i] === a))).toEqual({ [o]: 67, [s]: 66 });
    expect(run(c9, [a])).toEqual({ [f]: 400 });
    expect(run(c2, [a])).toEqual({ [m]: 400 });
    // S6 the whole line: refused
    for (const g of [c9, c5, c2]) {
      expect(() => route(g[0], cfg, line, undefined, undefined, new Set([f, o, a, s, m]), undefined, g)).toThrow(RoutingError);
    }

    // (iv) the task's own bar above some members
    const p = ch("x:p-model", 60, "mid"), q = ch("x:q-model", 56), r = ch("x:r-model", 52);
    const pqr = [p, q, r];
    const cfgB = cfgFor(pqr);
    // B1 no bar: {p, q} {r}
    expect(tally(picks(cfgB, pqr, allOf(400, 9)))).toEqual({ "x:p-model": 200, "x:q-model": 200 });
    expect(tally(picks(cfgB, pqr, allOf(400, 3)))).toEqual({ "x:r-model": 400 });
    // B2 the bar is frontier: {q, r} takes 1-10
    const barred = (c: number) => graphOf(Array.from({ length: 400 }, () => ({ complexity: c, floor: "frontier" as const })));
    expect(tally(picks(cfgB, pqr, barred(9)))).toEqual({ "x:q-model": 200, "x:r-model": 200 });
    expect(tally(picks(cfgB, pqr, barred(3)))).toEqual({ "x:q-model": 200, "x:r-model": 200 });

    // (v) the three modes side by side: [F, O, A, S], a graph of 400, 40 at each complexity
    const base = [F, O, A, S];
    const cfgBase = cfgFor(base);
    const mixed = graphOf(Array.from({ length: 400 }, (_, i) => ({ complexity: (i % 10) + 1 })));
    const pool = (mode: string) => load(`routing:\n  map:\n    implement:\n      pool:\n        mode: ${mode}\n        channels: [${base.map(channelKey).join(", ")}]\n`).cfg;
    const vendored = base.map((c) => ({ ...c, vendor: c.adapter === "codex" ? "openai" : "anthropic" }));
    expect(tally(picks(pool("any"), vendored, mixed))).toEqual({ [f]: 198, [a]: 202 });
    expect(tally(picks(pool("ordered"), base, mixed))).toEqual({ [f]: 400 });
    const byComplexity = picks(cfgBase, base, mixed);
    expect(tally(byComplexity)).toEqual({ [f]: 120, [o]: 94, [a]: 93, [s]: 93 });
    mixed.forEach((t, i) => expect(byComplexity[i] === f, t.id).toBe(t.complexity >= 8));

    // (vii) turns are real turns, and stable
    // U1 a sample whose hashes are all odd
    const x = ch("u:x", 65), y = ch("u:y", 64), z = ch("u:z", 50);
    const u1 = graphOf(Array.from({ length: 400 }, (_, i) => ({ complexity: 9, goal: `work ${i + 1}` })));
    expect(u1.every((t) => spreadOffset(t) % 2 === 1)).toBe(true);
    expect(tally(picks(cfgFor([x, y, z]), [x, y, z], u1))).toEqual({ "u:x": 200, "u:y": 200 });
    // U2 a graph of three tasks
    const u2 = graphOf([{ complexity: 3, goal: "a" }, { complexity: 5, goal: "b" }, { complexity: 7, goal: "c" }]);
    expect(picks(cfgBase, base, u2)).toEqual([o, a, s]);
    expect(route(u2[0], cfgBase, base, undefined, undefined, undefined, undefined, u2).provenance)
      .toBe("by complexity: the rest 1-7, group 2 of 2, one of 3 that take turns (config routing.map)");
    // U3 turns counted over the peers, not the graph
    const u3 = graphOf([9, 3, 5, 8, 2, 7, 10, 4, 6, 1].map((complexity) => ({ complexity })));
    expect(picks(cfgBase, base, u3)).toEqual([f, o, a, f, s, o, f, a, s, o]);
    expect(route(u3[0], cfgBase, base, undefined, undefined, undefined, undefined, u3).provenance)
      .toBe("by complexity: very complex 8-10, group 1 of 2 (config routing.map)");
    // U4 no graph: the task's hash stands for the rank
    const G = [o, a, s];
    for (const t of c5.slice(0, 60)) {
      const h = spreadOffset(t);
      const turn = G[h % 3];
      expect(channelKey(route(t, cfgBase, base).assignment)).toBe(turn);
      const usable = G.filter((k) => k !== turn);
      expect(channelKey(route(t, cfgBase, base, undefined, undefined, new Set([turn])).assignment)).toBe(usable[Math.floor(h / 3) % 2]);
    }
    // U6 two tasks of one range with different own bars: each rank 0 among its own peers
    const u6 = graphOf([{ complexity: 5 }, { complexity: 5, floor: "frontier" }]);
    expect(picks(cfgBase, base, u6)).toEqual([o, o]);
    // U7 stable turns, one of three stopped
    expect(picks(cfgBase, base, u2, new Set([a]))).toEqual([o, o, s]);
    // U8 four models of one group, two stopped
    const ms = [ch("w:m1", 60), ch("w:m2", 59), ch("w:m3", 58), ch("w:m4", 57)];
    const cfgM = cfgFor(ms);
    const u8 = allOf(12, 5);
    expect(picks(cfgM, ms, u8)).toEqual(Array.from({ length: 12 }, (_, i) => `w:m${(i % 4) + 1}`));
    const u8After = picks(cfgM, ms, u8, new Set(["w:m2", "w:m4"]));
    expect(u8After).toEqual(["w:m1", "w:m1", "w:m3", "w:m1", "w:m1", "w:m3", "w:m3", "w:m3", "w:m1", "w:m1", "w:m3", "w:m1"]);
    expect(tally(u8After)).toEqual({ "w:m1": 7, "w:m3": 5 });
    const big = allOf(400, 5);
    const bigBefore = picks(cfgM, ms, big);
    const bigAfter = picks(cfgM, ms, big, new Set(["w:m2", "w:m4"]));
    expect(tally(bigAfter)).toEqual({ "w:m1": 200, "w:m3": 200 });
    for (const stopped of ["w:m2", "w:m4"]) {
      expect(tally(bigAfter.filter((_, i) => bigBefore[i] === stopped))).toEqual({ "w:m1": 50, "w:m3": 50 });
    }
    // U9 400 of c5 on the line of (iii), A stopped; routed in reverse, one at a time, the same picks
    const ex = new Set([a]);
    const forward = picks(cfg, line, c5, ex);
    const reverse = [...c5].reverse().map((t) => channelKey(route(t, cfg, line, undefined, undefined, ex, undefined, c5).assignment)).reverse();
    expect(reverse).toEqual(forward);
    expect(tally(forward)).toEqual({ [o]: 201, [s]: 199 });
  }, 300_000);

  test("hardFrom and similarWithin default to 8 and 5; a bad value is a config error naming its key", () => {
    const { cfg } = load("");
    expect(cfg.routing.hardFrom).toBe(8);
    expect(cfg.routing.similarWithin).toBe(5);
    const ok = load("routing:\n  hardFrom: 2\n  similarWithin: 0\n").cfg.routing;
    expect([ok.hardFrom, ok.similarWithin]).toEqual([2, 0]);
    expect(load("routing:\n  hardFrom: 10\n  similarWithin: 100\n").cfg.routing.similarWithin).toBe(100);
    for (const v of ["1", "11", "7.5", '"8"', "[8]"]) {
      expect(() => load(`routing:\n  hardFrom: ${v}\n`), v).toThrow(/routing\.hardFrom/);
    }
    for (const v of ["-1", "100.5", '"5"', "true"]) {
      expect(() => load(`routing:\n  similarWithin: ${v}\n`), v).toThrow(/routing\.similarWithin/);
    }
    // the new mode loads; a mode outside the three does not
    expect(cfgFor([F]).routing.map.implement.pool?.mode).toBe("complexity");
    expect(() => load("routing:\n  map:\n    implement:\n      pool: { mode: hardest, channels: [a:b] }\n")).toThrow();
  }, 300_000);
});
