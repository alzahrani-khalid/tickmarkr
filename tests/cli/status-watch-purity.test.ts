import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, saveGraph, stateDirName } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";

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
});
