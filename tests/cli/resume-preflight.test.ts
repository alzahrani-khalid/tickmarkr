import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { resume } from "../../src/cli/commands/resume.js";
import { loadConfig } from "../../src/config/config.js";
import { graphDefinitionHash, loadGraph, saveGraph, setStatus } from "../../src/graph/graph.js";
import { SHAPES, validateGraph } from "../../src/graph/schema.js";
import { type DenyPreferCollision, denyPreferCollisions } from "../../src/route/preference.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { authedModels, setupRepo, T } from "../helpers/tmprepo.js";

const FAKE_ONLY_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

// A resumable run parked red: T1 failed, journal replayable, baseline present. Resume reaches its
// summary without dispatching anything, so what the preflight does is the only variable here.
async function parkedRedRun(extraCfg: string, runId = "run-red"): Promise<string> {
  const { repo } = setupRepo([T("T1")], { tasks: {} }, extraCfg);
  saveGraph(repo, setStatus(loadGraph(repo), "T1", "failed"));
  writeDoctor(repo, FAKE_ONLY_DOCTOR);
  const j = Journal.create(repo, runId);
  const baseRef = await gitHead(repo);
  j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  j.append("task-dispatch", "T1");
  j.append("task-failed", "T1", { error: "boom" });
  writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  return repo;
}

describe("v1.87 T3 resume preflight is scoped to the resumed graph", () => {
  // OBS-162, carried twice in this repo: the only crash-recovery path failed closed on a config fact
  // the resumed run would never resolve. deny claude-code collides with the DEFAULT plan/spec pins;
  // the graph carries only `implement`, so nothing the run touches is affected.
  test("test: resume proceeds past preflight when the only collision in the routing map is on a shape absent from the resumed graph", async () => {
    const repo = await parkedRedRun("routing:\n  deny:\n    adapters: [claude-code]\n");
    const graphShapes = new Set(loadGraph(repo).tasks.map((t) => t.shape));
    const wholeMap = denyPreferCollisions(loadConfig(repo));
    expect(wholeMap.length).toBeGreaterThan(0);
    expect(wholeMap.every((c) => !graphShapes.has(c.shape as (typeof SHAPES)[number]))).toBe(true);

    const r = await resume(["run-red"], repo);
    expect(r.out).toMatch(/resumed run-red/);
    expect(r.out).toMatch(/failed: 1/);
    expect(r.code).toBe(2);
  }, 120_000);

  // The narrowing is a scope change, not a retreat: a collision the resumed run WOULD hit still
  // refuses, with the same line the operator gets from doctor.
  test("test: resume still refuses with the collision line when the collision names a shape a resumed task uses", async () => {
    const repo = await parkedRedRun("routing:\n  deny:\n    adapters: [cursor-agent, codex]\n", "run-live");
    expect(loadGraph(repo).tasks.map((t) => t.shape)).toContain("implement");

    await expect(resume(["run-live"], repo)).rejects.toThrow(
      /deny∩prefer: routing\.map\.implement\.prefer cursor-agent > codex fully disallowed by routing\.deny/,
    );
  }, 120_000);

  test("test: pin collisions and prefer collisions are both scoped to the graph's shapes, proven member by member over the closed set of the two collision kinds", async () => {
    const kinds: DenyPreferCollision["kind"][] = ["pin", "prefer"];
    const { repo } = setupRepo([T("T1")], { tasks: {} }, [
      "routing:",
      "  deny:",
      "    adapters: [claude-code, cursor-agent, codex]",
      "  map:",
      "    migration:",
      "      pin: { via: claude-code, model: fable }",
      "",
    ].join("\n"));
    const cfg = loadConfig(repo);
    // the closed set: this fixture collides in BOTH kinds and no third kind exists
    expect(new Set(denyPreferCollisions(cfg).map((c) => c.kind))).toEqual(new Set(kinds));

    const shapeOf: Record<DenyPreferCollision["kind"], string> = { pin: "migration", prefer: "implement" };
    for (const kind of kinds) {
      const shape = shapeOf[kind];
      const graph = validateGraph({
        version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
        tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 3, acceptance: ["done"] }],
      });
      const inGraph = denyPreferCollisions(cfg, graph.tasks.map((t) => t.shape));
      expect(inGraph).toEqual([expect.objectContaining({ kind, shape })]);
      // …and scoping over every OTHER shape never surfaces it
      const elsewhere = denyPreferCollisions(cfg, SHAPES.filter((s) => s !== shape));
      expect(elsewhere.some((c) => c.shape === shape)).toBe(false);
      expect(elsewhere.some((c) => c.kind === kind)).toBe(kind === "pin"); // default plan/spec pins remain
    }
  });

  test("the preflight consumes the loaded graph's shape set rather than the whole routing map and runs after the graph is read, cited from the reordered lines in resume.ts", () => {
    const src = readFileSync(join(import.meta.dirname, "../../src/cli/commands/resume.ts"), "utf8");
    const graphRead = src.indexOf("const graph = loadGraph(cwd)");
    const preflight = src.indexOf("denyPreferCollisions(cfg, graph.tasks.map((t) => t.shape))");

    expect(graphRead).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(graphRead); // reordered: graph first, preflight second
    expect(src).not.toMatch(/denyPreferCollisions\(cfg\)/); // never the whole routing map
  });
});
