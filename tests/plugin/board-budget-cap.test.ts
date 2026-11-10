// Queue row 408 (D-2187 add.48 and add.49): the board budget's level 3, driven through the production seam
// (parseBoard → view → budget → the shipped Board) under a fixed clock and drawn with the PORT-RULES B9 harness. The
// table is the contract's closed list of the level-3, worst-case and recorded-run cells. The recorded run …2493
// snapshot is read, never written.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Board, { type BoardProps } from "../../hooks/board/board.js";
import { BOUNDS, budget, leaveOut, measure, shed, within } from "../../hooks/board/budget.js";
import { parseBoard, shown, view } from "../../hooks/board/model.js";
import type { NeedsYou, RunSnapshot, TaskRow } from "../../hooks/board/state.js";

const AT = 1_794_147_165;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(AT * 1000); });
afterEach(() => { vi.useRealTimers(); });

// PORT-RULES B9: callable Client elements returning inspectable React elements; every function component is evaluated.
type Props = Record<string, unknown> & { children?: ReactNode };
const elements = {
  Box: (props: Props) => createElement("Box", props),
  Text: (props: Props) => createElement("Text", props),
  Button: (props: Props) => createElement("Button", props),
};
type Node = { type: string; key?: string; props: Record<string, unknown>; children: (Node | string)[] };
type Drawn = { tree: Node; json: string; nodes: number; depth: number };

function drawOnce(props: BoardProps, surface: { state: unknown; picks: Map<string, () => void> }, columns: number): Drawn {
  let nodes = 0;
  let depth = 0;
  const walk = (node: ReactNode, level: number, key?: string): (Node | string)[] => {
    if (node === null || node === undefined || typeof node === "boolean") return [];
    if (typeof node === "string" || typeof node === "number") return [String(node)];
    if (Array.isArray(node)) return node.flatMap(item => walk(item, level));
    if (!isValidElement<Props>(node)) throw new Error("unexpected board node");
    const element = node as ReactElement<Props>;
    const own = element.key ?? key;
    if (typeof element.type === "function") return walk((element.type as (p: Props) => ReactNode)(element.props), level, own);
    nodes += 1;
    depth = Math.max(depth, level);
    const { children, ...rest } = element.props;
    if (rest.plain === true) surface.picks.set(rest.label as string, rest.onPress as () => void);
    const kept = Object.fromEntries(Object.entries(rest).filter(([, value]) => typeof value !== "function"));
    return [{ type: element.type as string, ...(own == null ? {} : { key: own }), props: kept, children: walk(children, level + 1) }];
  };
  const host = {
    elements, columns, rows: 0, every: () => () => {}, onPointer: () => () => {}, onKey: () => () => {}, post: () => {},
    get state() { return surface.state; }, setState(next: unknown) { surface.state = next; },
  };
  const [tree] = walk(Board(props as never, host as never) as ReactNode, 1) as Node[];
  return { tree: tree!, json: JSON.stringify(tree), nodes, depth };
}
/** The board at every listed layout, focus on the featured task then on the longest history (its selector pressed). */
function draws(props: BoardProps): { at: string; drawn: Drawn }[] {
  const longest = props.snap.tasks.reduce<TaskRow | undefined>((best, t) => (!best || t.history.length > best.history.length ? t : best), undefined);
  return [140, 90, 60].flatMap(columns => {
    const surface = { state: undefined as unknown, picks: new Map<string, () => void>() };
    const featured = drawOnce(props, surface, columns);
    if (longest) surface.picks.get(longest.id)!();
    return [{ at: `${columns} featured`, drawn: featured },
      { at: `${columns} longest`, drawn: longest ? drawOnce(props, surface, columns) : featured }];
  });
}
const textOf = (node: Node | string): string => (typeof node === "string" ? node : node.children.map(textOf).join(""));
const find = (node: Node | string, match: (n: Node) => boolean): Node[] =>
  typeof node === "string" ? [] : [...(match(node) ? [node] : []), ...node.children.flatMap(child => find(child, match))];
const cardIds = (tree: Node): string[] => find(tree, n => /^card-T\d+$/.test(n.key ?? "")).map(n => n.key!.slice("card-".length));

