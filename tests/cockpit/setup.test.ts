import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import {
  BANNER,
  GLYPHS,
  MARK_BITMAP,
  PLAIN_BANNER,
} from "../../src/brand.js";
import {
  loadConfigWithMode,
  unifiedYamlDiff,
} from "../../src/config/config.js";
import { JournalRowPanel } from "../../src/tui/cockpit/components.js";
import { approve } from "../../src/cli/commands/approve.js";
import { Journal } from "../../src/run/journal.js";
import {
  applySetupDecisionsKey,
  deriveParkedDecisions,
  deriveSetupCockpitData,
  executeSetupDecision,
  initialSetupDecisionsSession,
  recordSetupDecisionOutcome,
  SetupCockpitFrame,
  SetupDecisionsSurface,
  type ParkedDecision,
  type SetupDecisionCommand,
} from "../../src/tui/cockpit/setup-cockpit.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import { loadDemoCaptures } from "../../src/tui/cockpit/demo.js";
import {
  captureRendererOutput,
  HEIGHT_TIER_BOUNDARIES,
  regenerateGoldenFrames,
  WIDTH_BAND_CASES,
} from "../../src/tui/cockpit/capture.js";
import {
  deriveRunCockpitData,
  RunCockpitFrame,
} from "../../src/tui/cockpit/run-cockpit.js";
import {
  DECISIONS_TAB_HINT,
  DECISIONS_TAB_TITLE,
} from "../../src/tui/cockpit/views.js";
import {
  applySetupPromptInput,
  initialSetupInteractionState,
  keybarEntries,
  openingRunInteractionState,
  resolveSetupKeyBinding,
  SURFACE_KEY_BINDINGS,
  type SetupInteractionState,
  type SetupKeyBinding,
  type RunKeyEvent,
} from "../../src/tui/cockpit/keys.js";

const SOURCES = join(import.meta.dirname, "../fixtures/cockpit/sources");
const CAPTURE_FILES = readdirSync(SOURCES)
  .filter((name) => name !== "README.md")
  .sort();
const stripAnsi = (value: string) =>
  value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function renderComponent(node: ReactNode, columns = 150): Promise<string> {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = columns;
  output.rows = 60;
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
  const frame = stripAnsi(writes.at(-1) ?? "").trimEnd();
  app.unmount();
  return frame;
}

async function loadFrame(
  binaryVersion = "9.8.7",
  interaction?: SetupInteractionState,
  bindings: readonly SetupKeyBinding[] = SURFACE_KEY_BINDINGS.setup,
) {
  const captures = loadDemoCaptures();
  const data = deriveSetupCockpitData(captures, binaryVersion);
  const frame = await renderComponent(createElement(SetupCockpitFrame, {
    data,
    columns: 150,
    interaction,
    bindings,
  }));
  return { captures, data, frame };
}

const SETUP_EVENTS = {
  move: { input: "", key: { downArrow: true } },
  next: { input: "", key: { return: true } },
  back: { input: "", key: { leftArrow: true } },
  panel: { input: "", key: { tab: true } },
  help: { input: "?", key: {} },
  quit: { input: "q", key: {} },
  toggle: { input: " ", key: {} },
  all: { input: "a", key: {} },
  reprobe: { input: "r", key: {} },
  save: { input: "s", key: {} },
  stepNext: { input: "n", key: {} },
  stepPrevious: { input: "p", key: {} },
} as const satisfies Record<string, RunKeyEvent>;

function mustResolveSetup(
  bindings: readonly SetupKeyBinding[],
  event: RunKeyEvent,
): SetupKeyBinding {
  const binding = resolveSetupKeyBinding(bindings, event);
  if (binding === undefined) {
    throw new Error(`no registered setup handler owns ${JSON.stringify(event)}`);
  }
  return binding;
}

async function drawSetupInteraction(
  interaction?: SetupInteractionState,
  bindings: readonly SetupKeyBinding[] = SURFACE_KEY_BINDINGS.setup,
): Promise<string> {
  return (await loadFrame("9.8.7", interaction, bindings)).frame;
}

