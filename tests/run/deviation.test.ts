import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { BillingChannel } from "../../src/adapters/types.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, authedModels, setupRepo, T } from "../helpers/tmprepo.js";

// FakeAdapter's stock channels differ on marginalCostRank (sub vs api) — the score key is never reached.
// Override to TWO same-tier sub channels: a static tie resolved by discovery order (fake-1 first).
class TiedFake extends FakeAdapter {
  channels(): BillingChannel[] {
    return [
      { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
      { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "sub", tier: "frontier" },
    ];
  }
}

// ≥5 clean v1.6 rows warming fake:fake-2 for shape "implement"
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

describe("VIS-02 route-deviation journal event (fake adapter, zero tokens)", () => {
  test("deviation run: exactly one route-deviation event, dispatch is fake-2", async () => {
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: winScript }, "routing: { learned: on }\n");
    seedWarm(repo);
    await runDaemonWith(repo, scriptPath, "run-dev");
    const evs = deviations(repo, "run-dev");
    expect(evs).toHaveLength(1);
    expect(evs[0].data).toMatchObject({ static: "fake:fake-1", chosen: "fake:fake-2" });
    expect(evs[0].data.provenance).toMatch(/via learned score/);
    expect(dispatchAssign(repo, "run-dev").model).toBe("fake-2");
  });

  test("control run: no telemetry ⇒ zero route-deviation events, dispatch is fake-1", async () => {
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: winScript }, "routing: { learned: on }\n");
    await runDaemonWith(repo, scriptPath, "run-ctl");
    expect(deviations(repo, "run-ctl")).toHaveLength(0);
    expect(dispatchAssign(repo, "run-ctl").model).toBe("fake-1");
  });

  test("daemon-off run: warm telemetry is inert under explicit learned:off, dispatch is fake-1", async () => {
    // ROUTE-14 flipped the DEFAULT to on (2026-07-11), so off-inertness is now pinned via an explicit overlay.
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: winScript }, "routing: { learned: off }\n");
    seedWarm(repo);
    await runDaemonWith(repo, scriptPath, "run-off");
    expect(deviations(repo, "run-off")).toHaveLength(0);
    expect(dispatchAssign(repo, "run-off").model).toBe("fake-1");
  });

  test("resume-compat: the new event is inert to replayStatuses (old runs still read)", async () => {
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: winScript }, "routing: { learned: on }\n");
    seedWarm(repo);
    await runDaemonWith(repo, scriptPath, "run-res");
    const statuses = Journal.open(repo, "run-res").replayStatuses();
    expect(statuses.get("T1")).toBe("done");
  });
});

async function runDaemonWith(repo: string, scriptPath: string, runId: string) {
  const { runDaemon } = await import("../../src/run/daemon.js");
  await runDaemon(repo, { adapters: [new TiedFake(scriptPath)], runId });
}

// ── ROUTE-13: failover-deviation audit event (the daemon owns the journal write; nextChannel stays pure) ──

// THREE same-tier sub channels: a static failover tie resolved by discovery order (fake-1 first). The task
// pins fake-3, so route() dispatches there regardless of profile; the LEARNED tiebreak only shows up on the
// mid-task quota failover, where fake-2 (warmed) must beat the discovery-first fake-1.
class ThreeTiedFake extends FakeAdapter {
  async probe() {
    return { ...(await super.probe()), models: ["fake-1", "fake-2", "fake-3"], modelAuth: authedModels(["fake-1", "fake-2", "fake-3"]) };
  }

  channels(): BillingChannel[] {
    return [
      { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
      { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "sub", tier: "frontier" },
      { adapter: "fake", vendor: "fake-c", model: "fake-3", channel: "sub", tier: "frontier" },
    ];
  }
}

// T1 pinned to fake-3; step 0 quota-fails (no trailer + quota text + exit 1) ⇒ mid-task failover, step 1 wins.
const failoverScript = {
  T1: [
    { shell: "echo 'usage limit reached for this model'; exit 1" },
    { shell: `echo x > f.txt && ${COMMIT} f`, result: { ok: true, summary: "ok" } },
  ],
};
const PIN3 = { routingHints: { pin: { via: "fake", model: "fake-3" } } };
const failoverDevs = (repo: string, runId: string) =>
  Journal.open(repo, runId).read().filter((e) => e.event === "failover-deviation");
const dispatchModels = (repo: string, runId: string) =>
  Journal.open(repo, runId).read().filter((e) => e.event === "task-dispatch")
    .map((e) => (e.data.assignment as { model: string }).model);

async function runThreeTied(repo: string, scriptPath: string, runId: string) {
  const { runDaemon } = await import("../../src/run/daemon.js");
  await runDaemon(repo, { adapters: [new ThreeTiedFake(scriptPath)], runId });
}

describe("ROUTE-13 failover-deviation journal event (fake adapter, zero tokens)", () => {
  test("learned failover flips fake-1→fake-2: exactly one failover-deviation, post-failover dispatch is fake-2", async () => {
    const { repo, scriptPath } = setupRepo([T("T1", PIN3)], { tasks: failoverScript }, "routing: { learned: on }\n");
    seedWarm(repo); // warms fake-2 for shape "implement"
    await runThreeTied(repo, scriptPath, "run-fdev");
    const evs = failoverDevs(repo, "run-fdev");
    expect(evs).toHaveLength(1);
    // static pick = discovery order among the tied cold candidates (fake-1); learned pick = warmed fake-2
    expect(evs[0].data).toMatchObject({ site: "quota-failover", static: "fake:fake-1", chosen: "fake:fake-2" });
    const models = dispatchModels(repo, "run-fdev");
    expect(models[0]).toBe("fake-3");                 // pinned first dispatch
    expect(models[models.length - 1]).toBe("fake-2"); // post-failover dispatch
  });

  test("control — no seeded telemetry ⇒ zero failover-deviation events, failover lands on fake-1", async () => {
    const { repo, scriptPath } = setupRepo([T("T1", PIN3)], { tasks: failoverScript }, "routing: { learned: on }\n");
    await runThreeTied(repo, scriptPath, "run-fctl");
    expect(failoverDevs(repo, "run-fctl")).toHaveLength(0);
    expect(dispatchModels(repo, "run-fctl").at(-1)).toBe("fake-1");
  });
});
