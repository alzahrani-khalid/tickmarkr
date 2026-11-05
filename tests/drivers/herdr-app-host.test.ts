import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import type { WorkerAdapter } from "../../src/adapters/types.js";
import { doctor, hostRows, probeHerdrAppCapability, probeOrcaCapability } from "../../src/cli/commands/doctor.js";
import { ORCA_FIXTURE_VERSION } from "../../src/drivers/orca.js";
import { detectedHost as initDetectedHost } from "../../src/cli/commands/init.js";
import { run } from "../../src/cli/commands/run.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { HerdrAppDriver, terminalPayload } from "../../src/drivers/herdr-app.js";
import { HC_SCOPE_WARNING, HERDR_CONTROL_VARS, SEAT_MARKER_ENV } from "../../src/drivers/host-env.js";
import { captureHost, classifyHost, DRIVER_CHOICES, driverEvidence, pickDriver, preflightHostDriver, type ClassifiedHost, type DriverChoice } from "../../src/drivers/index.js";
import { herdrSealShellPrefix, SubprocessDriver } from "../../src/drivers/subprocess.js";
import * as DaemonModule from "../../src/run/daemon.js";
import { sh } from "../../src/run/git.js";
import { detectedHost as wizardDetectedHost, driverDescription } from "../../src/tui/ink/init-app.js";
import { FakeHerdrApp } from "../helpers/fake-herdr-app.js";
import { COMMIT, makeRepo, setupRepo, T } from "../helpers/tmprepo.js";

// Queue row 340; D-2180 — contract H and E: the Herdr app is detected from its HC pair, admitted by hc server status,
// probed only where selected, and its addressing (plus the launching terminal's HC_SCOPE) never reaches an agent child.
// Every hc/herdr-app here is an executable fake reached by explicit path; no case can reach an installed binary.

