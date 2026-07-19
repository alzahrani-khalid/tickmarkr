import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { BillingChannel } from "../../src/adapters/types.js";
import { loadConfig } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { cellOf } from "../../src/route/profile.js";
import { Journal, loadRoutingProfile } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// Two same-tier sub channels ⇒ a static tie resolved by discovery order (fake-1 first) — the seam the bonus decides.
class TiedFake extends FakeAdapter {
  channels(): BillingChannel[] {
    return [
      { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
      { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "sub", tier: "frontier" },
    ];
  }
}

// 2 gate-fail rows warming fake:fake-2 for shape "implement" ⇒ dispatches=2 < CAP ⇒ bonus 0.6 (under-cap probe target)
const seedProbe = (repo: string) => {
  const dir = join(tickmarkrDir(repo), "runs", "run-20200101-000000");
  mkdirSync(dir, { recursive: true });
  const row = JSON.stringify({
    taskId: "T0", shape: "implement", adapter: "fake", model: "fake-2", channel: "sub",
    attempts: 1, outcome: "human", durationMs: 1000, parkKind: "gate-fail", gateFails: 1, consults: 0,
  });
  writeFileSync(join(dir, "telemetry.jsonl"), Array(2).fill(row).join("\n") + "\n");
};

// 6 clean rows ⇒ dispatches=6 ≥ CAP ⇒ bonus 0, score real (the score-driven control)
const seedWarm = (repo: string) => {
  const dir = join(tickmarkrDir(repo), "runs", "run-20200101-000000");
  mkdirSync(dir, { recursive: true });
  const row = JSON.stringify({
    taskId: "T0", shape: "implement", adapter: "fake", model: "fake-2", channel: "sub",
    attempts: 1, outcome: "done", durationMs: 1000, gateFails: 0, consults: 0,
  });
  writeFileSync(join(dir, "telemetry.jsonl"), Array(6).fill(row).join("\n") + "\n");
};

const winScript = { T1: [{ shell: `echo x > f.txt && ${COMMIT} f`, result: { ok: true, summary: "ok" } }] };
const dispatchAssign = (repo: string, runId: string) =>
  Journal.open(repo, runId).read().find((e) => e.event === "task-dispatch")!.data.assignment as { model: string };
const deviations = (repo: string, runId: string) =>
  Journal.open(repo, runId).read().filter((e) => e.event === "route-deviation");

describe("EXP-03 exploratory dispatch rides the route-deviation event (fake adapter, zero tokens)", () => {
  test("14-01-09 probe run: one route-deviation with explore:true, dispatch is fake-2", async () => {
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: winScript }, "routing: { learned: on }\n");
    seedProbe(repo);
    await runDaemonWith(repo, scriptPath, "run-probe");
    const evs = deviations(repo, "run-probe");
    expect(evs).toHaveLength(1);
    expect(evs[0].data).toMatchObject({ static: "fake:fake-1", chosen: "fake:fake-2", explore: true });
    expect(evs[0].data.provenance).toMatch(/via exploration probe/);
    expect(dispatchAssign(repo, "run-probe").model).toBe("fake-2");
  });

  test("14-01-09 control: warm telemetry ⇒ score-driven deviation carries NO explore flag", async () => {
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: winScript }, "routing: { learned: on }\n");
    seedWarm(repo);
    await runDaemonWith(repo, scriptPath, "run-warm");
    const evs = deviations(repo, "run-warm");
    expect(evs).toHaveLength(1);
    expect(evs[0].data.provenance).toMatch(/via learned score/);
    expect("explore" in evs[0].data).toBe(false);
    expect(dispatchAssign(repo, "run-warm").model).toBe("fake-2");
  });

  test("14-01-10 the loop closes: the probe's outcome lands in telemetry and the rebuilt profile counts it", async () => {
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: winScript }, "routing: { learned: on }\n");
    seedProbe(repo);
    await runDaemonWith(repo, scriptPath, "run-loop");
    const wrote = Journal.open(repo, "run-loop").readTelemetry();
    expect(wrote.some((r) => r.model === "fake-2" && r.outcome === "done")).toBe(true);
    const cfg = loadConfig(repo);
    const profile = loadRoutingProfile(repo, cfg, { preview: true })!;
    expect(cellOf(profile, "implement", "fake:fake-2", "sub")!.dispatches).toBe(3); // 2 seeded + 1 probe
  });
});

async function runDaemonWith(repo: string, scriptPath: string, runId: string) {
  const { runDaemon } = await import("../../src/run/daemon.js");
  await runDaemon(repo, { adapters: [new TiedFake(scriptPath)], runId });
}
