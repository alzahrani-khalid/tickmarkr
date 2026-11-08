// Queue row 372 (D-2186): a graph-changed resume releases a parked task whose definition changed as a new
// engagement on both stop paths. The closed CASE table runs through the pure decider; the captured shapes,
// the kept parks and the waiver cells run through runDaemon. Zero tokens: fake adapters, the subprocess
// driver, disposable repositories.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { approve } from "../../src/cli/commands/approve.js";
import { narrationRow } from "../../src/cli/commands/run.js";
import { status } from "../../src/cli/commands/status.js";
import { wait } from "../../src/cli/commands/wait.js";
import { graphDefinitionHash, loadGraph, saveGraph } from "../../src/graph/graph.js";
import { GATE_NAMES, validateGraph, type Task } from "../../src/graph/schema.js";
import { pendingDaemonApprovalActions, runDaemon, type RunOptions } from "../../src/run/daemon.js";
import { createWorktree, gitHead, worktreePath } from "../../src/run/git.js";
import { foldDecisions, Journal, physicalLine, reviewRoundsSinceApproval, type JournalEvent } from "../../src/run/journal.js";
import { readOperatorState } from "../../src/run/operator-state.js";
import { decideSplitRelease, ENDED_PATH, PARK_KEPT_EVENT, parkDefinition, splitReleaseReads, STOPPED_PATH, type TaskWorkRead } from "../../src/run/split-release.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const SPEC = { source: "prd", paths: ["p"], hash: "h" };
const loaded = (task: Record<string, unknown>): Task => validateGraph({ version: 1, spec: SPEC, tasks: [task] }).tasks[0]!;
const recompile = (repo: string, tasks: Record<string, unknown>[]) => saveGraph(repo, validateGraph({ version: 1, spec: SPEC, tasks }));
const rows = (repo: string, runId: string) => Journal.open(repo, runId).read();
const plain = (s: string | null) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const rail = (event: JournalEvent, runId: string) => plain(narrationRow(event, runId, 400));
const NOISE = new Set(["worker-contact", "worker-status"]);
const SEAT = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// The captured task before and after its split: the split moves its goal, files and acceptance.
const ORIGINAL = T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] });
const SPLIT = T("T1", { complexity: 8, goal: "T1, split: the guard only", files: ["f.txt"], acceptance: [{ oracle: "command", command: "test -f f.txt" }] });

// ---- the pure decider: the closed CASE table ------------------------------------------------------------
const BEFORE = loaded(ORIGINAL);
const AFTER = loaded(SPLIT);
const REHASH = { from: "a1a1a1a1a1a1a1a1", to: "5f5f5f5f5f5f5f5f" };
const HEAD = "c".repeat(40);
const RUN = "run-split-table";
let clock = 0;
const row = (event: string, taskId?: string, data: Record<string, unknown> = {}): JournalEvent =>
  ({ ts: new Date(Date.UTC(2026, 10, 8, 0, 0, 0, clock++)).toISOString(), event, ...(taskId ? { taskId } : {}), data });
const binding = (events: JournalEvent[], i: number) => ({ line: physicalLine(events, i), ts: events[i]!.ts });

interface Parked { kind?: string; reason?: string; definition?: unknown; stop?: "ended" | "stopped"; dispatched?: boolean; before?: JournalEvent[]; after?: JournalEvent[] }
/** One review-cap park, stopped by a run-end (worktree removed, head preserved) or a SIGTERM in the window. */
const parkedJournal = (o: Parked = {}): JournalEvent[] => [
  row("run-start", undefined, { baseRef: "b".repeat(40) }),
  ...(o.dispatched === false ? [] : [
    row("task-dispatch", "T1", { attempt: 0, assignment: SEAT }),
    row("gate-result", "T1", { gate: "review", pass: false, commit: "s1", details: "f.txt: the guard is missing" }),
    row("task-dispatch", "T1", { attempt: 1, assignment: SEAT }),
    row("gate-result", "T1", { gate: "review", pass: false, commit: "s2", details: "f.txt: the guard is missing" }),
  ]),
  ...(o.before ?? []),
  row("task-human", "T1", {
    kind: o.kind ?? "gate-fail", reason: o.reason ?? "review round cap (2) reached this engagement — release with …",
    ...(o.definition === null ? {} : { definition: o.definition ?? parkDefinition(BEFORE) }),
  }),
  row("approval-window-start", undefined, { windowMs: 120000, parked: ["T1"] }),
  ...(o.stop === "stopped"
    ? [row("exit-cause", undefined, { cause: "deliberate", signal: "SIGTERM" })]
    : [row("approval-window-expired", undefined, { parked: ["T1"] }), row("run-end", undefined, { human: ["T1"] }),
      row("worktree-removed", undefined, { task: "T1", head: HEAD, ref: `refs/tickmarkr/preserved/${HEAD}` })]),
  ...(o.after ?? []),
  row("graph-rehash", undefined, REHASH),
  row("run-resume", undefined, { graphChanged: true }),
];
const parkIndex = (events: JournalEvent[], taskId = "T1") => events.map((e) => e.event === "task-human" && e.taskId === taskId).lastIndexOf(true);
const decide = (events: JournalEvent[], o: { tasks?: Task[]; work?: Record<string, TaskWorkRead>; rehash?: typeof REHASH | null } = {}) => {
  const input = { runId: RUN, events, tasks: o.tasks ?? [AFTER], rehash: o.rehash === null ? undefined : o.rehash ?? REHASH };
  return { decisions: decideSplitRelease(input, new Map(Object.entries(o.work ?? { T1: { head: HEAD, commits: 2 } }))), reads: splitReleaseReads(input) };
};
const releaseOf = (events: JournalEvent[], path: string, extra: Record<string, unknown> = { release: "recheck" }, head: string | null = HEAD) => ({
  taskId: "T1", event: "task-approved", data: {
    by: "resume --graph-changed", via: "resume", ...extra, park: binding(events, parkIndex(events)),
    engagement: { cause: "graph-changed", rehash: REHASH, from: parkDefinition(BEFORE), to: parkDefinition(AFTER), path, ...(head ? { head } : {}) },
  },
});
const keptReason = (events: JournalEvent[]) => {
  const { decisions } = decide(events);
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ taskId: "T1", event: PARK_KEPT_EVENT, data: { park: physicalLine(events, parkIndex(events)) } });
  return String(decisions[0]!.data.reason);
};

