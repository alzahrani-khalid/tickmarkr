import { createElement, isValidElement, type ReactNode } from "react";
import { expect, test, vi } from "vitest";
import Board, { INK } from "../../hooks/board/board.js";
import type { RunSnapshot, TaskRow } from "../../hooks/board/state.js";

// Closed pane table (queue row 393, D-2187 add.16), drawn through the production Board with a fixed clock.
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

type TextLine = { text: string; color: unknown };
type Props = { children?: ReactNode; color?: unknown };
const elements = {
  Box: (props: Props) => createElement("Box", props),
  Text: (props: Props) => createElement("Text", props),
  Button: (props: Props) => createElement("Button", props),
};

function boardClock() {
  let tick: (() => void) | undefined;
  const surface = {
    elements, state: undefined as unknown, columns: 160, rows: 80,
    setState(next: unknown) { surface.state = next; },
    every(ms: number, callback: () => void) { expect(ms).toBe(1000); tick = callback; return () => {}; },
    post: () => {},
  };
  const frame = (snap: RunSnapshot): TextLine[] => {
    const lines: TextLine[] = [];
    const textOf = (node: ReactNode): string => {
      if (node == null || typeof node === "boolean") return "";
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (Array.isArray(node)) return node.map(textOf).join("");
      return isValidElement<Props>(node) ? textOf(node.props.children) : "";
    };
    const walk = (node: ReactNode): void => {
      if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!isValidElement<Props>(node)) throw new Error("unexpected board node");
      if (typeof node.type === "function") { walk((node.type as (props: Props) => ReactNode)(node.props)); return; }
      if (node.type === "Text") lines.push({ text: textOf(node.props.children), color: node.props.color });
      walk(node.props.children);
    };
    walk(Board({ snap, error: null } as never, surface as never) as ReactNode);
    return lines;
  };
  const advance = (seconds: number) => { for (let n = 0; n < seconds; n++) tick!(); };
  return { frame, advance };
}