async function expectEveryAdvertisedSetupKeyBehaves(
  bindings: readonly SetupKeyBinding[],
): Promise<void> {
  const initial = initialSetupInteractionState();
  const initialFrame = await drawSetupInteraction(initial, bindings);
  expect(initialFrame).toBe(await drawSetupInteraction(undefined, bindings));

  const move = mustResolveSetup(bindings, SETUP_EVENTS.move);
  expect(move.label).toBe("Move");
  const moved = move.apply(initial, SETUP_EVENTS.move);
  expect(moved.selection).toBe(0);
  const movedFrame = await drawSetupInteraction(moved, bindings);
  expect(movedFrame).not.toBe(initialFrame);
  expect(movedFrame).toContain("selection 1");

  const next = mustResolveSetup(bindings, SETUP_EVENTS.next);
  expect(next.label).toBe("Next");
  const advanced = next.apply(initial, SETUP_EVENTS.next);
  expect(advanced.step).toBe(3);
  expect(await drawSetupInteraction(advanced, bindings)).toContain("setup · step 3/6");

  const back = mustResolveSetup(bindings, SETUP_EVENTS.back);
  expect(back.label).toBe("Back");
  const backed = back.apply(initial, SETUP_EVENTS.back);
  expect(backed.step).toBe(1);
  expect(await drawSetupInteraction(backed, bindings)).toContain("setup · step 1/6");

  const panel = mustResolveSetup(bindings, SETUP_EVENTS.panel);
  expect(panel.label).toBe("Panel");
  const panelled = panel.apply(initial, SETUP_EVENTS.panel);
  expect(panelled.panel).not.toBe(initial.panel);
  expect(await drawSetupInteraction(panelled, bindings)).toContain("panel KEYS");

  const help = mustResolveSetup(bindings, SETUP_EVENTS.help);
  expect(help.label).toBe("Help");
  const helping = help.apply(initial, SETUP_EVENTS.help);
  expect(helping.help).toBe(true);
  expect(await drawSetupInteraction(helping, bindings)).toContain("HELP");

  const quit = mustResolveSetup(bindings, SETUP_EVENTS.quit);
  expect(quit.label).toBe("Quit");
  expect(quit.apply(initial, SETUP_EVENTS.quit).quit).toBe(true);

  const toggle = mustResolveSetup(bindings, SETUP_EVENTS.toggle);
  expect(toggle.label).toBe("Toggle");
  const toggled = toggle.apply(initial, SETUP_EVENTS.toggle);
  expect(toggled.selected).toEqual([0]);
  expect(await drawSetupInteraction(toggled, bindings)).toContain("selection selected");

  const all = mustResolveSetup(bindings, SETUP_EVENTS.all);
  expect(all.label).toBe("All");
  const selectedAll = all.apply(initial, SETUP_EVENTS.all);
  expect(selectedAll.all).toBe(true);
  expect(await drawSetupInteraction(selectedAll, bindings)).toContain("all selected");

  const reprobe = mustResolveSetup(bindings, SETUP_EVENTS.reprobe);
  expect(reprobe.label).toBe("Re-probe");
  const reprobed = reprobe.apply(initial, SETUP_EVENTS.reprobe);
  expect(reprobed.probeRevision).toBe(1);
  expect(await drawSetupInteraction(reprobed, bindings)).toContain("re-probed 1");

  const save = mustResolveSetup(bindings, SETUP_EVENTS.save);
  expect(save.label).toBe("Save");
  const saving = save.apply(initial, SETUP_EVENTS.save);
  expect(saving.savePrompt).toBe(true);
  const savingFrame = await drawSetupInteraction(saving, bindings);
  expect(savingFrame).not.toBe(initialFrame);
  expect(savingFrame).toContain("SAVE");
  expect(savingFrame).toContain("confirm save");

  const stepNext = mustResolveSetup(bindings, SETUP_EVENTS.stepNext);
  expect(stepNext.label).toBe("Next");
  expect(stepNext.apply(initial, SETUP_EVENTS.stepNext).step).toBe(3);

  const stepPrevious = mustResolveSetup(bindings, SETUP_EVENTS.stepPrevious);
  expect(stepPrevious.label).toBe("Prev");
  expect(stepPrevious.apply(initial, SETUP_EVENTS.stepPrevious).step).toBe(1);
}

function independentlyResolvedConfig() {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-setup-cockpit-"));
  const globalDir = join(root, "global");
  const repoRoot = join(root, "repo");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(join(repoRoot, ".tickmarkr"), { recursive: true });
  writeFileSync(
    join(globalDir, "config.yaml"),
    readFileSync(join(SOURCES, "config.global.yaml"), "utf8"),
  );
  writeFileSync(
    join(repoRoot, ".tickmarkr", "config.yaml"),
    readFileSync(join(SOURCES, "config.repo.yaml"), "utf8"),
  );
  return loadConfigWithMode(repoRoot, { globalDir }).cfg;
}

function independentlyCountedDoctor() {
  const doctor = JSON.parse(
    readFileSync(join(SOURCES, "doctor.json"), "utf8"),
  ) as Record<string, {
    installed?: boolean;
    authed?: boolean;
    modelAuth?: Record<string, { authed?: boolean }>;
  }>;
  const harnesses = Object.entries(doctor).filter(([id]) => id !== "autoPrefer");
  return {
    found: harnesses.length,
    authenticated: harnesses.filter(([, health]) =>
      health.installed === true && health.authed === true
    ).length,
    routable: harnesses.filter(([, health]) =>
      health.installed === true
      && health.authed === true
      && Object.values(health.modelAuth ?? {}).some((model) => model.authed === true)
    ).length,
  };
}

