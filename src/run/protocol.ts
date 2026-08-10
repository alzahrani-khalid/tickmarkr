import { z } from "zod";
import { GATE_NAMES, type GateName } from "../graph/schema.js";
import { normalizeGateOutcome, type GateOutcome } from "./outcome.js";

// T32 (F2): the decision protocol is deliberately smaller than the journal. Existing journals contain
// many observational event types and must remain readable; only the five event names below assert a
// decision identity. T38 and T40 will migrate their producers to these rows. Until then, Journal's
// legacy tuple append remains byte-compatible and this module supplies the validated object-write and
// compatibility-read boundaries without dual-writing anything.

const NonEmptyStringSchema = z.string().refine(
  (value) => value.trim().length > 0,
  "must be a non-empty string",
);
const TimestampSchema = NonEmptyStringSchema;
const TaskIdSchema = NonEmptyStringSchema;
const TaskIdsSchema = z.array(TaskIdSchema);
const AttemptSchema = z.number().int().nonnegative();
const EvidenceSchema = z.record(z.string(), z.unknown());

/** The T31 outcome vocabulary, made executable and strict at the persistence boundary. */
export const GateOutcomeSchema: z.ZodType<GateOutcome> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("passed") }).strict(),
  z.object({ kind: z.literal("failed") }).strict(),
  z.object({ kind: z.literal("skipped"), reason: NonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal("declined"), reason: NonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal("held"), reason: NonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal("unavailable"), reason: NonEmptyStringSchema }).strict(),
  z.object({
    kind: z.literal("infra"),
    reason: NonEmptyStringSchema,
    retryable: z.boolean(),
  }).strict(),
]);

export const ROLE_INVOCATION_ROLES = ["worker", "judge", "review", "consult"] as const;
export type RoleInvocationRole = (typeof ROLE_INVOCATION_ROLES)[number];

export const ROLE_INVOCATION_OUTCOMES = ["completed", "failed", "unavailable"] as const;
export type RoleInvocationOutcome = (typeof ROLE_INVOCATION_OUTCOMES)[number];

export const RUN_TERMINAL_OUTCOMES = ["completed", "failed", "incomplete"] as const;
export type RunTerminalOutcome = (typeof RUN_TERMINAL_OUTCOMES)[number];

const MeasuredLoadSchema = z.object({
  oneMinute: z.number().nonnegative(),
  fiveMinute: z.number().nonnegative(),
  cores: z.number().int().positive(),
}).strict();

const UnavailableLoadSchema = z.object({
  unavailableReason: NonEmptyStringSchema,
}).strict();

const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().optional(),
  cacheWrite: z.number().int().nonnegative().optional(),
  reasoning: z.number().int().nonnegative().optional(),
}).strict();

const GatePhaseStartDataSchema = z.object({
  attempt: AttemptSchema,
  gate: z.enum(GATE_NAMES),
  evidence: EvidenceSchema.optional(),
}).strict();

const GateTerminalDataSchema = z.object({
  attempt: AttemptSchema,
  gate: z.enum(GATE_NAMES),
  outcome: GateOutcomeSchema,
  details: z.string().optional(),
  load: z.union([MeasuredLoadSchema, UnavailableLoadSchema]).optional(),
  evidence: EvidenceSchema.optional(),
}).strict();

// Adapter/model/vendor and metering fields are named now so T38 can publish them without reopening
// this schema. They remain optional in T32 because identity/pair integrity lands before that producer
// migration; T38 is the owner that will require them at every live invocation boundary.
const RoleInvocationIdentityDataSchema = z.object({
  attempt: AttemptSchema,
  role: z.enum(ROLE_INVOCATION_ROLES),
  adapter: NonEmptyStringSchema.optional(),
  model: NonEmptyStringSchema.optional(),
  vendor: NonEmptyStringSchema.optional(),
  evidence: EvidenceSchema.optional(),
});

const RoleInvocationStartDataSchema = RoleInvocationIdentityDataSchema.strict();

const RoleInvocationTerminalDataSchema = RoleInvocationIdentityDataSchema.extend({
  outcome: z.enum(ROLE_INVOCATION_OUTCOMES),
  reason: NonEmptyStringSchema,
  tokens: TokenUsageSchema.optional(),
  unmeteredReason: NonEmptyStringSchema.optional(),
}).strict();

