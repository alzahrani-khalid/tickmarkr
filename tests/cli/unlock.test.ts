import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
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

describe("tickmarkr unlock — liveness-checked delete (LOCK-03)", () => {
  test("no lock → resolves 'no lock held'", async () => {
    const dir = tmp();
    expect(await unlock([], dir)).toMatch(/no lock held/);
  });

  test("live holder (our own pid) → refuses naming the pid; the lock file is preserved", async () => {
    const dir = tmp();
    plantLock(dir, { pid: process.pid, runId: "run-x", startedAt: Date.now() });
    await expect(unlock([], dir)).rejects.toThrow(String(process.pid));
    expect(existsSync(lockOf(dir))).toBe(true); // safety property: a live-holder refusal never deletes
  });

  test("EPERM holder (pid 1, alive-but-not-ours) → refuses naming pid 1; file preserved", async () => {
    const dir = tmp();
    plantLock(dir, { pid: 1, runId: "run-init", startedAt: Date.now() });
    await expect(unlock([], dir)).rejects.toThrow(/\b1\b/);
    expect(existsSync(lockOf(dir))).toBe(true);
  });

  test("dead holder (fresh mtime — no staleness wait) → removes and reports the pid", async () => {
    const dir = tmp();
    const dead = spawnSync("true").pid!;
    plantLock(dir, { pid: dead, runId: "run-dead", startedAt: Date.now() });
    const out = await unlock([], dir);
    expect(out).toMatch(String(dead));
    expect(existsSync(lockOf(dir))).toBe(false);
  });

  test("garbage payload → removes and reports the garbage removal", async () => {
    const dir = tmp();
    plantLock(dir, "not json {{{");
    const out = await unlock([], dir);
    expect(out).toMatch(/garbage/i);
    expect(existsSync(lockOf(dir))).toBe(false);
  });

  test("zero-byte payload (torn write) → removes", async () => {
    const dir = tmp();
    plantLock(dir, "");
    await unlock([], dir);
    expect(existsSync(lockOf(dir))).toBe(false);
  });
});
