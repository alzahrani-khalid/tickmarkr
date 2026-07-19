import { type AuthHealth, channelKey, channelsFromConfig } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";

export interface Disallowed { by: "deny" | "allow"; entry: string }

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
): Disallowed | null {
  const { allow, deny } = routing;
  const matches = (e: string) => e === c.adapter || e === c.model || e === channelKey(c);
  const d = [...(deny?.adapters ?? []), ...(deny?.models ?? [])].find(matches);
  if (d) return { by: "deny", entry: d };
  if (allow) {
    const entries = [...(allow.adapters ?? []), ...(allow.models ?? [])];
    if (!entries.some(matches)) return { by: "allow", entry: entries.join(", ") || "(empty allowlist)" };
  }
  return null;
}
