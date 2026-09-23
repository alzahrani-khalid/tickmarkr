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
import { graphDefinitionHash, loadGraph, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import type { GateName } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead, shGitOk, VERIFICATION_PROTOCOL, verificationProtocol } from "../../src/run/git.js";
import { Journal, pendingRepairFindings, repairReachSinceApproval, repairsSinceApproval, reviewRoundsSinceApproval, type JournalEvent } from "../../src/run/journal.js";
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
  /** R41: the verification stamp to seed on the row — omitted (`null`) for a pre-stamp row. */
  verification?: Record<string, unknown> | null;
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
  repoFiles: Record<string, string> = {},
  /** OBS-1049: extra shell a gate runs inside the T1 worktree, after its marker line. */
  gateExtras: Partial<Record<(typeof SHELL_GATES)[number], string>> = {},
): Promise<SeededResume> {
  const marker = join(makeTestTempDir("tickmarkr-resume-gates-"), "shells.log");
  const commands = Object.fromEntries(SHELL_GATES.map((gate) => [
    gate,
    `if [[ "$PWD" == *--T1 ]]; then printf '%s\\n' ${shq(gate)} >> ${shq(marker)};`
      + `${gateExtras[gate] ? ` ${gateExtras[gate]}` : ""}${gate === failingShell ? " exit 1;" : ""} fi`,
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
  for (const [path, body] of Object.entries(repoFiles)) writeFileSync(join(repo, path), body);
  if (Object.keys(repoFiles).length) await shGitOk("git add -A && git commit --no-gpg-sign -m repo-files", repo);
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
        // R41: a daemon-written row carries the verification protocol of the session that wrote it.
        ...(result.verification === null ? {} : { verification: result.verification ?? verificationProtocol() }),
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
    // OBS-1049: the replayed build is provisioned (its command runs once in the recreated tree); no gate runs
    expect(markerLines(green.marker)).toEqual(["build"]);
    expect(greenEvents.some((event) => event.event === "phase-start" && event.data.gate === "acceptance")).toBe(true);

    const failed = await seedResume("run-green-until-lint", [[
      { gate: "build", pass: true }, { gate: "test", pass: true }, { gate: "lint", pass: false },
    ]], undefined, "lint");
    const failedEvents = await resume(failed);
    expect(failedEvents.filter((event) => event.event === "gate-reused").map((event) => event.data.gate))
      .toEqual(["build", "test"]);
    expect(markerLines(failed.marker).slice(0, 2)).toEqual(["build", "lint"]); // provisioned build, then the first re-run gate
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
    expect(markerLines(unchanged.marker).slice(0, 2)).toEqual(["build", "lint"]); // OBS-1049: provisioned, then lint

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

test("a replayed green build onto the recreated worktree runs the build command exactly once before the test gate, journals gate-reused build then gate-provisioned build with exit 0, and the test gate finds the dist that provisioning wrote; a provisioning that exits 1 journals its exit, reuses no gate, and re-runs build as a gate, so a replayed build that leaves the recreated tree dist-less or a red provisioning that is still reused fails", async () => {
  const provisions = { build: "mkdir -p dist && echo built > dist/marker;", test: "[ -f dist/marker ] || exit 1;" };
  const green = await seedResume("run-replay-build-provisions", [[{ gate: "build", pass: true }]],
    undefined, undefined, {}, { ".gitignore": "dist/\n" }, provisions);
  const greenEvents = await resume(green);
  const shells = markerLines(green.marker);
  expect(shells.filter((s) => s === "build")).toEqual(["build"]);
  expect(shells.indexOf("build")).toBeLessThan(shells.indexOf("test"));
  expect(greenEvents.filter((e) => e.event === "gate-reused").map((e) => e.data.gate)).toEqual(["build"]);
  // Relative order, not two independent filters: reuse row first, then the provisioning it belongs to.
  expect(greenEvents.filter((e) => e.event === "gate-reused" || e.event === "gate-provisioned").map((e) => `${e.event}:${e.data.gate}`))
    .toEqual(["gate-reused:build", "gate-provisioned:build"]);
  expect(greenEvents.filter((e) => e.event === "gate-provisioned").map((e) => e.data))
    .toEqual([expect.objectContaining({ gate: "build", commit: green.commit, exitCode: 0 })]);
  expect(greenEvents.find((e) => e.event === "gate-result" && e.data.gate === "test")?.data.pass).toBe(true);
  expect(greenEvents.some((e) => e.event === "task-done")).toBe(true);

  const red = await seedResume("run-replay-build-provision-red", [[{ gate: "build", pass: true }]],
    undefined, "build", {}, { ".gitignore": "dist/\n" }, provisions);
  const redEvents = await resume(red);
  expect(redEvents.filter((e) => e.event === "gate-provisioned").map((e) => e.data.exitCode)).toEqual([1]);
  expect(redEvents.filter((e) => e.event === "gate-reused")).toEqual([]);
  expect(markerLines(red.marker).slice(0, 2)).toEqual(["build", "build"]); // provisioning, then build as a gate
  expect(redEvents.find((e) => e.event === "gate-result" && e.data.gate === "build")?.data.pass).toBe(false);
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
    const typedEvents = await resume(typed);
    expect(markerLines(typed.marker).slice(0, 2)).toEqual(["build", "lint"]);
    expect(typedEvents.filter((e) => e.event === "gate-provisioned" && e.data.gate === "build"))
      .toHaveLength(1);
    expect(typedEvents.filter((e) => e.event === "gate-result" && e.data.gate === "build")).toEqual([]);
  }, 120_000);

test("test: a waiver is consumed by the worktree-recreation row journaled as its enactment so a run killed after that row and before any later approval or park resumes with the formerly waived gate running while a fold that clears the waiver only on a later task-approved or task-human row replays the dead waiver and fails", () => {
  const journal = Journal.create(
    makeTestTempDir("tickmarkr-waiver-enacted-"),
    "run-waiver-enacted-then-killed",
  );
  journal.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 0 });
  journal.append("worker-result", "T1", {
    ok: true, summary: "landed", deviations: [], finished: true, exitCode: 0,
  });
  journal.phaseStart("T1", "gates");
  journal.append("gate-result", "T1", {
    gate: "build", pass: false, details: "exit 1", commit: "waived-commit", attempt: 0,
  });
  journal.append("task-human", "T1", { reason: "build failed", kind: "gate-fail" });
  journal.append("task-approved", "T1", {
    by: "operator", release: "gate-satisfied", gate: "build",
  });
  expect(journal.replaySatisfiedGates()).toEqual(new Map([["T1", "build"]]));

  journal.append("worktree-recreation", "T1", {
    attempted: ["waived-commit"], carried: ["waived-commit"],
  });

  // This is the durable fast-kill boundary consumed by runDaemon on resume. The executable resume
  // oracle immediately above pins that no satisfied gate means build runs; keep this test focused on
  // the fold input so it adds no second repository/worktree process fan-out to the full suite.
  expect(journal.read().at(-1)?.event).toBe("worktree-recreation");
  expect(journal.replaySatisfiedGates()).toEqual(new Map());
});

test("test: a task re-parked after its waiver was enacted resumes with no gate marked satisfied so the new park's own release decides afresh while a waiver surviving its own enactment into the next engagement fails", () => {
  const journal = Journal.create(
    makeTestTempDir("tickmarkr-waiver-reparked-"),
    "run-waiver-enacted-then-reparked",
  );
  journal.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 0 });
  journal.append("task-human", "T1", { reason: "gate failed", kind: "gate-fail" });
  journal.append("task-approved", "T1", {
    by: "operator", release: "gate-satisfied", gate: "build",
  });
  expect(journal.replayStatuses().get("T1")).toBe("pending");
  expect(journal.replaySatisfiedGates()).toEqual(new Map([["T1", "build"]]));

  journal.append("worktree-recreation", "T1", {
    attempted: ["waived-commit"], carried: ["waived-commit"],
  });
  expect(journal.replaySatisfiedGates()).toEqual(new Map());

  journal.append("task-human", "T1", {
    reason: "post-approval gate failed", kind: "gate-fail",
  });
  journal.append("run-resume", undefined, { pid: 222_222 });

  expect(journal.replayStatuses().get("T1")).toBe("human");
  expect(journal.replaySatisfiedGates()).toEqual(new Map());

  journal.append("task-approved", "T1", {
    by: "operator", release: "gate-satisfied", gate: "test",
  });
  expect(journal.replayStatuses().get("T1")).toBe("pending");
  expect(journal.replaySatisfiedGates()).toEqual(new Map([["T1", "test"]]));
});

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
    expect(markerLines(passed.marker).slice(0, 2)).toEqual(["build", "lint"]); // OBS-1049: provisioned, then lint

    const released = await seedResume(
      "run-attempt-current-released",
      [[{ gate: "build", pass: true }], [{ gate: "build", pass: false }]],
      { by: "operator", release: "gate-satisfied", gate: "build" },
    );
    const releasedEvents = await resume(released);
    expect(markerLines(released.marker).slice(0, 2)).toEqual(["build", "lint"]);
    expect(releasedEvents.filter((e) => e.event === "gate-provisioned" && e.data.gate === "build"))
      .toHaveLength(1);
    expect(releasedEvents.filter((e) => e.event === "gate-result" && e.data.gate === "build")).toEqual([]);
  }, 120_000);

