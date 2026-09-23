// OBS-203: `approve --recheck` — the third decision a gate-fail park offers. Plain approve WAIVES the
// failed gate and every gate before it; --recheck waives nothing and re-dispatches against the full
// gate suite, for the case where the gate failed against a stale task DECLARATION (spec files[]) rather
// than a bad diff. Fail-closed like every approve path: refusals are loud and append nothing.
import { describe, expect, test } from "vitest";
import { approve, newestPark, permittedDecisionVerbs, readJournalEvents } from "../../src/cli/commands/approve.js";
import { Journal } from "../../src/run/journal.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

const assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };

// the park this release exists for: scope failed because files[] was too narrow, now amended
function scopeParkedRun(repo: string, runId: string, dispatches = 1): Journal {
  const j = Journal.create(repo, runId);
  for (let i = 0; i < dispatches; i++) j.append("task-dispatch", "T1", { assignment, attempt: i });
  j.append("gate-result", "T1", { gate: "scope", pass: false, details: "out-of-scope edits" });
  j.append("task-human", "T1", { kind: "gate-fail", reason: "consult verdict: human" });
  return j;
}

describe("tickmarkr approve --recheck (OBS-203, zero-token)", () => {
  test("recheck re-pends the task while marking NO gate satisfied, so scope re-runs", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = scopeParkedRun(repo, "run-recheck");

    const msg = await approve(["run-recheck", "T1", "--recheck", "--review-rounds", "1", "--by", "overseer"], repo);
    expect(msg).toMatch(/no gate marked satisfied/);

    const approvals = j.read().filter((e) => e.event === "task-approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      taskId: "T1",
      data: { by: "overseer", via: "cli", release: "recheck", reviewRoundCeiling: 1 },
    });
    // the whole point: plain approve would put scope here, skipping build/test/lint/evidence/scope
    expect(j.replaySatisfiedGates()).toEqual(new Map());
    expect(j.replayStatuses().get("T1")).toBe("pending");
  });

  test("recheck preserves the attempt budget and the tried list — it funds no attempt (OBS-1028)", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = scopeParkedRun(repo, "run-recheck-budget", 6);
    expect(j.replayResumeState().get("T1")?.attempts).toBe(6);

    await approve(["run-recheck-budget", "T1", "--recheck"], repo);

    const rs = j.replayResumeState().get("T1");
    expect(rs?.attempts).toBe(6); // the ladder is NOT reset by a verb that marks no gate satisfied
    expect(rs?.tried).toEqual(["fake:fake-1"]); // burned channels are NOT forgotten
  });

  test("recheck refuses a park that has no failed gate to re-run, appending nothing", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-recheck-refuse");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("task-human", "T1", { kind: "reroute-exhausted", reason: "every channel demoted" });

    await expect(approve(["run-recheck-refuse", "T1", "--recheck"], repo))
      .rejects.toThrow(/--recheck applies to a gate-fail, infra, diff-cap or red-tool-gate authoring park/);
    expect(j.read().filter((e) => e.event === "task-approved")).toHaveLength(0);
  });

  test("recheck accepts an infra park without inventing a failed gate", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-recheck-infra");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("gate-result", "T1", { gate: "test", pass: false, infra: true, details: "signal exit" });
    j.append("task-human", "T1", { kind: "infra", reason: "signal exit" });

    const message = await approve(["run-recheck-infra", "T1", "--recheck"], repo);
    expect(message).toContain("infra park");
    expect(j.read().find((e) => e.event === "task-approved")?.data.release).toBe("recheck");
  });

  test("uphold and recheck are different decisions and cannot be passed together", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = scopeParkedRun(repo, "run-recheck-both");

    await expect(approve(["run-recheck-both", "T1", "--uphold", "--recheck"], repo))
      .rejects.toThrow(/different decisions/);
    expect(j.read().filter((e) => e.event === "task-approved")).toHaveLength(0);
  });

  test("test: uphold and recheck remain mutually exclusive and each still refuses a park whose last failed gate does not match it", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const scopePark = scopeParkedRun(repo, "run-recheck-contract");

    await expect(approve(["run-recheck-contract", "T1", "--uphold", "--recheck"], repo))
      .rejects.toThrow(/different decisions/);
    await expect(approve(["run-recheck-contract", "T1", "--uphold"], repo))
      .rejects.toThrow(/failed gate scope/);
    expect(scopePark.read().filter((e) => e.event === "task-approved")).toHaveLength(0);

    const unmatched = Journal.create(repo, "run-recheck-unmatched");
    unmatched.append("task-dispatch", "T1", { assignment, attempt: 0 });
    unmatched.append("task-human", "T1", { kind: "reroute-exhausted", reason: "no failed gate" });
    await expect(approve(["run-recheck-unmatched", "T1", "--recheck"], repo))
      .rejects.toThrow(/newest park is reroute-exhausted/);
    expect(unmatched.read().filter((e) => e.event === "task-approved")).toHaveLength(0);
  });
});

// OBS-1084: an authoring park whose red is a runner report (a load flake in an unowned suite) admits
// --recheck; the daemon re-runs the battery on the preserved ref with no worker. A park with no red
// gate row (a worker refusal) stays plain-approve only.
describe("tickmarkr approve --recheck on an authoring park (OBS-1084, zero-token)", () => {
  test("test: recheck on an authoring park whose newest gate result is a red test gate journals a recheck release naming that gate so the verb table offers recheck for it, so a refusal listing only gate fail infra or diff cap fails", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-recheck-authoring");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("gate-result", "T1", { gate: "test", pass: false, details: "unowned suite failed to load" });
    j.append("task-human", "T1", { kind: "authoring", reason: "runner report", source: "test" });

    const { events, sourceIndexes } = readJournalEvents(j);
    expect(permittedDecisionVerbs(newestPark(events, "T1", sourceIndexes))).toEqual(["approve", "recheck"]);

    const msg = await approve(["run-recheck-authoring", "T1", "--recheck", "--by", "overseer"], repo);
    expect(msg).toContain("failed gate test");
    const approvals = j.read().filter((e) => e.event === "task-approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ taskId: "T1", data: { by: "overseer", via: "cli", release: "recheck", failedGate: "test", gate: "test" } });
    expect(j.replaySatisfiedGates()).toEqual(new Map());
    expect(j.replayStatuses().get("T1")).toBe("pending");
  });

  test("test: recheck on an authoring park raised by a worker refusal with no red gate result stays refused and the verb table offers approve alone, so a recheck that re-runs a battery nothing failed fails", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-recheck-authoring-refusal");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("task-human", "T1", { kind: "authoring", reason: "worker refused: task needs out-of-scope edits", source: "worker" });

    const { events, sourceIndexes } = readJournalEvents(j);
    expect(permittedDecisionVerbs(newestPark(events, "T1", sourceIndexes))).toEqual(["approve"]);

    await expect(approve(["run-recheck-authoring-refusal", "T1", "--recheck"], repo))
      .rejects.toThrow(/--recheck applies to .*newest park is authoring with failed gate none/);
    expect(j.read().filter((e) => e.event === "task-approved")).toHaveLength(0);
  });
});
