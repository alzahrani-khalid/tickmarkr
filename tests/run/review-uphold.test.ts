// OBS-189 (park-economics patch): a review park costs one decision, never a run. `approve --uphold`
// sides with the reviewer and funds ONE fixed worker attempt carrying the findings; the review round
// budget is scoped to the engagement (since the newest approval) so the funded attempt actually
// dispatches instead of re-parking against the whole journal's history — the defect that made a
// fresh journal (re-executing every green task) the only escape.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { approve } from "../../src/cli/commands/approve.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal, reviewRoundsSinceApproval, type JournalEvent } from "../../src/run/journal.js";
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
    const prompt = readFileSync(join(Journal.open(repo, runId).dir, "prompts", "T1-a0.md"), "utf8");
    expect(prompt).toMatch(/UPHELD/);
    expect(prompt).toMatch(/stat tile mislabeled/);
    expect(evs.some((e) => e.event === "consult-verdict")).toBe(false);
    expect(evs.some((e) => e.event === "merge" && e.taskId === "T1")).toBe(true);
  }, 120_000);
});
