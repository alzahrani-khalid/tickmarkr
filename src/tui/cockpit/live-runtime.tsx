import { existsSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderMarkdownRecord } from "../../cli/commands/report.js";
import { loadConfig } from "../../config/config.js";
import { estimateCosts } from "../../report/cost.js";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { render, useInput, useStdin } from "ink";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { createLiveStore, type LiveStore, type LiveStoreSnapshot } from "./live-store.js";
import { HomeView, deriveHomeView, selectNeedsYouTarget, type HomeNeedsYouTarget } from "./home-view.js";
import { RunView, applyRunViewKey, initialRunViewSession, runGateCells, evidenceLookup } from "./run-view.js";
import { renderBoardLines, stripBoardAnsi } from "./board.js";
import { EvidenceView, deriveEvidenceView, type EvidenceRow, defaultExportPath, planEvidenceExport, writeEvidenceExport } from "./evidence-view.js";
import { ShellGridFlow, ShellJournalSelection } from "./components.js";
import { CockpitShell, initialShellState, type ShellState, type ShellCommit } from "./shell.js";
import { planShell } from "./layout.js";
import { shellBindings, type RunKeyEvent } from "./keys.js";
import { createPointerReportReader, POINTER_TRACKING_ON, POINTER_TRACKING_OFF, type PointerReport } from "./pointer.js";
import { deriveRunDecisions, previewDecision, executeDecision, withDecisionPreview, withDecisionReceipt, decisionConfirmLines } from "./decision-actions.js";
import { approvalRunOwner } from "../../cli/commands/approve.js";
import { GLYPHS } from "../../brand.js";
import { Journal } from "../../run/journal.js";
import { observeNamedRun, WATCH_OWNER_ENV } from "../../run/supervision.js";
import { formatOwnedName, type FocusTarget, type FocusResult } from "../../drivers/types.js";
import type { EvidenceIdentity } from "../../run/operator-state.js";
import { cellWidth, wrapCells } from "./width.js";
import { resolveShellColourMode } from "./theme.js";

let timelineUsers = 0;
let timelineObserver: PerformanceObserver | undefined;
/** React 19 development measures retain fiber details in Node's global timeline.
 * Drain only React DevTools entries, sharing one observer across independent mounts.
 * No environment mutation, global performance monkey patch, or retained frame archive. */
export function borrowRuntimeTimeline(): () => void {
  if (timelineUsers++ === 0) {
    timelineObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const detail = (entry as PerformanceMeasure).detail as { devtools?: unknown } | null;
        if (detail?.devtools) performance.clearMeasures(entry.name);
      }
    });
    timelineObserver.observe({ entryTypes: ["measure"] });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--timelineUsers === 0) {
      for (const entry of performance.getEntriesByType("measure")) {
        if ((entry as PerformanceMeasure).detail?.devtools) performance.clearMeasures(entry.name);
      }
      timelineObserver?.disconnect(); timelineObserver = undefined;
    }
  };
}

export const SHELL_TERMINAL_ENTER = "\x1b[?1049h\x1b[22;0t\x1b]0;tickmarkr cockpit\x07" + POINTER_TRACKING_ON;
export const SHELL_TERMINAL_RESTORE = POINTER_TRACKING_OFF + "\x1b[23;0t\x1b[?25h\x1b[?1049l";
export interface ShellDelivery {
  snapshot: () => { state: ShellState; store: LiveStoreSnapshot; interaction: ShellState };
  refresh: () => boolean;
  key: (event: RunKeyEvent) => boolean;
  pointer: (report: PointerReport) => boolean;
  diagnostics: LiveStore["diagnostics"];
  stage: (edits: readonly string[]) => void;
  geometry: () => ShellCommit | undefined;
}
export interface ConsolidatedOptions {
  input: NodeJS.ReadStream; output: NodeJS.WriteStream; cwd: string; runId: string; binaryVersion: string;
  refreshMs?: number; now?: () => number; debug?: boolean;
  initialView?: ShellState["view"];
  initialParks?: boolean;
  observeRun?: boolean;
  focusDriver?: (target: FocusTarget, driver: string) => Promise<FocusResult>;
  /** Compatibility observer retained for the pre-existing production-mount harness. */
  onDelivery?: (delivery: ShellDelivery) => void;
  onShellDelivery?: (delivery: ShellDelivery) => void;
  environment?: NodeJS.ProcessEnv;
  diagnostics?: readonly HomeNeedsYouTarget[];
}

/** Preserve a policy-disabled gate from C2 even when C5's generic event
 * mapper calls an unpassed result unknown. Lead with the gate name so a long
 * task identity cannot clip the label that explains the disabled glyph. */
