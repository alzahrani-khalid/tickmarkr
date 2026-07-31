import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { render } from "ink";
import {
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { GLYPHS } from "../../brand.js";
import { version } from "../../cli/commands/version.js";
import { KEYBAR_KEYS, type ComponentState } from "./components.js";
import { loadDemoCaptures, type DemoCaptures } from "./demo.js";
import {
  planFrame,
  RAIL_COLUMNS,
  resolveCockpitLayout,
  type FrameRegion,
  type FrameRegionId,
} from "./layout.js";
import {
  deriveRunCockpitData,
  deriveRunViewRows,
  RunCockpitFrame,
  type RunCockpitData,
} from "./run-cockpit.js";
import {
  deriveSetupCockpitData,
  SetupCockpitFrame,
  type SetupCockpitData,
} from "./setup-cockpit.js";
import {
  formatKeybarEntries,
  initialRunInteractionState,
  projectRunKeyEntries,
  type RunInteractionState,
  type RunKeyProjection,
} from "./keys.js";
import { cellWidth } from "./width.js";

export type CockpitName = "run" | "setup";
export type CockpitRenderer = "frame" | "plain";

export type RendererCaptureOptions = {
  readonly columns: number;
  readonly rows: number;
  readonly colour: boolean;
};

export type FrameRenderer = (
  node: ReactNode,
  options: RendererCaptureOptions,
) => Promise<string>;

export type CockpitEmission = {
  readonly renderer: CockpitRenderer;
  readonly output: string;
};

export type CaptureCockpitOptions = {
  readonly cockpit: CockpitName;
  readonly output: NodeJS.WriteStream;
  readonly binaryVersion: string;
  readonly columns?: number;
  readonly rows?: number;
  readonly interactive?: boolean;
  readonly colour?: boolean;
  readonly ci?: boolean;
  readonly runInteraction?: RunInteractionState;
  readonly runKeyProjection?: RunKeyProjection;
  readonly captures?: DemoCaptures;
  readonly plainRenderer?: (
    cockpit: CockpitName,
    binaryVersion: string,
    captures: DemoCaptures,
  ) => string;
  readonly frameRenderer?: FrameRenderer;
};

export type WidthBandCase = {
  readonly arrangement: "stacked" | "folded-keys" | "three-column";
  readonly columns: number;
};

export const WIDTH_BAND_CASES = [
  { arrangement: "stacked", columns: 80 },
  { arrangement: "folded-keys", columns: 100 },
  { arrangement: "three-column", columns: 140 },
] as const satisfies readonly WidthBandCase[];

export const HEIGHT_TIER_BOUNDARIES = [14, 18, 24, 40] as const;

export const COCKPIT_CONTRACT_DOMAIN = {
  columns: { minimum: 40, maximum: 220 },
  rows: { minimum: 14, maximum: 50 },
} as const;

/**
 * What the contract's artwork draws for the rail: a 15-cell content band, then
 * one blank gutter cell, then the divider at cell 16. Both numbers are measured
 * from the approved frames in the design contract, and the rail span the plan
 * allocates is the same 15.
 */
export const COCKPIT_SIDEBAR_CONTENT_COLUMNS = RAIL_COLUMNS;
export const COCKPIT_SIDEBAR_GUTTER_COLUMNS = 1;
/** Content plus gutter — the cells before the divider. */
export const COCKPIT_SIDEBAR_COLUMNS =
  COCKPIT_SIDEBAR_CONTENT_COLUMNS + COCKPIT_SIDEBAR_GUTTER_COLUMNS;

/**
 * Where the paint puts the frame's own region boundaries, read off the bytes.
 * The contract's artwork draws a region edge as a glyph — a full-width rule
 * between row bands, a vertical between the rail and the body — so a region
 * that moved or that overlaps its neighbour is visible here as a boundary in
 * the wrong place, at unchanged outer dimensions.
 */
export type CockpitFrameBoundaries = {
  /** The paint is exactly `rows` lines of exactly `columns` cells. */
  readonly grid: boolean;
  /** Rows drawn as a full-width horizontal rule, in order. */
  readonly ruleRows: readonly number[];
  /** Columns carrying a vertical boundary inside the body band, in order. */
  readonly dividerColumns: readonly number[];
  /** Every contiguous vertical boundary span the paint draws in the body. */
  readonly dividerSpans: readonly CockpitBoundarySpan[];
  /** Rows carrying an advertised key label, in order. */
  readonly keyRows: readonly number[];
};

export type CockpitBoundarySpan = {
  readonly column: number;
  readonly row: number;
  readonly rows: number;
};

export type CockpitFrameContractInspection = {
  readonly tiles: boolean;
  /** The boundary geometry `tiles` is decided from. */
  readonly boundaries: CockpitFrameBoundaries;
  readonly withinWidth: boolean;
  readonly headerCount: number;
  readonly markGlyphCount: number;
  readonly keybarContained: boolean;
  /** Cells the rail's content band occupies; 0 where the plan draws no rail. */
  readonly sidebarContentColumns: number;
  /** Blank cells between that band and the divider; 0 where there is no rail. */
  readonly sidebarGutterColumns: number;
  /** Focus markers inside the navigation zone alone — never the whole frame. */
  readonly sidebarFocusMarkers: number;
  /** Selection markers inside the active list zone alone. */
  readonly listSelectionMarkers: number;
};

const CAPTURE_ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/**
 * The mark's alphabet: the block range minus the glyphs the approved artwork
 * itself draws — the sparkline's eighth-block ramp (▁▂▃▄▅▆▇█) and the meter's
 * shades (░▒▓). Subtracting them is what lets the scan run over the whole frame
 * rather than over a header band a renderer could redefine, which is the point:
 * a mark reintroduced anywhere is found.
 */
export const COCKPIT_MARK_ALPHABET = "[▀▉-▐▔-▟]";
const COCKPIT_MARK_GLYPHS = new RegExp(COCKPIT_MARK_ALPHABET, "gu");
const KEYBAR_LABEL = /(?:↑↓ Move|⏎ Open|← Back|Tab (?:Setup|Watch)|1–5 View|f Follow|\? Help|q Quit)/u;
/**
 * The header signature: the brand word standing on its own, wherever the paint
 * puts it. Indentation is not part of the signature — the artwork insets the
 * word on wide frames, so anchoring at column zero would read a valid header as
 * absent and an indented duplicate as absent too. A path or branch reference
 * that merely contains the word (`tickmarkr/run-…`) is not a header, so both
 * sides are bounded against the characters such a reference joins with.
 */
const HEADER_SIGNATURE = /(?<![\w/-])tickmarkr(?![\w/-])/gu;
const FOCUS_MARKER = "❯";
/** The glyphs the contract's artwork draws a region edge with. */
const RULE_GLYPH = "─";
const DIVIDER_GLYPH = "│";

const sameSequence = (
  observed: readonly number[],
  planned: readonly number[],
): boolean =>
  observed.length === planned.length
  && observed.every((value, index) => value === planned[index]);

const sameBoundarySpans = (
  observed: readonly CockpitBoundarySpan[],
  planned: readonly CockpitBoundarySpan[],
): boolean =>
  observed.length === planned.length
  && observed.every((span, index) => {
    const expected = planned[index];
    return expected !== undefined
      && span.column === expected.column
      && span.row === expected.row
      && span.rows === expected.rows;
  });

/** Display-cell offsets carrying `glyph`, never code-point offsets. */
function glyphColumns(line: string, glyph: string): number[] {
  return [...line.matchAll(new RegExp(glyph, "gu"))].map((match) =>
    cellWidth(line.slice(0, match.index))
  );
}

/** Contiguous row spans for every column carrying the vertical boundary. */
function verticalBoundarySpans(
  lines: readonly string[],
  region: FrameRegion | undefined,
): CockpitBoundarySpan[] {
  if (!region) return [];
  const rowsByColumn = new Map<number, number[]>();
  for (let row = region.row; row < region.row + region.rows; row += 1) {
    for (const column of glyphColumns(lines[row] ?? "", DIVIDER_GLYPH)) {
      const observedRows = rowsByColumn.get(column) ?? [];
      observedRows.push(row);
      rowsByColumn.set(column, observedRows);
    }
  }

  return [...rowsByColumn.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([column, observedRows]) => {
      const spans: CockpitBoundarySpan[] = [];
      let start = observedRows[0];
      let previous = start;
      for (const row of observedRows.slice(1)) {
        if (previous !== undefined && row === previous + 1) {
          previous = row;
          continue;
        }
        if (start !== undefined && previous !== undefined) {
          spans.push({ column, row: start, rows: previous - start + 1 });
        }
        start = row;
        previous = row;
      }
      if (start !== undefined && previous !== undefined) {
        spans.push({ column, row: start, rows: previous - start + 1 });
      }
      return spans;
    });
}

/** Where the paint drew the header signature, in cells rather than in bytes. */
export type HeaderSignatureHit = {
  readonly row: number;
  readonly column: number;
  readonly text: string;
};

/**
 * Every header signature in a painted frame, at whatever indentation it was
 * drawn. The inspector counts these and the falsification lever plants one, so
 * neither can hold a private idea of what a header looks like.
 */
export function findHeaderSignatures(
  lines: readonly string[],
): HeaderSignatureHit[] {
  return lines.flatMap((line, row) =>
    [...line.matchAll(HEADER_SIGNATURE)].map((match) => ({
      row,
      // Cells, not code units — the same count the frame's cells are read in.
      column: cellWidth(line.slice(0, match.index)),
      text: match[0],
    }))
  );
}

/** The cells of one row inside a planned region's column span. */
function regionSlice(line: string, region: FrameRegion): string {
  const cells = [...line];
  return cells.slice(region.column, region.column + region.columns).join("");
}

function markersIn(
  lines: readonly string[],
  region: FrameRegion | undefined,
): number {
  if (!region) return 0;
  let markers = 0;
  for (let row = region.row; row < region.row + region.rows; row += 1) {
    const line = lines[row];
    if (line === undefined) continue;
    markers += [...regionSlice(line, region)]
      .filter((glyph) => glyph === FOCUS_MARKER).length;
  }
  return markers;
}

/**
 * Inspect emitted terminal bytes without re-planning their geometry. This is
 * deliberately renderer-agnostic: the sweep and the production capture path
 * can judge the same paint, and a future renderer cannot move this target by
 * changing its own plan. The one thing it does take from the plan is where the
 * zones are, because "one zone holds focus" is a statement about zones and
 * cannot be counted as a frame-wide glyph total.
 */
export function inspectCockpitFrameContract(
  output: string,
  columns: number,
  rows: number,
): CockpitFrameContractInspection {
  const visible = output.replace(CAPTURE_ANSI, "").replace(/\n$/u, "");
  const lines = visible.split("\n");
  const widths = lines.map((line) => cellWidth(line));
  const headerCount = findHeaderSignatures(lines).length;
  const markGlyphCount = lines.reduce(
    (count, line) => count + [...line.matchAll(COCKPIT_MARK_GLYPHS)].length,
    0,
  );
  const keyRows = lines.flatMap((line, row) =>
    KEYBAR_LABEL.test(line) ? [row] : []
  );

  const plan = planFrame({ columns, rows });
  const regions = plan.kind === "frame" ? plan.regions : [];
  const region = (id: FrameRegionId): FrameRegion | undefined =>
    regions.find((candidate) => candidate.id === id);
  const body = region("body");
  const rail = region("rail");
  const navigation = rail ?? region("strip");
  const keybar = region("keybar");

  // The boundaries the paint actually draws. A full-width rule is a row band's
  // edge; a vertical inside the body band is the rail's edge. Both are read
  // from the bytes and neither is inferred from whichever row happens to be
  // painted last.
  const ruleRows = lines.flatMap((line, row) => {
    const cells = [...line];
    return cells.length > 0 && cellWidth(line) === columns
        && cells.every((glyph) => glyph === RULE_GLYPH)
      ? [row]
      : [];
  });
  const dividerSpans = verticalBoundarySpans(lines, body);
  const dividerColumns = [...new Set(
    dividerSpans.map(({ column }) => column),
  )];
  const boundaries: CockpitFrameBoundaries = {
    grid: lines.length === rows
      && lines.every((line) => cellWidth(line) === columns),
    ruleRows,
    dividerColumns,
    dividerSpans,
    keyRows,
  };

  // What the plan says those boundaries must be: a rule at each rule band, and
  // — only where the artwork draws a rail — one vertical, at the divider cell
  // the rail's content band and its gutter end at.
  const plannedRuleRows = regions
    .filter((candidate) => candidate.id === "rule" || candidate.id === "rule2")
    .map((candidate) => candidate.row)
    .sort((left, right) => left - right);
  const plannedDividerColumns = rail ? [COCKPIT_SIDEBAR_COLUMNS] : [];
  const plannedDividerSpans: CockpitBoundarySpan[] = rail && body
    ? [{
        column: COCKPIT_SIDEBAR_COLUMNS,
        row: body.row,
        rows: body.rows,
      }]
    : [];

  // The rail's content band and its gutter, read off the paint: the divider
  // column the body rows agree on, less the blank cells every one of them
  // leaves in front of it.
  let sidebarContentColumns = 0;
  let sidebarGutterColumns = 0;
  if (rail && body) {
    const railRows = lines
      .slice(body.row, body.row + body.rows)
      .filter((line) => line.includes("│"));
    const dividers = new Set(
      railRows.map((line) => cellWidth(line.slice(0, line.indexOf("│")))),
    );
    if (railRows.length === body.rows && dividers.size === 1) {
      const divider = [...dividers][0]!;
      let gutter = 0;
      while (
        gutter < divider
        && railRows.every((line) =>
          ([...line][divider - gutter - 1] ?? " ") === " "
        )
      ) {
        gutter += 1;
      }
      sidebarContentColumns = divider - gutter;
      sidebarGutterColumns = gutter;
    }
  }

  return {
    // Tiling is region ownership, not a filled rectangle: the paint covers the
    // whole grid AND every boundary sits at the offset the plan gives it, so a
    // region moved or overlapped at unchanged outer dimensions is a violation.
    tiles: boundaries.grid
      && sameSequence(ruleRows, plannedRuleRows)
      && sameSequence(dividerColumns, plannedDividerColumns)
      && sameBoundarySpans(dividerSpans, plannedDividerSpans),
    boundaries,
    withinWidth: widths.every((width) => width <= columns),
    headerCount,
    markGlyphCount,
    // Contained means inside the keybar band the plan allocated — never
    // "wherever the last painted row turned out to be", which accepts a keybar
    // one row above its own blank band.
    keybarContained: keybar !== undefined
      && keyRows.length > 0
      && keyRows.every((row) => row === keybar.row),
    sidebarContentColumns,
    sidebarGutterColumns,
    sidebarFocusMarkers: markersIn(lines, navigation),
    listSelectionMarkers: markersIn(lines, body),
  };
}

/** What the contract's artwork draws at one size — the sweep's expectation. */
export function cockpitFrameContractExpectation(
  columns: number,
  rows: number,
): Omit<CockpitFrameContractInspection, "listSelectionMarkers" | "boundaries"> {
  const plan = planFrame({ columns, rows });
  const sidebar = plan.kind === "frame" && plan.band === "sidebar";
  return {
    tiles: true,
    withinWidth: true,
    headerCount: 1,
    markGlyphCount: 0,
    keybarContained: true,
    sidebarContentColumns: sidebar ? COCKPIT_SIDEBAR_CONTENT_COLUMNS : 0,
    sidebarGutterColumns: sidebar ? COCKPIT_SIDEBAR_GUTTER_COLUMNS : 0,
    sidebarFocusMarkers: 1,
  };
}

export type GoldenFrameCase = {
  readonly id: string;
  readonly fixture: string;
  readonly cockpit: CockpitName;
  readonly axis: "width" | "height" | "variant";
  readonly columns: number;
  readonly rows: number;
  readonly interactive: boolean;
  readonly colour: boolean;
  readonly ci: boolean;
};

const fixtureName = (
  cockpit: CockpitName,
  id: string,
  columns: number,
  rows: number,
): string => `${cockpit}.${id}.${columns}x${rows}.txt`;

/**
 * The rendered corpus of one surface: a frame at each contracted width band and
 * each height tier boundary, plus the colourless variant.
 */
const renderedCasesFor = (cockpit: CockpitName): GoldenFrameCase[] => [
  ...WIDTH_BAND_CASES.map(({ arrangement, columns }) => ({
    id: `${cockpit}-width-${arrangement}`,
    fixture: fixtureName(cockpit, `width-${arrangement}`, columns, 24),
    cockpit,
    axis: "width" as const,
    columns,
    rows: 24,
    interactive: true,
    colour: false,
    ci: false,
  })),
  ...HEIGHT_TIER_BOUNDARIES.map((rows) => ({
    id: `${cockpit}-height-${rows}`,
    fixture: fixtureName(cockpit, `height-${rows}`, 140, rows),
    cockpit,
    axis: "height" as const,
    columns: 140,
    rows,
    interactive: true,
    colour: false,
    ci: false,
  })),
  {
    id: `${cockpit}-no-colour`,
    fixture: fixtureName(cockpit, "no-colour", 140, 24),
    cockpit,
    axis: "variant",
    columns: 140,
    rows: 24,
    interactive: true,
    colour: false,
    ci: false,
  },
];

/** The two machine surfaces: output this redesign did not move. */
const machineCasesFor = (cockpit: CockpitName): GoldenFrameCase[] => [
  {
    id: `${cockpit}-non-tty`,
    fixture: fixtureName(cockpit, "non-tty", 140, 24),
    cockpit,
    axis: "variant",
    columns: 140,
    rows: 24,
    interactive: false,
    colour: false,
    ci: false,
  },
  {
    id: `${cockpit}-ci`,
    fixture: fixtureName(cockpit, "ci", 140, 24),
    cockpit,
    axis: "variant",
    columns: 140,
    rows: 24,
    interactive: true,
    colour: false,
    ci: true,
  },
];

/** The surfaces whose rendered appearance this redesign moved. */
export const RETIRED_RENDERED_COCKPITS: readonly CockpitName[] = ["run"];

/**
 * A golden case is RETIRED when its cockpit's rendered appearance moved and
 * the case is a rendered one. Retirement keeps the superseded bytes committed
 * and the case in the shipped manifest — only regeneration skips it (OBS-207).
 */
export const isRetiredGoldenFrame = (golden: GoldenFrameCase): boolean =>
  RETIRED_RENDERED_COCKPITS.includes(golden.cockpit)
  && golden.interactive
  && !golden.ci;

const goldenCasesFor = (cockpit: CockpitName): GoldenFrameCase[] => [
  ...renderedCasesFor(cockpit),
  ...machineCasesFor(cockpit),
];

export const GOLDEN_FRAME_CASES = [
  ...goldenCasesFor("run"),
  ...goldenCasesFor("setup"),
] as const satisfies readonly GoldenFrameCase[];

export type ColourFrameCase = {
  readonly id:
    | "healthy-colour"
    | "healthy-no-colour"
    | "warning-failure-colour";
  readonly fixture: string;
  readonly sourceFileName: string;
  readonly columns: number;
  readonly rows: number;
  readonly colour: boolean;
};

/**
 * The colour corpus has a deliberately separate manifest from the layout
 * corpus. Layout cases stay colourless; these cases alone exercise real ink,
 * and their committed bytes are RETIRED superseded evidence: the ink oracles
 * render each case fresh and judge it.
 */
export const COLOUR_FRAME_CASES = [
  {
    id: "healthy-colour",
    fixture: "run-20260718-000943.colour.140x24.txt",
    sourceFileName: "run-20260718-000943.journal.jsonl",
    columns: 140,
    rows: 24,
    colour: true,
  },
  {
    id: "healthy-no-colour",
    fixture: "run-20260718-000943.no-colour.140x24.txt",
    sourceFileName: "run-20260718-000943.journal.jsonl",
    columns: 140,
    rows: 24,
    colour: false,
  },
  {
    id: "warning-failure-colour",
    fixture: "run-20260725-025004.interrupted.colour.140x24.txt",
    sourceFileName: "run-20260725-025004.interrupted.journal.jsonl",
    columns: 140,
    rows: 24,
    colour: true,
  },
] as const satisfies readonly ColourFrameCase[];

const COLOUR_SOURCE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/cockpit/colour/sources",
);

