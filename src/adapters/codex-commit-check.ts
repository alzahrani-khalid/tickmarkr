import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { assertGitTrust, GitTrustRefusal, protectedGitEnv } from "../run/git-trust.js";
import { CODEX_GIT_GRANT, codex } from "./codex.js";
import { type AuthHealth, type CodexCommitStatus, shq, type WorkerAdapter } from "./types.js";

export type { CodexCommitStatus };

// v2.6.5 T3 (B) → v2.6.6 T9 (K, D-912): does the Codex launch grant let a sandboxed seat commit in a tickmarkr
// worktree — and nothing more? A linked worktree keeps its index under the MAIN repo's .git/worktrees/<name>.
// This probe runs `codex sandbox` — a local sandboxed shell, no model call, zero tokens — through `sh` at a
// throwaway linked worktree of the repo, carrying the EXACT worker grant bytes (CODEX_GIT_GRANT, expanded by
// that shell at that cwd; never a rebuilt twin). Inside it: an ordinary-file write (the positive control, so
// "the sandbox never ran" can never read as "protected"), a real commit on a unique fixture branch (common/refs
// and common/logs), and two unique NON-hook files — one in <common>/hooks, one in the common root — that the
// grant must deny. Never a real hook or the real config. The closed table:
//   allowed   — the branch commit landed (receipt, ref and reflog agree) and both hostile members were denied;
//   protected — the commit was denied, the control was readable and both hostile members were denied;
//   escape    — ANY hostile member holds this probe's token: a BLOCKING security warning for every Codex role;
//   unknown   — anything unreadable or contradictory (a foreign change to the probe branch included).
// Advisory for routing: the verdict rides doctor.json, doctor and plan name it; routing never reads it.
export interface CodexCommitProbe {
  worktree: string; commonDir: string; branch: string; control: string; lock: string;
  hostileHook: string; hostileRoot: string; token: string; signal?: AbortSignal;
}
/** Runs the probe script inside the Codex sandbox and resolves its stdout. Injected in tests. */
export type CodexSandbox = (probe: CodexCommitProbe) => Promise<string>;
export interface CodexCommitResult { status: CodexCommitStatus; detail: string }

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
// v2.6.7 T4: host git after the sandbox has had the fixture — validation and cleanup — runs the uncached trust
// check and the forced child config on every call, so seat-rewritten metadata can neither run a config program
// nor answer for the probe's commit.
const hostGit = async (cwd: string, ...args: string[]) => {
  assertGitTrust(cwd);
  return (await exec("git", args, { cwd, env: protectedGitEnv(process.env) })).stdout.trim();
};
/** The fixture checkout's trust after the sandbox returned or threw: a refusal is reported with its path. */
const fixtureRefusal = (worktree: string): CodexCommitResult | undefined => {
  try { assertGitTrust(worktree); return undefined; } catch (e) {
    return unknown(e instanceof GitTrustRefusal ? `the sandbox left untrusted fixture git metadata (${e.message})` : `fixture git trust unreadable (${String(e)})`);
  }
};
const CONTROL = "tickmarkr-codex-commit-control";

// $1 control, $2 token, $3 hostile hooks member, $4 hostile common-root member. The commit disables hooks (the
// probe asks what the sandbox permits, never what a user hook decides) and forces the reflog so common/logs is
// always exercised. noclobber (set -C) never writes over a foreign occupant of a hostile path.
const SCRIPT = `printf %s "$2" > "$1" && echo control=ok || echo control=fail
git add -- "$1" && git -c core.hooksPath=/dev/null -c core.logAllRefUpdates=true -c commit.gpgsign=false -c user.name=tickmarkr -c user.email=probe@tickmarkr.invalid commit -q -m "tickmarkr-probe $2" && echo commit=ok || echo commit=fail
(set -C; printf %s "$2" > "$3") 2>/dev/null && echo hook=written || echo hook=denied
(set -C; printf %s "$2" > "$4") 2>/dev/null && echo root=written || echo root=denied`;

