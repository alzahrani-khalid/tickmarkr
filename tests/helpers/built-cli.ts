import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const ENTRY = join(ROOT, "dist/cli/index.js");
const SRC = join(ROOT, "src");

/**
 * Newest mtime of any FILE under `dir`, nested included — a source edit two levels down is still a
 * source edit. Directories are skipped: their own mtime moves when a child is added, which would
 * make every freshly-created tree look infinitely stale.
 */
export function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const s = statSync(join(dir, rel));
    if (s.isFile() && s.mtimeMs > newest) newest = s.mtimeMs;
  }
  return newest;
}

/**
 * The one place both spawning test files decide whether to build. The property is CURRENCY, not
 * presence: a dist entry that merely EXISTS but predates a source edit spawns yesterday's binary,
 * and the assertion diff that follows reads as a command-line regression (it bit 2.1.3 — a verb's
 * help text had moved in source and not in the build). Release CI builds before it tests, so only a
 * local run on a behind build tree can see this class. Build when the entry is missing OR older than
 * the newest source file; returns whether it built. The seams exist for the currency drills in
 * cli.test.ts — real callers pass nothing.
 */
export function prepareBuiltCli(opts: { entry?: string; srcDir?: string; build?: () => void } = {}): boolean {
  const entry = opts.entry ?? ENTRY;
  const entryMtimeMs = statSync(entry, { throwIfNoEntry: false })?.mtimeMs;
  if (entryMtimeMs !== undefined && newestMtimeMs(opts.srcDir ?? SRC) <= entryMtimeMs) return false;
  (opts.build ?? (() => execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" })))();
  return true;
}

export interface BuiltCliResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  error?: Error;
  durationMs: number;
}

export function spawnCli(args: string[]): BuiltCliResult {
  const start = Date.now();
  const r = spawnSync(process.execPath, [process.env.TICKMARKR_BUILT_CLI_ENTRY || "", ...args], { encoding: "utf8" });
  const durationMs = Date.now() - start;
  return {
    status: r.status,
    signal: r.signal,
    stderr: r.stderr || "",
    stdout: r.stdout || "",
    error: r.error,
    durationMs,
  };
}

export function assertCliSuccess(r: BuiltCliResult, testCase: string): void {
  if (r.status !== 0 || r.error) {
    const msg = [
      `built CLI failed: ${testCase}`,
      `exit status: ${r.status}`,
      `signal: ${r.signal || "none"}`,
      `elapsed: ${r.durationMs}ms`,
      r.error ? `spawn error: ${r.error.message}` : "",
      r.stderr ? `stderr:\n${r.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    expect.fail(msg);
  }
}

export function assertCliExit(r: BuiltCliResult, expectedStatus: number, testCase: string): void {
  if (r.status !== expectedStatus || r.error) {
    const msg = [
      `built CLI exit mismatch: ${testCase}`,
      `expected: ${expectedStatus}, got: ${r.status}`,
      `signal: ${r.signal || "none"}`,
      `elapsed: ${r.durationMs}ms`,
      r.error ? `spawn error: ${r.error.message}` : "",
      r.stderr ? `stderr:\n${r.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    expect.fail(msg);
  }
}
