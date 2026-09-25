import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { FILE_HANG_SLACK } from "../gates/test-manifest.js";

export const HOST_PROBE_SAMPLES = 3;
export const HOST_PROBE_SAMPLE_MS = 1_000;
export const HOST_LATENCY_FLOOR_MS = 50;
export const HOST_LATENCY_RATIO = FILE_HANG_SLACK;
export class HostDegradedError extends Error {}

// A probe owns just this child: no shell, descendants, inherited Node options, or host-wide kills.
let probeSpawn = spawn;
export const setHostProbeSpawnForTests = (fn: typeof spawn): void => { probeSpawn = fn; };
export const resetHostProbeSpawnForTests = (): void => { probeSpawn = spawn; };
const execLatency = (signal: AbortSignal, timeoutMs: number): Promise<number | null> => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const start = performance.now();
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  let child: ReturnType<typeof spawn>;
  try { child = probeSpawn(process.execPath, ["-e", ""], { stdio: "ignore", env }); }
  catch { resolve(null); return; }
  let unreadable = false;
  const retire = () => { unreadable = true; child.kill("SIGKILL"); };
  const timer = setTimeout(retire, timeoutMs);
  signal.addEventListener("abort", retire, { once: true });
  child.once("error", () => { unreadable = true; });
  // Resolve only after close: cancellation and timeout must reap the owned child before returning.
  child.once("close", code => {
    clearTimeout(timer);
    signal.removeEventListener("abort", retire);
    if (signal.aborted) reject(signal.reason);
    else {
      const elapsed = performance.now() - start;
      resolve(!unreadable && code === 0 && elapsed <= timeoutMs ? elapsed : null);
    }
  });
  if (signal.aborted) retire();
});
let sample = execLatency;
export const setHostLatencySampleForTests = (fn: typeof execLatency): void => { sample = fn; };
export const resetHostLatencySampleForTests = (): void => { sample = execLatency; };

export interface HostObservation { samplesMs: Array<number | null>; medianMs: number | null }
/** Three sequential samples, each bounded by 1s and the remaining observation budget. */
export async function observeHost(signal: AbortSignal, budgetMs = HOST_PROBE_SAMPLES * HOST_PROBE_SAMPLE_MS): Promise<HostObservation> {
  const deadline = performance.now() + budgetMs;
  const samplesMs: Array<number | null> = [];
  for (let i = 0; i < HOST_PROBE_SAMPLES; i++) {
    signal.throwIfAborted();
    const remaining = deadline - performance.now();
    const value = remaining > 0 ? await sample(signal, Math.min(HOST_PROBE_SAMPLE_MS, remaining)) : null;
    samplesMs.push(value !== null && Number.isFinite(value) && value > 0 ? value : null);
  }
  const medianMs = samplesMs.every((n): n is number => n !== null)
    ? [...samplesMs].sort((a, b) => a - b)[1]! : null;
  return { samplesMs, medianMs };
}
export const hostDegraded = (observation: HostObservation, referenceMs: number | undefined): boolean =>
  observation.medianMs === null || referenceMs === undefined
    || observation.medianMs >= Math.max(HOST_LATENCY_FLOOR_MS, referenceMs * HOST_LATENCY_RATIO);
