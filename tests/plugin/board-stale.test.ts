import { createElement, isValidElement, type ReactNode } from "react";
import { expect, test, vi } from "vitest";
import Board, { INK } from "../../hooks/board/board.js";
import type { RunSnapshot, TaskRow } from "../../hooks/board/state.js";

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
    elements, state: undefined as unknown, columns: 140, rows: 80,
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

const words = (lines: TextLine[]): string => lines.map(line => line.text).join("\n");
const hm = (epoch: number): string => {
  const d = new Date(Math.floor(Math.round(epoch * 1e6) / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
const has = (lines: TextLine[], text: string, color?: unknown) =>
  expect(lines).toContainEqual(color === undefined ? expect.objectContaining({ text }) : { text, color });

test("a snapshot whose read time has not changed for 30 seconds draws STALE and the not-refreshed line instead of LIVE and freezes its durations while a new read returns it to fresh (contract S rows)", () => {
  const clock = boardClock();
  has(clock.frame(snapshot), "● LIVE", INK.pass);
  clock.advance(5);
  // A successful read may have a newer readAt in the same epoch second. Its live ticks are kept for the freeze point.
  const sameEpochRead = { ...snapshot, readAt: "10:00:05" };
  has(clock.frame(sameEpochRead), "● LIVE", INK.pass);
  clock.advance(29);
  const before = clock.frame(sameEpochRead);
  has(before, "● LIVE", INK.pass);
  expect(words(before)).not.toContain("not refreshed since");
  expect(words(before)).toContain("working for 44s");
  clock.advance(1);
  const stale = clock.frame(sameEpochRead);
  has(stale, "● STALE · read 10:00:05", INK.warn);
  has(stale, "not refreshed since 10:00:05 — /tickmarkr-board reloads it", INK.warn);
  expect(words(stale)).not.toContain("● LIVE");
  expect(words(stale)).toContain("working for 15s");
  expect(words(stale)).toContain("checking for 15s");
  expect(words(stale)).toContain("25s elapsed");
  expect(words(stale)).toContain("approval window closes in 1:25");
  clock.advance(40);
  expect(clock.frame(sameEpochRead)).toEqual(stale);

  const next = { ...snapshot, atEpoch: AT + 75, readAt: "10:01:15" };
  const fresh = clock.frame(next);
  has(fresh, "● LIVE", INK.pass);
  expect(words(fresh)).not.toContain("not refreshed since");
  expect(words(fresh)).toContain("working for 1m 25s");
  clock.advance(1);
  expect(words(clock.frame(next))).toContain("working for 1m 26s");

  // The ended head's clock is anchored at Date.now(); pin it so the age is 0m and the end time is AT.
  vi.useFakeTimers();
  vi.setSystemTime(AT * 1000);
  try {
    const endedClock = boardClock();
    const ended: RunSnapshot = {
      ...snapshot, alive: false, endEpoch: AT, ended: { done: [], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed", owed: 0 },
    };
    const endedHead = `● ENDED · ended ${hm(AT)} · 0m ago`;
    has(endedClock.frame(ended), endedHead, INK.pass);
    endedClock.advance(30);
    has(endedClock.frame(ended), "● STALE · read 10:00:00", INK.warn);
    has(endedClock.frame(ended), "not refreshed since 10:00:00 — /tickmarkr-board reloads it", INK.warn);
    expect(words(endedClock.frame(ended))).not.toContain("● ENDED");
    has(endedClock.frame({ ...ended, readAt: "10:00:30" }), endedHead, INK.pass);
  } finally {
    vi.useRealTimers();
  }
});
