// OBS-189 (park-economics patch): a review park costs one decision, never a run. `approve --uphold`
// sides with the reviewer and funds ONE fixed worker attempt carrying the findings; the review round
// budget is scoped to the engagement (since the newest approval) so the funded attempt actually
// dispatches instead of re-parking against the whole journal's history — the defect that made a
// fresh journal (re-executing every green task) the only escape.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { TickmarkrConfig } from "../../src/config/config.js";
import type { BillingChannel } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { runDaemon, type RunSummary } from "../../src/run/daemon.js";
import { gitHead, shOk } from "../../src/run/git.js";
import { GATE_SATISFIED_RELEASE, Journal, RECHECK_RELEASE, REVIEW_UPHELD_RELEASE, reviewRoundsSinceApproval, type JournalEvent } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const ev = (event: string, taskId: string, data: Record<string, unknown> = {}): JournalEvent =>
  ({ ts: "2026-07-28T00:00:00.000Z", event, taskId, data });

describe("reviewRoundsSinceApproval — engagement-scoped review rounds (OBS-189)", () => {
  test("counts failed review rounds and resets on every operator approval", () => {
    const events = [
      ev("gate-result", "T1", { gate: "review", pass: false, details: "r1" }),
      ev("gate-result", "T1", { gate: "review", pass: false, details: "r2" }),
      ev("gate-result", "T2", { gate: "review", pass: false, details: "other task" }),
      ev("gate-result", "T1", { gate: "review", pass: true, details: "approved" }),
    ];
    expect(reviewRoundsSinceApproval(events, "T1")).toBe(2);
    events.push(ev("task-approved", "T1", { by: "op", release: "review-upheld", gate: "review" }));
    expect(reviewRoundsSinceApproval(events, "T1")).toBe(0);
    events.push(ev("gate-result", "T1", { gate: "review", pass: false, details: "r3" }));
    expect(reviewRoundsSinceApproval(events, "T1")).toBe(1);
    expect(reviewRoundsSinceApproval(events, "T2")).toBe(1); // untouched by T1's approval
  });
});

describe("replayResumeState — the review-upheld release (OBS-189)", () => {
  const assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };

  test("uphold zeros the attempt budget, keeps tried, clears lastAssignment, and carries the findings", () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-uphold-replay");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("gate-result", "T1", { gate: "review", pass: false, details: "reviewer: stat tile mislabeled" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "review round cap" });
    j.append("task-approved", "T1", { by: "op", via: "cli", release: "review-upheld", gate: "review" });
    const rs = j.replayResumeState().get("T1");
    expect(rs).toBeDefined();
    expect(rs!.attempts).toBe(0);
    expect(rs!.tried).toEqual(["fake:fake-1"]);
    expect(rs!.lastAssignment).toBeUndefined();
    expect(rs!.upheldFeedback).toBe("reviewer: stat tile mislabeled");
  });

  test("a plain approval (no release marker) carries no findings and leaves the attempt budget alone", () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-plain-approve-replay");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("gate-result", "T1", { gate: "review", pass: false, details: "findings" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "cap" });
    j.append("task-approved", "T1", { by: "op", via: "cli" });
    const rs = j.replayResumeState().get("T1");
    expect(rs!.attempts).toBe(1);
    expect(rs!.upheldFeedback).toBeUndefined();
  });
});

