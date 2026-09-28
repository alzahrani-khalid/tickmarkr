// Phase 47 (GATE-09): daemon-level incident analog — the judge-flake-billed-as-worker-attempt defect.
// Vendored incident shape: tests/fixtures/journal-corpus/run-20260711-185020.jsonl:65-72 (P43-03):
// four gates GREEN → acceptance "judge output unparseable — failing closed" → escalation step:retry
// attempt:2 → task-dispatch attempt:2 (the WORKER re-dispatched for a judge flake).
// This test reproduces the shape in-suite through the REAL runDaemon (zero tokens, FakeAdapter):
// a garbage-then-good judge script. ON UNFIXED HEAD: two task-dispatches + an escalation event;
// AFTER THE FIX: one dispatch, zero escalations, task-done — the judge was retried, the worker never billed.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../src/adapters/types.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { judgmentSubjectKey } from "../../src/gates/run-gates.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { runDaemon } from "../../src/run/daemon.js";
import { authedModels, COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

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

// T7 (OBS-1151 add.1): the contradiction key is PER CRITERION over the files its verdict cites, plus the
// canonical criterion, the task's declared bounds and the operator context — never the whole task diff.
// A resume over a journaled earlier judgment keeps comparing on those keys.
describe("per-criterion cited-file judgment keys across resume (production daemon, zero tokens)", () => {
  class Judge extends FakeAdapter {
    calls = 0;
    constructor(path: string, public override id: string, private met: boolean[], private tier: BillingChannel["tier"] = "frontier") {
      super(path);
      this.vendor = id;
    }
    override async probe() {
      return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
    }
    override channels(): BillingChannel[] {
      return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: this.tier }];
    }
    override headlessCommand(file: string): string {
      const prompt = readFileSync(file, "utf8");
      const nonce = /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)?.[1] ?? "";
      if (prompt.startsWith("TICKMARKR-REVIEW")) {
        const carried = [...prompt.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]!);
        return `printf '%s' ${shq(JSON.stringify({ nonce, approve: true, resolved: carried, reraised: [], findings: [] }))}`;
      }
      if (!prompt.startsWith("TICKMARKR-JUDGE")) return "true";
      const met = this.met[Math.min(this.calls++, this.met.length - 1)]!;
      return `printf '%s' ${shq(JSON.stringify({ nonce, pass: met, criteria: [{ criterion: "c1", met, reason: "a.txt", evidence: { path: "a.txt", line: 1 } }] }))}`;
    }
  }
  class CheapAuthor extends FakeAdapter {
    override channels(): BillingChannel[] { return [{ ...super.channels()[0]!, tier: "cheap" }]; }
  }
  const write = (files: Record<string, string>, msg: string) => ({
    shell: `${Object.entries(files).map(([p, c]) => `printf '%s\\n' ${shq(c)} > ${p}`).join(" && ")} && ${COMMIT} ${msg}`,
    result: { ok: true, summary: msg },
  });

  // Seeds an earlier PASS of c1 over a.txt = "A", b.txt = "old" (its key built from `prior`), then resumes:
  // the worker writes `wrote`, the primary judge now FAILs c1 citing a.txt, and the distinct judge would
  // side with the earlier PASS — so a detected contradiction parks, and an undetected one is simply fresh.
  async function resumeOver(runId: string, wrote: Record<string, string>, prior: { criterion?: string; files?: string[]; operatorContext?: string } = {}) {
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [write(wrote, "w0"), write({ "a.txt": "A-fixed" }, "w1")] }, consult: { action: "retry", notes: "fix it" } });
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), [
      "concurrency: 1", "routing:", "  escalateTier: \"off\"", "  floors: { implement: cheap }",
      "judge: { adapter: judge-a, model: judge-a }", "consult: { adapter: fake, model: fake-1 }",
      "review: { required: true, prefer: [seat-r], timeoutMs: 5000 }", "",
    ].join("\n"));
    const env = { ...process.env, GIT_INDEX_FILE: join(repo, ".git", "prior-index") };
    const git = (args: string, input?: string) => execSync(`git ${args}`, { cwd: repo, encoding: "utf8", env, input }).trim();
    git("read-tree HEAD");
    for (const [path, content] of Object.entries({ "a.txt": "A", "b.txt": "old" })) {
      git(`update-index --add --cacheinfo 100644,${git("hash-object -w --stdin", `${content}\n`)},${path}`);
    }
    const commit = git(`commit-tree ${git("write-tree")} -p HEAD -m prior`);
    git(`update-ref refs/tickmarkr/test-prior ${commit}`);
    const task = loadGraph(repo).tasks[0]!;
    const key = judgmentSubjectKey({ ...task, ...(prior.files ? { files: prior.files } : {}) }, prior.criterion ?? "done", prior.operatorContext);
    const journal = Journal.create(repo, runId);
    journal.append("run-start", undefined, { baseRef: await gitHead(repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    journal.append("gate-result", "T1", { gate: "acceptance", pass: true, details: "✓ c1: a.txt",
      judgment: { commit, judge: "judge-z:judge-z", criteria: [{ id: "c1", key, met: true, paths: ["a.txt"] }] } });
    writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    const second = new Judge(scriptPath, "judge-b", [true]);
    const summary = await runDaemon(repo, { runId, resume: true, adapters: [
      new CheapAuthor(scriptPath), new Judge(scriptPath, "judge-a", [false, true]), second, new Judge(scriptPath, "seat-r", [true], "mid"),
    ] });
    const rows = Journal.open(repo, runId).read().filter((row) => row.taskId === "T1");
    return { summary, second, disagreements: rows.filter((row) => row.event === "judge-disagreement"), dispatches: rows.filter((row) => row.event === "task-dispatch") };
  }

  test("production judging compares identical cited-file keys across resume despite changes to unrelated task files but treats changed cited blobs criteria bounds or operator context as fresh, so a whole-diff key hiding a contradiction fails", async () => {
    // Only b.txt changed: the whole diff differs, the cited a.txt does not — the reversal is caught.
    const same = await resumeOver("run-key-same", { "a.txt": "A", "b.txt": "new" });
    expect(same.disagreements).toHaveLength(1);
    expect(same.disagreements[0]!.data).toMatchObject({ disputed: [expect.objectContaining({ id: "c1", paths: ["a.txt"] })] });
    expect(same.second.calls).toBe(1);
    expect(same.summary.human).toEqual(["T1"]);
    expect(same.dispatches).toHaveLength(1);
    // A changed cited blob, criterion, declared bounds or operator context is a new subject: judged fresh.
    for (const [runId, wrote, prior] of [
      ["run-key-blob", { "a.txt": "A2", "b.txt": "old" }, {}],
      ["run-key-criterion", { "a.txt": "A", "b.txt": "new" }, { criterion: "done, as first worded" }],
      ["run-key-bounds", { "a.txt": "A", "b.txt": "new" }, { files: ["elsewhere/**"] }],
      ["run-key-context", { "a.txt": "A", "b.txt": "new" }, { operatorContext: "- an earlier ruling" }],
    ] as const) {
      const fresh = await resumeOver(runId, wrote, prior);
      expect(fresh.disagreements, runId).toEqual([]);
      expect(fresh.second.calls, runId).toBe(0);
      expect(fresh.summary.done, runId).toEqual(["T1"]);
      expect(fresh.dispatches, runId).toHaveLength(2);
    }
  });
}, 120000);
