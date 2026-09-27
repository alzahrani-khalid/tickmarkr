import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type ApprovalDisposition, approve } from "../../src/cli/commands/approve.js";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, loadGraph, taskDefinitionFingerprint, tickmarkrDir } from "../../src/graph/graph.js";
import { outstandingApprovals, pendingDaemonApprovalActions, runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import {
  activeRetryBan, APPROVAL_REFUSED, applyScopeAmendments, bindingToken, effectiveDecisions, foldDecisions, identicalGateFailures, journaledFailureBrief, Journal, normalizeGateFailure, PARK_KINDS,
  pendingApprovalActions, pendingRechecks, recordedGraphDefinitionHash, repairReachSinceApproval, repairsSinceApproval, reviewRoundsSinceApproval,
  staleApprovals, type DecisionBinding,
} from "../../src/run/journal.js";
import { previewDecision } from "../../src/tui/cockpit/decision-actions.js";
import { deriveRunCockpitData } from "../../src/tui/cockpit/derive.js";
import { createLiveStore } from "../../src/tui/cockpit/live-store.js";
import { decidedLiveStore } from "../../src/tui/cockpit/live-runtime.js";
import { acquireApprovalSerialization } from "../../src/run/lock.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const countApproved = (dir: string, runId: string): number =>
  Journal.open(dir, runId).read().filter((e) => e.event === "task-approved").length;

// OBS-147 (v1.79 T3): every test that dispatches a real daemon run carries the same explicit
// 120s load-proof budget the resume round-trip already needed — the vitest default timeout is
// a real-time bound this suite does not control, and a starved release runner exceeded it on
// healthy runs. Journal-only tests keep the default; they spawn no workers.
describe("tickmarkr approve — fail-closed human gate approval (GATE-08, zero-token)", () => {
  test("test: after approval of a gate-fail park a resume proceeds past the approved gate for that task without re-dispatching the worker and without re-judging", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      {
        judge: { pass: false, criteria: [{ criterion: "c1", met: false, reason: "operator override required" }] },
        review: { approve: true, issues: [] },
        consult: { action: "human", notes: "operator must decide" },
        tasks: { T1: [{ shell: `echo approved > approved.txt && ${COMMIT} approved`, result: { ok: true, summary: "implemented" } }] },
      },
    );
    const runId = "run-gate-satisfied";
    const first = await runDaemon(repo, { adapters: [fake], runId });
    expect(first.human).toEqual(["T1"]);

    await approve([runId, "T1", "--waive", "--by", "operator"], repo);
    const beforeResume = Journal.open(repo, runId).read();
    const dispatchesBefore = beforeResume.filter((e) => e.event === "task-dispatch" && e.taskId === "T1").length;
    const judgmentsBefore = beforeResume.filter((e) =>
      e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "acceptance",
    ).length;

    const resumed = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expect(resumed.done).toEqual(["T1"]);
    const afterResume = Journal.open(repo, runId).read();
    expect(afterResume.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(dispatchesBefore);
    expect(afterResume.filter((e) =>
      e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "acceptance",
    )).toHaveLength(judgmentsBefore);
    expect(afterResume.slice(beforeResume.length).filter((e) =>
      e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "review" && e.data.pass === true,
    )).toHaveLength(1);
    expect(afterResume.slice(beforeResume.length).some((e) => e.event === "merge" && e.taskId === "T1")).toBe(true);
  }, 120_000);

  test("test: the recorded approval marker is scoped to the approved task and gate and releases nothing else", async () => {
    const { repo } = setupRepo([T("T1"), T("T2")], { tasks: {} });
    const j = Journal.create(repo, "run-scoped-gate-approval");
    j.append("gate-result", "T1", { gate: "acceptance", pass: false, details: "judge failed" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "operator decision required" });
    j.append("gate-result", "T2", { gate: "review", pass: false, details: "review failed" });
    j.append("task-human", "T2", { kind: "gate-fail", reason: "operator decision required" });

    await approve(["run-scoped-gate-approval", "T1", "--waive", "--by", "operator"], repo);

    const approvals = j.read().filter((e) => e.event === "task-approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      taskId: "T1",
      data: { by: "operator", release: "gate-satisfied", gate: "acceptance" },
    });
    expect(j.replayStatuses()).toEqual(new Map([["T1", "pending"], ["T2", "human"]]));
  });

  test("gate satisfaction on resume derives only from an explicit operator approval event in the ledger and is never inferred by the daemon", () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-no-inferred-gate-approval");
    j.append("gate-result", "T1", { gate: "acceptance", pass: false, details: "judge failed" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "operator decision required" });
    j.append("gate-satisfied", "T1", { gate: "acceptance", source: "daemon" });

    expect(j.replaySatisfiedGates()).toEqual(new Map());
  });

  test("unknown runId is a loud refusal; no journal directory is created", async () => {
    const { repo } = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
    await expect(approve(["run-nope", "T1"], repo)).rejects.toThrow(/no journal for run-nope/i);
    expect(existsSync(join(tickmarkrDir(repo), "runs", "run-nope"))).toBe(false);
  });

  test("unknown taskId is a loud refusal; zero task-approved events appended", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-a" });
    await expect(approve(["run-a", "T_NOPE"], repo)).rejects.toThrow(/T_NOPE.*no events/);
    expect(countApproved(repo, "run-a")).toBe(0);
  }, 120_000);

  test("not-parked task is a loud refusal naming the actual status; zero events appended", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-b" });
    expect(s.done).toEqual(["T1"]); // T1 is done, not parked
    await expect(approve(["run-b", "T1"], repo)).rejects.toThrow(/T1 is done, not a parked human gate/);
    expect(countApproved(repo, "run-b")).toBe(0);
  }, 120_000);

  test("success appends who/when (default OS user) and prints the next step", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-c" }); // T1 parks
    const out = await approve(["run-c", "T1"], repo);
    expect(out).toContain(userInfo().username);
    expect(out).toContain("tickmarkr resume run-c");
    const ev = Journal.open(repo, "run-c").read().filter((e) => e.event === "task-approved");
    expect(ev).toHaveLength(1);
    expect(ev[0].taskId).toBe("T1");
    expect(ev[0].data.by).toBe(userInfo().username);
    expect(Date.parse(ev[0].ts)).toBeGreaterThan(0); // the event's ts is the when
  }, 120_000);

  test("--by and --reason are recorded verbatim", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-d" });
    await approve(["run-d", "T1", "--by", "orchestrator-on-behalf", "--reason", "reviewed diff"], repo);
    const ev = Journal.open(repo, "run-d").read().find((e) => e.event === "task-approved")!;
    expect(ev.data.by).toBe("orchestrator-on-behalf");
    expect(ev.data.reason).toBe("reviewed diff");
  }, 120_000);

  test("double-approve is refused (replayed status is now pending, not parked)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-e" });
    await approve(["run-e", "T1"], repo); // first approval — replayed status is now "pending"
    await expect(approve(["run-e", "T1"], repo)).rejects.toThrow(/T1 is pending, not a parked human gate/);
    expect(countApproved(repo, "run-e")).toBe(1); // exactly one event — approvals cannot stack
  }, 120_000);

  test("missing positionals is a loud usage refusal", async () => {
    const { repo } = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
    await expect(approve([], repo)).rejects.toThrow(/usage: tickmarkr approve/);
    await expect(approve(["run-x"], repo)).rejects.toThrow(/usage: tickmarkr approve/);
  });

  test("a review-round ceiling must be a positive integer and invalid values append no approval", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-invalid-review-ceiling");
    j.append("task-human", "T1", { kind: "human-gate", reason: "approval required" });

    for (const value of ["0", "-1", "1.5", "many"]) {
      await expect(approve(["run-invalid-review-ceiling", "T1", "--review-rounds", value], repo))
        .rejects.toThrow(/--review-rounds must be a positive integer/);
    }
    await expect(approve(["run-invalid-review-ceiling", "T1", "--review-rounds"], repo))
      .rejects.toThrow(/usage: tickmarkr approve/);
    expect(j.read().filter((event) => event.event === "task-approved")).toHaveLength(0);
  });

  test("GATE-08 end-to-end through the real command: park → approve() → resume → done", async () => {
    // proves the command and the daemon agree on the event name and semantics (not a journal append,
    // but the actual exported approve() function).
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    const s1 = await runDaemon(repo, { adapters: [fake], runId: "run-e2e" });
    expect(s1.human).toEqual(["T1"]);
    await approve(["run-e2e", "T1"], repo);
    const s2 = await runDaemon(repo, { adapters: [fake], runId: "run-e2e", resume: true });
    expect(s2.done).toEqual(["T1"]);
  }, 120_000);

  // v1.24 OBS-18 / GATE-08 non-regression: humanGate parks (attempts 0) stamp NO release field —
  // event shape stays {by, via} (+ optional reason), identical to pre-v1.24.
  test("humanGate approve stamps no release field (GATE-08 byte-stable)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-hg-rel" });
    await approve(["run-hg-rel", "T1", "--by", "op"], repo);
    const ev = Journal.open(repo, "run-hg-rel").read().find((e) => e.event === "task-approved")!;
    expect(ev.data.by).toBe("op");
    expect(ev.data.via).toBe("cli");
    expect(ev.data.release).toBeUndefined(); // no attempt-cap grant on a pre-dispatch humanGate park
  }, 120_000);

  // v1.24 OBS-18: approve of a task whose last task-human is an attempt-cap park stamps release.
  test("attempt-cap park approve stamps release:attempt-cap", async () => {
    const { repo } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    // seed a cap-park journal (status human) without burning 10 real attempts in the suite
    const j = Journal.create(repo, "run-cap-rel");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {} });
    const a = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
    for (let i = 0; i < 10; i++) j.append("task-dispatch", "T1", { assignment: a, attempt: i });
    j.append("task-human", "T1", { reason: "attempt cap (10) reached", kind: "attempt-cap" });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));

    await approve(["run-cap-rel", "T1", "--by", "op"], repo);
    const ev = Journal.open(repo, "run-cap-rel").read().find((e) => e.event === "task-approved")!;
    expect(ev.data.release).toBe("attempt-cap");
    expect(ev.data.by).toBe("op");
    // resume state: fresh budget resets both halves of the ladder (v2.5.6 T5, OBS-1028)
    const st = Journal.open(repo, "run-cap-rel").replayResumeState().get("T1")!;
    expect(st.attempts).toBe(0);
    expect(st.tried).toEqual([]);
  });

  test("approve resolves a park by its kind and not by prose matching", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-kind-rel");
    j.append("task-human", "T1", { reason: "a completely unrelated message", kind: "attempt-cap" });
    await approve(["run-kind-rel", "T1"], repo);
    expect(Journal.open(repo, "run-kind-rel").read().find((e) => e.event === "task-approved")?.data.release).toBe("attempt-cap");
  });

  test("an unknown park kind still requires a human", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-unknown-kind");
    j.append("task-human", "T1", { reason: "attempt cap (10) reached", kind: "future-kind" });
    await approve(["run-unknown-kind", "T1"], repo);
    const approved = Journal.open(repo, "run-unknown-kind").read().find((e) => e.event === "task-approved")!;
    expect(approved.data.release).toBeUndefined();
  });

  test("test: plain approve on a gate-fail park refuses naming the failed gate and every applicable disposition option — waive-gate and re-dispatch on a non-review gate and additionally fund-fixed-attempt when the failed gate is review — and appends no event while plain approve on a pre-dispatch human gate and on an attempt-cap park still appends its release so the shipped silent gate-satisfied waiver fails", async () => {
    const { repo } = setupRepo([T("T1"), T("T2"), T("T3"), T("T4")], { tasks: {} });
    const j = Journal.create(repo, "run-plain-dispositions");
    j.append("gate-result", "T1", { gate: "acceptance", pass: false, details: "red" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "gate failed" });
    j.append("gate-result", "T2", { gate: "review", pass: false, details: "changes" });
    j.append("task-human", "T2", { kind: "gate-fail", reason: "review failed" });
    j.append("task-human", "T3", { kind: "human-gate", reason: "needs approval" });
    j.append("task-human", "T4", { kind: "attempt-cap", reason: "cap" });

    await expect(approve(["run-plain-dispositions", "T1"], repo))
      .rejects.toThrow(/failed gate acceptance.*waive-gate.*re-dispatch/);
    await expect(approve(["run-plain-dispositions", "T2"], repo))
      .rejects.toThrow(/failed gate review.*waive-gate.*re-dispatch.*fund-fixed-attempt/);
    expect(j.read().filter((e) => e.event === "task-approved")).toHaveLength(0);

    expect(await approve(["run-plain-dispositions", "T3", "--by", "op"], repo)).toContain("disposition dispatch");
    expect(await approve(["run-plain-dispositions", "T4", "--by", "op"], repo)).toContain("disposition fresh-budget");
    expect(j.read().filter((e) => e.event === "task-approved").map((e) => e.data.release)).toEqual([undefined, "attempt-cap"]);
  });

  test("test: approve --waive on a gate-fail park appends the gate-satisfied release naming the failed gate and prints the waive-gate disposition while --waive on any other park kind refuses without appending", async () => {
    const nonGateKinds = PARK_KINDS.filter((kind) => kind !== "gate-fail");
    const { repo } = setupRepo([T("T1"), ...nonGateKinds.map((kind) => T(`park-${kind}`))], { tasks: {} });
    const j = Journal.create(repo, "run-waive");
    j.append("gate-result", "T1", { gate: "scope", pass: false, details: "scope red" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "gate failed" });
    for (const kind of nonGateKinds) {
      j.append("task-human", `park-${kind}`, { kind, reason: `park ${kind}` });
    }

    const out = await approve(["run-waive", "T1", "--waive", "--by", "op"], repo);
    expect(out).toContain("disposition waive-gate");
    expect(j.read().find((e) => e.event === "task-approved" && e.taskId === "T1")?.data)
      .toMatchObject({ release: "gate-satisfied", gate: "scope", by: "op" });

    for (const kind of nonGateKinds) {
      await expect(approve(["run-waive", `park-${kind}`, "--waive"], repo)).rejects.toThrow(/--waive applies to a gate-fail park/);
    }
    expect(j.read().filter((e) => e.event === "task-approved")).toHaveLength(1);
  });

  test("test: every decision flag binds to the newest park so --uphold on an attempt-cap park that follows an older rechecked review failure refuses without appending and any two of waive uphold and recheck passed together refuse with no event appended while the shipped parser that validates uphold against the newest historical failed gate and rejects only uphold with recheck fails", async () => {
    const { repo } = setupRepo([T("T1"), T("T2")], { tasks: {} });
    const j = Journal.create(repo, "run-newest-park");
    j.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0 });
    j.append("gate-result", "T1", { gate: "review", pass: false, details: "old review" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "review failed" });
    await approve(["run-newest-park", "T1", "--recheck"], repo);
    j.append("task-human", "T1", { kind: "attempt-cap", reason: "cap after recheck" });
    const before = j.read().filter((e) => e.event === "task-approved").length;
    await expect(approve(["run-newest-park", "T1", "--uphold"], repo))
      .rejects.toThrow(/newest park is attempt-cap/);
    expect(j.read().filter((e) => e.event === "task-approved")).toHaveLength(before);

    j.append("gate-result", "T2", { gate: "review", pass: false, details: "review" });
    j.append("task-human", "T2", { kind: "gate-fail", reason: "review failed" });
    for (const flags of [["--waive", "--uphold"], ["--waive", "--recheck"], ["--uphold", "--recheck"]]) {
      await expect(approve(["run-newest-park", "T2", ...flags], repo)).rejects.toThrow(/different decisions/);
    }
    expect(j.read().filter((e) => e.event === "task-approved" && e.taskId === "T2")).toHaveLength(0);
  });

  test("test: every accepted approval prints the disposition token its appended release maps to under the closed mapping — absent release dispatch, gate-satisfied waive-gate, recheck re-dispatch, review-upheld fund-fixed-attempt, attempt-cap fresh-budget — and the TICKMARKR_APPROVAL record carries the same token whenever it is emitted while a token chosen from message prose, a token outside the vocabulary, or a mapping that swaps any pair fails", async () => {
    const { repo } = setupRepo([T("dispatch"), T("waive"), T("recheck"), T("uphold"), T("cap")], { tasks: {} });
    const j = Journal.create(repo, "run-token-map");
    writeFileSync(join(tickmarkrDir(repo), "graph.lock"), JSON.stringify({ pid: process.pid, runId: "run-token-map", startedAt: Date.now() }));
    const cases: Array<[string, string[], ApprovalDisposition]> = [
      ["dispatch", [], "dispatch"],
      ["waive", ["--waive"], "waive-gate"],
      ["recheck", ["--recheck"], "re-dispatch"],
      ["uphold", ["--uphold"], "fund-fixed-attempt"],
      ["cap", [], "fresh-budget"],
    ];
    j.append("task-human", "dispatch", { kind: "human-gate", reason: "go" });
    for (const taskId of ["waive", "recheck"]) {
      j.append("gate-result", taskId, { gate: "acceptance", pass: false, details: "red" });
      j.append("task-human", taskId, { kind: "gate-fail", reason: "gate" });
    }
    j.append("gate-result", "uphold", { gate: "review", pass: false, details: "changes" });
    j.append("task-human", "uphold", { kind: "gate-fail", reason: "review" });
    j.append("task-human", "cap", { kind: "attempt-cap", reason: "cap" });

    for (const [taskId, flags, disposition] of cases) {
      const out = await approve(["run-token-map", taskId, ...flags, "--by", "op"], repo);
      expect(out).toContain(`disposition ${disposition}`);
      const record = JSON.parse(out.split("\n").find((line) => line.startsWith("TICKMARKR_APPROVAL "))!.slice("TICKMARKR_APPROVAL ".length));
      expect(record.disposition).toBe(disposition);
      expect(["dispatch", "waive-gate", "re-dispatch", "fund-fixed-attempt", "fresh-budget"]).toContain(record.disposition);
    }
  });
});

