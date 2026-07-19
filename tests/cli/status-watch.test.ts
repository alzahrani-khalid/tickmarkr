import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-repo-"));
const mandatoryGates = ["build", "test", "lint", "evidence", "scope"];

// T3: the graph is fixed across this suite — hoist it so run-start can record its real graphDefinitionHash
// (comparable), keeping these rendering assertions on the replayed states rather than the notice.
const GRAPH = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [
    { id: "T1", title: "done", goal: "Finish report, then archive it.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
    { id: "T2", title: "mixed", goal: "Run mixed gates; stop on failure.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
    { id: "T3", title: "waiting", goal: "Queue the undispatched follow-up.", shape: "implement", complexity: 3, deps: ["T2"], acceptance: ["a"], gates: mandatoryGates },
  ],
});
const DEF_HASH = graphDefinitionHash(GRAPH);

const seed = (repo: string, events: JournalEvent[]) => {
  saveGraph(repo, GRAPH);
  const dir = join(tickmarkrDir(repo), "runs", "run-watch");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

const row = (out: string, taskId: string) => out.split("\n").find((line) => new RegExp(`\\b${taskId}\\b`).test(line))!;
// the v1.34 ledger frame colorizes chips and task boxes — strip ANSI to fence glyphs/order, not styling
const strip = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "");
const ts = "2026-07-14T08:00:00.000Z";
const runStart = (): JournalEvent => ({ ts, event: "run-start", data: { pid: process.pid, graphDefinitionHash: DEF_HASH } });
const dispatch = (taskId: string, model: string): JournalEvent => ({
  ts,
  event: "task-dispatch",
  taskId,
  data: { assignment: { adapter: "fake", model, channel: "sub", tier: "cheap" } },
});
const gate = (taskId: string, name: string, pass: boolean): JournalEvent => ({
  ts,
  event: "gate-result",
  taskId,
  data: { gate: name, pass },
});

const withTty = async (fn: () => Promise<void>) => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  delete process.env.NO_COLOR;
  try {
    await fn();
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

describe("status checklist rendering", () => {
  test("renders mixed gate outcomes in order and a channel once", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      dispatch("T1", "fake-1"), gate("T1", "build", true), gate("T1", "test", true), { ts, event: "task-done", taskId: "T1", data: {} },
      dispatch("T2", "fake-2"), { ts, event: "worker-result", taskId: "T2", data: { ok: true } }, gate("T2", "build", true), gate("T2", "test", false),
    ]);

    await withTty(async () => {
      const out = await status([], repo);
      expect(strip(row(out, "T2"))).toMatch(/B✓ T✗ L○ E○ S○ A- R-/);
      expect(strip(row(out, "T2"))).toContain("pending"); // data plain — no off-palette status color
      expect(row(out, "T2")).not.toContain("\x1b[36m");
      expect(row(out, "T2").match(/fake:fake-2/g)).toHaveLength(1);
    });
  });

  test("lists completed, dep-waiting, and undispatched tasks with tally and goals", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      dispatch("T1", "fake-1"), gate("T1", "build", true), gate("T1", "test", true), { ts, event: "task-done", taskId: "T1", data: {} },
      dispatch("T2", "fake-2"),
    ]);

    await withTty(async () => {
      const out = await status([], repo);
      expect(out).toContain("1/3 done");
      expect(strip(row(out, "T1"))).toContain("✓ T1 Finish report");
      expect(strip(row(out, "T2"))).toContain("- T2 Run mixed gates");
      expect(strip(row(out, "T3"))).toContain("- T3 Queue the undispatched follow-up");
      expect(row(out, "T3")).toContain("dep-waiting");
    });
  });

  test("uses ASCII boxes without ANSI when NO_COLOR or stdout is not a TTY", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      dispatch("T1", "fake-1"), gate("T1", "build", true), gate("T1", "test", true), { ts, event: "task-done", taskId: "T1", data: {} },
      dispatch("T2", "fake-2"), gate("T2", "build", true), gate("T2", "test", false), { ts, event: "task-failed", taskId: "T2", data: {} },
    ]);
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const noColor = process.env.NO_COLOR;
    try {
      for (const [ttyValue, noColorValue] of [[false, undefined], [true, "1"]] as const) {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: ttyValue });
        if (noColorValue === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = noColorValue;
        const out = await status([], repo);
        expect(out).not.toMatch(/\x1b\[/);
        expect(out).not.toMatch(/[☐✓✗⏸]/);
        expect(row(out, "T1")).toContain("[x] T1");
        expect(row(out, "T2")).toContain("[!] T2");
        expect(row(out, "T3")).toContain("[ ] T3");
        expect(row(out, "T2")).toContain("B[x] T[!]");
      }
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (noColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = noColor;
    }
  });

  test("bounded --watch returns every frame and streams non-TTY output", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), dispatch("T2", "fake-2")]);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    try {
      const out = await status(["--watch"], repo, { iterations: 2, sleep: async () => {} });
      expect(out.split("\n---\n")).toHaveLength(2);
      expect(writes.join("")).toContain("[ ] T3");
    } finally {
      spy.mockRestore();
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});
