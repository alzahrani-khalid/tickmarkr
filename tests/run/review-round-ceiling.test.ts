import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { approve } from "../../src/cli/commands/approve.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const rejectedReviewRun = () => setupRepo(
  [T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })],
  {
    review: { approve: false, issues: ["review still requests changes"] },
    consult: { action: "retry", notes: "review retries must not consult" },
    tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
  },
);

const taskEvents = (repo: string, runId: string) =>
  Journal.open(repo, runId).read().filter((event) => event.taskId === "T1");

describe("operator-stated review round ceiling (OBS-419)", () => {
  test("test: a task released with a stated ceiling of further review rounds parks again once that many decisive rounds have been drawn, rather than at the module default", async () => {
    const { repo, fake, scriptPath } = rejectedReviewRun();
    const runId = "run-review-ceiling-release";

    const first = await runDaemon(repo, { adapters: [fake], runId });
    expect(first.human).toEqual(["T1"]);
    expect(taskEvents(repo, runId).filter((event) => event.event === "task-dispatch")).toHaveLength(2);

    await approve([runId, "T1", "--uphold", "--review-rounds", "1", "--by", "operator"], repo);
    const resumed = await runDaemon(repo, {
      adapters: [new FakeAdapter(scriptPath)], runId, resume: true,
    });

    expect(resumed.human).toEqual(["T1"]);
    const events = taskEvents(repo, runId);
    expect(events.filter((event) => event.event === "task-dispatch")).toHaveLength(3);
    expect(String(events.at(-1)?.data.reason)).toMatch(/review round cap \(1\)/);
  }, 120_000);

  test("test: the stated ceiling still governs after the approval that carried it, proving the approval does not reset the budget it was issued with", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true, complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })],
      {
        review: { approve: false, issues: ["one round only"] },
        consult: { action: "retry", notes: "must not run" },
        tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
      },
    );
    const runId = "run-review-ceiling-carried";

    await runDaemon(repo, { adapters: [fake], runId });
    await approve([runId, "T1", "--review-rounds", "1", "--by", "operator"], repo);
    const resumed = await runDaemon(repo, { adapters: [fake], runId, resume: true });

    expect(resumed.human).toEqual(["T1"]);
    const events = taskEvents(repo, runId);
    const approvalIndex = events.findIndex((event) => event.event === "task-approved");
    expect(events[approvalIndex]?.data.reviewRoundCeiling).toBe(1);
    expect(events.slice(approvalIndex + 1).filter((event) => event.event === "task-dispatch")).toHaveLength(1);
    expect(events.slice(approvalIndex + 1).filter((event) =>
      event.event === "gate-result" && event.data.gate === "review" && event.data.pass === false,
    )).toHaveLength(1);
    expect(String(events.at(-1)?.data.reason)).toMatch(/review round cap \(1\)/);
  }, 120_000);

  test("test: a release carrying no ceiling behaves exactly as before, so the default path is unchanged", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true, complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })],
      {
        review: { approve: false, issues: ["default cap"] },
        consult: { action: "retry", notes: "must not run" },
        tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
      },
    );
    const runId = "run-review-ceiling-default";

    await runDaemon(repo, { adapters: [fake], runId });
    await approve([runId, "T1", "--by", "operator"], repo);
    const resumed = await runDaemon(repo, { adapters: [fake], runId, resume: true });

    expect(resumed.human).toEqual(["T1"]);
    const events = taskEvents(repo, runId);
    const approval = events.find((event) => event.event === "task-approved");
    expect(approval?.data.reviewRoundCeiling).toBeUndefined();
    expect(events.filter((event) => event.event === "task-dispatch")).toHaveLength(2);
    expect(String(events.at(-1)?.data.reason)).toMatch(/review round cap \(2\)/);
  }, 120_000);
});
