import type { TickmarkrConfig } from "../config/config.js";
import { HerdrDriver } from "./herdr.js";
import { SubprocessDriver } from "./subprocess.js";
import type { ExecutorDriver } from "./types.js";

export function pickDriver(cfg: TickmarkrConfig, override?: "auto" | "herdr" | "subprocess"): ExecutorDriver {
  const want = override ?? cfg.driver;
  // VIS-09 item 2: plumb the per-tab cap into the HerdrDriver — the driver takes it as a constructor
  // param and never imports config (cfg is the only seam). Guaranteed present: DEFAULT_CONFIG seeds
  // workersPerTab:3 and deepMerge overlays on top, so a missing overlay key still resolves.
  if (want === "herdr") return new HerdrDriver("herdr", cfg.visibility.workersPerTab);
  if (want === "subprocess") return new SubprocessDriver();
  return HerdrDriver.available() ? new HerdrDriver("herdr", cfg.visibility.workersPerTab) : new SubprocessDriver();
}
