import type { GateResult } from "../gates/types.js";
import type { JournalEvent } from "./journal.js";

export type FailureDisposition = "infrastructure" | "behavioral" | "unknown";
export type VerificationRetryCause = "infrastructure" | "host-starved";

/** Structured verifier evidence wins; neither an exit code nor prose proves infrastructure. */
export function failureDisposition(result: Pick<GateResult, "pass" | "meta">): FailureDisposition {
  if (result.pass) return "unknown";
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
