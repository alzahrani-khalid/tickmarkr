import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  addEvidence, attributeBlocked, blockedTasks, closureReaches, getTask, isComplete, isStalled,
  tickmarkrDir, loadGraph, pendingTasks, readyTasks, saveGraph, setStatus,
} from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";

const g3 = () =>
  validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p.md"], hash: "h" },
    tasks: [
      { id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] },
      { id: "T2", title: "b", goal: "b", shape: "tests", complexity: 3, deps: ["T1"], acceptance: ["b"] },
      { id: "T3", title: "c", goal: "c", shape: "docs", complexity: 2, deps: ["T1", "T2"], acceptance: ["c"] },
    ],
  });

describe("graph ops", () => {
  test("readyTasks: only deps-done pending tasks", () => {
    let g = g3();
    expect(readyTasks(g).map((t) => t.id)).toEqual(["T1"]);
    g = setStatus(g, "T1", "done");
    expect(readyTasks(g).map((t) => t.id)).toEqual(["T2"]);
  });

  test("setStatus is immutable and addEvidence appends", () => {
    const g = g3();
    const g2 = setStatus(g, "T1", "running");
    expect(getTask(g, "T1").status).toBe("pending");
    expect(getTask(g2, "T1").status).toBe("running");
    const g3e = addEvidence(g2, "T1", { commits: ["abc"], gateResults: [{ gate: "build", pass: true }] });
    expect(getTask(g3e, "T1").evidence.commits).toEqual(["abc"]);
    expect(getTask(g3e, "T1").evidence.gateResults).toHaveLength(1);
  });

  test("isComplete / isStalled", () => {
    let g = g3();
    expect(isComplete(g)).toBe(false);
    expect(isStalled(g)).toBe(false); // T1 is ready
    g = setStatus(g, "T1", "failed"); // blocks T2, T3
    expect(isStalled(g)).toBe(true);
    g = setStatus(g, "T1", "done");
    g = setStatus(g, "T2", "done");
    g = setStatus(g, "T3", "done");
    expect(isComplete(g)).toBe(true);
  });

  test("save/load round-trip creates the state dir with self-gitignore", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-graph-"));
    saveGraph(dir, g3());
    const g = loadGraph(dir);
    expect(g.tasks).toHaveLength(3);
    expect(loadGraph(dir).tasks[0].id).toBe("T1");
    const gi = join(tickmarkrDir(dir), ".gitignore");
    expect(readFileSync(gi, "utf8")).toBe("*\n");
  });

  test("getTask throws on unknown id", () => {
    expect(() => getTask(g3(), "T99")).toThrow(/unknown task/i);
  });
});

