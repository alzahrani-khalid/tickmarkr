// Queue row 363 (D-2187 add.3, ruling A): a consult reroute with no other eligible channel is journaled and
// said — never a silent same-seat recycle — while the same-channel re-dispatch is kept. Every cell of the
// contract's reroute unavailable table runs through runDaemon with the scripted fake adapter and a scripted
// consult verdict; status reads the journal that run wrote. Zero tokens.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import { status } from "../../src/cli/commands/status.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const SILENT = { shell: "true" }; // no trailer: the window burns and the stall consult runs
const GREEN = { shell: `echo ok > f.txt && ${COMMIT} ok`, result: { ok: true, summary: "done" } };
const REROUTE = { action: "reroute", notes: "the seat is stuck" };
const HUMAN = { action: "human", notes: "needs the operator" };
const NOTHING = { shell: "true", result: { ok: true, summary: "nothing landed" } }; // a trailer, no commit: evidence red
const poolCfg = (channels: string[]) =>
  `routing:\n  map:\n    implement:\n      pool: { mode: ordered, channels: [${channels.join(", ")}] }\n`;
const ONE = "routing.map.implement.pool (ordered: fake:fake-1)";
const key = (a: unknown) => `${(a as { adapter: string }).adapter}:${(a as { model: string }).model}`;

type Row = JournalEvent & { line: number };
interface Cell { steps: object[]; extraCfg?: string; consult?: Record<string, unknown>; oneChannel?: boolean; demoted?: string; humanAfterRow?: boolean }

const capture = () => {
  const notices: string[] = [];
  const driver = new SubprocessDriver();
  driver.notify = async (msg) => { notices.push(msg); };
  return { notices, driver };
};

const sourced = (repo: string, runId: string): Row[] => {
  const { events, lines } = Journal.open(repo, runId).readSourced();
  return events.map((e, i) => ({ ...e, line: lines[i]! }));
};

