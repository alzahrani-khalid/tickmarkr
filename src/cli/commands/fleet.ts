import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters, discoverChannels, doctorAgeMs, initDoctorReuse, modelAuthExclusions, PREFERENCE_ROLES } from "../../adapters/registry.js";
import { catalogModelAdvisory, catalogTierRanking, declaredModelWindow, fleetUnclassifiedModels } from "../../adapters/model-lints.js";
import { CATALOG_REFRESH_TIMEOUT_MS, formatCatalogRefreshLegs, type CatalogFetcher, type CatalogModelEvidence, type CatalogReadResult, readCachedCatalog, refreshCatalogCommand } from "../../adapters/catalog-remote.js";
import { CLAUDE_ALIAS_IDENTITY_STAMPS, type ClaudeAlias, readClaudeAliasIdentity } from "../../adapters/claude-code.js";
import type { BillingChannel, WorkerAdapter } from "../../adapters/types.js";
import {
  ConfigError,
  DEFAULT_CONFIG,
  fleetEditableFromConfig,
  fleetEditableEquals,
  formatFleetPrint,
  globalConfigDir,
  DENY_SCOPES,
  initialDenyPropOf,
  loadConfigWithMode,
  lowerLayerModelOverrides,
  overlayBytesLoadError,
  readOverlayFile,
  stagedDenyKeyOf,
  renderFleetOverlayWrite,
  repoOverlayPath,
  repoShadowedUserKeys,
  ROUTING_MODES,
  TIER_RANK,
  type FleetOverlayWrite,
  type FleetEditable,
  type FleetUniverseRow,
  type LowerLayerModelOverrides,
  type MapEntry,
  type ModeResolution,
  type RoutingMode,
  type Tier,
  type TickmarkrConfig,
  unifiedYamlDiff,
  universeEntryMatches,
} from "../../config/config.js";
import { exclusionReason, projectFleetWhy, renderFleetWhy, type FleetWhyValue } from "../../config/fleet-why.js";
import { overlayHoldingLine, overlayHoldsMap } from "../../config/fleet-overlay.js";
import { SHAPES, TIERS, type Shape, type Task } from "../../graph/schema.js";
import { doctor } from "./doctor.js";
import { candidateRow, costSignal, shapeCandidates } from "./fleet-picker.js";
import { route } from "../../route/router.js";
import { pickRole } from "../../route/role-pick.js";
import { deadPoolEntries, deadPoolEntryLine, denyPreferCollisionLine, denyPreferCollisions, disallowedBy, entryMatchesChannel, exclusionCollector } from "../../route/preference.js";
import { resolveRunMode, type ResolvedRunMode } from "../../run/daemon.js";
import { loadRoutingProfile, readReviewNoVerdictHistory, reviewNoVerdictRows } from "../../run/journal.js";
// type-only: the Ink module must never load on the print path (nor before the TTY/FORCE_COLOR fixture)
import type {
  FleetEditorResult,
  FleetEditorState,
  FleetModelEvidence,
  FleetOverlayReview,
  FleetSeededAllow,
  FleetStagedDeny,
  FleetStagedMetadata,
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

// B2: a routing.map entry's declaration slot (pin/pool/prefer) — an empty prefer declares nothing
const mapSlot = (entry: MapEntry | undefined) => ({
  ...(entry?.pin ? { pin: entry.pin } : {}),
  ...(entry?.pool ? { pool: entry.pool } : {}),
  ...(entry?.prefer?.length ? { prefer: entry.prefer } : {}),
});
const slotLabel = (slot: ReturnType<typeof mapSlot>): string =>
  slot.pin ? `pin ${slot.pin.via}:${slot.pin.model}`
    : slot.pool ? `pool(${slot.pool.mode}·${slot.pool.channels.length})`
      : slot.prefer ? `prefer [${slot.prefer.join(", ")}]`
        : "cleared slot";

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
// T10: what every review says about where its bytes land and when they take effect
const REPO_DESTINATION_NOTE = (path: string) =>
  `destination: the repository overlay ${path} holds this repository's routing.allow/deny membership, so the edit lands there — the file is tracked: Fleet never stages or commits it; commit it to share the change`;
const FUTURE_LOADS_NOTE = "the save changes future config loads only — a tickmarkr run already in progress keeps the config it loaded";

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
    previewConfig: (mode: RoutingMode, map: Record<string, MapEntry>, deny: FleetStagedDeny, stage?: FleetStagedMetadata) =>
      { ok: true; cfg: TickmarkrConfig; mode: ModeResolution } | { ok: false; error: string };
  }
  | { unavailable: string }
