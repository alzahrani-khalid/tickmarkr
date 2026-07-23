import { type AuthHealth, channelKey, channelsFromConfig } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";
import { validateGraph } from "../graph/schema.js";
import { route, RoutingError } from "./router.js";

export interface Disallowed { by: "deny" | "allow"; entry: string }
export type PreferenceRole = "worker" | "judge" | "review" | "consult";

const adapterIds = (adapters: { id: string }[] | string[]): string[] =>
  typeof adapters[0] === "string" ? (adapters as string[]) : (adapters as { id: string }[]).map((a) => a.id);

export function excludedChannels(
  cfg: TickmarkrConfig,
  adapters: { id: string }[] | string[],
  health: Record<string, AuthHealth>,
): { key: string; d: Disallowed }[] {
  const { allow, deny } = cfg.routing;
  if (!allow && !deny) return [];
  const out: { key: string; d: Disallowed }[] = [];
  for (const id of adapterIds(adapters)) {
    if (!health[id]?.installed || !health[id]?.authed) continue;
    for (const c of channelsFromConfig(id, cfg)) {
      const d = disallowedBy(c, cfg.routing);
      if (d) out.push({ key: channelKey(c), d });
    }
  }
  return out;
}

export function exclusionLine(excluded: { key: string; d: Disallowed }[]): string {
  const parts = excluded.map(({ key, d }) => `${key} (${d.by}: ${d.entry})`);
  return `routing preference active: ${excluded.length} channel(s) excluded — ${parts.join(", ")}`;
}

// T4: the prefer rank a channel holds across the routing map — every shape whose prefer list ranks
// it, with its 0-based index in that list. Empty ⇒ the channel isn't a prefer target (routes only via
// tier/floor/cost). Mirrors preferIndex's match grammar (adapter id | channel key) — the authoritative
// routing comparator in router.ts — never the looser disallowedBy grammar that also bare-matches models.
export function preferRanks(c: { adapter: string; model: string }, cfg: TickmarkrConfig): { shape: string; rank: number }[] {
  const out: { shape: string; rank: number }[] = [];
  for (const [shape, entry] of Object.entries(cfg.routing.map)) {
    const i = (entry.prefer ?? []).findIndex((p) => p === c.adapter || p === channelKey(c));
    if (i !== -1) out.push({ shape, rank: i });
  }
  return out;
}

// entries in either list accept adapter id, model id, or adapter:model (grammar A1)
export function disallowedBy(
  c: { adapter: string; model: string },
  routing: TickmarkrConfig["routing"],
  role: PreferenceRole = "worker",
): Disallowed | null {
  const { allow, deny } = routing;
  const matches = (e: string) => e === c.adapter || e === c.model || e === channelKey(c);
  const workerDeny = role === "worker" ? deny?.workers : undefined;
  const d = [
    ...(deny?.adapters ?? []),
    ...(deny?.models ?? []),
    ...(workerDeny?.adapters ?? []),
    ...(workerDeny?.models ?? []),
  ].find(matches);
  if (d) return { by: "deny", entry: d };
  if (allow) {
    const entries = [...(allow.adapters ?? []), ...(allow.models ?? [])];
    if (!entries.some(matches)) return { by: "allow", entry: entries.join(", ") || "(empty allowlist)" };
  }
  return null;
}

export interface DenyPreferCollision {
  kind: "prefer" | "pin";
  shape: string;
  detail: string;
  disallowed: Disallowed;
}

// Delegates to route()'s preflightPrefer — doctor/resume preflight reuses the router grammar,
// not a second colon/tier/model parser of the same config.
const PREFLIGHT_SHAPE = "chore";
const preflightTask = validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T0", title: "preflight", goal: "preflight", shape: PREFLIGHT_SHAPE, complexity: 1, acceptance: ["preflight"] }],
}).tasks[0];

const disallowedFromPreferError = (msg: string): Disallowed | null => {
  const m = msg.match(/prefer entry .+ is disallowed by routing\.(deny|allow) \(([^)]+)\)/);
  return m ? { by: m[1] as "deny" | "allow", entry: m[2] } : null;
};

export function preferEntryDenied(p: string, cfg: TickmarkrConfig): Disallowed | null {
  if (!cfg.routing.allow && !cfg.routing.deny) return null;
  const probe = structuredClone(cfg);
  probe.routing.map = { ...probe.routing.map, [PREFLIGHT_SHAPE]: { prefer: [p] } };
  try {
    route(preflightTask, probe, []);
    return null;
  } catch (e) {
    if (e instanceof RoutingError) return disallowedFromPreferError(e.message);
    throw e;
  }
}

export function denyPreferCollisions(cfg: TickmarkrConfig): DenyPreferCollision[] {
  if (!cfg.routing.allow && !cfg.routing.deny) return [];
  const out: DenyPreferCollision[] = [];
  for (const [shape, entry] of Object.entries(cfg.routing.map)) {
    if (entry.pin) {
      const d = disallowedBy({ adapter: entry.pin.via, model: entry.pin.model }, cfg.routing);
      if (d) {
        out.push({
          kind: "pin",
          shape,
          detail: `${entry.pin.via}:${entry.pin.model}`,
          disallowed: d,
        });
      }
    }
    const prefer = entry.prefer ?? [];
    if (prefer.length && prefer.every((p) => preferEntryDenied(p, cfg) !== null)) {
      out.push({
        kind: "prefer",
        shape,
        detail: prefer.join(" > "),
        disallowed: preferEntryDenied(prefer[0], cfg)!,
      });
    }
  }
  return out;
}

export function denyPreferCollisionLine({ kind, shape, detail, disallowed }: DenyPreferCollision): string {
  const surface = kind === "pin" ? `routing.map.${shape}.pin` : `routing.map.${shape}.prefer`;
  const verb = kind === "pin" ? "is disallowed" : "fully disallowed";
  return `deny∩prefer: ${surface} ${detail} ${verb} by routing.${disallowed.by} (${disallowed.entry}) — remove the ${disallowed.by} entry or adjust ${kind === "pin" ? "pin" : "prefer"}`;
}
