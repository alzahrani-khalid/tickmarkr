// OBS-1106: an infrastructure recheck or replay reparks without buying a repair. ONE infra predicate
// (isInfraResult) governs classification, the journal row and repair admission, so a result carrying
// only an infra fingerprint or classification — no `meta.infra` — is still parked, never repaired.
// Zero tokens: fake adapter, subprocess driver, scripted gate commands.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
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
import { COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

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
      expect(funded).toHaveLength(1);
      expect(funded[0]!.data).toMatchObject({ charge: 1, gates: ["test"] });
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
        expect(of(post, "repair-attempt")).toHaveLength(1);
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