describe("row 372 — the split release decider", () => {
  test("the split release CASE table decides release recheck plain kept or nothing from the park kind the park definition record the loaded definition and the task work read", () => {
    // Captured ended shape: one recheck release bound to the park's token, path "the run had ended".
    const ended = parkedJournal();
    const endedCell = decide(ended);
    expect(endedCell.reads).toEqual(["T1"]);
    expect(endedCell.decisions).toEqual([releaseOf(ended, ENDED_PATH)]);
    expect(endedCell.decisions[0]!.data).not.toHaveProperty("reviewRoundCeiling");
    // ... and it is a BOUND decision: the existing fold judges it effective, its battery is pending, and the
    // engagement fold restarts at it — the exhausted round count is zero from the release row on.
    const released = [...ended, row("task-approved", "T1", endedCell.decisions[0]!.data)];
    const fold = foldDecisions(released);
    expect(fold.open).toEqual([{ taskId: "T1", line: released.length }]);
    expect(fold.effective.has(released.length)).toBe(true);
    expect(pendingDaemonApprovalActions(released).get("T1")).toMatchObject({ authority: "battery", release: "recheck" });
    expect(reviewRoundsSinceApproval(ended, "T1")).toBe(2);
    expect(reviewRoundsSinceApproval(released, "T1")).toBe(0);
    // The daemon dies after the release row, before its battery: no open park remains, so a later
    // (even graph-changed) resume writes no second release row; the pending battery enacts the first.
    expect(decide(released).decisions).toEqual([]);

    // Captured stopped shape: the same release, path "the run was stopped before it ended".
    const stopped = parkedJournal({ stop: "stopped" });
    expect(decide(stopped).decisions).toEqual([releaseOf(stopped, STOPPED_PATH)]);

    // No commits ahead of the task base: a plain release (no release field, no head) funds a fresh worker.
    const plainCell = decide(ended, { work: { T1: { head: "b".repeat(40), commits: 0 } } }).decisions;
    expect(plainCell).toEqual([releaseOf(ended, ENDED_PATH, {}, null)]);
    expect(pendingDaemonApprovalActions([...ended, row("task-approved", "T1", plainCell[0]!.data)]).get("T1"))
      .toMatchObject({ authority: "worker", release: "plain" });

    // Recovered from a journaled preserved ref (no checkout, branch or usable removal row): the recheck release
    // names that ref, so the battery gates exactly that tree; a preserved ref proving no commits is plain.
    const ref = `refs/tickmarkr/preserved/${HEAD}`;
    expect(decide(ended, { work: { T1: { head: HEAD, commits: 1, ref } } }).decisions)
      .toEqual([releaseOf(ended, ENDED_PATH, { release: "recheck", recheckedRef: ref })]);
    expect(decide(ended, { work: { T1: { head: "b".repeat(40), commits: 0, ref } } }).decisions).toEqual([releaseOf(ended, ENDED_PATH, {}, null)]);

    // Reading the task work fails (or was never taken): kept, naming the read failure and the park's verbs.
    const token = `${physicalLine(ended, parkIndex(ended))}@${ended[parkIndex(ended)]!.ts}`;
    const failed = decide(ended, { work: { T1: { error: "cannot rebuild task branch tickmarkr/x--T1: bad object" } } }).decisions;
    expect(failed).toHaveLength(1);
    expect(failed[0]!.event).toBe(PARK_KEPT_EVENT);
    expect(failed[0]!.data.reason).toContain("reading the task work failed (cannot rebuild task branch tickmarkr/x--T1: bad object)");
    expect(failed[0]!.data.reason).toContain(`\`tickmarkr approve ${RUN} T1 --recheck --gate review --park ${token}\``);
    expect(decide(ended, { work: {} }).decisions[0]!.data.reason).toContain("reading the task work failed (no read was taken)");

    // A park written before definition records: kept, the definition at park unrecorded, no work read.
    const legacy = parkedJournal({ definition: null });
    expect(keptReason(legacy)).toContain("the definition at park is unrecorded");
    expect(decide(legacy).reads).toEqual([]);

    // A stall park that recorded a reapFailure: its recheck release carries it, so the census guard runs
    // before any gate; a plain release (no commits) carries none, as an operator's plain approve.
    const unreaped = parkedJournal({ kind: "stall", reason: "worker could not be reaped before harvest: census unreadable", after: [] });
    unreaped[parkIndex(unreaped)]!.data.reapFailure = "census unreadable";
    expect(decide(unreaped).decisions).toEqual([releaseOf(unreaped, ENDED_PATH, { release: "recheck", reapFailure: "census unreadable" })]);
    expect(decide(unreaped, { work: { T1: { head: "b".repeat(40), commits: 0 } } }).decisions).toEqual([releaseOf(unreaped, ENDED_PATH, {}, null)]);
    // Only an exempt kept park is held out of scheduling; a read-failure or unrecorded kept park keeps its base.
    expect(failed[0]).not.toHaveProperty("hold");
    expect(decide(legacy).decisions[0]).not.toHaveProperty("hold");

    // Every non-exempt kind is released by the same rule (a consult's human verdict parks on its trigger kind).
    for (const [kind, reason] of [["gate-fail", undefined], ["stall", "worker stalled"], ["infra", "runner infra"],
      ["scope-request", "scope request: f.txt"], ["gate-fail", "consult verdict: human — operator decides"]] as const) {
      const events = parkedJournal({ kind, ...(reason ? { reason } : {}) });
      expect(decide(events).decisions, `${kind} ${reason}`).toEqual([releaseOf(events, ENDED_PATH)]);
    }

    // Attempt-cap park, with or without commits ahead: kept with the exhausted budget and the fresh-budget
    // decision it admits; no work is read, so no battery and no attempt reset can follow.
    for (const commits of [2, 0]) {
      const cap = parkedJournal({ kind: "attempt-cap", reason: "attempt cap (10) reached" });
      const capToken = `${physicalLine(cap, parkIndex(cap))}@${cap[parkIndex(cap)]!.ts}`;
      const { decisions, reads } = decide(cap, { work: { T1: { head: HEAD, commits } } });
      expect(reads).toEqual([]);
      expect(decisions.map((d) => d.event)).toEqual([PARK_KEPT_EVENT]);
      expect(decisions[0]).toMatchObject({ hold: true });
      const why = String(decisions[0]!.data.reason);
      expect(why).toContain("attempt-cap park: its exhausted attempt budget");
      expect(why).toContain("fresh-budget approve decision");
      expect(why).toContain(`\`tickmarkr approve ${RUN} T1 --park ${capToken}\``);
    }

    // Human-gate park, including one written before any dispatch, whose loaded definition still sets humanGate:
    // kept and held, naming the gate and its approve command. D-2186 add.11: a changed definition that turns
    // humanGate off is the operator's release — no kept and no released row, so it dispatches as at the base.
    const gated = [loaded({ ...SPLIT, humanGate: true })];
    for (const dispatched of [true, false]) {
      const gate = parkedJournal({ kind: "human-gate", reason: "humanGate: \"T1\" requires approval before dispatch", dispatched });
      const { decisions, reads } = decide(gate, { tasks: gated });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ taskId: "T1", event: PARK_KEPT_EVENT, hold: true, data: { park: physicalLine(gate, parkIndex(gate)) } });
      const why = String(decisions[0]!.data.reason);
      expect(why).toContain("human-gate park: the spec's approval-before-dispatch gate");
      expect(why).toContain(`\`tickmarkr approve ${RUN} T1 --park ${physicalLine(gate, parkIndex(gate))}@${gate[parkIndex(gate)]!.ts}\``);
      expect(reads).toEqual([]);
      expect(decide(gate, { tasks: [AFTER] })).toEqual({ decisions: [], reads: [] });
    }

    // Controls. Definition unchanged: nothing. A files[]-only or definition-only change is a change.
    expect(decide(ended, { tasks: [BEFORE] }).decisions).toEqual([]);
    expect(decide(ended, { tasks: [loaded({ ...ORIGINAL, files: ["f.txt"] })] }).decisions.map((d) => d.event)).toEqual(["task-approved"]);
    expect(decide(ended, { tasks: [loaded({ ...ORIGINAL, goal: "T1, split" })] }).decisions.map((d) => d.event)).toEqual(["task-approved"]);
    // Not a graph-changed resume (no rehash on this launch): nothing.
    expect(decide(ended, { rehash: null })).toEqual({ decisions: [], reads: [] });
    // No open park — done, failed, dispatched (running) after the park, or never parked at all — nothing.
    const approved = (events: JournalEvent[]) => row("task-approved", "T1", { by: "op", via: "cli", park: binding(events, parkIndex(events)) });
    const done = parkedJournal(); done.splice(done.length - 2, 0, approved(done), row("task-dispatch", "T1", { attempt: 2, assignment: SEAT }), row("task-done", "T1", {}));
    const failedTask = parkedJournal({ after: [row("task-failed", "T1", { error: "boom" })] });
    const running = parkedJournal({ after: [row("task-dispatch", "T1", { attempt: 2, assignment: SEAT })] });
    for (const events of [done, failedTask, running]) expect(decide(events).decisions).toEqual([]);
    expect(decide(ended, { tasks: [AFTER, loaded(T("T2", { goal: "never dispatched" }))] }).decisions.map((d) => d.taskId)).toEqual(["T1"]);
    // A prior operator approval carried a ceiling: the release carries none, so the module default caps it.
    const prior = parkedJournal();
    const firstPark = prior.findIndex((e) => e.event === "task-dispatch") + 2;
    prior.splice(firstPark, 0, row("task-human", "T1", { kind: "gate-fail", reason: "review red", definition: parkDefinition(BEFORE) }));
    prior.splice(firstPark + 1, 0, row("task-approved", "T1", { by: "op", via: "cli", release: "review-upheld", gate: "review", reviewRoundCeiling: 1, park: binding(prior, firstPark) }));
    const ceilingless = decide(prior).decisions;
    expect(ceilingless).toEqual([releaseOf(prior, ENDED_PATH)]);
    expect(ceilingless[0]!.data).not.toHaveProperty("reviewRoundCeiling");
  });
});

