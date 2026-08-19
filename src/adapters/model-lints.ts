import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type TickmarkrConfig, TIER_RANK, type Tier } from "../config/config.js";
import { filesGlob } from "../graph/files-glob.js";
import type { Task } from "../graph/schema.js";
import { buildTaskPrompt } from "./prompt.js";
import { channelKey, MODEL_ID_RE, type AuthHealth, type WorkerAdapter } from "./types.js";
import { resolveCatalogModel, type CatalogModelEvidence, type CatalogReadResult } from "./catalog-remote.js";
export const SEED_STAMPED = "2026-07-09";
// knowledge past this age gets a "rerun tickmarkr doctor" nudge (BLOCKED_POLL_MS-style named constant).
export const MODEL_STALE_DAYS = 30;
const DAY_MS = 86400000;
// cursor-agent 2026.07.08 reports 193 mostly-parameterized ids (e.g. gpt-5.3-codex-high-fast); filter the `auto`
// pseudo-model + effort/speed variant suffixes from the unconfigured-lint aggregation ONLY — doctor.json keeps the
// raw list (verified 2026-07-10). Data stays raw; lints stay signal. -max/-none/-thinking joined the suffix set
// 2026-08-12 (D-OBS-11: cursor's residual lint list was still mostly effort variants of configured bases).
const LINT_VARIANT_RE = /^auto$|-(fast|minimal|none|low|medium|high|xhigh|max|thinking)$/;
const LINT_CAP = 5;

/**
 * Operator directive 2026-08-13 ("we should exclude all retired models"): the fleet models
 * screen hides these classes BY DEFAULT — omp alone reports 218 ids, most of them dated
 * snapshots, previews, and SKUs that can never carry a worker. Shape-based on purpose: a
 * knowledge list of retired families rots, a suffix grammar does not. Hidden is never gone —
 * the screen counts what it hid and one key reveals it, and CLASSIFIED models are never hidden
 * regardless of shape (an operator who tiered a dated snapshot meant it).
 */
export function retiredModelReason(model: string): "dated snapshot" | "preview" | "non-worker" | "legacy family" | null {
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  // vendor-dated pins: claude-3-5-sonnet-20241022, claude-opus-4-1-20250805, *-preview-10-2025
  if (/-20\d{6}$/.test(bare)) return "dated snapshot";
  if (/-preview(?:-\d{2}-20\d{2})?$/.test(bare)) return "preview";
  // SKUs that cannot carry a worker seat: media, embedding, retrieval, and browsing surfaces
  if (/(?:^|-)(?:embed(?:ding)?s?|tts|whisper|audio|image|vision|ocr|rerank|moderation|computer-use|deep-research)(?:-|$)/.test(bare)) return "non-worker";
  // superseded generations still reported by CLIs long after retirement
  if (/^(?:gemini-1\.|claude-3-|gpt-3\.|gpt-4-)/.test(bare)) return "legacy family";
  return null;
}
const TTY_LINT_CAP = 3;
const DEFAULT_STATE_DIR = ".tickmarkr";
const doctorJsonRef = (stateDir: string) => ` — see ${stateDir}/doctor.json`;
const DECLARED_SEED_PREFER_DISPOSITION = "no declared preference overrides it";
const LEGACY_DOCTOR_SEED_PREFER_DISPOSITION = "auto-prefer is routing around it";

export const ttyVisual = () => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

// ponytail: chars/4 token heuristic — good enough for advisory plan lint; no tokenizer dep.
const CHARS_PER_TOKEN = 4;

/** Bases that band FLEET-RELATIVELY, most-trusted first (2026-08-13 ranking-sites assessment §4.3). */
const RANKED_BASES = ["agentic-coding", "intelligence"] as const;
type RankedBasis = typeof RANKED_BASES[number];
export type CatalogSuggestionBasis = RankedBasis | "price";

export interface CatalogModelAdvisory {
  coverage: "covered" | "uncovered";
  evidence?: CatalogModelEvidence;
  suggestion?: { tier: Tier; kind: "inference"; basis: CatalogSuggestionBasis; provenanceNote: string };
  display: string;
}

/** A (adapter, model) pair under advisory at a call site; it joins that call's ranking universe. */
export interface CatalogAdvisoryRow { adapter: string; model: string; resolvedModel?: string }

/** Per-basis descending scores; a basis below MIN_RANKED_MODELS never appears, so it yields. */
export type CatalogTierRanking = ReadonlyArray<{ basis: RankedBasis; scores: number[] }>;

/**
 * D-2 (2026-08-13 ranking-sites assessment): the retired `index >= 65 → frontier` cut was calibrated
 * against an older, higher-ceilinged AA index. After the v4.x rescale the best model in existence
 * scored 63.05, so NOTHING could ever be frontier. An absolute cut against a vendor index that gets
 * rescaled is the defect CLASS — the fix is a rank among the models we actually hold same-basis
 * evidence for, not a new magic number. Three is the floor: thirds over two models is a coin toss.
 */
const MIN_RANKED_MODELS = 3;

