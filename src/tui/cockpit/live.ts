import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render, useApp, useInput } from "ink";
import { createElement, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { graphPath, loadGraph, stateDirName } from "../../graph/graph.js";
import { Journal, parseRunId } from "../../run/journal.js";
import type {
  CockpitGraph,
  RunCockpitData,
  RunCockpitSource,
} from "./derive.js";
import { deriveRunCockpitData } from "./derive.js";
import {
  deriveRunViewRows,
  drawnRunViewRowIds,
  planRunCockpitFrame,
  runKeyColumns,
  RunCockpitFrame,
  type PlannedRunCockpitFrame,
} from "./run-cockpit.js";
import {
  dispatchRunSurfaceKey,
  openingRunSurfaceState,
  reconcileRunInteraction,
  RUN_INPUT_BINDINGS,
  selectableRunViewRowIds,
  type RunInteractionState,
  type RunKeyEvent,
} from "./keys.js";
import {
  applyPointerReport,
  borrowPointerTracking,
  createPointerReportReader,
  type PointerInputToken,
  type PointerReport,
  type PointerSurface,
} from "./pointer.js";

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

/**
 * The pointer surface a committed frame carries: the plan the paint drew and
 * the rows drawn into its body, both read off the renderer's own output. This
 * is the only composition the live input path resolves through — it holds no
 * planner and no geometry of its own, so a hit can never land on bands or
 * rows the operator has not seen.
 */
function committedRunPointerSurface(
  planned: PlannedRunCockpitFrame,
  data: RunCockpitData,
): PointerSurface | undefined {
  if (planned.plan.kind !== "frame" || planned.content === undefined) {
    return undefined;
  }
  return {
    interaction: planned.interaction,
    // The plan is the whole geometry the pointer receives: the item rows it
    // resolves a hit through are the plan's own `items` band, the same region
    // the paint draws its list into, so there is no second reading of where the
    // list starts.
    plan: planned.plan,
    drawnRowIds: drawnRunViewRowIds(
      data,
      planned.interaction,
      planned.content.items.rows,
    ),
    rowIds: liveRunViewRowIds(planned.interaction, data),
  };
}

/**
 * The suite's own planning of the surface a frame at this data, state and
 * measured size commits — the same composition the renderer publishes through
 * its commit seam, so a hit is tested against the frame production actually
 * painted. The live input path never calls this: it resolves through the
 * committed frame, and what nothing has painted yet has no geometry.
 */
export function liveRunPointerSurface(
  data: RunCockpitData,
  interaction: RunInteractionState,
  size: { readonly columns: number; readonly rows: number },
): PointerSurface | undefined {
  return committedRunPointerSurface(
    planRunCockpitFrame({
      data,
      columns: size.columns,
      rows: size.rows,
      interaction,
    }),
    data,
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
  readonly key: (event: RunKeyEvent) => boolean;
  readonly pointer: (report: PointerReport) => boolean;
  readonly batch: <Result>(deliver: () => Result) => Result;
};

type InternalLiveCockpitDelivery = LiveCockpitDelivery & {
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * The renderer's commit seam: the frame the paint just drew becomes the
   * surface pointer reports resolve against. Only the renderer writes here —
   * the input path reads.
   */
  readonly commitPointerSurface: (surface: PointerSurface | undefined) => void;
};

function createLiveCockpitDelivery({
  cwd,
  runId,
  binaryVersion,
  now,
  size,
}: {
  cwd: string;
  runId: string;
  binaryVersion: string;
  now: () => number;
  /**
   * The size the surface is drawn at, read at delivery time. Input is routed
   * against the bands the frame really has, never against an assumed width.
   */
  size: () => { readonly columns: number; readonly rows: number };
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
  /**
   * The frame on the screen, published by the renderer each time it commits
   * one. Pointer reports resolve through this and only this: the input path
   * plans nothing and caches no geometry, so a refresh, resize or key that
   * nothing has painted yet cannot move a hit — the target set is the bands
   * and rows the operator is actually looking at, until the paint replaces
   * them.
   */
  let committedPointerSurface: PointerSurface | undefined;

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
          // The batch ends and the surface is drawn again; the renderer's
          // commit of that draw publishes the frame the next report resolves
          // through.
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
    key: (event) => transition((current) => {
      const next = dispatchRunSurfaceKey(
        event,
        { interaction: current.interaction, stashed: current.stashed },
        RUN_INPUT_BINDINGS,
        liveRunViewRowIds(current.interaction, current.data),
        // The dispatcher decides on rail visibility from the width the surface
        // is measured at. A default here routed every key as if the rail were
        // drawn, at widths where the plan draws no rail at all.
        runKeyColumns(size().columns),
      );
      if (next === undefined) return current;
      const interaction = reconcileLiveRunInteraction(next.interaction, current.data);
      return interaction === current.interaction && next.stashed === current.stashed
        ? current
        : { ...current, interaction, stashed: next.stashed };
    }),
    // A pointer report resolves through the committed frame — the plan and
    // the drawn rows the paint has on the screen, and nothing the input path
    // derives for itself. Adjacent reports — a double click above all —
    // arrive in one batch, which defers the redraw: they all resolve through
    // the ONE committed frame still on the screen, and only the state each
    // transition is dispatched FROM moves. The first press's own new scroll
    // window cannot slide the list under the second press, because that
    // window does not exist until the paint draws it.
    pointer: (report) => transition((current) => {
      const drawn = committedPointerSurface;
      if (drawn === undefined) return current;
      const next = applyPointerReport(report, {
        ...drawn,
        interaction: current.interaction,
      });
      if (next === undefined) return current;
      const interaction = reconcileLiveRunInteraction(next, current.data);
      return interaction === current.interaction
        ? current
        : { ...current, interaction };
    }),
    commitPointerSurface: (surface) => {
      committedPointerSurface = surface;
    },
  };
  return delivery;
}

/** The measured size a snapshot states, in the whole cells a plan is made of. */
function parseMeasuredSize(
  snapshot: string,
): { readonly columns: number; readonly rows: number } {
  const [columns, rows] = snapshot.split(":").map((part) =>
    Math.max(0, Math.floor(Number(part)))
  ) as [number, number];
  return { columns, rows };
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

/**
 * The stdin the surface's keyboard reads: the real stream with every pointer
 * report taken out of it. Reports and keys arrive interleaved on one stream, and
 * a reader beside Ink's would not be enough — Ink would still see the report
 * bytes and read a whole one as an unnameable escape sequence, or half of one as
 * the single character its chunk happens to end on, dispatching either into
 * whatever scope is live. So the split sits in the pull Ink already does
 * (`read()` under its `readable` listener): reports are handed to the pointer
 * boundary, and only what was left is ever read as a keystroke. A chunk that was
 * nothing but reports reads as no input at all rather than as empty input.
 */
function pointerFilteredInput(
  input: NodeJS.ReadStream,
  deliver: (reports: readonly PointerReport[]) => void,
): { readonly stdin: NodeJS.ReadStream; readonly close: () => void } {
  const reader = createPointerReportReader();
  const tokens: PointerInputToken[] = [];
  let pendingEscape: NodeJS.Immediate | undefined;

  const clearPendingEscape = (): void => {
    if (pendingEscape === undefined) return;
    clearImmediate(pendingEscape);
    pendingEscape = undefined;
  };
  const wake = (): void => {
    input.emit("readable");
  };
  const schedulePendingEscape = (): void => {
    clearPendingEscape();
    // The same next-turn grace Ink gives an ambiguous ESC: a continuation that
    // arrives first completes the report; otherwise ESC becomes keyboard input.
    if (reader.pending() !== "\x1b") return;
    pendingEscape = setImmediate(() => {
      pendingEscape = undefined;
      tokens.push(...reader.flush().tokens);
      wake();
    });
  };

  const read = (...args: readonly unknown[]): string | null => {
    while (true) {
      const token = tokens.shift();
      if (token?.type === "pointer") {
        const reports = [token.report];
        while (tokens[0]?.type === "pointer") {
          const adjacent = tokens.shift();
          if (adjacent?.type === "pointer") reports.push(adjacent.report);
        }
        deliver(reports);
        continue;
      }
      if (token?.type === "keys") return token.bytes;

      const chunk = (input.read as (...rest: readonly unknown[]) => unknown)(
        ...args,
      );
      if (chunk === null || chunk === undefined) return null;
      clearPendingEscape();
      const readout = reader(String(chunk));
      tokens.push(...readout.tokens);
      schedulePendingEscape();
    }
  };
  const stdin = new Proxy(input, {
    get(target, property) {
      if (property === "read") return read;
      const value = Reflect.get(target, property);
      return typeof value === "function" && !Object.hasOwn(target, property)
        ? value.bind(target)
        : value;
    },
  }) as NodeJS.ReadStream;
  return { stdin, close: clearPendingEscape };
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
  const { columns, rows } = parseMeasuredSize(measuredSize);
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
    delivery.key({ input, key });
  });
  // Every frame the renderer commits is published to the delivery, so a
  // pointer report resolves against the plan and the drawn rows of the frame
  // on the screen — the input path never plans one of its own.
  const commitFrame = useCallback(
    (planned: PlannedRunCockpitFrame, frameData: RunCockpitData): void => {
      delivery.commitPointerSurface(
        committedRunPointerSurface(planned, frameData),
      );
    },
    [delivery],
  );
  return createElement(RunCockpitFrame, {
    data: surface.data,
    columns,
    rows,
    interaction: surface.interaction,
    onCommittedFrame: commitFrame,
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
  // Subscribe before Ink mounts so no stale-size repaint can overtake the
  // surface's newly planned frame — and before the delivery exists, which
  // routes every input against this measurement.
  const size = measureOutput(output);
  let app: ReturnType<typeof render> | undefined;
  let filteredInput: ReturnType<typeof pointerFilteredInput> | undefined;
  let releasePointerTracking: (() => void) | undefined;
  try {
    const delivery = createLiveCockpitDelivery({
      cwd,
      runId,
      binaryVersion,
      now,
      size: () => parseMeasuredSize(size.snapshot()),
    });
    onDelivery?.(delivery);
    // Pointer reports are their own input class: they are taken off the stream
    // before the keyboard reads it and delivered to the pointer boundary, never
    // handed to a key handler. A batch keeps adjacent reports to one redraw.
    filteredInput = pointerFilteredInput(input, (reports) => {
      delivery.batch(() => {
        for (const report of reports) delivery.pointer(report);
      });
    });
    // One loan owns the complete live lifecycle. Its signal repayments stand
    // before the ask, then remain installed through mount, paint, input and
    // unmount. Non-tty output borrows nothing and writes nothing.
    releasePointerTracking = borrowPointerTracking(output);
    app = render(createElement(LiveApp, {
      delivery,
      size,
      refreshMs,
    }), {
      stdin: filteredInput.stdin,
      stdout: size.stdout,
      debug,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await app.waitUntilExit();
  } finally {
    try {
      filteredInput?.close();
    } finally {
      try {
        app?.unmount();
      } finally {
        try {
          releasePointerTracking?.();
        } finally {
          size.close();
        }
      }
    }
  }
}
