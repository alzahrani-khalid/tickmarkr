import { DEFAULT_CONFIG, fleetKeyLayer } from "./config.js";
import { channelKey } from "../adapters/types.js";
import type { Route } from "../route/router.js";

export type ShapeWhy = {
  declaration: string;
  declaredAt?: string;
  operatorPinned?: boolean;
  members: { id: string; admitted: boolean; reason: string }[];
  routed?: Route;
  error?: string;
};

export type FleetWhySource =
  | "repo-overlay"
  | "global-config"
  | "seed-default"
  | "operator-pinned"
  | "defaulted";

export type FleetWhyValue<Id extends string = string> = {
  id: Id;
  effective: string;
  /** Dotted config path whose winning declaration produced this value. */
  declaredAt?: string;
  /** A live Shapes-screen pin outranks every persisted declaration. */
  operatorPinned?: boolean;
  /** Paste-ready only: projection and renderers never execute setup actions. */
  setupCommand?: string;
  shapeWhy?: ShapeWhy;
};

export type FleetWhyRow<Id extends string = string> = FleetWhyValue<Id> & {
  source: FleetWhySource;
  label: string;
  shapeSource?: FleetWhySource;
};

export type FleetWhyOptions = {
  repoRoot: string;
  globalDir?: string;
};

function valueAt(root: unknown, dotted: string): unknown {
  let value = root;
  for (const part of dotted.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function sourceOf(value: Pick<FleetWhyValue, "operatorPinned" | "declaredAt">, options: FleetWhyOptions): FleetWhySource {
  if (value.operatorPinned) return "operator-pinned";
  if (!value.declaredAt) return "defaulted";
  const layer = fleetKeyLayer(options.repoRoot, value.declaredAt, {
    globalDir: options.globalDir,
  });
  if (layer === "repo") return "repo-overlay";
  if (layer === "global") return "global-config";
  return valueAt(DEFAULT_CONFIG, value.declaredAt) === undefined
    ? "defaulted"
    : "seed-default";
}

/** The single fleet projection: every consumer receives the same value/source/setup label. */
export function projectFleetWhy<Id extends string>(
  values: readonly FleetWhyValue<Id>[],
  options: FleetWhyOptions,
): FleetWhyRow<Id>[] {
  return values.map((value) => {
    const source = sourceOf(value, options);
    const setup = value.setupCommand ? `\n    setup: ${value.setupCommand}` : "";
    return {
      ...value,
      source,
      ...(value.shapeWhy ? { shapeSource: sourceOf(value.shapeWhy, options) } : {}),
      label: `${value.id}  →  ${value.effective}  · source: ${source}${setup}`,
    };
  });
}

/** Reuse the Shapes labels and expand their route evidence for line-mode --why output. */
export function renderFleetWhy(rows: readonly FleetWhyRow[]): string {
  return ["tickmarkr fleet --why — effective shape routing", ...rows.map((row) =>
    row.label + (row.shapeWhy ? `\n${renderShapeWhy(row.shapeWhy, row.shapeSource)}` : ""))].join("\n");
}

/** The pick and choosing rule come verbatim from the production router's result. */
export function renderShapeWhy(why: ShapeWhy, source: FleetWhySource = "defaulted"): string {
  return [
    `  ${why.declaration} · source: ${source}`,
    ...why.members.map((member) => `    ${member.id}: ${member.admitted ? "admitted" : "skipped"} — ${member.reason}`),
    ...(why.routed ? [
      `  pick: ${channelKey(why.routed.assignment)}`,
      `  rule: ${why.routed.provenance}`,
      `  ladder: ${why.routed.ladder.join(" → ")}`,
      ...why.routed.lints.map((lint) => `  lint: ${lint}`),
    ] : [`  pick: unroutable — ${why.error ?? "routing unavailable"}`]),
  ].join("\n");
}

/** LEG2-T3: one exclusion-collector scope as the reason a fleet row shows — its config path, then
 * the entry that matched (a deny) or the fact the allowlist does not admit the channel. */
export function exclusionReason(scope: { by: "deny" | "allow"; configPath: string; entry: string }): string {
  return scope.by === "allow" ? `${scope.configPath} (not admitted)` : `${scope.configPath} (${scope.entry})`;
}