const hm = (epoch: number): string => {
  const d = new Date(Math.floor(Math.round(epoch * 1e6) / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
const words = (lines: TextLine[]): string => lines.map(line => line.text).join("\n");
const texts = (lines: TextLine[]): string[] => lines.map(line => line.text);
const has = (lines: TextLine[], text: string, color?: unknown) =>
  expect(lines).toContainEqual(color === undefined ? expect.objectContaining({ text }) : { text, color });

/** One fresh pane whose frame clock is anchored at `END + seconds`. */
function atAge(seconds: number): TextLine[] {
  vi.setSystemTime((END + seconds) * 1000);
  return boardClock().frame(endedOf());
}

test("an ended snapshot heads with its end time and age and says no run is live while a live snapshot heads as at the base", () => {
  vi.useFakeTimers();
  try {
    const clockHm = hm(END);
    // Age floors: under an hour `<m>m`, under 48 hours `<h>h`, otherwise `<d>d`. A negative difference reads `0m`.
    const ages: [number, string][] = [
      [-30, "0m"], [0, "0m"], [59, "0m"], [60, "1m"], [3599, "59m"],
      [3600, "1h"], [90 * 60, "1h"], [47 * 3600, "47h"], [48 * 3600 - 1, "47h"],
      [48 * 3600, "2d"], [3 * 86400 + 100, "3d"],
    ];
    for (const [seconds, age] of ages) {
      const lines = atAge(seconds);
      has(lines, `● ENDED · ended ${clockHm} · ${age} ago`, INK.pass);
      has(lines, `no run live — showing the last run, ${RUN}, ended ${age} ago`, INK.warn);
      expect(words(lines), age).not.toContain("older than release");
    }

    // The base life word stays, and the suffix follows it.
    vi.setSystemTime((END + 7200) * 1000);
    has(boardClock().frame(endedOf({}, 2)), `● ENDED · owes 2 · ended ${clockHm} · 2h ago`, INK.fail);
    has(boardClock().frame(endedOf({}, null)), `● ENDED · owed unknown · ended ${clockHm} · 2h ago`, INK.fail);
    has(boardClock().frame(endedOf({}, 0, ["T9"])), `● ENDED · ended ${clockHm} · 2h ago`, INK.fail);

    // The frame timer moves the age. Durations stay on the ended run's own clock. Under 30s the head is not stale.
    vi.setSystemTime((END + 50) * 1000);
    const ticking = boardClock();
    const fresh = ticking.frame(endedOf());
    has(fresh, `● ENDED · ended ${clockHm} · 0m ago`, INK.pass);
    expect(words(fresh)).toContain("20s elapsed");
    expect(words(fresh)).not.toContain("not refreshed since");
    ticking.advance(20);
    const later = ticking.frame(endedOf());
    has(later, `● ENDED · ended ${clockHm} · 1m ago`, INK.pass);
    has(later, `no run live — showing the last run, ${RUN}, ended 1m ago`, INK.warn);
    expect(words(later)).toContain("20s elapsed");

    // Contract S keeps precedence: the stale head replaces the ended word, and the no-run-live line follows the stale line.
    vi.setSystemTime((END + 3590) * 1000);
    const aging = boardClock();
    has(aging.frame(endedOf()), `● ENDED · ended ${clockHm} · 59m ago`, INK.pass);
    aging.advance(30);
    const stale = aging.frame(endedOf());
    has(stale, "● STALE · read 10:00:00", INK.warn);
    has(stale, "not refreshed since 10:00:00 — /tickmarkr-board reloads it", INK.warn);
    has(stale, `no run live — showing the last run, ${RUN}, ended 1h ago`, INK.warn);
    const order = texts(stale);
    expect(order.indexOf("not refreshed since 10:00:00 — /tickmarkr-board reloads it"))
      .toBeLessThan(order.indexOf(`no run live — showing the last run, ${RUN}, ended 1h ago`));
    expect(order.some(line => line.startsWith("● ENDED"))).toBe(false);

    // Live, and daemon down: the head is the base word and neither new line is added. A stray supersededBy changes nothing.
    const live = endedOf({ alive: true, ended: null, endEpoch: null, pid: 42, supersededBy: "release-2230" });
    const liveLines = boardClock().frame(live);
    has(liveLines, "● LIVE", INK.pass);
    expect(words(liveLines)).not.toContain("no run live");
    expect(words(liveLines)).not.toContain("older than release");
    expect(words(liveLines)).not.toContain("· ended");
    const down = boardClock().frame({ ...live, alive: false, supersededBy: null });
    has(down, "● DAEMON DOWN", INK.fail);
    expect(words(down)).not.toContain("no run live");
    expect(words(down)).not.toContain("older than release");
    expect(words(down)).not.toContain("· ended");
    const liveClock = boardClock();
    liveClock.frame(live);
    liveClock.advance(30);
    const liveStale = liveClock.frame(live);
    has(liveStale, "● STALE · read 10:00:00", INK.warn);
    expect(words(liveStale)).not.toContain("no run live");
    expect(words(liveStale)).not.toContain("● LIVE");
  } finally {
    vi.useRealTimers();
  }
});

test("a superseded snapshot adds the older than release line and an oracles judge seat draws with no harness mark", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime((END + 2 * 86400) * 1000);
    const clockHm = hm(END);
    const older = `older than release release-2230 — a newer run left no journal under these roots`;
    const notice = `no run live — showing the last run, ${RUN}, ended 2d ago`;
    const superseded = boardClock().frame(endedOf({ supersededBy: "release-2230" }));
    has(superseded, `● ENDED · ended ${clockHm} · 2d ago`, INK.pass);
    has(superseded, notice, INK.warn);
    has(superseded, older, INK.warn);
    const order = texts(superseded);
    expect(order.indexOf(notice)).toBeLessThan(order.indexOf(older));

    // Absent and null carry no older-than line. The no-run-live line still does.
    for (const snap of [endedOf(), endedOf({ supersededBy: null }), endedOf({ supersededBy: "" })]) {
      const lines = boardClock().frame(snap);
      has(lines, notice, INK.warn);
      expect(words(lines)).not.toContain("older than release");
    }

    const seated = endedOf({
      tasks: [
        task("T1", { judge: "oracles" }),
        task("T2", { worker: "codex:sol", judge: "claude-code:opus" }),
      ],
    });
    const lines = boardClock().frame(seated);
    const drawn = texts(lines);
    expect(drawn).toContain("judge oracles");
    expect(drawn).toContain("✻");
    expect(drawn).toContain("⬡");
    expect(drawn).toContain(" opus");
    expect(drawn).toContain(" sol");
    expect(drawn.some(line => line === "•" || line === " oracles" || line === "oracles")).toBe(false);
    expect(drawn).toContain(" codex");
    expect(drawn).toContain(" claude-code");
    expect(drawn).not.toContain(" oracles");
  } finally {
    vi.useRealTimers();
  }
});
