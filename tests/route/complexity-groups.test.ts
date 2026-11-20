import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type BillingChannel, channelKey } from "../../src/adapters/types.js";
import { loadConfigWithMode, type TickmarkrConfig } from "../../src/config/config.js";
import { type Task, validateGraph } from "../../src/graph/schema.js";
import { complexityRanges } from "../../src/route/complexity.js";
import { route } from "../../src/route/router.js";

// Rows 501, 502 (D-2187 add.363): the contract's closed case tables (i) and (ii), executed through
// route() on a config loadConfigWithMode loaded.

type Tier = BillingChannel["tier"];
const ch = (key: string, score?: number, tier: Tier = "frontier", identity?: string): BillingChannel => {
  const i = key.indexOf(":");
  return {
    adapter: key.slice(0, i), vendor: "v", model: key.slice(i + 1), channel: "sub", tier,
    ...(identity ? { identity } : {}), ...(score === undefined ? {} : { score }),
  };
};

const repo = mkdtempSync(join(tmpdir(), "tkr-cx-groups-r-"));
const globalDir = mkdtempSync(join(tmpdir(), "tkr-cx-groups-g-"));
const cfgFor = (channels: readonly BillingChannel[], routing = ""): TickmarkrConfig =>
  loadConfigWithMode(repo, {
    globalDir,
    repoOverlayText: `routing:\n${routing}  map:\n    implement:\n      pool:\n        mode: complexity\n        channels: [${channels.map(channelKey).join(", ")}]\n`,
  }).cfg;

const graphOf = (n: number, complexity: (i: number) => number): Task[] =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: Array.from({ length: n }, (_, k) => ({
      id: `T${k + 1}`, title: "t", goal: `simulated implement task ${k * 7919}`, shape: "implement",
      complexity: complexity(k + 1), acceptance: ["a"],
    })),
  }).tasks;

/** Each group, read off route(): the models that took a graph of 400 at each complexity, by the group it names. */
function groupsByRoute(cfg: TickmarkrConfig, channels: BillingChannel[], exclude?: ReadonlySet<string>): string[][] {
  const groups: Set<string>[] = [];
  for (let c = 1; c <= 10; c++) {
    const graph = graphOf(400, () => c);
    for (const t of graph) {
      const r = route(t, cfg, channels, undefined, undefined, exclude, undefined, graph);
      const m = /group (\d+) of (\d+)/.exec(r.provenance)!;
      const i = Number(m[1]) - 1;
      (groups[i] ??= new Set()).add(channelKey(r.assignment));
    }
  }
  return groups.map((g) => [...g]);
}

const F = ch("claude-code:claude-fable-5-2", 64.6);
const O = ch("claude-code:claude-opus-5-5", 59.1);
const A = ch("codex:gpt-6-astra", 56.9);
const S = ch("codex:gpt-6.1-sol", 54.6);
const k = channelKey;

const cell = (channels: BillingChannel[], routing = "", exclude?: ReadonlySet<string>) =>
  groupsByRoute(cfgFor(channels, routing), channels, exclude);

