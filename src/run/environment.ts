import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthHealth, BillingChannel } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";

// v1.70 T2: run environment identity, journaled on run-start alongside the graph/branch identity fields.
// Every input comes through a path that already exists — adapter versions are read from the same
// probe() health records doctor writes (the daemon's probeAll/readDoctor), the config hash is taken
// over the already-loaded resolved config, and the tickmarkr version reads package.json exactly the
// way the `tickmarkr version` command does. No second probing or loading mechanism lives here.

export interface RunEnvironment {
  tickmarkrVersion: string;
  configHash: string;
  adapterVersions: Record<string, string>;
}

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

export function runEnvironment(cfg: TickmarkrConfig, channels: BillingChannel[], health: Record<string, AuthHealth>): RunEnvironment {
  return { tickmarkrVersion: tickmarkrVersion(), configHash: configHash(cfg), adapterVersions: adapterVersions(channels, health) };
}
