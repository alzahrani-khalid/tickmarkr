// C (v2.6.5 T5): every failed review round has its lawful exit and a bounded recovery path. Each gate
// round settles the one row held behind a pending parallel sibling before any park or task-failed row;
// a checkout-proof timeout is excluded for its own round only; and an unchanged cached test red
// attributed wholly outside files[] is re-executed once per subject. Zero tokens: fake adapters, the
// subprocess driver, scripted gate commands, and (for the closed exit table) scripted gate rounds.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../../src/adapters/types.js";
import { approve, newestPark, permittedDecisionVerbs } from "../../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import type { Slot } from "../../../src/drivers/types.js";
import type { Tier } from "../../../src/config/config.js";
import type { GateName, GateResult, Task } from "../../../src/graph/schema.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import * as gateRunner from "../../../src/gates/run-gates.js";
import type { GateContext } from "../../../src/gates/run-gates.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { identicalGateFailures, Journal, normalizeGateFailure, recordedTaskFailureKind, type JournalEvent } from "../../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

afterEach(() => vi.restoreAllMocks());

const rowsOf = (repo: string, runId: string) => Journal.open(repo, runId).read();
const of = (rows: JournalEvent[], event: string) => rows.filter((row) => row.taskId === "T1" && row.event === event);
const gateRows = (rows: JournalEvent[], gate: string) => of(rows, "gate-result").filter((row) => row.data.gate === gate);
const afterResume = (rows: JournalEvent[]) => rows.slice(rows.map((row) => row.event).lastIndexOf("run-resume") + 1);
const verbs = (rows: JournalEvent[]) => permittedDecisionVerbs(newestPark(rows, "T1"));
const work = (id: string, file = "work.txt") => ({ shell: `echo ${id} > ${file} && ${COMMIT} ${id}`, result: { ok: true, summary: id } });
const nothing = (id: string) => ({ shell: "true", result: { ok: true, summary: id } });
const CMDS = stringify({ gates: { build: "true", test: "true", lint: "true" } });

class Seat extends FakeAdapter {
  /** `approves: false` asks for changes on this seat's FIRST review only, then closes what it carried. */
  constructor(path: string, public override id: string, private approves = true, private seatTier: Tier = "frontier") {
    super(path);
    this.vendor = id;
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: this.seatTier }];
  }
  override headlessCommand(file: string): string {
    const prompt = readFileSync(file, "utf8");
    if (!prompt.startsWith("TICKMARKR-REVIEW")) return "true";
    const nonce = extractPromptNonce(prompt);
    const carried = [...prompt.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]!);
    // the marker names the seat to a pane driver, which sees only the dispatch script
    const verdict = this.approves || carried.length ? { nonce, approve: true, resolved: carried, reraised: [], findings: [] }
      : { nonce, approve: false, resolved: [], reraised: [], findings: [{ note: "work.txt: the guard is missing", severity: "material" }] };
    return `: SEAT=${this.id}; printf '%s' ${shq(JSON.stringify(verdict))}`;
  }
}
class Author extends FakeAdapter {
  override channels(): BillingChannel[] { return super.channels().slice(0, 1); }
}
class MidAuthor extends FakeAdapter {
  override channels(): BillingChannel[] { return [{ ...super.channels()[0]!, tier: "mid" }]; }
}

// ---- scripted gate rounds: the closed exit table at the daemon's own publication seam ----------------
type Semantic = { review?: GateResult; acceptance?: "pass" | "cancelled" | "throw"; reviewFirst?: boolean };
const DETERMINISTIC: GateName[] = ["build", "test", "lint", "evidence", "scope"];
const pass = (gate: GateName): GateResult => ({ gate, pass: true, details: "ok" });
/** Replays one round through ctx.onGate exactly as run-gates publishes it: the deterministic battery in
 * sequence, then acceptance ‖ review stamped with one parent. A `cancelled` acceptance never ends; a
 * `throw` acceptance kills the round after whatever already ended. */
