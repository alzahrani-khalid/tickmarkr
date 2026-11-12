// Queue row 412 (D-2187 add.67): a stray directory at a task worktree path, the branch head a failed add
// would lose, and preserve's registered-worktree check. Every git question here has three answers (D-2187
// add.156): yes, no, and UNKNOWN (the probe failed), which throws and is never read as no.
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { shq } from "../adapters/types.js";
import { shGit } from "./git.js";
import { withoutExecutionBudget } from "./execution-budget.js";
import { GitTrustRefusal, trustedCommonDir } from "./git-trust.js";

const real = (path: string): string | undefined => { try { return realpathSync(path); } catch { return undefined; } };

/** A row 412 failure the daemon parks as infra with this data (disposition, path, printed recovery), never task-failed. */
export class WorktreeInfraError extends Error {
  constructor(readonly detail: string, readonly data: { disposition: string; path: string; recovery: string } & Record<string, unknown>) {
    super(`${detail}; recover with: ${data.recovery} then approve the task (row 412, D-2187 add.67)`);
    this.name = "WorktreeInfraError";
  }
  get path(): string { return this.data.path; }
  get recovery(): string { return this.data.recovery; }
}

/** A git probe itself failed (D-2187 add.156): the answer is unknown, so nothing was deleted, moved, written or added. */
export class GitProbeUnknownError extends WorktreeInfraError {
  constructor(subject: string, command: string, cwd: string, exit: number | null, detail: string) {
    const recovery = `cd -- ${shq(cwd)} && ${command}`;
    super(`git probe for ${subject} failed (exit ${exit ?? "none"}): ${command} in ${cwd}: ${detail}; nothing was deleted, moved, written or added`,
      { disposition: "git-probe-unknown", path: subject, recovery, probe: command, exit });
    this.name = "GitProbeUnknownError";
  }
}

type Probe = { code: number | null; stdout: string; stderr: string };
/** A probe that throws (a spawn fault) is a failed probe, never an answer; a trust refusal keeps its own type and handling. */
const probe = async (cmd: string, cwd: string): Promise<Probe> => {
  try { return await shGit(cmd, cwd); }
  catch (error) {
    if (error instanceof GitTrustRefusal) throw error;
    return { code: null, stdout: "", stderr: String(error) };
  }
};
const unknown = (subject: string, cmd: string, cwd: string, r: Probe): GitProbeUnknownError =>
  new GitProbeUnknownError(subject, cmd, cwd, r.code, (r.stderr || r.stdout).trim());
// only git's output terminator is removed: a path may end in whitespace or hold a newline
const line = (stdout: string): string => stdout.replace(/\n$/, "");

/**
 * Row 412 (c), D-2187 add.104 C6 and add.156 (1)(2): `dir` is a work tree git lists for its repository (asked of
 * `repo`, or of the common dir `dir` derives when none is named) AND is that work tree's top level. A plain directory
 * inside the worktrees folder resolves the PARENT repository, whose listing does not hold it: no. A failed probe throws
 * GitProbeUnknownError.
 */
export async function isRegisteredWorktree(dir: string, repo?: string): Promise<boolean> {
  let self: string;
  try { self = realpathSync(dir); }
  catch (error) {
    if (absent(error)) return false;
    throw new GitProbeUnknownError(dir, `realpath ${shq(dir)}`, dir, null, String(error));
  }
  let at = repo;
  // derived (no repository named): the listing runs in the directory, which the derivation proved resolves that same
  // common dir, so git lists that common dir's worktrees through the directory's own trust pin (an unpinned spawn at the
  // common dir would bypass it)
  if (at === undefined) {
    const common = "git rev-parse --path-format=absolute --git-common-dir";
    // the directory's OWN `.git` refused (a pruned worktree's gitfile names a missing gitdir) is a failed derivation:
    // unknown. A refusal naming other metadata (a redirected commondir) keeps its trust type.
    const r = await probe(common, dir).catch((error: unknown) => {
      if (error instanceof GitTrustRefusal && error.path === join(self, ".git")) return { code: null, stdout: "", stderr: error.message };
      throw error;
    });
    if (r.code !== 0) throw unknown(dir, common, dir, r);
    at = dir;
  }
  const list = "git worktree list --porcelain -z";
  const listed = await probe(list, at);
  if (listed.code !== 0) throw unknown(dir, list, at, listed);
  if (!listed.stdout.split("\0").some((field) => field.startsWith("worktree ") && real(field.slice(9)) === self)) return false;
  const toplevel = "git rev-parse --show-toplevel";
  const top = await probe(toplevel, dir);
  if (top.code !== 0) throw unknown(dir, toplevel, dir, top);
  return real(line(top.stdout)) === self;
}

