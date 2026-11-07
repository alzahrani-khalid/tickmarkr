import { readFileSync } from "node:fs";
import type { GateResult } from "../gates/types.js";
import type { JournalEvent } from "./journal.js";

export type FailureDisposition = "infrastructure" | "behavioral" | "interrupted" | "unknown";
export type VerificationRetryCause = "infrastructure" | "host-starved";

/** Row 337 (D-2181 D1): a measured failing-file window, from its report's start to its completion. */
export interface FailureWindow { file: string; from: number; to: number }

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const usableInterruption = (v: unknown): v is { kind: string; from: number; to: number } => record(v)
  && (v.kind === "host-suspend" || v.kind === "unknown") && finite(v.from) && finite(v.to) && v.from <= v.to
  && finite(v.wallMs) && finite(v.monoMs) && finite(v.subtractedMs);
const usableWindow = (v: unknown): v is FailureWindow => record(v)
  && typeof v.file === "string" && finite(v.from) && finite(v.to) && v.from <= v.to;

/**
 * Row 337 (D-2181 D1): why a FAILED verdict (or any verdict recording that disposition) is interrupted — inconclusive infrastructure, never a
 * behavioral red, a forgiven green or reusable proof — or undefined when the closed table keeps its
 * existing disposition. Reads the verdict meta or its journal row alike; the raw red evidence stays.
 * Overlap is inclusive, and a failing file with no usable measured window never proves non-overlap.
 */
export function interruptedReason(result: { pass?: unknown; meta?: Record<string, unknown> }): string | undefined {
  const meta = result.meta;
  if (!meta) return undefined;
  // An explicit interrupted disposition is authoritative even beside a contradicting pass: true, so no
  // cache boundary stores or reuses such a record as green proof.
  if (meta.disposition === "interrupted") return "recorded interrupted disposition";
  if (result.pass !== false) return undefined;
  const raw = meta.interruptions;
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return undefined;
  if (!Array.isArray(raw) || !raw.every(usableInterruption)) return "unreadable interruption evidence: a malformed interruption record";
  const failing = meta.failingFiles;
  // An infrastructure red naming no failing file keeps its existing (non-behavioral) disposition.
  if (failing === undefined && meta.classification !== "regression") return undefined;
  if (!Array.isArray(failing) || !failing.length || !failing.every((f) => typeof f === "string" && f))
    return "unreadable failing-file evidence: overlap with the interruption is unproved";
  const windows = meta.failureWindows;
  for (const file of failing as string[]) {
    const own = Array.isArray(windows) ? windows.filter((w) => record(w) && w.file === file) : [];
    if (!own.length || !own.every(usableWindow))
      return `no usable measured window for ${file}: overlap with the interruption is unproved`;
    const hit = raw.find((i) => own.some((w) => i.from <= w.to && i.to >= w.from));
    if (hit) return `${hit.kind} interruption overlaps ${file}`;
  }
  return undefined;
}

export const isInterruptedResult = (result: { pass?: unknown; meta?: Record<string, unknown> }): boolean =>
  interruptedReason(result) !== undefined;

/** Structured verifier evidence wins; neither an exit code nor prose proves infrastructure. An
 * interrupted red outranks its raw regression classification (row 337, D-2181 D1). */
export function failureDisposition(result: Pick<GateResult, "pass" | "meta">): FailureDisposition {
  if (result.pass) return "unknown";
  if (isInterruptedResult(result)) return "interrupted";
  if (result.meta?.classification === "regression") return "behavioral";
  if (result.meta?.infra === true && result.meta?.classification === "infra") return "infrastructure";
  return "unknown";
}

/** Reserve before re-execution. Interrupted reservations and new subjects never refill the task cap. */
export function reserveInfrastructureRetry(
  events: readonly JournalEvent[], taskId: string, subject: string,
  append: (event: string, taskId: string, data: Record<string, unknown>) => void,
  cause: VerificationRetryCause = "infrastructure",
): boolean {
  const used = events.filter((e) => e.taskId === taskId && e.event === "infra-retry-reserved");
  const malformed = used.some((e) => typeof e.data.subject !== "string" || !e.data.subject
    || (e.data.cause !== "infrastructure" && e.data.cause !== "host-starved"));
  const reason = !subject ? "unknown-subject" : malformed ? "invalid-accounting"
    : used.some((e) => e.data.subject === subject) ? "subject-allowance-exhausted"
    : used.length >= 2 ? "task-allowance-exhausted" : undefined;
  if (reason) {
    append("infra-retry-denied", taskId, { subject, cause, reason, consumed: used.length });
    return false;
  }
  append("infra-retry-reserved", taskId, { subject, cause, consumed: used.length + 1 });
  return true;
}

/** Row 337 (D-2181 D2): the durable, run/task-scoped reservation of an interrupted red's one
 * automatic test-only retry. Never a worker attempt, repair selection, consult or escalation. */
export const INTERRUPTED_RETRY_EVENT = "test-interrupted-retry-reserved";

/** Row 337 (D-2181 D2): the durable claim an interrupted subject's operator recheck journals BEFORE it
 * launches its one fresh full execution, data `{ commit }`, scoped by the row's taskId within its run. Never
 * drawn from or refilling the automatic reservation; a restart never launches a second one under it. */
