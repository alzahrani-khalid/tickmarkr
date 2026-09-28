// OBS-1106: an infrastructure recheck or replay reparks without buying a repair. ONE infra predicate
// (isInfraResult) governs classification, the journal row and repair admission, so a result carrying
// only an infra fingerprint or classification — no `meta.infra` — is still parked, never repaired.
// Zero tokens: fake adapter, subprocess driver, scripted gate commands.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Assignment } from "../../../src/adapters/types.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { loadConfig } from "../../../src/config/config.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { graphDefinitionHash, loadGraph } from "../../../src/graph/graph.js";
import * as gateRunner from "../../../src/gates/run-gates.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { gitHead, shGit, shGitOk, verificationProtocol } from "../../../src/run/git.js";
import { Journal, repairReachSinceApproval, repairsSinceApproval, type JournalEvent } from "../../../src/run/journal.js";
import { ensureIntegration, integrationBranch } from "../../../src/run/merge.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

const rows = (repo: string, runId: string) => Journal.open(repo, runId).read();
const afterResume = (all: JournalEvent[]): JournalEvent[] => all.slice(all.map((e) => e.event).lastIndexOf("run-resume") + 1);
const of = (evs: JournalEvent[], event: string) => evs.filter((e) => e.event === event && e.taskId === "T1");
const testRows = (evs: JournalEvent[]) => of(evs, "gate-result").filter((e) => e.data.gate === "test");

afterEach(() => vi.restoreAllMocks());

/** Strip `infra` (and optionally the classification) off every red test result BEFORE the daemon's
 * onGate sees it — a legacy/metadata-poor verifier whose only infra evidence is the fingerprint. */
const stripInfraMeta = (keepClassification: boolean) => {
  const original = gateRunner.runGates;
  vi.spyOn(gateRunner, "runGates").mockImplementation((task, ctx, ...rest) => original(task, {
    ...ctx,
    onGate: async (event) => {
      if (event.phase === "end" && event.result.gate === "test" && !event.result.pass) {
        const { infra: _infra, classification, ...meta } = event.result.meta ?? {};
        event.result.meta = keepClassification ? { ...meta, classification } : meta;
      }
      await ctx.onGate?.(event);
    },
  }, ...rest));
};

/** One task; the test gate is green until the worker lands t1.txt, then runs `red` on the same tree. */
const repoWith = (red: string) => setupRepo(
  [T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] })],
  {
    consult: { action: "human", notes: "operator decides" },
    tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] },
  },
  stringify({ gates: { build: "true", test: `[ ! -f t1.txt ] || { ${red}; }`, lint: "true" } }),
);

const INFRA = "echo 'Error: spawn EAGAIN' >&2; exit 1";
const NAMED = "echo 'FAIL t1.test.ts > reads one'; echo 'AssertionError: expected one to be two'; exit 1";

