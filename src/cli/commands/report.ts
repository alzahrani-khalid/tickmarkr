import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ttyVisual } from "../../adapters/model-lints.js";
import { addUsage, type TokenUsage } from "../../adapters/types.js";
import { dim, rule, title } from "../../brand.js";
import { loadConfig } from "../../config/config.js";
import { buildProofBundle } from "../../report/bundle.js";
import { compareRuns } from "../../report/compare.js";
import { estimateCosts, type ChannelCost } from "../../report/cost.js";
import { cellsOf, cellSummary } from "../../route/profile.js";
import { Journal, loadRoutingProfile, type JournalEvent, type TelemetryRow } from "../../run/journal.js";

const n = (x: number) => x.toLocaleString("en-US"); // explicit locale — CI/darwin flake guard
const EM = "—";

// TokenUsage fields that are actually present — filtered, never coalesced to zero (absent ⇒ unmetered).
const fields = (u: TokenUsage): string => {
  const parts = [`in ${n(u.input)}`, `out ${n(u.output)}`];
  if (u.cacheRead !== undefined && u.cacheWrite !== undefined) parts.push(`cache r/w ${n(u.cacheRead)}/${n(u.cacheWrite)}`);
  if (u.reasoning !== undefined) parts.push(`reasoning ${n(u.reasoning)}`);
  return parts.join("  ");
};
const total = (u: TokenUsage): number =>
  [u.input, u.output, u.cacheRead, u.cacheWrite, u.reasoning].filter((x): x is number => x !== undefined).reduce((a, b) => a + b, 0);

const firstLine = (s: unknown): string => {
  if (typeof s !== "string" || !s) return EM;
  const i = s.indexOf("\n");
  return (i < 0 ? s : s.slice(0, i)) || EM;
};

const channelLabel = (data: Record<string, unknown>): string => {
  const a = data.assignment;
  if (!a || typeof a !== "object") return EM;
  const { adapter, model } = a as { adapter?: unknown; model?: unknown };
  return typeof adapter === "string" && typeof model === "string" ? `${adapter}:${model}` : EM;
};

const rateBasis = (row: ChannelCost): string => {
  if (!row.rate) return EM;
  const cache = row.rate.cacheReadPerMtok === undefined ? "" : `; cache-read $${row.rate.cacheReadPerMtok}/Mtok`;
  const date = row.rate.rateDate === undefined ? "" : `; rate date ${row.rate.rateDate}`;
  return `in/out $${row.rate.inPerMtok}/$${row.rate.outPerMtok}/Mtok${cache}${date}`;
};

const priceLine = (row: ChannelCost): string => {
  const windows = row.channel === "sub" && row.subPlan ? `windows: ${n(row.attempts)}` : `attempts/windows: ${n(row.attempts)}`;
  const tokenText = row.tokens
    ? `tokens: ${row.partialMetering ? "≥ " : ""}${fields(row.tokens)} (${n(total(row.tokens))} tokens)`
    : "tokens: unmetered";
  const prices: string[] = [];
  const bases: string[] = [];
  if (row.apiUsd !== undefined) prices.push(`price: $${row.apiUsd.toFixed(6)}`);
  if (row.amortizedUsd !== undefined && row.subPlan !== undefined) {
    const [low, high] = row.amortizedUsd;
    prices.push(`price: $${low.toFixed(6)}–$${high.toFixed(6)} amortized`);
    bases.push(`${n(row.attempts)} windows × $${row.subPlan.planMonthly}/month ÷ ${row.subPlan.windowsPerMonthHigh}–${row.subPlan.windowsPerMonthLow} windows/month`);
  }
  if (row.counterfactualUsd !== undefined) prices.push(`API-equivalent: $${row.counterfactualUsd.toFixed(6)}`);
  if (row.rate) bases.push(rateBasis(row));
  if (!prices.length) prices.push("price: not measurable");
  if (!bases.length) bases.push(row.reason || "not recorded");
  return `- **${row.adapter}:${row.model}** — ${windows}; ${tokenText}; ${prices.join("; ")}; basis: ${bases.join("; ")}`;
};

