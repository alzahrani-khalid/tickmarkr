import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const { mockCreateInterface, mockQuestion } = vi.hoisted(() => {
  const mockQuestion = vi.fn();
  const mockCreateInterface = vi.fn(() => ({ question: mockQuestion, close: vi.fn() }));
  return { mockCreateInterface, mockQuestion };
});
vi.mock("node:readline/promises", () => ({ createInterface: mockCreateInterface }));

import { unlock } from "../../src/cli/commands/unlock.js";

// zero-token: real foreign pids only (spawnSync("true") = reaped-dead), no CLIs, no staleness wait —
// unlock is a liveness-checked delete, not a heartbeat-expiry reclaim.
const tmp = () => mkdtempSync(join(tmpdir(), "tickmarkr-unlock-"));
const lockOf = (dir: string) => join(dir, ".tickmarkr", "graph.lock");

function plantLock(dir: string, payload: unknown, ageMs = 0): string {
  mkdirSync(join(dir, ".tickmarkr"), { recursive: true });
  const p = lockOf(dir);
  writeFileSync(p, typeof payload === "string" ? payload : JSON.stringify(payload));
  if (ageMs) { const t = new Date(Date.now() - ageMs); utimesSync(p, t, t); }
  return p;
}

// Two real dead (reaped) pids, spawned once and reused by every test below that just needs "a pid
// known to be dead" — a fresh spawnSync per assertion adds real-process fork pressure this file
// doesn't need; only the holder-replacement tests, which plant two distinct pids in the SAME lock,
// need both.
let cachedDeadPidA: number | undefined;
let cachedDeadPidB: number | undefined;
const deadPidA = () => cachedDeadPidA ??= spawnSync("true").pid!;
const deadPidB = () => cachedDeadPidB ??= spawnSync("true").pid!;

const withTTY = async (fn: () => Promise<void>) => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    await fn();
  } finally {
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
};

afterEach(() => { mockQuestion.mockReset(); mockCreateInterface.mockClear(); });

