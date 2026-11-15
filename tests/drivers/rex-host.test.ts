// Queue row 391, phase 0 (D-2187 add.263): inside a detected Rex pane only the closed set of host lines changes.
// Every environment is built here; the real environment's TERM_PROGRAM and REX_ values are scrubbed by tests/setup.ts.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { hostRows } from "../../src/cli/commands/doctor.js";
import { plan } from "../../src/cli/commands/plan.js";
import { run } from "../../src/cli/commands/run.js";
import { DEFAULT_CONFIG, TickmarkrConfigSchema, type TickmarkrConfig } from "../../src/config/config.js";
import { captureHost, classifyHost, DRIVER_CHOICES, driverEvidence, parseDriverOverride, pickDriver } from "../../src/drivers/index.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { Journal } from "../../src/run/journal.js";
import { driverDescription, runInitWizardApp } from "../../src/tui/ink/init-app.js";
import { authedModels, COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const REX_LINE = "auto → subprocess (Rex detected, no Rex driver: running headless)";
const REX_HOST_ROW = "Rex detected, no Rex driver: running headless on the subprocess driver, with no daemon board";
const REX_WIZARD = "auto — resolves to subprocess here (Rex detected, no Rex driver: running headless)";
const BASE_LINE = "auto → subprocess (HERDR_ENV unset)";
const BASE_HOST_ROW = "no herdr, Herdr app or Orca host — seats run headless on the subprocess driver with no daemon board";
const BASE_WIZARD = "auto — resolves to subprocess here";

type Env = Record<string, string | undefined>;
const REX_PANES: Env[] = [
  { TERM_PROGRAM: "rex", REX_SESSION: "s1" }, // R1
  { TERM_PROGRAM: "rex", REX_SERVER: "/tmp/rex.sock", REX_BLOCK: "b1" }, // R1
  { TERM_PROGRAM: "Rex", REX_SERVER: "/tmp/rex.sock" }, // R2
];
const NOT_REX: Env[] = [
  { TERM_PROGRAM: "ghostty", REX_SERVER: "/tmp/rex.sock", REX_SESSION: "s1", REX_BLOCK: "b1" }, // R3 names alone
  { TERM_PROGRAM: "rex", REX_BIN_DIR: "/opt/rex/bin" }, // R3 REX_BIN_DIR only
  { TERM_PROGRAM: "rex", REX_SERVER: "  ", REX_SESSION: "\t", REX_BLOCK: " " }, // R3 whitespace only
];
const cfg = (driver: TickmarkrConfig["driver"]): TickmarkrConfig => ({ ...DEFAULT_CONFIG, driver });
const lineIn = (env: Env, driver: TickmarkrConfig["driver"] = "auto", override?: string) => {
  const c = cfg(driver);
  return driverEvidence(c, pickDriver(c, override, captureHost(env)), override);
};
const hostRow = (env: Env, driver: TickmarkrConfig["driver"] = "auto") => hostRows(env, "headless", driver)[0]!.detail;

const FAKE_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

const stubPane = (env: Env) => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); };

