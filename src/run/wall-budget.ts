import { gateDeclined } from "../report/bundle.js";
import type { JournalEvent } from "./journal.js";

/**
 * OBS-1201: where a run's wall time went. Every instant of the engagement window lands in exactly ONE
 * bucket — the first of WALL_PRIORITY with a span covering it — and what no span covers is residual,
 * so the exposed buckets always sum to the wall. Task-time sums every span as recorded, so concurrent
 * work (two workers, four suites waiting on one lease) stays visible without inflating the wall.
 *
 * Only journaled observations become spans: a fresh gate row's measured duration less the matched
 * suite waits inside it, a worker launch matched to its result, a suite wait matched to its admission,
 * and the gap a restart left between one engagement's last row and the next run-resume. A copy of
 * evidence — a cache reuse, a journal replay, a row naming an invocation already counted — never adds
 * a span; a reused full suite's row still times the fresh screen it carries. A row without a duration, a launch, wait or gate start with no matching end, and one cut by
 * a restart are counted, never timed. Residual
 * is unattributed time, not a claim of idleness. Pure: journal rows in, numbers out.
 */
export const WALL_PRIORITY = ["interruption", "test", "semantics", "worker", "queue", "other-gate"] as const;
export type WallBucket = (typeof WALL_PRIORITY)[number];

type PerBucket = Record<WallBucket, number>;

export interface WallBudget {
  wallMs: number;
  exposedMs: PerBucket;
  residualMs: number;
  taskMs: PerBucket;
  /** Gate-result rows by provenance. A declined gate never ran and is none of these. */
  evidence: { fresh: number; replay: number; reuse: number; unknown: number };
  /** Evidence that exists but carries no timing: rows without a duration, unmatched and interrupted starts. */
  untimed: Record<WallBucket, { unknown: number; unmatched: number; interrupted: number }>;
}

const perBucket = (): PerBucket =>
  Object.fromEntries(WALL_PRIORITY.map((bucket) => [bucket, 0])) as PerBucket;

const at = (e: JournalEvent): number => Date.parse(e.ts);
const measured = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

const bucketOf = (gate: string): WallBucket =>
  gate === "test" ? "test" : gate === "acceptance" || gate === "review" ? "semantics" : "other-gate";

// Rows another process writes around a restart — the operator's approval, the resuming daemon's
// reclaim and rehash audit — so the prior engagement's own last row is the one before them.
// ponytail: a closed list; a new out-of-engagement writer lengthens the interruption it precedes.
const OUTSIDE_ENGAGEMENT = new Set(["task-approved", "graph-rehash", "lock-reclaimed", "superseded"]);
const outsideEngagement = (e: JournalEvent): boolean =>
  OUTSIDE_ENGAGEMENT.has(e.event) || (e.event === "exit-cause" && e.data.cause === "unclean");

const WORKER_END = new Set(["worker-result", "worker-dead", "worker-hard-timeout"]);

const invocationOf = (data: Record<string, unknown>): string | undefined => {
  if (typeof data.nonce === "string") return data.nonce;
  const receipt = data.evidenceReceipt as { invocationId?: unknown } | undefined;
  return typeof receipt?.invocationId === "string" ? receipt.invocationId : undefined;
};

