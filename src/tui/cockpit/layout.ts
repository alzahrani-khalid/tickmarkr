import { cellWidth } from "./width.js";

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

/* ------------------------------------------------------------------ */
/* planFrame — the pure frame plan (v1.83 watch/setup contract, S1).   */
/* One plan owns every row and column of the frame at every terminal   */
/* size in the contract domain. It is computed from a measured size    */
/* only: no rendering, no I/O, no read of the live terminal. Exactly   */
/* one element per axis absorbs surplus — the body row band on the     */
/* row axis, the body column on the column axis.                       */
/* ------------------------------------------------------------------ */

export interface MeasuredSize {
  columns: number;
  rows: number;
}

/** The five sidebar views, in jump-key order (1–5). */
export const FRAME_VIEWS = ["run", "tasks", "gates", "journal", "fleet"] as const;
export type FrameView = (typeof FRAME_VIEWS)[number];
export type FrameTab = "watch" | "setup";

export interface FrameState {
  /** Active top-level tab; SETUP turns the journal tail into PENDING WRITES. */
  tab?: FrameTab;
  /** A row's full detail is open in the body (sidebar and tail stay). */
  detail?: boolean;
  /** Header caption, pre-measured in terminal cells by the caller. */
  captionCells?: number;
}

export const FRAME_WIDTH_FLOOR = COCKPIT_COLUMN_FLOOR;
export const FRAME_HEIGHT_FLOOR = COCKPIT_ROW_FLOOR;
export const SIDEBAR_COLUMN_FLOOR = 64;
export const RAIL_COLUMNS = 15;
export const STANDARD_TAIL_HEIGHT = 16;
export const FULL_TAIL_HEIGHT = 24;
export const TAIL_STANDARD_ROWS = 1;
export const TAIL_FULL_ROWS = FULL_JOURNAL_ROWS;

/**
 * The header's fixed parts beside the caption — brand and version, then the
 * two tab labels — joined by the contracted gap. Composed from named parts so
 * a header change moves the caption fit check with it; the suite pins the
 * composed text so an unreviewed header change fails a test. Measured in
 * display cells by the cockpit's width authority, never String length.
 */
export const FRAME_HEADER_PARTS = [
  "tickmarkr 1.83.0",
  "[ WATCH ]",
  "SETUP",
] as const;
export const FRAME_HEADER_GAP = "   ";
export const HEADER_FIXED_CELLS = cellWidth(
  FRAME_HEADER_PARTS.join(FRAME_HEADER_GAP),
);

/** Every (columns, rows) pair the sweep holds the plan to. */
export const FRAME_CONTRACT_DOMAIN = {
  minColumns: 40,
  maxColumns: 220,
  minRows: 14,
  maxRows: 50,
} as const;

/** The fixed order in which the fit check surrenders regions, first to last. */
export const FRAME_SURRENDER_ORDER = ["caption", "tail"] as const;
export type SurrenderedRegionId = (typeof FRAME_SURRENDER_ORDER)[number];

export interface FrameFit {
  columns: number;
  tailRows: number;
  captionCells: number;
}

/**
 * The fit predicate for each surrenderable region. The fit check walks
 * FRAME_SURRENDER_ORDER and applies these predicates, so the constant is the
 * ordering decision — not a comment about one.
 */
export const FRAME_SURRENDER_FIT: Readonly<
  Record<SurrenderedRegionId, (fit: FrameFit) => boolean>
> = {
  caption: ({ captionCells, columns }) =>
    captionCells >= 1 && captionCells <= columns - HEADER_FIXED_CELLS,
  tail: ({ tailRows }) => tailRows > 0,
};

export type FrameRegionId =
  | "header"
  | "rule"
  | "strip"
  | "rail"
  | "body"
  | "rule2"
  | "tail"
  | "status"
  | "keybar"
  | "caption";

/* ------------------------------------------------------------------ */
/* The sidebar band's composition: the menu at the rail's top, the     */
/* vitals anchored to the rail's bottom, and at least one blank row    */
/* between them whenever both draw. The plan owns this geometry; the   */
/* band composition draws it unmodified.                               */
/* ------------------------------------------------------------------ */

/** The vitals elements in block order, top first; a short rail surrenders from the top, so the meter is the last to go. */
export const SIDEBAR_VITALS_ORDER = ["tasks", "gates", "meter"] as const;
export type SidebarVitalsElement = (typeof SIDEBAR_VITALS_ORDER)[number];

/** The rail rows at and above which the menu carries its label row. */
export const SIDEBAR_MENU_LABEL_ROWS = 10;
/** Rows one vitals element occupies in each mode: label plus sparkline, or one inline row. */
export const SIDEBAR_VITALS_FULL_ELEMENT_ROWS = 2;
export const SIDEBAR_VITALS_COMPACT_ELEMENT_ROWS = 1;

