import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { expect } from "vitest";
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
  await expect.poll(() => latest ?? (child.exitCode !== null ? error || `exited ${child.exitCode}` : undefined), { timeout: 15000, interval: 20 }).toBeTruthy();
  return { child, exited, snapshot: () => latest!, error: () => error, send: (message: unknown) => child.send(message as object),
    close: async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; } },
  };
}
export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
}
