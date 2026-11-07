// Queue row 337 (D-2181 D2): the bounded interruption retry, through the production runDaemon → runGates →
// compareToBaseline path with a fake adapter and a scripted test command. The only seam is the verifier's
// output: a planned execution's red carries the captured interruption evidence (raw regression
// classification, its failing file, a measured window holding the suspend), exactly as a pre-upgrade
// verifier wrote it, BEFORE runGates' cache write — so the cache refusal is the production one too.
// The run-end tip verification is not a gate execution: the scripted command answers it green, uncounted.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, test, vi } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import * as baselineModule from "../../src/gates/baseline.js";
import { VerdictStore, type VerificationIdentity } from "../../src/gates/cache.js";
import type { GateResult } from "../../src/gates/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import * as git from "../../src/run/git.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import * as recoveryModule from "../../src/run/recovery.js";
import { attributable, executedFullTest, INTERRUPTED_RECHECK_EVENT, INTERRUPTED_RETRY_EVENT, interruptedLedger, interruptedRetryState, LISTING_INVOCATION_SUFFIX } from "../../src/run/recovery.js";
import { repairSelectionDecision } from "../../src/run/repair-selection.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const FROM = 1793621905332;
const CAPTURED_SUSPEND = { kind: "host-suspend", from: FROM, to: FROM + 170964, wallMs: 170964, monoMs: 170963.3752500005, subtractedMs: 170759.0830078125 };
const FILE = "tests/run/daemon/transport-closed.test.ts";
/** The one-file suite's existing attributed file a timeout-shaped red's isolated re-observation would rerun. */
const SLOW = "tests/slow.test.ts";
/** The runner-level diagnostic block the vitest manifest path appends to a red (a scripted runner cannot). */
const WORKER_RPC = "\nclassification: regression; runner-level diagnostic: never-started 0; reporter errors 1; runner vitest\nError: [vitest-worker]: Timeout calling \"onTaskUpdate\"";
/** `red` names a DIFFERENT failure than an interrupted execution; `infra` is a runner-infrastructure red the
 * ordinary in-gate retry would re-run; `starved` is a timeout red the host-starved remeasure would re-run
 * (its durations are injected at the sh seam by `starvedDurations`, never measured: row 377; D-2185 add.37);
 * `diag` is a timeout red with runner diagnostics on SLOW, which an isolated re-observation would rerun;
 * `discovery` is a manifest discovery refusal (listing receipts only); `litter` is a green full job that
 * then leaves dirt in the worktree; `stale` is a green full job whose command writes an IGNORED lockfile,
 * moving the verification identity, so its proof is stale and would buy a replacement job. */
type Outcome = "interrupted" | "green" | "red" | "infra" | "starved" | "diag" | "discovery" | "litter" | "stale"
  /** `same` is the uninterrupted twin of an interrupted execution's red (one fingerprint). */
  | "same";

afterEach(() => vi.restoreAllMocks());
const rows = (repo: string, runId: string) => Journal.open(repo, runId).read();
const of = (evs: JournalEvent[], event: string) => evs.filter((e) => e.event === event && e.taskId === "T1");
const testRows = (evs: JournalEvent[]) => of(evs, "gate-result").filter((e) => e.data.gate === "test");
const afterResume = (all: JournalEvent[]) => all.slice(all.map((e) => e.event).lastIndexOf("run-resume") + 1);

/** One task whose test command executes only once the worker lands t1.txt; each execution reads the next
 * planned outcome, and an `interrupted` one is published with the captured interruption evidence. With
 * `repairLands`, the second worker round lands a new commit: a new subject. */
