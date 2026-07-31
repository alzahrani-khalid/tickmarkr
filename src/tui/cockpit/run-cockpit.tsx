import { Box, useApp, useStdout, type DOMElement } from "ink";
import {
  cloneElement,
  type ReactElement,
  type ReactNode,
  useInsertionEffect,
  useMemo,
  useRef,
} from "react";
import {
  GLYPHS,
  PLAIN_COMPACT_LOCKUP,
} from "../../brand.js";
import {
  allocateBandColumns,
  BandLines,
  BodyText,
  CockpitGrid,
  composeBandLine,
  JournalRowPanel,
  keyRosterLines,
  Panel,
  PANEL_CHROME_ROWS,
  ProgressMeter,
  Sparkline,
  StatTile,
  StatusStrip,
  type BandColumnContent,
  type JournalRow,
} from "./components.js";
import { fieldReading, type RunCockpitData, type TaskRow } from "./derive.js";
import {
  initialRunInteractionState,
  projectRunKeyEntries,
  reconcileRunInteraction,
  RUN_SIDE_RAIL_COLUMN_FLOOR,
  runPanelFocusOrder,
  runSideRailVisible,
  selectableRunViewRowIds,
  type KeybarEntry,
  type RunInteractionState,
  type RunKeyProjection,
} from "./keys.js";
import {
  DECISIONS_TAB_TITLE,
  RUN_VIEWS,
  runViewById,
  setupSectionAt,
  SETUP_SECTIONS,
  type RunViewId,
} from "./views.js";
import {
  FRAME_HEADER_GAP,
  FULL_JOURNAL_ROWS,
  planFrame,
  SIDEBAR_COLUMN_FLOOR,
  type FramePlan,
  type FrameRegion,
  type FrameState,
  type FrameCockpitLayout,
  type FrameView,
  type MeasuredSize,
  type PlannedFrame,
  type SidebarPlan,
  type SidebarVitalsElement,
} from "./layout.js";
import { cellWidth, fitCells, wrapCells } from "./width.js";
export { deriveRunCockpitData } from "./derive.js";
export type { RunCockpitData } from "./derive.js";
export { PANEL_CHROME_ROWS } from "./components.js";

/** The width focus and key routing resolve at. */
export function runKeyColumns(columns: number): number {
  return columns >= SIDEBAR_COLUMN_FLOOR
    ? Math.max(columns, RUN_SIDE_RAIL_COLUMN_FLOOR)
    : columns;
}

const NARROW_HEADER_ALLOCATION = {
  chromeColumns: 0,
  minimumReadableColumns: 1,
} as const;

/**
 * How many rows one line of body text occupies once the renderer wraps it into
 * `columns`. This mirrors the renderer's own word wrap — greedy, and breaking a
 * word that cannot fit on a line of its own — so a frame can charge a panel the
 * rows it will really occupy instead of a hand-tuned constant.
 */
export function wrappedRows(text: string, columns: number): number {
  return wrapCells(text, columns).length;
}

/** The rows a bordered panel occupies when its body wraps into `columns`. */
export function panelRows(
  lines: readonly string[],
  columns: number,
): number {
  return lines.reduce(
    (rows, line) =>
      rows + wrapCells(line, columns, { continuationPrefix: "↳ " }).length,
    PANEL_CHROME_ROWS,
  );
}

