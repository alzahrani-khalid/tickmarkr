import type { Task } from "../graph/schema.js";
import { effectiveEvents, type JournalEvent } from "./journal.js";

/**
 * Row 419 (D-2187 add.89): the rulings an operator recorded with `approve --ruling` for one task of ONE
 * run, in journal order. `events` is that run's journal, so another run reusing the task id contributes
 * nothing. Only an EFFECTIVE task-approved row counts (the journal's decision fold): a refused or
 * ineffective approval, and any other row carrying a `ruling` field, contribute nothing. The approve
 * reason is never read.
 */
export function foldRulings(events: readonly JournalEvent[], taskId: string): string[] {
  return effectiveEvents(events)
    .filter((e) => e.event === "task-approved" && e.taskId === taskId)
    .flatMap((e) => Array.isArray(e.data.ruling) ? e.data.ruling.filter((r): r is string => typeof r === "string" && r.trim() !== "") : []);
}

/** A task as the review brief reads it: the run's folded rulings ride beside the compiled task. */
export type RuledTask = Task & { rulings?: readonly string[] };

/**
 * The task carrying its run's rulings for `taskId` (a new object; the task is unchanged), or the task itself
 * when none. verify names the run's task explicitly: its own gated task is the synthetic VERIFY.
 */
export function withRulings<T extends Task>(task: T, events: readonly JournalEvent[], taskId = task.id): T & { rulings?: readonly string[] } {
  const rulings = foldRulings(events, taskId);
  return rulings.length ? { ...task, rulings } : task;
}

/** The brief section (row 419), after `## Out of scope`; empty when the run recorded no ruling for the task. */
export function renderRulingsSection(rulings: readonly string[] | undefined): string {
  return rulings?.length
    ? `## Rulings recorded during this run (binding)\n${rulings.map((r) => `- ${r}`).join("\n")}\n\n`
    : "";
}