/** Rank r of n, 0-based: top third → frontier, middle third → mid, bottom third → cheap. */
const bandOfRank = (rank: number, total: number): Tier =>
  rank * 3 < total ? "frontier" : rank * 3 < total * 2 ? "mid" : "cheap";

const basisScore = (evidence: CatalogModelEvidence, basis: RankedBasis): number | undefined =>
  basis === "agentic-coding" ? evidence.agenticCodingScore : evidence.intelligenceIndex;

const priceTier = (outputPerMtok: number): Tier => outputPerMtok >= 12 ? "frontier" : outputPerMtok >= 2 ? "mid" : "cheap";
const round1 = (n: number): number => Math.round(n * 10) / 10;

function catalogEvidenceFor(
  cfg: TickmarkrConfig,
  catalog: CatalogReadResult,
  row: CatalogAdvisoryRow,
): CatalogModelEvidence | undefined {
  return resolveCatalogModel(catalog.catalog, {
    // A tier vendor is NULLABLE (config.ts:64) — null means "declared as having none at tier level, so
    // each model must declare its own". `resolveCatalogModel` takes an optional provider HINT
    // (catalog-remote.ts:218), and "no hint" is `undefined` there, so null normalizes to undefined rather
    // than travelling as a third state. Neither T17 nor T19 could see this seam: their files[] are
    // disjoint, so no ordering edge was derived, they dispatched 7ms apart, and each worktree was cut
    // before the other's change existed. Both gates passed truthfully; only the merged pair fails to
    // compile (OBS-371).
    provider: cfg.tiers[row.adapter]?.vendor ?? undefined,
    model: row.model,
    ...(row.resolvedModel ? { resolvedModel: row.resolvedModel } : {}),
  });
}

/**
 * The ranking universe: configured tier models ∪ the rows under advisory at THIS call site,
 * restricted per basis to those that resolve it. Build it once per call — a band that depended on
 * which adapter happened to be iterated first would not be a band. `resolvedModel` is the SAME
 * resolver the call site hands its advisory rows: a configured claude alias (`opus`) is absent from
 * models.dev under that spelling, so without it the fleet's own frontier models silently drop out
 * of the universe they are supposed to anchor.
 */
export function catalogTierRanking(
  cfg: TickmarkrConfig,
  catalog: CatalogReadResult,
  rows: readonly CatalogAdvisoryRow[] = [],
  resolvedModel?: (adapter: string, model: string) => string | undefined,
): CatalogTierRanking {
  // Orca import #1: the vendored catalog is a shipped default (`catalogOrigin: spec` in orca's terms),
  // never a fetched observation — it may not seed a ranking any more than it may seed a suggestion.
  if (catalog.source === "vendored") return [];
  const configured: CatalogAdvisoryRow[] = Object.entries(cfg.tiers).flatMap(([adapter, entry]) =>
    Object.keys(entry.models).map((model) => ({ adapter, model, resolvedModel: resolvedModel?.(adapter, model) })));
  // The resolver supplies the matched `<providerKey>/<recordId>`: caller spellings never define
  // identity, aliases of one record collapse, and equal bare ids under distinct providers do not.
  const universe = new Map<string, CatalogModelEvidence>();
  for (const row of [...configured, ...rows]) {
    const evidence = catalogEvidenceFor(cfg, catalog, row);
    if (evidence) universe.set(evidence.catalogId, evidence);
  }
  const members = [...universe.values()];
  return RANKED_BASES.flatMap((basis) => {
    const scores = members
      .map((member) => basisScore(member, basis))
      .filter((score): score is number => score !== undefined)
      .sort((a, b) => b - a);
    return scores.length >= MIN_RANKED_MODELS ? [{ basis, scores }] : [];
  });
}

/** First basis that both clears the floor AND can place this model; ties share the better band. */
function rankedSuggestion(
  ranking: CatalogTierRanking,
  evidence: CatalogModelEvidence,
): { basis: RankedBasis; tier: Tier; basisNote: string } | undefined {
  for (const { basis, scores } of ranking) {
    const score = basisScore(evidence, basis);
    if (score === undefined) continue;
    const rank = scores.filter((other) => other > score).length;
    // Every suggestion names its evidence source AND its date: an AA band that omits the index
    // version is exactly the silent-rescale defect D-2 shipped to everyone.
    const source = basis === "agentic-coding"
      ? `LiveBench Agentic Coding ${round1(score)} (LiveBench table ${evidence.evidenceDate ?? "date not reported"})`
      : `Artificial Analysis Intelligence Index ${round1(score)} (intelligence index version ${evidence.intelligenceIndexVersion ?? "not reported"})`;
    return { basis, tier: bandOfRank(rank, scores.length), basisNote: `fleet-relative rank ${rank + 1}/${scores.length} by ${source}` };
  }
  return undefined;
}

