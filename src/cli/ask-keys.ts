// Queue row 367 Phase 2; D-2187 add.18 (operator first-hand), add.20, add.21. When neither the environment
// nor the Keychain yields an Artificial Analysis key, `tickmarkr doctor` and `tickmarkr init` ask ONCE, and only
// when the command is interactive. This module is called only from those two command entry points, never from
// shared probe or catalog code, so a run, its daemon, its workers and its gate seats never prompt.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync, realpathSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  ARTIFICIAL_ANALYSIS_KEY_NAME,
  artificialAnalysisKeychainFailedLine,
  artificialAnalysisMissingKeyLine,
  readKeychainKey,
  refreshCatalogCommand,
  type ArtificialAnalysisKeyLookup,
  type ArtificialAnalysisKeyLookupOptions,
  type KeychainReadResult,
  type RefreshCatalogOptions,
  type RefreshCatalogResult,
} from "../adapters/catalog-remote.js";
import { SEAT_MARKER_ENV } from "../drivers/host-env.js";
import { stateDirName, tickmarkrDir } from "../graph/graph.js";
import { WORKTREES_DIR } from "../run/git.js";

/** The free key page the prompt names. */
export const ARTIFICIAL_ANALYSIS_KEY_PAGE = "artificialanalysis.ai";
export const ARTIFICIAL_ANALYSIS_KEY_PROMPT =
  `Artificial Analysis key for new-model tier evidence (free key: ${ARTIFICIAL_ANALYSIS_KEY_PAGE}) — paste it (input hidden), or press Enter to skip: `;

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface KeyPromptContext {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  json: boolean;
  env: Env;
  cwd: string;
}

/** Whether `cwd` is inside a `.tickmarkr/worktrees.noindex/` task checkout (src/run/git.ts WORKTREES_DIR). */
export function insideTaskCheckout(cwd: string): boolean {
  const paths = [resolve(cwd)];
  try {
    paths.push(realpathSync(cwd));
  } catch {
    // an unreadable cwd keeps the lexical answer
  }
  return paths.some((path) => {
    const parts = path.split(sep);
    return parts.some((part, i) => part === stateDirName(path) && parts[i + 1] === WORKTREES_DIR);
  });
}

/** The contract's interactive conjunction: every condition must hold; any failed one means no prompt. */
export function keyPromptInteractive(c: KeyPromptContext): boolean {
  const ci = c.env.CI;
  return c.stdinIsTTY && c.stdoutIsTTY && !c.json
    && (ci === undefined || ci === "" || ci === "false")
    && !(c.env[SEAT_MARKER_ENV] ?? "").trim()
    && !insideTaskCheckout(c.cwd);
}

/**
 * Reads one line with the terminal in raw mode, so the typed key is never echoed: only the prompt and the
 * closing newline are written. Echo goes off BEFORE the first prompt byte: a key pasted the instant the prompt
 * appears must never reach a terminal that still echoes. Enter ends the line; Ctrl-C, Ctrl-D, end of input, a
 * stream error, a failed prompt write or a SIGINT skip (no key), and every one of them restores the prior mode.
 * A stream without raw mode is never read, since its input would echo.
 */
export function readHiddenLine(input: NodeJS.ReadStream, output: NodeJS.WriteStream, prompt: string): Promise<string> {
  if (typeof input.setRawMode !== "function") return Promise.resolve("");
  return new Promise((done) => {
    const wasRaw = input.isRaw === true;
    let value = "";
    let settled = false;
    const finish = (answer: string) => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      process.off("SIGINT", onSignal);
      try {
        input.setRawMode(wasRaw);
        input.pause();
        output.write("\n");
      } finally {
        done(answer);
      }
    };
    const onEnd = () => finish("");
    // A delivered SIGINT restores the terminal, then keeps its default (exit) when nothing else listens for it.
    const onSignal = () => {
      finish("");
      if (process.listenerCount("SIGINT") === 0) process.kill(process.pid, "SIGINT");
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish(value);
        // ponytail: raw mode swallows SIGINT, so Ctrl-C skips the key instead of killing the command.
        if (ch === "\u0003" || ch === "\u0004") return finish("");
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    try {
      input.setRawMode(true);
      process.once("SIGINT", onSignal);
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onEnd);
      output.write(prompt);
      // An earlier Ink act can leave stdin paused and unref'd (init's wizard); revive it before reading.
      input.resume();
      input.ref?.();
    } catch {
      finish("");
    }
  });
}

