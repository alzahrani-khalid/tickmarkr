import { allAdapters, discoverChannels, readDoctor } from "../../adapters/registry.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import { costSignal } from "../../cli/commands/fleet-picker.js";
import { loadGraph } from "../../graph/graph.js";
import { SHAPES, type Shape, type Task } from "../../graph/schema.js";
import { route, RoutingError } from "../../route/router.js";
import { resolveRunMode } from "../../run/daemon.js";
import { loadRoutingProfile } from "../../run/journal.js";
import type { View } from "../app.js";

export type PreviewViewDeps = {
  cwd?: string;
  adapters?: WorkerAdapter[];
};

// Same exploration setting as the candidate picker (rankCandidates routes noExplore so repeated
// calls agree): a due probe must never make a preview row disagree with the picker's rank-1 for
// the same graph and channel set. Mirrors fleet.ts's PREVIEW_EXPLORE.
const PREVIEW_EXPLORE = { noExplore: true } as const;

// The no-graph stand-in: one synthetic task per shape so the consequence surface still shows what
// the router WOULD do with this fleet. Same shape as fleet.ts's previewTask.
function syntheticTask(shape: Shape): Task {
  return {
    id: `preview-${shape}`,
    title: `${shape} preview`,
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

// The consequence surface: the routing table a plan dry-run would produce, one row per task with
// the chosen channel, the route()'s why-provenance verbatim, and the picker's cost signal. Every
// render re-reads graph/config/doctor cache from disk (refresh on demand = repaint); the render
// path is strictly read-only — doctor cache only, never probeAll, so a preview spends no tokens
// and invokes no agent. Unroutable rows render the RoutingError in place, like plan's `!!` rows.
function renderPreview(deps: PreviewViewDeps): string[] {
  const cwd = deps.cwd ?? process.cwd();
  const adapters = deps.adapters ?? allAdapters();
  let graph = null as ReturnType<typeof loadGraph> | null;
  try {
    graph = loadGraph(cwd);
  } catch {
    graph = null; // absent or invalid — fall through to the synthetic per-shape set
  }
  const { cfg, mode, source } = resolveRunMode(cwd, { spec: graph?.mode });
  const cached = readDoctor(cwd);
  const channels = discoverChannels(cfg, adapters, cached ?? {});
  const profile = loadRoutingProfile(cwd, cfg, { preview: true });
  const tasks: Task[] = graph ? graph.tasks : SHAPES.map(syntheticTask);

  const lines: string[] = [
    "Preview view — plan dry run (read-only: no writes, no probes, no token spend)",
    graph
      ? `source: compiled graph (${tasks.length} task${tasks.length === 1 ? "" : "s"}) · mode: ${mode.mode} (${source}) · explore off (picker parity) · ${channels.length} channels`
      : `source: no compiled graph — synthetic per-shape task set (${tasks.length} shapes) · mode: ${mode.mode} (${source}) · explore off (picker parity) · ${channels.length} channels`,
  ];
  if (!cached) lines.push("doctor cache missing — rows route against zero channels; run `tickmarkr doctor` (the preview never probes)");
  lines.push("");

  for (const t of tasks) {
    try {
      const r = route(t, cfg, channels, profile, undefined, undefined, PREVIEW_EXPLORE);
      const a = r.assignment;
      lines.push(`  ${t.id.padEnd(16)} ${t.shape.padEnd(10)} → ${a.adapter}:${a.model} [${a.channel}/${a.tier}]  ${costSignal(a, cfg.pricing)}  — ${r.provenance}`);
    } catch (e) {
      if (!(e instanceof RoutingError)) throw e;
      lines.push(`  ${t.id.padEnd(16)} ${t.shape.padEnd(10)} !! ${e.message}`);
    }
  }
  return lines;
}

export function createPreviewView(deps: PreviewViewDeps = {}): View {
  return {
    id: "preview",
    label: "Preview",
    render: () => renderPreview(deps),
  };
}