function catalogEvidenceNote(evidence: CatalogModelEvidence, catalog: CatalogReadResult): string {
  const cost = evidence.inputCostPerMtok !== undefined && evidence.outputCostPerMtok !== undefined
    ? `$${evidence.inputCostPerMtok}/$${evidence.outputCostPerMtok} per Mtok`
    : "not reported";
  const features = evidence.features.length ? evidence.features.join(",") : "none reported";
  const agentic = evidence.agenticCodingScore !== undefined
    ? `; LiveBench Agentic Coding=${round1(evidence.agenticCodingScore)}${evidence.evidenceDate ? ` (table ${evidence.evidenceDate})` : ""}`
    : "";
  const intelligence = evidence.intelligenceIndex !== undefined
    ? `; Artificial Analysis Intelligence Index=${evidence.intelligenceIndex}${evidence.intelligenceIndexVersion ? ` (version ${evidence.intelligenceIndexVersion})` : ""}`
    : "";
  const freshness = catalog.stale ? `${catalog.source} stale cache` : catalog.source;
  return `models.dev id=${evidence.modelId}; cost=${cost}; context=${evidence.contextWindow ?? "not reported"}; features=${features}${agentic}${intelligence}; catalog=${freshness}; fetchedAt=${catalog.catalog.fetchedAt}`;
}

export function catalogModelAdvisory(
  cfg: TickmarkrConfig,
  catalog: CatalogReadResult,
  adapter: string,
  model: string,
  resolvedModel?: string,
  ranking?: CatalogTierRanking,
): CatalogModelAdvisory {
  const entry = cfg.tiers[adapter];
  const row: CatalogAdvisoryRow = { adapter, model, resolvedModel };
  const evidence = catalogEvidenceFor(cfg, catalog, row);
  if (!evidence) {
    return {
      coverage: "uncovered",
      display: `${model} — uncovered by ${catalog.source === "cache" ? "cached catalogs" : "vendored catalog"}; no tier suggestion`,
    };
  }

  const note = catalogEvidenceNote(evidence, catalog);
  // Orca import #1, read site: a shipped default must never launder into a fleet-reported suggestion.
  if (catalog.source === "vendored") {
    return {
      coverage: "covered",
      evidence,
      display: `${model} → ${note}; the vendored catalog is a shipped default, not fetched evidence — no tier suggestion (run tickmarkr doctor --refresh-catalog)`,
    };
  }
  const ranked = rankedSuggestion(ranking ?? catalogTierRanking(cfg, catalog, [row]), evidence);
  const basis = ranked
    ?? (entry?.channel === "api" && evidence.outputCostPerMtok !== undefined
      // composer-2.5's permanent home: it has zero public benchmark evidence anywhere, so price is
      // the only basis it will ever have. Unchanged absolute thresholds — price is not rescaled.
      ? { basis: "price" as const, tier: priceTier(evidence.outputCostPerMtok), basisNote: "price-derived fallback — no fleet-relative ranking basis covers this model" }
      : undefined);
  if (!basis) {
    const reason = entry?.channel === "sub" && evidence.outputCostPerMtok !== undefined
      ? "subscription billing; no price-derived suggestion"
      : "no tier suggestion from available evidence";
    return { coverage: "covered", evidence, display: `${model} → ${note}; ${reason}` };
  }

  const provenanceNote = `SUGGESTED ${basis.tier} (${basis.basis} inference, not a measurement) — ${basis.basisNote}; ${note}; operator confirmation required`;
  return {
    coverage: "covered",
    evidence,
    suggestion: { tier: basis.tier, kind: "inference", basis: basis.basis, provenanceNote },
    display: `${model} → ${note}; ${provenanceNote}`,
  };
}

function hasAnyWindows(cfg: TickmarkrConfig): boolean {
  return Object.values(cfg.tiers).some((t) => t.windows && Object.keys(t.windows).length > 0);
}

/**
 * Whether the doctor should add its optional window column. Keep non-TTY default output stable for
 * machine consumers; an interactive seed-only matrix shows T14's fleet windows, and any explicit
 * non-seed/overridden window keeps the historical operator-configured column behavior.
 */
export function hasWindowsConfig(cfg: TickmarkrConfig): boolean {
  const hasOperatorWindow = Object.entries(cfg.tiers).some(([adapter, entry]) =>
    Object.entries(entry.windows ?? {}).some(([model, window]) =>
      DEFAULT_CONFIG.tiers[adapter]?.windows?.[model] !== window,
    ),
  );
  if (hasOperatorWindow) return true;
  const seedOnly = Object.keys(cfg.tiers).every((adapter) => adapter in DEFAULT_CONFIG.tiers);
  return ttyVisual() && seedOnly && hasAnyWindows(cfg);
}

export function declaredModelWindow(cfg: TickmarkrConfig, adapter: string, model: string): number | undefined {
  return cfg.tiers[adapter]?.windows?.[model];
}

type BaseTree = { root: string; sizes: ReadonlyMap<string, number> };
/**
 * Why a CONTEXT ref carries no measurable bytes in the worker-visible tree. `produced-upstream` is
 * the benign member: the ref is written by a task this one transitively depends on, so it exists by
 * the time this task branches. Every other member is a ref the worker's "read these first" list will
 * dangle on, and `gitignored` is the member no commit can ever fix (Intl-Dossier P99 launch hold:
 * 17 tasks cited `.tickmarkr/overseer/RULING-*.md`, a self-gitignored tree).
 */
