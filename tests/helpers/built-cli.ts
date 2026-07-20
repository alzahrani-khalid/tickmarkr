import { spawnSync } from "node:child_process";
import { expect } from "vitest";

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