const RunTerminalDataSchema = z.object({
  outcome: z.enum(RUN_TERMINAL_OUTCOMES),
  reason: NonEmptyStringSchema,
  // `run-end` is already a live event name. These fields preserve the summary contract consumed by
  // daemon resume and report readers when T40 moves the producer onto this validated object write.
  runId: NonEmptyStringSchema,
  branch: NonEmptyStringSchema,
  done: TaskIdsSchema,
  failed: TaskIdsSchema,
  human: TaskIdsSchema,
  blocked: TaskIdsSchema,
  pending: TaskIdsSchema,
  tipVerify: z.enum(["passed", "failed"]).optional(),
  lastMergedTask: TaskIdSchema.optional(),
  approvalDisposition: z.enum(["complete", "outstanding"]).optional(),
  outstandingApprovals: TaskIdsSchema.optional(),
  phase: NonEmptyStringSchema.optional(),
  fatal: z.boolean().optional(),
  error: z.string().optional(),
  evidence: EvidenceSchema.optional(),
}).strict();

export const GatePhaseStartEventSchema = z.object({
  ts: TimestampSchema,
  // The shipped `phase-start` is a broader task-lifecycle marker. A distinct name prevents its
  // worker/gates/merge payloads from being falsely claimed as malformed gate decisions.
  event: z.literal("gate-phase-start"),
  taskId: TaskIdSchema,
  data: GatePhaseStartDataSchema,
}).strict();

export const GateTerminalEventSchema = z.object({
  ts: TimestampSchema,
  event: z.literal("gate-result"),
  taskId: TaskIdSchema,
  data: GateTerminalDataSchema,
}).strict();

export const RoleInvocationStartEventSchema = z.object({
  ts: TimestampSchema,
  event: z.literal("role-invocation-start"),
  taskId: TaskIdSchema,
  data: RoleInvocationStartDataSchema,
}).strict();

export const RoleInvocationTerminalEventSchema = z.object({
  ts: TimestampSchema,
  event: z.literal("role-invocation-terminal"),
  taskId: TaskIdSchema,
  data: RoleInvocationTerminalDataSchema,
}).strict();

export const RunTerminalEventSchema = z.object({
  ts: TimestampSchema,
  event: z.literal("run-end"),
  data: RunTerminalDataSchema,
}).strict();

/**
 * The complete decision-event vocabulary. There is no catch-all object arm: an event claiming one of
 * these names either validates as exactly one member or becomes a protocol issue on read.
 */
export const DecisionEventSchema = z.discriminatedUnion("event", [
  GatePhaseStartEventSchema,
  GateTerminalEventSchema,
  RoleInvocationStartEventSchema,
  RoleInvocationTerminalEventSchema,
  RunTerminalEventSchema,
]);
export type DecisionEvent = z.infer<typeof DecisionEventSchema>;

// New writers do not choose timestamps. Journal.append adds the timestamp and validates the resulting
// full DecisionEvent before a byte reaches appendFileSync.
export const DecisionEventWriteSchema = z.discriminatedUnion("event", [
  GatePhaseStartEventSchema.omit({ ts: true }),
  GateTerminalEventSchema.omit({ ts: true }),
  RoleInvocationStartEventSchema.omit({ ts: true }),
  RoleInvocationTerminalEventSchema.omit({ ts: true }),
  RunTerminalEventSchema.omit({ ts: true }),
]);
export type DecisionEventWrite = z.infer<typeof DecisionEventWriteSchema>;

export const DECISION_EVENT_NAMES = [
  "gate-phase-start",
  "gate-result",
  "role-invocation-start",
  "role-invocation-terminal",
  "run-end",
] as const satisfies readonly DecisionEvent["event"][];

type AssertNever<T extends never> = T;
export type UntabledDecisionEventName = AssertNever<
  Exclude<DecisionEvent["event"], (typeof DECISION_EVENT_NAMES)[number]>
>;

export interface JournalSourceRow {
  /** Zero-based physical JSONL line index. Blank and torn lines retain their place in this index. */
  sourceIndex: number;
  raw: unknown;
}

export interface InterpretedDecisionEvent {
  kind: "decision";
  runId: string;
  sourceIndex: number;
  event: DecisionEvent;
  /** Original parsed JSON, retained even when a legacy row was normalized for interpretation. */
  raw: unknown;
  rawData: unknown;
}

