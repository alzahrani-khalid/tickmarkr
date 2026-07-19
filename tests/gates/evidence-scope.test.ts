import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { evidenceGate } from "../../src/gates/evidence.js";
import { dispositionOffenders, scopeDiffBase, scopeGate } from "../../src/gates/scope.js";
import { gitHead } from "../../src/run/git.js";
import { makeRepo } from "../helpers/tmprepo.js";
import replay from "../fixtures/scope-corpus/replay.json";

const noResult = { ok: true, summary: "", deviations: [] as string[], raw: "" };

function commitFile(repo: string, path: string, content: string) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
  execSync(`git add -A && git commit -m work --no-gpg-sign`, { cwd: repo });
}

describe("evidenceGate", () => {
  test("fails when nothing was committed", async () => {
    const repo = makeRepo({ "a.txt": "x" });
    const base = await gitHead(repo);
    const r = await evidenceGate(repo, base);
    expect(r.pass).toBe(false);
    expect(r.commits).toEqual([]);
  });

  test("passes with commits + changed files, returns shas", async () => {
    const repo = makeRepo({ "a.txt": "x" });
    const base = await gitHead(repo);
    commitFile(repo, "src/new.ts", "export {};\n");
    const r = await evidenceGate(repo, base);
    expect(r.pass).toBe(true);
    expect(r.commits).toHaveLength(1);
    expect(r.details).toContain("src/new.ts");
  });
});

describe("scopeGate", () => {
  test("in-scope diff passes; out-of-scope fails naming offenders", async () => {
    const repo = makeRepo({ "src/auth/a.ts": "x", "README.md": "r" });
    const base = await gitHead(repo);
    commitFile(repo, "src/auth/b.ts", "export {};\n");
    expect((await scopeGate(repo, base, ["src/auth/**"], noResult)).pass).toBe(true);
    commitFile(repo, "README.md", "drive-by edit\n");
    const r = await scopeGate(repo, base, ["src/auth/**"], noResult);
    expect(r.pass).toBe(false);
    expect(r.details).toContain("README.md");
  });

  test("declared deviation does not pass — echoed as audit note only", async () => {
    const repo = makeRepo({ "src/auth/a.ts": "x", "README.md": "r" });
    const base = await gitHead(repo);
    commitFile(repo, "README.md", "documented deviation\n");
    const r = await scopeGate(repo, base, ["src/auth/**"], { ...noResult, deviations: ["README.md needed a usage note"] });
    expect(r.pass).toBe(false);
    expect(r.details).toContain("README.md");
    expect(r.details).toMatch(/audit note/i);
    expect(r.details).toContain("README.md needed a usage note");
  });

  test("empty files[] means unrestricted", async () => {
    const repo = makeRepo({ "a.txt": "x" });
    const base = await gitHead(repo);
    commitFile(repo, "anything.txt", "y\n");
    expect((await scopeGate(repo, base, [], noResult)).pass).toBe(true);
  });

  test("HARD-08: liar worker — a deviation naming no path does not excuse out-of-scope edits", async () => {
    const repo = makeRepo({ "src/auth/a.ts": "x", "README.md": "r" });
    const base = await gitHead(repo);
    commitFile(repo, "README.md", "drive-by edit\n");
    const r = await scopeGate(repo, base, ["src/auth/**"], { ...noResult, deviations: ["refactored a bit"] });
    expect(r.pass).toBe(false);
    expect(r.details).toContain("README.md");
  });

  test("HARD-08: naming the path is not sufficient", async () => {
    const repo = makeRepo({ "src/auth/a.ts": "x", "README.md": "r" });
    const base = await gitHead(repo);
    commitFile(repo, "README.md", "drive-by edit\n");
    const r = await scopeGate(repo, base, ["src/auth/**"], { ...noResult, deviations: ["README.md — needed a usage note"] });
    expect(r.pass).toBe(false);
    expect(r.details).toContain("README.md");
  });

  test("HARD-08: operator allowlist is the only relaxation", async () => {
    const repo = makeRepo({ "src/auth/a.ts": "x", "README.md": "r" });
    const base = await gitHead(repo);
    commitFile(repo, "README.md", "drive-by edit\n");
    expect((await scopeGate(repo, base, ["src/auth/**"], noResult, ["README.md"])).pass).toBe(true);
    expect((await scopeGate(repo, base, ["src/auth/**"], noResult, ["package-lock.json"])).pass).toBe(false);
  });

  test("a sibling task merged between attempts does not appear in a resumed attempt scope diff", async () => {
    const repo = makeRepo({ "src/a.ts": "a", "src/sibling.ts": "old" });
    const worktreeBase = await gitHead(repo);
    const wt = join(repo, "wt-t2");
    execSync(`git worktree add ${wt} -b tickmarkr-run--T2 ${worktreeBase}`, { cwd: repo });
    commitFile(wt, "src/in-scope.ts", "export {};\n");
    execSync("git checkout -b tickmarkr/run", { cwd: repo });
    commitFile(repo, "src/sibling.ts", "sibling merged\n");
    const integrationTip = await gitHead(repo);
    const r = await scopeGate(wt, integrationTip, ["src/**"], noResult);
    expect(r.pass).toBe(true);
    expect(r.details).not.toContain("src/sibling.ts");
  });

  test("the scope gate diffs against the base the attempt worktree was created from", async () => {
    const repo = makeRepo({ "f.txt": "x" });
    const worktreeBase = await gitHead(repo);
    commitFile(repo, "sibling.ts", "y\n");
    const integrationTip = await gitHead(repo);
    const wt = join(repo, "wt");
    execSync(`git worktree add ${wt} -b task ${worktreeBase}`, { cwd: repo });
    commitFile(wt, "task.ts", "z\n");
    expect(await scopeDiffBase(wt, integrationTip)).toBe(worktreeBase);
    expect((await scopeGate(wt, integrationTip, ["task.ts"], noResult)).pass).toBe(true);
  });

  // Counts from 41-01-DIAGNOSIS.md § Corpus scan (re-derived) — machine-checked against replay.json
  const CORPUS_FLIPS_UNDER_EMPTY = 7;
  const CORPUS_RECOVERIES_UNDER_PLANNING = 2;

  test("HARD-08: corpus replay — the shipped semantics reproduce the re-derived numbers", () => {
    const pass = (offenders: string[], allow: string[]) => dispositionOffenders(offenders, allow).hard.length === 0;
    const historicallyGreen = replay.filter((e) => e.historicalPass);
    const flips = historicallyGreen.filter((e) => !pass(e.offenders, []));
    expect(flips).toHaveLength(CORPUS_FLIPS_UNDER_EMPTY);
    const planningAllow = [".planning/**"];
    const recoveries = flips.filter((e) => pass(e.offenders, planningAllow));
    expect(recoveries).toHaveLength(CORPUS_RECOVERIES_UNDER_PLANNING);
    for (const e of replay.filter((x) => !x.historicalPass)) {
      expect(pass(e.offenders, [])).toBe(false);
    }
  });
});
