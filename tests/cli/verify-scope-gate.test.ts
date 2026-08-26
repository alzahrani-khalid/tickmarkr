import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { verify } from "../../src/cli/commands/verify.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { COMMIT, T, makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// verify builds its synthetic task's file scope from exactly three sources — an explicit --files,
// a compiled task's own files[], or nothing — and scopeGate reads an empty allowlist as
// "unrestricted" and passes (scope.ts:41). A PASS row for a check that gated no allowlist is what
// gets quoted, so verify now omits the gate on that third source instead. These cases pin all
// three, and that the omission never buys a green.

// A branch with one commit beside main and a real (fast) test command, so the baseline capture and
// the head battery both execute. Deterministic gates only: no LLM seat, no token, no doctor probe.
function repoWithBranch(opts: { breakTests?: boolean; outOfScope?: boolean } = {}): string {
  const repo = makeRepo({
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "sh check.sh" } }),
    "check.sh": "grep -q GOOD src.txt\n",
    "src.txt": "GOOD\n",
  });
  execSync("git checkout -b feature", { cwd: repo, encoding: "utf8" });
  writeFileSync(join(repo, "src.txt"), opts.breakTests ? "BAD\n" : "GOOD\nmore\n");
  if (opts.outOfScope) writeFileSync(join(repo, "stray.txt"), "drive-by\n");
  execSync(`${COMMIT} change`, { cwd: repo });
  return repo;
}

// OUTSIDE the repo on purpose: verify gates the checkout itself, so a criteria file written into it
// would trip the battery's own dirty-worktree refusal before a gate ever ran.
function criteriaFile(): string {
  const p = join(makeTestTempDir("tickmarkr-criteria-"), "criteria.md");
  writeFileSync(p, "- the change keeps the fixture suite green\n");
  return p;
}

// The semantic gates are off in every case here: they need a routable LLM seat, and the claim under
// test is which gate ROWS the report carries. --criteria still routes through the criteria-file
// branch that leaves files[] empty, which is the branch these cases are about.
type Report = { green: boolean; results: { gate: string; pass: boolean; details: string }[] };
const run = async (repo: string, args: string[]): Promise<{ code: number; report: Report }> => {
  const r = await verify(["--no-review", "--no-acceptance", "--json", ...args], repo);
  return { code: r.code, report: JSON.parse(r.out) as Report };
};

describe("tickmarkr verify — scope gate declared only when an allowlist exists", () => {
  test("a standalone verification whose acceptance came from a criteria file without a file allowlist declares no scope gate so its result carries no scope verdict while the shipped path returning scope passing as unrestricted fails", async () => {
    const { code, report } = await run(repoWithBranch(), ["--criteria", criteriaFile()]);

    expect(report.results.map((g) => g.gate)).toContain("evidence"); // the battery did run…
    expect(report.results.map((g) => g.gate)).not.toContain("scope"); // …and scope is not among it
    expect(report.green).toBe(true);
    expect(code).toBe(0);
  }, 60_000);

  test("a standalone verification given an explicit file allowlist reds on a changed file outside that allowlist while a change dropping scope whenever acceptance came from a criteria file fails", async () => {
    const repo = repoWithBranch({ outOfScope: true });
    const { code, report } = await run(repo, ["--criteria", criteriaFile(), "--files", "src.txt"]);

    const scope = report.results.find((g) => g.gate === "scope");
    expect(scope, "criteria + --files still declares scope").toBeDefined();
    expect(scope?.pass).toBe(false);
    expect(scope?.details).toContain("stray.txt");
    expect(code).toBe(2);
  }, 60_000);

  test("a standalone verification naming a compiled task gates its diff against that task's own declared files while a change omitting scope because no allowlist reached the command line fails", async () => {
    const repo = repoWithBranch({ outOfScope: true });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [T("T1", { files: ["src.txt"] })],
    }));
    const { code, report } = await run(repo, ["--task", "T1"]); // no --files: the allowlist is the task's own

    const scope = report.results.find((g) => g.gate === "scope");
    expect(scope, "a compiled task's files[] is an allowlist").toBeDefined();
    expect(scope?.pass).toBe(false);
    expect(scope?.details).toContain("stray.txt");
    expect(code).toBe(2);
  }, 60_000);

  test("a standalone verification declaring no scope gate still reaches a red overall verdict from the gates that did run while a change crediting the omitted gate as a passing contribution fails", async () => {
    const repo = repoWithBranch({ breakTests: true });
    const { code, report } = await run(repo, ["--criteria", criteriaFile()]);

    expect(report.results.map((g) => g.gate)).not.toContain("scope"); // omitted, so it credits nothing
    expect(report.results.some((g) => g.gate === "test" && !g.pass)).toBe(true);
    expect(report.green).toBe(false);
    expect(code).toBe(2);
  }, 60_000);
});