test("resuming a green current-commit prefix whose rows carry no verification stamp re-runs every gate and journals gate-replay-verification-changed naming the unrecorded rows and this session's protocol, the same prefix stamped with another protocol, another lifecycle or an unknown lifecycle is likewise re-run and named, and the prefix stamped with this session's protocol and effective lifecycle is replayed with zero gate-shell invocations, so a replay that inherits a green measured by an older discovery implementation, under another npm lifecycle policy, or under a policy nobody measured fails", async () => {
  const current = verificationProtocol();
  expect(current.lifecycle).not.toBe("unknown");
  const cases: Array<{ label: string; stamp: Record<string, unknown> | null; replayed: boolean }> = [
    { label: "unstamped", stamp: null, replayed: false },
    { label: "other-protocol", stamp: { ...current, protocol: "vl1.1" }, replayed: false },
    { label: "other-lifecycle", stamp: { ...current, lifecycle: current.lifecycle === "hooks" ? "ignore-scripts" : "hooks" }, replayed: false },
    { label: "unknown-lifecycle", stamp: { ...current, lifecycle: "unknown", source: "unknown" }, replayed: false },
    { label: "current", stamp: current, replayed: true },
  ];
  for (const c of cases) {
    const seed = await seedResume(`run-replay-verification-${c.label}`,
      [SHELL_GATES.map((gate) => ({ gate, pass: true, verification: c.stamp }))]);
    const events = await resume(seed);
    const reused = events.filter((e) => e.event === "gate-reused").map((e) => e.data.gate);
    const changed = events.filter((e) => e.event === "gate-replay-verification-changed");
    if (c.replayed) {
      expect({ label: c.label, reused, changed: changed.length, shells: markerLines(seed.marker) })
        .toEqual({ label: c.label, reused: [...SHELL_GATES], changed: 0, shells: ["build"] }); // OBS-1049: the provisioning shell only
    } else {
      // Every shell gate re-runs (the full test suite runs last, as the merge candidate).
      expect({ label: c.label, reused, changed: changed.length, shells: [...markerLines(seed.marker)].sort() })
        .toEqual({ label: c.label, reused: [], changed: 1, shells: [...SHELL_GATES].sort() });
      expect(changed[0]!.data).toMatchObject({ commit: seed.commit, resolved: current });
      expect((changed[0]!.data.recorded as unknown[]).length).toBe(SHELL_GATES.length);
      if (c.stamp) expect(changed[0]!.data.recorded).toEqual(SHELL_GATES.map(() => c.stamp));
      else expect((changed[0]!.data.recorded as unknown[]).every((r) => r === null || r === undefined)).toBe(true);
    }
    const written = events.filter((e) => e.event === "gate-result" && e.taskId === "T1");
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((e) => JSON.stringify(e.data.verification) === JSON.stringify(current))).toBe(true);
  }
}, 300_000);

