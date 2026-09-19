import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import type { Baseline } from "../../src/gates/baseline.js";
import { runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// Regression seam for a forced preserveWorktree failure (review finding: a failed git add/write-tree/
// update-ref inside preserveWorktree must surface as explicit evidence, never mask the refusal). Every
// other call passes straight through to the real implementation, byte-identically.
const preserveWorktreeControl = vi.hoisted(() => ({ forceFailure: false }));

vi.mock("../../src/run/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/git.js")>();
  return {
    ...actual,
    preserveWorktree: async (cwd: string) => {
      if (preserveWorktreeControl.forceFailure) throw new Error("forced preservation failure (test)");
      return actual.preserveWorktree(cwd);
    },
  };
});

const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const channels: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
  { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
];

function fakeWith(extra: object): { adapter: FakeAdapter; scriptPath: string } {
  const scriptPath = join(makeTestTempDir("tickmarkr-dirty-refusal-"), "s.json");
  writeFileSync(scriptPath, JSON.stringify({ tasks: {}, judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] }, ...extra }));
  return { adapter: new FakeAdapter(scriptPath), scriptPath };
}

describe("dirty tree refusal and provenance (OBS-1030, OBS-932)", () => {
  test("test: through runGates a harvest tree the gate observes clean before its own test command and dirty after it with an untracked file absent from the worker's diff yields a refusal classified infra naming that command as the culprit, whose meta names the file, its byte count and the preserved ref holding it with the worker's committed diff unchanged, an untracked file already present at round entry that the repository does not ignore or a modified tracked file stays a chargeable refusal that still preserves the litter on a ref, and a tree whose only dirt is a path the repository ignores gates clean with that path neither named nor preserved, so litter the gate's own command produced charged as a worker attempt, unattributed litter forgiven, dirt discarded, or an ignored cache scanned or force-added fails", async () => {
    const task = validateGraph({
      version: 1,
      spec: { source: "native", paths: ["spec.md"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], gates: ["build", "lint", "evidence", "scope", "test"], files: ["**"] }],
    }).tasks[0];
    const baseline: Baseline = {
      commands: {
        build: { exitCode: 0, fingerprints: [] },
        lint: { exitCode: 0, fingerprints: [] },
        test: { exitCode: 0, fingerprints: [] },
      },
    };
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const fake = fakeWith({}).adapter;

    // -------------------------------------------------------------------------
    // Scenario 1: Clean harvest tree -> test command writes untracked file absent from worker diff
    // -> refusal classified infra naming that command as culprit, meta names file, byte count, preserved ref, diff unchanged
    // -------------------------------------------------------------------------
    const repo1 = makeRepo({
      "src/index.ts": "export const x = 1;\n",
      ".gitignore": "ignored-dir/\n*.cache\n",
    });
    const baseRef1 = execSync("git rev-parse HEAD", { cwd: repo1, encoding: "utf8" }).trim();
    writeFileSync(join(repo1, "src/index.ts"), "export const x = 2;\n");
    execSync("git add -A && git commit --no-gpg-sign -m 'worker commit'", { cwd: repo1 });
    const workerHeadBefore1 = execSync("git rev-parse HEAD", { cwd: repo1, encoding: "utf8" }).trim();
    const workerDiffBefore1 = execSync(`git diff ${baseRef1}..HEAD`, { cwd: repo1, encoding: "utf8" });

    const testCmd1 = "sh -c 'echo \"litter bytes\" > untracked-litter.txt'";
    const { results: results1 } = await runGates(task, {
      worktree: repo1,
      baseRef: baseRef1,
      author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: { build: "true", lint: "true", test: testCmd1 },
      baseline,
      channels,
      adapters: [fake],
      cfg,
    });

    const testRefusal = results1.find((r) => r.gate === "test")!;
    expect(testRefusal).toBeDefined();
    expect(testRefusal.pass).toBe(false);
    // classified infra
    expect(testRefusal.meta?.infra).toBe(true);
    expect(testRefusal.meta?.classification).toBe("infra");
    // naming that command as the culprit
    expect(testRefusal.meta?.culprit).toBe(testCmd1);
    expect(testRefusal.details).toContain(testCmd1);
    // meta names the file
    expect(testRefusal.meta?.file).toBe("untracked-litter.txt");
    expect((testRefusal.meta?.paths as string[])).toContain("untracked-litter.txt");
    // byte count
    const expectedBytes1 = Buffer.byteLength("litter bytes\n");
    expect(testRefusal.meta?.byteCount).toBe(expectedBytes1);
    expect(testRefusal.meta?.bytes).toBe(expectedBytes1);
    // preserved ref holding it
    const preservedRef1 = testRefusal.meta?.ref as string;
    expect(preservedRef1).toMatch(/^refs\/tickmarkr\/preserved\/[0-9a-f]{40,64}$/);
    const preservedContent1 = execSync(`git show ${preservedRef1}:untracked-litter.txt`, { cwd: repo1, encoding: "utf8" });
    expect(preservedContent1).toBe("litter bytes\n");
    // worker's committed diff unchanged
    const workerHeadAfter1 = execSync("git rev-parse HEAD", { cwd: repo1, encoding: "utf8" }).trim();
    const workerDiffAfter1 = execSync(`git diff ${baseRef1}..HEAD`, { cwd: repo1, encoding: "utf8" });
    expect(workerHeadAfter1).toBe(workerHeadBefore1);
    expect(workerDiffAfter1).toBe(workerDiffBefore1);

    // Negative control: litter the gate's own command produced charged as a worker attempt fails
    expect(testRefusal.meta?.infra).not.toBe(false);
    expect(testRefusal.meta?.infra).toBe(true);

    // -------------------------------------------------------------------------
    // Scenario 2: Untracked file already present at round entry that the repo does not ignore
    // -> stays a chargeable refusal (not infra) that still preserves litter on a ref
    // -------------------------------------------------------------------------
    const repo2 = makeRepo({ "src/index.ts": "export const x = 1;\n" });
    const baseRef2 = execSync("git rev-parse HEAD", { cwd: repo2, encoding: "utf8" }).trim();
    writeFileSync(join(repo2, "src/index.ts"), "export const x = 2;\n");
    execSync("git add -A && git commit --no-gpg-sign -m 'worker commit'", { cwd: repo2 });
    const workerDiffBefore2 = execSync(`git diff ${baseRef2}..HEAD`, { cwd: repo2, encoding: "utf8" });

    // Dirt present at round entry:
    writeFileSync(join(repo2, "entry-untracked.txt"), "entry litter\n");
    const expectedBytes2 = Buffer.byteLength("entry litter\n");

    const { results: results2 } = await runGates(task, {
      worktree: repo2,
      baseRef: baseRef2,
      author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: { build: "true", lint: "true", test: "true" },
      baseline,
      channels,
      adapters: [fake],
      cfg,
    });

    const entryRefusal = results2[0]!;
    expect(entryRefusal.pass).toBe(false);
    // stays chargeable (NOT infra)
    expect(entryRefusal.meta?.infra).toBeUndefined();
    expect(entryRefusal.meta?.classification).toBeUndefined();
    // preserves the litter on a ref
    const preservedRef2 = entryRefusal.meta?.ref as string;
    expect(preservedRef2).toMatch(/^refs\/tickmarkr\/preserved\/[0-9a-f]{40,64}$/);
    expect(entryRefusal.meta?.file).toBe("entry-untracked.txt");
    expect(entryRefusal.meta?.byteCount).toBe(expectedBytes2);
    expect(execSync(`git show ${preservedRef2}:entry-untracked.txt`, { cwd: repo2, encoding: "utf8" })).toBe("entry litter\n");
    expect(execSync(`git diff ${baseRef2}..HEAD`, { cwd: repo2, encoding: "utf8" })).toBe(workerDiffBefore2);

    // Negative control: unattributed litter forgiven fails
    expect(results2.every((r) => r.pass)).toBe(false);

    // -------------------------------------------------------------------------
    // Scenario 3: Modified tracked file -> stays a chargeable refusal that still preserves the litter on a ref
    // -------------------------------------------------------------------------
    const repo3 = makeRepo({ "src/index.ts": "export const x = 1;\n" });
    const baseRef3 = execSync("git rev-parse HEAD", { cwd: repo3, encoding: "utf8" }).trim();
    writeFileSync(join(repo3, "src/index.ts"), "export const x = 2;\n");
    execSync("git add -A && git commit --no-gpg-sign -m 'worker commit'", { cwd: repo3 });
    const workerDiffBefore3 = execSync(`git diff ${baseRef3}..HEAD`, { cwd: repo3, encoding: "utf8" });

    // Modified tracked file produced during command
    const modifyCmd = "sh -c 'echo \"// modified\" >> src/index.ts'";
    const { results: results3 } = await runGates(task, {
      worktree: repo3,
      baseRef: baseRef3,
      author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: { build: modifyCmd, lint: "true", test: "true" },
      baseline,
      channels,
      adapters: [fake],
      cfg,
    });

    const trackedRefusal = results3.find((r) => r.gate === "build")!;
    expect(trackedRefusal).toBeDefined();
    expect(trackedRefusal.pass).toBe(false);
    // stays chargeable (NOT infra)
    expect(trackedRefusal.meta?.infra).toBeUndefined();
    expect(trackedRefusal.meta?.classification).toBeUndefined();
    // still preserves the litter on a ref
    const preservedRef3 = trackedRefusal.meta?.ref as string;
    expect(preservedRef3).toMatch(/^refs\/tickmarkr\/preserved\/[0-9a-f]{40,64}$/);
    expect(trackedRefusal.meta?.file).toBe("src/index.ts");
    expect(trackedRefusal.meta?.byteCount).toBeGreaterThan(0);
    expect(execSync(`git diff ${baseRef3}..HEAD`, { cwd: repo3, encoding: "utf8" })).toBe(workerDiffBefore3);

    // Negative control: dirt discarded fails
    expect(preservedRef1).toBeDefined();
    expect(preservedRef2).toBeDefined();
    expect(preservedRef3).toBeDefined();
    expect(execSync(`git rev-parse --verify ${preservedRef1}`, { cwd: repo1, encoding: "utf8" }).trim()).toBeTruthy();
    expect(execSync(`git rev-parse --verify ${preservedRef2}`, { cwd: repo2, encoding: "utf8" }).trim()).toBeTruthy();
    expect(execSync(`git rev-parse --verify ${preservedRef3}`, { cwd: repo3, encoding: "utf8" }).trim()).toBeTruthy();

    // -------------------------------------------------------------------------
    // Scenario 4: Tree whose only dirt is a path the repository ignores gates clean with that path neither named nor preserved
    // -------------------------------------------------------------------------
    const repo4 = makeRepo({
      "src/index.ts": "export const x = 1;\n",
      ".gitignore": "*.cache\nignored-dir/\n",
    });
    const baseRef4 = execSync("git rev-parse HEAD", { cwd: repo4, encoding: "utf8" }).trim();
    writeFileSync(join(repo4, "src/index.ts"), "export const x = 2;\n");
    execSync("git add -A && git commit --no-gpg-sign -m 'worker commit'", { cwd: repo4 });

    // Create ignored paths only
    writeFileSync(join(repo4, "data.cache"), "cache content\n");
    mkdirSync(join(repo4, "ignored-dir"), { recursive: true });
    writeFileSync(join(repo4, "ignored-dir/nested.txt"), "nested ignored\n");

    const { results: results4 } = await runGates(task, {
      worktree: repo4,
      baseRef: baseRef4,
      author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: { build: "true", lint: "true", test: "true" },
      baseline,
      channels,
      adapters: [fake],
      cfg,
    });

    // gates clean
    expect(results4.every((r) => r.pass)).toBe(true);
    expect(results4.some((r) => r.meta?.dirtyWorktree === true)).toBe(false);
    // path neither named nor preserved
    expect(results4.some((r) => r.meta?.ref !== undefined)).toBe(false);
    expect(results4.some((r) => r.details?.includes("data.cache"))).toBe(false);
    expect(results4.some((r) => r.details?.includes("ignored-dir"))).toBe(false);

    // Negative control: an ignored cache scanned or force-added fails
    const refsOutput = execSync("git for-each-ref --format='%(refname)' refs/tickmarkr/preserved", { cwd: repo4, encoding: "utf8" }).trim();
    expect(refsOutput).toBe("");
  });

  // Regression: git's newline porcelain c-quotes any non-ASCII byte in a path using octal escapes
  // (`"caf\303\251.txt"`), a grammar JSON.parse cannot decode — it silently kept the quoted string,
  // garbling meta.file and zeroing the byte count. `-z` porcelain never quotes, so this must decode losslessly.
  test("a non-ASCII litter path (café.txt) is named and sized correctly, not garbled by porcelain quoting", async () => {
    const task = validateGraph({
      version: 1,
      spec: { source: "native", paths: ["spec.md"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], gates: ["build", "lint", "evidence", "scope", "test"], files: ["**"] }],
    }).tasks[0];
    const baseline: Baseline = {
      commands: {
        build: { exitCode: 0, fingerprints: [] },
        lint: { exitCode: 0, fingerprints: [] },
        test: { exitCode: 0, fingerprints: [] },
      },
    };
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const fake = fakeWith({}).adapter;

    const repo = makeRepo({ "src/index.ts": "export const x = 1;\n" });
    const baseRef = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(join(repo, "src/index.ts"), "export const x = 2;\n");
    execSync("git add -A && git commit --no-gpg-sign -m 'worker commit'", { cwd: repo });

    const content = "café content\n";
    const testCmd = "sh -c 'echo \"café content\" > café.txt'";
    const { results } = await runGates(task, {
      worktree: repo,
      baseRef,
      author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: { build: "true", lint: "true", test: testCmd },
      baseline,
      channels,
      adapters: [fake],
      cfg,
    });

    const refusal = results.find((r) => r.gate === "test")!;
    expect(refusal.pass).toBe(false);
    expect(refusal.meta?.infra).toBe(true);
    expect(refusal.meta?.file).toBe("café.txt");
    expect(refusal.meta?.paths as string[]).toContain("café.txt");
    const expectedBytes = Buffer.byteLength(content);
    expect(refusal.meta?.byteCount).toBe(expectedBytes);
    expect(refusal.meta?.bytes).toBe(expectedBytes);
    const preservedRef = refusal.meta?.ref as string;
    expect(preservedRef).toMatch(/^refs\/tickmarkr\/preserved\/[0-9a-f]{40,64}$/);
    expect(execSync(`git show ${preservedRef}:café.txt`, { cwd: repo, encoding: "utf8" })).toBe(content);
  });

  test("a recreated non-ASCII path deleted by the worker remains chargeable because committed-diff membership is lossless", async () => {
    const task = validateGraph({
      version: 1,
      spec: { source: "native", paths: ["spec.md"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], gates: ["build", "lint", "evidence", "scope", "test"], files: ["**"] }],
    }).tasks[0];
    const baseline: Baseline = {
      commands: {
        build: { exitCode: 0, fingerprints: [] },
        lint: { exitCode: 0, fingerprints: [] },
        test: { exitCode: 0, fingerprints: [] },
      },
    };
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const fake = fakeWith({}).adapter;
    const repo = makeRepo({ "café.txt": "base\n" });
    const baseRef = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    execSync("git rm café.txt && git commit --no-gpg-sign -m 'worker deletion'", { cwd: repo });

    const { results } = await runGates(task, {
      worktree: repo,
      baseRef,
      author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: { build: "true", lint: "true", test: "sh -c 'echo recreated > café.txt'" },
      baseline,
      channels,
      adapters: [fake],
      cfg,
    });

    const refusal = results.find((r) => r.gate === "test")!;
    expect(refusal.pass).toBe(false);
    expect(refusal.meta?.file).toBe("café.txt");
    expect(refusal.meta?.infra).toBeUndefined();
    expect(refusal.meta?.classification).toBeUndefined();
  });

  // Regression: dirtyRefusal/dirtyRoundRefusal swallowed a preserveWorktree throw (a failed git add,
  // write-tree, or update-ref) and returned an ordinary refusal with an undefined ref indistinguishable
  // from "nothing to preserve". A forced failure must surface as explicit meta, not silence.
  test("a forced preserveWorktree failure surfaces explicit preservation-failure evidence rather than masking the refusal", async () => {
    const task = validateGraph({
      version: 1,
      spec: { source: "native", paths: ["spec.md"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], gates: ["build", "lint", "evidence", "scope", "test"], files: ["**"] }],
    }).tasks[0];
    const baseline: Baseline = {
      commands: {
        build: { exitCode: 0, fingerprints: [] },
        lint: { exitCode: 0, fingerprints: [] },
        test: { exitCode: 0, fingerprints: [] },
      },
    };
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const fake = fakeWith({}).adapter;

    const repo = makeRepo({ "src/index.ts": "export const x = 1;\n" });
    const baseRef = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(join(repo, "src/index.ts"), "export const x = 2;\n");
    execSync("git add -A && git commit --no-gpg-sign -m 'worker commit'", { cwd: repo });
    writeFileSync(join(repo, "entry-untracked.txt"), "entry litter\n");

    preserveWorktreeControl.forceFailure = true;
    try {
      const { results } = await runGates(task, {
        worktree: repo,
        baseRef,
        author,
        result: { ok: true, summary: "", deviations: [], raw: "" },
        commands: { build: "true", lint: "true", test: "true" },
        baseline,
        channels,
        adapters: [fake],
        cfg,
      });

      const refusal = results[0]!;
      expect(refusal.pass).toBe(false);
      expect(refusal.meta?.preservationFailed).toBe(true);
      expect(typeof refusal.meta?.preservationError).toBe("string");
      expect(refusal.meta?.ref).toBeUndefined();
      expect(refusal.meta?.preservedRef).toBeUndefined();
      expect(refusal.details).toContain("preservation failed");
      // No snapshot means this is a terminal infrastructure blocker, not a chargeable failure
      // the daemon may hand to a repair worker or escalate through its normal ladder.
      expect(refusal.meta?.infra).toBe(true);
      expect(refusal.meta?.classification).toBe("infra");
      expect(refusal.meta?.retryable).toBe(false);
      expect(refusal.meta?.recoveryBlocked).toContain("no recovery ref");
      // the litter is never silently discarded — it stays exactly where the refusal found it
      expect(existsSync(join(repo, "entry-untracked.txt"))).toBe(true);
    } finally {
      preserveWorktreeControl.forceFailure = false;
    }
  });
});
