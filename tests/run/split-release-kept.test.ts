// Queue row 415 (D-2187 add.73): a graph-changed resume keeps and holds an open park whose own definition
// (fingerprint and files) did not change, for every park kind, before the exempt-kind branches. The kept cells
// run through runDaemon; the release controls and the plain resume run through the decider the daemon calls.
// Zero tokens: fake adapter, disposable repositories.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { graphDefinitionHash, loadGraph, saveGraph } from "../../src/graph/graph.js";
import { validateGraph, type Task } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal, physicalLine, type JournalEvent } from "../../src/run/journal.js";
import { decideSplitRelease, PARK_KEPT_EVENT, parkDefinition, splitReleaseReads, type TaskWorkRead } from "../../src/run/split-release.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const SPEC = { source: "prd", paths: ["p"], hash: "h" };
const SEAT = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const SCHEDULED = ["task-dispatch", "worker-launch", "recheck-battery", "gate-result", "task-done", "task-approved", "task-human"];
const OK = [{ oracle: "command", command: "true" }];

const PARKS: Record<string, { kind: string; reason: string; humanGate?: boolean; dispatched: boolean }> = {
  D1: { kind: "diff-cap", reason: "diff cap exceeded (1200 > 800 lines)", dispatched: true },
  R1: { kind: "gate-fail", reason: "review round cap (3) reached: review still red", dispatched: true },
  H1: { kind: "human-gate", reason: "humanGate: \"H1\" requires approval before dispatch", humanGate: true, dispatched: false },
  A1: { kind: "attempt-cap", reason: "attempt cap (10) reached", dispatched: true },
};

/** Four open parks whose own definitions the recompile leaves unchanged, and one unparked task (Z1) whose
 * definition it changes, so the resume is graph-changed. */
async function keptScenario() {
  const tasks = [
    ...Object.entries(PARKS).map(([id, p]) => T(id, { files: [`${id}.txt`], acceptance: OK, ...(p.humanGate ? { humanGate: true } : {}) })),
    T("Z1", { files: ["Z1.txt"], acceptance: OK }),
  ];
  const ids = [...Object.keys(PARKS), "Z1"];
  const { repo, scriptPath } = setupRepo(tasks, {
    tasks: Object.fromEntries(ids.map((id) => [id, [{ shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } }]])),
  });
  const runId = "run-split-kept";
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { baseRef: await gitHead(repo), branch: `tickmarkr/${runId}`, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  const graph = loadGraph(repo);
  for (const [id, p] of Object.entries(PARKS)) {
    if (p.dispatched) journal.append("task-dispatch", id, { assignment: SEAT, attempt: 0 });
    journal.append("task-human", id, { kind: p.kind, reason: p.reason, definition: parkDefinition(graph.tasks.find((t) => t.id === id)!) });
  }
  journal.append("run-end", undefined, { done: [], failed: [], human: Object.keys(PARKS), blocked: [], pending: ["Z1"] });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  const seeded = journal.read();
  const lines = Object.fromEntries(Object.keys(PARKS).map((id) =>
    [id, physicalLine(seeded, seeded.map((e) => e.event === "task-human" && e.taskId === id).lastIndexOf(true))]));
  // the recompile writes every task pending; only Z1's definition changes
  saveGraph(repo, validateGraph({ version: 1, spec: SPEC, tasks: tasks.map((t) => (t.id === "Z1" ? { ...t, goal: "Z1, split" } : t)) }));
  const summary = await runDaemon(repo, { adapters: [new FakeAdapter(scriptPath)], runId, resume: true, graphChanged: true });
  const events = Journal.open(repo, runId).read();
  const resumed = events.slice(seeded.length); // every row this launch wrote, the graph-rehash included
  return { repo, summary, resumed, lines };
}

let scenario: ReturnType<typeof keptScenario> | undefined;
const once = () => (scenario ??= keptScenario());

