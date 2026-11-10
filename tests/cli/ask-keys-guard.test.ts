// Queue row 367 Phase 2; D-2187 add.18, add.20, add.21: doctor and init ask ONCE, with hidden input, for a
// missing Artificial Analysis key, and only when the command is interactive. Every cell runs through the
// doctor or init command entry point with the TTY flags, environment, cwd, Keychain reader and hidden reader
// injected; nothing is read from the operator's terminal. The one real-terminal cell runs the commands in a child
// process on a pseudo-terminal of its own.
import { spawnSync } from "node:child_process";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import {
  ARTIFICIAL_ANALYSIS_KEY_NAME,
  LIVEBENCH_CATEGORIES_URL,
  LIVEBENCH_TABLE_URL,
  MODELS_DEV_CATALOG_URL,
  readCachedCatalog,
  type ArtificialAnalysisKeyLookupOptions,
  type KeychainReadResult,
} from "../../src/adapters/catalog-remote.js";
import { ARTIFICIAL_ANALYSIS_KEY_PROMPT, insideTaskCheckout, readHiddenLine, type AskKeyOptions } from "../../src/cli/ask-keys.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { init } from "../../src/cli/commands/init.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { WORKTREES_DIR } from "../../src/run/git.js";
import { makeRepo, makeTestTempDir, quietGitInit } from "../helpers/tmprepo.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const ACCOUNT = "row367-ask-tester";
const MISSING_LINE = `no Artificial Analysis key: ${ARTIFICIAL_ANALYSIS_KEY_NAME} unset and no Keychain item ${ARTIFICIAL_ANALYSIS_KEY_NAME} for ${ACCOUNT} — set it with: security add-generic-password -a "$USER" -s ${ARTIFICIAL_ANALYSIS_KEY_NAME} -w`;

const keychain = (result: KeychainReadResult = { ok: true }): ArtificialAnalysisKeyLookupOptions =>
  ({ platform: "darwin", account: ACCOUNT, keychainReader: () => result });

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

/** Every interactive condition holds: both TTYs, no JSON flag, no CI, no seat marker, a cwd outside any task checkout. */
const INTERACTIVE = { stdinIsTTY: true, stdoutIsTTY: true, env: {} } satisfies AskKeyOptions;

const blockingReader = () => vi.fn((_prompt: string) => new Promise<string>(() => {}));
const BLOCKED = Symbol("blocked");
/** A command that prompted would await the never-resolving reader; this proves it returned on its own. */
const withinBound = <T>(work: Promise<T>) =>
  Promise.race([work, new Promise<typeof BLOCKED>((done) => setTimeout(() => done(BLOCKED), 20_000))]);

const stderr = () => vi.spyOn(console, "error").mockImplementation(() => {});
const printed = (spy: ReturnType<typeof stderr>) => spy.mock.calls.map((c) => c.join(" "));

/** doctor's catalog entry point: the prompt precedes it, and its AA leg shows which key was used. */
async function doctorCatalog(repo: string, askKey: AskKeyOptions, argv = ["--refresh-catalog"]) {
  const f = fetcher();
  const out = await doctor(argv, repo, [], { catalogFetcher: f, catalogNow: () => new Date(), askKey });
  return { out, keys: aaKeys(f) };
}

/** doctor's full probe path, cheap: no adapters, no host binaries; the cached catalog, or a stale one it refreshes through `refresh`. */
const doctorFull = (repo: string, askKey: AskKeyOptions, argv: string[] = [], refresh?: ReturnType<typeof fetcher>) => {
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
  return doctor(argv, repo, [], {
    banner: false, globalDir: makeTestTempDir("ask-keys-global-"),
    ...(refresh ? { catalogFetcher: refresh, catalogNow: () => new Date() } : { catalog: readCachedCatalog(repo) }),
    resolveClaudeAliasIdentity: () => undefined, resolveOrcaBinary: () => undefined,
    resolveHcBinary: () => undefined, resolveHerdrAppBinary: () => undefined, askKey,
  });
};