async function scriptedRound(task: Task, ctx: GateContext, s: Semantic) {
  const results: GateResult[] = [];
  const gates = task.gates as GateName[];
  for (const [index, gate] of gates.filter((g) => DETERMINISTIC.includes(g)).entries()) {
    await ctx.onGate?.({ phase: "start", gate, index, total: gates.length });
    results.push(pass(gate));
    await ctx.onGate?.({ phase: "end", gate, result: results.at(-1)! });
  }
  const semantic = (["acceptance", "review"] as GateName[]).filter((g) => gates.includes(g));
  const parentAt = semantic.length === 2 ? 1 : undefined;
  for (const gate of semantic) await ctx.onGate?.({ phase: "start", gate, index: gates.indexOf(gate), total: gates.length, parentAt });
  const review = semantic.includes("review") ? s.review ?? { ...pass("review"), meta: { reviewer: "seat-z:seat-z" } } : undefined;
  const endReview = async () => {
    if (!review) return;
    if (typeof review.meta?.reviewer === "string" && review.meta.noVerdict === true) {
      await ctx.onGate?.({ phase: "note", gate: "review", name: "review-no-verdict", payload: { ...review.meta }, result: review });
    }
    results.push(review);
    await ctx.onGate?.({ phase: "end", gate: "review", result: review });
  };
  if (s.reviewFirst) await endReview();
  if (semantic.includes("acceptance")) {
    if (s.acceptance === "throw") throw new Error("judge seat crashed mid-round");
    if (s.acceptance !== "cancelled") {
      results.push(pass("acceptance"));
      await ctx.onGate?.({ phase: "end", gate: "acceptance", result: results.at(-1)! });
    }
  }
  if (!s.reviewFirst) await endReview();
  return { results, commits: [] as string[] };
}
const scriptRounds = (plan: (task: Task, ctx: GateContext, call: number) => Semantic) => {
  let call = 0;
  return vi.spyOn(gateRunner, "runGates").mockImplementation(async (task, ctx) => scriptedRound(task, ctx, plan(task, ctx, call++)));
};
const noVerdict = (reviewer: string, launchCause?: string): GateResult => ({ gate: "review", pass: false, details: `review: no verdict from ${reviewer} (cause: seat-launch-failed)`,
  meta: { reviewer, cause: "seat-launch-failed", noVerdict: true, infra: true, classification: "infra", ...(launchCause ? { launchCause } : {}) } });
const noEligible: GateResult = { gate: "review", pass: false, details: "unreadable — no cross-vendor reviewer available at or above cheap floor",
  meta: { noEligibleReviewer: true, unreadable: true, findings: [], authorVendors: ["fake"], unresolvedAuthors: [] } };

/** Every gate-result row a round published precedes the terminal row; returns the review rows. */
function settledBefore(rows: JournalEvent[], terminal: string) {
  const end = rows.findIndex((row) => row.taskId === "T1" && row.event === terminal);
  expect(end, terminal).toBeGreaterThan(-1);
  expect(of(rows, "gate-result").every((row) => rows.indexOf(row) < end), terminal).toBe(true);
  return gateRows(rows, "review");
}

