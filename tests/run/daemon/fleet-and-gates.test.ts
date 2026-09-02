import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { shq } from "../../../src/adapters/types.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { renderMarkdownRecord } from "../../../src/cli/commands/report.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { formatOwnedName } from "../../../src/drivers/types.js";
import { captureBaseline } from "../../../src/gates/baseline.js";
import { gatePaneName } from "../../../src/gates/llm.js";
import { graphDefinitionHash, loadGraph, saveGraph, tickmarkrDir } from "../../../src/graph/graph.js";
import { validateGraph } from "../../../src/graph/schema.js";
import { runDaemon, watchCommand } from "../../../src/run/daemon.js";
import { gitHead, shOk } from "../../../src/run/git.js";
import { journaledFailureBrief, Journal, reviewRoundsSinceApproval, runHasEnded } from "../../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";


async function seedGateSatisfiedResume(
  runId: string,
  opts: {
    gates: string[];
    priorResults: Array<{ gate: string; pass: boolean; fullSuite?: boolean; selectedTests?: string[] }>;
    script: object;
  },
) {
  const suiteLog = join(makeTestTempDir("tickmarkr-approved-suite-"), "suite.log");
  const testCmd = `printf 'argc=%s args=%s\\n' "$#" "$*" >> ${shq(suiteLog)}`;
  const { repo, fake } = setupRepo(
    [T("T1", { complexity: 8, files: ["**"], gates: opts.gates })],
    { tasks: {}, ...opts.script },
    `gates: { test: ${JSON.stringify(testCmd)} }\n`,
  );
  const baseRef = await gitHead(repo);
  const branch = `tickmarkr/${runId}`;
  const taskBranch = `${branch}--T1`;
  const driver = new SubprocessDriver();
  const priorWt = await driver.worktree(repo, taskBranch, baseRef);
  writeFileSync(join(priorWt, "work.txt"), "landed\n");
  await shOk("git add work.txt && git commit --no-gpg-sign -m work", priorWt);

  const commands = { test: testCmd };
  const baseline = await captureBaseline(repo, commands);
  writeFileSync(suiteLog, ""); // baseline execution is not part of the resumed gate round
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, {
    baseRef, commands, branch, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
  });
  journal.append("task-dispatch", "T1", {
    assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
    attempt: 0,
  });
  journal.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [] });
  journal.phaseStart("T1", "gates");
  for (const result of opts.priorResults) {
    journal.append("gate-result", "T1", {
      gate: result.gate, pass: result.pass, details: result.pass ? "passed" : "failed",
      ...(result.fullSuite === undefined ? {} : { fullSuite: result.fullSuite }),
      ...(result.selectedTests === undefined ? {} : { selectedTests: result.selectedTests }),
    });
  }
  journal.append("task-human", "T1", { reason: "gate failed", kind: "gate-fail" });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(baseline));
  await approve([runId, "T1", "--waive", "--by", "test"], repo);
  return { repo, fake, suiteLog };
}


describe("v1.85 gate-satisfied resume preserves parallel AND and full-suite authority", () => {
  test("approving review re-runs an unapproved failed acceptance sibling and cannot merge it", async () => {
    const runId = "run-approved-parallel-red";
    const { repo, fake, suiteLog } = await seedGateSatisfiedResume(runId, {
      gates: ["build", "test", "lint", "evidence", "scope", "acceptance", "review"],
      // The selected test screen passed, then BOTH parallel verdicts failed. Plain approval satisfies
      // the last one (review) only; acceptance remains red and must be asked again.
      priorResults: [
        { gate: "test", pass: true, selectedTests: ["tests/a.test.ts"] },
        { gate: "acceptance", pass: false },
        { gate: "review", pass: false },
      ],
      script: {
        judge: { pass: false, criteria: [{ criterion: "done", met: false, reason: "still red" }] },
        review: { approve: true, issues: [] },
      },
    });

    const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expect(summary.done).not.toContain("T1");
    expect(summary.human).toContain("T1");
    const events = Journal.open(repo, runId).read();
    const resumeAt = events.findLastIndex((e) => e.event === "run-resume");
    const post = events.slice(resumeAt + 1);
    expect(post.some((e) => e.event === "gate-result" && e.taskId === "T1"
      && e.data.gate === "acceptance" && e.data.pass === false)).toBe(true);
    expect(post.some((e) => e.event === "merge" && e.taskId === "T1")).toBe(false);
    expect(readFileSync(suiteLog, "utf8").trim().split("\n")).toContain("argc=0 args=");
  }, 60_000);

  test("approving acceptance after a selected-only screen forces a full test gate before merge", async () => {
    const runId = "run-approved-selected-screen";
    const { repo, fake, suiteLog } = await seedGateSatisfiedResume(runId, {
      gates: ["build", "test", "lint", "evidence", "scope", "acceptance", "review"],
      priorResults: [
        { gate: "test", pass: true, selectedTests: ["tests/a.test.ts"] },
        { gate: "acceptance", pass: false },
        { gate: "review", pass: true },
      ],
      script: { review: { approve: true, issues: [] } },
    });

    const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expect(summary.done).toContain("T1");
    const events = Journal.open(repo, runId).read();
    const resumeAt = events.findLastIndex((e) => e.event === "run-resume");
    const post = events.slice(resumeAt + 1);
    const testAt = post.findIndex((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "test");
    const mergeAt = post.findIndex((e) => e.event === "merge" && e.taskId === "T1");
    expect(testAt).toBeGreaterThanOrEqual(0);
    expect(mergeAt).toBeGreaterThan(testAt);
    expect(post[testAt]!.data.pass).toBe(true);
    // One full gate run plus the strict integration-tip verify. No filtered argv can appear here.
    expect(readFileSync(suiteLog, "utf8").trim().split("\n")).toEqual([
      "argc=0 args=",
      "argc=0 args=",
    ]);
  }, 60_000);
});


describe("SPEND-02/05 metered done rows (fake adapter, zero tokens)", () => {
  test("SPEND-02: scripted usage lands byte-exact on the done telemetry row", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" }, usage: { input: 1200, output: 340, cacheRead: 9000 } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-usage" });
    expect(s.done).toEqual(["T1"]);
    const row = Journal.open(repo, "run-usage").readTelemetry().find((r) => r.taskId === "T1")!;
    // the record's write-time stamp is >= this attempt's dispatch ⇒ passes the sinceMs cursor
    expect(row.tokens).toEqual({ input: 1200, output: 340, cacheRead: 9000 });
  });

  test("SPEND-05: a step without usage leaves NO tokens key on the raw telemetry line", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-nousage" });
    expect(s.done).toEqual(["T1"]);
    const line = readFileSync(join(tickmarkrDir(repo), "runs", "run-nousage", "telemetry.jsonl"), "utf8").trim();
    expect(/"tokens"/.test(line)).toBe(false); // absent on disk — reddens the moment anyone writes zeros
    expect(/"meteredAttempts"/.test(line)).toBe(false); // SPEND-02: no metered count without tokens (Test E)
  });

  // Test C — SPEND-02 accumulation across attempts. A failed metered attempt + a passing metered attempt
  // bill the SUM, with meteredAttempts counting them. The fake's per-attempt worktree store cannot show
  // the 3A+2B+C cumulative-reader bug (that's pinned in 17-03 against the real claude reader); this proves
  // the fold arithmetic + meteredAttempts, not the cursor.
  test("SPEND-02: usage accumulates across a failed+passing attempt (sum + meteredAttempts)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "committed nothing" }, usage: { input: 100, output: 10 } }, // evidence gate fails ⇒ retry
        { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "real work" }, usage: { input: 200, output: 20 } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-accum" });
    expect(s.done).toEqual(["T1"]);
    const row = Journal.open(repo, "run-accum").readTelemetry().find((r) => r.taskId === "T1")!;
    expect(row.attempts).toBe(2);
    expect(row.tokens).toEqual({ input: 300, output: 30 }); // NOT the last attempt's 200/20 — the sum
    expect(row.meteredAttempts).toBe(2);
  });

  test("HARD-08: daemon fails a task whose worker edits out of scope and declares it", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { files: ["src/**"], gates: ["build", "test", "lint", "evidence", "scope"] })],
      { tasks: {
        T1: [{
          shell: `mkdir -p src && echo in > src/ok.ts && echo oos > README.md && ${COMMIT} oos`,
          result: { ok: true, summary: "edited README out of scope", deviations: ["README.md"] },
        }],
      } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-h08-scope" });
    expect(s.done).toEqual([]);
    const evs = Journal.open(repo, "run-h08-scope").read();
    expect(evs.some((e) => e.event === "gate-result" && e.data.gate === "scope" && e.data.pass === false)).toBe(true);
  });

  // Test D — parked spend is still spend. A ladder-exhausted task carries the sum over its metered
  // attempts on the park row. attempts is read from the row so the assertion is ladder-length-agnostic.
  test("SPEND-02: a parked (ladder-exhausted) task carries accumulated usage on its park row", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: { action: "retry", notes: "keep trying" }, // consult never terminates → ladder runs to its human step
        tasks: { T1: [{ shell: "true", result: { ok: true, summary: "never commits" }, usage: { input: 50, output: 5 } }] }, // evidence fails every attempt
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-park-spend" });
    expect(s.human).toEqual(["T1"]);
    const row = Journal.open(repo, "run-park-spend").readTelemetry().find((r) => r.taskId === "T1")!;
    expect(row.outcome).toBe("human");
    expect(row.parkKind).toBe("ladder-exhausted");
    expect(row.attempts).toBeGreaterThanOrEqual(1);
    expect(row.tokens).toEqual({ input: 50 * row.attempts, output: 5 * row.attempts }); // parked spend is real spend
    expect(row.meteredAttempts).toBe(row.attempts);
  });
}, 120000);


