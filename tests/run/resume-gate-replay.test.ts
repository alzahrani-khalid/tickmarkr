import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { afterEach, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type Assignment } from "../../src/adapters/types.js";
import { loadConfig } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir } from "../../src/graph/graph.js";
import type { GateName } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead, shGitOk } from "../../src/run/git.js";
import { Journal, reviewRoundsSinceApproval, type JournalEvent } from "../../src/run/journal.js";
import { ensureIntegration, integrationBranch } from "../../src/run/merge.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const ASSIGNMENT: Assignment = {
  adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier",
};
const SHELL_GATES = ["build", "test", "lint"] as const;

interface SeedGate {
  gate: GateName;
  pass: boolean;
  details?: string;
}

interface SeededResume {
  repo: string;
  fake: FakeAdapter;
  journal: Journal;
  marker: string;
  commit: string;
  taskWorktree: string;
  runId: string;
}

const activeChildren = new Set<ChildProcess>();
afterEach(() => {
  for (const child of activeChildren) child.kill("SIGKILL");
  activeChildren.clear();
});

const markerLines = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];

const afterLastResume = (events: JournalEvent[]): JournalEvent[] => {
  let at = -1;
  events.forEach((event, index) => { if (event.event === "run-resume") at = index; });
  return events.slice(at + 1);
};

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

async function seedResume(
  runId: string,
  attempts: SeedGate[][],
  approval?: Record<string, unknown>,
  failingShell?: (typeof SHELL_GATES)[number],
  scriptOverride: Record<string, unknown> = {},
): Promise<SeededResume> {
  const marker = join(makeTestTempDir("tickmarkr-resume-gates-"), "shells.log");
  const commands = Object.fromEntries(SHELL_GATES.map((gate) => [
    gate,
    `if [[ "$PWD" == *--T1 ]]; then printf '%s\\n' ${shq(gate)} >> ${shq(marker)};`
      + `${gate === failingShell ? " exit 1;" : ""} fi`,
  ]));
  const { repo, fake } = setupRepo(
    [T("T1", { files: ["work.txt", "changed.txt"] })],
    {
      tasks: { T1: [{
        shell: "exit 99",
        result: { ok: false, summary: failingShell ? "resume failure reached retry dispatch" : "worker must not be re-dispatched" },
      }] },
      judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
      review: { approve: true, issues: [] },
      ...scriptOverride,
    },
    stringify({ gates: commands }),
  );
  const baseRef = await gitHead(repo);
  const cfg = loadConfig(repo);
  const branch = integrationBranch(cfg, runId);
  await ensureIntegration(repo, branch, baseRef);
  const taskWorktree = await new SubprocessDriver().worktree(repo, `${branch}--T1`, baseRef);
  writeFileSync(join(taskWorktree, "work.txt"), "landed work\n");
  await shGitOk("git add work.txt && git commit --no-gpg-sign -m work", taskWorktree);
  const commit = await gitHead(taskWorktree);

  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, {
    pid: 111_111, baseRef, commands, branch, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
  });
  attempts.forEach((gates, attempt) => {
    journal.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt, retryMode: "fresh" });
    journal.append("worker-result", "T1", {
      ok: true, summary: "landed", deviations: [], finished: true, exitCode: 0,
    });
    journal.phaseStart("T1", "gates");
    for (const result of gates) {
      journal.append("gate-result", "T1", {
        gate: result.gate, pass: result.pass,
        details: result.details ?? (result.pass ? "exit 0" : "exit 1"),
        commit, attempt, ...(result.gate === "test" && result.pass ? { fullSuite: true } : {}),
      });
    }
  });
  if (approval) journal.append("task-approved", "T1", approval);
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({
    commands: Object.fromEntries(SHELL_GATES.map((gate) => [gate, { exitCode: 0, fingerprints: [] }])),
  }));
  return { repo, fake, journal, marker, commit, taskWorktree, runId };
}

async function resume(seed: SeededResume): Promise<JournalEvent[]> {
  await runDaemon(seed.repo, { adapters: [seed.fake], runId: seed.runId, resume: true });
  return afterLastResume(Journal.open(seed.repo, seed.runId).read());
}

