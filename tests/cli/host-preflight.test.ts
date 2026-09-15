import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { dispatch } from "../../src/cli/index.js";
import { graphDefinitionHash, loadGraph, saveGraph, setStatus, tickmarkrDir } from "../../src/graph/graph.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import * as DriversModule from "../../src/drivers/index.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { authedModels, COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const FAKE_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

/** Production pickDriver identity; methods delegated to SubprocessDriver so journal rows are daemon-authored. */
function hollowOut(real: ExecutorDriver, dispatched: string[]): ExecutorDriver {
  const sub = new SubprocessDriver();
  const shell = real as unknown as Record<string, unknown>;
  for (let proto = Object.getPrototypeOf(real); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) if (key !== "constructor") shell[key] = undefined;
  }
  for (const key of Object.getOwnPropertyNames(SubprocessDriver.prototype)) {
    const fn = (sub as unknown as Record<string, unknown>)[key];
    if (key === "constructor" || typeof fn !== "function") continue;
    shell[key] = (...a: unknown[]) => {
      if (key === "slot") dispatched.push(real.id);
      return (fn as (...x: unknown[]) => unknown).apply(sub, a);
    };
  }
  return real;
}

function setupTestRepo(cfgDriver?: string) {
  const { repo, scriptPath } = setupRepo(
    [T("T1", { files: ["result.txt"] })],
    { tasks: { T1: [{ shell: `echo ok > result.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    cfgDriver ? `driver: ${cfgDriver}\n` : "",
  );
  writeDoctor(repo, FAKE_DOCTOR);
  return { repo, scriptPath };
}

async function createRecordedRun(repo: string, runId = "run-recorded-1", recordedDriver = "herdr") {
  saveGraph(repo, setStatus(loadGraph(repo), "T1", "failed"));
  const j = Journal.create(repo, runId);
  const baseRef = await gitHead(repo);
  j.append("run-start", undefined, {
    baseRef,
    commands: {},
    driver: recordedDriver,
    graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
  });
  j.append("task-dispatch", "T1");
  j.append("task-failed", "T1", { error: "boom" });
  writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  return { runId, journal: j };
}

async function runCli(argv: string[], repo: string) {
  const prior = resolve(".");
  try {
    process.chdir(repo);
    return await dispatch("run", argv);
  } finally {
    process.chdir(prior);
  }
}

async function resumeCli(argv: string[], repo: string) {
  const prior = resolve(".");
  try {
    process.chdir(repo);
    return await dispatch("resume", argv);
  } finally {
    process.chdir(prior);
  }
}

describe("HD-1 host-driver truth (OBS-1003 / RULING-232-01 add.3)", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HERDR_ENV;
    delete process.env.TERM_PROGRAM;
    delete process.env.ORCA_TERMINAL_HANDLE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    delete process.env.TICKMARKR_FAKE_SCRIPT;
  });

  test("test: tickmarkr run over a repository whose config says driver herdr exits non-zero before any run directory or journal exists naming the detected host, the config line and the --driver remedy when the herdr host variable is unset, empty or any value other than 1, and driver orca is refused the same way when either Orca marker is absent, while driver herdr proceeds to a run-start row naming driver herdr under the herdr variable 1 even beside both Orca markers, driver orca proceeds to a run-start row naming driver orca under the full Orca pair alone, driver auto and driver subprocess proceed under every host combination with the run-start row naming the driver the selection chain picks, each of the four explicit --driver values bypasses this check under every host, and tickmarkr resume of a recorded run refuses under the same rule leaving the existing journal byte-identical, proceeds to a run-resume row when the host matches, and resumed under config auto on the other host dispatches on that host's driver rather than the driver the recorded run-start row names, so a truthy host read, a refused explicit --driver, a journaled driver taken as an override, or a mismatch that reaches run-start fails", async () => {
    // Real pickDriver (host from refs-preflight); only the returned object is hollowed.
    let picked: ExecutorDriver | null = null;
    const dispatched: string[] = [];
    const realPick = DriversModule.pickDriver;
    vi.spyOn(DriversModule, "pickDriver").mockImplementation((cfg, override, host) => {
      picked = hollowOut(realPick(cfg, override, host), dispatched);
      return picked;
    });
    const useRepo = (r: { repo: string; scriptPath: string }) => {
      process.env.TICKMARKR_FAKE_SCRIPT = r.scriptPath;
      picked = null;
      dispatched.length = 0;
      return r;
    };
    const startRow = (repo: string) => {
      const runs = readdirSync(runsDirOf(repo));
      expect(runs).toHaveLength(1);
      return Journal.open(repo, runs[0]!).read().find((e) => e.event === "run-start");
    };

    const runsDirOf = (repo: string) => join(tickmarkrDir(repo), "runs");

    // 1. herdr refused when HERDR_ENV is not 1
    const herdrValues = [undefined, "", "true", "yes", "0", "2"];
    for (const val of herdrValues) {
      const { repo } = useRepo(setupTestRepo("herdr"));
      if (val === undefined) {
        delete process.env.HERDR_ENV;
      } else {
        process.env.HERDR_ENV = val;
      }

      const res = await runCli([], repo);
      expect(res.code).not.toBe(0);
      expect(existsSync(runsDirOf(repo))).toBe(false);
      expect(res.out).toContain("detected host is none");
      expect(res.out).toContain("driver: herdr");
      expect(res.out).toContain("--driver subprocess");
      expect(picked).toBeNull();
    }

    // herdr refused on an Orca host with --driver orca remedy
    {
      const { repo } = useRepo(setupTestRepo("herdr"));
      process.env.TERM_PROGRAM = "Orca";
      process.env.ORCA_TERMINAL_HANDLE = "term_1";
      delete process.env.HERDR_ENV;

      const res = await runCli([], repo);
      expect(res.code).not.toBe(0);
      expect(existsSync(runsDirOf(repo))).toBe(false);
      expect(res.out).toContain("detected host is orca");
      expect(res.out).toContain("driver: herdr");
      expect(res.out).toContain("--driver orca");
    }

    // 2. orca refused when either marker is absent
    const orcaMarkerPairs = [
      { TERM_PROGRAM: undefined, ORCA_TERMINAL_HANDLE: undefined },
      { TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: undefined },
      { TERM_PROGRAM: undefined, ORCA_TERMINAL_HANDLE: "term_1" },
    ];
    for (const pair of orcaMarkerPairs) {
      const { repo } = useRepo(setupTestRepo("orca"));
      if (pair.TERM_PROGRAM) process.env.TERM_PROGRAM = pair.TERM_PROGRAM; else delete process.env.TERM_PROGRAM;
      if (pair.ORCA_TERMINAL_HANDLE) process.env.ORCA_TERMINAL_HANDLE = pair.ORCA_TERMINAL_HANDLE; else delete process.env.ORCA_TERMINAL_HANDLE;

      const res = await runCli([], repo);
      expect(res.code).not.toBe(0);
      expect(existsSync(runsDirOf(repo))).toBe(false);
      expect(res.out).toContain("detected host is none");
      expect(res.out).toContain("driver: orca");
      expect(res.out).toContain("--driver subprocess");
      expect(picked).toBeNull();
    }

    // orca refused on herdr with --driver herdr remedy
    {
      const { repo } = useRepo(setupTestRepo("orca"));
      process.env.HERDR_ENV = "1";
      delete process.env.TERM_PROGRAM;
      delete process.env.ORCA_TERMINAL_HANDLE;

      const res = await runCli([], repo);
      expect(res.code).not.toBe(0);
      expect(existsSync(runsDirOf(repo))).toBe(false);
      expect(res.out).toContain("detected host is herdr");
      expect(res.out).toContain("driver: orca");
      expect(res.out).toContain("--driver herdr");
      expect(picked).toBeNull();
    }

    // 3. herdr proceeds under HERDR_ENV=1 even beside Orca markers
    {
      const { repo } = useRepo(setupTestRepo("herdr"));
      process.env.HERDR_ENV = "1";
      process.env.TERM_PROGRAM = "Orca";
      process.env.ORCA_TERMINAL_HANDLE = "term_nested";

      const res = await runCli([], repo);
      expect(res.code).toBe(0);
      expect(picked!.id).toBe("herdr");
      const start = startRow(repo);
      expect(start?.data?.driver).toBe("herdr");
      expect(start?.data?.driverEvidence).toBe("herdr (config)");
      expect(dispatched).toEqual(["herdr"]);
    }

    // 4. orca proceeds under the full Orca pair alone
    {
      const { repo } = useRepo(setupTestRepo("orca"));
      delete process.env.HERDR_ENV;
      process.env.TERM_PROGRAM = "Orca";
      process.env.ORCA_TERMINAL_HANDLE = "term_standalone";

      const res = await runCli([], repo);
      expect(res.code).toBe(0);
      expect(picked!.id).toBe("orca");
      const start = startRow(repo);
      expect(start?.data?.driver).toBe("orca");
      expect(start?.data?.driverEvidence).toBe("orca (config)");
      expect(dispatched).toEqual(["orca"]);
    }

    // 5. auto and subprocess proceed under every host; run-start names the selected driver
    const hostCombos = [
      { name: "herdr", env: { HERDR_ENV: "1" }, autoPicks: "herdr", evidence: "auto → herdr (HERDR_ENV=1)" },
      { name: "herdr-and-orca", env: { HERDR_ENV: "1", TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: "t1" }, autoPicks: "herdr", evidence: "auto → herdr (HERDR_ENV=1)" },
      { name: "orca", env: { TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: "t1" }, autoPicks: "orca", evidence: "auto → orca (TERM_PROGRAM+ORCA_TERMINAL_HANDLE)" },
      { name: "none", env: {}, autoPicks: "subprocess", evidence: "auto → subprocess (HERDR_ENV unset)" },
    ];

    for (const combo of hostCombos) {
      delete process.env.HERDR_ENV;
      delete process.env.TERM_PROGRAM;
      delete process.env.ORCA_TERMINAL_HANDLE;
      Object.assign(process.env, combo.env);

      // config auto
      {
        const { repo } = useRepo(setupTestRepo("auto"));
          const res = await runCli([], repo);
        expect(res.code).toBe(0);
        expect(picked!.id).toBe(combo.autoPicks);
        const start = startRow(repo);
        expect(start?.data?.driver).toBe(combo.autoPicks);
        expect(start?.data?.driverEvidence).toBe(combo.evidence);
        expect(dispatched).toEqual([combo.autoPicks]);
      }

      // config subprocess
      {
        const { repo } = useRepo(setupTestRepo("subprocess"));
          const res = await runCli([], repo);
        expect(res.code).toBe(0);
        expect(picked!.id).toBe("subprocess");
        const start = startRow(repo);
        expect(start?.data?.driver).toBe("subprocess");
        expect(start?.data?.driverEvidence).toBe("subprocess (config)");
      }
    }

    // 6. explicit --driver bypasses the host check
    const drivers = ["auto", "herdr", "subprocess", "orca"];
    for (const d of drivers) {
      for (const combo of hostCombos) {
        delete process.env.HERDR_ENV;
        delete process.env.TERM_PROGRAM;
        delete process.env.ORCA_TERMINAL_HANDLE;
        Object.assign(process.env, combo.env);

        // mismatched config driver; explicit --driver wins
        const { repo } = useRepo(setupTestRepo("herdr"));
          const res = await runCli(["--driver", d], repo);
        expect(res.code).toBe(0);
        const want = d === "auto" ? combo.autoPicks : d;
        expect(picked!.id).toBe(want);
        const start = startRow(repo);
        expect(start?.data?.driver).toBe(want);
        expect(start?.data?.driverEvidence).toBe(`${want} (--driver)`);
      }
    }

    // 7. resume refuses; journal byte-identical
    {
      delete process.env.HERDR_ENV;
      delete process.env.TERM_PROGRAM;
      delete process.env.ORCA_TERMINAL_HANDLE;

      const { repo } = useRepo(setupTestRepo("herdr"));
      const { runId, journal } = await createRecordedRun(repo, "run-refuse-resume", "herdr");
      const journalFile = join(journal.dir, "journal.jsonl");
      const bytesBefore = readFileSync(journalFile);

      const res = await resumeCli([runId], repo);
      expect(res.code).not.toBe(0);
      expect(res.out).toContain("detected host is none");
      expect(res.out).toContain("driver: herdr");
      expect(res.out).toContain("--driver subprocess");
      expect(picked).toBeNull();

      const bytesAfter = readFileSync(journalFile);
      expect(bytesAfter.equals(bytesBefore)).toBe(true);
    }

    // 8. resume proceeds when the host matches
    {
      process.env.HERDR_ENV = "1";
      delete process.env.TERM_PROGRAM;
      delete process.env.ORCA_TERMINAL_HANDLE;

      const { repo } = useRepo(setupTestRepo("herdr"));
      const { runId } = await createRecordedRun(repo, "run-match-resume", "herdr");

      const res = await resumeCli([runId, "--retry-failed"], repo);
      expect(res.code).toBe(0);
      expect(picked!.id).toBe("herdr");

      const rows = Journal.open(repo, runId).read();
      const resumeRow = rows.find((e) => e.event === "run-resume");
      expect(resumeRow).toBeDefined();
      expect(resumeRow?.data?.pid).toBe(process.pid);
      expect(rows.filter((e) => e.event === "task-dispatch").length).toBeGreaterThan(1);
      expect(dispatched).toEqual(["herdr"]);
    }

    // 9. resume under auto on the other host dispatches that host's driver, not the journaled one
    {
      const { repo } = useRepo(setupTestRepo("auto"));
      const { runId } = await createRecordedRun(repo, "run-cross-host", "herdr");
      const jBefore = Journal.open(repo, runId);
      expect(jBefore.read().find((e) => e.event === "run-start")?.data?.driver).toBe("herdr");

      // resume under Orca:
      delete process.env.HERDR_ENV;
      process.env.TERM_PROGRAM = "Orca";
      process.env.ORCA_TERMINAL_HANDLE = "term_cross";

      const res = await resumeCli([runId, "--retry-failed"], repo);
      expect(res.code).toBe(0);
      // journaled driver is never an override
      expect(picked!.id).toBe("orca");
      const rows = Journal.open(repo, runId).read();
      expect(rows.some((e) => e.event === "run-resume")).toBe(true);
      expect(rows.find((e) => e.event === "run-start")?.data?.driver).toBe("herdr"); // untouched
      expect(dispatched).toEqual(["orca"]);
    }
  }, 600_000);
});
