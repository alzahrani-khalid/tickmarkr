import type { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { readDoctor, writeDoctor } from "../../src/adapters/registry.js";
import type { WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { verify, verifyStateDir } from "../../src/cli/commands/verify.js";
import { LAUNCHSERVICES_PROBE_CEILING_MS, resetLaunchServicesProbeForTests, setLaunchServicesProbeForTests, type ProbeTimer } from "../../src/run/launchservices-check.js";
import { COMMIT, makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const PID = 412;
const identity = `  ${PID} Thu Oct  1 09:12:05 2026     /System/Library/CoreServices/launchservicesd\n`;
const top = (count: string, pid = PID) => `Processes: 10 total\nPID COMMAND #PORTS\n\n ${pid} launchservicesd ${count}\n`;
const adapter = { id: "fixture", vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }) } as unknown as WorkerAdapter;

function child(output: string | null, code = 0, killed?: (signal: NodeJS.Signals | number | undefined) => void) {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    kill: (signal?: NodeJS.Signals | number) => {
      killed?.(signal);
      setImmediate(() => process.emit("close", null, signal));
      return true;
    },
  });
  if (output !== null) {
    process.stdout.on("end", () => process.emit("close", code, null));
    setImmediate(() => process.stdout.end(output));
  }
  return process;
}

function transport(ps: string | null, topOutput: string | null, topCode = 0) {
  const calls: string[][] = [];
  const kills: Array<NodeJS.Signals | number | undefined> = [];
  const spawnPs = ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return child(ps);
  }) as typeof spawn;
  const spawnTop = ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return child(topOutput, topCode, (signal) => kills.push(signal));
  }) as typeof spawn;
  return { calls, kills, spawnPs, spawnTop };
}

const setDarwin = (t: ReturnType<typeof transport>, setTimer?: ProbeTimer) =>
  setLaunchServicesProbeForTests({ platform: "darwin", spawn: t.spawnPs, spawnTop: t.spawnTop, ...(setTimer ? { setTimer } : {}) });

function repoWithGate(marker: string): string {
  const repo = makeRepo({
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "sh check.sh" } }),
    "check.sh": `printf x >> '${marker}'\ngrep -q GOOD src.txt\n`,
    "src.txt": "GOOD\n",
  });
  execSync("git checkout -q -b feature", { cwd: repo });
  writeFileSync(join(repo, "src.txt"), "GOOD\nmore\n");
  execSync(`${COMMIT} change`, { cwd: repo });
  return repo;
}

afterEach(() => { resetLaunchServicesProbeForTests(); vi.restoreAllMocks(); });

test("test: through production doctor on darwin a top count of 100000 or 100000+ for the launchservicesd pid prints the pid and the count as an attention row versus 99999 or 99999- printing it as an ordinary row and +200000 or 200000++ or 200000x or an extra column or another pid printing the count unknown", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const repo = makeRepo({ "keep.txt": "x" });
  for (const [row, output, glyph, value] of [
    ["boundary", top("100000"), "!", "100000"],
    ["up mark", top("100000+"), "!", "100000"],
    ["below", top("99999"), "✓", "99999"],
    ["down mark", top("99999-"), "✓", "99999"],
    ["prefix", top("+200000"), "!", "unknown"],
    ["double mark", top("200000++"), "!", "unknown"],
    ["letter", top("200000x"), "!", "unknown"],
    ["extra column", top("200000").replace("launchservicesd 200000", "launchservicesd 200000 extra"), "!", "unknown"],
    ["other pid", top("200000", 413), "!", "unknown"],
    ["nonzero", top("200000"), "!", "unknown"],
    ["header missing", "PID COMMAND PORTS\n412 launchservicesd 200000\n", "!", "unknown"],
  ] as const) {
    const t = transport(identity, output, row === "nonzero" ? 1 : 0);
    setDarwin(t);
    const out = await doctor(["--"], repo, [adapter], { banner: false });
    const line = out.split("\n").find((s) => s.includes("launchservicesd pid"));
    expect(line, row).toContain(`pid ${PID}`);
    expect(line, row).toContain(value === "unknown" ? "ports unknown" : `${value} ports`);
    expect(line?.trimStart().startsWith(glyph), row).toBe(true);
    expect(t.calls, row).toEqual([
      ["/bin/ps", "-A", "-o", "pid=,lstart=,comm="],
      ["/usr/bin/top", "-l", "1", "-stats", "pid,command,ports", "-pid", String(PID)],
    ]);
  }
}, 120_000);

