import * as childProcesses from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import * as lease from "../../src/run/lease.js";
import { REPOSITORY_LEASE_TOKEN_ENV, repositoryLeasePath, tryReserve, withRepositoryLease, type RepositoryLeaseHolder } from "../../src/run/lease.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// Queue row 120 (D-1684, D-1710): a killed run can leave a fixture child carrying the lease token; the lease is rightly
// never reclaimed while it lives, but the wait named only the holder's dead pid. The wait now names every live blocker by
// pid, executable and cwd, and prints NO argument (a command line joins argv with spaces, so no redaction can tell where
// a secret ends) and no environment. The namespace import keeps the unchanged-behaviour row (W2) runnable at the base.
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>() }));
type Blockers = Parameters<NonNullable<lease.RepositoryLeaseOptions["onWait"]>>[1];
const orphans: ReturnType<typeof spawn>[] = [];
afterEach(() => { for (const child of orphans.splice(0)) child.kill("SIGKILL"); vi.restoreAllMocks(); });
const carrier = (token: string, cwd?: string, args: string[] = []) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args],
    { cwd, env: { ROW120_MARK: "env-must-not-print", [REPOSITORY_LEASE_TOKEN_ENV]: token }, stdio: "ignore" });
  orphans.push(child);
  return child;
};
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
const deadHolder = async (token: string) => {
  const repo = makeRepo({ "a.txt": "a\n" });
  const path = await repositoryLeasePath(repo);
  const holder: RepositoryLeaseHolder = { pid: deadPid(), cwd: repo, at: 1, token, protectOrphans: true, roots: [] };
  expect(tryReserve(path, holder)).toBe(true);
  return { repo, path, holder };
};

test("test: a wait behind a dead holder whose token-carrying orphan keeps the lease names the orphan's pid, executable and cwd, prints none of its arguments and none of its environment, and is admitted once the orphan exits (W1)", async () => {
  const { repo, path } = await deadHolder("row120-token");
  const orphanCwd = makeTestTempDir("tickmarkr-lease-orphan-");
  const orphan = carrier("row120-token", orphanCwd, ["--access-token", "two word secret", "https://user:hunter2@host/r.git"]);
  await once(orphan, "spawn");
  const seen: [RepositoryLeaseHolder, Blockers][] = [];
  const stop = new AbortController();
  const sync = vi.spyOn(childProcesses, "execFileSync"); // passthrough: the wait's own probes must not block its loop (queue row 103)
  const spawned = vi.spyOn(childProcesses, "execFile"); // passthrough: and they read no environment (only the census does)
  const bound = setTimeout(() => stop.abort(new Error("bound: no blocker within 10 s")), 10_000);
  await expect(withRepositoryLease(repo, async () => { throw new Error("entered while an orphan kept the lease"); }, {
    isolated: true, inherited: "", pollMs: 20, signal: stop.signal,
    onWait: (observed, blockers) => { seen.push([observed, blockers]); if (blockers?.length) stop.abort(new Error("named")); },
  })).rejects.toThrow("named");
  clearTimeout(bound);
  const [observed, blockers] = seen.at(-1)!;
  expect(blockers?.map((b) => b.pid)).toEqual([orphan.pid]);
  const [blocker] = blockers!;
  expect(blocker!.executable).toMatch(/node/);
  expect(realpathSync(blocker!.cwd!)).toBe(realpathSync(orphanCwd));
  const message = lease.describeLeaseWait(observed, blockers);
  for (const part of [`held by pid ${observed.pid} in ${repo}`, "has exited or released it", `pid ${orphan.pid}`, "until they exit"]) expect(message).toContain(part);
  for (const leak of ["setInterval", "--access-token", "two word secret", "hunter2", "ROW120_MARK", "env-must-not-print", REPOSITORY_LEASE_TOKEN_ENV]) {
    expect(JSON.stringify(blockers)).not.toContain(leak);
    expect(message).not.toContain(leak);
  }
  expect(sync.mock.calls.filter(([file]) => file === "lsof")).toEqual([]);
  // the census's own `ps eww -A` reads token carriers by design; the wait's description adds no `ps e… -p` of its own
  expect(spawned.mock.calls.filter(([file, args]) => file === "ps" && Array.isArray(args) && /^e/.test(String(args[0])) && args.includes("-p"))).toEqual([]);
  orphan.kill("SIGKILL");
  await once(orphan, "exit");
  await withRepositoryLease(repo, async () => {}, { isolated: true, inherited: "", pollMs: 20 });
  expect(existsSync(path)).toBe(false);
});

