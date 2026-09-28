import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { isolatedBuild } from "./isolated-build.js";
export const root = resolve(import.meta.dirname, "../../..");
export type ObserverSnapshot = { type: string; stdout: string; stderr: string; raw: boolean; presence: string[]; pid: number; result?: { out: string; code: number } };
export async function observer(repo: string, command: string, args: string[], tty = true, extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [join(root, "tests/fixtures/screen-soak/observer.mjs"), repo, command, JSON.stringify(args), String(tty)], {
    cwd: root, env: { ...process.env, ...extraEnv, C6_BUILD_ROOT: isolatedBuild() }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let latest: ObserverSnapshot | undefined, error = "";
  child.stderr!.on("data", data => { error = (error + String(data)).slice(-20000); });
  child.on("message", message => { latest = message as ObserverSnapshot; });
  const exited = once(child, "exit");
  // Imported here so frame regeneration can load this module outside vitest.
  const { expect } = await import("vitest");
  await expect.poll(() => latest ?? (child.exitCode !== null ? error || `exited ${child.exitCode}` : undefined), { timeout: 15000, interval: 20 }).toBeTruthy();
  return { child, exited, snapshot: () => latest!, error: () => error, send: (message: unknown) => child.send(message as object),
    close: async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; } },
  };
}
export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
}
/**
 * Frame replay of a sealed duration record: its own archived journal in a fresh repository, for the
 * production shell to draw now. It measures nothing and re-runs no soak; the record stays as captured.
 */
export function replaySoakRecord(record: string): { cwd: string; runId: string; raw: string; close: () => void } {
  const raw = gunzipSync(readFileSync(join(root, "tests/fixtures/screen-soak/records", record, "journal.jsonl.gz"))).toString("utf8");
  const cwd = mkdtempSync(join(tmpdir(), `screen-soak-replay-${record}-`));
  const runId = "run-screen-soak";
  mkdirSync(join(cwd, ".tickmarkr", "runs", runId), { recursive: true });
  writeFileSync(join(cwd, ".tickmarkr", "runs", runId, "journal.jsonl"), raw);
  return { cwd, runId, raw, close: () => rmSync(cwd, { recursive: true, force: true }) };
}
/** A replay's committed Run frame: beside the final shell frames, outside the measured soak corpus. */
export const replayFramePath = (record: string, columns: number, rows: number): string =>
  join(root, "tests/fixtures/cockpit/final", `soak-${record}.${columns}x${rows}.txt`);
export const REPLAYED_SOAK_RECORDS = ["final-static", "final-growth", "cutover-static", "cutover-growth"] as const;
