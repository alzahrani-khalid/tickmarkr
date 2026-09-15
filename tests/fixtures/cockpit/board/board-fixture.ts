import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphDefinitionHash, saveGraph } from "../../../../src/graph/graph.js";
import { validateGraph } from "../../../../src/graph/schema.js";
import type { JournalEvent } from "../../../../src/run/journal.js";

/* ------------------------------------------------------------------------ */
/* BD-1 board fixture. One run that holds every condition the golden names:  */
/* T1 parked three times · T2 three review rounds · T3 a failed gate ·       */
/* T4 waiting on an unmerged dependency · T5 dispatched with no gate result  */
/* · T6 omits review · T7 a files entry outside the area map · T9 a journal  */
/* task id absent from the graph. The clock is fixed so the header's elapsed */
/* and "ago" fields are reproducible: BOARD_NOW is what the renderer and the */
/* fixture copy of the prototype (TKR_NOW) both read.                        */
/* ------------------------------------------------------------------------ */

export const BOARD_RUN_ID = "run-20260912-100000";
export const BOARD_NOW = Date.parse("2026-09-12T11:05:00.000Z");
export const BOARD_ASSIGNMENT = { adapter: "claude-code", model: "opus", vendor: "anthropic", channel: "sub", tier: "frontier" } as const;

export const boardGraph = validateGraph({
  version: 1, spec: { paths: ["specs/board.spec.md"], hash: "fixture-board", source: "native" },
  tasks: [
    { id: "T1", title: "Spec loader parks on every human gate it meets", goal: "g", shape: "implement", complexity: 3, deps: [], files: ["src/compile/loader.ts", "src/gates/human.ts"], acceptance: ["a"] },
    { id: "T2", title: "Runner survives three review rounds before it lands", goal: "g", shape: "implement", complexity: 3, deps: [], files: ["src/{run,drivers}/dispatch.ts"], acceptance: ["a"] },
    { id: "T3", title: "Board renderer fails its test gate", goal: "g", shape: "ui", complexity: 3, deps: [], files: ["src/tui/cockpit/board.ts", "tests/cockpit/board.test.ts"], acceptance: ["a"] },
    { id: "T4", title: "Docs wait on the renderer", goal: "g", shape: "docs", complexity: 1, deps: ["T3"], files: ["docs/board.md"], acceptance: ["a"] },
    { id: "T5", title: "CLI flag in flight with no gate result yet", goal: "g", shape: "implement", complexity: 2, deps: [], files: ["src/cli/commands/board.ts"], acceptance: ["a"] },
    { id: "T6", title: "Gate test task that omits the review gate", goal: "g", shape: "tests", complexity: 2, deps: [], files: ["tests/gates/board.test.ts"], acceptance: ["a"], gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] },
    { id: "T7", title: "Router asset outside the area map", goal: "g", shape: "implement", complexity: 2, deps: [], files: ["assets/board.png", "src/route/board.ts"], acceptance: ["a"] },
    { id: "T8", title: "Queued task with no files", goal: "g", shape: "implement", complexity: 1, deps: [], files: [], acceptance: ["a"] },
  ],
});

let clock = Date.parse("2026-09-12T10:00:00.000Z");
const tick = (): string => { clock += 60_000; return new Date(clock).toISOString(); };
const ev = (event: string, data: Record<string, unknown> = {}, taskId?: string): JournalEvent => ({ ts: tick(), event, data, ...(taskId ? { taskId } : {}) });
const dispatch = (id: string, attempt: number) => ev("task-dispatch", { assignment: BOARD_ASSIGNMENT, attempt, worktree: `/wt/${id}` }, id);
const gate = (id: string, name: string, pass: boolean) => ev("gate-result", { gate: name, pass, details: `${name} ${pass ? "ok" : "red"}` }, id);

