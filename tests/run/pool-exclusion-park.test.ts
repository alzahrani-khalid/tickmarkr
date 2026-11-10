// Queue row 397 (D-2187 add.23): an in-run exclusion that empties a task's floor pool parks the task
// pool-excluded with its readmit verb, and a resume can readmit the channel. Every cell runs through runDaemon
// with the scripted fake adapter: T1 burns two no-trailer windows on fake:fake-1 (a real run-wide demotion),
// then T2 routes through its routing.map pool. Resumes run over the journal that run wrote. Zero tokens.
import { describe, expect, test } from "vitest";
import { GLYPHS } from "../../src/brand.js";
import { status } from "../../src/cli/commands/status.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const STALL = { shell: "echo stall; exit 0" }; // no trailer, no commit: a window that counts at once
const finish = (id: string) => ({ shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } });
const RETRY = { action: "retry", notes: "a no-trailer window is not a verdict" };
const poolCfg = (channels: string[]) =>
  `routing:\n  map:\n    implement:\n      pool: { mode: ordered, channels: [${channels.join(", ")}] }\n`;

type Row = JournalEvent & { line: number };
const sourced = (repo: string, runId: string): Row[] => {
  const { events, lines } = Journal.open(repo, runId).readSourced();
  return events.map((e, i) => ({ ...e, line: lines[i]! }));
};
const key = (a: unknown) => `${(a as { adapter: string }).adapter}:${(a as { model: string }).model}`;
const of = (rows: Row[], event: string, taskId?: string) => rows.filter((e) => e.event === event && (taskId === undefined || e.taskId === taskId));
const trace = (rows: Row[]) => rows.map((e) => `${e.line}:${e.event}${e.taskId ? `[${e.taskId}]` : ""}${e.event === "task-dispatch" ? `:${key(e.data.assignment)}`
  : e.event === "task-human" || e.event === "task-failed" ? `(${String(e.data.reason ?? e.data.error)})` : ""}`).join("\n");
const strip = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "");

