import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Assignment, type BillingChannel, channelKey } from "../../src/adapters/types.js";
import { loadConfigWithMode, type TickmarkrConfig } from "../../src/config/config.js";
import { type Task, validateGraph } from "../../src/graph/schema.js";
import { climbChannel, nextChannel, route, spreadOffset } from "../../src/route/router.js";

// Row 502 (D-2187 add.363): rule 8 of the contract's section 1.2 — every later choice of the router on a line
// by complexity stays in the task's own group or a stronger one, with no memory. Closed case table (iii-b).

type Tier = BillingChannel["tier"];
const ch = (key: string, score?: number, tier: Tier = "frontier", channel: "sub" | "api" = "sub"): BillingChannel => {
  const i = key.indexOf(":");
  return { adapter: key.slice(0, i), vendor: key.slice(0, i), model: key.slice(i + 1), channel, tier, ...(score === undefined ? {} : { score }) };
};
const as = (c: BillingChannel): Assignment => ({ adapter: c.adapter, model: c.model, channel: c.channel, tier: c.tier });

const repo = mkdtempSync(join(tmpdir(), "tkr-cx-retry-r-"));
const globalDir = mkdtempSync(join(tmpdir(), "tkr-cx-retry-g-"));
const load = (text: string) => loadConfigWithMode(repo, { globalDir, repoOverlayText: text }).cfg;
const poolCfg = (mode: string, channels: readonly BillingChannel[]): TickmarkrConfig =>
  load(`routing:\n  map:\n    implement:\n      pool:\n        mode: ${mode}\n        channels: [${channels.map(channelKey).join(", ")}]\n`);

const taskOf = (complexity: number, k = 0): Task =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: `T${k + 1}`, title: "t", goal: `simulated implement task ${k * 7919}`, shape: "implement", complexity, acceptance: ["a"] }],
  }).tasks[0];

const F = ch("claude-code:claude-fable-5-2", 64.6);
const O = ch("claude-code:claude-opus-5-5", 59.1);
const A = ch("codex:gpt-6-astra", 56.9);
const S = ch("codex:gpt-6.1-sol", 54.6);
const M = ch("codex:mid-model", 48.0, "mid");
const L = ch("codex:low-model", 48.0);
const C = ch("codex:cheap-model", 30, "cheap");
const [f, o, a, s, m, l, c] = [F, O, A, S, M, L, C].map(channelKey);

const rot = (keys: string[], t: Task) => { const k = spreadOffset(t) % keys.length; return [...keys.slice(k), ...keys.slice(0, k)]; };

type Fn = typeof nextChannel | typeof climbChannel;
/** Every candidate the function offers, in order: each pick joins `tried`, as the daemon's retries add it. */
const offers = (fn: Fn, cur: BillingChannel, t: Task, cfg: TickmarkrConfig, line: BillingChannel[], tried: string[], ex?: string[]) => {
  const out: string[] = [];
  const seen = [...tried];
  for (;;) {
    const p = fn(as(cur), t, cfg, line, seen, undefined, ex && new Set(ex));
    if (!p) return out;
    out.push(channelKey(p));
    seen.push(channelKey(p));
    if (out.length > 20) throw new Error("no end");
  }
};

// Several tasks, so the hash's rotation takes every place in a group of three.
const tasks = (cx: number) => Array.from({ length: 6 }, (_, k) => taskOf(cx, k));

