// Queue row 372 (D-2186): the split release decider. A graph-changed resume releases a parked task whose
// definition changed as a NEW engagement — its committed head re-gated with no worker, or a fresh worker
// when it has no commits — keeps the parks it may not release, and decides nothing else. Pure: journal
// rows, the loaded tasks (after the resume's scope-amendment replay) and a read of each parked task's work
// in; the data of the rows the resume appends out. The daemon (which already exceeds the file-size bound)
// only reads the work, appends these rows and lets its ordinary boundary sweep enact them.
import { newestPark, type NewestPark } from "../cli/commands/approve.js";
import { taskDefinitionFingerprint } from "../graph/graph.js";
import type { Task } from "../graph/schema.js";
import { decisionCommands } from "./decision-verbs.js";
import { effectiveDecisions, PARK_KINDS, physicalLine, RECHECK_RELEASE, type JournalEvent } from "./journal.js";

/** The kept-park row the resume appends where it may not release (row 372, D-2186). */
export const PARK_KEPT_EVENT = "graph-change-park-kept";
export const RELEASED_BY = "resume --graph-changed";
export const ENDED_PATH = "the run had ended";
export const STOPPED_PATH = "the run was stopped before it ended";

/** The park definition record every task-human row carries: the task's definition fingerprint and files[]. */
export interface ParkDefinition { fingerprint: string; files: string[] }

export const parkDefinition = (task: Task): ParkDefinition =>
  ({ fingerprint: taskDefinitionFingerprint(task), files: [...task.files] });

/** What reading a parked task's work proved: its head, how many commits sit ahead of its task base, and the
 * preserved ref it was recovered from when neither the checkout, the removal row nor the task branch held it. */
export type TaskWorkRead = { head?: string; commits: number; ref?: string } | { error: string };

export interface SplitReleaseInput {
  runId: string;
  events: readonly JournalEvent[];
  /** The loaded graph's tasks, after the resume's own scope-amendment replay. */
  tasks: readonly Task[];
  /** The graph-rehash THIS launch journaled; absent, the resume is not graph-changed and nothing is decided. */
  rehash: { from: string | null; to: string } | undefined;
}

export type SplitDecision =
  | { taskId: string; event: "task-approved"; data: Record<string, unknown> }
  // `hold` is not row data: every kept park the resume keeps out of scheduling although the recompile wrote it
  // pending — execTask's humanGate guard would open a second park over an exempt one, an attempt-cap park's gate
  // replay would run before the cap check (D-2186 add.7, add.11), and an unproved change would run as if released
  // (row 389, D-2186 add.18, D-2187: kept means kept until an operator decision on the park).
  | { taskId: string; event: typeof PARK_KEPT_EVENT; data: { park: number; reason: string }; hold: true };

const CLOSES_PARK = new Set(["task-dispatch", "task-done", "task-failed"]);

interface Releasable { taskId: string; park: NewestPark & { ts: string }; from: ParkDefinition; to: ParkDefinition; path: string; next: string }

const recordOf = (value: unknown): ParkDefinition | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const { fingerprint, files } = value as Record<string, unknown>;
  return typeof fingerprint === "string" && fingerprint !== "" && Array.isArray(files) && files.every((f) => typeof f === "string")
    ? { fingerprint, files: [...files] } : undefined;
};

const kept = (taskId: string, park: number, reason: string): SplitDecision =>
  ({ taskId, event: PARK_KEPT_EVENT, data: { park, reason: `park at journal line ${park} kept — ${reason}` }, hold: true });

