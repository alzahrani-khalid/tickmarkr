// Queue row 367 Phase 2; D-2187 add.18, add.21 (1): the secrecy task's ask-key rows. A failed Keychain save or confirming
// re-read names its reason, keeps the entered key for that command only and never re-prompts; and across every path —
// lookup, entered key, save, skip and failure — the key reaches no spawned argv, log, doctor cache, journal, error or
// screen. Every cell runs through doctor's command entry point with the TTY, platform, Keychain seams, spawner and fetcher
// injected; the Keychain read is the production reader (readKeychainKey) over a recording `security` stand-in.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import {
  ARTIFICIAL_ANALYSIS_KEY_NAME,
  LIVEBENCH_CATEGORIES_URL,
  LIVEBENCH_TABLE_URL,
  MODELS_DEV_CATALOG_URL,
  readKeychainKey,
  type KeychainSpawnResult,
} from "../../src/adapters/catalog-remote.js";
import { ARTIFICIAL_ANALYSIS_KEY_PROMPT, ARTIFICIAL_ANALYSIS_SAVE_PROMPT, type AskKeyOptions } from "../../src/cli/ask-keys.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { resetSpawnForTests, setSpawnForTests } from "../../src/run/git.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetSpawnForTests();
});

const ACCOUNT = "row367-secrecy-tester";
// Plain characters only: an escaped copy (JSON, shell quoting) of a key with quotes would hide from a byte search.
const KEY = "sk-secrecy-367-7f3a9c";
const SAVED_LINE = "Artificial Analysis key saved to the macOS Keychain (confirmed by a re-read)";
const notSaved = (reason: string) => `Artificial Analysis key not saved: ${reason} — used for this command only\n`;

const response = (body: unknown) => ({
  ok: true, status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const MODELS_DEV = { anthropic: { id: "anthropic", models: { "fake-2": { id: "fake-2", cost: { input: 0, output: 0 }, limit: { context: 200_000, output: 32_000 } } } } };
/** The catalog's fetcher; `aaFails` makes the Artificial Analysis leg reject with an error that echoes the key. */
const fetcher = (aaFails = false) => vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith(MODELS_DEV_CATALOG_URL)) return response(MODELS_DEV);
  if (url.startsWith(LIVEBENCH_TABLE_URL)) return response("model,javascript\nfake-2,60\n");
  if (url.startsWith(LIVEBENCH_CATEGORIES_URL)) return response({ "Agentic Coding": ["javascript"], Coding: ["javascript"] });
  if (aaFails) throw new Error(`401 rejected x-api-key ${(init?.headers as Record<string, string> | undefined)?.["x-api-key"]}`);
  return response({ pagination: { has_more: false }, data: [] });
});
/** The x-api-key each Artificial Analysis request carried: the key the command actually used. */
const aaKeys = (f: ReturnType<typeof fetcher>) => f.mock.calls
  .filter(([url]) => String(url).includes("artificialanalysis.ai"))
  .map(([, init]) => (init?.headers as Record<string, string> | undefined)?.["x-api-key"]);

const answers = (...replies: string[]) => {
  const queue = [...replies];
  return vi.fn(async (_prompt: string) => queue.shift() ?? "");
};

/** Every spawned child's argv as ps would show it: the Keychain reads, the Keychain save, and any shell child. */
type Argv = string[];

/**
 * The macOS Keychain behind the PRODUCTION reader: readKeychainKey spawns a recording `security find-generic-password`
 * stand-in. `reads` scripts each read in turn (absent = the store's truth): exit 44 is no item; any other code, or
 * `spawn-error`, is a failed read.
 */
function keychain(argv: Argv[], reads: ("store" | number | "spawn-error")[] = []) {
  const store: { item?: string; account?: string } = {};
  const script = [...reads];
  const spawner = (command: "security", args: readonly string[]): KeychainSpawnResult => {
    argv.push([command, ...args]);
    const step = script.shift() ?? "store";
    if (step === "spawn-error") return { status: null, stdout: "", error: { code: "ENOENT" } };
    if (typeof step === "number") return { status: step, stdout: "" };
    return store.item !== undefined && args.includes(store.account ?? "") ? { status: 0, stdout: `${store.item}\n` } : { status: 44, stdout: "" };
  };
  const keychainReader = vi.fn((account: string) => readKeychainKey(account, spawner));
  return { store, keychainReader, lookup: { platform: "darwin" as NodeJS.Platform, account: ACCOUNT, keychainReader } };
}