/** init with a fresh doctor.json (reused, so no doctor call), or a stale one (init's own doctor call runs). */
function initRun(repo: string, askKey: AskKeyOptions, opts: { reuse?: boolean; argv?: string[] } = {}) {
  vi.spyOn(registry, "allAdapters").mockReturnValue([]);
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
  vi.spyOn(registry, "probeModels").mockResolvedValue();
  vi.spyOn(registry, "probeAll").mockResolvedValue({});
  registry.writeDoctor(repo, { fake: { installed: true, authed: true, models: [] } });
  const when = new Date(Date.now() - ((opts.reuse ?? true) ? 5 : 70) * 60_000);
  utimesSync(join(tickmarkrDir(repo), "doctor.json"), when, when);
  return init(["--global-dir", makeTestTempDir("ask-keys-init-global-"), "--yes", ...(opts.argv ?? [])], repo, { askKey });
}

/** A fake terminal whose event log records, in order, every raw-mode switch and every byte written. */
function terminal(wasRaw = false) {
  const events: string[] = [];
  const rawAtWrite: boolean[] = [];
  const writes: string[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: wasRaw, ref() { return this; },
    setRawMode: vi.fn(function (this: { isRaw: boolean }, mode: boolean) { this.isRaw = mode; events.push(`raw:${mode}`); return this; }),
  });
  const output = {
    isTTY: true,
    write: (chunk: string) => { writes.push(String(chunk)); rawAtWrite.push(input.isRaw); events.push(`write:${String(chunk)}`); return true; },
  };
  return {
    input, events, writes, rawAtFirstWrite: () => rawAtWrite[0],
    askKey: { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, env: {}, keyLookup: keychain() },
  };
}

const REPO_ROOT = join(import.meta.dirname, "../..");
const PTY = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" }).status === 0;
const PTY_SECRET = "sk-pty-secret-367";
const srcUrl = (path: string) => JSON.stringify(pathToFileURL(join(REPO_ROOT, path)).href);
/** The child: doctor or init on its own terminal, with the production reader on the real process.stdin and stdout. */
const PTY_CHILD = `
const { doctor } = await import(${srcUrl("src/cli/commands/doctor.ts")});
const { init } = await import(${srcUrl("src/cli/commands/init.ts")});
const { readHiddenLine } = await import(${srcUrl("src/cli/ask-keys.ts")});
const { writeDoctor } = await import(${srcUrl("src/adapters/registry.ts")});
process.env.VITEST = "true";
const cwd = process.env.T7_ROOT;
const readHidden = async (prompt) => {
  const key = await readHiddenLine(process.stdin, process.stdout, prompt);
  console.log("KEY-RECEIVED " + String(key === process.env.T7_SECRET));
  return key;
};
const askKey = { env: {}, cwd, keyLookup: { platform: "darwin", account: "pty-tester", keychainReader: () => ({ ok: true }) }, readHidden };
if (process.env.T7_COMMAND === "doctor") {
  await doctor(["--refresh-catalog"], cwd, [], { askKey, catalogFetcher: async () => ({ ok: false, status: 503 }) });
} else {
  writeDoctor(cwd, {});
  await init(["--yes", "--global-dir", cwd + "/global"], cwd, { askKey });
}
console.log("DONE");
`;
/** The driver: pastes the key the instant the prompt appears, then reports everything the terminal displayed. */
const PTY_DRIVER = String.raw`
import json, os, pty, select, subprocess, sys, time
secret = os.environ["T7_SECRET"].encode()
marker = os.environ["T7_PROMPT"].encode()
master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1], "--import", "tsx", "--input-type=module", "-e", os.environ["T7_SOURCE"]], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
out = bytearray()
sent = False
rc = None
try:
    deadline = time.monotonic() + 50
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            out.extend(chunk)
        if not sent and marker in out:
            os.write(master, secret + b"\r")
            sent = True
    rc = child.wait(timeout=5)
except Exception as error:
    out.extend(("DRIVER-ERROR " + repr(error)).encode())
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
print("PTY_RESULT " + json.dumps({"rc": rc, "sent": sent, "output": out.decode("utf8", "replace")}))
`;

