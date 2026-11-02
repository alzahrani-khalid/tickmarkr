import { type AuthHealth, type TrustVerdict } from "../../adapters/types.js";
import { codex } from "../../adapters/codex.js";
import { adapterHealthy } from "./doctor.js";

// status.ts keeps this private. The card copies it so a version, note, error or detail cannot
// break a row: ECMA-48 sequences are removed, remaining Cc become spaces, whitespace collapses.
const ECMA_48_CONTROL =
  /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u009D[\s\S]*?(?:\u0007|\u009C)|\u001B[P^_X][\s\S]*?\u001B\\|[\u0090\u0098\u009E\u009F][\s\S]*?\u009C|(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B[@-_])/gu;

const sanitize = (text: string): string =>
  text.replace(ECMA_48_CONTROL, "").replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();

const CODEX_ESCAPE_NOTE =
  "BLOCKING security warning: codex sandbox escape — stop Codex seats and inspect shared git metadata before dispatch";
const CODEX_PROTECTED_ACTION =
  "action: codex worker cannot commit in its worktree — use an eligible non-Codex worker";
const MORE = "more: tickmarkr doctor prints the full capability matrix, model notes and host checks";

const CHECK_KEYS = ["workers", "judge-model", "consult-model", "visibility", "folders", "package-manager"] as const;
const ROLES = ["judge", "consult"] as const;

type TrustRecord = TrustVerdict | { status: "check-failed"; error: string };
type CheckKey = (typeof CHECK_KEYS)[number];

/** Record lookups are partial at runtime even though the index signature says otherwise. */
const healthOf = (health: Record<string, AuthHealth>, id: string): AuthHealth | undefined => health[id];
const trustOf = (trust: Record<string, TrustRecord>, id: string): TrustRecord | undefined => trust[id];

const isInstalled = (record: AuthHealth | undefined): boolean => record?.installed === true;

/** Sanitized version, or "installed", plus a parenthetical note only when the note survives the strip. */
const stateOf = (id: string, record: AuthHealth): string => {
  const version = sanitize(record.version ?? "") || "installed";
  const recorded = sanitize(record.note ?? "");
  const note = recorded || (id === codex.id && record.codexCommit === "escape" ? CODEX_ESCAPE_NOTE : "");
  return note ? `${version} (${note})` : version;
};

const headline = (
  adapters: readonly { id: string }[],
  installedAdapters: readonly { id: string }[],
  passing: readonly { id: string }[],
): string => {
  if (passing.length > 0) {
    return `ready: ${passing.map((adapter) => sanitize(adapter.id)).join(", ")} (${passing.length} of ${installedAdapters.length} installed agent CLIs)`;
  }
  if (installedAdapters.length > 0) {
    return `not ready: none of the ${installedAdapters.length} installed agent CLIs passes the capability check`;
  }
  if (adapters.length > 0) {
    return `not ready: no supported agent CLI is installed — install one of: ${adapters.map((adapter) => sanitize(adapter.id)).join(", ")}`;
  }
  return "not ready: no supported agent CLI is registered — configure an adapter, then run tickmarkr doctor";
};

const checkRank = (key: string): number => {
  const index = CHECK_KEYS.indexOf(key as CheckKey);
  return index === -1 ? CHECK_KEYS.length : index;
};

/** Pure: every row is derived from the recorded input. Rosters and counts use only `adapters`. */
export function readinessCard(input: {
  adapters: readonly { id: string }[];
  health: Record<string, AuthHealth>;
  trust: Record<string, TrustVerdict | { status: "check-failed"; error: string }>;
  roles: readonly { role: "judge" | "consult"; adapter: string; model: string }[];
  checks: readonly { key: CheckKey; detail: string }[];
}): string[] {
  const { adapters, health, trust, roles, checks } = input;
  const installedAdapters = adapters.filter((adapter) => isInstalled(healthOf(health, adapter.id)));
  const passing = adapters.filter((adapter) => adapterHealthy(adapter.id, healthOf(health, adapter.id)));
  const rows = [headline(adapters, installedAdapters, passing)];

  for (const adapter of installedAdapters) {
    const record = healthOf(health, adapter.id);
    if (!record || adapterHealthy(adapter.id, record)) continue;
    rows.push(`not ready: ${sanitize(adapter.id)} — ${stateOf(adapter.id, record)}`);
  }

  for (const adapter of adapters) {
    const record = healthOf(health, adapter.id);
    if (isInstalled(record)) continue;
    const note = sanitize(record?.note ?? "");
    if (!note) continue;
    rows.push(`action: ${sanitize(adapter.id)} unavailable — ${note}`);
  }

  const codexRecord = healthOf(health, codex.id);
  if (installedAdapters.some((adapter) => adapter.id === codex.id) && codexRecord?.codexCommit === "protected") {
    rows.push(CODEX_PROTECTED_ACTION);
  }

  for (const adapter of installedAdapters) {
    const record = trustOf(trust, adapter.id);
    if (record?.status === "action-required") {
      rows.push(`action: ${sanitize(adapter.id)} trust — run once: ${sanitize(record.command)}`);
    } else if (record?.status === "check-failed") {
      rows.push(`action: ${sanitize(adapter.id)} trust — check failed: ${sanitize(record.error)}; run tickmarkr doctor`);
    }
  }

  // A role's adapter is installed only as a member of this roster. A cached health row for an
  // id outside input.adapters must not suppress either warning.
  const installedIds = new Set(installedAdapters.map((adapter) => adapter.id));
  for (const role of ROLES) {
    for (const entry of roles) {
      if (entry.role !== role || installedIds.has(entry.adapter)) continue;
      rows.push(
        `action: ${role} runs on ${sanitize(entry.adapter)}:${sanitize(entry.model)}, which is not installed — that gate fails closed until you install it or remap ${role}`,
      );
    }
  }

  for (const check of [...checks].sort((a, b) => checkRank(a.key) - checkRank(b.key))) {
    rows.push(`action: ${check.key} — ${sanitize(check.detail)}`);
  }

  rows.push(MORE);
  return rows;
}
