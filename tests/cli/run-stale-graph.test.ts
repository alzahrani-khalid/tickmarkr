import { afterEach, describe, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { run } from "../../src/cli/commands/run.js";
import { loadGraph, saveGraph, setStatus } from "../../src/graph/graph.js";
import { setupRepo, authedModels } from "../helpers/tmprepo.js";

const FAKE_ONLY_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

describe("stale-graph run warning", () => {
  afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; });

  test("test: a run against a graph with terminal statuses and no active daemon prints the stale-graph warning naming the recompile remedy", async () => {
    const { repo, scriptPath } = setupRepo(
      [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["done"] }],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "t1" } }] } },
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    // Mark the task done before the run so the daemon finishes immediately while the graph still
    // carries a terminal status — this keeps the test fast and isolated from the warning seam.
    saveGraph(repo, setStatus(loadGraph(repo), "T1", "done"));
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await run(["--driver", "subprocess"], repo);
      expect(r.out).toMatch(/finished/);
      expect(r.code).toBe(0);
      expect(loadGraph(repo).tasks[0].status).toBe("done");
      const staleWarning = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("stale graph"),
      );
      expect(staleWarning).toBeDefined();
      expect(String(staleWarning![0])).toMatch(/tickmarkr compile/);
      expect(String(staleWarning![0])).toMatch(/recompile/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("test: a run against a freshly compiled graph prints no stale-graph warning", async () => {
    const { repo, scriptPath } = setupRepo(
      [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["done"] }],
      { tasks: {} },
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await run(["--driver", "subprocess"], repo);
      const staleWarning = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("stale graph"),
      );
      expect(staleWarning).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