function IdentityHeader({
  data,
  columns,
  secondary = true,
}: {
  data: RunCockpitData;
  columns: number;
  secondary?: boolean;
}): ReactElement {
  const lockup = PLAIN_COMPACT_LOCKUP.split("\n");
  if (!runSideRailVisible(columns)) {
    const primary = [
      { title: "", lines: [lockup[0] ?? "tickmarkr"] },
      {
        title: "",
        lines: [`v${data.binaryVersion} · binary ${GLYPHS.pass}`],
      },
    ] as const satisfies readonly [BandColumnContent, BandColumnContent];
    const secondaryBand = [
      { title: "", lines: [lockup[1] ?? "tickmarkr"] },
      {
        title: "",
        lines: [
          `${data.runId} · ${data.branch}  ${data.status} · ${data.elapsed}`,
        ],
      },
    ] as const satisfies readonly [BandColumnContent, BandColumnContent];
    return (
      <Box flexDirection="column">
        <NarrowHeaderBand columns={columns} content={primary} rightStrong />
        {secondary && (
          <NarrowHeaderBand columns={columns} content={secondaryBand} />
        )}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <BodyText emphasis="strong">{lockup[0] ?? "tickmarkr"}</BodyText>
        <BodyText emphasis="strong">v{data.binaryVersion} · binary {GLYPHS.pass}</BodyText>
      </Box>
      {secondary && (
        <Box justifyContent="space-between">
          <BodyText emphasis="strong">{lockup[1] ?? "tickmarkr"}</BodyText>
          <BodyText>
            {data.runId} · {data.branch}  {data.status} · {data.elapsed}
          </BodyText>
        </Box>
      )}
    </Box>
  );
}

function NarrowHeaderBand({
  columns,
  content,
  rightStrong = false,
}: {
  columns: number;
  content: readonly [BandColumnContent, BandColumnContent];
  rightStrong?: boolean;
}): ReactElement {
  const widths = allocateBandColumns(
    columns,
    content,
    NARROW_HEADER_ALLOCATION,
  );
  return (
    <CockpitGrid
      columns={columns}
      columnContents={content}
      allocation={NARROW_HEADER_ALLOCATION}
    >
      <BandLines
        columns={Math.max(1, widths[0]!)}
        lines={content[0].lines}
        emphasis="strong"
      />
      <Box alignItems="flex-end" flexDirection="column">
        <BandLines
          columns={Math.max(1, widths[1]!)}
          lines={content[1].lines}
          emphasis={rightStrong ? "strong" : "normal"}
        />
      </Box>
    </CockpitGrid>
  );
}

const RUN_SIDE_RAIL_WIDTH = 16;
/** Border plus horizontal padding charged by Panel around its body. */
const RUN_PANEL_HORIZONTAL_CHROME = 4;

/** The header caption: the run's identity line, planned as the header's refinable sub-region. */
function frameCaption(data: RunCockpitData): string {
  return `${data.runId} · ${data.branch} · ${data.status} · ${data.elapsed}`;
}

/** The header's fixed left part: brand, version and the two tab labels. */
function headerLead(data: RunCockpitData, plan: PlannedFrame): string {
  const tabs = plan.tab === "watch"
    ? `[ WATCH ]${FRAME_HEADER_GAP}${DECISIONS_TAB_TITLE}`
    : `WATCH${FRAME_HEADER_GAP}[ ${DECISIONS_TAB_TITLE} ]`;
  return `tickmarkr ${data.binaryVersion}${FRAME_HEADER_GAP}${tabs}`;
}

/** The one plain header line: brand, version and the two tab labels, the active one marked. */
function PlannedHeader({
  data,
  plan,
  columns,
}: {
  data: RunCockpitData;
  plan: PlannedFrame;
  columns: number;
}): ReactElement {
  return (
    <BodyText emphasis="strong">
      {fitCells(headerLead(data, plan), Math.max(1, columns))}
    </BodyText>
  );
}

/** The header's caption sub-region: the run identity, right-aligned in it. */
function PlannedCaption({
  data,
  columns,
}: {
  data: RunCockpitData;
  columns: number;
}): ReactElement {
  const caption = frameCaption(data);
  const pad = Math.max(0, columns - cellWidth(caption));
  return (
    <BodyText>
      {fitCells(`${" ".repeat(pad)}${caption}`, Math.max(1, columns))}
    </BodyText>
  );
}

function runViewBodyColumns(
  columns: number,
  navigationRail: boolean,
  keysRail: boolean,
): number {
  const railColumns = (navigationRail ? RUN_SIDE_RAIL_WIDTH + 1 : 0)
    + (keysRail ? RUN_SIDE_RAIL_WIDTH + 1 : 0);
  return Math.max(1, columns - railColumns - RUN_PANEL_HORIZONTAL_CHROME);
}

/**
 * One row of a side rail. A rail row is exactly one row: where the layout
 * squeezes the rail narrower than a label, the label is clipped rather than
 * wrapped onto a second row nothing charges to the height budget — the rail's
 * height is then a constant, and a rail can never be what overruns the terminal.
 */
function RailRow({
  label,
  selected,
}: {
  label: string;
  selected: boolean;
}): ReactElement {
  return (
    <Box height={1} overflow="hidden">
      <BodyText emphasis={selected ? "strong" : "normal"}>
        {selected ? GLYPHS.pointer : " "} {label}
      </BodyText>
    </Box>
  );
}

function NavigationPanel({
  focused = false,
  selection = 0,
}: {
  focused?: boolean;
  selection?: number;
}): ReactElement {
  return (
    <Panel title="VIEWS" width={RUN_SIDE_RAIL_WIDTH} focused={focused}>
      {RUN_VIEWS.map((view, index) => (
        <RailRow
          key={view.id}
          label={view.label}
          selected={index === selection}
        />
      ))}
    </Panel>
  );
}

/**
 * The setup tab's rail. It draws in the same column as VIEWS and holds fewer
 * rows than it, so the rail can never be what decides the frame's height — the
 * body's budget stays the one budget, and the labels fit their column unwrapped.
 */
/** The lines the selected setup section states about itself. */
function setupSectionLines(
  section: ReturnType<typeof setupSectionAt>,
  data: RunCockpitData,
): readonly string[] {
  if (section.readOnly) {
    return [`${section.title} is read-only on this surface`];
  }
  const parked = data.taskRows.filter((row) => row.state === "human");
  if (parked.length === 0) return ["No parked decisions in this engagement"];
  return parked.map((row) => `${row.taskId} · parked · attempt ${row.attempts ?? 0}`);
}

/**
 * The setup tab's body, drawn inside the same row budget the watch tab's views
 * are drawn inside — the tab an operator switches to can never be taller than
 * the one they switched away from.
 */
function SetupTabPanel({
  data,
  selection,
  focused,
  keyEntries,
  help,
  bodyRows,
  bodyColumns,
}: {
  data: RunCockpitData;
  selection: number;
  focused: boolean;
  keyEntries: readonly KeybarEntry[];
  help: boolean;
  bodyRows: number;
  bodyColumns: number;
}): ReactElement {
  const section = setupSectionAt(selection);
  return (
    <SizedLinesPanel
      title={help ? "HELP" : section.title}
      lines={help ? helpLines(keyEntries) : setupSectionLines(section, data)}
      bodyRows={bodyRows}
      wrapColumns={bodyColumns}
      focused={focused}
      flexGrow={1}
    />
  );
}

/**
 * The one keybar, drawn once. While the help overlay is up it is not drawn at
 * all: the overlay is this same projected roster, one entry per line, so
 * drawing both states every key twice — and costs the frame the very rows the
 * shortest supported terminal has none of.
 */
function RunKeybar({
  entries,
  width,
  help,
}: {
  entries: readonly KeybarEntry[];
  width: number;
  help: boolean;
}): ReactElement {
  if (help) return <></>;
  // The plan grants this band one row: the first lossless roster slice is drawn explicitly.
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <BodyText emphasis="dim">{keyRosterLines(entries, width)[0] ?? ""}</BodyText>
    </Box>
  );
}

/**
 * The selectable rows owned by one view. The overview's journal is a passive
 * tail, not its item collection; tasks, gates and fleet remain honestly empty
 * until their dedicated derivations land. Journal rows keep the source-record
 * identities assigned by the production journal derivation.
 */
export function deriveRunViewRows(
  data: RunCockpitData,
  viewId: RunViewId,
  filterQuery = "",
): readonly JournalRow[] {
  const query = filterQuery.trim().toLowerCase();
  const rows = promotedViewRows(data, viewId);
  return query === ""
    ? rows
    : rows.filter((row) => row.text.toLowerCase().includes(query));
}

/**
 * The rows a view owns, in the identities `runViewRowIdentities` assigns them —
 * the two must agree, or the surface's keys would stand on rows the frame never
 * drew. The overview owns no list of its own, and the journal is a tail.
 */
function promotedViewRows(
  data: RunCockpitData,
  viewId: RunViewId,
): readonly JournalRow[] {
  if (viewId === "journal") return data.journalRows;
  if (viewId === "tasks") {
    return data.taskRows.map((row) => ({
      id: row.id,
      time: fieldReading(row.lastEventTime),
      state: taskRowState(row.state),
      text: `${row.taskId} · ${fieldReading(row.state)} · attempt ${
        fieldReading(row.attempts)
      } · ${fieldReading(row.actor)}${row.title === undefined ? "" : ` · ${row.title}`}`,
    }));
  }
  if (viewId === "gates") {
    return data.gateRows.map((row) => ({
      id: row.id,
      time: row.time,
      state: row.state,
      text: `${fieldReading(row.taskId)} · ${fieldReading(row.gate)} · ${
        row.pass === undefined ? fieldReading(undefined) : row.pass ? "pass" : "fail"
      }${row.details === undefined ? "" : ` · ${row.details}`}`,
    }));
  }
  if (viewId === "fleet") {
    return data.fleetRows.map((row) => ({
      id: row.id,
      time: fieldReading(row.lastEventTime),
      state: "neutral" as const,
      text: `${row.adapter} · ${row.model} · dispatches ${
        fieldReading(row.dispatches)
      }`,
    }));
  }
  return [];
}

/** A task's recorded state read as the component vocabulary the rows draw in. */
function taskRowState(state: TaskRow["state"]): JournalRow["state"] {
  if (state === "done") return "pass";
  if (state === "failed") return "fail";
  if (state === "running" || state === "human") return "active";
  return "neutral";
}

function windowedRows(
  rows: readonly JournalRow[],
  bodyRows: number,
  selection: string | null,
): { readonly rows: readonly JournalRow[]; readonly selection?: number } {
  const limit = Math.max(0, Math.floor(bodyRows));
  const selectedIndex = selection === null
    ? -1
    : rows.findIndex((row) => row.id === selection);
  const offset = selectedIndex < limit
    ? 0
    : selectedIndex - limit + 1;
  return {
    rows: rows.slice(offset, offset + limit),
    ...(selectedIndex < 0 ? {} : { selection: selectedIndex - offset }),
  };
}

