import Board, { type BoardProps } from "./board";
import type { BudgetBounds, BudgetLevel, BudgetMeasure, BudgetResult, RunSnapshot } from "./state";

/**
 * The board's tree budget (queue row 408; D-2187 add.48 and add.49, option A). The host unmounts a Client whose props
 * or drawn tree pass its bounds, read from the engine typings the board imports from `claude-code` (Claude Code
 * 2.1.319 claude-code.d.ts): ClientElements and ClientModule keep "every tree's bounds (20,000 nodes, 32 deep,
 * 100,000 characters serialized)", and the Client props doc bounds `props` at 100,000 characters serialized. The
 * typings name no serializer, so the budget measures JSON length and keeps a 20% margin on each size bound.
 * model.ts's view() calls `budget` before the snapshot becomes props: it sheds detail from the snapshot DATA, because
 * the host refuses oversized props before the pane can draw.
 */
export const BOUNDS: BudgetBounds = { props: 80_000, chars: 80_000, nodes: 16_000, depth: 32 };
/** The layouts measured (wide, medium, narrow), each with the focus on the featured and on the longest-history task. */
export const LAYOUTS = [140, 90, 60] as const;
/** Level 2's cut: a reason or note longer than this keeps its first CUT - 1 characters and gains `…`. */
export const CUT = 120;
const LEVELS: readonly BudgetLevel[] = [0, 1, 2];

type Drawn = { type: string; key?: string; props: Record<string, unknown>; children: (Drawn | string)[] };
type Element = { type: unknown; props?: Record<string, unknown>; key?: unknown };
const isElement = (node: unknown): node is Element => typeof node === "object" && node !== null && "type" in node;

/** Every element name draws a host element of that name: `{ type, props }`, the shape JSX hands the host. */
const elements = new Proxy({}, { get: (_, name) => (props: Record<string, unknown>) => ({ type: String(name), props }) });

/** A still surface at `columns` whose state the board keeps between draws, as the host keeps it between frames. */
const surfaceAt = (columns: number) => {
  const surface = {
    elements, columns, rows: 0, state: undefined as unknown,
    setState: (next: unknown) => { surface.state = next; },
    every: () => () => {}, onPointer: () => () => {}, onKey: () => () => {}, post: () => {},
  };
  return surface;
};

/**
 * One draw of the Board function over the measuring element table on `surface`: the host-element tree with function
 * components evaluated and functions dropped from props, its node count and depth, and the task selectors it drew.
 */
function drawBoard(props: BoardProps, surface: ReturnType<typeof surfaceAt>) {
  let nodes = 0;
  let depth = 0;
  const picks = new Map<string, () => void>();
  const walk = (node: unknown, level: number, key?: unknown): (Drawn | string)[] => {
    if (node === null || node === undefined || typeof node === "boolean") return [];
    if (typeof node === "string" || typeof node === "number") return [String(node)];
    if (Array.isArray(node)) return node.flatMap(item => walk(item, level));
    // an unknown node fails loud: a measure that cannot read the tree must not read as within bounds
    if (!isElement(node)) throw new Error("the board budget met a node it cannot measure");
    const own = node.key ?? key;
    if (typeof node.type === "function") return walk((node.type as (p: unknown) => unknown)(node.props ?? {}), level, own);
    nodes += 1;
    depth = Math.max(depth, level);
    const { children, ...rest } = node.props ?? {};
    if (rest.plain === true && typeof rest.onPress === "function") picks.set(String(rest.label), rest.onPress as () => void);
    const kept = Object.fromEntries(Object.entries(rest).filter(([, value]) => typeof value !== "function"));
    return [{ type: String(node.type), ...(own == null ? {} : { key: String(own) }), props: kept, children: walk(children, level + 1) }];
  };
  const tree = walk(Board(props as never, surface as never), 1);
  return { chars: JSON.stringify(tree.length === 1 ? tree[0] : tree).length, nodes, depth, picks };
}

/**
 * The four measures in every layout and focus: the featured task as the board first draws it, then the task with the
 * longest history, selected by pressing its ATTEMPTS selector as a person would. Props are measured once and shared.
 */
export function measure(props: BoardProps): BudgetMeasure[] {
  const propsLength = JSON.stringify(props).length;
  const tasks = props.snap.tasks;
  const longest = tasks.reduce<RunSnapshot["tasks"][number] | undefined>(
    (best, task) => (best === undefined || task.history.length > best.history.length ? task : best), undefined);
  return LAYOUTS.flatMap((columns): BudgetMeasure[] => {
    const surface = surfaceAt(columns);
    const featured = drawBoard(props, surface);
    const press = longest === undefined ? undefined : featured.picks.get(longest.id);
    press?.();
    const focused = press === undefined ? featured : drawBoard(props, surface);
    return [
      { columns, focus: "featured", props: propsLength, chars: featured.chars, nodes: featured.nodes, depth: featured.depth },
      { columns, focus: "longest", props: propsLength, chars: focused.chars, nodes: focused.nodes, depth: focused.depth },
    ];
  });
}