/** The `sh` argv production runs at the fixture worktree: `codex sandbox` under the worker grant fragment. */
export const codexSandboxArgs = (p: CodexCommitProbe, grant = CODEX_GIT_GRANT): string[] => [
  "-c",
  `codex sandbox -c 'sandbox_mode="workspace-write"' ${grant} -- sh -c ${shq(SCRIPT)} sh ${[p.control, p.token, p.hostileHook, p.hostileRoot].map(shq).join(" ")}`,
];
/** A sandbox executing `grant`; production is CODEX_GIT_GRANT. Tests pass a mutant grant to prove discrimination. */
export const codexSandboxFor = (grant: string): CodexSandbox => async (p) =>
  (await exec("sh", codexSandboxArgs(p, grant), { cwd: p.worktree, timeout: 20_000, signal: p.signal })).stdout;
export const codexSandbox: CodexSandbox = codexSandboxFor(CODEX_GIT_GRANT);

const holds = (path: string, token: string): boolean => {
  try { return readFileSync(path, "utf8") === token; } catch { return false; }
};
const unknown = (detail: string): CodexCommitResult => ({ status: "unknown", detail });
// The bytes on disk decide an escape whatever the receipts say — and whether or not the sandbox exited cleanly.
const escaped = (hostile: string[], token: string): CodexCommitResult | undefined => {
  const written = hostile.filter((m) => holds(m, token));
  return written.length ? { status: "escape", detail: `the sandbox wrote ${written.join(" and ")} outside the worker grant` } : undefined;
};
// One outcome per receipt field: a field reporting two outcomes (commit=ok AND commit=fail) is contradictory.
const contradictory = (out: string): boolean => {
  const seen = new Map<string, string>();
  for (const [, field, outcome] of out.matchAll(/^(control|commit|hook|root)=(\S+)/gm)) {
    if ((seen.get(field!) ?? outcome) !== outcome) return true;
    seen.set(field!, outcome!);
  }
  return false;
};
const tipOf = async (repo: string, ref: string): Promise<string | undefined> =>
  hostGit(repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).catch(() => undefined);
// This probe's commit and nothing else: one parent (the fixture base), its token in the subject and the control.
const isProbeCommit = async (repo: string, commit: string, base: string, token: string): Promise<boolean> => {
  try {
    return await hostGit(repo, "log", "-1", "--format=%P %s", commit) === `${base} tickmarkr-probe ${token}`
      && await hostGit(repo, "cat-file", "blob", `${commit}:${CONTROL}`) === token;
  } catch { return false; }
};