function SizedJournalPanel({
  rows,
  bodyRows,
  title,
  selection,
  focused,
}: {
  rows: readonly JournalRow[];
  bodyRows: number;
  title?: string;
  selection: string | null;
  focused?: boolean;
}): ReactElement {
  const window = windowedRows(rows, bodyRows, selection);
  const emptyRows = Math.max(0, bodyRows - window.rows.length);
  const journal = JournalRowPanel({
    rows: window.rows,
    title,
    selection: window.selection,
    focused,
  });
  const journalProps = journal.props as { readonly children?: ReactNode };
  return cloneElement(
    journal,
    {},
    journalProps.children,
    emptyRows > 0 ? <Box key="journal-space" height={emptyRows} /> : null,
  );
}

/** A body panel (help overlay, opened event) padded to the journal's rows. */
function SizedLinesPanel({
  title,
  lines,
  bodyRows,
  wrapColumns,
  focused,
  flexGrow,
}: {
  title: string;
  lines: readonly string[];
  bodyRows: number;
  wrapColumns?: number;
  focused?: boolean;
  flexGrow?: number;
}): ReactElement {
  const drawnLines = wrapColumns === undefined
    ? lines
    : lines.flatMap((line) => composeBandLine(line, wrapColumns));
  const visible = drawnLines.slice(0, bodyRows);
  const emptyRows = Math.max(0, bodyRows - visible.length);
  return (
    <Panel title={title} focused={focused} flexGrow={flexGrow}>
      {visible.map((line, index) => (
        <Box key={`${index}:${line}`} height={1} overflow="hidden">
          <BodyText>{line}</BodyText>
        </Box>
      ))}
      {emptyRows > 0 && <Box height={emptyRows} />}
    </Panel>
  );
}

/** The lines the help overlay draws: every advertised key and its promise. */
function helpLines(entries: readonly KeybarEntry[]): readonly string[] {
  return entries.map(({ key, label }) => `${key} ${label}`);
}

/** The lines the opened-event view draws for one journal row. */
function eventLines(row: JournalRow): readonly string[] {
  return [`${row.time} · ${row.state}`, row.text];
}

/**
 * A view drawn from the rows its own derivation produces: its detail while the
 * opened row stands, its genuinely empty state when the derivation yields
 * nothing, otherwise a window over the rows marked at the selection. The state
 * arrives already repaired by the frame, which owns both it and the data.
 */
function RunViewPanel({
  data,
  viewId,
  interaction,
  focused,
  keyEntries,
  bodyRows,
  bodyColumns,
}: {
  data: RunCockpitData;
  viewId: Exclude<RunViewId, "run">;
  interaction: RunInteractionState;
  focused: boolean;
  keyEntries: readonly KeybarEntry[];
  bodyRows: number;
  bodyColumns: number;
}): ReactElement {
  const view = runViewById(viewId);
  const rows = deriveRunViewRows(data, viewId, interaction.filterQuery);
  if (interaction.help) {
    return (
      <Panel title="HELP" focused={focused} flexGrow={1}>
        {helpLines(keyEntries).map((line) => <BodyText key={line}>{line}</BodyText>)}
      </Panel>
    );
  }
  const opened = interaction.opened === null
    ? undefined
    : rows.find((row) => row.id === interaction.opened);
  if (opened !== undefined) {
    return (
      <SizedLinesPanel
        title={view.detailTitle}
        lines={eventLines(opened)}
        bodyRows={bodyRows}
        wrapColumns={bodyColumns}
        focused={focused}
        flexGrow={1}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <Panel title={view.title} focused={focused} flexGrow={1}>
        <BodyText emphasis="dim">No {view.id} in this engagement</BodyText>
      </Panel>
    );
  }
  return (
    <SizedJournalPanel
      rows={rows}
      bodyRows={bodyRows}
      title={interaction.filterPrompt
        ? `${view.title} /${interaction.filterQuery}`
        : view.title}
      selection={interaction.selection}
      focused={focused}
    />
  );
}

/**
 * What the journal's slot of the RUN panel draws under an interaction state:
 * the help overlay while ? is up, otherwise the passive overview tail. Row
 * selection, filtering and detail live only on the Journal view above.
 */
function JournalBody({
  data,
  interaction,
  bodyRows,
  keyEntries,
}: {
  data: RunCockpitData;
  interaction?: RunInteractionState;
  bodyRows: number;
  keyEntries: readonly KeybarEntry[];
}): ReactElement {
  const rows = deriveRunViewRows(data, "journal");
  if (interaction?.help === true) {
    return (
      <SizedLinesPanel
        title="HELP"
        lines={helpLines(keyEntries)}
        bodyRows={bodyRows}
      />
    );
  }
  return (
    <SizedJournalPanel
      rows={rows}
      bodyRows={bodyRows}
      selection={null}
    />
  );
}

function RunStats({
  data,
  mode,
}: {
  data: RunCockpitData;
  mode: FrameCockpitLayout["stats"]["mode"] | "none";
}): ReactElement {
  if (mode === "none") return <></>;
  if (mode === "summary") {
    return (
      <BodyText>
        {`tasks ${data.tasks.done}/${data.tasks.total} · gates ${data.gates.passed}/${data.gates.total} · pass ${data.passRate.value}%`}
      </BodyText>
    );
  }
  return (
    <CockpitGrid>
      <StatTile
        label="TASKS"
        value={`${data.tasks.done}/${data.tasks.total}`}
        samples={data.tasks.samples}
      />
      <StatTile
        label="GATES"
        value={`${data.gates.passed}/${data.gates.total}`}
        samples={data.gates.samples}
      />
      <StatTile
        label="PASS RATE"
        value={`${data.passRate.value}%`}
        samples={data.passRate.samples}
      />
    </CockpitGrid>
  );
}

/** The sparkline's block ramp, one glyph per trailing sample, newest last. */
const COMPACT_SPARK_BLOCKS = "▁▂▃▄▅▆▇█";

function compactSparkline(
  samples: readonly (number | null)[],
  cells: number,
): string {
  const buckets = samples.slice(-Math.max(0, cells));
  const populated = buckets.filter(
    (sample): sample is number => typeof sample === "number" && Number.isFinite(sample),
  );
  const minimum = populated.length > 0 ? Math.min(...populated) : 0;
  const maximum = populated.length > 0 ? Math.max(...populated) : 0;
  let glyphs = "";
  for (const sample of buckets) {
    if (sample === null) {
      glyphs += " ";
      continue;
    }
    const level = maximum === minimum
      ? COMPACT_SPARK_BLOCKS.length - 1
      : Math.round(
        ((sample - minimum) / (maximum - minimum))
          * (COMPACT_SPARK_BLOCKS.length - 1),
      );
    glyphs += COMPACT_SPARK_BLOCKS[level];
  }
  return glyphs;
}

