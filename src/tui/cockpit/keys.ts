import { GLYPHS } from "../../brand.js";
import {
  moveRunViewSelection,
  moveSetupSectionSelection,
  runViewAt,
  runViewForNumber,
  type RunViewId,
} from "./views.js";

/**
 * THE key contract for the run cockpit. This registry is the single source of
 * truth for both halves of a key: what the keybar advertises and what the key
 * does. The keybar's entries are derived from these bindings (`keybarEntries`),
 * so a key with no registered handler cannot be drawn — an advertised key that
 * does nothing is not expressible.
 */

/** The subset of an ink key event the run bindings discriminate on. */
export type RunKeyEvent = {
  readonly input: string;
  readonly key: {
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly leftArrow?: boolean;
    readonly rightArrow?: boolean;
    readonly return?: boolean;
    readonly tab?: boolean;
    readonly escape?: boolean;
    readonly backspace?: boolean;
    readonly delete?: boolean;
    readonly ctrl?: boolean;
  };
};

/**
 * The observable interaction state of the run surface. RunCockpitFrame renders
 * every field of it — selection pointer, panel focus, opened event, follow
 * indicator, filter prompt, help overlay — so the initial state below renders
 * byte-identical to a frame that carries no interaction state at all, and every
 * transition away from it is a change an operator can see.
 */
/** The two top-level tabs: watch reads the engagement, setup writes to it. */
export type RunTabId = "watch" | "setup";

export type RunInteractionState = {
  /** Which of the two tabs the surface draws — switched by Tab, never by a view. */
  readonly tab: RunTabId;
  /** The row in the active view the pointer marks; the overview has no rows. */
  readonly selection: string | null;
  /** The focused region, index into RUN_PANEL_FOCUS_ORDER — set by diving and backing out. */
  readonly panel: number;
  /** The selected rail row, independent from the view currently open. */
  readonly railSelection: number;
  /** The view drawn in the main region. */
  readonly activeView: RunViewId;
  /** The active view row opened by ⏎, or null while drawing the view itself. */
  readonly opened: string | null;
  /** Follow mode — toggled by f; drawn as a status-strip indicator while on. */
  readonly follow: boolean;
  /** The / prompt is open and taking filter text. */
  readonly filterPrompt: boolean;
  /** The text the journal is narrowed to — empty shows every row. */
  readonly filterQuery: string;
  /** Help overlay — toggled by ?. */
  readonly help: boolean;
  /** Quit requested by q. */
  readonly quit: boolean;
};

export function initialRunInteractionState(): RunInteractionState {
  return {
    tab: "watch",
    selection: null,
    panel: 0,
    railSelection: 0,
    activeView: "run",
    opened: null,
    follow: false,
    filterPrompt: false,
    filterQuery: "",
    help: false,
    quit: false,
  };
}

/**
 * The panels the run surface's focus moves between, in their painted order;
 * index 0 is the content panel, and the sidebar is the level every view backs
 * out to. A width that hides the sidebar resolves every index onto the panel
 * that remains (`runPanelFocusOrder`).
 */
export const RUN_PANEL_FOCUS_ORDER = ["CONTENT", "VIEWS"] as const;

/** The sidebar's position in the focus order — the level every view backs out to. */
const SIDEBAR_PANEL = RUN_PANEL_FOCUS_ORDER.indexOf("VIEWS");

/**
 * The state the live surface opens in: the watch tab, the sidebar focused, so
 * the very first arrow key moves the view selection rather than a row. This is
 * a second constructor rather than a change to the one above: the committed
 * captures depict a surface with no interaction state at all, and only an
 * operator-accepted capture may re-freeze them.
 */
export function openingRunInteractionState(tab: RunTabId = "watch"): RunInteractionState {
  return { ...initialRunInteractionState(), tab, panel: SIDEBAR_PANEL };
}