export type HiddenReader = (prompt: string) => Promise<string>;
/** The `security` spawn seam, node's spawn shape: the save writes its one command line on the child's stdin. */
export type KeychainSaveSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export const ARTIFICIAL_ANALYSIS_SAVE_PROMPT = "Save it to the macOS Keychain for every workspace? [y/N] (input hidden): ";
export const ARTIFICIAL_ANALYSIS_ENV_RECIPE =
  `Artificial Analysis key used for this command only — to keep it, set it in your environment: export ${ARTIFICIAL_ANALYSIS_KEY_NAME}=<your key>`;

export interface AskKeyOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  env?: Env;
  cwd?: string;
  /** Under the test runner nothing is read unless a reader is injected, as with the Keychain read. */
  readHidden?: HiddenReader;
  keyLookup?: ArtificialAnalysisKeyLookupOptions;
  /** Where the missing-key hint goes when no prompt is shown; absent = stderr. */
  warn?: (line: string) => void;
  /** `tickmarkr doctor --ask-keys`: ask again whatever the workspace's recorded skip says. */
  askAgain?: boolean;
  /** The Keychain save's spawner; absent = node's spawn, except when the read is injected or under the test runner. */
  spawn?: KeychainSaveSpawn;
  /** The skip record's clock; absent = the wall clock. */
  now?: () => Date;
}

/**
 * The shared lookup's order and typed lines (environment, then the darwin Keychain), with the environment leg read
 * from THIS command's environment, the one the guard reads. ponytail: lookupArtificialAnalysisKey reads only
 * process.env (src/adapters/catalog-remote.ts, outside this task's files), so its Keychain leg is composed here from
 * its exported parts; call it with the environment instead once it accepts one.
 */
export function lookupCommandKey(env: Env, lookup: ArtificialAnalysisKeyLookupOptions = {}): ArtificialAnalysisKeyLookup {
  const fromEnv = env[ARTIFICIAL_ANALYSIS_KEY_NAME]?.trim();
  if (fromEnv) return { ok: true, key: fromEnv, source: "environment" };
  const read = commandKeychainRead(env, lookup);
  if (!read.ok) return { ok: false, error: artificialAnalysisKeychainFailedLine(read.exit) };
  return read.key ? { ok: true, key: read.key, source: "keychain" } : { ok: false, error: artificialAnalysisMissingKeyLine(commandAccount(env, lookup)) };
}

/** The lookup's Keychain leg: the darwin read for this command's account (none off darwin, or under the test runner
 *  without an injected reader). The save's confirming re-read goes through it, so its failure keeps its exit code. */
function commandKeychainRead(env: Env, lookup: ArtificialAnalysisKeyLookupOptions): KeychainReadResult {
  if ((lookup.platform ?? process.platform) !== "darwin") return { ok: true };
  const account = commandAccount(env, lookup);
  return lookup.keychainReader ? lookup.keychainReader(account) : process.env.VITEST ? { ok: true } : readKeychainKey(account);
}

function commandAccount(env: Env, lookup: ArtificialAnalysisKeyLookupOptions): string {
  if (lookup.account !== undefined) return lookup.account;
  try {
    return userInfo().username;
  } catch {
    return env.USER ?? "";
  }
}

/**
 * `key` is the key this command uses (found, or entered for this command only); without one, `error` is the typed hint.
 * `skippedAt` is the workspace's skip record in force (recorded now or earlier), never the key.
 */
export type AskKeyResult = { prompted: boolean; skippedAt?: string } & ({ key: string } | { error: string });

const doctorJsonPath = (cwd: string) => join(cwd, stateDirName(cwd), "doctor.json");

/** The first line of a doctor.json holding ONLY the skip record (the workspace had no report: no file, malformed JSON,
 *  or JSON that is not an object). JSON.parse refuses the file, so every report reader treats it as torn and probes, as
 *  it would with no file: an unprobed cache never reads as a probed fleet. Only recordedSkip reads past this exact line. */