/**
 * Compatibility is deliberately opaque for event names outside the decision vocabulary. Arbitrary
 * historical payloads survive byte-for-byte through `raw`; no unknown type can be mistaken for a
 * successful decision merely because it happened to contain pass-like fields.
 */
export interface HistoricalUnknownEvent {
  kind: "historical-unknown";
  runId: string;
  sourceIndex: number;
  eventType?: string;
  raw: unknown;
  rawData: unknown;
}

export interface ProtocolIssue {
  kind: "protocol-issue";
  runId: string;
  sourceIndex: number;
  eventType: DecisionEvent["event"];
  issues: string[];
  raw: unknown;
  rawData: unknown;
}

/** Closed tracked-reader result: decision, opaque historical unknown, or visible protocol failure. */
export type TrackedJournalRow = InterpretedDecisionEvent | HistoricalUnknownEvent | ProtocolIssue;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const rawDataOf = (raw: unknown): unknown => isRecord(raw) ? raw.data : undefined;

const eventTypeOf = (raw: unknown): string | undefined =>
  isRecord(raw) && typeof raw.event === "string" ? raw.event : undefined;

const isDecisionEventName = (event: string | undefined): event is DecisionEvent["event"] =>
  event !== undefined && (DECISION_EVENT_NAMES as readonly string[]).includes(event);

function legacyGateEvent(raw: unknown): DecisionEvent | undefined {
  if (!isRecord(raw) || raw.event !== "gate-result" || typeof raw.ts !== "string"
      || typeof raw.taskId !== "string" || !isRecord(raw.data)) return undefined;
  const data = raw.data;
  // An `outcome` key declares the canonical format. A malformed or mixed canonical row must not fall
  // through to the legacy booleans and become clean.
  if (hasOwn(data, "outcome")) return undefined;
  const attempt = data.attempt === undefined ? 0 : data.attempt;
  if (!Number.isInteger(attempt) || (attempt as number) < 0 || typeof data.gate !== "string"
      || !(GATE_NAMES as readonly string[]).includes(data.gate)) return undefined;
  const outcome = normalizeGateOutcome(data);
  // T31's unavailable fallback is useful to old projections, but at this protocol boundary it means
  // the known terminal could not be interpreted. Preserve it as a ProtocolIssue instead of silently
  // manufacturing a terminal outcome.
  if (outcome.kind === "unavailable") return undefined;
  const parsed = GateTerminalEventSchema.safeParse({
    ts: raw.ts,
    event: "gate-result",
    taskId: raw.taskId,
    data: {
      attempt,
      gate: data.gate,
      outcome,
      ...(typeof data.details === "string" ? { details: data.details } : {}),
      evidence: { legacyData: data },
    },
  });
  return parsed.success ? parsed.data : undefined;
}

const LegacyRunTerminalDataSchema = z.object({
  runId: NonEmptyStringSchema,
  branch: NonEmptyStringSchema,
  done: TaskIdsSchema,
  failed: TaskIdsSchema,
  human: TaskIdsSchema,
  blocked: TaskIdsSchema.optional(),
  pending: TaskIdsSchema.optional(),
  tipVerify: z.enum(["passed", "failed"]).optional(),
  lastMergedTask: TaskIdSchema.optional(),
  approvalDisposition: z.enum(["complete", "outstanding"]).optional(),
  outstandingApprovals: TaskIdsSchema.optional(),
  phase: NonEmptyStringSchema.optional(),
  fatal: z.boolean().optional(),
  error: z.string().optional(),
}).passthrough();

