import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

// Interpose only at filesystem boundaries; the previews, commits and filesystem are real.
// The read hook also follows descriptor reads so it exercises validation of a captured file.
const hooks = vi.hoisted(() => ({
  afterRead: undefined as (() => void) | undefined,
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
  beforeUnlink: undefined as ((path: string) => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const bytes = fs.readFileSync(...args);
      hooks.afterRead?.();
      return bytes;
    },
    renameSync: (from: string, to: string) => {
      hooks.beforeRename?.(from, to);
      return fs.renameSync(from, to);
    },
    unlinkSync: (path: string) => {
      hooks.beforeUnlink?.(path);
      return fs.unlinkSync(path);
    },
  };
});

import { commitGarbageUnlock, commitUnlock, previewGarbageUnlock, previewUnlock } from "../../src/run/lock.js";

const dirs: string[] = [];
const deadPid = () => {
  const child = spawnSync("true");
  expect(child.status).toBe(0);
  expect(child.pid).toBeGreaterThan(0);
  return child.pid!;
};
const payload = (pid: number, startedAt = 1) => Buffer.from(JSON.stringify({ pid, runId: "run-race", startedAt }));
function fixture(bytes: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-lock-commit-"));
  dirs.push(dir);
  const state = join(dir, ".tickmarkr");
  mkdirSync(state);
  const path = join(state, "graph.lock");
  writeFileSync(path, bytes);
  const time = new Date(1_700_000_000_000);
  utimesSync(path, time, time);
  return { dir, state, path, time };
}
function prepare(route: "named" | "garbage") {
  const f = fixture(route === "named" ? payload(deadPid()) : Buffer.from([0x80, 0x01]));
  if (route === "named") {
    const preview = previewUnlock(f.dir, "run-race");
    if (!preview.held || !preview.eligible) throw new Error("expected eligible named preview");
    return { ...f, commit: () => commitUnlock(f.dir, preview) };
  }
  const preview = previewGarbageUnlock(f.dir);
  if (!preview.held || !preview.eligible) throw new Error("expected eligible garbage preview");
  return { ...f, commit: () => commitGarbageUnlock(f.dir, preview) };
}
afterEach(() => {
  hooks.afterRead = hooks.beforeRename = hooks.beforeUnlink = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the named unlock commit refuses a holder rewritten in place with a different dead pid, the same run id and a restored mtime, and the replacement survives with its bytes and inode unchanged", () => {
  const first = deadPid();
  const replacement = deadPid();
  expect(replacement).not.toBe(first);
  // Also discriminate a payload-only rewrite with an unchanged PID and run ID.
  for (const bytes of [payload(replacement), payload(first, 2)]) {
    const f = fixture(payload(first));
    const preview = previewUnlock(f.dir, "run-race");
    if (!preview.held || !preview.eligible) throw new Error("expected eligible preview");
    writeFileSync(f.path, bytes);
    utimesSync(f.path, f.time, f.time);
    const before = statSync(f.path);
    expect(before.ino).toBe(preview.ino);
    expect(before.mtimeMs).toBe(preview.mtimeMs);
    expect.soft(commitUnlock(f.dir, preview)).toMatchObject({ removed: false });
    expect.soft(existsSync(f.path)).toBe(true);
    if (existsSync(f.path)) {
      expect(readFileSync(f.path)).toEqual(bytes);
      expect(statSync(f.path).ino).toBe(before.ino);
      expect(statSync(f.path).mtimeMs).toBe(before.mtimeMs);
    }
    expect.soft(readdirSync(f.state)).toEqual([".gitignore", "graph.lock"]);
  }
});

test("a successor installed after the commit's revalidation read and before its removal step survives with its bytes intact on both the named and the garbage route, and an entry that vanished before capture is reported as not removed rather than as a removal receipt", () => {
  for (const route of ["named", "garbage"] as const) {
    const f = prepare(route);
    const successor = payload(process.pid);
    let installedInode: number | undefined;
    hooks.afterRead = () => {
      hooks.afterRead = undefined;
      const next = join(f.state, "successor");
      writeFileSync(next, successor);
      installedInode = statSync(next).ino;
      renameSync(next, f.path);
    };
    expect.soft(f.commit()).toMatchObject({ removed: true });
    expect(installedInode).toBeDefined();
    expect.soft(existsSync(f.path)).toBe(true);
    if (existsSync(f.path)) {
      expect(readFileSync(f.path)).toEqual(successor);
      expect(statSync(f.path).ino).toBe(installedInode);
    }
    expect.soft(readdirSync(f.state)).toEqual([".gitignore", "graph.lock"]);

    const vanished = prepare(route);
    let raced = false;
    const vanish = (path: string) => {
      if (path !== vanished.path) return;
      hooks.beforeRename = hooks.beforeUnlink = undefined;
      unlinkSync(path);
      raced = true;
    };
    // rename is the capture boundary; unlink catches the former read-then-unlink defect.
    hooks.beforeRename = vanish;
    hooks.beforeUnlink = vanish;
    expect.soft(vanished.commit()).toMatchObject({ removed: false });
    expect(raced).toBe(true);
    expect(existsSync(vanished.path)).toBe(false);
    expect(readdirSync(vanished.state)).toEqual([".gitignore"]);
  }
});

