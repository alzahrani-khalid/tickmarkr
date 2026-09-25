import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters, discoverChannels, doctorAgeMs, initDoctorReuse, modelAuthExclusions, PREFERENCE_ROLES } from "../../adapters/registry.js";
import { catalogModelAdvisory, catalogTierRanking, declaredModelWindow, fleetUnclassifiedModels } from "../../adapters/model-lints.js";
import { CATALOG_REFRESH_TIMEOUT_MS, formatCatalogRefreshLegs, type CatalogFetcher, type CatalogModelEvidence, type CatalogReadResult, readCachedCatalog, refreshCatalogCommand } from "../../adapters/catalog-remote.js";
import { CLAUDE_ALIAS_IDENTITY_STAMPS, type ClaudeAlias, readClaudeAliasIdentity } from "../../adapters/claude-code.js";
import type { BillingChannel, WorkerAdapter } from "../../adapters/types.js";
import {
  fleetEditableFromConfig,
  fleetEditableEquals,
  formatFleetPrint,
  globalConfigDir,
  DENY_SCOPES,
  initialDenyPropOf,
  loadConfigWithMode,
  overlayBytesLoadError,
  readOverlayFile,
  stagedDenyKeyOf,
  renderFleetOverlayWrite,
  repoOverlayPath,
  ROUTING_MODES,
  TIER_RANK,
  type FleetOverlayWrite,
  type FleetEditable,
  type MapEntry,
  type RoutingMode,
  type Tier,
  type TickmarkrConfig,
  unifiedYamlDiff,
} from "../../config/config.js";
import { exclusionReason, projectFleetWhy, renderFleetWhy, type FleetWhyValue } from "../../config/fleet-why.js";
import { SHAPES, TIERS, type Shape, type Task } from "../../graph/schema.js";
import { doctor } from "./doctor.js";
import { candidateRow, costSignal, shapeCandidates } from "./fleet-picker.js";
import { route } from "../../route/router.js";
import { pickRole } from "../../route/role-pick.js";
import { denyPreferCollisionLine, denyPreferCollisions, disallowedBy, entryMatchesChannel, exclusionCollector } from "../../route/preference.js";
import { resolveRunMode, type ResolvedRunMode } from "../../run/daemon.js";
import { loadRoutingProfile } from "../../run/journal.js";
// type-only: the Ink module must never load on the print path (nor before the TTY/FORCE_COLOR fixture)
import type {
  FleetEditorResult,
  FleetEditorState,
  FleetModelEvidence,
  FleetOverlayReview,
  FleetStagedDeny,
  FleetSteeringKey,
} from "../../tui/ink/fleet-app.js";

type FleetEditorProps = Parameters<typeof import("../../tui/ink/fleet-app.js").runFleetInkEditor>[0];

const initialFetch = globalThis.fetch;
const NON_TTY_MSG = "tickmarkr fleet: interactive fleet editor requires a TTY — use `tickmarkr fleet --print` for non-interactive output";
const QUIT = "fleet: quit without writing";

export type FleetInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  pause: () => unknown;
  resume: () => unknown;
};
export type FleetOutput = { isTTY?: boolean; write: (chunk: string) => unknown };
export type FleetIO = {
  input?: FleetInput;
  output?: FleetOutput;
  debug?: boolean;
  reloadGuard?: (bytes: string) => string | null;
  catalogFetcher?: CatalogFetcher;
  catalogNow?: () => Date;
};

// v1.60 T3: every preview surface ranks with the SAME exploration setting as the candidate picker
// (rankCandidates routes noExplore so repeated calls agree) — a due probe must never make a
// step-4/5 row disagree with the picker's rank-1 for the same shape and channel set.
const PREVIEW_EXPLORE = { noExplore: true } as const;

function previewTask(shape: Shape): Task {
  return {
    id: "fleet-preview",
    title: "fleet preview",
    goal: "preview",
    shape,
    complexity: 3,
    acceptance: ["done"],
    deps: [],
    files: [],
    context: [],
    gates: ["build", "test", "lint", "evidence", "scope", "acceptance", "review"],
    humanGate: false,
    status: "pending",
    evidence: { commits: [], artifacts: [], gateResults: [] },
  };
}

function currentRepoOverlayText(repoRoot: string): string {
  const p = repoOverlayPath(repoRoot);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

export type FleetWriteHooks = {
  readPrior?: (path: string) => string;
  beforeRename?: () => void;
};

/** Atomic sibling-temp writer. Reading and serializing happen before `${path}.tmp` exists, and
 * any pre-rename interruption unlinks only that exact candidate while the original remains intact. */
export function writeFleetOverlay(
  path: string,
  serialize: (priorBytes: string) => string,
  hooks: FleetWriteHooks = {},
): void {
  const prior = hooks.readPrior
    ? hooks.readPrior(path)
    : (existsSync(path) ? readFileSync(path, "utf8") : "");
  const bytes = serialize(prior);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    hooks.beforeRename?.();
    renameSync(tmp, path);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Preserve the write failure; cleanup is constrained to the exact sibling candidate.
    }
    throw error;
  }
}

function formatFleetSteering(cfg: ResolvedRunMode["cfg"]): string {
  const blocks: string[] = [];
  if (cfg.review.prefer?.length) blocks.push(`review:\n  prefer: ${JSON.stringify(cfg.review.prefer)}`);
  if (cfg.consult.prefer?.length) blocks.push(`consult:\n  prefer: ${JSON.stringify(cfg.consult.prefer)}`);
  return blocks.length ? `${blocks.join("\n")}\n` : "";
}

// v1.51 T4: one gloss per routing mode on the fleet mode screen — mirrors the preset compiler.
const MODE_GLOSS: Record<RoutingMode, string> = {
  "partner-led": "every shape frontier · explore off",
  "risk-based": "risk-tiered default floors",
  "staff-led": "implement/refactor one band down · integrity shapes hold frontier",
};

