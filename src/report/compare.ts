// v1.70 T3: pure run-to-run comparison for `tickmarkr report --compare <baselineRunId>`.
// Cost / gate / duration deltas only — no I/O, no network. Comparability reuses the
// engagementComparable shape (comparable | mismatch+recorded | unbound) over the
// run-start environment identity stamped by v1.70 T2, so two runs are never presented
// as apples-to-apples when their recorded environments disagree.
import type { RunEnvironment } from "../run/environment.js";
import type { JournalEvent, TelemetryRow } from "../run/journal.js";
import { estimateCosts, type CostConfig } from "./cost.js";

// Shape twin of EngagementCompare in journal.ts — one notion of "comparable", not a second.
export type EnvironmentCompare =
  | { comparable: true; recorded: string }
  | { comparable: false; reason: "mismatch"; recorded: string }
  | { comparable: false; reason: "unbound" };

export function hasRunStart(events: JournalEvent[]): boolean {
  return events.some((e) => e.event === "run-start");
}

// First run-start's environment, fail-closed on a missing or malformed stamp.
export function recordedEnvironment(events: JournalEvent[]): RunEnvironment | undefined {
  for (const e of events) {
    if (e.event !== "run-start") continue;
    const env = e.data.environment;
    if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
    const o = env as Record<string, unknown>;
    if (typeof o.tickmarkrVersion !== "string" || typeof o.configHash !== "string") return undefined;
    if (!o.adapterVersions || typeof o.adapterVersions !== "object" || Array.isArray(o.adapterVersions)) return undefined;
    const adapterVersions: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.adapterVersions as Record<string, unknown>)) {
      if (typeof v !== "string") return undefined;
      adapterVersions[k] = v;
    }
    return { tickmarkrVersion: o.tickmarkrVersion, configHash: o.configHash, adapterVersions };
  }
  return undefined;
}

// Canonical identity string for the `recorded` field — configHash is the axis the acceptance
// criteria name; full environment equality still decides .comparable.
function envFingerprint(env: RunEnvironment): string {
  return env.configHash;
}

function envEqual(a: RunEnvironment, b: RunEnvironment): boolean {
  if (a.tickmarkrVersion !== b.tickmarkrVersion || a.configHash !== b.configHash) return false;
  const ak = Object.keys(a.adapterVersions).sort();
  const bk = Object.keys(b.adapterVersions).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (a.adapterVersions[ak[i]] !== b.adapterVersions[bk[i]]) return false;
  }
  return true;
}

// THE environment-identity comparator (criterion: reuses engagementComparable's shape).
// unbound = either side lacks a usable stamp; mismatch = stamps disagree; comparable = equal.
export function environmentComparable(
  baselineEnv: RunEnvironment | undefined,
  currentEnv: RunEnvironment | undefined,
): EnvironmentCompare {
  if (baselineEnv === undefined || currentEnv === undefined) return { comparable: false, reason: "unbound" };
  const recorded = envFingerprint(baselineEnv);
  return envEqual(baselineEnv, currentEnv)
    ? { comparable: true, recorded }
    : { comparable: false, reason: "mismatch", recorded };
}

export interface RunMetrics {
  durationMs: number | undefined;
  gatePass: number;
  gateFail: number;
  gateTotal: number;
  costUsd: number | undefined;
  tokensTotal: number | undefined;
}

export function runMetrics(events: JournalEvent[], rows: TelemetryRow[] = [], cost: CostConfig = {}): RunMetrics {
  const start = events.find((e) => e.event === "run-start");
  const end = [...events].reverse().find((e) => e.event === "run-end");
  let durationMs: number | undefined;
  if (start && end) {
    const from = Date.parse(start.ts);
    const to = Date.parse(end.ts);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from) durationMs = to - from;
  }
  const gates = events.filter((e) => e.event === "gate-result");
  const gatePass = gates.filter((e) => e.data.pass === true).length;
  const gateFail = gates.filter((e) => e.data.pass === false).length;

  let costUsd: number | undefined;
  let costSum = 0;
  let hasCost = false;
  for (const p of estimateCosts(rows, cost)) {
    if (p.apiUsd !== undefined) {
      costSum += p.apiUsd;
      hasCost = true;
    } else if (p.amortizedUsd) {
      costSum += (p.amortizedUsd[0] + p.amortizedUsd[1]) / 2;
      hasCost = true;
    }
  }
  if (hasCost) costUsd = Math.round(costSum * 1e6) / 1e6;

  let tokensTotal: number | undefined;
  let tokenSum = 0;
  let hasTokens = false;
  for (const r of rows) {
    if (!r.tokens) continue;
    hasTokens = true;
    const t = r.tokens;
    tokenSum += t.input + t.output + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) + (t.reasoning ?? 0);
  }
  if (hasTokens) tokensTotal = tokenSum;

  return { durationMs, gatePass, gateFail, gateTotal: gates.length, costUsd, tokensTotal };
}

export interface RunDelta {
  durationMs: number | undefined;
  gateFail: number;
  costUsd: number | undefined;
  tokensTotal: number | undefined;
}

export type CompareOutcome =
  | { ok: false; reason: string }
  | {
      ok: true;
      runId: string;
      baselineRunId: string;
      comparability: EnvironmentCompare;
      current: RunMetrics;
      baseline: RunMetrics;
      delta: RunDelta;
      text: string;
    };