/**
 * One vitals element of the sidebar's block, drawn whole: the plan has already
 * decided which elements draw and in which mode, so nothing here measures or
 * surrenders. The full form is a count row over a sparkline row (the meter: its
 * label over its bar); the compact form is one inline row per element.
 */
function RailVitals({
  data,
  columns,
  mode,
  elements,
}: {
  data: RunCockpitData;
  columns: number;
  mode: SidebarPlan["vitalsMode"];
  elements: readonly SidebarVitalsElement[];
}): ReactElement {
  const figures = {
    tasks: {
      value: `${data.tasks.done}/${data.tasks.total}`,
      samples: data.tasks.samples,
    },
    gates: {
      value: `${data.gates.passed}/${data.gates.total}`,
      samples: data.gates.samples,
    },
  } as const;
  const figure = (element: "tasks" | "gates"): ReactElement => {
    const reading = figures[element];
    if (mode === "compact") {
      const lead = `${element} ${reading.value} `;
      return (
        <Box key={element} height={1} flexShrink={0} overflow="hidden">
          <BodyText emphasis="strong">
            {fitCells(
              `${lead}${compactSparkline(reading.samples, columns - cellWidth(lead))}`,
              columns,
            )}
          </BodyText>
        </Box>
      );
    }
    return (
      <Box key={element} flexDirection="column" flexShrink={0}>
        <Box height={1} flexShrink={0} overflow="hidden">
          <BodyText emphasis="strong">
            {fitCells(`${element} ${reading.value}`, columns)}
          </BodyText>
        </Box>
        <Sparkline samples={reading.samples} />
      </Box>
    );
  };
  const meter = mode === "compact"
    ? (
      <Box key="meter" height={1} flexDirection="row" flexWrap="nowrap" flexShrink={0} overflow="hidden">
        <BodyText emphasis="strong">pass </BodyText>
        <ProgressMeter value={data.passRate.value} width={Math.max(1, columns - 9)} />
      </Box>
    )
    : (
      <Box key="meter" flexDirection="column" flexShrink={0}>
        <Box height={1} flexShrink={0} overflow="hidden">
          <BodyText emphasis="strong">{fitCells("pass", columns)}</BodyText>
        </Box>
        <Box height={1} flexShrink={0} overflow="hidden">
          <ProgressMeter value={data.passRate.value} width={Math.max(1, columns - 6)} />
        </Box>
      </Box>
    );
  return (
    <Box flexDirection="column" width={columns} flexShrink={0} overflow="hidden">
      {elements.map((element) => (element === "meter" ? meter : figure(element)))}
    </Box>
  );
}

/**
 * The navigation rail, unboxed, drawn at the composition the plan computed:
 * the menu at the top, the vitals anchored to the bottom, and the planned gap
 * of blank rows between them — the gap is planFrame's, never a spacing hack
 * applied here.
 */
function RailBand({
  data,
  focused,
  selection,
  columns,
  rows,
  sidebar,
}: {
  data: RunCockpitData;
  focused: boolean;
  selection: number;
  columns: number;
  /** The rail region's planned span. */
  rows: number;
  /** The rail's planned composition: menu, gap and vitals, consumed unmodified. */
  sidebar: SidebarPlan;
}): ReactElement {
  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      {sidebar.menuRows > RUN_VIEWS.length && (
        <Box height={1} flexShrink={0} overflow="hidden">
          <BodyText emphasis="strong">
            {fitCells(focused ? `${GLYPHS.pointer} VIEWS` : "VIEWS", columns)}
          </BodyText>
        </Box>
      )}
      {RUN_VIEWS.map((view, index) => (
        <Box key={view.id} height={1} flexShrink={0} overflow="hidden">
          <BodyText emphasis={index === selection ? "strong" : "normal"}>
            {fitCells(
              `${index === selection ? GLYPHS.pointer : " "} ${view.label}`,
              columns,
            )}
          </BodyText>
        </Box>
      ))}
      {sidebar.gapRows > 0 && <Box height={sidebar.gapRows} flexShrink={0} />}
      <RailVitals
        data={data}
        columns={columns}
        mode={sidebar.vitalsMode}
        elements={sidebar.vitals}
      />
    </Box>
  );
}

/** The setup tab's rail, drawn unboxed in the same planned columns. */
function SectionsBand({
  focused,
  selection,
  columns,
}: {
  focused: boolean;
  selection: number;
  columns: number;
}): ReactElement {
  return (
    <Box flexDirection="column" width={columns} overflow="hidden">
      <Box height={1} overflow="hidden">
        <BodyText emphasis="strong">
          {fitCells(focused ? `${GLYPHS.pointer} SECTIONS` : "SECTIONS", columns)}
        </BodyText>
      </Box>
      {SETUP_SECTIONS.map((section, index) => (
        <Box key={section.id} height={1} overflow="hidden">
          <BodyText emphasis={index === selection ? "strong" : "normal"}>
            {fitCells(
              `${index === selection ? GLYPHS.pointer : " "} ${section.label}`,
              columns,
            )}
          </BodyText>
        </Box>
      ))}
    </Box>
  );
}

/** A planned rule band: one row of the region edge glyph, exactly `columns` wide. */
function RuleBand({ columns }: { columns: number }): ReactElement {
  return (
    <Box height={1} overflow="hidden">
      <BodyText emphasis="dim">{"─".repeat(Math.max(0, columns))}</BodyText>
    </Box>
  );
}

/** The strip the plan draws instead of a rail between 40 and 63 columns: the five views on one row. */
function ViewStrip({
  selection,
  columns,
}: {
  selection: number;
  columns: number;
}): ReactElement {
  return (
    <Box width={columns} height={1} flexDirection="row" flexWrap="nowrap" overflow="hidden">
      {RUN_VIEWS.map((view, index) => (
        <Box key={view.id} flexShrink={0}>
          <BodyText>
            {index === selection ? `${GLYPHS.pointer}${view.label}` : ` ${view.label}`}
            {index === RUN_VIEWS.length - 1 ? "" : " "}
          </BodyText>
        </Box>
      ))}
    </Box>
  );
}

/** The journal tail band: it draws exactly the rows the plan left it, surrendered whole by tier. */
function TailBand({
  data,
  rows,
  columns,
  pendingWrites,
}: {
  data: RunCockpitData;
  rows: number;
  columns: number;
  pendingWrites: boolean;
}): ReactElement {
  const lines = pendingWrites
    ? ["PENDING WRITES · none"]
    : deriveRunViewRows(data, "journal")
      .slice(-rows)
      .map((row) => `${row.time} ${row.text}`);
  // A styled blank cell differs with colour on and off; these rows carry no dim style.
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {Array.from({ length: rows }, (_, index) => (
        <Box key={index} height={1} overflow="hidden">
          <BodyText>{fitCells(lines[index] ?? "", columns)}</BodyText>
        </Box>
      ))}
    </Box>
  );
}

function ApprovedProgress({
  data,
  caption,
}: {
  data: RunCockpitData;
  caption: boolean;
}): ReactElement {
  return (
    <Panel title="PROGRESS">
      <ProgressMeter value={data.progress} width={28} />
      {caption && <BodyText emphasis="dim">{data.progressCaption}</BodyText>}
    </Panel>
  );
}

