import { mkdirSync, mkdtempSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { saveGraph, stateDirName } from "../../src/graph/graph.js";
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

const seed = (repo: string) => {
  saveGraph(
    repo,
    validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"], status: "running" }],
    }),
  );
  // Strip tickmarkrDir's .gitignore so an injected saveGraph's path-set gain is observable (D-02 dual signal).
  unlinkSync(join(repo, stateDirName(repo), ".gitignore"));
  const dir = join(repo, stateDirName(repo), "runs", "run-purity");
  mkdirSync(dir, { recursive: true });
  const ev: JournalEvent = {
    ts: "2026-07-11T08:00:00.000Z",
    event: "task-dispatch",
    taskId: "T1",
    data: { assignment: { adapter: "fake", model: "fake-1" } },
  };
  writeFileSync(join(dir, "journal.jsonl"), JSON.stringify(ev) + "\n");
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
});
