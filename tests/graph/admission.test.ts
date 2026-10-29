import { describe, expect, test } from "vitest";
import { chainDepth, readyTasks, setStatus } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { Journal } from "../../src/run/journal.js";
import { runDaemon } from "../../src/run/daemon.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// OBS-1018: four leaves declared BEFORE a dependency-free root of a three-deep chain R → A → B → C.
const chained = () => [T("L1"), T("L2"), T("L3"), T("L4"), T("R"), T("A", { deps: ["R"] }), T("B", { deps: ["A"] }), T("C", { deps: ["B"] })];
const graphOf = (tasks: unknown[]) => validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks });
const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);
const DONE = ["A", "B", "C", "L1", "L2", "L3", "L4", "R"];
const waveScript = () => ({
  tasks: Object.fromEntries(chained().map((t) => [t.id, [{ shell: `echo ${t.id} > ${t.id}.txt && ${COMMIT} ${t.id}`, result: { ok: true, summary: t.id } }]])),
});

type JournalRow = { event: string; taskId?: string };
const dispatchIds = (events: readonly JournalRow[]) =>
  events.flatMap((e) => e.event === "task-dispatch" && e.taskId !== undefined ? [e.taskId] : []);

// Wave one is every task-dispatch before the first task-done, not the first two dispatch rows.
// Setup is per task, so those two rows follow a race in order and as a set.
function waveOneDispatches(events: readonly JournalRow[]): Set<string> {
  const firstTaskDone = events.findIndex((e) => e.event === "task-done");
  return new Set(dispatchIds(firstTaskDone < 0 ? events : events.slice(0, firstTaskDone)));
}

// Non-empty subset of {R, L1}. Exact equality is the pre-fix oracle: it rejects a prefix of only one id.
function isWaveOnePrefix(taskIds: ReadonlySet<string>): boolean {
  return taskIds.size > 0 && [...taskIds].every((id) => id === "R" || id === "L1");
}

function preFixRequiresBoth(taskIds: ReadonlySet<string>): boolean {
  return taskIds.size === 2 && taskIds.has("R") && taskIds.has("L1");
}

// Holds one task inside driver projection, which the daemon awaits before task-dispatch.
class HeldProjectionDriver extends SubprocessDriver {
  constructor(private readonly holdInProgress: (taskId: string) => Promise<void>) { super(); }
  async project(taskId: string, state: "in-progress" | "in-review" | "completed"): Promise<void> {
    if (state === "in-progress") await this.holdInProgress(taskId);
  }
}

