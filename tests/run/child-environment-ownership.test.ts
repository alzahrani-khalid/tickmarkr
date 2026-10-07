// v2.6.8 T2: child env and child git reach only their owner. Ownership is selected by ENTRY — shell/sh/shOk are
// payloads (operator git config kept, no checkout pin); shGit/shGitOk are tickmarkr's own git (forced inert
// hooks/fsmonitor and, in a linked checkout, a GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE pin AND, by default, the ref store,
// re-derived per attempt; only a caller declaring the detached worktree capability leaves the ref-store pin — the
// command text never selects a pin).
// Every oracle row supplies the inherited operator config / foreign token ITSELF; tests/setup.ts's D-1196
// containment only shields this suite from an installed <= 2.6.7 harness and never supplies a positive here.
// Slowest-runner note: deadlines below bound fixture setup/cleanup; readiness is a file/exit event, never a delay.
import { execFileSync, spawn, spawnSync, type SpawnOptions, type SpawnSyncReturns } from "node:child_process";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { afterEach, describe, expect, test, vi } from "vitest";
import { verify, verifyStateDir } from "../../src/cli/commands/verify.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { acceptanceGate } from "../../src/gates/acceptance.js";
import { captureBaseline, type Baseline } from "../../src/gates/baseline.js";
import { getWorktreeTree } from "../../src/gates/cache.js";
import { evidenceGate } from "../../src/gates/evidence.js";
import { changedPaths, fetchTaskDiff, mirrorsVersionOnly } from "../../src/gates/review.js";
import { runGates } from "../../src/gates/run-gates.js";
import { evaluateManifestedTest } from "../../src/gates/test-manifest.js";
import { HerdrDriver } from "../../src/drivers/herdr.js";
import { formatOwnedName } from "../../src/drivers/types.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { executionSignal, withExecutionBudget, type ExecutionBudgetEvent } from "../../src/run/execution-budget.js";
import { addDetachedWorktree, createWorktree, gitHead, preserveWorktree, removeWorktree, resetSpawnForTests, setSpawnForTests, sh, shell, shGit, shGitOk, shOk, WORKTREES_DIR } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { releaseRunLock } from "../../src/run/lock.js";
import { GitTrustRefusal, INERT_HOOKS_PATH } from "../../src/run/git-trust.js";
import { COMMAND_LEASE_TOKEN_ENV, repositoryLeasePath, withRepositoryLease } from "../../src/run/lease.js";
import { ensureIntegration, mergeTask } from "../../src/run/merge.js";
import { VERIFICATION_JOB_TOKEN_ENV, withVerificationJob, type VerificationJobReport } from "../../src/run/verification-job.js";
import { shq } from "../../src/adapters/types.js";
import { makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const ROOT = join(import.meta.dirname, "../..");
const TSX = pathToFileURL(join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;
const FORCED = `'core.fsmonitor=false' 'core.hooksPath=${INERT_HOOKS_PATH}'`;
const PIN_KEYS = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_REFERENCE_BACKEND", "GIT_REF_STORAGE_FORMAT"] as const;

// Raw controls never inherit a forced fragment from an enclosing protected shell.
const rawEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env = { ...process.env, ...extra };
  if (!("GIT_CONFIG_PARAMETERS" in extra)) delete env.GIT_CONFIG_PARAMETERS;
  for (const k of PIN_KEYS) if (!(k in extra)) delete env[k];
  return env;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: rawEnv() }).trim();
const refMap = (repo: string) => git(repo, "for-each-ref", "--format=%(refname) %(objectname)") + `\nHEAD ${git(repo, "rev-parse", "HEAD")}`;
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const witnessScript = (path: string, witness: string, exit = 0) =>
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "\${TKR_ROW:-unlabelled} $(basename "$0") $*" >> '${witness}'\nexit ${exit}\n`, { mode: 0o755 });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (ready: () => boolean, what: string) => {
  const deadline = Date.now() + 60_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`fixture did not reach ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
};
const sab = new Int32Array(new SharedArrayBuffer(4));
const waitSync = (path: string) => {
  const deadline = Date.now() + 60_000;
  while (!existsSync(path)) { if (Date.now() > deadline) throw new Error(`no ${path}`); Atomics.wait(sab, 0, 0, 5); }
};

/** The operator's hook-enabling git config, supplied by each row itself as an inherited export. */
interface Operator { hooks: string; hookWitness: string; fsmonitor: string; fsWitness: string; env: Record<string, string> }
const operator = (): Operator => {
  const dir = makeTestTempDir("child-env-operator-");
  const hooks = join(dir, "hooks");
  mkdirSync(hooks);
  const hookWitness = join(dir, "hook.witness"), fsWitness = join(dir, "fsmonitor.witness");
  witnessScript(join(hooks, "pre-commit"), hookWitness);
  const fsmonitor = join(dir, "fsmonitor");
  witnessScript(fsmonitor, fsWitness, 1);
  return { hooks, hookWitness, fsmonitor, fsWitness,
    env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks,
      GIT_CONFIG_PARAMETERS: `'core.fsmonitor=${fsmonitor}' 'core.hooksPath=${hooks}'` } };
};
const exportOperator = (op: Operator) => { for (const [k, v] of Object.entries(op.env)) vi.stubEnv(k, v); };
const commitCmd = (repo: string, label: string) =>
  `TKR_ROW=${label} git -C '${repo}' -c user.name=t -c user.email=t@t.invalid commit -q --no-gpg-sign --allow-empty -m '${label}'`;

/**
 * An ordinary repository, a REAL linked worktree of it, and an independently created hostile common directory: a
 * mirror of the real refs whose `task` branch is moved to a DECOY commit (adding decoy.txt; its object also sits in
 * the real store, so a redirected ref read resolves silently instead of failing), carrying hostile executable
 * config — an fsmonitor (status/add) and a diff.external (patch output) that each write a witness when git reads it.
 */
interface Linked { repo: string; common: string; linked: string; gitdir: string; worktree: string; hostile: string; hostileCommon: string; hostileFs: string; hostileExt: string; base: string; decoy: string }
const linkedFixture = (files: Record<string, string> = { "a.txt": "one\n", "sub/b.txt": "two\n" }, prepare?: (linked: string) => void, existing?: string): Linked => {
  const repo = existing ?? makeRepo(files);
  const base = git(repo, "rev-parse", "HEAD");
  const linked = join(makeTestTempDir("child-env-linked-"), "task");
  git(repo, "worktree", "add", "-q", "-b", "task", linked, "HEAD");
  prepare?.(linked);
  const common = realpathSync(join(repo, ".git"));
  const witnesses = makeTestTempDir("child-env-hostile-");
  const hostile = join(witnesses, "hostile.git");
  const scratch = rawEnv({ GIT_INDEX_FILE: join(witnesses, "decoy.index") });
  execFileSync("git", ["read-tree", base], { cwd: repo, env: scratch });
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, env: scratch, input: "decoy\n", encoding: "utf8" }).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},decoy.txt`], { cwd: repo, env: scratch });
  const decoyTree = execFileSync("git", ["write-tree"], { cwd: repo, env: scratch, encoding: "utf8" }).trim();
  const decoy = git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit-tree", decoyTree, "-p", base, "-m", "decoy");
  git(repo, "update-ref", "refs/decoy", decoy);
  git(witnesses, "clone", "-q", "--mirror", repo, hostile);
  git(repo, "update-ref", "-d", "refs/decoy");
  git(hostile, "update-ref", "refs/heads/task", decoy);
  git(hostile, "update-ref", "-d", "refs/decoy");
  const hostileFs = join(witnesses, "hostile-fsmonitor.witness"), hostileExt = join(witnesses, "hostile-ext.witness");
  witnessScript(join(witnesses, "fsmonitor"), hostileFs, 1);
  witnessScript(join(witnesses, "ext"), hostileExt);
  git(hostile, "config", "core.fsmonitor", join(witnesses, "fsmonitor"));
  git(hostile, "config", "diff.external", join(witnesses, "ext"));
  return { repo, common, linked, gitdir: join(common, "worktrees", "task"), worktree: realpathSync(linked), hostile,
    hostileCommon: realpathSync(hostile), hostileFs, hostileExt, base, decoy };
};

// ---- the spawn seam: AFTER the trust check, BEFORE the git child exists, commondir is rewritten hostile (or
// removed), and restored once the child has run — unless `persist`: then it stays hostile through every cleanup;
// `out` keeps what that child itself printed; `afterArmedChild` runs once that child has run, inside its caller's context ----
interface Seen { cmd: string; cwd: string; env: NodeJS.ProcessEnv; out?: string; view?: Record<string, string> }
interface Armed { gitdir: string; worktree: string; hostileCommon: string; rewrite: (target: string, content: string) => void; match?: RegExp; persist?: boolean }
let armed: Armed | undefined;
let refuseOnce: { match: string; onRefuse?: () => void } | undefined;
let afterArmedChild: (() => void) | undefined;
const seen: Seen[] = [];
const inside = (root: string, cwd: string) => { const real = realpathSync(cwd); return real === root || real.startsWith(`${root}/`); };
const fakeChild = (pid: number | undefined, run: (child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }) => void) => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid, kill: () => true });
  setImmediate(() => run(child));
  return child;
};
/** The real child already ran to completion under the rewritten metadata; replay its bytes and exit. */
const replay = (r: SpawnSyncReturns<Buffer>) => fakeChild(r.pid, (child) => {
  child.emit("spawn");
  if (r.stdout?.length) child.stdout.emit("data", r.stdout);
  if (r.stderr?.length) child.stderr.emit("data", r.stderr);
  child.emit("exit", r.status, r.signal);
  child.emit("close", r.status, r.signal);
});
const installSeam = () => setSpawnForTests(((file: string, args: string[], opts: SpawnOptions) => {
  const cmd = args[1]!, cwd = String(opts.cwd);
  const entry: Seen = { cmd, cwd, env: { ...opts.env }, view: viewOf(opts.env?.GIT_REFERENCE_BACKEND) };
  seen.push(entry);
  if (refuseOnce && cmd.includes(refuseOnce.match)) {
    const onRefuse = refuseOnce.onRefuse; refuseOnce = undefined; onRefuse?.();
    return fakeChild(undefined, (child) => child.emit("error", Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" })));
  }
  if (!armed || !inside(armed.worktree, cwd) || (armed.match && !armed.match.test(cmd))) return spawn(file, args, opts);
  const commondir = join(armed.gitdir, "commondir");
  const original = readFileSync(commondir, "utf8"), persist = armed.persist;
  armed.rewrite(commondir, `${armed.hostileCommon}\n`);
  try {
    const r = spawnSync(file, args, { cwd, env: opts.env });
    entry.out = String(r.stdout ?? "");
    afterArmedChild?.();
    return replay(r);
  } finally { if (!persist) writeFileSync(commondir, original); }
}) as unknown as Parameters<typeof setSpawnForTests>[0]);
const pinOf = (env: NodeJS.ProcessEnv) => Object.fromEntries(PIN_KEYS.map(k => [k, env[k]]));
/** The private ref view a child was pinned to, read at spawn: each entry's link target, or "file". */
function viewOf(uri: string | undefined): Record<string, string> | undefined {
  const dir = uri?.startsWith("files://") ? uri.slice("files://".length) : undefined;
  if (!dir || !existsSync(dir) || !basename(dir).startsWith("tickmarkr-refs-")) return undefined;
  return Object.fromEntries(readdirSync(dir).map(n => [n, lstatSync(join(dir, n)).isSymbolicLink() ? readlinkSync(join(dir, n)) : "file"]));
}
const NO_BACKGROUND_GIT = "'gc.auto=0' 'maintenance.auto=false'";
/** The pin (linked gitdir, trusted common, worktree root) AND the ref store: a private view of THIS attempt whose
 * entries link into the independently expected trusted common directory, beside the HEAD.lock that blocks a
 * HEAD-relative write once commondir is removed; the view is gone once the child has exited. */
const expectPinned = (s: Seen, f: Pick<Linked, "gitdir" | "common" | "worktree">, why: string, step: "view" | "detached add" = "view") => {
  if (step === "detached add") { // addDetachedWorktree's add step: the ref store is the trusted common directory itself
    expect(pinOf(s.env), `${why}: ${s.cmd}`).toEqual({ GIT_DIR: f.gitdir, GIT_COMMON_DIR: f.common, GIT_WORK_TREE: f.worktree,
      GIT_REFERENCE_BACKEND: `files://${f.common}`, GIT_REF_STORAGE_FORMAT: undefined });
  } else {
    expect(pinOf(s.env), `${why}: ${s.cmd}`).toEqual({ GIT_DIR: f.gitdir, GIT_COMMON_DIR: f.common, GIT_WORK_TREE: f.worktree,
      GIT_REFERENCE_BACKEND: expect.stringMatching(/^files:\/\/\/.+\/tickmarkr-refs-[^/]+$/), GIT_REF_STORAGE_FORMAT: undefined });
    expect(s.view, `${why}: ${s.cmd}`).toEqual({ refs: join(f.common, "refs"), "packed-refs": join(f.common, "packed-refs"),
      logs: join(f.common, "logs"), worktrees: join(f.common, "worktrees"), HEAD: join(f.common, "HEAD"), "HEAD.lock": "file" });
    expect(existsSync(s.env.GIT_REFERENCE_BACKEND!.slice("files://".length)), `${why}: view released`).toBe(false);
  }
  expect(s.env.GIT_CONFIG_PARAMETERS, `${why}: ${s.cmd}`).toContain(FORCED);
  expect(s.env.GIT_CONFIG_PARAMETERS?.endsWith(NO_BACKGROUND_GIT), `${why}: ${s.cmd}`).toBe(true);
};
const directRewrite = (target: string, content: string) => writeFileSync(target, content);
/** The own-git entry ran its child across the mid-child rewrite, then refused naming commondir: what that child printed. */
const refusedAfter = async (f: Linked, run: () => Promise<unknown>, why: string): Promise<string> => {
  const from = seen.length;
  await expect(run(), why).rejects.toMatchObject({ name: "GitTrustRefusal", path: join(f.gitdir, "commondir") });
  return seen.slice(from).map(s => s.out ?? "").join("");
};

