// Queue row 396 (D-2187 add.25, verbatim ruling): a harvested no-trailer window is NOT counted toward
// the OBS-57 demotion streak only when its gate round ends all green; red and undetermined rounds
// count, a window with no commits counts as at the base, and the exemptions are untouched. Every case
// drives the production daemon with fake adapters and scripted gate verdicts (zero tokens).
// tests/run/daemon/harvest.test.ts stays byte-identical as the control for harvested + red gates.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../src/adapters/types.js";
import type { TickmarkrConfig } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { Slot } from "../../src/drivers/types.js";
import * as graphModule from "../../src/graph/graph.js";
import { resetCapacityBackoffMsForTests, runDaemon, setCapacityBackoffMsForTests } from "../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { NoTrailerStreak } from "../../src/run/no-trailer-streak.js";
import { authedModels, COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const STALL = { shell: "echo stall; exit 0" }; // no trailer, no commit: a window that counts at once
const harvest = (id: string) => ({ shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}` }); // commits, no trailer
const finish = (id: string) => ({ ...harvest(id), result: { ok: true, summary: id } });
/** Waits (60 s cap) for `gate` before it commits and certifies: a window that ends after the gate opens. */
const finishAfter = (gate: string, id: string) => ({
  shell: `for i in $(seq 600); do [ -f ${shq(gate)} ] && break; sleep 0.1; done; ${harvest(id).shell}`,
  result: { ok: true, summary: id },
});
const RETRY = { action: "retry", notes: "a no-trailer window is not a verdict" };
const RED = { pass: false, criteria: [{ criterion: "c1", met: false, reason: "a.txt lacks the behavior" }] };
const GREEN = { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] };
const PANE = "visibility:\n  llm: pane\n  keepPanes: run\n";

const rowsOf = (repo: string, runId: string) => Journal.open(repo, runId).read();
const of = (rows: JournalEvent[], event: string, taskId = "T1") => rows.filter((e) => e.event === event && e.taskId === taskId);
const channelOf = (e: JournalEvent) => {
  const a = e.data.assignment as { adapter: string; model: string };
  return `${a.adapter}:${a.model}`;
};
/** Exactly one demotion — T1's first channel at streak 2 — landing after `anchor`; returns its index. */
const demotedAfter = (rows: JournalEvent[], anchor: JournalEvent) => {
  const demotions = rows.filter((e) => e.event === "channel-demotion");
  expect(demotions.map((e) => [e.taskId, e.data])).toEqual([["T1", { channel: channelOf(of(rows, "task-dispatch")[0]!), streak: 2 }]]);
  const at = rows.indexOf(demotions[0]!);
  expect(at).toBeGreaterThan(rows.indexOf(anchor));
  return at;
};

/** Every row is journaled, in the order given. */
const inOrder = (rows: JournalEvent[], ...events: JournalEvent[]) => {
  const at = events.map((e) => rows.indexOf(e));
  expect(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1]!)), JSON.stringify(at)).toBe(true);
};

// A real SubprocessDriver whose pane creation refuses the names `refuse` picks: that seat never launches.
function refusingDriver(refuse: (name: string) => boolean) {
  const inner = new SubprocessDriver();
  return {
    id: "subprocess", interactive: false,
    status: inner.status.bind(inner),
    async slot(cwd: string, name: string) {
      if (refuse(name)) throw new Error(`pane create refused for ${name}`);
      return inner.slot(cwd, name);
    },
    run: (slot: Slot, command: string) => inner.run(slot, command),
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  };
}

// The seat-launch suite's malformed-review fixture: fake-2 sits below the review floor, so seat-a is
// the only eligible reviewer, and it answers with one missing comma every time.
class Author extends FakeAdapter {
  override channels(cfg: TickmarkrConfig): BillingChannel[] { return [super.channels(cfg)[0]!, { ...super.channels(cfg)[1]!, tier: "cheap" }]; }
}
// A fake with a single seat: a quota wall has nowhere to fail over to.
class OneSeat extends FakeAdapter {
  override channels(cfg: TickmarkrConfig): BillingChannel[] { return [super.channels(cfg)[0]!]; }
}
class MalformedReviewer extends FakeAdapter {
  override id = "seat-a";
  override vendor = "seat-a";
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: ["seat-a"], modelAuth: authedModels(["seat-a"]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: "seat-a", model: "seat-a", vendor: "seat-a", channel: "api", tier: "frontier" }];
  }
  override headlessCommand(file: string): string {
    const prompt = readFileSync(file, "utf8");
    if (!prompt.startsWith("TICKMARKR-REVIEW")) return "true";
    const nonce = /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)?.[1] ?? "";
    return `printf '%s' ${shq(`{"nonce": "${nonce}", "approve": true, "findings": [] "resolved": []}`)}`;
  }
}

afterEach(() => { vi.restoreAllMocks(); resetCapacityBackoffMsForTests(); });

describe("row 396: a harvested no-trailer window counts unless its gate round ends all green", { timeout: 120_000 }, () => {
  test("a harvested no-trailer window whose gate round ends all green leaves a nonzero streak unchanged with no increment no reset and no certification", async () => {
    // T1: an empty window (streak 1), then a harvested window whose round goes all green and merges.
    // T2: one more empty window on the same channel must find the streak still at 1 and demote at 2.
    const { repo, fake } = setupRepo([T("T1"), T("T2", { deps: ["T1"] })], {
      consult: RETRY, tasks: { T1: [STALL, harvest("a")], T2: [STALL, finish("b")] },
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-396-green" });
    expect(s.done).toEqual(["T1", "T2"]);
    const rows = rowsOf(repo, "run-396-green");
    expect(of(rows, "worker-result-harvested")).toHaveLength(1);
    const round = of(rows, "gate-result");
    expect(round.length).toBeGreaterThan(0);
    expect(round.every((e) => e.data.pass !== false)).toBe(true);
    expect(of(rows, "merge")).toHaveLength(1);
    expect(of(rows, "task-dispatch").map(channelOf)).toEqual(["fake:fake-1", "fake:fake-1"]);
    // no increment (that demotes on T1 at its harvest) and no reset (that leaves T2 at streak 1, undemoted)
    const demotions = rows.filter((e) => e.event === "channel-demotion");
    expect(demotions.map((e) => [e.taskId, e.data])).toEqual([["T2", { channel: "fake:fake-1", streak: 2 }]]);
    expect(rows.indexOf(demotions[0]!)).toBeGreaterThan(rows.indexOf(of(rows, "task-done")[0]!));
    expect(of(rows, "task-dispatch", "T2").map(channelOf)).toEqual(["fake:fake-1", "fake:fake-2"]);
  });

  test("a harvested window whose gate round has a red gate counts toward the streak", async () => {
    const { repo, fake } = setupRepo([T("T1")], {
      judge: [RED, RED, GREEN], consult: RETRY, tasks: { T1: [harvest("a"), harvest("b"), finish("c")] },
    });
    await runDaemon(repo, { adapters: [fake], runId: "run-396-red" });
    const rows = rowsOf(repo, "run-396-red");
    const harvested = of(rows, "worker-result-harvested");
    expect(harvested.length).toBeGreaterThanOrEqual(2);
    const acceptance = of(rows, "gate-result").filter((e) => e.data.gate === "acceptance");
    expect(acceptance.slice(0, 2).map((e) => e.data.pass)).toEqual([false, false]);
    // both red rounds counted (streak 2), each when its round went red — never at the harvest
    const at = demotedAfter(rows, acceptance[1]!);
    expect(at).toBeGreaterThan(rows.indexOf(harvested[1]!));
    expect(rows.slice(at).filter((e) => e.event === "task-dispatch").every((e) => channelOf(e) !== "fake:fake-1")).toBe(true);
  });

  test("a harvested window whose round is seatless infra parked cancelled killed or outlived by the run counts and a window still deferred at run end is counted then", async () => {
    // Every case: an empty window first (streak 1), then a harvested window whose round never ends all green.
    const steps = { consult: RETRY, tasks: { T1: [STALL, harvest("a")] } };

    // Seatless: no judge seat can launch, the round parks infra and the window counts as it settles.
    {
      const { repo, fake } = setupRepo([T("T1")], steps, PANE);
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-396-seatless", driver: refusingDriver((name) => name.startsWith("tickmarkr:judge:")) });
      expect(s.human).toEqual(["T1"]);
      const rows = rowsOf(repo, "run-396-seatless");
      expect(of(rows, "worker-result-harvested")).toHaveLength(1);
      expect(of(rows, "gate-result").filter((e) => e.data.gate === "acceptance").at(-1)?.data).toMatchObject({ infra: true });
      const park = of(rows, "task-human").at(-1)!;
      expect(park.data.kind).toBe("infra");
      demotedAfter(rows, park);
    }

    // Infra parked: the only reviewer delivers a malformed verdict twice, the round parks infra.
    {
      const { repo, scriptPath } = setupRepo([T("T1")], steps, "review: { required: true, prefer: [seat-a], timeoutMs: 5000 }\n");
      const config = join(repo, ".tickmarkr", "config.yaml");
      writeFileSync(config, readFileSync(config, "utf8").replace("judge: { adapter: fake, model: fake-1 }", "judge: { adapter: fake, model: fake-2 }"));
      const s = await runDaemon(repo, { adapters: [new Author(scriptPath), new MalformedReviewer(scriptPath)], runId: "run-396-infra" });
      expect(s.human).toEqual(["T1"]);
      const rows = rowsOf(repo, "run-396-infra");
      expect(of(rows, "worker-result-harvested")).toHaveLength(1);
      expect(of(rows, "gate-result").filter((e) => e.data.gate === "review").at(-1)?.data).toMatchObject({ infra: true });
      const park = of(rows, "task-human").at(-1)!;
      expect(park.data.kind).toBe("infra");
      demotedAfter(rows, park);
    }

    // Cancelled and killed: the task's execution ceiling expires inside the round's test job, kills the
    // attempt and parks it. The cut-short round never ends all green, so the window counts.
    {
      const { repo, fake } = setupRepo([T("T1")], steps,
        `executionPolicy: { taskExecutionLimitMs: 15000 }\ngates:\n  test: ${JSON.stringify("test -f a.txt && sleep 60 || true")}\n`);
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-396-killed", driver: new SubprocessDriver() });
      expect(s.human).toEqual(["T1"]);
      const rows = rowsOf(repo, "run-396-killed");
      expect(of(rows, "worker-result-harvested")).toHaveLength(1);
      expect(of(rows, "merge")).toEqual([]);
      const park = of(rows, "task-human").at(-1)!;
      expect(park.data).toMatchObject({ disposition: "execution-budget-exhausted" });
      const round = rows.findLast((e) => e.event === "phase-start" && e.taskId === "T1" && e.data.phase === "gates")!;
      expect(rows.indexOf(round)).toBeGreaterThan(rows.indexOf(of(rows, "worker-result-harvested")[0]!));
      expect(demotedAfter(rows, round)).toBeLessThan(rows.findIndex((e) => e.event === "run-end"));
    }

    // Still deferred at run end: the harvested window walls on quota with no other seat to fail over to,
    // so it parks before any gate round. Nothing settles it; the normal close counts it before run-end.
    {
      const walled = { shell: `echo a > a.txt && ${COMMIT} a && echo 'usage limit reached for this model'; exit 1` };
      const { repo, scriptPath } = setupRepo([T("T1")], { consult: RETRY, tasks: { T1: [STALL, walled] } });
      const s = await runDaemon(repo, { adapters: [new OneSeat(scriptPath)], runId: "run-396-deferred" });
      expect(s.human).toEqual(["T1"]);
      const rows = rowsOf(repo, "run-396-deferred");
      expect(of(rows, "worker-result-harvested")).toHaveLength(1);
      expect(of(rows, "gate-result")).toEqual([]);
      expect(of(rows, "quota-failover").at(-1)?.data.to).toBeNull();
      const park = of(rows, "task-human").at(-1)!;
      expect(park.data.kind).toBe("quota");
      const at = demotedAfter(rows, park);
      expect(rows[at + 1]).toMatchObject({ event: "run-end" });
      expect(rows[at + 1]!.data.fatal).toBeUndefined();
    }

    // Outlived by the run: the scheduler dies while the round's test job runs; the fatal stop cancels the
    // round before it can merge, and the fatal close counts the still-deferred window before its run-end.
    {
      const { repo, fake } = setupRepo([T("T1")], steps, `gates:\n  test: ${JSON.stringify("test -f a.txt && sleep 3 || true")}\n`);
      const boom = new Error("scheduler sweep exploded mid-round");
      const real = graphModule.batteryPriority;
      let armed = false;
      let threw = false;
      vi.spyOn(graphModule, "batteryPriority").mockImplementation((...args) => {
        if (armed && !threw) { threw = true; throw boom; }
        return real(...args);
      });
      await expect(runDaemon(repo, {
        adapters: [fake], runId: "run-396-fatal",
        narrate: (e) => { if (e.event === "phase-start" && e.taskId === "T1" && e.data.phase === "gates") armed = true; },
      })).rejects.toBe(boom);
      expect(threw).toBe(true);
      const rows = rowsOf(repo, "run-396-fatal");
      expect(of(rows, "worker-result-harvested")).toHaveLength(1);
      expect(of(rows, "merge")).toEqual([]);
      const round = rows.findLast((e) => e.event === "phase-start" && e.taskId === "T1" && e.data.phase === "gates")!;
      const at = demotedAfter(rows, round);
      expect(rows[at + 1]).toMatchObject({ event: "run-end", data: { fatal: true, error: boom.message } });
    }

    // Cancelled by a deliberate stop: SIGTERM lands as the harvested window's round opens. The reaper counts
    // the still-deferred window before exit, and a deliberate stop still journals no run-end.
    {
      const { repo, fake } = setupRepo([T("T1")], steps);
      const runId = "run-396-sigterm";
      let atExit: JournalEvent[] = [];
      let exited!: (code: number) => void;
      const exitCode = new Promise<number>((resolve) => { exited = resolve; });
      const driver = { ...refusingDriver(() => false), project: async (taskId: string, state: string) => {
        if (taskId !== "T1" || state !== "in-review") return;
        process.emit("SIGTERM", "SIGTERM");
        await new Promise(() => {});
      } };
      await expect(runDaemon(repo, { adapters: [fake], runId, driver,
        exit: (code) => { atExit = rowsOf(repo, runId); exited(code); } })).rejects.toThrow("terminated by SIGTERM");
      expect(await exitCode).toBe(143);
      expect(of(atExit, "worker-result-harvested")).toHaveLength(1);
      expect(of(atExit, "gate-result")).toEqual([]);
      const cause = atExit.find((e) => e.event === "exit-cause")!;
      expect(cause.data).toEqual({ cause: "deliberate", signal: "SIGTERM" });
      demotedAfter(atExit, cause);
      expect(rowsOf(repo, runId).filter((e) => e.event === "run-end")).toEqual([]);
    }
  });

  test("a no-trailer window with no commits counts toward the streak as at the base", async () => {
    const { repo, fake } = setupRepo([T("T1")], { consult: RETRY, tasks: { T1: [STALL, STALL, finish("c")] } });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-396-empty" });
    expect(s.done).toEqual(["T1"]);
    const rows = rowsOf(repo, "run-396-empty");
    expect(of(rows, "worker-result-harvested")).toEqual([]);
    const second = of(rows, "worker-result")[1]!;
    // counted at once: after the second window's result and before anything follows it on this task
    const at = demotedAfter(rows, second);
    const next = rows.findIndex((e, i) => i > rows.indexOf(second) && e.taskId === "T1" && e.event !== "channel-demotion");
    expect(at).toBeLessThan(next);
    expect(of(rows, "task-dispatch").map(channelOf)).toEqual(["fake:fake-1", "fake:fake-1", "fake:fake-2"]);
  });

  test("provider death a refused pin quota and transient capacity stay exempt from the streak", async () => {
    setCapacityBackoffMsForTests(100);
    // Each exempt window carries a commit, so it is harvested too: the exemption, not the round, decides it.
    const exempt = (tail: string) => ({ shell: `echo x > x.txt && ${COMMIT} x && echo ${shq(tail)}; exit 1` });
    const cases = [
      { name: "provider", tail: "Unable to reach the model provider", row: "provider-death-requeue", task: {} },
      { name: "pin", tail: "usage limit reached for this model", row: "quota-failover-refused", task: { routingHints: { pin: { via: "fake", model: "fake-1" } } } },
      { name: "capacity", tail: "Selected model is at capacity", row: "capacity-requeue", task: {} },
    ];
    for (const c of cases) {
      const runId = `run-396-exempt-${c.name}`;
      const { repo, fake } = setupRepo([T("T1", c.task)], { consult: RETRY, tasks: { T1: [STALL, exempt(c.tail), finish("c")] } });
      const s = await runDaemon(repo, { adapters: [fake], runId });
      expect(s.done, c.name).toEqual(["T1"]);
      const rows = rowsOf(repo, runId);
      expect(of(rows, "worker-result")[0]!.data.finished, c.name).toBe(false); // the empty window: streak 1
      expect(of(rows, c.row), c.name).toHaveLength(1);
      expect(of(rows, "worker-result-harvested").length, c.name).toBeGreaterThanOrEqual(1);
      expect(rows.filter((e) => e.event === "channel-demotion"), c.name).toEqual([]);
      expect(of(rows, "task-dispatch").map(channelOf), c.name).toEqual(["fake:fake-1", "fake:fake-1", "fake:fake-1"]);
    }
  });

  test("a harvested window that merges all green is discharged at publication before a completed projection that rejects", async () => {
    // Streak 1, then a harvested window merges all green; the host's completed projection then rejects
    // and fails the task. The merged window was all green: nothing may count it at run-end.
    const { repo, fake } = setupRepo([T("T1")], { consult: RETRY, tasks: { T1: [STALL, harvest("a")] } });
    const refused = new Error("host refused the completed projection");
    const driver = { ...refusingDriver(() => false),
      project: async (_taskId: string, state: string) => { if (state === "completed") throw refused; } };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-396-projection", driver });
    expect(s.failed).toEqual(["T1"]);
    const rows = rowsOf(repo, "run-396-projection");
    expect(of(rows, "worker-result-harvested")).toHaveLength(1);
    expect(of(rows, "gate-result").every((e) => e.data.pass !== false)).toBe(true);
    const merge = of(rows, "merge");
    expect(merge).toHaveLength(1);
    const failed = of(rows, "task-failed");
    expect(failed.map((e) => e.data.error)).toEqual([String(refused)]);
    expect(rows.indexOf(failed[0]!)).toBeGreaterThan(rows.indexOf(merge[0]!));
    expect(rows.filter((e) => e.event === "channel-demotion")).toEqual([]);
  });

  // Window order across concurrent tasks. T1's harvested window A is decided first; T2's window B ends after
  // it and certifies the same channel; T3 (after T2) burns an empty window C in a fresh worktree, then merges
  // a harvested window all green (no increment, no reset). T1's host review projection (after A, before A's
  // round) opens B's gate and holds A's round until T3 is done, so B and C always land between A and A's
  // decision. In window order A | B resets | C the streak is 1: counting A after B's reset reaches 2.
  const crossed = async (runId: string, judge: unknown[], t1: object[], then: () => void = () => {}) => {
    const gate = join(makeTestTempDir("row396-"), "gate");
    const { repo, fake } = setupRepo([T("T1"), T("T2"), T("T3", { deps: ["T2"] })], {
      judge, consult: RETRY, tasks: { T1: t1, T2: [finishAfter(gate, "b")], T3: [STALL, harvest("d")] },
    });
    let open!: () => void;
    const t3Done = new Promise<void>((resolve) => { open = resolve; });
    let held = false;
    const driver = { ...refusingDriver(() => false), project: async (taskId: string, state: string) => {
      if (taskId !== "T1" || state !== "in-review" || held) return;
      held = true;
      writeFileSync(gate, "");
      await t3Done;
      then();
    } };
    const s = await runDaemon(repo, { adapters: [fake], runId, driver,
      narrate: (e) => { if (e.event === "task-done" && e.taskId === "T3") open(); } });
    const rows = rowsOf(repo, runId);
    const b = of(rows, "worker-result", "T2")[0]!;
    const c = of(rows, "worker-result", "T3")[0]!;
    expect(b.data.ok).toBe(true);
    expect(c.data.finished).toBe(false);
    expect(of(rows, "worker-result-harvested", "T3")).toHaveLength(1);
    expect([...of(rows, "task-dispatch", "T2"), ...of(rows, "task-dispatch", "T3")].map(channelOf)).toEqual(["fake:fake-1", "fake:fake-1", "fake:fake-1"]);
    return { s, rows, a: of(rows, "worker-result-harvested")[0]!, b, c };
  };

  test("a harvested window settled red after a later window certifies its channel never extends the cleared streak", async () => {
    // Judge order: T2's round, T3's round, A's round (red), T1's certifying repair.
    const { s, rows, a, b, c } = await crossed("run-396-order-red", [GREEN, GREEN, RED, GREEN], [harvest("a"), finish("c")]);
    const red = of(rows, "gate-result").find((e) => e.data.gate === "acceptance" && e.data.pass === false)!;
    inOrder(rows, a, b, c, red);
    expect(rows.filter((e) => e.event === "channel-demotion")).toEqual([]);
    // a false demotion would move T1's repair to fake-2 and leave no cross-vendor reviewer for it
    expect(of(rows, "task-dispatch").map(channelOf)).toEqual(["fake:fake-1", "fake:fake-1"]);
    expect(of(rows, "worker-result-harvested")).toHaveLength(1);
    expect(s.done).toEqual(["T1", "T2", "T3"]);
  });

  test("a harvested window flushed at run end after a later window certifies its channel never extends the cleared streak", async () => {
    // T1 fails at the held projection, before A's round settles: only the run-end flush decides A.
    const refused = new Error("host refused the in-review projection");
    const { s, rows, a, b, c } = await crossed("run-396-order-flush", [GREEN], [harvest("a")], () => { throw refused; });
    expect(s.done).toEqual(["T2", "T3"]);
    expect(s.failed).toEqual(["T1"]);
    const failed = of(rows, "task-failed")[0]!;
    const end = rows.find((e) => e.event === "run-end")!;
    expect(of(rows, "gate-result")).toEqual([]);
    expect(failed.data.error).toBe(String(refused));
    expect(end.data.fatal).toBeUndefined();
    inOrder(rows, a, b, c, failed, end);
    expect(rows.filter((e) => e.event === "channel-demotion")).toEqual([]);
  });
});

describe("NoTrailerStreak", () => {
  test("a deferred window routed away before any gate round counts at its task's next window, and a regate keeps it deferred", () => {
    const counted: Array<[string, string, number]> = [];
    const streak = new NoTrailerStreak((taskId, channel, n) => counted.push([taskId, channel, n]));
    const harvested = { certifies: false, counts: true, harvested: true };
    streak.window("T1", "a:1", harvested);
    streak.roundEnded("T1", "regate");
    expect(counted).toEqual([]);
    streak.window("T1", "a:2", { certifies: true, counts: false, harvested: false });
    expect(counted).toEqual([["T1", "a:1", 1]]);
    streak.window("T2", "a:1", harvested);
    streak.roundEnded("T2", "conflict");
    expect(counted).toEqual([["T1", "a:1", 1], ["T2", "a:1", 2]]);
    streak.window("T3", "a:1", harvested);
    streak.roundEnded("T3", "merged");
    streak.flush();
    expect(counted).toHaveLength(2);
  });

  test("every interleaving of three concurrent windows on one channel and their round settlements reaches the window-order streak", () => {
    // Bounded: 5 kinds ^ 3 windows (one task each), every harvested settlement anywhere after its own window,
    // the rest flushed at run end; then one more empty window reads the live streak.
    type Kind = "empty" | "certify" | "red" | "green" | "flushed";
    const KINDS: Kind[] = ["empty", "certify", "red", "green", "flushed"];
    const harvested = { certifies: false, counts: true, harvested: true };
    const shape = { empty: { ...harvested, harvested: false }, certify: { certifies: true, counts: false, harvested: false },
      red: harvested, green: harvested, flushed: harvested };
    // OBS-57 in WINDOW order: the most consecutive counted windows between certifications; all green is neither.
    const reference = (ws: Kind[]) => {
      let run = 0;
      let max = 0;
      for (const k of ws) {
        if (k === "certify") run = 0;
        else if (k !== "green") max = Math.max(max, ++run);
      }
      return { max, live: run };
    };
    // Event i >= 0 opens window i; ~i settles it (red or green only, after it opened).
    const orders = (ws: Kind[]): number[][] => {
      const out: number[][] = [];
      const walk = (next: number, open: number[], seq: number[]) => {
        if (next === ws.length && open.length === 0) out.push(seq);
        if (next < ws.length) walk(next + 1, ws[next] === "red" || ws[next] === "green" ? [...open, next] : open, [...seq, next]);
        for (const i of open) walk(next, open.filter((j) => j !== i), [...seq, ~i]);
      };
      walk(0, [], []);
      return out;
    };
    let cases = 0;
    for (const a of KINDS) for (const b of KINDS) for (const c of KINDS) {
      const ws = [a, b, c];
      const want = reference(ws);
      for (const seq of orders(ws)) {
        const seen: number[] = [];
        const streak = new NoTrailerStreak((_task, _channel, n) => seen.push(n));
        for (const e of seq) {
          if (e >= 0) streak.window(`T${e}`, "c", shape[ws[e]!]);
          else streak.roundEnded(`T${~e}`, ws[~e] === "green" ? "merged" : "red");
        }
        streak.flush();
        const label = `${ws.join(",")} via ${seq.join(",")}`;
        expect(Math.max(0, ...seen), label).toBe(want.max);
        streak.window("probe", "c", shape.empty);
        expect(seen.at(-1), label).toBe(want.live + 1);
        cases++;
      }
    }
    expect(cases).toBeGreaterThan(125);
  });
});