describe("row 502: rule 8 — a later choice never goes below the task's own group", () => {
  const line = [F, O, A, S, M];
  const cfg = poolCfg("complexity", line);

  test("the cells Y1 to Y6 and Y5b offer the models the contract's closed case table says", () => {
    for (const t5 of tasks(5)) {
      // Y1 c5, first on O, O tried: its own group (the hash's order), then F; never M
      expect(offers(nextChannel, O, t5, cfg, line, [o])).toEqual([...rot([o, a, s], t5).filter((k) => k !== o), f]);
      // Y2 O, A and S tried: F; with F tried too, nothing — M is not offered
      expect(offers(nextChannel, O, t5, cfg, line, [o, a, s])).toEqual([f]);
      expect(nextChannel(as(O), t5, cfg, line, [o, a, s, f])).toBeNull();
      // Y6 a release after a review upheld: O excluded, routed again → A or S; then the other, then F; never M
      const p6 = channelKey(route(t5, cfg, line, undefined, undefined, new Set([o])).assignment);
      expect([a, s]).toContain(p6);
      const cur6 = p6 === a ? A : S;
      expect(offers(nextChannel, cur6, t5, cfg, line, [p6], [o])).toEqual([p6 === a ? s : a, f]);
    }
    for (const t9 of tasks(9)) {
      // Y3 a resume with nothing to restore: F excluded → the nearest weaker group; its repairs stay there
      const p3 = channelKey(route(t9, cfg, line, undefined, undefined, new Set([f])).assignment);
      expect([o, a, s]).toContain(p3);
      const cur3 = [O, A, S].find((x) => channelKey(x) === p3)!;
      expect(offers(nextChannel, cur3, t9, cfg, line, [p3], [f])).toEqual(rot([o, a, s], t9).filter((k) => k !== p3));
      expect(nextChannel(as(cur3), t9, cfg, line, [o, a, s], undefined, new Set([f]))).toBeNull();
      // Y4 F no longer excluded, nothing to restore: route() gives F
      expect(channelKey(route(t9, cfg, line).assignment)).toBe(f);
      // Y7 (second half) the task continued on a restored O; its next routed choice, O tried, is F
      expect(offers(nextChannel, O, t9, cfg, line, [o])).toEqual([f]);
    }
    for (const t2 of tasks(2)) {
      // Y5 line F, O, A, S, low-model 48 (FRONTIER): c2, low-model excluded, sent to O; back, O tried
      const line5 = [F, O, A, S, L];
      const cfg5 = poolCfg("complexity", line5);
      const p5 = channelKey(route(t2, cfg5, line5, undefined, undefined, new Set([l])).assignment);
      expect([o, a, s]).toContain(p5);
      const cur5 = [O, A, S].find((x) => channelKey(x) === p5)!;
      expect(offers(nextChannel, cur5, t2, cfg5, line5, [p5])).toEqual([l, ...rot([o, a, s], t2).filter((k) => k !== p5), f]);
      // Y5b the line of (iii), M MID: the level check removes M, O being frontier
      expect(offers(nextChannel, O, t2, cfg, line, [o])).toEqual([...rot([o, a, s], t2).filter((k) => k !== o), f]);
    }
  });

  test("climbChannel offers no model below the task's own group while that group or a stronger one can take the task", () => {
    // groups {F} {O, A, S} {M} {C}; ranges 8-10, 5-7, 3-4, 1-2: a c5 task's own group is {O, A, S}
    const line4 = [F, O, A, S, M, C];
    const cfg4 = poolCfg("complexity", line4);
    for (const t5 of tasks(5)) {
      const first = climbChannel(as(C), t5, cfg4, line4, [c]);
      expect(first?.climbed).toBe(true);
      expect(channelKey(first!)).toBe(rot([o, a, s], t5)[0]); // the base climbs one band, to M
      expect(offers(climbChannel, C, t5, cfg4, line4, [c])).toEqual([...rot([o, a, s], t5), f]);
      // the own group all tried: still nothing below it
      expect(offers(climbChannel, C, t5, cfg4, line4, [c, o, a, s])).toEqual([f]);
      // the own group excluded in the run (step 7): the nearest stronger group, never M
      expect(offers(climbChannel, C, t5, cfg4, line4, [c], [o, a, s])).toEqual([f]);
    }
  });

  test("a task that continued on a restored model below its own group is offered its own group at its next routed choice", () => {
    for (const t5 of tasks(5)) {
      // restored on M (group 3), M tried: the next routed choice is its own group {O, A, S}, then F
      expect(offers(nextChannel, M, t5, cfg, line, [m])).toEqual([...rot([o, a, s], t5), f]);
      const climb = climbChannel(as(M), t5, cfg, line, [m]);
      expect(climb?.climbed).toBe(true);
      expect(channelKey(climb!)).toBe(rot([o, a, s], t5)[0]);
    }
  });
});

