import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { GLYPHS } from "../../brand.js";

export type FleetListRow = {
  id: string;
  content: ReactNode;
};

function keyedLines(lines: string[]): Array<{ id: string; text: string }> {
  const occurrences = new Map<string, number>();
  return lines.map((text) => {
    const occurrence = occurrences.get(text) ?? 0;
    occurrences.set(text, occurrence + 1);
    return { id: `${text}:${occurrence}`, text };
  });
}

export function TextLines({ lines }: { lines: string[] }) {
  return (
    <>
      {keyedLines(lines).map(({ id, text }) => <Text key={id}>{text || " "}</Text>)}
    </>
  );
}

export function ToggleMark({ active }: { active: boolean }) {
  return active
    ? <Text color="ansi256(41)">{GLYPHS.toggleActive}</Text>
    : <Text dimColor>{GLYPHS.toggleInactive}</Text>;
}

/**
 * v1.90.9 (operator field report: "can't choose models for omp"): a list longer than the
 * terminal rendered EVERY row, so the title, legend, and cursor scrolled off the top — omp's
 * 218 unclassified models left the operator staring at a tail of unselectable rows. The window
 * is cursor-centered and clamped; the markers say exactly what is elided and that the list is
 * still fully reachable (arrows walk it, type-to-search narrows it).
 */
export function windowRows<T>(rows: T[], cursor: number, capacity: number): { visible: T[]; start: number; above: number; below: number } {
  if (capacity <= 0 || rows.length <= capacity) return { visible: rows, start: 0, above: 0, below: 0 };
  const start = Math.min(Math.max(cursor - Math.floor(capacity / 2), 0), rows.length - capacity);
  return { visible: rows.slice(start, start + capacity), start, above: start, below: rows.length - start - capacity };
}

export function FleetListScreen({
  title,
  legend,
  rows,
  cursor,
  details = [],
  filter,
  viewRows,
}: {
  title: string;
  legend: string;
  rows: FleetListRow[];
  cursor: number;
  details?: string[];
  /** active type-to-search string; rendered on the legend line so the operator sees the narrowing */
  filter?: string;
  /** list viewport capacity; rows beyond it window around the cursor with elision markers */
  viewRows?: number;
}) {
  const { visible, start, above, below } = windowRows(rows, cursor, viewRows ?? Number.POSITIVE_INFINITY);
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>{filter ? `${legend} · search: ${filter}` : legend}</Text>
      {above > 0 && <Text dimColor>  … {above} above</Text>}
      {visible.map((row, index) => (
        <Text key={row.id} bold={start + index === cursor}>
          {start + index === cursor ? `${GLYPHS.pointer} ` : "  "}
          {row.content}
        </Text>
      ))}
      {below > 0 && <Text dimColor>  … {below} below — type to search</Text>}
      <TextLines lines={details} />
    </Box>
  );
}

export function FleetReviewScreen({
  title,
  legend,
  diff,
}: {
  title: string;
  legend: string;
  diff: string;
}) {
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>{legend}</Text>
      <Text>{diff}</Text>
    </Box>
  );
}
