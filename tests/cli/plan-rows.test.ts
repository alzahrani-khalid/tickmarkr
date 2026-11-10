import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import type { BillingChannel, WorkerAdapter } from "../../src/adapters/types.js";
import { plan, type PlanTaskRow } from "../../src/cli/commands/plan.js";
import type { VitestListResult } from "../../src/gates/acceptance.js";
import { saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { RoutingError } from "../../src/route/router.js";
import { makeRepo } from "../helpers/tmprepo.js";

const channels: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
  { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
];
const adapter = {
  id: "fake",
  vendor: "fake-a",
  probe: async () => ({ installed: true, authed: true, models: [] }),
  channels: () => channels,
} as unknown as WorkerAdapter;

const noTests = async (): Promise<VitestListResult> => ({ status: "listed", tests: [] });

// T1 routes, T2 hits a config map pin to an absent model (RoutingError), T3 names an unlisted test oracle.
function rowsRepo(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["fixture"], hash: "fixture" },
    tasks: [
      { id: "T1", title: "routed task", goal: "g", shape: "chore", complexity: 2, acceptance: ["judge me", "and me"] },
      { id: "T2", title: "unroutable task", goal: "g", shape: "migration", complexity: 2, acceptance: ["a"] },
      { id: "T3", title: "refused task", goal: "g", shape: "chore", complexity: 2, acceptance: [{ oracle: "test", test: "missing oracle" }] },
    ],
  }));
  const probedAt = "2026-08-30T00:00:00.000Z";
  writeDoctor(repo, {
    fake: {
      installed: true,
      authed: true,
      models: [],
      modelAuth: { "fake-1": { authed: true, probedAt }, "fake-2": { authed: true, probedAt } },
    },
  });
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), [
    "judge: { adapter: fake, model: fake-1 }",
    "routing:",
    "  map:",
    "    migration:",
    "      pin: { via: fake, model: absent }",
    "",
  ].join("\n"));
  return repo;
}

const planned = (repo: string, onTask?: (row: PlanTaskRow) => void) =>
  plan([], repo, [adapter], undefined, { listTests: noTests, ...(onTask ? { onTask } : {}) });

describe("plan per-task callback", () => {
  test("plan given a per-task callback over a graph holding a routed task, an unroutable task and a pre-dispatch refusal calls it once per task in graph order, with the routed worker and the exact printed judge and review seat strings on the routed task, and with no worker and the printed reason on the other two, so a callback that skips a branch or reorders tasks fails", async () => {
    const repo = rowsRepo();
    const rows: PlanTaskRow[] = [];
    const out = await planned(repo, (row) => rows.push(row));

    expect(rows.map((r) => r.id)).toEqual(["T1", "T2", "T3"]);
    const [routed, unroutable, refused] = rows;

    expect(routed).toEqual({
      id: "T1",
      title: "routed task",
      shape: "chore",
      acceptance: 2,
      worker: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
      // Rows 362 and 367 R5 (D-2187): the configured judge fake:fake-1 is the routed author, so the run's
      // judge — and plan's — is the seat resolver's independent pick, as at the base.
      judge: "fake:fake-2",
      review: "fake:fake-2 — reviewPolicy full",
    });
    // The seat strings are exactly what plan prints after "judge: " / "review: ", minus the cost suffix.
    expect(out).toContain(`    judge: ${routed!.judge} ~$`);
    expect(out).toContain(`    review: ${routed!.review} ~$`);

    expect(unroutable!.worker).toBeUndefined();
    expect(unroutable!.judge).toBeUndefined();
    expect(unroutable!.review).toBeUndefined();
    expect(unroutable).toMatchObject({ id: "T2", title: "unroutable task", shape: "migration", acceptance: 1 });
    expect(unroutable!.blocked).toContain("pinned fake:absent not available");
    expect(out).toContain(`  T2     migration  !! ${unroutable!.blocked}\n`);

    expect(refused!.worker).toBeUndefined();
    expect(refused).toMatchObject({ id: "T3", title: "refused task", shape: "chore", acceptance: 1 });
    expect(refused!.blocked).toBe(`acceptance oracle "missing oracle" matches zero runner-listed test names`);
    expect(out).toContain(`  T3     chore      !! pre-dispatch refusal — ${refused!.blocked}\n`);
  });

  test("plan's returned text with a per-task callback equals its text without one, byte for byte, on the same graph and fleet, so a callback that adds or drops a printed line fails", async () => {
    const repo = rowsRepo();
    let calls = 0;
    const withCallback = await planned(repo, () => { calls++; });
    const without = await planned(repo);
    expect(calls).toBe(3);
    expect(withCallback).toBe(without);
  });

  test("a per-task callback that throws an Error, and one that throws the router's routing error class, each make plan reject with that same thrown object after one delivery and no delivery for later tasks, so a callback error caught as an unroutable task fails", async () => {
    for (const thrown of [new Error("callback failed"), new RoutingError("callback routing failure")]) {
      const repo = rowsRepo();
      const seen: string[] = [];
      let caught: unknown;
      try {
        await planned(repo, (row) => { seen.push(row.id); throw thrown; });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBe(thrown);
      expect(seen).toEqual(["T1"]);
    }
  });
});
