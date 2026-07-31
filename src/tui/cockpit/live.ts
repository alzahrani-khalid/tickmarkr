import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render, useApp, useInput } from "ink";
import { createElement, useEffect, useRef, useSyncExternalStore } from "react";
import { graphPath, loadGraph, stateDirName } from "../../graph/graph.js";
import { Journal, parseRunId } from "../../run/journal.js";
import type {
  CockpitGraph,
  RunCockpitData,
  RunCockpitSource,
} from "./derive.js";
import { deriveRunCockpitData } from "./derive.js";
import { deriveRunViewRows, runKeyColumns, RunCockpitFrame } from "./run-cockpit.js";
import {
  dispatchRunSurfaceKey,
  openingRunSurfaceState,
  reconcileRunInteraction,
  RUN_INPUT_BINDINGS,
  selectableRunViewRowIds,
  type RunInteractionState,
  type RunKeyEvent,
} from "./keys.js";

// ponytail: fixed 2s re-derive cadence, matching `status --watch`; promote to a
// config knob only if an operator asks.
const REFRESH_MS = 2_000;

/**
 * THE engagement selection rule — stated once, here, so it can change in one
 * place without touching the renderer or the command: an explicit engagement
 * reference from the command line wins; the bare command opens the most
 * recently started engagement that has a readable journal.
 */
export function selectEngagementRunId(cwd: string, explicit?: string): string | null {
  if (explicit !== undefined) return parseRunId(explicit);
  return Journal.latestRunId(cwd, { withJournal: true });
}

/**
 * The journal bytes of a real engagement — never a committed capture. A read
 * failure throws: the caller refuses rather than drawing from nothing.
 */
export function loadEngagementSource(cwd: string, runId: string): RunCockpitSource {
  const id = parseRunId(runId);
  const path = join(cwd, stateDirName(cwd), "runs", id, "journal.jsonl");
  const raw = readFileSync(path, "utf8");
  return { fileName: `${id}.journal.jsonl`, raw };
}

/**
 * The compiled graph, when the repository has one. It lends the tasks view its
 * identities and nothing else, so an engagement with no compiled graph at all
 * still draws every task the journal mentions rather than refusing to open.
 *
 * Absence is the only fallback. A graph that exists and cannot be read, parsed
 * or validated is a fault, and swallowing it would quietly demote the surface:
 * every task the graph alone knows about would vanish from the rows, and a
 * selection standing on one of them would be cleared as if the engagement had
 * dropped it. So it throws, and the caller keeps its last good frame instead.
 */
export function loadEngagementGraph(cwd: string): CockpitGraph | undefined {
  if (!existsSync(graphPath(cwd))) return undefined;
  return loadGraph(cwd);
}

// The same s/m/h age vocabulary `status` speaks (status.ts fmtAge).
export function formatEventAge(ageMs: number): string {
  const safe = Math.max(0, ageMs);
  if (safe < 90_000) return `${Math.floor(safe / 1_000)}s`;
  if (safe < 5_400_000) return `${Math.floor(safe / 60_000)}m`;
  return `${Math.floor(safe / 3_600_000)}h`;
}

function lastEventMs(raw: string): number | undefined {
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { ts?: unknown };
      const ms = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : NaN;
      if (Number.isFinite(ms)) return ms;
    } catch {
      // a torn trailing line does not hide the event written before it
    }
  }
  return undefined;
}

/**
 * Live derivation over a real engagement's journal bytes. The header's
 * elapsed field additionally states how long ago the engagement's last event
 * arrived, so an engagement that has stopped moving reads as stale rather
 * than as current. Throws on unreadable bytes (empty capture, no run-start) —
 * the caller refuses instead of rendering a plausible surface from nothing.
 */
export function deriveLiveRunCockpitData(
  source: RunCockpitSource,
  binaryVersion: string,
  now: () => number = Date.now,
  graph?: CockpitGraph,
): RunCockpitData {
  const data = deriveRunCockpitData(source, binaryVersion, { graph });
  const lastMs = lastEventMs(source.raw);
  const staleness = lastMs === undefined
    ? "last event unknown"
    : `last event ${formatEventAge(now() - lastMs)} ago`;
  return { ...data, elapsed: `${data.elapsed} · ${staleness}` };
}

/**
 * Repair the interaction state against the rows a refreshed view now owns.
 * Selection is held by the row's source identity, so it survives rows landing
 * above it and is dropped — never slid onto whoever inherited its index —
 * when the refreshed engagement no longer carries it.
 */
