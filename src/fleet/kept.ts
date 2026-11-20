// KEPT OUT as data (queue rows 500, 501; D-2187 add.363, contract K3): every entry of every deny list in
// force, in the lists' order, with the comment written above it in the layer that holds it as its
// reason. No comment: no reason, never an invented one. An entry of a workers' list says its reach.
import { keptOut as rulesInForce } from "./lines.js";
import type { FleetModel } from "./model.js";

export interface KeptRule {
  /** the entry as written, and the dotted path of its list */
  rule: string; list: string;
  /** the comment above it, verbatim (comment marks and a leading date kept), or null */
  reason: string | null;
  /** an entry of a workers' list keeps its model from work only */
  workersOnly: boolean;
  /** the row's reason as the screen writes it: the comment, ` · workers only` after a workers' entry; `kept out for workers` with no comment */
  says: string | null;
}

export function keptOut(M: FleetModel): KeptRule[] {
  return rulesInForce(M).map((r) => {
    const workersOnly = r.list.startsWith("routing.deny.workers.");
    const says = r.reason === null ? (workersOnly ? "kept out for workers" : null) : workersOnly ? `${r.reason} · workers only` : r.reason;
    return { ...r, workersOnly, says };
  });
}
