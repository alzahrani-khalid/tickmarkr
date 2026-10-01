import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { compareToBaseline, fingerprint } from "../../src/gates/baseline.js";
import { DEFAULT_FORK_CAP, DEFAULT_SHELL_TIMEOUT_MS, FORK_CAP_ENV, ROUTING_ENV_SEAMS as SCRUBBED_AT_SPAWN, SPAWN_ATTEMPT_LIMIT, assertRefsWritable, classifyIdentityProbe, createWorktree, gitHead, linkNodeModules, preserveWorktree, probeRefsWritable, removeWorktree, resetSpawnForTests, setSpawnForTests, sh, shell, shOk, shGit, shGitOk, WORKTREES_DIR, worktreePath } from "../../src/run/git.js";
import { GATE_FINGERPRINT_CAP, identicalGateFailures, normalizeGateFailure, type JournalEvent } from "../../src/run/journal.js";
import { NO_EXPLORE_ENV, QUALITY_ENV, ROUTING_ENV_SEAMS } from "../../src/route/router.js";
import { makeRepo } from "../helpers/tmprepo.js";
import ts from "typescript";
import { shq } from "../../src/adapters/types.js";
import { NATIVE_PROCESS_TITLE_ENV, resetTitleEnvironmentForTests, setTitleEnvironmentForTests, TITLE_PREFLIGHT_TIMEOUT_MS } from "../../src/run/title-environment.js";