type UnmeasurableReason = "absent" | "untracked" | "gitignored" | "produced-upstream" | "base-tree-unavailable";
type UnmeasurableContext = { path: string; reason: UnmeasurableReason; producer?: string };
/** Named paths per lint line: an uncapped enumeration reached 4,924 columns on the P99 graph. */
const MAX_NAMED_PATHS = 3;

const GLOB_CHARS = /[*?{[]/;

// T13's visibility oracle is the committed base tree: workers are created from HEAD, not from the
// author's checkout or index. Keep --full-tree load-bearing for callers below the repository root.
// `-l` prices every blob in the SAME call (a per-path `cat-file -s` spawn cannot price a pattern),
// and `-z` is load-bearing correctness, not economy: without it git quotes any non-ASCII path, so
// every Arabic/UTF-8 tracked file read as absent.
function baseTreeAtHead(dir: string): BaseTree | undefined {
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  const top = git("rev-parse", "--show-toplevel");
  const tree = git("ls-tree", "--full-tree", "-r", "-l", "-z", "HEAD");
  if (top.status !== 0 || tree.status !== 0 || typeof top.stdout !== "string" || typeof tree.stdout !== "string") return undefined;
  const sizes = new Map<string, number>();
  for (const record of tree.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    // `<mode> <type> <object> <size>\t<path>`; a submodule entry carries `-` as its size and no bytes.
    const bytes = Number.parseInt(record.slice(0, tab).split(/\s+/)[3] ?? "", 10);
    sizes.set(record.slice(tab + 1), Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0);
  }
  return { root: top.stdout.trim(), sizes };
}

/**
 * Bytes a worker can read at that path in the base tree, or undefined when the tree carries nothing
 * there. A files[]-shaped pattern and a directory both price as everything they cover — matching
 * through src/graph/files-glob.ts so the estimate reads patterns exactly as the scope gate does.
 */
function measureBytes(tree: BaseTree, rel: string): number | undefined {
  const path = rel.replace(/\/+$/, "");
  const exact = tree.sizes.get(path);
  if (exact !== undefined) return exact;
  const match = GLOB_CHARS.test(path) ? filesGlob(path) : undefined;
  let total = 0;
  let covered = false;
  for (const [tracked, bytes] of tree.sizes) {
    if (!(match ? match(tracked) : tracked.startsWith(`${path}/`))) continue;
    total += bytes;
    covered = true;
  }
  return covered ? total : undefined;
}

function absentContextReason(root: string, path: string): "gitignored" | "untracked" | "absent" {
  if (spawnSync("git", ["-C", root, "check-ignore", "-q", "--", path]).status === 0) return "gitignored";
  return existsSync(join(root, path)) ? "untracked" : "absent";
}

/** Which transitive dependency, if any, declares a write scope covering a path this task must read. */
type UpstreamProducer = (taskId: string, path: string) => string | undefined;

function upstreamProducer(tasks: ReadonlyArray<Task>): UpstreamProducer {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cache = new Map<string, Array<{ id: string; covers: (path: string) => boolean }>>();
  const upstream = (taskId: string) => {
    let entry = cache.get(taskId);
    if (!entry) {
      const seen = new Set<string>();
      const walk = (from: string) => {
        for (const dep of byId.get(from)?.deps ?? []) if (!seen.has(dep)) { seen.add(dep); walk(dep); }
      };
      walk(taskId);
      entry = [...seen].map((id) => {
        const files = byId.get(id)?.files ?? [];
        return { id, covers: files.length ? filesGlob(files) : () => false };
      });
      cache.set(taskId, entry);
    }
    return entry;
  };
  return (taskId, path) => upstream(taskId).find((dep) => dep.covers(path))?.id;
}

function taskPayloadResolution(
  task: Task,
  repoRoot: string,
  feedback: string,
  tree: BaseTree | undefined = baseTreeAtHead(repoRoot),
  producerOf: UpstreamProducer = () => undefined,
): { tokens: number; unmeasurable: UnmeasurableContext[] } {
  let bytes = buildTaskPrompt(task, feedback).length;
  if (!tree) {
    return { tokens: Math.ceil(bytes / CHARS_PER_TOKEN), unmeasurable: [{ path: ".", reason: "base-tree-unavailable" }] };
  }
  // files[] is WRITE SCOPE, not payload: a task's own output (`99-04-SUMMARY.md`) is absent from the
  // base tree BY CONSTRUCTION and a scope entry is a set, not a document. Price what the worker can
  // already read there and charge nothing for the rest. Billing an output path as a measurement
  // failure is what made the window comparison unreachable on every real graph — 41 of 41 tasks on
  // the P99 graph reported "payload unreadable" and none was ever compared to its model's window.
  for (const path of task.files) bytes += measureBytes(tree, path) ?? 0;
  const unmeasurable: UnmeasurableContext[] = [];
  for (const path of task.context) {
    const measured = measureBytes(tree, path);
    if (measured !== undefined) {
      bytes += measured;
      continue;
    }
    const producer = producerOf(task.id, path);
    unmeasurable.push(producer
      ? { path, reason: "produced-upstream", producer }
      : { path, reason: absentContextReason(tree.root, path) });
  }
  return { tokens: Math.ceil(bytes / CHARS_PER_TOKEN), unmeasurable };
}

/** A numeric estimate exists only when every context ref is measurable from the worker-visible tree. */
export function estimateTaskPayloadTokens(task: Task, repoRoot: string, feedback = ""): number | undefined {
  const estimate = taskPayloadResolution(task, repoRoot, feedback);
  return estimate.unmeasurable.length === 0 ? estimate.tokens : undefined;
}

function unreachableContextLint(taskId: string, dangling: ReadonlyArray<UnmeasurableContext>): string {
  const describe = ({ path, reason }: UnmeasurableContext) => {
    if (reason === "base-tree-unavailable") return "the base tree is unavailable, so no context ref can be checked";
    const named = JSON.stringify(path);
    if (reason === "gitignored") return `${named} is gitignored — no commit can carry it into a worktree`;
    if (reason === "untracked") return `${named} is present in the checkout but not in the base tree`;
    return `${named} is absent from the base tree and no task in this graph produces it`;
  };
  const rest = dangling.length - MAX_NAMED_PATHS;
  return `${taskId}: context unreachable — ${dangling.slice(0, MAX_NAMED_PATHS).map(describe).join(", ")}`
    + `${rest > 0 ? `, +${rest} more` : ""}; the worker's "read these first" list dangles`
    + " and the context-window comparison is skipped";
}

export type RoutedAssignment = { taskId: string; adapter: string; model: string };

/** Advisory only — absent windows config or undeclared model window ⇒ no lint. */
export function contextWindowLints(
  tasks: ReadonlyArray<Task>,
  assignments: ReadonlyArray<RoutedAssignment>,
  cfg: TickmarkrConfig,
  repoRoot: string,
): string[] {
  if (!hasAnyWindows(cfg)) return [];
  const byId = new Map(assignments.map((a) => [a.taskId, a]));
  const tree = baseTreeAtHead(repoRoot);
  const producerOf = upstreamProducer(tasks);
  const lints: string[] = [];
  for (const t of tasks) {
    const a = byId.get(t.id);
    if (!a) continue;
    const window = declaredModelWindow(cfg, a.adapter, a.model);
    if (window === undefined) continue;
    const estimate = taskPayloadResolution(t, repoRoot, "", tree, producerOf);
    const dangling = estimate.unmeasurable.filter((u) => u.reason !== "produced-upstream");
    if (dangling.length > 0) {
      lints.push(unreachableContextLint(t.id, dangling));
      continue;
    }
    // An upstream-produced ref is unmeasurable but REACHABLE — the run writes it before this task
    // branches — so it earns no lint of its own: silence on the benign class is what leaves a real
    // dangling ref visible. The estimate is then a lower bound, and a lower bound over the window is
    // still an overflow, so it is reported with what it excludes named.
    if (estimate.tokens > window) {
      const pending = estimate.unmeasurable.length;
      lints.push(`${t.id}: payload ~${estimate.tokens} tokens exceeds ${a.adapter}:${a.model} window ${window}`
        + (pending > 0 ? ` (lower bound — ${pending} context ref(s) are produced upstream and not yet measurable)` : ""));
    }
  }
  return lints;
}

const adapterHasAuthedChannel = (
  adapterId: string,
  shape: string,
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  adapters: WorkerAdapter[],
): boolean => {
  // v1.52 T5: routing.floors is the only band authority — a map entry can no longer carry a tier.
  const minTier: Tier = cfg.routing.floors[shape] ?? "cheap";
  const a = adapters.find((x) => x.id === adapterId);
  const h = health[adapterId];
  if (!a || !h?.installed || typeof a.channels !== "function") return false;
  if (!h.modelAuth || !Object.keys(h.modelAuth).length) return true; // no per-model probe data — compat, not dead
  return a.channels(cfg).some((c) =>
    TIER_RANK[c.tier] >= TIER_RANK[minTier] && h.modelAuth?.[c.model]?.authed === true,
  );
};

function collectSeedPreferLints(
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  adapters: WorkerAdapter[],
  overlayPreferShapes: ReadonlySet<string>,
  disposition: string,
): string[] {
  const lints: string[] = [];
  for (const shape of Object.keys(cfg.routing.map)) {
    if (overlayPreferShapes.has(shape)) continue;
    for (const p of DEFAULT_CONFIG.routing.map[shape]?.prefer ?? []) {
      const adapterId = p.includes(":") ? p.slice(0, p.indexOf(":")) : p;
      if (!cfg.tiers[adapterId]) continue;
      if (!adapterHasAuthedChannel(adapterId, shape, cfg, health, adapters)) {
        lints.push(`routing seed names dead adapter '${adapterId}' for shape '${shape}' — ${disposition}`);
      }
    }
  }
  return lints;
}

// OBS-30 T2 / v1.86 T3: warn when a built-in seed prefer names an adapter with zero authed
// channels and no operator-declared preference overrides that seed for the shape.
export function seedPreferLints(
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  adapters: WorkerAdapter[],
  overlayPreferShapes: ReadonlySet<string> = new Set(),
): string[] {
  return collectSeedPreferLints(cfg, health, adapters, overlayPreferShapes, DECLARED_SEED_PREFER_DISPOSITION);
}

// v1.92: dead-pool lint — mirrors the dead-adapter seed lint above. A pool naming zero
// doctor-found channels renders advisory here; plan/run stays the fail-loud authority (the
// router's exhaustion RoutingError). Liveness mirrors adapterHasAuthedChannel's compat rule:
// an installed adapter without per-model probe data counts live, not dead.
export function deadPoolLints(
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  adapters: WorkerAdapter[],
): string[] {
  const lints: string[] = [];
  for (const [shape, entry] of Object.entries(cfg.routing.map)) {
    const pool = entry.pool;
    if (!pool) continue;
    const live = pool.channels.some((id) => {
      const a = adapters.find((x) => x.id === id.slice(0, id.indexOf(":")));
      const h = a && health[a.id];
      if (!a || !h?.installed || typeof a.channels !== "function") return false;
      const c = a.channels(cfg).find((ch) => channelKey(ch) === id);
      if (!c) return false;
      if (!h.modelAuth || !Object.keys(h.modelAuth).length) return true; // no per-model probe data — compat, not dead
      return h.modelAuth[c.model]?.authed === true;
    });
    if (!live) lints.push(`routing.map.${shape}.pool names no live channel — declared: ${pool.channels.join(", ")}`);
  }
  return lints;
}

// v1.54 T3: dead-steering sweep — operator prefer entries (routing.map overlay shapes, review.prefer,
// consult.prefer) that can never match an installed channel are named at plan time; v1.53 T2 pins the
// no-match case as a silent no-op, which makes a typo invisible. Advisory only: reads config + doctor
// health (no live probes), never touches routing. Seed map prefers stay seedPreferLints' turf;
// mapShapes limits this sweep to operator-authored entries so a bare default fleet isn't double-linted.
// Entry grammar mirrors preferIndex: adapter | adapter:model (first colon).
export function preferEntryLints(
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  mapShapes: ReadonlySet<string> = new Set(),
): string[] {
  const lints: string[] = [];
  const sweep = (surface: string, entries?: readonly string[]) => {
    for (const entry of entries ?? []) {
      const i = entry.indexOf(":");
      const adapter = i < 0 ? entry : entry.slice(0, i);
      const model = i < 0 ? undefined : entry.slice(i + 1);
      if (!health[adapter]?.installed) {
        lints.push(`${surface} '${entry}' names uninstalled adapter '${adapter}' — dead steering (entry can never match)`);
      } else if (model !== undefined && !(model in (cfg.tiers[adapter]?.models ?? {}))) {
        lints.push(`${surface} '${entry}' names model '${model}' absent from ${adapter}'s configured channels — dead steering (entry can never match)`);
      }
    }
  };
  for (const shape of mapShapes) sweep(`routing.map.${shape}.prefer`, cfg.routing.map[shape]?.prefer);
  sweep("review.prefer", cfg.review.prefer);
  sweep("consult.prefer", cfg.consult.prefer);
  return lints;
}

// Diffs detected models (doctor.json) against configured tiers, both directions, per installed adapter.
// No `  ! ` prefix here — the consumer (doctor rows / plan lints) owns that. Pre-v1.5 doctor.json (models:[], no
// modelsDetectedAt) is the compat baseline: `?.`/`?? []` everywhere, no zod (would reject old files).
export function modelLints(
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  adapters: WorkerAdapter[],
  opts?: { tty?: boolean; stateDir?: string; overlayPreferShapes?: ReadonlySet<string> },
): string[] {
  const cap = opts?.tty ? TTY_LINT_CAP : LINT_CAP;
  const doctorRef = opts?.tty ? doctorJsonRef(opts.stateDir ?? DEFAULT_STATE_DIR) : "";
  const lints: string[] = [];
  for (const adapter of adapters) {
    const id = adapter.id;
    if (!adapter.listModels) {
      // v1.90 / OBS-504: the seeds-stamped wording presumes a seeded tier table. agy ships routable
      // but UNCLASSIFIED (no listModels, no seed models) — for that shape the honest sentence names
      // the classification debt, not a seed stamp with nothing behind it.
      lints.push(Object.keys(cfg.tiers[id]?.models ?? {}).length > 0
        ? `${id}: no model-list surface — seeds stamped ${SEED_STAMPED}; verify manually`
        : `${id}: no model-list surface and no configured models — classify per benchmark policy to open channels`);
      continue;
    }
    const h = health[id];
    const detected = h?.models ?? []; // MANDATORY default: pre-v1.5 files lack a populated models array
    if (detected.length === 0) {
      if (h?.installed) lints.push(`${id}: no detection data — run tickmarkr doctor`);
      continue; // no data to diff or age
    }
    const configured = Object.keys(cfg.tiers[id]?.models ?? {});
    for (const model of configured) {
      if (!detected.includes(model)) {
        lints.push(`${id}: tiers lists ${model} — CLI no longer reports it; tombstone it (${model}: null overlay) or verify the id`);
      }
    }
    const extra = detected.filter((m) => !configured.includes(m) && !LINT_VARIANT_RE.test(m));
    if (extra.length) {
      const shown = extra.slice(0, cap).join(", ");
      const tail = extra.length > cap ? `, +${extra.length - cap} more${doctorRef}` : "";
      lints.push(`${id}: reports ${extra.length} model(s) not in tiers (${shown}${tail}) — classify before routing (benchmark policy)`);
    }
    const at = h?.modelsDetectedAt;
    if (at) {
      const days = Math.floor((Date.now() - Date.parse(at)) / DAY_MS); // completed days — never overstate age
      if (days >= MODEL_STALE_DAYS) lints.push(`${id}: model knowledge is ${days} days old — rerun tickmarkr doctor`);
    }
  }
  // v1.34 T3 byte-pins non-TTY doctor output. Doctor consumers are the ones that provide stateDir;
  // keep that machine-facing compatibility surface stable while plan and direct lint callers state
  // the current declared-preference mechanism truthfully.
  const seedDisposition = opts?.stateDir !== undefined && opts.tty !== true
    ? LEGACY_DOCTOR_SEED_PREFER_DISPOSITION
    : DECLARED_SEED_PREFER_DISPOSITION;
  lints.push(...collectSeedPreferLints(cfg, health, adapters, opts?.overlayPreferShapes ?? new Set(), seedDisposition));
  lints.push(...deadPoolLints(cfg, health, adapters));
  return lints;
}

// T2/T6: one lint per exclusion, naming the probe reason and date. TTY truncates reasons to 60 chars and
// points at doctor.json for the full text; non-TTY is byte-identical to the pre-T6 registry helper.
export function formatModelAuthLine(
  excluded: { key: string; reason: string; probedAt: string }[],
  tty?: boolean,
  stateDir: string = DEFAULT_STATE_DIR,
): string {
  const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
  const parts = excluded.map(({ key, reason, probedAt }) => {
    const r = tty ? trunc(reason, 60) : reason;
    return `${key} (${r} — probed ${probedAt.split("T")[0]})`;
  });
  const base = `model auth: ${excluded.length} channel(s) unauthed — ${parts.join(", ")}`;
  return tty ? `${base}${doctorJsonRef(stateDir)}` : base;
}

// MODEL-05/06: render detected-vs-configured drift as a paste-ready config.yaml fragment. Locked v1.5
// decision: detection is strictly advisory — doctor prints, a human pastes; NO --write/--apply exists.
// Additions render WHOLE-LINE-COMMENTED with a `???` tier placeholder (a tier is a benchmark claim; the
// machine never fabricates one — auto-tiering reopens the NaN-routing class). Removals render as LIVE
// `<id>: null` tombstones (deepMerge deletes the key). Pure function: no fs, no routing contact.
// Returns "" when no adapter has a delta. Mirrors modelLints' per-adapter guards exactly.
export function suggestOverlay(
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  adapters: WorkerAdapter[],
  stateDir: string = DEFAULT_STATE_DIR,
  opts: {
    catalog?: CatalogReadResult;
    resolvedModel?: (adapter: string, model: string) => string | undefined;
  } = {},
): string {
  // Pass 1 — decide WHAT each adapter drifts by. Pass 2 renders, after every addition this call
  // will print has joined one ranking universe: a fleet-relative band must not depend on which
  // adapter happened to be iterated first.
  const drifts = adapters.flatMap((adapter) => {
    const id = adapter.id;
    if (!adapter.listModels) return [];      // no list surface → nothing to diff (mirror modelLints)
    const h = health[id];
    const detected = h?.models ?? [];
    if (detected.length === 0) return [];    // no detection data → don't guess a delta
    const configured = Object.keys(cfg.tiers[id]?.models ?? {});
    // Tombstones: configured ids the CLI no longer reports. Ids are operator-authored (from cfg) → MODEL_ID_RE only.
    const tombstones = configured.filter((model) => !detected.includes(model) && MODEL_ID_RE.test(model));
    // Additions: detected ids not in cfg. WHOLE line commented, no tier (MODEL-06). Ids come from an external
    // CLI → MODEL_ID_RE (defense-in-depth, T-21-01) + the variant filter (cursor's ~193 parameterized ids).
    // RELATIONAL gate (no capability judgment — "looks like an embedding model" is auto-tiering's cousin, the
    // NaN-routing class the v1.5 decision forbids): a detected id is suggested iff it shares a provider prefix
    // (clause a) OR a canonical segment (clause b, the RENAME case: opencode/glm-5.2 ⇒ zai-coding-plan/glm-5.2)
    // with some configured id. Everything else collapses into ONE counted summary — never dropped silently.
    // NB: the bare "" prefix is a real match key on purpose. codex's whole namespace is unprefixed
    // (gpt-5.6-sol, gpt-5.5), so "" is how a detected gpt-5.7-nova surfaces as an upgrade of a configured
    // gpt-5.6-sol — the MODEL-05 worked example. The cost is that an adapter with ONE bare configured id
    // (cursor's composer-2.5) admits every unprefixed detected id; those collapse into the counted summary,
    // not silently. ponytail: not worth a per-adapter heuristic to quiet cursor at the price of codex signal.
    const cfgPrefixes = new Set(configured.map(providerPrefix));
    const cfgCanon = new Set(configured.map(canonical));
    const additions: string[] = [];
    let omitted = 0;
    for (const model of detected) {
      if (configured.includes(model) || !MODEL_ID_RE.test(model) || LINT_VARIANT_RE.test(model)) continue;
      if (configured.length > 0 && !cfgPrefixes.has(providerPrefix(model)) && !cfgCanon.has(canonical(model))) {
        omitted++;
        continue;
      }
      additions.push(model);
    }
    return [{ id, date: h?.modelsDetectedAt?.split("T")[0], tombstones, additions, omitted }]; // date: best-effort day stamp
  });
  const ranking = opts.catalog
    ? catalogTierRanking(cfg, opts.catalog, drifts.flatMap(({ id, additions }) =>
      additions.map((model) => ({ adapter: id, model, resolvedModel: opts.resolvedModel?.(id, model) }))), opts.resolvedModel)
    : [];

  const blocks: string[] = [];
  for (const { id, date, tombstones, additions, omitted } of drifts) {
    const detNote = date ? ` (detected ${date})` : "";
    const lines: string[] = [];
    for (const model of tombstones) {
      lines.push(`      ${model}: null   # tombstone: ${id} no longer reports this id${detNote}${referenceWarning(cfg, id, model)}`);
    }
    for (const model of additions) {
      const advisory = opts.catalog
        ? catalogModelAdvisory(cfg, opts.catalog, id, model, opts.resolvedModel?.(id, model), ranking)
        : undefined;
      const guidance = advisory?.suggestion
        ? `provenance note (operator confirmation required): ${advisory.suggestion.provenanceNote}; choose a tier, then uncomment`
        : `classify per benchmark policy (AA Index + SWE-bench Pro, dated), then uncomment${advisory ? ` — ${advisory.display}` : ""}`;
      lines.push(`      # ${model}: ???   #${date ? ` detected ${date} —` : ""} ${guidance}`);
    }
    if (omitted) lines.push(`      # (+${omitted} other detected id${omitted === 1 ? "" : "s"} not related to your configured models — see ${stateDir}/doctor.json)`);
    if (lines.length) blocks.push(`  ${id}:\n    models:\n${lines.join("\n")}`);
  }
  if (blocks.length === 0) return "";
  return `# paste into ${stateDir}/config.yaml — tickmarkr prints this, it never applies it\ntiers:\n${blocks.join("\n")}\n`;
}

// Purely relational id split for the addition gate (see suggestOverlay). Local, not exported: this is NOT a
// global identity concept — src/gates/review.ts has its own local modelId(), deliberately not shared.
// providerPrefix("zai/glm-5.2") === "zai"; providerPrefix("gpt-5.5") === "" (bare ids share the "" prefix).
const providerPrefix = (id: string): string => { const i = id.lastIndexOf("/"); return i < 0 ? "" : id.slice(0, i); };
// canonical("zai-coding-plan/glm-5.2") === "glm-5.2" — the rename-detecting segment.
const canonical = (id: string): string => { const i = id.lastIndexOf("/"); return i < 0 ? id : id.slice(i + 1); };

// A tombstoned id that a routing.map pin / judge / consult still names (on the same adapter) would leave a
// dangling reference — surface it inline so the operator remaps before deleting the seed.
function referenceWarning(cfg: TickmarkrConfig, adapterId: string, model: string): string {
  const refs: string[] = [];
  for (const [shape, entry] of Object.entries(cfg.routing.map)) {
    if (entry.pin?.via === adapterId && entry.pin.model === model) refs.push(`routing.map.${shape}.pin`);
  }
  if (cfg.judge.adapter === adapterId && cfg.judge.model === model) refs.push("judge");
  if (cfg.consult.adapter === adapterId && cfg.consult.model === model) refs.push("consult");
  return refs.length ? `  # WARNING: still referenced by ${refs.join(", ")} — remap before removing` : "";
}

/** Unclassified models surfaced for fleet screen 2 (doctor matrix math, no tier fabrication). */
export function fleetUnclassifiedModels(
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  adapters: WorkerAdapter[],
): { adapter: string; model: string; detectedAt?: string }[] {
  const out: { adapter: string; model: string; detectedAt?: string }[] = [];
  for (const adapter of adapters) {
    const id = adapter.id;
    const h = health[id];
    if (!h?.installed) continue;
    const detected = h?.models ?? [];
    if (!detected.length) continue;
    const configured = new Set(Object.keys(cfg.tiers[id]?.models ?? {}));
    const date = h?.modelsDetectedAt?.split("T")[0];
    for (const model of detected) {
      if (configured.has(model) || LINT_VARIANT_RE.test(model)) continue;
      out.push({ adapter: id, model, detectedAt: date });
    }
  }
  return out;
}
