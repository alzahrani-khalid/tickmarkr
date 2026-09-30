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
  // Frame delivery control: once a production frame satisfies `holdFrom`, it and every later frame are held
  // back from `writes` until `release()` delivers them in order. Rendering itself is never touched.
  const held: string[] = [];
  let holdFrom: ((frame: string) => boolean) | undefined;
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const frame = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (holdFrom && (held.length > 0 || holdFrom(stripAnsi(frame)))) held.push(frame); else writes.push(frame);
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;
  const hold = (from: (frame: string) => boolean) => { holdFrom = from; };
  const release = () => { holdFrom = undefined; const delivered = held.splice(0); writes.push(...delivered); return delivered.map(stripAnsi); };
  const holding = () => held.length;
  return { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, writes, hold, release, holding };
}

/** Upper bound on any wait for a production frame; a poll that reaches it rejects with the last frame drawn. */
const FRAME_POLL_MS = 2000;
const tick = () => new Promise((r) => setTimeout(r, 5));
/** Poll the production frames until `settled` holds; never a fixed sleep. Rejects at the bound with the last frame. */
async function untilFrame(frame: () => string, settled: (frame: string) => boolean, want: string, timeoutMs = FRAME_POLL_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = frame();
    if (settled(current)) return current;
    if (Date.now() >= deadline) throw new Error(`frame never reached ${want} within ${timeoutMs} ms; last frame:\n${current}`);
    await tick();
  }
}
const shows = (text: string) => (frame: string) => frame.includes(text);

/** Mount `node` and wait for its first frame; keys and rerenders then wait for the frame they produce. */
async function mountFrame(node: ReactElement) {
  const { input, output, writes, hold, release, holding } = makeInkStreams();
  const app = render(node, { stdin: input, stdout: output, exitOnCtrlC: false, patchConsole: false, debug: true });
  const frame = () => stripAnsi(writes.at(-1) ?? "");
  const until = (settled: (frame: string) => boolean, want: string, timeoutMs?: number) => untilFrame(frame, settled, want, timeoutMs);
  /** Write a key and wait for the frame it produces: the requested text when known, otherwise any new frame. */
  const key = async (bytes: string, settled?: (frame: string) => boolean, want = "a new frame") => {
    const drawn = writes.length;
    input.write(bytes);
    return until(settled ?? (() => writes.length > drawn), `${want} after ${JSON.stringify(bytes)}`);
  };
  /** Wait for a callback or other non-frame observation; the failure still carries the last frame. */
  const untilCall = (done: () => boolean, want: string, timeoutMs?: number) => until(() => done(), want, timeoutMs);
  await until((f) => f.length > 0, "a first frame");
  return {
    frame, input, key, until, untilCall, hold, release, holding,
    frames: () => writes.map(stripAnsi),
    rerender: async (next: ReactElement, settled: (frame: string) => boolean, want: string) => {
      app.rerender(next);
      await until(settled, want);
    },
    unmount: () => app.unmount(),
  };
}