function legacyRunTerminalEvent(raw: unknown): DecisionEvent | undefined {
  if (!isRecord(raw) || raw.event !== "run-end" || typeof raw.ts !== "string"
      || hasOwn(raw, "taskId") || !isRecord(raw.data)) return undefined;
  // Either canonical discriminator declares a new-format row. Never repair a malformed canonical row
  // from its summary arrays, because doing so could turn a rejected write into a clean terminal.
  if (hasOwn(raw.data, "outcome") || hasOwn(raw.data, "reason")) return undefined;
  const legacy = LegacyRunTerminalDataSchema.safeParse(raw.data);
  if (!legacy.success) return undefined;
  const data = legacy.data;
  const failed = data.fatal === true || data.failed.length > 0 || data.tipVerify === "failed";
  const incomplete = data.human.length > 0 || (data.blocked?.length ?? 0) > 0
    || (data.pending?.length ?? 0) > 0 || data.approvalDisposition === "outstanding";
  const outcome: RunTerminalOutcome = failed ? "failed" : incomplete ? "incomplete" : "completed";
  const reason = data.fatal === true
    ? data.error?.trim() || "legacy run ended after a fatal error"
    : failed
      ? "legacy run summary records failed verification or tasks"
      : incomplete
        ? "legacy run summary records unfinished tasks or approvals"
        : "legacy run summary records all tasks complete";
  const parsed = RunTerminalEventSchema.safeParse({
    ts: raw.ts,
    event: "run-end",
    data: {
      outcome,
      reason,
      runId: data.runId,
      branch: data.branch,
      done: data.done,
      failed: data.failed,
      human: data.human,
      blocked: data.blocked ?? [],
      pending: data.pending ?? [],
      ...(data.tipVerify === undefined ? {} : { tipVerify: data.tipVerify }),
      ...(data.lastMergedTask === undefined ? {} : { lastMergedTask: data.lastMergedTask }),
      ...(data.approvalDisposition === undefined ? {} : { approvalDisposition: data.approvalDisposition }),
      ...(data.outstandingApprovals === undefined ? {} : { outstandingApprovals: data.outstandingApprovals }),
      ...(data.phase === undefined ? {} : { phase: data.phase }),
      ...(data.fatal === undefined ? {} : { fatal: data.fatal }),
      ...(data.error === undefined ? {} : { error: data.error }),
      evidence: { legacyData: raw.data },
    },
  });
  return parsed.success ? parsed.data : undefined;
}

function schemaFor(event: DecisionEvent["event"]) {
  switch (event) {
    case "gate-phase-start": return GatePhaseStartEventSchema;
    case "gate-result": return GateTerminalEventSchema;
    case "role-invocation-start": return RoleInvocationStartEventSchema;
    case "role-invocation-terminal": return RoleInvocationTerminalEventSchema;
    case "run-end": return RunTerminalEventSchema;
  }
}

function issueMessages(event: DecisionEvent["event"], raw: unknown): string[] {
  const parsed = schemaFor(event).safeParse(raw);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "row";
    return `${path}: ${issue.message}`;
  });
}

/** Interpret every parseable JSONL row without dropping unknown or malformed-known events. */
export function trackJournalRows(runId: string, sourceRows: readonly JournalSourceRow[]): TrackedJournalRow[] {
  return sourceRows.map(({ sourceIndex, raw }): TrackedJournalRow => {
    const eventType = eventTypeOf(raw);
    const rawData = rawDataOf(raw);
    if (!isDecisionEventName(eventType)) {
      return { kind: "historical-unknown", runId, sourceIndex, eventType, raw, rawData };
    }

    const canonical = DecisionEventSchema.safeParse(raw);
    const compatible = canonical.success
      ? canonical.data
      : eventType === "gate-result"
        ? legacyGateEvent(raw)
        : eventType === "run-end"
          ? legacyRunTerminalEvent(raw)
          : undefined;
    if (compatible) {
      return { kind: "decision", runId, sourceIndex, event: compatible, raw, rawData };
    }

    const issues = issueMessages(eventType, raw);
    if (eventType === "gate-result" && isRecord(rawData) && !hasOwn(rawData, "outcome")) {
      const outcome = normalizeGateOutcome(rawData);
      if (outcome.kind === "unavailable") issues.push(`data.outcome: ${outcome.reason}`);
    }
    return {
      kind: "protocol-issue",
      runId,
      sourceIndex,
      eventType,
      issues: issues.length > 0 ? issues : ["row does not satisfy its closed decision schema"],
      raw,
      rawData,
    };
  });
}

export type PairRole = RoleInvocationRole | `gate:${GateName}`;

export interface PairIdentity {
  runId: string;
  taskId: string;
  attempt: number;
  role: PairRole;
}

export interface PairIntegrityRecord {
  identity: PairIdentity;
  state: "closed" | "open" | "invalid";
  startSourceIndexes: number[];
  terminalSourceIndexes: number[];
}

