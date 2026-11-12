import type { WaiveProof } from "./waive-proof.js";

/** The closed verb set every decision surface may name. Nothing outside it reaches this command. */
export const DECISION_VERBS = ["approve", "waive", "uphold", "recheck"] as const;
export type DecisionVerb = (typeof DECISION_VERBS)[number];

/** The recorded park facts the decision menu needs, independent of CLI and daemon imports. */
export interface DecisionPark {
  kind: string | undefined;
  failedGate: string | undefined;
  tombstone: boolean;
  reapFailure?: string;
  /** Row 418 (D-2187 add.84): the waive-proof reader's answer for an infra park whose failed gate is a no-verdict review. */
  reviewWaiveProof?: WaiveProof;
}

/**
 * FINAL §3.3's decision menu as data: human-gate/attempt-cap/other non-gate parks → approve; infra (plus
 * waive for a proved no-verdict review, row 418), and a stall park that recorded a reapFailure (OBS-1202), → approve or recheck; review gate-fail →
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
  // Row 418 (D-2187 add.84): an infra park left by a no-verdict review admits a waive owing the review,
  // only when the proof reader proved its candidate (an executed full test, every other enabled gate passed).
  if (park.kind === "infra") {
    return park.failedGate === "review" && park.reviewWaiveProof?.ok === true ? ["approve", "waive", "recheck"] : ["approve", "recheck"];
  }
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

export interface DecisionCommands {
  readonly commands: readonly { readonly verb: DecisionVerb; readonly command: string }[];
  readonly noDecision: string | null;
}

const commandArg = (arg: string): string => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)
  ? arg : `'${arg.replace(/'/g, "'\\''")}'`;

/** Complete, copyable releases from the verb table. Unbound commands preserve journal reason text. */
export function decisionCommands(
  runId: string,
  taskId: string,
  park: (DecisionPark & { readonly line?: number; readonly ts?: string }) | undefined,
  { bound } = { bound: true },
): DecisionCommands {
  const none = (noDecision: string): DecisionCommands => ({ commands: [], noDecision });
  if (!park) return none("no recorded park — no decision is available");
  const verbs = permittedDecisionVerbs(park);
  if (park.tombstone) return none("tombstone — permanent by design; no verb releases it");
  if (park.kind === "scope-request") return none("scope-request requires --files <glob,…> to widen files[], or --reason <text> to refuse the expansion and continue within the current files[]");
  if (bound && (park.ts === undefined || park.ts === "" || !Number.isSafeInteger(park.line) || park.line! < 1)) {
    return none("untimed park — no park token is available; refusing an unbound decision");
  }
  if (verbs.length === 0 || (park.kind === "gate-fail" && !park.failedGate)) return none("parked on gate-fail with no failed gate result on the newest park — refusing to infer one");
  // Row 418: an infra park's waive names the review it waives; its approve and recheck stay as at the base.
  const gateFor = (verb: DecisionVerb) => bound && (park.kind === "gate-fail" || (park.kind === "authoring" && isToolGate(park.failedGate))
    || (park.kind === "infra" && verb === "waive")) ? park.failedGate : undefined;
  return {
    commands: verbs.map(verb => ({
      verb,
      command: ["tickmarkr", "approve", runId, taskId,
        ...(verb === "approve" ? [] : [`--${verb}`]),
        ...(gateFor(verb) === undefined ? [] : ["--gate", gateFor(verb)!]),
        ...(bound ? ["--park", `${park.line}@${park.ts}`] : []),
      ].map(commandArg).join(" "),
    })),
    noDecision: null,
  };
}