async function drawFrame(node: ReactElement) {
  const mounted = await mountFrame(node);
  return { ...mounted, frame: mounted.frame() };
}
async function mountHome(initialModel: HomeViewModel, handlers?: {
  onOpenPark?: (id: string) => void;
  onOpenDiagnostic?: (id: string) => void;
  onOpenEvidence?: (ev: EvidenceIdentity) => void;
  onSelectNeedsYou?: (target: HomeNeedsYouTarget | undefined, index: number) => void;
}) {
  const home = (model: HomeViewModel) => createElement(HomeView, {
    model,
    focused: true,
    onOpenPark: handlers?.onOpenPark ?? (() => {}),
    onOpenDiagnostic: handlers?.onOpenDiagnostic ?? (() => {}),
    onOpenEvidence: handlers?.onOpenEvidence ?? (() => {}),
    onSelectNeedsYou: handlers?.onSelectNeedsYou,
  });
  const mounted = await mountFrame(home(initialModel));
  return {
    ...mounted,
    rerender: (nextModel: HomeViewModel, settled: (frame: string) => boolean, want: string) => mounted.rerender(home(nextModel), settled, want),
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
  const paged = await drawFrame(createElement(HomeView, {
    model: activityModel, focused: true,
    onOpenPark: () => {}, onOpenDiagnostic: () => {},
    onOpenEvidence: (evidence) => openedEvidence.push(evidence),
  }));
  await paged.key("\x1B[C"); // right arrow: focus the activity section
  const pages = Math.ceil(earlyIndex / HOME_ACTIVITY_VISIBLE_ROWS);
  for (let i = 0; i < pages; i++) await paged.key("\x1B[5~"); // Page Up
  paged.input.write("\r"); // Enter
  await paged.untilCall(() => openedEvidence.length === 1, "the opened evidence callback");
  paged.unmount();
  expect(openedEvidence).toHaveLength(1);
  expect(openedEvidence[0]).toEqual(longActivity[earlyIndex]!.evidence);

  // Needs-you never fires with no selected identity: with nothing to open, Enter is a no-op.
  const openedParks: string[] = [];
  const idleFrame = await drawFrame(createElement(HomeView, {
    model: idleModel, focused: true,
    onOpenPark: (id) => openedParks.push(id), onOpenDiagnostic: (id) => openedParks.push(id),
    onOpenEvidence: () => {},
  }));
  // A no-op Enter draws nothing new: give the callback the same bounded window a real one gets, expecting silence.
  idleFrame.input.write("\r");
  await expect(idleFrame.untilCall(() => openedParks.length > 0, "a park callback", 100)).rejects.toThrow(/never reached a park callback/);
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

  // A down arrow waits for the frame it produces: the drawn pointer while the row is inside the 3-row window,
  // otherwise the next frame — the selection is kept apart from the page window, so it is not drawn there.
  const downTo = (h: { key: (bytes: string, settled?: (frame: string) => boolean, want?: string) => Promise<string> }, index: number) =>
    index < HOME_ACTIVITY_VISIBLE_ROWS
      ? h.key("\x1B[B", shows(`${GLYPHS.pointer} event ${index}`), `the pointer on event ${index}`)
      : h.key("\x1B[B");
  // Verify in isolated mounts that each required row opens through Enter:
  // second newest (index 1), third newest (index 2), fifth newest (index 4), sixth newest (index 5)
  for (const targetIndex of [1, 2, 4, 5]) {
    const opened: unknown[] = [];
    const h = await drawFrame(createElement(HomeView, {
      model, focused: true,
      onOpenPark: () => {}, onOpenDiagnostic: () => {},
      onOpenEvidence: (ev) => opened.push(ev),
    }));
    await h.key("\x1B[C"); // focus activity
    for (let step = 1; step <= targetIndex; step++) await downTo(h, step); // move down to target row
    h.input.write("\r"); // Enter opens selected row
    await h.untilCall(() => opened.length === 1, "the opened evidence callback");
    h.unmount();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toEqual(sevenRowActivity[targetIndex]!.evidence);
  }

  // Continuous traversal across rows, including rows scrolled outside the 3-row visible window (indices 4 and 5):
  const continuousOpened: unknown[] = [];
  const h = await drawFrame(createElement(HomeView, {
    model, focused: true,
    onOpenPark: () => {}, onOpenDiagnostic: () => {},
    onOpenEvidence: (ev) => continuousOpened.push(ev),
  }));
  await h.key("\x1B[C");
  const down = (index: number) => downTo(h, index);
  const enter = (opens: number) => { h.input.write("\r"); return h.untilCall(() => continuousOpened.length === opens, `open #${opens}`); };
  // 2nd newest row (index 1):
  await down(1); await enter(1);
  expect(continuousOpened[0]).toEqual(sevenRowActivity[1]!.evidence);
  // 3rd newest row (index 2):
  await down(2); await enter(2);
  expect(continuousOpened[1]).toEqual(sevenRowActivity[2]!.evidence);
  // 5th newest row (index 4, outside visible window 0..2):
  await down(3); await down(4); await enter(3);
  expect(continuousOpened[2]).toEqual(sevenRowActivity[4]!.evidence);
  // 6th newest row (index 5, outside visible window 0..2):
  await down(5); await enter(4);
  expect(continuousOpened[3]).toEqual(sevenRowActivity[5]!.evidence);
  h.unmount();
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
  const h = await drawFrame(createElement(HomeView, {
    model: threeTargetModel,
    focused: true,
    onOpenPark: (id) => openedParks.push(id),
    onOpenDiagnostic: (id) => openedDiagnostics.push(id),
    onOpenEvidence: () => {},
  }));
  const enter = (opens: number) => { h.input.write("\r"); return h.untilCall(() => openedParks.length + openedDiagnostics.length === opens, `open #${opens}`); };

  // Initial selection is target 0 ("T2"). Move down to second target ("T3", a park):
  await h.key("\x1B[B", shows("T3 blocked"), "the pointer on T3");
  await enter(1);
  expect(openedParks).toEqual(["T3"]);
  expect(openedDiagnostics).toEqual([]);

  // Move down to third target ("lock-dead-holder", a diagnostic):
  await h.key("\x1B[B", shows("lock: dead holder"), "the pointer on the diagnostic");
  await enter(2);
  expect(openedParks).toEqual(["T3"]);
  expect(openedDiagnostics).toEqual(["lock-dead-holder"]);

  // Cycle to next target (cycles back to first target "T2"):
  await h.key("\x1B[B", shows("T2 human"), "the pointer on T2");
  await enter(3);
  expect(openedParks).toEqual(["T3", "T2"]);
  expect(openedDiagnostics).toEqual(["lock-dead-holder"]);

  h.unmount();
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
  await h.key("\x1B[B", shows("T3 blocked"), "the pointer on T3");
  await h.key("\x1B[B", shows("lock: dead holder"), "the pointer on the diagnostic");
  expect(h.frame()).toContain("lock: dead holder");

  // Model shrinks to 2 targets: diagnostic is resolved/cleared, only T2 and T3 remain
  const shrunkModel = deriveHomeView({
    operator: partialSnapshot,
    seats,
  });
  await h.rerender(shrunkModel, (f) => !f.includes("lock: dead holder"), "the frame without the cleared diagnostic");

  // The label must NOT disappear, and Enter must NOT be a no-op; it clamps/reconciles to T3 blocked
  expect(h.frame()).toContain("T3 blocked");
  h.input.write("\r");
  await h.untilCall(() => openedParks.length === 1, "the first park callback");
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
  await h.rerender(singleTargetModel, (f) => !f.includes("T3 blocked"), "the frame without the merged T3");
  expect(h.frame()).toContain("T2 human");
  h.input.write("\r");
  await h.untilCall(() => openedParks.length === 2, "the second park callback");
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

  await h.key("\x1B[C"); // focus activity
  await h.key("\x1B[B", shows(`${GLYPHS.pointer} event 99`), "the pointer on event 99"); // select row1 (event 99)

  // Verify row1 is selected
  expect(h.frame()).toContain(`${GLYPHS.pointer} event 99`);

  // New row is prepended at index 0 (as journal writes new chronological events)
  const rowNew: HomeActivityRow = { evidence: { source: "journal.jsonl", line: 101, id: "journal.jsonl#L101" }, time: "08:03:00", state: "neutral", text: "event 101" };
  const updatedModel = deriveHomeView({ operator: resumedSnapshot, seats, activity: [rowNew, row0, row1, row2] });
  await h.rerender(updatedModel, shows("event 101"), "the prepended row");

  // Selection must still be on event 99 (now at index 2), NOT silently retargeted to event 100
  expect(h.frame()).toContain(`${GLYPHS.pointer} event 99`);
  expect(h.frame()).not.toContain(`${GLYPHS.pointer} event 100`);

  h.input.write("\r");
  await h.untilCall(() => opened.length === 1, "the opened evidence callback");
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
    await h.until((f) => opened.length === 1 && f.includes("T3 blocked"), "the park callback and the pointer on T3");
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
    await h.until((f) => opened.length === 1 && f.includes(`${GLYPHS.pointer} event 97`), "the evidence callback and the pointer on event 97");
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
    await h.until((f) => opened.length === 1 && f.includes(model.needsYou[2]!.label), "the park callback and the pointer on the third park");
    expect(opened).toEqual(["T3"]);
    expect(h.frame()).toContain(model.needsYou[2]!.label);
    expect(h.frame()).not.toContain(model.needsYou[1]!.label);
  } finally { h.unmount(); }
});

