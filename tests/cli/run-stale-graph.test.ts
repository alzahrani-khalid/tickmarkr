import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { compile } from "../../src/cli/commands/compile.js";
import { run } from "../../src/cli/commands/run.js";
import { sha256 } from "../../src/compile/common.js";
import { compileRefusalPath, graphPath, loadGraph, saveGraph, setStatus } from "../../src/graph/graph.js";
import { setupRepo, authedModels, COMMIT, T } from "../helpers/tmprepo.js";

const FAKE_ONLY_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

const VALID_NATIVE = `<!-- tickmarkr:spec -->
## T1: Produce result
- goal: Produce one observable result.
- shape: implement
- complexity: 2
- files: result.txt
- acceptance:
  - judge: result.txt is produced
`;

const INVALID_NATIVE = `<!-- tickmarkr:spec -->
## T1: Produce result
- goal: Produce one observable result.
- shape: implement
- complexity: 2
- files: result.txt
`;

const VALID_PRD = `# Result plan

## T1: Produce result
- goal: Produce one observable result.
- shape: implement
- complexity: 2
- files: result.txt
- acceptance:
  - result.txt is produced
`;

const VALID_SPECKIT = `# Tasks

- [ ] T1 Produce result
  - goal: Produce one observable result.
  - shape: implement
  - complexity: 2
  - files: result.txt
  - acceptance: result.txt is produced
`;

function runnableRepo() {
  return setupRepo(
    [T("T1", { files: ["result.txt"] })],
    { tasks: { T1: [{ shell: `echo result > result.txt && ${COMMIT} result`, result: { ok: true, summary: "result" } }] } },
  );
}

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

  test("test: a compile refused by an authoring error leaves a refusal record beside the prior graph and run then refuses naming that error and the recompile remedy while a later successful compile clears the record and run proceeds and a dry-run refusal writes nothing whereas a run that executes the prior graph after a refusal fails", async () => {
    const fixture = runnableRepo();
    const spec = join(fixture.repo, "feature.spec.md");
    writeFileSync(spec, VALID_NATIVE);
    await compile(["feature.spec.md"], fixture.repo);
    const priorGraph = readFileSync(graphPath(fixture.repo));

    writeFileSync(spec, INVALID_NATIVE);
    await expect(compile(["feature.spec.md"], fixture.repo)).rejects.toThrow(/acceptance criteria are required/);
    expect(readFileSync(graphPath(fixture.repo)).equals(priorGraph)).toBe(true);
    const refusal = JSON.parse(readFileSync(compileRefusalPath(fixture.repo), "utf8"));
    expect(refusal.error).toContain("acceptance criteria are required");
    expect(refusal.source).toBe(spec);

    await expect(run(["--driver", "subprocess"], fixture.repo))
      .rejects.toThrow(/last compile[\s\S]*acceptance criteria are required[\s\S]*Recompile successfully/);
    expect(existsSync(join(fixture.repo, "result.txt"))).toBe(false);

    const dry = runnableRepo();
    const drySpec = join(dry.repo, "feature.spec.md");
    writeFileSync(drySpec, VALID_NATIVE);
    await compile(["feature.spec.md"], dry.repo);
    const dryGraph = readFileSync(graphPath(dry.repo));
    writeFileSync(drySpec, INVALID_NATIVE);
    await expect(compile(["feature.spec.md", "--dry-run"], dry.repo)).rejects.toThrow(/acceptance criteria are required/);
    expect(readFileSync(graphPath(dry.repo)).equals(dryGraph)).toBe(true);
    expect(existsSync(compileRefusalPath(dry.repo))).toBe(false);

    writeFileSync(spec, VALID_NATIVE);
    await compile(["feature.spec.md"], fixture.repo);
    expect(existsSync(compileRefusalPath(fixture.repo))).toBe(false);
    writeDoctor(fixture.repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = fixture.scriptPath;
    await expect(run(["--driver", "subprocess"], fixture.repo)).resolves.toMatchObject({ code: 0 });
  }, 120_000);

  test("test: run refuses a graph whose recorded spec hash differs from the spec file's content on disk naming both hashes while the unchanged spec runs whereas a run that trusts the graph over the file fails", async () => {
    const unchanged = runnableRepo();
    writeFileSync(join(unchanged.repo, "feature.prd.md"), VALID_PRD);
    await compile(["feature.prd.md"], unchanged.repo);
    writeDoctor(unchanged.repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = unchanged.scriptPath;
    await expect(run(["--driver", "subprocess"], unchanged.repo)).resolves.toMatchObject({ code: 0 });

    const dialects = [
      { source: "native", argument: "feature.spec.md", path: "feature.spec.md", content: VALID_NATIVE },
      { source: "prd", argument: "feature.prd.md", path: "feature.prd.md", content: VALID_PRD },
      { source: "speckit", argument: "feature", path: "feature/tasks.md", content: VALID_SPECKIT },
    ] as const;
    for (const dialect of dialects) {
      const changed = runnableRepo();
      const spec = join(changed.repo, dialect.path);
      mkdirSync(dirname(spec), { recursive: true });
      writeFileSync(spec, dialect.content);
      await compile([dialect.argument], changed.repo);
      const graph = loadGraph(changed.repo);
      expect(graph.spec.source).toBe(dialect.source);
      const recorded = graph.spec.hash;
      const edited = `${dialect.content}\n# changed after compile\n`;
      writeFileSync(spec, edited);
      const actual = sha256(edited);
      expect(actual).not.toBe(recorded);

      await expect(run(["--driver", "subprocess"], changed.repo))
        .rejects.toThrow(new RegExp(`${actual}[\\s\\S]*${recorded}`));
      expect(existsSync(join(changed.repo, ".tickmarkr", "runs"))).toBe(false);
    }
  }, 120_000);
});
