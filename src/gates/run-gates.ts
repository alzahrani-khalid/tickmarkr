import { type Assignment, type BillingChannel, channelKey, type WorkerAdapter, type WorkerResult } from "../adapters/types.js";
import { type TickmarkrConfig, TIER_RANK } from "../config/config.js";
import { getAdapter } from "../adapters/registry.js";
import { GATE_NAMES, type GateName, type Task } from "../graph/schema.js";
import { acceptanceGate } from "./acceptance.js";
import { type Baseline, compareToBaseline } from "./baseline.js";
import { evidenceGate } from "./evidence.js";
import type { GateVia } from "./llm.js";
import { marginalCostRank } from "../route/router.js";
import { reviewGate } from "./review.js";
import { scopeGate } from "./scope.js";
import type { GateResult } from "./types.js";

export type GateEvent =
  | { phase: "start"; gate: GateName; index: number; total: number }
  | { phase: "end"; gate: GateName; result: GateResult };

export interface GateContext {
  worktree: string;
  baseRef: string;
  result: WorkerResult;
  author: Assignment;
  commands: Record<string, string>;
  baseline: Baseline;
  channels: BillingChannel[];
  adapters: WorkerAdapter[];
  cfg: TickmarkrConfig;
  via?: GateVia; // v1.1: present → judge/review run as visible named agents through the driver
  excludeReviewers?: string[]; // v1.1: reviewer channels that produced garbage for this task (failover)
  onGate?: (e: GateEvent) => void | Promise<void>;
}

