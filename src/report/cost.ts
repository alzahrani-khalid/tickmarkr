// v1.20 REC-02: pure cost estimation. Turns telemetry usage rows + an operator-maintained price table
// into per-channel cost estimates with full basis (tokens counted, rate used, rate date) — justification
// is data, not prose. ABSENT pricing degrades to "not measurable", never a crash or a fake $0. No network
// anywhere in the path; the price table is operator config copied from LiteLLM's price JSON (spec cost model).
import { addUsage, type TokenUsage } from "../adapters/types.js";
import type { ModelPricing, SubPricing } from "../config/config.js";
import type { TelemetryRow } from "../run/journal.js";

// The price-table slice of TickmarkrConfig (cfg.cost). Both maps optional; the whole field optional.
// Accepted loose so estimateCosts stays a pure function of minimal inputs, independent of full config load.
export interface CostConfig {
  models?: Record<string, ModelPricing>; // keyed by model id (LiteLLM convention)
  subs?: Record<string, SubPricing>; // keyed by adapter id (plans are per-account)
}

export interface ChannelCost {
  adapter: string;
  model: string;
  channel: string; // the telemetry row's channel value ("sub" | "api" | raw)
  attempts: number; // dispatch-window count attributable to this group
  tasks: number; // rows (tasks) in the group
  tokens?: TokenUsage; // folded across metered rows; absent ⇒ unmetered (never coalesced to 0)
  partialMetering: boolean; // some rows lacked tokens ⇒ tokens is a floor, not a total
  apiUsd?: number; // API channel dollar estimate
  amortizedUsd?: [number, number]; // sub channel amortized range [low, high]
  counterfactualUsd?: number; // sub channel: what the metered tokens would cost on the model's API rate
  rate?: ModelPricing; // basis for apiUsd / counterfactualUsd (carries rateDate)
  subPlan?: SubPricing; // basis for amortizedUsd
  measurable: boolean; // any dollar figure formed; false ⇒ not measurable, reason explains why
  reason?: string; // present iff measurable === false — names the missing datum, never prose
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6; // kill float dust without faking cents precision

// tokens × per-Mtok rate. Only dimensions with a configured rate are priced; cacheWrite/reasoning carry no
// rate field (REC-02) so they stay counted-in-basis but unpriced — honest, not silently inflated.
function apiCost(t: TokenUsage, r: ModelPricing): number {
  const perMtok = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  let usd = perMtok(t.input, r.inPerMtok) + perMtok(t.output, r.outPerMtok);
  if (t.cacheRead !== undefined && r.cacheReadPerMtok !== undefined) usd += perMtok(t.cacheRead, r.cacheReadPerMtok);
  return round6(usd);
}

function estimateGroup(gr: TelemetryRow[], cost: CostConfig): ChannelCost {
  const { adapter, model, channel } = gr[0];
  const attempts = gr.reduce((s, r) => s + (r.attempts ?? 0), 0);
  // fold only rows that metered tokens; absent stays absent (the one sanctioned addUsage coalesce)
  let tokens: TokenUsage | undefined;
  let metered = 0;
  for (const r of gr) if (r.tokens) { metered++; tokens = addUsage(tokens, r.tokens); }
  const partialMetering = metered > 0 && metered < gr.length;
  const rate = cost.models?.[model];
  const subPlan = cost.subs?.[adapter];

  const c: ChannelCost = {
    adapter,
    model,
    channel,
    attempts,
    tasks: gr.length,
    partialMetering,
    measurable: false,
    ...(tokens ? { tokens } : {}),
  };

  if (channel === "api") {
    if (tokens && rate) {
      c.apiUsd = apiCost(tokens, rate);
      c.rate = rate;
    } else {
      // fail closed: known rate but no tokens ⇒ unmetered; tokens but no rate ⇒ price unknown
      c.reason = !tokens ? "unmetered — no token usage recorded" : `no API rate configured for model "${model}"`;
    }
  } else {
    // sub channel: amortized range from the plan (a RANGE — time-varying quotas); counterfactual from
    // metered tokens × the model's API rate. Each is independent; either may be absent.
    if (subPlan) {
      // more windows ⇒ cheaper per window ⇒ low uses High and high uses Low
      const perWindowLow = subPlan.planMonthly / subPlan.windowsPerMonthHigh;
      const perWindowHigh = subPlan.planMonthly / subPlan.windowsPerMonthLow;
      c.amortizedUsd = [round6(attempts * perWindowLow), round6(attempts * perWindowHigh)];
      c.subPlan = subPlan;
    }
    if (tokens && rate) {
      c.counterfactualUsd = apiCost(tokens, rate);
      c.rate = rate;
    }
    if (c.amortizedUsd === undefined && c.counterfactualUsd === undefined) {
      // here subPlan is necessarily undefined (else amortized would be set); counterfactual needs tokens+rate
      c.reason = tokens
        ? `no sub plan for adapter "${adapter}" and no API rate for model "${model}"`
        : `no sub plan for adapter "${adapter}" and unmetered`;
    }
  }

  c.measurable = c.apiUsd !== undefined || c.amortizedUsd !== undefined || c.counterfactualUsd !== undefined;
  return c;
}

// Pure: (telemetry rows, price table) → per-channel estimates. Groups by adapter:model (matches the
// report's existing grouping). Deterministic order: sorted by adapter:model. No I/O, no network.
export function estimateCosts(rows: TelemetryRow[], cost: CostConfig = {}): ChannelCost[] {
  const groups = new Map<string, TelemetryRow[]>();
  for (const r of rows) {
    const key = `${r.adapter}:${r.model}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, gr]) => estimateGroup(gr, cost));
}
