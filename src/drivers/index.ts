import type { TickmarkrConfig } from "../config/config.js";
import { HerdrDriver } from "./herdr.js";
import { OrcaDriver } from "./orca.js";
import { SubprocessDriver } from "./subprocess.js";
import type { ExecutorDriver } from "./types.js";

export const DRIVER_CHOICES = ["auto", "herdr", "subprocess", "orca"] as const;
export type DriverChoice = (typeof DRIVER_CHOICES)[number];

/** Validate argv at the CLI boundary rather than casting an arbitrary string into a driver choice. */
export function parseDriverOverride(override?: string): DriverChoice | undefined {
  if (override === undefined) return undefined;
  for (const choice of DRIVER_CHOICES) if (override === choice) return choice;
  throw new Error(`usage: --driver must be one of ${DRIVER_CHOICES.join(" | ")} (got ${override})`);
}

export function pickDriver(cfg: TickmarkrConfig, override?: string): ExecutorDriver {
  const want = parseDriverOverride(override) ?? cfg.driver;
  // VIS-09 item 2: plumb the per-tab cap into the HerdrDriver — the driver takes it as a constructor
  // param and never imports config (cfg is the only seam). Guaranteed present: DEFAULT_CONFIG seeds
  // workersPerTab:3 and deepMerge overlays on top, so a missing overlay key still resolves.
  if (want === "herdr") return new HerdrDriver("herdr", cfg.visibility.workersPerTab);
  if (want === "subprocess") return new SubprocessDriver();
  // Orca is an operator-selected execution surface. Its runtime failure stays on Orca; selection
  // must never substitute a hidden subprocess worker after this explicit choice.
  if (want === "orca") return new OrcaDriver();
  return HerdrDriver.available() ? new HerdrDriver("herdr", cfg.visibility.workersPerTab) : new SubprocessDriver();
}