test.each(["named", "garbage"] as const)("%s capture validates the entry it actually moved and restores a rejected entry without changing its bytes or inode", (route) => {
  for (const replacement of ["live", "identical-bytes"] as const) {
    const f = prepare(route);
    const bytes = replacement === "live" ? payload(process.pid) : readFileSync(f.path);
    const oldInode = statSync(f.path).ino;
    let inode: number | undefined;
    let captures = 0;
    hooks.beforeRename = (from) => {
      if (from !== f.path) return;
      captures++;
      hooks.beforeRename = undefined;
      const next = join(f.state, "successor");
      writeFileSync(next, bytes);
      utimesSync(next, f.time, f.time);
      inode = statSync(next).ino;
      renameSync(next, f.path); // replaced at the last instant before atomic capture
    };
    expect(f.commit()).toMatchObject({ removed: false });
    expect(captures).toBe(1);
    expect(inode).not.toBe(oldInode);
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(statSync(f.path).ino).toBe(inode);
    expect(readdirSync(f.state)).toEqual([".gitignore", "graph.lock"]);
  }
});

test.each(["named", "garbage"] as const)("%s refusal preserves the captured entry and a successor when restoration cannot claim graph.lock", (route) => {
  const f = prepare(route);
  const rejected = payload(process.pid);
  writeFileSync(f.path, rejected);
  const rejectedInode = statSync(f.path).ino;
  const successor = payload(process.pid, 2);
  let successorInode: number | undefined;
  hooks.afterRead = () => {
    hooks.afterRead = undefined;
    expect(existsSync(f.path)).toBe(false); // validation is reading the captured entry
    writeFileSync(f.path, successor, { flag: "wx" });
    successorInode = statSync(f.path).ino;
  };
  const result = f.commit();
  expect(result).toMatchObject({ removed: false });
  if (result.removed) throw new Error("expected refusal");
  expect(result.reason).toContain("EEXIST");
  const recoveryDir = readdirSync(f.state).find((name) => name.startsWith("graph.lock.unlock-"));
  expect(recoveryDir).toBeDefined();
  const captured = join(f.state, recoveryDir!, "graph.lock");
  expect(result.reason).toContain(captured);
  expect(readFileSync(captured)).toEqual(rejected);
  expect(statSync(captured).ino).toBe(rejectedInode);
  expect(readFileSync(f.path)).toEqual(successor);
  expect(statSync(f.path).ino).toBe(successorInode);
});

test.each(["named", "garbage"] as const)("%s capture restores on unlink failure and never counts unlink ENOENT as removal", (route) => {
  for (const code of ["EACCES", "ENOENT"] as const) {
    const f = prepare(route);
    const bytes = readFileSync(f.path);
    const inode = statSync(f.path).ino;
    let attempted = false;
    hooks.beforeUnlink = (path) => {
      hooks.beforeUnlink = undefined;
      expect(path).not.toBe(f.path);
      expect(readFileSync(path)).toEqual(bytes);
      attempted = true;
      if (code === "ENOENT") unlinkSync(path);
      throw Object.assign(new Error(`injected ${code}`), { code });
    };
    expect(f.commit()).toMatchObject({ removed: false });
    expect(attempted).toBe(true);
    if (code === "EACCES") {
      expect(readFileSync(f.path)).toEqual(bytes);
      expect(statSync(f.path).ino).toBe(inode);
      expect(readdirSync(f.state)).toEqual([".gitignore", "graph.lock"]);
    } else {
      expect(existsSync(f.path)).toBe(false);
      expect(readdirSync(f.state)).toEqual([".gitignore"]);
    }
  }
});
