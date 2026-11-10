// Queue row 408 (D-2187 add.48, add.49, option A): the board budget, driven through the production seam
// (parseBoard → view → budget → the shipped Board) from wire snapshots this test writes, under a fixed clock, and drawn
// with the PORT-RULES B9 harness. Each table is a closed list of the contract's row 408 cells for levels 0 to 2.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Board, { type BoardProps } from "../../hooks/board/board.js";
import { BOUNDS, CUT, LAYOUTS, budget, measure, shed, within } from "../../hooks/board/budget.js";
import { parseBoard, shown, view } from "../../hooks/board/model.js";
import type { BudgetMeasure, NeedsYou, RunSnapshot, TaskRow } from "../../hooks/board/state.js";

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

/** The drawn host-element tree: type, key, props without functions or children, children; function components evaluated. */
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
function draws(props: BoardProps): { columns: number; focus: "featured" | "longest"; drawn: Drawn }[] {
  const longest = props.snap.tasks.reduce<TaskRow | undefined>((best, t) => (!best || t.history.length > best.history.length ? t : best), undefined);
  return [140, 90, 60].flatMap(columns => {
    const surface = { state: undefined as unknown, picks: new Map<string, () => void>() };
    const featured = drawOnce(props, surface, columns);
    if (longest) surface.picks.get(longest.id)!();
    return [{ columns, focus: "featured" as const, drawn: featured },
      { columns, focus: "longest" as const, drawn: longest ? drawOnce(props, surface, columns) : featured }];
  });
}
/** The board at `columns` with `id`'s ATTEMPTS selector pressed. */
function focusedOn(props: BoardProps, id: string, columns: number): Drawn {
  const surface = { state: undefined as unknown, picks: new Map<string, () => void>() };
  drawOnce(props, surface, columns);
  surface.picks.get(id)!();
  return drawOnce(props, surface, columns);
}
const textOf = (node: Node | string): string => (typeof node === "string" ? node : node.children.map(textOf).join(""));
const find = (node: Node | string, match: (n: Node) => boolean): Node[] =>
  typeof node === "string" ? [] : [...(match(node) ? [node] : []), ...node.children.flatMap(child => find(child, match))];

