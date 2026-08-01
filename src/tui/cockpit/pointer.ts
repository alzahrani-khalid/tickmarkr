import {
  dispatchRunKey,
  RUN_INPUT_BINDINGS,
  RUN_PANEL_FOCUS_ORDER,
  RUN_SIDE_RAIL_COLUMN_FLOOR,
  runPanelFocusOrder,
  type RunInteractionState,
  type RunKeyEvent,
} from "./keys.js";
import {
  FRAME_VIEWS,
  type FrameRegion,
  type FrameRegionId,
  type FrameView,
  type PlannedFrame,
} from "./layout.js";

/**
 * THE pointer layer of the run cockpit. Three laws govern every line of it:
 *
 * 1. HIT-TESTING RESOLVES THROUGH THE PLAN. A cell becomes a target by being
 *    looked up in planFrame's own output — the plan the conformance oracle
 *    pins — and every offset inside it is planned too: the bands from
 *    `plan.regions`, which the item rows are a member of, and the rail's view
 *    rows from `plan.sidebar.viewRows`. Both are read, never reconstructed:
 *    this layer performs no geometric arithmetic at all, so there is no
 *    expression here for a plan change to leave behind. The plan is the whole
 *    input: nothing is passed beside it, so no caller can hand this layer a
 *    rectangle the plan did not produce. It owns no constant of the drawn
 *    chrome and imports none:
 *    it never measures the terminal, subtracts a border, re-derives a band or
 *    caches a rectangle. v1.83 deleted withBandGeometry for exactly that
 *    defect, and it does not return wearing a mouse.
 * 2. EVERY POINTER ACTION IS A KEY'S TRANSITION. The pointer dispatches only
 *    keys through the one registry; it never manufactures focus, selection or
 *    prompt state beside the keyboard and then restores it afterward.
 * 3. A POINTER ACTION IS NEVER ROUTED THROUGH WHATEVER SCOPE IS LIVE. A click
 *    means the target it hit, so the / prompt — a keyboard scope in which a
 *    digit is filter text and ⏎ applies a filter — is retired before any
 *    transition is dispatched. Otherwise clicking Gates would type "3". The
 *    wheel dispatches through that same normal roster but restores the prompt
 *    afterwards: a scroll names no target, so it may not retire one panel's
 *    prompt on its way to scrolling another.
 * 4. WHERE THE POINTER IS RESTING IS DRAWN STATE, NOT A TRANSITION. It is the
 *    one piece of pointer state no key has an equivalent for, so it travels
 *    beside the transition rather than inside it — see `pointerRestingCell`.
 */

/** SGR-1006 (`ESC [ < b ; x ; y M|m`) — the one pointer reporting mode read. */
const SGR_POINTER_REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/gu;

/**
 * The terminal reports no pointer at all until it is asked to, so the parser
 * above reads nothing until these bytes are written. DECSET 1000 turns on normal
 * tracking — presses, releases and the wheel. DECSET 1006 asks for them in SGR
 * encoding: the one grammar `SGR_POINTER_REPORT` reads, and the only one that
 * can state a cell past column 223 at all. DECSET 1003 widens that to motion
 * with no button held — the only way a terminal ever says where the pointer is
 * merely resting, and therefore the whole reason a hover highlight can exist
 * at all. It is asked for last, so the widest tracking mode is the one asked
 * for in the grammar already selected. The request lives beside the parser so a
 * change to what is read cannot leave what is asked for behind.
 */
export const POINTER_TRACKING_ON = "\x1b[?1000h\x1b[?1006h\x1b[?1003h";

/** The same three modes turned off, in exact reverse of the order they were
 * asked for — a terminal left tracking writes reports into whatever runs after
 * the cockpit exits. */
export const POINTER_TRACKING_OFF = "\x1b[?1003l\x1b[?1006l\x1b[?1000l";

