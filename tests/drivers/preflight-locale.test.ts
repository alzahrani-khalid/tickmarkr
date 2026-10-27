import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { resume } from "../../src/cli/commands/resume.js";
import { run } from "../../src/cli/commands/run.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import * as drivers from "../../src/drivers/index.js";
import { localeFinding } from "../../src/drivers/host-env.js";
import { loadGraph } from "../../src/graph/graph.js";
import * as daemon from "../../src/run/daemon.js";
import { shOk } from "../../src/run/git.js";
import * as journal from "../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const LOCALE_KEYS = ["LC_ALL", "LC_CTYPE", "LANG"] as const;
const FIX = " — gates inherit the C-locale fallback (Node formats as en-US); fix: set LANG in your shell profile, e.g. export LANG=en_US.UTF-8";
const warning = (detail: string) => `tickmarkr: warning: locale — ${detail}`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("test: run and resume each print the locale warning through their shared preflight when the effective locale is unset, C or POSIX, in the words doctor prints, and print nothing for a UTF-8 locale or an empty locale override beside a UTF-8 language setting, so a run starting silent under the C locale fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no catalog fetch in test"); }));
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
  for (const key of ["HERDR_ENV", "TERM_PROGRAM", "ORCA_TERMINAL_HANDLE", "HOME"]) vi.stubEnv(key, undefined);
  vi.stubEnv("NO_COLOR", "1");
  const { repo, fake } = setupRepo([T("T1")], { tasks: {} });
  vi.spyOn(journal, "newRunId").mockReturnValue("run-locale");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const preflight = vi.spyOn(drivers, "preflightHostDriver"); // pass through the real shared preflight
  const dispatch = vi.spyOn(daemon, "runDaemon").mockResolvedValue({
    runId: "run-locale", branch: "tickmarkr/run-locale", done: [], failed: ["T1"], human: [], blocked: [], pending: [],
  });
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const cases: [NodeJS.ProcessEnv, string | undefined][] = [
    [{}, "no locale set (LC_ALL, LC_CTYPE and LANG unset)"],
    [{ LC_ALL: "", LC_CTYPE: "", LANG: "" }, "no locale set (LC_ALL, LC_CTYPE and LANG unset)"],
    [{ LANG: "C" }, "LANG=C"],
    [{ LANG: "POSIX" }, "LANG=POSIX"],
    [{ LC_ALL: "C", LANG: "en_US.UTF-8" }, "LC_ALL=C"],
    [{ LC_ALL: "POSIX", LC_CTYPE: "en_US.UTF-8", LANG: "en_US.UTF-8" }, "LC_ALL=POSIX"],
    [{ LC_CTYPE: "POSIX", LANG: "en_US.UTF-8" }, "LC_CTYPE=POSIX"],
    [{ LC_ALL: "", LC_CTYPE: "C", LANG: "en_US.UTF-8" }, "LC_CTYPE=C"],
    [{ LANG: "en_US.UTF-8" }, undefined],
    [{ LANG: "ar_SA.UTF-8" }, undefined],
    [{ LANG: "C.UTF-8" }, undefined],
    [{ LC_CTYPE: "en_US.UTF-8", LANG: "C" }, undefined],
    [{ LC_ALL: "C.UTF-8", LC_CTYPE: "C", LANG: "POSIX" }, undefined],
    [{ LC_ALL: "", LANG: "en_US.UTF-8" }, undefined],
    [{ LC_ALL: "", LC_CTYPE: "", LANG: "en_US.UTF-8" }, undefined],
  ];
  for (const [env, effective] of cases) {
    const expected = effective === undefined ? [] : [[warning(effective + FIX)]];
    // The supplied snapshot wins over the opposite ambient locale, and neither is changed.
    for (const key of LOCALE_KEYS) vi.stubEnv(key, key === "LANG" ? (effective ? "en_US.UTF-8" : "C") : undefined);
    const supplied = Object.freeze({ ...env });
    warnings.mockClear();
    stderr.mockClear();
    await drivers.preflightHostDriver(DEFAULT_CONFIG, "subprocess", "none", repo, supplied);
    expect(warnings.mock.calls, JSON.stringify(env)).toEqual(expected);
    expect(stderr).not.toHaveBeenCalled();
    expect(supplied).toEqual(env);
    expect(process.env.LANG).toBe(effective ? "en_US.UTF-8" : "C");

    for (const key of LOCALE_KEYS) vi.stubEnv(key, env[key]);
    const doctorOutput = await doctor(["--"], repo, [fake], { banner: false, resolveOrcaBinary: () => undefined });
    const rows = doctorOutput.split("\n").filter(line => /^  [✓!] locale\s/u.test(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(localeFinding(env).detail);
    expect(rows[0]).toMatch(effective === undefined ? /^  ✓ locale\s/u : /^  ! locale\s/u);
    if (effective !== undefined) expect(rows[0]).toContain(effective + FIX);

    for (const command of ["run", "resume"] as const) {
      warnings.mockClear();
      stderr.mockClear();
      preflight.mockClear();
      dispatch.mockClear();
      const result = command === "run"
        ? await run(["--driver", "subprocess"], repo)
        : await resume(["run-locale", "--driver", "subprocess"], repo);
      expect(result.code).toBe(2); // the daemon's result is returned: the warning never refuses admission
      expect(preflight, command).toHaveBeenCalledTimes(1);
      expect(dispatch, command).toHaveBeenCalledTimes(1);
      expect(warnings.mock.calls, `${command}: ${JSON.stringify(env)}`).toEqual(expected);
      expect(stderr).not.toHaveBeenCalled();
      for (const key of LOCALE_KEYS) expect(process.env[key], key).toBe(env[key]);
    }
  }
}, 60_000);

