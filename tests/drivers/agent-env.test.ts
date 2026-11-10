// Queue row 367 (its child-environment clause); D-2187 add.21 (2), cross-read M9: a sentinel Artificial Analysis key in
// the parent environment reaches no AGENT child — a worker (subprocess seal and pane shell prefix), a judge, review or
// consult seat, a doctor model probe and the Kimi doctor turn — while build, test, lint and oracle commands keep it
// byte-equal and the parent's lookup and catalog fetch still read it. Every child is a REAL login shell (bash -lc) whose
// agent is a further bash — the production dispatch script (`bash <script>`) or a `#!/bin/bash` CLI shim — running a
// recorder, under a temporary HOME whose startup file exports the sentinel too. So a seal that strips the variable before
// the shell starts while the profile hands it back is caught; a readonly export, which a shell `unset` cannot remove, is
// caught (the D-2187 add.21 (2) ruling). A key a user startup file sets itself in a shell the agent starts later is the
// user's own configuration (T9 outOfScope, D-2187 add.45), so no cell probes it. A profile-defined function, the
// variables it reads (under `set -u` too) and an alias still resolve exactly as at the base.
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ARTIFICIAL_ANALYSIS_KEY_NAME,
  LIVEBENCH_CATEGORIES_URL,
  LIVEBENCH_TABLE_URL,
  lookupArtificialAnalysisKey,
  MODELS_DEV_CATALOG_URL,
  refreshCatalogCommand,
} from "../../src/adapters/catalog-remote.js";
import { probeKimiDoctorTurn } from "../../src/adapters/kimi.js";
import { probeModels } from "../../src/adapters/registry.js";
import { channelsFromConfig, shq, type AuthHealth, type WorkerAdapter } from "../../src/adapters/types.js";
import { paneDispatchCommand } from "../../src/brand.js";
import { askArtificialAnalysisKey, lookupCommandKey, refreshCatalogWithAskedKey } from "../../src/cli/ask-keys.js";
import { DEFAULT_CONFIG, type TickmarkrConfig } from "../../src/config/config.js";
import { AGENT_WITHHELD_VARS, agentEnv, agentEnvShellPrefix, agentShellCommand, isAgentEnv } from "../../src/drivers/agent-env.js";
import { terminalPayload } from "../../src/drivers/herdr-app.js";
import { herdrSealShellPrefix, sealHerdrEnv, SubprocessDriver } from "../../src/drivers/subprocess.js";
import { captureBaseline, detectVacuousOracles } from "../../src/gates/baseline.js";
import { runHeadless, runViaDriver } from "../../src/gates/llm.js";
import { resetSpawnForTests, setSpawnForTests, sh } from "../../src/run/git.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetSpawnForTests();
});

const KEY = ARTIFICIAL_ANALYSIS_KEY_NAME;
// Values a shell would mangle if any seam re-quoted them: spaces, both quotes, $, a backslash.
const SENTINEL = `sk-aa-sentinel-367 'q' "dq" $HOME \\ end`;
// Control: an unlisted variable every child must still receive byte-equal, so a seal that strips more fails.
const CANARY = "TICKMARKR_ROW367_CANARY";
const CANARY_VALUE = `canary 'q' "dq" $PATH \\ end`;
// Control: the startup file exports this too, so a child that carries it really ran that file before its command.
const PROFILE_RAN = "TICKMARKR_ROW367_PROFILE_RAN";
// Control: a login-file cell's exported BASH_ENV exports this and no key, so BASH_ENV stays set and is sourced as usual.
const BASH_ENV_RAN = "TICKMARKR_ROW367_BASH_ENV_RAN";
// The closed list of startup files a bash reads before its command — the first login file that exists, then $BASH_ENV,
// which every non-interactive bash sources (the login shell and each further bash the agent starts).
const LOGIN_FILES = [".bash_profile", ".bash_login", ".profile"] as const;
type StartupFile = (typeof LOGIN_FILES)[number] | "BASH_ENV";
// The closed list of ways a startup file hands the key back: a plain export, and a readonly export no shell can unset.
const KEY_EXPORTS = ["export", "readonly export"] as const;
// Plus the fail-closed cell: a readonly export whose file also leaves env unreachable with execfail on, so the proof
// that the key is gone cannot run.
type StartupKey = "none" | (typeof KEY_EXPORTS)[number] | "readonly export, env unreachable";

