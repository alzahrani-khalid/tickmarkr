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

function NavigationPanel(): ReactElement {
  return (
    <Panel title="VIEWS" width={16}>
      <BodyText emphasis="strong">{GLYPHS.pointer} Run</BodyText>
      <BodyText>  Tasks</BodyText>
      <BodyText>  Gates</BodyText>
      <BodyText>  Journal</BodyText>
      <BodyText>  Fleet</BodyText>
    </Panel>
  );
}

function KeysPanel(): ReactElement {
  return (
    <Panel title="KEYS" width={16}>
      {KEYBAR_KEYS.run.map((item) => (
        <Box key={item.key}>
          <BodyText emphasis="strong">{item.key}</BodyText>
          <BodyText> {item.label}</BodyText>
        </Box>
      ))}
    </Panel>
  );
}

function SizedJournalPanel({
  rows,
  bodyRows,
}: {
  rows: readonly JournalRow[];
  bodyRows: number;
}): ReactElement {
  const visible = rows.slice(0, bodyRows);
  const emptyRows = Math.max(0, bodyRows - visible.length);
  const journal = JournalRowPanel({ rows: visible });
  const journalProps = journal.props as { readonly children?: ReactNode };
  return cloneElement(
    journal,
    {},
    journalProps.children,
    emptyRows > 0 ? <Box key="journal-space" height={emptyRows} /> : null,
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
}: {
  data: RunCockpitData;
  layout: FrameCockpitLayout;
  columns: number;
  rows: number;
  compactMeterWidth?: number;
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
    <Panel title="RUN" focused flexGrow={1}>
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
      <SizedJournalPanel
        rows={data.journalRows}
        bodyRows={journalBodyRows}
      />
    </Panel>
  );
}

function LegacyRunPanel({ data }: { data: RunCockpitData }): ReactElement {
  return (
    <Panel title="RUN" focused flexGrow={1}>
      <RunStats data={data} mode="tiles" />
      <Panel title="PROGRESS">
        <ProgressMeter value={data.progress} width={28} />
        <BodyText emphasis="dim">{data.progressCaption}</BodyText>
      </Panel>
      <JournalRowPanel rows={data.journalRows} />
    </Panel>
  );
}

export function RunCockpitFrame({
  data,
  columns,
  rows,
}: {
  data: RunCockpitData;
  columns: number;
  rows?: number;
}): ReactElement {
  if (rows === undefined) {
    return (
      <Box flexDirection="column" width={columns}>
        <IdentityHeader data={data} columns={columns} />
        <Box flexDirection="row" gap={1}>
          <NavigationPanel />
          <LegacyRunPanel data={data} />
          <KeysPanel />
        </Box>
        <StatusStrip items={data.statusItems} width={columns} />
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
        {showSideRails && <NavigationPanel />}
        <LadderRunPanel
          data={data}
          layout={contentLayout}
          columns={columns}
          rows={rows}
          compactMeterWidth={showSideRails ? undefined : 24}
        />
        {showSideRails && <KeysPanel />}
      </Box>
      <StatusStrip items={data.statusItems} width={columns} />
      <Keybar surface="run" width={columns} />
    </Box>
  );
}