> {
  const globalDir = opts.globalDir;
  // B2: the editor's choices are the operator's MACHINE choices — a save lands in the USER overlay,
  // which every repository on this machine inherits. T10 (D-925/D-926): except a membership edit the
  // repository overlay holds — it lands where it is effective (destinationEdits below).
  const userPath = join(globalDir, "config.yaml");
  const repoPath = repoOverlayPath(cwd);
  const currentUserText = () => (existsSync(userPath) ? readFileSync(userPath, "utf8") : "");
  type Destination = "user" | "repo";
  const pathOf = (destination: Destination) => (destination === "repo" ? repoPath : userPath);
  // the candidate bytes stand in for the destination layer in the one loader path
  const layerOf = (destination: Destination, bytes: string) =>
    (destination === "repo" ? { repoOverlayText: bytes } : { userOverlayText: bytes });
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
  // B2: the universe any scope-blind discovery serves — the assembly's, or a candidate config's at a
  // membership write (current layers plus staged classifications)
  const universeOf = (discovered: BillingChannel[]): FleetUniverseRow[] => adapters
    .filter((adapter) => health[adapter.id]?.installed)
    .map((adapter) => {
      const served = discovered.filter((c) => c.adapter === adapter.id);
      // LEG2-T3 round 2 finding 3: the recorded identity per channel, so the editable membership
      // matches allow/deny entries with the same authority the collector and the browser use
      const identities = Object.fromEntries(served.flatMap((c) => (c.identity ? [[c.model, c.identity]] : [])));
      return {
        adapter: adapter.id,
        models: [...new Set(served.map((c) => c.model))],
        ...(Object.keys(identities).length ? { identities } : {}),
      };
    });
  const universe = universeOf(previewChannels);
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
  // T8: staged classifications and efforts as the editable tiers/efforts a review writes — one fold for
  // the review and every preview, so the mode/shape/picker callbacks rank exactly what w would write.
  // T10 (D-939): each classification's seeded allow entry rides beside the metadata, never inside FleetEditable
  type StagedMetadata = Pick<FleetEditable, "tiers" | "efforts"> & { seeds: FleetSeededAllow[] };
  const stagedMetadataOf = (stage: FleetStagedMetadata): StagedMetadata => {
    const tiers = structuredClone(initial.tiers);
    const today = new Date().toISOString().slice(0, 10);
    for (const classification of stage.classifications) {
      tiers[classification.adapter] ??= {};
      tiers[classification.adapter][classification.model] = {
        tier: classification.tier,
        provenance: `${classification.note} — fleet ${today}`,
      };
    }
    // OBS-1182: staged efforts replace the loaded ones; none staged anywhere ⇒ no key, as loaded
    const efforts = Object.fromEntries(Object.entries(stage.efforts ?? {}).filter(([, models]) => Object.keys(models).length));
    return { tiers, ...(Object.keys(efforts).length ? { efforts } : {}), seeds: stage.seededAllowOut ?? [] };
  };
  // B2: the classifications and efforts of the last reviewed state — what a preview called without a
  // stage (the browser's staged routing, --why) ranks; the editor passes its current stage (T8).
  let reviewedStage: StagedMetadata = { tiers: initial.tiers, efforts: initial.efforts, seeds: [] };
  // OBS-1182: the layers under the written overlay — B2: the defaults alone under the USER overlay;
  // T10: defaults + user under the repository overlay — read raw, so clearing an effort masks an
  // inherited one. OBS-1188: re-read at every review and save, never an assembly-time snapshot; an
  // unreadable read keeps the last good one for the preview only — the save guard below refuses it.
  const lowerOverrides: Record<Destination, LowerLayerModelOverrides> = { user: {}, repo: {} };
  const stagedEditable = (map: Record<string, MapEntry>, deny: StagedDeny, metadata: StagedMetadata): FleetEditable => ({
    ...structuredClone(initial),
    // metadata carries efforts only when some are staged — as a review writes them
    tiers: structuredClone(metadata.tiers),
    efforts: metadata.efforts && structuredClone(metadata.efforts),
    ...Object.fromEntries(DENY_SCOPES.map((scope) => [scope.key, deny[stagedDenyKeyOf(scope)]])),
    // OBS-1046: the allow complement is staged beside the deny lists, never folded into them
    allowOut: deny.allowOut ?? initial.allowOut,
    map,
  });
  // B2: the writer diffs a CHANGED routing.map slot against what its destination declares there —
  // the user layer (defaults + user, no repo) — never the effective slot a repo pin/pool/prefer
  // shadows, which would leave the user's own hidden declaration beside the new one (a stale pin a
  // second repository still routes to, or pin+pool bytes that refuse a valid edit).
  // B2: a touched membership is the same — the writer rewrites the allow form from the whole staged
  // fleet, so its flat deny lists and allow complement diff against the user layer's own; a user
  // deny the repo's list hides is admitted or kept by the staged fleet, never left to re-exclude
  // it in every other repository.
  const membershipKeys = [...DENY_SCOPES.filter((scope) => scope.path.length === 3).map((scope) => scope.key), "allowOut"] as const;
  const sameSet = (a: string[] = [], b: string[] = []) => [...new Set(a)].sort().join() === [...new Set(b)].sort().join();
  // T10: a repository destination diffs against the effective layers (defaults + user + repo).
  const destinationInitial = <T extends FleetEditable>(base: T, edited: FleetEditable, destination: Destination, text: string, target: FleetUniverseRow[]): T => {
    let userCfg: TickmarkrConfig;
    try {
      userCfg = loadConfigWithMode(cwd, {
        globalDir,
        ...(destination === "repo" ? { repoOverlayText: text } : { userOverlayText: text, repoOverlayText: "" }),
      }).cfg;
    } catch {
      return base; // ponytail: bytes that load only beside another layer — the reload guard refuses the write
    }
    const userLayer = userCfg.routing.map;
    const editedMap = edited.map;
    const map = { ...base.map };
    for (const shape of new Set([...Object.keys(base.map), ...Object.keys(editedMap)])) {
      if (JSON.stringify(base.map[shape]) === JSON.stringify(editedMap[shape])) continue;
      const { pin, pool, prefer } = userLayer[shape] ?? {};
      // escalate is no slot key: it merges per key, so the effective value stays the baseline
      const escalate = base.map[shape]?.escalate;
      map[shape] = {
        ...(pin ? { pin } : {}), ...(pool ? { pool } : {}), ...(prefer ? { prefer } : {}),
        ...(escalate !== undefined ? { escalate } : {}),
      };
    }
    const membershipTouched = membershipKeys.some((key) => !sameSet(base[key], edited[key]));
    const layer = membershipTouched ? fleetEditableFromConfig(userCfg, target) : undefined;
    return {
      ...base,
      map,
      ...(layer ? Object.fromEntries(membershipKeys.map((key) => [key, layer[key] ?? []])) : {}),
    };
  };
  // B2: a changed slot staged with no declaration (auto, no prefer) where the defaults under the user
  // overlay declare one: deleting the user's pin/pool would restore that default, so the slot is
  // masked with prefer: [] — a declaration that replaces the lower slot atomically and ranks nothing.
  // T8: a default PIN is masked by the writer's raw pin: null tombstone instead (lowerMap below), so
  // Auto saves no prefer declaration the operator never made.
  const maskClearedSlots = (base: FleetEditable, staged: FleetEditable): FleetEditable => {
    const map = { ...staged.map };
    for (const shape of new Set([...Object.keys(base.map), ...Object.keys(staged.map)])) {
      const entry = staged.map[shape];
      const lower = mapSlot(DEFAULT_CONFIG.routing.map[shape]);
      if (JSON.stringify(base.map[shape]) === JSON.stringify(entry)) continue;
      if (Object.keys(mapSlot(entry)).length || !Object.keys(lower).length || lower.pin) continue;
      map[shape] = { ...entry, prefer: [] };
    }
    return { ...staged, map };
  };
  // T10 (D-939): ONE pure baseline — the session's initial allow complement plus the allow entry Ink
  // seeded beside each classification it staged (FleetSeededAllow) — serves every preview, the review
  // and the destination choice. `initial` is never mutated.
  const baselineOf = (seeds: FleetSeededAllow[]): FleetEditable => (seeds.length
    ? { ...initial, allowOut: [...new Set([...(initial.allowOut ?? []), ...seeds.map((seed) => seed.entry)])].sort() }
    : initial);
  const FLAT_SCOPES = DENY_SCOPES.filter((scope) => scope.path.length === 3);
  // one browser channel: a seed, or (T10 review) a classified row with no seed
  type RowChannel = Pick<FleetSeededAllow, "adapter" | "displayModel" | "identity">;
  const seedChannel = (seed: RowChannel) =>
    ({ adapter: seed.adapter, model: seed.displayModel, ...(seed.identity !== undefined ? { identity: seed.identity } : {}) });
  // an allow-complement entry excludes a seeded channel by the allow form's own matching (adapter id,
  // model, adapter:model, recorded identity) — the seed's spelling is one such entry, never the only one
  const seedRow = (seed: RowChannel): FleetUniverseRow => ({
    adapter: seed.adapter,
    models: [seed.displayModel],
    ...(seed.identity !== undefined ? { identities: { [seed.displayModel]: seed.identity } } : {}),
  });
  const allowExcludes = (staged: FleetEditable, seed: RowChannel) =>
    (staged.allowOut ?? []).some((entry) => universeEntryMatches(seedRow(seed), seed.displayModel, entry));
  // membership keeps the channel out: its allow complement or a flat (all-seats) deny entry
  const excludedIn = (staged: FleetEditable, seed: RowChannel) => allowExcludes(staged, seed)
    || FLAT_SCOPES.some((scope) => (staged[scope.key] ?? []).some((entry) => entryMatchesChannel(entry, seedChannel(seed), true)));
  // a seed cleared while another staged complement entry (its adapter's, say) still excludes its
  // channel admitted nothing: the press is a no-op, so the seed stays staged and the shared exclusion
  // is no membership edit — its classification stays a lone tier
  const settled = (staged: FleetEditable, seeds: FleetSeededAllow[]): FleetEditable => {
    const kept = seeds.filter((seed) => !(staged.allowOut ?? []).includes(seed.entry) && allowExcludes(staged, seed));
    return kept.length
      ? { ...staged, allowOut: [...new Set([...(staged.allowOut ?? []), ...kept.map((seed) => seed.entry)])].sort() }
      : staged;
  };
  // an END state, re-derived per call: no staged complement entry and no flat deny excludes the seed's
  // channel any more — an admission undone by out · all is no admission
  const admittedSeeds = (staged: FleetEditable, seeds: FleetSeededAllow[]) => seeds.filter((seed) => !excludedIn(staged, seed));
  // ponytail: rows re-render per key press, each naming its scopes' holders — memoized per (bytes, path),
  // cleared wholesale past 256 entries; a keyed LRU if a fleet ever outgrows it
  const holdingMemo = new Map<string, number | undefined>();
  const holdingLine = (text: string, path: readonly string[]): number | undefined => {
    const key = `${path.join(".")}\0${text}`;
    if (!holdingMemo.has(key)) {
      if (holdingMemo.size > 256) holdingMemo.clear();
      holdingMemo.set(key, overlayHoldingLine(text, path));
    }
    return holdingMemo.get(key);
  };
  // routing.allow is held through its leaves: a bare `allow: {}` declares none, so the merge keeps the
  // lower layer's leaves effective; a null mask at a leaf or above still holds it
  const heldLine = (text: string, path: readonly string[]): number | undefined =>
    path.join(".") === "routing.allow" && ["adapters", "models"].every((leaf) => holdingLine(text, [...path, leaf]) === undefined)
      ? undefined
      : holdingLine(text, path);
  // T10: the repository holds a path when it declares it ([] included) or masks it with null at it or above
  const repoHolds = (path: readonly string[]): boolean => heldLine(currentRepoOverlayText(cwd), path) !== undefined;
  // T10: where a scope lives in this repository's merge — `path:line` of the repository overlay when it
  // holds it, else of the user overlay when that one does; undefined = the defaults alone. Paths are
  // short (repo-relative, ~ for home) so the row's detail line keeps them on screen.
  const home = homedir();
  const shown = (path: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
  const holderOf = (dotted: string): string | undefined => {
    const path = dotted.split(".");
    const repoLine = heldLine(currentRepoOverlayText(cwd), path);
    if (repoLine !== undefined) return `${relative(cwd, repoPath)}:${repoLine}`;
    const userLine = heldLine(currentUserText(), path);
    return userLine === undefined ? undefined : `${shown(userPath)}:${userLine}`;
  };
  // the allow + flat-deny family is ONE coupled write (the allow form is
  // regenerated from the whole staged fleet), so it has one holder: the repository when it holds any of
  // its leaves, else the user. A bare repository `allow: {}` holds no leaf, yet its presence alone keeps
  // the allowlist on: a user save that drops the user allow form would fail-close this repository, so
  // only the repository (which masks it) can take that save. Whether the user form goes away is read off
  // the one writer's user bytes — a staged flat deny, an allow exclusion, or a retained authored entry
  // for a channel this probe never served each keep it, and with it the save, in the user overlay.
  const userFormDropped = (staged: FleetEditable, seeds: FleetSeededAllow[]): boolean => {
    const text = currentUserText();
    try {
      const bytes = renderFleetOverlayWrite(text, layerWrite(staged, seeds, "user", text, { lowerOverrides: lowerOverrides.user }));
      return !overlayHoldsMap(bytes, ["routing", "allow"]);
    } catch {
      return false; // the review renders the same write and names its refusal
    }
  };
  const familyHolder = (staged: FleetEditable, seeds: FleetSeededAllow[]): Destination =>
    [["routing", "allow"], ...FLAT_SCOPES.map((scope) => scope.path)].some(repoHolds)
    || (holdingLine(currentRepoOverlayText(cwd), ["routing", "allow"]) !== undefined && userFormDropped(staged, seeds))
      ? "repo" : "user";
  type DestinationEdit = { name: string; destination: Destination };
  const destinationEdits = (pressed: FleetEditable, seeds: FleetSeededAllow[], controls: string[]): DestinationEdit[] => {
    const staged = settled(pressed, seeds);
    const baseline = baselineOf(seeds);
    const admitted = admittedSeeds(staged, seeds);
    let held: Destination | undefined;
    const family = () => (held ??= familyHolder(staged, seeds));
    const edits: DestinationEdit[] = [];
    if (admitted.length || membershipKeys.some((key) => !sameSet(baseline[key], staged[key]))) {
      edits.push({ name: "routing.allow/routing.deny membership", destination: family() });
    }
    // a worker leaf follows the layer that holds it
    for (const scope of DENY_SCOPES.filter((candidate) => candidate.path.length > 3)) {
      if (!sameSet(initial[scope.key], staged[scope.key])) edits.push({ name: scope.dotted, destination: repoHolds(scope.path) ? "repo" : "user" });
    }
    for (const [adapter, models] of Object.entries(staged.tiers)) {
      for (const [model, value] of Object.entries(models)) {
        if (JSON.stringify(value) === JSON.stringify(initial.tiers[adapter]?.[model])) continue;
        // a classification co-locates only with its own admission — its seed cleared, or (T10 review) its
        // own flat-deny lift: a row the baseline membership kept out that the staged one admits; a lone or
        // unrelated tier stays user
        const own = admitted.some((seed) => seed.adapter === adapter && seed.model === model)
          || (modelGroups.find((group) => group.adapter === adapter)?.rows ?? [])
            .filter((row) => row.model === model || ("classifyModel" in row && row.classifyModel === model))
            .some((row) => {
              const channel = { adapter, displayModel: row.model, ...(row.evidence?.identity !== undefined ? { identity: row.evidence.identity } : {}) };
              return excludedIn(baseline, channel) && !excludedIn(staged, channel);
            });
        edits.push({ name: `tiers.${adapter}.models.${model}`, destination: own ? family() : "user" });
      }
    }
    // {} ≡ absent: pin-then-auto leaves an empty entry that writes nothing (fleet-app stagedCount)
    if ([...new Set([...Object.keys(initial.map), ...Object.keys(staged.map)])]
      .some((shape) => JSON.stringify(initial.map[shape] ?? {}) !== JSON.stringify(staged.map[shape] ?? {}))) {
      edits.push({ name: "routing.map", destination: "user" });
    }
    if (JSON.stringify(initial.efforts ?? {}) !== JSON.stringify(staged.efforts ?? {})) edits.push({ name: "model efforts", destination: "user" });
    return [...edits, ...controls.map((name) => ({ name, destination: "user" as const }))];
  };
  // ONE review confirms ONE destination; a batch needing both is refused before any write (no
  // multi-file transaction) and names what to save in separate sessions
  const chooseDestination = (edits: DestinationEdit[]): { ok: true; destination: Destination } | { ok: false; reason: string } => {
    if (new Set(edits.map((edit) => edit.destination)).size <= 1) return { ok: true, destination: edits[0]?.destination ?? "user" };
    const side = (destination: Destination) =>
      `${edits.filter((edit) => edit.destination === destination).map((edit) => edit.name).join(", ")} → ${pathOf(destination)}`;
    return {
      ok: false,
      reason: `mixed destinations — one review writes one overlay: ${side("repo")}; ${side("user")} — save them in separate sessions (stage one side, w, y; then the other)`,
    };
  };
  // T10: the universe a write edits — the candidate's own discovery plus every seeded channel, so an
  // unprobed classified model can still be admitted (membership ≠ routability). A seed whose channel
  // the browser never showed, or whose spelling names no channel, is refused.
  const editingUniverse = (candidate: TickmarkrConfig, seeds: FleetSeededAllow[]): FleetUniverseRow[] => {
    const target = universeOf(candidateChannels(candidate));
    const covers = (seed: FleetSeededAllow) => target.some((row) => row.adapter === seed.adapter
      && row.models.some((model) => universeEntryMatches(row, model, seed.entry)));
    for (const seed of seeds) {
      if (covers(seed)) continue;
      const shown = modelGroups.some((group) => group.adapter === seed.adapter && group.rows.some((row) => row.model === seed.displayModel));
      const row = target.find((candidateRow) => candidateRow.adapter === seed.adapter);
      if (shown && row) {
        row.models = [...row.models, seed.displayModel];
        if (seed.identity !== undefined) row.identities = { ...row.identities, [seed.displayModel]: seed.identity };
      }
      if (!covers(seed)) throw new ConfigError(`the seeded allow entry ${seed.entry} names no channel of the discovered fleet — re-probe with tickmarkr doctor, then classify it again`);
    }
    return target;
  };
  // T10: the routing.allow the layers BELOW the destination declare (the defaults declare none; under
  // the repository, the user overlay's, read now). "Whole fleet in" masks it, never resurrects it, and
  // while the repository declares no allow of its own, that inherited form's unserved entries are
  // effective here, so the regenerated repository form keeps them.
  const lowerAllow = (destination: Destination): FleetOverlayWrite["preservedAllow"] => {
    if (destination === "user") return DEFAULT_CONFIG.routing.allow;
    const user = readOverlayFile(userPath) as { routing?: { allow?: FleetOverlayWrite["preservedAllow"] | null } | null };
    return user.routing?.allow ?? undefined;
  };
  // B2: the one write builder the previews and the review share, so a preview ranks the bytes y would
  // land. A touched membership serializes against the universe the candidate itself serves (current
  // layers plus staged classifications), rendered first with membership unchanged; a channel only that
  // universe adds keeps the verdict the current layers' allow form gives it — T10: unless it is an
  // admitted seed, which the operator just let in.
  const layerWrite = (
    pressed: FleetEditable,
    seeds: FleetSeededAllow[],
    destination: Destination,
    text: string,
    rest: Pick<FleetOverlayWrite, "mode" | "judge" | "steering"> & { lowerOverrides: LowerLayerModelOverrides },
  ): FleetOverlayWrite => {
    const staged = settled(pressed, seeds);
    const baseline = baselineOf(seeds);
    const admitted = admittedSeeds(staged, seeds);
    const lower = lowerAllow(destination);
    // per leaf: an inherited allow leaf the repository neither declares nor masks (at it or above) is
    // effective here, so its unserved entries ride the regenerated form even beside a declared sibling
    const inherited = lower && Object.fromEntries((["adapters", "models"] as const)
      .filter((leaf) => lower[leaf] != null && !repoHolds(["routing", "allow", leaf]))
      .map((leaf) => [leaf, lower[leaf]]));
    const fixed = {
      lowerMap: DEFAULT_CONFIG.routing.map,
      ...(lower !== undefined ? { lowerAllow: lower } : {}),
      ...(inherited && Object.keys(inherited).length ? { preservedAllow: inherited } : {}),
    };
    let edited = maskClearedSlots(initial, staged);
    let target = editingUniverse(cfg, seeds);
    if (membershipKeys.some((key) => !sameSet(baseline[key], edited[key]))) {
      const unchanged = { ...edited, ...Object.fromEntries(membershipKeys.map((key) => [key, baseline[key]])) };
      try {
        const bytes = renderFleetOverlayWrite(text, {
          ...rest, ...fixed, initial: destinationInitial(baseline, unchanged, destination, text, target), edited: unchanged, universe: target,
        });
        const candidate = loadConfigWithMode(cwd, { globalDir, ...layerOf(destination, bytes) }).cfg;
        target = editingUniverse(candidate, seeds);
        const known = (entry: string) => universe.some((row) =>
          entry === row.adapter || row.models.some((model) => universeEntryMatches(row, model, entry)));
        const admits = (entry: string) => admitted.some((seed) => target.some((row) => row.adapter === seed.adapter
          && row.models.some((model) => universeEntryMatches(row, model, seed.entry) && universeEntryMatches(row, model, entry))));
        const grown = (fleetEditableFromConfig(candidate, target).allowOut ?? []).filter((entry) => !known(entry) && !admits(entry));
        if (grown.length) edited = { ...edited, allowOut: [...new Set([...(edited.allowOut ?? []), ...grown])].sort() };
      } catch {
        // the full render below (or the reload guard) names the refusal
      }
    }
    return { ...rest, ...fixed, initial: destinationInitial(baseline, edited, destination, text, target), edited, universe: target };
  };
  // LEG2-T3 finding 2: a preview is the config loader over the candidate bytes the writer would
  // produce — never a second in-memory merge of the staged sets over the resolved config, which
  // kept every on-disk scope the staged edit tombstones (a removed workers deny survived here).
  // Judge c2 (R107): candidate bytes the writer cannot render or the loader refuses are an
  // explicit invalid-preview state carrying the refusal — never another config shown in their place.
  // ponytail: bounded memo, previews re-render per key press; a tiny LRU if it ever churns.
  type CandidatePreview = { ok: true; cfg: TickmarkrConfig; mode: ModeResolution } | { ok: false; error: string };
  const candidateMemo = new Map<string, CandidatePreview>();
  const previewCfg = (mode: RoutingMode, map: Record<string, MapEntry>, deny: StagedDeny, stage?: FleetStagedMetadata): CandidatePreview => {
    // B2: the user and repo overlay bytes are part of the key — a layer edited mid-session (a repo
    // deny added before a review) re-renders the preview instead of serving the pre-edit one.
    // T8: so are the staged tiers/efforts — a metadata edit never serves the preview cached before it
    const metadata = stage ? stagedMetadataOf(stage) : reviewedStage;
    const userText = currentUserText();
    const repoText = currentRepoOverlayText(cwd);
    const key = JSON.stringify([mode, map, deny, metadata, userText, repoText]);
    const hit = candidateMemo.get(key);
    if (hit) return hit;
    let preview: CandidatePreview;
    try {
      const staged = stagedEditable(map, deny, metadata);
      // T10: a preview loads the bytes the chosen destination would hold; a mixed batch (refused at w)
      // previews with the repository side, so a row's reach never turns unknown mid-session
      const chosen = chooseDestination(destinationEdits(staged, metadata.seeds, mode !== rm.mode.mode ? ["routing.mode"] : []));
      const destination: Destination = chosen.ok ? chosen.destination : "repo";
      const text = destination === "repo" ? repoText : userText;
      const bytes = renderFleetOverlayWrite(text, layerWrite(staged, metadata.seeds, destination, text, {
        lowerOverrides: lowerOverrides[destination],
        ...(mode !== rm.mode.mode ? { mode } : {}),
      }));
      preview = { ok: true, ...loadConfigWithMode(cwd, { globalDir, ...layerOf(destination, bytes) }) };
    } catch (error) {
      preview = { ok: false, error: (error as Error).message.replace(/\s+/g, " ").trim() };
    }
    if (candidateMemo.size > 32) candidateMemo.clear();
    candidateMemo.set(key, preview);
    return preview;
  };
  const previewUnavailable = (error: string) =>
    `preview unavailable (${error}) — the staged overlay does not load, so w would be refused`;
  // T10: the staged metadata rides along, so a seeded classification's admission reads `in` before w
  const stagedRouting = (deny: StagedDeny, stage?: FleetStagedMetadata): { ok: true; routing: TickmarkrConfig["routing"] } | { ok: false; error: string } => {
    const preview = previewCfg(rm.mode.mode, editable.map, deny, stage);
    return preview.ok ? { ok: true, routing: preview.cfg.routing } : preview;
  };
  // B2: the candidate config's own discovery, blind to both membership scopes — classifications and
  // channel metadata (tier, channel) a reloaded layer changed reach routing, ranking and the ledger,
  // never the assembly-time channels. Keyed on the memoized candidate config object.
  const candidateChannelMemo = new WeakMap<TickmarkrConfig, BillingChannel[]>();
  const candidateChannels = (cfgPreview: TickmarkrConfig): BillingChannel[] => {
    const hit = candidateChannelMemo.get(cfgPreview);
    if (hit) return hit;
    const { deny: _deny, allow: _allow, ...blind } = cfgPreview.routing;
    const discovered = discoverChannels({ ...cfgPreview, routing: blind }, adapters, health);
    candidateChannelMemo.set(cfgPreview, discovered);
    return discovered;
  };
  // route() never deny-filters its pool — that contract lives in discoverChannels — so every
  // preview call rebuilds the pool the staged deny would discover
  const previewPool = (cfgPreview: TickmarkrConfig) =>
    candidateChannels(cfgPreview).filter((c) => disallowedBy(c, cfgPreview.routing) === null);
  const modeSpend = (mode: RoutingMode, map: Record<string, MapEntry>, deny: StagedDeny, stage?: FleetStagedMetadata): string => {
    const tierCount: Partial<Record<Tier, number>> = {};
    let subs = 0;
    let apiN = 0;
    let apiUsd = 0;
    const preview = previewCfg(mode, map, deny, stage);
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
          apiUsd += cfgPreview.pricing[assignment.tier] ?? 0;
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
  // B2: the floors the candidate user-layer bytes resolve to — the same config the routed mix ranks
  // against, so a repo-declared mode that shadows the user's pick previews no floor change
  const floorPreview = (mode: RoutingMode, map: Record<string, MapEntry>, deny: StagedDeny, stage?: FleetStagedMetadata): string[] => {
    if (mode === rm.mode.mode) return [];
    const preview = previewCfg(mode, map, deny, stage);
    if (!preview.ok) return []; // modeSpend names the refusal
    const current = cfg.routing.floors;
    const next = preview.cfg.routing.floors;
    const changed = SHAPES.filter((shape) => current[shape] !== next[shape]);
    return [
      `  floors vs ${rm.mode.mode}:`,
      ...(changed.length
        ? changed.map((shape) => `    ${shape}: ${current[shape]} → ${next[shape]}`)
        : ["    (no floor changes)"]),
    ];
  };
  // B2: `resolution` is the candidate user-layer bytes' own mode resolution — a repo-declared mode that
  // shadows the user's pick keeps its provenance, never an operator pin the loader would not apply
  // B2: `entry` is the slot the candidate's loader applies — a staged slot a repo declaration shadows
  // is no operator pin here; the repo's winning declaration keeps its provenance
  const whyDeclaration = (
    shape: Shape,
    resolution: ModeResolution,
    entry: MapEntry | undefined,
    mapProducedValue: boolean,
  ): Pick<FleetWhyValue, "declaredAt" | "operatorPinned"> => {
    const mapChanged = JSON.stringify(mapSlot(entry)) !== JSON.stringify(mapSlot(editable.map[shape]));
    if (mapProducedValue) {
      return mapChanged
        ? { operatorPinned: true }
        : { declaredAt: `routing.map.${shape}` };
    }

    const floorSource = resolution.provenance[shape];
    if (floorSource === undefined) return {};
    if (floorSource === "config floors") return { declaredAt: `routing.floors.${shape}` };
    if (resolution.mode !== rm.mode.mode) return { operatorPinned: true };
    return rm.source === "default"
      ? { declaredAt: `routing.floors.${shape}` }
      : { declaredAt: "routing.mode" };
  };
  const projectedShapeRows = (mode: RoutingMode, map: Record<string, MapEntry>, deny: StagedDeny, stage?: FleetStagedMetadata) => {
    const preview = previewCfg(mode, map, deny, stage);
    if (!preview.ok) {
      return projectFleetWhy(SHAPES.map((shape) => ({
        id: shape,
        effective: previewUnavailable(preview.error),
        ...whyDeclaration(shape, modeCfgs[mode].mode, map[shape], false),
      })), { repoRoot: cwd, globalDir });
    }
    const cfgPreview = preview.cfg;
    const pool = previewPool(cfgPreview);
    const values: FleetWhyValue<Shape>[] = SHAPES.map((shape) => {
      // B2: annotations and provenance read the slot the loader applies; a staged slot it does not
      // apply (a repo pin/pool/prefer above the user overlay) is named shadowed, never shown as routing
      const entry = cfgPreview.routing.map[shape];
      const staged = mapSlot(map[shape]);
      const shadowed = JSON.stringify(staged) !== JSON.stringify(mapSlot(editable.map[shape]))
        && JSON.stringify(staged) !== JSON.stringify(mapSlot(entry));
      const shadowNote = shadowed ? `  · staged ${slotLabel(staged)} shadowed — not applied in this repository` : "";
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
        const declaredPool = entry?.pool;
        const poolPrefix = declaredPool ? `pool(${declaredPool.mode}·${declaredPool.channels.length}) → ` : "";
        // T8: the launch effort the routed channel carries — a staged effort shows here before w
        const effort = assignment.effort ? `, effort ${assignment.effort}` : "";
        const effective = `${poolPrefix}${assignment.adapter}:${assignment.model} (${assignment.channel}, ${assignment.tier}${effort})  ${costSignal(assignment, cfgPreview.pricing)}${shadowNote}`;
        const mapProducedValue = entry?.pin !== undefined || entry?.pool !== undefined
          || routed.provenance.includes("via prefer");
        return {
          id: shape,
          effective,
          ...whyDeclaration(shape, preview.mode, entry, mapProducedValue),
        };
      } catch (error) {
        const mapProducedValue = entry?.pin !== undefined || entry?.pool !== undefined
          || (entry?.prefer?.length ?? 0) > 0;
        return {
          id: shape,
          effective: `${(error as Error).message}${shadowNote}`,
          ...whyDeclaration(shape, preview.mode, entry, mapProducedValue),
          setupCommand: "tickmarkr fleet",
        };
      }
    });
    return projectFleetWhy(values, { repoRoot: cwd, globalDir });
  };
  const routedShapeRows = (mode: RoutingMode, map: Record<string, MapEntry>, deny: StagedDeny, stage?: FleetStagedMetadata) =>
    projectedShapeRows(mode, map, deny, stage).map(({ id, label }) => ({ id, label }));
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
    for (const channel of candidateChannels(cfgPreview)) {
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
  // B2: captions read the slot the candidate's loader applies — a staged slot a repo declaration
  // shadows excludes nothing here, so it is never named as the reason
  const shapeExclusionCaptions = (shape: Shape, cfgPreview: TickmarkrConfig): string[] => {
    const pool = previewPool(cfgPreview);
    const entry = cfgPreview.routing.map[shape];
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
    for (const collision of denyPreferCollisions(cfgPreview, [shape], health)) {
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
    // B2: reasons name the applied slot; the carried chain below stays the staged one Space edits
    const entry = cfgPreview.routing.map[shape];
    const floor = cfgPreview.routing.floors[shape];
    const collisions = denyPreferCollisions(cfgPreview, [shape], health);
    const discovered = new Set(candidateChannels(cfgPreview).map((c) => `${c.adapter}:${c.model}`));
    // T2 review (D-225): discovery already dropped a channel whose model probe failed — it is
    // rebuilt as a structured channel from its adapter's own declaration and walks the SAME
    // reach + collector path as every other row, the auth reason appended LAST; never a bare string
    const withIdentity = (adapter: string, declared: BillingChannel) => {
      const identity = health[adapter]?.modelAuth?.[declared.model]?.identity ?? health[adapter]?.modelIdentities?.[declared.model];
      return identity ? { ...declared, identity } : declared;
    };
    const failedProbes = unauthedModels.filter(({ key }) => !discovered.has(key)).flatMap(({ key, adapter, reason }) => {
      const declared = adapters.find((a) => a.id === adapter)?.channels(cfgPreview).find((c) => `${c.adapter}:${c.model}` === key);
      return declared ? [{ ...withIdentity(adapter, declared), authReason: `unauthed (${reason}) — re-probe with tickmarkr doctor` }] : [];
    });
    // T2 review round 6: an installed-but-unauthed CLI is dropped by discovery AND by the model
    // probe list, so its configured channels are rebuilt from the adapter's own declaration too —
    // each greys with its reach and covering entry, the CLI auth reason last; never one bare adapter line
    const unauthedCliChannels = unauthedClis.flatMap((adapter) => (adapters.find((a) => a.id === adapter)?.channels(cfgPreview) ?? [])
      .map((declared) => ({ ...withIdentity(adapter, declared), authReason: `${adapter} CLI unauthed — re-probe with tickmarkr doctor` })));
    // D-225: the ledger is the EXCLUDED half of a closed partition — a channel the picker offers
    // never greys beside itself; its pin/pool/floor/prefer captions stay in excludedNote
    const ledgerChannels = [...candidateChannels(cfgPreview).map((c) => ({ ...c, authReason: undefined as string | undefined })), ...failedProbes, ...unauthedCliChannels]
      .filter((c) => !offered.has(`${c.adapter}:${c.model}`));
    const lines = ledgerChannels.flatMap((c) => {
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
      return reasons.length ? [{ key, line: `${c.adapter}/${c.model} — reach: ${reach} — ${reasons.join("; ")}` }] : [];
    });
    // OBS-1145 add.1: every carried pool member the picker does not offer leads the ledger in chain
    // order — one no reason above names still gets its own row — so the picker renders its ordinal
    // and Space can drop it; a chain member with no row is hidden AND irremovable
    const carried = map[shape]?.pool?.channels.filter((key) => !offered.has(key)) ?? [];
    const named = new Set(lines.map((row) => row.key));
    const unnamed = carried.filter((key) => !named.has(key)).map((key) => ({
      key,
      line: `${key.replace(":", "/")} — ${discovered.has(key) ? `not offered for ${shape}` : "not served by an installed adapter"} — carried in routing.map.${shape}.pool`,
    }));
    const order = (key: string) => (carried.includes(key) ? carried.indexOf(key) : carried.length);
    return [...lines, ...unnamed].sort((a, b) => order(a.key) - order(b.key)).map((row) => row.line);
  };
  const candidatesForShape = (shape: Shape, mode: RoutingMode, map: Record<string, MapEntry>, deny: StagedDeny, stage?: FleetStagedMetadata) => {
    const preview = previewCfg(mode, map, deny, stage);
    if (!preview.ok) return { rows: [], excludedNote: previewUnavailable(preview.error) };
    const cfgPreview = preview.cfg;
    const rows = shapeCandidates(previewTask(shape), cfgPreview, previewPool(cfgPreview), profile).map((candidate) => ({
      id: `${candidate.assignment.adapter}:${candidate.assignment.model}`,
      label: candidateRow(candidate, cfgPreview.pricing),
      pin: { via: candidate.assignment.adapter, model: candidate.assignment.model },
      // OBS-1065: a picker lift reads eligibility from here, not the ledger strings
      belowFloor: candidate.belowFloor,
    }));
    const offered = new Set(rows.map((row) => row.id));
    const notes = [excludedNoteFor(cfgPreview), ...shapeExclusionCaptions(shape, cfgPreview)].filter(
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
  // OBS-1052(3): shown on the Steering view beside review.prefer; the pickers above stay untouched.
  const reviewAdvisories = reviewNoVerdictRows(readReviewNoVerdictHistory(cwd))
    .filter((row) => row.verdict === "warn")
    .map((row) => `review history: ${row.channel} — ${row.value}`);
  const steeringOptionsFor = (which: FleetSteeringKey, current: string[]) => {
    const discovered = which === "review" ? [...reviewAdapters, ...seats] : seats;
    return [...discovered, ...current.filter((entry) => !discovered.includes(entry))];
  };
  // The judge is one seat by schema (config.judge: { adapter, model }); the editor offers the same
  // discovered seats universe plus a keep-default row, and a write is staged only on a real change.
  const initialJudge = `${cfg.judge.adapter}:${cfg.judge.model}`;
  // B2: the staged write plus the user and repo overlay bytes its review (and shadow notes) were rendered
  // against; T10: and the one destination it confirmed
  type PendingWrite = { write: FleetOverlayWrite; repo: string; user: string; destination: Destination; path: string };
  let pendingWrite: PendingWrite | null = null;
  const lowerLayers = (destination: Destination) => lowerLayerModelOverrides({ globalDir, below: destination });
  // OBS-1188: the reviewed bytes are the only bytes that may land. Any byte of the user or repo overlay
  // that moved since the review is a stale preview — a re-render alone would overwrite a same-key edit
  // with the staged value and still match — then the lower layers are re-rendered as they are NOW.
  // T10: both overlays are guarded whichever one is written, so a holder that moved after the review
  // (the destination itself) refuses instead of retargeting. Null = still current.
  const stalePreview = (pending: PendingWrite, reviewed: string, prior?: string): string | null => {
    const destinationNow = prior ?? (pending.destination === "repo" ? currentRepoOverlayText(cwd) : currentUserText());
    const repoNow = pending.destination === "repo" ? destinationNow : currentRepoOverlayText(cwd);
    const userNow = pending.destination === "user" ? destinationNow : currentUserText();
    if (repoNow !== pending.repo) {
      return `stale preview — the repository overlay ${repoPath} changed after the review diff was rendered; press w to review what would be written now`;
    }
    if (userNow !== pending.user) {
      return `stale preview — the user overlay ${userPath} changed after the review diff was rendered; press w to review what would be written now`;
    }
    const lower = lowerLayers(pending.destination);
    if (!lower.ok) return lower.error;
    try {
      if (renderFleetOverlayWrite(destinationNow, { ...pending.write, lowerOverrides: lower.overrides }) === reviewed) return null;
    } catch (error) {
      return (error as Error).message;
    }
    return `stale preview — the overlay ${pending.path} or a lower config layer changed after the review diff was rendered; press w to review what would be written now`;
  };
  // B2: a saved user key the repository overlay also decides does not apply in THIS repository —
  // each is named with the value that still applies here, never reported as applied.
  const repoShadowNotes = (before: string, after: string): string[] =>
    repoShadowedUserKeys(cwd, before, after, { globalDir }).map(({ path, value }) => {
      const shown = value === undefined ? "absent" : typeof value === "string" ? value : JSON.stringify(value);
      return `repo-shadowed: ${path} stays ${shown} in this repository — ${repoPath} sets it above the user overlay`;
    });
  const reviewOverlay = (state: FleetEditorState): FleetOverlayReview => {
    // B2: a review re-reads every layer, so no preview rendered before it is served after it
    candidateMemo.clear();
    const staged = structuredClone(initial) as FleetEditable;
    // OBS-994/FL-1, OBS-1099 add.1: every schema-enumerated deny scope rides the same review/write funnel
    for (const scope of DENY_SCOPES) staged[scope.key] = state[scope.key];
    staged.allowOut = state.allowOut ?? initial.allowOut;
    staged.map = state.map;
    const metadata = stagedMetadataOf(state);
    staged.tiers = metadata.tiers;
    if (metadata.efforts) staged.efforts = metadata.efforts;
    else delete staged.efforts;
    reviewedStage = metadata;

    // This callback is the sole candidate-overlay builder. The Ink component renders
    // the diff and asks for confirmation, but owns neither filesystem access nor a writer.
    // B2: defaults/user/repo are re-read here, at review. T10: so is the destination.
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
    const chosen = chooseDestination(destinationEdits(staged, metadata.seeds, [
      ...(modeChanged ? ["routing.mode"] : []),
      ...(steeringChanged ? ["review/consult prefer"] : []),
      ...(judgeChanged ? ["judge"] : []),
    ]));
    if (!chosen.ok) {
      pendingWrite = null;
      return { kind: "refused", reason: chosen.reason };
    }
    const destination = chosen.destination;
    const user = currentUserText();
    const repo = currentRepoOverlayText(cwd);
    const before = destination === "repo" ? repo : user;
    const path = pathOf(destination);
    const lower = lowerLayers(destination);
    if (lower.ok) lowerOverrides[destination] = lower.overrides;
    let write: FleetOverlayWrite;
    let after: string;
    try {
      write = layerWrite(staged, metadata.seeds, destination, before, {
        lowerOverrides: lowerOverrides[destination],
        ...(modeChanged ? { mode: state.selectedMode } : {}),
        ...(judgeChanged && judgeSeat ? { judge: judgeSeat } : {}),
        steering: { initial: initialSteering, edited: state.steering },
      });
      after = renderFleetOverlayWrite(before, write); // T10 (D-987): a merge-key path refuses here
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      pendingWrite = null;
      return { kind: "refused", reason: error.message };
    }
    if (before === after) {
      pendingWrite = null;
      return { kind: "empty" };
    }
    pendingWrite = { write, repo, user, destination, path };
    // OBS-1144: the review names every dead pool entry the written config carries, with its reason and
    // what still routes — before y. Unloadable bytes carry no notes: the reload guard refuses them anyway.
    let poolNotes: string[] = [];
    try {
      const written = loadConfigWithMode(cwd, { globalDir, ...layerOf(destination, after) }).cfg;
      poolNotes = deadPoolEntries(written, undefined, health).map(deadPoolEntryLine);
    } catch {
      poolNotes = [];
    }
    const notes = [
      // T10: the review names where the edit lands and what that file is
      ...(destination === "repo" ? [REPO_DESTINATION_NOTE(repoPath)] : repoShadowNotes(before, after)),
      FUTURE_LOADS_NOTE,
      ...(lower.ok ? [] : [`${lower.error} — y will be refused`]),
      ...poolNotes,
    ];
    return {
      kind: "diff",
      before,
      after,
      diff: unifiedYamlDiff(before, after, path),
      path,
      notes,
    };
  };
  // B2: every repository inherits the user overlay, so its bytes must load here AND on their own —
  // a tiers entry whose vendor/channel only this repository declares would break every other one.
  // T10: repository bytes load through the same loader in the repository layer.
  const loaderGuard = (destination: Destination) => io.reloadGuard
    ?? ((bytes: string) => {
      if (destination === "repo") return overlayBytesLoadError(cwd, bytes, { globalDir, layer: "repo" });
      const here = overlayBytesLoadError(cwd, bytes, { globalDir, layer: "user" });
      if (here !== null) return here;
      const alone = overlayBytesLoadError(cwd, bytes, { globalDir, layer: "user", repoOverlayText: "" });
      return alone === null ? null
        : `the user overlay ${userPath} loads only beside ${repoPath} — every repository inherits it, and without that overlay it fails: ${alone}`;
    });
  // OBS-1188: a stale preview or an unreadable lower layer answers on the same error channel as the loader
  const reloadGuard = (bytes: string) =>
    (pendingWrite && stalePreview(pendingWrite, bytes)) || loaderGuard(pendingWrite?.destination ?? "user")(bytes);

  const props: FleetEditorProps = {
    ageMs: doctorAgeMs(cwd),
    adapters,
    health,
    ...Object.fromEntries(DENY_SCOPES.map((scope) => [initialDenyPropOf(scope), editable[scope.key] ?? []])),
    initialAllowOut: editable.allowOut,
    initialEfforts: editable.efforts,
    modelGroups,
    initialMode: rm.mode.mode,
    modeOptions: ROUTING_MODES.map((mode) => ({ id: mode, gloss: MODE_GLOSS[mode] })),
    initialMap: editable.map,
    modePreview: (mode, map, deny, stage) => [modeSpend(mode, map, deny, stage), ...floorPreview(mode, map, deny, stage)],
    shapeRows: routedShapeRows,
    candidatesForShape,
    preferOptionsForShape: (_shape, current) => [
      ...preferUniverse,
      ...current.filter((entry) => !preferUniverse.includes(entry)),
    ],
    initialSteering,
    steeringOptionsFor,
    reviewAdvisories,
    reviewOverlay,
    reloadGuard,
    stagedRouting,
    holderOf,
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
    const pending = pendingWrite;
    if (!pending) throw new Error("fleet write reached confirmation without a staged overlay mutation");
    const write = pending.write;
    // OBS-1188: re-checked against the bytes on disk at write time; a refusal throws before the temp file exists.
    // T10: the one destination is the one the review confirmed, and bytes the loader refuses never land there.
    try {
      writeFleetOverlay(pending.path, (prior) => {
        const refusal = result.review.path === pending.path
          ? stalePreview(pending, result.review.after, prior) ?? loaderGuard(pending.destination)(result.review.after)
          : `the reviewed destination ${result.review.path} is not the staged destination ${pending.path}`;
        if (refusal !== null) throw new ConfigError(refusal);
        return result.review.after;
      });
    } catch (error) {
      if (error instanceof ConfigError) return `fleet: nothing written — ${error.message}`;
      throw error;
    }
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
    // B2: a repo-shadowed save says what still applies here — never claimed applied
    const head = [`fleet: wrote ${pending.path}`, ...(pending.destination === "user"
      ? repoShadowNotes(result.review.before, result.review.after).map((note) => `fleet: ${note}`)
      : [])].join("\n");
    if (!unprobed.length) return head;
    const named = unprobed.slice(0, 3).join(", ") + (unprobed.length > 3 ? `, +${unprobed.length - 3} more` : "");
    return `${head}\nfleet: ${unprobed.length} newly classified model(s) have no probe verdict yet (${named}) — run \`tickmarkr fleet --fresh\` to probe them; unverified models stay unroutable`;
  };

  return {
    props,
    commit,
    renderWhy: () => renderFleetWhy(projectedShapeRows(rm.mode.mode, editable.map, stagedDenyOf(editable))),
    // T8: the memoized candidate every preview callback ranks — read-only, so its identity is checkable
    previewConfig: previewCfg,
  };
}