const journalUsage = (events: JournalEvent[], known: Set<string>): string[] => {
  const groups = new Map<string, { channel: string; label: string; attempts: number }>();
  for (const e of events) {
    if (e.event !== "task-dispatch") continue;
    const channel = typeof (e.data.assignment as { channel?: unknown } | undefined)?.channel === "string"
      ? (e.data.assignment as { channel: string }).channel
      : EM;
    const label = channelLabel(e.data);
    if (channel === EM || label === EM) continue;
    const key = `${channel}:${label}`;
    if (known.has(key)) continue;
    const group = groups.get(key);
    if (group) group.attempts++;
    else groups.set(key, { channel, label, attempts: 1 });
  }
  return [...groups.values()].map((group) =>
    `- **${group.label}** — attempts/windows: ${n(group.attempts)}; tokens: not measurable; price: not measurable; basis: no telemetry row`,
  );
};

const wallClock = (start?: JournalEvent, end?: JournalEvent): string => {
  const from = Date.parse(start?.ts || "");
  const to = Date.parse(end?.ts || "");
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "not measurable";
  const seconds = Math.round((to - from) / 1_000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
};

const detail = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : EM;

// v1.53 T5: supersession is derived from the run's OWN journal only — `superseded by` from the
// appended superseded event (last wins), `supersedes` from the run-start stamp. No cross-run scan.
const supersession = (events: JournalEvent[]): { supersededBy?: string; supersedes?: string } => {
  const by = [...events].reverse().find((e) => e.event === "superseded" && typeof e.data.by === "string")?.data.by;
  const start = events.find((e) => e.event === "run-start");
  const supersedes = typeof start?.data.supersedes === "string" ? start.data.supersedes : undefined;
  return { ...(typeof by === "string" ? { supersededBy: by } : {}), ...(supersedes ? { supersedes } : {}) };
};

const taskIds = (events: JournalEvent[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of events) {
    if (!e.taskId || seen.has(e.taskId)) continue;
    seen.add(e.taskId);
    out.push(e.taskId);
  }
  return out;
};

const outcomeFor = (events: JournalEvent[], taskId: string, runEnd?: JournalEvent): string => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.taskId !== taskId) continue;
    if (e.event === "task-done") return "unqualified opinion";
    if (e.event === "task-failed") return "qualified opinion";
    if (e.event === "task-human") return "human";
  }
  if (runEnd) {
    const d = runEnd.data;
    if (Array.isArray(d.done) && d.done.includes(taskId)) return "unqualified opinion";
    if (Array.isArray(d.failed) && d.failed.includes(taskId)) return "qualified opinion";
    if (Array.isArray(d.human) && d.human.includes(taskId)) return "human";
  }
  return "not recorded";
};

