import type { TickmarkrConfig } from "../config/config.js";
import { HerdrDriver } from "./herdr.js";
import { OrcaDriver } from "./orca.js";
import { SubprocessDriver } from "./subprocess.js";
import type { ExecutorDriver } from "./types.js";

export const DRIVER_CHOICES = ["auto", "herdr", "subprocess", "orca"] as const;
export type DriverChoice = (typeof DRIVER_CHOICES)[number];

const overrideByDriver = new WeakMap<ExecutorDriver, DriverChoice>();

/** Validate argv at the CLI boundary rather than casting an arbitrary string into a driver choice. */
export function parseDriverOverride(override?: string): DriverChoice | undefined {
  if (override === undefined) return undefined;
  for (const choice of DRIVER_CHOICES) if (override === choice) return choice;
  throw new Error(`usage: --driver must be one of ${DRIVER_CHOICES.join(" | ")} (got ${override})`);
}

export function driverEvidence(cfg: TickmarkrConfig, driver: ExecutorDriver, override?: string): string {
  const selectedOverride = override ?? overrideByDriver.get(driver);
  const want = parseDriverOverride(selectedOverride) ?? cfg.driver;
  if (selectedOverride !== undefined) return `${driver.id} (--driver)`;
  if (want !== "auto") return `${driver.id} (config)`;
  const herdrAvailable = process.env.HERDR_ENV === "1";
  if (driver.id === (herdrAvailable ? "herdr" : "subprocess")) {
    return `auto → ${driver.id} (${herdrAvailable ? "HERDR_ENV=1" : "HERDR_ENV unset"})`;
  }
  return `auto → ${driver.id} (runtime)`;
}

export function pickDriver(cfg: TickmarkrConfig, override?: string): ExecutorDriver {
  const selectedOverride = parseDriverOverride(override);
  const want = selectedOverride ?? cfg.driver;
  // VIS-09 item 2: plumb the per-tab cap into the HerdrDriver — the driver takes it as a constructor
  // param and never imports config (cfg is the only seam). Guaranteed present: DEFAULT_CONFIG seeds
  // workersPerTab:3 and deepMerge overlays on top, so a missing overlay key still resolves.
  const driver = want === "herdr" ? new HerdrDriver("herdr", cfg.visibility.workersPerTab)
    : want === "subprocess" ? new SubprocessDriver()
      // Orca is an operator-selected execution surface. Its runtime failure stays on Orca; selection
      // must never substitute a hidden subprocess worker after this explicit choice.
      : want === "orca" ? new OrcaDriver()
        : HerdrDriver.available() ? new HerdrDriver("herdr", cfg.visibility.workersPerTab) : new SubprocessDriver();
  if (selectedOverride !== undefined) overrideByDriver.set(driver, selectedOverride);
  return driver;
}
