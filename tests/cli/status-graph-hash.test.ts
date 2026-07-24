import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, loadGraph, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { engagementComparable, Journal, recordedGraphDefinitionHash, type JournalEvent } from "../../src/run/journal.js";
import { runDaemon } from "../../src/run/daemon.js";
import { setupRepo, T, COMMIT } from "../helpers/tmprepo.js";

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-graph-hash-"));
const GRAPH_HASH = "abc123";
const OTHER_HASH = "def456";
const mandatoryGates = ["build", "test", "lint", "evidence", "scope"];

const seedJournal = (repo: string, runId: string, events: JournalEvent[]) => {
  const dir = join(tickmarkrDir(repo), "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

const row = (out: string, taskId: string) => out.split("\n").find((line) => new RegExp(`\\b${taskId}\\b`).test(line))!;

const graph = (hash: string, taskIds: string[]) =>
  validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p"], hash },
    tasks: taskIds.map((id) => ({
      id, title: id, goal: `${id} goal`, shape: "implement" as const, complexity: 3,
      acceptance: ["a"], gates: mandatoryGates,
    })),
  });

const runStart = (graphDefinitionHash?: string, extra: Record<string, unknown> = {}): JournalEvent => ({
  ts: new Date().toISOString(),
  event: "run-start",
  data: { pid: process.pid, ...(graphDefinitionHash ? { graphDefinitionHash } : {}), ...extra },
});

