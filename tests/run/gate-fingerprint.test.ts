import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, test } from "vitest";
import type { Assignment } from "../../src/adapters/types.js";
import { loadConfig } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead, shGit, shGitOk, verificationProtocol } from "../../src/run/git.js";
import { GATE_FINGERPRINT_CAP, identicalGateFailures, Journal, normalizeGateFailure, type JournalEvent } from "../../src/run/journal.js";
import { ensureIntegration, integrationBranch } from "../../src/run/merge.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// T34 tracked fixture: the two recorded T21 gate-test details from run-20260805-164546, at
// 2026-08-05T17:33:02.522Z and 2026-08-05T18:11:01.544Z, captured VERBATIM from that run's journal
// and committed here. The live journal under .tickmarkr/ is gitignored and absent from every clean
// checkout, so this tracked capture — not the journal, not a re-typed transcription — is the only
// hermetic source. The pair names the same five suites in the same order and differs ONLY in the
// base-moved runner tallies: 192 passed | 1 skipped (197) became 193 passed | 1 skipped (198), and
// 2962 passed | 2 skipped (2969) became 2968 passed | 2 skipped (2975).
const RECORDED_1733 = `failing tests:
 Test Files  4 failed | 192 passed | 1 skipped (197)
      Tests  5 failed | 2962 passed | 2 skipped (2969)
 FAIL  |suite| tests/adapters/prompt.test.ts > parseWorkerResult > fail-closed on missing or garbled trailer
 FAIL  |suite| tests/adapters/prompt.test.ts > parseWorkerResult v1.2 hardening (interactive transcripts) > template echo alone fails closed
 FAIL  |suite| tests/gates/verdict-nonce.test.ts > judge review and consult verdict surfaces all require the nonce > consult rejects unbound verdict output
 FAIL  |suite| tests/run/consult.test.ts > consult.prefer seat failover > a verdict failure on every seat still returns the fail safe human action
 FAIL  |suite| tests/run/worker-result-cause.test.ts > worker-result cause journaling (v1.46 T1, zero tokens) > a finished worker with an unparseable trailer journals cause malformed-trailer

new failure fingerprints vs baseline (secondary):
Test Files # failed | # passed | # skipped (#)
Tests # failed | # passed | # skipped (#)
FAIL |suite| tests/adapters/prompt.test.ts > parseWorkerResult > fail-closed on missing or garbled trailer
AssertionError: expected 'worker produced no TICKMARKR_RESULT t…' to be 'unparseable TICKMARKR_RESULT trailer' // Object.is equality
FAIL |suite| tests/adapters/prompt.test.ts > parseWorkerResult v#.# hardening (interactive transcripts) > template echo alone fails closed
FAIL |suite| tests/gates/verdict-nonce.test.ts > judge review and consult verdict surfaces all require the nonce > consult rejects unbound verdict output
AssertionError: expected 'consult produced no verdict — failing…' to match /unparseable/i
FAIL |suite| tests/run/consult.test.ts > consult.prefer seat failover > a verdict failure on every seat still returns the fail safe human action
AssertionError: expected { action: 'human', …(#) } to deeply equal { action: 'human', …(#) }
FAIL |suite| tests/run/worker-result-cause.test.ts > worker-result cause journaling (v#.# T#, zero tokens) > a finished worker with an unparseable trailer journals cause malformed-trailer
AssertionError: expected 'clean-exit-no-trailer' to be 'malformed-trailer' // Object.is equality`;

