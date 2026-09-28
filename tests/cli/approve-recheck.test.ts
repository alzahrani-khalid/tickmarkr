// OBS-203: `approve --recheck` — the third decision a gate-fail park offers. Plain approve WAIVES the
// failed gate and every gate before it; --recheck waives nothing and re-dispatches against the full
// gate suite, for the case where the gate failed against a stale task DECLARATION (spec files[]) rather
// than a bad diff. Fail-closed like every approve path: refusals are loud and append nothing.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { approve, newestPark, parkToken, permittedDecisionVerbs, readJournalEvents } from "../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName } from "../../src/drivers/types.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import * as stall from "../../src/run/stall.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };

// the park this release exists for: scope failed because files[] was too narrow, now amended
function scopeParkedRun(repo: string, runId: string, dispatches = 1): Journal {
  const j = Journal.create(repo, runId);
  for (let i = 0; i < dispatches; i++) j.append("task-dispatch", "T1", { assignment, attempt: i });
  j.append("gate-result", "T1", { gate: "scope", pass: false, details: "out-of-scope edits" });
  j.append("task-human", "T1", { kind: "gate-fail", reason: "consult verdict: human" });
  return j;
}

describe("tickmarkr approve --recheck (OBS-203, zero-token)", () => {
  test("recheck re-pends the task while marking NO gate satisfied, so scope re-runs", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = scopeParkedRun(repo, "run-recheck");

    const msg = await approve(["run-recheck", "T1", "--recheck", "--review-rounds", "1", "--by", "overseer"], repo);
    expect(msg).toMatch(/no gate marked satisfied/);

    const approvals = j.read().filter((e) => e.event === "task-approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      taskId: "T1",
      data: { by: "overseer", via: "cli", release: "recheck", reviewRoundCeiling: 1 },
    });
    // the whole point: plain approve would put scope here, skipping build/test/lint/evidence/scope
    expect(j.replaySatisfiedGates()).toEqual(new Map());
    expect(j.replayStatuses().get("T1")).toBe("pending");
  });

  test("recheck preserves the attempt budget and the tried list — it funds no attempt (OBS-1028)", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = scopeParkedRun(repo, "run-recheck-budget", 6);
    expect(j.replayResumeState().get("T1")?.attempts).toBe(6);

    await approve(["run-recheck-budget", "T1", "--recheck"], repo);

    const rs = j.replayResumeState().get("T1");
    expect(rs?.attempts).toBe(6); // the ladder is NOT reset by a verb that marks no gate satisfied
    expect(rs?.tried).toEqual(["fake:fake-1"]); // burned channels are NOT forgotten
  });

  test("recheck refuses a park that has no failed gate to re-run, appending nothing", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-recheck-refuse");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("task-human", "T1", { kind: "reroute-exhausted", reason: "every channel demoted" });

    await expect(approve(["run-recheck-refuse", "T1", "--recheck"], repo))
      .rejects.toThrow(/--recheck applies to a gate-fail, infra, diff-cap or red-tool-gate authoring park/);
    expect(j.read().filter((e) => e.event === "task-approved")).toHaveLength(0);
  });

  test("recheck accepts an infra park without inventing a failed gate", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-recheck-infra");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("gate-result", "T1", { gate: "test", pass: false, infra: true, details: "signal exit" });
    j.append("task-human", "T1", { kind: "infra", reason: "signal exit" });

    const message = await approve(["run-recheck-infra", "T1", "--recheck"], repo);
    expect(message).toContain("infra park");
    expect(j.read().find((e) => e.event === "task-approved")?.data.release).toBe("recheck");
  });

  test("uphold and recheck are different decisions and cannot be passed together", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = scopeParkedRun(repo, "run-recheck-both");

    await expect(approve(["run-recheck-both", "T1", "--uphold", "--recheck"], repo))
      .rejects.toThrow(/different decisions/);
    expect(j.read().filter((e) => e.event === "task-approved")).toHaveLength(0);
  });

  test("test: uphold and recheck remain mutually exclusive and each still refuses a park whose last failed gate does not match it", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const scopePark = scopeParkedRun(repo, "run-recheck-contract");

    await expect(approve(["run-recheck-contract", "T1", "--uphold", "--recheck"], repo))
      .rejects.toThrow(/different decisions/);
    await expect(approve(["run-recheck-contract", "T1", "--uphold"], repo))
      .rejects.toThrow(/failed gate scope/);
    expect(scopePark.read().filter((e) => e.event === "task-approved")).toHaveLength(0);

    const unmatched = Journal.create(repo, "run-recheck-unmatched");
    unmatched.append("task-dispatch", "T1", { assignment, attempt: 0 });
    unmatched.append("task-human", "T1", { kind: "reroute-exhausted", reason: "no failed gate" });
    await expect(approve(["run-recheck-unmatched", "T1", "--recheck"], repo))
      .rejects.toThrow(/newest park is reroute-exhausted/);
    expect(unmatched.read().filter((e) => e.event === "task-approved")).toHaveLength(0);
  });
});

