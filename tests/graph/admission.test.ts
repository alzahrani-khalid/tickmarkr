import { describe, expect, test } from "vitest";
import { chainDepth, readyTasks, setStatus } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { Journal } from "../../src/run/journal.js";
import { runDaemon } from "../../src/run/daemon.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// OBS-1018: four leaves declared BEFORE a dependency-free root of a three-deep chain R → A → B → C.
const chained = () => [T("L1"), T("L2"), T("L3"), T("L4"), T("R"), T("A", { deps: ["R"] }), T("B", { deps: ["A"] }), T("C", { deps: ["B"] })];
const graphOf = (tasks: unknown[]) => validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks });
const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);

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

  test("a fake-adapter run at concurrency one over that graph journals the chain root's task-dispatch before any leaf's and at concurrency two dispatches the root and the first declared leaf in wave one, so a daemon loop whose slice follows declaration order fails", async () => {
    const script = { tasks: Object.fromEntries(chained().map((t) => [t.id, [{ shell: `echo ${t.id} > ${t.id}.txt && ${COMMIT} ${t.id}`, result: { ok: true, summary: t.id } }]])) };
    const dispatches = async (runId: string, concurrency: number) => {
      const { repo, fake } = setupRepo(chained(), script);
      const s = await runDaemon(repo, { adapters: [fake], runId, concurrency });
      expect([...s.done].sort()).toEqual(["A", "B", "C", "L1", "L2", "L3", "L4", "R"]);
      return Journal.open(repo, runId).read().filter((e) => e.event === "task-dispatch").map((e) => e.taskId);
    };
    const one = await dispatches("run-obs1018-c1", 1);
    expect(one[0]).toBe("R");
    expect(one.indexOf("R")).toBeLessThan(Math.min(...["L1", "L2", "L3", "L4"].map((id) => one.indexOf(id))));
    const two = await dispatches("run-obs1018-c2", 2);
    expect(two.slice(0, 2)).toEqual(["R", "L1"]);
  }, 120_000);
});