type ChildRecord = { label: string; env: Record<string, string> };

/** A recorder: `node record.cjs <out> <label>` appends {label, env} as one JSON line — the environment the agent CLI it
 *  stands in for would have started with. `bashCmd` runs it through a further bash (`bash wrap.sh <label>`), and
 *  `dispatch` through the production dispatch line (`bash <script>`), as a CLI shim or a daemon dispatch would. */
function recorder() {
  const dir = makeTestTempDir("agent-env-");
  const out = join(dir, "records.jsonl");
  const script = join(dir, "record.cjs");
  writeFileSync(script, 'const fs = require("fs"); const [out, label] = process.argv.slice(2);\n'
    + 'fs.appendFileSync(out, JSON.stringify({ label, env: process.env }) + "\\n");\n');
  const node = [process.execPath, script, out].map(shq).join(" ");
  const cmd = (label: string) => `${node} ${shq(label)}`;
  const wrap = join(dir, "wrap.sh");
  writeFileSync(wrap, `exec ${node} "$1"\n`);
  const bashCmd = (label: string) => `bash ${shq(wrap)} ${shq(label)}`;
  let scripts = 0;
  const dispatch = (label: string, tail = "") => {
    const path = join(dir, `dispatch-${scripts++}.sh`);
    writeFileSync(path, `${cmd(label)}\n${tail}`);
    return paneDispatchCommand(path);
  };
  const records = (): ChildRecord[] => existsSync(out)
    ? readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ChildRecord)
    : [];
  return { dir, node, cmd, bashCmd, dispatch, records };
}
type Recorder = ReturnType<typeof recorder>;

/**
 * A HOME whose ONE startup file marks that it ran, hands the sentinel back as `key` says, and puts a `#!/bin/bash` `kimi`
 * shim running the recorder first on PATH, as a user's profile adds a CLI's directory. A fake `kimi` on the front of the
 * parent's PATH labels a shell that skipped the file — so the Kimi CLI itself never runs. The parent's BASH_ENV names the
 * file for a BASH_ENV cell; for a login-file cell it names a file that exports a marker and no key, so no host BASH_ENV
 * leaks into a cell and the kept BASH_ENV is seen.
 */
function homeWith(file: StartupFile, rec: Recorder, key: StartupKey): string {
  const home = makeTestTempDir("agent-env-home-");
  const profileBin = join(home, "profile-bin");
  mkdirSync(profileBin);
  mkdirSync(join(home, "no-env"));
  writeFileSync(join(profileBin, "kimi"), `#!/bin/bash\nexec ${rec.cmd("kimi turn")}\n`, { mode: 0o755 });
  const startupFile = join(home, file === "BASH_ENV" ? "bash-env" : file);
  const keptBashEnv = join(home, "kept-bash-env");
  writeFileSync(keptBashEnv, `export ${BASH_ENV_RAN}=1\n`);
  vi.stubEnv("BASH_ENV", file === "BASH_ENV" ? startupFile : keptBashEnv);
  const keyLines = [`${key.includes("readonly") ? "readonly " : ""}${KEY}=${shq(SENTINEL)}`, `export ${KEY}`];
  writeFileSync(startupFile, [
    `export ${PROFILE_RAN}=${shq(file)}`,
    ...(key === "none" ? [] : keyLines),
    key === "readonly export, env unreachable"
      ? `shopt -s execfail; export PATH=${shq(join(home, "no-env"))}`
      : `export PATH=${shq(profileBin)}:"$PATH"`,
  ].join("\n") + "\n");
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "kimi"), `#!/bin/sh\nexec ${rec.cmd("kimi without the startup file")}\n`, { mode: 0o755 });
  return home;
}