// OBS-1084: an authoring park whose red is a runner report (a load flake in an unowned suite) admits
// --recheck; the daemon re-runs the battery on the preserved ref with no worker. A park with no red
// gate row (a worker refusal) stays plain-approve only.
describe("tickmarkr approve --recheck on an authoring park (OBS-1084, zero-token)", () => {
  test("test: recheck on an authoring park whose newest gate result is a red test gate journals a recheck release naming that gate so the verb table offers recheck for it, so a refusal listing only gate fail infra or diff cap fails", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-recheck-authoring");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("gate-result", "T1", { gate: "test", pass: false, details: "unowned suite failed to load" });
    j.append("task-human", "T1", { kind: "authoring", reason: "runner report", source: "test" });

    const { events, sourceIndexes } = readJournalEvents(j);
    expect(permittedDecisionVerbs(newestPark(events, "T1", sourceIndexes))).toEqual(["approve", "recheck"]);

    const msg = await approve(["run-recheck-authoring", "T1", "--recheck", "--by", "overseer"], repo);
    expect(msg).toContain("failed gate test");
    const approvals = j.read().filter((e) => e.event === "task-approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ taskId: "T1", data: { by: "overseer", via: "cli", release: "recheck", failedGate: "test", gate: "test" } });
    expect(j.replaySatisfiedGates()).toEqual(new Map());
    expect(j.replayStatuses().get("T1")).toBe("pending");
  });

  test("test: recheck on an authoring park raised by a worker refusal with no red gate result stays refused and the verb table offers approve alone, so a recheck that re-runs a battery nothing failed fails", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-recheck-authoring-refusal");
    j.append("task-dispatch", "T1", { assignment, attempt: 0 });
    j.append("task-human", "T1", { kind: "authoring", reason: "worker refused: task needs out-of-scope edits", source: "worker" });

    const { events, sourceIndexes } = readJournalEvents(j);
    expect(permittedDecisionVerbs(newestPark(events, "T1", sourceIndexes))).toEqual(["approve"]);

    await expect(approve(["run-recheck-authoring-refusal", "T1", "--recheck"], repo))
      .rejects.toThrow(/--recheck applies to .*newest park is authoring with failed gate none/);
    expect(j.read().filter((e) => e.event === "task-approved")).toHaveLength(0);
  });
});

