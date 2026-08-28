// T7: a gate verdict carries the capacity it was measured under, and no reuse crosses a changed one.
//
// The capacity is the fork cap a command's child actually received and the core count that cap was
// divided from — resolved where the shell builds the child's environment, so an operator export is
// recorded as the operator's number rather than the run's derived one. Every reuse of recorded
// evidence across a session boundary is keyed on it here: the baseline's forgiveness at BOTH of its
// readers, the cached tip verdict, and a resumed run's contiguous green prefix.
//
// The load averages a gate row carries beside the capacity are deliberately absent from every
// comparison below: they are endpoint samples of a gate whose interior neither of them saw. Nothing
// in this file claims a machine was calm — only that two measurements divided it by the same number.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, test } from "vitest";
import type { Assignment } from "../../src/adapters/types.js";
import { shq } from "../../src/adapters/types.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { type Baseline, compareToBaseline, fingerprint } from "../../src/gates/baseline.js";
import { loadConfig } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import type { GateName } from "../../src/graph/schema.js";
import { runDaemon, verifyIntegrationTipCached } from "../../src/run/daemon.js";
import { deriveForkCap, FORK_CAP_ENV, gitHead, type RunCapacity, sameCapacity, shGitOk } from "../../src/run/git.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { ensureIntegration, integrationBranch, verifyIntegrationTip } from "../../src/run/merge.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const CORES = availableParallelism();
/** The one export every child of this process inherits; restored after every case. */
const operatorExport = (cap: number | undefined): void => {
  if (cap === undefined) delete process.env[FORK_CAP_ENV];
  else process.env[FORK_CAP_ENV] = String(cap);
};
const priorExport = process.env[FORK_CAP_ENV];
afterEach(() => {
  if (priorExport === undefined) delete process.env[FORK_CAP_ENV];
  else process.env[FORK_CAP_ENV] = priorExport;
});

type GateRow = Record<string, unknown> & { gate: string; capacity?: RunCapacity };
const gateRows = (repo: string, runId: string): GateRow[] =>
  Journal.open(repo, runId).read().filter((e) => e.event === "gate-result").map((e) => e.data as GateRow);

const lines = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0) : [];

test("test: a gate row for a command the battery actually ran carries the fork cap that command's child received and the core count it was divided from, read where the shell builds that child's environment, so an operator export of the cap is recorded as the operator's value; a stamp re-derived from the run's own budget after the command returned reports the run's number on exactly the case a release was re-taken for and: it fails", async () => {
  // The run's OWN budget, derived from the concurrency this run resolves, and an operator export
  // that is deliberately a different number on any machine — 2-core runner or 64-core host alike.
  // Without that gap the case a release was re-taken for is untestable: the two answers coincide.
  const derived = deriveForkCap(1);
  const operatorCap = derived + 7;
  expect(operatorCap).not.toBe(derived);
  operatorExport(operatorCap);

  // Every gate command records the cap its own child was handed, so the assertions below compare the
  // journalled stamp against what the machine actually delivered rather than against a helper's
  // return value. The log lives outside the repo: a gate that dirties the worktree fails the round.
  const log = join(makeTestTempDir("tickmarkr-capacity-gates-"), "caps.log");
  const gate = `printf '%s\\n' "\${${FORK_CAP_ENV}-unset}" >> ${shq(log)}`;
  const fixture = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `echo T1 > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "done" } }] } },
    stringify({ concurrency: 1, gates: { build: gate, test: gate, lint: gate } }),
  );
  await runDaemon(fixture.repo, { adapters: [fixture.fake], runId: "run-capacity-stamp" });

  const rows = gateRows(fixture.repo, "run-capacity-stamp");
  const battery = rows.filter((r) => ["build", "test", "lint"].includes(r.gate));
  expect(battery.map((r) => r.gate).sort()).toEqual(["build", "lint", "test"]);
  for (const row of battery) {
    expect({ gate: row.gate, capacity: row.capacity })
      .toEqual({ gate: row.gate, capacity: { forkCap: operatorCap, cores: CORES } });
  }

  // the stamp IS what the child received: every gate shell, and the baseline capture before them,
  // wrote the operator's number into the log from its own environment
  const delivered = [...new Set(lines(log))];
  expect(delivered).toEqual([String(operatorCap)]);
  // …and never the run's own derived budget, which is what a stamp re-derived after the command
  // returned would report on exactly this case.
  expect(rows.map((r) => r.capacity?.forkCap)).not.toContain(derived);

  // a row for a gate that ran no battery command states no capacity: it never divided the machine.
  for (const row of rows.filter((r) => ["evidence", "scope"].includes(r.gate))) {
    expect({ gate: row.gate, capacity: row.capacity }).toEqual({ gate: row.gate, capacity: undefined });
  }

  // …and the verdict a green command's ROW is REPLACED by is still that command's row. run-gates
  // swaps a battery result for a dirty-worktree refusal when the command exits 0 having left the
  // tree dirty — a fresh verdict object built from none of the result it replaces. The child ran, so
  // the row owes the world it ran in; a lift that reads only what survived that swap records nothing
  // here and the criterion is met on clean commands alone.
  const dirty = setupRepo(
    [T("T2")],
    { tasks: { T2: [{ shell: `echo T2 > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "done" } }] } },
    stringify({ concurrency: 1, gates: { build: "printf dirt > dirt.txt" } }),
  );
  await runDaemon(dirty.repo, { adapters: [dirty.fake], runId: "run-capacity-dirty" });

  const refusals = gateRows(dirty.repo, "run-capacity-dirty")
    .filter((r) => r.gate === "build" && String(r.details).includes("The build command (printf dirt > dirt.txt) left them behind"));
  expect(refusals.length).toBeGreaterThan(0);
  for (const row of refusals) {
    expect({ pass: row.pass, capacity: row.capacity })
      .toEqual({ pass: false, capacity: { forkCap: operatorCap, cores: CORES } });
  }
}, 300_000);

