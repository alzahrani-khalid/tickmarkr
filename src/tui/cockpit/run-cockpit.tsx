import { Box } from "ink";
import {
  cloneElement,
  type ReactElement,
  type ReactNode,
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
  KEYBAR_KEYS,
  Keybar,
  Panel,
  PANEL_CHROME_ROWS,
  ProgressMeter,
  StatTile,
  StatusStrip,
  type BandColumnContent,
  type JournalRow,
} from "./components.js";
import type { RunCockpitData } from "./derive.js";
import {
  RUN_PANEL_FOCUS_ORDER,
  RUN_KEY_BINDINGS,
  type RunInteractionState,
} from "./keys.js";
import {
  resolveCockpitLayout,
  type FrameCockpitLayout,
} from "./layout.js";
export { deriveRunCockpitData } from "./derive.js";
export type { RunCockpitData } from "./derive.js";
export { PANEL_CHROME_ROWS } from "./components.js";

const APPROVED_SIDE_RAIL_COLUMN_FLOOR = 80;
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
  if (columns < 1) return 1;
  let rows = 1;
  let used = 0;
  for (const [index, word] of text.split(" ").entries()) {
    // ponytail: code points, not display columns — every glyph the cockpit
    // draws is one column wide. Reach for a width table only if it stops being.
    const length = [...word].length;
    if (index !== 0) {
      if (used >= columns) {
        rows += 1;
        used = 0;
      }
      used += 1;
    }
    if (length > columns) {
      const startsThisLine = 1 + Math.floor((length - (columns - used) - 1) / columns);
      if (Math.floor((length - 1) / columns) < startsThisLine) {
        rows += 1;
        used = 0;
      }
      for (let taken = 0; taken < length; taken += 1) {
        if (used < columns) used += 1;
        else {
          rows += 1;
          used = 1;
        }
      }
      continue;
    }
    if (used > 0 && used + length > columns) {
      rows += 1;
      used = 0;
    }
    used += length;
  }
  return rows;
}

