// OBS-1169: a worker CLI that dies in its own bootstrap (codex's `account/read failed during TUI
// bootstrap … (code -32603)`, exit 1 about a second after launch) never read the brief. It is not a work
// failure: it must not harvest the carried commits into a replay of the previous red (one real failure
// counted twice by the fingerprint cap), must not spend the repair it was dispatched to perform, and must
// not label an adapter's unlaunched siblings "already tried" when the whole adapter is escalated away from.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { channelKey, type BillingChannel } from "../../../src/adapters/types.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir } from "../../../src/graph/graph.js";
import { resetBootstrapBackoffMsForTests, runDaemon, setBootstrapBackoffMsForTests } from "../../../src/run/daemon.js";
import { gitHead } from "../../../src/run/git.js";
import { Journal, repairsSinceApproval, type JournalEvent } from "../../../src/run/journal.js";
import { authedModels, COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

const BOOT = { shell: `echo ${JSON.stringify("Error: account/read failed during TUI bootstrap: account/read failed: workspace routing discovery failed (code -32603)")}; exit 1` };
const RED = { shell: `echo boom > broken.txt && ${COMMIT} b1`, result: { ok: true, summary: "a0" } };
const FIX = { shell: `echo ok > fixed.txt && git rm -q broken.txt && ${COMMIT} b2`, result: { ok: true, summary: "fixed" } };
const TEST_GATE = "gates: { test: 'test ! -f broken.txt' }\n";
const HUMAN = { action: "human", notes: "park" };
const evs = (repo: string, runId: string) => Journal.open(repo, runId).read();
const of = (all: JournalEvent[], event: string) => all.filter((e) => e.event === event && e.taskId === "T1");
const seatOf = (e: JournalEvent) => channelKey((e.data as { assignment: BillingChannel }).assignment);
const failedTests = (all: JournalEvent[]) => of(all, "gate-result").filter((e) => e.data.gate === "test" && e.data.pass === false);

// A second adapter the fleet can escalate to once the fake's bootstrap is broken.
class OtherAdapter extends FakeAdapter {
  id = "other";
  vendor = "other-v";
  async probe() {
    return { installed: true, authed: true, version: "fake", models: ["o-1"], modelAuth: authedModels(["o-1"]) };
  }
  channels(): BillingChannel[] {
    return [{ adapter: "other", vendor: "other-v", model: "o-1", channel: "api", tier: "frontier" }];
  }
}

// The fake with its second channel removed: an adapter with NO untried sibling to carry its exclusion.
class SoloFake extends FakeAdapter {
  channels(): BillingChannel[] {
    return [{ adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" }];
  }
}

describe("OBS-1169: a worker CLI bootstrap death keeps its own account", () => {
  beforeEach(() => setBootstrapBackoffMsForTests(50));
  afterEach(() => resetBootstrapBackoffMsForTests());

  test("test: the production daemon retries an exit-one bootstrap with zero commits once on the same channel without changing repair or fingerprint counts versus charging a real work failure, so a bootstrap replay reaching occurrence two fails", async () => {
    // attempt 0 lands a real red; the funded repair dies at bootstrap over the carried commit, then runs
    const boot = setupRepo([T("T1")], { consult: HUMAN, tasks: { T1: [RED, BOOT, FIX] } }, TEST_GATE);
    const s = await runDaemon(boot.repo, { adapters: [boot.fake], runId: "run-boot" });
    expect(s.done).toEqual(["T1"]);
    const b = evs(boot.repo, "run-boot");
    expect(of(b, "bootstrap-retry").map((e) => e.data)).toMatchObject([
      { attempt: 1, retry: 1, of: 1, channel: "fake:fake-1", exitCode: 1, matched: "account/read failed during TUI bootstrap" },
    ]);
    // the same channel, the same attempt, still the funded repair — the bootstrap bought nothing
    const dispatches = of(b, "task-dispatch");
    expect(dispatches.map((e) => [seatOf(e), e.data.attempt, e.data.retryMode])).toEqual([
      ["fake:fake-1", 0, "fresh"], ["fake:fake-1", 1, "repair"], ["fake:fake-1", 1, "repair"],
    ]);
    // the carried commit was never harvested into a replay of attempt 0's red
    expect(of(b, "worker-result-harvested")).toHaveLength(0);
    expect(failedTests(b)).toHaveLength(1);
    expect(of(b, "gate-fingerprint-cap")).toHaveLength(0);
    // one repair funded, and charged once — by the retried worker's battery, not by the dead launch
    expect(of(b, "repair-attempt")).toHaveLength(1);
    expect(repairsSinceApproval(b, "T1")).toBe(1);
    const retryPrompt = readFileSync(join(tickmarkrDir(boot.repo), "runs", "run-boot", "prompts", "T1-a1.md"), "utf8");
    expect(retryPrompt).toContain("## Repair attempt — fix ONLY what these findings name");
    expect(of(b, "channel-demotion")).toHaveLength(0);
    expect(of(b, "consult-verdict")).toHaveLength(0);

    // the same exit-one with no trailer is a real work failure — charged, its carried commit harvested,
    // the replayed red counted as occurrence two — when it carries no bootstrap text, and equally when
    // the bootstrap wording sits outside the startup prefix: after a tool frame (the worker's own
    // command said it), or at the tail of a row-saturated read whose origin has scrolled away
    const said = JSON.stringify("Error: account/read failed during TUI bootstrap (code -32603)");
    const works = {
      plain: "echo 'still thinking about the fix'; exit 1",
      tool: `echo ${JSON.stringify("⏺ Bash(npm run setup)")}; echo ${said}; exit 1`,
      // the bootstrap line came FIRST, then the worker ran a tool: the prefix is not the CLI's own
      afterwards: `echo ${said}; echo ${JSON.stringify("⏺ Bash(npm run setup)")}; exit 1`,
      // not the known adapter diagnostic — generic prose that merely says "bootstrap failed"
      prose: `echo 'setup bootstrap failed, see logs'; exit 1`,
      saturated: `seq 1 600; echo ${said}; exit 1`,
      // Even startup-shaped output cannot refund a worker that produced its own commit.
      committed: `echo progress > progress.txt && ${COMMIT} progress >/dev/null && echo ${said}; exit 1`,
    };
    for (const [name, shell] of Object.entries(works)) {
      const work = setupRepo([T("T1")], { consult: HUMAN, tasks: { T1: [RED, { shell }, FIX] } }, TEST_GATE);
      const s2 = await runDaemon(work.repo, { adapters: [work.fake], runId: `run-work-${name}` });
      const w = evs(work.repo, `run-work-${name}`);
      expect(of(w, "bootstrap-retry"), name).toHaveLength(0);
      expect(of(w, "worker-result-harvested"), name).toHaveLength(1);
      expect(of(w, "worker-result-harvested")[0]!.data.commits, name).toHaveLength(name === "committed" ? 2 : 1);
      expect(failedTests(w), name).toHaveLength(2);
      expect(of(w, "gate-fingerprint-cap").map((e) => e.data), name).toMatchObject([{ gate: "test", occurrences: 2 }]);
      expect(s2.done, name).toEqual([]);
    }
  }, 240_000);

  test("test: the production daemon records vendor escalation separately from actual channel attempts after bounded bootstrap recovery versus ordinary retry, so an unlaunched sibling labelled already tried fails", async () => {
    const escalated = "vendor escalated: fake bootstrap failed on fake:fake-1";
    const { repo, fake } = setupRepo([T("T1")], { consult: HUMAN, tasks: { T1: [BOOT, BOOT] } });
    const otherScript = join(makeTestTempDir("tickmarkr-other-"), "s.json");
    writeFileSync(otherScript, JSON.stringify({
      judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] }, consult: HUMAN,
      tasks: { T1: [{ shell: `echo ok > T1.txt && ${COMMIT} T1`, result: { ok: true, summary: "on other" } }] },
    }));
    const s = await runDaemon(repo, { adapters: [fake, new OtherAdapter(otherScript)], runId: "run-boot-escalate" });
    expect(s.done).toEqual(["T1"]);
    const e = evs(repo, "run-boot-escalate");
    expect(of(e, "bootstrap-retry")).toHaveLength(1);
    expect(of(e, "bootstrap-failover").map((r) => r.data)).toMatchObject([
      { from: "fake:fake-1", to: "other:o-1", retries: 1, escalated: ["fake:fake-2"] },
    ]);
    const dispatches = of(e, "task-dispatch");
    expect(dispatches.map((r) => [seatOf(r), r.data.attempt])).toEqual([["fake:fake-1", 0], ["fake:fake-1", 0], ["other:o-1", 0]]);
    // the ordinary same-channel retry excludes nothing; only the escalation names the adapter's siblings
    expect(dispatches[1]!.data.exclusionReasons).toEqual({});
    // the launched channel is already tried; its never-launched sibling carries the escalation reason
    expect(dispatches[2]!.data.exclusionReasons).toEqual({ "fake:fake-1": "already tried", "fake:fake-2": escalated });
    expect(of(e, "worker-launch")).toHaveLength(3);
    expect(dispatches.some((r) => seatOf(r) === "fake:fake-2")).toBe(false);
    // task-scoped: nothing is demoted or excluded run-wide
    expect(of(e, "channel-demotion")).toHaveLength(0);
    expect(of(e, "channel-exclusion")).toHaveLength(0);

    // with no eligible channel beyond the broken adapter, the bounded recovery parks infra, uncharged
    const alone = setupRepo([T("T1")], { consult: HUMAN, tasks: { T1: [BOOT, BOOT, BOOT] } });
    const s2 = await runDaemon(alone.repo, { adapters: [alone.fake], runId: "run-boot-alone" });
    expect(s2.human).toEqual(["T1"]);
    const a = evs(alone.repo, "run-boot-alone");
    expect(of(a, "bootstrap-retry")).toHaveLength(1);
    expect(of(a, "bootstrap-failover").map((r) => r.data)).toMatchObject([{ from: "fake:fake-1", to: null, escalated: ["fake:fake-2"] }]);
    expect(of(a, "task-human").map((r) => r.data)).toMatchObject([{ kind: "infra", cause: "bootstrap", channel: "fake:fake-1", retries: 1 }]);
    expect(of(a, "task-dispatch")).toHaveLength(2);

    // a restart keeps the escalation's routing disposition apart from the attempts it refunded: crash
    // (1) right after the failover row resumes ON its destination, never the exhausted source; crash
    // (2) after the destination's dispatch still holds the escalated sibling out of the next failover
    const seat = (adapter: string, model: string, channel: string) => ({ adapter, model, channel, tier: "frontier" });
    const [src, dest] = [seat("fake", "fake-1", "sub"), seat("other", "o-1", "api")];
    const crashed = async (name: string, destinationDispatched: boolean, destinationShell?: string) => {
      const r = setupRepo([T("T1")], { consult: HUMAN, tasks: { T1: [BOOT] } });
      const script = join(makeTestTempDir("tickmarkr-other-"), "s.json");
      writeFileSync(script, JSON.stringify({
        judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] }, consult: HUMAN,
        tasks: { T1: destinationShell ? [{ shell: destinationShell }] : destinationDispatched ? [BOOT] : [{ shell: `echo ok > T1.txt && ${COMMIT} T1`, result: { ok: true, summary: "on other" } }] },
      }));
      const runId = `run-boot-resume-${name}`;
      const j = Journal.create(r.repo, runId);
      j.append("run-start", undefined, { baseRef: await gitHead(r.repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(r.repo)) });
      const matched = "account/read failed during TUI bootstrap";
      j.append("task-dispatch", "T1", { assignment: src, attempt: 0, workerDispatchOrdinal: 0 });
      j.append("bootstrap-retry", "T1", { attempt: 0, retry: 1, of: 1, channel: "fake:fake-1", assignment: src, matched, exitCode: 1, backoffMs: 50 });
      j.append("task-dispatch", "T1", { assignment: src, attempt: 0, workerDispatchOrdinal: 1 });
      j.append("bootstrap-failover", "T1", { from: "fake:fake-1", to: "other:o-1", toAssignment: dest, matched, retries: 1, escalated: ["fake:fake-2"], reason: escalated });
      if (destinationDispatched) j.append("task-dispatch", "T1", { assignment: dest, attempt: 0, workerDispatchOrdinal: 2 });
      writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
      const before = j.read().length;
      const sum = await runDaemon(r.repo, { adapters: [r.fake, new OtherAdapter(script)], runId, resume: true });
      return { sum, after: evs(r.repo, runId).slice(before) };
    };
    const one = await crashed("after-failover", false);
    expect(one.sum.done).toEqual(["T1"]);
    expect(of(one.after, "resume-restore").map((r) => r.data)).toMatchObject([{ attempts: 0, assignment: dest }]);
    expect(of(one.after, "task-dispatch").map(seatOf)).toEqual(["other:o-1"]);
    expect(of(one.after, "task-dispatch")[0]!.data.exclusionReasons).toEqual({ "fake:fake-1": "already tried", "fake:fake-2": escalated });
    const two = await crashed("after-destination", true);
    expect(two.sum.human).toEqual(["T1"]);
    expect(of(two.after, "task-dispatch").map(seatOf)).toEqual(["other:o-1", "other:o-1"]);
    expect(of(two.after, "task-dispatch")[0]!.data.exclusionReasons).toEqual({ "fake:fake-1": "already tried", "fake:fake-2": escalated });
    expect(of(two.after, "bootstrap-failover").map((r) => r.data)).toMatchObject([{ from: "other:o-1", to: null, escalated: [] }]);
    expect(of(two.after, "task-human").map((r) => r.data)).toMatchObject([{ kind: "infra", cause: "bootstrap", channel: "other:o-1" }]);

    // crash (3): the resumed destination dies with an ORDINARY dead-channel diagnostic — the
    // recycle fallback must still hold the escalated adapter out, never relaunching its siblings
    const three = await crashed("dead-destination", true, "echo 'zsh: other: command not found'; exit 1");
    expect(three.sum.human).toEqual(["T1"]);
    expect(of(three.after, "task-dispatch").map(seatOf)).toEqual(["other:o-1"]);
    expect(of(three.after, "channel-exclusion").map((r) => r.data)).toMatchObject([{ channel: "other:o-1", reason: "setup-required" }]);
    expect(of(three.after, "dead-channel-failover").map((r) => r.data)).toMatchObject([{ from: "other:o-1", to: null }]);
    expect(of(three.after, "channel-recycle")).toHaveLength(0);
    expect(of(three.after, "worker-launch")).toHaveLength(1);

    // two SINGLE-channel adapters: A exhausts bootstrap recovery with no sibling to carry its exclusion
    // and fails over to B; B dying with an ordinary dead-channel diagnostic must not recycle A's channel
    const DEAD = { shell: "echo 'zsh: other: command not found'; exit 1" };
    const soloOther = () => {
      const script = join(makeTestTempDir("tickmarkr-other-"), "s.json");
      writeFileSync(script, JSON.stringify({
        judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] }, consult: HUMAN,
        tasks: { T1: [DEAD] },
      }));
      return new OtherAdapter(script);
    };
    const solo = setupRepo([T("T1")], { consult: HUMAN, tasks: { T1: [BOOT, BOOT] } });
    const s3 = await runDaemon(solo.repo, { adapters: [new SoloFake(solo.scriptPath), soloOther()], runId: "run-boot-solo" });
    expect(s3.human).toEqual(["T1"]);
    const so = evs(solo.repo, "run-boot-solo");
    expect(of(so, "bootstrap-failover").map((r) => r.data)).toMatchObject([{ from: "fake:fake-1", to: "other:o-1", escalated: [] }]);
    expect(of(so, "task-dispatch").map(seatOf)).toEqual(["fake:fake-1", "fake:fake-1", "other:o-1"]);
    expect(of(so, "dead-channel-failover").map((r) => r.data)).toMatchObject([{ from: "other:o-1", to: null }]);
    expect(of(so, "channel-recycle")).toHaveLength(0);
    expect(of(so, "worker-launch")).toHaveLength(3);

    // …and the same after a crash following B's dispatch: the adapter exclusion is replayed, not lost
    const soloResume = async (runId: string, excluded: boolean) => {
      const rs = setupRepo([T("T1")], { consult: HUMAN, tasks: { T1: [BOOT] } });
      const j = Journal.create(rs.repo, runId);
      j.append("run-start", undefined, { baseRef: await gitHead(rs.repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(rs.repo)) });
      const matched = "account/read failed during TUI bootstrap";
      j.append("task-dispatch", "T1", { assignment: src, attempt: 0, workerDispatchOrdinal: 0 });
      j.append("bootstrap-retry", "T1", { attempt: 0, retry: 1, of: 1, channel: "fake:fake-1", assignment: src, matched, exitCode: 1, backoffMs: 50 });
      j.append("task-dispatch", "T1", { assignment: src, attempt: 0, workerDispatchOrdinal: 1 });
      j.append("bootstrap-failover", "T1", { from: "fake:fake-1", to: "other:o-1", toAssignment: dest, matched, retries: 1, escalated: [], reason: escalated });
      j.append("task-dispatch", "T1", { assignment: dest, attempt: 0, workerDispatchOrdinal: 2 });
      if (excluded) j.append("channel-exclusion", "T1", { channel: "other:o-1", reason: "setup-required", kind: "dead-channel" });
      writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
      const before = j.read().length;
      const sum = await runDaemon(rs.repo, { adapters: [new SoloFake(rs.scriptPath), soloOther()], runId, resume: true });
      return { sum, after: evs(rs.repo, runId).slice(before) };
    };
    const four = await soloResume("run-boot-solo-resume", false);
    expect(four.sum.human).toEqual(["T1"]);
    expect(of(four.after, "task-dispatch").map(seatOf)).toEqual(["other:o-1"]);
    expect(of(four.after, "dead-channel-failover").map((r) => r.data)).toMatchObject([{ from: "other:o-1", to: null }]);
    expect(of(four.after, "channel-recycle")).toHaveLength(0);
    expect(of(four.after, "worker-launch")).toHaveLength(1);
    // crash right after B's channel-exclusion, before its park: B is demoted and A escalated, so the
    // resume has nothing eligible — it parks infra rather than falling back to route()'s static A
    const five = await soloResume("run-boot-solo-excluded", true);
    expect(five.sum.human).toEqual(["T1"]);
    expect(of(five.after, "task-dispatch")).toHaveLength(0);
    expect(of(five.after, "worker-launch")).toHaveLength(0);
    expect(of(five.after, "task-human").map((r) => r.data)).toMatchObject([{ kind: "infra", cause: "bootstrap", channel: "fake:fake-1" }]);
  }, 300_000);
});