describe("row 502: rule 8 keeps the provider-outage read of the whole pool", () => {
  // Reviewer reproducers: the group limit applies to the candidates, never to the pool the outage rule reads,
  // so a filtered-out sibling of the current adapter neither fakes an outage nor hides one.
  const oa = (key: string, score: number, tier: Tier = "frontier", vendor = "openai"): BillingChannel => ({ ...ch(key, score, tier), vendor });
  const F2 = oa("claude-code:claude-fable-5-2", 64.6, "frontier", "anthropic");
  const A2 = oa("codex:gpt-6-astra", 59.1);
  const S2 = oa("omp:openai/gpt-6.1-sol", 56.9);
  const M2 = oa("codex:gpt-5-mini", 48, "cheap");
  const t5 = taskOf(5);
  const cases: Array<[string, BillingChannel[], BillingChannel, string]> = [
    ["false outage, frontier", [F2, A2, S2, M2], A2, channelKey(S2)],
    ["false outage, mid", [F2, { ...A2, tier: "mid" }, S2, M2], { ...A2, tier: "mid" }, channelKey(S2)],
    ["lost outage", [F2, S2, M2], M2, channelKey(F2)],
  ];
  test.each(cases)("%s: nextChannel and climbChannel keep the base's outage verdict", (_n, line, cur, want) => {
    const cfg = poolCfg("complexity", line);
    for (const fn of [nextChannel, climbChannel]) {
      const p = fn(as(cur), t5, cfg, line, [channelKey(cur)]);
      expect(p && channelKey(p)).toBe(want);
    }
  });
});

describe("row 502: rule 8 leaves the other pools and open routing as they are", () => {
  // Frozen from 2.26.1 (the base, c55fc812e) by running the same calls there.
  const fleet = [F, O, A, S, M, C, ch("api:metered-mid", undefined, "mid", "api"), ch("api:metered-top", undefined, "frontier", "api")];
  const cases: Array<[string, TickmarkrConfig]> = [
    ["any", poolCfg("any", [F, O, A, S, M, C])],
    ["ordered", poolCfg("ordered", [F, O, A, S, M, C])],
    ["open", load("routing: {}\n")],
  ];
  const run = (cfg: TickmarkrConfig) =>
    [1, 5, 9].flatMap((cx) => [taskOf(cx, cx)].flatMap((t) => [C, M, O].flatMap((cur) => [
      offers(nextChannel, cur, t, cfg, fleet, [channelKey(cur)]).join(" "),
      offers(nextChannel, cur, t, cfg, fleet, [channelKey(cur)], [a]).join(" "),
      offers(climbChannel, cur, t, cfg, fleet, [channelKey(cur)]).join(" "),
      offers(climbChannel, cur, t, cfg, fleet, [channelKey(cur)], [o]).join(" "),
    ])));

  test("on any pools; ordered pools; open routing: nextChannel and climbChannel return what they return in 2.26.1", () => {
    const got = Object.fromEntries(cases.map(([k, cfg]) => [k, run(cfg)]));
    if (process.env.T2_CAPTURE) console.log(`T2CAP${JSON.stringify(got)}T2CAP`);
    expect(got).toEqual(BASE);
  });
});

const BASE: Record<string, string[]> = {
  any: [
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
  ],
  ordered: [
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "codex:mid-model claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol",
  ],
  open: [
    "codex:mid-model api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "codex:mid-model api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol api:metered-top",
    "codex:mid-model api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "codex:mid-model api:metered-mid claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol api:metered-top",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top api:metered-mid",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top api:metered-mid",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "claude-code:claude-fable-5-2 codex:gpt-6.1-sol api:metered-top",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "codex:mid-model api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "codex:mid-model api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol api:metered-top",
    "codex:mid-model api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "codex:mid-model api:metered-mid claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol api:metered-top",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top api:metered-mid",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top api:metered-mid",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "claude-code:claude-fable-5-2 codex:gpt-6.1-sol api:metered-top",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "codex:mid-model api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "codex:mid-model api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol api:metered-top",
    "codex:mid-model api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "codex:mid-model api:metered-mid claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "api:metered-mid claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6.1-sol api:metered-top",
    "claude-code:claude-fable-5-2 claude-code:claude-opus-5-5 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top api:metered-mid",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top api:metered-mid",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "claude-code:claude-fable-5-2 codex:gpt-6.1-sol api:metered-top",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
    "claude-code:claude-fable-5-2 codex:gpt-6-astra codex:gpt-6.1-sol api:metered-top",
  ],
};
