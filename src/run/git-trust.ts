import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// v2.6.7 T4 (GHSA-2): a seat-run linked worktree's gitdir is seat-writable (the Codex worker grant), so its
// `commondir` and `config.worktree` can redirect every later unsandboxed host git in that checkout to a
// hostile common directory or config program. Authority is derived afresh on every call from the seat-denied
// worktree gitfile and the trusted ordinary common directory's own bytes — never persisted enrollment, never
// the mutable commondir/config.worktree, never ambient GIT_DIR/GIT_COMMON_DIR. No verdict is cached: a check
// passed once proves nothing about the next spawn. This module must not import git.ts, lease.ts or journal.ts.

/** A covered git invocation refused before spawn; `path` names the offending metadata. */
export class GitTrustRefusal extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`git trust refusal: ${path}: ${detail}`);
    this.name = "GitTrustRefusal";
    this.path = path;
  }
}

/** The nearest `.git` entry at or above cwd, or undefined outside any checkout. */
const dotGitOf = (cwd: string): string | undefined => {
  let dir: string;
  try { dir = realpathSync.native(cwd); } catch { return undefined; }
  for (;;) {
    const candidate = join(dir, ".git");
    try { lstatSync(candidate); return candidate; } catch { /* keep walking */ }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
};

const present = (path: string): boolean => {
  try { lstatSync(path); return true; } catch { return false; }
};

/**
 * A path exactly as git reads it from a gitfile or commondir (setup.c read_gitfile_gently /
 * get_common_dir_noenv): raw bytes with ONLY trailing CR/LF stripped — never trimmed, so a leading or trailing
 * space stays a path component git follows — relative to `base` unless it starts with "/", then a PHYSICAL
 * realpath (symlinks resolved before `..`, as git's strbuf_realpath and realpath(3) do; fs.realpathSync
 * normalizes `..` lexically first). Throws when the path does not resolve.
 */
const resolveAsGit = (base: string, bytes: Buffer): Buffer => {
  let end = bytes.length;
  while (end && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end--;
  const named = bytes.subarray(0, end);
  return realpathSync.native(named[0] === 0x2f ? named : Buffer.concat([Buffer.from(`${base}/`), named]), { encoding: "buffer" });
};

interface Authority { gitdir: string; common: string; linked: boolean }

function authorityOf(dotGit: string): Authority {
  let directory: boolean;
  try { directory = statSync(dotGit).isDirectory(); } catch (e) { throw new GitTrustRefusal(dotGit, `unreadable checkout metadata (${String(e)})`); }
  if (directory) {
    const gitdir = realpathSync.native(dotGit);
    return { gitdir, common: gitdir, linked: false };
  }
  // git accepts a gitfile only when its first bytes are exactly "gitdir: " and the rest names the path
  let named: Buffer | undefined;
  try {
    const bytes = readFileSync(dotGit);
    if (bytes.subarray(0, 8).toString("latin1") === "gitdir: ") named = bytes.subarray(8);
  } catch { /* refused below */ }
  if (!named || !/[^\r\n]/.test(named.toString("latin1"))) throw new GitTrustRefusal(dotGit, "not a readable gitfile");
  let gitdir: string;
  try { gitdir = resolveAsGit(dirname(dotGit), named).toString(); } catch { throw new GitTrustRefusal(dotGit, `names a missing gitdir ${named.toString().trimEnd()}`); }
  // Supported linked layout: <common>/worktrees/<name>, where <common> is itself an ordinary git directory.
  // The layout decides, never commondir's presence: a seat can delete its own commondir (and plant standalone
  // repository metadata beside it), which must not turn its writable gitdir into its own trusted common dir.
  const common = basename(dirname(gitdir)) === "worktrees" ? dirname(dirname(gitdir)) : undefined;
  if (common !== undefined && present(join(common, "HEAD")) && !present(join(common, "commondir"))) return { gitdir, common, linked: true };
  // Outside that layout, a gitdir without commondir is an ordinary separate git directory (submodule, --separate-git-dir).
  if (!present(join(gitdir, "commondir"))) return { gitdir, common: gitdir, linked: false };
  if (common === undefined) throw new GitTrustRefusal(dotGit, `names ${gitdir}, outside a supported <common>/worktrees/<name> layout`);
  throw new GitTrustRefusal(common, "the linked worktree's common directory is not an ordinary git directory");
}

/**
 * The canonical, independently expected common git directory for the checkout enclosing `cwd` — never what
 * a mutable commondir says. Throws GitTrustRefusal naming the authority path when it cannot be established.
 */
export function trustedCommonDir(cwd: string): string {
  const dotGit = dotGitOf(cwd);
  if (!dotGit) throw new GitTrustRefusal(cwd, "no checkout encloses this directory");
  return authorityOf(dotGit).common;
}

/** Read failures and unparseable values never become clean authority. */
function worktreeConfigEnabled(common: string): boolean {
  const config = join(common, "config");
  if (!present(config)) throw new GitTrustRefusal(config, "the trusted common config is missing");
  try {
    return execFileSync("git", ["config", "--file", config, "--type=bool", "--get", "extensions.worktreeConfig"], {
      cwd: "/", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    }).trim() === "true";
  } catch (error) {
    const e = error as { status?: number | null; stderr?: string };
    if (e.status === 1 && !e.stderr?.trim()) return false; // the key is absent
    throw new GitTrustRefusal(config, `cannot read extensions.worktreeConfig (${(e.stderr ?? String(error)).trim().split("\n")[0]})`);
  }
}

/**
 * The uncached pre-spawn check for a covered git invocation at `cwd`. Outside any checkout it is a no-op
 * (unrelated shell commands stay compatible). Inside one it refuses, naming the file, when the commondir git
 * would follow resolves anywhere but the expected common directory, or when the trusted common config enables
 * extensions.worktreeConfig and the linked gitdir holds a config.worktree.
 */
export function assertGitTrust(cwd: string): void {
  const dotGit = dotGitOf(cwd);
  if (!dotGit) return;
  const { gitdir, common, linked } = authorityOf(dotGit);
  const commondir = join(gitdir, "commondir");
  if (linked && !present(commondir)) throw new GitTrustRefusal(commondir, `is missing, so git would treat the seat-writable gitdir as its own repository; expected ${common}`);
  if (present(commondir)) {
    // read as git reads it (resolveAsGit), never trimmed or lexically normalized: either would let a seat-written
    // path that names the real common directory to us lead git somewhere else
    let actual: Buffer;
    try { actual = resolveAsGit(gitdir, readFileSync(commondir)); } catch {
      throw new GitTrustRefusal(commondir, `names no readable directory; expected ${common}`);
    }
    if (!actual.equals(Buffer.from(common))) throw new GitTrustRefusal(commondir, `resolves to ${actual.toString()}, not the expected common directory ${common}`);
  }
  const worktreeConfig = join(gitdir, "config.worktree");
  if (linked && present(worktreeConfig) && worktreeConfigEnabled(common)) {
    throw new GitTrustRefusal(worktreeConfig, `extensions.worktreeConfig is enabled in ${join(common, "config")}, so git would read this seat-writable file`);
  }
}

/** The inert hooks directory every protected git child receives (no hook can exist beneath it). */
export const INERT_HOOKS_PATH = "/dev/null";
const FORCED_GIT_CONFIG = `'core.fsmonitor=false' 'core.hooksPath=${INERT_HOOKS_PATH}'`;

/**
 * A copy of `env` whose git children run with core.fsmonitor=false and an inert core.hooksPath, despite repo
 * config and inherited GIT_CONFIG_COUNT/GIT_CONFIG_PARAMETERS: git applies GIT_CONFIG_PARAMETERS after
 * GIT_CONFIG_COUNT and the last value wins, so the forced pair is appended last. Every other value survives.
 * Named keys only — this does not neutralize arbitrary executable drivers. The pair is inherited by every
 * descendant of the protected child (a suite that needs real hooks must clear it for its own git).
 */
export function protectedGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const prior = env.GIT_CONFIG_PARAMETERS?.trim();
  return { ...env, GIT_CONFIG_PARAMETERS: prior ? `${prior} ${FORCED_GIT_CONFIG}` : FORCED_GIT_CONFIG };
}