const processGroupExists = (groupId: number): boolean => {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

describe("sh", () => {
  test.each(["timeout", "already-exited", "abort"])("%s bounds draining when an escaped descendant never closes the pipes", async (mode) => {
    const { shell } = await import("../../src/run/git.js");
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 800001, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    });
    setSpawnForTests((() => child) as unknown as Parameters<typeof setSpawnForTests>[0]);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      if (mode === "already-exited") throw Object.assign(new Error("gone"), { code: "ESRCH" });
      child.emit("exit", null);
      return true;
    });
    const controller = new AbortController();
    try {
      const result = shell("sleep 30", "/tmp", 1000, false, { signal: controller.signal });
      let settled = false;
      void result.then(() => { settled = true; });
      if (mode === "already-exited") child.emit("exit", 0);
      if (mode === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(false);
      child.stdout.write("last buffered bytes");
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);
      expect(await result).toMatchObject({ stdout: "last buffered bytes", timedOut: mode !== "abort" });
      expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resetSpawnForTests(); kill.mockRestore(); vi.useRealTimers();
    }
  });

  test("captures stdout/stderr/code", async () => {
    const r = await sh("echo out; echo err >&2; exit 3", "/tmp");
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
    expect(r.code).toBe(3);
  });

  test("timeout kills and reports timedOut, not a plain exit-1", async () => {
    const r = await sh("sleep 5", "/tmp", 300);
    expect(r.code).not.toBe(0);
    expect(r.timedOut).toBe(true);
  }, 10000);

  test("test: a shell command that exits zero while leaving a background child holding its stdio settles within the reap grace after the shell's exit with code zero reapedGroup true and the child's process group gone while a command whose group exits with it settles on close without the flag whereas a shell that waits for the timeout to kill the survivors fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-reap-"));
    const groupFile = join(dir, "group");
    try {
      const timeoutMs = 8000;
      const startedAt = Date.now();
      const reaped = await sh(`printf '%s' "$$" > ${JSON.stringify(groupFile)}; sleep 30 &`, dir, timeoutMs);
      const groupId = Number(readFileSync(groupFile, "utf8"));

      expect(reaped).toMatchObject({ code: 0, reapedGroup: true });
      expect(reaped.timedOut).not.toBe(true);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1800);
      expect(Date.now() - startedAt).toBeLessThan(5000);
      await vi.waitFor(() => expect(processGroupExists(groupId)).toBe(false), { timeout: 2000, interval: 20 });

      const closedAt = Date.now();
      const closed = await sh(":", dir, 5000);
      expect(closed).toMatchObject({ code: 0 });
      expect(closed.reapedGroup).toBeUndefined();
      expect(Date.now() - closedAt).toBeLessThan(2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test("test: a command that reaches its timeout is still killed as a whole group and reports timedOut without reapedGroup whereas a reap path that reclassifies a timeout kill as a grace reap fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-timeout-group-"));
    const groupFile = join(dir, "group");
    try {
      const timedOut = await sh(
        `printf '%s' "$$" > ${JSON.stringify(groupFile)}; sleep 30 & wait`,
        dir,
        300,
      );
      const groupId = Number(readFileSync(groupFile, "utf8"));

      expect(timedOut.code).not.toBe(0);
      expect(timedOut.timedOut).toBe(true);
      expect(timedOut.reapedGroup).toBeUndefined();
      await vi.waitFor(() => expect(processGroupExists(groupId)).toBe(false), { timeout: 2000, interval: 20 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);

  // Q24: the ceiling scales with what a suite actually costs, so the shell has to report that cost.
  // Measured at this seam, not by each caller — two callers bracketing their own Date.now() is how a
  // "measured" duration starts disagreeing with itself. A killed child reports elapsed-at-the-kill.
  test("every shell reports its own wall clock, and a killed one reports elapsed at the kill", async () => {
    const ran = await sh("sleep 0.3", "/tmp");
    expect(ran.durationMs).toBeGreaterThanOrEqual(300);
    expect(ran.durationMs).toBeLessThan(20000);

    const killed = await sh("sleep 30", "/tmp", 300);
    expect(killed.timedOut).toBe(true);
    expect(killed.durationMs).toBeGreaterThanOrEqual(300);
    expect(killed.durationMs).toBeLessThan(5000); // the kill's elapsed, never the 30s the command asked for
    expect(DEFAULT_SHELL_TIMEOUT_MS).toBe(600000); // the shipped ceiling every unmeasured caller falls back to
  }, 15000);

  test("timeout resolves even when a grandchild keeps the stdio pipes open", async () => {
    // v1.33.1 init hang: SIGKILLing bash orphaned a background child that inherited our
    // stdout pipe, so "close" never fired. The background sleep here reproduces that.
    const t0 = Date.now();
    const r = await sh("sleep 30 & sleep 30", "/tmp", 300);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 10000);

  test("stdin-reading command returns promptly (stdin ignored)", async () => {
    const t0 = Date.now();
    // cat blocks forever on an open stdin pipe; with stdin ignore it EOFs and exits.
    const r = await sh("cat", "/tmp", 5000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.timedOut).not.toBe(true);
    expect(r.code).toBe(0);
  }, 10000);

  test("shOk throws with stderr", async () => {
    await expect(shOk("echo boom >&2; exit 1", "/tmp")).rejects.toThrow(/boom/);
  });

  test("internal git plumbing commands run without the login-shell flag", async () => {
    const home = mkdtempSync(join(tmpdir(), "tickmarkr-shell-home-"));
    writeFileSync(join(home, ".bash_profile"), "export TICKMARKR_LOGIN_SOURCED=yes\n");
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await shGit("test -z \"$TICKMARKR_LOGIN_SOURCED\" && printf ok", "/tmp");
      expect(r).toMatchObject({ code: 0, stdout: "ok" });
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});


interface ChunkPlan {
  stdout?: Buffer[];
  stderr?: Buffer[];
  code?: number;
}

// The real pipe boundary is nondeterministic. This injected child emits the exact chunk plan before
// `close`, which is the child_process contract the capture seam consumes.
const spawnWithChunks = (plans: ChunkPlan[]): typeof spawn => {
  let call = 0;
  return ((_file, _args, _opts) => {
    const plan = plans[call++];
    if (!plan) throw new Error(`no chunk plan for spawn ${call}`);
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr, kill: () => true });
    setImmediate(() => {
      child.emit("spawn");
      for (const chunk of plan.stdout ?? []) stdout.emit("data", chunk);
      for (const chunk of plan.stderr ?? []) stderr.emit("data", chunk);
      child.emit("close", plan.code ?? 0);
    });
    return child;
  }) as typeof spawn;
};

const chunksAt = (bytes: Buffer, offset: number): Buffer[] => [bytes.subarray(0, offset), bytes.subarray(offset)];
const chunkLocalDecode = (chunks: Buffer[]): string => chunks.map((chunk) => chunk.toString("utf8")).join("");

describe("UTF-8 capture at the one shell seam (OBS-716)", () => {
  afterEach(() => resetSpawnForTests());

  test("test: a command whose output carries a three-byte box-drawing character delivered as two chunks that split it is captured equal in length and content to the bytes the command wrote; a reader decoding each chunk alone returns three extra bytes where the split falls after two of those bytes and six where it falls after one: it fails", async () => {
    const written = Buffer.from("left ┌ right");
    const boxStart = Buffer.byteLength("left ");
    const afterTwo = chunksAt(written, boxStart + 2);
    const afterOne = chunksAt(written, boxStart + 1);
    setSpawnForTests(spawnWithChunks([{ stdout: afterTwo }]));

    const captured = await sh("fixture controls this command", "/tmp");
    expect(captured.stdout).toBe(written.toString("utf8"));
    expect(Buffer.byteLength(captured.stdout)).toBe(written.length);
    expect(Buffer.byteLength(chunkLocalDecode(afterTwo)) - written.length).toBe(3);
    expect(Buffer.byteLength(chunkLocalDecode(afterOne)) - written.length).toBe(6);
  });

  test("test: the same forced split on the error stream is captured equal in length and content to what the command wrote; a repair that carries the partial only on the output stream leaves every value derived from the error stream corrupt and fails", async () => {
    const written = Buffer.from("Error: ┌ stderr failure\n");
    const split = chunksAt(written, Buffer.byteLength("Error: ") + 1);
    setSpawnForTests(spawnWithChunks([{ stderr: split, code: 1 }]));

    const captured = await sh("fixture controls this command", "/tmp");
    const joined = `${captured.stdout}\n${captured.stderr}`;
    const corruptStderr = chunkLocalDecode(split);
    const corruptJoined = `\n${corruptStderr}`;
    expect(captured.stderr).toBe(written.toString("utf8"));
    expect(Buffer.byteLength(captured.stderr)).toBe(written.length);
    expect(joined).not.toBe(corruptJoined);
    expect(fingerprint(joined)).not.toEqual(fingerprint(corruptJoined));
  });

  test("test: one failure written twice byte-for-byte yields the same failure shape a gate derives from the two streams joined where the pipe delivers it whole once and split mid-character once; split-dependent error characters that make two identical failures compare unequal disable the identical-retry ban and fail", async () => {
    const written = Buffer.from("Error: ┌ same failure\n");
    const split = chunksAt(written, Buffer.byteLength("Error: ") + 1);
    setSpawnForTests(spawnWithChunks([
      { stderr: [written], code: 1 },
      { stderr: split, code: 1 },
    ]));

    const whole = await sh("fixture controls first command", "/tmp");
    const chunked = await sh("fixture controls second command", "/tmp");
    const gateShape = (result: { stdout: string; stderr: string }) =>
      fingerprint(`${result.stdout}\n${result.stderr}`).join("\n");
    const wholeShape = gateShape(whole);
    const chunkedShape = gateShape(chunked);
    expect(chunkedShape).toBe(wholeShape);

    const gateDetails = (shape: string) => `new failure fingerprints vs baseline:\n${shape}`;
    const correctedEvents: JournalEvent[] = [wholeShape, chunkedShape].map((shape, index) => ({
      ts: `2026-08-27T00:00:0${index}.000Z`,
      event: "gate-result",
      taskId: "T1",
      data: { gate: "test", pass: false, details: gateDetails(shape) },
    }));
    expect(identicalGateFailures(correctedEvents, "T1", "test", normalizeGateFailure(gateDetails(chunkedShape))))
      .toBe(GATE_FINGERPRINT_CAP);

    const corruptShape = fingerprint(`\n${chunkLocalDecode(split)}`).join("\n");
    const corruptEvents: JournalEvent[] = [wholeShape, corruptShape].map((shape, index) => ({
      ts: `2026-08-27T00:01:0${index}.000Z`,
      event: "gate-result",
      taskId: "T1",
      data: { gate: "test", pass: false, details: gateDetails(shape) },
    }));
    expect(corruptShape).not.toBe(wholeShape);
    expect(identicalGateFailures(corruptEvents, "T1", "test", normalizeGateFailure(gateDetails(corruptShape))))
      .toBeLessThan(GATE_FINGERPRINT_CAP);
  });

  test("test: a stream carrying multi-byte characters is captured exactly at every byte offset the boundary could fall on and with no split at all; a reader correct only where the boundary lands between characters passes the unsplit control alone and fails", async () => {
    const written = Buffer.from("A¢┌😀Z");
    const plans: ChunkPlan[] = [];
    for (let offset = 1; offset < written.length; offset++) plans.push({ stdout: chunksAt(written, offset) });
    plans.push({ stdout: [written] });
    setSpawnForTests(spawnWithChunks(plans));

    for (let offset = 1; offset < written.length; offset++) {
      const captured = await sh(`fixture controls split ${offset}`, "/tmp");
      expect(captured.stdout, `split at byte ${offset}`).toBe(written.toString("utf8"));
      expect(Buffer.byteLength(captured.stdout), `split at byte ${offset}`).toBe(written.length);
    }
    const unsplit = await sh("fixture controls unsplit", "/tmp");
    expect(unsplit.stdout).toBe(written.toString("utf8"));
    expect(chunkLocalDecode([written])).toBe(unsplit.stdout);
    expect(Array.from({ length: written.length - 1 }, (_, index) => index + 1)
      .some((offset) => chunkLocalDecode(chunksAt(written, offset)) !== unsplit.stdout)).toBe(true);
  });

  test("the capture site records that a passing case proves this decoder correct rather than proving every caller byte-safe, because chunk boundaries are the kernel's to choose, so a diff claiming the class closed without naming what timing still decides fails", () => {
    const source = readFileSync(new URL("../../src/run/git.ts", import.meta.url), "utf8");
    expect(source).toMatch(/proves this decoder correct rather than\s+\/\/ proving every caller byte-safe/);
    expect(source).toMatch(/chunk boundaries are the kernel's to choose, so timing\s+\/\/ still decides/);
  });
});


// OBS-688: the machine refusing a fork is not evidence about the work — the command never started.
// It happened twice in one night behind a waived flake, and it is unreachable from a fixture while
// the seam holds `spawn` from the standard library directly, so the seam is injected here. The fake
// child mirrors what node hands back on a refused spawn: streams exist, no `spawn` event ever fires,
// and the error arrives asynchronously (measured against a real ENOENT spawn, which the third case
// below uses unfaked rather than describing).
const refusedSpawn = (code: string) => {
  const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  const err = Object.assign(new Error(`spawn bash ${code}`), { code, syscall: "spawn bash" });
  setImmediate(() => child.emit("error", err));
  return child;
};

describe("spawn refusal at the one shell seam (OBS-688)", () => {
  afterEach(() => resetSpawnForTests());

  test("a spawn the operating system refuses for a temporary resource shortage before the command starts is retried and the caller receives the command's own exit status and output; a seam returning the spawn error on the first refusal fails", async () => {
    let calls = 0;
    setSpawnForTests(((file, args, opts) => {
      calls += 1;
      return calls === 1 ? refusedSpawn("EAGAIN") : spawn(file, args as string[], opts as object);
    }) as typeof spawn);
    const r = await sh("echo out; echo err >&2; exit 3", "/tmp");
    expect(calls).toBe(2); // the refusal was retried, not reported
    expect(r.code).toBe(3); // ...and the caller sees the COMMAND's status, never the seam's 127
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
  }, 10000);

  test("the retry is bounded and a refusal persisting past that bound returns the spawn error rather than looping; an unbounded retry that never returns fails", async () => {
    let calls = 0;
    setSpawnForTests((() => { calls += 1; return refusedSpawn("EAGAIN"); }) as typeof spawn);
    const r = await sh("echo never-runs", "/tmp"); // an unbounded retry never resolves and times this case out
    expect(calls).toBe(SPAWN_ATTEMPT_LIMIT);
    expect(SPAWN_ATTEMPT_LIMIT).toBeGreaterThan(1); // a "bound" of one is no retry at all
    expect(r.code).toBe(127);
    expect(r.stderr).toMatch(/EAGAIN/); // the refusal's own text, carried out to the caller
  }, 10000);

  test("a spawn refused because the interpreter does not exist is returned immediately with no retry; a seam retrying every spawn error delays every genuine failure and fails", async () => {
    let calls = 0;
    // a REAL refusal: node itself raises ENOENT for this binary, so nothing about it is modelled
    setSpawnForTests(((_file, args, opts) => {
      calls += 1;
      return spawn("tickmarkr-no-such-interpreter", args as string[], opts as object);
    }) as typeof spawn);
    const r = await sh("echo never-runs", "/tmp");
    expect(calls).toBe(1); // a seam retrying every spawn error would spend the whole backoff here
    expect(r.code).toBe(127);
    expect(r.stderr).toMatch(/ENOENT/);
  }, 10000);
});

describe("routing env scrub at the spawn seam (OBS-74)", () => {
  test("the scrub list is imported from the router constants", () => {
    // reference identity: the seam scrubs the router's own exported list, not a hardcoded copy —
    // a rename or addition in router.ts cannot silently un-scrub the spawn seam
    expect(SCRUBBED_AT_SPAWN).toBe(ROUTING_ENV_SEAMS);
    expect(ROUTING_ENV_SEAMS).toEqual([QUALITY_ENV, NO_EXPLORE_ENV]);
  });

  test("the parent daemon environment remains unchanged after child execution", async () => {
    process.env[QUALITY_ENV] = "1";
    process.env[NO_EXPLORE_ENV] = "1";
    try {
      // ${VAR-unset}: distinguishes unset from set-but-empty — the child must see neither seam at all
      const r = await sh(`printf '%s|%s' "\${${QUALITY_ENV}-unset}" "\${${NO_EXPLORE_ENV}-unset}"`, "/tmp");
      expect(r.stdout).toBe("unset|unset"); // scrubbed from the child...
      expect(process.env[QUALITY_ENV]).toBe("1"); // ...while the daemon's own env is untouched
      expect(process.env[NO_EXPLORE_ENV]).toBe("1");
    } finally {
      delete process.env[QUALITY_ENV];
      delete process.env[NO_EXPLORE_ENV];
    }
  });

  test("non-login git plumbing children are scrubbed too (same choke point)", async () => {
    process.env[QUALITY_ENV] = "1";
    try {
      const r = await shGit(`printf '%s' "\${${QUALITY_ENV}-unset}"`, "/tmp");
      expect(r.stdout).toBe("unset");
    } finally {
      delete process.env[QUALITY_ENV];
    }
  });
});

describe("fork-cap default at the spawn seam (OBS-110)", () => {
  const resetForkCap = () => {
    const before = process.env[FORK_CAP_ENV];
    delete process.env[FORK_CAP_ENV];
    return before;
  };
  const restoreForkCap = (before: string | undefined) => {
    if (before === undefined) delete process.env[FORK_CAP_ENV];
    else process.env[FORK_CAP_ENV] = before;
  };

  test("a child spawned with no fork-cap variable in the parent environment receives the default value", async () => {
    const before = resetForkCap();
    try {
      const r = await sh(`printf '%s' "\${${FORK_CAP_ENV}-unset}"`, "/tmp");
      expect(r.stdout).toBe(DEFAULT_FORK_CAP);
    } finally {
      restoreForkCap(before);
    }
  });

  test("a child spawned with the operator's own fork-cap variable already set in the parent environment keeps that value unchanged", async () => {
    const before = process.env[FORK_CAP_ENV];
    process.env[FORK_CAP_ENV] = "12";
    try {
      const r = await sh(`printf '%s' "\${${FORK_CAP_ENV}-unset}"`, "/tmp");
      expect(r.stdout).toBe("12");
    } finally {
      restoreForkCap(before);
    }
  });

  test("a plain git plumbing command spawned through the same helper still succeeds with the default variable present", async () => {
    const before = resetForkCap();
    try {
      const repo = makeRepo({ "a.txt": "hello\n" });
      const head = await gitHead(repo);
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      restoreForkCap(before);
    }
  });
});

describe("worktrees", () => {
  test("worktreePath resolves under worktrees.noindex from the shared constant (OBS-49)", () => {
    // pure-ish: tickmarkrDir() mkdirs, so use a real temp root; both this and the merge path
    // derive the directory name from the single exported WORKTREES_DIR constant
    const repo = mkdtempSync(join(tmpdir(), "wt-path-"));
    expect(worktreePath(repo, "tickmarkr/run-1--T1")).toContain(
      join(".tickmarkr", WORKTREES_DIR, "tickmarkr-run-1--T1"),
    );
    expect(WORKTREES_DIR).toBe("worktrees.noindex");
  });

  test("createWorktree makes an isolated checkout on a new branch", async () => {
    const repo = makeRepo({ "a.txt": "hello\n" });
    const base = await gitHead(repo);
    // "--" not "/": a task branch must never nest under the integration branch ref (locked decision 10)
    const wt = await createWorktree(repo, "tickmarkr/run-1--T1", base);
    expect(wt).toContain(`.tickmarkr/${WORKTREES_DIR}/`);
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("hello\n");
    expect((await shOk("git branch --show-current", wt)).trim()).toBe("tickmarkr/run-1--T1");
    // recreating the same lane resets it instead of failing
    const wt2 = await createWorktree(repo, "tickmarkr/run-1--T1", base);
    expect(existsSync(wt2)).toBe(true);
  });

  test("recreating a checkout that holds three uncommitted paths — a modified tracked file; an untracked file; an untracked file inside a directory absent from HEAD — leaves a durable reference whose tree carries all three at their exact bytes; a capture taken through the stash object this seat reached for by hand loses the untracked pair silently: that capture fails", async () => {
    const repo = makeRepo({ "tracked.bin": "head\n" });
    const base = await gitHead(repo);
    const branch = "tickmarkr/preserve-three--T1";
    const wt = await createWorktree(repo, branch, base);
    const bytes = {
      "tracked.bin": Buffer.from([0x00, 0x74, 0x72, 0x61, 0x63, 0x6b, 0xff]),
      "loose.bin": Buffer.from([0x6c, 0x6f, 0x6f, 0x73, 0x65, 0x00, 0xfe]),
      "new-dir/deep.bin": Buffer.from([0xfd, 0x64, 0x65, 0x65, 0x70, 0x00]),
    };
    writeFileSync(join(wt, "tracked.bin"), bytes["tracked.bin"]);
    writeFileSync(join(wt, "loose.bin"), bytes["loose.bin"]);
    mkdirSync(join(wt, "new-dir"));
    writeFileSync(join(wt, "new-dir", "deep.bin"), bytes["new-dir/deep.bin"]);

    // Control on the exact tempting command: `-u` is merely accepted by `stash create`; neither
    // ordinary untracked path becomes a parent/tree entry, and git exits successfully while losing both.
    const stash = (await shGitOk("git stash create -u", wt)).trim();
    expect(stash).toMatch(/^[0-9a-f]{40,64}$/);
    expect(execFileSync("git", ["cat-file", "blob", `${stash}:tracked.bin`], { cwd: wt }))
      .toEqual(bytes["tracked.bin"]);
    expect((await shGit(`git cat-file -e ${stash}:loose.bin`, wt)).code).not.toBe(0);
    expect((await shGit(`git cat-file -e ${stash}:new-dir/deep.bin`, wt)).code).not.toBe(0);

    const ref = await preserveWorktree(wt);
    expect(ref).toMatch(/^refs\/tickmarkr\/preserved\/[0-9a-f]{40,64}$/);
    for (const [path, expected] of Object.entries(bytes)) {
      expect(readFileSync(join(wt, path))).toEqual(expected); // capture is byte-inert before removal
    }

    await createWorktree(repo, branch, base); // removes the old checkout
    expect((await shGitOk(`git rev-parse --verify '${ref}^{commit}'`, repo)).trim()).toMatch(/^[0-9a-f]{40,64}$/);
    for (const [path, expected] of Object.entries(bytes)) {
      expect(execFileSync("git", ["cat-file", "blob", `${ref}:${path}`], { cwd: repo })).toEqual(expected);
    }
  });

  test("the working tree the recreation hands back is the fresh checkout it always was and the preservation leaves no staged residue behind it, so a preservation that writes through the repository's own index and carries its own scratch file into the preserved tree fails", async () => {
    const repo = makeRepo({ "tracked.txt": "head\n" });
    const base = await gitHead(repo);
    const branch = "tickmarkr/preserve-clean-index--T1";
    const wt = await createWorktree(repo, branch, base);
    writeFileSync(join(wt, "tracked.txt"), "working bytes\n");
    writeFileSync(join(wt, "loose.txt"), "untracked bytes\n");
    const before = {
      tracked: readFileSync(join(wt, "tracked.txt")),
      loose: readFileSync(join(wt, "loose.txt")),
    };

    const ref = await preserveWorktree(wt);
    expect(ref).toBeDefined();
    expect(readFileSync(join(wt, "tracked.txt"))).toEqual(before.tracked);
    expect(readFileSync(join(wt, "loose.txt"))).toEqual(before.loose);
    expect(await shGitOk("git diff --cached --name-only", wt)).toBe("");
    expect((await shGitOk(`git ls-tree -r --name-only ${ref}`, wt)).trim().split("\n").sort())
      .toEqual(["loose.txt", "tracked.txt"]); // no repository-local temporary index staged itself

    const fresh = await createWorktree(repo, branch, base);
    expect(readFileSync(join(fresh, "tracked.txt"), "utf8")).toBe("head\n");
    expect(existsSync(join(fresh, "loose.txt"))).toBe(false);
    expect(await shGitOk("git status --porcelain --untracked-files=all", fresh)).toBe("");
    expect(await shGitOk("git diff --cached --name-only", fresh)).toBe("");
  });

  test("recreating a checkout that holds nothing uncommitted writes no reference at all; a preservation firing on every dispatch buries the deaths that matter under references nobody reads: it fails", async () => {
    const repo = makeRepo({ "tracked.txt": "head\n" });
    const wt = await createWorktree(repo, "tickmarkr/preserve-clean--T1", await gitHead(repo));
    expect(await shGitOk("git for-each-ref --format='%(refname)' refs/tickmarkr/preserved", repo)).toBe("");
    expect(await preserveWorktree(wt)).toBeUndefined();
    expect(await shGitOk("git for-each-ref --format='%(refname)' refs/tickmarkr/preserved", repo)).toBe("");
  });

  test("metacharacter branch never executes shell injection (HARD-01)", async () => {
    const repo = makeRepo({ "a.txt": "hello\n" });
    const base = await gitHead(repo);
    const payload = "tickmarkr/run'; touch PWNED #";
    try {
      await createWorktree(repo, payload, base);
    } catch {
      // git may reject the malformed ref after quoting — either outcome is fine
    }
    expect(existsSync(join(repo, "PWNED"))).toBe(false);
  });

  test("symlinks the repo's node_modules into a fresh worktree", async () => {
    const repo = makeRepo({ "a.txt": "hello\n" });
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "marker.txt"), "root\n");
    const base = await gitHead(repo);
    const wt = await createWorktree(repo, "tickmarkr/run-2--T1", base);
    const link = join(wt, "node_modules");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(repo, "node_modules")));
    expect(readFileSync(join(link, "marker.txt"), "utf8")).toBe("root\n");
  });

  test("creates no link and no error when the repo has no node_modules", async () => {
    const repo = makeRepo({ "a.txt": "hello\n" });
    const base = await gitHead(repo);
    const wt = await createWorktree(repo, "tickmarkr/run-3--T1", base);
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
  });

  test("leaves an existing worktree node_modules untouched", async () => {
    // node_modules tracked in git: checkout gives both repo and worktree a real (non-symlink) copy
    const repo = makeRepo({ "a.txt": "hello\n", "node_modules/own.txt": "own\n" });
    const base = await gitHead(repo);
    const wt = await createWorktree(repo, "tickmarkr/run-4--T1", base);
    const link = join(wt, "node_modules");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(link, "own.txt"), "utf8")).toBe("own\n");
  });

  test("removeWorktree tears down a created worktree under the new path (OBS-49 lifecycle)", async () => {
    const repo = makeRepo({ "a.txt": "hello\n" });
    const base = await gitHead(repo);
    const wt = await createWorktree(repo, "tickmarkr/run-rm--T1", base);
    expect(existsSync(wt)).toBe(true);
    await removeWorktree(repo, wt);
    expect(existsSync(wt)).toBe(false);
    // the lane directory under worktrees.noindex is gone
    expect(existsSync(worktreePath(repo, "tickmarkr/run-rm--T1"))).toBe(false);
  });
});