/** A fixture adapter whose every launch command is `command()`: it runs where the agent CLI would. */
function fixtureAdapter(id: string, command: () => string): WorkerAdapter {
  return {
    id, vendor: "fixture",
    channels: (c: TickmarkrConfig) => channelsFromConfig(id, c),
    probe: async () => ({ installed: true, authed: true, models: [] }),
    headlessCommand: () => command(),
    interactiveCommand: () => null,
    invoke: () => ({ command: "unused" }),
    parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
  } as unknown as WorkerAdapter;
}

const withheld = (env: Record<string, string | undefined>) => Object.entries(env).filter(([k, v]) => k === KEY || v?.includes("sk-aa-sentinel-367"));

/** Every spawned shell's command text on the git seam, each then run for real exactly as tickmarkr built it. */
function spawnedCommands(): string[] {
  const commands: string[] = [];
  setSpawnForTests(((command: string, args: readonly string[], options: SpawnOptions) => {
    commands.push(String(args.at(-1)));
    return spawn(command, [...args], options);
  }) as typeof spawn);
  return commands;
}

const SEAT_PROMPTS = [["judge", "TICKMARKR-JUDGE criteria"], ["review", "TICKMARKR-REVIEW diff"], ["consult", "Consult: which route?"]] as const;
// Every agent launch in order, each through its production seam. A pane seed is typed into the pane's own shell after
// its startup files, and the seeded command runs after it in that same shell.
const AGENT_LABELS = [
  "worker", "pane prefix", "terminal payload", "pane seed",
  ...SEAT_PROMPTS.map(([role]) => `seat ${role}`), ...SEAT_PROMPTS.map(([role]) => `driver seat ${role}`),
  "doctor probe", "kimi turn",
];
const PANES = ["pane prefix", "terminal payload", "pane seed"] as const;

/** Every agent child, each through its production launch under `home`, its agent a further bash. Returns the recorder's
 *  captures, the pane shells' exit statuses and stderr, and the worker's output. `started` false is a fail-closed cell:
 *  no launch may start its agent. */
async function launchEveryAgentChild(rec: Recorder, home: string, path: string, started = true) {
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", `${join(home, "bin")}:${path}`);
  // Worker: the subprocess driver's own sealed login shell running the daemon's dispatch line.
  const worker = new SubprocessDriver();
  const slot = await worker.slot(rec.dir, "T1-worker-fake-a0-r");
  await worker.run(slot, rec.dispatch("worker", "printf 'DONE\\n'\n"));
  expect(await worker.waitAgentStatus(slot, "done", 20_000)).toBe(true);
  const workerOut = await worker.read(slot, 50);
  expect(workerOut.includes("DONE")).toBe(started);
  await worker.close(slot);
  // Pane shell prefixes: daemon setup's and an hc terminal's payload, each run by a login shell whose host environment
  // still carries the sentinel (a pane takes its environment from its host, not the daemon's seal) and whose startup
  // file runs before the command; and a herdr pane seed, typed into a login shell reading its terminal (stdin). Each
  // then runs the dispatch line a daemon types or sends after it.
  const bash = (args: string[], input?: string) => spawnSync("bash", args, { cwd: rec.dir, env: process.env, input, encoding: "utf8" });
  const shells = {
    "pane prefix": bash(["-lc", `${herdrSealShellPrefix()}${rec.dispatch("pane prefix")}`]),
    "terminal payload": bash(["-lc", terminalPayload(rec.dispatch("terminal payload"), process.env)]),
    "pane seed": bash(["-ls"], `${herdrSealShellPrefix()}\n${rec.dispatch("pane seed")}\n`),
  };
  const panes = Object.fromEntries(PANES.map((p) => [p, shells[p].status]));
  const stderr = Object.fromEntries(PANES.map((p) => [p, shells[p].stderr]));
  // Seats: judge, review and consult through the headless seat launcher, then through the driver's dispatch script.
  let seat = "";
  const seatAdapter = fixtureAdapter("seats", () => rec.bashCmd(seat));
  for (const [role, prompt] of SEAT_PROMPTS) {
    seat = `seat ${role}`;
    await runHeadless(seatAdapter, "seat-model", prompt, rec.dir, 30_000).catch(() => "");
  }
  for (const [role, prompt] of SEAT_PROMPTS) {
    seat = `driver seat ${role}`;
    // A refused dispatch never prints its exit trailer, so that wait is cut short: the worker above, on the same driver
    // seam, already waited for its shell's real exit.
    await runViaDriver(seatAdapter, "seat-model", prompt, rec.dir, { driver: new SubprocessDriver(), name: `${role}-seat` }, started ? 20_000 : 3_000).catch(() => "");
  }
  // Doctor's model probe (its CLI a bash shim) and the Kimi doctor turn (the profile's `#!/bin/bash` kimi).
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tiers = { probes: { vendor: "fixture", channel: "sub", models: { "probe-model": "mid" } } };
  const health: Record<string, AuthHealth> = { probes: { installed: true, authed: true, models: [] } };
  await probeModels(cfg, makeRepo({ "keep.txt": "x\n" }), [fixtureAdapter("probes", () => rec.bashCmd("doctor probe"))], health);
  expect(health.probes.modelAuth?.["probe-model"]?.authed === true).toBe(started);
  const kimi = await probeKimiDoctorTurn(rec.dir);
  return { records: rec.records(), panes, stderr, workerOut, kimi };
}

