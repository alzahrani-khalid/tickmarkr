import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { shq } from "../../src/adapters/types.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon, runEndTipProof, verifyIntegrationTipCached } from "../../src/run/daemon.js";
import * as git from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

afterEach(() => vi.restoreAllMocks());

const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
const cleanupError = (repo: string, checkout: string, steps: string[]) =>
  new Error(`cleanup of ${checkout} through ${join(repo, ".git")} failed: ${steps.join("; ")}`);

test("test: the production daemon whose tip verification checkout cannot be removed for a permission denial ends the run without a fatal record, with the tip proof incomplete and the cleanup cancellation journaled, and a resume runs the tip battery again, so a permission loss that crashes the run fails", async () => {
  const calls = join(makeTestTempDir("tip-cleanup-calls-"), "calls.log");
  const command = `case "$PWD" in */tip-verify-*) printf 'tip\\n' >> ${shq(calls)} ;; esac`;
  const { repo, fake } = setupRepo([T("T1"), T("T2", { humanGate: true })], {
    tasks: { T1: [{ shell: `echo landed > work.txt && ${COMMIT} work`, result: { ok: true, summary: "done" } }] },
  }, stringify({ concurrency: 1, gates: { lint: command } }));
  const realRemove = git.removeWorktree;
  let deny = true;
  let checkout: string | undefined;
  let failure: Error | undefined;
  vi.spyOn(git, "removeWorktree").mockImplementation(async (root, dir) => {
    if (deny && basename(dir).startsWith("tip-verify-")) {
      checkout = dir;
      failure = cleanupError(root, dir, ["git worktree prune (128): Operation not permitted"]);
      throw failure;
    }
    await realRemove(root, dir);
  });
  const runId = "run-tip-cleanup-permission";
  const run = (resume = false) => runDaemon(repo, { adapters: [fake], runId, resume, approvalWindowMs: 0 });
  const journal = () => Journal.open(repo, runId).read();

  const first = await run();
  expect(first.done).toEqual(["T1"]);
  expect(first.tipVerify).toBeUndefined();
  expect(first.tipProof?.kind).toBe("incomplete");
  expect(checkout).toBeDefined();
  expect(existsSync(checkout!)).toBe(true);
  expect(lines(calls)).toEqual(["tip"]);
  const before = journal();
  const cancelled = before.filter(row => row.event === "tip-verify-cancelled");
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]!.data).toEqual({ reason: "cleanup-permission", checkout, details: failure!.message });
  expect(before.some(row => row.data.fatal === true)).toBe(false);
  expect(before.at(-1)).toMatchObject({ event: "run-end", data: { tipProof: { kind: "incomplete" } } });
  expect(before.at(-1)!.data).not.toHaveProperty("tipVerify");
  expect(before.some(row => row.event === "tip-verify" && row.data.pass === true)).toBe(true);

  deny = false;
  const resumed = await run(true);
  expect(resumed.tipVerify).toBe("passed");
  expect(resumed.tipProof?.kind).toBe("fresh");
  expect(lines(calls)).toEqual(["tip", "tip"]);
  const after = journal().slice(before.length);
  expect(after.some(row => row.event === "tip-verify-cached")).toBe(false);
  expect(after.some(row => row.event === "tip-verify-start" && row.data.cached === false)).toBe(true);
  expect(after.some(row => row.data.fatal === true)).toBe(false);
}, 120_000);

test("test: each cell of the closed cleanup table decides as ruled, an operation not permitted, a permission denied and a spawn access error each recoverable, while a missing repository error alone or beside a permission denial stays fatal, so a classifier forgiving any failure or none fails", async () => {
  const repo = makeRepo({ "base.txt": "base\n" });
  const tip = await git.gitHead(repo);
  type Cell = { name: string; steps: (checkout: string) => string[]; recoverable?: boolean };
  const deniedRm = (dir: string) => `rm -rf ${shq(dir)} (1): Permission denied`;
  const cells: Cell[] = [
    { name: "success", steps: () => [] },
    { name: "prune permission", steps: () => ["git worktree prune (128): Operation not permitted"], recoverable: true },
    { name: "rm permission", steps: dir => [deniedRm(dir)], recoverable: true },
    { name: "spawn access", steps: () => ["git worktree prune: Error: spawn EACCES"], recoverable: true },
    { name: "spawn permission", steps: dir => [`rm -rf ${shq(dir)}: Error: spawn EPERM`], recoverable: true },
    { name: "both permission", steps: dir => [deniedRm(dir), "git worktree prune (128): Operation not permitted"], recoverable: true },
    { name: "diagnostic punctuation", steps: dir => [`${deniedRm(dir)}; protected: try again`], recoverable: true },
    { name: "missing repository", steps: () => ["git worktree prune (128): fatal: not a git repository"] },
    { name: "mixed", steps: dir => [deniedRm(dir), "git worktree prune (128): fatal: not a git repository"] },
    { name: "reverse mixed", steps: dir => [`rm -rf ${shq(dir)} (1): unexpected I/O failure`, "git worktree prune (128): Operation not permitted"] },
    { name: "case sensitive", steps: () => ["git worktree prune (128): operation not permitted"] },
  ];
  const realRemove = git.removeWorktree;
  let active: Cell;
  let thrown: Error | undefined;
  const cleanups: string[] = [];
  vi.spyOn(git, "removeWorktree").mockImplementation(async (root, checkout) => {
    cleanups.push(checkout);
    const steps = active.steps(checkout);
    if (!steps.length) return realRemove(root, checkout);
    thrown = cleanupError(root, checkout, steps);
    throw thrown;
  });
  for (const [index, cell] of cells.entries()) {
    active = cell;
    const journal = Journal.create(repo, `run-cleanup-cell-${index}`);
    const verifying = verifyIntegrationTipCached(repo, { lint: "true" }, journal, { identity: { repo, branch: "main", expected: tip } });
    if (cell.steps("checkout").length && !cell.recoverable) {
      const error = await verifying.catch(error => error);
      expect(error, cell.name).toBeInstanceOf(Error);
      expect(error, cell.name).toBe(thrown);
      expect(journal.read().filter(row => row.event === "tip-verify-cancelled"), cell.name).toEqual([]);
    } else {
      const close = await verifying;
      expect(close.cancelled, cell.name).toBe(cell.recoverable ? "cleanup-permission" : undefined);
      expect(close.failed, cell.name).toBe(false);
      expect(runEndTipProof(journal.read()).kind, cell.name).toBe(cell.recoverable ? "incomplete" : "fresh");
      if (cell.recoverable) expect(close.deferred, cell.name).toEqual([]);
    }
  }
  for (const checkout of cleanups) if (existsSync(checkout)) await realRemove(repo, checkout);
});

