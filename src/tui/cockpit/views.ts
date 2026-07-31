/** The run cockpit's rail order. Number keys are one-based positions here. */
export const RUN_VIEWS = [
  { id: "run", label: "Run", title: "RUN", detailTitle: "RUN DETAIL" },
  { id: "tasks", label: "Tasks", title: "TASKS", detailTitle: "TASK DETAIL" },
  { id: "gates", label: "Gates", title: "GATES", detailTitle: "GATE DETAIL" },
  { id: "journal", label: "Journal", title: "JOURNAL", detailTitle: "EVENT DETAIL" },
  { id: "fleet", label: "Fleet", title: "FLEET", detailTitle: "CHANNEL DETAIL" },
] as const;

export type RunView = (typeof RUN_VIEWS)[number];
export type RunViewId = RunView["id"];

export function runViewAt(index: number): RunView | undefined {
  return Number.isInteger(index) ? RUN_VIEWS[index] : undefined;
}

export function runViewById(id: RunViewId): RunView {
  return RUN_VIEWS.find((view) => view.id === id) ?? RUN_VIEWS[0];
}

/** Rail movement stops at either end; it never points outside the five views. */
export function moveRunViewSelection(selection: number, delta: number): number {
  return Math.max(0, Math.min(RUN_VIEWS.length - 1, selection + delta));
}

/** A one-based number key's view, or undefined for a digit the rail does not own. */
export function runViewForNumber(input: string): RunView | undefined {
  if (!/^\d$/u.test(input)) return undefined;
  return runViewAt(Number(input) - 1);
}

/**
 * The second tab's drawn name. It was SETUP through v1.83; the operator's UAT
 * read that as configuration, and what the tab draws is journal-parked human
 * decisions whose only writes are approve and uphold. Stated once here so the
 * tab strip, the keybar hint and the surface's own header cannot drift apart.
 */
export const DECISIONS_TAB_TITLE = "DECISIONS";
/** The same name in the keybar's sentence case — the word drawn beside Tab. */
export const DECISIONS_TAB_HINT = "Decisions";

/**
 * The decisions tab's rail. Every label fits the rail's own column unwrapped —
 * a wrapped rail row is a row nothing charges to the height budget, and that is
 * what pushed the surface past a 14-row terminal. Read-only sections say so in
 * their body, not in a label long enough to wrap.
 */
export const SETUP_SECTIONS = [
  { id: "decisions", label: "Decisions", title: "DECISIONS", readOnly: false },
  { id: "fleet", label: "Fleet", title: "FLEET", readOnly: true },
  { id: "config", label: "Config", title: "CONFIG", readOnly: true },
] as const;

export type SetupSection = (typeof SETUP_SECTIONS)[number];
export type SetupSectionId = SetupSection["id"];

/** The section a rail position names; out-of-range positions clamp to the rail. */
export function setupSectionAt(index: number): SetupSection {
  const clamped = Math.max(0, Math.min(SETUP_SECTIONS.length - 1, Math.floor(index)));
  return SETUP_SECTIONS[clamped]!;
}

/** Rail movement stops at either end; it never points outside the sections. */
export function moveSetupSectionSelection(selection: number, delta: number): number {
  return Math.max(0, Math.min(SETUP_SECTIONS.length - 1, selection + delta));
}

// Sections carry no number key: 1–5 names a view on the whole surface, and a
// digit that meant a section here would be the same key with two meanings.
// The sections are reached the way the contract gives them — ↑↓ and ⏎.
