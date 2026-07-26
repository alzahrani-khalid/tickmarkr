export const COCKPIT_ROW_FLOOR = 14;
export const COCKPIT_COLUMN_FLOOR = 40;
export const FULL_JOURNAL_ROWS = 3;

const FRAME_CHROME_ROWS = 8;

/**
 * Ordered from highest priority (last surrendered) to lowest (first
 * surrendered). A minimum row preserves an element in the compact frame; its
 * preferred rows restore the full presentation before the next step receives
 * any rows. The stats minimum is its one-line summary, not the full tiles.
 */
const ORDERED_POLICY = [
  { element: "keybar", minimumRows: 1, preferredRows: 1 },
  { element: "statusStrip", minimumRows: 1, preferredRows: 1 },
  { element: "primaryHeader", minimumRows: 1, preferredRows: 1 },
  { element: "progressBar", minimumRows: 1, preferredRows: 1 },
  { element: "journal", minimumRows: 1, preferredRows: FULL_JOURNAL_ROWS },
  { element: "progressCaption", minimumRows: 0, preferredRows: 1 },
  { element: "statTiles", minimumRows: 1, preferredRows: 2 },
  { element: "secondaryHeader", minimumRows: 0, preferredRows: 1 },
] as const;

type PolicyElement = (typeof ORDERED_POLICY)[number]["element"];
type RowAllocation = Record<PolicyElement, number>;

export const LAYOUT_PRIORITY: readonly PolicyElement[] = ORDERED_POLICY.map(
  ({ element }) => element,
);

export const FULL_LAYOUT_ROWS =
  FRAME_CHROME_ROWS +
  ORDERED_POLICY.reduce((rows, step) => rows + step.preferredRows, 0);

export type CockpitArrangement = "stacked" | "folded-keys" | "three-column";

export interface FrameCockpitLayout {
  renderer: "frame";
  arrangement: CockpitArrangement;
  elements: {
    version: true;
    keybar: true;
    statusStrip: true;
    primaryHeader: true;
    progressBar: boolean;
    progressCaption: boolean;
    secondaryHeader: boolean;
  };
  stats: {
    mode: "tiles" | "summary";
    rows: number;
    figures: readonly ["tasks", "gates", "pass"];
  };
  journalRows: number;
  rowAllocation: {
    chrome: number;
  } & RowAllocation;
}

export interface PlainCockpitLayout {
  renderer: "plain";
  arrangement: "plain";
}

export type CockpitLayout = FrameCockpitLayout | PlainCockpitLayout;

function arrangementFor(columns: number): CockpitArrangement {
  if (columns >= 120) return "three-column";
  if (columns >= 90) return "folded-keys";
  return "stacked";
}

function allocateRows(rows: number): RowAllocation {
  const allocation = Object.fromEntries(
    ORDERED_POLICY.map(({ element }) => [element, 0]),
  ) as RowAllocation;
  let available = rows - FRAME_CHROME_ROWS;

  // Preserve each element's compact form. At the contracted floor these
  // minima consume the budget exactly.
  for (const step of ORDERED_POLICY) {
    const granted = Math.min(step.minimumRows, available);
    allocation[step.element] = granted;
    available -= granted;
  }

  // Restore full forms in priority order, never funding a lower-priority
  // element while a higher-priority element remains compact.
  for (const step of ORDERED_POLICY) {
    const wanted = step.preferredRows - allocation[step.element];
    const granted = Math.min(wanted, available);
    allocation[step.element] += granted;
    available -= granted;
  }

  // Once every element is full, journal history is the sole useful sink.
  allocation.journal += available;
  return allocation;
}

export function resolveCockpitLayout(columns: number, rows: number): CockpitLayout {
  if (
    !Number.isFinite(columns) ||
    !Number.isFinite(rows) ||
    columns < COCKPIT_COLUMN_FLOOR ||
    rows < COCKPIT_ROW_FLOOR
  ) {
    return { renderer: "plain", arrangement: "plain" };
  }

  const allocation = allocateRows(Math.floor(rows));
  return {
    renderer: "frame",
    arrangement: arrangementFor(Math.floor(columns)),
    elements: {
      version: true,
      keybar: true,
      statusStrip: true,
      primaryHeader: true,
      progressBar: allocation.progressBar > 0,
      progressCaption: allocation.progressCaption > 0,
      secondaryHeader: allocation.secondaryHeader > 0,
    },
    stats: {
      mode: allocation.statTiles > 1 ? "tiles" : "summary",
      rows: allocation.statTiles,
      figures: ["tasks", "gates", "pass"],
    },
    journalRows: allocation.journal,
    rowAllocation: {
      chrome: FRAME_CHROME_ROWS,
      ...allocation,
    },
  };
}
