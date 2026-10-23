import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { beginGateEvidence, captureBaseline } from "../../src/gates/baseline.js";
import { sh } from "../../src/run/git.js";
import { GitTrustRefusal } from "../../src/run/git-trust.js";
import { resolveStateDir } from "../../src/gates/cache.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// Queue row 2 item a (D-2112, D-2114): observational gate lookups cannot follow a worker's pointer.
test("test: in a linked worktree whose commondir names a foreign repository holding its branch, a gate command's evidence receipt records no foreign subject and the gate state directory resolves outside that repository, while an intact worktree's receipt records its own HEAD, so a lookup following the rewritten commondir fails", async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const repo = realpathSync(makeRepo({ own: "own" }));
  const foreign = realpathSync(makeRepo({ foreign: "foreign" }));
  const branch = "tickmarkr/task";
  const worktree = join(makeTestTempDir("gate-trusted-"), "task");
  git(repo, "worktree", "add", "-qb", branch, worktree);
  git(foreign, "branch", branch);
  const ownHead = git(repo, "rev-parse", "HEAD");
  const foreignHead = git(foreign, "rev-parse", "HEAD");
  expect(ownHead).not.toBe(foreignHead);
  const gitdir = git(worktree, "rev-parse", "--absolute-git-dir");
  mkdirSync(join(repo, ".tickmarkr"));
  mkdirSync(join(foreign, ".tickmarkr"));
  const intact = await captureBaseline(worktree, { build: "printf own" }, { evidence: { artifactDir: makeTestTempDir("gate-intact-") } });
  expect(intact.evidenceReceipts!.build!.subject.subjectCommit).toBe(ownHead);
  expect(intact.evidenceReceipts!.build!.termination.exitCode).toBe(0);
  const commondir = join(gitdir, "commondir");
  const before = readFileSync(commondir);
  try {
    writeFileSync(commondir, `${foreign}/.git\n`);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(foreignHead);
    const evidence = beginGateEvidence(worktree, "build", "printf own", { artifactDir: makeTestTempDir("gate-refused-") });
    await expect(sh("printf own", worktree, undefined, { onReceipt: receipt => evidence.observe(receipt) })).rejects.toBeInstanceOf(GitTrustRefusal);
    const redirected = evidence.finish();
    expect(redirected.subject.subjectCommit).toBeNull();
    expect(redirected.subject.subjectCommit).not.toBe(foreignHead);
    expect(resolveStateDir(worktree)).toBe(join(repo, ".tickmarkr"));
    expect(resolveStateDir(worktree).startsWith(foreign)).toBe(false);
  } finally { writeFileSync(commondir, before); }
});
