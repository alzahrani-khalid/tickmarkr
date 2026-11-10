// Queue row 407; D-2187 add.35. runDaemon drops ARTIFICIAL_ANALYSIS_API_KEY from its own environment as its first
// statement, so no child of a run inherits the key from tickmarkr, payload shells included. Both entries are driven
// through their production commands — `run` and `resume`, each calling runDaemon in-process — with the fake adapter in a
// disposable repository. The run's test command records whether the variable is present, never its value. HOME is a
// temporary directory, so no host startup file can hand the key back to the payload's login shell.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ARTIFICIAL_ANALYSIS_KEY_NAME } from "../../src/adapters/catalog-remote.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { shq } from "../../src/adapters/types.js";
import { resume } from "../../src/cli/commands/resume.js";
import { run } from "../../src/cli/commands/run.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { gitHead, sh } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { authedModels, COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const KEY = ARTIFICIAL_ANALYSIS_KEY_NAME;
const SENTINEL = "tkr407-strip-sentinel-Qz8vX";

/** A disposable repository whose test gate is `testCmd`, with the fake adapter authed in its doctor cache. */
function repoWithTestGate(testCmd: string) {
  const { repo, scriptPath } = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    stringify({ gates: { test: testCmd } }),
  );
  writeDoctor(repo, { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } });
  return { repo, scriptPath };
}

describe("row 407: the run daemon drops the Artificial Analysis key at start", () => {
  test("a test command spawned by runDaemon on the run and the resume entry lacks a sentinel key that was set in the environment before the run started", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {}); // the run's narration rail
    vi.spyOn(process.stderr, "write").mockImplementation(() => true); // run's key warning (tests/cli/aa-key-warning.test.ts)
    vi.stubEnv("HOME", makeTestTempDir("aa-key-strip-home-"));
    vi.stubEnv(KEY, SENTINEL);
    const records = join(makeTestTempDir("aa-key-strip-records-"), "presence.txt");
    writeFileSync(records, "");
    const testCmd = `if [ -n "\${${KEY}+x}" ]; then echo present; else echo absent; fi >> ${shq(records)}`;
    const lines = () => readFileSync(records, "utf8").split("\n").filter(Boolean);

    // Control: the same command in a payload shell outside a run sees the variable, as at the base — so the recorder
    // can catch it, and a payload spawned outside a run still keeps it.
    await sh(testCmd, makeTestTempDir("aa-key-strip-control-"), 30_000);
    expect(lines()).toEqual(["present"]);

    // The run entry: `run` calls runDaemon, whose baseline capture, test gate and tip verify spawn the test command.
    const fresh = repoWithTestGate(testCmd);
    vi.stubEnv("TICKMARKR_FAKE_SCRIPT", fresh.scriptPath);
    expect(process.env[KEY]).toBe(SENTINEL);
    const ran = await run(["--driver", "subprocess"], fresh.repo);
    expect(ran.code, ran.out).toBe(0);
    const runLines = lines().slice(1);
    expect(runLines.length).toBeGreaterThan(0);
    expect(runLines.every((line) => line === "absent"), runLines.join(",")).toBe(true);
    // The daemon keeps no copy in its own environment.
    expect(process.env[KEY]).toBeUndefined();

    // The resume entry: a run interrupted inside its baseline capture (run-start journaled, no baseline.json), so the
    // resumed daemon recaptures with the test command, then runs T1's test gate and the tip verify.
    const resumed = repoWithTestGate(testCmd);
    vi.stubEnv("TICKMARKR_FAKE_SCRIPT", resumed.scriptPath);
    const runId = "run-20261109-000000-0000000000000407";
    Journal.create(resumed.repo, runId).append("run-start", undefined, {
      baseRef: await gitHead(resumed.repo), commands: { test: testCmd }, graphDefinitionHash: graphDefinitionHash(loadGraph(resumed.repo)),
    });
    vi.stubEnv(KEY, SENTINEL);
    expect(process.env[KEY]).toBe(SENTINEL);
    const before = lines().length;
    const back = await resume([runId, "--driver", "subprocess"], resumed.repo);
    expect(back.code, back.out).toBe(0);
    const resumeLines = lines().slice(before);
    expect(resumeLines.length).toBeGreaterThan(0);
    expect(resumeLines.every((line) => line === "absent"), resumeLines.join(",")).toBe(true);
    expect(process.env[KEY]).toBeUndefined();
  }, 180_000);
});
