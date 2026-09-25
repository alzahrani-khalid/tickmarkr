import { discoverChannels } from "../adapters/registry.js";
import { type AuthHealth, type BillingChannel, type WorkerAdapter } from "../adapters/types.js";
import { type TickmarkrConfig } from "../config/config.js";
import type { PreferenceRole } from "./preference.js";
import { rankPreferredChannels, reviewPreferenceTieBreak } from "./router.js";

export { preferIndex, rankPreferredChannels, reviewPreferenceTieBreak } from "./router.js";

export type RolePick =
  | { ok: true; channel: BillingChannel }
  | { ok: false; reason: "missing-prefer" | "no-eligible-preferred-channel" };

/** Strict role selection: no task, author, pin, or default seat is invented. */
export function pickRole(
  role: PreferenceRole,
  cfg: TickmarkrConfig,
  adapters: WorkerAdapter[],
  health: Record<string, AuthHealth>,
  opts: {
    excludeVendors?: ReadonlySet<string>;
    eligible?: (channel: BillingChannel) => boolean;
  } = {},
): RolePick {
  // Worker preferences belong to shapes; judge currently has only an explicit pin.
  const prefer = role === "review" ? cfg.review.prefer : role === "consult" ? cfg.consult.prefer : undefined;
  if (!prefer?.length) return { ok: false, reason: "missing-prefer" };
  const pool = discoverChannels(cfg, adapters, health, role).filter((c) =>
    !opts.excludeVendors?.has(c.vendor) && (opts.eligible?.(c) ?? true));
  const channel = rankPreferredChannels(pool, prefer, {
    tieBreak: role === "review" ? reviewPreferenceTieBreak : undefined,
  })[0];
  return channel ? { ok: true, channel } : { ok: false, reason: "no-eligible-preferred-channel" };
}
