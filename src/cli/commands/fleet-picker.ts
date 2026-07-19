import type { Assignment, BillingChannel } from "../../adapters/types.js";
import type { TickmarkrConfig } from "../../config/config.js";
import type { Task } from "../../graph/schema.js";
import { rankCandidates, type RankedCandidate } from "../../route/candidates.js";
import type { RoutingProfile } from "../../route/profile.js";

// v1.56 T2: ranking glue + row presentation for the per-shape candidate picker. Everything here
// is pure — the picker loop in fleet.ts mutates only in-memory editable state, and disk stays
// reachable solely through fleet's diff-confirm + reload-guard write path.

// Channel economics + tier, never invented dollars: a flat-rate sub quota rendered as $0 would be
// the one dishonest thing this screen could say (v1.56 ruling — cost visible where the choice is made).
export function costSignal(a: Assignment, pricing: Record<string, number>): string {
  if (a.channel === "sub") return "sub flat-rate quota";
  const perTask = pricing[a.tier];
  return perTask == null ? "api metered" : `api ~$${perTask.toFixed(2)}/task`;
}

export function candidateRow(c: RankedCandidate, pricing: Record<string, number>): string {
  const a = c.assignment;
  const override = c.belowFloor ? "  · below floor — operator override" : "";
  return `${a.adapter}:${a.model}  ${a.tier}  ${costSignal(a, pricing)}  — ${c.why}${override}`;
}

// Ranking ignores the shape's own map pin so a pinned shape still offers the full candidate
// order — route() returns a map pin first and fail-louds on its exclusion, which would collapse
// the picker to a single row. No hidden mutation: fresh cfg objects only.
export function shapeCandidates(
  task: Task,
  cfg: TickmarkrConfig,
  channels: BillingChannel[],
  profile?: RoutingProfile,
): RankedCandidate[] {
  const { pin: _pin, ...entry } = cfg.routing.map[task.shape] ?? {};
  const map = { ...cfg.routing.map, [task.shape]: entry };
  return rankCandidates(task, { ...cfg, routing: { ...cfg.routing, map } }, channels, profile);
}