// ---- runDaemon: the captured shapes -----------------------------------------------------------------------
const SCRIPT = {
  review: { approve: false, issues: ["f.txt: the guard is still missing"] },
  consult: { action: "retry", notes: "a review round never consults" },
  tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
};

/** Runs a daemon and delivers SIGTERM to ITS handler, synchronously, at the first row `at` matches. */
async function terminatedAt(repo: string, opts: RunOptions, at: (e: JournalEvent) => boolean): Promise<void> {
  const before = new Set(process.listeners("SIGTERM"));
  let exited!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => { exited = resolve; });
  let fired = false;
  const run = runDaemon(repo, { ...opts, exit: exited, narrate: (e) => {
    if (fired || !at(e)) return;
    fired = true;
    (process.listeners("SIGTERM").find((listener) => !before.has(listener)) as (signal: string) => void)("SIGTERM");
  } });
  await expect(run).rejects.toThrow(/terminated by SIGTERM/);
  expect(await exitCode).toBe(143);
}

interface Captured {
  repo: string; runId: string; scriptPath: string; events: JournalEvent[]; park: JournalEvent; parkLine: number; head: string;
  rehashAt: number; releaseAt: number; release: JournalEvent; parkedOneline: string;
}

/** One review-cap park stopped by a run-end (worktree removed) or by a SIGTERM inside the approval window,
 * then the split recompiled and a graph-changed resume (killed right after its release row for "dies"). */