describe("linkNodeModules re-assert (OBS-47)", () => {
  const provisioning = (repo: string) => {
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "marker.txt"), "root\n");
  };

  test("OBS-47: a removed node_modules link is re-asserted before the next attempt's gates (force)", () => {
    const repo = mkdtempSync(join(tmpdir(), "wt-reassert-"));
    provisioning(repo);
    const wt = mkdtempSync(join(tmpdir(), "wt-reassert-wt-"));
    expect(linkNodeModules(repo, wt)).toBe(true); // provisioned
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    rmSync(join(wt, "node_modules")); // a worker deleted the link
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
    expect(linkNodeModules(repo, wt, { force: true })).toBe(true); // harness re-asserts it
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(wt, "node_modules", "marker.txt"), "utf8")).toBe("root\n");
  });

  test("OBS-47: a worker-replaced real directory is restored to the provisioned link (force)", () => {
    const repo = mkdtempSync(join(tmpdir(), "wt-realdir-"));
    provisioning(repo);
    const wt = mkdtempSync(join(tmpdir(), "wt-realdir-wt-"));
    linkNodeModules(repo, wt);
    rmSync(join(wt, "node_modules"));
    mkdirSync(join(wt, "node_modules")); // worker replaced the link with a real directory
    writeFileSync(join(wt, "node_modules", "own.txt"), "worker\n");
    // lenient (provisioning) leaves the real dir untouched; force restores the provisioned link
    expect(linkNodeModules(repo, wt)).toBe(false);
    expect(lstatSync(join(wt, "node_modules")).isDirectory()).toBe(true);
    expect(linkNodeModules(repo, wt, { force: true })).toBe(true);
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(wt, "node_modules", "marker.txt"), "utf8")).toBe("root\n");
  });

  test("OBS-47: an already-correct link is idempotent under force", () => {
    const repo = mkdtempSync(join(tmpdir(), "wt-idem-"));
    provisioning(repo);
    const wt = mkdtempSync(join(tmpdir(), "wt-idem-wt-"));
    linkNodeModules(repo, wt);
    expect(linkNodeModules(repo, wt, { force: true })).toBe(true); // no-op, still correct
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
  });

  test("OBS-47: no provisioned source is benign — nothing to link, never a failure", () => {
    const repo = mkdtempSync(join(tmpdir(), "wt-nosrc-")); // no node_modules at the repo root
    const wt = mkdtempSync(join(tmpdir(), "wt-nosrc-wt-"));
    expect(linkNodeModules(repo, wt, { force: true })).toBe(true); // correct state is no link — not a parkable failure
    expect(existsSync(join(wt, "node_modules"))).toBe(false); // nothing created
  });
});

