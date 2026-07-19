import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shq } from "../adapters/types.js";
import { tickmarkrDir } from "../graph/graph.js";
import { ROUTING_ENV_SEAMS } from "../route/router.js";

export { ROUTING_ENV_SEAMS };

export interface ShResult { code: number; stdout: string; stderr: string; timedOut?: boolean }

// stdin "ignore": same class as HARD-05 / SubprocessDriver — never leave an open pipe a child can block on
// (pi -p / codex exec wait for stdin EOF). timedOut distinguishes SIGKILL-timeout from a real nonzero exit.
function shell(cmd: string, cwd: string, timeoutMs: number, login: boolean): Promise<ShResult> {
  // OBS-74: scrub tickmarkr's own routing env seams from every child — a daemon carrying
  // TICKMARKR_QUALITY leaked it into baseline/gate/tip-verify children, turning a dogfood
  // repo's route() tests red inside the gates. Scrub a copy at this one choke point so
  // children are hermetic by construction; the daemon's own process.env stays unchanged.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ROUTING_ENV_SEAMS) delete env[k];
  return new Promise((resolve) => {
    // detached: bash gets its own process group so a timeout can kill the whole tree —
    // SIGKILLing bash alone orphans grandchildren (codex/pi) that hold the stdio pipes
    // open, so "close" never fires and the promise wedges forever (v1.33.1 init hang).
    const p = spawn("bash", [login ? "-lc" : "-c", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "";
    let timedOut = false, done = false;
    const finish = (code: number, err?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: err ?? stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-p.pid!, "SIGKILL"); } catch { p.kill("SIGKILL"); }
    }, timeoutMs);
    p.stdout!.on("data", (d) => (stdout += d));
    p.stderr!.on("data", (d) => (stderr += d));
    p.on("error", (e) => finish(127, String(e)));
    p.on("close", (code) => finish(code ?? 1));
    // "close" waits for stdio to drain; a surviving pipe-holder must not outlive the timeout
    p.on("exit", (code) => { if (timedOut) finish(code ?? 1); });
  });
}

export function sh(cmd: string, cwd: string, timeoutMs = 600000): Promise<ShResult> {
  return shell(cmd, cwd, timeoutMs, true);
}

// Git plumbing never needs an operator profile; skip login-shell startup and its side effects.
export function shGit(cmd: string, cwd: string, timeoutMs = 600000): Promise<ShResult> {
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

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  await shGit(`git worktree remove --force ${shq(dir)}`, repo); // best-effort; stale dirs are re-added with -B
  await shGit(`rm -rf ${shq(dir)}`, repo);
  await shGit("git worktree prune", repo);
}