// only a path that does not resolve is absent: an inaccessible parent (EACCES) is unknown, never "no checkout here"
const absent = (error: unknown): boolean => ["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code));

/** Row 412 (D-2187 add.156): something is at `path` (yes), nothing resolves (no), or the stat failed (throws, unknown). */
export function pathPresent(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if (absent(error)) return false;
    throw new GitProbeUnknownError(path, `stat ${shq(path)}`, path, null, String(error));
  }
}

/**
 * D-2187 add.156 (3)(4): a ref's object name, or undefined only when the absent-ref transaction exits 0. A quiet exit 1
 * of the verify is not a no: a broken ref exits 1 too.
 */
async function refValue(repo: string, ref: string): Promise<string | undefined> {
  const verify = await probe(`git rev-parse --verify -q ${shq(ref)}`, repo);
  const oid = verify.stdout.trim();
  if (verify.code === 0 && oid) return oid;
  const absent = `printf '%s\\n' ${shq(`verify ${ref}`)} | git update-ref --stdin`;
  const r = await probe(absent, repo);
  if (r.code === 0) return undefined;
  throw unknown(ref, absent, repo, r);
}

/** An add failed because its path exists and is not a registered worktree (row 412 b). */
export class WorktreePathExistsError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`worktree add failed: ${path} exists and is not a registered worktree: ${detail}`);
    this.name = "WorktreePathExistsError";
  }
}

/** The stray could not be moved aside, or the single retried add failed: an infra park, never a failed task. */
export class WorktreeStrayError extends WorktreeInfraError {
  constructor(path: string, detail: string, movedTo?: string, recovery?: string) {
    recovery ??= existsSync(path) ? `mv -- ${shq(path)} ${shq(`${path}.quarantine-manual`)}` : "git worktree prune";
    super(`stray directory at worktree path ${path}: ${detail}`,
      { disposition: "worktree-stray", path, recovery, ...(movedTo ? { movedTo } : {}) });
    this.name = "WorktreeStrayError";
  }
  get movedTo(): string | undefined { return this.data.movedTo as string | undefined; }
}

