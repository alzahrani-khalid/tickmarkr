import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  readonly detail: string;
  constructor(path: string, detail: string, options?: ErrorOptions) {
    super(`git trust refusal: ${path}: ${detail}`, options);
    this.name = "GitTrustRefusal";
    this.path = path;
    this.detail = detail;
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

/** One key of the trusted common config. Read failures and unparseable values never become clean authority. */
function trustedConfig(common: string, key: string, type?: "bool"): string | undefined {
  const config = join(common, "config");
  if (!present(config)) throw new GitTrustRefusal(config, "the trusted common config is missing");
  try {
    return execFileSync("git", ["config", "--file", config, ...(type ? [`--type=${type}`] : []), "--get", key], {
      cwd: "/", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    }).trim();
  } catch (error) {
    const e = error as { status?: number | null; stderr?: string };
    if (e.status === 1 && !e.stderr?.trim()) return undefined; // the key is absent
    throw new GitTrustRefusal(config, `cannot read ${key} (${(e.stderr ?? String(error)).trim().split("\n")[0]})`);
  }
}

const worktreeConfigEnabled = (common: string): boolean => trustedConfig(common, "extensions.worktreeConfig", "bool") === "true";

/** commondir's identity: ctime moves on every write, rename, unlink/recreate or restore, and no caller can set it. */
const stampOf = (path: string): string | undefined => {
  try { const s = lstatSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.ctimeNs}`; } catch { return undefined; }
};

const isSymlink = (path: string): boolean => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };

/** The checked authority for `cwd` (see assertGitTrust), with the canonical worktree root the gitfile sits in. */
function checkedAuthority(cwd: string): (Authority & { worktree: string; stamp?: string }) | undefined {
  const dotGit = dotGitOf(cwd);
  if (!dotGit) return undefined;
  const { gitdir, common, linked } = authorityOf(dotGit);
  const commondir = join(gitdir, "commondir");
  // stamped BEFORE its bytes are read, so any change after this read moves the stamp
  const stamp = linked ? stampOf(commondir) : undefined;
  if (linked && !present(commondir)) throw new GitTrustRefusal(commondir, `is missing, so git would treat the seat-writable gitdir as its own repository; expected ${common}`);
  // git writes commondir as a regular file; through a symlink the bytes git reads could be rewritten and restored
  // without moving the link's own stamp, so that layout is refused rather than trusted
  if (linked && isSymlink(commondir)) throw new GitTrustRefusal(commondir, "is a symbolic link, so its target could change without moving its stamp");
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
  return { gitdir, common, linked, worktree: dirname(dotGit), stamp };
}

/**
 * The uncached pre-spawn check for a covered git invocation at `cwd`. Outside any checkout it is a no-op
 * (unrelated shell commands stay compatible). Inside one it refuses, naming the file, when the commondir git
 * would follow resolves anywhere but the expected common directory, or when the trusted common config enables
 * extensions.worktreeConfig and the linked gitdir holds a config.worktree.
 */
export function assertGitTrust(cwd: string): void {
  checkedAuthority(cwd);
}

/** The child of tickmarkr's own git in a linked checkout: its pinned environment, the post-exit recheck and its release. */
export interface OwnGitPin {
  /** The whole child environment: the caller's, with the pin set and every unpinned inherited ref backend removed. */
  env: NodeJS.ProcessEnv;
  /** Throws GitTrustRefusal naming commondir when it changed in ANY way since the check that derived `env`. */
  recheck: () => void;
  /** Removes this attempt's private ref view; called once its child has exited, or when it never spawned. */
  release: () => void;
  /** git names ref paths through the view; its output names the trusted common directory instead. */
  unview: (text: string) => string;
  /** The trusted common directory this attempt derived from the layout: the authority a raced worktree add rolls back through. */
  store: string;
}

/**
 * v2.6.8 T2: what an own-git CALLER declares at its call site — never read from the command text, its tokens, login or
 * cwd, and never a way out of any pin: every own-git child keeps the path pin, the ref-store pin and the recheck.
 * `createsWorktree: "branch"` is declared by the three branch-creating adds (git writes a branch add's new HEAD as the
 * symbolic branch ref, which the pin leaves intact). The two DETACHED adds declare the capability by calling
 * `addDetachedWorktree` (src/run/git.ts), because under the pin git stubs a detached add's new HEAD as
 * `ref: refs/heads/.invalid`.
 */
export interface OwnGitCapability { createsWorktree?: "branch"; rollback?: WorktreeRollback }
/**
 * What a worktree-creating call site declares it creates, so a result refused AFTER its child ran (a commondir raced
 * mid-child) is rolled back: the checkout `dir` and its registration, and — when the add creates or moves one — the
 * branch (`prior` restores a moved branch; without it the new branch is deleted). The rollback runs through the
 * attempt's own trusted common directory (TrustedStoreCapability), never the caller's checkout, so it completes while
 * the caller's commondir stays hostile.
 */
export interface WorktreeRollback { dir: string; branch?: { name: string; prior?: string } }
/**
 * Internal to addDetachedWorktree's add step: its ref store is pinned to the trusted common directory itself, not to a
 * view. git stubs the new checkout's HEAD under ANY ref payload and, through a view, would resolve that stub into a
 * shared `refs/heads/.invalid`; naming the common directory keeps it in the new gitdir, where the next step replaces
 * it. That step writes no ref of the CALLER's checkout, so a commondir removed under it has no HEAD to redirect.
 */
export interface DetachedAddCapability { createsWorktree: "detached"; rollback: WorktreeRollback }
/**
 * v2.6.8 T2: cleanup authority. The child reads and writes ONLY `store` — a trusted common directory derived once from
 * the trusted layout (gitfile and `<common>/worktrees/<name>`, never a mutable commondir) — as an ordinary repository:
 * GIT_DIR names it and every inherited redirect (common dir, work tree, ref backend, index, objects) is removed. It never
 * consults the caller's checkout, so removal completes even while that checkout's commondir stays hostile.
 */
export interface TrustedStoreCapability { store: string }

function storePin(store: string, env: NodeJS.ProcessEnv): OwnGitPin {
  if (!present(join(store, "HEAD")) || present(join(store, "commondir"))) throw new GitTrustRefusal(store, "is not an ordinary git directory");
  const child: NodeJS.ProcessEnv = { ...env, GIT_DIR: store };
  for (const k of ["GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_REFERENCE_BACKEND", "GIT_REF_STORAGE_FORMAT", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete child[k];
  return { env: child, store, recheck: () => {}, release: () => {}, unview: (text) => text };
}

/**
 * v2.6.8 T2: the ref store an own-git child in a linked checkout is pinned to — a private directory of this attempt
 * whose `refs`, `packed-refs`, `logs`, `worktrees` and `HEAD` are links into the TRUSTED common directory, beside a
 * `HEAD.lock` nothing removes. git decides "linked" from the gitdir's commondir FILE alone: while it is present the
 * child reads this checkout's own HEAD from <view>/worktrees/<id> (its trusted gitdir) and shared refs from the trusted
 * store; when a seat REMOVES it before the child starts, git treats the view as the repository, so no HEAD-relative
 * write (commit, merge, cherry-pick, reset, checkout, update-ref HEAD) can take the view's HEAD lock and nothing lands
 * on the main checkout's branch — the recheck then refuses the result. That lock also refuses a write of the MAIN
 * worktree's HEAD from a linked checkout's own git. Only the files format can be viewed this way: any other
 * `extensions.refStorage` is refused by name, never run unpinned.
 */
function refStoreView(common: string): { uri: string; release: () => void; unview: (text: string) => string } {
  const view = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-refs-")));
  const release = () => rmSync(view, { recursive: true, force: true }); // unlinks the links, never their targets
  try {
    for (const name of ["refs", "packed-refs", "logs", "worktrees", "HEAD"]) symlinkSync(join(common, name), join(view, name));
    writeFileSync(join(view, "HEAD.lock"), "");
  } catch (error) { release(); throw error; }
  return { uri: `files://${view}`, release, unview: (text) => text.split(view).join(common) };
}

function assertFilesRefStore(common: string): void {
  const format = trustedConfig(common, "extensions.refStorage") ?? "files";
  if (format !== "files") {
    throw new GitTrustRefusal(join(common, "config"), `extensions.refStorage is ${format}; tickmarkr's own git can pin only the files ref store, so it is refused instead of running unpinned`);
  }
}

/** A detached auto gc or maintenance would outlive its child and read refs through a view already released. */
const NO_BACKGROUND_GIT = "'gc.auto=0' 'maintenance.auto=false'";

const PROBE_REF = "refs/tickmarkr/ref-pin-probe", PROBE_TARGET = "refs/tickmarkr/ref-pin-honoured";
/**
 * Whether, before the child spawns, the git its PATH resolves honours GIT_REFERENCE_BACKEND (git >= 2.54): a fresh
 * probe repository whose own refs lack PROBE_REF, pinned to a fresh store that holds it as a symbolic ref. A git that
 * ignores the pin reads the probe repository's own refs. Nothing is cached: each attempt probes again.
 */
function refStorePinHonoured(env: NodeJS.ProcessEnv): boolean {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-ref-pin-"));
  try {
    const repo = join(dir, "repo"), store = join(dir, "store");
    for (const d of [join(repo, "objects"), join(repo, "refs"), join(store, "refs", "tickmarkr")]) mkdirSync(d, { recursive: true });
    for (const head of [join(repo, "HEAD"), join(store, "HEAD")]) writeFileSync(head, "ref: refs/heads/main\n");
    writeFileSync(join(store, PROBE_REF), `ref: ${PROBE_TARGET}\n`);
    const probe: NodeJS.ProcessEnv = { ...env, GIT_DIR: repo, GIT_REFERENCE_BACKEND: `files://${store}` };
    for (const k of ["GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete probe[k];
    let read = "";
    try {
      read = execFileSync("git", ["symbolic-ref", PROBE_REF], { cwd: dir, env: probe, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }).trim();
    } catch { /* refused below */ }
    return read === PROBE_TARGET;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

let warnedRefStorePin = false;
/** Said once per process: the fallback below is a weaker guard, and the operator should know why and what lifts it. */
function warnRefStorePinUnavailable(): void {
  if (warnedRefStorePin) return;
  warnedRefStorePin = true;
  console.error("tickmarkr: the git on this PATH does not honour GIT_REFERENCE_BACKEND (needs git 2.54 or newer), so tickmarkr's own git in linked checkouts runs without its ref-store pin — path pins and the post-exit commondir recheck only, the 2.6.7 guard; upgrade git for the full pin");
}

/**
 * v2.6.8 T2 (P3): the same uncached check, returning the child of tickmarkr's OWN git in a linked checkout — `env`
 * (the caller's) with GIT_DIR, GIT_COMMON_DIR and GIT_WORK_TREE set to the canonical gitdir, trusted common directory
 * and worktree root derived above, AND the ref store: GIT_REFERENCE_BACKEND names this attempt's private view of the
 * trusted store (refStoreView), since git's ref store otherwise resolves shared refs through the gitdir's commondir
 * FILE even under GIT_COMMON_DIR. So a commondir rewritten after this check (by a live worker or a surviving
 * descendant) is followed for neither config, hooks, info/, objects nor refs: HEAD, branches, status and diffs read
 * the real repository and every ref write lands in the trusted store, whatever an inherited GIT_CONFIG_* or ref backend
 * says; a commondir REMOVED after it cannot move the main checkout's branch. Before such a child spawns, the git it
 * would run must prove it honours that pin (refStorePinHonoured); one that cannot (git < 2.54) runs without it, below.
 * Nothing here reads the command, and no caller leaves any pin. `recheck` (after the child exits) fails closed on ANY change to commondir since the check: the result
 * of that child is never returned. An ordinary checkout or a non-repository gets no pin.
 * NAMED RESIDUAL: git still reads $GIT_DIR/config.worktree when the trusted common config already enables
 * extensions.worktreeConfig, so a config.worktree planted AFTER this check is not closed.
 */
export function ownGitPin(cwd: string, env: NodeJS.ProcessEnv, capability: OwnGitCapability | DetachedAddCapability | TrustedStoreCapability = {}): OwnGitPin | undefined {
  if ("store" in capability) return storePin(capability.store, env);
  const { createsWorktree } = capability;
  const authority = checkedAuthority(cwd);
  if (!authority?.linked) return undefined;
  const { gitdir, common, worktree, stamp } = authority;
  const child: NodeJS.ProcessEnv = { ...env, GIT_DIR: gitdir, GIT_COMMON_DIR: common, GIT_WORK_TREE: worktree,
    GIT_CONFIG_PARAMETERS: `${env.GIT_CONFIG_PARAMETERS?.trim() ?? ""} ${NO_BACKGROUND_GIT}`.trim() };
  // GIT_REF_STORAGE_FORMAT only chooses a NEW repository's format; an inherited one is never a store this child follows
  delete child.GIT_REF_STORAGE_FORMAT;
  assertFilesRefStore(common);
  const commondir = join(gitdir, "commondir");
  const recheck = () => {
    if (stampOf(commondir) !== stamp) {
      throw new GitTrustRefusal(commondir, "changed while tickmarkr's own git ran in this checkout, so that result is refused");
    }
  };
  // D-1484: a git older than 2.54 cannot take the ref-store pin. Refusing it would refuse tickmarkr's own git in every
  // linked checkout on most installed gits, and a hostile git binary ignores every pin anyway; so it runs with the
  // path pins and the post-exit recheck (the 2.6.7 guard). NAMED RESIDUAL there: refs still resolve through the
  // commondir file, so a rewrite between check and exit can reach the hostile store before the recheck refuses.
  if (!refStorePinHonoured(child)) {
    delete child.GIT_REFERENCE_BACKEND;
    warnRefStorePinUnavailable();
    return { env: child, store: common, release: () => {}, unview: (text: string) => text, recheck };
  }
  const view = createsWorktree === "detached" ? { uri: `files://${common}`, release: () => {}, unview: (text: string) => text } : refStoreView(common);
  child.GIT_REFERENCE_BACKEND = view.uri;
  return { env: child, store: common, release: view.release, unview: view.unview, recheck };
}

/** The inert hooks directory every protected git child receives (no hook can exist beneath it). */
export const INERT_HOOKS_PATH = "/dev/null";
const FORCED_GIT_CONFIG = `'core.fsmonitor=false' 'core.hooksPath=${INERT_HOOKS_PATH}'`;

/**
 * A copy of `env` whose git children run with core.fsmonitor=false and an inert core.hooksPath, despite repo
 * config and inherited GIT_CONFIG_COUNT/GIT_CONFIG_PARAMETERS: git applies GIT_CONFIG_PARAMETERS after
 * GIT_CONFIG_COUNT and the last value wins, so the forced pair is appended last. Every other value survives.
 * Named keys only — this does not neutralize arbitrary executable drivers. v2.6.8 T2: only tickmarkr's OWN git
 * children (shGit/shGitOk) receive it; payload shells (gate commands, suites) keep the operator's git config.
 */
export function protectedGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const prior = env.GIT_CONFIG_PARAMETERS?.trim();
  return { ...env, GIT_CONFIG_PARAMETERS: prior ? `${prior} ${FORCED_GIT_CONFIG}` : FORCED_GIT_CONFIG };
}