// OBS-1178 (D-470): a decision binds to the park open when it was COMMANDED, not when it lands.
describe("tickmarkr approve — park-bound decisions (OBS-1178, zero-token)", () => {
  test("test: two queued approvals bind the first review park and refuse its stale second waive after a new test park opens, versus applying a matching review waive, so waiving the newer test fails", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const runId = "run-queued-waives";
    const j = Journal.create(repo, runId);
    j.append("gate-result", "T1", { gate: "review", pass: false, details: "reviewer requested changes" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "review park" });
    const lineOf = (event: string): string => {
      const { events, lines } = j.readSourced();
      const i = events.map((e) => e.event).lastIndexOf(event);
      return bindingToken({ line: lines[i]!, ts: events[i]!.ts });
    };
    const reviewPark = lineOf("task-human");

    // Both decisions are commanded while the review park is open, each queued behind the serializer.
    // The first lands and applies: a matching review waive bound to the review park.
    const held = await acquireApprovalSerialization(repo, runId);
    const first = approve([runId, "T1", "--waive", "--by", "operator"], repo);
    held.release();
    await expect(first).resolves.toContain("waived failed gate review");
    // The second (a standing order) is commanded against that same review park and queues…
    const heldAgain = await acquireApprovalSerialization(repo, runId);
    const second = approve([runId, "T1", "--waive", "--by", "standing-order"], repo);
    const settled = second.then(() => "appended", (e: Error) => e.message);
    // …while the daemon enacts the first and a new TEST park opens.
    j.append("worktree-recreation", "T1", {});
    j.append("gate-result", "T1", { gate: "test", pass: false, details: "1 failed" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "test park" });
    const testPark = lineOf("task-human");
    heldAgain.release();
    // Revalidated under serialization, the queued waive is stale: it never lands on the test park.
    expect(await settled).toBe(`refusing stale decision for T1: bound to park ${reviewPark} but the open park is ${testPark} — read \`tickmarkr status ${runId}\` and decide the open park; nothing appended`);
    // The explicit re-issue of that same stale token names both parks and appends nothing.
    await expect(approve([runId, "T1", "--waive", "--park", reviewPark, "--by", "standing-order"], repo))
      .rejects.toThrow(`bound to park ${reviewPark} but the open park is ${testPark}`);

    const approvals = j.read().filter((e) => e.event === "task-approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.data).toMatchObject({ by: "operator", release: "gate-satisfied", gate: "review", park: { line: Number(reviewPark.split("@")[0]) } });
    expect(j.replaySatisfiedGates().get("T1")).toBeUndefined(); // the newer test gate is NOT waived
    expect(j.replayStatuses().get("T1")).toBe("human");

    // A stale waive written past the CLI (e.g. a racing writer) is refused again before enactment: the
    // daemon's revalidation names it, its refusal row consumes it, and the test gate stays red.
    j.append("task-approved", "T1", { by: "standing-order", via: "cli", release: "gate-satisfied", gate: "review", park: approvals[0]!.data.park });
    const refused = staleApprovals(j.read());
    expect(refused.get("T1")?.reason).toContain(`bound to park ${reviewPark} but the newest park is ${testPark}`);
    // an unrelated task row landing between the decision and its refusal must not let the decision stand
    j.append("worktree-preserved", "T1", { ref: `refs/tickmarkr/preserved/${runId}--T1` });
    j.append(APPROVAL_REFUSED, "T1", { reason: refused.get("T1")!.reason, lines: refused.get("T1")!.lines });
    expect(j.replaySatisfiedGates().get("T1")).toBeUndefined();
    expect(j.replayStatuses().get("T1")).toBe("human");

    // Versus: the matching decision on the open test park applies, bound to that park.
    await expect(approve([runId, "T1", "--waive", "--park", testPark, "--gate", "test", "--by", "operator"], repo))
      .resolves.toContain("waived failed gate test");
    const bound = j.read().filter((e) => e.event === "task-approved").at(-1)!;
    expect(bound.data).toMatchObject({ release: "gate-satisfied", gate: "test", park: { line: Number(testPark.split("@")[0]) } });
    expect(staleApprovals(j.read()).size).toBe(0);
    expect(j.replaySatisfiedGates().get("T1")).toBe("test");
  });

  test("a bound waiver requires an explicit recognized gate failed by its own park", () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    for (const gate of [undefined, "unknown", "test"]) {
      const j = Journal.create(repo, `run-invalid-waive-${gate ?? "missing"}`);
      j.append("gate-result", "T1", { gate: "test", pass: false, details: "1 failed" });
      j.append("task-human", "T1", { kind: "gate-fail" });
      j.append("task-human", "T1", { kind: "infra" });
      j.append("task-approved", "T1", { release: "gate-satisfied", ...(gate === undefined ? {} : { gate }), park: j.newestBinding("T1") });
      const line = j.readSourced().lines.at(-1)!;
      expect(effectiveDecisions(j.read()).has(line)).toBe(false);
      expect(staleApprovals(j.read()).get("T1")?.lines).toEqual([line]);
      expect(j.replayStatuses().get("T1")).toBe("human");
      expect(j.replaySatisfiedGates().get("T1")).toBeUndefined();
      expect(journaledFailureBrief(j.read(), "T1")).toEqual(["test: 1 failed"]);
      j.append("worktree-recreation", "T1", {});
      expect(effectiveDecisions(j.read()).has(line)).toBe(false);
      expect(journaledFailureBrief(j.read(), "T1")).toEqual(["test: 1 failed"]);
    }
  });

  test("every open decision is judged: an unbound review waive followed by a bound recheck of the same park refuses, so review is never satisfied; a lone bound recheck stands", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const runId = "run-open-decisions";
    const j = Journal.create(repo, runId);
    j.append("task-dispatch", "T1", { attempt: 0 });
    j.append("gate-result", "T1", { gate: "review", pass: false, details: "reviewer requested changes" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "review park" });
    const park = j.newestBinding("T1")!;
    // An unbound review waive lands, then a recheck correctly bound to P (the newest row).
    j.append("task-approved", "T1", { by: "racer", via: "cli", release: "gate-satisfied", gate: "review" });
    j.append("task-approved", "T1", { by: "operator", via: "cli", release: "recheck", park });
    const refused = staleApprovals(j.read());
    expect(refused.get("T1")?.reason).toMatch(/^#L\d+ an unbound decision names no park token/u);
    j.append(APPROVAL_REFUSED, "T1", { reason: refused.get("T1")!.reason, lines: refused.get("T1")!.lines });
    expect(j.replaySatisfiedGates().get("T1")).toBeUndefined(); // the refusal voids the unbound waive
    expect(refused.get("T1")!.lines).toHaveLength(1); // only the unbound waive is named…
    expect(staleApprovals(j.read()).size).toBe(0); // …the bound recheck survives its refusal
    expect(j.replayStatuses().get("T1")).toBe("pending"); // released by that sound recheck alone, with review unsatisfied
    // Versus: one bound recheck alone on the same park is judged sound.
    j.append("task-approved", "T1", { by: "operator", via: "cli", release: "recheck", park });
    expect(staleApprovals(j.read()).size).toBe(0);
  });

  test("an unenacted waive stays open across a newer park, so it is refused rather than carried into a recheck bound to the new park", () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const runId = "run-unenacted-across-park";
    const j = Journal.create(repo, runId);
    j.append("task-dispatch", "T1", { attempt: 0 });
    j.append("gate-result", "T1", { gate: "review", pass: false, details: "reviewer requested changes" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "review park P" });
    j.append("task-approved", "T1", { by: "racer", via: "cli", release: "gate-satisfied", gate: "review" }); // unbound, never enacted
    j.append("task-human", "T1", { kind: "gate-fail", reason: "park Q" });
    j.append("task-approved", "T1", { by: "operator", via: "cli", release: "recheck", park: j.newestBinding("T1") });
    const refused = staleApprovals(j.read());
    expect(refused.get("T1")?.reason).toMatch(/an unbound decision names no park token/u);
    j.append(APPROVAL_REFUSED, "T1", { reason: refused.get("T1")!.reason, lines: refused.get("T1")!.lines });
    expect(j.replaySatisfiedGates().get("T1")).toBeUndefined(); // review is never carried into Q's recheck
    expect(refused.get("T1")!.lines).toHaveLength(1);
    expect(j.replayStatuses().get("T1")).toBe("pending"); // Q's sound recheck alone releases the park
  });

  test("a park-bound decision is stale once the task fails after its park; a refused failed-task recheck keeps the failure token", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const runId = "run-failed-after-park";
    const j = Journal.create(repo, runId);
    j.append("task-dispatch", "T1", { attempt: 0 });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "park" });
    j.append("task-approved", "T1", { by: "operator", via: "cli", park: j.newestBinding("T1") });
    j.append("task-failed", "T1", { error: "worker died" });
    const staleApprove = staleApprovals(j.read()).get("T1")!;
    expect(staleApprove.reason).toMatch(/but the task failed since/u);
    j.append(APPROVAL_REFUSED, "T1", { reason: staleApprove.reason, lines: staleApprove.lines });
    j.append("task-approved", "T1", { by: "racer", via: "cli", release: "recheck" }); // unbound recheck
    const why = staleApprovals(j.read()).get("T1")!;
    expect(why.reason).toMatch(/unbound decision/u);
    j.append(APPROVAL_REFUSED, "T1", { reason: why.reason, lines: why.lines });
    const failure = j.newestBinding("T1", "task-failed")!;
    const { status } = await import("../../src/cli/commands/status.js");
    expect(await status([runId], repo)).toContain(`failed — T1 — failure ${bindingToken(failure)}`);
  });

  // D-514: ONE fold decides whether a decision happened, keyed by physical journal line. Every consumer
  // of task-approved rows must agree with it for every binding, park shape, refusal and blank line.
  test("every decision consumer agrees with the one physical-line fold across {bound, unbound, stale} x {same park, new park, failed task, scope-request} x {refused, not} x {blank line before, not}", async () => {
    const { repo } = setupRepo([T("T1", { files: ["src/a.ts"] })], { tasks: {} });
    const graph = loadGraph(repo);
    const task = graph.tasks[0]!;
    const amended = { ...graph, tasks: [{ ...task, files: [...task.files, "src/b.ts"] }] };
    const amendment = { from: graphDefinitionHash(graph), to: graphDefinitionHash(amended), beforeFiles: task.files, files: amended.tasks[0]!.files, definition: taskDefinitionFingerprint(task) };
    const seat = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
    let run = 0;
    for (const binding of ["bound", "unbound", "stale"] as const) {
      for (const shape of ["same park", "new park", "failed task", "scope-request"] as const) {
        for (const refused of [false, true]) {
          for (const blank of [false, true]) {
            const label = `${binding} / ${shape} / ${refused ? "refused" : "not refused"} / ${blank ? "blank line before" : "no blank line"}`;
            const runId = `run-agree-${run++}`;
            const j = Journal.create(repo, runId);
            const newest = (event: string): DecisionBinding => {
              const { events, lines } = j.readSourced();
              const i = events.map((e) => e.event).lastIndexOf(event);
              return { line: lines[i]!, ts: events[i]!.ts };
            };
            j.append("run-start", undefined, { graphDefinitionHash: amendment.from });
            j.append("task-dispatch", "T1", { assignment: seat, attempt: 0 });
            const dispatch = newest("task-dispatch");
            if (blank) appendFileSync(j.journalPath, "\n\n"); // physical lines now run ahead of row indexes
            if (shape === "failed task") j.append("task-failed", "T1", { error: "worker died" });
            else {
              if (shape !== "scope-request") j.append("gate-result", "T1", { gate: "review", pass: false, details: "changes requested", commit: "c1" });
              j.append("task-human", "T1", { kind: shape === "scope-request" ? "scope-request" : "gate-fail", reason: "parked" });
            }
            const open = newest(shape === "failed task" ? "task-failed" : "task-human");
            const named = binding === "bound" ? open : binding === "stale" ? dispatch : undefined;
            const release = shape === "failed task" ? { release: "recheck" } : shape === "scope-request"
              ? { release: "scope-request", amendment: { ...amendment, parkLine: open.line } }
              : { release: "gate-satisfied", gate: "review" };
            j.append("task-approved", "T1", { by: "op", via: "cli", ...release, ...(named ? { [shape === "failed task" ? "failure" : "park"]: named } : {}) });
            const decision = newest("task-approved").line;
            if (shape === "new park") {
              j.append("gate-result", "T1", { gate: "test", pass: false, details: "1 failed", commit: "c1" });
              j.append("task-human", "T1", { kind: "gate-fail", reason: "newer park" });
            }
            if (refused) j.append(APPROVAL_REFUSED, "T1", { reason: "refused before enactment", lines: [decision] });

            const took = binding === "bound" && shape !== "new park" && !refused;
            const events = j.read();
            expect(effectiveDecisions(events).has(decision), label).toBe(took);
            expect(j.replayStatuses().get("T1"), label).toBe(took ? "pending" : shape === "failed task" ? "failed" : "human");
            expect(j.replaySatisfiedGates().get("T1"), label).toBe(took && shape === "same park" ? "review" : undefined);
            expect(j.replayResumeState().get("T1")?.lastAssignment === undefined, label).toBe(took && shape === "failed task");
            expect(pendingApprovalActions(events).has("T1"), label).toBe(took);
            expect(pendingDaemonApprovalActions(events).has("T1"), label).toBe(took);
            expect(pendingRechecks(events).has("T1"), label).toBe(took && shape === "failed task");
            // run-end reports answers, not effects: every decision not refused is still unanswered here
            expect(outstandingApprovals(events).includes("T1"), label).toBe(!refused);
            expect(staleApprovals(events).has("T1"), label).toBe(!took && !refused);
            const scoped = took && shape === "scope-request";
            expect(applyScopeAmendments(graph, j).tasks[0]!.files, label).toEqual(scoped ? amendment.files : task.files);
            expect(recordedGraphDefinitionHash(j.read()), label).toBe(scoped ? amendment.to : amendment.from);
            if (shape === "failed task") {
              expect((await status([runId], repo)).includes(`failure ${bindingToken(open)}`), label).toBe(!took);
            } else if (shape !== "scope-request") {
              const preview = previewDecision({ verb: "waive", taskId: "T1" }, { cwd: repo, runId, by: "op" });
              expect(preview.ok ? "open" : preview.refusal, label).toMatch(took ? /was already released at #L/u : /^open$/u);
            }
          }
        }
      }
    }
  });

  test("an unbound review waive superseded by a newer park never takes effect, even once a recheck bound to that park is enacted, so review is never carried into the recheck", () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-superseded-waive");
    j.append("task-dispatch", "T1", { attempt: 0 });
    j.append("gate-result", "T1", { gate: "review", pass: false, details: "changes requested", commit: "X" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "review park P" });
    j.append("task-approved", "T1", { by: "racer", via: "cli", release: "gate-satisfied", gate: "review" });
    const waive = j.readSourced().lines.at(-1)!;
    j.append("task-human", "T1", { kind: "infra", reason: "park Q" });
    j.append("task-approved", "T1", { by: "operator", via: "cli", release: "recheck", park: j.newestBinding("T1") });
    const recheck = j.readSourced().lines.at(-1)!;
    j.append("recheck-battery", "T1", { pass: true });
    const effective = effectiveDecisions(j.read());
    expect(effective.has(waive)).toBe(false);
    expect(effective.has(recheck)).toBe(true);
    expect(j.replaySatisfiedGates(new Map([["T1", "X"]])).get("T1")).toBeUndefined();
  });

  test("a refused approval resets no execution budget: review rounds, identical-failure counts, repair history and the retry ban stand, versus a bound recheck that opens a new engagement", () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-refused-budgets");
    j.append("task-dispatch", "T1", { attempt: 0 });
    j.append("gate-result", "T1", { gate: "review", pass: false, details: "changes requested" });
    j.append("repair-attempt", "T1", { repair: 1, gates: ["test"] });
    j.append("worker-launch", "T1", {});
    j.append("gate-result", "T1", { gate: "test", pass: false, details: "FAIL a.test.ts" });
    j.append("gate-result", "T1", { gate: "test", pass: false, details: "FAIL a.test.ts" });
    j.append("gate-fingerprint-cap", "T1", { gate: "test", channel: "fake:fake-1" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "fingerprint cap" });
    const budgets = () => {
      const events = j.read();
      return {
        reviewRounds: reviewRoundsSinceApproval(events, "T1"),
        identical: identicalGateFailures(events, "T1", "test", normalizeGateFailure("FAIL a.test.ts")),
        repairs: repairsSinceApproval(events, "T1"),
        reach: repairReachSinceApproval(events, "T1").length,
        ban: activeRetryBan(events, "T1", "fake:fake-1"),
      };
    };
    const spent = { reviewRounds: 1, identical: 2, repairs: 1, reach: 1, ban: "test" };
    expect(budgets()).toEqual(spent);
    // An unbound recheck, then one bound to a park that is no longer open: both refused, neither resets a budget.
    const park = j.newestBinding("T1")!;
    j.append("task-approved", "T1", { by: "racer", via: "cli", release: "recheck" });
    j.append("task-approved", "T1", { by: "racer", via: "cli", release: "recheck", park: { line: park.line - 1, ts: park.ts } });
    expect(budgets()).toEqual(spent); // not yet refused: unsound decisions are no engagement either
    const refused = staleApprovals(j.read()).get("T1")!;
    expect(refused.lines).toHaveLength(2);
    j.append(APPROVAL_REFUSED, "T1", { reason: refused.reason, lines: refused.lines });
    expect(budgets()).toEqual(spent);
    // Versus: the recheck bound to the open park is an effective decision — a new engagement.
    j.append("task-approved", "T1", { by: "operator", via: "cli", release: "recheck", park });
    expect(budgets()).toEqual({ reviewRounds: 0, identical: 0, repairs: 0, reach: 0, ban: undefined });
  });

  test("a refused recheck leaves status, the cockpit fold and the live board reading the park with its failed gate evidence at its physical line", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const runId = "run-refused-surfaces";
    const j = Journal.create(repo, runId);
    j.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(loadGraph(repo)), pid: 999_999_999 });
    j.append("task-dispatch", "T1", { attempt: 0, assignment: { adapter: "fake", model: "fake-1" } });
    j.append("gate-result", "T1", { gate: "test", pass: false, details: "1 failed" });
    const gateLine = j.readSourced().lines.at(-1)!;
    j.append("task-human", "T1", { kind: "gate-fail", reason: "test red" });
    j.append("run-end", undefined, { done: [], failed: [], human: ["T1"], blocked: [], pending: [], tipVerify: "not required" });
    appendFileSync(j.journalPath, "\n"); // physical lines now run ahead of row indexes
    j.append("task-approved", "T1", { by: "racer", via: "cli", release: "recheck" }); // unbound
    const refused = staleApprovals(j.read()).get("T1")!;
    j.append(APPROVAL_REFUSED, "T1", { reason: refused.reason, lines: refused.lines });
    expect(j.replayStatuses().get("T1")).toBe("human");

    // status and every capture reader fold the cockpit rows over the decided journal
    const raw = readFileSync(j.journalPath, "utf8");
    expect(deriveRunCockpitData({ fileName: `${runId}.journal.jsonl`, raw }, "test").taskRows.find((r) => r.taskId === "T1"))
      .toMatchObject({ state: "human", parkKind: "gate-fail" });
    const shown = (await status([runId], repo)).split("\n").find((line) => /\bT1\b/u.test(line) && /\[.\]/u.test(line))!;
    expect(shown).toMatch(/\bparked \(gate-fail\)/u);
    expect(shown).not.toMatch(/\bpending\b/u);

    // the live board: the store's incremental fold reads the refused row as a release; the decided store does not
    const store = createLiveStore({ cwd: repo, runId });
    try {
      expect(store.snapshot().operator.tasks.find((t) => t.id === "T1")!.state).toBe("pending");
      const board = decidedLiveStore(store).snapshot().operator;
      const task = board.tasks.find((t) => t.id === "T1")!;
      expect(task.state).toBe("human");
      expect(task.parkKind).toBe("gate-fail");
      expect(task.gates.test).toMatchObject({ state: "failed", evidence: { line: gateLine, id: `${j.journalPath}#L${gateLine}` } });
      expect(board.approvedResumeRequired).toBe(false);
      expect(board.label).not.toBe("approved; resume required");
    } finally { store.dispose(); }

    // A later run-end restores the park on the raw fold, but not the gate evidence the refused recheck
    // erased there: the decided board keeps it whatever state the raw fold shows.
    j.append("run-end", undefined, { done: [], failed: [], human: ["T1"], blocked: [], pending: [], tipVerify: "not required" });
    const ended = createLiveStore({ cwd: repo, runId });
    try {
      const rawTask = ended.snapshot().operator.tasks.find((t) => t.id === "T1")!;
      expect(rawTask.state).toBe("human");
      expect(rawTask.gates.test?.state).not.toBe("failed");
      expect(decidedLiveStore(ended).snapshot().operator.tasks.find((t) => t.id === "T1")!.gates.test)
        .toMatchObject({ state: "failed", evidence: { line: gateLine } });
    } finally { ended.dispose(); }
  });

  test("an enacted decision consumes its park: a second approval bound to that park after the task completed is stale and never resurrects the task", () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-consumed-park");
    j.append("gate-result", "T1", { gate: "review", pass: false, details: "changes requested" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "review park" });
    const park = j.newestBinding("T1")!;
    j.append("task-approved", "T1", { by: "operator", via: "cli", park });
    j.append("task-dispatch", "T1", { attempt: 1 });
    j.append("task-done", "T1", {});
    const enacted = j.readSourced().lines[2]!;
    j.append("task-approved", "T1", { by: "late", via: "cli", park });
    const late = j.readSourced().lines.at(-1)!;
    const { effective, open } = foldDecisions(j.read());
    expect(effective.has(enacted)).toBe(true); // the enacted decision stays effective
    expect(effective.has(late)).toBe(false);
    expect(open).toEqual([expect.objectContaining({ taskId: "T1", line: late, stale: expect.stringContaining("newest park is none") })]);
    expect(staleApprovals(j.read()).get("T1")?.lines).toEqual([late]);
    expect(j.replayStatuses().get("T1")).toBe("done");
  });
});