/**
 * The signals that end a process where nothing else repays the loan: they run
 * no `finally`, unwind no stack and unmount no renderer, so a surface killed by
 * one would leave the operator's terminal reporting a pointer into whatever
 * shell comes next. Listening for them is the only way to hand the modes back.
 *
 * The roster is every catchable POSIX terminator an interactive cockpit is
 * actually killed by — ⌃C, a `kill`, a closed terminal, and ⌃\ — not a
 * shortlist of the three that came to mind. A signal missing from here is a
 * terminal left reporting, so the test that guards it names its own required
 * set rather than reading this one back.
 */
export const POINTER_RELEASE_SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
] as const satisfies readonly NodeJS.Signals[];

/**
 * The roster a given host can actually receive. SIGQUIT is a POSIX terminator
 * with no Windows counterpart — libuv refuses the listener there — so the one
 * platform that can never be killed by it is the one that does not listen for
 * it. Every other platform listens for all four.
 */
function releaseSignals(host: PointerTrackingHost): readonly NodeJS.Signals[] {
  return (host.platform ?? process.platform) === "win32"
    ? POINTER_RELEASE_SIGNALS.filter((signal) => signal !== "SIGQUIT")
    : POINTER_RELEASE_SIGNALS;
}

/** A cell the pointer can be at, counted from zero like every planned region. */
export type PointerCell = { readonly column: number; readonly row: number };

/**
 * WHERE THE POINTER IS RESTING — the fourth law's state, and the only pointer
 * state the keyboard has no equivalent for.
 *
 * It is drawn state and nothing else: no key produces it, no interaction
 * transition carries it, no journal records it, nothing reads it back to decide
 * anything, and no capture ever asks for it. So it travels BESIDE the
 * transition `applyPointerReport` returns rather than inside it, which is what
 * lets a resting pointer stay no transition at all — it moves no marker, opens
 * no view and selects nothing.
 *
 * Both writers are in this file, and both are the terminal telling us something
 * rather than a surface deciding something: every report states where the
 * pointer now is, and the tracking loan's release states that the terminal has
 * stopped saying. Release restores exactly the state that stands before the
 * first report ever arrives, so a surface nobody has pointed at yet and a
 * surface whose loan was repaid are the same surface.
 *
 * ponytail: one process drives one terminal and a terminal has one pointer, so
 * this is one cell rather than a store per surface; make it surface-owned if a
 * process ever paints two cockpits at once.
 */
let restingCell: PointerCell | null = null;
const restWatchers = new Set<() => void>();

function reportPointerRest(cell: PointerCell | null): void {
  if (
    cell === null
      ? restingCell === null
      : restingCell !== null && restingCell.column === cell.column
        && restingCell.row === cell.row
  ) return;
  // Copied rather than aliased: a report object stays its reader's own.
  restingCell = cell === null ? null : { column: cell.column, row: cell.row };
  for (const watcher of restWatchers) watcher();
}

/**
 * The cell the pointer is resting on, or none. The same reference for as long
 * as it has not moved, so a watcher redraws when the pointer moves and at no
 * other time.
 */
export function pointerRestingCell(): PointerCell | null {
  return restingCell;
}

/** Watch the resting cell. The returned call stops watching. */
export function watchPointerRest(watcher: () => void): () => void {
  restWatchers.add(watcher);
  return () => {
    restWatchers.delete(watcher);
  };
}

/**
 * THE SESSION PANEL OVERRIDE — the rail columns the operator dragged the
 * rail/body boundary to, this session only. Like the resting cell it is drawn
 * state no key has an equivalent for, so it travels beside the transitions
 * `applyPointerReport` returns rather than inside one: a drag moves no marker,
 * opens no view and selects nothing, it re-PLANS. The override is an input to
 * planFrame (`FrameState.railColumns`), never a bypass of it — the plan
 * recomputes from the measured size plus this override, clamps it at the
 * panels' readable floors, and the renderer draws the recomputed plan
 * unmodified, so drawn still equals planned everywhere.
 *
 * It lives only in the running process: nothing writes it to disk, the
 * journal, or anywhere else, and a relaunch starts with none — the default
 * layout draws. The process boundary is marked by the tracking loan: a fresh
 * `borrowPointerTracking` is a fresh session and clears whatever a previous
 * session dragged to.
 */
