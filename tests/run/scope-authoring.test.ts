import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type Assignment, channelKey } from "../../src/adapters/types.js";
import { collateralHits } from "../../src/compile/collateral.js";
import { loadConfig } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead, shGitOk } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { ensureIntegration, integrationBranch } from "../../src/run/merge.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// OBS-547: the run computes ONE full collateral map. The spy proves it is computed once and that the
// gate classifies on THAT object — a second scan at the red, or the plan's 20-item view, shows up here.
vi.mock("../../src/compile/collateral.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/compile/collateral.js")>();
  return { ...actual, collateralHits: vi.fn(actual.collateralHits) };
});

// 25 collateral hits for T1: `tests/t20.test.ts` is the 21st, computed and never displayed — the
// v1.96 T2 shape, where the victim sorted past the cap and no operator could have read it.
const HITS = 25;
const HIDDEN = "tests/t20.test.ts";

/** A repo whose tests/ predicts 25 collateral victims for T1, and a worker that edits `edits`. */
const seed = (edits: string) => {
  const fixture = setupRepo(
    [T("T1", { files: ["src/a.ts"], gates: ["build", "test", "lint", "evidence", "scope"] })],
    {
      tasks: { T1: [{ shell: `echo work >> src/a.ts && ${edits} && ${COMMIT} oops`, result: { ok: true, summary: "worked" } }] },
      consult: { action: "human", notes: "operator decides" },
    },
  );
  mkdirSync(join(fixture.repo, "tests"), { recursive: true });
  mkdirSync(join(fixture.repo, "src"), { recursive: true });
  writeFileSync(join(fixture.repo, "src/a.ts"), "export const a = 1;\n");
  for (let i = 0; i < HITS; i++) {
    writeFileSync(join(fixture.repo, `tests/t${String(i).padStart(2, "0")}.test.ts`), 'import "../src/a.js";\n');
  }
  execSync("git add src tests && git commit --no-gpg-sign -m collateral", { cwd: fixture.repo });
  return fixture;
};

const events = (repo: string, runId: string) => Journal.open(repo, runId).read();

// The accounting and replay criteria inspect the same two completed runs. Keep one lazy pair for
// both leaves: repeating these daemon runs bought no additional observation and needlessly added
// subprocess pressure while the suite's sync-heavy appearance oracle was sweeping the whole domain.
let accountingRuns: Promise<{
  predicted: ReturnType<typeof seed>;
  missed: ReturnType<typeof seed>;
}> | undefined;
const completedAccountingRuns = () => (accountingRuns ??= (async () => {
  const predicted = seed(`echo hidden >> ${HIDDEN}`);
  await runDaemon(predicted.repo, { adapters: [predicted.fake], runId: "run-authoring" });
  const missed = seed("echo oos >> README.md");
  await runDaemon(missed.repo, { adapters: [missed.fake], runId: "run-miss" });
  return { predicted, missed };
})());

const ASSIGNMENT: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const OTHER: Assignment = { adapter: "fake", model: "fake-2", channel: "sub", tier: "frontier" };
const SHELL_GATES = ["build", "test", "lint"] as const;

/**
 * A run interrupted mid-gates: the task worktree already carries the out-of-scope edit and the journal
 * holds a red `build` an operator then released, so the resume re-runs the rest through the GATE-REPLAY
 * path (daemon.ts resumeGateReplay) and never re-dispatches a worker. This is the path a crash between
 * a journaled scope red and its classification lands on.
 */
