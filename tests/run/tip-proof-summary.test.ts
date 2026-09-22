import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatTipProof, recordFatalRunEnd, runDaemon, runEndTipProof } from "../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const TIP = "a".repeat(40);
const ev = (event: string, data: Record<string, unknown> = {}): JournalEvent => ({ ts: "2026-09-22T00:00:00.000Z", event, data });
const start = (cached: boolean, gates = ["build", "test"]) => ev("tip-verify-start", { tip: TIP, cmdHash: "h", gates, cached });
const pass = (gate: string, cached = false) => ev("tip-verify", { gate, pass: true, tip: TIP, cmdHash: "h", ...(cached ? { cached: true } : {}) });
const green = [start(false), pass("build"), pass("test"), ev("run-end", { tipVerify: "passed" })];

/** One partial run (T2 parks on its human gate, so the integration worktree survives) and its journal + close notifications. */
async function partialRun(runId: string) {
  const { repo, fake } = setupRepo([T("T1"), T("T2", { humanGate: true })],
    { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  const notifies: string[] = [];
  const driver = new SubprocessDriver();
  driver.notify = async (message) => { notifies.push(message); };
  const run = (resume: boolean) => runDaemon(repo, { adapters: [fake], driver, runId, resume, approvalWindowMs: 0 });
  return { repo, notifies, run };
}

test("test: a close after an eligible cached verification records and announces reused proof naming its verified commit, so inferring reuse from an unchanged commit despite an ineligible cache key fails", async () => {
  // Same commit, but the start row declared the cache ineligible and the commands really ran: fresh, never reused.
  expect(runEndTipProof([...green, start(false), pass("build"), pass("test")])).toEqual({ kind: "fresh", tip: TIP });
  // Cached verdict rows without the cache row (or the reverse) prove neither kind.
  expect(runEndTipProof([...green, start(true), pass("build", true), pass("test", true)]).kind).toBe("incomplete");
  expect(runEndTipProof([...green, start(false), ev("tip-verify-cached", { tip: TIP }), pass("build"), pass("test")]).kind).toBe("incomplete");

  const { repo, notifies, run } = await partialRun("run-proof-reused");
  await run(false);
  const resumed = await run(true);
  const events = Journal.open(repo, "run-proof-reused").read();
  const cachedRow = events.findLast((e) => e.event === "tip-verify-cached")!;
  expect(cachedRow).toBeDefined();
  const end = events.findLast((e) => e.event === "run-end")!;
  expect(end.data.tipVerify).toBe("passed");
  expect(end.data.tipProof).toEqual({ kind: "reused", tip: cachedRow.data.tip });
  expect(resumed.tipProof).toEqual(end.data.tipProof);
  expect(notifies.at(-1)).toContain(`tip proof: reused — carried from verified commit ${(cachedRow.data.tip as string).slice(0, 12)}`);
}, 120_000);

test("test: a close whose latest cycle failed or was cancelled before completing records and announces failed or incomplete proof despite an earlier green cycle, so an unfinished cycle reported as reused green fails", async () => {
  const failed = runEndTipProof([...green, start(false), pass("build"), ev("tip-verify-failed", { gate: "test", tip: TIP, cmdHash: "h" })]);
  expect(failed).toEqual({ kind: "failed", tip: TIP });
  expect(formatTipProof(failed)).toContain("tip proof: failed");
  for (const unfinished of [
    [...green, start(true), ev("tip-verify-cached", { tip: TIP }), pass("build", true), ev("tip-verify-cancelled", { reason: "approval" })],
    [...green, start(false), pass("build"), ev("tip-verify-cancelled", { reason: "approval" })],
    [...green, start(false), pass("build")], // killed mid-battery
    [...green, start(true)],
  ]) {
    const proof = runEndTipProof(unfinished);
    expect(proof).toEqual({ kind: "incomplete", tip: TIP });
    expect(formatTipProof(proof)).toContain("tip proof: incomplete");
    expect(formatTipProof(proof)).not.toMatch(/reused|fresh/);
  }
  // No delimited cycle at all is not evidence of anything.
  expect(runEndTipProof([pass("build"), pass("test")])).toEqual({ kind: "incomplete" });

  // A close that never enters tip verification (nothing done) still records and announces exactly one proof.
  const { repo, fake } = setupRepo([T("T1", { humanGate: true })], {});
  const notifies: string[] = [];
  const driver = new SubprocessDriver();
  driver.notify = async (message) => { notifies.push(message); };
  const summary = await runDaemon(repo, { adapters: [fake], driver, runId: "run-proof-skipped", approvalWindowMs: 0 });
  const end = Journal.open(repo, "run-proof-skipped").read().findLast((e) => e.event === "run-end")!;
  expect(end.data.tipVerify).toBeUndefined();
  expect(end.data.tipProof).toEqual({ kind: "incomplete" });
  expect(summary.tipProof).toEqual(end.data.tipProof);
  expect(notifies.at(-1)).toContain("tip proof: incomplete");
}, 60_000);

test("test: a close after successful execution of every tip command records and announces fresh proof, so a successful fresh verification presented as reused fails", async () => {
  expect(runEndTipProof(green)).toEqual({ kind: "fresh", tip: TIP });
  expect(formatTipProof({ kind: "fresh", tip: TIP })).not.toContain("reused");

  const { repo, notifies, run } = await partialRun("run-proof-fresh");
  const summary = await run(false);
  const events = Journal.open(repo, "run-proof-fresh").read();
  const startRow = events.findLast((e) => e.event === "tip-verify-start")!;
  expect(events.some((e) => e.event === "tip-verify-cached")).toBe(false);
  const end = events.findLast((e) => e.event === "run-end")!;
  expect(end.data.tipVerify).toBe("passed"); // the legacy enum is kept beside the additive field
  expect(end.data.tipProof).toEqual({ kind: "fresh", tip: startRow.data.tip });
  expect(summary.tipProof).toEqual(end.data.tipProof);
  expect(notifies.at(-1)).toContain("tip proof: fresh — every tip command ran and passed on");
  expect(notifies.at(-1)).not.toContain("reused");
}, 60_000);

/** tipTest is green wherever T1's t1.txt is absent (the baseline capture), so only the integration tip can see it red. */
function flaggedRun(runId: string, testCmd: (flag: string) => string) {
  const flag = join(makeTestTempDir("tickmarkr-flag-"), "flag");
  const { repo, fake } = setupRepo([T("T1"), T("T2", { humanGate: true })],
    { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
    `gates: { build: 'node -e ""', test: 'node -e ""', tipTest: 'test ! -e t1.txt || ${testCmd(flag)}' }\n`);
  const notifies: string[] = [];
  const driver = new SubprocessDriver();
  driver.notify = async (message) => { notifies.push(message); };
  const run = (resume: boolean) => runDaemon(repo, { adapters: [fake], driver, runId, resume, approvalWindowMs: 0 });
  return { repo, flag, notifies, run };
}

// D-131 regression 1: the whole-cycle cache is ineligible (the previous cycle was red), yet verifyIntegrationTip
// carries build forward from its persisted verdict and executes only test — never "every command ran".
test("a cycle that reuses one persisted per-gate verdict and executes the rest is recorded as reused, never fresh", async () => {
  expect(runEndTipProof([...green, start(false), pass("build", true), pass("test")])).toEqual({ kind: "reused", tip: TIP });

  const { repo, flag, notifies, run } = flaggedRun("run-proof-mixed", (f) => `test -e "${f}"`);
  await run(false);
  const red = Journal.open(repo, "run-proof-mixed").read().findLast((e) => e.event === "run-end")!;
  expect(red.data.tipProof).toMatchObject({ kind: "failed" });
  writeFileSync(flag, "");
  await run(true);
  const events = Journal.open(repo, "run-proof-mixed").read();
  const cycle = events.slice(events.map((e) => e.event).lastIndexOf("tip-verify-start"));
  expect(cycle[0]!.data.cached).toBe(false);
  expect(cycle.some((e) => e.event === "tip-verify-cached")).toBe(false);
  expect(cycle.find((e) => e.event === "tip-verify" && e.data.gate === "build")!.data.cached).toBe(true);
  expect(cycle.find((e) => e.event === "tip-verify" && e.data.gate === "test")!.data.cached).toBeUndefined();
  expect(events.findLast((e) => e.event === "run-end")!.data.tipProof).toMatchObject({ kind: "reused" });
  expect(notifies.at(-1)).toContain("tip proof: reused");
}, 120_000);

// D-131 regression 2: the verifier subprocess dies after tip-verify-start; the fatal close still names one proof.
test("a fatal close after tip-verify-start records and announces incomplete proof despite an earlier green cycle", async () => {
  // Pure: the fatal engagement's unfinished cycle inherits nothing from the engagement before it.
  const { repo: scratch } = setupRepo([T("T1")], {});
  const journal = Journal.create(scratch, "run-proof-fatal-pure");
  for (const e of [ev("run-start"), ...green, ev("run-resume"), start(false), pass("build")]) journal.append(e.event, undefined, e.data);
  expect(recordFatalRunEnd(journal, "run-proof-fatal-pure", "b", new Error("boom"))).toEqual({ kind: "incomplete", tip: TIP });
  expect(journal.read().at(-1)!.data).toMatchObject({ fatal: true, tipProof: { kind: "incomplete", tip: TIP } });

  // Daemon: at the tip the command kills its own verifier subprocess (and only that — never an in-process caller).
  const { repo, notifies, run } = flaggedRun("run-proof-fatal", () => `{ ps -o command= -p $PPID | grep -q input-type=module && kill -9 $PPID; exit 1; }`);
  await expect(run(false)).rejects.toThrow();
  const events = Journal.open(repo, "run-proof-fatal").read();
  const end = events.findLast((e) => e.event === "run-end")!;
  const startRow = events.findLast((e) => e.event === "tip-verify-start")!;
  expect(end.data.fatal).toBe(true);
  expect(end.data.tipProof).toEqual({ kind: "incomplete", tip: startRow.data.tip });
  expect(notifies.at(-1)).toContain("run crashed — tip proof: incomplete");
}, 120_000);
