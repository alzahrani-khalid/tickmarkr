import { render, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { allAdapters, doctorAgeMs, readDoctor } from "../../adapters/registry.js";
import { fleetEditableFromConfig, loadConfig } from "../../config/config.js";
import { loadGraph } from "../../graph/graph.js";
import { type RunGraph, type TaskStatus } from "../../graph/schema.js";
import {
  Journal,
  readAllTelemetry,
  RUNS_WINDOW,
  type JournalEvent,
} from "../../run/journal.js";
import { buildSaveProposal, confirmSave, type SaveProposal } from "../save.js";
import { FleetStaging } from "../staging.js";
import {
  DiffConfirmationScreen,
  StudioScreen,
} from "./components.js";

export type StudioInkView = {
  id: string;
  label: string;
  render(props: { cols: number; rows: number }): string[];
  key?(name: string): void;
};

export type StudioInkIO = {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  views?: StudioInkView[];
  repoRoot?: string;
  globalDir?: string;
  staging?: FleetStaging;
  runsData?: RunsCockpitData;
  clock?: () => number;
  debug?: boolean;
};

export type RunsCockpitData = {
  runId?: string;
  events: JournalEvent[];
  graph: RunGraph;
  prompts?: Record<string, string[]>;
};

type DossierVerdict = { action: "retry" | "reroute" | "decompose" | "human"; reason?: string; prompt?: string };
type ConsultDossierData = { taskId: string; verdicts: DossierVerdict[] };
type RunsCockpitTask = { id: string; status: string;
  phase?: string; elapsed?: string; consultCount: number };
const STATUS: Record<string, TaskStatus> = {
  "task-dispatch": "running", "task-done": "done", "task-failed": "failed",
  "task-human": "human", "task-approved": "pending",
};

const HELP = [
  "Key bindings",
  "1-5      switch view",
  "tab      cycle views",
  "?        show this help",
  "esc / q  quit",
  "u        revert staged changes",
  "s        save staged changes",
];

function loadFleetData(repoRoot: string) {
  try {
    const cfg = loadConfig(repoRoot);
    const health = readDoctor(repoRoot);
    if (!health) return undefined;
    const editable = fleetEditableFromConfig(cfg);
    const adapters = allAdapters().flatMap((adapter) => {
      if (!health[adapter.id]?.installed) return [];
      const models = adapter.channels(cfg).map((channel) => ({
        model: channel.model,
        tier: channel.tier,
        channel: channel.channel,
      }));
      return models.length ? [{ adapter: adapter.id, models }] : [];
    });
    return {
      adapters,
      health,
      doctorAgeMs: doctorAgeMs(repoRoot),
      denyAdapters: editable.denyAdapters,
      denyModels: editable.denyModels,
      telemetry: readAllTelemetry(repoRoot, RUNS_WINDOW),
    };
  } catch {
    // Best-effort read surface: line-mode commands remain the diagnostic path when config is unavailable.
    return undefined;
  }
}

function emptyStaging(): FleetStaging {
  return new FleetStaging({
    denyAdapters: [],
    denyModels: [],
    tiers: {},
    map: {},
    floors: {},
  });
}

function loadStaging(repoRoot: string): FleetStaging {
  try {
    return new FleetStaging(fleetEditableFromConfig(loadConfig(repoRoot)));
  } catch {
    return emptyStaging();
  }
}

const componentView = (id: string, label: string, line: string): StudioInkView =>
  ({ id, label, render: () => [line] });
const createView = (id: string, label: string) => (..._: unknown[]) => componentView(id, label, `${label} view`);
const createFleetView = createView("fleet", "Fleet"), createRoutingView = createView("routing", "Routing"),
  createPreviewView = createView("preview", "Preview"), createProfileView = createView("profile", "Profile"),
  createRunsView = createView("runs", "Runs");

function defaultViews(repoRoot: string, staging: FleetStaging): StudioInkView[] {
  return [
    createFleetView(loadFleetData(repoRoot), staging),
    createRoutingView({ repoRoot, staging }),
    createPreviewView({ cwd: repoRoot }),
    createProfileView({ repoRoot }),
    createRunsView(undefined, { repoRoot }),
  ];
}

const emptyGraph = (): RunGraph => ({ version: 1, spec: { source: "prd", paths: [], hash: "" }, tasks: [] });

function loadRunsData(repoRoot: string): RunsCockpitData {
  const runId = Journal.latestRunId(repoRoot, { withJournal: true }) ?? undefined;
  let graph = emptyGraph();
  try {
    graph = loadGraph(repoRoot);
  } catch { /* no graph loaded */ }
  return { runId, events: runId ? Journal.open(repoRoot, runId).read() : [], graph };
}

export function foldConsultDossier(data: RunsCockpitData, taskId: string): ConsultDossierData {
  let prompt = 0;
  const verdicts = data.events.flatMap((event): DossierVerdict[] => {
    if (event.taskId !== taskId || event.event !== "consult-verdict") return [];
    const action = event.data.action as DossierVerdict["action"];
    if (!["retry", "reroute", "decompose", "human"].includes(action)) return [];
    return [{
      action,
      reason: typeof event.data.reason === "string" ? event.data.reason : undefined,
      prompt: data.prompts?.[taskId]?.[prompt++],
    }];
  });
  return { taskId, verdicts };
}

export function buildRunsCockpitTasks(data: RunsCockpitData, nowMs: number): RunsCockpitTask[] {
  return data.graph.tasks.map((task) => {
    const events = data.events.filter((event) => event.taskId === task.id);
    const state = [...events].reverse().find((event) => STATUS[event.event]);
    const status = STATUS[state?.event ?? ""] ?? task.status;
    const phaseStart = [...events].reverse().find((event) => event.event === "phase-start");
    const start = phaseStart ?? (state?.event === "task-dispatch" ? state : undefined);
    const phase = typeof phaseStart?.data.phase === "string" ? phaseStart.data.phase : undefined;
    const running = status === "running" && start !== undefined;
    const elapsedMs = running ? Math.max(0, nowMs - Date.parse(start.ts)) : 0;
    return {
      id: task.id, status,
      ...(running ? { phase: phase ?? "worker",
        elapsed: `${Math.floor(elapsedMs / 1000)}s` } : {}),
      consultCount: foldConsultDossier(data, task.id).verdicts.length,
    };
  });
}

function dossierLines(data: ConsultDossierData | undefined): string[] {
  if (!data) return ["d opens consult dossier"];
  if (!data.verdicts.length) return [`no consult verdicts recorded for ${data.taskId}`];
  return [`Consult dossier — ${data.taskId}`, "d back", ...data.verdicts.flatMap((verdict, index) => [
    `❯ ${index + 1}. ${verdict.action}${verdict.reason ? ` — ${verdict.reason}` : ""}`,
    `  prompt ${index + 1}`,
    ...(verdict.prompt ?? "(prompt unavailable)").split("\n")
      .map((line) => `  ${line.replace(/^#{1,6}\s+/, "")}`),
  ])];
}

function runsLines(runId: string | undefined, tasks: RunsCockpitTask[], cursor: number): string[] {
  if (!runId) return ["Runs cockpit", "no run loaded"];
  return [`Runs cockpit — ${runId}`, "d consult dossier", ...tasks.flatMap((task, index) => [
    `${index === cursor ? "❯ " : "  "}${task.id} — ${task.status}`,
    `  ${task.phase ? `${task.phase} · ${task.elapsed}` : "waiting"}${
      task.consultCount ? ` · ${task.consultCount} consult verdict` : ""}`,
  ])];
}

export function StudioApp({
  views: suppliedViews,
  repoRoot = process.cwd(),
  globalDir,
  staging: suppliedStaging,
  runsData: suppliedRunsData,
  clock = Date.now,
  columns = 80,
  rows = 24,
}: {
  views?: StudioInkView[];
  repoRoot?: string;
  globalDir?: string;
  staging?: FleetStaging;
  runsData?: RunsCockpitData;
  clock?: () => number;
  columns?: number;
  rows?: number;
}) {
  const { exit } = useApp();
  const stagingRef = useRef<FleetStaging | undefined>(undefined);
  stagingRef.current ??= suppliedStaging ?? loadStaging(repoRoot);
  const staging = stagingRef.current;
  const viewsRef = useRef<StudioInkView[] | undefined>(undefined);
  viewsRef.current ??= suppliedViews ?? defaultViews(repoRoot, staging);
  const views = viewsRef.current;
  const [active, setActive] = useState(0);
  const [help, setHelp] = useState(false);
  const [saveProposal, setSaveProposal] = useState<SaveProposal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runsData, setRunsData] = useState<RunsCockpitData>(() => suppliedRunsData ?? loadRunsData(repoRoot));
  const [nowMs, setNowMs] = useState(clock);
  const [dossierOpen, setDossierOpen] = useState(false);
  const [, repaint] = useState(0);
  const nativeRuns = suppliedViews === undefined && views[active]?.id === "runs";
  const runTasks = buildRunsCockpitTasks(runsData, nowMs);
  const runsCursor = Math.max(0, runTasks.findIndex((task) => task.consultCount > 0));
  const selectedRunTask = runTasks[runsCursor];
  const dossier = selectedRunTask ? foldConsultDossier(runsData, selectedRunTask.id) : undefined;

  useEffect(() => {
    if (!nativeRuns) return;
    const timer = setInterval(() => {
      setNowMs(clock());
      if (!suppliedRunsData) setRunsData(loadRunsData(repoRoot));
    }, 250);
    return () => clearInterval(timer);
  }, [clock, nativeRuns, repoRoot, suppliedRunsData]);

  useInput((input, key) => {
    if (key.escape) {
      if (help) setHelp(false);
      else if (saveProposal) setSaveProposal(null);
      else exit();
      return;
    }
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (saveProposal) {
      if (input === "n") {
        setSaveProposal(null);
      } else if (input === "t") {
        const target = saveProposal.target === "repo" ? "global" : "repo";
        setSaveProposal(buildSaveProposal({
          repoRoot,
          loaded: staging.loadedState,
          staged: staging.current,
          target,
          globalDir,
        }));
      } else if (input === "y") {
        const result = confirmSave({
          repoRoot,
          loaded: staging.loadedState,
          staged: staging.current,
          target: saveProposal.target,
          globalDir,
        });
        if (result.kind === "written") {
          const nextStaging = new FleetStaging(staging.current);
          stagingRef.current = nextStaging;
          if (!suppliedViews) viewsRef.current = defaultViews(repoRoot, nextStaging);
          setNotice(`wrote ${result.path}`);
        } else if (result.kind === "refused") {
          setNotice(`save refused: ${result.reason}`);
        }
        setSaveProposal(null);
      }
      return;
    }
    if (input === "q") {
      if (!help) exit();
      return;
    }
    if (input === "?") {
      setHelp(true);
      return;
    }
    if (help) return;
    if (nativeRuns && input === "d" && (dossierOpen || selectedRunTask)) {
      setDossierOpen((open) => !open);
      return;
    }
    if (input === "s") {
      if (!staging.isDirty) {
        setNotice("no staged changes");
      } else {
        setNotice(null);
        setSaveProposal(buildSaveProposal({
          repoRoot,
          loaded: staging.loadedState,
          staged: staging.current,
          target: "repo",
          globalDir,
        }));
      }
      return;
    }
    if (input === "u") {
      staging.revert();
      setNotice(staging.isDirty ? null : "no staged changes");
      repaint((revision) => revision + 1);
      return;
    }
    if (key.tab) {
      setActive((index) => (index + 1) % views.length);
      setNotice(null);
      setDossierOpen(false);
      return;
    }
    if (/^[1-9]$/.test(input)) {
      const index = Number(input) - 1;
      if (index < views.length) {
        setActive(index);
        setNotice(null);
        setDossierOpen(false);
      }
      return;
    }
    const name = key.upArrow ? "up" : key.downArrow ? "down" : null;
    if (name) {
      views[active]?.key?.(name);
      repaint((revision) => revision + 1);
    }
  });

  const view = views[active]!;
  const lines = help
    ? HELP
    : nativeRuns
      ? dossierOpen
        ? dossierLines(dossier)
        : runsLines(runsData.runId, runTasks, runsCursor)
    : [
        ...view.render({ cols: columns, rows: Math.max(rows - 2, 1) }),
        ...(notice ? [notice] : []),
      ];
  const count = staging.changeCount;
  const status = staging.isDirty
    ? `● ${count} staged change${count === 1 ? "" : "s"}`
    : "no staged changes";
  return (
    <StudioScreen
      tabs={views.map((candidate) => candidate.label)}
      active={active}
      lines={lines}
      status={status}
    >
      {saveProposal
        ? (
            <DiffConfirmationScreen
              target={saveProposal.target}
              targetPath={saveProposal.targetPath}
              diff={saveProposal.diff}
              liveRun={saveProposal.liveRun}
            />
          )
        : undefined}
    </StudioScreen>
  );
}

export async function runStudioInk({
  input,
  output,
  views,
  repoRoot,
  globalDir,
  staging,
  runsData,
  clock,
  debug = false,
}: StudioInkIO): Promise<void> {
  const app = render(
    <StudioApp
      views={views}
      repoRoot={repoRoot}
      globalDir={globalDir}
      staging={staging}
      runsData={runsData}
      clock={clock}
      columns={output.columns}
      rows={output.rows}
    />,
    {
      stdin: input,
      stdout: output,
      exitOnCtrlC: false,
      patchConsole: false,
      debug,
    },
  );
  try {
    await app.waitUntilExit();
  } finally {
    app.unmount();
  }
}