describe("OBS-52 status graph-hash join guard", () => {
  test("test: after a journaled graph-rehash matching the compiled graph the header renders no recompile warning and no advice to start a new run", async () => {
    const repo = mkRepo();
    const g = graph(GRAPH_HASH, ["T1"]);
    saveGraph(repo, g);
    seedJournal(repo, "run-audited", [
      runStart(OTHER_HASH),
      {
        ts: new Date().toISOString(),
        event: "graph-rehash",
        data: { from: OTHER_HASH, to: graphDefinitionHash(g) },
      },
      { ts: new Date().toISOString(), event: "run-resume", data: { pid: process.pid } },
    ]);

    const snapshots = [
      await status([], repo),
      await status(["--watch"], repo, { iterations: 1, sleep: async () => {} }),
    ];
    for (const out of snapshots) {
      const header = out.split("\n")[0]!;
      expect(header).not.toContain("graph recompiled");
      expect(header).not.toContain("not comparable");
      expect(header).not.toContain("tickmarkr run");
    }
  });

  test("test: a recompile with no journaled rehash still renders the not-comparable warning and its guidance names resuming or auditing rather than starting a new run", async () => {
    const repo = mkRepo();
    saveGraph(repo, graph(GRAPH_HASH, ["T1"]));
    seedJournal(repo, "run-unaudited", [runStart(OTHER_HASH)]);

    const header = (await status([], repo)).split("\n")[0]!;
    expect(header).toContain("graph recompiled since this run — task states not comparable");
    expect(header).toMatch(/resum|audit/i);
    expect(header).not.toContain("tickmarkr run");
  });

  test("test: gate results recorded before an audited rehash render with a prior-graph marker and their channel attribution intact rather than as absent", async () => {
    const repo = mkRepo();
    const g = graph(GRAPH_HASH, ["T1"]);
    saveGraph(repo, g);
    seedJournal(repo, "run-prior-gates", [
      runStart(OTHER_HASH),
      {
        ts: new Date().toISOString(), event: "task-dispatch", taskId: "T1",
        data: { assignment: { adapter: "codex", model: "prior-model", channel: "sub", tier: "mid" }, attempt: 0 },
      },
      { ts: new Date().toISOString(), event: "gate-result", taskId: "T1", data: { gate: "build", pass: true } },
      { ts: new Date().toISOString(), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true } },
      {
        ts: new Date().toISOString(),
        event: "graph-rehash",
        data: { from: OTHER_HASH, to: graphDefinitionHash(g) },
      },
      { ts: new Date().toISOString(), event: "run-resume", data: { pid: process.pid } },
    ]);

    const taskRow = row(await status([], repo), "T1");
    expect(taskRow).toContain("B[x]");
    expect(taskRow).toContain("T[x]");
    expect(taskRow).toContain("prior graph");
    expect(taskRow).toContain("codex:prior-model");
  });

  test("test: a task merged before an audited rehash keeps its done verdict and its gate detail visible after it", async () => {
    const repo = mkRepo();
    const g = graph(GRAPH_HASH, ["T1"]);
    saveGraph(repo, g);
    seedJournal(repo, "run-prior-merge", [
      runStart(OTHER_HASH),
      {
        ts: new Date().toISOString(), event: "task-dispatch", taskId: "T1",
        data: { assignment: { adapter: "codex", model: "prior-model", channel: "sub", tier: "mid" }, attempt: 0 },
      },
      { ts: new Date().toISOString(), event: "gate-result", taskId: "T1", data: { gate: "build", pass: true, details: "exit 0" } },
      { ts: new Date().toISOString(), event: "task-done", taskId: "T1", data: { attempts: 1 } },
      { ts: new Date().toISOString(), event: "merge", taskId: "T1", data: { commit: "abc123" } },
      {
        ts: new Date().toISOString(),
        event: "graph-rehash",
        data: { from: OTHER_HASH, to: graphDefinitionHash(g) },
      },
      { ts: new Date().toISOString(), event: "run-resume", data: { pid: process.pid } },
    ]);

    const out = await status([], repo);
    expect(out).toContain("1/1 done");
    expect(row(out, "T1")).toContain("[x] T1");
    expect(row(out, "T1")).toContain("B[x]");
    expect(row(out, "T1")).toContain("done");
  });

  test("the not-comparable guard ignores a graph-rehash that does not audit the loaded graph", async () => {
    const repo = mkRepo();
    const g = graph(GRAPH_HASH, ["T1"]);
    saveGraph(repo, g);
    seedJournal(repo, "run-wrong-rehash", [
      runStart(OTHER_HASH),
      {
        ts: new Date().toISOString(),
        event: "graph-rehash",
        data: { from: "unrelated-hash", to: graphDefinitionHash(g) },
      },
      { ts: new Date().toISOString(), event: "task-done", taskId: "T1", data: {} },
    ]);

    const out = await status([], repo);
    expect(out).toContain("not comparable");
    expect(out).toContain("0/1 done");
    expect(row(out, "T1")).not.toContain("[x]");
  });

  test("the newest graph-rehash stays authoritative when an older audit happens to match the loaded graph", async () => {
    const repo = mkRepo();
    const g = graph(GRAPH_HASH, ["T1"]);
    saveGraph(repo, g);
    seedJournal(repo, "run-stale-audit", [
      runStart(OTHER_HASH),
      {
        ts: new Date().toISOString(),
        event: "graph-rehash",
        data: { from: OTHER_HASH, to: graphDefinitionHash(g) },
      },
      {
        ts: new Date().toISOString(),
        event: "graph-rehash",
        data: { from: OTHER_HASH, to: "newer-compiled-graph" },
      },
      { ts: new Date().toISOString(), event: "task-done", taskId: "T1", data: {} },
    ]);

    const out = await status([], repo);
    expect(out).toContain("not comparable");
    expect(out).toContain("0/1 done");
    expect(row(out, "T1")).not.toContain("[x]");
  });

  test("a graph-rehash stays authoritative when the loaded graph later matches the original run-start hash again", async () => {
    const repo = mkRepo();
    const g = graph(GRAPH_HASH, ["T1"]);
    const loadedHash = graphDefinitionHash(g);
    saveGraph(repo, g);
    seedJournal(repo, "run-original-hash", [
      runStart(loadedHash),
      {
        ts: new Date().toISOString(),
        event: "graph-rehash",
        data: { from: loadedHash, to: "newer-compiled-graph" },
      },
      { ts: new Date().toISOString(), event: "task-done", taskId: "T1", data: {} },
    ]);

    const out = await status([], repo);
    expect(out).toContain("not comparable");
    expect(out).toContain("0/1 done");
    expect(row(out, "T1")).not.toContain("[x]");
  });

  test("a freshly compiled graph plus a stale journal from a different graph renders every task not-yet-run with the not-comparable notice and never a done checkmark", async () => {
    const repo = mkRepo();
    saveGraph(repo, graph(GRAPH_HASH, ["T1", "T2", "T3", "T4"]));
    seedJournal(repo, "run-stale", [
      runStart(OTHER_HASH),
      { ts: new Date().toISOString(), event: "task-done", taskId: "T1", data: {} },
      { ts: new Date().toISOString(), event: "task-done", taskId: "T2", data: {} },
      { ts: new Date().toISOString(), event: "task-done", taskId: "T3", data: {} },
      { ts: new Date().toISOString(), event: "task-done", taskId: "T4", data: {} },
      {
        ts: new Date().toISOString(), event: "gate-result", taskId: "T1",
        data: { gate: "build", pass: true },
      },
    ]);
    const out = await status([], repo);
    expect(out).toContain("run run-stale");
    expect(out).toContain("graph recompiled since this run — task states not comparable");
    expect(out).toContain("0/4 done");
    for (const id of ["T1", "T2", "T3", "T4"]) {
      const line = row(out, id);
      expect(line).toMatch(/\bpending\b/);
      expect(line).not.toMatch(/\bdone\b/);
      expect(line).not.toContain("[x]");
      expect(line).not.toContain("✓");
      expect(line).not.toContain("B[x]");
    }
  });

  test("a journal whose recorded graph hash matches the loaded graph renders task states exactly as today", async () => {
    const repo = mkRepo();
    const g = graph(GRAPH_HASH, ["T1", "T2"]);
    saveGraph(repo, g);
    seedJournal(repo, "run-match", [
      runStart(graphDefinitionHash(g)),
      {
        ts: new Date().toISOString(), event: "task-dispatch", taskId: "T1",
        data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "mid" }, attempt: 0 },
      },
      { ts: new Date().toISOString(), event: "gate-result", taskId: "T1", data: { gate: "build", pass: true } },
      { ts: new Date().toISOString(), event: "task-done", taskId: "T1", data: {} },
    ]);
    const out = await status([], repo);
    expect(out).not.toContain("not comparable");
    expect(out).toContain("1/2 done");
    expect(row(out, "T1")).toMatch(/\bdone\b/);
    expect(row(out, "T1")).toContain("B[x]");
    expect(row(out, "T2")).toMatch(/\bpending\b/);
  });

  test("a journal without a recorded graph hash is treated as not comparable", async () => {
    const repo = mkRepo();
    saveGraph(repo, graph(GRAPH_HASH, ["T1"]));
    seedJournal(repo, "run-old", [
      runStart(),
      { ts: new Date().toISOString(), event: "task-done", taskId: "T1", data: {} },
    ]);
    expect(recordedGraphDefinitionHash(Journal.open(repo, "run-old").read())).toBeUndefined();
    expect(engagementComparable(Journal.open(repo, "run-old").read(), GRAPH_HASH).comparable).toBe(false);
    const out = await status([], repo);
    expect(out).toContain("not comparable");
    expect(row(out, "T1")).toMatch(/\bpending\b/);
    expect(row(out, "T1")).not.toMatch(/\bdone\b/);
  });

  test("status can no longer render a gate checkmark sourced from a journal whose graph hash does not match the loaded graph", async () => {
    const repo = mkRepo();
    saveGraph(repo, graph(GRAPH_HASH, ["T1"]));
    seedJournal(repo, "run-gates", [
      runStart(OTHER_HASH),
      {
        ts: new Date().toISOString(), event: "task-dispatch", taskId: "T1",
        data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "mid" }, attempt: 0 },
      },
      { ts: new Date().toISOString(), event: "gate-result", taskId: "T1", data: { gate: "build", pass: true } },
      { ts: new Date().toISOString(), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true } },
    ]);
    const out = await status([], repo);
    const line = row(out, "T1");
    expect(line).toContain("B[ ]");
    expect(line).not.toContain("B[x]");
    expect(line).not.toContain("T[x]");
  });

  test("the run-start journal event records the compiled graph hash", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > f.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-hash-record" });
    const start = Journal.open(repo, "run-hash-record").read().find((e) => e.event === "run-start");
    expect(start?.data.graphDefinitionHash).toBe(graphDefinitionHash(loadGraph(repo)));
  });
});
