import type { TickmarkrConfig } from "../config/config.js";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { stateDirName } from "../graph/graph.js";
import { hcScopePresent, localeFinding, protectedFolderFinding } from "./host-env.js";
import { HcClient } from "./hc-client.js";
import { HerdrDriver } from "./herdr.js";
import { HerdrAppDriver } from "./herdr-app.js";
import { shq } from "../adapters/types.js";
import { sh } from "../run/git.js";
import { canonicalWorktreePath, OrcaDriver, OrcaError, parseEnvelope, resolveOrcaCliBinary, terminalWorktree } from "./orca.js";
import { SubprocessDriver } from "./subprocess.js";
import type { ExecutorDriver } from "./types.js";

export const DRIVER_CHOICES = ["auto", "herdr", "subprocess", "orca", "herdr-app"] as const;
export type DriverChoice = (typeof DRIVER_CHOICES)[number];
export type ClassifiedHost = "herdr" | "herdr-app" | "orca" | "none";
/** Run/resume's one captured launch instant: the host, and whether an hc scope token was inherited (boolean only). */
export interface HostSnapshot { readonly host: ClassifiedHost; readonly inheritedScope: boolean }

const overrideByDriver = new WeakMap<ExecutorDriver, DriverChoice>();
// The host snapshot the driver was selected under: driverEvidence reads this, never process.env,
// so preflight, selection and the journal row all describe the same instant.
const hostByDriver = new WeakMap<ExecutorDriver, ClassifiedHost>();

/**
 * One host classifier beside the driver chooser reads the launching environment (CASE H, queue row 340; D-2180), in
 * order: classic herdr only when HERDR_ENV is exactly 1; the Herdr app when BOTH HC_TERMINAL_ID and HC_TERMINAL_SOCKET
 * are nonblank after trim; Orca only when TERM_PROGRAM is Orca and ORCA_TERMINAL_HANDLE is nonblank; none otherwise
 * (either HC marker alone, blank markers or ghostty alone). Environment only: it executes no binary. run and resume
 * call captureHost once at the refs-preflight point and thread the snapshot into pickDriver; nothing downstream reads
 * the markers again.
 */
export function classifyHost(env: NodeJS.ProcessEnv = process.env): ClassifiedHost {
  return hostMarkers(env)[0] ?? "none";
}

const nonblank = (v: string | undefined) => (v ?? "").trim() !== "";
const HOST_MARKERS: readonly (readonly [Exclude<ClassifiedHost, "none">, (env: NodeJS.ProcessEnv) => boolean])[] = [
  ["herdr", (env) => env.HERDR_ENV === "1"],
  ["herdr-app", (env) => nonblank(env.HC_TERMINAL_ID) && nonblank(env.HC_TERMINAL_SOCKET)],
  // A whitespace-only handle is no handle: the narrator trims it and would refuse the split.
  ["orca", (env) => env.TERM_PROGRAM === "Orca" && nonblank(env.ORCA_TERMINAL_HANDLE)],
];

/** Every host whose markers are present, in precedence order, BEFORE precedence picks one (D-2180 add.11): a row whose
 * markers are present but which loses to an earlier host says so instead of claiming selection. */
