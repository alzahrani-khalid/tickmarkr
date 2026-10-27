import { type ChildProcess, spawn, spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { shq } from "../adapters/types.js";
import { createWorktree, FORK_CAP_ENV, resolvedForkCap } from "../run/git.js";
import { HOST_SESSION_VARS, SEAT_MARKER_ENV, withoutHostSession } from "./host-env.js";
import { workerReapHost } from "../run/stall.js";
import type { ExecutorDriver, NotificationPost, NotifyOpts, Slot, TransportState } from "./types.js";

export type NotificationPoster = (command: string, args: string[], options: SpawnSyncOptions) =>
  Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "signal">;

// HARD-03: cap retained worker output so a chatty worker can't grow tickmarkr's heap unbounded.
// 2MB is safe against BOTH consumers: the largest read() call site asks for 1000 lines
// (daemon.ts:217/247), and every marker (TICKMARKR_RESULT, TICKMARKR_EXIT_<nonce>) is emitted at the
// END of output — a trailer would only be evicted if >2MB arrived AFTER it inside one 200ms
// waitOutput poll (~10MB/s sustained, far beyond agent-CLI rates). Tail-truncate, never head:
// consumers only ever tail-read.
export const MAX_BUF = 2 * 1024 * 1024;

// OBS-17 / v1.22 T3 and OBS-843: host control-plane vars that let a process address the operator's
// herdr or Orca UI. Workers, judges, reviewers, and consults must never inherit them — only the
// daemon process and its driver calls keep the live session. TERM_PROGRAM is host description, not
// an addressing capability, and ORCA_AGENT_HOOK_* belongs to agent status transport, so both stay.
// Keep the exported name for compatibility even though the list is now host-neutral.
export const HERDR_CONTROL_VARS = [
  "HERDR_ENV",
  "HERDR_SOCKET_PATH",
  "ORCA_TERMINAL_HANDLE",
  "ORCA_PANE_KEY",
  "ORCA_TAB_ID",
] as const;

/**
 * Copy of worker env with the fork cap applied and host control-plane and host-session vars stripped.
 * Workers retain the run's concurrency-derived cap (resolvedForkCap), independently of
 * verification's suite-window budget. The operator's own export still wins. An inherited seat marker is stripped
 * (D-2174): a pane seat's own script exports its role after this seal.
 */
export function sealHerdrEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = withoutHostSession(env); // queue row 193
  if (!(FORK_CAP_ENV in out)) out[FORK_CAP_ENV] = resolvedForkCap();
  for (const k of HERDR_CONTROL_VARS) delete out[k];
  delete out[SEAT_MARKER_ENV];
  return out;
}

/** Pane/login-shell form of the same host-neutral worker env seal (herdr seed + daemon setup). A pane shell takes its
 * environment from its host, not the daemon's seal, so the inherited seat marker is unset here too (D-2174). */
export function herdrSealShellPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const forkCap = sealHerdrEnv(env)[FORK_CAP_ENV] ?? resolvedForkCap();
  return `export ${FORK_CAP_ENV}=${shq(forkCap)}; ` +
    HERDR_CONTROL_VARS.map((k) => `unset ${k}`).join("; ") + `; unset ${HOST_SESSION_VARS.join(" ")}; unset ${SEAT_MARKER_ENV}; `;
}

/** Queue row 108 (D-1622): ONE invocation's own stream state, written only by that invocation's process listeners. */
interface Invocation { closed: boolean; exitCode: number | null; signal: string | null }
interface SlotState { buf: string; receivedBytes: number; proc?: ChildProcess; identity?: Promise<string | null | undefined>; exited: boolean; invocation?: Invocation }

export class SubprocessDriver implements ExecutorDriver {
  id = "subprocess";
  interactive = false; // no pane, no operator — interactive workers force print here
  // OBS-17 T2: no `reconcile` — there are no panes/tabs to sweep; the daemon's optional-chain
  // call is a no-op here by construction, so the oracle suite runs byte-identical.
  private slots = new Map<string, SlotState>();
  private n = 0;
  private append?: Parameters<NonNullable<ExecutorDriver["journalWith"]>>[0];
  private readonly poster: NotificationPoster;
  private readonly platform: NodeJS.Platform;

  constructor(options: { poster?: NotificationPoster; platform?: NodeJS.Platform } = {}) {
    // Like the daemon's production wait switch, suppress only the default side effect in Vitest.
    // An injected synchronous poster always runs, including under Vitest on either host platform.
    this.poster = options.poster ?? (process.env.VITEST
      ? () => ({ status: 0, signal: null }) : spawnSync);
    this.platform = options.platform ?? process.platform;
  }

  journalWith(append: NonNullable<SubprocessDriver["append"]>): void { this.append = append; }