const KNOWN = "FAIL tests/known.test.ts > pre-existing red";
// `undefined` is the pre-T7 entry that records nothing; every other value — `null` included — is a
// value the entry really carries, so it must reach the reader rather than being dropped here.
const redAt = (capacity?: unknown): Baseline => ({
  commands: {
    test: {
      exitCode: 1,
      fingerprints: fingerprint(KNOWN),
      ...(capacity === undefined ? {} : { capacity: capacity as RunCapacity }),
    },
  },
});

/** A tree whose one command reproduces exactly the failure the baseline recorded. */
function redRepo(): { wt: string; runDir: string; commands: Record<string, string> } {
  const wt = makeRepo({ "fail.sh": `printf '%s\\n' "${KNOWN}"\nexit 1\n` });
  const runDir = join(wt, "run");
  mkdirSync(runDir, { recursive: true });
  return { wt, runDir, commands: { test: "sh fail.sh" } };
}

test("test: a verdict whose failures are all recorded in a baseline captured under a different fork cap fails instead of forgiving them at both readers of that entry (the task battery as well as the post-merge tip verification), so a red never becomes a green on fingerprints from a world it was not measured in; the same baseline and verdict sharing one cap still forgives, while a repair voiding forgiveness wherever a capture recorded a cap reds every ordinary run and: it fails", async () => {
  const cap = 3;
  operatorExport(cap);
  const here: RunCapacity = { forkCap: cap, cores: CORES };
  const { wt, runDir, commands } = redRepo();

  // CONTROL, and the falsifier for a repair that simply voids forgiveness wherever a capture
  // recorded a capacity: same world, same fingerprints, still forgiven — at both readers.
  const [batteryControl] = await compareToBaseline(wt, commands, redAt(here), ["test"]);
  expect(batteryControl!.pass).toBe(true);
  expect(batteryControl!.details).toContain("forgiven");
  const [tipControl] = await verifyIntegrationTip(wt, commands, runDir, redAt(here));
  expect(tipControl!.pass).toBe(true);
  expect(tipControl!.forgiven).toBe(true);

  // A capture taken under a different fork cap divided the machine by a different number, so its
  // fingerprints are not evidence that these failures pre-existed the diff.
  const otherCap: RunCapacity = { forkCap: cap + 1, cores: CORES };
  const [batteryOther] = await compareToBaseline(wt, commands, redAt(otherCap), ["test"]);
  expect(batteryOther!.pass).toBe(false);
  expect(batteryOther!.details).toContain("capacity");
  const [tipOther] = await verifyIntegrationTip(wt, commands, runDir, redAt(otherCap));
  expect(tipOther!.pass).toBe(false);
  expect(tipOther!.forgiven).toBeUndefined();

  // the cores half is comparable too: the same cap divided out of a different machine is a different
  // world, which is what a journal replayed on another host looks like
  const otherCores: RunCapacity = { forkCap: cap, cores: CORES + 1 };
  expect((await compareToBaseline(wt, commands, redAt(otherCores), ["test"]))[0]!.pass).toBe(false);
  expect((await verifyIntegrationTip(wt, commands, runDir, redAt(otherCores)))[0]!.pass).toBe(false);
});

