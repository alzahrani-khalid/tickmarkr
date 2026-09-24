import type { CommandReceiptAttribution, ShellReceipt } from "./protocol.js";
import { executionSignal } from "./execution-budget.js";
import { commandLeaseEnvironment, withCommandLease } from "./lease.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { shq } from "../adapters/types.js";
import { tickmarkrDir } from "../graph/graph.js";
import { ROUTING_ENV_SEAMS } from "../route/router.js";

export { ROUTING_ENV_SEAMS };

// OBS-110: gate/baseline/tip-verify children are vitest suites; without a fork cap, concurrent
// full-suite gate runs fork a worker-per-core pool per worktree and saturate the operator box.
// Default to a modest cap through the environment so vitest honors it natively; never pass it
// as argv (OBS-55) so child test oracles stay intact. The operator's own export wins.
export const FORK_CAP_ENV = "VITEST_MAX_FORKS";
export const SUITE_PARENT_ENV = "TICKMARKR_SUITE_PARENT";
export const DEFAULT_FORK_CAP = "6";

/** Worker concurrency is resolved once per run and isolated from other async runs. */
const forkBudget = new AsyncLocalStorage<string>();
const verificationBudget = new AsyncLocalStorage<RunCapacity>();

/** Verification uses command leases; workers keep their concurrency budget. */
export const runWithVerificationBudget = <T>(capacity: RunCapacity, fn: () => Promise<T>): Promise<T> =>
  verificationBudget.run(capacity, fn);

/**
 * OBS-618: how many PROCESSES one vitest fork can hold at its peak — the fork, a daemon it spawns,
 * and that daemon's own `git` child. The previous formula counted FORKS and assumed one process
 * each, which is the assumption this suite violates by design: its tests spawn daemons that spawn
 * git, so demand is a MULTIPLE of the cap and the fork table sees that multiple, not the cap.
 *
 * Measured, not guessed: on an 18-core machine at `concurrency: 1` the old formula authorised 18
 * forks. Six gate batteries across two tasks with no shared file (T1, T3) and two vendors (claude,
 * codex) then died on `spawn EAGAIN` — at load1 as low as 2.21, so this is fork-table exhaustion and
 * not CPU saturation. 18 ÷ 3 = 6, which is exactly the value `DEFAULT_FORK_CAP` was already set to;
 * the number was right and only the derivation was missing.
 */
export const SPAWN_FANOUT = 3;

/**
 * cap = max(1, floor(cores / (concurrency × SPAWN_FANOUT))). Total PROCESS demand is then
 * cap × concurrency × SPAWN_FANOUT, which stays at or under `cores` wherever the floor is non-zero,
 * and the `max(1, …)` pins it to one fork per run when the machine is too small to divide — a run
 * cannot give a suite less than one fork.
 *
 * Portable by construction: `availableParallelism()` reports the CPUs actually usable by this
 * process (it honours CPU affinity), so a 2-core CI runner derives 1, an 18-core workstation derives
 * 6, and a 64-core host derives 21 — no machine is named anywhere and no value is pinned.
 * ⚠ It is a FLOOR of 1, never 0: on a small host the cap stops dividing and the protection this
 * provides runs out. That is the honest bound — a 2-core runner at concurrency 1 gets one fork and
 * the fan-out is then bounded by the suite itself, not by us.
 */
export const deriveForkCap = (concurrency: number, cores: number = availableParallelism()): number =>
  Math.max(1, Math.floor(cores / (Math.max(1, concurrency) * SPAWN_FANOUT)));

/** Run `fn` with the fork budget this run's resolved concurrency implies. */
export const runWithForkBudget = <T>(concurrency: number, fn: () => Promise<T>): Promise<T> =>
  forkBudget.run(String(deriveForkCap(concurrency)), fn);

/** The cap owned by the run on this async context; the standalone default outside one. */
export const resolvedForkCap = (): string => forkBudget.getStore() ?? DEFAULT_FORK_CAP;

/**
 * T7: the CAPACITY a suite verdict was measured under — the fork cap the command's child actually
 * received, and the core count that cap was divided from. Two verdicts are comparable only when both
 * numbers match: a run resumed at a different capacity divides the machine by a different
 * number, so a green measured in that other world is not evidence about this one.
 *
 * This pair is the WHOLE comparable identity, and the load averages a gate row already carries beside
 * it are deliberately NOT part of it — no reader below ever feeds a load sample into the comparison.
 * The capacity is deterministic and resolved here, where the child's environment is built. The load
 * endpoints are neither: they are two samples taken at a gate's boundaries, and a gate's INTERIOR is
 * invisible to them — on this milestone's own run a gate's interior reached well over twice what
 * either of its own endpoints saw. So matching capacity establishes only that two measurements
 * divided the same machine by the same number. It says nothing about whether the machine was calm.
 */
export interface RunCapacity { forkCap: number; cores: number }

export type CapacityRead =
  | { state: "present"; capacity: RunCapacity }
  | { state: "absent" }
  | { state: "malformed" };

const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * Three states, never two. A record carrying NO capacity is an older record from before this stamp
 * existed: it keeps exactly the verdict it has today. A record carrying a capacity it cannot state —
 * half the pair, an empty container, a zero, a negative, an unparseable value — is a NEWER record
 * that is malformed, and reading it as an older one is how a fail-closed guard stops firing silently.
 */
export function readCapacity(value: unknown): CapacityRead {
  if (value === undefined) return { state: "absent" };
  if (value === null || typeof value !== "object") return { state: "malformed" };
  const { forkCap, cores } = value as Record<string, unknown>;
  return positiveInt(forkCap) && positiveInt(cores)
    ? { state: "present", capacity: { forkCap, cores } }
    : { state: "malformed" };
}

/**
 * May a verdict recorded under `recorded` be reused — forgiven, cached, replayed — by a session
 * running under `current`? Absent → yes, unchanged. Present and identical → yes. Malformed, a
 * different capacity, or a current capacity the caller could not state → no.
 */