let railOverride: number | null = null;
const overrideWatchers = new Set<() => void>();
/** Set by a press on the panel boundary, released by the button's release. */
let boundaryDrag = false;

function reportRailOverride(columns: number | null): void {
  if (railOverride === columns) return;
  railOverride = columns;
  for (const watcher of overrideWatchers) watcher();
}

/**
 * The rail columns the session dragged the boundary to, or none. The same
 * reference for as long as it has not changed, so a watcher redraws when the
 * drag moves the boundary and at no other time.
 */
export function sessionRailOverride(): number | null {
  return railOverride;
}

/** Watch the session override. The returned call stops watching. */
export function watchSessionRailOverride(watcher: () => void): () => void {
  overrideWatchers.add(watcher);
  return () => {
    overrideWatchers.delete(watcher);
  };
}

/**
 * The session boundary the relaunch contract is stated against: the override
 * and any drag in progress are gone, exactly as a new process starts. The
 * production marker is the tracking loan — a fresh borrow is a fresh session.
 */
export function resetSessionRailOverride(): void {
  boundaryDrag = false;
  reportRailOverride(null);
}

/** The stream the modes are asked of — a real terminal, or something that is not one. */
export type PointerTrackingTerminal = {
  readonly isTTY?: boolean;
  readonly write: (bytes: string) => unknown;
};

/** The process the loan registers its last-resort repayment with. */
export type PointerTrackingHost = {
  readonly pid: number;
  readonly on: (signal: NodeJS.Signals, listener: () => void) => unknown;
  readonly off: (signal: NodeJS.Signals, listener: () => void) => unknown;
  readonly kill: (pid: number, signal: NodeJS.Signals) => unknown;
  /** Which signals this host can be killed by at all — `process.platform`. */
  readonly platform?: NodeJS.Platform;
};

/**
 * Borrow pointer reporting, and return the one way to repay it.
 *
 * The loan is the whole lifecycle in one expression, so no caller can hold half
 * of it. Only an interactive terminal is asked at all: writing mode requests
 * into a pipe puts escape bytes in a capture rather than a mouse on a surface
 * nobody is pointing at, so the non-tty and CI surfaces carry no enable
 * sequence because none is ever written — not because a later guard strips one.
 *
 * Repayment is idempotent and reachable from every exit: the returned release
 * for an ordinary return, the same release run from a `finally` or a renderer's
 * cleanup for a thrown failure, and the signal listeners registered here for
 * the exits that run neither. A listener repays and then re-raises its own
 * signal with our listener removed, so the process still ends exactly the way
 * the signal meant it to.
 */
export function borrowPointerTracking(
  terminal: PointerTrackingTerminal,
  host: PointerTrackingHost = process,
): () => void {
  // A fresh loan is a fresh session: the override a previous session dragged
  // the panel boundary to dies with it — a relaunch draws the original layout.
  resetSessionRailOverride();
  if (terminal.isTTY !== true) return () => {};
  const listeners: (readonly [NodeJS.Signals, () => void])[] = [];
  let lent = true;
  const release = (): void => {
    if (!lent) return;
    lent = false;
    for (const [signal, listener] of listeners) host.off(signal, listener);
    // The terminal stops saying where the pointer is, so nothing is resting
    // anywhere any more — and a frame drawn after this draws no highlight.
    reportPointerRest(null);
    terminal.write(POINTER_TRACKING_OFF);
  };
  for (const signal of releaseSignals(host)) {
    const listener = (): void => {
      release();
      host.kill(host.pid, signal);
    };
    listeners.push([signal, listener]);
    host.on(signal, listener);
  }
  // Asked for only once the repayment path stands: a loan taken before that
  // could be one the signal listeners were never registered for.
  terminal.write(POINTER_TRACKING_ON);
  return release;
}