describe("OBS-1106 — infrastructure rechecks repark without buying a repair", () => {
  test("test: the production daemon reparks a same-tree recheck with an INFRA fingerprint or infra classification lacking meta.infra without repair debit versus ordinary bounded repair for a named assertion, so metadata-only admission fails", async () => {
    // ---- infra: fingerprint only, then classification only — both repark, neither funds a repair --
    for (const [runId, keepClassification] of [["run-infra-fingerprint", false], ["run-infra-classification", true]] as const) {
      const { repo, fake } = repoWith(INFRA);
      const first = await runDaemon(repo, { adapters: [fake], runId });
      expect(first.human).toEqual(["T1"]);
      const parked = of(rows(repo, runId), "task-human").at(-1)!;
      expect(parked.data.kind).toBe("infra");
      const attempts = Journal.open(repo, runId).replayResumeState().get("T1")?.attempts;
      const dispatches = of(rows(repo, runId), "task-dispatch").length;
      await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      stripInfraMeta(keepClassification);
      const resumed = await runDaemon(repo, { adapters: [fake], runId, resume: true });
      vi.restoreAllMocks();
      expect(resumed.human, runId).toEqual(["T1"]);
      const post = afterResume(rows(repo, runId));
      const repark = of(post, "task-human").at(-1)!;
      expect(repark.data.kind, runId).toBe("infra");
      expect(repark.data.reason, runId).toMatch(/^test: infra;/);
      expect(of(post, "repair-attempt"), runId).toEqual([]);
      expect(of(post, "task-dispatch"), runId).toEqual([]);
      expect(of(post, "worker-launch"), runId).toEqual([]);
      expect(repairsSinceApproval(rows(repo, runId), "T1"), runId).toBe(0);
      // persistence agrees with classification: the row is journaled AS infra, and the carried
      // commit and attempt count survive the park
      const red = testRows(post).at(-1)!;
      expect(red.data.pass).toBe(false);
      expect(red.data.infra, runId).toBe(true);
      expect(of(post, "worktree-recreation")[0]!.data.carried).toHaveLength(1);
      expect(of(rows(repo, runId), "task-dispatch")).toHaveLength(dispatches);
      expect(Journal.open(repo, runId).replayResumeState().get("T1")?.attempts, runId).toBe(attempts);
    }
    // ---- a named assertion on the same recheck buys the ordinary bounded repair ------------------
    {
      const { repo, fake } = repoWith(NAMED);
      const runId = "run-named-repair";
      const first = await runDaemon(repo, { adapters: [fake], runId });
      expect(first.human).toEqual(["T1"]);
      expect(of(rows(repo, runId), "task-human").at(-1)!.data.kind).not.toBe("infra");
      await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      await runDaemon(repo, { adapters: [fake], runId, resume: true });
      const post = afterResume(rows(repo, runId));
      const funded = of(post, "repair-attempt");
      // bounded: the repair lands nothing, so its battery REPLAYS the red — a copy of one observation,
      // not a second occurrence (OBS-1106 residual) — and the ladder draws its second repair, no more
      expect(funded.map((e) => e.data.charge)).toEqual([1, 2]);
      expect(funded[0]!.data).toMatchObject({ charge: 1, gates: ["test"] });
      expect(of(post, "gate-fingerprint-cap")).toEqual([]);
      expect(funded[0]!.data.findings).toContain("FAIL t1.test.ts");
      expect(of(post, "task-dispatch")[0]?.data.retryMode).toBe("repair");
      expect(testRows(post).every((e) => e.data.infra === undefined)).toBe(true);
    }
  }, 300_000);

  test("test: the production daemon classifies an assertion-free signal137 recheck as infra versus a named assertion with SIGKILL as work, so signal text overriding failure identity fails", async () => {
    for (const [runId, red, infra] of [
      ["run-signal-only", "echo SIGKILL; exit 137", true],
      ["run-signal-named", "echo 'FAIL t1.test.ts > reads one'; echo SIGKILL; exit 137", false],
    ] as const) {
      const { repo, fake } = repoWith(red);
      const first = await runDaemon(repo, { adapters: [fake], runId });
      expect(first.human, runId).toEqual(["T1"]);
      expect(of(rows(repo, runId), "task-human").at(-1)!.data.kind === "infra", runId).toBe(infra);
      await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      await runDaemon(repo, { adapters: [fake], runId, resume: true });
      const post = afterResume(rows(repo, runId));
      const red137 = testRows(post)[0]!;
      expect(red137.data.pass, runId).toBe(false);
      expect(red137.data.infra, runId).toBe(infra ? true : undefined);
      if (infra) {
        expect(of(post, "task-human").at(-1)!.data.kind).toBe("infra");
        expect(of(post, "repair-attempt")).toEqual([]);
        expect(of(post, "task-dispatch")).toEqual([]);
      } else {
        expect(of(post, "repair-attempt").map((e) => e.data.charge)).toEqual([1, 2]); // the replay is a copy (OBS-1106)
        expect(of(post, "task-dispatch")[0]?.data.retryMode).toBe("repair");
      }
    }
  }, 300_000);

  test("test: the production daemon resume over an infra gate replay preserves the recorded repair reach with carried subject identity intact, so replay minting another repair intent or charging one fails", async () => {
    // A journal ending mid-battery of a FUNDED repair: attempt 0 red on a named assertion, repair 1
    // funded and launched, its battery reached build (green) and test (a legacy infra row: fingerprint
    // only, no `infra` flag) on the same commit, then the daemon died. The resume replays the green
    // build and re-measures test, which is infra again.
    const runId = "run-infra-replay-reach";
    const ASSIGNMENT: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
    const commands = {
      build: 'if [[ "$PWD" == *--T1 ]]; then true; fi',
      test: 'if [[ "$PWD" == *--T1 ]]; then echo "Error: spawn EAGAIN"; exit 1; fi',
      lint: "true",
    };
    const { repo, fake } = setupRepo(
      [T("T1", { files: ["work.txt"] })],
      { tasks: { T1: [{ shell: "exit 99", result: { ok: false, summary: "worker must not be re-dispatched" } }] } },
      stringify({ gates: commands }),
    );
    const baseRef = await gitHead(repo);
    const branch = integrationBranch(loadConfig(repo), runId);
    await ensureIntegration(repo, branch, baseRef);
    const wt = await new SubprocessDriver().worktree(repo, `${branch}--T1`, baseRef);
    writeFileSync(join(wt, "work.txt"), "landed work\n");
    await shGitOk("git add work.txt && git commit --no-gpg-sign -m work", wt);
    const commit = await gitHead(wt);
    const journal = Journal.create(repo, runId);
    journal.append("run-start", undefined, { pid: 111_111, baseRef, commands, branch, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    const row = (gate: string, attempt: number, data: Record<string, unknown>) =>
      journal.append("gate-result", "T1", { gate, verification: verificationProtocol(), commit, attempt, ...data });
    journal.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 0, retryMode: "fresh" });
    journal.append("worker-launch", "T1", {});
    journal.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [], finished: true, exitCode: 0 });
    journal.phaseStart("T1", "gates");
    row("build", 0, { pass: true });
    row("test", 0, { pass: false, details: "FAIL unowned.test.ts > reads one" });
    journal.append("repair-attempt", "T1", { repair: 1, charge: 1, of: 2, gates: ["test"], commits: 1, findings: "test: FAIL unowned.test.ts > reads one" });
    journal.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 1, retryMode: "repair" });
    journal.append("worker-launch", "T1", {});
    journal.append("worker-result", "T1", { ok: true, summary: "repaired", deviations: [], finished: true, exitCode: 0 });
    journal.phaseStart("T1", "gates");
    row("build", 1, { pass: true });
    row("test", 1, { pass: false, details: "infra; exit 1; the fresh failures carry infrastructure evidence alone — the runner never completed a suite, so this gate verified nothing:\nError: spawn EAGAIN" });
    writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({
      commands: Object.fromEntries(Object.keys(commands).map((gate) => [gate, { exitCode: 0, fingerprints: [] }])),
    }));
    const reachBefore = repairReachSinceApproval(journal.read(), "T1");
    expect(reachBefore).toEqual([{ repair: 1, funded: ["test"], reached: ["build", "test"], diedAt: "test", charged: true }]);

    stripInfraMeta(false);
    const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    vi.restoreAllMocks();
    expect(summary.human).toEqual(["T1"]);
    const all = rows(repo, runId);
    const post = afterResume(all);
    expect(of(post, "task-human").at(-1)!.data.kind).toBe("infra");
    expect(of(post, "repair-attempt")).toEqual([]);
    expect(of(post, "task-dispatch")).toEqual([]);
    expect(of(post, "worker-launch")).toEqual([]);
    // the recorded reach is still ONE repair — same funding, same death gate, charged once — its
    // battery merely finished its walk; nothing was minted and nothing re-charged
    const reach = repairReachSinceApproval(all, "T1");
    expect(reach).toHaveLength(1);
    expect(reach[0]).toMatchObject({ repair: 1, funded: ["test"], diedAt: "test", charged: true });
    expect(reach[0]!.reached).toEqual(expect.arrayContaining(reachBefore[0]!.reached));
    expect(repairsSinceApproval(all, "T1")).toBe(1);
    expect(of(all, "repair-attempt")).toHaveLength(1);
    // subject identity carried: the replayed green names the seeded commit and every fresh row of
    // the resumed battery sits on one subject, journaled AS infra
    expect(of(post, "gate-reused").map((e) => [e.data.gate, e.data.commit])).toEqual([["build", commit]]);
    const fresh = of(post, "gate-result");
    expect(new Set(fresh.map((e) => e.data.commit)).size).toBe(1);
    const red = testRows(post).at(-1)!;
    expect(red.data).toMatchObject({ pass: false, infra: true, attempt: 2 });
    expect(of(post, "worktree-recreation")[0]!.data.carried).toEqual([commit]);

    // ---- the prior-row REPLAY branch: a legacy infra red lent to the repair attempt ----------------
    // A run that stopped between funding repair 1 and dispatching it (run-end, T1 pending): attempt
    // 0's test red is a legacy infra row (fingerprint only, no `infra`) that a pre-OBS-1106 daemon
    // funded a repair for. On resume the repair worker lands no new commit, so attempt 1's battery
    // replays attempt 0's rows instead of buying a command. The replayed red is normalized AS infra
    // and parks; the one funded repair is neither re-minted nor re-charged twice.
    {
      const replayRunId = "run-infra-replay-prior-row";
      const { repo: repo2, fake: fake2 } = setupRepo(
        [T("T1", { files: ["work.txt"] })],
        { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "nothing to change" } }] } },
        stringify({ gates: commands }),
      );
      const base2 = await gitHead(repo2);
      const branch2 = integrationBranch(loadConfig(repo2), replayRunId);
      await ensureIntegration(repo2, branch2, base2);
      const wt2 = await new SubprocessDriver().worktree(repo2, `${branch2}--T1`, base2);
      writeFileSync(join(wt2, "work.txt"), "landed work\n");
      await shGitOk("git add work.txt && git commit --no-gpg-sign -m work", wt2);
      const commit2 = await gitHead(wt2);
      // the daemon's canonical gate subject for this commit series (daemon.ts gateCommitSubject)
      const history = await shGit(`git log --reverse --format='%T%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e' ${base2}..${commit2}`, wt2);
      const subject2 = createHash("sha256").update(history.stdout).digest("hex");
      const j2 = Journal.create(repo2, replayRunId);
      j2.append("run-start", undefined, { pid: 111_112, baseRef: base2, commands, branch: branch2, graphDefinitionHash: graphDefinitionHash(loadGraph(repo2)) });
      const legacyRed = "infra; exit 1; the fresh failures carry infrastructure evidence alone — the runner never completed a suite, so this gate verified nothing:\nError: spawn EAGAIN";
      j2.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 0, retryMode: "fresh" });
      j2.append("worker-launch", "T1", {});
      j2.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [], finished: true, exitCode: 0 });
      j2.phaseStart("T1", "gates");
      j2.append("gate-result", "T1", { gate: "build", verification: verificationProtocol(), commit: subject2, attempt: 0, pass: true });
      j2.append("gate-result", "T1", { gate: "test", verification: verificationProtocol(), commit: subject2, attempt: 0, pass: false, details: legacyRed });
      j2.append("repair-attempt", "T1", { repair: 1, charge: 1, of: 2, gates: ["test"], commits: 1, findings: `test: ${legacyRed}` });
      j2.append("run-end", undefined, { runId: replayRunId, branch: branch2, done: [], failed: [], human: [], blocked: [], pending: ["T1"] });
      writeFileSync(join(j2.dir, "baseline.json"), JSON.stringify({
        commands: Object.fromEntries(Object.keys(commands).map((gate) => [gate, { exitCode: 0, fingerprints: [] }])),
      }));
      const reach2Before = repairReachSinceApproval(j2.read(), "T1");
      expect(reach2Before).toHaveLength(1);
      // funded, not yet dispatched: charged only once its worker runs
      expect(reach2Before[0]).toMatchObject({ repair: 1, funded: ["test"], charged: false });

      const summary2 = await runDaemon(repo2, { adapters: [fake2], runId: replayRunId, resume: true });
      expect(summary2.human).toEqual(["T1"]);
      const all2 = rows(repo2, replayRunId);
      const post2 = afterResume(all2);
      // the repair worker ran once on the carried tree and changed nothing
      expect(of(post2, "task-dispatch").map((e) => e.data.retryMode)).toEqual(["repair"]);
      expect(of(post2, "worker-launch")).toHaveLength(1);
      expect(of(post2, "worktree-recreation")[0]!.data.carried).toEqual([commit2]);
      // so attempt 0's rows were REPLAYED — no command bought — and the red persisted as infra
      const replayed = of(post2, "gate-replayed");
      expect(replayed.map((e) => [e.data.gate, e.data.pass, e.data.commit, e.data.priorAttempt]))
        .toEqual([["build", true, subject2, 0], ["test", false, subject2, 0]]);
      const replayedRed = testRows(post2).at(-1)!;
      expect(replayedRed.data).toMatchObject({ pass: false, infra: true, attempt: 1, replayedFromAttempt: 0, commit: subject2 });
      expect(of(post2, "gate-reused")).toEqual([]);
      // parked as infra; the repair ledger is unchanged: one funded, charged once, nothing minted
      expect(of(post2, "task-human").at(-1)!.data.kind).toBe("infra");
      expect(of(post2, "repair-attempt")).toEqual([]);
      expect(of(all2, "repair-attempt")).toHaveLength(1);
      expect(repairsSinceApproval(all2, "T1")).toBe(1);
      const reach2 = repairReachSinceApproval(all2, "T1");
      expect(reach2).toHaveLength(1);
      expect(reach2[0]).toMatchObject({ repair: 1, funded: ["test"], charged: true });
    }
  }, 180_000);
});

