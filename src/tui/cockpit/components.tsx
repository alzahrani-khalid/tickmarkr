import { Box, Text } from "ink";
import { Children, type ReactElement, type ReactNode } from "react";
import { GLYPHS } from "../../brand.js";
import {
  COCKPIT_DATA_RAMP,
  COCKPIT_INKS,
  TEXT_EMPHASIS_TOKENS,
} from "./theme.js";
import { SPARKLINE_BUCKET_WINDOW } from "./derive.js";
export { SPARKLINE_BUCKET_WINDOW } from "./derive.js";
import {
  formatKeybarEntries,
  keybarEntries,
  SETUP_KEY_BINDINGS,
} from "./keys.js";
/**
 * Measurement and cutting come from the cockpit's one width authority; this
 * file owns no width table and counts no code points of its own. The local
 * name stays `stringWidth` because `keys.test.ts`'s branch ledger proves the
 * roster's fit branch by naming that line of this file verbatim and watching
 * the named test fail without it — renaming the call would leave the ledger
 * reporting a missing anchor instead of a covered branch. The name is the
 * ledger's; the measurement is `cellWidth`, and `string-width` the package is
 * no longer imported here.
 */
import { cellWidth as stringWidth, sliceCells } from "./width.js";

const SPARKLINE_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * The hover highlight's non-colour half: one cell wide, drawn in the separator
 * the row already spends, from the block family the cockpit already draws with.
 * Colour is the other half and the louder one, but Chalk suppresses inverse and
 * colour together at level 0, so a highlight made of ink alone does not exist
 * under `NO_COLOR` or a colourless TTY. This is a character; it always does.
 */
export const HOVER_MARKER = "▌";
const BAND_GAP_COLUMNS = 1;
const PANEL_HORIZONTAL_CHROME = 4;
/**
 * The columns below which a bordered panel no longer reads — the floor a band
 * allocation defends, and the floor planFrame's session resize override clamps
 * the body panel at: a drag surrenders an element whole or not at all, it
 * never collapses one below what reads.
 */
export const READABLE_PANEL_COLUMNS = 20;

export const PANEL_CHROME_ROWS = 3;
export const BAND_CONTINUATION_PREFIX = "↳ ";

export type BandColumnContent = {
  readonly title: string;
  readonly lines: readonly string[];
};

export type BandAllocationOptions = {
  readonly chromeColumns?: number;
  readonly minimumReadableColumns?: number;
};

export type TextEmphasis = keyof typeof TEXT_EMPHASIS_TOKENS;
export type ComponentState =
  | "active"
  | "inactive"
  | "pass"
  | "fail"
  | "warn"
  | "neutral";

export type KeybarItem = {
  readonly key: string;
  readonly label: string;
};

const SETUP_KEYS = keybarEntries(SETUP_KEY_BINDINGS);
const SETUP_ADDITIONAL_KEYS = SETUP_KEYS.slice(6);

export const KEYBAR_KEYS = {
  setup: SETUP_KEYS,
  setupAdditional: SETUP_ADDITIONAL_KEYS,
} as const;

export type JournalRow = {
  readonly id: string;
  readonly time: string;
  /** The complete recorded instant behind `time`; absent only on non-event/legacy rows. */
  readonly timestamp?: string;
  readonly state: ComponentState;
  readonly text: string;
};

export function BodyText({
  children,
  emphasis = "normal",
}: {
  children: ReactNode;
  emphasis?: TextEmphasis;
}): ReactElement {
  const token = TEXT_EMPHASIS_TOKENS[emphasis];
  return (
    <Text bold={token.weight === "bold"} dimColor={token.dimmed}>
      {children}
    </Text>
  );
}

function longestBandLine(column: BandColumnContent): number {
  return Math.max(
    1,
    ...[column.title, ...column.lines].map((line) => stringWidth(line)),
  );
}

