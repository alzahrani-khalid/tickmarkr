import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { compile } from "../../src/cli/commands/compile.js";
import { status } from "../../src/cli/commands/status.js";
import { saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { acquireRunLock, isPidLive, isRunLockLive, releaseRunLock, shouldRefuse } from "../../src/run/lock.js";
import { deriveRunCockpitData } from "../../src/tui/cockpit/derive.js";
import { COMMIT, makeRepo, setupRepo, T } from "../helpers/tmprepo.js";

// LOCK-04 pid seam: the table itself is exercised unmocked everywhere else in this file. This wrapper
// exists so ONE test can change the table's answer and watch the two surfaces that consume it move —
// a consumer that kept its own `process.kill(pid, 0)` cannot move, which is the drift being fenced.
// `forced` is undefined for every other test, so they see the real predicate.
const table = vi.hoisted(() => ({ forced: undefined as boolean | undefined }));
vi.mock("../../src/run/lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/lock.js")>();
  return { ...actual, isPidLive: (pid: number) => table.forced ?? actual.isPidLive(pid) };
});

// The copy two callers wrote by hand: ANY thrown probe error is read as death. Kept here as the
// falsifier — it is what these tests must be able to catch.
const anyThrowIsDeath = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// zero-token: real foreign pids only (spawnSync("true") = reaped-dead, spawn("sleep") = live), no CLIs.
const STALE_PAST = 600_000; // 10 min > STALE_MS (60s) — the "expired heartbeat" fixture

const tmp = () => mkdtempSync(join(tmpdir(), "tickmarkr-lock-"));
const lockOf = (dir: string) => join(tickmarkrDir(dir), "graph.lock");

function plantLock(dir: string, payload: unknown, ageMs = 0): string {
  const p = lockOf(dir);
  writeFileSync(p, typeof payload === "string" ? payload : JSON.stringify(payload));
  if (ageMs) { const t = new Date(Date.now() - ageMs); utimesSync(p, t, t); }
  return p;
}