/** Every bound holds in every drawn layout and focus, measured by this harness, not by the budget's own measure. */
function expectWithin(props: BoardProps): void {
  expect(JSON.stringify(props).length).toBeLessThanOrEqual(BOUNDS.props);
  for (const { at, drawn } of draws(props)) {
    expect(drawn.json.length, at).toBeLessThanOrEqual(BOUNDS.chars);
    expect(drawn.nodes, at).toBeLessThanOrEqual(BOUNDS.nodes);
    expect(drawn.depth, at).toBeLessThanOrEqual(BOUNDS.depth);
    // never blank: the head, the needsYou line and every task needsYou names draw
    expect(find(drawn.tree, n => n.key === "head"), at).toHaveLength(1);
    const named = props.snap.needsYou.map(n => n.task);
    if (named.length) expect(find(drawn.tree, n => n.key === "needs"), at).toHaveLength(1);
    expect(cardIds(drawn.tree).filter(id => named.includes(id)), at).toEqual(named.filter(id => props.snap.tasks.some(t => t.id === id)));
    for (const id of named) expect(cardIds(drawn.tree), at).toContain(id);
    expect(cardIds(drawn.tree).length, at).toBeGreaterThan(0);
  }
}

const ok = (snap: unknown) => ({ exitCode: 0, stdout: `${JSON.stringify(snap)}\n`, stderr: "" });
/** The props the production seam hands the pane for a wire snapshot. */
function seam(snap: unknown): BoardProps {
  const state = parseBoard(ok(snap));
  expect(state.error).toBeNull();
  const drawn = view(state, "glyph");
  if (!("props" in drawn)) throw new Error("expected the board view");
  return drawn.props;
}
const base = (snap: RunSnapshot): BoardProps => ({ snap: shown(snap), error: null, marks: "glyph" });

const row = (id: string, patch: Partial<TaskRow> = {}): TaskRow => ({
  id, title: `task ${id}`, state: "pending", attempt: 0, dispatched: false, budget: 3, launches: 0, gates: {}, note: "",
  deps: [], blocks: [], worker: "", judge: "", reviewer: "", suiteWaiting: false, now: "", nowSince: null, history: [],
  startEpoch: null, endEpoch: null, startedAt: "", endedAt: "", tokens: null, ...patch,
});
const RUN = "run-20261108-153320-0000000000002493";
const live = (tasks: TaskRow[], patch: Partial<RunSnapshot> = {}): RunSnapshot => ({
  version: 1, runId: RUN, spec: "v2.24.0-picks-tell-the-truth", alive: true, pid: 4242, elapsedMin: 77, ended: null, tasks,
  needsYou: [], approvalWindow: null, eta: null, atEpoch: AT, startEpoch: AT - 4620, endEpoch: null, readAt: "14:12:45",
  release: null, ...patch,
});
const need = (task: string, reason: string): NeedsYou =>
  ({ task, kind: "gate-fail", reason, since: AT - 60, blocks: [], cmd: `tickmarkr approve ${RUN} ${task} --park 93@x` });
const reason = (seed: string, n = 300): string => `${seed} `.repeat(n).slice(0, n);
/** A task that was tried `attempts` times, `parts` steps each, every step carrying a long red reason. */
const tried = (id: string, state: TaskRow["state"], attempts: number, parts: number): TaskRow => {
  const note = reason(`note-${id}`);
  return row(id, {
    title: `${reason(`title-${id}`, 200)}`, state, dispatched: true, attempt: attempts - 1, launches: attempts,
    worker: "codex:gpt-6-sol", judge: "claude-code:opus", reviewer: "gemini:pro", note,
    now: state === "failed" ? `failed — ${note}` : state === "parked" ? "parked {since} · gate-fail" : "worker {since}",
    nowSince: state === "failed" ? null : AT - 60, startEpoch: AT - 4000, startedAt: "2026-11-08 13:05:00",
    gates: { build: "pass", lint: "pass", evidence: "fail", scope: "pass" },
    history: Array.from({ length: attempts }, (_, a) => ({
      att: a + 1, start: `13:${String(a).padStart(2, "0")}`,
      parts: Array.from({ length: parts }, (_, k) => ({ text: `step ${k} ✖`, tone: "fail" as const, reason: reason(`r${a}-${k}-${id}`) })),
    })),
  });
};
const STATES: TaskRow["state"][] = ["failed", "parked", "worker", "failed", "pending"];
const runOf = (count: number, named: string[]): RunSnapshot => live(
  Array.from({ length: count }, (_, i) => {
    const id = `T${i + 1}`;
    return tried(id, named.includes(id) ? "parked" : STATES[i % STATES.length]!, 3, 20);
  }),
  { needsYou: named.map(id => need(id, reason(`need-${id}`))) },
);

