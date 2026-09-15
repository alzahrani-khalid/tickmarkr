import type { TickmarkrConfig } from "../config/config.js";
import { HerdrDriver } from "./herdr.js";
import { OrcaDriver } from "./orca.js";
import { SubprocessDriver } from "./subprocess.js";
import type { ExecutorDriver } from "./types.js";

export const DRIVER_CHOICES = ["auto", "herdr", "subprocess", "orca"] as const;
export type DriverChoice = (typeof DRIVER_CHOICES)[number];
export type ClassifiedHost = "herdr" | "orca" | "none";

const overrideByDriver = new WeakMap<ExecutorDriver, DriverChoice>();
// The host snapshot the driver was selected under: driverEvidence reads this, never process.env,
// so preflight, selection and the journal row all describe the same instant.
const hostByDriver = new WeakMap<ExecutorDriver, ClassifiedHost>();

/**
 * One host classifier beside the driver chooser reads the launching environment:
 * herdr only when HERDR_ENV is exactly 1, orca only when both Orca markers are present,
 * none otherwise. run and resume call it once at the refs-preflight point and thread the
 * result into pickDriver; nothing downstream reads the markers again.
 */
export function classifyHost(env: NodeJS.ProcessEnv = process.env): ClassifiedHost {
  if (env.HERDR_ENV === "1") return "herdr";
  if (env.TERM_PROGRAM === "Orca" && env.ORCA_TERMINAL_HANDLE !== undefined && env.ORCA_TERMINAL_HANDLE !== "") return "orca";
  return "none";
}

/**
 * A config driver of herdr or orca whose host is not the classified one is refused naming the
 * detected host, the config line and the --driver remedy. Any explicit --driver value bypasses
 * this; auto and subprocess are never refused.
 */
export function preflightHostDriver(cfg: TickmarkrConfig, driverOverride: string | undefined, host: ClassifiedHost): void {
  if (driverOverride !== undefined) return;
  if ((cfg.driver === "herdr" || cfg.driver === "orca") && cfg.driver !== host) {
    const remedy = host === "none" ? "subprocess" : host;
    throw new Error(
      `refusing driver '${cfg.driver}' (config line 'driver: ${cfg.driver}'): detected host is ${host}; use --driver ${remedy} to override`,
    );
  }
}

/**
 * Orca authors both markers on every terminal it creates. Requiring the pair avoids treating an
 * unrelated TERM_PROGRAM value or a copied terminal handle as host identity. This is deliberately
 * environment-only: selection must not execute a binary or contact the Orca runtime.
 */
export function orcaHostDetected(env: NodeJS.ProcessEnv = process.env): boolean {
  return classifyHost(env) === "orca";
}

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
  const host = hostByDriver.get(driver);
  if (host === "herdr" && driver.id === "herdr") return "auto → herdr (HERDR_ENV=1)";
  if (host === "orca" && driver.id === "orca") return "auto → orca (TERM_PROGRAM+ORCA_TERMINAL_HANDLE)";
  if (host === "none" && driver.id === "subprocess") return "auto → subprocess (HERDR_ENV unset)";
  return `auto → ${driver.id} (runtime)`;
}

export function pickDriver(cfg: TickmarkrConfig, override?: string, host: ClassifiedHost = classifyHost()): ExecutorDriver {
  const selectedOverride = parseDriverOverride(override);
  const want = selectedOverride ?? cfg.driver;
  // VIS-09 item 2: plumb the per-tab cap into the HerdrDriver — the driver takes it as a constructor
  // param and never imports config (cfg is the only seam). Guaranteed present: DEFAULT_CONFIG seeds
  // workersPerTab:3 and deepMerge overlays on top, so a missing overlay key still resolves.
  const driver = want === "herdr" ? new HerdrDriver("herdr", cfg.visibility.workersPerTab)
    : want === "subprocess" ? new SubprocessDriver()
      // Orca is an operator-selected execution surface. Its runtime failure stays on Orca; selection
      // must never substitute a hidden subprocess worker after an explicit or detected choice.
      : want === "orca" ? new OrcaDriver()
        : host === "herdr" ? new HerdrDriver("herdr", cfg.visibility.workersPerTab)
          : host === "orca" ? new OrcaDriver()
            : new SubprocessDriver();
  if (selectedOverride !== undefined) overrideByDriver.set(driver, selectedOverride);
  hostByDriver.set(driver, host);
  return driver;
}
