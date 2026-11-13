// The team model: sample tasks through the product's own router and seat resolver, with stub
// adapters and hand-written doctor results. No model is called.
import { describe, expect, test } from "vitest";
import { buildFleetModel, consequence, shortName } from "../../src/fleet/model.js";
import { freeSeat, othersOf } from "../../src/fleet/rules.js";
import { health, POOL, source } from "./world.js";

describe("YOUR TEAM", () => {
  test("a model is shown by its own id, without the provider path a gateway puts in front", () => {
    expect(["claude-opus-5-5", "gpt-6.1-sol", "zai/glm-5.3", "google/gemini-3.8-flash", "grok-4.7", "kimi-code/k3"].map(shortName))
      .toEqual(["claude-opus-5-5", "gpt-6.1-sol", "glm-5.3", "gemini-3.8-flash", "grok-4.7", "k3"]);
    // an alias is shown as the model it was probed as
    const h = health();
    (h["claude-code"].modelAuth!.fable as { identity?: string }).identity = "claude-fable-5-2";
    expect(buildFleetModel(source({ health: h }).inputs).name("claude-code:fable")).toBe("claude-fable-5-2");
  });
});

describe("answers and the one write path", () => {
  test("the review compares counts over the same sample tasks: a share that moves on its own is not a change", () => {
    const M = buildFleetModel(source({ repoText: POOL }).inputs);
    const a = M.sample();
    const withSample = (over: Partial<typeof a>) => ({ ...M, sample: () => ({ ...a, ...over }) }) as typeof M;
    // only the share of tasks that have a worker moved (more tasks got one): no task's reviewer or judge changed
    const shares = consequence(M, withSample({ routed: a.routed - 400 }));
    expect(shares.changes.map((c) => c.label)).toEqual([]);
    // tasks did change: the line gives both counts and calls more unreviewed tasks worse
    const counts = consequence(M, withSample({ noReviewer: a.noReviewer + 1200, ownVendor: a.ownVendor }));
    expect(counts.changes).toEqual([{ label: "tasks with no reviewer", before: a.noReviewer.toLocaleString("en-US"), after: (a.noReviewer + 1200).toLocaleString("en-US"), better: false }]);
    expect(consequence(withSample({ ownVendor: 400 }), withSample({ ownVendor: 0 })).changes).toEqual([{ label: "tasks judged by the worker's vendor", before: "400", after: "0", better: true }]);
  });
  test("a shape is thin by its own pool: one model at the floor in the pool, however many the machine has", () => {
    const pooled = buildFleetModel(source({ repoText: POOL }).inputs).sample().thin;
    const open = buildFleetModel(source({ repoText: "routing:\n  mode: partner-led\n" }).inputs).sample().thin;
    expect(pooled).toContain("implement");
    expect(open).not.toContain("implement");
  });
});

describe("a lowered floor", () => {
  test("a floor set through a YAML alias of routing is compared with the mode as a direct one is", () => {
    const direct = "routing:\n  mode: partner-led\n  floors:\n    implement: cheap\n";
    const aliased = "defaults: &routing\n  mode: partner-led\n  floors:\n    implement: cheap\nrouting: *routing\n";
    const lowered = (repoText: string) => buildFleetModel(source({ repoText }).inputs).lowered;
    expect(lowered(direct).implement?.own).toBe("cheap");
    expect(lowered(aliased)).toEqual(lowered(direct));
  });
});

describe("RULING-T5 rule 4: a lowered floor is read from loaded values", () => {
  test("every form of the same floor gives the same lowered answer; a floor the mode writes is not lowered", () => {
    const lowered = (repoText: string) => buildFleetModel(source({ repoText }).inputs).lowered;
    const want = { implement: { own: "cheap", mode: "frontier" } };
    expect(lowered("routing:\n  mode: partner-led\n  floors:\n    implement: cheap\n")).toEqual(want);
    for (const repoText of [
      "r: &r\n  mode: partner-led\n  floors:\n    implement: cheap\nrouting: *r\n",
      "%YAML 1.1\n---\nr: &routing\n  mode: partner-led\n  floors:\n    implement: cheap\nrouting:\n  <<: *routing\n",
      "f: &f\n  implement: cheap\nrouting:\n  mode: partner-led\n  floors: *f\n",
      "%YAML 1.1\n---\nf: &f\n  implement: cheap\nrouting:\n  mode: partner-led\n  floors:\n    <<: *f\n",
    ]) expect(lowered(repoText), repoText).toEqual(want);
    expect(lowered("routing:\n  mode: partner-led\n")).toEqual({});
  });
});

describe("RULING-T5 rule 5: an entry that names a CLI is the CLI's rule", () => {
  // kimi's other default models tombstoned: kimi-code/k3 is the CLI's only model today
  const kimi = (deny: string) => `tiers:\n  kimi:\n    models:\n      kimi-code/kimi-for-coding: null\n      kimi-code/kimi-for-coding-highspeed: null\nrouting:\n  deny:\n${deny}\nconsult:\n  prefer: [kimi:kimi-code/k3]\n`;
  const free = (deny: string, role: "consult" | "worker" = "consult") => {
    const M = buildFleetModel(source({ repoText: kimi(deny) }).inputs);
    const s = M.seat("kimi:kimi-code/k3")!;
    expect(M.seats.filter((x) => x.adapter === "kimi").map((x) => x.key)).toEqual(["kimi:kimi-code/k3"]);
    const r = structuredClone(M.cfg.routing);
    return { result: freeSeat(r, s, s.key, role, othersOf(M, s.key)), deny: r.deny };
  };
  test("a model's yes never lifts a whole-CLI rule, however few models the CLI has today; its own entry it lifts", () => {
    // a workers-only rule keeps the model from work, not from consulting: its cell is a tick on work
    for (const [deny, role] of [["    adapters: [kimi]", "consult"], ["    workers:\n      adapters: [kimi]", "worker"], ["    models: [kimi]", "consult"]] as const) {
      const { result, deny: after } = free(deny, role);
      expect(result.freed, deny).toBe(false);
      expect(result.why.join(" "), deny).toContain("the deny rule kimi");
      expect(JSON.stringify(after), deny).toContain('"kimi"');
    }
    const own = free("    models: [kimi:kimi-code/k3]");
    expect(own.result.freed).toBe(true);
    expect(own.deny?.models ?? []).toEqual([]);
  });
});
