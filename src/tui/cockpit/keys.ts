import { GLYPHS } from "../../brand.js";

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
export type RunInteractionState = {
  /** The journal row the pointer marks — moved by ↑↓, -1 while nothing is selected. */
  readonly selection: number;
  /** The focused panel, index into RUN_PANEL_FOCUS_ORDER — cycled by Tab. */
  readonly panel: number;
  /** The selection opened by ⏎, or null once ← returns from it. */
  readonly opened: number | null;
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
    selection: -1,
    panel: 0,
    opened: null,
    follow: false,
    filterPrompt: false,
    filterQuery: "",
    help: false,
    quit: false,
  };
}

/**
 * The panels Tab cycles focus through, in cycle order; index 0 is the focus
 * the surface opens with, so the initial frame is the one the anchors pin.
 */
export const RUN_PANEL_FOCUS_ORDER = ["RUN", "VIEWS", "KEYS"] as const;

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
  ) => RunInteractionState;
  /**
   * How a binding that carries on/off state reports it — the brand's reserved
   * toggle glyphs, never bracket toggles. Present exactly on the bindings
   * whose state is on/off.
   */
  readonly report?: (state: RunInteractionState) => string;
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
    apply: (state, { key }) => ({
      ...state,
      selection: Math.max(
        -1,
        state.selection + (key.upArrow === true ? -1 : 1),
      ),
    }),
  },
  {
    key: "⏎",
    label: "Open",
    matches: ({ key }) => key.return === true,
    apply: (state) =>
      state.selection >= 0 ? { ...state, opened: state.selection } : state,
  },
  {
    key: "←",
    label: "Back",
    matches: ({ key }) => key.leftArrow === true,
    apply: (state) => ({ ...state, opened: null }),
  },
  {
    key: "Tab",
    label: "Panel",
    matches: ({ key }) => key.tab === true,
    apply: (state) => ({
      ...state,
      panel: (state.panel + 1) % RUN_PANEL_FOCUS_ORDER.length,
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
    key: "f",
    label: "Follow",
    matches: ({ input }) => input === "f",
    apply: (state) => ({ ...state, follow: !state.follow }),
    report: (state) => toggleReport("Follow", state.follow),
  },
  {
    key: "/",
    label: "Filter",
    matches: ({ input }) => input === "/",
    apply: (state) => ({ ...state, filterPrompt: true, filterQuery: "" }),
  },
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

/**
 * The transitions of the open / prompt. The prompt is not an advertised key,
 * so it has no binding — but its transitions live here beside the registry
 * because they rewrite the same interaction state: characters grow the query,
 * backspace shrinks it, ⏎ applies it (the journal stays narrowed), escape
 * cancels it. Anything else the prompt swallows unchanged.
 */
export function applyFilterInput(
  event: RunKeyEvent,
  state: RunInteractionState,
): RunInteractionState | undefined {
  if (!state.filterPrompt) return undefined;
  const { input, key } = event;
  if (key.return === true) return { ...state, filterPrompt: false };
  if (key.escape === true) {
    return { ...state, filterPrompt: false, filterQuery: "" };
  }
  if (key.backspace === true || key.delete === true) {
    return { ...state, filterQuery: [...state.filterQuery].slice(0, -1).join("") };
  }
  if (input.length === 1 && key.ctrl !== true) {
    return { ...state, filterQuery: state.filterQuery + input };
  }
  return state;
}

/** What an advertisement looks like once the handler is stripped away. */
export type KeybarEntry = {
  readonly key: string;
  readonly label: string;
};

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
 * Send a key event to the registry: the matching binding's handler produces
 * the next interaction state. An event no handler owns changes nothing.
 */
export function dispatchRunKey(
  event: RunKeyEvent,
  state: RunInteractionState,
  bindings: readonly RunKeyBinding[] = RUN_KEY_BINDINGS,
): RunInteractionState | undefined {
  const binding = resolveRunKeyBinding(bindings, event);
  return binding?.apply(state, event);
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
