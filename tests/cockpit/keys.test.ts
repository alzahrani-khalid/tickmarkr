import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { GLYPHS } from "../../src/brand.js";
import {
  KEYBAR_KEYS,
  Keybar,
  type JournalRow,
  type KeybarItem,
  type KeybarSurface,
} from "../../src/tui/cockpit/components.js";
import {
  regenerateColourFrames,
  regenerateGoldenFrames,
} from "../../src/tui/cockpit/capture.js";
import { loadDemoCaptures } from "../../src/tui/cockpit/demo.js";
import {
  applyFilterInput,
  dispatchRunKey,
  initialRunInteractionState,
  keybarEntries,
  resolveRunKeyBinding,
  RUN_KEY_BINDINGS,
  type RunInteractionState,
  type RunKeyBinding,
  type RunKeyEvent,
} from "../../src/tui/cockpit/keys.js";
import {
  deriveRunCockpitData,
  RunCockpitFrame,
  type RunCockpitData,
} from "../../src/tui/cockpit/run-cockpit.js";

const stripAnsi = (value: string) =>
  value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function renderComponent(node: ReactNode, columns = 120): Promise<string> {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = columns;
  output.rows = 40;

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

const drawRunKeybar = () =>
  renderComponent(createElement(Keybar, { surface: "run", width: 120 }));

/** The run data the behaviour frames are drawn from: the healthy demo capture. */
const RUN_DATA: RunCockpitData = (() => {
  const captures = loadDemoCaptures();
  const healthy = captures.journals.find((journal) =>
    journal.fileName === "run-20260724-231138.journal.jsonl"
  );
  if (!healthy) throw new Error("healthy cockpit capture is missing");
  return deriveRunCockpitData(healthy, "0.0.0-test");
})();

/** The frame the live surface paints under an interaction state. */
const drawRunFrame = (interaction?: RunInteractionState) =>
  renderComponent(createElement(RunCockpitFrame, {
    data: RUN_DATA,
    columns: 140,
    rows: 40,
    interaction,
  }), 140);

/** A word that narrows the fixture journal to a strict, non-empty subset. */
function strictSubsetWord(rows: readonly JournalRow[]): string {
  for (const row of rows) {
    for (const word of row.text.split(" ")) {
      if (word.length < 3) continue;
      const hits = rows.filter((candidate) => candidate.text.includes(word));
      if (hits.length > 0 && hits.length < rows.length) return word;
    }
  }
  throw new Error("fixture journal carries no strict-subset filter word");
}

/** The key events a terminal sends, one per advertised key. */
const EVENTS = {
  moveDown: { input: "", key: { downArrow: true } },
  moveUp: { input: "", key: { upArrow: true } },
  open: { input: "", key: { return: true } },
  back: { input: "", key: { leftArrow: true } },
  panel: { input: "", key: { tab: true } },
  help: { input: "?", key: {} },
  quit: { input: "q", key: {} },
  follow: { input: "f", key: {} },
  filter: { input: "/", key: {} },
} as const satisfies Record<string, RunKeyEvent>;

function mustResolve(
  bindings: readonly RunKeyBinding[],
  event: RunKeyEvent,
): RunKeyBinding {
  const binding = resolveRunKeyBinding(bindings, event);
  if (binding === undefined) {
    throw new Error(`no registered handler owns ${JSON.stringify(event)}`);
  }
  return binding;
}

/**
 * The behaviour contract, written against the keys the run surface advertises
 * — a fixed expectation, not a walk over whatever the registry happens to
 * hold. Each advertised key must be owned by a handler and must produce the
 * change its own label promises, in state AND in the painted frame: Move moves
 * the pointer, Open opens the event, Back returns from it, Panel moves the
 * focus, Help opens the overlay, Quit asks to quit, Follow raises its
 * indicator, Filter opens the prompt and narrows the journal. A handler that
 * only renames a field fails here, because every assertion that matters is
 * made against rendered output.
 */
async function expectEveryAdvertisedKeyBehaves(
  bindings: readonly RunKeyBinding[],
): Promise<void> {
  const initial = initialRunInteractionState();
  const initialFrame = await drawRunFrame(initial);

  // The pinned appearance: the initial state paints exactly the frame that
  // carries no interaction state at all.
  expect(initialFrame).toBe(await drawRunFrame());

  const move = mustResolve(bindings, EVENTS.moveDown);
  expect(move.label).toBe("Move");
  const moved = move.apply(initial, EVENTS.moveDown);
  expect(moved.selection).toBe(initial.selection + 1);
  const movedFrame = await drawRunFrame(moved);
  expect(movedFrame).not.toBe(initialFrame);
  // The pointer marks the first journal row.
  expect(movedFrame).toContain(
    `${GLYPHS.pointer} ${RUN_DATA.journalRows[0]!.text.slice(0, 20)}`,
  );
  const movedUp = move.apply(moved, EVENTS.moveUp);
  expect(movedUp.selection).toBe(initial.selection);
  expect(await drawRunFrame(movedUp)).toBe(initialFrame);

  const open = mustResolve(bindings, EVENTS.open);
  expect(open.label).toBe("Open");
  const opened = open.apply(moved, EVENTS.open);
  expect(opened.opened).toBe(moved.selection);
  const openedFrame = await drawRunFrame(opened);
  expect(openedFrame).not.toBe(movedFrame);
  expect(openedFrame).toContain("EVENT");
  expect(openedFrame).toContain(RUN_DATA.journalRows[0]!.text.slice(0, 20));

  const back = mustResolve(bindings, EVENTS.back);
  expect(back.label).toBe("Back");
  const returned = back.apply(opened, EVENTS.back);
  expect(returned.opened).toBeNull();
  // Back restores exactly the surface Open was sent from.
  expect(await drawRunFrame(returned)).toBe(movedFrame);

  const panel = mustResolve(bindings, EVENTS.panel);
  expect(panel.label).toBe("Panel");
  const panelled = panel.apply(initial, EVENTS.panel);
  expect(panelled.panel).not.toBe(initial.panel);
  const panelFrame = await drawRunFrame(panelled);
  expect(panelFrame).not.toBe(initialFrame);
  // The focus — and its pointer — left RUN for VIEWS.
  expect(initialFrame).toContain(`${GLYPHS.pointer} RUN`);
  expect(panelFrame).not.toContain(`${GLYPHS.pointer} RUN`);
  expect(panelFrame).toContain(`${GLYPHS.pointer} VIEWS`);

  const help = mustResolve(bindings, EVENTS.help);
  expect(help.label).toBe("Help");
  const helping = help.apply(initial, EVENTS.help);
  expect(helping.help).toBe(!initial.help);
  const helpFrame = await drawRunFrame(helping);
  expect(helpFrame).not.toBe(initialFrame);
  expect(helpFrame).toContain("HELP");
  expect(await drawRunFrame(help.apply(helping, EVENTS.help))).toBe(initialFrame);

  const quit = mustResolve(bindings, EVENTS.quit);
  expect(quit.label).toBe("Quit");
  // Quit's observable consequence is the surface exiting, which live.ts
  // performs on next.quit; the state is what a frame cannot show.
  expect(quit.apply(initial, EVENTS.quit).quit).toBe(true);

  const follow = mustResolve(bindings, EVENTS.follow);
  expect(follow.label).toBe("Follow");
  const following = follow.apply(initial, EVENTS.follow);
  expect(following.follow).toBe(!initial.follow);
  const followFrame = await drawRunFrame(following);
  expect(followFrame).not.toBe(initialFrame);
  // The status strip gains the brand's active-toggle glyph next to Follow.
  expect(followFrame).toContain(`${GLYPHS.toggleActive} Follow`);
  expect(initialFrame).not.toContain(`${GLYPHS.toggleActive} Follow`);
  expect(await drawRunFrame(follow.apply(following, EVENTS.follow)))
    .toBe(initialFrame);

  const filter = mustResolve(bindings, EVENTS.filter);
  expect(filter.label).toBe("Filter");
  const prompting = filter.apply(initial, EVENTS.filter);
  expect(prompting.filterPrompt).toBe(true);
  const promptFrame = await drawRunFrame(prompting);
  expect(promptFrame).not.toBe(initialFrame);
  expect(promptFrame).toContain("JOURNAL /");

  // Typing into the prompt narrows the journal to the rows carrying the query.
  const query = strictSubsetWord(RUN_DATA.journalRows);
  let typed = prompting;
  for (const character of query) {
    const next = applyFilterInput({ input: character, key: {} }, typed);
    expect(next).toBeDefined();
    typed = next!;
  }
  expect(typed.filterQuery).toBe(query);
  const trimmed = applyFilterInput({ input: "", key: { backspace: true } }, typed);
  expect(trimmed!.filterQuery).toBe(query.slice(0, -1));
  const typedFrame = await drawRunFrame(typed);
  const shown = RUN_DATA.journalRows.filter((row) => row.text.includes(query));
  const hidden = RUN_DATA.journalRows.find((row) =>
    !row.text.includes(query)
    && !shown.some((peer) => peer.text.includes(row.text.slice(0, 24)))
  );
  expect(shown.length).toBeGreaterThan(0);
  expect(hidden).toBeDefined();
  expect(typedFrame).toContain(shown[0]!.text.slice(0, 24));
  expect(typedFrame).not.toContain(hidden!.text.slice(0, 24));

  // ⏎ applies the filter: the prompt closes, the journal stays narrowed.
  const applied = applyFilterInput({ input: "", key: { return: true } }, typed);
  expect(applied!.filterPrompt).toBe(false);
  const appliedFrame = await drawRunFrame(applied!);
  expect(appliedFrame).not.toContain("JOURNAL /");
  expect(appliedFrame).toContain(shown[0]!.text.slice(0, 24));
  expect(appliedFrame).not.toContain(hidden!.text.slice(0, 24));

  // Escape cancels: the surface is back to the pinned appearance.
  const cancelled = applyFilterInput({ input: "", key: { escape: true } }, typed);
  expect(cancelled!.filterQuery).toBe("");
  expect(await drawRunFrame(cancelled!)).toBe(initialFrame);
}

describe("run surface keys", () => {
  test("test: the entries the keybar draws are derived from the registered handlers rather than from a list written beside them", async () => {
    const derived = keybarEntries(RUN_KEY_BINDINGS);

    // The export every consumer reads IS the derivation, not a copy of it.
    expect(KEYBAR_KEYS.run).toEqual([...derived]);

    // And the drawn keybar carries exactly the derived entries, in order.
    const expectedLine = derived
      .map((entry) => `${entry.key} ${entry.label}`)
      .join(" · ");
    expect(await drawRunKeybar()).toContain(expectedLine);
  });

  test("test: a key with no registered handler cannot appear in the keybar, asserted by removing a handler and observing the entry disappear", async () => {
    const drawn = await drawRunKeybar();
    expect(drawn).toContain("f Follow");

    const withoutFollow = RUN_KEY_BINDINGS.filter(
      (binding) => binding.key !== "f",
    );
    const entries = keybarEntries(withoutFollow);

    expect(entries).toHaveLength(RUN_KEY_BINDINGS.length - 1);
    expect(entries.some((entry) => entry.key === "f")).toBe(false);
    expect(entries.map((entry) => `${entry.key} ${entry.label}`).join(" · "))
      .not.toContain("f Follow");
    // The un-owned key no longer dispatches either.
    expect(dispatchRunKey(EVENTS.follow, initialRunInteractionState(), withoutFollow))
      .toBeUndefined();
  });

  test("test: each advertised key of the run surface changes observable state when it is sent", async () => {
    // The keys the keybar advertises are exactly the keys under test here.
    expect(KEYBAR_KEYS.run.map((item) => item.key)).toEqual([
      "↑↓",
      "⏎",
      "←",
      "Tab",
      "?",
      "q",
      "f",
      "/",
    ]);
    await expectEveryAdvertisedKeyBehaves(RUN_KEY_BINDINGS);
  });

  test("test: removing a handler makes that key's behaviour assertion fail, so a key that stops working cannot pass", async () => {
    await expect(expectEveryAdvertisedKeyBehaves(RUN_KEY_BINDINGS))
      .resolves.toBeUndefined();

    const removed = RUN_KEY_BINDINGS.filter(
      (binding) => binding.label !== "Follow",
    );
    await expect(expectEveryAdvertisedKeyBehaves(removed)).rejects.toThrow();

    // A handler that is present but does nothing fails the same way.
    const dead: readonly RunKeyBinding[] = RUN_KEY_BINDINGS.map((binding) =>
      binding.label === "Follow"
        ? { ...binding, apply: (state: RunInteractionState) => state }
        : binding
    );
    await expect(expectEveryAdvertisedKeyBehaves(dead)).rejects.toThrow();
  });

  test("test: the drawn keybar carries the same entries in the same order as before this task, so the surface a reader sees is unchanged", async () => {
    expect(await drawRunKeybar()).toContain(
      "↑↓ Move · ⏎ Open · ← Back · Tab Panel · ? Help · q Quit · f Follow · / Filter",
    );
  });

  test("test: the keybar entries stay reachable under the name and shape the modules outside this task already import, so nothing beyond this task's scope needs editing to keep building", async () => {
    // The name and shape the outside modules import from components.js.
    expect(Object.keys(KEYBAR_KEYS).sort()).toEqual([
      "run",
      "setup",
      "setupAdditional",
    ]);
    expect(typeof Keybar).toBe("function");
    const surfaces: readonly KeybarSurface[] = ["run", "setup"];
    for (const surface of surfaces) {
      for (const item of KEYBAR_KEYS[surface]) {
        const entry: KeybarItem = item;
        expect(typeof entry.key).toBe("string");
        expect(typeof entry.label).toBe("string");
      }
    }
    expect(KEYBAR_KEYS.setup.map((item) => item.key)).toEqual([
      ...KEYBAR_KEYS.run.slice(0, 6).map((item) => item.key),
      ...KEYBAR_KEYS.setupAdditional.map((item) => item.key),
    ]);

    // The out-of-scope modules that read the keybar still link unedited.
    await expect(import("../../src/tui/cockpit/run-cockpit.js")).resolves.toBeDefined();
    await expect(import("../../src/tui/cockpit/setup-cockpit.js")).resolves.toBeDefined();
    await expect(import("../../src/tui/cockpit/capture.js")).resolves.toBeDefined();
  });

  test("test: the toggle glyphs the brand reserves are used wherever a key reports an on or off state, and bracket toggles appear nowhere", async () => {
    const reporters = RUN_KEY_BINDINGS.filter(
      (binding) => binding.report !== undefined,
    );
    // The run surface's on/off key is Follow, and it reports its state.
    expect(reporters.map((binding) => binding.label)).toEqual(["Follow"]);

    const initial = initialRunInteractionState();
    const reports: string[] = [];
    for (const binding of reporters) {
      const report = binding.report!;
      const off = report(initial);
      const on = report(binding.apply(initial, EVENTS.follow));
      expect(on).toContain(GLYPHS.toggleActive);
      expect(on).not.toContain(GLYPHS.toggleInactive);
      expect(off).toContain(GLYPHS.toggleInactive);
      expect(off).not.toContain(GLYPHS.toggleActive);
      reports.push(on, off);
    }

    // Bracket toggles are forbidden on every surface: reports, labels, the bar.
    const bracketToggle = /\[(?:x|X| |on|off)\]/;
    const surfaces = [
      await drawRunKeybar(),
      ...reports,
      ...RUN_KEY_BINDINGS.map((binding) => `${binding.key} ${binding.label}`),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toMatch(bracketToggle);
      expect(surface).not.toContain("[");
    }
  });

  test("test: every committed frame is byte-identical after this task", async () => {
    // The bytes are pinned directly: every fixture on disk must equal the
    // frame the renderer emits today, for the layout corpus and the colour
    // corpus alike — no git comparison that a same-commit change could slip.
    const framesDirectory = new URL("../fixtures/cockpit/frames/", import.meta.url);
    for (const frame of await regenerateGoldenFrames()) {
      const committed = readFileSync(
        new URL(frame.fixture, framesDirectory),
        "utf8",
      );
      expect(committed, frame.fixture).toBe(frame.emitted);
    }
    const colourDirectory = new URL("../fixtures/cockpit/colour/", import.meta.url);
    for (const frame of await regenerateColourFrames()) {
      const committed = readFileSync(
        new URL(frame.fixture, colourDirectory),
        "utf8",
      );
      expect(committed, frame.fixture).toBe(frame.emitted);
    }
  });
});