type SaveMode = { exit?: number; throws?: string; emits?: string; storeNothing?: boolean; echo?: boolean };

/** A `security -q -i` stand-in on the save's production spawn seam. It executes the ONE allowed command line at end of
 *  file and exits 0 — unless told to exit nonzero, throw or emit a spawn error. `echo` writes the received stdin (key
 *  included) back on stdout and stderr, as a chatty failing binary might, to prove those streams are never shown. */
function fakeSecurity(argv: Argv[], store: { item?: string; account?: string }, mode: SaveMode = {}) {
  const stdins: string[] = [];
  const spawnSave = vi.fn((command: string, args: readonly string[], _options: SpawnOptions) => {
    argv.push([command, ...args]);
    if (mode.throws) throw Object.assign(new Error(`spawn ${command} ${mode.throws}`), { code: mode.throws });
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    if (mode.emits) {
      setImmediate(() => child.emit("error", Object.assign(new Error(`spawn ${command} ${mode.emits}`), { code: mode.emits })));
      setImmediate(() => child.emit("close", null, null));
    }
    let received = "";
    const stdin = new Writable({
      write(chunk, _encoding, done) {
        received += String(chunk);
        done();
      },
      final(done) {
        stdins.push(received);
        const line = /^add-generic-password -U -a "((?:[^"\\]|\\.)*)" -s ARTIFICIAL_ANALYSIS_API_KEY -w "((?:[^"\\]|\\.)*)"\n$/.exec(received);
        if (line && !mode.storeNothing && !mode.exit && !mode.emits) {
          store.account = line[1].replace(/\\(.)/g, "$1");
          store.item = line[2].replace(/\\(.)/g, "$1");
        }
        if (mode.echo) {
          stdout.write(received);
          stderr.write(`security: ${received}`);
        }
        done();
        if (!mode.emits) setImmediate(() => child.emit("close", line ? mode.exit ?? 0 : 1, null));
      },
    });
    return Object.assign(child, { stdin, stdout, stderr }) as unknown as ChildProcess;
  });
  return { spawnSave, stdins };
}

function terminalOut() {
  const writes: string[] = [];
  return { writes, output: { isTTY: true, write: (chunk: string) => { writes.push(String(chunk)); return true; } } as unknown as NodeJS.WriteStream };
}

/** Every interactive condition holds: both TTYs, no JSON flag, no CI, no seat marker, a cwd outside any task checkout. */
const INTERACTIVE = { stdinIsTTY: true, stdoutIsTTY: true, env: {} } satisfies AskKeyOptions;

/** Every log and screen sink a command can reach: console, the process streams. */
function screens() {
  const lines: string[] = [];
  const sink = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  for (const name of ["log", "error", "warn", "info"] as const) vi.spyOn(console, name).mockImplementation(sink);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  return lines;
}

/** Every file the command left under a directory: the doctor cache, the catalog cache and any journal. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((rel) => join(dir, rel))
    .filter((path) => statSync(path).isFile())
    .map((path) => `${path}\n${readFileSync(path, "utf8")}`);
}

/** doctor through its full probe path (no adapters, no host binaries; it writes doctor.json and refreshes the stale
 *  catalog), or through its catalog-only entry point. Any shell child's argv is captured on the git seam, then run. */
async function runDoctor(repo: string, askKey: AskKeyOptions, argv: Argv[], f = fetcher(), flags: string[] = []) {
  setSpawnForTests(((command: string, args: readonly string[], options: SpawnOptions) => {
    argv.push([command, ...args]);
    return spawn(command, [...args], options);
  }) as typeof spawn);
  const globalDir = makeTestTempDir("ask-keys-secrecy-global-");
  if (flags.length) {
    const out = await doctor(flags, repo, [], { catalogFetcher: f, catalogNow: () => new Date(), askKey });
    return { out, keys: aaKeys(f), globalDir };
  }
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
  const out = await doctor([], repo, [], {
    banner: false, globalDir, catalogFetcher: f, catalogNow: () => new Date(),
    resolveClaudeAliasIdentity: () => undefined, resolveOrcaBinary: () => undefined,
    resolveHcBinary: () => undefined, resolveHerdrAppBinary: () => undefined, askKey,
  });
  return { out, keys: aaKeys(f), globalDir };
}