describe("tickmarkr unlock <run-id> — matching-run recovery (LOCK-03, R16-17, AC1)", () => {
  test("usage: no run-id and no --garbage refuses (R17 — a run ID is required)", async () => {
    const dir = tmp();
    await expect(unlock([], dir)).rejects.toThrow(/usage/i);
  });

  test("no lock → neutral 'no lock held', even though a run-id was named", async () => {
    const dir = tmp();
    expect(await unlock(["run-x", "--yes"], dir)).toMatch(/no lock held/);
  });

  test("seeded dead-holder success: preview names the pid/run, --yes removes it, receipt names the actual (re-read) holder", async () => {
    const dir = tmp();
    const dead = deadPidA();
    plantLock(dir, { pid: dead, runId: "run-dead", startedAt: Date.now() });
    const out = await unlock(["run-dead", "--yes"], dir);
    expect(out).toContain(String(dead));
    expect(out).toContain("run-dead");
    expect(existsSync(lockOf(dir))).toBe(false);
  });

  test("TTY confirmation (y) removes; declining (n) refuses and preserves the lock", async () => {
    const dir = tmp();
    const dead = deadPidA();
    plantLock(dir, { pid: dead, runId: "run-dead", startedAt: Date.now() });
    mockQuestion.mockResolvedValueOnce("y");
    await withTTY(async () => {
      const out = await unlock(["run-dead"], dir);
      expect(out).toContain(String(dead));
    });
    expect(existsSync(lockOf(dir))).toBe(false);

    const dir2 = tmp();
    const dead2 = deadPidB();
    plantLock(dir2, { pid: dead2, runId: "run-dead2", startedAt: Date.now() });
    mockQuestion.mockResolvedValueOnce("n");
    await withTTY(async () => {
      await expect(unlock(["run-dead2"], dir2)).rejects.toThrow(/not confirmed/);
    });
    expect(existsSync(lockOf(dir2))).toBe(true);
  });

  test("non-interactive without --yes refuses and preserves the lock", async () => {
    const dir = tmp();
    const dead = deadPidA();
    plantLock(dir, { pid: dead, runId: "run-dead", startedAt: Date.now() });
    await expect(unlock(["run-dead"], dir)).rejects.toThrow(/not confirmed/);
    expect(existsSync(lockOf(dir))).toBe(true);
  });

  test("live holder (our own pid) → refuses naming the pid; the lock file is preserved", async () => {
    const dir = tmp();
    plantLock(dir, { pid: process.pid, runId: "run-x", startedAt: Date.now() });
    await expect(unlock(["run-x", "--yes"], dir)).rejects.toThrow(String(process.pid));
    expect(existsSync(lockOf(dir))).toBe(true);
  });

  test("EPERM holder (pid 1, alive-but-not-ours) → refuses naming pid 1; file preserved", async () => {
    const dir = tmp();
    plantLock(dir, { pid: 1, runId: "run-init", startedAt: Date.now() });
    await expect(unlock(["run-init", "--yes"], dir)).rejects.toThrow(/\b1\b/);
    expect(existsSync(lockOf(dir))).toBe(true);
  });

  test("different-run case refuses even though the holder is dead — the operator must name the actual holder", async () => {
    const dir = tmp();
    const dead = deadPidA();
    plantLock(dir, { pid: dead, runId: "run-actual", startedAt: Date.now() });
    await expect(unlock(["run-guessed", "--yes"], dir)).rejects.toThrow(/run-actual/);
    expect(existsSync(lockOf(dir))).toBe(true);
  });

  test("garbage payload via the ordinary named route refuses (never silently recovered) and points at --garbage", async () => {
    const dir = tmp();
    plantLock(dir, "not json {{{");
    await expect(unlock(["run-x", "--yes"], dir)).rejects.toThrow(/--garbage/);
    expect(existsSync(lockOf(dir))).toBe(true);
  });

  test("unreadable lock content refuses rather than reporting the neutral 'no lock held' receipt, and never redirects to --garbage", async () => {
    const dir = tmp();
    const p = plantLock(dir, { pid: process.pid, runId: "run-x", startedAt: Date.now() });
    chmodSync(p, 0o000);
    try {
      // a valid live lock made unreadable must never be steered into the garbage route, which
      // would delete it without ever observing its actual (live) bytes
      await expect(unlock(["run-x", "--yes"], dir)).rejects.toThrow(/could not be read/);
    } finally {
      chmodSync(p, 0o644);
    }
    expect(existsSync(lockOf(dir))).toBe(true);
  });

  test("holder replaced between preview and commit (same run, new dead pid) refuses and leaves the new holder intact", async () => {
    const dir = tmp();
    const first = deadPidA();
    plantLock(dir, { pid: first, runId: "run-dead", startedAt: Date.now() });
    const replacement = deadPidB();
    mockQuestion.mockImplementationOnce(async () => {
      plantLock(dir, { pid: replacement, runId: "run-dead", startedAt: Date.now() }); // concurrent reclaim mid-confirm
      return "y";
    });
    await withTTY(async () => {
      await expect(unlock(["run-dead"], dir)).rejects.toThrow(/changed since preview/);
    });
    expect(existsSync(lockOf(dir))).toBe(true);
    expect(JSON.parse(readFileSync(lockOf(dir), "utf8")).pid).toBe(replacement);
  });

  test("holder replaced with a LIVE process between preview and commit refuses and leaves it intact (the discriminating pair's other half)", async () => {
    const dir = tmp();
    const dead = deadPidA();
    plantLock(dir, { pid: dead, runId: "run-dead", startedAt: Date.now() });
    mockQuestion.mockImplementationOnce(async () => {
      plantLock(dir, { pid: process.pid, runId: "run-dead", startedAt: Date.now() }); // now live
      return "y";
    });
    await withTTY(async () => {
      await expect(unlock(["run-dead"], dir)).rejects.toThrow(/changed since preview/);
    });
    expect(existsSync(lockOf(dir))).toBe(true);
    expect(JSON.parse(readFileSync(lockOf(dir), "utf8")).pid).toBe(process.pid);
  });
});

