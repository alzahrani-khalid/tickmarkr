import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthHealth, BillingChannel } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";
import { FORK_CAP_ENV, resolvedForkCap } from "./git.js";

// v1.70 T2: run environment identity, journaled on run-start alongside the graph/branch identity fields.
// Every input comes through a path that already exists — adapter versions are read from the same
// probe() health records doctor writes (the daemon's probeAll/readDoctor), the config hash is taken
// over the already-loaded resolved config, and the tickmarkr version reads package.json exactly the
// way the `tickmarkr version` command does. No second probing or loading mechanism lives here.

export interface RunEnvironment {
  tickmarkrVersion: string;
  configHash: string;
  adapterVersions: Record<string, string>;
  // v2.0 T2 (OBS-554): the run's CAPACITY, the other half of every load reading. A `load1Start` of 9
  // means nothing until a reader knows how many cores it was measured against, and the gate suites'
  // fork cap is what a run actually spent of them — so the two numbers the parked load-aware
  // scheduler's threshold is defined over are recorded here, and a journal replayed on another host
  // reconstructs that threshold mechanically instead of re-reading THIS machine.
  // Optional on the TYPE only because report/compare reconstructs a RunEnvironment from a journal,
  // and a pre-v2.0 run-start genuinely has no capacity stamp — absent is the truth there. Every
  // record this module MINTS carries both: see StampedRunEnvironment, which runEnvironment returns.
  cores?: number;
  forkCap?: number;
}

/** A record this run wrote: capacity is present by construction, so "absent" cannot compile. */
export type StampedRunEnvironment = RunEnvironment & { cores: number; forkCap: number };

/**
 * Both capacity readings come through providers so a test can state the host it is describing.
 * The defaults are the same two surfaces production already uses — `availableParallelism` (the one
 * `deriveForkCap` divides) and `resolvedForkCap`, the run-scoped cap every gate shell inherits —
 * so nothing here is a second mechanism, and neither number is hardcoded.
 */
export interface CapacityProviders {
  cores?: () => number;
  forkCap?: () => number;
}

/**
 * The cap a gate suite ACTUALLY runs under — the same precedence `sh` applies when it builds a child's
 * environment (src/run/git.ts): an operator export of VITEST_MAX_FORKS wins, and only when there is
 * none does the run's own derived cap apply. Recording the derived number while children run at the
 * operator's would describe a host this run never used.
 * resolvedForkCap is an AsyncLocalStorage read: it must run INSIDE the run's fork budget (daemon.ts
 * enters it around the whole run body) or it reports the standalone default instead of this run's cap.
 */
const defaultForkCap = (): number =>
  Number(FORK_CAP_ENV in process.env ? process.env[FORK_CAP_ENV] : resolvedForkCap());

// An adapter whose version probe failed is recorded, not dropped — "unknown", never a fabricated string.
export const UNKNOWN_ADAPTER_VERSION = "unknown";

// Same package.json read as src/cli/commands/version.ts (one resolution pattern, two consumers).
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");

export function tickmarkrVersion(): string {
  const { version: v } = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return v;
}

// Key order in a parsed config is an accident of the schema/merge layers, so the hash canonicalizes
// first: object keys sorted recursively, undefined dropped (JSON semantics), array order preserved.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
}

// sha256 truncated to 16 hex — the graphDefinitionHash convention (stable, grep-friendly).
export function configHash(cfg: TickmarkrConfig): string {
  return createHash("sha256").update(stableStringify(cfg)).digest("hex").slice(0, 16);
}

// One entry per adapter with a channel in the run (not per channel). The version is whatever the
// adapter's own probe recorded in health; a missing/undefined probe result becomes "unknown".
export function adapterVersions(channels: BillingChannel[], health: Record<string, AuthHealth>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of channels) {
    if (!(c.adapter in out)) out[c.adapter] = health[c.adapter]?.version ?? UNKNOWN_ADAPTER_VERSION;
  }
  return out;
}

export function runEnvironment(
  cfg: TickmarkrConfig,
  channels: BillingChannel[],
  health: Record<string, AuthHealth>,
  capacity: CapacityProviders = {},
): StampedRunEnvironment {
  return {
    tickmarkrVersion: tickmarkrVersion(),
    configHash: configHash(cfg),
    adapterVersions: adapterVersions(channels, health),
    cores: (capacity.cores ?? availableParallelism)(),
    forkCap: (capacity.forkCap ?? defaultForkCap)(),
  };
}
