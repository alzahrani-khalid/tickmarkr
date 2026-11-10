// Queue row 397 (D-2187 add.23): an in-run exclusion — a run-wide demotion, channel exclusion or dead-channel
// failover — that empties a task's floor pool PARKS the task recoverably (kind infra, disposition
// pool-excluded) with the operator's verbs, never task-failed. The proof is the same route() call without
// the in-run exclusion set returning a channel; a pool that is empty without the exclusions keeps the base
// failure. `tickmarkr resume <runId> --readmit <adapter:model>` lifts an exclusion (Journal.replayExcludedChannels).
import type { BillingChannel } from "../adapters/types.js";
import { shq } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import type { RoutingProfile } from "../route/profile.js";
import { channelExclusion, route, RoutingError } from "../route/router.js";
import type { JournalEvent } from "./journal.js";

export const POOL_EXCLUDED = "pool-excluded";

/** The worker channel a run-wide exclusion row names, as the journal's exclusion replay reads it. */
const excludedChannel = (e: JournalEvent): unknown =>
  e.event === "channel-demotion" || e.event === "channel-exclusion" ? e.data.channel
    : e.event === "dead-channel-failover" ? e.data.from : undefined;

const causeOf = (e: JournalEvent): string =>
  e.event === "channel-demotion" ? `no-trailer streak ${String(e.data.streak)}` : String(e.data.reason ?? e.event);

const arg = (s: string): string => /^[\w@%+=:,./-]+$/u.test(s) ? s : shq(s);

export interface PoolExclusionPark { reason: string; details: Record<string, unknown> }

/**
 * The park for a route() refusal that only the in-run exclusion set caused, or undefined when the refusal
 * stands at the base: not a RoutingError, no exclusion in force, or the same call without exclusions
 * refusing too (a pool empty for another reason). Names each excluded channel behind the channel that
 * call would have used, with the journal row that excluded it.
 */
export function poolExclusionPark(err: unknown, runId: string, task: Task, cfg: TickmarkrConfig, channels: BillingChannel[],
  profile: RoutingProfile | undefined, exclude: ReadonlySet<string>, journal: { events: JournalEvent[]; lines: number[] },
): PoolExclusionPark | undefined {
  if (!(err instanceof RoutingError) || exclude.size === 0) return undefined;
  let pick: { adapter: string; model: string };
  try {
    pick = route(task, cfg, channels, profile).assignment; // the same call, without the in-run exclusion set
  } catch {
    return undefined;
  }
  const named = [...exclude].filter((key) => channelExclusion(channels, [key])(pick)).sort();
  if (named.length === 0) return undefined;
  const { events, lines } = journal;
  const exclusions = named.map((channel) => {
    let i = events.length - 1;
    while (i >= 0 && excludedChannel(events[i]!) !== channel) i--;
    return i < 0 ? { channel, cause: "excluded in this run" }
      : { channel, event: events[i]!.event, line: lines[i]!, cause: causeOf(events[i]!) };
  });
  const readmit = ["tickmarkr", "resume", runId, ...named.flatMap((c) => ["--readmit", c])].map(arg).join(" ");
  const plain = ["tickmarkr", "resume", runId].map(arg).join(" ");
  const why = exclusions.map((x) => `${x.channel} (${"line" in x ? `${x.event} at journal line ${x.line}: ` : ""}${x.cause})`).join(", ");
  return {
    reason: `${POOL_EXCLUDED}: ${err.message} — only the run-wide exclusion of ${why} emptied the pool; `
      + `readmit with \`${readmit}\`, or change the routing.map pool and then \`${plain}\``,
    details: { disposition: POOL_EXCLUDED, channels: named, exclusions, readmit, poolChange: plain },
  };
}

/** The task's newest park is a pool-excluded park; callers pair it with a replayed human state. */
export function poolExcludedPark(events: readonly JournalEvent[], taskId: string): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.taskId === taskId && e.event === "task-human") return e.data.disposition === POOL_EXCLUDED;
  }
  return false;
}