const SKIP_ONLY_HEADER = "tickmarkr: no doctor report yet; this file holds only the Artificial Analysis key prompt skip\n";

/** The workspace's recorded skip (`aaKeyPrompt: { skippedAt }` in doctor.json): a missing, unreadable or malformed
 *  record never proves a skip, so the prompt is shown. */
function recordedSkip(cwd: string): string | undefined {
  try {
    const text = readFileSync(doctorJsonPath(cwd), "utf8");
    const body = text.startsWith(SKIP_ONLY_HEADER) ? text.slice(SKIP_ONLY_HEADER.length) : text;
    const at: unknown = JSON.parse(body)?.aaKeyPrompt?.skippedAt;
    return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Queue row 367 Phase 2 (D-2187 add.18): writes the result's skip record into doctor.json as `aaKeyPrompt: { skippedAt }`
 * (never the key). Over a report it keeps every other key and the file's mtime, which is the doctor cache's age; doctor
 * calls this again after its own rewrite of doctor.json, so the record outlives every doctor. Without a report (no state
 * directory, no file, malformed JSON, null, an array or a scalar) it writes the skip-only form, dated at the epoch so any
 * age reader sees it past every freshness bound, and the next probing doctor carries the record into its report.
 */
export function recordKeyPromptSkip(cwd: string, asked: AskKeyResult): void {
  if (!asked.skippedAt) return;
  const path = doctorJsonPath(cwd);
  let report: Record<string, unknown> | undefined;
  let times = { atime: new Date(0), mtime: new Date(0) };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      times = statSync(path);
      report = raw as Record<string, unknown>;
    }
  } catch {
    // no report to keep: the skip-only form below
  }
  const record = { aaKeyPrompt: { skippedAt: asked.skippedAt } };
  const { aaKeyPrompt: _, ...rest } = report ?? {};
  tickmarkrDir(cwd);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, report ? JSON.stringify({ ...rest, ...record }, null, 2) + "\n" : `${SKIP_ONLY_HEADER}${JSON.stringify(record)}\n`);
  renameSync(tmp, path);
  utimesSync(path, times.atime, times.mtime);
}

/** A `security -i` argument: double-quoted, with every backslash and double quote inside escaped by a backslash. */
const securityQuote = (value: string) => `"${value.replace(/[\\"]/g, "\\$&")}"`;

/** The ONE command line the Keychain save writes on `security -i`'s stdin: the key travels as a quoted `-w` value,
 *  never as a dangling `-w` followed by a raw key line (cross-read N1), and never in argv. */
export const keychainAddCommand = (account: string, key: string): string =>
  `add-generic-password -U -a ${securityQuote(account)} -s ${ARTIFICIAL_ANALYSIS_KEY_NAME} -w ${securityQuote(key)}\n`;

/** Spawns `security -q -i` (no key in argv), writes the one command line on its stdin, then end of file. Its stdout and
 *  stderr are piped and dropped, never echoed. Resolves undefined on exit 0, else the typed reason: the nonzero exit (or
 *  the signal) or the spawn error's code — never the error's text, which nothing here needs to print. */