function presentEvidenceRow(
  row: EvidenceRow,
  event: { event: string; data: Record<string, unknown> } | undefined,
): EvidenceRow {
  if (event?.event !== "gate-result" || event.data.disabled !== true) return row;
  return { ...row, state: "inactive", text: `${event.data.gate ?? "gate"} — ${row.text}` };
}

/** The live entry mounts the dependency-owned leaves, using only C2 snapshots/history/page. */
export async function runConsolidatedCockpit(options: ConsolidatedOptions): Promise<void> {
  const { input, output, cwd, runId } = options;
  const colour = resolveShellColourMode(options.environment);
  const releaseTimeline = borrowRuntimeTimeline();
  const wasRaw = input.isRaw ?? false;
  const wasPaused = input.isPaused();
  let store: LiveStore | undefined;
  let observation: ReturnType<typeof observeNamedRun> | undefined;
  let app: ReturnType<typeof render> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let entered = false;
  let done = false;
  let failure: unknown;
  let finish!: () => void;
  const stopped = new Promise<void>(resolve => { finish = resolve; });
  const stop = (error?: unknown) => { if (done) return; done = true; failure = error; finish(); };
  const signal = () => stop();
  const ioError = (error: Error) => stop(error);
  let resize = () => {};
  try {
    process.on("SIGTERM", signal); process.on("SIGINT", signal);
    input.on("error", ioError); output.on("error", ioError);
    if (output.isTTY) { entered = true; output.write(SHELL_TERMINAL_ENTER); }
    store = createLiveStore({ cwd, runId, now: options.now });
    const source = store;
    if (options.observeRun !== false) observation = observeNamedRun(cwd, runId, options.environment);
    // BD-1 (RULING-231-19 §2): the daemon-placed board carries the watch owner token and mounts
    // rail-less — a zero shortcut budget the plan honours at every width. The manual cockpit keeps its rail.
    const railless = Boolean((options.environment ?? process.env)[WATCH_OWNER_ENV]);
    let state = { ...initialShellState(), view: options.initialView ?? "home", ...(railless ? { shortcutColumns: 0 } : {}) };
    let runSession = initialRunViewSession();
    if (options.initialParks) {
      runSession = { ...runSession, selection: Math.max(0, source.snapshot().operator.tasks.findIndex(t => t.state === "human" || t.state === "blocked")) };
      state = { ...state, scroll: Number.MAX_SAFE_INTEGER };
    }
    let decisionsKey = "";
    let visibleDecisions: ReturnType<typeof deriveRunDecisions> = [];
    let selectedEvidence: EvidenceIdentity | undefined;
    let evidenceNavigation = 0;
    let activeEvidence: string | undefined;
    const reportEvidenceSelection = (id: string | undefined) => {
      if (id !== activeEvidence) { activeEvidence = id; publish(); }
    };
    let homeNeedsYouIndex = 0;
    const reportHomeNeedsYouSelection = (_target: HomeNeedsYouTarget | undefined, index: number) => {
      if (index !== homeNeedsYouIndex) {
        homeNeedsYouIndex = index;
        publish();
      }
    };
    let dragColumn: number | undefined;
    let committed: ShellCommit | undefined;
    type Target = { column: number; row: number; columns: number; rows: number } & (
      { kind: "resize" } | { kind: "key"; binding: ReturnType<typeof shellBindings>[number] } |
      { kind: "task" | "park" | "diagnostic"; id: string } | { kind: "evidence"; identity: EvidenceIdentity; open: boolean }
    );
    let committedTargets: Target[] = [];
    let revision = 0;
    const listeners = new Set<() => void>();
    const publish = () => { revision++; for (const listener of listeners) listener(); };
    const unsubscribe = source.subscribe(publish);
    const geometry = () => planShell(output.columns ?? 80, output.rows ?? 24, state.shortcutColumns);
    const openEvidence = (identity: EvidenceIdentity) => {
      evidenceNavigation++;
      selectedEvidence = identity; state = { ...state, view: "evidence", scroll: 0, evidenceSection: 0 }; publish();
    };
    let exportPath: string | undefined;
    const beginExport = () => {
      const paths = source.snapshot().graph.value?.spec.paths ?? [];
      const destination = defaultExportPath({ runId, specPaths: paths,
        specDir: paths.length === 1 ? dirname(resolve(cwd, paths[0]!)) : undefined });
      state = { ...state, editor: destination ?? "", editorKind: "export" };
      publish();
    };
    const focusTask = async () => {
      const task = source.snapshot().operator.tasks[runSession.selection];
      if (!task) return;
      const launch = Journal.open(cwd, runId).read().reverse().find(row => row.event === "worker-launch" && row.taskId === task.id && row.data.attempt === task.attempt);
      const data = launch?.data;
      const slot = data?.slot as FocusTarget["slot"] | undefined;
      let result: FocusResult = { status: "unsupported", reason: "No recorded pane ownership; open task evidence with Enter" };
      if (slot && typeof data?.driver === "string" && typeof slot.id === "string" && typeof slot.cwd === "string" && task.attempt !== undefined &&
          slot.name === formatOwnedName({ role: "worker", taskId: task.id, attempt: task.attempt, runId })) {
        const target: FocusTarget = { repo: cwd, runId, taskId: task.id, attempt: task.attempt, slot, workspace: typeof data.workspace === "string" ? data.workspace : undefined };
        if (options.focusDriver) result = await options.focusDriver(target, data.driver);
        else {
          const { pickDriver } = await import("../../drivers/index.js");
          const { loadConfig } = await import("../../config/config.js");
          const driver = pickDriver(loadConfig(cwd), data.driver);
          result = await driver.focus?.(target) ?? result;
        }
      }
      if (done) return;
      state = { ...state, overlay: [result.status === "focused" ? `Focused ${task.id}` : `Pane ${result.status}`, result.reason, "Enter opens task evidence after Esc"], overlayOffset: 0 };
      publish();
    };
    // The board is taller than a small body; a selection moved by keys or a park opened from Home
    // scrolls the shell's viewport just far enough that the selected row (and the rows that wrap
    // under it) is seen. The rows are the very lines the Run view draws at this body width.
    const followSelection = () => {
      const snap = source.snapshot();
      const task = snap.operator.tasks[runSession.selection];
      if (!task) return;
      const g = geometry();
      const lines = renderBoardLines({ runId, snapshot: snap.operator, graph: snap.graph.value, now: (options.now ?? Date.now)(), selection: task.id, keys: false, colour: false }, g.bodyColumns);
      const first = lines.findIndex(l => l.startsWith("  ❯ "));
      if (first < 0) return;
      let last = first;
      while (last + 1 < lines.length && lines[last + 1]!.startsWith(" ".repeat(9))) last++;
      const top = first + 1, bottom = last + 1; // the RUN summary line sits above the board
      const scroll = state.scroll;
      if (top < scroll) state = { ...state, scroll: top };
      else if (bottom >= scroll + g.bodyRows) state = { ...state, scroll: bottom - g.bodyRows + 1 };
    };
    const openDetail = () => {
      const snap = source.snapshot();
      const task = state.view === "run" ? snap.operator.tasks[runSession.selection] : undefined;
      const identity = state.view === "run" ? task?.gates.review.evidence ?? task?.mergeEvidence : selectedEvidence ?? snap.journal.history.at(-1);
      if (!identity) {
        if (task) state = { ...state, overlay: [task.id, task.title ?? "", task.path ?? "path unknown", "No review evidence"].flatMap(t => wrapCells(t, geometry().bodyColumns)), overlayOffset: 0 };
        return;
      }
      const row = source.page(identity.line, 1)[0];
      state = { ...state, overlay: [identity.id, ...(task ? [task.id, task.title ?? ""].flatMap(t => wrapCells(t, geometry().bodyColumns)) : []), ...wrapCells(row?.event ? JSON.stringify(row.event, null, 2) : row?.error ?? "missing evidence", geometry().bodyColumns), ...(typeof row?.event?.data.details === "string" ? row.event.data.details.split("\n").flatMap(t => wrapCells(t, geometry().bodyColumns)) : [])], overlayOffset: 0 };
    };
    // The mounted leaves own their selection. Forward synthetic registry actions
    // through the same Ink input bus as terminal keys instead of guessing a row
    // from the snapshot. The guard prevents the shell from dispatching its echo.
    let leafInput: ReturnType<typeof useStdin>["internal_eventEmitter"] | undefined;
    let forwarding = false;
    let lastRawInput = "";
    const forwardLeaf = (bytes: string) => {
      forwarding = true;
      try { leafInput?.emit("input", bytes); } finally { forwarding = false; }
    };
    const key = (event: RunKeyEvent, terminal = false): boolean => {
      if (done) return false;
      const { input: text, key: k } = event;
      if (k.ctrl && text === "c") { stop(); return true; }
      if (exportPath !== undefined) {
        if (text === "y") {
          const j = Journal.open(cwd, runId);
          const events = j.read();
          const rows = j.readTelemetry();
          const cfg = loadConfig(cwd);
          const record = renderMarkdownRecord(runId, events, estimateCosts(rows, cfg.cost), rows);
          const receipt = writeEvidenceExport(exportPath, record, { existsSync, writeFileSync, renameSync, unlinkSync, statSync }, true);
          state = { ...state, overlay: [receipt.ok ? `Exported ${receipt.path} (${receipt.bytes} bytes)` : receipt.reason], overlayOffset: 0 };
          exportPath = undefined;
        } else if (text === "n" || k.escape) { exportPath = undefined; state = { ...state, overlay: undefined }; }
        publish(); return true;
      }
      if (state.reviewing) {
        if (text === "y") { state = { ...state, staged: [], reviewing: false, quit: true }; stop(); }
        else if (text === "n" || k.escape) state = { ...state, reviewing: false, overlay: undefined };
        publish(); return true;
      }
      if (state.editor !== undefined) {
        if (k.escape) state = { ...state, editor: undefined };
        else if (k.return) {
          if (state.editorKind === "export") {
            if (state.editor.trim()) {
              const plan = planEvidenceExport(resolve(cwd, state.editor), { existsSync });
              exportPath = plan.path;
              state = { ...state, editor: undefined, overlay: [`${plan.exists ? "Overwrite" : "Export to"} ${plan.path}`, "y Confirm | n/Esc Cancel"], overlayOffset: 0 };
            }
          } else { selectedEvidence = undefined; state = { ...state, query: state.editor, editor: undefined, scroll: 0 }; }
        }
        else if (k.backspace || k.delete) state = { ...state, editor: [...state.editor].slice(0, -1).join("") };
        else if (!k.ctrl && !k.meta && !/[\x00-\x1f\x7f]/.test(text)) state = { ...state, editor: state.editor + text };
        publish(); return true;
      }
      if (runSession.decisions.confirming || runSession.decisions.menu) {
        if (k.pageUp || k.pageDown) { state = { ...state, overlayOffset: Math.max(0, state.overlayOffset + (k.pageDown ? 1 : -1) * geometry().bodyRows) }; publish(); return true; }
        const snap = source.snapshot();
        const decisions = deriveRunDecisions(Journal.open(cwd, runId), snap.graph.value);
        const next = applyRunViewKey(runSession, event, { tasks: snap.operator.tasks, decisions, verdictLines: 0 });
        runSession = next.session;
        if (runSession.decisions.menu) state = { ...state, overlay: ["Actions — Enter reviews; Esc cancels", ...runSession.decisions.menu.verbs.map((v, i) => `${i === runSession.decisions.menu!.selection ? ">" : " "} ${v}`)], overlayOffset: 0 };
        if (next.open) {
          runSession = { ...runSession, decisions: withDecisionPreview(runSession.decisions, previewDecision(next.open, { cwd, runId, by: "operator" })) };
          const preview = runSession.decisions.confirming;
          if (preview) state = { ...state, overlay: decisionConfirmLines(preview).flatMap(t => wrapCells(t, geometry().bodyColumns)), overlayOffset: 0 };
        }
        if (next.confirm) {
          void executeDecision(next.confirm, { cwd }).then(receipt => {
            if (done) return;
            runSession = { ...runSession, decisions: withDecisionReceipt(runSession.decisions, receipt) };
            state = { ...state, overlay: [receipt.ok ? "Decision recorded; refresh reads its journal append" : receipt.refusal], overlayOffset: 0 };
            source.refresh();
          }).catch(stop);
        } else if (!runSession.decisions.confirming && !runSession.decisions.menu) state = { ...state, overlay: undefined };
        publish(); return true;
      }
      if (k.escape) {
        state = state.overlay ? { ...state, overlay: undefined } : state.help ? { ...state, help: false } : { ...state, query: "", scroll: 0 };
      } else if (text === "q") {
        if (state.staged.length) state = { ...state, reviewing: true, overlay: ["Review staged edits before quitting", ...state.staged, "y Discard staged edits and quit | n/Esc Cancel"], overlayOffset: 0 };
        else { state = { ...state, quit: true }; stop(); }
      }
      else if (state.overlay || state.help) {
        if (text === "?") state = { ...state, help: false };
        if (k.pageDown || k.pageUp) state = { ...state, overlayOffset: Math.max(0, state.overlayOffset + (k.pageDown ? 1 : -1) * geometry().bodyRows) };
      } else if (k.tab) {
        const focus = geometry().focus;
        state = { ...state, focus: focus[(Math.max(0, focus.indexOf(state.focus)) + (k.shift ? focus.length - 1 : 1)) % focus.length]! };
      } else {
        const action = shellBindings(state).find(b => b.key === text)?.action;
        if (action === "home" || action === "run" || action === "evidence") state = { ...state, view: action, scroll: 0, evidenceSection: action === state.view ? state.evidenceSection : 0 };
        else if (action === "widen" || action === "narrow") state = { ...state, shortcutColumns: planShell(geometry().columns, geometry().rows, geometry().shortcuts + (action === "widen" ? 1 : -1)).shortcuts };
        else if (action === "help") state = { ...state, help: true, overlayOffset: 0 };
        else if (action === "filter") state = { ...state, editor: state.query, editorKind: "filter" };
        else if (action === "export") { if (!terminal) forwardLeaf("e"); }
        else if (state.view === "evidence" && (k.leftArrow || k.rightArrow)) state = { ...state, evidenceSection: ((state.evidenceSection ?? 0) + (k.rightArrow ? 1 : 4)) % 5 };
        else if ((k.pageDown || k.pageUp) && state.view !== "run") state = { ...state, scroll: Math.max(0, state.scroll + (k.pageDown ? 1 : -1) * geometry().bodyRows) };
        else if (k.return || action === "open") {
          if (state.view === "run") openDetail();
          else if (!terminal && (state.view === "home" || !state.evidenceSection)) forwardLeaf("\r");
        }
        else if (state.view === "run") {
          if (text === "o") { void focusTask().catch(error => { if (!done) { state = { ...state, overlay: [String(error), "Pane focus refused; Enter opens task evidence after Esc"], overlayOffset: 0 }; publish(); } }); return true; }
          const snap = source.snapshot();
          const decisions = text === "a" ? deriveRunDecisions(Journal.open(cwd, runId), snap.graph.value) : [];
          const task = snap.operator.tasks[runSession.selection];
          const cells = task ? runGateCells(task, evidenceLookup(snap.journal.history, source.page)) : [];
          runSession = applyRunViewKey(runSession, event, { tasks: snap.operator.tasks, decisions, verdictLines: cells[runSession.verdictGate]?.verdict.length ?? 0 }).session;
          if (k.upArrow || k.downArrow) followSelection();
          if (k.pageDown || k.pageUp) state = {
            ...state,
            // The Run leaf owns verdict paging; the shell only moves its viewport so that leaf's
            // verdict panel is seen — it sits below the board and the selected task's cells, so the
            // viewport goes to the leaf's end (clamped by the shell), not one page down.
            scroll: k.pageDown ? Number.MAX_SAFE_INTEGER : 0,
          };
          if (runSession.decisions.menu) state = { ...state, overlay: ["Actions — Enter reviews; Esc cancels", ...runSession.decisions.menu.verbs], overlayOffset: 0 };
          else if (text === "a") state = { ...state, overlay: ["No actionable park selected", "tickmarkr resume " + runId], overlayOffset: 0 };
        } else if (text === "a") state = { ...state, overlay: ["Existing CLI actions", "tickmarkr fleet", "tickmarkr plan", "tickmarkr doctor"], overlayOffset: 0 };
      }
      if (!terminal && state.view !== "run" && !state.overlay && !state.help && state.editor === undefined) {
        const bytes = k.upArrow ? "\x1b[A" : k.downArrow ? "\x1b[B" : k.rightArrow ? "\x1b[C" : k.leftArrow ? "\x1b[D" : k.pageUp ? "\x1b[5~" : k.pageDown ? "\x1b[6~" : text === "f" ? "f" : undefined;
        if (bytes) forwardLeaf(bytes);
      }
      source.input(); return true;
    };
    const pointer = (report: PointerReport) => {
      const p = committed;
      if (!p || p.refused || report.column < 0 || report.column >= p.columns || report.row < 0 || report.row >= p.rows) return false;
      if (dragColumn !== undefined) {
        if (report.action === "release" || (report.button !== undefined && (report.button & 3) === 3)) { dragColumn = undefined; return true; }
        if (report.action === "move") {
          const delta = report.column - dragColumn; dragColumn = report.column;
          for (let steps = Math.abs(delta); steps > 0; steps--) key({ input: delta > 0 ? "-" : "+", key: {} });
          return true;
        }
      }
      if (report.action === "wheel-down" || report.action === "wheel-up") return key({ input: "", key: { pageDown: report.action === "wheel-down", pageUp: report.action === "wheel-up" } });
      if (report.action !== "press") return false;
      if (state.editor !== undefined || state.overlay || state.help) return false;
      const target = committedTargets.find(target => report.column >= target.column && report.column < target.column + target.columns
        && report.row >= target.row && report.row < target.row + target.rows);
      if (target?.kind === "resize") { dragColumn = report.column; return true; }
      if (target?.kind === "key") {
        const binding = target.binding;
        return key({ input: binding.key, key: { tab: binding.key === "Tab", return: binding.key === "Enter", pageDown: binding.action === "page" } });
      }
      if (report.row < p.bodyRow || report.row >= p.bodyRow + p.bodyRows || report.column < p.bodyColumn || report.column >= p.bodyColumn + p.bodyColumns) return false;
      state = { ...state, focus: "content" };
      if (target?.kind === "task" || target?.kind === "park") {
        const index = source.snapshot().operator.tasks.findIndex(task => task.id === target.id);
        if (index >= 0) {
          // A key may have changed the pending view since this row painted.
          // Execute the clicked row's context, not that uncommitted view.
          state = { ...state, view: "run", scroll: target.kind === "park" ? 0 : p.scroll };
          const direction = index > runSession.selection ? "downArrow" : "upArrow";
          for (let steps = Math.abs(index - runSession.selection); steps > 0; steps--) key({ input: "", key: { [direction]: true } });
        }
      } else if (target?.kind === "diagnostic") {
        state = { ...state, overlay: [target.id], overlayOffset: 0 };
      } else if (target?.kind === "evidence") {
        if (target.open) openEvidence(target.identity);
        else {
          if (state.view === "evidence") for (let section = state.evidenceSection ?? 0; section > 0; section--) forwardLeaf("\x1b[D");
          // The leaf may have moved with arrows since this identity was last
          // requested. Every click is a new navigation, even to the same #L.
          evidenceNavigation++;
          selectedEvidence = target.identity;
          state = { ...state, view: "evidence", scroll: p.scroll, evidenceSection: 0 };
        }
      }
      publish(); return true;
    };
    const delivery: ShellDelivery = { geometry: () => committed, snapshot: () => ({ state, store: source.snapshot(), interaction: state }), key, pointer, refresh: () => {
      if (done) return false;
      try { if (observation?.stopRequested()) { stop(); return false; } const snap = source.refresh(); if (options.observeRun !== false && snap.journal.status === "unreadable") stop(new Error(snap.journal.error?.error ?? "journal unreadable")); return true; } catch (e) { stop(e); return false; }
    }, diagnostics: source.diagnostics, stage: edits => { state = { ...state, staged: [...edits] }; publish(); } };
    options.onDelivery?.(delivery);
    options.onShellDelivery?.(delivery);
    resize = () => {
      const p = geometry();
      if (!p.focus.includes(state.focus)) state = { ...state, focus: "content" };
      source.resize(p.columns, p.rows);
    };
    output.on("resize", resize);
    const reader = createPointerReportReader();
    const stdin = new Proxy(input, { get(target, property) {
      if (property === "read") return () => {
        try {
          let keys = "";
          // OBS-965: drain until the stream itself says empty. A real tty (highWaterMark 0) stops its
          // handle after every chunk and only a read() that finds the buffer EMPTY restarts it; Ink's
          // loop stops at the first null, so returning null after ONE pointer-only chunk left that
          // empty read unmade and every later key queued in the kernel — the deaf board.
          for (let chunk = target.read(); chunk != null; chunk = target.read()) {
            for (const token of reader(String(chunk)).tokens) { if (token.type === "pointer") pointer(token.report); else keys += token.bytes; }
          }
          // A standalone Escape is unambiguous after Ink's own input grace.
          if (reader.pending() === "\x1b") for (const token of reader.flush().tokens) if (token.type === "keys") keys += token.bytes;
          return keys || null;
        } catch (error) { stop(error); return null; }
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    function App() {
      useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision);
      const stdinContext = useStdin();
      useLayoutEffect(() => {
        const emitter = stdinContext.internal_eventEmitter;
        leafInput = emitter;
        // Ink strips an escape sequence's ESC before useInput sees it, so an unnamed CSI and typed
        // "[..." look alike there. Its parser emits every escape sequence as its own event, so the RAW
        // event says which it was. Registered in a layout effect, this listener runs before useInput's.
        const raw = (data: string) => { lastRawInput = data; };
        emitter?.on("input", raw);
        return () => { leafInput = undefined; emitter?.off("input", raw); };
      }, [stdinContext.internal_eventEmitter]);
      const renderedView = state.view;
      const leafActive = state.editor === undefined && !state.overlay && !state.help && !state.reviewing;
      useInput((text, k) => {
        if (forwarding || (leafActive && renderedView !== "run" && (k.return || (renderedView === "evidence" && text === "e")))) return;
        // OBS-1002: Ink hands a coalesced chunk ("a\r", "na\r" — a paste, key repeat under load, a
        // `pane run` message) to the handler as ONE string with no key flags, and a single-key map
        // ignores it. Split every non-escape chunk into one event per code point; an escape sequence
        // (arrows, page keys) is one key and already carries its flags.
        const flagged = k.ctrl || k.meta || k.upArrow || k.downArrow || k.leftArrow || k.rightArrow || k.pageUp || k.pageDown || k.return || k.escape || k.tab || k.backspace || k.delete;
        const points = !flagged && !lastRawInput.startsWith("\x1b") && [...text].length > 1 ? [...text] : [text];
        try {
          for (const point of points) {
            const event = points.length === 1 ? { input: text, key: k }
              : point === "\r" || point === "\n" ? { input: "", key: { return: true } }
              : point === "\t" ? { input: "", key: { tab: true } }
              : point === "\x1b" ? { input: "", key: { escape: true } }
              : { input: point, key: { shift: /[A-Z]/.test(point) } };
            key(event, true);
          }
        } catch (error) { stop(error); }
      });
      const snap = source.snapshot();
      const p = geometry();
      const nextDecisionsKey = `${snap.journal.generation}:${snap.journal.offset}:${snap.graph.identity}`;
      if (nextDecisionsKey !== decisionsKey) {
        decisionsKey = nextDecisionsKey;
        visibleDecisions = snap.operator.tasks.some(t => t.state === "human") ? deriveRunDecisions(Journal.open(cwd, runId), snap.graph.value) : [];
      }
      state = { ...state, canOpen: state.view === "home"
        ? snap.operator.lifecycle !== "UNKNOWN" && (snap.operator.tasks.some(t => t.state === "human" || t.state === "blocked") || snap.journal.history.some(row => row.event))
        : state.view === "run" ? snap.operator.tasks.length > 0
        : false };

      const model = deriveEvidenceView({ rows: snap.journal.history, source: snap.journal.source });
      const journal = model.journal.map(item => {
        const row = snap.journal.history.find(r => r.line === item.evidence.line);
        return presentEvidenceRow(item, row?.event);
      });
      const homeActivity = journal.slice().reverse().map(row => ({ ...row, text: `#L${row.evidence.line} ${row.text}` }));
      let evidenceRows: EvidenceRow[] = journal;
      if (selectedEvidence && !journal.some(row => row.evidence.id === selectedEvidence!.id)) {
        const row = source.page(selectedEvidence.line, 1)[0];
        if (row?.event) evidenceRows = [...deriveEvidenceView({ rows: [row], source: snap.journal.source }).journal.map(item => presentEvidenceRow({ ...item, evidence: selectedEvidence! }, row.event)), ...journal];
      }
      if (state.query) evidenceRows = evidenceRows.filter(row => row.text.includes(state.query) || row.fullText.includes(state.query));
      state = { ...state, canResize: p.shortcuts > 0 };
      if (state.view === "evidence") state = { ...state, canOpen: evidenceRows.some(row => row.evidence.id === activeEvidence) };
      const bindings = shellBindings(state);
      const mergedTasks = new Set<string>();
      const mergeTrend: number[] = [];
      for (const row of snap.journal.history) {
        if (row.event?.event === "merge" && row.event.taskId && !mergedTasks.has(row.event.taskId)) {
          mergedTasks.add(row.event.taskId); mergeTrend.push(mergedTasks.size);
        }
      }
      // Commit pointer identities from the very model supplied to Home. Its
      // human-first Needs-you ordering can differ from graph declaration order.
      const homeModel = deriveHomeView({ operator: snap.operator,
        trend: mergeTrend.length > 1 ? mergeTrend : [],
        seats: { active: snap.operator.tasks.filter(t => t.state === "running").length, eligible: 0 },
        activity: homeActivity,
        diagnostics: options.diagnostics });
      const focused = state.editor === undefined && !state.overlay && !state.help;
      return <CockpitShell snapshot={options.observeRun === false ? { ...snap, journal: { ...snap.journal, source: "no run/journal.jsonl" } } : snap} state={state} columns={p.columns} rows={p.rows} version={options.binaryVersion} colour={colour} onCommit={plan => {
        committed = plan;
        const targets: Target[] = [];
        // A board row opens with the prototype's four-cell indent or the focus marker, then the id;
        // the first painted row naming a task is that task's target (the effort fold names it again, later).
        const boardRowId = (text: string): string | undefined => /^(?: {4}| {2}❯ )(\S+)/u.exec(stripBoardAnsi(text))?.[1];
        const usedTasks = new Set<string>();
        for (const row of plan.paintedRows) {
          if (row.row < plan.bodyRow && (row.text.startsWith("1 Home") || row.text.startsWith("1H"))) {
            for (const binding of bindings.filter(binding => ["home", "run", "evidence"].includes(binding.action))) {
              const caption = plan.columns < 60 ? `${binding.key}${binding.label[0]}` : `${binding.key} ${binding.label}`;
              const index = row.text.indexOf(caption);
              if (index >= 0) targets.push({ ...row, column: row.column + cellWidth(row.text.slice(0, index)), columns: cellWidth(caption), kind: "key", binding });
            }
          }
          if (row.row >= plan.bodyRow + plan.bodyRows && row.text.includes("q Quit")) {
            for (const binding of bindings) {
              const caption = `${binding.key} ${binding.action === "actions" && plan.columns < 60 ? "Act" : binding.label}`;
              const index = row.text.indexOf(caption);
              if (index >= 0) targets.push({ ...row, column: row.column + cellWidth(row.text.slice(0, index)), columns: cellWidth(caption), kind: "key", binding });
            }
          }
          if (row.row < plan.bodyRow || row.row >= plan.bodyRow + plan.bodyRows) continue;
          if (plan.shortcuts && row.column === plan.bodyColumn + plan.bodyColumns && row.text === "│") {
            targets.push({ ...row, kind: "resize" }); continue;
          }
          if (row.column < plan.bodyColumn || row.column >= plan.bodyColumn + plan.bodyColumns) {
            const binding = bindings.find(binding => row.text.trim() === `${binding.key} ${binding.label}`);
            if (binding) targets.push({ ...row, kind: "key", binding });
            continue;
          }
          if (state.view === "run") {
            const drawn = boardRowId(row.text);
            // A narrow body clips the row inside a long id; the drawn prefix still names one task.
            const id = drawn === undefined ? undefined : (snap.operator.tasks.find(task => task.id === drawn) ?? snap.operator.tasks.find(task => task.id.startsWith(drawn)))?.id;
            if (id !== undefined && !usedTasks.has(id)) { usedTasks.add(id); targets.push({ ...row, kind: "task", id }); }
          } else {
            const cleanText = row.text.trim().startsWith(GLYPHS.pointer)
              ? row.text.trim().slice(GLYPHS.pointer.length).trim()
              : row.text.trim();
            const evidence = state.view === "home"
              ? homeActivity.find(item => row.text.trim() === item.text || cleanText === item.text)
              : evidenceRows.find(item => row.evidenceId === item.evidence.id);
            if (evidence) targets.push({ ...row, column: plan.bodyColumn, columns: plan.bodyColumns,
              kind: "evidence", identity: evidence.evidence, open: state.view === "home" });
            if (state.view === "home" && row.text.startsWith("NEEDS YOU")) {
              const target = selectNeedsYouTarget(homeModel, homeNeedsYouIndex);
              if (target?.kind === "park") targets.push({ ...row, kind: "park", id: target.id });
              else if (target?.kind === "diagnostic") targets.push({ ...row, kind: "diagnostic", id: target.id });
            }
          }
        }
        committedTargets = targets;
      }}>
        {state.view === "home" ? <ShellGridFlow width={p.bodyColumns} columns={p.columns < 120 ? 2 : 3} rowHeight={p.rows < 20 ? 1 : p.columns < 120 ? 2 : 3}><HomeView key={String(homeModel.needsYou.length > 0)} width={p.bodyColumns} model={homeModel} focused={focused}
          onOpenPark={id => { runSession = { ...runSession, selection: Math.max(0, snap.operator.tasks.findIndex(t => t.id === id)) }; state = { ...state, view: "run", scroll: 0 }; followSelection(); publish(); }}
          onOpenDiagnostic={id => { state = { ...state, overlay: [id], overlayOffset: 0 }; publish(); }} onOpenEvidence={openEvidence}
          onSelectNeedsYou={reportHomeNeedsYouSelection} /></ShellGridFlow> :
        state.view === "run" ? <RunView snapshot={snap.operator} rows={snap.journal.history} page={source.page} graph={snap.graph.value} decisions={visibleDecisions} session={runSession} columns={p.bodyColumns} run={approvalRunOwner(cwd, runId)} now={options.now} /> :
        <ShellJournalSelection.Provider value={reportEvidenceSelection}><EvidenceView key={`${state.query}:${evidenceNavigation}`} width={p.bodyColumns} model={{ ...model, journal: evidenceRows }} focusEvidence={selectedEvidence} focused={focused} onExport={beginExport} onSelect={id => { selectedEvidence = id; openDetail(); publish(); }} /></ShellJournalSelection.Provider>}
      </CockpitShell>;
    }
    app = render(<App />, { stdin, stdout: output, debug: options.debug, exitOnCtrlC: false, patchConsole: false });
    void app.waitUntilExit().then(() => stop(), stop);
    timer = setInterval(delivery.refresh, options.refreshMs ?? 1000);
    await stopped;
    unsubscribe(); listeners.clear();
  } catch (error) { failure = error; }
  finally {
    if (timer) clearInterval(timer);
    output.off("resize", resize);
    process.off("SIGTERM", signal); process.off("SIGINT", signal);
    try { app?.unmount(); } catch (e) { failure ??= e; }
    store?.dispose();
    try { if (input.isTTY) input.setRawMode(wasRaw); if (wasPaused) input.pause(); else input.resume(); } catch (e) { failure ??= e; }
    try { if (entered) output.write(SHELL_TERMINAL_RESTORE); } catch (e) { failure ??= e; }
    input.off("error", ioError); output.off("error", ioError);
    releaseTimeline();
    try { observation?.close(); } catch (e) { failure ??= e; }
  }
  if (failure) throw failure;
}