const RECORDED_1811 = `failing tests:
 Test Files  4 failed | 193 passed | 1 skipped (198)
      Tests  5 failed | 2968 passed | 2 skipped (2975)
 FAIL  |suite| tests/adapters/prompt.test.ts > parseWorkerResult > fail-closed on missing or garbled trailer
 FAIL  |suite| tests/adapters/prompt.test.ts > parseWorkerResult v1.2 hardening (interactive transcripts) > template echo alone fails closed
 FAIL  |suite| tests/gates/verdict-nonce.test.ts > judge review and consult verdict surfaces all require the nonce > consult rejects unbound verdict output
 FAIL  |suite| tests/run/consult.test.ts > consult.prefer seat failover > a verdict failure on every seat still returns the fail safe human action
 FAIL  |suite| tests/run/worker-result-cause.test.ts > worker-result cause journaling (v1.46 T1, zero tokens) > a finished worker with an unparseable trailer journals cause malformed-trailer

new failure fingerprints vs baseline (secondary):
Test Files # failed | # passed | # skipped (#)
Tests # failed | # passed | # skipped (#)
FAIL |suite| tests/adapters/prompt.test.ts > parseWorkerResult > fail-closed on missing or garbled trailer
AssertionError: expected 'worker produced no TICKMARKR_RESULT t…' to be 'unparseable TICKMARKR_RESULT trailer' // Object.is equality
FAIL |suite| tests/adapters/prompt.test.ts > parseWorkerResult v#.# hardening (interactive transcripts) > template echo alone fails closed
FAIL |suite| tests/gates/verdict-nonce.test.ts > judge review and consult verdict surfaces all require the nonce > consult rejects unbound verdict output
AssertionError: expected 'consult produced no verdict — failing…' to match /unparseable/i
FAIL |suite| tests/run/consult.test.ts > consult.prefer seat failover > a verdict failure on every seat still returns the fail safe human action
AssertionError: expected { action: 'human', …(#) } to deeply equal { action: 'human', …(#) }
FAIL |suite| tests/run/worker-result-cause.test.ts > worker-result cause journaling (v#.# T#, zero tokens) > a finished worker with an unparseable trailer journals cause malformed-trailer
AssertionError: expected 'clean-exit-no-trailer' to be 'malformed-trailer' // Object.is equality`;

// A details text in the exact grammar baseline.ts:209-219 emits: the failing-tests headline block,
// a blank line, then the secondary fingerprint section.
const detail = (testFilesTally: string, testsTally: string) =>
  [
    "failing tests:",
    ` Test Files  ${testFilesTally}`,
    `      Tests  ${testsTally}`,
    " FAIL  |suite| tests/x.test.ts > suite > the defect",
    "",
    "new failure fingerprints vs baseline (secondary):",
    "secondary",
  ].join("\n");