async function captured(stop: "ended" | "stopped" | "dies"): Promise<Captured> {
  const { repo, scriptPath } = setupRepo([ORIGINAL], SCRIPT);
  const runId = `run-split-${stop}`;
  const fake = () => new FakeAdapter(scriptPath);
  if (stop === "stopped") {
    await terminatedAt(repo, { adapters: [fake()], runId, approvalWindowMs: 60_000 }, (e) => e.event === "approval-window-start");
  } else {
    expect((await runDaemon(repo, { adapters: [fake()], runId })).human).toEqual(["T1"]);
  }
  const parked = rows(repo, runId);
  const parkAt = parkIndex(parked);
  const park = parked[parkAt]!;
  expect(park.data.reason).toMatch(/^review round cap \(2\) reached this engagement/);
  expect(park.data.definition).toEqual(parkDefinition(BEFORE));
  const after = parked.slice(parkAt + 1).map((e) => e.event);
  const removal = parked.slice(parkAt + 1).find((e) => e.event === "worktree-removed" && e.data.task === "T1");
  let head: string;
  if (stop === "stopped") {
    expect(after).toContain("exit-cause");
    expect(after).not.toContain("run-end");
    expect(removal).toBeUndefined();
    head = await gitHead(worktreePath(repo, `tickmarkr/${runId}--T1`));
  } else {
    expect(after).toEqual(expect.arrayContaining(["approval-window-start", "approval-window-expired", "run-end"]));
    expect(removal?.data.ref).toMatch(/^refs\/tickmarkr\/preserved\//);
    head = String(removal!.data.head);
  }
  const parkedOneline = await status([runId, "--oneline"], repo);
  recompile(repo, [SPLIT]);
  if (stop === "dies") {
    await terminatedAt(repo, { adapters: [fake()], runId, resume: true, graphChanged: true }, (e) => e.event === "task-approved" && e.data.via === "resume");
  } else {
    expect((await runDaemon(repo, { adapters: [fake()], runId, resume: true, graphChanged: true })).human).toEqual(["T1"]);
  }
  const events = rows(repo, runId);
  const rehashAt = events.findIndex((e) => e.event === "graph-rehash");
  const releaseAt = events.findIndex((e, i) => i > rehashAt && e.event === "task-approved" && e.taskId === "T1");
  expect(rehashAt).toBeGreaterThan(parkAt);
  expect(releaseAt).toBeGreaterThan(rehashAt);
  return { repo, runId, scriptPath, events, park, parkLine: parkAt + 1, head, rehashAt, releaseAt, release: events[releaseAt]!, parkedOneline };
}
let endedRun: Promise<Captured> | undefined;
const endedPath = () => (endedRun ??= captured("ended"));

/** The release row, the no-worker battery at the parked head, and the repair its first review red funds. */
function assertReleasedAndRegated(c: Captured, path: string): void {
  const { events, release, releaseAt, rehashAt } = c;
  expect(release.data).toEqual({
    by: "resume --graph-changed", via: "resume", release: "recheck", park: { line: c.parkLine, ts: c.park.ts },
    engagement: {
      cause: "graph-changed", rehash: { from: events[rehashAt]!.data.from, to: events[rehashAt]!.data.to },
      from: parkDefinition(BEFORE), to: parkDefinition(AFTER), path, head: c.head,
    },
  });
  // The same resume enacts it: no task-human at the resume, no worker before the battery gates the head.
  const t1 = events.map((e, i) => ({ e, i })).filter(({ e }) => e.taskId === "T1");
  const batteryAt = t1.find(({ e, i }) => i > releaseAt && e.event === "recheck-battery")!.i;
  const window = t1.filter(({ i }) => i > rehashAt && i < batteryAt).map(({ e }) => e);
  expect(window.filter((e) => ["task-human", "worker-launch", "task-dispatch"].includes(e.event))).toEqual([]);
  expect(window.filter((e) => e.event === "worktree-recreation")).toHaveLength(1);
  const regated = window.filter((e) => e.event === "gate-result" && e.data.gate === "review");
  expect(regated.map((e) => e.data.pass)).toEqual([false]);
  expect(events[batteryAt]!.data.pass).toBe(false);
  // The round counter restarts at the release: exhausted (2 of 2) before it, zero at it.
  expect(reviewRoundsSinceApproval(events.slice(0, releaseAt), "T1")).toBe(2);
  expect(reviewRoundsSinceApproval(events.slice(0, releaseAt + 1), "T1")).toBe(0);
  // The first review red funds a repair round under the ordinary ladder — a dispatch, never the cap park.
  const next = t1.filter(({ i }) => i > batteryAt).map(({ e }) => e);
  expect(next.find((e) => e.event === "task-dispatch" || e.event === "task-human")?.event).toBe("task-dispatch");
  expect(next.some((e) => e.event === "worker-launch")).toBe(true);
  // Whatever the ordinary ladder parks on next, that park records the definition the daemon now holds.
  const repark = next.find((e) => e.event === "task-human");
  if (repark) expect(repark.data.definition).toEqual(parkDefinition(AFTER));
}

describe("row 372 — a graph-changed resume releases the parked task on both stop paths", () => {
  test("the captured ended path releases the review cap park at the graph changed resume and re-gates the preserved head with no worker and a reset round counter so the first review red funds a repair", async () => {
    const c = await endedPath();
    assertReleasedAndRegated(c, ENDED_PATH);
    // the checkout the run-end removed is rebuilt from its removal row at the preserved head
    const recreation = c.events.find((e, i) => i > c.releaseAt && e.taskId === "T1" && e.event === "worktree-recreation")!;
    expect(recreation.data.rebuiltFrom).toBe("removal");
    expect(rail(c.release, c.runId)).toContain(`released the park at journal line ${c.parkLine} — ${ENDED_PATH} — re-gating its head ${c.head.slice(0, 12)}`);
  }, 300_000);

  test("the captured stopped path inside the approval window releases the same way and the two paths differ only in the path field and the rail sentence", async () => {
    const stopped = await captured("stopped");
    assertReleasedAndRegated(stopped, STOPPED_PATH);
    const ended = await endedPath();
    // The two shapes come from one fixture that differs only in how the run stopped. Fixture data (the
    // park's line and time, the head's hash) aside, the release rows differ only in their path field ...
    const shape = (c: Captured) => {
      const engagement = c.release.data.engagement as Record<string, unknown>;
      return { ...c.release.data, park: "<park>", engagement: { ...engagement, path: "<path>", head: "<head>" } };
    };
    expect(shape(stopped)).toEqual(shape(ended));
    expect([(stopped.release.data.engagement as { path: string }).path, (ended.release.data.engagement as { path: string }).path]).toEqual([STOPPED_PATH, ENDED_PATH]);
    // ... their rail rows only in the path sentence ...
    const sentence = (c: Captured) => rail(c.release, c.runId).replace(String(c.parkLine), "<line>").replace(c.head.slice(0, 12), "<head>");
    expect(sentence(stopped).replace(STOPPED_PATH, "<path>")).toBe(sentence(ended).replace(ENDED_PATH, "<path>"));
    expect(sentence(stopped)).toContain(STOPPED_PATH);
    // ... and the rows after the rehash, up to the repair the first red funds, are the same rows.
    const sequence = (c: Captured) => {
      const t1 = c.events.slice(c.rehashAt).filter((e) => e.taskId === "T1" && !NOISE.has(e.event)).map((e) => e.event);
      return t1.slice(0, t1.indexOf("task-dispatch") + 1);
    };
    expect(sequence(stopped)).toEqual(sequence(ended));
    expect(sequence(stopped)).toEqual(expect.arrayContaining(["task-approved", "worktree-recreation", "recheck-battery", "task-dispatch"]));
  }, 600_000);

  test("from the release row status the wait snapshot and the operator fold show no released park while the rail names each released or kept park with its journal line and its next step", async () => {
    // The daemon dies right after its release row: the journal ends AT the release row.
    const c = await captured("dies");
    const token = `${c.parkLine}@${c.park.ts}`;
    expect(c.events.slice(c.releaseAt + 1).filter((e) => e.taskId === "T1")).toEqual([]);
    expect(c.parkedOneline).toContain("1 parked"); // the park was projected before the release
    // the operator fold: parked before the release row, not parked from it on
    const fold = (events: JournalEvent[]) => readOperatorState({ events }).tasks.find((t) => t.id === "T1")!;
    expect(fold(c.events.slice(0, c.releaseAt))).toMatchObject({ state: "human", parkKind: "gate-fail" });
    expect(fold(c.events.slice(0, c.releaseAt + 1))).toMatchObject({ state: "pending", parkKind: undefined });
    // status, plain, oneline and JSON: no park, no needs-you count for it, no command of the released park
    const json = JSON.parse(await status([c.runId, "--json"], c.repo)) as { parks: { taskId: string }[]; tasks: { id: string; state: string }[] };
    expect(json.parks).toEqual([]);
    expect(json.tasks.find((t) => t.id === "T1")?.state).not.toBe("human");
    const oneline = await status([c.runId, "--oneline"], c.repo);
    expect(oneline).toContain("0 parked");
    const board = plain(await status([c.runId], c.repo));
    expect(board).toContain("0 parked");
    for (const out of [JSON.stringify(json), oneline, board]) expect(out).not.toContain(token);
    // the wait snapshot
    const seat = process.env.TICKMARKR_SEAT;
    delete process.env.TICKMARKR_SEAT; // a seat's wait returns before any snapshot (queue row 371)
    try {
      const waited = JSON.parse((await wait([c.runId, "--json", "--timeout", "0s"], c.repo, { sleep: async () => {} })).out) as
        { snapshot: { parks: unknown[]; tasks: { id: string; state: string }[] } };
      expect(waited.snapshot.parks).toEqual([]);
      expect(waited.snapshot.tasks.find((t) => t.id === "T1")?.state).toBe("pending");
    } finally {
      if (seat === undefined) delete process.env.TICKMARKR_SEAT; else process.env.TICKMARKR_SEAT = seat;
    }
    // the released park is consumed: approve refuses it, as for any consumed park
    await expect(approve([c.runId, "T1", "--uphold", "--park", token], c.repo)).rejects.toThrow(/not a parked human gate/);
    expect(rows(c.repo, c.runId)).toHaveLength(c.events.length);
    // the rail names the released park with its journal line, its stop path and its next step
    expect(rail(c.release, c.runId)).toContain(`T1 released — released the park at journal line ${c.parkLine} — ${ENDED_PATH} — re-gating its head ${c.head.slice(0, 12)}`);
    // A later resume enacts the pending release; on a now-comparable graph it journals no rehash and decides nothing.
    await runDaemon(c.repo, { adapters: [new FakeAdapter(c.scriptPath)], runId: c.runId, resume: true, graphChanged: true });
    const all = rows(c.repo, c.runId);
    const lastResume = all.map((e) => e.event).lastIndexOf("run-resume");
    expect(all.filter((e) => e.event === "graph-rehash")).toHaveLength(1);
    expect(all.filter((e) => e.event === "task-approved" && e.data.via === "resume")).toHaveLength(1);
    expect(all.filter((e) => e.event === PARK_KEPT_EVENT)).toEqual([]);
    expect(all.slice(lastResume).some((e) => e.taskId === "T1" && e.event === "recheck-battery")).toBe(true);

    // Kept parks and a plain release, through runDaemon: an attempt-cap park, a human-gate park whose recompile
    // keeps humanGate (status pending), a park with no definition record, a stall park with no commits, and a
    // human-gate park whose recompile drops humanGate (D-2186 add.11: no row, dispatched as at the base).
    const k = await keptScenario();
    const kept = (id: string) => k.events.find((e) => e.event === PARK_KEPT_EVENT && e.taskId === id)!;
    for (const id of ["T2", "T3", "T4"]) {
      expect(kept(id).data.park).toBe(k.parks[id]!.line);
      expect(rail(kept(id), k.runId)).toContain(`${id} park kept — park at journal line ${k.parks[id]!.line} kept`);
    }
    expect(rail(kept("T2"), k.runId)).toContain(`exhausted attempt budget is refilled only by the operator's fresh-budget approve decision`);
    expect(rail(kept("T2"), k.runId)).toContain(`\`tickmarkr approve ${k.runId} T2 --park ${k.parks.T2!.token}\``);
    expect(rail(kept("T3"), k.runId)).toContain("human-gate park");
    expect(rail(kept("T3"), k.runId)).toContain(`\`tickmarkr approve ${k.runId} T3 --park ${k.parks.T3!.token}\``);
    expect(rail(kept("T4"), k.runId)).toContain("the definition at park is unrecorded");
    const plainRelease = k.events.find((e) => e.event === "task-approved" && e.taskId === "T5")!;
    expect(plainRelease.data).not.toHaveProperty("release");
    expect(rail(plainRelease, k.runId)).toContain(`T5 released — released the park at journal line ${k.parks.T5!.line} — ${ENDED_PATH} — dispatching a fresh worker`);
    expect(k.events.filter((e) => e.event === "task-approved" && ["T2", "T3", "T4"].includes(e.taskId!))).toEqual([]);
    const resumed = k.events.slice(k.resumeAt);
    // attempt-cap: held parked, so the resume schedules it nowhere — no worker, no battery, no attempt reset,
    // no re-park; it keeps its original park and its kept row is its only row this resume
    expect(resumed.filter((e) => e.taskId === "T2").map((e) => e.event)).toEqual([PARK_KEPT_EVENT]);
    expect(loadGraph(k.repo).tasks.find((t) => t.id === "T2")?.status).toBe("human");
    // human-gate: the recompile kept humanGate and wrote it pending — held parked until that approval: no dispatch,
    // no worker, no second park from execTask's guard; its original park stays projected
    expect(loadGraph(k.repo).tasks.find((t) => t.id === "T3")?.humanGate).toBe(true);
    expect(resumed.filter((e) => e.taskId === "T3").map((e) => e.event)).toEqual([PARK_KEPT_EVENT]);
    expect(loadGraph(k.repo).tasks.find((t) => t.id === "T3")?.status).toBe("human");
    // D-2186 add.11: the recompile turned T6's humanGate off — neither kept nor released; it dispatches as at the base
    expect(resumed.filter((e) => e.taskId === "T6" && (e.event === PARK_KEPT_EVENT || e.event === "task-approved"))).toEqual([]);
    expect(resumed.some((e) => e.taskId === "T6" && e.event === "task-dispatch")).toBe(true);
    expect(resumed.some((e) => e.taskId === "T6" && e.event === "task-done")).toBe(true);
    expect(loadGraph(k.repo).tasks.find((t) => t.id === "T6")?.status).toBe("done");
    // the plain release dispatched a fresh worker under the new engagement
    expect(resumed.some((e) => e.taskId === "T5" && e.event === "worker-launch")).toBe(true);
    expect(resumed.some((e) => e.taskId === "T5" && e.event === "task-done")).toBe(true);
    // a kept park stays projected; the released one does not
    const after = JSON.parse(await status([k.runId, "--json"], k.repo)) as { parks: { taskId: string }[] };
    expect(after.parks.map((p) => p.taskId).sort()).toEqual(expect.arrayContaining(["T2", "T3"]));
    expect(after.parks.map((p) => p.taskId)).not.toContain("T5");
    expect(after.parks.map((p) => p.taskId)).not.toContain("T6");
    expect((after.parks as { taskId: string; token: string | null }[]).find((p) => p.taskId === "T3")?.token).toBe(k.parks.T3!.token);
  }, 600_000);
});

/** Seeded parks for the kept rows and the plain release, then a recompile that changes each definition. */
async function keptScenario() {
  const before = [
    T("T2", { goal: "capped", acceptance: [{ oracle: "command", command: "true" }] }),
    T("T3", { goal: "gated", humanGate: true, acceptance: [{ oracle: "command", command: "true" }] }),
    T("T4", { goal: "legacy park", acceptance: [{ oracle: "command", command: "true" }] }),
    T("T5", { goal: "stalled", acceptance: [{ oracle: "command", command: "true" }] }),
    T("T6", { goal: "gated, then released by the operator", humanGate: true, acceptance: [{ oracle: "command", command: "true" }] }),
  ];
  const { repo, scriptPath } = setupRepo(before, {
    tasks: Object.fromEntries(["T2", "T3", "T4", "T5", "T6"].map((id) => [id, [{ shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } }]])),
  });
  const runId = "run-split-kept";
  const definition = (id: string) => parkDefinition(loadGraph(repo).tasks.find((t) => t.id === id)!);
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { baseRef: await gitHead(repo), branch: `tickmarkr/${runId}`, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  for (let attempt = 0; attempt < 10; attempt++) journal.append("task-dispatch", "T2", { assignment: SEAT, attempt });
  journal.append("task-human", "T2", { kind: "attempt-cap", reason: "attempt cap (10) reached", definition: definition("T2") });
  journal.append("task-human", "T3", { kind: "human-gate", reason: "humanGate: \"T3\" requires approval before dispatch", definition: definition("T3") });
  journal.append("task-human", "T4", { kind: "infra", reason: "runner infra (a park written before definition records)" });
  journal.append("task-dispatch", "T5", { assignment: SEAT, attempt: 0 });
  journal.append("task-human", "T5", { kind: "stall", reason: "worker stalled with nothing committed", definition: definition("T5") });
  journal.append("task-human", "T6", { kind: "human-gate", reason: "humanGate: \"T6\" requires approval before dispatch", definition: definition("T6") });
  journal.append("run-end", undefined, { done: [], failed: [], human: ["T2", "T3", "T4", "T5", "T6"], blocked: [], pending: [] });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  const seeded = journal.read();
  const parks = Object.fromEntries(["T2", "T3", "T4", "T5"].map((id) => {
    const i = parkIndex(seeded, id);
    return [id, { line: physicalLine(seeded, i), token: `${physicalLine(seeded, i)}@${seeded[i]!.ts}` }];
  }));
  // every recompile writes each task pending; T3 keeps its humanGate (D-2186 add.7), T6's drops it (add.11)
  recompile(repo, before.map((t) => ({ ...t, goal: `${String(t.goal)}, split`, files: [`${String(t.id)}.txt`], ...(t.id === "T6" ? { humanGate: false } : {}) })));
  await runDaemon(repo, { adapters: [new FakeAdapter(scriptPath)], runId, resume: true, graphChanged: true });
  const events = rows(repo, runId);
  return { repo, runId, events, parks, resumeAt: events.findIndex((e) => e.event === "run-resume") };
}

// ---- runDaemon: the waiver cells ---------------------------------------------------------------------------
class Counting extends FakeAdapter {
  judges = 0;
  reviews = 0;
  override headlessCommand(file: string, model: string): string {
    const prompt = readFileSync(file, "utf8");
    if (prompt.startsWith("TICKMARKR-JUDGE")) this.judges++;
    if (prompt.startsWith("TICKMARKR-REVIEW")) this.reviews++;
    return super.headlessCommand(file, model);
  }
}

/** An older waiver of `gate` on the parked subject, then a park, then either a definition change and a
 * graph-changed resume, or an ordinary operator recheck. Returns the real judge and reviewer calls after. */
async function waiverCell(gate: "acceptance" | "review", graphChanged: boolean) {
  const task = (over: Record<string, unknown> = {}) => T("T1", {
    complexity: 8, files: ["work.ts"], gates: [...GATE_NAMES],
    acceptance: gate === "acceptance" ? ["work.ts exports the value"] : [{ oracle: "command", command: "true" }], ...over,
  });
  const { repo, scriptPath } = setupRepo([task()], { tasks: {} });
  const runId = `run-split-waiver-${gate}-${graphChanged ? "graph" : "recheck"}`;
  const baseRef = await gitHead(repo);
  const branch = `tickmarkr/${runId}`;
  git(repo, "branch", branch, baseRef);
  const wt = await createWorktree(repo, `${branch}--T1`, baseRef);
  writeFileSync(join(wt, "work.ts"), "export const value = 1;\n");
  git(wt, "add", "work.ts");
  git(wt, "commit", "--no-gpg-sign", "-m", "work");
  const subject = createHash("sha256").update(execFileSync("git", ["log", "--reverse",
    "--format=%T%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e", `${baseRef}..HEAD`], { cwd: wt, encoding: "utf8" })).digest("hex");
  const definition = parkDefinition(loadGraph(repo).tasks[0]!);
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { baseRef, branch, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  journal.append("task-dispatch", "T1", { assignment: SEAT, attempt: 0 });
  journal.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [] });
  journal.append("gate-result", "T1", { gate, pass: false, commit: subject, details: "operator disputes this verdict" });
  journal.append("task-human", "T1", { kind: "gate-fail", reason: `${gate} red`, definition });
  await approve([runId, "T1", "--waive"], repo); // the older waiver, on this very subject
  journal.append("worktree-recreation", "T1", {});
  if (gate === "acceptance") {
    journal.append("gate-result", "T1", { gate: "review", pass: false, commit: subject, details: "work.ts: the guard is missing" });
    journal.append("task-human", "T1", { kind: "gate-fail", reason: "review round cap (2) reached this engagement", definition });
  } else {
    journal.append("task-human", "T1", { kind: "infra", reason: "environment unavailable after waiver", definition });
  }
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  if (graphChanged) recompile(repo, [task(gate === "acceptance" ? { acceptance: ["work.ts exports the value under its new name"] } : { goal: "T1, split" })]);
  else await approve([runId, "T1", "--recheck"], repo);
  const fake = new Counting(scriptPath);
  const before = journal.read().length;
  const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true, ...(graphChanged ? { graphChanged: true } : {}) });
  const after = journal.read().slice(before).filter((e) => e.taskId === "T1");
  return { summary, after, judges: fake.judges, reviews: fake.reviews, subject };
}

