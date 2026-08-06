import { DEFAULT_CONFIG, fleetKeyLayer } from "./config.js";

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
};

export type FleetWhyRow<Id extends string = string> = FleetWhyValue<Id> & {
  source: FleetWhySource;
  label: string;
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

function sourceOf(value: FleetWhyValue, options: FleetWhyOptions): FleetWhySource {
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
      label: `${value.id}  →  ${value.effective}  · source: ${source}${setup}`,
    };
  });
}

/** Plain line-mode twin of the Shapes rows; labels are projected, never reconstructed here. */
export function renderFleetWhy(rows: readonly FleetWhyRow[]): string {
  return ["tickmarkr fleet --why — effective shape routing", ...rows.map((row) => row.label)].join("\n");
}
