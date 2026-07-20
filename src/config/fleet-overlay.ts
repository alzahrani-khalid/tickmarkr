// Fleet-overlay provenance cluster (v1.61 seed 8): harvesting, serialization, and diff rendering
// for the `tickmarkr fleet` write path. Pure move out of config.ts — prior import paths preserved
// via re-exports there.
import { isMap, isScalar, isSeq, parseDocument, stringify } from "yaml";
import type { FleetEditable, MapEntry, Tier } from "./config.js";

/** Fleet-owned overlay keys — the only config surface `tickmarkr fleet` may write. */
export const FLEET_OVERLAY_KEYS = ["routing", "tiers"] as const;

function fleetSubset(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FLEET_OVERLAY_KEYS) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function sortedUnique(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

/** Trailing `# note` comments on per-entry lines an operator may have hand-written or a prior
 *  fleet write stamped: model tier lines (including null tombstones) and deny list items. */
export type HarvestedProvenance = {
  tiers: Record<string, Record<string, string>>;
  denyAdapters: Record<string, string>;
  denyModels: Record<string, string>;
};

/** OBS-88: harvest existing provenance comments from raw repo-overlay bytes at fleet-session
 *  load. yaml.parse discards comments, so before this every fleet write re-serialized the file
 *  knowing only the current session's own notes and silently stripped all prior ones — a typed
 *  benchmark-provenance note survived exactly one write. Fail-open to empty: an unreadable
 *  overlay is the loader's problem to reject, never the harvester's. */
export function harvestFleetProvenance(overlayText: string): HarvestedProvenance {
  const out: HarvestedProvenance = { tiers: {}, denyAdapters: {}, denyModels: {} };
  if (!overlayText.trim()) return out;
  const doc = parseDocument(overlayText);
  const note = (n: unknown): string | undefined => {
    const c = isScalar(n) ? n.comment : undefined;
    return typeof c === "string" && c.trim() ? c.trim() : undefined;
  };
  const tiers = doc.getIn(["tiers"]);
  if (isMap(tiers)) {
    for (const ap of tiers.items) {
      if (!isScalar(ap.key)) continue;
      const models = isMap(ap.value) ? ap.value.get("models") : undefined;
      if (!isMap(models)) continue;
      for (const mp of models.items) {
        const n = note(mp.value);
        if (isScalar(mp.key) && n) (out.tiers[String(ap.key.value)] ??= {})[String(mp.key.value)] = n;
      }
    }
  }
  for (const [key, dest] of [["adapters", out.denyAdapters], ["models", out.denyModels]] as const) {
    const seq = doc.getIn(["routing", "deny", key]);
    if (!isSeq(seq)) continue;
    for (const item of seq.items) {
      const n = note(item);
      if (isScalar(item) && n) dest[String(item.value)] = n;
    }
  }
  return out;
}

/** Harvested deny-entry notes keyed by the exact entry string, re-attached at serialize time. */
export type FleetDenyNotes = { adapters?: Record<string, string>; models?: Record<string, string> };

/** Build the repo overlay fragment fleet would write for edits since session start. */
export function fleetRepoOverlayFromDelta(
  initial: FleetEditable,
  edited: FleetEditable,
  existingRepo: Record<string, unknown> = {},
): Record<string, unknown> {
  if (fleetEditableEquals(initial, edited)) return {};
  const out = structuredClone(existingRepo) as Record<string, unknown>;
  const routing = { ...(out.routing as Record<string, unknown> | undefined) };
  let routingTouched = false;
  const denyChanged =
    sortedUnique(initial.denyAdapters).join() !== sortedUnique(edited.denyAdapters).join()
    || sortedUnique(initial.denyModels).join() !== sortedUnique(edited.denyModels).join();
  if (denyChanged) {
    routing.deny = {
      adapters: edited.denyAdapters.length ? edited.denyAdapters : null,
      models: edited.denyModels.length ? edited.denyModels : null,
    };
    routingTouched = true;
  }
  const mapDelta: Record<string, MapEntry> = {};
  for (const shape of new Set([...Object.keys(initial.map), ...Object.keys(edited.map)])) {
    if (JSON.stringify(initial.map[shape]) !== JSON.stringify(edited.map[shape])) mapDelta[shape] = edited.map[shape];
  }
  if (Object.keys(mapDelta).length) {
    routing.map = { ...(routing.map as Record<string, MapEntry> | undefined), ...mapDelta };
    routingTouched = true;
  }
  const floorDelta: Record<string, Tier> = {};
  for (const shape of new Set([...Object.keys(initial.floors), ...Object.keys(edited.floors)])) {
    if (initial.floors[shape] !== edited.floors[shape]) floorDelta[shape] = edited.floors[shape];
  }
  if (Object.keys(floorDelta).length) {
    routing.floors = { ...(routing.floors as Record<string, Tier> | undefined), ...floorDelta };
    routingTouched = true;
  }
  if (routingTouched) out.routing = routing;
  const tiersOut: Record<string, { models: Record<string, Tier | null> }> = {
    ...(out.tiers as Record<string, { models: Record<string, Tier | null> }> | undefined),
  };
  let tiersTouched = false;
  const adapters = new Set([...Object.keys(initial.tiers), ...Object.keys(edited.tiers)]);
  for (const adapter of adapters) {
    const models = new Set([
      ...Object.keys(initial.tiers[adapter] ?? {}),
      ...Object.keys(edited.tiers[adapter] ?? {}),
    ]);
    const modelDelta: Record<string, Tier | null> = {};
    for (const model of models) {
      const a = initial.tiers[adapter]?.[model];
      const b = edited.tiers[adapter]?.[model];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        modelDelta[model] = b === null || b === undefined ? null : b.tier;
      }
    }
    if (Object.keys(modelDelta).length) {
      // spread the existing entry so vendor/channel/windows survive the rewrite — dropping them
      // makes the overlay unloadable for any adapter without a default seed (reload-guard class)
      tiersOut[adapter] = { ...tiersOut[adapter], models: { ...tiersOut[adapter]?.models, ...modelDelta } };
      tiersTouched = true;
    }
  }
  if (tiersTouched) out.tiers = tiersOut;
  return out;
}