describe("run lock decision table (HARD-01, HARD-02)", () => {
  const dirs: string[] = [];
  const mk = () => { const d = tmp(); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs) releaseRunLock(d); dirs.length = 0; });

  test("row 1: acquire creates the lock; a second same-process acquire refuses naming our (alive) pid", () => {
    const dir = mk();
    const r = acquireRunLock(dir, "run-x");
    expect(r.reclaimed).toBeUndefined();
    expect(JSON.parse(readFileSync(lockOf(dir), "utf8"))).toMatchObject({ pid: process.pid, runId: "run-x" });
    expect(() => acquireRunLock(dir, "run-y")).toThrow(String(process.pid));
  });

  test("row 2: pid 1 (init) + fresh heartbeat refuses — EPERM means ALIVE, never dead", () => {
    const dir = mk();
    plantLock(dir, { pid: 1, runId: "run-init", startedAt: Date.now() });
    expect(() => acquireRunLock(dir, "run-me")).toThrow(/held by pid 1/);
  });

  test("row 3: dead holder + expired heartbeat → reclaim, returns old pid, new lock is ours", () => {
    const dir = mk();
    const dead = spawnSync("true").pid!;
    plantLock(dir, { pid: dead, runId: "run-dead", startedAt: Date.now() - STALE_PAST }, STALE_PAST);
    const r = acquireRunLock(dir, "run-me");
    expect(r.reclaimed).toEqual({ pid: dead, mtimeMs: expect.any(Number) });
    expect(JSON.parse(readFileSync(lockOf(dir), "utf8")).pid).toBe(process.pid);
  });

  test("row 4: dead holder + fresh heartbeat → SELF-CLEAR via reclaim (OBS-05, LOCK-02)", () => {
    // OBS-05: after killing a dead daemon, tickmarkr resume refused with "holder pid … is dead but its
    // heartbeat hasn't expired — retry in ≤60s or run `tickmarkr unlock`". A PROVABLY-dead holder
    // (kill(pid,0) → ESRCH) now self-clears through the existing race-guarded reclaim branch —
    // no 60s heartbeat wait, no `tickmarkr unlock` demanded. Today (RED) this throws the heartbeat message.
    const dir = mk();
    const dead = spawnSync("true").pid!;
    plantLock(dir, { pid: dead, runId: "run-dead", startedAt: Date.now() }); // dead + FRESH mtime
    const r = acquireRunLock(dir, "run-me");
    expect(r.reclaimed).toEqual({ pid: dead, mtimeMs: expect.any(Number) });
    expect(JSON.parse(readFileSync(lockOf(dir), "utf8")).pid).toBe(process.pid);
  });

  test("row 5: live foreign process holds the lock → refuses naming that pid", () => {
    const dir = mk();
    const child = spawn("sleep", ["30"]);
    try {
      plantLock(dir, { pid: child.pid, runId: "run-foreign", startedAt: Date.now() });
      expect(() => acquireRunLock(dir, "run-me")).toThrow(String(child.pid));
    } finally {
      child.kill();
    }
  });

  test("row 6a: garbage payload refuses unconditionally — mtime irrelevant, only `tickmarkr unlock` removes it (LOCK-01)", () => {
    const dir = mk();
    plantLock(dir, "not json {{{", STALE_PAST);
    expect(() => acquireRunLock(dir, "run-me")).toThrow(/tickmarkr unlock/);
    expect(existsSync(lockOf(dir))).toBe(true); // NOT reclaimed — the garbage lock survives
  });

  test("row 6c: zero-byte lock (torn write) refuses fresh AND expired; isRunLockLive true for both (LOCK-01, v1.6 compat)", () => {
    const fresh = mk();
    plantLock(fresh, "");
    expect(() => acquireRunLock(fresh, "run-me")).toThrow(/tickmarkr unlock/);
    expect(isRunLockLive(fresh)).toBe(true);
    const stale = mk();
    plantLock(stale, "", STALE_PAST);
    expect(() => acquireRunLock(stale, "run-me")).toThrow(/tickmarkr unlock/);
    expect(isRunLockLive(stale)).toBe(true);
  });

  test("acquireRunLock refusals (live holder, garbage) name `tickmarkr unlock` and never say delete", () => {
    // Post-LOCK-02 the only refusal rows are live-holder and garbage (dead self-clears, OBS-05).
    const liveDir = mk();
    plantLock(liveDir, { pid: process.pid, runId: "r", startedAt: Date.now() }); // alive
    expect(() => acquireRunLock(liveDir, "run-me")).toThrow(/tickmarkr unlock/);
    try { acquireRunLock(liveDir, "run-me"); } catch (e) { expect((e as Error).message).not.toMatch(/delete/i); }
    const garbageDir = mk();
    plantLock(garbageDir, "not json {{{");
    expect(() => acquireRunLock(garbageDir, "run-me")).toThrow(/tickmarkr unlock/);
    try { acquireRunLock(garbageDir, "run-me"); } catch (e) { expect((e as Error).message).not.toMatch(/delete/i); }
  });

  test("row 6b: garbage payload + fresh heartbeat → refuses (fail closed)", () => {
    const dir = mk();
    plantLock(dir, "not json {{{");
    expect(() => acquireRunLock(dir, "run-me")).toThrow(/graph\.lock/);
  });

  test("release removes our lock; a fresh acquire then succeeds", () => {
    const dir = mk();
    acquireRunLock(dir, "run-a");
    releaseRunLock(dir);
    expect(existsSync(lockOf(dir))).toBe(false);
    expect(() => acquireRunLock(dir, "run-b")).not.toThrow();
  });

  test("release never deletes a lock whose payload pid is not ours", () => {
    const dir = mk();
    const foreign = spawnSync("true").pid!;
    plantLock(dir, { pid: foreign, runId: "run-foreign", startedAt: Date.now() });
    releaseRunLock(dir);
    expect(existsSync(lockOf(dir))).toBe(true);
  });

  test("isRunLockLive: true for a live holder, false for none/dead (expired OR fresh — OBS-05)", () => {
    const dir = mk();
    expect(isRunLockLive(dir)).toBe(false);
    plantLock(dir, { pid: process.pid, runId: "run-x", startedAt: Date.now() });
    expect(isRunLockLive(dir)).toBe(true);
    const dead = spawnSync("true").pid!;
    plantLock(dir, { pid: dead, runId: "run-dead", startedAt: Date.now() - STALE_PAST }, STALE_PAST);
    expect(isRunLockLive(dir)).toBe(false);
    // OBS-05: a provably-dead holder reads not-live EVEN with a fresh heartbeat (compile agrees with resume)
    plantLock(dir, { pid: spawnSync("true").pid!, runId: "run-dead2", startedAt: Date.now() });
    expect(isRunLockLive(dir)).toBe(false);
  });
});