// OBS-147 budget discipline: daemon round-trips carry an explicit 120s budget (see approve.test.ts).
describe("approve --uphold round trip — a park costs one attempt, never a run (OBS-189)", () => {
  test("park at the engagement round cap → uphold → resume dispatches ONE fixed attempt carrying the findings → green", async () => {
    const { repo, fake, scriptPath } = setupRepo(
      [T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })],
      {
        review: { approve: false, issues: ["stat tile mislabeled"] }, // request-changes every round
        consult: { action: "retry", notes: "must never fire" }, // review-fix retries bypass the ladder
        tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
      },
    );
    const runId = "run-uphold-trip";
    const first = await runDaemon(repo, { adapters: [fake], runId });
    expect(first.human).toEqual(["T1"]);
    const parked = Journal.open(repo, runId).read();
    // engagement cap 2: two review rounds ran, then the park — no third dispatch, no consult
    expect(parked.filter((e) => e.event === "task-dispatch").length).toBe(2);
    expect(String(parked.find((e) => e.event === "task-human")?.data.reason)).toMatch(/--uphold/);
    const prompts = join(Journal.open(repo, runId).dir, "prompts");
    const firstEngagementPrompt = readFileSync(join(prompts, "T1-a0.md"));

    const msg = await approve([runId, "T1", "--uphold", "--by", "operator"], repo);
    expect(msg).toMatch(/upheld the reviewer/);

    // the next review approves (the fix attempt addressed the findings)
    const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Record<string, unknown>;
    writeFileSync(scriptPath, JSON.stringify({ ...script, review: { approve: true, issues: [] } }));

    // fresh adapter instance re-reads the script; same journal — the run is NOT restarted
    const resumed = await runDaemon(repo, { adapters: [new FakeAdapter(scriptPath)], runId, resume: true });
    expect(resumed.done).toEqual(["T1"]);
    const evs = Journal.open(repo, runId).read();
    // exactly ONE funded attempt on top of the two parked rounds — never a fresh journal
    expect(evs.filter((e) => e.event === "task-dispatch").length).toBe(3);
    // the funded attempt's prompt carries the upheld findings as its brief
    const prompt = readFileSync(join(prompts, "T1-a0.md"), "utf8");
    expect(readFileSync(join(prompts, "T1-a0-engagement-0.md"))).toEqual(firstEngagementPrompt);
    expect(prompt).toMatch(/UPHELD/);
    expect(prompt).toMatch(/stat tile mislabeled/);
    expect(evs.some((e) => e.event === "consult-verdict")).toBe(false);
    expect(evs.some((e) => e.event === "merge" && e.taskId === "T1")).toBe(true);
  }, 120_000);
});

interface PostApprovalUpholdResult {
  completedJournal: Journal;
  fundedEvents: JournalEvent[];
  fundedSummary: RunSummary;
  prompt: string;
  staleEvents: JournalEvent[];
  staleSummary: RunSummary;
}

async function postApprovalUpholdScenario(): Promise<PostApprovalUpholdResult> {
  const runId = "run-post-approval-uphold";
  const commands = { build: "true", test: "true", lint: "true" };
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", {
      complexity: 8,
      files: ["**"],
      gates: ["build", "test", "lint", "evidence", "scope", "acceptance", "review"],
      acceptance: [{ oracle: "command", command: "true" }],
    })],
    {
      review: { approve: false, issues: ["stat tile mislabeled"] },
      tasks: {
        T1: [{
          shell: `echo fixed >> work.txt && ${COMMIT} fixed`,
          result: { ok: true, summary: "fixed the stat tile" },
        }],
      },
    },
    `gates: { build: "true", test: "true", lint: "true" }\n`,
  );
  const baseRef = await gitHead(repo);
  const branch = `tickmarkr/${runId}`;
  const taskBranch = `${branch}--T1`;
  const priorWt = await new SubprocessDriver().worktree(repo, taskBranch, baseRef);
  writeFileSync(join(priorWt, "work.txt"), "stale\n");
  await shOk("git add work.txt && git commit --no-gpg-sign -m stale", priorWt);

  const baseline = await captureBaseline(repo, commands);
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, {
    baseRef,
    commands,
    branch,
    graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
  });
  journal.append("task-dispatch", "T1", {
    assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
    attempt: 0,
  });
  journal.append("worker-result", "T1", {
    ok: true,
    summary: "stale work",
    deviations: [],
  });
  journal.phaseStart("T1", "gates");
  journal.append("gate-result", "T1", {
    gate: "build",
    pass: false,
    details: "operator waived this build failure",
  });
  journal.append("task-human", "T1", { reason: "build failed", kind: "gate-fail" });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(baseline));
  await approve([runId, "T1", "--waive", "--by", "operator"], repo);

  const staleStart = journal.read().length;
  const staleSummary = await runDaemon(repo, { adapters: [fake], runId, resume: true });
  const staleEvents = Journal.open(repo, runId).read().slice(staleStart);
  await approve([runId, "T1", "--uphold", "--by", "operator"], repo);

  const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Record<string, unknown>;
  writeFileSync(scriptPath, JSON.stringify({ ...script, review: { approve: true, issues: [] } }));
  const fundedStart = Journal.open(repo, runId).read().length;
  const fundedSummary = await runDaemon(repo, {
    adapters: [new FakeAdapter(scriptPath)],
    runId,
    resume: true,
  });
  const completedJournal = Journal.open(repo, runId);
  return {
    completedJournal,
    fundedEvents: completedJournal.read().slice(fundedStart),
    fundedSummary,
    prompt: readFileSync(join(completedJournal.dir, "prompts", "T1-a0.md"), "utf8"),
    staleEvents,
    staleSummary,
  };
}