export function repoOverlayYaml(
  overlay: Record<string, unknown>,
  provenance: Record<string, Record<string, string>> = {},
  denyNotes: FleetDenyNotes = {},
): string {
  if (!Object.keys(overlay).length) return "";
  const fleet = fleetSubset(overlay);
  const fleetBody = serializeFleetOverlay(fleet, provenance, denyNotes);
  const rest = { ...overlay };
  for (const k of FLEET_OVERLAY_KEYS) delete rest[k];
  if (!Object.keys(rest).length) return fleetBody;
  const head = stringify(rest).trimEnd();
  return fleetBody ? `${head}\n${fleetBody}` : `${head}\n`;
}

export function serializeFleetOverlay(
  overlay: Record<string, unknown>,
  provenance: Record<string, Record<string, string>> = {},
  denyNotes: FleetDenyNotes = {},
): string {
  if (!Object.keys(overlay).length) return "";
  const lines: string[] = [];
  // OBS-75: never glue stringify() output onto a key line — wrap the key into the object and
  // re-indent the whole emitted block, so sequences/nested maps nest correctly and null
  // tombstones/empty collections survive the serialize→parse round-trip.
  const block = (obj: Record<string, unknown>, pad: string): string[] =>
    stringify(obj).trimEnd().split("\n").map((l) => `${pad}${l}`);
  // deny lists emit item-by-item through the same stringify quoting rules as block(), so a
  // harvested `# reason` can re-attach to its exact entry (multi-line emissions never take one)
  const denySeq = (key: "adapters" | "models", v: string[] | null | undefined): string[] => {
    if (v === undefined) return [];
    if (v === null || !v.length) return block({ [key]: v }, "    ");
    const out = [`    ${key}:`];
    for (const item of v) {
      const emitted = stringify([item]).trimEnd().split("\n");
      const n = denyNotes[key]?.[item];
      if (n && emitted.length === 1) emitted[0] += `  # ${n}`;
      out.push(...emitted.map((l) => `      ${l}`));
    }
    return out;
  };
  const routing = overlay.routing as Record<string, unknown> | undefined;
  if (routing) {
    lines.push("routing:");
    const deny = routing.deny as { adapters?: string[] | null; models?: string[] | null } | undefined;
    if (deny && (deny.adapters !== undefined || deny.models !== undefined)) {
      lines.push("  deny:");
      lines.push(...denySeq("adapters", deny.adapters));
      lines.push(...denySeq("models", deny.models));
    }
    if (routing.map) lines.push(...block({ map: routing.map as Record<string, MapEntry> }, "  "));
    if (routing.floors) lines.push(...block({ floors: routing.floors as Record<string, unknown> }, "  "));
  }
  const tiers = overlay.tiers as
    | Record<string, { vendor?: string; channel?: string; windows?: Record<string, number>; models?: Record<string, Tier | null> }>
    | undefined;
  if (tiers && Object.keys(tiers).length) {
    lines.push("tiers:");
    for (const [adapter, entry] of Object.entries(tiers)) {
      const body: string[] = [];
      if (entry.vendor) body.push(`    vendor: ${entry.vendor}`);
      if (entry.channel) body.push(`    channel: ${entry.channel}`);
      if (entry.windows) body.push(...block({ windows: entry.windows }, "    "));
      const models = Object.entries(entry.models ?? {});
      if (models.length) {
        body.push("    models:");
        for (const [model, tier] of models) {
          // OBS-88: notes serialize verbatim (fresh session notes arrive pre-stamped with their
          // "— fleet <date>" suffix), so a harvested note round-trips byte-for-byte every write
          const note = provenance[adapter]?.[model];
          const suffix = note ? `  # ${note}` : "";
          body.push(`      ${model}: ${tier === null ? "null" : tier}${suffix}`);
        }
      } else if (entry.models) {
        body.push("    models: {}"); // present-but-empty: explicit {} — a childless header parses as null and the loader rejects it
      }
      // a bare `adapter:` line parses as a null tombstone and would DELETE the adapter's default seeds on merge
      if (body.length) lines.push(`  ${adapter}:`, ...body);
      else lines.push(`  ${adapter}: {}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function unifiedYamlDiff(before: string, after: string, label = "config overlay"): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  // v1.60 T3: shortest-edit (LCS) matching. The old scan resynced greedily on the first mismatched
  // line, so one inserted line could cascade into a whole-file remove/re-add hunk on the one
  // confirmation surface an operator reviews before a write.
  // ponytail: O(n·m) table — overlays are tens of lines; Myers O(nd) if files ever grow.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const header = [`--- ${label} (current)`, `+++ ${label} (proposed)`];
  const hunks: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const del: string[] = [];
    const add: string[] = [];
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i] === b[j])) {
      if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) del.push(`-${a[i++]}`);
      else add.push(`+${b[j++]}`);
    }
    hunks.push("@@", ...del, ...add);
  }
  return `${header.join("\n")}\n${hunks.join("\n")}\n`;
}

export function fleetEditableEquals(a: FleetEditable, b: FleetEditable): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