function apportion(
  available: number,
  weights: readonly number[],
): number[] {
  if (weights.length === 0) return [];
  if (available <= 0) return weights.map(() => 0);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return weights.map((_, index) =>
      Math.floor(available / weights.length)
        + (index < available % weights.length ? 1 : 0)
    );
  }

  const exact = weights.map((weight) => (available * weight) / totalWeight);
  const granted = exact.map(Math.floor);
  let remainder = available - granted.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({
    index,
    fraction: value - granted[index]!,
    weight: weights[index]!,
  })).sort((left, right) =>
    right.fraction - left.fraction
    || right.weight - left.weight
    || left.index - right.index
  );
  for (const item of order) {
    if (remainder <= 0) break;
    granted[item.index]! += 1;
    remainder -= 1;
  }
  return granted;
}

/**
 * Give each panel the columns its own longest line calls for. Surplus is shared
 * evenly after every line fits; scarcity is apportioned by unmet content need.
 */
export function allocateBandColumns(
  columns: number,
  content: readonly BandColumnContent[],
  options: BandAllocationOptions = {},
): readonly number[] {
  if (content.length === 0) return [];
  const chromeColumns = Math.max(
    0,
    Math.floor(options.chromeColumns ?? PANEL_HORIZONTAL_CHROME),
  );
  const minimumColumns = chromeColumns + 1;
  const minimumReadableColumns = Math.max(
    minimumColumns,
    Math.floor(options.minimumReadableColumns ?? READABLE_PANEL_COLUMNS),
  );
  const total = Math.max(0, Math.floor(columns));
  const usable = Math.max(0, total - BAND_GAP_COLUMNS * (content.length - 1));
  if (usable < minimumColumns * content.length) {
    return apportion(
      usable,
      content.map((column) => longestBandLine(column)),
    );
  }

  const preferred = content.map((column) =>
    longestBandLine(column) + chromeColumns
  );
  const preferredTotal = preferred.reduce((sum, value) => sum + value, 0);
  if (preferredTotal <= usable) {
    const surplus = apportion(
      usable - preferredTotal,
      content.map(() => 1),
    );
    return preferred.map((value, index) => value + surplus[index]!);
  }

  const readable = preferred.map((value) =>
    Math.min(value, minimumReadableColumns)
  );
  const readableTotal = readable.reduce((sum, value) => sum + value, 0);
  const base = readableTotal <= usable
    ? readable
    : content.map(() => minimumColumns);
  const shares = apportion(
    usable - base.reduce((sum, value) => sum + value, 0),
    preferred.map((value, index) => value - base[index]!),
  );
  return base.map((value, index) => value + shares[index]!);
}

/**
 * Compose one data line into visible rows. A fitting line is byte-for-byte
 * untouched. Every wrapped row carries a continuation marker before any
 * separator or data token, so it cannot masquerade as a new item.
 */
export function composeBandLine(text: string, columns: number): readonly string[] {
  const width = Math.max(1, Math.floor(columns));
  if (stringWidth(text) <= width) return [text];

  const words = text.split(" ");
  const rendered: string[] = [];
  let current = "";
  let continuation = false;
  const emptyLine = () =>
    continuation
      ? BAND_CONTINUATION_PREFIX.slice(0, width)
      : "";

  for (const sourceWord of words) {
    let word = sourceWord;
    for (;;) {
      if (current.length === 0) current = emptyLine();
      const hasData = current !== emptyLine();
      const separator = hasData ? " " : "";
      const candidate = `${current}${separator}${word}`;
      if (stringWidth(candidate) <= width) {
        current = candidate;
        break;
      }

      if (hasData) {
        rendered.push(current);
        continuation = true;
        current = "";
        continue;
      }

      const available = Math.max(1, width - stringWidth(current));
      const { head, tail } = sliceCells(word, available);
      current += head;
      word = tail;
      if (word.length === 0) break;
      rendered.push(current);
      continuation = true;
      current = "";
    }
  }
  if (current.length > 0) rendered.push(current);
  return rendered.length > 0 ? rendered : [text];
}

