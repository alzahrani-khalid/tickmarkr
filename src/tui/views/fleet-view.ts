// T3 (v1.66): fleet view — the harness roster. Pure render over INJECTED data: the module never
// touches the filesystem, so the studio shell (or a test) loads doctor.json + recent run journals
// up front and hands the facts in. Auth comes from the doctor cache (AuthHealth), enabled/denied
// state and provenance notes from the harvested fleet overlay, and the per-channel health digest
// is folded from journal telemetry rows (TelemetryRow) — never from any new state file.
import type { View } from "../app.js";
import type { AuthHealth } from "../../adapters/types.js";
import type { Tier } from "../../config/config.js";
import type { TelemetryRow } from "../../run/journal.js";
import { GLYPHS, bold, dim, fail, legend } from "../../brand.js";

/** One discovered adapter and its classified models (cfg.tiers via channels()). */
export type FleetRosterEntry = {
  adapter: string;
  models: { model: string; tier: Tier; channel: "sub" | "api" }[];
};

/** Provenance notes harvested from overlay `# comment`s (fleet-overlay.ts shapes). */
export type FleetProvenanceNotes = {
  denyAdapters?: Record<string, string>;
  denyModels?: Record<string, string>;
};

/** Everything the roster renders — loaded by the caller, never by the render path. */
export type FleetViewData = {
  adapters: FleetRosterEntry[];
  /** Doctor cache contents (doctor.json), keyed by adapter id. */
  health: Record<string, AuthHealth>;
  /** Age of the doctor cache in ms; null when no probe data exists. */
  doctorAgeMs: number | null;
  denyAdapters: string[];
  /** routing.deny.models entries in channelKey form ("adapter:model"). */
  denyModels: string[];
  notes?: FleetProvenanceNotes;
  /** Telemetry folded from recent run journals (readAllTelemetry); runId optional. */
  telemetry: (TelemetryRow & { runId?: string })[];
};

/** Per-channel health digest, folded from journal telemetry rows only. */
export type ChannelHealth = {
  key: string;
  tasks: number;
  attempts: number;
  done: number;
  failed: number;
  human: number;
  overruns: number;
  quotaFailovers: number;
  /** Sum of OBSERVED gateFails; null when no row carried the field (unobserved, never 0). */
  gateFails: number | null;
  medianDurationMs: number | null;
  lastOutcome: TelemetryRow["outcome"] | null;
};

const keyOf = (r: { adapter: string; model: string }): string => `${r.adapter}:${r.model}`;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Fold one row list into a single digest. Journals are append-only, so input order is
 *  chronological and the last row's outcome is the channel's last observed outcome. */
function foldRows(key: string, rows: TelemetryRow[]): ChannelHealth {
  const d: ChannelHealth = {
    key, tasks: 0, attempts: 0, done: 0, failed: 0, human: 0,
    overruns: 0, quotaFailovers: 0, gateFails: null, medianDurationMs: null, lastOutcome: null,
  };
  for (const r of rows) {
    d.tasks += 1;
    d.attempts += r.attempts;
    if (r.outcome === "done") d.done += 1;
    else if (r.outcome === "failed") d.failed += 1;
    else d.human += 1;
    if (r.overrun === true) d.overruns += 1;
    if (r.quotaFailover === true) d.quotaFailovers += 1;
    // absent = unobserved: an all-legacy channel keeps gateFails null rather than a fake 0
    if (r.gateFails !== undefined) d.gateFails = (d.gateFails ?? 0) + r.gateFails;
    d.lastOutcome = r.outcome;
  }
  if (rows.length) d.medianDurationMs = median(rows.map((r) => r.durationMs));
  return d;
}

/** Fold journal telemetry rows into a per-channel health digest keyed by channelKey
 *  ("adapter:model"). The digest derives from journal telemetry (TelemetryRow, the rows the
 *  daemon appends to each run's telemetry.jsonl) rather than any new state file: this module
 *  reads nothing and writes nothing — the caller folds rows out of the existing run journals
 *  (readAllTelemetry) and the fold is a pure function of them, same telemetry in, same digest
 *  out. */
export function foldChannelHealth(rows: (TelemetryRow & { runId?: string })[]): Map<string, ChannelHealth> {
  const byChannel = new Map<string, TelemetryRow[]>();
  for (const r of rows) {
    const key = keyOf(r);
    const list = byChannel.get(key);
    if (list) list.push(r);
    else byChannel.set(key, [r]);
  }
  const out = new Map<string, ChannelHealth>();
  for (const [key, list] of byChannel) out.set(key, foldRows(key, list));
  return out;
}

/** The studio View plus the roster's own key seam. The T2 shell binds only view-level keys, so
 *  expand/collapse and selection are driven through key() — the same names the engine decodes. */
