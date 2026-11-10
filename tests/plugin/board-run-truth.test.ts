// Queue row 398 (D-2187 add.24), PORT-RULES B1: the pane rows of a run that cannot finish, drawn through the
// production seam (parseBoard → view → the shipped Board) from fixed snapshots under a fixed clock. Each table is a
// closed list of the contract's pane cells and their controls.
import { createElement, isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Board, { INK } from "../../hooks/board/board.js";
import { parseBoard, view } from "../../hooks/board/model.js";
import type { NeedsYou, RunSnapshot, TaskRow } from "../../hooks/board/state.js";

const AT = 1_794_147_165; // 2026-11-08T14:12:45Z, the operator's read of run …2405
const RUN = "run-20261108-125547-0000000000002405";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(AT * 1000); });
afterEach(() => { vi.useRealTimers(); });

type Line = { text: string; color: unknown; wrap: unknown; card: string | null };
type Props = { children?: ReactNode; color?: unknown; wrap?: unknown };
const elements = {
  Box: (props: Props) => createElement("Box", props),
  Text: (props: Props) => createElement("Text", props),
  Button: (props: Props) => createElement("Button", props),
};

/** Every Text the pane draws for `snap` at `columns`, with its colour, wrap mode and the card it sits in. */
function draw(snap: RunSnapshot, columns = 160): Line[] {
  const state = parseBoard({ exitCode: 0, stdout: JSON.stringify(snap), stderr: "" });
  expect(state.error).toBeNull();
  const shown = view(state);
  if (!("props" in shown)) throw new Error("expected the board view");
  const surface = {
    elements, state: undefined as unknown, columns, rows: 80,
    setState(next: unknown) { surface.state = next; }, every: () => () => {}, post: () => {},
  };
  const lines: Line[] = [];
  const textOf = (node: ReactNode): string => {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    return isValidElement<Props>(node) ? textOf(node.props.children) : "";
  };
  const walk = (node: ReactNode, card: string | null): void => {
    if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, card)); return; }
    if (!isValidElement<Props>(node)) throw new Error("unexpected board node");
    // a card is the Box keyed `card-<id>`; the key sits on the element before its function component is evaluated
    const own = typeof node.key === "string" && /^card-T\d+$/.test(node.key) ? node.key.slice("card-".length) : card;
    if (typeof node.type === "function") { walk((node.type as (props: Props) => ReactNode)(node.props), own); return; }
    if (node.type === "Text") lines.push({ text: textOf(node.props.children), color: node.props.color, wrap: node.props.wrap, card: own });
    walk(node.props.children, own);
  };
  walk(Board(shown.props as never, surface as never) as ReactNode, null);
  return lines;
}
const texts = (lines: Line[]): string[] => lines.map(line => line.text);
const inCard = (lines: Line[], id: string): Line[] => lines.filter(line => line.card === id);

const row = (id: string, patch: Partial<TaskRow>): TaskRow => ({
  id, title: `task ${id}`, state: "pending", attempt: 0, dispatched: false, budget: 3, launches: 0, gates: {}, note: "",
  deps: [], blocks: [], worker: "", judge: "", reviewer: "", suiteWaiting: false, now: "", nowSince: null, history: [],
  startEpoch: null, endEpoch: null, startedAt: "", endedAt: "", tokens: null, ...patch,
});
/** A failed task as the row 398 reader sends it: the full note, its now-sentence `failed — <note>`. */
const failed = (id: string, note: string, patch: Partial<TaskRow> = {}): TaskRow =>
  row(id, { state: "failed", note, now: `failed — ${note}`, ...patch });
const blocked = (id: string, deps: string[], root: string, kind: "failed" | "parked"): TaskRow =>
  row(id, { state: "blocked", deps, now: `blocked by ${root} (${kind})` });
const running = (id: string): TaskRow =>
  row(id, { state: "worker", dispatched: true, launches: 1, worker: "codex:gpt-6-sol", now: "worker a1 {since} on codex:gpt-6-sol",
    nowSince: AT - 90, startEpoch: AT - 90, startedAt: "2026-11-08 14:11:15" });
const failure = (t: TaskRow): NeedsYou =>
  ({ task: t.id, kind: "failed", reason: t.note, since: AT - 600, blocks: t.blocks, cmd: `tickmarkr resume ${RUN} --retry-failed` });
const live = (tasks: TaskRow[], patch: Partial<RunSnapshot> = {}): RunSnapshot => ({
  version: 1, runId: RUN, spec: "v2.24.0-picks-tell-the-truth", alive: true, pid: 4242, elapsedMin: 77, ended: null, tasks,
  needsYou: tasks.filter(t => t.state === "failed").map(failure), approvalWindow: null, eta: null,
  atEpoch: AT, startEpoch: AT - 77 * 60, endEpoch: null, readAt: "14:12:45", release: null, ...patch,
});