function CompactProgress({
  data,
  caption,
  meterWidth = 28,
}: {
  data: RunCockpitData;
  caption: boolean;
  meterWidth?: number;
}): ReactElement {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="nowrap">
        <BodyText emphasis="strong">PROGRESS </BodyText>
        <ProgressMeter value={data.progress} width={meterWidth} />
      </Box>
      {caption && <BodyText emphasis="dim">{data.progressCaption}</BodyText>}
    </Box>
  );
}

/* Draw-time content resolution: every budget is a planned span minus the drawn band's chrome. */

/** What each drawn region draws: the resolved budgets its panels consume. */
export type RegionContent = {
  readonly body: number;
  readonly journal: number;
  readonly bodyColumns: number;
  readonly sideRails: boolean;
  readonly stats: FrameCockpitLayout["stats"]["mode"] | "none";
  readonly progressBar: boolean;
  readonly progressCaption: boolean;
  readonly approvedProgress: boolean;
};

/** The RUN view's interior, allocated out of the planned body span, each element granted whole or not at all. */
function resolveRunViewContent(
  bodySpan: number,
  bodyColumns: number,
  data: RunCockpitData,
): Pick<
  RegionContent,
  "journal" | "stats" | "progressBar" | "progressCaption" | "approvedProgress"
> {
  const interior = Math.max(0, bodySpan - PANEL_CHROME_ROWS);
  let available = interior;
  const progressBar = available >= 1;
  if (progressBar) available -= 1;
  // Every element is granted whole or not at all, and the summary reports the fit decision it computed.
  let journal = 0;
  if (available >= PANEL_CHROME_ROWS + 1) {
    journal = 1;
    available -= PANEL_CHROME_ROWS + 1;
  }
  const summary = available >= 1;
  if (summary) available -= 1;
  const tail = journal > 0
    ? Math.min(available, Math.max(0, FULL_JOURNAL_ROWS - journal))
    : 0;
  journal += tail;
  available -= tail;
  const captionRows = progressBar
    ? wrapCells(data.progressCaption, Math.max(1, bodyColumns)).length
    : 0;
  const progressCaption = captionRows > 0 && available >= captionRows;
  if (progressCaption) available -= captionRows;
  // The tiles are retired into the rail's unboxed vitals; the summary line is the only stats form drawn.
  if (journal > 0) journal += available;
  // Restored only once every element is full and the journal can pay the chrome rows.
  const approvedProgress = progressBar && progressCaption
    && journal > PANEL_CHROME_ROWS;
  if (approvedProgress) journal -= PANEL_CHROME_ROWS;
  return {
    journal,
    stats: summary ? "summary" : "none",
    progressBar,
    progressCaption,
    approvedProgress,
  };
}

/** What fills the regions this paint draws, resolved from the plan's own spans. */
function resolveRegionContent(
  plan: PlannedFrame,
  data: RunCockpitData,
  interaction: RunInteractionState,
): RegionContent {
  const bodyRegion = requiredRegion(plan, "body");
  const bodySpan = bodyRegion.rows;
  const sideRails = plan.band === "sidebar";
  const body = Math.max(1, bodySpan - PANEL_CHROME_ROWS);
  const bodyColumns = Math.max(
    1,
    bodyRegion.columns - RUN_PANEL_HORIZONTAL_CHROME,
  );
  const common = { body, bodyColumns, sideRails } as const;

  if (interaction.tab !== "setup" && interaction.activeView === "run") {
    return {
      ...common,
      // The help overlay stands in for the journal tail, drawing into its whole interior.
      ...(interaction.help
        ? {
          journal: Math.max(1, bodySpan - PANEL_CHROME_ROWS * 2),
          stats: "summary" as const,
          progressBar: false,
          progressCaption: false,
          approvedProgress: false,
        }
        : resolveRunViewContent(bodySpan, bodyColumns, data)),
    };
  }
  return {
    ...common,
    journal: 0,
    stats: "summary",
    progressBar: false,
    progressCaption: false,
    approvedProgress: false,
  };
}

/** The RUN view drawn at its planned spans: every row budget arrives resolved. */
function LadderRunPanel({
  data,
  content,
  compactMeterWidth,
  interaction,
  keyEntries,
  focused = true,
}: {
  data: RunCockpitData;
  content: RegionContent;
  compactMeterWidth?: number;
  interaction?: RunInteractionState;
  keyEntries: readonly KeybarEntry[];
  focused?: boolean;
}): ReactElement {
  if (interaction?.help === true) {
    return (
      <SizedLinesPanel
        title="HELP"
        lines={helpLines(keyEntries)}
        bodyRows={content.body}
        wrapColumns={content.bodyColumns}
        focused={focused}
        flexGrow={1}
      />
    );
  }
  return (
    <Panel title="RUN" focused={focused} flexGrow={1}>
      <RunStats data={data} mode={content.stats} />
      {content.progressBar && (
        content.approvedProgress
          ? <ApprovedProgress data={data} caption={content.progressCaption} />
          : (
            <CompactProgress
              data={data}
              caption={content.progressCaption}
              meterWidth={compactMeterWidth}
            />
          )
      )}
      {content.journal > 0 && (
        <JournalBody
          data={data}
          interaction={interaction}
          bodyRows={content.journal}
          keyEntries={keyEntries}
        />
      )}
    </Panel>
  );
}

function LegacyRunPanel({
  data,
  interaction,
  keyEntries,
  focused = true,
}: {
  data: RunCockpitData;
  interaction?: RunInteractionState;
  keyEntries: readonly KeybarEntry[];
  focused?: boolean;
}): ReactElement {
  const rows = deriveRunViewRows(data, "journal");
  return (
    <Panel title="RUN" focused={focused} flexGrow={1}>
      <RunStats data={data} mode="tiles" />
      <Panel title="PROGRESS">
        <ProgressMeter value={data.progress} width={28} />
        <BodyText emphasis="dim">{data.progressCaption}</BodyText>
      </Panel>
      <JournalBody
        data={data}
        interaction={interaction}
        bodyRows={rows.length}
        keyEntries={keyEntries}
      />
    </Panel>
  );
}

/** The ref for a planned region's node, stable per region so the guard can check the frame region by region. */
type RegionRef = (
  id: FrameRegion["id"],
) => (node: DOMElement | null) => void;

/**
 * One planned band, drawn at exactly the span the plan gives it. Unsized (the
 * legacy surface) it is whatever it contains.
 */
function FrameBand({
  rows,
  row = false,
  gap,
  regionRef,
  children,
}: {
  rows?: number;
  row?: boolean;
  gap?: number;
  regionRef?: (node: DOMElement | null) => void;
  children: ReactNode;
}): ReactElement {
  return (
    <Box
      ref={regionRef}
      flexDirection={row ? "row" : "column"}
      {...(gap === undefined ? {} : { gap })}
      {...(rows === undefined ? {} : { height: rows, flexShrink: 0 })}
      overflow="hidden"
    >
      {children}
    </Box>
  );
}