/** Every open park's decision, with the releasable ones still waiting on their work read. */
function classify({ runId, events, tasks, rehash }: SplitReleaseInput): Array<SplitDecision | Releasable> {
  if (!rehash) return [];
  const effective = effectiveDecisions(events);
  const out: Array<SplitDecision | Releasable> = [];
  for (const task of tasks) {
    const park = newestPark(events, task.id);
    if (!park || park.ts === undefined) continue; // no park, or one no decision can bind to: base behaviour
    const after = events.slice(park.index + 1);
    const closed = after.some((e, k) => e.taskId === task.id
      && (CLOSES_PARK.has(e.event) || (e.event === "task-approved" && effective.has(physicalLine(events, park.index + 1 + k)))));
    if (closed) continue; // not an open park — a pending decision or a later dispatch already moved it
    const { commands, noDecision } = decisionCommands(runId, task.id, park);
    const next = commands.length ? `release with ${commands.map(({ command }) => `\`${command}\``).join(" or ")}` : noDecision ?? "no decision is available";
    const from = recordOf(events[park.index]!.data.definition);
    if (!from) {
      out.push(kept(task.id, park.line, `the definition at park is unrecorded (the park predates definition records), so no change is proved — ${next}`));
      continue;
    }
    const to = parkDefinition(task);
    // Row 415 (D-2187 add.73): an unchanged definition — fingerprint AND files — keeps its park, of every kind,
    // before the exempt-kind branches. Under a graph-changed resume the recompile's `pending` cannot be told
    // from an operator's graph.json release, so only an operator decision on the park releases it.
    if (from.fingerprint === to.fingerprint && JSON.stringify(from.files) === JSON.stringify(to.files)) {
      out.push(kept(task.id, park.line, `definition unchanged — ${next}`));
      continue;
    }
    // D-2186 add.7: the spec's approval-before-dispatch gate and an exhausted attempt budget (queue row 388 owns
    // any automatic reset) are operator decisions whatever the definition change. D-2186 add.11: a human-gate park
    // is exempt only while the loaded definition still sets humanGate; one that turns it off is the operator's own
    // release and dispatches as at the base, with no kept or released row.
    if (park.kind === "human-gate") {
      if (task.humanGate) out.push(kept(task.id, park.line, `human-gate park: the spec's approval-before-dispatch gate is never released automatically, whatever its definition change — ${next}`));
      continue;
    }
    if (park.kind === "attempt-cap") {
      out.push(kept(task.id, park.line, `attempt-cap park: its exhausted attempt budget is refilled only by the operator's fresh-budget approve decision, never by a definition change — ${next}`));
      continue;
    }
    if (!(PARK_KINDS as readonly string[]).includes(park.kind ?? "")) continue; // an unlisted kind keeps the base
    const path = after.some((e) => e.event === "run-end") ? ENDED_PATH : STOPPED_PATH;
    out.push({ taskId: task.id, park: { ...park, ts: park.ts }, from, to, path, next });
  }
  return out;
}

const releasable = (c: SplitDecision | Releasable): c is Releasable => !("event" in c);

/** The parked tasks whose work the decision must read: open, recorded, changed and not exempt. */
export function splitReleaseReads(input: SplitReleaseInput): string[] {
  return classify(input).filter(releasable).map((c) => c.taskId);
}

/**
 * Per open park: a release (task-approved bound to the park's token, recheck when the read proves commits
 * ahead of the task base, plain when it proves none), a kept park with its reason, or nothing (absent).
 * A missing or failed read proves neither, so it keeps the park.
 */
export function decideSplitRelease(input: SplitReleaseInput, work: ReadonlyMap<string, TaskWorkRead>): SplitDecision[] {
  return classify(input).map((c): SplitDecision => {
    if (!releasable(c)) return c;
    const read = work.get(c.taskId);
    if (!read || "error" in read || (read.commits > 0 && !read.head)) {
      const why = !read ? "no read was taken" : "error" in read ? read.error : "the read counted commits but named no head";
      return kept(c.taskId, c.park.line, `reading the task work failed (${why}), so neither a committed head nor its absence is proved — ${c.next}`);
    }
    const recheck = read.commits > 0;
    return {
      taskId: c.taskId,
      event: "task-approved",
      data: {
        by: RELEASED_BY,
        via: "resume",
        // row 413 (D-2187 add.100 M2): the operator asked for this release by changing the spec, so its red
        // battery funds a repair EXPLICITLY — the operator recheck's park default never applies here
        ...(recheck ? { release: RECHECK_RELEASE, onRed: "repair" } : {}),
        // the battery gates a recovered preserved ref exactly, as it does approve's failed-task recheck (OBS-1022)
        ...(recheck && read.ref !== undefined ? { recheckedRef: read.ref } : {}),
        // OBS-1202: a stall park's recorded reap failure rides the recheck, so the battery's census guard runs first
        ...(recheck && c.park.reapFailure !== undefined ? { reapFailure: c.park.reapFailure } : {}),
        park: { line: c.park.line, ts: c.park.ts },
        engagement: {
          cause: "graph-changed", rehash: { ...input.rehash! }, from: c.from, to: c.to, path: c.path,
          // the head the battery re-gates, so the rail can name it
          ...(recheck ? { head: read.head } : {}),
        },
      },
    };
  });
}