const runCell = async (runId: string, cell: Cell) => {
  const made = setupRepo([T("T1", { timeoutMinutes: 0.05, routingHints: { escalate: false } })], {
    consult: cell.consult ?? REROUTE,
    tasks: { T1: cell.steps },
  }, cell.extraCfg ?? "");
  if (cell.humanAfterRow) {
    // the scripted consult answers reroute until this run has journaled an unavailable reroute, then human —
    // so the engagement parks on a consult verdict without demoting its only seat
    const script = (made.fake as unknown as { script: Record<string, unknown> }).script;
    Object.defineProperty(script, "consult", {
      get: () => {
        try { return Journal.open(made.repo, runId).read().some((e) => e.event === "reroute-unavailable") ? HUMAN : REROUTE; } catch { return REROUTE; }
      },
    });
  }
  if (cell.oneChannel) made.fake.channels = () => [{ adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" }];
  if (cell.demoted) {
    // the other pool member is already demoted before the task's first dispatch (a resumed run's replayed demotion)
    const j = Journal.create(made.repo, runId);
    j.append("run-start", undefined, { baseRef: await gitHead(made.repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(made.repo)) });
    j.append("channel-demotion", "T1", { channel: cell.demoted, streak: 2 });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  }
  const { notices, driver } = capture();
  const summary = await runDaemon(made.repo, { adapters: [made.fake], runId, driver, resume: !!cell.demoted });
  const all = sourced(made.repo, runId);
  return { ...made, runId, summary, all, rows: all.filter((e) => e.taskId === "T1"), notices };
};

const memo = <V>(make: () => Promise<V>) => { let p: Promise<V> | undefined; return () => (p ??= make()); };
// The one-member pool whose kept re-dispatch lands green work: shared by the journal test and the done-task control.
const onePoolDone = memo(() => runCell("run-ru-one", { steps: [SILENT, GREEN], extraCfg: poolCfg(["fake:fake-1"]) }));

const trace = (rows: Row[]) => rows.map((e) => `${e.event}${e.event === "task-dispatch" ? `:${key(e.data.assignment)}`
  : e.event === "task-human" || e.event === "task-failed" ? `(${String(e.data.reason ?? e.data.error)})` : ""}`).join(" ");
const dispatches = (rows: Row[]) => rows.filter((e) => e.event === "task-dispatch").map((e) => key(e.data.assignment));

/** The degenerate reroute's rows: the verdict, the row, the base channel-recycle bytes, then the same-channel dispatch. */
const expectUnavailable = (rows: Row[], all: Row[], pool: string, excludeAdapter?: string) => {
  const t = trace(rows);
  const verdict = rows.findIndex((e) => e.event === "consult-verdict" && e.data.action === "reroute");
  expect(verdict, t).toBeGreaterThanOrEqual(0);
  const marks = rows.filter((e) => e.event === "reroute-unavailable");
  expect(marks, t).toHaveLength(1);
  const mark = marks[0]!;
  expect(mark.data, t).toEqual({ pool, channel: "fake:fake-1", attempt: 1, ...(excludeAdapter ? { excludeAdapter } : {}) });
  expect(rows.indexOf(mark), t).toBeGreaterThan(verdict);
  // immediately before the channel-recycle row naming the same channel, whose bytes stay as at the base
  const next = all[all.indexOf(mark) + 1]!;
  expect(next.event, t).toBe("channel-recycle");
  expect(next.data, t).toEqual({ site: "consult-reroute", channel: "fake:fake-1" });
  // the same-channel re-dispatch is kept (ruling A): the next dispatch is the recycled seat, never a park
  const redispatch = rows.slice(rows.indexOf(mark)).find((e) => e.event === "task-dispatch" || e.event === "task-human");
  expect(redispatch?.event, t).toBe("task-dispatch");
  expect(key(redispatch!.data.assignment), t).toBe("fake:fake-1");
  expect(dispatches(rows), t).toEqual(["fake:fake-1", "fake:fake-1"]);
};

describe("queue row 363: a consult reroute with no other eligible channel is journaled and said", () => {
  test("a consult reroute with no other eligible channel journals the unavailable reroute naming the pool and the channel and keeps the same channel re-dispatch", async () => {
    // One-member pool (RED at the base: the recycle fell back to the current assignment silently).
    const one = await onePoolDone();
    expectUnavailable(one.rows, one.all, ONE);
    expect(one.summary.done, trace(one.rows)).toEqual(["T1"]);

    // Pool of two whose other member is demoted: the same as the one-member pool.
    const demoted = await runCell("run-ru-demoted", { steps: [SILENT, SILENT], extraCfg: poolCfg(["fake:fake-1", "fake:fake-2"]), demoted: "fake:fake-2" });
    expectUnavailable(demoted.rows, demoted.all, "routing.map.implement.pool (ordered: fake:fake-1, fake:fake-2)");

    // Unpooled fleet with one channel: the pool named as the discovered worker fleet.
    const open = await runCell("run-ru-open", { steps: [SILENT, SILENT], oneChannel: true });
    expectUnavailable(open.rows, open.all, "the discovered worker fleet (fake:fake-1)");

    // Reroute verdict naming the only adapter as excluded: the same, the row carrying excludeAdapter.
    const excluded = await runCell("run-ru-excluded", {
      steps: [SILENT, GREEN], extraCfg: poolCfg(["fake:fake-1"]), consult: { ...REROUTE, excludeAdapter: "fake" },
    });
    expectUnavailable(excluded.rows, excluded.all, ONE, "fake");
  }, 300_000);

  test("a pool with another eligible channel reroutes exactly as before and journals no unavailable reroute", async () => {
    const two = await runCell("run-ru-control", { steps: [SILENT, GREEN], extraCfg: poolCfg(["fake:fake-1", "fake:fake-2"]) });
    const t = trace(two.rows);
    const verdict = two.rows.findIndex((e) => e.event === "consult-verdict" && e.data.action === "reroute");
    expect(verdict, t).toBeGreaterThanOrEqual(0);
    // the reroute fails over to the other member: no unavailable row and no recycle anywhere in the run
    expect(two.all.some((e) => e.event === "reroute-unavailable"), t).toBe(false);
    expect(two.all.some((e) => e.event === "channel-recycle"), t).toBe(false);
    expect(dispatches(two.rows), t).toEqual(["fake:fake-1", "fake:fake-2"]);
    expect(two.summary.done, t).toEqual(["T1"]);
    // and nothing about it is said in status or any notice
    expect(two.notices.some((m) => /reroute unavailable/i.test(m))).toBe(false);
    expect(await status([], two.repo)).not.toContain("reroute unavailable");
    expect(await status(["--oneline"], two.repo)).not.toContain("reroute unavailable");
  }, 180_000);

  test("status and the park notice of that engagement name the unavailable reroute while a later engagement and a done task do not", async () => {
    // Engagement 1: the reroute recycles the one member; the kept re-dispatch lands nothing (a retry rung that
    // also resets the no-trailer streak, so the seat never demotes), the next window is silent and the stall
    // consult now says human — a later park of the same engagement.
    const parked = await runCell("run-ru-park", { steps: [SILENT, NOTHING, SILENT], extraCfg: poolCfg(["fake:fake-1"]), humanAfterRow: true });
    const t = trace(parked.rows);
    expect(parked.summary.human, t).toEqual(["T1"]);
    const mark = parked.rows.find((e) => e.event === "reroute-unavailable")!;
    expect(mark, t).toBeDefined();
    const sentence = `Reroute unavailable at journal line ${mark.line}: the consult reroute found no other eligible channel in ${ONE}, so fake:fake-1 was re-dispatched.`;
    const parkNotices = parked.notices.filter((m) => m.includes("T1 needs a human"));
    expect(parkNotices, t).toHaveLength(1);
    expect(parkNotices[0]!.split("\n"), t).toContain(sentence);
    const note = `T1 reroute unavailable — no other eligible channel in ${ONE}; fake:fake-1 re-dispatched (journal line ${mark.line})`;
    const body = await status([], parked.repo);
    expect(body.split("\n").filter((line) => line.includes(note)), body).toHaveLength(1);
    expect(await status(["--oneline"], parked.repo)).toContain(note);
    expect(await status(["--json"], parked.repo)).not.toContain("reroute unavailable"); // the snapshot is unchanged

    // Engagement 2 (control): released, resumed, and parked again on the consult's human verdict — its
    // notice and status no longer name the earlier engagement's unavailable reroute.
    await approve([parked.runId, "T1", "--by", "test"], parked.repo);
    const later = capture();
    await runDaemon(parked.repo, { adapters: [parked.fake], runId: parked.runId, driver: later.driver, resume: true });
    const after = sourced(parked.repo, parked.runId).filter((e) => e.taskId === "T1");
    const approvedAt = after.findLastIndex((e) => e.event === "task-approved");
    expect(approvedAt, trace(after)).toBeGreaterThan(after.indexOf(after.find((e) => e.event === "reroute-unavailable")!));
    expect(after.slice(approvedAt).some((e) => e.event === "task-human"), trace(after)).toBe(true);
    const laterPark = later.notices.filter((m) => m.includes("T1 needs a human"));
    expect(laterPark, trace(after)).toHaveLength(1);
    expect(laterPark[0], trace(after)).not.toContain("Reroute unavailable");
    expect(await status([], parked.repo)).not.toContain("reroute unavailable");
    expect(await status(["--oneline"], parked.repo)).not.toContain("reroute unavailable");

    // A done task (control): the engagement holds the row but the task is done, so status says nothing.
    const done = await onePoolDone();
    expect(done.rows.some((e) => e.event === "reroute-unavailable")).toBe(true);
    expect(done.summary.done).toEqual(["T1"]);
    expect(done.notices.some((m) => m.includes("needs a human"))).toBe(false);
    expect(await status([], done.repo)).not.toContain("reroute unavailable");
    expect(await status(["--oneline"], done.repo)).not.toContain("reroute unavailable");
  }, 300_000);
});
