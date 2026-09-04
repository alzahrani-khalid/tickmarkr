import { spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import { createElement, type ReactNode } from "react";
import {
  createSourceFile,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isStringLiteral,
  ScriptKind,
  ScriptTarget,
  type ExpressionStatement,
  type Node,
} from "typescript";
import stringWidth from "string-width";
import { describe, expect, test } from "vitest";
import { GLYPHS } from "../../src/brand.js";
import * as cockpitComponents from "../../src/tui/cockpit/components.js";
import {
  BAND_CONTINUATION_PREFIX,
  KeyRoster,
} from "../../src/tui/cockpit/components.js";
import {
  captureCockpitOutput,
  GOLDEN_FRAME_CASES,
  goldenFrameMatchesCommitted,
  regenerateColourFrames,
  regenerateGoldenFrames,
} from "../../src/tui/cockpit/capture.js";
import { loadDemoCaptures } from "../../src/tui/cockpit/demo.js";
import {
  dispatchRunKey,
  dispatchRunSurfaceKey,
  initialRunInteractionState,
  openingRunInteractionState,
  openingRunSurfaceState,
  formatKeybarEntries,
  keybarEntries,
  projectRunKeyEntries,
  reconcileRunInteraction,
  resolveRunKeyBinding,
  RUN_INPUT_BINDINGS,
  RUN_KEY_BINDINGS,
  RUN_SIDE_RAIL_COLUMN_FLOOR,
  selectableRunViewRowIds,
  type RunInteractionState,
  type RunKeyBinding,
  type RunKeyEvent,
} from "../../src/tui/cockpit/keys.js";
import * as keyContract from "../../src/tui/cockpit/keys.js";
import {
  COCKPIT_COLUMN_FLOOR,
  COCKPIT_ROW_FLOOR,
  planFrame,
  SIDEBAR_COLUMN_FLOOR,
} from "../../src/tui/cockpit/layout.js";
import {
  deriveRunCockpitData,
  deriveRunViewRows,
  runKeyColumns,
  RunCockpitFrame,
  type RunCockpitData,
} from "../../src/tui/cockpit/run-cockpit.js";

const SURFACE_DECLARED_BRANCH_MODULES = [
  "src/tui/cockpit/keys.ts",
  "src/tui/cockpit/live.ts",
  "src/tui/cockpit/components.tsx",
  "src/tui/cockpit/capture.ts",
  "src/tui/cockpit/run-cockpit.tsx",
] as const;

type SurfaceBranchModule = typeof SURFACE_DECLARED_BRANCH_MODULES[number];
type LedgerTestFile =
  | "tests/cockpit/keys.test.ts"
  | "tests/cockpit/live.test.ts"
  | "tests/cockpit/views.test.ts"
  | "tests/cockpit/components.test.ts";

type BranchLedgerEntry = {
  readonly branch: string;
  readonly module: SurfaceBranchModule;
  readonly testFile: LedgerTestFile;
  readonly testTitle: string;
  readonly breakProduction: (source: string) => string;
};

const KEYS_TEST = "tests/cockpit/keys.test.ts" as const;
const LIVE_TEST = "tests/cockpit/live.test.ts" as const;
const VIEWS_TEST = "tests/cockpit/views.test.ts" as const;
const COMPONENTS_TEST = "tests/cockpit/components.test.ts" as const;
const KEY_HANDLERS_TITLE =
  "test: each advertised key of the run surface changes observable state when it is sent";
const WIDTH_ADVERTISEMENT_TITLE =
  "test: a key that cannot act at a supported width is not advertised at that width, and a key advertised at a supported width changes observable state in that exact context";
const NARROWEST_WIDTH_TITLE =
  "test: at the narrowest supported width every advertised key's effect is visible in the drawn frame";
const DRAWN_TAB_WORD_TITLE =
  "test: the drawn keybar names the tab the Tab key will draw, so the surface's own switch is advertised by its action rather than by a frozen word";
const SURFACE_ROUND_TRIP_TITLE =
  "test: tabbing away and back returns each tab to the state it was left in, so the surface's switch carries each tab's own state across the round trip";
const LIVE_PROMPT_EDIT_TITLE =
  "test: two characters typed into the filter prompt before any redraw both land in the query in order, driven through the live surface";
const NUMBER_JUMP_TITLE =
  "test: entering the selected view's rows with enter or the right arrow and backing out with escape or the left arrow returns focus to the sidebar with the same view selected, and each number key jumps straight to its view";
const PROMPT_TRANSITIONS_TITLE =
  "the filter prompt's edit, delete, apply and cancel bindings each execute their registered production transition";
const CAPTURE_BOUNDARY_TITLE =
  "the capture boundary sends an interactive TTY through the frame renderer and every non-interactive surface through the plain renderer";
const FRAME_DETAIL_TITLE =
  "a selected production journal row opens through the frame's detail branch";

function replaceProductionBranch(
  source: string,
  before: string,
  after: string,
  occurrence = 0,
): string {
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= source.length) {
    const offset = source.indexOf(before, cursor);
    if (offset < 0) break;
    offsets.push(offset);
    cursor = offset + before.length;
  }
  const offset = offsets[occurrence];
  if (offset === undefined) {
    throw new Error(
      `production branch anchor ${JSON.stringify(before)} occurrence ${occurrence} is absent`,
    );
  }
  return source.slice(0, offset) + after + source.slice(offset + before.length);
}