const seedInterrupted = async (runId: string, offender: string, crashedAfterClassifying = false) => {
  const { repo, fake } = setupRepo(
    [T("T1", { files: ["src/a.ts"], gates: ["build", "test", "lint", "evidence", "scope"] })],
    { tasks: { T1: [{ shell: "exit 99", result: { ok: false, summary: "worker must not be re-dispatched" } }] } },
    stringify({ gates: Object.fromEntries(SHELL_GATES.map((g) => [g, "true"])) }),
  );
  mkdirSync(join(repo, "tests"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
  for (let i = 0; i < HITS; i++) {
    writeFileSync(join(repo, `tests/t${String(i).padStart(2, "0")}.test.ts`), 'import "../src/a.js";\n');
  }
  execSync("git add src tests && git commit --no-gpg-sign -m collateral", { cwd: repo });

  const baseRef = await gitHead(repo);
  const branch = integrationBranch(loadConfig(repo), runId);
  await ensureIntegration(repo, branch, baseRef);
  const wt = await new SubprocessDriver().worktree(repo, `${branch}--T1`, baseRef);
  writeFileSync(join(wt, "src/a.ts"), "export const a = 2;\n");
  mkdirSync(join(wt, "tests"), { recursive: true });
  writeFileSync(join(wt, offender), "// landed out of scope\n");
  await shGitOk("git add -A && git commit --no-gpg-sign -m work", wt);
  const commit = await gitHead(wt);

  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, {
    pid: 111_111, baseRef, branch, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
  });
  // an ORDINARY chargeable attempt before the predicted one: the accounting the replay must not eat
  if (crashedAfterClassifying) journal.append("task-dispatch", "T1", { assignment: OTHER, attempt: 0, retryMode: "fresh" });
  journal.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: crashedAfterClassifying ? 1 : 0, retryMode: "fresh" });
  journal.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [], finished: true, exitCode: 0 });
  journal.phaseStart("T1", "gates");
  journal.append("gate-result", "T1", { gate: "build", pass: false, details: "exit 1", commit, attempt: 0 });
  journal.append("task-approved", "T1", { by: "operator", release: "gate-satisfied", gate: "build" });
  // the crash point: the classification is already journaled, its park never ran
  if (crashedAfterClassifying) {
    journal.append("scope-authoring", "T1", {
      gate: "scope", predicted: [offender], repair: `add ${offender} to T1.files[]`, attempt: 2, chargeable: false,
    });
  }
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({
    commands: Object.fromEntries(SHELL_GATES.map((g) => [g, { exitCode: 0, fingerprints: [] }])),
  }));
  await runDaemon(repo, { adapters: [fake], runId, resume: true });
  return Journal.open(repo, runId);
};