test("test: through production verify a count of 200000 or 200000+ refuses with exit 1 naming the count and the logout remedy before any baseline or gate command runs versus 199999 or 199999- and the unknown +200000 or 200000++ or 200000x or extra column each running every gate to the same verdict as an unprobed verify", async () => {
  const diagnostics: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => { diagnostics.push(String(line)); });
  for (const count of ["200000", "200000+"]) {
    diagnostics.length = 0;
    const refusedMarker = join(makeTestTempDir("tickmarkr-ports-refuse-"), "gate.log");
    const refusedRepo = repoWithGate(refusedMarker);
    const t = transport(identity, top(count));
    setDarwin(t);
    const r = await verify(["--no-review"], refusedRepo);
    expect(r.code).toBe(1);
    expect(r.out).toContain("200000");
    expect(r.out).toContain("threshold 200000");
    expect(r.out).toMatch(/log out or restart to reset launchservicesd/);
    expect(diagnostics.filter((line) => line.startsWith("verify: ports "))).toEqual(["verify: ports 200000"]);
    expect(existsSync(refusedMarker)).toBe(false);
    expect(existsSync(verifyStateDir(refusedRepo))).toBe(false);
    expect(t.calls).toHaveLength(2);
  }
  const verdict = (r: { out: string; code: number }) => ({ code: r.code, rows: r.out.split("\n").filter((s) => /^(PASS|FAIL) /.test(s)) });
  // Keep the real verify and gate command path; the sandbox denies only the lease's process census.
  vi.doMock("../../src/run/lease.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../../src/run/lease.js")>(),
    withRepositoryLease: async (_cwd: string, run: () => Promise<unknown>) => run(),
  }));
  vi.resetModules();
  try {
    const { verify: gateVerify } = await import("../../src/cli/commands/verify.js");
    const { setLaunchServicesProbeForTests: setGateProbe, resetLaunchServicesProbeForTests: resetGateProbe } = await import("../../src/run/launchservices-check.js");
    resetGateProbe();
    const referenceMarker = join(makeTestTempDir("tickmarkr-ports-reference-"), "gate.log");
    const reference = verdict(await gateVerify(["--no-review"], repoWithGate(referenceMarker)));
    expect(reference.code).toBe(0);
    expect(reference.rows).toContain("PASS test");
    for (const [row, output] of [
      ["below", top("199999")], ["down mark", top("199999-")],
      ["prefix", top("+200000")], ["double mark", top("200000++")],
      ["letter", top("200000x")], ["extra column", top("200000 extra")],
    ] as const) {
      diagnostics.length = 0;
      const t = transport(identity, output);
      setGateProbe({ platform: "darwin", spawn: t.spawnPs, spawnTop: t.spawnTop });
      const marker = join(makeTestTempDir("tickmarkr-ports-gate-"), "gate.log");
      expect(verdict(await gateVerify(["--no-review"], repoWithGate(marker))), row).toEqual(reference);
      expect(readFileSync(marker, "utf8").length, row).toBeGreaterThan(0);
      expect(diagnostics.filter((line) => line.startsWith("verify: ports ")), row)
        .toEqual([`verify: ports ${row === "below" || row === "down mark" ? "199999" : "unknown"}`]);
      expect(t.calls, row).toHaveLength(2);
    }
    // The pre-run pid selects top's row; the advisory still compares a fresh identity after the gates.
    const restartedMarker = join(makeTestTempDir("tickmarkr-ports-restart-"), "gate.log");
    const restartedRepo = repoWithGate(restartedMarker);
    writeDoctor(restartedRepo, { fake: { installed: false, authed: false, models: [],
      launchServices: { pid: 377, start: "Wed Sep 30 21:54:33 2026" } } });
    const restartCalls: string[][] = [];
    let psReads = 0;
    const restartPs = ((cmd: string, args: string[]) => {
      restartCalls.push([cmd, ...args]);
      return child(++psReads === 1
        ? "  377 Wed Sep 30 21:54:33 2026     /System/Library/CoreServices/launchservicesd\n"
        : identity);
    }) as typeof spawn;
    const restartTop = ((cmd: string, args: string[]) => {
      restartCalls.push([cmd, ...args]);
      return child(top("1234", 377));
    }) as typeof spawn;
    setGateProbe({ platform: "darwin", spawn: restartPs, spawnTop: restartTop });
    expect(verdict(await gateVerify(["--no-review"], restartedRepo))).toEqual(reference);
    expect(readFileSync(restartedMarker, "utf8").length).toBeGreaterThan(0);
    expect(restartCalls.map((call) => call[0])).toEqual(["/bin/ps", "/usr/bin/top", "/bin/ps"]);
    expect(restartCalls[1]?.at(-1)).toBe("377");
    expect(readDoctor(restartedRepo)?.fake?.launchServices).toMatchObject({ pid: 412,
      advisory: expect.stringContaining("launchservicesd restarted") });
    resetGateProbe();
  } finally {
    vi.doUnmock("../../src/run/lease.js");
    vi.resetModules();
  }
}, 120_000);