/** The same startup file in a payload shell (no agent or seat option), the parent's own copy removed first: it alone
 *  hands the key over, so the cell really exercised a startup file that restores it. */
async function startupFileRestoresKey(rec: Recorder): Promise<string | undefined> {
  const parentWithoutKey = { ...process.env };
  delete parentWithoutKey[KEY];
  await sh(rec.cmd("control"), rec.dir, 30_000, { env: parentWithoutKey });
  return rec.records().at(-1)?.env[KEY];
}

const response = (body: unknown) => ({
  ok: true, status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const MODELS_DEV = { anthropic: { id: "anthropic", models: { "fake-2": { id: "fake-2", cost: { input: 0, output: 0 }, limit: { context: 200_000, output: 32_000 } } } } };
const fetcher = () => vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith(MODELS_DEV_CATALOG_URL)) return response(MODELS_DEV);
  if (url.startsWith(LIVEBENCH_TABLE_URL)) return response("model,javascript\nfake-2,60\n");
  if (url.startsWith(LIVEBENCH_CATEGORIES_URL)) return response({ "Agentic Coding": ["javascript"], Coding: ["javascript"] });
  return response({ pagination: { has_more: false }, data: [] });
});
const aaKeys = (f: ReturnType<typeof fetcher>) => f.mock.calls
  .filter(([url]) => String(url).includes("artificialanalysis.ai"))
  .map(([, init]) => (init?.headers as Record<string, string> | undefined)?.["x-api-key"]);