test("with no explicit lifecycle export the replay guard measures the effective policy for the recreated task worktree, so over a repository whose committed project npmrc sets ignore-scripts=false a green prefix stamped hooks from npm config is replayed with zero gate-shell invocations while the same prefix stamped ignore-scripts is re-run and gate-replay-verification-changed names hooks as resolved, and every gate-result row the resumed session writes carries the policy measured for that worktree, so a replay that compares against a session-wide policy resolved at the repository root instead of the task checkout's own fails", async () => {
  const prior = process.env.npm_config_ignore_scripts;
  delete process.env.npm_config_ignore_scripts;
  try {
    const projectNpmrc = { ".npmrc": "ignore-scripts=false\n" };
    const expected = { protocol: VERIFICATION_PROTOCOL, lifecycle: "hooks", source: "npm-config" };
    const replayed = await seedResume("run-replay-project-npmrc-same",
      [SHELL_GATES.map((gate) => ({ gate, pass: true, verification: expected }))], undefined, undefined, {}, projectNpmrc);
    const sameEvents = await resume(replayed);
    expect({ reused: sameEvents.filter((e) => e.event === "gate-reused").map((e) => e.data.gate), shells: markerLines(replayed.marker),
      changed: sameEvents.filter((e) => e.event === "gate-replay-verification-changed").length })
      .toEqual({ reused: [...SHELL_GATES], shells: ["build"], changed: 0 }); // OBS-1049: the provisioning shell only

    const stale = { protocol: VERIFICATION_PROTOCOL, lifecycle: "ignore-scripts", source: "npm-config" };
    const rerun = await seedResume("run-replay-project-npmrc-other",
      [SHELL_GATES.map((gate) => ({ gate, pass: true, verification: stale }))], undefined, undefined, {}, projectNpmrc);
    const otherEvents = await resume(rerun);
    const changed = otherEvents.filter((e) => e.event === "gate-replay-verification-changed");
    expect({ reused: otherEvents.filter((e) => e.event === "gate-reused").map((e) => e.data.gate), shells: [...markerLines(rerun.marker)].sort(), changed: changed.length })
      .toEqual({ reused: [], shells: [...SHELL_GATES].sort(), changed: 1 });
    expect(changed[0]!.data).toMatchObject({ commit: rerun.commit, resolved: expected, recorded: SHELL_GATES.map(() => stale) });
    const written = otherEvents.filter((e) => e.event === "gate-result" && e.taskId === "T1" && SHELL_GATES.includes(e.data.gate as never));
    expect(written.length).toBe(SHELL_GATES.length);
    expect(written.map((e) => e.data.verification)).toEqual(SHELL_GATES.map(() => expected));
  } finally {
    if (prior === undefined) delete process.env.npm_config_ignore_scripts; else process.env.npm_config_ignore_scripts = prior;
  }
}, 300_000);

