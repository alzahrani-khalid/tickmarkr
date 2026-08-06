import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters, discoverChannels, doctorAgeMs, initDoctorReuse } from "../../adapters/registry.js";
import { fleetUnclassifiedModels } from "../../adapters/model-lints.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import {
  fleetEditableFromConfig,
  fleetEditableEquals,
  formatFleetPrint,
  globalConfigDir,
  overlayBytesLoadError,
  renderFleetOverlayWrite,
  repoOverlayPath,
  ROUTING_MODES,
  type FleetOverlayWrite,
  type FleetEditable,
  type MapEntry,
  type RoutingMode,
  type Tier,
  unifiedYamlDiff,
} from "../../config/config.js";
import { projectFleetWhy, renderFleetWhy, type FleetWhyValue } from "../../config/fleet-why.js";
import { SHAPES, TIERS, type Shape, type Task } from "../../graph/schema.js";
import { candidateRow, costSignal, shapeCandidates } from "./fleet-picker.js";
import { route } from "../../route/router.js";
import { resolveRunMode, type ResolvedRunMode } from "../../run/daemon.js";
import { loadRoutingProfile } from "../../run/journal.js";
import type {
  FleetEditorState,
  FleetOverlayReview,
  FleetSteeringKey,
} from "../../tui/ink/fleet-app.js";

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
      print: { type: "boolean" },
      why: { type: "boolean" },
      "global-dir": { type: "string" },
      fresh: { type: "boolean" },
    },
  });
  const globalDir = values["global-dir"] ?? globalConfigDir();
  const print = values.print ?? false;
  const why = values.why ?? false;
  const input = io.input ?? (process.stdin as FleetInput);
  const output = io.output ?? (process.stdout as FleetOutput);
  const interactive = input.isTTY === true && output.isTTY === true;

  if (print) {
    // v1.51 T4: the print surface names the mode and its source layer right under the header —
    // comment-prefixed so the YAML body stays machine-parseable and regex-stable.
    const rm = resolveRunMode(cwd, { globalDir });
    const body = formatFleetPrint(cwd, { globalDir });
    const nl = body.indexOf("\n");
    // Steering comes from the same resolved config snapshot the editor consumes below,
    // not from another parse of either raw overlay.
    return `${body.slice(0, nl)}\n# mode: ${rm.mode.mode} (${rm.source})${body.slice(nl)}${formatFleetSteering(rm.cfg)}`;
  }

  if (!why && !interactive) return { out: NON_TTY_MSG, code: 1 };

  const fresh = values.fresh ?? false;
  const { reuse, health: cached } = initDoctorReuse(cwd, fresh);
  if (!reuse || !cached) {
    return {
      out: "tickmarkr fleet: probe data missing or stale — run `tickmarkr doctor` first (fleet never re-probes; doctor is the sensor)",
      code: 1,
    };
  }

  const rm = resolveRunMode(cwd, { globalDir });
  const cfg = rm.cfg;
  const initial = fleetEditableFromConfig(cfg);
  const editable = structuredClone(initial) as FleetEditable;
  const health = cached;
  const modelGroups = adapters
    .filter((adapter) => health[adapter.id]?.installed)
    .map((adapter) => {
      const unclassified = fleetUnclassifiedModels(cfg, health, adapters).filter((row) => row.adapter === adapter.id);
      return {
        adapter: adapter.id,
        rows: [
          ...Object.entries(editable.tiers[adapter.id] ?? {}).map(([model, value]) => ({ model, tier: value?.tier })),
          ...unclassified
            .filter((row) => !editable.tiers[adapter.id]?.[row.model])
            .map((row) => ({ model: row.model, detectedAt: row.detectedAt })),
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
  const previewCfg = (mode: RoutingMode, map: Record<string, MapEntry>) => ({
    ...cfg,
    routing: { ...cfg.routing, map, floors: modeCfgs[mode].cfg.routing.floors },
  });
  const modeSpend = (mode: RoutingMode, map: Record<string, MapEntry>): string => {
    const tierCount: Partial<Record<Tier, number>> = {};
    let subs = 0;
    let apiN = 0;
    let apiUsd = 0;
    for (const shape of SHAPES) {
      try {
        const assignment = route(
          previewTask(shape),
          previewCfg(mode, map),
          channels,
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
  const projectedShapeRows = (mode: RoutingMode, map: Record<string, MapEntry>) => {
    const values: FleetWhyValue<Shape>[] = SHAPES.map((shape) => {
      try {
        const routed = route(
          previewTask(shape),
          previewCfg(mode, map),
          channels,
          profile,
          undefined,
          undefined,
          PREVIEW_EXPLORE,
        );
        const assignment = routed.assignment;
        const effective = `${assignment.adapter}:${assignment.model} (${assignment.channel}, ${assignment.tier})  ${costSignal(assignment, cfg.pricing)}`;
        const mapProducedValue = map[shape]?.pin !== undefined || routed.provenance.includes("via prefer");
        return {
          id: shape,
          effective,
          ...whyDeclaration(shape, mode, map, mapProducedValue),
        };
      } catch (error) {
        const mapProducedValue = map[shape]?.pin !== undefined || (map[shape]?.prefer?.length ?? 0) > 0;
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
  const routedShapeRows = (mode: RoutingMode, map: Record<string, MapEntry>) =>
    projectedShapeRows(mode, map).map(({ id, label }) => ({ id, label }));
  if (why) return renderFleetWhy(projectedShapeRows(rm.mode.mode, editable.map));
  const candidatesForShape = (shape: Shape, mode: RoutingMode, map: Record<string, MapEntry>) =>
    shapeCandidates(previewTask(shape), previewCfg(mode, map), channels, profile).map((candidate) => ({
      id: `${candidate.assignment.adapter}:${candidate.assignment.model}`,
      label: candidateRow(candidate, cfg.pricing),
      pin: { via: candidate.assignment.adapter, model: candidate.assignment.model },
    }));
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
  let pendingWrite: FleetOverlayWrite | null = null;
  const reviewOverlay = (state: FleetEditorState): FleetOverlayReview => {
    const staged = structuredClone(initial) as FleetEditable;
    staged.denyAdapters = state.denyAdapters;
    staged.denyModels = state.denyModels;
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
    if (!modeChanged && !steeringChanged && fleetEditableEquals(initial, staged)) {
      pendingWrite = null;
      return { kind: "empty" };
    }
    const write: FleetOverlayWrite = {
      initial,
      edited: staged,
      ...(modeChanged ? { mode: state.selectedMode } : {}),
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

  // Keep Ink out of print, non-TTY, and missing-probe paths: the component runtime belongs
  // exclusively to the interactive editor.
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
  const result = await runFleetInkEditor({
    ageMs: doctorAgeMs(cwd),
    adapters,
    health,
    initialDenyAdapters: editable.denyAdapters,
    initialDenyModels: editable.denyModels,
    modelGroups,
    initialMode: rm.mode.mode,
    modeOptions: ROUTING_MODES.map((mode) => ({ id: mode, gloss: MODE_GLOSS[mode] })),
    initialMap: editable.map,
    modePreview: (mode, map) => [modeSpend(mode, map), ...floorPreview(mode)],
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
    initialInput,
    input: input as NodeJS.ReadStream,
    output: output as NodeJS.WriteStream,
    debug: io.debug,
  });
  if (result.kind === "quit") return QUIT;
  if (result.kind === "refresh") {
    return "fleet: run `tickmarkr doctor` to refresh probe data, then re-run `tickmarkr fleet` (doctor is the sensor; fleet never re-probes)";
  }
  if (result.kind === "no-changes") return "fleet: no overlay changes (empty diff)";
  if (result.kind === "discard") return "fleet: discarded overlay changes";

  // The command remains the single config actuator. Every interactive edit reaches this
  // one write only after the component-rendered diff confirm and the production reload guard.
  const write = pendingWrite;
  if (!write) throw new Error("fleet write reached confirmation without a staged overlay mutation");
  writeFleetOverlay(result.review.path, (prior) => renderFleetOverlayWrite(prior, write));
  return `fleet: wrote ${result.review.path}`;
}