type DerivedCockpitData =
  | { readonly cockpit: "run"; readonly data: RunCockpitData }
  | { readonly cockpit: "setup"; readonly data: SetupCockpitData };

function derivedData(
  cockpit: CockpitName,
  binaryVersion: string,
  captures: DemoCaptures,
): DerivedCockpitData {
  if (cockpit === "setup") {
    return {
      cockpit,
      data: deriveSetupCockpitData(captures, binaryVersion),
    };
  }
  const source = captures.journals.find((capture) =>
    capture.fileName === "run-20260724-231138.journal.jsonl"
  );
  if (!source) throw new Error("healthy cockpit capture is missing");
  return {
    cockpit,
    data: deriveRunCockpitData(source, binaryVersion),
  };
}

function stateGlyph(state: ComponentState): string {
  if (state === "active" || state === "pass") return GLYPHS.pass;
  if (state === "inactive") return GLYPHS.toggleInactive;
  if (state === "fail") return GLYPHS.fail;
  if (state === "warn") return GLYPHS.attention;
  return GLYPHS.neutral;
}

export function defaultPlainRenderer(
  cockpit: CockpitName,
  binaryVersion: string,
  captures: DemoCaptures,
  columns = 140,
  runInteraction: RunInteractionState = initialRunInteractionState(),
  runKeyProjection: RunKeyProjection = projectRunKeyEntries,
): string {
  const derived = derivedData(cockpit, binaryVersion, captures);
  if (derived.cockpit === "run") {
    const data = derived.data;
    const rowIds = deriveRunViewRows(
      data,
      runInteraction.activeView,
      runInteraction.filterQuery,
    ).map((row) => row.id);
    return [
      `tickmarkr v${binaryVersion}`,
      `${data.runId} ${data.status} ${data.elapsed}`,
      ...data.statusItems.map((item) =>
        `${stateGlyph(item.state)} ${item.text}`
      ),
      `keys ${formatKeybarEntries(runKeyProjection({
        interaction: runInteraction,
        columns,
        rowIds,
      }))}`,
      "",
    ].join("\n");
  }
  const data = derived.data;
  return [
    `tickmarkr v${binaryVersion}`,
    `setup ${data.counts.found} found ${data.counts.authenticated} authed ${data.counts.routable} routable`,
    ...data.harnesses.map((harness) =>
      `${stateGlyph(harness.state)} ${harness.stateWord} ${harness.id}`
    ),
    ...data.deniedChannels.map((denied) =>
      `${GLYPHS.fail} denied ${denied.channel} - ${denied.reason}`
    ),
    `${GLYPHS.pass} base untouched`,
    `${GLYPHS.attention} ${data.stagedChanges.length} changes unsaved`,
    `keys ${KEYBAR_KEYS.setup.map((item) =>
      `${item.key} ${item.label}`
    ).join(" · ")}`,
    "",
  ].join("\n");
}