test("test: a top child that never returns is killed with SIGKILL at the 5000 ms ceiling and reaped and read unknown without a retry versus a released row completing on its one spawn and an off-darwin doctor printing not applicable while spawning neither ps nor top", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const repo = makeRepo({ "keep.txt": "x" });
  const armed: number[] = [];
  let timers = 0;
  const clock: ProbeTimer = (fire, ms) => {
    armed.push(ms);
    timers += 1;
    if (timers === 2) setImmediate(fire);
    return () => undefined;
  };
  const stuck = transport(identity, null);
  setDarwin(stuck, clock);
  const unknown = await doctor(["--"], repo, [adapter], { banner: false });
  expect(LAUNCHSERVICES_PROBE_CEILING_MS).toBe(5000);
  expect(armed).toEqual([5000, 5000]);
  expect(stuck.kills).toEqual(["SIGKILL"]);
  expect(stuck.calls).toHaveLength(2);
  expect(unknown).toContain(`pid ${PID}: ports unknown`);

  const released = transport(identity, top("5036"));
  setDarwin(released);
  const known = await doctor(["--"], repo, [adapter], { banner: false });
  expect(known).toContain(`pid ${PID}: 5036 ports`);
  expect(released.calls).toHaveLength(2);
  expect(released.kills).toEqual([]);

  const off = transport(identity, top("200000"));
  setLaunchServicesProbeForTests({ platform: "linux", spawn: off.spawnPs, spawnTop: off.spawnTop });
  const na = await doctor(["--"], repo, [adapter], { banner: false });
  expect(na).toContain("launchservicesd ports: not applicable");
  expect(off.calls).toEqual([]);
}, 120_000);

test("test: an unreadable launchservicesd identity spawns no top and reads the count unknown versus a readable identity spawning exactly one top for its own pid", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const repo = makeRepo({ "keep.txt": "x" });
  const unreadable = transport("", top("200000"));
  setDarwin(unreadable);
  const unknown = await doctor(["--"], repo, [adapter], { banner: false });
  expect(unknown).toContain("launchservicesd pid unknown: ports unknown");
  expect(unreadable.calls.map((c) => c[0])).toEqual(["/bin/ps"]);

  const readable = transport(identity, top("1234"));
  setDarwin(readable);
  const known = await doctor(["--"], repo, [adapter], { banner: false });
  expect(known).toContain(`pid ${PID}: 1234 ports`);
  expect(readable.calls.map((c) => c[0])).toEqual(["/bin/ps", "/usr/bin/top"]);
  expect(readable.calls[1]?.at(-1)).toBe(String(PID));
}, 120_000);

test("Cite the changed comment beside the port-count read in src/run/launchservices-check.ts stating the closed top format, the 100000 advisory and 200000 stop thresholds and that an unknown count never stops versus the base comment that the identity read is advisory only", () => {
  const source = readFileSync(new URL("../../src/run/launchservices-check.ts", import.meta.url), "utf8");
  const comment = source.slice(source.indexOf("// The captured macOS top layout"), source.indexOf("function readPortCount"));
  expect(comment).toContain("closed");
  expect(comment).toContain("100000");
  expect(comment).toContain("200000");
  expect(comment).toContain("Unknown");
  expect(comment).toContain("never stops");
});
