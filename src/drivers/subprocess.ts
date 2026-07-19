import { type ChildProcess, spawn } from "node:child_process";
import { createWorktree } from "../run/git.js";
import type { ExecutorDriver, NotifyOpts, Slot } from "./types.js";

// HARD-03: cap retained worker output so a chatty worker can't grow tickmarkr's heap unbounded.
// 2MB is safe against BOTH consumers: the largest read() call site asks for 1000 lines
// (daemon.ts:217/247), and every marker (TICKMARKR_RESULT, TICKMARKR_EXIT_<nonce>) is emitted at the
// END of output — a trailer would only be evicted if >2MB arrived AFTER it inside one 200ms
// waitOutput poll (~10MB/s sustained, far beyond agent-CLI rates). Tail-truncate, never head:
// consumers only ever tail-read.
export const MAX_BUF = 2 * 1024 * 1024;

// OBS-17 / v1.22 T3: control-plane vars that let a process talk to the operator's herdr.
// Workers, judges, reviewers, and consults must never inherit them — only the daemon process
// (and its own herdr driver CLI calls) keep the live session. Socket path is the wire; HERDR_ENV
// is the "I am inside herdr" gate every agent skill checks before mutating panes.
export const HERDR_CONTROL_VARS = ["HERDR_ENV", "HERDR_SOCKET_PATH"] as const;

/** Copy of env with herdr control-plane vars stripped. Daemon process.env is left alone. */
export function sealHerdrEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of HERDR_CONTROL_VARS) delete out[k];
  return out;
}

/** Shell prefix that unsets herdr control vars in a pane/login shell (herdr seed + daemon setup). */
export function herdrSealShellPrefix(): string {
  return HERDR_CONTROL_VARS.map((k) => `unset ${k}`).join("; ") + "; ";
}

interface SlotState { buf: string; proc?: ChildProcess; exited: boolean }

export class SubprocessDriver implements ExecutorDriver {
  id = "subprocess";
  interactive = false; // no pane, no operator — interactive workers force print here
  // OBS-17 T2: no `reconcile` — there are no panes/tabs to sweep; the daemon's optional-chain
  // call is a no-op here by construction, so the oracle suite runs byte-identical.
  private slots = new Map<string, SlotState>();
  private n = 0;

  async slot(cwd: string, name: string): Promise<Slot> {
    const id = `sp-${++this.n}`;
    this.slots.set(id, { buf: "", exited: false });
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
    // v1.22 T3: seal herdr control vars so worker/judge/review/consult children cannot reach the
    // operator's herdr (OBS-17 watch-tab leak class). process.env of the daemon is untouched.
    const p = spawn("bash", ["-lc", cmd], {
      cwd: slot.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: sealHerdrEnv(process.env),
      detached: true,
    });
    s.proc = p;
    p.stdout.on("data", (d) => (s.buf = (s.buf + d).slice(-MAX_BUF)));
    p.stderr.on("data", (d) => (s.buf = (s.buf + d).slice(-MAX_BUF)));
    p.on("close", () => (s.exited = true));
    p.on("error", (e) => { s.buf = (s.buf + `\n[tickmarkr subprocess error] ${e}\n`).slice(-MAX_BUF); s.exited = true; });
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

  async read(slot: Slot, lines: number): Promise<string> {
    return this.state(slot).buf.split("\n").slice(-lines).join("\n");
  }

  async notify(msg: string, _opts?: NotifyOpts): Promise<void> {
    if (_opts?.tier === "routine") return;
    console.log(`[tickmarkr] ${msg}`);
  }

  async close(slot: Slot): Promise<void> {
    const s = this.slots.get(slot.id);
    if (s?.proc && !s.exited) {
      try { process.kill(-s.proc.pid!, "SIGKILL"); } catch { s.proc.kill("SIGKILL"); }
    }
    this.slots.delete(slot.id);
  }

  worktree(repo: string, branch: string, baseRef: string): Promise<string> {
    return createWorktree(repo, branch, baseRef);
  }
}