const listEntries = (root: string, limit = 20): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: import("node:fs").Dirent[];
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of names) {
      if (out.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
};

/**
 * Row 412 (b): move the stray aside to a sibling `<path>.quarantine-<UTC stamp>` (never deleted here), journal it, and
 * retry the add EXACTLY once. The admin-race retry policy is the caller's and is never nested in this retry.
 */
export async function quarantineAndRetry<T>(
  error: WorktreePathExistsError,
  add: () => Promise<T>,
  journal: (data: { path: string; movedTo: string; entries: string[] }) => void,
  now: Date = new Date(),
): Promise<T> {
  const { path } = error;
  const movedTo = `${path}.quarantine-${now.toISOString().replace(/[-:.]/g, "")}`;
  const entries = listEntries(path);
  // D-2187 add.159: the move's entry is recorded BEFORE the move, so every park of this dispatch (an execution budget
  // that replaced the error included) prints the original path, the sibling and a command completing the move
  const finish = moveCommand(path, movedTo);
  const store = dispatch.getStore();
  if (store) store.move = { path, movedTo, recovery: finish };
  try { renameSync(path, movedTo); }
  catch (move) {
    throw new WorktreeStrayError(path, `could not move it aside to ${movedTo}: ${move instanceof Error ? move.message : String(move)}`, undefined,
      existsSync(path) ? finish : undefined);
  }
  journal({ path, movedTo, entries });
  let result: T;
  try { result = await add(); }
  catch (retry) {
    // Binding contract, row 412 amendment J (D-2187 add.159), "The dispatch's recovery record": "This task changes neither
    // the trust-refusal path nor the admin-race policy: a trust refusal keeps its type and its base ending (task-failed),
    // and this task does not park it." Rule (b)'s infra park covers a failed retry of the add itself; a refusal is the
    // trust check's verdict on hostile git metadata, which an operator must not "recover" by re-approving. Nothing is lost
    // (the stray is in its sibling with its journal row, the safety ref holds the prior head) and the daemon prints the
    // recovery record in the task-failed row's error text (daemon.ts, the dispatch catch's default ending).
    if (retry instanceof GitTrustRefusal) throw retry;
    const detail = `moved aside to ${movedTo}; the single retried add failed: ${retry instanceof Error ? retry.message : String(retry)}`;
    // the worktree was added but the dispatch's safety ref stayed: the recovery is removing that ref, not moving the worktree;
    // a safety ref a failed add kept is named by ownSafetyRefs on the way out
    throw new WorktreeStrayError(path, detail, movedTo, retry instanceof SafetyRefCleanupError ? retry.recovery : undefined);
  }
  return result;
}

/** The add succeeded but the dispatch's temporary safety ref could not be removed (row 412 a): an infra park naming it. */
export class SafetyRefCleanupError extends WorktreeInfraError {
  constructor(readonly ref: string, detail: string, recovery: string) {
    super(`worktree added but its temporary safety ref ${ref} could not be removed: ${detail}`,
      { disposition: "safety-ref", path: ref, recovery });
    this.name = "SafetyRefCleanupError";
  }
}

/**
 * The current dispatch's safety refs across its admin-race and quarantine retries (row 412 a): `owned` are the refs it
 * created, `retained` maps each ref a failed add kept to the command that recovers it.
 */
type Dispatch = { owned: Set<string>; retained: Map<string, string>; pending: Set<string>; move?: { path: string; movedTo: string; recovery: string } };
/** Completes a stray's move only while the path is still there and the sibling is not; it never deletes the sibling. */
const moveCommand = (path: string, movedTo: string): string =>
  `if [ -e ${shq(path)} ] && [ ! -e ${shq(movedTo)} ]; then mv -- ${shq(path)} ${shq(movedTo)}; fi`;

/**
 * Row 412 (a), D-2187 add.156: a printed recovery never depends on whether the safety ref's write landed. The branch is
 * restored from the literal prior head, never through the ref, and the ref is dropped only if it exists.
 */
const guardedDrop = (ref: string, prior: string): string =>
  `if git show-ref --verify --quiet ${shq(ref)}; then git update-ref -d ${shq(ref)} ${shq(prior)}; fi`;
/** Names the kept refs without claiming one whose write was never confirmed exists. */
const keptNote = (refs: string[], pending?: Set<string>): string => refs.map((ref) => pending?.has(ref)
  ? `the safety ref ${ref} may hold the prior head (its write was not confirmed)` : `the safety ref ${ref} keeps the prior head`).join("; ");
const dispatch = new AsyncLocalStorage<Dispatch>();

/**
 * One dispatch's add sequence: a safety ref an earlier failed attempt created is removed by a later attempt's success.
 * When the sequence fails with a safety ref kept, the failure parks infra and its printed recovery names that ref, on
 * every path: a plain add, an admin race, a quarantine move or its retry, an unknown probe (D-2187 add.156). The store is
 * also registered under `key` (the worktree path) so a park whose error never passed through here (an execution budget
 * that replaced it, a cleanup probe that failed after it) still reads the refs through keptSafetyRefs.
 */
export const ownSafetyRefs = <T>(adds: () => Promise<T>, key?: string): Promise<T> => {
  const store: Dispatch = { owned: new Set(), retained: new Map(), pending: new Set() };
  if (key !== undefined) liveByPath.set(key, store);
  // on failure the store stays registered: an execution budget may already have replaced the decorated error, and
  // withKeptSafetyRefs skips any ref the park's own error already names
  return dispatch.run(store, () => adds().then((result) => {
    // the creation finally succeeded: the move's entry leaves the record
    store.move = undefined;
    if (key !== undefined && liveByPath.get(key) === store && !store.retained.size) liveByPath.delete(key);
    return result;
  }, (error: unknown) => { throw naming(error, store.retained, store.pending); }));
};

/**
 * Row 412 (a), D-2187 add.156: each dispatch's recovery entries, keyed by worktree path. An entry is recorded BEFORE the
 * git command that writes its safety ref (an interrupted write still leaves it) and removed only after the ref's deletion
 * is confirmed, so every park of the task reads what survives; taken once.
 */
const liveByPath = new Map<string, Dispatch>();
export const keptSafetyRefs = (key: string, named = ""): { note: string; kept: string; data: { safetyRefs?: string[]; quarantine?: { path: string; movedTo: string }; recovery: string } } | undefined => {
  const store = liveByPath.get(key);
  liveByPath.delete(key);
  const entries = [...store?.retained ?? []].filter(([ref]) => !named.includes(shq(ref)) && !named.includes(` ${ref}`));
  // D-2187 add.159: the stray's move, unless the park's own error already names where it was moved
  const move = store?.move && !named.includes(store.move.movedTo) && !named.includes(store.move.recovery) ? store.move : undefined;
  if (!entries.length && !move) return undefined;
  const refs = entries.map(([ref]) => ref);
  const recovery = [...move ? [move.recovery] : [], ...entries.map(([, command]) => command)].join(" && ");
  const kept = [...move ? [`the stray at worktree path ${move.path} was moved (or is being moved) aside to ${move.movedTo}`] : [],
    ...refs.length ? [keptNote(refs, store?.pending)] : []].join("; ");
  return { kept, note: `; ${kept}; recover with: ${recovery}`,
    data: { ...refs.length ? { safetyRefs: refs } : {}, ...move ? { quarantine: { path: move.path, movedTo: move.movedTo } } : {}, recovery } };
};

/** A park's message and data with the kept safety refs (if any) named and prepended to its recovery (row 412 a). */
export const withKeptSafetyRefs = (key: string, message: string, data: Record<string, unknown>): { message: string; data: Record<string, unknown> } => {
  const kept = keptSafetyRefs(key, `${message} ${typeof data.recovery === "string" ? data.recovery : ""}`);
  if (!kept) return { message, data };
  if (typeof data.recovery !== "string" || !message.includes(data.recovery)) {
    return { message: `${message}${kept.note}`, data: { ...data, ...kept.data } };
  }
  // the park prints ONE executable recovery: the kept refs' commands run before the error's own
  const recovery = `${kept.data.recovery} && ${data.recovery}`;
  const note = `; ${kept.kept}`;
  return { message: `${message.replace(data.recovery, () => recovery)}${note}`, data: { ...data, ...kept.data, recovery } };
};

function naming(error: unknown, retained: Map<string, string>, pending: Set<string>): unknown {
  if (!retained.size) return error;
  const refs = [...retained.keys()];
  const safety = [...retained.values()].join(" && ");
  const kept = `; ${keptNote(refs, pending)}`;
  if (error instanceof WorktreeInfraError) {
    // a failed restore already names its own ref's recovery: each command once
    const extra = [...retained].filter(([ref, command]) => !error.recovery.includes(command) && !error.recovery.includes(shq(ref))).map(([, command]) => command);
    return new WorktreeInfraError(`${error.detail}${kept}`, { ...error.data, safetyRefs: refs, recovery: [...extra, error.recovery].join(" && ") });
  }
  // an exhausted admin race is an infra park with no recovery of its own: it becomes one naming the ref
  if (error instanceof Error && error.name === "WorktreeAdminRaceError") {
    return new WorktreeInfraError(`${error.message}${kept}`,
      { disposition: "worktree-admin-race", path: refs[0]!, safetyRefs: refs, recovery: safety, evidence: (error as { evidence?: unknown }).evidence });
  }
  // a plain add failure stays task-failed (row 223) and its error names the ref and its recovery; ponytail: other typed
  // errors (budget, host, held probe) keep their own daemon handling unchanged
  if (error instanceof Error && (error.constructor === Error || error.constructor === AggregateError)) {
    return new AggregateError([error], `${error.message}${kept}; recover with: ${safety}`);
  }
  return error;
}

/** Cleanup, so outside any execution budget (an expired one would refuse it); a failed step is thrown, never ignored. */
const bounded = (repo: string, cmd: string) => withoutExecutionBudget(() => probe(cmd, repo));

async function dropSafetyRef(repo: string, ref: string, prior: string): Promise<void> {
  const r = await bounded(repo, `git update-ref -d ${shq(ref)} ${shq(prior)}`);
  if (r.code !== 0) throw new SafetyRefCleanupError(ref, (r.stderr || r.stdout).trim(), `cd -- ${shq(repo)} && ${guardedDrop(ref, prior)}`);
}

/**
 * Row 412 (a): `git worktree add -B` resets an existing branch to base BEFORE it fails on an existing path. While the add
 * runs, the branch's prior head is held by a TEMPORARY safety ref; any failure restores the branch to it and keeps the ref
 * as the recovery point; success removes it. A ref that existed before this dispatch is never written or deleted; one an
 * earlier failed attempt of the same dispatch (inside `ownSafetyRefs`) created is this dispatch's to remove. An unknown
 * probe, or a safety ref that cannot be written, parks infra before any add (D-2187 add.156).
 */
export async function withBranchSafety<T>(repo: string, branch: string, add: (prior: string | undefined) => Promise<T>): Promise<T> {
  // the ONE checked prior-head probe: the add's own rollback uses this answer, never a second unchecked read
  const prior = await refValue(repo, `refs/heads/${branch}`);
  if (!prior) return add(undefined);
  // scoped to the branch: a sibling dispatch whose branch shares this head never owns (nor removes) this recovery point
  const ref = `refs/tickmarkr/safety/${branch}/${prior}`;
  const store = dispatch.getStore();
  const mine = store?.owned;
  const existed = await refValue(repo, ref) !== undefined;
  const ours = !existed || mine?.has(ref) === true;
  const head = `refs/heads/${branch}`;
  const drop = guardedDrop(ref, prior);
  // restored from the literal prior head, so it holds whether or not the write below landed
  const back = `cd -- ${shq(repo)} && git update-ref ${shq(head)} ${shq(prior)}${ours ? ` && ${drop}` : ""}`;
  // recorded BEFORE the write and before the add: an interrupted write or add still leaves the recovery named; an older
  // ref is named without ever being deleted
  store?.retained.set(ref, back);
  if (!existed) {
    // pending until the write's exit 0: an interrupted or failed write may or may not have landed
    store?.pending.add(ref);
    const write = `git update-ref ${shq(ref)} ${shq(prior)} ''`;
    const wrote = await probe(write, repo);
    if (wrote.code !== 0) {
      // the entry stays: the write may have landed before its non-zero exit; the guarded drop removes it only if it did
      throw new WorktreeInfraError(`could not confirm the safety ref ${ref} for ${branch} (exit ${wrote.code ?? "none"}): ${(wrote.stderr || wrote.stdout).trim()}; no add ran`,
        { disposition: "safety-ref", path: ref, recovery: `cd -- ${shq(repo)} && ${drop}` });
    }
    store?.pending.delete(ref);
    mine?.add(ref);
  }
  let result: T;
  try { result = await add(prior); }
  catch (error) {
    // a failed restore (a trust refusal's hostile commondir; its own rollback restores through the trusted store) never
    // replaces the add's error: the safety ref still holds the prior head
    const restore = await bounded(repo, `git update-ref ${shq(head)} ${shq(prior)}`)
      .then((r) => r.code === 0 ? undefined : (r.stderr || r.stdout).trim(), (e: unknown) => String(e));
    const why = restore === undefined ? "" : `; restoring ${branch} to ${prior} failed, the safety ref ${ref} keeps it: ${restore}`;
    // a failed restore keeps the ref as the recovery point: no later success of this dispatch removes it
    if (why) mine?.delete(ref);
    // the ref this failure keeps, with the command that recovers it: the branch is back, so an owned ref only needs
    // dropping; an older recovery ref stays named and is never deleted
    if (!why && ours) store?.retained.set(ref, `cd -- ${shq(repo)} && ${drop}`);
    // D-2187 add.156: a failed restore stops every retry (quarantine, admin race) and parks infra naming the ref; the
    // add's own error stays in the detail. A trust refusal keeps its type: its rollback restores through the trusted store
    if (why && !(error instanceof GitTrustRefusal)) {
      throw new WorktreeInfraError(`${error instanceof Error ? error.message : String(error)}${why}`,
        { disposition: "safety-ref-restore", path: ref, recovery: back });
    }
    // the base's trust-refusal path is unchanged (D-2187 add.159): the refusal leaves the trusted refs as the base did. The
    // branch is restored and an owned ref dropped through the TRUSTED common dir (the checkout's metadata may still be
    // hostile); the entry leaves the record only once that drop is confirmed
    if (ours && error instanceof GitTrustRefusal) {
      let at: string | undefined;
      try { at = trustedCommonDir(repo); } catch { at = undefined; }
      const trusted = (cmd: string) => withoutExecutionBudget(() => shGit(cmd, at!, undefined, { store: at! }))
        .then((r) => r.code, () => null);
      if (at !== undefined && await trusted(`git update-ref ${shq(head)} ${shq(prior)}`) === 0
        && await trusted(`git update-ref -d ${shq(ref)} ${shq(prior)}`) === 0) {
        store?.retained.delete(ref); mine?.delete(ref);
      }
    }
    if (error instanceof WorktreePathExistsError) throw new WorktreePathExistsError(error.path, `${error.detail}${why}`);
    throw why && error instanceof Error && error.constructor === Error ? new AggregateError([error], `${error.message}${why}`) : error;
  }
  if (!ours) { store?.retained.delete(ref); return result; }
  // the add succeeded: only the drop is owed, and the entry leaves only once the drop is confirmed
  store?.retained.set(ref, `cd -- ${shq(repo)} && ${drop}`);
  await dropSafetyRef(repo, ref, prior);
  store?.retained.delete(ref);
  mine?.delete(ref);
  return result;
}
