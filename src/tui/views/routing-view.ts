import { type BillingChannel, channelsFromConfig } from "../../adapters/types.js";
import { candidateRow, shapeCandidates } from "../../cli/commands/fleet-picker.js";
import {
  DEFAULT_CONFIG,
  fleetEditableFromConfig,
  INTEGRITY_FLOOR_SHAPES,
  loadConfigWithMode,
  ROUTING_MODES,
  TIER_RANK,
  type FleetEditable,
  type RoutingMode,
  type TickmarkrConfig,
  type Tier,
} from "../../config/config.js";
import { SHAPES, type Shape, type Task } from "../../graph/schema.js";
import type { RankedCandidate } from "../../route/candidates.js";
import type { RoutingProfile } from "../../route/profile.js";
import { FleetStaging } from "../staging.js";
import type { View } from "../app.js";

// v1.66 T4 + v1.67 T2: the Routing tab — per-shape policy grid (floor / pin / prefer chain under
// the active mode) plus a candidate inspector ranking through the fleet picker's shared glue
// (shapeCandidates + candidateRow), so the studio never disagrees with the router.
// Every change stages through the FleetStaging model (staging.apply / staging.revert) — the view
// holds navigation state only (cursors, a derived row cache), never private edit state, and
// nothing touches disk. Staged cells render marked ●; revert clears the marks. A mode stages
// compiled into its preset floor table — the only tier authority the router sees.

export type RoutingViewData = {
  cfg: TickmarkrConfig;
  channels: BillingChannel[];
  /** active routing mode for the header; absent ⇒ cfg.routing.mode ?? "risk-based" */
  mode?: RoutingMode;
  profile?: RoutingProfile;
};

export type RoutingViewDeps = {
  /** injected fixture data — with data present the render path never touches the filesystem */
  data?: RoutingViewData;
  /** where the no-arg studio shell loads config from (default: process.cwd()) */
  repoRoot?: string;
  /** shared staged-changes buffer; default derives one from data.cfg — edits never leave it */
  staging?: FleetStaging;
};

export type RoutingView = View & {
  /** open the candidate inspector for a shape (default: the selected grid row) */
  openInspector(shape?: Shape): void;
  closeInspector(): void;
  moveCursor(delta: number): void;
  /** move the inspector's candidate highlight (wraps) */
  moveInspectorCursor(delta: number): void;
  /** stage the highlighted inspector candidate as that shape's map pin */
  stageInspectorPin(): void;
  /** stage a floor tier for the selected grid shape */
  stageFloor(tier: Tier): void;
  /** stage a prefer chain for the selected grid shape ([] clears the chain) */
  stagePrefer(chain: string[]): void;
  /** stage a routing mode — compiles into the preset's floor table in the buffer */
  stageMode(mode: RoutingMode): void;
  /** discard every staged edit (delegates to the staging model) */
  revert(): void;
  readonly selectedShape: Shape;
  /** mode derived from the buffer: loaded mode, a staged preset, or "custom" — never stored */
  readonly selectedMode: RoutingMode | "custom";
  /** the staging model every change flows through */
  readonly staging: FleetStaging;
  /** the inspector's candidate rows — the picker's candidateRow strings, in rank order */
  inspectorRows(): string[] | null;
};

