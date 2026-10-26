/** The closed verb set every decision surface may name. Nothing outside it reaches this command. */
export const DECISION_VERBS = ["approve", "waive", "uphold", "recheck"] as const;
export type DecisionVerb = (typeof DECISION_VERBS)[number];

/** The recorded park facts the decision menu needs, independent of CLI and daemon imports. */
export interface DecisionPark {
  kind: string | undefined;
  failedGate: string | undefined;
  tombstone: boolean;
  reapFailure?: string;
}

/**
 * FINAL §3.3's decision menu as data: human-gate/attempt-cap/other non-gate parks → approve; infra, and
 * a stall park that recorded a reapFailure (OBS-1202), → approve or recheck; review gate-fail →
 * waive/uphold/recheck; other gate-fail → waive/recheck; a
 * gate-fail park with no failed-gate evidence, or a tombstone → nothing (a diagnostic, never a
 * fabricated verb). The refusals in the `approve` command enforce the same table; this is the one place a
 * surface may read it from, so what a menu offers and what the command accepts cannot drift.
 */
export function permittedDecisionVerbs(park: DecisionPark | undefined): readonly DecisionVerb[] {
  if (!park || park.tombstone || park.kind === "scope-request") return [];
  if (park.kind === "gate-fail") {
    if (park.failedGate === undefined) return [];
    return park.failedGate === "review" ? ["waive", "uphold", "recheck"] : ["waive", "recheck"];
  }
  if (park.kind === "infra") return ["approve", "recheck"];
  // OBS-1202: an unreadable reap census parks finished work; recheck re-verifies that census and gates the
  // harvested commits with no worker. An ordinary stall recorded no census failure: approve alone.
  if (park.kind === "stall" && park.reapFailure !== undefined) return ["approve", "recheck"];
  // OBS-1084: an authoring park whose newest gate row is a red tool gate is a runner report (a load
  // flake in an unowned suite), so the battery re-runs on the preserved ref with no worker.
  if (park.kind === "authoring" && isToolGate(park.failedGate)) return ["approve", "recheck"];
  if (park.kind === "diff-cap") return ["recheck"]; // OBS-1007: a cap trip is re-gated under a raised cap, never re-bought
  return ["approve"];
}

const TOOL_GATES: readonly string[] = ["build", "test", "lint"];
const isToolGate = (gate: string | undefined): gate is string => gate !== undefined && TOOL_GATES.includes(gate);
