import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type CodexCommitProbe, type CodexSandbox, codexSandboxArgs, probeCodexCommit } from "../../src/adapters/codex-commit-check.js";
import { makeRepo } from "../helpers/tmprepo.js";

test("doctor removes its probe lock and fixture worktree after allowed denied or cancelled probes while preserving a pre-existing foreign lock", async () => {
  const cancel = new AbortController();
  const cases: Array<{ want: string; sandbox: CodexSandbox; signal?: AbortSignal }> = [
    { want: "allowed", sandbox: async (p) => { writeFileSync(p.control, p.token); writeFileSync(p.lock, p.token); return "control=ok\nlock=ok\n"; } },
    { want: "protected", sandbox: async (p) => { writeFileSync(p.control, p.token); return `control=ok\nlock=fail sh: ${p.lock}: Permission denied\n`; } },
    // cancelled mid-probe, after the lock landed: the verdict is unknown and the lock still goes
    { want: "unknown", signal: cancel.signal, sandbox: async (p) => { writeFileSync(p.control, p.token); writeFileSync(p.lock, p.token); cancel.abort(); throw new Error("aborted"); } },
  ];
  for (const { want, sandbox, signal } of cases) {
    const repo = makeRepo({ "keep.txt": "x" });
    // someone else's git operation in the main checkout holds ITS index.lock throughout
    const foreign = join(repo, ".git", "index.lock");
    writeFileSync(foreign, "foreign");
    let seen: CodexCommitProbe | undefined;
    const result = await probeCodexCommit(repo, async (p) => { seen = p; return sandbox(p); }, signal);

    expect(result.status, want).toBe(want);
    if (signal) expect(result.detail).toBe("probe cancelled");
    expect(seen!.lock).toMatch(/\.git\/worktrees\/[^/]+\/index\.lock$/);
    expect(existsSync(seen!.lock), want).toBe(false);
    expect(existsSync(seen!.worktree), want).toBe(false);
    expect(readdirSync(join(repo, ".git")), want).not.toContain("worktrees");
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
    expect(readFileSync(foreign, "utf8"), want).toBe("foreign");
    // the production sandbox grant names the exact directory holding index.lock, beside the common dir
    expect(codexSandboxArgs(seen!)).toContain(`sandbox_workspace_write.writable_roots=${JSON.stringify([seen!.commonDir, dirname(seen!.lock)])}`);
  }

  // a foreign lock at the FIXTURE's own index.lock path (another process won the race right after checkout):
  // the sandbox never runs, and neither worktree removal nor pruning may take the lock's metadata with it
  const repo = makeRepo({ "keep.txt": "x" });
  writeFileSync(join(repo, ".git", "hooks", "post-checkout"), '#!/bin/sh\nprintf foreign > "$(git rev-parse --absolute-git-dir)/index.lock"\n', { mode: 0o755 });
  let called = false;
  const result = await probeCodexCommit(repo, async () => { called = true; return ""; });
  expect(result).toEqual({ status: "unknown", detail: "a foreign index.lock already holds the fixture worktree" });
  expect(called).toBe(false);
  const [name] = readdirSync(join(repo, ".git", "worktrees"));
  expect(readFileSync(join(repo, ".git", "worktrees", name!, "index.lock"), "utf8")).toBe("foreign");
  // the fixture checkout itself is still gone
  expect(existsSync(dirname(readFileSync(join(repo, ".git", "worktrees", name!, "gitdir"), "utf8").trim()))).toBe(false);

  // consecutive probes: a later allowed probe in the same repository cleans up only its own fixture and
  // leaves the earlier probe's foreign lock (and its metadata) alone
  const hook = join(repo, ".git", "hooks", "post-checkout");
  rmSync(hook);
  const next = await probeCodexCommit(repo, async (p) => { writeFileSync(p.control, p.token); writeFileSync(p.lock, p.token); return "control=ok\nlock=ok\n"; });
  expect(next.status).toBe("allowed");
  expect(readdirSync(join(repo, ".git", "worktrees"))).toEqual([name]);
  expect(readFileSync(join(repo, ".git", "worktrees", name!, "index.lock"), "utf8")).toBe("foreign");

  // a post-checkout hook that writes a foreign lock and then FAILS `worktree add`: the lock path is known
  // before the add, so cleanup still sees the lock as foreign and keeps it
  const failing = makeRepo({ "keep.txt": "x" });
  writeFileSync(join(failing, ".git", "hooks", "post-checkout"), '#!/bin/sh\nprintf foreign > "$(git rev-parse --absolute-git-dir)/index.lock"\nexit 1\n', { mode: 0o755 });
  called = false;
  const failed = await probeCodexCommit(failing, async () => { called = true; return ""; });
  expect(failed.status).toBe("unknown");
  expect(called).toBe(false);
  const [left] = readdirSync(join(failing, ".git", "worktrees"));
  expect(readFileSync(join(failing, ".git", "worktrees", left!, "index.lock"), "utf8")).toBe("foreign");
});