// OBS-1106 residual: a timeout or wall-budget red that arrives with runner infra diagnostics is
// re-observed ONCE, isolated to its attributed failing files, before anything is charged for it.
describe("OBS-1106 — infra-shaped reds are re-observed before a charge", () => {
  const SLOW = "tests/slow.test.ts";
  const TIMEOUT = "echo 'Error: Test timed out in 5000ms.'";
  // The runner-level diagnostic block the vitest manifest path appends to a red's details
  // (test-manifest.ts: the never-started count, then the runner's own errors and output tails).
  const NEVER_STARTED = "\nclassification: regression; runner-level diagnostic: never-started 3; reporter errors 0; runner vitest";
  const WORKER_RPC = "\nclassification: regression; runner-level diagnostic: never-started 0; reporter errors 1; runner vitest\nError: [vitest-worker]: Timeout calling \"onTaskUpdate\"";
  /** A scripted runner cannot emit that block itself, so it is attached where the manifest path would. */
  const withDiagnostic = (diagnostic: string) => {
    const original = gateRunner.runGates;
    vi.spyOn(gateRunner, "runGates").mockImplementation((task, ctx, ...rest) => original(task, {
      ...ctx,
      onGate: async (event) => {
        if (event.phase === "end" && event.result.gate === "test" && !event.result.pass) event.result.details += diagnostic;
        await ctx.onGate?.(event);
      },
    }, ...rest));
  };
  /** The full run is a timeout-shaped red; a narrowed invocation (a file argument) is the rerun. */
  const repoWith = (diagnostic: string, timeout: string, rerun: string) => {
    withDiagnostic(diagnostic);
    const dir = makeTestTempDir("tickmarkr-reobserve-");
    const script = join(dir, "gate.sh");
    writeFileSync(script, [
      "[ -f t1.txt ] || exit 0",
      `if [ $# -gt 0 ]; then echo "rerun $*" >> ${JSON.stringify(join(dir, "reruns.log"))}; ${rerun}; fi`,
      `echo 'FAIL ${SLOW} > slow'; ${timeout}; exit 1`,
    ].join("\n") + "\n");
    const made = setupRepo(
      [T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] })],
      { consult: { action: "human", notes: "operator decides" },
        tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } },
          ...Array.from({ length: 4 }, () => ({ shell: "true", result: { ok: true, summary: "nothing" } }))] } },
      stringify({ gates: { build: "true", test: `sh ${script}`, lint: "true" } }),
    );
    mkdirSync(join(made.repo, "tests"), { recursive: true });
    writeFileSync(join(made.repo, SLOW), "// the attributed failing file\n");
    execFileSync("git", ["add", SLOW], { cwd: made.repo });
    execFileSync("git", ["commit", "--no-gpg-sign", "-q", "-m", "slow test"], { cwd: made.repo });
    return { ...made, reruns: join(dir, "reruns.log") };
  };
  const firstRound = (evs: JournalEvent[]) => {
    const second = evs.findIndex((e) => e.taskId === "T1" && e.event === "task-dispatch" && e.data.attempt === 1);
    return second === -1 ? evs : evs.slice(0, second);
  };

  test("test: the production daemon charges only a reproduced assertion after one isolated rerun of attributed timeout or wall-budget failures accompanied by never-started or worker-RPC diagnostics, versus parking a pass or ambiguous rerun under the unresolved original red", async () => {
    const WALL = "echo 'AssertionError: expected 1180 to be less than 1000'";
    // ---- a pass or an ambiguous rerun parks under the unresolved original red, charging nothing -----
    for (const [runId, diagnostic, shape, rerun, outcome] of [
      ["run-reobserve-pass", WORKER_RPC, TIMEOUT, "exit 0", "passed"],
      ["run-reobserve-pass-wall", NEVER_STARTED, WALL, "exit 0", "passed"],
      // D-607 round 2: a runner without a manifest reporter proves nothing about its selection — even a
      // rerun that fails exactly the attributed file is ambiguous, whatever the red's shape or diagnostic
      ["run-reobserve-no-manifest-never-started", NEVER_STARTED, TIMEOUT, `echo 'FAIL ${SLOW} > slow'; echo 'AssertionError: expected 1 to be 2'; exit 1`, "ambiguous"],
      ["run-reobserve-no-manifest-worker-rpc", WORKER_RPC, WALL, `echo 'FAIL ${SLOW} > slow'; echo 'AssertionError: expected 1 to be 2'; exit 1`, "ambiguous"],
      ["run-reobserve-ambiguous", NEVER_STARTED, TIMEOUT, "echo 'Error: spawn EAGAIN'; exit 1", "ambiguous"],
      ["run-reobserve-unnamed", WORKER_RPC, TIMEOUT, "echo 'something else broke'; exit 1", "ambiguous"],
      // the rerun PRINTS the original path, but attributes its failure to another file: no reproduction
      ["run-reobserve-unrelated", NEVER_STARTED, TIMEOUT,
        `echo ' ✓ ${SLOW} (1 test)'; echo 'FAIL tests/other.test.ts > other'; echo 'AssertionError: expected 1 to be 2'; exit 1`, "ambiguous"],
      // D-607: a runner that ignored the file argument and reported a wider run fails the file again
      // under the same contention — its OBSERVED selection is not the isolated one, so no charge
      ["run-reobserve-ignored-args", WORKER_RPC, TIMEOUT,
        `echo ' ✓ tests/a.test.ts (3 tests)'; echo 'FAIL ${SLOW} > slow'; echo 'AssertionError: expected 1 to be 2'; exit 1`, "ambiguous"],
      // D-607: the original path as a stdout substring beside an unattributed assertion is not attribution
      ["run-reobserve-substring", NEVER_STARTED, TIMEOUT,
        `echo 'stdout | see ${SLOW} for the fixture'; echo 'AssertionError: expected 1 to be 2'; exit 1`, "ambiguous"],
    ] as const) {
      const { repo, fake, reruns } = repoWith(diagnostic, shape, rerun);
      const summary = await runDaemon(repo, { adapters: [fake], runId });
      vi.restoreAllMocks();
      expect(summary.human, runId).toEqual(["T1"]);
      expect(summary.done, runId).toEqual([]);
      const all = rows(repo, runId);
      expect(readFileSync(reruns, "utf8").split("\n").filter(Boolean), runId).toEqual([`rerun ${SLOW}`]);
      expect(of(all, "gate-reobserved").map((e) => e.data.outcome), runId).toEqual([outcome]);
      const park = of(all, "task-human").at(-1)!;
      expect(park.data.kind, runId).toBe("infra");
      expect(park.data.reason, runId).toContain(`not reproduced by one isolated rerun of ${SLOW} (${outcome})`);
      expect(park.data.reason, runId).toContain("the original red stands unresolved");
      // the original red is still the test gate's only verdict: never replaced, never greened, no merge
      const reds = testRows(all);
      expect(reds.map((e) => e.data.pass), runId).toEqual([false]);
      expect(of(all, "merge"), runId).toEqual([]);
      expect(of(all, "task-done"), runId).toEqual([]);
      expect(of(all, "repair-attempt"), runId).toEqual([]);
      expect(of(all, "task-dispatch"), runId).toHaveLength(1);
      expect(repairsSinceApproval(all, "T1"), runId).toBe(0);
    }
    // ---- only a manifested rerun can reproduce, and only from an isolated selection: the ordinary
    // repair is charged for a reproduced assertion; a positional filter that also collected another file
    // (`tests/slow.test.tsx`) is ambiguous even with the original file failing ----
    // D-607: on the manifest path only the reporter's attribution counts — a `FAIL <path>` line the test's
    // own stdout printed, with the reporter attributing nothing, is ambiguous; and a rerun reporting no
    // manifest (per-file lines are not complete selection evidence) cannot prove isolation
    for (const [runId, diagnostic, shape, manifest, failingFiles, outcome] of [
      ["run-reobserve-manifest-isolated", NEVER_STARTED, TIMEOUT, [SLOW], [SLOW], "reproduced"],
      ["run-reobserve-manifest-isolated-wall", WORKER_RPC, WALL, [SLOW], [SLOW], "reproduced"],
      ["run-reobserve-manifest-wider", NEVER_STARTED, TIMEOUT, [SLOW, "tests/slow.test.tsx"], [SLOW], "ambiguous"],
      ["run-reobserve-manifest-stdout-fail-line", NEVER_STARTED, TIMEOUT, [SLOW], [], "ambiguous"],
      ["run-reobserve-no-selection-evidence", WORKER_RPC, TIMEOUT, undefined, [SLOW], "ambiguous"],
    ] as const) {
      const { repo, fake } = repoWith(diagnostic, shape, "exit 0");
      const reobserve = vi.spyOn(gateRunner, "reobserveTestFiles").mockResolvedValue({ gate: "test", pass: false,
        details: `test report names failing fingerprint(s):\nFAIL ${SLOW} > slow\nAssertionError: expected 1 to be 2`,
        meta: { classification: "regression", failingTests: [`${SLOW} > slow`], failingFiles: [...failingFiles], ...(manifest ? { manifest: [...manifest] } : {}) } });
      const summary = await runDaemon(repo, { adapters: [fake], runId });
      expect(reobserve.mock.calls[0]!.slice(3, 4), runId).toEqual([[SLOW]]);
      vi.restoreAllMocks();
      const round = firstRound(rows(repo, runId));
      expect(of(round, "gate-reobserved").map((e) => e.data.outcome), runId).toEqual([outcome]);
      if (manifest) expect(of(round, "gate-reobserved")[0]!.data.selection, runId).toEqual([...manifest].sort());
      if (outcome === "reproduced") {
        // the ORIGINAL red is the charged evidence; the rerun is no gate-result row of its own
        expect(testRows(round).map((e) => e.data.pass), runId).toEqual([false]);
        expect(of(round, "repair-attempt").map((e) => e.data), runId).toMatchObject([{ charge: 1, gates: ["test"] }]);
        expect(of(round, "task-human"), runId).toEqual([]);
      } else {
        expect(summary.human, runId).toEqual(["T1"]);
        expect(of(round, "repair-attempt"), runId).toEqual([]);
        expect(of(round, "task-human").at(-1)!.data.kind, runId).toBe("infra");
      }
    }
  }, 600_000);

  // A process that dies after the red is persisted leaves a cached copy for the resume to find. Whether
  // that copy may be charged is decided by the ledger: with no adjudication of that observation the
  // copy is re-observed now; with one, its recorded outcome parks it without a second rerun.
  test("a copied red is adjudicated on resume unless its observation's adjudication is on the ledger, whose recorded outcome then decides without a second rerun", async () => {
    for (const cut of ["before-adjudication", "after-adjudication"] as const) {
      const runId = `run-reobserve-crash-${cut}`;
      const { repo, fake, reruns } = repoWith(WORKER_RPC, TIMEOUT, "exit 0");
      await runDaemon(repo, { adapters: [fake], runId });
      vi.restoreAllMocks();
      const journal = Journal.open(repo, runId);
      const lived = journal.read();
      const red = lived.findIndex((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "test" && e.data.pass === false);
      const adjudicated = lived.findIndex((e) => e.event === "gate-reobserved");
      expect(red, cut).toBeGreaterThan(-1);
      expect(adjudicated, cut).toBeGreaterThan(red);
      expect(lived[adjudicated]!.data).toMatchObject({ outcome: "passed", commit: lived[red]!.data.commit });
      // the crash: nothing after the persisted red (or after its adjudication) reached the ledger
      writeFileSync(join(journal.dir, "journal.jsonl"), lived.slice(0, (cut === "before-adjudication" ? red : adjudicated) + 1)
        .map((e) => JSON.stringify(e)).join("\n") + "\n");
      withDiagnostic(WORKER_RPC);
      const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true });
      vi.restoreAllMocks();
      const post = afterResume(rows(repo, runId));
      // the resume's red is the persisted observation's cached copy, not a new execution
      expect(testRows(post)[0]!.data, cut).toMatchObject({ pass: false, reused: true, evidenceReceipt: lived[red]!.data.evidenceReceipt });
      const reobserved = of(post, "gate-reobserved");
      const reran = readFileSync(reruns, "utf8").split("\n").filter(Boolean);
      if (cut === "before-adjudication") {
        expect(reobserved.map((e) => e.data.outcome), cut).toEqual(["passed"]);
        expect(reran, cut).toEqual([`rerun ${SLOW}`, `rerun ${SLOW}`]);
      } else {
        expect(reobserved, cut).toEqual([]);
        expect(reran, cut).toEqual([`rerun ${SLOW}`]);
      }
      // either way the copy parks under its unresolved original red and buys nothing
      expect(summary.human, cut).toEqual(["T1"]);
      const park = of(post, "task-human").at(-1)!;
      expect(park.data.kind, cut).toBe("infra");
      expect(park.data.reason, cut).toContain(`not reproduced by one isolated rerun of ${SLOW} (passed)`);
      expect(of(post, "repair-attempt"), cut).toEqual([]);
      expect(of(post, "task-dispatch"), cut).toEqual([]);
    }
  }, 300_000);
});

