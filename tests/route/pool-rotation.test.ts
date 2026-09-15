import { expect, test } from "vitest";
import { type BillingChannel, channelKey } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, type Tier } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import { routingModelProvider } from "../../src/route/preference.js";
import { route, RoutingError } from "../../src/route/router.js";

const POOL: BillingChannel[] = [
  { adapter: "qwen", vendor: "alibaba", model: "qwen3.8-max", channel: "sub", tier: "frontier" },
  { adapter: "grok", vendor: "xai", model: "grok-4.6", channel: "sub", tier: "frontier" },
  { adapter: "omp", vendor: "mixed", model: "xai/grok-4.6", channel: "sub", tier: "frontier" },
  { adapter: "omp", vendor: "mixed", model: "google/gemini-3.8-flash", channel: "sub", tier: "mid" },
  { adapter: "claude-code", vendor: "anthropic", model: "opus", channel: "sub", tier: "frontier" },
];
const API: BillingChannel = { adapter: "codex", vendor: "openai", model: "gpt-5.5", channel: "api", tier: "frontier" };
const task = (id = "T1", floor?: Tier) => validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id, title: "pool fixture", goal: "Implement fixture task", shape: "implement", complexity: 5,
    acceptance: ["a"], ...(floor ? { routingHints: { floor } } : {}) }],
}).tasks[0];
const config = (mode: "any" | "ordered", members = POOL) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.routing.map = { implement: { pool: { mode, channels: members.map(channelKey) } } };
  cfg.routing.floors = {};
  return cfg;
};
// Independently pinned polynomial offsets for the exact ids and goal above. Provider order is
// alibaba, xai, google, anthropic; the duplicate Grok transport must not get an extra turn.
const CASES = [
  { id: "T1", offset: 2321842886, provider: "google", member: 3 },
  { id: "T2", offset: 2254836133, provider: "xai", member: 1 },
  { id: "T3", offset: 2187829380, provider: "alibaba", member: 0 },
  { id: "T4", offset: 2120822627, provider: "anthropic", member: 4 },
  { id: "T5", offset: 2053815874, provider: "google", member: 3 },
];
const provider = (c: BillingChannel) => routingModelProvider(c.model, c.vendor);
const assignment = ({ adapter, model, channel, tier }: BillingChannel) => ({ adapter, model, channel, tier });

test("test: five tasks with the fixture's exact ids and goals routed over the declared five-member pool — qwen, two Grok transports, gemini and the opus alias, all equal-cost sub — each land on the provider the group rotation names for that task's offset, which differs from a channel-slot rotation on at least one task because Grok holds two slots, at least three providers are visited, a costlier api member never precedes a sub member, and routing the same task twice yields the same channel, so a pool pick that concentrates on the lowest tier, rotates channel slots, or rotates unstably fails", () => {

  const visited = new Set<string>();
  let differsFromSlots = false;
  for (const fixture of CASES) {
    expect(["alibaba", "xai", "google", "anthropic"][fixture.offset % 4]).toBe(fixture.provider);
    differsFromSlots ||= provider(POOL[fixture.offset % POOL.length]) !== fixture.provider;
    const t = task(fixture.id);
    const cfg = config("any");
    // Discovery order must not replace declaration order.
    const actual = route(t, cfg, [...POOL].reverse());
    expect(actual.assignment).toEqual(assignment(POOL[fixture.member]));
    const pickedProvider = provider(POOL.find((c) => channelKey(c) === channelKey(actual.assignment))!);
    expect(pickedProvider).toBe(fixture.provider);
    visited.add(pickedProvider);
    expect(route(t, cfg, POOL)).toEqual(actual);
    expect(route(t, cfg, POOL)).toEqual(route(t, cfg, POOL));
    const withApi = [API, ...POOL];
    expect(route(t, config("any", withApi), withApi).assignment).toEqual(actual.assignment);
  }
  expect(differsFromSlots).toBe(true);
  expect(visited.size).toBeGreaterThanOrEqual(3);
});