/** The mounted wizard (production stream path) at `columns`, on the driver row; returns every frame, ANSI stripped. */
async function mountedWizard(columns: number): Promise<string> {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
  const writes: string[] = [];
  const output = { isTTY: true, columns, rows: 60, write: (c: string) => { writes.push(c); return true; } } as unknown as NodeJS.WriteStream;
  await runInitWizardApp({
    fields: { driver: "auto", concurrency: 3, visibilityLlm: "headless", offerSkills: true, skillsDefault: true },
    input: input as unknown as NodeJS.ReadStream, output, initialInput: ["\x1b"],
  });
  return writes.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

afterEach(() => vi.unstubAllEnvs());

describe("row 391 phase 0: Rex detected, no Rex driver", () => {
  test("run started in a Rex pane journals the Rex driver line that plan also prints", async () => {
    stubPane({ TERM_PROGRAM: "rex", REX_SESSION: "s1" });
    const { repo, scriptPath } = setupRepo(
      [T("T1", { files: ["result.txt"] })],
      { tasks: { T1: [{ shell: `echo ok > result.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
      "driver: auto\n",
    );
    writeDoctor(repo, FAKE_DOCTOR);
    vi.stubEnv("TICKMARKR_FAKE_SCRIPT", scriptPath);

    const planned = (await plan([], repo)).split("\n").filter((l) => l.startsWith("driver: "));
    expect(planned).toEqual([`driver: ${REX_LINE}`]);

    const res = await run([], repo);
    expect(res.code).toBe(0);
    const runs = readdirSync(join(tickmarkrDir(repo), "runs"));
    expect(runs).toHaveLength(1);
    const start = Journal.open(repo, runs[0]!).read().find((e) => e.event === "run-start");
    expect(start?.data?.driver).toBe("subprocess");
    expect(start?.data?.driverEvidence).toBe(REX_LINE); // R8: run passes the whole snapshot

    // R7: the snapshot is the selection instant; removing the REX_ names before the line is formed changes nothing.
    stubPane({ TERM_PROGRAM: "rex", REX_SERVER: "/tmp/rex.sock" });
    const snapshot = captureHost();
    const driver = pickDriver(cfg("auto"), undefined, snapshot);
    vi.stubEnv("REX_SERVER", undefined);
    vi.stubEnv("TERM_PROGRAM", undefined);
    expect(driverEvidence(cfg("auto"), driver)).toBe(REX_LINE);

    // R1, R2 through the production functions
    for (const env of REX_PANES) expect(lineIn(env)).toBe(REX_LINE);
  });

  test("doctor's host row in a Rex pane reads Rex detected, no Rex driver: running headless on the subprocess driver, with no daemon board", () => {
    for (const env of REX_PANES) {
      expect(hostRow(env)).toBe(REX_HOST_ROW);
      expect(hostRow(env, "subprocess")).toBe(REX_HOST_ROW); // R5: config subprocess still reads the Rex sentence
      // the visibility row is unchanged
      expect(hostRows(env, "pane")[1]).toEqual(hostRows({}, "pane")[1]);
      // R5: a refused config keeps its own words
      for (const d of ["herdr", "herdr-app", "orca"] as const) expect(hostRow(env, d)).toBe(hostRow({}, d));
    }
    expect(hostRow({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop", TERM_PROGRAM: "rex", REX_BLOCK: "b" })).toBe(REX_HOST_ROW);
  });

  test("the mounted init wizard at 74 and at 80 columns shows the whole Rex sentence for auto", async () => {
    stubPane({ TERM_PROGRAM: "rex", REX_SESSION: "s1" });
    expect(driverDescription("auto")).toBe(REX_WIZARD);
    for (const columns of [74, 80]) {
      const frames = (await mountedWizard(columns)).replace(/\s+/g, " ");
      expect(frames).toContain(REX_WIZARD); // wrapped, never clipped
      expect(frames).not.toContain("running he…");
    }
  });

  test("Rex names without the rex terminal, the rex terminal with only REX_BIN_DIR, or blank names change no line", async () => {
    for (const env of NOT_REX) {
      expect(captureHost(env).rex).toBeUndefined();
      expect(lineIn(env)).toBe(BASE_LINE);
      expect(hostRow(env)).toBe(BASE_HOST_ROW);
    }
    // Outside Rex the snapshot keeps its base shape exactly.
    expect(captureHost({})).toEqual({ host: "none", inheritedScope: false });
    expect(Object.keys(captureHost({}))).toEqual(["host", "inheritedScope"]);
    stubPane(NOT_REX[1]!);
    expect(driverDescription("auto")).toBe(BASE_WIZARD);
    const frames = (await mountedWizard(80)).replace(/\s+/g, " ");
    expect(frames).toContain(BASE_WIZARD);
    expect(frames).not.toContain("Rex detected");
  });

  test("a Rex pane inside herdr, the Herdr app or Orca keeps that host's lines, and an explicit subprocess choice keeps its driver line", () => {
    const rex = { TERM_PROGRAM: "rex", REX_SESSION: "s1" };
    const hosts: [Env, string][] = [
      [{ ...rex, HERDR_ENV: "1" }, "herdr"],
      [{ ...rex, HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/tmp/hc.sock" }, "herdr-app"],
      // The Orca pair needs TERM_PROGRAM Orca, so Rex rides only its session names here.
      [{ TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: "h1", REX_SESSION: "s1", REX_SERVER: "/tmp/rex.sock" }, "orca"],
    ];
    for (const [env, host] of hosts) {
      const without = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("REX_") && !(k === "TERM_PROGRAM" && env[k] === "rex")));
      expect(captureHost(env)).toEqual({ host, inheritedScope: false });
      expect(hostRow(env)).toBe(hostRow(without));
      expect(hostRow(env)).not.toContain("Rex");
      expect(driverDescription("auto", host as "herdr")).toBe(`auto — resolves to ${host} here`);
    }
    // R5: a choice the user made carries no Rex suffix
    for (const env of REX_PANES) {
      expect(lineIn(env, "auto", "subprocess")).toBe("subprocess (--driver)");
      expect(lineIn(env, "subprocess")).toBe("subprocess (config)");
      expect(pickDriver(cfg("auto"), undefined, captureHost(env)).id).toBe("subprocess"); // R6: auto → subprocess
      expect(classifyHost(env as NodeJS.ProcessEnv)).toBe("none");
    }
    // R6: Rex is never a driver choice or a schema value
    expect(DRIVER_CHOICES as readonly string[]).not.toContain("rex");
    expect(() => parseDriverOverride("rex")).toThrow(/usage: --driver must be one of/);
    expect(TickmarkrConfigSchema.safeParse({ ...DEFAULT_CONFIG, driver: "rex" }).success).toBe(false);
  });
});
