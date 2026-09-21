/**
 * Pure operator-page grouping over the `operator-page` rows the daemon journals (one row per
 * delivered page, carrying the producer's `suppressed` count). This module consumes that count and
 * never throttles a second time: it only coalesces EQUIVALENT rows for display while keeping every
 * source line, both evidence timestamps, and the producer's suppressed count separate from what was
 * actually observed. Folding is incremental and pure; `fold(fold(empty, a), b)` equals
 * `fold(empty, [...a, ...b])` and no journal byte is touched.
 */
import type { JournalEvent } from "./journal.js";

export interface OperatorPageRow {
  /** Source reference (journal line number or any stable locator). */
  readonly line: number;
  readonly ts: string;
  readonly runId: string;
  readonly taskId: string;
  /** Current park identity (e.g. park kind + attempt); part of the group key. */
  readonly park: string;
  /** Decision state (e.g. blocked / idle / failed / resolved); part of the group key. */
  readonly status: string;
  /** Producer-suppressed page count; absent on rows written before suppression metadata existed. */
  readonly suppressed?: number;
  readonly blocker?: string;
  readonly owner?: string;
  readonly requiredAction?: string;
  readonly permittedActions?: readonly string[];
}

export interface OperatorPageGroup {
  readonly key: string;
  readonly runId: string;
  readonly taskId: string;
  readonly park: string;
  readonly status: string;
  readonly blocker?: string;
  readonly owner?: string;
  readonly requiredAction?: string;
  readonly permittedActions: readonly string[];
  readonly firstEvidenceAt: string;
  readonly lastEvidenceAt: string;
  /** Rows actually present in the journal. */
  readonly observedCount: number;
  /** Sum of the producer's `suppressed` counts; never added to observedCount. */
  readonly suppressedCount: number;
  /** True when at least one row lacked suppression metadata (pre-metadata journal). */
  readonly rawOnly: boolean;
  readonly lines: readonly number[];
}

export interface OperatorPageSummary {
  readonly groups: readonly OperatorPageGroup[];
}

export const EMPTY_OPERATOR_PAGE_SUMMARY: OperatorPageSummary = { groups: [] };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Projects a journal event onto a row; returns undefined for anything that is not an operator page. */
export function operatorPageRow(event: JournalEvent, line: number, runId: string): OperatorPageRow | undefined {
  if (event.event !== "operator-page" || event.taskId === undefined) return undefined;
  const d = event.data;
  const permitted = Array.isArray(d.permittedActions) ? d.permittedActions.filter((a): a is string => typeof a === "string") : undefined;
  return {
    line, ts: event.ts, runId, taskId: event.taskId,
    park: str(d.park) ?? `${str(d.slot) ?? ""}#${typeof d.attempt === "number" ? d.attempt : ""}`,
    status: str(d.status) ?? "unknown",
    ...(typeof d.suppressed === "number" ? { suppressed: d.suppressed } : {}),
    ...(str(d.blocker) !== undefined ? { blocker: str(d.blocker) } : {}),
    ...(str(d.owner) !== undefined ? { owner: str(d.owner) } : {}),
    ...(str(d.requiredAction) !== undefined ? { requiredAction: str(d.requiredAction) } : {}),
    ...(permitted !== undefined ? { permittedActions: permitted } : {}),
  };
}

const groupKey = (r: OperatorPageRow): string => [r.runId, r.taskId, r.park, r.status].join("\u0000");

const openKey = (r: { runId: string; taskId: string }): string => `${r.runId}\u0000${r.taskId}`;

/** Permitted actions compare as a SET: order and duplicates never open a new group. */
const actionSet = (a: readonly string[] | undefined): string => [...new Set(a ?? [])].sort().join("\u0000");

const sameDecision = (g: OperatorPageGroup, r: OperatorPageRow): boolean =>
  g.key === groupKey(r)
  && g.blocker === r.blocker && g.owner === r.owner && g.requiredAction === r.requiredAction
  && actionSet(g.permittedActions) === actionSet(r.permittedActions);

/** Folds rows into a summary. Pure: returns a new summary, never mutates inputs. */
export function foldOperatorPages(prior: OperatorPageSummary, rows: readonly OperatorPageRow[]): OperatorPageSummary {
  const groups = [...prior.groups];
  // One open group per run/task: ANY change in park, status or decision closes it, so a later
  // transition can never merge backward into an earlier group across an intervening change.
  const open = new Map<string, number>();
  groups.forEach((g, i) => open.set(openKey(g), i));
  for (const row of rows) {
    const key = groupKey(row);
    const idx = open.get(openKey(row));
    const g = idx === undefined ? undefined : groups[idx];
    if (g !== undefined && sameDecision(g, row)) {
      groups[idx!] = {
        ...g,
        firstEvidenceAt: row.ts < g.firstEvidenceAt ? row.ts : g.firstEvidenceAt,
        lastEvidenceAt: row.ts > g.lastEvidenceAt ? row.ts : g.lastEvidenceAt,
        observedCount: g.observedCount + 1,
        suppressedCount: g.suppressedCount + (row.suppressed ?? 0),
        rawOnly: g.rawOnly || row.suppressed === undefined,
        lines: [...g.lines, row.line],
      };
      continue;
    }
    groups.push({
      key, runId: row.runId, taskId: row.taskId, park: row.park, status: row.status,
      ...(row.blocker !== undefined ? { blocker: row.blocker } : {}),
      ...(row.owner !== undefined ? { owner: row.owner } : {}),
      ...(row.requiredAction !== undefined ? { requiredAction: row.requiredAction } : {}),
      permittedActions: [...(row.permittedActions ?? [])],
      firstEvidenceAt: row.ts, lastEvidenceAt: row.ts,
      observedCount: 1, suppressedCount: row.suppressed ?? 0,
      rawOnly: row.suppressed === undefined, lines: [row.line],
    });
    open.set(openKey(row), groups.length - 1);
  }
  return { groups };
}

/** Full replay from journal events. */
export function summarizeOperatorPages(events: readonly JournalEvent[], runId: string): OperatorPageSummary {
  const rows = events.flatMap((e, i) => { const r = operatorPageRow(e, i + 1, runId); return r ? [r] : []; });
  return foldOperatorPages(EMPTY_OPERATOR_PAGE_SUMMARY, rows);
}