test("test: a task with floor frontier over a pool holding mid and frontier members routes to a frontier member, a task with floor frontier over a pool holding only mid members throws naming the floor and the declared members, and a mode floor above every pool member still routes with the pool lint, so a task floor advisory on pools or a mode floor made hard fails", () => {

  const mid = [POOL[3]];
  expect(route(task("T1", "frontier"), config("any"), POOL).assignment).toEqual(assignment(POOL[4]));
  for (const live of [mid, []]) {
    const pick = () => route(task("T1", "frontier"), config("any", mid), live);
    expect(pick).toThrow(RoutingError);
    expect(pick).toThrow("floor frontier");
    expect(pick).toThrow(mid.map(channelKey).join(", "));
  }
  const cfg = config("any", mid);
  cfg.routing.floors = { implement: "frontier" };
  const actual = route(task(), cfg, mid);
  expect(actual.assignment).toEqual(assignment(mid[0]));
  expect(actual.lints).toEqual(["T1 (implement): map pool routes mid, below config floor frontier — map pools are supreme"]);
});

test("test: an ordered pool listing a mid member before a frontier member routes to the frontier member under a frontier task floor and throws naming the floor when no member reaches it, while an ordered pool the floor excludes nothing from, a bare map pin and the floor/auto path each route byte-identically to the base, so a rotation that leaks outside the any branch or an ordered pick below the task floor fails", () => {

  const members = [POOL[3], POOL[0], POOL[4]];
  const cfg = config("ordered", members);
  expect(route(task("T1", "frontier"), cfg, POOL).assignment).toEqual(assignment(POOL[0]));
  const exhausted = () => route(task("T1", "frontier"), config("ordered", [POOL[3]]), POOL);
  expect(exhausted).toThrow(RoutingError);
  expect(exhausted).toThrow("floor frontier");
  expect(exhausted).toThrow(channelKey(POOL[3]));

  // Complete pre-change route bytes, including lints, provenance and ladder (not just assignment).
  const orderedBase = '{"assignment":{"adapter":"omp","model":"google/gemini-3.8-flash","channel":"sub","tier":"mid"},"ladder":["retry","escalate","consult","human"],"lints":[],"provenance":"pool ordered omp:google/gemini-3.8-flash (config routing.map)"}';
  const pinBase = '{"assignment":{"adapter":"omp","model":"google/gemini-3.8-flash","channel":"sub","tier":"mid"},"ladder":["retry","escalate","consult","human"],"lints":["T1 (implement): map pin routes mid, below task floor frontier — map pins are supreme"],"provenance":"pin omp:google/gemini-3.8-flash (config routing.map)"}';
  const autoBase = '{"assignment":{"adapter":"omp","model":"google/gemini-3.8-flash","channel":"sub","tier":"mid"},"ladder":["retry","escalate","consult","human"],"lints":[],"provenance":"tier cheap (default), marginal-cost auto (cheapest sufficient tier)"}';
  const floorBase = autoBase.replace("tier cheap (default)", "floor mid (config floors)");
  for (const fixture of CASES) {
    expect(JSON.stringify(route(task(fixture.id, "mid"), cfg, POOL))).toBe(orderedBase);
    const auto = config("any");
    auto.routing.map = {};
    expect(JSON.stringify(route(task(fixture.id), auto, POOL))).toBe(autoBase);
    auto.routing.floors = { implement: "mid" };
    expect(JSON.stringify(route(task(fixture.id), auto, POOL))).toBe(floorBase);
  }
  const pin = config("any");
  pin.routing.map = { implement: { pin: { via: "omp", model: POOL[3].model } } };
  expect(JSON.stringify(route(task("T1", "frontier"), pin, POOL))).toBe(pinBase);
});
test("provider rotation precedes tier, and tier precedes declaration order inside the chosen provider", () => {
  const members = POOL.map((c, i) => i === 2 ? { ...c, tier: "mid" as const } : c);
  expect(route(task("T2"), config("any", members), members).assignment).toEqual(assignment(members[2]));
});

test("only live, unexcluded providers participate in rotation, with declaration order breaking transport ties", () => {
  const cfg = config("any");
  const exclude = new Set([channelKey(POOL[0])]);
  // Three remaining groups: xai, google, anthropic; T1 offset % 3 = 2.
  expect(route(task(), cfg, POOL, undefined, undefined, exclude).assignment).toEqual(assignment(POOL[4]));
  expect(route(task(), cfg, POOL.slice(1)).assignment).toEqual(assignment(POOL[4]));
  // Losing one Grok transport keeps the same four groups and the same provider turn.
  expect(route(task("T2"), cfg, POOL.filter((_, i) => i !== 1)).assignment).toEqual(assignment(POOL[2]));
});