const ok = (snap: unknown) => ({ exitCode: 0, stdout: `${JSON.stringify(snap)}\n`, stderr: "" });
/** The props the production seam hands the pane for a wire snapshot. */
function seam(snap: RunSnapshot, marks: "glyph" | "devicons" = "glyph", fit?: number): BoardProps {
  const state = parseBoard(ok(snap));
  expect(state.error).toBeNull();
  const drawn = view(state, marks, fit);
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
const words = (n: number, seed: string): string => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ").slice(0, n);
const need = (task: string, reason: string, cmd = `tickmarkr approve ${RUN} ${task} --park 93@x`): NeedsYou =>
  ({ task, kind: "gate-fail", reason, since: AT - 60, blocks: [], cmd });
const parked = (id: string, note: string, patch: Partial<TaskRow> = {}): TaskRow => row(id, {
  state: "parked", dispatched: true, launches: 1, worker: "codex:gpt-6-sol", note, now: "parked {since} · gate-fail", nowSince: AT - 60,
  startEpoch: AT - 900, startedAt: "2026-11-08 13:57:45",
  history: [{ att: 1, start: "13:57", parts: [{ text: "worker 4m ✓", tone: "pass" }, { text: "acceptance ✖", tone: "fail", reason: "criterion 2 cites no hunk" }] }],
  ...patch,
});
/** A merged task with `attempts` attempt lines of `parts` short steps each: small as data, large drawn narrow. */
const merged = (id: string, attempts: number, parts: number): TaskRow => row(id, {
  state: "done", dispatched: true, attempt: attempts - 1, budget: attempts, launches: attempts, worker: "claude-code:opus",
  gates: { build: "pass", lint: "pass", evidence: "pass", scope: "pass", acceptance: "pass", review: "pass", test: "pass" },
  now: "merged 13:40", startEpoch: AT - 4000, endEpoch: AT - 100, startedAt: "2026-11-08 13:05:00", endedAt: "14:11",
  history: Array.from({ length: attempts }, (_, a) => ({
    att: a + 1, start: `13:${String(a % 60).padStart(2, "0")}`,
    parts: Array.from({ length: parts }, (_, k) => ({ text: `step ${k} ok`, tone: "pass" as const })),
  })),
});
const LONG_NOTE = words(200, "note"); // over CUT, kept whole until level 2
const MERGED_HISTORY = live([parked("T1", LONG_NOTE), merged("T2", 30, 20), row("T3", { now: "waits on T1" })],
  { needsYou: [need("T1", LONG_NOTE)] });

test("the budget measures props and the drawn tree as JSON length node count and depth in every listed layout and focus against the four bounds", () => {
  expect(BOUNDS).toEqual({ props: 80_000, chars: 80_000, nodes: 16_000, depth: 32 });
  expect(LAYOUTS).toEqual([140, 90, 60]);

  // each measurement equals the B9 harness's own: props JSON length, tree JSON length, host-element count, depth
  const props = base(MERGED_HISTORY);
  const measures = measure(props);
  const drawn = draws(props);
  const expected: BudgetMeasure[] = drawn.map(({ columns, focus, drawn }) =>
    ({ columns, focus, props: JSON.stringify(props).length, chars: drawn.json.length, nodes: drawn.nodes, depth: drawn.depth }));
  expect(measures).toEqual(expected);
  expect(measures.map(m => `${m.columns} ${m.focus}`)).toEqual(
    ["140 featured", "140 longest", "90 featured", "90 longest", "60 featured", "60 longest"]);
  // the featured task is T1 (parked); the longest history is T2's 30 attempts, drawn only once its selector is pressed
  const at = (columns: number, focus: string) => drawn.find(d => d.columns === columns && d.focus === focus)!.drawn;
  expect(find(at(140, "featured").tree, n => /^att-T1-\d+$/.test(n.key ?? ""))).toHaveLength(1);
  expect(find(at(140, "longest").tree, n => /^att-T2-\d+$/.test(n.key ?? ""))).toHaveLength(30);

  // this cell is over a bound in ONE measurement, the narrow layout with the longest history in focus: a budget that
  // measured one layout or one focus would pass it unshed
  const over = measures.filter(m => !within([m]));
  expect(over.map(m => `${m.columns} ${m.focus}`)).toEqual(["60 longest"]);
  expect(over[0]!.chars).toBeGreaterThan(BOUNDS.chars);
  expect(within(measures)).toBe(false);
  expect(within(measures.filter(m => m.columns !== 60))).toBe(true);
  expect(within(measures.filter(m => m.focus === "featured"))).toBe(true);

  // the props bound: reasons the pane never draws make the props alone too long, the tree well within
  const quiet = measure(base(live([parked("T1", "")], { needsYou: [need("T1", "r".repeat(BOUNDS.props))] })));
  for (const m of quiet) {
    expect(m.props).toBeGreaterThan(BOUNDS.props);
    expect(m.chars).toBeLessThan(BOUNDS.chars / 4);
  }
  expect(within(quiet)).toBe(false);

  // each bound alone: at the bound holds, one past it fails, whatever the other three read
  const fit = measures[0]!;
  for (const key of ["props", "chars", "nodes", "depth"] as const) {
    expect(within([{ ...fit, [key]: BOUNDS[key] }]), key).toBe(true);
    expect(within([{ ...fit, [key]: BOUNDS[key] + 1 }]), key).toBe(false);
    expect(within([fit, { ...fit, columns: 60, focus: "longest", [key]: BOUNDS[key] + 1 }]), key).toBe(false);
  }
  for (const m of measures) expect(m.depth).toBeLessThanOrEqual(BOUNDS.depth);
});

test("a snapshot over a bound only through a done task's long history sheds level one and that history draws one line", () => {
  // control: the same run with T2's history one attempt long is within every bound and passes unchanged
  const short = live([MERGED_HISTORY.tasks[0]!, merged("T2", 1, 20), MERGED_HISTORY.tasks[2]!], { needsYou: MERGED_HISTORY.needsYou });
  const control = base(short);
  expect(budget(control)).toMatchObject({ level: 0, fits: true });
  expect(budget(control).props).toBe(control);

  const props = seam(MERGED_HISTORY);
  const result = budget(base(MERGED_HISTORY));
  expect(result).toMatchObject({ level: 1, fits: true });
  expect(props).toEqual(result.props);
  // only T2's history changed: one line, its last attempt's att and start, `<k> attempts · merged`
  const t2 = shown(MERGED_HISTORY).tasks[1]!;
  expect(props.snap).toEqual({
    ...shown(MERGED_HISTORY),
    tasks: [shown(MERGED_HISTORY).tasks[0], { ...t2, history: [{ att: 30, start: "13:29", parts: [{ text: "30 attempts · merged", tone: "pass" }] }] }, shown(MERGED_HISTORY).tasks[2]],
  });
  // levels apply in order: level 2's cut has not happened, so the long note and needsYou reason stay whole
  expect(props.snap.tasks[0]!.note).toBe(LONG_NOTE);
  expect(props.snap.needsYou[0]!.reason).toBe(LONG_NOTE);
  expect(within(measure(props))).toBe(true);

  // drawn: with T2 in focus, every layout draws its history as one attempt line
  for (const columns of LAYOUTS) {
    const lines = find(focusedOn(props, "T2", columns).tree, n => /^att-T2-\d+$/.test(n.key ?? ""));
    expect(lines, `${columns}`).toHaveLength(1);
    expect(textOf(lines[0]!).replace(/\s+/g, " "), `${columns}`).toBe("a30 13:29 30 attempts · merged");
  }
});

test("a snapshot still over a bound after level one cuts every long reason and note to the fixed length with an ellipsis and keeps ids and commands whole", () => {
  const long = (seed: string) => `🔥${words(5000, seed)}`; // a code point outside the BMP: the cut counts characters
  const EDGE = "e".repeat(CUT); // exactly CUT characters: kept whole
  const PAST = "p".repeat(CUT + 1); // one more: cut
  const TITLE = words(300, "title");
  const tasks = [
    ...Array.from({ length: 6 }, (_, i) => parked(`T${i + 1}`, long(`n${i}`), {
      title: i === 0 ? TITLE : `task T${i + 1}`,
      history: [{ att: 1, start: "13:57", parts: [
        { text: "worker 4m ✓", tone: "pass" }, { text: "acceptance ✖", tone: "fail", reason: long(`r${i}`) }] }],
    })),
    parked("T7", EDGE), parked("T8", PAST), merged("T9", 5, 3), row("T10", { now: "waits on T1", note: long("pending") }),
  ];
  const CMD = `tickmarkr approve ${RUN} T1 --park 93@x ${words(300, "flag")}`;
  const snap = live(tasks, {
    needsYou: [need("T1", long("need"), CMD), ...tasks.slice(1, 8).map((t, i) => need(t.id, t.id === "T7" ? EDGE : long(`need${i}`)))],
  });
  const one = base(snap);
  const levelOne = { ...one, snap: shed(one.snap, 1) };
  expect(within(measure(levelOne))).toBe(false); // still over after level 1

  const props = seam(snap);
  const result = budget(one);
  expect(result).toMatchObject({ level: 2, fits: true });
  expect(props).toEqual(result.props);
  expect(within(measure(props))).toBe(true);

  // level 1 still applied first: the merged task's history is its one line
  expect(props.snap.tasks[8]!.history).toEqual([{ att: 5, start: "13:04", parts: [{ text: "5 attempts · merged", tone: "pass" }] }]);
  // every string of the level-1 snapshot is unchanged but a reason or note longer than CUT, which keeps CUT - 1
  // characters and gains `…`; ids, titles, commands, now-sentences and every other field are whole
  const leaves = (value: unknown, path = ""): [string, unknown][] =>
    value !== null && typeof value === "object"
      ? Object.entries(value).flatMap(([key, item]) => leaves(item, `${path}/${key}`)) : [[path, value]];
  const before = leaves(levelOne.snap);
  const after = new Map(leaves(props.snap));
  expect([...after.keys()]).toEqual(before.map(([path]) => path));
  let cuts = 0;
  for (const [path, value] of before) {
    const cuttable = /^\/tasks\/\d+\/note$|^\/tasks\/\d+\/history\/\d+\/parts\/\d+\/reason$|^\/needsYou\/\d+\/reason$/.test(path);
    if (cuttable && typeof value === "string" && [...value].length > CUT) {
      cuts += 1;
      expect(after.get(path), path).toBe(`${[...value].slice(0, CUT - 1).join("")}…`);
      expect([...(after.get(path) as string)].length, path).toBe(CUT);
    } else {
      expect(after.get(path), path).toBe(value);
    }
  }
  expect(cuts).toBe(8 + 6 + 7); // notes of T1–T6, T8 and T10; part reasons of T1–T6; needsYou reasons of T1–T6 and T8
  expect(props.snap.tasks[6]!.note).toBe(EDGE);
  expect(props.snap.tasks[7]!.note).toBe(`${"p".repeat(CUT - 1)}…`);
  expect(props.snap.tasks.map(t => t.id)).toEqual(tasks.map(t => t.id));
  expect(props.snap.tasks[0]!.title).toBe(TITLE);
  expect(props.snap.needsYou.map(n => n.cmd)).toEqual(snap.needsYou.map(n => n.cmd));
  expect(props.snap.needsYou[0]!.cmd).toBe(CMD);
});

// Queue row 408 (D-2187 add.90): the union review's two failed-task shapes. Production writes a failed task's
// now-sentence as `failed — <note>` (src/board/summarize.ts, src/board/run-truth.ts), and the board draws the reason
// once — no ↳ line when the now-sentence carries it. Level 2 cuts note, now-sentence and needsYou reason by one cut.
const failed = (id: string, note: string): TaskRow => row(id, {
  state: "failed", dispatched: true, launches: 1, worker: "codex:gpt-6-sol", note, now: `failed — ${note}`, nowSince: null,
  startEpoch: AT - 900, startedAt: "2026-11-08 13:57:45",
  history: [{ att: 1, start: "13:57", parts: [{ text: "worker 4m ✖", tone: "fail", reason: "worker exited 1" }] }],
});
const FAILED_CMD = `tickmarkr approve ${RUN} T1 --park 93@x`;
/** Every drawn string leaf, at every listed layout and focus. */
const leavesOf = (node: Node | string): string[] => (typeof node === "string" ? [node] : node.children.flatMap(leavesOf));
function drawsOneCutReason(note: string, reason: string, char: string) {
  const snap = live([failed("T1", note), row("T2", { now: "waits on T1" })], { needsYou: [need("T1", reason, FAILED_CMD)] });
  const props = seam(snap);
  const result = budget(base(snap));
  expect(props).toEqual(result.props);
  expect(result.level).toBe(2);
  const shortened = `${char.repeat(CUT - 1)}…`;
  const drawn = draws(props);
  for (const { columns, focus, drawn: d } of drawn) {
    const at = `${columns} ${focus}`;
    const lines = leavesOf(d.tree).filter(text => text.includes(char.repeat(10)));
    expect(lines, at).toEqual([`failed — ${shortened}`]); // exactly one reason line, never a full-length copy
    expect(Array.from(lines[0]!.slice("failed — ".length)).length, at).toBeLessThanOrEqual(CUT);
    expect(leavesOf(d.tree).filter(text => text.startsWith("↳ ")), at).toEqual([]); // no second ↳ line
    expect(d.json.includes(char.repeat(CUT)), at).toBe(false);
  }
  // the one shared cut, in every field the board draws the reason from
  const task = props.snap.tasks[0]!;
  expect(task.note).toBe(shortened);
  expect(task.now).toBe(`failed — ${shortened}`);
  expect(props.snap.needsYou[0]!.reason).toBe(`${reason[0]!.repeat(CUT - 1)}…`);
  // ids, titles and commands whole
  expect(props.snap.tasks.map(t => [t.id, t.title])).toEqual(snap.tasks.map(t => [t.id, t.title]));
  expect(props.snap.needsYou[0]!.cmd).toBe(FAILED_CMD);
  // fits is true only when the DRAWN tree, as the harness draws it, is inside the four bounds
  const inside = drawn.every(({ drawn: d }) => JSON.stringify(props).length <= BOUNDS.props
    && d.json.length <= BOUNDS.chars && d.nodes <= BOUNDS.nodes && d.depth <= BOUNDS.depth);
  expect(result.fits).toBe(inside);
  expect(result.fits).toBe(true);
}

test("a failed task with a short note over the cut and a needs you reason past the props bound draws its cut reason once with no second reason line", () => {
  drawsOneCutReason("x".repeat(300), "r".repeat(80_000), "x");
});

test("a failed task whose note now sentence and needs you reason all carry one very long reason draws it once at the cut and never at full length", () => {
  drawsOneCutReason("x".repeat(30_000), "x".repeat(30_000), "x");
});

// The control cell: every full snapshot the pane tests use, rebuilt here verbatim from each test's own construction
// (its helpers, ids, clocks and patches), and every full snapshot in the reader goldens. A closed list: one block per
// source test, every snapshot that test builds, each drawn at the wall clocks its test pins (only the ended head reads
// the wall clock; a test that pins none draws at this file's clock).
type Cell = { label: string; snap: RunSnapshot; at: readonly number[] };
const cell = (label: string, snap: RunSnapshot, at: readonly number[] = [AT]): Cell => ({ label, snap, at });
type Golden = { expected: Record<string, unknown> };
const GOLDENS = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/board/goldens.json"), "utf8")) as { cases: Golden[]; io: Golden[] };

/** board-render.test.ts: the tainted SNAPSHOT, and the head test's clean run id with a spec and with none. */
function renderCells(): Cell[] {
  const TAINT = "\x1b]52;c;cXdu\x07\x1b[2K\x9b2J";
  const t = (text: string) => text + TAINT;
  const AT = 1_793_594_000;
  const row = (id: string, patch: Partial<TaskRow>): TaskRow => ({
    id, title: "a task", state: "pending", attempt: 0, dispatched: false, budget: 3, launches: 0, gates: {}, note: "",
    deps: [], blocks: [], worker: "", judge: "", reviewer: "", suiteWaiting: false, now: "waits on T1", nowSince: null,
    history: [], startEpoch: null, endEpoch: null, startedAt: "", endedAt: "", tokens: null, ...patch,
  });
  const T1 = t("T1");
  const T2 = t("T2");
  const SNAPSHOT: RunSnapshot = {
    version: 1, runId: t("run-20261102-100040-0000000000000576"), spec: t("v2.19.0-run-board"), alive: true, pid: 4242, elapsedMin: 12, ended: null,
    tasks: [
      row(T1, {
        title: t("port the board"), state: "parked", dispatched: true, attempt: 1, launches: 2,
        gates: { build: "pass", lint: "pass", evidence: "pass", scope: "pass", acceptance: "fail" }, note: t("park note"),
        worker: `codex:${t("sol")}`, judge: `claude-code:${t("opus")}`, reviewer: t("mystery"),
        now: t("parked on acceptance"), startEpoch: AT - 600, startedAt: t("2026-11-02 10:00:00"),
        history: [{ att: 1, start: t("10:00"), parts: [{ text: t("worker 4m ✓"), tone: "pass" }, { text: t("acceptance ✖"), tone: "fail", reason: t("criterion 2 cites no hunk") }] }],
      }),
      row(T2, {
        title: t("ship the plugin"), state: "gates", dispatched: true, worker: `codex:${t("sol")}`, now: t("full suite running"),
        gates: { build: "pass", lint: "pass", evidence: "pass", scope: "pass" }, startEpoch: AT - 300, startedAt: t("2026-11-02 10:05:00"),
        history: [{ att: 1, start: t("10:05"), parts: [{ text: t("worker 2m ✓"), tone: "pass" }, { text: t("checks"), tone: "open", since: AT - 30 }] }],
      }),
      row(t("T3"), { title: t("later work"), now: t("waits on T2") }),
    ],
    needsYou: [{ task: T1, kind: t("gate-fail"), reason: t("acceptance"), since: AT - 60, blocks: [], cmd: t("tickmarkr approve run-0576 T1 --park 93@x") }],
    approvalWindow: { closesAt: AT + 80, parked: [T1] },
    eta: { cleanMin: 12, oneRepairMin: 30, criticalPath: [T2], stoppedBy: [T1] },
    atEpoch: AT, startEpoch: AT - 600, endEpoch: null, readAt: t("10:10:00"),
    release: {
      version: t("2.19.0"), dir: t("/rel"), ciRun: t("19045"), mirror: t("public"), status: t("in_progress"), conclusion: "",
      polledAt: t("10:09"), stages: [{ name: t("CI"), state: "running", detail: t("3/5 jobs") }, { name: "tag", state: "pending", detail: "" }],
    },
  };
  const clean = (spec: string | null): RunSnapshot => ({ ...SNAPSHOT, runId: "run-20261102-100040-0000000000000576", spec });
  return [
    cell("render: the tainted SNAPSHOT", SNAPSHOT),
    cell("render: the head's clean run id with its spec", clean("v2.19.0-run-board")),
    cell("render: the head's clean run id with no spec", clean(null)),
  ];
}

/** board-ended.test.ts: every endedOf variant, the live and daemon-down snapshots, at the clocks each is drawn at. */
function endedCells(): Cell[] {
  const END = 1_700_000_000;
  const RUN = "run-20261102-100040-0000000000001724";
  const task = (id: string, patch: Partial<TaskRow>): TaskRow => ({
    id, title: "a task", state: "done", attempt: 0, dispatched: true, budget: 2, launches: 1,
    gates: {}, note: "", deps: [], blocks: [], worker: "", judge: "", reviewer: "", suiteWaiting: false,
    now: "merged", nowSince: null, history: [], startEpoch: END - 20, endEpoch: END, startedAt: "10:00:00", endedAt: "10:00",
    tokens: null, ...patch,
  });
  const endedOf = (patch: Partial<RunSnapshot> = {}, owed: number | null = 0, failed: string[] = []): RunSnapshot => ({
    version: 1, runId: RUN, spec: null, alive: false, pid: null, elapsedMin: 1,
    ended: { done: ["T1"], failed, human: [], blocked: [], pending: [], tipVerify: "passed", owed },
    tasks: [task("T1", {})], needsYou: [], approvalWindow: null, eta: null,
    atEpoch: END, startEpoch: END - 20, endEpoch: END, readAt: "10:00:00", release: null, ...patch,
  });
  const AGES = [-30, 0, 59, 60, 3599, 3600, 90 * 60, 47 * 3600, 48 * 3600 - 1, 48 * 3600, 3 * 86400 + 100].map(s => END + s);
  const live = endedOf({ alive: true, ended: null, endEpoch: null, pid: 42, supersededBy: "release-2230" });
  const TWO_DAYS = [END + 2 * 86400];
  return [
    cell("ended: owing nothing", endedOf(), [...AGES, END + 50, END + 3590]),
    cell("ended: owes 2", endedOf({}, 2), [END + 7200]),
    cell("ended: owed unknown", endedOf({}, null), [END + 7200]),
    cell("ended: a failed task", endedOf({}, 0, ["T9"]), [END + 7200]),
    cell("ended: live with a stray supersededBy", live, [END + 3590]),
    cell("ended: daemon down, supersededBy null", { ...live, alive: false, supersededBy: null }, [END + 3590]),
    cell("ended: superseded", endedOf({ supersededBy: "release-2230" }), TWO_DAYS),
    cell("ended: supersededBy null", endedOf({ supersededBy: null }), TWO_DAYS),
    cell("ended: supersededBy empty", endedOf({ supersededBy: "" }), TWO_DAYS),
    cell("ended: an oracles judge seat", endedOf({
      tasks: [task("T1", { judge: "oracles" }), task("T2", { worker: "codex:sol", judge: "claude-code:opus" })],
    }), TWO_DAYS),
  ];
}

/** board-stale.test.ts: the first read, the refreshed reads at 10:00:05 and 10:01:15, the ended run and its read at 10:00:30. */
function staleCells(): Cell[] {
  const AT = 1_793_594_000;
  const task: TaskRow = {
    id: "T1", title: "running task", state: "worker", attempt: 0, dispatched: true, budget: 2, launches: 1,
    gates: {}, note: "", deps: [], blocks: [], worker: "codex:sol", judge: "", reviewer: "", suiteWaiting: false,
    now: "working for {since}", nowSince: AT - 10,
    history: [{ att: 1, start: "10:00", parts: [{ text: "checking for {since}", tone: "open", since: AT - 10 }] }],
    startEpoch: AT - 20, endEpoch: null, startedAt: "10:00:00", endedAt: "", tokens: null,
  };
  const snapshot: RunSnapshot = {
    version: 1, runId: "run-20261102-100040-0000000000000576", spec: null, alive: true, pid: 42,
    elapsedMin: 1, ended: null, tasks: [task], needsYou: [{ task: "T1", kind: "approval", reason: "wait", since: AT, blocks: [], cmd: "tickmarkr approve" }],
    approvalWindow: { closesAt: AT + 90, parked: ["T1"] }, eta: { cleanMin: 2, oneRepairMin: 4, criticalPath: ["T1"], stoppedBy: [] },
    atEpoch: AT, startEpoch: AT - 20, endEpoch: null, readAt: "10:00:00", release: null,
  };
  const ended: RunSnapshot = {
    ...snapshot, alive: false, endEpoch: AT, ended: { done: [], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed", owed: 0 },
  };
  return [
    cell("stale: the first read", snapshot),
    cell("stale: a read at 10:00:05 in the same epoch second", { ...snapshot, readAt: "10:00:05" }),
    cell("stale: a new read at 10:01:15", { ...snapshot, atEpoch: AT + 75, readAt: "10:01:15" }),
    cell("stale: the ended run", ended, [AT]),
    cell("stale: the ended run read again at 10:00:30", { ...ended, readAt: "10:00:30" }, [AT]),
  ];
}

/** board-run-truth.test.ts: the four-root stop, its four ETA controls, the blocked snapshot, four exclusion and four reason cases. */
function runTruthCells(): Cell[] {
  const AT = 1_794_147_165;
  const RUN = "run-20261108-125547-0000000000002405";
  const row = (id: string, patch: Partial<TaskRow>): TaskRow => ({
    id, title: `task ${id}`, state: "pending", attempt: 0, dispatched: false, budget: 3, launches: 0, gates: {}, note: "",
    deps: [], blocks: [], worker: "", judge: "", reviewer: "", suiteWaiting: false, now: "", nowSince: null, history: [],
    startEpoch: null, endEpoch: null, startedAt: "", endedAt: "", tokens: null, ...patch,
  });
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
  const SUMMARY_2405 = "pool implement has no live channel at floor frontier: 1 excluded run-wide (claude-code:claude-opus-5-5), 3 below floor, 3 not found";
  const DEMOTION_2405 = { channel: "claude-code:claude-opus-5-5", cause: "no-trailer streak 2", line: 75 };
  const LONG = Array.from({ length: 9 }, (_, i) => `repair ${i + 1} left the verifier red on src/run/daemon.ts with the same unhandled rejection`).join("; ");
  const ROOTS = ["T2", "T8", "T12", "T20"];
  const reachableTasks = [row("T1", { state: "done", now: "merged 13:40 · 1 attempt(s)" }), running("T4"), row("T17", { deps: ["T4"], now: "waits on T4" })];
  const stoppedTasks = [...reachableTasks, ...ROOTS.map(id => failed(id, SUMMARY_2405)), blocked("T3", ["T2"], "T2", "failed")];
  const PATH = ["T4", "T17", "T18", "T19"];
  const etas: [label: string, eta: RunSnapshot["eta"]][] = [
    ["a reachable run", { cleanMin: 49, oneRepairMin: 94, criticalPath: PATH, stoppedBy: [] }],
    ["cannotFinish false", { cleanMin: 49, oneRepairMin: 94, criticalPath: PATH, stoppedBy: [], cannotFinish: false }],
    ["an older CLI's parked stop, no cannotFinish key", { cleanMin: 12, oneRepairMin: 30, criticalPath: ["T4"], stoppedBy: ["T6"] }],
    ["no ETA", null],
  ];
  const parkedT5 = row("T5", {
    state: "parked", dispatched: true, launches: 1, note: "review round cap · review ✖ src/x.ts null deref",
    now: "parked {since} · gate-fail · blocks T6", nowSince: AT - 60, startEpoch: AT - 900, startedAt: "2026-11-08 13:57:45",
  });
  const DEAD = { channel: "codex:gpt-6-sol", cause: "dead channel: auth expired", line: 90 };
  const exclusions: [label: string, exclusions: RunSnapshot["exclusions"]][] = [
    ["…2405's demotion", [DEMOTION_2405]], ["two entries, in the snapshot's order", [DEMOTION_2405, DEAD]],
    ["no exclusions field", undefined], ["an empty list", []],
  ];
  const PARK_NOTE = "review round cap · review ✖ src/x.ts null deref";
  const parkedWith = (note: string): TaskRow => row("T5", {
    state: "parked", dispatched: true, launches: 1, note, now: "parked {since} · gate-fail", nowSince: AT - 60,
    startEpoch: AT - 900, startedAt: "2026-11-08 13:57:45",
  });
  const reasons: [label: string, task: TaskRow][] = [
    ["…2405's routing note", failed("T2", SUMMARY_2405)], ["a reason of several hundred characters", failed("T2", LONG)],
    ["a parked note apart from its now-sentence", parkedWith(PARK_NOTE)], ["a long parked note", parkedWith(LONG)],
  ];
  return [
    cell("run truth: cannot finish, stopped by four roots", live(stoppedTasks, { eta: { cleanMin: 0, oneRepairMin: 0, criticalPath: PATH, stoppedBy: ROOTS, cannotFinish: true } })),
    ...etas.map(([label, eta]) => cell(`run truth: ETA control, ${label}`, live(reachableTasks, { eta }))),
    cell("run truth: blocked tasks", live([
      failed("T2", "worker exited 1"), blocked("T3", ["T2"], "T2", "failed"),
      parkedT5, blocked("T6", ["T5"], "T5", "parked"),
      running("T4"), row("T17", { deps: ["T4"], now: "waits on T4" }),
    ], { needsYou: [failure(failed("T2", "worker exited 1"))] })),
    ...exclusions.map(([label, list]) => cell(`run truth: exclusions, ${label}`, live(stoppedTasks, list === undefined ? {} : { exclusions: list }))),
    ...reasons.map(([label, task]) => cell(`run truth: reason, ${label}`,
      live([task, blocked("T3", [task.id], task.id, task.state as "failed" | "parked")]))),
  ];
}

/** board-manifest.test.ts and board-seat-guard.test.ts: the snapshot each register test answers with. */
function registerCells(): Cell[] {
  const NOW_S = Date.parse("2026-11-02T10:00:00.000Z") / 1000;
  const MANIFEST: RunSnapshot = {
    version: 1, runId: "run-x881", alive: true, pid: 4242, elapsedMin: 3, ended: null,
    tasks: [{
      id: "T1", title: "Park a review red", state: "parked", attempt: 0, dispatched: true, budget: 1, launches: 1,
      gates: { build: "pass", test: "fail" }, note: "", deps: [], blocks: [],
      worker: "codex:gpt-6.1", judge: "", reviewer: "", suiteWaiting: false,
      now: "waits on the review gate", nowSince: null,
      history: [{ att: 0, start: "09:57:00", parts: [{ text: "worker", tone: "pass" }, { text: "review", tone: "fail", reason: "red diff" }] }],
      startEpoch: NOW_S - 180, endEpoch: null, startedAt: "2026-11-02 09:57:00", endedAt: "", tokens: null,
    }],
    needsYou: [{ task: "T1", kind: "gate-fail", reason: "review", since: NOW_S - 60, blocks: [], cmd: "tickmarkr approve run-x T1 --waive --gate review\x1b" }],
    approvalWindow: null, eta: null, atEpoch: NOW_S, startEpoch: NOW_S - 180, endEpoch: null,
    readAt: "10:00:00", release: null, spec: "v2.19.0-run-board",
  };
  const SEAT_GUARD: RunSnapshot = {
    version: 1, runId: "run-x881", alive: true, pid: 4242, elapsedMin: 3, ended: null,
    tasks: [], needsYou: [], approvalWindow: null, eta: null, atEpoch: 0, startEpoch: 0, endEpoch: null,
    readAt: "10:00:00", release: null, spec: null,
  };
  return [cell("manifest: a parked task whose command carries an ESC byte", MANIFEST), cell("seat guard: no tasks", SEAT_GUARD)];
}

/** board-register, -recovery, -autoload and -model tests: the golden main layout as wire version 1, with each test's patches. */
function controllerCells(): Cell[] {
  const BASE = { ...GOLDENS.io[0]!.expected, version: 1, readAt: "10:00:00", spec: null } as unknown as RunSnapshot;
  const recovery = (runId: string, readAt: string): RunSnapshot => ({ ...BASE, runId, readAt, alive: true, ended: null });
  const endedOf = (owed: number | null): NonNullable<RunSnapshot["ended"]> => ({
    done: ["T1"], failed: [], human: [], blocked: [], pending: [], tipVerify: owed === null || owed > 0 ? null : "passed", owed,
  });
  const autoload = (runId: string, alive: boolean | null, ended: RunSnapshot["ended"]): RunSnapshot => ({ ...BASE, runId, alive, ended });
  const READS: [runId: string, readAt: string][] = [
    ["run-boot", "10:00:00"], ["run-boot", "10:00:01"], ["run-boot", "10:00:05"], ["run-command", "10:00:10"], ["run-command-2", "10:00:15"],
    ["run-older", "10:00:20"], ["run-newer", "10:00:25"], ["run-newest", "10:00:30"], ["run-aged", "10:00:20"], ["run-command", "10:00:30"],
    ["run-open", "10:00:00"], ["run-latch", "10:00:01"], ["run-latch", "10:00:02"], ["run-same", "10:00:00"], ["run-same", "10:00:05"],
    ["run-other", "10:00:05"], ["run-latched", "10:00:00"], ["run-latched", "10:00:05"], ["run-latched", "10:00:10"],
  ];
  const AUTOLOAD: [runId: string, alive: boolean | null, ended: RunSnapshot["ended"]][] = [
    ["run-alive-true", true, null], ["run-alive-false", false, null], ["run-alive-null", null, null],
    ["run-ended", true, endedOf(0)], ["run-owed", false, endedOf(4)],
    ["run-a", true, null], ["run-a", false, null], ["run-a", null, null], ["run-b", null, null], ["run-b", true, null], ["run-b", true, endedOf(2)],
    ["run-narrow", null, null], ["run-narrow", false, null], ["run-narrow", true, null], ["run-ended", true, endedOf(3)], ["run-ended", false, null], ["run-other", null, null],
    ["run-after-empty", true, null], ["run-after-failed", null, null], ["run-shared", true, null],
  ];
  // board-model.test.ts's own wire(): release and spec default before the summary
  const MODEL = ({ release: null, spec: null, ...GOLDENS.io[0]!.expected, version: 1, readAt: "10:00:00" }) as unknown as RunSnapshot;
  const task = (id: string, state: TaskRow["state"]): TaskRow => ({ ...MODEL.tasks[0]!, id, state });
  const need = (taskId: string, cmd: string) => ({ task: taskId, kind: "gate-fail", reason: "review", since: 1, blocks: [], cmd });
  const raw = "tickmarkr approve run-1 T1 --park 7@x\x1b]52;c;cXdu\x07";
  const tainted = "T2\x1b]0;owned\x07";
  const release = { version: "2.19.0", dir: "/rel", ciRun: "1", mirror: null, status: "completed", conclusion: "success", polledAt: "10:00",
    stages: [{ name: "CI", state: "done" as const, detail: "" }] };
  const modelLive: RunSnapshot = { ...MODEL, runId: "run-20261102-100040-0000000000000576", alive: true, ended: null,
    tasks: [task("T1", "done"), task(tainted, "parked"), task("T3", "gates"), task("T4", "pending")], needsYou: [need(tainted, "c")], release };
  return [
    cell("register: the golden main layout", BASE),
    ...READS.map(([runId, readAt]) => cell(`recovery: ${runId} read at ${readAt}`, recovery(runId, readAt))),
    cell("recovery: run-same read at 10:00:05, daemon down", { ...recovery("run-same", "10:00:05"), alive: false }),
    ...AUTOLOAD.map(([runId, alive, ended]) => cell(`autoload: ${runId} alive ${String(alive)}, owed ${ended === null ? "no end" : String(ended.owed)}`,
      autoload(runId, alive, ended))),
    cell("model: the wire BASE", MODEL),
    cell("model: colliding Copy commands", { ...MODEL, needsYou: [need("T1", raw), need("T1", raw),
      need("T2", "tickmarkr approve run-1 T2 --park 8@x\\x1b"), need("T2", "tickmarkr approve run-1 T2 --park 8@x\x1b")] }),
    cell("model: colliding Copy commands, needsYou cleared (a stale post)", { ...MODEL, needsYou: [] }),
    cell("model: the tainted live run with a release", modelLive),
    cell("model: that run ended", { ...modelLive, needsYou: [], release: null,
      ended: { done: ["T1"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed", owed: 0 } }),
    cell("model: that run's daemon down with CI failed", { ...modelLive, alive: false,
      release: { ...release, stages: [{ name: "CI", state: "failed", detail: "" }] } }),
  ];
}

const PANES: Cell[] = [...renderCells(), ...endedCells(), ...staleCells(), ...runTruthCells(), ...registerCells(), ...controllerCells()];

test("every pane test snapshot and every full reader golden snapshot passes the budget unchanged and draws byte identical", { timeout: 60_000 }, () => {
  // the closed list: per source, the count of full snapshots its tests build
  const sources = PANES.map(c => c.label.slice(0, c.label.indexOf(":")));
  expect(Object.fromEntries([...new Set(sources)].map(s => [s, sources.filter(x => x === s).length]))).toEqual({
    render: 3, ended: 10, stale: 5, "run truth": 14, manifest: 1, "seat guard": 1, register: 1, recovery: 20, autoload: 20, model: 6,
  });
  expect(new Set(PANES.map(c => c.label)).size).toBe(PANES.length);
  const readerSnaps = [...GOLDENS.io, ...GOLDENS.cases].map(golden =>
    ({ release: null, spec: null, ...golden.expected, version: 1, readAt: "10:00:00" }) as unknown as RunSnapshot);
  expect(readerSnaps).toHaveLength(GOLDENS.io.length + GOLDENS.cases.length);
  expect(readerSnaps.length).toBeGreaterThan(100);
  // the pane snapshots also as the desktop draws them (devicons, fit 1.5); the goldens as view's defaults
  const variants = { pane: [["glyph", undefined], ["devicons", 1.5]], golden: [["glyph", undefined]] } as const;
  const cells: readonly (readonly [Cell, readonly (readonly ["glyph" | "devicons", number | undefined])[]])[] = [
    ...PANES.map(c => [c, variants.pane] as const),
    ...readerSnaps.map((snap, i) => [cell(`golden ${i}`, snap), variants.golden] as const),
  ];

  for (const [{ label, snap, at }, marks] of cells) {
    for (const clock of at) {
      vi.setSystemTime(clock * 1000);
      for (const [mark, fit] of marks) {
        const where = `${label} at ${clock} ${mark}`;
        const unbudgeted: BoardProps = { snap: shown(snap), error: null, marks: mark, ...(fit === undefined ? {} : { fit }) };
        const result = budget(unbudgeted);
        expect(result, where).toMatchObject({ level: 0, fits: true });
        expect(result.props, where).toBe(unbudgeted); // the same value, not a copy
        const props = seam(snap, mark, fit);
        expect(props, where).toEqual(unbudgeted);
        const drawnBase = draws(unbudgeted);
        draws(props).forEach(({ columns, focus, drawn }, i) => expect(drawn.json, `${where} ${columns} ${focus}`).toBe(drawnBase[i]!.drawn.json));
      }
    }
  }
});