describe("worktree node_modules exclude (OBS-78)", () => {
  const provisionedWorktree = async (files: Record<string, string> = { "a.txt": "hello\n" }) => {
    const repo = makeRepo(files);
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "marker.txt"), "root\n");
    const wt = await createWorktree(repo, "tickmarkr/run-ex--T1", await gitHead(repo));
    return { repo, wt };
  };
  // the exclude file git actually consults for the worktree (linked worktrees share the common dir's)
  const excludeFile = async (wt: string) =>
    (await shGitOk("git rev-parse --path-format=absolute --git-path info/exclude", wt)).trim();

  test("staging all files in a provisioned worktree leaves the node_modules symlink unstaged", async () => {
    const { wt } = await provisionedWorktree();
    await shGitOk("git add -A", wt); // the OBS-78 worker move that committed the link
    const staged = await shGitOk("git diff --cached --name-only", wt);
    expect(staged).not.toMatch(/^node_modules$/m);
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true); // link present, just unstageable
  });

  test("the provisioned worktree carries a git exclude entry for node_modules", async () => {
    const { wt } = await provisionedWorktree();
    expect(readFileSync(await excludeFile(wt), "utf8")).toMatch(/^node_modules$/m);
    const r = await shGit("git check-ignore -q node_modules", wt); // git itself honors it in the worktree
    expect(r.code).toBe(0);
  });

  test("a repeated re-assert leaves a single exclude entry", async () => {
    const { repo, wt } = await provisionedWorktree();
    linkNodeModules(repo, wt, { force: true }); // daemon re-asserts before every gate pass
    linkNodeModules(repo, wt, { force: true });
    expect(readFileSync(await excludeFile(wt), "utf8").match(/^node_modules$/gm)).toHaveLength(1);
  });

  test("the node_modules exclusion never edits the target repository gitignore", async () => {
    const { repo, wt } = await provisionedWorktree({ "a.txt": "hello\n", ".gitignore": "dist/\n" });
    linkNodeModules(repo, wt, { force: true }); // provision + re-assert both ran
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("dist/\n");
    expect(readFileSync(join(wt, ".gitignore"), "utf8")).toBe("dist/\n");
  });
});

