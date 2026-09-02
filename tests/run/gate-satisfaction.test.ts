import { stringify } from "yaml";
import { describe, expect, test } from "vitest";
import { compareToBaseline } from "../../src/gates/baseline.js";
import { gateSatisfied, runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

// T9: the merge predicate. `gateSatisfied` decides whether a task's gate battery authorizes a merge
// to the integration branch, and it is the ONLY place that can tell an honest report of an
// infrastructure abort apart from a verified green — because a gate that classifies its failure into
// infra metadata and still reports `pass: true` authorizes the merge anyway.

const oneTask = (id: string) => ({
  tasks: { [id]: [{ shell: `echo ${id} > ${id.toLowerCase()}.txt && ${COMMIT} ${id.toLowerCase()}`, result: { ok: true, summary: "done" } }] },
});

/** A repo whose `test` gate is the given shell command, driven by the scripted fake adapter. */
const repoWithTestGate = (cmd: string) => setupRepo([T("T1")], oneTask("T1"), stringify({ gates: { test: cmd } }));

// The two runners under test. Neither is a mock: each is the shell the gate actually executes.
const INFRA_RUNNER = "printf '%s\\n' 'Error: spawn EAGAIN' >&2; exit 1"; // died on the machine, no suite completed
const COMPLETED_RUNNER = "printf '%s\\n' ' Tests  0 failed | 3 passed (3)'; exit 0"; // ran, zero failures

test("test: replaySatisfiedGates keeps a gate-satisfied entry only while it is the task's newest approval so a later uphold or recheck approval clears it while the shipped fold that lets a stale waiver persist across a later uphold fails", () => {
  const repo = makeTestTempDir("tickmarkr-waiver-approval-");
  const journal = Journal.create(repo, "run-waiver-newest-approval");

  journal.append("task-approved", "T1", { by: "operator", release: "gate-satisfied", gate: "build" });
  journal.append("task-approved", "T2", { by: "operator", release: "gate-satisfied", gate: "lint" });
  expect(journal.replaySatisfiedGates()).toEqual(new Map([["T1", "build"], ["T2", "lint"]]));

  journal.append("task-approved", "T1", { by: "operator", release: "review-upheld" });
  expect(journal.replaySatisfiedGates()).toEqual(new Map([["T2", "lint"]]));

  journal.append("task-approved", "T2", { by: "operator", release: "recheck" });
  expect(journal.replaySatisfiedGates()).toEqual(new Map());
});

describe("merge satisfaction of an infra-only gate result (fake adapter, zero tokens)", () => {
  test("test: a test gate whose runner exited nonzero on infrastructure alone with no completed suite does not read as merge-satisfied, exercised against that run and against a genuinely completed zero-failure run, because classifying the failure into infra metadata while still reporting a pass authorizes the merge anyway", async () => {
    // The gate results below are produced by the real gate over the real runners — not written here.
    const bench = makeRepo({ "base.txt": "base\n" });
    const redBaseline = { commands: { test: { exitCode: 1, fingerprints: [] } } };
    const [infraResult] = await compareToBaseline(bench, { test: INFRA_RUNNER }, redBaseline, ["test"]);
    const [completedResult] = await compareToBaseline(bench, { test: COMPLETED_RUNNER }, redBaseline, ["test"]);

    // The runner that never completed a suite verified nothing — it cannot authorize a merge.
    expect(infraResult.meta?.infra).toBe(true);
    expect(gateSatisfied(infraResult)).toBe(false);
    // The runner that completed with zero failures did verify the work — it must still authorize one,
    // so the predicate is not simply refusing everything that mentions a machine error.
    expect(completedResult.pass).toBe(true);
    expect(gateSatisfied(completedResult)).toBe(true);

    // The shape the criterion names: the failure IS classified into infra metadata, and the gate
    // nevertheless reports a pass. Honest metadata beside `pass: true` must not merge.
    expect(gateSatisfied({ gate: "test", pass: true, details: "exit 1 — spawn EAGAIN", meta: { classification: "infra", infra: true } })).toBe(false);
    // A gate that genuinely declined to run stays satisfied (the pre-existing skip contract).
    expect(gateSatisfied({ gate: "review", pass: true, details: "below threshold", meta: { skipped: true } })).toBe(true);

    // End to end, through the daemon: the infra run merges nothing, the completed run merges its task.
    const infraRepo = repoWithTestGate(INFRA_RUNNER);
    const infraSummary = await runDaemon(infraRepo.repo, { adapters: [infraRepo.fake], runId: "run-gate-satisfaction-infra" });
    expect(infraSummary.done).not.toContain("T1");
    const infraEvents = Journal.open(infraRepo.repo, "run-gate-satisfaction-infra").read();
    expect(infraEvents.filter((e) => e.event === "merge")).toHaveLength(0);
    // and the ledger says WHY it refused, rather than showing an ordinary red test row
    const infraRows = infraEvents.filter((e) => e.event === "gate-result" && e.data.gate === "test");
    expect(infraRows.length).toBeGreaterThan(0);
    expect(infraRows.every((e) => e.data.infra === true && e.data.pass === false)).toBe(true);

    const greenRepo = repoWithTestGate(COMPLETED_RUNNER);
    const greenSummary = await runDaemon(greenRepo.repo, { adapters: [greenRepo.fake], runId: "run-gate-satisfaction-green" });
    expect(greenSummary.done).toContain("T1");
    const greenEvents = Journal.open(greenRepo.repo, "run-gate-satisfaction-green").read();
    expect(greenEvents.filter((e) => e.event === "merge" && e.taskId === "T1").length).toBeGreaterThan(0);
    expect(greenEvents.some((e) => e.event === "gate-result" && e.data.gate === "test" && e.data.infra === true)).toBe(false);
  }, 240000);
});
