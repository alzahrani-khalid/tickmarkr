import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { GLYPHS } from "../../src/brand.js";
import { loadDemoCaptures } from "../../src/tui/cockpit/demo.js";
import {
  dispatchRunKey,
  dispatchRunSurfaceKey,
  initialRunInteractionState,
  openingRunInteractionState,
  openingRunSurfaceState,
  RUN_INPUT_BINDINGS,
  RUN_KEY_BINDINGS,
  selectableRunViewRowIds,
  type RunInteractionState,
  type RunKeyBinding,
  type RunKeyEvent,
  type RunSurfaceState,
} from "../../src/tui/cockpit/keys.js";
import { COCKPIT_COLUMN_FLOOR } from "../../src/tui/cockpit/layout.js";
import {
  deriveRunCockpitData,
  deriveRunViewRows,
  RunCockpitFrame,
  type RunCockpitData,
} from "../../src/tui/cockpit/run-cockpit.js";

const stripAnsi = (value: string): string =>
  value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function draw(node: ReactNode, columns = 140, rows = 40): Promise<string> {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;

  let painted!: () => void;
  const firstPaint = new Promise<void>((resolve) => {
    painted = resolve;
  });
  const app = render(node, {
    stdout: output as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    onRender: painted,
  });
  await firstPaint;
  const frame = stripAnsi(writes.at(-1) ?? "");
  app.unmount();
  return frame;
}

const RUN_DATA: RunCockpitData = (() => {
  const source = loadDemoCaptures().journals.find((journal) =>
    journal.fileName === "run-20260724-231138.journal.jsonl"
  );
  if (!source) throw new Error("healthy cockpit capture is missing");
  return deriveRunCockpitData(source, "0.0.0-test");
})();

const frame = (interaction: RunInteractionState, data = RUN_DATA) =>
  draw(createElement(RunCockpitFrame, {
    data,
    columns: 140,
    rows: 40,
    interaction,
  }));

/** The same frame at the terminal the caller names — the floor included. */
const frameAt = (interaction: RunInteractionState, columns: number, rows: number) =>
  draw(
    createElement(RunCockpitFrame, { data: RUN_DATA, columns, rows, interaction }),
    columns,
    rows,
  );

const EVENTS = {
  down: { input: "", key: { downArrow: true } },
  open: { input: "", key: { return: true } },
  back: { input: "", key: { leftArrow: true } },
  escape: { input: "", key: { escape: true } },
  right: { input: "", key: { rightArrow: true } },
  tab: { input: "", key: { tab: true } },
  filter: { input: "/", key: {} },
  follow: { input: "f", key: {} },
  help: { input: "?", key: {} },
  quit: { input: "q", key: {} },
} as const satisfies Record<string, RunKeyEvent>;

function send(
  state: RunInteractionState,
  event: RunKeyEvent,
  bindings: readonly RunKeyBinding[] = RUN_INPUT_BINDINGS,
  columns?: number,
): RunInteractionState {
  // The rows the active view's own derivation produces, supplied the way the
  // live surface supplies them — a key that acts on a row needs the collection.
  const rowIds = selectableRunViewRowIds(
    state.activeView,
    deriveRunViewRows(RUN_DATA, state.activeView, state.filterQuery)
      .map((row) => row.id),
  );
  return dispatchRunKey(event, state, bindings, rowIds, columns) ?? state;
}

/** The whole-surface twin of send: both tabs, each keeping its own state. */
function sendSurface(
  surface: RunSurfaceState,
  event: RunKeyEvent,
  columns?: number,
): RunSurfaceState {
  const rowIds = selectableRunViewRowIds(
    surface.interaction.activeView,
    deriveRunViewRows(
      RUN_DATA,
      surface.interaction.activeView,
      surface.interaction.filterQuery,
    ).map((row) => row.id),
  );
  return dispatchRunSurfaceKey(
    event,
    surface,
    RUN_INPUT_BINDINGS,
    rowIds,
    columns,
  ) ?? surface;
}

function withInteractionFields(
  overrides: Record<string, unknown> = {},
): RunInteractionState {
  return { ...initialRunInteractionState(), ...overrides } as RunInteractionState;
}