describe("tickmarkr unlock --garbage — malformed-snapshot recovery (LOCK-03, R16-17, AC2)", () => {
  test("the garbage confirmation names a sha256 digest of the observed lock bytes beside the inode, so two malformed payloads of equal length produce different prompts and the prompt whose digest was confirmed is the one committed", async () => {
    const dir = tmp();
    const p = plantLock(dir, "");
    // Equal length and identical lossy UTF-8 text, with an unchanged inode and mtime.
    const first = Buffer.from([0x80, 0x01]);
    const second = Buffer.from([0x81, 0x01]);
    const digest = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
    const ino = statSync(p).ino;
    const time = new Date(1_700_000_000_000);
    const prompts: string[] = [];
    writeFileSync(p, first);
    utimesSync(p, time, time);
    mockQuestion.mockImplementationOnce(async (question: string) => {
      prompts.push(question);
      writeFileSync(p, second); // confirm the first prompt after its bytes were replaced
      utimesSync(p, time, time);
      return "y";
    });
    await withTTY(async () => {
      await expect(unlock(["--garbage"], dir)).rejects.toThrow(/changed since preview/);
    });
    expect(readFileSync(p)).toEqual(second);
    expect(statSync(p).ino).toBe(ino);
    mockQuestion.mockImplementationOnce(async (question: string) => {
      prompts.push(question);
      return "y";
    });
    await withTTY(async () => {
      expect(await unlock(["--garbage"], dir)).toMatch(/removed garbage lock/);
    });
    expect(existsSync(p)).toBe(false);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(`inode ${ino}, sha256 ${digest(first)}`);
    expect(prompts[1]).toContain(`inode ${ino}, sha256 ${digest(second)}`);
    expect(prompts[0]).not.toBe(prompts[1]);
  });

  test("absent lock returns a neutral receipt, without requiring a run id", async () => {
    const dir = tmp();
    expect(await unlock(["--garbage", "--yes"], dir)).toMatch(/no lock held/);
  });

  test("malformed seeded bytes with explicit confirmation are removed", async () => {
    const dir = tmp();
    plantLock(dir, "not json {{{");
    const out = await unlock(["--garbage", "--yes"], dir);
    expect(out).toMatch(/garbage/i);
    expect(existsSync(lockOf(dir))).toBe(false);
  });

  test("zero-byte payload (torn write) → removes", async () => {
    const dir = tmp();
    plantLock(dir, "");
    await unlock(["--garbage", "--yes"], dir);
    expect(existsSync(lockOf(dir))).toBe(false);
  });

  test("a positional run id passed alongside --garbage is never invented into the receipt or the identity check", async () => {
    const dir = tmp();
    plantLock(dir, "not json {{{");
    const out = await unlock(["some-guessed-run", "--garbage", "--yes"], dir);
    expect(out).not.toContain("some-guessed-run");
    expect(existsSync(lockOf(dir))).toBe(false);
  });

  test("ordinary well-formed lock refuses --garbage (dead holder) and preserves the file, pointing at the named route", async () => {
    const dir = tmp();
    const dead = deadPidA();
    plantLock(dir, { pid: dead, runId: "run-dead", startedAt: Date.now() });
    await expect(unlock(["--garbage", "--yes"], dir)).rejects.toThrow(/run-dead/);
    expect(existsSync(lockOf(dir))).toBe(true);
  });

  test("ordinary well-formed lock refuses --garbage (live holder) and preserves the file", async () => {
    const dir = tmp();
    plantLock(dir, { pid: process.pid, runId: "run-x", startedAt: Date.now() });
    await expect(unlock(["--garbage", "--yes"], dir)).rejects.toThrow(/run-x/);
    expect(existsSync(lockOf(dir))).toBe(true);
  });

  test("unreadable file is identified (not reported neutral) but refused — its bytes were never observed, so --garbage never deletes it blind", async () => {
    const dir = tmp();
    const p = plantLock(dir, { totally: "not our schema" });
    chmodSync(p, 0o000);
    try {
      await expect(unlock(["--garbage", "--yes"], dir)).rejects.toThrow(/could not be read/);
    } finally {
      chmodSync(p, 0o644);
    }
    expect(existsSync(lockOf(dir))).toBe(true);
  });

  test("changed bytes/inode since preview refuses and preserves the new file", async () => {
    const dir = tmp();
    plantLock(dir, "not json {{{");
    mockQuestion.mockImplementationOnce(async () => {
      plantLock(dir, "still garbage but different {{{{"); // rewritten mid-confirm
      return "y";
    });
    await withTTY(async () => {
      await expect(unlock(["--garbage"], dir)).rejects.toThrow(/changed since preview/);
    });
    expect(existsSync(lockOf(dir))).toBe(true);
    expect(readFileSync(lockOf(dir), "utf8")).toBe("still garbage but different {{{{");
  });

  test("replacement with a valid live holder between preview and commit refuses and preserves the new holder", async () => {
    const dir = tmp();
    plantLock(dir, "not json {{{");
    mockQuestion.mockImplementationOnce(async () => {
      plantLock(dir, { pid: process.pid, runId: "run-live", startedAt: Date.now() }); // now a real, live lock
      return "y";
    });
    await withTTY(async () => {
      await expect(unlock(["--garbage"], dir)).rejects.toThrow(/well-formed payload/);
    });
    expect(existsSync(lockOf(dir))).toBe(true);
    expect(JSON.parse(readFileSync(lockOf(dir), "utf8")).runId).toBe("run-live");
  });

  test("non-interactive without --yes refuses and preserves the lock", async () => {
    const dir = tmp();
    plantLock(dir, "not json {{{");
    await expect(unlock(["--garbage"], dir)).rejects.toThrow(/not confirmed/);
    expect(existsSync(lockOf(dir))).toBe(true);
  });
});
