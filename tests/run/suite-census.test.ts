import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { countLiveSuites } from "../../src/run/daemon.js";
import { SUITE_PARENT_ENV } from "../../src/run/git.js";
import { batchedProcessProbes, type ProbeExec, type ProcReader } from "../../src/run/suite-census.js";

// Queue row 103's closed case table (D-1561): per pid, the batched census
// answers what the base per-pid probes answered — failures included. Rows C1–C5 and C11–C14 go through the PRODUCTION probeExec, so
// execFile itself is replaced here; every other row injects its exec.
type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const probe = vi.hoisted(() => ({ impl: undefined as undefined | ((file: string, args: string[], done: Callback) => void), calls: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // only the census's own probes (`lsof`/`ps` with a callback) are replaced; any other execFile call is the real one
  return { ...actual, execFile: (...args: unknown[]) => (args[0] === "lsof" || args[0] === "ps") && typeof args[3] === "function"
    ? (probe.calls++, probe.impl!(args[0] as string, args[1] as string[], args[3] as Callback)) : (actual.execFile as (...a: unknown[]) => unknown)(...args) };
});
beforeEach(() => { probe.impl = undefined; probe.calls = 0; });

const pidA = 910_000_001, pidB = 910_000_002;
const noProc: ProcReader = { cwd: () => { throw new Error("no /proc"); }, environ: () => { throw new Error("no /proc"); } };
const answer = (respond: (file: string, args: string[], done: Callback) => void) => { probe.impl = respond; };

test("census row C1 a synchronous spawn throw from lsof and ps leaves every pid unanswered and the census still resolves", async () => {
  probe.impl = () => { throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" }); };
  const probes = await batchedProcessProbes([pidA, pidB], undefined, noProc);
  expect([probes.cwd(pidA), probes.cwd(pidB), probes.suiteParent(pidA), probes.suiteParent(pidB)]).toEqual([undefined, undefined, undefined, undefined]);
  expect(probe.calls).toBe(2); // one lsof, one ps — both threw synchronously
});

// D-1564: every "nothing" row is fed rows that WOULD count — a repository cwd from lsof and a marker naming the daemon
// from ps — so a missing guard shows as a count of 1. C13/C14 are the same rows from a probe that ran to completion.
const daemon = 7000;
test.each([
  ["C2 an asynchronous spawn error discards the rows it buffered", { code: "ENOENT" }, false],
  ["C4 a timed-out probe discards the rows it buffered", { killed: true, signal: "SIGTERM", code: null }, false],
  ["C11 a probe killed by a signal discards the rows it buffered", { killed: false, signal: "SIGKILL", code: null }, false],
  ["C12 a probe over its output cap discards the rows it buffered", { killed: true, signal: "SIGTERM", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, false],
  ["C13 a probe that exits non-zero keeps the same rows and counts the runner", { code: 1 }, true],
  ["C14 a probe that exits zero keeps the same rows and counts the runner", null, true],
] as const)("census row %s", async (_row, error, kept) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-census-repo-")));
  answer((file, _args, done) => done(error && Object.assign(new Error("probe"), error),
    file === "lsof" ? `p${pidA}\nfcwd\nn${repo}\n` : `${pidA} node vitest.mjs run ${SUITE_PARENT_ENV}=${daemon}\n`, ""));
  const probes = await batchedProcessProbes([pidA], undefined, noProc);
  expect([probes.cwd(pidA), probes.suiteParent(pidA)]).toEqual(kept ? [repo, daemon] : [undefined, undefined]);
  expect(countLiveSuites(`${pidA} 1 S node vitest.mjs run\n`, repo, daemon, probes.cwd, probes.suiteParent)).toBe(kept ? 1 : 0);
});

test("census row C3 a probe that exits non-zero keeps every row it printed", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-census-c3-")));
  answer((file, _args, done) => done(Object.assign(new Error("exit 1"), { code: 1 }),
    file === "lsof" ? `p${pidA}\nfcwd\nn${dir}\n` : `${pidA} node vitest.mjs run ${SUITE_PARENT_ENV}=7000\n`, ""));
  const probes = await batchedProcessProbes([pidA, pidB], undefined, noProc);
  expect([probes.cwd(pidA), probes.suiteParent(pidA), probes.cwd(pidB), probes.suiteParent(pidB)]).toEqual([dir, 7000, undefined, undefined]);
});

test("census row C5 an lsof path that no longer exists leaves that pid unanswered", async () => {
  answer((file, _args, done) => done(null, file === "lsof" ? `p${pidA}\nfcwd\nn${join(tmpdir(), "tickmarkr-census-gone-910000001")}\n` : "", ""));
  const probes = await batchedProcessProbes([pidA], undefined, noProc);
  expect(probes.cwd(pidA)).toBeUndefined();
});

test("census row C6 an injected exec that rejects never rejects the census", async () => {
  const probes = await batchedProcessProbes([pidA], async () => { throw new Error("injected reject"); }, noProc);
  expect([probes.cwd(pidA), probes.suiteParent(pidA)]).toEqual([undefined, undefined]);
});

test("census row C7 a duplicated marker on the ps line takes the first", async () => {
  const probes = await batchedProcessProbes([pidA],
    async (file) => file === "ps" ? `${pidA} node vitest.mjs run ${SUITE_PARENT_ENV}=7000 ${SUITE_PARENT_ENV}=8000\n` : "", noProc);
  expect(probes.suiteParent(pidA)).toBe(7000);
});

test("census row C8 a duplicated /proc marker entry takes the first", async () => {
  const probes = await batchedProcessProbes([pidA], async () => "", {
    cwd: () => { throw new Error("no /proc"); },
    environ: () => [`${SUITE_PARENT_ENV}=7000`, `${SUITE_PARENT_ENV}=8000`].join("\0"),
  });
  expect(probes.suiteParent(pidA)).toBe(7000);
});

test("census row C9 a readable /proc answers cwd and marker without any probe", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-census-c9-")));
  const exec = vi.fn(async () => "");
  const probes = await batchedProcessProbes([pidA], exec, { cwd: () => dir, environ: () => `PATH=/x\0${SUITE_PARENT_ENV}=7000` });
  expect([probes.cwd(pidA), probes.suiteParent(pidA)]).toEqual([dir, 7000]);
  // the parent 7000's cwd is asked of /proc too (it answers dir here), so no lsof or ps runs at all
  expect(exec).not.toHaveBeenCalled();
});

