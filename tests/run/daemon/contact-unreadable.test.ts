import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { resetAttemptHardTimeoutMsForTests, resetContactUnreadableDeadlineMsForTests, runDaemon, setAttemptHardTimeoutMsForTests, setContactUnreadableDeadlineMsForTests } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

afterEach(() => { resetContactUnreadableDeadlineMsForTests(); resetAttemptHardTimeoutMsForTests(); });

const fixture = (timeoutMinutes?: number) => setupRepo([T("T1", { files: ["t1.txt"], ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }) })], {
  tasks: { T1: [{ shell: `echo kept > t1.txt && ${COMMIT} kept`, result: { ok: true, summary: "done" } }] },
});
// A worker that commits and then keeps running with no trailer: the wait loop runs to its clocks.
const hanging = (timeoutMinutes: number) => setupRepo([T("T1", { files: ["t1.txt"], timeoutMinutes })], {
  tasks: { T1: [{ shell: `echo kept > t1.txt && ${COMMIT} kept && echo working-on-it` }] },
});
const rows = (repo: string, id: string) => Journal.open(repo, id).read().filter((e) => e.taskId === "T1");
// Not a transport timeout: heldWorkerTransport's own retry budget never sees it, only the contact latch.
const unreadable = () => new Error("pane unreadable: replacement handle term_A is the old handle value reused by runtime rt-2");

