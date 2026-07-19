import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { createWorktree, gitHead, shOk, WORKTREES_DIR } from "../../src/run/git.js";
import { ensureIntegration, integrationBranch, integrationHead, mergeTask } from "../../src/run/merge.js";
import { makeRepo } from "../helpers/tmprepo.js";

const commitAll = (cwd: string, msg: string) =>
  execSync(`git add -A && git commit -m '${msg}' --no-gpg-sign`, { cwd });

describe("integration merge", () => {
  test("branch naming uses prefix + runId, never main", () => {
    expect(integrationBranch(DEFAULT_CONFIG, "run-1")).toBe("tickmarkr/run-1");
  });

  test("a fresh integration branch uses the tickmarkr prefix", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const branch = integrationBranch(DEFAULT_CONFIG, "run-fresh");
    const intWt = await ensureIntegration(repo, branch, await gitHead(repo));
    expect((await shOk("git branch --show-current", intWt)).trim()).toBe("tickmarkr/run-fresh");
    // OBS-49: the merge path resolves under worktrees.noindex from the same constant as worktreePath()
    expect(intWt).toContain(`.tickmarkr/${WORKTREES_DIR}/tickmarkr-run-fresh`);
  });

  test("a fresh integration worktree symlinks the repo's node_modules", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const modules = join(repo, "node_modules");
    mkdirSync(modules);

    const intWt = await ensureIntegration(repo, "tickmarkr/run-modules", await gitHead(repo));
    const link = join(intWt, "node_modules");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(modules));
  });

  test("ensureIntegration restores a missing node_modules link on resume", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const modules = join(repo, "node_modules");
    mkdirSync(modules);
    const intWt = await ensureIntegration(repo, "tickmarkr/run-resume-modules", await gitHead(repo));
    rmSync(join(intWt, "node_modules"), { force: true });

    await ensureIntegration(repo, "tickmarkr/run-resume-modules", await gitHead(repo));

    expect(lstatSync(join(intWt, "node_modules")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(intWt, "node_modules"))).toBe(realpathSync(modules));
  });

  test("a legacy integration branch keeps its branch and worktree on resume", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    await shOk("git branch tickmarkr/run-legacy", repo);

    const intWt = await ensureIntegration(repo, "tickmarkr/run-legacy", base);

    expect((await shOk("git branch --show-current", intWt)).trim()).toBe("tickmarkr/run-legacy");
    const taskWt = await createWorktree(repo, "tickmarkr/run-legacy--T1", await integrationHead(intWt));
    expect((await shOk("git branch --show-current", taskWt)).trim()).toBe("tickmarkr/run-legacy--T1");
  });

  test("merge two task branches in dependency order; main untouched", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    const intWt = await ensureIntegration(repo, "tickmarkr/run-1", base);

    // task branches use "--" — a branch tickmarkr/run-1 blocks any ref under tickmarkr/run-1/ (locked decision 10)
    const wt1 = await createWorktree(repo, "tickmarkr/run-1--T1", await integrationHead(intWt));
    writeFileSync(join(wt1, "t1.txt"), "one\n");
    commitAll(wt1, "T1");
    expect((await mergeTask(intWt, "tickmarkr/run-1--T1", "tickmarkr: merge T1", await gitHead(wt1))).ok).toBe(true);

    // T2 branches AFTER T1 merged → sees t1.txt (dep visibility)
    const wt2 = await createWorktree(repo, "tickmarkr/run-1--T2", await integrationHead(intWt));
    expect((await shOk("ls", wt2))).toContain("t1.txt");
    writeFileSync(join(wt2, "t2.txt"), "two\n");
    commitAll(wt2, "T2");
    expect((await mergeTask(intWt, "tickmarkr/run-1--T2", "tickmarkr: merge T2", await gitHead(wt2))).ok).toBe(true);

    expect(await shOk("git show --stat HEAD", intWt)).toContain("T2");
    expect((await shOk("ls", intWt))).toContain("t1.txt");
    // main untouched
    expect((await shOk("git log --oneline main", repo)).trim().split("\n")).toHaveLength(1);
  });

  test("refuses a task branch whose tip moved after gating (OBS-15)", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    const intWt = await ensureIntegration(repo, "tickmarkr/run-tip-moved", base);
    const wt = await createWorktree(repo, "tickmarkr/run-tip-moved--T1", base);
    writeFileSync(join(wt, "task.txt"), "gated\n");
    commitAll(wt, "gated");
    const gated = await gitHead(wt);
    writeFileSync(join(wt, "task.txt"), "ungated\n");
    commitAll(wt, "ungated");
    const current = await gitHead(wt);

    const r = await mergeTask(intWt, "tickmarkr/run-tip-moved--T1", "merge T1", gated);

    expect(r).toEqual({ ok: false, tipMoved: { gatedCommit: gated, branchTip: current } });
    expect(await integrationHead(intWt)).toBe(base);
  });

  test("conflict: aborts cleanly and reports files", async () => {
    const repo = makeRepo({ "shared.txt": "orig\n" });
    const base = await gitHead(repo);
    const intWt = await ensureIntegration(repo, "tickmarkr/run-2", base);
    const wtA = await createWorktree(repo, "tickmarkr/run-2--TA", base);
    writeFileSync(join(wtA, "shared.txt"), "A\n");
    commitAll(wtA, "TA");
    await mergeTask(intWt, "tickmarkr/run-2--TA", "merge TA", await gitHead(wtA));
    const wtB = await createWorktree(repo, "tickmarkr/run-2--TB", base); // same base → conflict with TA
    writeFileSync(join(wtB, "shared.txt"), "B\n");
    commitAll(wtB, "TB");
    const r = await mergeTask(intWt, "tickmarkr/run-2--TB", "merge TB", await gitHead(wtB));
    expect(r.ok).toBe(false);
    expect(r.conflict).toContain("shared.txt");
    // aborted: worktree clean, next merge still possible
    expect((await shOk("git status --porcelain", intWt)).trim()).toBe("");
  });

  test("ensureIntegration on resume keeps existing tip", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    const intWt = await ensureIntegration(repo, "tickmarkr/run-3", base);
    writeFileSync(join(intWt, "x.txt"), "x\n");
    commitAll(intWt, "progress");
    const tip = await integrationHead(intWt);
    const intWt2 = await ensureIntegration(repo, "tickmarkr/run-3", base);
    expect(await integrationHead(intWt2)).toBe(tip); // not reset to base
  });

  test("metacharacter taskBranch never executes shell injection (HARD-01)", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    const intWt = await ensureIntegration(repo, "tickmarkr/run-4", base);
    const r = await mergeTask(intWt, "x'; touch PWNED #", "tickmarkr: merge T1", base);
    expect(r.ok).toBe(false);
    expect(existsSync(join(intWt, "PWNED"))).toBe(false);
    expect(existsSync(join(repo, "PWNED"))).toBe(false);
  });

  test("apostrophe in merge message is preserved (HARD-01)", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    const intWt = await ensureIntegration(repo, "tickmarkr/run-5", base);
    const wt = await createWorktree(repo, "tickmarkr/run-5--T1", await integrationHead(intWt));
    writeFileSync(join(wt, "t1.txt"), "one\n");
    commitAll(wt, "T1");
    const r = await mergeTask(intWt, "tickmarkr/run-5--T1", "tickmarkr: merge T1 don't panic", await gitHead(wt));
    expect(r.ok).toBe(true);
    expect((await shOk("git log -1 --format=%s", intWt))).toContain("don't");
  });
});