test("test: a cached tip verdict recorded under a different fork cap is not carried forward and the verification runs its commands again, so a skip never inherits a green from a world this session is not in; a cache eligible on the tip and the command set alone carries that green forward and: it fails", async () => {
  const runs = join(makeTestTempDir("tickmarkr-capacity-tip-"), "runs.log");
  const repo = makeRepo({ "green.sh": `printf '%s\\n' ran >> ${shq(runs)}\nexit 0\n` });
  const events: JournalEvent[] = [];
  const journal = {
    dir: makeTestTempDir("tickmarkr-capacity-tipdir-"),
    read: () => events,
    append: (event: string, taskId: string | undefined, data: Record<string, unknown>) => {
      events.push({ ts: new Date().toISOString(), event, ...(taskId ? { taskId } : {}), data } as unknown as JournalEvent);
    },
  } as unknown as Journal;
  const commands = { test: "sh green.sh" };

  operatorExport(3);
  expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
  expect(lines(runs)).toHaveLength(1);

  // CONTROL: nothing moved — same tip, same commands, same capacity — so the green is carried
  // forward and the command is not re-run. This is the behaviour the capacity key must preserve.
  expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
  expect(lines(runs)).toHaveLength(1);
  expect(events.filter((e) => e.event === "tip-verify-cached")).toHaveLength(1);

  // A session that divides the machine by a different number is not the session that established
  // that green. A cache keyed on the tip and the command set alone carries it forward regardless.
  operatorExport(4);
  expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
  expect(lines(runs)).toHaveLength(2);
  expect(events.filter((e) => e.event === "tip-verify-cached")).toHaveLength(1);
  const starts = events.filter((e) => e.event === "tip-verify-start");
  expect(starts.map((e) => e.data.cached)).toEqual([false, true, false]);

  // The green lives on the VERDICT row, not on the start row that preceded it. A start row states
  // the world a cycle intended to run in before one command had run; a cycle whose verdict row was
  // measured somewhere else — or cannot say where — is not a green this session may inherit, so a
  // cache that reads the start row alone and never the verdict's own capacity carries it forward.
  const tamper = (capacity: unknown): void => {
    const last = [...events].reverse().find((e) => e.event === "tip-verify")!;
    (last.data as Record<string, unknown>).capacity = capacity;
  };
  for (const [label, capacity] of [
    ["another world", { forkCap: 9, cores: CORES }],
    ["malformed", { forkCap: 0, cores: CORES }],
  ] as Array<[string, unknown]>) {
    const before = lines(runs).length;
    tamper(capacity);
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    expect({ label, ran: lines(runs).length }).toEqual({ label, ran: before + 1 });
    expect(events.filter((e) => e.event === "tip-verify-cached")).toHaveLength(1);
  }
});

const ASSIGNMENT: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const SHELL_GATES = ["build", "test", "lint"] as const;

/**
 * A journal whose current attempt already recorded green build/test/lint on the task's exact commit,
 * each row stamped with `capacity`. Resuming it either replays those greens or re-runs them; the
 * marker file names every gate shell that actually ran, so an inert resume is not mistaken for one.
 */
async function seedGreenAttempt(runId: string, capacity: unknown): Promise<{ repo: string; fake: FakeAdapter; marker: string }> {
  const marker = join(makeTestTempDir("tickmarkr-capacity-resume-"), "shells.log");
  const commands = Object.fromEntries(SHELL_GATES.map((gate) => [
    gate,
    `if [[ "$PWD" == *--T1 ]]; then printf '%s\\n' ${shq(gate)} >> ${shq(marker)}; fi`,
  ]));
  const { repo, fake } = setupRepo(
    [T("T1", { files: ["work.txt"] })],
    {
      tasks: { T1: [{ shell: "exit 99", result: { ok: false, summary: "worker must not be re-dispatched" } }] },
      judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
      review: { approve: true, issues: [] },
    },
    stringify({ concurrency: 1, gates: commands }),
  );
  const baseRef = await gitHead(repo);
  const branch = integrationBranch(loadConfig(repo), runId);
  await ensureIntegration(repo, branch, baseRef);
  const taskWorktree = await new SubprocessDriver().worktree(repo, `${branch}--T1`, baseRef);
  writeFileSync(join(taskWorktree, "work.txt"), "landed work\n");
  await shGitOk("git add work.txt && git commit --no-gpg-sign -m work", taskWorktree);
  const commit = await gitHead(taskWorktree);

  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, {
    pid: 111_111, baseRef, commands, branch, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
  });
  journal.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 0, retryMode: "fresh" });
  journal.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [], finished: true, exitCode: 0 });
  journal.phaseStart("T1", "gates");
  for (const gate of SHELL_GATES) {
    journal.append("gate-result", "T1", {
      gate: gate as GateName, pass: true, details: "exit 0", commit, attempt: 0,
      ...(gate === "test" ? { fullSuite: true } : {}),
      ...(capacity === undefined ? {} : { capacity }),
    });
  }
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({
    commands: Object.fromEntries(SHELL_GATES.map((gate) => [gate, { exitCode: 0, fingerprints: [] }])),
  }));
  return { repo, fake, marker };
}

