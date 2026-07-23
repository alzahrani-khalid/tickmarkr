import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";

// Phase 48-03 (VIS-11 / SC4): `tickmarkr status` shows the age of the last journal event and whether the
// recorded daemon pid is alive — honest about unknowns, a pure reader (kill(pid,0) signal probe only).
// Synthetic tmpdir journals; assertions on distinct fixture-driven outcomes (dead vs alive vs unknown),
// never one string narration. The tokens "alive"/"dead"/"unknown" are the test currency.

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-liveness-"));

const seedGraph = (repo: string) => {
  const graph = validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] }],
  });
  saveGraph(repo, graph);
  return graph;
};

const seedJournal = (repo: string, events: JournalEvent[]) => {
  const dir = join(tickmarkrDir(repo), "runs", "run-liveness");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

const ev = (event: string, data: Record<string, unknown> = {}, ts = new Date().toISOString(), taskId?: string): JournalEvent => ({
  ts, event, ...(taskId ? { taskId } : {}), data,
});

describe("VIS-11 status liveness (SC4)", () => {
  test("dead recorded pid renders dead", async () => {
    const repo = mkRepo();
    seedGraph(repo);
    const dead = spawnSync("true").pid!; // reaped-dead foreign pid (lock.test.ts idiom) → kill(pid,0) ESRCH
    seedJournal(repo, [ev("run-start", { pid: dead })]);
    const out = await status([], repo);
    expect(out).toContain("dead");
    expect(out).not.toContain("alive");
  });

  test("dead pid after run-end renders finished, not dead (clean exit is not a crash)", async () => {
    const repo = mkRepo();
    seedGraph(repo);
    const dead = spawnSync("true").pid!;
    seedJournal(repo, [ev("run-start", { pid: dead }), ev("run-end", { done: ["T1"] })]);
    const out = await status([], repo);
    expect(out).toContain("finished");
    expect(out).not.toContain("dead");
  });

  test("status for a setup-failed run shows the recorded failure cause", async () => {
    const repo = mkRepo();
    seedGraph(repo);
    const dead = spawnSync("true").pid!;
    seedJournal(repo, [
      ev("run-start", { pid: dead }),
      ev("run-end", { phase: "setup", error: "cannot lock ref refs/heads/tickmarkr/run-x", fatal: true }),
    ]);

    const out = await status([], repo);

    expect(out).toContain("finished");
    expect(out).toContain("setup failed");
    expect(out).toContain("cannot lock ref refs/heads/tickmarkr/run-x");
  });

  test("live recorded pid renders alive", async () => {
    const repo = mkRepo();
    seedGraph(repo);
    seedJournal(repo, [ev("run-start", { pid: process.pid })]); // this test process is alive
    const out = await status([], repo);
    expect(out).toContain("alive");
    expect(out).not.toContain("dead");
  });

  test("pid-less journal renders unknown (never fabricated)", async () => {
    const repo = mkRepo();
    seedGraph(repo);
    seedJournal(repo, [ev("run-start", {})]); // pre-v1.13 corpus shape: no pid key
    const out = await status([], repo);
    expect(out).toContain("unknown");
    expect(out).not.toContain("alive");
    expect(out).not.toContain("dead");
  });

  test("garbage pid data renders unknown (non-integer / ≤0 fail toward unknown)", async () => {
    const repo = mkRepo();
    seedGraph(repo);
    seedJournal(repo, [ev("run-start", { pid: "50938" })]); // string, not a positive integer
    const out = await status([], repo);
    expect(out).toContain("unknown");
    expect(out).not.toContain("alive");
    expect(out).not.toContain("dead");
  });

  test("last-event age renders a minutes-form when backdated", async () => {
    const repo = mkRepo();
    seedGraph(repo);
    const past = new Date(Date.now() - 120_000).toISOString(); // 2 minutes ago
    seedJournal(repo, [
      ev("run-start", { pid: process.pid }, past),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "fake-1" } }, past, "T1"),
    ]);
    const out = await status([], repo);
    expect(out).toContain("2m"); // floor(120000/60000) === 2
  });

  test("last-event age renders a seconds-form when fresh", async () => {
    const repo = mkRepo();
    seedGraph(repo);
    seedJournal(repo, [ev("run-start", { pid: process.pid })]); // ts ≈ now
    const out = await status([], repo);
    expect(out).toMatch(/\b\d+s\b/); // <90_000ms ⇒ seconds form
  });

  test("run-resume wins over run-start (last valid pid wins)", async () => {
    const repo = mkRepo();
    seedGraph(repo);
    const dead = spawnSync("true").pid!;
    seedJournal(repo, [
      ev("run-start", { pid: dead }),       // older recording: dead daemon
      ev("run-resume", { pid: process.pid }), // newer recording: this live process
    ]);
    const out = await status([], repo);
    expect(out).toContain("alive");
    expect(out).not.toContain("dead");
  });

  test("a live worker phase reports its no-output age from the watcher-local clock", async () => {
    const repo = mkRepo();
    const graph = seedGraph(repo);
    const startedAt = Date.parse("2026-07-23T08:00:00.000Z");
    seedJournal(repo, [
      ev("run-start", { pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) }, new Date(startedAt - 1_000).toISOString()),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "fake-1" } }, new Date(startedAt).toISOString(), "T1"),
      ev("phase-start", { phase: "worker" }, new Date(startedAt).toISOString(), "T1"),
    ]);

    const out = await status(["--watch"], repo, {
      iterations: 1,
      sleep: async () => {},
      now: () => startedAt + 7_000,
    });

    expect(out).toContain("worker");
    expect(out).toContain("no output 7s");
  });

  test("a live worker phase advances last-output age from watcher-local pane observations", async () => {
    const repo = mkRepo();
    const graph = seedGraph(repo);
    const startedAt = Date.parse("2026-07-23T08:00:00.000Z");
    seedJournal(repo, [
      ev("run-start", { pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) }, new Date(startedAt - 1_000).toISOString()),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "fake-1" }, attempt: 2 }, new Date(startedAt).toISOString(), "T1"),
      ev("phase-start", { phase: "worker", attempt: 2 }, new Date(startedAt).toISOString(), "T1"),
    ]);
    const times = [startedAt + 7_000, startedAt + 9_000, startedAt + 12_000];
    const reads: Array<string | undefined> = ["first visible output", "first visible output"];

    const out = await status(["--watch"], repo, {
      iterations: 3,
      sleep: async () => {},
      now: () => times.shift()!,
      readWorkerOutput: async () => reads.shift(),
    });

    const frames = out.split("\n---\n");
    expect(frames[0]).toContain("no output 7s");
    expect(frames[1]).toContain("last output 2s ago");
    expect(frames[2]).toContain("last output 5s ago");
  });
});