  postSync(post: NotificationPost): void {
    if (this.platform !== "darwin") return;
    try {
      const result = this.poster("osascript", [
        "-e", "on run argv",
        "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
        "-e", "end run", post.text, "tickmarkr",
      ], { timeout: 10_000, killSignal: "SIGKILL", stdio: "ignore" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`osascript exited ${result.status ?? result.signal ?? "unknown"}`);
    } catch (error) {
      try { this.append?.("os-notify-failed", undefined, { kind: post.kind, error: String(error) }); }
      catch { /* An observation failure must never stop the run either. */ }
    }
  }

  async slot(cwd: string, name: string): Promise<Slot> {
    const id = `sp-${++this.n}`;
    this.slots.set(id, { buf: "", receivedBytes: 0, exited: false });
    return { id, name, cwd };
  }

  private state(slot: Slot): SlotState {
    const s = this.slots.get(slot.id);
    if (!s) throw new Error(`unknown slot ${slot.id}`);
    return s;
  }

  async run(slot: Slot, cmd: string): Promise<void> {
    const s = this.state(slot);
    // HARD-05: interactive=false — no operator, so an open stdin pipe is a promise tickmarkr can never
    // keep; codex exec appends a piped stdin as a <stdin> block (`codex exec --help`) and blocks on a
    // read that never EOFs. One spawn site covers every adapter (D-06).
    // v1.22 T3 / OBS-843: seal host control vars so worker/judge/review/consult children cannot
    // address the operator's herdr or Orca UI. process.env of the daemon is untouched.
    const p = spawn("bash", ["-lc", cmd], {
      cwd: slot.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: sealHerdrEnv(process.env),
      detached: true,
    });
    s.proc = p;
    s.identity = p.pid === undefined ? Promise.resolve(undefined) : workerReapHost.identity(p.pid);
    // Queue row 233 (D-2130): count both received streams before retention truncates the tail.
    const receive = (d: Buffer) => {
      s.receivedBytes += d.length;
      s.buf = (s.buf + d).slice(-MAX_BUF);
    };
    p.stdout.on("data", receive);
    p.stderr.on("data", receive);
    p.on("close", () => (s.exited = true));
    p.on("error", (e) => { s.buf = (s.buf + `\n[tickmarkr subprocess error] ${e}\n`).slice(-MAX_BUF); s.exited = true; });
    // Queue row 108 (D-1622): THIS run's transport state. The slot's `exited` outlives an invocation (a reused slot) and
    // an 'error' sets it before stdio closes, so it is not the fact. This object is fresh per run and written only by
    // THIS process's listeners: a previous worker's late close lands on its own state, never on the current one. Only
    // stdio 'close' closes it — or a spawn that never started (no pid), which has nothing to drain.
    const invocation: Invocation = { closed: false, exitCode: null, signal: null };
    s.invocation = invocation;
    p.on("exit", (code, signal) => { invocation.exitCode = code; invocation.signal = signal; });
    p.on("close", () => { invocation.closed = true; });
    p.on("error", () => { if (p.pid === undefined) invocation.closed = true; });
  }

  async waitOutput(slot: Slot, pattern: string, timeoutMs: number, opts?: { regex?: boolean }): Promise<boolean> {
    const s = this.state(slot);
    const re = opts?.regex ? new RegExp(pattern) : null; // compile once, not per 200ms poll
    const hit = re ? (b: string) => re.test(b) : (b: string) => b.includes(pattern);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (hit(s.buf)) return true;
      await new Promise((r) => setTimeout(r, 200)); // ponytail: 200ms poll; herdr driver has real event waits
    }
    return hit(s.buf);
  }

  async waitAgentStatus(slot: Slot, status: string, timeoutMs: number): Promise<boolean> {
    if (status !== "done") return false; // subprocess knows only process-exit
    const s = this.state(slot);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (s.exited) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return s.exited;
  }

  async status(_slot: Slot): Promise<string> {
    return "unknown"; // no screen to scrape; never reports blocked
  }

  async transportState(slot: Slot): Promise<TransportState> {
    const s = this.state(slot);
    const run = s.invocation;
    return { closed: run?.closed ?? false, bytes: s.receivedBytes, exitCode: run?.exitCode ?? null, signal: run?.signal ?? null };
  }

  async read(slot: Slot, lines: number): Promise<string> {
    return this.state(slot).buf.split("\n").slice(-lines).join("\n");
  }

  async focus(): Promise<import("./types.js").FocusResult> {
    return { status: "unsupported", reason: "Subprocess workers have no visible pane; open task evidence with Enter" };
  }

  async notify(msg: string, _opts?: NotifyOpts): Promise<void> {
    if (_opts?.tier === "routine") return;
    console.log(`[tickmarkr] ${msg}`);
  }

  async close(slot: Slot): Promise<void> {
    const s = this.slots.get(slot.id);
    if (s?.proc && !s.exited) {
      const pid = s.proc.pid;
      const identity = await s.identity;
      if (pid !== undefined && identity && await workerReapHost.identity(pid) === identity) {
        try { workerReapHost.kill(-pid); }
        catch {
          // The group probe can fail slowly enough for the leader pid to be reused.
          if (await workerReapHost.identity(pid) === identity) {
            try { workerReapHost.kill(pid); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
        }
      }
    }
    this.slots.delete(slot.id);
  }

  worktree(repo: string, branch: string, baseRef: string): Promise<string> {
    return createWorktree(repo, branch, baseRef);
  }
}
