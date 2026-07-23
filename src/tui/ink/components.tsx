import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { GLYPHS } from "../../brand.js";

export type FleetListRow = {
  id: string;
  content: ReactNode;
};

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
      {details.map((detail) => <Text key={detail}>{detail}</Text>)}
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
