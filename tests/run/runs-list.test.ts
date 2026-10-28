import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { listRuns } from "../../src/run/runs-list.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

test("listRuns reads only parseable journalled runs, orders by id instead of time and tolerates missing or broken snapshots", () => {
  const cwd = makeTestTempDir("runs-list-");
  expect(listRuns(cwd)).toEqual([]);
  const root = join(cwd, ".tickmarkr", "runs");
  const time = new Date("2026-01-01T00:00:00Z");
  for (const id of ["run-b", "run-a", "run-c", "run-d", "run-empty", "run-bad!", "run-", "not-a-run", " run-spaced"]) {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    if (id === "run-empty") continue;
    writeFileSync(join(dir, "journal.jsonl"), "");
    utimesSync(join(dir, "journal.jsonl"), time, time);
    if (id === "run-b") writeFileSync(join(dir, "graph.json"), JSON.stringify({ spec: { paths: ["specs/first.md", "second.md"] } }));
    if (id === "run-c") writeFileSync(join(dir, "graph.json"), "broken");
    if (id === "run-d") writeFileSync(join(dir, "graph.json"), JSON.stringify({ spec: { paths: [7] } }));
  }
  mkdirSync(join(root, "run-directory", "journal.jsonl"), { recursive: true });
  writeFileSync(join(root, "run-file"), "not a directory");
  utimesSync(join(root, "run-a", "journal.jsonl"), new Date(), new Date());
  expect(listRuns(cwd)).toEqual([
    { runId: "run-d", updatedAt: time.toISOString() },
    { runId: "run-c", updatedAt: time.toISOString() },
    { runId: "run-b", title: "first.md", updatedAt: time.toISOString() },
    { runId: "run-a", updatedAt: expect.any(String) },
  ]);
});
