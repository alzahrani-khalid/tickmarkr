import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { loadGraph, stateDirName } from "../../graph/graph.js";
import { GATE_NAMES } from "../../graph/schema.js";
import { decisionCommands } from "../../run/decision-verbs.js";
import { effectiveEvents, fatalRunEndCause, Journal, physicalLine, type JournalEvent } from "../../run/journal.js";
import { readOperatorState } from "../../run/operator-state.js";
import { newestPark, parkToken } from "./approve.js";
import { currentOwed } from "./report.js";
import { daemonLiveness, readRunRecord, recordProjection } from "./status.js";

const instant = z.iso.datetime({ offset: true });
const gate = z.enum(["unknown", "not-run", "disabled", "queued", "running", "passed", "failed"]);
const bucket = z.array(z.string()).nullable();

/** Closed wire contract. Every field is present, including explicit unknowns. */
export const StatusSnapshotSchema = z.strictObject({
  version: z.literal(1),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  observedAt: instant,
  daemon: z.enum(["alive", "dead", "unknown"]),
  lifecycle: z.enum(["PENDING", "RUNNING", "PARTIAL", "APPROVED", "COMPLETE", "UNKNOWN"]),
  verdict: z.strictObject({
    green: z.boolean(),
    fatal: z.boolean(),
    currentTip: z.enum(["passed", "not required", "pending", "failed", "unknown"]),
    buckets: z.strictObject({ failed: bucket, human: bucket, blocked: bucket, pending: bucket }),
    outstanding: z.discriminatedUnion("known", [
      z.strictObject({ known: z.literal(true), debt: z.number().int().nonnegative(), checks: z.array(z.string()) }),
      z.strictObject({ known: z.literal(false), reason: z.string().min(1) }),
    ]),
  }),
  approvalWindow: z.strictObject({ opensAt: instant, closesAt: instant, parked: z.array(z.string()) }).nullable(),
  tasks: z.array(z.strictObject({
    id: z.string(), title: z.string(), deps: z.array(z.string()),
    state: z.enum(["unknown", "pending", "running", "completed", "merged", "failed", "human", "blocked"]),
    gates: z.strictObject({ build: gate, test: gate, lint: gate, evidence: gate, scope: gate, acceptance: gate, review: gate }),
    tries: z.strictObject({
      round: z.number().int().positive().nullable(),
      budget: z.number().int().positive(),
      launches: z.number().int().nonnegative(),
    }),
    seats: z.strictObject({ worker: z.string().nullable(), judge: z.string().nullable(), reviewer: z.string().nullable() }),
    startedAt: instant.nullable(), endedAt: instant.nullable(),
    now: z.strictObject({ phase: z.string().nullable(), since: instant.nullable(), blocker: z.string().nullable(), nextAction: z.string().nullable() }),
  })),
  parks: z.array(z.strictObject({
    taskId: z.string(), kind: z.string().nullable(), reason: z.string().nullable(), token: z.string().nullable(),
    commands: z.array(z.strictObject({ verb: z.enum(["approve", "waive", "uphold", "recheck"]), command: z.string() })),
    noDecision: z.string().nullable(),
  })),
});

export type StatusSnapshot = z.infer<typeof StatusSnapshotSchema>;

const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const last = (events: readonly JournalEvent[], name: string, gate?: string): JournalEvent | undefined =>
  [...events].reverse().find(row => row.event === name && (gate === undefined || row.data.gate === gate));

/** Journal evidence closes a window; the observer's clock never invents an expiry event. */
const approvalWindow = (events: readonly JournalEvent[]): StatusSnapshot["approvalWindow"] => {
  let window: StatusSnapshot["approvalWindow"] = null;
  for (const row of events) {
    if (row.event === "approval-window-start") {
      const ms = row.data.windowMs;
      const opens = Date.parse(row.ts);
      window = typeof ms === "number" && Number.isFinite(ms) && ms >= 0 && Number.isFinite(opens)
        && Array.isArray(row.data.parked) && row.data.parked.every(id => typeof id === "string")
        ? { opensAt: row.ts, closesAt: new Date(opens + ms).toISOString(), parked: row.data.parked } : null;
    } else if (["approval-window-expired", "task-approved", "task-dispatch", "run-end", "run-start", "run-resume"].includes(row.event)) {
      window = null;
    }
  }
  return window;
};