describe("reap error visibility (§B T6)", () => {
  test("test: a gate shell whose group kill fails with a permission error carries that error on the shell result and the gate row and still settles at the timeout while an ESRCH is silent whereas a reap that swallows the permission error fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-reap-eperm-"));
    const group = join(dir, "group");
    const realKill = process.kill.bind(process);
    let errno = "EPERM";
    let groupId: number | undefined;
    const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
      if (pid < 0) {
        const error = new Error(`kill ${errno}`) as NodeJS.ErrnoException;
        error.code = errno;
        throw error;
      }
      return realKill(pid, sig as never);
    }) as typeof process.kill);
    try {
      const startedAt = Date.now();
      const timed = await sh(`printf '%s' "$$" > ${JSON.stringify(group)}; sleep 30 & exit 0`, dir, 2_500);
      groupId = Number(readFileSync(group, "utf8"));
      expect(timed).toMatchObject({ timedOut: true, reapError: expect.stringMatching(/EPERM/) });
      expect(Date.now() - startedAt).toBeLessThan(4_000); // the ceiling, not the surviving pipe, settled it
      realKill(-groupId, "SIGKILL");
      groupId = undefined;

      const [gate] = await compareToBaseline(
        dir,
        { test: "sleep 2.2 & exit 0" },
        { commands: { test: { exitCode: 0, fingerprints: [], durationMs: 100 } } },
        ["test"],
      );
      expect(gate).toMatchObject({ pass: true, meta: { reapError: expect.stringMatching(/EPERM/) } });

      errno = "ESRCH";
      const silent = await sh("sleep 2.2 & exit 0", dir, 4_000);
      expect(silent.reapError).toBeUndefined();
      expect(silent.reapedGroup).toBeUndefined();
    } finally {
      spy.mockRestore();
      if (groupId !== undefined) {
        try { realKill(-groupId, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }, 20_000);
});