/**
 * The whole surface: the tab being drawn and the tab waiting behind it. Each
 * half keeps its own selection, so Tab and Tab again returns an operator to
 * exactly the row and view they left.
 */
export type RunSurfaceState = {
  readonly interaction: RunInteractionState;
  readonly stashed: RunInteractionState;
};

export function openingRunSurfaceState(): RunSurfaceState {
  return {
    interaction: openingRunInteractionState("watch"),
    stashed: openingRunInteractionState("setup"),
  };
}

/**
 * The rows of a view a key may actually stand on. The journal is a tail, not a
 * list: it is never selected, opened or filtered, in either tab. Stated once
 * here so the dispatcher and the advertisement cannot disagree about it.
 */
export function selectableRunViewRowIds(
  viewId: RunViewId,
  rowIds: readonly string[],
): readonly string[] {
  return viewId === "journal" ? [] : rowIds;
}

/** The one width predicate shared by rendering, focus and key projection. */
export const RUN_SIDE_RAIL_COLUMN_FLOOR = 80;

/**
 * The width a dispatch assumes when the caller names none: wide enough that
 * every width-gated key is offered. Callers that know the terminal — the live
 * surface — pass the real width, and a narrow one withholds what it hides.
 */
const UNMEASURED_COLUMNS = Number.MAX_SAFE_INTEGER;

export function runSideRailVisible(columns: number): boolean {
  return Number.isFinite(columns) && Math.floor(columns) >= RUN_SIDE_RAIL_COLUMN_FLOOR;
}

export function runPanelFocusOrder(
  columns: number,
): readonly (typeof RUN_PANEL_FOCUS_ORDER)[number][] {
  return runSideRailVisible(columns) ? RUN_PANEL_FOCUS_ORDER : ["CONTENT"];
}

export type RunKeyProjectionContext = {
  readonly interaction: RunInteractionState;
  readonly columns: number;
  /** Stable identities in the active view's filtered logical collection. */
  readonly rowIds?: readonly string[];
};

export type RunKeyApplyContext = {
  readonly rowIds: readonly string[];
  /**
   * The terminal width the dispatch was made at, so a handler resolves focus
   * against the same effective width the advertisement did. Handlers invoked
   * without a dispatch — tests driving a binding directly — assume the width
   * that offers every key.
   */
  readonly columns?: number;
};

export function runFocusedPanel({
  interaction,
  columns,
}: RunKeyProjectionContext): (typeof RUN_PANEL_FOCUS_ORDER)[number] {
  const order = runPanelFocusOrder(columns);
  return order[interaction.panel % order.length] ?? "CONTENT";
}

/**
 * Where focus effectively rests at the width the surface is drawn: the sidebar
 * a width hides cannot hold focus, so a state pointing at it resolves to the
 * content panel — the same resolution the renderer paints. One predicate, so
 * no handler can act on a panel the frame does not show as focused.
 */
function railFocused(
  state: RunInteractionState,
  columns: number = UNMEASURED_COLUMNS,
): boolean {
  return runFocusedPanel({ interaction: state, columns }) === "VIEWS";
}

function openView(state: RunInteractionState, index: number): RunInteractionState {
  const view = runViewAt(index);
  if (view === undefined) return state;
  return {
    ...state,
    activeView: view.id,
    railSelection: index,
    panel: 0,
    selection: null,
    opened: null,
    filterPrompt: false,
    filterQuery: "",
  };
}

/** Diving into the setup tab's selected section: the rail keeps its position. */
function openSetupSection(state: RunInteractionState): RunInteractionState {
  return { ...state, panel: 0, opened: null, filterPrompt: false, filterQuery: "" };
}

/**
 * THE tab switch, written once and shared by every scope that owns Tab: the
 * drawn tab steps aside for the one waiting behind it. Stated here so the
 * normal roster and the filter prompt's roster cannot disagree about what Tab
 * does — a prompt that swallowed Tab would strand an operator on one tab.
 */
