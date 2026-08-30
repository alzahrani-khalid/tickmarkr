// v2.0 T2 (OBS-554): run-1734's 32 test-gate runs averaged 15.6 minutes beside a second tickmarkr run
// on the same box, and the journal could not decompose suite growth from load contention — no row
// recorded machine load, and one logical `test` row covered a selected screen plus a full suite with
// other gates in between. These fixtures pin the measurement that makes the decomposition possible:
// every gate-result row carries the gate's OWN duration and the load it started and finished under,
// the composite test row splits its two suites, and the verdict gates keep one span per dispatch.
// Measurement only — no scheduler is exercised here, because none was built.
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { AuthHealth, BillingChannel } from "../../src/adapters/types.js";
import { resetLoadProviderForTests, setLoadProviderForTests } from "../../src/gates/run-gates.js";
import { GATE_NAMES } from "../../src/graph/schema.js";
import { runDaemon as daemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { authedModels, COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

// The three fields every gate-result row must carry, and the predicate the criterion calls "closed":
// a row is telemetered only when ALL of them are present as numbers. Absence is the falsifier — a row
// that dropped one is not "mostly measured", it is unusable for a stratified recalibration.
const TELEMETRY_FIELDS = ["durationMs", "load1Start", "load1End"] as const;
const carriesTelemetry = (data: Record<string, unknown>): boolean =>
  TELEMETRY_FIELDS.every((f) => typeof data[f] === "number");

// THE rows under test: the daemon's own `gate-result` journal events, written through the one
// journalGateResult helper that serves both onGate sites. Read straight off the ledger — a
// measurement kept anywhere else is not the row the spec requires.
type GateRow = Record<string, unknown> & { gate: string; pass?: boolean; durationMs: number; load1Start: number; load1End: number };
const gateRows = (repo: string, runId: string): GateRow[] =>
  Journal.open(repo, runId).read().filter((e) => e.event === "gate-result").map((e) => e.data as GateRow);

// setupRepo's fixture plus the extra seats a case needs; the scripted fake is always in the fleet.
const runDaemon = async (fixture: { repo: string; fake: FakeAdapter }, runId: string, extra: FakeAdapter[] = []) => {
  await daemon(fixture.repo, { adapters: [fixture.fake, ...extra], runId });
};

const oneTask = (id: string, extra = "") => ({
  tasks: { [id]: [{ shell: `echo ${id} > ${id.toLowerCase()}.txt${extra} && ${COMMIT} ${id.toLowerCase()}`, result: { ok: true, summary: "done" } }] },
});

afterEach(() => resetLoadProviderForTests());

describe("gate-result telemetry (v2.0 T2, fake adapter, zero tokens)", () => {
  test("test: every gate-result row for all seven gates carries durationMs load1Start and load1End and a row missing any field fails the closed-set assertion", async () => {
    // A green run journals one row per declared gate. build/test/lint have no command in this repo,
    // so they are journaled as skips — the quantifier is "every row", not "every row that ran a
    // command", and a skip that reports no duration is still a hole in the distribution.
    const fixture = setupRepo([T("T1")], oneTask("T1"));
    await runDaemon(fixture, "run-telemetry-closed-set");
    const rows = gateRows(fixture.repo, "run-telemetry-closed-set");
    // all seven gates, pass and fail alike, through the one journalGateResult helper
    expect([...new Set(rows.map((r) => r.gate))].sort()).toEqual([...GATE_NAMES].sort());
    // the quantifier is closed over the LEDGER itself: EVERY gate-result row, not a filtered subset,
    // so a gate whose verdict was journaled without a measurement is a hole, not an exemption.
    for (const row of rows) {
      expect({ gate: row.gate, telemetered: carriesTelemetry(row) }).toEqual({ gate: row.gate, telemetered: true });
      expect(row.durationMs).toBeGreaterThanOrEqual(0);
    }

    // the assertion has teeth: drop ONE field from a real row and the same predicate refuses it.
    for (const field of TELEMETRY_FIELDS) {
      const { [field]: _dropped, ...stripped } = rows[0]!;
      expect({ field, telemetered: carriesTelemetry(stripped) }).toEqual({ field, telemetered: false });
    }
  }, 120000);

  test("test: a gate started under one injected load value and finished under another journals both distinct samples so one shared sample fails", async () => {
    // Every read returns a NEW value, so a gate that sampled once and reused the number for both ends
    // would journal load1Start === load1End. The 1000 offset puts every sample far outside anything
    // os.loadavg could report on this machine: a row reading production load instead of the injected
    // provider is visible, not merely equal-by-accident.
    let reads = 0;
    setLoadProviderForTests(() => 1000 + ++reads);
    const fixture = setupRepo([T("T1")], oneTask("T1"));
    await runDaemon(fixture, "run-telemetry-two-samples");
    const rows = gateRows(fixture.repo, "run-telemetry-two-samples");

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const { gate, load1Start: start, load1End: end } = row;
      // both samples came from the injected provider ...
      expect({ gate, injected: start > 1000 && end > 1000 }).toEqual({ gate, injected: true });
      // ... and they are two distinct reads, the start one before the gate ran and the end one after
      expect({ gate, distinct: start !== end }).toEqual({ gate, distinct: true });
      expect(end).toBeGreaterThan(start); // the provider only ever moves forward, so end is the later read
    }
    expect(reads).toBeGreaterThanOrEqual(2 * rows.length);
  }, 120000);

  // The composite path, staged so the three intervals are separable by construction: the SELECTED
  // screen sleeps 0.5s (the test command sees its file arguments), the `acceptance` gate that runs
  // between the screen and the merge-candidate suite sleeps 1.2s, and the FULL suite sleeps 1.6s (no
  // arguments). A summing-the-wrong-thing implementation is arithmetically visible: full-only reports
  // ~1.6s, wait-inclusive reports ~3.3s, and only the two test intervals sum to ~2.1s.
  const SELECTED_MS = 500;
  const INTERVENING_MS = 1200;
  const FULL_MS = 1600;

  test("test: a delayed selected screen beside a separately delayed intervening gate beside a delayed full suite journals a test durationMs summing only the two test intervals so full-only or wait-inclusive counting fails", async () => {
    // `$#` is 0 for the merge-candidate full suite and 1 once run-gates appends the selected file,
    // so ONE configured command gives the screen and the suite different, known costs.
    const testCmd = `sh -c 'if [ $# -gt 0 ]; then sleep ${SELECTED_MS / 1000}; else sleep ${FULL_MS / 1000}; fi' tkr`;
    const fixture = setupRepo(
      [T("T1", { acceptance: [
        { oracle: "command", command: `sleep ${INTERVENING_MS / 1000}`, text: "delayed intervening gate" },
        "done",
      ] })],
      // the worker's only change is a TEST file, so coveringTests attributes the diff and the round
      // runs a selection instead of falling back to the full suite
      { tasks: { T1: [{ shell: `echo "// worker" > covered.test.js && ${COMMIT} covered`, result: { ok: true, summary: "done" } }] } },
      `gates: { test: "${testCmd}" }\n`,
    );
    await runDaemon(fixture, "run-telemetry-composite");
    const { repo } = fixture;
    const rows = gateRows(repo, "run-telemetry-composite");
    const testRows = rows.filter((r) => r.gate === "test");
    const intervening = rows.find((r) => r.gate === "acceptance")!;
    const events = Journal.open(repo, "run-telemetry-composite").read();

    // one logical `test` row per round, and it really is the composite one: the screen ran a subset
    // and the merge-candidate round ran the whole suite on the same commit
    expect(testRows).toHaveLength(1);
    const row = testRows[0]!;
    expect(row.selectedTests).toEqual(["covered.test.js"]);
    expect(row.fullSuite).toBe(true);
    expect(intervening.durationMs).toBeGreaterThanOrEqual(INTERVENING_MS); // the intervening gate really was delayed

    const duration = row.durationMs;
    const selected = row.selectedDurationMs as number;
    const full = row.fullDurationMs as number;
    // the two halves are kept apart AND they are exactly what the whole is made of
    expect(selected + full).toBe(duration);
    expect(selected).toBeGreaterThanOrEqual(SELECTED_MS);
    expect(selected).toBeLessThan(FULL_MS); // the screen is the subset, not a second full suite
    expect(full).toBeGreaterThanOrEqual(FULL_MS);

    // full-only counting fails: the screen's cost is in there too
    expect(duration).toBeGreaterThanOrEqual(SELECTED_MS + FULL_MS);
    // wait-inclusive counting fails: the intervening gate's 1.2s sat BETWEEN the two intervals and is
    // excluded, so the sum stays under the span that would have swallowed it
    expect(duration).toBeLessThan(SELECTED_MS + FULL_MS + INTERVENING_MS);

    // and it is measured where the gate runs, not re-derived: the journal span from the round's first
    // `test` phase-start to its verdict is strictly larger, because it contains everything in between
    const firstTestStart = events.find((e) => e.event === "phase-start" && e.data.gate === "test")!;
    const verdict = events.find((e) => e.event === "gate-result" && e.data.gate === "test")!;
    const journalSpan = Date.parse(verdict.ts) - Date.parse(firstTestStart.ts);
    expect(journalSpan).toBeGreaterThan(duration + INTERVENING_MS);
  }, 180000);

  test("test: review & acceptance rows carry per-invocation durations & channels covering primary & retry so a single blended span fails", async () => {
    // Both verdict gates re-ask exactly once when the first seat answers unparseably (GATE-09 for the
    // judge, OBS-193 for the review), so the gate's own durationMs is an ENVELOPE over two dispatches.
    // The parked ceiling and inactivity-window recalibrations are stated per INVOCATION, so a single
    // blended span cannot fund them — these rows have to name each dispatch and what it cost.

    // acceptance: each acceptanceGate call first pays a separately delayed deterministic command,
    // then dispatches adapters with two different known delays. The command is pre-dispatch work:
    // wrapper-level timing reports PREPROCESS + adapter, while dispatch-seam timing reports adapter.
    const judged = setupRepo([T("T1", { acceptance: [
      { oracle: "command", command: `sleep ${PREPROCESS_MS / 1000}`, text: "delayed deterministic setup" },
      "done",
    ] })], {
      ...oneTask("T1"),
      judge: ["not-a-verdict", { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }],
    });
    const delayedJudge = new DelayedFake(judged.scriptPath, {
      judge: { "fake-1": JUDGE_PRIMARY_MS, "fake-2": JUDGE_RETRY_MS },
    });
    await daemon(judged.repo, { adapters: [delayedJudge], runId: "run-telemetry-judge-invocations" });
    const acceptance = gateRows(judged.repo, "run-telemetry-judge-invocations").find((r) => r.gate === "acceptance")!;
    expect(Journal.open(judged.repo, "run-telemetry-judge-invocations").read()
      .filter((e) => e.event === "judge-retry")).toHaveLength(1); // the retry really happened
    expect(acceptance.pass).toBe(true); // and the retry's verdict is what decided the gate
    assertInvocations(acceptance, [
      { channel: "fake:fake-1", delayMs: JUDGE_PRIMARY_MS },
      { channel: "fake:fake-2", delayMs: JUDGE_RETRY_MS },
    ]);

    // review: the declared leaf path makes reviewGate perform changed-path promotion before each
    // dispatch. A test-only git wrapper delays precisely that read; the diff then escapes the leaf
    // class through an allowed deviation, so review still dispatches and retries normally.
    const reviewed = setupRepo(
      [T("T1", { files: ["docs/note.md"] })],
      { tasks: { T1: [{
        shell: `mkdir -p docs && echo note > docs/note.md && echo extra > t1.txt && ${COMMIT} review-telemetry`,
        result: { ok: true, summary: "done" },
      }] } },
      'review: { prefer: ["fakeg:g-1"] }\nscope: { allowDeviations: ["t1.txt"] }\n',
    );
    const fallback = new DelayedFake(reviewed.scriptPath, { review: { "fake-2": REVIEW_RETRY_MS } });
    const garbage = new GarbageReviewer(reviewed.scriptPath, REVIEW_PRIMARY_MS);
    await withDelayedReviewPreprocessing(PREPROCESS_MS, () =>
      daemon(reviewed.repo, { adapters: [fallback, garbage], runId: "run-telemetry-review-invocations" }));
    const review = gateRows(reviewed.repo, "run-telemetry-review-invocations").find((r) => r.gate === "review")!;
    expect(Journal.open(reviewed.repo, "run-telemetry-review-invocations").read()
      .filter((e) => e.event === "review-retry")).toHaveLength(1);
    expect(review.pass).toBe(true);
    assertInvocations(review, [
      { channel: "fakeg:g-1", delayMs: REVIEW_PRIMARY_MS },
      { channel: "fake:fake-2", delayMs: REVIEW_RETRY_MS },
    ]);
  }, 180000);
});

/**
 * One entry per dispatch, in dispatch order, each naming its own channel and its own cost. Two
 * falsifiers live here: a row that blended the pair into one span has a single entry (and that
 * entry's duration is the whole gate), and a row that recorded two spans but only one channel
 * cannot say which seat the recalibration should attribute the slow invocation to.
 */
const PREPROCESS_MS = 1800;
const JUDGE_PRIMARY_MS = 350;
const JUDGE_RETRY_MS = 850;
const REVIEW_PRIMARY_MS = 450;
const REVIEW_RETRY_MS = 950;
const INVOCATION_SLOP_MS = 700;

function assertInvocations(row: GateRow, expected: Array<{ channel: string; delayMs: number }>): void {
  const invocations = row.invocations as Array<{ channel: string; durationMs: number }>;
  expect(invocations).toHaveLength(expected.length);
  expect(invocations.map((i) => i.channel)).toEqual(expected.map((e) => e.channel));
  expect(new Set(invocations.map((i) => i.channel)).size).toBe(expected.length); // primary ≠ retry
  const gateMs = row.durationMs;
  for (const [index, invocation] of invocations.entries()) {
    const delayed = expected[index]!;
    expect(typeof invocation.durationMs).toBe("number");
    // Each value tracks ITS adapter's delay: hardcoded 1ms fails the lower bound, the old wrapper-level
    // clock fails the upper bound by including PREPROCESS_MS, and swapping/blending the pair fails too.
    expect(invocation.durationMs).toBeGreaterThanOrEqual(delayed.delayMs);
    expect(invocation.durationMs).toBeLessThan(delayed.delayMs + INVOCATION_SLOP_MS);
    expect(invocation.durationMs).toBeLessThan(gateMs);
  }
  expect(invocations.reduce((n, i) => n + i.durationMs, 0)).toBeLessThanOrEqual(gateMs);
}

type VerdictDelays = Partial<Record<"judge" | "review", Record<string, number>>>;

/** Fake verdict transport with independently controllable adapter delays by role and model. */
class DelayedFake extends FakeAdapter {
  constructor(scriptPath: string, private readonly delays: VerdictDelays) {
    super(scriptPath);
  }

  override headlessCommand(promptFile: string, model: string): string {
    const prompt = readFileSync(promptFile, "utf8");
    const role = prompt.startsWith("TICKMARKR-JUDGE") ? "judge"
      : prompt.startsWith("TICKMARKR-REVIEW") ? "review"
      : undefined;
    const command = super.headlessCommand(promptFile, model);
    const delayMs = role ? this.delays[role]?.[model] : undefined;
    return delayMs ? `sleep ${delayMs / 1000}; ${command}` : command;
  }
}

/** Delay only reviewGate's leaf-path promotion read; all other daemon git operations remain normal. */
async function withDelayedReviewPreprocessing<T>(delayMs: number, run: () => Promise<T>): Promise<T> {
  const binDir = makeTestTempDir("tickmarkr-delayed-git-");
  const wrapper = join(binDir, "git");
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(wrapper, [
    "#!/bin/sh",
    `if [ "$1" = "diff" ] && [ "$2" = "--name-only" ] && [ "$3" = "--no-renames" ]; then sleep ${delayMs / 1000}; fi`,
    'exec "$TICKMARKR_TELEMETRY_REAL_GIT" "$@"',
  ].join("\n"));
  chmodSync(wrapper, 0o755);
  const priorPath = process.env.PATH;
  const priorRealGit = process.env.TICKMARKR_TELEMETRY_REAL_GIT;
  process.env.PATH = `${binDir}:${priorPath ?? ""}`;
  process.env.TICKMARKR_TELEMETRY_REAL_GIT = realGit;
  try {
    return await run();
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorRealGit === undefined) delete process.env.TICKMARKR_TELEMETRY_REAL_GIT;
    else process.env.TICKMARKR_TELEMETRY_REAL_GIT = priorRealGit;
  }
}

// A reviewer seat that answers WITHOUT the verdict nonce: an adapter id other than "fake" is never
// nonce-augmented by the LLM transport, which is the same unparseable shape a real CLI produces when
// its verdict is cut off. `cheap` keeps it below the implement floor so it never draws WORKER routing;
// review.prefer is what puts it first in the reviewer pick.
class GarbageReviewer extends FakeAdapter {
  override id = "fakeg";
  override vendor = "fakeg";
  constructor(scriptPath: string, private readonly delayMs = 0) {
    super(scriptPath);
  }
  override async probe(): Promise<AuthHealth> {
    return { installed: true, authed: true, version: "fakeg", models: ["g-1"], modelAuth: authedModels(["g-1"]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, vendor: this.vendor, model: "g-1", channel: "sub", tier: "cheap" }];
  }
  override headlessCommand(promptFile: string, model: string): string {
    const command = super.headlessCommand(promptFile, model);
    return this.delayMs ? `sleep ${this.delayMs / 1000}; ${command}` : command;
  }
}