export async function fleet(
  argv: string[],
  cwd = process.cwd(),
  adapters: WorkerAdapter[] = allAdapters(),
  io: FleetIO = {},
): Promise<string | { out: string; code: number }> {
  const { values } = parseArgs({
    args: argv,
    options: {
      pick: { type: "string" },
      "exclude-vendor": { type: "string", multiple: true },
      print: { type: "boolean" },
      why: { type: "boolean" },
      "global-dir": { type: "string" },
      fresh: { type: "boolean" },
    },
  });
  const globalDir = values["global-dir"] ?? globalConfigDir();
  if (values.pick !== undefined) {
    const role = PREFERENCE_ROLES.find((role) => role === values.pick);
    const refuse = (reason: string) => ({ out: `tickmarkr fleet --pick ${values.pick}: ${reason}`, code: 1 });
    if (!role) return refuse("unsupported-role — expected worker, judge, review or consult; no role prefer resolved");
    if (values.print || values.why || values.fresh) return refuse("incompatible options — --pick cannot use --print, --why or --fresh");
    const { cfg } = resolveRunMode(cwd, { globalDir });
    const { reuse, health } = initDoctorReuse(cwd, false);
    const selection = pickRole(role, cfg, adapters, reuse && health ? health : {}, {
      excludeVendors: new Set(values["exclude-vendor"] ?? []),
    });
    if (!selection.ok) {
      return refuse(selection.reason === "missing-prefer" ? `${role}.prefer: missing-prefer`
        : !reuse || !health ? `${role}.prefer: probe data missing or stale — run tickmarkr doctor first`
        : `${role}.prefer: ${selection.reason}`);
    }
    const { adapter, model, vendor, channel } = selection.channel;
    return JSON.stringify({ role, adapter, model, vendor, channel });
  }
  if (values["exclude-vendor"]?.length) return { out: "tickmarkr fleet: --exclude-vendor requires --pick <role>", code: 1 };
  const print = values.print ?? false;
  const why = values.why ?? false;
  const input = io.input ?? (process.stdin as FleetInput);
  const output = io.output ?? (process.stdout as FleetOutput);
  const interactive = input.isTTY === true && output.isTTY === true;
  let catalog = readCachedCatalog(cwd, { now: io.catalogNow });
  let refreshReason = "";
  let catalogRefreshAttempted = false;
  const catalogRefreshAllowed = process.env.VITEST !== "true"
    || io.catalogFetcher !== undefined
    || io.catalogNow !== undefined
    || globalThis.fetch !== initialFetch;
  if (catalog.stale && catalogRefreshAllowed) {
    const refreshed = await refreshCatalogCommand({
      repoRoot: cwd,
      fetcher: io.catalogFetcher,
      timeoutMs: CATALOG_REFRESH_TIMEOUT_MS,
      now: io.catalogNow,
    });
    catalogRefreshAttempted = true;
    catalog = refreshed.catalog;
    refreshReason = `fleet: catalog auto-refresh — ${formatCatalogRefreshLegs(refreshed.legs)}`;
  }

  if (print) {
    // v1.51 T4: the print surface names the mode and its source layer right under the header —
    // comment-prefixed so the YAML body stays machine-parseable and regex-stable.
    const rm = resolveRunMode(cwd, { globalDir });
    const body = formatFleetPrint(cwd, { globalDir });
    const nl = body.indexOf("\n");
    // Steering comes from the same resolved config snapshot the editor consumes below,
    // not from another parse of either raw overlay.
    return `${body.slice(0, nl)}\n# mode: ${rm.mode.mode} (${rm.source})${refreshReason ? `\n# ${refreshReason}` : ""}${body.slice(nl)}${formatFleetSteering(rm.cfg)}`;
  }

  if (!why && !interactive) return { out: `${refreshReason ? `${refreshReason}\n` : ""}${NON_TTY_MSG}`, code: 1 };

  // OBS-528: `--fresh` parsed since v1.92 but nothing ever RAN the probe — it forced the reuse
  // gate false and guaranteed the "probe data missing or stale" refusal. The law stands — the
  // EDITOR never probes (previews stay cache-only, `r` still exits to the operator) — but the
  // command may run the sensor up front, exactly like init's act 2: a stale cache (or --fresh)
  // probes first, visibly, then the editor assembles from what the probe just recorded.
  if (!why && interactive) {
    const { reuse } = initDoctorReuse(cwd, values.fresh ?? false);
    if (!reuse) {
      output.write(`${await doctor([], cwd, adapters, { banner: false, compact: true, ...(catalogRefreshAttempted ? { catalog } : {}), catalogFetcher: io.catalogFetcher, catalogNow: io.catalogNow })}\n`);
    }
  }

  const assembled = await assembleFleetEditor(cwd, adapters, io, { globalDir, catalog });
  if ("unavailable" in assembled) return { out: `${refreshReason ? `${refreshReason}\n` : ""}${assembled.unavailable}`, code: 1 };
  if (why) return `${refreshReason ? `${refreshReason}\n` : ""}${assembled.renderWhy()}`;

  // Keep Ink out of print, non-TTY, and missing-probe paths: the component runtime belongs
  // exclusively to the interactive editor. The capture window brackets only the dynamic Ink
  // import — keys typed while the module loads land in props.initialInput, never get dropped.
  const initialInput: string[] = [];
  const productionInput = input as FleetInput & Partial<Pick<NodeJS.ReadStream, "ref" | "unref">>;
  const captureStartupInput = typeof productionInput.ref === "function"
    && typeof productionInput.unref === "function";
  const onStartupInput = (chunk: string | Buffer) => {
    initialInput.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  };
  if (captureStartupInput) {
    input.on("data", onStartupInput);
    input.resume();
  }
  let runFleetInkEditor: typeof import("../../tui/ink/fleet-app.js").runFleetInkEditor;
  try {
    ({ runFleetInkEditor } = await import("../../tui/ink/fleet-app.js"));
  } catch (error) {
    if (captureStartupInput) {
      input.off("data", onStartupInput);
      input.pause();
    }
    throw error;
  }
  if (captureStartupInput) {
    input.off("data", onStartupInput);
    input.pause();
  }
  assembled.props.initialInput = initialInput;
  const result = await runFleetInkEditor(assembled.props);
  return `${refreshReason ? `${refreshReason}\n` : ""}${assembled.commit(result)}`;
}

