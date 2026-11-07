// Row 337 (D-2181 D3, D4): a fresh test force is a property of a run/task/test/subject, folded over the task's
// whole history — a semantic park, a waiver, an uphold, a recheck or a restart never discharges it; only a later
// executed full test on the same subject does — and a park names execution or reuse from proven evidence. Zero
// tokens: the fake adapter, scripted gate commands, and a scripted review leg (no review seat is launched).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, test, vi } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import { validateGraph, type GateName, type Task } from "../../src/graph/schema.js";
import type { GateResult } from "../../src/gates/types.js";
import { isInfraResult } from "../../src/gates/cache.js";
import * as gateRunner from "../../src/gates/run-gates.js";
import type { GateContext } from "../../src/gates/run-gates.js";
import { outsideScopeRed, pendingFreshForce, readTestHistory, replaySource, runDaemon, testRedEvidence, testRedWording } from "../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import * as recoveryModule from "../../src/run/recovery.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

afterEach(() => vi.restoreAllMocks());

// ---- the captured shapes (run-20261102-100040-0000000000000576), as fixture data -----------------------
const S = "c70a6592bc088c541282b2c842048ebf206dedb9c3f1286bb998267dacdf3d77"; // a gate subject digest, not a git commit
const RUN = "run-20261102-100040-0000000000000576";
const HEAD = "ea0b946db2a01e040c8c508f5018353d04130461"; // the git commit the subject was measured on
const OTHER = "0000000000000000000000000000000000000000000000000000000000000001";
const OUTSIDE = "tests/outside.test.ts";
const CLEAN = "\nclassification: regression; runner-level diagnostic: never-started 0; reporter errors 0; runner vitest";
const SUSPEND = { kind: "host-suspend", from: 1793621905332, to: 1793622076296, wallMs: 170964, monoMs: 170963.3752500005, subtractedMs: 170759.0830078125 };
const WINDOW = { file: "tests/run/daemon/transport-closed.test.ts", from: 1793621893704, to: 1793622077279 };
/** A production-shaped receipt: stamped with its run, task and gate (its `subjectCommit` is a git commit, never the
 * gate subject digest); a vitest invocation also carries its nonce, which a shell pre-spawn retry keeps while its
 * invocation id moves on. */
const receipt = (id: string, taskId = "T1", extra: Record<string, unknown> = {}, attempt: number | null = null) => ({ invocationId: id,
  subject: { runId: RUN, taskId, attempt, gate: "test", subjectCommit: HEAD },
  termination: { kind: "exit", exitCode: 1 }, ...extra });
/** The same receipt stamped for a concrete attempt, as the live daemon stamps it (its round's gate-subject attempt). */
const stamped = (id: string, attempt: number) => { const r = receipt(id, "T1", { nonce: id }); return { ...r, subject: { ...r.subject, attempt } }; };
const row = (event: string, data: Record<string, unknown>, taskId = "T1"): JournalEvent => ({ ts: "2026-11-02T10:00:00.000Z", event, taskId, data });
const force = (attempt: number, commit: unknown = S, extra: Record<string, unknown> = {}) =>
  row("gate-fresh-forced", { gate: "test", attempt, priorAttempt: attempt - 1, commit, reason: "no-commit-out-of-scope-red", ...extra });
/** A full test result that executed: a started test invocation's receipt stamped for the row's own attempt, as the
 * daemon stamps both from its round's gate subject — never reused or replayed. */
const executed = (attempt: number, extra: Record<string, unknown> = {}, taskId = "T1") => row("gate-result", {
  gate: "test", pass: false, attempt, commit: S, subjectHead: HEAD, fullSuite: true, classification: "regression", failingFiles: [OUTSIDE],
  evidenceReceipt: receipt(`inv-${attempt}`, taskId, {}, attempt), ...extra }, taskId);
/** The captured attempt-five row: the cache's attempt-three verdict, its original attempt-three receipt carried. */
const reused = (attempt: number, extra: Record<string, unknown> = {}) => executed(attempt, { reused: true, evidenceReceipt: receipt("inv-3", "T1", {}, 3), ...extra });
const semanticPark = [
  row("gate-result", { gate: "review", pass: false, attempt: 4, commit: S, details: "unreadable — no cross-vendor reviewer available" }),
  row("task-human", { kind: "gate-fail", reason: "review red" }),
  row("task-approved", { release: "gate-satisfied", gate: "review" }),
];
const CAPTURED = [executed(3), force(4), ...semanticPark];
/** Review 2ca692d7c9cd: a receipt-less red at three, the force at four, then a full row carrying attempt three's
 * invocation — an older attempt journaled late, or a row/receipt attempt missing, a string or contradicting. */
const LATE = [row("gate-result", { gate: "test", pass: false, commit: S, attempt: 3 }), force(4)];
const lateReceipt = (attempt: unknown) => ({ ...receipt("old-3", "T1", { nonce: "old-3" }), subject: { ...receipt("old-3").subject, attempt } });
const LATE_CELLS: Array<[string, unknown, unknown]> = [["an earlier attempt journaled after the force", 3, 3], ["a row naming no attempt", undefined, 3],
  ["a string row attempt", "5", 3], ["a string receipt attempt", 5, "3"]];
const lateRow = (attempt: unknown, stamp: unknown, pass: boolean, extra: Record<string, unknown> = {}) =>
  row("gate-result", { gate: "test", commit: S, subjectHead: HEAD, attempt, pass, fullSuite: true, nonce: "old-3", evidenceReceipt: lateReceipt(stamp), ...extra });
/** Review (resettable attempt counters): the force at four, its park, then an approval the next dispatch ENACTS — an
 * uphold or an attempt-cap release resets the attempt counter, so the new engagement executes again from attempt 0. */
const engaged = (release: string, refused = false) => [executed(3), force(4), row("task-human", { kind: "gate-fail", reason: "review red" }),
  row("task-approved", { release }), ...(refused ? [row("approval-refused", {})] : []), row("task-dispatch", { attempt: 0 })];
/** Review (non-resetting events): the force at four, a review red and its park, then a release BOUND to that park and
 * enacted by a resume. Only an uphold or attempt-cap release resets the counter; a waive or recheck keeps counting. */
const bound = (release: string) => {
  const park = row("task-human", { kind: release === "attempt-cap" ? "attempt-cap" : "gate-fail", reason: "review red" });
  return [force(4), row("gate-result", { gate: "review", pass: false, attempt: 4, commit: S }), park,
    row("task-approved", { release, gate: "review", park: { line: 3, ts: park.ts } }), row("resume-restore", {})];
};
/** A retry-failed resume while `failed` stood failed by dispatch (dispatched, no red since): only THAT task's counter resets. */
const retried = (failed: string) => [force(4), row("task-dispatch", { attempt: 4 }, failed), row("task-failed", { kind: "dispatch" }, failed),
  { ts: "2026-11-02T10:00:00.000Z", event: "run-resume", data: { retryFailed: true } } as JournalEvent];