/** A task checkout: a git checkout under `.tickmarkr/worktrees.noindex/`. */
function taskCheckout(): string {
  const dir = join(makeRepo({ "keep.txt": "x\n" }), ".tickmarkr", WORKTREES_DIR, "tickmarkr-run-x--T1");
  mkdirSync(dir, { recursive: true });
  quietGitInit(dir);
  return dir;
}

describe("row 367 Phase 2: the ask-once key prompt guard", () => {
  test("doctor and init prompt only when stdin and stdout are terminals and no json flag ci seat marker or task checkout applies", async () => {
    const err = stderr();
    // CI unset, empty or `false` and a blank seat marker all leave the command interactive.
    for (const env of [{}, { CI: "" }, { CI: "false" }, { TICKMARKR_SEAT: "  " }]) {
      const repo = makeRepo({ "keep.txt": "x\n" });
      expect(insideTaskCheckout(repo)).toBe(false);
      const read = vi.fn(async (_prompt: string) => "sk-entered-367");
      const doctorRun = await doctorCatalog(repo, { ...INTERACTIVE, env, keyLookup: keychain(), readHidden: read });
      expect(read, JSON.stringify(env)).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0][0]).toBe(ARTIFICIAL_ANALYSIS_KEY_PROMPT);
      // The entered key serves this command: the Artificial Analysis leg fetched with it.
      expect(doctorRun.keys).toEqual(["sk-entered-367"]);
      expect(doctorRun.out).toContain("Artificial Analysis updated");

      const initRead = vi.fn(async (_prompt: string) => "");
      await initRun(makeRepo({ "keep.txt": "x\n" }), { ...INTERACTIVE, env, keyLookup: keychain(), readHidden: initRead });
      expect(initRead, JSON.stringify(env)).toHaveBeenCalledTimes(1);
      expect(initRead.mock.calls[0][0]).toBe(ARTIFICIAL_ANALYSIS_KEY_PROMPT);
    }
    // doctor's full probe path prompts at the same entry point.
    const full = vi.fn(async (_prompt: string) => "");
    await doctorFull(makeRepo({ "keep.txt": "x\n" }), { ...INTERACTIVE, keyLookup: keychain(), readHidden: full });
    expect(full).toHaveBeenCalledTimes(1);
    // A failed Keychain read found no key either, so an interactive command still asks.
    const failedRead = vi.fn(async (_prompt: string) => "");
    await doctorCatalog(makeRepo({ "keep.txt": "x\n" }), { ...INTERACTIVE, keyLookup: keychain({ ok: false, exit: "51" }), readHidden: failedRead });
    expect(failedRead).toHaveBeenCalledTimes(1);
    // ONCE: init asks, and the doctor call init makes reuses that answer instead of asking again.
    const once = vi.fn(async (_prompt: string) => "");
    const probed = await initRun(makeRepo({ "keep.txt": "x\n" }), { ...INTERACTIVE, keyLookup: keychain(), readHidden: once }, { reuse: false });
    expect(probed).not.toContain("using probe results");
    expect(vi.mocked(registry.probeAll)).toHaveBeenCalled();
    expect(once).toHaveBeenCalledTimes(1);
    // An interactive command never prints the missing-key hint in place of asking.
    expect(printed(err).filter((line) => line.includes("no Artificial Analysis key"))).toEqual([]);
  });

  test("each failed interactive condition alone gives no prompt and no block and prints the missing key hint", async () => {
    const cells: { name: string; askKey: AskKeyOptions; cwd?: () => string }[] = [
      { name: "stdin not a terminal", askKey: { ...INTERACTIVE, stdinIsTTY: false } },
      { name: "stdout not a terminal", askKey: { ...INTERACTIVE, stdoutIsTTY: false } },
      { name: "CI=true", askKey: { ...INTERACTIVE, env: { CI: "true" } } },
      { name: "CI=1", askKey: { ...INTERACTIVE, env: { CI: "1" } } },
      { name: "a seat marker", askKey: { ...INTERACTIVE, env: { TICKMARKR_SEAT: "judge" } } },
      { name: "a task checkout", askKey: INTERACTIVE, cwd: taskCheckout },
    ];
    for (const cell of cells) {
      const cwd = cell.cwd?.() ?? makeRepo({ "keep.txt": "x\n" });
      expect(insideTaskCheckout(cwd), cell.name).toBe(cell.name === "a task checkout");

      const err = stderr();
      const read = blockingReader();
      const doctorRun = await withinBound(doctorCatalog(cwd, { ...cell.askKey, keyLookup: keychain(), readHidden: read }));
      expect(doctorRun, `doctor: ${cell.name}`).not.toBe(BLOCKED);
      expect(read, `doctor: ${cell.name}`).not.toHaveBeenCalled();
      expect(printed(err), `doctor: ${cell.name}`).toContain(MISSING_LINE);
      if (doctorRun !== BLOCKED) {
        expect(doctorRun.keys).toEqual([]);
        expect(doctorRun.out).toContain(`Artificial Analysis skipped (${MISSING_LINE}`);
      }
      err.mockRestore();

      const initErr = stderr();
      const initRead = blockingReader();
      const initOut = await withinBound(initRun(cwd, { ...cell.askKey, keyLookup: keychain(), readHidden: initRead }));
      expect(initOut, `init: ${cell.name}`).not.toBe(BLOCKED);
      expect(initRead, `init: ${cell.name}`).not.toHaveBeenCalled();
      expect(printed(initErr), `init: ${cell.name}`).toContain(MISSING_LINE);
      vi.restoreAllMocks();
    }
    // The JSON flag: doctor never prompts under it and prints the hint.
    const err = stderr();
    const read = blockingReader();
    const jsonRun = await withinBound(doctorFull(makeRepo({ "keep.txt": "x\n" }), { ...INTERACTIVE, keyLookup: keychain(), readHidden: read }, ["--json"]));
    expect(jsonRun).not.toBe(BLOCKED);
    expect(read).not.toHaveBeenCalled();
    expect(printed(err)).toContain(MISSING_LINE);
    err.mockRestore();
    // init has no JSON flag: a JSON caller still gets the hint and no prompt, then the parse refuses the flag.
    const initErr = stderr();
    const initRead = blockingReader();
    const initJson = await withinBound(initRun(makeRepo({ "keep.txt": "x\n" }), { ...INTERACTIVE, keyLookup: keychain(), readHidden: initRead }, { argv: ["--json"] })
      .then(() => "resolved", (error: unknown) => error));
    expect(initJson).not.toBe(BLOCKED);
    expect(String(initJson)).toMatch(/--json/);
    expect(initRead).not.toHaveBeenCalled();
    expect(printed(initErr)).toContain(MISSING_LINE);
  });

  test("an interactive doctor or init with the key in the environment does not prompt", async () => {
    const err = stderr();
    const keychainRead = vi.fn((_account: string): KeychainReadResult => ({ ok: true, key: "sk-keychain-unused" }));
    const lookup = { platform: "darwin" as const, account: ACCOUNT, keychainReader: keychainRead };
    const read = blockingReader();
    // The command's environment, injected (the ambient one empty) and, with nothing injected, the process environment.
    vi.stubEnv(ARTIFICIAL_ANALYSIS_KEY_NAME, "");
    const injected = { ...INTERACTIVE, env: { [ARTIFICIAL_ANALYSIS_KEY_NAME]: "sk-environment-367" }, keyLookup: lookup, readHidden: read };
    const doctorRun = await withinBound(doctorCatalog(makeRepo({ "keep.txt": "x\n" }), injected));
    expect(doctorRun).not.toBe(BLOCKED);
    if (doctorRun !== BLOCKED) expect(doctorRun.keys).toEqual(["sk-environment-367"]);
    expect(await withinBound(initRun(makeRepo({ "keep.txt": "x\n" }), injected))).not.toBe(BLOCKED);
    vi.stubEnv(ARTIFICIAL_ANALYSIS_KEY_NAME, "sk-process-367");
    const ambient = { stdinIsTTY: true, stdoutIsTTY: true, keyLookup: lookup, readHidden: read };
    const ambientRun = await withinBound(doctorCatalog(makeRepo({ "keep.txt": "x\n" }), ambient));
    expect(ambientRun).not.toBe(BLOCKED);
    if (ambientRun !== BLOCKED) expect(ambientRun.keys).toEqual(["sk-process-367"]);
    expect(await withinBound(initRun(makeRepo({ "keep.txt": "x\n" }), ambient))).not.toBe(BLOCKED);
    expect(read).not.toHaveBeenCalled();
    expect(keychainRead).not.toHaveBeenCalled();
    expect(printed(err).filter((line) => line.includes("no Artificial Analysis key"))).toEqual([]);
  });

  // Review finding (row 367 Phase 2): the guard, the key lookup and the catalog refresh read ONE environment, the
  // command's. The refresh uses the key that lookup or the prompt produced, never a second lookup of another one.
  test("the command's injected environment alone decides the prompt and the key the catalog refresh sends, at every doctor and init entry point", async () => {
    const INJECTED = "sk-injected-367";
    const AMBIENT = "sk-ambient-367";
    const ENTERED = "sk-entered-367";
    const entries: Record<string, (askKey: AskKeyOptions) => Promise<(string | null)[]>> = {
      "doctor --refresh-catalog": async (askKey) => (await doctorCatalog(makeRepo({ "keep.txt": "x\n" }), askKey)).keys,
      "doctor's full probe refreshing a stale catalog": async (askKey) => {
        const f = fetcher();
        await doctorFull(makeRepo({ "keep.txt": "x\n" }), askKey, [], f);
        return aaKeys(f);
      },
      "init's doctor call refreshing a stale catalog": async (askKey) => {
        const f = fetcher();
        vi.stubGlobal("fetch", f);
        await initRun(makeRepo({ "keep.txt": "x\n" }), askKey, { reuse: false });
        return aaKeys(f);
      },
    };
    for (const [entry, run] of Object.entries(entries)) {
      for (const injected of [true, false]) {
        for (const ambient of [true, false]) {
          for (const answer of [ENTERED, ""]) {
            const cell = `${entry}: injected key ${injected}, ambient key ${ambient}, answer ${JSON.stringify(answer)}`;
            vi.stubEnv(ARTIFICIAL_ANALYSIS_KEY_NAME, ambient ? AMBIENT : "");
            stderr();
            const read = vi.fn(async (_prompt: string) => answer);
            const env = injected ? { [ARTIFICIAL_ANALYSIS_KEY_NAME]: INJECTED } : {};
            const keys = await run({ ...INTERACTIVE, env, keyLookup: keychain(), readHidden: read });
            expect(read, cell).toHaveBeenCalledTimes(injected ? 0 : 1);
            expect(keys, cell).toEqual(injected ? [INJECTED] : answer ? [ENTERED] : []);
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
          }
        }
      }
    }
    // Without a key the refresh's leg carries the command lookup's own line: a failed Keychain read stays one,
    // and the ambient key is still never sent.
    vi.stubEnv(ARTIFICIAL_ANALYSIS_KEY_NAME, AMBIENT);
    stderr();
    const failed = await doctorCatalog(makeRepo({ "keep.txt": "x\n" }), { ...INTERACTIVE, stdinIsTTY: false, keyLookup: keychain({ ok: false, exit: "51" }) });
    expect(failed.keys).toEqual([]);
    expect(failed.out).toContain("Artificial Analysis skipped (no Artificial Analysis key: Keychain read failed (exit 51)");
  });

  test("an interactive doctor or init with a keychain hit does not prompt", async () => {
    const err = stderr();
    const keychainRead = vi.fn((_account: string): KeychainReadResult => ({ ok: true, key: "sk-keychain-367" }));
    const lookup = { platform: "darwin" as const, account: ACCOUNT, keychainReader: keychainRead };
    const read = blockingReader();
    const doctorRun = await withinBound(doctorCatalog(makeRepo({ "keep.txt": "x\n" }), { ...INTERACTIVE, keyLookup: lookup, readHidden: read }));
    expect(doctorRun).not.toBe(BLOCKED);
    if (doctorRun !== BLOCKED) expect(doctorRun.keys).toEqual(["sk-keychain-367"]);
    const initOut = await withinBound(initRun(makeRepo({ "keep.txt": "x\n" }), { ...INTERACTIVE, keyLookup: lookup, readHidden: read }));
    expect(initOut).not.toBe(BLOCKED);
    expect(read).not.toHaveBeenCalled();
    expect(keychainRead.mock.calls.map(([account]) => account).every((account) => account === ACCOUNT)).toBe(true);
    expect(printed(err).filter((line) => line.includes("no Artificial Analysis key"))).toEqual([]);
  });

  test("the prompt names the free key page and reads the key with hidden input that echoes nothing", async () => {
    // The production reader, unhooked from the test runner's no-reader default, on fake terminal streams.
    vi.stubEnv("VITEST", "");
    const typed = "sk-hiddenX\u007f-367\r";
    const key = "sk-hidden-367";
    // Echo goes off BEFORE the first prompt byte, and the prior mode comes back only after the line is read: a key
    // pasted the instant the prompt appears never meets an echoing terminal (review finding, row 367 Phase 2).
    const ORDER = ["raw:true", `write:${ARTIFICIAL_ANALYSIS_KEY_PROMPT}`, "raw:false", "write:\n"];

    const doctorTerm = terminal();
    doctorTerm.input.write(typed);
    const doctorRun = await doctorCatalog(makeRepo({ "keep.txt": "x\n" }), doctorTerm.askKey);
    expect(doctorTerm.events).toEqual(ORDER);
    expect(doctorTerm.rawAtFirstWrite()).toBe(true);
    expect(doctorTerm.writes).toEqual([ARTIFICIAL_ANALYSIS_KEY_PROMPT, "\n"]);
    expect(doctorTerm.writes.join("")).toContain("artificialanalysis.ai");
    expect(doctorTerm.writes.join("")).not.toMatch(/sk-hidden|-367/);
    expect(doctorTerm.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(doctorRun.keys).toEqual([key]);
    expect(doctorRun.out).not.toContain(key);

    const initTerm = terminal();
    initTerm.input.write(typed);
    const initOut = await initRun(makeRepo({ "keep.txt": "x\n" }), initTerm.askKey);
    expect(initTerm.events).toEqual(ORDER);
    expect(initTerm.rawAtFirstWrite()).toBe(true);
    expect(initTerm.writes).toEqual([ARTIFICIAL_ANALYSIS_KEY_PROMPT, "\n"]);
    expect(initTerm.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(initOut).not.toContain(key);

    // A stream that cannot turn echo off is never read: no prompt, no typed byte consumed.
    const noRaw = Object.assign(new PassThrough(), { isTTY: true });
    const noRawWrites: string[] = [];
    noRaw.write("sk-echoed\r");
    await expect(readHiddenLine(noRaw as unknown as NodeJS.ReadStream,
      { write: (c: string) => { noRawWrites.push(c); return true; } } as unknown as NodeJS.WriteStream, ARTIFICIAL_ANALYSIS_KEY_PROMPT)).resolves.toBe("");
    expect(noRawWrites).toEqual([]);
    // End of input mid-line skips rather than hangs, and restores the terminal.
    const ended = terminal();
    const reading = readHiddenLine(ended.askKey.input, ended.askKey.output, ARTIFICIAL_ANALYSIS_KEY_PROMPT);
    ended.input.end("sk-partial");
    await expect(reading).resolves.toBe("");
    expect(ended.input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  // Operator ruling on the review finding (row 367 Phase 2): echo is off before the first prompt byte and the prior mode
  // is restored on every way the read ends. One closed table of endings, each from both prior modes.
  test("every ending of the hidden read turns echo off before the first prompt byte and restores the prior terminal mode", async () => {
    type Term = ReturnType<typeof terminal>;
    const endings: { name: string; answer: string; output?: () => NodeJS.WriteStream; act: (t: Term) => void }[] = [
      { name: "Enter", answer: "sk-enter", act: (t) => t.input.write("sk-enter\r") },
      { name: "a newline", answer: "sk-newline", act: (t) => t.input.write("sk-newline\n") },
      { name: "Ctrl-C (the SIGINT key, swallowed by raw mode)", answer: "", act: (t) => t.input.write("sk-part\u0003") },
      { name: "Ctrl-D", answer: "", act: (t) => t.input.write("sk-part\u0004") },
      { name: "end of input", answer: "", act: (t) => t.input.end("sk-part") },
      { name: "a stream error", answer: "", act: (t) => { t.input.write("sk-part"); setImmediate(() => t.input.emit("error", new Error("EIO"))); } },
      { name: "a delivered SIGINT", answer: "", act: () => setImmediate(() => sigint()) },
      {
        name: "a prompt write that throws", answer: "", act: () => {},
        output: () => ({ write: () => { throw new Error("EBADF"); } }) as unknown as NodeJS.WriteStream,
      },
    ];
    let sigint = () => {};
    for (const wasRaw of [false, true]) {
      for (const ending of endings) {
        const cell = `${ending.name}, prior raw ${wasRaw}`;
        const once = vi.spyOn(process, "once");
        const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
        sigint = () => {
          const handler = once.mock.calls.find(([event]) => event === "SIGINT")?.[1] as (() => void) | undefined;
          if (!handler) throw new Error("no SIGINT handler was installed");
          process.off("SIGINT", handler);
          handler();
        };
        const t = terminal(wasRaw);
        const reading = readHiddenLine(t.askKey.input, ending.output?.() ?? t.askKey.output, ARTIFICIAL_ANALYSIS_KEY_PROMPT);
        ending.act(t);
        await expect(reading, cell).resolves.toBe(ending.answer);
        expect(t.input.setRawMode.mock.calls, cell).toEqual([[true], [wasRaw]]);
        expect(t.input.isRaw, cell).toBe(wasRaw);
        if (!ending.output) {
          expect(t.rawAtFirstWrite(), cell).toBe(true);
          expect(t.events, cell).toEqual(["raw:true", `write:${ARTIFICIAL_ANALYSIS_KEY_PROMPT}`, `raw:${wasRaw}`, "write:\n"]);
        }
        // Nothing outlives the read: no data, end, error or SIGINT listener stays behind.
        expect(t.input.listenerCount("data") + t.input.listenerCount("end") + t.input.listenerCount("error"), cell).toBe(0);
        expect(process.listeners("SIGINT").some((l) => once.mock.calls.some(([, h]) => h === l)), cell).toBe(false);
        // A delivered SIGINT keeps its default (exit) once the terminal is restored, unless something else handles it.
        expect(kill.mock.calls, cell).toEqual(ending.name === "a delivered SIGINT" && process.listenerCount("SIGINT") === 0 ? [[process.pid, "SIGINT"]] : []);
        vi.restoreAllMocks();
      }
    }
  });

  // The reviewer's reproducer (row 367 Phase 2), owned: a real pseudo-terminal, the production reader on the real
  // process.stdin and stdout, the key pasted the instant the prompt appears, through doctor's and init's entry points.
  test.skipIf(!PTY)("a key pasted the instant the prompt appears never reaches a real terminal's echo, through doctor and init", () => {
    for (const command of ["doctor", "init"]) {
      const root = makeTestTempDir("ask-keys-pty-");
      const r = spawnSync("python3", ["-", process.execPath], {
        input: PTY_DRIVER, encoding: "utf8", timeout: 60_000, killSignal: "SIGTERM", cwd: REPO_ROOT,
        env: { ...process.env, T7_ROOT: root, T7_COMMAND: command, T7_SECRET: PTY_SECRET, T7_PROMPT: ARTIFICIAL_ANALYSIS_KEY_PROMPT.trim(), T7_SOURCE: PTY_CHILD },
      });
      const line = r.stdout.split("\n").find((l) => l.startsWith("PTY_RESULT "));
      if (!line) expect.fail(`${command}: the pty driver produced no result\nstatus: ${r.status}\nstderr:\n${r.stderr}`);
      const result = JSON.parse(line.slice("PTY_RESULT ".length)) as { rc: number | null; sent: boolean; output: string };
      const evidence = `${command}: ${JSON.stringify(result)}`;
      expect(result.sent, evidence).toBe(true);
      expect(result.output, evidence).toContain("artificialanalysis.ai");
      expect(result.output, evidence).toContain("KEY-RECEIVED true");
      expect(result.output, evidence).toContain("DONE");
      expect(result.rc, evidence).toBe(0);
      expect(result.output, evidence).not.toContain(PTY_SECRET);
    }
  }, 150_000);
});
