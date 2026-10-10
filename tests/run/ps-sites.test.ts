import { execSync, spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { shq } from "../../src/adapters/types.js";
import * as daemon from "../../src/run/daemon.js";
import { GitTrustRefusal } from "../../src/run/git-trust.js";
import { resetSpawnForTests, setSpawnForTests } from "../../src/run/git.js";
import * as stall from "../../src/run/stall.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// Queue row 113 lever 1' (D-1686): the six process-table snapshots take the payload shell entry instead of the own-git
// entry, whose linked-checkout pin probes were two SYNC git spawns per call on the daemon's event loop. This file is its
// own base control: the parity rows (M, E, T) are green at the base and after; G1 (no git spawn) is red at the base, and
// G1b (the process-tree observation) is red there by a missing export.
// The sampler's Linux branch (/proc CPU, a once-per-process `getconf CLK_TCK`) is gated on /proc/self/stat. That gate is
// off here until G1 opens it, so on every host the clock-tick read is still cold when G1 records git (r2, D-1690).
const proc = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = ((path: unknown) => path === "/proc/self/stat" ? proc.on : actual.existsSync(path as string)) as typeof actual.existsSync;
  return { ...actual, default: { ...actual, existsSync }, existsSync };
});
interface Row { pid: number; ppid: number; pgid: number; stat?: string; time?: string; command: string }
let table: Row[] = [];
const psCalls: string[] = [];
const spawnCalls: string[] = []; // every spawn through the seam: a `bash -c` line as is, any other command as its argv
const render = (words: string[]) => {
  const spec = words.find((w) => /^[a-z]+=(,[a-z]+=)*$/.test(w))!;
  const only = words.includes("-p") ? Number(words[words.indexOf("-p") + 1]) : undefined;
  const cell = (r: Row, column: string) => ({ pid: r.pid, ppid: r.ppid, pgid: r.pgid, stat: r.stat ?? "S", state: r.stat ?? "S",
    time: r.time ?? "0:00.10", command: r.command } as Record<string, string | number>)[column];
  return table.filter((r) => only === undefined || r.pid === only)
    .map((r) => `  ${spec.split(",").map((c) => String(cell(r, c.slice(0, -1)))).join("  ")}`).join("\n") + "\n";
};
// One fake process table behind the shared spawn seam, answering `bash -c "ps …"` (both entries spawn bash); every other
// spawn is real.
const serveTable = () => setSpawnForTests(((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
  spawnCalls.push(command === "bash" && args[1] !== undefined ? args[1] : [command, ...args].join(" "));
  const line = command === "bash" && /^ps /.test(args[1] ?? "") ? args[1]! : undefined;
  if (line === undefined) return realSpawn(command, args, options);
  psCalls.push(line);
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 9_299_000 + psCalls.length,
    kill: () => true });
  setImmediate(() => {
    child.emit("spawn");
    child.stdout.on("end", () => setImmediate(() => { child.emit("exit", 0, null); child.emit("close", 0, null); }));
    child.stdout.end(render(line.split(/\s+/).slice(1)));
    child.stderr.end();
  });
  return child;
}) as unknown as Parameters<typeof setSpawnForTests>[0]);
afterEach(() => { resetSpawnForTests(); vi.unstubAllEnvs(); table = []; psCalls.length = 0; spawnCalls.length = 0; proc.on = false; });