function switchTab(state: RunInteractionState): RunInteractionState {
  return { ...state, tab: state.tab === "watch" ? "setup" : "watch" };
}

/**
 * The word the run keybar draws beside Tab for the second tab: its real name.
 * The tab is named DECISIONS wherever it is drawn AS A TAB — the header strip,
 * its own panel title, and its own tab line (views.ts owns those constants) —
 * and the advertisement of the key that draws it names the same destination.
 * The dormant configuration wizard's own header strings ("SETUP",
 * "setup · step N/6") are not advertisements of a destination and are none of
 * this constant's business.
 */
const TAB_DESTINATION_DECISIONS = "Decisions";

/**
 * The word the keybar draws beside Tab: the tab the key will draw — the
 * second tab's advertised word while watch is drawn, "Watch" while it is.
 * Resolved against the live state at projection time, so the advertisement is
 * the action rather than a word frozen beside it. One function, so the normal
 * roster and the filter prompt's roster cannot disagree about what Tab promises.
 */
const tabDestination = (state: RunInteractionState): string =>
  state.tab === "watch" ? TAB_DESTINATION_DECISIONS : "Watch";

export type RunKeyBinding = {
  /** The glyph the keybar draws, e.g. "↑↓". */
  readonly key: string;
  /** The promise the keybar draws next to the glyph, e.g. "Move". */
  readonly label: string;
  /** Whether a key event activates this binding. */
  readonly matches: (event: RunKeyEvent) => boolean;
  /** The state transition the label promises. */
  readonly apply: (
    state: RunInteractionState,
    event: RunKeyEvent,
    context?: RunKeyApplyContext,
  ) => RunInteractionState;
  /** Which projected contexts can actually observe this binding's transition. */
  readonly available?: (context: RunKeyProjectionContext) => boolean;
  /** Prompt bindings replace, rather than supplement, the normal roster. */
  readonly scope?: "normal" | "filter-prompt";
  /**
   * How a binding that carries on/off state reports it — the brand's reserved
   * toggle glyphs, never bracket toggles. Present exactly on the bindings
   * whose state is on/off.
   */
  readonly report?: (state: RunInteractionState) => string;
  /**
   * The word naming where a switch key takes the operator from the current
   * state — Tab promises the tab it will draw. Present exactly on bindings
   * whose honest label depends on which side of the switch the surface is on.
   */
  readonly destination?: (state: RunInteractionState) => string;
};

/** A toggle's on/off report: the brand's reserved glyphs, never brackets. */
export function toggleReport(label: string, on: boolean): string {
  return `${label} ${on ? GLYPHS.toggleActive : GLYPHS.toggleInactive}`;
}

/**
 * Every key the run surface advertises, in keybar order. Each entry carries
 * its handler, so advertisement and behaviour cannot drift apart.
 */
