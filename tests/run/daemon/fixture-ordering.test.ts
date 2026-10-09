// OBS-1163 / OBS-1162: the fake-worker races the daemon suites used to order by unequal sleeps are
// ordered here by journal events through tests/helpers/worker-barrier.ts. Every scenario runs the
// PRODUCTION daemon (runDaemon) in both worker arrival orders and proves the held worker finished
// after the row that released it, so a barrier released before its recorded event is red.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { quotaSignal, shq } from "../../../src/adapters/types.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { shOk } from "../../../src/run/git.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { alive, exited, ownedFailures, type Proc, type PsTable, psTable, runOwned, teardownTree } from "../../helpers/owned-process.js";
import { COMMIT, setupRepo, T, TEST_BASE_TMPDIR_ENV } from "../../helpers/tmprepo.js";
import { conflictPair, heldAfterRelease, lastRows, Q1_SCHEDULES, type Q1Schedule, q1Violations, releaseAll, releaseIndex, releaseOn, type WorkerBarrier, workerBarrier } from "../../helpers/worker-barrier.js";

type Id = "T1" | "T2";
const other = (id: Id): Id => (id === "T1" ? "T2" : "T1");
const ORDERS: Id[] = ["T1", "T2"];
const events = (repo: string, runId: string) => Journal.open(repo, runId).read();
const at = (rows: JournalEvent[], event: string, taskId: string) => rows.findIndex((e) => e.event === event && e.taskId === taskId);

/** The held worker's result must land after the row that released it; an early release has no row. */
function expectHeldAfterRelease(rows: JournalEvent[], b: WorkerBarrier, held: Id, event: string, releasedBy: Id) {
  expect(heldAfterRelease(rows, b, held, event, releasedBy)).toEqual([]);
}

/** A same-base conflict pair (held waits for first's merge, first waits for held's launch), both orders proven. */
async function expectConflictOrder(runId: string, first: Id) {
  expect(await conflictPair(runId, first, other(first)).violations()).toEqual([]);
}

