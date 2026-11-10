// Queue row 367 Phase 2; D-2187 add.18, add.20, add.21: the ask-once prompt's skip and save rows. Enter records the skip
// in doctor.json (never the key) and the next doctor honours it; `doctor --ask-keys` asks again; on darwin a yes saves
// through `security -q -i` with one escaped command on stdin then end of file, confirmed by a re-read through the lookup;
// a no stores nothing; off darwin the key serves that command only and the environment recipe is shown. Every cell runs
// through doctor's (or init's) command entry point with the TTY, platform, Keychain reader, spawner and clock injected.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import {
  ARTIFICIAL_ANALYSIS_KEY_NAME,
  LIVEBENCH_CATEGORIES_URL,
  LIVEBENCH_TABLE_URL,
  MODELS_DEV_CATALOG_URL,
  type KeychainReadResult,
} from "../../src/adapters/catalog-remote.js";
import {
  ARTIFICIAL_ANALYSIS_ENV_RECIPE,
  ARTIFICIAL_ANALYSIS_KEY_PROMPT,
  ARTIFICIAL_ANALYSIS_SAVE_PROMPT,
  type AskKeyOptions,
} from "../../src/cli/ask-keys.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { init } from "../../src/cli/commands/init.js";
import { COMMAND_HELP } from "../../src/cli/help.js";
import { dispatch } from "../../src/cli/index.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const ACCOUNT = "row367-save-tester";
const MISSING_LINE = `no Artificial Analysis key: ${ARTIFICIAL_ANALYSIS_KEY_NAME} unset and no Keychain item ${ARTIFICIAL_ANALYSIS_KEY_NAME} for ${ACCOUNT} — set it with: security add-generic-password -a "$USER" -s ${ARTIFICIAL_ANALYSIS_KEY_NAME} -w`;
const SAVED_LINE = "Artificial Analysis key saved to the macOS Keychain (confirmed by a re-read)";
const SKIPPED_AT = "2026-11-09T10:00:00.000Z";
const now = (iso = SKIPPED_AT) => () => new Date(iso);

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
/** The x-api-key each Artificial Analysis request carried: the key the command actually used. */
const aaKeys = (f: ReturnType<typeof fetcher>) => f.mock.calls
  .filter(([url]) => String(url).includes("artificialanalysis.ai"))
  .map(([, init]) => new Headers(init?.headers).get("x-api-key"));

const stderr = () => vi.spyOn(console, "error").mockImplementation(() => {});
const printed = (spy: ReturnType<typeof stderr>) => spy.mock.calls.map((c) => c.join(" "));
const blockingReader = () => vi.fn((_prompt: string) => new Promise<string>(() => {}));
const BLOCKED = Symbol("blocked");
const withinBound = <T>(work: Promise<T>) =>
  Promise.race([work, new Promise<typeof BLOCKED>((done) => setTimeout(() => done(BLOCKED), 20_000))]);
/** A hidden reader answering each prompt in turn. */
const answers = (...replies: string[]) => {
  const queue = [...replies];
  return vi.fn(async (_prompt: string) => queue.shift() ?? "");
};

/** The macOS Keychain as `security -i` would leave it, read back through the lookup's injected reader. */
function keychain(platform: NodeJS.Platform = "darwin", account = ACCOUNT) {
  const store: { item?: string; account?: string } = {};
  const reads: KeychainReadResult[] = [];
  const keychainReader = vi.fn((asked: string): KeychainReadResult => {
    const read: KeychainReadResult = { ok: true, ...(store.item !== undefined && asked === store.account ? { key: store.item } : {}) };
    reads.push(read);
    return read;
  });
  return { store, reads, keychainReader, lookup: { platform, account, keychainReader } };
}

/** A `security` stand-in on the production spawn seam: it records argv and stdin and, at end of file, executes the ONE
 *  command line the contract allows, unescaping the quoted values as security does. Anything else stores nothing. */