describe("rows 501, 502: (i) grouping", () => {
  test("the grouping cells G1 to G12 give the groups the contract's closed case table says", () => {
    // G1 base: {F} {O, A, S}
    expect(cell([F, O, A, S])).toEqual([[k(F)], [k(O), k(A), k(S)]]);
    // G2 equal at similarWithin 0: one group, written order
    expect(cell([ch("a:m1", 60), ch("b:m2", 60)], "  similarWithin: 0\n")).toEqual([["a:m1", "b:m2"]]);
    // G3 / G3b exactly 5 apart, float below and above 5
    expect(cell([ch("a:m1", 64.6), ch("b:m2", 59.6)])).toEqual([["a:m1", "b:m2"]]);
    expect(cell([ch("a:m1", 8.3), ch("b:m2", 3.3)])).toEqual([["a:m1", "b:m2"]]);
    // G4 just over
    expect(cell([ch("a:m1", 64.6), ch("b:m2", 59.5)])).toEqual([["a:m1"], ["b:m2"]]);
    // G5 a chain: m3 is 10 below the group's highest
    expect(cell([ch("a:m1", 64.6), ch("b:m2", 59.6), ch("c:m3", 54.6)])).toEqual([["a:m1", "b:m2"], ["c:m3"]]);
    // G6 one model takes 1-10
    expect(cell([S])).toEqual([[k(S)]]);
    const g6 = graphOf(1, () => 1);
    expect(route(g6[0], cfgFor([S]), [S], undefined, undefined, undefined, undefined, g6).provenance)
      .toBe("by complexity: every task 1-10, group 1 of 1 (config routing.map)");
    // G7 an alias pair is one model, one share
    const alias = ch("claude-code:fable", 64.6, "frontier", "claude-fable-5-2");
    const full = ch("claude-code:claude-fable-5-2", 64.6);
    expect(cell([alias, full, O])).toEqual([[k(alias)], [k(O)]]);
    // G8 one model through two CLIs, no identities: the provider path is not the model
    const omp = ch("omp:zai/glm-5.3", 40);
    const oc = ch("opencode:zai-coding-plan/glm-5.3", 40);
    expect(cell([omp, oc, S])).toEqual([[k(S)], [k(omp)]]);
    // G9 a missing score: grouped by level, the provenance names the model
    const Onone = ch("claude-code:claude-opus-5-5");
    const luna = ch("codex:gpt-6-luna", 41, "mid");
    const g9 = [F, Onone, A, luna];
    expect(cell(g9)).toEqual([[k(F), k(Onone), k(A)], [k(luna)]]);
    const t9 = graphOf(1, () => 9);
    expect(route(t9[0], cfgFor(g9), g9, undefined, undefined, undefined, undefined, t9).provenance)
      .toContain("; grouped by level: claude-code:claude-opus-5-5 has no score");
    // G10 a stand-in takes its model's turns: 400 of 400
    const standIn = ch("claude-code:claude-fable-5-2", 64.6);
    const g10 = [alias, standIn, O];
    const graph = graphOf(400, () => 9);
    const ex = new Set([k(alias)]);
    const picks = graph.map((t) => k(route(t, cfgFor(g10), g10, undefined, undefined, ex, undefined, graph).assignment));
    expect(picks.filter((p) => p === k(standIn))).toHaveLength(400);
    // G11 scores inside one tenth keep written order
    expect(cell([ch("a:m1", 60.01), ch("b:m2", 60.04)])).toEqual([["a:m1", "b:m2"]]);
    expect(cell([ch("b:m2", 60.04), ch("a:m1", 60.01)])).toEqual([["b:m2", "a:m1"]]);
    // G12 one identity known, one not
    expect(cell([ch("a:opus", 60, "frontier", "claude-opus-5-5"), ch("b:opus", 50)])).toEqual([["a:opus"], ["b:opus"]]);
    expect(cell([alias, ch("x:claude-fable-5-2", 64.6), S])).toEqual([[k(alias)], [k(S)]]);
  }, 300_000);
});