export const RUN_KEY_BINDINGS: readonly RunKeyBinding[] = [
  {
    key: "↑↓",
    label: "Move",
    matches: ({ key }) => key.upArrow === true || key.downArrow === true,
    apply: (state, { key }, context) => {
      const delta = key.upArrow === true ? -1 : 1;
      const columns = context?.columns ?? UNMEASURED_COLUMNS;
      if (railFocused(state, columns)) {
        if (state.tab === "setup") {
          return {
            ...state,
            railSelection: moveSetupSectionSelection(state.railSelection, delta),
          };
        }
        return {
          ...state,
          railSelection: moveRunViewSelection(state.railSelection, delta),
        };
      }
      if (state.tab === "setup") return state;
      // A width that hides the rail leaves the overview no pointer to move, so
      // there the arrow moves the view selection itself and the body follows:
      // the first arrow at the floor acts exactly as it does on the rail.
      if (!runSideRailVisible(columns) && state.activeView === "run") {
        const index = moveRunViewSelection(state.railSelection, delta);
        const view = runViewAt(index);
        if (view === undefined || index === state.railSelection) return state;
        return {
          ...state,
          railSelection: index,
          activeView: view.id,
          selection: null,
          opened: null,
          filterPrompt: false,
          filterQuery: "",
        };
      }
      if (state.activeView === "run") return state;
      const rowIds = context?.rowIds ?? [];
      if (rowIds.length === 0) return state;
      const current = state.selection === null
        ? -1
        : rowIds.indexOf(state.selection);
      if (delta < 0) {
        if (current < 0) return state;
        return current === 0
          ? { ...state, selection: null }
          : { ...state, selection: rowIds[current - 1]! };
      }
      const next = Math.min(rowIds.length - 1, current + 1);
      if (next === current) return state;
      return { ...state, selection: rowIds[next]! };
    },
    available: ({ interaction, columns, rowIds }) =>
      railFocused(interaction, columns)
      || (interaction.tab === "watch"
        && interaction.opened === null
        && !interaction.help
        && ((!runSideRailVisible(columns) && interaction.activeView === "run")
          || (interaction.activeView !== "run" && (rowIds?.length ?? 0) > 0))),
  },
  {
    key: "⏎",
    label: "Open",
    matches: ({ key }) => key.return === true || key.rightArrow === true,
    apply: (state, _event, context) => {
      const columns = context?.columns ?? UNMEASURED_COLUMNS;
      if (railFocused(state, columns) && state.tab === "setup") return openSetupSection(state);
      if (railFocused(state, columns)) return openView(state, state.railSelection);
      if (
        state.tab === "setup"
        || state.activeView === "run"
        || state.selection === null
        || !(context?.rowIds.includes(state.selection) ?? false)
      ) return state;
      return { ...state, opened: state.selection };
    },
    available: ({ interaction, columns, rowIds }) =>
      railFocused(interaction, columns)
      || (interaction.tab === "watch"
        && interaction.activeView !== "run"
        && interaction.opened === null
        && interaction.selection !== null
        && (rowIds?.includes(interaction.selection) ?? false)
        && !interaction.help),
  },
  {
    key: "←",
    label: "Back",
    matches: ({ key }) => key.leftArrow === true || key.escape === true,
    apply: (state, _event, context) => {
      const columns = context?.columns ?? UNMEASURED_COLUMNS;
      if (state.opened !== null) return { ...state, opened: null };
      if (railFocused(state, columns)) return state;
      if (state.tab === "watch" && state.activeView === "run") return state;
      // A width that hides the rail gives back no sidebar to hand focus to, so
      // there back steps out of the view itself and returns to the overview.
      if (state.tab === "watch" && !runSideRailVisible(columns)) {
        return { ...state, activeView: "run", railSelection: 0, selection: null };
      }
      return { ...state, panel: SIDEBAR_PANEL };
    },
    available: ({ interaction, columns }) =>
      interaction.opened !== null
      || (!railFocused(interaction, columns)
        && ((interaction.tab === "setup" && runSideRailVisible(columns))
          || (interaction.tab === "watch" && interaction.activeView !== "run"))),
  },
  {
    key: "Tab",
    label: TAB_DESTINATION_DECISIONS,
    destination: tabDestination,
    matches: ({ key }) => key.tab === true,
    apply: switchTab,
    // Tab is a top-level surface action, not a sidebar action: it is offered
    // and dispatchable at every supported width, including the widths that
    // hide the sidebar. One predicate governs the advertisement and the
    // switch together, and that predicate is the surface's, not the rail's.
    available: () => true,
  },
  {
    key: "?",
    label: "Help",
    matches: ({ input }) => input === "?",
    apply: (state) => ({ ...state, help: !state.help }),
    available: () => true,
  },
  {
    key: "q",
    label: "Quit",
    matches: ({ input }) => input === "q",
    apply: (state) => ({ ...state, quit: true }),
    available: ({ interaction }) => !interaction.quit,
  },
  {
    key: "f",
    label: "Follow",
    matches: ({ input }) => input === "f",
    apply: (state) =>
      state.tab === "watch"
          && (state.activeView === "run" || state.activeView === "journal")
        ? { ...state, follow: !state.follow }
        : state,
    report: (state) => toggleReport("Follow", state.follow),
    available: ({ interaction }) =>
      interaction.tab === "watch"
      && (interaction.activeView === "run" || interaction.activeView === "journal"),
  },
  {
    key: "/",
    label: "Filter",
    matches: ({ input }) => input === "/",
    apply: (state, _event, context) =>
      state.tab === "setup"
          || state.activeView === "run"
          || state.activeView === "journal"
          || railFocused(state, context?.columns ?? UNMEASURED_COLUMNS)
          || state.opened !== null
          || state.help
        ? state
        : { ...state, filterPrompt: true, filterQuery: "" },
    available: ({ interaction, columns }) =>
      !railFocused(interaction, columns)
      && interaction.tab === "watch"
      && interaction.activeView !== "run"
      // The journal is a tail, never a list: nothing filters it.
      && interaction.activeView !== "journal"
      && interaction.opened === null
      && !interaction.help,
  },
];