// Same preview task fleet.ts's picker ranks (one per shape, complexity 3): the inspector must
// rank the exact inputs the fleet editor ranks, or the two surfaces could disagree.
export function routingPreviewTask(shape: Shape): Task {
  return {
    id: "routing-preview",
    title: "routing preview",
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

const isIntegrity = (shape: string): boolean => (INTEGRITY_FLOOR_SHAPES as readonly string[]).includes(shape);

// Staged-cell glyph — the same ● the shell status bar counts staged changes with (app.ts).
const STAGED_MARK = "●";

const lowerTier = (t: Tier): Tier => (t === "frontier" ? "mid" : "cheap");
const maxTier = (a: Tier, b: Tier): Tier => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);

// config.ts presetFloor mirrored (module-private there): a mode compiles into floors at load,
// so staging a mode stages exactly this table.
function presetFloor(mode: RoutingMode, shape: Shape): Tier {
  const dflt = DEFAULT_CONFIG.routing.floors[shape] ?? "cheap";
  if (mode === "partner-led") return "frontier";
  if (mode === "staff-led") return maxTier(lowerTier(dflt), isIntegrity(shape) ? "frontier" : "cheap");
  return dflt;
}

function floorsEqual(a: Record<string, Tier>, b: Record<string, Tier>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/** The header mode is DERIVED from the buffer, never stored: clean floors show the loaded mode;
 *  floors matching a preset show that mode (staged); anything else reads "custom". */
function deriveMode(
  loadedMode: RoutingMode,
  loaded: FleetEditable,
  buffer: FleetEditable,
): { mode: RoutingMode | "custom"; staged: boolean } {
  if (floorsEqual(loaded.floors, buffer.floors)) return { mode: loadedMode, staged: false };
  for (const mode of ROUTING_MODES) {
    if (SHAPES.every((s) => buffer.floors[s] === presetFloor(mode, s))) return { mode, staged: true };
  }
  return { mode: "custom", staged: true };
}

/** The config the router would see with the staged policy applied: map + floors ride the buffer
 *  (deny/tier edits are the fleet view's lane, T3). The buffer snapshot is already detached. */
function effectiveConfig(cfg: TickmarkrConfig, buffer: FleetEditable): TickmarkrConfig {
  return { ...cfg, routing: { ...cfg.routing, map: buffer.map, floors: buffer.floors } };
}

// No-arg shell path (app.ts constructs views without deps): load the operator's resolved config
// and derive channels from the configured tier table. Best-effort — a load failure degrades the
// view to an explanatory note instead of breaking the studio.
function loadDefaultData(repoRoot: string): RoutingViewData | null {
  try {
    const { cfg, mode } = loadConfigWithMode(repoRoot);
    const channels = Object.keys(cfg.tiers).flatMap((id) => channelsFromConfig(id, cfg));
    return { cfg, channels, mode: mode.mode };
  } catch {
    return null;
  }
}

export function createRoutingView(deps: RoutingViewDeps = {}): RoutingView {
  const data = deps.data ?? loadDefaultData(deps.repoRoot ?? process.cwd());
  // The one edit authority: every mutating method below is a staging.apply()/revert() over this
  // buffer, so a staged change can never hide in private view state.
  const staging =
    deps.staging ??
    new FleetStaging(
      data ? fleetEditableFromConfig(data.cfg) : { denyAdapters: [], denyModels: [], tiers: {}, map: {}, floors: {} },
    );
  let cursor = 0;
  let inspector: { shape: Shape; cursor: number; ranked: RankedCandidate[] } | null = null;

  const rankInspector = (shape: Shape): RankedCandidate[] => {
    if (!data) return [];
    // THE parity seam: rank through the same shared picker glue the fleet editor uses — no
    // comparator lives here. Clean buffer ⇒ the injected config by reference (the delegation
    // tests pin that identity); staged edits ⇒ the effective config, what the router would
    // choose given the staged inputs.
    const cfgNow = staging.isDirty ? effectiveConfig(data.cfg, staging.current) : data.cfg;
    return shapeCandidates(routingPreviewTask(shape), cfgNow, data.channels, data.profile);
  };

  const rowOf = (c: RankedCandidate): string => candidateRow(c, data?.cfg.pricing ?? {});

  // Re-rank the open inspector after a staging mutation changed the ranking inputs.
  const refreshInspector = (): void => {
    if (!inspector) return;
    inspector.ranked = rankInspector(inspector.shape);
    inspector.cursor = Math.min(inspector.cursor, Math.max(inspector.ranked.length - 1, 0));
  };

  return {
    id: "routing",
    label: "Routing",
    get selectedShape(): Shape {
      return SHAPES[cursor];
    },
    get selectedMode(): RoutingMode | "custom" {
      const loadedMode = data?.mode ?? data?.cfg.routing.mode ?? "risk-based";
      return deriveMode(loadedMode, staging.loadedState, staging.current).mode;
    },
    get staging(): FleetStaging {
      return staging;
    },
    moveCursor(delta: number): void {
      cursor = (cursor + delta + SHAPES.length) % SHAPES.length;
    },
    moveInspectorCursor(delta: number): void {
      if (!inspector || inspector.ranked.length === 0) return;
      const n = inspector.ranked.length;
      inspector.cursor = (inspector.cursor + delta + n) % n;
    },
    openInspector(shape?: Shape): void {
      if (!data) return;
      const target = shape ?? SHAPES[cursor];
      inspector = { shape: target, cursor: 0, ranked: rankInspector(target) };
    },
    closeInspector(): void {
      inspector = null;
    },
    stageInspectorPin(): void {
      if (!data || !inspector) return;
      const target = inspector.shape;
      const chosen = inspector.ranked[inspector.cursor];
      if (!chosen) return;
      const { adapter, model } = chosen.assignment;
      staging.apply((buffer) => {
        buffer.map[target] = { ...buffer.map[target], pin: { via: adapter, model } };
      });
      // No re-rank: shapeCandidates strips the shape's own pin from the ranking inputs.
    },
    stageFloor(tier: Tier): void {
      if (!data) return;
      const target = SHAPES[cursor];
      staging.apply((buffer) => {
        buffer.floors[target] = tier;
      });
      refreshInspector();
    },
    stagePrefer(chain: string[]): void {
      if (!data) return;
      const target = SHAPES[cursor];
      staging.apply((buffer) => {
        const entry = { ...buffer.map[target] };
        if (chain.length) entry.prefer = [...chain];
        else delete entry.prefer;
        // an emptied entry leaves no phantom delta behind
        if (Object.keys(entry).length) buffer.map[target] = entry;
        else delete buffer.map[target];
      });
      refreshInspector();
    },
    stageMode(mode: RoutingMode): void {
      if (!data) return;
      staging.apply((buffer) => {
        for (const shape of SHAPES) buffer.floors[shape] = presetFloor(mode, shape);
      });
      refreshInspector();
    },
    revert(): void {
      staging.revert();
      refreshInspector();
    },
    inspectorRows(): string[] | null {
      return inspector ? inspector.ranked.map(rowOf) : null;
    },
    render: (): string[] => {
      const lines: string[] = ["Routing view — per-shape policy grid"];
      if (!data) {
        lines.push("routing data unavailable — see `tickmarkr fleet --print` for the line-mode surface");
        return lines;
      }
      const { cfg } = data;
      const buffer = staging.current;
      const loaded = staging.loadedState;
      const loadedMode = data.mode ?? cfg.routing.mode ?? "risk-based";
      const { mode, staged: modeStaged } = deriveMode(loadedMode, loaded, buffer);
      lines.push(`mode: ${mode}${modeStaged ? ` ${STAGED_MARK} (staged)` : ""}`);
      lines.push(`  ${"shape".padEnd(10)}${"floor".padEnd(10)}${"pin".padEnd(20)}prefer`);
      for (const [i, shape] of SHAPES.entries()) {
        const entry = buffer.map[shape];
        const loadedEntry = loaded.map[shape];
        const floor = buffer.floors[shape] ?? "—";
        const floorStaged = loaded.floors[shape] !== buffer.floors[shape];
        const marker = isIntegrity(shape) ? "*" : "";
        const pin = entry?.pin ? `${entry.pin.via}:${entry.pin.model}` : "—";
        const prefer = entry?.prefer?.length ? entry.prefer.join(", ") : "—";
        const pinStaged = JSON.stringify(loadedEntry?.pin ?? null) !== JSON.stringify(entry?.pin ?? null);
        const preferStaged = JSON.stringify(loadedEntry?.prefer ?? null) !== JSON.stringify(entry?.prefer ?? null);
        const sel = i === cursor ? "❯" : " ";
        const floorCell = `${floor}${marker}${floorStaged ? STAGED_MARK : ""}`.padEnd(10);
        const pinCell = `${pin}${pinStaged ? STAGED_MARK : ""}`.padEnd(20);
        const preferCell = `${prefer}${preferStaged ? STAGED_MARK : ""}`;
        lines.push(`${sel} ${shape.padEnd(10)}${floorCell}${pinCell}${preferCell}`);
      }
      lines.push("* integrity set: never below frontier");
      if (staging.isDirty) lines.push(`${STAGED_MARK} staged — not saved`);
      lines.push(`pick: ${SHAPES[cursor]} — enter opens the candidate inspector`);
      if (inspector) {
        lines.push(`─ candidates: ${inspector.shape} — the fleet picker ranking for the same inputs ──`);
        if (inspector.ranked.length === 0) lines.push("  (no routable candidates)");
        for (const [j, c] of inspector.ranked.entries()) {
          lines.push(`${j === inspector.cursor ? "❯ " : "  "}${rowOf(c)}`);
        }
        lines.push("select stages the highlighted candidate as this shape's pin");
      }
      return lines;
    },
  };
}