test("test: a wait behind a live holder names no blockers, and its words stay 'held by pid P in C' (W2)", async () => {
  const repo = makeRepo({ "a.txt": "a\n" });
  const path = await repositoryLeasePath(repo);
  const holder: RepositoryLeaseHolder = { pid: process.pid, cwd: repo, at: 1, token: "row120-live" };
  expect(tryReserve(path, holder)).toBe(true);
  const seen: [RepositoryLeaseHolder, Blockers][] = [];
  const stop = new AbortController();
  await expect(withRepositoryLease(repo, async () => { throw new Error("entered a live holder's lease"); }, {
    independent: true, isolated: true, inherited: "", protectOrphans: false, pollMs: 20, signal: stop.signal,
    onWait: (observed, blockers) => { seen.push([observed, blockers]); stop.abort(new Error("waited")); },
  })).rejects.toThrow("waited");
  expect(seen).toEqual([[holder, undefined]]);
  if (lease.describeLeaseWait) expect(lease.describeLeaseWait(holder)).toBe(`held by pid ${process.pid} in ${repo}`);
});

test("test: when a second token-carrying orphan joins while the waiter is blocked, the wait names the blockers again, now both (W3)", async () => {
  const { repo } = await deadHolder("row120-two");
  const first = carrier("row120-two");
  await once(first, "spawn");
  const named: number[][] = [];
  let second: ReturnType<typeof spawn> | undefined;
  const stop = new AbortController();
  const bound = setTimeout(() => stop.abort(new Error("bound: no second listing within 15 s")), 15_000);
  await expect(withRepositoryLease(repo, async () => { throw new Error("entered while orphans kept the lease"); }, {
    isolated: true, inherited: "", pollMs: 20, signal: stop.signal,
    onWait: (_holder, blockers) => {
      if (!blockers?.length) return;
      named.push(blockers.map((b) => b.pid).sort((a, b) => a - b));
      if (named.length === 1) second = carrier("row120-two");
      else stop.abort(new Error("re-named"));
    },
  })).rejects.toThrow("re-named");
  clearTimeout(bound);
  expect(named).toEqual([[first.pid!], [first.pid!, second!.pid!].sort((a, b) => a - b)]);
});

test("test: two waiters in one process behind the same dead holder both name its blocker, the queued follower included, and both name the change when a second orphan joins (W4)", async () => {
  const { repo } = await deadHolder("row120-queue");
  const first = carrier("row120-queue");
  await once(first, "spawn");
  const named: [number[][], number[][]] = [[], []];
  let second: ReturnType<typeof spawn> | undefined;
  const stops = [new AbortController(), new AbortController()];
  const bound = setTimeout(() => stops.forEach((s) => s.abort(new Error("bound: the follower never caught up within 20 s"))), 20_000);
  const waiter = (i: 0 | 1) => withRepositoryLease(repo, async () => { throw new Error("entered while an orphan kept the lease"); }, {
    isolated: true, inherited: "", pollMs: 20, signal: stops[i]!.signal,
    onWait: (_holder, blockers) => {
      if (!blockers?.length) return;
      named[i].push(blockers.map((b) => b.pid).sort((a, b) => a - b));
      if (!second && named[0].length && named[1].length) second = carrier("row120-queue");
      if (named[i].length === 2) stops[i]!.abort(new Error("caught up"));
    },
  });
  const results = await Promise.allSettled([waiter(0), waiter(1)]);
  clearTimeout(bound);
  for (const result of results) expect(result.status === "rejected" && String((result as PromiseRejectedResult).reason)).toContain("caught up");
  const both = [first.pid!, second!.pid!].sort((a, b) => a - b);
  expect(named).toEqual([[[first.pid!], both], [[first.pid!], both]]);
});