describe("row 367 Phase 2 secrecy: failed saves fall back once and the key never leaves the parent", () => {
  test("a failed save or confirming re-read from a nonzero exit or spawn error gives its reason uses the key for that command only and never asks again", async () => {
    const lines = screens();
    // The closed failure list: the save's nonzero exit, its synchronous spawn throw, its emitted spawn error; the
    // confirming re-read's nonzero exit, its spawn error, and a re-read that misses (the save exits 0, nothing stored).
    const CELLS: { name: string; save: SaveMode; reads: ("store" | number | "spawn-error")[]; reason: string }[] = [
      { name: "save exits nonzero", save: { exit: 1, echo: true }, reads: [], reason: "security exited 1" },
      { name: "save spawn throws", save: { throws: "EACCES" }, reads: [], reason: "security could not be started (EACCES)" },
      { name: "save spawn error event", save: { emits: "ENOENT" }, reads: [], reason: "security could not be started (ENOENT)" },
      { name: "re-read exits nonzero", save: {}, reads: [44, 36], reason: "the confirming Keychain re-read failed (exit 36)" },
      { name: "re-read spawn error", save: {}, reads: [44, "spawn-error"], reason: "the confirming Keychain re-read failed (exit ENOENT)" },
      { name: "re-read misses", save: { storeNothing: true }, reads: [], reason: "the confirming Keychain re-read did not find it" },
    ];
    for (const cell of CELLS) {
      const argv: Argv[] = [];
      const repo = makeRepo({ "keep.txt": "x\n" });
      const kc = keychain(argv, cell.reads);
      const security = fakeSecurity(argv, kc.store, cell.save);
      const term = terminalOut();
      const read = answers(KEY, "y", KEY, "y", KEY);
      const run = await runDoctor(repo, { ...INTERACTIVE, output: term.output, keyLookup: kc.lookup, readHidden: read, spawn: security.spawnSave }, argv, fetcher(), ["--refresh-catalog"]);
      // Its reason, once, without the key; never the saved line.
      expect(term.writes, cell.name).toEqual([notSaved(cell.reason)]);
      expect(term.writes.join(""), cell.name).not.toContain(SAVED_LINE);
      // Never asks again: one key prompt and one save prompt, then the command returns — no re-prompt, no second save.
      expect(read.mock.calls, cell.name).toEqual([[ARTIFICIAL_ANALYSIS_KEY_PROMPT], [ARTIFICIAL_ANALYSIS_SAVE_PROMPT]]);
      expect(security.spawnSave, cell.name).toHaveBeenCalledTimes(1);
      // The entered key serves this command: the catalog's Artificial Analysis leg fetched with it.
      expect(run.keys, cell.name).toEqual([KEY]);
      // For this command only: nothing confirmed in the Keychain (a miss stores nothing), no skip record, so the next
      // interactive doctor asks again from a clean start rather than inheriting a half-saved state.
      if (cell.save.exit || cell.save.throws || cell.save.emits || cell.save.storeNothing) expect(kc.store, cell.name).toEqual({});
      const cache = join(tickmarkrDir(repo), "doctor.json");
      expect(existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")).aaKeyPrompt : undefined, cell.name).toBeUndefined();
      for (const bytes of [term.writes.join(""), run.out, ...filesUnder(tickmarkrDir(repo)), JSON.stringify(argv)]) {
        expect(bytes, cell.name).not.toContain(KEY);
      }
    }
    expect(lines.join("\n")).not.toContain(KEY);
    // Control: the same seams with a save that succeeds report it saved, so the failure lines above are not a default.
    const argv: Argv[] = [];
    const kc = keychain(argv);
    const security = fakeSecurity(argv, kc.store);
    const term = terminalOut();
    await runDoctor(makeRepo({ "keep.txt": "x\n" }), { ...INTERACTIVE, output: term.output, keyLookup: kc.lookup, readHidden: answers(KEY, "y"), spawn: security.spawnSave }, argv, fetcher(), ["--refresh-catalog"]);
    expect(term.writes).toEqual([`${SAVED_LINE}\n`]);
    expect(kc.store).toEqual({ item: KEY, account: ACCOUNT });
  });

  test("across lookup entered key save skip and failure paths the key appears in no argv log doctor cache journal error or screen output", async () => {
    // The closed path list. Each runs doctor's full probe path (doctor.json written, the stale catalog refreshed) with
    // every log and screen sink captured; `used` is the control that the key was really in play on that path.
    type Path = { name: string; env?: Record<string, string>; reads?: ("store" | number | "spawn-error")[]; seed?: boolean;
      platform?: NodeJS.Platform; replies: string[]; save?: SaveMode; aaFails?: boolean; used: boolean };
    const PATHS: Path[] = [
      { name: "lookup: environment", env: { [ARTIFICIAL_ANALYSIS_KEY_NAME]: KEY }, replies: [], used: true },
      { name: "lookup: Keychain", seed: true, replies: [], used: true },
      { name: "lookup: failed Keychain read", reads: [36], replies: [], used: false },
      { name: "entered key off darwin", platform: "linux", replies: [KEY], used: true },
      { name: "entered key, a no", replies: [KEY, "n"], used: true },
      { name: "save confirmed", replies: [KEY, "y"], used: true },
      { name: "skip", replies: [""], used: false },
      { name: "failure: save exits nonzero, echoing its stdin", replies: [KEY, "y"], save: { exit: 1, echo: true }, used: true },
      { name: "failure: re-read fails", reads: [44, 36], replies: [KEY, "y"], used: true },
      { name: "error: the catalog fetch rejects echoing the key", env: { [ARTIFICIAL_ANALYSIS_KEY_NAME]: KEY }, replies: [], aaFails: true, used: true },
    ];
    for (const path of PATHS) {
      const lines = screens();
      const argv: Argv[] = [];
      const repo = makeRepo({ "keep.txt": "x\n" });
      const kc = keychain(argv, path.reads);
      if (path.seed) Object.assign(kc.store, { item: KEY, account: ACCOUNT });
      const security = fakeSecurity(argv, kc.store, path.save);
      const term = terminalOut();
      const f = fetcher(path.aaFails);
      const run = await runDoctor(repo, {
        ...INTERACTIVE, env: path.env ?? {}, output: term.output, readHidden: answers(...path.replies), spawn: security.spawnSave,
        keyLookup: { ...kc.lookup, platform: path.platform ?? "darwin" }, now: () => new Date("2026-11-09T10:00:00.000Z"),
      }, argv, f);
      vi.restoreAllMocks();
      // Control: the key was in play — the fetch carried it (or the path never had one), and a save sent it on stdin only.
      expect(run.keys, path.name).toEqual(path.used ? [KEY] : []);
      if (path.save || path.name === "save confirmed") expect(security.stdins.join(""), path.name).toContain(KEY);
      // Every spawned child's argv (Keychain reads, the save, any shell child) carries names only. Control: on darwin
      // without an environment key the production Keychain read really ran, so the argv capture is not empty by default.
      if ((path.platform ?? "darwin") === "darwin" && !path.env) {
        expect(argv.some(([command, sub]) => command === "security" && sub === "find-generic-password"), path.name).toBe(true);
      }
      expect(JSON.stringify(argv), path.name).not.toContain(KEY);
      // Every log and screen line, doctor's own output (errors and leg details included), the prompt's terminal, and
      // every file it wrote — doctor.json, the catalog cache, any journal — under the workspace and the global directory.
      const sinks = { screen: lines.join("\n"), out: run.out, terminal: term.writes.join(""),
        files: [...filesUnder(tickmarkrDir(repo)), ...filesUnder(run.globalDir)].join("\n") };
      for (const [sink, bytes] of Object.entries(sinks)) expect(bytes, `${path.name}: ${sink}`).not.toContain(KEY);
      expect(sinks.files, path.name).toContain("doctor.json");
      if (path.aaFails) expect(sinks.out, path.name).toContain("[redacted]");
    }
  });
});
