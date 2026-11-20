import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Assignment, type BillingChannel, channelKey } from "../../src/adapters/types.js";
import { loadConfigWithMode, TIER_RANK, type TickmarkrConfig, type Tier } from "../../src/config/config.js";
import { SHAPES, type Task, validateGraph } from "../../src/graph/schema.js";
import { disallowedBy, routingModelProvider } from "../../src/route/preference.js";
import { learnedScore, type RoutingProfile } from "../../src/route/profile.js";
import {
  channelExclusion, climbChannel, marginalCostRank, nextChannel, resolvedFloor, type Route, route, RoutingError,
} from "../../src/route/router.js";

// Rows 501, 502 (D-2187 add.363), the contract's table (vi): `any` and `ordered` are unchanged. The oracle is a
// copy of the base's pool branch of route(), rankAnyPool, nextChannel and climbChannel (c9b635ac7).

const baseSpread = (task: Task): number => {
  let h = 0;
  for (const ch of `${task.id}\n${task.goal}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};
function baseRankAnyPool(live: BillingChannel[], task: Task): BillingChannel[] {
  const sorted = [...live].sort((a, b) => marginalCostRank(a) - marginalCostRank(b));
  const out: BillingChannel[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && marginalCostRank(sorted[j]) === marginalCostRank(sorted[i])) j++;
    const groups = new Map<string, BillingChannel[]>();
    for (const c of sorted.slice(i, j)) {
      const provider = routingModelProvider(c.model, c.vendor);
      const group = groups.get(provider) ?? [];
      group.push(c);
      groups.set(provider, group);
    }
    const ordered = [...groups.values()];
    const k = baseSpread(task) % ordered.length;
    for (const group of [...ordered.slice(k), ...ordered.slice(0, k)]) out.push(...group.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]));
    i = j;
  }
  return out;
}
/** The base's pool branch of route() for a task with no pin of its own and no profile. */
function baseRoute(task: Task, cfg: TickmarkrConfig, offered: BillingChannel[], exclude?: ReadonlySet<string>): Route {
  const observed = new Map(offered.flatMap((c) => (c.identity ? [[channelKey(c), c.identity] as const] : [])));
  const seat = (adapter: string, model: string) => {
    const identity = observed.get(channelKey({ adapter, model }));
    return identity ? { adapter, model, identity } : { adapter, model };
  };
  let channels = offered;
  if (exclude?.size) { const ex = channelExclusion(offered, exclude); channels = offered.filter((c) => !ex(c)); }
  const entry = cfg.routing.map[task.shape]!;
  const pool = entry.pool!;
  const lints: string[] = [];
  const taskFloor = task.routingHints?.floor;
  const mapPinFloor = resolvedFloor(task, cfg);
  const prefActive = !!(cfg.routing.allow || cfg.routing.deny);
  const skipped: string[] = [];
  const admitted = pool.channels.filter((p) => {
    if (!prefActive) return true;
    const i = p.indexOf(":");
    const d = disallowedBy(seat(p.slice(0, i), p.slice(i + 1)), cfg.routing);
    if (d) skipped.push(`${p} (disallowed by routing.${d.by} (${d.entry}))`);
    return d === null;
  });
  const skippedNote = skipped.length ? `; skipped ${skipped.join(", ")}` : "";
  if (!admitted.length) throw new RoutingError(`${task.id}: routing.map.${task.shape}.pool is exhausted — no admitted entry remains: ${skipped.join(", ")} — remove the deny/allow entry or add an admitted channel to the pool`);
  const live = admitted.map((id) => channels.find((c) => channelKey(c) === id))
    .filter((c): c is BillingChannel => c !== undefined && (!taskFloor || TIER_RANK[c.tier] >= TIER_RANK[taskFloor]));
  if (!live.length) throw new RoutingError(`${task.id}: routing.map.${task.shape}.pool has no live channel${taskFloor ? ` at task floor ${taskFloor}` : ""} — declared: ${pool.channels.join(", ")}${skippedNote}; doctor found: ${channels.map(channelKey).join(", ") || "(nothing)"}`);
  const chosen = pool.mode === "ordered" ? live[0] : baseRankAnyPool(live, task)[0];
  if (mapPinFloor && TIER_RANK[chosen.tier] < TIER_RANK[mapPinFloor.tier]) {
    lints.push(`${task.id} (${task.shape}): map pool routes ${chosen.tier}, below ${mapPinFloor.source} floor ${mapPinFloor.tier} — map pools are supreme`);
  }
  const escalate = task.routingHints?.escalate ?? entry.escalate ?? true;
  const assignment = { adapter: chosen.adapter, model: chosen.model, channel: chosen.channel, tier: chosen.tier, ...(chosen.effort ? { effort: chosen.effort } : {}) };
  return { assignment, ladder: escalate ? ["retry", "escalate", "consult", "human"] : ["retry", "consult", "human"], lints, provenance: `pool ${pool.mode} ${channelKey(chosen)} (config routing.map${skippedNote})` };
}

// Frozen from c9b635ac7: retry/climb and their router helpers. Keep this reference independent
// of today's nextChannel/climbChannel so a later routing change cannot rewrite the expected result.
function baseMarginalCostRank(c: BillingChannel): number {
  if (c.channel === "sub") return 0; // flat-rate: ~zero marginal cost until quota
  return TIER_RANK[c.tier] + 1;      // metered API: cheap 1, mid 2, frontier 3
}

const baseToAssignment = (c: BillingChannel): Assignment => ({
  adapter: c.adapter, model: c.model, channel: c.channel, tier: c.tier,
  ...(c.effort ? { effort: c.effort } : {}),
});

const baseTaskPool = (task: Task, cfg: TickmarkrConfig) => cfg.routing.map[task.shape]?.pool;

const baseInTaskPool = (task: Task, cfg: TickmarkrConfig, key: string): boolean =>
  baseTaskPool(task, cfg)?.channels.includes(key) ?? true;

function baseChannelExclusion(offered: readonly BillingChannel[], excluded: Iterable<string>): (seat: Pick<Assignment, "adapter" | "model">) => boolean {
  const keys = new Set(excluded);
  const identityOf = new Map(offered.flatMap((c) => (c.identity ? [[channelKey(c), c.identity] as const] : [])));
  const identities = new Set([...keys].flatMap((k) => identityOf.get(k) ?? []));
  return (seat) => {
    const key = channelKey(seat);
    const identity = identityOf.get(key);
    return keys.has(key) || (identity !== undefined && identities.has(identity));
  };
}

function baseCandidatePool(
  current: Assignment,
  task: Task,
  cfg: TickmarkrConfig,
  channels: BillingChannel[],
  tried: string[],
  tierPredicate: (tier: Tier) => boolean,
  exclude?: ReadonlySet<string>,
): BillingChannel[] {
  // D-718: tried/escalated/demoted keys share baseChannelExclusion's meaning, resolved against every offered
  // channel; the provider-outage rule below still reads the raw-key remainder exactly as before.
  const excluded = baseChannelExclusion(channels, [...(exclude ?? []), ...tried]);
  channels = channels.filter((c) => !exclude?.has(channelKey(c)) && baseInTaskPool(task, cfg, channelKey(c)));
  const triedKeys = new Set(tried);
  // excludeAdapter is expanded by the daemon into every channel key of the failed adapter. Once that
  // complete set is present, the outage follows the current served provider across gateway aliases.
  const currentAdapterExcluded = channels.some((c) => c.adapter === current.adapter)
    && channels.filter((c) => c.adapter === current.adapter).every((c) => triedKeys.has(channelKey(c)));
  const currentChannel = channels.find((c) => c.adapter === current.adapter && c.model === current.model);
  const excludedProvider = currentAdapterExcluded ? routingModelProvider(current.model, currentChannel?.vendor) : undefined;
  return channels.filter((c) => !excluded(c)
    && (!excludedProvider || routingModelProvider(c.model, c.vendor) !== excludedProvider)
    && tierPredicate(c.tier));
}

function baseRankFailoverCandidates(
  pool: BillingChannel[],
  task: Task,
  cfg: TickmarkrConfig,
  profile?: RoutingProfile,
): BillingChannel[] {
  const scores = new Map(pool.map((c) => [channelKey(c), profile ? learnedScore(profile, task.shape, channelKey(c), c.channel, { availWeight: cfg.routing.learnedTuning?.availWeight }) : 0]));
  const scoreOf = (c: BillingChannel) => scores.get(channelKey(c))!;
  return pool.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || baseMarginalCostRank(a) - baseMarginalCostRank(b) || scoreOf(b) - scoreOf(a));
}

function baseNextChannel(
  current: Assignment,
  task: Task,
  cfg: TickmarkrConfig,
  channels: BillingChannel[],
  tried: string[],
  profile?: RoutingProfile,
  exclude?: ReadonlySet<string>,
): Assignment | null {
  // already cheapest-sufficient: TIER_RANK asc is the PRIMARY key so escalation climbs one band at a time.
  // Do NOT "unify" this onto route()'s key order (marginal-cost first) — that reverses climb-one-band on mixed fleets (ROUTE-02, D2).
  // ROUTE-13: learnedScore is the STRICTLY-LAST key — within-band tiebreak only. Precomputed
  // outside the comparator (Pitfall 1), never arithmetic-combined with the band keys, no
  // profile-dependent filter. NO exploration bonus here (route():110 has one; a probe on the
  // failure path would spend a real retry). Absent profile ⇒ every score is 0 ⇒ third key
  // all-ties ⇒ the stable sort preserves the exact v1.7 candidate ORDER.
  const pool = baseCandidatePool(current, task, cfg, channels, tried, (tier) => TIER_RANK[tier] >= TIER_RANK[current.tier], exclude);
  const candidates = baseRankFailoverCandidates(pool, task, cfg, profile);
  return candidates.length ? baseToAssignment(candidates[0]) : null;
}

type BaseClimbPick = Assignment & {
  climbed: boolean;
  reason?: string;
};

function baseMakeClimbPick(assignment: Assignment, climbed: boolean, reason?: string): BaseClimbPick {
  const pick: BaseClimbPick = {
    adapter: assignment.adapter,
    model: assignment.model,
    channel: assignment.channel,
    tier: assignment.tier,
    climbed,
    ...(climbed ? {} : { reason }),
  };
  Object.defineProperty(pick, "assignment", {
    get() {
      return {
        adapter: this.adapter,
        model: this.model,
        channel: this.channel,
        tier: this.tier,
      };
    },
    enumerable: false,
  });
  return pick;
}

/**
 * v2.5.4 OBS-986 (ES-1): climb one tier on request when untried channels exist in higher tiers.
 * With routing.escalateTier on, returns the cheapest untried live channel strictly above current.tier,
 * ordered as baseNextChannel orders (tier, then marginal cost, learned score strictly last), flagged climbed: true.
 * When the knob is off, when current is frontier, or when no higher tier has an untried channel,
 * returns baseNextChannel's same-or-higher pick flagged climbed: false naming the reason.
 */
function baseClimbChannel(
  current: Assignment,
  task: Task,
  cfg: TickmarkrConfig,
  channels: BillingChannel[],
  tried: string[],
  profile?: RoutingProfile,
  exclude?: ReadonlySet<string>,
): BaseClimbPick | null {
  const escalateOn = cfg.routing.escalateTier !== "off";
  if (!escalateOn) {
    const pick = baseNextChannel(current, task, cfg, channels, tried, profile, exclude);
    return pick ? baseMakeClimbPick(pick, false, "routing.escalateTier knob is off") : null;
  }

  if (current.tier === "frontier") {
    const pick = baseNextChannel(current, task, cfg, channels, tried, profile, exclude);
    return pick ? baseMakeClimbPick(pick, false, "no higher tier") : null;
  }

  const higherPool = baseCandidatePool(current, task, cfg, channels, tried, (tier) => TIER_RANK[tier] > TIER_RANK[current.tier], exclude);
  if (higherPool.length > 0) {
    const candidates = baseRankFailoverCandidates(higherPool, task, cfg, profile);
    return baseMakeClimbPick(baseToAssignment(candidates[0]), true);
  }

  const pick = baseNextChannel(current, task, cfg, channels, tried, profile, exclude);
  return pick ? baseMakeClimbPick(pick, false, "no higher tier has an untried channel") : null;
}

const outcome = (f: () => unknown) => { try { return { ok: f() }; } catch (e) { return { error: (e as Error).message }; } };

const ch = (key: string, channel: "sub" | "api" = "sub", tier: BillingChannel["tier"] = "frontier", score?: number): BillingChannel => {
  const i = key.indexOf(":");
  return { adapter: key.slice(0, i), vendor: key.startsWith("codex") ? "openai" : "anthropic", model: key.slice(i + 1), channel, tier, ...(score === undefined ? {} : { score }) };
};
const BASE = ["claude-code:claude-fable-5-2", "claude-code:claude-opus-5-5", "codex:gpt-6-astra", "codex:gpt-6.1-sol"];
const scores = [64.6, 59.1, 56.9, 54.6];
const LINES: { name: string; channels: BillingChannel[]; deny?: string }[] = [
  { name: "base", channels: BASE.map((k, i) => ch(k, "sub", "frontier", scores[i])) },
  { name: "mixed cost", channels: [...BASE.slice(0, 3).map((k, i) => ch(k, "sub", "frontier", scores[i])), ch("codex:gpt-6-luna", "api", "cheap", 41)] },
  { name: "skipped", channels: BASE.map((k, i) => ch(k, "sub", "frontier", scores[i])), deny: "codex:gpt-6-astra" },
];

const repo = mkdtempSync(join(tmpdir(), "tkr-parity-r-"));
const globalDir = mkdtempSync(join(tmpdir(), "tkr-parity-g-"));
const load = (text: string) => loadConfigWithMode(repo, { globalDir, repoOverlayText: text }).cfg;
const overlay = (mode: string, keys: string[], deny?: string, extra = "") =>
  `routing:\n${extra}${deny ? `  deny:\n    models: [${deny}]\n` : ""}  map:\n${SHAPES.map((s) => `    ${s}:\n      pool:\n        mode: ${mode}\n        channels: [${keys.join(", ")}]\n`).join("")}`;

// A sample task keeps its id and goal at every complexity 1 to 10 (table (vi)).
const sample = (shape: string, complexity: number): Task[] => validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: Array.from({ length: 400 }, (_, k) => ({
    id: `T${k + 1}`, title: "t", goal: `simulated ${shape} task ${k * 7919}`, shape, complexity, acceptance: ["a"],
  })),
}).tasks;

// The config 2.26.1 (3ea2fe662) loads from the overlay below, leaf for leaf, frozen from that commit's own
// loadConfigWithMode: independent of today's DEFAULT_CONFIG, so a changed default reds here.
const LEGACY_LEAVES: Record<string, unknown> = {
  "concurrency": 3,
  "driver": "auto",
  "integrationBranchPrefix": "tickmarkr/",
  "taskTimeoutMinutes": 30,
  "contextWarnTokens": 170000,
  "routing.map.plan.pin.via": "claude-code",
  "routing.map.plan.pin.model": "fable",
  "routing.map.spec.pin.via": "claude-code",
  "routing.map.spec.pin.model": "fable",
  "routing.map.implement.prefer.0": "cursor-agent",
  "routing.map.implement.prefer.1": "codex",
  "routing.map.tests.prefer.0": "opencode",
  "routing.map.docs.pool.mode": "ordered",
  "routing.map.docs.pool.channels.0": "codex:gpt-6-astra",
  "routing.map.docs.pool.channels.1": "claude-code:claude-opus-5-5",
  "routing.floors.plan": "frontier",
  "routing.floors.spec": "frontier",
  "routing.floors.migration": "frontier",
  "routing.floors.implement": "mid",
  "routing.floors.ui": "mid",
  "routing.floors.refactor": "mid",
  "routing.floors.tests": "cheap",
  "routing.floors.docs": "cheap",
  "routing.floors.chore": "cheap",
  "routing.learned": "on",
  "routing.escalateTier": "off",
  "routing.allowUnverifiedModels": false,
  "routing.deny.models.0": "codex:gpt-6.1-sol",
  "tiers.claude-code.vendor": "anthropic",
  "tiers.claude-code.channel": "sub",
  "tiers.claude-code.models.fable": "frontier",
  "tiers.claude-code.models.opus": "frontier",
  "tiers.claude-code.models.sonnet": "mid",
  "tiers.claude-code.models.haiku": "cheap",
  "tiers.claude-code.windows.fable": 1000000,
  "tiers.claude-code.windows.opus": 1000000,
  "tiers.claude-code.windows.sonnet": 1000000,
  "tiers.claude-code.windows.haiku": 200000,
  "tiers.codex.vendor": "openai",
  "tiers.codex.channel": "sub",
  "tiers.codex.models.gpt-6-astra": "frontier",
  "tiers.codex.models.gpt-6-sol": "frontier",
  "tiers.codex.models.gpt-6-luna": "cheap",
  "tiers.codex.models.gpt-5.6-sol": "frontier",
  "tiers.codex.models.gpt-5.6-terra": "mid",
  "tiers.codex.models.gpt-5.6-luna": "cheap",
  "tiers.codex.windows.gpt-6-astra": 272000,
  "tiers.codex.windows.gpt-6-sol": 272000,
  "tiers.codex.windows.gpt-6-luna": 272000,
  "tiers.codex.windows.gpt-5.6-sol": 272000,
  "tiers.codex.windows.gpt-5.6-terra": 272000,
  "tiers.codex.windows.gpt-5.6-luna": 272000,
  "tiers.cursor-agent.vendor": "cursor",
  "tiers.cursor-agent.channel": "sub",
  "tiers.cursor-agent.models.composer-2.5": "mid",
  "tiers.cursor-agent.models.composer-2.5-fast": "cheap",
  "tiers.cursor-agent.models.claude-fable-5-1": "frontier",
  "tiers.cursor-agent.models.gemini-3.8-flash": "mid",
  "tiers.cursor-agent.windows.composer-2.5": 200000,
  "tiers.cursor-agent.windows.composer-2.5-fast": 200000,
  "tiers.cursor-agent.windows.claude-fable-5-1": 1000000,
  "tiers.cursor-agent.windows.gemini-3.8-flash": 1000000,
  "tiers.opencode.vendor": "mixed",
  "tiers.opencode.channel": "sub",
  "tiers.opencode.models.zai-coding-plan/glm-5.2": "mid",
  "tiers.opencode.windows.zai-coding-plan/glm-5.2": 1000000,
  "tiers.pi.vendor": "zhipu",
  "tiers.pi.channel": "sub",
  "tiers.pi.models.zai/glm-5.2": "mid",
  "tiers.pi.models.zai/glm-5.3": "frontier",
  "tiers.pi.models.zai/glm-5.3-flash": "mid",
  "tiers.pi.windows.zai/glm-5.2": 1000000,
  "tiers.pi.windows.zai/glm-5.3": 1000000,
  "tiers.pi.windows.zai/glm-5.3-flash": 200000,
  "tiers.omp.vendor": "mixed",
  "tiers.omp.channel": "sub",
  "tiers.omp.models.google/gemini-3.8-flash": "mid",
  "tiers.omp.models.zai/glm-5.3": "frontier",
  "tiers.omp.models.alibaba/qwen3.8-max": "frontier",
  "tiers.omp.modelOverrides.google/gemini-3.8-flash.vendor": "google",
  "tiers.omp.modelOverrides.zai/glm-5.3.vendor": "zhipu",
  "tiers.omp.modelOverrides.alibaba/qwen3.8-max.vendor": "alibaba",
  "tiers.omp.windows.google/gemini-3.8-flash": 1000000,
  "tiers.omp.windows.zai/glm-5.3": 1000000,
  "tiers.omp.windows.alibaba/qwen3.8-max": 1000000,
  "tiers.qwen.vendor": "alibaba",
  "tiers.qwen.channel": "sub",
  "tiers.qwen.models.qwen3.8-max": "frontier",
  "tiers.qwen.windows.qwen3.8-max": 1000000,
  "tiers.prime-agent.vendor": "mixed",
  "tiers.prime-agent.channel": "sub",
  "tiers.prime-agent.models.prime-inference/z-ai/glm-5.2": "mid",
  "tiers.prime-agent.modelOverrides.prime-inference/z-ai/glm-5.2.vendor": "zhipu",
  "tiers.prime-agent.windows.prime-inference/z-ai/glm-5.2": 1000000,
  "tiers.grok.vendor": "xai",
  "tiers.grok.channel": "sub",
  "tiers.grok.models.grok-4.5": "mid",
  "tiers.grok.models.grok-composer-2.5-fast": "cheap",
  "tiers.grok.windows.grok-4.5": 500000,
  "tiers.grok.windows.grok-composer-2.5-fast": 200000,
  "tiers.kimi.vendor": "moonshot",
  "tiers.kimi.channel": "sub",
  "tiers.kimi.models.kimi-code/k3": "frontier",
  "tiers.kimi.models.kimi-code/kimi-for-coding": "mid",
  "tiers.kimi.models.kimi-code/kimi-for-coding-highspeed": "cheap",
  "tiers.kimi.windows.kimi-code/k3": 1048576,
  "tiers.kimi.windows.kimi-code/kimi-for-coding": 262144,
  "tiers.kimi.windows.kimi-code/kimi-for-coding-highspeed": 262144,
  "pricing.cheap": 0.1,
  "pricing.mid": 0.5,
  "pricing.frontier": 2.5,
  "gates.diffCap": 60000,
  "gates.evidenceQuotaBytes": 8388608,
  "judge.adapter": "claude-code",
  "judge.model": "fable",
  "review.complexityThreshold": 7,
  "review.timeoutMs": 900000,
  "review.required": true,
  "review.criticalPaths.0": "src/gates/**",
  "review.criticalPaths.1": "src/run/**",
  "review.criticalPaths.2": "src/drivers/**",
  "review.criticalPaths.3": "src/adapters/**",
  "review.floor": "worker",
  "consult.adapter": "claude-code",
  "consult.model": "fable",
  "consult.stallMinutes": 15,
  "visibility.llm": "headless",
  "visibility.keepPanes": "run",
  "visibility.worker": "interactive",
  "visibility.workersPerTab": 3,
};

type Leaf = [string, unknown];
const leaves = (v: unknown, at = ""): Leaf[] =>
  v !== null && typeof v === "object"
    ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leaves(x, at ? `${at}.${k}` : k))
    : [[at, v]];

describe("rows 501, 502: any and ordered are unchanged", () => {
  test("any and ordered give every sample task the complete route result the 2.26.1 rule gives; a 2.26.1 config loads leaf for leaf", () => {
    const crossings = [2, 8, 10].flatMap((h) => [0, 5, 100].map((w) => `  hardFrom: ${h}\n  similarWithin: ${w}\n`));
    const samples = new Map(SHAPES.flatMap((shape) => Array.from({ length: 10 }, (_, i) => [`${shape} ${i + 1}`, sample(shape, i + 1)] as const)));
    // Complete results compared as their JSON, one string per task: the first that differs fails, by name.
    const same = (got: (f: Task) => unknown, want: string[], tasks: Task[], at: string) => {
      const i = tasks.findIndex((t, n) => JSON.stringify(outcome(() => got(t))) !== want[n]);
      if (i >= 0) expect(outcome(() => got(tasks[i])), `${at} ${tasks[i].id}`).toEqual(JSON.parse(want[i]));
    };
    const json = (tasks: Task[], f: (t: Task) => unknown) => tasks.map((t) => JSON.stringify(outcome(() => f(t))));
    let compared = 0;
    for (const mode of ["any", "ordered"]) {
      for (const line of LINES) {
        const keys = line.channels.map(channelKey);
        const plain = load(overlay(mode, keys, line.deny));
        const cfgs = crossings.map((extra) => load(overlay(mode, keys, line.deny, extra)));
        const c0 = line.channels[0];
        const cur = { adapter: c0.adapter, model: c0.model, channel: c0.channel, tier: c0.tier };
        const low = { ...cur, tier: "mid" as const };
        for (const exclude of [undefined, new Set([keys[1]])]) {
          for (const shape of SHAPES) {
            for (let c = 1; c <= 10; c++) {
              const tasks = samples.get(`${shape} ${c}`)!;
              const want = json(tasks, (t) => baseRoute(t, plain, line.channels, exclude));
              const nextWant = json(tasks, (t) => baseNextChannel(cur, t, plain, line.channels, [keys[0]], undefined, exclude));
              const climbWant = json(tasks, (t) => baseClimbChannel(low, t, plain, line.channels, [], undefined, exclude));
              const at = `${mode} ${line.name} ${shape} c${c} ${exclude ? "excluded" : ""}`;
              for (const cfg of cfgs) {
                same((t) => route(t, cfg, line.channels, undefined, undefined, exclude), want, tasks, at);
                same((t) => route(t, cfg, line.channels, undefined, undefined, exclude, undefined, tasks), want, tasks, `${at} graph`);
                same((t) => nextChannel(cur, t, cfg, line.channels, [keys[0]], undefined, exclude), nextWant, tasks, `${at} nextChannel`);
                same((t) => climbChannel(low, t, cfg, line.channels, [], undefined, exclude), climbWant, tasks, `${at} climbChannel`);
                compared += 2 * tasks.length;
              }
            }
          }
        }
      }
    }
    expect(compared).toBe(2 * 3 * 2 * SHAPES.length * 10 * 400 * 9 * 2);

    // A config as 2.26.1 loads it: today's loader over the same overlay, leaf for leaf against 2.26.1's own result.
    const now = load("routing:\n  escalateTier: off\n  deny:\n    models: [codex:gpt-6.1-sol]\n  map:\n    docs:\n      pool:\n        mode: ordered\n        channels: [codex:gpt-6-astra, claude-code:claude-opus-5-5]\n");
    const is = new Map(leaves(now));
    for (const [k, v] of Object.entries(LEGACY_LEAVES)) expect(is.get(k), k).toEqual(v);
    expect([...is.keys()].filter((k) => !(k in LEGACY_LEAVES)).sort()).toEqual(["routing.hardFrom", "routing.similarWithin"]);
    expect([is.get("routing.hardFrom"), is.get("routing.similarWithin")]).toEqual([8, 5]);
  }, 900_000);
});