export function BandLines({
  lines,
  columns,
  emphasis,
}: {
  lines: readonly string[];
  columns: number;
  emphasis?: TextEmphasis;
}): ReactElement {
  return (
    <Box flexDirection="column">
      {lines.flatMap((line, lineIndex) =>
        composeBandLine(line, columns).map((visible, visibleIndex) => (
          <BodyText
            key={`${lineIndex}:${visibleIndex}:${visible}`}
            emphasis={emphasis}
          >
            {visible}
          </BodyText>
        ))
      )}
    </Box>
  );
}

/** Rows drawn by a band of bordered panels at the same allocated widths. */
export function measureBandRows(
  columns: number,
  content: readonly BandColumnContent[],
): number {
  const widths = allocateBandColumns(columns, content);
  return Math.max(
    0,
    ...content.map((column, index) =>
      PANEL_CHROME_ROWS
      + column.lines.reduce(
        (rows, line) =>
          rows + composeBandLine(
            line,
            Math.max(1, widths[index]! - PANEL_HORIZONTAL_CHROME),
          ).length,
        0,
      )
    ),
  );
}

function statePresentation(state: ComponentState): {
  glyph: string;
  color?: string;
  dimmed?: boolean;
} {
  switch (state) {
    case "active":
      return {
        glyph: GLYPHS.toggleActive,
        color: `ansi256(${COCKPIT_DATA_RAMP[1].xterm})`,
      };
    case "inactive":
      return { glyph: GLYPHS.toggleInactive, dimmed: true };
    case "pass":
      return {
        glyph: GLYPHS.pass,
        color: `ansi256(${COCKPIT_DATA_RAMP[1].xterm})`,
      };
    case "fail":
      return {
        glyph: GLYPHS.fail,
        color: `ansi256(${COCKPIT_INKS.failure.xterm})`,
      };
    case "warn":
      return {
        glyph: GLYPHS.attention,
        color: `ansi256(${COCKPIT_INKS.warning.xterm})`,
      };
    case "neutral":
      return { glyph: GLYPHS.neutral, dimmed: true };
  }
}

export function StateGlyph({ state }: { state: ComponentState }): ReactElement {
  const presentation = statePresentation(state);
  return (
    <Text color={presentation.color} dimColor={presentation.dimmed}>
      {presentation.glyph}
    </Text>
  );
}

export function Panel({
  title,
  focused = false,
  width,
  flexGrow,
  children,
}: {
  title: string;
  focused?: boolean;
  width?: number | string;
  flexGrow?: number;
  children: ReactNode;
}): ReactElement {
  const content = Children.map(children, (child) =>
    typeof child === "string" || typeof child === "number"
      ? <BodyText>{child}</BodyText>
      : child
  );

  return (
    <Box
      flexDirection="column"
      flexGrow={flexGrow}
      width={width}
      paddingX={1}
      borderStyle={focused ? "double" : "round"}
      borderColor={`ansi256(${
        focused ? COCKPIT_DATA_RAMP[0].xterm : COCKPIT_DATA_RAMP[3].xterm
      })`}
      borderDimColor={!focused}
    >
      <Box>
        {focused ? (
          <>
            <Text color={`ansi256(${COCKPIT_DATA_RAMP[0].xterm})`}>
              {GLYPHS.pointer}
            </Text>
            <BodyText emphasis="strong"> {title}</BodyText>
          </>
        ) : (
          <BodyText emphasis="strong">{title}</BodyText>
        )}
      </Box>
      <Box flexDirection="column">{content}</Box>
    </Box>
  );
}

export function CockpitGrid({
  children,
  columns,
  columnContents,
  allocation,
}: {
  children: ReactNode;
  columns?: number;
  columnContents?: readonly BandColumnContent[];
  allocation?: BandAllocationOptions;
}): ReactElement {
  const items = Children.toArray(children);
  const widths = columns !== undefined
      && columnContents?.length === items.length
    ? allocateBandColumns(columns, columnContents, allocation)
    : undefined;
  return (
    <Box
      flexDirection="row"
      flexWrap="nowrap"
      gap={BAND_GAP_COLUMNS}
      width={columns}
    >
      {items.map((child, index) => (
        <Box
          key={index}
          flexDirection={widths ? "column" : undefined}
          flexGrow={widths ? 0 : 1}
          flexShrink={widths ? 0 : 1}
          flexBasis={widths ? undefined : 0}
          width={widths?.[index]}
        >
          {child}
        </Box>
      ))}
    </Box>
  );
}