// …2405 lines 101–104 as the reader summarizes them (R13 (e)), and its line 75 demotion (R13 (d)).
const SUMMARY_2405 = "pool implement has no live channel at floor frontier: 1 excluded run-wide (claude-code:claude-opus-5-5), 3 below floor, 3 not found";
const DEMOTION_2405 = { channel: "claude-code:claude-opus-5-5", cause: "no-trailer streak 2", line: 75 };
/** A reason of several hundred characters in no special form. */
const LONG = Array.from({ length: 9 }, (_, i) => `repair ${i + 1} left the verifier red on src/run/daemon.ts with the same unhandled rejection`).join("; ");
const WIDTHS = [160, 90, 60];

const ROOTS = ["T2", "T8", "T12", "T20"];
const reachableTasks = [row("T1", { state: "done", now: "merged 13:40 · 1 attempt(s)" }), running("T4"), row("T17", { deps: ["T4"], now: "waits on T4" })];
const stoppedTasks = [...reachableTasks, ...ROOTS.map(id => failed(id, SUMMARY_2405)), blocked("T3", ["T2"], "T2", "failed")];

test("a cannot finish snapshot draws cannot finish with its stopped roots instead of a time", () => {
  const PATH = ["T4", "T17", "T18", "T19"];
  // the …2405 shape: four failed roots, the reader's cannot-finish ETA (no minutes, kept as numbers for the wire)
  const stopped = live(stoppedTasks, { eta: { cleanMin: 0, oneRepairMin: 0, criticalPath: PATH, stoppedBy: ROOTS, cannotFinish: true } });
  for (const columns of WIDTHS) {
    const lines = draw(stopped, columns);
    expect(lines.filter(line => line.text === "cannot finish · stopped by T2, T8, T12, T20"), `${columns}`)
      .toEqual([expect.objectContaining({ color: INK.fail, card: null })]);
    expect(texts(lines).filter(text => /\bETA\b|clock stopped on|cannot finish/.test(text)), `${columns}`)
      .toEqual(["cannot finish · stopped by T2, T8, T12, T20"]);
  }

  // controls: every ETA a run that can finish sends reads as at the base, with no cannot-finish line
  const controls: [label: string, eta: RunSnapshot["eta"], drawn: string | null][] = [
    ["a reachable run", { cleanMin: 49, oneRepairMin: 94, criticalPath: PATH, stoppedBy: [] }, "ETA 49m – 1h 34m"],
    ["cannotFinish false", { cleanMin: 49, oneRepairMin: 94, criticalPath: PATH, stoppedBy: [], cannotFinish: false }, "ETA 49m – 1h 34m"],
    ["an older CLI's parked stop, no cannotFinish key", { cleanMin: 12, oneRepairMin: 30, criticalPath: ["T4"], stoppedBy: ["T6"] }, "ETA 12m – 30m · clock stopped on T6"],
    ["no ETA", null, null],
  ];
  for (const [label, eta, drawn] of controls) {
    const lines = draw(live(reachableTasks, { eta }));
    expect(texts(lines).filter(text => /\bETA\b|clock stopped on|cannot finish/.test(text)), label).toEqual(drawn ? [drawn] : []);
    if (drawn) expect(lines.find(line => line.text === drawn)?.color, label).toBe("subtle");
  }
});

