// T7: journal + telemetry identical with vs without the attention-only notify sink
import { describe, expect, test, vi } from "vitest";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal, type JournalEvent, type TelemetryRow } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const VERDICT = "fake-judge-verdict-marker-39";

const cleanScript = {
  tasks: {
    T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
  },
};

const failScript = {
  judge: { pass: false, criteria: [{ criterion: "c1", met: false, reason: VERDICT }] },
  review: { approve: true, issues: [] },
  tasks: {
    T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
  },
};

function swapExact<T>(obj: T, from: string, to: string): T {
  if (from === to) return obj;
  if (typeof obj === "string") return (obj === from ? to : obj) as T;
  if (Array.isArray(obj)) return obj.map((x) => swapExact(x, from, to)) as T;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = swapExact(v, from, to);
    return out as T;
  }
  return obj;
}

function normJournal(events: JournalEvent[], runId: string, baseRef: string, taskId = "T1") {
  return events.map((e, i) => {
    let row = { ...e, ts: String(i) };
    row = swapExact(row, runId, "<RUNID>");
    row = swapExact(row, `tickmarkr/${runId}`, "tickmarkr/<RUNID>");
    row = swapExact(row, `tickmarkr/${runId}--${taskId}`, "tickmarkr/<RUNID>--T1");
    row = swapExact(row, baseRef, "<BASEREF>");
    if (row.event === "merge" && typeof row.data.commit === "string") {
      row = { ...row, data: { ...row.data, commit: "<COMMIT>" } };
    }
    if (row.event === "worktree-recreation") {
      const d = row.data as { attempted?: string[]; carried?: string[] };
      row = {
        ...row,
        data: {
          attempted: (d.attempted ?? []).map(() => "<HASH>"),
          carried: (d.carried ?? []).map(() => "<HASH>"),
        },
      };
    }
    return row;
  });
}

// durationMs is the ONE field the oracle cannot pin — notifications could in principle make a run slower;
// they cannot change what it does (daemon control flow, gate ordering, merge behavior).
function normTelemetry(rows: TelemetryRow[]) {
  return rows.map((r) => {
    expect(typeof r.durationMs).toBe("number");
    return { ...r, durationMs: "<DUR>" as unknown as number };
  });
}

function driverWithNotify(sink: string[]): ExecutorDriver {
  const inner = new SubprocessDriver();
  const orig = inner.notify.bind(inner);
  inner.notify = async (msg, opts) => {
    sink.push(msg);
    if (opts?.tier === "attention" || opts?.sound) sink.push("sound:request");
    return orig(msg, opts);
  };
  return inner;
}

function noopDriver(): ExecutorDriver {
  const inner = new SubprocessDriver();
  inner.notify = async () => {};
  return inner;
}

async function identityPair(script: object, runTag: string) {
  const { repo: repoA, fake: fakeA } = setupRepo([T("T1")], script);
  const { repo: repoB, fake: fakeB } = setupRepo([T("T1")], script);
  const runIdA = `run-id-a-${runTag}`;
  const runIdB = `run-id-b-${runTag}`;
  const captured: string[] = [];
  await runDaemon(repoA, { adapters: [fakeA], runId: runIdA, driver: driverWithNotify(captured) });
  await runDaemon(repoB, { adapters: [fakeB], runId: runIdB, driver: noopDriver() });
  const baseA = (await gitHead(repoA)) as string;
  const baseB = (await gitHead(repoB)) as string;
  const jA = normJournal(Journal.open(repoA, runIdA).read(), runIdA, baseA);
  const jB = normJournal(Journal.open(repoB, runIdB).read(), runIdB, baseB);
  const tA = normTelemetry(Journal.open(repoA, runIdA).readTelemetry());
  const tB = normTelemetry(Journal.open(repoB, runIdB).readTelemetry());
  expect(jA).toEqual(jB);
  expect(tA).toEqual(tB);
  return captured;
}

describe("VIS-08 notify-identity oracle (D-07)", () => {
  test("clean run: journal + telemetry stay identical and only run-end notifies", async () => {
    const captured = await identityPair(cleanScript, "clean");
    const messages = captured.filter((m) => !m.startsWith("sound:"));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("integration branch");
    expect(captured).toEqual([messages[0]]);
  });

  test("gate-failing run: journal + telemetry stay identical and every attention event pings once", async () => {
    const captured = await identityPair(failScript, "fail");
    const messages = captured.filter((m) => !m.startsWith("sound:"));
    expect(messages.filter((m) => /escalation:/.test(m))).toHaveLength(3);
    expect(messages.filter((m) => /: T1 consult verdict:/.test(m))).toHaveLength(1);
    expect(messages.filter((m) => /needs a human/.test(m))).toHaveLength(1);
    expect(messages.filter((m) => /integration branch/.test(m))).toHaveLength(1);
    expect(captured.filter((m) => m === "sound:request")).toHaveLength(messages.length - 1);
  });
});

describe("T7 notification tiers", () => {
  test("the notify ternary resolves to two distinct tiers", async () => {
    const calls: Array<{ message: string; tier?: string }> = [];
    const driver = new SubprocessDriver();
    driver.notify = async (message, opts) => { calls.push({ message, tier: opts?.tier }); };
    const { repo, fake } = setupRepo([T("T1")], cleanScript);

    await runDaemon(repo, { adapters: [fake], runId: "run-routine-tier", driver });

    expect(calls.find((call) => call.message.includes("integration branch"))?.tier).toBe("routine");
  });

  test("human gates and quota failovers each notify once with attention", async () => {
    const captured: string[] = [];
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true }), T("T2")],
      { tasks: { T2: [
        { shell: "echo 'usage limit reached for this model'; exit 1" },
        { shell: `echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } },
      ] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-tiers", driver: driverWithNotify(captured) });
    const messages = captured.filter((m) => !m.startsWith("sound:"));
    expect(messages.filter((m) => /T1 needs a human/.test(m))).toHaveLength(1);
    expect(messages.filter((m) => /T2 quota failover/.test(m))).toHaveLength(1);
    expect(messages.filter((m) => /integration branch/.test(m))).toHaveLength(1);
    expect(captured.filter((m) => m === "sound:request")).toHaveLength(messages.length - 1);
  });

  test("subprocess fallback logs attention and suppresses routine tiers", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const driver = new SubprocessDriver();
      await driver.notify("routine", { tier: "routine" });
      await driver.notify("attention", { tier: "attention" });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("[tickmarkr] attention");
    } finally {
      log.mockRestore();
    }
  });
});