/** All four bounds hold in every measurement. */
export const within = (measures: readonly BudgetMeasure[]): boolean => measures.every(m =>
  m.props <= BOUNDS.props && m.chars <= BOUNDS.chars && m.nodes <= BOUNDS.nodes && m.depth <= BOUNDS.depth);

const cut = (text: string): string => ([...text].length > CUT ? [...text].slice(0, CUT - 1).join("") + "…" : text);

/**
 * Queue row 408 (D-2187 add.90): a failed task's now-sentence is `failed — <note>`, and the board draws the reason once,
 * from the now-sentence (no ↳ line when it carries the note). ONE shared cut shortens the note and every copy of it in
 * the now-sentence, so the drawn tree holds the cut reason once, never a full-length copy beside a shortened ↳ line.
 */
const cutNote = (task: RunSnapshot["tasks"][number]): { note: string; now: string } => {
  const note = cut(task.note);
  return { note, now: note === task.note ? task.now : task.now.split(task.note).join(note) };
};

/**
 * The snapshot at a shedding level, cumulative and in order. 1: a done task's history becomes one line, its last
 * attempt's `{ att, start }` with one part `<k> attempts · merged`. 2: also every history part reason, task note and
 * needsYou reason longer than CUT is cut, and a now-sentence carrying a cut note carries the same cut note in its place;
 * ids, titles, commands and every other field stay whole. Level 0 is the same
 * value. The input is never changed.
 */
export function shed(snap: RunSnapshot, level: BudgetLevel): RunSnapshot {
  if (level === 0) return snap;
  const merged = snap.tasks.map(task => {
    const last = task.history.at(-1);
    return task.state !== "done" || last === undefined ? task
      : { ...task, history: [{ att: last.att, start: last.start, parts: [{ text: `${task.history.length} attempts · merged`, tone: "pass" as const }] }] };
  });
  if (level === 1) return { ...snap, tasks: merged };
  return {
    ...snap,
    tasks: merged.map(task => ({
      ...task, ...cutNote(task),
      history: task.history.map(line => ({
        ...line, parts: line.parts.map(part => (part.reason === undefined ? part : { ...part, reason: cut(part.reason) })),
      })),
    })),
    needsYou: snap.needsYou.map(need => ({ ...need, reason: cut(need.reason) })),
  };
}

/** A budget level with the contract's level 3 (row 408, D-2187 add.48 and add.49): the last tasks left out. */
export type ShedLevel = BudgetLevel | 3;
export type Budgeted<P> = Omit<BudgetResult<P>, "level"> & { level: ShedLevel };

/**
 * Level 3 (queue row 408; D-2187 add.48 and add.49): the level-2 snapshot with the last `count` tasks in task order left
 * out of the task list, never a task named in needsYou, so the pane still draws the head, the needsYou line and every
 * task it names. The input is never changed.
 */
export function leaveOut(snap: RunSnapshot, count: number): RunSnapshot {
  const named = new Set(snap.needsYou.map(need => need.task));
  const out = new Set(snap.tasks.filter(task => !named.has(task.id)).slice(-count).map(task => task.id));
  return count <= 0 ? snap : { ...snap, tasks: snap.tasks.filter(task => !out.has(task.id)) };
}

/**
 * The FIRST level at which all four bounds hold in every measurement. A snapshot that fits at level 0 passes through
 * as the same props value, so it draws byte-identical to the base. Level 3 leaves out the SMALLEST count N of last
 * tasks at which all four bounds hold, and the props carry `more: N` so the pane draws one `+N more tasks` line. Past
 * every task that may be left out, the most-shed props are returned with `fits: false`.
 * ponytail: up to 18 board draws per call for levels 0 to 2, plus 6 per count tried at level 3; cache by snapshot
 * identity if view() turns hot.
 */
export function budget(props: BoardProps): Budgeted<BoardProps> {
  let result: Budgeted<BoardProps> | undefined;
  for (const level of LEVELS) {
    const next = level === 0 ? props : { ...props, snap: shed(props.snap, level) };
    const measures = measure(next);
    result = { props: next, level, fits: within(measures), measures };
    if (result.fits) return result;
  }
  const cutSnap = shed(props.snap, 2);
  const named = new Set(cutSnap.needsYou.map(need => need.task));
  const removable = cutSnap.tasks.filter(task => !named.has(task.id)).length;
  for (let more = 1; more <= removable; more += 1) {
    const next: BoardProps = { ...props, snap: leaveOut(cutSnap, more), more };
    const measures = measure(next);
    result = { props: next, level: 3, fits: within(measures), measures };
    if (result.fits) return result;
  }
  return result!;
}