describe("gate fingerprint — base-moved runner tally (T34)", () => {
  test("test: the two recorded T21 gate details normalize to identical bytes, read from a TRACKED verbatim capture of those two details committed as a fixture — never from a live journal under `.tickmarkr/`, which is gitignored and absent from every clean checkout, and never from a re-typed transcription", () => {
    // Sanity that the fixture IS the recorded incident: two distinct raw captures, both carrying
    // the failing-tests header, differing only in tally fields.
    expect(RECORDED_1733).not.toBe(RECORDED_1811);
    expect(RECORDED_1733).toContain("failing tests:");
    expect(RECORDED_1811).toContain("failing tests:");
    expect(RECORDED_1733).toContain("192 passed | 1 skipped (197)");
    expect(RECORDED_1811).toContain("193 passed | 1 skipped (198)");
    expect(RECORDED_1733).toContain("2962 passed | 2 skipped (2969)");
    expect(RECORDED_1811).toContain("2968 passed | 2 skipped (2975)");
    expect(normalizeGateFailure(RECORDED_1733)).toBe(normalizeGateFailure(RECORDED_1811));
  });

  test("test: only the tally FIELDS are masked and every other number on that line is identity, proven member by member over the closed set of identity-bearing positions that share a line with a tally — a differing failed-assertion count, a differing failing-suite count, an exit status appended to the line, and a parenthesized code appended after the derived total — where the tally fields are exactly the passed count, the skipped and todo counts, and the derived parenthesized total", () => {
    // The tally FIELDS — passed count, skipped and todo counts, derived parenthesized total — move
    // with the base and MUST collapse, every one of them differing at once on both summary lines.
    const moved = detail("4 failed | 192 passed | 1 skipped | 0 todo (197)", "5 failed | 2962 passed | 2 skipped | 0 todo (2969)");
    const movedAgain = detail("4 failed | 193 passed | 2 skipped | 3 todo (202)", "5 failed | 2968 passed | 4 skipped | 1 todo (2978)");
    expect(normalizeGateFailure(moved)).toBe(normalizeGateFailure(movedAgain));

    // The closed set of identity-bearing positions sharing a line with a tally — each MUST stay
    // identity, member by member: [Test Files tally A, Tests tally A, Test Files tally B, Tests tally B, member].
    const identityPairs: Array<[string, string, string, string, string]> = [
      // a differing failed-assertion count
      ["4 failed | 1 passed (5)", "5 failed | 10 passed (15)", "4 failed | 1 passed (5)", "6 failed | 10 passed (15)", "failed-assertion count"],
      // a differing failing-suite count
      ["4 failed | 10 passed (14)", "5 failed | 1 passed (6)", "5 failed | 10 passed (14)", "5 failed | 1 passed (6)", "failing-suite count"],
      // an exit status appended to the line
      ["4 failed | 1 passed (5)", "1 failed | 12 passed (13) | exit 1", "4 failed | 1 passed (5)", "1 failed | 12 passed (13) | exit 2", "appended exit status"],
      // a parenthesized code appended after the derived total
      ["4 failed | 1 passed (5)", "5 failed | 10 passed (15) | upstream HTTP (404)", "4 failed | 1 passed (5)", "5 failed | 10 passed (15) | upstream HTTP (500)", "appended parenthesized code"],
    ];
    for (const [filesA, testsA, filesB, testsB, member] of identityPairs) {
      expect(normalizeGateFailure(detail(filesA, testsA)), member).not.toBe(normalizeGateFailure(detail(filesB, testsB)));
    }

    // And the kept numbers survive literally in the normalized bytes while the masked ones are gone.
    const kept = normalizeGateFailure(detail("4 failed | 192 passed (196)", "7 failed | 2962 passed (2969) | exit 1"));
    expect(kept).toContain("4 failed");
    expect(kept).toContain("7 failed");
    expect(kept).toContain("exit 1");
    expect(kept).not.toContain("192");
    expect(kept).not.toContain("2962");
  });

  test("test: identicalGateFailures counts the recorded pair as a repeat and reaches the cap, proven through the same call the daemon makes rather than through the normalizer alone", () => {
    // The exact call the daemon makes (daemon.ts gate-fingerprint-cap): identicalGateFailures over
    // the journaled gate-result events, compared against the current failure's normalization.
    const events: JournalEvent[] = [
      { ts: "2026-08-05T17:33:02.522Z", event: "gate-result", taskId: "T21", data: { gate: "test", pass: false, details: RECORDED_1733 } },
      { ts: "2026-08-05T18:11:01.544Z", event: "gate-result", taskId: "T21", data: { gate: "test", pass: false, details: RECORDED_1811 } },
    ];
    const repeats = identicalGateFailures(events, "T21", "test", normalizeGateFailure(RECORDED_1811));
    expect(repeats).toBe(GATE_FINGERPRINT_CAP);
  });

  test("test: no fingerprint pair distinguished OUTSIDE the runner's base-moved tally fields is newly collapsed, proven member by member over the closed set of texts that carry a tally shape without being a runner summary — a tally-shaped sequence inside a quoted assertion payload, a tally-shaped line quoted in review prose, and a tally-shaped suffix on a single-line assertion message — each pair distinct before the change and required to remain distinct after it", () => {
    const pairs: Array<[string, string, string]> = [
      // a tally-shaped sequence inside a quoted assertion payload
      [
        "AssertionError: expected \"Tests 1 failed | 2 passed (3)\" to be \"ok\"",
        "AssertionError: expected \"Tests 1 failed | 9 passed (10)\" to be \"ok\"",
        "quoted assertion payload",
      ],
      // a tally-shaped line quoted in review prose
      [
        "reviewer: the run printed \"Tests 1 failed | 2 passed (3)\" verbatim, fix the tally",
        "reviewer: the run printed \"Tests 1 failed | 9 passed (10)\" verbatim, fix the tally",
        "tally-shaped line in review prose",
      ],
      // a tally-shaped suffix on a single-line assertion message
      [
        "AssertionError: expected \"foo\" Tests 5 failed | 2 passed (7)",
        "AssertionError: expected \"foo\" Tests 5 failed | 9 passed (14)",
        "tally-shaped suffix on a single-line assertion message",
      ],
      // review regression (round 5): a FAIL headline inside the failing-tests block whose test
      // NAME carries tally-shaped text — provenance matched, shape did not, so it stays identity
      [
        detail("4 failed | 1 passed (5)", "5 failed | 2 passed (7)").replace("the defect", "the 192 passed (197) defect"),
        detail("4 failed | 1 passed (5)", "5 failed | 2 passed (7)").replace("the defect", "the 193 passed (198) defect"),
        "FAIL headline carrying tally-shaped test-name text",
      ],
    ];
    for (const [textA, textB, member] of pairs) {
      expect(normalizeGateFailure(textA), member).not.toBe(normalizeGateFailure(textB));
    }
  });
});

