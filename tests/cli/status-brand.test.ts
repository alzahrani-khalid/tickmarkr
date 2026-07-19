import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { BANNER } from "../../src/brand.js";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";

// T3 (v1.50): the watch cockpit restyles the TTY frame through src/brand.ts. The non-TTY
// surface is machine-consumed and byte-pinned: the golden literal below was captured from
// the pre-change implementation over this exact fixture — it must never drift.

const mandatoryGates = ["build", "test", "lint", "evidence", "scope"];
const GRAPH = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [
    { id: "T1", title: "done", goal: "Finish report, then archive it.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
    { id: "T2", title: "failed", goal: "Run mixed gates; stop on failure.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
    { id: "T3", title: "starved", goal: "Queue the undispatched follow-up.", shape: "implement", complexity: 3, deps: ["T2"], acceptance: ["a"], gates: mandatoryGates },
  ],
});

// Deterministic fixture: events backdated exactly 10 minutes (age renders "10m" for the next
// ~50s of wall clock), a garbage pid (renders "unknown", never probes), fixed 120 columns.
const seed = (repo: string) => {
  saveGraph(repo, GRAPH);
  const ts = new Date(Date.now() - 600_000).toISOString();
  const events: JournalEvent[] = [
    { ts, event: "run-start", data: { pid: "not-a-pid", graphDefinitionHash: graphDefinitionHash(GRAPH) } },
    { ts, event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" } } },
    { ts, event: "gate-result", taskId: "T1", data: { gate: "build", pass: true } },
    { ts, event: "gate-result", taskId: "T1", data: { gate: "test", pass: true } },
    { ts, event: "task-done", taskId: "T1", data: {} },
    { ts, event: "task-dispatch", taskId: "T2", data: { assignment: { adapter: "fake", model: "fake-2", channel: "sub", tier: "cheap" } } },
    { ts, event: "gate-result", taskId: "T2", data: { gate: "build", pass: true } },
    { ts, event: "gate-result", taskId: "T2", data: { gate: "test", pass: false } },
    { ts, event: "task-failed", taskId: "T2", data: {} },
    { ts, event: "context-sample", taskId: "T2", data: { tokens: 1234, threshold: 170_000, attempt: 0 } },
  ];
  const dir = join(tickmarkrDir(repo), "runs", "run-brand");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

const withStdout = async (tty: boolean, fn: () => Promise<void>) => {
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
  delete process.env.NO_COLOR;
  try {
    await fn();
  } finally {
    if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (columns) Object.defineProperty(process.stdout, "columns", columns);
    else delete (process.stdout as { columns?: number }).columns;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

describe("T3 watch cockpit brand restyle", () => {
  test("status non-tty output is byte-identical to before this change", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(false, async () => {
      const out = await status([], repo);
      expect(out).toBe(
        "tickmarkr status / run run-brand / last event 10m ago / daemon pid unknown / 1/3 done\n" +
        "  gates: B build / T test / L lint / E evidence / S scope / A acceptance / R review\n" +
        "  [x] T1 Finish report  B[x] T[x] L[ ] E[ ] S[ ] A. R.  done  fake:fake-1\n" +
        "  [!] T2 Run mixed gates  B[x] T[!] L[ ] E[ ] S[ ] A. R.  failed  fake:fake-2 / ctx 1234\n" +
        "  [ ] T3 Queue the undispatched follow-up  B[ ] T[ ] L[ ] E[ ] S[ ] A. R.  pending starved  -",
      );
    });
  });

  // one bounded watch frame with stdout captured — the cockpit write is banner + frame + footer
  const watchFrame = async (repo: string): Promise<string> => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await status(["--watch"], repo, { iterations: 1, sleep: async () => {} });
    } finally {
      spy.mockRestore();
    }
    return writes.join("");
  };

  test("the watch frame renders the run title with emphasis on a tty", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(true, async () => {
      const out = await watchFrame(repo);
      expect(out).toContain(BANNER); // banner plus dominant run title
      expect(out).toContain("\x1b[1mrun run-brand\x1b[0m"); // title() emphasis on the run id
    });
  });

  test("a done task row renders the ok glyph and a failed task row renders the fail glyph on a tty", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(true, async () => {
      const out = await status([], repo);
      const row = (id: string) => out.split("\n").find((line) => new RegExp(`\\b${id}\\b`).test(line))!;
      expect(row("T1")).toContain("\x1b[38;5;41m✓\x1b[0m T1"); // ok() brand-green tickmark leads the done row
      expect(row("T2")).toContain("\x1b[31m✗\x1b[0m T2"); // fail() red cross leads the failed row
    });
  });

  test("the watch footer renders as a single dim legend line on a tty", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(true, async () => {
      const out = await watchFrame(repo);
      const footer = out.split("\n").at(-1)!;
      expect(footer).toBe("\x1b[2m watching · refresh 2s · ^C to quit\x1b[0m"); // legend(): one dim line, nothing after it
    });
  });
});
