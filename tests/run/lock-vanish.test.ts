// Queue row 305 (D-2178 add.80): a lock its holder removes while a reader inspects it must read as not
// held, or as the owner it named — never as a live lock of an unknown pid. The fs seam below removes the
// lock file right after the reader's FIRST touch of it, whichever call that is, so the race is
// deterministic and the test does not care how inspect() reads.
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const armed = vi.hoisted(() => ({ path: undefined as string | undefined, nonFile: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const touch = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    const result = fn(...args);
    if (armed.path !== undefined && args[0] === armed.path) { const p = armed.path; armed.path = undefined; fs.unlinkSync(p); }
    return result;
  };
  // nonFile: the next fstat reports a non-regular file (a FIFO, say) while the bytes stay a valid lock payload.
  const fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
    const st = fs.fstatSync(...args);
    if (!armed.nonFile || st === undefined) return st;
    armed.nonFile = false;
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isFile: () => false });
  }) as typeof fs.fstatSync;
  return { ...fs, fstatSync, statSync: touch(fs.statSync), lstatSync: touch(fs.lstatSync), openSync: touch(fs.openSync), readFileSync: touch(fs.readFileSync) };
});

const { runLockOwner, isRunLockLive } = await import("../../src/run/lock.js");

afterEach(() => { armed.path = undefined; armed.nonFile = false; });

function repoWithLock(pid: number): { repo: string; lock: string } {
  const repo = mkdtempSync(join(tmpdir(), "tkr-lock-vanish-"));
  mkdirSync(join(repo, ".tickmarkr"));
  const lock = join(repo, ".tickmarkr", "graph.lock");
  writeFileSync(lock, JSON.stringify({ pid, runId: "run-20261029-000000-0000000000000001", startedAt: Date.now() }));
  return { repo, lock };
}

const DEAD_PID = 2_147_483_000; // beyond any live pid on the test hosts: ESRCH, so the recorded owner is dead

test("a graph lock its dead holder removes in the middle of an inspection reads as not held or as that dead owner and never as a live lock of an unknown pid, so a vanished lock classified as garbage fails", () => {
  const { repo, lock } = repoWithLock(DEAD_PID);
  armed.path = lock;
  const owner = runLockOwner(repo);
  expect(armed.path).toBeUndefined(); // control: the seam fired, so the lock vanished mid-inspection
  if (owner !== undefined) {
    expect(owner.pid).toBe(DEAD_PID);
    expect(owner.live).toBe(false);
  }
  armed.path = repoWithLock(DEAD_PID).lock;
  expect(isRunLockLive(join(armed.path, "..", ".."))).toBe(false);
});

test("an inspection that finds no lock at all still reads as not held, and a whole lock of a live holder still reads live with its pid, so the vanish guard that hides real owners fails", () => {
  const empty = mkdtempSync(join(tmpdir(), "tkr-lock-vanish-"));
  mkdirSync(join(empty, ".tickmarkr"));
  expect(runLockOwner(empty)).toBeUndefined();
  const { repo } = repoWithLock(process.pid);
  expect(runLockOwner(repo)).toEqual({ pid: process.pid, runId: "run-20261029-000000-0000000000000001", live: true });
});

test("a graph lock that exists but cannot be read, as a directory or as an unreadable file, still reads as a live lock and refuses, so a fix that turns an unreadable lock into an absent one fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "tkr-lock-vanish-"));
  mkdirSync(join(dir, ".tickmarkr", "graph.lock"), { recursive: true }); // EISDIR even under a privileged runner
  expect(runLockOwner(dir)?.live).toBe(true);
  expect(isRunLockLive(dir)).toBe(true);
  if (process.getuid?.() === 0) return; // root reads a mode-000 file; the directory row above still holds
  const { repo, lock } = repoWithLock(process.pid);
  chmodSync(lock, 0o000);
  try {
    expect(runLockOwner(repo)?.live).toBe(true);
    expect(isRunLockLive(repo)).toBe(true);
  } finally { chmodSync(lock, 0o600); }
});

test("a FIFO planted at the graph lock path is inspected without blocking and reads as a live unreadable lock, so a blocking open that hangs the reader fails", () => {
  if (process.platform === "win32") return;
  const repo = mkdtempSync(join(tmpdir(), "tkr-lock-vanish-"));
  mkdirSync(join(repo, ".tickmarkr"));
  const fifo = join(repo, ".tickmarkr", "graph.lock");
  const made = spawnSync("mkfifo", [fifo]);
  if (made.status !== 0) return; // no mkfifo on this host: nothing to plant
  expect(runLockOwner(repo)?.live).toBe(true); // returns at all (no hang) and refuses
});

test("a lock path that is not a regular file reads as a live unreadable lock even when its bytes are a valid payload naming a dead holder, so a FIFO writer that invites a reclaim fails", () => {
  const { repo } = repoWithLock(DEAD_PID);
  armed.nonFile = true;
  expect(runLockOwner(repo)?.live).toBe(true);
  expect(armed.nonFile).toBe(false); // control: the seam fired
});

test("a symlink at the graph lock path reads as a live unreadable lock whether it points at a valid dead-holder payload or at nothing, so a link that lends a reclaimable payload or reads as no lock fails", () => {
  if (process.platform === "win32") return;
  const { repo, lock } = repoWithLock(DEAD_PID);
  const target = join(repo, "planted.json");
  writeFileSync(target, JSON.stringify({ pid: DEAD_PID, runId: "run-20261029-000000-0000000000000001", startedAt: Date.now() }));
  unlinkSync(lock);
  symlinkSync(target, lock);
  expect(runLockOwner(repo)?.live).toBe(true);
  unlinkSync(lock);
  symlinkSync(join(repo, "missing.json"), lock);
  expect(runLockOwner(repo)?.live).toBe(true);
});