const withTty = async <V>(fn: () => Promise<V>): Promise<V> => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  delete process.env.NO_COLOR;
  try {
    return await fn();
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

/** T1 demotes fake:fake-1 run-wide; T2 (frontier floor) then routes through the implement pool `pool`. */
const runCell = async (runId: string, pool: string[]) => {
  const made = setupRepo([
    T("T1", { shape: "docs" }),
    T("T2", { deps: ["T1"], routingHints: { floor: "frontier" } }),
  ], { consult: RETRY, tasks: { T1: [STALL, STALL, finish("a")], T2: [finish("b")] } }, poolCfg(pool));
  const summary = await runDaemon(made.repo, { adapters: [made.fake], runId });
  const rows = sourced(made.repo, runId);
  // the demotion is real, run-wide, and lands before T2 is routed
  const demotions = of(rows, "channel-demotion");
  expect(demotions.map((e) => e.data), trace(rows)).toEqual([{ channel: "fake:fake-1", streak: 2 }]);
  return { ...made, runId, summary, rows, demotion: demotions[0]! };
};

const memo = <V>(make: () => Promise<V>) => { let p: Promise<V> | undefined; return () => (p ??= make()); };
// …2405's shape: the pool's only frontier member demoted run-wide. Status is read right after the park,
// before any test resumes this run.
const parkedRun = memo(async () => {
  const cell = await runCell("run-397-park", ["fake:fake-1"]);
  const tty = await withTty(() => status([], cell.repo));
  return { ...cell, tty };
});

describe("row 397: an exclusion that empties a task's floor pool parks it with its readmit verb", { timeout: 300_000 }, () => {
  test("an in-run exclusion that empties a task's floor pool parks it naming the channel its exclusion row and both verbs", async () => {
    const { rows, runId, summary, demotion } = await parkedRun();
    const t = trace(rows);
    expect(summary.human, t).toEqual(["T2"]);
    expect(summary.failed, t).toEqual([]);
    expect(of(rows, "task-failed"), t).toEqual([]);
    expect(of(rows, "task-dispatch", "T2"), t).toEqual([]);
    const parks = of(rows, "task-human", "T2");
    expect(parks, t).toHaveLength(1);
    const park = parks[0]!;
    expect(park.line, t).toBeGreaterThan(demotion.line);
    expect(park.data.kind).toBe("infra");
    expect(park.data.disposition).toBe("pool-excluded");
    expect(park.data.channels).toEqual(["fake:fake-1"]);
    expect(park.data.exclusions).toEqual([
      { channel: "fake:fake-1", event: "channel-demotion", line: demotion.line, cause: "no-trailer streak 2" },
    ]);
    const reason = String(park.data.reason);
    // the router's own refusal, the channel with its exclusion row, and both operator verbs
    expect(reason).toContain("T2: routing.map.implement.pool has no live channel at task floor frontier — declared: fake:fake-1");
    expect(reason).toContain(`fake:fake-1 (channel-demotion at journal line ${demotion.line}: no-trailer streak 2)`);
    expect(reason).toContain(`\`tickmarkr resume ${runId} --readmit fake:fake-1\``);
    expect(reason).toContain(`change the routing.map pool and then \`tickmarkr resume ${runId}\``);
  });

  test("status shows the pool excluded park at the recoverable infra severity and never as a terminal failure", async () => {
    const { rows, tty } = await parkedRun();
    // the run has ended: at the base every task still parked in an ended run renders red
    expect(of(rows, "run-end"), trace(rows)).toHaveLength(1);
    const lines = tty.split("\n");
    const t2 = lines.filter((line) => /\bT2\b/u.test(strip(line)));
    expect(t2.length, tty).toBeGreaterThan(0);
    const card = strip(t2.join("\n"));
    expect(card, tty).toContain(`${GLYPHS.attention} parked (infra)`);
    // the red and warn tiers share one colour and are told apart by their words (the base: `✗ failed`)
    expect(card, tty).not.toContain(GLYPHS.fail);
    expect(card, tty).not.toMatch(/\bfailed\b/u);
  });

  test("resume with readmit writes the readmit row before the replay and the parked task dispatches on the readmitted channel", async () => {
    const { repo, fake, runId } = await parkedRun();
    // Control: a plain resume still replays the exclusion and the task parks again, never fails.
    const plain = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    let rows = sourced(repo, runId);
    let t = trace(rows);
    const plainResume = of(rows, "run-resume");
    expect(plainResume, t).toHaveLength(1);
    expect(plainResume[0]!.data.excludedChannels, t).toEqual(["fake:fake-1"]);
    expect(plain.human, t).toEqual(["T2"]);
    expect(of(rows, "task-failed"), t).toEqual([]);
    expect(of(rows, "task-dispatch", "T2"), t).toEqual([]);
    const reparked = of(rows, "task-human", "T2");
    expect(reparked.map((e) => e.data.disposition), t).toEqual(["pool-excluded", "pool-excluded"]);
    expect(reparked[1]!.line, t).toBeGreaterThan(plainResume[0]!.line);

    // The readmit: one channel-readmit row before the replay, the channel routable again, the task dispatched.
    const readmitted = await runDaemon(repo, { adapters: [fake], runId, resume: true, readmit: ["fake:fake-1"] });
    rows = sourced(repo, runId);
    t = trace(rows);
    const readmits = of(rows, "channel-readmit");
    expect(readmits.map((e) => e.data), t).toEqual([{ channel: "fake:fake-1" }]);
    const resumes = of(rows, "run-resume");
    expect(resumes, t).toHaveLength(2);
    const resumeRow = resumes[1]!;
    expect(readmits[0]!.line, t).toBeGreaterThan(reparked[1]!.line);
    expect(readmits[0]!.line, t).toBeLessThan(resumeRow.line);
    expect(resumeRow.data.excludedChannels, t).toBeUndefined(); // the replay read the readmit
    const dispatches = of(rows, "task-dispatch", "T2");
    expect(dispatches.map((e) => key(e.data.assignment)), t).toEqual(["fake:fake-1"]);
    expect(dispatches[0]!.line, t).toBeGreaterThan(resumeRow.line);
    expect(readmitted.done, t).toContain("T2");
    expect(of(rows, "task-failed"), t).toEqual([]);
    // the journal's own replay agrees: the readmit lifted the only exclusion
    expect([...Journal.open(repo, runId).replayExcludedChannels()]).toEqual([]);
  });

  test("a pool with another live channel at the floor routes exactly as at the base", async () => {
    const { rows, summary } = await runCell("run-397-two", ["fake:fake-1", "fake:fake-2"]);
    const t = trace(rows);
    expect(of(rows, "task-dispatch", "T2").map((e) => key(e.data.assignment)), t).toEqual(["fake:fake-2"]);
    expect(summary.done, t).toEqual(["T1", "T2"]);
    expect(of(rows, "task-human"), t).toEqual([]);
    expect(of(rows, "task-failed"), t).toEqual([]);
    expect(rows.some((e) => e.data.disposition === "pool-excluded"), t).toBe(false);
  });

  test("a floor pool that is empty without any in-run exclusion still fails the task as at the base", async () => {
    // The demotion is in force, but the pool's only member was never discovered: the same route call
    // without the exclusion set refuses too, so the base failure stands.
    const { rows, summary } = await runCell("run-397-empty", ["fake:fake-9"]);
    const t = trace(rows);
    expect(summary.failed, t).toEqual(["T2"]);
    expect(of(rows, "task-human", "T2"), t).toEqual([]);
    const failed = of(rows, "task-failed", "T2");
    expect(failed, t).toHaveLength(1);
    expect(failed[0]!.data.kind).toBe("infra");
    expect(String(failed[0]!.data.error)).toContain("RoutingError: T2: routing.map.implement.pool has no live channel at task floor frontier — declared: fake:fake-9");
  });
});
