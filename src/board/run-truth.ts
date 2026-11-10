// The live board's truth about a run that cannot finish (queue row 398, D-2187 add.24; PORT-RULES R13). readRunBoard
// applies it after summarize, so summarize.ts and its goldens stay the reference port. Pure: no file, process or clock.
import { tsEpoch, type NeedsYou, type RunSummary, type TaskRow } from "./summarize.js";

/** The ETA with row 398's flag: present (true) only when some task is unreachable; absent reads as at the base. */
export type RunEta = NonNullable<RunSummary["eta"]> & { cannotFinish?: true };
/** Row 398 (c): a task row whose state may also read `blocked`. */
export type RunTask = Omit<TaskRow, "state"> & { state: TaskRow["state"] | "blocked" };
/** Row 398 (d): a channel excluded run-wide and not readmitted, with its cause and the journal line of the row standing. */
export type Exclusion = { channel: string; cause: string; line: number };
/** `exclusions` is present only when some channel stands excluded, so a run with none reads exactly as at the base. */
export type RunTruth = Omit<RunSummary, "eta" | "tasks"> & { eta: RunEta | null; tasks: RunTask[]; exclusions?: Exclusion[] };

const stops = (r: TaskRow): boolean => r.state === "failed" || r.state === "parked";

/** Row 398 (c): the nearest failed or parked task in a task's dependency closure, by graph.ts attributeBlocked's rule
 *  (level order over deps, the first stop found wins); undefined when the closure reaches none, so it is also
 *  blockedTasks' closure test. */
function nearestStop(t: TaskRow, byId: ReadonlyMap<string, TaskRow>): TaskRow | undefined {
  const seen = new Set<string>();
  const queue = [...t.deps];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const dep = byId.get(id);
    if (!dep) continue;
    if (stops(dep)) return dep;
    for (const d of dep.deps) if (!seen.has(d)) queue.push(d);
  }
  return undefined;
}

const data = (e: { data?: unknown }): Record<string, unknown> =>
  typeof e.data === "object" && e.data !== null ? e.data as Record<string, unknown> : {};

/** Row 398 (d): Journal.replayExcludedChannels' fold in journal order, the run-wide exclusion set a resume replays: a
 *  channel-demotion or channel-exclusion row excludes its `channel`, a dead-channel-failover row its `from`, and a
 *  channel-readmit row lifts its `channel`. One entry per channel still excluded, at its latest excluding row, with
 *  pool-exclusion.ts's cause (a demotion's streak, otherwise the row's reason). */
function exclusionsOf(events: readonly unknown[]): Exclusion[] {
  const standing = new Map<string, Exclusion>();
  for (const e of events as Array<{ event?: unknown; data?: unknown; _line?: unknown }>) {
    const d = data(e);
    const channel = e.event === "channel-demotion" || e.event === "channel-exclusion" ? d.channel
      : e.event === "dead-channel-failover" ? d.from : undefined;
    if (typeof channel === "string") {
      standing.delete(channel); // the latest excluding row stands, in its own journal position
      const cause = e.event === "channel-demotion" ? `no-trailer streak ${String(d.streak)}` : String(d.reason ?? e.event);
      standing.set(channel, { channel, cause, line: e._line as number });
    } else if (e.event === "channel-readmit" && typeof d.channel === "string") {
      standing.delete(d.channel);
    }
  }
  return [...standing.values()];
}

/** The router's floor-pool refusal (router.ts, a pool with no live channel at the task floor), as a journal error
 *  carries it after `RoutingError: `. A list never holds `; ` or a line break, so a lazy declared list ends exactly
 *  at the skipped or doctor-found clause; any other text does not match and is kept whole. */
const FLOOR_POOL = /^(?:RoutingError: )?\S+: routing\.map\.(\S+)\.pool has no live channel at task floor (\S+) — declared: (.+?)(?:; skipped .+?)?; doctor found: (.*)$/u;

/** Row 398 (e): a failed task's full error, the floor-pool form summarized per declared channel: excluded run-wide when
 *  an exclusions entry names it, else below floor when doctor found it, else not found; a counter at zero is omitted. */