describe("fixture ordering by events (fake adapter, zero tokens)", () => {
  test("test: the production daemon preserves the required HYG-09 close order plus all three retry merge orders under reversed worker arrival, so releasing a barrier before its recorded event fails", async () => {
    // HYG-09 (fleet-and-gates.test.ts "close only what you own"): the held worker waits for the other
    // task's task-done row, so the first worker close is always the unheld task's own slot.
    for (const first of ORDERS) {
      const held = other(first);
      const runId = `run-order-hyg09-${first}`;
      const b = workerBarrier(`${runId}-${held}`);
      const { repo, fake } = setupRepo([T("T1"), T("T2")], { tasks: {
        [first]: [{ shell: `echo ${first} > ${first}.txt && ${COMMIT} ${first}`, result: { ok: true, summary: first } }],
        [held]: [{ shell: `${b.hold} && echo ${held} > ${held}.txt && ${COMMIT} ${held}`, result: { ok: true, summary: held } }],
      } }, "visibility:\n  keepPanes: run\n");
      const inner = new SubprocessDriver();
      const ops: { kind: string; name: string }[] = [];
      const driver = {
        id: "ordered", interactive: false,
        status: inner.status.bind(inner), run: inner.run.bind(inner), waitOutput: inner.waitOutput.bind(inner),
        waitAgentStatus: inner.waitAgentStatus.bind(inner), read: inner.read.bind(inner), notify: inner.notify.bind(inner),
        worktree: inner.worktree.bind(inner),
        async slot(cwd: string, name: string) { ops.push({ kind: "slot", name }); return inner.slot(cwd, name); },
        async close(s: { id: string; name: string; cwd: string }) { ops.push({ kind: "close", name: s.name }); return inner.close(s); },
      };
      const s = await runDaemon(repo, { adapters: [fake], runId, driver, concurrency: 2, narrate: releaseOn(b, "task-done", first) })
        .finally(() => releaseAll(b));
      // D-1278: a task that ends not done names its outcome and last rows here; teardown deletes the journal.
      const rows = events(repo, runId);
      const tails = ORDERS.map((id) => `${id}: ${lastRows(rows, id).join(" | ")}`).join(" ;; ");
      expect(s.done.sort(), `${runId} failed=[${s.failed}] human=[${s.human}] ${tails}`).toEqual(["T1", "T2"]);
      expectHeldAfterRelease(rows, b, held, "task-done", first);
      const worker = (id: Id) => ops.find((o) => o.kind === "slot" && o.name.includes(`${id}-worker-fake-a0-`))?.name;
      const firstClose = ops.find((o) => o.kind === "close" && /-worker-fake-a0-/.test(o.name));
      expect(firstClose?.name, runId).toBe(worker(first));
      for (const id of ORDERS) expect(ops.filter((o) => o.kind === "close" && o.name === worker(id)), `${runId} ${id} closes`).toHaveLength(1);
    }

    // The three retry.test.ts conflict fixtures (run-wt-partial, run-wt-resume, run-wt-keep) share one
    // merge order: the released worker merges, the held worker meets the conflict — in BOTH arrivals.
    for (const fixture of ["partial", "resume", "keep"]) {
      for (const first of ORDERS) await expectConflictOrder(`run-order-wt-${fixture}-${first}`, first);
    }
  }, 240_000);

  test("test: the production daemon admits an approval while its sibling is barrier-held then resolves the same-base conflict pair under either arrival order, so a missed approval or a conflict that never occurs fails", async () => {
    // approval-sweep.test.ts live approval: A's approval is appended on B's dispatch while B's worker
    // holds until A's dispatch row — the approval is consumed inside B's flight, never at a boundary.
    const runId = "run-order-approval";
    const b = workerBarrier(`${runId}-B`);
    const { repo, fake } = setupRepo([T("A", { humanGate: true }), T("B")], { tasks: {
      A: [{ shell: `echo a > a.txt && ${COMMIT} a`, result: { ok: true, summary: "a" } }],
      B: [{ shell: `${b.hold} && echo b > b.txt && ${COMMIT} b`, result: { ok: true, summary: "b" } }],
    } });
    const s = await runDaemon(repo, { adapters: [fake], runId, approvalWindowMs: 1, concurrency: 2,
      narrate: releaseOn(b, "task-dispatch", "A", (e) => {
        if (e.event === "task-dispatch" && e.taskId === "B") {
          const journal = Journal.open(repo, runId); // OBS-1178: the approval binds A's park
          journal.append("task-approved", "A", { by: "test", via: "test", park: journal.newestBinding("A") });
        }
      }),
    }).finally(() => releaseAll(b));
    expect(s.done.sort()).toEqual(["A", "B"]);
    const rows = events(repo, runId);
    const approvedAt = at(rows, "task-approved", "A");
    const dispatchAt = rows.findIndex((e, i) => i > approvedAt && e.event === "task-dispatch" && e.taskId === "A");
    expect(approvedAt).toBeGreaterThanOrEqual(0);
    expect(dispatchAt).toBeGreaterThan(approvedAt);
    expect(b.releasedOn?.event).toBe("task-dispatch");
    expect(releaseIndex(rows, b)).toBe(dispatchAt);
    expect(at(rows, "worker-result", "B")).toBeGreaterThan(dispatchAt);

    // daemon.test.ts run-conflict: the same-base pair conflicts (merge-conflict + human consult
    // verdict for the held task) in both arrival orders.
    for (const first of ORDERS) await expectConflictOrder(`run-order-conflict-${first}`, first);
  }, 120_000);

  test("test: the production daemon Q-1 fixture delivers both distinct task commits in either merge order under delayed release or consult completion versus a one-task terminal summary, so diagnostics must expose the last five rows on a missing commit", async () => {
    const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/quota/${name}`, import.meta.url));
    const dump = (name: string) => `cat ${shq(fixture(name))}; exit 1`;
    // queue row 106 (D-1597, declared contract change): a2 still carries a quota PHRASE in its body — the hazard; a0's only
    // former match was a bare `429:` line number, which is no quota signal at all now.
    expect(quotaSignal(readFileSync(fixture("run3522-T2-a2.out"), "utf8"))).not.toBeNull();
    expect(quotaSignal(readFileSync(fixture("run3522-T2-a0.out"), "utf8"))).toBeNull();
    const ok = (id: Id) => `echo ok > ${id}.txt && ${COMMIT} ${id}`;
    let witness: { first: Id; held: Id; schedule: Q1Schedule; barrier: WorkerBarrier; rows: JournalEvent[]; tree: string } | undefined;
    for (const schedule of Q1_SCHEDULES) {
      for (const first of ORDERS) {
        const held = other(first);
        const runId = `run-order-q1-${schedule.on}-${first}`;
        const b = workerBarrier(`${runId}-${held}`);
        const { repo, fake } = setupRepo([T("T1"), T("T2")], {
          consult: { action: "retry", notes: "a no-trailer exit is not a channel verdict" },
          tasks: {
            [first]: [{ shell: dump("run3522-T2-a0.out") }, { shell: ok(first), result: { ok: true, summary: first } }],
            [held]: [{ shell: dump("run3522-T2-a2.out") }, { shell: `${b.hold} && ${ok(held)}`, result: { ok: true, summary: held } }],
          },
        });
        const s = await runDaemon(repo, { adapters: [fake], runId, narrate: releaseOn(b, schedule.on, first) }).finally(() => releaseAll(b));
        const rows = events(repo, runId);
        const tree = await shOk(`git ls-tree -r --name-only ${s.branch}`, repo);
        expect(q1Violations({ runId, first, held, schedule, barrier: b, done: s.done, rows, tree })).toEqual([]);
        witness ??= { first, held, schedule, barrier: b, rows, tree };
      }
    }

    // versus a one-task terminal summary: the same rows judged with the held task undelivered must name
    // exactly that task's last five rows (never its sixth-last, never the delivered task's merge) on both the
    // missing done entry and the missing commit
    const w = witness!;
    const heldRows = w.rows.filter((e) => e.taskId === w.held);
    expect(heldRows.length).toBeGreaterThan(5);
    const red = q1Violations({ runId: "run-order-q1-partial", ...w, done: [w.first], tree: w.tree.split("\n").filter((f) => f !== `${w.held}.txt`).join("\n") });
    expect(red).toHaveLength(2);
    const tail = lastRows(w.rows, w.held);
    expect(tail).toHaveLength(5);
    for (const v of red) {
      expect(v).toMatch(new RegExp(`: ${w.held}(\\.txt)? `));
      for (const row of tail) expect(v).toContain(row);
      expect(v).not.toContain(`${heldRows.at(-6)!.event} ${JSON.stringify(heldRows.at(-6)!.data).slice(0, 160)}`);
      expect(v).not.toContain(lastRows(w.rows, w.first).find((row) => row.startsWith("merge ")));
    }
  }, 120_000);
});

// ── wall-time-bounded stress harness ──────────────────────────────────────────────────────────
// Each repetition runs `concurrent` conflict-pair daemon fixtures at once (alternating arrival
// orders) and records ONE outcome per fixture — a rejection, a cut or a failed process discovery is
// an outcome, never a lost row. Each fixture runs in its OWN owned node process
// (tests/helpers/owned-process.ts), so the bound cuts every execution path it has: the daemon, its
// detached worker groups, headless judge/review/consult commands and git. That process tree is torn
// down (frozen, killed, awaited) before the outcome is recorded, and the ledger names any pid that
// survived and any ownership a failed discovery left unproven, so a leaked child is red.
type Mode = "pair" | "hang";
type FixtureSpec = { mode: Mode; runId: string; first: Id; ms: number; armOn?: RegExp; ps?: PsTable };
type FixtureLedger = { runId: string; ok: boolean; error?: string; tree: Proc[]; detached: number; survivors: number[] };
type Outcome = { rep: number; slot: number } & FixtureLedger;
const STRESS = process.env.TICKMARKR_TEST_STRESS;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX = createRequire(import.meta.url).resolve("tsx");
const HELPER = new URL("../../helpers/worker-barrier.ts", import.meta.url).href;
const ARM_CEILING_MS = 60_000;
/** A node root script that spawns `spawnArgs` detached and unreferenced, prints its pid, then runs `then`. */
const SPAWN_DETACHED = (spawnArgs: string, then: string) =>
  `const c = require("node:child_process").spawn(${spawnArgs}, { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid); ${then}`;

/**
 * One fixture in its own owned node process. The wall-time bound runs from spawn, or from the first
 * stdout match of `armOn` (a fixture that never arms is still cut at ARM_CEILING_MS, so it cannot
 * outlive its test); the fixture reports `OUTCOME <violations>` and parks, so its tree is still
 * intact when it is torn down. Whichever comes first — outcome, exit or bound — the tree is torn
 * down and awaited before the ledger row exists. Never rejects.
 */
async function ownedFixture(o: FixtureSpec): Promise<FixtureLedger> {
  const script = [
    `const { fixtureViolations } = await import(${JSON.stringify(HELPER)});`,
    `const violations = await fixtureViolations(${JSON.stringify(o.mode)}, ${JSON.stringify(o.runId)}, ${JSON.stringify(o.first)}).catch((e) => [String(e?.stack ?? e)]);`,
    `process.stdout.write("\\nOUTCOME " + JSON.stringify(violations) + "\\n");`,
    "setInterval(() => {}, 1 << 30); // parked until the harness tears this tree down",
  ].join("\n");
  const run = await runOwned(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], {
    cwd: ROOT, ms: o.ms, armOn: o.armOn, armCeilingMs: ARM_CEILING_MS, settleOn: /^OUTCOME /m, ps: o.ps,
    // the child's fixture temporaries land under this file's recorded TMPDIR, reaped with it
    env: { ...process.env, [TEST_BASE_TMPDIR_ENV]: process.env.TMPDIR },
  });
  const reported = /^OUTCOME (.*)$/m.exec(run.out)?.[1];
  const parsed = (text: string): string[] => { try { return JSON.parse(text); } catch { return [`${o.runId}: unparseable outcome ${text}`]; } };
  const violations: string[] = [
    ...(run.why === "expired" ? [`${o.runId}: wall-time bound ${o.ms} ms exhausted`]
      : reported ? parsed(reported) : [`${o.runId}: fixture process exited without an outcome: ${run.err.slice(-4_000)}`]),
    ...(run.unresolved ? [`${o.runId}: ownership unresolved — ${run.unresolved}`] : []),
  ];
  return {
    runId: o.runId, ok: violations.length === 0, ...(violations.length ? { error: violations.join("; ") } : {}),
    tree: run.tree, detached: run.tree.filter((p) => p.pgid !== run.pid).length, survivors: run.survivors,
  };
}

/** One ledger row per spec, whatever each fixture does: ownedFixture never rejects, so no row is lost to an aborted Promise.all. */
const ownedFixtures = (specs: FixtureSpec[]) => Promise.all(specs.map(ownedFixture));

async function stressMatrix(o: { reps: number; concurrent: number; burners: number; wallMs: number }) {
  const burners: ChildProcess[] = [];
  const outcomes: Outcome[] = [];
  const deadline = Date.now() + o.wallMs;
  try {
    for (let i = 0; i < o.burners; i++) burners.push(spawn("nice", ["-n", "19", "sh", "-c", "while :; do :; done"], { stdio: "ignore", detached: true }));
    for (let rep = 0; rep < o.reps; rep++) {
      const remaining = deadline - Date.now();
      const specs = Array.from({ length: o.concurrent }, (_, slot): FixtureSpec => ({ mode: "pair", runId: `run-stress-${rep}-${slot}`, first: ORDERS[slot % 2]!, ms: remaining }));
      const round = remaining > 0 ? await ownedFixtures(specs)
        : specs.map((s): FixtureLedger => ({ runId: s.runId, ok: false, error: `${s.runId}: wall-time bound exhausted before start`, tree: [], detached: 0, survivors: [] }));
      outcomes.push(...round.map((r, slot) => ({ rep, slot, ...r })));
    }
  } finally {
    await Promise.all(burners.map((c) => teardownTree(c)));
  }
  return { outcomes, burners: burners.map((c) => ({ pid: c.pid, exited: exited(c) })) };
}

describe("fixture stress harness", () => {
  test("a fixture cut at its wall-time bound while its detached worker is held is recorded as bound-exhausted only after its whole process tree, detached worker group included, is killed and awaited", async () => {
    // the bound arms on the worker-launch row, so a live worker is certainly in the tree it cuts
    const ledger = await ownedFixture({ mode: "hang", runId: "run-bound-hang", first: "T1", ms: 0, armOn: /^LAUNCHED T1$/m });
    expect(ledger.ok).toBe(false);
    expect(ledger.error).toBe("run-bound-hang: wall-time bound 0 ms exhausted");
    expect(ledger.detached, "the held worker's own process group was inside the teardown").toBeGreaterThanOrEqual(1);
    expect(ledger.tree.length).toBeGreaterThan(ledger.detached);
    expect(ledger.survivors).toEqual([]);
  }, 120_000);

  test("test: the fixture harness returns one outcome for every owned fixture when one exceeds its deadline versus normal completion and reaps known children even when discovery fails, so an aborted Promise.all or surviving recorded child fails", async () => {
    // Discovery answers its first pass — the held worker's detached group is recorded and frozen — then
    // fails. The teardown must still kill and await everything recorded, and the row must name the
    // fixture's ownership unresolved, while its concurrent sibling completes normally beside it.
    let passes = 0;
    const failing: PsTable = async (o) => { if (o.phase === "teardown" && passes++ > 0) throw new Error("injected ps failure"); return psTable(o); };
    const [cut, normal, ...extra] = await ownedFixtures([
      { mode: "hang", runId: "run-deadline-hang", first: "T1", ms: 0, armOn: /^LAUNCHED T1$/m, ps: failing },
      { mode: "pair", runId: "run-deadline-pair", first: "T1", ms: 150_000 },
    ]);
    expect(extra).toEqual([]);
    expect(passes).toBe(2);
    expect(cut!.ok).toBe(false);
    expect(cut!.error).toBe("run-deadline-hang: wall-time bound 0 ms exhausted; run-deadline-hang: ownership unresolved — process discovery failed: injected ps failure");
    expect(cut!.detached, "the held worker's own group was recorded before discovery failed").toBeGreaterThanOrEqual(1);
    expect(cut!.survivors).toEqual([]);
    expect(cut!.tree.filter((p) => alive(p.pid))).toEqual([]);
    expect(normal, normal?.error).toMatchObject({ runId: "run-deadline-pair", ok: true, survivors: [] });
    expect(normal!.tree.length).toBeGreaterThanOrEqual(1);
    expect(normal!.tree.filter((p) => alive(p.pid))).toEqual([]);

    // Discovery failing on its very first pass still reaps the root, its group and the detached child the
    // tracker recorded while the root ran — all known before teardown began.
    const tracked = await runOwned(process.execPath, ["-e", SPAWN_DETACHED("'sleep', ['60']", "setInterval(() => {}, 1 << 30)")], {
      ms: 1_500, ps: (o) => o.phase === "teardown" ? Promise.reject(new Error("injected ps failure")) : psTable(o),
    });
    const orphan = Number(tracked.out.trim());
    expect(tracked.why).toBe("expired");
    expect(tracked.unresolved).toBe("process discovery failed: injected ps failure");
    expect(tracked.tree.map((p) => p.pid)).toContain(orphan);
    expect(tracked.survivors).toEqual([]);
    expect(alive(orphan)).toBe(false);
    expect(alive(-tracked.pid!)).toBe(false);

    // Discovery that never answers is cut at half of one teardown deadline, and the reaping still happens.
    const started = Date.now();
    const stalled = await runOwned("sh", ["-c", "sleep 60 & sleep 60"], {
      ms: 200, boundMs: 2_000, ps: (o) => o.phase === "teardown" ? new Promise<never>(() => {}) : psTable(o),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(stalled.why).toBe("expired");
    expect(stalled.unresolved).toBe("process discovery failed: discovery past its 1000 ms share of the teardown bound timed out");
    expect(stalled.survivors).toEqual([]);
    expect(stalled.tree.filter((p) => alive(p.pid))).toEqual([]);
    expect(alive(-stalled.pid!)).toBe(false);
  }, 240_000);

  test("an owned root that exits normally before its detached child still owns and reaps that child, so a descendant leaked past its root's exit fails", async () => {
    // tracked: the root outlives a tracking pass after spawning a detached platform binary, then exits 0
    const lingered = await runOwned(process.execPath, ["-e", SPAWN_DETACHED("'sleep', ['60']", "setTimeout(() => {}, 1_500)")], { ms: 30_000 });
    // tagged: the root exits the moment its detached child is spawned, before any tracking pass can see it
    const quick = await runOwned(process.execPath, ["-e", SPAWN_DETACHED("process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)']", "")], { ms: 30_000 });
    for (const run of [lingered, quick]) {
      const orphan = Number(run.out.trim());
      expect(orphan, run.err).toBeGreaterThan(0);
      expect(run).toMatchObject({ why: "settled", exitCode: 0, survivors: [] });
      expect(ownedFailures(run, "orphan")).toEqual([]);
      expect(run.tree.map((p) => p.pid)).toContain(orphan);
      expect(alive(orphan)).toBe(false);
    }
  }, 60_000);

  test.skipIf(STRESS !== "smoke" && STRESS !== "1")("the fixture smoke harness records individual success for all 4 repetitions at 2 concurrent daemon fixtures plus 0 burners with complete owned-child cleanup, so one missing outcome or leaked child fails", async () => {
    const { outcomes, burners } = await stressMatrix({ reps: 4, concurrent: 2, burners: 0, wallMs: 150_000 });
    expect(outcomes).toHaveLength(8);
    expect(outcomes.filter((r) => !r.ok)).toEqual([]);
    expect(burners).toHaveLength(0);
    // every fixture process was owned (in its torn-down tree) and nothing it spawned outlived teardown
    expect(outcomes.filter((r) => r.tree.length < 1 || r.survivors.length > 0)).toEqual([]);
  }, 180_000);

  // The overseer's release proof after run-end, never a task criterion: 32 × 16 daemon fixtures
  // beside 16 owned nice -n 19 burners. Skipped unless TICKMARKR_TEST_STRESS=1.
  test.skipIf(STRESS !== "1")("the fixture stress matrix records individual success for all 32 repetitions at 16 concurrent daemon fixtures plus 16 owned burners under nice -n 19 with complete owned-child cleanup", async () => {
    const { outcomes, burners } = await stressMatrix({ reps: 32, concurrent: 16, burners: 16, wallMs: 1_500_000 });
    expect(outcomes).toHaveLength(512);
    expect(outcomes.filter((r) => !r.ok)).toEqual([]);
    expect(burners).toHaveLength(16);
    expect(burners.every((c) => c.exited)).toBe(true);
    expect(outcomes.filter((r) => r.tree.length < 1 || r.survivors.length > 0)).toEqual([]);
  }, 1_600_000);
});