test("test: the production daemon recovers one transient unreadable contact versus parking a persistently unreadable owned slot at its deadline with bounded rows, so twenty-two-thousand retry rows or a repair debit fails", async () => {
  // Transient: the status probe cannot read the owned slot once, then contact returns.
  {
    const { repo, fake } = fixture();
    const driver = new SubprocessDriver();
    driver.interactive = true;
    let probes = 0;
    driver.status = async () => { if (++probes === 1) throw unreadable(); return "working"; };
    const read = driver.read.bind(driver), wait = driver.waitOutput.bind(driver);
    driver.read = async (s, n) => probes < 1 ? "working" : read(s, n);
    driver.waitOutput = async (s, p, ms, o) => probes < 1 ? false : wait(s, p, ms, o);
    const id = "run-contact-transient";
    const result = await runDaemon(repo, { adapters: [fake], driver, runId: id, approvalWindowMs: 0 });
    expect(result.done).toEqual(["T1"]);
    const events = rows(repo, id);
    expect(events.filter((e) => e.event === "contact-unreadable").map((e) => e.data)).toEqual([
      expect.objectContaining({ source: "driver", state: "unreadable", concludes: false }),
    ]);
    expect(events.filter((e) => e.event === "contact-recovered").map((e) => e.data)).toEqual([
      expect.objectContaining({ source: "driver", state: "readable", attempt: 0 }),
    ]);
    expect(events.filter((e) => e.event === "repair-attempt" || e.event === "escalation")).toEqual([]);
    expect(events.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
    expect(events.filter((e) => e.event === "task-human" || e.event === "task-failed")).toEqual([]);
  }

  // Transient at launch: the first read after dispatch fails once. It joins the same latch and the
  // wait loop recovers it — never the generic task-failed path that would close the slot.
  {
    const { repo, fake } = fixture();
    const driver = new SubprocessDriver();
    driver.interactive = true;
    const read = driver.read.bind(driver);
    let reads = 0;
    driver.read = async (s, n) => { if (++reads === 1) throw unreadable(); return read(s, n); };
    const id = "run-contact-launch-transient";
    const result = await runDaemon(repo, { adapters: [fake], driver, runId: id, approvalWindowMs: 0 });
    expect(result.done).toEqual(["T1"]);
    const events = rows(repo, id);
    expect(events.filter((e) => e.event === "contact-unreadable")).toHaveLength(1);
    expect(events.filter((e) => e.event === "contact-recovered")).toHaveLength(1);
    expect(events.filter((e) => e.event === "repair-attempt" || e.event === "escalation")).toEqual([]);
    expect(events.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
    expect(events.filter((e) => e.event === "task-human" || e.event === "task-failed")).toEqual([]);
  }

  // Persistent status, readable pane: a read that answers must not reset the latch the failing status
  // probe holds, or every slice writes a fresh unreadable/recovered pair until the hard timeout.
  {
    setContactUnreadableDeadlineMsForTests(1_200);
    const { repo, fake } = fixture();
    const driver = new SubprocessDriver();
    driver.interactive = true;
    let probes = 0;
    driver.read = async () => "working";
    driver.waitOutput = async () => false;
    driver.status = async () => { probes++; throw unreadable(); };
    const id = "run-contact-status-persistent";
    const result = await runDaemon(repo, { adapters: [fake], driver, runId: id, approvalWindowMs: 0 });
    expect(result.human).toEqual(["T1"]);
    const events = rows(repo, id);
    expect(events.filter((e) => e.event === "contact-unreadable")).toHaveLength(1);
    expect(events.filter((e) => e.event === "contact-recovered")).toEqual([]);
    expect(probes).toBeGreaterThan(1);
    expect(probes).toBeLessThan(20);
    expect(events.find((e) => e.event === "task-human")?.data).toMatchObject({ kind: "infra", disposition: "contact-unreadable" });
    expect(events.filter((e) => e.event === "repair-attempt" || e.event === "escalation")).toEqual([]);
    expect(events.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
  }

  // Persistent: after launch every contact with the owned slot fails. The latch must write one row,
  // retry with growing pauses, and park infra at its deadline with the committed work preserved.
  {
    const deadlineMs = 1_200;
    setContactUnreadableDeadlineMsForTests(deadlineMs);
    const { repo, fake } = fixture();
    const driver = new SubprocessDriver();
    driver.interactive = true;
    const read = driver.read.bind(driver);
    let launched = false;
    let contacts = 0;
    driver.read = async (s, n) => {
      if (!launched) { launched = true; return read(s, n); } // the launch read answers
      contacts++;
      throw unreadable();
    };
    driver.waitOutput = async () => { contacts++; throw unreadable(); };
    driver.status = async () => { contacts++; throw unreadable(); };
    const id = "run-contact-persistent";
    const started = Date.now();
    const result = await runDaemon(repo, { adapters: [fake], driver, runId: id, approvalWindowMs: 0 });
    const elapsed = Date.now() - started;
    expect(result.human).toEqual(["T1"]);
    const events = rows(repo, id);
    const lost = events.filter((e) => e.event === "contact-unreadable");
    expect(lost).toHaveLength(1);
    expect(lost[0]!.data).toMatchObject({ source: "driver", state: "unreadable", concludes: false, deadlineMs });
    expect(events.filter((e) => e.event === "contact-recovered")).toEqual([]);
    // Retries happened, but with backoff: a ~1 s cadence over the deadline, never a tight loop.
    expect(contacts).toBeGreaterThan(1);
    expect(contacts).toBeLessThan(20);
    // Bounded rows: the whole task's journal stays small however long the latch held.
    expect(events.length).toBeLessThan(40);
    const park = events.find((e) => e.event === "task-human");
    expect(park?.data).toMatchObject({ kind: "infra", disposition: "contact-unreadable" });
    expect(String(park?.data.reason)).toMatch(/past its 1200ms deadline/);
    expect(elapsed).toBeGreaterThanOrEqual(deadlineMs);
    // Work preserved for a recheck, with no repair debit and no second dispatch charged.
    const ref = events.find((e) => e.event === "worktree-preserved")?.data.ref;
    expect(ref).toEqual(expect.stringMatching(/^refs\/tickmarkr\/preserved\//));
    expect(execFileSync("git", ["show", `${String(ref)}:t1.txt`], { cwd: repo, encoding: "utf8" }).trim()).toBe("kept");
    expect(events.filter((e) => e.event === "repair-attempt" || e.event === "escalation")).toEqual([]);
    expect(events.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
    expect(events.filter((e) => e.event === "task-failed")).toEqual([]);
  }

  // Sustained past the stall window: once the stall clock expires the poll slice clamps to 100 ms.
  // The contact retry schedule is its own (1 s doubling, bounded by the contact deadline), so the
  // remaining window costs a handful of calls, never ten a second.
  {
    const deadlineMs = 4_000;
    setContactUnreadableDeadlineMsForTests(deadlineMs);
    setAttemptHardTimeoutMsForTests(6_000);
    const { repo, fake } = hanging(0.01); // 600 ms stall window, expired long before the contact deadline
    const driver = new SubprocessDriver();
    driver.interactive = true;
    const read = driver.read.bind(driver);
    let launched = false;
    let contacts = 0;
    driver.read = async (s, n) => {
      if (!launched) { launched = true; return read(s, n); }
      contacts++;
      throw unreadable();
    };
    driver.waitOutput = async () => { contacts++; throw unreadable(); };
    driver.status = async () => { contacts++; throw unreadable(); };
    const id = "run-contact-past-stall-window";
    const started = Date.now();
    const result = await runDaemon(repo, { adapters: [fake], driver, runId: id, approvalWindowMs: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(deadlineMs);
    expect(result.human).toEqual(["T1"]);
    const events = rows(repo, id);
    expect(events.filter((e) => e.event === "contact-unreadable")).toHaveLength(1);
    expect(contacts).toBeGreaterThan(1);
    expect(contacts).toBeLessThan(16); // ~34 hundred-millisecond slices of two probes each without the schedule
    expect(events.find((e) => e.event === "task-human")?.data).toMatchObject({ kind: "infra", disposition: "contact-unreadable" });
    expect(events.filter((e) => e.event === "worker-hard-timeout" || e.event === "repair-attempt" || e.event === "escalation")).toEqual([]);
    expect(events.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
  }

  // Late loss: contact goes unreadable within one contact window of the hard deadline, so the
  // deadline ends the attempt while it is still latched. That is still contact loss — the same infra
  // park with the work preserved, never the hard-timeout classification and its repair charge.
  {
    setContactUnreadableDeadlineMsForTests(1_500);
    setAttemptHardTimeoutMsForTests(3_000);
    const { repo, fake } = hanging(0.01);
    const driver = new SubprocessDriver();
    driver.interactive = true;
    // A pane that keeps painting new lines: the stall clock stays fresh, so only the hard deadline
    // (or the contact latch) can end this attempt. Every contact fails from 2 s after launch.
    let launchedAt: number | undefined;
    let paints = 0;
    const late = () => launchedAt !== undefined && Date.now() - launchedAt >= 2_000;
    driver.read = async () => { launchedAt ??= Date.now(); if (late()) throw unreadable(); return Array.from({ length: ++paints }, (_, i) => `working-on-it ${i}`).join("\n"); };
    driver.waitOutput = async (_s, _p, ms) => { if (late()) throw unreadable(); await new Promise((r) => setTimeout(r, Math.min(ms, 100))); return false; };
    driver.status = async () => { if (late()) throw unreadable(); return "working"; };
    const id = "run-contact-late-loss";
    const result = await runDaemon(repo, { adapters: [fake], driver, runId: id, approvalWindowMs: 0 });
    expect(result.human).toEqual(["T1"]);
    const events = rows(repo, id);
    expect(events.filter((e) => e.event === "contact-unreadable")).toHaveLength(1);
    expect(events.filter((e) => e.event === "contact-recovered")).toEqual([]);
    const park = events.find((e) => e.event === "task-human");
    expect(park?.data).toMatchObject({ kind: "infra", disposition: "contact-unreadable" });
    expect(String(park?.data.reason)).toMatch(/still latched at the attempt's hard deadline/);
    const ref = events.find((e) => e.event === "worktree-preserved")?.data.ref;
    expect(execFileSync("git", ["show", `${String(ref)}:t1.txt`], { cwd: repo, encoding: "utf8" }).trim()).toBe("kept");
    expect(events.filter((e) => e.event === "worker-hard-timeout" || e.event === "worker-result" || e.event === "repair-attempt" || e.event === "escalation")).toEqual([]);
    expect(events.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
  }
}, 60_000);
