import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { codex } from "./codex.js";
import type { AuthHealth, WorkerAdapter } from "./types.js";

// v2.6.5 T3 (B): can a Codex worker commit in a tickmarkr worktree? A linked worktree keeps its index under
// the MAIN repo's .git/worktrees/<name>. The worker launch grants the git common dir as a writable root, yet
// the installed sandbox (codex-cli 0.159.2, probed 2026-10-01) still denies index.lock there while ordinary
// worktree files write fine. This probe replays that launch grant under `codex sandbox` — a local sandboxed
// shell, no model call, zero tokens — against a throwaway linked worktree of the repo, with an ordinary-file
// write as the positive control so "the sandbox never ran" can never read as "protected".
// Advisory: the verdict rides doctor.json and plan names it; routing never reads it.
export type CodexCommitStatus = "protected" | "allowed" | "unknown";
export interface CodexCommitProbe { worktree: string; commonDir: string; control: string; lock: string; token: string; signal?: AbortSignal }
/** Runs the write script inside the Codex sandbox and resolves its stdout. Injected in tests. */
export type CodexSandbox = (probe: CodexCommitProbe) => Promise<string>;
export interface CodexCommitResult { status: CodexCommitStatus; detail: string }

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

// $1 control, $2 lock, $3 token. noclobber (set -C) creates the lock the way git does — never over an existing one.
const SCRIPT = `printf %s "$3" > "$1" && echo control=ok || echo control=fail
e=$( (set -C; printf %s "$3" > "$2") 2>&1 ) && echo lock=ok || echo "lock=fail $e"`;

// The grant names the git common dir (the worker launch grant) AND the exact linked metadata directory that
// holds index.lock, so a denial is protection despite an exact grant — never a grant this probe forgot.
export const codexSandboxArgs = (p: CodexCommitProbe): string[] => [
  "sandbox", "-c", 'sandbox_mode="workspace-write"',
  "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([p.commonDir, dirname(p.lock)])}`,
  "--", "sh", "-c", SCRIPT, "sh", p.control, p.lock, p.token,
];
export const codexSandbox: CodexSandbox = async (p) =>
  (await exec("codex", codexSandboxArgs(p), { cwd: p.worktree, timeout: 20_000, signal: p.signal })).stdout;

const holds = (path: string, token: string): boolean => {
  try { return readFileSync(path, "utf8") === token; } catch { return false; }
};
const unknown = (detail: string): CodexCommitResult => ({ status: "unknown", detail });

export async function probeCodexCommit(repoRoot: string, sandbox: CodexSandbox = codexSandbox, signal?: AbortSignal): Promise<CodexCommitResult> {
  const token = randomUUID();
  const parent = mkdtempSync(join(tmpdir(), "tickmarkr-codex-commit-"));
  // git names the fixture's metadata directory after the checkout's basename; a unique one makes that
  // directory — and so the lock path — known BEFORE `worktree add`, which can fail after creating it
  const worktree = join(parent, `tickmarkr-probe-${token}`);
  let lock: string | undefined;
  try {
    const commonDir = await git(repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
    lock = join(commonDir, "worktrees", basename(worktree), "index.lock");
    await git(repoRoot, "worktree", "add", "--detach", worktree, "HEAD");
    if (join(await git(worktree, "rev-parse", "--absolute-git-dir"), "index.lock") !== lock) return unknown("the fixture worktree metadata is not where git was expected to put it");
    const control = join(worktree, "tickmarkr-codex-commit-control");
    if (existsSync(lock)) return unknown("a foreign index.lock already holds the fixture worktree");
    const out = await sandbox({ worktree, commonDir, control, lock, token, signal });
    // Every verdict needs the sandbox's own report AND the bytes on disk to agree; anything else is unknown.
    if (!/^control=ok$/m.test(out) || !holds(control, token)) return unknown("the sandbox did not write the ordinary control file");
    if (/^lock=ok$/m.test(out) && holds(lock, token)) return { status: "allowed", detail: "the sandbox wrote index.lock" };
    if (/^lock=fail .*(not permitted|permission denied)/mi.test(out) && !existsSync(lock)) {
      return { status: "protected", detail: "the sandbox wrote an ordinary worktree file but denied index.lock" };
    }
    return unknown("the sandbox result for index.lock was unreadable");
  } catch (e) {
    return unknown(signal?.aborted ? "probe cancelled" : `probe did not run (${(e instanceof Error ? e.message : String(e)).split("\n")[0]})`);
  } finally {
    // only the lock this probe wrote (its token) is ours to remove; a foreign one is never touched
    if (lock && holds(lock, token)) rmSync(lock, { force: true });
    // a foreign lock lives in the fixture's metadata directory, which `worktree remove` would delete with
    // it: drop only the checkout and leave that metadata to the lock's owner. Never a repository-wide
    // prune — that would take an earlier probe's preserved foreign lock (or anyone's prunable worktree).
    const foreign = lock !== undefined && existsSync(lock);
    if (lock && !foreign) {
      await git(repoRoot, "worktree", "remove", "--force", worktree).catch(() => undefined);
      // a failed `worktree add` leaves metadata git no longer removes by path: drop this probe's own directory
      rmSync(dirname(lock), { recursive: true, force: true });
      try { rmdirSync(dirname(dirname(lock))); } catch { /* other worktrees live there */ }
    }
    rmSync(parent, { recursive: true, force: true });
  }
}

const NOTE: Record<CodexCommitStatus, string> = {
  protected: "linked-worktree git metadata protected",
  allowed: "linked-worktree commit probe: index.lock writable",
  unknown: "linked-worktree commit probe unknown",
};

/** Doctor's one call: gated on the REAL codex adapter object (a codex-id stub gets no probe and no output
 *  unless a test injects a sandbox — the kimiTurnEnabled rule). Mutates only the health record doctor owns. */
export async function recordCodexCommit(adapters: WorkerAdapter[], health: Record<string, AuthHealth>, cwd: string, sandbox?: CodexSandbox): Promise<void> {
  const adapter = adapters.find((a) => a.id === codex.id);
  const h = health[codex.id];
  if (!adapter || (adapter !== codex && !sandbox) || !h?.installed) return;
  const r = await probeCodexCommit(cwd, sandbox);
  const say = `${NOTE[r.status]} — ${r.detail}${r.status === "protected" ? "; a Codex worker cannot commit in its worktree" : ""}`;
  health[codex.id] = { ...h, codexCommit: r.status, note: `${h.note ? `${h.note}; ` : ""}${say}` };
}

/** Plan's headline beneath a Codex worker row; null for every other worker and for an allowed probe.
 *  An absent field is unknown, but only the real adapter earns the line — stubs stay byte-identical. */
export function codexCommitHeadline(worker: string, adapters: WorkerAdapter[], health: Record<string, AuthHealth>): string | null {
  if (worker !== codex.id || !adapters.includes(codex)) return null;
  const status = health[codex.id]?.codexCommit ?? "unknown";
  if (status === "protected") {
    return "    worker restriction: codex linked-worktree git metadata is protected (doctor probe) — this worker cannot commit its own work; routing consequence: steer this task to an eligible non-Codex worker";
  }
  return status === "unknown"
    ? "    worker restriction: unknown — the codex linked-worktree commit probe has no verdict; run tickmarkr doctor"
    : null;
}