export type FleetView = View & {
  /** Handle a decoded key name ("up" | "down" | "left" | "right" | "space" | "return"). */
  key(name: string): void;
  /** Whether an adapter's model rows are currently shown. */
  expanded(adapter: string): boolean;
  /** channelKey of the cursor's channel, or null when the cursor sits on an adapter row. */
  selectedChannel(): string | null;
};

// fleet.ts formatAge voice — the operator already reads "12m old" on the classic fleet screen.
const formatCacheAge = (ageMs: number | null): string => {
  if (ageMs === null) return "no probe data";
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${mins}m old`;
  return `${Math.floor(mins / 60)}h old`;
};

const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${(s / 60).toFixed(1)}m`;
};

const trunc = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

const note = (n: string | undefined): string => (n ? ` — ${n}` : "");

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** doctor.ts model-status voice: authed / unauthed with reason+date / unknown. A non-installed
 *  adapter is "unknown" whatever stale modelAuth its doctor entry still carries — the roster row
 *  and the detail panel must never disagree about whether a channel is usable. */
function modelAuthText(health: AuthHealth | undefined, model: string): string {
  const v = health?.installed ? health.modelAuth?.[model] : undefined;
  if (!v) return "unknown";
  if (v.authed) return "authed";
  return `unauthed: ${trunc(v.reason ?? "probe failed", 40)} (${v.probedAt.slice(0, 10)})`;
}

/** A channel is denied by its own routing.deny.models entry OR by its adapter's deny — the roster
 *  row and the detail panel resolve deny through this one seam so an adapter-level deny can never
 *  read as available on the model row while the panel below it says "denied". Adapter deny wins
 *  and carries the adapter's note: it is the broader reason. */
function denyOf(data: FleetViewData, adapter: string, model: string): { denied: boolean; note?: string } {
  if (data.denyAdapters.includes(adapter)) return { denied: true, note: data.notes?.denyAdapters?.[adapter] };
  const key = `${adapter}:${model}`;
  if (data.denyModels.includes(key)) return { denied: true, note: data.notes?.denyModels?.[key] };
  return { denied: false };
}

function digestLine(d: ChannelHealth, noun: string): string {
  if (d.tasks === 0) return `  journals: no recent telemetry for this ${noun}`;
  const parts = [
    `${d.tasks} task${d.tasks === 1 ? "" : "s"}`,
    `${d.attempts} attempt${d.attempts === 1 ? "" : "s"}`,
    `${d.done} done`,
  ];
  if (d.failed) parts.push(`${d.failed} failed`);
  if (d.human) parts.push(`${d.human} human`);
  if (d.medianDurationMs !== null) parts.push(`median ${fmtDuration(d.medianDurationMs)}`);
  if (d.gateFails !== null) parts.push(`${d.gateFails} gate-fails`);
  parts.push(`${d.overruns} overrun${d.overruns === 1 ? "" : "s"}`);
  parts.push(`${d.quotaFailovers} quota failover${d.quotaFailovers === 1 ? "" : "s"}`);
  return `  journals: ${parts.join(" · ")}`;
}

type Row = { kind: "adapter"; adapter: string } | { kind: "model"; adapter: string; model: string };