export function reconcileLiveRunInteraction(
  interaction: RunInteractionState,
  data: RunCockpitData,
): RunInteractionState {
  return reconcileRunInteraction(interaction, liveRunViewRowIds(interaction, data));
}

/**
 * The rows the live surface hands its keys — the engagement's own identities,
 * minus the journal's, which are never selectable in either tab. This is the
 * one place rows enter the dispatcher, so no key can reach a journal row.
 */
export function liveRunViewRowIds(
  interaction: RunInteractionState,
  data: RunCockpitData,
): readonly string[] {
  return selectableRunViewRowIds(
    interaction.activeView,
    // The frame's own rows, so a key can never stand on a row the surface did
    // not draw — one derivation, read by both.
    deriveRunViewRows(data, interaction.activeView, interaction.filterQuery)
      .map((row) => row.id),
  );
}

export type LiveCockpitSurface = {
  readonly data: RunCockpitData;
  readonly interaction: RunInteractionState;
  /** The tab waiting behind the drawn one, holding the state it was left in. */
  readonly stashed: RunInteractionState;
};

/**
 * The live owner's delivery boundary. A refresh is the real journal read and
 * state transition used by the timer; snapshot exposes the state subsequent
 * deliveries will read. Batch keeps applying transitions synchronously while
 * deferring only the redraw notification, so multiple sources can be ordered
 * in one turn without substituting a helper state machine for the live one.
 */
export type LiveCockpitDelivery = {
  readonly snapshot: () => LiveCockpitSurface;
  readonly refresh: () => boolean;
  readonly key: (event: RunKeyEvent, columns?: number) => boolean;
  readonly batch: <Result>(deliver: () => Result) => Result;
};

type InternalLiveCockpitDelivery = LiveCockpitDelivery & {
  readonly subscribe: (listener: () => void) => () => void;
};

function createLiveCockpitDelivery({
  cwd,
  runId,
  binaryVersion,
  now,
}: {
  cwd: string;
  runId: string;
  binaryVersion: string;
  now: () => number;
}): InternalLiveCockpitDelivery {
  // Both sources are read every refresh: a recompile between refreshes changes
  // which tasks exist, and the surface must draw the graph the repository has
  // now rather than the one it had when the cockpit opened.
  const derive = (): RunCockpitData =>
    deriveLiveRunCockpitData(
      loadEngagementSource(cwd, runId),
      binaryVersion,
      now,
      loadEngagementGraph(cwd),
    );
  const opening = openingRunSurfaceState();
  let surface: LiveCockpitSurface = {
    data: derive(),
    interaction: opening.interaction,
    stashed: opening.stashed,
  };
  const listeners = new Set<() => void>();
  let batchDepth = 0;
  let pendingDraw = false;

  const publish = (): void => {
    if (batchDepth > 0) {
      pendingDraw = true;
      return;
    }
    for (const listener of listeners) listener();
  };
  const transition = (
    apply: (current: LiveCockpitSurface) => LiveCockpitSurface,
  ): boolean => {
    const next = apply(surface);
    if (next === surface) return false;
    surface = next;
    publish();
    return true;
  };

  const delivery: InternalLiveCockpitDelivery = {
    snapshot: () => surface,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    batch: (deliver) => {
      batchDepth += 1;
      try {
        return deliver();
      } finally {
        batchDepth -= 1;
        if (batchDepth === 0 && pendingDraw) {
          pendingDraw = false;
          publish();
        }
      }
    },
    refresh: () => {
      try {
        const refreshed = derive();
        return transition((current) => ({
          ...current,
          data: refreshed,
          interaction: reconcileLiveRunInteraction(
            current.interaction,
            refreshed,
          ),
        }));
      } catch {
        // A torn read mid-append, or a graph caught mid-recompile, keeps the
        // last good frame rather than demoting or blanking the surface.
        return false;
      }
    },
    // Every key goes to the one surface dispatcher, in every state the surface
    // can be in. The prompt is a scope inside that registry rather than an
    // owner in front of it, so a global key — Tab above all — reaches its
    // handler with a prompt open exactly as it does without one.
    key: (event, columns = Number.MAX_SAFE_INTEGER) => transition((current) => {
      const next = dispatchRunSurfaceKey(
        event,
        { interaction: current.interaction, stashed: current.stashed },
        RUN_INPUT_BINDINGS,
        liveRunViewRowIds(current.interaction, current.data),
        // The dispatcher decides on rail visibility, and the plan owns that.
        runKeyColumns(columns),
      );
      if (next === undefined) return current;
      const interaction = reconcileLiveRunInteraction(next.interaction, current.data);
      return interaction === current.interaction && next.stashed === current.stashed
        ? current
        : { ...current, interaction, stashed: next.stashed };
    }),
  };
  return delivery;
}