describe("row 372 — a graph-change engagement gates acceptance and review fresh", () => {
  test("a graph changed engagement calls the judge and the reviewer fresh despite an older waiver on the same subject while an ordinary recheck still carries that waiver", async () => {
    const carried = (after: JournalEvent[]) => after.filter((e) => e.event === "gate-waiver-carried").map((e) => e.data);
    const verdicts = (after: JournalEvent[], gate: string) => after.filter((e) => e.event === "gate-result" && e.data.gate === gate).map((e) => e.data.pass);

    // acceptance waiver, then a review-cap park, a definition change and a graph-changed resume: the judge runs
    const acceptance = await waiverCell("acceptance", true);
    const release = acceptance.after.find((e) => e.event === "task-approved")!;
    expect((release.data.engagement as { cause: string }).cause).toBe("graph-changed");
    expect(release.data.release).toBe("recheck");
    expect(acceptance.judges).toBeGreaterThanOrEqual(1);
    expect(acceptance.reviews).toBeGreaterThanOrEqual(1);
    expect(verdicts(acceptance.after, "acceptance")).toEqual([true]); // the fresh verdict decides acceptance
    expect(carried(acceptance.after)).toEqual([]);
    expect(acceptance.summary.done).toEqual(["T1"]);
    // review waiver, then a park, a definition change and a graph-changed resume: the reviewer runs
    const review = await waiverCell("review", true);
    expect(review.reviews).toBeGreaterThanOrEqual(1);
    expect(verdicts(review.after, "review")).toEqual([true]);
    expect(carried(review.after)).toEqual([]);
    expect(review.summary.done).toEqual(["T1"]);

    // controls: an ordinary operator recheck after the same older waiver carries it exactly as at the base
    const acceptanceControl = await waiverCell("acceptance", false);
    expect(acceptanceControl.judges).toBe(0);
    expect(verdicts(acceptanceControl.after, "acceptance")).toEqual([]);
    expect(carried(acceptanceControl.after)).toEqual([{ gate: "acceptance", commit: acceptanceControl.subject, carried: true, release: "recheck" }]);
    const reviewControl = await waiverCell("review", false);
    expect(reviewControl.reviews).toBe(0);
    expect(verdicts(reviewControl.after, "review")).toEqual([]);
    expect(carried(reviewControl.after)).toEqual([{ gate: "review", commit: reviewControl.subject, carried: true, release: "recheck" }]);
  }, 600_000);
});

