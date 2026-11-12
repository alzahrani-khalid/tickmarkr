import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { GateResult } from "../../src/gates/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { resetHostLatencySampleForTests, setHostLatencySampleForTests } from "../../src/run/host-health.js";
import { Journal } from "../../src/run/journal.js";
import { classifyRepairDisposition } from "../../src/run/repair-disposition.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

// Queue row 410: every cell of the refusal-form case table, through the classifier the daemon calls
// (src/run/daemon.ts passes refusalSummary only for an ok:false worker result).
const files = ["src/run/widget.ts"];
const odd = ["Dockerfile", ".gitignore", "src/über.ts", "src/a+b.ts"];
const inventory = ["src/run/widget.ts", "src/a.ts", "src/b.ts", "x.ts", "tests/cli/vendor-truth.test.ts", ...odd];
const lint: GateResult = { gate: "lint", pass: false, details: "3 problems" };
const read = (refusalSummary?: string) => classifyRepairDisposition({ files, inventory, results: [lint], refusalSummary });
const LINE_1814 = "infeasible inside files[]: tests/cli/vendor-truth.test.ts — the one credential sink (D-2187 add.57) is built in cliproxy.ts/doctor.ts and its CASE table (a)-(d) plus controls passes and fails pre-fix, but vendor-truth.test.ts:485 and :536 pin the superseded confirmed-proxy-only rule (credential kept behind a failed listing or differing override), so they red and only a grant of that file can update them.";

describe("refusal forms (queue row 410)", () => {
  test("the recorded infeasible inside files summary becomes a scope request naming its path and comma or space separated lists name every path", () => {
    expect(read(LINE_1814)).toMatchObject({ kind: "scope-request", source: "worker", paths: ["tests/cli/vendor-truth.test.ts"] });
    expect(read("infeasible inside files[]: src/a.ts, src/b.ts — reason")).toMatchObject({ kind: "scope-request", paths: ["src/a.ts", "src/b.ts"] });
    expect(read("infeasible inside files[]: src/a.ts src/b.ts")).toMatchObject({ kind: "scope-request", paths: ["src/a.ts", "src/b.ts"] });
    // Whole repository-relative tokens: names the prose lexer cannot spell are still every path.
    for (const path of odd) expect(read(`infeasible inside files[]: ${path}`), path).toMatchObject({ kind: "scope-request", paths: [path] });
    expect(read("infeasible inside files[]: Dockerfile, .gitignore, src/über.ts src/a+b.ts src/a.ts — src/b.ts"))
      .toMatchObject({ kind: "scope-request", paths: [".gitignore", "Dockerfile", "src/a+b.ts", "src/a.ts", "src/über.ts"] });
  });

  test("lawful path tokens keep every literal character (D-2187 add.122)", () => {
    const literal = ["src/trailing.", "src/quoted'", "'leading.ts", "src/trailing.."];
    const readIn = (inv: string[], summary: string) => classifyRepairDisposition({ files, inventory: inv, results: [lint], refusalSummary: summary });
    for (const path of literal) {
      expect(readIn([...inventory, ...literal, "src/trailing", "src/quoted", "leading.ts"], `infeasible inside files[]: ${path}`), path)
        .toMatchObject({ kind: "scope-request", paths: [path] });
    }
    expect(readIn([...inventory, "src/trailing.", "src/trailing"], "infeasible inside files[]: src/trailing."))
      .toMatchObject({ kind: "scope-request", paths: ["src/trailing."] });
    expect(readIn(inventory, "infeasible inside files[]: src/a.ts.")).toMatchObject({ kind: "none", paths: [] });
  });

  test("a different unowned path after each delimiter is never named and an uppercase lawful prefix still parses", () => {
    for (const delimiter of [" — ", " - ", ";"]) {
      expect(read(`infeasible inside files[]: src/a.ts${delimiter}mentions src/b.ts`)).toMatchObject({ kind: "scope-request", paths: ["src/a.ts"] });
    }
    expect(read("INFEASIBLE INSIDE FILES[]: src/a.ts")).toMatchObject({ kind: "scope-request", paths: ["src/a.ts"] });
  });

  test("the infeasible form naming a path inside files and the bare word infeasible are not refusals", () => {
    expect(read("infeasible inside files[]: src/run/widget.ts")).toMatchObject({ kind: "none", paths: [] });
    expect(read("the change is infeasible")).toEqual(read(undefined));
    expect(read("the change is infeasible src/a.ts").kind).toBe("none");
  });

  test("each existing refusal alternative alone and an ok true result read exactly as before", () => {
    for (const summary of ["x.ts is outside the task", "x.ts is not on my allowlist", "x.ts is out of scope",
      "x.ts needs a scope expansion", "x.ts is not in files[]", "I do not own x.ts", "x.ts is unowned"]) {
      expect(read(summary), summary).toMatchObject({ kind: "scope-request", source: "worker", paths: ["x.ts"] });
    }
    expect(read("x.ts is fine").kind).toBe("none");
    // ok:true → the daemon supplies no refusal summary, so the lawful form is never read
    expect(read(undefined)).toMatchObject({ kind: "none", paths: [] });
  });
});

describe("the lawful form through the daemon (queue row 410)", () => {
  beforeEach(() => { setHostLatencySampleForTests(async () => 20); });
  afterEach(() => { resetHostLatencySampleForTests(); });

  // The daemon forwards only an ok:false summary; the same lawful text on ok:true is never a refusal.
  test.each([[false, "needed.txt"], [true, "needed.txt"], [false, "needed.txt."]] as const)("a lawful summary on a worker result with ok %s naming %s", async (ok, path) => {
    const result = { shell: "true", result: { ok, summary: `infeasible inside files[]: ${path} — only a grant fixes it` } };
    const { repo, fake } = setupRepo([T("T1", { files: ["owned.txt"] })],
      { consult: { action: "human", notes: "operator decides" }, tasks: { T1: Array.from({ length: 6 }, () => result) } });
    for (const seeded of ["needed.txt", path]) writeFileSync(join(repo, seeded), "needs repair\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "--no-gpg-sign", "-m", "seed requested path"], { cwd: repo });
    const id = `run-lawful-${ok}-${path.length}`;
    await runDaemon(repo, { adapters: [fake], runId: id, approvalWindowMs: 0 });
    const requests = Journal.open(repo, id).read().filter((e) => e.taskId === "T1" && e.event === "scope-request");
    if (ok) expect(requests).toEqual([]);
    else expect(requests[0]?.data).toMatchObject({ paths: [path] });
  }, 60_000);
});