// ── GATE-08: human gate approval (D-02 shape — journal event + replay mapping + the daemon guard) ──
// All three cases use ONLY HEAD-present API (Journal.append("task-approved", id, {...})) — no import of a
// not-yet-existing approve command — so they run and color RED against unfixed src while the rest stays green.
describe("GATE-08: human gate approval (fake adapter, zero tokens)", () => {
  test("GATE-08: an approved human gate dispatches and completes on resume", async () => {
    // THE ORACLE (D-06): humanGate task → run → PARKS → approval → resume → DISPATCHES AND COMPLETES.
    // RED on HEAD: replayStatuses has no approval concept, so T1 replays to "human" and the resume
    // quiesces with done=[] (readyTasks keeps only status==='pending'). GREEN needs BOTH the replay
    // mapping (task-approved → pending) AND the daemon guard consulting the approved set.
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    const s1 = await runDaemon(repo, { adapters: [fake], runId: "run-g08-oracle" });
    expect(s1.human).toEqual(["T1"]);
    expect(s1.done).toEqual([]);
    const j1 = Journal.open(repo, "run-g08-oracle").read();
    expect(j1.some((e) => e.event === "task-dispatch")).toBe(false); // parked, never dispatched

    // approval is a JOURNAL EVENT carrying who/when — never a graph.json mutation (D-02: recompile erases it)
    Journal.open(repo, "run-g08-oracle").append("task-approved", "T1", { by: "test" });

    const s2 = await runDaemon(repo, { adapters: [fake], runId: "run-g08-oracle", resume: true });
    expect(s2.done).toEqual(["T1"]); // RED on HEAD: [] — the approval takes effect
    expect(s2.human).toEqual([]);
    const j2 = Journal.open(repo, "run-g08-oracle").read();
    expect(j2.filter((e) => e.event === "task-dispatch" && e.taskId === "T1").length).toBeGreaterThanOrEqual(1);
    expect(j2.some((e) => e.event === "task-done" && e.taskId === "T1")).toBe(true);
  });

  test("GATE-08: an unapproved human gate stays parked while an approved one completes", async () => {
    // bucket assertion, NOT the guard pin: two independent humanGate tasks, approve only T1.
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true }), T("T2", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    const s1 = await runDaemon(repo, { adapters: [fake], runId: "run-g08-bucket" });
    expect(s1.human.sort()).toEqual(["T1", "T2"]);

    // approve ONLY T1
    Journal.open(repo, "run-g08-bucket").append("task-approved", "T1", { by: "test" });

    const s2 = await runDaemon(repo, { adapters: [fake], runId: "run-g08-bucket", resume: true });
    expect(s2.done).toEqual(["T1"]);
    expect(s2.human).toEqual(["T2"]); // unapproved gate still parks — the feature is not globally disarmed
    const j = Journal.open(repo, "run-g08-bucket").read();
    expect(j.some((e) => e.event === "task-dispatch" && e.taskId === "T2")).toBe(false); // T2 never dispatched
  });

  // REDNESS PROFILE: RED under a global disarm (`if (false)`), RED under a resume-scoped disarm
  // (`if (t.humanGate && !opts.resume)` — which passes the dispatch oracle AND the entire existing suite),
  // GREEN only under `!approved.has(t.id)`. This is the ONLY test in the suite that reaches the guard on
  // the resume path: a task parked in run 1 is filtered out by readyTasks() (graph.ts keeps only
  // status==='pending') and therefore NEVER re-enters execTask on resume. T_GATE here has NO journal
  // events and status 'pending' when the resume begins, so it becomes ready DURING the resume and hits
  // the guard for the first time — the one shape a park-then-resume 'pin' cannot exercise.
  test("GATE-08 resume-path guard pin: an unapproved human gate that first becomes ready DURING a resume still parks", async () => {
    const { repo, fake } = setupRepo(
      [T("T_DEP")],
      { tasks: { T_DEP: [{ shell: `echo dep > dep.txt && ${COMMIT} dep`, result: { ok: true, summary: "dep done" } }] } },
    );
    const s1 = await runDaemon(repo, { adapters: [fake], runId: "run-g08-pin" });
    expect(s1.done).toEqual(["T_DEP"]);

    // between runs: add T_GATE — humanGate, deps [T_DEP] (done), status pending, ZERO journal events
    // (exactly like a gate whose dep completes mid-resume). House pattern: saveGraph + validateGraph.
    // T3: adding a task is a task-DEFINITION change, so resume sees a graph-changed journal and needs
    // the audited --graph-changed release — the test still pins the GATE-08 park-on-resume behavior.
    saveGraph(repo, validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [
        T("T_DEP", { status: "done" }),
        T("T_GATE", { humanGate: true, deps: ["T_DEP"], status: "pending" }),
      ],
    }));

    const s2 = await runDaemon(repo, { adapters: [fake], runId: "run-g08-pin", resume: true, graphChanged: true });
    expect(s2.human).toEqual(["T_GATE"]); // unapproved → parks even though it first became ready during the resume
    const j = Journal.open(repo, "run-g08-pin").read();
    expect(j.some((e) => e.event === "task-human" && e.taskId === "T_GATE")).toBe(true); // park() ran — reachable on resume
    expect(j.some((e) => e.event === "task-dispatch" && e.taskId === "T_GATE")).toBe(false); // never dispatched
  });
}, 120000);