/** The rows a bordered panel occupies when its body wraps into `columns`. */
export function panelRows(
  lines: readonly string[],
  columns: number,
): number {
  return lines.reduce(
    (rows, line) => rows + composeBandLine(line, columns).length,
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
  if (columns < APPROVED_SIDE_RAIL_COLUMN_FLOOR) {
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

function NavigationPanel({ focused = false }: { focused?: boolean }): ReactElement {
  return (
    <Panel title="VIEWS" width={16} focused={focused}>
      <BodyText emphasis="strong">{GLYPHS.pointer} Run</BodyText>
      <BodyText>  Tasks</BodyText>
      <BodyText>  Gates</BodyText>
      <BodyText>  Journal</BodyText>
      <BodyText>  Fleet</BodyText>
    </Panel>
  );
}

function KeysPanel({ focused = false }: { focused?: boolean }): ReactElement {
  return (
    <Panel title="KEYS" width={16} focused={focused}>
      {KEYBAR_KEYS.run.map((item) => (
        <Box key={item.key}>
          <BodyText emphasis="strong">{item.key}</BodyText>
          <BodyText> {item.label}</BodyText>
        </Box>
      ))}
    </Panel>
  );
}

/** The journal rows an interaction state leaves visible. */
function visibleJournalRows(
  rows: readonly JournalRow[],
  interaction: RunInteractionState | undefined,
): readonly JournalRow[] {
  const query = interaction?.filterQuery.trim().toLowerCase() ?? "";
  if (query === "") return rows;
  return rows.filter((row) => row.text.toLowerCase().includes(query));
}

function SizedJournalPanel({
  rows,
  bodyRows,
  title,
  selection,
}: {
  rows: readonly JournalRow[];
  bodyRows: number;
  title?: string;
  selection?: number;
}): ReactElement {
  const visible = rows.slice(0, bodyRows);
  const emptyRows = Math.max(0, bodyRows - visible.length);
  const journal = JournalRowPanel({ rows: visible, title, selection });
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
}: {
  title: string;
  lines: readonly string[];
  bodyRows: number;
}): ReactElement {
  const visible = lines.slice(0, bodyRows);
  const emptyRows = Math.max(0, bodyRows - visible.length);
  return (
    <Panel title={title}>
      {visible.map((line, index) => (
        <BodyText key={`${index}:${line}`}>{line}</BodyText>
      ))}
      {emptyRows > 0 && <Box height={emptyRows} />}
    </Panel>
  );
}

/** The lines the help overlay draws: every advertised key and its promise. */
function helpLines(): readonly string[] {
  return RUN_KEY_BINDINGS.map((binding) => `${binding.key} ${binding.label}`);
}

/** The lines the opened-event view draws for one journal row. */
function eventLines(row: JournalRow): readonly string[] {
  return [`${row.time} · ${row.state}`, row.text];
}

/**
 * What the journal's slot of the RUN panel draws under an interaction state:
 * the help overlay while ? is up, the opened event while ⏎'s choice stands,
 * otherwise the journal itself — narrowed by the filter, marked at the
 * selection, titled with the open / prompt.
 */
function JournalBody({
  data,
  interaction,
  bodyRows,
}: {
  data: RunCockpitData;
  interaction?: RunInteractionState;
  bodyRows: number;
}): ReactElement {
  const rows = visibleJournalRows(data.journalRows, interaction);
  if (interaction?.help === true) {
    return <SizedLinesPanel title="HELP" lines={helpLines()} bodyRows={bodyRows} />;
  }
  const opened = interaction?.opened ?? null;
  if (opened !== null && opened < rows.length) {
    return (
      <SizedLinesPanel
        title="EVENT"
        lines={eventLines(rows[opened]!)}
        bodyRows={bodyRows}
      />
    );
  }
  return (
    <SizedJournalPanel
      rows={rows}
      bodyRows={bodyRows}
      title={interaction?.filterPrompt === true
        ? `JOURNAL /${interaction.filterQuery}`
        : undefined}
      selection={interaction === undefined || interaction.selection < 0
        ? undefined
        : interaction.selection}
    />
  );
}

function RunStats({
  data,
  mode,
}: {
  data: RunCockpitData;
  mode: FrameCockpitLayout["stats"]["mode"];
}): ReactElement {
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

function pairedTextRows(left: string, right: string, columns: number): number {
  const leftWidth = [...left].length;
  const rightWidth = [...right].length;
  const required = leftWidth + rightWidth;
  if (required <= columns) return 1;
  const leftColumns = Math.max(
    1,
    Math.floor((Math.max(1, columns) * leftWidth) / required),
  );
  const rightColumns = Math.max(1, Math.max(1, columns) - leftColumns);
  return Math.max(
    wrappedRows(left, leftColumns),
    wrappedRows(right, rightColumns),
  );
}

function narrowHeaderRows(left: string, right: string, columns: number): number {
  const content = [
    { title: "", lines: [left] },
    { title: "", lines: [right] },
  ] as const satisfies readonly [BandColumnContent, BandColumnContent];
  const widths = allocateBandColumns(
    columns,
    content,
    NARROW_HEADER_ALLOCATION,
  );
  return Math.max(
    ...content.map((column, index) =>
      composeBandLine(column.lines[0]!, Math.max(1, widths[index]!)).length
    ),
  );
}

function headerRowsFor(
  layout: FrameCockpitLayout,
  data: RunCockpitData,
  columns: number,
): number {
  const lockup = PLAIN_COMPACT_LOCKUP.split("\n");
  const measure = columns < APPROVED_SIDE_RAIL_COLUMN_FLOOR
    ? narrowHeaderRows
    : pairedTextRows;
  const primaryRows = measure(
    lockup[0] ?? "tickmarkr",
    `v${data.binaryVersion} · binary ${GLYPHS.pass}`,
    columns,
  );
  if (!layout.elements.secondaryHeader) return primaryRows;
  return primaryRows + measure(
    lockup[1] ?? "tickmarkr",
    `${data.runId} · ${data.branch}  ${data.status} · ${data.elapsed}`,
    columns,
  );
}

function compactJournalRows(
  rows: number,
  layout: FrameCockpitLayout,
  data: RunCockpitData,
  columns: number,
): number {
  const statRows = layout.stats.mode === "tiles" ? 5 : 1;
  const progressRows = layout.elements.progressBar
    ? 1 + (layout.elements.progressCaption ? 1 : 0)
    : 0;
  const fixedRows = headerRowsFor(layout, data, columns)
    + 2 // permanent status strip and keybar
    + 3 // outer RUN panel border and title
    + statRows
    + progressRows
    + 3; // journal border and title
  return Math.max(
    1,
    Math.min(layout.journalRows, Math.floor(rows) - fixedRows),
  );
}

function LadderRunPanel({
  data,
  layout,
  columns,
  rows,
  compactMeterWidth,
  interaction,
  focused = true,
}: {
  data: RunCockpitData;
  layout: FrameCockpitLayout;
  columns: number;
  rows: number;
  compactMeterWidth?: number;
  interaction?: RunInteractionState;
  focused?: boolean;
}): ReactElement {
  const compactBodyRows = compactJournalRows(rows, layout, data, columns);
  // The approved bordered progress panel has the same meter/caption as the
  // compact form plus its border, title row and closing border. It is restored
  // only after the resolved ladder has retained every full-arrangement element
  // and the journal can pay those three chrome rows without disappearing.
  const approvedProgressChromeRows = 3;
  const approvedArrangement = layout.elements.secondaryHeader
    && layout.elements.progressBar
    && layout.elements.progressCaption
    && layout.stats.mode === "tiles"
    && compactBodyRows > approvedProgressChromeRows;
  const journalBodyRows = approvedArrangement
    ? compactBodyRows - approvedProgressChromeRows
    : compactBodyRows;

  return (
    <Panel title="RUN" focused={focused} flexGrow={1}>
      <RunStats data={data} mode={layout.stats.mode} />
      {layout.elements.progressBar && (
        approvedArrangement
          ? (
            <ApprovedProgress
              data={data}
              caption={layout.elements.progressCaption}
            />
          )
          : (
            <CompactProgress
              data={data}
              caption={layout.elements.progressCaption}
              meterWidth={compactMeterWidth}
            />
          )
      )}
      <JournalBody
        data={data}
        interaction={interaction}
        bodyRows={journalBodyRows}
      />
    </Panel>
  );
}

function LegacyRunPanel({
  data,
  interaction,
  focused = true,
}: {
  data: RunCockpitData;
  interaction?: RunInteractionState;
  focused?: boolean;
}): ReactElement {
  const rows = visibleJournalRows(data.journalRows, interaction);
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
      />
    </Panel>
  );
}

export function RunCockpitFrame({
  data,
  columns,
  rows,
  interaction,
}: {
  data: RunCockpitData;
  columns: number;
  rows?: number;
  /**
   * The run surface's interaction state. Omitted — or at its initial value —
   * the frame is byte-identical to the pinned appearance; every transition a
   * binding makes is drawn from it.
   */
  interaction?: RunInteractionState;
}): ReactElement {
  const focus = interaction === undefined
    ? 0
    : interaction.panel % RUN_PANEL_FOCUS_ORDER.length;
  const focusedPanel = RUN_PANEL_FOCUS_ORDER[focus] ?? "RUN";
  // Follow mode reports its on state as a status-strip item carrying the
  // brand's reserved active-toggle glyph; off it draws nothing, so the pinned
  // frame is untouched.
  const statusItems = interaction?.follow === true
    ? [...data.statusItems, { state: "active" as const, text: "Follow" }]
    : data.statusItems;
  if (rows === undefined) {
    return (
      <Box flexDirection="column" width={columns}>
        <IdentityHeader data={data} columns={columns} />
        <Box flexDirection="row" gap={1}>
          <NavigationPanel focused={focusedPanel === "VIEWS"} />
          <LegacyRunPanel
            data={data}
            interaction={interaction}
            focused={focusedPanel === "RUN"}
          />
          <KeysPanel focused={focusedPanel === "KEYS"} />
        </Box>
        <StatusStrip items={statusItems} width={columns} />
        <Keybar surface="run" width={columns} />
      </Box>
    );
  }
  const layout = resolveCockpitLayout(columns, rows);
  if (layout.renderer === "plain") return <></>;
  const showSideRails = columns >= APPROVED_SIDE_RAIL_COLUMN_FLOOR;
  const contentLayout: FrameCockpitLayout = showSideRails
    ? layout
    : {
      ...layout,
      stats: { ...layout.stats, mode: "summary", rows: 1 },
    };

  return (
    <Box flexDirection="column" width={columns}>
      <IdentityHeader
        data={data}
        columns={columns}
        secondary={layout.elements.secondaryHeader}
      />
      <Box flexDirection="row" gap={showSideRails ? 1 : 0}>
        {showSideRails && <NavigationPanel focused={focusedPanel === "VIEWS"} />}
        <LadderRunPanel
          data={data}
          layout={contentLayout}
          columns={columns}
          rows={rows}
          compactMeterWidth={showSideRails ? undefined : 24}
          interaction={interaction}
          focused={focusedPanel === "RUN"}
        />
        {showSideRails && <KeysPanel focused={focusedPanel === "KEYS"} />}
      </Box>
      <StatusStrip items={statusItems} width={columns} />
      <Keybar surface="run" width={columns} />
    </Box>
  );
}
