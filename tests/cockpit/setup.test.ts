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
  PLAIN_BANNER,
} from "../../src/brand.js";
import {
  loadConfigWithMode,
  unifiedYamlDiff,
} from "../../src/config/config.js";
import { JournalRowPanel } from "../../src/tui/cockpit/components.js";
import {
  deriveSetupCockpitData,
  SetupCockpitFrame,
} from "../../src/tui/cockpit/setup-cockpit.js";
import { loadDemoCaptures } from "../../src/tui/cockpit/demo.js";
import {
  applySetupPromptInput,
  initialSetupInteractionState,
  keybarEntries,
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

  test("test: the setup surface heads itself with the full four-line mark taken from the brand module, matching that module's constant for the colour mode in force rather than the compact lockup or art drawn in the surface", async () => {
    const { frame } = await loadFrame();
    const fullMark = stripAnsi(BANNER).trimEnd();

    expect(fullMark).toBe(PLAIN_BANNER.trimEnd());
    expect(fullMark.split("\n")).toHaveLength(4);
    for (const line of fullMark.split("\n")) expect(frame).toContain(line);
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
