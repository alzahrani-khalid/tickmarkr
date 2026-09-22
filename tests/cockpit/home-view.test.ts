import { PassThrough } from "node:stream";
import { ttyInput } from "../helpers/tty-input.js";
import { createElement, type ReactElement } from "react";
import { render } from "ink";
import { describe, expect, test } from "vitest";
import { GLYPHS } from "../../src/brand.js";
import { graphDefinitionHash } from "../../src/graph/graph.js";
import { GATE_NAMES, type RunGraph } from "../../src/graph/schema.js";
import { readOperatorState, type EvidenceIdentity } from "../../src/run/operator-state.js";
import { graph, ev } from "../fixtures/operator-state/fixture.js";
import {
  deriveHomeView,
  HOME_ACTIVITY_VISIBLE_ROWS,
  HomeView,
  selectActivityTarget,
  selectNeedsYouTarget,
  type HomeActivityRow,
  type HomeNeedsYouTarget,
  type HomeViewModel,
} from "../../src/tui/cockpit/home-view.js";

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function makeInkStreams() {
  const input = ttyInput();
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  output.isTTY = true; output.columns = 100; output.rows = 40;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;
  return { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, writes };
}

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function drawFrame(node: ReactElement): Promise<{ frame: string; input: NodeJS.ReadStream; unmount: () => void }> {
  const { input, output, writes } = makeInkStreams();
  const app = render(node, { stdin: input, stdout: output, exitOnCtrlC: false, patchConsole: false, debug: true });
  await wait();
  return { frame: stripAnsi(writes.at(-1) ?? ""), input, unmount: () => app.unmount() };
}
async function mountHome(initialModel: HomeViewModel, handlers?: {
  onOpenPark?: (id: string) => void;
  onOpenDiagnostic?: (id: string) => void;
  onOpenEvidence?: (ev: EvidenceIdentity) => void;
  onSelectNeedsYou?: (target: HomeNeedsYouTarget | undefined, index: number) => void;
}) {
  const { input, output, writes } = makeInkStreams();
  const app = render(createElement(HomeView, {
    model: initialModel,
    focused: true,
    onOpenPark: handlers?.onOpenPark ?? (() => {}),
    onOpenDiagnostic: handlers?.onOpenDiagnostic ?? (() => {}),
    onOpenEvidence: handlers?.onOpenEvidence ?? (() => {}),
    onSelectNeedsYou: handlers?.onSelectNeedsYou,
  }), { stdin: input, stdout: output, exitOnCtrlC: false, patchConsole: false, debug: true });
  await wait();
  return {
    frame: () => stripAnsi(writes.at(-1) ?? ""),
    input,
    rerender: async (nextModel: HomeViewModel) => {
      app.rerender(createElement(HomeView, {
        model: nextModel,
        focused: true,
        onOpenPark: handlers?.onOpenPark ?? (() => {}),
        onOpenDiagnostic: handlers?.onOpenDiagnostic ?? (() => {}),
        onOpenEvidence: handlers?.onOpenEvidence ?? (() => {}),
        onSelectNeedsYou: handlers?.onSelectNeedsYou,
      }));
      await wait();
    },
    unmount: () => app.unmount(),
  };
}


// Seven gate results (declaration order) give a 7/7 historical gate-pass record for T1 alone.
const gateResults = (taskId: string) => GATE_NAMES.map((gate) => ev("gate-result", { gate, pass: true }, taskId));

