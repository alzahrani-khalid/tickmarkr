// C5: the shared operator-record `report`, `stats` and Evidence's Channels tab all read from —
// one place naming what a channel-role count and a token/money label mean, so the three surfaces
// cannot silently drift into disagreeing labels for the same journal evidence.
import type { TokenUsage } from "../adapters/types.js";
import type { JournalEvent } from "../run/journal.js";
import type { ChannelCost } from "./cost.js";

const n = (x: number) => x.toLocaleString("en-US");

export function formatTokenUsage(u: TokenUsage): string {
  const parts = [`in ${n(u.input)}`, `out ${n(u.output)}`];
  if (u.cacheRead !== undefined && u.cacheWrite !== undefined) parts.push(`cache r/w ${n(u.cacheRead)}/${n(u.cacheWrite)}`);
  if (u.reasoning !== undefined) parts.push(`reasoning ${n(u.reasoning)}`);
  return parts.join("  ");
}

export function totalTokens(u: TokenUsage): number {
  return [u.input, u.output, u.cacheRead, u.cacheWrite, u.reasoning].filter((x): x is number => x !== undefined).reduce((a, b) => a + b, 0);
}

/** The channel a journal event's `assignment` names, or absent — never coalesced to a placeholder
 * string here, so a caller decides its own absent-channel reading. */
export function assignmentChannel(data: Record<string, unknown>): string | undefined {
  const assignment = data.assignment;
  if (!assignment || typeof assignment !== "object") return undefined;
  const { adapter, model } = assignment as { adapter?: unknown; model?: unknown };
  return typeof adapter === "string" && typeof model === "string" ? `${adapter}:${model}` : undefined;
}

/** Worker token coverage: "unmetered" when the adapter reported no usage at all — distinct from a
 * channel with no telemetry row whatsoever, which `labelChannelUsage` below calls "unknown". */
export function formatChannelTokens(row: ChannelCost): string {
  return row.tokens
    ? `${row.partialMetering ? "≥ " : ""}${formatTokenUsage(row.tokens)} (${n(totalTokens(row.tokens))} tokens)`
    : "unmetered";
}

export function formatRateBasis(row: ChannelCost): string | undefined {
  if (!row.rate) return undefined;
  const cache = row.rate.cacheReadPerMtok === undefined ? "" : `; cache-read $${row.rate.cacheReadPerMtok}/Mtok`;
  const date = row.rate.rateDate === undefined ? "" : `; rate date ${row.rate.rateDate}`;
  return `in/out $${row.rate.inPerMtok}/$${row.rate.outPerMtok}/Mtok${cache}${date}`;
}

/** Nonmeasurable money always says so explicitly (`row.reason`, or "not recorded") — never a $0. */
export function formatChannelMoney(row: ChannelCost): { readonly prices: string[]; readonly bases: string[] } {
  const prices: string[] = [];
  const bases: string[] = [];
  if (row.apiUsd !== undefined) prices.push(`price: $${row.apiUsd.toFixed(6)}`);
  if (row.amortizedUsd !== undefined && row.subPlan !== undefined) {
    const [low, high] = row.amortizedUsd;
    prices.push(`price: $${low.toFixed(6)}–$${high.toFixed(6)} amortized`);
    bases.push(`${n(row.attempts)} windows × $${row.subPlan.planMonthly}/month ÷ ${row.subPlan.windowsPerMonthHigh}–${row.subPlan.windowsPerMonthLow} windows/month`);
  }
  if (row.counterfactualUsd !== undefined) prices.push(`API-equivalent: $${row.counterfactualUsd.toFixed(6)}`);
  const basis = formatRateBasis(row);
  if (basis) bases.push(basis);
  if (!prices.length) prices.push("price: not measurable");
  if (!bases.length) bases.push(row.reason || "not recorded");
  return { prices, bases };
}

export interface ChannelUsageLabel {
  readonly channel: string;
  /** "unmetered" (metered run, adapter reported nothing), a real total, or "unknown" (no telemetry
   *  row exists for this channel at all — missing metadata, never invented). */
  readonly tokens: string;
  /** "not measurable" (metered but unpriced/partial), a real dollar figure, or "unknown" (no row). */
  readonly money: string;
}

