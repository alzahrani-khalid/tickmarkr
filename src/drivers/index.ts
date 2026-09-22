import type { TickmarkrConfig } from "../config/config.js";
import { HerdrDriver } from "./herdr.js";
import { shq } from "../adapters/types.js";
import { sh } from "../run/git.js";
import { canonicalWorktreePath, OrcaDriver, OrcaError, parseEnvelope, resolveOrcaCliBinary, terminalWorktree } from "./orca.js";
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
  // A whitespace-only handle is no handle: the narrator trims it and would refuse the split.
  if (env.TERM_PROGRAM === "Orca" && (env.ORCA_TERMINAL_HANDLE ?? "").trim() !== "") return "orca";
  return "none";
}

const UNMANAGED_CHECKOUT = "checkout is not Orca-managed; run from an orca worktree create checkout or pass --driver subprocess";

/**
 * OBS-1061: the ONE admission probe — `worktree current` asked from the run root. Like the driver's
 * own per-checkout query it accepts an enclosing tracked checkout after path canonicalisation. An
 * untracked checkout refuses with both remedies; any other failure refuses naming its reason, never
 * read as managed.
 */
async function admitOrcaCheckout(runRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  const bin = resolveOrcaCliBinary(runRoot, { env }) ?? "orca";
  const refuse = (reason: string) => new Error(`refusing driver 'orca': Orca admission probe of ${runRoot} failed — ${reason}`);
  let reported: string | undefined;
  // The transport's own diagnostics (timeout, exit, stderr): a stderr-only failure such as a missing
  // executable parses as 'empty response', which alone names no cause.
  let transport = "";
  try {
    // Config values flow into a shell here: every argv element is quoted, always.
    const r = await sh([bin, "worktree", "current", "--json"].map(shq).join(" "), runRoot);
    const raw = [r.stdout, r.stderr ? `STDERR: ${r.stderr}` : ""].filter(Boolean).join("\n");
    transport = [r.timedOut ? "probe timed out" : r.code !== 0 ? `orca exited ${r.code}` : "", r.stderr.trim() ? `stderr: ${r.stderr.trim()}` : ""]
      .filter(Boolean).join("; ");
    const envelope = parseEnvelope("worktree-current", r.stdout, raw);
    // An ok:true body on a nonzero exit is a transport failure (stale stdout), as in the driver.
    if (r.code !== 0) throw new OrcaError("worktree-current", `orca exited ${r.code}`, raw);
    const worktree = envelope.result.worktree;
    reported = typeof worktree === "object" && worktree !== null && !Array.isArray(worktree)
      ? terminalWorktree(worktree as Record<string, unknown>)
      : undefined;
    if (!reported) throw new OrcaError("worktree-current", "response carries no worktree path", raw);
  } catch (e) {
    if (e instanceof OrcaError && e.code === "selector_not_found") throw new Error(`refusing driver 'orca': ${UNMANAGED_CHECKOUT}`);
    const reason = e instanceof OrcaError ? e.reason : (e as Error).message;
    throw refuse(transport.startsWith(reason) ? transport : [reason, transport].filter(Boolean).join("; "));
  }
  const tracked = canonicalWorktreePath(reported);
  const root = canonicalWorktreePath(runRoot);
  if (tracked !== root && !root.startsWith(`${tracked}/`)) throw new Error(`refusing driver 'orca': ${UNMANAGED_CHECKOUT}`);
}

/**
 * A config driver of herdr or orca whose host is not the classified one is refused naming the
 * detected host, the config line and the --driver remedy. Any explicit --driver value bypasses
 * that; auto and subprocess are never refused. Then, when the RESOLVED driver is orca (config,
 * auto on an Orca host, or an explicit flag), the run root is admitted by one probe before any run
 * directory, journal row or dispatch exists. Subprocess and herdr selections probe nothing.
 */
export async function preflightHostDriver(
  cfg: TickmarkrConfig,
  driverOverride: string | undefined,
  host: ClassifiedHost,
  runRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (driverOverride === undefined && (cfg.driver === "herdr" || cfg.driver === "orca") && cfg.driver !== host) {
    const remedy = host === "none" ? "subprocess" : host;
    throw new Error(
      `refusing driver '${cfg.driver}' (config line 'driver: ${cfg.driver}'): detected host is ${host}; use --driver ${remedy} to override`,
    );
  }
  const want = parseDriverOverride(driverOverride) ?? cfg.driver;
  const resolved = want === "auto" ? (host === "none" ? "subprocess" : host) : want;
  if (resolved === "orca") await admitOrcaCheckout(runRoot, env);
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
