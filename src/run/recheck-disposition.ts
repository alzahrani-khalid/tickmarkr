// Queue row 413 (D-2187 add.69, add.99, add.100): what a red recheck battery does next. An operator
// recheck records `onRed` on its decision row — park (the default approve writes) or repair; a
// graph-changed resume's generated recheck records repair explicitly. The daemon never defaults: a
// recheck row with no onRed (every journal written before this version) is enacted as repair, the base.
import { GATE_NAMES, type GateName } from "../graph/schema.js";
import { effectiveEvents, RECHECK_RELEASE, type JournalEvent } from "./journal.js";

export const ON_RED = ["park", "repair"] as const;
export type OnRed = (typeof ON_RED)[number];

/** The disposition approve writes when the operator passes no --on-red. */
export const DEFAULT_ON_RED: OnRed = "park";

/** The enactment clause each disposition buys — approve's message and the cockpit's preview read it. */
export const RECHECK_ENACTS: Record<OnRed, string> = {
  park: "re-run the whole declared battery on the parked commit before any worker; if it is red, park on the first red gate for the next decision",
  repair: "re-dispatch against the full gate suite only if re-running the whole declared battery on the parked commit before any worker is red",
};

/** `--on-red <value>`: a usage refusal for anything but park or repair. */
export function parseOnRed(value: string | undefined): OnRed {
  if (value === undefined || !(ON_RED as readonly string[]).includes(value)) {
    throw new Error(`--on-red requires one of ${ON_RED.join(", ")}`);
  }
  return value as OnRed;
}

/** True only when the recheck decision row recorded park; an absent or unknown value is the base repair. */
export const recheckParksOnRed = (decision: { data: Record<string, unknown> } | undefined): boolean =>
  decision?.data.onRed === "park";

/** The first red gate in declaration order (build, test, lint, evidence, scope, acceptance, review). */
export function firstRedGate(failing: ReadonlyArray<{ gate: string }>): GateName | undefined {
  return GATE_NAMES.find((g) => failing.some((r) => r.gate === g));
}

// Queue row 413 (D-2187 add.151): the ONE journal fold that answers whether an operator recheck's park
// disposition is in force for a task. It holds from the effective recheck decision row recording onRed park
// until the first settlement after it: a park (task-human), a merge (task-done), a failure (task-failed), or
// a later effective task-approved row. Nothing else ends it — not a recheck-battery row, a gate result, a
// regate or a restart — and no in-memory flag (the consumed approval included) decides it.
const SETTLEMENTS = new Set(["task-human", "task-done", "task-failed"]);
export function recheckParkInForce(events: readonly JournalEvent[], taskId: string): boolean {
  let inForce = false;
  for (const e of effectiveEvents(events)) {
    if (e.taskId !== taskId) continue;
    if (e.event === "task-approved") inForce = e.data.release === RECHECK_RELEASE && recheckParksOnRed(e);
    else if (SETTLEMENTS.has(e.event)) inForce = false;
  }
  return inForce;
}
