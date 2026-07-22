import { type BillingChannel, channelsFromConfig } from "../../adapters/types.js";
import { candidateRow, shapeCandidates } from "../../cli/commands/fleet-picker.js";
import {
  INTEGRITY_FLOOR_SHAPES,
  loadConfigWithMode,
  type RoutingMode,
  type TickmarkrConfig,
} from "../../config/config.js";
import { SHAPES, type Shape, type Task } from "../../graph/schema.js";
import type { RoutingProfile } from "../../route/profile.js";
import type { View } from "../app.js";

// v1.66 T4: the Routing tab — the per-shape policy grid (floor / pin / prefer chain under the
// active routing mode) plus a read-only candidate inspector for the selected shape. The inspector
// reuses the fleet picker's shared ranking (fleet-picker.ts shapeCandidates + candidateRow) so the
// studio can never disagree with the router about candidate order, cost signal, or provenance.

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
};

export type RoutingView = View & {
  /** open the read-only candidate inspector for a shape (default: the selected grid row) */
  openInspector(shape?: Shape): void;
  closeInspector(): void;
  moveCursor(delta: number): void;
  readonly selectedShape: Shape;
  /** the inspector's candidate rows — exactly the picker's candidateRow strings, in rank order */
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
  let cursor = 0;
  let inspector: { shape: Shape; rows: string[] } | null = null;

  return {
    id: "routing",
    label: "Routing",
    get selectedShape(): Shape {
      return SHAPES[cursor];
    },
    moveCursor(delta: number): void {
      cursor = (cursor + delta + SHAPES.length) % SHAPES.length;
    },
    openInspector(shape?: Shape): void {
      if (!data) return;
      const target = shape ?? SHAPES[cursor];
      // THE parity seam: rank through the same shared picker glue the fleet editor uses — no
      // comparator lives here — so rows, cost signals, and provenance match the router's choice.
      const ranked = shapeCandidates(routingPreviewTask(target), data.cfg, data.channels, data.profile);
      inspector = { shape: target, rows: ranked.map((c) => candidateRow(c, data.cfg.pricing)) };
    },
    closeInspector(): void {
      inspector = null;
    },
    inspectorRows(): string[] | null {
      return inspector ? [...inspector.rows] : null;
    },
    render: (): string[] => {
      const lines: string[] = ["Routing view — per-shape policy grid (read-only)"];
      if (!data) {
        lines.push("routing data unavailable — see `tickmarkr fleet --print` for the line-mode surface");
        return lines;
      }
      const { cfg } = data;
      const mode = data.mode ?? cfg.routing.mode ?? "risk-based";
      lines.push(`mode: ${mode}`);
      lines.push(`  ${"shape".padEnd(10)}${"floor".padEnd(10)}${"pin".padEnd(20)}prefer`);
      for (const [i, shape] of SHAPES.entries()) {
        const entry = cfg.routing.map[shape];
        const floor = cfg.routing.floors[shape] ?? "—";
        const marker = isIntegrity(shape) ? "*" : "";
        const pin = entry?.pin ? `${entry.pin.via}:${entry.pin.model}` : "—";
        const prefer = entry?.prefer?.length ? entry.prefer.join(", ") : "—";
        const sel = i === cursor ? "❯" : " ";
        lines.push(`${sel} ${shape.padEnd(10)}${`${floor}${marker}`.padEnd(10)}${pin.padEnd(20)}${prefer}`);
      }
      lines.push("* integrity set: never below frontier");
      lines.push(`pick: ${SHAPES[cursor]} — enter opens the candidate inspector (read-only)`);
      if (inspector) {
        lines.push(`─ candidates: ${inspector.shape} — the fleet picker ranking for the same inputs ──`);
        if (inspector.rows.length === 0) lines.push("  (no routable candidates)");
        for (const [j, row] of inspector.rows.entries()) {
          lines.push(`${j === 0 ? "❯ " : "  "}${row}`);
        }
      }
      return lines;
    },
  };
}