const RUN_VIEWS_INDEX: Readonly<Record<RunViewId, number>> = {
  run: 0,
  tasks: 1,
  gates: 2,
  journal: 3,
  fleet: 4,
};

/**
 * Number jumps name a view, and a digit means that one view on the whole
 * surface — one key, one meaning, everywhere. Pressed on the setup tab, which
 * holds sections rather than views, a digit switches to the tab that holds
 * the views and lands on the one it numbers; setup waits behind with its own
 * state intact for the round trip.
 */
export const RUN_VIEW_KEY_BINDING: RunKeyBinding = {
  key: "1–5",
  label: "Move",
  matches: ({ input }) => /^\d$/u.test(input),
  apply: (state, { input }) => {
    const view = runViewForNumber(input);
    if (view === undefined) return state;
    const jumped = openView(state, RUN_VIEWS_INDEX[view.id]);
    return state.tab === "setup" ? { ...jumped, tab: "watch" } : jumped;
  },
  available: () => true,
};

/** The filter prompt's own advertised and executable input roster. */
export const RUN_FILTER_PROMPT_BINDINGS: readonly RunKeyBinding[] = [
  {
    key: "text",
    label: "Edit",
    scope: "filter-prompt",
    matches: ({ input, key }) =>
      input.length === 1
      && key.ctrl !== true
      && key.return !== true
      && key.escape !== true
      && key.backspace !== true
      && key.delete !== true,
    apply: (state, { input }) => ({
      ...state,
      filterQuery: state.filterQuery + input,
    }),
    available: () => true,
  },
  {
    key: "⌫",
    label: "Delete",
    scope: "filter-prompt",
    matches: ({ key }) => key.backspace === true || key.delete === true,
    apply: (state) => ({
      ...state,
      filterQuery: [...state.filterQuery].slice(0, -1).join(""),
    }),
    available: ({ interaction }) => interaction.filterQuery.length > 0,
  },
  {
    key: "⏎",
    label: "Apply",
    scope: "filter-prompt",
    matches: ({ key }) => key.return === true,
    apply: (state) => ({ ...state, filterPrompt: false }),
    available: () => true,
  },
  {
    key: "Esc",
    label: "Cancel",
    scope: "filter-prompt",
    matches: ({ key }) => key.escape === true,
    apply: (state) => ({ ...state, filterPrompt: false, filterQuery: "" }),
    available: () => true,
  },
  {
    // Tab belongs to the surface, not to the view under it: an open prompt
    // narrows one view's rows and never takes the key that leaves the tab.
    // The prompt keeps its query while the other tab is drawn, so tabbing
    // back returns to the prompt exactly as it was left.
    key: "Tab",
    label: TAB_DESTINATION_DECISIONS,
    destination: tabDestination,
    scope: "filter-prompt",
    matches: ({ key }) => key.tab === true,
    apply: switchTab,
    available: () => true,
  },
];