async function fundedPlainResume(live: boolean, closed: boolean) {
  const seed = await seedResume(`run-plain-funding-${live}-${closed}`, [[{ gate: "test", pass: false }]], undefined, undefined, {
    tasks: { T1: [{ shell: `echo fixed > changed.txt && ${COMMIT} fixed`, result: { ok: true, summary: "fixed" } }] },
  });
  seed.journal.append("task-human", "T1", { kind: "gate-fail", reason: "old red" });
  const graph = loadGraph(seed.repo);
  saveGraph(seed.repo, { ...graph, tasks: graph.tasks.map((t) => ({ ...t, status: "human" })) });
  if (closed) seed.journal.append("run-end", undefined, { branch: `tickmarkr/${seed.runId}` });
  if (!live) seed.journal.append("task-approved", "T1", { by: "operator" });
  let appended = false;
  const summary = await runDaemon(seed.repo, { adapters: [seed.fake], runId: seed.runId, resume: true, approvalWindowMs: 1,
    narrate: (e) => {
      if (live && !appended && e.event === "approval-window-start") {
        appended = true;
        seed.journal.append("task-approved", "T1", { by: "operator" });
      }
    },
  });
  const events = seed.journal.read();
  const approvalAt = events.findIndex((e) => e.event === "task-approved");
  const post = events.slice(approvalAt + 1).filter((e) => e.taskId === "T1");
  const dispatchAt = post.findIndex((e) => e.event === "task-dispatch");
  const gatesAt = post.findIndex((e) => e.event === "gate-result");
  expect(summary.done).toEqual(["T1"]);
  expect(dispatchAt).toBeGreaterThanOrEqual(0);
  expect(gatesAt).toBeGreaterThan(dispatchAt);
  expect(post.some((e) => e.event === "worker-launch")).toBe(true);
  expect(post.filter((e) => e.event === "gate-result").every((e) => e.data.replayMeasurement !== true)).toBe(true);
  expect(post.some((e) => e.event === "gate-replayed")).toBe(false);
  expect(post.find((e) => e.event === "task-dispatch")?.data.attempt).toBe(1);
}