test("a blocked task draws its blocked sentence", () => {
  const parked = row("T5", {
    state: "parked", dispatched: true, launches: 1, note: "review round cap · review ✖ src/x.ts null deref",
    now: "parked {since} · gate-fail · blocks T6", nowSince: AT - 60, startEpoch: AT - 900, startedAt: "2026-11-08 13:57:45",
  });
  const snap = live([
    failed("T2", "worker exited 1"), blocked("T3", ["T2"], "T2", "failed"),
    parked, blocked("T6", ["T5"], "T5", "parked"),
    running("T4"), row("T17", { deps: ["T4"], now: "waits on T4" }),
  ], { needsYou: [failure(failed("T2", "worker exited 1"))] });
  for (const columns of WIDTHS) {
    const lines = draw(snap, columns);
    // each blocked card: its sentence, the BLOCKED word, and no word of a task that waits, queues or runs
    for (const [id, sentence] of [["T3", "blocked by T2 (failed)"], ["T6", "blocked by T5 (parked)"]] as const) {
      const card = inCard(lines, id);
      expect(card.filter(line => line.text === sentence), `${columns} ${id}`).toEqual([expect.objectContaining({ color: "subtle", wrap: "wrap" })]);
      expect(card.filter(line => line.text === "BLOCKED"), `${columns} ${id}`).toEqual([expect.objectContaining({ color: INK.fail })]);
      expect(texts(card).filter(text => /^(QUEUED|WAITING|RUNNING|VERIFYING)$|^waits on /.test(text)), `${columns} ${id}`).toEqual([]);
      // its pill reads not started, never a filled running pill
      expect(lines.filter(line => line.text === ` ○ ${id} `), `${columns} ${id} pill`).toEqual([expect.objectContaining({ color: "inactive", card: null })]);
    }
    // control: a dependent of a running task still reads `waits on …`, never blocked
    const waiting = inCard(lines, "T17");
    expect(texts(waiting), `${columns} T17`).toEqual(expect.arrayContaining(["waits on T4", "WAITING"]));
    expect(texts(waiting).filter(text => /blocked|BLOCKED/i.test(text)), `${columns} T17`).toEqual([]);
  }
});

test("each exclusion entry draws one header line and a snapshot without exclusions draws none", () => {
  const header = (x: { channel: string; cause: string; line: number }): string =>
    `excluded run-wide: ${x.channel} — ${x.cause} (journal line ${x.line})`;
  const DEAD = { channel: "codex:gpt-6-sol", cause: "dead channel: auth expired", line: 90 };
  const cases: [label: string, exclusions: RunSnapshot["exclusions"], drawn: string[]][] = [
    ["…2405's demotion", [DEMOTION_2405], ["excluded run-wide: claude-code:claude-opus-5-5 — no-trailer streak 2 (journal line 75)"]],
    ["two entries, in the snapshot's order", [DEMOTION_2405, DEAD], [header(DEMOTION_2405), header(DEAD)]],
    ["no exclusions field (control)", undefined, []],
    ["an empty list (control)", [], []],
  ];
  for (const [label, exclusions, drawn] of cases) {
    for (const columns of WIDTHS) {
      const lines = draw(live(stoppedTasks, exclusions === undefined ? {} : { exclusions }), columns);
      const drawnLines = lines.filter(line => line.text.includes("excluded run-wide:"));
      expect(texts(drawnLines), `${label} ${columns}`).toEqual(drawn);
      for (const line of drawnLines) expect(line, `${label} ${columns}`).toMatchObject({ color: INK.warn, card: null });
      // header lines: above the merged count, never inside a card
      const merged = texts(lines).indexOf(`1 of ${stoppedTasks.length} merged`);
      for (const text of drawn) expect(texts(lines).indexOf(text), `${label} ${columns}`).toBeLessThan(merged);
    }
  }
});

test("a failed task draws its reason once and a long reason wraps whole", () => {
  const PARK_NOTE = "review round cap · review ✖ src/x.ts null deref";
  const parkedWith = (note: string): TaskRow => row("T5", {
    state: "parked", dispatched: true, launches: 1, note, now: "parked {since} · gate-fail", nowSince: AT - 60,
    startEpoch: AT - 900, startedAt: "2026-11-08 13:57:45",
  });
  // [label, task, the one line its reason draws on]
  const cases: [label: string, task: TaskRow, line: string][] = [
    ["…2405's routing note", failed("T2", SUMMARY_2405), `failed — ${SUMMARY_2405}`],
    ["a reason of several hundred characters in no special form", failed("T2", LONG), `failed — ${LONG}`],
    ["a parked note apart from its now-sentence (control)", parkedWith(PARK_NOTE), `↳ ${PARK_NOTE}`],
    ["a long parked note (control)", parkedWith(LONG), `↳ ${LONG}`],
  ];
  expect(LONG.length).toBeGreaterThan(300);
  for (const [label, task, drawn] of cases) {
    const reason = task.note;
    for (const columns of WIDTHS) {
      const lines = draw(live([task, blocked("T3", [task.id], task.id, task.state as "failed" | "parked")]), columns);
      // drawn once in the whole pane (its needsYou entry carries the same reason), never a second ↳ line
      const carrying = lines.filter(line => line.text.includes(reason.slice(0, 40)));
      expect(carrying, `${label} ${columns}`).toEqual([expect.objectContaining({ text: drawn, wrap: "wrap", card: task.id })]);
      // whole: the line holds the full reason and no ellipsis cut
      expect(carrying[0]!.text.endsWith(reason), `${label} ${columns}`).toBe(true);
      expect(carrying[0]!.text, `${label} ${columns}`).not.toContain("…");
    }
  }
});
