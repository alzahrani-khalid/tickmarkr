import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { plan } from "../../src/cli/commands/plan.js";
import { resume } from "../../src/cli/commands/resume.js";
import { run } from "../../src/cli/commands/run.js";
import { graphDefinitionHash, loadGraph, saveGraph, setStatus, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, authedModels, makeRepo, setupRepo, T } from "../helpers/tmprepo.js";

const FAKE_ONLY_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

const SINGLE_VENDOR_DOCTOR = {
  "claude-code": { installed: true, authed: true, models: [], modelAuth: authedModels(["fable", "opus", "sonnet", "haiku"]) },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

describe("run/resume greenness exit contract", () => {
  afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; });

  test("all-green run summary exits 0 via dispatch", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const r = await run(["--concurrency", "1", "--driver", "subprocess"], repo);
    expect(r.out).toMatch(/finished/);
    expect(r.out).toMatch(/failed: 0/);
    expect(r.code).toBe(0);
  });

  test("run summary with a failed task exits 2", async () => {
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: {} });
    saveGraph(repo, setStatus(loadGraph(repo), "T1", "failed"));
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const r = await run(["--driver", "subprocess"], repo);
    expect(r.out).toMatch(/finished/);
    expect(r.out).toMatch(/failed: 1/);
    expect(r.code).toBe(2);
  });

  test("run summary with a non-green parked task exits 2", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "echo fail && exit 1", result: { ok: false, summary: "boom" } }] } },
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const r = await run(["--driver", "subprocess"], repo);
    expect(r.out).toMatch(/finished/);
    expect(r.out).toMatch(/human: 1/);
    expect(r.code).toBe(2);
  });

  test("resume applies the same greenness exit contract as run", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    saveGraph(repo, setStatus(loadGraph(repo), "T1", "failed"));
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    const j = Journal.create(repo, "run-red");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "T1");
    j.append("task-failed", "T1", { error: "boom" });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));

    const r = await resume(["run-red"], repo);
    expect(r.out).toMatch(/resumed run-red/);
    expect(r.out).toMatch(/failed: 1/);
    expect(r.code).toBe(2);
  });
});

describe("run --concurrency validation", () => {
  test("refuses zero, negative, and non-numeric values before dispatch", async () => {
    const repo = makeRepo({ "a.txt": "x" });
    for (const bad of [["--concurrency", "0"], ["--concurrency", "foo"], ["--concurrency=-5"]]) {
      await expect(run(bad, repo)).rejects.toThrow(/positive integer/);
      expect(existsSync(join(tickmarkrDir(repo), "runs"))).toBe(false);
    }
  });
});

describe("plan review fleet lint", () => {
  test("single-vendor fleet under review.required names the waiver", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
    }));
    writeDoctor(repo, SINGLE_VENDOR_DOCTOR);
    const out = await plan([], repo);
    expect(out).toContain("routing lints:");
    expect(out).toMatch(/review:.*cross-vendor reviewer pair/);
    expect(out).toContain("review.required: false");
  });
});