test("a snapshot still over a bound after level two leaves the fewest last tasks out keeps every needs you task and draws one more tasks line naming the count and tickmarkr status", { timeout: 120_000 }, () => {
  // the needs-you tasks sit at the END of the task order, where level 3 cuts: they must stay
  const named = ["T2", "T29", "T30"];
  const snap = runOf(30, named);
  const one = base(snap);
  expect(within(measure({ ...one, snap: shed(one.snap, 2) }))).toBe(false); // still over after level two

  const props = seam(snap);
  const result = budget(one);
  expect(result).toMatchObject({ level: 3, fits: true });
  expect(props).toEqual(result.props);
  const more = props.more!;
  expect(more).toBeGreaterThan(0);

  // the last `more` tasks in task order that needsYou does not name are left out; every other task stays in order
  const removable = snap.tasks.map(t => t.id).filter(id => !named.includes(id));
  const out = removable.slice(-more);
  expect(props.snap.tasks.map(t => t.id)).toEqual(snap.tasks.map(t => t.id).filter(id => !out.includes(id)));
  for (const id of named) expect(props.snap.tasks.map(t => t.id)).toContain(id);
  expect(props.snap.needsYou.map(n => n.task)).toEqual(named);
  // the rest of the snapshot is level two's: leaving out is the only change
  expect(props.snap).toEqual(leaveOut(shed(one.snap, 2), more));

  // the smallest count: one fewer left out is still over a bound
  expect(within(measure({ ...one, snap: leaveOut(shed(one.snap, 2), more - 1), more: more - 1 }))).toBe(false);
  expect(within(measure(props))).toBe(true);

  // one line, after the last card, names the count and tickmarkr status
  for (const { at, drawn } of draws(props)) {
    const lines = find(drawn.tree, n => n.key === "more");
    expect(lines, at).toHaveLength(1);
    expect(textOf(lines[0]!), at).toBe(`+${more} more tasks (see tickmarkr status)`);
    const top = drawn.tree.children.map(c => (typeof c === "string" ? "" : c.key ?? ""));
    expect(top.indexOf("more"), at).toBe(top.indexOf("tasks") + 1);
    expect(leavesOfAll(drawn.tree).filter(t => t.includes("more tasks")), at).toHaveLength(1);
    expect(cardIds(drawn.tree), at).toEqual(props.snap.tasks.map(t => t.id));
  }
  expectWithin(props);

  // control: a fitting snapshot carries no `more` and draws no such line
  const small = base(live([row("T1"), row("T2")]));
  const fitting = budget(small);
  expect(fitting).toMatchObject({ level: 0, fits: true });
  expect(fitting.props).toBe(small);
  expect("more" in fitting.props).toBe(false);
  for (const { at, drawn } of draws(fitting.props)) expect(find(drawn.tree, n => n.key === "more"), at).toEqual([]);
});
const leavesOfAll = (node: Node | string): string[] => (typeof node === "string" ? [node] : node.children.flatMap(leavesOfAll));

test("a forty task snapshot with three attempts of twenty parts and long reasons draws within all four bounds in every listed layout and focus", { timeout: 120_000 }, () => {
  const named = ["T1", "T20", "T40"];
  const snap = runOf(40, named);
  expect(snap.tasks).toHaveLength(40);
  for (const t of snap.tasks) {
    expect(t.history).toHaveLength(3);
    for (const line of t.history) {
      expect(line.parts).toHaveLength(20);
      for (const part of line.parts) expect(part.reason!.length).toBe(300);
    }
  }
  const props = seam(snap);
  const result = budget(base(snap));
  expect(result.fits).toBe(true);
  expect(props).toEqual(result.props);
  expectWithin(props);
  for (const id of named) expect(props.snap.tasks.map(t => t.id)).toContain(id);
  if (result.level === 3) {
    for (const { at, drawn } of draws(props)) {
      expect(find(drawn.tree, n => n.key === "more").map(textOf), at).toEqual([`+${props.more} more tasks (see tickmarkr status)`]);
    }
  }
});

test("the recorded run snapshot fixture draws a non blank board within all four bounds", { timeout: 120_000 }, () => {
  const bytes = readFileSync(resolve(import.meta.dirname, "../fixtures/board/run-2493-snapshot.json"));
  // the recorded fixture, unedited: 32,447 bytes, sha256 prefix a9bcb0f40944d233, 27 tasks
  expect(bytes.length).toBe(32_447);
  expect(createHash("sha256").update(bytes).digest("hex").slice(0, 16)).toBe("a9bcb0f40944d233");
  const snap = JSON.parse(bytes.toString("utf8")) as RunSnapshot;
  expect(snap.tasks).toHaveLength(27);

  const props = seam(snap);
  expect(budget(base(snap)).fits).toBe(true);
  expectWithin(props);
  for (const { at, drawn } of draws(props)) {
    expect(cardIds(drawn.tree).length, at).toBeGreaterThan(0);
    expect(textOf(drawn.tree), at).toContain(snap.runId.replace(/^.*-0*(?=\d+$)/, "#"));
    expect(find(drawn.tree, n => n.key === "hist"), at).toHaveLength(1);
  }
});