// The mkdtemp root the runtime actually hands out on this platform class: os.tmpdir() resolves to
// /var/folders/<2>/<30>/T on darwin and /tmp on linux, and mkdtemp appends exactly six characters
// from [A-Za-z0-9] to the caller's chosen prefix (observed: tickmarkr-demo- + "IwtrdE").
const DARWIN_TMP = "/var/folders/xz/s67kmj4x68n4qlkkbrvfhvfr0000gn/T";

// A gate detail that NAMES the temp directory — once as the path's final segment (an mkdir that
// failed, so nothing deeper exists to name) and once as the parent of a file inside it. Not phrased
// with an assertion cue: a payload span is protected from every rule here by design, so a fixture
// that hid the path inside one would prove nothing about the path rules.
const tmpDetail = (root: string, dir: string) =>
  [
    "failing tests:",
    " Test Files  1 failed | 192 passed (193)",
    "      Tests  1 failed | 2962 passed (2963)",
    " FAIL  |suite| tests/gates/llm.test.ts > llm gate > writes the judge prompt",
    "",
    "new failure fingerprints vs baseline (secondary):",
    `Error: EACCES: permission denied, mkdir '${root}/${dir}'`,
    `  the judge prompt could not be written to ${root}/${dir}/prompt.md`,
  ].join("\n");

