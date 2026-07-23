import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { GLYPHS } from "../../brand.js";
import { RELOAD_GUARD_NOTICE, type SaveTarget } from "../save.js";

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

export type DiffConfirmationProps = { target: SaveTarget; targetPath: string; diff: string; liveRun: boolean };

export function DiffConfirmationScreen(props: DiffConfirmationProps) {
  return <TextLines lines={[
    `Save overlay — ${props.targetPath} (${props.target === "repo" ? "repository" : "global"} target)`,
    "t toggle target · y confirm · n/esc cancel",
    ...(props.liveRun ? [RELOAD_GUARD_NOTICE] : []),
    "─ diff ─",
    props.diff || "(no overlay changes)",
  ]} />;
}

export function StudioScreen({
  tabs,
  active,
  lines,
  status = "no staged changes",
  children,
}: {
  tabs: string[];
  active: number;
  lines: string[];
  status?: string;
  children?: ReactNode;
}) {
  const tabBar = [
    "tickmarkr ui ──",
    ...tabs.map((label, index) => `[${index + 1}]${index === active ? "*" : ""}${label}`),
  ].join(" ");
  return (
    <Box flexDirection="column">
      <Text bold>{tabBar}</Text>
      {children ?? <TextLines lines={lines} />}
      <Text dimColor>{status}</Text>
    </Box>
  );
}