// VIS-09 safety (43-02): the per-attempt completion nonce. A run-scoped nonce is a latent hazard —
// HerdrDriver.read() is `pane read --lines 1000` over scrollback and SubprocessDriver never clears
// s.buf, so a retained prior-attempt trailer could let attempt N harvest attempt N-1's TICKMARKR_RESULT
// as its OWN completion, silently lying about a worker's outcome. This oracle models that retention
// (a shared, never-cleared buffer across attempts) and proves attempt 1 completes on ITS OWN trailer.
// RED if the nonce is hoisted to run scope: attempt 0 and 1 would share a nonce, so attempt 1's first
// waitOutput poll matches attempt 0's retained marker before attempt 1's own output lands (the delayed
// delivery below) and harvests the STALE-A0 result as attempt 1's outcome.
describe("VIS-09 per-attempt nonce (stale-trailer oracle)", () => {
  test("a retained prior-attempt trailer cannot complete a retry", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "STALE-A0" } }, // commits nothing → evidence gate fails → retry
        { shell: `echo fresh > f.txt && ${COMMIT} fresh`, result: { ok: true, summary: "FRESH-A1" } },
      ] } },
    );
    // shared, never-cleared buffer across attempts — the honest model of BOTH real drivers' retention
    // (herdr scrollback / subprocess buf). Output is delivered after a short delay so a prior attempt's
    // retained marker is visible to the next attempt's first waitOutput poll before its own output lands
    // (the deterministic shape of the hazard: a stale marker matches before the live agent finishes).
    let buf = "";
    const inner = new SubprocessDriver();
    const driver = {
      id: "retaining",
      interactive: false,
      async slot(cwd: string, name: string) { return inner.slot(cwd, name); },
      async run(s: { id: string; name: string; cwd: string }, cmd: string) {
        const p = spawn("bash", ["-lc", cmd], { cwd: s.cwd, stdio: ["ignore", "pipe", "pipe"] });
        let acc = "";
        p.stdout.on("data", (d) => (acc += d));
        p.stderr.on("data", (d) => (acc += d));
        p.on("close", () => { setTimeout(() => { buf += acc; }, 25); }); // delayed delivery to the SHARED buf
      },
      async waitOutput(_s: unknown, pattern: string, timeoutMs: number, opts?: { regex?: boolean }) {
        const re = opts?.regex ? new RegExp(pattern) : null;
        const hit = re ? (b: string) => re.test(b) : (b: string) => b.includes(pattern);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (hit(buf)) return true;
          await new Promise((r) => setTimeout(r, 15));
        }
        return hit(buf);
      },
      async read(_s: unknown, lines: number) { return buf.split("\n").slice(-lines).join("\n"); },
      async waitAgentStatus() { return true; },
      async status() { return "unknown"; },
      async notify() {},
      async close() {},
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-nonce", driver });
    expect(s.done).toEqual(["T1"]);
    const results = Journal.open(repo, "run-nonce").read()
      .filter((e) => e.event === "worker-result" && e.taskId === "T1")
      .map((e) => String((e.data as { summary?: string }).summary));
    expect(results).toHaveLength(2); // two attempts ran
    expect(results[0]).toBe("STALE-A0");
    expect(results[1]).toBe("FRESH-A1"); // attempt 1 completes on ITS OWN trailer, not the retained attempt-0 one
  });
}, 120000);