test("resume preserves a completed legacy plain approval followed by gate replay and merge without a new dispatch", async () => {
  const seed = await seedResume("run-legacy-approved-done", [[{ gate: "test", pass: false }]], { reason: "re-gate" });
  // 2.5.x enacted plain approvals through gates alone, leaving no dispatch to consume funding.
  for (const gate of ["build", "test", "lint", "evidence", "scope", "acceptance", "review"]) {
    seed.journal.append("gate-result", "T1", { gate, pass: true, commit: seed.commit, attempt: 0, replayMeasurement: true });
  }
  const branch = integrationBranch(loadConfig(seed.repo), seed.runId);
  const intWt = await ensureIntegration(seed.repo, branch, seed.commit);
  await shGitOk(`git merge --ff-only ${shq(seed.commit)}`, intWt);
  seed.journal.append("task-done", "T1", { attempts: 1, assignment: ASSIGNMENT });
  seed.journal.append("merge", "T1", { branch: `${branch}--T1`, commit: await gitHead(intWt) });
  const graph = loadGraph(seed.repo);
  saveGraph(seed.repo, { ...graph, tasks: graph.tasks.map((t) => ({ ...t, status: "done" })) });
  const before = seed.journal.replayResumeState().get("T1");

  const summary = await runDaemon(seed.repo, { adapters: [seed.fake], runId: seed.runId, resume: true, approvalWindowMs: 1 });

  expect(summary.done).toEqual(["T1"]);
  expect(summary.human).toEqual([]);
  expect(loadGraph(seed.repo).tasks[0]!.status).toBe("done");
  expect(afterLastResume(seed.journal.read()).filter((e) => e.taskId === "T1" &&
    ["task-dispatch", "worker-launch", "task-human", "gate-result", "task-done", "merge"].includes(e.event))).toEqual([]);
  expect(seed.journal.replayResumeState().get("T1")).toEqual(before);
  expect((await shGitOk(`git rev-parse ${shq(branch)}`, seed.repo)).trim()).toBe(seed.commit);
}, 120_000);

test("test: a resume over a journal holding an unenacted plain approval newer than the last dispatch starts a fresh attempt, so a resume that restores the superseded attempt from its cached reds fails", async () => {
  for (const closed of [false, true]) await fundedPlainResume(false, closed);
}, 120_000);

test("test: the same approval appended while the daemon is live is enacted by the live sweep as a fresh attempt, so a live sweep that replays the parked attempt's red verdicts fails", async () => {
  for (const closed of [false, true]) await fundedPlainResume(true, closed);
}, 120_000);