export function sameCapacity(recorded: unknown, current: RunCapacity | undefined): boolean {
  const read = readCapacity(recorded);
  if (read.state === "absent") return true;
  if (read.state === "malformed" || current === undefined) return false;
  return read.capacity.forkCap === current.forkCap && read.capacity.cores === current.cores;
}

/**
 * R41: the verification PROTOCOL a verdict was produced under — which implementation of the manifest
 * discovery/report contract judged it, and the npm lifecycle policy its runner children ran with.
 * Two verdicts are comparable only when both match: a manifest built from module collection ("vl1.1",
 * the pre-stamp implementation) and one built from file specifications ("vl1.2") certify different
 * sets, and a suite whose `pretest` hook ran (ignore-scripts=false) is a different measurement from
 * one where npm skipped it. Bump VERIFICATION_PROTOCOL whenever discovery or report semantics change.
 */
export const VERIFICATION_PROTOCOL = "vl1.2";
export type RunnerLifecycle = "hooks" | "ignore-scripts" | "unknown";
export interface VerificationProtocol {
  protocol: string;
  /** The EFFECTIVE npm lifecycle policy a runner child receives: `hooks` (pretest/prebuild run),
   * `ignore-scripts` (npm skips them), or `unknown` (could not be measured — never comparable). */
  lifecycle: RunnerLifecycle;
  /** Provenance only, never part of compatibility: an explicit process-scoped env export, or npm's
   * own resolved config for that checkout (user/project npmrc). */
  source: "explicit" | "npm-config" | "unknown";
}

const lifecycleOf = (raw: string | undefined): Exclude<RunnerLifecycle, "unknown"> | undefined => {
  const v = raw?.trim().toLowerCase();
  return v === "false" ? "hooks" : v === "true" ? "ignore-scripts" : undefined;
};

// Measured effective policy, keyed on everything npm resolves it from that this process can see:
// the checkout, its project npmrc and the user npmrc (path + mtime), and the explicit env. A
// rewritten npmrc changes the key, so a later battery in the same process re-measures.
const measuredLifecycle = new Map<string, RunnerLifecycle>();
const mtimeOf = (p: string): string => { try { return String(statSync(p).mtimeMs); } catch { return "-"; } };

/**
 * R41: the lifecycle policy a runner child spawned from `env` in `cwd` receives. An explicit
 * process-scoped `npm_config_ignore_scripts` export decides (npm reads env over every npmrc) and is
 * recorded as such; otherwise the policy is MEASURED from npm's own resolved config for that checkout
 * (`npm config get ignore-scripts` — user npmrc, project npmrc, env), so the identity binds what
 * npm will actually do rather than a guess. A policy that cannot be measured is `unknown`, and an
 * unknown policy is never compatible with anything, itself included. No env or npmrc is written here.
 */