test("test: home-view key cases reach their expected final frames when each key's second render is delayed past the former fixed sleep while a view that never renders rejects at the bounded poll", async () => {
  const FORMER_FIXED_SLEEP_MS = 20;
  const activity: HomeActivityRow[] = [100, 99, 98].map(line => ({
    evidence: { source: "journal.jsonl", line, id: `journal.jsonl#L${line}` },
    time: "08:00:00", state: "neutral", text: `event ${line}`,
  }));
  // Only the seat count differs between these models, so a seats update is a production frame that never
  // shows a key's requested view.
  const withSeats = (active: number) => deriveHomeView({
    operator: partialSnapshot, seats: { active, eligible: 3 }, activity,
    diagnostics: [{ kind: "diagnostic", id: "lock-dead-holder", label: "lock: dead holder" }],
  });
  const opened: string[] = [];
  const evidence: EvidenceIdentity[] = [];
  const h = await mountHome(withSeats(1), { onOpenPark: id => opened.push(id), onOpenDiagnostic: id => opened.push(id), onOpenEvidence: e => evidence.push(e) });
  /** Resolves "pending" or "settled" after `ms`, without ever settling `wait` itself. */
  const stateAfter = (wait: Promise<unknown>, ms: number) =>
    Promise.race([wait.then(() => "settled" as const), new Promise<"pending">(r => setTimeout(() => r("pending"), ms))]);
  const cases: Array<{ key: string; expected: string }> = [
    { key: "\x1B[B", expected: "T3 blocked" },
    { key: "\x1B[B", expected: "lock: dead holder" },
    { key: "\x1B[B", expected: "T2 human" },
    { key: "\x1B[C", expected: `${GLYPHS.pointer} event 100` },
    { key: "\x1B[B", expected: `${GLYPHS.pointer} event 99` },
    { key: "\x1B[B", expected: `${GLYPHS.pointer} event 98` },
  ];
  try {
    for (const [i, { key, expected }] of cases.entries()) {
      expect(h.frame()).not.toContain(expected);
      const drawn = h.frames().length;
      // The key is delivered at once through the navigation helper. Before it is handled, a seats update
      // draws a nonmatching production frame AFTER the key; the key's second render, the one showing the
      // requested view, is then held back past the former fixed sleep.
      h.hold(shows(expected));
      const wait = h.key(key, shows(expected), expected);
      const seatsText = `${i + 2} active`;
      await h.rerender(withSeats(i + 2), shows(seatsText), seatsText);
      const intermediate = h.frame();
      expect(h.frames().length).toBeGreaterThan(drawn); // a helper returning on any new frame would stop here
      expect(intermediate).toContain(seatsText);
      expect(intermediate).not.toContain(expected);
      await h.untilCall(() => h.holding() > 0, `the held render showing ${expected}`);
      // The final frame exists but is held: key() stays pending on the intermediate frame past the former sleep.
      expect(await stateAfter(wait, FORMER_FIXED_SLEEP_MS * 2)).toBe("pending");
      expect(h.frame()).toBe(intermediate);
      const released = h.release();
      expect(released.at(-1)).toContain(expected);
      expect(released.at(-1)).toContain(seatsText); // drawn after the intermediate frame, not before it
      const settled = await wait;
      expect(settled).toContain(expected);
      expect(settled).toBe(h.frame());
    }
    h.input.write("\r");
    await h.untilCall(() => evidence.length === 1, "the opened evidence callback");
    expect(evidence).toEqual([activity[2]!.evidence]);
    expect(opened).toEqual([]);
    // A view that never renders: no key produces a fourth activity row, so the poll rejects at its bound.
    await expect(h.until(shows(`${GLYPHS.pointer} event 97`), "a fourth row", 80)).rejects.toThrow(/never reached a fourth row within 80 ms; last frame:/);
  } finally { h.unmount(); }
});