test("test: a restart or a live sweep holding no pending funding leaves human gate permission, replayed verdicts and attempt budget unchanged across consumed approvals or inert releases, so another approval demand or fresh funding inferred from those rows fails", async () => {
  const greens: SeedGate[] = ["build", "test", "lint", "evidence", "scope"].map((gate) => ({ gate: gate as GateName, pass: true }));
  for (const live of [false, true]) {
    for (const release of [undefined, { release: "unknown-release" }, { release: "gate-satisfied", gate: "unknown-gate" }]) {
      const seed = await seedResume(`run-no-funding-${live}-${release?.release ?? "consumed"}`, [greens]);
      // An approval that already paid for this dispatch still grants human-gate permission.
      const events = seed.journal.read();
      events.splice(1, 0, { ts: events[0]!.ts, event: "task-approved", taskId: "T1", data: { by: "operator" } });
      writeFileSync(seed.journal.journalPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const graph = loadGraph(seed.repo);
      const gated = { ...graph, tasks: graph.tasks.map((t) => ({ ...t, humanGate: true })) };
      saveGraph(seed.repo, gated);
      seed.journal.append("graph-rehash", undefined, { from: graphDefinitionHash(graph), to: graphDefinitionHash(gated) });
      if (release && !live) seed.journal.append("task-approved", "T1", release);
      const before = seed.journal.replayResumeState().get("T1");
      const summary = await runDaemon(seed.repo, { adapters: [seed.fake], runId: seed.runId, resume: true, approvalWindowMs: 1,
        narrate: (e) => {
          if (release && live && e.event === "run-resume") seed.journal.append("task-approved", "T1", release);
        },
      });
      const post = afterLastResume(seed.journal.read());
      expect(summary.done).toEqual(["T1"]);
      expect(post.filter((e) => e.event === "gate-reused").map((e) => e.data.gate)).toEqual(greens.map((g) => g.gate));
      expect(post.some((e) => ["task-dispatch", "worker-launch", "task-human", "gate-rerun"].includes(e.event))).toBe(false);
      expect(seed.journal.replayResumeState().get("T1")).toEqual(before);
    }
    for (const release of [{ release: "unknown-release" }, { release: "gate-satisfied", gate: "unknown-gate" }]) {
      const seed = await seedResume(`run-inert-park-${live}-${release.release}`, [[{ gate: "test", pass: false }]]);
      const graph = loadGraph(seed.repo);
      saveGraph(seed.repo, { ...graph, tasks: graph.tasks.map((t) => ({ ...t, status: "human" })) });
      seed.journal.append("task-human", "T1", { kind: "gate-fail", reason: "parked red" });
      const before = seed.journal.replayResumeState().get("T1");
      if (!live) seed.journal.append("task-approved", "T1", release);
      let appended = false;
      const summary = await runDaemon(seed.repo, { adapters: [seed.fake], runId: seed.runId, resume: true, approvalWindowMs: 1,
        narrate: (e) => {
          if (live && !appended && e.event === "approval-window-start") {
            appended = true;
            seed.journal.append("task-approved", "T1", release);
          }
        },
      });
      expect(summary.human).toEqual(["T1"]);
      expect(afterLastResume(seed.journal.read()).some((e) => ["task-dispatch", "worker-launch", "gate-result"].includes(e.event))).toBe(false);
      expect(seed.journal.replayResumeState().get("T1")).toEqual(before);
    }
  }
}, 120_000);


test("legacy worker launch consumes a recheck approval at restart and in the live sweep without reopening a human park", async () => {
  for (const live of [false, true]) {
    for (const missingWorktree of [false, true]) {
      const seed = await seedResume(`run-legacy-recheck-${live}-${missingWorktree}`, [[{ gate: "test", pass: false }]]);
      const park = () => seed.journal.append("task-human", "T1", { kind: "ladder-exhausted", reason: "exhausted" });
      const legacyEnactment = () => {
        seed.journal.append("task-approved", "T1", { release: "recheck" });
        seed.journal.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 1, retryMode: "fresh" });
        seed.journal.append("worker-launch", "T1", { attempt: 1 });
        park();
      };
      park();
      const graph = loadGraph(seed.repo);
      saveGraph(seed.repo, { ...graph, tasks: graph.tasks.map((t) => ({ ...t, status: "human" })) });
      if (!live) legacyEnactment();
      if (missingWorktree) await shGitOk(`git worktree remove --force ${shq(seed.taskWorktree)}`, seed.repo);
      let swept = false;
      // Repeated resumes must leave the consumed release consumed.
      for (let restart = 0; restart < 2; restart++) {
        let boundary = seed.journal.read().length;
        let before = seed.journal.replayResumeState().get("T1");
        const summary = await runDaemon(seed.repo, {
          adapters: [seed.fake], runId: seed.runId, resume: true, approvalWindowMs: 1,
          narrate: (e) => {
            if (live && !swept && e.event === "approval-window-start") {
              swept = true;
              legacyEnactment();
              boundary = seed.journal.read().length;
              before = seed.journal.replayResumeState().get("T1");
            }
          },
        });
        expect(summary.human).toEqual(["T1"]);
        expect(summary.failed).toEqual([]);
        expect(loadGraph(seed.repo).tasks[0]!.status).toBe("human");
        expect(seed.journal.read().slice(boundary).filter((e) => e.taskId === "T1" &&
          ["task-dispatch", "worker-launch", "worktree-recreation", "gate-result", "recheck-battery", "task-done"].includes(e.event))).toEqual([]);
        expect(seed.journal.replayResumeState().get("T1")).toEqual(before);
      }
      if (live) expect(swept).toBe(true);
    }
  }
}, 120_000);

test("test: the same eligible red observed by a resumed gate replay receives the same funded repair disposition, so a restored path that parks where the ordinary path repairs fails", async () => {
  const seed = await seedResume("run-unowned-replay", [[{ gate: "build", pass: true }]], undefined, undefined, {
    tasks: { T1: [{ shell: `echo fixed > changed.txt && ${COMMIT} repaired`, result: { ok: true, summary: "fixed" } }] },
  }, { "unowned.test.ts": "// detection site\n" }, {
    test: ' if test ! -f changed.txt; then echo "FAIL unowned.test.ts"; exit 1; fi;',
  });
  const events = await resume(seed);
  const funding = events.filter((e) => e.event === "repair-attempt");
  expect(funding).toHaveLength(1);
  expect(funding[0]!.data).toMatchObject({ charge: 1, commits: 1, gates: ["test"] });
  expect(funding[0]!.data.findings).toContain("FAIL unowned.test.ts");
  expect(events.find((e) => e.event === "task-dispatch")!.data.retryMode).toBe("repair");
  expect(events.some((e) => e.event === "scope-authoring" || e.event === "task-approved")).toBe(false);
  expect(events.some((e) => e.event === "merge")).toBe(true);
  expect(repairsSinceApproval(seed.journal.read(), "T1")).toBe(1);
}, 60_000);

