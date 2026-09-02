// OBS-189: `approve --uphold` — the second decision a review park offers. Plain approve accepts the
// diff the reviewer rejected; --uphold sides WITH the reviewer and funds one fixed worker attempt.
// Fail-closed like every approve path: refusals are loud and append nothing.
import { describe, expect, test } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import { Journal } from "../../src/run/journal.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

const assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };

describe("tickmarkr approve --uphold (OBS-189, zero-token)", () => {
  test("uphold on a review park appends the review-upheld release and re-pends the task", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-uphold");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("gate-result", "T1", { gate: "review", pass: false, details: "requested changes" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "review round cap (2) reached this engagement" });

    const msg = await approve(["run-uphold", "T1", "--uphold", "--by", "operator"], repo);
    expect(msg).toMatch(/upheld the reviewer/);

    const approvals = j.read().filter((e) => e.event === "task-approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      taskId: "T1",
      data: { by: "operator", via: "cli", release: "review-upheld", gate: "review" },
    });
    // release marker discipline: an uphold is NOT a gate-satisfied — resume must re-run review
    expect(j.replaySatisfiedGates()).toEqual(new Map());
    expect(j.replayStatuses().get("T1")).toBe("pending");
  });

  test("uphold refuses when the last failed gate is not review, appending nothing", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-uphold-refuse");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("gate-result", "T1", { gate: "acceptance", pass: false, details: "judge failed" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "operator decision required" });

    await expect(approve(["run-uphold-refuse", "T1", "--uphold"], repo))
      .rejects.toThrow(/--uphold applies to a review gate-fail park/);
    expect(j.read().filter((e) => e.event === "task-approved")).toHaveLength(0);
  });

  test("uphold refuses a task that is not parked", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-uphold-notparked");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("task-done", "T1", { attempts: 1 });

    await expect(approve(["run-uphold-notparked", "T1", "--uphold"], repo))
      .rejects.toThrow(/not a parked human gate/);
    expect(j.read().filter((e) => e.event === "task-approved")).toHaveLength(0);
  });
});
