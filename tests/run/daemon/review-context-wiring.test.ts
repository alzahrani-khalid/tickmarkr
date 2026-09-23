// v2.5.6 Leg-2 (OBS-1052): the daemon threads `reviewNoVerdicts` into GateContext. Without it
// run-gates' two-strike retirement (OBS-1025 add.2) is inert in production: a flaking seat is
// re-asked on every task and the review-recovery spend is unbounded. Fake adapters, zero tokens.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../../src/adapters/types.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

// A review-only seat with its own adapter id and vendor. `prose` seats never emit a trailer.
class ReviewSeat extends FakeAdapter {
  calls = 0;
  constructor(path: string, public override id: string, public override vendor: string, private prose = false) {
    super(path);
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
  override headlessCommand(promptFile: string): string {
    this.calls++;
    if (this.prose) return "printf 'Review completed, but no structured verdict was returned.'";
    const nonce = extractPromptNonce(readFileSync(promptFile, "utf8"));
    return `printf '%s\\n' ${shq(JSON.stringify({ nonce, approve: true, issues: [] }))}`;
  }
}

const pin = { routingHints: { pin: { via: "fake", model: "fake-1" } } };
const work = (id: string) => [{ shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } }];

test("Leg-2 (OBS-1052): a seat with no verdict on rounds 1 and 2 is absent from round 3's eligible set — the run's review dispatches stay bounded", async () => {
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", pin), T("T2", { deps: ["T1"], ...pin }), T("T3", { deps: ["T2"], ...pin })],
    { tasks: { T1: work("t1"), T2: work("t2"), T3: work("t3") } },
    "review: { required: true, prefer: [seat-a, seat-b] }\nrouting: { deny: { workers: { adapters: [seat-a, seat-b] } } }\n",
  );
  fake.channels = () => [{ adapter: "fake", model: "fake-1", vendor: fake.vendor, channel: "sub", tier: "frontier" }];
  const flaky = new ReviewSeat(scriptPath, "seat-a", "vendor-a", true);
  const steady = new ReviewSeat(scriptPath, "seat-b", "vendor-b");
  const runId = "run-leg2-two-strike";
  const result = await runDaemon(repo, { adapters: [fake, flaky, steady], runId, concurrency: 1 });
  expect(result.done).toEqual(["T1", "T2", "T3"]);
  // strike on T1, strike on T2, retired for T3: the flaky seat is asked exactly twice in the run
  expect([flaky.calls, steady.calls]).toEqual([2, 3]);
  const events = Journal.open(repo, runId).read();
  expect(events.filter((e) => e.event === "review-no-verdict").map((e) => [e.taskId, e.data.reviewer])).toEqual([["T1", "seat-a:seat-a"], ["T2", "seat-a:seat-a"]]);
  expect(events.filter((e) => e.event === "review-pool-demotion").map((e) => [e.taskId, e.data.reviewer, e.data.causes]))
    .toEqual([["T2", "seat-a:seat-a", ["no-verdict", "no-verdict"]]]);
  const t3Review = events.filter((e) => e.taskId === "T3" && e.event === "gate-result" && e.data.gate === "review");
  expect(t3Review.map((e) => [e.data.reviewer, e.data.reviewRetry])).toEqual([["seat-b:seat-b", undefined]]);
}, 90_000);

