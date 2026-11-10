// Queue row 398 (d) and (e), D-2187 add.24 (PORT-RULES R13 (d), (e)): readRunBoard, the production seam, over run folders
// this test writes. The base is the unchanged summarize over the same journal and graph: the reader's snapshot before
// the exclusions list and the uncut failure note existed.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { BillingChannel } from "../../src/adapters/types.js";
import { readRunBoard } from "../../src/board/read.js";
import { summarize, type TaskRow } from "../../src/board/summarize.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import { route } from "../../src/route/router.js";
import { parseBoard } from "../../hooks/board/model.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

const RUN = "run-20261108-125547-0000000000002405";
const T0 = Date.parse("2026-11-08T12:55:47Z") / 1000;
const NOW = T0 + 70 * 60;
const at = (min: number): string => new Date((T0 + min * 60) * 1000).toISOString();
type Ev = { ts: string; event: string; taskId?: string; data: Record<string, unknown> };
const ev = (min: number, event: string, taskId?: string, data: Record<string, unknown> = {}): Ev =>
  ({ ts: at(min), event, ...(taskId ? { taskId } : {}), data });
type Exclusion = { channel: string; cause: string; line: number };
type Board = { tasks: TaskRow[]; needsYou: Array<{ task: string; kind: string; reason: string }>; exclusions?: Exclusion[] };

function put(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  utimesSync(path, NOW, NOW);
}
const jsonl = (events: readonly object[]): string => events.map((e) => JSON.stringify(e) + "\n").join("");

/** A live run (no run-end) of tasks T1..Tn with no dependencies, read at NOW, beside the base summarize. `line(i)` is
 *  the journal line of `events[i]` (the run-start row is line 1). */