/** Every input binding the live run cockpit dispatches or the prompt owns. */
export const RUN_INPUT_BINDINGS: readonly RunKeyBinding[] = [
  ...RUN_KEY_BINDINGS,
  RUN_VIEW_KEY_BINDING,
  ...RUN_FILTER_PROMPT_BINDINGS,
];

/** The panels the setup surface cycles through, in their painted order. */
export const SETUP_PANEL_FOCUS_ORDER = ["SETUP", "HARNESSES", "KEYS"] as const;

/**
 * The observable state owned by setup's bindings. Its initial value is the
 * already-pinned setup frame: step two, the harness body focused, nothing
 * selected, no modal action open. Every handler moves away from that state in
 * a way SetupCockpitFrame paints.
 */
export type SetupInteractionState = {
  readonly selection: number;
  readonly panel: number;
  readonly step: number;
  readonly selected: readonly number[];
  readonly all: boolean;
  readonly probeRevision: number;
  readonly savePrompt: boolean;
  readonly saved: boolean;
  readonly help: boolean;
  readonly quit: boolean;
};

export function initialSetupInteractionState(): SetupInteractionState {
  return {
    selection: -1,
    panel: 1,
    step: 2,
    selected: [],
    all: false,
    probeRevision: 0,
    savePrompt: false,
    saved: false,
    help: false,
    quit: false,
  };
}

export type SetupKeyBinding = {
  readonly key: string;
  readonly label: string;
  readonly matches: (event: RunKeyEvent) => boolean;
  readonly apply: (
    state: SetupInteractionState,
    event: RunKeyEvent,
  ) => SetupInteractionState;
  readonly report?: (state: SetupInteractionState) => string;
};

function setupStep(state: SetupInteractionState, delta: number): SetupInteractionState {
  return { ...state, step: Math.min(6, Math.max(1, state.step + delta)) };
}

/**
 * Every setup advertisement and handler, in the exact order the surface has
 * always drawn. The global six are registered here with setup semantics; the
 * six setup-only bindings follow them on the same surface registry.
 */
export const SETUP_KEY_BINDINGS: readonly SetupKeyBinding[] = [
  {
    key: "↑↓",
    label: "Move",
    matches: ({ key }) => key.upArrow === true || key.downArrow === true,
    apply: (state, { key }) => ({
      ...state,
      selection: key.upArrow === true
        ? Math.max(0, state.selection - 1)
        : state.selection + 1,
    }),
  },
  {
    key: "⏎",
    label: "Next",
    matches: ({ key }) => key.return === true,
    apply: (state) => setupStep(state, 1),
  },
  {
    key: "←",
    label: "Back",
    matches: ({ key }) => key.leftArrow === true,
    apply: (state) => setupStep(state, -1),
  },
  {
    key: "Tab",
    label: "Panel",
    matches: ({ key }) => key.tab === true,
    apply: (state) => ({
      ...state,
      panel: (state.panel + 1) % SETUP_PANEL_FOCUS_ORDER.length,
    }),
  },
  {
    key: "?",
    label: "Help",
    matches: ({ input }) => input === "?",
    apply: (state) => ({ ...state, help: !state.help }),
  },
  {
    key: "q",
    label: "Quit",
    matches: ({ input }) => input === "q",
    apply: (state) => ({ ...state, quit: true }),
  },
  {
    key: "␣",
    label: "Toggle",
    matches: ({ input }) => input === " ",
    apply: (state) => {
      const selection = Math.max(0, state.selection);
      const selected = state.selected.includes(selection)
        ? state.selected.filter((index) => index !== selection)
        : [...state.selected, selection];
      return { ...state, selection, selected, all: false };
    },
    report: (state) =>
      toggleReport("Selection", state.all || state.selected.length > 0),
  },
  {
    key: "a",
    label: "All",
    matches: ({ input }) => input === "a",
    apply: (state) => ({ ...state, all: true, selected: [] }),
  },
  {
    key: "r",
    label: "Re-probe",
    matches: ({ input }) => input === "r",
    apply: (state) => ({ ...state, probeRevision: state.probeRevision + 1 }),
  },
  {
    key: "s",
    label: "Save",
    matches: ({ input }) => input === "s",
    apply: (state) => ({ ...state, savePrompt: true }),
    report: (state) => toggleReport("Saved", state.saved),
  },
  {
    key: "n",
    label: "Next",
    matches: ({ input }) => input === "n",
    apply: (state) => setupStep(state, 1),
  },
  {
    key: "p",
    label: "Prev",
    matches: ({ input }) => input === "p",
    apply: (state) => setupStep(state, -1),
  },
];

