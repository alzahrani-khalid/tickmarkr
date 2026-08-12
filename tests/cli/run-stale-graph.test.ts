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

  test("test: a run against an all-terminal graph prints the stale-graph warning, then the daemon refuses to start a no-op run", async () => {
    const { repo, scriptPath } = setupRepo(
      [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["done"] }],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "t1" } }] } },
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    // Mark the task done before the run: the graph carries a terminal status with no daemon alive,
    // so the CLI's advisory fires — and since NOTHING is dispatchable, the daemon now refuses to
    // start (GATE-FIX-4 defect 4) instead of journaling a zero-dispatch run-start/run-end that this
    // test used to accept as "finished". The warning seam stays isolated and fast: no run exists.
    saveGraph(repo, setStatus(loadGraph(repo), "T1", "done"));
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(run(["--driver", "subprocess"], repo)).rejects.toThrow(/nothing to dispatch/);
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
