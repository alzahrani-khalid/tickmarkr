import { chmodSync, existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { resume } from "../../src/cli/commands/resume.js";
import { run } from "../../src/cli/commands/run.js";
import { dispatch } from "../../src/cli/index.js";
import { graphDefinitionHash, loadGraph, saveGraph, setStatus, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const FAKE_ONLY_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

function setupRunnableRepo() {
  const { repo, scriptPath } = setupRepo(
    [T("T1", { files: ["result.txt"] })],
    { tasks: { T1: [{ shell: `echo result > result.txt && ${COMMIT} result`, result: { ok: true, summary: "result" } }] } },
  );
  writeDoctor(repo, FAKE_ONLY_DOCTOR);
  return { repo, scriptPath };
}

async function setupRecordedRun(repo: string, runId = "run-recorded") {
  saveGraph(repo, setStatus(loadGraph(repo), "T1", "failed"));
  const j = Journal.create(repo, runId);
  const baseRef = await gitHead(repo);
  j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  j.append("task-dispatch", "T1");
  j.append("task-failed", "T1", { error: "boom" });
  writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  return { runId, journal: j };
}

describe("RP-1 refs preflight (OBS-983/984)", () => {
  afterEach(() => {
    delete process.env.TICKMARKR_FAKE_SCRIPT;
  });

  test("test: tickmarkr run in a repository whose refs directory refuses writes exits non-zero naming that directory and the remedy and leaves no run journal, tickmarkr resume of a recorded run refuses the same way and appends no run-resume row, and both proceed once the directory accepts writes, so a refusal journaled after run-start fails", async () => {
    // ── Part 1: tickmarkr run with read-only refs directory ──
    const { repo, scriptPath } = setupRunnableRepo();
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const refsDir = join(repo, ".git", "refs");
    const canonicalRefsDir = realpathSync(refsDir);
    const runsDir = join(tickmarkrDir(repo), "runs");

    // Make refs directory refuse writes
    chmodSync(refsDir, 0o555);

    try {
      // Direct invocation rejects naming refs directory and remedy
      await expect(run(["--driver", "subprocess"], repo)).rejects.toThrow(
        /refusing to run: repository refs directory/,
      );

      // CLI dispatch exits non-zero naming that directory and remedy
      const priorCwd = process.cwd();
      process.chdir(repo);
      try {
        const runRes = await dispatch("run", ["--driver", "subprocess"]);
        expect(runRes.code).not.toBe(0);
        expect(runRes.out.includes(refsDir) || runRes.out.includes(canonicalRefsDir)).toBe(true);
        expect(runRes.out).toContain("run from the main repository or a full clone; a sandbox that denies writes under that path cannot host a run");
      } finally {
        process.chdir(priorCwd);
      }

      // Leaves no run journal
      const runEntries = existsSync(runsDir) ? readdirSync(runsDir) : [];
      expect(runEntries).toEqual([]);

      // ── Part 2: tickmarkr resume of a recorded run with read-only refs directory ──
      // Temporarily restore write permissions to record a prior run
      chmodSync(refsDir, 0o755);
      const runId = "run-preflight-test";
      const { journal } = await setupRecordedRun(repo, runId);
      const rowsBeforeResume = journal.read().length;

      // Make refs directory refuse writes again
      chmodSync(refsDir, 0o555);

      // Direct resume rejects naming directory and remedy
      await expect(resume([runId, "--driver", "subprocess"], repo)).rejects.toThrow(
        /refusing to resume: repository refs directory/,
      );

      // CLI dispatch resume exits non-zero naming that directory and remedy
      process.chdir(repo);
      try {
        const resumeRes = await dispatch("resume", [runId, "--driver", "subprocess"]);
        expect(resumeRes.code).not.toBe(0);
        expect(resumeRes.out.includes(refsDir) || resumeRes.out.includes(canonicalRefsDir)).toBe(true);
        expect(resumeRes.out).toContain("run from the main repository or a full clone; a sandbox that denies writes under that path cannot host a run");
      } finally {
        process.chdir(priorCwd);
      }

      // Appends no run-resume row
      const rowsAfterRefusal = Journal.open(repo, runId).read();
      expect(rowsAfterRefusal.length).toBe(rowsBeforeResume);
      expect(rowsAfterRefusal.some((e) => e.event === "run-resume")).toBe(false);

      // ── Part 3: Both proceed once the directory accepts writes ──
      chmodSync(refsDir, 0o755);

      // Resume proceeds and appends run-resume
      const resumeProceed = await resume([runId, "--driver", "subprocess"], repo);
      expect(resumeProceed.code).toBe(2); // failed task gives code 2
      const rowsAfterProceed = Journal.open(repo, runId).read();
      expect(rowsAfterProceed.some((e) => e.event === "run-resume")).toBe(true);

      // Fresh run proceeds and creates a run journal
      saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", { files: ["result.txt"] })] }));
      const runProceed = await run(["--driver", "subprocess"], repo);
      expect(runProceed.code).toBe(0);
      const runDirsAfter = existsSync(runsDir) ? readdirSync(runsDir) : [];
      expect(runDirsAfter.length).toBeGreaterThan(1);
    } finally {
      chmodSync(refsDir, 0o755);
    }
  }, 120_000);
});