// VIS-01: blocked/pending are first-class buckets; helpers depend on RunGraph alone.
describe("blocked/pending buckets (closureReaches + blockedTasks + pendingTasks)", () => {
  // Diamond: A → B, A → C, B&C → D. Failing any single root counts D as blocked exactly once.
  const diamond = () =>
    validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p.md"], hash: "h" },
      tasks: [
        { id: "A", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] },
        { id: "B", title: "b", goal: "b", shape: "implement", complexity: 3, deps: ["A"], acceptance: ["b"] },
        { id: "C", title: "c", goal: "c", shape: "implement", complexity: 3, deps: ["A"], acceptance: ["c"] },
        { id: "D", title: "d", goal: "d", shape: "implement", complexity: 3, deps: ["B", "C"], acceptance: ["d"] },
      ],
    });

  test("closureReaches walks forward along deps and matches a parked root", () => {
    let g = diamond();
    expect(closureReaches(g, "D", (t) => t.status === "failed")).toBe(false); // nothing parked yet
    g = setStatus(g, "A", "failed");
    expect(closureReaches(g, "D", (t) => t.status === "failed")).toBe(true);
    expect(closureReaches(g, "D", (t) => t.status === "human")).toBe(false); // predicate is exact
    g = setStatus(g, "B", "human");
    expect(closureReaches(g, "D", (t) => t.status === "human")).toBe(true); // nearest parked ancestor matches too
  });

  test("pending behind failed → blocked", () => {
    let g = g3();
    g = setStatus(g, "T1", "failed"); // T2 and T3 chain through T1
    expect(blockedTasks(g).map((t) => t.id).sort()).toEqual(["T2", "T3"]);
    expect(pendingTasks(g)).toEqual([]);
  });

  test("pending behind human → blocked", () => {
    let g = g3();
    g = setStatus(g, "T1", "human");
    expect(blockedTasks(g).map((t) => t.id).sort()).toEqual(["T2", "T3"]);
    expect(pendingTasks(g)).toEqual([]);
  });

  test("pending behind only running/pending deps → pending, never blocked", () => {
    let g = g3();
    g = setStatus(g, "T1", "running"); // T2's only dep is still running
    expect(blockedTasks(g)).toEqual([]);
    expect(pendingTasks(g).map((t) => t.id).sort()).toEqual(["T2", "T3"]);
  });

  test("diamond dep counted once as blocked", () => {
    let g = diamond();
    g = setStatus(g, "A", "failed"); // both B/C/D strand
    const blocked = blockedTasks(g).map((t) => t.id).sort();
    expect(blocked).toEqual(["B", "C", "D"]); // D appears once even though two paths reach the parked root
    expect(pendingTasks(g)).toEqual([]);
  });

  test("mixed graph: blocked + pending + done partition pending tasks truthfully", () => {
    let g = diamond();
    g = setStatus(g, "A", "done");
    g = setStatus(g, "B", "failed"); // D strands behind B; C is still runnable; D is blocked
    expect(blockedTasks(g).map((t) => t.id)).toEqual(["D"]);
    expect(pendingTasks(g).map((t) => t.id)).toEqual(["C"]);
  });
});

// VIS-02: attributeBlocked names the nearest parked root per blocked subtree, never double-counting.
describe("attributeBlocked (nearest-ancestor BFS)", () => {
  // Diamond-dep attribution: L reaches TWO parked roots (R2 directly, R1 via M) — the nearer
  // one (R2, one hop) wins; M reaches only R1. Each blocked task counted exactly once.
  const twoRoots = () =>
    validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p.md"], hash: "h" },
      tasks: [
        { id: "R1", title: "r1", goal: "r1", shape: "implement", complexity: 3, acceptance: ["a"] },
        { id: "R2", title: "r2", goal: "r2", shape: "implement", complexity: 3, acceptance: ["a"] },
        { id: "M", title: "m", goal: "m", shape: "implement", complexity: 3, deps: ["R1"], acceptance: ["a"] },
        { id: "L", title: "l", goal: "l", shape: "implement", complexity: 3, deps: ["M", "R2"], acceptance: ["a"] },
      ],
    });

  test("diamond-dep attribution: nearest parked root wins, single attribution, never double-counted", () => {
    let g = twoRoots();
    g = setStatus(g, "R1", "failed");
    g = setStatus(g, "R2", "failed");
    const attribution = attributeBlocked(g);
    expect(attribution.get("R1")).toBe(1); // M — one hop to R1
    expect(attribution.get("R2")).toBe(1); // L — one hop to R2, nearer than the two-hop path via M→R1
    expect([...attribution.values()].reduce((a, b) => a + b, 0)).toBe(blockedTasks(g).length); // no double-count
  });

  test("no blocked tasks → empty attribution map", () => {
    expect(attributeBlocked(g3())).toEqual(new Map());
  });

  test("simple chain: single parked root attributes every downstream task to it", () => {
    let g = g3();
    g = setStatus(g, "T1", "failed");
    const attribution = attributeBlocked(g);
    expect(attribution.get("T1")).toBe(2); // T2 and T3 both nearest to T1
    expect(attribution.size).toBe(1);
  });
});