function sparklineLevel(value: number, minimum: number, maximum: number): number {
  if (maximum === minimum) return 0;
  return Math.round(
    ((value - minimum) / (maximum - minimum)) * (SPARKLINE_GLYPHS.length - 1),
  );
}

export function Sparkline({
  samples,
}: {
  samples: readonly (number | null)[];
}): ReactElement {
  const buckets = samples
    .slice(-SPARKLINE_BUCKET_WINDOW)
    .map((sample) =>
      typeof sample === "number" && Number.isFinite(sample) ? sample : null
    );
  const populated = buckets.filter((sample): sample is number => sample !== null);
  const minimum = populated.length > 0 ? Math.min(...populated) : 0;
  const maximum = populated.length > 0 ? Math.max(...populated) : 0;

  return (
    <Box flexDirection="row" height={1} aria-label="metric sparkline">
      {buckets.map((sample, index) => {
        if (sample === null) return <Text key={`gap:${index}`}> </Text>;
        const level = sparklineLevel(sample, minimum, maximum);
        const rampIndex = COCKPIT_DATA_RAMP.length - 1 - Math.round(
          (level / (SPARKLINE_GLYPHS.length - 1)) * (COCKPIT_DATA_RAMP.length - 1),
        );
        const ink = COCKPIT_DATA_RAMP[rampIndex] ?? COCKPIT_DATA_RAMP[0];
        return (
          <Text
            key={`${index}:${sample}`}
            color={`ansi256(${ink.xterm})`}
          >
            {SPARKLINE_GLYPHS[level]}
          </Text>
        );
      })}
    </Box>
  );
}

export function StatTile({
  label,
  value,
  samples,
  focused,
  width,
}: {
  label: string;
  value: ReactNode;
  samples: readonly (number | null)[];
  focused?: boolean;
  width?: number | string;
}): ReactElement {
  return (
    <Panel title={label} focused={focused} width={width} flexGrow={1}>
      <BodyText emphasis="strong">{value}</BodyText>
      <Sparkline samples={samples} />
    </Panel>
  );
}

export function ProgressMeter({
  value,
  width = 24,
}: {
  value: number;
  width?: number;
}): ReactElement {
  const safeWidth = Math.max(1, Math.floor(width));
  const percentage = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
  const filled = Math.round((percentage / 100) * safeWidth);
  const valueLabel = Number.isInteger(percentage)
    ? percentage.toFixed(0)
    : percentage.toFixed(1);

  return (
    <Box
      flexDirection="row"
      flexWrap="nowrap"
      height={1}
      overflow="hidden"
      aria-role="progressbar"
      aria-label={`${valueLabel}% complete`}
    >
      <Text color={`ansi256(${COCKPIT_DATA_RAMP[0].xterm})`}>
        {"█".repeat(filled)}
      </Text>
      <Text dimColor>{"░".repeat(safeWidth - filled)}</Text>
      <BodyText emphasis="strong"> {valueLabel}%</BodyText>
    </Box>
  );
}

function OneLineItems({
  children,
  width,
  label,
}: {
  children: ReactNode;
  width: number;
  label: string;
}): ReactElement {
  return (
    <Box
      flexDirection="row"
      flexWrap="nowrap"
      width={width}
      height={1}
      overflow="hidden"
      aria-label={label}
    >
      {children}
    </Box>
  );
}

/**
 * Wrap a projected roster without losing a byte. Unlike prose wrapping, these
 * rows are exact consecutive slices: stripping continuation markers and
 * joining the slices reconstructs the registry projection byte for byte.
 */