const owned: number[] = [];
afterEach(() => {
  resetSpawnForTests(); armed = undefined; refuseOnce = undefined; afterArmedChild = undefined; seen.length = 0;
  for (const pid of owned.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

// ---- a manifest runner fixture: discovery, one reported pass, named-test filter, optional nested verify ----
interface RunnerRow { pid: number; ppid: number; pgid: number; label: string; phase: string; token: string | null; lease: string | null; holder?: { token: string; roots?: number[]; rootBirths?: Record<string, string> }; code?: number | null; survivor?: number; survivorPgid?: number; survivorAlive?: boolean }
interface Runner { repo: string; base: string; log: string; artifacts: string; lease: string; rows: () => RunnerRow[] }
async function runnerFixture(hookRepo: string, nestedScript?: string, survivorMarker?: string, censusArm?: string): Promise<Runner> {
  const repo = makeRepo({ ".gitignore": "node_modules/\n", "package.json": '{"scripts":{"test":"vitest run"}}', "src/a.ts": "export const a = 1;\n" });
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
  git(repo, "add", "src/a.ts");
  git(repo, "commit", "--no-gpg-sign", "-qm", "fixture candidate");
  const artifacts = makeTestTempDir("child-env-runner-");
  const log = join(artifacts, "runner.jsonl");
  const lease = await repositoryLeasePath(repo);
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(repo, "node_modules/.bin/vitest"), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const args = process.argv.slice(2), files = ['tests/a.test.ts'];
const label = process.env.TKR_LABEL || 'gate';
const phase = args[0] === 'list' ? 'list' : args.includes('-t') ? 'named' : 'run';
const pgid = Number(cp.execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
const record = (extra) => {
  let holder; try { holder = JSON.parse(fs.readFileSync(${JSON.stringify(lease)}, 'utf8')); } catch {}
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, pgid, label, phase,
    token: process.env.${VERIFICATION_JOB_TOKEN_ENV} ?? null, lease: process.env.TICKMARKR_REPOSITORY_LEASE_TOKEN ?? null, holder, ...extra }) + '\\n');
};
if (phase === 'list') { console.log(JSON.stringify(files.map(f => ({ file: path.resolve(f) })))); process.exit(0); }
// the payload's own descendant fires the fixture hook under whatever git config the payload inherited
cp.execFileSync('git', ['-C', ${JSON.stringify(hookRepo)}, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '--no-gpg-sign', '--allow-empty', '-m', label + '-' + phase],
  { env: { ...process.env, TKR_ROW: label + '-' + phase }, stdio: 'ignore' });
record({});
if (phase === 'named') { console.log('Tests  1 passed (1)'); process.exit(0); }
const marker = ${JSON.stringify(survivorMarker ?? "")};
if (marker && label === 'nested' && phase === 'run') {
  // a descendant left alive in this shell's group with NO token, so only that group's recorded root reaches it; it
  // writes the marker if it ever sees the outer reservation released
  const s = cp.spawn(process.execPath, ['-e', 'const fs = require("node:fs"); setInterval(() => { if (!fs.existsSync(process.argv[1])) { fs.writeFileSync(process.argv[2], "outlived"); process.exit(0); } }, 10);',
    ${JSON.stringify(lease)}, marker], { stdio: 'ignore', env: { PATH: process.env.PATH } });
  s.unref();
  record({ phase: 'survivor', survivor: s.pid, survivorPgid: Number(cp.execFileSync('ps', ['-o', 'pgid=', '-p', String(s.pid)], { encoding: 'utf8' }).trim()) });
}
const nested = ${JSON.stringify(nestedScript ?? "")};
if (nested && label === 'gate') {
  const r = cp.spawnSync(process.execPath, ['--import', ${JSON.stringify(TSX)}, nested], { stdio: ['ignore', 'ignore', fs.openSync(${JSON.stringify(join(artifacts, "nested.stderr"))}, 'a')] });
  record({ phase: 'nested-exit', code: r.status });
  const s = fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l)).find(r => r.survivor);
  let survivorAlive = false; try { if (s) { process.kill(s.survivor, 0); survivorAlive = true; } } catch {}
  record({ phase: 'after-nested', survivorAlive });
  // arms ONE injected failure of the next process census (the outer job's, once this runner has exited)
  if (${JSON.stringify(censusArm ?? "")}) fs.writeFileSync(${JSON.stringify(censusArm ?? "")}, '');
}
const now = Date.now();
fs.writeFileSync(process.env.TICKMARKR_TEST_REPORT, JSON.stringify({ nonce: process.env.TICKMARKR_TEST_NONCE, requested: files,
  scheduling: Object.fromEntries(files.map(f => [f, { pool: 'forks', singleFork: false }])),
  started: Object.fromEntries(files.map(f => [f, now])),
  completed: Object.fromEntries(files.map(f => [f, { at: now, status: 'passed', tests: { passed: 1, failed: 0, skipped: 0 } }])),
  certificate: { at: now, exitCode: 0, errors: 0, diagnostics: [] } }));
`, { mode: 0o755 });
  return { repo, base, log, artifacts, lease, rows: () => read(log).trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as RunnerRow) };
}
/** A nested verify process: production evaluateManifestedTest from a parent's job payload, plus one no-job payload shell. */
const nestedVerify = (repo: string, label: string, out: string): string => {
  const script = join(makeTestTempDir("child-env-nested-"), "nested.mjs");
  const src = (rel: string) => JSON.stringify(pathToFileURL(join(ROOT, rel)).href);
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
import { evaluateManifestedTest } from ${src("src/gates/test-manifest.ts")};
import { shell } from ${src("src/run/git.ts")};
process.env.TKR_LABEL = ${JSON.stringify(label)};
const outside = await shell('printf %s "\${${VERIFICATION_JOB_TOKEN_ENV}-unset}"', ${JSON.stringify(repo)}, 60000, false);
const result = await evaluateManifestedTest('vitest run', ${JSON.stringify(repo)}, { artifactDir: ${JSON.stringify(join(out, "artifacts"))} });
writeFileSync(${JSON.stringify(join(out, "result.json"))}, JSON.stringify({ pass: result.pass, details: result.details, job: result.meta.verificationJob,
  inheritedToken: process.env.${VERIFICATION_JOB_TOKEN_ENV} ?? null, outsideJobChild: outside.stdout }));
`);
  mkdirSync(join(out, "artifacts"), { recursive: true });
  return script;
};
const jobOf = (outcome: { meta: Record<string, unknown> }) => outcome.meta.verificationJob as VerificationJobReport;

const taskOf = (acceptance: unknown[]) => validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "h" }, tasks: [{
  id: "T1", title: "ownership", goal: "ownership", shape: "implement", complexity: 3, gates: ["build", "test", "lint", "evidence", "scope"], acceptance, files: ["**"],
}] }).tasks[0]!;

