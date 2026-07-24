// Phase 47 (GATE-09): daemon-level incident analog — the judge-flake-billed-as-worker-attempt defect.
// Vendored incident shape: tests/fixtures/journal-corpus/run-20260711-185020.jsonl:65-72 (P43-03):
// four gates GREEN → acceptance "judge output unparseable — failing closed" → escalation step:retry
// attempt:2 → task-dispatch attempt:2 (the WORKER re-dispatched for a judge flake).
// This test reproduces the shape in-suite through the REAL runDaemon (zero tokens, FakeAdapter):
// a garbage-then-good judge script. ON UNFIXED HEAD: two task-dispatches + an escalation event;
// AFTER THE FIX: one dispatch, zero escalations, task-done — the judge was retried, the worker never billed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Journal } from "../../src/run/journal.js";
import { runDaemon } from "../../src/run/daemon.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

describe("GATE-09 judge-flake attribution (daemon level, fake adapter, zero tokens)", () => {
  test("garbage-then-good judge: one dispatch, zero escalations, task-done (SC-1)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      {
        // the incident: judge serves garbage on the first call, a clean pass on the retry
        judge: ["judge output garbage — not a verdict", { pass: true, criteria: [{ criterion: "c1", met: true, reason: "r" }] }],
        review: { approve: true, issues: [] },
        tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-g09-flake" });
    expect(s.done).toEqual(["T1"]);

    const evs = Journal.open(repo, "run-g09-flake").read();
    // AFTER THE FIX: exactly ONE task-dispatch — the judge was retried inside runGates, the worker was
    // never billed a second attempt. ON UNFIXED HEAD: two task-dispatches (attempt 0 + attempt 1).
    expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
    // AFTER THE FIX: ZERO escalation events — no gate failure reached the daemon's attempt loop.
    // ON UNFIXED HEAD: an escalation step:retry event (the worker billed for the judge's flake).
    expect(evs.filter((e) => e.event === "escalation")).toHaveLength(0);
    // the task completed
    expect(evs.some((e) => e.event === "task-done" && e.taskId === "T1")).toBe(true);
    // exactly one acceptance gate-result and it passes (the retried verdict)
    const acc = evs.filter((e) => e.event === "gate-result" && (e.data as { gate?: string }).gate === "acceptance");
    expect(acc).toHaveLength(1);
    expect((acc[0].data as { pass: boolean }).pass).toBe(true);

    // GATE-09 SC-4 (RED on HEAD): the judge retry is an attributable journal event naming the gate, the
    // flaked channelKey, and the retry channelKey — `tickmarkr journal` can distinguish "judge flaked,
    // retried" from "worker failed". ON UNFIXED HEAD: zero judge-retry events (the retry is invisible).
    const jr = evs.filter((e) => e.event === "judge-retry" && e.taskId === "T1");
    expect(jr).toHaveLength(1);
    // no secondUnparseable: the retry produced a parseable pass (only double-garbage sets the flag)
    expect(jr[0].data).toMatchObject({
      gate: "acceptance",
      flaked: "fake:fake-1",
      retried: "fake:fake-2",
      transcript: expect.stringContaining("judge output garbage — not a verdict"),
    });
    // ordering pin: attribution precedes the verdict in the stream (judge-retry BEFORE acceptance gate-result)
    const jrIdx = evs.findIndex((e) => e.event === "judge-retry" && e.taskId === "T1");
    const accIdx = evs.findIndex((e) => e.event === "gate-result" && (e.data as { gate?: string }).gate === "acceptance");
    expect(jrIdx).toBeGreaterThanOrEqual(0);
    expect(accIdx).toBeGreaterThan(jrIdx);
  });

  test("double-garbage judge: worker escalates exactly as today — fail-closed intact (daemon SC-2)", async () => {
    // Two garbage verdicts fail the gate closed; the daemon escalates the worker (the retry did NOT
    // manufacture a pass). This is today's semantics, preserved. Each worker attempt re-runs gates, so
    // multiple acceptance gate-results appear — the pin is that NONE of them is a pass.
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      {
        judge: ["garbage one", "garbage two"],
        consult: { action: "human", notes: "judge keeps flaking" },
        tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-g09-double" });
    // the double-garbage acceptance fail eventually parks via the ladder (consult → human)
    expect(s.human).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-g09-double").read();
    // EVERY acceptance gate-result is pass:false — fail-closed, no garbage²→pass path, at any attempt
    const acc = evs.filter((e) => e.event === "gate-result" && (e.data as { gate?: string }).gate === "acceptance");
    expect(acc.length).toBeGreaterThanOrEqual(1);
    for (const a of acc) {
      expect((a.data as { pass: boolean }).pass).toBe(false);
      expect((a.data as { details: string }).details).toMatch(/unparseable — failing closed/);
    }
    // GATE-09 SC-4 (RED on HEAD): the judge retry is journaled even when the retry ALSO flaked —
    // double-garbage is distinguishable via secondUnparseable:true WITHOUT correlating events. The flag
    // is derived from the final result's meta.unparseable alongside judgeRetry.
    const jr = evs.filter((e) => e.event === "judge-retry" && e.taskId === "T1");
    expect(jr.length).toBeGreaterThanOrEqual(1);
    for (const j of jr) {
      expect((j.data as { gate?: string }).gate).toBe("acceptance");
      expect((j.data as { secondUnparseable?: boolean }).secondUnparseable).toBe(true);
    }
  });

  // GATE-09 SC-4 absence pin: no judge flake ⇒ no judge-retry event. GREEN on HEAD by vacuity (zero
  // events are ever emitted today); reddens ONLY if the daemon append condition ever widens past the
  // acceptance-unparseable-retry case. A parseable pass:false is NOT a flake (SC-3 fence) — no retry.
  test("no judge flake → no judge-retry event (clean pass and parseable fail)", async () => {
    // clean pass: a parseable pass on the first call — no flake, no retry, no event
    const clean = setupRepo(
      [T("T1", { complexity: 8 })],
      {
        judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "r" }] },
        review: { approve: true, issues: [] },
        tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] },
      },
    );
    const cs = await runDaemon(clean.repo, { adapters: [clean.fake], runId: "run-g09-clean" });
    expect(cs.done).toEqual(["T1"]);
    expect(Journal.open(clean.repo, "run-g09-clean").read().filter((e) => e.event === "judge-retry")).toHaveLength(0);

    // parseable fail: a parseable pass:false is NOT a flake — no retry, no event (SC-3 fence)
    const pf = setupRepo(
      [T("T1", { complexity: 8 })],
      {
        judge: { pass: false, criteria: [{ criterion: "c1", met: false, reason: "not done" }] },
        consult: { action: "human", notes: "parseable fail" },
        tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] },
      },
    );
    const ps = await runDaemon(pf.repo, { adapters: [pf.fake], runId: "run-g09-pfail" });
    expect(ps.human).toEqual(["T1"]);
    expect(Journal.open(pf.repo, "run-g09-pfail").read().filter((e) => e.event === "judge-retry")).toHaveLength(0);
  });

  test("a verdict that fails to parse journals the redacted judge transcript alongside the flake record", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      {
        judge: ["judge emitted prose instead of a verdict", { pass: true, criteria: [{ criterion: "c1", met: true, reason: "r" }] }],
        review: { approve: true, issues: [] },
        tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] },
      },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-judge-transcript" });

    const flake = Journal.open(repo, "run-judge-transcript").read()
      .find((e) => e.event === "judge-retry" && e.taskId === "T1");
    expect(flake?.data.transcript).toContain("judge emitted prose instead of a verdict");
  });

  test("a parseable verdict captures no transcript so a healthy run grows no journal weight", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      {
        judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "r" }] },
        review: { approve: true, issues: [] },
        tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] },
      },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-judge-healthy" });

    const journal = Journal.open(repo, "run-judge-healthy");
    expect(JSON.stringify(journal.read())).not.toContain("transcript");
  });

  test("a captured transcript passes through the existing redaction seam before touching disk", async () => {
    const secret = "sk-ant-api03-AbCd1234EfGh5678IjKl";
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      {
        judge: [`judge leaked ANTHROPIC_API_KEY=${secret}`, { pass: true, criteria: [{ criterion: "c1", met: true, reason: "r" }] }],
        review: { approve: true, issues: [] },
        tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] },
      },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-judge-redacted" });

    const journal = Journal.open(repo, "run-judge-redacted");
    const persisted = readFileSync(join(journal.dir, "journal.jsonl"), "utf8");
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("sk-ant-[REDACTED]");
    expect(journal.read().find((e) => e.event === "judge-retry")?.data.transcript)
      .toContain("sk-ant-[REDACTED]");
  });

  test("telemetry gains a row for each judge invocation naming its channel and outcome", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      {
        judge: ["judge output garbage", { pass: true, criteria: [{ criterion: "c1", met: true, reason: "r" }] }],
        review: { approve: true, issues: [] },
        tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] },
      },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-judge-telemetry" });

    const rows = Journal.open(repo, "run-judge-telemetry").readJudgeTelemetry();
    expect(rows).toEqual([
      expect.objectContaining({ taskId: "T1", channel: "fake:fake-1", outcome: "failed" }),
      expect.objectContaining({ taskId: "T1", channel: "fake:fake-2", outcome: "done" }),
    ]);
  });
}, 120000);
