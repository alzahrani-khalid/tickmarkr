import type { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { readDoctor, writeDoctor } from "../../src/adapters/registry.js";
import type { AuthHealth, WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { verify } from "../../src/cli/commands/verify.js";
import {
  parsePsIdentity, resetLaunchServicesProbeForTests, setLaunchServicesProbeForTests,
} from "../../src/run/launchservices-check.js";
import { COMMIT, makeRepo } from "../helpers/tmprepo.js";

const LSD = "/System/Library/CoreServices/launchservicesd";
const PRIOR = { pid: 377, start: "Wed Sep 30 21:54:33 2026" };
const psRow = (pid: number, start: string) => `  ${pid} ${start}     ${LSD}\n    1 Wed Sep 30 21:50:00 2026     /sbin/launchd\n`;

// A /bin/ps stand-in: stdout + exit code, released on the next turn. Every spawn is counted.
function fakePs(stdout: string, code = 0) {
  const calls: string[][] = [];
  const fn = ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
    child.stdout.on("end", () => child.emit("close", code, null));
    setImmediate(() => child.stdout.end(stdout));
    return child;
  }) as unknown as typeof spawn;
  return { fn, calls };
}

const stub = { id: "fixture", vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }) } as unknown as WorkerAdapter;
const held = (repo: string) => Object.values(readDoctor(repo) ?? {}).flatMap((h) => h.launchServices ? [h.launchServices] : []);
const strip = (repo: string) => Object.fromEntries(Object.entries(readDoctor(repo) ?? {}).map(([id, { launchServices: _, ...h }]) => [id, h]));

afterEach(() => { resetLaunchServicesProbeForTests(); vi.restoreAllMocks(); });