describe("OBS-547 — a scope red asks what the collateral map already predicted", () => {
  beforeEach(() => { vi.mocked(collateralHits).mockClear(); });

  test("test: one full per-task collateral map is computed once at run start and the scope gate reads that same map; recomputing a second map at the red or passing only the displayed subset fails", async () => {
    const { repo, fake } = seed(`echo hidden >> ${HIDDEN}`);
    await runDaemon(repo, { adapters: [fake], runId: "run-one-map" });

    // once for the whole run — a scan at the red would be a second call
    expect(vi.mocked(collateralHits)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(collateralHits).mock.calls[0]?.[1]).toBe(repo);
    const computed = vi.mocked(collateralHits).mock.results[0]?.value as Map<string, string[]>;
    expect(computed.get("T1")).toHaveLength(HITS);

    // and the gate classified on THAT map: the offender it named is the hit the display never shows
    const authoring = events(repo, "run-one-map").find((e) => e.event === "scope-authoring" && e.taskId === "T1");
    expect(authoring?.data.predicted).toEqual([HIDDEN]);
    expect(computed.get("T1")?.indexOf(HIDDEN)).toBeGreaterThanOrEqual(20); // past the 20-item display cap

    // ONE map for the RUN, not for the process: the prediction is pre-dispatch state, so reopening the
    // same run restores it instead of rescanning a repository the run has since edited. Delete every
    // collateral test and resume — a rescan would return an empty map and flip HIDDEN to unpredicted.
    rmSync(join(repo, "tests"), { recursive: true, force: true });
    execSync("git add -A && git commit --no-gpg-sign -m 'delete the collateral tests'", { cwd: repo });
    await runDaemon(repo, { adapters: [fake], runId: "run-one-map", resume: true });
    expect(vi.mocked(collateralHits)).toHaveBeenCalledTimes(1); // still one scan for the whole run
    const pinned = JSON.parse(readFileSync(join(Journal.open(repo, "run-one-map").dir, "collateral.json"), "utf8"));
    expect(pinned.T1).toContain(HIDDEN);
  }, 240_000);

  test("test: a scope red whose every hard offender was predicted journals an authoring classification carrying the verbatim files repair and parks unchargeable; a red holding one unpredicted hard offender keeps the ordinary quality accounting and journals the miss", async () => {
    const { predicted, missed } = await completedAccountingRuns();
    const authoringEvents = events(predicted.repo, "run-authoring").filter((e) => e.taskId === "T1");

    const classified = authoringEvents.find((e) => e.event === "scope-authoring");
    expect(classified?.data.repair).toBe(`add ${HIDDEN} to T1.files[]`);
    expect(classified?.data.chargeable).toBe(false);
    expect(authoringEvents.find((e) => e.event === "task-human")?.data.kind).toBe("authoring");
    // unchargeable: the dispatch bought no attempt, no gate-failure count, no escalation, no ladder rung
    expect(authoringEvents.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
    expect(authoringEvents.filter((e) => e.event === "escalation")).toEqual([]);
    expect(authoringEvents.filter((e) => e.event === "repair-attempt")).toEqual([]);
    const parked = Journal.open(predicted.repo, "run-authoring").readTelemetry().find((r) => r.taskId === "T1");
    expect(parked?.parkKind).toBe("authoring");
    expect(parked?.attempts).toBe(0);
    expect(parked?.gateFails).toBe(0);

    const missEvents = events(missed.repo, "run-miss").filter((e) => e.taskId === "T1");

    expect(missEvents.find((e) => e.event === "collateral-miss")?.data.unpredicted).toEqual(["README.md"]);
    expect(missEvents.filter((e) => e.event === "scope-authoring")).toEqual([]);
    // ordinary quality accounting: the red is charged, escalates, and parks on a quality kind
    const charged = Journal.open(missed.repo, "run-miss").readTelemetry().find((r) => r.taskId === "T1");
    expect(charged?.parkKind).not.toBe("authoring");
    expect(charged?.gateFails ?? 0).toBeGreaterThan(0);
    expect(charged?.attempts ?? 0).toBeGreaterThan(0);
  }, 240_000);

  test("test: a replayed resume neither counts the unchargeable authoring dispatch as an attempt nor retains its channel; an ordinary scope red replays as the chargeable attempt it was", async () => {
    const { predicted, missed } = await completedAccountingRuns();
    const authoring = Journal.open(predicted.repo, "run-authoring").replayResumeState().get("T1");

    expect(authoring?.attempts).toBe(0); // the dispatch it closed is not an attempt anyone owes for
    expect(authoring?.tried).toEqual([]); // and its channel is not burned — the channel did nothing wrong
    expect(authoring?.lastAssignment).toBeUndefined();

    const ordinary = Journal.open(missed.repo, "run-miss").replayResumeState().get("T1");

    expect(ordinary?.attempts ?? 0).toBeGreaterThan(0);
    expect(ordinary?.tried).toContain("fake:fake-1");

    // and the disposition is the RUN's, not the worker path's: a crash between a journaled scope red
    // and its classification leaves the resume's gate-replay path to observe the red. It must reach the
    // same verdict — predicted parks unchargeable, unpredicted charges and records the miss.
    const replayPredicted = await seedInterrupted("run-replay-gate-authoring", HIDDEN);
    const replayPredictedEvents = replayPredicted.read().filter((e) => e.taskId === "T1");
    const replayClassified = replayPredictedEvents.find((e) => e.event === "scope-authoring");
    expect(replayClassified?.data.repair).toBe(`add ${HIDDEN} to T1.files[]`);
    expect(replayPredictedEvents.filter((e) => e.event === "task-human").at(-1)?.data.kind).toBe("authoring");
    // the ACCOUNTING, not just the classification: this is the same first dispatch the fresh path
    // parks at ordinal 1 with zero chargeable attempts. If which path observed the red changed either
    // number, the dispatch would be counted here and forgiven there.
    expect(replayClassified?.data.attempt).toBe(1);
    const replayParked = replayPredicted.readTelemetry().find((r) => r.taskId === "T1");
    expect(replayParked?.attempts).toBe(0);
    expect(replayParked?.gateFails).toBe(0);
    expect(replayParked?.parkKind).toBe("authoring");

    // and the replay is idempotent: a crash between the classification append and the park that
    // follows it makes the next resume classify again. The duplicate has no dispatch left to take
    // back, so it must subtract nothing — the earlier CHARGEABLE attempt is not its to erase.
    const dup = Journal.create(predicted.repo, "run-replay-dup");
    dup.append("task-dispatch", "T1", { assignment: OTHER, attempt: 0, retryMode: "fresh" });
    dup.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 1, retryMode: "fresh" });
    const classification = { gate: "scope", predicted: [HIDDEN], repair: `add ${HIDDEN} to T1.files[]`, attempt: 2, chargeable: false };
    dup.append("scope-authoring", "T1", classification);
    dup.append("scope-authoring", "T1", classification); // the re-classification after the crash
    const deduped = dup.replayResumeState().get("T1");
    expect(deduped?.attempts).toBe(1); // only the unchargeable dispatch is undone, once
    expect(deduped?.tried).toEqual([channelKey(OTHER)]);
    expect(deduped?.lastAssignment).toEqual(OTHER);

    // Dispatch B consumed A's pending reroute. Forgiving B must restore that reroute along with the
    // prior assignment, or a later approval can dispatch A even though the consult explicitly banned it.
    const rerouted = Journal.create(predicted.repo, "run-replay-reroute");
    rerouted.append("task-dispatch", "T1", { assignment: OTHER, attempt: 0, retryMode: "fresh" });
    rerouted.append("consult-verdict", "T1", { action: "reroute" });
    rerouted.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 1, retryMode: "fresh" });
    rerouted.append("scope-authoring", "T1", classification);
    const rewoundReroute = rerouted.replayResumeState().get("T1");
    expect(rewoundReroute?.attempts).toBe(1);
    expect(rewoundReroute?.tried).toEqual([channelKey(OTHER)]);
    expect(rewoundReroute?.lastAssignment).toBeUndefined();

    // end to end through the daemon, with an EARLIER chargeable attempt behind the predicted one: the
    // replay has already taken the unchargeable dispatch back, so the gate path must not take it back
    // a second time. Double-subtraction would park at attempts 0 / ordinal 1 — erasing the ordinary
    // attempt on OTHER — and bill the park to OTHER, the assignment the rewind restored.
    const crashed = await seedInterrupted("run-replay-gate-crash", HIDDEN, true);
    const crashedEvents = crashed.read().filter((e) => e.taskId === "T1");
    expect(crashedEvents.filter((e) => e.event === "scope-authoring").at(-1)?.data.attempt).toBe(2);
    const crashedParked = crashed.readTelemetry().find((r) => r.taskId === "T1");
    expect(crashedParked?.attempts).toBe(1); // the earlier chargeable attempt survives
    expect(crashedParked?.model).toBe(ASSIGNMENT.model); // and the park belongs to the dispatch it closed
    expect(crashedParked?.parkKind).toBe("authoring");

    const replayMissed = await seedInterrupted("run-replay-gate-miss", "README.md");
    const replayMissedEvents = replayMissed.read().filter((e) => e.taskId === "T1");
    expect(replayMissedEvents.find((e) => e.event === "collateral-miss")?.data.unpredicted).toEqual(["README.md"]);
    expect(replayMissedEvents.filter((e) => e.event === "scope-authoring")).toEqual([]);
    expect(replayMissedEvents.filter((e) => e.event === "task-human").at(-1)?.data.kind).not.toBe("authoring");
  }, 240_000);
});
