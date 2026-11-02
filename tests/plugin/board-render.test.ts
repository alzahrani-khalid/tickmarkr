import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { expect, test } from "vitest";
// Static import uses the repository's normal react-jsx test transform; compilation errors fail collection.
import Board from "../../hooks/board/board.js";
import { copyTarget, parseBoard, view, visible } from "../../hooks/board/model.js";
import type { RunSnapshot, TaskRow } from "../../hooks/board/state.js";

// PORT-RULES B9: callable Client elements returning inspectable React elements; every function component (the
// reference's Text wrapper included) is evaluated; Copy buttons are told apart from task-selector buttons; no global h.
type Props = { children?: ReactNode; label?: string; plain?: boolean; variant?: string; onPress?: () => void };
const elements = {
  Box: (props: Props) => createElement("Box", props),
  Text: (props: Props) => createElement("Text", props),
  Button: (props: Props) => createElement("Button", props),
};
type Frame = { texts: string[]; labels: string[]; copies: { label: string; press: () => void }[]; selectors: Map<string, () => void> };

function render(props: unknown, surface: { state: unknown }): Frame {
  const frame: Frame = { texts: [], labels: [], copies: [], selectors: new Map() };
  const walk = (node: ReactNode): string => {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(walk).join("");
    if (!isValidElement<Props>(node)) throw new Error("unexpected board node");
    const element = node as ReactElement<Props>;
    if (typeof element.type === "function") return walk((element.type as (p: Props) => ReactNode)(element.props));
    const text = walk(element.props.children);
    if (element.type === "Text") frame.texts.push(text);
    if (element.type === "Button") {
      const { label, onPress } = element.props;
      expect(typeof label).toBe("string");
      expect(onPress).toBeTypeOf("function");
      frame.labels.push(label!);
      if (element.props.plain === true) frame.selectors.set(label!, onPress!);
      else {
        expect([label, element.props.variant]).toEqual(["Copy", "primary"]);
        frame.copies.push({ label: label!, press: onPress! });
      }
    }
    return text;
  };
  walk(Board(props as never, surface as never) as ReactNode);
  return frame;
}

const TAINT = "\x1b]52;c;cXdu\x07\x1b[2K\x9b2J";
const SHOWN = "\\x1b]52;c;cXdu\\x07\\x1b[2K\\u009b2J";
const t = (text: string) => text + TAINT;
const s = (text: string) => text + SHOWN;
// the board sentence-cases titles: lower case, then the first word character upper
const sentence = (text: string) => text.toLowerCase().replace(/^\w/, c => c.toUpperCase());
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
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

// The table: every journal- or release-controlled string the board renders, by field, in its shown form.
const TABLE: [field: string, shown: string][] = [
  ["run id", s("20261102-100040-0000000000000576")], // the head drops the run- prefix
  ["spec", `${s("v2.19.0-run-board")} · `], // queue row 335: the head names the spec being built
  ["task id badge", s("T1")], ["task id badge", s("T2")], ["task id badge", s("T3")],
  ["title", sentence(s("port the board"))], ["title", sentence(s("ship the plugin"))],
  ["note", `↳ ${s("park note")}`], ["now", s("parked on acceptance")], ["now", s("full suite running")],
  ["worker model", ` ${s("sol")}`], ["judge model", ` ${s("opus")}`], ["unknown harness", ` ${s("mystery")}`],
  ["started", `started ${s("2026-11-02 10:00:00")}`],
  ["release", `RELEASE ${s("2.19.0")}`], ["release run", `CI run ${s("19045")} on ${s("public")} · polled ${s("10:09")}`],
  ["release stage", `● ${s("CI")} ${s("3/5 jobs")}`],
  ["command", s("tickmarkr approve run-0576 T1 --park 93@x")],
];
const HISTORY: Record<string, [field: string, shown: string][]> = {
  [s("T1")]: [["history start", ` ${s("10:00")}  `], ["history part", s("worker 4m ✓")], ["history part", ` → ${s("acceptance ✖")}`],
    ["history reason", ` — ${s("criterion 2 cites no hunk")}`]],
  [s("T2")]: [["history start", ` ${s("10:05")}  `], ["history part", s("worker 2m ✓")], ["history part", ` → ${s("checks")}`]],
};

test("a table of rendered task, history part and reason, release and command strings carrying escape and bell bytes, at wide and narrow widths with each history-bearing task selected, shows only visible forms in every text and button label, and Copy posts the displayed command", () => {
  const state = parseBoard({ exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: "" });
  expect(state.snapshot).toEqual(SNAPSHOT);
  const shown = view(state);
  if (!("props" in shown)) throw new Error("expected the board view");

  const historyBearing = SNAPSHOT.tasks.filter(task => task.history.length).map(task => visible(task.id));
  expect(historyBearing).toEqual([s("T1"), s("T2")]);
  for (const columns of [400, 120, 60]) {
    const posted: unknown[] = [];
    const surface = {
      elements, state: undefined as unknown, columns, rows: 80,
      setState(next: unknown) { surface.state = next; }, every: () => () => {}, onPointer: () => () => {}, onKey: () => () => {},
      post: (data: unknown) => { posted.push(data); },
    };
    for (const selected of historyBearing) {
      render(shown.props, surface).selectors.get(selected)!();
      const frame = render(shown.props, surface);
      const label = `${columns} columns, ${JSON.stringify(selected)} selected`;
      for (const text of [...frame.texts, ...frame.labels]) expect(text, label).not.toMatch(CONTROL);
      expect(frame.texts.join("\n"), label).toContain(SHOWN);
      expect(frame.labels.filter(name => name !== "Copy").sort(), label).toEqual(SNAPSHOT.tasks.map(task => visible(task.id)).sort());
      if (columns === 400) {
        const all = frame.texts.join("\n");
        for (const [field, text] of [...TABLE, ...HISTORY[selected]!]) expect(all, `${label}: ${field}`).toContain(text);
        for (const [field, text] of HISTORY[selected === s("T1") ? s("T2") : s("T1")]!.slice(-1)) expect(all, `${label}: other ${field}`).not.toContain(text);
      }

      // Copy posts the command the card displays; the engine maps it back to the exact raw bytes
      expect(frame.copies.map(copy => copy.label)).toEqual(["Copy"]);
      posted.length = 0;
      frame.copies[0]!.press();
      expect(posted).toEqual([{ copy: visible(SNAPSHOT.needsYou[0]!.cmd) }]);
      const copy = (posted[0] as { copy: string }).copy;
      expect(frame.texts, label).toContain(copy);
      expect(copyTarget(state.snapshot, copy)).toBe(SNAPSHOT.needsYou[0]!.cmd);
    }
  }
});

test("the head names the spec being built and the run number, and falls back to the run id when no spec is recorded (queue row 335)", () => {
  const surface = {
    elements, state: undefined as unknown, columns: 400, rows: 80,
    setState(next: unknown) { surface.state = next; }, every: () => () => {}, onPointer: () => () => {}, onKey: () => () => {}, post: () => {},
  };
  const head = (spec: string | null): string[] => {
    const clean = { ...SNAPSHOT, runId: "run-20261102-100040-0000000000000576", spec };
    const shown = view(parseBoard({ exitCode: 0, stdout: JSON.stringify(clean), stderr: "" }));
    if (!("props" in shown)) throw new Error("expected the board view");
    return render(shown.props, surface).texts;
  };
  expect(head("v2.19.0-run-board")).toContain("v2.19.0-run-board · #576");
  expect(head(null)).toContain("20261102-100040 · #576");
  expect(head(null).join("\n")).not.toContain("v2.19.0");
});