describe("C — each failed review round has its lawful exit (production daemon, zero tokens)", { timeout: 600_000 }, () => {
  test("runDaemon publishes every held parallel row (zero or one) at both fresh/resumed recovery sites; zero held publishers create no row; one flushes once; pending siblings clear before the terminal row; the closed table is no-eligible refusal→gate-fail (pass:false review row; production approve offers waive/uphold/recheck) / seatless review→infra / exhausted recovery→infra (production approve offers approve/recheck) / thrown sibling→existing task-failed (resume --retry-failed); exercise cancelled-sibling permutations within these rows", async () => {
    // cancelled sibling: the review ends first and is HELD behind an acceptance that never ends (one held);
    // healthy order: acceptance ends first and nothing is ever held (zero held).
    const permutations = [["held", { reviewFirst: true, acceptance: "cancelled" }], ["none", { reviewFirst: false, acceptance: "pass" }]] as const;
    const table = [
      { row: "no-eligible", kind: "gate-fail", verbs: ["waive", "uphold", "recheck"], seats: [] as string[], review: () => noEligible, calls: 1 },
      { row: "seatless", kind: "infra", verbs: ["approve", "recheck"], seats: [], review: () => noVerdict("seat-a:seat-a"), calls: 1 },
      // the recovery picker re-seats seat-b on a review-only round, which also returns no verdict
      { row: "exhausted", kind: "infra", verbs: ["approve", "recheck"], seats: ["seat-b"], review: (call: number) => noVerdict(call % 2 === 0 ? "seat-a:seat-a" : "seat-b:seat-b"), calls: 2 },
    ] as const;
    for (const exit of table) {
      for (const [held, order] of permutations) {
        const runId = `run-exit-${exit.row}-${held}`;
        const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("w0")] } }, CMDS);
        const adapters = [new Author(scriptPath), ...exit.seats.map((id) => new Seat(scriptPath, id))];
        let calls = 0;
        scriptRounds((task, _ctx, call) => {
          calls++;
          // the review-only recovery round runs its review alone: no parallel sibling to wait for
          return task.gates.includes("acceptance") ? { ...order, review: exit.review(call) } : { review: exit.review(call) };
        });
        // ---- the fresh site ----
        const fresh = await runDaemon(repo, { adapters, runId });
        expect(fresh.human, runId).toEqual(["T1"]);
        let rows = rowsOf(repo, runId);
        expect(calls, runId).toBe(exit.calls);
        const reviews = settledBefore(rows, "task-human");
        // exactly one review row per round: a held row flushed once, a non-held row never duplicated
        expect(reviews, runId).toHaveLength(exit.calls);
        expect(gateRows(rows, "acceptance"), runId).toHaveLength(held === "held" ? 0 : 1);
        expect(of(rows, "task-human").at(-1)!.data.kind, runId).toBe(exit.kind);
        if (exit.kind === "gate-fail") {
          expect(reviews[0]!.data, runId).toMatchObject({ pass: false, noEligibleReviewer: true });
        } else {
          for (const review of reviews) {
            expect(review.data, runId).toMatchObject({ infra: true, skipped: true, noVerdict: true });
            expect(review.data.pass, runId).toBeUndefined(); // never a fabricated pass:false, never a pass
          }
        }
        expect(verbs(rows), runId).toEqual(exit.verbs);
        expect(of(rows, "task-failed"), runId).toEqual([]);
        // ---- the resumed site: a recheck re-gates through the resume battery and exits the same way ----
        calls = 0;
        await approve([runId, "T1", "--recheck", "--by", "op"], repo);
        const resumed = await runDaemon(repo, { adapters, runId, resume: true });
        expect(resumed.human, runId).toEqual(["T1"]);
        rows = afterResume(rowsOf(repo, runId));
        const resumedReviews = settledBefore(rows, "task-human");
        expect(resumedReviews.length, runId).toBe(calls);
        expect(calls, runId).toBeGreaterThan(0);
        expect(of(rows, "task-human").at(-1)!.data.kind, runId).toBe(exit.kind);
        expect(verbs(rowsOf(repo, runId)), runId).toEqual(exit.verbs);
        vi.restoreAllMocks();
      }
    }
    // ---- thrown sibling: the held review is published once BEFORE the existing task-failed row, whose
    // kind is the dispatch failure `resume --retry-failed` re-opens; a review that never ended is no row ----
    for (const [held, order] of [["held", { reviewFirst: true, acceptance: "throw" }], ["none", { reviewFirst: false, acceptance: "throw" }]] as const) {
      const runId = `run-exit-thrown-${held}`;
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("t0"), work("t1", "again.txt")] } }, CMDS);
      const adapters = [new Author(scriptPath)];
      scriptRounds((_task, _ctx, call) => call === 0 ? order : {});
      const failed = await runDaemon(repo, { adapters, runId });
      expect(failed.failed, runId).toEqual(["T1"]);
      const rows = rowsOf(repo, runId);
      const reviews = settledBefore(rows, "task-failed");
      expect(reviews.map((row) => row.data.pass), runId).toEqual(held === "held" ? [true] : []);
      expect(of(rows, "task-human"), runId).toEqual([]);
      expect(recordedTaskFailureKind(rows, "T1"), runId).toBe("dispatch");
      const retried = await runDaemon(repo, { adapters, runId, resume: true, retryFailed: true });
      expect(retried.done, runId).toEqual(["T1"]);
      vi.restoreAllMocks();
    }
    // ---- exhausted recovery holds the round's floor: a preferred frontier seat whose checkout proof timed
    // out lifts the floor above the mid-tier alternative left, so recovery seats nothing and parks infra ----
    {
      const runId = "run-exit-exhausted-floor";
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("f0")] } }, `${CMDS}review: { required: true, prefer: [seat-a, seat-c] }\n`);
      const adapters = [new MidAuthor(scriptPath), new Seat(scriptPath, "seat-a"), new Seat(scriptPath, "seat-c", true, "mid")];
      let calls = 0;
      // a second call would be the below-floor recovery runGates refuses (its floor counts seat-a)
      scriptRounds(() => ({ review: calls++ === 0 ? noVerdict("seat-a:seat-a", "checkout-proof-timeout") : noEligible }));
      const s = await runDaemon(repo, { adapters, runId });
      vi.restoreAllMocks();
      expect(s.human, runId).toEqual(["T1"]);
      const rows = rowsOf(repo, runId);
      expect(calls, runId).toBe(1);
      expect(of(rows, "review-infra-retry"), runId).toEqual([]);
      expect(of(rows, "task-human").at(-1)!.data.kind, runId).toBe("infra");
      expect(verbs(rows), runId).toEqual(["approve", "recheck"]);
    }
  });

  // ---- an unchanged cached test red, by its attribution ------------------------------------------------
  const OUTSIDE = "tests/outside.test.ts";
  const INSIDE = "src/inside.test.ts";
  /** The worker lands src/a.txt, then a repair that lands nothing. The red names `named` in its own text;
   * `meta` is the reporter's attribution, stamped on the result before the daemon's onGate sees it. */
  const ASSERTION = "AssertionError: expected one to be two";
  const attributedRepo = (files: string[] | undefined, named: string, failure = ASSERTION) => setupRepo(
    [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"], ...(files ? { files } : {}) })],
    { consult: { action: "human", notes: "operator decides" },
      tasks: { T1: [{ shell: `mkdir -p src && echo a0 > src/a.txt && ${COMMIT} a0`, result: { ok: true, summary: "a0" } },
        nothing("r1"), nothing("r2"), nothing("r3")] } },
    stringify({ gates: { build: "true", lint: "true",
      test: `[ ! -f src/a.txt ] || { echo ' FAIL  ${named} > reads one'; echo '${failure}'; exit 1; }` } }),
  );
  /** The runner certificate the vitest manifest path appends to a red's details (test-manifest.ts): its
   * never-started and reporter-error counts, then each runner-level diagnostic line. */
  const certificate = (counts: string, ...diagnostics: string[]) =>
    ["", `classification: regression; runner-level diagnostic: ${counts}; runner vitest`, ...diagnostics].join("\n");
  const CLEAN = certificate("never-started 0; reporter errors 0");
  const attribute = (meta: Record<string, unknown>, report = CLEAN) => {
    const original = gateRunner.runGates;
    return vi.spyOn(gateRunner, "runGates").mockImplementation((task, ctx) => original(task, {
      ...ctx,
      onGate: async (event) => {
        if (event.phase === "end" && event.result.gate === "test" && !event.result.pass) {
          event.result.meta = { ...event.result.meta, ...meta };
          event.result.details += report;
        }
        await ctx.onGate?.(event);
      },
    }));
  };
  const complete = (failingFiles: unknown[]) => ({ classification: "regression", failingFiles, fullSuite: true });
  const forcedOutside = (rows: JournalEvent[]) => of(rows, "gate-fresh-forced").filter((row) => row.data.reason === "no-commit-out-of-scope-red");

  test("runDaemon reexecutes one unchanged cached test red with complete attributed failures wholly outside files while in-scope mixed empty unknown contradictory or failed-producer attribution remains fail-closed and a fresh outside-scope red parks without cap-funded work or another replay on the same subject", async () => {
    // ---- the trigger: complete, trustworthy, all outside a declared files[] — a timeout-shaped one
    // too, which keeps this trigger's own bypass and park over the timeout refresh ----
    for (const [label, failure] of [["assertion", ASSERTION], ["timeout-shaped", "Error: Test timed out in 5000ms."]] as const) {
      const runId = `run-outside-fresh-${label}`;
      const { repo, fake } = attributedRepo(["src/**"], OUTSIDE, failure);
      attribute(complete([OUTSIDE]));
      const s = await runDaemon(repo, { adapters: [fake], runId });
      vi.restoreAllMocks();
      expect(s.human).toEqual(["T1"]);
      const rows = rowsOf(repo, runId);
      const tests = gateRows(rows, "test");
      // the original red, then ONE fresh re-execution of the unchanged subject — never a copy of it
      expect(tests.map((row) => [row.data.attempt, row.data.pass])).toEqual([[0, false], [1, false]]);
      expect(tests[1]!.data.commit).toBe(tests[0]!.data.commit);
      expect(tests[1]!.data.replayedFromAttempt).toBeUndefined();
      expect(tests[1]!.data.reused).toBeUndefined();
      expect(forcedOutside(rows).map((row) => row.data)).toMatchObject([{ gate: "test", attempt: 1, priorAttempt: 0, commit: tests[0]!.data.commit }]);
      expect(of(rows, "gate-replayed")).toEqual([]);
      expect(of(rows, "gate-reused-verdict").filter((row) => row.data.gate === "test")).toEqual([]);
      const rerun = of(rows, "gate-rerun");
      if (rerun.length) expect(rerun.map((row) => row.data)).toMatchObject([{ gate: "test", bypass: "out-of-scope-fresh" }]);
      // the fresh red keeps its row and parks gate-fail before the cap, a consult or more repair funding
      const park = of(rows, "task-human").at(-1)!;
      expect(park.data.kind).toBe("gate-fail");
      expect(rows.indexOf(park)).toBeGreaterThan(rows.indexOf(tests[1]!));
      const forcedAt = rows.indexOf(forcedOutside(rows)[0]!);
      for (const event of ["gate-fingerprint-cap", "consult", "consult-verdict", "escalation", "repair-attempt", "task-dispatch"]) {
        expect(of(rows, event).filter((row) => rows.indexOf(row) > forcedAt), event).toEqual([]);
      }
      expect(of(rows, "gate-fingerprint-cap")).toEqual([]);
      expect(of(rows, "gate-fresh-forced").filter((row) => row.data.reason !== "no-commit-out-of-scope-red"), label).toEqual([]);
      expect(verbs(rows)).toEqual(["waive", "recheck"]);
      // and no second replay or forced execution of that subject: a resume of the park re-buys nothing
      await runDaemon(repo, { adapters: [fake], runId, resume: true });
      const after = rowsOf(repo, runId);
      expect(forcedOutside(after)).toHaveLength(1);
      expect(gateRows(after, "test")).toHaveLength(2);
      expect(of(after, "gate-replayed")).toEqual([]);
    }
    // ---- a crash at every interruption point of the forced round. After its build, or after a passing
    // selected-test screen ahead of its full suite: resume keeps the forced bypass and re-executes the
    // forced test once, and that fresh red is independent evidence (never a replay measurement), counted
    // and parked exactly as live. After its test or before its park: resume restores that park from the
    // journaled subject and result — no re-execution, no replay, no worker ----
    for (const point of ["after-build", "after-screen", "after-test", "before-park"] as const) {
      const runId = `run-outside-crash-${point}`;
      const { repo, fake } = attributedRepo(["src/**"], OUTSIDE);
      attribute(complete([OUTSIDE]));
      await runDaemon(repo, { adapters: [fake], runId });
      vi.restoreAllMocks();
      const file = join(Journal.open(repo, runId).dir, "journal.jsonl");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      const parsed = lines.map((line) => JSON.parse(line) as JournalEvent);
      const forcedAt = parsed.findIndex((row) => row.event === "gate-fresh-forced" && row.data.reason === "no-commit-out-of-scope-red");
      const gateAt = (gate: string) => parsed.findIndex((row, i) => i > forcedAt && row.event === "gate-result" && row.data.gate === gate);
      const cut = point === "before-park" ? parsed.findIndex((row) => row.event === "task-human" && row.taskId === "T1")
        : point === "after-screen" ? gateAt("test") : gateAt(point === "after-build" ? "build" : "test") + 1;
      expect(forcedAt, point).toBeGreaterThan(-1);
      expect(cut, point).toBeGreaterThan(forcedAt + 1);
      const kept = lines.slice(0, cut);
      if (point === "after-screen") {
        // the screen's own row, exactly as the daemon journals a passing selected-test screen
        const red = parsed[gateAt("test")]!;
        kept.push(JSON.stringify({ ts: red.ts, event: "gate-result", taskId: "T1", data: { gate: "test", pass: true,
          details: "selected tests passed", selectedTests: [OUTSIDE], commit: red.data.commit, attempt: red.data.attempt } }));
      }
      writeFileSync(file, `${kept.join("\n")}\n`);
      expect(of(rowsOf(repo, runId), "task-human"), point).toEqual([]);
      attribute(complete([OUTSIDE]));
      const s = await runDaemon(repo, { adapters: [fake], runId, resume: true });
      vi.restoreAllMocks();
      expect(s.human, point).toEqual(["T1"]);
      const rows = rowsOf(repo, runId);
      const resumed = afterResume(rows);
      expect(of(resumed, "task-human").map((row) => row.data.kind), point).toEqual(["gate-fail"]);
      const tests = gateRows(rows, "test").filter((row) => row.data.pass === false);
      expect(tests, point).toHaveLength(2);
      // both reds are observations: the original and the one fresh re-execution, however it was interrupted
      for (const row of tests) expect(row.data.replayMeasurement, point).toBeUndefined();
      expect(identicalGateFailures(rows, "T1", "test", normalizeGateFailure(String(tests[1]!.data.details))), point).toBe(2);
      if (point === "after-build" || point === "after-screen") {
        expect(gateRows(resumed, "test").map((row) => row.data), point).toMatchObject([{ pass: false, commit: tests[0]!.data.commit }]);
        expect(of(resumed, "gate-rerun").filter((row) => row.data.bypass !== "out-of-scope-fresh"), point).toEqual([]);
        expect(tests[1]!.data.replayedFromAttempt, point).toBeUndefined();
        expect(tests[1]!.data.reused, point).toBeUndefined();
        expect(forcedOutside(resumed).map((row) => row.data), point).toMatchObject([{ resumed: true, commit: tests[0]!.data.commit }]);
      } else {
        expect(of(resumed, "gate-result"), point).toEqual([]);
        expect(of(resumed, "gate-fresh-forced"), point).toEqual([]);
        expect(forcedOutside(rows), point).toHaveLength(1);
      }
      for (const event of ["gate-replayed", "gate-fingerprint-cap", "consult", "task-dispatch", "worker-launch"]) {
        expect(of(resumed, event), `${point} ${event}`).toEqual([]);
      }
      expect(verbs(rows), point).toEqual(["waive", "recheck"]);
    }
    // ---- every other attribution keeps the replay: the copy is restated, nothing is re-executed. That
    // includes a complete-looking outside list whose runner certificate does not prove it complete: an
    // in-scope collection failure has no module record, so it lives only in the certificate (D-854) ----
    const controls: Array<[string, string[] | undefined, string, Record<string, unknown>, string?]> = [
      ["collection-failure", ["src/**"], OUTSIDE, complete([OUTSIDE]),
        certificate("never-started 0; reporter errors 1", `${INSIDE}: Failed to load url ./missing.js (resolved id: ./missing.js)`)],
      ["reporter-errors-unknown", ["src/**"], OUTSIDE, complete([OUTSIDE]), certificate("never-started 0; reporter errors unknown")],
      ["never-started", ["src/**"], OUTSIDE, complete([OUTSIDE]), certificate("never-started 2; reporter errors 0")],
      ["no-certificate", ["src/**"], OUTSIDE, complete([OUTSIDE]), ""],
      ["in-scope", ["src/**"], INSIDE, complete([INSIDE])],
      ["mixed", ["src/**"], OUTSIDE, complete([OUTSIDE, INSIDE])],
      ["empty", ["src/**"], OUTSIDE, complete([])],
      ["unknown", ["src/**"], OUTSIDE, { classification: undefined, failingFiles: [OUTSIDE] }],
      ["incomplete", ["src/**"], OUTSIDE, { classification: "regression", failingFiles: [OUTSIDE], selectedTests: ["tests/other.test.ts"], selectionDecision: undefined }],
      ["contradictory", ["src/**"], INSIDE, complete([OUTSIDE])],
      ["failed-producer", ["src/**"], OUTSIDE, { ...complete([OUTSIDE]), recoveryBlocked: "the isolated rerun could not be scheduled" }],
      ["unrestricted", undefined, OUTSIDE, complete([OUTSIDE])],
    ];
    for (const [name, files, named, meta, report] of controls) {
      const runId = `run-outside-control-${name}`;
      const { repo, fake } = attributedRepo(files, named);
      attribute(meta, report);
      await runDaemon(repo, { adapters: [fake], runId });
      vi.restoreAllMocks();
      const rows = rowsOf(repo, runId);
      expect(forcedOutside(rows), name).toEqual([]);
      const replayed = gateRows(rows, "test").filter((row) => row.data.attempt === 1);
      expect(replayed.length, name).toBeGreaterThan(0);
      expect(replayed[0]!.data, name).toMatchObject({ pass: false, replayedFromAttempt: 0 });
      expect(of(rows, "gate-replayed").filter((row) => row.data.gate === "test").length, name).toBeGreaterThan(0);
      expect(of(rows, "gate-rerun").filter((row) => row.data.bypass === "out-of-scope-fresh"), name).toEqual([]);
    }
  });

  // ---- seat launch failures through a pane driver -------------------------------------------------------
  const PANE = "visibility:\n  llm: pane\n  keepPanes: run\n";
  const proofTimeout = () => Object.assign(new Error("checkout proof absent (names no checkout)"), { launchCause: "checkout-proof-timeout" });
  /** A real SubprocessDriver whose review-seat launch for `failing(seat)` throws `error()`; `delivered`
   * counts the review launches that actually ran, per seat. */
  function launchDriver(failing: (seat: string) => (() => Error) | undefined) {
    const inner = new SubprocessDriver();
    const delivered = new Map<string, number>();
    const driver = {
      id: "subprocess", interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      async run(slot: Slot, command: string) {
        const script = /([^'"\s]*dispatch\.sh)/.exec(command)?.[1];
        const seat = script ? /: SEAT=(seat-[a-z]);/.exec(readFileSync(script, "utf8"))?.[1] : undefined;
        if (seat) {
          const error = failing(seat);
          if (error) throw error();
          delivered.set(seat, (delivered.get(seat) ?? 0) + 1);
        }
        return inner.run(slot, command);
      },
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: (slot: Slot) => inner.close(slot),
      worktree: inner.worktree.bind(inner),
    };
    return { driver, delivered };
  }
  const reviewCfg = (seats: string[]) => `${PANE}review: { required: true, prefer: [${seats.join(", ")}], timeoutMs: 5000 }\n`;

  test("runDaemon preserves launch-failure eligibility live and after resume for a checkout-proof timeout and an ordinary launch failure alike and no-verdict never becomes a passing review", async () => {
    // ---- live: a seat that failed to launch (and on its one relaunch) is seated again on the task's next
    // round — a launch failure of any kind never strikes (v2.6.8 T1) ----
    for (const [name, error] of [["timeout", proofTimeout], ["ordinary", () => new Error("pane create refused")]] as const) {
      const runId = `run-live-${name}`;
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("l0"), work("l1", "fix.txt"), work("l2", "fix2.txt")] } }, reviewCfg(["seat-a", "seat-b"]));
      const a = new Seat(scriptPath, "seat-a");
      const b = new Seat(scriptPath, "seat-b", false); // round 1's replacement asks for changes: a second round is drawn
      let failures = 0;
      const { driver } = launchDriver((seat) => seat === "seat-a" && failures++ < 2 ? error : undefined);
      await runDaemon(repo, { adapters: [new Author(scriptPath), a, b], runId, driver });
      const rows = rowsOf(repo, runId);
      const reviewers = gateRows(rows, "review").map((row) => row.data.reviewer);
      expect(reviewers[0], name).toBe("seat-b:seat-b");
      const launchRow = { reviewer: "seat-a:seat-a", cause: "seat-launch-failed", ...(name === "timeout" ? { launchCause: "checkout-proof-timeout" } : {}) };
      expect(of(rows, "review-no-verdict").map((row) => row.data), name).toMatchObject([launchRow, launchRow]);
      // the next round: the seat that failed to launch is eligible again, whatever the launch cause
      expect(reviewers[1], name).toBe("seat-a:seat-a");
      for (const row of gateRows(rows, "review").filter((r) => r.data.noVerdict === true)) expect(row.data.pass, name).toBeUndefined();
    }
    // ---- after resume: no launch failure in the journal seeds a strike ----
    for (const [name, error] of [["timeout", proofTimeout], ["ordinary", () => new Error("pane create refused")]] as const) {
      const runId = `run-resume-${name}`;
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("r0")] } }, reviewCfg(["seat-a"]));
      const a = new Seat(scriptPath, "seat-a");
      let released = false;
      const { driver, delivered } = launchDriver((seat) => seat === "seat-a" && !released ? error : undefined);
      const adapters = [new Author(scriptPath), a];
      // one live failure, then two resumed ones: each parks infra, never a passing review
      expect((await runDaemon(repo, { adapters, runId, driver })).human, name).toEqual(["T1"]);
      for (let i = 0; i < 2; i++) {
        await approve([runId, "T1", "--recheck", "--by", "op"], repo);
        await runDaemon(repo, { adapters, runId, resume: true, driver });
      }
      let rows = rowsOf(repo, runId);
      expect(gateRows(rows, "review").some((row) => row.data.pass === true), name).toBe(false);
      released = true;
      await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      const last = await runDaemon(repo, { adapters, runId, resume: true, driver });
      rows = rowsOf(repo, runId);
      // never struck: the released seat is still seated and its real verdict lands
      expect(of(rows, "review-pool-demotion"), name).toEqual([]);
      expect(last.done, name).toEqual(["T1"]);
      expect(gateRows(rows, "review").at(-1)!.data, name).toMatchObject({ pass: true, reviewer: "seat-a:seat-a" });
      expect(delivered.get("seat-a"), name).toBe(1);
    }
  });

  test("runDaemon makes at most N gate-round calls for always-timeout pools of N eligible seats at N=1 and N=2; each parks infra offering recheck; a released reviewer supplies a real verdict; a later recheck can select the timed-out seat again", async () => {
    for (const seats of [["seat-a"], ["seat-a", "seat-b"]]) {
      const n = seats.length;
      const runId = `run-always-timeout-${n}`;
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("n0")] } }, reviewCfg(seats));
      const pool = seats.map((id) => new Seat(scriptPath, id));
      let released = false;
      const { driver, delivered } = launchDriver((seat) => !released && seats.includes(seat) ? proofTimeout : undefined);
      const adapters = [new Author(scriptPath), ...pool];
      const original = gateRunner.runGates;
      let calls = 0;
      vi.spyOn(gateRunner, "runGates").mockImplementation((task, ctx) => { calls++; return original(task, ctx); });
      for (let round = 0; round < 2; round++) {
        calls = 0;
        const s = round === 0 ? await runDaemon(repo, { adapters, runId, driver })
          : await runDaemon(repo, { adapters, runId, resume: true, driver });
        expect(s.human, `${n}/${round}`).toEqual(["T1"]);
        expect(calls, `${n}/${round}`).toBeGreaterThan(0);
        expect(calls, `${n}/${round}`).toBeLessThanOrEqual(n);
        const rows = rowsOf(repo, runId);
        expect(of(rows, "task-human").at(-1)!.data.kind, `${n}/${round}`).toBe("infra");
        expect(verbs(rows), `${n}/${round}`).toContain("recheck");
        expect(gateRows(rows, "review").some((row) => row.data.pass === true), `${n}/${round}`).toBe(false);
        await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      }
      // released: the recheck seats a timed-out seat again and its real verdict merges the work
      released = true;
      const done = await runDaemon(repo, { adapters, runId, resume: true, driver });
      vi.restoreAllMocks();
      expect(done.done, String(n)).toEqual(["T1"]);
      const rows = rowsOf(repo, runId);
      const final = gateRows(rows, "review").at(-1)!;
      expect(final.data, String(n)).toMatchObject({ pass: true });
      expect(seats.map((id) => `${id}:${id}`), String(n)).toContain(final.data.reviewer);
      expect(of(rows, "review-pool-demotion"), String(n)).toEqual([]);
      expect([...delivered.values()].reduce((sum, count) => sum + count, 0), String(n)).toBe(1);
    }
  });
});