describe("gate fingerprint — mkdtemp suffix (T3)", () => {
  test("test: two raw gate-failure details differing only in the random suffix of a mkdtemp directory normalize to identical bytes, with the suffix present in both inputs", () => {
    const a = tmpDetail(DARWIN_TMP, "tickmarkr-llm-IwtrdE");
    const b = tmpDetail(DARWIN_TMP, "tickmarkr-llm-kkOtkR");

    // The suffix is IN both raw inputs — the fixture is two real renderings of one defect, not two
    // texts that were already identical before normalization ran.
    expect(a).toContain("tickmarkr-llm-IwtrdE");
    expect(b).toContain("tickmarkr-llm-kkOtkR");
    expect(a).not.toBe(b);

    expect(normalizeGateFailure(a)).toBe(normalizeGateFailure(b));
    // …and identical BECAUSE the suffix is gone, not because the whole path collapsed to nothing.
    expect(normalizeGateFailure(a)).not.toContain("IwtrdE");
    expect(normalizeGateFailure(b)).not.toContain("kkOtkR");
    expect(normalizeGateFailure(a)).toContain("tickmarkr-llm-");

    // Same defect under the linux tmp root, and the deeper path inside the directory is unaffected.
    expect(normalizeGateFailure(tmpDetail("/tmp", "tickmarkr-llm-Ab3xYz")))
      .toBe(normalizeGateFailure(tmpDetail("/tmp", "tickmarkr-llm-9QmpZ0")));
    expect(normalizeGateFailure(a)).toContain("prompt.md");
  });

  test("test: two failures naming different mkdtemp prefixes still normalize apart, so distinct defects cannot spend one another's retry budget", () => {
    // Every prefix mkdtemp is called with in src/ is a distinct diagnostic location; a pair of them
    // must never fingerprint together however the suffixes fall.
    // Same suffix on both sides, so the prefix ALONE has to keep them apart.
    const prefixes = ["tickmarkr-llm-", "tickmarkr-eval-", "tickmarkr-scope-compile-", "tickmarkr-probe-", "tickmarkr-mode-"];
    for (const p of prefixes) {
      for (const q of prefixes) {
        if (p === q) continue;
        expect(normalizeGateFailure(tmpDetail(DARWIN_TMP, `${p}IwtrdE`)), `${p} vs ${q}`)
          .not.toBe(normalizeGateFailure(tmpDetail(DARWIN_TMP, `${q}IwtrdE`)));
      }
      // The chosen prefix survives literally — it is the only thing left telling the two apart.
      expect(normalizeGateFailure(tmpDetail(DARWIN_TMP, `${p}IwtrdE`))).toContain(p);
    }
    // The realistic pair of two live leaks: different prefix AND different suffix.
    expect(normalizeGateFailure(tmpDetail(DARWIN_TMP, "tickmarkr-scope-compile-Xy12Ab")))
      .not.toBe(normalizeGateFailure(tmpDetail(DARWIN_TMP, "tickmarkr-probe-Q7fPz0")));

    // Nor may the erasure reach past the generated suffix into a chosen name that merely looks like
    // one: an ordinary six-letter directory under a tmp root stays identity…
    expect(normalizeGateFailure(tmpDetail("/tmp", "tickmarkr-worker-output")))
      .not.toBe(normalizeGateFailure(tmpDetail("/tmp", "tickmarkr-worker-stderrs")));
    expect(normalizeGateFailure(tmpDetail("/tmp", "tickmarkr-worker-output"))).toContain("output");
    // …and a hyphenated word in ordinary prose, rooted in no temp directory at all, is untouched.
    expect(normalizeGateFailure("worker left the run-detail marker behind"))
      .not.toBe(normalizeGateFailure("worker left the run-config marker behind"));
  });

  test("test: a run of gate-result events carrying the same underlying failure with different mkdtemp suffixes reaches GATE_FINGERPRINT_CAP through identicalGateFailures", () => {
    // Each dispatch gets a fresh mkdtemp directory, so the cap is only reachable if the suffixes
    // normalize away — this is the exact call daemon.ts makes at gate-fingerprint-cap.
    const suffixes = ["IwtrdE", "kkOtkR", "0KtKrj", "87dTKr"].slice(0, GATE_FINGERPRINT_CAP);
    const events: JournalEvent[] = suffixes.map((s, i) => ({
      ts: `2026-08-06T1${i}:00:00.000Z`,
      event: "gate-result",
      taskId: "T5",
      data: { gate: "test", pass: false, details: tmpDetail(DARWIN_TMP, `tickmarkr-llm-${s}`) },
    }));
    // A DIFFERENT leak journaled in between must not fund this cap.
    events.splice(1, 0, {
      ts: "2026-08-06T10:30:00.000Z",
      event: "gate-result",
      taskId: "T5",
      data: { gate: "test", pass: false, details: tmpDetail(DARWIN_TMP, "tickmarkr-mode-Q7fPz0") },
    });
    expect(new Set(events.map((e) => String(e.data.details))).size).toBe(GATE_FINGERPRINT_CAP + 1);

    const current = normalizeGateFailure(String(events.at(-1)!.data.details));
    expect(identicalGateFailures(events, "T5", "test", current)).toBe(GATE_FINGERPRINT_CAP);

    // An enacted operator approval is still a new engagement, and a different prefix still buys its own budget.
    const approval: JournalEvent = { ts: "2026-08-06T11:30:00.000Z", event: "task-approved", taskId: "T5", data: {} };
    const approved: JournalEvent[] = [events[0]!, approval, { ts: "2026-08-06T11:31:00.000Z", event: "task-dispatch", taskId: "T5", data: {} }, events.at(-1)!];
    expect(identicalGateFailures(approved, "T5", "test", current)).toBe(1);
    // OBS-1178: an approval the daemon refused is no new engagement — the count stands.
    const refused: JournalEvent[] = [events[0]!, approval, { ts: "2026-08-06T11:31:00.000Z", event: "approval-refused", taskId: "T5", data: { lines: [2] } }, events.at(-1)!];
    expect(identicalGateFailures(refused, "T5", "test", current)).toBe(GATE_FINGERPRINT_CAP);
    expect(identicalGateFailures(events, "T5", "test", normalizeGateFailure(tmpDetail(DARWIN_TMP, "tickmarkr-eval-IwtrdE")))).toBe(0);
  });
});