describe("post-approval review uphold consumes an earlier waiver (OBS-571)", () => {
  let scenario: PostApprovalUpholdResult;

  beforeAll(async () => {
    scenario = await postApprovalUpholdScenario();
  }, 120_000);

  test("test: resume after an uphold on a task re-parked post-approval dispatches a worker carrying the upheld review findings and gates its new commits with build and test present while the shipped gates-only battery on the stale commit with the waived gate skipped fails", () => {
    expect(scenario.staleSummary.human).toEqual(["T1"]);
    expect(scenario.staleEvents.some((e) => e.event === "task-dispatch")).toBe(false);
    expect(scenario.staleEvents.some((e) => e.event === "gate-result" && e.data.gate === "build")).toBe(false);
    expect(scenario.staleEvents.some((e) => e.event === "gate-result" && e.data.gate === "test")).toBe(true);
    expect(scenario.staleEvents.some((e) =>
      e.event === "gate-result" && e.data.gate === "review" && e.data.pass === false
    )).toBe(true);

    expect(scenario.fundedSummary.done).toEqual(["T1"]);
    expect(scenario.fundedEvents.some((e) => e.event === "task-dispatch")).toBe(true);
    expect(scenario.prompt).toMatch(/UPHELD/);
    expect(scenario.prompt).toMatch(/stat tile mislabeled/);
    expect(scenario.fundedEvents.some((e) => e.event === "gate-result" && e.data.gate === "build")).toBe(true);
    expect(scenario.fundedEvents.some((e) => e.event === "gate-result" && e.data.gate === "test")).toBe(true);
  });

  test("test: a gate waived for one enactment is run again on any later attempt's new commits so a funded attempt's battery includes the previously waived gate while a waiver that carries into commits it never released fails", () => {
    const staleCommit = scenario.staleEvents.find((e) =>
      e.event === "gate-result" && e.data.gate === "test"
    )?.data.commit;
    const fundedBuild = scenario.fundedEvents.find((e) =>
      e.event === "gate-result" && e.data.gate === "build"
    );
    const fundedTest = scenario.fundedEvents.find((e) =>
      e.event === "gate-result" && e.data.gate === "test"
    );

    expect(scenario.completedJournal.replaySatisfiedGates().size).toBe(0);
    expect(fundedBuild?.data.pass).toBe(true);
    expect(fundedTest?.data.pass).toBe(true);
    expect(fundedBuild?.data.commit).toBe(fundedTest?.data.commit);
    expect(fundedBuild?.data.commit).not.toBe(staleCommit);
  });
});