export const INTERRUPTED_RECHECK_EVENT = "test-interrupted-recheck-claimed";

/** The invocation-id suffix of a manifest DISCOVERY listing: it lists files and executes no test. */
export const LISTING_INVOCATION_SUFFIX = "-listing";

/** A receipt that positively names a started test-command invocation — not a manifest listing, not a
 * spawn that never started, not another gate's command. */
const startedTestInvocation = (r: unknown): boolean => record(r) && typeof r.invocationId === "string" && r.invocationId !== ""
  && !r.invocationId.endsWith(LISTING_INVOCATION_SUFFIX) && record(r.subject) && r.subject.gate === "test"
  && record(r.termination) && (r.termination.kind === "exit" || r.termination.kind === "signal" || r.termination.kind === "timeout");

/** Row 337 (D-2181 D2): a full test result that EXECUTED on its subject, read from its journal row. It
 * needs positive execution evidence — a started test invocation's receipt — so a dependency-link or
 * dirty-entry refusal (no receipt) and a discovery failure (listing receipts only) never qualify, and
 * neither does a reuse, a journal replay copy (`replayedFromAttempt`, which carries copied receipts) or
 * a selected screen. A full job that ran and THEN left dirt keeps its receipts on the dirty refusal: it
 * executed, so it qualifies. A resume's `replayMeasurement` re-observation is a fresh invocation and does. */
export function executedFullTest(data: Record<string, unknown>): boolean {
  return data.gate === "test" && typeof data.pass === "boolean" && data.skipped !== true && data.reused !== true
    && data.replayedFromAttempt === undefined
    && (data.selectedTests === undefined || data.fullSuite === true)
    && [data.evidenceReceipt, ...(Array.isArray(data.evidenceReceipts) ? data.evidenceReceipts : [])].some(startedTestInvocation);
}

/** The last executed full test row on the subject (row 337, D-2181 D2). */
export function lastExecutedTest(
  events: readonly Pick<JournalEvent, "event" | "taskId" | "data">[], taskId: string, subject: string,
): Pick<JournalEvent, "event" | "taskId" | "data"> | undefined {
  return events.filter((e) => e.taskId === taskId && e.event === "gate-result" && record(e.data)
    && e.data.commit === subject && executedFullTest(e.data)).at(-1);
}

export type InterruptedRetryState =
  | { kind: "unreserved" }
  /** Reserved, but no executed full test result on the subject was persisted after it. */
  | { kind: "reserved"; attempt: number }
  /** Consumed by the first executed full test result after it, whatever its disposition. */
  | { kind: "consumed"; attempt: number; by: Pick<JournalEvent, "event" | "taskId" | "data"> }
  | { kind: "unprovable"; reason: string };

/** Row 337 (D-2181 D2): a row the accounting fold can attribute — an event name, a data object and a task
 * identity that is absent (a run-level row) or a non-empty string; a reservation, recheck claim or gate
 * observation always names its task, and a recheck claim its subject. Checked over EVERY row before any task
 * or subject filter, so a malformed row never vanishes as "another task's" or "another subject's". */
const OWNED = new Set([INTERRUPTED_RETRY_EVENT, INTERRUPTED_RECHECK_EVENT, "gate-result"]);
export const attributable = (e: unknown): boolean => record(e) && typeof e.event === "string" && e.event !== "" && record(e.data)
  && (e.taskId === undefined ? !OWNED.has(e.event) : typeof e.taskId === "string" && e.taskId !== "")
  && (e.event !== INTERRUPTED_RECHECK_EVENT || (typeof e.data.commit === "string" && e.data.commit !== ""));

/** Row 337 (D-2181 D2): why the task's interruption accounting is unprovable, whatever subject is asked
 * about — every row attributable, every reservation well formed and unique per subject, every interrupted
 * test observation naming a readable subject — or undefined when it proves something. */
function accountingRefusal(events: readonly Pick<JournalEvent, "event" | "taskId" | "data">[], taskId: string): string | undefined {
  if (!events.every(attributable)) return "malformed journal row or task identity";
  const own = events.filter((e) => e.taskId === taskId);
  const reservations = own.filter((e) => e.event === INTERRUPTED_RETRY_EVENT);
  if (reservations.some((e) => typeof e.data.commit !== "string" || !e.data.commit
    || !Number.isInteger(e.data.attempt) || (e.data.attempt as number) < 0)) return "malformed interruption retry reservation";
  if (new Set(reservations.map((e) => e.data.commit)).size < reservations.length) return "duplicate interruption retry reservations for one subject";
  if (own.some((e) => e.event === "gate-result" && e.data.gate === "test" && (typeof e.data.commit !== "string" || !e.data.commit)
    && isInterruptedResult({ pass: e.data.pass, meta: e.data }))) return "an interrupted test observation names no readable subject";
  return undefined;
}

/** The closed accounting fold. A consumed reservation is never replenished: not by a park, an
 * approval, a restart or another round. Missing subject or malformed accounting proves nothing. */