/** Labels one channel's metered/priced facts. `row` absent means journal evidence names this
 *  channel (e.g. a pre-telemetry run) but no telemetry row was ever recorded for it — missing
 *  metadata, distinct from a recorded-but-unpriced/unmetered row. */
export function labelChannelUsage(channel: string, row: ChannelCost | undefined): ChannelUsageLabel {
  if (!row) return { channel, tokens: "unknown", money: "unknown" };
  const { prices } = formatChannelMoney(row);
  return { channel, tokens: formatChannelTokens(row), money: prices.join("; ") };
}

export interface ChannelRoleCounts {
  readonly channel: string;
  /** Dispatches recorded for this channel as the task's worker. */
  readonly worker: number;
  /** Review gate-results whose reviewer identity resolved to this channel. */
  readonly review: number;
  /** Consult verdicts recorded against the task this channel was last dispatched on. */
  readonly consult: number;
}

const REVIEWER_PATTERN = /reviewer\s+([^\s;()]+:[^\s;()]+)/i;

function reviewerChannel(data: Record<string, unknown>): string | undefined {
  if (typeof data.reviewer === "string" && data.reviewer.includes(":")) return data.reviewer;
  const meta = typeof data.meta === "object" && data.meta !== null ? data.meta : undefined;
  if (meta && "reviewer" in meta && typeof meta.reviewer === "string" && meta.reviewer.includes(":")) return meta.reviewer;
  return typeof data.details === "string" ? REVIEWER_PATTERN.exec(data.details)?.[1] : undefined;
}

/** The channel a `consult-verdict` event names as ITS OWN consultant identity (daemon.ts always
 *  appends `adapter`/`model` on every verdict) — never the task's worker dispatch, which is a
 *  different channel a consult can (and typically does) disagree with. */
function consultChannel(data: Record<string, unknown>): string | undefined {
  const { adapter, model } = data;
  return typeof adapter === "string" && typeof model === "string" ? `${adapter}:${model}` : undefined;
}

/** Recorded worker/review/consult appearances per channel, read only from journal evidence — no
 *  extrapolation to an all-role invoice. A channel that only ever reviewed still gets a row with
 *  worker:0, never a fabricated dispatch. */
export function channelRoleCounts(events: readonly JournalEvent[]): ChannelRoleCounts[] {
  const counts = new Map<string, { worker: number; review: number; consult: number }>();
  const ensure = (channel: string) => {
    let row = counts.get(channel);
    if (!row) { row = { worker: 0, review: 0, consult: 0 }; counts.set(channel, row); }
    return row;
  };
  for (const e of events) {
    if (e.event === "task-dispatch") {
      const channel = assignmentChannel(e.data);
      if (channel) ensure(channel).worker++;
      continue;
    }
    if (e.event === "gate-result" && e.data.gate === "review") {
      const channel = reviewerChannel(e.data);
      if (channel) ensure(channel).review++;
      continue;
    }
    if (e.event === "review-leg2") {
      const channel = reviewerChannel(e.data);
      if (channel) ensure(channel).review++;
      continue;
    }
    if (e.event === "consult-verdict") {
      const channel = consultChannel(e.data);
      if (channel) ensure(channel).consult++;
    }
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([channel, role]) => ({ channel, ...role }));
}

export interface OperatorRecordRow extends ChannelRoleCounts, Omit<ChannelUsageLabel, "channel"> {}

/** The shared record: one row per channel journal evidence actually names (role counts), joined
 *  with that channel's metered/priced facts. A channel `costs` prices but journal evidence never
 *  names gets no row here — this never invents a role from cost data alone. */
export function buildOperatorRecord(events: readonly JournalEvent[], costs: readonly ChannelCost[] = []): OperatorRecordRow[] {
  const byChannel = new Map(costs.map((c) => [`${c.adapter}:${c.model}`, c]));
  return channelRoleCounts(events).map((role) => {
    const usage = labelChannelUsage(role.channel, byChannel.get(role.channel));
    return { ...role, tokens: usage.tokens, money: usage.money };
  });
}

export function formatOperatorRecordRow(row: OperatorRecordRow): string {
  return `${row.channel} — worker: ${row.worker}, review: ${row.review}, consult: ${row.consult}; tokens: ${row.tokens}; money: ${row.money}`;
}