class OneChannelFake extends FakeAdapter {
  channels(_cfg: TickmarkrConfig): BillingChannel[] {
    return [{ adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" }];
  }
}

const approvalCommands = (reason: string): string[] =>
  [...reason.matchAll(/`(tickmarkr approve [^`]+)`/g)].map((m) => m[1]!);

async function identicalFailureParkReason(): Promise<string> {
  const { repo, scriptPath } = setupRepo(
    [T("T1", { acceptance: [{ oracle: "command", command: "true" }] })],
    {
      consult: { action: "retry", notes: "try again" },
      tasks: { T1: [{ shell: "true", result: { ok: true, summary: "no commits" } }] },
    },
  );
  const summary = await runDaemon(repo, { adapters: [new OneChannelFake(scriptPath)], runId: "run-identical-reason" });
  expect(summary.human).toEqual(["T1"]);
  return String(Journal.open(repo, "run-identical-reason").read().find((e) => e.event === "task-human" && e.taskId === "T1")?.data.reason);
}

async function reviewCapParkReason(): Promise<string> {
  const { repo, fake } = setupRepo(
    [T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })],
    {
      review: { approve: false, issues: ["still wrong"] },
      tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
    },
  );
  const summary = await runDaemon(repo, { adapters: [fake], runId: "run-review-cap-reason" });
  expect(summary.human).toEqual(["T1"]);
  return String(Journal.open(repo, "run-review-cap-reason").read().find((e) => e.event === "task-human" && e.taskId === "T1")?.data.reason);
}

async function releaseFromPrintedCommand(command: string, gate: "review" | "test" | "evidence") {
  const [, , runId, taskId, ...flags] = command.split(" ");
  const { repo } = setupRepo([T(taskId)], { tasks: {} });
  const j = Journal.create(repo, runId);
  j.append("gate-result", taskId, { gate, pass: false, details: `${gate} failed` });
  j.append("task-human", taskId, { kind: "gate-fail", reason: "parked" });
  await approve([runId, taskId, ...flags], repo);
  return Journal.open(repo, runId).read().find((e) => e.event === "task-approved" && e.taskId === taskId)!;
}

test("test: every daemon-authored gate-fail park reason — the post-approval, review-round-cap and identical-failure-ban parks, never a consult verdict's own text — keeps its shipped reason identity, review round cap (N) reached this engagement, post-approval gate failed and identical failure twice this engagement, with executable tickmarkr approve commands appended carrying --waive and --recheck and additionally --uphold on a review gate-fail, so invoking each command exactly as printed appends its matching release and no flag-free approve command is advertised, while commands replacing the reason, token-only prose, or the shipped bare-approve prescription fails", async () => {
  const postApproval = (await postApprovalUpholdScenario()).staleEvents
    .find((e) => e.event === "task-human" && e.taskId === "T1")!;
  const reasons = [
    { reason: String(postApproval.data.reason), gate: "review" as const, uphold: true },
    { reason: await reviewCapParkReason(), gate: "review" as const, uphold: true },
    { reason: await identicalFailureParkReason(), gate: "evidence" as const, uphold: false },
  ];

  expect(reasons[0]!.reason).toContain("post-approval gate failed");
  expect(reasons[1]!.reason).toMatch(/review round cap \(\d+\) reached this engagement/);
  expect(reasons[2]!.reason).toContain("identical evidence failure twice this engagement");

  for (const { reason, gate, uphold } of reasons) {
    const commands = approvalCommands(reason);
    expect(commands.some((command) => / --waive\b/.test(command))).toBe(true);
    expect(commands.some((command) => / --recheck\b/.test(command))).toBe(true);
    expect(commands.some((command) => / --uphold\b/.test(command))).toBe(uphold);
    expect(commands.every((command) => / --(waive|recheck|uphold)\b/.test(command))).toBe(true);
    expect(commands.some((command) => /^tickmarkr approve \S+ \S+$/.test(command))).toBe(false);
    for (const command of commands) {
      const approval = await releaseFromPrintedCommand(command, gate);
      if (command.includes("--waive")) expect(approval.data.release).toBe(GATE_SATISFIED_RELEASE);
      if (command.includes("--recheck")) expect(approval.data.release).toBe(RECHECK_RELEASE);
      if (command.includes("--uphold")) expect(approval.data.release).toBe(REVIEW_UPHELD_RELEASE);
    }
  }
}, 180_000);
