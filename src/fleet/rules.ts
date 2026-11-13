// Lifting the rules that keep one model from one role, and turning the result into config edits.
// Used by the consult item (a yes) and by a line changed by hand (a tick on a model a rule keeps out).
import { DENY_SCOPES, type TickmarkrConfig } from "../config/config.js";
import { disallowedBy, entryMatchesChannel, observedSeat, type PreferenceRole } from "../route/preference.js";
import type { FleetModel } from "./model.js";
import type { Edit, Layer } from "./edits.js";

export type Routing = TickmarkrConfig["routing"];
type SeatId = { adapter: string; model: string; identity?: string };
/** Every other model of the config, as the rule check sees it: a rule that also matches one of these is not `key`'s own. */
export const othersOf = (M: FleetModel, key: string): SeatId[] => M.seats.filter((s) => s.key !== key).map((s) => observedSeat(M.health, s.adapter, s.model));

const valueAt = (obj: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((cur, seg) => (cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined), obj);
/** A deny or allow list of `routing`, by its config path (which starts with "routing"). */
export const ruleList = (routing: Routing, path: readonly string[]): string[] => (valueAt({ routing }, path) as string[] | undefined) ?? [];
/** Sets one of those lists in `routing` (which is changed). */
export function putRule(routing: Routing, path: readonly string[], value: string[]): void {
  let at = routing as unknown as Record<string, unknown>;
  for (const seg of path.slice(1, -1)) at = (at[seg] ??= {}) as Record<string, unknown>;
  at[path[path.length - 1]] = value;
}
const ALLOW = ["routing", "allow", "models"], WORKERS = ["routing", "deny", "workers", "models"];
/**
 * What `routing.deny.workers` covers, said wherever it is named: in the config a worker is whoever
 * takes a task, of any shape. A reader takes "worker" for "writes code", and plan and spec are shapes.
 */
export const WORK = "all work (every shape, plan and spec too)";

/**
 * In `routing` (a copy: it is changed), lifts every rule that keeps `seat` from `role`, asking the
 * product's own rule check after each, and says in words what was in the way.
 *
 * Only a rule that is the model's own is lifted: one that matches none of `others` (every other
 * model of the config), by the matcher the router itself uses. A CLI's id, a bare model id two
 * CLIs serve and an alias family all match more than one; lifting such a rule would be a choice
 * about the others, so `freed` is false and `why` names the rule. The allowlist is "lifted" by
 * adding the model to it. When the role is not a worker's, the model is then denied for all work
 * (`routing.deny.workers.models`) if lifting let it take a task: it may consult, judge or review,
 * and still takes none.
 */
export function freeSeat(routing: Routing, seat: SeatId, key: string, role: PreferenceRole, others: readonly SeatId[]): { freed: boolean; why: string[] } {
  const why: string[] = [];
  // its own: the entry matches no other model of the config, by the matcher the router itself uses
  // (a CLI's id, a bare model id two CLIs serve and an alias family all match more than one)
  const own = (entry: string) => !others.some((o) => entryMatchesChannel(entry, o, true));
  for (let reason = disallowedBy(seat, routing, role), n = 0; reason; reason = disallowedBy(seat, routing, role), n++) {
    if (n > 8) return { freed: false, why };
    if (reason.by === "allow") {
      why.push("the allowlist");
      putRule(routing, ALLOW, [...ruleList(routing, ALLOW), key]);
      continue;
    }
    const entry = reason.entry;
    const scopes = DENY_SCOPES.filter((sc) => ruleList(routing, sc.path).includes(entry) && (role === "worker" || sc.path[2] !== "workers"));
    // a worker is kept out by the workers' list before the list for every seat
    const scope = scopes.find((sc) => sc.path[2] === "workers") ?? scopes[0];
    if (!scope) return { freed: false, why };
    const everySeat = scope.path[2] !== "workers";
    // an entry that names a CLI is that CLI's rule, whatever models it has today (tombstoned ones
    // included): any entry of an adapters list, by its place, and the CLI's own id, by its words (RULING-T5 rule 5)
    if (scope.path[scope.path.length - 1] === "adapters" || entry === seat.adapter) return { freed: false, why: [...why, `the deny rule ${entry}, which covers the whole ${entry} CLI`] };
    if (!own(entry)) return { freed: false, why: [...why, `the deny rule ${entry}, which covers more than this model`] };
    why.push(everySeat ? `the deny rule ${entry}, which covers every seat` : `the deny rule ${entry} for ${WORK}`);
    putRule(routing, scope.path, ruleList(routing, scope.path).filter((e) => e !== entry));
  }
  // a seat that is not a worker's is let in for that seat alone: what was lifted for it must not let it take a task
  if (role !== "worker" && !disallowedBy(seat, routing, "worker")) putRule(routing, WORKERS, [...new Set([...ruleList(routing, WORKERS), key])]);
  return { freed: true, why };
}

/** The edits that turn the rules of `before` into those of `after`: one for each deny or allow list that differs. */
export function ruleEdits(before: Routing, after: Routing, holder: (path: readonly string[]) => Layer): Edit[] {
  return [ALLOW, ...DENY_SCOPES.map((sc) => [...sc.path])]
    .filter((path) => JSON.stringify(ruleList(after, path)) !== JSON.stringify(ruleList(before, path)))
    .map((path): Edit => {
      const was = ruleList(before, path), now = ruleList(after, path);
      const gone = was.filter((e) => !now.includes(e)), come = now.filter((e) => !was.includes(e));
      const scope = path[2] === "workers" ? WORK : "every seat";
      const label = path[1] === "allow" ? `allow ${come.join(", ")}`
        : [gone.length ? `${gone.join(", ")}: no longer denied for ${scope}` : "", come.length ? `${come.join(", ")}: denied for ${scope}` : ""].filter(Boolean).join("; ");
      return { layer: holder(path), path, value: now, label };
    });
}