async function waitForTaskEvent(repo: string, runId: string, taskId: string, event: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    let rows: JournalRow[] = [];
    try { rows = Journal.open(repo, runId).read(); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("no journal")) throw error;
    }
    if (rows.some((row) => row.event === event && row.taskId === taskId)) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${taskId} ${event}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("critical-path admission (OBS-1018)", () => {
  test("a graph declaring four leaf tasks before a dependency-free root of a three-deep chain returns that root first from readyTasks and the leaves after it in declaration order, two roots of equal depth keep declaration order, a task becomes ready only when every dependency is done, and a graph with no chains returns declaration order byte-identically to the base, so an admission that reads declaration order or reorders equal depths fails", () => {
    let g = graphOf(chained());
    expect(chainDepth(g).get("R")).toBe(3);
    expect(ids(readyTasks(g))).toEqual(["R", "L1", "L2", "L3", "L4"]);
    // A joins only once R is done; it then outranks every leaf, and nothing below it is ready yet
    g = setStatus(g, "R", "done");
    expect(ids(readyTasks(g))).toEqual(["A", "L1", "L2", "L3", "L4"]);
    expect(ids(readyTasks(setStatus(g, "A", "running")))).toEqual(["L1", "L2", "L3", "L4"]);

    // two roots of equal depth keep declaration order
    const twin = graphOf([T("L1"), T("R2"), T("R1"), T("A2", { deps: ["R2"] }), T("A1", { deps: ["R1"] })]);
    expect(ids(readyTasks(twin))).toEqual(["R2", "R1", "L1"]);

    // a task with two dependencies is ready only when every one of them is done
    let join = graphOf([T("X"), T("Y"), T("Z", { deps: ["X", "Y"] })]);
    join = setStatus(join, "X", "done");
    expect(ids(readyTasks(join))).toEqual(["Y"]);
    join = setStatus(join, "Y", "done");
    expect(ids(readyTasks(join))).toEqual(["Z"]);

    // no chains: byte-identical to the base declaration order
    const flat = graphOf([T("F3"), T("F1"), T("F2")]);
    expect(JSON.stringify(readyTasks(flat))).toBe(JSON.stringify(flat.tasks));
  });

  test("a fake-adapter run at concurrency one journals the chain root's task-dispatch before any leaf's and at concurrency two only the root and the first declared leaf dispatch before any task completes, so a declaration-order slice fails", async () => {
    const rows = async (runId: string, concurrency: number) => {
      const { repo, fake } = setupRepo(chained(), waveScript());
      const s = await runDaemon(repo, { adapters: [fake], runId, concurrency });
      expect([...s.done].sort()).toEqual(DONE);
      return Journal.open(repo, runId).read();
    };
    const one = dispatchIds(await rows("run-obs1018-c1", 1));
    expect(one[0]).toBe("R");
    expect(one.indexOf("R")).toBeLessThan(Math.min(...["L1", "L2", "L3", "L4"].map((id) => one.indexOf(id))));
    // Each admitted task journals task-dispatch only after its own setup, so the first two rows —
    // compared in order or as a set — are not wave one. Wave one is every dispatch before the first
    // task-done: a non-empty set holding only the chain root and the first declared leaf. Either id
    // may be absent when that task's setup outlasts the other's completion.
    const two = await rows("run-obs1018-c2", 2);
    const firstTaskDone = two.findIndex((e) => e.event === "task-done");
    expect(firstTaskDone).toBeGreaterThanOrEqual(0);
    const dispatchesBeforeFirstTaskDone = waveOneDispatches(two);
    expect(dispatchesBeforeFirstTaskDone.size).toBeGreaterThan(0);
    for (const id of dispatchesBeforeFirstTaskDone) expect(["R", "L1"]).toContain(id);
  }, 120_000);

  test("a fake-adapter run at concurrency two with the chain root held in projection until the first declared leaf completes journals only that leaf before the first task-done, and holding the leaf until the root completes journals only the root, so exact equality with both ids rejects each prefix", async () => {
    const held = async (runId: string, taskId: string, untilTask: string) => {
      const { repo, fake } = setupRepo(chained(), waveScript());
      const driver = new HeldProjectionDriver((id) => id === taskId ? waitForTaskEvent(repo, runId, untilTask, "task-done") : Promise.resolve());
      const summary = await runDaemon(repo, { adapters: [fake], runId, concurrency: 2, driver });
      expect([...summary.done].sort()).toEqual(DONE);
      return waveOneDispatches(Journal.open(repo, runId).read());
    };
    // Found consequence, through runDaemon: R awaits projection while L1 dispatches and completes.
    const onlyLeaf = await held("run-obs1018-c2-root-held", "R", "L1");
    expect([...onlyLeaf].sort()).toEqual(["L1"]);
    expect(isWaveOnePrefix(onlyLeaf)).toBe(true);
    expect(preFixRequiresBoth(onlyLeaf)).toBe(false);
    // The other singleton the same race allows.
    const onlyRoot = await held("run-obs1018-c2-leaf-held", "L1", "R");
    expect([...onlyRoot].sort()).toEqual(["R"]);
    expect(isWaveOnePrefix(onlyRoot)).toBe(true);
    expect(preFixRequiresBoth(onlyRoot)).toBe(false);
  }, 180_000);

  test("every non-empty subset of the chain root and the first declared leaf is a pre-completion wave and every other id is not, while exact equality with both ids and a first-two-rows slice each reject a legal delayed-root journal", () => {
    const row = (event: string, taskId?: string): JournalRow => ({ event, taskId });
    const samples: { label: string; events: JournalRow[]; members: string[] | null }[] = [
      { label: "delayed root, leaf completes, later leaf dispatches", events: [row("task-dispatch", "L1"), row("task-done", "L1"), row("task-dispatch", "L2"), row("task-dispatch", "R")], members: ["L1"] },
      { label: "delayed leaf, root completes first", events: [row("task-dispatch", "R"), row("task-done", "R"), row("task-dispatch", "L1")], members: ["R"] },
      { label: "both before either completes, leaf first", events: [row("task-dispatch", "L1"), row("task-dispatch", "R"), row("task-done", "L1")], members: ["L1", "R"] },
      { label: "both before either completes, root first", events: [row("task-dispatch", "R"), row("task-dispatch", "L1"), row("task-done", "R")], members: ["L1", "R"] },
      { label: "first two dispatch rows as a set include a later leaf", events: [row("task-dispatch", "L1"), row("task-dispatch", "L2"), row("task-done", "L1")], members: null },
      { label: "no dispatch before the first completion", events: [row("task-done", "L1")], members: null },
      { label: "chain descendant", events: [row("task-dispatch", "A"), row("task-done", "A")], members: null },
      { label: "later leaves", events: [row("task-dispatch", "L3"), row("task-dispatch", "L4"), row("task-done", "L3")], members: null },
      { label: "wave plus an outsider", events: [row("task-dispatch", "R"), row("task-dispatch", "L1"), row("task-dispatch", "B"), row("task-done", "R")], members: null },
    ];
    for (const sample of samples) {
      const prefix = waveOneDispatches(sample.events);
      expect(isWaveOnePrefix(prefix), sample.label).toBe(sample.members !== null);
      if (!sample.members) continue;
      expect([...prefix].sort(), sample.label).toEqual([...sample.members].sort());
      expect(preFixRequiresBoth(prefix), sample.label).toBe(sample.members.length === 2);
    }
    // The probe's journal order. The first two dispatch rows, in order or as a set, are L1 then L2.
    // The dispatches before the first task-done are only L1.
    const probe = samples[0]!.events;
    expect(dispatchIds(probe).slice(0, 2)).toEqual(["L1", "L2"]);
    expect([...waveOneDispatches(probe)].sort()).toEqual(["L1"]);
  });
});