// ---- runDaemon: what a release may never be built on ------------------------------------------------------
/** A stopped run (SIGTERM, no run-end) holding, each with a changed definition: eight parks whose work cannot
 * be read (a checkout whose HEAD read throws, an unrelated repository at the checkout path, a removal head that
 * resolves nowhere with no task branch, a journaled preserved ref that resolves nowhere, and the bounded class of
 * checkouts that are not the task's own linked worktree at its branch tip over a surviving task branch with
 * committed work: a missing .git, a .git redirected to the main git dir or to a sibling worktree's record, and a
 * HEAD detached back to the base — D-2186 add.14), a park whose work survives
 * only under a journaled preserved ref, a stall park that recorded a reapFailure over committed work, and an
 * attempt-cap park over committed work its current attempt already gated. The unreadable ones depend on the
 * capped task, so their base behaviour never schedules them while it stays parked. */
async function unreadableScenario() {
  const R = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"];
  const before = [
    T("C1", { goal: "capped with work", files: ["C1.txt"], acceptance: [{ oracle: "command", command: "true" }] }),
    T("P1", { goal: "preserved only", files: ["P1.txt"], acceptance: [{ oracle: "command", command: "true" }] }),
    T("S1", { goal: "stalled unreaped", files: ["S1.txt"], acceptance: [{ oracle: "command", command: "true" }] }),
    ...R.map((id) => T(id, { goal: `unreadable ${id}`, deps: ["C1"], acceptance: [{ oracle: "command", command: "true" }] })),
  ];
  const { repo, scriptPath } = setupRepo(before, { tasks: Object.fromEntries([...R, "C1", "S1", "P1"].map((id) =>
    [id, [{ shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } }]])) });
  const runId = "run-split-unreadable";
  const baseRef = await gitHead(repo);
  const branch = `tickmarkr/${runId}`;
  git(repo, "branch", branch, baseRef);
  const committed = async (id: string) => {
    const wt = await createWorktree(repo, `${branch}--${id}`, baseRef);
    writeFileSync(join(wt, `${id}.txt`), `${id}\n`);
    git(wt, "add", `${id}.txt`);
    git(wt, "commit", "--no-gpg-sign", "-m", id);
    return createHash("sha256").update(execFileSync("git", ["log", "--reverse",
      "--format=%T%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e", `${baseRef}..HEAD`], { cwd: wt, encoding: "utf8" })).digest("hex");
  };
  const capSubject = await committed("C1");
  await committed("S1");
  // P1: its work survives only under a journaled preserved ref — the checkout, the task branch and any
  // removal row are gone. R4: its only journaled preserved ref resolves to no object.
  await committed("P1");
  const p1 = worktreePath(repo, `${branch}--P1`);
  const p1Head = await gitHead(p1);
  const p1Ref = `refs/tickmarkr/preserved/${p1Head}`;
  git(repo, "update-ref", p1Ref, p1Head);
  git(repo, "worktree", "remove", "--force", p1);
  git(repo, "branch", "-D", `${branch}--P1`);
  const r4Ref = `refs/tickmarkr/preserved/${"e".repeat(40)}`;
  // R5: the checkout's .git file is missing, so Git discovery reaches the parent repository and its base HEAD.
  // R6: the checkout's .git redirects to the repository's own git dir, so HEAD reads the main checkout's. Both
  // keep a task branch holding committed work, so a read that trusted either HEAD would prove zero commits.
  await committed("R5");
  unlinkSync(join(worktreePath(repo, `${branch}--R5`), ".git"));
  await committed("R6");
  writeFileSync(join(worktreePath(repo, `${branch}--R6`), ".git"), `gitdir: ${git(repo, "rev-parse", "--absolute-git-dir")}\n`);
  // R7: the checkout's .git redirects to a SIBLING linked worktree's admin record, detached at the task base — Git
  // resolves a linked worktree of this repository rooted at the checkout path, but its HEAD is the sibling's.
  // R8: the task's own linked worktree with its HEAD detached back to the task base. Both keep a task branch
  // holding committed work, so a read that trusted either checkout's HEAD would prove zero commits.
  await committed("R7");
  const sibling = join(makeTestTempDir("tickmarkr-split-sibling-"), "wt");
  git(repo, "worktree", "add", "-q", "--detach", sibling, baseRef);
  writeFileSync(join(worktreePath(repo, `${branch}--R7`), ".git"), `gitdir: ${git(sibling, "rev-parse", "--absolute-git-dir")}\n`);
  await committed("R8");
  git(worktreePath(repo, `${branch}--R8`), "checkout", "-q", "--detach", baseRef);
  // R1: a checkout whose HEAD read throws. R2: an unrelated repository at the checkout path, which holds no
  // base object. R3: no checkout and no task branch, and
  // the removal row's recorded head resolves to no object.
  const r1 = worktreePath(repo, `${branch}--R1`);
  mkdirSync(r1, { recursive: true });
  writeFileSync(join(r1, ".git"), "gitdir: /nonexistent/tickmarkr-row-372\n");
  const r2 = worktreePath(repo, `${branch}--R2`);
  mkdirSync(r2, { recursive: true });
  git(r2, "init", "-q");
  writeFileSync(join(r2, "R2.txt"), "unrelated\n");
  git(r2, "add", "R2.txt");
  git(r2, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--no-gpg-sign", "-qm", "unrelated");
  const lost = "d".repeat(40);
  const definition = (id: string) => parkDefinition(loadGraph(repo).tasks.find((t) => t.id === id)!);
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { baseRef, branch, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  for (let attempt = 0; attempt < 10; attempt++) journal.append("task-dispatch", "C1", { assignment: SEAT, attempt });
  journal.append("worker-result", "C1", { ok: true, summary: "landed", deviations: [] });
  for (const gate of ["evidence", "scope", "acceptance"]) journal.append("gate-result", "C1", { gate, pass: true, commit: capSubject });
  journal.append("task-human", "C1", { kind: "attempt-cap", reason: "attempt cap (10) reached", definition: definition("C1") });
  journal.append("task-dispatch", "S1", { assignment: SEAT, attempt: 0 });
  const reapFailure = "worker group 4242 census unreadable";
  journal.append("task-human", "S1", { kind: "stall", reason: `worker could not be reaped before harvest: ${reapFailure}`, reapFailure, definition: definition("S1") });
  for (const id of [...R, "P1"]) {
    journal.append("task-dispatch", id, { assignment: SEAT, attempt: 0 });
    if (id === "P1" || id === "R4") journal.append("worktree-preserved", id, { ref: id === "P1" ? p1Ref : r4Ref });
    journal.append("task-human", id, { kind: "infra", reason: "runner infra", definition: definition(id) });
  }
  journal.append("worktree-removed", undefined, { task: "R3", dir: worktreePath(repo, `${branch}--R3`), head: lost, ref: `refs/tickmarkr/preserved/${lost}`, by: "run-end" });
  journal.append("exit-cause", undefined, { cause: "deliberate", signal: "SIGTERM" });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  const seeded = journal.read();
  const parks = Object.fromEntries([...R, "C1", "S1", "P1"].map((id) => [id, physicalLine(seeded, parkIndex(seeded, id))]));
  recompile(repo, before.map((t) => ({ ...t, goal: `${String(t.goal)}, split` })));
  const summary = await runDaemon(repo, { adapters: [new FakeAdapter(scriptPath)], runId, resume: true, graphChanged: true });
  const events = rows(repo, runId);
  return { repo, runId, baseRef, summary, events, parks, reapFailure, p1Head, p1Ref, r4Ref, resumeAt: events.findIndex((e) => e.event === "run-resume") };
}

describe("row 372 — a release is built only on proven work, through the existing guards", () => {
  test("a graph changed resume keeps every park whose work read fails, recovers work held only under a preserved ref, carries a stall park's reap failure into the census guard and schedules no attempt cap park", async () => {
    const u = await unreadableScenario();
    const resumed = u.events.slice(u.resumeAt);
    const of = (id: string) => resumed.filter((e) => e.taskId === id);
    const kept = (id: string) => of(id).filter((e) => e.event === PARK_KEPT_EVENT);
    // Every unreadable read keeps its park with one kept row naming the failure; none is approved.
    const notItself = "not this task's own linked worktree at its branch";
    for (const [id, failure] of [["R1", "cannot read the task checkout"], ["R2", notItself], ["R3", "does not resolve"],
      ["R4", `the preserved ref ${u.r4Ref} does not resolve`], ["R5", notItself], ["R6", notItself], ["R7", notItself], ["R8", notItself]] as const) {
      expect(kept(id).map((e) => e.data.park), id).toEqual([u.parks[id]]);
      expect(String(kept(id)[0]!.data.reason), id).toContain("reading the task work failed (");
      expect(String(kept(id)[0]!.data.reason), id).toContain(failure);
      expect(of(id).filter((e) => e.event === "task-approved"), id).toEqual([]);
    }
    // R5–R8 hold committed work on their surviving task branches: none may read its checkout's HEAD as no commits (a
    // plain release funding a worker), so each keeps its park and the branch keeps its commit (D-2186 add.14).
    for (const id of ["R5", "R6", "R7", "R8"]) {
      expect(String(kept(id)[0]!.data.reason), id).toContain("cannot read the task checkout");
      expect(git(u.repo, "rev-list", "--count", `${u.baseRef}..tickmarkr/${u.runId}--${id}`), id).toBe("1");
    }
    // Work held only under a journaled preserved ref is recovered, not read as no commits: a recheck release
    // naming that ref, whose battery gates its head with no worker and carries its commit.
    const p1Release = of("P1").find((e) => e.event === "task-approved")!;
    expect(p1Release.data).toMatchObject({ release: "recheck", recheckedRef: u.p1Ref, engagement: { head: u.p1Head } });
    expect(of("P1").filter((e) => e.event === "worker-launch" || e.event === "task-dispatch")).toEqual([]);
    expect(of("P1").find((e) => e.event === "worktree-recreation")?.data).toMatchObject({ attempted: [u.p1Head] });
    expect(of("P1").find((e) => e.event === "recheck-battery")?.data.pass).toBe(true);
    // The stall park's recheck carries its reapFailure, so the census guard runs before any gate: with no
    // recorded launch ownership it re-parks the stall, and nothing reads or gates the tree.
    const release = of("S1").find((e) => e.event === "task-approved")!;
    const afterRelease = of("S1").slice(of("S1").indexOf(release) + 1);
    expect(afterRelease.filter((e) => ["gate-result", "recheck-battery", "worker-launch", "worktree-recreation"].includes(e.event))).toEqual([]);
    expect(afterRelease.find((e) => e.event === "task-human")?.data).toMatchObject({
      kind: "stall", reason: "worker could not be reaped before recheck: the parked attempt recorded no launch ownership evidence" });
    expect(release.data).toMatchObject({ release: "recheck", reapFailure: u.reapFailure, park: { line: u.parks.S1 } });
    // The attempt-cap park over gated work stays parked: its kept row, and no gate replay, battery, worker or merge.
    // (the run-end's cleanup preserving its parked checkout, as at the base, is its only other row)
    expect(of("C1").map((e) => e.event).filter((e) => e !== "worktree-preserved")).toEqual([PARK_KEPT_EVENT]);
    expect(String(kept("C1")[0]!.data.reason)).toContain("attempt-cap park");
    expect(u.summary.done).toEqual(["P1"]);
    expect(u.summary.human).toEqual(expect.arrayContaining(["C1", "S1"]));
    expect(loadGraph(u.repo).tasks.find((t) => t.id === "C1")?.status).toBe("human");
    const parked = JSON.parse(await status([u.runId, "--json"], u.repo)) as { parks: { taskId: string }[] };
    expect(parked.parks.map((p) => p.taskId)).toEqual(expect.arrayContaining(["C1", "S1"]));
  }, 300_000);
});

// ---- runDaemon: the scope-amendment replay's rehash is this launch's rehash -------------------------------
/** A review-cap park beside a sibling whose scope-request the operator granted, then a recompile that changes
 * the parked task and drops the materialized amendment. The resume's scope-amendment replay journals the only
 * rehash of this launch and leaves the loaded graph comparable, so no comparison rehash follows it. */
async function amendmentScenario() {
  const before = [
    T("T1", { goal: "parked on review", files: ["T1.txt"], acceptance: [{ oracle: "command", command: "true" }] }),
    T("W1", { goal: "sibling widened", files: ["W1.txt"], acceptance: [{ oracle: "command", command: "true" }] }),
  ];
  const { repo, scriptPath } = setupRepo(before, { tasks: {
    T1: [{ shell: `echo T1 >> T1.txt && ${COMMIT} T1`, result: { ok: true, summary: "T1" } }],
    W1: [{ shell: `echo W1 > W1.txt && echo W1 > W1b.txt && ${COMMIT} W1`, result: { ok: true, summary: "W1" } }],
  } });
  const runId = "run-split-amended";
  const baseRef = await gitHead(repo);
  const branch = `tickmarkr/${runId}`;
  git(repo, "branch", branch, baseRef);
  const wt = await createWorktree(repo, `${branch}--T1`, baseRef);
  writeFileSync(join(wt, "T1.txt"), "T1\n");
  git(wt, "add", "T1.txt");
  git(wt, "commit", "--no-gpg-sign", "-m", "T1");
  const head = await gitHead(wt);
  const definition = (id: string) => parkDefinition(loadGraph(repo).tasks.find((t) => t.id === id)!);
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { baseRef, branch, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  journal.append("task-dispatch", "T1", { assignment: SEAT, attempt: 0 });
  journal.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [] });
  journal.append("gate-result", "T1", { gate: "review", pass: false, commit: "s1", details: "T1.txt: the guard is missing" });
  journal.append("task-human", "T1", { kind: "gate-fail", reason: "review round cap (2) reached this engagement", definition: definition("T1") });
  journal.append("task-dispatch", "W1", { assignment: SEAT, attempt: 0 });
  journal.append("task-human", "W1", { kind: "scope-request", reason: "scope request: W1b.txt", definition: definition("W1") });
  journal.append("exit-cause", undefined, { cause: "deliberate", signal: "SIGTERM" });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  await approve([runId, "W1", "--files", "W1b.txt"], repo); // the sibling's granted, materialized amendment
  const seeded = journal.read();
  const parkLine = physicalLine(seeded, parkIndex(seeded, "T1"));
  recompile(repo, [{ ...before[0], goal: "parked on review, split" }, before[1]]);
  const launchAt = seeded.length;
  const summary = await runDaemon(repo, { adapters: [new FakeAdapter(scriptPath)], runId, resume: true, graphChanged: true });
  return { events: rows(repo, runId), launchAt, parkLine, head, summary };
}