function frameNode(
  derived: DerivedCockpitData,
  columns: number,
  rows: number,
  runInteraction: RunInteractionState = initialRunInteractionState(),
  runKeyProjection: RunKeyProjection = projectRunKeyEntries,
): ReactNode {
  if (derived.cockpit === "run") {
    return createElement(RunCockpitFrame, {
      data: derived.data,
      columns,
      rows,
      interaction: runInteraction,
      keyProjection: runKeyProjection,
    });
  }
  return createElement(SetupCockpitFrame, {
    data: derived.data,
    columns,
    rows,
  });
}

/**
 * Capture exactly the bytes Ink writes for one static paint. Debug mode is
 * deliberate: it exposes the complete frame rather than terminal patch
 * instructions, so the committed corpus is the renderer's frame output.
 */
export async function captureRendererOutput(
  node: ReactNode,
  options: RendererCaptureOptions,
): Promise<string> {
  const sizedNode = isValidElement(node)
      && (node.type === RunCockpitFrame || node.type === SetupCockpitFrame)
    ? cloneElement(
      node as ReactElement<{ readonly rows?: number }>,
      { rows: options.rows },
    )
    : node;
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = options.columns;
  output.rows = options.rows;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;

  const previousColourLevel = chalk.level;
  const previousNoColour = process.env.NO_COLOR;
  chalk.level = options.colour ? 3 : 0;
  if (options.colour) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = "1";

  let painted!: () => void;
  const firstPaint = new Promise<void>((resolve) => {
    painted = resolve;
  });
  const app = render(sizedNode, {
    stdout: output as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    onRender: painted,
  });
  try {
    await firstPaint;
    return writes.at(-1) ?? "";
  } finally {
    app.unmount();
    app.cleanup();
    chalk.level = previousColourLevel;
    if (previousNoColour === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColour;
  }
}

/**
 * The single interactive/plain boundary. It decides before mounting Ink, then
 * falls back again if a renderer returns an empty paint.
 */
export async function captureCockpitOutput(
  options: CaptureCockpitOptions,
): Promise<CockpitEmission> {
  const columns = options.columns ?? options.output.columns ?? 80;
  const rows = options.rows ?? options.output.rows ?? 24;
  const interactive = options.interactive
    ?? options.output.isTTY === true;
  const colour = options.colour
    ?? process.env.NO_COLOR === undefined;
  const ci = options.ci ?? process.env.CI === "true";
  const captures = options.captures ?? loadDemoCaptures();
  const plain = () => options.plainRenderer === undefined
    ? defaultPlainRenderer(
      options.cockpit,
      options.binaryVersion,
      captures,
      columns,
      options.runInteraction,
      options.runKeyProjection,
    )
    : options.plainRenderer(options.cockpit, options.binaryVersion, captures);
  const layout = resolveCockpitLayout(columns, rows);

  if (!interactive || options.output.isTTY !== true || ci || layout.renderer === "plain") {
    const plainOutput = plain();
    options.output.write(plainOutput);
    return { renderer: "plain", output: plainOutput };
  }

  const derived = derivedData(options.cockpit, options.binaryVersion, captures);
  const frameOutput = await (
    options.frameRenderer ?? captureRendererOutput
  )(
    frameNode(
      derived,
      columns,
      rows,
      options.runInteraction,
      options.runKeyProjection,
    ),
    { columns, rows, colour },
  );
  if (frameOutput.length === 0) {
    const plainOutput = plain();
    options.output.write(plainOutput);
    return { renderer: "plain", output: plainOutput };
  }
  options.output.write(frameOutput);
  return { renderer: "frame", output: frameOutput };
}

export type RegeneratedGoldenFrame = GoldenFrameCase & {
  readonly renderer: CockpitRenderer;
  readonly output: string;
  readonly emitted: string;
};

export async function regenerateGoldenFrames(
  binaryVersion?: string,
): Promise<readonly RegeneratedGoldenFrame[]> {
  const resolvedVersion = binaryVersion ?? await version();
  const captures = loadDemoCaptures();
  const regenerated: RegeneratedGoldenFrame[] = [];
  for (const golden of GOLDEN_FRAME_CASES) {
    // Regenerating a retired case would produce the new appearance, and
    // byte-comparing would force the re-stamp the contract forbids.
    if (isRetiredGoldenFrame(golden)) continue;
    const output = new PassThrough() as PassThrough & {
      isTTY: boolean;
      columns: number;
      rows: number;
    };
    output.isTTY = golden.interactive;
    output.columns = golden.columns;
    output.rows = golden.rows;
    const writes: string[] = [];
    const write = output.write.bind(output);
    output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      writes.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return Reflect.apply(write, output, [chunk, ...args]) as boolean;
    }) as typeof output.write;
    const emission = await captureCockpitOutput({
      cockpit: golden.cockpit,
      output: output as unknown as NodeJS.WriteStream,
      binaryVersion: resolvedVersion,
      columns: golden.columns,
      rows: golden.rows,
      interactive: golden.interactive,
      colour: golden.colour,
      ci: golden.ci,
      captures,
    });
    regenerated.push({
      ...golden,
      ...emission,
      emitted: writes.join(""),
    });
  }
  return regenerated;
}

