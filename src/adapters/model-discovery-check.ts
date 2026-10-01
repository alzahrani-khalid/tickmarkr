import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import { stateDirName } from "../graph/graph.js";
import { observedIdentity } from "../route/preference.js";
import {
  CATALOG_REFRESH_TIMEOUT_MS, formatCatalogRefreshLegs, refreshCatalogCommand, resolveCatalogModel, sourcedIdentityRecord,
  type CatalogFetcher, type CatalogReadResult,
} from "./catalog-remote.js";
import { CLAUDE_ALIAS_IDENTITY_STAMPS, type ClaudeAlias } from "./claude-code.js";
import { readDoctor } from "./registry.js";
import type { AuthHealth, WorkerAdapter } from "./types.js";

export interface ModelDiscoveryCheckInput {
  cwd: string;
  cfg: TickmarkrConfig;
  adapters: WorkerAdapter[];
  /** This doctor's fresh health, BEFORE it is written: the doctor.json on disk is the prior discovery. */
  health: Record<string, AuthHealth>;
  catalog: CatalogReadResult;
  resolved: Partial<Record<ClaudeAlias, string | undefined>>;
  /** False when this doctor already refreshed, was handed a catalog, or may not touch the network. */
  mayRefresh: boolean;
  fetcher?: CatalogFetcher;
  now?: () => Date;
}

const seen = (health: Record<string, AuthHealth> | null, adapter: string): Set<string> => {
  const h = health?.[adapter];
  return new Set([...(h?.models ?? []), ...Object.values(h?.modelAuth ?? {}).flatMap((v) => (v.identity ? [v.identity] : []))]);
};

// A failed refresh's unknown outlives that doctor: keyed to the models.dev spine stamp it failed against,
// so any later successful refresh (doctor's guard, fleet, catalog refresh) supersedes it by moving the stamp.
const unknownPath = (cwd: string) => join(cwd, stateDirName(cwd), "catalog-coverage-unknown.json");
const spineStamp = (c: CatalogReadResult): string | null =>
  c.source === "cache" ? c.catalog.legFetchedAt?.modelsDev ?? c.catalog.fetchedAt : null;
