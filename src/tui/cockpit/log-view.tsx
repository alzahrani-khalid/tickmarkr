import { Box, Text } from "ink";
import { narrationRow } from "../../cli/commands/run.js";
import type { JournalEvent } from "../../run/journal.js";
import { STORE_LIMITS, type JournalLine, type TailSnapshot } from "./live-store.js";

/** The board uses the daemon's TTY narration, including its suppression and sanitization. */
export const renderLogLines = (events: readonly JournalEvent[], runId: string, columns: number): string[] =>
  events.map(event => narrationRow(event, runId, columns)).filter((line): line is string => line !== null);

export interface LogRow { line: number; text: string }
export interface LogPage { rows: readonly LogRow[]; error?: string }
type PageReader = (firstLine: number, count?: number, generation?: number) => readonly JournalLine[];
interface LogSource { journal: TailSnapshot; page: PageReader; runId: string; columns: number }
const narrate = (rows: readonly JournalLine[], source: LogSource): LogRow[] => rows.flatMap(row => row.event
  ? renderLogLines([row.event], source.runId, source.columns).map(text => ({ line: row.line, text })) : []);

/** Demand-page backwards to fill the viewport, including events outside the store's retained tail.
 * Only the requested visible rows survive; suppressed events never consume viewport rows. */
export function readLogPage(source: LogSource, count: number, end = source.journal.lines): LogPage {
  let cursor = Math.min(end, source.journal.lines);
  let rows: LogRow[] = [];
  try {
    while (cursor > 0 && rows.length < count) {
      const first = Math.max(1, cursor - STORE_LIMITS.history + 1);
      const retained = source.journal.history.filter(row => row.line >= first && row.line <= cursor);
      const page = retained.length === cursor - first + 1 ? retained
        : source.page(first, cursor - first + 1, source.journal.generation);
      rows = [...narrate(page, source), ...rows].slice(-count);
      cursor = first - 1;
    }
    return { rows };
  } catch (error) { return { rows: [], error: error instanceof Error ? error.message : String(error) }; }
}

/** Move by visible narration rows. Undefined means follow the journal tail again. */
export function moveLogEnd(source: LogSource, end: number | undefined, delta: number): number | undefined {
  const cursor = Math.min(end ?? source.journal.lines, source.journal.lines);
  if (delta < 0) {
    const rows = readLogPage(source, -delta + 1, cursor).rows;
    return rows[Math.max(0, rows.length - 1 + delta)]?.line ?? end;
  }
  let first = cursor + 1, remaining = delta;
  while (first <= source.journal.lines) {
    const last = Math.min(source.journal.lines, first + STORE_LIMITS.history - 1);
    let rows: LogRow[];
    try { rows = narrate(source.page(first, last - first + 1, source.journal.generation), source); }
    catch { return end; } // A stale journal observation must never terminate the board's key handler.
    if (rows.length >= remaining) {
      const line = rows[remaining - 1]!.line;
      return line === source.journal.lines ? undefined : line;
    }
    remaining -= rows.length;
    first = last + 1;
  }
  return undefined;
}

export function LogView({ page }: { page: LogPage }) {
  return <Box flexDirection="column">{page.error
    ? <Text>Log unavailable: {page.error}</Text>
    : page.rows.length ? page.rows.map(row => <Text key={row.line} wrap="truncate-end">{row.text}</Text>)
    : <Text>No narrated events</Text>}</Box>;
}