export function hostMarkers(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Exclude<ClassifiedHost, "none">[] {
  return HOST_MARKERS.filter(([, present]) => present(env as NodeJS.ProcessEnv)).map(([host]) => host);
}

/** D-2180 add.11: the ONE resolution — the wanted choice (an explicit --driver, else config), then auto by classifyHost
 * precedence. pickDriver builds it, preflightHostDriver admits it, and every doctor and init host claim reads it. */
export function resolveDriver(want: DriverChoice, host: ClassifiedHost): Exclude<DriverChoice, "auto"> {
  return want === "auto" ? (host === "none" ? "subprocess" : host) : want;
}

/** A config driver naming a host-specific driver off its own host: run and resume refuse it (an explicit --driver bypasses). */
export function configDriverRefused(cfgDriver: DriverChoice, host: ClassifiedHost): boolean {
  return (cfgDriver === "herdr" || cfgDriver === "herdr-app" || cfgDriver === "orca") && cfgDriver !== host;
}

/** The immutable launch snapshot: later environment mutation (the daemon deletes HC_SCOPE) cannot change it. */
export function captureHost(env: NodeJS.ProcessEnv = process.env): HostSnapshot {
  return Object.freeze({ host: classifyHost(env), inheritedScope: hcScopePresent(env) });
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
 * Queue row 340 (D-2180): the ONE hc / herdr-app executable resolution shared by doctor, preflight and the driver — the
 * client environment's own PATH, where the hc client's execFile (argv, no shell, no login profile) runs it. A login
 * shell lookup can see a profile-only install that no run can execute, so nothing here consults one. Filesystem only:
 * it executes nothing. ponytail: relative PATH entries are skipped (cwd-dependent); an install reachable only through
 * one reads absent everywhere, never admitted by one surface and refused by another.
 */
export function herdrAppBinary(bin: "hc" | "herdr-app", env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const path = join(dir, bin);
    try {
      if (statSync(path).isFile()) { accessSync(path, constants.X_OK); return path; }
    } catch { /* absent or not executable here: the next PATH entry */ }
  }
  return undefined;
}

/**
 * Queue row 340 (D-2180): admit a resolved herdr-app selection by the same validated client the driver uses — one
 * `hc server status --json` against the launcher's core, through the hc that herdrAppBinary resolves (the one doctor
 * reports and the driver runs). hc missing, a timeout, a signal, a nonzero exit or a malformed or incomplete body
 * refuses visibly before any run state; it is never replaced by subprocess. Status may start a core: that is the
 * selected intent. The app window is not consulted — without one, execution stays available.
 */
export async function admitHerdrApp(
  env: NodeJS.ProcessEnv, hcBin: string | undefined = herdrAppBinary("hc", env), timeoutMs?: number,
): Promise<{ coreId: string; version: string }> {
  if (!hcBin) {
    throw new Error("refusing driver 'herdr-app': hc not installed on this process's PATH; no other driver is substituted " +
      "(install hc, start the Herdr app, or choose another --driver)");
  }
  try {
    const status = await new HcClient({ hcBin, env, timeoutMs }).status();
    return { coreId: status.coreId, version: status.version };
  } catch (e) {
    throw new Error(`refusing driver 'herdr-app': hc server status failed — ${(e as Error).message.split("\n")[0]}; ` +
      "no other driver is substituted (install hc, start the Herdr app, or choose another --driver)");
  }
}

/**
 * A config driver of herdr, herdr-app or orca whose host is not the classified one is refused naming the detected
 * host, the config line and the --driver remedy. Any explicit --driver value bypasses that; auto and subprocess are
 * never refused. Then the RESOLVED driver is admitted before any run directory, journal row or dispatch exists: orca
 * by its checkout probe, herdr-app by hc server status. Subprocess and herdr selections probe nothing.
 */
export async function preflightHostDriver(
  cfg: TickmarkrConfig,
  driverOverride: string | undefined,
  host: ClassifiedHost,
  runRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { hcBin?: string; timeoutMs?: number } = {},
): Promise<void> {
  const locale = localeFinding(env);
  if (locale.verdict === "warn") console.warn(`tickmarkr: warning: locale — ${locale.detail}`);
  const root = canonicalWorktreePath(runRoot);
  const folders = protectedFolderFinding(root, canonicalWorktreePath(join(root, stateDirName(runRoot))),
    process.platform, env.HOME ? canonicalWorktreePath(env.HOME) : undefined);
  if (folders) process.stderr.write(`warning: ${folders.detail}\n`);
  if (driverOverride === undefined && configDriverRefused(cfg.driver, host)) {
    const remedy = host === "none" ? "subprocess" : host;
    throw new Error(
      `refusing driver '${cfg.driver}' (config line 'driver: ${cfg.driver}'): detected host is ${host}; use --driver ${remedy} to override`,
    );
  }
  const want = parseDriverOverride(driverOverride) ?? cfg.driver;
  const resolved = resolveDriver(want, host);
  if (resolved === "orca") await admitOrcaCheckout(runRoot, env);
  if (resolved === "herdr-app") await admitHerdrApp(env, opts.hcBin, opts.timeoutMs);
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
  if (host === "herdr-app" && driver.id === "herdr-app") return "auto → herdr-app (HC_TERMINAL_ID+HC_TERMINAL_SOCKET)";
  if (host === "orca" && driver.id === "orca") return "auto → orca (TERM_PROGRAM+ORCA_TERMINAL_HANDLE)";
  if (host === "none" && driver.id === "subprocess") return "auto → subprocess (HERDR_ENV unset)";
  return `auto → ${driver.id} (runtime)`;
}

const herdrAppDriver = () => new HerdrAppDriver({ hcBin: herdrAppBinary("hc"), appBin: herdrAppBinary("herdr-app") });

export function pickDriver(cfg: TickmarkrConfig, override?: string, host: ClassifiedHost = classifyHost()): ExecutorDriver {
  const selectedOverride = parseDriverOverride(override);
  const want = selectedOverride ?? cfg.driver;
  // VIS-09 item 2: plumb the per-tab cap into the HerdrDriver — the driver takes it as a constructor
  // param and never imports config (cfg is the only seam). Guaranteed present: DEFAULT_CONFIG seeds
  // workersPerTab:3 and deepMerge overlays on top, so a missing overlay key still resolves.
  const resolved = resolveDriver(want, host);
  const driver = resolved === "herdr" ? new HerdrDriver("herdr", cfg.visibility.workersPerTab)
    // Queue row 340 (D-2180): the hc client keeps the launcher's HC pair (process.env) to reach its core, and runs the
    // hc and herdr-app that preflight admitted and doctor reported (herdrAppBinary), never a later PATH lookup.
    : resolved === "herdr-app" ? herdrAppDriver()
      // Orca is an operator-selected execution surface. Its runtime failure stays on Orca; selection
      // must never substitute a hidden subprocess worker after an explicit or detected choice.
      : resolved === "orca" ? new OrcaDriver()
        : new SubprocessDriver();
  if (selectedOverride !== undefined) overrideByDriver.set(driver, selectedOverride);
  hostByDriver.set(driver, host);
  return driver;
}