function persistedUnknown(cwd: string, catalog: CatalogReadResult): string[] {
  try {
    const v = JSON.parse(readFileSync(unknownPath(cwd), "utf8")) as { modelsDevAt?: unknown; keys?: unknown };
    return v.modelsDevAt === spineStamp(catalog) && Array.isArray(v.keys) ? v.keys.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Doctor's post-discovery coverage check. A model this discovery ADDED (absent from the prior
 * doctor.json) that the catalog does not cover earns at most ONE refresh, even under a fresh cache;
 * a model already seen never re-fetches, so a permanently uncovered model cannot become a per-run
 * fetch. A failed refresh leaves coverage unknown — never "uncovered" — until a successful refresh. Advisory: no config, tier or
 * routing write; sourced identity records print as inference for confirmation.
 */
export async function checkModelDiscovery(input: ModelDiscoveryCheckInput): Promise<{ catalog: CatalogReadResult; findings: string[] }> {
  const { cfg, health } = input;
  const prior = readDoctor(input.cwd);
  const findings: string[] = [];
  // Discovery is every listed model and resolved alias identity, classified or not: an operator's tier
  // classification never establishes catalog coverage. A claude alias is checked as the identity it
  // resolved to; one with no resolved identity has nothing a refresh could cover (its row says unknown).
  const resolvedOf = (adapter: string, model: string) =>
    adapter === "claude-code" && model in CLAUDE_ALIAS_IDENTITY_STAMPS ? input.resolved[model as ClaudeAlias] ?? null : undefined;
  const added = input.adapters.filter((a) => health[a.id]?.installed).flatMap((a) => {
    const before = seen(prior, a.id);
    return [...seen(health, a.id)].filter((model) => !before.has(model) && resolvedOf(a.id, model) !== null)
      .map((model) => ({ adapter: a.id, model, resolvedModel: resolvedOf(a.id, model) ?? undefined }));
  });
  const covered = (catalog: CatalogReadResult, row: { adapter: string; model: string; resolvedModel?: string }) =>
    resolveCatalogModel(catalog.catalog, { provider: cfg.tiers[row.adapter]?.vendor ?? undefined, model: row.model, resolvedModel: row.resolvedModel }) !== undefined;
  let catalog = input.catalog;
  const unknown = persistedUnknown(input.cwd, catalog);
  if (unknown.length) catalog = { ...catalog, coverageUnknown: unknown };
  const uncovered = added.filter((row) => !covered(catalog, row));
  if (uncovered.length && input.mayRefresh) {
    const refreshed = await refreshCatalogCommand({
      repoRoot: input.cwd, fetcher: input.fetcher, timeoutMs: CATALOG_REFRESH_TIMEOUT_MS, now: input.now,
    });
    const names = (rows: typeof uncovered) => rows.map((r) => `${r.adapter}:${r.model}`).join(", ");
    if (refreshed.legs.some((leg) => leg.leg === "models.dev" && leg.status === "updated")) {
      catalog = refreshed.catalog;
      const still = uncovered.filter((row) => !covered(catalog, row));
      findings.push(`catalog coverage refreshed once after discovery added ${uncovered.length} uncovered model(s) (${names(uncovered)})${still.length ? `; still uncovered: ${names(still)}` : "; now covered"} — ${formatCatalogRefreshLegs(refreshed.legs)} (advisory — routing unchanged)`);
    } else {
      const keys = [...new Set([...unknown, ...uncovered.map((r) => `${r.adapter}:${r.model}`)])];
      catalog = { ...catalog, coverageUnknown: keys };
      mkdirSync(join(input.cwd, stateDirName(input.cwd)), { recursive: true });
      writeFileSync(unknownPath(input.cwd), JSON.stringify({ modelsDevAt: spineStamp(refreshed.catalog), keys }) + "\n");
      findings.push(`catalog coverage unknown for ${names(uncovered)} — the one post-discovery refresh failed: ${formatCatalogRefreshLegs(refreshed.legs)} (advisory — routing unchanged)`);
    }
  }
  findings.push(...identityRecordFindings(cfg, health, input.resolved));
  return { catalog, findings };
}

/**
 * Sourced tier/price/window per resolved alias; unknown and unsourced identities claim nothing. An alias
 * the probe proved unauthed is not listed as unknown: its model-status row already names why.
 */
function identityRecordFindings(cfg: TickmarkrConfig, health: Record<string, AuthHealth>, resolved: Partial<Record<ClaudeAlias, string | undefined>>): string[] {
  const configured = cfg.tiers["claude-code"]?.models ?? {};
  const unknown: string[] = [];
  const rows: string[] = [];
  for (const [alias, identity] of Object.entries(resolved) as [ClaudeAlias, string | undefined][]) {
    if (!identity) {
      if (health["claude-code"]?.modelAuth?.[alias]?.authed !== false) unknown.push(alias);
      continue;
    }
    const record = sourcedIdentityRecord(identity);
    if (!record || record.alias !== alias) {
      // A record of another alias family is a disagreement, never a record this alias may borrow.
      rows.push(`identity record: claude-code:${alias} → ${identity} ${record ? `disagrees with the ${alias} family` : "has no sourced record"} — tier/price/window unknown`);
      continue;
    }
    rows.push(`identity record: claude-code:${alias} → ${identity} · $${record.inputCostPerMtok}/$${record.outputCostPerMtok} per Mtok (API) · window ${record.contextWindow}/${record.outputWindow} · sourced ${record.fetchedAt} (${record.sources.join(", ")})`
      + ` · INFERRED tier ${record.tier} by ${record.tierBasis} — inference for operator confirmation (tickmarkr fleet); doctor writes no configuration`
      + ` · routing authority: configured claude-code:${alias}=${configured[alias] ?? "unclassified"}`);
  }
  if (unknown.length) rows.unshift(`identity record: claude-code:${unknown.join(", ")} identity unknown — no sourced tier/price/window applies`);
  return rows;
}

/**
 * plan's headline: drift read from the identity doctor PERSISTED for each configured claude alias.
 * Matching identities stay silent; an alias doctor never resolved stays unknown, never clean.
 */
export function aliasIdentityHeadlines(cfg: TickmarkrConfig, health: Record<string, AuthHealth>): string[] {
  if (!health["claude-code"]?.installed) return [];
  const configured = cfg.tiers["claude-code"]?.models ?? {};
  const unknown: string[] = [];
  const lines: string[] = [];
  for (const [alias, stamped] of Object.entries(CLAUDE_ALIAS_IDENTITY_STAMPS)) {
    if (!(alias in configured)) continue;
    const identity = observedIdentity(health, "claude-code", alias);
    if (!identity) unknown.push(alias);
    else if (identity !== stamped) {
      lines.push(`alias drift: claude-code:${alias} serves ${identity} (persisted by doctor), stamped identity ${stamped} — reclassify per benchmark policy (advisory — routing unchanged)`);
    }
  }
  if (unknown.length) lines.push(`alias identity unknown: claude-code:${unknown.join(", ")} — doctor persisted no resolved identity (run tickmarkr doctor)`);
  return lines;
}
