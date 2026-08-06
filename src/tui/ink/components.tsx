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

export function FleetListScreen({
  title,
  legend,
  rows,
  cursor,
  details = [],
}: {
  title: string;
  legend: string;
  rows: FleetListRow[];
  cursor: number;
  details?: string[];
}) {
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>{legend}</Text>
      {rows.map((row, index) => (
        <Text key={row.id} bold={index === cursor}>
          {index === cursor ? `${GLYPHS.pointer} ` : "  "}
          {row.content}
        </Text>
      ))}
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
