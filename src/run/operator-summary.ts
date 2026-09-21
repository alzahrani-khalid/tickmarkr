/** Labels describe blockers, not journal park kinds or commands. */
export const BLOCKER_KINDS = [
  "human-decision", "retry", "cooldown", "dependency-wait", "stale-receipt",
  "missing-capability", "unknown",
] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

/**
 * Structural boundary: callers compute park with newestPark and verbs with
 * permittedDecisionVerbs in cli/commands/approve. RunDecision also fits this
 * shape. This module neither imports a surface nor repeats its decision table.
 * Supply only current parks, from the same snapshot as the task statuses.
 */
export interface OperatorDecisionSnapshot {
  readonly taskId: string;
  readonly park: {
    readonly kind: string | undefined;
    readonly tombstone: boolean;
    readonly reason?: string;
  };
  readonly verbs: readonly string[];
  readonly diagnostic?: string;
}

export interface RecordedResponsibility {
  readonly role?: string;
  readonly agent?: string;
}

/**
 * Current, already-reduced evidence supplied by the reader. Optional facts stay
 * absent: a wait duration is not a wake timestamp, a channel is not an owner,
 * and elapsed wall time alone cannot establish that a receipt is stale.
 */
export interface OperatorSummaryTask {
  readonly id: string;
  readonly status: string;
  readonly deps: readonly string[];
  readonly phase?: string;
  readonly lastEvidenceAt?: string;
  readonly responsible?: RecordedResponsibility;
  readonly wait?: {
    readonly kind: "retry" | "cooldown";
    readonly wakeAt?: string;
    readonly diagnostic?: string;
  };
  readonly staleReceipt?: { readonly diagnostic: string };
  readonly missingCapability?: { readonly capability: string; readonly diagnostic?: string };
}

export interface OperatorBlocker {
  kind: BlockerKind;
  permittedActions: string[];
  humanInterventionRequired: boolean;
  decisionRequired: boolean;
  diagnostic?: string;
  nextAction: string | null;
  prerequisites?: string[];
  wakeAt?: string;
  capability?: string;
}

export interface OperatorTaskSummary {
  taskId: string;
  phase: string | null;
  lastEvidenceAt: string | null;
  /** null explicitly means unknown; never inferred from a park or wait. */
  responsible: RecordedResponsibility | null;
  blocker: OperatorBlocker | null;
}

const SETTLED = new Set<string | undefined>(["done", "completed", "merged"]);

const emptyBlocker = (kind: BlockerKind): OperatorBlocker => ({
  kind, permittedActions: [], humanInterventionRequired: false,
  decisionRequired: false, nextAction: null,
});

/** Pure projection in current-task order; no clock, host access, or retained state. */
export function projectOperatorSummary(
  tasks: readonly OperatorSummaryTask[],
  decisions: readonly OperatorDecisionSnapshot[],
): OperatorTaskSummary[] {
  const statuses = new Map(tasks.map(task => [task.id, task.status]));
  const parks = new Map(decisions.map(decision => [decision.taskId, decision]));
  return tasks.map(task => {
    let blocker: OperatorBlocker | null = null;
    const decision = task.status === "human" ? parks.get(task.id) : undefined;
    const terminal = SETTLED.has(task.status) || task.status === "failed";
    if (decision) {
      const { park, verbs, diagnostic } = decision;
      blocker = {
        ...emptyBlocker(park.tombstone ? "unknown" : "human-decision"),
        permittedActions: [...verbs],
        humanInterventionRequired: !park.tombstone,
        decisionRequired: verbs.length > 0,
        ...(diagnostic !== undefined || park.reason !== undefined
          ? { diagnostic: diagnostic ?? park.reason } : {}),
        nextAction: verbs.length > 0 ? `Choose a decision: ${verbs.join(", ")}` : null,
      };
      if (!park.tombstone && park.kind === "infra" && task.missingCapability) {
        const { capability, diagnostic: capabilityDiagnostic } = task.missingCapability;
        blocker.kind = "missing-capability";
        blocker.capability = capability;
        blocker.nextAction = `Diagnose host capability: ${capability}`;
        if (diagnostic === undefined && capabilityDiagnostic !== undefined) blocker.diagnostic = capabilityDiagnostic;
      }
    } else if (task.status === "human") {
      // Missing decision evidence must not make a parked task look automatic.
      blocker = { ...emptyBlocker("unknown"), humanInterventionRequired: true };
    } else if (!terminal) {
      const unmet = task.status === "pending" ? task.deps.filter(id => !SETTLED.has(statuses.get(id))) : [];
      if (unmet.length > 0) {
        blocker = {
          ...emptyBlocker("dependency-wait"), prerequisites: unmet,
          nextAction: `Wait for prerequisites: ${unmet.join(", ")}`,
        };
      } else if (task.staleReceipt) {
        blocker = {
          ...emptyBlocker("stale-receipt"), diagnostic: task.staleReceipt.diagnostic,
          nextAction: "Inspect the stale receipt and refresh its evidence",
        };
      } else if (task.wait) {
        blocker = {
          ...emptyBlocker(task.wait.kind),
          ...(task.wait.diagnostic === undefined ? {} : { diagnostic: task.wait.diagnostic }),
          ...(task.wait.wakeAt === undefined ? {} : { wakeAt: task.wait.wakeAt }),
        };
      } else if (task.status === "blocked" || task.status === "unknown") {
        blocker = emptyBlocker("unknown");
      }
    }
    const owner = task.responsible;
    return {
      taskId: task.id, phase: task.phase ?? null, lastEvidenceAt: task.lastEvidenceAt ?? null,
      responsible: owner?.role !== undefined || owner?.agent !== undefined
        ? { ...(owner.role === undefined ? {} : { role: owner.role }),
          ...(owner.agent === undefined ? {} : { agent: owner.agent }) } : null,
      blocker,
    };
  });
}