describe("setup cockpit capture-backed surface", () => {
  test("test: every section the contract names for the setup surface renders, and the guided step indicator states the current position within the traversal", async () => {
    const { frame } = await loadFrame();

    for (const section of [
      "HARNESSES",
      "DETECTED",
      "OVERLAY DIFF",
      "FLEET",
      "GATES",
      "CONSULTS",
      "REVIEWERS",
      "REVIEW",
    ]) {
      expect(frame).toContain(section);
    }
    expect(frame).toMatch(/\bsetup · step 2\/6\b/);
  });

  test("test: the setup surface heads itself with the full ruled mark taken from the brand module, matching that module's constant for the colour mode in force rather than the compact lockup or art drawn in the surface", async () => {
    const { frame } = await loadFrame();
    const fullMark = stripAnsi(BANNER).replace(/[ \t]+$/gm, "").trimEnd();

    expect(fullMark).toBe(PLAIN_BANNER.trimEnd());
    expect(fullMark.split("\n")).toHaveLength(MARK_BITMAP.length / 2 - 1);
    for (const line of fullMark.split("\n")) expect(frame).toContain(line.trimEnd());
  });

  test("test: each detected harness renders its state as a glyph together with a word, and a denied channel renders its reason inline", async () => {
    const { data, frame } = await loadFrame();

    for (const harness of data.harnesses) {
      const glyph = harness.state === "pass" ? GLYPHS.pass
        : harness.state === "fail" ? GLYPHS.fail
          : GLYPHS.toggleInactive;
      expect(frame).toContain(harness.id);
      expect(frame).toMatch(new RegExp(`${glyph}\\s+${harness.stateWord}`));
    }
    expect(data.deniedChannels.length).toBeGreaterThan(0);
    for (const denied of data.deniedChannels) {
      expect(frame).toContain(`${GLYPHS.fail} denied`);
      expect(frame).toContain(denied.channel);
      expect(frame).toContain(denied.reason);
    }
  });

  test("test: the found, authenticated and routable tiles each equal the count independently derived from the captured detection cache", async () => {
    const { data, frame } = await loadFrame();
    const expected = independentlyCountedDoctor();

    expect(data.counts).toEqual(expected);
    expect(frame).toMatch(new RegExp(`FOUND[\\s\\S]*?${expected.found}`));
    expect(frame).toMatch(new RegExp(`AUTHENTICATED[\\s\\S]*?${expected.authenticated}`));
    expect(frame).toMatch(new RegExp(`ROUTABLE[\\s\\S]*?${expected.routable}`));
  });

  test("test: the fleet, gates, consults and reviewers sections show the values the captured configuration pair actually resolves to rather than built-in defaults", async () => {
    const { data, frame } = await loadFrame();
    const expected = independentlyResolvedConfig();

    expect(data.config).toEqual(expected);
    expect(frame).toContain(`mode ${expected.routing.mode}`);
    expect(frame).toContain(`implement:${expected.routing.floors.implement}`);
    expect(frame).toContain(`test ${expected.gates.test}`);
    expect(frame).toContain(`diff cap ${expected.gates.diffCap}`);
    expect(frame).toContain(`seat ${expected.consult.adapter}:${expected.consult.model}`);
    for (const seat of expected.consult.prefer ?? []) expect(frame).toContain(seat);
    expect(frame).toContain(`required ${String(expected.review.required)}`);
    for (const reviewer of expected.review.prefer ?? []) expect(frame).toContain(reviewer);
  });

  test("test: the overlay difference is produced by the product's existing configuration diff renderer over the captured pair rather than by a second differ written for the surface", async () => {
    const { captures, data, frame } = await loadFrame();
    const expected = unifiedYamlDiff(
      captures.config.global.raw,
      captures.config.repo.raw,
      captures.config.repo.fileName,
    );

    expect(data.overlayDiff).toBe(expected);
    expect(frame).toContain(`--- ${captures.config.repo.fileName} (current)`);
    expect(frame).toContain(`+++ ${captures.config.repo.fileName} (proposed)`);
    expect(frame).toContain("+gates:");
  });

  test("test: the status strip names the overlay target, states that the base is untouched, and reports an unsaved count equal to the number of staged changes", async () => {
    const { captures, data, frame } = await loadFrame();

    expect(data.stagedChanges.length).toBeGreaterThan(0);
    expect(frame).toContain(`overlay ${captures.config.repo.fileName}`);
    expect(frame).toContain("base untouched");
    expect(frame).toContain(`${data.stagedChanges.length} changes unsaved`);
  });

  test("test: the review section renders through the same journal row panel component the run cockpit uses", async () => {
    const { data, frame } = await loadFrame();
    const journal = await renderComponent(createElement(JournalRowPanel, {
      rows: data.reviewRows,
      title: "REVIEW",
      width: 70,
    }), 70);

    expect(data.reviewRows.length).toBeGreaterThan(0);
    for (const row of data.reviewRows) {
      expect(frame).toContain(row.text);
      expect(journal).toContain(row.text);
    }
  });

  test("test: the nav column lists its contracted section entries and marks the current one, which is a separate signal from the guided step indicator in the header", async () => {
    const { frame } = await loadFrame();

    for (const entry of [
      "Detect",
      "Harnesses",
      "Fleet",
      "Gates",
      "Consults",
      "Reviewers",
      "Review",
    ]) {
      expect(frame).toContain(entry);
    }
    expect(frame).toMatch(/❯\s+Harnesses/);
    expect(frame).toMatch(/\bsetup · step 2\/6\b/);
  });

  test("test: the setup surface draws its keybar from the same registry the other surface uses rather than from a second list", async () => {
    const entries = keybarEntries(SURFACE_KEY_BINDINGS.setup);
    const expected = entries.map((entry) => `${entry.key} ${entry.label}`).join(" · ");
    const { frame } = await loadFrame();

    expect(frame).toContain(expected);

    const withoutSave = SURFACE_KEY_BINDINGS.setup.filter(
      (binding) => binding.label !== "Save",
    );
    expect(await drawSetupInteraction(undefined, withoutSave)).not.toContain("s Save");
  });

  test("test: each advertised key of the setup surface changes observable state when it is sent", async () => {
    expect(keybarEntries(SURFACE_KEY_BINDINGS.setup).map((item) => item.key)).toEqual([
      "↑↓",
      "⏎",
      "←",
      "Tab",
      "?",
      "q",
      "␣",
      "a",
      "r",
      "s",
      "n",
      "p",
    ]);
    await expectEveryAdvertisedSetupKeyBehaves(SURFACE_KEY_BINDINGS.setup);
  });

  test("test: removing a handler makes that key's behaviour assertion fail, so a key that stops working cannot pass", async () => {
    await expect(expectEveryAdvertisedSetupKeyBehaves(SURFACE_KEY_BINDINGS.setup))
      .resolves.toBeUndefined();

    const removed = SURFACE_KEY_BINDINGS.setup.filter(
      (binding) => binding.label !== "Save",
    );
    await expect(expectEveryAdvertisedSetupKeyBehaves(removed)).rejects.toThrow();

    const dead: readonly SetupKeyBinding[] = SURFACE_KEY_BINDINGS.setup.map(
      (binding) => binding.label === "Save"
        ? { ...binding, apply: (state: SetupInteractionState) => state }
        : binding,
    );
    await expect(expectEveryAdvertisedSetupKeyBehaves(dead)).rejects.toThrow();
  });

  test("test: a key advertised on one surface and not the other is registered for the surface that advertises it and is absent from the other", () => {
    const runKeys = new Set(SURFACE_KEY_BINDINGS.run.map((binding) => binding.key));
    const setupKeys = new Set(SURFACE_KEY_BINDINGS.setup.map((binding) => binding.key));

    expect([...runKeys].filter((key) => !setupKeys.has(key))).toEqual(["f", "/"]);
    expect([...setupKeys].filter((key) => !runKeys.has(key))).toEqual([
      "␣",
      "a",
      "r",
      "s",
      "n",
      "p",
    ]);
    for (const key of ["f", "/"]) {
      expect(SURFACE_KEY_BINDINGS.run.some((binding) => binding.key === key)).toBe(true);
      expect(SURFACE_KEY_BINDINGS.setup.some((binding) => binding.key === key)).toBe(false);
    }
    for (const key of ["␣", "a", "r", "s", "n", "p"]) {
      expect(SURFACE_KEY_BINDINGS.setup.some((binding) => binding.key === key)).toBe(true);
      expect(SURFACE_KEY_BINDINGS.run.some((binding) => binding.key === key)).toBe(false);
    }
  });

  test("test: the key that reports a saved or unsaved state uses the reserved toggle glyphs, and bracket toggles appear nowhere", async () => {
    const save = SURFACE_KEY_BINDINGS.setup.find((binding) => binding.label === "Save");
    expect(save?.report).toBeDefined();

    const initial = initialSetupInteractionState();
    const unsaved = save!.report!(initial);
    const saving = save!.apply(initial, SETUP_EVENTS.save);
    const savedState = applySetupPromptInput(
      { input: "y", key: {} },
      saving,
    );
    expect(savedState).toBeDefined();
    const saved = save!.report!(savedState!);

    expect(unsaved).toContain(GLYPHS.toggleInactive);
    expect(unsaved).not.toContain(GLYPHS.toggleActive);
    expect(saved).toContain(GLYPHS.toggleActive);
    expect(saved).not.toContain(GLYPHS.toggleInactive);

    const bracketToggle = /\[(?:x|X| |on|off)\]/;
    for (const text of [
      unsaved,
      saved,
      await drawSetupInteraction(),
      ...SURFACE_KEY_BINDINGS.setup.map((binding) => `${binding.key} ${binding.label}`),
    ]) {
      expect(text).not.toMatch(bracketToggle);
      expect(text).not.toContain("[");
    }
  });

  test("test: the drawn keybar carries the same entries in the same order as before this task", async () => {
    expect(await drawSetupInteraction()).toContain(
      "↑↓ Move · ⏎ Next · ← Back · Tab Panel · ? Help · q Quit · ␣ Toggle · a All · r Re-probe · s Save · n Next · p Prev",
    );
  });

  test("the setup surface writes no configuration and re-probes nothing", async () => {
    const before = Object.fromEntries(CAPTURE_FILES.map((fileName) => [
      fileName,
      readFileSync(join(SOURCES, fileName), "utf8"),
    ]));
    const source = readFileSync(
      join(import.meta.dirname, "../../src/tui/cockpit/setup-cockpit.tsx"),
      "utf8",
    );

    await loadFrame();

    const after = Object.fromEntries(CAPTURE_FILES.map((fileName) => [
      fileName,
      readFileSync(join(SOURCES, fileName), "utf8"),
    ]));
    expect(after).toEqual(before);
    expect(source).not.toMatch(
      /\b(writeFile|rename|confirmSave|buildSaveProposal|readDoctor|probeAll|allAdapters)\b/,
    );
  });

  test("the review section reuses the run cockpit's journal panel rather than carrying a second implementation of one", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../../src/tui/cockpit/setup-cockpit.tsx"),
      "utf8",
    );

    expect(source).toContain("JournalRowPanel");
    expect(source.match(/JournalRowPanel/g)?.length).toBe(2);
    expect(source).not.toMatch(/function\s+\w*Journal\w*Panel/);
  });
});