export interface PairIntegrityIssue {
  kind: "duplicate-start" | "duplicate-terminal" | "terminal-without-start" | "malformed-decision";
  identity?: PairIdentity;
  sourceIndexes: number[];
  reason: string;
}

export interface PairIntegrityFold {
  pairs: PairIntegrityRecord[];
  issues: PairIntegrityIssue[];
}

interface PairAccumulator {
  identity: PairIdentity;
  starts: number[];
  terminals: number[];
  firstSourceIndex: number;
}

const pairKey = ({ runId, taskId, attempt, role }: PairIdentity): string =>
  JSON.stringify([runId, taskId, attempt, role]);

function pairedIdentity(row: InterpretedDecisionEvent): { identity: PairIdentity; terminal: boolean } | undefined {
  const event = row.event;
  switch (event.event) {
    case "gate-phase-start":
      return {
        identity: {
          runId: row.runId,
          taskId: event.taskId,
          attempt: event.data.attempt,
          role: `gate:${event.data.gate}`,
        },
        terminal: false,
      };
    case "gate-result":
      return {
        identity: {
          runId: row.runId,
          taskId: event.taskId,
          attempt: event.data.attempt,
          role: `gate:${event.data.gate}`,
        },
        terminal: true,
      };
    case "role-invocation-start":
      return {
        identity: {
          runId: row.runId,
          taskId: event.taskId,
          attempt: event.data.attempt,
          role: event.data.role,
        },
        terminal: false,
      };
    case "role-invocation-terminal":
      return {
        identity: {
          runId: row.runId,
          taskId: event.taskId,
          attempt: event.data.attempt,
          role: event.data.role,
        },
        terminal: true,
      };
    case "run-end":
      return undefined;
  }
}

/**
 * Structural pair fold only. It does not reduce task or run state. An open start remains observable as
 * open; duplicate starts/terminals and orphan terminals are invalid and never count as a closed pair.
 */
export function foldPairIntegrity(rows: readonly TrackedJournalRow[]): PairIntegrityFold {
  const byIdentity = new Map<string, PairAccumulator>();
  const issues: PairIntegrityIssue[] = [];

  for (const row of rows) {
    if (row.kind === "protocol-issue") {
      issues.push({
        kind: "malformed-decision",
        sourceIndexes: [row.sourceIndex],
        reason: `${row.eventType}: ${row.issues.join("; ")}`,
      });
      continue;
    }
    if (row.kind !== "decision") continue;
    const paired = pairedIdentity(row);
    if (!paired) continue;
    const key = pairKey(paired.identity);
    let accumulator = byIdentity.get(key);
    if (!accumulator) {
      accumulator = {
        identity: paired.identity,
        starts: [],
        terminals: [],
        firstSourceIndex: row.sourceIndex,
      };
      byIdentity.set(key, accumulator);
    }
    (paired.terminal ? accumulator.terminals : accumulator.starts).push(row.sourceIndex);
  }

  const accumulators = [...byIdentity.values()].sort((a, b) => a.firstSourceIndex - b.firstSourceIndex);
  const pairs = accumulators.map((pair): PairIntegrityRecord => {
    if (pair.starts.length > 1) {
      issues.push({
        kind: "duplicate-start",
        identity: pair.identity,
        sourceIndexes: [...pair.starts],
        reason: "one structural identity has more than one start",
      });
    }
    if (pair.terminals.length > 1) {
      issues.push({
        kind: "duplicate-terminal",
        identity: pair.identity,
        sourceIndexes: [...pair.terminals],
        reason: "one structural identity has more than one terminal",
      });
    }
    const orphanTerminals = pair.starts.length === 0
      ? pair.terminals
      : pair.terminals.filter((sourceIndex) => sourceIndex < pair.starts[0]!);
    if (orphanTerminals.length > 0) {
      issues.push({
        kind: "terminal-without-start",
        identity: pair.identity,
        sourceIndexes: [...orphanTerminals],
        reason: "a terminal has no preceding start with the same run, task, attempt and role",
      });
    }
    const invalid = pair.starts.length > 1 || pair.terminals.length > 1 || orphanTerminals.length > 0;
    return {
      identity: pair.identity,
      state: invalid ? "invalid" : pair.terminals.length === 0 ? "open" : "closed",
      startSourceIndexes: [...pair.starts],
      terminalSourceIndexes: [...pair.terminals],
    };
  });

  return { pairs, issues };
}
