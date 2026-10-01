import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { AuthHealth, LaunchServicesRecord } from "../adapters/types.js";

/**
 * v2.6.5 T10 (A1, D-787/D-789): did launchservicesd restart since tickmarkr last looked?
 *
 * On 2026-09-30 a heavy local suite exhausted launchservicesd's Mach port space (0x1000600b); the daemon
 * crashed, respawned with an empty app registry, and every GUI app launched before it read "not open
 * anymore". The tell is the daemon's own identity: a young pid/start beside an old Dock and Finder.
 * doctor and standalone verify read that identity with one bounded /bin/ps call, compare it with the
 * one the FIRST doctor.json record holds (registry order — no new state file or adapter row), and
 * persist one advisory on a change. Unreadable evidence is unknown: the prior identity is kept, never
 * replaced by a guess. Advisory only — verdicts, retries and routing never read it.
 */
export const LAUNCHSERVICES_PROBE_CEILING_MS = 5_000;
// lstart in the C locale: "Wed Sep 30 21:54:33 2026"; comm is the executable path on Darwin.
const PS_ARGS = ["-A", "-o", "pid=,lstart=,comm="];
const PS_LINE = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;
const MAX_PS_BYTES = 4 * 1024 * 1024;

export interface LaunchServicesIdentity { pid: number; start: string }
export type LaunchServicesObservation =
  | { status: "non-darwin" }
  | { status: "read"; identity: LaunchServicesIdentity }
  | { status: "unreadable"; detail: string };
/** The closed identity table; "first" is the baseline row when no prior identity is held. */
export type LaunchServicesStatus = "first" | "unchanged" | "changed-pid" | "changed-start" | "unreadable" | "non-darwin" | "skipped";

/** Exactly one launchservicesd row, or null (absent, ambiguous or malformed output is unknown). */
export function parsePsIdentity(stdout: string): LaunchServicesIdentity | null {
  const rows = stdout.split("\n").flatMap((line) => {
    const m = PS_LINE.exec(line);
    return m && basename(m[3]!) === "launchservicesd" ? [{ pid: Number(m[1]), start: m[2]!.replace(/\s+/g, " ") }] : [];
  });
  return rows.length === 1 ? rows[0]! : null;
}

export type ProbeTimer = (fire: () => void, ms: number) => () => void;
interface ProbeSeam { platform: NodeJS.Platform; spawn: typeof spawn; setTimer: ProbeTimer; signal?: AbortSignal }
const production = (): ProbeSeam => ({
  platform: process.platform,
  spawn,
  setTimer: (fire, ms) => { const t = setTimeout(fire, ms); return () => clearTimeout(t); },
});
// ponytail: default-off under the test runner (the catalogRefreshAllowed precedent) so an unowned doctor
// test never takes a real host reading or changes its doctor.json bytes; tests opt in through the seam.
let seam: ProbeSeam | undefined;
export const setLaunchServicesProbeForTests = (s: Partial<ProbeSeam>): void => { seam = { ...production(), ...s }; };
export const resetLaunchServicesProbeForTests = (): void => { seam = undefined; };
const activeSeam = (): ProbeSeam | undefined => seam ?? (process.env.VITEST === "true" ? undefined : production());