describe("run lock at the daemon seam (fake adapter, zero tokens)", () => {
  test("concurrent: a second overlapping runDaemon rejects naming the holder pid; the first completes", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `sleep 1 && echo x > f.txt && ${COMMIT} x`, result: { ok: true, summary: "x" } }] } },
    );
    const first = runDaemon(repo, { adapters: [fake], runId: "run-a" });
    await new Promise((r) => setTimeout(r, 200)); // let the first acquire the lock while its task sleeps
    // both daemons share one process, so kill(pid,0) sees "alive" — the refuse-live row, at the seam
    await expect(runDaemon(repo, { adapters: [fake], runId: "run-b" })).rejects.toThrow(String(process.pid));
    const s = await first;
    expect(s.done).toEqual(["T1"]);
  });

  test("journaled: a pre-planted stale lock is reclaimed and journaled once with the old pid", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo x > f.txt && ${COMMIT} x`, result: { ok: true, summary: "x" } }] } },
    );
    const dead = spawnSync("true").pid!;
    plantLock(repo, { pid: dead, runId: "run-old", startedAt: Date.now() - STALE_PAST }, STALE_PAST);
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-reclaim" });
    expect(s.done).toEqual(["T1"]);
    const reclaims = Journal.open(repo, "run-reclaim").read().filter((e) => e.event === "lock-reclaimed");
    expect(reclaims).toHaveLength(1);
    expect(reclaims[0].data.pid).toBe(dead);
  });

  test("OBS-05: a pre-planted dead+FRESH lock is reclaimed and runDaemon proceeds (resume-shaped)", async () => {
    // The incident shape: a reaped-dead holder pid with a FRESH heartbeat mtime. Today (RED) runDaemon's
    // acquireRunLock throws "… is dead but its heartbeat hasn't expired"; post-LOCK-02 it self-clears
    // and the resume-shaped daemon runs to completion, journaled once with the old pid.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo x > f.txt && ${COMMIT} x`, result: { ok: true, summary: "x" } }] } },
    );
    const dead = spawnSync("true").pid!;
    plantLock(repo, { pid: dead, runId: "run-old", startedAt: Date.now() }); // dead + FRESH — the OBS-05 shape
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-resume" });
    expect(s.done).toEqual(["T1"]);
    const reclaims = Journal.open(repo, "run-resume").read().filter((e) => e.event === "lock-reclaimed");
    expect(reclaims).toHaveLength(1);
    expect(reclaims[0].data.pid).toBe(dead);
  });

  test("released: lock gone after a normal run; a second sequential run is not blocked by a stale lock", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo x > f.txt && ${COMMIT} x`, result: { ok: true, summary: "x" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-1" });
    expect(existsSync(lockOf(repo))).toBe(false);
    // Q150s: the completed graph now refuses a second FRESH run (nothing to dispatch) — the
    // lock contract this test defends is that the refusal comes from the graph, never from a
    // stale lock, and that the lock is released again on the refusal path's finally.
    await expect(runDaemon(repo, { adapters: [fake], runId: "run-2" })).rejects.toThrow(/nothing to dispatch/);
    expect(existsSync(lockOf(repo))).toBe(false);
  });
});

// LOCK-02: link(2) atomic acquire — the lock never exists without a complete payload, and no
// graph.lock.<pid>.tmp handle survives any non-crash path (winner, EEXIST loser, reclaim).
const listStateDir = (dir: string) => readdirSync(tickmarkrDir(dir));
const noTmp = (dir: string) => listStateDir(dir).filter((f) => f.endsWith(".tmp"));

describe("LOCK-02 atomic acquire (link(2), no temp litter)", () => {
  const dirs: string[] = [];
  const mk = () => { const d = tmp(); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs) releaseRunLock(d); dirs.length = 0; });

  test("Test A — EEXIST loser leaves no *.tmp litter, only graph.lock survives", () => {
    const dir = mk();
    plantLock(dir, { pid: process.pid, runId: "run-live", startedAt: Date.now() }); // alive ⇒ refuse
    expect(() => acquireRunLock(dir, "run-me")).toThrow();
    expect(noTmp(dir)).toEqual([]); // the loser's temp handle is unlinked in finally
    expect(listStateDir(dir)).toContain("graph.lock"); // the live lock is untouched
  });

  test("Test B — winner leaves no *.tmp and a complete JSON payload", () => {
    const dir = mk();
    const r = acquireRunLock(dir, "run-win");
    expect(r.reclaimed).toBeUndefined();
    expect(noTmp(dir)).toEqual([]);
    const payload = JSON.parse(readFileSync(lockOf(dir), "utf8"));
    expect(payload).toMatchObject({ pid: process.pid, runId: "run-win" });
    expect(typeof payload.startedAt).toBe("number");
  });

  test("Test C — reclaim path leaves no *.tmp and a complete new payload", () => {
    const dir = mk();
    const dead = spawnSync("true").pid!;
    plantLock(dir, { pid: dead, runId: "run-dead", startedAt: Date.now() - STALE_PAST }, STALE_PAST);
    const r = acquireRunLock(dir, "run-me");
    expect(r.reclaimed).toEqual({ pid: dead, mtimeMs: expect.any(Number) });
    expect(noTmp(dir)).toEqual([]);
    const payload = JSON.parse(readFileSync(lockOf(dir), "utf8"));
    expect(payload).toMatchObject({ pid: process.pid, runId: "run-me" });
    expect(typeof payload.startedAt).toBe("number");
  });
});

// LOCK-04 decision table — one predicate, two entry points. Post-16-02 behavior:
// refuse everywhere except dead+expired (the only reclaim row); garbage refuses at any mtime (LOCK-01).
describe("LOCK-04 decision table — one predicate, two entry points", () => {
  const dirs: string[] = [];
  const mk = () => { const d = tmp(); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs) releaseRunLock(d); dirs.length = 0; });

  // Each row: a planted lock and the CURRENT expected refuse verdict (true = refuse, false = reclaim).
  const rows: { name: string; payload: () => unknown; age: number; refuse: boolean }[] = [
    { name: "alive (process.pid) + fresh", payload: () => ({ pid: process.pid, runId: "r", startedAt: Date.now() }), age: 0, refuse: true },
    { name: "alive (process.pid) + expired", payload: () => ({ pid: process.pid, runId: "r", startedAt: Date.now() - STALE_PAST }), age: STALE_PAST, refuse: true }, // live holder NEVER reclaims, even on a stale heartbeat (mutation drill: !(dead||expired) reds here)
    { name: "EPERM (pid 1) + fresh", payload: () => ({ pid: 1, runId: "r", startedAt: Date.now() }), age: 0, refuse: true },
    { name: "dead + fresh", payload: () => ({ pid: spawnSync("true").pid!, runId: "r", startedAt: Date.now() }), age: 0, refuse: false }, // OBS-05: dead ⇒ self-clear, mtime irrelevant
    { name: "dead + expired", payload: () => ({ pid: spawnSync("true").pid!, runId: "r", startedAt: Date.now() - STALE_PAST }), age: STALE_PAST, refuse: false },
    { name: "garbage + fresh", payload: () => "not json {{{", age: 0, refuse: true },
    { name: "garbage + expired", payload: () => "not json {{{", age: STALE_PAST, refuse: true }, // LOCK-01 flip: garbage refuses at any mtime
  ];

  test("Test D — acquireRunLock and isRunLockLive agree on every row (drift oracle)", () => {
    for (const row of rows) {
      const dir = mk();
      plantLock(dir, row.payload(), row.age);
      // Entry point 1: read-only predicate.
      expect(isRunLockLive(dir), `${row.name}: isRunLockLive`).toBe(row.refuse);
      // Entry point 2: mutating acquire — throws iff refuse, else reclaims.
      if (row.refuse) {
        expect(() => acquireRunLock(dir, "run-me"), `${row.name}: acquire refuses`).toThrow();
      } else {
        const r = acquireRunLock(dir, "run-me");
        expect(r.reclaimed, `${row.name}: acquire reclaims`).toBeDefined();
        releaseRunLock(dir);
      }
    }
  });

  test("Test E — shouldRefuse is the source: false for dead (ESRCH proof-positive; expiry dropped, OBS-05)", () => {
    expect(shouldRefuse({ garbage: false, dead: true })).toBe(false);
    expect(shouldRefuse({ garbage: false, dead: false })).toBe(true); // alive ⇒ refuse (expiry no longer participates)
  });

  test("Test F — garbage short-circuits shouldRefuse: refuses regardless of dead (LOCK-01)", () => {
    expect(shouldRefuse({ garbage: true, dead: true })).toBe(true);
    expect(shouldRefuse({ garbage: true, dead: false })).toBe(true);
  });
});

// LOCK-01 BLOCKER: compile acquires the run lock — a stale garbage lock must refuse HONESTLY and
// name the escape, not falsely claim a live run and dead-end the operator.
describe("compile refuses on a stale garbage lock, naming `tickmarkr unlock` (LOCK-01 BLOCKER)", () => {
  test("stale garbage lock → compile rejects naming `tickmarkr unlock`, not a bare live-run claim", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    cpSync("fixtures/sample.prd.md", join(repo, "feature.prd.md"));
    plantLock(repo, "not json {{{", STALE_PAST); // garbage + expired → acquireRunLock refuses post-16-02
    await expect(compile(["feature.prd.md"], repo)).rejects.toThrow(/tickmarkr unlock/);
    await expect(compile(["feature.prd.md"], repo)).rejects.not.toThrow(/held by a live tickmarkr run/);
  });
});

// T5 / Sol #3: compile holds the same link(2) lock as runDaemon around saveGraph.
describe("compile acquires graph lock around saveGraph (T5)", () => {
  test("compile fails with a clear message naming the holder when the lock is held", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    cpSync("fixtures/sample.prd.md", join(repo, "feature.prd.md"));
    acquireRunLock(repo, "run-active");
    try {
      await expect(compile(["feature.prd.md"], repo)).rejects.toThrow(/held by pid/);
      await expect(compile(["feature.prd.md"], repo)).rejects.toThrow(/run-active/);
    } finally {
      releaseRunLock(repo);
    }
  });

  test("compile releases the lock after a successful save", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    cpSync("fixtures/sample.prd.md", join(repo, "feature.prd.md"));
    await compile(["feature.prd.md"], repo);
    expect(existsSync(lockOf(repo))).toBe(false);
    expect(isRunLockLive(repo)).toBe(false);
  });

  test("compile releases the lock when the save throws", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    cpSync("fixtures/sample.prd.md", join(repo, "feature.prd.md"));
    const graphMod = await import("../../src/graph/graph.js");
    const spy = vi.spyOn(graphMod, "saveGraph").mockImplementation(() => {
      throw new Error("save boom");
    });
    await expect(compile(["feature.prd.md"], repo)).rejects.toThrow("save boom");
    spy.mockRestore();
    expect(existsSync(lockOf(repo))).toBe(false);
    expect(isRunLockLive(repo)).toBe(false);
  });
});

// LOCK-04, pid-scoped. lock.ts stated that its inspection is the one decision table and that a second
// `process.kill(pid, 0)` elsewhere would be a copy free to drift — while exporting only
// REPOSITORY-scoped helpers, so a caller holding a pid off a journal row had no seam to consume and
// wrote the four lines itself. Two did. The cockpit's copy swallowed every error, so a daemon owned
// by another user read dead there and alive in the lock.
describe("LOCK-04 pid-scoped seam — one predicate for every pid-liveness call site", () => {
  const runStartRaw = (pid: number) =>
    JSON.stringify({ ts: "2026-08-26T00:00:00.000Z", event: "run-start", data: { pid } }) + "\n";

  // The cockpit's answer, read off the only field it publishes: an active run whose daemon is alive
  // is `running`; the same journal with a dead daemon is `interrupted`.
  const cockpitStatus = (pid: number) =>
    deriveRunCockpitData({ fileName: "run-20260826-000000.journal.jsonl", raw: runStartRaw(pid) }, "0.0.0-test").status;

  // The live status board's answer, in the words it prints to the operator.
  const boardLine = async (pid: number): Promise<string> => {
    const repo = tmp();
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] }],
    }));
    const dir = join(tickmarkrDir(repo), "runs", "run-seam");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "journal.jsonl"), runStartRaw(pid));
    return status([], repo);
  };

  test("a pid whose signal probe is refused for permission reads live through the exported predicate so a daemon owned by another user is never called dead while a probe treating any thrown error as death fails", () => {
    // pid 1 (launchd/init) is alive and owned by root: kill(1, 0) is REFUSED EPERM for an
    // unprivileged user. Assert the fixture itself — a probe that never throws proves nothing here.
    let code: string | undefined;
    try { process.kill(1, 0); } catch (e) { code = (e as NodeJS.ErrnoException).code; }
    expect(code).toBe("EPERM");

    expect(isPidLive(1)).toBe(true); // EPERM is not evidence of death

    // the hand-written copy, on the same pid: it calls a live daemon dead.
    expect(anyThrowIsDeath(1)).toBe(false);
    expect(anyThrowIsDeath(1)).not.toBe(isPidLive(1));

    // and the two still agree where death is PROVABLE — so the disagreement above is EPERM alone,
    // not a predicate that answers "live" to everything.
    const reaped = spawnSync("true").pid!;
    expect(isPidLive(reaped)).toBe(false);
    expect(anyThrowIsDeath(reaped)).toBe(false);
  });

  test("the cockpit and the live status board both answer pid liveness through that one exported predicate so changing the table changes every answer while a caller keeping its own probe disagrees with the table", async () => {
    const reaped = spawnSync("true").pid!; // provably dead (ESRCH)

    // Baseline, table unchanged: each surface reports what the real table says about its pid.
    expect(cockpitStatus(1)).toBe("running");
    expect(await boardLine(1)).toContain("daemon pid 1 alive");
    expect(cockpitStatus(reaped)).toBe("interrupted");
    expect(await boardLine(reaped)).toContain(`daemon pid ${reaped} dead`);

    // Change the TABLE, touch neither surface. Both must move — including against what their own
    // probe would have said about these very pids, which is what makes this more than a restatement.
    try {
      table.forced = true;
      expect(cockpitStatus(reaped)).toBe("running");
      expect(await boardLine(reaped)).toContain(`daemon pid ${reaped} alive`);
      table.forced = false;
      expect(cockpitStatus(1)).toBe("interrupted");
      expect(await boardLine(1)).toContain("daemon pid 1 dead");
    } finally {
      table.forced = undefined;
    }

    // The falsifier: a consumer keeping its own probe cannot move with the table — it answers the
    // same thing before, during and after the change, and is wrong about the EPERM pid throughout.
    try {
      table.forced = true;
      expect(anyThrowIsDeath(1)).toBe(false);
      expect(anyThrowIsDeath(1)).not.toBe(isPidLive(1));
    } finally {
      table.forced = undefined;
    }
  });
});