/** SGR-1006 encodes the wheel in bit 6 and pointer motion in bit 5. */
const WHEEL_BIT = 64;
const MOTION_BIT = 32;

export type PointerAction =
  | "press"
  | "release"
  | "move"
  | "wheel-up"
  | "wheel-down";

/** One reported pointer event, its cell zero-based like every planned region. */
export type PointerReport = {
  readonly action: PointerAction;
  readonly column: number;
  readonly row: number;
  /**
   * The raw SGR button code the report arrived with. The action alone throws
   * information away that a drag latch cannot survive without: under DECSET
   * 1003 a motion with NO button held reports button 35 — `(button & 3) === 3`
   * — and that no-button motion is the only signal that a release lost
   * outside the window (the pointer let go past the terminal's edge, which
   * sends no release at all) has already happened. Absent only on a report
   * built by hand rather than parsed off the wire; a hand-built move is read
   * as a drag-motion, the reading that cannot end a drag its producer had no
   * way to describe.
   */
  readonly button?: number;
};

/** What one chunk of terminal input turned out to be: the reports it carried,
 * and the bytes that were not part of any — the keyboard's own input. */
export type PointerReadout = {
  /** Keyboard and pointer input in the byte order the terminal delivered it. */
  readonly tokens: readonly PointerInputToken[];
  readonly reports: readonly PointerReport[];
  readonly keys: string;
};

export type PointerInputToken =
  | { readonly type: "keys"; readonly bytes: string }
  | { readonly type: "pointer"; readonly report: PointerReport };

export type PointerReportReader = {
  (chunk: string): PointerReadout;
  /** Release a prefix that did not receive the bytes needed to become a report. */
  flush(): PointerReadout;
  /** The incomplete report prefix currently withheld from the keyboard. */
  pending(): string;
};

/**
 * The pointer reports carried by a chunk of terminal input. Bytes that are not
 * a report are not pointer input and are left for whoever else reads the
 * stream; a torn or malformed sequence simply reports nothing.
 */
export function parsePointerReports(bytes: string): readonly PointerReport[] {
  const reports: PointerReport[] = [];
  for (const match of bytes.matchAll(SGR_POINTER_REPORT)) {
    const button = Number(match[1]);
    // The terminal counts cells from one; the plan counts them from zero.
    const column = Number(match[2]) - 1;
    const row = Number(match[3]) - 1;
    if (column < 0 || row < 0) continue;
    const action: PointerAction = (button & WHEEL_BIT) !== 0
      ? ((button & 1) === 0 ? "wheel-up" : "wheel-down")
      : (button & MOTION_BIT) !== 0
      ? "move"
      : match[4] === "m"
      ? "release"
      : "press";
    reports.push({ action, column, row, button });
  }
  return reports;
}

/**
 * The longest suffix of `bytes` that is still on its way to being a report: an
 * escape whose `M` or `m` has not arrived yet. A completed report never matches
 * (it ends at its own terminator), so a carried tail can never be reported
 * twice. ponytail: a tail longer than any real report is not one — it is
 * dropped rather than accumulated, which is also what bounds this buffer.
 */