export const boardEvents: readonly JournalEvent[] = [
  ev("run-start", { graphDefinitionHash: graphDefinitionHash(boardGraph), branch: "tickmarkr/run", baseRef: "main" }),
  // T1 — parked three times on a human gate, re-dispatched twice, build/test/lint green on the third attempt.
  dispatch("T1", 0), ev("task-human", { kind: "human-gate", reason: "spec asks for a human" }, "T1"), ev("task-approved", { by: "operator", via: "cli" }, "T1"),
  dispatch("T1", 1), ev("task-human", { kind: "human-gate", reason: "still asks" }, "T1"), ev("task-approved", { by: "operator", via: "cli" }, "T1"),
  ev("run-resume", {}),
  dispatch("T1", 2), gate("T1", "build", true), gate("T1", "test", true), gate("T1", "lint", true), ev("task-human", { kind: "human-gate", reason: "third ask" }, "T1"),
  // T2 — every gate green; review needed three rounds; done and merged.
  dispatch("T2", 0), ...["build", "test", "lint", "evidence", "scope", "acceptance"].map((g) => gate("T2", g, true)),
  gate("T2", "review", false), ev("escalation", { step: 1, attempt: 1 }, "T2"), gate("T2", "review", false), ev("escalation", { step: 2, attempt: 1 }, "T2"), gate("T2", "review", true),
  ev("task-done", {}, "T2"), ev("merge", { commit: "abc1234" }, "T2"),
  // T3 — build green, test red, parked on the failed gate.
  dispatch("T3", 0), gate("T3", "build", true), gate("T3", "test", false), ev("task-human", { kind: "gate-fail", reason: "test red" }, "T3"),
  // T5 — dispatched, nothing has come back yet.
  dispatch("T5", 0),
  // T6 — review omitted by declaration; three gates green so far.
  dispatch("T6", 0), gate("T6", "build", true), gate("T6", "test", true), gate("T6", "lint", true),
  // T7 — dispatched; build green.
  dispatch("T7", 0), gate("T7", "build", true),
  // T9 — a task the journal names that this graph no longer carries (retired at compile).
  dispatch("T9", 0),
];

export const rawOf = (events: readonly JournalEvent[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

/** A temp repository holding the board graph and journal; `events` overrides the journal. */
export function boardFixture(events: readonly JournalEvent[] = boardEvents) {
  const cwd = mkdtempSync(join(tmpdir(), "board-fixture-"));
  const dir = join(cwd, ".tickmarkr", "runs", BOARD_RUN_ID);
  mkdirSync(dir, { recursive: true });
  saveGraph(cwd, boardGraph);
  // The fixture copy of the prototype reads the graph at its own unchanged root-relative path.
  const protoGraph = join(cwd, ".tickmarkr", "overseer", "graph-v185-safety-backup.json");
  mkdirSync(join(cwd, ".tickmarkr", "overseer"), { recursive: true });
  writeFileSync(protoGraph, readFileSync(join(cwd, ".tickmarkr", "graph.json")));
  writeFileSync(join(dir, "journal.jsonl"), rawOf(events));
  return { cwd, runId: BOARD_RUN_ID, graph: boardGraph, close: () => rmSync(cwd, { recursive: true, force: true }) };
}

/** A run-ended tail over the fixture: `park` names the bucket one task is parked in, none for the green variant. */
export function boardEndedEvents(park?: "failed" | "human" | "blocked" | "pending"): readonly JournalEvent[] {
  const ids = boardGraph.tasks.map((t) => t.id);
  const done = park ? ids.filter((id) => id !== "T8") : ids;
  const buckets = { failed: [] as string[], human: [] as string[], blocked: [] as string[], pending: [] as string[] };
  if (park) buckets[park] = ["T8"];
  return [
    ...boardEvents,
    ...done.flatMap((id) => [ev("task-done", {}, id), ev("merge", { commit: `m-${id}` }, id)]),
    ev("tip-verify", { pass: true }),
    ev("run-end", { done, ...buckets, tipVerify: "passed" }),
  ];
}