function saveToKeychain(spawner: KeychainSaveSpawn, line: string): Promise<string | undefined> {
  return new Promise((done) => {
    const unstarted = (error: unknown) => done(`security could not be started (${(error as NodeJS.ErrnoException | undefined)?.code ?? "spawn error"})`);
    let child: ChildProcess;
    try {
      child = spawner("security", ["-q", "-i"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      return unstarted(error);
    }
    child.stdout?.resume();
    child.stderr?.resume();
    child.once("error", unstarted);
    child.once("close", (code, signal) => done(code === 0 ? undefined : `security exited ${code ?? signal ?? "without a status"}`));
    // security exiting before it reads stdin must not surface as an unhandled EPIPE.
    child.stdin?.once("error", () => {});
    child.stdin?.end(line);
  });
}

/**
 * The ask-once prompt. A key the lookup finds in this command's environment or the Keychain short-circuits it (no
 * prompt). Otherwise it prompts only when every interactive condition holds and the workspace has no recorded skip
 * (`askAgain`, doctor's `--ask-keys`, asks whatever the record says); any other path prints the lookup's typed hint and
 * returns at once. Enter records the skip. An entered key serves this command; on darwin a yes saves it to the
 * Keychain and re-reads it through the lookup to confirm, and off darwin the environment recipe is shown.
 */
export async function askArtificialAnalysisKey(argv: readonly string[], opts: AskKeyOptions = {}): Promise<AskKeyResult> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const lookup = opts.keyLookup ?? {};
  const recorded = recordedSkip(cwd);
  const held = recorded ? { skippedAt: recorded } : {};
  const found = lookupCommandKey(env, lookup);
  if (found.ok) return { prompted: false, key: found.key, ...held };
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const interactive = keyPromptInteractive({
    stdinIsTTY: opts.stdinIsTTY ?? input.isTTY === true,
    stdoutIsTTY: opts.stdoutIsTTY ?? output.isTTY === true,
    json: argv.includes("--json"),
    env,
    cwd,
  });
  const read = opts.readHidden ?? (process.env.VITEST ? undefined : (prompt: string) => readHiddenLine(input, output, prompt));
  if (!interactive || !read || (recorded && !opts.askAgain)) {
    (opts.warn ?? console.error)(found.error);
    return { prompted: false, error: found.error, ...held };
  }
  const key = (await read(ARTIFICIAL_ANALYSIS_KEY_PROMPT)).trim();
  if (!key) {
    const skipped = { prompted: true, error: found.error, skippedAt: (opts.now?.() ?? new Date()).toISOString() };
    recordKeyPromptSkip(cwd, skipped);
    return skipped;
  }
  const say = (line: string) => output.write(`${line}\n`);
  if ((lookup.platform ?? process.platform) !== "darwin") {
    say(ARTIFICIAL_ANALYSIS_ENV_RECIPE);
    return { prompted: true, key, ...held };
  }
  // The real Keychain is written only when it is also the one read back: an injected reader, or the test runner,
  // never pairs with the real security binary. Without a saver nothing is offered and the key serves this command.
  const saver = opts.spawn ?? (lookup.keychainReader || process.env.VITEST ? undefined : spawn);
  if (!saver) return { prompted: true, key, ...held };
  const account = commandAccount(env, lookup);
  if (/[\n\r\0]/.test(account + key)) {
    say("Artificial Analysis key not saved: the key or account contains a newline, carriage return or NUL — used for this command only");
    return { prompted: true, key, ...held };
  }
  if (!/^y(es)?$/i.test((await read(ARTIFICIAL_ANALYSIS_SAVE_PROMPT)).trim())) return { prompted: true, key, ...held };
  // Queue row 367 (D-2187 add.21 (1)): a failed save or confirmation names its reason once, keeps the entered key for
  // this command only and returns: the prompt is never asked again, and no reason carries the key.
  const failure = await saveToKeychain(saver, keychainAddCommand(account, key)) ?? confirmSave(env, lookup, key);
  say(failure
    ? `Artificial Analysis key not saved: ${failure} — used for this command only`
    : "Artificial Analysis key saved to the macOS Keychain (confirmed by a re-read)");
  return { prompted: true, key, ...held };
}

/** The confirming re-read through the lookup's Keychain leg: undefined when it returns the entered key, else the reason. */
function confirmSave(env: Env, lookup: ArtificialAnalysisKeyLookupOptions, key: string): string | undefined {
  const read = commandKeychainRead(env, lookup);
  if (!read.ok) return `the confirming Keychain re-read failed (exit ${read.exit})`;
  return read.key === key ? undefined : "the confirming Keychain re-read did not find it";
}

/**
 * The catalog refresh for doctor and init: the command's key decision is the key of record, so the refresh never runs
 * its own lookup against a different environment than the one the prompt read. Without a key the Artificial Analysis
 * leg carries the command lookup's typed line (a failed Keychain read stays a failed read).
 */
export async function refreshCatalogWithAskedKey(opts: RefreshCatalogOptions, asked: AskKeyResult): Promise<RefreshCatalogResult> {
  const refreshed = await refreshCatalogCommand({ ...opts, artificialAnalysisKey: "key" in asked ? asked.key : "" });
  if ("key" in asked) return refreshed;
  return {
    ...refreshed,
    legs: refreshed.legs.map((leg) => leg.leg === "Artificial Analysis" && leg.status === "skipped" ? { ...leg, detail: asked.error } : leg),
  };
}