test("census row C10 a readable /proc without the marker answers no parent and never falls back to ps", async () => {
  const exec = vi.fn(async () => "");
  const probes = await batchedProcessProbes([pidA], exec, { cwd: () => realpathSync(tmpdir()), environ: () => "PATH=/x\0HOME=/h" });
  expect(probes.suiteParent(pidA)).toBeUndefined();
  expect(exec).not.toHaveBeenCalled();
});

// D-1567 BATCH POISONING (queue row 103's case table): lsof and ps fail the WHOLE command for one -p member they cannot take — measured
// on Darwin, 1e+21 / Infinity fail both and 2147483648 fails ps — modelled here as any member outside 1..2^31-1, the
// union over both tools. The base probed per pid, so a poison member lost only its own answer; the batch must too.
const poisonable = (cwdOf: Record<number, string>, parentOf: Record<number, string>): ProbeExec => async (file, args) => {
  const members = args[args.indexOf("-p") + 1]!.split(",");
  if (members.some((m) => !/^\d+$/.test(m) || Number(m) < 1 || Number(m) > 2_147_483_647)) return "";
  return members.map((m) => file === "lsof"
    ? (cwdOf[Number(m)] ? `p${m}\nfcwd\nn${cwdOf[Number(m)]}\n` : "")
    : (parentOf[Number(m)] ? `${m} node vitest.mjs run ${SUITE_PARENT_ENV}=${parentOf[Number(m)]}\n` : "")).join("");
};
const validParent = 910_000_003;
test.each([
  ["X1 a suite-parent marker past 2^53 that prints as 1e+21", "1" + "0".repeat(21)],
  ["X2 a suite-parent marker that overflows to Infinity", "9".repeat(310)],
  ["X3 a suite-parent marker above int32", "2147483648"],
  ["X4 a suite-parent marker of zero", "0"],
  ["X5 a suite-parent marker past 2^53 that still prints as digits", "9007199254740993"],
] as const)("census batch poisoning %s never hides a valid suite parent beside it", async (_row, poison) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-census-poison-")));
  // runner A's marker is the poison, runner B's names a parent whose cwd is the repository; neither runner's own cwd is
  const probes = await batchedProcessProbes([pidA, pidB], poisonable({ [validParent]: repo }, { [pidA]: poison, [pidB]: String(validParent) }), noProc);
  expect(probes.cwd(validParent)).toBe(repo);
  expect(countLiveSuites(`${pidA} 1 S node vitest.mjs run\n${pidB} 1 S node vitest.mjs run\n`, repo, daemon, probes.cwd, probes.suiteParent)).toBe(1);
});

test("census batch poisoning X6 a runner pid outside the pid range never hides a valid runner beside it", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-census-poison-")));
  const probes = await batchedProcessProbes([1e21, pidB], poisonable({ [pidB]: repo }, { [pidB]: String(daemon) }), noProc);
  expect([probes.cwd(pidB), probes.suiteParent(pidB)]).toEqual([repo, daemon]);
});