// ── HYG-09 (D-07) fleet hygiene: ephemeral panes self-clean, done means gone, close only what you own ──
// Every test uses a recording stub driver that logs an ORDERED op stream (slot/close/notify) so timing
// of the close vs. downstream ops is assertable. The shipped default is llm: headless — these tests opt
// into llm: pane explicitly to exercise the pane close path. RED on unfixed HEAD: today keepLlm tracks
// keepOpen (true under "run"), so judge/review/consult panes stay open until the run-end sweep and a
// merged task's worker pane persists to run end.
describe("HYG-09 fleet hygiene (fake adapter, zero tokens)", () => {
  // records an ordered op stream while delegating execution to a real SubprocessDriver
  function orderedDriver() {
    const inner = new SubprocessDriver();
    const ops: { kind: string; name?: string; msg?: string }[] = [];
    const driver = {
      id: "ordered",
      interactive: false,
      status: inner.status.bind(inner),
      async slot(cwd: string, name: string) { ops.push({ kind: "slot", name }); return inner.slot(cwd, name); },
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      async notify(msg: string, opts?: { sound?: string }) { ops.push({ kind: "notify", msg }); return inner.notify(msg, opts); },
      async close(s: { id: string; name: string; cwd: string }) { ops.push({ kind: "close", name: s.name }); return inner.close(s); },
      worktree: inner.worktree.bind(inner),
    };
    return { driver, ops };
  }

  test("HYG-09: judge/review pane closes when its result is read, before the run-end notification", async () => {
    // D-07 ephemeral-panes-self-clean (leftover-judge-pane incident): under default keepPanes "run" with
    // llm pane opted in, the judge/review slot closes INSIDE runGates (verdict read), BEFORE the
    // run-end notification fires. RED on HEAD: keepLlm=keepOpen keeps the pane to the sweep.
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
      "visibility:\n  llm: pane\n  keepPanes: run\n",
    );
    const { driver, ops } = orderedDriver();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-hyg09-judge", driver });
    expect(s.done).toEqual(["T1"]);
    const judgeClose = ops.findIndex((o) => o.kind === "close" && o.name === formatOwnedName({ role: "judge", taskId: "T1", attempt: 0, runId: "run-hyg09-judge" }));
    const runEndNotify = ops.findIndex((o) => o.kind === "notify" && /integration branch/.test(o.msg ?? ""));
    expect(judgeClose).toBeGreaterThanOrEqual(0);
    expect(runEndNotify).toBeGreaterThanOrEqual(0);
    expect(judgeClose).toBeLessThan(runEndNotify);
  });

  test("HYG-09: consult pane closes when its verdict is read, before the next attempt dispatches", async () => {
    // D-07: the consult pane self-cleans when the verdict is read, BEFORE attempt 3's worker slot is
    // created. RED on HEAD: consult tracked keepOpen → closed in the run-end sweep, after attempt 3.
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: { action: "retry", notes: "commit something real this time" },
        tasks: { T1: [
          { shell: "true", result: { ok: true, summary: "nothing 1" } },
          { shell: "true", result: { ok: true, summary: "nothing 2" } },
          { shell: "true", result: { ok: true, summary: "nothing 3" } }, // ladder reaches consult → retry
          { shell: `echo done > f.txt && ${COMMIT} f`, result: { ok: true, summary: "finally" } },
        ] },
      },
      "visibility:\n  llm: pane\n  keepPanes: run\n",
    );
    const { driver, ops } = orderedDriver();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-hyg09-consult", driver });
    expect(s.done).toEqual(["T1"]);
    const consultClose = ops.findIndex((o) => o.kind === "close" && o.name === gatePaneName("consult", "T1"));
    const nextWorkerSlot = ops.findIndex((o) => o.kind === "slot" && /T1-worker-fake-a3-/.test(o.name ?? ""));
    expect(consultClose).toBeGreaterThanOrEqual(0);
    expect(nextWorkerSlot).toBeGreaterThanOrEqual(0);
    expect(consultClose).toBeLessThan(nextWorkerSlot);
  });

  test("HYG-09: done means gone — a merged task's worker pane closes on done, exactly once", async () => {
    // D-07 done-means-gone (merged-P42-01-worker incident): T1 → T2 (dep). T1 merges first and its worker
    // pane closes on the done path BEFORE T2 dispatches; the slot is closed EXACTLY once (the run-end
    // sweep skips it — it was removed from keptSlots). RED on HEAD: the merged worker persists to run end.
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2", { deps: ["T1"] })],
      { tasks: {
        T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
        T2: [{ shell: `test -f t1.txt && echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
      } },
      "visibility:\n  keepPanes: run\n",
    );
    const { driver, ops } = orderedDriver();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-hyg09-done", driver, concurrency: 1 });
    expect(s.done).toEqual(["T1", "T2"]);
    const t1WorkerClose = ops.findIndex((o) => o.kind === "close" && /T1-worker-fake-a0-/.test(o.name ?? ""));
    const t2WorkerSlot = ops.findIndex((o) => o.kind === "slot" && /T2-worker-fake-a0-/.test(o.name ?? ""));
    expect(t1WorkerClose).toBeGreaterThanOrEqual(0);
    expect(t2WorkerSlot).toBeGreaterThanOrEqual(0);
    expect(t1WorkerClose).toBeLessThan(t2WorkerSlot); // closed on done, before T2 even dispatches
    const t1WorkerName = ops.find((o) => o.kind === "slot" && /T1-worker-fake-a0-/.test(o.name ?? ""))?.name;
    expect(ops.filter((o) => o.kind === "close" && o.name === t1WorkerName)).toHaveLength(1); // no double-close
  });

  test("HYG-09: keepPanes forever keeps everything — zero closes", async () => {
    // Non-regression pin: forever is the keep-everything debug override. Green on HEAD and after.
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8 })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
      "visibility:\n  llm: pane\n  keepPanes: forever\n",
    );
    const { driver, ops } = orderedDriver();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-hyg09-forever", driver });
    expect(s.done).toEqual(["T1"]);
    expect(ops.filter((o) => o.kind === "close")).toHaveLength(0);
  });

  test("HYG-09: close only what you own — task A's done-close never closes task B's slot", async () => {
    // Pitfall 5 (anonymous-live-daemon trap): the done-close targets the slot handle the closer itself
    // created, never a scan/label. Two concurrent tasks; T1 (instant shell) merges first — its done-close
    // targets ONLY its own worker name. A scan would close T2's worker too (double-close for T2 ⇒ RED).
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2")],
      { tasks: {
        T1: [{ shell: `echo a > a.txt && ${COMMIT} a`, result: { ok: true, summary: "a" } }],
        T2: [{ shell: `sleep 0.4 && echo b > b.txt && ${COMMIT} b`, result: { ok: true, summary: "b" } }],
      } },
      "visibility:\n  keepPanes: run\n",
    );
    const { driver, ops } = orderedDriver();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-hyg09-own", driver, concurrency: 2 });
    expect(s.done.sort()).toEqual(["T1", "T2"]);
    const t1Name = ops.find((o) => o.kind === "slot" && /T1-worker-fake-a0-/.test(o.name ?? ""))?.name;
    const t2Name = ops.find((o) => o.kind === "slot" && /T2-worker-fake-a0-/.test(o.name ?? ""))?.name;
    expect(t1Name).toBeDefined();
    expect(t2Name).toBeDefined();
    // T1 (instant) finishes first; the first worker close targets T1's own name, never T2's
    const firstWorkerClose = ops.find((o) => o.kind === "close" && /-worker-fake-a0-/.test(o.name ?? ""));
    expect(firstWorkerClose?.name).toBe(t1Name);
    // each task's worker slot closed exactly once — a scan that hit T2 during T1's done-close would
    // double-close T2 (the sweep would also reap it), so this count guards the own-slot-only invariant.
    expect(ops.filter((o) => o.kind === "close" && o.name === t1Name)).toHaveLength(1);
    expect(ops.filter((o) => o.kind === "close" && o.name === t2Name)).toHaveLength(1);
  });

  test("HYG-09: failed attempts keep context — prior attempt's worker slot is NOT closed on done", async () => {
    // D-07: only the SUCCESSFUL attempt's slot closes on the done path; a prior failed attempt's slot
    // stays governed by keepPanes (it holds failure context the operator may need) and waits for the sweep.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "lied — committed nothing" } }, // evidence gate fails
        { shell: `echo ok > f.txt && ${COMMIT} fix`, result: { ok: true, summary: "actually worked" } },
      ] } },
      "visibility:\n  keepPanes: run\n",
    );
    const { driver, ops } = orderedDriver();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-hyg09-failedctx", driver });
    expect(s.done).toEqual(["T1"]);
    const a0Name = ops.find((o) => o.kind === "slot" && /T1-worker-fake-a0-/.test(o.name ?? ""))?.name;
    const a1Name = ops.find((o) => o.kind === "slot" && /T1-worker-fake-a1-/.test(o.name ?? ""))?.name;
    expect(a0Name).toBeDefined(); // the failed attempt's worker slot was created
    expect(a1Name).toBeDefined(); // the successful attempt's worker slot was created
    // the successful attempt's slot (a1) is closed exactly once on done; the failed attempt's slot (a0)
    // is NOT closed on the done path — it waits for the run-end sweep (both close exactly once total).
    expect(ops.filter((o) => o.kind === "close" && o.name === a1Name)).toHaveLength(1);
    expect(ops.filter((o) => o.kind === "close" && o.name === a0Name)).toHaveLength(1);
    // and the failed attempt's close comes AFTER the successful attempt's done-close (sweep, not done path)
    const a1Close = ops.findIndex((o) => o.kind === "close" && o.name === a1Name);
    const a0Close = ops.findIndex((o) => o.kind === "close" && o.name === a0Name);
    expect(a0Close).toBeGreaterThan(a1Close);
  });
}, 120000);


// ── narrator pane: one live status surface per run (herdr only; subprocess unaffected) ──
// A narrator-capable driver gets exactly one "watch" pane opened at run start (before any worker
// dispatch) and leaves it to the operator after run end. A narrator that fails to open is swallowed
// — the run is unaffected. Drivers without the narrator method (subprocess, every stub above) spawn
// nothing: driver.narrator?.() is a no-op there (criterion 3 = the whole suite above).
describe("narrator pane (fake adapter, zero tokens)", () => {
  test("herdr-style driver: opens exactly one watch pane only after run-start is journaled and before any worker", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const inner = new SubprocessDriver();
    const ops: { kind: string; name?: string; cmd?: string; msg?: string; journalEvent?: string }[] = [];
    const driver = {
      id: "herdr",
      interactive: true,
      status: inner.status.bind(inner),
      async slot(cwd: string, name: string) { ops.push({ kind: "slot", name }); return inner.slot(cwd, name); },
      async run(s: { id: string; name: string; cwd: string }, cmd: string) {
        ops.push({ kind: "run", name: s.name, cmd });
        if (cmd.includes("status --watch")) return; // the narrator is a live loop — never actually run it
        return inner.run(s, cmd);
      },
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      async notify(msg: string, o?: { sound?: string }) { ops.push({ kind: "notify", msg }); return inner.notify(msg, o); },
      async close(s: { id: string; name: string; cwd: string }) { ops.push({ kind: "close", name: s.name }); return inner.close(s); },
      worktree: inner.worktree.bind(inner),
      async narrator(cwd: string, command: string) {
        ops.push({
          kind: "narrator-open",
          cmd: command,
          journalEvent: Journal.open(cwd, "run-narr").read().at(-1)?.event,
        });
        return inner.slot(cwd, "narrator-watch");
      },
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-narr", driver });
    expect(s.done).toEqual(["T1"]);
    // exactly one narrator open, with the watch command
    const opens = ops.filter((o) => o.kind === "narrator-open");
    expect(opens).toHaveLength(1);
    expect(opens[0]!.cmd).toBe(watchCommand("run-narr"));
    expect(opens[0]!.journalEvent).toBe("run-start");
    // opened at run START — before the first worker slot is created
    const openIdx = ops.findIndex((o) => o.kind === "narrator-open");
    const firstWorker = ops.findIndex((o) => o.kind === "slot" && /-worker-/.test(o.name ?? ""));
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(firstWorker).toBeGreaterThan(openIdx);
    expect(ops.filter((o) => o.kind === "close" && o.name === "narrator-watch")).toHaveLength(0);
  });

  // QUEUE-v194: the board is bound to the run that spawned it. `status` resolves the newest journal
  // when no run is named, and a board showing a previous milestone's numbers under this run's id is a
  // recorded incident (skills/tickmarkr-overseer/SKILL.md).
  test("the exported watchCommand builder names its run id as the explicit status positional and the daemon spawns the narrator through it, so a bare watch command following the newest journal in a repo carrying a second newer run fails", async () => {
    // status takes exactly one positional and it is the run id (cli/commands/status.ts
    // positionalRunId reads the first bare token) — so the run id must BE that bare token.
    const argv = watchCommand("run-board-42").split(" ");
    expect(argv.slice(0, 2)).toEqual(["tickmarkr", "status"]);
    expect(argv).toContain("--watch");
    expect(argv.slice(2).filter((a) => !a.startsWith("-"))).toEqual(["run-board-42"]);

    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const inner = new SubprocessDriver();
    const opens: string[] = [];
    const driver = {
      id: "herdr",
      interactive: true,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      async run(s: { id: string; name: string; cwd: string }, cmd: string) {
        if (cmd.includes("status --watch")) return; // the narrator is a live loop — never actually run it
        return inner.run(s, cmd);
      },
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      async narrator(cwd: string, command: string) {
        opens.push(command);
        return inner.slot(cwd, "narrator-watch");
      },
    };
    // the second, NEWER run this repo carries — what an unnamed `status --watch` would resolve to
    // (Journal.latestRunId sorts run ids, status.ts:766). It exists BEFORE the board opens.
    Journal.create(repo, "run-zz-newer").append("run-start", undefined, {});

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-bound-board", driver });
    expect(s.done).toEqual(["T1"]);
    expect(Journal.latestRunId(repo, { withJournal: true })).toBe("run-zz-newer"); // the bare command's run
    expect(opens).toEqual([watchCommand("run-bound-board")]);
    expect(opens[0]).not.toContain("run-zz-newer"); // never the bare, newest-journal-following command
  });

  test("test: a narrator placement failure journals a watch-placement-failed event carrying the thrown message while a driver without a narrator journals nothing so a failed and a never-attempted board are no longer byte-identical in the journal", async () => {
    const failing = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const inner = new SubprocessDriver();
    const driver = {
      id: "herdr",
      interactive: true,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      async narrator() { throw new Error("herdr tab create failed"); },
    };
    const s = await runDaemon(failing.repo, { adapters: [failing.fake], runId: "run-narr-fail", driver });
    expect(s.done).toEqual(["T1"]); // the run succeeded despite the narrator failure
    expect(Journal.open(failing.repo, "run-narr-fail").read().some((e) =>
      e.event === "watch-placement-failed" && e.data.error === "herdr tab create failed"
    )).toBe(true);

    const never = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const noNarrator = {
      id: "subprocess",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };
    await runDaemon(never.repo, { adapters: [never.fake], runId: "run-narr-none-journal", driver: noNarrator });
    expect(Journal.open(never.repo, "run-narr-none-journal").read().some((e) => e.event === "watch-placement-failed")).toBe(false);
  });

  test("a driver without narrator (subprocess-style) spawns nothing new", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const inner = new SubprocessDriver();
    const names: string[] = [];
    const driver = {
      id: "subprocess",
      interactive: false,
      status: inner.status.bind(inner),
      async slot(cwd: string, name: string) { names.push(name); return inner.slot(cwd, name); },
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      // no narrator method — the daemon's optional-chain call must be a no-op
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-narr-none", driver });
    expect(s.done).toEqual(["T1"]);
    expect(names.every((n) => !n.startsWith("narrator"))).toBe(true); // no narrator pane created
  });
}, 120000);


// v1.54 T2 (OBS-71): the termination reaper's handlers are scoped to one runDaemon call — this suite
// runs the daemon dozens of times in one process, so a leaked handler would close a later run's slots.
test("the signal handlers are removed after a normal run end", async () => {
  const { repo, fake } = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
  );
  const count = () => ({ int: process.listeners("SIGINT").length, term: process.listeners("SIGTERM").length });
  const before = count();
  const inner = new SubprocessDriver();
  let during: ReturnType<typeof count> | undefined;
  const driver = {
    id: "listener-spy",
    interactive: false,
    status: inner.status.bind(inner),
    async slot(cwd: string, name: string) {
      during ??= count(); // sampled mid-run, at the first worker dispatch
      return inner.slot(cwd, name);
    },
    run: inner.run.bind(inner),
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  };
  const s = await runDaemon(repo, { adapters: [fake], runId: "run-sig-removed", driver });
  expect(s.done).toEqual(["T1"]);
  expect(during).toEqual({ int: before.int + 1, term: before.term + 1 }); // registered while the run was live
  expect(count()).toEqual(before); // and removed after the normal run end
});


// ── R3 (OBS-186): a declined review is journal truth, and an honest decline is not a failed gate ──
// The retired branch returned `pass: true` on a complexity comparison, so a review that never ran was
// indistinguishable in the ledger from one that ran and approved. Participation is path-keyed now, the
// decline says so, and the merge decision had to learn that an unrun gate is not a red one — otherwise
// honesty alone would have parked every judge-only task at the merge it was never asked to review.

/** A task whose declared paths are ALL leaf-class, and whose one commit stays inside that class. */
const leafTaskRepo = () => setupRepo(
  [T("T1", { files: ["docs/**", "CHANGELOG.md"] })],
  { tasks: { T1: [{
    shell: `mkdir -p docs && echo '# guide' > docs/guide.md && ${COMMIT} docs`,
    result: { ok: true, summary: "documented the thing" },
  }] } },
);


describe("R3 declined review — journal truth and merge (OBS-186)", () => {
  test("test: a skipped review journals verdict skipped with a policy id and never pass true", async () => {
    const { repo, fake } = leafTaskRepo();
    await runDaemon(repo, { adapters: [fake], runId: "run-r3-journal" });

    const evs = Journal.open(repo, "run-r3-journal").read();
    const review = evs.filter((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "review");
    expect(review).toHaveLength(1);
    const data = review[0]!.data;
    expect(data.pass).not.toBe(true); // a gate that never ran cannot claim a pass
    expect(data.skipped).toBe(true);
    expect(data.verdict).toBe("skipped");
    expect(data.policy).toBe("judge-only"); // the policy id that declined it
    expect(String(data.reason)).toMatch(/leaf/i); // …and why
    expect(String(data.details)).toMatch(/^skipped\b/);
    // the row is legible without the details prose: policy + reason are structured fields
    expect(Object.keys(data)).toEqual(expect.arrayContaining(["verdict", "policy", "reason", "skipped"]));

    // …and it does not claim a FAILURE either. `pass:false` for a decline is one boolean, but it is
    // the boolean five folds outside the daemon key on, and none of them can see `skipped`: the
    // engagement round budget, the operator's failed-gate list, the record's gate-failure total, the
    // retry brief. Assert the REAL consumers on the REAL journal, not a hand-built row.
    expect(data.pass).toBeUndefined(); // the ledger states no verdict it does not have
    expect(reviewRoundsSinceApproval(evs, "T1")).toBe(0); // a skip never spends a review round
    expect(journaledFailureBrief(evs, "T1")).toEqual([]); // …and never becomes "fix this" feedback
    expect(evs.filter((e) => e.event === "gate-result" && e.data.pass === false)).toEqual([]);
    // …and structured findings are never synthesised from a decline's prose
    expect(data.findings).toBeUndefined();

    // the engagement record: declined is its own state, counted in neither total
    const md = renderMarkdownRecord("run-r3-journal", evs);
    expect(md).toContain("review: declined");
    expect(md).not.toContain("review: pass");
    expect(md).not.toContain("review: fail");
    expect(md).toMatch(/\*\*gate failures:\*\* none recorded/);
  }, 60_000);

  test("test: merge treats a review verdict of pass false with skipped true as non-failure and the task can merge", async () => {
    const { repo, fake } = leafTaskRepo();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-r3-merge" });

    expect(s.done).toEqual(["T1"]); // the honest decline did not park the task
    expect(s.human).toEqual([]);
    const evs = Journal.open(repo, "run-r3-merge").read();
    const review = evs.find((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "review")!;
    // the exact shape the merge predicate has to accept: a GateResult carrying pass:false AND
    // skipped:true (the ledger row drops the verdict it does not have — see the journal test above).
    expect(review.data.skipped).toBe(true);
    expect(review.data.pass).not.toBe(true);
    expect(evs.some((e) => e.event === "merge" && e.taskId === "T1")).toBe(true);
    expect(evs.some((e) => e.event === "task-done" && e.taskId === "T1")).toBe(true);
    // …and it is the SKIP that is forgiven, never a red verdict: a review that RAN and failed still
    // blocks, so the predicate cannot be read as "review no longer gates".
    const { repo: red, fake: redFake } = setupRepo(
      [T("T2", { files: ["src/run/daemon.ts"] })],
      {
        consult: { action: "human", notes: "reviewer blocked it" },
        review: { approve: false, issues: ["the retry loop drops its last iteration"] },
        tasks: { T2: [{ shell: `mkdir -p src/run && echo 'export const x = 1;' > src/run/daemon.ts && ${COMMIT} src`, result: { ok: true, summary: "changed source" } }] },
      },
    );
    const blocked = await runDaemon(red, { adapters: [redFake], runId: "run-r3-red" });
    expect(blocked.done).toEqual([]);
    const redEvs = Journal.open(red, "run-r3-red").read();
    const redReview = redEvs.find((e) => e.event === "gate-result" && e.taskId === "T2" && e.data.gate === "review")!;
    expect(redReview.data.pass).toBe(false);
    expect(redReview.data.skipped).toBeUndefined(); // a verdict, not a decline
    expect(redEvs.some((e) => e.event === "merge" && e.taskId === "T2")).toBe(false);
  }, 120_000);
});


describe("v1.86 T7 the fatal handler cannot eat the error it reports", () => {
  // A node-style errno exception, as appendFileSync/readFileSync throw them.
  const fault = (code: string, message: string) => Object.assign(new Error(message), { code });

  // A repo whose run dies in the fatal window (after run-start, before the task loop):
  // refs/heads/tickmarkr blocks refs/heads/tickmarkr/<runId>, so ensureIntegration throws.
  const setupFatalRepo = async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    await shOk("git branch tickmarkr", repo);
    return { repo, fake };
  };
  const originalErrorResembles = (runId: string) => new RegExp(`tickmarkr/${runId}|cannot lock ref|command failed`);

  const rejectionOf = async (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => { throw new Error("expected runDaemon to reject"); },
      (e) => e,
    );

  // Faults injected at the journal's only durable sink, scoped to run-end appends so run-start and
  // the rest of the setup path write normally. Returns the run-end attempt count.
  const failRunEndAppends = (implant: (call: number, journal: Journal) => void) => {
    const real = Journal.prototype.append;
    let calls = 0;
    vi.spyOn(Journal.prototype, "append").mockImplementation(function (this: Journal, event: string, taskId?: string, data?: Record<string, unknown>) {
      if (event === "run-end") {
        calls += 1;
        implant(calls, this); // throws to simulate the sink fault; returns to write through
      }
      return real.call(this, event, taskId, data);
    });
    return { count: () => calls };
  };

  const captureConsoleErrors = () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    return { lines: () => spy.mock.calls.map((args) => args.map(String).join(" ")) };
  };

  const journalPathOf = (repo: string, runId: string) => join(Journal.open(repo, runId).dir, "journal.jsonl");

  test("test: a failing journal append during fatal handling surfaces both the original error and the append failure, proven member by member over the closed set of append failures — a full-disk fixture, a permission fixture and a closed-handle fixture", async () => {
    const members = [
      { name: "full-disk", make: () => fault("ENOSPC", "ENOSPC: no space left on device, write") },
      { name: "permission", make: () => fault("EACCES", "EACCES: permission denied, open") },
      { name: "closed-handle", make: () => fault("EBADF", "EBADF: bad file descriptor, write") },
    ];
    for (const member of members) {
      const runId = `run-t7-append-${member.name}`;
      const { repo, fake } = await setupFatalRepo();
      const sink = member.make();
      failRunEndAppends(() => { throw sink; });
      const consoleErrors = captureConsoleErrors();

      const err = await rejectionOf(runDaemon(repo, { adapters: [fake], runId }));
      const reported = consoleErrors.lines();
      vi.restoreAllMocks();

      // the original error reaches the caller — never replaced by the append failure
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBe(sink);
      expect((err as Error).message).toMatch(originalErrorResembles(runId));
      expect((err as Error).message).not.toContain(sink.message);
      // and the append failure is surfaced ALONGSIDE the original error, not instead of it
      expect(reported.some((line) => line.includes(sink.message) && line.includes((err as Error).message))).toBe(true);
    }
  });

  test("test: a journal read that throws inside the fatal handler is reported alongside the original error rather than replacing it, and the original error still reaches the caller when the read and the append fail independently", async () => {
    const runId = "run-t7-read-fatal";
    const { repo, fake } = await setupFatalRepo();
    const readFault = fault("EIO", "EIO: i/o error, read");
    const realRead = Journal.prototype.read;
    vi.spyOn(Journal.prototype, "read").mockImplementation(function (this: Journal) {
      const events = realRead.call(this);
      // only the fatal handler reads this journal after run-start in this scenario
      if (events.some((e) => e.event === "run-start")) throw readFault;
      return events;
    });
    const appendFault = fault("ENOSPC", "ENOSPC: no space left on device, write");
    failRunEndAppends(() => { throw appendFault; });
    const consoleErrors = captureConsoleErrors();

    const err = await rejectionOf(runDaemon(repo, { adapters: [fake], runId }));
    const reported = consoleErrors.lines();
    vi.restoreAllMocks();

    // the original error reaches the caller even with the read and the append failing independently
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(originalErrorResembles(runId));
    expect((err as Error).message).not.toContain(readFault.message);
    expect((err as Error).message).not.toContain(appendFault.message);
    // the read failure is reported alongside the original error, never replacing it
    expect(reported.some((line) => line.includes(readFault.message) && line.includes((err as Error).message))).toBe(true);
    // …and the independently-failing append is reported too, naming the journal path
    expect(reported.some((line) => line.includes(appendFault.message) && line.includes(journalPathOf(repo, runId)))).toBe(true);
  });

  test("test: an append that fails once and succeeds on retry writes run-end and the journal replays to a terminal state, proven over the closed set of one-shot faults — a transient-EIO fixture, a first-call-throws fixture, and a partial-write fixture that leaves a malformed trailing prefix on disk rather than throwing before any bytes land", async () => {
    const members: Array<{ name: string; implant: (journal: Journal) => void }> = [
      { name: "transient-eio", implant: () => { throw fault("EIO", "EIO: i/o error, write"); } },
      { name: "first-call-throws", implant: () => { throw new Error("simulated first-call failure"); } },
      {
        name: "partial-write",
        implant: (journal) => {
          // bytes land BEFORE the failure: a torn, malformed fragment with no terminating newline
          appendFileSync(join(journal.dir, "journal.jsonl"), '{"ts":"TORN-PARTIAL-WRITE');
          throw fault("EIO", "EIO: i/o error, write");
        },
      },
    ];
    for (const member of members) {
      const runId = `run-t7-retry-${member.name}`;
      const { repo, fake } = await setupFatalRepo();
      const attempts = failRunEndAppends((call, journal) => {
        if (call === 1) member.implant(journal);
      });

      const err = await rejectionOf(runDaemon(repo, { adapters: [fake], runId }));
      vi.restoreAllMocks();

      expect((err as Error).message).toMatch(originalErrorResembles(runId));
      expect(attempts.count()).toBe(2); // failed once, retried ONCE, succeeded
      const events = Journal.open(repo, runId).read();
      expect(runHasEnded(events)).toBe(true); // the journal replays to a terminal state
      const runEnds = events.filter((e) => e.event === "run-end");
      expect(runEnds).toHaveLength(1);
      expect(runEnds[0]!.data.fatal).toBe(true);
      expect(runEnds[0]!.data.phase).toBe("setup");
      expect(runEnds[0]!.data.error).toBe((err as Error).message);
      if (member.name === "partial-write") {
        // the torn fragment stays on disk as a dropped malformed line — recovery never truncates
        expect(readFileSync(journalPathOf(repo, runId), "utf8")).toContain("TORN-PARTIAL-WRITE");
      }
    }
  });

  test("test: a persistently unwritable sink reports a crash carrying no terminal record and naming the journal path, rather than reporting an ended run, proven member by member over the closed set of persistent sinks — a permission-denied fixture, a full-disk fixture and a read-only-filesystem fixture", async () => {
    const members = [
      { name: "permission-denied", make: () => fault("EACCES", "EACCES: permission denied, open") },
      { name: "full-disk", make: () => fault("ENOSPC", "ENOSPC: no space left on device, write") },
      { name: "read-only-filesystem", make: () => fault("EROFS", "EROFS: read-only file system, open") },
    ];
    for (const member of members) {
      const runId = `run-t7-dead-${member.name}`;
      const { repo, fake } = await setupFatalRepo();
      const sink = member.make();
      const attempts = failRunEndAppends(() => { throw sink; });
      const consoleErrors = captureConsoleErrors();

      const err = await rejectionOf(runDaemon(repo, { adapters: [fake], runId }));
      const reported = consoleErrors.lines();
      vi.restoreAllMocks();

      // the original error reaches the caller
      expect((err as Error).message).toMatch(originalErrorResembles(runId));
      expect((err as Error).message).not.toContain(sink.message);
      // retried ONCE, then fail-closed: no terminal record on evidence the harness could not write
      expect(attempts.count()).toBe(2);
      const events = Journal.open(repo, runId).read();
      expect(events.some((e) => e.event === "run-end")).toBe(false);
      expect(runHasEnded(events)).toBe(false);
      // the crash report names the journal path and both failures — and never claims an ended run
      const crash = reported.find((line) => line.includes(journalPathOf(repo, runId)));
      expect(crash).toBeDefined();
      expect(crash!).toContain(sink.message);
      expect(crash!).toContain((err as Error).message);
      expect(crash!).not.toMatch(/\brun ended\b/i);
    }
  });

  test("test: the original error's message and stack survive verbatim on the thrown object and its cause, while the operator-visible line stays the one-line dispatcher form carrying no raw stack, proven by routing the rejection through the dispatcher", async () => {
    const runId = "run-t7-verbatim";
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "unreachable" } }] } },
      "gates:\n  build: definitely-missing-tickmarkr-build\n  test: definitely-missing-tickmarkr-test\n",
    );
    const cause = new Error("root cause fixture");
    const sentinel = new Error("sentinel original failure", { cause });
    const real = Journal.prototype.append;
    // missing baseline commands produce baseline-warning appends INSIDE the fatal window (after
    // run-start, before the task loop); the first one throws our sentinel, becoming the run's fatal
    vi.spyOn(Journal.prototype, "append").mockImplementation(function (this: Journal, event: string, taskId?: string, data?: Record<string, unknown>) {
      if (event === "baseline-warning") throw sentinel;
      return real.call(this, event, taskId, data);
    });

    const err = await rejectionOf(runDaemon(repo, { adapters: [fake], runId }));
    vi.restoreAllMocks();

    // the thrown object IS the original error: message, stack and cause survive verbatim
    expect(err).toBe(sentinel);
    expect((err as Error).message).toBe("sentinel original failure");
    expect((err as Error).stack).toBe(sentinel.stack);
    expect((err as Error).cause).toBe(cause);
    expect(((err as Error).cause as Error).message).toBe("root cause fixture");
    expect(((err as Error).cause as Error).stack).toBe(cause.stack);
    // the fatal run-end still records the original error's message
    const events = Journal.open(repo, runId).read();
    expect(events.at(-1)?.event).toBe("run-end");
    expect(events.at(-1)?.data.error).toBe("sentinel original failure");
    // routed through the dispatcher, the operator-visible line is the one-line form — no raw stack
    // Load the eager CLI entrypoint only at the assertion that needs its dispatcher. A static import
    // makes daemon.test collection load every command (including Ink) while app.test is observing
    // its first rendered frame, turning that production-path oracle into a suite-load race.
    const { dispatch } = await import("../../../src/cli/index.js");
    const result = await dispatch("run", [], { run: () => Promise.reject(err) });
    expect(result.code).toBe(1);
    expect(result.out).toBe("tickmarkr run: sentinel original failure");
    expect(result.out).not.toContain("\n");
    expect(result.out).not.toContain("    at ");
  });
});
