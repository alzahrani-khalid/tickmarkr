import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { expect, test } from "vitest";
import { renderCodexGitGrant } from "../../src/adapters/codex.js";
import { type CodexCommitProbe, type CodexSandbox, codexSandboxArgs, probeCodexCommit } from "../../src/adapters/codex-commit-check.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// The probe's own commit, made the way its sandbox script makes it (v2.6.6 T9 K receipts).
const commitAsProbe = (p: CodexCommitProbe) => {
  writeFileSync(p.control, p.token);
  execFileSync("git", ["add", "--", p.control], { cwd: p.worktree });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-gpg-sign", "-m", `tickmarkr-probe ${p.token}`], { cwd: p.worktree });
};
// queue row 2 item b: the fixture git runs with hooks inert, so a foreign lock is planted by a git stand-in on PATH right
// after the fixture's `worktree add` (the race the probe guards against), never by a post-checkout hook; `fail` also
// fails the add. A planted post-checkout hook writes `marker` instead: protected fixture git never fires it.
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const lockingGit = (fail: boolean): string => {
  const dir = makeTestTempDir("lock-git-");
  writeFileSync(join(dir, "git"), `#!/bin/sh\n'${realGit}' "$@"; s=$?\n`
    + `if [ "$1" = worktree ] && [ "$2" = add ]; then printf foreign > "$('${realGit}' rev-parse --path-format=absolute --git-common-dir)/worktrees/$(basename "$5")/index.lock"; ${fail ? "exit 1" : "exit $s"}; fi\nexit $s\n`, { mode: 0o755 });
  return dir;
};
const plantHook = (repo: string): string => {
  const marker = join(repo, "hook-fired");
  writeFileSync(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\nprintf fired > '${marker}'\n`, { mode: 0o755 });
  return marker;
};
const withPath = async <T>(dir: string, body: () => Promise<T>): Promise<T> => {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try { return await body(); } finally { process.env.PATH = saved; }
};
const probeBranches = (repo: string) => execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/tickmarkr-probe-*"], { cwd: repo, encoding: "utf8" }).trim();

test("doctor's codex probe with its fixture git protected still reports allowed, protected and unknown as before and still preserves a foreign index lock at its fixture's metadata path, so a probe whose foreign-lock handling depended on a post-checkout hook firing fails", async () => {
  const cancel = new AbortController();
  const cases: Array<{ want: string; sandbox: CodexSandbox; signal?: AbortSignal }> = [
    { want: "allowed", sandbox: async (p) => { commitAsProbe(p); writeFileSync(p.lock, p.token); return "control=ok\ncommit=ok\nhook=denied\nroot=denied\n"; } },
    { want: "protected", sandbox: async (p) => { writeFileSync(p.control, p.token); return "control=ok\ncommit=fail\nhook=denied\nroot=denied\n"; } },
    // cancelled mid-probe, after the lock landed: the verdict is unknown and the lock still goes
    { want: "unknown", signal: cancel.signal, sandbox: async (p) => { writeFileSync(p.control, p.token); writeFileSync(p.lock, p.token); cancel.abort(); throw new Error("aborted"); } },
  ];
  for (const { want, sandbox, signal } of cases) {
    const repo = makeRepo({ "keep.txt": "x" });
    const marker = plantHook(repo);
    // someone else's git operation in the main checkout holds ITS index.lock throughout
    const foreign = join(repo, ".git", "index.lock");
    writeFileSync(foreign, "foreign");
    let seen: CodexCommitProbe | undefined;
    const result = await probeCodexCommit(repo, async (p) => { seen = p; return sandbox(p); }, signal);

    expect(result.status, want).toBe(want);
    expect(existsSync(marker), want).toBe(false);
    if (signal) expect(result.detail).toBe("probe cancelled");
    expect(seen!.lock).toMatch(/\.git\/worktrees\/[^/]+\/index\.lock$/);
    expect(existsSync(seen!.lock), want).toBe(false);
    expect(existsSync(seen!.worktree), want).toBe(false);
    expect(readdirSync(join(repo, ".git")), want).not.toContain("worktrees");
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
    expect(readFileSync(foreign, "utf8"), want).toBe("foreign");
    // the fixture branch is the probe's own, and it goes with the fixture
    expect(probeBranches(repo), want).toBe("");
    // Queue row 2 (D-2112): the probe renders its fixture through the shared worker renderer.
    expect(codexSandboxArgs(seen!)[1]).toContain(`codex sandbox -c 'sandbox_mode="workspace-write"' ${renderCodexGitGrant({ cwd: seen!.worktree, branch: seen!.branch, repoRoot: repo })} -- sh -c `);
  }

  // a foreign lock at the FIXTURE's own index.lock path (another process won the race right after checkout):
  // the sandbox never runs, and neither worktree removal nor pruning may take the lock's metadata with it
  const repo = makeRepo({ "keep.txt": "x" });
  const marker = plantHook(repo);
  let called = false;
  const result = await withPath(lockingGit(false), () => probeCodexCommit(repo, async () => { called = true; return ""; }));
  expect(result).toEqual({ status: "unknown", detail: "a foreign index.lock already holds the fixture worktree" });
  expect(called).toBe(false);
  const [name] = readdirSync(join(repo, ".git", "worktrees"));
  expect(readFileSync(join(repo, ".git", "worktrees", name!, "index.lock"), "utf8")).toBe("foreign");
  // the fixture checkout itself is still gone; its branch stays with the metadata left to the lock's owner
  expect(existsSync(dirname(readFileSync(join(repo, ".git", "worktrees", name!, "gitdir"), "utf8").trim()))).toBe(false);
  expect(probeBranches(repo)).toBe(name);
  expect(existsSync(marker)).toBe(false);

  // consecutive probes: a later allowed probe in the same repository cleans up only its own fixture and
  // leaves the earlier probe's foreign lock (and its metadata) alone
  const next = await probeCodexCommit(repo, async (p) => { commitAsProbe(p); writeFileSync(p.lock, p.token); return "control=ok\ncommit=ok\nhook=denied\nroot=denied\n"; });
  expect(next.status).toBe("allowed");
  expect(readdirSync(join(repo, ".git", "worktrees"))).toEqual([name]);
  expect(readFileSync(join(repo, ".git", "worktrees", name!, "index.lock"), "utf8")).toBe("foreign");
  expect(probeBranches(repo)).toBe(name);

  // a post-checkout hook that writes a foreign lock and then FAILS `worktree add`: the lock path is known
  // before the add, so cleanup still sees the lock as foreign and keeps it
  const failing = makeRepo({ "keep.txt": "x" });
  const failingMarker = plantHook(failing);
  called = false;
  const failed = await withPath(lockingGit(true), () => probeCodexCommit(failing, async () => { called = true; return ""; }));
  expect(failed.status).toBe("unknown");
  expect(called).toBe(false);
  const [left] = readdirSync(join(failing, ".git", "worktrees"));
  expect(readFileSync(join(failing, ".git", "worktrees", left!, "index.lock"), "utf8")).toBe("foreign");
  // the hook plant is live: raw git in the same fixture fires it, which the probe's protected fixture git never did
  expect(existsSync(failingMarker)).toBe(false);
  execFileSync("git", ["checkout", "-q", "-b", "raw-control"], { cwd: failing });
  expect(readFileSync(failingMarker, "utf8")).toBe("fired");
});
