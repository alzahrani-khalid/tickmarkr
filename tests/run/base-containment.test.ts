import { execSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { declaredBaseContainment } from "../../src/run/git.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// Every fixture below is a REAL repository on disk — the probe reads git and nothing else, so a
// stubbed history would only prove the stub. `makeRepo` gives an initialized repo with one commit.
const git = (repo: string, cmd: string) => execSync(`git ${cmd}`, { cwd: repo, encoding: "utf8" }).trim();
const commit = (repo: string, path: string, body: string, msg: string) => {
  writeFileSync(join(repo, path), body);
  git(repo, "add -A");
  git(repo, `commit --no-gpg-sign -m ${msg}`);
  return git(repo, "rev-parse HEAD");
};
// A merge of two branches that changed the SAME path conflicts, so git exits nonzero and leaves the
// resolution to the caller — which is the point: `body` is the content that ends up in the merge, and
// nothing forces it to have existed on either parent. Committing with MERGE_HEAD set still produces a
// two-parent merge commit (asserted below), so this is a real merge, not a squash wearing the name.
const mergeResolving = (repo: string, branch: string, path: string, body: string, msg: string) => {
  execSync(`git merge --no-ff --no-gpg-sign ${branch} -m ${msg} || true`, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  // an outstanding MERGE_HEAD is what makes this fixture mean anything: git could NOT settle the
  // path itself, so the content below is the merge's own and not a replay of either side. Asserted
  // here so the scenario cannot quietly decay into a conflict-free merge of disjoint files.
  expect(git(repo, "rev-parse -q --verify MERGE_HEAD || true")).not.toBe("");
  writeFileSync(join(repo, path), body);
  git(repo, "add -A");
  git(repo, `commit --no-gpg-sign -m ${msg}`);
};

// base ← x and y, which both ADD f.txt with different content; main reaches both sides, and
// `declared` merges the same conflicting pair resolving f.txt to content carried by NEITHER parent.
// So declared's only unique commit is that merge, and no replay of either side's patches produces
// its tree — the merge alone authored it.
const mergeOnlyRepo = (): string => {
  const repo = makeRepo({ "a.txt": "a\n" });
  const base = git(repo, "rev-parse HEAD");
  git(repo, "checkout -q -b x");
  commit(repo, "f.txt", "x\n", "x-side");
  git(repo, `checkout -q -b y ${base}`);
  commit(repo, "f.txt", "y\n", "y-side");
  git(repo, "checkout -q main");
  git(repo, "merge -q --no-ff --no-gpg-sign x -m main-merges-x"); // main has no f.txt yet: clean
  mergeResolving(repo, "y", "f.txt", "x\n", "main-merges-y"); // now add/add on f.txt: conflict
  git(repo, "checkout -q -b declared y");
  mergeResolving(repo, "x", "f.txt", "resolved-only-in-the-merge\n", "declared-merge");
  return repo;
};

describe("declared-base containment probe", () => {
  test("the containment probe reports contained for an ancestor and for a no-ancestry recreated branch carrying every declared non-merge patch under different commit identities, built as real git repositories", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const c2 = commit(repo, "b.txt", "b\n", "c2");
    const c3 = commit(repo, "c.txt", "c\n", "c3");

    // an ancestor of HEAD is contained outright
    expect(await declaredBaseContainment(repo, c2)).toEqual({ result: "contained", via: "ancestry" });

    // recreate main's patches on an orphan branch: same content, new commit identities, no shared history
    const root = git(repo, "rev-list --max-parents=0 main");
    git(repo, `checkout -q --orphan recreated ${root}`);
    git(repo, "commit --no-gpg-sign -m recreated-root");
    git(repo, `cherry-pick --no-gpg-sign ${c2} ${c3}`);
    expect(execSync(`git merge-base recreated main || true`, { cwd: repo, encoding: "utf8" }).trim()).toBe("");
    expect(git(repo, "rev-parse recreated")).not.toBe(c3);

    expect(await declaredBaseContainment(repo, "main", "recreated")).toEqual({ result: "contained", via: "patch-id" });
  });

  test("a sibling declared tip with one patch absent reports drifted and names the missing commit plus at least one path it touches, while cherry-picking that patch flips only the result to contained", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const base = git(repo, "rev-parse HEAD");
    git(repo, "checkout -q -b declared");
    const p1 = commit(repo, "one.txt", "1\n", "p1");
    // Git permits this pathname. Newline splitting plus trim used to erase it and report no path
    // evidence for the missing commit, so the criterion deliberately exercises the raw name here.
    const p2 = commit(repo, " ", "2\n", "p2");

    // sibling branch off the same base carrying p1 only, under its own commit identity — its own
    // commit first, so the copies cannot hash back to the originals and answer by ancestry instead
    git(repo, `checkout -q -b work ${base}`);
    commit(repo, "work.txt", "w\n", "work-only");
    git(repo, `cherry-pick --no-gpg-sign ${p1}`);
    expect(git(repo, "rev-parse work")).not.toBe(p1);

    const drifted = await declaredBaseContainment(repo, "declared", "work");
    expect(drifted.result).toBe("drifted");
    if (drifted.result !== "drifted") return;
    expect(drifted.missing.map((m) => m.commit)).toEqual([p2]);
    expect(drifted.missing[0]!.paths).toEqual([" "]);

    // cherry-picking exactly the missing patch flips the verdict and nothing else: the declared tip is
    // untouched and still not an ancestor, so the flip is patch identity, not a moved branch.
    const declaredTip = git(repo, "rev-parse declared");
    git(repo, `cherry-pick --no-gpg-sign ${p2}`);
    expect(git(repo, "rev-parse declared")).toBe(declaredTip);
    expect(await declaredBaseContainment(repo, "declared", "work")).toEqual({ result: "contained", via: "patch-id" });
  });

  test("an unresolvable declaration reports unresolvable rather than drifted or contained, with the original git evidence retained for the caller", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const probe = await declaredBaseContainment(repo, "refs/heads/never-existed");
    expect(probe.result).toBe("unresolvable");
    if (probe.result !== "unresolvable") return;
    expect(probe.ref).toBe("refs/heads/never-existed");
    // git's own words, kept verbatim — the caller reports evidence rather than inventing a cause
    expect(probe.evidence).toMatch(/fatal:/);
    expect(probe.evidence).toBe(
      execSync(`git rev-parse --verify 'refs/heads/never-existed^{commit}' 2>&1 || true`, { cwd: repo, encoding: "utf8" }).trim(),
    );
  });

  test("a declared merge outside HEAD ancestry whose own ordinary patch-id stream is empty cannot report contained merely because the stream is empty, exercised with a merge-only resolution and a control where the declared merge is an ancestor", async () => {
    const repo = mergeOnlyRepo();
    const declaredMerge = git(repo, "rev-parse declared");
    // the resolution is merge-only: this content exists on neither parent, so nothing but the merge
    // itself can account for it, and a `contained` verdict would be asserting an unproven tree
    expect(git(repo, "rev-list --parents -1 declared").split(/\s+/)).toHaveLength(3); // sha + 2 parents
    expect(git(repo, "show declared:f.txt")).toBe("resolved-only-in-the-merge");
    expect(git(repo, "show x:f.txt")).toBe("x");
    expect(git(repo, "show y:f.txt")).toBe("y");

    // the trap is armed: git's ordinary patch stream skips merges and sees nothing at all here
    expect(git(repo, "cherry main declared")).toBe("");
    expect(git(repo, "rev-list main..declared")).toBe(declaredMerge);

    const probe = await declaredBaseContainment(repo, "declared", "main");
    expect(probe.result).toBe("drifted");
    if (probe.result !== "drifted") return;
    expect(probe.missing).toEqual([{ commit: declaredMerge, paths: ["f.txt"], merge: true }]);

    // control: the same merge, now an ancestor of the target — contained, so the rule above is
    // fail-closed on unproven merges and not a blanket "any merge is drift"
    git(repo, "checkout -q -b control declared");
    expect(await declaredBaseContainment(repo, "declared", "control")).toEqual({ result: "contained", via: "ancestry" });
  });

  test("a git failure while naming a missing commit's touched paths reports unresolvable with git's own words, never a drifted verdict carrying an empty path list", async () => {
    const repo = mergeOnlyRepo();
    const declaredMerge = git(repo, "rev-parse declared");
    // Delete the declared merge's own tree object. `rev-list --parents` reads commit objects and
    // `git cherry` skips merges outright, so both still answer; the ONLY command left that can fail
    // is the diff-tree naming the paths — precisely the seam where swallowing the error turns
    // "git could not tell us" into a drifted verdict claiming the commit touched nothing.
    const tree = git(repo, "rev-parse 'declared^{tree}'");
    rmSync(join(repo, ".git/objects", tree.slice(0, 2), tree.slice(2)));
    expect(git(repo, "rev-list main..declared")).toBe(declaredMerge);
    expect(git(repo, "cherry main declared")).toBe("");

    const probe = await declaredBaseContainment(repo, "declared", "main");
    expect(probe.result).toBe("unresolvable");
    if (probe.result !== "unresolvable") return;
    expect(probe.ref).toBe(declaredMerge);
    expect(probe.evidence).toMatch(/fatal:/);
    expect(probe.evidence).toContain(tree); // git named the object it could not read; we kept that
  });

  test("a truncated (shallow-clone) declared history reports unresolvable, because git cherry matches the graft boundary's whole tree as one patch and the complete history calls the same declaration drifted", async () => {
    const source = makeRepo({ "a.txt": "a\n" });
    commit(source, "b.txt", "b\n", "c2");
    commit(source, "c.txt", "c\n", "c3");
    const clone = join(makeTestTempDir("tickmarkr-shallow-"), "clone");
    execSync(`git clone -q --depth 1 "file://${source}" "${clone}"`, { encoding: "utf8" });
    expect(git(clone, "rev-parse --is-shallow-repository")).toBe("true");
    expect(git(clone, "rev-list main").split("\n")).toHaveLength(1); // c1 and c2 are simply not here

    // one squashed commit whose tree equals the graft boundary's: git cherry says the boundary's
    // synthetic full-tree patch is present, which is the whole of what this clone can see
    git(clone, "checkout -q --orphan squashed");
    git(clone, "commit --no-gpg-sign -m squashed");
    expect(git(clone, "cherry squashed main")).toMatch(/^- /);

    const probe = await declaredBaseContainment(clone, "main", "squashed");
    expect(probe.result).toBe("unresolvable");
    if (probe.result !== "unresolvable") return;
    expect(probe.ref).toBe("main");
    expect(probe.evidence).toBe("git rev-parse --is-shallow-repository: true");

    // the identical declaration against the COMPLETE history: three declared patches are missing,
    // so a `contained` here would have been an artifact of truncation rather than a fact
    git(source, "checkout -q --orphan squashed");
    git(source, "commit --no-gpg-sign -m squashed");
    const full = await declaredBaseContainment(source, "main", "squashed");
    expect(full.result).toBe("drifted");
    if (full.result !== "drifted") return;
    expect(full.missing).toHaveLength(3);
    expect(full.missing.every((m) => m.paths.length > 0)).toBe(true);
  });
});
