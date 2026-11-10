// Queue row 407; D-2187 add.35. `tickmarkr run` writes exactly one stderr line, before it calls runDaemon, when
// ARTIFICIAL_ANALYSIS_API_KEY is in the environment with a non-empty value after trimming; it never carries the value,
// stdout is unchanged, and a key kept only in the Keychain prints nothing. Every cell drives the production `run` command
// to its end with the fake adapter in a disposable repository. The Keychain reader is injected, so neither the real
// Keychain nor the security command is touched, and vi.stubEnv restores every sentinel set in process.env.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { stringify } from "yaml";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ARTIFICIAL_ANALYSIS_KEY_NAME, lookupArtificialAnalysisKey } from "../../src/adapters/catalog-remote.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { run } from "../../src/cli/commands/run.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { sh } from "../../src/run/git.js";
import { authedModels, COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const KEY = ARTIFICIAL_ANALYSIS_KEY_NAME;
// No vendor-key shape, so journal redaction could not mask a leak and hide it from the check.
const SENTINEL = "tkr407-warning-sentinel-Wm3pK";
// The contract's row 407 line, verbatim.
const WARNING = 'warning: ARTIFICIAL_ANALYSIS_API_KEY is set in the environment, so every process started from it inherits the key and a process listing can show it; on macOS keep it in the Keychain only: security add-generic-password -a "$USER" -s ARTIFICIAL_ANALYSIS_API_KEY -w, then: launchctl unsetenv ARTIFICIAL_ANALYSIS_API_KEY';
// The run's test command shows what its payload shell inherited and fails when the key reached it.
const TEST_CMD = `printf 'seen:%s\\n' "\${${KEY}-}"; [ -z "\${${KEY}+x}" ]`;

/** Every stdout and stderr sink the run command reaches, kept apart: the console and the process streams. */
function streams() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sink = (into: string[]) => (...args: unknown[]) => { into.push(`${format(...args)}\n`); };
  for (const name of ["log", "info"] as const) vi.spyOn(console, name).mockImplementation(sink(stdout));
  for (const name of ["warn", "error"] as const) vi.spyOn(console, name).mockImplementation(sink(stderr));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
  const lines = (chunks: string[]) => chunks.join("").split("\n").filter(Boolean);
  return { stdout: () => lines(stdout), stderr: () => lines(stderr) };
}

/** `tickmarkr run` to its end in a disposable repository (fake adapter, subprocess driver), under a temporary HOME so no
 *  host startup file reaches the payload's login shell. Returns its streams, its result and its run folder. */
async function runToEnd() {
  vi.stubEnv("HOME", makeTestTempDir("aa-key-warning-home-"));
  const { repo, scriptPath } = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    stringify({ gates: { test: TEST_CMD } }),
  );
  writeDoctor(repo, { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } });
  vi.stubEnv("TICKMARKR_FAKE_SCRIPT", scriptPath);
  const io = streams();
  const result = await run(["--driver", "subprocess"], repo);
  vi.restoreAllMocks();
  const runs = join(tickmarkrDir(repo), "runs");
  const [runId] = readdirSync(runs);
  return { stdout: io.stdout(), stderr: io.stderr(), result, runDir: join(runs, runId) };
}

const mentionsKey = (lines: string[]) => lines.filter((line) => line.includes(KEY));

describe("row 407: run warns when the environment carries the Artificial Analysis key", () => {
  test("run writes one stderr warning naming process inheritance the Keychain recipe and launchctl unsetenv when the environment carries the key", async () => {
    // The environment carries the key: exactly one line on stderr, the contract's, and none on stdout.
    vi.stubEnv(KEY, SENTINEL);
    const carried = await runToEnd();
    expect(carried.result.code, carried.result.out).toBe(0);
    expect(mentionsKey(carried.stderr)).toEqual([WARNING]);
    expect(WARNING).toContain("every process started from it inherits the key");
    expect(WARNING).toContain('security add-generic-password -a "$USER" -s ARTIFICIAL_ANALYSIS_API_KEY -w');
    expect(WARNING).toContain("launchctl unsetenv ARTIFICIAL_ANALYSIS_API_KEY");
    expect(mentionsKey(carried.stdout)).toEqual([]);

    // Control: the environment unset, and a value that is empty after trimming — no warning.
    for (const value of [undefined, "  \t "]) {
      vi.stubEnv(KEY, value);
      const quiet = await runToEnd();
      expect(quiet.result.code, quiet.result.out).toBe(0);
      expect(mentionsKey([...quiet.stderr, ...quiet.stdout]), JSON.stringify(value)).toEqual([]);
    }

    // A key found only in the Keychain (an injected reader that returns the sentinel): it still serves the lookup, and
    // run prints no warning, because the environment does not carry it.
    vi.stubEnv(KEY, undefined);
    const keychainReader = vi.fn(() => ({ ok: true as const, key: SENTINEL }));
    expect(lookupArtificialAnalysisKey({ platform: "darwin", keychainReader })).toEqual({ ok: true, key: SENTINEL, source: "keychain" });
    expect(keychainReader).toHaveBeenCalledTimes(1);
    const keychainOnly = await runToEnd();
    expect(keychainOnly.result.code, keychainOnly.result.out).toBe(0);
    expect(mentionsKey([...keychainOnly.stderr, ...keychainOnly.stdout])).toEqual([]);
  }, 180_000);

  test("the sentinel value appears in no run stdout stderr or journal line", async () => {
    vi.stubEnv(KEY, SENTINEL);
    // Control: outside a run the payload command inherits the key and prints it, so a run that passed it down would put
    // the value in the test gate's red output.
    const leaked = await sh(TEST_CMD, makeTestTempDir("aa-key-warning-control-"), 30_000);
    expect([leaked.code === 0, leaked.stdout.includes(SENTINEL)]).toEqual([false, true]);

    const { stdout, stderr, result, runDir } = await runToEnd();
    expect(result.code, result.out).toBe(0);
    // The capture is live: it holds the warning and the run's narration.
    expect(mentionsKey(stderr)).toEqual([WARNING]);
    expect(stdout.length).toBeGreaterThan(0);
    const journal = readFileSync(join(runDir, "journal.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(journal.some((line) => line.includes('"run-start"'))).toBe(true);
    expect(journal.some((line) => line.includes('"run-end"'))).toBe(true);
    // Every file the run folder holds (journal, telemetry, baseline, gate output) is read, not just the journal.
    const files = (readdirSync(runDir, { recursive: true }) as string[])
      .map((rel) => join(runDir, rel))
      .filter((path) => existsSync(path) && statSync(path).isFile());
    const leaks = [
      ...stdout.map((line) => `stdout: ${line}`),
      ...stderr.map((line) => `stderr: ${line}`),
      `result: ${result.out}`,
      ...journal.map((line) => `journal: ${line}`),
      ...files.map((path) => `${path}: ${readFileSync(path, "utf8")}`),
    ].filter((text) => text.includes(SENTINEL));
    expect(leaks).toEqual([]);
  }, 120_000);
});
