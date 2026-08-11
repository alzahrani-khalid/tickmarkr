import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BillingChannel } from "../../src/adapters/types.js";
import { pickReviewer } from "../../src/gates/review.js";
import { HUMAN_AUTHOR, HUMAN_CHANNEL, parseCriteria, verify } from "../../src/cli/commands/verify.js";
import { COMMIT, makeRepo } from "../helpers/tmprepo.js";

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

describe("tickmarkr verify — standalone gate battery", () => {
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
});