/** A sized sub-floor plan draws the plain fallback, clipped to the measured size. */
function PlainFallbackPaint({
  data,
  size,
}: {
  data: RunCockpitData;
  size: MeasuredSize;
}): ReactElement {
  const columns = Math.max(1, size.columns);
  const lines = [
    `tickmarkr ${data.binaryVersion}`,
    `${data.runId} ${data.status} ${data.elapsed}`,
    ...data.statusItems.map((item) => item.text),
  ];
  return (
    <Box
      flexDirection="column"
      width={size.columns}
      height={Math.max(0, size.rows)}
      overflow="hidden"
    >
      {lines.map((line, index) => (
        <Box key={`${index}:${line}`} height={1} flexShrink={0} overflow="hidden">
          <BodyText>{fitCells(line, columns)}</BodyText>
        </Box>
      ))}
    </Box>
  );
}

/** The paint: every span is read off the plan's regions and every row budget off the resolved content. */
function RunCockpitPaint({
  data,
  columns,
  plan,
  content,
  interaction,
  keyProjection = projectRunKeyEntries,
  onRegion,
}: {
  data: RunCockpitData;
  columns: number;
  /** The plan this paint draws, absent only on the unsized legacy surface. */
  plan?: PlannedFrame;
  /** What fills the drawn regions, absent only on the unsized legacy surface. */
  content?: RegionContent;
  /**
   * The run surface's interaction state. Omitted — or at its initial value —
   * the frame is byte-identical to the pinned appearance; every transition a
   * binding makes is drawn from it.
   */
  interaction?: RunInteractionState;
  /** Testable seam for the one registry projection consumed by every roster. */
  keyProjection?: RunKeyProjection;
  /** Stable refs for the nodes the planned regions are drawn into. */
  onRegion?: RegionRef;
}): ReactElement {
  const suppliedInteraction = interaction ?? initialRunInteractionState();
  const suppliedRows = deriveRunViewRows(
    data,
    suppliedInteraction.activeView,
    suppliedInteraction.filterQuery,
  );
  const currentInteraction = reconcileRunInteraction(
    suppliedInteraction,
    suppliedRows.map((row) => row.id),
  );
  const focusOrder = runPanelFocusOrder(runKeyColumns(columns));
  const focus = currentInteraction.panel % focusOrder.length;
  const focusedPanel = focusOrder[focus] ?? "CONTENT";
  const contentFocused = focusedPanel === "CONTENT";
  const activeView = currentInteraction.activeView;
  const railSelection = currentInteraction.railSelection;
  const keyEntries = keyProjection({
    interaction: currentInteraction,
    columns: runKeyColumns(columns),
    // What the keybar promises is what a key can actually stand on: the journal
    // tail owns no selectable row, so it advertises no row key.
    rowIds: selectableRunViewRowIds(
      currentInteraction.activeView,
      suppliedRows.map((row) => row.id),
    ),
  });
  // Follow mode reports its on state as a status-strip item carrying the
  // brand's reserved active-toggle glyph; off it draws nothing, so the pinned
  // frame is untouched.
  const interactionStatusItems = [
    ...(currentInteraction.quit
      ? [{ state: "active" as const, text: "Quit requested" }]
      : []),
    ...(currentInteraction.follow
      ? [{ state: "active" as const, text: "Follow" }]
      : []),
  ];
  const reportedStatusItems = [...interactionStatusItems, ...data.statusItems];
  const regionRef = (id: FrameRegion["id"]) => onRegion?.(id);
  const railFocused = focusedPanel === "VIEWS";
  if (plan === undefined || content === undefined) {
    return (
      <Box flexDirection="column" width={columns} overflow="hidden">
        <IdentityHeader data={data} columns={columns} />
        <Box flexDirection="row" gap={1}>
          <NavigationPanel focused={railFocused} selection={railSelection} />
          {activeView === "run"
            ? (
              <LegacyRunPanel
                data={data}
                interaction={currentInteraction}
                keyEntries={keyEntries}
                focused={contentFocused}
              />
            )
            : (
              <RunViewPanel
                data={data}
                viewId={activeView}
                interaction={currentInteraction}
                focused={contentFocused}
                keyEntries={keyEntries}
                bodyRows={Math.max(
                  1,
                  currentInteraction.help
                    ? keyEntries.length
                    : suppliedRows.length,
                )}
                bodyColumns={runViewBodyColumns(columns, true, false)}
              />
            )}
        </Box>
        <StatusStrip items={reportedStatusItems} width={columns} />
        <RunKeybar
          entries={keyEntries}
          width={columns}
          help={currentInteraction.help}
        />
      </Box>
    );
  }
  // Every region the plan places, drawn at the plan's own offset and span.
  const region = (id: FrameRegion["id"]) =>
    plan.regions.find((candidate) => candidate.id === id);
  const header = requiredRegion(plan, "header");
  const body = requiredRegion(plan, "body");
  const caption = region("caption");
  const strip = region("strip");
  const rail = region("rail");
  const tail = region("tail");
  const setup = currentInteraction.tab === "setup";
  return (
    <Box
      flexDirection="column"
      width={plan.size.columns}
      height={plan.size.rows}
      overflow="hidden"
    >
      <FrameBand rows={header.rows} row regionRef={regionRef("header")}>
        <Box
          flexGrow={1}
          flexShrink={1}
          height={header.rows}
          overflow="hidden"
        >
          <PlannedHeader
            data={data}
            plan={plan}
            columns={plan.size.columns - (caption?.columns ?? 0)}
          />
        </Box>
        {caption !== undefined && (
          <Box
            ref={regionRef("caption")}
            width={caption.columns}
            height={caption.rows}
            flexShrink={0}
            overflow="hidden"
          >
            <PlannedCaption data={data} columns={caption.columns} />
          </Box>
        )}
      </FrameBand>
      <FrameBand rows={requiredRegion(plan, "rule").rows} regionRef={regionRef("rule")}>
        <RuleBand columns={plan.size.columns} />
      </FrameBand>
      {strip !== undefined && (
        <FrameBand rows={strip.rows} regionRef={regionRef("strip")}>
          <ViewStrip selection={railSelection} columns={strip.columns} />
        </FrameBand>
      )}
      <FrameBand rows={body.rows} row>
        {rail !== undefined && (
          <Box
            ref={regionRef("rail")}
            width={rail.columns}
            height={rail.rows}
            flexShrink={0}
            overflow="hidden"
          >
            {setup
              ? (
                <SectionsBand
                  focused={railFocused}
                  selection={railSelection}
                  columns={rail.columns}
                />
              )
              : (
                <RailBand
                  data={data}
                  focused={railFocused}
                  selection={railSelection}
                  columns={rail.columns}
                  rows={rail.rows}
                  sidebar={plan.sidebar!}
                />
              )}
          </Box>
        )}
        <Box
          ref={regionRef("body")}
          width={body.columns}
          height={body.rows}
          flexShrink={0}
          flexDirection="column"
          overflow="hidden"
        >
          {setup
            ? (
              <SetupTabPanel
                data={data}
                selection={railSelection}
                focused={contentFocused}
                keyEntries={keyEntries}
                help={currentInteraction.help}
                bodyRows={content.body}
                bodyColumns={content.bodyColumns}
              />
            )
            : activeView === "run"
            ? (
              <LadderRunPanel
                data={data}
                content={content}
                compactMeterWidth={content.sideRails ? undefined : 24}
                interaction={currentInteraction}
                keyEntries={keyEntries}
                focused={contentFocused}
              />
            )
            : (
              <RunViewPanel
                data={data}
                viewId={activeView}
                interaction={currentInteraction}
                focused={contentFocused}
                keyEntries={keyEntries}
                bodyRows={content.body}
                bodyColumns={content.bodyColumns}
              />
            )}
        </Box>
      </FrameBand>
      <FrameBand rows={requiredRegion(plan, "rule2").rows} regionRef={regionRef("rule2")}>
        <RuleBand columns={plan.size.columns} />
      </FrameBand>
      {tail !== undefined && (
        <FrameBand rows={tail.rows} regionRef={regionRef("tail")}>
          <TailBand
            data={data}
            rows={tail.rows}
            columns={tail.columns}
            pendingWrites={plan.content.tail === "pending-writes"}
          />
        </FrameBand>
      )}
      <FrameBand rows={requiredRegion(plan, "status").rows} regionRef={regionRef("status")}>
        <StatusStrip items={reportedStatusItems} width={plan.size.columns} />
      </FrameBand>
      <FrameBand rows={requiredRegion(plan, "keybar").rows} regionRef={regionRef("keybar")}>
        <RunKeybar
          entries={keyEntries}
          width={plan.size.columns}
          help={currentInteraction.help}
        />
      </FrameBand>
    </Box>
  );
}


