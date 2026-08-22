import { describe, expect, test } from "vitest";
import { addEvidence, loadGraph, readyTasks, taskContentDigest } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import {
  foldPriorEvidence,
  formatPriorFindingEvidence,
  Journal,
  readPriorRunEvidence,
  REVIEW_UPHELD_RELEASE,
  structuredFindings,
  type JournalEvent,
  type PriorRunJournal,
} from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const at = "2026-08-20T00:00:00.000Z";

function blocking(taskId: string, digest: string | undefined, note: string): JournalEvent {
  const details = `- [material] ${note}`;
  return {
    ts: at,
    event: "gate-result",
    taskId,
    data: {
      gate: "review",
      pass: false,
      details,
      ...(digest ? { taskContentDigest: digest } : {}),
      findings: structuredFindings("review", details),
    },
  };
}

const event = (eventName: string, taskId: string, data: Record<string, unknown> = {}): JournalEvent => ({
  ts: at, event: eventName, taskId, data,
});

function run(runId: string, events: JournalEvent[]): PriorRunJournal {
  return { runId, events };
}

describe("prior-run finding evidence", () => {
  test("test: the prior-evidence fold clears a finding after task completion or ordinary approval but retains it after an uphold, so a fold treating those three events alike fails", () => {
    const digest = "d".repeat(64);
    const evidence = foldPriorEvidence([
      run("run-retirements", [
        blocking("T_DONE", digest, "done finding"),
        event("task-done", "T_DONE", { taskContentDigest: digest }),
        blocking("T_APPROVED", digest, "approved finding"),
        event("task-approved", "T_APPROVED", { release: "gate-satisfied" }),
        blocking("T_UPHELD", digest, "upheld finding"),
        event("task-approved", "T_UPHELD", { release: REVIEW_UPHELD_RELEASE }),
      ]),
    ]);

    expect(evidence.findings.map((finding) => finding.taskId)).toEqual(["T_UPHELD"]);
    expect(evidence.findings[0]?.finding.note).toBe("upheld finding");
  });

  test("test: a carried finding is labelled evidence rather than a verdict and cannot red a gate on its own; a carry that fails a fresh attempt before its work is judged fails", () => {
    const graph = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [T("T1", { goal: "stable", files: ["src/a.ts"], acceptance: ["observable"] })],
    });
    const digest = taskContentDigest(graph.tasks[0]!);
    const evidence = foldPriorEvidence([
      run("run-prior", [blocking("T1", digest, "src/a.ts:9 — preserve the checked branch")]),
      // A fresh dispatch dying before gates is not in the closed retirement set.
      run("run-fresh-failed", [event("task-failed", "T1", { kind: "dispatch", error: "launch failed" })]),
    ]);

    expect(formatPriorFindingEvidence(evidence.findings[0]!)).toContain("EVIDENCE (not a verdict)");
    expect(evidence.findings).toHaveLength(1);
    expect(graph.tasks[0]!.status).toBe("pending");
    expect(graph.tasks[0]!.evidence.gateResults).toEqual([]);
    expect(readyTasks(graph).map((task) => task.id)).toEqual(["T1"]);

    const fixture = setupRepo([T("T1", { goal: "stable", files: ["src/a.ts"], acceptance: ["observable"] })]);
    const task = loadGraph(fixture.repo).tasks[0]!;
    const taskDigest = taskContentDigest(task);
    const prior = Journal.create(fixture.repo, "run-resume-prior");
    prior.append("gate-result", "T1", blocking("T1", taskDigest, "older evidence survives resume").data);
    prior.append("gate-result", "T1", blocking("T1", taskDigest, "finding replayed by current journal").data);
    const self = Journal.create(fixture.repo, "run-resume-self");
    self.append("gate-result", "T1", blocking("T1", taskDigest, "finding replayed by current journal").data);

    const resumed = readPriorRunEvidence(fixture.repo, [task], { suppressRunId: "run-resume-self" });
    expect(resumed.findings.map((finding) => finding.finding.note)).toEqual(["older evidence survives resume"]);

    self.append("task-approved", "T1", { release: "gate-satisfied" });
    expect(readPriorRunEvidence(fixture.repo, [task], { suppressRunId: "run-resume-self" }).findings).toEqual([]);
  });

  test("test: the daemon stamps the content digest onto blocking acceptance and review gate evidence and onto task completion so a later run matches on it; evidence journaled without the digest fails", async () => {
    const rejected = setupRepo(
      [T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })],
      {
        review: { approve: false, issues: ["review still requests changes"] },
        consult: { action: "retry", notes: "review retries do not consult" },
        tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
      },
    );
    await runDaemon(rejected.repo, { adapters: [rejected.fake], runId: "run-digest-review" });
    const rejectedTask = loadGraph(rejected.repo).tasks[0]!;
    const rejectedDigest = taskContentDigest(rejectedTask);
    const blockingRows = Journal.open(rejected.repo, "run-digest-review").read().filter((row) =>
      row.event === "gate-result" && row.data.gate === "review" && row.data.pass === false,
    );
    expect(blockingRows.length).toBeGreaterThan(0);
    expect(blockingRows.every((row) => row.data.taskContentDigest === rejectedDigest)).toBe(true);

    const accepted = setupRepo(
      [T("T1", { acceptance: [{ oracle: "command", command: "true" }] })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    await runDaemon(accepted.repo, { adapters: [accepted.fake], runId: "run-digest-done" });
    const acceptedTask = loadGraph(accepted.repo).tasks[0]!;
    const acceptedDigest = taskContentDigest(acceptedTask);
    const done = Journal.open(accepted.repo, "run-digest-done").read().find((row) => row.event === "task-done");
    expect(done?.data.taskContentDigest).toBe(acceptedDigest);
    expect(acceptedTask.evidence.gateResults.length).toBeGreaterThan(0);
    expect(acceptedTask.evidence.gateResults.every((row) =>
      row !== null && typeof row === "object"
        && (row as { taskContentDigest?: string }).taskContentDigest === acceptedDigest,
    )).toBe(true);

    const unstamped = foldPriorEvidence([run("run-unstamped", [blocking("T1", undefined, "must not carry")])]);
    expect(unstamped.findings).toEqual([]);

    // `addEvidence` is the graph boundary even outside a daemon integration fixture.
    const direct = addEvidence(validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [T("T1")],
    }), "T1", { gateResults: [{ gate: "acceptance", pass: false }] });
    expect((direct.tasks[0]!.evidence.gateResults[0] as { taskContentDigest?: string }).taskContentDigest)
      .toBe(taskContentDigest(direct.tasks[0]!));
  }, 120_000);
});