describe("rows 501, 502: (ii) complexity to group", () => {
  test("complexity maps to its group for 1 to 9 groups at complexity 1; hardFrom less one; hardFrom; 10", () => {
    for (let n = 1; n <= 9; n++) {
      // n models ten points apart: n groups
      const line = Array.from({ length: n }, (_, i) => ch(`a:m${i + 1}`, 90 - i * 10));
      const cfg = cfgFor(line);
      const groupAt = (c: number) => {
        const g = graphOf(1, () => c);
        return /group (\d+) of (\d+)/.exec(route(g[0], cfg, line, undefined, undefined, undefined, undefined, g).provenance)!.slice(1).map(Number);
      };
      expect(groupAt(1)).toEqual([n === 1 ? 1 : Math.min(n, 8), n]);
      expect(groupAt(7)).toEqual([n === 1 ? 1 : 2, n]);
      expect(groupAt(8)).toEqual([1, n]);
      expect(groupAt(10)).toEqual([1, n]);
    }
    expect(complexityRanges(1, 8)).toEqual([[1, 10]]);
    expect(complexityRanges(2, 8)).toEqual([[8, 10], [1, 7]]);
    expect(complexityRanges(3, 8)).toEqual([[8, 10], [4, 7], [1, 3]]);
    expect(complexityRanges(4, 8)).toEqual([[8, 10], [5, 7], [3, 4], [1, 2]]);
    expect(complexityRanges(8, 8)).toEqual([[8, 10], [7, 7], [6, 6], [5, 5], [4, 4], [3, 3], [2, 2], [1, 1]]);
    expect(complexityRanges(9, 8)).toEqual([...complexityRanges(8, 8), null]);
    expect(complexityRanges(3, 9)).toEqual([[9, 10], [5, 8], [1, 4]]);
    expect(complexityRanges(2, 10)).toEqual([[10, 10], [1, 9]]);
    expect(complexityRanges(3, 2)).toEqual([[2, 10], [1, 1], null]);
    // Table (ii), Other hardFrom: load every configuration and check both sides of every boundary,
    // including the picked model and the exact range words (D-2187 add.374).
    for (const { hardFrom, n, cases } of [
      { hardFrom: 9, n: 3, cases: [
        [1, 3, "complexity 1-4"], [4, 3, "complexity 1-4"],
        [5, 2, "complexity 5-8"], [8, 2, "complexity 5-8"],
        [9, 1, "very complex 9-10"], [10, 1, "very complex 9-10"],
      ] },
      { hardFrom: 10, n: 2, cases: [
        [1, 2, "the rest 1-9"], [9, 2, "the rest 1-9"], [10, 1, "very complex 10-10"],
      ] },
      { hardFrom: 2, n: 3, cases: [
        [1, 2, "complexity 1"], [2, 1, "very complex 2-10"], [10, 1, "very complex 2-10"],
      ] },
    ] as const) {
      const line = Array.from({ length: n }, (_, i) => ch(`a:m${i + 1}`, 90 - i * 10));
      const cfg = cfgFor(line, `  hardFrom: ${hardFrom}\n`);
      for (const [c, group, words] of cases) {
        const graph = graphOf(1, () => c);
        const result = route(graph[0], cfg, line, undefined, undefined, undefined, undefined, graph);
        const at = `hardFrom ${hardFrom}, ${n} groups, c${c}`;
        expect(channelKey(result.assignment), at).toBe(`a:m${group}`);
        expect(result.provenance, at).toBe(`by complexity: ${words}, group ${group} of ${n} (config routing.map)`);
      }
    }
  }, 300_000);

  test("every allowed hardFrom preserves the hard boundary for one to nine groups", () => {
    // Bounded generalisation of table (ii): 9 thresholds × 9 group counts × 4 boundary probes.
    for (let hardFrom = 2; hardFrom <= 10; hardFrom++) {
      for (let n = 1; n <= 9; n++) {
        const line = Array.from({ length: n }, (_, i) => ch(`a:m${i + 1}`, 90 - i * 10));
        const cfg = cfgFor(line, `  hardFrom: ${hardFrom}\n`);
        for (const [c, group] of [[1, Math.min(n, hardFrom)], [hardFrom - 1, n === 1 ? 1 : 2], [hardFrom, 1], [10, 1]]) {
          const graph = graphOf(1, () => c);
          const result = route(graph[0], cfg, line, undefined, undefined, undefined, undefined, graph);
          const at = `hardFrom ${hardFrom}, ${n} groups, c${c}`;
          expect(channelKey(result.assignment), at).toBe(`a:m${group}`);
          expect(result.provenance, at).toContain(`group ${group} of ${n}`);
        }
      }
    }
  });
});
