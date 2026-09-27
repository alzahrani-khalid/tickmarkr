import { type AuthHealth, channelKey, channelsFromConfig } from "../adapters/types.js";
import { DENY_SCOPES, denyEntriesAt, type TickmarkrConfig } from "../config/config.js";
import { validateGraph } from "../graph/schema.js";
import { route, RoutingError } from "./router.js";

export interface Disallowed { by: "deny" | "allow"; entry: string }
export type PreferenceRole = "worker" | "judge" | "review" | "consult";

const PREFERENCE_ROLES: PreferenceRole[] = ["worker", "judge", "review", "consult"];

/** Provider identity comes from the served model, not a gateway adapter's stamped vendor. */
export function modelProvider(model: string, fallback = "unknown"): string {
  const id = model.toLowerCase();
  const sepIdx = id.search(/[/:\s]/);
  const prefix = sepIdx !== -1 ? id.slice(0, sepIdx) : "";
  const remainder = sepIdx !== -1 ? id.slice(sepIdx + 1) : id;
  if (prefix === "openai" || prefix === "openai-codex" || /^(?:gpt|o\d)/.test(remainder)) return "openai";
  if (prefix === "anthropic" || /^(?:claude|opus|sonnet|haiku|fable)(?:-|$)/.test(remainder)) return "anthropic";
  if (prefix === "google" || /^gemini(?:-|$)/.test(remainder)) return "google";
  if (prefix === "xai" || prefix === "xai-oauth" || /^(?:grok|xai)(?:-|$)/.test(remainder) || id.startsWith("xai-oauth")) return "xai";
  if (["zai", "zhipu", "zai-coding-plan"].includes(prefix) || /^glm(?:-|$)/.test(remainder)) return "zhipu";
  if (["kimi-code", "moonshot"].includes(prefix) || /^kimi(?:-|$)/.test(remainder)) return "moonshot";
  const normalizedFallback = fallback.toLowerCase();
  if (normalizedFallback === "xai-oauth" || normalizedFallback === "xai") return "xai";
  return fallback;
}

// Router naming remains explicit while sharing the review gate's exact function object.
export const routingModelProvider = modelProvider;

export const modelRouteIdentity = (model: string, fallback = "unknown") =>
  `${routingModelProvider(model, fallback)}/${model.slice(model.lastIndexOf("/") + 1).toLowerCase()}`;

export const channelRouteIdentity = (key: string, fallback = "unknown") => {
  const i = key.indexOf(":");
  return i < 0 ? key : modelRouteIdentity(key.slice(i + 1), fallback);
};

export function routingEntrySeatLines(cfg: TickmarkrConfig): string[] {
  const lines: string[] = [];
  const add = (path: string, entries: readonly string[] | undefined, roles: PreferenceRole[]) => {
    for (const entry of entries ?? []) lines.push(`${path} '${entry}' reaches seats: ${roles.join(", ")}`);
  };
  add("routing.allow.adapters", cfg.routing.allow?.adapters, PREFERENCE_ROLES);
  add("routing.allow.models", cfg.routing.allow?.models, PREFERENCE_ROLES);
  add("routing.deny.adapters", cfg.routing.deny?.adapters, PREFERENCE_ROLES);
  add("routing.deny.models", cfg.routing.deny?.models, PREFERENCE_ROLES);
  add("routing.deny.workers.adapters", cfg.routing.deny?.workers?.adapters, ["worker"]);
  add("routing.deny.workers.models", cfg.routing.deny?.workers?.models, ["worker"]);
  return lines;
}

// OBS-1143: the probed identity doctor cached for adapter:model — the one discoverChannels routes
// with. Absent ⇒ unknown, and the deny matcher stays conservative (alias-family match).
export const observedIdentity = (
  health: Record<string, AuthHealth> | null | undefined, adapter: string, model: string,
): string | undefined => health?.[adapter]?.modelAuth?.[model]?.identity ?? health?.[adapter]?.modelIdentities?.[model];

export const observedSeat = (health: Record<string, AuthHealth> | null | undefined, adapter: string, model: string) => {
  const identity = observedIdentity(health, adapter, model);
  return identity ? { adapter, model, identity } : { adapter, model };
};

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
      const d = disallowedBy(observedSeat(health, c.adapter, c.model), cfg.routing);
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

