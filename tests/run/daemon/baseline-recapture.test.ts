import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import * as baselines from "../../../src/gates/baseline.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import { gitHead, shGitOk, WORKTREES_DIR } from "../../../src/run/git.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir } from "../../../src/graph/graph.js";
import { releaseRunLock } from "../../../src/run/lock.js";
import { COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

// Pass-through fs whose one hook observes the staged baseline at the instant it would be published.
const fsHooks = vi.hoisted(() => ({ beforeRename: undefined as ((from: string, to: string) => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync = ((from: string, to: string) => {
    fsHooks.beforeRename?.(String(from), String(to));
    return actual.renameSync(from, to);
  }) as typeof actual.renameSync;
  return { ...actual, renameSync };
});

// The red depends on the checkout: a capture of the moved HEAD fingerprints `moved`, which would leave
// the task's `existing` red (measured on the journaled base) fresh and unforgiven.
const commands = {
  build: "true",
  test: "if [ -f head-only.txt ]; then echo 'FAIL tests/moved.test.ts > moved'; else echo 'FAIL tests/existing.test.ts > existing'; fi; echo 'AssertionError: expected one to be two'; exit 1",
  lint: "true",
};
const gated = ["build", "test", "lint", "evidence", "scope"];
const fixture = (status: "human" | "pending", gates: Record<string, string> = commands) => setupRepo(
  [T("T1", { status, files: ["work.txt"], gates: gated })],
  { tasks: { T1: [{ shell: `echo work > work.txt && ${COMMIT} work`, result: { ok: true, summary: "landed work" } }] } },
  stringify({ gates }),
);
const rows = (journal: Journal, prefix: string) => journal.read().filter((e) => e.event.startsWith(prefix));
const pristineLeft = (repo: string) => {
  const dir = join(tickmarkrDir(repo), WORKTREES_DIR);
  return existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith("baseline-recapture-")) : [];
};

afterEach(() => { fsHooks.beforeRename = undefined; vi.restoreAllMocks(); });

/** The interrupted-capture state: run-start journaled, no baseline.json published. */
async function seeded(runId: string, status: "human" | "pending" = "human", recorded: Record<string, string> = commands) {
  const { repo, fake } = fixture(status, recorded);
  const baseRef = await gitHead(repo);
  const journal = Journal.create(repo, runId);
  journal.append("baseline-start", undefined, { baseRef, commands: recorded });
  journal.append("run-start", undefined, { baseRef, commands: recorded, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  return { repo, fake, baseRef, journal };
}

/** Termination reaps asynchronously after runDaemon settles; the exit code is the interruption's receipt. */
async function interrupted(run: (exit: (code: number) => void) => Promise<unknown>): Promise<number> {
  let exited!: (code: number) => void;
  const code = new Promise<number>((resolve) => { exited = resolve; });
  await run(exited).catch(() => undefined);
  return code;
}

async function moveHead(repo: string, baseRef: string) {
  writeFileSync(join(repo, "head-only.txt"), "later HEAD\n");
  await shGitOk("git add head-only.txt && git commit --no-gpg-sign -m later", repo);
  expect(await gitHead(repo)).not.toBe(baseRef);
}

// SLOWEST-RUNNER: owned in-process capture receipt/return barrier; the 300000ms ceiling only bounds
// cleanup on 3-core macOS under coverage. Neither signal scheduling nor elapsed time is an oracle.
test("runDaemon interrupted inside baseline capture after run-start recaptures the journaled pristine base across a second interruption and forgives its recorded red after HEAD moves", async () => {
  const { repo, fake } = fixture("pending");
  const runId = "run-baseline-recapture";
  const baseRef = await gitHead(repo);
  let cuts = 2;
  const seen: { cwd: string; head: string }[] = [];
  const original = baselines.captureBaseline;
  vi.spyOn(baselines, "captureBaseline").mockImplementation(async (cwd, cmds, opts = {}) => {
    seen.push({ cwd, head: await gitHead(cwd) });
    const cut = cuts > 0;
    let interrupted = false;
    const captured = await original(cwd, cmds, { ...opts, onReceipt: (receipt) => {
      opts.onReceipt?.(receipt);
      if (!cut || interrupted) return;
      interrupted = true; cuts--;
      const journal = Journal.open(repo, runId);
      expect(journal.read().some((e) => e.event === "run-start")).toBe(true);
      expect(existsSync(join(journal.dir, "baseline.json"))).toBe(false);
      process.emit("SIGTERM", "SIGTERM");
    } });
    // The capture really returned; the daemon dies before its publisher receives it.
    if (interrupted) throw new Error("owned capture-return interruption before publication");
    return captured;
  });
  expect(await interrupted((exit) => runDaemon(repo, { adapters: [fake], runId, exit }))).toBe(143);
  const journal = Journal.open(repo, runId);
  expect(existsSync(join(journal.dir, "baseline.json"))).toBe(false);
  expect(journal.read().some((e) => e.event === "baseline-start" && e.data.baseRef === baseRef)).toBe(true);
  releaseRunLock(repo);

  await moveHead(repo, baseRef);
  expect(await interrupted((exit) => runDaemon(repo, { adapters: [fake], runId, resume: true, exit }))).toBe(143);
  expect(existsSync(join(journal.dir, "baseline.json"))).toBe(false);
  releaseRunLock(repo);

  // Termination can reap the in-flight worker's slot (a dispatch failure); --retry-failed is its release.
  const completed = await runDaemon(repo, { adapters: [fake], runId, resume: true, retryFailed: true });
  expect(completed.done).toEqual(["T1"]);
  const baseline = JSON.parse(readFileSync(join(journal.dir, "baseline.json"), "utf8"));
  expect(baseline.provenance.baseRef).toBe(baseRef);
  expect(Object.keys(baseline.provenance).sort()).toEqual(["baseRef", "capturedAt"]);
  expect(seen.map((s) => s.head)).toEqual([baseRef, baseRef, baseRef]);
  expect(seen[0]!.cwd).toBe(repo);
  expect(seen[1]!.cwd).not.toBe(repo);
  expect(seen[2]!.cwd).not.toBe(repo);
  expect(rows(journal, "baseline-recapture-start")).toHaveLength(2);
  expect(rows(journal, "baseline-recapture-complete").map((e) => e.data.provenance)).toEqual([baseline.provenance]);
  const gate = journal.read().find((e) => e.taskId === "T1" && e.event === "gate-result" && e.data.gate === "test");
  expect(gate?.data).toMatchObject({ pass: true, baselineProvenance: { baseRef } });
  expect(String(gate?.data.details)).toMatch(/pre-existing|baseline/);
  expect(pristineLeft(repo)).toEqual([]);
}, 300_000);

test("production runDaemon refuses a missing baseline with changed effective commands by name before capture or gates rather than capturing current commands", async () => {
  const capture = vi.spyOn(baselines, "captureBaseline");
  // A changed credential assignment redacts to the same journaled bytes; equality is unprovable, not proven.
  const masked = { ...commands, test: "TEST_TOKEN=original-suite true" };
  const cases = [
    { runId: "run-baseline-command-mismatch", recorded: commands, gates: { build: "true", test: "true", tipTest: "true" }, names: "lint, test, tipTest" },
    { runId: "run-baseline-masked-mismatch", recorded: masked, gates: { ...masked, test: "TEST_TOKEN=replacement-suite true" }, names: "test" },
  ];
  for (const { runId, recorded, gates, names } of cases) {
    const { repo, fake, journal } = await seeded(runId, "pending", recorded);
    const config = join(tickmarkrDir(repo), "config.yaml");
    writeFileSync(config, readFileSync(config, "utf8").replace(stringify({ gates: recorded }), stringify({ gates })));
    const before = readFileSync(join(journal.dir, "journal.jsonl"), "utf8");
    await expect(runDaemon(repo, { adapters: [fake], runId, resume: true }))
      .rejects.toThrow(new RegExp(`baseline recapture refused — effective commands differ from \\(or are masked in\\) run-start's journaled commands: ${names}$`));
    expect(capture).not.toHaveBeenCalled();
    expect(existsSync(join(journal.dir, "baseline.json"))).toBe(false);
    expect(readFileSync(join(journal.dir, "journal.jsonl"), "utf8")).toBe(before);
    expect(journal.read().filter((e) => ["worker-launch", "phase-start", "gate-result"].includes(e.event))).toEqual([]);
    expect(pristineLeft(repo)).toEqual([]);
    releaseRunLock(repo);
  }
}, 120_000);

test("production runDaemon fails closed on existing malformed and truncated baseline bytes without recapture while an existing valid baseline adds no recapture rows", async () => {
  const capture = vi.spyOn(baselines, "captureBaseline");
  for (const bytes of ["not json", '{"commands":{"build":{"exitCode":0']) {
    const { repo, fake, journal } = await seeded(`run-unreadable-${bytes.length}`);
    writeFileSync(join(journal.dir, "baseline.json"), bytes);
    await expect(runDaemon(repo, { adapters: [fake], runId: journal.runId, resume: true }))
      .rejects.toThrow(/existing baseline\.json is unreadable .* never recaptured over/);
    expect(readFileSync(join(journal.dir, "baseline.json"), "utf8")).toBe(bytes);
    expect(rows(journal, "baseline-recapture-")).toEqual([]);
    releaseRunLock(repo);
  }
  expect(capture).not.toHaveBeenCalled();
  const { repo, fake, journal } = await seeded("run-existing-baseline");
  const valid = JSON.stringify(await baselines.captureBaseline(repo, commands));
  writeFileSync(join(journal.dir, "baseline.json"), valid);
  capture.mockClear();
  await runDaemon(repo, { adapters: [fake], runId: journal.runId, resume: true });
  expect(capture).not.toHaveBeenCalled();
  expect(rows(journal, "baseline-recapture-")).toEqual([]);
  expect(journal.read().filter((e) => e.event === "run-resume")).toHaveLength(1);
  expect(readFileSync(join(journal.dir, "baseline.json"), "utf8")).toBe(valid);
}, 180_000);

// SLOWEST-RUNNER: owned staged-publication barrier at the publishing rename; the ceiling only bounds cleanup.
test("production runDaemon interrupted after staging a recaptured baseline exposes no partial destination and resumes to complete journaled-base provenance before its first gate versus exposing truncated destination bytes", async () => {
  const { repo, fake, baseRef, journal } = await seeded("run-staged-recapture", "pending");
  await moveHead(repo, baseRef);
  const destination = join(journal.dir, "baseline.json");
  let staged = "";
  fsHooks.beforeRename = (from, to) => {
    if (to !== destination) return;
    fsHooks.beforeRename = undefined;
    staged = readFileSync(from, "utf8");
    expect(JSON.parse(staged).provenance.baseRef).toBe(baseRef);
    expect(existsSync(destination)).toBe(false);
    process.emit("SIGTERM", "SIGTERM");
    throw new Error("owned interruption between staging and publication");
  };
  expect(await interrupted((exit) => runDaemon(repo, { adapters: [fake], runId: journal.runId, resume: true, exit }))).toBe(143);
  expect(staged).not.toBe("");
  expect(existsSync(destination)).toBe(false);
  expect(readdirSync(journal.dir).filter((f) => f.startsWith("baseline.json"))).toEqual([]);
  expect(rows(journal, "baseline-recapture-complete")).toEqual([]);
  releaseRunLock(repo);

  const atFirstGate: unknown[] = [];
  const completed = await runDaemon(repo, { adapters: [fake], runId: journal.runId, resume: true, retryFailed: true, narrate: (row) => {
    if (row.event === "phase-start" && row.data.gate && atFirstGate.length === 0) {
      atFirstGate.push(JSON.parse(readFileSync(destination, "utf8")).provenance);
    }
  } });
  expect(completed.done).toEqual(["T1"]);
  const published = JSON.parse(readFileSync(destination, "utf8"));
  expect(published.provenance).toEqual({ baseRef, capturedAt: expect.any(String) });
  expect(Number.isNaN(Date.parse(published.provenance.capturedAt))).toBe(false);
  expect(atFirstGate).toEqual([published.provenance]);
  const events = journal.read();
  const resumed = events.findLastIndex((e) => e.event === "run-resume");
  const complete = events.findIndex((e, i) => i > resumed && e.event === "baseline-recapture-complete");
  const firstGate = events.findIndex((e, i) => i > resumed && e.event === "phase-start" && e.data.gate);
  expect(complete).toBeGreaterThan(resumed);
  expect(complete).toBeLessThan(firstGate);
  expect(events[complete]!.data.provenance).toEqual(published.provenance);
  expect(rows(journal, "baseline-recapture-start")).toHaveLength(2);
  const gate = events.find((e) => e.taskId === "T1" && e.event === "gate-result" && e.data.gate === "test");
  expect(gate?.data).toMatchObject({ pass: true, baselineProvenance: published.provenance });
  expect(pristineLeft(repo)).toEqual([]);

  // Versus a publisher that wrote the destination in place: the same interruption leaves its
  // truncated bytes there, and a resume can only fail closed on them.
  const direct = await seeded("run-direct-write", "pending");
  const truncated = staged.slice(0, Math.floor(staged.length / 2));
  writeFileSync(join(direct.journal.dir, "baseline.json"), truncated);
  await expect(runDaemon(direct.repo, { adapters: [direct.fake], runId: direct.journal.runId, resume: true }))
    .rejects.toThrow(/existing baseline\.json is unreadable/);
  expect(readFileSync(join(direct.journal.dir, "baseline.json"), "utf8")).toBe(truncated);
  expect(rows(direct.journal, "baseline-recapture-")).toEqual([]);
  releaseRunLock(direct.repo);
}, 300_000);
