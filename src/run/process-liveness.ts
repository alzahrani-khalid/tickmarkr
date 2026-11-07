import { execFile } from "node:child_process";
import { harvestCpuFlatWindowMs, WorkerTreeCpuAccountant } from "./stall.js";

// Row 364; D-2184 add.31/add.44/add.45; D-2185 add.3: one reading for harvest, print workers and consults.
export type CpuLeg = { state: "flat"; cpu: { ms: number; resolutionMs: number } }
  | { state: "accruing" | "unmeasurable" };
export type ProcessLiveness = { state: "live"; leg: "connection" | "cpu" }
  | { state: "silent" } | { state: "unmeasurable"; leg: "connection" | "cpu" };
type CpuObservation = ReturnType<WorkerTreeCpuAccountant["read"]>;

/** The existing continuous, quantization-aware CPU leg; gaps always re-arm its flat window. */
export class CpuLegReader {
  private flat: { ms: number; since: number } | undefined;
  private gaps = 0;
  reset(): void { this.flat = undefined; this.gaps = 0; }
  read(observation: CpuObservation, now: number, unreadable: (reason: string) => void = () => {}): CpuLeg {
    if (observation.gaps !== this.gaps) {
      this.gaps = observation.gaps;
      this.flat = undefined;
      unreadable("one or more worker process snapshots could not be read");
    }
    const cpu = observation.cpu;
    if (cpu === undefined) {
      this.flat = undefined;
      unreadable("the worker process snapshot could not be read");
      return { state: "unmeasurable" };
    }
    if (cpu.ms !== this.flat?.ms) {
      this.flat = { ms: cpu.ms, since: now };
      return { state: "accruing" };
    }
    return now - this.flat.since < harvestCpuFlatWindowMs(cpu.resolutionMs)
      ? { state: "accruing" } : { state: "flat", cpu };
  }
}

export type ConnectionReading = "connected" | "none" | "unreadable";
/** Injectable probes; production never scans environment or terminals to guess ownership. */
export const processLivenessHost = {
  connection(group: number, timeoutMs: number): Promise<ConnectionReading> {
    return new Promise((resolve) => {
      try {
        // -a intersects selections; -g includes connector children in this owned process group.
        execFile("lsof", ["-nP", "-a", "-g", String(group), "-iTCP", "-sTCP:ESTABLISHED", "-Fp"],
          { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (!error && stdout.trim()) resolve("connected");
            else if (error && error.code === 1 && !stdout && !stderr) resolve("none");
            else resolve("unreadable");
          });
      } catch { resolve("unreadable"); }
    });
  },
};

export async function readOwnedProcessLiveness(group: number | undefined, cpu: CpuLeg, budgetMs = 15_000): Promise<ProcessLiveness> {
  const connection = group === undefined || budgetMs <= 0 ? "unreadable"
    : await processLivenessHost.connection(group, Math.max(1, Math.min(15_000, budgetMs))).catch(() => "unreadable" as const);
  if (connection === "connected") return { state: "live", leg: "connection" };
  if (cpu.state === "accruing") return { state: "live", leg: "cpu" };
  if (connection === "unreadable") return { state: "unmeasurable", leg: "connection" };
  return cpu.state === "unmeasurable" ? { state: "unmeasurable", leg: "cpu" } : { state: "silent" };
}

export interface LivenessTime { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export const livenessTime: LivenessTime = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  }),
};