test("a permission cleanup cancellation also leaves a red battery incomplete", async () => {
  const repo = makeRepo({ "base.txt": "base\n" });
  const journal = Journal.create(repo, "run-red-cleanup");
  const realRemove = git.removeWorktree;
  vi.spyOn(git, "removeWorktree").mockImplementation(async (root, dir) => {
    await realRemove(root, dir);
    throw cleanupError(root, dir, ["git worktree prune (128): Operation not permitted"]);
  });
  const close = await verifyIntegrationTipCached(repo, { lint: "exit 1" }, journal, { identity: { repo, branch: "main" } });
  expect(close.cancelled).toBe("cleanup-permission");
  expect(runEndTipProof(journal.read()).kind).toBe("incomplete");
});

test("the daemon retains a fatal close for a non-permission tip cleanup failure alone or alongside a permission failure", async () => {
  const realRemove = git.removeWorktree;
  for (const mixed of [false, true]) {
    const { repo, fake } = setupRepo([T("T1")], {
      tasks: { T1: [{ shell: `echo landed > work.txt && ${COMMIT} work`, result: { ok: true, summary: "done" } }] },
    }, stringify({ gates: { lint: "true" } }));
    let original: Error | undefined;
    const remove = vi.spyOn(git, "removeWorktree").mockImplementation(async (root, dir) => {
      if (!basename(dir).startsWith("tip-verify-")) return realRemove(root, dir);
      original = cleanupError(root, dir, [
        ...(mixed ? [`rm -rf ${shq(dir)} (1): Permission denied`] : []),
        "git worktree prune (128): fatal: not a git repository",
      ]);
      throw original;
    });
    const runId = `run-fatal-cleanup-${mixed}`;
    const error = await runDaemon(repo, { adapters: [fake], runId, approvalWindowMs: 0 }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBe(original);
    const events = Journal.open(repo, runId).read();
    expect(events.at(-1)!.data).toMatchObject({ fatal: true, phase: "tip-verify", error: original!.message });
    expect(events.some(row => row.event === "tip-verify-cancelled")).toBe(false);
    remove.mockRestore();
  }
}, 120_000);

test("test: the tip verification's sweep of a dead owner's stale checkout skips an entry whose removal is denied permission and still creates and verifies the new checkout, while a non-permission removal failure still propagates, so a stale-checkout permission loss that crashes the resume fails", async () => {
  const repo = makeRepo({ "base.txt": "base\n" });
  const tip = await git.gitHead(repo);
  const parent = join(tickmarkrDir(repo), git.WORKTREES_DIR);
  const stale = join(parent, "tip-verify-99999999-abcdef"); // no process holds that pid
  mkdirSync(stale, { recursive: true });
  const realRemove = git.removeWorktree;
  for (const denied of [true, false]) {
    let thrown: Error | undefined;
    const removed: string[] = [];
    const remove = vi.spyOn(git, "removeWorktree").mockImplementation(async (root, dir) => {
      if (dir !== stale) { removed.push(dir); return realRemove(root, dir); }
      thrown = cleanupError(root, dir, [denied ? `rm -rf ${shq(dir)} (1): Operation not permitted` : "git worktree prune (128): fatal: not a git repository"]);
      throw thrown;
    });
    const journal = Journal.create(repo, `run-stale-sweep-${denied}`);
    const verifying = verifyIntegrationTipCached(repo, { lint: "true" }, journal, { identity: { repo, branch: "main", expected: tip } });
    if (denied) {
      const close = await verifying;
      expect(thrown).toBeDefined();
      expect(close).toMatchObject({ failed: false, identityFailed: false });
      expect(close.cancelled).toBeUndefined();
      expect(removed).toHaveLength(1); // the new checkout was created, verified and closed
      expect(basename(removed[0]!)).toMatch(new RegExp(`^tip-verify-${process.pid}-`));
      expect(runEndTipProof(journal.read()).kind).toBe("fresh");
    } else {
      expect(await verifying.catch(error => error)).toBe(thrown);
      expect(removed).toEqual([]);
    }
    expect(readdirSync(parent)).toEqual([basename(stale)]);
    remove.mockRestore();
  }
});
