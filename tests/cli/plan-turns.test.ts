// Rows 501, 502 (D-2187 add.367): plan routes each task with the compiled graph, so on a line by complexity the
// models of a group take real turns over the graph's peers (contract 1.5 (vii) U2, U10), and on any, ordered and
// open routing it prints byte for byte what it printed in 2.26.1, before the graph was passed.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { channelKey, type BillingChannel } from "../../src/adapters/types.js";
import { plan, type PlanTaskRow } from "../../src/cli/commands/plan.js";
import type { VitestListResult } from "../../src/gates/acceptance.js";
import { saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { authedModels, makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

// The 2.26.1 oracle: the same route() with the graph argument dropped, as every caller called it then.
const base = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/route/router.js", async (orig) => {
  const m = await orig<typeof import("../../src/route/router.js")>();
  return { ...m, route: (...a: Parameters<typeof m.route>) => m.route(...(base.on ? a.slice(0, 7) as Parameters<typeof m.route> : a)) };
});

const MODELS = ["fake-1", "fake-2", "fake-3"];
const script = join(makeTestTempDir("tkr-plan-turns-"), "s.json");
writeFileSync(script, "{}");
const fake = new FakeAdapter(script);
fake.probe = async () => ({ installed: true, authed: true, version: "fake", models: MODELS, modelAuth: authedModels(MODELS) });
fake.channels = (): BillingChannel[] => MODELS.map((model) => ({ adapter: "fake", model, vendor: "fake-a", channel: "sub", tier: "frontier" }));

const pool = (mode: string) => `routing:\n  map:\n    implement:\n      pool:\n        mode: ${mode}\n        channels: [fake:fake-1, fake:fake-2, fake:fake-3]\n`;
const U2 = [T("T1", { goal: "a", complexity: 3 }), T("T2", { goal: "b", complexity: 5 }), T("T3", { goal: "c", complexity: 7 })];
const compile = (repo: string, tasks: unknown[]) =>
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks }));
const repoWith = (tasks: unknown[], routing: string) => {
  const repo = makeRepo({ "base.txt": "base\n" });
  compile(repo, tasks);
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), `judge: { adapter: fake, model: fake-1 }\nreview: { required: false }\n${routing}`);
  return repo;
};
const noTests = async (): Promise<VitestListResult> => ({ status: "listed", tests: [] });
const planned = async (repo: string) => {
  const rows: PlanTaskRow[] = [];
  const out = await plan([], repo, [fake], undefined, { listTests: noTests, onTask: (r) => rows.push(r) });
  return { out, named: Object.fromEntries(rows.map((r) => [r.id, r.worker ? channelKey(r.worker) : "none"])) };
};

describe("rows 501, 502: plan passes the compiled graph to route()", () => {
  test("plan gives a three-task graph on a three-model group one task for each model", async () => {
    const { out, named } = await planned(repoWith(U2, pool("complexity")));
    expect(named).toEqual({ T1: "fake:fake-1", T2: "fake:fake-2", T3: "fake:fake-3" });
    expect(out).toContain("by complexity: every task 1-10, group 1 of 1, one of 3 that take turns; grouped by level: fake:fake-1, fake:fake-2, fake:fake-3 has no score (config routing.map)");
  });

  test("a done peer keeps its turn: plan reads the whole graph, done and pending alike", async () => {
    // U5's bait: a rank read from the tasks still pending would hand T2 and T3 the first model once T1 is done.
    const done = [{ ...U2[0], status: "done" }, ...U2.slice(1)];
    expect((await planned(repoWith(done, pool("complexity")))).named).toEqual({ T1: "fake:fake-1", T2: "fake:fake-2", T3: "fake:fake-3" });
  });

  test("on any lines; ordered lines; open routing: plan prints what it prints in 2.26.1", async () => {
    for (const routing of [pool("any"), pool("ordered"), ""]) {
      const repo = repoWith(U2, routing);
      const now = (await planned(repo)).out;
      base.on = true;
      try {
        expect(now).toBe((await planned(repo)).out);
      } finally {
        base.on = false;
      }
    }
  });

  test("a re-compile that inserts an earlier peer moves the turns of the tasks not yet dispatched", async () => {
    const repo = repoWith(U2, pool("complexity"));
    expect((await planned(repo)).named).toEqual({ T1: "fake:fake-1", T2: "fake:fake-2", T3: "fake:fake-3" });
    compile(repo, [T("T0", { goal: "d", complexity: 4 }), ...U2]);
    expect((await planned(repo)).named).toEqual({ T0: "fake:fake-1", T1: "fake:fake-2", T2: "fake:fake-3", T3: "fake:fake-1" });
  });
});