// OBS-1106 residual: occurrences are independent observations. A journal replay or a verdict-cache
// hit of one red is a COPY of it; only a fresh execution is a second occurrence.
describe("gate fingerprint — copied evidence is one occurrence (OBS-1106)", () => {
  const ASSIGNMENT: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
  const NAMED = "echo 'FAIL t1.test.ts > reads one'; echo 'AssertionError: expected one to be two'; exit 1";
  const TIMEOUT = "echo 'FAIL t1.test.ts > slow'; echo 'Error: Test timed out in 5000ms.'; exit 1";
  const of = (evs: JournalEvent[], event: string) => evs.filter((e) => e.event === event && e.taskId === "T1");
  const testRows = (evs: JournalEvent[]) => of(evs, "gate-result").filter((e) => e.data.gate === "test");
  const fresh = (e: JournalEvent) => e.data.reused !== true && typeof e.data.replayedFromAttempt !== "number" && e.data.replayMeasurement !== true;
  const occurrences = (evs: JournalEvent[], red: JournalEvent) =>
    identicalGateFailures(evs, "T1", "test", normalizeGateFailure(String(red.data.details)));
  /** Worker steps: the first lands t1.txt, every later one lands `later` (nothing, or a new commit). */
  const repoWith = (red: string, later: (i: number) => string) => setupRepo(
    [T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] })],
    {
      consult: { action: "human", notes: "operator decides" },
      tasks: { T1: [
        { shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } },
        ...Array.from({ length: 8 }, (_, i) => ({ shell: later(i), result: { ok: true, summary: `step ${i}` } })),
      ] },
    },
    stringify({ gates: { build: "true", test: `[ ! -f t1.txt ] || { ${red}; }`, lint: "true" } }),
  );

  test("test: the production daemon counts cache or journal copies as one failure across resume and forces a fresh execution after a no-commit timeout repair versus counting an independent repeated red as two, so copied evidence buying a fingerprint-cap escalation fails", async () => {
    // ---- journal copy across resume: a pre-resume red, replayed by a repair that lands nothing ----
    {
      const runId = "run-copy-resume";
      const commands = { build: "true", test: "[ ! -f work.txt ] || { " + NAMED + "; }", lint: "true" };
      const { repo, fake } = setupRepo(
        [T("T1", { files: ["work.txt"] })],
        { consult: { action: "human", notes: "operator decides" },
          tasks: { T1: Array.from({ length: 4 }, () => ({ shell: "true", result: { ok: true, summary: "nothing to change" } })) } },
        stringify({ gates: commands }),
      );
      const base = await gitHead(repo);
      const branch = integrationBranch(loadConfig(repo), runId);
      await ensureIntegration(repo, branch, base);
      const wt = await new SubprocessDriver().worktree(repo, `${branch}--T1`, base);
      writeFileSync(join(wt, "work.txt"), "landed work\n");
      await shGitOk("git add work.txt && git commit --no-gpg-sign -m work", wt);
      const history = await shGit(`git log --reverse --format='%T%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e' ${base}..${await gitHead(wt)}`, wt);
      const subject = createHash("sha256").update(history.stdout).digest("hex");
      const details = "failing tests:\n FAIL t1.test.ts > reads one\nAssertionError: expected one to be two";
      const j = Journal.create(repo, runId);
      j.append("run-start", undefined, { pid: 111_113, baseRef: base, commands, branch, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
      j.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 0, retryMode: "fresh" });
      j.append("worker-launch", "T1", {});
      j.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [], finished: true, exitCode: 0 });
      j.phaseStart("T1", "gates");
      j.append("gate-result", "T1", { gate: "build", verification: verificationProtocol(), commit: subject, attempt: 0, pass: true });
      j.append("gate-result", "T1", { gate: "test", verification: verificationProtocol(), commit: subject, attempt: 0, pass: false, details,
        evidenceReceipt: { invocationId: "inv-original" } });
      j.append("repair-attempt", "T1", { repair: 1, charge: 1, of: 2, gates: ["test"], commits: 1, findings: `test: ${details}` });
      j.append("run-end", undefined, { runId, branch, done: [], failed: [], human: [], blocked: [], pending: ["T1"] });
      writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({
        commands: Object.fromEntries(Object.keys(commands).map((gate) => [gate, { exitCode: 0, fingerprints: [] }])),
      }));
      await runDaemon(repo, { adapters: [fake], runId, resume: true });
      const all = Journal.open(repo, runId).read();
      const post = all.slice(all.map((e) => e.event).lastIndexOf("run-resume") + 1);
      const replayed = testRows(post).filter((e) => e.data.replayedFromAttempt === 0);
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed[0]!.data).toMatchObject({ pass: false, commit: subject, attempt: 1 });
      // the replay is the pre-resume observation restated: ONE occurrence, so no cap on the copy
      expect(occurrences(all.slice(0, all.indexOf(replayed[0]!) + 1), replayed[0]!)).toBe(1);
      const firstCap = all.findIndex((e) => e.event === "gate-fingerprint-cap" && e.taskId === "T1");
      const freshReds = all.map((e, i) => [e, i] as const).filter(([e]) => e.event === "gate-result" && e.taskId === "T1"
        && e.data.gate === "test" && e.data.pass === false && fresh(e));
      if (firstCap !== -1) expect(freshReds.length >= 2 && freshReds[1]![1] < firstCap, "a cap needs two independent observations").toBe(true);
      expect(of(post, "gate-fingerprint-cap").filter((e) => e.data.attempt === 2)).toEqual([]);
    }
    // ---- cache and journal copies in one live run: nothing after the first red is new evidence -----
    {
      const runId = "run-copy-live";
      const { repo, fake } = repoWith(NAMED, () => "true");
      await runDaemon(repo, { adapters: [fake], runId });
      const all = Journal.open(repo, runId).read();
      const reds = testRows(all).filter((e) => e.data.pass === false);
      const copies = reds.filter((e) => !fresh(e));
      expect(reds.length).toBeGreaterThan(1);
      // both copy paths ran: the repair's journal replay and the fresh retry's verdict-cache hit
      expect(copies.some((e) => typeof e.data.replayedFromAttempt === "number")).toBe(true);
      expect(copies.some((e) => e.data.reused === true)).toBe(true);
      expect(reds.filter(fresh)).toHaveLength(1);
      expect(occurrences(all, reds.at(-1)!)).toBe(1);
      expect(of(all, "gate-fingerprint-cap")).toEqual([]);
    }
    // ---- a no-commit repair on a timeout red executes fresh: no replay, no cached red --------------
    {
      const runId = "run-timeout-fresh";
      const { repo, fake } = repoWith(TIMEOUT, () => "true");
      await runDaemon(repo, { adapters: [fake], runId });
      const all = Journal.open(repo, runId).read();
      const forced = of(all, "gate-fresh-forced");
      expect(forced.length).toBe(1);
      expect(forced[0]!.data).toMatchObject({ gate: "test", attempt: 1, priorAttempt: 0, reason: "no-commit-timeout-red" });
      const a1 = testRows(all).filter((e) => e.data.attempt === 1);
      expect(a1.length).toBe(1);
      expect(fresh(a1[0]!)).toBe(true);
      expect(of(all, "gate-replayed").filter((e) => e.data.attempt === 1)).toEqual([]);
      expect(of(all, "gate-reused-verdict").filter((e) => e.data.gate === "test")).toEqual([]);
      // the fresh re-observation IS independent evidence: a repeated timeout reaches the cap there
      expect(occurrences(all.slice(0, all.indexOf(a1[0]!) + 1), a1[0]!)).toBe(GATE_FINGERPRINT_CAP);
      const cap = of(all, "gate-fingerprint-cap")[0]!;
      expect(cap.data).toMatchObject({ gate: "test", occurrences: GATE_FINGERPRINT_CAP, attempt: 2 });
      // and it is forced ONCE: no second forced execution after the cap owns the next move
      expect(forced).toHaveLength(1);
    }
    // ---- across resume: a crash after the no-commit timeout repair finished but before its gates, or
    // inside its forced battery before the test row, still owes that one fresh execution -------------
    for (const cut of ["after-repair-result", "inside-forced-battery"] as const) {
      const runId = `run-timeout-fresh-crash-${cut}`;
      const { repo, fake } = repoWith(TIMEOUT, () => "true");
      await runDaemon(repo, { adapters: [fake], runId });
      const journal = Journal.open(repo, runId);
      const lived = journal.read();
      const repairResult = lived.findIndex((e, i) => e.event === "worker-result" && e.taskId === "T1"
        && lived.slice(0, i).some((d) => d.event === "task-dispatch" && d.taskId === "T1" && d.data.attempt === 1));
      const forcedRow = lived.findIndex((e) => e.event === "gate-fresh-forced" && e.taskId === "T1");
      expect(repairResult, cut).toBeGreaterThan(-1);
      expect(forcedRow, cut).toBeGreaterThan(repairResult);
      // the crash: nothing after the cut reached the ledger (the live fresh red included)
      const kept = lived.slice(0, (cut === "after-repair-result" ? repairResult : forcedRow) + 1);
      expect(testRows(kept).map((e) => e.data.attempt), cut).toEqual([0]);
      writeFileSync(join(journal.dir, "journal.jsonl"), kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
      await runDaemon(repo, { adapters: [fake], runId, resume: true });
      const all = Journal.open(repo, runId).read();
      const post = all.slice(all.map((e) => e.event).lastIndexOf("run-resume") + 1);
      expect(of(post, "gate-fresh-forced")[0]?.data, cut).toMatchObject({ gate: "test", resumed: true, reason: "no-commit-timeout-red" });
      // the resume battery EXECUTED the test gate: no cached red and no replay re-stated attempt 0's
      const red = testRows(post)[0]!;
      expect(red.data.pass, cut).toBe(false);
      expect(fresh(red), cut).toBe(true);
      const battery = post.slice(0, post.indexOf(red) + 1);
      expect(of(battery, "gate-reused-verdict").filter((e) => e.data.gate === "test"), cut).toEqual([]);
      expect(of(battery, "gate-rerun").map((e) => e.data), cut).toMatchObject([{ gate: "test", bypass: "timeout-fresh" }]);
      // that fresh red is the second independent observation: the cap, not a copy, owns the next move
      expect(occurrences(all.slice(0, all.indexOf(red) + 1), red), cut).toBe(GATE_FINGERPRINT_CAP);
    }
    // ---- an independent repeated red (a new commit each attempt) counts as two ---------------------
    {
      const runId = "run-independent";
      const { repo, fake } = repoWith(NAMED, (i) => `echo ${i} > t${i + 2}.txt && ${COMMIT} more${i}`);
      await runDaemon(repo, { adapters: [fake], runId });
      const all = Journal.open(repo, runId).read();
      const reds = testRows(all).filter((e) => e.data.pass === false);
      expect(reds.slice(0, 2).every(fresh)).toBe(true);
      expect(new Set(reds.slice(0, 2).map((e) => e.data.commit)).size).toBe(2);
      expect(occurrences(all.slice(0, all.indexOf(reds[1]!) + 1), reds[1]!)).toBe(GATE_FINGERPRINT_CAP);
      const cap = of(all, "gate-fingerprint-cap")[0]!;
      expect(cap.data).toMatchObject({ gate: "test", occurrences: GATE_FINGERPRINT_CAP, attempt: 2 });
      expect(all.indexOf(cap)).toBeGreaterThan(all.indexOf(reds[1]!));
    }
  }, 300_000);
});