const ROOT = join(import.meta.dirname, "../..");
const HOST_KEYS = ["HERDR_ENV", "HERDR_SOCKET_PATH", "TERM_PROGRAM", "ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY", "ORCA_TAB_ID",
  "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "HC_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE"] as const;
type Env = Partial<Record<(typeof HOST_KEYS)[number], string>>;
const HC: Env = { HC_TERMINAL_ID: "t4", HC_TERMINAL_SOCKET: "/tmp/hc-host-test.sock" };
const ORCA: Env = { TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: "term-host-test" };
const TOKEN = "launcher-scope-token-5f3a";
const COLLECTED = "collected under an ambient HC pair and HC_SCOPE the suite still selects subprocess";

const stubHost = (env: Env) => { for (const k of HOST_KEYS) vi.stubEnv(k, env[k]); };
const fakeDir = () => mkdtempSync(join(tmpdir(), "tkr-hc-host-"));
const parseEnv = (text: string): Record<string, string> =>
  Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Herdr app host — contract H and E (queue row 340; D-2180)", () => {
  // The leaf a nested runner collects with the markers set in ITS collecting process (criterion 1).
  test(COLLECTED, () => {
    for (const k of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE"]) expect(process.env[k], k).toBeUndefined();
    const driver = pickDriver(DEFAULT_CONFIG);
    expect(driver.id).toBe("subprocess");
    expect(driverEvidence(DEFAULT_CONFIG, driver)).toBe("auto → subprocess (HERDR_ENV unset)");
  });

  test("host selection satisfies the closed precedence table without a binary call while captured evidence remains stable after environment mutation while an ambient HC pair or HC_SCOPE in the collecting process cannot change driver selection", async () => {
    // A PATH-first fake hc/herdr-app logs any call selection could make: there must be none.
    const f = new FakeHerdrApp(fakeDir());
    vi.stubEnv("PATH", `${f.dir}:${process.env.PATH ?? ""}`);
    const table: [string, Env, ClassifiedHost][] = [
      ["classic beside both other hosts", { HERDR_ENV: "1", ...HC, ...ORCA }, "herdr"],
      ["HC pair beside Orca", { ...HC, ...ORCA }, "herdr-app"],
      ["HC pair padded", { HC_TERMINAL_ID: " t4 ", HC_TERMINAL_SOCKET: " /s " }, "herdr-app"],
      ["HERDR_ENV not exactly one", { HERDR_ENV: "true", ...HC }, "herdr-app"],
      ["Orca pair", ORCA, "orca"],
      ["HC id alone", { HC_TERMINAL_ID: "t4", ...ORCA, ORCA_TERMINAL_HANDLE: undefined }, "none"],
      ["HC socket alone", { HC_TERMINAL_SOCKET: "/s" }, "none"],
      ["blank HC id", { HC_TERMINAL_ID: "  ", HC_TERMINAL_SOCKET: "/s" }, "none"],
      ["blank Orca handle", { TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: "  " }, "none"],
      ["ghostty alone", { TERM_PROGRAM: "ghostty" }, "none"],
      ["HC_SCOPE alone", { HC_SCOPE: TOKEN }, "none"],
    ];
    const autoId: Record<ClassifiedHost, string> = { herdr: "herdr", "herdr-app": "herdr-app", orca: "orca", none: "subprocess" };
    for (const [name, env, host] of table) {
      stubHost(env);
      expect(classifyHost(), name).toBe(host);
      const snapshot = captureHost();
      expect(snapshot.host, name).toBe(host);
      expect(snapshot.inheritedScope, name).toBe(env.HC_SCOPE !== undefined);
      expect(pickDriver(DEFAULT_CONFIG, undefined, snapshot.host).id, name).toBe(autoId[host]);
    }
    // Explicit override wins anywhere; an unknown one is a usage failure; a config choice is that driver.
    const explicit = pickDriver(DEFAULT_CONFIG, "herdr-app", "none");
    expect(explicit).toBeInstanceOf(HerdrAppDriver);
    expect(driverEvidence(DEFAULT_CONFIG, explicit)).toBe("herdr-app (--driver)");
    expect(() => pickDriver(DEFAULT_CONFIG, "herdr_app", "none")).toThrow("usage: --driver must be one of auto | herdr | subprocess | orca | herdr-app (got herdr_app)");
    const configured = { ...DEFAULT_CONFIG, driver: "herdr-app" as const };
    expect(driverEvidence(configured, pickDriver(configured, undefined, "none"))).toBe("herdr-app (config)");

    // The captured snapshot and its evidence survive later environment mutation, and name variables, never values.
    stubHost({ ...HC, HC_SCOPE: TOKEN });
    const snapshot = captureHost();
    const auto = pickDriver(DEFAULT_CONFIG, undefined, snapshot.host);
    stubHost({ HERDR_ENV: "1" });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual({ host: "herdr-app", inheritedScope: true });
    const evidence = driverEvidence(DEFAULT_CONFIG, auto);
    expect(evidence).toBe("auto → herdr-app (HC_TERMINAL_ID+HC_TERMINAL_SOCKET)");
    for (const value of [HC.HC_TERMINAL_ID!, HC.HC_TERMINAL_SOCKET!, TOKEN]) expect(evidence).not.toContain(value);
    expect(f.calls()).toEqual([]);

    // The collecting process itself carries the HC pair and HC_SCOPE before config/setup load; the collected leaf
    // still sees neither and auto still resolves to subprocess.
    const out = join(fakeDir(), "report.json");
    const ambient = { ...process.env, HC_TERMINAL_ID: "t9", HC_TERMINAL_SOCKET: "/tmp/hc-ambient.sock", HC_SCOPE: TOKEN };
    const nested = await new Promise<{ code: number | null; output: string }>((resolve) => {
      execFile(process.execPath, [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "tests/drivers/herdr-app-host.test.ts",
        "--project", "suite", "-t", COLLECTED, "--reporter", "json", "--outputFile", out],
      { cwd: ROOT, env: ambient, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: `${stdout}\n${stderr}` }));
    });
    expect(nested.code, nested.output).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8")) as { testResults: { assertionResults: { title: string; status: string }[] }[] };
    const ran = report.testResults.flatMap((r) => r.assertionResults).filter((a) => a.status !== "skipped" && a.status !== "pending");
    expect(ran).toEqual([expect.objectContaining({ title: COLLECTED, status: "passed" })]);
  }, 150_000);

  test("Herdr app preflight satisfies the closed admission table before run state exists while unreachable hc never substitutes subprocess", async () => {
    stubHost({});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const repo = makeRepo({ "a.txt": "a" });
    const f = new FakeHerdrApp(fakeDir());
    // herdr-app answers that no window owns its socket: admission never asks it.
    f.rule({ tool: "herdr-app", match: [], stderr: "Error: no Herdr window is listening\n", exit: 1 });
    const admit = (override: string | undefined, host: ClassifiedHost, cfg = DEFAULT_CONFIG, hcBin = f.hc) =>
      preflightHostDriver(cfg, override, host, repo, process.env, { hcBin, timeoutMs: 1_500 });

    // Base: a detected host and an explicit selection outside any shown window both admit on one status call.
    await expect(admit(undefined, "herdr-app")).resolves.toBeUndefined();
    await expect(admit("herdr-app", "none")).resolves.toBeUndefined();
    expect(f.calls()).toEqual([{ tool: "hc", argv: ["server", "status", "--json"] }, { tool: "hc", argv: ["server", "status", "--json"] }]);

    // Every failure refuses visibly, naming herdr-app and never another driver.
    const failures: [string, Parameters<FakeHerdrApp["rule"]>[0] | "missing"][] = [
      ["hc missing", "missing"],
      ["timeout", { match: ["server", "status"], sleepMs: 4_000 }],
      ["signal", { match: ["server", "status"], signal: "SIGKILL" }],
      ["nonzero", { match: ["server", "status"], stderr: '{"error":{"kind":"io","message":"connect refused"}}\n', exit: 3 }],
      ["success body on nonzero", { match: ["server", "status"], output: '{"core":{"id":"c1"},"version":"0.1.17","pid":7,"live":0,"finished":0}\n', exit: 1 }],
      ["malformed", { match: ["server", "status"], output: "{not json\n" }],
      ["incomplete", { match: ["server", "status"], output: '{"core":{"id":"c1"},"version":"0.1.17","live":0,"finished":0}\n' }],
    ];
    for (const [name, rule] of failures) {
      f.clearRules();
      if (rule !== "missing") f.rule(rule);
      const refused = admit(undefined, "herdr-app", DEFAULT_CONFIG, rule === "missing" ? join(f.dir, "absent-hc") : f.hc);
      await expect(refused, name).rejects.toThrow(/^refusing driver 'herdr-app': hc server status failed — status response family failed/);
      await expect(refused, name).rejects.toThrow(/no other driver is substituted/);
    }
    expect(f.calls().filter((c) => c.tool === "herdr-app")).toEqual([]);

    // A host-specific config driver on another host refuses before any probe, naming the line, host and remedy.
    f.clearCalls();
    await expect(admit(undefined, "none", { ...DEFAULT_CONFIG, driver: "herdr-app" })).rejects.toThrow(
      "refusing driver 'herdr-app' (config line 'driver: herdr-app'): detected host is none; use --driver subprocess to override");
    await expect(admit(undefined, "herdr-app", { ...DEFAULT_CONFIG, driver: "herdr" })).rejects.toThrow(
      "refusing driver 'herdr' (config line 'driver: herdr'): detected host is herdr-app; use --driver herdr-app to override");
    await expect(admit(undefined, "herdr-app", { ...DEFAULT_CONFIG, driver: "subprocess" })).resolves.toBeUndefined();
    expect(f.calls()).toEqual([]);
    // The declared host guidance states that same rule: --driver selects a host-specific driver elsewhere, and a config
    // line naming one is refused off its host — never recommended there as a way in.
    for (const doc of ["README.md", "docs/codebase/INTEGRATIONS.md"]) {
      const text = readFileSync(join(ROOT, doc), "utf8").replace(/\s+/g, " ");
      expect(text, doc).toContain("Outside a Herdr app terminal, select it with `--driver herdr-app`.");
      expect(text, doc).toMatch(/A config `driver: herdr-app` .{0,160}on any other host .{0,60}refuse/);
      expect(text, doc).not.toMatch(/`--driver herdr-app` or `driver: herdr-app`|`--driver orca` or `driver: orca`/);
    }

    // Through run itself on a detected host whose hc does not resolve (PATH holds no hc at all): refused before any
    // run directory or daemon, never dispatched on subprocess.
    for (const dir of ["/usr/bin", "/bin"]) expect(existsSync(join(dir, "hc")), dir).toBe(false);
    const daemon = vi.spyOn(DaemonModule, "runDaemon");
    const { repo: runRepo } = setupRepo([T("T1")], { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } });
    stubHost(HC);
    vi.stubEnv("PATH", `${fakeDir()}:/usr/bin:/bin`);
    await expect(run([], runRepo)).rejects.toThrow(/refusing driver 'herdr-app': hc not installed on this process's PATH; no other driver is substituted/);
    expect(daemon).not.toHaveBeenCalled();
    expect(existsSync(join(runRepo, ".tickmarkr", "runs"))).toBe(false);
  }, 60_000);

  test("doctor and both init detectors satisfy the selected-only probe table while unselected hc installation never starts a core or falsely implies subprocess", async () => {
    // The three detectors agree on every host.
    const hosts: [Env, string, string][] = [
      [{ HERDR_ENV: "1", ...HC }, "herdr", "herdr — auto selects the herdr driver"],
      [{ ...HC, ...ORCA }, "herdr-app", "Herdr app — auto selects the herdr-app driver"],
      [ORCA, "orca", "Orca — auto selects the orca driver"],
      [{ HC_TERMINAL_ID: "t4" }, "subprocess", "no herdr, Herdr app or Orca host — seats run headless on the subprocess driver with no daemon board"],
    ];
    for (const [env, detected, row] of hosts) {
      expect(initDetectedHost(env as NodeJS.ProcessEnv)).toBe(detected);
      expect(wizardDetectedHost(env as NodeJS.ProcessEnv)).toBe(detected);
      expect(hostRows(env, "headless")).toEqual([{ verdict: "pass", key: "host", detail: row }]);
    }
    // The wizard offers the new driver and seeds the detected host into auto's description.
    expect(driverDescription("auto", "herdr-app")).toBe("auto — resolves to herdr-app here");
    expect(driverDescription("herdr-app", "subprocess")).toMatch(/^herdr-app: /);

    const f = new FakeHerdrApp(fakeDir());
    const layout = '{"spaces":[{"id":"s1","tabs":[{"id":"b1","name":"ORCH","terminals":[{"terminal":"t4","pane":"p1"}]}]}]}\n';
    const seams = { resolveHcBinary: () => f.hc, resolveHerdrAppBinary: () => f.app };
    const absent = { resolveHcBinary: () => undefined, resolveHerdrAppBinary: () => undefined };
    const probe = (env: Env, driver: DriverChoice = "auto", s: typeof seams | typeof absent = seams) => probeHerdrAppCapability(ROOT, env, driver, s);

    // Unselected hosts: installed hc is reported, never probed; absent hc is an explicit absent row on every one. HC
    // markers outranked by herdr say so (D-2180 add.11) and make no auto claim.
    for (const [env, note] of [[{}, ""], [{ HERDR_ENV: "1", ...HC }, "; Herdr app markers present, not selected: herdr takes precedence"], [ORCA, ""],
      [{ HC_TERMINAL_ID: "t4", HC_SCOPE: TOKEN }, ""]] as [Env, string][]) {
      expect(await probe(env), JSON.stringify(env)).toEqual({ verdict: "pass", detail: `hc installed — not probed (probing starts a core)${note}` });
      expect(await probe(env, "auto", absent), JSON.stringify(env)).toEqual({ verdict: "fail", detail: `hc not installed — herdr-app not selected here${note}` });
    }
    expect(f.calls()).toEqual([]);

    // Selected: detected with a window, detected without one, explicit-only, unreachable and absent are all distinct.
    f.rule({ tool: "herdr-app", match: ["ls"], output: layout, once: true });
    const withWindow = await probe(HC);
    expect(withWindow.verdict).toBe("pass");
    expect(withWindow.detail).toMatch(/^core f191f9b1503d40cb5c557bf9f3701747 reachable \(hc 0\.1\.17\); app window present — auto selects herdr-app \(HC_TERMINAL_ID\+HC_TERMINAL_SOCKET\)$/);
    expect(f.calls().map((c) => [c.tool, ...c.argv])).toEqual([["hc", "server", "status", "--json"], ["herdr-app", "ls"]]);
    f.rule({ tool: "herdr-app", match: ["ls"], stderr: "Error: no Herdr window is listening\n", exit: 1 });
    const noWindow = await probe(HC);
    expect(noWindow.verdict).toBe("warn");
    expect(noWindow.detail).toContain("app window absent — execution available, task tabs and board unavailable — auto selects herdr-app");
    // Only herdr-app's recognized no-window refusal proves absence; every other app failure keeps the window unknown and
    // names its failure, and a missing herdr-app is its own row.
    const appFailures: [string, Parameters<FakeHerdrApp["rule"]>[0], RegExp][] = [
      ["malformed JSON", { tool: "herdr-app", match: ["ls"], output: "{not json\n" }, /app-ls response family failed — malformed JSON/],
      ["permission denied", { tool: "herdr-app", match: ["ls"], stderr: "herdr-app: Permission denied (os error 13)\n", exit: 13 }, /app-ls response family failed — exited 13 \[/],
      ["app error body", { tool: "herdr-app", match: ["ls"], output: '{"error":"socket refused"}\n', exit: 1 }, /exited 1 \(app_error\)/],
      ["signal", { tool: "herdr-app", match: ["ls"], signal: "SIGKILL" }, /ended by signal SIGKILL/],
      ["incomplete layout", { tool: "herdr-app", match: ["ls"], output: '{"spaces":[{"id":"s1"}]}\n' }, /app-ls response family failed — tabs is not an array/],
    ];
    for (const [name, rule, reason] of appFailures) {
      f.clearRules();
      f.rule(rule);
      const row = await probe(HC);
      expect(row.verdict, name).toBe("warn");
      expect(row.detail, name).toMatch(/^core \S+ reachable \(hc 0\.1\.17\); app window unknown — herdr-app ls failed: /);
      expect(row.detail, name).toMatch(reason);
      expect(row.detail, name).not.toContain("app window absent");
    }
    f.clearRules();
    expect((await probe(HC, "auto", { resolveHcBinary: () => f.hc, resolveHerdrAppBinary: () => undefined })).detail).toMatch(
      /^core \S+ reachable \(hc 0\.1\.17\); herdr-app not installed — execution available, task tabs and board unavailable — auto selects/);
    // A config selection outside its host is probed but says run/resume refuse that line; only --driver selects it there.
    const explicitOnly = await probe({}, "herdr-app");
    expect(explicitOnly.detail).toContain("config driver: herdr-app but the detected host is none — run and resume refuse that config line here; select it with --driver herdr-app");
    expect((await probe(ORCA, "herdr-app")).detail).toContain("config driver: herdr-app but the detected host is orca — run and resume refuse");
    f.rule({ match: ["server", "status"], stderr: '{"error":{"kind":"io","message":"connect refused"}}\n', exit: 7 });
    const unreachable = await probe(HC);
    expect(unreachable.verdict).toBe("fail");
    expect(unreachable.detail).toMatch(/^hc installed but core unreachable — hc server status failed — status response family failed — exited 7 \(io\)/);
    expect(await probe(HC, "auto", absent)).toEqual({ verdict: "fail",
      detail: "hc not installed — auto selects herdr-app (HC_TERMINAL_ID+HC_TERMINAL_SOCKET), so runs refuse; no other driver is substituted" });
    for (const row of [withWindow, noWindow, explicitOnly, unreachable]) expect(row.detail).not.toContain("subprocess");

    // D-2180 add.8: the row's selection follows the RESOLVED driver exactly as pickDriver/preflight resolve it. A config
    // naming subprocess, herdr or orca on a Herdr app host leaves herdr-app unselected: capability only, no run claim.
    // The reviewer's reproducer: HC pair + config subprocess + absent hc admits and runs subprocess — so no refusal.
    const subprocessCfg = { ...DEFAULT_CONFIG, driver: "subprocess" as const };
    await expect(preflightHostDriver(subprocessCfg, undefined, "herdr-app", ROOT, HC as NodeJS.ProcessEnv, { hcBin: join(f.dir, "absent-hc") })).resolves.toBeUndefined();
    expect(pickDriver(subprocessCfg, undefined, "herdr-app").id).toBe("subprocess");
    for (const driver of ["subprocess", "herdr", "orca"] as const) {
      expect(await probe(HC, driver, absent), driver).toEqual({ verdict: "fail",
        detail: `hc not installed — herdr-app not selected here; Herdr app markers present, not selected: config driver: ${driver}` });
    }
    // Bounded generalisation over every config choice on every host shape: the row claims a run (and probes the core)
    // iff resolution yields herdr-app; otherwise it is the capability-only row and makes no hc call.
    f.clearRules();
    f.rule({ tool: "herdr-app", match: ["ls"], output: layout });
    for (const env of [{}, { HERDR_ENV: "1", ...HC }, HC, { ...HC, HC_SCOPE: TOKEN }, ORCA, { HC_TERMINAL_ID: "t4" }] as Env[]) {
      for (const driver of DRIVER_CHOICES) {
        const label = `${JSON.stringify(env)} driver: ${driver}`;
        const host = classifyHost(env as NodeJS.ProcessEnv);
        const selected = pickDriver({ ...DEFAULT_CONFIG, driver }, undefined, host).id === "herdr-app";
        // HC pair present but not selected: the row names why (an earlier host, or the config driver), never a claim.
        const note = !selected && env.HC_TERMINAL_ID?.trim() && env.HC_TERMINAL_SOCKET?.trim()
          ? `; Herdr app markers present, not selected: ${host === "herdr-app" ? `config driver: ${driver}` : `${host} takes precedence`}` : "";
        const missing = await probe(env, driver, absent);
        expect(missing.detail.includes("runs refuse"), label).toBe(selected);
        if (!selected) expect(missing, label).toEqual({ verdict: "fail", detail: `hc not installed — herdr-app not selected here${note}` });
        f.clearCalls();
        const installed = await probe(env, driver);
        expect(f.hcCalls("server").length, label).toBe(selected ? 1 : 0);
        if (!selected) expect(installed, label).toEqual({ verdict: "pass", detail: `hc installed — not probed (probing starts a core)${note}` });
      }
    }
    f.clearRules();

    // Through doctor itself (init's sensor): an unselected plain host makes no hc call (subprocess really is its driver);
    // a Herdr app host or Orca host never reads "subprocess will be used" because classic herdr is absent, and the Herdr
    // app host names that host and probes once.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("catalog fetch unavailable in test"); }));
    vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
    vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
    const stub = { id: "fixture", vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }) } as unknown as WorkerAdapter;
    const doctorUnder = async (env: Env, files: Record<string, string> = {}, extra: Parameters<typeof doctor>[3] = {}) => {
      stubHost(env);
      vi.stubEnv("LANG", "en_US.UTF-8");
      return doctor(["--"], makeRepo({ "k.txt": "x", ...files }), [stub], { banner: false, resolveOrcaBinary: () => undefined, ...seams, ...extra });
    };
    f.clearRules();
    f.clearCalls();
    const plain = await doctorUnder({});
    expect(plain).toMatch(/^ {2}✗ herdr\s+not detected — subprocess driver will be used$/m);
    expect(plain).toMatch(/^ {2}✓ herdr-app\s+hc installed — not probed \(probing starts a core\)$/m);
    const orca = await doctorUnder(ORCA);
    expect(orca).toMatch(/^ {2}✗ herdr\s+classic herdr not detected \(HERDR_ENV unset\)$/m);
    expect(orca).not.toContain("subprocess driver will be used");
    expect(orca).toMatch(/^ {2}✓ herdr-app\s+hc installed — not probed \(probing starts a core\)$/m);
    expect(f.calls()).toEqual([]);
    f.rule({ tool: "herdr-app", match: ["ls"], output: layout });
    const app = await doctorUnder(HC);
    expect(app).toMatch(/^ {2}✓ host\s+Herdr app — auto selects the herdr-app driver$/m);
    expect(app).toMatch(/^ {2}✗ herdr\s+classic herdr not detected \(HERDR_ENV unset\)$/m);
    expect(app).toMatch(/^ {2}✓ herdr-app\s+core \S+ reachable \(hc 0\.1\.17\); app window present/m);
    expect(app).not.toContain("subprocess driver will be used");
    expect(f.hcCalls("server")).toEqual([["server", "status", "--json"]]);
    // A Herdr app host whose repo config selects subprocess: doctor probes no core and claims no herdr-app run; the
    // classic herdr row's "subprocess will be used" is true here because subprocess is the configured driver.
    f.clearCalls();
    const configured = await doctorUnder(HC, { ".tickmarkr/config.yaml": "driver: subprocess\n" });
    expect(configured).toMatch(/^ {2}✓ herdr-app\s+hc installed — not probed \(probing starts a core\); Herdr app markers present, not selected: config driver: subprocess$/m);
    expect(configured).toMatch(/^ {2}✓ host\s+Herdr app — Herdr app markers present, not selected: config driver: subprocess$/m);
    expect(configured).not.toMatch(/auto selects/);
    expect(configured).not.toContain("runs refuse");
    expect(configured).toMatch(/^ {2}✗ herdr\s+not detected — subprocess driver will be used$/m);
    expect(f.calls()).toEqual([]);

    // D-2180 add.11 (review finding): ONE resolution — classifyHost precedence, then the config driver, as pickDriver and
    // preflightHostDriver resolve it — decides every host row's claim. The reviewer's mixed-marker hosts through doctor's
    // own orca call site (process.env, no orcaEnv seam): the Orca row says its markers lost and to whom, never "auto
    // picks orca", agreeing with the host row and both init detectors. Control: Orca alone keeps the auto claim.
    const orcaSeams = { resolveOrcaBinary: () => "/fixture/orca",
      orcaStatusProbe: async () => ({ code: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { reachable: true, appVersion: ORCA_FIXTURE_VERSION } }, _meta: { runtimeId: "rt-host" } }), stderr: "", timedOut: false }),
      orcaHooksStatusProbe: async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false }) };
    const rowOf = (out: string, key: string) => out.split("\n").filter((l) => new RegExp(`^ {2}[✓✗!] ${key}\\s`).test(l));
    f.rule({ tool: "herdr-app", match: ["ls"], output: layout });
    const mixed: [string, Env, string, string][] = [
      ["HC pair + Orca", { ...HC, ...ORCA }, "herdr-app", "Orca markers present, not selected: herdr-app takes precedence"],
      ["HERDR_ENV + HC pair + Orca", { HERDR_ENV: "1", ...HC, ...ORCA }, "herdr", "Orca markers present, not selected: herdr takes precedence"],
      ["HERDR_ENV + Orca", { HERDR_ENV: "1", ...ORCA }, "herdr", "Orca markers present, not selected: herdr takes precedence"],
      ["Orca alone (control)", ORCA, "orca", "auto picks orca in this Orca terminal"],
    ];
    for (const [name, env, winner, orcaClaim] of mixed) {
      const out = await doctorUnder(env, {}, orcaSeams);
      const [orcaRow] = rowOf(out, "orca");
      expect(orcaRow, name).toMatch(new RegExp(`runtime reachable \\(rt-host, appVersion \\S+; fixture pin \\S+\\); hooks status unavailable — ${orcaClaim}$`));
      expect(orcaRow.includes("auto picks orca"), name).toBe(winner === "orca");
      expect(rowOf(out, "host"), name).toEqual([expect.stringMatching(new RegExp(` — auto selects the ${winner} driver$`))]);
      expect(initDetectedHost(env as NodeJS.ProcessEnv), name).toBe(winner);
      expect(wizardDetectedHost(env as NodeJS.ProcessEnv), name).toBe(winner);
      expect(pickDriver(DEFAULT_CONFIG, undefined, captureHost().host).id, name).toBe(winner);
      // Every "auto selects/picks <host>" claim on the page names the winner only.
      for (const m of out.matchAll(/auto (?:selects|picks) (?:the )?(herdr-app|herdr|orca)\b(?! only inside)/g)) expect(m[1], `${name}: ${m[0]}`).toBe(winner);
      if (winner === "herdr") expect(rowOf(out, "herdr-app"), name).toEqual([expect.stringMatching(env.HC_TERMINAL_ID
        ? /hc installed — not probed \(probing starts a core\); Herdr app markers present, not selected: herdr takes precedence$/
        : /hc installed — not probed \(probing starts a core\)$/)]);
    }
    // HERDR_ENV=1 + Orca with config subprocess: no row claims herdr or orca; each says its markers lost and to what.
    const herdrConfigured = await doctorUnder({ HERDR_ENV: "1", ...ORCA }, { ".tickmarkr/config.yaml": "driver: subprocess\n" }, orcaSeams);
    expect(rowOf(herdrConfigured, "herdr")).toEqual([expect.stringMatching(/driver available \(HERDR_ENV=1\) — herdr markers present, not selected: config driver: subprocess$/)]);
    expect(rowOf(herdrConfigured, "host")).toEqual([expect.stringMatching(/herdr — herdr markers present, not selected: config driver: subprocess$/)]);
    expect(rowOf(herdrConfigured, "orca")).toEqual([expect.stringMatching(/ — Orca markers present, not selected: herdr takes precedence$/)]);
    expect(herdrConfigured).not.toMatch(/auto (?:selects|picks) (?:the )?(?:herdr|orca)\b(?! only inside)/);
    f.clearRules();
    f.clearCalls();

    // Bounded generalisation over every marker subset x every config driver, oracle built from the subset itself: a
    // row claims its host (auto or config) iff the one resolution yields it; markers present but unselected name the
    // winner or the config driver; no row ever claims "auto" for a host auto does not pick.
    const parts: [string, Env][] = [["herdr", { HERDR_ENV: "1" }], ["herdr-app", HC], ["orca", ORCA]];
    for (let bits = 0; bits < 8; bits++) {
      const present = parts.filter((_, i) => bits & (1 << i));
      const env = Object.assign({}, ...present.map(([, e]) => e)) as Env;
      const winner = present[0]?.[0] ?? "none";
      expect(initDetectedHost(env as NodeJS.ProcessEnv)).toBe(winner === "none" ? "subprocess" : winner);
      expect(wizardDetectedHost(env as NodeJS.ProcessEnv)).toBe(winner === "none" ? "subprocess" : winner);
      for (const driver of DRIVER_CHOICES) {
        const label = `${present.map(([h]) => h).join("+") || "none"} driver: ${driver}`;
        const resolved = driver === "auto" ? (winner === "none" ? "subprocess" : winner) : driver;
        const refused = driver !== "auto" && driver !== "subprocess" && driver !== winner;
        const orcaRow = (await probeOrcaCapability(ROOT, { ...orcaSeams, orcaEnv: env }, driver)).detail;
        const appRow = (await probe(env, driver, absent)).detail;
        const [hostRow] = hostRows(env, "headless", driver);
        const rows: [string, string, string][] = [["orca", "Orca", orcaRow], ["herdr-app", "Herdr app", appRow]];
        for (const [target, label2, row] of rows) {
          const marked = present.some(([h]) => h === target);
          const claim = row.match(/auto (?:selects|picks) (herdr-app|herdr|orca)\b(?! only inside)/)?.[1];
          expect(claim, `${label} ${target}: ${row}`).toBe(driver === "auto" && resolved === target ? target : undefined);
          expect(row.includes(`config driver: ${target} on this`), `${label} ${target}`).toBe(driver === target && !refused);
          expect(row.includes("run and resume refuse"), `${label} ${target}`).toBe(driver === target && refused);
          const lost = marked && resolved !== target && driver !== target;
          expect(row.includes(`${label2} markers present, not selected: ${winner === target ? `config driver: ${driver}` : `${winner} takes precedence`}`), `${label} ${target}: ${row}`).toBe(lost);
        }
        expect(hostRow.detail.includes(`auto selects the ${winner} driver`), `${label} host: ${hostRow.detail}`).toBe(winner !== "none" && driver === "auto");
        expect(hostRow.detail.includes("seats run headless on the subprocess driver"), `${label} host`).toBe(winner === "none" && !refused);
        if (winner === "none" && refused) expect(hostRow.detail, label).toContain(`config driver: ${driver} but the detected host is none — run and resume refuse`);
        for (const m of hostRow.detail.matchAll(/auto selects the (\S+) driver/g)) expect(m[1], label).toBe(resolved);
      }
    }
    expect(f.calls()).toEqual([]);

    // Review finding (D-2180): doctor resolves hc exactly where preflight and the driver run it — this process's PATH,
    // which the hc client's execFile searches — never a login profile. Bounded over PATH layouts, with a profile that
    // would put a second hc first in a login shell: doctor reads a reachable core iff preflight admits, through the same
    // hc the driver is built with; a profile-only, relative-entry, directory or non-executable hc reads absent on every
    // surface and is never invoked.
    for (const dir of ["/usr/bin", "/bin"]) expect(existsSync(join(dir, "hc")), dir).toBe(false);
    const onPath = new FakeHerdrApp(fakeDir());
    const profileOnly = new FakeHerdrApp(fakeDir());
    const home = fakeDir();
    writeFileSync(join(home, ".bash_profile"), `export PATH='${profileOnly.dir}:/usr/bin:/bin'\n`);
    const nonExecutable = fakeDir();
    writeFileSync(join(nonExecutable, "hc"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const directory = fakeDir();
    mkdirSync(join(directory, "hc"));
    const layouts: [string, string, FakeHerdrApp | undefined][] = [
      ["process PATH beside a profile", `${onPath.dir}:/usr/bin:/bin`, onPath],
      ["login profile only (the reproducer)", "/usr/bin:/bin", undefined],
      ["non-executable hc first", `${nonExecutable}:${onPath.dir}:/usr/bin:/bin`, onPath],
      ["directory named hc first", `${directory}:${onPath.dir}:/usr/bin:/bin`, onPath],
      ["relative PATH entry only", `${relative(resolve("."), onPath.dir)}:/usr/bin:/bin`, undefined],
    ];
    for (const [name, path, runs] of layouts) {
      stubHost(HC);
      vi.stubEnv("HOME", home);
      vi.stubEnv("PATH", path);
      vi.stubEnv("LANG", "en_US.UTF-8");
      onPath.clearCalls();
      profileOnly.clearCalls();
      const row = await probeHerdrAppCapability(ROOT, process.env, "auto", { resolveHerdrAppBinary: () => undefined });
      const admitted = await preflightHostDriver(DEFAULT_CONFIG, undefined, "herdr-app", home, process.env).then(() => "admitted", (e: Error) => e.message);
      const built = pickDriver(DEFAULT_CONFIG, undefined, captureHost().host) as unknown as { id: string; opts: { hcBin?: string } };
      expect(built.id, name).toBe("herdr-app");
      expect(built.opts.hcBin, name).toBe(runs?.hc);
      if (runs) {
        expect(row.detail, name).toMatch(/^core \S+ reachable \(hc 0\.1\.17\); herdr-app not installed/);
        expect(admitted, name).toBe("admitted");
        expect(runs.hcCalls("server"), name).toEqual([["server", "status", "--json"], ["server", "status", "--json"]]);
      } else {
        expect(row, name).toEqual({ verdict: "fail",
          detail: "hc not installed — auto selects herdr-app (HC_TERMINAL_ID+HC_TERMINAL_SOCKET), so runs refuse; no other driver is substituted" });
        expect(admitted, name).toBe("refusing driver 'herdr-app': hc not installed on this process's PATH; no other driver is substituted " +
          "(install hc, start the Herdr app, or choose another --driver)");
        expect(onPath.calls(), name).toEqual([]);
      }
      expect(profileOnly.calls(), name).toEqual([]);
    }
  }, 120_000);

  test("worker pane and headless role environments satisfy the closed seal table while inherited scope is removed and a fresh worker scope remains owned", async () => {
    const home = fakeDir();
    const inherited: Env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", ORCA_TERMINAL_HANDLE: "term-x", ORCA_PANE_KEY: "pane-x",
      ORCA_TAB_ID: "tab-x", ...HC, HC_SCOPE: TOKEN, HC_SESSION: "own-session", TERM_PROGRAM: "ghostty" };
    stubHost(inherited);
    vi.stubEnv("HOME", home); // login shells: keep the operator's profile out of the recorded environment
    vi.stubEnv("ANTHROPIC_API_KEY", "user-auth-value");
    vi.stubEnv(SEAT_MARKER_ENV, "review");
    const kept = { HC_SESSION: "own-session", TERM_PROGRAM: "ghostty", ANTHROPIC_API_KEY: "user-auth-value" };
    const expectSealed = (env: Record<string, string>, label: string) => {
      for (const k of HERDR_CONTROL_VARS) expect(env[k], `${label} ${k}`).toBeUndefined();
      for (const [k, v] of Object.entries(kept)) expect(env[k], `${label} ${k}`).toBe(v);
    };

    // Subprocess worker: the real child of the driver's sealed spawn.
    const worker = new SubprocessDriver();
    const slot = await worker.slot(home, "T1-worker-fake-a0-r");
    await worker.run(slot, "env; printf 'DONE\\n'");
    expect(await worker.waitOutput(slot, "DONE", 10_000)).toBe(true);
    const workerEnv = parseEnv(await worker.read(slot, 1000));
    await worker.close(slot);
    expectSealed(workerEnv, "worker");
    expect(workerEnv[SEAT_MARKER_ENV]).toBeUndefined();

    // Headless role shells: a seat or an explicit agent shell drops every control var; the agent flag fabricates no seat.
    for (const seat of ["judge", "review", "consult"] as const) {
      const env = parseEnv((await sh("env", home, 30_000, { seat })).stdout);
      expectSealed(env, seat);
      expect(env[SEAT_MARKER_ENV]).toBe(seat);
    }
    const agent = parseEnv((await sh("env", home, 30_000, { agent: true })).stdout);
    expectSealed(agent, "agent");
    expect(agent[SEAT_MARKER_ENV]).toBeUndefined();
    // A non-agent shell (gate payload, the hc client) keeps the addressing pair so its session is never redirected.
    const plain = parseEnv((await sh("env", home, 30_000)).stdout);
    expect(plain.HC_TERMINAL_ID).toBe(HC.HC_TERMINAL_ID);
    expect(plain.HC_TERMINAL_SOCKET).toBe(HC.HC_TERMINAL_SOCKET);
    expect(plain.HERDR_ENV).toBe("1");

    // Pane seal (herdr/Orca seeds): inherited scope and addressing are unset inside the pane's own shell.
    const pane = parseEnv(execFileSync("bash", ["-c", `${herdrSealShellPrefix()}env`], { encoding: "utf8" }));
    expectSealed(pane, "pane");
    // A new hc terminal: hc injected its own fresh pair and scope; only that own scope survives the seal (hc kill reaps
    // through it), while the launcher's inherited scope never reaches the payload.
    const own = { ...process.env, HC_TERMINAL_ID: "t9", HC_TERMINAL_SOCKET: "/tmp/core.sock", HC_SCOPE: "scope-own-t9" };
    const terminal = parseEnv(execFileSync("bash", ["-c", terminalPayload("env", process.env)], { encoding: "utf8", env: own }));
    expect(terminal.HC_SCOPE).toBe("scope-own-t9");
    for (const k of HERDR_CONTROL_VARS) if (k !== "HC_SCOPE") expect(terminal[k], k).toBeUndefined();
    expect(Object.values(terminal)).not.toContain(TOKEN);
    expect(terminal.HC_SESSION).toBe("own-session");
    // The daemon's own environment is never mutated by any of these seals.
    expect(process.env.HC_SCOPE).toBe(TOKEN);
    expect(process.env.HC_TERMINAL_ID).toBe(HC.HC_TERMINAL_ID);
  }, 60_000);

  test("an inherited-scope snapshot emits one journal row and one warning line without its token while a scope-cleared launch emits neither", async () => {
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write);
    const daemon = async (runId: string, opts: { inheritedHcScope?: boolean } = {}) => {
      const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{ shell: `env > env.txt; echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } });
      lines.length = 0;
      const summary = await DaemonModule.runDaemon(repo, { adapters: [fake], runId, driver: new SubprocessDriver(), approvalWindowMs: 1, ...opts });
      const journal = readFileSync(join(repo, ".tickmarkr", "runs", runId, "journal.jsonl"), "utf8");
      const rows = journal.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; data: Record<string, unknown> });
      return { summary, journal, rows, warned: lines.join("").split("\n").filter((l) => l.includes(HC_SCOPE_WARNING)) };
    };

    // Direct daemon entry captures an inherited scope itself, strips it for children only and keeps the anchor pair.
    stubHost({ ...HC, HC_SCOPE: TOKEN });
    const inherited = await daemon("run-hc-scope-inherited");
    expect(inherited.summary.done).toContain("T1");
    expect(inherited.rows.filter((r) => r.event === "host-scope-inherited")).toEqual([
      expect.objectContaining({ event: "host-scope-inherited", data: { warning: HC_SCOPE_WARNING } })]);
    expect(inherited.warned).toEqual([`tickmarkr: warning: ${HC_SCOPE_WARNING}`]);
    expect(inherited.journal).not.toContain(TOKEN);
    expect(lines.join("")).not.toContain(TOKEN);
    expect(process.env.HC_SCOPE).toBeUndefined();
    expect(process.env.HC_TERMINAL_ID).toBe(HC.HC_TERMINAL_ID);
    expect(process.env.HC_TERMINAL_SOCKET).toBe(HC.HC_TERMINAL_SOCKET);

    // run/resume's forwarded snapshot decides, even after the variable is already gone from this process.
    stubHost(HC);
    const forwarded = await daemon("run-hc-scope-forwarded", { inheritedHcScope: true });
    expect(forwarded.rows.filter((r) => r.event === "host-scope-inherited")).toHaveLength(1);
    expect(forwarded.warned).toHaveLength(1);

    // A launch under env -u HC_SCOPE: no warning row, no warning line.
    stubHost(HC);
    const cleared = await daemon("run-hc-scope-cleared");
    expect(cleared.summary.done).toContain("T1");
    expect(cleared.rows.filter((r) => r.event === "host-scope-inherited")).toEqual([]);
    expect(cleared.warned).toEqual([]);
  }, 120_000);
});