export async function probeCodexCommit(repoRoot: string, sandbox: CodexSandbox = codexSandbox, signal?: AbortSignal): Promise<CodexCommitResult> {
  const token = randomUUID();
  const parent = mkdtempSync(join(tmpdir(), "tickmarkr-codex-commit-"));
  // git names the fixture's metadata directory after the checkout's basename; a unique one makes that
  // directory — and so the lock path — known BEFORE `worktree add`, which can fail after creating it
  const branch = `tickmarkr-probe-${token}`;
  const ref = `refs/heads/${branch}`;
  const worktree = join(parent, branch);
  let lock: string | undefined;
  let base: string | undefined;
  let hostile: string[] = [];
  let sandboxed = false;
  try {
    const commonDir = await git(repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
    lock = join(commonDir, "worktrees", basename(worktree), "index.lock");
    const hostileHook = join(commonDir, "hooks", branch), hostileRoot = join(commonDir, branch);
    hostile = [hostileHook, hostileRoot];
    if (hostile.some((m) => existsSync(m))) return unknown("a foreign file already holds a hostile probe path");
    base = await git(repoRoot, "rev-parse", "--verify", "HEAD^{commit}");
    await git(repoRoot, "worktree", "add", "-b", branch, worktree, base);
    if (join(await git(worktree, "rev-parse", "--absolute-git-dir"), "index.lock") !== lock) return unknown("the fixture worktree metadata is not where git was expected to put it");
    const control = join(worktree, CONTROL);
    if (existsSync(lock)) return unknown("a foreign index.lock already holds the fixture worktree");
    sandboxed = true;
    const out = await sandbox({ worktree, commonDir, branch, control, lock, hostileHook, hostileRoot, token, signal });
    // An escape on disk dominates; every other verdict needs consistent receipts AND disk — and trusted metadata.
    const escape = escaped(hostile, token);
    if (escape) return escape;
    const refused = fixtureRefusal(worktree);
    if (refused) return refused;
    if (contradictory(out)) return unknown("the sandbox receipts contradict each other");
    if (!/^control=ok$/m.test(out) || !holds(control, token)) return unknown("the sandbox did not write the ordinary control file");
    if (!/^hook=denied$/m.test(out) || !/^root=denied$/m.test(out) || hostile.some((m) => existsSync(m))) {
      return unknown("the sandbox result for the shared-metadata members was unreadable");
    }
    const tip = await tipOf(repoRoot, ref);
    if (/^commit=ok$/m.test(out) && tip && tip !== base && await isProbeCommit(repoRoot, tip, base, token)) {
      let reflog = "";
      try { reflog = readFileSync(join(commonDir, "logs", ref), "utf8"); } catch { /* absent: unknown below */ }
      if (reflog.trimEnd().split("\n").pop()?.startsWith(`${base} ${tip} `)) {
        return { status: "allowed", detail: "the sandbox committed on its fixture branch and was denied both shared-metadata members" };
      }
      return unknown("the fixture branch moved but its reflog does not record the probe commit");
    }
    if (/^commit=fail$/m.test(out) && tip === base) {
      return { status: "protected", detail: "the sandbox wrote an ordinary worktree file but denied the linked-worktree commit" };
    }
    return unknown("the fixture branch does not match the sandbox commit report (a foreign change may have moved it)");
  } catch (e) {
    // a sandbox that wrote a hostile member and then failed (or was cancelled) still escaped: inspect before cleanup
    const escape = escaped(hostile, token);
    if (escape) return escape;
    const refused = sandboxed ? fixtureRefusal(worktree) : undefined;
    if (refused) return refused;
    return unknown(signal?.aborted ? "probe cancelled" : `probe did not run (${(e instanceof Error ? e.message : String(e)).split("\n")[0]})`);
  } finally {
    // only files holding this probe's token are ours to remove; a foreign occupant is never touched
    for (const m of hostile) if (holds(m, token)) rmSync(m, { force: true });
    if (lock && holds(lock, token)) rmSync(lock, { force: true });
    // a foreign lock lives in the fixture's metadata directory, which `worktree remove` would delete with
    // it: drop only the checkout and leave that metadata to the lock's owner. Never a repository-wide
    // prune — that would take an earlier probe's preserved foreign lock (or anyone's prunable worktree).
    const foreign = lock !== undefined && existsSync(lock);
    if (lock && !foreign) {
      await hostGit(repoRoot, "worktree", "remove", "--force", worktree).catch(() => undefined);
      // a failed `worktree add` leaves metadata git no longer removes by path: drop this probe's own directory
      rmSync(dirname(lock), { recursive: true, force: true });
      try { rmdirSync(dirname(dirname(lock))); } catch { /* other worktrees live there */ }
    }
    // The fixture branch and its reflog go only while the tip is still this probe's (the base or its own
    // commit), and update-ref's old-value check refuses if anyone moves it between this read and the delete.
    // Metadata preserved for a foreign lock keeps its branch too: that checkout's HEAD still names it.
    const tip = base === undefined || foreign ? undefined : await tipOf(repoRoot, ref);
    if (tip && base && (tip === base || await isProbeCommit(repoRoot, tip, base, token))) {
      await hostGit(repoRoot, "update-ref", "-d", ref, tip).catch(() => undefined);
    }
    rmSync(parent, { recursive: true, force: true });
  }
}

const NOTE: Record<CodexCommitStatus, string> = {
  protected: "linked-worktree git metadata protected",
  allowed: "linked-worktree commit probe: commit allowed, shared hooks/config denied",
  escape: "BLOCKING security warning: codex sandbox escape into shared git metadata",
  unknown: "linked-worktree commit probe unknown",
};
const CONSEQUENCE: Record<CodexCommitStatus, string> = {
  protected: "; a Codex worker cannot commit in its worktree",
  allowed: "",
  escape: "; every Codex worker (headless and interactive) launches with this grant, while judge, review and consult seats launch grantless — stop Codex seats and inspect .git/hooks and git config --list --show-origin (core.hooksPath, core.fsmonitor, filter.*, diff.external)",
  unknown: "",
};
const STATUSES = new Set<string>(Object.keys(NOTE));
/** A persisted verdict outside the closed table (an older or newer doctor.json) reads unknown, never allowed. */
export const codexCommitStatus = (health: Record<string, AuthHealth>): CodexCommitStatus => {
  const s = health[codex.id]?.codexCommit;
  return s !== undefined && STATUSES.has(s) ? s : "unknown";
};

/** Doctor's one call: gated on the REAL codex adapter object (a codex-id stub gets no probe and no output
 *  unless a test injects a sandbox — the kimiTurnEnabled rule). Mutates only the health record doctor owns. */
export async function recordCodexCommit(adapters: WorkerAdapter[], health: Record<string, AuthHealth>, cwd: string, sandbox?: CodexSandbox): Promise<void> {
  const adapter = adapters.find((a) => a.id === codex.id);
  const h = health[codex.id];
  if (!adapter || (adapter !== codex && !sandbox) || !h?.installed) return;
  const r = await probeCodexCommit(cwd, sandbox);
  const say = `${NOTE[r.status]} — ${r.detail}${CONSEQUENCE[r.status]}`;
  health[codex.id] = { ...h, codexCommit: r.status, note: `${h.note ? `${h.note}; ` : ""}${say}` };
}

const ESCAPE_ACTION = "stop Codex seats and inspect .git/hooks and git config --list --show-origin (core.hooksPath, core.fsmonitor, filter.*, diff.external) before dispatch";

/** Plan's headline beneath a Codex worker row; null for every other worker and for an allowed probe.
 *  An absent field is unknown, but only the real adapter earns the line — stubs stay byte-identical. */
export function codexCommitHeadline(worker: string, adapters: WorkerAdapter[], health: Record<string, AuthHealth>): string | null {
  if (worker !== codex.id || !adapters.includes(codex)) return null;
  const status = codexCommitStatus(health);
  if (status === "escape") {
    return `    BLOCKING security warning: codex sandbox escape (doctor probe) — this worker's launch grant let the sandbox write shared git metadata; ${ESCAPE_ACTION}`;
  }
  if (status === "protected") {
    return "    worker restriction: codex linked-worktree git metadata is protected (doctor probe) — this worker cannot commit its own work; routing consequence: steer this task to an eligible non-Codex worker";
  }
  return status === "unknown"
    ? "    worker restriction: unknown — the codex linked-worktree commit probe has no verdict; run tickmarkr doctor"
    : null;
}

/** Plan's one line for Codex's NON-worker roles (judge, review, consult). v2.6.7 T4: those seats launch
 *  grantless, but they run in the same repository whose shared metadata a Codex worker's grant let the sandbox
 *  write — so an escape still blocks; allowed, protected and unknown concern commits, which they never make. */
export function codexEscapeRoleLine(roles: string[], adapters: WorkerAdapter[], health: Record<string, AuthHealth>): string | null {
  if (!roles.length || !adapters.includes(codex) || codexCommitStatus(health) !== "escape") return null;
  return `BLOCKING security warning: codex sandbox escape (doctor probe) — Codex ${roles.join("/")} seats launch grantless, but the Codex worker grant let the sandbox write shared git metadata they run against; ${ESCAPE_ACTION}`;
}