test("resuming five green current-attempt/current-commit results emits five gate-reused records and advances to the next phase with zero gate-shell invocations; changing one result to failed emits a shell invocation beginning at that gate, so an inert resume or blanket skip fails", async () => {
    const green = await seedResume("run-five-green", [[
      { gate: "build", pass: true }, { gate: "test", pass: true }, { gate: "lint", pass: true },
      { gate: "evidence", pass: true }, { gate: "scope", pass: true },
    ]]);
    const greenEvents = await resume(green);
    expect(greenEvents.filter((event) => event.event === "gate-reused").map((event) => event.data.gate))
      .toEqual(["build", "test", "lint", "evidence", "scope"]);
    expect(markerLines(green.marker)).toEqual([]);
    expect(greenEvents.some((event) => event.event === "phase-start" && event.data.gate === "acceptance")).toBe(true);

    const failed = await seedResume("run-green-until-lint", [[
      { gate: "build", pass: true }, { gate: "test", pass: true }, { gate: "lint", pass: false },
    ]], undefined, "lint");
    const failedEvents = await resume(failed);
    expect(failedEvents.filter((event) => event.event === "gate-reused").map((event) => event.data.gate))
      .toEqual(["build", "test"]);
    expect(markerLines(failed.marker)[0]).toBe("lint");
    expect(failedEvents.some((event) => event.event === "task-dispatch")).toBe(true);
    expect(failedEvents.find((event) =>
      event.event === "gate-result" && event.data.gate === "lint" && event.data.pass === false,
    )?.data.replayMeasurement).toBe(true);
  }, 120_000);

test("resume re-measurements do not spend deterministic fingerprint occurrences or review rounds", async () => {
    const exactLintFailure = "command was green at baseline but now exits 1 with no recognizable failure lines — failing closed";
    const lint = await seedResume(
      "run-resume-lint-accounting",
      [[{ gate: "lint", pass: false, details: exactLintFailure }]],
      undefined,
      "lint",
      {
        tasks: { T1: [{ shell: "true", result: { ok: true, summary: "unchanged tree" } }] },
        consult: { action: "human", notes: "stop after the fingerprint cap" },
      },
    );
    const lintEvents = await resume(lint);
    const lintFailures = lintEvents.filter((event) =>
      event.event === "gate-result" && event.data.gate === "lint" && event.data.pass === false,
    );
    expect(lintFailures.map((event) => event.data.replayMeasurement)).toEqual([true, undefined]);
    expect(lintEvents.filter((event) => event.event === "task-dispatch")).toHaveLength(1);
    expect(lintEvents.filter((event) => event.event === "gate-fingerprint-cap")).toHaveLength(1);
    expect(lintEvents.filter((event) =>
      event.event === "escalation" && event.data.fingerprintCap !== true,
    )).toHaveLength(0);

    const review = await seedResume(
      "run-resume-review-accounting",
      [[{ gate: "review", pass: false, details: "reviewer requested changes" }]],
      undefined,
      undefined,
      {
        tasks: { T1: [{ shell: "true", result: { ok: true, summary: "unchanged tree" } }] },
        review: { approve: false, issues: ["review still requests changes"] },
      },
    );
    const reviewEvents = await resume(review);
    const reviewFailures = reviewEvents.filter((event) =>
      event.event === "gate-result" && event.data.gate === "review" && event.data.pass === false,
    );
    expect(reviewFailures.map((event) => event.data.replayMeasurement)).toEqual([true, undefined]);
    expect(reviewEvents.filter((event) => event.event === "task-dispatch")).toHaveLength(1);
    expect(reviewRoundsSinceApproval(review.journal.read(), "T1")).toBe(2);
    expect(reviewEvents.find((event) => event.event === "task-human")?.data.reason)
      .toMatch(/review round cap/);
  }, 120_000);