export type PlannedRunCockpitFrame = {
  readonly plan: FramePlan;
  readonly columns: number;
  readonly rows?: number;
  /** What fills the drawn regions; absent on the unsized legacy surface. */
  readonly content?: RegionContent;
  /** The inputs planFrame planned from, so the guard can re-plan and refuse
   * a span that moved after planning. */
  readonly planning?: {
    readonly size: MeasuredSize;
    readonly view: FrameView;
    readonly state: FrameState;
  };
  readonly interaction: RunInteractionState;
  readonly keyEntries: readonly KeybarEntry[];
};

/** Resolve every draw-time input; the plan is planFrame's own return, consumed unmodified. */
export function planRunCockpitFrame({
  data,
  columns,
  rows,
  interaction,
  keyProjection = projectRunKeyEntries,
}: {
  data: RunCockpitData;
  columns: number;
  rows?: number;
  interaction?: RunInteractionState;
  keyProjection?: RunKeyProjection;
}): PlannedRunCockpitFrame {
  const suppliedInteraction = interaction ?? initialRunInteractionState();
  const suppliedRows = deriveRunViewRows(
    data,
    suppliedInteraction.activeView,
    suppliedInteraction.filterQuery,
  );
  const rowIds = suppliedRows.map((row) => row.id);
  const repaired = reconcileRunInteraction(suppliedInteraction, rowIds);
  const keyEntries = keyProjection({
    interaction: repaired,
    columns: runKeyColumns(columns),
    rowIds: selectableRunViewRowIds(repaired.activeView, rowIds),
  });
  const size: MeasuredSize = { columns, rows: rows ?? 1 };
  const view: FrameView = repaired.activeView;
  const state: FrameState = {
    tab: repaired.tab,
    detail: repaired.opened !== null,
    captionCells: cellWidth(frameCaption(data)),
  };
  const plan = planFrame(size, view, state);
  const content = rows === undefined || plan.kind !== "frame"
    ? undefined
    : resolveRegionContent(plan, data, repaired);
  return {
    plan,
    columns,
    rows,
    content,
    planning: rows === undefined || plan.kind !== "frame"
      ? undefined
      : { size, view, state },
    interaction: repaired,
    keyEntries,
  };
}

/** The public surface always enters paint through one measured plan. */
export function RunCockpitFrame({
  data,
  columns,
  rows,
  interaction,
  keyProjection = projectRunKeyEntries,
}: {
  data: RunCockpitData;
  columns: number;
  rows?: number;
  interaction?: RunInteractionState;
  keyProjection?: RunKeyProjection;
}): ReactElement {
  const plannedFrame = useMemo(
    () =>
      planRunCockpitFrame({
        data,
        columns,
        rows,
        interaction,
        keyProjection,
      }),
    [data, columns, rows, interaction, keyProjection],
  );
  return (
    <RunCockpitFrameFromPlan
      data={data}
      plannedFrame={plannedFrame}
    />
  );
}

function requiredRegion(plan: PlannedFrame, id: FrameRegion["id"]): FrameRegion {
  const region = plan.regions.find((candidate) => candidate.id === id);
  if (region === undefined) throw new Error(`planned region ${id} is missing`);
  return region;
}

function optionalRegion(
  plan: PlannedFrame,
  id: FrameRegion["id"],
): FrameRegion | undefined {
  return plan.regions.find((candidate) => candidate.id === id);
}

