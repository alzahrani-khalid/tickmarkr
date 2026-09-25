// OBS-1163 / OBS-1162: the fake-worker races the daemon suites used to order by unequal sleeps are
// ordered here by journal events through tests/helpers/worker-barrier.ts. Every scenario runs the
// PRODUCTION daemon (runDaemon) in both worker arrival orders and proves the held worker finished
// after the row that released it, so a barrier released before its recorded event is red.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { QUOTA_RE, shq } from "../../../src/adapters/types.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { shOk } from "../../../src/run/git.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { COMMIT, setupRepo, T, TEST_BASE_TMPDIR_ENV } from "../../helpers/tmprepo.js";
import { conflictPair, heldAfterRelease, releaseAll, releaseIndex, releaseOn, type WorkerBarrier, workerBarrier } from "../../helpers/worker-barrier.js";

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
      expect(s.done.sort(), runId).toEqual(["T1", "T2"]);
      const rows = events(repo, runId);
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
        if (e.event === "task-dispatch" && e.taskId === "B") Journal.open(repo, runId).append("task-approved", "A", { by: "test", via: "test" });
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

  test("test: the production daemon completes Q-1 retries with distinct task files under either merge order, so sharing ok.txt until one retry has nothing to commit fails", async () => {
    const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/quota/${name}`, import.meta.url));
    const dump = (name: string) => `cat ${shq(fixture(name))}; exit 1`;
    for (const f of ["run3522-T2-a0.out", "run3522-T2-a2.out"]) expect(QUOTA_RE.test(readFileSync(fixture(f), "utf8"))).toBe(true);
    for (const first of ORDERS) {
      const held = other(first);
      const runId = `run-order-q1-${first}`;
      const b = workerBarrier(`${runId}-${held}`);
      const ok = (id: Id) => `echo ok > ${id}.txt && ${COMMIT} ${id}`;
      const { repo, fake } = setupRepo([T("T1"), T("T2")], {
        consult: { action: "retry", notes: "a no-trailer exit is not a channel verdict" },
        tasks: {
          [first]: [{ shell: dump("run3522-T2-a0.out") }, { shell: ok(first), result: { ok: true, summary: first } }],
          [held]: [{ shell: dump("run3522-T2-a2.out") }, { shell: `${b.hold} && ${ok(held)}`, result: { ok: true, summary: held } }],
        },
      });
      const s = await runDaemon(repo, { adapters: [fake], runId, narrate: releaseOn(b, "merge", first) }).finally(() => releaseAll(b));
      expect(s.done.sort(), runId).toEqual(["T1", "T2"]);
      const rows = events(repo, runId);
      expectHeldAfterRelease(rows, b, held, "merge", first);
      expect(rows.some((e) => e.event === "quota-failover"), runId).toBe(false);
      expect(rows.filter((e) => e.event === "merge").map((e) => e.taskId), runId).toEqual([first, held]);
      // each retry committed its own file, so both landed on the integration tip
      const tree = await shOk(`git ls-tree -r --name-only ${s.branch}`, repo);
      expect(tree, runId).toContain("T1.txt");
      expect(tree, runId).toContain("T2.txt");
    }
  }, 120_000);
});

// ── wall-time-bounded stress harness ──────────────────────────────────────────────────────────
// Each repetition runs `concurrent` conflict-pair daemon fixtures at once (alternating arrival
// orders) and records ONE outcome per fixture — a rejection is an outcome, never a lost row. Each
// fixture runs in its OWN node process, so the bound cuts every execution path it has: the daemon,
// its detached worker groups, headless judge/review/consult commands and git. That process tree is
// torn down (frozen, killed, awaited) before the outcome is recorded, and the ledger names any pid
// that survived, so a leaked child is red.
type Mode = "pair" | "hang";
type Proc = { pid: number; ppid: number; pgid: number };
type FixtureLedger = { runId: string; ok: boolean; error?: string; tree: number; detached: number; survivors: number[] };
type Outcome = { rep: number; slot: number } & FixtureLedger;
const STRESS = process.env.TICKMARKR_TEST_STRESS;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX = createRequire(import.meta.url).resolve("tsx");
const HELPER = new URL("../../helpers/worker-barrier.ts", import.meta.url).href;
const execFileP = promisify(execFile);
const ARM_CEILING_MS = 60_000;
const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const signal = (pid: number, sig: NodeJS.Signals) => { try { process.kill(pid, sig); } catch { /* already gone */ } };
async function killOwned(c: ChildProcess) {
  if (exited(c)) return;
  try { process.kill(-c.pid!, "SIGKILL"); } catch { c.kill("SIGKILL"); }
  await once(c, "exit");
}

async function psTable(): Promise<Proc[]> {
  const { stdout } = await execFileP("ps", ["-A", "-o", "pid=,ppid=,pgid="]);
  return stdout.trim().split("\n").map((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    return { pid: pid!, ppid: ppid!, pgid: pgid! };
  });
}

/**
 * Tear down `root` and every descendant, whatever group it forked into — the SubprocessDriver's
 * workers are detached into their own process groups, so a group kill alone would miss them.
 * Freeze-then-kill: SIGSTOP each newly seen descendant until a ps pass finds none new (a stopped
 * process cannot fork out of the snapshot), then SIGKILL the whole set and await every pid's exit
 * within a bound; whatever outlives that bound is a survivor.
 */
async function teardownTree(root: ChildProcess, boundMs = 10_000): Promise<{ tree: Proc[]; survivors: number[] }> {
  const tree = new Map<number, Proc>();
  for (let grew = true; grew;) {
    grew = false;
    const rows = await psTable();
    const children = new Map<number, Proc[]>();
    for (const p of rows) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
    const queue = rows.filter((p) => p.pid === root.pid);
    for (let p = queue.shift(); p; p = queue.shift()) {
      queue.push(...(children.get(p.pid) ?? []));
      if (tree.has(p.pid)) continue;
      tree.set(p.pid, p);
      signal(p.pid, "SIGSTOP");
      grew = true;
    }
  }
  for (const pid of tree.keys()) signal(pid, "SIGKILL");
  if (!exited(root)) await once(root, "exit");
  const deadline = Date.now() + boundMs;
  let survivors = [...tree.keys()].filter(alive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    survivors = survivors.filter(alive);
  }
  return { tree: [...tree.values()], survivors };
}

/**
 * One fixture in its own owned node process. The wall-time bound runs from spawn, or from the first
 * stdout match of `armOn` (a fixture that never arms is still cut at ARM_CEILING_MS, so it cannot
 * outlive its test); the fixture reports `OUTCOME <violations>` and parks, so its tree is still
 * intact when it is torn down. Whichever comes first — outcome, exit or bound — the tree is torn
 * down and awaited before the ledger row exists.
 */
async function ownedFixture(o: { mode: Mode; runId: string; first: Id; ms: number; armOn?: RegExp }): Promise<FixtureLedger> {
  const script = [
    `const { fixtureViolations } = await import(${JSON.stringify(HELPER)});`,
    `const violations = await fixtureViolations(${JSON.stringify(o.mode)}, ${JSON.stringify(o.runId)}, ${JSON.stringify(o.first)}).catch((e) => [String(e?.stack ?? e)]);`,
    `process.stdout.write("\\nOUTCOME " + JSON.stringify(violations) + "\\n");`,
    "setInterval(() => {}, 1 << 30); // parked until the harness tears this tree down",
  ].join("\n");
  const child = spawn(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], {
    cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"],
    // the child's fixture temporaries land under this file's recorded TMPDIR, reaped with it
    env: { ...process.env, [TEST_BASE_TMPDIR_ENV]: process.env.TMPDIR },
  });
  let out = "";
  let err = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  const why = await new Promise<"expired" | "settled">((resolve) => {
    const arm = () => { timer ??= setTimeout(() => resolve("expired"), o.ms); };
    if (!o.armOn) arm(); else ceiling = setTimeout(() => resolve("expired"), ARM_CEILING_MS);
    child.stdout!.on("data", (d) => {
      out += d;
      if (o.armOn?.test(out)) arm();
      if (/^OUTCOME /m.test(out)) resolve("settled");
    });
    child.stderr!.on("data", (d) => { err = (err + d).slice(-4_000); });
    child.once("exit", () => resolve("settled"));
  });
  clearTimeout(timer);
  clearTimeout(ceiling);
  const { tree, survivors } = await teardownTree(child);
  const reported = /^OUTCOME (.*)$/m.exec(out)?.[1];
  const violations: string[] = why === "expired" ? [`${o.runId}: wall-time bound ${o.ms} ms exhausted`]
    : reported ? JSON.parse(reported) : [`${o.runId}: fixture process exited without an outcome: ${err}`];
  return {
    runId: o.runId, ok: violations.length === 0, ...(violations.length ? { error: violations.join("; ") } : {}),
    tree: tree.length, detached: tree.filter((p) => p.pgid !== child.pid).length, survivors,
  };
}

async function stressMatrix(o: { reps: number; concurrent: number; burners: number; wallMs: number }) {
  const burners: ChildProcess[] = [];
  const outcomes: Outcome[] = [];
  const deadline = Date.now() + o.wallMs;
  try {
    for (let i = 0; i < o.burners; i++) burners.push(spawn("nice", ["-n", "19", "sh", "-c", "while :; do :; done"], { stdio: "ignore", detached: true }));
    for (let rep = 0; rep < o.reps; rep++) {
      const remaining = deadline - Date.now();
      const round = await Promise.all(Array.from({ length: o.concurrent }, async (_, slot): Promise<Outcome> => {
        const runId = `run-stress-${rep}-${slot}`;
        if (remaining <= 0) return { rep, slot, runId, ok: false, error: `${runId}: wall-time bound exhausted before start`, tree: 0, detached: 0, survivors: [] };
        return { rep, slot, ...await ownedFixture({ mode: "pair", runId, first: ORDERS[slot % 2]!, ms: remaining }) };
      }));
      outcomes.push(...round);
    }
  } finally {
    await Promise.all(burners.map(killOwned));
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
    expect(ledger.tree).toBeGreaterThan(ledger.detached);
    expect(ledger.survivors).toEqual([]);
  }, 120_000);

  test.skipIf(STRESS !== "smoke" && STRESS !== "1")("the fixture smoke harness records individual success for all 4 repetitions at 2 concurrent daemon fixtures plus 0 burners with complete owned-child cleanup, so one missing outcome or leaked child fails", async () => {
    const { outcomes, burners } = await stressMatrix({ reps: 4, concurrent: 2, burners: 0, wallMs: 150_000 });
    expect(outcomes).toHaveLength(8);
    expect(outcomes.filter((r) => !r.ok)).toEqual([]);
    expect(burners).toHaveLength(0);
    // every fixture process was owned (in its torn-down tree) and nothing it spawned outlived teardown
    expect(outcomes.filter((r) => r.tree < 1 || r.survivors.length > 0)).toEqual([]);
  }, 180_000);

  // The overseer's release proof after run-end, never a task criterion: 32 × 16 daemon fixtures
  // beside 16 owned nice -n 19 burners. Skipped unless TICKMARKR_TEST_STRESS=1.
  test.skipIf(STRESS !== "1")("the fixture stress matrix records individual success for all 32 repetitions at 16 concurrent daemon fixtures plus 16 owned burners under nice -n 19 with complete owned-child cleanup", async () => {
    const { outcomes, burners } = await stressMatrix({ reps: 32, concurrent: 16, burners: 16, wallMs: 1_500_000 });
    expect(outcomes).toHaveLength(512);
    expect(outcomes.filter((r) => !r.ok)).toEqual([]);
    expect(burners).toHaveLength(16);
    expect(burners.every((c) => c.exited)).toBe(true);
    expect(outcomes.filter((r) => r.tree < 1 || r.survivors.length > 0)).toEqual([]);
  }, 1_600_000);
});