/** Pure reader: one journal read supplies lifecycle, current debt, task facts and decisions. */
export function statusSnapshot(cwd: string, runId?: string): StatusSnapshot {
  const graph = loadGraph(cwd);
  // Unlike the live text board, the unnamed machine snapshot selects the newest journalled run.
  const selected = runId ?? Journal.latestRunId(cwd, { withJournal: true });
  if (!selected) throw new Error("no runs yet — status --json requires a run");
  const record = readRunRecord(cwd, graph, selected)!;
  const events = effectiveEvents(record.events);
  const daemon = daemonLiveness(events).state;
  const sequence = record.raw.split("\n").length - (record.raw.endsWith("\n") ? 1 : 0);
  const observedAt = Date.now();
  const source = join(cwd, stateDirName(cwd), "runs", record.runId, "journal.jsonl");
  const basis = createHash("sha256").update(record.raw).digest("hex");
  const readable = record.events.length === record.raw.split("\n").filter(line => line.trim()).length;
  const fold = currentOwed(events, cwd);
  // The same effective rows AND basis feed both authorities. A run-end's owedChecks copy is history.
  const operator = readOperatorState({
    events: events.map((event, index) => {
      const line = physicalLine(events, index);
      return { event, source, line, id: `${source}#L${line}` };
    }),
    graph, source, sequence, observedAt, readable, daemonDead: daemon === "dead",
    owed: { basis, fold }, basis,
  });
  const projection = recordProjection(record, graph, () => daemon !== "dead");
  const tasksById = new Map(operator.tasks.map(task => [task.id, task]));
  const parks: StatusSnapshot["parks"] = [];
  const tasks = graph.tasks.map(task => {
    const own = events.filter(row => row.taskId === task.id);
    const dispatch = last(own, "task-dispatch");
    const repair = last(own, "repair-attempt");
    const assignment = object(dispatch?.data.assignment);
    const acceptance = last(own, "gate-result", "acceptance");
    const invocations = acceptance?.data.invocations;
    const judge = Array.isArray(invocations) ? text(object(invocations.at(-1)).channel) : null;
    const reviewer = text(last(own, "gate-result", "review")?.data.reviewer);
    const state = tasksById.get(task.id);
    const summary = projection.summaries.get(task.id)!;
    if (state?.state === "human") {
      const park = newestPark(events, task.id);
      if (park) {
        const decision = decisionCommands(record.runId, task.id, park);
        parks.push({ taskId: task.id, kind: park.kind ?? null, reason: park.reason ?? null,
          token: parkToken(park) ?? null, commands: [...decision.commands], noDecision: decision.noDecision });
      }
    }
    return {
      id: task.id, title: task.title, deps: task.deps, state: state?.state ?? "unknown",
      gates: Object.fromEntries(GATE_NAMES.map(name => [name, state?.gates[name]?.state ?? "unknown"])),
      tries: {
        round: Number.isInteger(dispatch?.data.attempt) ? Number(dispatch!.data.attempt) + 1 : null,
        budget: Number.isInteger(repair?.data.of) ? Number(repair!.data.of) + 1 : 3,
        launches: own.filter(row => row.event === "worker-launch").length,
      },
      seats: { worker: typeof assignment.adapter === "string" && typeof assignment.model === "string"
        ? `${assignment.adapter}:${assignment.model}` : null, judge, reviewer },
      startedAt: own.find(row => row.event === "task-dispatch")?.ts ?? null,
      endedAt: last(own, "merge")?.ts ?? null,
      now: { phase: summary.phase, since: summary.lastEvidenceAt, blocker: summary.blocker?.kind ?? null, nextAction: summary.blocker?.nextAction ?? null },
    };
  });
  return StatusSnapshotSchema.parse({
    version: 1, runId: record.runId, sequence: record.raw.length ? sequence : 0,
    observedAt: new Date(observedAt).toISOString(), daemon, lifecycle: operator.lifecycle,
    verdict: {
      green: operator.green, fatal: fatalRunEndCause(events) !== undefined, currentTip: operator.currentTip,
      buckets: Object.fromEntries(Object.entries(operator.buckets).map(([name, ids]) => [name, ids ?? null])),
      outstanding: !readable ? { known: false, reason: "complete journal holds an invalid line" }
        : operator.debt === "unknown" ? { known: false, reason: fold.unknown.map(item => item.reason).join("; ") || "current owed checks unknown" }
          : { known: true, debt: operator.debt, checks: operator.outstanding },
    },
    approvalWindow: approvalWindow(events), tasks, parks,
  });
}