export function keyRosterLines(
  entries: readonly KeybarItem[],
  columns: number,
): readonly string[] {
  const width = Math.max(1, Math.floor(columns));
  const formatted = formatKeybarEntries(entries);
  if (stringWidth(formatted) <= width) return [formatted];

  const rendered: string[] = [];
  let remaining = formatted;
  let first = true;
  while (remaining.length > 0) {
    const prefix = first ? "" : BAND_CONTINUATION_PREFIX;
    const available = Math.max(1, width - stringWidth(prefix));
    const { head: slice, tail } = sliceCells(remaining, available);
    // Ink trims terminal-row trailing spaces. Carry them to the next slice so
    // the painted representation still reconstructs the formatted roster.
    const trailingSpace = slice.match(/\s+$/u)?.[0] ?? "";
    const head = trailingSpace.length === 0
      ? slice
      : slice.slice(0, -trailingSpace.length);
    rendered.push(`${prefix}${head}`);
    remaining = trailingSpace + tail;
    first = false;
  }
  return rendered;
}

/** The lossless, width-safe rendering of one projected key roster. */
export function KeyRoster({
  entries,
  width,
}: {
  entries: readonly KeybarItem[];
  width: number;
}): ReactElement {
  return (
    <Box flexDirection="column" width={width} aria-label="run cockpit keys">
      {keyRosterLines(entries, width).map((line, index) => (
        <BodyText key={`${index}:${line}`} emphasis="dim">{line}</BodyText>
      ))}
    </Box>
  );
}

export type StatusStripItem = {
  readonly state: ComponentState;
  readonly text: string;
};

export function StatusStrip({
  items,
  width,
}: {
  items: readonly StatusStripItem[];
  width: number;
}): ReactElement {
  return (
    <OneLineItems width={width} label="cockpit status">
      {items.map((item, index) => (
        <Box key={`${item.state}:${item.text}`} flexShrink={0}>
          {index > 0 && <BodyText emphasis="dim"> · </BodyText>}
          <StateGlyph state={item.state} />
          <BodyText> {item.text}</BodyText>
        </Box>
      ))}
    </OneLineItems>
  );
}

export function JournalRowPanel({
  rows,
  width,
  focused,
  title = "JOURNAL",
  selection,
  hover,
}: {
  rows: readonly JournalRow[];
  width?: number | string;
  focused?: boolean;
  title?: string;
  /** Index of the row the pointer marks; undefined draws no pointer. */
  selection?: number;
  /**
   * Index of the row a live pointer is resting on; undefined draws no
   * highlight, which is every surface nobody is pointing at — a capture above
   * all. The highlight is ink AND shape: the brightest step of the existing
   * data ramp worn inverted, plus {@link HOVER_MARKER} standing in the one
   * separator cell the row already spends between its state glyph and its text.
   * Ink alone would be no highlight at all under `NO_COLOR` or a colourless
   * TTY, where Chalk suppresses inverse and colour alike; the marker is a drawn
   * character, so it survives every colour level. It costs the row no cell it
   * did not already own, so a hover shifts nothing an operator was reading.
   */
  hover?: number;
}): ReactElement {
  return (
    <Panel title={title} focused={focused} width={width}>
      {rows.map((row, index) => (
        <Box
          key={row.id}
          flexDirection="row"
          flexWrap="nowrap"
          height={1}
          overflow="hidden"
        >
          <BodyText emphasis="dim">{row.time}</BodyText>
          <BodyText> </BodyText>
          <StateGlyph state={row.state} />
          <BodyText emphasis={index === hover ? "strong" : "normal"}>
            {index === hover ? HOVER_MARKER : " "}
          </BodyText>
          {index === selection && (
            <BodyText emphasis="strong">{GLYPHS.pointer} </BodyText>
          )}
          {index === hover
            ? (
              <Text inverse color={`ansi256(${COCKPIT_DATA_RAMP[0].xterm})`}>
                {row.text}
              </Text>
            )
            : <BodyText>{row.text}</BodyText>}
        </Box>
      ))}
    </Panel>
  );
}
