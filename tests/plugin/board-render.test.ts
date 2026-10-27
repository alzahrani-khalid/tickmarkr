import { isValidElement, type ReactNode } from "react";
import { expect, test } from "vitest";
// Static import uses the repository's normal react-jsx test transform; compilation errors fail collection.
import Board, { type BoardProps } from "../../hooks/board/board.js";

test("test: the run board rendered over a snapshot whose every journal-controlled field carries escape and bell bytes shows each field in its visible escape form and no raw escape or bell byte in any rendered text, while its copy action still posts the raw command, so a board field rendered without the filter fails", () => {
  const now = Date.parse("2026-10-27T10:00:00.000Z");
  const taint = (value: string) => `${value}\x1b[2K\x07`;
  const shown = "\\x1b[2K\\x07";
  const waive = "tickmarkr approve run-board T285 --waive";
  const recheck = "tickmarkr approve run-board T285 --recheck";
  const commands = [
    { verb: taint("waive"), command: taint(waive) },
    { verb: taint("recheck"), command: taint(recheck) },
  ];
  // Poison even wire enums and timestamps: journal strings are untrusted at runtime.
  const snapshot = {
    version: 1, runId: taint("run-board"), sequence: 100,
    observedAt: taint("2026-10-27T10:00:00.000Z"), daemon: taint("alive"), lifecycle: taint("PARTIAL"),
    verdict: {
      green: false, fatal: false, currentTip: taint("pending"),
      buckets: { failed: [], human: [], blocked: [], pending: [] },
      outstanding: { known: true, debt: 0, checks: [] },
    },
    approvalWindow: null,
    tasks: [{
      id: taint("T285"), title: taint("A task card"), deps: [], state: taint("blocked"),
      gates: {
        build: taint("passed"), lint: taint("passed"), evidence: taint("passed"), scope: taint("passed"),
        acceptance: taint("passed"), review: taint("passed"), test: taint("passed"),
      },
      tries: { round: 1, budget: 3, launches: 1 },
      seats: { worker: taint("worker-model"), judge: taint("judge-model"), reviewer: taint("reviewer-model") },
      startedAt: taint("2026-10-27T09:59:00.000Z"), endedAt: null,
      now: { phase: taint("phase"), since: null, blocker: taint("blocker"), nextAction: taint("next-action") },
    }],
    parks: [{
      taskId: taint("T285"), kind: taint("gate-fail"), reason: taint("park reason"), token: taint("park token"),
      commands, noDecision: taint("no decision available"),
    }],
  };
  const props = { state: { snapshot }, now } as unknown as BoardProps;
  const posted: unknown[] = [];
  const surface = {
    elements: { Box: "Box", Text: "Text", Button: "Button" },
    state: undefined, setState: () => {}, every: () => () => {}, columns: 180,
    post: (data: unknown) => { posted.push(data); },
  };
  const rendered: string[] = [];
  const lines: string[] = [];
  const copies: (() => void)[] = [];
  type ElementProps = { children?: ReactNode; label?: string; onPress?: () => void };
  function walk(node: ReactNode): string {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") {
      rendered.push(String(node));
      return String(node);
    }
    if (Array.isArray(node)) return node.map(walk).join("");
    if (!isValidElement<ElementProps>(node)) throw new Error("Unexpected board render node");
    // Only child text and the displayed button label are rendered. Keys deliberately retain raw ids.
    if (node.type === "Button") {
      expect(node.props.label).toBe("Copy");
      expect(node.props.onPress).toBeTypeOf("function");
      rendered.push(node.props.label!);
      copies.push(node.props.onPress!);
    }
    const text = walk(node.props.children);
    if (node.type === "Text") lines.push(text);
    return text;
  }
  walk(Board(props as never, surface as never) as ReactNode);

  // Closed field table, independent of model.visible: assert the production tree's actual text nodes.
  const expectedLines = [
    ["run id", `TICKMARKR run-board${shown}`],
    ["headline", `● PARTIAL${shown}`],
    ["task id", `T285${shown}`],
    ["title", `A task card${shown}`],
    ["state", `BLOCKED${shown}`],
    ["three seats", `worker worker-model${shown} · judge judge-model${shown} · reviewer reviewer-model${shown}`],
    ["started line", `started 2026-10-27T09:59:00.000Z${shown} · NaNs elapsed`],
    ["phase and blocker", `phase${shown} · blocker${shown}`],
    ["next action", `next-action${shown}`],
    ["park task id, kind and reason", `T285${shown} · gate-fail${shown} · park reason${shown}`],
    ["waive verb and command", `waive${shown}: ${waive}${shown}`],
    ["recheck verb and command", `recheck${shown}: ${recheck}${shown}`],
  ];
  for (const [field, text] of expectedLines) expect(lines, field).toContain(text);
  // The same park warning is rendered separately in its task card and in the needs-you lane.
  expect(lines.filter(text => text === `no decision available${shown}`)).toHaveLength(2);
  expect(rendered.join("\n")).not.toMatch(/[\x1b\x07]/);
  expect(rendered.filter(text => text === "Copy")).toHaveLength(2);
  expect(posted).toEqual([]);
  expect(copies).toHaveLength(commands.length);
  copies.forEach(press => press());
  expect(posted).toEqual(commands.map(({ command }) => ({ copy: command })));
  for (const { command } of commands) {
    expect(command).toContain("\x1b");
    expect(command).toContain("\x07");
  }
});