export function isExplicitIdOfAliasFamily(candidateModel: string, alias: string): boolean {
  if (candidateModel === alias) return true;
  const tokens = candidateModel.toLowerCase().split(/[^a-z0-9]+/);
  return tokens.includes(alias.toLowerCase());
}

export function entryMatchesChannel(
  entry: string,
  c: { adapter: string; model: string; identity?: string },
  allowFamilyMatching = false,
): boolean {
  if (entry === c.adapter) return true;
  if (entry === c.model) return true;
  if (entry === channelKey(c)) return true;
  if (c.identity) {
    if (entry === c.identity) return true;
    if (entry === `${c.adapter}:${c.identity}`) return true;
  }
  if (!c.identity && allowFamilyMatching) {
    const colon = entry.indexOf(":");
    if (colon !== -1) {
      const entryAdapter = entry.slice(0, colon);
      const entryModel = entry.slice(colon + 1);
      if (entryAdapter === c.adapter && isExplicitIdOfAliasFamily(entryModel, c.model)) {
        return true;
      }
    } else {
      if (isExplicitIdOfAliasFamily(entry, c.model)) {
        return true;
      }
    }
  }
  return false;
}

export interface ExclusionScope {
  scope: string;
  path: string;
  configPath: string;
  entry: string;
  by: "deny" | "allow";
}

export function exclusionCollector(
  c: { adapter: string; model: string; identity?: string },
  routingOrCfg: TickmarkrConfig["routing"] | TickmarkrConfig,
  role: PreferenceRole = "worker",
): ExclusionScope[] {
  const routing = "routing" in routingOrCfg ? routingOrCfg.routing : routingOrCfg;
  const out: ExclusionScope[] = [];
  const { allow } = routing ?? {};
  for (const scope of DENY_SCOPES) {
    // Lists under workers apply only to worker seats; flat deny lists cover every role.
    if (scope.path[2] === "workers" && role !== "worker") continue;
    for (const entry of denyEntriesAt(routing, scope) ?? []) {
      if (entryMatchesChannel(entry, c, true)) {
        out.push({
          scope: scope.dotted,
          path: scope.dotted,
          configPath: scope.dotted,
          entry,
          by: "deny",
        });
      }
    }
  }

  if (allow) {
    const allAllow = [...(allow.adapters ?? []), ...(allow.models ?? [])];
    const admitted = allAllow.some((e) => entryMatchesChannel(e, c, false));
    if (!admitted) {
      out.push({
        scope: "routing.allow",
        path: "routing.allow",
        configPath: "routing.allow",
        entry: allAllow.join(", ") || "(empty allowlist)",
        by: "allow",
      });
    }
  }

  return out;
}

export const collectExclusions = exclusionCollector;
export const exclusionProvenance = exclusionCollector;

// entries in either list accept adapter id, model id, or adapter:model (grammar A1)
export function disallowedBy(
  c: { adapter: string; model: string; identity?: string },
  routingOrCfg: TickmarkrConfig["routing"] | TickmarkrConfig,
  role: PreferenceRole = "worker",
): Disallowed | null {
  const exclusions = exclusionCollector(c, routingOrCfg, role);
  if (exclusions.length === 0) return null;
  const first = exclusions[0];
  return { by: first.by, entry: first.entry };
}

