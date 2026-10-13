import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { createWorktree, gitHead, shOk, WORKTREES_DIR } from "../../src/run/git.js";
import { ensureIntegration, integrationBranch, mergeTask } from "../../src/run/merge.js";
import { makeRepo } from "../helpers/tmprepo.js";

const commitAll = (cwd: string, msg: string) =>
  execSync(`git add -A && git commit -m '${msg}' --no-gpg-sign`, { cwd });
const refOf = (repo: string, branch: string) => shOk(`git rev-parse refs/heads/${branch}`, repo).then((s) => s.trim());

// 2.8.1 T2 (ANL-023 §7.2): the integration branch is a ref published by compare-and-swap from the stored tip E;
// no checkout of it exists. Every caller passes the tip it set up — nothing defaults `expected`.
describe("integration merge", () => {
  test("branch naming uses prefix + runId, never main", () => {
    expect(integrationBranch(DEFAULT_CONFIG, "run-1")).toBe("tickmarkr/run-1");
  });

  test("a fresh integration branch is created create-only at the base, with no checkout, and E is that base", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    const branch = integrationBranch(DEFAULT_CONFIG, "run-fresh");
    expect(await ensureIntegration(repo, branch, base)).toBe(base);
    expect(await refOf(repo, branch)).toBe(base);
    expect(await shOk(`git reflog show --format=%gs refs/heads/${branch}`, repo)).toContain("tickmarkr: run start");
    expect(await shOk("git worktree list --porcelain", repo)).not.toContain(`branch refs/heads/${branch}`);
    const dir = join(tickmarkrDir(repo), WORKTREES_DIR);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  test("an existing integration branch is never reused: creation refuses and leaves it as found", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    writeFileSync(join(repo, "x.txt"), "x\n");
    commitAll(repo, "progress");
    const other = await gitHead(repo);
    await shOk(`git branch tickmarkr/run-legacy ${base}`, repo);
    await expect(ensureIntegration(repo, "tickmarkr/run-legacy", other))
      .rejects.toThrow(/integration branch tickmarkr\/run-legacy already exists or cannot be created: /);
    expect(await refOf(repo, "tickmarkr/run-legacy")).toBe(base);
  });

  test("merge two task branches in dependency order; each publication names its own commit and from; main untouched", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    let tip = await ensureIntegration(repo, "tickmarkr/run-1", base);
    const published: string[] = [];

    // task branches use "--" — a branch tickmarkr/run-1 blocks any ref under tickmarkr/run-1/ (locked decision 10)
    const wt1 = await createWorktree(repo, "tickmarkr/run-1--T1", tip);
    writeFileSync(join(wt1, "t1.txt"), "one\n");
    commitAll(wt1, "T1");
    const m1 = await mergeTask(repo, { branch: "tickmarkr/run-1", expected: tip }, "tickmarkr/run-1--T1", "tickmarkr: merge T1", await gitHead(wt1), (c) => published.push(c));
    expect(m1).toEqual({ ok: true, commit: published[0], from: base });
    expect(await refOf(repo, "tickmarkr/run-1")).toBe(published[0]);
    tip = published[0]!;

    // T2 branches AFTER T1 merged → sees t1.txt (dep visibility)
    const wt2 = await createWorktree(repo, "tickmarkr/run-1--T2", tip);
    expect((await shOk("ls", wt2))).toContain("t1.txt");
    writeFileSync(join(wt2, "t2.txt"), "two\n");
    commitAll(wt2, "T2");
    const m2 = await mergeTask(repo, { branch: "tickmarkr/run-1", expected: tip }, "tickmarkr/run-1--T2", "tickmarkr: merge T2", await gitHead(wt2), (c) => published.push(c));
    expect(m2).toEqual({ ok: true, commit: published[1], from: published[0] });
    expect(await shOk(`git show --stat ${published[1]}`, repo)).toContain("t2.txt");
    expect(await shOk(`git ls-tree --name-only ${published[1]}`, repo)).toContain("t1.txt");
    expect(await shOk(`git rev-parse ${published[1]}^1 ${published[1]}^2`, repo)).toBe(`${published[0]}\n${await gitHead(wt2)}\n`);
    expect((await shOk("git log --oneline main", repo)).trim().split("\n")).toHaveLength(1);
  });

  test("an ancestorOnly call (a replay that ran no gates) refuses a commit not in E with infra and publishes nothing", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    await ensureIntegration(repo, "tickmarkr/run-ancestor-only", base);
    const wt = await createWorktree(repo, "tickmarkr/run-ancestor-only--T1", base);
    writeFileSync(join(wt, "task.txt"), "ungated\n");
    commitAll(wt, "ungated");
    const published: string[] = [];
    const m = await mergeTask(repo, { branch: "tickmarkr/run-ancestor-only", expected: base, merged: [], ancestorOnly: true },
      "tickmarkr/run-ancestor-only--T1", "tickmarkr: merge T1", await gitHead(wt), (c) => published.push(c));
    expect(m).toMatchObject({ ok: false, infra: { step: "ancestry" } });
    expect(published).toEqual([]);
    expect(await refOf(repo, "tickmarkr/run-ancestor-only")).toBe(base);
    expect((await shOk("git log --all --merges --format=%H", repo)).trim()).toBe(""); // nothing constructed either
  });

  test("refuses a task branch whose tip moved after gating (OBS-15)", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    await ensureIntegration(repo, "tickmarkr/run-tip-moved", base);
    const wt = await createWorktree(repo, "tickmarkr/run-tip-moved--T1", base);
    writeFileSync(join(wt, "task.txt"), "gated\n");
    commitAll(wt, "gated");
    const gated = await gitHead(wt);
    writeFileSync(join(wt, "task.txt"), "ungated\n");
    commitAll(wt, "ungated");
    const current = await gitHead(wt);

    const r = await mergeTask(repo, { branch: "tickmarkr/run-tip-moved", expected: base }, "tickmarkr/run-tip-moved--T1", "merge T1", gated, () => {});

    expect(r).toEqual({ ok: false, tipMoved: { gatedCommit: gated, branchTip: current } });
    expect(await refOf(repo, "tickmarkr/run-tip-moved")).toBe(base);
  });

  test("conflict: reports files from merge-tree and writes no ref", async () => {
    const repo = makeRepo({ "shared.txt": "orig\n" });
    const base = await gitHead(repo);
    await ensureIntegration(repo, "tickmarkr/run-2", base);
    const wtA = await createWorktree(repo, "tickmarkr/run-2--TA", base);
    writeFileSync(join(wtA, "shared.txt"), "A\n");
    commitAll(wtA, "TA");
    let tip = base;
    await mergeTask(repo, { branch: "tickmarkr/run-2", expected: tip }, "tickmarkr/run-2--TA", "merge TA", await gitHead(wtA), (c) => { tip = c; });
    const wtB = await createWorktree(repo, "tickmarkr/run-2--TB", base); // same base → conflict with TA
    writeFileSync(join(wtB, "shared.txt"), "B\n");
    commitAll(wtB, "TB");
    let called = false;
    const r = await mergeTask(repo, { branch: "tickmarkr/run-2", expected: tip }, "tickmarkr/run-2--TB", "merge TB", await gitHead(wtB), () => { called = true; });
    expect(r.ok).toBe(false);
    expect("conflict" in r && r.conflict).toContain("shared.txt");
    expect(called).toBe(false);
    expect(await refOf(repo, "tickmarkr/run-2")).toBe(tip);
  });

  test("a ref moved off the stored tip is never a merge parent: the move is reported and nothing is published", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    await ensureIntegration(repo, "tickmarkr/run-3", base);
    const wt = await createWorktree(repo, "tickmarkr/run-3--T1", base);
    writeFileSync(join(wt, "x.txt"), "x\n");
    commitAll(wt, "progress");
    const foreign = await gitHead(wt);
    await shOk(`git update-ref refs/heads/tickmarkr/run-3 ${foreign}`, repo);
    const r = await mergeTask(repo, { branch: "tickmarkr/run-3", expected: base }, "tickmarkr/run-3--T1", "merge T1", foreign, () => {});
    expect(r).toMatchObject({ ok: false, integrationMoved: { branch: "tickmarkr/run-3", expected: base, found: foreign, leg: "value", stage: "check" } });
    expect(await refOf(repo, "tickmarkr/run-3")).toBe(foreign);
  });

  test("metacharacter taskBranch never executes shell injection (HARD-01)", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    await ensureIntegration(repo, "tickmarkr/run-4", base);
    const r = await mergeTask(repo, { branch: "tickmarkr/run-4", expected: base }, "x'; touch PWNED #", "tickmarkr: merge T1", base, () => {});
    expect(r.ok).toBe(false);
    expect(existsSync(join(repo, "PWNED"))).toBe(false);
  });

  test("apostrophe in merge message is preserved (HARD-01)", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const base = await gitHead(repo);
    await ensureIntegration(repo, "tickmarkr/run-5", base);
    const wt = await createWorktree(repo, "tickmarkr/run-5--T1", base);
    writeFileSync(join(wt, "t1.txt"), "one\n");
    commitAll(wt, "T1");
    const r = await mergeTask(repo, { branch: "tickmarkr/run-5", expected: base }, "tickmarkr/run-5--T1", "tickmarkr: merge T1 don't panic", await gitHead(wt), () => {});
    expect(r.ok).toBe(true);
    expect((await shOk("git log -1 --format=%s refs/heads/tickmarkr/run-5", repo))).toContain("don't");
  });
});