const BRANCH_LEDGER = [
  {
    branch: "run key handler: rail movement",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: KEY_HANDLERS_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "railSelection: moveRunViewSelection(state.railSelection, delta),",
      "railSelection: state.railSelection,",
    ),
  },
  {
    branch: "run key handler: rail open",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: KEY_HANDLERS_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "if (railFocused(state, columns)) return openView(state, state.railSelection);",
      "if (railFocused(state, columns)) return state;",
    ),
  },
  {
    branch: "run key handler: a hidden rail leaves the arrow the views themselves",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: NARROWEST_WIDTH_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "      if (!runSideRailVisible(columns) && state.activeView === \"run\") {",
      "      if (false && !runSideRailVisible(columns) && state.activeView === \"run\") {",
    ),
  },
  {
    branch: "run key handler: back out of a view the rail's width hides",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: WIDTH_ADVERTISEMENT_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "      if (state.tab === \"watch\" && !runSideRailVisible(columns)) {",
      "      if (state.tab === \"watch\" && false && !runSideRailVisible(columns)) {",
    ),
  },
  {
    branch: "run key handler: back to the sidebar",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: "test: following that is on before a jump to another view and back is still on after the return",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "      return { ...state, panel: SIDEBAR_PANEL };",
      "      return state;",
    ),
  },
  {
    branch: "run key handler: tab switch",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: KEY_HANDLERS_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "  return { ...state, tab: state.tab === \"watch\" ? \"setup\" : \"watch\" };",
      "  return state;",
    ),
  },
  {
    branch: "run key projection: the tab key's word is the tab it draws",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: DRAWN_TAB_WORD_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "\n        ?? binding.destination?.(context.interaction)",
      "",
    ),
  },
  {
    branch: "run key handler: a digit pressed on the sections tab lands on its view",
    module: "src/tui/cockpit/keys.ts",
    testFile: VIEWS_TEST,
    testTitle: NUMBER_JUMP_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "    return state.tab === \"setup\" ? { ...jumped, tab: \"watch\" } : jumped;",
      "    return jumped;",
    ),
  },
  {
    branch: "run surface: the waiting tab comes forward with its own state",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: SURFACE_ROUND_TRIP_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "      interaction: { ...surface.stashed, tab: next.tab },",
      "      interaction: { ...surface.interaction, tab: next.tab },",
    ),
  },
  {
    branch: "live delivery: every key reaches the one surface dispatcher",
    module: "src/tui/cockpit/live.ts",
    testFile: LIVE_TEST,
    testTitle: LIVE_PROMPT_EDIT_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "      const next = dispatchRunSurfaceKey(",
      "      if (current.interaction.filterPrompt) return current;\n      const next = dispatchRunSurfaceKey(",
    ),
  },
  {
    branch: "run key handler: help",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: KEY_HANDLERS_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "apply: (state) => ({ ...state, help: !state.help }),",
      "apply: (state) => state,",
      0,
    ),
  },
  {
    branch: "run key handler: quit",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: KEY_HANDLERS_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "apply: (state) => ({ ...state, quit: true }),",
      "apply: (state) => state,",
      0,
    ),
  },
  {
    branch: "run key handler: follow",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: "test: following that is on before a jump to another view and back is still on after the return",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "        ? { ...state, follow: !state.follow }\n        : state,",
      "        ? state\n        : state,",
    ),
  },
  {
    branch: "run key handler: open filter prompt",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: "test: after every advertised key that acts on the selected row is sent to an empty view, the interaction state equals what it was before, field by field, and every other advertised key sent to that empty view still does its own job",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "        : { ...state, filterPrompt: true, filterQuery: \"\" },",
      "        : state,",
    ),
  },
  {
    branch: "run key handler: view jump",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: "test: after every advertised key that acts on the selected row is sent to an empty view, the interaction state equals what it was before, field by field, and every other advertised key sent to that empty view still does its own job",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "    const jumped = openView(state, RUN_VIEWS_INDEX[view.id]);",
      "    const jumped = state;",
    ),
  },
  {
    branch: "filter prompt handler: edit",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: PROMPT_TRANSITIONS_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "filterQuery: state.filterQuery + input,",
      "filterQuery: state.filterQuery,",
    ),
  },
  {
    branch: "filter prompt handler: delete",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: PROMPT_TRANSITIONS_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "filterQuery: [...state.filterQuery].slice(0, -1).join(\"\"),",
      "filterQuery: state.filterQuery,",
    ),
  },
  {
    branch: "filter prompt handler: apply",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: PROMPT_TRANSITIONS_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "apply: (state) => ({ ...state, filterPrompt: false }),",
      "apply: (state) => state,",
    ),
  },
  {
    branch: "filter prompt handler: cancel",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: PROMPT_TRANSITIONS_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "apply: (state) => ({ ...state, filterPrompt: false, filterQuery: \"\" }),",
      "apply: (state) => state,",
    ),
  },
  {
    branch: "run key projection: contextual availability",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: WIDTH_ADVERTISEMENT_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "    .filter((binding) => binding.available?.(context) ?? true)",
      "    .filter(() => true)",
    ),
  },
  {
    branch: "run interaction reconciliation: retained selection",
    module: "src/tui/cockpit/keys.ts",
    testFile: KEYS_TEST,
    testTitle: "test: the selected row is still the same row after a change that removes a row above it, after one that adds a row above it, and after one that reorders without changing the count",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "  const selection = state.selection !== null && available.has(state.selection)\n    ? state.selection\n    : null;",
      "  const selection = null;",
    ),
  },
  {
    branch: "live delivery: transitions read current state",
    module: "src/tui/cockpit/live.ts",
    testFile: LIVE_TEST,
    testTitle: "test: two back-to-back moves delivered before any redraw advance the selection twice, driven through the live surface rather than a helper that waits between keys",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "    const next = apply(surface);",
      "    const next = apply({ ...surface, interaction: initialRunInteractionState() });",
    ),
  },
  {
    branch: "live delivery: refresh installs refreshed data",
    module: "src/tui/cockpit/live.ts",
    testFile: LIVE_TEST,
    testTitle: "test: the refresh-first ordering is proved by a delivery seam that applies the refresh to the live state before the key, so an arm that only touches the disk while both inputs run in one turn makes the assertion fail",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "          data: refreshed,",
      "          data: current.data,",
    ),
  },
  {
    branch: "capture: interactive versus plain boundary",
    module: "src/tui/cockpit/capture.ts",
    testFile: KEYS_TEST,
    testTitle: CAPTURE_BOUNDARY_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "  if (!interactive || options.output.isTTY !== true || ci || layout.renderer === \"plain\") {",
      "  if (false && (!interactive || options.output.isTTY !== true || ci || layout.renderer === \"plain\")) {",
    ),
  },
  {
    branch: "capture: plain run projection",
    module: "src/tui/cockpit/capture.ts",
    testFile: KEYS_TEST,
    testTitle: "test: every surface advertises exactly the roster a substituted projection returns, including entries no live binding defines and entries wider than the terminal, so a surface that filters, amends, bypasses or clips the projection makes the assertion fail",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "runKeyProjection({",
      "projectRunKeyEntries({",
    ),
  },
  {
    branch: "components: content-weighted column allocation",
    module: "src/tui/cockpit/components.tsx",
    testFile: COMPONENTS_TEST,
    testTitle: "test: in a two-column band the column whose longest line is longer is given more columns than its sibling rather than an equal share",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "  const preferred = content.map((column) =>\n    longestBandLine(column) + chromeColumns\n  );",
      "  const preferred = content.map(() => minimumReadableColumns);",
    ),
  },
  {
    branch: "components: focused panel treatment",
    module: "src/tui/cockpit/components.tsx",
    testFile: COMPONENTS_TEST,
    testTitle: "test: a focused panel is distinguishable from an unfocused one by both its border treatment and a title marker, and remains distinguishable when colour is disabled",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "borderStyle={focused ? \"double\" : \"round\"}",
      "borderStyle=\"round\"",
    ),
  },
  {
    branch: "components: active state glyph",
    module: "src/tui/cockpit/components.tsx",
    testFile: COMPONENTS_TEST,
    testTitle: "test: no component renders a bracket toggle, and active and inactive states use the established glyph vocabulary",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "glyph: GLYPHS.toggleActive,",
      "glyph: GLYPHS.toggleInactive,",
    ),
  },
  {
    branch: "components: empty sparkline bucket",
    module: "src/tui/cockpit/components.tsx",
    testFile: COMPONENTS_TEST,
    testTitle: "test: an empty bucket renders as a gap rather than as a zero-height bar indistinguishable from a low one",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "if (sample === null) return <Text key={`gap:${index}`}> </Text>;",
      "if (sample === null) return <Text key={`gap:${index}`}>{SPARKLINE_GLYPHS[0]}</Text>;",
    ),
  },
  {
    branch: "components: width-safe key roster wrapping",
    module: "src/tui/cockpit/components.tsx",
    testFile: KEYS_TEST,
    testTitle: "test: at every supported width down to the floor the drawn interactive advertisement parses back to exactly the projected roster, with nothing clipped by the drawing of it",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "  if (stringWidth(formatted) <= width) return [formatted];",
      "  return [formatted];",
    ),
  },
  {
    branch: "frame: genuinely empty view",
    module: "src/tui/cockpit/run-cockpit.tsx",
    testFile: KEYS_TEST,
    testTitle: "test: only the journal view draws journal rows, and a view whose own derivation produces nothing draws its genuinely empty state rather than borrowed rows",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "  if (rows.length === 0) {",
      "  if (false && rows.length === 0) {",
    ),
  },
  {
    branch: "frame: opened row detail",
    module: "src/tui/cockpit/run-cockpit.tsx",
    testFile: KEYS_TEST,
    testTitle: FRAME_DETAIL_TITLE,
    breakProduction: (source) => replaceProductionBranch(
      source,
      "  if (opened !== undefined) {",
      "  if (opened !== undefined && interaction.opened === \"__broken_detail__\") {",
    ),
  },
  {
    branch: "frame: overview help overlay",
    module: "src/tui/cockpit/run-cockpit.tsx",
    testFile: KEYS_TEST,
    testTitle: "test: the help overlay drawn at the narrowest supported width and the shortest supported height together contains every advertised entry and stays within the terminal",
    breakProduction: (source) => replaceProductionBranch(
      replaceProductionBranch(
        source,
        "  if (interaction?.help === true) {",
        "  if (false && interaction?.help === true) {",
      ),
      "  if (interaction?.help === true) {",
      "  if (false && interaction?.help === true) {",
    ),
  },
  {
    branch: "frame: active view selects its own panel",
    module: "src/tui/cockpit/run-cockpit.tsx",
    testFile: KEYS_TEST,
    testTitle: "test: only the journal view draws journal rows, and a view whose own derivation produces nothing draws its genuinely empty state rather than borrowed rows",
    breakProduction: (source) => replaceProductionBranch(
      source,
      ": activeView === \"run\"",
      ": activeView !== \"run\"",
    ),
  },
  {
    branch: "frame: selection-following row window",
    module: "src/tui/cockpit/run-cockpit.tsx",
    testFile: KEYS_TEST,
    testTitle: "test: the window that follows the selection lives on the surface that carries the selection, asserted by selecting past the screen there and observing the window move in the drawn frame",
    breakProduction: (source) => replaceProductionBranch(
      source,
      "  const offset = selectedIndex < limit\n    ? 0\n    : selectedIndex - limit + 1;",
      "  const offset = 0;",
    ),
  },
] as const satisfies readonly BranchLedgerEntry[];

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VITEST_BIN = join(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs");

type NamedTestResult = {
  readonly status: number | null;
  readonly output: string;
};

function makeBranchSandbox(): string {
  const sandbox = mkdtempSync(join(tmpdir(), "tickmarkr-branch-ledger-"));
  for (const directory of ["src", "tests", "fixtures"] as const) {
    cpSync(join(PROJECT_ROOT, directory), join(sandbox, directory), { recursive: true });
  }
  for (const file of ["package.json", "tsconfig.json", "vitest.config.ts"] as const) {
    copyFileSync(join(PROJECT_ROOT, file), join(sandbox, file));
  }
  symlinkSync(join(PROJECT_ROOT, "node_modules"), join(sandbox, "node_modules"), "dir");
  return sandbox;
}

function runNamedLedgerTest(
  sandbox: string,
  entry: BranchLedgerEntry,
): Promise<NamedTestResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      VITEST_BIN,
      "run",
      entry.testFile,
      "--configLoader",
      "runner",
      "--reporter=verbose",
      "-t",
      entry.testTitle,
    ], {
      cwd: sandbox,
      env: {
        ...process.env,
        // OBS-886 (the OBS-854 precedent): every nested run is a whole vitest process whose fork pool pre-spawns
        // min(cpus-1, maxForks) workers; one ledger entry at a time inside a PARALLEL fork ran ≈60 s and starved
        // the worker↔host birpc window (post-summary "Timeout calling onTaskUpdate" with every test green).
        // The entries are awaited serially, so one fork per child costs nothing and ends the storm.
        VITEST_MAX_FORKS: "1",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > 16 * 1024 * 1024) {
        child.kill("SIGKILL");
        reject(new Error(`${entry.branch}: named test output exceeded 16 MiB`));
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${entry.branch}: named test exceeded 45 seconds`));
    }, 45_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, output });
    });
  });
}

function assertNamedTestPassed(entry: BranchLedgerEntry, result: NamedTestResult): void {
  const output = stripAnsi(result.output);
  if (
    result.status !== 0
    || !output.includes(entry.testTitle)
    || !/Tests\s+1 passed\b/u.test(output)
  ) {
    throw new Error(
      `${entry.branch}: named baseline test did not execute and pass\n${output}`,
    );
  }
}

function assertNamedTestFailed(entry: BranchLedgerEntry, result: NamedTestResult): void {
  const output = stripAnsi(result.output);
  if (
    result.status === 0
    || !output.includes(entry.testTitle)
    || !/Tests\s+1 failed\b/u.test(output)
  ) {
    throw new Error(
      `${entry.branch}: named test did not execute and fail against its broken production branch\n${output}`,
    );
  }
}

function deleteNamedTest(source: string, fileName: string, title: string): string {
  const sourceFile = createSourceFile(
    fileName,
    source,
    ScriptTarget.Latest,
    true,
    ScriptKind.TS,
  );
  let statement: ExpressionStatement | undefined;
  const visit = (node: Node): void => {
    if (
      isExpressionStatement(node)
      && isCallExpression(node.expression)
      && isIdentifier(node.expression.expression)
      && node.expression.expression.text === "test"
      && isStringLiteral(node.expression.arguments[0])
      && node.expression.arguments[0].text === title
    ) {
      if (statement !== undefined) {
        throw new Error(`named test is registered more than once: ${title}`);
      }
      statement = node;
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  if (statement === undefined) throw new Error(`named test is absent: ${title}`);
  return source.slice(0, statement.getFullStart()) + source.slice(statement.getEnd());
}

async function proveLedgerEntry(
  sandbox: string,
  entry: BranchLedgerEntry,
  passed: Set<string>,
  options: { readonly deleteNamedTest?: boolean } = {},
): Promise<void> {
  const testIdentity = `${entry.testFile}\0${entry.testTitle}`;
  if (!passed.has(testIdentity)) {
    assertNamedTestPassed(entry, await runNamedLedgerTest(sandbox, entry));
    passed.add(testIdentity);
  }

  const modulePath = join(sandbox, entry.module);
  const originalProduction = readFileSync(modulePath, "utf8");
  const brokenProduction = entry.breakProduction(originalProduction);
  if (brokenProduction === originalProduction) {
    throw new Error(`${entry.branch}: broken arm did not change production module ${entry.module}`);
  }

  const testPath = join(sandbox, entry.testFile);
  const originalTest = readFileSync(testPath, "utf8");
  writeFileSync(modulePath, brokenProduction);
  try {
    if (options.deleteNamedTest === true) {
      writeFileSync(
        testPath,
        deleteNamedTest(originalTest, entry.testFile, entry.testTitle),
      );
    }
    assertNamedTestFailed(entry, await runNamedLedgerTest(sandbox, entry));
  } finally {
    writeFileSync(modulePath, originalProduction);
    writeFileSync(testPath, originalTest);
  }
}

async function withBranchSandbox(
  run: (sandbox: string) => Promise<void>,
): Promise<void> {
  const sandbox = makeBranchSandbox();
  try {
    await run(sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

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
  renderComponent(createElement(KeyRoster, {
    entries: keybarEntries(RUN_KEY_BINDINGS),
    width: 120,
  }));

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

type ProjectedEntry = { readonly key: string; readonly label: string };
type ProjectionContext = {
  readonly interaction: RunInteractionState;
  readonly columns: number;
};
type RunKeyProjection = (context: ProjectionContext) => readonly ProjectedEntry[];
type T13KeyContract = {
  readonly RUN_INPUT_BINDINGS: readonly RunKeyBinding[];
  readonly RUN_FILTER_PROMPT_BINDINGS: readonly RunKeyBinding[];
  readonly formatKeybarEntries: (entries: readonly ProjectedEntry[]) => string;
  readonly projectRunKeyEntries: (
    context: ProjectionContext,
    bindings?: readonly RunKeyBinding[],
  ) => readonly ProjectedEntry[];
  readonly runPanelFocusOrder: (columns: number) => readonly ("CONTENT" | "VIEWS")[];
  readonly runSideRailVisible: (columns: number) => boolean;
};
type T13ComponentContract = {
  readonly keyRosterLines: (
    entries: readonly ProjectedEntry[],
    columns: number,
  ) => readonly string[];
};

function t13Keys(): T13KeyContract {
  const contract = keyContract as unknown as Partial<T13KeyContract>;
  expect(typeof contract.projectRunKeyEntries).toBe("function");
  expect(typeof contract.formatKeybarEntries).toBe("function");
  expect(typeof contract.runPanelFocusOrder).toBe("function");
  expect(typeof contract.runSideRailVisible).toBe("function");
  expect(Array.isArray(contract.RUN_FILTER_PROMPT_BINDINGS)).toBe(true);
  return contract as T13KeyContract;
}

function t13Components(): T13ComponentContract {
  const contract = cockpitComponents as unknown as Partial<T13ComponentContract>;
  expect(typeof contract.keyRosterLines).toBe("function");
  return contract as T13ComponentContract;
}

/** The rows the frame supplies to the projection, supplied the same way here. */
function frameRowIds(interaction: RunInteractionState): readonly string[] {
  return selectableRunViewRowIds(
    interaction.activeView,
    deriveRunViewRows(RUN_DATA, interaction.activeView, interaction.filterQuery)
      .map((row) => row.id),
  );
}

function renderRunContext(
  interaction: RunInteractionState,
  columns: number,
  rows: number,
  keyProjection?: RunKeyProjection,
  data: RunCockpitData = RUN_DATA,
): Promise<string> {
  const props = { data, columns, rows, interaction, keyProjection };
  return renderComponent(
    createElement(
      RunCockpitFrame as unknown as (props: typeof props) => ReactNode,
      props,
    ),
    columns,
  );
}

function memoryStream(isTTY: boolean, columns: number, rows: number) {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
    writes: string[];
  };
  output.isTTY = isTTY;
  output.columns = columns;
  output.rows = rows;
  output.writes = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    output.writes.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;
  return output;
}

function frameLines(frame: string): string[] {
  return stripAnsi(frame).trimEnd().split("\n");
}

function drawnRosterLines(
  frame: string,
  entries: readonly ProjectedEntry[],
): readonly string[] {
  const firstEntry = entries[0];
  if (firstEntry === undefined) return [];
  const start = frameLines(frame).findLastIndex((line) =>
    line.startsWith(`${firstEntry.key} `)
  );
  if (start < 0) return [];
  return frameLines(frame).slice(start);
}

function parseDrawnRoster(lines: readonly string[]): string {
  return lines.map((line, index) => {
    if (index === 0) return line;
    if (!line.startsWith(BAND_CONTINUATION_PREFIX)) {
      throw new Error(`roster continuation lacks marker: ${JSON.stringify(line)}`);
    }
    return line.slice(BAND_CONTINUATION_PREFIX.length);
  }).join("");
}

function drawnKeysRailLines(frame: string): readonly string[] {
  const lines = frameLines(frame);
  const titleRow = lines.findIndex((line) => line.includes("│ KEYS "));
  if (titleRow < 0) return [];
  const right = lines[titleRow]!.lastIndexOf("│");
  const left = lines[titleRow]!.lastIndexOf("│", right - 1);
  const body: string[] = [];
  for (const line of lines.slice(titleRow + 1)) {
    if (line[left] !== "│" || line[right] !== "│") break;
    body.push(line.slice(left + 2, right - 1).trimEnd());
  }
  while (body.at(-1) === "") body.pop();
  return body;
}

/** The key events a terminal sends, one per advertised key. */
const EVENTS = {
  moveDown: { input: "", key: { downArrow: true } },
  moveUp: { input: "", key: { upArrow: true } },
  // Ink preserves carriage return as input because "return" is not in its
  // non-alphanumeric key list; prompt matchers must handle this live shape.
  open: { input: "\r", key: { return: true } },
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
 * change its own label promises in the context that owns it: rail movement and
 * opening, view back-navigation, two-way focus, global view jumps, the passive
 * overview's follow state, and filtering only after a list view is open.
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
  const railFocused = { ...initial, panel: 1 };
  const moved = move.apply(railFocused, EVENTS.moveDown);
  expect(moved.railSelection).toBe(1);
  const movedFrame = await drawRunFrame(moved);
  expect(movedFrame).toContain(`${GLYPHS.pointer} Tasks`);
  const movedUp = move.apply(moved, EVENTS.moveUp);
  expect(movedUp.railSelection).toBe(0);
  expect(await drawRunFrame(movedUp)).toBe(await drawRunFrame(railFocused));

  const open = mustResolve(bindings, EVENTS.open);
  expect(open.label).toBe("Open");
  const opened = open.apply(moved, EVENTS.open);
  expect(opened.activeView).toBe("tasks");
  const openedFrame = await drawRunFrame(opened);
  expect(openedFrame).not.toBe(movedFrame);
  expect(openedFrame).toContain(`${GLYPHS.pointer} TASKS`);
  expect(openedFrame).not.toContain("PROGRESS");

  const back = mustResolve(bindings, EVENTS.back);
  expect(back.label).toBe("Back");
  const returned = back.apply(opened, EVENTS.back);
  // Backing out of a view returns focus to the sidebar holding it, with that
  // same view still selected there.
  expect(returned.activeView).toBe("tasks");
  expect(returned.railSelection).toBe(1);
  const returnedFrame = await drawRunFrame(returned);
  expect(returnedFrame).not.toBe(openedFrame);
  expect(returnedFrame).toContain(`${GLYPHS.pointer} VIEWS`);
  expect(returnedFrame).toContain(`${GLYPHS.pointer} Tasks`);
  expect(returnedFrame).not.toContain(`${GLYPHS.pointer} TASKS`);

  const panel = mustResolve(bindings, EVENTS.panel);
  const tabbed = panel.apply(opened, EVENTS.panel);
  expect(tabbed.tab).toBe("setup");
  const tabbedFrame = await drawRunFrame(tabbed);
  expect(tabbedFrame).not.toBe(openedFrame);
  expect(tabbedFrame).toContain("SECTIONS");
  expect(tabbedFrame).not.toContain(`${GLYPHS.pointer} TASKS`);
  expect(await drawRunFrame(panel.apply(tabbed, EVENTS.panel))).toBe(openedFrame);

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
  const quitting = quit.apply(initial, EVENTS.quit);
  expect(quitting.quit).toBe(true);
  expect(await drawRunFrame(quitting)).toContain(
    `${GLYPHS.toggleActive} Quit requested`,
  );

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
  // The overview owns no list, so / is inert there.
  expect(filter.apply(initial, EVENTS.filter)).toBe(initial);
  const prompting = filter.apply(opened, EVENTS.filter);
  expect(prompting.filterPrompt).toBe(true);
  const promptFrame = await drawRunFrame(prompting);
  expect(promptFrame).not.toBe(openedFrame);

  // The prompt's own scope is not part of the roster under test here, so its
  // transitions are dispatched through the whole registry, as production does.
  const typed = dispatchRunKey({ input: "x", key: {} }, prompting, RUN_INPUT_BINDINGS)!;
  expect(typed.filterQuery).toBe("x");
  const cancelled = dispatchRunKey(
    { input: "", key: { escape: true } },
    typed,
    RUN_INPUT_BINDINGS,
  )!;
  expect(cancelled.filterQuery).toBe("");
  expect(await drawRunFrame(cancelled)).toBe(openedFrame);

}

describe("run surface keys", () => {
  test("test: the entries the keybar draws are derived from the registered handlers rather than from a list written beside them", async () => {
    const derived = keybarEntries(RUN_KEY_BINDINGS);

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
    expect(keybarEntries(RUN_KEY_BINDINGS).map((item) => item.key)).toEqual([
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

  test("test: the keybar is projected from the live binding registry, so removing a handler removes its advertisement and every advertised key has a handler", async () => {
    const drawnKeys = async (
      interaction: RunInteractionState,
      bindings: readonly RunKeyBinding[] = RUN_INPUT_BINDINGS,
    ): Promise<readonly string[]> => {
      const entries = projectRunKeyEntries(
        { interaction, columns: 140, rowIds: frameRowIds(interaction) },
        bindings,
      );
      const frame = await renderRunContext(
        interaction,
        140,
        24,
        (context) => projectRunKeyEntries(context, bindings),
      );
      // What the keybar drew, parsed back out of the frame itself.
      expect(parseDrawnRoster(drawnRosterLines(frame, entries)))
        .toBe(formatKeybarEntries(entries));
      return entries.map((entry) => entry.key);
    };

    const gates: RunInteractionState = {
      ...initialRunInteractionState(),
      activeView: "gates",
      railSelection: 2,
    };
    const advertised = await drawnKeys(gates);
    expect(advertised).toContain("?");

    // Every advertised key is owned by a handler in the registry that produced
    // it — an advertisement with nothing behind it is not expressible.
    for (const key of advertised) {
      expect(
        RUN_INPUT_BINDINGS.some((binding) => binding.key === key),
        key,
      ).toBe(true);
    }

    // And the projection runs the other way too: in each of these contexts, a
    // key the keybar leaves out is a key nothing dispatches, and every key it
    // draws does dispatch. The advertisement is the whole roster of what acts.
    const contexts: readonly (readonly [string, RunInteractionState, number])[] = [
      ["gates", gates, 140],
      ["journal", { ...gates, activeView: "journal", railSelection: 3 }, 140],
      ["setup", openingRunInteractionState("setup"), 140],
      ["narrow", initialRunInteractionState(), COCKPIT_COLUMN_FLOOR],
    ];
    const eventsByKey: Readonly<Record<string, RunKeyEvent>> = {
      "↑↓": EVENTS.moveDown,
      "⏎": EVENTS.open,
      "←": EVENTS.back,
      Tab: EVENTS.panel,
      "?": EVENTS.help,
      q: EVENTS.quit,
      f: EVENTS.follow,
      "/": EVENTS.filter,
      "1–5": { input: "2", key: {} },
    };
    for (const [name, interaction, columns] of contexts) {
      const rowIds = frameRowIds(interaction);
      const keys = projectRunKeyEntries({ interaction, columns, rowIds })
        .map((entry) => entry.key);
      for (const [key, event] of Object.entries(eventsByKey)) {
        const dispatched = dispatchRunKey(
          event,
          interaction,
          RUN_INPUT_BINDINGS,
          rowIds,
          columns,
        );
        expect(dispatched !== undefined, `${name}: ${key}`).toBe(keys.includes(key));
      }
    }

    // And removing a handler removes its advertisement from the drawn keybar.
    const withoutHelp = RUN_INPUT_BINDINGS.filter((binding) => binding.key !== "?");
    expect(await drawnKeys(gates, withoutHelp)).not.toContain("?");
    // The removed key no longer dispatches either.
    expect(dispatchRunKey(EVENTS.help, gates, withoutHelp)).toBeUndefined();
  });

  test("test: a view with nothing to open does not advertise open, asserted on the drawn keybar in that view", async () => {
    // A view whose own derivation produces rows advertises the open key once a
    // row is selected; the same view with nothing to open does not.
    const gatesRows = deriveRunViewRows(RUN_DATA, "gates", "");
    expect(gatesRows.length).toBeGreaterThan(0);
    const withRow: RunInteractionState = {
      ...initialRunInteractionState(),
      activeView: "gates",
      railSelection: 2,
      selection: gatesRows[0]!.id,
    };
    const bare = productionJournalData([{ event: "one" }, { event: "two" }]);
    const rowless: RunInteractionState = {
      ...initialRunInteractionState(),
      activeView: "gates",
      railSelection: 2,
    };
    expect(deriveRunViewRows(bare, "gates", "")).toEqual([]);

    const keybarOf = async (
      interaction: RunInteractionState,
      data: RunCockpitData,
    ): Promise<string> => {
      const entries = projectRunKeyEntries({
        interaction,
        columns: 140,
        rowIds: selectableRunViewRowIds(
          interaction.activeView,
          deriveRunViewRows(data, interaction.activeView, interaction.filterQuery)
            .map((row) => row.id),
        ),
      });
      const frame = await renderRunContext(interaction, 140, 24, undefined, data);
      return parseDrawnRoster(drawnRosterLines(frame, entries));
    };

    expect(await keybarOf(withRow, RUN_DATA)).toContain("⏎ Open");
    expect(await keybarOf(rowless, bare)).not.toContain("⏎ Open");
    // The journal has rows and still opens nothing: it is a tail, not a list.
    expect(await keybarOf({
      ...initialRunInteractionState(),
      activeView: "journal",
      railSelection: 3,
    }, RUN_DATA)).not.toContain("⏎ Open");
  });

  test("test: the drawn keybar names the tab the Tab key will draw, so the surface's own switch is advertised by its action rather than by a frozen word", async () => {
    expect(await drawRunKeybar()).toContain(
      "↑↓ Move · ⏎ Open · ← Back · Tab Decisions · ? Help · q Quit · f Follow · / Filter",
    );

    // The promise is resolved against the live state, not frozen beside the
    // key: on the watch tab it names Decisions, on the Decisions tab it names
    // Watch — asserted on the roster slice the keybar band draws.
    const components = t13Components();
    const drawnFor = (tab: "watch" | "setup"): string => {
      const interaction = openingRunInteractionState(tab);
      const entries = projectRunKeyEntries({
        interaction,
        columns: 120,
        rowIds: frameRowIds(interaction),
      });
      return components.keyRosterLines(entries, 120).join("\n");
    };
    expect(drawnFor("watch")).toContain("Tab Decisions");
    expect(drawnFor("watch")).not.toContain("Tab Setup");
    expect(drawnFor("setup")).toContain("Tab Watch");
  });

  test("test: tabbing away and back returns each tab to the state it was left in, so the surface's switch carries each tab's own state across the round trip", () => {
    const surface = openingRunSurfaceState();
    // The rail owns focus on open, so the first arrow moves the watch tab's
    // view selection: the state the watch tab is left in.
    const left = dispatchRunSurfaceKey(EVENTS.moveDown, surface);
    expect(left?.interaction.railSelection).toBe(1);

    // Tab draws the tab that was waiting — with its own state, not watch's.
    const away = dispatchRunSurfaceKey(EVENTS.panel, left!);
    expect(away?.interaction.tab).toBe("setup");
    expect(away?.interaction.railSelection).toBe(0);

    // The setup tab is left with a mark of its own.
    const leftSetup = dispatchRunSurfaceKey(EVENTS.moveDown, away!);
    expect(leftSetup?.interaction.railSelection).toBe(1);

    // Tabbing back returns watch exactly as it was left, and setup likewise.
    const back = dispatchRunSurfaceKey(EVENTS.panel, leftSetup!);
    expect(back?.interaction.tab).toBe("watch");
    expect(back?.interaction.railSelection).toBe(1);
    const roundTrip = dispatchRunSurfaceKey(EVENTS.panel, back!);
    expect(roundTrip?.interaction.tab).toBe("setup");
    expect(roundTrip?.interaction.railSelection).toBe(1);
  });

  test("test: the keybar hint advertises Tab Decisions at every size the plan draws the hint", () => {
    // The surface opens on the watch tab, so the destination Tab promises is
    // the second tab, by its real name. The keybar band owns one row of the
    // plan at every frame size, and RunKeybar draws the roster's first
    // lossless slice there — so the slice is what the plan draws, and the
    // hint must be on it at every size, never the retired "Setup" word.
    const interaction = openingRunInteractionState("watch");
    const components = t13Components();
    let sizes = 0;
    for (let columns = 40; columns <= 220; columns += 1) {
      for (let rows = 14; rows <= 50; rows += 1) {
        const plan = planFrame({ columns, rows });
        if (plan.kind !== "frame") continue;
        expect(plan.rowSpans.keybar, `${columns}x${rows}`).toBe(1);
        sizes += 1;
        const entries = projectRunKeyEntries({
          interaction,
          columns,
          rowIds: frameRowIds(interaction),
        });
        const drawn = components.keyRosterLines(entries, columns)[0] ?? "";
        expect(drawn, `${columns}x${rows}`).toContain("Tab Decisions");
        expect(drawn, `${columns}x${rows}`).not.toContain("Tab Setup");
      }
    }
    expect(sizes).toBeGreaterThan(0);
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
    // The bytes still committed are pinned directly; rendered run and colour
    // cases are absent until operator UAT, so rendering them is coverage.
    const framesDirectory = new URL("../fixtures/cockpit/frames/", import.meta.url);
    for (const frame of await regenerateGoldenFrames()) {
      const committed = readFileSync(
        new URL(frame.fixture, framesDirectory),
        "utf8",
      );
      expect(goldenFrameMatchesCommitted(frame, committed), frame.fixture)
        .toBe(true);
    }
    for (const frame of await regenerateColourFrames()) {
      expect(frame.emitted, frame.fixture).toBe(frame.output);
    }
  });

  test("test: the keys the non-interactive surface advertises are the keys the interactive one advertises, drawn from one registry rather than from a second list", async () => {
    const contract = t13Keys();
    const interaction = initialRunInteractionState();
    const columns = 140;
    const entries = contract.projectRunKeyEntries({ interaction, columns });
    const interactive = await renderRunContext(interaction, columns, 24);
    expect(drawnRosterLines(interactive, entries)).toEqual(
      t13Components().keyRosterLines(entries, columns),
    );

    const output = memoryStream(false, columns, 24);
    const emission = await captureCockpitOutput({
      cockpit: "run",
      output: output as unknown as NodeJS.WriteStream,
      binaryVersion: "0.0.0-test",
      columns,
      rows: 24,
      interactive: false,
      captures: loadDemoCaptures(),
    });
    expect(frameLines(emission.output).at(-1)).toBe(
      `keys ${contract.formatKeybarEntries(entries)}`,
    );
  });

  test("the capture boundary sends an interactive TTY through the frame renderer and every non-interactive surface through the plain renderer", async () => {
    const interactiveOutput = memoryStream(true, 140, 24);
    const interactive = await captureCockpitOutput({
      cockpit: "run",
      output: interactiveOutput as unknown as NodeJS.WriteStream,
      binaryVersion: "0.0.0-test",
      columns: 140,
      rows: 24,
      interactive: true,
      captures: loadDemoCaptures(),
      frameRenderer: async () => "FRAME BRANCH\n",
      plainRenderer: () => "PLAIN BRANCH\n",
    });
    expect(interactive).toEqual({ renderer: "frame", output: "FRAME BRANCH\n" });

    const plainOutput = memoryStream(false, 140, 24);
    const plain = await captureCockpitOutput({
      cockpit: "run",
      output: plainOutput as unknown as NodeJS.WriteStream,
      binaryVersion: "0.0.0-test",
      columns: 140,
      rows: 24,
      interactive: false,
      captures: loadDemoCaptures(),
      frameRenderer: async () => {
        throw new Error("the non-interactive branch mounted a frame");
      },
      plainRenderer: () => "PLAIN BRANCH\n",
    });
    expect(plain).toEqual({ renderer: "plain", output: "PLAIN BRANCH\n" });
  });

  test("test: removing a handler removes its advertisement from every surface that advertises it, including the non-interactive one and the prompt's own keys", async () => {
    const contract = t13Keys();
    const withoutHelp = contract.RUN_INPUT_BINDINGS.filter((binding) =>
      binding.key !== "?"
    );
    const projectWithoutHelp: RunKeyProjection = (context) =>
      contract.projectRunKeyEntries(context, withoutHelp);
    const interaction = initialRunInteractionState();
    const entries = projectWithoutHelp({ interaction, columns: 140 });
    const interactive = await renderRunContext(interaction, 140, 24, projectWithoutHelp);
    expect(entries.some((entry) => entry.key === "?")).toBe(false);
    expect(drawnRosterLines(interactive, entries)).toEqual(
      t13Components().keyRosterLines(entries, 140),
    );
    expect(interactive).not.toContain("? Help");

    const output = memoryStream(false, 140, 24);
    const emission = await captureCockpitOutput({
      cockpit: "run",
      output: output as unknown as NodeJS.WriteStream,
      binaryVersion: "0.0.0-test",
      columns: 140,
      rows: 24,
      interactive: false,
      captures: loadDemoCaptures(),
      ...({ runKeyProjection: projectWithoutHelp } as Record<string, unknown>),
    });
    expect(emission.output).not.toContain("? Help");

    const prompting = {
      ...interaction,
      activeView: "tasks" as const,
      filterPrompt: true,
    };
    const withoutEdit = contract.RUN_INPUT_BINDINGS.filter((binding) =>
      binding.key !== "text"
    );
    const projectWithoutEdit: RunKeyProjection = (context) =>
      contract.projectRunKeyEntries(context, withoutEdit);
    const promptEntries = contract.projectRunKeyEntries(
      { interaction: prompting, columns: 80 },
      withoutEdit,
    );
    expect(promptEntries.some((entry) => entry.key === "text")).toBe(false);
    const promptFrame = await renderRunContext(
      prompting,
      80,
      24,
      projectWithoutEdit,
    );
    expect(drawnRosterLines(promptFrame, promptEntries)).toEqual(
      t13Components().keyRosterLines(promptEntries, 80),
    );
    expect(promptFrame).not.toContain("text Edit");
    // With the edit handler removed, the character reaches nothing at all.
    expect(dispatchRunKey({ input: "x", key: {} }, prompting, withoutEdit))
      .toBeUndefined();
  });

  test("test: the view-jump keys the interactive surface advertises appear on the non-interactive surface too, so a reader of either learns the same interface", async () => {
    const contract = t13Keys();
    const interaction = initialRunInteractionState();
    const entries = contract.projectRunKeyEntries({ interaction, columns: 140 });
    expect(entries).toContainEqual({ key: "1–5", label: "Move" });
    const interactive = await renderRunContext(interaction, 140, 24);
    expect(interactive).toContain("1–5 Move");

    const output = memoryStream(false, 140, 24);
    const emission = await captureCockpitOutput({
      cockpit: "run",
      output: output as unknown as NodeJS.WriteStream,
      binaryVersion: "0.0.0-test",
      interactive: false,
      captures: loadDemoCaptures(),
    });
    expect(emission.output).toContain("1–5 Move");
  });

  test("test: every surface advertises exactly the roster a substituted projection returns, including entries no live binding defines and entries wider than the terminal, so a surface that filters, amends, bypasses or clips the projection makes the assertion fail", async () => {
    const contract = t13Keys();
    const sentinel = [
      { key: "Z", label: "Outside registry" },
      { key: "Ω", label: `wide-${"x".repeat(80)}` },
    ] as const;
    const substituted: RunKeyProjection = () => sentinel;
    for (const columns of [COCKPIT_COLUMN_FLOOR, 140]) {
      const interaction = { ...initialRunInteractionState(), help: true };
      // The keybar draws the projected roster whole. The help overlay is that
      // same roster one entry per line, and it replaces the bar rather than
      // repeating it, so each surface is measured where it is drawn.
      const barred = await renderRunContext(
        { ...interaction, help: false },
        columns,
        24,
        substituted,
      );
      const plannedBar = t13Components().keyRosterLines(sentinel, columns)[0]!;
      expect(drawnRosterLines(barred, sentinel)).toEqual([plannedBar]);
      const interactive = await renderRunContext(interaction, columns, 24, substituted);
      expect(drawnRosterLines(interactive, sentinel)).toEqual([]);
      for (const entry of sentinel) {
        // The overlay owns the complete projection. At the floor width it may
        // wrap after the key, so prove the key and its label bytes independently
        // instead of requiring them to share a physical terminal row.
        expect(interactive, entry.key).toContain(entry.key);
        expect(interactive, entry.label).toContain(entry.label.slice(0, 12));
      }
      expect(drawnKeysRailLines(interactive)).toEqual([]);
      expect(interactive).not.toContain("KEYS");
      expect(interactive).toContain("Z Outside registry");
      expect(interactive).not.toContain("f Follow");
      expect(barred).not.toContain("f Follow");

      const output = memoryStream(false, columns, 24);
      const emission = await captureCockpitOutput({
        cockpit: "run",
        output: output as unknown as NodeJS.WriteStream,
        binaryVersion: "0.0.0-test",
        columns,
        rows: 24,
        interactive: false,
        captures: loadDemoCaptures(),
        ...({
          runInteraction: interaction,
          runKeyProjection: substituted,
        } as Record<string, unknown>),
      });
      expect(frameLines(emission.output).at(-1)).toBe(
        `keys ${contract.formatKeybarEntries(sentinel)}`,
      );
      expect(emission.output).not.toContain("f Follow");
    }
  });

  test("test: while the filter prompt owns input no normal binding is advertised, a character that would edit the query edits it and nothing else, and the prompt's own keys are the advertised ones", async () => {
    const contract = t13Keys();
    const prompting: RunInteractionState = {
      ...initialRunInteractionState(),
      activeView: "tasks",
      filterPrompt: true,
      filterQuery: "x",
    };
    const entries = contract.projectRunKeyEntries({ interaction: prompting, columns: 80 });
    expect(entries).toEqual(contract.RUN_FILTER_PROMPT_BINDINGS.map(({ key, label }) => ({
      key,
      label,
    })));
    // The prompt's roster is its own scope's keys plus the one key that owns
    // the whole surface rather than the view being narrowed.
    expect(entries.map((entry) => entry.key)).toEqual(["text", "⌫", "⏎", "Esc", "Tab"]);
    expect(entries.some((entry) => entry.key === "q")).toBe(false);

    const typed = dispatchRunKey(
      { input: "q", key: {} },
      prompting,
      contract.RUN_INPUT_BINDINGS,
    )!;
    expect(typed).toEqual({ ...prompting, filterQuery: "xq" });
    expect(typed.quit).toBe(false);
    // Tab is advertised in the prompt because it acts in the prompt: the tab
    // switches and the query the prompt was holding is untouched.
    const switched = dispatchRunKey(
      EVENTS.panel,
      typed,
      contract.RUN_INPUT_BINDINGS,
    )!;
    expect(switched).toEqual({ ...typed, tab: "setup" });
    const applied = dispatchRunKey(EVENTS.open, typed, contract.RUN_INPUT_BINDINGS)!;
    expect(applied).toEqual({ ...typed, filterPrompt: false });
    expect(dispatchRunKey(EVENTS.open, typed, contract.RUN_INPUT_BINDINGS))
      .toEqual(applied);
    expect(dispatchRunKey(
      { input: "x", key: {} },
      initialRunInteractionState(),
      contract.RUN_INPUT_BINDINGS,
    )).toBeUndefined();
    const frame = await renderRunContext(prompting, 80, 24);
    expect(drawnRosterLines(frame, entries)).toEqual(
      t13Components().keyRosterLines(entries, 80),
    );
  });

  test("the filter prompt's edit, delete, apply and cancel bindings each execute their registered production transition", () => {
    const prompting = journalInteraction({ filterPrompt: true, filterQuery: "a" });
    const typed = dispatchRunKey(
      { input: "b", key: {} },
      prompting,
      RUN_INPUT_BINDINGS,
      [],
    )!;
    expect(typed).toMatchObject({ filterPrompt: true, filterQuery: "ab" });

    const deleted = dispatchRunKey(
      { input: "", key: { backspace: true } },
      typed,
      RUN_INPUT_BINDINGS,
      [],
    )!;
    expect(deleted).toMatchObject({ filterPrompt: true, filterQuery: "a" });

    const applied = dispatchRunKey(EVENTS.open, deleted, RUN_INPUT_BINDINGS, [])!;
    expect(applied).toMatchObject({ filterPrompt: false, filterQuery: "a" });

    const cancelled = dispatchRunKey(
      { input: "", key: { escape: true } },
      prompting,
      RUN_INPUT_BINDINGS,
      [],
    )!;
    expect(cancelled).toMatchObject({ filterPrompt: false, filterQuery: "" });
  });

  test("test: with a detail open and the rail focused, the rail's keys are advertised and operate the visible rail", async () => {
    const contract = t13Keys();
    const interaction: RunInteractionState = {
      ...initialRunInteractionState(),
      activeView: "tasks",
      railSelection: 1,
      panel: 1,
      selection: "task:T1",
      opened: "task:T1",
    };
    const entries = contract.projectRunKeyEntries({ interaction, columns: 140 });
    expect(entries.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(["↑↓", "⏎", "Tab"]),
    );
    const moved = mustResolve(contract.RUN_INPUT_BINDINGS, EVENTS.moveDown)
      .apply(interaction, EVENTS.moveDown);
    expect(moved.railSelection).toBe(2);
    expect(await renderRunContext(moved, 140, 24)).toContain(`${GLYPHS.pointer} Gates`);
    const opened = mustResolve(contract.RUN_INPUT_BINDINGS, EVENTS.open)
      .apply(moved, EVENTS.open);
    expect(opened.activeView).toBe("gates");
    expect(await renderRunContext(opened, 140, 24)).toContain(`${GLYPHS.pointer} GATES`);
  });

  test("test: at every supported width down to the floor the drawn interactive advertisement parses back to exactly the projected roster, with nothing clipped by the drawing of it", async () => {
    const contract = t13Keys();
    const contexts = [
      initialRunInteractionState(),
      { ...initialRunInteractionState(), activeView: "tasks" as const },
    ];
    for (let columns = COCKPIT_COLUMN_FLOOR; columns <= 170; columns += 1) {
      for (const interaction of contexts) {
        const entries = contract.projectRunKeyEntries({
          interaction,
          // Advertised at the width the surface routes keys at; drawn at the
          // terminal's own.
          columns: runKeyColumns(columns),
          rowIds: frameRowIds(interaction),
        });
        const frame = await renderRunContext(interaction, columns, 24);
        const drawn = drawnRosterLines(frame, entries);
        expect(drawn, `${columns} columns`).toEqual([
          t13Components().keyRosterLines(entries, columns)[0],
        ]);
        expect(Math.max(...drawn.map(stringWidth)))
          .toBeLessThanOrEqual(columns);
      }
    }
  });

  test("test: a key that cannot act at a supported width is not advertised at that width, and a key advertised at a supported width changes observable state in that exact context", async () => {
    const contract = t13Keys();
    const interaction = initialRunInteractionState();
    // Tab is a top-level surface action, not a sidebar action: the floor
    // width hides the sidebar and Tab is advertised and acts there all the
    // same. The keybar and the handler cannot disagree about it at any width.
    expect(contract.runSideRailVisible(COCKPIT_COLUMN_FLOOR)).toBe(false);
    expect(
      contract.projectRunKeyEntries({ interaction, columns: COCKPIT_COLUMN_FLOOR })
        .some((entry) => entry.key === "Tab"),
    ).toBe(true);
    const narrow = dispatchRunKey(
      EVENTS.panel,
      interaction,
      contract.RUN_INPUT_BINDINGS,
      [],
      COCKPIT_COLUMN_FLOOR,
    )!;
    expect(narrow).toBeDefined();
    expect(narrow.tab).toBe("setup");
    expect(await renderRunContext(narrow, COCKPIT_COLUMN_FLOOR, 24))
      .not.toBe(await renderRunContext(interaction, COCKPIT_COLUMN_FLOOR, 24));

    expect(contract.runSideRailVisible(80)).toBe(true);
    expect(
      contract.projectRunKeyEntries({ interaction, columns: 80 })
        .some((entry) => entry.key === "Tab"),
    ).toBe(true);
    const tabbed = dispatchRunKey(
      EVENTS.panel,
      interaction,
      contract.RUN_INPUT_BINDINGS,
      [],
      80,
    )!;
    expect(tabbed.tab).toBe("setup");
    expect(await renderRunContext(tabbed, 80, 24))
      .not.toBe(await renderRunContext(interaction, 80, 24));

    // The number keys name views, and a digit means its view on every tab:
    // on the tab that holds sections rather than views it is advertised, and
    // it acts — it switches to the views' tab and lands on the view it numbers.
    const setup: RunInteractionState = { ...interaction, tab: "setup" };
    expect(
      contract.projectRunKeyEntries({ interaction: setup, columns: 140 })
        .some((entry) => entry.key === "1–5"),
    ).toBe(true);
    for (const [index, digit] of ["1", "2", "3", "4", "5"].entries()) {
      const jumped = dispatchRunKey(
        { input: digit, key: {} },
        setup,
        contract.RUN_INPUT_BINDINGS,
      )!;
      expect(jumped, digit).toBeDefined();
      expect(jumped.tab, digit).toBe("watch");
      expect(jumped.activeView, digit).toBe(
        ["run", "tasks", "gates", "journal", "fleet"][index],
      );
    }

    // A width that hides the rail gives back no sidebar to hand focus to, so
    // back is advertised there exactly when a view is drawn, and it acts: it
    // steps out of the view itself and returns to the overview.
    const narrowView: RunInteractionState = {
      ...interaction,
      activeView: "tasks",
      railSelection: 1,
    };
    expect(
      contract.projectRunKeyEntries({
        interaction: narrowView,
        columns: COCKPIT_COLUMN_FLOOR,
        rowIds: frameRowIds(narrowView),
      }).some((entry) => entry.key === "←"),
    ).toBe(true);
    const backedOut = dispatchRunKey(
      EVENTS.back,
      narrowView,
      contract.RUN_INPUT_BINDINGS,
      frameRowIds(narrowView),
      COCKPIT_COLUMN_FLOOR,
    )!;
    expect(backedOut).toBeDefined();
    expect(backedOut.activeView).toBe("run");
    expect(await renderRunContext(backedOut, COCKPIT_COLUMN_FLOOR, 24))
      .not.toBe(await renderRunContext(narrowView, COCKPIT_COLUMN_FLOOR, 24));

    // And the row keys are advertised only where a row exists to act on: the
    // journal is a tail, so it advertises neither the pointer nor the filter.
    const journal: RunInteractionState = {
      ...interaction,
      activeView: "journal",
    };
    const journalKeys = contract.projectRunKeyEntries({
      interaction: journal,
      columns: 140,
      rowIds: frameRowIds(journal),
    }).map((entry) => entry.key);
    expect(journalKeys).not.toContain("↑↓");
    expect(journalKeys).not.toContain("⏎");
    expect(journalKeys).not.toContain("/");
  });

  test("test: at the narrowest supported width every advertised key's effect is visible in the drawn frame", async () => {
    const contract = t13Keys();
    const interaction = initialRunInteractionState();
    const entries = contract.projectRunKeyEntries({
      interaction,
      columns: COCKPIT_COLUMN_FLOOR,
    });
    const eventsByKey: Readonly<Record<string, RunKeyEvent>> = {
      "↑↓": EVENTS.moveDown,
      Tab: EVENTS.panel,
      "?": EVENTS.help,
      q: EVENTS.quit,
      f: EVENTS.follow,
      "1–5": { input: "2", key: {} },
    };
    const before = await renderRunContext(interaction, COCKPIT_COLUMN_FLOOR, 24);
    for (const entry of entries) {
      const event = eventsByKey[entry.key];
      expect(event, entry.key).toBeDefined();
      const next = mustResolve(contract.RUN_INPUT_BINDINGS, event!).apply(
        interaction,
        event!,
        { rowIds: [], columns: COCKPIT_COLUMN_FLOOR },
      );
      expect(await renderRunContext(next, COCKPIT_COLUMN_FLOOR, 24), entry.key)
        .not.toBe(before);
    }
  });

  test("test: an indicator that reports state is drawn where it cannot be clipped, asserted at the narrowest supported width", async () => {
    const contract = t13Keys();
    const following = mustResolve(contract.RUN_INPUT_BINDINGS, EVENTS.follow)
      .apply(initialRunInteractionState(), EVENTS.follow);
    const frame = await renderRunContext(following, COCKPIT_COLUMN_FLOOR, 24);
    const indicatorLine = frameLines(frame).find((line) =>
      line.includes(`${GLYPHS.toggleActive} Follow`)
    );
    expect(indicatorLine).toBeDefined();
    expect(stringWidth(indicatorLine!)).toBeLessThanOrEqual(COCKPIT_COLUMN_FLOOR);
  });

  test("test: the help overlay drawn at the narrowest supported width and the shortest supported height together contains every advertised entry and stays within the terminal", async () => {
    const contract = t13Keys();
    const interaction = { ...initialRunInteractionState(), help: true };
    const entries = contract.projectRunKeyEntries({
      interaction,
      columns: COCKPIT_COLUMN_FLOOR,
    });
    const frame = await renderRunContext(interaction, COCKPIT_COLUMN_FLOOR, 14);
    expect(frameLines(frame).length).toBeLessThanOrEqual(14);
    expect(Math.max(...frameLines(frame).map(stringWidth))).toBeLessThanOrEqual(
      COCKPIT_COLUMN_FLOOR,
    );
    expect(frame).toContain("HELP");
    for (const entry of entries) {
      expect(frame, `${entry.key} ${entry.label}`).toContain(`${entry.key} ${entry.label}`);
    }
  });

  test("test: at every supported width, cycling focus leaves a visible focus ring at each step, and focus never rests on something the width omits", async () => {
    const contract = t13Keys();
    for (let columns = COCKPIT_COLUMN_FLOOR; columns <= 170; columns += 1) {
      // Every width the plan bands a sidebar at is a width the sidebar can
      // hold focus at — no band where the frame draws a rail the focus order
      // omits.
      const railPlanned = columns >= SIDEBAR_COLUMN_FLOOR;
      const order = contract.runPanelFocusOrder(runKeyColumns(columns));
      expect(order, `${columns} focus order`).toEqual(
        railPlanned ? ["CONTENT", "VIEWS"] : ["CONTENT"],
      );
      if (railPlanned) {
        // And the arrow that lands there moves the rail's own selection
        // rather than the body's row.
        const rail = { ...initialRunInteractionState(), panel: 1 };
        const moved = dispatchRunKey(
          EVENTS.moveDown,
          rail,
          contract.RUN_INPUT_BINDINGS,
          frameRowIds(rail),
          runKeyColumns(columns),
        )!;
        expect(moved.railSelection, `${columns} rail arrow`).toBe(1);
        expect(moved.selection, `${columns} row untouched`).toBe(rail.selection);
      }
      for (const [panel, focused] of order.entries()) {
        const frame = await renderRunContext(
          { ...initialRunInteractionState(), panel },
          columns,
          24,
        );
        expect(frame, `${columns} ${focused}`).toContain(
          `${GLYPHS.pointer} ${focused === "CONTENT" ? "RUN" : "VIEWS"}`,
        );
      }
      if (columns < SIDEBAR_COLUMN_FLOOR) {
        const hiddenRailState = await renderRunContext(
          { ...initialRunInteractionState(), panel: 1 },
          columns,
          24,
        );
        expect(hiddenRailState).toContain(`${GLYPHS.pointer} RUN`);
        expect(hiddenRailState).not.toContain("VIEWS");
      }
    }
  });
});

function productionJournalData(
  records: readonly {
    readonly event: string;
    readonly taskId?: string;
    readonly data?: Record<string, unknown>;
  }[],
): RunCockpitData {
  const events = [
    {
      ts: "2026-07-27T12:00:00.000Z",
      event: "run-start",
      data: { branch: "spec/t14", pid: process.pid },
    },
    ...records.map((record, index) => ({
      ts: new Date(Date.parse("2026-07-27T12:00:00.000Z") + (index + 1) * 1_000)
        .toISOString(),
      event: record.event,
      ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
      data: record.data ?? {},
    })),
  ];
  return deriveRunCockpitData({
    fileName: "run-20260727-120000.journal.jsonl",
    raw: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  }, "0.0.0-test");
}

const rowIds = (rows: ReturnType<typeof deriveRunViewRows>) =>
  rows.map((row) => row.id);

function journalInteraction(
  overrides: Partial<RunInteractionState> = {},
): RunInteractionState {
  return {
    ...initialRunInteractionState(),
    activeView: "journal",
    railSelection: 3,
    ...overrides,
  };
}

function selectProductionRow(
  rows: ReturnType<typeof deriveRunViewRows>,
  targetId: string,
): RunInteractionState {
  const target = rows.findIndex((row) => row.id === targetId);
  if (target < 0) throw new Error(`production row is absent: ${targetId}`);
  let state = journalInteraction();
  for (let index = 0; index <= target; index += 1) {
    state = dispatchRunKey(
      EVENTS.moveDown,
      state,
      RUN_INPUT_BINDINGS,
      rowIds(rows),
    )!;
  }
  return state;
}

describe("run row identity and empty-view invariants", () => {
  test("test: only the journal view draws journal rows, and a view whose own derivation produces nothing draws its genuinely empty state rather than borrowed rows", async () => {
    // An engagement that recorded nothing but plain events: its journal has
    // rows, and the three promoted views genuinely have none.
    const bare = productionJournalData([{ event: "one" }, { event: "two" }]);
    const journalRows = deriveRunViewRows(bare, "journal", "");
    expect(journalRows.length).toBeGreaterThan(1);
    for (const view of ["tasks", "gates", "fleet"] as const) {
      expect(deriveRunViewRows(bare, view, "")).toEqual([]);
      const drawn = await renderRunContext({
        ...initialRunInteractionState(),
        activeView: view,
      }, 140, 24, undefined, bare);
      expect(drawn).toContain(`No ${view} in this engagement`);
      const plan = planFrame({ columns: 140, rows: 24 }, view);
      if (plan.kind !== "frame") throw new Error("expected frame plan");
      const body = plan.regions.find((region) => region.id === "body")!;
      const tail = plan.regions.find((region) => region.id === "tail")!;
      const lines = frameLines(drawn);
      expect(lines.slice(body.row, body.row + body.rows).join("\n"))
        .not.toContain(journalRows[0]!.text);
      expect(lines.slice(tail.row, tail.row + tail.rows).join("\n"))
        .toContain(journalRows[0]!.text);
    }
    const journal = await renderRunContext(
      journalInteraction(),
      140,
      24,
      undefined,
      bare,
    );
    expect(journal).toContain(journalRows[0]!.text);
  });

  test("test: a selection cannot move on a view that has no rows, and the open key leaves that view's empty state drawn, asserted on a genuinely rowless production view rather than on emptiness a filter manufactured", async () => {
    const bare = productionJournalData([{ event: "one" }, { event: "two" }]);
    const empty = {
      ...initialRunInteractionState(),
      activeView: "fleet" as const,
      railSelection: 4,
    };
    const rows = deriveRunViewRows(bare, empty.activeView, empty.filterQuery);
    expect(rows).toEqual([]);
    const moved = dispatchRunKey(EVENTS.moveDown, empty, RUN_INPUT_BINDINGS, rowIds(rows)) ?? empty;
    const opened = dispatchRunKey(EVENTS.open, moved, RUN_INPUT_BINDINGS, rowIds(rows)) ?? moved;
    expect(moved).toEqual(empty);
    expect(opened).toEqual(empty);
    expect(await renderRunContext(opened, 140, 24, undefined, bare)).toContain(
      "No fleet in this engagement",
    );
  });

  test("test: an opened row still shows the same row after a change that removes a row above it, after one that adds a row above it, and after one that reorders without changing the count", async () => {
    const data = productionJournalData([
      { event: "one" },
      { event: "two" },
      { event: "three" },
    ]);
    const rows = deriveRunViewRows(data, "journal", "");
    const target = rows.find((row) => row.text === "neutral · two")!;
    const prepended = deriveRunViewRows(productionJournalData([
      { event: "one" },
      { event: "two" },
      { event: "three" },
      { event: "four" },
    ]), "journal", "");
    const selected = selectProductionRow(rows, target.id);
    const opened = dispatchRunKey(
      EVENTS.open,
      selected,
      RUN_INPUT_BINDINGS,
      rowIds(rows),
    )!;
    const changes = [
      rows.slice(1),
      prepended,
      [rows[2]!, rows[0]!, rows[1]!, ...rows.slice(3)],
    ];
    for (const changed of changes) {
      const repaired = reconcileRunInteraction(opened, rowIds(changed));
      expect(repaired.opened).toBe(target.id);
      const drawn = await renderRunContext(repaired, 140, 24, undefined, {
        ...data,
        journalRows: changed,
      });
      expect(drawn).toContain(target.text);
    }
  });

  test("test: the selected row is still the same row after a change that removes a row above it, after one that adds a row above it, and after one that reorders without changing the count", async () => {
    const data = productionJournalData([
      { event: "one" },
      { event: "two" },
      { event: "three" },
    ]);
    const rows = deriveRunViewRows(data, "journal", "");
    const target = rows.find((row) => row.text === "neutral · two")!;
    const prepended = deriveRunViewRows(productionJournalData([
      { event: "one" },
      { event: "two" },
      { event: "three" },
      { event: "four" },
    ]), "journal", "");
    const selected = selectProductionRow(rows, target.id);
    const changes = [
      rows.slice(1),
      prepended,
      [rows[2]!, rows[0]!, rows[1]!, ...rows.slice(3)],
    ];
    for (const changed of changes) {
      const repaired = reconcileRunInteraction(selected, rowIds(changed));
      expect(repaired.selection).toBe(target.id);
      const drawn = await renderRunContext(repaired, 140, 24, undefined, {
        ...data,
        journalRows: changed,
      });
      expect(frameLines(drawn).find((line) => line.includes(target.text)))
        .toContain(GLYPHS.pointer);
    }
  });

  test("test: an opened row whose own row disappears is cleared rather than left showing whichever row took its place, and a selection whose own row disappears is cleared the same way", () => {
    const rows = deriveRunViewRows(RUN_DATA, "journal", "");
    const target = rows[1]!;
    const selected = selectProductionRow(rows, target.id);
    const opened = dispatchRunKey(
      EVENTS.open,
      selected,
      RUN_INPUT_BINDINGS,
      rowIds(rows),
    )!;
    const repaired = reconcileRunInteraction(
      opened,
      rowIds(rows.filter((row) => row.id !== target.id)),
    );
    expect(repaired.selection).toBeNull();
    expect(repaired.opened).toBeNull();
  });

  test("test: a row's identity comes from its source record rather than its drawn presentation, so a row whose drawn text changes when a newer event arrives keeps its selection and detail, and two rows drawn identically remain distinct", () => {
    const beforeData = productionJournalData([{
      event: "task-dispatch",
      taskId: "T1",
      data: { assignment: { adapter: "codex", model: "gpt-5.6-sol" } },
    }]);
    const beforeRows = deriveRunViewRows(beforeData, "journal", "");
    const target = beforeRows.find((row) => row.id === "event:2")!;
    const afterData = productionJournalData([
      {
        event: "task-dispatch",
        taskId: "T1",
        data: { assignment: { adapter: "codex", model: "gpt-5.6-sol" } },
      },
      { event: "newer-event" },
    ]);
    const afterRows = deriveRunViewRows(afterData, "journal", "");
    const changedTarget = afterRows.find((row) => row.id === target.id)!;
    expect(changedTarget.text).not.toBe(target.text);
    const selected = selectProductionRow(beforeRows, target.id);
    const opened = dispatchRunKey(
      EVENTS.open,
      selected,
      RUN_INPUT_BINDINGS,
      rowIds(beforeRows),
    )!;
    expect(reconcileRunInteraction(
      opened,
      rowIds(afterRows),
    )).toMatchObject({ selection: target.id, opened: target.id });

    const identical = deriveRunViewRows(productionJournalData([
      { event: "same-event" },
      { event: "same-event" },
    ]), "journal", "").filter((row) => row.text === "neutral · same-event");
    expect(identical).toHaveLength(2);
    expect(new Set(identical.map((row) => row.id)).size).toBe(2);
  });

  test("test: the row identity criteria are asserted on rows the production derivation builds rather than on rows a test builds by hand", () => {
    const data = productionJournalData([
      { event: "one" },
      { event: "two" },
      { event: "three" },
    ]);
    const rows = deriveRunViewRows(data, "journal", "");
    expect(rows).toBe(data.journalRows);
    expect(rows.every((row) => /^event:\d+$/u.test(row.id))).toBe(true);
  });

  test("test: following that is on before a jump to another view and back is still on after the return", () => {
    const following = dispatchRunKey(
      EVENTS.follow,
      initialRunInteractionState(),
      RUN_INPUT_BINDINGS,
      [],
    )!;
    const away = dispatchRunKey(
      { input: "2", key: {} },
      following,
      RUN_INPUT_BINDINGS,
      [],
    )!;
    const back = dispatchRunKey(EVENTS.back, away, RUN_INPUT_BINDINGS, [])!;
    const home = dispatchRunKey({ input: "1", key: {} }, back, RUN_INPUT_BINDINGS, [])!;
    expect(back.activeView).toBe("tasks");
    // Backing out lands on the sidebar, which is what the return then leaves.
    expect(back.panel).toBe(1);
    expect(home.activeView).toBe("run");
    expect(home.follow).toBe(true);
    expect(back.follow).toBe(true);
  });

  test("test: after every advertised key that acts on the selected row is sent to an empty view, the interaction state equals what it was before, field by field, and every other advertised key sent to that empty view still does its own job", () => {
    const empty = {
      ...initialRunInteractionState(),
      activeView: "fleet" as const,
      railSelection: 4,
    };
    for (const event of [EVENTS.moveDown, EVENTS.open]) {
      expect(dispatchRunKey(event, empty, RUN_INPUT_BINDINGS, []) ?? empty)
        .toEqual(empty);
    }
    const entries = projectRunKeyEntries({ interaction: empty, columns: 140, rowIds: [] });
    expect(entries.map((entry) => entry.key)).not.toEqual(
      expect.arrayContaining(["↑↓", "⏎"]),
    );
    const globalEffects: Readonly<Record<string, [RunKeyEvent, (state: RunInteractionState) => boolean]>> = {
      "←": [EVENTS.back, (state) => state.panel === 1],
      Tab: [EVENTS.panel, (state) => state.tab === "setup"],
      "?": [EVENTS.help, (state) => state.help],
      q: [EVENTS.quit, (state) => state.quit],
      "/": [EVENTS.filter, (state) => state.filterPrompt],
      "1–5": [{ input: "2", key: {} }, (state) => state.activeView === "tasks"],
    };
    for (const entry of entries) {
      const effect = globalEffects[entry.key];
      expect(effect, entry.key).toBeDefined();
      const next = dispatchRunKey(effect![0], empty, RUN_INPUT_BINDINGS, [])!;
      expect(effect![1](next), entry.key).toBe(true);
    }
  });

  test("test: leaving a detail that was never opened draws the view rather than somewhere else", async () => {
    const invalid = journalInteraction({ opened: "event:not-present" });
    const repaired = reconcileRunInteraction(
      invalid,
      rowIds(deriveRunViewRows(RUN_DATA, "journal", "")),
    );
    expect(repaired.opened).toBeNull();
    const drawn = await renderRunContext(repaired, 140, 24);
    expect(drawn).toContain(`${GLYPHS.pointer} JOURNAL`);
    expect(drawn).not.toContain("EVENT DETAIL");
    expect(drawn).not.toContain("PROGRESS");
  });

  test("a selected production journal row opens through the frame's detail branch", async () => {
    const rows = deriveRunViewRows(RUN_DATA, "journal", "");
    const target = rows[0]!;
    const drawn = await renderRunContext(
      journalInteraction({ selection: target.id, opened: target.id }),
      140,
      24,
    );
    expect(drawn).toContain("EVENT DETAIL");
    expect(drawn).toContain(target.text);
  });

  test("test: a row beyond the first painted screen can be selected and is brought into view", async () => {
    const rows = deriveRunViewRows(RUN_DATA, "journal", "");
    expect(rows.length).toBeGreaterThan(20);
    let state = journalInteraction();
    for (let index = 0; index <= 22; index += 1) {
      state = dispatchRunKey(
        EVENTS.moveDown,
        state,
        RUN_INPUT_BINDINGS,
        rowIds(rows),
      )!;
    }
    expect(state.selection).toBe(rows[22]!.id);
    const drawn = await renderRunContext(state, 140, 14);
    expect(frameLines(drawn).find((line) => line.includes(rows[22]!.text)))
      .toContain(GLYPHS.pointer);
    expect(drawn).not.toContain(rows[0]!.text);
  });

  test("test: a drawn frame never has more lines than the terminal has rows, in every view at every supported size, so bringing a row into view means moving a window rather than overrunning the terminal", async () => {
    const dimensions = new Map(
      GOLDEN_FRAME_CASES.map(({ columns, rows }) => [`${columns}x${rows}`, { columns, rows }]),
    );
    // Review carryforward: the golden cases carry no case at the corner where
    // the column floor and the row floor meet, which is exactly where a rail
    // whose labels wrap would push the frame past the terminal. Both tabs are
    // measured there, and at the row floor of every golden width.
    for (const { columns } of GOLDEN_FRAME_CASES) {
      dimensions.set(`${columns}x${COCKPIT_ROW_FLOOR}`, { columns, rows: COCKPIT_ROW_FLOOR });
    }
    dimensions.set(
      `${RUN_SIDE_RAIL_COLUMN_FLOOR}x${COCKPIT_ROW_FLOOR}`,
      { columns: RUN_SIDE_RAIL_COLUMN_FLOOR, rows: COCKPIT_ROW_FLOOR },
    );

    // The setup tab is drawn at every one of those sizes too, in each of its
    // sections and in its help variant.
    for (const { columns, rows } of dimensions.values()) {
      for (const railSelection of [0, 1, 2]) {
        for (const help of [false, true]) {
          const drawn = await renderRunContext(
            {
              ...initialRunInteractionState(),
              tab: "setup",
              railSelection,
              help,
            },
            columns,
            rows,
          );
          expect(
            frameLines(drawn).length,
            `setup section ${railSelection} help ${help} ${columns}x${rows}`,
          ).toBeLessThanOrEqual(rows);
        }
      }
    }

    for (const view of ["run", "tasks", "gates", "journal", "fleet"] as const) {
      for (const { columns, rows } of dimensions.values()) {
        const base = {
          ...initialRunInteractionState(),
          activeView: view,
          railSelection: ["run", "tasks", "gates", "journal", "fleet"].indexOf(view),
        };
        const journalRows = deriveRunViewRows(RUN_DATA, "journal", "");
        const states = [
          base,
          { ...base, help: true },
          ...(view === "run" ? [] : [{ ...base, filterPrompt: true }]),
          ...(view === "journal"
            ? [
              { ...base, selection: journalRows[22]!.id },
              {
                ...base,
                selection: journalRows[22]!.id,
                opened: journalRows[22]!.id,
              },
            ]
            : []),
        ];
        for (const [variant, state] of states.entries()) {
          const drawn = await renderRunContext(state, columns, rows);
          expect(
            frameLines(drawn).length,
            `${view} variant ${variant} ${columns}x${rows}`,
          ).toBeLessThanOrEqual(rows);
          if (view === "journal" && variant === 0 && columns >= 140) {
            expect(drawn, `${view} ${columns}x${rows}`)
              .toContain("T2 attempt 4");
          }
        }
      }
    }

    // Review carryforward: a short demo detail is not a height oracle. This
    // row comes from the production derivation and forces the opened detail to
    // wrap far past the 40x14 terminal unless the detail owns a real window.
    const longData = productionJournalData([{ event: `long-${"x".repeat(1_000)}` }]);
    const longRow = deriveRunViewRows(longData, "journal", "")[0]!;
    const openedLongRow = await renderRunContext(
      journalInteraction({ selection: longRow.id, opened: longRow.id }),
      40,
      14,
      undefined,
      longData,
    );
    expect(openedLongRow).toContain("EVENT DETAIL");
    expect(frameLines(openedLongRow).length).toBeLessThanOrEqual(14);
  });

  test("test: the window that follows the selection lives on the surface that carries the selection, asserted by selecting past the screen there and observing the window move in the drawn frame", async () => {
    const rows = deriveRunViewRows(RUN_DATA, "journal", "");
    const first = await renderRunContext(journalInteraction(), 140, 14);
    const selected = journalInteraction({ selection: rows[22]!.id });
    const moved = await renderRunContext(selected, 140, 14);
    expect(first).toContain(rows[0]!.text);
    expect(moved).not.toContain(rows[0]!.text);
    expect(frameLines(moved).find((line) => line.includes(rows[22]!.text)))
      .toContain(GLYPHS.pointer);
    expect(moved).toContain(`${GLYPHS.pointer} JOURNAL`);
  });

  test("test: every branch either surface can still reach carries a test, and any branch neither can reach is gone from the source rather than left uncovered", () => {
    expect(BRANCH_LEDGER.length).toBeGreaterThan(SURFACE_DECLARED_BRANCH_MODULES.length);
    expect(new Set(BRANCH_LEDGER.map((entry) => entry.module))).toEqual(
      new Set(SURFACE_DECLARED_BRANCH_MODULES),
    );
    for (const entry of BRANCH_LEDGER) {
      expect(entry.branch.length).toBeGreaterThan(0);
      expect(entry.testTitle.length).toBeGreaterThan(0);
    }
  });
});

describe("executed cockpit branch ledger", () => {
  test("test: the branch ledger is proved by breaking each reachable branch and observing the test the entry names fail, not a weaker inline assertion beside it", async () => {
    await withBranchSandbox(async (sandbox) => {
      const passed = new Set<string>();
      for (const entry of BRANCH_LEDGER) {
        await proveLedgerEntry(sandbox, entry, passed);
      }
    });
  }, 180_000);

  test("test: a ledger broken arm breaks the production branch it names rather than code the test owns, so an arm that fails by construction without touching production makes the assertion fail", async () => {
    await withBranchSandbox(async (sandbox) => {
      const constructionOnly: BranchLedgerEntry = {
        ...BRANCH_LEDGER[0],
        branch: "test-owned construction-only arm",
        breakProduction: (source) => source,
      };
      await expect(proveLedgerEntry(sandbox, constructionOnly, new Set()))
        .rejects.toThrow(/did not change production module/u);
    });
  });

  test("test: the ledger covers every module either surface declares, so a reachable branch in the capture, components or frame module is enumerated the same way as one in the key handlers", () => {
    expect(new Set(BRANCH_LEDGER.map((entry) => entry.module))).toEqual(
      new Set(SURFACE_DECLARED_BRANCH_MODULES),
    );
  });

  test("deleting any test the ledger names makes the ledger itself fail rather than pass by silence", async () => {
    await withBranchSandbox(async (sandbox) => {
      const passed = new Set<string>();
      for (const entry of BRANCH_LEDGER) {
        await expect(proveLedgerEntry(sandbox, entry, passed, { deleteNamedTest: true }))
          .rejects.toThrow(/named test did not execute and fail/u);
      }
    });
  }, 180_000);
});