describe("v2.6.8 T2 closed environment and own-git tables", () => {
  test("production gate payloads fire their fixture hook versus protected own-git output under the closed environment table", async () => {
    vi.stubEnv(COMMAND_LEASE_TOKEN_ENV, undefined);
    const op = operator();
    const hookRepo = makeRepo({ "h.txt": "h\n" });
    git(hookRepo, "config", "core.fsmonitor", op.fsmonitor); // a conflicting REPOSITORY value as well
    const f = await runnerFixture(hookRepo);
    exportOperator(op);
    const labels = () => read(op.hookWitness).split("\n").filter(Boolean).map(l => l.split(" ")[0]);

    // configured baseline build/test/lint payloads, one through a nested shell
    const baseline = await captureBaseline(f.repo, { build: commitCmd(hookRepo, "baseline-build"),
      test: `bash -c ${JSON.stringify(commitCmd(hookRepo, "baseline-nested-test"))}`, lint: commitCmd(hookRepo, "baseline-lint") });
    expect(Object.values(baseline.commands).every(c => c.exitCode === 0), JSON.stringify(baseline)).toBe(true);
    // runGates' manifested test payload
    const gate = await runGates(taskOf(["done"]), { worktree: f.repo, baseRef: f.base, author: { adapter: "fake", model: "fake", tier: "mid", channel: "sub" },
      result: { ok: true, summary: "done", deviations: [], raw: "" }, commands: { test: "vitest run" }, baseline: { commands: {} } as Baseline,
      channels: [], adapters: [], cfg: structuredClone(DEFAULT_CONFIG), artifactDir: f.artifacts });
    const testRow = gate.results.find(r => r.gate === "test")!;
    expect(testRow.pass, testRow.details).toBe(true);
    // command and named-test acceptance payloads (deterministic oracles: zero LLM spend)
    const acc = await acceptanceGate(taskOf([{ oracle: "command", command: commitCmd(hookRepo, "acceptance-command") }, { oracle: "test", test: "fixture named test" }]),
      f.repo, f.base, { adapter: {} as never, model: "none" }, undefined, { testCmd: "./node_modules/.bin/vitest run" });
    expect(acc.pass, acc.details).toBe(true);
    // every payload fired its hook; the base forces an inert hooksPath on every shell and no label appears
    expect(labels()).toEqual(expect.arrayContaining(["baseline-build", "baseline-nested-test", "baseline-lint", "gate-run", "gate-named", "acceptance-command"]));
    expect(read(op.fsWitness)).not.toBe("");

    // own git in the SAME checkout: expected commit/index/output with silent hook and fsmonitor witnesses
    rmSync(op.hookWitness, { force: true }); rmSync(op.fsWitness, { force: true });
    const head = git(hookRepo, "rev-parse", "HEAD");
    expect((await shGitOk("git config core.fsmonitor", hookRepo)).trim()).toBe("false");
    expect((await shGitOk("git config core.hooksPath", hookRepo)).trim()).toBe(INERT_HOOKS_PATH);
    await shGitOk(`${commitCmd(hookRepo, "own-direct")} && git status --porcelain`, hookRepo);
    expect(git(hookRepo, "rev-parse", "HEAD^")).toBe(head);
    expect(git(hookRepo, "log", "-1", "--format=%s")).toBe("own-direct");
    // GIT_INDEX_FILE wrapper: the scratch index is used and the real index stays byte-identical
    const index = readFileSync(join(hookRepo, ".git", "index"));
    const scratch = join(makeTestTempDir("child-env-index-"), "index");
    const tree = (await shGitOk(`GIT_INDEX_FILE='${scratch}' git read-tree HEAD && GIT_INDEX_FILE='${scratch}' git write-tree && GIT_INDEX_FILE='${scratch}' git config core.hooksPath`, hookRepo)).trim().split("\n");
    expect(tree).toEqual([git(hookRepo, "rev-parse", "HEAD^{tree}"), INERT_HOOKS_PATH]);
    expect(readFileSync(join(hookRepo, ".git", "index")).equals(index)).toBe(true);
    // pipefail/head wrapper
    expect((await shGitOk("set -o pipefail; git config core.hooksPath | head -c 100", hookRepo)).trim()).toBe(INERT_HOOKS_PATH);
    expect((await shGit("set -o pipefail; git status --porcelain | head -c 100", hookRepo)).code).toBe(0);
    expect(read(op.hookWitness), "own git hook").toBe("");
    expect(read(op.fsWitness), "own git fsmonitor").toBe("");

    // login=false payload still fires; text beginning `git` through sh/shOk is still a payload
    await shell(commitCmd(hookRepo, "payload-login-false"), hookRepo, 60_000, false);
    await sh(commitCmd(hookRepo, "payload-sh-git-text"), hookRepo);
    expect((await shOk("git config core.hooksPath", hookRepo)).trim()).toBe(op.hooks);
    expect(labels()).toEqual(["payload-login-false", "payload-sh-git-text"]);
    // the parent environment is unchanged by either kind of child
    expect(process.env.GIT_CONFIG_PARAMETERS).toBe(op.env.GIT_CONFIG_PARAMETERS);
    for (const k of PIN_KEYS) expect(process.env[k]).toBeUndefined();
  }, 240_000);

  test("production evidence review Herdr adoption and job identity protect all eight own-git reads versus a payload inferred from login or command text", async () => {
    // quoted argument text never selects another pin: a pathspec reading 'worktree add', and one whose production shq
    // escaping splits its quotes ('owner'\''s ...) around that text
    const owners = "owner's worktree add report.txt";
    const f = linkedFixture({ "package.json": '{\n  "name": "x",\n  "version": "1.0.0"\n}\n', "a.txt": "one\n", [owners]: '{\n  "version": "1.0.0"\n}\n' }, (linked) => {
      writeFileSync(join(linked, "package.json"), '{\n  "name": "x",\n  "version": "1.0.1"\n}\n');
      writeFileSync(join(linked, "b.txt"), "b\n");
      writeFileSync(join(linked, "worktree add.txt"), "wt\n");
      writeFileSync(join(linked, owners), '{\n  "version": "1.0.1"\n}\n');
      git(linked, "add", "-A");
      git(linked, "commit", "--no-gpg-sign", "-qm", "task work");
    });
    const taskHead = git(f.linked, "rev-parse", "HEAD");
    expect(git(f.hostile, "rev-parse", "refs/heads/task")).toBe(f.decoy); // a redirected ref read would see the decoy
    const hostileRefs = refMap(f.hostile);
    const op = operator();
    exportOperator(op);
    installSeam();
    // Herdr adoption: `pane list` is the herdr binary's payload; the checkout proof is own git
    const bin = join(makeTestTempDir("child-env-herdr-"), "herdr");
    const name = formatOwnedName({ role: "worker", taskId: "T1", attempt: 1, runId: "r1" });
    writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ result: { panes: [{ pane_id: "p1", label: name, cwd: f.linked, tab_id: "t1" }] } })}'\n`, { mode: 0o755 });
    const adopt = () => new HerdrDriver(bin).adopt({ id: "s1", name, cwd: f.linked });
    // the verification job's job-identity HEAD read: a raced read is refused, so the job's subject stays explicitly unknown
    const jobReport = join(makeTestTempDir("child-env-job-"), "report.json");
    const jobCommit = async () => jobOf(await withVerificationJob("vitest run", f.linked, jobReport, undefined, async () => ({ pass: true, meta: {} }))).subject.commit;

    // each of the EIGHT reads with its commondir rewritten to the decoy repository mid-child: the child itself read
    // the trusted identity, refs included (never the decoy commit or decoy.txt), and the entry still fails closed —
    // mirrorsVersionOnly's own catch turns that refusal into the strict answer `false`, the job's into a null subject
    const observed = async (run: () => Promise<unknown>, expected: unknown) => {
      const from = seen.length;
      expect(await run()).toBe(expected);
      return seen.slice(from).map(s => s.out ?? "").join("");
    };
    const rows: [RegExp, () => Promise<string>, (out: string) => void][] = [
      [/^git rev-list /, () => refusedAfter(f, () => evidenceGate(f.linked, f.base), "rev-list"), (out) => expect(out.trim()).toBe(taskHead)],
      [/^git diff --stat /, () => refusedAfter(f, () => evidenceGate(f.linked, f.base), "diff --stat"), (out) => expect(out).toMatch(/b\.txt [\s\S]*owner's worktree add report\.txt [\s\S]*package\.json/)],
      [/^git diff --name-only --no-renames -z /, () => refusedAfter(f, () => changedPaths(f.linked, f.base), "name-only"),
        (out) => expect(out.split("\0").filter(Boolean)).toEqual(["b.txt", owners, "package.json", "worktree add.txt"])],
      [/^git diff --full-index -U0 .* -- 'package\.json'$/, () => observed(() => mirrorsVersionOnly(f.linked, f.base, "package.json"), false),
        (out) => expect(out).toContain('+  "version": "1.0.1"')],
      [/^git diff --full-index '[^']+'$/, () => refusedAfter(f, () => fetchTaskDiff(f.linked, f.base), "full"), (out) => expect(out).toContain("+b")],
      [/^git diff --full-index -U0 '[^']+'$/, () => refusedAfter(f, () => fetchTaskDiff(f.linked, f.base), "U0"), (out) => expect(out).toContain("@@ -0,0 +1 @@")],
      [/^git rev-parse --show-toplevel$/, () => refusedAfter(f, adopt, "adopt"), (out) => expect(out.trim()).toBe(f.worktree)],
      [/^git rev-parse HEAD$/, () => observed(jobCommit, null), (out) => expect(out.trim()).toBe(taskHead)],
    ];
    for (const [shape, run, check] of rows) {
      armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite: directRewrite, match: shape };
      const out = await run();
      expect(seen.filter(s => shape.test(s.cmd) && s.out !== undefined).length, String(shape)).toBeGreaterThanOrEqual(1);
      check(out);
      for (const decoy of [f.decoy, "decoy.txt", "+decoy"]) expect(out, String(shape)).not.toContain(decoy);
    }
    // a quoted pathspec reading 'worktree add' selects no other pin: both review diffs of that file still read the
    // task's own change across the rewrite, never an empty or decoy diff, and still refuse after the child
    for (const [file, spec, change] of [["worktree add.txt", "'worktree add\\.txt'", "+wt"], [owners, "'owner'\\\\''s worktree add report\\.txt'", '+  "version": "1.0.1"']]) {
      for (const shape of [new RegExp(`^git diff --full-index '[^']+' -- ${spec}$`), new RegExp(`^git diff --full-index -U0 '[^']+' -- ${spec}$`)]) {
        armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite: directRewrite, match: shape };
        const out = await refusedAfter(f, () => fetchTaskDiff(f.linked, f.base, [file]), String(shape));
        expect(out, String(shape)).toContain(change);
        for (const decoy of [f.decoy, "decoy.txt", "+decoy"]) expect(out, String(shape)).not.toContain(decoy);
      }
    }
    armed = undefined;
    expect((await fetchTaskDiff(f.linked, f.base, ["worktree add.txt"])).forCap).toContain("+wt");
    // stationary: the escaped-quote filename is a version-only change read in full
    const ownersDiff = await fetchTaskDiff(f.linked, f.base, [owners]);
    expect(ownersDiff.full).toContain('+  "version": "1.0.1"');
    expect(ownersDiff.full).not.toContain("+b");
    expect(await mirrorsVersionOnly(f.linked, f.base, owners)).toBe(true);

    // stationary metadata: the same production reads return the task's own truth
    const evidence = await evidenceGate(f.linked, f.base);
    expect(evidence.pass, evidence.details).toBe(true);
    expect(evidence.commits).toEqual([taskHead]);
    expect(evidence.details).toContain("b.txt");
    expect(await changedPaths(f.linked, f.base)).toEqual(["b.txt", owners, "package.json", "worktree add.txt"]);
    expect(await mirrorsVersionOnly(f.linked, f.base, "package.json")).toBe(true);
    const diff = await fetchTaskDiff(f.linked, f.base);
    expect(diff.full).toContain("+b");
    expect(diff.full).toContain('+  "version": "1.0.1"');
    expect(diff.forCap).toContain("@@ -0,0 +1 @@");
    const restricted = (await fetchTaskDiff(f.linked, f.base, ["b.txt"])).full;
    expect(restricted).toContain("+b");
    expect(restricted).not.toContain("version");
    expect(await adopt()).toMatchObject({ id: "p1", name, cwd: f.linked });
    expect(await jobCommit()).toBe(taskHead);

    // all EIGHT reads ran through the protected entry, its default pin pinning config, objects AND refs
    const reads = seen.filter(s => s.cmd.startsWith("git ") && inside(f.worktree, s.cwd));
    for (const [shape] of rows) expect(reads.filter(s => shape.test(s.cmd)).length, String(shape)).toBeGreaterThanOrEqual(2);
    for (const s of reads) expectPinned(s, f, "own-git read");
    // inert witnesses: the hostile common config's fsmonitor and external diff never ran, its refs are unchanged
    expect(read(f.hostileFs)).toBe("");
    expect(read(f.hostileExt)).toBe("");
    expect(refMap(f.hostile)).toBe(hostileRefs);
    expect(read(op.hookWitness) + read(op.fsWitness)).toBe("");
    expect(readFileSync(join(f.gitdir, "commondir"), "utf8")).not.toContain(f.hostileCommon);

    // payload controls: neither login=false nor command text beginning `git` makes a payload own git —
    // no pin, operator config kept, and the payload follows the user's (here rewritten) metadata
    seen.length = 0;
    armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite: directRewrite };
    const commonOf = "git rev-parse --path-format=absolute --git-common-dir && git config core.hooksPath";
    for (const [why, run] of [["shell login=false", () => shell(commonOf, f.linked, 60_000, false)], ["sh git text", () => sh(commonOf, f.linked)]] as const) {
      const r = await run();
      expect(r.stdout.trim().split("\n"), why).toEqual([f.hostileCommon, op.hooks]);
    }
    for (const s of seen) for (const k of PIN_KEYS) expect(s.env[k], `${s.cmd} ${k}`).toBeUndefined();
  }, 240_000);

  test("production nested verify stamps its own job receipts and its parent reaps the nested owned shells versus an inherited token or outer members in the nested census", async () => {
    vi.stubEnv(COMMAND_LEASE_TOKEN_ENV, undefined);
    const op = operator();
    const hookRepo = makeRepo({ "h.txt": "h\n" });
    const [one, two] = [await runnerFixture(hookRepo), await runnerFixture(makeRepo({ "h.txt": "h\n" }))];
    const innerOut = makeTestTempDir("child-env-nested-out-");
    const inner = await runnerFixture(makeRepo({ "h.txt": "h\n" }));
    const outer = await runnerFixture(hookRepo, nestedVerify(inner.repo, "nested", innerOut));
    exportOperator(op);
    vi.stubEnv(VERIFICATION_JOB_TOKEN_ENV, "foreign-token");
    vi.stubEnv("TKR_UNRELATED", "kept");

    // no process-local job: the child omits the inherited foreign token; parent env and unrelated values survive
    const plain = makeTestTempDir("child-env-plain-");
    for (const run of [() => shell(`printf %s "\${${VERIFICATION_JOB_TOKEN_ENV}-unset}:$TKR_UNRELATED"`, plain, 60_000, false),
      () => shGit(`printf %s "\${${VERIFICATION_JOB_TOKEN_ENV}-unset}:$TKR_UNRELATED"`, plain)]) {
      expect((await run()).stdout).toBe("unset:kept");
    }
    expect(process.env[VERIFICATION_JOB_TOKEN_ENV]).toBe("foreign-token");

    // inside a process-local job: the payload fires its hook and its child carries only that job's fresh id;
    // two same-process jobs stay distinct
    const [a, b] = await Promise.all([one, two].map(r => evaluateManifestedTest("vitest run", r.repo, { artifactDir: r.artifacts })));
    expect(a!.pass, a!.details).toBe(true); expect(b!.pass, b!.details).toBe(true);
    const ids = [jobOf(a!).id, jobOf(b!).id];
    expect(new Set(ids).size).toBe(2);
    for (const [i, r] of [one, two].entries()) {
      const run = r.rows().find(row => row.phase === "run")!;
      expect(run.token).toBe(ids[i]);
      expect(jobOf([a, b][i]!).phases.some(p => p.phase === "first-pass" && [run.pid, run.ppid].includes(p.pid!))).toBe(true);
    }
    expect(read(op.hookWitness)).toContain("gate-run");
    expect(process.env[VERIFICATION_JOB_TOKEN_ENV]).toBe("foreign-token");

    // nested verify launched by a parent's job payload: its own job, its own receipts, its own hook firing
    rmSync(op.hookWitness, { force: true });
    const parent = await evaluateManifestedTest("vitest run", outer.repo, { artifactDir: outer.artifacts });
    expect(parent.pass, parent.details).toBe(true);
    const parentId = jobOf(parent).id;
    expect(outer.rows().find(row => row.phase === "nested-exit")?.code, read(join(outer.artifacts, "nested.stderr"))).toBe(0);
    const nested = JSON.parse(readFileSync(join(innerOut, "result.json"), "utf8")) as { pass: boolean; details: string; job: VerificationJobReport; inheritedToken: string; outsideJobChild: string };
    expect(nested.pass, nested.details).toBe(true);
    expect(nested.inheritedToken).toBe(parentId); // the nested process itself inherited the parent's token...
    expect(nested.outsideJobChild).toBe("unset"); // ...but never forwards it to a child outside its own job
    expect(nested.job.id).not.toBe(parentId);
    expect(nested.job.id).not.toBe("foreign-token");
    const nestedRun = inner.rows().find(row => row.phase === "run")!;
    expect(nestedRun.token).toBe(nested.job.id);
    expect(nested.job.phases.map(p => p.phase)).toEqual(["discovery", "first-pass"]);
    const sidecar = readdirSync(join(innerOut, "artifacts")).filter(n => n.endsWith(".job.json")).map(n => JSON.parse(readFileSync(join(innerOut, "artifacts", n), "utf8")) as VerificationJobReport);
    expect(new Set(sidecar.map(j => j.id))).toEqual(new Set([nested.job.id]));
    expect(outer.rows().find(row => row.phase === "run")!.token).toBe(parentId);
    expect(read(op.hookWitness)).toContain("nested-run");
    vi.unstubAllEnvs();
    vi.stubEnv(COMMAND_LEASE_TOKEN_ENV, undefined);
    // the outer job owns its reservation, or reuses an enclosing withRepositoryLease one: either way that reservation's
    // in-process owner must end the nested survivor before it releases, with no later owner shell refreshing its roots —
    // also when the outer job's own census FAILS once (an injected ps failure), which must not skip carrying the
    // nested groups back to that owner
    const realPs = execFileSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).trim();
    for (const [wrapped, censusFails] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      const out = makeTestTempDir("child-env-reap-");
      // the nested verify runs in the SAME repository, so it reenters the parent's reservation
      const scriptDir = makeTestTempDir("child-env-reap-script-");
      const placeholder = join(scriptDir, "nested.mjs"), marker = join(scriptDir, "survivor.marker");
      const arm = join(scriptDir, "census.arm");
      const f = await runnerFixture(hookRepo, placeholder, marker, censusFails ? arm : undefined);
      writeFileSync(placeholder, readFileSync(nestedVerify(f.repo, "nested", out), "utf8"));
      exportOperator(op);
      if (censusFails) {
        // the full process census fails exactly once after the outer runner armed it; every other ps is the real one
        const bin = join(scriptDir, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "ps"), `#!/bin/sh\nif [ "$1" = eww ] && [ "$2" = -A ] && mv '${arm}' '${arm}.used' 2>/dev/null; then echo 'injected census failure' >&2; exit 1; fi\nexec '${realPs}' "$@"\n`, { mode: 0o755 });
        vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
      }

      const evaluate = () => evaluateManifestedTest("vitest run", f.repo, { artifactDir: f.artifacts });
      const parent = wrapped ? await withRepositoryLease(f.repo, evaluate) : await evaluate();
      expect(parent.pass, parent.details).toBe(!censusFails);
      if (censusFails) {
        expect(parent.details).toMatch(/injected census failure/);
        expect(existsSync(`${arm}.used`)).toBe(true);
      }
      const parentJob = jobOf(parent);
      expect(parentJob.state).toBe(censusFails ? "failed" : "completed");
      expect(parentJob.reservationReused ?? false, String(wrapped)).toBe(wrapped);
      const rows = f.rows();
      const outerRun = rows.find(row => row.label === "gate" && row.phase === "run")!;
      const nestedRun = rows.find(row => row.label === "nested" && row.phase === "run")!;
      const nested = JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as { pass: boolean; details: string; job: VerificationJobReport };
      const survivor = rows.find(row => row.phase === "survivor")!;
      owned.push(survivor.survivor!);
      // the nested census counted only its own members: it completed and reaped while the outer runner — alive,
      // carrying the parent's token — waited for it and outlived it (an outer member in that census never ceases)
      expect(rows.find(row => row.phase === "nested-exit")?.code, read(join(f.artifacts, "nested.stderr"))).toBe(0);
      expect(nested.pass, nested.details).toBe(true);
      expect(nested.job.state).toBe("completed");
      expect(nested.job.reapedAt).toBeTypeOf("number");
      // ...and left its token-less descendant ALIVE in the nested shell's group: after the nested job completed, the
      // outer runner still saw it running, so nothing but the outer owner remains to end it
      expect(rows.find(row => row.phase === "after-nested")).toMatchObject({ pid: outerRun.pid, survivorAlive: true });
      expect(survivor.survivorPgid).toBe(nestedRun.pgid);
      expect(outerRun.token).toBe(parentJob.id);
      expect(nestedRun.token).toBe(nested.job.id);
      expect(nestedRun.token).not.toBe(parentJob.id);
      expect(read(op.hookWitness)).toContain("nested-run");
      // the outer owner still owns the nested shells: they ran under the parent's reservation capability and the
      // reservation recorded their birth-checked groups beside the outer member's
      expect(nested.job.reservation?.token).toBe(parentJob.reservation?.token);
      expect(nestedRun.lease).toBe(parentJob.reservation?.token);
      expect(nestedRun.holder?.token).toBe(parentJob.reservation?.token);
      expect(nestedRun.holder?.roots).toEqual(expect.arrayContaining([outerRun.pgid, nestedRun.pgid]));
      expect(nestedRun.holder?.rootBirths?.[nestedRun.pgid]).toBeTruthy();
      // the outer owner terminated that descendant through the recorded group BEFORE releasing the reservation: it is
      // dead and never saw the lease vanish (with the outer reap dropped it outlives the release and writes the marker)
      expect(alive(survivor.survivor!)).toBe(false);
      expect(read(marker)).toBe("");
      for (const row of rows) expect(alive(row.pid), `${row.label} ${row.phase} ${row.pid}`).toBe(false);
      expect(existsSync(f.lease)).toBe(false);
    }
  }, 480_000);

  test("production shGit and shGitOk pin the ref store across a between-check-and-spawn commondir rewrite under every inherited git configuration versus a decoy read or a hostile ref write", async () => {
    const f = linkedFixture();
    const hostileRefs = refMap(f.hostile);
    const realRefs = () => refMap(f.repo);
    installSeam();
    // writers: the test itself, a live writer process, and a surviving descendant of an earlier payload shell
    const writerJs = join(makeTestTempDir("child-env-writer-"), "writer.cjs");
    // every handoff file appears whole (written aside, then renamed): a reader polling under load never parses a
    // partial request or a partial pid
    writeFileSync(writerJs, `const fs = require('node:fs'); const dir = process.argv[2]; let n = 0;
fs.writeFileSync(dir + '/pid.tmp', String(process.pid)); fs.renameSync(dir + '/pid.tmp', dir + '/pid');
setInterval(() => { const go = dir + '/go-' + n; if (!fs.existsSync(go)) return;
  const [target, content] = JSON.parse(fs.readFileSync(go, 'utf8')); fs.writeFileSync(target, content); fs.writeFileSync(dir + '/done-' + n, ''); n++; }, 5);
`);
    const viaProcess = (dir: string) => { let n = 0; return (target: string, content: string) => {
      writeFileSync(join(dir, `go-${n}.tmp`), JSON.stringify([target, content])); renameSync(join(dir, `go-${n}.tmp`), join(dir, `go-${n}`));
      waitSync(join(dir, `done-${n}`)); n++; }; };
    const liveDir = makeTestTempDir("child-env-live-"), survivorDir = makeTestTempDir("child-env-survivor-");
    const live = spawn(process.execPath, [writerJs, liveDir], { stdio: "ignore" });
    owned.push(live.pid!);
    await shell(`'${process.execPath}' -e "require('child_process').spawn(process.execPath, ['${writerJs}', '${survivorDir}'], { detached: true, stdio: 'ignore' }).unref()"`, makeTestTempDir("child-env-nonrepo-"), 60_000, false);
    await until(() => existsSync(join(liveDir, "pid")) && existsSync(join(survivorDir, "pid")), "writers ready");
    const survivor = Number(readFileSync(join(survivorDir, "pid"), "utf8"));
    owned.push(survivor);
    expect(alive(survivor)).toBe(true); // it outlived the payload shell that launched it

    writeFileSync(join(f.linked, "sub", "b.txt"), "two changed\n");
    const rawStatus = git(f.linked, "status", "--porcelain");
    const realHead = git(f.linked, "rev-parse", "HEAD");
    expect(git(f.hostile, "rev-parse", "refs/heads/task")).toBe(f.decoy); // a redirected ref read would see the decoy
    // the DEFAULT entry pins the ref store (no caller declares anything): each own-git child runs ACROSS the rewrite and
    // what it printed is the REAL repository — HEAD, branch, status, diff, index — twice, never the decoy; its ref WRITES
    // land only in the trusted store whatever the inherited operator or outer-harness git configuration says; and the
    // entry still refuses that result after the child, naming commondir. The base and run 1's default entry print the
    // decoy here, and run 1's ref-write guard is switched off by an inherited hook disable.
    const hostilePacked = () => read(join(f.hostileCommon, "packed-refs"));
    const packedBefore = hostilePacked();
    const inherited: [string, Record<string, string>][] = [
      ["no inherited config", {}],
      ["inherited GIT_CONFIG_PARAMETERS hook disable", { GIT_CONFIG_PARAMETERS: "'hook.reference-transaction.enabled=false'" }],
      ["inherited GIT_CONFIG_COUNT hook disable", { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "hook.reference-transaction.enabled", GIT_CONFIG_VALUE_0: "false" }],
      ["inherited hostile ref backend", { GIT_REFERENCE_BACKEND: `files://${f.hostileCommon}`, GIT_REF_STORAGE_FORMAT: `files://${f.hostileCommon}` }],
    ];
    const writers = [["test writer", directRewrite], ["live writer", viaProcess(liveDir)], ["surviving descendant", viaProcess(survivorDir)]] as const;
    for (const [why, rewrite] of writers) {
      armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite };
      seen.length = 0;
      const before = realRefs();
      for (const pass of [1, 2]) {
        const tag = `${why} read ${pass}`;
        expect(await refusedAfter(f, () => shGitOk("git rev-parse --path-format=absolute --git-common-dir", f.linked), tag)).toBe(`${f.common}\n`);
        expect((await refusedAfter(f, () => shGitOk("git rev-parse HEAD refs/heads/task", f.linked), tag)).trim().split("\n"), tag).toEqual([realHead, realHead]);
        expect((await refusedAfter(f, () => shGit("git rev-parse refs/heads/task HEAD", f.linked), tag)).trim().split("\n"), tag).toEqual([realHead, realHead]);
        expect((await refusedAfter(f, () => gitHead(f.linked), tag)).trim(), tag).toBe(realHead);
        expect((await refusedAfter(f, () => shGitOk("git status --porcelain", f.linked), tag)).trim(), tag).toBe(rawStatus);
        expect((await refusedAfter(f, () => shGit("git diff --name-only", f.linked), tag)).trim(), tag).toBe("sub/b.txt");
      }
      await refusedAfter(f, () => shGitOk("git add b.txt", join(f.linked, "sub")), why); // cwd below the worktree root
      expect(git(f.linked, "diff", "--cached", "--name-only"), why).toBe("sub/b.txt"); // staged in the REAL index
      expect((await refusedAfter(f, () => shGitOk("git rev-parse --show-prefix", join(f.linked, "sub")), why)).trim(), why).toBe("sub/");
      git(f.linked, "reset", "-q");
      for (const [config, env] of inherited) {
        const tag = `${why}, ${config}`;
        const slug = tag.replace(/\W+/g, "-");
        for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
        // update-ref (create) with a production-shq reflog message holding an escaped quote and the words 'worktree add'
        const probe = `refs/tickmarkr/probe-${slug}`;
        await refusedAfter(f, () => shGitOk(`git update-ref --create-reflog -m ${shq("owner's worktree add receipt")} ${probe} ${f.base}`, f.linked), tag);
        expect(git(f.repo, "rev-parse", probe), tag).toBe(f.base);
        expect(git(f.repo, "reflog", "-1", "--format=%gs", probe), tag).toBe("owner's worktree add receipt");
        git(f.repo, "update-ref", "-d", probe);
        // a commit through both wrappers: HEAD's branch gains exactly that commit, in the trusted store only
        for (const run of [(c: string) => shGitOk(c, f.linked), (c: string) => shGit(c, f.linked)]) {
          await refusedAfter(f, () => run("git -c user.name=t -c user.email=t@t.invalid commit -q --no-gpg-sign --allow-empty -m raced"), tag);
          expect(git(f.repo, "rev-parse", "refs/heads/task^"), tag).toBe(realHead);
          expect(git(f.repo, "log", "-1", "--format=%s", "refs/heads/task"), tag).toBe("raced");
          git(f.repo, "update-ref", "refs/heads/task", realHead);
        }
        // branch -m of a branch only the trusted store holds, and pack-refs
        git(f.repo, "branch", "-q", `m-${slug}`, f.base);
        await refusedAfter(f, () => shGitOk(`git branch -m m-${slug} n-${slug}`, f.linked), tag);
        expect(git(f.repo, "rev-parse", `refs/heads/n-${slug}`), tag).toBe(f.base);
        expect(() => git(f.repo, "rev-parse", "--verify", "-q", `refs/heads/m-${slug}`), tag).toThrow();
        git(f.repo, "branch", "-q", "-D", `n-${slug}`);
        await refusedAfter(f, () => shGitOk("git pack-refs --all", f.linked), tag);
        vi.unstubAllEnvs();
        expect(refMap(f.hostile), tag).toBe(hostileRefs);
        expect(hostilePacked(), tag).toBe(packedBefore);
      }
      const own = seen.filter(s => inside(f.worktree, s.cwd));
      expect(own.length, why).toBeGreaterThan(30);
      for (const s of own) expectPinned(s, f, why);
      expect(realRefs(), why).toBe(before);
      expect(refMap(f.hostile), why).toBe(hostileRefs);
      expect(read(f.hostileFs) + read(f.hostileExt), why).toBe("");
    }

    // a git that does not honour the ref-store pin (it drops GIT_REFERENCE_BACKEND, as every git before 2.54 does) still
    // runs — refusing it would refuse own git in every linked checkout on most installed gits (D-1484) — with the path
    // pins and no ref-store pin, after one warning naming git 2.54, and its result across the rewrite is still refused
    // by the post-exit recheck; a git that honours it (2.54+) reads the real HEAD across the rewrite
    const hostGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8", env: rawEnv() }).trim();
    const fakeBin = makeTestTempDir("child-env-fakegit-");
    writeFileSync(join(fakeBin, "git"), `#!/bin/sh\nunset GIT_REFERENCE_BACKEND\nexec '${hostGit}' "$@"\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${fakeBin}:${process.env.PATH}`);
    const warned = vi.spyOn(console, "error").mockImplementation(() => {});
    armed = undefined; // untouched metadata: own git works on such a git and reads the real HEAD
    expect((await gitHead(f.linked)).trim(), "a git that drops the ref-store pin, no rewrite").toBe(realHead);
    armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite: directRewrite };
    seen.length = 0;
    await refusedAfter(f, () => shGitOk("git rev-parse HEAD", f.linked), "a git that drops the ref-store pin");
    expect(seen).toHaveLength(1);
    expect(pinOf(seen[0]!.env)).toEqual({ GIT_DIR: f.gitdir, GIT_COMMON_DIR: f.common, GIT_WORK_TREE: f.worktree,
      GIT_REFERENCE_BACKEND: undefined, GIT_REF_STORAGE_FORMAT: undefined });
    expect(warned.mock.calls.flat().join("\n")).toContain("needs git 2.54 or newer");
    warned.mockRestore();
    vi.unstubAllEnvs();
    // the version decides the expectation independently of the production probe: Apple Git on macOS 26 predates 2.54
    const honours = (bin: string) => {
      const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(execFileSync(bin, ["--version"], { encoding: "utf8" })) ?? []).slice(1).map(Number);
      return major > 2 || (major === 2 && minor >= 54);
    };
    for (const bin of [hostGit, "/usr/bin/git"].filter(b => existsSync(b))) {
      const dir = makeTestTempDir("child-env-realgit-");
      symlinkSync(bin, join(dir, "git"));
      vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
      const out = (await refusedAfter(f, () => gitHead(f.linked), bin)).trim();
      if (honours(bin)) expect(out, bin).toBe(realHead);
      vi.unstubAllEnvs();
    }
    armed = undefined;
    expect(refMap(f.hostile)).toBe(hostileRefs);

    // a commondir REMOVED mid-child (then restored): git decides "linked" from that file's presence alone, so the child
    // takes the private view as its repository — and every HEAD-relative write it tries (commit through both wrappers,
    // merge, reset, checkout -B, update-ref HEAD) cannot take the view's HEAD lock: the main checkout's branch, its HEAD
    // and the task branch are all unchanged, and the entry still refuses each result by name
    git(f.repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "main moves");
    const mainHead = git(f.repo, "rev-parse", "HEAD"), mainHeadFile = read(join(f.common, "HEAD"));
    armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite: (target) => rmSync(target) };
    seen.length = 0;
    const raced = "-c user.name=t -c user.email=t@t.invalid";
    for (const [why, run] of [
      ["shGitOk commit", () => shGitOk(`git ${raced} commit -q --no-gpg-sign --allow-empty -m raced`, f.linked)],
      ["shGit commit", () => shGit(`git ${raced} commit -q --no-gpg-sign --allow-empty -m raced`, f.linked)],
      ["merge", () => shGitOk(`git ${raced} merge --no-ff --no-gpg-sign -m raced ${shq(f.decoy)}`, f.linked)],
      ["reset", () => shGitOk(`git reset -q --soft ${shq(f.base)}`, f.linked)],
      ["checkout -B", () => shGitOk(`git checkout -q -B removed-${Date.now()} ${shq(f.base)}`, f.linked)],
      ["update-ref HEAD", () => shGitOk(`git update-ref HEAD ${shq(f.base)}`, f.linked)],
    ] as const) {
      await refusedAfter(f, run, why);
      expect(git(f.repo, "rev-parse", "refs/heads/main"), why).toBe(mainHead);
      expect(read(join(f.common, "HEAD")), why).toBe(mainHeadFile);
      expect(git(f.repo, "rev-parse", "refs/heads/task"), why).toBe(realHead);
      expect(git(f.linked, "rev-parse", "HEAD"), why).toBe(realHead);
    }
    for (const s of seen) expectPinned(s, f, "removed commondir");
    for (const b of git(f.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/removed-*").split("\n").filter(Boolean)) git(f.repo, "branch", "-q", "-D", b);
    rmSync(join(f.linked, "decoy.txt"), { force: true }); // a refused merge may have written its tree before its HEAD lock
    git(f.linked, "reset", "-q");
    expect(git(f.linked, "status", "--porcelain")).toBe(rawStatus);
    git(f.repo, "reset", "-q", "--hard", f.base);
    armed = undefined;

    // explicit environment conflicts: an inherited GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE or ref store never redirects own git
    vi.stubEnv("GIT_DIR", f.hostileCommon); vi.stubEnv("GIT_COMMON_DIR", f.hostileCommon); vi.stubEnv("GIT_WORK_TREE", f.hostile);
    vi.stubEnv("GIT_REFERENCE_BACKEND", `files://${f.hostileCommon}`); vi.stubEnv("GIT_REF_STORAGE_FORMAT", `files://${f.hostileCommon}`);
    seen.length = 0;
    for (const own of [{}, { createsWorktree: "branch" }] as const) {
      seen.length = 0;
      expect((await shGitOk("git rev-parse --path-format=absolute --git-common-dir --show-toplevel HEAD", f.linked, own)).trim().split("\n"))
        .toEqual([f.common, f.worktree, realHead]);
      expectPinned(seen[0]!, f, "explicit conflicts");
    }
    // the add path too: a branch-creating createWorktree under the inherited hostile ref store (stationary metadata)
    // creates its branch in the trusted repository only, its child's ref store pinned over the inherited one
    seen.length = 0;
    const inheritedDir = await createWorktree(f.linked, "c-inherited", f.base);
    expect(seen.map(s => s.cmd).filter(c => /^git worktree add /.test(c))).toHaveLength(1);
    for (const s of seen.filter(s => /^git worktree add /.test(s.cmd))) expectPinned(s, f, "inherited ref store");
    vi.unstubAllEnvs();
    expect(git(f.repo, "rev-parse", "refs/heads/c-inherited")).toBe(f.base);
    expect(git(inheritedDir, "symbolic-ref", "HEAD")).toBe("refs/heads/c-inherited");
    expect(refMap(f.hostile)).toBe(hostileRefs);
    await removeWorktree(f.repo, inheritedDir);
    git(f.repo, "branch", "-q", "-D", "c-inherited");

    // a pre-spawn EAGAIN retry re-derives authority: a clean retry is pinned afresh; a retry whose metadata
    // turned hostile before the second check is refused naming commondir — no cached pin, no cached verdict
    seen.length = 0;
    refuseOnce = { match: "rev-parse --absolute-git-dir" };
    expect((await shGitOk("git rev-parse --absolute-git-dir", f.linked)).trim()).toBe(f.gitdir);
    expect(seen.length).toBe(2);
    for (const s of seen) expectPinned(s, f, "EAGAIN retry");
    const commondir = join(f.gitdir, "commondir");
    const original = readFileSync(commondir, "utf8");
    refuseOnce = { match: "rev-parse --absolute-git-dir", onRefuse: () => writeFileSync(commondir, `${f.hostileCommon}\n`) };
    await expect(shGitOk("git rev-parse --absolute-git-dir", f.linked)).rejects.toMatchObject({ name: "GitTrustRefusal", path: commondir });
    writeFileSync(commondir, original);

    // before-spawn hostile metadata still refuses naming the path (enabled + present config.worktree included);
    // the AFTER-check enabled config.worktree residual is NOT claimed closed here
    armed = undefined;
    writeFileSync(commondir, `${f.hostileCommon}\n`);
    for (const run of [() => shGit("git status", f.linked), () => shGitOk("git status", f.linked)]) {
      await expect(run()).rejects.toMatchObject({ name: "GitTrustRefusal", path: commondir });
    }
    writeFileSync(commondir, original);
    git(f.repo, "config", "extensions.worktreeConfig", "true");
    writeFileSync(join(f.gitdir, "config.worktree"), "[core]\n\tfsmonitor = false\n");
    await expect(shGitOk("git status", f.linked)).rejects.toBeInstanceOf(GitTrustRefusal);
    await expect(shGitOk("git status", f.linked)).rejects.toMatchObject({ path: join(f.gitdir, "config.worktree") });
    rmSync(join(f.gitdir, "config.worktree"));
    git(f.repo, "config", "extensions.worktreeConfig", "false");

    // a commondir that is a SYMBOLIC LINK (even to the expected bytes) is refused before any child spawns: its
    // target could be rewritten hostile and restored mid-child without moving the link's own stamp — for reads,
    // the quoted-'worktree add' review pathspec, a 'worktree add' reflog write and branch-creating worktree creation
    const linkTarget = join(makeTestTempDir("child-env-link-"), "commondir");
    writeFileSync(linkTarget, original);
    rmSync(commondir); symlinkSync(linkTarget, commondir);
    seen.length = 0;
    for (const run of [() => shGitOk("git status", f.linked), () => fetchTaskDiff(f.linked, f.base, ["**"]),
      () => shGitOk(`git update-ref -m 'worktree add' refs/heads/task ${f.base}`, f.linked), () => createWorktree(f.linked, "c-link", f.base)]) {
      await expect(run()).rejects.toMatchObject({ name: "GitTrustRefusal", path: commondir });
    }
    expect(seen).toEqual([]);
    rmSync(commondir); writeFileSync(commondir, original);
    expect(() => git(f.repo, "rev-parse", "--verify", "-q", "refs/heads/c-link")).toThrow();
    expect(git(f.repo, "rev-parse", "refs/heads/task")).toBe(realHead);
    expect(refMap(f.hostile)).toBe(hostileRefs);

    // controls: an ordinary checkout and a non-repository get no NEW pin; a payload in the linked checkout gets none
    seen.length = 0;
    await shGitOk("git status --porcelain", f.repo);
    await shGit("echo plain", makeTestTempDir("child-env-plain-"));
    await sh("git status --porcelain", f.linked);
    await shell("echo payload", makeTestTempDir("child-env-plain-"), 60_000, false);
    expect(seen.length).toBe(4);
    for (const s of seen) for (const k of PIN_KEYS) expect(s.env[k], `${s.cmd} ${k}`).toBeUndefined();

    // ---- pin compatibility: the pin itself must not break ordinary own-git work (stationary metadata) ----
    armed = undefined;
    // same-repository git -C into a linked subdirectory; -C gives no authority to leave the pinned checkout
    seen.length = 0;
    expect((await shGitOk("git -C sub status --porcelain", f.linked)).trim()).toBe(git(join(f.linked, "sub"), "status", "--porcelain"));
    expect((await shGitOk("git -C sub rev-parse --show-prefix", f.linked)).trim()).toBe("sub/");
    expect((await shGitOk(`git -C '${f.repo}' rev-parse --show-toplevel`, f.linked)).trim()).toBe(f.worktree);
    for (const s of seen) expect(s.env.GIT_WORK_TREE).toBe(f.worktree);

    // nothing is inferred from words: path arguments named worktree and add, quoted or not, keep their meaning — each
    // exactly as raw git runs it, under the default pin
    writeFileSync(join(f.linked, "worktree"), "w\n");
    writeFileSync(join(f.linked, "add"), "a\n");
    await shGitOk("git add worktree add", f.linked);
    expect(git(f.linked, "diff", "--cached", "--name-only").split("\n")).toEqual(["add", "worktree"]);
    expect((await shGitOk("git diff --cached --name-only -- 'worktree' 'add'", f.linked)).trim().split("\n")).toEqual(["add", "worktree"]);
    git(f.linked, "commit", "-q", "--no-gpg-sign", "-m", "paths named worktree and add");
    const wordsHead = git(f.linked, "rev-parse", "HEAD");
    expect((await shGitOk("git diff --name-only HEAD^ HEAD -- worktree add", f.linked)).trim().split("\n")).toEqual(["add", "worktree"]);
    writeFileSync(join(f.linked, "worktree"), "w2\n");
    expect((await shGitOk("git diff --name-only -- worktree add", f.linked)).trim()).toBe("worktree");
    git(f.linked, "checkout", "-q", "--", "worktree");
    expect(git(f.linked, "rev-parse", "HEAD^")).toBe(realHead);
    git(f.linked, "reset", "-q", "--keep", realHead); // drops only those two paths; sub/b.txt's edit stays
    expect(wordsHead).not.toBe(realHead);

    // default callers that run in LINKED checkouts, driven through the production entry from the linked root: the
    // daemon's worktree-recreation replay and preserved ref, its status/log/show/diff/ls-files/rev-parse/merge-base reads
    const side = git(f.repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "side");
    git(f.repo, "update-ref", "refs/heads/side", side);
    writeFileSync(join(f.repo, "side.txt"), "side\n");
    git(f.repo, "add", "side.txt");
    git(f.repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-gpg-sign", "-m", "side file");
    const sideFile = git(f.repo, "rev-parse", "HEAD");
    git(f.repo, "reset", "-q", "--hard", f.base);
    seen.length = 0;
    await shGitOk(`git -c user.name=t -c user.email=t@t.invalid cherry-pick --no-gpg-sign ${shq(sideFile)}`, f.linked);
    const replayed = git(f.repo, "rev-parse", "refs/heads/task");
    expect(git(f.repo, "rev-parse", "refs/heads/task^")).toBe(realHead);
    expect(git(f.repo, "show", "refs/heads/task:side.txt")).toBe("side");
    await shGitOk(`git update-ref ${shq(`refs/tickmarkr/preserved/${replayed}`)} ${shq(replayed)}`, f.linked);
    expect(git(f.repo, "rev-parse", `refs/tickmarkr/preserved/${replayed}`)).toBe(replayed);
    expect((await shGitOk("git log -1 --format=%H", f.linked)).trim()).toBe(replayed);
    expect((await shGitOk("git show -s --format=%H HEAD", f.linked)).trim()).toBe(replayed);
    expect((await shGitOk("git ls-files side.txt", f.linked)).trim()).toBe("side.txt");
    expect((await shGitOk(`git merge-base HEAD ${shq(side)}`, f.linked)).trim()).toBe(f.base);
    expect((await shGitOk("git diff --name-only HEAD^ HEAD", f.linked)).trim()).toBe("side.txt");
    expect((await shGitOk("git status --porcelain", f.linked)).trim()).toBe(rawStatus);
    for (const s of seen) expectPinned(s, f, "default linked callers");
    git(f.repo, "update-ref", "-d", `refs/tickmarkr/preserved/${replayed}`);
    git(f.repo, "update-ref", "-d", "refs/heads/side");
    git(f.linked, "reset", "-q", "--keep", realHead);
    expect(refMap(f.hostile)).toBe(hostileRefs);

    // ensureIntegration and mergeTask with ordinary-main and linked-integration checkouts
    git(f.linked, "commit", "-qam", "task work", "--no-gpg-sign");
    const gated = git(f.linked, "rev-parse", "HEAD");
    for (const root of [f.repo, f.linked]) {
      const branch = `tickmarkr/run-${root === f.repo ? "main" : "linked"}`;
      const intWt = await ensureIntegration(root, branch, f.base);
      expect(await ensureIntegration(root, branch, f.base)).toBe(intWt); // reuse
      expect(git(intWt, "rev-parse", "HEAD")).toBe(f.base);
      const intArmed = { gitdir: realpathSync(git(intWt, "rev-parse", "--absolute-git-dir")), worktree: realpathSync(intWt) };
      seen.length = 0;
      expect(await mergeTask(intWt, "task", `merge ${branch}`, f.base)).toEqual({ ok: false, tipMoved: { gatedCommit: f.base, branchTip: gated } });
      expect(await mergeTask(intWt, "task", `merge ${branch}`, gated)).toEqual({ ok: true });
      expect(git(intWt, "rev-parse", "HEAD^2")).toBe(gated);
      expect(git(intWt, "rev-parse", "HEAD^{tree}")).toBe(git(f.repo, "rev-parse", `${gated}^{tree}`));
      expect(git(f.repo, "rev-parse", `refs/heads/${branch}`)).toBe(git(intWt, "rev-parse", "HEAD"));
      expect(seen.length).toBeGreaterThan(0);
      for (const s of seen) {
        // mergeTask's merge and reads carry the default pin, ref store included, in the linked integration checkout
        expectPinned(s, { gitdir: intArmed.gitdir, common: f.common, worktree: intArmed.worktree }, "linked integration");
      }
    }

    // preserveWorktree and getWorktreeTree GIT_INDEX_FILE wrappers keep the caller-owned scratch index
    writeFileSync(join(f.linked, "a.txt"), "dirty\n");
    writeFileSync(join(f.linked, "untracked.txt"), "loose\n");
    const indexBefore = readFileSync(join(f.gitdir, "index"));
    const scratch = join(makeTestTempDir("child-env-tree-"), "index");
    const env = rawEnv({ GIT_INDEX_FILE: scratch });
    execFileSync("git", ["read-tree", "HEAD"], { cwd: f.linked, env });
    execFileSync("git", ["add", "-A", "--", "."], { cwd: f.linked, env });
    const expectedTree = execFileSync("git", ["write-tree"], { cwd: f.linked, env, encoding: "utf8" }).trim();
    seen.length = 0;
    expect(await getWorktreeTree(f.linked)).toBe(expectedTree);
    for (const s of seen) { expectPinned(s, f, "cache index wrapper"); expect(s.env.GIT_INDEX_FILE).toBeUndefined(); }
    expect(seen.filter(s => s.cmd.startsWith("GIT_INDEX_FILE=")).length).toBeGreaterThanOrEqual(3);
    seen.length = 0;
    const ref = await preserveWorktree(f.linked);
    expect(ref).toMatch(/^refs\/tickmarkr\/preserved\/[0-9a-f]{40}$/);
    expect(git(f.repo, "rev-parse", `${ref}^{tree}`)).toBe(expectedTree);
    expect(git(f.repo, "show", `${ref}:untracked.txt`)).toBe("loose");
    expect(readFileSync(join(f.gitdir, "index")).equals(indexBefore)).toBe(true);
    for (const s of seen) { expectPinned(s, f, "index wrapper"); expect(s.env.GIT_INDEX_FILE).toBeUndefined(); }
    expect(seen.filter(s => s.cmd.startsWith("GIT_INDEX_FILE=")).length).toBeGreaterThanOrEqual(3);
    // across a rewrite at its shared-ref write (the default pin), preserveWorktree refuses — and the recovery ref that write made
    // exists in the TRUSTED repository, never the hostile one
    writeFileSync(join(f.linked, "untracked.txt"), "looser\n");
    armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite: directRewrite, match: /^git update-ref / };
    await expect(preserveWorktree(f.linked)).rejects.toMatchObject({ name: "GitTrustRefusal", path: commondir });
    armed = undefined;
    const preserved = git(f.repo, "for-each-ref", "--format=%(refname)", "refs/tickmarkr/preserved/").split("\n");
    expect(preserved).toHaveLength(2);
    expect(git(f.repo, "show", `${preserved.find(r => r !== ref)}:untracked.txt`)).toBe("looser");
    expect(git(f.hostile, "for-each-ref", "refs/tickmarkr/")).toBe("");

    // nothing leaked into the parent, and the hostile directory never moved
    for (const k of PIN_KEYS) expect(process.env[k]).toBeUndefined();
    expect(refMap(f.hostile)).toBe(hostileRefs);
    expect(read(f.hostileFs) + read(f.hostileExt)).toBe("");
  }, 240_000);
  test("production baseline recapture and standalone verify create their detached base checkouts from a linked root through the declared worktree capability versus a stubbed invalid HEAD or a hostile-store checkout", async () => {
    // a daemon repository whose LINKED checkout is the repository root (the Orca-workspace layout), its main HEAD moved
    // past the linked HEAD; payload gate commands log the HEAD of whatever checkout they run in
    const headLog = join(makeTestTempDir("child-env-headlog-"), "heads");
    const gates = { build: `git rev-parse HEAD >> ${shq(headLog)}`, lint: "true" };
    const heads = () => read(headLog).trim().split("\n").filter(Boolean);
    const { repo, fake } = setupRepo([T("T1", { status: "human", files: ["work.txt"], gates: ["build", "test", "lint", "evidence", "scope"] })], { tasks: {} }, stringify({ gates }));
    const f = linkedFixture(undefined, (linked) => {
      writeFileSync(join(linked, "work.txt"), "work\n");
      git(linked, "add", "work.txt");
      git(linked, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-gpg-sign", "-m", "linked work");
    }, repo);
    cpSync(join(repo, ".tickmarkr"), join(f.linked, ".tickmarkr"), { recursive: true });
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "main moves");
    const linkedHead = git(f.linked, "rev-parse", "HEAD");
    const mainHead = git(repo, "rev-parse", "HEAD");
    expect(linkedHead).not.toBe(mainHead);
    const commondir = join(f.gitdir, "commondir");
    const hostileRefs = refMap(f.hostile);
    const hostileWorktrees = () => existsSync(join(f.hostileCommon, "worktrees")) ? readdirSync(join(f.hostileCommon, "worktrees")) : [];
    // the trusted store's registered checkouts besides each daemon run's own integration checkout
    const trustedWorktrees = () => readdirSync(join(f.common, "worktrees")).filter(n => !n.startsWith("tickmarkr-run-")).sort();
    const noStub = (why: string) => {
      expect(existsSync(join(f.common, "refs", "heads", ".invalid")), why).toBe(false);
      expect(refMap(f.hostile), why).toBe(hostileRefs);
      expect(hostileWorktrees(), why).toEqual([]);
      expect(read(f.hostileFs) + read(f.hostileExt), why).toBe("");
    };
    installSeam();
    const seeded = (root: string, runId: string) => {
      const journal = Journal.create(root, runId);
      const baseRef = git(root, "rev-parse", "HEAD");
      journal.append("baseline-start", undefined, { baseRef, commands: gates });
      journal.append("run-start", undefined, { baseRef, commands: gates, graphDefinitionHash: graphDefinitionHash(loadGraph(root)) });
      return { journal, baseRef };
    };
    const recaptureLeft = (root: string) => readdirSync(join(tickmarkrDir(root), WORKTREES_DIR)).filter(d => d.startsWith("baseline-recapture-"));
    const exited = spawnSync(process.execPath, ["-e", ""]).pid!;

    // production runDaemon resume from the LINKED root with the spawn-seam rewrite armed for its add: the detached add is
    // refused by name, the run reports it, no baseline is published from a decoy and the checkout is removed — a dead
    // owner's leftover checkout is swept and a live owner's beside it is untouched
    const parent = join(tickmarkrDir(f.linked), WORKTREES_DIR);
    mkdirSync(parent, { recursive: true });
    const [deadOwner, liveOwner] = [join(parent, `baseline-recapture-${exited}-aaaaaa`), join(parent, `baseline-recapture-${process.pid}-bbbbbb`)];
    for (const dir of [deadOwner, liveOwner]) expect((await addDetachedWorktree(f.linked, dir, f.base)).code).toBe(0);
    armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite: directRewrite, match: /^git worktree add --no-checkout --detach / };
    const raced = seeded(f.linked, "run-linked-recapture-raced");
    seen.length = 0;
    await expect(runDaemon(f.linked, { adapters: [fake], runId: raced.journal.runId, resume: true })).rejects.toMatchObject({ name: "GitTrustRefusal", path: commondir });
    releaseRunLock(f.linked);
    armed = undefined;
    const adds = seen.filter(s => /^git worktree add --no-checkout --detach /.test(s.cmd));
    expect(adds).toHaveLength(1);
    expect(adds[0]!.cmd).toContain(shq(linkedHead)); // the add names the object id, so no ref decides its checkout
    expectPinned(adds[0]!, f, "recapture add", "detached add");
    expect(existsSync(join(raced.journal.dir, "baseline.json"))).toBe(false);
    expect(raced.journal.read().filter(e => e.event === "baseline-recapture-complete")).toEqual([]);
    expect(JSON.stringify(raced.journal.read().filter(e => e.event === "run-end"))).toContain("git trust refusal");
    expect(heads()).toEqual([]);
    expect(recaptureLeft(f.linked)).toEqual([basename(liveOwner)]);
    expect(existsSync(deadOwner)).toBe(false);
    noStub("raced recapture");

    // ...and unraced, the same production resume recaptures the JOURNALED linked base from the trusted store: the
    // capture's checkout sat at that commit (never the main HEAD, never a stubbed invalid HEAD) and is removed afterwards
    const clean = seeded(f.linked, "run-linked-recapture");
    await runDaemon(f.linked, { adapters: [fake], runId: clean.journal.runId, resume: true });
    const published = JSON.parse(readFileSync(join(clean.journal.dir, "baseline.json"), "utf8")) as { provenance: { baseRef: string } };
    expect(published.provenance.baseRef).toBe(linkedHead);
    expect(clean.journal.read().filter(e => e.event === "baseline-recapture-complete")).toHaveLength(1);
    expect(heads()).toEqual([linkedHead]);
    expect(recaptureLeft(f.linked)).toEqual([basename(liveOwner)]);
    await removeWorktree(f.linked, liveOwner);
    expect(existsSync(liveOwner)).toBe(false);
    expect(trustedWorktrees()).toEqual(["task"]);
    noStub("clean recapture");
    // ordinary-root control: the same production resume from the main checkout recaptures the main HEAD with no pin
    rmSync(headLog, { force: true });
    const ordinary = seeded(repo, "run-ordinary-recapture");
    seen.length = 0;
    await runDaemon(repo, { adapters: [fake], runId: ordinary.journal.runId, resume: true });
    expect(heads()).toEqual([mainHead]);
    const ordinaryAdds = seen.filter(s => /^git worktree add --no-checkout --detach /.test(s.cmd));
    expect(ordinaryAdds).toHaveLength(1);
    for (const k of PIN_KEYS) expect(ordinaryAdds[0]!.env[k], k).toBeUndefined();
    expect(recaptureLeft(repo)).toEqual([]);

    // production standalone `verify --base` from the LINKED root: raced at its base-worktree add it refuses by name and
    // removes that checkout; unraced it captures its baseline in a checkout at the merge-base; an ordinary root is unpinned
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const baseDirs = (cwd: string) => existsSync(verifyStateDir(cwd)) ? readdirSync(verifyStateDir(cwd)).filter(d => d.startsWith("base-")) : [];
    rmSync(headLog, { force: true });
    armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite: directRewrite, match: /^git worktree add --no-checkout --detach / };
    seen.length = 0;
    const refused = await verify(["--base", "main", "--no-review"], f.linked).catch((e: unknown) => e);
    armed = undefined;
    const said = refused instanceof Error ? `${refused.name}: ${refused.message}` : `${(refused as { code: number }).code} ${(refused as { out: string }).out}`;
    expect(`${said}\n${errors.mock.calls.flat().join("\n")}`).toContain(`git trust refusal: ${commondir}`);
    if (!(refused instanceof Error)) expect((refused as { code: number }).code).not.toBe(0);
    const verifyAdds = seen.filter(s => /^git worktree add --no-checkout --detach /.test(s.cmd));
    expect(verifyAdds).toHaveLength(1);
    expectPinned(verifyAdds[0]!, f, "verify add", "detached add");
    expect(heads()).not.toContain(git(f.linked, "merge-base", "main", "HEAD"));
    expect(baseDirs(f.linked)).toEqual([]);
    noStub("raced verify");
    const mergeBase = git(f.linked, "merge-base", "main", "HEAD");
    rmSync(headLog, { force: true });
    const verified = await verify(["--base", "main", "--no-review"], f.linked);
    expect(heads().sort(), verified.out).toEqual([mergeBase, linkedHead].sort());
    expect(baseDirs(f.linked)).toEqual([]);
    expect(trustedWorktrees()).toEqual(["task"]);
    noStub("clean verify");
    errors.mockRestore();

    // the worktree-capability table through the production entry with the capability as the creating call sites declare
    // it. Detached adds (addDetachedWorktree) from the LINKED root resolve the commit-ish in the CALLER's checkout — a SHA,
    // a branch name and HEAD (the linked HEAD, never the main HEAD) — into an apostrophe target via production shq and
    // from a cwd below the worktree root; every step is pinned (the repair to the NEW checkout's own authority), the HEAD
    // file is never the stub and the checkout is populated. A branch add spelled `git -C . worktree add` runs as written.
    const tmp = makeTestTempDir("child-env-capability-");
    mkdirSync(join(f.linked, "sub"));
    const detached: [string, string, string, string][] = [
      [join(tmp, "sha"), f.linked, f.base, f.base],
      [join(tmp, "branch"), f.linked, "task", linkedHead],
      [join(tmp, "it's head"), f.linked, "HEAD", linkedHead],
      [join(tmp, "below"), join(f.linked, "sub"), "HEAD", linkedHead],
      [join(tmp, "main-sha"), repo, f.base, f.base],
      [join(tmp, "main-head"), repo, "HEAD", mainHead],
    ];
    for (const [dir, cwd, commitish, want] of detached) {
      seen.length = 0;
      expect((await addDetachedWorktree(cwd, dir, commitish)).code, commitish).toBe(0);
      const gitdir = realpathSync(git(dir, "rev-parse", "--absolute-git-dir"));
      expect(read(join(gitdir, "HEAD")).trim(), commitish).toBe(want);
      expect(git(dir, "rev-parse", "HEAD"), commitish).toBe(want);
      expect(existsSync(join(dir, "a.txt")) || existsSync(join(dir, "base.txt")), commitish).toBe(true);
      expect(git(dir, "status", "--porcelain"), commitish).toBe("");
      expect(realpathSync(git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")), commitish).toBe(f.common);
      expect(seen.map(s => s.cmd)).toEqual([`git rev-parse --verify --end-of-options ${shq(`${commitish}^{commit}`)}`,
        `git worktree add --no-checkout --detach ${shq(dir)} ${shq(want)}`, `git update-ref --no-deref HEAD ${shq(want)} && git update-ref -d refs/heads/.invalid && git reset -q --hard --no-recurse-submodules`]);
      for (const [i, s] of seen.slice(0, 2).entries()) {
        if (cwd === repo) for (const k of PIN_KEYS) expect(s.env[k], `${s.cmd} ${k}`).toBeUndefined();
        else expectPinned(s, f, "detached capability", i === 0 ? "view" : "detached add");
      }
      expectPinned(seen[2]!, { gitdir, common: f.common, worktree: realpathSync(dir) }, "detached repair");
    }
    seen.length = 0;
    await shGitOk(`git -C . worktree add -b dash-c ${shq(join(tmp, "dash-c"))} HEAD`, f.linked, { createsWorktree: "branch" });
    expect(git(join(tmp, "dash-c"), "symbolic-ref", "HEAD")).toBe("refs/heads/dash-c");
    expect(git(join(tmp, "dash-c"), "rev-parse", "HEAD")).toBe(linkedHead);
    expectPinned(seen[0]!, f, "branch capability as written");
    noStub("capability adds");
    // removeWorktree and prune after capability adds: only the named checkout goes, the others stay registered
    await removeWorktree(f.linked, detached[0]![0]);
    expect(existsSync(detached[0]![0])).toBe(false);
    expect(trustedWorktrees()).toEqual(["below", "branch", "dash-c", "it's-head", "main-head", "main-sha", "task"]);
    for (const dir of [...detached.slice(1).map(([d]) => d), join(tmp, "dash-c")]) await removeWorktree(repo, dir);
    git(repo, "branch", "-q", "-D", "dash-c");
    expect(trustedWorktrees()).toEqual(["task"]);
    // versus an UNDECLARED detached add from the linked root: the ref-store pin makes git stub the new HEAD as
    // `ref: refs/heads/.invalid` and check out nothing — the reason the detached call sites declare the capability
    const stubbed = join(tmp, "stubbed");
    await shGit(`git worktree add --detach ${shq(stubbed)} HEAD`, f.linked);
    expect(read(join(f.common, "worktrees", "stubbed", "HEAD")).trim()).toBe("ref: refs/heads/.invalid");
    expect(existsSync(join(stubbed, "a.txt"))).toBe(false);
    git(repo, "worktree", "remove", "--force", stubbed);
    rmSync(join(f.common, "refs", "heads", ".invalid"), { force: true });
    rmSync(join(f.common, "logs", "refs", "heads", ".invalid"), { force: true });
    git(repo, "worktree", "prune");

    // across the after-check rewrite (test writer, live writer, surviving descendant), with and without the inherited
    // hook disable and the inherited hostile ref backend: a detached add of a SHA, a branch name or HEAD raced at its
    // resolution is refused by name having read the TRUSTED commit and registering nothing; raced at its add it is refused
    // by name and rolls back the checkout it registered in the TRUSTED store; a branch add (createWorktree's -B on a new
    // and on a moved branch, ensureIntegration's existing-branch and -b forms) is refused by name and rolls back its
    // checkout, its registration and the branch it created (deleted) or moved (restored), in the trusted store only
    const writerJs = join(makeTestTempDir("child-env-writer-"), "writer.cjs");
    writeFileSync(writerJs, `const fs = require('node:fs'); const dir = process.argv[2]; let n = 0;
fs.writeFileSync(dir + '/pid.tmp', String(process.pid)); fs.renameSync(dir + '/pid.tmp', dir + '/pid');
setInterval(() => { const go = dir + '/go-' + n; if (!fs.existsSync(go)) return;
  const [target, content] = JSON.parse(fs.readFileSync(go, 'utf8')); fs.writeFileSync(target, content); fs.writeFileSync(dir + '/done-' + n, ''); n++; }, 5);
`);
    const viaProcess = (dir: string) => { let n = 0; return (target: string, content: string) => {
      writeFileSync(join(dir, `go-${n}.tmp`), JSON.stringify([target, content])); renameSync(join(dir, `go-${n}.tmp`), join(dir, `go-${n}`));
      waitSync(join(dir, `done-${n}`)); n++; }; };
    const liveDir = makeTestTempDir("child-env-live-"), survivorDir = makeTestTempDir("child-env-survivor-");
    const live = spawn(process.execPath, [writerJs, liveDir], { stdio: "ignore" });
    owned.push(live.pid!);
    await shell(`'${process.execPath}' -e "require('child_process').spawn(process.execPath, ['${writerJs}', '${survivorDir}'], { detached: true, stdio: 'ignore' }).unref()"`, makeTestTempDir("child-env-nonrepo-"), 60_000, false);
    await until(() => existsSync(join(liveDir, "pid")) && existsSync(join(survivorDir, "pid")), "writers ready");
    owned.push(Number(readFileSync(join(survivorDir, "pid"), "utf8")));
    const inheritedEnvs: [string, Record<string, string>][] = [
      ["no inherited config", {}],
      ["inherited hook disable", { GIT_CONFIG_PARAMETERS: "'hook.reference-transaction.enabled=false'" }],
      ["inherited hostile ref backend", { GIT_REFERENCE_BACKEND: `files://${f.hostileCommon}`, GIT_REF_STORAGE_FORMAT: `files://${f.hostileCommon}` }],
    ];
    // one request counter per writer process, shared by every row below
    const liveWrite = viaProcess(liveDir), survivorWrite = viaProcess(survivorDir);
    for (const [why, rewrite] of [["test writer", directRewrite], ["live writer", liveWrite], ["surviving descendant", survivorWrite]] as const) {
      for (const [config, env] of inheritedEnvs) {
        const tag = `${why}, ${config}`;
        const slug = tag.replace(/\W+/g, "-");
        const trustedRefs = refMap(repo);
        for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
        for (const [commitish, want] of [[f.base, f.base], ["task", linkedHead], ["HEAD", linkedHead]] as const) {
          const resolving = join(tmp, `resolve-${slug}-${commitish}`), adding = join(tmp, `add-${slug}-${commitish}`);
          armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite, match: /^git rev-parse --verify / };
          expect((await refusedAfter(f, () => addDetachedWorktree(f.linked, resolving, commitish), `${tag} ${commitish}`)).trim()).toBe(want);
          expect(existsSync(resolving), `${tag} ${commitish}`).toBe(false);
          armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite, match: /^git worktree add / };
          await refusedAfter(f, () => addDetachedWorktree(f.linked, adding, commitish), `${tag} ${commitish}`);
          expect(existsSync(adding), `${tag} ${commitish}`).toBe(false);
          expect(trustedWorktrees(), `${tag} ${commitish}`).toEqual(["task"]);
        }
        armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite, match: /^git worktree add / };
        git(repo, "branch", "-q", `e-${slug}`, f.base);
        git(repo, "branch", "-q", `m-${slug}`, linkedHead);
        const refsBefore = refMap(repo);
        await refusedAfter(f, () => createWorktree(f.linked, `c-${slug}`, f.base), tag);
        await refusedAfter(f, () => createWorktree(f.linked, `m-${slug}`, f.base), tag);
        await refusedAfter(f, () => ensureIntegration(f.linked, `e-${slug}`, f.base), tag);
        await refusedAfter(f, () => ensureIntegration(f.linked, `b-${slug}`, f.base), tag);
        armed = undefined;
        vi.unstubAllEnvs();
        expect(refMap(f.hostile), tag).toBe(hostileRefs);
        expect(hostileWorktrees(), tag).toEqual([]);
        expect(refMap(repo), tag).toBe(refsBefore); // c- and b- deleted, m- restored to its prior commit, e- untouched
        expect(git(repo, "rev-parse", `refs/heads/m-${slug}`), tag).toBe(linkedHead);
        for (const branch of [`e-${slug}`, `m-${slug}`]) git(repo, "branch", "-q", "-D", branch);
        expect(refMap(repo), tag).toBe(trustedRefs);
        expect(trustedWorktrees(), tag).toEqual(["task"]);
        noStub(tag);
      }
    }

    // a PERSISTENT rewrite (the live writer and the surviving descendant), never restored before cleanup: every add that
    // registered before its refusal — the production daemon recapture, standalone verify, a direct detached add and the
    // branch adds — leaves no directory and no trusted registration, rolls back the branch it created or moved, and the
    // hostile store stays byte-identical; the cleanup ran through the trusted common directory, never the hostile one
    const original = readFileSync(commondir, "utf8");
    const persistently = async <T>(rewrite: (target: string, content: string) => void, match: RegExp, why: string, run: () => Promise<T>): Promise<T> => {
      armed = { gitdir: f.gitdir, worktree: f.worktree, hostileCommon: f.hostileCommon, rewrite, match, persist: true };
      seen.length = 0;
      let outcome: { value: T } | { error: unknown };
      try { outcome = { value: await run() }; } catch (error) { outcome = { error }; }
      {
        armed = undefined;
        const left = readFileSync(commondir, "utf8");
        writeFileSync(commondir, original);
        expect(left, `${why}: still hostile after its cleanup (${"error" in outcome ? String(outcome.error) : "no error"})`).toBe(`${f.hostileCommon}\n`);
        for (const s of seen.filter(s => realpathSync(s.cwd) === f.common)) {
          expect(pinOf(s.env), `${why}: ${s.cmd}`).toEqual({ GIT_DIR: f.common, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined, GIT_REFERENCE_BACKEND: undefined, GIT_REF_STORAGE_FORMAT: undefined });
        }
        expect(seen.some(s => /^git worktree remove --force /.test(s.cmd) && realpathSync(s.cwd) === f.common), why).toBe(true);
      }
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    };
    const DETACHED_ADD = /^git worktree add --no-checkout --detach /;
    // ...and the task's execution budget expires right AFTER the add registered: once the add's child has run, the
    // budget's clock moves past its ceiling and the budget observes it, so that child is cancelled and every later step
    // inside that budget is refused — the rollback still completes, outside the expired budget, through the trusted store.
    // Returns what the add itself threw; the budget boundary throws its own exhaustion.
    const expiring = async (run: () => Promise<unknown>): Promise<unknown> => {
      const events: ExecutionBudgetEvent[] = [];
      const realNow = performance.now.bind(performance);
      let skew = 0, inner: unknown;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + skew);
      afterArmedChild = () => { skew = 7_200_000; expect(executionSignal()?.aborted).toBe(true); };
      try {
        await expect(withExecutionBudget({ limitMs: 3_600_000, taskId: "T-expiry", readEvents: () => events, append: (event, taskId, data) => { events.push({ event, taskId, data }); } },
          () => run().catch((error: unknown) => { inner = error; throw error; }))).rejects.toMatchObject({ name: "ExecutionBudgetExceeded" });
      } finally { clock.mockRestore(); afterArmedChild = undefined; }
      return inner;
    };
    const persistErrors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [why, rewrite] of [["live writer", liveWrite], ["surviving descendant", survivorWrite]] as const) {
      const slug = why.replace(/\W+/g, "-");
      const trustedRefs = refMap(repo);
      const run = seeded(f.linked, `run-persistent-${slug}`);
      await expect(persistently(rewrite, DETACHED_ADD, `${why} recapture`, () => runDaemon(f.linked, { adapters: [fake], runId: run.journal.runId, resume: true })))
        .rejects.toThrow("git trust refusal");
      releaseRunLock(f.linked);
      expect(existsSync(join(run.journal.dir, "baseline.json")), why).toBe(false);
      expect(recaptureLeft(f.linked), why).toEqual([]);
      expect(trustedWorktrees(), why).toEqual(["task"]);
      noStub(`${why} recapture`);
      // no cached baseline for this merge-base answers without the base checkout
      const cache = join(realpathSync(tmpdir()), "tickmarkr-verify", "cache"), base = `baseline-${git(f.linked, "merge-base", "main", "HEAD").slice(0, 12)}-`;
      for (const n of existsSync(cache) ? readdirSync(cache).filter(n => n.startsWith(base)) : []) rmSync(join(cache, n), { force: true });
      const refused = await persistently(rewrite, DETACHED_ADD, `${why} verify`, () => verify(["--base", "main", "--no-review"], f.linked).catch((e: unknown) => e));
      expect(`${refused instanceof Error ? refused.message : (refused as { out: string }).out}\n${persistErrors.mock.calls.flat().join("\n")}`, why).toContain(`git trust refusal: ${commondir}`);
      expect(baseDirs(f.linked), why).toEqual([]);
      expect(trustedWorktrees(), why).toEqual(["task"]);
      noStub(`${why} verify`);
      const detached = join(tmp, `persistent-${slug}`);
      await expect(persistently(rewrite, DETACHED_ADD, `${why} detached`, () => addDetachedWorktree(f.linked, detached, "HEAD"))).rejects.toMatchObject({ name: "GitTrustRefusal", path: commondir });
      expect(existsSync(detached), why).toBe(false);
      git(repo, "branch", "-q", `pe-${slug}`, f.base);
      git(repo, "branch", "-q", `pm-${slug}`, linkedHead);
      const refsBefore = refMap(repo);
      for (const add of [() => createWorktree(f.linked, `pc-${slug}`, f.base), () => createWorktree(f.linked, `pm-${slug}`, f.base),
        () => ensureIntegration(f.linked, `pe-${slug}`, f.base), () => ensureIntegration(f.linked, `pb-${slug}`, f.base)]) {
        await expect(persistently(rewrite, /^git worktree add /, `${why} branch add`, add)).rejects.toMatchObject({ name: "GitTrustRefusal", path: commondir });
        expect(trustedWorktrees(), why).toEqual(["task"]);
        expect(refMap(repo), why).toBe(refsBefore);
        noStub(`${why} branch add`);
      }
      // the same persistent rewrite with the budget expiring after registration: a detached add, createWorktree's new and
      // moved branch, ensureIntegration's existing branch and -b add each leave nothing behind in the trusted store
      const expired = join(tmp, `expired-${slug}`);
      for (const [kind, add, match] of [["detached", () => addDetachedWorktree(f.linked, expired, "HEAD"), DETACHED_ADD],
        ["new branch", () => createWorktree(f.linked, `pc-${slug}`, f.base), /^git worktree add /], ["moved branch", () => createWorktree(f.linked, `pm-${slug}`, f.base), /^git worktree add /],
        ["existing branch", () => ensureIntegration(f.linked, `pe-${slug}`, f.base), /^git worktree add /], ["-b branch", () => ensureIntegration(f.linked, `pb-${slug}`, f.base), /^git worktree add /]] as const) {
        const tag = `${why} ${kind} add under an expired budget`;
        expect(await persistently(rewrite, match, tag, () => expiring(add)), tag).toMatchObject({ name: "GitTrustRefusal", path: commondir });
        expect(existsSync(expired), tag).toBe(false);
        expect(trustedWorktrees(), tag).toEqual(["task"]);
        expect(refMap(repo), tag).toBe(refsBefore);
        noStub(tag);
      }
      expect(recaptureLeft(f.linked).concat(readdirSync(parent).filter(d => /^p[cmeb]-/.test(d))), why).toEqual([]);
      for (const branch of [`pe-${slug}`, `pm-${slug}`]) git(repo, "branch", "-q", "-D", branch);
      expect(refMap(repo), why).toBe(trustedRefs);
    }
    persistErrors.mockRestore();
    expect(git(f.linked, "rev-parse", "HEAD")).toBe(linkedHead);
  }, 600_000);
});