function fakeSecurity(store: { item?: string; account?: string }, opts: { storeNothing?: boolean } = {}) {
  const calls: { command: string; args: string[]; options: SpawnOptions; stdin: string; ended: boolean }[] = [];
  const spawn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new EventEmitter();
    const call = { command, args: [...args], options, stdin: "", ended: false };
    calls.push(call);
    const stdin = new Writable({
      write(chunk, _encoding, done) {
        call.stdin += String(chunk);
        done();
      },
      final(done) {
        call.ended = true;
        const line = /^add-generic-password -U -a "((?:[^"\\]|\\.)*)" -s ARTIFICIAL_ANALYSIS_API_KEY -w "((?:[^"\\]|\\.)*)"\n$/.exec(call.stdin);
        if (line && !opts.storeNothing) {
          store.account = line[1].replace(/\\(.)/g, "$1");
          store.item = line[2].replace(/\\(.)/g, "$1");
        }
        done();
        setImmediate(() => child.emit("close", line ? 0 : 1));
      },
    });
    return Object.assign(child, { stdin, stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcess;
  });
  return { spawn, calls };
}

function terminalOut() {
  const writes: string[] = [];
  return { writes, output: { isTTY: true, write: (chunk: string) => { writes.push(String(chunk)); return true; } } as unknown as NodeJS.WriteStream };
}

/** Every interactive condition holds: both TTYs, no JSON flag, no CI, no seat marker, a cwd outside any task checkout. */
const INTERACTIVE = { stdinIsTTY: true, stdoutIsTTY: true, env: {} } satisfies AskKeyOptions;

/** doctor's full probe path, cheap: no adapters, no host binaries; it rewrites doctor.json, and a stale catalog refreshes. */
async function doctorFull(repo: string, askKey: AskKeyOptions, argv: string[] = []) {
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
  const f = fetcher();
  const out = await doctor(argv, repo, [], {
    banner: false, globalDir: makeTestTempDir("ask-keys-save-global-"), catalogFetcher: f, catalogNow: () => new Date(),
    resolveClaudeAliasIdentity: () => undefined, resolveOrcaBinary: () => undefined,
    resolveHcBinary: () => undefined, resolveHerdrAppBinary: () => undefined, askKey,
  });
  return { out, keys: aaKeys(f) };
}

async function doctorCatalog(repo: string, askKey: AskKeyOptions, flag: "--refresh-catalog" | "--catalog-only" = "--refresh-catalog") {
  const f = fetcher();
  const out = await doctor([flag], repo, [], { catalogFetcher: f, catalogNow: () => new Date(), askKey });
  // The raw header value: a key with a control byte is not a valid Headers value, so it is read as sent.
  const raw = f.mock.calls.filter(([url]) => String(url).includes("artificialanalysis.ai"))
    .map(([, init]) => (init?.headers as Record<string, string> | undefined)?.["x-api-key"]);
  return { out, keys: raw };
}

/** init with a fresh doctor.json, so init reuses it and makes no doctor call of its own. */
function initReusing(repo: string, askKey: AskKeyOptions) {
  vi.spyOn(registry, "allAdapters").mockReturnValue([]);
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
  vi.spyOn(registry, "probeModels").mockResolvedValue();
  vi.spyOn(registry, "probeAll").mockResolvedValue({});
  return init(["--global-dir", makeTestTempDir("ask-keys-save-init-"), "--yes"], repo, { askKey });
}

const doctorPath = (repo: string) => join(tickmarkrDir(repo), "doctor.json");
const doctorJson = (repo: string) => (existsSync(doctorPath(repo)) ? readFileSync(doctorPath(repo), "utf8") : "");
const record = (repo: string): unknown => (doctorJson(repo) ? JSON.parse(doctorJson(repo)).aaKeyPrompt : undefined);

