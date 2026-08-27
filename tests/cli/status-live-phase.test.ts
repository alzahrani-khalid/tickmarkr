import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";

const RUN_ID = "run-live-phase";
const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const PHASE_STARTED = NOW - 8 * 60 * 60 * 1000;

const mkRepo = (): string => mkdtempSync(join(tmpdir(), "tickmarkr-status-live-phase-"));

const seedGraph = (repo: string) => {
  const graph = validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["plan.md"], hash: "status-live-phase" },
    tasks: [{
      id: "T1",
      title: "Ship the task",
      goal: "Ship the task.",
      shape: "implement",
      complexity: 3,
      acceptance: ["done"],
    }],
  });
  saveGraph(repo, graph);
  return graph;
};

const phaseJournal = (hash: string, pid: unknown, includePid = true): JournalEvent[] => [
  {
    ts: new Date(PHASE_STARTED - 2_000).toISOString(),
    event: "run-start",
    data: { ...(includePid ? { pid } : {}), graphDefinitionHash: hash },
  },
  {
    ts: new Date(PHASE_STARTED - 1_000).toISOString(),
    event: "task-dispatch",
    taskId: "T1",
    data: { attempt: 0, assignment: { adapter: "fake", model: "fake-1" } },
  },
  {
    ts: new Date(PHASE_STARTED).toISOString(),
    event: "phase-start",
    taskId: "T1",
    data: { phase: "worker", attempt: 0 },
  },
];

const writeJournal = (repo: string, events: JournalEvent[]): void => {
  const dir = join(tickmarkrDir(repo), "runs", RUN_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
};

const plain = (value: string): string => value
  .replace(/\x1b\][^\x07]*\x07/gu, "")
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "");

const flattened = (value: string): string => plain(value).replace(/\s+/gu, " ");

const watchFrame = async (
  repo: string,
  readWorkerOutput?: () => Promise<string | undefined>,
): Promise<{ frame: string; writes: string }> => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const noColor = process.env.NO_COLOR;
  const writes: string[] = [];
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
  delete process.env.NO_COLOR;
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    const frame = await status(["--watch", RUN_ID], repo, {
      iterations: 2,
      sleep: async () => {},
      now: () => NOW,
      ...(readWorkerOutput ? { readWorkerOutput } : {}),
    });
    return { frame, writes: writes.join("") };
  } finally {
    write.mockRestore();
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (columns) Object.defineProperty(process.stdout, "columns", columns);
    else delete (process.stdout as { columns?: number }).columns;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

describe("status live phases require a daemon that is not proved dead", () => {
  test("test: a journal whose recorded daemon process id is provably dead and whose newest phase marker has no matching outcome renders no live phase in any task cell or terminal title; the same journal recording this live process renders it; a fold that never consults the liveness the same frame prints fails", async () => {
    const repo = mkRepo();
    const graph = seedGraph(repo);
    const deadPid = spawnSync("true").pid!;
    writeJournal(repo, phaseJournal(graphDefinitionHash(graph), deadPid));
    const deadScrape = vi.fn(async () => "stale pane output");

    const dead = await watchFrame(repo, deadScrape);
    expect(flattened(dead.frame)).toContain(`daemon pid ${deadPid} dead`);
    expect(flattened(dead.frame)).not.toContain("worker · 8h0m0s elapsed");
    expect(dead.writes).not.toContain("\x1b]0;⏳ T1 worker");
    expect(deadScrape).not.toHaveBeenCalled();

    writeJournal(repo, phaseJournal(graphDefinitionHash(graph), process.pid));
    const liveScrape = vi.fn(async () => "live pane output");
    const live = await watchFrame(repo, liveScrape);
    expect(flattened(live.frame)).toContain(`daemon pid ${process.pid} alive`);
    expect(flattened(live.frame)).toContain("worker · 8h0m0s elapsed");
    expect(live.writes).toContain("\x1b]0;⏳ T1 worker 8h0m0s\x07");
    expect(liveScrape).toHaveBeenCalled();
  });

  test("test: a journal whose recorded daemon process id is absent or is not a positive integer still renders its unmatched phase marker; a guard suppressing on anything short of a proved death blanks every pre-identity journal and fails", async () => {
    for (const reading of [
      { includePid: false, pid: undefined },
      { includePid: true, pid: 0 },
      { includePid: true, pid: -7 },
      { includePid: true, pid: 1.5 },
      { includePid: true, pid: "123" },
    ]) {
      const repo = mkRepo();
      const graph = seedGraph(repo);
      writeJournal(repo, phaseJournal(graphDefinitionHash(graph), reading.pid, reading.includePid));

      const frame = plain(await status([RUN_ID], repo, { now: () => NOW }));
      expect(frame).toContain("daemon pid unknown");
      expect(frame).toContain("worker · 8h0m0s elapsed");
    }
  });

  test("test: a process id whose signal probe is refused for permission still renders its live phase because the shared liveness predicate calls it alive; a locally written probe treating any thrown error as death fails", async () => {
    const repo = mkRepo();
    const graph = seedGraph(repo);
    const refusedPid = 424_242;
    writeJournal(repo, phaseJournal(graphDefinitionHash(graph), refusedPid));
    const permissionError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw permissionError; });
    try {
      const frame = plain(await status([RUN_ID], repo, { now: () => NOW }));
      expect(frame).toContain(`daemon pid ${refusedPid} alive`);
      expect(frame).toContain("worker · 8h0m0s elapsed");
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      kill.mockRestore();
    }
  });

  test("the live-phase fold and the daemon liveness line read one derived liveness value, so a diff leaving each of them to probe the process id on its own fails", () => {
    const source = readFileSync(new URL("../../src/cli/commands/status.ts", import.meta.url), "utf8");

    expect(source.match(/\bdaemonLiveness\(events\)/gu)).toHaveLength(1);
    expect(source.match(/\bisPidLive\(/gu)).toHaveLength(1);
    expect(source).not.toMatch(/process\.kill\s*\(/u);
    expect(source).toMatch(/const phases = comparable && daemon\.state !== "dead" \? livePhases\(events\)/u);
    expect(source.match(/liveness\(events, daemon, now\)/gu)).toHaveLength(2);
  });
});