/** A draw-time terminal measurement and the stream Ink paints through. */
type MeasuredSize = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => string;
  readonly stdout: NodeJS.WriteStream;
  readonly settle: () => void;
  readonly close: () => void;
};

function measureOutput(output: NodeJS.WriteStream): MeasuredSize {
  const read = (): string => `${output.columns ?? 80}:${output.rows ?? 24}`;
  let size = read();
  const listeners = new Set<() => void>();
  const heldInkResizeListeners = new Set<() => void>();
  const resized = (): void => {
    size = read();
    for (const listener of listeners) listener();
  };
  output.on("resize", resized);

  // Ink otherwise repaints its previous tree as soon as the stream resizes.
  // Hold that repaint until React has published the newly measured plan.
  const subscribe = (event: string, listener: () => void): NodeJS.WriteStream => {
    if (event === "resize") heldInkResizeListeners.add(listener);
    else output.on(event, listener);
    return stdout;
  };
  const unsubscribe = (event: string, listener: () => void): NodeJS.WriteStream => {
    if (event === "resize") heldInkResizeListeners.delete(listener);
    else output.off(event, listener);
    return stdout;
  };
  const stdout = new Proxy(output, {
    get(target, property) {
      if (property === "on" || property === "addListener") return subscribe;
      if (property === "off" || property === "removeListener") return unsubscribe;
      const value = Reflect.get(target, property);
      return typeof value === "function" && !Object.hasOwn(target, property)
        ? value.bind(target)
        : value;
    },
  }) as NodeJS.WriteStream;

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => size,
    stdout,
    settle: () => {
      for (const listener of heldInkResizeListeners) listener();
    },
    close: () => output.off("resize", resized),
  };
}

function LiveApp({
  delivery,
  size,
  refreshMs,
}: {
  delivery: InternalLiveCockpitDelivery;
  size: MeasuredSize;
  refreshMs: number;
}) {
  const { exit } = useApp();
  const surface = useSyncExternalStore(
    delivery.subscribe,
    delivery.snapshot,
    delivery.snapshot,
  );
  const measuredSize = useSyncExternalStore(
    size.subscribe,
    size.snapshot,
    size.snapshot,
  );
  const [columns, rows] = measuredSize.split(":").map((part) =>
    Math.max(0, Math.floor(Number(part)))
  ) as [number, number];
  const drawnSize = useRef(measuredSize);
  useEffect(() => {
    if (drawnSize.current === measuredSize) return;
    drawnSize.current = measuredSize;
    size.settle();
  }, [measuredSize, size]);
  useEffect(() => {
    const timer = setInterval(delivery.refresh, refreshMs);
    return () => clearInterval(timer);
  }, [delivery, refreshMs]);
  useEffect(() => {
    if (surface.interaction.quit) exit();
  }, [exit, surface.interaction.quit]);
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    delivery.key({ input, key }, columns);
  });
  return createElement(RunCockpitFrame, {
    data: surface.data,
    columns,
    rows,
    interaction: surface.interaction,
  });
}

export async function runLiveCockpit({
  input,
  output,
  cwd,
  runId,
  binaryVersion,
  refreshMs = REFRESH_MS,
  now = Date.now,
  debug = false,
  onDelivery,
}: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  cwd: string;
  runId: string;
  binaryVersion: string;
  refreshMs?: number;
  now?: () => number;
  /** Emit complete frames for diagnostics instead of terminal diffs. */
  debug?: boolean;
  /** Observe and control the production delivery boundary. */
  onDelivery?: (delivery: LiveCockpitDelivery) => void;
}): Promise<void> {
  const delivery = createLiveCockpitDelivery({
    cwd,
    runId,
    binaryVersion,
    now,
  });
  onDelivery?.(delivery);
  // Subscribe before Ink mounts so no stale-size repaint can overtake the
  // surface's newly planned frame.
  const size = measureOutput(output);
  const app = render(createElement(LiveApp, {
    delivery,
    size,
    refreshMs,
  }), {
    stdin: input,
    stdout: size.stdout,
    debug,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await app.waitUntilExit();
  } finally {
    size.close();
    app.unmount();
  }
}