const reusedGates = (repo: string, runId: string): string[] =>
  Journal.open(repo, runId).read().filter((e) => e.event === "gate-reused").map((e) => e.data.gate as string);

test("test: a resumed run re-runs a green gate whose recorded capacity differs from the one this session resolved rather than reusing it, so a contiguous green prefix keyed on the task commit alone cannot span two worlds; a reuse predicate reading the commit and never the recorded capacity replays that green and: it fails", async () => {
  operatorExport(3);
  const here: RunCapacity = { forkCap: 3, cores: CORES };

  // CONTROL: the same world. The commit is unchanged and the capacity matches, so the green prefix
  // is replayed and not one gate shell runs — exactly today's behaviour.
  const same = await seedGreenAttempt("run-capacity-resume-same", here);
  await runDaemon(same.repo, { adapters: [same.fake], runId: "run-capacity-resume-same", resume: true });
  expect(reusedGates(same.repo, "run-capacity-resume-same")).toEqual([...SHELL_GATES]);
  expect(lines(same.marker)).toEqual([]);

  // The same commit measured under a different fork cap. The tree is identical; the machine it was
  // measured on was divided by a different number, so those greens are re-run.
  const other = await seedGreenAttempt("run-capacity-resume-other", { forkCap: 4, cores: CORES });
  await runDaemon(other.repo, { adapters: [other.fake], runId: "run-capacity-resume-other", resume: true });
  expect(reusedGates(other.repo, "run-capacity-resume-other")).toEqual([]);
  expect(lines(other.marker)[0]).toBe("build");
}, 300_000);

test("test: a record carrying no capacity keeps exactly the verdict it has today; a record whose capacity is half-present, empty, zero, negative or unparseable fails closed instead, so an older baseline never breaks and a malformed newer one is never read as an older one — a reader treating a malformed capacity as an absent one: it fails", async () => {
  operatorExport(3);
  const here: RunCapacity = { forkCap: 3, cores: CORES };
  const { wt, runDir, commands } = redRepo();

  // the pre-T7 record: no capacity anywhere, and the verdict is the one it has today
  const [legacyBattery] = await compareToBaseline(wt, commands, redAt(), ["test"]);
  expect(legacyBattery!.pass).toBe(true);
  expect(legacyBattery!.details).toContain("forgiven");
  const [legacyTip] = await verifyIntegrationTip(wt, commands, runDir, redAt());
  expect(legacyTip!.pass).toBe(true);
  expect(legacyTip!.forgiven).toBe(true);
  expect(sameCapacity(undefined, here)).toBe(true);

  // every way a NEWER record can carry a capacity it cannot state. None of these is an absence:
  // reading them as one is how a fail-closed guard stops firing without anyone noticing.
  const malformed: Array<[string, unknown]> = [
    ["half-present (no cores)", { forkCap: 3 }],
    ["half-present (no fork cap)", { cores: CORES }],
    ["empty", {}],
    ["zero", { forkCap: 0, cores: CORES }],
    ["negative", { forkCap: -3, cores: CORES }],
    ["unparseable", { forkCap: Number("6 forks"), cores: CORES }],
    ["a string where the pair belongs", "3"],
    ["null", null],
    ["fractional", { forkCap: 3.5, cores: CORES }],
  ];
  for (const [label, capacity] of malformed) {
    expect({ label, comparable: sameCapacity(capacity, here) }).toEqual({ label, comparable: false });
    const [row] = await compareToBaseline(wt, commands, redAt(capacity), ["test"]);
    expect({ label, pass: row!.pass }).toEqual({ label, pass: false });
    const [tip] = await verifyIntegrationTip(wt, commands, runDir, redAt(capacity));
    expect({ label, pass: tip!.pass }).toEqual({ label, pass: false });
  }
});