test("a gate result recorded against a commit the task no longer carries is re-run rather than honoured, exercised with the same task id at a changed commit and at the unchanged one, so survival is scoped to the commit and not to the id", async () => {
    const unchanged = await seedResume("run-commit-unchanged", [[{ gate: "build", pass: true }]]);
    const unchangedEvents = await resume(unchanged);
    expect(unchangedEvents.filter((event) => event.event === "gate-reused").map((event) => event.data.gate))
      .toEqual(["build"]);
    expect(markerLines(unchanged.marker)[0]).toBe("lint");

    const changed = await seedResume("run-commit-changed", [[{ gate: "build", pass: true }]]);
    writeFileSync(join(changed.taskWorktree, "changed.txt"), "a different task tip\n");
    await shGitOk("git add changed.txt && git commit --no-gpg-sign -m changed", changed.taskWorktree);
    expect(await gitHead(changed.taskWorktree)).not.toBe(changed.commit);
    const changedEvents = await resume(changed);
    expect(changedEvents.filter((event) => event.event === "gate-reused")).toEqual([]);
    expect(markerLines(changed.marker)[0]).toBe("build");

    const rebased = await seedResume("run-integration-base-changed", [[{ gate: "build", pass: true }]]);
    const cfg = loadConfig(rebased.repo);
    const branch = integrationBranch(cfg, rebased.runId);
    const intWt = await ensureIntegration(rebased.repo, branch, await gitHead(rebased.repo));
    writeFileSync(join(intWt, "changed.txt"), "a newly merged dependency\n");
    await shGitOk("git add changed.txt && git commit --no-gpg-sign -m dependency", intWt);
    expect(await gitHead(rebased.taskWorktree)).toBe(rebased.commit);
    const rebasedEvents = await resume(rebased);
    expect(rebasedEvents.filter((event) => event.event === "gate-reused")).toEqual([]);
    expect(markerLines(rebased.marker)[0]).toBe("build");
  }, 120_000);

test("replaySatisfiedGates receives current-attempt failed-gate journals with no approval, an untyped approval and a typed gate-satisfied release; resume re-runs the gate in the first two and advances only in the third, so blanket survival or marker-blind approval fails", async () => {
    const none = await seedResume("run-failed-no-approval", [[{ gate: "build", pass: false }]]);
    expect(none.journal.replaySatisfiedGates().has("T1")).toBe(false);
    await resume(none);
    expect(markerLines(none.marker)[0]).toBe("build");

    const untyped = await seedResume(
      "run-failed-untyped-approval", [[{ gate: "build", pass: false }]], { by: "operator" },
    );
    expect(untyped.journal.replaySatisfiedGates().has("T1")).toBe(false);
    await resume(untyped);
    expect(markerLines(untyped.marker)[0]).toBe("build");

    const typed = await seedResume(
      "run-failed-typed-approval", [[{ gate: "build", pass: false }]],
      { by: "operator", release: "gate-satisfied", gate: "build" },
    );
    expect(typed.journal.replaySatisfiedGates().get("T1")).toBe("build");
    await resume(typed);
    expect(markerLines(typed.marker)[0]).toBe("lint");
  }, 120_000);