test("test: a run started through the production run command under the C locale prints the locale warning exactly once and still dispatches and merges its task, so a warning that refuses the run or repeats per task fails", async () => {
  // Two tasks distinguish one startup warning from a warning repeated for every dispatch.
  const { repo, scriptPath } = setupRepo(
    [T("T1", { files: ["one.txt"] }), T("T2", { files: ["two.txt"], deps: ["T1"] })],
    { tasks: {
      T1: [{ shell: `echo one > one.txt && ${COMMIT} one`, result: { ok: true, summary: "one" } }],
      T2: [{ shell: `test -f one.txt && echo two > two.txt && ${COMMIT} two`, result: { ok: true, summary: "two" } }],
    } },
  );
  registry.writeDoctor(repo, {
    ...Object.fromEntries(registry.allAdapters().map(adapter => [adapter.id, { installed: false, authed: false, models: [] }])),
    fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  });
  const child = spawnSync(process.execPath, [
    "--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
    fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url)),
    "run", "--driver", "subprocess", "--concurrency", "1",
  ], {
    cwd: repo, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
    env: { ...process.env, LC_ALL: "C", LC_CTYPE: "en_US.UTF-8", LANG: "en_US.UTF-8",
      TICKMARKR_FAKE_SCRIPT: scriptPath, HERDR_ENV: undefined, TERM_PROGRAM: undefined,
      ORCA_TERMINAL_HANDLE: undefined, NO_COLOR: "1" },
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stdout + child.stderr).toBe(0);
  expect(child.stderr).toBe(warning("LC_ALL=C" + FIX) + "\n");
  expect(child.stdout).not.toContain("tickmarkr: warning: locale");
  const runId = child.stdout.match(/run (run-\S+) finished/u)?.[1];
  expect(runId).toBeDefined();
  const events = journal.Journal.open(repo, runId!).read();
  expect(events.filter(event => event.event === "task-dispatch").map(event => event.taskId)).toEqual(["T1", "T2"]);
  expect(events.filter(event => event.event === "merge").map(event => event.taskId)).toEqual(["T1", "T2"]);
  expect(loadGraph(repo).tasks.map(task => task.status)).toEqual(["done", "done"]);
  for (const [file, content] of [["one.txt", "one\n"], ["two.txt", "two\n"]]) {
    expect(await shOk(`git show tickmarkr/${runId}:${file}`, repo)).toBe(content);
  }
  expect(await shOk("git log --format=%s main", repo)).toBe("init\n");
}, 90_000);
