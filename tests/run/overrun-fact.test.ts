import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { gitHead } from "../../src/run/git.js";
import { Journal, readAllTelemetry } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// Phase 48-03 (ROUTE-18 write side + VIS-11 pid recording): zero-token oracles for the daemon/journal
// write-side one-liners. The overrun fact row is the routing penalty 48-01's ProfileRow consumes; the
// pid on run-start/run-resume is the liveness surface 48-03's status.ts reads. All synthetic tmpdirs.

// Interactive driver hosting the scripted "TUI" (daemon-interactive.test.ts idiom); a step with no
// `result` emits no trailer, so the daemon reaches the !finished branch where the overrun row is written.
function idriver(): ExecutorDriver {
  const inner = new SubprocessDriver();
  return {
    id: "interactive-fake", interactive: true,
    slot: inner.slot.bind(inner), run: inner.run.bind(inner),
    waitOutput: inner.waitOutput.bind(inner), waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner), notify: inner.notify.bind(inner), close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner), status: async () => "unknown",
  } as ExecutorDriver;
};

// overrun is a v1.13-additive optional field — cast so the test compiles + asserts against UNFIXED src.
const overrunOf = (r: Record<string, unknown>) => r.overrun;

describe("ROUTE-18 overrun telemetry fact row (Phase 48-03, zero tokens)", () => {
  test("no-trailer overrun writes an attributed fact row", async () => {
    // daemon-interactive.test.ts crash idiom: exit 7 + no trailer → finished:false → !finished branch.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "echo boom; exit 7" }] } }, // no result → no trailer; process dies
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-overrun", driver: idriver() });
    expect(s.human).toEqual(["T1"]); // consult unscripted → fail-closed to human (verdict written AFTER the fact row)
    const rows = Journal.open(repo, "run-overrun").readTelemetry().filter((r) => r.taskId === "T1");
    // the dispatched assignment is read from the journal — never hardcoded
    const dispatch = Journal.open(repo, "run-overrun").read().find((e) => e.event === "task-dispatch")!;
    const a = (dispatch.data as { assignment: { adapter: string; model: string; channel: string } }).assignment;
    const row = rows.find((r) => overrunOf(r as unknown as Record<string, unknown>) === true);
    expect(row).toBeDefined(); // RED on unfixed HEAD: no such row exists
    expect(row!.outcome).toBe("failed");
    expect(row!.durationMs).toBe(0); // FACT row, not a timed attempt — the TEL-05 quotaFailover shape
    expect(row!.adapter).toBe(a.adapter); // attributed to the DISPATCHED channel
    expect(row!.model).toBe(a.model);
    expect(row!.channel).toBe(a.channel);
  }, 30_000);

  test("readAllTelemetry round-trips overrun:true (the schema-line red)", () => {
    // a synthetic telemetry.jsonl with an overrun fact row; readAllTelemetry safeParses through
    // TelemetryRowSchema — WITHOUT the schema line, zod strips the unknown key (overrun === undefined).
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-overrun-rt-"));
    const dir = join(tickmarkrDir(repo), "runs", "run-rt");
    mkdirSync(dir, { recursive: true });
    const row = { taskId: "T1", shape: "implement", adapter: "fake", model: "fake-1", channel: "sub", attempts: 1, outcome: "failed", durationMs: 0, overrun: true };
    writeFileSync(join(dir, "telemetry.jsonl"), JSON.stringify(row) + "\n");
    const rows = readAllTelemetry(repo, 50);
    const rt = rows.find((r) => r.taskId === "T1");
    expect(rt).toBeDefined();
    expect(overrunOf(rt as unknown as Record<string, unknown>)).toBe(true); // RED without the schema line
  });

  test("quota failover never writes overrun (no double-count fence)", async () => {
    // TEL-05 idiom: quota on channel A → failover to B → done. The quota branch returns/continues
    // BEFORE the overrun write site, so the quota path carries quotaFailover:true and ZERO overrun rows.
    // GREEN before and after — the no-double-count fence.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "echo 'usage limit reached for this model'; exit 1" }, // quota on A → failover to B
        { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "worked on next channel" } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-overrun-quota" });
    expect(s.done).toEqual(["T1"]);
    const rows = Journal.open(repo, "run-overrun-quota").readTelemetry().filter((r) => r.taskId === "T1");
    expect(rows.some((r) => r.quotaFailover === true)).toBe(true);
    expect(rows.every((r) => overrunOf(r as unknown as Record<string, unknown>) === undefined)).toBe(true);
  }, 30_000);
});

describe("pid recording on run-start / run-resume (Phase 48-03)", () => {
  test("fresh run records pid on run-start", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-startpid" });
    const start = Journal.open(repo, "run-startpid").read().find((e) => e.event === "run-start");
    expect(start?.data.pid).toBe(process.pid); // RED on unfixed HEAD: no pid in the data object
  }, 30_000);

  test("resumed run records pid on run-resume", async () => {
    // daemon.test.ts:155-173 resume idiom: hand-craft a prior interrupted run (T1 done), then resume.
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2", { deps: ["T1"] })],
      { tasks: {
        T1: [{ shell: "echo SHOULD-NOT-RUN && exit 1", result: { ok: false, summary: "must not run" } }],
        T2: [{ shell: `echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
      } },
    );
    const j = Journal.create(repo, "run-resumepid");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "T1");
    j.append("task-done", "T1");
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-resumepid", resume: true });
    expect(s.done).toContain("T2");
    const resume = Journal.open(repo, "run-resumepid").read().find((e) => e.event === "run-resume");
    expect(resume?.data.pid).toBe(process.pid); // RED on unfixed HEAD
  }, 30_000);
});

describe("overrun schema is additive-optional (doctrine pin)", () => {
  test("old telemetry rows without overrun parse unchanged (overrun === undefined, never false)", () => {
    // a v1.5-shape row: the eight core fields, none of the v1.6+ optional keys — parses with overrun === undefined.
    // GREEN before and after (the field is optional, mirrors quotaFailover).
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-old-row-"));
    const dir = join(tickmarkrDir(repo), "runs", "run-old");
    mkdirSync(dir, { recursive: true });
    const row = { taskId: "T1", shape: "implement", adapter: "fake", model: "fake-1", channel: "sub", attempts: 1, outcome: "done", durationMs: 5000 };
    writeFileSync(join(dir, "telemetry.jsonl"), JSON.stringify(row) + "\n");
    const rows = readAllTelemetry(repo, 50);
    const rt = rows.find((r) => r.taskId === "T1");
    expect(rt).toBeDefined();
    expect(overrunOf(rt as unknown as Record<string, unknown>)).toBeUndefined(); // never false
  });
});