/** Everything between the doctor-reuse gate and the Ink render, packaged for reuse: `tickmarkr init`
 * runs the same editor (entry="presets": Esc is HOME to the preset overlay, never a bare quit)
 * without re-owning the assembly or the write funnel. `commit` remains the single config actuator —
 * it maps editor results to the command's exact result strings and performs the one guarded
 * overlay write. */
export async function assembleFleetEditor(
  cwd: string,
  adapters: WorkerAdapter[],
  io: FleetIO,
  opts: { globalDir: string; entry?: "presets" | "probe"; catalog?: CatalogReadResult },
): Promise<
  | {
    props: FleetEditorProps;
    commit: (result: FleetEditorResult) => string;
    renderWhy: () => string;
  }
  | { unavailable: string }
> {
  const globalDir = opts.globalDir;
  const { reuse, health: cached } = initDoctorReuse(cwd, false);
  if (!reuse || !cached) {
    return {
      unavailable: "tickmarkr fleet: probe data missing or stale — run `tickmarkr doctor` first, or `tickmarkr fleet` interactively (it runs the probe itself when the cache is stale; --fresh forces one)",
    };
  }

  const rm = resolveRunMode(cwd, { globalDir });
  const cfg = rm.cfg;
  const health = cached;
  // v1.92: the discovered fleet universe — every channel the adapters actually SERVE, discovered
  // blind to both membership scopes (deny and allow). Membership is an allow-complement, which is
  // only computable against the served universe: cfg.tiers alone would drop served-but-unclassified
  // channels (adapter-declared extras) out of the fleet the moment any exclusion is staged.
  // fleetEditableFromConfig folds routing.allow into the editor's exclusion sets with it, and the
  // writer emits the minimal allow form from it. The same pool later ranks every preview.
  const { deny: _diskDeny, allow: _diskAllow, ...routingScopeBlind } = cfg.routing;
  const previewChannels = discoverChannels({ ...cfg, routing: routingScopeBlind }, adapters, health);
  const universe = adapters
    .filter((adapter) => health[adapter.id]?.installed)
    .map((adapter) => {
      const served = previewChannels.filter((c) => c.adapter === adapter.id);
      // LEG2-T3 round 2 finding 3: the recorded identity per channel, so the editable membership
      // matches allow/deny entries with the same authority the collector and the browser use
      const identities = Object.fromEntries(served.flatMap((c) => (c.identity ? [[c.model, c.identity]] : [])));
      return {
        adapter: adapter.id,
        models: [...new Set(served.map((c) => c.model))],
        ...(Object.keys(identities).length ? { identities } : {}),
      };
    });
  const initial = fleetEditableFromConfig(cfg, universe);
  const editable = structuredClone(initial) as FleetEditable;
  // OBS-508: the same catalog evidence doctor's drift overlay prints now rides each unclassified
  // row — it prefills the classify flow and feeds the bulk `s` stage. Suggestions stay advisory:
  // only the review-diff confirm writes, so "tickmarkr never applies" holds with less typing.
  const catalog = opts.catalog ?? readCachedCatalog(cwd);
  // The same alias→identity resolution doctor hands its advisory rows: models.dev has never heard of
  // `opus`, so without it the fleet's own frontier models drop out of the universe they are supposed
  // to anchor and fleet bands a different set than doctor for one fleet. The stored identity wins;
  // the stamped one backs it up. No probe — fleet never re-probes, doctor is the sensor (and doctor
  // is the seat that lints a stamp the live identity has drifted away from).
  const resolvedCatalogModel = (adapter: string, model: string): string | undefined =>
    adapter !== "claude-code" || !(model in CLAUDE_ALIAS_IDENTITY_STAMPS)
      ? undefined
      : readClaudeAliasIdentity(cwd, model as ClaudeAlias) ?? CLAUDE_ALIAS_IDENTITY_STAMPS[model as ClaudeAlias];
  // One ranking universe for the whole screen: every unclassified row bands fleet-relatively
  // against the same set, so a suggestion never depends on which adapter group renders first.
  const detectedRows = fleetUnclassifiedModels(cfg, health, adapters)
    .map((row) => ({ ...row, resolvedModel: resolvedCatalogModel(row.adapter, row.model) }));
  const catalogRanking = catalogTierRanking(cfg, catalog, detectedRows, resolvedCatalogModel);
  const foldedRows: Array<(typeof detectedRows)[number] & {
    advisory: ReturnType<typeof catalogModelAdvisory>;
    score?: number;
    foldedModels?: string[];
  }> = [];
  const folds = new Map<string, (typeof foldedRows)[number]>();
  for (const row of detectedRows) {
    const advisory = catalogModelAdvisory(cfg, catalog, row.adapter, row.model, row.resolvedModel, catalogRanking);
    const evidence = advisory.coverage === "covered" ? advisory.evidence : undefined;
    const score = evidence?.agenticCodingScore ?? evidence?.intelligenceIndex ?? evidence?.codingScore;
    const next = { ...row, advisory, ...(score !== undefined ? { score } : {}) };
    const foldKey = evidence ? `${row.adapter}:${evidence.catalogId}` : undefined;
    const first = foldKey ? folds.get(foldKey) : undefined;
    if (first) {
      first.foldedModels ??= [first.model];
      first.foldedModels.push(row.model);
    } else {
      foldedRows.push(next);
      if (foldKey) folds.set(foldKey, next);
    }
  }
  const unclassifiedRows = foldedRows.sort((a, b) =>
    Number(!!b.advisory.suggestion) - Number(!!a.advisory.suggestion)
      || (b.detectedAt ?? "").localeCompare(a.detectedAt ?? "")
      || (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY)
      || a.model.localeCompare(b.model));
  // OBS-508 follow-through: the browser renders the metadata the assembler always had — catalog
  // ctx/price evidence and doctor's model-probe wall clock — as columns instead of dropping them.
  // OBS-972/FL-1: the same alias→identity doctor recorded (modelAuth.identity, falling back to
  // the coarser per-adapter modelIdentities map registry.ts/preference.ts already read for
  // routing exclusion) — a floating alias's resolved concrete model id.
  const resolvedModelIdentity = (adapter: string, model: string): string | undefined =>
    health[adapter]?.modelAuth?.[model]?.identity ?? health[adapter]?.modelIdentities?.[model];
  const rowEvidence = (adapter: string, model: string, evidence?: CatalogModelEvidence): FleetModelEvidence | undefined => {
    const probed = health[adapter]?.modelAuth?.[model] as { durationMs?: number; authed?: boolean; reason?: string } | undefined;
    const contextWindow = evidence?.contextWindow ?? declaredModelWindow(cfg, adapter, model);
    const identity = resolvedModelIdentity(adapter, model);
    const out: FleetModelEvidence = {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(evidence?.outputWindow !== undefined ? { outputWindow: evidence.outputWindow } : {}),
      ...(evidence?.inputCostPerMtok !== undefined ? { inputCostPerMtok: evidence.inputCostPerMtok } : {}),
      ...(evidence?.outputCostPerMtok !== undefined ? { outputCostPerMtok: evidence.outputCostPerMtok } : {}),
      ...(probed?.durationMs !== undefined ? { probeMs: probed.durationMs } : {}),
      // OBS-519: doctor already recorded the failed verdict — a rate-limited/unauthed model must
      // not render identically to a healthy row on the surface that edits its fleet membership.
      ...(probed?.authed === false ? { unauthed: probed.reason ?? "probe failed" } : {}),
      // the browser decides deny coverage itself, over the STAGED policy (LEG2-T3 finding 1)
      ...(identity !== undefined ? { identity } : {}),
    };
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const modelGroups = adapters
    .filter((adapter) => health[adapter.id]?.installed)
    .map((adapter) => {
      const unclassified = unclassifiedRows.filter((row) => row.adapter === adapter.id);
      return {
        adapter: adapter.id,
        channel: cfg.tiers[adapter.id]?.channel,
        rows: [
          ...Object.entries(editable.tiers[adapter.id] ?? {}).map(([model, value]) => {
            const advisory = catalogModelAdvisory(cfg, catalog, adapter.id, model, resolvedCatalogModel(adapter.id, model), catalogRanking);
            const evidence = rowEvidence(adapter.id, model, advisory.coverage === "covered" ? advisory.evidence : undefined);
            return { model, tier: value?.tier, ...(evidence ? { evidence } : {}) };
          }),
          ...unclassified
            .filter((row) => !editable.tiers[adapter.id]?.[row.model])
            .map((row) => {
              const evidence = rowEvidence(adapter.id, row.classifyModel ?? row.model,
                row.advisory.coverage === "covered" ? row.advisory.evidence : undefined);
              return {
                model: row.model,
                detectedAt: row.detectedAt,
                ...(row.classifyModel ? { classifyModel: row.classifyModel } : {}),
                ...(row.variants ? { variants: row.variants } : {}),
                ...(row.foldedModels ? { foldedModels: row.foldedModels } : {}),
                ...(row.score !== undefined ? { score: row.score } : {}),
                ...(evidence ? { evidence } : {}),
                ...(row.advisory.suggestion
                  ? { suggestion: { tier: row.advisory.suggestion.tier, note: row.advisory.suggestion.provenanceNote } }
                  : {}),
              };
            }),
        ],
      };
    });
  // Steps 4–5 remain surfaces over production routing. Ink owns interaction and rendering;
  // these callbacks retain the existing router, preset compiler, and candidate-ranker seams.
  const modeCfgs = Object.fromEntries(
    ROUTING_MODES.map((mode) => [
      mode,
      mode === rm.mode.mode ? rm : resolveRunMode(cwd, { flag: mode, globalDir }),
    ]),
  ) as Record<RoutingMode, ResolvedRunMode>;
  const channels = discoverChannels(cfg, adapters, health);
  const profile = loadRoutingProfile(cwd, cfg, { preview: true });
  // Preview surfaces rank against the STAGED membership state: previewChannels (above) is blind to
  // both disk scopes and previewCfg carries the session's sets, so a model toggled out this session
  // leaves the picker immediately and one toggled back in reappears without a relaunch (both
  // directions exact — the on-disk scopes would otherwise pre-filter the pool at startup and lie
  // until restart).
  // OBS-1099 add.1: the staged deny lists travel one per schema-enumerated scope, never four hand fields
  type StagedDeny = FleetStagedDeny;
  const stagedDenyOf = (editable: FleetEditable): StagedDeny =>
    Object.fromEntries(DENY_SCOPES.map((scope) => [stagedDenyKeyOf(scope), editable[scope.key] ?? []])) as StagedDeny;
  const stagedEditable = (map: Record<string, MapEntry>, deny: StagedDeny): FleetEditable => ({
    ...structuredClone(initial),
    ...Object.fromEntries(DENY_SCOPES.map((scope) => [scope.key, deny[stagedDenyKeyOf(scope)]])),
    // OBS-1046: the allow complement is staged beside the deny lists, never folded into them
    allowOut: deny.allowOut ?? initial.allowOut,
    map,
  });
  // LEG2-T3 finding 2: a preview is the config loader over the candidate bytes the writer would
  // produce — never a second in-memory merge of the staged sets over the resolved config, which
  // kept every on-disk scope the staged edit tombstones (a removed workers deny survived here).
  // Judge c2 (R107): candidate bytes the writer cannot render or the loader refuses are an
  // explicit invalid-preview state carrying the refusal — never another config shown in their place.
  // ponytail: bounded memo, previews re-render per key press; a tiny LRU if it ever churns.
  type CandidatePreview = { ok: true; cfg: TickmarkrConfig } | { ok: false; error: string };
  const candidateMemo = new Map<string, CandidatePreview>();
  const previewCfg = (mode: RoutingMode, map: Record<string, MapEntry>, deny: StagedDeny): CandidatePreview => {
    const key = JSON.stringify([mode, map, deny]);
    const hit = candidateMemo.get(key);
    if (hit) return hit;
    let preview: CandidatePreview;
    try {
      const bytes = renderFleetOverlayWrite(currentRepoOverlayText(cwd), {
        initial,
        edited: stagedEditable(map, deny),
        universe,
        ...(mode !== rm.mode.mode ? { mode } : {}),
      });
      preview = { ok: true, cfg: loadConfigWithMode(cwd, { globalDir, repoOverlayText: bytes }).cfg };
    } catch (error) {
      preview = { ok: false, error: (error as Error).message.replace(/\s+/g, " ").trim() };
    }
    if (candidateMemo.size > 32) candidateMemo.clear();
    candidateMemo.set(key, preview);
    return preview;
  };
  const previewUnavailable = (error: string) =>
    `preview unavailable (${error}) — the staged overlay does not load, so w would be refused`;
  const stagedRouting = (deny: StagedDeny): { ok: true; routing: TickmarkrConfig["routing"] } | { ok: false; error: string } => {
    const preview = previewCfg(rm.mode.mode, editable.map, deny);
    return preview.ok ? { ok: true, routing: preview.cfg.routing } : preview;
  };
  // route() never deny-filters its pool — that contract lives in discoverChannels — so every
  // preview call rebuilds the pool the staged deny would discover
  const previewPool = (cfgPreview: TickmarkrConfig) =>
    previewChannels.filter((c) => disallowedBy(c, cfgPreview.routing) === null);
  const modeSpend = (mode: RoutingMode, map: Record<string, MapEntry>, deny: StagedDeny): string => {
    const tierCount: Partial<Record<Tier, number>> = {};
    let subs = 0;
    let apiN = 0;
    let apiUsd = 0;
    const preview = previewCfg(mode, map, deny);
    if (!preview.ok) return `  mix: ${previewUnavailable(preview.error)}`;
    const cfgPreview = preview.cfg;
    const pool = previewPool(cfgPreview);
    for (const shape of SHAPES) {
      try {
        const assignment = route(
          previewTask(shape),
          cfgPreview,
          pool,
          profile,
          undefined,
          undefined,
          PREVIEW_EXPLORE,
        ).assignment;
        tierCount[assignment.tier] = (tierCount[assignment.tier] ?? 0) + 1;
        if (assignment.channel === "sub") subs += 1;
        else {
          apiN += 1;
          apiUsd += cfg.pricing[assignment.tier] ?? 0;
        }
      } catch {
        // Unroutable under this mode's floors; the aggregate names it below.
      }
    }
    const mix = [...TIERS].reverse().flatMap((tier) =>
      tierCount[tier] ? [`${tierCount[tier]} ${tier}`] : []).join(" · ");
    const parts: string[] = [];
    if (subs) parts.push(`${subs === SHAPES.length ? "all" : subs} sub (flat-rate quota)`);
    if (apiN) parts.push(`${apiN} api · est. cost (API shapes only, rough): ~$${apiUsd.toFixed(2)}`);
    const unroutable = SHAPES.length - subs - apiN;
    if (unroutable) parts.push(`${unroutable} unroutable`);
    return `  mix: ${mix} — ${parts.join(" · ")}`;
  };
  const floorPreview = (mode: RoutingMode): string[] => {
    if (mode === rm.mode.mode) return [];
    const current = cfg.routing.floors;
    const next = modeCfgs[mode].cfg.routing.floors;
    const changed = SHAPES.filter((shape) => current[shape] !== next[shape]);
    return [
      `  floors vs ${rm.mode.mode}:`,
      ...(changed.length
        ? changed.map((shape) => `    ${shape}: ${current[shape]} → ${next[shape]}`)
        : ["    (no floor changes)"]),
    ];
  };
  const whyDeclaration = (
    shape: Shape,
    mode: RoutingMode,
    map: Record<string, MapEntry>,
    mapProducedValue: boolean,
  ): Pick<FleetWhyValue, "declaredAt" | "operatorPinned"> => {
    const mapChanged = JSON.stringify(map[shape] ?? {}) !== JSON.stringify(editable.map[shape] ?? {});
    if (mapProducedValue) {
      return mapChanged
        ? { operatorPinned: true }
        : { declaredAt: `routing.map.${shape}` };
    }

    const floorSource = modeCfgs[mode].mode.provenance[shape];
    if (floorSource === undefined) return {};
    if (floorSource === "config floors") return { declaredAt: `routing.floors.${shape}` };
    if (mode !== rm.mode.mode) return { operatorPinned: true };
    return rm.source === "default"
      ? { declaredAt: `routing.floors.${shape}` }
      : { declaredAt: "routing.mode" };
  };
  const projectedShapeRows = (mode: RoutingMode, map: Record<string, MapEntry>, deny: StagedDeny) => {
    const preview = previewCfg(mode, map, deny);
    if (!preview.ok) {
      return projectFleetWhy(SHAPES.map((shape) => ({
        id: shape,
        effective: previewUnavailable(preview.error),
        ...whyDeclaration(shape, mode, map, false),
      })), { repoRoot: cwd, globalDir });
    }
    const cfgPreview = preview.cfg;
    const pool = previewPool(cfgPreview);
    const values: FleetWhyValue<Shape>[] = SHAPES.map((shape) => {
      try {
        const routed = route(
          previewTask(shape),
          cfgPreview,
          pool,
          profile,
          undefined,
          undefined,
          PREVIEW_EXPLORE,
        );
        const assignment = routed.assignment;
        // OBS-531: a pooled shape used to render only the routed WINNER — indistinguishable from
        // a pin. The declaration is the operator's decision; the winner is today's dice.
        const declaredPool = map[shape]?.pool;
        const poolPrefix = declaredPool ? `pool(${declaredPool.mode}·${declaredPool.channels.length}) → ` : "";
        const effective = `${poolPrefix}${assignment.adapter}:${assignment.model} (${assignment.channel}, ${assignment.tier})  ${costSignal(assignment, cfg.pricing)}`;
        const mapProducedValue = map[shape]?.pin !== undefined || map[shape]?.pool !== undefined
          || routed.provenance.includes("via prefer");
        return {
          id: shape,
          effective,
          ...whyDeclaration(shape, mode, map, mapProducedValue),
        };
      } catch (error) {
        const mapProducedValue = map[shape]?.pin !== undefined || map[shape]?.pool !== undefined
          || (map[shape]?.prefer?.length ?? 0) > 0;
        return {
          id: shape,
          effective: (error as Error).message,
          ...whyDeclaration(shape, mode, map, mapProducedValue),
          setupCommand: "tickmarkr fleet",
        };
      }
    });
    return projectFleetWhy(values, { repoRoot: cwd, globalDir });
  };
  const routedShapeRows = (mode: RoutingMode, map: Record<string, MapEntry>, deny: StagedDeny) =>
    projectedShapeRows(mode, map, deny).map(({ id, label }) => ({ id, label }));
  // OBS-530: the picker silently omitted every excluded channel — the operator asked "why is X
  // missing" three times in one session and the answer lived only in config archaeology. One dim
  // line now names each bucket. Static buckets (unauthed, unclassified) computed once; the
  // staged-vs-disk split recomputed per open because it ranks against the SESSION's deny state.
  const unauthedClis = adapters
    .filter((adapter) => health[adapter.id]?.installed && health[adapter.id]?.authed === false)
    .map((adapter) => adapter.id);
  const unauthedModels = modelAuthExclusions(cfg, adapters, health);
  const unauthedModelCount = unauthedModels.length;
  const excludedNoteFor = (cfgPreview: TickmarkrConfig): string | undefined => {
    let stagedOut = 0;
    let denied = 0;
    for (const channel of previewChannels) {
      if (disallowedBy(channel, cfgPreview.routing) === null) continue;
      if (disallowedBy(channel, cfg.routing) === null) stagedOut += 1;
      else denied += 1;
    }
    const parts: string[] = [];
    if (stagedOut) parts.push(`${stagedOut} staged out this session`);
    if (denied) parts.push(`${denied} denied in config`);
    if (unauthedModelCount) parts.push(`${unauthedModelCount} unauthed`);
    if (unauthedClis.length) parts.push(`${unauthedClis.join("/")} CLI unauthed`);
    if (unclassifiedRows.length) parts.push(`${unclassifiedRows.length} unclassified (never routed)`);
    return parts.length ? `not offered: ${parts.join(" · ")} — the models view explains each row` : undefined;
  };
  // OBS-994/FL-1: the nine mechanisms outside the deny scopes that can keep a channel off a
  // shape's candidate list each get a reason or an explicit "not manageable here" caption — a
  // silent omission is indistinguishable from a bug (OBS-530's lesson, extended past deny/allow).
  // allow and the unauthed probe already carry a reason through excludedNoteFor above; the rest
  // are shape-scoped (a pin/pool/floor/prefer excludes only for THIS shape) and belong here.
  const shapeExclusionCaptions = (shape: Shape, map: Record<string, MapEntry>, cfgPreview: TickmarkrConfig): string[] => {
    const pool = previewPool(cfgPreview);
    const entry = map[shape];
    const captions: string[] = [];

    // 2. pin or pool — a closed candidate set declared for this shape; a channel outside it is
    // not manageable from the models view, it is a Shapes-view declaration.
    if (entry?.pin) {
      captions.push(`pin: routing.map.${shape}.pin fixes this shape to ${entry.pin.via}:${entry.pin.model} — not manageable here, edit it in Shapes`);
    } else if (entry?.pool) {
      const declared = new Set(entry.pool.channels);
      const outside = pool.filter((c) => !declared.has(`${c.adapter}:${c.model}`));
      if (outside.length) {
        captions.push(`pool: ${outside.length} channel(s) outside routing.map.${shape}.pool's declared set — not manageable here, edit it in Shapes`);
      }
    }

    // 3. floor — channels below this shape's minimum tier.
    const floor = cfgPreview.routing.floors[shape];
    if (floor) {
      const belowFloor = pool.filter((c) => TIER_RANK[c.tier] < TIER_RANK[floor]);
      if (belowFloor.length) {
        captions.push(`floor: ${belowFloor.length} channel(s) below routing.floors.${shape} (${floor}) — not manageable here, edit the floor in Shapes`);
      }
    }

    // 5. tombstones — the repo overlay's OWN null over this shape's map entry, masking a lower
    // (global/default) layer's declaration rather than expressing a value of its own.
    const repoRaw = readOverlayFile(repoOverlayPath(cwd)) as {
      routing?: { map?: Record<string, { pin?: unknown; pool?: unknown; prefer?: unknown } | null> };
    };
    const rawEntry = repoRaw.routing?.map?.[shape];
    if (rawEntry === null) {
      captions.push(`tombstone: routing.map.${shape}: null masks a lower layer's declaration — not manageable here, edit the repo overlay directly`);
    } else if (rawEntry && "pool" in rawEntry && rawEntry.pool === null) {
      captions.push(`tombstone: routing.map.${shape}.pool: null masks a lower layer's pool — not manageable here, edit the repo overlay directly`);
    } else if (rawEntry && "pin" in rawEntry && rawEntry.pin === null) {
      captions.push(`tombstone: routing.map.${shape}.pin: null masks a lower layer's pin — not manageable here, edit the repo overlay directly`);
    }

    // 6. explore/learned knobs — global routing settings, never a per-channel fleet toggle.
    if (cfgPreview.routing.explore?.mode === "off") {
      captions.push("explore: routing.explore.mode is off — a global knob, not manageable here");
    }
    if (cfgPreview.routing.learned === "off") {
      captions.push("learned: routing.learned is off — a global knob, not manageable here");
    }

    // 7. task hint — a shape's prefer bias is authored in Shapes/spec, not per-channel in fleet.
    if (entry?.prefer?.length) {
      captions.push(`task hint: routing.map.${shape}.prefer ranks ${entry.prefer.join(", ")} — not manageable here, edit it in Shapes`);
    }

    // 8. deny∩prefer collision — a standing lint on this shape's declaration, never a fleet toggle.
    for (const collision of denyPreferCollisions(cfgPreview, [shape])) {
      captions.push(denyPreferCollisionLine(collision));
    }

    // 9. first-match provenance — the per-channel ledger below lists EVERY collector scope.
    return captions;
  };
  // LEG2-T3 finding 1: each channel a mechanism touches on this shape gets its own ledger row
  // naming every reason — collector scopes with their config paths (allow, flat and workers deny,
  // all of them, never a first match), the unauthed probe, pin/pool/floor, the task hint and a
  // deny∩prefer collision it is the target of — or that leaves the shape with no candidate at all.
  const channelLedger = (
    shape: Shape,
    map: Record<string, MapEntry>,
    cfgPreview: TickmarkrConfig,
    offered: ReadonlySet<string>,
  ): string[] => {
    const entry = map[shape];
    const floor = cfgPreview.routing.floors[shape];
    const collisions = denyPreferCollisions(cfgPreview, [shape]);
    const discovered = new Set(previewChannels.map((c) => `${c.adapter}:${c.model}`));
    // T2 review (D-225): discovery already dropped a channel whose model probe failed — it is
    // rebuilt as a structured channel from its adapter's own declaration and walks the SAME
    // reach + collector path as every other row, the auth reason appended LAST; never a bare string
    const withIdentity = (adapter: string, declared: BillingChannel) => {
      const identity = health[adapter]?.modelAuth?.[declared.model]?.identity ?? health[adapter]?.modelIdentities?.[declared.model];
      return identity ? { ...declared, identity } : declared;
    };
    const failedProbes = unauthedModels.filter(({ key }) => !discovered.has(key)).flatMap(({ key, adapter, reason }) => {
      const declared = adapters.find((a) => a.id === adapter)?.channels(cfg).find((c) => `${c.adapter}:${c.model}` === key);
      return declared ? [{ ...withIdentity(adapter, declared), authReason: `unauthed (${reason}) — re-probe with tickmarkr doctor` }] : [];
    });
    // T2 review round 6: an installed-but-unauthed CLI is dropped by discovery AND by the model
    // probe list, so its configured channels are rebuilt from the adapter's own declaration too —
    // each greys with its reach and covering entry, the CLI auth reason last; never one bare adapter line
    const unauthedCliChannels = unauthedClis.flatMap((adapter) => (adapters.find((a) => a.id === adapter)?.channels(cfg) ?? [])
      .map((declared) => ({ ...withIdentity(adapter, declared), authReason: `${adapter} CLI unauthed — re-probe with tickmarkr doctor` })));
    // D-225: the ledger is the EXCLUDED half of a closed partition — a channel the picker offers
    // never greys beside itself; its pin/pool/floor/prefer captions stay in excludedNote
    const ledgerChannels = [...previewChannels.map((c) => ({ ...c, authReason: undefined as string | undefined })), ...failedProbes, ...unauthedCliChannels]
      .filter((c) => !offered.has(`${c.adapter}:${c.model}`));
    return ledgerChannels.flatMap((c) => {
      const key = `${c.adapter}:${c.model}`;
      const reasons = exclusionCollector(c, cfgPreview.routing, "worker").map(exclusionReason);
      // OBS-1065: a greyed picker row carries its reach beside its reasons, like the models view
      const allSeats = exclusionCollector(c, cfgPreview.routing, "judge");
      const reach = allSeats.some((scope) => scope.by === "deny") ? "out all"
        : allSeats.length ? "out allow" : reasons.length ? "out workers" : "in";
      if (!c.authReason && health[c.adapter]?.modelAuth?.[c.model]?.authed === false) reasons.push("unauthed — re-probe with tickmarkr doctor");
      if (entry?.pin && key !== `${entry.pin.via}:${entry.pin.model}`) {
        reasons.push(`not routing.map.${shape}.pin (${entry.pin.via}:${entry.pin.model}) — not manageable here`);
      }
      if (entry?.pool && !entry.pool.channels.includes(key)) {
        reasons.push(`outside routing.map.${shape}.pool — not manageable here`);
      }
      if (floor && TIER_RANK[c.tier] < TIER_RANK[floor]) {
        reasons.push(`below routing.floors.${shape} (${floor}) — not manageable here`);
      }
      if (entry?.prefer?.some((p) => entryMatchesChannel(p, c))) {
        reasons.push(`task hint: routing.map.${shape}.prefer names it — not manageable here`);
      }
      for (const collision of collisions) {
        const named = collision.detail.split(" > ").some((p) => entryMatchesChannel(p, c));
        if (named || offered.size === 0) reasons.push(denyPreferCollisionLine(collision));
      }
      if (c.authReason) reasons.push(c.authReason);
      // labelled like the models view's row (adapter/model), so a ledger row never reads as a candidate
      return reasons.length ? [`${c.adapter}/${c.model} — reach: ${reach} — ${reasons.join("; ")}`] : [];
    });
  };
  const candidatesForShape = (shape: Shape, mode: RoutingMode, map: Record<string, MapEntry>, deny: StagedDeny) => {
    const preview = previewCfg(mode, map, deny);
    if (!preview.ok) return { rows: [], excludedNote: previewUnavailable(preview.error) };
    const cfgPreview = preview.cfg;
    const rows = shapeCandidates(previewTask(shape), cfgPreview, previewPool(cfgPreview), profile).map((candidate) => ({
      id: `${candidate.assignment.adapter}:${candidate.assignment.model}`,
      label: candidateRow(candidate, cfg.pricing),
      pin: { via: candidate.assignment.adapter, model: candidate.assignment.model },
      // OBS-1065: a picker lift reads eligibility from here, not the ledger strings
      belowFloor: candidate.belowFloor,
    }));
    const offered = new Set(rows.map((row) => row.id));
    const notes = [excludedNoteFor(cfgPreview), ...shapeExclusionCaptions(shape, map, cfgPreview)].filter(
      (note): note is string => note !== undefined,
    );
    return { rows, excludedNote: notes.length ? notes.join("\n") : undefined, ledger: channelLedger(shape, map, cfgPreview, offered) };
  };
  const preferUniverse = [
    ...new Set(channels.flatMap((channel) => [
      channel.adapter,
      channel.model,
      `${channel.adapter}:${channel.model}`,
    ])),
  ];
  const seats = [...new Set(channels.map((channel) => `${channel.adapter}:${channel.model}`))];
  const reviewAdapters = [...new Set(channels.map((channel) => channel.adapter))];
  const initialSteering: Record<FleetSteeringKey, string[] | undefined> = {
    review: cfg.review.prefer?.slice(),
    consult: cfg.consult.prefer?.slice(),
  };
  const steeringOptionsFor = (which: FleetSteeringKey, current: string[]) => {
    const discovered = which === "review" ? [...reviewAdapters, ...seats] : seats;
    return [...discovered, ...current.filter((entry) => !discovered.includes(entry))];
  };
  // The judge is one seat by schema (config.judge: { adapter, model }); the editor offers the same
  // discovered seats universe plus a keep-default row, and a write is staged only on a real change.
  const initialJudge = `${cfg.judge.adapter}:${cfg.judge.model}`;
  let pendingWrite: FleetOverlayWrite | null = null;
  const reviewOverlay = (state: FleetEditorState): FleetOverlayReview => {
    const staged = structuredClone(initial) as FleetEditable;
    // OBS-994/FL-1, OBS-1099 add.1: every schema-enumerated deny scope rides the same review/write funnel
    for (const scope of DENY_SCOPES) staged[scope.key] = state[scope.key];
    staged.allowOut = state.allowOut ?? initial.allowOut;
    staged.map = state.map;
    const today = new Date().toISOString().slice(0, 10);
    for (const classification of state.classifications) {
      staged.tiers[classification.adapter] ??= {};
      staged.tiers[classification.adapter][classification.model] = {
        tier: classification.tier,
        provenance: `${classification.note} — fleet ${today}`,
      };
    }

    // This callback is the sole candidate-overlay builder. The Ink component renders
    // the diff and asks for confirmation, but owns neither filesystem access nor a writer.
    const before = currentRepoOverlayText(cwd);
    const path = repoOverlayPath(cwd);
    const modeChanged = state.selectedMode !== rm.mode.mode;
    const steeringChanged = (["review", "consult"] as const).some(
      (key) => JSON.stringify(state.steering[key]) !== JSON.stringify(initialSteering[key]),
    );
    const judgeSeat = state.judgeSeat;
    const judgeChanged = judgeSeat !== undefined
      && `${judgeSeat.adapter}:${judgeSeat.model}` !== initialJudge;
    if (!modeChanged && !steeringChanged && !judgeChanged && fleetEditableEquals(initial, staged)) {
      pendingWrite = null;
      return { kind: "empty" };
    }
    const write: FleetOverlayWrite = {
      initial,
      edited: staged,
      universe,
      ...(modeChanged ? { mode: state.selectedMode } : {}),
      ...(judgeChanged && judgeSeat ? { judge: judgeSeat } : {}),
      steering: { initial: initialSteering, edited: state.steering },
    };
    const after = renderFleetOverlayWrite(before, write);
    if (before === after) {
      pendingWrite = null;
      return { kind: "empty" };
    }
    pendingWrite = write;
    return {
      kind: "diff",
      before,
      after,
      diff: unifiedYamlDiff(before, after, path),
      path,
    };
  };
  const reloadGuard = io.reloadGuard
    ?? ((bytes: string) => overlayBytesLoadError(cwd, bytes, { globalDir }));

  const props: FleetEditorProps = {
    ageMs: doctorAgeMs(cwd),
    adapters,
    health,
    ...Object.fromEntries(DENY_SCOPES.map((scope) => [initialDenyPropOf(scope), editable[scope.key] ?? []])),
    initialAllowOut: editable.allowOut,
    modelGroups,
    initialMode: rm.mode.mode,
    modeOptions: ROUTING_MODES.map((mode) => ({ id: mode, gloss: MODE_GLOSS[mode] })),
    initialMap: editable.map,
    modePreview: (mode, map, deny) => [modeSpend(mode, map, deny), ...floorPreview(mode)],
    shapeRows: routedShapeRows,
    candidatesForShape,
    preferOptionsForShape: (_shape, current) => [
      ...preferUniverse,
      ...current.filter((entry) => !preferUniverse.includes(entry)),
    ],
    initialSteering,
    steeringOptionsFor,
    reviewOverlay,
    reloadGuard,
    stagedRouting,
    entry: opts.entry,
    initialJudge,
    judgeSeats: seats,
    initialInput: [],
    input: (io.input ?? (process.stdin as FleetInput)) as NodeJS.ReadStream,
    output: (io.output ?? (process.stdout as FleetOutput)) as NodeJS.WriteStream,
    debug: io.debug,
  };

  const commit = (result: FleetEditorResult): string => {
    if (result.kind === "quit") return QUIT;
    if (result.kind === "refresh") {
      return "fleet: probe refresh requested — re-run `tickmarkr fleet --fresh` (doctor is the sensor; the editor itself never re-probes)";
    }
    if (result.kind === "no-changes") return "fleet: no overlay changes (empty diff)";
    if (result.kind === "discard") return "fleet: discarded overlay changes";

    // The command remains the single config actuator. Every interactive edit reaches this
    // one write only after the component-rendered diff confirm and the production reload guard.
    const write = pendingWrite;
    if (!write) throw new Error("fleet write reached confirmation without a staged overlay mutation");
    writeFleetOverlay(result.review.path, (prior) => renderFleetOverlayWrite(prior, write));
    // OBS-529: a freshly classified model has no probe verdict (doctor probes CONFIGURED models,
    // and it was not configured at probe time), so it stays unroutable — invisible in every
    // picker — until the next probe. Name the step, or the classify flow reads as broken.
    const unprobed: string[] = [];
    for (const [adapter, models] of Object.entries(write.edited.tiers)) {
      for (const [model, assigned] of Object.entries(models)) {
        if (assigned === null || assigned === undefined) continue;
        if (JSON.stringify(write.initial.tiers[adapter]?.[model]) === JSON.stringify(assigned)) continue;
        if (health[adapter]?.modelAuth?.[model] === undefined) unprobed.push(`${adapter}:${model}`);
      }
    }
    const head = `fleet: wrote ${result.review.path}`;
    if (!unprobed.length) return head;
    const named = unprobed.slice(0, 3).join(", ") + (unprobed.length > 3 ? `, +${unprobed.length - 3} more` : "");
    return `${head}\nfleet: ${unprobed.length} newly classified model(s) have no probe verdict yet (${named}) — run \`tickmarkr fleet --fresh\` to probe them; unverified models stay unroutable`;
  };

  return {
    props,
    commit,
    renderWhy: () => renderFleetWhy(projectedShapeRows(rm.mode.mode, editable.map, stagedDenyOf(editable))),
  };
}
