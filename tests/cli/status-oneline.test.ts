import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";

// The compact one-line form exists so journal interpretation happens ONCE, inside the product: an
// operator-local bash reimplementation counted verification events instead of reading the run-end
// field and scored two runs whose tip verification had FAILED as verified.
//
// The fs wrapper below calls straight through — it only tallies reads of journal.jsonl and, when a
// test arms it, appends bytes AFTER a read returns: the window a second read would fall into.
const journal = vi.hoisted(() => ({ reads: 0, armedPath: "", appendAfterRead: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const counted = ((path: unknown, ...rest: unknown[]) => {
    const isJournal = typeof path === "string" && path.endsWith("journal.jsonl");
    if (isJournal) journal.reads += 1;
    const bytes = (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    if (isJournal && path === journal.armedPath && journal.appendAfterRead) {
      actual.appendFileSync(path as string, journal.appendAfterRead);
      journal.appendAfterRead = "";
    }
    return bytes;
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync: counted }, readFileSync: counted };
});

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-oneline-"));
const mandatoryGates = ["build", "test", "lint", "evidence", "scope"];
const at = (n: number) => new Date(Date.parse("2026-08-07T08:00:00.000Z") + n * 1000).toISOString();

const graphOf = (ids: string[]) => validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: ids.map((id) => ({
    id, title: id, goal: `Work ${id}.`, shape: "implement" as const, complexity: 3,
    acceptance: ["a"], gates: mandatoryGates,
  })),
});

const journalPath = (repo: string, runId: string) =>
  join(tickmarkrDir(repo), "runs", runId, "journal.jsonl");

const seed = (repo: string, runId: string, ids: string[], events: (hash: string) => JournalEvent[]): string => {
  const graph = graphOf(ids);
  saveGraph(repo, graph);
  mkdirSync(join(tickmarkrDir(repo), "runs", runId), { recursive: true });
  const path = journalPath(repo, runId);
  writeFileSync(path, events(graphDefinitionHash(graph)).map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
};

const landed = (taskId: string, second: number): JournalEvent[] => [
  { ts: at(second), event: "task-dispatch", taskId, data: { assignment: { adapter: "fake", model: "fake-1" }, attempt: 0 } },
  { ts: at(second + 1), event: "task-done", taskId, data: { attempts: 1 } },
  { ts: at(second + 2), event: "merge", taskId, data: { commit: `commit-${taskId}` } },
];

/** Terminal control bytes, C0 and C1 — none of which may leave a form a statusline embeds. */
const CONTROL_BYTE = /[\u0000-\u001F\u007F-\u009F]/u;

describe("compact one-line status form", () => {
  test("test: the compact one-line form derives task completion and tip verification from ONE journal read, proven by appending the final task completion and run-end between what would be two reads and requiring the rendered line to never pair a complete task count with an unrecorded verify, so two snapshots cannot be presented as one state", async () => {
    const repo = mkRepo();
    const path = seed(repo, "run-torn", ["T1", "T2", "T3"], (hash) => [
      { ts: at(0), event: "run-start", data: { pid: process.pid, graphDefinitionHash: hash, commands: { test: "npm test" } } },
      ...landed("T1", 1),
      ...landed("T2", 4),
      { ts: at(7), event: "task-dispatch", taskId: "T3", data: { assignment: { adapter: "fake", model: "fake-1" }, attempt: 0 } },
    ]);
    // What the daemon writes between two reads: the last task lands and the run records its verdict.
    journal.armedPath = path;
    journal.appendAfterRead = [
      { ts: at(8), event: "task-done", taskId: "T3", data: { attempts: 1 } },
      { ts: at(9), event: "merge", taskId: "T3", data: { commit: "commit-T3" } },
      { ts: at(10), event: "run-end", data: { done: ["T1", "T2", "T3"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    journal.reads = 0;

    const line = await status(["--oneline"], repo);

    // ONE read: a second one is what lets a tally from one instant be paired with a verdict from
    // another, and the appended bytes above are sitting in exactly that window.
    expect(journal.reads).toBe(1);
    // Whichever instant this line describes, it describes ONE of them whole. The forbidden pairing
    // is the torn one: every task complete beside a verify the earlier snapshot had not yet seen.
    expect(line).not.toMatch(/3\/3 done.*unrecorded/u);
    expect([
      "run-torn · 2/3 done · verify unrecorded",
      "run-torn · 3/3 done · verify passed",
    ]).toContain(line);
    expect(line.split("\n")).toHaveLength(1);
  });

  test("test: the compact one-line form reports tip verification read from the run-end field and reports failed for a run whose verify failed where counting verification events reports success, and renders each of the tipVerify values \"failed\\npassed\", \"\\u001B[31mfailed\\u001B[0m\" and \"\\u001B]8;;https://example.invalid\\u0007failed\\u001B]8;;\\u0007\", decoded from these escape sequences before reaching the production one-line renderer, as unrecorded on one line with no control byte emitted", async () => {
    journal.armedPath = "";
    // A run that verified its tip TWICE on the way and failed the verification that decided the
    // run: counting `tip-verify` events scores it verified, reading the run-end field does not.
    const verifiedGates: JournalEvent[] = [
      { ts: at(11), event: "tip-verify", data: { gate: "build", pass: true } },
      { ts: at(12), event: "tip-verify", data: { gate: "lint", pass: true } },
    ];
    const failedRepo = mkRepo();
    seed(failedRepo, "run-counted", ["T1"], (hash) => [
      { ts: at(0), event: "run-start", data: { pid: process.pid, graphDefinitionHash: hash, commands: { test: "npm test" } } },
      ...landed("T1", 1),
      ...verifiedGates,
      { ts: at(13), event: "run-end", data: { done: ["T1"], failed: [], human: [], blocked: [], pending: [], tipVerify: "failed" } },
    ]);
    // The oracle the product refuses: every verification event in this journal reports success.
    expect(verifiedGates.every((event) => event.data.pass === true)).toBe(true);

    const counted = await status(["--oneline"], failedRepo);
    expect(counted).toBe("run-counted · 1/1 done · verify failed");

    // A field that is not one of the two recorded verdicts records no verdict — whatever it carries.
    const unusable = [
      "failed\npassed",
      "\u001B[31mfailed\u001B[0m",
      "\u001B]8;;https://example.invalid\u0007failed\u001B]8;;\u0007",
    ];
    for (const [index, tipVerify] of unusable.entries()) {
      const repo = mkRepo();
      seed(repo, `run-unusable-${index}`, ["T1"], (hash) => [
        { ts: at(0), event: "run-start", data: { pid: process.pid, graphDefinitionHash: hash, commands: { test: "npm test" } } },
        ...landed("T1", 1),
        { ts: at(13), event: "run-end", data: { done: ["T1"], failed: [], human: [], blocked: [], pending: [], tipVerify } },
      ]);

      const line = await status(["--oneline"], repo);

      expect(line).toBe(`run-unusable-${index} · 1/1 done · verify unrecorded`);
      expect(line.split("\n")).toHaveLength(1);
      expect(CONTROL_BYTE.test(line), JSON.stringify(line)).toBe(false);
      expect(line).not.toContain("verify passed");
      expect(line).not.toContain("verify failed");
    }
  });
});