export interface SidebarPlan {
  /** Rows the menu block occupies at the rail's top: the five views, plus the label row when it fits. */
  menuRows: number;
  /**
   * Blank rows between the last menu row and the first vitals row. Never zero
   * while any vitals element draws — a short rail surrenders whole vitals
   * elements rather than closing the gap.
   */
  gapRows: number;
  /** Two rows per element, or one when the rail cannot pay for the full block. */
  vitalsMode: "full" | "compact";
  /** The vitals elements that draw, top to bottom, anchored to the rail's bottom. */
  vitals: readonly SidebarVitalsElement[];
}

/**
 * Compose the sidebar band for a rail of `railRows` rows — pure. The menu sits
 * at the top; the vitals block sits at the bottom; the gap between them absorbs
 * every surplus row and is never traded away: what remains after the menu and
 * one gap row is the vitals budget, spent on the full two-row block when it
 * fits whole, else on the one-row elements, surrendered from the top of the
 * block with the meter surrendered last. An element draws whole or not at all.
 */
export function planSidebar(railRows: number): SidebarPlan {
  const menuRows = railRows >= SIDEBAR_MENU_LABEL_ROWS
    ? 1 + FRAME_VIEWS.length
    : FRAME_VIEWS.length;
  const fullRows = SIDEBAR_VITALS_ORDER.length * SIDEBAR_VITALS_FULL_ELEMENT_ROWS;
  // The gap is funded before the vitals are: the budget is what remains after it.
  const budget = railRows - menuRows - 1;
  if (budget >= fullRows) {
    return {
      menuRows,
      gapRows: railRows - menuRows - fullRows,
      vitalsMode: "full",
      vitals: SIDEBAR_VITALS_ORDER,
    };
  }
  const kept = Math.max(
    0,
    Math.min(SIDEBAR_VITALS_ORDER.length, Math.floor(budget)),
  );
  return {
    menuRows,
    gapRows: kept > 0 ? railRows - menuRows - kept : 0,
    vitalsMode: "compact",
    vitals: SIDEBAR_VITALS_ORDER.slice(SIDEBAR_VITALS_ORDER.length - kept),
  };
}

export interface FrameRegion {
  id: FrameRegionId;
  row: number;
  rows: number;
  column: number;
  columns: number;
}

export interface FrameBandContent {
  /** Body band: view rows, an open row detail, or the full-height journal tail. */
  body: "rows" | "detail" | "journal";
  /** Tail band: the compact journal tail, or PENDING WRITES on the SETUP tab. */
  tail: "journal" | "pending-writes";
}

export interface PlannedFrame {
  kind: "frame";
  size: MeasuredSize;
  view: FrameView;
  tab: FrameTab;
  band: "strip" | "sidebar";
  /** What the view and state draw into each flexible band. */
  content: FrameBandContent;
  regions: readonly FrameRegion[];
  /**
   * Row bands, top to bottom; their spans tile the height exactly. A band
   * map: the nested caption sub-region is deliberately excluded.
   */
  rowSpans: Readonly<Record<string, number>>;
  /**
   * Column bands of the body band; their spans tile the width exactly. A
   * band map: the nested caption sub-region is deliberately excluded.
   */
  columnSpans: Readonly<Record<string, number>>;
  /** The single surplus-absorbing element on each axis. */
  flexible: { readonly row: "body"; readonly column: "body" };
  /**
   * The rail band's composition — menu, gap and vitals — planned when the
   * band is the sidebar, null on the strip band. The renderer draws it
   * unmodified.
   */
  sidebar: SidebarPlan | null;
  /** Regions the fit check surrendered, in FRAME_SURRENDER_ORDER. */
  surrendered: readonly SurrenderedRegionId[];
}

export interface PlainFallbackPlan {
  kind: "plain";
  size: MeasuredSize;
}

export type FramePlan = PlannedFrame | PlainFallbackPlan;

function tailRowsFor(rows: number): number {
  if (rows >= FULL_TAIL_HEIGHT) return TAIL_FULL_ROWS;
  if (rows >= STANDARD_TAIL_HEIGHT) return TAIL_STANDARD_ROWS;
  return 0;
}

