import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, saveGraph, stateDirName } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { beatSupervision } from "../../src/run/supervision.js";

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-repo-"));

type Snap = { paths: string[]; entries: { path: string; ino: number; mtimeMs: number; size: number; mode: number }[] };

const snapshot = (repo: string): Snap => {
  const root = join(repo, stateDirName(repo));
  const paths: string[] = [];
  const walk = (dir: string, rel = "") => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      paths.push(r);
      if (statSync(p).isDirectory()) walk(p, r);
    }
  };
  walk(root);
  paths.sort();
  const entries = paths.map((rel) => {
    const st = statSync(join(root, rel));
    return { path: rel, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, mode: st.mode };
  });
  return { paths, entries };
};

const seed = (repo: string, livePhase = false) => {
  const graph = validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"], status: "running" }],
  });
  saveGraph(repo, graph);
  // Strip tickmarkrDir's .gitignore so an injected saveGraph's path-set gain is observable (D-02 dual signal).
  unlinkSync(join(repo, stateDirName(repo), ".gitignore"));
  const dir = join(repo, stateDirName(repo), "runs", "run-purity");
  mkdirSync(dir, { recursive: true });
  const events: JournalEvent[] = [
    {
      ts: "2026-07-11T07:59:59.000Z",
      event: "run-start",
      data: { graphDefinitionHash: graphDefinitionHash(graph) },
    },
    {
      ts: "2026-07-11T08:00:00.000Z",
      event: "task-dispatch",
      taskId: "T1",
      data: { assignment: { adapter: "fake", model: "fake-1" } },
    },
    ...(livePhase
      ? [{
          ts: "2026-07-11T08:00:00.000Z",
          event: "phase-start",
          taskId: "T1",
          data: { phase: "worker" },
        } satisfies JournalEvent]
      : []),
  ];
  writeFileSync(join(dir, "journal.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
};

// D-02: bounded --watch is a pure reader — mtime + inode + path-set under .tickmarkr/ unchanged.
describe("VIS-07 status --watch purity (D-02)", () => {
  test("test: a status render with no supervision directory present leaves the directory absent, so reading the board never creates the state it reports", async () => {
    const repo = mkRepo();
    seed(repo);
    const dir = join(repo, stateDirName(repo), "supervision");

    expect(existsSync(dir)).toBe(false);
    const out = await status([], repo);

    expect(out).toContain("supervision:");
    expect(out).toContain("watch ABSENT");
    expect(existsSync(dir)).toBe(false);
  });

  test("iterations:3 watch leaves .tickmarkr/ snapshot identical", async () => {
    const repo = mkRepo();
    console.error("VIS-07 purity fixture:", repo); // provenance for WATCH-DRILLS (D-13)
    seed(repo);
    const before = snapshot(repo);
    expect(before.paths).not.toContain(".gitignore");
    await status(["--watch"], repo, { iterations: 3, sleep: async () => {} });
    const after = snapshot(repo);
    expect(after).toEqual(before);
    expect(after.paths).not.toContain(".gitignore");
    expect(after.paths).not.toContain("run.lock");
  });

  test("all animation derives from watcher-local clocks between real journal events and the watcher writes nothing to the journal", async () => {
    const repo = mkRepo();
    seed(repo, true);
    const journal = join(repo, stateDirName(repo), "runs", "run-purity", "journal.jsonl");
    const before = snapshot(repo);
    const bytesBefore = readFileSync(journal, "utf8");
    const startedAt = Date.parse("2026-07-11T08:00:00.000Z");
    const times = [startedAt + 1_000, startedAt + 4_000];
    let clock = 0;

    const out = await status(["--watch"], repo, {
      iterations: 2,
      sleep: async () => {},
      now: () => times[clock++]!,
    });

    expect(out.split("\n---\n")[0]).toContain("1s elapsed");
    expect(out.split("\n---\n")[1]).toContain("4s elapsed");
    expect(readFileSync(journal, "utf8")).toBe(bytesBefore);
    expect(snapshot(repo)).toEqual(before);
  });

  // SUP-01: reading a tier's status may not create, touch or reap the very files it reports on —
  // a reader that beat on the watcher's behalf would report every dead tier as healthy forever.
  test("reading supervision tiers neither beats for an armed tier nor materializes an absent one", async () => {
    const repo = mkRepo();
    seed(repo);
    beatSupervision(repo, "orchestrator", "ORCH-w1:p1"); // one tier armed; every other tier has no record
    const before = snapshot(repo);
    expect(before.paths).toContain("supervision/orchestrator.beat");
    expect(before.paths).not.toContain("supervision/overseer.beat");

    const out = await status(["--watch"], repo, { iterations: 3, sleep: async () => {} });

    expect(out).toContain("orchestrator ARMED");
    expect(out).toContain("overseer ABSENT");
    // identical inode, mtime and path set: the armed beat was not refreshed and no absent tier
    // gained a file merely by being read three times.
    expect(snapshot(repo)).toEqual(before);
  });

  // SUP-06: the board arms its OWN tier, and the fence that keeps that from becoming a reader beating
  // for a watcher is the bounded/unbounded split — every case above renders a BOUNDED number of frames,
  // so a beat on that path would report every dead tier healthy from any of them.
  test("test: a bounded render writes no beat for any tier and leaves the supervision records byte-identical while the unbounded board writes exactly its own; a board arming on the bounded path makes the reader beat on the watcher's behalf and fails", async () => {
    const repo = mkRepo();
    seed(repo);
    beatSupervision(repo, "orchestrator", "ORCH-w1:p1"); // foreign records the board must leave exactly as it found
    beatSupervision(repo, "overseer", "OVSR-w1:p2");
    const before = snapshot(repo);
    const foreign = (snap: Snap) =>
      snap.entries.filter((e) => e.path.startsWith("supervision/") && !e.path.startsWith("supervision/watch."));

    await status(["--watch"], repo, { iterations: 3, sleep: async () => {} });

    // The bounded reader: not one beat for any tier, and the supervision records byte-for-byte intact.
    expect(snapshot(repo)).toEqual(before);
    expect(snapshot(repo).paths).not.toContain("supervision/watch.beat");

    const quiet = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await status(["--watch"], repo, {
        sleep: async () => { throw new Error("board closed"); },
      }).catch(() => undefined);
    } finally { quiet.mockRestore(); }

    // The unbounded board: its own tier's record, and nothing else's.
    const after = snapshot(repo);
    expect(after.paths).toContain("supervision/watch.beat");
    expect(after.paths.filter((p) => !before.paths.includes(p)).every((p) => p.startsWith("supervision/watch."))).toBe(true);
    expect(foreign(after)).toEqual(foreign(before));
  });

  test("the stream is pure formatting over journal truth with no new state, service, or storage", async () => {
    const repo = mkRepo();
    seed(repo);
    const journal = join(repo, stateDirName(repo), "runs", "run-purity", "journal.jsonl");
    writeFileSync(journal, readFileSync(journal, "utf8") + JSON.stringify({
      ts: "2026-07-11T08:00:01.000Z",
      event: "task-human",
      taskId: "T1",
      data: { kind: "human-gate", reason: "approval required" },
    }) + "\n");
    const bytesBefore = readFileSync(journal, "utf8");
    const before = snapshot(repo);

    const first = await status(["--watch", "--events"], repo, { iterations: 1, sleep: async () => {} });
    const replay = await status(["--watch", "--events"], repo, { iterations: 1, sleep: async () => {} });

    expect(replay).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      type: "human-decision-required",
      approvalCommand: "tickmarkr approve run-purity T1",
    });
    expect(readFileSync(journal, "utf8")).toBe(bytesBefore);
    expect(snapshot(repo)).toEqual(before);
  });
});