test("test: a resume over a journal ending at repair funding before any launch holds that allowance unspent whereas one ending after the funded gate was reached keeps its charge, so refunding a spent repair or forfeiting an unspent one fails", async () => {
  const seed = await seedResume("run-repair-charge-replay", [[{ gate: "build", pass: true }]]);
  const finding = "test: FAIL unowned.test.ts\nAssertion evidence: expected ready, received waiting";
  seed.journal.append("repair-attempt", "T1", { repair: 1, gates: ["test"], findings: finding });
  const replay = () => Journal.open(seed.repo, seed.runId).read();
  seed.journal.append("run-resume", undefined, {});
  expect(repairsSinceApproval(replay(), "T1")).toBe(0);
  expect(pendingRepairFindings(replay(), "T1")).toBe(finding);
  seed.journal.append("task-dispatch", "T1", { attempt: 1, assignment: ASSIGNMENT, retryMode: "repair" });
  expect(repairsSinceApproval(replay(), "T1")).toBe(0);
  expect(pendingRepairFindings(replay(), "T1")).toBe(finding);
  seed.journal.append("worker-launch", "T1", {});
  seed.journal.append("gate-result", "T1", { gate: "build", pass: true });
  expect(repairsSinceApproval(replay(), "T1")).toBe(0);
  seed.journal.append("gate-result", "T1", { gate: "test", pass: false, details: "FAIL unowned.test.ts" });
  seed.journal.append("run-resume", undefined, {});
  expect(repairsSinceApproval(replay(), "T1")).toBe(1);
  expect(pendingRepairFindings(replay(), "T1")).toBeUndefined();
  expect(repairReachSinceApproval(replay(), "T1")).toEqual([
    { repair: 1, funded: ["test"], reached: ["build", "test"], diedAt: "test", charged: true },
  ]);
});

test("a waived build whose provisioning exits 1 records the failure and continues through the remaining gates without re-gating build or re-parking", async () => {
  const seed = await seedResume("run-waived-build-provision-red", [[{ gate: "build", pass: false }]],
    { by: "operator", release: "gate-satisfied", gate: "build" }, "build");
  const events = await resume(seed);
  expect(markerLines(seed.marker)).toEqual(["build", "lint", "test"]);
  expect(events.filter((e) => e.event === "gate-provisioned").map((e) => e.data))
    .toEqual([expect.objectContaining({ gate: "build", exitCode: 1 })]);
  expect(events.filter((e) => e.event === "gate-result" && e.data.gate === "build")).toEqual([]);
  expect(events.filter((e) => e.event === "gate-reused")).toEqual([]);
  expect(events.filter((e) => e.event === "gate-result").map((e) => [e.data.gate, e.data.pass]))
    .toEqual(expect.arrayContaining(["lint", "test", "evidence", "scope", "acceptance", "review"]
      .map((gate) => [gate, true])));
  expect(events.some((e) => e.event === "worktree-recreation")).toBe(true);
  expect(events.some((e) => e.event === "task-done")).toBe(true);
  expect(events.some((e) => e.event === "task-dispatch" || e.event === "task-human")).toBe(false);
}, 60_000);

const restoreProvisions = {
  build: "mkdir -p dist && echo built > dist/marker;",
  test: "[ -f dist/marker ] || exit 1;",
};
const waiverResults: SeedGate[] = [
  { gate: "build", pass: true }, { gate: "lint", pass: true },
  { gate: "evidence", pass: true }, { gate: "scope", pass: true },
  { gate: "acceptance", pass: true }, { gate: "review", pass: false },
];