/** One /bin/ps call that owns only its child, killed at the ceiling or on cancellation and reaped before it resolves. */
function readIdentity(s: ProbeSeam): Promise<LaunchServicesObservation> {
  return new Promise((resolve) => {
    const unknown = (detail: string) => resolve({ status: "unreadable", detail });
    if (s.signal?.aborted) { unknown("probe cancelled"); return; }
    let child: ReturnType<typeof spawn>;
    try {
      child = s.spawn("/bin/ps", PS_ARGS, { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });
    } catch (e) {
      unknown(`/bin/ps did not start (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    let out = "";
    let why: string | undefined;
    const retire = (reason: string) => { why ??= reason; child.kill("SIGKILL"); };
    const clear = s.setTimer(() => retire(`/bin/ps exceeded the ${LAUNCHSERVICES_PROBE_CEILING_MS} ms kill ceiling`), LAUNCHSERVICES_PROBE_CEILING_MS);
    const cancel = () => retire("probe cancelled");
    s.signal?.addEventListener("abort", cancel, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > MAX_PS_BYTES) retire("/bin/ps output exceeded its bound");
    });
    child.once("error", (e) => { why ??= `/bin/ps failed (${e.message})`; });
    child.once("close", (code) => {
      clear();
      s.signal?.removeEventListener("abort", cancel);
      if (why) return unknown(why);
      if (code !== 0) return unknown(`/bin/ps exited ${code}`);
      const identity = parsePsIdentity(out);
      return identity ? resolve({ status: "read", identity }) : unknown("no single launchservicesd row in /bin/ps output");
    });
  });
}

export function observeLaunchServices(s: ProbeSeam = production()): Promise<LaunchServicesObservation> {
  return s.platform === "darwin" ? readIdentity(s) : Promise.resolve({ status: "non-darwin" });
}

// doctor.json is never schema-validated: a malformed held record is no identity at all.
const knownPrior = (prior: Partial<LaunchServicesRecord> | undefined): prior is LaunchServicesRecord =>
  typeof prior?.pid === "number" && typeof prior.start === "string";

export function launchServicesAdvisory(prior: LaunchServicesIdentity, now: LaunchServicesIdentity): string {
  return `launchservicesd restarted: pid ${prior.pid} → ${now.pid}, started ${prior.start} → ${now.start}. `
    + `GUI apps launched before ${now.start} may read "not open anymore" (D-787: the daemon crashed and respawned with an empty app registry). `
    + `Remedy: quit and relaunch each affected app, or log out / restart the Mac (a restart ends agent sessions and wipes /private/tmp); `
    + `confirm with /usr/bin/log show (launchservicesd 0x1000600b near ${now.start}) and ~/Library/Logs/DiagnosticReports/ExcUserFault_node-*.ips (advisory — verdicts unchanged)`;
}

/** Pure: the table row for one observation against the held record, and the record to hold next. */
export function classifyLaunchServices(prior: Partial<LaunchServicesRecord> | undefined, observed: LaunchServicesObservation): {
  status: LaunchServicesStatus; next?: LaunchServicesRecord; line?: string;
} {
  const kept = knownPrior(prior) ? prior : undefined;
  if (observed.status === "non-darwin") return { status: "non-darwin", next: kept };
  if (observed.status === "unreadable") {
    const held = kept ? `pid ${kept.pid} started ${kept.start}` : "none";
    return { status: "unreadable", next: kept, line: `launchservicesd identity unknown — ${observed.detail}; prior identity (${held}) retained (advisory — verdicts unchanged)` };
  }
  const now = observed.identity;
  if (!knownPrior(prior)) return { status: "first", next: now };
  const status = prior.pid !== now.pid ? "changed-pid" : prior.start !== now.start ? "changed-start" : "unchanged";
  if (status === "unchanged") return { status, next: prior };
  const advisory = launchServicesAdvisory(prior, now);
  return { status, next: { ...now, advisory }, line: advisory };
}

/** Observe, classify against the first record of `prior`, and hold the result on the first record of `health`.
 *  Returns `health` itself when nothing changed, else a copy — the argument is never mutated. */
export async function recordLaunchServices(prior: Record<string, AuthHealth> | null, health: Record<string, AuthHealth>): Promise<{
  status: LaunchServicesStatus; health: Record<string, AuthHealth>; line?: string;
}> {
  const held = prior ? Object.values(prior)[0]?.launchServices : undefined;
  const s = activeSeam();
  const r = s ? classifyLaunchServices(held, await observeLaunchServices(s)) : { status: "skipped" as const, next: knownPrior(held) ? held : undefined };
  const holder = Object.keys(health)[0];
  if (!holder || !r.next || JSON.stringify(health[holder]!.launchServices) === JSON.stringify(r.next)) return { ...r, health };
  return { ...r, health: { ...health, [holder]: { ...health[holder]!, launchServices: r.next } } };
}