/** One surface-aware registry serves both cockpit renderers and dispatchers. */
export const SURFACE_KEY_BINDINGS = {
  run: RUN_KEY_BINDINGS,
  setup: SETUP_KEY_BINDINGS,
} as const;

/** Save confirmation owns input until it is accepted or dismissed. */
export function applySetupPromptInput(
  event: RunKeyEvent,
  state: SetupInteractionState,
): SetupInteractionState | undefined {
  if (!state.savePrompt) return undefined;
  if (event.input === "y" || event.key.return === true) {
    return { ...state, savePrompt: false, saved: true };
  }
  if (event.input === "n" || event.key.escape === true) {
    return { ...state, savePrompt: false };
  }
  return state;
}

/** What an advertisement looks like once the handler is stripped away. */
export type KeybarEntry = {
  readonly key: string;
  readonly label: string;
};

export type RunKeyProjection = (
  context: RunKeyProjectionContext,
) => readonly KeybarEntry[];

/** The lossless text vocabulary shared by frame and plain advertisements. */
export function formatKeybarEntries(entries: readonly KeybarEntry[]): string {
  return entries.map(({ key, label }) => `${key} ${label}`).join(" · ");
}

/**
 * THE one context projection over the one run registry. Consumers receive its
 * return value whole; none may filter, append or independently map bindings.
 */
export function projectRunKeyEntries(
  context: RunKeyProjectionContext,
  bindings: readonly RunKeyBinding[] = RUN_INPUT_BINDINGS,
): readonly KeybarEntry[] {
  const scope = context.interaction.filterPrompt ? "filter-prompt" : "normal";
  return bindings
    .filter((binding) => (binding.scope ?? "normal") === scope)
    .filter((binding) => binding.available?.(context) ?? true)
    .map((binding) => ({
      key: binding.key,
      label: binding.report?.(context.interaction)
        ?? binding.destination?.(context.interaction)
        ?? binding.label,
    }));
}

/**
 * The keybar's entries, derived from a binding registry. This is the only way
 * a keybar list is produced: remove a handler and its entry disappears.
 */
export function keybarEntries(
  bindings: readonly { readonly key: string; readonly label: string }[],
): readonly KeybarEntry[] {
  return bindings.map(({ key, label }) => ({ key, label }));
}

/** The binding a key event activates, or undefined when no handler owns it. */
export function resolveRunKeyBinding(
  bindings: readonly RunKeyBinding[],
  event: RunKeyEvent,
): RunKeyBinding | undefined {
  return bindings.find((binding) => binding.matches(event));
}

/**
 * Re-establish the row invariant after a derivation or filter changes. The
 * identities themselves are authoritative: an in-range position is never a
 * substitute for the row that used to occupy it.
 */
export function reconcileRunInteraction(
  state: RunInteractionState,
  rowIds: readonly string[],
): RunInteractionState {
  const available = new Set(rowIds);
  const selection = state.selection !== null && available.has(state.selection)
    ? state.selection
    : null;
  const opened = state.opened !== null && available.has(state.opened)
    ? state.opened
    : null;
  return selection === state.selection && opened === state.opened
    ? state
    : { ...state, selection, opened };
}

