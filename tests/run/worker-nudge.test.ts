// OBS-201: the liveness nudge — the daemon's ACTIVE response to an idle worker holding no trailer.
// One latched nudge through the driver's verified-delivery surface; if the grace passes still idle
// with no progress, the wait concludes as a stall immediately (the consult sees the un-answered
// nudge) instead of burning the remainder of the window. Consult-ratified 3/3 (CONSULT-liveness).
import { describe, expect, test, afterEach } from "vitest";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { HerdrDriver } from "../../src/drivers/herdr.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import {
  NUDGEABLE_ADAPTERS, resetNudgeTimingForTests, runDaemon, setNudgeTimingForTests, WORKER_NUDGE_MESSAGE,
} from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

function idriver(overrides: Record<string, unknown> = {}): ExecutorDriver {
  const inner = new SubprocessDriver();
  return {
    id: "interactive-fake",
    interactive: true,
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    waitOutput: async () => { await new Promise((r) => setTimeout(r, 50)); return false; },
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
    status: async () => "idle",
    ...overrides,
  } as ExecutorDriver;
}

// a worker that prints something (so early-launch liveness passes) but never emits a trailer
const STALLED_SCRIPT = {
  consult: { action: "human", notes: "stalled after nudge" },
  tasks: { T1: [{ shell: "echo working-on-it" }] },
};

afterEach(() => {
  NUDGEABLE_ADAPTERS.delete("fake");
  resetNudgeTimingForTests();
});

describe("worker liveness nudge (OBS-201, zero-token)", () => {
  test("an idle nudgeable worker is nudged once, and an unanswered grace concludes the wait as a stall with the nudge on record", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(0, 500);
    const nudges: string[] = [];
    const notifies: string[] = [];
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED_SCRIPT);
    const driver = idriver({
      read: async () => "working-on-it", // a live TUI holding no trailer and no exit marker
      nudge: async (_slot: unknown, message: string) => { nudges.push(message); return true; },
      notify: async (msg: string) => { notifies.push(msg); },
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-nudge-expire", driver });
    expect(s.human).toEqual(["T1"]);
    expect(nudges).toEqual([WORKER_NUDGE_MESSAGE]); // exactly one nudge, the frozen nonce-free text
    const evs = Journal.open(repo, "run-nudge-expire").read();
    expect(evs.filter((e) => e.event === "worker-nudge")).toHaveLength(1);
    expect(evs.filter((e) => e.event === "worker-nudge-expired")).toHaveLength(1);
    // the conclusion classifies through the existing tail — no new cause, no schema change
    const wr = evs.find((e) => e.event === "worker-result" && e.taskId === "T1");
    expect(wr?.data.cause).toBe("stall-timeout");
    // the nudge-expired conclusion precedes the worker-result harvest in the stream
    expect(evs.findIndex((e) => e.event === "worker-nudge-expired"))
      .toBeLessThan(evs.findIndex((e) => e.event === "worker-result" && e.taskId === "T1"));
    // a delivered nudge suppresses the idle page — the daemon acted instead of paging
    expect(notifies.some((m) => /looks idle without finishing/.test(m))).toBe(false);
  }, 120_000);

  test("an undeliverable nudge is journaled and falls back to today's page-plus-window behavior", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(0, 500);
    const notifies: string[] = [];
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED_SCRIPT);
    const driver = idriver({
      read: async () => "working-on-it",
      nudge: async () => false,
      notify: async (msg: string) => { notifies.push(msg); },
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-nudge-fail", driver });
    expect(s.human).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-nudge-fail").read();
    expect(evs.filter((e) => e.event === "worker-nudge-failed")).toHaveLength(1);
    expect(evs.some((e) => e.event === "worker-nudge-expired")).toBe(false); // no grace without a delivery
    expect(notifies.some((m) => /looks idle without finishing/.test(m))).toBe(true);
  }, 120_000);

  test("a non-allowlisted adapter is never nudged — the idle page behaves exactly as before", async () => {
    setNudgeTimingForTests(0, 500); // allowlist NOT extended: "fake" stays outside
    const nudges: string[] = [];
    const notifies: string[] = [];
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED_SCRIPT);
    const driver = idriver({
      read: async () => "working-on-it",
      nudge: async () => { nudges.push("x"); return true; },
      notify: async (msg: string) => { notifies.push(msg); },
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-nudge-unlisted", driver });
    expect(s.human).toEqual(["T1"]);
    expect(nudges).toEqual([]);
    expect(Journal.open(repo, "run-nudge-unlisted").read().some((e) => e.event === "worker-nudge")).toBe(false);
    expect(notifies.some((m) => /looks idle without finishing/.test(m))).toBe(true);
  }, 120_000);
});

describe("HerdrDriver.nudge pinning (OBS-201)", () => {
  test("a slot with no pinned delivered pane returns false without attempting delivery", async () => {
    const d = new HerdrDriver();
    await expect(d.nudge({ id: "w1:p1", name: "tickmarkr:worker:T1:0:run-x", cwd: "/tmp" }, "msg")).resolves.toBe(false);
  });
});

// OBS-202: channels are session factories, not consumed seats. A consult reroute with every
// channel merely TRIED (but live) recycles a fresh session instead of parking; the attempt cap
// is the real bound. Only an all-demoted fleet still parks reroute-exhausted (worker-result-cause
// pins that case).
describe("channel recycle — artificial scarcity never parks (OBS-202)", () => {
  test("reroute past a merely-tried fleet recycles fresh sessions; only EARNED demotion of every channel parks", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { timeoutMinutes: 0.05 })],
      {
        consult: { action: "reroute", notes: "try another seat" },
        tasks: { T1: [{ shell: "echo grinding" }] }, // no trailer: scripted stall every attempt
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-recycle", driver: idriver({ read: async () => "grinding" }) });
    expect(s.human).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-recycle").read();
    // both channels tried after 2 dispatches — the OLD behavior parked right there. The recycle
    // grants fresh sessions until each channel EARNS demotion (OBS-57: two consecutive no-trailer
    // windows) — evidence-based deadness, not artificial scarcity.
    expect(evs.filter((e) => e.event === "task-dispatch").length).toBe(4);
    expect(evs.filter((e) => e.event === "channel-recycle").length).toBeGreaterThanOrEqual(1);
    expect(evs.filter((e) => e.event === "channel-demotion").length).toBe(2);
    const park = evs.find((e) => e.event === "task-human" && e.taskId === "T1");
    expect(park?.data.kind).toBe("reroute-exhausted");
    expect(String(park?.data.reason)).toMatch(/demoted/); // the honest reason: dead, not "exhausted"
    // demotions precede the park — scarcity was EARNED, never assumed
    const parkIdx = evs.findIndex((e) => e.event === "task-human" && e.taskId === "T1");
    expect(evs.filter((e, i) => e.event === "channel-demotion" && i < parkIdx).length).toBe(2);
  }, 180_000);
});
