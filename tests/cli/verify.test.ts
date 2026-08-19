import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { BillingChannel } from "../../src/adapters/types.js";
import { pickReviewer } from "../../src/gates/review.js";
import { HUMAN_AUTHOR, HUMAN_CHANNEL, parseCriteria, verify, verifyStateDir } from "../../src/cli/commands/verify.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { COMMIT, authedModels, makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// A branch with one commit beside main, with a real (fast) test command so the baseline capture
// and the head battery both execute. No LLM seat: --no-review + no criteria = deterministic only.
function repoWithBranch(opts: { breakTests?: boolean; outOfScope?: boolean } = {}): string {
  const repo = makeRepo({
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "sh check.sh" } }),
    "check.sh": "grep -q GOOD src.txt\n",
    "src.txt": "GOOD\n",
  });
  const git = (c: string) => execSync(`git ${c}`, { cwd: repo, encoding: "utf8" });
  git("checkout -b feature");
  writeFileSync(join(repo, "src.txt"), opts.breakTests ? "BAD\n" : "GOOD\nmore\n");
  if (opts.outOfScope) writeFileSync(join(repo, "stray.txt"), "drive-by\n");
  execSync(`${COMMIT} change`, { cwd: repo });
  return repo;
}

// Doctor caches, so `readDoctor` short-circuits probeAll: no real CLI is touched and no token spent.
const NO_CHANNEL_DOCTOR = { fake: { installed: false, authed: false, models: [] } };
const FAKE_ONLY_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
};

// The capture is the expensive step: it mints verify's state dir and caches a baseline there. Its
// absence is therefore the proof a refusal preceded it — an assertion on the message alone cannot
// tell a hoisted check from one that refused ten minutes late.
const captured = (repo: string) => existsSync(verifyStateDir(repo));

describe("tickmarkr verify — standalone gate battery", () => {
  afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; });

  test("green diff verifies end-to-end without a daemon: battery + evidence + scope pass, exit 0", async () => {
    const repo = repoWithBranch();
    const r = await verify(["--no-review"], repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PASS test");
    expect(r.out).toContain("PASS evidence");
    expect(r.out).toContain("verify GREEN");
  }, 60_000);

  test("a test regression vs the captured base baseline fails closed with exit 2", async () => {
    const repo = repoWithBranch({ breakTests: true });
    const r = await verify(["--no-review"], repo);
    expect(r.code).toBe(2);
    expect(r.out).toContain("FAIL test");
  }, 60_000);

  test("--files enforces scope: an out-of-scope edit is named and fails closed", async () => {
    const repo = repoWithBranch({ outOfScope: true });
    const r = await verify(["--no-review", "--files", "src.txt"], repo);
    expect(r.code).toBe(2);
    expect(r.out).toContain("FAIL scope");
    expect(r.out).toContain("stray.txt");
  }, 60_000);

  test("nothing to verify when HEAD is contained in --base", async () => {
    const repo = makeRepo({ "a.txt": "x\n" });
    await expect(verify(["--no-review"], repo)).rejects.toThrow(/nothing to verify/);
  });

  test("parseCriteria: typed oracle prefixes and plain judge lines, comments skipped", () => {
    expect(parseCriteria("# heading\n- test: exact title\ncommand: npm run x\n- plain rubric\n\n")).toEqual([
      { oracle: "test", test: "exact title" },
      { oracle: "command", command: "npm run x" },
      "plain rubric",
    ]);
  });

  // The load-bearing novelty of verify's review wiring: pickReviewer fails CLOSED (null) for an
  // author it cannot resolve in the channel list, so a human-authored diff would never get a
  // reviewer. The sentinel makes the author resolvable as vendor "human", which excludes no real
  // channel — any live LLM seat stays eligible.

  test("human-author sentinel: reviewer eligible with the sentinel, fail-closed without it", () => {
    const llm: BillingChannel = { adapter: "codex", vendor: "openai", model: "gpt-x", channel: "sub", tier: "frontier" };
    expect(pickReviewer(HUMAN_AUTHOR, [llm])).toBeNull();
    expect(pickReviewer(HUMAN_AUTHOR, [llm, HUMAN_CHANNEL])).toEqual(llm);
  });
  // OBS-541: both refusals below are correct and were already fail-closed — the defect was that each
  // one cost a full baseline capture (602s, then 590s on the same candidate) to reach.
  test("verify on a dirty worktree refuses without capturing a baseline and names every offending path, so a refusal that follows a capture fails", async () => {
    const repo = repoWithBranch();
    // `status.showUntrackedFiles=no` is a normal git configuration under which a bare `git status
    // --porcelain` shows NO untracked file at all — the check must not be bypassable by it.
    execSync("git config status.showUntrackedFiles no", { cwd: repo });
    writeFileSync(join(repo, "src.txt"), "GOOD\nuncommitted\n");   // tracked, modified
    writeFileSync(join(repo, "stray.txt"), "untracked\n");          // untracked
    mkdirSync(join(repo, "nested", "deep"), { recursive: true });
    writeFileSync(join(repo, "nested", "deep", "buried.txt"), "untracked\n"); // nested: collapses to `?? nested/` by default
    writeFileSync(join(repo, ".tickmarkr-usage"), "harness litter\n"); // exempt: the harness's own

    const err = await verify(["--no-review"], repo).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("refusing to gate a dirty worktree");
    expect(err?.message).toContain("src.txt");     // every offending path, not just the first
    expect(err?.message).toContain("stray.txt");
    expect(err?.message).toContain("nested/deep/buried.txt"); // named individually, not as `nested/`
    expect(err?.message).not.toContain("tickmarkr-usage");
    expect(captured(repo)).toBe(false);
  }, 30_000);

  test("verify with no routable review channel refuses without capturing a baseline unless review is disabled, so a refusal that follows a capture fails", async () => {
    const repo = repoWithBranch();
    writeDoctor(repo, NO_CHANNEL_DOCTOR);

    await expect(verify([], repo)).rejects.toThrow(/review gate needs at least one authed LLM channel/);
    expect(captured(repo)).toBe(false);

    const r = await verify(["--no-review"], repo);  // the same tree, review disabled: nothing to refuse
    expect(r.code).toBe(0);
    expect(captured(repo)).toBe(true);
  }, 60_000);

  test("verify on a clean worktree with a routable channel captures and runs the battery unchanged, so a precondition phase that blocks a legitimate candidate fails", async () => {
    const repo = repoWithBranch();
    const scriptPath = join(makeTestTempDir("tickmarkr-script-"), "s.json");
    writeFileSync(scriptPath, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const r = await verify([], repo);
    expect(r.code).toBe(0);
    expect(captured(repo)).toBe(true);
    expect(r.out).toContain("PASS test");
    expect(r.out).toContain("PASS review");
    expect(r.out).toContain("verify GREEN");
  }, 120_000);

  test("cite the precondition phase ordered ahead of the baseline capture call, so a check left below it fails", () => {
    const src = readFileSync(new URL("../../src/cli/commands/verify.ts", import.meta.url), "utf8");
    const capture = src.indexOf("await captureBaseline(");
    expect(capture).toBeGreaterThan(-1);
    for (const check of ["PRECONDITIONS (OBS-541)", "git status --porcelain", "review gate needs at least one authed LLM channel"]) {
      const at = src.indexOf(check);
      expect(at, `${check} is missing`).toBeGreaterThan(-1);
      expect(at, `${check} sits below the baseline capture`).toBeLessThan(capture);
    }
  });
});