export function runnerLifecycle(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Pick<VerificationProtocol, "lifecycle" | "source"> {
  const explicit = lifecycleOf(env.npm_config_ignore_scripts ?? env.NPM_CONFIG_IGNORE_SCRIPTS);
  if (explicit) return { lifecycle: explicit, source: "explicit" };
  const userconfig = env.NPM_CONFIG_USERCONFIG ?? env.npm_config_userconfig ?? join(homedir(), ".npmrc");
  const key = [cwd, mtimeOf(join(cwd, ".npmrc")), userconfig, mtimeOf(userconfig),
    env.npm_config_ignore_scripts ?? env.NPM_CONFIG_IGNORE_SCRIPTS ?? ""].join("\0");
  let lifecycle = measuredLifecycle.get(key);
  if (lifecycle === undefined) {
    try {
      const out = execFileSync("npm", ["config", "get", "ignore-scripts"], {
        cwd: existsSync(cwd) ? cwd : process.cwd(), env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"],
      });
      lifecycle = lifecycleOf(out) ?? "unknown";
    } catch {
      lifecycle = "unknown";
    }
    measuredLifecycle.set(key, lifecycle);
  }
  return { lifecycle, source: lifecycle === "unknown" ? "unknown" : "npm-config" };
}

export function verificationProtocol(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): VerificationProtocol {
  return { protocol: VERIFICATION_PROTOCOL, ...runnerLifecycle(env, cwd) };
}

/**
 * May a verdict recorded under `recorded` be reused — cached, replayed — by a session running
 * `current`? Unlike capacity, ABSENT is NOT compatible: a row with no protocol stamp was produced by
 * the pre-stamp implementation (module-collection discovery, lifecycle unstated), which is exactly
 * the evidence a changed protocol must not inherit — positive or negative. Malformed → no. An
 * `unknown` lifecycle on either side → no: two unmeasured policies are not the same policy.
 * `source` is provenance and never enters the comparison — an explicit `false` and an npmrc `false`
 * are the same effective policy.
 */
export function sameVerification(recorded: unknown, current: VerificationProtocol): boolean {
  if (recorded === null || typeof recorded !== "object") return false;
  const { protocol, lifecycle } = recorded as Record<string, unknown>;
  if (lifecycle === "unknown" || current.lifecycle === "unknown") return false;
  return protocol === current.protocol && lifecycle === current.lifecycle;
}

export const describeVerification = (value: unknown): string => {
  if (value === null || typeof value !== "object") return "an unrecorded verification protocol";
  const { protocol, lifecycle, source } = value as Record<string, unknown>;
  return typeof protocol === "string" && typeof lifecycle === "string"
    ? `protocol ${protocol}, lifecycle ${lifecycle}${typeof source === "string" ? ` (${source})` : ""}` : "a malformed verification protocol";
};

export const describeCapacity = (value: unknown): string => {
  const read = readCapacity(value);
  return read.state === "present"
    ? `fork cap ${read.capacity.forkCap} of ${read.capacity.cores} cores`
    : read.state === "absent" ? "an unrecorded capacity" : "a malformed capacity";
};

/**
 * The capacity a child spawned on THIS async context would receive: the same precedence `shell`
 * applies below — the verification budget captures any operator export at run start — beside the
 * cores it was divided from. A caller holding a command's own result reads the capacity off THAT
 * result (`ShResult.capacity`, stamped where the child's environment was built); this is for the
 * decisions taken BEFORE any child exists — a cache hit, a reuse predicate.
 */
export const resolvedCapacity = (): RunCapacity => verificationBudget.getStore() ?? ({
  forkCap: Number(FORK_CAP_ENV in process.env ? process.env[FORK_CAP_ENV] : resolvedForkCap()),
  cores: availableParallelism(),
});

/** The shipped shell ceiling: the fallback every caller gets when nothing measured a better one. */
export const DEFAULT_SHELL_TIMEOUT_MS = 600000;

// durationMs is the child's own wall clock, measured at this one seam so no caller has to bracket its
// own Date.now() around a shell (two callers bracketing differently is how a "measured" number starts
// disagreeing with itself). On a timeout it is the elapsed time at the kill, not the ceiling.
export interface ShResult {
  code: number;
  signalExit?: boolean;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** The shell exited, but descendants still held its process group and pipes past the grace. */
  reapedGroup?: boolean;
  /** The grace reap's group kill failed with something other than ESRCH (for example EPERM). */
  reapError?: string;
  durationMs?: number;
  /** T7: the capacity THIS child ran under, stamped where its environment was built (see `shell`). */
  capacity?: RunCapacity;
}

/**
 * OBS-688: every gate, every baseline capture and every tip verification reaches the machine through
 * this one seam, and the seam took its spawn from the standard library directly — so the one failure
 * it must handle, the kernel REFUSING the fork, was unreachable from a fixture and could only be
 * described. It is injectable here for exactly that reason; production always holds `spawn` itself.
 * Undefined-until-set, never captured at module load: the standard library binding stays read at
 * CALL time, exactly as before this seam existed, so a suite that mocks `node:child_process` without
 * a `spawn` export still imports this module (tests/adapters/pi-auth.test.ts does).
 */
let spawnChild: typeof spawn | undefined;
export const setSpawnForTests = (fn: typeof spawn): void => { spawnChild = fn; };
export const resetSpawnForTests = (): void => { spawnChild = undefined; };

/**
 * A refusal is NOT evidence about the work: the command never started, so nothing ran, and a retry
 * cannot repeat a side effect. That argument is the whole safety case for retrying here, and it
 * holds for exactly one closed case — the kernel refused the fork for a temporary resource shortage
 * (EAGAIN: the fork table is full, which a gate burst does to a box twice in one night). Every
 * other spawn error is a standing fact about the machine — a missing interpreter above all — and
 * retrying it buys nothing while delaying every genuine failure by the whole backoff, so it returns
 * on the first read. The retry is also gated on the child having produced NO byte and never having
 * emitted `spawn`: past either, a command has run and re-running it is a side effect, never a retry.
 */
const RETRYABLE_SPAWN_CODE = "EAGAIN";
export const SPAWN_ATTEMPT_LIMIT = 4;
export const SPAWN_RETRY_BACKOFF_MS = 50;

/** A spawn the machine refused before the command started; carries the error for the caller. */
interface SpawnRefusal { refused: NodeJS.ErrnoException }

// RULING-P99-28: SHIP — every gate user can hit the inherited-pipe hang at this product seam.
/** Give a normally-exited shell's descendants this long to close their inherited pipes themselves. */
const SHELL_REAP_GRACE_MS = 2000;

// stdin "ignore": same class as HARD-05 / SubprocessDriver — never leave an open pipe a child can block on
// (pi -p / codex exec wait for stdin EOF). timedOut distinguishes SIGKILL-timeout from a real nonzero exit.
export interface ShellOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onSpawn?: (pid: number | undefined) => void;
  onTimeout?: () => void;
  /** Independent of the legacy pid callback; started means the child emitted spawn. */
  onReceipt?: (receipt: ShellReceipt) => void;
  /** Called once per invocation (1-based), including each pre-spawn retry. */
  receiptAttribution?: (invocation: number) => CommandReceiptAttribution;
}

/** Shared command seam, including invocation-bound manifested runners. */
export function shell(cmd: string, cwd: string, timeoutMs: number, login = false, options: ShellOptions = {}): Promise<ShResult> {
  const inherited = executionSignal();
  const signal = inherited && options.signal ? AbortSignal.any([inherited, options.signal]) : inherited ?? options.signal;
  let attribution: CommandReceiptAttribution | undefined;
  let confirmedStart = false;
  let terminal = false;
  const begin = (invocation: number) => {
    attribution = options.receiptAttribution?.(invocation);
    confirmedStart = false;
    terminal = false;
  };
  const emit = (receipt: Omit<ShellReceipt, "attribution" | "confirmedStart">) => {
    if (terminal) return;
    if (receipt.outcome === "started") confirmedStart = true;
    else terminal = true;
    // Observational callbacks must not change process cleanup, retries or cancellation.
    try { options.onReceipt?.({ ...receipt, confirmedStart, ...(attribution ? { attribution: { ...attribution } } : {}) }); }
    catch { /* receipt sinks are observational */ }
  };
  const checkAbort = () => {
    if (signal?.aborted) emit({ outcome: "cancelled", exitCode: null, signal: null });
    signal?.throwIfAborted();
  };
  begin(1);
  checkAbort();
  return withCommandLease(cmd, () => executeShell(cmd, cwd, timeoutMs, login, { ...options, signal }, { begin, emit, checkAbort }))
    .catch((error: unknown) => {
      if (signal?.aborted) emit({ outcome: "cancelled", exitCode: null, signal: null });
      throw error;
    });
}

interface ShellObservation {
  begin: (invocation: number) => void;
  emit: (receipt: Omit<ShellReceipt, "attribution" | "confirmedStart">) => void;
  checkAbort: () => void;
}