/** Undefined when the journal names no measurable window (no run-start, or unreadable timestamps). */
export function wallBudget(events: readonly JournalEvent[]): WallBudget | undefined {
  const first = events.findIndex((e) => e.event === "run-start");
  if (first < 0) return undefined;
  const lastOf = (event: string) => events.map((e) => e.event).lastIndexOf(event);
  const lastEnd = lastOf("run-end");
  const lastResume = lastOf("run-resume");
  const from = at(events[first]!);
  // A closed engagement ends at its run-end; an open or crashed one at its newest row.
  const to = at(events[lastEnd > lastResume ? lastEnd : events.length - 1]!);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return undefined;

  const spans: Array<{ bucket: WallBucket; from: number; to: number }> = [];
  const span = (bucket: WallBucket, a: number, b: number) => {
    const s = Math.max(a, from);
    const t = Math.min(b, to);
    if (Number.isFinite(s) && Number.isFinite(t) && t > s) spans.push({ bucket, from: s, to: t });
  };
  const evidence = { fresh: 0, replay: 0, reuse: 0, unknown: 0 };
  const untimed = Object.fromEntries(WALL_PRIORITY.map((bucket) => [bucket, { unknown: 0, unmatched: 0, interrupted: 0 }])) as WallBudget["untimed"];
  const counted = new Set<string>();
  // A gate row is journaled when its whole round settles (acceptance, review and test often share one
  // timestamp), so its measured duration is anchored at the gate's FIRST phase-start in the round.
  const gateStarts = new Map<string, Map<string, number>>();
  const workers = new Map<string, number>();
  // A dispatch that never journals a launch (every pre-launch-row journal) ran a worker nobody timed.
  const dispatched = new Set<string>();
  // A wait is owned by the gate whose command was admitted (the daemon names it when the phase is
  // unambiguous; a parallel sibling leaves it absent). Its measurement started before admission, so
  // a matched wait inside that gate's own span is queue, not service, and is cut out before priority
  // applies. Sibling gates keep executing through it, so nothing is cut from them. A wait naming no
  // gate belongs to the suite lease, which is the test gate's.
  const owner = (task: string, gate: unknown) => `${task}\0${typeof gate === "string" ? gate : "test"}`;
  const waits = new Map<string, number>();
  const queued = new Map<string, Array<[number, number]>>();
  const admit = (task: string, gate: unknown, ts: number) => {
    const key = owner(task, gate);
    const opened = waits.get(key);
    if (opened === undefined) return;
    span("queue", opened, ts);
    // One open wait per owner, closed in journal order: the list stays sorted and non-overlapping.
    queued.set(key, [...(queued.get(key) ?? []), [opened, ts]]);
    waits.delete(key);
  };
  const service = (gate: string, task: string, a: number, b: number) => {
    const bucket = bucketOf(gate);
    // One linear sweep over the sorted waits; span() drops any empty or inverted piece.
    let cursor = a;
    for (const [ws, we] of queued.get(owner(task, gate)) ?? []) {
      if (we <= cursor || ws >= b) continue;
      span(bucket, cursor, ws);
      cursor = Math.max(cursor, we);
    }
    span(bucket, cursor, b);
  };
  // A gate that started and never journaled its result is evidence without timing, never a zero.
  const untimedStarts = (starts: Map<string, number> | undefined, kind: "unmatched" | "interrupted") => {
    for (const gate of starts?.keys() ?? []) untimed[bucketOf(gate)][kind]++;
  };

  for (let i = first + 1; i < events.length; i++) {
    const e = events[i]!;
    const task = e.taskId ?? "";
    const ts = at(e);
    switch (e.event) {
      case "run-resume": {
        let last = i - 1;
        while (last > first && outsideEngagement(events[last]!)) last--;
        span("interruption", at(events[last]!), ts);
        untimed.worker.interrupted += workers.size;
        untimed.worker.unknown += dispatched.size;
        untimed.queue.interrupted += waits.size;
        for (const starts of gateStarts.values()) untimedStarts(starts, "interrupted");
        workers.clear();
        dispatched.clear();
        waits.clear();
        gateStarts.clear();
        break;
      }
      case "phase-start": {
        if (e.data.phase === "gates") {
          untimedStarts(gateStarts.get(task), "unmatched");
          gateStarts.delete(task);
        }
        else if (typeof e.data.gate === "string") {
          const starts = gateStarts.get(task) ?? new Map<string, number>();
          if (!starts.has(e.data.gate)) starts.set(e.data.gate, ts);
          gateStarts.set(task, starts);
        }
        if (e.data.admitted === true) admit(task, e.data.gate, ts);
        break;
      }
      case "suite-admitted":
        admit(task, undefined, ts);
        break;
      case "suite-wait":
        // Repeated rows while a wait is open re-report its count; they do not open a second wait.
        if (!waits.has(owner(task, e.data.gate))) waits.set(owner(task, e.data.gate), ts);
        break;
      case "task-dispatch":
        if (dispatched.has(task)) untimed.worker.unknown++;
        dispatched.add(task);
        break;
      case "worker-launch":
        if (workers.has(task)) untimed.worker.unmatched++;
        workers.set(task, ts);
        dispatched.delete(task);
        break;
      case "gate-provisioned":
        if (measured(e.data.durationMs)) service(typeof e.data.gate === "string" ? e.data.gate : "build", task, ts - e.data.durationMs, ts);
        break;
      case "gate-result": {
        const gate = e.data.gate;
        if (typeof gate !== "string") break;
        const anchor = gateStarts.get(task)?.get(gate);
        gateStarts.get(task)?.delete(gate);
        if (gateDeclined(e.data)) break;
        const bucket = bucketOf(gate);
        const invocation = invocationOf(e.data);
        const identity = invocation === undefined ? undefined : `${gate}\0${invocation}`;
        if (e.data.reused === true) {
          evidence.reuse++;
          // A held screen runs fresh before its full suite is carried from the cache, and the one
          // merge-candidate row holds both: the screen's measured interval is fresh execution, the
          // carried suite adds none. A replay's copy is not a measurement of this attempt.
          const screen = e.data.fullSuite === true && e.data.replayedFromAttempt === undefined ? e.data.selectedDurationMs : undefined;
          if (!measured(screen) || screen <= 0) break;
          evidence.fresh++;
          const screenFrom = anchor ?? ts - screen;
          service(gate, task, screenFrom, Math.min(screenFrom + screen, ts));
          break;
        }
        if (e.data.replayedFromAttempt !== undefined || (identity !== undefined && counted.has(identity))) { evidence.replay++; break; }
        if (identity !== undefined) counted.add(identity);
        const d = e.data.durationMs;
        if (!measured(d)) { evidence.unknown++; untimed[bucket].unknown++; break; }
        evidence.fresh++;
        const full = e.data.fullSuite === true && measured(e.data.fullDurationMs) && measured(e.data.selectedDurationMs);
        if (anchor === undefined) service(gate, task, ts - d, ts);
        else if (full) {
          // The full suite ends at the row; the selected run began at the gate's first phase-start.
          const fullFrom = ts - (e.data.fullDurationMs as number);
          service(gate, task, anchor, Math.min(anchor + (e.data.selectedDurationMs as number), fullFrom));
          service(gate, task, fullFrom, ts);
        } else service(gate, task, anchor, Math.min(anchor + d, ts));
        break;
      }
      default:
        if (WORKER_END.has(e.event) && workers.has(task)) {
          span("worker", workers.get(task)!, ts);
          workers.delete(task);
        }
    }
  }
  untimed.worker.unmatched += workers.size;
  untimed.worker.unknown += dispatched.size;
  untimed.queue.unmatched += waits.size;
  for (const starts of gateStarts.values()) untimedStarts(starts, "unmatched");

  const taskMs = perBucket();
  for (const s of spans) taskMs[s.bucket] += s.to - s.from;
  // One sweep over span edges: each segment goes to the highest-priority bucket still open over it.
  const rank = (bucket: WallBucket) => WALL_PRIORITY.indexOf(bucket);
  const edges = spans.flatMap((s) => [[s.from, rank(s.bucket), 1], [s.to, rank(s.bucket), -1]] as const)
    .sort((a, b) => a[0] - b[0]);
  const open = WALL_PRIORITY.map(() => 0);
  const exposedMs = perBucket();
  let cursor = from;
  for (const [t, r, delta] of edges) {
    if (t > cursor) {
      const top = open.findIndex((n) => n > 0);
      if (top >= 0) exposedMs[WALL_PRIORITY[top]!] += t - cursor;
      cursor = t;
    }
    open[r]! += delta;
  }
  const wallMs = to - from;
  const residualMs = wallMs - WALL_PRIORITY.reduce((sum, bucket) => sum + exposedMs[bucket], 0);
  return { wallMs, exposedMs, residualMs, taskMs, evidence, untimed };
}

