// Row 419 (D-2187 add.89): every verify of a task carries its spec's outOfScope; only a verify bound to a run by
// `--record <run>` carries that run's rulings for the task — with or without --supersede — and a verify bound by
// task id alone never guesses a run. Disposable repositories, the fake adapter, zero tokens.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { approve } from "../../src/cli/commands/approve.js";
import { verify } from "../../src/cli/commands/verify.js";
import { getVerdictStore } from "../../src/gates/cache.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { Journal, owedSubject, type OwedCheck } from "../../src/run/journal.js";
import { authedModels, makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

const RUN = "run-rulings-verify";
const OTHER = "run-rulings-other";
const FILES = ["src/a.ts"];
const OOS = "Never rename the exported constant.";
const [R1, R2, R3] = ["Ruling one: the constant stays a number.", "Ruling two: no new file.", "Ruling three: the waive keeps its debt."];
const REASON = "Reason that must reach no brief.";
const HEADING = "## Rulings recorded during this run (binding)";
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();

afterEach(() => {
  delete process.env.TICKMARKR_FAKE_SCRIPT;
  vi.restoreAllMocks();
});

/** The review briefs the fake reviewer is handed, read at command-build time through the production seat. */
function captureReviewBriefs(): string[] {
  const briefs: string[] = [];
  const original = FakeAdapter.prototype.headlessCommand;
  vi.spyOn(FakeAdapter.prototype, "headlessCommand").mockImplementation(function (this: FakeAdapter, file: string, model: string) {
    const text = readFileSync(file, "utf8");
    if (text.startsWith("TICKMARKR-REVIEW")) briefs.push(text);
    return original.call(this, file, model);
  });
  return briefs;
}

const inOrder = (text: string, ...items: string[]) => items.map((item) => text.indexOf(item)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]!));

test("a verify bound to the run by record carries its rulings under supersede or not while an unbound verify carries only the spec out of scope", async () => {
  const repo = makeRepo({ "src/a.ts": "export const a = 1;\n" });
  const graph = validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [T("T1", { files: FILES, outOfScope: [OOS] }), T("T2", { files: FILES })] });
  saveGraph(repo, graph);
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "judge: { adapter: fake, model: fake-1 }\n");
  writeDoctor(repo, { fake: { installed: true, authed: true, models: ["fake-3"], modelAuth: authedModels(["fake-1", "fake-2"]) } });
  const script = join(makeTestTempDir("rulings-verify-script-"), "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
  process.env.TICKMARKR_FAKE_SCRIPT = script;
  vi.spyOn(console, "error").mockImplementation(() => {});

  git(repo, "branch", `tickmarkr/${RUN}`, "main");
  git(repo, "checkout", "-q", "-b", `tickmarkr/${RUN}--T1`);
  writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
  git(repo, "commit", "-q", "--no-gpg-sign", "-am", "feature");
  const head = git(repo, "rev-parse", "HEAD");
  const base = git(repo, "rev-parse", "main");
  git(repo, "checkout", "-q", "main");

  // Another run reusing T1 holds a ruling of its own: nothing binds it to this verify.
  const other = Journal.create(repo, OTHER);
  other.append("run-start", undefined, { baseRef: "main" });
  other.append("task-human", "T2", { kind: "human-gate", reason: "operator decision" });
  other.append("task-human", "T1", { kind: "human-gate", reason: "operator decision" });
  await approve([OTHER, "T1", "--ruling", "Other run's ruling.", "--by", "operator"], repo);
  await approve([OTHER, "T2", "--ruling", "Other run's T2 ruling.", "--by", "operator"], repo);

  // This run: two rulings on the first decision, a third on the waive; the reason rides beside them.
  const journal = Journal.create(repo, RUN);
  copyFileSync(join(repo, ".tickmarkr", "graph.json"), join(journal.dir, "graph.json"));
  journal.append("run-start", undefined, { baseRef: "main" });
  journal.append("task-human", "T1", { kind: "human-gate", reason: "operator decision" });
  await approve([RUN, "T1", "--ruling", R1, "--ruling", R2, "--reason", REASON, "--by", "operator"], repo);
  const dispatch = { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } };
  journal.append("task-dispatch", "T1", { attempt: 0, ...dispatch });
  journal.append("gate-result", "T1", { gate: "review", pass: false, details: "red", commit: owedSubject(repo, base, head) });
  journal.append("task-human", "T1", { kind: "gate-fail", reason: "operator decision" });
  await approve([RUN, "T1", "--waive", "--ruling", R3, "--by", "operator"], repo);
  const approvals = journal.read().filter((row) => row.event === "task-approved");
  expect(approvals.map((row) => row.data.ruling)).toEqual([[R1, R2], [R3]]);
  expect(approvals[0]!.data.reason).toBe(REASON);
  const obligation = approvals[1]!.data.obligation as OwedCheck;
  journal.append("run-end", undefined, { done: ["T1"], failed: [], human: [], blocked: [], pending: [] });

  git(repo, "checkout", "-q", "--detach", head);
  writeFileSync(join(repo, "src/a.ts"), "export const a = 3;\n");
  git(repo, "commit", "-q", "--no-gpg-sign", "-am", "fix");
  const briefs = captureReviewBriefs();
  const run = async (argv: string[]) => {
    getVerdictStore(join(repo, ".tickmarkr")).clear();
    const start = briefs.length;
    const result = await verify(argv, repo);
    expect(briefs.length, result.out).toBeGreaterThan(start);
    return briefs.slice(start);
  };
  const bound = (brief: string) => {
    expect(brief).toContain(`## Out of scope\nThe task declares these items out of scope.`);
    expect(brief).toContain(`- ${OOS}`);
    expect(brief).toContain(`${HEADING}\n- ${R1}\n- ${R2}\n- ${R3}\n`);
    expect(inOrder(brief, "## Out of scope", HEADING, "## Diff")).toBe(true);
    for (const absent of [REASON, "Other run's ruling.", "Other run's T2 ruling."]) expect(brief).not.toContain(absent);
  };

  // --record with --supersede: the run's rulings for T1, verbatim and in order, beside the snapshot's outOfScope.
  for (const brief of await run(["--record", RUN, "--task", "T1", "--base", "main", "--supersede", obligation.id, "--author", "human", "--no-acceptance", "--json"])) bound(brief);
  // --record without --supersede: the same rulings.
  for (const brief of await run(["--record", RUN, "--task", "T1", "--base", "main", "--no-acceptance"])) bound(brief);
  // No --record: the spec's outOfScope verbatim, and no run's rulings — never a latest-run guess from the task id.
  for (const brief of await run(["--task", "T1", "--base", "main", "--no-acceptance"])) {
    expect(brief).toContain(`- ${OOS}`);
    expect(brief).not.toContain(HEADING);
    for (const absent of [R1, R2, R3, REASON, "Other run's ruling."]) expect(brief).not.toContain(absent);
  }
  // Control: a task with neither renders neither heading.
  for (const brief of await run(["--task", "T2", "--base", "main", "--no-acceptance"])) {
    expect(brief).not.toContain("## Out of scope");
    expect(brief).not.toContain(HEADING);
  }
}, 120_000);