describe("refs probe (OBS-983/984)", () => {
  test("test: the refs probe run from a linked worktree names the main repository's refs directory, a writable repository reports ok and leaves no preflight ref behind, and a read-only one reports the path with git's own error, so a probe that inspects the worktree's git file instead of the common dir fails", async () => {
    const mainRepo = makeRepo({ "a.txt": "hello\n" });
    const wt = await createWorktree(mainRepo, "probe-branch", await gitHead(mainRepo));
    const mainRefsDir = realpathSync(join(mainRepo, ".git", "refs"));

    // 1. Writable repository from linked worktree
    const writableProbe = await probeRefsWritable(wt);
    expect(writableProbe.ok).toBe(true);
    expect(writableProbe.path).toBe(mainRefsDir);
    expect(writableProbe.refsDir).toBe(mainRefsDir);

    // Leaves no preflight ref behind
    const remainingRefs = await shGit("git for-each-ref refs/tickmarkr/preflight", wt);
    expect(remainingRefs.stdout.trim()).toBe("");

    // 2. Read-only refs directory
    // Note: in the linked worktree wt, wt/.git is a gitfile that remains writable.
    // Making the main repo's refs directory read-only tests that git resolves to the common dir,
    // and a probe inspecting wt/.git would fail to detect this read-only state.
    chmodSync(mainRefsDir, 0o555);
    try {
      const roProbe = await probeRefsWritable(wt);
      expect(roProbe.ok).toBe(false);
      expect(roProbe.path).toBe(mainRefsDir);
      expect(roProbe.refsDir).toBe(mainRefsDir);
      if (!roProbe.ok) {
        expect(roProbe.error).toMatch(/cannot lock ref|unable to create directory|update_ref failed/);
        expect(roProbe.error).toContain(mainRefsDir);
      }
    } finally {
      chmodSync(mainRefsDir, 0o755);
    }
  });

  test("assertRefsWritable succeeds on writable repository and throws on read-only refs", async () => {
    const repo = makeRepo({ "b.txt": "hello\n" });
    const refsDir = realpathSync(join(repo, ".git", "refs"));
    const probe = await assertRefsWritable(repo, "run");
    expect(probe.ok).toBe(true);
    expect(probe.path).toBe(refsDir);

    chmodSync(refsDir, 0o555);
    try {
      await expect(assertRefsWritable(repo, "run")).rejects.toThrow(
        new RegExp(`refusing to run: repository refs directory ${refsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not writable`),
      );
      await expect(assertRefsWritable(repo, "resume")).rejects.toThrow(
        new RegExp(`refusing to resume: repository refs directory ${refsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not writable`),
      );
    } finally {
      chmodSync(refsDir, 0o755);
    }
  });

  test("probeRefsWritable returns ok false on non-git directory", async () => {
    const nonGit = mkdtempSync(join(tmpdir(), "non-git-"));
    try {
      const result = await probeRefsWritable(nonGit);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not a git repository|fatal:/);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

const receiptIdentity = (invocation: number) => ({
  runId: "run-receipts", taskId: "T3", attempt: 2, gateRound: 4, invocation: `caller-invocation-${invocation}`,
});

test("test: the shell seam emits a confirmed-start receipt only from the child's spawn event and a terminal receipt naming exit code, signal, timeout or spawn failure, a pre-spawn EAGAIN exhaustion emits terminal spawn-failed with no confirmed start, and invoking the actual shell with an already aborted signal emits cancelled terminal evidence with no confirmed start while preserving cancellation behavior, so a receipt taken from child creation or from the pid callback alone or a lost pre-abort terminal fails", async () => {
  const { shell } = await import("../../src/run/git.js");
  const { CommandReceiptSchema } = await import("../../src/run/protocol.js");
  type Receipt = import("../../src/run/protocol.js").ShellReceipt;
  vi.useFakeTimers();
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    for (const mode of ["exit", "signal", "timeout", "spawn-failure", "cancel"] as const) {
      const receipts: Receipt[] = [];
      const child = Object.assign(new EventEmitter(), {
        pid: 812345, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
      });
      setSpawnForTests((() => child) as unknown as typeof spawn);
      const controller = new AbortController();
      const onSpawn = vi.fn(() => expect(receipts).toEqual([]));
      const result = shell("unused", "/tmp", 1000, false, {
        onSpawn, signal: controller.signal, receiptAttribution: receiptIdentity,
        onReceipt: (receipt) => receipts.push(receipt),
      });
      expect(onSpawn).toHaveBeenCalledWith(child.pid);
      expect(receipts).toEqual([]); // Child creation and the pid callback prove no start.
      if (mode === "spawn-failure") {
        child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
        child.emit("close", -2, null);
        expect(await result).toMatchObject({ code: 127 });
        expect(receipts).toEqual([expect.objectContaining({ outcome: "spawn-failed", confirmedStart: false, error: "Error: spawn ENOENT", exitCode: null })]);
      } else {
        child.emit("spawn");
        expect(receipts).toEqual([{ outcome: "started", confirmedStart: true, pid: child.pid, attribution: receiptIdentity(1) }]);
        if (mode === "timeout") await vi.advanceTimersByTimeAsync(1000);
        if (mode === "cancel") controller.abort();
        const code = mode === "exit" ? 7 : null;
        const signal = mode === "exit" ? null : mode === "signal" ? "SIGTERM" : "SIGKILL";
        child.emit("exit", code, signal);
        child.emit("close", code, signal);
        expect(await result).toMatchObject({ code: code ?? 1, timedOut: mode === "timeout" });
        expect(receipts[1]).toMatchObject({
          outcome: mode === "timeout" ? "timed-out" : mode === "cancel" ? "cancelled" : "completed",
          confirmedStart: true, exitCode: code, signal,
        });
        expect(receipts).toHaveLength(2);
      }
      expect(receipts.every((r) => CommandReceiptSchema.safeParse(r).success)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }

    const receipts: Receipt[] = [];
    setSpawnForTests((() => refusedSpawn("EAGAIN")) as typeof spawn);
    const exhausted = shell("unused", "/tmp", 1000, false, { receiptAttribution: receiptIdentity, onReceipt: (r) => receipts.push(r) });
    await vi.runAllTimersAsync();
    expect(await exhausted).toMatchObject({ code: 127, stderr: expect.stringContaining("EAGAIN") });
    expect(receipts).toHaveLength(SPAWN_ATTEMPT_LIMIT);
    expect(receipts.every((r) => r.outcome === "spawn-failed" && !r.confirmedStart)).toBe(true);
    expect(receipts.map((r) => r.attribution)).toEqual(Array.from({ length: SPAWN_ATTEMPT_LIMIT }, (_, n) => receiptIdentity(n + 1)));
  } finally {
    resetSpawnForTests(); kill.mockRestore(); vi.useRealTimers();
  }
  // Exercise the public, actual shell seam: this used to throw before any evidence could land.
  const controller = new AbortController();
  const reason = new Error("already cancelled");
  controller.abort(reason);
  const receipts: Receipt[] = [];
  const pid = vi.fn();
  expect(() => shell("exit 0", "/tmp", 1000, false, {
    signal: controller.signal, onSpawn: pid, receiptAttribution: receiptIdentity, onReceipt: (r) => receipts.push(r),
  })).toThrow(reason);
  expect(pid).not.toHaveBeenCalled();
  expect(receipts).toEqual([{ outcome: "cancelled", confirmedStart: false, attribution: receiptIdentity(1), exitCode: null, signal: null }]);
  expect(CommandReceiptSchema.safeParse(receipts[0]).success).toBe(true);
});

test("test: every existing pid-callback consumer still receives the pid it received before and each receipt carries the invocation identity the caller supplied, with a retry inside one attempt reported as a new invocation of the same attempt, so an observer that replaces the pid callback or merges two invocations fails", async () => {
  const { shell } = await import("../../src/run/git.js");
  type Receipt = import("../../src/run/protocol.js").ShellReceipt;
  const receipts: Receipt[] = [];
  const pids: Array<number | undefined> = [];
  const suppliedPids: Array<number | undefined> = [];
  const attribution = vi.fn(receiptIdentity);
  let calls = 0;
  setSpawnForTests(((file, args, opts) => {
    const child = ++calls === 1 ? refusedSpawn("EAGAIN") : spawn(file, args as string[], opts as object);
    suppliedPids.push(child.pid);
    return child;
  }) as typeof spawn);
  try {
    expect(await shell("printf receipt", "/tmp", 5000, false, {
      onSpawn: (pid) => pids.push(pid), receiptAttribution: attribution, onReceipt: (r) => receipts.push(r),
    })).toMatchObject({ code: 0, stdout: "receipt" });
    expect(pids).toEqual(suppliedPids);
    expect(pids[0]).toBeUndefined();
    expect(pids[1]).toBeGreaterThan(0);
    expect(attribution.mock.calls).toEqual([[1], [2]]);
    expect(receipts.map((r) => [r.outcome, r.attribution])).toEqual([
      ["spawn-failed", receiptIdentity(1)], ["started", receiptIdentity(2)], ["completed", receiptIdentity(2)],
    ]);
    expect(receipts.slice(1).every((r) => r.pid === pids[1])).toBe(true);
  } finally { resetSpawnForTests(); }
});

// OBS-1173 add.2: the ps identity probe distinguishes a pid that is GONE (ps's clean exit 1 with
// nothing printed, "") from a probe that FAILED and proves nothing (null): its 15 s timeout kill, a
// signal, a spawn error, an overflow, or any other exit. Classified without a real ps or a 15 s wait.
test("processIdentity classifies only ps's clean no-such-process exit as gone; a timeout or signal is a failed probe", () => {
  expect(classifyIdentityProbe(null, " Fri Sep 25   02:00:00 2026\n")).toBe("Fri Sep 25 02:00:00 2026");
  expect(classifyIdentityProbe({ code: 1 }, "")).toBe("");
  expect(classifyIdentityProbe({ code: null, killed: true, signal: "SIGTERM" }, "")).toBeNull();
  expect(classifyIdentityProbe({ code: null, signal: "SIGKILL" }, "")).toBeNull();
  expect(classifyIdentityProbe({ code: "ENOENT" }, "")).toBeNull();
  expect(classifyIdentityProbe({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "Fri")).toBeNull();
  expect(classifyIdentityProbe({ code: 2 }, "")).toBeNull();
  expect(classifyIdentityProbe(null, "")).toBeNull();
});

// A2 (D-787): the Darwin title preload at the one shell seam. Each child reports through a ready file
// AFTER its title writes and then holds until released, so `ps` reads the live process — never a sleep.
describe("Darwin title preload at the shell seam (A2)", () => {
  const REPO_ROOT = join(import.meta.dirname, "../..");
  /** The shipped preload source compiled to CommonJS into a test-owned directory (root dist is shared). */
  const compiledPreload = (dir: string): string => {
    mkdirSync(dir, { recursive: true });
    const out = join(dir, "title-preload.cjs");
    writeFileSync(out, ts.transpileModule(readFileSync(join(REPO_ROOT, "src/run/title-preload.cts"), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
    return out;
  };
  const writeBarrier = (dir: string): string => {
    const barrier = join(dir, "barrier.cjs");
    writeFileSync(barrier, `const fs = require("fs");
module.exports = (ready, release) => {
  fs.writeFileSync(ready + ".tmp", JSON.stringify({ pid: process.pid, title: process.title, nodeOptions: process.env.NODE_OPTIONS ?? null, userHook: globalThis.tkrUserHook === true }));
  fs.renameSync(ready + ".tmp", ready);
  const hold = setInterval(() => { if (fs.existsSync(release)) clearInterval(hold); }, 10);
};
`);
    return barrier;
  };
  const psCommand = (pid: number): string => execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  let held = 0;
  /** Run `script args…` under production shell; read the child's report and its OS-visible command, then release it. */
  const holdChild = async (dir: string, script: string, args: string[], env: NodeJS.ProcessEnv) => {
    const ready = join(dir, `ready-${++held}.json`), release = join(dir, `release-${held}`);
    let settled: Awaited<ReturnType<typeof shell>> | undefined;
    const result = shell([process.execPath, script, ready, release, ...args].map(shq).join(" "), dir, 120_000, false, { env })
      .then((r) => (settled = r));
    try {
      await expect.poll(() => existsSync(ready) || settled !== undefined, { timeout: 60_000, interval: 20 }).toBe(true);
      expect(existsSync(ready), settled?.stderr).toBe(true);
      const report = JSON.parse(readFileSync(ready, "utf8")) as { pid: number; title: string; nodeOptions: string | null; userHook: boolean };
      return { report, ps: psCommand(report.pid) };
    } finally {
      writeFileSync(release, "");
      expect((await result).code).toBe(0);
    }
  };
  afterEach(() => { resetTitleEnvironmentForTests(); resetSpawnForTests(); });

  test("test: production shell Darwin mode appends one quoted inherited preload at a space-bearing absolute path versus unchanged Linux or native opt-out environments; JS title updates retain the native ps command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tkr title "));
    try {
      const preload = compiledPreload(join(dir, "pre load"));
      const option = `--require "${preload}"`;
      const child = join(dir, "title child.cjs");
      writeFileSync(child, `process.title = "tkr-js-title";\nrequire(${JSON.stringify(writeBarrier(dir))})(process.argv[2], process.argv[3]);\n`);
      const own = "--max-old-space-size=4096";
      // Another tickmarkr install's shipped preload (a nested shell under it) is managed too; a user's own hook
      // that happens to share the file name is not, and keeps running in every mode.
      const otherInstall = join(dir, "other install");
      const other = `--require "${compiledPreload(join(otherInstall, "dist/run"))}"`;
      writeFileSync(join(otherInstall, "package.json"), JSON.stringify({ name: "tickmarkr" }));
      const userHook = join(dir, "project", "title-preload.cjs");
      mkdirSync(join(dir, "project"));
      writeFileSync(userHook, "globalThis.tkrUserHook = true;\n");
      const user = `--require "${userHook}"`;
      for (const row of [
        { platform: "darwin" as const, inherited: own, optOut: false, expected: `${own} ${option}` },
        // a nested shell inherits the option already: still exactly one
        { platform: "darwin" as const, inherited: `${own} ${option}`, optOut: false, expected: `${own} ${option}` },
        { platform: "linux" as const, inherited: own, optOut: false, expected: own },
        { platform: "darwin" as const, inherited: own, optOut: true, expected: own },
        // a nested shell's inherited preload never outlives native mode: opt-out and Linux both drop it
        { platform: "darwin" as const, inherited: `${option} ${own}`, optOut: true, expected: own },
        { platform: "linux" as const, inherited: `${own} ${option}`, optOut: false, expected: own },
        // when the inherited preload was all there was, the native child's NODE_OPTIONS is unset, not empty
        { platform: "darwin" as const, inherited: option, optOut: true, expected: null },
        { platform: "darwin" as const, inherited: `${own} ${other}`, optOut: false, expected: `${own} ${option}` },
        { platform: "darwin" as const, inherited: `${other} ${own}`, optOut: true, expected: own },
        // the user's hook is kept byte-identical and runs; in Darwin its --require is an option the probe cannot vouch for
        { platform: "linux" as const, inherited: `${own} ${user}`, optOut: false, expected: `${own} ${user}` },
        { platform: "darwin" as const, inherited: `${own} ${user}`, optOut: true, expected: `${own} ${user}` },
        { platform: "darwin" as const, inherited: `${own} ${user}`, optOut: false, expected: `${own} ${user}` },
      ]) {
        setTitleEnvironmentForTests({ platform: row.platform, preloadPath: preload });
        const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: row.inherited };
        if (row.optOut) env[NATIVE_PROCESS_TITLE_ENV] = "1"; else delete env[NATIVE_PROCESS_TITLE_ENV];
        const { report, ps } = await holdChild(dir, child, [], env);
        const preloaded = row.expected?.includes(option) ?? false;
        expect(report.nodeOptions, JSON.stringify(row)).toBe(row.expected);
        expect((report.nodeOptions ?? "").split(option).length - 1).toBe(preloaded ? 1 : 0);
        expect(report.userHook).toBe(row.inherited.includes(user));
        expect(report.title).toBe("tkr-js-title"); // the child reads back its own write in every mode
        if (preloaded) {
          expect(ps).toContain(child);
          expect(ps).not.toContain("tkr-js-title");
        } else expect(ps).toBe("tkr-js-title");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 300_000);

  test("test: production shell preserves native npm secret hiding for npm-cli entry paths of majors 9 10 and 11 while ordinary vitest forks and threads use the JS setter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tkr-title-npm-"));
    try {
      setTitleEnvironmentForTests({ platform: "darwin", preloadPath: compiledPreload(join(dir, "preload")) });
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "" };
      delete env[NATIVE_PROCESS_TITLE_ENV];
      const barrier = writeBarrier(dir);
      // Each major's installed layout; the entry replaces its argv with the native title first thing, as
      // npm's lib/cli/entry.js does. Two run through the `npm` link on PATH, as a shell invokes npm.
      for (const { major, pkg, run } of [
        { major: 9, pkg: "nvm/versions/node/v18.20.4/lib/node_modules/npm", run: "nvm/versions/node/v18.20.4/lib/node_modules/npm/bin/npm-cli.js" },
        { major: 10, pkg: "project/node_modules/npm", run: "project/node_modules/.bin/npm" },
        { major: 11, pkg: "homebrew/lib/node_modules/npm", run: "homebrew/bin/npm" },
      ]) {
        mkdirSync(join(dir, pkg, "bin"), { recursive: true });
        writeFileSync(join(dir, pkg, "package.json"), JSON.stringify({ name: "npm", version: `${major}.9.0`, bin: { npm: "bin/npm-cli.js" } }));
        const entry = join(dir, pkg, "bin/npm-cli.js");
        writeFileSync(entry, `#!/usr/bin/env node\nprocess.title = "npm";\nprocess.title = "npm --version";\nrequire(${JSON.stringify(barrier)})(process.argv[2], process.argv[3]);\n`);
        if (!run.endsWith("npm-cli.js")) {
          mkdirSync(join(dir, run, ".."), { recursive: true });
          symlinkSync(entry, join(dir, run));
        }
        const secret = `--//registry.example/:_authToken=SECRET-${major}`;
        const { report, ps } = await holdChild(dir, join(dir, run), [secret], env);
        expect(report.nodeOptions).toContain("title-preload.cjs");
        expect(ps, `npm ${major}`).toBe("npm --version");
        expect(ps).not.toContain("SECRET");
      }
      // Vitest's main process writes `node (vitest)` and its workers `node (vitest N)`; the fixture worker writes
      // one too. Under the preload every one of those writes stays in JS in both pool kinds: the worker's
      // process (a fork, or the main process itself for threads) and a fork's parent main show no vitest title.
      const project = join(dir, "pools");
      mkdirSync(project);
      writeFileSync(join(project, "title.test.mjs"), `import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
test("title", () => {
  process.title = "node (vitest fixture)";
  const ps = (pid) => execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const jsSetter = typeof Object.getOwnPropertyDescriptor(process, "title").get === "function";
  writeFileSync(process.env.TKR_TITLE_REPORT, JSON.stringify({ jsSetter, title: process.title, ps: ps(process.pid), parentPs: ps(process.ppid), isMainThread }));
});
`);
      const vitest = join(REPO_ROOT, "node_modules/vitest/vitest.mjs");
      for (const pool of ["forks", "threads"]) {
        const report = join(dir, `${pool}.json`);
        const r = await shell([process.execPath, vitest, "run", "--globals", "--configLoader", "runner", "--root", project, "--pool", pool].map(shq).join(" "),
          project, 120_000, false, { env: { ...env, TKR_TITLE_REPORT: report } });
        expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
        const seen = JSON.parse(readFileSync(report, "utf8")) as { jsSetter: boolean; title: string; ps: string; parentPs: string; isMainThread: boolean };
        expect(seen, pool).toMatchObject({ jsSetter: true, title: "node (vitest fixture)", isMainThread: pool === "forks" });
        expect(seen.ps).toContain("node");
        expect(seen.ps).not.toContain("(vitest");
        if (pool === "forks") expect(seen.parentPs).not.toContain("(vitest");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 300_000);

  test("test: production shell preflights a refused preload then starts one native payload and never repeats an already-started payload that exits with the same refusal text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tkr-title-refused-"));
    try {
      const refused = join(dir, "refused-preload.cjs");
      writeFileSync(refused, 'process.stderr.write("TKR_PRELOAD_REFUSED\\n");\nprocess.exit(7);\n');
      const probes: Array<{ command: string; args: readonly string[]; nodeOptions?: string; cwd?: unknown; timeout?: number; killSignal?: unknown }> = [];
      const spawned: string[] = [];
      const probeWith = (answer: (...a: Parameters<typeof spawnSync>) => ReturnType<typeof spawnSync>) => ((...a: Parameters<typeof spawnSync>) => {
        const options = a[2] as { env?: NodeJS.ProcessEnv; cwd?: unknown; timeout?: number; killSignal?: unknown };
        probes.push({ command: a[0], args: a[1] as string[], nodeOptions: options.env?.NODE_OPTIONS, cwd: options.cwd, timeout: options.timeout, killSignal: options.killSignal });
        return answer(...a);
      }) as typeof spawnSync;
      setSpawnForTests(((command: string, args: readonly string[], options: object) => {
        spawned.push(args.at(-1)!);
        return spawn(command, args, options);
      }) as unknown as typeof spawn);
      const marker = join(dir, "payload.log");
      const own = "--max-old-space-size=4096";
      const payload = `echo started >> ${shq(marker)}; printf '%s' "$NODE_OPTIONS"; echo TKR_PRELOAD_REFUSED >&2; exit 7`;
      const env = { ...process.env, NODE_OPTIONS: own };
      // The real runner node refuses this preload: native payloads, one start each, one probe in all — run under
      // the preload alone in its own directory, so neither the operator's options nor a payload cwd key it.
      setTitleEnvironmentForTests({ platform: "darwin", preloadPath: refused, probe: probeWith((...a) => spawnSync(...a)) });
      for (let round = 1; round <= 2; round++) {
        const r = await shell(payload, dir, 60_000, false, { env });
        expect(r).toMatchObject({ code: 7, stdout: own });
        expect(r.stderr).toContain("TKR_PRELOAD_REFUSED");
        expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(round);
      }
      // A nested shell inherits the refused preload from its parent: the native fallback removes it, so the
      // one node payload starts and exits on its own terms rather than the preload's 7, and nothing re-probes.
      const nodePayload = [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(marker)}, "started\\n"); process.stdout.write(process.env.NODE_OPTIONS)`].map(shq).join(" ");
      const nested = await shell(nodePayload, dir, 60_000, false, { env: { ...env, NODE_OPTIONS: `${own} --require "${refused}"` } });
      expect(nested, nested.stderr).toMatchObject({ code: 0, stdout: own });
      expect(nested.stderr).not.toContain("TKR_PRELOAD_REFUSED");
      expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(3);
      // D-827: the refused (execPath, content, mode) triple stays refused under a changed heap size from another cwd.
      const sub = join(dir, "payload cwd");
      mkdirSync(sub);
      const resized = await shell(nodePayload, sub, 60_000, false, { env: { ...env, NODE_OPTIONS: "--max-old-space-size=8192" } });
      expect(resized, resized.stderr).toMatchObject({ code: 0, stdout: "--max-old-space-size=8192" });
      expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(4);
      expect(probes).toEqual([{ command: process.execPath, args: ["-e", ""], nodeOptions: `--require "${refused}"`, cwd: dir, timeout: TITLE_PREFLIGHT_TIMEOUT_MS, killSignal: "SIGKILL" }]);
      expect(spawned).toEqual([payload, payload, nodePayload, nodePayload]);
      // The closed preflight table: an accepted probe preloads; one killed at its ceiling, a nonzero exit
      // and a thrown spawn each fail open. Every member is probed once and never through the payload seam.
      const tableMarker = join(dir, "table.log");
      for (const member of [
        { name: "accepted", preloaded: true, answer: () => ({ status: 0, signal: null }) },
        { name: "never returns", preloaded: false, answer: () => ({ status: null, signal: "SIGKILL", error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }) }) },
        { name: "nonzero", preloaded: false, answer: () => ({ status: 1, signal: null }) },
        { name: "spawn throws", preloaded: false, answer: () => { throw Object.assign(new Error("spawnSync EAGAIN"), { code: "EAGAIN" }); } },
      ]) {
        probes.length = 0;
        spawned.length = 0;
        setTitleEnvironmentForTests({ probe: probeWith(member.answer as unknown as (...a: Parameters<typeof spawnSync>) => ReturnType<typeof spawnSync>) });
        const command = `echo started >> ${shq(tableMarker)}; printf '%s' "$NODE_OPTIONS"`;
        for (let round = 0; round < 2; round++) {
          const r = await shell(command, dir, 60_000, false, { env });
          expect(r.stdout, member.name).toBe(member.preloaded ? `${own} --require "${refused}"` : own);
        }
        expect(probes, member.name).toHaveLength(1);
        expect(spawned).toEqual([command, command]);
      }
      expect(readFileSync(tableMarker, "utf8").trim().split("\n")).toHaveLength(8);
      // D-827: the operator's own options can refuse a sound preload the probe accepted — a cwd-relative permission
      // grant denies reading it from a payload cwd other than the probe's — so options the one probe cannot vouch
      // for (the permission model, another loader, any cwd-relative path) select native payloads in every cwd with
      // no probe, while a changed heap size from another cwd reuses the single accepted probe.
      const permission = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
      const preload = compiledPreload(join(dir, "pre load"));
      const relativeGrant = `${permission} --allow-fs-read=./*`;
      const denied = spawnSync(process.execPath, ["-e", ""], { cwd: sub, encoding: "utf8", env: { ...env, NODE_OPTIONS: `${relativeGrant} --require "${preload}"` } });
      expect(denied.stderr).toContain("ERR_ACCESS_DENIED"); // the payload's failure this rule prevents
      const hook = join(dir, "hook.cjs");
      writeFileSync(hook, "");
      setTitleEnvironmentForTests({ preloadPath: preload, probe: probeWith((...a) => spawnSync(...a)) });
      probes.length = 0;
      spawned.length = 0;
      const guarded = [process.execPath, "-e", `process.stdout.write(JSON.stringify({ options: process.env.NODE_OPTIONS, fsRead: process.permission?.has("fs.read") ?? null }))`].map(shq).join(" ");
      const report = async (cwd: string, options: string): Promise<unknown> => {
        const r = await shell(guarded, cwd, 60_000, false, { env: { ...env, NODE_OPTIONS: options } });
        expect(r.code, `${options}\n${r.stderr}`).toBe(0);
        return JSON.parse(r.stdout);
      };
      expect(await report(dir, own)).toEqual({ options: `${own} --require "${preload}"`, fsRead: null });
      expect(await report(sub, "--max-old-space-size=8192")).toEqual({ options: `--max-old-space-size=8192 --require "${preload}"`, fsRead: null });
      const uncertified = [relativeGrant, permission, `--require ${hook}`, "--redirect-warnings=./warnings.log"];
      for (const options of uncertified) {
        expect(await report(sub, options), options).toEqual({ options, fsRead: options.startsWith(permission) ? false : null });
      }
      // Node takes `_` for `-` in an option name: Node 20.3.1's `--experimental_permission` refuses the preload's
      // read exactly as the hyphen spelling does, so each underscore spelling is classified and stays native too.
      // A shell payload reports what the child received, since today's runner node rejects Node 20's flag itself.
      const received = `printf '%s' "$NODE_OPTIONS"`;
      const underscored = ["--experimental_permission", "--allow_fs_read=*", "--experimental_loader=/abs/hook.mjs", "--experimental_policy=/abs/policy.json"];
      for (const options of underscored) {
        const r = await shell(received, sub, 60_000, false, { env: { ...env, NODE_OPTIONS: options } });
        expect(r, options).toMatchObject({ code: 0, stdout: options });
      }
      expect(probes.map((p) => [p.nodeOptions, p.cwd])).toEqual([[`--require "${preload}"`, join(dir, "pre load")]]);
      expect(spawned).toEqual([...Array(2 + uncertified.length).fill(guarded), ...Array(underscored.length).fill(received)]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);
});