export interface DenyPreferCollision {
  kind: "prefer" | "pin" | "pool";
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

// OBS-1143: `health` is doctor's CACHED verdict (never a probe); its identities ride the channels
// route() reads them from, so the preflight answers exactly as the router would.
export function preferEntryDenied(p: string, cfg: TickmarkrConfig, health?: Record<string, AuthHealth> | null): Disallowed | null {
  if (!cfg.routing.allow && !cfg.routing.deny) return null;
  const probe = structuredClone(cfg);
  probe.routing.map = { ...probe.routing.map, [PREFLIGHT_SHAPE]: { prefer: [p] } };
  const observed = Object.keys(cfg.tiers).flatMap((id) => channelsFromConfig(id, cfg))
    .flatMap((c) => {
      const identity = observedIdentity(health, c.adapter, c.model);
      return identity ? [{ ...c, identity }] : [];
    });
  try {
    route(preflightTask, probe, observed);
    return null;
  } catch (e) {
    if (e instanceof RoutingError) return disallowedFromPreferError(e.message);
    throw e;
  }
}

// v1.87 T3 (OBS-162): graph-aware walk. `shapes` narrows it to the shapes the caller will actually
// route — resume hands it the loaded graph's shape set, so a collision on a shape no resumed task
// uses can no longer refuse the only crash-recovery path. Omitted ⇒ the whole routing map: doctor
// audits the config itself, which has no graph to be scoped by.
// OBS-1143: `health` (doctor's cached verdict) supplies each alias's observed identity; omitted or
// unrecorded ⇒ unknown, which stays conservative.
export function denyPreferCollisions(
  cfg: TickmarkrConfig, shapes?: Iterable<string>, health?: Record<string, AuthHealth> | null,
): DenyPreferCollision[] {
  if (!cfg.routing.allow && !cfg.routing.deny) return [];
  const inGraph = shapes === undefined ? undefined : new Set(shapes);
  const out: DenyPreferCollision[] = [];
  for (const [shape, entry] of Object.entries(cfg.routing.map)) {
    if (inGraph && !inGraph.has(shape)) continue;
    if (entry.pin) {
      const d = disallowedBy(observedSeat(health, entry.pin.via, entry.pin.model), cfg.routing);
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
    if (prefer.length && prefer.every((p) => preferEntryDenied(p, cfg, health) !== null)) {
      out.push({
        kind: "prefer",
        shape,
        detail: prefer.join(" > "),
        disallowed: preferEntryDenied(prefer[0], cfg, health)!,
      });
    }
    const pool = entry.pool;
    if (pool) {
      const denied = pool.channels.map((p) => poolEntryDisallowed(p, cfg, health));
      // only a FULLY dead pool collides — a partial deny still leaves live members to route
      if (denied.every((d) => d !== null)) {
        out.push({ kind: "pool", shape, detail: pool.channels.join(" > "), disallowed: denied[0]! });
      }
    }
  }
  return out;
}

const poolEntryDisallowed = (p: string, cfg: TickmarkrConfig, health?: Record<string, AuthHealth> | null) => {
  const i = p.indexOf(":");
  return disallowedBy(observedSeat(health, p.slice(0, i), p.slice(i + 1)), cfg.routing);
};

export interface DeadPoolEntry { shape: string; entry: string; disallowed: Disallowed; admitted: string[] }

// OBS-1144: every disallowed entry a pool carries, beside the admitted remainder the router routes
// instead — the router skips the entry; an empty remainder is the exhausted pool it refuses.
export function deadPoolEntries(
  cfg: TickmarkrConfig, shapes?: Iterable<string>, health?: Record<string, AuthHealth> | null,
): DeadPoolEntry[] {
  if (!cfg.routing.allow && !cfg.routing.deny) return [];
  const inGraph = shapes === undefined ? undefined : new Set(shapes);
  return Object.entries(cfg.routing.map).flatMap(([shape, entry]) => {
    if (!entry.pool || (inGraph && !inGraph.has(shape))) return [];
    const judged = entry.pool.channels.map((p) => ({ p, d: poolEntryDisallowed(p, cfg, health) }));
    const admitted = judged.filter(({ d }) => d === null).map(({ p }) => p);
    return judged.flatMap(({ p, d }) => (d ? [{ shape, entry: p, disallowed: d, admitted }] : []));
  });
}

export function deadPoolEntryLine({ shape, entry, disallowed, admitted }: DeadPoolEntry): string {
  const verdict = admitted.length
    ? `skipped — routes the admitted remainder ${admitted.join(" > ")}`
    : "the pool is exhausted — no admitted entry remains, so the shape is unroutable";
  return `routing.map.${shape}.pool entry ${entry} is disallowed by routing.${disallowed.by} (${disallowed.entry}) — ${verdict}`;
}

export function denyPreferCollisionLine({ kind, shape, detail, disallowed }: DenyPreferCollision): string {
  const verb = kind === "pin" ? "is disallowed" : "fully disallowed";
  return `deny∩prefer: routing.map.${shape}.${kind} ${detail} ${verb} by routing.${disallowed.by} (${disallowed.entry}) — remove the ${disallowed.by} entry or adjust ${kind}`;
}