/**
 * Send a key event to the registry: the matching binding's handler produces
 * the next interaction state. An event no handler owns changes nothing — and
 * while the / prompt is open the prompt's own scope is the only roster that
 * owns anything, so a character grows the query rather than quitting the
 * surface. One dispatcher decides that, so no caller can own the prompt twice.
 */
export function dispatchRunKey(
  event: RunKeyEvent,
  state: RunInteractionState,
  bindings: readonly RunKeyBinding[] = RUN_INPUT_BINDINGS,
  rowIds: readonly string[] = [],
  columns: number = UNMEASURED_COLUMNS,
): RunInteractionState | undefined {
  const scope = state.filterPrompt ? "filter-prompt" : "normal";
  const context: RunKeyProjectionContext = { interaction: state, columns, rowIds };
  const binding = resolveRunKeyBinding(
    bindings.filter((candidate) =>
      (candidate.scope ?? "normal") === scope
      // A key acts exactly where it is advertised. One predicate decides both,
      // so a keybar that hides a key cannot leave its handler live behind it.
      && (candidate.available?.(context) ?? true)
    ),
    event,
  );
  const next = binding?.apply(state, event, { rowIds, columns });
  return next === undefined ? undefined : reconcileRunInteraction(next, rowIds);
}

/**
 * Send a key event to the whole surface. The registry owns every transition,
 * including the tab flip; the surface only decides what a flipped tab means —
 * the tab that was waiting comes forward carrying the state it was left in, and
 * the tab that was drawn is what waits now.
 */
export function dispatchRunSurfaceKey(
  event: RunKeyEvent,
  surface: RunSurfaceState,
  bindings: readonly RunKeyBinding[] = RUN_INPUT_BINDINGS,
  rowIds: readonly string[] = [],
  columns: number = UNMEASURED_COLUMNS,
): RunSurfaceState | undefined {
  const next = dispatchRunKey(event, surface.interaction, bindings, rowIds, columns);
  if (next === undefined) return undefined;
  if (next.tab !== surface.interaction.tab) {
    const flipOnly = (Object.keys(next) as readonly (keyof RunInteractionState)[])
      .every((field) => field === "tab" || next[field] === surface.interaction[field]);
    if (flipOnly) {
      // A pure switch: the tab that was drawn waits behind with everything it
      // had, and the tab that was waiting comes forward exactly as it was left.
      return {
        interaction: { ...surface.stashed, tab: next.tab },
        stashed: surface.interaction,
      };
    }
    // The key changed more than the tab — a digit pressed on the sections tab
    // means its view on the tab it switches to. The event is replayed against
    // the tab that was waiting, so the change lands on that tab's own state
    // rather than on a coincidence of the tab it was pressed on.
    const replayed = dispatchRunKey(
      event,
      { ...surface.stashed, tab: next.tab },
      bindings,
      rowIds,
      columns,
    );
    if (replayed === undefined) return undefined;
    return { interaction: replayed, stashed: surface.interaction };
  }
  return next === surface.interaction ? surface : { ...surface, interaction: next };
}

/** The setup binding a key event activates, or undefined when none owns it. */
export function resolveSetupKeyBinding(
  bindings: readonly SetupKeyBinding[],
  event: RunKeyEvent,
): SetupKeyBinding | undefined {
  return bindings.find((binding) => binding.matches(event));
}

/** Send a key event through the setup half of the shared surface registry. */
export function dispatchSetupKey(
  event: RunKeyEvent,
  state: SetupInteractionState,
  bindings: readonly SetupKeyBinding[] = SETUP_KEY_BINDINGS,
): SetupInteractionState | undefined {
  return resolveSetupKeyBinding(bindings, event)?.apply(state, event);
}