test("doctor/standalone verify persist one advisory from the closed Darwin identity table changed-pid/changed-start/unchanged/unreadable/non-Darwin; verdict/retry decisions remain equal", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const table = [
    { row: "changed-pid", platform: "darwin", ps: fakePs(psRow(412, "Thu Oct  1 09:12:05 2026")), want: { pid: 412, start: "Thu Oct 1 09:12:05 2026" }, advisory: true },
    { row: "changed-start", platform: "darwin", ps: fakePs(psRow(377, "Thu Oct  1 09:12:05 2026")), want: { pid: 377, start: "Thu Oct 1 09:12:05 2026" }, advisory: true },
    { row: "unchanged", platform: "darwin", ps: fakePs(psRow(PRIOR.pid, PRIOR.start)), want: PRIOR, advisory: false },
    { row: "unreadable", platform: "darwin", ps: fakePs("", 1), want: PRIOR, advisory: false },
    { row: "non-Darwin", platform: "linux", ps: fakePs(psRow(412, "Thu Oct  1 09:12:05 2026")), want: PRIOR, advisory: false },
  ] as const;

  // doctor: the identity rides the FIRST doctor.json record; no other record or state file appears.
  const doctorRepo = makeRepo({ "keep.txt": "x" });
  let doctorReference: Record<string, unknown> | undefined;
  for (const r of table) {
    writeDoctor(doctorRepo, { fixture: { installed: true, authed: true, models: [], launchServices: PRIOR } });
    r.ps.calls.length = 0;
    setLaunchServicesProbeForTests({ platform: r.platform, spawn: r.ps.fn });
    const out = await doctor(["--"], doctorRepo, [stub], { banner: false });
    const records = held(doctorRepo);
    expect(records, r.row).toHaveLength(1);
    const { advisory, ...identity } = records[0]!;
    expect(identity, r.row).toEqual(r.want);
    expect(advisory !== undefined, r.row).toBe(r.advisory);
    expect(out.includes("launchservicesd restarted"), r.row).toBe(r.advisory);
    if (r.advisory) expect(advisory).toContain(`pid ${PRIOR.pid} → ${r.want.pid}`);
    if (r.row === "unreadable") expect(out).toContain("launchservicesd identity unknown");
    expect(r.ps.calls.length, r.row).toBe(r.platform === "darwin" ? 1 : 0); // one bounded read, never a retry
    expect(Object.keys(readDoctor(doctorRepo)!), r.row).toEqual(["fixture"]);
    doctorReference ??= strip(doctorRepo);
    expect(strip(doctorRepo), r.row).toEqual(doctorReference); // every non-advisory verdict is the same
  }
  // the advisory survives the next doctor write when the identity holds
  const after = fakePs(psRow(412, "Thu Oct  1 09:12:05 2026"));
  writeDoctor(doctorRepo, { fixture: { installed: true, authed: true, models: [], launchServices: PRIOR } });
  setLaunchServicesProbeForTests({ platform: "darwin", spawn: table[0].ps.fn });
  await doctor(["--"], doctorRepo, [stub], { banner: false });
  setLaunchServicesProbeForTests({ platform: "darwin", spawn: after.fn });
  await doctor(["--"], doctorRepo, [stub], { banner: false });
  expect(held(doctorRepo)).toEqual([expect.objectContaining({ pid: 412, advisory: expect.stringContaining("launchservicesd restarted") })]);

  // standalone verify: same table, same persisted record, and the verdict equal to an unprobed run.
  const verifyRepo = makeRepo({
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "sh check.sh" } }),
    "check.sh": "grep -q GOOD src.txt\n",
    "src.txt": "GOOD\n",
  });
  execSync("git checkout -q -b feature", { cwd: verifyRepo });
  writeFileSync(join(verifyRepo, "src.txt"), "GOOD\nmore\n");
  execSync(`${COMMIT} change`, { cwd: verifyRepo });
  const fake: AuthHealth = { installed: false, authed: false, models: [] };
  writeDoctor(verifyRepo, { fake: { ...fake, launchServices: PRIOR } });
  const verdict = (v: { out: string; code: number }) => ({ code: v.code, rows: v.out.split("\n").filter((l) => /^(PASS|FAIL) /.test(l)) });
  resetLaunchServicesProbeForTests();
  const reference = verdict(await verify(["--no-review"], verifyRepo)); // the seam is off: no probe
  expect(reference.code).toBe(0);
  expect(held(verifyRepo)).toEqual([PRIOR]);
  for (const r of table) {
    writeDoctor(verifyRepo, { fake: { ...fake, launchServices: PRIOR } });
    r.ps.calls.length = 0;
    setLaunchServicesProbeForTests({ platform: r.platform, spawn: r.ps.fn });
    const result = await verify(["--no-review"], verifyRepo);
    expect(verdict(result), r.row).toEqual(reference);
    const records = held(verifyRepo);
    expect(records, r.row).toHaveLength(1);
    const { advisory, ...identity } = records[0]!;
    expect(identity, r.row).toEqual(r.want);
    expect(advisory !== undefined, r.row).toBe(r.advisory);
    expect(r.ps.calls.length, r.row).toBe(r.platform === "darwin" ? 1 : 0);
    expect(Object.keys(readDoctor(verifyRepo)!), r.row).toEqual(["fake"]);
  }
  // with no doctor.json there is nothing to persist into, and none is created
  rmSync(join(verifyRepo, ".tickmarkr", "doctor.json"));
  setLaunchServicesProbeForTests({ platform: "darwin", spawn: table[0].ps.fn });
  expect(verdict(await verify(["--no-review"], verifyRepo))).toEqual(reference);
  expect(readDoctor(verifyRepo)).toBeNull();
}, 120_000);

test("a /bin/ps listing with no or two launchservicesd rows is no identity", () => {
  expect(parsePsIdentity(psRow(377, "Wed Sep 30 21:54:33 2026"))).toEqual(PRIOR);
  expect(parsePsIdentity("    1 Wed Sep 30 21:50:00 2026     /sbin/launchd\n")).toBeNull();
  expect(parsePsIdentity(psRow(377, PRIOR.start) + psRow(412, PRIOR.start))).toBeNull();
  expect(parsePsIdentity("")).toBeNull();
});