export async function runGates(
  task: Task,
  ctx: GateContext,
): Promise<{ results: GateResult[]; commits: string[] }> {
  const results: GateResult[] = [];
  let commits: string[] = [];
  const shapeGates = ctx.cfg.gates.byShape?.[task.shape];
  const enabled = (g: GateName) =>
    task.gates.includes(g) && (g !== "acceptance" && g !== "review" || shapeGates?.[g] !== false);
  const failed = () => results.some((r) => !r.pass);
  const sequence = GATE_NAMES.filter((g) => enabled(g));
  const total = sequence.length;
  const indexOf = (gate: GateName) => sequence.indexOf(gate) + 1;

  const record = async (result: GateResult) => {
    results.push(result);
    await ctx.onGate?.({ phase: "end", gate: result.gate as GateName, result });
  };

  const emitStart = async (gate: GateName) => {
    await ctx.onGate?.({ phase: "start", gate, index: indexOf(gate), total });
  };

  // 1. build/test/lint vs shared baseline — deterministic and cheap, first
  const toolGates = (["build", "test", "lint"] as const).filter(enabled);
  if (toolGates.length) {
    // ponytail: compareToBaseline batches build/test/lint — their starts are emitted at iteration,
    // not at true execution start. They are collectively sub-second (measured), so the debounce
    // suppresses them anyway; split compareToBaseline only if a tool gate ever gets slow.
    const toolResults = await compareToBaseline(ctx.worktree, ctx.commands, ctx.baseline, toolGates);
    for (const r of toolResults) {
      await emitStart(r.gate as GateName);
      await record(r);
    }
    if (failed()) return { results, commits };
  }

  // 2. evidence — did the worker actually commit anything?
  if (enabled("evidence")) {
    await emitStart("evidence");
    const e = await evidenceGate(ctx.worktree, ctx.baseRef);
    commits = e.commits;
    await record({ gate: e.gate, pass: e.pass, details: e.details });
    if (!e.pass) return { results, commits };
  }

  // 3. scope
  if (enabled("scope")) {
    await emitStart("scope");
    await record(await scopeGate(ctx.worktree, ctx.baseRef, task.files, ctx.result, ctx.cfg.scope?.allowDeviations ?? []));
    if (failed()) return { results, commits };
  }

  // 4. acceptance judge (first LLM spend — everything cheaper already passed)
  if (enabled("acceptance")) {
    await emitStart("acceptance");
    const judgeAdapter = getAdapter(ctx.cfg.judge.adapter, ctx.adapters);
    const jvia = ctx.via
      ? { driver: ctx.via.driver, keep: ctx.via.keep, onSlot: ctx.via.onSlot, name: ctx.via.nameFor("judge", judgeAdapter.id), label: ctx.via.labelFor("judge") }
      : undefined;
    // v1.19 (T2): testCmd threads the detected test runner to the gate so named-test oracles run
    // deterministically (filtered via -t) before any LLM judge dispatch.
    let a = await acceptanceGate(task, ctx.worktree, ctx.baseRef, { adapter: judgeAdapter, model: ctx.cfg.judge.model }, jvia, { testCmd: ctx.commands.test, diffCap: ctx.cfg.gates.diffCap });
    // GATE-09: an unparseable judge verdict retries the JUDGE exactly once on a failover channel — never
    // the worker (run-20260711-185020 P43-03 L70-72 billed a judge flake as a worker attempt). The flaked
    // first verdict NEVER enters results (no false gate-result journal event, no operator notify, no stale
    // failed() short-circuit — research Pitfall 5). Detection is meta-only (D-03), never string-matching
    // details. The v1.1 badReviewers precedent's TIMING can't transfer: its failover lands on the NEXT
    // worker attempt — exactly what this fix forbids; only its meta-carries-channel pattern is mirrored.
    // Straight-line single `if` — NO loop/counter/knob: exactly-once by construction (a knob is a
    // fail-closed weakening vector); a second garbage verdict fails the gate closed exactly as today.
    if (a.meta?.unparseable === true && typeof a.meta.judge === "string") {
      const flakedKey = a.meta.judge;
      const candidate = ctx.channels
        .filter((c) => channelKey(c) !== flakedKey)
        // pickReviewer's sort (review.ts:37): TIER_RANK desc, marginalCostRank asc — proven ordering; both
        // symbols already imported by a sibling gate file. No vendor-diversity axis (the judge isn't review).
        .sort((x, y) => TIER_RANK[y.tier] - TIER_RANK[x.tier] || marginalCostRank(x) - marginalCostRank(y))[0];
      // ponytail: same-channel fallback when the fleet has no alternative (D-03). One judge call against a
      // deterministic garbage source is wasted, bounded; fail-closed unchanged on a second garbage verdict.
      const retry = candidate ?? { adapter: ctx.cfg.judge.adapter, model: ctx.cfg.judge.model };
      const retryAdapter = getAdapter(retry.adapter, ctx.adapters);
      const retryJvia = ctx.via
        // unconditional -r1 suffix: under keepPanes:forever a same-channel retry cannot collide with the
        // still-open first pane (herdr agent_name_taken regression, research Pitfall 4)
        ? { driver: ctx.via.driver, keep: ctx.via.keep, onSlot: ctx.via.onSlot, name: ctx.via.nameFor("judge", retryAdapter.id) + "-r1", label: ctx.via.labelFor("judge") }
        : undefined;
      // the retry IS a second acceptanceGate call: one code path, one parser, zero new parse leniency.
      a = await acceptanceGate(task, ctx.worktree, ctx.baseRef, { adapter: retryAdapter, model: retry.model }, retryJvia, { testCmd: ctx.commands.test, diffCap: ctx.cfg.gates.diffCap });
      a = { ...a, meta: { ...a.meta, judgeRetry: { flaked: flakedKey, retried: channelKey({ adapter: retry.adapter, model: retry.model }) } } };
    }
    await record(a);
    if (failed()) return { results, commits };
  }

  // 5. cross-vendor review
  if (enabled("review")) {
    await emitStart("review");
    await record(
      await reviewGate(task, ctx.worktree, ctx.baseRef, ctx.author, ctx.channels, ctx.adapters, ctx.cfg, ctx.via, ctx.excludeReviewers),
    );
  }
  return { results, commits };
}
