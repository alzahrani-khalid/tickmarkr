import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { OrcaError } from "../../../src/drivers/orca.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import type { Slot } from "../../../src/drivers/types.js";
import { heldWorkerTransport, runDaemon, type DispatchObservation } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

const timeout = () => new OrcaError("send", "orca CLI exited 124 after timeout", "");
const fixture = () => setupRepo([T("T1", { files: ["t1.txt"] })], {
  tasks: { T1: [{ shell: `echo kept > t1.txt && ${COMMIT} kept`, result: { ok: true, summary: "done" } }] },
});
const rows = (repo: string, id: string) => Journal.open(repo, id).read().filter((e) => e.taskId === "T1");

test("test: a fake driver whose status probe times out once and answers on the retry keeps the attempt in flight with a journaled held-probe row and no task-failed row, so a first timeout that fails the task fails", async () => {
  const { repo, fake } = fixture();
  const driver = new SubprocessDriver();
  driver.interactive = true;
  let probes = 0;
  driver.status = async () => { if (++probes === 1) throw timeout(); return "working"; };
  const read = driver.read.bind(driver);
  driver.read = async (s, n) => probes < 2 ? "working" : read(s, n);
  const wait = driver.waitOutput.bind(driver);
  driver.waitOutput = async (s, p, ms, o) => probes < 2 ? false : wait(s, p, ms, o);
  const id = "run-held-status";
  const result = await runDaemon(repo, { adapters: [fake], driver, runId: id });
  expect(result.done).toEqual(["T1"]);
  const events = rows(repo, id);
  expect(events.filter((e) => e.event === "held-probe")).toHaveLength(1);
  expect(events.find((e) => e.event === "held-probe")?.data).toMatchObject({ operation: "status", state: "held", retry: 0 });
  expect(events.filter((e) => e.event === "task-failed")).toEqual([]);
  expect(events.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
});

test("test: a fake driver whose run call times out after delivery is reconciled by a matching positive dispatch observation and journals exactly one worker-launch, while empty stale failed or ambiguous observations stay held then park without re-delivery and only authoritative proof of original nonacceptance permits retry, so an empty read causing a second delivery or a positively observed launch being lost fails", async () => {
  for (const observation of ["positive", "positive-interactive", "empty", "stale", "failed", "ambiguous"] as const) {
    const { repo, fake } = fixture();
    const driver = new SubprocessDriver();
    driver.interactive = observation === "positive-interactive";
    const positive = observation.startsWith("positive");
    let deliveries = 0;
    const run = driver.run.bind(driver), read = driver.read.bind(driver);
    driver.run = async (s, cmd) => {
      deliveries++;
      if (positive) {
        await run(s, cmd);
        await driver.waitOutput(s, "TICKMARKR_DISPATCH_", 5_000);
      }
      throw timeout();
    };
    driver.read = async (s, n) => {
      if (positive) return read(s, n);
      if (observation === "failed") throw new Error("read unavailable");
      return observation === "stale" ? "TICKMARKR_DISPATCH_old" : observation === "ambiguous" ? "working" : "";
    };
    const id = `run-held-${observation}`;
    const result = await runDaemon(repo, { adapters: [fake], driver, runId: id, approvalWindowMs: 0 });
    const events = rows(repo, id);
    expect(deliveries).toBe(1);
    expect(events.filter((e) => e.event === "worker-launch")).toHaveLength(positive ? 1 : 0);
    expect(events.some((e) => e.event === "held-probe")).toBe(true);
    expect(events.filter((e) => e.event === "task-failed")).toEqual([]);
    if (positive) expect(result.done).toEqual(["T1"]);
    else {
      expect(result.human).toEqual(["T1"]);
      expect(events.find((e) => e.event === "task-human")?.data.kind).toBe("infra");
    }
  }
  // Only a transport's exact, authoritative receipt can license the second send.
  for (const mismatch of ["none", "authority", "slot", "command", "nonce"]) {
    const authoritative = mismatch !== "authority";
    const driver = new SubprocessDriver() as SubprocessDriver & {
      observeDispatch: (s: Slot, command: string, dispatchId: string) => Promise<DispatchObservation>;
    };
    let deliveries = 0;
    driver.run = async () => { if (++deliveries === 1) throw timeout(); };
    driver.read = async () => "";
    driver.observeDispatch = async (s, command, dispatchId) => ({ slotId: mismatch === "slot" ? "other" : s.id, command: mismatch === "command" ? "old" : command, dispatchId: mismatch === "nonce" ? "old" : dispatchId,
      outcome: "not-accepted", authoritative } as DispatchObservation);
    const slot = { id: "slot", name: "worker", cwd: "/tmp" };
    const transport = heldWorkerTransport(driver, slot, "nonce", () => {}, async () => {});
    if (mismatch === "none") await transport.run(slot, "command");
    else await expect(transport.run(slot, "command")).rejects.toThrow(/uncertain/);
    expect(deliveries).toBe(mismatch === "none" ? 2 : 1);
  }
}, 60_000);

test("test: a fake driver that times out past the retry budget parks the attempt kind infra with worktree-preserved naming the ref that holds its commits and no task-dispatch row after the originating one, so a park that drops the commits or charges a new attempt fails", async () => {
  const { repo, fake } = fixture();
  const driver = new SubprocessDriver();
  const commits: string[] = [];
  driver.run = async (slot) => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(slot.cwd, "t1.txt"), `commit ${i}`);
      execFileSync("git", ["add", "t1.txt"], { cwd: slot.cwd });
      execFileSync("git", ["commit", "--no-gpg-sign", "-m", `kept ${i}`], { cwd: slot.cwd });
      commits.push(execFileSync("git", ["rev-parse", "HEAD"], { cwd: slot.cwd, encoding: "utf8" }).trim());
    }
  };
  driver.read = async () => { throw timeout(); };
  const id = "run-held-exhausted";
  const result = await runDaemon(repo, { adapters: [fake], driver, runId: id, approvalWindowMs: 0 });
  expect(result.human).toEqual(["T1"]);
  const events = rows(repo, id);
  expect(events.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
  expect(events.filter((e) => e.event === "task-failed")).toEqual([]);
  expect(events.find((e) => e.event === "task-human")?.data.kind).toBe("infra");
  const ref = events.find((e) => e.event === "worktree-preserved")?.data.ref;
  expect(ref).toEqual(expect.stringMatching(/^refs\/tickmarkr\/preserved\//));
  for (const commit of commits) execFileSync("git", ["merge-base", "--is-ancestor", commit, String(ref)], { cwd: repo });
  expect(Journal.open(repo, id).replayResumeState().get("T1")?.attempts).toBe(1);
  expect(events.filter((e) => e.event === "held-probe").map((e) => e.data.backoffMs)).toEqual([250, 500, 1000, undefined]);
});