export function findGoldenFrameMismatches(
  regenerated: readonly RegeneratedGoldenFrame[],
  committed: ReadonlyMap<string, string>,
): string[] {
  // Membership is judged against the whole shipped manifest, retired cases
  // included: a retired fixture is claimed, so only its bytes are exempt.
  // Anything committed that no case claims is still named.
  const expected = new Set(GOLDEN_FRAME_CASES.map((frame) => frame.fixture));
  return [
    ...regenerated.flatMap((frame) =>
      committed.get(frame.fixture) === frame.output ? [] : [frame.fixture]
    ),
    ...[...committed.keys()].filter((fixture) => !expected.has(fixture)),
  ].sort();
}

export type RegeneratedColourFrame = ColourFrameCase & {
  readonly output: string;
  readonly emitted: string;
};

/**
 * Regenerate only the colour contract corpus from its own manifest. Historical
 * run sources are read and rendered byte-for-byte with their captured daemon
 * stopped, matching the demo path and avoiding live-process state in committed
 * bytes.
 */
export async function regenerateColourFrames(
  binaryVersion?: string,
): Promise<readonly RegeneratedColourFrame[]> {
  const resolvedVersion = binaryVersion ?? await version();
  const regenerated: RegeneratedColourFrame[] = [];

  for (const colourCase of COLOUR_FRAME_CASES) {
    const source = {
      fileName: colourCase.sourceFileName,
      raw: readFileSync(
        join(COLOUR_SOURCE_DIRECTORY, colourCase.sourceFileName),
        "utf8",
      ),
    };
    const data = deriveRunCockpitData(source, resolvedVersion, {
      isDaemonAlive: () => false,
    });
    const output = await captureRendererOutput(
      frameNode(
        { cockpit: "run", data },
        colourCase.columns,
        colourCase.rows,
      ),
      {
        columns: colourCase.columns,
        rows: colourCase.rows,
        colour: colourCase.colour,
      },
    );
    regenerated.push({
      ...colourCase,
      output,
      emitted: output,
    });
  }

  return regenerated;
}