const base = [
  ev("run-start", { graphDefinitionHash: graphDefinitionHash(graph), branch: "fixture" }),
  ev("task-dispatch", { attempt: 0 }, "T1"),
  ...gateResults("T1"),
  ev("merge", { commit: "abc" }, "T1"),
  ev("task-human", { kind: "human-gate" }, "T2"),
  ev("tip-verify", { pass: true }),
  ev("run-end", { done: ["T1"], failed: [], human: ["T2"], blocked: ["T3"], pending: [], tipVerify: "passed" }),
];
const approvedEvents = [...base, ev("task-approved", {}, "T2")];
const resumedEvents = [
  ...approvedEvents,
  ev("run-resume"),
  ev("task-dispatch", { attempt: 0, worktree: "/recorded/T2", pane: "p2", alarmMs: 45000 }, "T2"),
];
const completeEvents = [
  ...resumedEvents,
  ev("merge", {}, "T2"),
  ev("merge", {}, "T3"),
  ev("tip-verify", { pass: true }),
  ev("run-end", { done: ["T1", "T2", "T3"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" }),
];

const partialSnapshot = readOperatorState({ events: base, graph, sequence: 3, observedAt: 3000 });
const resumedSnapshot = readOperatorState({ events: resumedEvents, graph, sequence: 1, observedAt: 1000 });
const completeSnapshot = readOperatorState({ events: completeEvents, graph, sequence: 2, observedAt: 2000 });
const emptySnapshot = readOperatorState({ events: [] });

const zeroTaskGraph = {
  version: 1, spec: { source: "native", paths: ["empty.md"], hash: "fixture-empty" }, tasks: [],
} as unknown as RunGraph;
const zeroTaskEvents = [
  ev("run-start", { graphDefinitionHash: graphDefinitionHash(zeroTaskGraph) }),
  ev("run-end", { done: [], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" }),
];
const zeroTaskSnapshot = readOperatorState({ events: zeroTaskEvents, graph: zeroTaskGraph });

const seats = { active: 1, eligible: 3 };

test("The exported Home body consumed by C1 renders graph-backed MERGED with numerator 1 and denominator 3, historical GATES RAN with numerator 7 and denominator 7 and CURRENT TIP PENDING separately for the resumed fixture, versus closed merged numerator 3 and denominator 3 with every unresolved bucket empty. Empty Home offers existing Fleet/Plan CLI pointers and zero tasks says no plan. Equal-looking 100% pass and complete for a resumed or partial run fails.", async () => {
  const resumedModel = deriveHomeView({ operator: resumedSnapshot, seats });
  expect(resumedModel).toMatchObject({ merged: 1, planned: 3, currentTip: "pending", lifecycle: "RUNNING", green: false });
  expect(resumedModel.gatesRan).toEqual({ passed: 7, total: 7 });

  const completeModel = deriveHomeView({ operator: completeSnapshot, seats: { active: 0, eligible: 3 } });
  expect(completeModel).toMatchObject({ merged: 3, planned: 3, lifecycle: "COMPLETE", green: true });
  expect(completeModel.buckets).toEqual({ failed: [], human: [], blocked: [], pending: [] });

  // Historical gate-pass rate reads 100% under BOTH a genuinely closed-partial run (tip already
  // passed) and a resumed one — neither is "complete", and the render must never say so from the
  // rate alone (R19/R21).
  const partialModel = deriveHomeView({ operator: partialSnapshot, seats: { active: 0, eligible: 3 } });
  expect(partialModel.gatePassRate).toBe(100);
  expect(partialModel.currentTip).toBe("passed");
  expect(partialModel).toMatchObject({ lifecycle: "PARTIAL", green: false });
  expect(partialModel.buckets.human).toEqual(["T2"]);
  expect(partialModel.buckets.blocked).toEqual(["T3"]);
  expect(resumedModel.gatePassRate).toBe(100);
  expect(resumedModel.lifecycle).not.toBe("COMPLETE");

  const partialFrame = (await drawFrame(createElement(HomeView, {
    model: partialModel, onOpenPark: () => {}, onOpenDiagnostic: () => {}, onOpenEvidence: () => {},
  }))).frame;
  expect(partialFrame).toContain("HOME / PARTIAL");
  expect(partialFrame).toContain("100%");
  expect(partialFrame).not.toContain("HOME / COMPLETE");

  const resumedFrame = (await drawFrame(createElement(HomeView, {
    model: resumedModel, onOpenPark: () => {}, onOpenDiagnostic: () => {}, onOpenEvidence: () => {},
  }))).frame;
  expect(resumedFrame).toContain("1 / 3");
  expect(resumedFrame).toContain("7 / 7");
  expect(resumedFrame).toContain("CURRENT TIP: PENDING");
  expect(resumedFrame).not.toContain("HOME / COMPLETE");

  const completeFrame = (await drawFrame(createElement(HomeView, {
    model: completeModel, onOpenPark: () => {}, onOpenDiagnostic: () => {}, onOpenEvidence: () => {},
  }))).frame;
  expect(completeFrame).toContain("3 / 3");
  expect(completeFrame).toContain("HOME / COMPLETE");

  // Empty Home: no run recorded at all points at the existing CLI, never a fabricated frame.
  const emptyModel = deriveHomeView({ operator: emptySnapshot, seats: { active: 0, eligible: 0 } });
  expect(emptyModel.hasRun).toBe(false);
  const emptyFrame = (await drawFrame(createElement(HomeView, {
    model: emptyModel, onOpenPark: () => {}, onOpenDiagnostic: () => {}, onOpenEvidence: () => {},
  }))).frame;
  expect(emptyFrame).toContain("tickmarkr fleet");
  expect(emptyFrame).toContain("tickmarkr plan");

  // Zero tasks: a comparable graph with nothing planned says "no plan", never a hollow 100%.
  const zeroTaskModel = deriveHomeView({ operator: zeroTaskSnapshot, seats: { active: 0, eligible: 0 } });
  expect(zeroTaskModel.comparable).toBe(true);
  expect(zeroTaskModel.planned).toBe(0);
  expect(zeroTaskModel.noPlan).toBe(true);
  expect(zeroTaskModel.progressPercent).toBeUndefined();
  const zeroTaskFrame = (await drawFrame(createElement(HomeView, {
    model: zeroTaskModel, onOpenPark: () => {}, onOpenDiagnostic: () => {}, onOpenEvidence: () => {},
  }))).frame;
  expect(zeroTaskFrame).toContain("no plan");
  expect(zeroTaskFrame).not.toContain("100%");
});

test("Home Needs-you opens the selected park or available diagnostic context and Activity opens the original Evidence line through C1 navigation callbacks, including an early row outside the visible history. Active seats and eligible channels remain distinct counts, absent spend says not measurable and absent trend says no history. A callback with no selected identity or all-subscription telemetry rendered as measured $0 fails.", async () => {
  const resumedModel = deriveHomeView({ operator: resumedSnapshot, seats });
  // Needs-you resolves the selected park from LIVE task state (T2 is running again post-resume;
  // T3 is still blocked), never an invalid/empty identity.
  expect(resumedModel.humanCount).toBe(0);
  expect(resumedModel.blockedCount).toBe(1);
  const target = selectNeedsYouTarget(resumedModel);
  expect(target).toEqual({ kind: "park", id: "T3", label: "T3 blocked" });

  // With no park at all, Needs-you falls back to an available diagnostic context — still a real
  // non-empty identity, never invented.
  const noParkModel = deriveHomeView({
    operator: completeSnapshot, seats,
    diagnostics: [{ kind: "diagnostic", id: "lock-dead-holder", label: "lock: dead holder" }],
  });
  expect(noParkModel.humanCount).toBe(0);
  expect(noParkModel.blockedCount).toBe(0);
  expect(selectNeedsYouTarget(noParkModel)).toEqual({ kind: "diagnostic", id: "lock-dead-holder", label: "lock: dead holder" });
  // A blank-id diagnostic is not a selectable identity.
  const blankDiagnosticModel = deriveHomeView({
    operator: completeSnapshot, seats, diagnostics: [{ kind: "diagnostic", id: "  ", label: "unusable" }],
  });
  expect(selectNeedsYouTarget(blankDiagnosticModel)).toBeUndefined();
  // Nothing needing attention at all: no callback target exists.
  const idleModel = deriveHomeView({ operator: completeSnapshot, seats });
  expect(selectNeedsYouTarget(idleModel)).toBeUndefined();

  // Activity opens the ORIGINAL evidence identity, including a row well outside the initial
  // visible window (paging never recomputes an on-screen ordinal as the identity).
  const longActivity: HomeActivityRow[] = Array.from({ length: HOME_ACTIVITY_VISIBLE_ROWS + 5 }, (_, i) => ({
    evidence: { source: "journal.jsonl", line: 100 - i, id: `journal.jsonl#L${100 - i}` },
    time: `08:${30 + i}:00`, state: "neutral" as const, text: `event ${i}`,
  }));
  const activityModel: HomeViewModel = deriveHomeView({ operator: resumedSnapshot, seats, activity: longActivity });
  const earlyIndex = longActivity.length - 1; // outside the first render's visible window
  expect(selectActivityTarget(activityModel, earlyIndex)).toEqual(longActivity[earlyIndex]!.evidence);
  expect(selectActivityTarget(activityModel, 0)).toEqual(longActivity[0]!.evidence);
  expect(selectActivityTarget(activityModel, 999)).toBeUndefined();

  // Live wiring: PageUp scrolls the window until the early row is on top, then Enter opens it —
  // through the callback C1 supplies, never fabricated.
  const openedEvidence: unknown[] = [];
  const { input, unmount } = await drawFrame(createElement(HomeView, {
    model: activityModel, focused: true,
    onOpenPark: () => {}, onOpenDiagnostic: () => {},
    onOpenEvidence: (evidence) => openedEvidence.push(evidence),
  }));
  input.write("\x1B[C"); // right arrow: focus the activity section
  await wait();
  const pages = Math.ceil(earlyIndex / HOME_ACTIVITY_VISIBLE_ROWS);
  for (let i = 0; i < pages; i++) { input.write("\x1B[5~"); await wait(); } // Page Up
  input.write("\r"); // Enter
  await wait();
  unmount();
  expect(openedEvidence).toHaveLength(1);
  expect(openedEvidence[0]).toEqual(longActivity[earlyIndex]!.evidence);

  // Needs-you never fires with no selected identity: with nothing to open, Enter is a no-op.
  const openedParks: string[] = [];
  const idleFrame = await drawFrame(createElement(HomeView, {
    model: idleModel, focused: true,
    onOpenPark: (id) => openedParks.push(id), onOpenDiagnostic: (id) => openedParks.push(id),
    onOpenEvidence: () => {},
  }));
  idleFrame.input.write("\r");
  await wait();
  idleFrame.unmount();
  expect(openedParks).toEqual([]);

  // Active seats vs eligible channels: two distinct counts, never collapsed into one.
  expect(resumedModel.seats).toEqual({ active: 1, eligible: 3 });
  const seatsFrame = (await drawFrame(createElement(HomeView, {
    model: resumedModel, onOpenPark: () => {}, onOpenDiagnostic: () => {}, onOpenEvidence: () => {},
  }))).frame;
  expect(seatsFrame).toContain("1 active");
  expect(seatsFrame).toContain("3 eligible channels");

  // Absent spend says not measurable; an all-subscription (unmeasurable) fixture can never render
  // as a measured $0, even when the caller's stale `display` field says otherwise.
  const noSpendModel = deriveHomeView({ operator: resumedSnapshot, seats });
  expect(noSpendModel.spend).toEqual({ measurable: false });
  const subscriptionOnlyModel = deriveHomeView({
    operator: resumedSnapshot, seats, spend: { measurable: false, display: "$0" },
  });
  expect(subscriptionOnlyModel.spend).toEqual({ measurable: false });
  const spendFrame = (await drawFrame(createElement(HomeView, {
    model: subscriptionOnlyModel, onOpenPark: () => {}, onOpenDiagnostic: () => {}, onOpenEvidence: () => {},
  }))).frame;
  expect(spendFrame).toContain("not measurable");
  expect(spendFrame).not.toContain("$0");

  // Absent trend says no history rather than a decorative blank sparkline.
  const noTrendFrame = (await drawFrame(createElement(HomeView, {
    model: resumedModel, onOpenPark: () => {}, onOpenDiagnostic: () => {}, onOpenEvidence: () => {},
  }))).frame;
  expect(noTrendFrame).toContain("no history");
  const trendModel = deriveHomeView({
    operator: resumedSnapshot, seats, trend: [1, 2, 3],
    activity: [{ evidence: { source: "journal.jsonl", line: 1, id: "journal.jsonl#L1" }, time: "08:00:00", state: "neutral", text: "event" }],
  });
  const trendFrame = (await drawFrame(createElement(HomeView, {
    model: trendModel, onOpenPark: () => {}, onOpenDiagnostic: () => {}, onOpenEvidence: () => {},
  }))).frame;
  expect(trendFrame.includes("no history")).toBe(false);
});

test("test: arrow keys move a Home Activity selection kept apart from the page window and Enter opens the selected row's original evidence identity for the second, third, fifth and sixth newest rows of a seven-row history, including a row scrolled outside the visible window", async () => {
  const sevenRowActivity: HomeActivityRow[] = Array.from({ length: 7 }, (_, i) => ({
    evidence: { source: "journal.jsonl", line: 100 - i, id: `journal.jsonl#L${100 - i}` },
    time: `08:${30 + i}:00`,
    state: "neutral" as const,
    text: `event ${i}`,
  }));
  const model = deriveHomeView({ operator: resumedSnapshot, seats, activity: sevenRowActivity });

  // Verify in isolated mounts that each required row opens through Enter:
  // second newest (index 1), third newest (index 2), fifth newest (index 4), sixth newest (index 5)
  for (const targetIndex of [1, 2, 4, 5]) {
    const opened: unknown[] = [];
    const { input, unmount } = await drawFrame(createElement(HomeView, {
      model, focused: true,
      onOpenPark: () => {}, onOpenDiagnostic: () => {},
      onOpenEvidence: (ev) => opened.push(ev),
    }));
    input.write("\x1B[C"); // focus activity
    await wait();
    for (let step = 0; step < targetIndex; step++) {
      input.write("\x1B[B"); // move down to target row
      await wait();
    }
    input.write("\r"); // Enter opens selected row
    await wait();
    unmount();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toEqual(sevenRowActivity[targetIndex]!.evidence);
  }

  // Continuous traversal across rows, including rows scrolled outside the 3-row visible window (indices 4 and 5):
  const continuousOpened: unknown[] = [];
  const { input, unmount } = await drawFrame(createElement(HomeView, {
    model, focused: true,
    onOpenPark: () => {}, onOpenDiagnostic: () => {},
    onOpenEvidence: (ev) => continuousOpened.push(ev),
  }));
  input.write("\x1B[C");
  await wait();
  // 2nd newest row (index 1):
  input.write("\x1B[B"); await wait();
  input.write("\r"); await wait();
  expect(continuousOpened[0]).toEqual(sevenRowActivity[1]!.evidence);
  // 3rd newest row (index 2):
  input.write("\x1B[B"); await wait();
  input.write("\r"); await wait();
  expect(continuousOpened[1]).toEqual(sevenRowActivity[2]!.evidence);
  // 5th newest row (index 4, outside visible window 0..2):
  input.write("\x1B[B"); await wait();
  input.write("\x1B[B"); await wait();
  input.write("\r"); await wait();
  expect(continuousOpened[2]).toEqual(sevenRowActivity[4]!.evidence);
  // 6th newest row (index 5, outside visible window 0..2):
  input.write("\x1B[B"); await wait();
  input.write("\r"); await wait();
  expect(continuousOpened[3]).toEqual(sevenRowActivity[5]!.evidence);
  unmount();
});

test("test: Needs-you moves its selection across every listed park and diagnostic and Enter opens the selected one through its own callback, so with three targets the second and third open by their own ids and not the first", async () => {
  const threeTargetModel = deriveHomeView({
    operator: partialSnapshot, // has T2 human, T3 blocked
    seats,
    diagnostics: [{ kind: "diagnostic", id: "lock-dead-holder", label: "lock: dead holder" }],
  });
  expect(threeTargetModel.needsYou).toHaveLength(3);
  expect(threeTargetModel.needsYou[0]!.id).toBe("T2");
  expect(threeTargetModel.needsYou[1]!.id).toBe("T3");
  expect(threeTargetModel.needsYou[2]!.id).toBe("lock-dead-holder");

  const openedParks: string[] = [];
  const openedDiagnostics: string[] = [];
  const { input, unmount } = await drawFrame(createElement(HomeView, {
    model: threeTargetModel,
    focused: true,
    onOpenPark: (id) => openedParks.push(id),
    onOpenDiagnostic: (id) => openedDiagnostics.push(id),
    onOpenEvidence: () => {},
  }));

  // Initial selection is target 0 ("T2"). Move down to second target ("T3", a park):
  input.write("\x1B[B");
  await wait();
  input.write("\r");
  await wait();
  expect(openedParks).toEqual(["T3"]);
  expect(openedDiagnostics).toEqual([]);

  // Move down to third target ("lock-dead-holder", a diagnostic):
  input.write("\x1B[B");
  await wait();
  input.write("\r");
  await wait();
  expect(openedParks).toEqual(["T3"]);
  expect(openedDiagnostics).toEqual(["lock-dead-holder"]);

  // Cycle to next target (cycles back to first target "T2"):
  input.write("\x1B[B");
  await wait();
  input.write("\r");
  await wait();
  expect(openedParks).toEqual(["T3", "T2"]);
  expect(openedDiagnostics).toEqual(["lock-dead-holder"]);

  unmount();
});

describe("home-view model", () => {
  test("needsYou always carries a non-empty id for every listed target", () => {
    const model = deriveHomeView({ operator: partialSnapshot, seats });
    for (const item of model.needsYou) expect(item.id.trim().length).toBeGreaterThan(0);
  });
});
test("Needs-you selection reconciles against model updates: when Needs-you shrinks past selection index, label remains visible and Enter opens the valid target", async () => {
  const initialModel = deriveHomeView({
    operator: partialSnapshot, // T2, T3
    seats,
    diagnostics: [{ kind: "diagnostic", id: "lock-dead-holder", label: "lock: dead holder" }],
  });
  const openedParks: string[] = [];
  const openedDiagnostics: string[] = [];
  const reported: Array<{ target: HomeNeedsYouTarget | undefined; index: number }> = [];

  const h = await mountHome(initialModel, {
    onOpenPark: (id) => openedParks.push(id),
    onOpenDiagnostic: (id) => openedDiagnostics.push(id),
    onSelectNeedsYou: (target, index) => reported.push({ target, index }),
  });

  // Initial selection is index 0 ("T2 human")
  expect(h.frame()).toContain("T2 human");

  // Move down twice to select target index 2 ("lock: dead holder")
  h.input.write("\x1B[B");
  await wait();
  h.input.write("\x1B[B");
  await wait();
  expect(h.frame()).toContain("lock: dead holder");

  // Model shrinks to 2 targets: diagnostic is resolved/cleared, only T2 and T3 remain
  const shrunkModel = deriveHomeView({
    operator: partialSnapshot,
    seats,
  });
  await h.rerender(shrunkModel);

  // The label must NOT disappear, and Enter must NOT be a no-op; it clamps/reconciles to T3 blocked
  expect(h.frame()).toContain("T3 blocked");
  h.input.write("\r");
  await wait();
  expect(openedParks).toEqual(["T3"]);
  expect(openedDiagnostics).toEqual([]);

  // Model shrinks further to 1 target: T2 only
  const singleTargetModel = deriveHomeView({
    operator: {
      ...partialSnapshot,
      tasks: [
        { id: "T1", state: "done", gates: { build: { state: "pass" }, test: { state: "pass" }, lint: { state: "pass" }, evidence: { state: "pass" }, scope: { state: "pass" }, acceptance: { state: "pass" }, review: { state: "pass" } } },
        { id: "T2", state: "human", gates: { build: { state: "pass" }, test: { state: "pass" }, lint: { state: "pass" }, evidence: { state: "pass" }, scope: { state: "pass" }, acceptance: { state: "pass" }, review: { state: "pass" } } },
      ],
    },
    seats,
  });
  await h.rerender(singleTargetModel);
  expect(h.frame()).toContain("T2 human");
  h.input.write("\r");
  await wait();
  expect(openedParks).toEqual(["T3", "T2"]);

  h.unmount();
});

test("Activity selection reconciles by stable evidence identity when new activity is prepended", async () => {
  const row0: HomeActivityRow = { evidence: { source: "journal.jsonl", line: 100, id: "journal.jsonl#L100" }, time: "08:00:00", state: "neutral", text: "event 100" };
  const row1: HomeActivityRow = { evidence: { source: "journal.jsonl", line: 99, id: "journal.jsonl#L99" }, time: "08:01:00", state: "neutral", text: "event 99" };
  const row2: HomeActivityRow = { evidence: { source: "journal.jsonl", line: 98, id: "journal.jsonl#L98" }, time: "08:02:00", state: "neutral", text: "event 98" };

  const initialModel = deriveHomeView({ operator: resumedSnapshot, seats, activity: [row0, row1, row2] });
  const opened: unknown[] = [];
  const h = await mountHome(initialModel, {
    onOpenEvidence: (ev) => opened.push(ev),
  });

  h.input.write("\x1B[C"); // focus activity
  await wait();
  h.input.write("\x1B[B"); // select row1 (event 99)
  await wait();

  // Verify row1 is selected
  expect(h.frame()).toContain(`${GLYPHS.pointer} event 99`);

  // New row is prepended at index 0 (as journal writes new chronological events)
  const rowNew: HomeActivityRow = { evidence: { source: "journal.jsonl", line: 101, id: "journal.jsonl#L101" }, time: "08:03:00", state: "neutral", text: "event 101" };
  const updatedModel = deriveHomeView({ operator: resumedSnapshot, seats, activity: [rowNew, row0, row1, row2] });
  await h.rerender(updatedModel);

  // Selection must still be on event 99 (now at index 2), NOT silently retargeted to event 100
  expect(h.frame()).toContain(`${GLYPHS.pointer} event 99`);
  expect(h.frame()).not.toContain(`${GLYPHS.pointer} event 100`);

  h.input.write("\r");
  await wait();
  expect(opened).toEqual([row1.evidence]);

  h.unmount();
});


test("test: a down arrow followed at once by Enter on the needs you section opens the second park when no frame was drawn between the keys, so a handler acting on the previous render's selection fails", async () => {
  const model = deriveHomeView({ operator: partialSnapshot, seats });
  const opened: string[] = [];
  const h = await mountHome(model, { onOpenPark: id => opened.push(id) });
  try {
    expect(h.frame()).toContain("T2 human");
    // No wait or render between the navigation and activation.
    h.input.write("\x1B[B"); h.input.write("\r");
    await wait(50);
    expect(opened).toEqual(["T3"]);
    expect(h.frame()).toContain("T3 blocked");
    expect(h.frame()).not.toContain("T2 human");
  } finally { h.unmount(); }
});

test("test: a right arrow then a down arrow then Enter written in one tick opens the second activity row's evidence, so a handler that still targets the needs you section fails", async () => {
  const activity: HomeActivityRow[] = [100, 97].map(line => ({
    evidence: { source: "journal.jsonl", line, id: `journal.jsonl#L${line}` },
    time: "08:00:00", state: "neutral", text: `event ${line}`,
  }));
  const model = deriveHomeView({ operator: partialSnapshot, seats, activity });
  const opened: EvidenceIdentity[] = [];
  const parks: string[] = [];
  const h = await mountHome(model, {
    onOpenPark: id => parks.push(id),
    onOpenEvidence: evidence => opened.push(evidence),
  });
  try {
    expect(h.frame()).toContain("T2 human");
    h.input.write("\x1B[C"); h.input.write("\x1B[B"); h.input.write("\r");
    await wait(50);
    expect(opened).toEqual([activity[1]!.evidence]);
    expect(parks).toEqual([]);
    expect(h.frame()).toContain(`${GLYPHS.pointer} event 97`);
    expect(h.frame()).not.toContain(`${GLYPHS.pointer} event 100`);
    expect(h.frame()).toContain("T2 human");
  } finally { h.unmount(); }
});

test("test: two down arrows written in one tick across three parks select the third park, so a handler that steps once from a stale index fails", async () => {
  const model = deriveHomeView({
    operator: {
      ...partialSnapshot,
      tasks: partialSnapshot.tasks.map(task => ({ ...task, state: "human" as const })),
    },
    seats,
  });
  expect(model.needsYou.map(target => target.id)).toEqual(["T1", "T2", "T3"]);
  const opened: string[] = [];
  const h = await mountHome(model, { onOpenPark: id => opened.push(id) });
  try {
    expect(h.frame()).toContain(model.needsYou[0]!.label);
    h.input.write("\x1B[B"); h.input.write("\x1B[B"); h.input.write("\r");
    await wait(50);
    expect(opened).toEqual(["T3"]);
    expect(h.frame()).toContain(model.needsYou[2]!.label);
    expect(h.frame()).not.toContain(model.needsYou[1]!.label);
  } finally { h.unmount(); }
});