const TORN_POINTER_REPORT = /\x1b(?:\[(?:<[\d;]*)?)?$/u;
const MAX_TORN_REPORT_BYTES = 32;

function tornPointerTail(bytes: string): string {
  const torn = TORN_POINTER_REPORT.exec(bytes)?.[0] ?? "";
  return torn.length > MAX_TORN_REPORT_BYTES ? "" : torn;
}

/**
 * A reader over the input stream rather than over one chunk. The terminal
 * writes bytes, not messages: a single report is free to arrive split across
 * chunks, and chunk-at-a-time parsing silently drops every report that lands on
 * a boundary. The reader carries the torn tail into the next chunk and reports
 * only sequences that have completed.
 *
 * It also states what was left — the bytes of that chunk that belonged to no
 * report, including none at all while a torn one is still arriving. Reports and
 * keys share one stream, so this is the only place that can tell them apart:
 * downstream, a whole report is an unnameable escape sequence and half a report
 * is the single character it happens to end on, either of which would be read as
 * a keystroke by whatever scope is live.
 */
export function createPointerReportReader(): PointerReportReader {
  let carry = "";

  const readComplete = (complete: string): PointerReadout => {
    const tokens: PointerInputToken[] = [];
    let offset = 0;
    for (const match of complete.matchAll(SGR_POINTER_REPORT)) {
      const index = match.index;
      if (index > offset) {
        tokens.push({ type: "keys", bytes: complete.slice(offset, index) });
      }
      const report = parsePointerReports(match[0])[0];
      if (report !== undefined) tokens.push({ type: "pointer", report });
      offset = index + match[0].length;
    }
    if (offset < complete.length) {
      tokens.push({ type: "keys", bytes: complete.slice(offset) });
    }
    return {
      tokens,
      reports: tokens.flatMap((token) =>
        token.type === "pointer" ? [token.report] : []
      ),
      keys: tokens.flatMap((token) => token.type === "keys" ? [token.bytes] : [])
        .join(""),
    };
  };

  const reader = ((chunk: string) => {
    const bytes = carry + chunk;
    carry = tornPointerTail(bytes);
    const complete = carry.length > 0 ? bytes.slice(0, -carry.length) : bytes;
    return readComplete(complete);
  }) as PointerReportReader;
  reader.flush = () => {
    const pending = carry;
    carry = "";
    return readComplete(pending);
  };
  reader.pending = () => carry;
  return reader;
}

/**
 * The width the key registry resolves at for the bands THIS plan drew. The
 * focus order follows the plan rather than a second reading of the terminal:
 * between 64 and 79 columns the plan draws the rail at a width the key floor
 * alone would deny it, and the click targets and the focus order have to agree
 * about that band or a click would act on a panel the frame does not show.
 */
export function plannedKeyColumns(plan: PlannedFrame): number {
  return plan.band === "sidebar"
    ? Math.max(plan.size.columns, RUN_SIDE_RAIL_COLUMN_FLOOR)
    : plan.size.columns;
}

/** Which planned band holds which focusable panel — the frame's own two. */
const REGION_PANELS: Partial<
  Record<FrameRegionId, (typeof RUN_PANEL_FOCUS_ORDER)[number]>
> = {
  rail: "VIEWS",
  body: "CONTENT",
  // The item rows are the body band's own nested band: a cell on them is a cell
  // in the body, and focusing it focuses the panel the body draws.
  items: "CONTENT",
};

export type PointerTarget = {
  /** The tightest planned region containing the cell. */
  readonly region: FrameRegion;
  /** The rail's menu row under the cell, when the cell is on one. */
  readonly view?: number;
  /** The body's drawn row under the cell, counted from the planned item region's own first row. */
  readonly row?: number;
};

/** The tightest planned region containing a cell — regions nest (the item rows
 * refine the body band, the caption the header's row), so the smallest one owns
 * the cell. */
function plannedRegionAt(
  plan: PlannedFrame,
  cell: { readonly column: number; readonly row: number },
): FrameRegion | undefined {
  let hit: FrameRegion | undefined;
  for (const region of plan.regions) {
    if (!contains(region, cell)) continue;
    if (hit === undefined || region.rows * region.columns < hit.rows * hit.columns) {
      hit = region;
    }
  }
  return hit;
}

/**
 * What the plan says is under a cell. The rail's view rows are
 * `plan.sidebar.viewRows` — frame rows planFrame itself computed, where the
 * label row was decided — so the menu's shape is looked up rather than
 * reconstructed from `menuRows` out here. The body's item rows are a planned
 * band of their own, so the tightest-region lookup lands on them directly and
 * the first item's offset is the region's own row. The view strip the plan draws
 * instead of a rail below 64 columns is one span with no per-view columns in it,
 * so nothing here invents any: a strip cell resolves to the strip band and no
 * further.
 */
export function resolvePointerTarget(
  plan: PlannedFrame,
  cell: { readonly column: number; readonly row: number },
): PointerTarget | undefined {
  const region = plannedRegionAt(plan, cell);
  if (region === undefined) return undefined;
  if (region.id === "rail" && plan.sidebar !== null && plan.tab === "watch") {
    const rows = plan.sidebar.viewRows;
    const view = FRAME_VIEWS.findIndex(
      (name: FrameView) => rows[name] === cell.row,
    );
    return view < 0 ? { region } : { region, view };
  }
  if (region.id === "items") return { region, row: cell.row - region.row };
  return { region };
}

function contains(
  region: FrameRegion,
  cell: { readonly column: number; readonly row: number },
): boolean {
  return cell.row >= region.row
    && cell.row < region.row + region.rows
    && cell.column >= region.column
    && cell.column < region.column + region.columns;
}

/**
 * The focus index a target's band carries at the width the plan drew — the same
 * order the frame paints its focus ring from, so a click can never focus a
 * panel the frame does not show as focusable.
 */
export function pointerFocusPanel(
  plan: PlannedFrame,
  target: PointerTarget,
): number | undefined {
  const panel = REGION_PANELS[target.region.id];
  if (panel === undefined) return undefined;
  const index = runPanelFocusOrder(plannedKeyColumns(plan)).indexOf(panel);
  return index < 0 ? undefined : index;
}

/**
 * The half of a surface a row hit resolves through: the plan the paint drew,
 * and the identities the rows drawn into it carry.
 */
export type PointerRowSurface = {
  readonly plan: PlannedFrame;
  /** The identities the body's drawn rows carry, top to bottom. */
  readonly drawnRowIds: readonly string[];
};

/**
 * The item a cell acts on — THE resolution, shared by every pointer path.
 * A click reads it to decide what to select, and a hover highlight reads the
 * same call to decide what to mark, so the highlight cannot name a row a click
 * at that cell would miss: there is one answer, not two agreeing ones. A cell
 * the plan does not place on an item row, and an item row the paint drew
 * nothing into, are both nothing here rather than a nearest guess.
 */
export function pointerRowAt(
  surface: PointerRowSurface,
  cell: { readonly column: number; readonly row: number },
): string | undefined {
  const target = resolvePointerTarget(surface.plan, cell);
  return target?.row === undefined ? undefined : surface.drawnRowIds[target.row];
}

/** The surface a pointer report acts on: the plan the paint drew, and the rows drawn into it. */
export type PointerSurface = {
  /** planFrame's own output — the only geometry a hit resolves through. */
  readonly plan: PlannedFrame;
  readonly interaction: RunInteractionState;
  /** The identities the body's drawn rows carry, top to bottom. */
  readonly drawnRowIds: readonly string[];
  /** The rows a key may stand on, in the active view's own order. */
  readonly rowIds: readonly string[];
};

/**
 * The frame's one panel boundary: the rail's own last column, the grab cell
 * beside the body's border. The body's border cell itself stays a click
 * target of the body panel — a press there retires the prompt and focuses
 * content exactly as the keyboard's grammar advertises — so the drag handle
 * is the cell this side of it — on the rows the plan gives no other target.
 * A view row's last column already belongs to the view itself, so the handle
 * yields those rows to the plan's own resolution. Read off the plan's own
 * regions like every other target; a band with no rail has no boundary.
 */
function panelBoundaryCell(
  plan: PlannedFrame,
  cell: { readonly column: number; readonly row: number },
): boolean {
  if (plan.band !== "sidebar") return false;
  const rail = plan.regions.find((region) => region.id === "rail");
  if (
    rail === undefined
    || cell.column !== rail.column + rail.columns - 1
    || cell.row < rail.row
    || cell.row >= rail.row + rail.rows
  ) {
    return false;
  }
  // A view row's cell is the view's own click target wherever in the rail the
  // plan puts it — the grab column included (the first law: hit-testing
  // resolves through the plan, and the plan resolves that cell to the view).
  // The handle owns the rail's remaining rows; at the readable floor the
  // rail's last column sits on the final letter of a drawn view name, and a
  // press there is still that view's number key, not a grab.
  return plan.sidebar === null || plan.tab !== "watch" || FRAME_VIEWS.every(
    (name: FrameView) => plan.sidebar!.viewRows[name] !== cell.row,
  );
}

/**
 * The transition a pointer report makes, or undefined when nothing owns the
 * cell. A click on a view name is that view's own number key; a click on the
 * row already marked is ⏎; moving between panels is the advertised dive/back
 * grammar; and a wheel is ↑↓ only when the panel under it already owns ↑↓.
 * An off-focus wheel is not an action: borrowing focus or prompt scope and then
 * restoring it would create a frame no advertised key sequence can reach.
 *
 * A drag of the panel boundary is the exception that proves the second law:
 * it is no transition at all. The press landing on the boundary grabs it; each
 * move hands the plan a new input through the session override; the release
 * lets go — and when the release never arrives because the pointer was let go
 * outside the window, the first no-button motion says so in its stead, so no
 * latch outlives the drag it latched. The interaction comes back untouched —
 * the drag re-plans the frame rather than moving anything inside it.
 */
export function applyPointerReport(
  report: PointerReport,
  surface: PointerSurface,
): RunInteractionState | undefined {
  // Every report states where the pointer now is, whatever else it does or does
  // not do — a move above all, whose whole content is that. This is the one
  // call the live delivery makes for every report it receives, so the resting
  // cell a frame draws its highlight from is fed by the production input path
  // rather than by anything a caller supplies beside it.
  reportPointerRest(report);
  if (report.action === "press" && panelBoundaryCell(surface.plan, report)) {
    boundaryDrag = true;
    return undefined;
  }
  if (boundaryDrag) {
    // A drag-motion — a move with a button still held — is the drag's only
    // content. The requested rail width is where the rail's last column was
    // dragged to; the plan owns the floors and clamps it there, so a drag
    // past a panel's readable floor leaves the panel at the floor rather
    // than collapsing it.
    if (
      report.action === "move"
      && (report.button === undefined || (report.button & 3) !== 3)
    ) {
      reportRailOverride(report.column + 1);
      return undefined;
    }
    // Every other report ENDS the drag rather than feeding it or being
    // swallowed by it. A release lets go. A no-button motion is the terminal
    // saying the button is already up — the only word of the release that
    // never arrives when the pointer is let go outside the window, and the
    // report that would otherwise keep resizing the panel on a bare hover
    // for the rest of the session. And anything else — a press, the wheel —
    // is a fresh action a dead latch may not eat: the latch dies with the
    // drag and the report takes its ordinary route.
    boundaryDrag = false;
    if (report.action === "release") return undefined;
  }
  return pointerTransition(report, surface);
}

/**
 * The transition alone, with no report of where the pointer now is. Asking what
 * a press WOULD do is not the pointer coming to rest anywhere, so the hover
 * resolution below reaches the click's own route through here rather than
 * through the entry point that also moves the resting cell.
 */
function pointerTransition(
  report: PointerReport,
  surface: PointerSurface,
): RunInteractionState | undefined {
  const target = resolvePointerTarget(surface.plan, report);
  if (target === undefined) return undefined;
  const panel = pointerFocusPanel(surface.plan, target);
  const columns = plannedKeyColumns(surface.plan);
  const focusOrder = runPanelFocusOrder(columns);
  const focusedPanel = (state: RunInteractionState): number =>
    state.panel % focusOrder.length;
  const dispatch = (
    event: RunKeyEvent,
    from: RunInteractionState,
  ): RunInteractionState | undefined =>
    dispatchRunKey(
      event,
      from,
      RUN_INPUT_BINDINGS,
      surface.rowIds,
      columns,
    );

  if (report.action === "wheel-up" || report.action === "wheel-down") {
    if (panel === undefined || focusedPanel(surface.interaction) !== panel) {
      return undefined;
    }
    return dispatch(
      {
        input: "",
        key: report.action === "wheel-up"
          ? { upArrow: true }
          : { downArrow: true },
      },
      surface.interaction,
    );
  }
  if (report.action !== "press") return undefined;

  // A click is outside the prompt's input class. Apply the prompt through its
  // own advertised Enter before dispatching the click's advertised route.
  let state = surface.interaction;
  if (state.filterPrompt) {
    const applied = dispatch({ input: "", key: { return: true } }, state);
    if (applied === undefined) return undefined;
    state = applied;
  }
  if (target.view !== undefined) {
    // Number keys are one-based positions in the same rail order.
    return dispatch({ input: String(target.view + 1), key: {} }, state);
  }

  // Focus is never assigned. Dive or back through the advertised grammar until
  // the target panel owns the keyboard, including closing an open detail before
  // backing from content to the rail.
  if (panel !== undefined) {
    for (let attempts = 0; focusedPanel(state) !== panel && attempts < 2; attempts += 1) {
      const next = dispatch(
        panel === focusOrder.indexOf("CONTENT")
          ? { input: "", key: { return: true } }
          : { input: "", key: { leftArrow: true } },
        state,
      );
      if (next === undefined || next === state) return undefined;
      state = next;
    }
    if (focusedPanel(state) !== panel) return undefined;
  }
  if (target.row === undefined) return state;

  // Diving from a mismatched rail marker may legitimately open a different
  // view. The clicked row belonged to the old committed frame, so no stale row
  // transition follows that key-owned view change.
  if (state.activeView !== surface.interaction.activeView) return state;
  const id = pointerRowAt(surface, report);
  const targetIndex = id === undefined ? -1 : surface.rowIds.indexOf(id);
  if (id === undefined || targetIndex < 0) return state;
  if (id === state.selection) {
    return dispatch({ input: "", key: { return: true } }, state) ?? state;
  }

  // A row click is the same finite ↑↓ journey from the current marker. Work on
  // a candidate state so an unreachable target causes no partial transition.
  let candidate = state;
  for (let attempts = 0; attempts <= surface.rowIds.length; attempts += 1) {
    if (candidate.selection === id) return candidate;
    const currentIndex = candidate.selection === null
      ? -1
      : surface.rowIds.indexOf(candidate.selection);
    const next = dispatch(
      {
        input: "",
        key: currentIndex > targetIndex
          ? { upArrow: true }
          : { downArrow: true },
      },
      candidate,
    );
    if (next === undefined || next === candidate) return undefined;
    candidate = next;
  }
  return undefined;
}

/**
 * The item a hover highlight marks: the one a click at that cell would ACT ON.
 *
 * `pointerRowAt` answers a smaller question — which drawn row the plan places
 * under the cell — and a click is not only that lookup. It is a route: the /
 * prompt applied, focus dived or backed to the panel under the pointer, and only
 * then the row. Any of those may legitimately land somewhere else, the plainest
 * case is the rail marker standing on a view the body is not drawing: the click
 * that dives into content opens the MARKED view and selects no row at all, while
 * the rows under the pointer belong to the view being left behind.
 *
 * So the highlight is not decided by the lookup. It is decided by running the
 * click's own transition and asking what it settled on — the same
 * `pointerTransition` the live report path dispatches through, on the same
 * surface, so an answer these two could disagree about is not expressible. A
 * click that acts on something else, or on nothing, lights nothing up.
 *
 * It reports no rest and returns no state: asking is not pointing and not
 * clicking, so the surface is exactly as it was.
 */
export function pointerHoverRow(
  surface: PointerSurface,
  cell: { readonly column: number; readonly row: number },
): string | undefined {
  const id = pointerRowAt(surface, cell);
  if (id === undefined) return undefined;
  const clicked = pointerTransition({ action: "press", ...cell }, surface);
  return clicked?.selection === id ? id : undefined;
}