/** Whole seconds past a minute, one decimal below ten seconds — never a rounded-away "0s" for a real span. */
export const formatSpan = (ms: number): string => {
  if (ms > 0 && ms < 10_000) return `${(Math.ceil(ms / 100) / 10).toString()}s`;
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3_600)}h ${Math.floor((s % 3_600) / 60)}m`;
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * One fact per bucket, then residual and the evidence tally — the words every surface prints. A
 * bucket whose only evidence is untimed reads `unknown`, never a zero it did not measure.
 */
export function wallBudgetFacts(b: WallBudget): Array<[label: string, fact: string]> {
  const pct = (ms: number) => b.wallMs > 0 ? ` (${Math.round((100 * ms) / b.wallMs)}%)` : "";
  const facts = WALL_PRIORITY.map((bucket): [string, string] => {
    const { unknown, unmatched, interrupted } = b.untimed[bucket];
    const notes = [
      ...(unknown ? [bucket === "worker"
        ? `${unknown} ${unknown === 1 ? "dispatch" : "dispatches"} without a launch row`
        : `${plural(unknown, "row")} without a duration`] : []),
      ...(unmatched ? [`${unmatched} unmatched`] : []),
      ...(interrupted ? [`${interrupted} cut by a restart`] : []),
    ];
    if (!b.exposedMs[bucket] && !b.taskMs[bucket] && notes.length) return [bucket, `unknown — ${notes.join(" · ")}`];
    const timed = `${formatSpan(b.exposedMs[bucket])}${pct(b.exposedMs[bucket])} · task-time ${formatSpan(b.taskMs[bucket])}`;
    return [bucket, [timed, ...notes.map((note) => `${note}, untimed`)].join(" · ")];
  });
  const { fresh, replay, reuse, unknown } = b.evidence;
  return [
    ...facts,
    ["residual", `${formatSpan(b.residualMs)}${pct(b.residualMs)} — unattributed, not proven idle`],
    ["gate evidence", `fresh ${fresh} · replay ${replay} · reuse ${reuse} · unknown ${unknown}`],
  ];
}

export const WALL_PRIORITY_TEXT = [...WALL_PRIORITY, "residual"].join(" › ");