// VIS-07 / REC-01: derived only from the run journal, telemetry, and local configuration.
export function renderMarkdownRecord(runId: string, events: JournalEvent[], prices: ChannelCost[] = [], rows: TelemetryRow[] = []): string {
  const runStart = events.find((e) => e.event === "run-start");
  const runEnd = [...events].reverse().find((e) => e.event === "run-end");
  const baseRef = typeof runStart?.data.baseRef === "string" ? runStart.data.baseRef : EM;
  const branch = typeof runEnd?.data.branch === "string" ? runEnd.data.branch : EM;
  const count = (key: string) => {
    const v = runEnd?.data[key];
    return Array.isArray(v) ? String(v.length) : EM;
  };
  const gateFailures = new Map<string, number>();
  for (const event of events) {
    if (event.event !== "gate-result" || event.data.pass !== false || typeof event.data.gate !== "string") continue;
    gateFailures.set(event.data.gate, (gateFailures.get(event.data.gate) || 0) + 1);
  }
  const firstAttemptRows = rows.filter((row) => row.firstAttemptOk !== undefined);
  const firstAttemptRate = firstAttemptRows.length
    ? `${firstAttemptRows.filter((row) => row.firstAttemptOk).length}/${firstAttemptRows.length} (${Math.round((100 * firstAttemptRows.filter((row) => row.firstAttemptOk).length) / firstAttemptRows.length)}%)`
    : "not measurable";
  const usageLines = prices.map(priceLine);
  usageLines.push(...journalUsage(events, new Set(prices.map((row) => `${row.channel}:${row.adapter}:${row.model}`))));
  if (!usageLines.length) usageLines.push("- **not recorded:** attempts/windows: not measurable; tokens: not measurable; price: not measurable");

  const sup = supersession(events);
  const lines = [
    `# tickmarkr engagement`,
    "",
    `- **runId:** ${runId}`,
    ...(sup.supersededBy ? [`- **superseded by:** ${sup.supersededBy}`] : []),
    ...(sup.supersedes ? [`- **supersedes:** ${sup.supersedes}`] : []),
    `- **base ref:** ${baseRef}`,
    `- **branch:** ${branch}`,
    `- **done:** ${count("done")}`,
    `- **failed:** ${count("failed")}`,
    `- **human:** ${count("human")}`,
    "",
    "## Usage & efficiency",
    "",
    ...usageLines,
    `- **wall-clock:** ${wallClock(runStart, runEnd)}`,
    `- **first-attempt rate:** ${firstAttemptRate}`,
    `- **gate failures:** ${[...gateFailures.entries()].map(([gate, failures]) => `${gate}: ${failures}`).join(", ") || "none recorded"}`,
    `- **consults:** ${events.filter((e) => e.event === "consult-verdict").length}`,
    `- **escalations:** ${events.filter((e) => e.event === "escalation").length}`,
    "",
  ];

  lines.push("## Audit trail", "");

  for (const taskId of taskIds(events)) {
    const dispatches = events.filter((e) => e.taskId === taskId && e.event === "task-dispatch");
    const channels = dispatches.map((e) => channelLabel(e.data));
    const gates = events.filter((e) => e.taskId === taskId && e.event === "gate-result");
    const consults = events.filter((e) => e.taskId === taskId && e.event === "consult-verdict");
    const deviations = events.filter((e) => e.taskId === taskId && e.event === "route-deviation");
    const merge = [...events].reverse().find((e) => e.taskId === taskId && e.event === "merge");
    const provenance = dispatches
      .map((e) => typeof e.data.provenance === "string" ? e.data.provenance : "")
      .filter(Boolean);

    lines.push(`## ${taskId}`, "");
    lines.push(`- **opinion:** ${outcomeFor(events, taskId, runEnd)}`);
    lines.push(`- **attempts:** ${dispatches.length || EM}`);
    lines.push(`- **channels tried:** ${channels.length ? channels.join(", ") : EM}`);
    lines.push(`- **routing:** ${provenance.length ? provenance.join(" | ") : EM}`);
    if (deviations.length) {
      for (const deviation of deviations) {
        lines.push(`- **route deviation:** ${detail(deviation.data.chosen)} learned score ${detail(deviation.data.score)} (n=${detail(deviation.data.n)}) vs static ${detail(deviation.data.static)} ${detail(deviation.data.staticScore)}`);
      }
    } else lines.push(`- **route deviation:** ${EM}`);
    lines.push("- **tickmarks:**");
    if (gates.length) {
      for (const g of gates) {
        const pass = g.data.pass === true ? "pass" : g.data.pass === false ? "fail" : EM;
        const gate = typeof g.data.gate === "string" ? g.data.gate : EM;
        lines.push(`  - ${gate}: ${pass} — ${firstLine(g.data.details)}`);
      }
    } else lines.push(`  - ${EM}`);
    lines.push("- **National Office:**");
    if (consults.length) {
      for (const c of consults) {
        const action = typeof c.data.action === "string" ? c.data.action : EM;
        lines.push(`  - ${action} — ${firstLine(c.data.notes)}`);
      }
    } else lines.push(`  - ${EM}`);
    const mergedBranch = typeof merge?.data.branch === "string" ? merge.data.branch : EM;
    const mergedCommit = typeof merge?.data.commit === "string" ? merge.data.commit : EM;
    lines.push(`- **consolidation branch:** ${mergedBranch}`);
    lines.push(`- **consolidation commit:** ${mergedCommit}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function textReport(runId: string, events: JournalEvent[], rows: TelemetryRow[], cwd: string): string {
  // one group per adapter:model, carrying channel + the folded usage across its rows
  const groups = new Map<string, { channel: string; rows: TelemetryRow[] }>();
  for (const r of rows) {
    const k = `${r.adapter}:${r.model}`;
    const g = groups.get(k) ?? { channel: r.channel, rows: [] };
    g.rows.push(r);
    groups.set(k, g);
  }

  // TOKENS axis (channel-agnostic): tokens present ⇒ measured, absent ⇒ unmetered (never 0).
  const tokenLines = [...groups.entries()].map(([k, g]) => {
    const usage = g.rows.filter((r) => r.tokens).reduce<TokenUsage | undefined>((a, r) => addUsage(a, r.tokens!), undefined);
    if (!usage) return `  ${k.padEnd(24)} unmetered (adapter reports no usage)`;
    // exact iff EVERY row is metered to completion; a degraded (tokens but meteredAttempts undefined) row ⇒ floor
    const exact = g.rows.every((r) => r.tokens && r.meteredAttempts === r.attempts);
    if (exact) {
      const tasks = g.rows.length;
      return `  ${k.padEnd(24)} ${fields(usage)}   (${n(total(usage))} tokens, ${tasks} task${tasks === 1 ? "" : "s"})`;
    }
    const metered = g.rows.reduce((s, r) => (r.meteredAttempts === undefined ? s : s + r.meteredAttempts), 0);
    const attempts = g.rows.reduce((s, r) => s + r.attempts, 0);
    return `  ${k.padEnd(24)} ≥ ${fields(usage)}   (floor: ${metered}/${attempts} attempts metered)`;
  });

  // MONEY axis (orthogonal — branches on channel, NOT tokens): sub ⇒ subscription (no price ever),
  // api ⇒ operator price × tokens; no prices configured ⇒ `price unset`, never a dollar figure.
  const subs = [...groups].filter(([, g]) => g.channel === "sub").map(([k]) => k);
  const apis = [...groups].filter(([, g]) => g.channel === "api").map(([k]) => k);
  const apiLine = apis.length ? apis.map((k) => `${k} — price unset`).join(" · ") : "none configured";

  // VIS-05 learning axis: render the PREVIEW-mode profile (preview bypasses routing.learned:off) so the
  // operator audits per-cell confidence before ever flipping learning on. profile.ts owns every number
  // (cellSummary); this section only formats. probes = this run's exploratory route-deviation events.
  const cfg = loadConfig(cwd);
  const off = cfg.routing.learned === "off";
  const p = loadRoutingProfile(cwd, cfg, { preview: true });
  const probes = events.filter((e) => e.event === "route-deviation" && e.data.explore === true).length;
  const learningLines = !p || p.cells.size === 0
    ? ["  no telemetry yet"]
    : [...cellsOf(p)].map(({ shape, chKey, channel, cell }) => {
        const s = cellSummary(cell);
        return `  ${shape.padEnd(10)} ${chKey.padEnd(28)} ${channel.padEnd(4)} raw=${s.nRaw} n_eff=${s.nEff} disp=${s.dispatches} q=${s.quality === undefined ? "-" : s.quality.toFixed(2)} quota=${s.quotaHits} explore-left=${s.exploreRemaining}${s.cold ? "  cold (neutral)" : ""}`;
      });

  const gateResults = events.filter((e) => e.event === "gate-result");
  const gatePass = gateResults.filter((e) => e.data.pass).length;
  const escalations = events.filter((e) => e.event === "escalation").length;
  const consults = events.filter((e) => e.event === "consult-verdict").length;
  const failovers = events.filter((e) => e.event === "quota-failover").length;

  const sup = supersession(events);
  return [
    `tickmarkr engagement — ${runId}`,
    ...(sup.supersededBy ? [`superseded by ${sup.supersededBy}`] : []),
    ...(sup.supersedes ? [`supersedes ${sup.supersedes}`] : []),
    "",
    "engagement summary — audit trail:",
    ...[...groups.entries()].map(([k, g]) =>
      `  ${k.padEnd(30)} tasks ${g.rows.length}, attempts ${g.rows.reduce((s, r) => s + r.attempts, 0)}, done ${g.rows.filter((r) => r.outcome === "done").length}`,
    ),
    "",
    `tickmark rate: ${gateResults.length ? Math.round((100 * gatePass) / gateResults.length) : 0}% (${gatePass}/${gateResults.length})`,
    `escalations: ${escalations} · National Office consults: ${consults} · quota failovers: ${failovers}`,
    "",
    "spend — tokens (measured where observed):",
    ...tokenLines,
    "spend — money:",
    `  subscription channels (no marginal spend): ${subs.length ? subs.join(", ") : "none"}`,
    `  api channels: ${apiLine}`,
    "",
    `learning (routing.learned: ${cfg.routing.learned}${off ? " — preview" : ""}):`,
    ...learningLines,
    `  probes this run (route-deviation explore): ${probes}`,
  ].join("\n");
}

// T4 (v1.50): TTY-only brand pass over the text report — title frame + dim section chrome; row
// text and alignment untouched (the doctor/status system). Gated on ttyVisual(): the non-TTY
// surface returns untouched, and --md never styles (the record is a document surface).
const stylizeReport = (out: string): string => {
  if (!ttyVisual()) return out;
  return out
    .replace(/^.*$/m, (first) => `${title(first)}\n${rule()}`) // non-global /m ⇒ first line only
    .replace(/^(engagement summary — audit trail:|spend — tokens[^\n]*|spend — money:|learning \([^\n]*)$/gm, (l) => dim(l));
};

export async function report(argv: string[], cwd = process.cwd()): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      md: { type: "boolean" },
      // v1.70 T3: baseline run id for cost/gate/duration delta + environment comparability guard
      compare: { type: "string" },
      // v1.70 T4: write a portable, schema-versioned proof packet (local file only — no network)
      bundle: { type: "string" },
    },
    allowPositionals: true,
  });
  const runId = positionals[0] ?? Journal.latestRunId(cwd, { withJournal: true });
  if (!runId) throw new Error("no runs found — usage: tickmarkr report <run-id> [--md] [--compare <baseline-run-id>] [--bundle <path>]");
  const j = Journal.open(cwd, runId);
  const events = j.read();
  const rows = j.readTelemetry();
  const cfg = loadConfig(cwd);

  let bundleNote = "";
  if (values.bundle) {
    // Local-only write of the pure proof packet — no network path exists in buildProofBundle.
    const packet = buildProofBundle(runId, events);
    writeFileSync(values.bundle, JSON.stringify(packet, null, 2) + "\n");
    bundleNote = `wrote proof bundle → ${values.bundle}\n`;
  }

  let comparison = "";
  if (values.compare) {
    const baselineRunId = values.compare;
    const baseline = Journal.open(cwd, baselineRunId);
    const outcome = compareRuns({
      runId,
      baselineRunId,
      events,
      baselineEvents: baseline.read(),
      rows,
      baselineRows: baseline.readTelemetry(),
      cost: cfg.cost,
    });
    // Fail closed: missing run-start yields a clear reason, never a partial table.
    if (!outcome.ok) throw new Error(outcome.reason);
    comparison = "\n" + outcome.text;
  }

  if (values.md) {
    return bundleNote + renderMarkdownRecord(runId, events, estimateCosts(rows, cfg.cost), rows) + comparison;
  }
  return bundleNote + stylizeReport(textReport(runId, events, rows, cwd)) + comparison;
}