test("test: a resume releasing a waived review gate onto a recreated worktree whose journal holds a green build runs the build command once as provisioning before the test gate and journals gate-provisioned build, so a restore that reaches the suite with no dist fails", async () => {
  const seed = await seedResume("run-waiver-provision", [waiverResults],
    { by: "operator", release: "gate-satisfied", gate: "review" }, undefined, {},
    { ".gitignore": "dist/\n" }, restoreProvisions);
  expect(existsSync(join(seed.taskWorktree, "dist"))).toBe(false);
  const events = await resume(seed);
  expect(markerLines(seed.marker)).toEqual(["build", "test"]);
  expect(events.filter((e) => e.event === "gate-provisioned").map((e) => e.data))
    .toEqual([expect.objectContaining({ gate: "build", exitCode: 0 })]);
  expect(events.findIndex((e) => e.event === "gate-provisioned"))
    .toBeLessThan(events.findIndex((e) => e.event === "phase-start" && e.data.gate === "test"));
  expect(events.filter((e) => e.event === "gate-result").map((e) => [e.data.gate, e.data.pass]))
    .toEqual([["test", true]]);
  expect(events.some((e) => e.event === "worktree-recreation")).toBe(true);
  expect(events.some((e) => e.event === "task-done")).toBe(true);
  expect(events.some((e) => e.event === "task-dispatch")).toBe(false);
}, 60_000);

test("test: the same waiver restore whose provisioning exits nonzero re-enters build and every declared gate behind it as gates and journals no reuse, so a red provisioning that is skipped fails", async () => {
  const seed = await seedResume("run-waiver-provision-red", [waiverResults],
    { by: "operator", release: "gate-satisfied", gate: "review" }, undefined, {},
    { ".gitignore": "dist/\n" }, {
      ...restoreProvisions,
      build: "if [ ! -f dist/marker ]; then mkdir -p dist && echo built > dist/marker; exit 1; fi;",
    });
  const events = await resume(seed);
  expect(events.filter((e) => e.event === "gate-provisioned").map((e) => e.data.exitCode)).toEqual([1]);
  expect(events.filter((e) => e.event === "gate-reused")).toEqual([]);
  expect(markerLines(seed.marker)).toEqual(["build", "build", "lint", "test"]);
  const results = events.filter((e) => e.event === "gate-result");
  expect(results.map((e) => e.data.gate).sort()).toEqual([
    "acceptance", "build", "evidence", "lint", "review", "scope", "test",
  ]);
  expect(results.every((e) => e.data.pass === true)).toBe(true);
  expect(events.some((e) => e.event === "task-done")).toBe(true);
  expect(events.some((e) => e.event === "task-dispatch")).toBe(false);
}, 60_000);

test("test: a recheck restore runs build as a gate and journals no gate-provisioned row, so provisioning that runs a second build beside the build gate fails", async () => {
  const seed = await seedResume("run-recheck-provision", [waiverResults], undefined, undefined, {},
    { ".gitignore": "dist/\n" }, restoreProvisions);
  seed.journal.append("task-approved", "T1", { by: "operator", release: "recheck", recheckedRef: seed.commit });
  const events = await resume(seed);
  expect(markerLines(seed.marker)).toEqual(["build", "lint", "test"]);
  expect(events.filter((e) => e.event === "gate-provisioned" || e.event === "gate-reused")).toEqual([]);
  expect(events.filter((e) => e.event === "gate-result" && e.data.gate === "build").map((e) => e.data.pass)).toEqual([true]);
  expect(events.find((e) => e.event === "gate-result" && e.data.gate === "test")?.data.pass).toBe(true);
  expect(events.some((e) => e.event === "worktree-recreation")).toBe(true);
  expect(events.some((e) => e.event === "task-done")).toBe(true);
}, 60_000);

test("test: a contiguous prefix restore keeps its gate-reused rows followed by one gate-provisioned build row in that order, so a hoist that reorders or duplicates the prefix branch's rows fails", async () => {
  const gates: GateName[] = ["build", "test", "lint", "evidence", "scope"];
  const seed = await seedResume("run-prefix-provision-order", [gates.map((gate) => ({ gate, pass: true }))],
    undefined, undefined, {}, { ".gitignore": "dist/\n" }, restoreProvisions);
  const events = await resume(seed);
  expect(events.filter((e) => e.event === "gate-reused" || e.event === "gate-provisioned").map((e) => [e.event, e.data.gate, e.data.commit]))
    .toEqual([...gates.map((gate) => ["gate-reused", gate, seed.commit]), ["gate-provisioned", "build", seed.commit]]);
  expect(markerLines(seed.marker)).toEqual(["build"]);
  expect(events.find((e) => e.event === "gate-provisioned")?.data.exitCode).toBe(0);
  expect(events.some((e) => e.event === "task-done")).toBe(true);
}, 60_000);