describe("row 367 Phase 2: the ask-once prompt's skip and save rows", () => {
  test("enter records the skip in the doctor cache without the key and the next doctor does not ask", async () => {
    const err = stderr();
    const repo = makeRepo({ "keep.txt": "x\n" });
    const kc = keychain();
    const enter = answers("");
    await doctorFull(repo, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: enter, now: now() });
    expect(enter.mock.calls).toEqual([[ARTIFICIAL_ANALYSIS_KEY_PROMPT]]);
    // The record is the skip time alone, written after doctor's own rewrite of doctor.json.
    expect(record(repo)).toEqual({ skippedAt: SKIPPED_AT });
    expect(JSON.parse(doctorJson(repo))).toHaveProperty(["aaKeyPrompt"]);
    // The next doctor, its catalog entry point and init in this workspace never ask, and each keeps the record.
    for (const [name, run] of [
      ["doctor", (askKey: AskKeyOptions) => doctorFull(repo, askKey)],
      ["doctor again", (askKey: AskKeyOptions) => doctorFull(repo, askKey)],
      ["doctor --refresh-catalog", (askKey: AskKeyOptions) => doctorCatalog(repo, askKey)],
      ["init", (askKey: AskKeyOptions) => initReusing(repo, askKey)],
    ] as const) {
      err.mockClear();
      const read = blockingReader();
      expect(await withinBound(run({ ...INTERACTIVE, keyLookup: kc.lookup, readHidden: read, now: now("2026-11-10T00:00:00.000Z") })), name).not.toBe(BLOCKED);
      expect(read, name).not.toHaveBeenCalled();
      expect(printed(err), name).toContain(MISSING_LINE);
      expect(record(repo), name).toEqual({ skippedAt: SKIPPED_AT });
    }
    // init's Enter on a reused cache records the skip WITHOUT touching the cache's age (its mtime), so init still reuses it.
    const reused = makeRepo({ "keep.txt": "x\n" });
    registry.writeDoctor(reused, { fake: { installed: true, authed: true, models: [] } });
    const when = new Date(Date.now() - 5 * 60_000);
    utimesSync(doctorPath(reused), when, when);
    const initEnter = answers("");
    expect(await initReusing(reused, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: initEnter, now: now() })).toContain("using probe results from 5m ago");
    expect(initEnter).toHaveBeenCalledTimes(1);
    expect(record(reused)).toEqual({ skippedAt: SKIPPED_AT });
    expect(statSync(doctorPath(reused)).mtimeMs).toBe(when.getTime());
    expect(JSON.parse(doctorJson(reused)).fake).toEqual({ installed: true, authed: true, models: [] });
    const next = blockingReader();
    expect(await withinBound(doctorFull(reused, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: next }))).not.toBe(BLOCKED);
    expect(next).not.toHaveBeenCalled();
    // Control: an unreadable record never proves a skip, so the prompt is shown.
    for (const bad of ["yes", { skippedAt: "not a time" }, { skippedAt: 5 }, null]) {
      const cell = makeRepo({ "keep.txt": "x\n" });
      registry.writeDoctor(cell, { fake: { installed: true, authed: true, models: [] } });
      writeFileSync(doctorPath(cell), JSON.stringify({ ...JSON.parse(doctorJson(cell)), aaKeyPrompt: bad }));
      const read = answers("");
      await doctorCatalog(cell, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: read, now: now() });
      expect(read, JSON.stringify(bad)).toHaveBeenCalledTimes(1);
      expect(record(cell), JSON.stringify(bad)).toEqual({ skippedAt: SKIPPED_AT });
    }
    expect(kc.keychainReader.mock.calls.every(([account]) => account === ACCOUNT)).toBe(true);
  });

  test("enter at either catalog entry point records the skip whatever doctor.json held, and a skip-only record never reads as a probed doctor cache", async () => {
    stderr();
    const kc = keychain("linux");
    const FLAGS = ["--refresh-catalog", "--catalog-only"] as const;
    const REPORT = { fake: { installed: true, authed: true, models: [] } };
    // The closed list of what the workspace held before the Enter: no state directory, no doctor.json, malformed JSON,
    // JSON null, a JSON array, a JSON scalar, and a doctor report (the control, merged in place).
    const CACHES: [name: string, initial: string | typeof REPORT | undefined, stateDir: boolean][] = [
      ["no state directory", undefined, false], ["absent", undefined, true], ["malformed", "{", true],
      ["null", "null", true], ["array", "[]", true], ["scalar", "7", true], ["report", REPORT, true],
    ];
    for (const flag of FLAGS) {
      for (const [name, initial, stateDir] of CACHES) {
        const cell = `${flag} over ${name}`;
        const repo = makeRepo({ "keep.txt": "x\n" });
        if (stateDir) tickmarkrDir(repo);
        if (typeof initial === "string") writeFileSync(doctorPath(repo), initial);
        else if (initial) registry.writeDoctor(repo, initial);
        const reportTime = new Date(Date.now() - 5 * 60_000);
        if (initial === REPORT) utimesSync(doctorPath(repo), reportTime, reportTime);
        const enter = answers("");
        await doctorCatalog(repo, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: enter, now: now() }, flag);
        expect(enter, cell).toHaveBeenCalledTimes(1);
        // The next doctor at either catalog entry point does not ask.
        for (const next of FLAGS) {
          const read = answers("");
          await doctorCatalog(repo, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: read, now: now("2026-11-10T00:00:00.000Z") }, next);
          expect(read, `${cell}, then ${next}`).not.toHaveBeenCalled();
        }
        if (initial === REPORT) {
          expect(record(repo), cell).toEqual({ skippedAt: SKIPPED_AT });
          expect(registry.readDoctor(repo)?.fake, cell).toEqual(REPORT.fake);
          expect(statSync(doctorPath(repo)).mtimeMs, cell).toBe(reportTime.getTime());
          continue;
        }
        // A skip-only record never reads as a probed doctor cache: every report reader finds no report (run and its
        // daemon probe, init does not reuse it) and its age is past the reuse bound.
        expect(registry.readDoctor(repo), cell).toBeNull();
        expect(registry.initDoctorReuse(repo, false).reuse, cell).toBe(false);
        expect(registry.doctorAgeMs(repo), cell).toBeGreaterThanOrEqual(registry.INIT_DOCTOR_REUSE_MS);
        // The full doctor that follows does not ask, writes a real, fresh report and keeps the record in it.
        const full = answers("");
        await doctorFull(repo, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: full, now: now("2026-11-10T00:00:00.000Z") });
        expect(full, cell).not.toHaveBeenCalled();
        expect(registry.readDoctor(repo), cell).not.toBeNull();
        expect(record(repo), cell).toEqual({ skippedAt: SKIPPED_AT });
        expect(registry.doctorAgeMs(repo), cell).toBeLessThan(registry.INIT_DOCTOR_REUSE_MS);
      }
    }
    // Control: only the exact skip-only first line is read past; any other leading line leaves the file unreadable, so it
    // never proves a skip and the prompt is shown.
    const forged = makeRepo({ "keep.txt": "x\n" });
    writeFileSync(doctorPath(forged), `tickmarkr: anything else\n${JSON.stringify({ aaKeyPrompt: { skippedAt: SKIPPED_AT } })}\n`);
    const read = answers("");
    await doctorCatalog(forged, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: read, now: now() });
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("the ask keys flag asks again despite a recorded skip and doctor help names it", async () => {
    stderr();
    const repo = makeRepo({ "keep.txt": "x\n" });
    const kc = keychain();
    await doctorFull(repo, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: answers(""), now: now() });
    expect(record(repo)).toEqual({ skippedAt: SKIPPED_AT });
    // Without the flag the record holds; with it doctor asks whatever the record says, and a second Enter re-records.
    const held = blockingReader();
    expect(await withinBound(doctorFull(repo, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: held }))).not.toBe(BLOCKED);
    expect(held).not.toHaveBeenCalled();
    const again = answers("");
    await doctorFull(repo, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: again, now: now("2026-11-10T00:00:00.000Z") }, ["--ask-keys"]);
    expect(again.mock.calls).toEqual([[ARTIFICIAL_ANALYSIS_KEY_PROMPT]]);
    expect(record(repo)).toEqual({ skippedAt: "2026-11-10T00:00:00.000Z" });
    // A key entered under the flag serves this command.
    const entered = answers("sk-ask-again-367");
    const run = await doctorFull(makeRepoWithSkip(), { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: entered }, ["--ask-keys"]);
    expect(entered).toHaveBeenCalledTimes(1);
    expect(run.keys).toEqual(["sk-ask-again-367"]);
    // The flag never overrides the interactive guard.
    const guarded = blockingReader();
    expect(await withinBound(doctorFull(repo, { ...INTERACTIVE, stdinIsTTY: false, keyLookup: kc.lookup, readHidden: guarded }, ["--ask-keys"]))).not.toBe(BLOCKED);
    expect(guarded).not.toHaveBeenCalled();
    // doctor's help names the flag.
    const help = await dispatch("doctor", ["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain(`--ask-keys  ${COMMAND_HELP.doctor.options["--ask-keys"]}`);
    expect(COMMAND_HELP.doctor.options["--ask-keys"]).toContain("Ask again");
    expect(COMMAND_HELP.doctor.options["--ask-keys"]).toContain("recorded a skip");
    expect(help.out).toContain("tickmarkr doctor --ask-keys");

    function makeRepoWithSkip() {
      const cell = makeRepo({ "keep.txt": "x\n" });
      registry.writeDoctor(cell, { fake: { installed: true, authed: true, models: [] } });
      writeFileSync(doctorPath(cell), JSON.stringify({ ...JSON.parse(doctorJson(cell)), aaKeyPrompt: { skippedAt: SKIPPED_AT } }));
      return cell;
    }
  });

  test("on darwin a yes sends one escaped add command to security on stdin then end of file and the re-read through the lookup hits", async () => {
    stderr();
    // The key and the account each carry a double quote and a backslash, so only correct escaping round-trips.
    const KEY = 'sk-q"uo\\te-367';
    const account = 'row367 "save"\\tester';
    for (const yes of ["y", "Y", "yes", "YES"]) {
      const repo = makeRepo({ "keep.txt": "x\n" });
      const kc = keychain("darwin", account);
      const security = fakeSecurity(kc.store);
      const term = terminalOut();
      const read = answers(KEY, yes);
      const run = await doctorFull(repo, { ...INTERACTIVE, output: term.output, keyLookup: kc.lookup, readHidden: read, spawn: security.spawn });
      expect(read.mock.calls, yes).toEqual([[ARTIFICIAL_ANALYSIS_KEY_PROMPT], [ARTIFICIAL_ANALYSIS_SAVE_PROMPT]]);
      // argv `security -q -i`, no key in it; every stream piped (captured, never inherited onto the screen).
      expect(security.calls.map((c) => [c.command, c.args]), yes).toEqual([["security", ["-q", "-i"]]]);
      expect(security.calls[0].options.stdio, yes).toEqual(["pipe", "pipe", "pipe"]);
      expect(JSON.stringify(security.calls[0].args), yes).not.toContain("sk-q");
      // ONE command line on stdin, then end of file: never a dangling -w followed by a raw key line.
      expect(security.calls[0].stdin, yes).toBe('add-generic-password -U -a "row367 \\"save\\"\\\\tester" -s ARTIFICIAL_ANALYSIS_API_KEY -w "sk-q\\"uo\\\\te-367"\n');
      expect(security.calls[0].stdin.split("\n"), yes).toHaveLength(2);
      expect(security.calls[0].ended, yes).toBe(true);
      expect(kc.store, yes).toEqual({ item: KEY, account });
      // The confirming re-read went through the lookup's Keychain leg after the save, and hit.
      expect(kc.reads, yes).toEqual([{ ok: true }, { ok: true, key: KEY }]);
      expect(term.writes, yes).toEqual([`${SAVED_LINE}\n`]);
      expect(run.keys, yes).toEqual([KEY]);
      for (const bytes of [term.writes.join(""), run.out, doctorJson(repo)]) expect(bytes, yes).not.toContain("sk-q");
      // Saved once, found by every later command: the next doctor reads it from the Keychain and never asks.
      const next = blockingReader();
      const later = await withinBound(doctorCatalog(repo, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: next, spawn: security.spawn }));
      expect(later, yes).not.toBe(BLOCKED);
      if (later !== BLOCKED) expect(later.keys, yes).toEqual([KEY]);
      expect(next, yes).not.toHaveBeenCalled();
      expect(security.spawn, yes).toHaveBeenCalledTimes(1);
    }
    // Control: a save the re-read does not find is not reported saved.
    const kc = keychain("darwin", account);
    const unsaved = fakeSecurity(kc.store, { storeNothing: true });
    const term = terminalOut();
    const run = await doctorCatalog(makeRepo({ "keep.txt": "x\n" }), { ...INTERACTIVE, output: term.output, keyLookup: kc.lookup, readHidden: answers(KEY, "y"), spawn: unsaved.spawn });
    expect(unsaved.spawn).toHaveBeenCalledTimes(1);
    expect(kc.reads).toEqual([{ ok: true }, { ok: true }]);
    expect(term.writes.join("")).not.toContain(SAVED_LINE);
    expect(run.keys).toEqual([KEY]);
    // A key or account with a newline, carriage return or NUL is never sent: it would split the one command line.
    for (const [key, who] of [["sk-line\nbreak", ACCOUNT], ["sk-carriage\rreturn", ACCOUNT], ["sk-nul\u0000byte", ACCOUNT], ["sk-fine-367", "row367\nsplit"]]) {
      const cell = keychain("darwin", who);
      const security = fakeSecurity(cell.store);
      const out = terminalOut();
      const refused = await doctorCatalog(makeRepo({ "keep.txt": "x\n" }), { ...INTERACTIVE, output: out.output, keyLookup: cell.lookup, readHidden: answers(key, "y"), spawn: security.spawn });
      expect(security.spawn, JSON.stringify(key)).not.toHaveBeenCalled();
      expect(out.writes.join(""), JSON.stringify(key)).toContain("not saved: the key or account contains a newline, carriage return or NUL");
      expect(out.writes.join(""), JSON.stringify(key)).not.toContain("sk-");
      expect(refused.keys, JSON.stringify(key)).toEqual([key]);
    }
  });

  test("a no uses the key for that command and stores nothing", async () => {
    stderr();
    const KEY = "sk-declined-367";
    // Only y or yes (any case) saves: every other answer, Enter included, is a no.
    for (const no of ["n", "N", "no", "", "maybe", "y es"]) {
      const repo = makeRepo({ "keep.txt": "x\n" });
      const kc = keychain();
      const security = fakeSecurity(kc.store);
      const term = terminalOut();
      const read = answers(KEY, no);
      const run = await doctorFull(repo, { ...INTERACTIVE, output: term.output, keyLookup: kc.lookup, readHidden: read, spawn: security.spawn, now: now() });
      expect(read.mock.calls, JSON.stringify(no)).toEqual([[ARTIFICIAL_ANALYSIS_KEY_PROMPT], [ARTIFICIAL_ANALYSIS_SAVE_PROMPT]]);
      expect(run.keys, JSON.stringify(no)).toEqual([KEY]);
      // Nothing stored: no security spawn, no Keychain item, no skip record and no key in doctor.json or the output.
      expect(security.spawn, JSON.stringify(no)).not.toHaveBeenCalled();
      expect(kc.store, JSON.stringify(no)).toEqual({});
      expect(record(repo), JSON.stringify(no)).toBeUndefined();
      for (const bytes of [term.writes.join(""), run.out, doctorJson(repo)]) expect(bytes, JSON.stringify(no)).not.toContain(KEY);
      // So the next doctor in the workspace asks again.
      const next = answers("");
      await doctorCatalog(repo, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: next });
      expect(next, JSON.stringify(no)).toHaveBeenCalledTimes(1);
    }
  });

  test("off darwin the entered key serves that command only and the environment recipe is shown", async () => {
    stderr();
    const KEY = "sk-elsewhere-367";
    for (const platform of ["linux", "win32", "freebsd"] as NodeJS.Platform[]) {
      const repo = makeRepo({ "keep.txt": "x\n" });
      const kc = keychain(platform);
      const security = fakeSecurity(kc.store);
      const term = terminalOut();
      const read = answers(KEY, "y");
      const run = await doctorFull(repo, { ...INTERACTIVE, output: term.output, keyLookup: kc.lookup, readHidden: read, spawn: security.spawn, now: now() });
      // Asked once for the key, never offered a save; no Keychain read or write off darwin.
      expect(read.mock.calls, platform).toEqual([[ARTIFICIAL_ANALYSIS_KEY_PROMPT]]);
      expect(security.spawn, platform).not.toHaveBeenCalled();
      expect(kc.keychainReader, platform).not.toHaveBeenCalled();
      expect(run.keys, platform).toEqual([KEY]);
      expect(term.writes, platform).toEqual([`${ARTIFICIAL_ANALYSIS_ENV_RECIPE}\n`]);
      expect(ARTIFICIAL_ANALYSIS_ENV_RECIPE).toContain(`export ${ARTIFICIAL_ANALYSIS_KEY_NAME}=`);
      for (const bytes of [term.writes.join(""), run.out, doctorJson(repo)]) expect(bytes, platform).not.toContain(KEY);
      expect(record(repo), platform).toBeUndefined();
      // That command only: the next doctor asks again.
      const next = answers("");
      await doctorCatalog(repo, { ...INTERACTIVE, keyLookup: kc.lookup, readHidden: next });
      expect(next, platform).toHaveBeenCalledTimes(1);
    }
  });
});