function assertPlanSpans(plan: PlannedFrame): void {
  let nextRow = 0;
  for (const [id, span] of Object.entries(plan.rowSpans)) {
    const region = requiredRegion(plan, id as FrameRegion["id"]);
    const fullWidth = id !== "body";
    if (
      region.row !== nextRow ||
      region.rows !== span ||
      (fullWidth && (region.column !== 0 || region.columns !== plan.size.columns))
    ) {
      throw new Error(
        `planned row region ${id} has offset/span ${region.row}/${region.rows}, expected ${nextRow}/${span}`,
      );
    }
    nextRow += span;
  }
  if (nextRow !== plan.size.rows) {
    throw new Error(`planned row spans total ${nextRow}, expected ${plan.size.rows}`);
  }

  let nextColumn = 0;
  for (const [id, span] of Object.entries(plan.columnSpans)) {
    const region = requiredRegion(plan, id as FrameRegion["id"]);
    if (region.column !== nextColumn || region.columns !== span) {
      throw new Error(
        `planned column region ${id} has offset/span ${region.column}/${region.columns}, expected ${nextColumn}/${span}`,
      );
    }
    nextColumn += span;
  }
  if (nextColumn !== plan.size.columns) {
    throw new Error(
      `planned column spans total ${nextColumn}, expected ${plan.size.columns}`,
    );
  }

  const body = requiredRegion(plan, "body");
  const rail = optionalRegion(plan, "rail");
  if (rail !== undefined && (rail.row !== body.row || rail.rows !== body.rows)) {
    throw new Error("planned rail region does not share the body row span");
  }
  const caption = optionalRegion(plan, "caption");
  if (caption !== undefined) {
    const header = requiredRegion(plan, "header");
    if (
      caption.row !== header.row ||
      caption.rows !== header.rows ||
      caption.column + caption.columns !== header.column + header.columns
    ) {
      throw new Error("planned caption region does not refine the header span");
    }
  }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/gu;

/** The rows the renderer drew, Ink's transport framing removed: the shipped path appends a newline of its own. */
function drawnRows(drawnFrame: string, plannedRows: number): readonly string[] {
  const rows = drawnFrame.replace(ANSI, "").split("\n");
  return rows.length === plannedRows + 1 && rows.at(-1) === ""
    ? rows.slice(0, -1)
    : rows;
}

/**
 * Assert the plan's tiled extents, the bytes production paints, and — given
 * the offsets read off the painted nodes — that every planned region was
 * drawn where the plan puts it.
 */
export function assertFrameConformance(
  plan: PlannedFrame,
  drawnFrame: string,
  drawnRegions?: readonly FrameRegion[],
): void {
  assertPlanSpans(plan);
  const lines = drawnRows(drawnFrame, plan.size.rows);
  if (lines.length !== plan.size.rows) {
    throw new Error(
      `drawn frame has ${lines.length} rows, planned ${plan.size.rows} for ${plan.tab}/${plan.view} at ${plan.size.columns} columns`,
    );
  }
  for (const [index, line] of lines.entries()) {
    if (cellWidth(line) > plan.size.columns) {
      throw new Error(
        `drawn frame row ${index} has ${cellWidth(line)} cells, exceeding planned span ${plan.size.columns} for ${plan.tab}/${plan.view}: ${JSON.stringify(line)}`,
      );
    }
  }
  if (drawnRegions === undefined) return;
  // Every planned region is located in the drawn frame, so a redistribution
  // that keeps the plan tiled at unchanged height still fails here.
  for (const region of plan.regions) {
    const drawn = drawnRegions.find((candidate) => candidate.id === region.id);
    if (drawn === undefined) {
      throw new Error(
        `drawn frame has no region ${region.id}; planned row ${region.row} span ${region.rows} column ${region.column} span ${region.columns} for ${plan.tab}/${plan.view}`,
      );
    }
    if (
      drawn.row !== region.row ||
      drawn.rows !== region.rows ||
      drawn.column !== region.column ||
      drawn.columns !== region.columns
    ) {
      throw new Error(
        `drawn region ${region.id} is at row ${drawn.row} span ${drawn.rows} column ${drawn.column} span ${drawn.columns}, planned row ${region.row} span ${region.rows} column ${region.column} span ${region.columns} for ${plan.tab}/${plan.view} at ${plan.size.columns} columns`,
      );
    }
  }
}

/** The offsets and spans the renderer actually drew, read off the painted nodes' computed layout. */
function measuredDrawnRegions(
  nodes: ReadonlyMap<FrameRegion["id"], DOMElement>,
): FrameRegion[] {
  return [...nodes.entries()].map(([id, node]) => {
    let row = 0;
    let column = 0;
    for (
      let current: DOMElement | undefined = node;
      current?.parentNode !== undefined;
      current = current.parentNode
    ) {
      row += current.yogaNode?.getComputedTop() ?? 0;
      column += current.yogaNode?.getComputedLeft() ?? 0;
    }
    return {
      id,
      row: Math.round(row),
      rows: Math.round(node.yogaNode?.getComputedHeight() ?? 0),
      column: Math.round(column),
      columns: Math.round(node.yogaNode?.getComputedWidth() ?? 0),
    };
  });
}

/** The plan's regions measured off the painted nodes; a planned region with no painted node is a refusal. */
function drawnPlannedRegions(
  plan: PlannedFrame,
  nodes: ReadonlyMap<FrameRegion["id"], DOMElement>,
): readonly FrameRegion[] {
  const missing = plan.regions
    .filter((region) => !nodes.has(region.id))
    .map((region) => region.id);
  if (missing.length > 0) {
    throw new Error(
      `drawn frame registered no node for planned region(s) ${String(missing)} for ${plan.tab}/${plan.view} at ${plan.size.columns} columns`,
    );
  }
  return measuredDrawnRegions(nodes);
}

/** planFrame's own regions for the inputs the plan was planned from, so a moved span is a refusal. */
function authoritativeRegions(
  planning: NonNullable<PlannedRunCockpitFrame["planning"]>,
): readonly FrameRegion[] | undefined {
  const authoritative = planFrame(planning.size, planning.view, planning.state);
  return authoritative.kind === "frame" ? authoritative.regions : undefined;
}

/** Production paint consumes only resolved plan inputs and fails closed with
 * the same conformance assertion the acceptance suite runs. */
export function RunCockpitFrameFromPlan({
  data,
  plannedFrame,
}: {
  data: RunCockpitData;
  plannedFrame: PlannedRunCockpitFrame;
}): ReactElement {
  if (plannedFrame.plan.kind === "frame") {
    assertPlanSpans(plannedFrame.plan);
  }
  const { stdout } = useStdout();
  const { exit } = useApp();
  const regionNodes = useRef(new Map<FrameRegion["id"], DOMElement>());
  const regionRefCallbacks = useRef(
    new Map<FrameRegion["id"], (node: DOMElement | null) => void>(),
  );
  useInsertionEffect(() => {
    const plan = plannedFrame.plan;
    if (plan.kind !== "frame" || plannedFrame.content === undefined) return;
    const originalWrite = stdout.write;
    const writeFrame = ((chunk: string | Uint8Array, ...args: unknown[]): boolean => {
      const bytes = typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString("utf8");
      if (bytes.replace(ANSI, "").trim().length === 0) {
        return Reflect.apply(originalWrite, stdout, [chunk, ...args]) as boolean;
      }
      // Byte spans refuse before the frame leaves; the region check measures the nodes its commit painted.
      try {
        assertFrameConformance(plan, bytes);
      } catch (error) {
        queueMicrotask(() => exit(error as Error));
        return true;
      }
      const planning = plannedFrame.planning;
      queueMicrotask(() => {
        try {
          if (planning !== undefined) {
            const planned = authoritativeRegions(planning);
            if (planned !== undefined) {
              assertFrameConformance(plan, bytes, planned);
            }
          }
          assertFrameConformance(
            plan,
            bytes,
            drawnPlannedRegions(plan, regionNodes.current),
          );
        } catch (error) {
          exit(error as Error);
        }
      });
      return Reflect.apply(originalWrite, stdout, [chunk, ...args]) as boolean;
    }) as typeof stdout.write;
    stdout.write = writeFrame;
    return () => {
      if (stdout.write === writeFrame) stdout.write = originalWrite;
    };
  }, [plannedFrame, stdout, exit]);

  if (plannedFrame.plan.kind === "plain" && plannedFrame.rows !== undefined) {
    return <PlainFallbackPaint data={data} size={plannedFrame.plan.size} />;
  }
  return (
    <RunCockpitPaint
      data={data}
      columns={plannedFrame.columns}
      plan={plannedFrame.plan.kind === "frame" ? plannedFrame.plan : undefined}
      content={plannedFrame.content}
      interaction={plannedFrame.interaction}
      keyProjection={() => plannedFrame.keyEntries}
      onRegion={(id) => {
        let callback = regionRefCallbacks.current.get(id);
        if (callback === undefined) {
          callback = (node) => {
            if (node === null) regionNodes.current.delete(id);
            else regionNodes.current.set(id, node);
          };
          regionRefCallbacks.current.set(id, callback);
        }
        return callback;
      }}
    />
  );
}