export function failureNote(error: string, exclusions: readonly Exclusion[]): string {
  const m = FLOOR_POOL.exec(error);
  if (!m) return error;
  const [, shape, tier, declared, found] = m;
  const excluded = new Set(exclusions.map((x) => x.channel));
  const doctor = new Set(found.split(", "));
  const listed = declared.split(", ");
  const named = listed.filter((c) => excluded.has(c));
  const below = listed.filter((c) => !excluded.has(c) && doctor.has(c)).length;
  const missing = listed.length - named.length - below;
  const counts = [named.length ? `${named.length} excluded run-wide (${named.join(", ")})` : "",
    below ? `${below} below floor` : "", missing ? `${missing} not found` : ""].filter(Boolean);
  return `pool ${shape} has no live channel at floor ${tier}: ${counts.join(", ")}`;
}

/** The summary with row 398 (a) to (e) applied. `events` are the journal events summarize read, each with its `_line`. */
export function runTruth(summary: RunSummary, events: readonly unknown[]): RunTruth {
  const byId = new Map(summary.tasks.map((t) => [t.id, t]));
  // (a) a task is unreachable when it is not done and it is failed or parked, or its closure reaches such a task
  const unreached = summary.tasks.filter((t) => t.state !== "done" && (stops(t) || nearestStop(t, byId) !== undefined));
  // (a) the roots are the unreachable tasks that are themselves failed or parked; the minutes are zeroed, never a
  // time the run cannot meet, and stay numbers so the wire shape holds for an older pane
  const eta: RunEta | null = summary.eta && unreached.length
    ? { ...summary.eta, cleanMin: 0, oneRepairMin: 0, stoppedBy: unreached.filter(stops).map((t) => t.id), cannotFinish: true }
    : summary.eta;
  const failure = new Map<unknown, { since: number; data: Record<string, unknown> }>();
  for (const e of events as Array<{ event?: unknown; taskId?: unknown; ts?: unknown; data?: unknown }>) {
    // the latest failure is the one standing
    if (e.event === "task-failed") failure.set(e.taskId, { since: tsEpoch(e.ts), data: data(e) });
  }
  const exclusions = exclusionsOf(events);
  // (e) a failed task's note is its full error, the base's `error`, else `reason`, never cut at 90 code points; the
  // now-sentence is the base's `failed — <note>` over it. ponytail: a non-string error keeps the base's text, which
  // the daemon never writes (String(err)); port Python's str here if one ever lands
  const noted = (t: TaskRow): TaskRow => {
    if (t.state !== "failed") return t;
    const d = (failure.get(t.id) as { data: Record<string, unknown> }).data;
    const raw = Object.hasOwn(d, "error") ? d.error : Object.hasOwn(d, "reason") ? d.reason : "";
    if (typeof raw !== "string") return t;
    const note = failureNote(raw, exclusions);
    return note === t.note ? t : { ...t, note, now: `failed — ${note}` };
  };
  // (c) a pending task whose closure reaches a failed or parked task is blocked (graph.ts blockedTasks, the run-end
  // row's bucket) and names its nearest root; a task waiting on running work keeps the base's `waits on` sentence
  const tasks = summary.tasks.map((t): RunTask => {
    const root = t.state === "pending" ? nearestStop(t, byId) : undefined;
    return root ? { ...t, state: "blocked", now: `blocked by ${root.id} (${root.state})`, nowSince: null } : noted(t);
  });
  // (b) one entry per failed task, after the base's park entries, which are kept as they are; summarize fails a row
  // only on its task-failed event, so every failed task has a time
  const failed: NeedsYou[] = tasks.filter((t) => t.state === "failed").map((t) => ({
    task: t.id, kind: "failed", reason: t.note, since: (failure.get(t.id) as { since: number }).since, blocks: t.blocks,
    cmd: "tickmarkr resume {run} --retry-failed",
  }));
  // (d) the run-wide exclusions, only when some channel stands excluded (an absent field reads as none)
  return { ...summary, tasks, eta, needsYou: [...summary.needsYou, ...failed], ...(exclusions.length ? { exclusions } : {}) };
}