function planned(plan: Outcome[], repairLands = false) {
  const dir = makeTestTempDir("interrupted-plan-");
  writeFileSync(join(dir, "plan"), `${plan.join("\n")}\n`);
  writeFileSync(join(dir, "run.sh"), `case "$PWD" in *tip-verify-*) exit 0;; esac
n=$(cat '${dir}/count' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${dir}/count'
case "$(sed -n "\${n}p" '${dir}/plan')" in
  green) exit 0;;
  red) echo 'FAIL t1.test.ts > reads two'; echo 'AssertionError: expected two to be three'; exit 1;;
  infra) echo 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"'; exit 1;;
  starved) echo 'FAIL t1.test.ts > reads one'; echo 'Error: Test timed out in 5000ms'; exit 1;;
  diag) echo 'FAIL ${SLOW} > slow'; echo 'Error: Test timed out in 5000ms.'; exit 1;;
  discovery) echo 'cannot list'; exit 2;;
  litter) echo left > "$PWD/litter.txt"; exit 0;;
  stale) echo '{"lockfileVersion":1}' > "$PWD/package-lock.json"; exit 0;;
  *) echo 'FAIL t1.test.ts > reads one'; echo 'AssertionError: expected one to be two'; exit 1;;
esac
`);
  const executions = () => existsSync(join(dir, "count")) ? Number(readFileSync(join(dir, "count"), "utf8").trim()) : 0;
  const setPlan = (next: Outcome[]) => writeFileSync(join(dir, "plan"), `${next.join("\n")}\n`);
  const { repo, fake } = setupRepo(
    [T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] })],
    { consult: { action: "human", notes: "operator decides" },
      tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } },
        ...(repairLands ? [{ shell: `echo two > t1.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }] : [])] } },
    stringify({ gates: { build: `[ ! -f '${join(dir, "build-fails")}' ]`, test: `[ ! -f t1.txt ] || sh '${join(dir, "run.sh")}'`, lint: "true" } }),
  );
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, SLOW), "// the attributed failing file\n");
  execFileSync("git", ["add", SLOW], { cwd: repo });
  execFileSync("git", ["commit", "--no-gpg-sign", "-q", "-m", "slow test"], { cwd: repo });
  appendFileSync(join(repo, ".git", "info", "exclude"), "package-lock.json\n"); // ignored: no dirty-tree refusal
  const interrupt = (before?: (out: Awaited<ReturnType<typeof baselineModule.compareToBaseline>>) => void) => {
    vi.restoreAllMocks(); // one seam per daemon run: a spy chained over another plan's spy reads that plan
    const original = baselineModule.compareToBaseline;
    vi.spyOn(baselineModule, "compareToBaseline").mockImplementation(async (...args) => (await original(...args)).map((g, _i, out) => {
      if (_i === 0) before?.(out);
      if (g.gate !== "test" || g.pass) return g;
      const now = readFileSync(join(dir, "plan"), "utf8").split("\n")[executions() - 1];
      if (now === "diag") return { ...g, details: g.details + WORKER_RPC };
      if (now === "discovery") {
        const listing = <R extends { invocationId: string }>(r: R): R => ({ ...r, invocationId: `${r.invocationId}${LISTING_INVOCATION_SUFFIX}` });
        return { ...g, details: "test manifest discovery failed: cannot list", evidenceReceipt: g.evidenceReceipt && listing(g.evidenceReceipt),
          evidenceReceipts: g.evidenceReceipts?.map(listing), meta: { ...g.meta, classification: "infra", infra: true, manifestDiscoveryFailed: true } };
      }
      if (now !== "interrupted") return g;
      const { infra: _infra, ...meta } = g.meta ?? {};
      return { ...g, meta: { ...meta, classification: "regression", failingFiles: [FILE],
        failureWindows: [{ file: FILE, from: FROM - 11_628, to: FROM + 171_947 }], interruptions: [{ ...CAPTURED_SUSPEND }] } };
    }));
  };
  /** Runs `act` on the task worktree the moment the reservation is durable — before its retry launches. */
  const onReserve = (act: (wt: string) => void) => {
    const append = Journal.prototype.append;
    vi.spyOn(Journal.prototype, "append").mockImplementation(function (this: Journal, ...args: Parameters<Journal["append"]>) {
      append.apply(this, args);
      if (args[0] !== INTERRUPTED_RETRY_EVENT) return;
      const root = join(repo, ".tickmarkr", "worktrees.noindex");
      act(join(root, readdirSync(root).find((d) => d.endsWith("--T1"))!));
    } as Journal["append"]);
  };
  /** Seeds an uninterrupted verdict in the production store under the first round's test identity. */
  const cacheSeed = () => {
    let seen: { store: VerdictStore; id: VerificationIdentity } | undefined;
    const get = VerdictStore.prototype.get;
    vi.spyOn(VerdictStore.prototype, "get").mockImplementation(function (this: VerdictStore, id) { // never the tip verify's
      if (id?.gate === "test") seen ??= { store: this, id };
      return get.call(this, id);
    });
    return (verdict: GateResult): boolean => seen !== undefined && seen.store.set(seen.id, verdict);
  };
  /** From now on the build command fails: a resume's build provisioning is red. */
  const failBuild = () => writeFileSync(join(dir, "build-fails"), "");
  /** hostStarved reads durations, so a `starved` red gets them from the sh seam, never from a wall clock: the
   * planned timeout red took 10 ms, every other test-command execution (the baseline capture included) 1 ms
   * (the tests/gates/run-gates-fingerprint.test.ts form; row 377, D-2185 add.37). Install it after `interrupt`. */
  const starvedDurations = () => {
    const sh = git.sh;
    vi.spyOn(git, "sh").mockImplementation(async (...args) => {
      const result = await sh(...args);
      if (!args[0].includes(join(dir, "run.sh"))) return result;
      return { ...result, durationMs: result.stdout.includes("Error: Test timed out in 5000ms") ? 10 : 1 };
    });
  };
  return { repo, fake, executions, setPlan, interrupt, onReserve, cacheSeed, failBuild, starvedDurations };
}

const reservations = (evs: JournalEvent[]) => of(evs, INTERRUPTED_RETRY_EVENT);
const noRepair = (evs: JournalEvent[], label: string) => {
  for (const event of ["repair-attempt", "consult-verdict", "gate-fingerprint-cap"]) expect(of(evs, event), `${label} ${event}`).toEqual([]);
};
const measured = (evs: JournalEvent[]) => testRows(evs).map((e) => e.data.disposition === "interrupted" ? "interrupted" : e.data.pass ? "green" : "red");
/** Every execution of the test command has its OWN journaled row: nothing re-ran inside a gate. */
const everyExecutionJournaled = (p: { executions: () => number }, evs: JournalEvent[], label: string) =>
  expect(p.executions(), label).toBe(testRows(evs).filter((e) => executedFullTest(e.data)).length);

describe("row 337 (D-2181 D2): one reserved test-only retry, then an infra park", () => {
  test("the bounded interruption retry CASE table parks repeated interrupted reds before a third execution", async () => {
    // ---- base row: interrupted, then interrupted again on the same subject ------------------------
    {
      const runId = "run-interrupted-twice";
      const p = planned(["interrupted", "interrupted", "red"]);
      p.interrupt();
      const s = await runDaemon(p.repo, { adapters: [p.fake], runId });
      expect(s.human).toEqual(["T1"]);
      const evs = rows(p.repo, runId);
      expect(p.executions()).toBe(2); // no third automatic test job
      const tests = testRows(evs);
      expect(tests.map((e) => e.data)).toMatchObject([
        { pass: false, disposition: "interrupted", infra: true, classification: "regression", failingFiles: [FILE], interruptions: [CAPTURED_SUSPEND] },
        { pass: false, disposition: "interrupted", infra: true, classification: "regression", failingFiles: [FILE], interruptions: [CAPTURED_SUSPEND] },
      ]);
      // the first observation is journaled, then the reservation, then the separately journaled execution
      const [reserved] = reservations(evs);
      expect(reservations(evs)).toHaveLength(1);
      expect(reserved!.data).toEqual({ commit: tests[0]!.data.commit, attempt: tests[0]!.data.attempt });
      expect(evs.indexOf(tests[0]!)).toBeLessThan(evs.indexOf(reserved!));
      expect(evs.indexOf(reserved!)).toBeLessThan(evs.indexOf(tests[1]!));
      expect(executedFullTest(tests[1]!.data)).toBe(true);
      expect(tests[1]!.data.commit).toBe(tests[0]!.data.commit);
      expect(interruptedRetryState(evs, "T1", tests[0]!.data.commit)).toMatchObject({ kind: "consumed", by: tests[1] });
      const park = of(evs, "task-human").at(-1)!;
      expect(park.data.kind).toBe("infra");
      expect(park.data.reason).toMatch(/interrupted again after the one automatic retry reserved at attempt 0 was consumed; no third automatic test job/);
      expect(String(park.data.reason).match(/host-suspend 170964ms wall \/ 170963ms monotonic/g)).toHaveLength(2);
      expect(park.data.interruptedObservations).toEqual([0, 0].map((attempt) => ({ attempt, interruptions: [{ kind: "host-suspend", wallMs: 170964, monoMs: 170963.3752500005 }] })));
      // no worker charge, consult, repair or fingerprint cap; one dispatch only
      noRepair(evs, "twice");
      expect(of(evs, "worker-launch")).toHaveLength(1);
      expect(repairSelectionDecision(evs, "T1", true)).toEqual({ selectTests: true, requiredFiles: [], reason: "no-test-failure" });
      // the cache never answered an interrupted red, so the retry executed instead of reusing it
      expect(of(evs, "gate-reused-verdict").filter((e) => e.data.gate === "test")).toEqual([]);
    }
    // ---- second execution green: the normal complete-proof/merge rules -----------------------------
    {
      const runId = "run-interrupted-then-green";
      const p = planned(["interrupted", "green"]);
      p.interrupt();
      const s = await runDaemon(p.repo, { adapters: [p.fake], runId });
      expect(s.done).toEqual(["T1"]);
      const evs = rows(p.repo, runId);
      expect(p.executions()).toBe(2);
      expect(measured(evs)).toEqual(["interrupted", "green"]);
      expect(reservations(evs)).toHaveLength(1);
      expect(of(evs, "task-human")).toEqual([]);
      noRepair(evs, "green");
    }
    // ---- second execution an uninterrupted red: the existing settlement on the new evidence ---------
    {
      const runId = "run-interrupted-then-red";
      const p = planned(["interrupted", "red", "red", "red", "red", "red"]);
      p.interrupt();
      await runDaemon(p.repo, { adapters: [p.fake], runId });
      const evs = rows(p.repo, runId);
      expect(measured(evs).slice(0, 2)).toEqual(["interrupted", "red"]);
      // no third interruption retry: one reservation, and no interrupted infra park
      expect(reservations(evs)).toHaveLength(1);
      expect(of(evs, "task-human").filter((e) => e.data.interruptedRetry !== undefined)).toEqual([]);
      expect(measured(evs).slice(2).every((d) => d !== "interrupted")).toBe(true);
      everyExecutionJournaled(p, evs, "then red");
      // the repair is funded from the RETRY's evidence alone: the interrupted red's failure never reaches it
      const prompt = readFileSync(join(p.repo, ".tickmarkr", "runs", runId, "prompts", "T1-a1.md"), "utf8");
      const repair = prompt.slice(prompt.indexOf("### Failing gate findings (verbatim)"), prompt.indexOf("### The work under review"));
      expect(repair).toContain("reads two");
      expect(repair).toContain("expected two to be three");
      expect(repair).not.toContain("reads one");
      expect(repair).not.toContain("expected one to be two");
    }
    // ---- the retry's uninterrupted red has the SAME fingerprint as the interrupted red it replaced: the
    // interrupted observation is no occurrence of it, so it is a first behavioral red — the normal repair,
    // never the fingerprint cap's escalation rung or its forced consult -----------------------------------
    for (const [first, second] of [["interrupted", "same"]] as const) {
      const runId = `run-${first}-then-${second}`;
      const p = planned([first, second, "green", "green", "green", "green"]);
      p.interrupt();
      await runDaemon(p.repo, { adapters: [p.fake], runId });
      const evs = rows(p.repo, runId);
      const [interrupted, retried] = testRows(evs);
      expect(measured(evs).slice(0, 2), second).toEqual(["interrupted", "red"]);
      expect(retried!.data.details, second).toBe(interrupted!.data.details);
      expect(reservations(evs), second).toHaveLength(1);
      expect(of(evs, "gate-fingerprint-cap"), second).toEqual([]);
      const repairLaunch = of(evs, "worker-launch")[1];
      expect(repairLaunch, second).toBeDefined(); // the retry red funded the next worker round directly
      expect(of(evs.slice(0, evs.indexOf(repairLaunch!)), "consult-verdict"), second).toEqual([]);
    }
    // ---- the reserved retry is ONE full execution: a runner-infrastructure red or a host-starved timeout
    // red inside it buys no in-gate remeasurement; it settles through the existing infra/red rules -------
    for (const second of ["infra", "starved"] as const) {
      const runId = `run-interrupted-then-${second}`;
      const p = planned(["interrupted", second, "green", "green", "green", "green"]);
      p.interrupt();
      if (second === "starved") p.starvedDurations();
      await runDaemon(p.repo, { adapters: [p.fake], runId });
      const evs = rows(p.repo, runId);
      const tests = testRows(evs);
      expect(measured(evs).slice(0, 2), second).toEqual(["interrupted", "red"]);
      expect(tests[1]!.data.runnerInfraRerun, second).toBeUndefined();
      expect(tests[1]!.data.hostStarvedRerun, second).toBeUndefined();
      expect(tests[1]!.data.recoveryBlocked, second).toEqual(expect.any(String));
      expect(reservations(evs), second).toHaveLength(1);
      everyExecutionJournaled(p, evs, second);
      if (second === "infra") {
        expect(p.executions()).toBe(2);
        expect(of(evs, "task-human").at(-1)!.data).toMatchObject({ kind: "infra" });
        expect(of(evs, "task-human").at(-1)!.data.interruptedRetry).toBeUndefined();
        noRepair(evs, second);
      }
    }
    // ---- the reserved retry ran no test: a dependency-link or dirty-entry refusal is not an executed
    // full result — the reservation stays unconsumed, the missing-result cell parks infra, no repair ----
    for (const refusal of ["dependency", "dirty-entry"] as const) {
      const runId = `run-interrupted-retry-${refusal}`;
      const p = planned(["interrupted", "red", "red"]);
      p.interrupt();
      p.onReserve((wt) => {
        if (refusal === "dirty-entry") { writeFileSync(join(wt, "litter.txt"), "left behind\n"); return; }
        mkdirSync(join(wt, "node_modules"), { recursive: true });
        symlinkSync(makeTestTempDir("interrupted-outside-"), join(wt, "node_modules", "outside"));
      });
      const s = await runDaemon(p.repo, { adapters: [p.fake], runId });
      expect(s.human, refusal).toEqual(["T1"]);
      expect(p.executions(), refusal).toBe(1);
      const evs = rows(p.repo, runId);
      const [reserved] = reservations(evs);
      const refused = testRows(evs).filter((e) => evs.indexOf(e) > evs.indexOf(reserved!));
      expect(refused, refusal).toHaveLength(1);
      expect(refused[0]!.data.pass, refusal).toBe(false);
      expect(executedFullTest(refused[0]!.data), refusal).toBe(false);
      expect(interruptedRetryState(evs, "T1", String(reserved!.data.commit)).kind, refusal).toBe("reserved");
      const park = of(evs, "task-human").at(-1)!;
      expect(park.data, refusal).toMatchObject({ kind: "infra", interruptedRetry: "reserved" });
      expect(park.data.reason, refusal).toMatch(/has no executed full test result \(missing result\); the reservation is not reset/);
      noRepair(evs, refusal);
      expect(of(evs, "worker-launch"), refusal).toHaveLength(1);
    }
    // ---- the retry's full job ran and THEN left dirt: its dirty refusal keeps the job's receipts, so it
    // executed — it consumes the reservation and settles through the existing dirty-tree rules ----------
    {
      const runId = "run-interrupted-retry-litter";
      const p = planned(["interrupted", "litter", "green", "green"]);
      p.interrupt();
      await runDaemon(p.repo, { adapters: [p.fake], runId });
      const evs = rows(p.repo, runId);
      expect(p.executions()).toBe(2);
      const [reserved] = reservations(evs);
      expect(reservations(evs)).toHaveLength(1);
      const dirty = testRows(evs).filter((e) => evs.indexOf(e) > evs.indexOf(reserved!));
      expect(dirty[0]!.data).toMatchObject({ pass: false, dirtyWorktree: true });
      expect(executedFullTest(dirty[0]!.data)).toBe(true);
      expect(interruptedRetryState(evs, "T1", String(reserved!.data.commit))).toMatchObject({ kind: "consumed", by: dirty[0] });
      const park = of(evs, "task-human").at(-1)!;
      expect(park.data.interruptedRetry).toBeUndefined();
      expect(String(park.data.reason)).not.toMatch(/missing result/);
    }
    // ---- the reserved retry is ONE execution: a timeout red with runner diagnostics on an existing
    // attributed file in a one-file suite buys no isolated re-observation — it parks infra, unrerun ----
    {
      const runId = "run-interrupted-then-diag";
      const p = planned(["interrupted", "diag", "green", "green"]);
      p.interrupt();
      const s = await runDaemon(p.repo, { adapters: [p.fake], runId });
      expect(s.human).toEqual(["T1"]);
      const evs = rows(p.repo, runId);
      expect(p.executions()).toBe(2);
      expect(measured(evs)).toEqual(["interrupted", "red"]);
      expect(of(evs, "gate-reobserved")).toEqual([]);
      expect(reservations(evs)).toHaveLength(1);
      const park = of(evs, "task-human").at(-1)!;
      expect(park.data.kind).toBe("infra");
      expect(park.data.reason).toMatch(/no isolated rerun adds another execution/);
      everyExecutionJournaled(p, evs, "diag");
      noRepair(evs, "diag");
    }
    // ---- the reserved retry is ONE execution: its green whose own command moved the verification identity
    // (an ignored lockfile) is stale proof that fails closed — no replacement full job, an infra park ------
    {
      const runId = "run-interrupted-then-stale";
      const p = planned(["interrupted", "stale", "green", "green"]);
      p.interrupt();
      const s = await runDaemon(p.repo, { adapters: [p.fake], runId });
      expect(s.human).toEqual(["T1"]);
      const evs = rows(p.repo, runId);
      expect(p.executions()).toBe(2);
      expect(measured(evs)).toEqual(["interrupted", "red"]);
      expect(testRows(evs)[1]!.data).toMatchObject({ pass: false, infra: true, details: expect.stringMatching(/^stale full proof: .* failing closed/) });
      expect(testRows(evs)[1]!.data.skipped).toBeUndefined();
      expect(reservations(evs)).toHaveLength(1);
      expect(interruptedRetryState(evs, "T1", String(testRows(evs)[0]!.data.commit))).toMatchObject({ kind: "consumed", by: testRows(evs)[1] });
      const park = of(evs, "task-human").at(-1)!;
      expect(park.data.kind).toBe("infra");
      expect(park.data.reason).toMatch(/stale full proof/);
      everyExecutionJournaled(p, evs, "stale");
      noRepair(evs, "stale");
    }
    // ---- the reserved retry is ONE fresh execution: a cached uninterrupted red never answers it ----------
    {
      const runId = "run-interrupted-retry-over-cache";
      const p = planned(["interrupted", "green"]);
      p.interrupt();
      const seed = p.cacheSeed();
      let seeded = false;
      p.onReserve(() => { seeded = seed({ gate: "test", pass: false, details: "FAIL t1.test.ts > cached", meta: { classification: "regression" } }); });
      expect((await runDaemon(p.repo, { adapters: [p.fake], runId })).done).toEqual(["T1"]);
      expect([seeded, p.executions()]).toEqual([true, 2]);
      const evs = rows(p.repo, runId);
      expect(of(evs, "gate-reused-verdict").filter((e) => e.data.gate === "test")).toEqual([]);
      expect(interruptedRetryState(evs, "T1", String(testRows(evs)[0]!.data.commit))).toMatchObject({ kind: "consumed", by: testRows(evs)[1] });
    }
    // ---- another subject: no interrupted verdict carries across; it has its own allowance and its
    // existing rules — A consumed its retry, the repair landed B, and the operator recheck of B's infra
    // park keeps the ordinary in-gate infrastructure retry with no single-execution claim -------------
    {
      const runId = "run-interrupted-other-subject-recheck";
      const p = planned(["interrupted", "red", "infra", "infra", "infra", "green"], true);
      p.interrupt();
      await runDaemon(p.repo, { adapters: [p.fake], runId });
      const [a, , b] = testRows(rows(p.repo, runId));
      expect([p.executions(), b!.data.commit !== a!.data.commit, of(rows(p.repo, runId), "task-human").at(-1)!.data.kind]).toEqual([4, true, "infra"]);
      await approve([runId, "T1", "--recheck", "--by", "op"], p.repo);
      p.interrupt();
      expect((await runDaemon(p.repo, { adapters: [p.fake], runId, resume: true })).done).toEqual(["T1"]);
      const after = afterResume(rows(p.repo, runId));
      expect([p.executions(), of(after, INTERRUPTED_RECHECK_EVENT)]).toEqual([6, []]);
      expect(testRows(after).map((e) => [e.data.commit, e.data.pass, e.data.runnerInfraRerun !== undefined])).toEqual([[b!.data.commit, true, true]]);
      const reservation = { event: INTERRUPTED_RETRY_EVENT, taskId: "T1", data: { commit: "a".repeat(64), attempt: 0 } };
      expect(interruptedRetryState([reservation], "T1", "b".repeat(64))).toEqual({ kind: "unreserved" });
      expect(interruptedRetryState([reservation], "T2", "a".repeat(64))).toEqual({ kind: "unreserved" });
      expect(interruptedRetryState([reservation], "T1", "a".repeat(64))).toEqual({ kind: "reserved", attempt: 0 });
    }
  }, 300_000);

  test("interruption retry accounting survives restart consumes executed full results parks missing or malformed accounting infra executes an operator recheck once without refilling the automatic allowance and funds no behavioral repair from interrupted rows", async () => {
    const runId = "run-interrupted-accounting";
    const p = planned(["interrupted", "interrupted", "interrupted", "infra", "green"]);
    p.interrupt();
    await runDaemon(p.repo, { adapters: [p.fake], runId });
    vi.restoreAllMocks();
    expect(p.executions()).toBe(2);
    const subject = String(testRows(rows(p.repo, runId))[0]!.data.commit);

    // ---- restart: a plain resume re-buys nothing and the consumed allowance stays spent ------------
    p.interrupt();
    await runDaemon(p.repo, { adapters: [p.fake], runId, resume: true });
    vi.restoreAllMocks();
    expect(p.executions()).toBe(2);
    expect(reservations(rows(p.repo, runId))).toHaveLength(1);
    expect(interruptedRetryState(rows(p.repo, runId), "T1", subject).kind).toBe("consumed");

    // ---- operator recheck: exactly one fresh full job, neither drawn from nor refilling the reservation;
    // its interrupted red parks infra again with every observation's measurements ---------------------
    await approve([runId, "T1", "--recheck", "--by", "op"], p.repo);
    p.interrupt();
    await runDaemon(p.repo, { adapters: [p.fake], runId, resume: true });
    vi.restoreAllMocks();
    expect(p.executions()).toBe(3);
    let evs = rows(p.repo, runId);
    expect(reservations(evs)).toHaveLength(1);
    const repark = of(evs, "task-human").at(-1)!;
    expect(repark.data.kind).toBe("infra");
    expect(String(repark.data.reason).match(/host-suspend 170964ms wall \/ 170963ms monotonic/g)).toHaveLength(3);
    expect(repark.data.interruptedObservations).toHaveLength(3);
    noRepair(afterResume(evs), "recheck");
    expect(of(afterResume(evs), "task-dispatch")).toEqual([]);
    // interrupted rows fund no behavioral repair and require no repair test
    expect(repairSelectionDecision(evs, "T1", true)).toEqual({ selectTests: true, requiredFiles: [], reason: "no-test-failure" });

    // ---- a second recheck is ONE execution too: its uninterrupted runner-infra red buys no in-gate
    // remeasurement and settles through the existing infra park ---------------------------------------
    await approve([runId, "T1", "--recheck", "--by", "op"], p.repo);
    p.interrupt();
    await runDaemon(p.repo, { adapters: [p.fake], runId, resume: true });
    vi.restoreAllMocks();
    expect(p.executions()).toBe(4);
    evs = rows(p.repo, runId);
    expect(testRows(evs).at(-1)!.data).toMatchObject({ pass: false, recoveryBlocked: expect.any(String) });
    expect(testRows(evs).at(-1)!.data.runnerInfraRerun).toBeUndefined();
    expect(of(evs, "task-human").at(-1)!.data.kind).toBe("infra");
    everyExecutionJournaled(p, evs, "infra recheck");

    // ---- a third recheck executes once more; its green settles normally ----------------------------
    await approve([runId, "T1", "--recheck", "--by", "op"], p.repo);
    p.interrupt();
    const merged = await runDaemon(p.repo, { adapters: [p.fake], runId, resume: true });
    vi.restoreAllMocks();
    expect(merged.done).toEqual(["T1"]);
    expect(p.executions()).toBe(5);
    evs = rows(p.repo, runId);
    expect(measured(evs)).toEqual(["interrupted", "interrupted", "interrupted", "red", "green"]);
    expect(reservations(evs)).toHaveLength(1);
    everyExecutionJournaled(p, evs, "green recheck");
    noRepair(evs, "rechecks");

    // ---- missing result: a crash before or inside the reserved execution, or after its interrupted red
    // but before its park, leaves a reservation the resume never resets — an infra park, no execution.
    // A crash after the first interrupted red but BEFORE its reservation reserves on resume first, so
    // the resume's re-measurement is the sole retry; its interrupted red parks with no third execution --
    for (const cut of ["before-reservation", "after-reservation", "inside-retry", "before-park"] as const) {
      const crashId = `run-interrupted-crash-${cut}`;
      const c = planned(["interrupted", "interrupted", "interrupted", "green"]);
      c.interrupt();
      await runDaemon(c.repo, { adapters: [c.fake], runId: crashId });
      vi.restoreAllMocks();
      const file = join(Journal.open(c.repo, crashId).dir, "journal.jsonl");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      const parsed = lines.map((line) => JSON.parse(line) as JournalEvent);
      const reservedAt = parsed.findIndex((e) => e.event === INTERRUPTED_RETRY_EVENT);
      const keep = cut === "before-reservation" ? reservedAt : cut === "after-reservation" ? reservedAt + 1
        : cut === "inside-retry" ? parsed.findIndex((e, i) => i > reservedAt && e.event === "phase-start" && e.data.phase === "gates") + 1
        : parsed.findIndex((e) => e.event === "task-human" && e.taskId === "T1");
      expect(keep, cut).toBeGreaterThanOrEqual(reservedAt);
      writeFileSync(file, `${lines.slice(0, keep).join("\n")}\n`);
      const before = c.executions();
      c.interrupt();
      const resumed = await runDaemon(c.repo, { adapters: [c.fake], runId: crashId, resume: true });
      vi.restoreAllMocks();
      expect(resumed.human, cut).toEqual(["T1"]);
      const after = rows(c.repo, crashId);
      const park = of(afterResume(after), "task-human").at(-1)!;
      expect(park.data.kind, cut).toBe("infra");
      expect(reservations(after), cut).toHaveLength(1);
      noRepair(afterResume(after), cut);
      if (cut === "before-reservation") {
        expect(c.executions(), cut).toBe(before + 1);
        const [reserved] = reservations(afterResume(after));
        const [retest, ...more] = testRows(afterResume(after));
        expect(more, cut).toEqual([]);
        expect(after.indexOf(reserved!), cut).toBeLessThan(after.indexOf(retest!));
        // test-only: no semantic or tool gate runs ahead of (or instead of) the reserved test; the round's
        // already-green gates on this subject are reused, the judge is not asked again
        expect(of(afterResume(after), "gate-result").map((e) => e.data.gate), cut).toEqual(["test"]);
        expect(of(afterResume(after), "gate-reused").map((e) => e.data.gate).sort(), cut).toEqual(["acceptance", "build", "evidence", "lint", "scope"]);
        expect(of(afterResume(after), "phase-start").filter((e) => e.data.phase === "judge"), cut).toEqual([]);
        expect(reserved!.data, cut).toEqual({ commit: retest!.data.commit, attempt: 0 });
        expect(executedFullTest(retest!.data), cut).toBe(true);
        expect(retest!.data.disposition, cut).toBe("interrupted");
        expect(park.data.interruptedRetry, cut).toBe("consumed");
        expect(park.data.reason, cut).toMatch(/interrupted again after the one automatic retry reserved at attempt 0 was consumed; no third automatic test job/);
        continue;
      }
      expect(c.executions(), cut).toBe(before);
      expect(park.data.interruptedRetry, cut).toBe(cut === "before-park" ? "consumed" : "reserved");
      if (cut !== "before-park") expect(park.data.reason, cut).toMatch(/has no executed full test result \(missing result\); the reservation is not reset/);
      expect(of(afterResume(after), "gate-result"), cut).toEqual([]);
    }

    // ---- that before-reservation resume's retry is a FRESH execution, never a replay measurement: its
    // uninterrupted red identical to the interrupted one counts, so the repair's next independent
    // identical red (on a new subject) crosses the fingerprint cap ----------------------------------
    {
      const crashId = "run-interrupted-crash-before-reservation-same";
      const c = planned(["interrupted", "interrupted"], true);
      c.interrupt();
      await runDaemon(c.repo, { adapters: [c.fake], runId: crashId });
      vi.restoreAllMocks();
      c.setPlan(["interrupted", "interrupted", "same", "same", "green"]);
      const file = join(Journal.open(c.repo, crashId).dir, "journal.jsonl");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      writeFileSync(file, `${lines.slice(0, lines.findIndex((l) => (JSON.parse(l) as JournalEvent).event === INTERRUPTED_RETRY_EVENT)).join("\n")}\n`);
      c.interrupt();
      await runDaemon(c.repo, { adapters: [c.fake], runId: crashId, resume: true });
      vi.restoreAllMocks();
      const after = afterResume(rows(c.repo, crashId));
      const [retry, next] = testRows(after);
      expect(after.indexOf(reservations(after)[0]!)).toBeLessThan(after.indexOf(retry!));
      expect([retry!.data.disposition, retry!.data.replayMeasurement, next!.data.details]).toEqual(["behavioral", undefined, retry!.data.details]);
      expect(next!.data.commit).not.toBe(retry!.data.commit);
      expect(after.indexOf(of(after, "gate-fingerprint-cap")[0]!)).toBeGreaterThan(after.indexOf(next!));
    }

    // ---- a crash after the reserved retry's EXECUTED uninterrupted red but before its settlement: the
    // allowance is spent, so the resume settles that persisted result — no battery, no in-gate retry,
    // no isolated re-observation, no new reservation. Infra and runner-diagnostic reds park infra; a
    // behavioral red funds the existing repair from the retry's evidence before any further execution --
    for (const second of ["infra", "diag", "red", "same"] as const) {
      const crashId = `run-interrupted-crash-after-consumed-${second}`;
      const c = planned(["interrupted", second, "green", "green", "green", "green"]);
      c.interrupt();
      await runDaemon(c.repo, { adapters: [c.fake], runId: crashId });
      vi.restoreAllMocks();
      expect(c.executions(), second).toBe(2);
      const file = join(Journal.open(c.repo, crashId).dir, "journal.jsonl");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      const parsed = lines.map((line) => JSON.parse(line) as JournalEvent);
      const reservedAt = parsed.findIndex((e) => e.event === INTERRUPTED_RETRY_EVENT);
      const consumedAt = parsed.findIndex((e, i) => i > reservedAt && e.event === "gate-result" && e.taskId === "T1" && executedFullTest(e.data));
      expect(parsed[consumedAt]!.data.disposition, second).not.toBe("interrupted");
      writeFileSync(file, `${lines.slice(0, consumedAt + 1).join("\n")}\n`);
      const subject = String(parsed[consumedAt]!.data.commit);
      expect(interruptedRetryState(rows(c.repo, crashId), "T1", subject).kind, second).toBe("consumed");
      c.interrupt();
      await runDaemon(c.repo, { adapters: [c.fake], runId: crashId, resume: true });
      vi.restoreAllMocks();
      const after = afterResume(rows(c.repo, crashId));
      expect(reservations(rows(c.repo, crashId)), second).toHaveLength(1);
      expect(of(after, "gate-reobserved"), second).toEqual([]);
      if (second !== "red" && second !== "same") {
        expect(c.executions(), second).toBe(2); // the persisted result settled; nothing re-ran
        expect(of(after, "gate-result"), second).toEqual([]);
        const park = of(after, "task-human").at(-1)!;
        expect(park.data.kind, second).toBe("infra");
        expect(park.data.interruptedRetry, second).toBeUndefined();
        if (second === "diag") expect(park.data.reason).toMatch(/no isolated rerun adds another execution/);
        noRepair(after, second);
        continue;
      }
      // behavioral — its fingerprint the interrupted red's own ("same") included, since an interrupted
      // observation never arms the repeated-failure guard: the repair is funded from the persisted retry red with no battery ahead of it — no
      // gate (the judge included) is measured, reused or replayed again on the consumed subject first
      expect(c.executions(), second).toBe(2);
      const [repair] = of(after, "repair-attempt");
      expect(repair?.data.gates, second).toEqual(["test"]);
      const launch = of(after, "worker-launch")[0];
      expect(launch, second).toBeDefined();
      const ahead = after.slice(0, after.indexOf(launch!));
      expect(ahead.indexOf(repair!), second).toBeGreaterThanOrEqual(0);
      for (const event of ["gate-result", "gate-reused-verdict"]) expect(of(ahead, event), `${second} ${event}`).toEqual([]);
      expect(of(after, "task-human").filter((e) => e.data.interruptedRetry !== undefined), second).toEqual([]);
    }

    // ---- an operator recheck of an interrupted subject is ONE execution too: its timeout red with runner
    // diagnostics buys no isolated re-observation of the attributed file, and its green whose own command
    // moved the verification identity is stale proof that fails closed, buying no replacement full job ---
    for (const third of ["diag", "stale"] as const) {
      const recheckId = `run-interrupted-recheck-${third}`;
      const r = planned(["interrupted", "interrupted", third, "green"]);
      r.interrupt();
      await runDaemon(r.repo, { adapters: [r.fake], runId: recheckId });
      vi.restoreAllMocks();
      expect(r.executions(), third).toBe(2);
      await approve([recheckId, "T1", "--recheck", "--by", "op"], r.repo);
      r.interrupt();
      await runDaemon(r.repo, { adapters: [r.fake], runId: recheckId, resume: true });
      vi.restoreAllMocks();
      expect(r.executions(), third).toBe(3);
      const all = rows(r.repo, recheckId);
      expect(of(all, "gate-reobserved"), third).toEqual([]);
      const park = of(afterResume(all), "task-human").at(-1)!;
      expect(park.data.kind, third).toBe("infra");
      if (third === "diag") expect(park.data.reason).toMatch(/no isolated rerun adds another execution/);
      else {
        expect(testRows(afterResume(all)).map((e) => e.data), third).toMatchObject([{ pass: false, infra: true, details: expect.stringMatching(/^stale full proof: .* failing closed/) }]);
        expect(park.data.reason).toMatch(/stale full proof/);
      }
      expect(reservations(all), third).toHaveLength(1);
      everyExecutionJournaled(r, all, `recheck ${third}`);
      noRepair(afterResume(all), `recheck ${third}`);
    }

    // ---- an interrupted subject's operator recheck is ONE fresh test execution: a cached uninterrupted
    // (exit-receipted) green never answers it, while lint keeps its existing reuse ----------------------
    {
      const recheckId = "run-interrupted-recheck-over-cache";
      const r = planned(["interrupted", "interrupted", "interrupted", "green"]);
      r.interrupt();
      const seed = r.cacheSeed();
      await runDaemon(r.repo, { adapters: [r.fake], runId: recheckId });
      expect(seed({ gate: "test", pass: true, details: "cached green", evidenceReceipt: { invocationId: "cached",
        termination: { kind: "exit", exitCode: 0, signal: null, timedOut: false } } as GateResult["evidenceReceipt"] })).toBe(true);
      await approve([recheckId, "T1", "--recheck", "--by", "op"], r.repo);
      r.interrupt();
      await runDaemon(r.repo, { adapters: [r.fake], runId: recheckId, resume: true });
      vi.restoreAllMocks();
      const after = afterResume(rows(r.repo, recheckId));
      expect([r.executions(), of(after, "gate-reused-verdict").map((e) => e.data.gate)]).toEqual([3, ["lint"]]);
      expect(testRows(after).map((e) => [executedFullTest(e.data), e.data.disposition])).toEqual([[true, "interrupted"]]);
      expect([of(after, "task-human").at(-1)!.data.kind, of(after, "task-done")]).toEqual(["infra", []]);
    }
    // ---- a crash after an interrupted subject's operator recheck journaled its executed full result but
    // before its recheck-battery enactment: the restart settles THAT persisted round — no second battery
    // under the one approval, no worker charge and no automatic reservation. Its infra or interrupted red
    // parks infra; its green settles normally --------------------------------------------------------
    for (const third of ["infra", "interrupted", "green"] as const) {
      const recheckId = `run-interrupted-recheck-crash-${third}`;
      const r = planned(["interrupted", "interrupted", third, "green", "green"]);
      r.interrupt();
      await runDaemon(r.repo, { adapters: [r.fake], runId: recheckId });
      vi.restoreAllMocks();
      await approve([recheckId, "T1", "--recheck", "--by", "op"], r.repo);
      // the crash lands before any merge: the integration branch still holds the tip published before it
      const tip = execFileSync("git", ["rev-parse", `tickmarkr/${recheckId}`], { cwd: r.repo, encoding: "utf8" }).trim();
      r.interrupt();
      await runDaemon(r.repo, { adapters: [r.fake], runId: recheckId, resume: true });
      vi.restoreAllMocks();
      expect(r.executions(), third).toBe(3);
      const file = join(Journal.open(r.repo, recheckId).dir, "journal.jsonl");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      const parsed = lines.map((line) => JSON.parse(line) as JournalEvent);
      const approvedAt = parsed.findIndex((e) => e.event === "task-approved" && e.taskId === "T1");
      const enactedAt = parsed.findIndex((e) => e.event === "recheck-battery" && e.taskId === "T1");
      const ranAt = parsed.map((e, i) => i < enactedAt && e.event === "gate-result" && e.taskId === "T1" && executedFullTest(e.data)).lastIndexOf(true);
      expect(ranAt, third).toBeGreaterThan(approvedAt);
      writeFileSync(file, `${lines.slice(0, ranAt + 1).join("\n")}\n`);
      execFileSync("git", ["update-ref", `refs/heads/tickmarkr/${recheckId}`, tip], { cwd: r.repo });
      r.interrupt();
      const resumed = await runDaemon(r.repo, { adapters: [r.fake], runId: recheckId, resume: true });
      vi.restoreAllMocks();
      expect(r.executions(), third).toBe(3); // the persisted recheck result settled; nothing re-ran
      const all = rows(r.repo, recheckId);
      const after = afterResume(all);
      expect(of(after, "gate-result"), third).toEqual([]);
      expect(of(after, "recheck-battery"), third).toHaveLength(1);
      expect(reservations(all), third).toHaveLength(1);
      noRepair(after, third);
      expect(of(after, "worker-launch"), third).toEqual([]);
      if (third === "green") {
        expect(resumed.done, third).toEqual(["T1"]);
        continue;
      }
      expect(resumed.human, third).toEqual(["T1"]);
      const park = of(after, "task-human").at(-1)!;
      expect(park.data.kind, third).toBe("infra");
      if (third === "interrupted") {
        expect(park.data.interruptedRetry, third).toBe("consumed");
        expect(park.data.interruptedObservations, third).toHaveLength(3);
      }
    }
    // ---- the operator recheck's one execution is CLAIMED durably before it launches. On a legacy
    // interrupted infra park with NO automatic reservation: a crash after the claim, or after its launch but
    // before its full result persisted, parks infra as a missing result and executes nothing; a crash after
    // its recheck-battery enactment settles the persisted result (infra parks, green merges) — no second
    // battery, nested infra retry, worker charge, second claim or automatic reservation under one approval.
    // A torn or unattributable row where the claim would be is unprovable accounting, never "no claim" ----
    // A persisted green recheck round is restored only as comparable proof: a resume under another capacity,
    // or one whose build provisioning fails, parks infra — the consumed execution is never re-bought ------
    // A claim naming no readable subject ({}, "", 42) is unattributable, never another subject's; a surviving
    // claim involves its subject even when the interrupted history is torn, as does one naming no attributable
    // owner (absent or numeric taskId) beside that torn history; and an open claim restores its round only
    // from a journal that reads whole: each parks infra as unprovable, executing nothing --------------------
    // Nor over a strict ledger that refuses: a historical interrupted observation naming no readable subject
    // (commit 42), or a malformed reservation ({ commit: 42 }), keeps a persisted green from merging ---------
    // Nor one whose persisted result contradicts itself: pass true beside an interrupted disposition, no infra
    // flag — the disposition outranks the pass, so it parks infra as the interrupted operator run it was -----
    // Nor a FRESH approval over a malformed reservation, before any claim exists: every unprovable cell parks at
    // the task boundary, before claim lookup, executing nothing ---------------------------------------------
    for (const cut of ["after-claim", "after-launch", "after-enactment-infra", "after-enactment-green", "after-enactment-green-capacity",
      "after-enactment-green-provisioning", "torn-claim", "unowned-claim", "empty-claim", "blank-claim", "numeric-claim",
      "torn-history-claim", "after-enactment-green-torn-claim", "torn-history-unowned-claim", "after-enactment-infra-torn-history-numeric-claim",
      "after-enactment-infra-torn-history-torn-claim", "after-enactment-green-subjectless-history", "after-enactment-green-malformed-reservation",
      "after-enactment-green-interrupted-pass", "approved-malformed-reservation"] as const) {
      const legacyId = `run-interrupted-legacy-recheck-${cut}`;
      const r = planned(["infra", "infra", "infra"]);
      await runDaemon(r.repo, { adapters: [r.fake], runId: legacyId });
      const first = r.executions();
      r.setPlan([...Array<Outcome>(first).fill("infra"), cut.startsWith("after-enactment-green") ? "green" : "infra", "green", "green"]);
      const file = join(Journal.open(r.repo, legacyId).dir, "journal.jsonl");
      const history = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as JournalEvent);
      for (const e of testRows(history)) if (e.data.pass === false) Object.assign(e.data, { disposition: "interrupted", classification: "regression",
        infra: true, interruptions: [{ ...CAPTURED_SUSPEND }], failingFiles: [FILE], failureWindows: [{ file: FILE, from: FROM - 1, to: FROM + 1 }] });
      writeFileSync(file, `${history.map((e) => JSON.stringify(e)).join("\n")}\n`);
      expect(reservations(history), cut).toEqual([]);
      await approve([legacyId, "T1", "--recheck", "--by", "op"], r.repo);
      const tip = execFileSync("git", ["rev-parse", `tickmarkr/${legacyId}`], { cwd: r.repo, encoding: "utf8" }).trim();
      await runDaemon(r.repo, { adapters: [r.fake], runId: legacyId, resume: true });
      expect(r.executions(), cut).toBe(first + 1);
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      const parsed = lines.map((line) => JSON.parse(line) as JournalEvent);
      const approvedAt = parsed.findIndex((e) => e.event === "task-approved" && e.taskId === "T1");
      const claimedAt = parsed.findIndex((e, i) => i > approvedAt && e.event === INTERRUPTED_RECHECK_EVENT && e.taskId === "T1");
      const testAt = parsed.findIndex((e, i) => i > approvedAt && e.event === "gate-result" && e.data.gate === "test");
      const enactedAt = parsed.findIndex((e, i) => i > approvedAt && e.event === "recheck-battery" && e.taskId === "T1");
      // the claim names the subject and precedes the recheck's execution and its enactment
      expect(approvedAt, cut).toBeLessThan(claimedAt);
      expect(claimedAt, cut).toBeLessThan(testAt);
      expect(testAt, cut).toBeLessThan(enactedAt);
      expect(parsed[claimedAt]!.data, cut).toEqual({ commit: parsed[testAt]!.data.commit });
      expect(executedFullTest(parsed[testAt]!.data), cut).toBe(true);
      const kept = lines.slice(0, cut === "after-launch" ? testAt : cut.startsWith("after-enactment") ? enactedAt + 1 : cut.startsWith("approved") ? claimedAt : claimedAt + 1);
      const { taskId: _taskId, ...unowned } = parsed[claimedAt]!;
      if (cut === "torn-claim" || cut === "after-enactment-infra-torn-history-torn-claim") kept[claimedAt] = kept[claimedAt]!.slice(0, 40);
      const owners = { "unowned-claim": unowned, "torn-history-unowned-claim": unowned,
        "after-enactment-infra-torn-history-numeric-claim": { ...unowned, taskId: 42 } } as Record<string, object>;
      if (owners[cut]) kept[claimedAt] = JSON.stringify(owners[cut]);
      const subjectless = { "empty-claim": {}, "blank-claim": { commit: "" }, "numeric-claim": { commit: 42 } } as Record<string, object>;
      if (subjectless[cut]) kept[claimedAt] = JSON.stringify({ ...parsed[claimedAt], data: subjectless[cut] });
      if (cut.includes("torn-history")) parsed.forEach((e, i) => { if (i < approvedAt && testRows([e]).length && e.data.pass === false) kept[i] = kept[i]!.slice(0, 40); });
      if (cut === "after-enactment-green-torn-claim") kept.splice(claimedAt + 1, 0, kept[claimedAt]!.slice(0, 40));
      if (cut === "after-enactment-green-subjectless-history") parsed.forEach((e, i) => {
        if (i < approvedAt && testRows([e]).length && e.data.pass === false) kept[i] = JSON.stringify({ ...e, data: { ...e.data, commit: 42 } });
      });
      if (cut === "after-enactment-green-interrupted-pass") {
        const { infra: _infra, ...green } = parsed[testAt]!.data;
        kept[testAt] = JSON.stringify({ ...parsed[testAt], data: { ...green, pass: true, disposition: "interrupted" } });
      }
      if (cut.endsWith("malformed-reservation")) {
        kept.splice(claimedAt, 0, JSON.stringify({ event: INTERRUPTED_RETRY_EVENT, ts: parsed[claimedAt]!.ts, taskId: "T1", data: { commit: 42 } }));
      }
      writeFileSync(file, `${kept.join("\n")}\n`);
      execFileSync("git", ["update-ref", `refs/heads/tickmarkr/${legacyId}`, tip], { cwd: r.repo });
      if (cut === "after-enactment-green-provisioning") r.failBuild();
      const forks = process.env.VITEST_MAX_FORKS;
      const recorded = (parsed[testAt]!.data.capacity as { forkCap?: number } | undefined)?.forkCap;
      if (cut === "after-enactment-green-capacity") {
        expect(recorded, cut).toEqual(expect.any(Number));
        process.env.VITEST_MAX_FORKS = String(recorded! + 1);
      }
      const resumed = await runDaemon(r.repo, { adapters: [r.fake], runId: legacyId, resume: true })
        .finally(() => { if (forks === undefined) delete process.env.VITEST_MAX_FORKS; else process.env.VITEST_MAX_FORKS = forks; });
      expect(r.executions(), cut).toBe(first + 1); // one approval, one execution — nothing re-ran
      const all = rows(r.repo, legacyId);
      const after = afterResume(all);
      expect(of(after, "gate-result"), cut).toEqual([]);
      expect(of(after, INTERRUPTED_RECHECK_EVENT), cut).toEqual([]);
      expect(of(after, "recheck-battery"), cut).toHaveLength(cut === "after-claim" || cut === "after-launch" ? 1 : 0);
      expect(reservations(all), cut).toHaveLength(cut.endsWith("malformed-reservation") ? 1 : 0); // never reset or refilled
      noRepair(after, cut);
      expect(of(after, "worker-launch"), cut).toEqual([]);
      if (cut === "after-enactment-green") {
        expect(resumed.done, cut).toEqual(["T1"]);
        continue;
      }
      expect(resumed.human, cut).toEqual(["T1"]);
      const park = of(after, "task-human").at(-1)!;
      expect(park.data.kind, cut).toBe("infra");
      expect([of(after, "task-done"), of(after, "merge")], cut).toEqual([[], []]);
      expect(park.data.reason, cut).toMatch(cut === "after-enactment-infra" ? /^test: infra; /
        : cut === "after-enactment-green-capacity" ? /^test: the operator recheck's persisted result was measured under another capacity or verification protocol than this session's; its one execution is consumed/
        : cut === "after-enactment-green-provisioning" ? /^test: the operator recheck's persisted result cannot stand: this session's build provisioning failed; its one execution is consumed/
        : cut === "after-enactment-green-interrupted-pass" ? /^test: interrupted, inconclusive infrastructure and not a worker defect: the operator-funded fresh full test job was interrupted/
        : cut !== "after-claim" && /claim|history|reservation/.test(cut)
        ? new RegExp(`^test: interrupted, inconclusive infrastructure and not a worker defect: interruption retry accounting is unprovable \\(${cut.includes("torn")
          ? "\\d+ unreadable journal line" : cut.endsWith("history") ? "an interrupted test observation names no readable subject"
          : cut.endsWith("reservation") ? "malformed interruption retry reservation" : "malformed journal row or task identity"}`)
        : /^test: the operator recheck claimed its one execution on this subject before the restart, but no executed full test result was journaled after it \(missing result\); no second execution runs under one recheck/);
    }
    // ---- a FRESH operator recheck of an interrupted subject whose round executed no full test after its claim
    // — no test command configured (a skipped green with no receipt) or a manifest discovery refusal (listing
    // receipts only) — is the missing-result cell: an infra park, never a green merge or a worker charge ----
    for (const missing of ["no test command", "discovery"] as const) {
      const id = `run-interrupted-recheck-unexecuted-${missing.replace(/ /g, "-")}`;
      const r = planned(["infra", "infra", "infra"]);
      await runDaemon(r.repo, { adapters: [r.fake], runId: id });
      const first = r.executions();
      r.setPlan([...Array<Outcome>(first).fill("infra"), "discovery", "green"]);
      const file = join(Journal.open(r.repo, id).dir, "journal.jsonl");
      const history = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as JournalEvent);
      for (const e of testRows(history)) if (e.data.pass === false) Object.assign(e.data, { disposition: "interrupted", classification: "regression",
        infra: true, interruptions: [{ ...CAPTURED_SUSPEND }], failingFiles: [FILE], failureWindows: [{ file: FILE, from: FROM - 1, to: FROM + 1 }] });
      writeFileSync(file, `${history.map((e) => JSON.stringify(e)).join("\n")}\n`);
      await approve([id, "T1", "--recheck", "--by", "op"], r.repo);
      if (missing === "no test command") {
        const cfg = join(r.repo, ".tickmarkr", "config.yaml");
        const doc = parse(readFileSync(cfg, "utf8")) as { gates: Record<string, string> };
        writeFileSync(cfg, stringify({ ...doc, gates: { ...doc.gates, test: "" } }));
      } else r.interrupt();
      const resumed = await runDaemon(r.repo, { adapters: [r.fake], runId: id, resume: true });
      vi.restoreAllMocks();
      expect(r.executions(), missing).toBe(first + (missing === "discovery" ? 1 : 0));
      const after = afterResume(rows(r.repo, id));
      const [claimed] = of(after, INTERRUPTED_RECHECK_EVENT);
      expect(claimed, missing).toBeDefined();
      expect(testRows(after).filter((e) => after.indexOf(e) > after.indexOf(claimed!) && executedFullTest(e.data)), missing).toEqual([]);
      expect([resumed.human, resumed.done, of(after, "task-done"), of(after, "merge"), of(after, "worker-launch"), reservations(after)], missing)
        .toEqual([["T1"], [], [], [], [], []]);
      expect(of(after, "recheck-battery").map((e) => e.data.pass), missing).toEqual([false]);
      expect(of(after, "task-human").at(-1)!.data, missing).toMatchObject({ kind: "infra",
        reason: expect.stringMatching(/^test: the operator recheck claimed its one execution on this subject, but no executed full test result was journaled after it \(missing result\)/) });
      noRepair(after, missing);
    }
    // ---- a before-reservation crash whose resumed (now reserved) re-measurement is a refusal that ran no
    // test — a dirty entry or a manifest discovery failure — keeps the missing-result cell: infra park ----
    for (const refusal of ["dirty-entry", "discovery"] as const) {
      const crashId = `run-interrupted-crash-before-reservation-${refusal}`;
      const c = planned(["interrupted", "interrupted", refusal === "discovery" ? "discovery" : "green", "green"]);
      c.interrupt();
      await runDaemon(c.repo, { adapters: [c.fake], runId: crashId });
      vi.restoreAllMocks();
      const file = join(Journal.open(c.repo, crashId).dir, "journal.jsonl");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      writeFileSync(file, `${lines.slice(0, lines.findIndex((l) => (JSON.parse(l) as JournalEvent).event === INTERRUPTED_RETRY_EVENT)).join("\n")}\n`);
      const before = c.executions();
      c.interrupt();
      if (refusal === "dirty-entry") c.onReserve((wt) => { writeFileSync(join(wt, "litter.txt"), "left behind\n"); });
      const resumed = await runDaemon(c.repo, { adapters: [c.fake], runId: crashId, resume: true });
      vi.restoreAllMocks();
      expect(resumed.human, refusal).toEqual(["T1"]);
      expect(c.executions(), refusal).toBe(before + (refusal === "discovery" ? 1 : 0));
      const after = afterResume(rows(c.repo, crashId));
      const [reserved] = reservations(after);
      expect(reserved, refusal).toBeDefined();
      const refused = of(after, "gate-result").filter((e) => e.data.pass === false);
      expect(refused.length, refusal).toBeGreaterThan(0);
      expect(after.indexOf(reserved!), refusal).toBeLessThan(after.indexOf(refused[0]!));
      expect(refused.some((e) => refusal === "dirty-entry" ? e.data.dirtyWorktree === true
        : e.data.gate === "test" && String(e.data.details).includes("discovery failed")), refusal).toBe(true);
      expect(testRows(after).filter((e) => executedFullTest(e.data)), refusal).toEqual([]);
      const park = of(after, "task-human").at(-1)!;
      expect(park.data, refusal).toMatchObject({ kind: "infra", interruptedRetry: "reserved" });
      expect(park.data.reason, refusal).toMatch(/has no executed full test result \(missing result\); the reservation is not reset/);
      noRepair(after, refusal);
      expect(of(after, "worker-launch"), refusal).toEqual([]);
    }
    // ---- an interrupted test observation naming no readable subject (absent, blank or numeric commit) —
    // an earlier copy before a valid row, or the LATEST row itself, so replay finds no candidate — is
    // unprovable accounting before any subject filter or candidate: the restart parks infra at the task
    // boundary and executes nothing, dispatching no worker ------------------------------------------------
    for (const [shape, commit] of [["absent", undefined], ["blank", ""], ["numeric", 42]] as const) for (const latest of [false, true]) {
      const id = `run-interrupted-${shape}-${latest ? "latest" : "earlier"}-observation-subject`;
      const c = planned(["interrupted", "interrupted", "green", "green"]);
      c.interrupt();
      await runDaemon(c.repo, { adapters: [c.fake], runId: id });
      vi.restoreAllMocks();
      const file = join(Journal.open(c.repo, id).dir, "journal.jsonl");
      const parsed = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as JournalEvent);
      const kept = parsed.slice(0, parsed.findIndex((e) => e.event === INTERRUPTED_RETRY_EVENT));
      const [observed] = testRows(kept);
      expect(observed!.data.disposition, shape).toBe("interrupted");
      const { commit: _subject, ...data } = observed!.data;
      const corrupt = { ...observed!, data: commit === undefined ? data : { ...data, commit } };
      if (latest) kept[kept.indexOf(observed!)] = corrupt; else kept.splice(kept.findIndex((e) => e.event === "gate-result"), 0, corrupt);
      writeFileSync(file, `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`);
      const before = c.executions();
      c.interrupt();
      const resumed = await runDaemon(c.repo, { adapters: [c.fake], runId: id, resume: true });
      vi.restoreAllMocks();
      expect([resumed.human, c.executions()], shape).toEqual([["T1"], before]);
      const after = afterResume(rows(c.repo, id));
      expect([of(after, "gate-result"), reservations(after), of(after, "worker-launch"), of(after, "task-done"), of(after, "merge")], shape).toEqual([[], [], [], [], []]);
      expect(of(after, "task-human").at(-1)!.data, shape).toMatchObject({ kind: "infra", interruptedRetry: "unprovable",
        reason: expect.stringMatching(/interruption retry accounting is unprovable \(an interrupted test observation names no readable subject\)/) });
      noRepair(after, shape);
    }
    // ---- the subject's latest test row is interrupted but never executed (skipped, pass false, no infra flag)
    // and nothing is reserved: the replay fold reads skipped as satisfied, but the interrupted row decides
    // first — an infra park as live, no execution, no reservation and no merge -----------------------------
    {
      const id = "run-interrupted-skipped-observation";
      const c = planned(["interrupted", "interrupted", "green", "green"]);
      c.interrupt();
      await runDaemon(c.repo, { adapters: [c.fake], runId: id });
      vi.restoreAllMocks();
      const file = join(Journal.open(c.repo, id).dir, "journal.jsonl");
      const parsed = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as JournalEvent);
      const kept = parsed.slice(0, parsed.findIndex((e) => e.event === INTERRUPTED_RETRY_EVENT));
      const observed = testRows(kept).at(-1)!;
      const { infra: _infra, ...data } = observed.data;
      kept[kept.indexOf(observed)] = { ...observed, data: { ...data, pass: false, skipped: true, disposition: "interrupted" } };
      writeFileSync(file, `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`);
      const before = c.executions();
      c.interrupt();
      const resumed = await runDaemon(c.repo, { adapters: [c.fake], runId: id, resume: true });
      vi.restoreAllMocks();
      expect([resumed.human, resumed.done, c.executions()]).toEqual([["T1"], [], before]);
      const after = afterResume(rows(c.repo, id));
      expect([of(after, "gate-result"), reservations(after), of(after, "task-done")]).toEqual([[], [], []]);
      expect(of(after, "task-human").at(-1)!.data).toMatchObject({ kind: "infra", interruptedRetry: "unreserved",
        reason: expect.stringMatching(/interrupted without an executed full result or beside another unsatisfied gate; no automatic retry/) });
      noRepair(after, "skipped observation");
      expect(of(after, "worker-launch")).toEqual([]);
    }
    // ---- a torn or malformed reservation row BETWEEN two persisted interrupted results — a torn line, an
    // object with no event, a reservation with no task identity or a non-string one: the ordinary readers
    // drop or misfile it, so it would read as an unused allowance and buy a third execution. Every row is
    // validated before any task filter: unprovable accounting parks infra with the safely read observations
    for (const shape of ["torn", "empty object", "missing taskId", "non-string taskId"] as const) {
      const tornId = `run-interrupted-${shape.replace(/ /g, "-")}-reservation`;
      const c = planned(["interrupted", "interrupted", "interrupted", "green"]);
      c.interrupt();
      await runDaemon(c.repo, { adapters: [c.fake], runId: tornId });
      vi.restoreAllMocks();
      const file = join(Journal.open(c.repo, tornId).dir, "journal.jsonl");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      const parsed = lines.map((line) => JSON.parse(line) as JournalEvent);
      const reservedAt = parsed.findIndex((e) => e.event === INTERRUPTED_RETRY_EVENT);
      const kept = lines.slice(0, parsed.findIndex((e) => e.event === "task-human" && e.taskId === "T1"));
      const { taskId: _taskId, ...unowned } = parsed[reservedAt]!;
      kept[reservedAt] = shape === "torn" ? kept[reservedAt]!.slice(0, 40) : shape === "empty object" ? "{}"
        : JSON.stringify(shape === "missing taskId" ? unowned : { ...unowned, taskId: 42 });
      expect(testRows(parsed.slice(reservedAt + 1, kept.length)).length, shape).toBeGreaterThan(0); // interior, not trailing
      writeFileSync(file, `${kept.join("\n")}\n`);
      expect(reservations(rows(c.repo, tornId)), shape).toEqual([]); // the ordinary reader lost it
      c.interrupt();
      const resumed = await runDaemon(c.repo, { adapters: [c.fake], runId: tornId, resume: true });
      vi.restoreAllMocks();
      expect(resumed.human, shape).toEqual(["T1"]);
      expect(c.executions(), shape).toBe(2);
      const after = afterResume(rows(c.repo, tornId));
      expect(of(after, "gate-result"), shape).toEqual([]);
      expect(reservations(after), shape).toEqual([]);
      const park = of(after, "task-human").at(-1)!;
      expect(park.data, shape).toMatchObject({ kind: "infra", interruptedRetry: "unprovable" });
      expect(park.data.reason, shape).toMatch(shape === "torn" ? /interruption retry accounting is unprovable \(1 unreadable journal line\(s\)/
        : /interruption retry accounting is unprovable \(malformed journal row or task identity\); no retry on a guessed identity/);
      expect(park.data.interruptedObservations, shape).toHaveLength(2);
      noRepair(after, shape);
    }
    // ---- an accounting read that FAILS proves nothing: an infra park naming it, no retry, no throw ----
    {
      const failId = "run-interrupted-unreadable";
      const u = planned(["interrupted", "green"]);
      u.interrupt();
      vi.spyOn(recoveryModule, "readAccountingJournal").mockReturnValue({ ok: false, error: "EIO: i/o error, read" });
      const s = await runDaemon(u.repo, { adapters: [u.fake], runId: failId });
      vi.restoreAllMocks();
      expect(s.human).toEqual(["T1"]);
      expect(u.executions()).toBe(1);
      const evs = rows(u.repo, failId);
      expect(reservations(evs)).toEqual([]);
      const park = of(evs, "task-human").at(-1)!;
      expect(park.data).toMatchObject({ kind: "infra", interruptedRetry: "unprovable", interruptedObservations: [] });
      expect(park.data.reason).toMatch(/unprovable \(unreadable accounting: EIO: i\/o error, read\); no retry on a guessed identity; interruption observations: unreadable/);
      noRepair(evs, "unreadable");
    }
    // ---- malformed accounting or a missing subject: an infra park naming unprovable accounting -------
    {
      const badId = "run-interrupted-malformed";
      const m = planned(["interrupted", "green"]);
      // a corrupt reservation lands in the ledger before the first red settles
      m.interrupt((out) => {
        if (out.some((g) => g.gate === "test" && !g.pass)) Journal.open(m.repo, badId).append(INTERRUPTED_RETRY_EVENT, "T1", { commit: 42 });
      });
      await runDaemon(m.repo, { adapters: [m.fake], runId: badId });
      vi.restoreAllMocks();
      expect(m.executions()).toBe(1);
      const evs = rows(m.repo, badId);
      const park = of(evs, "task-human").at(-1)!;
      expect(park.data).toMatchObject({ kind: "infra", interruptedRetry: "unprovable" });
      expect(park.data.reason).toMatch(/interruption retry accounting is unprovable \(malformed interruption retry reservation\); no retry on a guessed identity/);
      noRepair(evs, "malformed");
      // restart before that park: the persisted malformed reservation launches no job and parks again
      const file = join(Journal.open(m.repo, badId).dir, "journal.jsonl");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      writeFileSync(file, `${lines.slice(0, lines.findIndex((l) => (JSON.parse(l) as JournalEvent).event === "task-human")).join("\n")}\n`);
      m.interrupt();
      const resumed = await runDaemon(m.repo, { adapters: [m.fake], runId: badId, resume: true });
      vi.restoreAllMocks();
      expect(resumed.human).toEqual(["T1"]);
      expect(m.executions()).toBe(1);
      const again = afterResume(rows(m.repo, badId));
      expect(of(again, "gate-result")).toEqual([]);
      expect(of(again, "task-human").at(-1)!.data).toMatchObject({ kind: "infra", interruptedRetry: "unprovable" });
      noRepair(again, "malformed restart");
      expect(interruptedRetryState(evs, "T1", "")).toEqual({ kind: "unprovable", reason: "missing subject" });
      expect(interruptedRetryState(evs, "T1", undefined)).toEqual({ kind: "unprovable", reason: "missing subject" });
      const twice = { event: INTERRUPTED_RETRY_EVENT, taskId: "T1", data: { commit: "a".repeat(64), attempt: 0 } };
      expect(interruptedRetryState([twice, twice], "T1", "a".repeat(64)).kind).toBe("unprovable");
      // a recheck claim names its subject: none readable is unattributable before any task or subject filter,
      // and a same-subject or subjectless claim involves the subject even with nothing else readable
      const claim = (data: object) => ({ event: INTERRUPTED_RECHECK_EVENT, taskId: "T1", data }) as JournalEvent;
      const involved = (data: object) => interruptedLedger({ ok: true, events: [claim(data)], unreadable: 0, unreadableLines: [] }, "T1", "a".repeat(64)).involved;
      expect([{}, { commit: "" }, { commit: 42 }, { commit: "a".repeat(64) }].map((data) => [attributable(claim(data)), involved(data)]))
        .toEqual([[false, true], [false, true], [false, true], [true, true]]);
      expect(involved({ commit: "b".repeat(64) })).toBe(false);
    }
    // ---- consumption is by an EXECUTED full result only: reuse, replay, screens and refusals never consume
    {
      const subject64 = "c".repeat(64);
      const reservation = { event: INTERRUPTED_RETRY_EVENT, taskId: "T1", data: { commit: subject64, attempt: 3 } };
      const receipt = (invocationId: string, kind = "exit", gate = "test") => ({ invocationId,
        subject: { runId: "r", taskId: "T1", attempt: 4, gate, subjectCommit: null }, termination: { kind, exitCode: 1, signal: null, timedOut: false } });
      const ran = { evidenceReceipt: receipt("a1b2c3") };
      const result = (data: Record<string, unknown>) => ({ event: "gate-result", taskId: "T1", data: { gate: "test", pass: false, commit: subject64, attempt: 4, ...data } });
      for (const [cell, row] of [
        ["reused", result({ ...ran, reused: true })], ["journal replay copy", result({ ...ran, replayedFromAttempt: 3 })],
        ["selected screen", result({ ...ran, pass: true, selectedTests: [FILE] })], ["unexecuted refusal", result({ skipped: true, pass: undefined })],
        ["dependency-link refusal: no invocation", result({ infra: true, classification: "infra", retryable: false })],
        ["dirty-entry refusal: no invocation", result({ dirtyWorktree: true, infra: true, classification: "infra" })],
        ["discovery failure: listing receipts only", result({ evidenceReceipt: receipt(`n1${LISTING_INVOCATION_SUFFIX}`), evidenceReceipts: [receipt(`n1${LISTING_INVOCATION_SUFFIX}`)] })],
        ["spawn never started", result({ evidenceReceipt: receipt("a1b2c3", "not-started") })],
        ["another gate's invocation", result({ evidenceReceipt: receipt("a1b2c3", "exit", "build") })],
        ["other subject", result({ ...ran, commit: "d".repeat(64) })], ["other gate", result({ ...ran, gate: "build" })],
      ] as const) {
        if (cell !== "other subject") expect(executedFullTest(row.data), cell).toBe(false);
        expect(interruptedRetryState([reservation, row], "T1", subject64).kind, cell).toBe("reserved");
      }
      for (const executed of [result({ ...ran, fullSuite: true, selectedTests: [FILE], pass: true }), result({ ...ran, replayMeasurement: true }),
        result({ ...ran, dirtyWorktree: true }), // a full job that ran and then left dirt keeps its receipts
        result({ evidenceReceipt: receipt(`n1${LISTING_INVOCATION_SUFFIX}`), evidenceReceipts: [receipt(`n1${LISTING_INVOCATION_SUFFIX}`), receipt("n1")] })]) {
        expect(interruptedRetryState([reservation, executed], "T1", subject64)).toEqual({ kind: "consumed", attempt: 3, by: executed });
      }
      expect(interruptedRetryState([result(ran), reservation], "T1", subject64).kind, "execution before the reservation").toBe("reserved");
    }
  }, 600_000);
});