/**
 * Plan the frame for a measured size, a view and a state — pure: no
 * rendering, no I/O, no read of the live terminal. Below either floor the
 * plan is the plain fallback. Otherwise the frame is row bands that tile the
 * height exactly — header, rule, the view strip (40–63 columns), the body
 * band, a second rule, the journal tail surrendered whole by height tier,
 * status, keybar — and, at ≥64 columns, column bands that tile the width
 * exactly: the constant 15-column rail beside the body. The body is the sole
 * flexible element on both axes. The view and state decide what the flexible
 * bands draw (the Journal view is the full-height tail; SETUP turns the tail
 * into PENDING WRITES; an open detail owns the body) without moving any
 * span. The caption is a nested sub-region sharing row 0 with the header
 * band, so cells on that row are owned by the header band and refinable by
 * the caption; it is surrendered first when it does not fit beside the fixed
 * header text, never squeezed to a zero or negative span. On the sidebar band
 * the plan also owns the rail's composition: the menu at the top, the vitals
 * anchored to the bottom, and at least one blank row between them whenever
 * both draw — a too-short rail surrenders whole vitals elements from the top
 * of the block, the meter last, rather than closing the gap. rowSpans and
 * columnSpans are band maps: they deliberately exclude the nested caption,
 * and column bands are reported for the body band only, so each map's spans
 * sum to the full height and width respectively.
 */
export function planFrame(
  size: MeasuredSize,
  view: FrameView = "tasks",
  state: FrameState = {},
): FramePlan {
  const columns = Math.floor(size.columns);
  const rows = Math.floor(size.rows);
  if (
    !Number.isFinite(columns) ||
    !Number.isFinite(rows) ||
    columns < FRAME_WIDTH_FLOOR ||
    rows < FRAME_HEIGHT_FLOOR
  ) {
    return { kind: "plain", size: { columns, rows } };
  }

  const tab: FrameTab = state.tab ?? "watch";
  const band = columns >= SIDEBAR_COLUMN_FLOOR ? "sidebar" : "strip";
  const stripRows = band === "strip" ? 1 : 0;
  const tailRows = tailRowsFor(rows);
  // Fixed chrome is five rows: header, rule, a second rule below the body
  // band, status and keybar.
  const bodyRows = rows - (5 + stripRows + tailRows);

  const fit: FrameFit = {
    columns,
    tailRows,
    captionCells: state.captionCells ?? 0,
  };
  // The fit check walks the declared order; the constant is what orders the
  // surrender decisions.
  const surrendered = FRAME_SURRENDER_ORDER.filter(
    (id) => !FRAME_SURRENDER_FIT[id](fit),
  );
  const captionFits = FRAME_SURRENDER_FIT.caption(fit);
  const captionCells = fit.captionCells;

  const regions: FrameRegion[] = [];
  let row = 0;
  regions.push({ id: "header", row, rows: 1, column: 0, columns });
  row += 1;
  regions.push({ id: "rule", row, rows: 1, column: 0, columns });
  row += 1;
  if (stripRows > 0) {
    regions.push({ id: "strip", row, rows: stripRows, column: 0, columns });
    row += stripRows;
  }
  const bodyRow = row;
  row += bodyRows;
  regions.push({ id: "rule2", row, rows: 1, column: 0, columns });
  row += 1;
  if (tailRows > 0) {
    regions.push({ id: "tail", row, rows: tailRows, column: 0, columns });
    row += tailRows;
  }
  regions.push({ id: "status", row, rows: 1, column: 0, columns });
  row += 1;
  regions.push({ id: "keybar", row, rows: 1, column: 0, columns });
  row += 1;

  if (band === "sidebar") {
    regions.push({
      id: "rail",
      row: bodyRow,
      rows: bodyRows,
      column: 0,
      columns: RAIL_COLUMNS,
    });
    regions.push({
      id: "body",
      row: bodyRow,
      rows: bodyRows,
      column: RAIL_COLUMNS,
      columns: columns - RAIL_COLUMNS,
    });
  } else {
    regions.push({
      id: "body",
      row: bodyRow,
      rows: bodyRows,
      column: 0,
      columns,
    });
  }
  if (captionFits) {
    regions.push({
      id: "caption",
      row: 0,
      rows: 1,
      column: columns - captionCells,
      columns: captionCells,
    });
  }

  const rowSpans: Record<string, number> = { header: 1, rule: 1 };
  if (stripRows > 0) rowSpans.strip = stripRows;
  rowSpans.body = bodyRows;
  rowSpans.rule2 = 1;
  if (tailRows > 0) rowSpans.tail = tailRows;
  rowSpans.status = 1;
  rowSpans.keybar = 1;

  const columnSpans: Record<string, number> =
    band === "sidebar"
      ? { rail: RAIL_COLUMNS, body: columns - RAIL_COLUMNS }
      : { body: columns };

  return {
    kind: "frame",
    size: { columns, rows },
    view,
    tab,
    band,
    content: {
      body: view === "journal" ? "journal" : state.detail ? "detail" : "rows",
      tail: tab === "setup" ? "pending-writes" : "journal",
    },
    regions,
    rowSpans,
    columnSpans,
    flexible: { row: "body", column: "body" },
    sidebar: band === "sidebar" ? planSidebar(bodyRows) : null,
    surrendered,
  };
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
