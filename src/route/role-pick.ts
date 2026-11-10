import { discoverChannels } from "../adapters/registry.js";
import { type AuthHealth, type BillingChannel, type WorkerAdapter } from "../adapters/types.js";
import { type TickmarkrConfig } from "../config/config.js";
import type { PreferenceRole } from "./preference.js";
import { resolveSeats } from "./seat-resolver.js";

export type RolePick =
  | { ok: true; channel: BillingChannel }
  | { ok: false; reason: "missing-prefer" | "no-eligible-preferred-channel" };

/** Strict role selection: no task, author, pin, or default seat is invented. Ranked by the seat resolver (row 367, D-2187). */
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
  const pool = discoverChannels(cfg, adapters, health, role);
  const { excludeVendors, eligible } = opts;
  // No pin and no author: every seat the resolver can return here is a pool channel.
  const channel = role === "review"
    ? resolveSeats({ role, pool, prefer, excludeVendors, eligible }).pick
    : resolveSeats({ role: "consult", cfg, pool, excludeVendors, eligible }).pick as BillingChannel | null;
  return channel ? { ok: true, channel } : { ok: false, reason: "no-eligible-preferred-channel" };
}