export function interruptedRetryState(
  events: readonly Pick<JournalEvent, "event" | "taskId" | "data">[], taskId: string, subject: unknown,
): InterruptedRetryState {
  if (typeof subject !== "string" || !subject) return { kind: "unprovable", reason: "missing subject" };
  const reason = accountingRefusal(events, taskId);
  if (reason !== undefined) return { kind: "unprovable", reason };
  const own = events.filter((e) => e.taskId === taskId);
  const mine = own.find((e) => e.event === INTERRUPTED_RETRY_EVENT && e.data.commit === subject);
  if (!mine) return { kind: "unreserved" };
  const attempt = mine.data.attempt as number;
  const by = own.slice(own.indexOf(mine) + 1)
    .find((e) => e.event === "gate-result" && e.data.commit === subject && executedFullTest(e.data));
  return by ? { kind: "consumed", attempt, by } : { kind: "reserved", attempt };
}

/** Every interrupted test observation journaled on the subject (on any, when none is named), each
 * interruption's measurements named. */
export function interruptedObservations(
  events: readonly Pick<JournalEvent, "event" | "taskId" | "data">[], taskId: string, subject?: string,
): { attempt: unknown; interruptions: { kind: string; wallMs: number; monoMs: number }[] }[] {
  return events.filter((e) => e.taskId === taskId && e.event === "gate-result" && record(e.data)
    && e.data.gate === "test" && (subject === undefined || e.data.commit === subject) && e.data.reused !== true
    && isInterruptedResult({ pass: e.data.pass, meta: e.data }))
    .map((e) => ({
      attempt: e.data.attempt,
      interruptions: (Array.isArray(e.data.interruptions) ? e.data.interruptions : []).filter(record)
        .map((i) => ({ kind: String(i.kind), wallMs: Number(i.wallMs), monoMs: Number(i.monoMs) })),
    }));
}

/** Row 337 (D-2181 D2): the journal read STRICTLY for interruption accounting. The ordinary reader drops
 * a line it cannot parse; a dropped reservation would then read as an unused allowance, so here every
 * unparseable or non-object line is counted, by its physical 1-based line. Never throws: a failed read is
 * its own result. */
export function readAccountingJournal(path: string):
  { ok: true; events: JournalEvent[]; unreadable: number; unreadableLines: number[] } | { ok: false; error: string } {
  try {
    const events: JournalEvent[] = [];
    const unreadableLines: number[] = [];
    for (const [i, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const row: unknown = JSON.parse(line);
        if (record(row)) events.push(row as unknown as JournalEvent); else unreadableLines.push(i + 1);
      } catch { unreadableLines.push(i + 1); }
    }
    return { ok: true, events, unreadable: unreadableLines.length, unreadableLines };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface InterruptedLedger {
  state: InterruptedRetryState;
  /** Every interrupted observation safely read on the subject — what a park names. */
  observations: ReturnType<typeof interruptedObservations>;
  /** The last executed full test row on the subject, when the read proves one. */
  last: Pick<JournalEvent, "event" | "taskId" | "data"> | undefined;
  /** The subject's interruption accounting is in play: an interrupted observation, a reservation or a
   * recheck claim ON THIS SUBJECT, or unprovable accounting — a torn line, an unowned row or an interrupted
   * observation, reservation or claim naming no readable subject could be this subject's, so it is never
   * excluded as another task's or subject's. Another subject's valid row never involves this one. */
  involved: boolean;
}

/** Row 337 (D-2181 D2): the task's accounting refused before ANY subject, candidate or claim is known —
 * a failed read, an unreadable line or a malformed row — naming every interrupted observation it safely
 * read; undefined when it reads whole. The one validation boundary every resumed or approved task passes. */
export function refusedLedger(read: ReturnType<typeof readAccountingJournal>, taskId: string): InterruptedLedger | undefined {
  const reason = !read.ok ? `unreadable accounting: ${read.error}`
    : read.unreadable ? `${read.unreadable} unreadable journal line(s); a dropped reservation would read as an unused allowance`
    : accountingRefusal(read.events, taskId);
  return reason === undefined ? undefined
    : { state: { kind: "unprovable", reason }, observations: read.ok ? interruptedObservations(read.events, taskId) : [], last: undefined, involved: true };
}

/** Row 337 (D-2181 D2): the one accounting fold every daemon caller reads. A failed read or any
 * unreadable line is unprovable accounting — never an unreserved allowance — and unprovable is always
 * involved, never "nothing to account for". */
export function interruptedLedger(read: ReturnType<typeof readAccountingJournal>, taskId: string, subject: string): InterruptedLedger {
  const events = read.ok ? read.events : [];
  const state = refusedLedger(read, taskId)?.state ?? interruptedRetryState(events, taskId, subject);
  const observations = interruptedObservations(events, taskId, subject);
  const involved = state.kind === "unprovable" || observations.length > 0 || events.some((e) => e.taskId === taskId
    && (e.event === INTERRUPTED_RETRY_EVENT || e.event === INTERRUPTED_RECHECK_EVENT) && e.data.commit === subject);
  return { state, observations, last: lastExecutedTest(events, taskId, subject), involved };
}