describe("row 372 — a release follows every rehash this launch journals", () => {
  test("a graph changed resume whose only rehash is the scope amendment replay still releases the changed park and enacts it", async () => {
    const a = await amendmentScenario();
    const launch = a.events.slice(a.launchAt);
    const rehashes = launch.filter((e) => e.event === "graph-rehash");
    // the replay's audited rehash is the last one this launch journaled, and no comparison rehash follows it
    expect(rehashes.at(-1)?.data).toMatchObject({ source: "approval", replay: true });
    expect(rehashes.filter((e) => e.data.replay !== true && e.data.source !== "approval")).toEqual([]);
    const replay = rehashes.at(-1)!;
    const t1 = launch.filter((e) => e.taskId === "T1");
    const release = t1.find((e) => e.event === "task-approved")!;
    expect(release.data).toMatchObject({
      by: "resume --graph-changed", via: "resume", release: "recheck", park: { line: a.parkLine },
      engagement: { cause: "graph-changed", rehash: { from: replay.data.from, to: replay.data.to }, head: a.head, path: STOPPED_PATH },
    });
    // the same resume enacts it: the battery gates the parked head with no worker and no re-park before it
    const batteryAt = t1.findIndex((e) => e.event === "recheck-battery");
    expect(batteryAt).toBeGreaterThan(t1.indexOf(release));
    expect(t1.slice(0, batteryAt).filter((e) => ["task-human", "worker-launch", "task-dispatch"].includes(e.event))).toEqual([]);
    expect(a.summary.done).toEqual(expect.arrayContaining(["T1", "W1"]));
  }, 300_000);
});