describe("row 337 (D-2181 D3): a pending fresh force survives everything but a proven full execution", () => {
  // ---- the production daemon: worker lands src/a.txt, then nothing; every test run names only OUTSIDE ----
  const fixture = (green?: string) => setupRepo(
    [T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "review"], files: ["src/**"] })],
    { consult: { action: "human", notes: "operator decides" },
      tasks: { T1: [{ shell: `mkdir -p src && echo a0 > src/a.txt && ${COMMIT} a0`, result: { ok: true, summary: "a0" } },
        ...["r1", "r2", "r3", "r4", "r5"].map((id) => ({ shell: "true", result: { ok: true, summary: id } }))] } },
    stringify({ gates: { build: "true", lint: "true",
      test: `${green ? `[ -f '${green}' ] || ` : ""}[ ! -f src/a.txt ] || { echo ' FAIL  ${OUTSIDE} > reads one'; echo 'AssertionError: expected one to be two'; exit 1; }` } }),
  );
  /** The real gate battery with the reporter's complete outside attribution stamped on every test red, and a
   * scripted review leg: approved on the first round, then (while `semanticRed`) a no-eligible-reviewer red that
   * ends the round BEFORE any test payload, exactly as run-gates orders semantics ahead of the test gate. */
  const gates = () => {
    const state = { semanticRed: false, calls: 0 };
    const original = gateRunner.runGates;
    vi.spyOn(gateRunner, "runGates").mockImplementation(async (task: Task, ctx: GateContext) => {
      state.calls++;
      const attributed: GateContext = { ...ctx, onGate: async (e) => {
        if (e.phase === "end" && e.result.gate === "test" && !e.result.pass) {
          e.result.meta = { ...e.result.meta, classification: "regression", failingFiles: [OUTSIDE], fullSuite: true };
          e.result.details += CLEAN;
        }
        await ctx.onGate?.(e);
      } };
      const total = task.gates.length;
      if (task.gates.includes("review") && state.semanticRed) {
        const results: GateResult[] = [];
        for (const gate of task.gates.filter((g) => g !== "test" && g !== "review") as GateName[]) {
          await ctx.onGate?.({ phase: "start", gate, index: task.gates.indexOf(gate), total });
          results.push({ gate, pass: true, details: "ok" });
          await ctx.onGate?.({ phase: "end", gate, result: results.at(-1)! });
        }
        const review: GateResult = { gate: "review", pass: false, details: "unreadable — no cross-vendor reviewer available at or above cheap floor",
          meta: { noEligibleReviewer: true, unreadable: true, findings: [], authorVendors: ["fake"], unresolvedAuthors: [] } };
        await ctx.onGate?.({ phase: "start", gate: "review", index: task.gates.indexOf("review"), total });
        await ctx.onGate?.({ phase: "end", gate: "review", result: review });
        return { results: [...results, review], commits: [] };
      }
      const done = await original({ ...task, gates: task.gates.filter((g) => g !== "review") }, attributed);
      if (!task.gates.includes("review")) return done;
      const review: GateResult = { gate: "review", pass: true, details: "approved", meta: { reviewer: "seat-z:seat-z" } };
      await ctx.onGate?.({ phase: "start", gate: "review", index: task.gates.indexOf("review"), total });
      await ctx.onGate?.({ phase: "end", gate: "review", result: review });
      state.semanticRed = true; // every later round with a review leg records a semantic red before its test
      return { results: [...done.results, review], commits: done.commits };
    });
    return state;
  };
  const rows = (repo: string, runId: string) => Journal.open(repo, runId).read();
  const of = (all: JournalEvent[], event: string) => all.filter((e) => e.taskId === "T1" && e.event === event);
  const tests = (all: JournalEvent[]) => of(all, "gate-result").filter((e) => e.data.gate === "test");
  const after = (all: JournalEvent[], n: number) => all.slice(n);
  /** Live: attempt 0's executed outside red, then attempt 1's force whose round parks on a semantic red. */
  const forcedThenSemanticPark = async (runId: string, green?: string) => {
    const { repo, fake } = fixture(green);
    const state = gates();
    const live = await runDaemon(repo, { adapters: [fake], runId });
    expect(live.human).toEqual(["T1"]);
    const all = rows(repo, runId);
    const [red] = tests(all);
    expect(tests(all)).toHaveLength(1);
    expect(red!.data).toMatchObject({ attempt: 0, pass: false, testExecution: "executed" });
    const subject = String(red!.data.commit);
    expect(of(all, "gate-fresh-forced").map((e) => e.data)).toMatchObject([{ gate: "test", attempt: 1, priorAttempt: 0, commit: subject, reason: "no-commit-out-of-scope-red" }]);
    expect(of(all, "task-human").at(-1)!.data.kind).toBe("gate-fail");
    expect(of(all, "gate-result").filter((e) => e.data.gate === "review" && e.data.attempt === 1).map((e) => e.data.pass)).toEqual([false]);
    expect(pendingFreshForce(all, runId, "T1", subject)).toMatchObject({ kind: "pending", attempt: 1 });
    return { repo, fake, state, subject };
  };
  /** The waiver's resume: the next same-subject test EXECUTES fresh, refusing the attempt-0 cache red. */
  const expectFreshExecution = (all: JournalEvent[], from: number, subject: string, runId: string) => {
    const resumed = after(all, from);
    expect(tests(resumed).map((e) => [e.data.commit, e.data.pass, e.data.testExecution, e.data.reused, e.data.replayedFromAttempt]))
      .toEqual([[subject, false, "executed", undefined, undefined]]);
    expect(of(resumed, "gate-reused-verdict").filter((e) => e.data.gate === "test")).toEqual([]);
    expect(of(resumed, "gate-replayed")).toEqual([]);
    expect(of(resumed, "gate-rerun").map((e) => e.data)).toEqual([{ gate: "test", reason: "cached-red-discarded", bypass: "pending-fresh-force" }]);
    // the park is worded from that execution: a full run after the subject's force, so the fresh sentence is true
    expect(String(of(resumed, "task-human").at(-1)!.data.reason))
      .toContain("test: a fresh re-execution of the unchanged subject failed again only in files outside files[] — no repair can reach them");
    expect(pendingFreshForce(all, runId, "T1", subject)).toEqual({ kind: "none" });
  };

  /** Review 838 F1/F2: an interrupted subject's operator recheck executed its one full job GREEN and enacted it, and
   * the daemon died before merging; a force row then lands on that subject before the restart settles the persisted
   * round. The green predates the force and D2 forbids a second execution under the one recheck: the restart parks
   * infra, executing and merging nothing — never a restored green. `forceRow` builds the row from the subject. */
  const persistedRecheckThenForce = async (runId: string, forceRow: (subject: string) => Record<string, unknown>) => {
    const dir = makeTestTempDir("force-recheck-");
    writeFileSync(join(dir, "run.sh"), `case "$PWD" in *tip-verify-*) exit 0;; esac
n=$(cat '${dir}/count' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${dir}/count'
[ -f '${dir}/green' ] && exit 0
echo 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"'; exit 1
`);
    const executions = () => existsSync(join(dir, "count")) ? Number(readFileSync(join(dir, "count"), "utf8").trim()) : 0;
    const { repo, fake } = setupRepo(
      [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })],
      { consult: { action: "human", notes: "operator decides" }, tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
      stringify({ gates: { build: "true", lint: "true", test: `[ ! -f t1.txt ] || sh '${join(dir, "run.sh")}'` } }),
    );
    await runDaemon(repo, { adapters: [fake], runId });
    const file = join(Journal.open(repo, runId).dir, "journal.jsonl");
    // the legacy interrupted park: its test reds carry the captured interruption evidence
    const history = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as JournalEvent);
    for (const e of tests(history)) if (e.data.pass === false) Object.assign(e.data, { disposition: "interrupted", classification: "regression",
      infra: true, interruptions: [SUSPEND], failingFiles: [WINDOW.file], failureWindows: [{ file: WINDOW.file, from: SUSPEND.from - 1, to: SUSPEND.from + 1 }] });
    writeFileSync(file, `${history.map((e) => JSON.stringify(e)).join("\n")}\n`);
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    const tip = execFileSync("git", ["rev-parse", `tickmarkr/${runId}`], { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(join(dir, "green"), "");
    await runDaemon(repo, { adapters: [fake], runId, resume: true });
    const ran = executions();
    // the crash: the journal ends at the recheck's enactment, over its persisted executed green, unmerged
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const parsed = lines.map((line) => JSON.parse(line) as JournalEvent);
    const enactedAt = parsed.findIndex((e) => e.event === "recheck-battery" && e.taskId === "T1");
    const green = tests(parsed.slice(0, enactedAt)).filter((e) => e.data.pass === true && recoveryModule.executedFullTest(e.data)).at(-1);
    expect(green).toBeDefined();
    const subject = String(green!.data.commit);
    writeFileSync(file, `${[...lines.slice(0, enactedAt + 1), JSON.stringify({ ts: "2026-11-02T10:00:00.000Z", ...forceRow(subject) })].join("\n")}\n`);
    execFileSync("git", ["update-ref", `refs/heads/tickmarkr/${runId}`, tip], { cwd: repo });
    const resumed = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    const all = rows(repo, runId);
    const resumedRows = after(all, all.map((e) => e.event).lastIndexOf("run-resume") + 1);
    expect(executions()).toBe(ran); // nothing re-ran under the one recheck
    expect(tests(resumedRows)).toEqual([]);
    expect([resumed.done, resumed.human, of(resumedRows, "task-done"), of(resumedRows, "merge"), of(resumedRows, "worker-launch")])
      .toEqual([[], ["T1"], [], [], []]);
    const park = of(resumedRows, "task-human").at(-1)!;
    expect(park.data.kind).toBe("infra");
    return { reason: String(park.data.reason), all, subject, runId };
  };

  test("the captured fresh force survives a semantic park and a review waiver so the next same subject test executes rather than reusing the earlier verdict", async () => {
    const runId = "run-fresh-force-captured";
    const { repo, fake, state, subject } = await forcedThenSemanticPark(runId);
    expect(await approve([runId, "T1", "--waive"], repo)).toContain("waived failed gate review");
    expect(of(rows(repo, runId), "task-approved").at(-1)!.data).toMatchObject({ release: "gate-satisfied" });
    const from = rows(repo, runId).length;
    state.semanticRed = false;
    await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expectFreshExecution(rows(repo, runId), from, subject, runId);
    // and the consumed force is never refilled: a resume of that park re-executes nothing
    const settled = rows(repo, runId).length;
    await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expect(tests(after(rows(repo, runId), settled))).toEqual([]);
    vi.restoreAllMocks();

    // ---- review 809 F2: the parked round ALSO journaled a REUSED full green test on the subject. The waiver's
    // satisfied-gate selection alone would drop test (a full suite looked complete) and advance on a reuse; the
    // one admission predicate keeps test in the resumed round, so it executes fresh and parks truthfully ----
    {
      const runId = "run-fresh-force-reused-green-waiver";
      const { repo, fake, state, subject } = await forcedThenSemanticPark(runId);
      const file = join(Journal.open(repo, runId).dir, "journal.jsonl");
      const lines = readFileSync(file, "utf8").split("\n");
      const parkAt = lines.map((line) => line.includes("\"event\":\"task-human\"")).lastIndexOf(true);
      lines.splice(parkAt, 0, JSON.stringify({ ts: "2026-11-02T10:00:00.000Z", event: "gate-result", taskId: "T1", data: {
        gate: "test", pass: true, attempt: 1, commit: subject, fullSuite: true, reused: true, testExecution: "reused", details: "reused green" } }));
      writeFileSync(file, lines.join("\n"));
      expect(pendingFreshForce(rows(repo, runId), runId, "T1", subject)).toMatchObject({ kind: "pending", attempt: 1 });
      expect(await approve([runId, "T1", "--waive"], repo)).toContain("waived failed gate review");
      const from = rows(repo, runId).length;
      state.semanticRed = false;
      await runDaemon(repo, { adapters: [fake], runId, resume: true });
      expectFreshExecution(rows(repo, runId), from, subject, runId);
      expect(of(after(rows(repo, runId), from), "task-done")).toEqual([]);
    }
  }, 600_000);

  test("pending fresh force survives waive uphold recheck and daemon resume while only a later proven full execution on the same subject consumes it", async () => {
    const runId = "run-fresh-force-approvals";
    const { repo, fake, state, subject } = await forcedThenSemanticPark(runId);
    // recheck, uphold (funding its existing worker, which lands nothing) and a bare restart: each round again
    // records its semantic red before any test, so nothing executes the test and the one force stays pending
    for (const step of ["recheck", "uphold", "resume"] as const) {
      if (step !== "resume") expect(await approve([runId, "T1", `--${step}`, "--by", "op"], repo), step).toContain("approval disposition");
      const from = rows(repo, runId).length;
      await runDaemon(repo, { adapters: [fake], runId, resume: true });
      const all = rows(repo, runId);
      const resumed = after(all, from);
      expect(tests(resumed), step).toEqual([]);
      expect(of(resumed, "gate-replayed"), step).toEqual([]);
      expect(of(resumed, "gate-reused-verdict").filter((e) => e.data.gate === "test"), step).toEqual([]);
      if (step !== "resume") expect(of(resumed, "task-human").at(-1)?.data.kind, step).toBe("gate-fail");
      expect(pendingFreshForce(all, runId, "T1", subject), step).toMatchObject({ kind: "pending", attempt: 1 });
      // one obligation: no approval appends a force to forget or re-buy the older one
      expect(of(all, "gate-fresh-forced").filter((e) => e.data.resumed !== true), step).toHaveLength(1);
    }
    expect(of(rows(repo, runId), "worker-launch").length).toBeGreaterThan(1); // the uphold funded its worker
    // the waiver: the next same-subject test executes, and only that executed full result consumes the force
    expect(await approve([runId, "T1", "--waive"], repo)).toContain("waived failed gate review");
    const from = rows(repo, runId).length;
    state.semanticRed = false;
    await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expectFreshExecution(rows(repo, runId), from, subject, runId);
    vi.restoreAllMocks();

    // ---- review 838 F2: a valid same-subject force after a recheck's persisted executed green, before the restart
    // settles it — the earlier green never answers the pending force and no second execution runs: infra park ----
    const persisted = await persistedRecheckThenForce("run-fresh-force-persisted-recheck",
      (commit) => ({ event: "gate-fresh-forced", taskId: "T1", data: { gate: "test", attempt: 9, priorAttempt: 8, commit, reason: "no-commit-out-of-scope-red" } }));
    expect(pendingFreshForce(persisted.all, persisted.runId, "T1", persisted.subject)).toMatchObject({ kind: "pending", attempt: 9 });
    expect(persisted.reason).toMatch(/^test: the persisted test result cannot answer the subject's pending fresh force — it was not executed after that force, and no second execution runs under one recheck or reservation/);

    // ---- review d4c138e9d74f, the reviewer's reproducer: a readable same-subject force, then the test command is
    // removed and the operator rechecks. The resumed battery's test is a skip that executed nothing, so the force
    // stays pending and the green battery never merges: the task parks unresolved, infra ----
    const UNANSWERED = "test: the subject's pending fresh force was not answered by a proven full test execution — a skipped, reused or refused test never answers it, so nothing merges";
    {
      const runId = "run-review-unexecuted-force";
      const { repo, fake } = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"], files: ["src/**"] })],
        { consult: { action: "human", notes: "decide" }, tasks: { T1: [{ shell: `mkdir -p src && echo a > src/a.txt && ${COMMIT} a`, result: { ok: true, summary: "a" } },
          ...Array.from({ length: 6 }, () => ({ shell: "true", result: { ok: true, summary: "no change" } }))] } },
        "gates:\n  build: \"true\"\n  lint: \"true\"\n  test: \"[ ! -f src/a.txt ] || { echo boom; exit 1; }\"\n");
      const opts = { adapters: [fake], runId, approvalWindowMs: 0 };
      await runDaemon(repo, opts);
      const j = Journal.open(repo, runId);
      const red = j.read().filter((e) => e.event === "gate-result" && e.data.gate === "test").at(-1)!;
      j.append("gate-fresh-forced", "T1", { gate: "test", commit: red.data.commit, attempt: red.data.attempt, reason: "no-commit-timeout-red" });
      const cfg = join(repo, ".tickmarkr/config.yaml");
      writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^ {2}test:.*\n/m, ""));
      await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      const from = j.read().length;
      const result = await runDaemon(repo, { ...opts, resume: true });
      const all = j.read();
      const resumed = after(all, from);
      expect(tests(resumed).map((e) => ({ pass: e.data.pass, skipped: e.data.skipped, testExecution: e.data.testExecution })))
        .toEqual([{ pass: true, skipped: true, testExecution: "unexecuted" }]);
      expect(pendingFreshForce(all, runId, "T1", String(red.data.commit))).toMatchObject({ kind: "pending" });
      expect([result.done, result.human, of(resumed, "task-done"), of(resumed, "merge")]).toEqual([[], ["T1"], [], []]);
      expect(of(resumed, "task-human").at(-1)!.data).toMatchObject({ kind: "infra", reason: expect.stringContaining(UNANSWERED) });
    }

    // ---- the same cell on LIVE dispatch: attempt 0's executed outside red forces attempt 1, whose battery's test is the
    // gate runner's own no-command skip — the green battery never merges past the pending force ----
    {
      const runId = "run-fresh-force-live-skip";
      const { repo, fake } = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"], files: ["src/**"] })],
        { consult: { action: "human", notes: "decide" }, tasks: { T1: [{ shell: `mkdir -p src && echo a0 > src/a.txt && ${COMMIT} a0`, result: { ok: true, summary: "a0" } },
          ...["r1", "r2", "r3"].map((id) => ({ shell: "true", result: { ok: true, summary: id } }))] } },
        stringify({ gates: { build: "true", lint: "true",
          test: `[ ! -f src/a.txt ] || { echo ' FAIL  ${OUTSIDE} > reads one'; echo 'AssertionError: expected one to be two'; exit 1; }` } }));
      const original = gateRunner.runGates;
      let calls = 0;
      vi.spyOn(gateRunner, "runGates").mockImplementation(async (task: Task, ctx: GateContext) => {
        if (++calls === 1) return original(task, { ...ctx, onGate: async (e) => {
          if (e.phase === "end" && e.result.gate === "test" && !e.result.pass) {
            e.result.meta = { ...e.result.meta, classification: "regression", failingFiles: [OUTSIDE], fullSuite: true };
            e.result.details += CLEAN;
          }
          await ctx.onGate?.(e);
        } });
        // the test command is gone: baseline.ts's own skip shape for a gate with no detected command
        const done = await original({ ...task, gates: task.gates.filter((g) => g !== "test") }, ctx);
        const skip: GateResult = { gate: "test", pass: true, details: "no test command detected — skipped",
          meta: { skipped: true, outcome: { kind: "skipped", reason: "no test command detected" } } };
        await ctx.onGate?.({ phase: "start", gate: "test", index: task.gates.indexOf("test"), total: task.gates.length });
        await ctx.onGate?.({ phase: "end", gate: "test", result: skip });
        return { results: [...done.results, skip], commits: done.commits };
      });
      const live = await runDaemon(repo, { adapters: [fake], runId });
      vi.restoreAllMocks();
      const all = rows(repo, runId);
      const subject = String(tests(all)[0]!.data.commit);
      expect(of(all, "gate-fresh-forced").map((e) => e.data)).toMatchObject([{ gate: "test", attempt: 1, commit: subject }]);
      expect(tests(all).map((e) => [e.data.attempt, e.data.pass, e.data.skipped, e.data.testExecution]))
        .toEqual([[0, false, undefined, "executed"], [1, true, true, "unexecuted"]]);
      expect(pendingFreshForce(all, runId, "T1", subject)).toMatchObject({ kind: "pending", attempt: 1 });
      expect([live.done, live.human, of(all, "task-done"), of(all, "merge")]).toEqual([[], ["T1"], [], []]);
      expect(of(all, "task-human").at(-1)!.data).toMatchObject({ kind: "infra", reason: expect.stringContaining(UNANSWERED) });
    }

    // ---- review (resettable attempt counters), through the daemon: an uphold and an attempt-cap release each reset the
    // attempt counter, so the funded engagement's FIRST round executes the test at attempt 0 — below the force's attempt 1.
    // That full execution is genuinely new: red or green it consumes the force, and a green merges instead of parking infra ----
    for (const release of ["review-upheld", "attempt-cap"] as const) for (const pass of [false, true]) {
      const cell = `${release}, ${pass ? "green" : "red"}`;
      const runId = `run-fresh-force-${release}-${pass ? "green" : "red"}`;
      const green = join(makeTestTempDir("force-engagement-"), "green");
      const { repo, fake, state, subject } = await forcedThenSemanticPark(runId, green);
      // review (physical line identity): a blank line shifts every compacted index below it; the approval below binds
      // its park by PHYSICAL line, and the daemon's strict read must keep that identity to see the reset
      const file = join(Journal.open(repo, runId).dir, "journal.jsonl");
      writeFileSync(file, readFileSync(file, "utf8").replace("\n", "\n\n"));
      if (release === "review-upheld") expect(await approve([runId, "T1", "--uphold", "--by", "op"], repo), cell).toContain("approval disposition");
      else {
        Journal.open(repo, runId).append("task-human", "T1", { kind: "attempt-cap", reason: "attempt cap (10) reached" });
        expect(await approve([runId, "T1", "--by", "op"], repo), cell).toContain("approval disposition");
      }
      expect(of(rows(repo, runId), "task-approved").at(-1)!.data.release, cell).toBe(release);
      expect(Journal.open(repo, runId).replayResumeState().get("T1")!.attempts, cell).toBe(0);
      if (pass) writeFileSync(green, "");
      const from = rows(repo, runId).length;
      state.semanticRed = false;
      const result = await runDaemon(repo, { adapters: [fake], runId, resume: true });
      vi.restoreAllMocks();
      const all = rows(repo, runId);
      const resumed = after(all, from);
      const first = tests(resumed)[0]!;
      expect(first.data, cell).toMatchObject({ commit: subject, attempt: 0, pass, testExecution: "executed" });
      expect(pendingFreshForce(all.slice(0, all.indexOf(first)), runId, "T1", subject), cell).toMatchObject({ kind: "pending", attempt: 1 });
      expect(pendingFreshForce(all.slice(0, all.indexOf(first) + 1), runId, "T1", subject), cell).toEqual({ kind: "none" });
      expect(of(resumed, "task-human").filter((e) => String(e.data.reason).includes("fresh force")), cell).toEqual([]);
      if (pass) expect([result.done, result.human, of(resumed, "task-done").length], cell).toEqual([["T1"], [], 1]);
      // the park seam's own strict read words that attempt-0 red as the fresh re-execution, never a plain executed red
      const strict = readTestHistory(file);
      expect(strict.ok && strict.unreadable, cell).toBe(0);
      if (!pass && strict.ok) expect(testRedEvidence(strict.events.slice(0, all.indexOf(first) + 1), runId, "T1", subject).kind, cell).toBe("fresh");
    }
  }, 600_000);

  test("duplicate force rows reuse selected screens other subjects missing execution proof and unreadable history never consume or refill a pending force", async () => {
    const screen = (attempt: number, pass: boolean) => executed(attempt, { pass, fullSuite: undefined, selectedTests: [OUTSIDE] });
    // [cell, history, expected kind] — the closed D3 input list, base first, on the fold the daemon reads
    const cells: Array<[string, JournalEvent[], "none" | "pending" | "unprovable", number?]> = [
      ["captured: force, semantic park, waiver, attempt-three cache offered at five", [...CAPTURED, reused(5)], "pending"],
      ["park, waive, uphold or recheck approvals after the force", [...CAPTURED, row("task-approved", { release: "uphold" }), row("task-approved", { release: "recheck" }),
        row("test-interrupted-recheck-claimed", { commit: S })], "pending"],
      ["a measured phase-start after the force", [...CAPTURED, row("phase-start", { phase: "gates", gate: "test", durationMs: 99 })], "pending"],
      ["selected green", [...CAPTURED, screen(5, true)], "pending"],
      ["selected red", [...CAPTURED, screen(5, false)], "pending"],
      ["skipped test", [...CAPTURED, executed(5, { pass: undefined, skipped: true })], "pending"],
      ["unexecuted refusal with no receipt (missing execution proof)", [...CAPTURED, executed(5, { evidenceReceipt: undefined, dirtyWorktree: true })], "pending"],
      ["a discovery listing receipt only", [...CAPTURED, executed(5, { evidenceReceipt: receipt("inv-5-listing", "T1", {}, 5) })], "pending"],
      ["a new row stating testExecution unexecuted beside a bound receipt (contradiction)", [...CAPTURED, executed(5, { testExecution: "unexecuted" })], "unprovable"],
      ["a new row stating testExecution reused", [...CAPTURED, executed(5, { testExecution: "reused" })], "pending"],
      ["reused green", [...CAPTURED, reused(5, { pass: true })], "pending"],
      ["journal replay copy, green", [...CAPTURED, executed(5, { pass: true, replayedFromAttempt: 4 })], "pending"],
      ["executed on another subject", [...CAPTURED, executed(5, { commit: OTHER })], "pending"],
      ["executed by another task", [...CAPTURED, executed(5, {}, "T2")], "pending"],
      ["only another gate after the force", [...CAPTURED, row("gate-result", { gate: "lint", pass: true, attempt: 5, commit: S, evidenceReceipt: receipt("inv-lint") })], "pending"],
      ["a result naming no readable subject", [...CAPTURED, executed(5, { commit: undefined })], "unprovable"],
      ["execution before the force", [executed(3), executed(3, { pass: true, evidenceReceipt: receipt("inv-3b", "T1", {}, 3) }), force(4)], "pending"],
      ["duplicate force rows before one full execution", [...CAPTURED, force(4, S, { resumed: true }), force(5)], "pending"],
      ["one execution consumes the duplicate set", [...CAPTURED, force(4, S, { resumed: true }), force(5), executed(6)], "none"],
      ["proven green execution consumes", [...CAPTURED, executed(5, { pass: true })], "none"],
      ["an execution at the force's own attempt consumes", [...CAPTURED, executed(4)], "none"],
      ["an execution before the latest duplicate force's attempt does not", [...CAPTURED, force(6), executed(5)], "pending"],
      // review (resettable attempt counters): an enacted uphold or attempt-cap release, or a retry-failed resume, starts a
      // new engagement whose attempts restart at 0 — its full execution follows the force, red or green; a refused or
      // unenacted unbound approval resets nothing, and a force journaled in the new engagement is owed on its own counter
      ...(["review-upheld", "attempt-cap"] as const).flatMap((release) => ([false, true] as const).map((pass): [string, JournalEvent[], "none"] =>
        [`an enacted ${release} release's attempt-0 ${pass ? "green" : "red"} consumes`, [...engaged(release), executed(0, { pass })], "none"])),
      ["a retry-failed resume of this task's dispatch failure: its attempt-0 execution consumes", [executed(3), ...retried("T1"), executed(0)], "none"],
      // review (non-resetting events): only THIS task's actual counter reset starts an engagement — a bound waive or
      // recheck keeps counting, and so does a retry-failed resume that reset another task or found this one failed by a red
      ...(["gate-satisfied", "recheck"] as const).flatMap((release) => ([false, true] as const).map((pass): [string, JournalEvent[], "pending"] =>
        [`an effective ${release} release's late attempt-3 ${pass ? "green" : "red"} never consumes`, [...bound(release), executed(3, { pass })], "pending"])),
      ...(["review-upheld", "attempt-cap"] as const).map((release): [string, JournalEvent[], "none"] =>
        [`an effective bound ${release} release's attempt-0 execution consumes`, [...bound(release), executed(0)], "none"]),
      ["a retry-failed resume that reset only another task", [executed(3), ...retried("T2"), executed(3)], "pending"],
      ["a retry-failed resume after this task failed by a gate red", [executed(3), force(4), row("task-dispatch", { attempt: 4 }),
        row("gate-result", { gate: "review", pass: false, attempt: 4, commit: S }), row("task-failed", {}), retried("T1").at(-1)!, executed(0)], "pending"],
      ["a refused uphold resets nothing: attempt 0 after it is an older attempt", [...engaged("review-upheld", true), executed(0)], "pending"],
      ["an unenacted unbound approval resets nothing", [...CAPTURED, executed(0)], "pending"],
      ["a force in the new engagement is owed on that engagement's counter", [...engaged("review-upheld"), force(1), executed(0)], "pending"],
      ["the new engagement's execution at that force's attempt consumes", [...engaged("review-upheld"), force(1), executed(1)], "none"],
      ["proven interrupted execution consumes (D2 still bounds its retry)", [...CAPTURED, executed(5, { disposition: "interrupted", infra: true, interruptions: [SUSPEND], failureWindows: [WINDOW] })], "none"],
      ["consumed, then reuse, screens and approvals never refill", [...CAPTURED, executed(5), reused(6), screen(6, false), row("task-approved", { release: "recheck" })], "none"],
      ["a force on another subject", [executed(3), force(4, OTHER)], "none"],
      ["no force", [executed(3), reused(4)], "none"],
      ["a force naming no readable subject", [...CAPTURED, force(5, "")], "unprovable"],
      ["a force whose subject is not a string", [executed(3), force(4, null)], "unprovable"],
      // review 87x F1: the reviewer's malformed pair, both orders (identity checked below)
      ["a result naming no gate before a force naming no gate", [row("gate-result", { pass: true, commit: S }), row("gate-fresh-forced", { attempt: 1, commit: S, reason: "no-commit-out-of-scope-red" })], "unprovable"],
      ["a force naming no gate before a result naming no gate", [row("gate-fresh-forced", { attempt: 1, commit: S, reason: "no-commit-out-of-scope-red" }), row("gate-result", { pass: true, commit: S })], "unprovable"],
      // review 87x F2: one namespace of effective nonces — a receipt nonce equal to an earlier receipt's invocation id is a copy
      ["a post-force row whose receipt nonce is an earlier receipt's invocation id (effective nonce alias)", [executed(2, { commit: OTHER, nonce: "n", evidenceReceipt: receipt("n", "T1", { nonce: "n" }, 2) }),
        force(4), executed(5, { nonce: "n", evidenceReceipt: receipt("u-new", "T1", { nonce: "n" }, 5) })], "pending"],
      // review 809 F1: every force and result row is validated BEFORE any filter by task or gate
      ["a force row naming no gate", [...CAPTURED, row("gate-fresh-forced", { attempt: 5, commit: S, reason: "no-commit-out-of-scope-red" })], "unprovable"],
      ["a force row naming no task", [executed(3), { ts: "2026-11-02T10:00:00.000Z", event: "gate-fresh-forced", data: { gate: "test", attempt: 4, commit: S, reason: "no-commit-out-of-scope-red" } } as JournalEvent], "unprovable"],
      ["a force row with no data", [executed(3), { ts: "2026-11-02T10:00:00.000Z", event: "gate-fresh-forced", taskId: "T1" } as JournalEvent], "unprovable"],
      ["another task's force naming no subject", [executed(3), { ...force(4, ""), taskId: "T2" }], "unprovable"],
      ["a result row naming no task, beside a consumed force", [...CAPTURED, executed(5), { ts: "2026-11-02T10:00:00.000Z", event: "gate-result", data: { gate: "test", pass: true, commit: S } } as JournalEvent], "unprovable"],
      ["a result row naming no gate", [executed(3), row("gate-result", { pass: true, commit: S })], "unprovable"],
      ["unreadable lines beside a pending force", CAPTURED, "unprovable", 1],
      ["unreadable lines beside a consumed force never refill it", [...CAPTURED, executed(5)], "unprovable", 1],
      ["unreadable lines beside no readable force prove nothing (a dropped line could be the force)", [executed(3)], "unprovable", 1],
      // contradictory production-shaped evidence: a receipt binds only the row's OWN started invocation
      ["a row whose nonce conflicts with its receipt's invocation", [...CAPTURED, executed(5, { nonce: "n-5" })], "unprovable"],
      ["a receipt carrying a nonce that conflicts with the row's", [...CAPTURED, executed(5, { nonce: "inv-5", evidenceReceipt: receipt("inv-5", "T1", { nonce: "n-other" }, 5) })], "unprovable"],
      ["a T1 row carrying T2's receipt", [...CAPTURED, executed(5, { evidenceReceipt: receipt("inv-5", "T2", {}, 5) })], "unprovable"],
      ["a receipt naming no task", [...CAPTURED, executed(5, { evidenceReceipt: { ...receipt("inv-5"), subject: { gate: "test", attempt: 5 } } })], "unprovable"],
      ["a listing nonce behind a retried invocation id", [...CAPTURED, executed(5, { evidenceReceipt: receipt("u-5", "T1", { nonce: "n-5-listing" }, 5) })], "pending"],
      ["a recorded selected scope without fullSuite or selectedTests", [...CAPTURED, executed(5, { fullSuite: undefined, selectionDecision: { scope: "selected", reason: "admitted", requiredFiles: [OUTSIDE] } })], "pending"],
      ["an unreadable selection decision without fullSuite", [...CAPTURED, executed(5, { fullSuite: undefined, selectionDecision: "selected" })], "pending"],
      // review 838 F3: invocation ownership — a receipt an EARLIER row already carried is a copy, never this row's execution
      ["a post-force row on this subject copying another subject's earlier receipt and nonce", [executed(2, { commit: OTHER, nonce: "n-2", evidenceReceipt: receipt("inv-2", "T1", { nonce: "n-2" }, 2) }),
        force(4), executed(5, { nonce: "n-2", evidenceReceipt: receipt("inv-2", "T1", { nonce: "n-2" }, 5) })], "pending"],
      ["a post-force row copying this subject's pre-force receipt", [...CAPTURED, executed(5, { evidenceReceipt: receipt("inv-3", "T1", {}, 5) })], "pending"],
      ["a post-force row carrying an earlier invocation's nonce behind a new invocation id", [executed(2, { commit: OTHER, nonce: "n-2", evidenceReceipt: receipt("u-2", "T1", { nonce: "n-2" }, 2) }),
        force(4), executed(5, { nonce: "n-2", evidenceReceipt: receipt("u-5", "T1", { nonce: "n-2" }, 5) })], "pending"],
      ["a post-force row copying another task's earlier row's invocation", [executed(2, { commit: OTHER }, "T2"),
        force(4), executed(5, { evidenceReceipt: receipt("inv-2", "T1", {}, 5) })], "pending"],
      // review 2ad34ffeaa5b: a receipt stamped for a concrete attempt other than the row's is that attempt's invocation —
      // a no-receipt red at three, the force at four, then a five row carrying an attempt-three receipt, red or green
      ...([false, true] as const).map((pass): [string, JournalEvent[], "unprovable"] => [`a post-force ${pass ? "green" : "red"} carrying a receipt stamped for an earlier attempt`,
        [executed(3, { evidenceReceipt: undefined }), force(4), executed(5, { pass, nonce: "old-3", evidenceReceipt: stamped("old-3", 3) })], "unprovable"]),
      // review 2ca692d7c9cd: invocation ownership needs an integer attempt the row and its receipt both name, at or
      // after the force — an older attempt journaled late, a missing or string attempt on either side, red or green
      // (the late earlier attempt is a well-formed execution that cannot reach the force: pending; the rest match no shape)
      ...LATE_CELLS.flatMap(([label, attempt, stamp], i) => ([false, true] as const).map((pass): [string, JournalEvent[], "pending" | "unprovable"] =>
        [`${label}, ${pass ? "green" : "red"}`, [...LATE, lateRow(attempt, stamp, pass)], i === 0 ? "pending" : "unprovable"])),
      ["a force naming no integer attempt", [executed(3), force(4, S, { attempt: "4" })], "unprovable"],
      // review 10f3f4e06080: a row naming no readable event could be a force or its consumer
      ...([undefined, null, 7, ""] as const).map((event): [string, JournalEvent[], "unprovable"] => [`a force-shaped row whose event is ${String(event)}`,
        [executed(3), { ts: "2026-11-02T10:00:00.000Z", event, taskId: "T1", data: force(4).data } as unknown as JournalEvent], "unprovable"]),
      ["a row naming no event beside a consumed force", [...CAPTURED, executed(5), { ts: "2026-11-02T10:00:00.000Z", taskId: "T1", data: executed(6).data } as unknown as JournalEvent], "unprovable"],
      ["a non-object row", [executed(3), 7 as unknown as JournalEvent], "unprovable"],
      // review (D-2184 add.43): proof is conjunctive — a receipt naming another run, a null, missing or other subject
      // commit, or a row recording no measured commit, is no proof (it matches no shape), red or green
      ...([false, true] as const).flatMap((pass): Array<[string, JournalEvent[], "unprovable"]> => [
        ["a receipt naming another run", { ...receipt("inv-5", "T1", {}, 5), subject: { ...receipt("inv-5", "T1", {}, 5).subject, runId: "run-B" } }],
        ["a receipt with a null subject commit", { ...receipt("inv-5", "T1", {}, 5), subject: { ...receipt("inv-5", "T1", {}, 5).subject, subjectCommit: null } }],
        ["a receipt naming another subject commit", { ...receipt("inv-5", "T1", {}, 5), subject: { ...receipt("inv-5", "T1", {}, 5).subject, subjectCommit: "head-B" } }],
      ].map(([label, r]): [string, JournalEvent[], "unprovable"] => [`${label as string}, ${pass ? "green" : "red"}`, [...CAPTURED, executed(5, { pass, evidenceReceipt: r })], "unprovable"])),
      ["a row recording no measured subject commit beside a receipt", [...CAPTURED, executed(5, { subjectHead: undefined })], "unprovable"],
      ["the receipt's commit compared with the subject digest itself is no proof", [...CAPTURED, executed(5, { subjectHead: S })], "unprovable"],
      // fullSuite false (or not a boolean) is NOT full: an executed partial run never consumes, red or green
      ["fullSuite false without selection fields, red", [...CAPTURED, executed(5, { fullSuite: false })], "pending"],
      ["fullSuite false without selection fields, green", [...CAPTURED, executed(5, { pass: true, fullSuite: false })], "pending"],
      ["a non-boolean fullSuite", [...CAPTURED, executed(5, { fullSuite: "true" })], "unprovable"],
      ["no fullSuite flag beside a selected-scope decision is not full", [...CAPTURED, executed(5, { fullSuite: undefined, selectionDecision: { scope: "selected" } })], "pending"],
      ["the in-battery full job's own readable full-scope decision (no fullSuite flag) consumes", [...CAPTURED, executed(5, { fullSuite: undefined, selectionDecision: { scope: "full", reason: "recheck-full-suite", requiredFiles: [] } })], "none"],
      ["a reused row naming a non-integer replayed attempt", [...CAPTURED, executed(5, { replayedFromAttempt: "3" })], "unprovable"],
      // a refusal is no result, though its command ran: a dirty-tree refusal, a blocked recovery, a stale proof or a
      // runner that died never consumes, red or green — only an interrupted red, which D2 bounds, does
      ...([false, true] as const).flatMap((pass): Array<[string, JournalEvent[], "pending"]> => [
        ["a dirty-tree refusal carrying its command's receipt", { dirtyWorktree: true, dirtyPaths: ["litter.txt"] }],
        ["a blocked recovery", { recoveryBlocked: "preserve failed" }],
        ["a stale full proof", { infra: true, classification: "infra", staleProof: true }],
        ["a signal-death infra non-verdict", { infra: true, classification: "infra", kind: "signal-exit" }],
        // review 9e6258d19cb1: the shared infra predicate, not the infra flag alone — a SIGKILLed row whose only infra
        // mark is its classification, a ceiling kill or a hang is a non-verdict too
        ["an infra classification without the infra flag", { classification: "infra", evidenceReceipt: { ...receipt("inv-5", "T1", {}, 5), termination: { kind: "signal", signal: "SIGKILL" } } }],
        ["a ceiling kill without the infra flag", { kind: "ceiling-kill" }],
        ["a hang without the infra flag", { kind: "hang" }],
        ["an infra-prefixed diagnostic without the infra flag", { classification: "regression", details: "infra: runner died before reporting" }],
      ].map(([label, extra]): [string, JournalEvent[], "pending"] => [`${label as string} after the force, ${pass ? "green" : "red"}`,
        [...CAPTURED, executed(5, { pass, ...(extra as Record<string, unknown>) })], "pending"])),
      ["an interrupted full red after the force consumes", [...CAPTURED, executed(5, { disposition: "interrupted", infra: true, interruptions: [SUSPEND], failureWindows: [WINDOW] })], "none"],
      // controls, one per kind, that DO parse and count: a force (pending), a reuse (never consumes), an execution (consumes)
      ["control: a well-formed force", [executed(3), force(4)], "pending"],
      ["control: a well-formed reuse after the force", [...CAPTURED, reused(5, { originAttempt: 3 })], "pending"],
      ["control: a well-formed owned full execution after the force", [...CAPTURED, executed(5)], "none"],
      // the same shapes, bound: each consumes
      ["a receipt stamped for the row's own attempt consumes", [...CAPTURED, executed(5, { nonce: "n-5", evidenceReceipt: stamped("n-5", 5) })], "none"],
      ["a nonce-bound receipt after a shell pre-spawn retry consumes", [...CAPTURED, executed(5, { nonce: "n-5", evidenceReceipt: receipt("u-5", "T1", { nonce: "n-5" }, 5) })], "none"],
      ["the full job after a diagnosed screen (selected scope, fullSuite) consumes", [...CAPTURED, executed(5, { selectionDecision: { scope: "selected", reason: "admitted", requiredFiles: [OUTSIDE] } })], "none"],
      ["a plain battery row (no fullSuite flag, no selection) consumes", [...CAPTURED, executed(5, { fullSuite: undefined })], "none"],
    ];
    for (const [cell, history, kind, unreadable] of cells) {
      expect(pendingFreshForce(history, RUN, "T1", S, unreadable).kind, cell).toBe(kind);
    }
    // review 9e6258d19cb1, the reviewer's reproducer verbatim: a SIGKILLed post-force row the shared predicate calls
    // infrastructure never consumes the force nor earns the fresh sentence
    for (const extra of [{ classification: "infra" }, { kind: "ceiling-kill" }, { kind: "hang" }]) {
      const data = { gate: "test", pass: false, attempt: 5, commit: "S", subjectHead: "H", fullSuite: true, ...extra,
        evidenceReceipt: { invocationId: "new-5", subject: { runId: "run-A", taskId: "T1", attempt: 5, gate: "test", subjectCommit: "H" }, termination: { kind: "signal", signal: "SIGKILL" } } };
      const h = [{ ts: "2026-11-02T10:00:00.000Z", event: "gate-fresh-forced", taskId: "T1", data: { gate: "test", commit: "S", attempt: 4, reason: "no-commit-out-of-scope-red" } },
        { ts: "2026-11-02T10:00:00.000Z", event: "gate-result", taskId: "T1", data }];
      const cell = JSON.stringify(extra);
      expect(isInfraResult({ pass: false, meta: data }), cell).toBe(true);
      expect(pendingFreshForce(h, "run-A", "T1", "S"), cell).toEqual({ kind: "pending", attempt: 4 });
      expect(testRedWording(testRedEvidence(h, "run-A", "T1", "S"), true), cell).not.toContain("a fresh re-execution of the unchanged subject failed again");
      expect(outsideScopeRed(validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
        tasks: [T("T1", { files: ["src/**"] })] }).tasks[0]!, "T1", { ...data, failingFiles: [OUTSIDE], details: ` FAIL  ${OUTSIDE} > x${CLEAN}` }, "S"), cell).toBe(false);
    }
    expect(pendingFreshForce(CAPTURED, RUN, "T1", "").kind, "missing subject").toBe("unprovable");
    expect(pendingFreshForce(CAPTURED, RUN, "T1", undefined).kind, "missing subject").toBe("unprovable");
    // an unreadable subject parks infra; unreadable history alone refuses every reuse and the subject measures
    expect(pendingFreshForce(CAPTURED, RUN, "T1", "")).toMatchObject({ identity: false });
    expect(pendingFreshForce([...CAPTURED, force(5, "")], RUN, "T1", S)).toMatchObject({ identity: false });
    expect(pendingFreshForce([executed(3)], RUN, "T1", S, 1)).toMatchObject({ identity: true });
    expect(pendingFreshForce([executed(3), row("gate-fresh-forced", { attempt: 4, commit: S })], RUN, "T1", S)).toMatchObject({ identity: false });
    expect(pendingFreshForce([executed(3), row("gate-result", { pass: true, commit: S })], RUN, "T1", S)).toMatchObject({ identity: true });
    // review 87x F1: a malformed force's identity: false is never masked by a malformed result before it or by unreadable lines
    const badForce = row("gate-fresh-forced", { attempt: 1, commit: S, reason: "no-commit-out-of-scope-red" });
    const badResult = row("gate-result", { pass: true, commit: S });
    for (const [label, history, unreadable] of [["result first", [badResult, badForce], 0], ["force first", [badForce, badResult], 0],
      ["beside unreadable lines", [badForce], 1], ["result first beside unreadable lines", [badResult, badForce], 2]] as const) {
      expect(pendingFreshForce(history, RUN, "T1", S, unreadable), label).toMatchObject({ kind: "unprovable", identity: false, reason: "a fresh-force row names no readable task, gate or subject" });
    }
    expect(pendingFreshForce([executed(3), force(4, S, { attempt: undefined })], RUN, "T1", S)).toMatchObject({ identity: false, reason: "a fresh-force row names no readable attempt" });
    // review 10f3f4e06080, through the strict reader: a force-shaped row with no readable event refuses every reuse
    for (const event of [undefined, null, 7]) {
      const file = join(makeTestTempDir("force-event-"), "journal.jsonl");
      const owner = executed(3, { nonce: "n3", evidenceReceipt: receipt("n3", "T1", { nonce: "n3" }, 3) });
      writeFileSync(file, [owner, { ts: owner.ts, event, taskId: "T1", data: force(4).data }].map((e) => JSON.stringify(e)).join("\n") + "\n");
      const read = recoveryModule.readAccountingJournal(file);
      expect(read.ok && read.unreadable, String(event)).toBe(0); // the reader keeps the row: the fold must refuse it
      expect(read.ok && pendingFreshForce(read.events, RUN, "T1", S, read.unreadable), String(event))
        .toEqual({ kind: "unprovable", reason: "a journal row names no readable event", identity: true });
      expect(read.ok && testRedEvidence(read.events, RUN, "T1", S), String(event)).toEqual({ kind: "unproved", interrupted: false });
    }
    // review (physical line identity), disk-backed through the daemon's strict read: a blank line before the history
    // shifts every compacted index, yet a line-bound uphold or attempt-cap release still resets the counter — its attempt-0
    // full execution consumes, red or green, and the red is fresh — while an approval-refused row naming an unbound
    // uphold's physical line refuses it, so attempt 0 stays an older attempt
    const lined = (release: string, pass: boolean, refused = false) => {
      const h = [executed(3), force(4), row("gate-result", { gate: "review", pass: false, attempt: 4, commit: S }),
        row("task-human", { kind: release === "attempt-cap" ? "attempt-cap" : "gate-fail", reason: "review red" })];
      // physical line = index + 2 behind the leading blank line
      const approval = row("task-approved", { release, ...(refused ? {} : { park: { line: h.length + 1, ts: h[3]!.ts } }) });
      return [...h, approval, ...(refused ? [row("approval-refused", { lines: [h.length + 2] })] : []), row("task-dispatch", { attempt: 0 }), executed(0, { pass })];
    };
    for (const [cell, history, kind, evidence] of [
      ...(["review-upheld", "attempt-cap"] as const).flatMap((release) => ([false, true] as const).map((pass) =>
        [`a line-bound ${release} release behind a blank line, ${pass ? "green" : "red"}`, lined(release, pass), "none", pass ? "executed" : "fresh"] as const)),
      ["a refused unbound uphold behind a blank line", lined("review-upheld", false, true), "pending", "executed"] as const,
    ]) {
      const file = join(makeTestTempDir("force-lines-"), "journal.jsonl");
      writeFileSync(file, `\n${history.map((e) => JSON.stringify(e)).join("\n")}\n`);
      const read = readTestHistory(file);
      expect(read.ok && read.unreadable, cell).toBe(0);
      expect(read.ok && pendingFreshForce(read.events, RUN, "T1", S, read.unreadable).kind, cell).toBe(kind);
      expect(read.ok && testRedEvidence(read.events, RUN, "T1", S, read.unreadable).kind, cell).toBe(evidence);
    }
    // the reviewer's reproducer, through the strict reader the daemon reads: neither malformed force is ever none
    for (const malformed of [
      { event: "gate-fresh-forced", taskId: "T1", data: { commit: "S", attempt: 4, reason: "no-commit-out-of-scope-red" } },
      { event: "gate-fresh-forced", data: { gate: "test", commit: "S", attempt: 4, reason: "no-commit-out-of-scope-red" } },
    ]) {
      const file = join(makeTestTempDir("force-review-"), "journal.jsonl");
      writeFileSync(file, `${JSON.stringify(malformed)}\n`);
      const read = recoveryModule.readAccountingJournal(file);
      expect(read.ok && pendingFreshForce(read.events, RUN, "T1", "S", read.unreadable), JSON.stringify(malformed)).toMatchObject({ kind: "unprovable", identity: false });
    }

    // ---- review 838 F1, through the daemon: a force row naming no gate after a recheck's persisted executed green,
    // before the restart settles it — whose force it is cannot be established, so the persisted green never merges:
    // the restart parks infra, executing nothing ----
    {
      const malformed = await persistedRecheckThenForce("run-fresh-force-persisted-malformed",
        (commit) => ({ event: "gate-fresh-forced", taskId: "T1", data: { attempt: 9, commit, reason: "no-commit-out-of-scope-red" } }));
      expect(pendingFreshForce(malformed.all, malformed.runId, "T1", malformed.subject)).toMatchObject({ kind: "unprovable", identity: false });
      expect(malformed.reason).toContain("the pending fresh-force accounting is unprovable (a fresh-force row names no readable task, gate or subject)");
    }

    // ---- contradictory evidence through the daemon: rows after the force that only LOOK executed — another task's
    // receipt, a nonce conflicting with its receipt's, a receipt naming another run and no measured commit — match no
    // accounting shape (D-2184 add.43), so the history is unprovable: nothing consumes the force, the waiver's resume
    // still executes the subject fresh (never reuses the cached red) and the park never claims a fresh re-execution ----
    {
      const runId = "run-fresh-force-contradictory";
      const { repo, fake, state, subject } = await forcedThenSemanticPark(runId);
      const journal = Journal.open(repo, runId);
      const base = { gate: "test", pass: false, attempt: 1, commit: subject, details: "contradictory", classification: "regression" };
      // review d2d8aaa41d02 F1, alone on the real journal first: a primary receipt naming another run beside a secondary
      // bound to this run, task, attempt and measured commit never proves the row executed
      const head = String(tests(rows(repo, runId))[0]!.data.subjectHead);
      const bound = { invocationId: "inv-bound", subject: { runId, taskId: "T1", attempt: 1, gate: "test", subjectCommit: head }, termination: { kind: "exit", exitCode: 1 } };
      journal.append("gate-result", "T1", { ...base, fullSuite: true, subjectHead: head, evidenceReceipts: [bound],
        evidenceReceipt: { ...bound, invocationId: "inv-primary", subject: { ...bound.subject, runId: "run-B" } } });
      expect(pendingFreshForce(rows(repo, runId), runId, "T1", subject)).toMatchObject({ kind: "unprovable", identity: true });
      expect(testRedEvidence(rows(repo, runId), runId, "T1", subject)).toEqual({ kind: "unproved", interrupted: false });
      journal.append("gate-result", "T1", { ...base, fullSuite: true, evidenceReceipt: receipt("inv-other-task", "T2", {}, 1) });
      journal.append("gate-result", "T1", { ...base, fullSuite: true, nonce: "n-row", evidenceReceipt: receipt("inv-row", "T1", { nonce: "n-receipt" }, 1) });
      journal.append("gate-result", "T1", { ...base, selectionDecision: { scope: "selected", reason: "admitted", requiredFiles: [OUTSIDE] }, evidenceReceipt: receipt("inv-screen", "T1", {}, 1) });
      expect(pendingFreshForce(rows(repo, runId), runId, "T1", subject)).toMatchObject({ kind: "unprovable", identity: true });
      expect(await approve([runId, "T1", "--waive"], repo)).toContain("waived failed gate review");
      const from = rows(repo, runId).length;
      state.semanticRed = false;
      await runDaemon(repo, { adapters: [fake], runId, resume: true });
      const all = rows(repo, runId);
      const resumed = after(all, from);
      expect(tests(resumed).map((e) => [e.data.commit, e.data.pass, e.data.testExecution, e.data.reused, e.data.replayedFromAttempt]))
        .toEqual([[subject, false, "executed", undefined, undefined]]);
      expect(of(resumed, "gate-reused-verdict").filter((e) => e.data.gate === "test")).toEqual([]);
      expect(of(resumed, "gate-replayed")).toEqual([]);
      expect(of(resumed, "gate-rerun").map((e) => e.data)).toEqual([{ gate: "test", reason: "cached-red-discarded", bypass: "pending-fresh-force" }]);
      const reason = String(of(resumed, "task-human").at(-1)!.data.reason);
      expect(reason).toContain("test: the red's execution and attribution are unproved");
      expect(reason).not.toContain("a fresh re-execution of the unchanged subject failed again");
      expect(pendingFreshForce(all, runId, "T1", subject)).toMatchObject({ kind: "unprovable", identity: true });
      vi.restoreAllMocks();
    }

    // ---- unreadable history with NO readable force, live: a torn line, or a strict read that fails, proves nothing,
    // so the repair round on the unchanged subject neither replays the prior red nor reuses its cached verdict ----
    for (const shape of ["torn line", "failed strict read", "row naming no event", "force row naming no gate", "force row naming no task",
      // review 87x F1: a malformed result row or an unreadable line before it never masks a malformed force's identity
      "force row naming no gate after a result naming no gate", "force row naming no gate beside a torn line"] as const) {
      const runId = `run-fresh-force-unreadable-${shape.replace(/ /g, "-")}`;
      const { repo, fake } = setupRepo(
        [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"], files: ["src/**"] })],
        { consult: { action: "human", notes: "operator decides" },
          tasks: { T1: [{ shell: `mkdir -p src && echo a0 > src/a.txt && ${COMMIT} a0`, result: { ok: true, summary: "a0" } },
            { shell: "true", result: { ok: false, summary: "cannot repair" } }] } },
        stringify({ gates: { build: "true", lint: "true", test: "[ ! -f src/a.txt ] || { echo boom; exit 1; }" } }),
      );
      const original = gateRunner.runGates;
      let calls = 0;
      vi.spyOn(gateRunner, "runGates").mockImplementation(async (task: Task, ctx: GateContext) => {
        const done = await original(task, ctx);
        if (++calls === 1 && shape === "torn line") {
          appendFileSync(join(Journal.open(repo, runId).dir, "journal.jsonl"), "{\"event\":\"gate-fresh-forced\",\"taskId\":\"T1\",\"data\":{\"gate\":\"te\n");
        }
        if (calls === 1 && shape === "row naming no event") { // review 10f3f4e06080: no readable force remains recognizable
          const commit = tests(rows(repo, runId))[0]!.data.commit;
          appendFileSync(join(Journal.open(repo, runId).dir, "journal.jsonl"),
            `${JSON.stringify({ ts: "2026-11-02T10:00:00.000Z", taskId: "T1", data: { gate: "test", attempt: 1, commit, reason: "no-commit-out-of-scope-red" } })}\n`);
        }
        if (calls === 1 && shape.startsWith("force row")) { // review 809 F1: a malformed force on the real subject
          const commit = tests(rows(repo, runId))[0]!.data.commit;
          const data = { attempt: 1, commit, reason: "no-commit-out-of-scope-red" };
          const before = shape.endsWith("after a result naming no gate") ? `${JSON.stringify({ ts: "2026-11-02T10:00:00.000Z", event: "gate-result", taskId: "T1", data: { pass: true, commit } })}\n`
            : shape.endsWith("beside a torn line") ? "{\"event\":\"gate-result\",\"taskId\":\"T1\",\"data\":{\"gate\":\"te\n" : "";
          appendFileSync(join(Journal.open(repo, runId).dir, "journal.jsonl"), `${before}${JSON.stringify(shape !== "force row naming no task"
            ? { ts: "2026-11-02T10:00:00.000Z", event: "gate-fresh-forced", taskId: "T1", data }
            : { ts: "2026-11-02T10:00:00.000Z", event: "gate-fresh-forced", data: { gate: "test", ...data } })}\n`);
        }
        return done;
      });
      if (shape === "failed strict read") vi.spyOn(recoveryModule, "readAccountingJournal").mockReturnValue({ ok: false, error: "EIO: i/o error, read" });
      await runDaemon(repo, { adapters: [fake], runId });
      vi.restoreAllMocks();
      const all = rows(repo, runId);
      expect(of(all, "gate-replayed"), shape).toEqual([]);
      if (shape.startsWith("force row")) {
        // whose force it is cannot be established: the round parks infra, executing and reusing nothing
        expect(calls, shape).toBe(1);
        expect(tests(all).map((e) => [e.data.attempt, e.data.pass, e.data.testExecution]), shape).toEqual([[0, false, "executed"]]);
        expect(of(all, "task-human").at(-1)!.data, shape).toMatchObject({ kind: "infra",
          reason: expect.stringContaining("the pending fresh-force accounting is unprovable (a fresh-force row names no readable task, gate or subject)") });
        expect(of(all, "gate-reused-verdict").filter((e) => e.data.gate === "test"), shape).toEqual([]);
        continue;
      }
      expect(calls, shape).toBe(2);
      expect(tests(all).map((e) => [e.data.attempt, e.data.pass, e.data.testExecution, e.data.reused, e.data.replayedFromAttempt]), shape)
        .toEqual([[0, false, "executed", undefined, undefined], [1, false, "executed", undefined, undefined]]);
      expect(of(all, "gate-reused-verdict").filter((e) => e.data.gate === "test"), shape).toEqual([]);
      expect(of(all, "gate-rerun").map((e) => e.data), shape).toEqual([{ gate: "test", reason: "cached-red-discarded", bypass: "pending-fresh-force" }]);
    }

    // ---- unreadable history through the daemon: a torn journal line beside the pending force parks infra and
    // executes no test — never a consumed force, never a refilled one ----
    const runId = "run-fresh-force-torn";
    const { repo, fake, state, subject } = await forcedThenSemanticPark(runId);
    expect(await approve([runId, "T1", "--waive"], repo)).toContain("waived failed gate review");
    const file = join(Journal.open(repo, runId).dir, "journal.jsonl");
    const from = rows(repo, runId).length;
    appendFileSync(file, "{\"event\":\"gate-result\",\"taskId\":\"T1\",\"data\":{\"gate\":\"te\n");
    state.semanticRed = false;
    await runDaemon(repo, { adapters: [fake], runId, resume: true });
    const all = rows(repo, runId);
    expect(tests(after(all, from))).toEqual([]);
    expect(of(after(all, from), "task-human").at(-1)!.data.kind).toBe("infra");
    expect(readFileSync(file, "utf8")).toContain("{\"gate\":\"te\n");
    expect(pendingFreshForce(all, runId, "T1", subject).kind).toBe("pending");
    expect(pendingFreshForce(all, runId, "T1", subject, 1).kind).toBe("unprovable");
  }, 600_000);
});

describe("row 337 (D-2181 D4): park wording from proof, never from a force marker", () => {
  test("the park wording CASE table names execution or reuse from proven source evidence", async () => {
    const FRESH = "a fresh re-execution of the unchanged subject failed again";
    const interrupted = { disposition: "interrupted", infra: true, interruptions: [SUSPEND], failureWindows: [WINDOW] };
    // [cell, history, attributed wholly outside files[], expected evidence, words it must name]
    const cells: Array<[string, JournalEvent[], boolean, Record<string, unknown>, string]> = [
      ["reused × outside scope (captured attempt five, its stored origin stamped)", [...CAPTURED, reused(5, { originAttempt: 3 })], true,
        { kind: "reused", source: 3 }, "test: reused attempt 3's verdict; not re-executed"],
      // D-2184 add.46, the closed source rule: a pre-upgrade cache record carries no origin, so its exact receipt is never joined
      ["reused × outside scope (captured attempt five, pre-upgrade cache record with no stored origin)", [...CAPTURED, reused(5)], true,
        { kind: "reused", source: undefined }, "test: reused verdict; source attempt unknown; not re-executed"],
      ["reused × outside scope (recorded origin)", [...CAPTURED, reused(5, { originAttempt: 3, evidenceReceipt: undefined })], true,
        { kind: "reused", source: 3 }, "test: reused attempt 3's verdict; not re-executed"],
      ["executed × outside scope after the subject's force", [...CAPTURED, executed(5)], true,
        { kind: "fresh" }, `test: ${FRESH} only in files outside files[] — no repair can reach them`],
      ["executed × outside scope with no force", [executed(3)], true, { kind: "executed" }, "test: an executed full test run failed only in files outside files[]"],
      ["executed × outside scope before the force", [executed(3), force(4)], true, { kind: "executed" }, "test: an executed full test run failed only in files outside files[]"],
      // review (resettable attempt counters): an enacted uphold's attempt-0 red is a fresh re-execution; after a refused one it is an older attempt
      ["executed × outside scope in an enacted uphold's new engagement", [...engaged("review-upheld"), executed(0)], true,
        { kind: "fresh" }, `test: ${FRESH} only in files outside files[] — no repair can reach them`],
      ["executed × outside scope after a refused uphold", [...engaged("review-upheld", true), executed(0)], true,
        { kind: "executed" }, "test: an executed full test run failed only in files outside files[]"],
      // review (non-resetting events): a waive, a recheck or another task's retry-failed resume resets nothing, so an older
      // attempt journaled late is executed, never fresh; this task's own dispatch-failure retry starts a new engagement
      ...(["gate-satisfied", "recheck"] as const).map((release): [string, JournalEvent[], boolean, Record<string, unknown>, string] =>
        [`executed × outside scope: an effective ${release} release's late attempt-3 red`, [...bound(release), executed(3)], true,
          { kind: "executed" }, "test: an executed full test run failed only in files outside files[]"]),
      ["executed × outside scope after another task's retry-failed resume", [...retried("T2"), executed(3)], true,
        { kind: "executed" }, "test: an executed full test run failed only in files outside files[]"],
      ["executed × outside scope after this task's retry-failed resume", [...retried("T1"), executed(0)], true,
        { kind: "fresh" }, `test: ${FRESH} only in files outside files[] — no repair can reach them`],
      ["reused × interrupted", [...CAPTURED, reused(5, { originAttempt: 3, ...interrupted })], true,
        { kind: "reused", source: 3, interrupted: true }, "test: reused attempt 3's verdict; interrupted, inconclusive and not re-executed"],
      ["executed × interrupted", [...CAPTURED, executed(5, interrupted)], true, { kind: "fresh", interrupted: true }, "interrupted — inconclusive infrastructure, not a worker defect"],
      ["reused × in scope", [executed(3), reused(4, { originAttempt: 3 })], false, { kind: "reused", source: 3 }, "test: reused attempt 3's verdict; not re-executed"],
      ["executed × in scope", [executed(3)], false, { kind: "executed" }, "test: an executed full test run failed (not attributed wholly outside files[])"],
      ["reused, legacy unknown provenance (no origin, no receipt)", [...CAPTURED, reused(5, { evidenceReceipt: undefined })], true,
        { kind: "reused", source: undefined }, "test: reused verdict; source attempt unknown; not re-executed"],
      ["reused, legacy receipt of one of two owned executions, no stamp", [executed(3), executed(4), force(5), reused(6, { evidenceReceipts: [receipt("inv-4")] })], true,
        { kind: "reused", source: undefined }, "test: reused verdict; source attempt unknown; not re-executed"],
      // no stamp: the exact receipt of attempt three's owned execution is never joined to name it
      ["reused, a legacy receipt copy between the original and the reuse, no stamp", [executed(3), executed(4, { evidenceReceipt: receipt("inv-3", "T1", {}, 4) }), force(5), reused(6)], true,
        { kind: "reused", source: undefined }, "test: reused verdict; source attempt unknown; not re-executed"],
      ["reused, origin of another attempt never borrowed from the current one", [...CAPTURED, reused(5, { evidenceReceipt: receipt("inv-9") })], true,
        { kind: "reused", source: undefined }, "source attempt unknown"],
      ["journal replay copy stamped with its lender's attempt", [executed(3), force(4), executed(5, { replayedFromAttempt: 3, originAttempt: 3, evidenceReceipt: undefined })], true,
        { kind: "reused", source: 3 }, "test: reused attempt 3's verdict; not re-executed"],
      ["journal replay copy carrying its lender's receipt but no stamp", [executed(3), force(4), executed(5, { replayedFromAttempt: 3, evidenceReceipt: receipt("inv-3", "T1", {}, 3) })], true,
        { kind: "reused", source: undefined }, "test: reused verdict; source attempt unknown; not re-executed"],
      ["reused nonce-bound exact receipt, no stamp", [executed(3, { nonce: "n-3", evidenceReceipt: receipt("u-3", "T1", { nonce: "n-3" }, 3) }), force(4),
        reused(5, { evidenceReceipt: receipt("u-3", "T1", { nonce: "n-3" }, 3) })], true, { kind: "reused", source: undefined }, "test: reused verdict; source attempt unknown; not re-executed"],
      // replayedFromAttempt and receipts never name a source: only the row's own stamp does
      ["reused receipt sharing attempt three's invocation id with a conflicting nonce", [...CAPTURED, reused(5, { evidenceReceipt: receipt("inv-3", "T1", { nonce: "n-conflict" }) })], true,
        { kind: "reused", source: undefined }, "test: reused verdict; source attempt unknown; not re-executed"],
      ["journal replay copy naming attempt three with no receipt", [executed(3), force(4), executed(5, { replayedFromAttempt: 3, evidenceReceipt: undefined })], true,
        { kind: "reused", source: undefined }, "test: reused verdict; source attempt unknown; not re-executed"],
      ["journal replay copy naming attempt three with an unrelated receipt", [executed(3), force(4), executed(5, { replayedFromAttempt: 3, evidenceReceipt: receipt("inv-9") })], true,
        { kind: "reused", source: undefined }, "source attempt unknown"],
      ["journal replay copy naming attempt three carrying attempt four's receipt", [executed(3), executed(4), force(5), executed(6, { replayedFromAttempt: 3, evidenceReceipt: receipt("inv-4") })], true,
        { kind: "reused", source: undefined }, "source attempt unknown"],
      ["reused red carrying another task's receipt", [...CAPTURED, reused(5, { evidenceReceipt: receipt("inv-3", "T2") })], true,
        { kind: "reused", source: undefined }, "source attempt unknown"],
      // contradictory execution evidence after the force never earns the fresh-again sentence
      ["a red whose nonce conflicts with its receipt, after the force", [...CAPTURED, executed(5, { nonce: "n-5" })], true, { kind: "unproved" }, "unproved"],
      ["a T1 red carrying T2's receipt, after the force", [...CAPTURED, executed(5, { evidenceReceipt: receipt("inv-5", "T2", {}, 5) })], true, { kind: "unproved" }, "unproved"],
      // review 838 F3: a red whose receipt and nonce an earlier row on another subject already carried is a copy — never fresh
      ["a post-force red copying another subject's earlier receipt and nonce", [executed(2, { commit: OTHER, nonce: "n-2", evidenceReceipt: receipt("inv-2", "T1", { nonce: "n-2" }, 2) }),
        force(4), executed(5, { nonce: "n-2", evidenceReceipt: receipt("inv-2", "T1", { nonce: "n-2" }, 5) })], true, { kind: "unproved" }, "unproved"],
      ["a post-force red copying this subject's pre-force receipt", [...CAPTURED, executed(5, { evidenceReceipt: receipt("inv-3", "T1", {}, 5) })], true, { kind: "unproved" }, "unproved"],
      ["a recorded selected-scope red without fullSuite, after the force", [...CAPTURED, executed(5, { fullSuite: undefined, selectionDecision: { scope: "selected", reason: "admitted", requiredFiles: [OUTSIDE] } })], true,
        { kind: "screen" }, "test: an executed selected-test screen failed; no full run of this subject was journaled"],
      ["selected screen after the force", [...CAPTURED, executed(5, { fullSuite: undefined, selectedTests: [OUTSIDE] })], true,
        { kind: "screen" }, "test: an executed selected-test screen failed; no full run of this subject was journaled"],
      // review 87x: an interrupted selected screen is never worded as a full run
      ["interrupted selected screen after the force", [...CAPTURED, executed(5, { fullSuite: undefined, selectedTests: [OUTSIDE], ...interrupted })], false,
        { kind: "screen", interrupted: true }, "test: an executed selected-test screen was interrupted — inconclusive infrastructure, not a worker defect; no full run of this subject was journaled"],
      // review 87x F2: ownership compares effective nonces, and a source is only ever an OWNED execution
      ["a post-force red whose receipt nonce is an earlier receipt's invocation id (effective nonce alias)", [executed(2, { commit: OTHER, nonce: "n", evidenceReceipt: receipt("n", "T1", { nonce: "n" }, 2) }),
        force(4), executed(5, { nonce: "n", evidenceReceipt: receipt("u-new", "T1", { nonce: "n" }, 5) })], true, { kind: "unproved" }, "unproved"],
      ["a legacy reuse of a non-owning exact copy names no source", [executed(2, { commit: OTHER, nonce: "n", evidenceReceipt: receipt("u", "T1", { nonce: "n" }, 2) }), force(4),
        executed(5, { nonce: "n", evidenceReceipt: receipt("u", "T1", { nonce: "n" }, 5) }), reused(6, { evidenceReceipt: receipt("u", "T1", { nonce: "n" }, 5) })], true,
        { kind: "reused", source: undefined }, "test: reused verdict; source attempt unknown; not re-executed"],
      // D-2184 add.46: the stamp alone names the source — a receipt or replayed attempt disagreeing with it never vetoes
      // or replaces it (the replay projection is what never stamps a copy's lent source: replaySource below)
      ["a replay whose stamp disagrees with its replayed attempt and receipt names its stamp", [...CAPTURED, executed(5), executed(6, { evidenceReceipt: receipt("inv-5", "T1", {}, 6) }),
        executed(7, { replayedFromAttempt: 6, originAttempt: 5, evidenceReceipt: receipt("inv-5", "T1", {}, 6) })], true, { kind: "reused", source: 5 }, "test: reused attempt 5's verdict; not re-executed"],
      ["a replay of a legacy copy with no stamp names no source", [...CAPTURED, executed(5), executed(6, { evidenceReceipt: receipt("inv-5", "T1", {}, 6) }),
        executed(7, { replayedFromAttempt: 6, evidenceReceipt: receipt("inv-5", "T1", {}, 6) })], true, { kind: "reused", source: undefined }, "source attempt unknown"],
      // review 2ad34ffeaa5b: an attempt-five red carrying an attempt-three receipt executed nothing at five, and a later
      // reuse of that receipt never names attempt five as its source
      ["a post-force red carrying a receipt stamped for an earlier attempt", [executed(3, { evidenceReceipt: undefined }), force(4),
        executed(5, { nonce: "old-3", evidenceReceipt: stamped("old-3", 3) })], true, { kind: "unproved" }, "unproved"],
      // review 7d5be6ffbe57: a reuse is worded from its own stamp alone, so an unprovable neighbour names no source for it
      ["a reuse of a receipt the attempt-five row only carried names no source", [executed(3, { evidenceReceipt: undefined }), force(4),
        executed(5, { nonce: "old-3", evidenceReceipt: stamped("old-3", 3) }), reused(6, { evidenceReceipt: stamped("old-3", 3) })], true,
        { kind: "reused", source: undefined }, "test: reused verdict; source attempt unknown; not re-executed"],
      ["a reuse stamped with its owned execution's attempt names it", [executed(3, { nonce: "n-3", evidenceReceipt: stamped("n-3", 3) }), force(4),
        reused(5, { originAttempt: 3, evidenceReceipt: stamped("n-3", 3) })], true, { kind: "reused", source: 3 }, "test: reused attempt 3's verdict; not re-executed"],
      // review 2ca692d7c9cd: an older attempt journaled after the force executed BEFORE it — executed, never fresh, and
      // its reuse names that attempt; a missing, string or contradicting attempt proves no execution, so no source
      ["an earlier attempt's red journaled after the force", [...LATE, lateRow(3, 3, false)], true, { kind: "executed" },
        "test: an executed full test run failed only in files outside files[]"],
      ["a reuse of that late row stamped attempt three names it", [...LATE, lateRow(3, 3, false), lateRow(6, 3, false, { reused: true, nonce: undefined, originAttempt: 3 })], true,
        { kind: "reused", source: 3 }, "test: reused attempt 3's verdict; not re-executed"],
      ...LATE_CELLS.slice(1).flatMap(([label, attempt, stamp]): Array<[string, JournalEvent[], boolean, Record<string, unknown>, string]> => [
        [`${label}: its red is unproved`, [...LATE, lateRow(attempt, stamp, false)], true, { kind: "unproved" }, "unproved"],
        [`${label}: the row matches no shape, and an unstamped reuse after it names no source`, [...LATE, lateRow(attempt, stamp, false), lateRow(6, stamp, false, { reused: true, nonce: undefined })], true,
          { kind: "reused", source: undefined }, "test: reused verdict; source attempt unknown; not re-executed"]]),
      // review 2b-4 F1: a red after the force whose receipt names another run or a null subject commit is unproved
      ["a post-force red whose receipt names another run", [...CAPTURED, executed(5, { evidenceReceipt: { ...receipt("inv-5", "T1", {}, 5), subject: { ...receipt("inv-5", "T1", {}, 5).subject, runId: "run-B" } } })], true,
        { kind: "unproved" }, "unproved"],
      ["a post-force red whose receipt has a null subject commit", [...CAPTURED, executed(5, { evidenceReceipt: { ...receipt("inv-5", "T1", {}, 5), subject: { ...receipt("inv-5", "T1", {}, 5).subject, subjectCommit: null } } })], true,
        { kind: "unproved" }, "unproved"],
      // D-2184 add.46: owners at three and four, a reuse carrying attempt four's receipt but stamped origin three: the stamp
      ["a reuse whose stamped origin disagrees with its receipt names its stamp", [executed(3), executed(4), force(5), reused(6, { originAttempt: 3, evidenceReceipt: receipt("inv-4", "T1", {}, 4) })], true,
        { kind: "reused", source: 3 }, "test: reused attempt 3's verdict; not re-executed"],
      // ... and a stamped reuse whose receipt names another attempt, run or commit: the receipt neither vetoes nor replaces it
      ...([["attempt", 99], ["runId", "run-B"], ["subjectCommit", "head-B"]] as const).map(([field, value]): [string, JournalEvent[], boolean, Record<string, unknown>, string] =>
        [`a stamped reuse whose receipt names ${field} ${value} names its stamp`, [executed(3), force(4),
          reused(5, { originAttempt: 3, evidenceReceipt: { ...receipt("inv-3", "T1", {}, 3), subject: { ...receipt("inv-3", "T1", {}, 3).subject, [field]: value } } })], true,
          { kind: "reused", source: 3 }, "test: reused attempt 3's verdict; not re-executed"]),
      // review 2b-4 F2: fullSuite false is not a full execution — never the fresh sentence
      ["a post-force red with fullSuite false and no selection fields", [...CAPTURED, executed(5, { fullSuite: false })], true,
        { kind: "unproved" }, "unproved"],
      // a refusal after the force is no fresh failure: a dirty-tree refusal or an infra non-verdict is worded unproved
      ["a post-force dirty-tree refusal", [...CAPTURED, executed(5, { dirtyWorktree: true, dirtyPaths: ["litter.txt"] })], true, { kind: "unproved" }, "unproved"],
      ["a post-force stale-proof infra red", [...CAPTURED, executed(5, { infra: true, classification: "infra", staleProof: true })], true, { kind: "unproved" }, "unproved"],
      // review 9e6258d19cb1: an infra classification, a ceiling kill or a hang without the infra flag is no fresh failure
      ...([{ classification: "infra" }, { kind: "ceiling-kill" }, { kind: "hang" }] as const).map((extra): [string, JournalEvent[], boolean, Record<string, unknown>, string] =>
        [`a post-force ${JSON.stringify(extra)} red without the infra flag`, [...CAPTURED, executed(5, extra)], true, { kind: "unproved" }, "unproved"]),
      ["a row naming no event beside an executed red", [executed(3), { ts: "2026-11-02T10:00:00.000Z", taskId: "T1", data: force(4).data } as unknown as JournalEvent], true,
        { kind: "unproved" }, "unproved"],
      ["execution unproved (no receipt, no reuse flag)", [...CAPTURED, executed(5, { evidenceReceipt: undefined })], true,
        { kind: "unproved" }, "unproved"],
      ["another subject's red", [executed(3, { commit: OTHER }), force(4)], true, { kind: "unproved" }, "unproved"],
      ["another subject's force", [force(2, OTHER), executed(3)], true, { kind: "executed" }, "test: an executed full test run failed"],
      ["a force row, a phase-start and an approval alone", [force(4), row("phase-start", { phase: "gates" }), row("task-approved", { release: "recheck" })], true,
        { kind: "unproved" }, "unproved"],
    ];
    for (const [cell, history, outside, evidence, words] of cells) {
      const found = testRedEvidence(history, RUN, "T1", S);
      expect(found, cell).toMatchObject({ interrupted: false, ...evidence });
      const text = testRedWording(found, outside);
      expect(text, cell).toContain(words);
      if (evidence.kind !== "fresh" || evidence.interrupted === true) expect(text, cell).not.toContain(FRESH);
      if (evidence.kind === "unproved") for (const claim of ["fresh", "unchanged", "again", "only in files outside"]) expect(text, `${cell}: ${claim}`).not.toContain(claim);
      if (!outside) expect(text, cell).not.toContain("only in files outside");
      if (evidence.kind === "reused") expect(text, cell).toContain("not re-executed");
    }
    // the replay stamp's rule: a legacy receipt copy owns no execution, so it lends no source; its owner lends its own attempt
    const copied = [...CAPTURED, executed(5), executed(6, { evidenceReceipt: receipt("inv-5", "T1", {}, 6) })];
    expect(replaySource(copied, RUN, copied.length - 1)).toBeUndefined();
    expect(replaySource(copied, RUN, copied.length - 2)).toBe(5);
    // review 2ca692d7c9cd: a missing or string attempt leaves the history unprovable, so no lender lends a source
    for (const [label, attempt, stamp] of LATE_CELLS) {
      expect(replaySource([...LATE, lateRow(attempt, stamp, true)], RUN, 2), label).toBe(label === LATE_CELLS[0]![0] ? 3 : undefined);
    }
    const alien = [executed(2, { commit: OTHER, nonce: "n", evidenceReceipt: receipt("u", "T1", { nonce: "n" }, 2) }), force(4), executed(5, { nonce: "n", evidenceReceipt: receipt("u", "T1", { nonce: "n" }, 5) })];
    expect(replaySource(alien, RUN, 2)).toBeUndefined();
    expect(testRedWording({ kind: "screen", interrupted: true }, false)).not.toContain("full test run");
    // the fresh sentence is the existing outside-scope reason, byte-for-byte
    expect(testRedWording({ kind: "fresh", interrupted: false }, true))
      .toBe("test: a fresh re-execution of the unchanged subject failed again only in files outside files[] — no repair can reach them");
    // interrupted settlement precedes the outside-scope park: an interrupted red is never an outside-scope red
    const task = validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"], files: ["src/**"] })] }).tasks[0]!;
    const red = { ...executed(5).data, disposition: "behavioral", details: ` FAIL  ${OUTSIDE} > reads one\nAssertionError: expected one to be two${CLEAN}` };
    expect(outsideScopeRed(task, "T1", red, S)).toBe(true);
    expect(outsideScopeRed(task, "T1", { ...red, interruptions: [SUSPEND], failureWindows: [{ ...WINDOW, file: OUTSIDE }] }, S)).toBe(false);
    expect(outsideScopeRed(task, "T1", { ...red, disposition: "interrupted" }, S)).toBe(false);
    // the park seam reads history through the fold's own validation boundary: a malformed force row proves nothing
    expect(testRedEvidence([...CAPTURED, executed(5), row("gate-fresh-forced", { attempt: 6, commit: S })], RUN, "T1", S)).toEqual({ kind: "unproved", interrupted: false });
    // an unreadable line could hide a force, a contradicting receipt or the consumer: never executed, fresh or screen —
    // but a reuse still names its own stamp (D-2184 add.46)
    for (const [cell, history] of [["fresh", [...CAPTURED, executed(5)]], ["executed", [executed(3)]],
      ["screen", [...CAPTURED, executed(5, { fullSuite: undefined, selectedTests: [OUTSIDE] })]]] as const) {
      expect(testRedEvidence(history, RUN, "T1", S, 1), cell).toEqual({ kind: "unproved", interrupted: false });
    }
    expect(testRedEvidence([...CAPTURED, reused(5, { originAttempt: 3 })], RUN, "T1", S, 1)).toMatchObject({ kind: "reused", source: 3 });

    // ---- the torn-line review, through the daemon's emitted park: attempt 0's executed outside red forces attempt 1,
    // a torn line lands after the force, and attempt 1 executes a full red outside files[]. The strict fold reads the
    // history unprovable, so the outside-scope park never claims a fresh re-execution: its execution is unproved ----
    {
      const runId = "run-park-wording-torn-after-force";
      const { repo, fake } = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"], files: ["src/**"] })],
        { consult: { action: "human", notes: "operator decides" },
          tasks: { T1: [{ shell: `mkdir -p src && echo a0 > src/a.txt && ${COMMIT} a0`, result: { ok: true, summary: "a0" } },
            ...["r1", "r2", "r3"].map((id) => ({ shell: "true", result: { ok: true, summary: id } }))] } },
        stringify({ gates: { build: "true", lint: "true",
          test: `[ ! -f src/a.txt ] || { echo ' FAIL  ${OUTSIDE} > reads one'; echo 'AssertionError: expected one to be two'; exit 1; }` } }));
      const original = gateRunner.runGates;
      let calls = 0;
      vi.spyOn(gateRunner, "runGates").mockImplementation(async (task: Task, ctx: GateContext) => {
        if (++calls === 2) appendFileSync(join(Journal.open(repo, runId).dir, "journal.jsonl"), "{\"event\":\"gate-result\",\"taskId\":\"T1\",\"data\":{\"gate\":\"te\n");
        return original(task, { ...ctx, onGate: async (e) => {
          if (e.phase === "end" && e.result.gate === "test" && !e.result.pass) {
            e.result.meta = { ...e.result.meta, classification: "regression", failingFiles: [OUTSIDE], fullSuite: true };
            e.result.details += CLEAN;
          }
          await ctx.onGate?.(e);
        } });
      });
      expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
      vi.restoreAllMocks();
      const all = Journal.open(repo, runId).read();
      const reds = all.filter((e) => e.taskId === "T1" && e.event === "gate-result" && e.data.gate === "test");
      expect(calls).toBe(2);
      expect(reds.map((e) => [e.data.attempt, e.data.pass, e.data.testExecution])).toEqual([[0, false, "executed"], [1, false, "executed"]]);
      expect(all.filter((e) => e.taskId === "T1" && e.event === "gate-fresh-forced").map((e) => e.data.attempt)).toEqual([1]);
      // the tolerant read alone would prove a fresh re-execution — the defect this cell pins
      expect(testRedEvidence(all, runId, "T1", String(reds[1]!.data.commit))).toMatchObject({ kind: "fresh" });
      const park = all.filter((e) => e.taskId === "T1" && e.event === "task-human").at(-1)!;
      expect(park.data.kind).toBe("gate-fail");
      expect(String(park.data.reason)).toContain("test: the red's execution and attribution are unproved");
      expect(String(park.data.reason)).not.toContain(FRESH);
    }

    // ---- review 809 F3, through the daemon: an IN-SCOPE test red reaching a consult's human verdict parks with the
    // EMITTED reason naming what that red proves beside the consult's own text — executed when the worker's new
    // commit ran it, the reused source attempt when the repair landed nothing and the round replayed it ----
    const IN_SCOPE = " (not attributed wholly outside files[])";
    for (const [cell, repair, words] of [
      ["executed × in scope", `echo r >> src/a.txt && ${COMMIT} r`, `test: an executed full test run failed${IN_SCOPE}`],
      ["reused × in scope", "true", `test: reused attempt 0's verdict; not re-executed — its recorded red failed${IN_SCOPE}`],
    ] as const) {
      const runId = `run-park-wording-${cell.startsWith("executed") ? "executed" : "reused"}-in-scope`;
      const { repo, fake } = setupRepo(
        [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"], files: ["src/**"] })],
        { consult: { action: "human", notes: "operator decides" },
          tasks: { T1: [{ shell: `mkdir -p src && echo a0 > src/a.txt && ${COMMIT} a0`, result: { ok: true, summary: "a0" } },
            ...["r1", "r2", "r3", "r4", "r5"].map((id) => ({ shell: repair, result: { ok: true, summary: id } }))] } },
        stringify({ gates: { build: "true", lint: "true",
          test: "[ ! -f src/a.txt ] || { echo ' FAIL  src/a.test.ts > reads one'; echo 'AssertionError: expected one to be two'; exit 1; }" } }),
      );
      const live = await runDaemon(repo, { adapters: [fake], runId });
      expect(live.human, cell).toEqual(["T1"]);
      const all = Journal.open(repo, runId).read();
      const park = all.filter((e) => e.taskId === "T1" && e.event === "task-human").at(-1)!;
      expect(String(park.data.reason), cell).toContain(words);
      expect(String(park.data.reason), cell).not.toContain(FRESH);
      expect(String(park.data.reason), cell).not.toContain("only in files outside");
      // the trigger's own reason is kept, the sentence beside it — never in place of it
      expect(String(park.data.reason).startsWith("test:"), cell).toBe(false);
    }

    // ---- acceptance c1, through the daemon's journal replay: attempt 0's owned full execution consumed a force on its
    // subject, and a legacy attempt-1 row then copied its invocation without reuse flags (spliced by the attempt-2
    // worker, before that round's gates read the journal; its receipt restamped for attempt 1, so it is a well-formed
    // copy that owns nothing). The repair round replaying attempt 1 never names the copying row's own attempt, and the
    // copy's receipt disagrees with the owned execution's, so its stamped origin and wording name an unknown source ----
    {
      const runId = "run-park-wording-replayed-receipt-copy";
      const dir = makeTestTempDir("force-copy-");
      writeFileSync(join(dir, "splice.mjs"), `import { readFileSync, writeFileSync } from "node:fs";
const file = readFileSync(${JSON.stringify(join(dir, "journal-path"))}, "utf8");
const rows = readFileSync(file, "utf8").trimEnd().split("\\n").map((line) => JSON.parse(line));
const at = (attempt) => rows.findIndex((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "test" && e.data.attempt === attempt);
const owner = rows[at(0)];
const restamp = (r) => ({ ...r, subject: { ...r.subject, attempt: 1 } });
rows[at(1)] = { ...rows[at(1)], data: { ...owner.data, attempt: 1, evidenceReceipt: restamp(owner.data.evidenceReceipt),
  ...(owner.data.evidenceReceipts ? { evidenceReceipts: owner.data.evidenceReceipts.map(restamp) } : {}) } };
rows.splice(at(0), 0, { ts: owner.ts, event: "gate-fresh-forced", taskId: "T1",
  data: { gate: "test", attempt: 0, priorAttempt: -1, commit: owner.data.commit, reason: "no-commit-out-of-scope-red" } });
writeFileSync(file, rows.map((e) => JSON.stringify(e)).join("\\n") + "\\n");
`);
      const { repo, fake } = setupRepo(
        [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"], files: ["src/**"] })],
        { consult: { action: "human", notes: "operator decides" },
          tasks: { T1: [{ shell: `mkdir -p src && echo a0 > src/a.txt && ${COMMIT} a0`, result: { ok: true, summary: "a0" } },
            { shell: "true", result: { ok: true, summary: "r1" } },
            { shell: `node '${join(dir, "splice.mjs")}'`, result: { ok: true, summary: "r2" } },
            ...["r3", "r4", "r5"].map((id) => ({ shell: "true", result: { ok: true, summary: id } }))] } },
        stringify({ gates: { build: "true", lint: "true",
          test: "[ ! -f src/a.txt ] || { echo ' FAIL  src/a.test.ts > reads one'; echo 'AssertionError: expected one to be two'; exit 1; }" } }),
      );
      writeFileSync(join(dir, "journal-path"), join(repo, ".tickmarkr", "runs", runId, "journal.jsonl"));
      expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
      const all = Journal.open(repo, runId).read();
      const [owner, copy, replayed] = all.filter((e) => e.taskId === "T1" && e.event === "gate-result" && e.data.gate === "test");
      const subject = String(owner!.data.commit);
      // the splice landed: a forced subject, its owned execution, then a flagless copy of that execution's receipt
      expect(owner!.data).toMatchObject({ attempt: 0, testExecution: "executed" });
      const ownerReceipt = owner!.data.evidenceReceipt as { invocationId: string; subject: Record<string, unknown> };
      expect(copy!.data).toMatchObject({ attempt: 1, testExecution: "executed",
        evidenceReceipt: { invocationId: ownerReceipt.invocationId, subject: { ...ownerReceipt.subject, attempt: 1 } } });
      expect(copy!.data.replayedFromAttempt).toBeUndefined();
      expect(pendingFreshForce(all.slice(0, all.indexOf(copy!)), runId, "T1", subject)).toEqual({ kind: "none" });
      expect(pendingFreshForce(all.slice(0, all.indexOf(copy!) + 1), runId, "T1", subject)).toEqual({ kind: "none" }); // a well-formed copy
      expect(replayed!.data).toMatchObject({ attempt: 2, commit: subject, replayedFromAttempt: 1, testExecution: "reused" });
      expect(replayed!.data.originAttempt).toBeUndefined();
      expect(testRedWording(testRedEvidence(all.slice(0, all.indexOf(replayed!) + 1), runId, "T1", subject), false))
        .toBe(`test: reused verdict; source attempt unknown; not re-executed — its recorded red failed${IN_SCOPE}`);
      // the park lands on a later round's CACHE hit, whose stored origin and carried receipt both name the owned
      // attempt-0 execution: that source is proven, and neither copying attempt is ever named
      const parked = all.filter((e) => e.taskId === "T1" && e.event === "gate-result" && e.data.gate === "test").at(-1)!;
      expect(parked.data).toMatchObject({ testExecution: "reused", originAttempt: 0, evidenceReceipt: owner!.data.evidenceReceipt });
      const reason = String(all.filter((e) => e.taskId === "T1" && e.event === "task-human").at(-1)!.data.reason);
      expect(reason).toContain(`test: reused attempt 0's verdict; not re-executed — its recorded red failed${IN_SCOPE}`);
      expect(reason).not.toMatch(/attempt [12]'s verdict/);
    }

    // ---- review 1080, through the daemon's journal replay: attempt 1's row is an OWNED selected-test screen (its own
    // started invocation, spliced by the attempt-2 worker before that round's gates read the journal). The repair round
    // replaying attempt 1 stamps the screen's own attempt as its source, so its wording names attempt 1 — never unknown ----
    {
      const runId = "run-park-wording-replayed-screen";
      const dir = makeTestTempDir("force-screen-");
      writeFileSync(join(dir, "splice.mjs"), `import { readFileSync, writeFileSync } from "node:fs";
const file = readFileSync(${JSON.stringify(join(dir, "journal-path"))}, "utf8");
const rows = readFileSync(file, "utf8").trimEnd().split("\\n").map((line) => JSON.parse(line));
const at = (attempt) => rows.findIndex((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "test" && e.data.attempt === attempt);
const owner = rows[at(0)];
const { fullSuite, evidenceReceipts, nonce, ...data } = owner.data;
const r = owner.data.evidenceReceipt;
rows[at(1)] = { ...rows[at(1)], data: { ...data, attempt: 1, selectedTests: ["src/a.test.ts"],
  selectionDecision: { scope: "selected", reason: "admitted", requiredFiles: ["src/a.test.ts"] },
  ...(nonce === undefined ? {} : { nonce: "screen-1" }),
  evidenceReceipt: { ...r, invocationId: "screen-1", ...(r.nonce === undefined ? {} : { nonce: "screen-1" }), subject: { ...r.subject, attempt: 1 } } } };
writeFileSync(file, rows.map((e) => JSON.stringify(e)).join("\\n") + "\\n");
`);
      const { repo, fake } = setupRepo(
        [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"], files: ["src/**"] })],
        { consult: { action: "human", notes: "operator decides" },
          tasks: { T1: [{ shell: `mkdir -p src && echo a0 > src/a.txt && ${COMMIT} a0`, result: { ok: true, summary: "a0" } },
            { shell: "true", result: { ok: true, summary: "r1" } },
            { shell: `node '${join(dir, "splice.mjs")}'`, result: { ok: true, summary: "r2" } },
            ...["r3", "r4", "r5"].map((id) => ({ shell: "true", result: { ok: true, summary: id } }))] } },
        stringify({ gates: { build: "true", lint: "true",
          test: "[ ! -f src/a.txt ] || { echo ' FAIL  src/a.test.ts > reads one'; echo 'AssertionError: expected one to be two'; exit 1; }" } }),
      );
      writeFileSync(join(dir, "journal-path"), join(repo, ".tickmarkr", "runs", runId, "journal.jsonl"));
      expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
      const all = Journal.open(repo, runId).read();
      const [, screened, replayed] = all.filter((e) => e.taskId === "T1" && e.event === "gate-result" && e.data.gate === "test");
      const subject = String(screened!.data.commit);
      // the splice landed: attempt 1 is an owned selected screen on the subject, which a full force never counts
      expect(screened!.data).toMatchObject({ attempt: 1, testExecution: "executed", selectedTests: ["src/a.test.ts"], evidenceReceipt: { invocationId: "screen-1" } });
      expect(replaySource(all, runId, all.indexOf(screened!))).toBe(1);
      expect(replayed!.data).toMatchObject({ attempt: 2, commit: subject, replayedFromAttempt: 1, testExecution: "reused", originAttempt: 1 });
      expect(testRedWording(testRedEvidence(all.slice(0, all.indexOf(replayed!) + 1), runId, "T1", subject), false))
        .toBe(`test: reused attempt 1's verdict; not re-executed — its recorded red failed${IN_SCOPE}`);
      // and the park the replayed red reaches is emitted with that sentence beside the trigger's own reason
      expect(String(all.filter((e) => e.taskId === "T1" && e.event === "task-human").at(-1)!.data.reason))
        .toContain(`test: reused attempt 1's verdict; not re-executed — its recorded red failed${IN_SCOPE}`);
    }
  }, 600_000);
});

describe("row 337 (D-2181 D3 D4): review d2d8aaa41d02 — every started receipt binds, discovery never invalidates, a replay carries its lender's source", () => {
  const FRESH = "a fresh re-execution of the unchanged subject failed again";
  /** A started receipt stamped for `attempt`, with any subject field overridden. */
  const at = (id: string, attempt: number, subject: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const r = receipt(id, "T1", extra, attempt);
    return { ...r, subject: { ...r.subject, ...subject } };
  };
  const listing = (a: number) => at(`l${a}-listing`, a, {}, { nonce: `l${a}-listing` });
  const unstarted = (a: number) => ({ ...at(`spawn-${a}`, a, { subjectCommit: null }), termination: { kind: "not-started", exitCode: null } });

  test("a contradictory started receipt anywhere refuses consumption and fresh wording, discovery and unstarted spawns never stop an owner lending its attempt, and a replay chain carries its lender's source unchanged", () => {
    // ---- F1: the bad receipt as primary or secondary, beside one bound to this run, task, attempt and measured commit ----
    const corruptions: Array<[string, Record<string, unknown>]> = [["another run", { runId: "run-B" }], ["a null subject commit", { subjectCommit: null }],
      ["another subject commit", { subjectCommit: "head-B" }], ["another task", { taskId: "T2" }], ["another attempt", { attempt: 4 }], ["a string attempt", { attempt: "5" }]];
    for (const [label, bad] of corruptions) for (const primaryBad of [true, false]) for (const pass of [false, true]) {
      const good = at("good-5", 5), wrong = at("bad-5", 5, bad);
      const h = [...CAPTURED, executed(5, { pass, evidenceReceipt: primaryBad ? wrong : good, evidenceReceipts: [primaryBad ? good : wrong] })];
      const cell = `${label} on the ${primaryBad ? "primary" : "secondary"} receipt, ${pass ? "green" : "red"}`;
      expect(pendingFreshForce(h, RUN, "T1", S), cell).toMatchObject({ kind: "unprovable", identity: true });
      expect(testRedWording(testRedEvidence(h, RUN, "T1", S), true), cell).not.toContain(FRESH);
    }
    // the primary carries a nonce other than the row's while a secondary carries the row's: no proof
    const nonceSwap = [...CAPTURED, executed(5, { nonce: "n-5", evidenceReceipt: at("u-5", 5, {}, { nonce: "n-other" }), evidenceReceipts: [at("n-5", 5, {}, { nonce: "n-5" })] })];
    expect(pendingFreshForce(nonceSwap, RUN, "T1", S)).toMatchObject({ kind: "unprovable" });
    // controls: legitimate multi-invocation rows still prove execution — an infra rerun's first invocation, and a
    // continuation whose first pass ran under another nonce, beside discovery listings and an unstarted spawn
    for (const [cell, extra] of [
      ["an infra rerun's first invocation", { evidenceReceipts: [at("first-5", 5), at("inv-5", 5)] }],
      ["a continuation's first pass under another nonce", { nonce: "retry-5", evidenceReceipt: at("retry-5", 5, {}, { nonce: "retry-5" }),
        evidenceReceipts: [listing(5), at("first-5", 5, {}, { nonce: "first-5" }), unstarted(5), at("retry-5", 5, {}, { nonce: "retry-5" })] }],
    ] as const) {
      const h = [...CAPTURED, executed(5, extra)];
      expect(pendingFreshForce(h, RUN, "T1", S), cell).toEqual({ kind: "none" });
      expect(testRedWording(testRedEvidence(h, RUN, "T1", S), true), cell).toContain(FRESH);
    }

    // ---- F2: a discovery listing or an unstarted spawn never makes an owner lend nothing, and a reuse names its stamp ----
    for (const [cell, extra] of [["none", []], ["a listing", [listing(3)]], ["an unstarted spawn", [unstarted(3)]], ["both", [listing(3), unstarted(3)]]] as const) {
      const owner = executed(3, { evidenceReceipts: [...extra, receipt("inv-3", "T1", {}, 3)] });
      expect(replaySource([owner], RUN, 0), cell).toBe(3);
      for (const [origin, words] of [[{ originAttempt: 3 }, "test: reused attempt 3's verdict; not re-executed"], [{}, "test: reused verdict; source attempt unknown"]] as const) {
        const h = [owner, force(4), reused(5, { ...origin, evidenceReceipts: owner.data.evidenceReceipts })];
        expect(testRedWording(testRedEvidence(h, RUN, "T1", S), true), cell).toContain(words);
      }
    }

    // ---- F3 under the closed source rule (D-2184 add.46): each replay hop lends its lender's source unchanged, and the
    // wording names the row's own stamp — no chain walk, receipt or missing lender vetoes or replaces it ----
    for (const carried of [false, true]) for (const hops of [1, 2, 3]) {
      const h: JournalEvent[] = [executed(3)];
      for (let a = 4; a < 4 + hops; a++) {
        const lent = replaySource(h, RUN, h.length - 1);
        expect(lent, `hop to ${a}`).toBe(3);
        h.push(executed(a, { replayedFromAttempt: a - 1, originAttempt: lent, evidenceReceipt: carried ? receipt("inv-3", "T1", {}, 3) : undefined }));
      }
      const cell = `${hops} hop(s), ${carried ? "carried receipts" : "receipt-less"}`;
      expect(testRedWording(testRedEvidence(h, RUN, "T1", S), false), cell).toContain("test: reused attempt 3's verdict; not re-executed");
    }
    const chain = [executed(3), executed(4, { replayedFromAttempt: 3, originAttempt: 3, evidenceReceipt: undefined })];
    for (const [cell, h, source] of [
      ["a stamp naming the lender's own attempt", [...chain, executed(5, { replayedFromAttempt: 4, originAttempt: 4, evidenceReceipt: undefined })], 4],
      ["a stamp beside a carried receipt of another attempt", [...chain, executed(5, { replayedFromAttempt: 4, originAttempt: 3, evidenceReceipt: receipt("inv-4", "T1", {}, 4) })], 3],
      ["a stamp beside a lender that was never journaled", [...chain, executed(5, { replayedFromAttempt: 7, originAttempt: 3, evidenceReceipt: undefined })], 3],
      ["no stamp after a stamped lender", [...chain, executed(5, { replayedFromAttempt: 4, evidenceReceipt: undefined })], undefined],
    ] as const) {
      expect(testRedEvidence(h as JournalEvent[], RUN, "T1", S), cell).toMatchObject({ kind: "reused", source });
    }
    // the projection side: a lender that is only a copy, or unexecuted, lends nothing to stamp
    expect(replaySource([executed(3), executed(4, { evidenceReceipt: receipt("inv-3", "T1", {}, 4) })], RUN, 1)).toBeUndefined();
    expect(replaySource([executed(3, { evidenceReceipt: undefined })], RUN, 0)).toBeUndefined();
  });
});

describe("row 337 (D-2181 D2 D3 D4): review b54beb4cfa5e — an interruption retry executes twice at one attempt, and a reuse still names its source", () => {
  test("an interrupted full execution and its reserved retry at one attempt leave a later cache reuse or journal replay naming that attempt from its own stamp", () => {
    // ---- the reviewer's reproducer, verbatim shapes: the interrupted execution, its reservation, the retry, then attempt 4 ----
    const r = (id: string) => ({ invocationId: id, subject: { runId: "run-A", taskId: "T1", attempt: 3, gate: "test", subjectCommit: "head" }, termination: { kind: "exit", exitCode: 1 } });
    const g = (attempt: number, extra: Record<string, unknown> = {}) => row("gate-result",
      { gate: "test", pass: false, attempt, commit: "subject", subjectHead: "head", fullSuite: true, evidenceReceipt: r("retry"), ...extra });
    const base = [g(3, { infra: true, disposition: "interrupted", evidenceReceipt: r("first") }), row("test-interrupted-retry-reserved", { commit: "subject", attempt: 3 }), g(3)];
    // the retry, an owned execution at attempt 3, lends 3 to a journal replay; the interrupted first one would too
    expect(replaySource(base, "run-A", 2)).toBe(3);
    expect(replaySource(base, "run-A", 0)).toBe(3);
    for (const [label, extra] of [["exact cache receipt", { reused: true, originAttempt: 3 }], ["journal projection", { replayedFromAttempt: 3, originAttempt: 3, evidenceReceipt: undefined }]] as const) {
      const h = [...base, g(4, { ...extra, testExecution: "reused" })];
      expect(testRedWording(testRedEvidence(h, "run-A", "T1", "subject"), false), label)
        .toBe("test: reused attempt 3's verdict; not re-executed — its recorded red failed (not attributed wholly outside files[])");
    }

    // ---- bounded generalisation: every reuse shape after two owned executions at one attempt names its own stamp ----
    const interrupted = { disposition: "interrupted", infra: true, interruptions: [SUSPEND], failureWindows: [WINDOW] };
    const first = executed(3, { ...interrupted, evidenceReceipt: receipt("first-3", "T1", {}, 3) });
    const retry = executed(3, { evidenceReceipt: receipt("retry-3", "T1", {}, 3) });
    const twice = [first, row("test-interrupted-retry-reserved", { commit: S, attempt: 3 }), retry, force(4)];
    const replay = (attempt: number, lender: number, extra: Record<string, unknown> = {}) =>
      executed(attempt, { replayedFromAttempt: lender, originAttempt: 3, evidenceReceipt: undefined, ...extra });
    const cells: Array<[string, JournalEvent[], number | undefined]> = [
      ["cache reuse carrying the retry's exact receipt", [...twice, reused(5, { originAttempt: 3, evidenceReceipt: receipt("retry-3", "T1", {}, 3) })], 3],
      ["cache reuse carrying the interrupted execution's exact receipt", [...twice, reused(5, { originAttempt: 3, evidenceReceipt: receipt("first-3", "T1", {}, 3) })], 3],
      ["cache reuse recording origin 3 with no receipt", [...twice, reused(5, { originAttempt: 3, evidenceReceipt: undefined })], 3],
      ["receipt-less journal replay of the retry", [...twice, replay(5, 3)], 3],
      ["journal replay carrying the retry's receipt", [...twice, replay(5, 3, { evidenceReceipt: receipt("retry-3", "T1", {}, 3) })], 3],
      ["a two-hop replay chain after the retry", [...twice, replay(5, 3), replay(6, 5)], 3],
      ["a receipt neither execution carried", [...twice, reused(5, { originAttempt: 3, evidenceReceipt: receipt("inv-9", "T1", {}, 3) })], 3],
      ["the receipts of both executions on one reuse", [...twice, reused(5, { originAttempt: 3, evidenceReceipt: receipt("retry-3", "T1", {}, 3), evidenceReceipts: [receipt("first-3", "T1", {}, 3)] })], 3],
      ["a stamp naming attempt 4 beside the retry's receipt", [...twice, reused(5, { originAttempt: 4, evidenceReceipt: receipt("retry-3", "T1", {}, 3) })], 4],
      ["a replay naming a lender never journaled", [...twice, replay(5, 2)], 3],
      ["a cache reuse with no stamp carrying the retry's exact receipt", [...twice, reused(5, { evidenceReceipt: receipt("retry-3", "T1", {}, 3) })], undefined],
      ["a journal replay with no stamp", [...twice, replay(5, 3, { originAttempt: undefined })], undefined],
    ];
    for (const [cell, history, source] of cells) {
      expect(testRedEvidence(history, RUN, "T1", S), cell).toMatchObject({ kind: "reused", source });
      expect(testRedWording(testRedEvidence(history, RUN, "T1", S), true), cell)
        .toContain(source === undefined ? "test: reused verdict; source attempt unknown" : `test: reused attempt ${source}'s verdict; not re-executed`);
    }
  });
});

describe("row 337 (D-2181 D4, D-2184 add.46): review 1080 — the source a wording names is the row's own stamped origin attempt", () => {
  const screen = (attempt: number, extra: Record<string, unknown> = {}) => executed(attempt, { fullSuite: undefined, selectedTests: [OUTSIDE], ...extra });
  const named = (h: JournalEvent[], outside = false) => testRedWording(testRedEvidence(h, RUN, "T1", S), outside);
  test("an executed selected screen stays a reuse source for a later cache hit and a journal replay, and every reuse names exactly its own stamped origin attempt or says unknown", () => {
    // ---- the reviewer's reproducers, verbatim shapes: an attempt-3 selected screen, then a real attempt-4 cache hit
    // carrying its exact receipt and originAttempt 3; and the journal replay of that screen ----
    const owned = [screen(3)];
    const hit = [...owned, reused(4, { originAttempt: 3, evidenceReceipt: receipt("inv-3", "T1", {}, 3) })];
    expect(testRedEvidence(hit, RUN, "T1", S)).toEqual({ kind: "reused", source: 3, interrupted: false });
    expect(named(hit)).toBe("test: reused attempt 3's verdict; not re-executed — its recorded red failed (not attributed wholly outside files[])");
    expect(replaySource(owned, RUN, 0)).toBe(3);
    const replayed = [...owned, screen(4, { replayedFromAttempt: 3, originAttempt: replaySource(owned, RUN, 0), testExecution: "reused" })];
    expect(named(replayed)).toBe("test: reused attempt 3's verdict; not re-executed — its recorded red failed (not attributed wholly outside files[])");
    // a selected screen still never consumes a force: ownership names a source, only a full execution answers D3
    expect(pendingFreshForce([force(2), ...hit], RUN, "T1", S)).toMatchObject({ kind: "pending", attempt: 2 });

    // ---- the replay projection's lender rule, base first: an owned execution (full or screen) lends its own attempt,
    // a reused lender lends its own stamped origin or none, a copy or an unexecuted row lends none ----
    const lenders: Array<[string, JournalEvent[], number | undefined]> = [
      ["an owned full execution", [executed(3)], 3],
      ["an owned selected screen", [screen(3)], 3],
      ["an owned interrupted selected screen", [screen(3, { disposition: "interrupted", infra: true, interruptions: [SUSPEND], failureWindows: [WINDOW] })], 3],
      ["a cache hit stamped origin 2", [executed(2), reused(3, { originAttempt: 2, evidenceReceipt: receipt("inv-2", "T1", {}, 2) })], 2],
      ["a journal replay stamped origin 2", [executed(2), executed(3, { replayedFromAttempt: 2, originAttempt: 2, evidenceReceipt: undefined })], 2],
      ["a cache hit with no stamp, even carrying an owned receipt", [executed(2), reused(3, { evidenceReceipt: receipt("inv-2", "T1", {}, 2) })], undefined],
      ["a journal replay with no stamp", [executed(2), executed(3, { replayedFromAttempt: 2, evidenceReceipt: undefined })], undefined],
      ["a legacy copy of an earlier receipt (owns nothing)", [executed(2), executed(3, { evidenceReceipt: receipt("inv-2", "T1", {}, 3) })], undefined],
      ["an unexecuted row (no started receipt)", [executed(3, { evidenceReceipt: undefined })], undefined],
      ["an unprovable history", [executed(3), row("gate-result", { pass: true, commit: S })], undefined],
    ];
    for (const [cell, h, source] of lenders) {
      const at = h.length - 1 - (cell === "an unprovable history" ? 1 : 0);
      expect(replaySource(h, RUN, at), cell).toBe(source);
    }

    // ---- the closed rule over every reuse shape: a row with an originAttempt names it — no receipt join, lender walk,
    // interrupted-retry or selected-screen matching may veto or replace it — and a row without one says unknown ----
    const interrupted = { disposition: "interrupted", infra: true, interruptions: [SUSPEND], failureWindows: [WINDOW] };
    const twice = [executed(3, { ...interrupted, evidenceReceipt: receipt("first-3", "T1", {}, 3) }), executed(3, { evidenceReceipt: receipt("retry-3", "T1", {}, 3) })];
    const cells: Array<[string, JournalEvent[], number | undefined]> = [
      ["cache hit, stamp agreeing with its receipt", [executed(3), reused(4, { originAttempt: 3 })], 3],
      ["cache hit, stamp with no receipt", [executed(3), reused(4, { originAttempt: 3, evidenceReceipt: undefined })], 3],
      ["cache hit, stamp beside a receipt of another attempt", [executed(3), executed(4), reused(5, { originAttempt: 3, evidenceReceipt: receipt("inv-4", "T1", {}, 4) })], 3],
      ["cache hit, stamp beside a receipt no row carried", [executed(3), reused(4, { originAttempt: 3, evidenceReceipt: receipt("inv-9", "T1", {}, 3) })], 3],
      ["cache hit, stamp after two executions at one attempt", [...twice, reused(4, { originAttempt: 3, evidenceReceipt: receipt("retry-3", "T1", {}, 3) })], 3],
      ["cache hit of a screen, stamp", [screen(3), reused(4, { originAttempt: 3, evidenceReceipt: receipt("inv-3", "T1", {}, 3) })], 3],
      ["journal replay, stamp", [executed(3), executed(4, { replayedFromAttempt: 3, originAttempt: 3, evidenceReceipt: undefined })], 3],
      ["journal replay chain, stamp carried", [executed(3), executed(4, { replayedFromAttempt: 3, originAttempt: 3, evidenceReceipt: undefined }),
        executed(5, { replayedFromAttempt: 4, originAttempt: 3, evidenceReceipt: undefined })], 3],
      ["cache hit, no stamp, exact receipt of an owned execution", [executed(3), reused(4)], undefined],
      ["cache hit, no stamp, no receipt", [executed(3), reused(4, { evidenceReceipt: undefined })], undefined],
      ["journal replay, no stamp, carrying its lender's receipt", [executed(3), executed(4, { replayedFromAttempt: 3, evidenceReceipt: receipt("inv-3", "T1", {}, 3) })], undefined],
      ["journal replay of a screen, no stamp", [screen(3), screen(4, { replayedFromAttempt: 3 })], undefined],
    ];
    for (const [cell, h, source] of cells) {
      expect(testRedEvidence(h, RUN, "T1", S), cell).toMatchObject({ kind: "reused", source });
      expect(named(h, true), cell).toContain(source === undefined ? "test: reused verdict; source attempt unknown; not re-executed"
        : `test: reused attempt ${source}'s verdict; not re-executed`);
    }
  });
});

describe("row 337 (D-2181 D3 D4, D-2184 add.46): review 7d5be6ffbe57 — no receipt anywhere erases a reused row's own stamped origin", () => {
  test("a contradictory neighbouring receipt or an unreadable carried receipt never erases a reuse's stamped origin attempt while force consumption and executed wording stay strict", () => {
    // ---- the reviewer's reproducer, verbatim: an execution row whose receipt names run-B, then a run-A cache hit
    // stamped originAttempt 3 ----
    const r = (event: string, data: Record<string, unknown>) => ({ event, taskId: "T1", data }) as unknown as JournalEvent;
    const old = r("gate-result", { gate: "test", pass: false, attempt: 3, commit: "S", subjectHead: "H", fullSuite: true,
      evidenceReceipt: { invocationId: "old", subject: { runId: "run-B", taskId: "T1", attempt: 3, gate: "test", subjectCommit: "H" }, termination: { kind: "exit", exitCode: 1 } } });
    const hit = r("gate-result", { gate: "test", pass: false, attempt: 5, commit: "S", reused: true, testExecution: "reused", originAttempt: 3 });
    for (const h of [[hit], [old, hit]]) {
      expect(testRedEvidence(h, "run-A", "T1", "S"), `history ${h.length}`).toEqual({ kind: "reused", source: 3, interrupted: false });
      expect(testRedWording(testRedEvidence(h, "run-A", "T1", "S"), true), `history ${h.length}`)
        .toBe("test: reused attempt 3's verdict; not re-executed — its recorded red failed only in files outside files[] — no repair can reach them");
      expect(replaySource(h, "run-A", h.length - 1), `history ${h.length}`).toBe(3);
    }
    // ---- the closed cells: a stamped reuse (cache hit or journal replay) beside every receipt shape that is no proof ----
    const alien = { ...receipt("alien-2"), subject: { ...receipt("alien-2").subject, runId: "run-B", attempt: 2 } };
    const reuses: Array<[string, Record<string, unknown>]> = [["a cache hit", { reused: true }], ["a journal replay", { replayedFromAttempt: 4 }]];
    const carried: Array<[string, unknown]> = [["null", null], ["a string", "unreadable"], ["another run's", alien],
      ["a null subject commit", { ...receipt("inv-3"), subject: { ...receipt("inv-3").subject, attempt: 3, subjectCommit: null } }]];
    const neighbours: Array<[string, JournalEvent[]]> = [["none", []],
      ["an execution naming another run", [executed(2, { evidenceReceipt: alien })]],
      ["a receipt contradicting its row attempt", [executed(2, { evidenceReceipt: receipt("inv-2", "T1", {}, 7) })]],
      ["a malformed force row", [row("gate-fresh-forced", { attempt: 4, commit: S })]]];
    for (const [shape, flags] of reuses) for (const [what, evidenceReceipt] of carried) for (const [around, before] of neighbours) {
      const cell = `${shape} carrying ${what} receipt after ${around}`;
      const h = [executed(3), ...before, force(4), executed(5, { ...flags, originAttempt: 3, testExecution: "reused", evidenceReceipt })];
      expect(testRedEvidence(h, RUN, "T1", S), cell).toEqual({ kind: "reused", source: 3, interrupted: false });
      expect(testRedWording(testRedEvidence(h, RUN, "T1", S), true), cell).toContain("test: reused attempt 3's verdict; not re-executed");
      expect(replaySource(h, RUN, h.length - 1), cell).toBe(3);
      // the force fold stays strict: a reuse never consumes, and an unprovable history is never none
      expect(pendingFreshForce(h, RUN, "T1", S).kind, cell).not.toBe("none");
    }
    // controls: a reuse without a stamp still says unknown; an unprovable history still proves no execution or freshness
    expect(testRedEvidence([old, { ...hit, data: { ...hit.data, originAttempt: undefined } }], "run-A", "T1", "S")).toEqual({ kind: "reused", source: undefined, interrupted: false });
    expect(testRedEvidence([old, { ...hit, data: { ...hit.data, originAttempt: "3" } }], "run-A", "T1", "S")).toMatchObject({ kind: "reused", source: undefined });
    const contradicted = [executed(2, { evidenceReceipt: alien }), force(4), executed(5)];
    expect(testRedEvidence(contradicted, RUN, "T1", S)).toEqual({ kind: "unproved", interrupted: false });
    expect(replaySource(contradicted, RUN, 2)).toBeUndefined();
    expect(pendingFreshForce(contradicted, RUN, "T1", S)).toMatchObject({ kind: "unprovable" });
    expect(testRedEvidence([force(4), executed(5)], RUN, "T1", S)).toEqual({ kind: "fresh", interrupted: false });
    expect(pendingFreshForce([force(4), executed(5)], RUN, "T1", S)).toEqual({ kind: "none" });
  });
});