export function createFleetView(data?: FleetViewData): FleetView {
  // One expanded bit per adapter, default expanded — the roster shows everything at a glance.
  const expandedMap = new Map<string, boolean>((data?.adapters ?? []).map((a) => [a.adapter, true]));
  let cursor = 0;

  const visibleRows = (): Row[] => {
    const rows: Row[] = [];
    for (const a of data?.adapters ?? []) {
      rows.push({ kind: "adapter", adapter: a.adapter });
      if (expandedMap.get(a.adapter) !== false) {
        for (const m of a.models) rows.push({ kind: "model", adapter: a.adapter, model: m.model });
      }
    }
    return rows;
  };

  const view: FleetView = {
    id: "fleet",
    label: "Fleet",

    key(name: string): void {
      const rows = visibleRows();
      if (!rows.length) return;
      if (name === "up") cursor = Math.max(cursor - 1, 0);
      else if (name === "down") cursor = Math.min(cursor + 1, rows.length - 1);
      else if (name === "left" || name === "right" || name === "space" || name === "return") {
        const row = rows[cursor];
        if (!row) return;
        const cur = expandedMap.get(row.adapter) !== false;
        const next = name === "left" ? false : name === "right" ? true : !cur;
        expandedMap.set(row.adapter, next);
        if (row.kind === "model" && !next) {
          // collapsing from a model row parks the cursor on the adapter header row
          cursor = visibleRows().findIndex((r) => r.kind === "adapter" && r.adapter === row.adapter);
        }
      }
      const n = visibleRows().length;
      cursor = Math.min(Math.max(cursor, 0), n - 1);
    },

    expanded(adapter: string): boolean {
      return expandedMap.get(adapter) !== false;
    },

    selectedChannel(): string | null {
      const row = visibleRows()[cursor];
      return row?.kind === "model" ? `${row.adapter}:${row.model}` : null;
    },

    render(_props: { cols: number; rows: number }): string[] {
      if (!data) {
        // T2 stub surface — the shell registers the view before any data source is wired.
        return ["Fleet view", "Harness roster and health (read-only in v1.66)."];
      }
      const digest = foldChannelHealth(data.telemetry);
      const lines: string[] = [bold("Fleet view — harness roster")];
      lines.push(
        legend(
          `doctor cache: ${formatCacheAge(data.doctorAgeMs)} · ${data.adapters.length} adapters · ` +
          `${data.telemetry.length} journal rows · ↑↓ select · → expand · ← collapse · space toggle`,
        ),
      );

      const rows = visibleRows();
      rows.forEach((row, i) => {
        const pointer = i === cursor ? `${GLYPHS.pointer} ` : "  ";
        const h = data.health[row.adapter];
        if (row.kind === "adapter") {
          const marker = expandedMap.get(row.adapter) !== false ? "▾" : "▸";
          const state = !h?.installed
            ? `${fail(GLYPHS.fail)} not installed`
            : `${h.version ?? "installed"} · ${h.authed ? "authed" : "unauthed"}`;
          const counts = h?.installed ? ` · ${plural(entryOf(data, row.adapter)?.models.length ?? 0, "model")}` : "";
          const deny = data.denyAdapters.includes(row.adapter)
            ? ` · ${fail("denied")}${note(data.notes?.denyAdapters?.[row.adapter])}`
            : "";
          lines.push(`${pointer}${marker} ${bold(row.adapter)}  ${state}${counts}${deny}`);
          return;
        }
        const m = data.adapters.find((a) => a.adapter === row.adapter)?.models.find((mm) => mm.model === row.model);
        if (!m) return;
        const key = `${row.adapter}:${row.model}`;
        const auth = modelAuthText(h, row.model);
        const dn = denyOf(data, row.adapter, row.model);
        const deny = dn.denied ? `  ${fail(GLYPHS.fail)} denied${note(dn.note)}` : "";
        const d = digest.get(key);
        const healthBit = d && d.tasks > 0 ? `  ${dim(`${d.done}/${d.tasks} done`)}` : "";
        lines.push(`${pointer}  ${row.model.padEnd(28)} [${m.tier}] ${m.channel}  ${auth}${deny}${healthBit}`);
      });

      lines.push(...detailPanel(data, digest, rows[cursor]));
      return lines;
    },
  };
  return view;
}

const entryOf = (data: FleetViewData, adapter: string): FleetRosterEntry | undefined =>
  data.adapters.find((a) => a.adapter === adapter);

/** The bottom panel: the selected channel's journal-derived health digest (or the adapter fold
 *  when the cursor sits on an adapter header row). */
function detailPanel(
  data: FleetViewData,
  digest: Map<string, ChannelHealth>,
  row: Row | undefined,
): string[] {
  if (!row) return [];
  const h = data.health[row.adapter];
  if (row.kind === "model") {
    const key = `${row.adapter}:${row.model}`;
    const m = data.adapters.find((a) => a.adapter === row.adapter)?.models.find((mm) => mm.model === row.model);
    const v = h?.installed ? h.modelAuth?.[row.model] : undefined;
    // an unauthed reading already carries its probe date inside modelAuthText — appending it again
    // printed the same day twice ("… (2026-07-21) (probed 2026-07-21)")
    const probed = v?.authed ? ` (probed ${v.probedAt.slice(0, 10)})` : "";
    const dn = denyOf(data, row.adapter, row.model);
    const d = digest.get(key);
    const lines = [
      "",
      dim(`── ${key} ──`),
      `  tier ${m?.tier ?? "???"} · ${m?.channel ?? "?"} · ${modelAuthText(h, row.model)}${probed} · ${dn.denied ? "denied" : "enabled"}${note(dn.note)}`,
      digestLine(d ?? foldRows(key, []), "channel"),
    ];
    if (d?.lastOutcome) lines.push(`  last outcome: ${d.lastOutcome}`);
    return lines;
  }
  const folded = foldRows(row.adapter, data.telemetry.filter((r) => r.adapter === row.adapter));
  const state = !h?.installed ? "not installed" : `${h.version ?? "installed"} · ${h.authed ? "authed" : "unauthed"}`;
  const denied = data.denyAdapters.includes(row.adapter);
  const enabled = `${denied ? "denied" : "enabled"}${denied ? note(data.notes?.denyAdapters?.[row.adapter]) : ""}`;
  return [
    "",
    dim(`── ${row.adapter} (adapter) ──`),
    `  ${state} · ${plural(entryOf(data, row.adapter)?.models.length ?? 0, "model")} · ${enabled}`,
    digestLine(folded, "adapter"),
  ];
}