const n = (x: number) => x.toLocaleString("en-US");
const EM = "—";

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return EM;
  const seconds = Math.round(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function fmtSignedDuration(ms: number | undefined): string {
  if (ms === undefined) return EM;
  if (ms === 0) return "0s";
  const sign = ms > 0 ? "+" : "-";
  return `${sign}${fmtDuration(Math.abs(ms))}`;
}

function fmtUsd(v: number | undefined): string {
  if (v === undefined) return EM;
  return `$${v.toFixed(6)}`;
}

function fmtSignedUsd(v: number | undefined): string {
  if (v === undefined) return EM;
  if (v === 0) return "$0.000000";
  const sign = v > 0 ? "+" : "-";
  return `${sign}$${Math.abs(v).toFixed(6)}`;
}

function fmtInt(v: number | undefined): string {
  if (v === undefined) return EM;
  return n(v);
}

function fmtSignedInt(v: number | undefined): string {
  if (v === undefined) return EM;
  if (v === 0) return "0";
  return v > 0 ? `+${n(v)}` : `-${n(Math.abs(v))}`;
}

function comparabilityLine(
  cmp: EnvironmentCompare,
  baselineEnv: RunEnvironment | undefined,
  currentEnv: RunEnvironment | undefined,
): string {
  if (cmp.comparable) {
    return `full comparability (environment identity matches; configHash=${cmp.recorded})`;
  }
  if (cmp.reason === "unbound") {
    return "comparability caveat — one or both runs lack a recorded environment identity; not apples-to-apples";
  }
  const base = baselineEnv?.configHash ?? EM;
  const cur = currentEnv?.configHash ?? EM;
  return `comparability caveat — environment identity disagrees (baseline configHash=${base} ≠ current configHash=${cur}; recorded baseline ${cmp.recorded}); not apples-to-apples`;
}

export function renderComparison(opts: {
  runId: string;
  baselineRunId: string;
  comparability: EnvironmentCompare;
  baselineEnv: RunEnvironment | undefined;
  currentEnv: RunEnvironment | undefined;
  current: RunMetrics;
  baseline: RunMetrics;
  delta: RunDelta;
}): string {
  const { runId, baselineRunId, comparability, baselineEnv, currentEnv, current, baseline, delta } = opts;
  // Both run ids are always named so the reader knows which is the baseline.
  const lines = [
    `## Comparison`,
    "",
    `- **run:** ${runId}`,
    `- **baseline:** ${baselineRunId}`,
    `- **comparability:** ${comparabilityLine(comparability, baselineEnv, currentEnv)}`,
    "",
    "### Delta (current − baseline)",
    "",
    `| metric | baseline (${baselineRunId}) | current (${runId}) | delta |`,
    `| --- | --- | --- | --- |`,
    `| duration | ${fmtDuration(baseline.durationMs)} | ${fmtDuration(current.durationMs)} | ${fmtSignedDuration(delta.durationMs)} |`,
    `| gate failures | ${fmtInt(baseline.gateFail)} | ${fmtInt(current.gateFail)} | ${fmtSignedInt(delta.gateFail)} |`,
    `| gate pass rate | ${baseline.gateTotal ? `${baseline.gatePass}/${baseline.gateTotal}` : EM} | ${current.gateTotal ? `${current.gatePass}/${current.gateTotal}` : EM} | ${EM} |`,
    `| cost | ${fmtUsd(baseline.costUsd)} | ${fmtUsd(current.costUsd)} | ${fmtSignedUsd(delta.costUsd)} |`,
    `| tokens | ${fmtInt(baseline.tokensTotal)} | ${fmtInt(current.tokensTotal)} | ${fmtSignedInt(delta.tokensTotal)} |`,
    "",
  ];
  if (!comparability.comparable) {
    lines.push(
      "_Caveat: deltas are shown for inspection only — environment identity disagrees, so this is not an apples-to-apples table._",
      "",
    );
  }
  return lines.join("\n").trimEnd() + "\n";
}

// Fail closed when either journal has no run-start (no partial / fabricated comparison).
// Mismatch of environment identity still yields a rendered delta, with an explicit caveat.
export function compareRuns(opts: {
  runId: string;
  baselineRunId: string;
  events: JournalEvent[];
  baselineEvents: JournalEvent[];
  rows?: TelemetryRow[];
  baselineRows?: TelemetryRow[];
  cost?: CostConfig;
}): CompareOutcome {
  if (!hasRunStart(opts.baselineEvents)) {
    return {
      ok: false,
      reason: `baseline run ${opts.baselineRunId} has no recorded run-start event — cannot compare`,
    };
  }
  if (!hasRunStart(opts.events)) {
    return {
      ok: false,
      reason: `run ${opts.runId} has no recorded run-start event — cannot compare`,
    };
  }

  const baselineEnv = recordedEnvironment(opts.baselineEvents);
  const currentEnv = recordedEnvironment(opts.events);
  const comparability = environmentComparable(baselineEnv, currentEnv);

  const baseline = runMetrics(opts.baselineEvents, opts.baselineRows ?? [], opts.cost ?? {});
  const current = runMetrics(opts.events, opts.rows ?? [], opts.cost ?? {});

  const delta: RunDelta = {
    durationMs:
      current.durationMs !== undefined && baseline.durationMs !== undefined
        ? current.durationMs - baseline.durationMs
        : undefined,
    gateFail: current.gateFail - baseline.gateFail,
    costUsd:
      current.costUsd !== undefined && baseline.costUsd !== undefined
        ? Math.round((current.costUsd - baseline.costUsd) * 1e6) / 1e6
        : undefined,
    tokensTotal:
      current.tokensTotal !== undefined && baseline.tokensTotal !== undefined
        ? current.tokensTotal - baseline.tokensTotal
        : undefined,
  };

  const text = renderComparison({
    runId: opts.runId,
    baselineRunId: opts.baselineRunId,
    comparability,
    baselineEnv,
    currentEnv,
    current,
    baseline,
    delta,
  });

  return {
    ok: true,
    runId: opts.runId,
    baselineRunId: opts.baselineRunId,
    comparability,
    current,
    baseline,
    delta,
    text,
  };
}
