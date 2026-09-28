import type { JournalEvent } from "./journal.js";

export interface RepairSelectionDecision {
  selectTests: boolean;
  requiredFiles: string[];
  reason: "no-test-failure" | "known-failing-files" | "legacy-test-failure"
    | "unattributed-test-failure";
}

type SelectionEvent = Pick<JournalEvent, "event" | "taskId" | "data">;

/** OBS-1199: repair selection is on unless a config says otherwise, independent of the optional
 * execution budget (which stays subprocess-only). Either explicit `false` turns it off. */
export function repairSelectionEnabled(cfg?: {
  executionPolicy?: { repairSelection?: unknown }; gates?: { repairSelection?: unknown };
}): boolean {
  return cfg?.executionPolicy?.repairSelection !== false && cfg?.gates?.repairSelection !== false;
}

/** These are literal repository-relative identities. Existence and selection support are checked
 * against the current worktree by the gate; this journal fold cannot establish either. */
function fileIdentities(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.some((file) =>
    typeof file !== "string" || !file || /[\\\x00-\x1f\x7f]/.test(file)
    || /^[A-Za-z]:/.test(file) || file.split("/").some((part) => !part || part === "." || part === ".."))) {
    return undefined;
  }
  return [...new Set(value as string[])].sort();
}

/** Diagnostic selection only: neither a narrow pass nor this decision can authorize integration.
 * Distrust and known failing files survive later green results, approvals and resume. A historical
 * ambiguous failure is never reinterpreted using a newly enabled policy. */
export function repairSelectionDecision(
  events: readonly SelectionEvent[], taskId: string, enabled: boolean,
): RepairSelectionDecision {
  const required = new Set<string>();
  let distrust: RepairSelectionDecision["reason"] | undefined;
  for (const event of events) {
    if (event.taskId !== taskId || event.event !== "gate-result"
      || event.data.gate !== "test" || event.data.pass !== false) continue;
    const data = event.data;
    if (!enabled) {
      distrust ??= "legacy-test-failure";
      continue;
    }
    // Only the recorded closed disposition can exempt infrastructure. Contradictory structured
    // failure evidence cannot turn a behavioral failure into a harmless infrastructure event.
    if (data.disposition === "infrastructure" && data.classification !== "regression"
      && (data.failingFiles === undefined || (Array.isArray(data.failingFiles) && data.failingFiles.length === 0))) continue;
    if (data.disposition !== "behavioral" || typeof data.commit !== "string"
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(data.commit)) {
      distrust ??= "unattributed-test-failure";
      continue;
    }
    // OBS-1199: a full-suite red counts only when it positively says it was full — the replacement
    // after a screen (`fullSuite`), or an ordinary full run whose recorded selection decision says
    // so — and names its failing files. Those files join every later screen even when no selector
    // reaches them; the merge candidate still runs the complete suite. No attribution means full.
    const failing = fileIdentities(data.failingFiles);
    const selected = fileIdentities(data.selectedTests);
    const decision = data.selectionDecision as { scope?: unknown } | null | undefined;
    const replacement = data.fullSuite === true;
    const ordinaryFull = data.fullSuite === undefined && data.selectedTests === undefined
      && typeof decision === "object" && decision !== null && decision.scope === "full";
    const screen = (data.fullSuite === undefined || data.fullSuite === false) && selected !== undefined
      && failing !== undefined && failing.every((file) => selected.includes(file));
    if (!failing || !(replacement || ordinaryFull || screen)) {
      distrust ??= "unattributed-test-failure";
      continue;
    }
    for (const file of failing) required.add(file);
  }
  return {
    selectTests: distrust === undefined,
    requiredFiles: [...required].sort(),
    reason: distrust ?? (required.size ? "known-failing-files" : "no-test-failure"),
  };
}