test("a daemon-controlled restart writes exit-cause \"deliberate\" before leaving, while the next resume after a process killed before run-end writes exit-cause \"unclean\" from durable lock/journal evidence; a reader distinguishes both without requiring the dead process to write", async () => {
    const deliberateRunId = "run-exit-deliberate";
    const deliberate = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "sleep 30" }] } },
      "taskTimeoutMinutes: 10\n",
    );
    const before = new Set(process.listeners("SIGTERM"));
    const controlled = runDaemon(deliberate.repo, {
      adapters: [deliberate.fake], runId: deliberateRunId, exit: () => {},
    });
    controlled.catch(() => { /* asserted below */ });
    await waitFor(
      () => existsSync(join(tickmarkrDir(deliberate.repo), "runs", deliberateRunId, "journal.jsonl"))
        && Journal.open(deliberate.repo, deliberateRunId).read().some((event) => event.event === "worker-launch"),
      "controlled daemon worker launch",
    );
    const handler = process.listeners("SIGTERM").find((listener) => !before.has(listener));
    expect(handler).toBeDefined();
    handler!("SIGTERM");
    await expect(controlled).rejects.toThrow(/terminated by SIGTERM/);
    const deliberateEvents = Journal.open(deliberate.repo, deliberateRunId).read();
    expect(deliberateEvents.filter((event) => event.event === "exit-cause").map((event) => event.data.cause))
      .toEqual(["deliberate"]);
    expect(deliberateEvents.some((event) => event.event === "run-end")).toBe(false);

    const abruptRunId = "run-exit-unclean";
    const stop = join(makeTestTempDir("tickmarkr-abrupt-stop-"), "stop");
    const abrupt = setupRepo(
      [T("T1", { files: ["recovered.txt"] })],
      { tasks: { T1: [{ shell: `while [ ! -f ${shq(stop)} ]; do sleep 0.05; done` }] } },
      "taskTimeoutMinutes: 10\n",
    );
    const root = join(import.meta.dirname, "..", "..");
    const daemonUrl = pathToFileURL(join(root, "src", "run", "daemon.ts")).href;
    const fakeUrl = pathToFileURL(join(root, "src", "adapters", "fake.ts")).href;
    const childCode = `
      import { runDaemon } from ${JSON.stringify(daemonUrl)};
      import { FakeAdapter } from ${JSON.stringify(fakeUrl)};
      await runDaemon(${JSON.stringify(abrupt.repo)}, {
        adapters: [new FakeAdapter(${JSON.stringify(abrupt.scriptPath)})],
        runId: ${JSON.stringify(abruptRunId)}
      });
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    const abruptJournalPath = join(tickmarkrDir(abrupt.repo), "runs", abruptRunId, "journal.jsonl");
    const abruptLockPath = join(tickmarkrDir(abrupt.repo), "graph.lock");
    await waitFor(() => {
      if (!existsSync(abruptJournalPath) || !existsSync(abruptLockPath)) return false;
      return readFileSync(abruptJournalPath, "utf8").includes('"event":"worker-launch"');
    }, "abrupt daemon durable journal and lock");
    child.kill("SIGKILL");
    await once(child, "exit");
    activeChildren.delete(child);
    writeFileSync(stop, "stop\n");
    expect(existsSync(abruptLockPath)).toBe(true);
    expect(Journal.open(abrupt.repo, abruptRunId).read().some((event) => event.event === "run-end")).toBe(false);

    writeFileSync(abrupt.scriptPath, JSON.stringify({
      tasks: { T1: [{ shell: `echo recovered > recovered.txt && ${COMMIT} recovered`, result: { ok: true, summary: "recovered" } }] },
      judge: { pass: true, criteria: [] }, review: { approve: true, issues: [] },
    }));
    await runDaemon(abrupt.repo, {
      adapters: [new FakeAdapter(abrupt.scriptPath)], runId: abruptRunId, resume: true,
    });
    const observed = Journal.open(abrupt.repo, abruptRunId).read();
    expect(observed.filter((event) => event.event === "exit-cause").map((event) => event.data.cause))
      .toEqual(["unclean"]);
    expect(observed.find((event) => event.event === "exit-cause")?.data.evidence)
      .toBe("reclaimed-lock-with-open-journal");
  }, 120_000);

test("a prior-attempt pass plus current-attempt failure resumes at the failed gate; replacing the current failure with a pass reuses it, and adding a typed task-approved release advances only the failed case, so attempt leakage or inferred failed-gate satisfaction changes the recorded next phase", async () => {
    const failed = await seedResume("run-attempt-current-failed", [
      [{ gate: "build", pass: true }], [{ gate: "build", pass: false }],
    ]);
    await resume(failed);
    expect(markerLines(failed.marker)[0]).toBe("build");

    const passed = await seedResume("run-attempt-current-passed", [
      [{ gate: "build", pass: true }], [{ gate: "build", pass: true }],
    ]);
    const passedEvents = await resume(passed);
    expect(passedEvents.filter((event) => event.event === "gate-reused").map((event) => event.data.gate))
      .toEqual(["build"]);
    expect(markerLines(passed.marker)[0]).toBe("lint");

    const released = await seedResume(
      "run-attempt-current-released",
      [[{ gate: "build", pass: true }], [{ gate: "build", pass: false }]],
      { by: "operator", release: "gate-satisfied", gate: "build" },
    );
    await resume(released);
    expect(markerLines(released.marker)[0]).toBe("lint");
  }, 120_000);
