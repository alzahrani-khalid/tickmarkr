import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";
import {
  SUPERVISION_STALE_MS,
  SUPERVISION_TIERS,
  beatSupervision,
  supervisionBeatPath,
} from "../../src/run/supervision.js";

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

  test("test: status renders every known tier including those that never beat, so a tier missing from the output cannot be mistaken for a tier that is healthy", async () => {
    const repo = mkRepo();
    seedGraph(repo);
    seedJournal(repo, [ev("run-start", { pid: process.pid })]);
    // Exactly ONE tier has ever beaten, and one of the others armed and then died — the surface must
    // still name all three, because a tier it omitted would be read as one that is fine.
    beatSupervision(repo, "orchestrator");
    beatSupervision(repo, "overseer");
    const dead = new Date(Date.now() - SUPERVISION_STALE_MS - 1_000);
    utimesSync(supervisionBeatPath(repo, "overseer"), dead, dead);

    const out = await status([], repo);

    for (const tier of SUPERVISION_TIERS) expect(out).toContain(tier);
    expect(out).toContain("orchestrator ARMED");
    expect(out).toContain("overseer STALE"); // armed-then-died, not silently folded into never-armed
    expect(out).toContain("watch ABSENT"); // never beat, and it is SAID rather than omitted
    // one reading per known tier, and no tier reading is missing from the line
    const line = out.split("\n").find((l) => l.includes("supervision:"))!;
    for (const tier of SUPERVISION_TIERS) {
      expect(line.match(new RegExp(`\\b${tier} (?:ABSENT|STALE|ARMED|UNREADABLE)\\b`, "gu"))).toHaveLength(1);
    }
  });

  // ── Pane locators: what the board says an operator can still OPEN, derived from the run's own
  // record plus the visibility setting that governs when the daemon closes a worker pane.
  const PANE_RUN = "run-panes";
  const paneGraph = (repo: string) => {
    const graph = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: ["T1", "T2", "T3"].map((id) => ({
        id, title: id, goal: `Work ${id}.`, shape: "implement" as const, complexity: 3,
        acceptance: ["a"], gates: ["build", "test", "lint", "evidence", "scope"],
      })),
    });
    saveGraph(repo, graph);
    return graph;
  };
  const paneRepo = (keepPanes: "run" | "attempt", events: (hash: string) => JournalEvent[]): string => {
    const repo = mkRepo();
    const graph = paneGraph(repo);
    // The repo overlay is written explicitly in every case: which pane survives is the SETTING's
    // decision, so neither case may inherit it from whatever the host operator's global config says.
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), `visibility:\n  keepPanes: ${keepPanes}\n`);
    const dir = join(tickmarkrDir(repo), "runs", PANE_RUN);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "journal.jsonl"),
      events(graphDefinitionHash(graph)).map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    return repo;
  };
  const at = (n: number) => new Date(Date.parse("2026-08-07T08:00:00.000Z") + n * 1000).toISOString();
  const paneFrame = async (repo: string, columns: number): Promise<string> => {
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const cols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const noColor = process.env.NO_COLOR;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
    delete process.env.NO_COLOR;
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      return await status(["--watch"], repo, { iterations: 1, sleep: async () => {}, now: () => Date.parse(at(20)) });
    } finally {
      spy.mockRestore();
      if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (cols) Object.defineProperty(process.stdout, "columns", cols);
      else delete (process.stdout as { columns?: number }).columns;
      if (noColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = noColor;
    }
  };
  /** Wrapping inserts whitespace and nothing else — a squashed frame reassembles a wrapped locator. */
  const squash = (frame: string) => frame.replace(/\x1b\[[0-9;]*m/gu, "").replace(/\s+/gu, "");

  test("test: status --watch reads a journal ending at task-dispatch and renders pane location plus engagement 2, and renders a pane locator ONLY for tasks whose pane can still exist, exercised over a dispatched-but-unstarted task, a completed task whose pane the daemon closed on task-done, and a keepPanes=attempt task whose pane closed before gates, so a locator built from dispatch history alone sends an operator to a pane that is gone", async () => {
    // T2 ran and landed; T1 is on its SECOND engagement and the record stops at that dispatch —
    // no phase-start has arrived yet, which is exactly the window a fixture that always pairs the
    // two never enters.
    const dispatched = paneRepo("run", (hash) => [
      { ts: at(0), event: "run-start", data: { pid: process.pid, graphDefinitionHash: hash } },
      { ts: at(1), event: "task-dispatch", taskId: "T2", data: { assignment: { adapter: "fake", model: "fake-2" }, attempt: 0 } },
      { ts: at(2), event: "worker-result", taskId: "T2", data: { ok: true, finished: true } },
      { ts: at(3), event: "task-done", taskId: "T2", data: { attempts: 1 } },
      { ts: at(4), event: "merge", taskId: "T2", data: { commit: "abc123" } },
      { ts: at(5), event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "fake", model: "fake-1" }, attempt: 1 } },
    ]);
    // The SAME dispatch history under each setting: harvested, gates not yet started.
    const harvested = (hash: string): JournalEvent[] => [
      { ts: at(0), event: "run-start", data: { pid: process.pid, graphDefinitionHash: hash } },
      { ts: at(1), event: "task-dispatch", taskId: "T3", data: { assignment: { adapter: "fake", model: "fake-3" }, attempt: 0 } },
      { ts: at(2), event: "worker-result", taskId: "T3", data: { ok: true, finished: true } },
    ];
    const closedPerAttempt = paneRepo("attempt", harvested);
    const keptForTheRun = paneRepo("run", harvested);

    for (const columns of [55, 120]) {
      const live = squash(await paneFrame(dispatched, columns));
      // Where to look, in full, at both widths — half an address is no address.
      expect(live, `${columns} cols`).toContain(`panetickmarkr:worker:T1:1:${PANE_RUN}`);
      expect(live, `${columns} cols`).toContain("engagementattempt2");
      // T2's worker pane closed on task-done; naming it would send the operator to a dead pane.
      expect(live, `${columns} cols`).not.toContain(`tickmarkr:worker:T2:0:${PANE_RUN}`);
      expect(live, `${columns} cols`).not.toContain("panetickmarkr:worker:T2");

      // Same journal, different setting: under keepPanes=attempt the pane is gone the moment the
      // attempt is harvested — before any gate runs — and under keepPanes=run it is still there.
      expect(squash(await paneFrame(closedPerAttempt, columns)), `${columns} cols`)
        .not.toContain("panetickmarkr:worker:T3");
      expect(squash(await paneFrame(keptForTheRun, columns)), `${columns} cols`)
        .toContain(`panetickmarkr:worker:T3:0:${PANE_RUN}`);
    }
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

  // OBS-538: `worker-contact` — the daemon's own proof that a silent worker is alive, hashed off its
  // worktree — was journaled and read by nothing. A headless channel prints nothing to its pane ever,
  // and one-shot `status` scrapes no pane at all, so the row said "no output 14m51s" about a worker
  // proven alive 10s earlier: a false stall on the surface a kill decision is made from.
  test("a live worker phase names the daemon's journaled contact when it is fresher than any pane output, and falls back to no-output only when the journal proves nothing", async () => {
    const repo = mkRepo();
    const graph = seedGraph(repo);
    const startedAt = Date.parse("2026-07-23T08:00:00.000Z");
    const seed = (extra: JournalEvent[]) => seedJournal(repo, [
      ev("run-start", { pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) }, new Date(startedAt - 1_000).toISOString()),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "fake-1" } }, new Date(startedAt).toISOString(), "T1"),
      ev("phase-start", { phase: "worker" }, new Date(startedAt).toISOString(), "T1"),
      ...extra,
    ]);
    const frame = async () => status(["--watch"], repo, {
      iterations: 1,
      sleep: async () => {},
      now: () => startedAt + 600_000,
    });

    seed([ev("worker-contact", { slot: "s", attempt: 0, evidence: "worktree" }, new Date(startedAt + 590_000).toISOString(), "T1")]);
    const withContact = await frame();
    expect(withContact).toContain("last contact 10s ago (worktree)");
    expect(withContact).not.toContain("no output");

    seed([]);
    expect(await frame()).toContain("no output 10m0s");
  });

  // The half-fix the gate record on 8b103bf3 caught: OBS-538 taught the detail PHRASE to read
  // `worker-contact` and left the stall ALARM (`staleWorker`) clocking pane bytes alone, so for the
  // very population OBS-538 is about — a headless channel whose pane never prints, so hasOutput stays
  // false — every live row was warn-painted from 60s onward while line 2 of the same card read "last
  // contact 10s ago (worktree)". The suite pinned the text and not the paint, which is how it shipped.
  // The alarm is a COLOR-only difference (same glyph, same word), so this asserts the SGR bytes: the
  // cockpit's own `visual()` gate is `process.stdout.isTTY === true && NO_COLOR unset`.
  test("the stall alarm reads the same evidence the detail line names: a live worker with a fresh journaled contact and no pane output is NOT warn-painted, and the same row with nothing observed IS", async () => {
    const repo = mkRepo();
    const graph = seedGraph(repo);
    const startedAt = Date.parse("2026-07-23T08:00:00.000Z");
    const seed = (extra: JournalEvent[]) => seedJournal(repo, [
      ev("run-start", { pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) }, new Date(startedAt - 1_000).toISOString()),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "fake-1" } }, new Date(startedAt).toISOString(), "T1"),
      ev("phase-start", { phase: "worker" }, new Date(startedAt).toISOString(), "T1"),
      ...extra,
    ]);
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const noColor = process.env.NO_COLOR;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    delete process.env.NO_COLOR;
    try {
      const card = async (): Promise<string> => {
        const out = await status(["--watch"], repo, {
          iterations: 1,
          sleep: async () => {},
          now: () => startedAt + 600_000,
        });
        const lines = out.split("\n");
        const bare = (line: string) => line.replace(/\x1b\[[\d;]*m/gu, "");
        const start = lines.findIndex((line) => /^ {4}T1(?:\s|$)/u.test(bare(line)));
        let end = start + 1;
        while (end < lines.length && !/^ {4}\S/u.test(bare(lines[end]!))) end += 1;
        return lines.slice(start, end).join(" ").replace(/\s+/gu, " ");
      };
      const AMBER = "\x1b[33m"; // brand.ts warn()
      const DIM = "\x1b[2m"; //   brand.ts dim()

      // contact 10s old: alive by the daemon's own evidence, so no alarm on either half of the card
      seed([ev("worker-contact", { slot: "s", attempt: 0, evidence: "worktree" }, new Date(startedAt + 590_000).toISOString(), "T1")]);
      const alive = await card();
      const aliveText = alive.replace(/\x1b\[[\d;]*m/gu, "").replace(/\s+/gu, " ");
      expect(aliveText).toContain("last contact 10s ago (worktree)");
      expect(alive).not.toContain(AMBER); // neither the status word nor the spinner is flagged
      expect(alive).toContain(DIM); // the spinner still renders, as chrome

      // nothing observed for ten minutes: the alarm is exactly what should fire here
      seed([]);
      const silent = await card();
      const silentText = silent.replace(/\x1b\[[\d;]*m/gu, "").replace(/\s+/gu, " ");
      expect(silentText).toContain("no output 10m0s");
      expect(silent).toContain(AMBER);
    } finally {
      // restore by descriptor either way: an absent isTTY reads as undefined, which is what the
      // cockpit's `isTTY === true` gate already treats as "not a terminal"
      Object.defineProperty(process.stdout, "isTTY", tty ?? { configurable: true, value: undefined });
      if (noColor !== undefined) process.env.NO_COLOR = noColor;
    }
  });
});