const MARKER = "/tmp/tickmarkr-dispatch-row113.sh";
const GROUP = 9_300_001;
// The dispatch root and its child; a reparented group member with no marker (M1); a row whose ARGV holds the group's
// digits (M3); a group member whose time cell is unreadable (M4) and that member's own child in another group.
const workerTable = (): Row[] => [
  { pid: process.pid, ppid: 1, pgid: 1, command: "node test-host" },
  { pid: 9_300_001, ppid: 1, pgid: GROUP, time: "0:01.00", command: `bash ${MARKER}` },
  { pid: 9_300_002, ppid: 9_300_001, pgid: GROUP, time: "0:02.00", command: "node agent --task T1" },
  { pid: 9_300_003, ppid: 1, pgid: GROUP, time: "0:04.00", command: "tool reparented-after-root-exit" },
  { pid: 9_300_005, ppid: 1, pgid: 555, time: "0:16.00", command: `x ${GROUP} ${GROUP} 0:16.00` },
  { pid: 9_300_006, ppid: 9_300_001, pgid: GROUP, time: "??", command: "unreadable-time member" },
  { pid: 9_300_007, ppid: 9_300_006, pgid: 888, time: "0:32.00", command: "grandchild of the unreadable member" },
];
const sampleOnce = async (group?: number) => {
  const accountant = new stall.WorkerTreeCpuAccountant(MARKER, makeTestTempDir("tickmarkr-ps-sites-"), () => group);
  try { await accountant.start(); return accountant.read().cpu?.ms; } finally { await accountant.stop(); }
};
// A linked checkout shaped like a task worktree: `git worktree add`, no config.worktree (D-1686 (b)).
const linkedCheckout = () => {
  const repo = makeRepo({ "a.txt": "a\n" });
  const linked = join(makeTestTempDir("tickmarkr-ps-linked-"), "wt");
  execSync(`git worktree add -q --detach ${shq(linked)}`, { cwd: repo });
  const gitdir = execSync("git rev-parse --absolute-git-dir", { cwd: linked, encoding: "utf8" }).trim();
  return { repo, linked, gitdir };
};
// Records every git process spawned while it is installed, by PATH.
const recordGit = () => {
  const bin = makeTestTempDir("tickmarkr-ps-gitlog-");
  const log = join(bin, "git.log");
  const realGit = execSync("command -v git", { encoding: "utf8", shell: "/bin/sh" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "git $*" >> ${shq(log)}\nexec ${shq(realGit)} "$@"\n`, { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  return () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
};

test("test: the CPU sampler with a recorded group counts the marker root, its ppid closure, a reparented group member with no marker, and the child of a group member whose own time is unreadable, and never a row whose argv merely holds the group's digits — 1+2+4+32 s (M1-M4)", async () => {
  table = workerTable();
  serveTable();
  expect(await sampleOnce(GROUP)).toBe(39_000);
});

test("test: the CPU sampler with no recorded group counts only the marker root and its ppid closure — no group member and no child of an unreadable row (M5, E-S3)", async () => {
  table = workerTable();
  serveTable();
  expect(await sampleOnce(undefined)).toBe(3_000);
  expect((await stall.workerTreeCpuMs(MARKER, makeTestTempDir("tickmarkr-ps-sites-")))?.ms).toBe(3_000);
});

test("test: confirming a group reap reads the process table and reports the group's live member while dropping its zombie (E-S1, E-S2)", async () => {
  table = [
    { pid: process.pid, ppid: 1, pgid: 1, command: "node test-host" },
    { pid: 9_300_801, ppid: 1, pgid: 9_300_777, stat: "S", command: "still running" },
    { pid: 9_300_802, ppid: 1, pgid: 9_300_777, stat: "Z", command: "<defunct>" },
  ];
  serveTable();
  // a group id above every pid_max: the real group kill finds nothing and the confirmation reads the table above
  expect(await stall.reapOwnedProcessGroup(9_300_777, makeTestTempDir("tickmarkr-ps-sites-"))).toEqual([9_300_801]);
});

test("test: the live-suite census over a process table holding no test runner counts zero (E-S6)", async () => {
  table = workerTable();
  serveTable();
  expect(await daemon.liveSuiteCount(makeTestTempDir("tickmarkr-ps-sites-"))).toBe(0);
  expect(psCalls.some((call) => call.includes("pid=,ppid=,state=,command="))).toBe(true);
});

test("test: in a linked checkout shaped like a task worktree, the CPU sampler with its group — its first, cold clock-tick read with /proc present included — the group reap and its confirmation, and the live-suite census spawn no git at all (G1)", async () => {
  const { linked } = linkedCheckout();
  table = workerTable();
  serveTable();
  const gitCalls = recordGit();
  proc.on = true;
  const before = psCalls.length;
  const accountant = new stall.WorkerTreeCpuAccountant(MARKER, linked, () => GROUP);
  try { await accountant.start(); } finally { await accountant.stop(); }
  await stall.reapOwnedProcessGroup(9_300_777, linked);
  await daemon.liveSuiteCount(linked);
  expect(psCalls.length).toBeGreaterThan(before); // the snapshots ran: an empty git log is not a skipped probe
  expect(spawnCalls.filter((line) => line === "getconf CLK_TCK")).toHaveLength(1); // and the cold read ran inside the window
  expect(gitCalls()).toEqual([]);
});

test("test: in that linked checkout the worker process-tree observation reads the table and spawns no git (G1b)", async () => {
  const { linked } = linkedCheckout();
  table = workerTable();
  serveTable();
  const gitCalls = recordGit();
  expect(await daemon.observeWorkerProcessTree(MARKER, linked)).not.toBe("unmeasurable");
  expect(psCalls.some((call) => call.includes("pid=,ppid=,command="))).toBe(true);
  expect(gitCalls()).toEqual([]);
});

// D-1686 (a): every git-trust refusal the own-git entry raised for a snapshot is raised identically by the payload entry —
// both run the same checkedAuthority before any spawn. The one that goes away is the ref-store pin probe's "could not
// tell … twice" refusal: that probe is the own-git entry's alone and says nothing about `ps`.
const sites = (linked: string) => [() => stall.workerTreeCpuMs(MARKER, linked), () => stall.reapOwnedProcessGroup(9_300_777, linked),
  () => daemon.liveSuiteCount(linked)];
const refusedAtEverySite = async (linked: string, refusal: RegExp) => {
  for (const site of sites(linked)) {
    const error = await site().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(GitTrustRefusal);
    expect((error as Error).message).toMatch(refusal);
  }
};
const hostile: [string, (c: ReturnType<typeof linkedCheckout>) => void, RegExp][] = [
  ["a missing commondir", ({ gitdir }) => rmSync(join(gitdir, "commondir")), /commondir: is missing/],
  ["a symlinked commondir", ({ gitdir }) => { renameSync(join(gitdir, "commondir"), join(gitdir, "commondir.real"));
    symlinkSync(join(gitdir, "commondir.real"), join(gitdir, "commondir")); }, /commondir: is a symbolic link/],
  ["a commondir naming another repository", ({ gitdir }) => writeFileSync(join(gitdir, "commondir"),
    `${execSync("git rev-parse --absolute-git-dir", { cwd: makeRepo({ "b.txt": "b\n" }), encoding: "utf8" }).trim()}\n`), /commondir: resolves to .*not the expected common directory/],
];
test.each(hostile)("test: a snapshot in a linked checkout with %s is refused by name before any process spawns, git included — the CPU sampler, the group reap and the live-suite census alike (T1-T3)", async (_name, harm, refusal) => {
  const checkout = linkedCheckout();
  harm(checkout);
  table = workerTable();
  serveTable();
  const gitCalls = recordGit();
  await refusedAtEverySite(checkout.linked, refusal);
  expect(spawnCalls).toEqual([]);
  expect(gitCalls()).toEqual([]);
});

// The named residual (D-1686 (b)): with config.worktree present, the trust check itself must ask the trusted common config
// whether extensions.worktreeConfig is on — one git read per call, the same at the base. Nothing else spawns.
test("test: a snapshot in a linked checkout with an enabled config.worktree is refused by name before any ps runs, and its only spawns are the trust check's own extensions.worktreeConfig read, one per site — the CPU sampler, the group reap and the live-suite census alike (T4)", async () => {
  const checkout = linkedCheckout();
  writeFileSync(join(checkout.gitdir, "config.worktree"), "[core]\n");
  execSync("git config extensions.worktreeConfig true", { cwd: checkout.repo });
  table = workerTable();
  serveTable();
  const gitCalls = recordGit();
  await refusedAtEverySite(checkout.linked, /config\.worktree: extensions\.worktreeConfig is enabled/);
  expect(spawnCalls).toEqual([]);
  expect(gitCalls()).toHaveLength(3);
  for (const call of gitCalls()) expect(call).toMatch(/^git config --file \S+\/config --type=bool --get extensions\.worktreeConfig$/);
});
