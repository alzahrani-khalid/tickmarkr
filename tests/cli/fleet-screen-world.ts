// What the fleet command's test files share: stub adapters, a hand-written doctor.json, a scratch
// repository with the command bound to it, and a terminal the Ink screen can be mounted on.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { allAdapters, writeDoctor } from "../../src/adapters/registry.js";
import type { AuthHealth } from "../../src/adapters/types.js";
import { fleetCommand, type FleetScreenIO } from "../../src/cli/commands/fleet-screen.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { makeRepo } from "../helpers/tmprepo.js";

export const adapters = allAdapters({ operatorYaml: null, operatorPath: false });
export function health(dead: string[] = [], extra: Record<string, string[]> = {}): Record<string, AuthHealth> {
  const out: Record<string, AuthHealth> = {};
  for (const [adapter, t] of Object.entries(DEFAULT_CONFIG.tiers)) {
    const models = [...Object.keys(t.models), ...(extra[adapter] ?? [])];
    out[adapter] = { installed: true, authed: true, models, modelAuth: Object.fromEntries(models.map((m) => [m, dead.includes(`${adapter}:${m}`)
      ? { authed: false, reason: "probe timed out (60000ms)", probedAt: new Date().toISOString() } : { authed: true, probedAt: new Date().toISOString() }])) };
  }
  return out;
}
export function setup(opts: { repo?: string; dead?: string[]; probe?: boolean } = {}) {
  const cwd = makeRepo({ "keep.txt": "x" });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-screen-"));
  mkdirSync(join(cwd, ".tickmarkr"), { recursive: true });
  if (opts.repo) writeFileSync(join(cwd, ".tickmarkr", "config.yaml"), opts.repo);
  if (opts.probe !== false) writeDoctor(cwd, health(opts.dead ?? ["claude-code:fable"]));
  const run = (argv: string[], io: FleetScreenIO = {}) => fleetCommand([...argv, "--global-dir", globalDir], cwd, adapters, { input: Object.assign(new PassThrough(), { isTTY: false }) as never, output: { isTTY: false, write: () => true }, ...io });
  return { cwd, globalDir, run, overlay: () => readFileSync(join(cwd, ".tickmarkr", "config.yaml"), "utf8") };
}
export const tty = { input: Object.assign(new PassThrough(), { isTTY: true }) as never, output: { isTTY: true, write: () => true } };

export const strip = (t: string) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
export function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => input, unref: () => input });
  const direct = input.write.bind(input);
  const pending: string[] = [];
  let pumping = false;
  const pump = () => { const c = pending.shift(); if (c === undefined) { pumping = false; return; } direct(c); setImmediate(pump); };
  input.write = ((chunk: string) => { pending.push(...(chunk.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? [])); if (!pumping) { pumping = true; setImmediate(pump); } return true; }) as typeof input.write;
  const writes: string[] = [];
  const waiters: Array<{ marker: string; resolve: () => void }> = [];
  const output = { isTTY: true, columns: 100, rows: 30, on: () => {}, off: () => {}, removeListener: () => {},
    write: (chunk: string) => {
      writes.push(chunk);
      for (let i = waiters.length - 1; i >= 0; i--) if (strip(chunk).includes(waiters[i].marker)) waiters.splice(i, 1)[0].resolve();
      return true;
    } };
  // a frame that never comes fails by name, with the last frame drawn, instead of at the test's timeout
  /** One chunk, unsplit: what a driver or fast typing delivers. */
  const burst = (chunk: string) => direct(chunk);
  const frame = (marker: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no frame containing "${marker}"; the last frame was:\n${strip(writes.filter((w) => w.length > 80).at(-1) ?? "")}`)), 8000);
    waiters.push({ marker, resolve: () => { clearTimeout(timer); resolve(); } });
  });
  return { input, output, frame, burst, text: () => writes.map(strip).join("\n") };
}