function expectKeptAndHeld(h: Awaited<ReturnType<typeof keptScenario>>, ids: string[]) {
  expect(h.resumed.some((e) => e.event === "graph-rehash")).toBe(true);
  for (const id of ids) {
    const kept = h.resumed.filter((e) => e.taskId === id && e.event === PARK_KEPT_EVENT);
    expect(kept.map((e) => e.data.park), id).toEqual([h.lines[id]]);
    expect(String(kept[0]!.data.reason), id).toContain("definition unchanged");
    expect(h.resumed.filter((e) => e.taskId === id && SCHEDULED.includes(e.event)).map((e) => e.event), id).toEqual([]);
    expect(loadGraph(h.repo).tasks.find((t) => t.id === id)?.status, id).toBe("human");
  }
  expect(h.summary.human).toEqual(expect.arrayContaining(ids));
}

// ---- the decider: the changed-definition controls and the plain resume ------------------------------------
const loaded = (task: Record<string, unknown>): Task => validateGraph({ version: 1, spec: SPEC, tasks: [task] }).tasks[0]!;
const BEFORE = loaded(T("T1", { files: ["f.txt"], acceptance: OK }));
let clock = 0;
const row = (event: string, taskId?: string, data: Record<string, unknown> = {}): JournalEvent =>
  ({ ts: new Date(Date.UTC(2026, 10, 10, 0, 0, 0, clock++)).toISOString(), event, ...(taskId ? { taskId } : {}), data });
const parked = (kind: string): JournalEvent[] => [
  row("run-start", undefined, { baseRef: "b".repeat(40) }),
  row("task-dispatch", "T1", { attempt: 0, assignment: SEAT }),
  row("task-human", "T1", { kind, reason: `${kind} park`, definition: parkDefinition(BEFORE) }),
  row("run-end", undefined, { human: ["T1"] }),
];
const REHASH = { from: "a1a1a1a1a1a1a1a1", to: "5f5f5f5f5f5f5f5f" };
const decide = (events: JournalEvent[], task: Task, work: TaskWorkRead, rehash: typeof REHASH | null = REHASH) => {
  const input = { runId: "run-kept-table", events, tasks: [task], rehash: rehash ?? undefined };
  return { decisions: decideSplitRelease(input, new Map([["T1", work]])), reads: splitReleaseReads(input) };
};

describe("row 415 — a graph-changed resume keeps a park whose own definition did not change", () => {
  test("a diff cap park and a review round cap park whose own definition did not change are kept and held with no dispatch on a graph changed resume", async () => {
    const h = await once();
    expectKeptAndHeld(h, ["D1", "R1"]);
    // the other task's changed definition made the resume graph-changed, and it ran as at the base
    expect(h.summary.done).toContain("Z1");
  }, 300_000);

  test("an unchanged human gate park and an unchanged attempt cap park each get one kept row and stay held", async () => {
    expectKeptAndHeld(await once(), ["H1", "A1"]);
  }, 300_000);

  test("a park whose own definition or files changed is released as before and a plain resume decides nothing", () => {
    const changedGoal = loaded(T("T1", { files: ["f.txt"], acceptance: OK, goal: "T1, split" }));
    const changedFiles = loaded(T("T1", { files: ["f.txt", "g.txt"], acceptance: OK }));
    expect(parkDefinition(changedFiles).fingerprint).toBe(parkDefinition(BEFORE).fingerprint);
    for (const kind of ["diff-cap", "gate-fail"]) {
      for (const task of [changedGoal, changedFiles]) {
        const withCommits = decide(parked(kind), task, { head: "c".repeat(40), commits: 2 });
        expect(withCommits.reads, kind).toEqual(["T1"]);
        expect(withCommits.decisions.map((d) => [d.event, d.data.release]), kind).toEqual([["task-approved", "recheck"]]);
        const fresh = decide(parked(kind), task, { commits: 0 });
        expect(fresh.decisions.map((d) => [d.event, d.data.release]), kind).toEqual([["task-approved", undefined]]);
      }
      // a plain resume (no rehash on this launch) decides nothing, changed or not
      for (const task of [BEFORE, changedGoal]) expect(decide(parked(kind), task, { commits: 0 }, null)).toEqual({ decisions: [], reads: [] });
    }
  });
});
