import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { approve } from "../../src/cli/commands/approve.js";
import { verify } from "../../src/cli/commands/verify.js";
import type { GateResult } from "../../src/gates/types.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { foldOwedChecks, Journal, owedSubject } from "../../src/run/journal.js";
import { authedModels, makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

const ASSUMPTION = "verify: no --author given — review treats this diff as human-written and may seat a reviewer of the vendor that wrote it; pass --author <adapter:model> naming the agent that wrote it";
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("test: standalone verify whose review runs with no author and no binding recorded authors prints the one human-written assumption line naming the author flag, as for a record owing nothing, while a human or adapter and model author, a record whose authors bind, no review, and criteria with no review print none, so a silent or ungated assumption fails", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const script = join(makeTestTempDir("verify-author-assumption-"), "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
  vi.stubEnv("TICKMARKR_FAKE_SCRIPT", script);

  const cases = [
    { name: "none", args: [], advisory: true, reviewer: "fake:fake-1" },
    { name: "human", args: ["--author", "human"], advisory: false, reviewer: "fake:fake-1" },
    { name: "agent", args: ["--author", "fake:fake-1"], advisory: false, reviewer: "fake:fake-2" },
    { name: "record-bound", args: ["--task", "T1", "--no-acceptance", "--record", "run-author-assumption"], advisory: false, reviewer: "fake:fake-2" },
    { name: "record-empty", args: ["--record", "run-author-assumption"], advisory: true, reviewer: "fake:fake-1" },
    { name: "no-review", args: ["--no-review"], advisory: false, reviewer: undefined },
    { name: "criteria-no-review", args: ["--criteria", "criteria.txt", "--no-review"], advisory: false, reviewer: undefined },
  ];

  for (const entry of cases) {
    // Each base is distinct so every case captures a real baseline, rather than reusing another's.
    const repo = makeRepo({
      ".gitignore": ".tickmarkr/\n",
      "src.txt": `base ${entry.name}\n`,
      "criteria.txt": "command: true\n",
    });
    const runId = "run-author-assumption";
    git(repo, "branch", `tickmarkr/${runId}`, "main");
    git(repo, "checkout", "-b", `tickmarkr/${runId}--T1`);
    writeFileSync(join(repo, "src.txt"), `base ${entry.name}\nfeature\n`);
    git(repo, "add", "src.txt");
    git(repo, "commit", "--no-gpg-sign", "-m", "feature");
    saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", { files: ["src.txt"] })] }));
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "gates:\n  build: 'true'\n");
    writeDoctor(repo, { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } });

    if (entry.name.startsWith("record-")) {
      const journal = Journal.create(repo, runId);
      journal.append("run-start", undefined, { baseRef: "main" });
      if (entry.name === "record-bound") {
        const head = git(repo, "rev-parse", "HEAD");
        const base = git(repo, "rev-parse", "main");
        journal.append("task-dispatch", "T1", { attempt: 0, assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } });
        journal.append("gate-result", "T1", { gate: "review", pass: false, details: "red", commit: owedSubject(repo, base, head) });
        journal.append("task-human", "T1", { kind: "gate-fail", reason: "operator decision" });
        git(repo, "checkout", "main");
        await approve([runId, "T1", "--waive", "--by", "operator", "--reason", "author assumption fixture"], repo);
        expect(foldOwedChecks(journal.read(), repo)).toMatchObject({ known: true, debt: 1, outstanding: [{ authors: ["fake:fake-1"] }] });
        git(repo, "checkout", "--detach", head);
      } else {
        expect(foldOwedChecks(journal.read(), repo)).toMatchObject({ known: true, debt: 0, outstanding: [] });
      }
    }

    errors.mockClear();
    const args = entry.args.map((arg) => arg === "criteria.txt" ? join(repo, arg) : arg);
    const result = await verify(["--json", ...args], repo);
    expect(result.code, `${entry.name}: ${result.out}`).toBe(0);
    expect(result.out, entry.name).not.toContain(ASSUMPTION);
    const lines = errors.mock.calls.map((call) => call.map(String).join(" "));
    expect(lines.filter((line) => line.includes("no --author given")), entry.name).toEqual(entry.advisory ? [ASSUMPTION] : []);
    const captureAt = lines.findIndex((line) => line.startsWith("verify: capturing baseline at merge-base"));
    expect(captureAt, `${entry.name}: baseline capture ran`).toBeGreaterThan(-1);
    if (entry.advisory) expect(lines.indexOf(ASSUMPTION), entry.name).toBeLessThan(captureAt);

    const rows = (JSON.parse(result.out) as { results: GateResult[] }).results;
    const review = rows.find((row) => row.gate === "review");
    if (entry.reviewer) {
      expect(review, entry.name).toMatchObject({ pass: true, meta: { reviewer: entry.reviewer } });
    } else {
      expect(review, entry.name).toBeUndefined();
    }
    if (entry.name === "criteria-no-review") expect(rows.find((row) => row.gate === "acceptance")?.pass).toBe(true);
  }
}, 120_000);