// OBS-1202: a stall park whose reap census was UNREADABLE parks finished work whose tree only needs the
// gates. The park is written exactly as the live daemon writes it (worker-result, then the reap row with
// survivors null, then task-human kind stall carrying reapFailure) over a task branch holding the
// finished commit; the fake script would commit redo.txt if a worker were dispatched again. The host's
// process census is stubbed at the one seam the daemon reaps through, so each census outcome is exact.
describe("approve --recheck on a reapFailure stall park (OBS-1202, zero-token)", () => {
  const fake2 = { adapter: "fake", model: "fake-2", channel: "api" as const, tier: "frontier" as const };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const reapFailure = "worker group 4242 cleanup unknown";
  const seedPark = async (runId: string, recorded: boolean) => {
    const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [
      { shell: `echo redo > redo.txt && ${COMMIT} redo`, result: { ok: true, summary: "redone" } },
    ] } });
    const base = await gitHead(repo);
    const wt = await new SubprocessDriver().worktree(repo, `tickmarkr/${runId}--T1`, base);
    writeFileSync(join(wt, "harvest.txt"), "finished before the park\n");
    git(wt, "add", "-A");
    git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--no-gpg-sign", "-qm", "finished work");
    const j = Journal.create(repo, runId);
    j.append("run-start", undefined, { baseRef: base, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    const nonce = "5ea1ed00";
    const dispatchScript = join(j.dir, "T1-a0.sh");
    writeFileSync(`${dispatchScript}.${nonce}.pgid`, "4242\n");
    const slot = { id: "sub-1", name: formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId }), cwd: wt };
    j.append("task-dispatch", "T1", { assignment: fake2, attempt: 0, workerDispatchOrdinal: 0, retryMode: "fresh" });
    j.append("worker-launch", "T1", { attempt: 0, retryMode: "fresh", nonce, dispatchScript, driver: "subprocess", slot });
    j.append("worker-result", "T1", { ok: true, summary: "t1 finished", deviations: [], finished: true, exitCode: null, mode: "interactive" });
    j.append("worker-process-reaped", "T1", { slot: slot.name, attempt: 0, processGroup: 4242, strays: [43190], survivors: null, error: reapFailure });
    j.append("task-human", "T1", recorded
      ? { kind: "stall", reason: `worker could not be reaped before harvest: ${reapFailure}`, reapFailure }
      : { kind: "stall", reason: "worker stalled with no output" });
    const { events, sourceIndexes } = readJournalEvents(j);
    const park = newestPark(events, "T1", sourceIndexes)!;
    return { repo, fake, j, park, token: parkToken(park)! };
  };
  const resume = async (repo: string, fake: Awaited<ReturnType<typeof seedPark>>["fake"], runId: string, census: number[] | null) => {
    const reap = vi.spyOn(stall, "reapOwnedProcessGroup").mockResolvedValue(census);
    try {
      return await runDaemon(repo, { adapters: [fake], runId, resume: true, driver: new SubprocessDriver() });
    } finally {
      reap.mockRestore();
    }
  };
  const afterResume = (j: Journal) => { const all = j.read(); return all.slice(all.findIndex((e) => e.event === "run-resume") + 1); };

  test("approve --recheck bound to a matching reapFailure stall park token gates harvested commits without worker dispatch for empty owned-census survivors but retains the park for null/live survivors, with plain approve dispatching versus ordinary stall --recheck refusal, so a mismatched outcome fails", async () => {
    // an EMPTY re-verified census releases the harvested commits to the battery; no worker is funded
    {
      const runId = "run-reap-recheck-empty";
      const { repo, fake, j, park, token } = await seedPark(runId, true);
      expect(permittedDecisionVerbs(park)).toEqual(["approve", "recheck"]);
      // bound: a token naming no open park is refused, appending nothing
      await expect(approve([runId, "T1", "--recheck", "--park", `1@${park.ts}`], repo)).rejects.toThrow(/refusing stale decision/);
      expect(j.read().filter((e) => e.event === "task-approved")).toEqual([]);
      const msg = await approve([runId, "T1", "--recheck", "--park", token, "--by", "overseer"], repo);
      expect(msg).toMatch(/^approval disposition re-dispatch: .*reapFailure stall park; the owned census is re-verified before the gates; no gate marked satisfied/);
      expect(j.read().find((e) => e.event === "task-approved")!.data).toMatchObject({ release: "recheck", reapFailure, park: { line: park.line, ts: park.ts } });
      const s = await resume(repo, fake, runId, []);
      expect(s.done).toEqual(["T1"]);
      const post = afterResume(j);
      expect(post.filter((e) => e.event === "task-dispatch" || e.event === "worker-launch")).toEqual([]);
      const reaped = post.findIndex((e) => e.event === "worker-process-reaped");
      expect(post[reaped]!.data).toMatchObject({ attempt: 0, processGroup: 4242, survivors: [] });
      expect(reaped).toBeLessThan(post.findIndex((e) => e.event === "gate-result"));
      expect(post.some((e) => e.event === "recheck-battery")).toBe(true);
      expect(post.find((e) => e.event === "task-done")!.data.assignment).toEqual(fake2);
      expect(git(repo, "show", `tickmarkr/${runId}:harvest.txt`)).toBe("finished before the park");
      expect(() => git(repo, "show", `tickmarkr/${runId}:redo.txt`)).toThrow();
    }
    // an UNREADABLE (null) or SURVIVING census keeps the task parked: a stall park carrying the fresh
    // reapFailure under its own new token, still offering approve/recheck, with nothing gated or dispatched
    for (const [label, census, said] of [["null", null, "cleanup unknown"], ["live", [4243], "survivors: 4243"]] as const) {
      const runId = `run-reap-recheck-${label}`;
      const { repo, fake, j, token } = await seedPark(runId, true);
      await approve([runId, "T1", "--recheck", "--park", token], repo);
      const s = await resume(repo, fake, runId, census === null ? null : [...census]);
      expect(s.human).toEqual(["T1"]);
      expect(s.done).toEqual([]);
      const post = afterResume(j);
      expect(post.filter((e) => ["task-dispatch", "worker-launch", "gate-result", "recheck-battery"].includes(e.event))).toEqual([]);
      expect(post.find((e) => e.event === "worker-process-reaped")!.data).toMatchObject({ attempt: 0, processGroup: 4242, survivors: census === null ? null : [...census] });
      const reparked = post.filter((e) => e.event === "task-human");
      expect(reparked.map((e) => e.data)).toEqual([expect.objectContaining({
        kind: "stall", reapFailure: `worker group 4242 ${said}`, reason: `worker could not be reaped before recheck: worker group 4242 ${said}`,
      })]);
      const { events, sourceIndexes } = readJournalEvents(j);
      const kept = newestPark(events, "T1", sourceIndexes)!;
      expect(permittedDecisionVerbs(kept)).toEqual(["approve", "recheck"]);
      expect(parkToken(kept)).not.toBe(token);
      expect(j.replayStatuses().get("T1")).toBe("human");
      expect(() => git(repo, "show", `tickmarkr/${runId}:harvest.txt`)).toThrow();
      // the consumed token no longer binds: only the retained park's own token decides it
      await expect(approve([runId, "T1", "--recheck", "--park", token], repo)).rejects.toThrow(/refusing stale decision/);
    }
    // MISSING ownership files (no .pgid/.session, no descendants) make reapWorker return normally
    // with a null census: that is not a recorded empty census, so the park is retained too
    {
      const runId = "run-reap-recheck-unowned";
      const { repo, fake, j, token } = await seedPark(runId, true);
      rmSync(join(j.dir, "T1-a0.sh.5ea1ed00.pgid"));
      await approve([runId, "T1", "--recheck", "--park", token], repo);
      const s = await resume(repo, fake, runId, null);
      expect(s.human).toEqual(["T1"]);
      expect(s.done).toEqual([]);
      const post = afterResume(j);
      expect(post.filter((e) => ["task-dispatch", "worker-launch", "gate-result", "recheck-battery"].includes(e.event))).toEqual([]);
      expect(post.find((e) => e.event === "worker-process-reaped")!.data).toMatchObject({ attempt: 0, processGroup: null, survivors: null });
      expect(post.filter((e) => e.event === "task-human").map((e) => e.data)).toEqual([expect.objectContaining({
        kind: "stall", reapFailure: "worker group unknown census unrecorded",
      })]);
      expect(() => git(repo, "show", `tickmarkr/${runId}:harvest.txt`)).toThrow();
    }
    // plain approve on the same park keeps its dispatch semantics: it funds a worker
    {
      const runId = "run-reap-plain";
      const { repo, fake, j, token } = await seedPark(runId, true);
      expect(await approve([runId, "T1", "--park", token], repo)).toMatch(/^approval disposition dispatch: /);
      const s = await resume(repo, fake, runId, []);
      expect(s.done).toEqual(["T1"]);
      expect(afterResume(j).filter((e) => e.event === "task-dispatch").map((e) => e.data.attempt)).toEqual([1]);
      expect(git(repo, "show", `tickmarkr/${runId}:redo.txt`)).toBe("redo");
    }
    // an ordinary stall park recorded no census failure: approve only, and --recheck is refused unappended
    {
      const runId = "run-reap-ordinary";
      const { repo, j, park, token } = await seedPark(runId, false);
      expect(park.reapFailure).toBeUndefined();
      expect(permittedDecisionVerbs(park)).toEqual(["approve"]);
      await expect(approve([runId, "T1", "--recheck", "--park", token], repo))
        .rejects.toThrow(/--recheck applies to a stall park only when it recorded a reapFailure/);
      expect(j.read().filter((e) => e.event === "task-approved")).toEqual([]);
    }
  }, 120_000);
});