describe("row 367 child-environment isolation: agents never receive the Artificial Analysis key", () => {
  test("a sentinel key is absent from every captured worker seat pane prefix doctor probe and kimi turn environment", async () => {
    vi.stubEnv(KEY, SENTINEL);
    vi.stubEnv(CANARY, CANARY_VALUE);
    const path = process.env.PATH ?? "";
    // Agents start: each login file's plain and readonly export (with an exported BASH_ENV that exports no key), and a
    // BASH_ENV file that exports no key itself.
    const starting: [StartupFile, StartupKey][] = [
      ...LOGIN_FILES.flatMap((file) => KEY_EXPORTS.map((how): [StartupFile, StartupKey] => [file, how])), ["BASH_ENV", "none"],
    ];
    for (const [file, how] of starting) {
      const cell = `${file} (${how})`;
      const rec = recorder();
      const { records, panes } = await launchEveryAgentChild(rec, homeWith(file, rec, how), path);
      // Control: every named child was captured, each after its startup file — a missing record, or a shell that skipped
      // the file, would make the absence check vacuous. A readonly key stops being exported in a typed pane seed too, so
      // that pane starts its command as well.
      expect(records.map((r) => r.label), cell).toEqual(AGENT_LABELS);
      expect(panes, cell).toEqual({ "pane prefix": 0, "terminal payload": 0, "pane seed": 0 });
      for (const { label, env } of records) {
        expect(withheld(env), `${cell}: ${label}`).toEqual([]);
        expect(env[PROFILE_RAN], `${cell}: ${label}`).toBe(file);
        expect(env[CANARY], `${cell}: ${label}`).toBe(CANARY_VALUE);
        // No other variable is stripped: BASH_ENV reaches every agent byte-equal, and the file it names ran.
        expect(env.BASH_ENV, `${cell}: ${label}`).toBe(process.env.BASH_ENV);
        if (file !== "BASH_ENV") expect(env[BASH_ENV_RAN], `${cell}: ${label}`).toBe("1");
      }
      expect(await startupFileRestoresKey(rec), cell).toBe(how === "none" ? undefined : SENTINEL);
    }
    // Fail closed: when env cannot prove the key gone (env unreachable, execfail on, the key readonly), no agent starts.
    const rec = recorder();
    const failed = await launchEveryAgentChild(rec, homeWith(".bash_profile", rec, "readonly export, env unreachable"), path, false);
    expect(failed.records).toEqual([]);
    expect(failed.panes).toEqual({ "pane prefix": 126, "terminal payload": 126, "pane seed": 126 });
    // Each launch says why, without the key.
    const refusal = "tickmarkr: the Artificial Analysis key is still in the agent's environment, so the agent does not start (queue row 367)";
    for (const pane of PANES) expect(failed.stderr[pane], pane).toContain(refusal);
    expect(failed.workerOut).toContain(refusal);
    expect(failed.kimi).toMatchObject({ ok: false, evidence: expect.stringContaining(refusal) });
    for (const text of [failed.workerOut, failed.kimi.evidence, ...Object.values(failed.stderr)]) expect(text).not.toContain("sk-aa-sentinel-367");
    expect(await startupFileRestoresKey(rec)).toBe(SENTINEL);
    // A BASH_ENV the login file sets WITHOUT exporting reaches no agent, as at the base: the launching shell sources it,
    // the prefix stops exporting the key it exported, and a further bash never sees that BASH_ENV, so it cannot source it.
    const unexported = recorder();
    const home = homeWith("BASH_ENV", unexported, "readonly export");
    vi.stubEnv("HOME", home);
    vi.stubEnv("BASH_ENV", undefined);
    writeFileSync(join(home, ".bash_profile"), `BASH_ENV=${shq(join(home, "bash-env"))}\n`);
    await sh(unexported.bashCmd("unexported BASH_ENV"), unexported.dir, 30_000, { env: agentEnv() });
    const [record] = unexported.records();
    expect(record.label).toBe("unexported BASH_ENV");
    expect([withheld(record.env), record.env.BASH_ENV, record.env[PROFILE_RAN]]).toEqual([[], undefined, "BASH_ENV"]);
    // The pure seals agree, and the pane shell prefix gains the key's unset.
    expect(sealHerdrEnv(process.env)[KEY]).toBeUndefined();
    expect(herdrSealShellPrefix().indexOf(agentEnvShellPrefix())).toBeGreaterThan(0);
    expect(agentShellCommand("x 'y'")).toBe(`${agentEnvShellPrefix()}x 'y'`);
    expect(agentEnvShellPrefix()).toContain(`typeset +x ${KEY} 2>/dev/null || :; ( unset ${KEY} ) 2>/dev/null && unset ${KEY}; `);
    expect([...AGENT_WITHHELD_VARS]).toEqual([KEY]);
    // The helper copies and tags its copy: its input and the daemon's own environment keep the key and stay untagged.
    const input = { [KEY]: SENTINEL, [CANARY]: CANARY_VALUE };
    const copy = agentEnv(input);
    expect(copy).toEqual({ [CANARY]: CANARY_VALUE });
    expect([isAgentEnv(copy), isAgentEnv(input), isAgentEnv(process.env), isAgentEnv({ ...copy })]).toEqual([true, false, false, false]);
    expect(input[KEY]).toBe(SENTINEL);
    expect(process.env[KEY]).toBe(SENTINEL);
  }, 600_000);

  test("a profile-defined agent function the variables it reads and an alias resolve exactly as at the base whether or not the profile exports the key", async () => {
    vi.stubEnv(KEY, SENTINEL);
    vi.stubEnv(CANARY, CANARY_VALUE);
    vi.stubEnv("BASH_ENV", undefined);
    const path = process.env.PATH ?? "";
    for (const how of ["none", "readonly export", "readonly export under set -u"] as const) {
      const rec = recorder();
      const home = makeTestTempDir("agent-env-functions-");
      const fallback = join(home, "bin");
      mkdirSync(fallback);
      // A hermetic `kimi` executable the profile's function shadows: a shell that bypassed the function answers NOT-OK.
      writeFileSync(join(fallback, "kimi"), "#!/bin/sh\necho NOT-OK\n", { mode: 0o755 });
      // Non-exported functions, the non-exported variable they read and an alias, as a user's profile defines them:
      // none of them is in any environment, so a shell that dropped them answers otherwise (or exits, under set -u).
      writeFileSync(join(home, ".bash_profile"), [
        ...(how.endsWith("set -u") ? ["set -u"] : []),
        "agent_answer=OK",
        `fake_agent() { ${rec.node} "$1"; printf 'AGENT_OK %s %s\\n' "$1" "$agent_answer"; }`,
        "kimi() { printf '%s\\n' \"$agent_answer\"; }",
        "shopt -s expand_aliases",
        "alias fake_alias='fake_agent alias'",
        ...(how === "none" ? [] : [`readonly ${KEY}=${shq(SENTINEL)}`, `export ${KEY}`]),
      ].join("\n") + "\n");
      vi.stubEnv("HOME", home);
      vi.stubEnv("PATH", `${fallback}:${path}`);
      const lines = (stdout: string) => stdout.trim().split("\n");
      // The base: a payload shell, which tickmarkr leaves exactly as it was, resolves both and keeps the key.
      const base = await sh("fake_agent base; fake_alias", rec.dir, 30_000);
      expect([base.code, lines(base.stdout)], how).toEqual([0, ["AGENT_OK base OK", "AGENT_OK alias OK"]]);
      expect(rec.records().map((r) => [r.label, r.env[KEY]]), how).toEqual([["base", SENTINEL], ["alias", SENTINEL]]);
      const before = rec.records().length;
      // Every agent seam resolves them the same way: the agent and seat shells, a probe's agentEnv() copy, the worker.
      for (const [name, options] of [["agent", { agent: true }], ["seat", { seat: "judge" as const }], ["probe-env", { env: agentEnv() }]] as const) {
        const r = await sh(`fake_agent ${name}; fake_alias`, rec.dir, 30_000, options);
        expect([r.code, lines(r.stdout)], `${how}: ${name}`).toEqual([0, [`AGENT_OK ${name} OK`, "AGENT_OK alias OK"]]);
      }
      const worker = new SubprocessDriver();
      const slot = await worker.slot(rec.dir, "T1-worker-fake-a0-r");
      await worker.run(slot, "fake_agent worker; printf 'DONE\\n'");
      expect(await worker.waitOutput(slot, "DONE", 20_000), how).toBe(true);
      expect(await worker.read(slot, 50), how).toContain("AGENT_OK worker OK");
      await worker.close(slot);
      // Doctor's model probe and the Kimi doctor turn, each backed by a profile function.
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.tiers = { probes: { vendor: "fixture", channel: "sub", models: { "probe-model": "mid" } } };
      const health: Record<string, AuthHealth> = { probes: { installed: true, authed: true, models: [] } };
      await probeModels(cfg, makeRepo({ "keep.txt": "x\n" }), [fixtureAdapter("probes", () => "fake_agent 'doctor probe'")], health);
      expect(health.probes.modelAuth?.["probe-model"]?.authed, how).toBe(true);
      expect(await probeKimiDoctorTurn(rec.dir), how).toMatchObject({ ok: true });
      // And none of those agents received the key.
      const agents = rec.records().slice(before);
      expect(agents.map((r) => r.label), how).toEqual(["agent", "alias", "seat", "alias", "probe-env", "alias", "worker", "doctor probe"]);
      for (const { label, env } of agents) {
        expect(withheld(env), `${how}: ${label}`).toEqual([]);
        expect(env[CANARY], `${how}: ${label}`).toBe(CANARY_VALUE);
      }
    }
  }, 120_000);

  test("build test lint and oracle commands keep the sentinel key exactly as at the base", async () => {
    const rec = recorder();
    // The startup file runs (and marks it) but exports no key: what a payload carries is the parent's own value.
    const home = homeWith(".bash_profile", rec, "none");
    vi.stubEnv("HOME", home);
    vi.stubEnv(KEY, SENTINEL);
    vi.stubEnv(CANARY, CANARY_VALUE);
    const commands = spawnedCommands();
    // The gates' own production calls: the baseline capture runs build, test and lint; the oracle sweep runs a command
    // oracle exactly as the acceptance gate does (sh(command, cwd), neither the agent nor the seat option).
    const payload = { build: rec.cmd("build"), test: rec.cmd("test"), lint: rec.cmd("lint"), oracle: rec.cmd("oracle") };
    await captureBaseline(rec.dir, { build: payload.build, test: payload.test, lint: payload.lint });
    await detectVacuousOracles(rec.dir, [{ id: "T1", acceptance: [{ oracle: "command", command: payload.oracle }] }]);
    resetSpawnForTests();
    // The payload path is untouched: each shell runs the command text verbatim, with no unset in front of it.
    expect(commands).toEqual([payload.build, payload.test, payload.lint, payload.oracle]);
    const records = rec.records();
    expect(records.map((r) => r.label)).toEqual(["build", "test", "lint", "oracle"]);
    for (const { label, env } of records) {
      expect(env[KEY], label).toBe(SENTINEL);
      expect(env[CANARY], label).toBe(CANARY_VALUE);
      expect(env[PROFILE_RAN], label).toBe(".bash_profile");
    }
  }, 120_000);

  test("the parent lookup and catalog fetch still read the sentinel key", async () => {
    vi.stubEnv(KEY, SENTINEL);
    // The parent's lookups, shared and command-scoped, read it from the environment.
    expect(lookupArtificialAnalysisKey({ platform: "linux" })).toEqual({ ok: true, key: SENTINEL.trim(), source: "environment" });
    expect(lookupCommandKey(process.env, { platform: "linux" })).toEqual({ ok: true, key: SENTINEL.trim(), source: "environment" });
    // An agent child's environment is built beside it, never from it: the parent still holds the key afterwards.
    expect(agentEnv()[KEY]).toBeUndefined();
    expect(process.env[KEY]).toBe(SENTINEL);
    // The in-process catalog fetch sends it: the shared refresh's own lookup, and doctor's and init's asked-key refresh.
    const shared = fetcher();
    const refreshed = await refreshCatalogCommand({ repoRoot: makeRepo({ "keep.txt": "x\n" }), fetcher: shared, keyLookup: { platform: "linux" } });
    expect(aaKeys(shared)).toEqual([SENTINEL.trim()]);
    expect(refreshed.legs.find((leg) => leg.leg === "Artificial Analysis")?.status).toBe("updated");
    const asked = await askArtificialAnalysisKey([], { stdinIsTTY: false, stdoutIsTTY: false, keyLookup: { platform: "linux" } });
    expect(asked).toMatchObject({ prompted: false, key: SENTINEL.trim() });
    const command = fetcher();
    await refreshCatalogWithAskedKey({ repoRoot: makeRepo({ "keep.txt": "x\n" }), fetcher: command }, asked);
    expect(aaKeys(command)).toEqual([SENTINEL.trim()]);
  });
});