/* ------------------------------------------------------------------------ */
/* The setup tab's decisions surface: parked rows, confirm, the one write.   */
/* ------------------------------------------------------------------------ */

const DECISION_ASSIGNMENT = {
  adapter: "fake",
  model: "fake-1",
  channel: "sub",
  tier: "frontier",
} as const;

function decisionsRepo(runId: string): { root: string; journalPath: string } {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-setup-decisions-"));
  return { root, journalPath: join(root, ".tickmarkr", "runs", runId, "journal.jsonl") };
}

function parkOnReview(journal: Journal, taskId: string): void {
  journal.append("task-dispatch", taskId, { assignment: DECISION_ASSIGNMENT, attempt: 0 });
  journal.append("gate-result", taskId, {
    gate: "review",
    pass: false,
    details: "requested changes",
  });
  journal.append("task-human", taskId, {
    kind: "gate-fail",
    reason: "review round cap reached this engagement",
  });
}

function journalEvents(journalPath: string): {
  event: string;
  taskId?: string;
  data: Record<string, unknown>;
}[] {
  return readFileSync(journalPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function drawDecisions(
  decisions: readonly ParkedDecision[],
  session = initialSetupDecisionsSession(),
  columns = 140,
  journalFile = ".tickmarkr/runs/run-decisions/journal.jsonl",
): Promise<string> {
  return renderComponent(createElement(SetupDecisionsSurface, {
    decisions,
    session,
    columns,
    actor: "operator",
    journalFile,
  }), columns);
}

describe("setup tab decisions surface", () => {
  test("test: the decisions section draws one row per parked task from the journal and a truthful empty state when nothing is parked, and setup-cockpit.tsx measures those rows through the width module alone, so a task name carrying a ZWJ grapheme neither overflows the row nor truncates mid-cluster", async () => {
    const { root } = decisionsRepo("run-decisions-rows");
    const journal = Journal.create(root, "run-decisions-rows");
    parkOnReview(journal, "T1");
    journal.append("task-dispatch", "T2", { assignment: DECISION_ASSIGNMENT, attempt: 0 });
    journal.append("task-human", "T2", { kind: "attempt-cap" });
    journal.append("task-dispatch", "T3", { assignment: DECISION_ASSIGNMENT, attempt: 0 });
    journal.append("task-done", "T3", { attempts: 1 });

    const decisions = deriveParkedDecisions(Journal.open(root, "run-decisions-rows"));
    expect(decisions.map((decision) => decision.taskId)).toEqual(["T1", "T2"]);

    const frame = await drawDecisions(decisions);
    expect(frame).toContain("DECISIONS · 2 parked");
    // one row per parked task: two pointer-column rows, and the done task owns none
    expect(frame).toContain("T1 · gate-fail");
    expect(frame).toContain("T2 · attempt-cap");
    expect(frame).not.toContain("T3 ·");
    // a surface that can write advertises only what it has: both verbs, named
    // (the selected row is T1, a review park, where uphold exists)
    expect(frame).toContain("a Approve · u Uphold");

    // On a park whose last failed gate is not review the command must refuse
    // uphold, so the verb leaves the keybar and the key is inert.
    const moved = applySetupDecisionsKey(
      initialSetupDecisionsSession(),
      { input: "", key: { downArrow: true } },
      decisions,
    );
    expect(moved.session.selection).toBe(1);
    expect(decisions[1]!.failedGate).toBeUndefined();
    const movedFrame = await drawDecisions(decisions, moved.session);
    expect(movedFrame).toContain("a Approve");
    expect(movedFrame).not.toContain("Uphold");
    const upheld = applySetupDecisionsKey(moved.session, { input: "u", key: {} }, decisions);
    expect(upheld.session.confirming).toBeNull();
    expect(upheld.command).toBeUndefined();

    const empty = Journal.create(root, "run-decisions-empty");
    empty.append("run-start", undefined, { graphDefinitionHash: "abc" });
    const noDecisions = deriveParkedDecisions(Journal.open(root, "run-decisions-empty"));
    expect(noDecisions).toEqual([]);
    const emptyFrame = await drawDecisions(noDecisions);
    expect(emptyFrame).toContain("DECISIONS · 0 parked");
    expect(emptyFrame).toContain("nothing needs you now");
    // nothing parked ⇒ the write KEYS are not advertised, however the empty
    // state describes the two decisions a future park would carry
    expect(emptyFrame).not.toContain("a Approve");
    expect(emptyFrame).not.toContain("u Uphold");

    // Rows are measured through the width module alone: a task name carrying a
    // ZWJ grapheme is drawn whole or dropped whole, and no line overflows.
    const source = readFileSync(
      join(import.meta.dirname, "../../src/tui/cockpit/setup-cockpit.tsx"),
      "utf8",
    );
    expect(source).toMatch(/import \{ fitCells \} from "\.\/width\.js"/);
    const zwj = "👨‍👩‍👧";
    const zwjTask = `T-wider-than-the-row-${zwj}`;
    const zwjJournal = Journal.create(root, "run-decisions-zwj");
    parkOnReview(zwjJournal, zwjTask);
    const zwjDecisions = deriveParkedDecisions(Journal.open(root, "run-decisions-zwj"));
    for (const columns of [24, 120]) {
      const zwjFrame = await drawDecisions(zwjDecisions, initialSetupDecisionsSession(), columns);
      for (const line of zwjFrame.split("\n")) {
        expect(cellWidth(line)).toBeLessThanOrEqual(columns);
      }
      expect(zwjFrame.includes("👨")).toBe(zwjFrame.includes(zwjTask));
    }
    expect((await drawDecisions(zwjDecisions, initialSetupDecisionsSession(), 24)).includes(zwj)).toBe(false);
    expect((await drawDecisions(zwjDecisions, initialSetupDecisionsSession(), 120)).includes(zwjTask)).toBe(true);
  });

  test("test: the approve key on a parked row opens a confirm inset naming the task, the actor, the file and the effect, and the journal file stays byte-identical until the confirm key", async () => {
    const { root, journalPath } = decisionsRepo("run-decisions-confirm");
    parkOnReview(Journal.create(root, "run-decisions-confirm"), "T4");
    const journalFile = ".tickmarkr/runs/run-decisions-confirm/journal.jsonl";
    const decisions = deriveParkedDecisions(Journal.open(root, "run-decisions-confirm"));

    const before = readFileSync(journalPath, "utf8");
    const opened = applySetupDecisionsKey(
      initialSetupDecisionsSession(),
      { input: "a", key: {} },
      decisions,
    );
    expect(opened.command).toBeUndefined();
    expect(opened.session.confirming).toEqual({ verb: "approve", taskId: "T4" });

    const frame = await drawDecisions(decisions, opened.session, 140, journalFile);
    expect(frame).toContain("CONFIRM APPROVE");
    expect(frame).toContain("task   T4");
    expect(frame).toContain("actor  operator");
    expect(frame).toContain(`file   ${journalFile}`);
    expect(frame).toContain("y approve · n cancel");
    expect(readFileSync(journalPath, "utf8")).toBe(before);

    // Even the confirm key itself only names the write; nothing touches the file.
    const confirmed = applySetupDecisionsKey(opened.session, { input: "y", key: {} }, decisions);
    expect(confirmed.command).toEqual({ verb: "approve", taskId: "T4" });
    expect(confirmed.session.confirming).toBeNull();
    expect(readFileSync(journalPath, "utf8")).toBe(before);

    // The inset's stated effect is checked against the write it names, not
    // against itself: confirm for real and read back what the journal gained.
    const outcome = await executeSetupDecision(
      confirmed.command as SetupDecisionCommand,
      { cwd: root, runId: "run-decisions-confirm", by: "operator" },
    );
    expect(outcome.ok).toBe(true);
    const recorded = journalEvents(journalPath).find(
      (event) => event.event === "task-approved" && event.taskId === "T4",
    );
    expect(recorded).toBeDefined();
    // this park is gate-fail on review: the write satisfies the gate, and the
    // inset said so — never the opposite
    expect(recorded!.data.release).toBe("gate-satisfied");
    expect(recorded!.data.gate).toBe("review");
    expect(frame).toContain(
      `effect appends one task-approved event with release ${String(recorded!.data.release)}`
        + ` for gate ${String(recorded!.data.gate)}`,
    );
    expect(frame).toContain(`it marks gate ${String(recorded!.data.gate)} satisfied`);
    expect(frame).not.toContain("does NOT mark the task done or pass any gate");
  });

  test("test: confirming appends the approval to the journal file, verified by reading the file back and finding the recorded release, and a refusal from the command renders on the surface as the exact string the command produced", async () => {
    const { root, journalPath } = decisionsRepo("run-decisions-approve");
    parkOnReview(Journal.create(root, "run-decisions-approve"), "T4");
    const journalFile = ".tickmarkr/runs/run-decisions-approve/journal.jsonl";
    const decisions = deriveParkedDecisions(Journal.open(root, "run-decisions-approve"));
    const opened = applySetupDecisionsKey(
      initialSetupDecisionsSession(),
      { input: "a", key: {} },
      decisions,
    );
    const confirmed = applySetupDecisionsKey(opened.session, { input: "y", key: {} }, decisions);
    const command = confirmed.command as SetupDecisionCommand;

    const outcome = await executeSetupDecision(command, { cwd: root, runId: "run-decisions-approve", by: "operator" });
    expect(outcome.ok).toBe(true);
    // read the file back: the recorded release is there
    const approvals = journalEvents(journalPath).filter(
      (event) => event.event === "task-approved" && event.taskId === "T4",
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.data.release).toBe("gate-satisfied");
    expect(approvals[0]!.data.by).toBe("operator");
    if (outcome.ok) expect(outcome.write.release).toBe("gate-satisfied");

    const written = recordSetupDecisionOutcome(initialSetupDecisionsSession(), outcome);
    const writtenFrame = await drawDecisions(decisions, written, 140, journalFile);
    if (outcome.ok) expect(writtenFrame).toContain(outcome.message);

    // the second approve is refused by the production command; the surface draws
    // the command's own string, exactly
    const expected = await approve(["run-decisions-approve", "T4", "--by", "operator"], root)
      .then(
        () => {
          throw new Error("expected the command to refuse");
        },
        (error: Error) => error.message,
      );
    const refusal = await executeSetupDecision(command, { cwd: root, runId: "run-decisions-approve", by: "operator" });
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.refusal).toBe(expected);
    const refused = recordSetupDecisionOutcome(written, refusal);
    const refusedFrame = await drawDecisions(decisions, refused, 140, journalFile);
    expect(refusedFrame).toContain(expected);
    // the refusal appended nothing
    expect(
      journalEvents(journalPath).filter(
        (event) => event.event === "task-approved" && event.taskId === "T4",
      ),
    ).toHaveLength(1);
  });

  test("test: the uphold key appends the uphold release to the journal file the same way, verified by reading the file back, and the pending writes region draws what the file gained this session", async () => {
    const { root, journalPath } = decisionsRepo("run-decisions-uphold");
    parkOnReview(Journal.create(root, "run-decisions-uphold"), "T7");
    const journalFile = ".tickmarkr/runs/run-decisions-uphold/journal.jsonl";
    const decisions = deriveParkedDecisions(Journal.open(root, "run-decisions-uphold"));

    const opened = applySetupDecisionsKey(
      initialSetupDecisionsSession(),
      { input: "u", key: {} },
      decisions,
    );
    expect(opened.session.confirming).toEqual({ verb: "uphold", taskId: "T7" });
    const confirmFrame = await drawDecisions(decisions, opened.session, 140, journalFile);
    expect(confirmFrame).toContain("CONFIRM UPHOLD");
    expect(confirmFrame).toContain("release review-upheld");

    const confirmed = applySetupDecisionsKey(opened.session, { input: "y", key: {} }, decisions);
    const outcome = await executeSetupDecision(
      confirmed.command as SetupDecisionCommand,
      { cwd: root, runId: "run-decisions-uphold", by: "operator" },
    );
    expect(outcome.ok).toBe(true);

    const approvals = journalEvents(journalPath).filter(
      (event) => event.event === "task-approved" && event.taskId === "T7",
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.data.release).toBe("review-upheld");
    // the inset promised exactly the release the file gained
    expect(confirmFrame).toContain(`release ${String(approvals[0]!.data.release)}`);

    const session = recordSetupDecisionOutcome(initialSetupDecisionsSession(), outcome);
    expect(session.writes).toHaveLength(1);
    const frame = await drawDecisions(decisions, session, 140, journalFile);
    expect(frame).toContain("PENDING WRITES");
    expect(frame).toContain("uphold T7 · release review-upheld · by operator");
    expect(frame).not.toContain("nothing written this session");
  });

  test("test: with no actionable park, the decisions section draws the empty state naming approve and uphold and that nothing needs the operator", async () => {
    const { root } = decisionsRepo("run-decisions-quiet");
    const quiet = Journal.create(root, "run-decisions-quiet");
    quiet.append("run-start", undefined, { graphDefinitionHash: "abc" });
    quiet.append("task-dispatch", "T1", { assignment: DECISION_ASSIGNMENT, attempt: 0 });
    quiet.append("task-done", "T1", { attempts: 1 });
    const none = deriveParkedDecisions(Journal.open(root, "run-decisions-quiet"));
    expect(none).toEqual([]);

    const quietFrame = await drawDecisions(none);
    expect(quietFrame).toContain("nothing needs you now — no task is parked on a human gate");
    expect(quietFrame).toContain("approve releases it");
    expect(quietFrame).toContain("uphold sides with the reviewer");

    // "no ACTIONABLE park" is the trigger, not "no park": a journal holding
    // only tombstone parks is still a surface nothing needs the operator for.
    const tombstoned = Journal.create(root, "run-decisions-quiet-tombstone");
    tombstoned.append("task-human", "T13", {
      kind: "human-gate",
      reason: 'humanGate: "SUPERSEDED BY T14 — tombstone, never dispatched"'
        + " requires approval before dispatch",
    });
    const onlyTombstones = deriveParkedDecisions(
      Journal.open(root, "run-decisions-quiet-tombstone"),
    );
    expect(onlyTombstones.map((decision) => decision.tombstone)).toEqual([true]);
    const tombstoneFrame = await drawDecisions(onlyTombstones);
    expect(tombstoneFrame).toContain("nothing needs you now — no task is parked on a human gate");
    expect(tombstoneFrame).toContain("approve releases it");
    expect(tombstoneFrame).toContain("uphold sides with the reviewer");

    // an actionable park displaces the empty state rather than joining it
    const parked = Journal.create(root, "run-decisions-quiet-parked");
    parkOnReview(parked, "T2");
    const actionable = deriveParkedDecisions(
      Journal.open(root, "run-decisions-quiet-parked"),
    );
    const busyFrame = await drawDecisions(actionable);
    expect(busyFrame).toContain("T2 · gate-fail");
    expect(busyFrame).not.toContain("nothing needs you now");
  });

  test("test: a tombstone park draws as read-only with no live verb, while an actionable park draws its approve and uphold verbs", async () => {
    const { root, journalPath } = decisionsRepo("run-decisions-tombstone");
    const journal = Journal.create(root, "run-decisions-tombstone");
    journal.append("task-human", "T13", {
      kind: "human-gate",
      reason: 'humanGate: "SUPERSEDED BY T14+T15+T16 — tombstone, never dispatched"'
        + " requires approval before dispatch",
    });
    parkOnReview(journal, "T14");

    const decisions = deriveParkedDecisions(Journal.open(root, "run-decisions-tombstone"));
    expect(decisions.map((decision) => [decision.taskId, decision.tombstone])).toEqual([
      ["T13", true],
      ["T14", false],
    ]);

    const frame = await drawDecisions(decisions);
    // both parks are drawn — the roster stays honest about what the journal holds
    expect(frame).toContain("T13 · human-gate");
    expect(frame).toContain("T14 · gate-fail");
    // the tombstone row says what it is, and carries neither pointer nor verb
    const tombstoneRow = frame.split("\n").find((line) => line.includes("T13 ·"))!;
    expect(tombstoneRow).toContain("read-only · permanent by design");
    expect(tombstoneRow).not.toContain(GLYPHS.pointer);
    // the pointer and both verbs belong to the actionable park instead
    const actionableRow = frame.split("\n").find((line) => line.includes("T14 ·"))!;
    expect(actionableRow).toContain(GLYPHS.pointer);
    expect(frame).toContain("a Approve · u Uphold");

    // no key reaches the tombstone: the pointer cannot move onto it, and the
    // verbs name the actionable park no matter how far the pointer is pushed
    let session = initialSetupDecisionsSession();
    for (let press = 0; press < 4; press += 1) {
      session = applySetupDecisionsKey(
        session,
        { input: "", key: { downArrow: true } },
        decisions,
      ).session;
    }
    const before = readFileSync(journalPath, "utf8");
    for (const verb of ["a", "u"] as const) {
      const named = applySetupDecisionsKey(session, { input: verb, key: {} }, decisions);
      expect(named.session.confirming?.taskId).toBe("T14");
      const confirmed = applySetupDecisionsKey(
        named.session,
        { input: "y", key: {} },
        decisions,
      );
      expect(confirmed.command?.taskId).toBe("T14");
    }
    expect(readFileSync(journalPath, "utf8")).toBe(before);

    // and the production command agrees: it refuses the tombstone's id outright
    await expect(
      approve(["run-decisions-tombstone", "T13", "--uphold", "--by", "operator"], root),
    ).rejects.toThrow(/--uphold applies to a review rejection/);
  });

  test("test: cancelling the confirm leaves the journal byte-identical, asserted on the file", async () => {
    const { root, journalPath } = decisionsRepo("run-decisions-cancel");
    parkOnReview(Journal.create(root, "run-decisions-cancel"), "T5");
    const decisions = deriveParkedDecisions(Journal.open(root, "run-decisions-cancel"));

    const before = readFileSync(journalPath, "utf8");
    const opened = applySetupDecisionsKey(
      initialSetupDecisionsSession(),
      { input: "a", key: {} },
      decisions,
    );
    expect(opened.session.confirming).not.toBeNull();

    const cancelled = applySetupDecisionsKey(opened.session, { input: "n", key: {} }, decisions);
    expect(cancelled.command).toBeUndefined();
    expect(cancelled.session.confirming).toBeNull();
    expect(readFileSync(journalPath, "utf8")).toBe(before);

    const reopened = applySetupDecisionsKey(cancelled.session, { input: "u", key: {} }, decisions);
    const escaped = applySetupDecisionsKey(reopened.session, { input: "", key: { escape: true } }, decisions);
    expect(escaped.command).toBeUndefined();
    expect(escaped.session.confirming).toBeNull();
    expect(readFileSync(journalPath, "utf8")).toBe(before);
  });
});

/**
 * The tab's own name, drawn. The operator's v1.83 UAT read "Setup" as
 * configuration; these assert on rendered bytes at every contracted size, so
 * the rename is proved where an operator would read it rather than in source.
 */
describe("the decisions tab's drawn name", () => {
  const CAPTURES = loadDemoCaptures();
  const RUN_SOURCE = CAPTURES.journals.find((capture) =>
    capture.fileName === "run-20260724-231138.journal.jsonl"
  )!;
  /** The word wherever it is drawn, in either case the surface uses. */
  const SETUP_LABEL = /\bSetup\b|\bSETUP\b/u;

  const drawTab = (
    tab: "watch" | "setup",
    columns: number,
    rows: number,
  ): Promise<string> =>
    captureRendererOutput(
      createElement(RunCockpitFrame, {
        data: deriveRunCockpitData(RUN_SOURCE, "9.8.7"),
        columns,
        rows,
        interaction: openingRunInteractionState(tab),
      }),
      { columns, rows, colour: false },
    );

  test("test: the decisions surface draws DECISIONS in its header and the tab hint, and no drawn frame of the decisions tab shows the label Setup", async () => {
    expect(DECISIONS_TAB_TITLE).toBe("DECISIONS");
    expect(DECISIONS_TAB_HINT).toBe("Decisions");

    // The header marks the tab it draws, from the constant, and the panel under
    // it titles itself with the same word — two lines carry the name, no more.
    const decisions = stripAnsi(await drawTab("setup", 140, 24));
    expect(decisions).toContain(`[ ${DECISIONS_TAB_TITLE} ]`);
    expect(decisions.split("\n").filter((line) => line.includes(DECISIONS_TAB_TITLE)))
      .toHaveLength(2);
    // And it names the tab Tab draws next, which from here is the watch tab.
    expect(decisions).toContain("Tab Watch");

    // The tab strip names it from the watch side too, in the same bytes.
    const watch = stripAnsi(await drawTab("watch", 140, 24));
    expect(watch).toContain(`[ WATCH ]   ${DECISIONS_TAB_TITLE}`);

    // The surface's own tab hint — what the tab is and what it may write —
    // carries the name in the keybar's case, from the same pair of constants.
    const section = stripAnsi(await drawDecisions([]));
    expect(section).toContain(`${DECISIONS_TAB_TITLE} · 0 parked`);
    expect(section).toContain(`tab ${DECISIONS_TAB_HINT} · `);
    expect(section).not.toMatch(SETUP_LABEL);

    // And nowhere the decisions tab draws, at any contracted size, does the old
    // label survive — not in the header, the rail, the body or the keybar.
    for (const { columns } of WIDTH_BAND_CASES) {
      for (const rows of HEIGHT_TIER_BOUNDARIES) {
        const frame = stripAnsi(await drawTab("setup", columns, rows));
        const offenders = frame.split("\n").filter((line) => SETUP_LABEL.test(line));

        expect(offenders, `decisions tab at ${columns}x${rows}`).toEqual([]);
        expect(frame, `decisions tab at ${columns}x${rows}`)
          .toMatch(new RegExp(DECISIONS_TAB_TITLE, "u"));
      }
    }
  });

  test("test: the machine-surface anchors byte-match what the renderer draws with the DECISIONS label, so the frozen tier is current", async () => {
    const anchors = join(import.meta.dirname, "../fixtures/cockpit/anchors");
    const generated = await regenerateGoldenFrames();

    // The renderer the tier is frozen against is the renamed one: the tab strip
    // it draws today carries DECISIONS, from whichever tab is in front.
    for (const tab of ["watch", "setup"] as const) {
      expect(stripAnsi(await drawTab(tab, 140, 24)), tab)
        .toContain(DECISIONS_TAB_TITLE);
    }

    for (
      const fixture of ["run.ci.140x24.txt", "run.non-tty.140x24.txt"] as const
    ) {
      const rendered = generated.find((frame) => frame.fixture === fixture);
      if (!rendered) throw new Error(`the manifest drew no ${fixture}`);
      const frozen = readFileSync(join(anchors, fixture), "utf8");

      // Current to the last byte, keys line included — nothing here is exempted
      // or normalised, so the tier falling behind the renamed renderer fails
      // here rather than being absorbed.
      expect(frozen, fixture).toBe(rendered.output);
      expect(frozen.split("\n").at(-2), `${fixture} keys line`)
        .toBe(rendered.output.split("\n").at(-2));
    }
  });
});
