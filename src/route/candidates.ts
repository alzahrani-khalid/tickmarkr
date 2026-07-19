import { type Assignment, type BillingChannel, channelKey } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import type { RoutingProfile } from "./profile.js";
import { route, RoutingError, type RoutingPreferContext } from "./router.js";

export interface RankedCandidate {
  assignment: Assignment;
  why: string; // route provenance, verbatim — the one-line reason the picker renders
  belowFloor: boolean;
}

// v1.56 T1 (scoper ruling 2, RULED FOR FABLE): NO comparator lives here — every rank IS a
// production route() result. Order derives solely from re-calling route with a growing exclusion
// set (the OBS-57 exclude seam), exploration off so repeated calls agree. When the eligible pool
// exhausts (RoutingError), the advisory floor for this shape is dropped ONCE and the remaining
// live channels rank after, marked belowFloor — mirroring the routes-but-lints semantics a
// below-floor map pin already has (router.ts pin path).
export function rankCandidates(
  task: Task,
  cfg: TickmarkrConfig,
  channels: BillingChannel[],
  profile?: RoutingProfile,
  preferCtx?: RoutingPreferContext,
): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  const exclude = new Set<string>();
  let effCfg = cfg;
  let belowFloor = false;
  while (exclude.size < channels.length) {
    let r;
    try {
      r = route(task, effCfg, channels, profile, preferCtx, exclude, { noExplore: true });
    } catch (e) {
      if (!(e instanceof RoutingError)) throw e;
      if (belowFloor) break; // pool exhausted (or an unresolvable map pin) — ranking is complete
      // eligible pool dry: drop this shape's advisory floor and keep iterating the production
      // router over the leftover live channels. No hidden mutation — fresh cfg objects only.
      belowFloor = true;
      const { [task.shape]: _dropped, ...floors } = cfg.routing.floors;
      effCfg = { ...cfg, routing: { ...cfg.routing, floors } };
      continue;
    }
    ranked.push({ assignment: r.assignment, why: r.provenance, belowFloor });
    exclude.add(channelKey(r.assignment));
  }
  return ranked;
}