describe("run cockpit views", () => {
  test("test: moving the selection while the rail is focused redraws the rail's pointer on the newly selected view, and removing that handler makes this assertion fail", async () => {
    const assertion = async (bindings: readonly RunKeyBinding[]) => {
      const focused = withInteractionFields({ panel: 1, railSelection: 0 });
      const before = await frame(focused);
      const after = await frame(send(focused, EVENTS.down, bindings));
      expect(after).not.toBe(before);
      expect(after).toContain(`${GLYPHS.pointer} Tasks`);
      expect(after).not.toContain(`${GLYPHS.pointer} Run`);
    };

    await expect(assertion(RUN_KEY_BINDINGS)).resolves.toBeUndefined();
    await expect(assertion(
      RUN_KEY_BINDINGS.filter((binding) => binding.key !== "↑↓"),
    )).rejects.toThrow();
  });

  test("test: opening the selected view from the rail redraws the main region as that view rather than as the overview, and removing that handler makes this assertion fail", async () => {
    const assertion = async (bindings: readonly RunKeyBinding[]) => {
      const selected = withInteractionFields({ panel: 1, railSelection: 1 });
      const opened = send(selected, EVENTS.open, bindings);
      const drawn = await frame(opened);
      expect(drawn).toContain(`${GLYPHS.pointer} TASKS`);
      expect(drawn).not.toContain("PROGRESS");
    };

    await expect(assertion(RUN_KEY_BINDINGS)).resolves.toBeUndefined();
    await expect(assertion(
      RUN_KEY_BINDINGS.filter((binding) => binding.key !== "⏎"),
    )).rejects.toThrow();
  });

  test("test: each of the five number keys draws its own view in the main region, and a number key with no view draws no change", async () => {
    const initial = initialRunInteractionState();
    const expectedTitles = ["RUN", "TASKS", "GATES", "JOURNAL", "FLEET"];
    const drawn: string[] = [];
    for (const [index, title] of expectedTitles.entries()) {
      const selected = send(initial, { input: String(index + 1), key: {} });
      const output = await frame(selected);
      expect(output).toContain(`${GLYPHS.pointer} ${title}`);
      drawn.push(output);
    }
    expect(new Set(drawn).size).toBe(expectedTitles.length);
    expect(await frame(send(initial, { input: "6", key: {} })))
      .toBe(await frame(initial));
  });

  test("test: the surface opens with the watch tab active and the sidebar focused, so the first arrow key moves the view selection and nothing else", async () => {
    const opening = openingRunInteractionState();
    expect(opening.tab).toBe("watch");
    const opened = await frame(opening);
    expect(opened).toContain(`${GLYPHS.pointer} VIEWS`);
    expect(opened).toContain(`${GLYPHS.pointer} Run`);

    // The very first arrow key moves the view selection — nothing else in the
    // state, and nothing else in the frame, changes with it.
    const moved = send(opening, EVENTS.down);
    expect(moved).toEqual({ ...opening, railSelection: 1 });
    const movedFrame = await frame(moved);
    expect(movedFrame).toContain(`${GLYPHS.pointer} Tasks`);
    expect(movedFrame).not.toContain(`${GLYPHS.pointer} Run`);
    // The view drawn in the body is still the one the surface opened on: the
    // sidebar's selection moved, the surface behind it did not.
    expect(movedFrame).toContain("PROGRESS");

    // A width that hides the sidebar cannot leave the opening arrow inert:
    // focus resolves against the effective width, the first arrow moves the
    // same view selection, and the body — the only place the selection can
    // show there — follows it.
    const floored = send(opening, EVENTS.down, RUN_INPUT_BINDINGS, COCKPIT_COLUMN_FLOOR);
    expect(floored).toEqual({ ...opening, railSelection: 1, activeView: "tasks" });
    const flooredFrame = await frameAt(floored, COCKPIT_COLUMN_FLOOR, 24);
    expect(flooredFrame).toContain("TASKS");
    expect(flooredFrame).not.toBe(await frameAt(opening, COCKPIT_COLUMN_FLOOR, 24));
    // And the surface's own switch is offered and acts at that width too.
    const tabbed = send(opening, EVENTS.tab, RUN_INPUT_BINDINGS, COCKPIT_COLUMN_FLOOR);
    expect(tabbed.tab).toBe("setup");
    expect(await frameAt(tabbed, COCKPIT_COLUMN_FLOOR, 24))
      .not.toBe(await frameAt(opening, COCKPIT_COLUMN_FLOOR, 24));
  });

  test("test: entering the selected view's rows with enter or the right arrow and backing out with escape or the left arrow returns focus to the sidebar with the same view selected, and each number key jumps straight to its view", async () => {
    const opening = openingRunInteractionState();
    const selected = send(opening, EVENTS.down);
    const railFrame = await frame(selected);

    for (const enter of [EVENTS.open, EVENTS.right] as const) {
      const entered = send(selected, enter);
      expect(entered.activeView).toBe("tasks");
      const enteredFrame = await frame(entered);
      expect(enteredFrame).toContain(`${GLYPHS.pointer} TASKS`);
      expect(enteredFrame).not.toContain(`${GLYPHS.pointer} VIEWS`);

      for (const leave of [EVENTS.escape, EVENTS.back] as const) {
        const backedOut = send(entered, leave);
        // The same view stays selected in the sidebar, and the sidebar is what
        // holds focus again.
        expect(backedOut.railSelection).toBe(1);
        expect(backedOut.activeView).toBe("tasks");
        const backedFrame = await frame(backedOut);
        expect(backedFrame).toContain(`${GLYPHS.pointer} VIEWS`);
        expect(backedFrame).toContain(`${GLYPHS.pointer} Tasks`);
        expect(backedFrame).not.toContain(`${GLYPHS.pointer} TASKS`);
      }
    }
    expect(railFrame).toContain(`${GLYPHS.pointer} Tasks`);

    // And a number key skips the walk entirely: one press opens its own view.
    for (const [index, title] of ["RUN", "TASKS", "GATES", "JOURNAL", "FLEET"].entries()) {
      const jumped = send(opening, { input: String(index + 1), key: {} });
      expect(jumped.railSelection).toBe(index);
      expect(jumped.activeView).toBe(
        ["run", "tasks", "gates", "journal", "fleet"][index],
      );
      expect(await frame(jumped)).toContain(`${GLYPHS.pointer} ${title}`);
    }

    // A digit names a view, and it names the same view on every tab: pressed
    // on the tab that holds sections rather than views, it is not swallowed
    // and not reinterpreted — it switches to the views' tab and lands on the
    // view it numbers, while setup waits behind with its state untouched.
    let onSetup = sendSurface(openingRunSurfaceState(), EVENTS.tab);
    expect(onSetup.interaction.tab).toBe("setup");
    // Give setup a state of its own, so the round trip has something to keep.
    onSetup = sendSurface(onSetup, EVENTS.down);
    expect(onSetup.interaction.railSelection).toBe(1);
    for (const [index, digit] of ["1", "2", "3", "4", "5"].entries()) {
      const jumped = sendSurface(onSetup, { input: digit, key: {} });
      expect(jumped.interaction.tab, digit).toBe("watch");
      expect(jumped.interaction.railSelection, digit).toBe(index);
      expect(jumped.interaction.activeView, digit).toBe(
        ["run", "tasks", "gates", "journal", "fleet"][index],
      );
      // The tab left behind kept everything it had.
      expect(jumped.stashed, digit).toEqual(onSetup.interaction);
      expect(await frame(jumped.interaction), digit).toContain(
        `${GLYPHS.pointer} ${["RUN", "TASKS", "GATES", "JOURNAL", "FLEET"][index]}`,
      );
      // And the round trip returns to setup exactly as it was left.
      const returned = sendSurface(jumped, EVENTS.tab);
      expect(returned.interaction, digit).toEqual(onSetup.interaction);
    }
  });

  test("test: backing out of a detail draws its view, and backing out of a view draws the sidebar holding it", async () => {
    // Driven on the Gates view: its rows are the engagement's own gate results,
    // so the detail this backs out of is a row that exists. The journal is a
    // tail and opens no detail at all.
    const gates = send(initialRunInteractionState(), { input: "3", key: {} });
    const selected = send(gates, EVENTS.down);
    const detail = send(selected, EVENTS.open);
    expect(await frame(detail)).toContain("GATE DETAIL");

    const view = send(detail, EVENTS.back);
    const viewFrame = await frame(view);
    expect(viewFrame).toContain(`${GLYPHS.pointer} GATES`);
    expect(viewFrame).not.toContain("GATE DETAIL");

    const sidebar = await frame(send(view, EVENTS.back));
    expect(sidebar).toContain(`${GLYPHS.pointer} VIEWS`);
    expect(sidebar).toContain(`${GLYPHS.pointer} Gates`);
  });

  test("test: no key selects, opens or filters a journal row in any tab, so the journal tail draws the same rows before and after every such attempt", async () => {
    const attempts = [
      EVENTS.down,
      EVENTS.open,
      EVENTS.right,
      EVENTS.filter,
      { input: "", key: { upArrow: true } },
    ] as const satisfies readonly RunKeyEvent[];
    // The rows the tail drew, by their own text — the sidebar's pointer shares
    // those lines, so the row texts are what the assertion compares.
    const journalRows = (drawn: string): readonly string[] =>
      RUN_DATA.journalRows.filter((row) => drawn.includes(row.text))
        .map((row) => row.text);

    // The watch tab: the overview's tail and the Journal view's full-height
    // tail, entered so the rows — not the sidebar — are what the keys aim at.
    for (const state of [
      openingRunInteractionState(),
      send(openingRunInteractionState(), { input: "4", key: {} }),
    ]) {
      const before = await frame(state);
      expect(journalRows(before).length).toBeGreaterThan(0);
      for (const attempt of attempts) {
        const next = send(state, attempt);
        const after = await frame(next);
        expect(journalRows(after)).toEqual(journalRows(before));
        expect(next.selection).toBeNull();
        expect(next.opened).toBeNull();
        // And nothing narrowed the tail behind the drawn rows either: an
        // empty query would draw every row too, so the prompt itself is what
        // the assertion holds — it never opened, and it holds no query.
        expect(next.filterPrompt, "watch filter prompt").toBe(false);
        expect(next.filterQuery, "watch filter query").toBe("");
      }
    }

    // The setup tab draws no journal rows of its own, so asserting on its
    // drawn rows would compare nothing with nothing. What must survive the
    // attempts is the watch journal waiting behind the surface: drive the
    // attempts while setup is active, switch back through the surface
    // dispatcher, and compare the real watch rows and the state around them.
    const attemptsBehindSetup = (start: RunSurfaceState): RunSurfaceState => {
      let surface = sendSurface(start, EVENTS.tab);
      expect(surface.interaction.tab).toBe("setup");
      for (const attempt of attempts) {
        surface = sendSurface(surface, attempt);
        // Setup's own keys may move its own rail, but no attempt reaches a
        // journal row: nothing selected, nothing opened, nothing filtered.
        expect(surface.interaction.selection).toBeNull();
        expect(surface.interaction.opened).toBeNull();
        expect(surface.interaction.filterPrompt, "setup filter prompt").toBe(false);
        expect(surface.interaction.filterQuery, "setup filter query").toBe("");
      }
      return sendSurface(surface, EVENTS.tab);
    };

    // A watch state carrying a selected row: corrupting the hidden journal
    // state — selection, open detail, filter — would change what the round
    // trip returns.
    let gated = openingRunSurfaceState();
    gated = sendSurface(gated, { input: "3", key: {} });
    gated = sendSurface(gated, EVENTS.down);
    expect(gated.interaction.selection).not.toBeNull();
    const gatedBack = attemptsBehindSetup(gated);
    expect(gatedBack.interaction.tab).toBe("watch");
    expect(gatedBack.interaction).toEqual(gated.interaction);

    // A watch state whose tail is drawn: the same rows before and after every
    // attempt made while setup was active.
    let tailed = sendSurface(openingRunSurfaceState(), EVENTS.follow);
    const beforeRows = journalRows(await frame(tailed.interaction));
    expect(beforeRows.length).toBeGreaterThan(0);
    const tailedBack = attemptsBehindSetup(tailed);
    expect(tailedBack.interaction).toEqual(tailed.interaction);
    expect(journalRows(await frame(tailedBack.interaction))).toEqual(beforeRows);
  });

  test("test: following on the overview draws its indicator and keeps the newest event drawn as events arrive", async () => {
    const following = send(initialRunInteractionState(), EVENTS.follow);
    const indicator = await frame(following);
    expect(indicator).toContain(`${GLYPHS.toggleActive} Follow`);

    const newest = {
      id: "event:newest",
      time: "23:59:59",
      state: "active" as const,
      text: "newest event arrived while following",
    };
    const refreshed = await frame(following, {
      ...RUN_DATA,
      journalRows: [newest, ...RUN_DATA.journalRows],
    });
    expect(refreshed).toContain(newest.text);
  });

  test("test: the help overlay and the quit key keep the behaviour they already have, asserted on the drawn frame", async () => {
    const initial = initialRunInteractionState();
    const help = send(initial, EVENTS.help);
    const helpFrame = await frame(help);
    expect(helpFrame).toContain("HELP");
    expect(await frame(send(help, EVENTS.help))).toBe(await frame(initial));

    const quitFrame = await frame(send(initial, EVENTS.quit));
    expect(quitFrame).toContain(`${GLYPHS.toggleActive} Quit requested`);
  });
});
