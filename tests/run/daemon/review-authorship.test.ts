import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../../src/adapters/types.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { captureBaseline } from "../../../src/gates/baseline.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import { graphDefinitionHash, loadGraph } from "../../../src/graph/graph.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

class ThirdReviewer extends FakeAdapter {
  override id = "third-review";
  override vendor = "third-vendor";
  calls = 0;
  green = false;
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
  override headlessCommand(file: string): string {
    this.calls++;
    const text = readFileSync(file, "utf8");
    const prior = [...text.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]);
    return `printf '%s\\n' ${shq(JSON.stringify({ nonce: extractPromptNonce(text), approve: this.green,
      resolved: this.green ? prior : [], reraised: this.green ? [] : prior,
      findings: this.green ? [] : [{ note: "work.txt still needs correction", severity: "material", ...(prior[0] ? { reraised: prior[0] } : {}) }],
    }))}`;
  }
}

function twoVendors(fake: FakeAdapter) {
  fake.channels = () => [
    { adapter: "fake", model: "fake-1", vendor: "openai", channel: "sub", tier: "frontier" },
    { adapter: "fake", model: "fake-2", vendor: "anthropic", channel: "api", tier: "frontier" },
  ];
  return fake;
}
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

// A real preserved openai attempt, followed by an operator-funded repair. The reset and
// fresh daemon prove ownership is lifetime journal evidence, independent of attempt/tried budgets.
async function repairFixture(carryOnly = false, missing: false | "channel" | "assignment" = false) {
  const made = setupRepo([T("T1", { files: ["work.txt", "fix.txt"], gates: ["build", "test", "lint", "evidence", "scope", "review"] })], {
    tasks: { T1: [{ shell: carryOnly ? "test -f work.txt" : `echo fix > fix.txt && ${COMMIT} fix`, result: { ok: true, summary: "repaired" } }] },
  }, "review: { required: false }\nrouting: { deny: { workers: { adapters: [third-review] } } }\n");
  twoVendors(made.fake);
  const runId = "run-author-repair";
  const baseRef = git(made.repo, "rev-parse", "HEAD");
  const branch = `tickmarkr/${runId}`;
  const wt = await new SubprocessDriver().worktree(made.repo, `${branch}--T1`, baseRef);
  writeFileSync(join(wt, "work.txt"), "original work\n");
  git(wt, "add", "work.txt");
  // Force cherry-picks to have new hashes, without relying on a wall-clock second rolling over.
  execFileSync("git", ["commit", "--no-gpg-sign", "-m", "original"], { cwd: wt,
    env: { ...process.env, GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" } });
  const original = git(wt, "rev-parse", "HEAD");
  const journal = Journal.create(made.repo, runId);
  journal.append("run-start", undefined, { baseRef, branch, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(made.repo)) });
  journal.append("task-dispatch", "T1", { attempt: 0, ...(missing === "assignment" ? {} : {
    assignment: { adapter: missing === "channel" ? "vanished" : "fake", model: "fake-1", channel: "sub", tier: "frontier" },
  }) });
  journal.append("worker-result", "T1", { ok: true, summary: "original work", deviations: [] });
  journal.phaseStart("T1", "gates");
  journal.append("gate-result", "T1", { gate: "review", pass: false, details: "request changes: work.txt needs correction" });
  journal.append("task-human", "T1", { kind: "gate-fail", reason: "review needs correction" });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(await captureBaseline(made.repo, {})));
  await approve([runId, "T1", "--uphold", "--review-rounds", "1"], made.repo);
  return { ...made, runId, journal, wt, original };
}

test("test: a task whose subject carries commits from an openai worker attempt and an anthropic repair attempt is reviewed by a third vendor's seat on first review and again when a recheck restores its review, so a reviewer sharing any commit author's vendor fails", async () => {
  const f = await repairFixture();
  const third = new ThirdReviewer(f.scriptPath);
  const adapters = [f.fake, third];
  expect((await runDaemon(f.repo, { adapters, runId: f.runId, resume: true })).human).toEqual(["T1"]);
  let rows = f.journal.read();
  expect(rows.filter((r) => r.event === "task-dispatch").at(-1)?.data.assignment).toMatchObject({ model: "fake-2" });
  expect(third.calls).toBe(1);
  expect(rows.filter((r) => r.event === "gate-result" && r.data.gate === "review").at(-1)?.data.reviewer).toBe("third-review:third-review");
  await approve([f.runId, "T1", "--recheck", "--review-rounds", "1"], f.repo);
  third.green = true;
  expect((await runDaemon(f.repo, { adapters: [twoVendors(new FakeAdapter(f.scriptPath)), third], runId: f.runId, resume: true })).done).toEqual(["T1"]);
  rows = f.journal.read();
  expect(third.calls).toBe(2);
  expect(rows.filter((r) => r.event === "task-dispatch")).toHaveLength(2);
  expect(rows.filter((r) => r.event === "gate-result" && r.data.gate === "review").slice(1).map((r) => r.data.reviewer))
    .toEqual(["third-review:third-review", "third-review:third-review"]);
}, 90_000);

test("test: the same mixed subject in a fleet whose review pool holds only those two vendors parks on a failed review gate naming both author vendors before any repair or consult even when review is not required, and an operator waive of that park merges it without another dispatch, so a merge before the waive or a funded repair or an unwaivable park fails", async () => {
  const f = await repairFixture();
  const before = f.journal.read().length;
  expect((await runDaemon(f.repo, { adapters: [f.fake], runId: f.runId, resume: true })).human).toEqual(["T1"]);
  const rows = f.journal.read().slice(before);
  expect(rows.filter((r) => ["repair-attempt", "consult-verdict", "merge"].includes(r.event))).toEqual([]);
  expect(rows.find((r) => r.event === "gate-result" && r.data.gate === "review")?.data).toMatchObject({ pass: false, noEligibleReviewer: true });
  const park = rows.find((r) => r.event === "task-human")!;
  expect(park.data.kind).toBe("gate-fail");
  expect(park.data.reason).toContain("openai");
  expect(park.data.reason).toContain("anthropic");
  // Restore the red once too: it must not buy a repair or consult on the recheck path.
  await approve([f.runId, "T1", "--recheck"], f.repo);
  const recheckStart = f.journal.read().length;
  expect((await runDaemon(f.repo, { adapters: [f.fake], runId: f.runId, resume: true })).human).toEqual(["T1"]);
  expect(f.journal.read().slice(recheckStart).filter((r) => ["task-dispatch", "repair-attempt", "consult-verdict", "merge"].includes(r.event))).toEqual([]);
  await approve([f.runId, "T1", "--waive"], f.repo);
  expect((await runDaemon(f.repo, { adapters: [f.fake], runId: f.runId, resume: true })).done).toEqual(["T1"]);
  expect(f.journal.read().filter((r) => r.event === "task-dispatch")).toHaveLength(2);
}, 90_000);

test("test: a subject authored by one vendor seats another vendor's reviewer exactly as today even when the dispatched seat only carried that work forward under new hashes and committed nothing, so an exclusion of a seat that authored nothing or an attribution joined by hash fails", async () => {
  const f = await repairFixture(true);
  expect((await runDaemon(f.repo, { adapters: [f.fake], runId: f.runId, resume: true })).done).toEqual(["T1"]);
  const rows = f.journal.read();
  expect(rows.filter((r) => r.event === "task-dispatch").at(-1)?.data.assignment).toMatchObject({ model: "fake-2" });
  expect(rows.filter((r) => r.event === "gate-result" && r.data.gate === "review").at(-1)?.data.reviewer).toBe("fake:fake-2");
  const mergedPatch = git(f.repo, "log", "--format=%H", `tickmarkr/${f.runId}`, "--", "work.txt");
  expect(mergedPatch).not.toBe(f.original);
  expect(rows.find((r) => r.event === "worktree-recreation")?.data.carried).toEqual([f.original]);
}, 90_000);

test("test: a failover attempt that committed nothing leaves its vendor eligible to review the next attempt's work, so an exclusion taken from every tried channel fails", async () => {
  const f = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "review"] })], { tasks: { T1: [
    { shell: "echo 'usage limit reached for this model'; exit 1" },
    { shell: `echo work > work.txt && ${COMMIT} work`, result: { ok: true, summary: "done" } },
  ] } });
  twoVendors(f.fake);
  expect((await runDaemon(f.repo, { adapters: [f.fake], runId: "run-no-patch" })).done).toEqual(["T1"]);
  const rows = Journal.open(f.repo, "run-no-patch").read();
  expect(rows.filter((r) => r.event === "task-dispatch")).toHaveLength(2);
  expect(rows.find((r) => r.event === "gate-result" && r.data.gate === "review")?.data.reviewer).toBe("fake:fake-1");
}, 90_000);

test("test: an author channel whose vendor the current review pool cannot resolve parks the task naming that channel, so an unresolvable author that excludes nothing fails", async () => {
  for (const missing of ["channel", "assignment"] as const) {
    const f = await repairFixture(false, missing);
    const third = new ThirdReviewer(f.scriptPath);
    third.green = true;
    expect((await runDaemon(f.repo, { adapters: [f.fake, third], runId: f.runId, resume: true })).human).toEqual(["T1"]);
    const rows = f.journal.read();
    const park = rows.filter((r) => r.event === "task-human").at(-1)!;
    expect(park.data.kind).toBe("gate-fail");
    expect(park.data.reason).toContain(missing === "channel" ? "vanished:fake-1" : "missing task-dispatch assignment");
    expect(third.calls).toBe(0);
    expect(rows.some((r) => r.event === "merge")).toBe(false);
  }
}, 90_000);
