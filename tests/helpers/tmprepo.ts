import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";

export const COMMIT = "git add -A && git commit --no-gpg-sign -m";
export const authedModels = (models: Iterable<string>) => Object.fromEntries([...models].map((model) => [model, { authed: true, probedAt: "2026-07-16T00:00:00.000Z" }]));

export const T = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: id, goal: id, shape: "implement", complexity: 3, acceptance: ["done"], ...over,
});

const testTempDirs = new Set<string>();

/**
 * OBS-1054: every temp directory this runner creates lives under ONE namespace root keyed by this
 * process's pid plus a nonce, so two parallel runners of the same suite file never share a flat
 * prefix — a sweep of one runner's root cannot touch another runner's fixture repository.
 */
export const TEST_TEMP_ROOT = join(tmpdir(), "tickmarkr-tests", `${process.pid}-${randomBytes(4).toString("hex")}`);

/**
 * The temp-directory seam for tests. Create test-owned temp directories through this helper
 * so tests/setup.ts can reap them at suite teardown; production source has no cleanup role.
 */
export function makeTestTempDir(prefix: string): string {
  mkdirSync(TEST_TEMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_TEMP_ROOT, prefix));
  testTempDirs.add(dir);
  return dir;
}

/** Removes exactly the directories this runner recorded — never a prefix sweep, never the root's other children. */
export function reapTestTempDirs(): void {
  for (const dir of testTempDirs) {
    rmSync(dir, { recursive: true, force: true });
    testTempDirs.delete(dir);
  }
  try { rmdirSync(TEST_TEMP_ROOT); } catch { /* not empty (unrecorded siblings) or never created — leave it */ }
}

// one fixture for every daemon suite: graph + config overlay + scripted fake adapter
export function setupRepo(tasks: unknown[], script: object, extraCfg = ""): { repo: string; fake: FakeAdapter; scriptPath: string } {
  const repo = makeRepo({ "base.txt": "base\n" });
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks }));
  // fake adapter is judge+reviewer+consult too
  writeFileSync(
    join(tickmarkrDir(repo), "config.yaml"),
    `judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n${extraCfg}`,
  );
  const sdir = makeTestTempDir("tickmarkr-script-");
  const scriptPath = join(sdir, "s.json");
  writeFileSync(scriptPath, JSON.stringify({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] }, ...script }));
  return { repo, fake: new FakeAdapter(scriptPath), scriptPath };
}

/**
 * OBS-1067: every fixture repo is created here or by a caller of this. `git commit` may spawn git's
 * detached auto-maintenance (`gc --auto`), which writes and removes `.git/objects/maintenance.lock`
 * while a test is still walking the tree — a recursive readdir then dies with ENOENT on an entry that
 * vanished under it, and the gate reports "authoring" on whichever suite lost the race. Fixtures never
 * need maintenance; switch it off at init so no background git process ever runs inside one.
 */
export function quietGitInit(dir: string, branch = "main"): void {
  const git = (c: string) => execSync(`git ${c}`, { cwd: dir, encoding: "utf8", stdio: "pipe" });
  git(`init -q -b ${branch}`);
  git("config gc.auto 0");
  git("config maintenance.auto false");
}

export function makeRepo(files: Record<string, string>): string {
  const dir = makeTestTempDir("tickmarkr-repo-");
  const git = (c: string) => execSync(`git ${c}`, { cwd: dir, encoding: "utf8" });
  quietGitInit(dir);
  git("config user.email tickmarkr@test.local");
  git("config user.name tickmarkr-test");
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  git("add -A");
  git('commit -m init --no-gpg-sign');
  return dir;
}