function read(n: number, events: readonly Ev[]): { board: Board; base: TaskRow[]; raw: string } {
  const tmp = makeTestTempDir("tkr-run-notes-");
  mkdirSync(join(tmp, ".git")); // its own repository, so the walk never reaches an enclosing checkout
  const journal = [ev(0, "run-start", undefined, { runId: RUN }), ...events];
  const graph = { tasks: Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}`, title: `task T${i + 1}`, deps: [] })) };
  put(join(tmp, ".tickmarkr", "runs", RUN, "journal.jsonl"), jsonl(journal));
  put(join(tmp, ".tickmarkr", "runs", RUN, "graph.json"), JSON.stringify(graph));
  const board = readRunBoard(tmp, [], [], NOW);
  const base = summarize(journal.map((e, i) => ({ ...e, _line: i + 1 })), graph, null, false, NOW).tasks;
  return { board: board as unknown as Board, base, raw: JSON.stringify(board) };
}
const line = (i: number): number => i + 2;
const parsed = (raw: string) => parseBoard({ exitCode: 0, stdout: raw });
const MISSHAPEN = "tickmarkr board printed a misshapen snapshot";

// …2405 line 75, verbatim: the run-wide no-trailer demotion of the pool's only frontier member.
const DEMOTION_2405 = ev(34, "channel-demotion", "T4", { channel: "claude-code:claude-opus-5-5", streak: 2 });
// …2405 lines 101–104, verbatim: the router's floor-pool refusal as the daemon journaled it.
const POOL_ERROR_2405 = (id: string): string => `RoutingError: ${id}: routing.map.implement.pool has no live channel at task floor frontier`
  + " — declared: claude-code:claude-opus-5-5, codex:gpt-6-sol, grok:grok-4.7, kimi:kimi-code/k3, omp:zai/glm-5.3, omp:xai-oauth/grok-4.7, omp:kimi-code/k3"
  + "; doctor found: codex:gpt-6-astra, codex:gpt-6-sol, codex:gpt-5.6-terra, codex:gpt-6.1-sol, grok:grok-4.7, omp:google/gemini-3.8-flash, omp:xai-oauth/grok-4.7";
const SUMMARY_2405 = "pool implement has no live channel at floor frontier: 1 excluded run-wide (claude-code:claude-opus-5-5), 3 below floor, 3 not found";
const failing = (min: number, id: string, data: Record<string, unknown>): Ev[] =>
  [ev(min, "task-dispatch", id, { attempt: 0 }), ev(min + 1, "task-failed", id, data)];

test("a channel demotion or exclusion not readmitted adds one exclusion entry with its cause and journal line", () => {
  // …2405's demotion: one entry naming the channel, its streak and its journal line
  const demoted = read(1, [ev(1, "task-dispatch", "T1", { attempt: 0 }), DEMOTION_2405]);
  expect(demoted.board.exclusions).toStrictEqual([{ channel: "claude-code:claude-opus-5-5", cause: "no-trailer streak 2", line: line(1) }]);

  // every excluding row kind, folded in journal order with readmit (Journal.replayExcludedChannels): a readmitted
  // channel is not listed, a channel excluded again after its readmit is listed at that later row, a dead channel's
  // exclusion and failover rows make one entry at the failover's line, and a row naming no channel excludes nothing
  const events = [
    ev(1, "channel-demotion", "T1", { channel: "a:readmitted", streak: 3 }),
    ev(2, "channel-exclusion", "T1", { channel: "b:again", reason: "auth expired" }),
    ev(3, "channel-readmit", undefined, { channel: "a:readmitted" }),
    ev(4, "channel-readmit", undefined, { channel: "b:again" }),
    ev(5, "channel-demotion", "T1", { channel: "b:again", streak: 4 }),
    ev(6, "channel-exclusion", "T1", { channel: "c:dead", reason: "quota exhausted", kind: "dead-channel" }),
    ev(6, "dead-channel-failover", "T1", { reason: "quota exhausted", from: "c:dead", to: "d:next" }),
    ev(7, "channel-demotion", "T1", {}), // the board fixtures' shrunk rows carry no channel
    ev(8, "dead-channel-failover", "T1", { reason: "session lost", from: "e:legacy", to: null }), // pre-v1.71 compat row
  ];
  const fold = read(1, events);
  expect(fold.board.exclusions).toStrictEqual([
    { channel: "b:again", cause: "no-trailer streak 4", line: line(4) },
    { channel: "c:dead", cause: "quota exhausted", line: line(6) },
    { channel: "e:legacy", cause: "session lost", line: line(8) },
  ]);
  // every other field is the base's: no task row changes for an exclusion alone
  expect(fold.board.tasks).toStrictEqual(fold.base);

  // the plugin's shape check accepts the field and rejects an entry outside the wire contract
  expect(parsed(fold.raw).snapshot?.exclusions).toStrictEqual(fold.board.exclusions);
  for (const bad of [{ channel: "x:y", cause: "c", line: "7" }, { channel: "x:y", line: 7 }, "x:y"]) {
    expect(parsed(JSON.stringify({ ...JSON.parse(fold.raw), exclusions: [bad] })).error, JSON.stringify(bad)).toBe(MISSHAPEN);
  }
  expect(parsed(JSON.stringify({ ...JSON.parse(fold.raw), exclusions: null })).error).toBe(MISSHAPEN);
});

test("a run with no exclusion has no exclusion entry", () => {
  // no excluding row at all, a row with no channel, and an exclusion its readmit lifted: no field, so the snapshot
  // reads exactly as at the base, and the plugin's check accepts the absent field
  for (const events of [
    [ev(1, "task-dispatch", "T1", { attempt: 0 }), ev(5, "worker-result", "T1")],
    [ev(1, "task-dispatch", "T1", { attempt: 0 }), ev(7, "channel-demotion", "T1", {})],
    [ev(1, "task-dispatch", "T1", { attempt: 0 }), DEMOTION_2405, ev(40, "channel-readmit", undefined, { channel: "claude-code:claude-opus-5-5" })],
  ]) {
    const { board, base, raw } = read(1, events);
    expect(Object.hasOwn(board, "exclusions"), events.at(-1)?.event).toBe(false);
    expect(board.tasks, events.at(-1)?.event).toStrictEqual(base);
    expect(parsed(raw).snapshot?.exclusions, events.at(-1)?.event).toBeUndefined();
  }
});

test("a floor pool refusal note counts its declared channels as excluded below floor and not found", () => {
  // …2405's shape: the demotion, then four tasks failing on the router's floor-pool refusal
  const ids = ["T1", "T2", "T3", "T4"];
  const run = read(4, [ev(1, "task-dispatch", "T4", { attempt: 0 }), DEMOTION_2405,
    ...ids.flatMap((id, k) => failing(60 + k, id, { error: POOL_ERROR_2405(id), kind: "infra", attempts: 0 }))]);
  for (const [i, t] of run.board.tasks.entries()) {
    expect([t.state, t.note, t.now], t.id).toEqual(["failed", SUMMARY_2405, `failed — ${SUMMARY_2405}`]);
    // the control: the base cut the error at 90 code points, mid-reason
    expect(run.base[i].note, t.id).toBe([...POOL_ERROR_2405(t.id)].slice(0, 90).join(""));
    expect({ ...t, note: 0, now: 0 }, t.id).toStrictEqual({ ...run.base[i], note: 0, now: 0 });
  }
  expect(run.board.needsYou.map((n) => [n.task, n.kind, n.reason])).toEqual(ids.map((id) => [id, "failed", SUMMARY_2405]));

  // the same refusal with the demotion readmitted: no exclusions entry names the channel, and doctor did not find
  // it, so it counts as not found; a counter at zero is omitted
  const readmitted = read(1, [DEMOTION_2405, ev(40, "channel-readmit", undefined, { channel: "claude-code:claude-opus-5-5" }),
    ...failing(60, "T1", { error: POOL_ERROR_2405("T1") })]);
  expect(readmitted.board.tasks[0].note).toBe("pool implement has no live channel at floor frontier: 3 below floor, 4 not found");

  // the router's own refusal, as the daemon journals it (String(err)): a frontier pool member excluded in the run, a
  // mid member doctor found, a member doctor never found, and a skipped clause, which carries no counter of its own
  const channels: BillingChannel[] = [
    { adapter: "codex", vendor: "openai", model: "gpt-front", channel: "api", tier: "frontier" },
    { adapter: "claude-code", vendor: "anthropic", model: "sonnet", channel: "sub", tier: "mid" },
  ];
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.routing.map.implement = { pool: { mode: "ordered", channels: ["codex:gpt-front", "claude-code:sonnet", "kimi:k3"] } };
  const task = validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 5, routingHints: { floor: "frontier" }, acceptance: ["a"] }] }).tasks[0];
  let refusal = "";
  try {
    route(task, cfg, channels, undefined, undefined, new Set(["codex:gpt-front"]));
  } catch (err) {
    refusal = String(err);
  }
  expect(refusal).toMatch(/^RoutingError: T1: routing\.map\.implement\.pool has no live channel at task floor frontier — declared: /);
  const exclude = ev(30, "channel-exclusion", "T1", { channel: "codex:gpt-front", reason: "auth expired" });
  const live = read(1, [exclude, ...failing(60, "T1", { error: refusal })]);
  expect(live.board.tasks[0].note)
    .toBe("pool implement has no live channel at floor frontier: 1 excluded run-wide (codex:gpt-front), 1 below floor, 1 not found");
  const skipped = refusal.replace("; doctor found:", "; skipped kimi:k3 (disallowed by routing.deny (kimi:k3)); doctor found:");
  expect(read(1, [exclude, ...failing(60, "T1", { error: skipped })]).board.tasks[0].note).toBe(live.board.tasks[0].note);
});

test("a long failure reason in no special form is kept whole by the reader", () => {
  const long = "Error: the worker's session ended before it wrote a result trailer; " + "the transcript tail read: ".repeat(12)
    + "exit 137 after the inactivity window — no commit, no diff, nothing to gate.";
  const multiline = 'OrcaError: orca status failed — orca CLI exited 1 after timeout; raw response:\n{\n  "id": "local-status",\n'
    + '  "ok": true,\n  "result": { "target": { "kind": "local" }, "app": { "running": true, "pid": 50721 } }\n}';
  // the router's other refusals and a cut floor-pool text are not the floor-pool form, so they are kept whole too
  const exhausted = "RoutingError: T1: routing.map.implement.pool is exhausted — no admitted entry remains: a:b (disallowed by"
    + " routing.deny (a:b)) — remove the deny/allow entry or add an admitted channel to the pool";
  const cutPool = "RoutingError: T1: routing.map.implement.pool has no live channel at task floor frontier — declared: a:b, c:d";
  expect(long.length).toBeGreaterThan(300);
  for (const [data, whole] of [[{ error: long }, long], [{ reason: long }, long], [{ error: multiline }, multiline],
    [{ error: exhausted }, exhausted], [{ error: cutPool }, cutPool]] as const) {
    const { board, base } = read(1, [DEMOTION_2405, ...failing(60, "T1", data)]);
    expect([board.tasks[0].note, board.tasks[0].now], whole.slice(0, 30)).toEqual([whole, `failed — ${whole}`]);
    expect(board.needsYou.map((n) => n.reason), whole.slice(0, 30)).toEqual([whole]);
    // the control: the base cut the reason at 90 code points
    expect([base[0].note, base[0].now], whole.slice(0, 30)).toEqual([[...whole].slice(0, 90).join(""), `failed — ${[...whole].slice(0, 90).join("")}`]);
  }
  // a short reason reads exactly as at the base, and a parked task's note is not a failure reason: the base's
  const short = read(2, [...failing(60, "T1", { error: "worker crashed" }), ev(61, "task-dispatch", "T2", { attempt: 0 }),
    ev(62, "task-human", "T2", { kind: "human", reason: long })]);
  expect(short.board.tasks).toStrictEqual(short.base);
});
