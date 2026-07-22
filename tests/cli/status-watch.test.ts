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

// T6 (v1.61): a graph whose task parks at a DESIGNED human gate — pre-dispatch, so no gate
// result ever exists for it. Separate from GRAPH: the byte-pinned golden below must not drift.
const HUMAN_GRAPH = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [
    { id: "T1", title: "gated", goal: "Ship the risky migration safely.", shape: "migration", complexity: 3, acceptance: ["a"], gates: mandatoryGates, humanGate: true },
  ],
});
const HUMAN_DEF_HASH = graphDefinitionHash(HUMAN_GRAPH);

const seed = (repo: string, events: JournalEvent[], graph = GRAPH) => {
  saveGraph(repo, graph);
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
      expect(strip(row(out, "T2"))).toMatch(/✓ ✗ ○ ○ ○ - -/);
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

    // v1.65 T4: T2's live-attempt activity cell widens the status column — give the frame room
    // so the goal column keeps its full text for this assertion.
    const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 180 });
    try {
      await withTty(async () => {
        const out = await status([], repo);
        expect(out).toContain("1/3 done");
        expect(strip(row(out, "T1"))).toContain("✓ T1 Finish report");
        expect(strip(row(out, "T2"))).toContain("- T2 Run mixed gates");
        expect(strip(row(out, "T2"))).toContain("attempt 1 in flight on fake:fake-2 since 08:00:00");
        expect(strip(row(out, "T3"))).toContain("- T3 Queue the undispatched follow-up");
        expect(row(out, "T3")).toContain("dep-waiting on T2"); // the unmet dep is named (OBS-104)
      });
    } finally {
      if (columns) Object.defineProperty(process.stdout, "columns", columns);
      else delete (process.stdout as { columns?: number }).columns;
    }
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

  test("a TTY gate chain renders as glyph-only cells with no letter prefix on any cell", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      dispatch("T1", "fake-1"), gate("T1", "build", true), gate("T1", "test", true), { ts, event: "task-done", taskId: "T1", data: {} },
      dispatch("T2", "fake-2"), gate("T2", "build", true), gate("T2", "test", false),
    ]);

    await withTty(async () => {
      const out = await status([], repo);
      expect(strip(row(out, "T1"))).toContain("✓ ✓ ○ ○ ○ - -");
      expect(strip(row(out, "T2"))).toContain("✓ ✗ ○ ○ ○ - -");
      expect(strip(row(out, "T3"))).toContain("○ ○ ○ ○ ○ - -");
      // no letter+glyph (or letter+dash) chip survives anywhere in the frame
      expect(strip(out)).not.toMatch(/[A-Z][✓✗○]|\b[A-Z]-/);
    });
  });

  test("the TTY frame legend names all seven gates in fixed order once per frame", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), dispatch("T1", "fake-1")]);

    await withTty(async () => {
      const plain = strip(await status([], repo));
      expect(plain.split("gates: build · test · lint · evidence · scope · acceptance · review")).toHaveLength(2); // exactly once
      expect(plain).not.toContain("B build"); // letter keys are gone from the TTY legend
    });
  });

  test("a task with a failed gate names that gate in words in its own status cell", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      dispatch("T1", "fake-1"), gate("T1", "build", true), gate("T1", "test", true), { ts, event: "task-done", taskId: "T1", data: {} },
      dispatch("T2", "fake-2"), gate("T2", "build", true), gate("T2", "test", false), { ts, event: "task-failed", taskId: "T2", data: {} },
    ]);

    await withTty(async () => {
      const out = await status([], repo);
      expect(strip(row(out, "T2"))).toContain("failed · test");
      expect(strip(row(out, "T1"))).not.toContain("done ·"); // healthy rows carry no gate words
    });
  });

  test("a task parked at a designed human gate names that gate in words in its own status cell", async () => {
    const repo = mkRepo();
    seed(repo, [
      { ts, event: "run-start", data: { pid: process.pid, graphDefinitionHash: HUMAN_DEF_HASH } },
      { ts, event: "task-human", taskId: "T1", data: { reason: 'humanGate: "gated" requires approval before dispatch', kind: "human-gate" } },
    ], HUMAN_GRAPH);

    await withTty(async () => {
      const out = await status([], repo);
      // v1.65 T4: the activity cell names the park kind between the status word and the approval hint
      expect(strip(row(out, "T1"))).toContain("human parked (human-gate) · awaiting approval");
    });
  });

  // v1.65 T4 (OBS-104): the cockpit carries a run-level now line so the operator can tell
  // dispatching from gating from merging without tailing the journal.
  test("the surface carries a run-level line naming the most recent journal event", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), dispatch("T2", "fake-2"), { ts, event: "worker-result", taskId: "T2", data: { ok: true, finished: true } }, gate("T2", "build", true)]);

    await withTty(async () => {
      const out = await status([], repo);
      expect(strip(out)).toContain("now: gate-result — T2 — build passed");
      expect(strip(row(out, "T2"))).toContain("gate test running"); // and the watched task names its running gate
    });
  });

  test("the parked human-gate label renders before any gate result exists for the task", async () => {
    const repo = mkRepo();
    // the daemon parks a designed human gate BEFORE dispatch — this fixture mirrors that exactly:
    // no task-dispatch, no gate-result anywhere in the journal
    const events: JournalEvent[] = [
      { ts, event: "run-start", data: { pid: process.pid, graphDefinitionHash: HUMAN_DEF_HASH } },
      { ts, event: "task-human", taskId: "T1", data: { kind: "human-gate" } },
    ];
    expect(events.some((e) => e.event === "gate-result")).toBe(false);
    seed(repo, events, HUMAN_GRAPH);

    await withTty(async () => {
      const out = await status([], repo);
      expect(strip(row(out, "T1"))).toContain("awaiting approval");
    });
  });

  test("non-TTY and NO_COLOR output is byte-identical to its pre-redesign form", async () => {
    const repo = mkRepo();
    // deterministic fixture: events backdated exactly 10 minutes (age renders "10m"), a garbage
    // pid (renders "unknown", never probes), fixed 120 columns — the status-brand golden idiom
    const old = new Date(Date.now() - 600_000).toISOString();
    const at = (e: JournalEvent): JournalEvent => ({ ...e, ts: old });
    seed(repo, [
      { ts: old, event: "run-start", data: { pid: "not-a-pid", graphDefinitionHash: DEF_HASH } },
      at(dispatch("T1", "fake-1")), at(gate("T1", "build", true)), at(gate("T1", "test", true)), { ts: old, event: "task-done", taskId: "T1", data: {} },
      at(dispatch("T2", "fake-2")), at(gate("T2", "build", true)), at(gate("T2", "test", false)), { ts: old, event: "task-failed", taskId: "T2", data: {} },
    ]);
    // golden literal captured from the pre-redesign implementation over this exact fixture — it must never drift
    const golden =
      "tickmarkr status / run run-watch / last event 10m ago / daemon pid unknown / 1/3 done\n" +
      "  gates: B build / T test / L lint / E evidence / S scope / A acceptance / R review\n" +
      "  [x] T1 Finish report  B[x] T[x] L[ ] E[ ] S[ ] A. R.  done  fake:fake-1\n" +
      "  [!] T2 Run mixed gates  B[x] T[!] L[ ] E[ ] S[ ] A. R.  failed  fake:fake-2\n" +
      "  [ ] T3 Queue the undispatched follow-up  B[ ] T[ ] L[ ] E[ ] S[ ] A. R.  pending starved  -";
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const noColor = process.env.NO_COLOR;
    try {
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
      for (const [ttyValue, noColorValue] of [[false, undefined], [true, "1"]] as const) {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: ttyValue });
        if (noColorValue === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = noColorValue;
        expect(await status([], repo)).toBe(golden);
      }
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (columns) Object.defineProperty(process.stdout, "columns", columns);
      else delete (process.stdout as { columns?: number }).columns;
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