function executeShell(cmd: string, cwd: string, timeoutMs: number, login: boolean, options: ShellOptions, observation: ShellObservation): Promise<ShResult> {
  observation.checkAbort();
  // OBS-74: scrub tickmarkr's own routing env seams from every child — a daemon carrying
  // TICKMARKR_QUALITY leaked it into baseline/gate/tip-verify children, turning a dogfood
  // repo's route() tests red inside the gates. Scrub a copy at this one choke point so
  // children are hermetic by construction; the daemon's own process.env stays unchanged.
  const env = commandLeaseEnvironment(options.env ?? process.env);
  for (const k of ROUTING_ENV_SEAMS) delete env[k];
  // A run freezes the operator override and cores at startup; admission can lower the round cap.
  env[FORK_CAP_ENV] = verificationBudget.getStore()
    ? String(resolvedCapacity().forkCap)
    : env[FORK_CAP_ENV] ?? resolvedForkCap();
  // OBS-854: descendants can leave the checkout (nested fixture suites do), so cwd alone cannot
  // attribute them. Every daemon shell exports the daemon pid as their durable parentage marker.
  env[SUITE_PARENT_ENV] = String(process.pid);
  // T7: the capacity every result of this shell carries, read HERE — off the environment the child
  // is about to receive, after the precedence above has settled. An operator export is already in
  // `env`, so what gets recorded is the operator's number, which is the case a release was re-taken
  // for; re-deriving the run's own budget after the command returned would stamp a cap no child ran
  // under. `Number` of an unparseable export is NaN, which every reader treats as malformed and
  // therefore fails closed — the honest direction when the cap in play cannot be stated.
  const capacity: RunCapacity = { forkCap: Number(env[FORK_CAP_ENV]), cores: resolvedCapacity().cores };
  const attempt = (): Promise<ShResult | SpawnRefusal> => new Promise((resolve) => {
    const startedAt = Date.now();
    // detached: bash gets its own process group so a timeout can kill the whole tree —
    // SIGKILLing bash alone orphans grandchildren (codex/pi) that hold the stdio pipes
    // open, so "close" never fires and the promise wedges forever (v1.33.1 init hang).
    let p: ReturnType<typeof spawn>;
    try {
      p = (spawnChild ?? spawn)("bash", [login ? "-lc" : "-c", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (error) {
      observation.emit({ outcome: "spawn-failed", exitCode: null, signal: null, error: String(error) });
      throw error;
    }
    let stdout = "", stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let timedOut = false, reapedGroup = false, done = false, started = false, outputSeen = false;
    let reapError: string | undefined, exitedCode: number | undefined;
    let signalExit = false;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: string | undefined;
    let reapTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    const finish = (code: number, err?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(reapTimer);
      clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", abort);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      observation.emit({
        outcome: options.signal?.aborted ? "cancelled" : timedOut ? "timed-out" : spawnError ? "spawn-failed" : "completed",
        pid: p.pid, exitCode: signalExit || spawnError ? null : code,
        signal: exitSignal, ...(spawnError ? { error: spawnError } : {}),
        durationMs: Date.now() - startedAt,
      });
      resolve({
        code,
        ...(signalExit ? { signalExit: true } : {}),
        stdout,
        stderr: err ?? stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        capacity,
        ...(reapedGroup ? { reapedGroup: true } : {}),
        ...(reapError ? { reapError } : {}),
      });
    };
    // Escaped descendants can retain pipes even after the shell and its group are dead.
    const boundDrain = () => {
      if (!done && !drainTimer) drainTimer = setTimeout(() => {
        p.stdout?.destroy();
        p.stderr?.destroy();
        finish(exitedCode ?? 1);
      }, 100);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      options.onTimeout?.();
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ESRCH") {
          reapError ??= `${code ?? "kill"}: ${error instanceof Error ? error.message : String(error)}`;
        }
        p.kill("SIGKILL");
        // A failed group kill can leave inherited pipes open forever; the command ceiling still wins.
        if (code !== "ESRCH") finish(exitedCode ?? 1);
      }
      boundDrain();
    }, timeoutMs);
    const abort = () => {
      try { process.kill(-p.pid!, "SIGKILL"); } catch { p.kill("SIGKILL"); }
      boundDrain();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    options.onSpawn?.(p.pid);
    if (options.signal?.aborted) abort();
    p.on("spawn", () => { started = true; observation.emit({ outcome: "started", pid: p.pid }); }); // the command exists from here on — never retryable past it
    // OBS-716: one stateful decoder per stream carries an incomplete UTF-8 sequence into that
    // stream's next pipe chunk; decoding each chunk through string concatenation corrupts bytes at
    // kernel-chosen boundaries. A deterministic fixture proves this decoder correct rather than
    // proving every caller byte-safe: real chunk boundaries are the kernel's to choose, so timing
    // still decides whether a chunk-local decoder exposes the defect in any particular run.
    p.stdout!.on("data", (d) => {
      if (d.length > 0) outputSeen = true;
      stdout += stdoutDecoder.write(d);
    });
    p.stderr!.on("data", (d) => {
      if (d.length > 0) outputSeen = true;
      stderr += stderrDecoder.write(d);
    });
    p.on("error", (e: NodeJS.ErrnoException) => {
      spawnError = String(e);
      if (!done && !started && !outputSeen && e.code === RETRYABLE_SPAWN_CODE) {
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        observation.emit({ outcome: "spawn-failed", exitCode: null, signal: null, error: String(e), durationMs: Date.now() - startedAt });
        resolve({ refused: e });
        return;
      }
      finish(127, String(e));
    });
    p.on("close", (code, signal) => { signalExit = code === null; exitSignal = signal; finish(code ?? 1); });
    // "close" waits for stdio to drain. Once bash exits normally, give descendants a bounded grace
    // to exit with it; a survivor still in bash's detached group is then reaped so its inherited pipe
    // cannot hold this promise until the command ceiling. A real timeout wins first and is never
    // reclassified as a grace reap.
    p.on("exit", (code, signal) => {
      exitSignal = signal;
      signalExit = code === null;
      exitedCode = code ?? 1;
      // Allow a short pipe drain after killing, bounded even for an escaped descendant.
      if (timedOut) return;
      reapTimer = setTimeout(() => {
        if (done) return;
        try {
          process.kill(-p.pid!, "SIGKILL");
          reapedGroup = true;
        } catch (error) {
          // ESRCH means the group closed in the grace race; every other error must survive to the
          // result while the command timeout remains the explicit backstop.
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          if (code !== "ESRCH") reapError = `${code ?? "kill"}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }, SHELL_REAP_GRACE_MS);
    });
  });
  return (async () => {
    const startedAt = Date.now();
    for (let n = 1; ; n++) {
      if (n > 1) observation.begin(n);
      observation.checkAbort();
      const r = await attempt();
      if (!("refused" in r)) return r;
      // Bounded, and the bound is what makes a persisting shortage a REPORTED failure rather than a
      // wedged daemon: past it the caller gets the refusal's own text under exit 127, as before.
      if (n >= SPAWN_ATTEMPT_LIMIT) {
        return { code: 127, stdout: "", stderr: String(r.refused), durationMs: Date.now() - startedAt, capacity };
      }
      await new Promise((wake) => setTimeout(wake, SPAWN_RETRY_BACKOFF_MS * n));
    }
  })();
}

export function sh(cmd: string, cwd: string, timeoutMs = DEFAULT_SHELL_TIMEOUT_MS, options: ShellOptions = {}): Promise<ShResult> {
  return shell(cmd, cwd, timeoutMs, true, options);
}

// Git plumbing never needs an operator profile; skip login-shell startup and its side effects.
export function shGit(cmd: string, cwd: string, timeoutMs = DEFAULT_SHELL_TIMEOUT_MS): Promise<ShResult> {
  return shell(cmd, cwd, timeoutMs, false);
}

export async function shOk(cmd: string, cwd: string): Promise<string> {
  const r = await sh(cmd, cwd);
  if (r.code !== 0) throw new Error(`command failed (${r.code}): ${cmd}\n${r.stderr || r.stdout}`);
  return r.stdout;
}

export async function shGitOk(cmd: string, cwd: string): Promise<string> {
  const r = await shGit(cmd, cwd);
  if (r.code !== 0) throw new Error(`command failed (${r.code}): ${cmd}\n${r.stderr || r.stdout}`);
  return r.stdout;
}

const NPM_DEPENDENCY_MANIFESTS = ["package.json", "package-lock.json", "npm-shrinkwrap.json"];

// OBS-126: compare the whole attempt (committed, staged, unstaged, or newly added manifest) with
// the task's integration-tip baseline. A committed package.json change is invisible to `git status`,
// while an untracked manifest is invisible to `git diff`, so both views are required.
export async function npmDependencyManifestChanged(cwd: string, baselineRef: string): Promise<boolean> {
  const paths = NPM_DEPENDENCY_MANIFESTS.map(shq).join(" ");
  const diff = await shGit(`git diff --quiet ${shq(baselineRef)} -- ${paths}`, cwd);
  if (diff.code === 1) return true;
  if (diff.code !== 0) {
    throw new Error(`dependency manifest comparison failed (${diff.code}): ${diff.stderr || diff.stdout}`);
  }
  const untracked = await shGit(`git ls-files --others --exclude-standard -- ${paths}`, cwd);
  if (untracked.code !== 0) {
    throw new Error(`dependency manifest comparison failed (${untracked.code}): ${untracked.stderr || untracked.stdout}`);
  }
  return untracked.stdout.trim().length > 0;
}

// npm reifies a worktree's node_modules symlink as a private directory, which makes a successful
// install disappear at worktree cleanup. Build positional specs from the attempt manifest so the
// daemon can install them at the main repo root (the provisioned link's target) without saving them
// into that baseline manifest. `--install-links` packs file: dependencies before the attempt is removed.
export function npmDependencyInstallCommand(cwd: string): string {
  const manifestPath = join(cwd, "package.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    : {};
  const dependencyGroups = [
    manifest.peerDependencies,
    manifest.devDependencies,
    manifest.dependencies,
    manifest.optionalDependencies,
  ];
  const dependencies: Record<string, string> = {};
  for (const group of dependencyGroups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    for (const [name, spec] of Object.entries(group)) {
      if (typeof spec === "string") dependencies[name] = spec;
    }
  }
  const specs = Object.entries(dependencies).map(([name, rawSpec]) => {
    let spec = rawSpec;
    if (spec.startsWith("file:")) spec = `file:${resolve(cwd, spec.slice("file:".length))}`;
    else if (spec.startsWith("./") || spec.startsWith("../")) spec = resolve(cwd, spec);
    return shq(`${name}@${spec}`);
  });
  return [
    "npm install --no-save --no-audit --no-fund --package-lock=false --install-links",
    ...specs,
  ].join(" ");
}

export async function gitHead(cwd: string): Promise<string> {
  return (await shGitOk("git rev-parse HEAD", cwd)).trim();
}

export const sanitizeBranch = (branch: string) => branch.replace(/[^\w.-]+/g, "-");

const sanitize = sanitizeBranch;

// OBS-49: macOS Spotlight skips any *.noindex directory, so worktree churn during gate bursts
// stops spawning mdworkers (9 mdworkers measured on an 18-core M5 Max at load-77). Accepted cost:
// CLI trust stores key on exact worktree paths (OBS-16), so each worktree re-prompts for trust
// once after this rename — the same one-time per-install cost as the v1.38 state-dir rename.
export const WORKTREES_DIR = "worktrees.noindex";

export const worktreePath = (repo: string, branch: string) =>
  join(tickmarkrDir(repo), WORKTREES_DIR, sanitize(branch));

/** OBS-28: remove this run's recorded worktrees; tolerates already-gone paths. */
export async function cleanupRunWorktrees(
  repo: string,
  branch: string,
  opts: { removeIntegration: boolean; removeTaskIds: string[] },
): Promise<void> {
  if (opts.removeIntegration) await removeWorktree(repo, worktreePath(repo, branch));
  for (const id of opts.removeTaskIds) await removeWorktree(repo, worktreePath(repo, `${branch}--${id}`));
}


export async function resolveIntegrationBranch(_repo: string, branch: string): Promise<string> {
  return branch;
}

const resolveTaskBranch = async (repo: string, branch: string): Promise<string> => {
  const split = branch.lastIndexOf("--");
  if (split < 0) return branch;
  const integration = await resolveIntegrationBranch(repo, branch.slice(0, split));
  return `${integration}${branch.slice(split)}`;
};

/**
 * Preserve the bytes an existing checkout holds before recreation removes it.
 *
 * `git stash create` cannot do this job: its apparent `-u` argument is accepted as a message and
 * untracked files never enter the stash object. Build the snapshot through a disposable index
 * instead. The index starts at HEAD (so no unrelated residue from the checkout's real index enters
 * the tree), stages the complete working tree including ordinary untracked paths, and lives outside
 * the repository so it cannot stage itself. None of these plumbing commands writes the checkout or
 * its real index.
 *
 * The returned ref is the durable recovery handle. A clean checkout returns undefined and creates
 * neither a commit nor a ref, keeping meaningful deaths visible rather than minting one ref per
 * ordinary dispatch.
 */
export async function preserveWorktree(cwd: string): Promise<string | undefined> {
  if (!existsSync(cwd)) return undefined;
  const scratch = mkdtempSync(join(tmpdir(), "tickmarkr-preserve-index-"));
  const index = join(scratch, "index");
  const withIndex = (command: string) => `GIT_INDEX_FILE=${shq(index)} ${command}`;
  try {
    await shGitOk(withIndex("git read-tree HEAD"), cwd);
    await shGitOk(withIndex("git add -A -- ."), cwd);
    const tree = (await shGitOk(withIndex("git write-tree"), cwd)).trim();
    const headTree = (await shGitOk("git rev-parse 'HEAD^{tree}'", cwd)).trim();
    if (tree === headTree) return undefined;

    // Do not depend on consumer-level identity configuration: this is an engine recovery object,
    // not an authored project commit. Its HEAD parent makes the preserved tree directly inspectable.
    const identity = "GIT_AUTHOR_NAME=tickmarkr GIT_AUTHOR_EMAIL=tickmarkr@localhost "
      + "GIT_COMMITTER_NAME=tickmarkr GIT_COMMITTER_EMAIL=tickmarkr@localhost";
    const commit = (await shGitOk(
      `${identity} git commit-tree ${shq(tree)} -p HEAD -m ${shq("tickmarkr: preserve uncommitted worktree")}`,
      cwd,
    )).trim();
    const ref = `refs/tickmarkr/preserved/${commit}`;
    await shGitOk(`git update-ref ${shq(ref)} ${shq(commit)}`, cwd);
    return ref;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function createWorktree(repo: string, branch: string, baseRef: string): Promise<string> {
  branch = await resolveTaskBranch(repo, branch);
  const dir = join(tickmarkrDir(repo), WORKTREES_DIR, sanitize(branch));
  if (existsSync(dir)) await removeWorktree(repo, dir);
  await shGitOk(`git worktree add -B ${shq(branch)} ${shq(dir)} ${shq(baseRef)}`, repo);
  linkNodeModules(repo, dir);
  return dir;
}

// OBS-41/OBS-47: the harness provisions node_modules as a symlink into the main repo so devDep-based
// gates (tsx, vitest) resolve in a bare worktree. Provisioning (createWorktree) calls this LENIENT —
// create the link only when dest is absent, never clobber (best-effort, never fails worktree creation).
// The pre-gate re-assert (OBS-47) calls this with force:true — a worker that deleted/replaced the link
// (real directory, wrong/broken symlink) is restored to the provisioned link. Idempotent: an
// already-correct link is a no-op. Returns whether dest is the provisioned link: provisioning ignores
// the result; the pre-gate caller treats false as a named environmental park, never a masked test red.
// OBS-78: target repos typically ignore `node_modules/` — a directories-only pattern that does NOT
// match the provisioned SYMLINK, so a worker staging with `git add -A` commits the link and burns an
// attempt on the scope gate. Write `node_modules` (no slash: matches the link too) into the exclude
// file git actually consults for this worktree. Per-worktree `info/` is ignored in linked worktrees
// (gitrepository-layout redirects it), so resolve through the `.git` gitfile + `commondir` indirection
// to the common git dir. Local git metadata only — the target repository's .gitignore is never edited.
// Idempotent (appends only when no entry exists) and best-effort, like the link itself.
function excludeNodeModules(dir: string): void {
  try {
    let gitDir = join(dir, ".git");
    if (lstatSync(gitDir).isFile()) { // linked worktree: .git is a gitfile naming the real git dir
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m) return;
      gitDir = resolve(dir, m[1]);
    }
    const commondir = join(gitDir, "commondir");
    if (existsSync(commondir)) gitDir = resolve(gitDir, readFileSync(commondir, "utf8").trim());
    const exclude = join(gitDir, "info", "exclude");
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (/^node_modules$/m.test(current)) return; // already excluded — repeated re-asserts add nothing
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(exclude, current + (current && !current.endsWith("\n") ? "\n" : "") + "node_modules\n");
  } catch { /* not a git checkout (bare tmpdir in tests) — never fail provisioning over the exclude */ }
}

export interface DependencyLink {
  /** Package link, relative to node_modules (including @scope/name). */
  link: string;
  target: string;
  classification: "worktree" | "node_modules" | "outside";
}

/** Inventory only package-level links; never descend into installed packages. */
export function inventoryDependencyLinks(worktree: string): DependencyLink[] {
  const dependencyPath = join(worktree, "node_modules");
  try { lstatSync(dependencyPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const root = realpathSync(worktree);
  const dependencies = realpathSync(dependencyPath);
  const inside = (parent: string, target: string): boolean => {
    const rel = relative(parent, target);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  };
  const links: DependencyLink[] = [];
  const inspect = (link: string): void => {
    const path = join(dependencies, link);
    if (!lstatSync(path).isSymbolicLink()) return;
    const target = realpathSync(path);
    links.push({ link, target, classification: inside(root, target) ? "worktree"
      : inside(dependencies, target) ? "node_modules" : "outside" });
  };
  for (const entry of readdirSync(dependencies).sort()) {
    inspect(entry);
    if (entry.startsWith("@") && statSync(join(dependencies, entry)).isDirectory()) {
      for (const child of readdirSync(join(dependencies, entry)).sort()) inspect(join(entry, child));
    }
  }
  return links;
}

/** Shared pre-command refusal; unreadable inventories cannot establish isolation either. */
export function dependencyLinkRefusal(worktree: string): string | undefined {
  try {
    const outside = inventoryDependencyLinks(worktree).filter(link => link.classification === "outside");
    if (!outside.length) return undefined;
    return "infra: OBS-1118 refusing verification: dependency links resolve outside the worktree and real node_modules:\n"
      + outside.map(({ link, target }) => `node_modules/${link} -> ${target}`).join("\n");
  } catch (error) {
    return `infra: OBS-1118 refusing verification: cannot inventory dependency links in ${worktree}: ${String(error)}`;
  }
}

export function linkNodeModules(repo: string, dir: string, { force = false } = {}): boolean {
  const src = join(repo, "node_modules");
  const dest = join(dir, "node_modules");
  if (!existsSync(src)) return true; // nothing provisioned to link — correct state is no link (OBS-27 best-effort)
  excludeNodeModules(dir); // OBS-78: the link must never be stageable in this worktree
  try {
    if (lstatSync(dest).isSymbolicLink() && readlinkSync(dest) === src) return true; // already the provisioned link
  } catch { /* dest absent — fall through to create */ }
  if (!force && existsSync(dest)) return false; // lenient provisioning (OBS-41): never clobber an existing entry
  try {
    rmSync(dest, { recursive: true, force: true }); // force tolerates absent; clears a wrong link / real dir / file
    symlinkSync(src, dest, "dir");
    return true;
  } catch {
    return false;
  }
}

// OBS-47: the worktree layout the harness provisions, stated in the worker prompt so cheap-tier workers
// stop tripping the scope gate by committing/deleting/replacing node_modules. The harness re-asserts the
// link itself before gates regardless (gates never trust worker claims) — this contract just keeps the
// worker from spending an attempt on environment repair.
export const WORKTREE_LAYOUT_CONTRACT = `## Worktree layout contract (harness-provisioned — do not modify)
- node_modules is a symlink into the main repo's node_modules, provisioned by tickmarkr. Never commit, delete, or replace it — the harness re-asserts this link before gates run, so modifying it cannot help and may fail your attempt.`;

/** A declared patch this probe could not find in the target's history, with the paths it touched. */
export interface MissingDeclaredPatch { commit: string; paths: string[]; merge: boolean }

/**
 * `contained` — every declared patch is in the target, by ancestry or by patch identity.
 * `drifted`   — at least one declared patch is missing (or is an unproven merge); each is named.
 * `unresolvable` — git could not answer; the raw git output is kept so the caller reports evidence,
 * not a guess. Only `contained` is a clean verdict: the other two never let a caller assume one.
 */
export type BaseContainment =
  | { result: "contained"; via: "ancestry" | "patch-id" }
  | { result: "drifted"; missing: MissingDeclaredPatch[] }
  | { result: "unresolvable"; ref: string; evidence: string };

// First-parent name-only diff: works for ordinary commits, merges (--diff-merges=first-parent, which
// a bare -m would widen to every parent's diff) and the root commit (--root), so one command names
// the paths of every commit shape this probe can report. The raw result is returned, never a path
// list: a failed diff-tree produced NO paths, and folding that into an empty array would ship a
// drifted verdict whose "touched nothing" evidence git never said — an empty list is only an answer
// after a successful command, so the caller turns a failure into unresolvable with git's own words.
const touchedPaths = (cwd: string, sha: string): Promise<ShResult> =>
  shGit(`git diff-tree --no-commit-id --name-only -z -r --root --diff-merges=first-parent ${shq(sha)}`, cwd);

/**
 * Is the declared base contained in `targetRef`'s history? Pure git evidence — no journal, no daemon
 * state, no worker claim. Ancestry answers it outright; a recreated branch carries the same patches
 * under new commit identities, which `git cherry` settles by patch-id.
 *
 * The trap this probe exists to refuse: `git cherry` (like `git log -p | git patch-id`) SKIPS merge
 * commits, so a declared tip whose unique commits are all merges produces an EMPTY patch stream, and
 * "no missing patches" reads exactly like "contained". So the verdict is NOT read off that stream.
 * The commits are enumerated from `git rev-list --parents`, which sees merges, and patch identity
 * only ever SUBTRACTS from that list: every unique commit is drift until something proves it, and
 * for a merge the only direct proof git offers is reachability from the target — which would have
 * kept it out of the range to begin with. The `!merge` guard below keeps that fail-closed even if a
 * future `git cherry` ever emitted a `-` line for a merge.
 */
export async function declaredBaseContainment(
  cwd: string,
  declaredRef: string,
  targetRef = "HEAD",
): Promise<BaseContainment> {
  for (const ref of [declaredRef, targetRef]) {
    const r = await shGit(`git rev-parse --verify ${shq(`${ref}^{commit}`)}`, cwd);
    if (r.code !== 0) return { result: "unresolvable", ref, evidence: (r.stderr || r.stdout).trim() };
  }
  const ancestor = await shGit(`git merge-base --is-ancestor ${shq(declaredRef)} ${shq(targetRef)}`, cwd);
  if (ancestor.timedOut) {
    const detail = (ancestor.stderr || ancestor.stdout).trim();
    return {
      result: "unresolvable",
      ref: declaredRef,
      evidence: `git merge-base --is-ancestor timed out${detail ? `: ${detail}` : ""}`,
    };
  }
  if (ancestor.code === 0) return { result: "contained", via: "ancestry" };
  // 1 is the honest "not an ancestor"; anything else is git failing to answer, never a clean read.
  if (ancestor.code !== 1) {
    return { result: "unresolvable", ref: declaredRef, evidence: (ancestor.stderr || ancestor.stdout).trim() };
  }
  // Ancestry above is a POSITIVE proof and survives a truncated history; everything below reads
  // history as if it were complete, and a shallow clone is exactly the history that is not. Its
  // graft makes the boundary commit parentless, so `rev-list` stops there and `git cherry` offers
  // the boundary's whole tree as ONE synthetic patch — which a single squashed commit on the target
  // matches, hiding every truncated declared patch behind it (a depth-1 clone reports one matched
  // patch where the complete repository reports three missing ones). The same truncation on the
  // target side invents drift just as easily, so neither verdict is available: the repository does
  // not hold the evidence, and saying so is the only honest read.
  const shallow = await shGit("git rev-parse --is-shallow-repository", cwd);
  if (shallow.code !== 0 || shallow.stdout.trim() !== "false") {
    const said = (shallow.stdout || shallow.stderr).trim();
    return { result: "unresolvable", ref: declaredRef, evidence: `git rev-parse --is-shallow-repository: ${said}` };
  }
  const range = `${shq(targetRef)}..${shq(declaredRef)}`;
  const listed = await shGit(`git rev-list --parents ${range}`, cwd);
  if (listed.code !== 0) {
    return { result: "unresolvable", ref: declaredRef, evidence: (listed.stderr || listed.stdout).trim() };
  }
  const cherry = await shGit(`git cherry ${shq(targetRef)} ${shq(declaredRef)}`, cwd);
  if (cherry.code !== 0) {
    return { result: "unresolvable", ref: declaredRef, evidence: (cherry.stderr || cherry.stdout).trim() };
  }
  const proven = new Set(
    cherry.stdout.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()),
  );
  const missing: MissingDeclaredPatch[] = [];
  for (const line of listed.stdout.split("\n").filter((l) => l.trim())) {
    const [sha, ...parents] = line.trim().split(/\s+/);
    const merge = parents.length > 1;
    if (!merge && proven.has(sha!)) continue;
    const paths = await touchedPaths(cwd, sha!);
    if (paths.code !== 0) {
      return { result: "unresolvable", ref: sha!, evidence: (paths.stderr || paths.stdout).trim() };
    }
    missing.push({ commit: sha!, paths: paths.stdout.split("\0").filter((path) => path.length > 0), merge });
  }
  return missing.length > 0 ? { result: "drifted", missing } : { result: "contained", via: "patch-id" };
}

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  await shGit(`git worktree remove --force ${shq(dir)}`, repo); // best-effort; stale dirs are re-added with -B
  await shGit(`rm -rf ${shq(dir)}`, repo);
  await shGit("git worktree prune", repo);
}

export const REFS_PREFLIGHT_PREFIX = "refs/tickmarkr/preflight";
export const REFS_PROBE_REMEDY =
  "run from the main repository or a full clone; a sandbox that denies writes under that path cannot host a run";

export interface RefsProbeOk {
  ok: true;
  path: string;
  refsDir: string;
}

export interface RefsProbeRefusal {
  ok: false;
  path: string;
  refsDir: string;
  error: string;
}

export type RefsProbeResult = RefsProbeOk | RefsProbeRefusal;

export function refsRefusalMessage(action: "run" | "resume", path: string, error: string): string {
  return `refusing to ${action}: repository refs directory ${path} is not writable (${error}). `
    + `Remedy: ${REFS_PROBE_REMEDY}.`;
}

/**
 * OBS-983/984: prove the repository's common git directory accepts a ref write before starting
 * the daemon. In a linked worktree, git resolves refs to the main repository's git directory.
 * Creates and deletes a real ref under refs/tickmarkr/preflight/ through git itself, leaving
 * nothing behind on success.
 */
export async function probeRefsWritable(cwd: string = process.cwd()): Promise<RefsProbeResult> {
  const refsPathRes = await shGit("git rev-parse --git-path refs", cwd);
  if (refsPathRes.code !== 0) {
    const error = (refsPathRes.stderr || refsPathRes.stdout).trim() || "git rev-parse --git-path refs failed";
    return { ok: false, path: "", refsDir: "", error };
  }
  const raw = refsPathRes.stdout.trim();
  let refsDir = resolve(cwd, raw);
  try {
    refsDir = realpathSync(refsDir);
  } catch {
    // keep resolved path if realpath fails
  }

  const headRes = await shGit("git rev-parse HEAD", cwd);
  const target = headRes.code === 0 && headRes.stdout.trim()
    ? headRes.stdout.trim()
    : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  const probeId = `probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ref = `${REFS_PREFLIGHT_PREFIX}/${probeId}`;

  const createRes = await shGit(`git update-ref ${shq(ref)} ${shq(target)}`, cwd);
  if (createRes.code !== 0) {
    const error = (createRes.stderr || createRes.stdout).trim() || `git update-ref failed (${createRes.code})`;
    return { ok: false, path: refsDir, refsDir, error };
  }

  const delRes = await shGit(`git update-ref -d ${shq(ref)}`, cwd);
  if (delRes.code !== 0) {
    const error = (delRes.stderr || delRes.stdout).trim() || `git update-ref -d failed (${delRes.code})`;
    return { ok: false, path: refsDir, refsDir, error };
  }

  // Clean up empty directories left behind by git
  try {
    const preflightDir = join(refsDir, "tickmarkr", "preflight");
    if (existsSync(preflightDir) && readdirSync(preflightDir).length === 0) {
      rmSync(preflightDir, { recursive: true, force: true });
    }
    const tmDir = join(refsDir, "tickmarkr");
    if (existsSync(tmDir) && readdirSync(tmDir).length === 0) {
      rmSync(tmDir, { recursive: true, force: true });
    }
  } catch {
    // best-effort cleanup of empty dirs
  }

  return { ok: true, path: refsDir, refsDir };
}

export const probeRefs = probeRefsWritable;
export const refsProbe = probeRefsWritable;

export async function assertRefsWritable(cwd: string = process.cwd(), action: "run" | "resume" = "run"): Promise<RefsProbeResult> {
  const probe = await probeRefsWritable(cwd);
  if (!probe.ok) {
    throw new Error(refsRefusalMessage(action, probe.path, probe.error));
  }
  return probe;
}