test("test: the daemon binds the newest approval reason before the released task dispatch then passes it into that attempt's review rounds reviewer failovers plus its no worker recheck brief whereas a later engagement without a reason inherits none, so a scan after the current dispatch that loses the reason fails", async () => {
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", { ...pin, humanGate: true, files: ["t1.txt"], gates: ["build", "test", "lint", "evidence", "scope", "review"] })],
    { tasks: { T1: [
      { shell: `echo one > t1.txt && ${COMMIT} first`, result: { ok: true, summary: "first" } },
      { shell: `echo two > t1.txt && ${COMMIT} second`, result: { ok: true, summary: "second" } },
    ] } },
    "review: { required: true, prefer: [seat-a, seat-b, seat-c] }\nrouting: { deny: { workers: { adapters: [seat-a, seat-b, seat-c] } } }\n",
  );
  fake.channels = () => [{ adapter: "fake", model: "fake-1", vendor: fake.vendor, channel: "sub", tier: "frontier" }];
  const runId = "run-operator-review-context";
  const journal = () => Journal.open(repo, runId);
  const briefs: { seat: string; text: string; dispatches: number }[] = [];
  let green = false;
  let steadyRounds = 0;
  // Move the tip after the daemon captures its gated commit. A green first review then
  // forces another round of the SAME dispatch, which must retain the bound reason.
  class MovingTipDriver extends SubprocessDriver {
    taskTree = "";
    moved = false;
    override async worktree(repo: string, branch: string, base: string) {
      const wt = await super.worktree(repo, branch, base);
      if (branch.endsWith("--T1")) this.taskTree = wt;
      return wt;
    }
    async project(_taskId: string, state: string) {
      if (state !== "in-review" || this.moved) return;
      this.moved = true;
      writeFileSync(join(this.taskTree, "t1.txt"), "one with concurrent tip movement\n");
      execSync("git add t1.txt && git commit --amend --no-edit --no-gpg-sign", { cwd: this.taskTree });
    }
  }
  const driver = new MovingTipDriver();
  const seats = ["seat-a", "seat-b", "seat-c"].map((id, i) => {
    const seat = new ReviewSeat(scriptPath, id, `vendor-${i}`);
    seat.headlessCommand = (file) => {
      const text = readFileSync(file, "utf8");
      briefs.push({ seat: id, text, dispatches: journal().read().filter((row) => row.event === "task-dispatch").length });
      // Exercise every in-gate reviewer failover.
      if (i < 2) return "printf 'No structured verdict available.'";
      const approveRound = green || ++steadyRounds === 1;
      const prior = [...text.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]);
      return `printf '%s\\n' ${shq(JSON.stringify({
        nonce: extractPromptNonce(text), approve: approveRound,
        resolved: approveRound ? prior : [], reraised: approveRound ? [] : prior,
        findings: approveRound ? [] : [{ note: "t1.txt loses selection", severity: "material", ...(prior[0] ? { reraised: prior[0] } : {}) }],
      }))}`;
    };
    return seat;
  });
  const adapters = [fake, ...seats];
  expect((await runDaemon(repo, { adapters, runId })).human).toEqual(["T1"]);
  journal().append("task-approved", "T1", { reason: "Superseded operator reason" });
  journal().append("task-human", "T1", { kind: "human-gate", reason: "operator decision pending" });
  const reason = "Keep explicit selection; verify the prepend behavior.";
  await approve([runId, "T1", "--reason", reason, "--review-rounds", "1"], repo);
  expect((await runDaemon(repo, { adapters, runId, resume: true, driver })).human).toEqual(["T1"]);
  expect(briefs.map((b) => b.seat)).toEqual(["seat-a", "seat-b", "seat-c", "seat-c"]);
  expect(journal().read().filter((e) => e.event === "tip-moved")).toHaveLength(1);
  for (const brief of briefs) {
    expect(brief.dispatches).toBe(1); // The binding survives its dispatch row landing.
    expect(brief.text).toContain(`## Operator context\n`);
    expect(brief.text).toContain(reason);
    expect(brief.text).not.toContain("Superseded operator reason");
  }
  expect(journal().read().filter((e) => e.event === "review-no-verdict")).toHaveLength(2);
  const recheckStart = journal().read().length;
  const recheckBriefStart = briefs.length;
  const recheckReason = "Re-measure the same design against the selection criterion.";
  await approve([runId, "T1", "--recheck", "--reason", recheckReason, "--review-rounds", "1"], repo);
  expect((await runDaemon(repo, { adapters, runId, resume: true, driver })).human).toEqual(["T1"]);
  const recheckRows = journal().read().slice(recheckStart);
  expect(recheckRows.some((e) => e.event === "recheck-battery")).toBe(true);
  expect(recheckRows.filter((e) => ["task-dispatch", "worker-launch"].includes(e.event))).toEqual([]);
  expect(briefs.length).toBeGreaterThan(recheckBriefStart);
  for (const brief of briefs.slice(recheckBriefStart)) {
    expect(brief.text).toContain(recheckReason);
    expect(brief.text).not.toContain(reason);
  }
  green = true;
  const laterStart = briefs.length;
  await approve([runId, "T1", "--uphold", "--review-rounds", "1"], repo);
  expect((await runDaemon(repo, { adapters, runId, resume: true, driver })).done).toEqual(["T1"]);
  expect(briefs.length).toBeGreaterThan(laterStart);
  for (const brief of briefs.slice(laterStart)) {
    expect(brief.dispatches).toBe(2);
    expect(brief.text).not.toContain("## Operator context");
    expect(brief.text).not.toContain(reason);
    expect(brief.text).not.toContain(recheckReason);
  }
  // Saved briefs must carry the same context as the actual adapter delivery.
  const saved = journal().read().filter((e) => e.event === "gate-result" && e.data.gate === "review" && e.data.briefPath);
  expect(saved.length).toBeGreaterThanOrEqual(3);
  for (const row of saved) {
    const text = readFileSync(String(row.data.briefPath), "utf8");
    expect(briefs.some((brief) => brief.text === text)).toBe(true);
  }
}, 90_000);
