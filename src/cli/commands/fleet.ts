import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters, discoverChannels, doctorAgeMs, initDoctorReuse, readAutoPrefer } from "../../adapters/registry.js";
import { fleetUnclassifiedModels } from "../../adapters/model-lints.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import {
  fleetEditableFromConfig,
  fleetEditableEquals,
  fleetRepoOverlayFromDelta,
  formatFleetPrint,
  globalConfigDir,
  harvestFleetProvenance,
  overlayBytesLoadError,
  overlayPreferShapes,
  readOverlayFile,
  repoOverlayPath,
  repoOverlayYaml,
  ROUTING_MODES,
  type FleetEditable,
  type MapEntry,
  type RoutingMode,
  type Tier,
  unifiedYamlDiff,
} from "../../config/config.js";
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

function provenanceMap(editable: FleetEditable): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [adapter, models] of Object.entries(editable.tiers)) {
    for (const [model, v] of Object.entries(models)) {
      if (v?.provenance) {
        out[adapter] ??= {};
        out[adapter][model] = v.provenance;
      }
    }
  }
  return out;
}

// v1.51 T4: serializeFleetOverlay predates routing.mode — splice the mode line under routing:
// so a repo-declared mode survives fleet writes and a mode selection lands as routing.mode.
function withModeLine(yaml: string, mode: RoutingMode | undefined): string {
  if (!mode) return yaml;
  if (/^routing:$/m.test(yaml)) return yaml.replace(/^routing:$/m, `routing:\n  mode: ${mode}`);
  return `routing:\n  mode: ${mode}\n${yaml}`;
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
      "global-dir": { type: "string" },
      fresh: { type: "boolean" },
    },
  });
  const globalDir = values["global-dir"] ?? globalConfigDir();
  const print = values.print ?? false;
  const input = io.input ?? (process.stdin as FleetInput);
  const output = io.output ?? (process.stdout as FleetOutput);
  const interactive = input.isTTY === true && output.isTTY === true;

  if (print) {
    // v1.51 T4: the print surface names the mode and its source layer right under the header —
    // comment-prefixed so the YAML body stays machine-parseable and regex-stable.
    const rm = resolveRunMode(cwd, { globalDir });
    const body = formatFleetPrint(cwd, { globalDir });
    const nl = body.indexOf("\n");
    return `${body.slice(0, nl)}\n# mode: ${rm.mode.mode} (${rm.source})${body.slice(nl)}`;
  }

  if (!interactive) return { out: NON_TTY_MSG, code: 1 };

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
  // OBS-88: harvest existing `# note` comments from the overlay bytes at session load — the
  // session must know about every prior note, not only its own edits, or the next write strips them
  const harvested = harvestFleetProvenance(currentRepoOverlayText(cwd));
  const initial = fleetEditableFromConfig(cfg, harvested.tiers);
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
  const autoPrefer = readAutoPrefer(cwd);
  const overlayShapes = overlayPreferShapes(cwd, { globalDir });
  const routedShapeRows = (mode: RoutingMode, map: Record<string, MapEntry>) =>
    SHAPES.map((shape) => {
      let now: string;
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
        now = `${assignment.adapter}:${assignment.model} (${assignment.channel}, ${assignment.tier})  ${costSignal(assignment, cfg.pricing)}`;
      } catch (error) {
        now = (error as Error).message;
      }
      const auto = autoPrefer?.[shape] && !overlayShapes.has(shape) ? "  (auto-prefer active)" : "";
      return { id: shape, label: `${shape}  →  ${now}${auto}` };
    });
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
    const existing = readOverlayFile(path);
    const modeChanged = state.selectedMode !== rm.mode.mode;
    const writeMode = modeChanged
      ? state.selectedMode
      : (existing as { routing?: { mode?: RoutingMode } }).routing?.mode;
    const merged = fleetEditableEquals(initial, staged)
      ? (structuredClone(existing) as Record<string, unknown>)
      : fleetRepoOverlayFromDelta(initial, staged, existing);
    let steeringChanged = false;
    for (const key of ["review", "consult"] as const) {
      if (JSON.stringify(state.steering[key]) === JSON.stringify(initialSteering[key])) continue;
      steeringChanged = true;
      const block = { ...(merged[key] as Record<string, unknown> | undefined) };
      if (state.steering[key]) block.prefer = state.steering[key];
      else delete block.prefer;
      if (Object.keys(block).length) merged[key] = block;
      else delete merged[key];
    }
    const tierNotes = structuredClone(harvested.tiers);
    for (const [adapter, models] of Object.entries(provenanceMap(staged))) {
      for (const [model, note] of Object.entries(models)) {
        (tierNotes[adapter] ??= {})[model] = note;
      }
    }
    const after = withModeLine(
      repoOverlayYaml(merged, tierNotes, {
        adapters: harvested.denyAdapters,
        models: harvested.denyModels,
      }),
      writeMode,
    );
    if ((!modeChanged && !steeringChanged && fleetEditableEquals(initial, staged)) || before === after) {
      return { kind: "empty" };
    }
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
  mkdirSync(dirname(result.review.path), { recursive: true });
  writeFileSync(result.review.path, result.review.after);
  return `fleet: wrote ${result.review.path}`;
}
