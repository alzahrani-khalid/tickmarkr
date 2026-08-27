import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { LIVE, LIVE_PALETTE } from "../../src/brand.js";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";

// The palette negative control still runs the shipped status renderer. Arming it swaps only the
// live role implementations at their source, recreating the provisional board without rewriting a
// completed frame (which would make the control independent of the renderer under test).
const livePaletteControl = vi.hoisted(() => ({ provisional: false }));
vi.mock("../../src/brand.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/brand.js")>();
  const provisional = {
    brand: "38;5;108",
    pass: "38;5;108",
    running: "38;5;245",
    information: "38;5;245",
    text: "38;5;253",
    primaryText: "38;5;253",
    chrome: "38;5;245",
    secondaryText: "38;5;245",
    attention: "38;5;180",
    failure: "38;5;174",
    chip: "38;5;253;48;5;236",
  } satisfies Record<keyof typeof actual.LIVE, string>;
  const live = Object.fromEntries(Object.entries(actual.LIVE).map(([role, token]) => [
    role,
    (text: string): string => {
      const rendered = token(text);
      return livePaletteControl.provisional && rendered !== text
        ? `\x1b[${provisional[role as keyof typeof provisional]}m${text}\x1b[0m`
        : rendered;
    },
  ])) as unknown as typeof actual.LIVE;
  return { ...actual, LIVE: live };
});

// The board names the binary's version through the CLI's ONE version reader, so a mispackaged
// installation is reachable from here: `stubVersion` swaps that reader for the length of a single
// assertion and every other suite in this file keeps reading the real repository manifest.
const versionStub = vi.hoisted(() => ({ read: undefined as (() => Promise<string>) | undefined }));
vi.mock("../../src/cli/commands/version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/commands/version.js")>();
  return { version: async () => (versionStub.read ? versionStub.read() : actual.version()) };
});
const stubVersion = async (read: () => Promise<string>, body: () => Promise<void>): Promise<void> => {
  versionStub.read = read;
  try { await body(); } finally { versionStub.read = undefined; }
};

// T8: the cockpit's width and layout authorities are INSTRUMENTED here, never re-implemented. Both
// wrappers call straight through, so every suite in this file sees the real frame; the recordings
// and the two overrides below are what a copied constant, an unused import or a local helper the
// shipped command never calls cannot produce.
const widthCalls = vi.hoisted(() => ({
  measured: [] as string[],
  wrapped: [] as string[],
  fitted: [] as string[],
  // The NEGATIVE CONTROL, armed per render: the shipped renderer draws through a local UTF-16
  // code-unit width model — the measure this task deletes — instead of the cockpit authority. It
  // bills ANSI bytes and combining marks cells they never draw and under-bills a wide cluster.
  codeUnits: false,
  localWidth: (text: string) => text.length,
  localWrap: (text: string, maxCells: number): string[] => {
    const budget = Math.max(1, Math.floor(maxCells));
    const rows: string[] = [];
    for (let at = 0; at < text.length; at += budget) rows.push(text.slice(at, at + budget));
    return rows.length > 0 ? rows : [""];
  },
  localFit: (text: string, cells: number): string =>
    cells < 1 ? "" : text.slice(0, cells).padEnd(cells),
}));
vi.mock("../../src/tui/cockpit/width.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/cockpit/width.js")>();
  return {
    ...actual,
    cellWidth: (text: string) => {
      widthCalls.measured.push(text);
      return widthCalls.codeUnits ? widthCalls.localWidth(text) : actual.cellWidth(text);
    },
    wrapCells: (
      text: string,
      maxCells: number,
      options?: Parameters<typeof actual.wrapCells>[2],
    ) => {
      widthCalls.wrapped.push(text);
      return widthCalls.codeUnits
        ? widthCalls.localWrap(text, maxCells)
        : actual.wrapCells(text, maxCells, options);
    },
    fitCells: (text: string, cells: number) => {
      widthCalls.fitted.push(text);
      return widthCalls.codeUnits ? widthCalls.localFit(text, cells) : actual.fitCells(text, cells);
    },
  };
});
const layoutOverride = vi.hoisted(() => ({
  columnFloor: undefined as number | undefined,
  priority: undefined as readonly string[] | undefined,
}));
vi.mock("../../src/tui/cockpit/layout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/cockpit/layout.js")>();
  return {
    ...actual,
    get COCKPIT_COLUMN_FLOOR() {
      return layoutOverride.columnFloor ?? actual.COCKPIT_COLUMN_FLOOR;
    },
    get LAYOUT_PRIORITY() {
      return (layoutOverride.priority ?? actual.LAYOUT_PRIORITY) as typeof actual.LAYOUT_PRIORITY;
    },
  };
});

// T3 (v1.50): the watch cockpit restyles the TTY frame through src/brand.ts. The non-TTY
// surface is machine-consumed and byte-pinned; its task column follows the graph title contract.

const mandatoryGates = ["build", "test", "lint", "evidence", "scope"];
const GRAPH = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [
    { id: "T1", title: "done", goal: "Finish report, then archive it.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
    { id: "T2", title: "failed", goal: "Run mixed gates; stop on failure.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
    { id: "T3", title: "starved", goal: "Queue the undispatched follow-up.", shape: "implement", complexity: 3, deps: ["T2"], acceptance: ["a"], gates: mandatoryGates },
  ],
});

// Deterministic fixture: events backdated exactly 10 minutes (age renders "10m" for the next
// ~50s of wall clock), a garbage pid (renders "unknown", never probes), fixed 120 columns.
const seed = (repo: string) => {
  saveGraph(repo, GRAPH);
  const ts = new Date(Date.now() - 600_000).toISOString();
  const events: JournalEvent[] = [
    { ts, event: "run-start", data: { pid: "not-a-pid", graphDefinitionHash: graphDefinitionHash(GRAPH) } },
    { ts, event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" } } },
    { ts, event: "gate-result", taskId: "T1", data: { gate: "build", pass: true } },
    { ts, event: "gate-result", taskId: "T1", data: { gate: "test", pass: true } },
    { ts, event: "task-done", taskId: "T1", data: {} },
    { ts, event: "task-dispatch", taskId: "T2", data: { assignment: { adapter: "fake", model: "fake-2", channel: "sub", tier: "cheap" } } },
    { ts, event: "gate-result", taskId: "T2", data: { gate: "build", pass: true } },
    { ts, event: "gate-result", taskId: "T2", data: { gate: "test", pass: false } },
    { ts, event: "task-failed", taskId: "T2", data: {} },
    { ts, event: "context-sample", taskId: "T2", data: { tokens: 1234, threshold: 170_000, attempt: 0 } },
  ];
  const dir = join(tickmarkrDir(repo), "runs", "run-brand");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

const withStdout = async (tty: boolean, fn: () => Promise<void>) => {
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
  delete process.env.NO_COLOR;
  try {
    await fn();
  } finally {
    if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (columns) Object.defineProperty(process.stdout, "columns", columns);
    else delete (process.stdout as { columns?: number }).columns;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

// ── T8 board fixture: the two ids the id column must be sized by (the shortest the schema allows
// and the longest), a title carrying wide clusters and a combining mark, and a task whose two
// blockers are both unlanded — the structure a narrowing board must keep naming.
const BOARD_LONG_ID = "T_cockpit_width_authority_at_the_schema_maximum_identifier_lengt";
const BOARD_WIDE_TITLE = `日本語の幅 e${"́"} combining title`;
const BOARD_GRAPH = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [
    { id: "T9", title: "compile the graph", goal: "Compile the graph.", shape: "implement", complexity: 3, acceptance: ["a"] },
    { id: BOARD_LONG_ID, title: BOARD_WIDE_TITLE, goal: "Migrate the width call sites.", shape: "implement", complexity: 3, acceptance: ["a"] },
    { id: "T3", title: "waits on both", goal: "Land behind both.", shape: "implement", complexity: 3, deps: ["T9", BOARD_LONG_ID], acceptance: ["a"] },
  ],
});

// A released human gate leaves T3 pending with both deps still in flight — a real journal in which
// the board owes the operator the blockers by name.
const boardRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-board-"));
  saveGraph(repo, BOARD_GRAPH);
  const at = new Date(Date.now() - 600_000).toISOString();
  const events: JournalEvent[] = [
    // A live daemon: with no run-end and a dead pid the fold would read both dispatches as
    // interrupted, which starves T3 and retires the dependency naming this fixture exists for.
    { ts: at, event: "run-start", data: { pid: process.pid, graphDefinitionHash: graphDefinitionHash(BOARD_GRAPH) } },
    { ts: at, event: "task-dispatch", taskId: "T9", data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" }, attempt: 0 } },
    { ts: at, event: "task-dispatch", taskId: BOARD_LONG_ID, data: { assignment: { adapter: "fake", model: "fake-2", channel: "sub", tier: "cheap" }, attempt: 0 } },
    { ts: at, event: "gate-result", taskId: BOARD_LONG_ID, data: { gate: "build", pass: true } },
    { ts: at, event: "context-sample", taskId: "T9", data: { tokens: 12_345, threshold: 170_000, attempt: 0 } },
    { ts: at, event: "task-human", taskId: "T3", data: { kind: "designed-gate" } },
    { ts: at, event: "task-approved", taskId: "T3", data: { gate: "human" } },
  ];
  const dir = join(tickmarkrDir(repo), "runs", "run-board");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return repo;
};

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, "");
const taskBlock = (frame: string, taskId: string): string => {
  const lines = strip(frame).split("\n");
  const start = lines.findIndex((line) => new RegExp(`^ {4}${taskId}(?:\\s|$)`).test(line));
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^ {4}T/u.test(lines[end]!)) end += 1;
  return lines.slice(start, end).join("\n");
};
const taskHead = (frame: string, taskId: string): string =>
  frame.split("\n").find((line) => new RegExp(`^ {4}(?:\\x1b\\[[\\d;]*m)*${taskId}(?:\\s|$)`).test(line))!;

/** One bounded watch frame at a named terminal width, with the cockpit's own writes swallowed. */
const boardFrame = async (repo: string, columns: number): Promise<string> => {
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const cols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  delete process.env.NO_COLOR;
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    return await status(["--watch"], repo, { iterations: 1, sleep: async () => {} });
  } finally {
    spy.mockRestore();
    if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (cols) Object.defineProperty(process.stdout, "columns", cols);
    else delete (process.stdout as { columns?: number }).columns;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

/**
 * The negative control: the SAME journal drawn by the SAME shipped command, with the local
 * code-unit width model armed in place of the cockpit authority. Whatever this returns is what a
 * copied helper, a hand-rolled `vw`/`pad`/`fit` or an unused import would have drawn.
 */
const controlFrame = async (repo: string, columns: number): Promise<string> => {
  widthCalls.codeUnits = true;
  try {
    return await boardFrame(repo, columns);
  } finally {
    widthCalls.codeUnits = false;
  }
};

describe("T3 watch cockpit brand restyle", () => {
  test("status non-tty output remains byte-pinned around the task-title column", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(false, async () => {
      const out = await status([], repo);
      expect(out).toBe(
        "tickmarkr status / run run-brand / last event 10m ago / daemon pid unknown / 1/3 done\n" +
        "  gates: B build / T test / L lint / E evidence / S scope / A acceptance / R review\n" +
        // no watcher has ever beaten in this fixture, and every tier says so rather than being omitted
        "  supervision: orchestrator ABSENT / orchestrator-context ABSENT / overseer ABSENT / overseer-context ABSENT / watch ABSENT\n" +
        "  [x] T1 done  B[x] T[x] L[ ] E[ ] S[ ] A. R.  done  fake:fake-1\n" +
        "  [!] T2 failed  B[x] T[!] L[ ] E[ ] S[ ] A. R.  failed  fake:fake-2 / ctx 1234\n" +
        "  [ ] T3 starved  B[ ] T[ ] L[ ] E[ ] S[ ] A. R.  pending starved  -",
      );
    });
  });

  // one bounded watch frame with stdout captured — the cockpit write is banner + frame + footer
  const watchFrame = async (repo: string): Promise<string> => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await status(["--watch"], repo, { iterations: 1, sleep: async () => {} });
    } finally {
      spy.mockRestore();
    }
    return writes.join("");
  };

  test("the watch frame uses the approved brand chip and a dominant run id without the old four-row banner", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(true, async () => {
      const out = await watchFrame(repo);
      // The chip wears the BRAND authority itself, not merely some live role: asserting it through
      // LIVE.brand — whose bytes the role-table criterion pins to #90C4A4 — is what a chip that
      // drifted onto chrome, text or its own hue cannot satisfy.
      expect(out).toContain(LIVE.brand(" tickmarkr "));
      expect(out).toContain(LIVE.text("run-brand"));
      expect(out).not.toContain("spec in, verified work out.");
    });
  });

  test("the approved table colors the done task id teal and the failed task id amethyst", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(true, async () => {
      const out = await status([], repo);
      expect(taskHead(out, "T1")).toContain("\x1b[38;2;144;196;164m");
      expect(taskHead(out, "T2")).toContain("\x1b[38;2;176;123;172m");
    });
  });

  test("the shipped task table keeps its dependency column and every task identity at 40, 110 and 220 columns through the cockpit width authority", async () => {
    expect(BOARD_LONG_ID).toHaveLength(64);
    expect(cellWidth(BOARD_WIDE_TITLE)).not.toBe(BOARD_WIDE_TITLE.length);
    const repo = boardRepo();

    for (const columns of [40, 110, 220]) {
      widthCalls.measured.length = 0;
      widthCalls.wrapped.length = 0;
      widthCalls.fitted.length = 0;
      const frame = await boardFrame(repo, columns);
      const plain = strip(frame);

      for (const line of frame.split("\n")) {
        expect(cellWidth(line), `${columns} cols: ${strip(line)}`).toBeLessThanOrEqual(columns);
      }
      expect(plain).toContain("deps");
      expect(plain).toContain("WHERE THE EFFORT WENT");
      const waiter = taskBlock(frame, "T3").replace(/\s+/gu, "");
      expect(waiter).toContain("T9");
      if (columns >= 110) expect(widthCalls.fitted).toContain(BOARD_WIDE_TITLE);
      expect(widthCalls.wrapped.some((text) => text.includes(BOARD_LONG_ID))).toBe(true);
    }

    // The control arms the exact deleted failure mode: local UTF-16 clipping on the same production
    // path. Wide/combining data must produce different bytes from the grapheme-aware renderer.
    expect(await controlFrame(repo, 110)).not.toBe(await boardFrame(repo, 110));
  });

  // ── v1.99 T3: the exact operator palette, and the two-row brand lockup every TTY board wears.

  test("test: the TTY watch frame live-colour set deep-equals the exported role table while the provisional frame control differs", async () => {
    const renderedColours = (frame: string): Set<string> => {
      const colours = new Set<string>();
      const rgbHex = (channels: readonly number[]): string =>
        `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`;

      for (const match of frame.matchAll(/\x1b\[([\d:;]*)m/gu)) {
        const payload = match[1]!;
        // Colon-delimited extended colours are valid SGR too. The live renderer does not emit
        // them, so make their presence an explicit mismatch instead of silently overlooking them.
        if (payload.includes(":")) {
          colours.add(`colon-sgr:${payload}`);
          continue;
        }
        const parameters = payload === "" ? [0] : payload.split(";").map(Number);
        for (let index = 0; index < parameters.length; index += 1) {
          const code = parameters[index]!;
          if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
            colours.add(`ansi16-foreground:${code}`);
            continue;
          }
          if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
            colours.add(`ansi16-background:${code}`);
            continue;
          }
          if (code !== 38 && code !== 48) continue;

          const plane = code === 38 ? "foreground" : "background";
          const mode = parameters[index + 1];
          if (mode === 5 && parameters[index + 2] !== undefined) {
            colours.add(`ansi256-${plane}:${parameters[index + 2]}`);
            index += 2;
            continue;
          }
          if (mode === 2 && parameters.slice(index + 2, index + 5).length === 3) {
            const hex = rgbHex(parameters.slice(index + 2, index + 5));
            colours.add(plane === "foreground" ? hex : `truecolor-background:${hex}`);
            index += 4;
            continue;
          }
          colours.add(`unsupported-${plane}:${parameters.slice(index).join(";")}`);
          break;
        }
      }
      return colours;
    };

    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    const board = await boardFrame(repo, 120);
    const approvedColours = new Set(Object.values(LIVE_PALETTE));
    expect(renderedColours(board)).toEqual(approvedColours);

    // Poison the real frame with every standard/bright ANSI colour plus each extended foreground
    // and background form. Every one must change the complete colour set; an extractor that only
    // recognizes the production fixture's 38;2 form makes at least one of these controls vacuous.
    const ansi16Codes = [
      ...Array.from({ length: 8 }, (_, offset) => 30 + offset),
      ...Array.from({ length: 8 }, (_, offset) => 90 + offset),
      ...Array.from({ length: 8 }, (_, offset) => 40 + offset),
      ...Array.from({ length: 8 }, (_, offset) => 100 + offset),
    ].map(String);
    const unauthorizedColourForms = [
      ...ansi16Codes,
      "38;2;255;0;0",
      "38;5;108",
      "48;2;144;196;164",
      "48;5;108",
      "38:2::144:196:164",
      "48:5:108",
    ];
    for (const sgrCode of unauthorizedColourForms) {
      expect(renderedColours(`${board}\x1b[${sgrCode}mX\x1b[0m`), sgrCode).not.toEqual(approvedColours);
    }

    livePaletteControl.provisional = true;
    let provisionalFrame: string;
    try {
      provisionalFrame = await boardFrame(repo, 120);
    } finally {
      livePaletteControl.provisional = false;
    }
    const provisionalColours = renderedColours(provisionalFrame);
    expect(provisionalColours).not.toEqual(approvedColours);
    expect(provisionalColours).toContain("ansi256-background:236");
  });

  test("test: at forty, one hundred ten and two hundred twenty columns every TTY board places the running binary version directly below the tickmarkr brand and keeps every line within the measured width; a missing or same-line version fails", async () => {
    // Longer than the chip and carrying both optional SemVer sections: the complete running
    // version must size the gutter rather than being clipped to the repository fixture's width.
    const semver = "12.34.56-rc.7+build.20260820";
    const stamp = `v${semver}`;

    // The lockup rule, stated once: brand on one row, the running version on the row directly
    // below it and starting in the same column, and never on the brand's own row.
    const lockedUp = (lines: readonly string[]): void => {
      const brandRow = lines.findIndex((line) => line.includes("tickmarkr"));
      expect(brandRow).toBeGreaterThanOrEqual(0);
      expect(lines[brandRow]).not.toContain(stamp);
      expect(lines[brandRow + 1] ?? "").toContain(stamp);
      expect(lines[brandRow + 1]!.indexOf(stamp)).toBe(lines[brandRow]!.indexOf("tickmarkr"));
    };

    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await stubVersion(async () => semver, async () => {
      for (const columns of [40, 110, 220]) {
        const frame = await boardFrame(repo, columns);
        lockedUp(strip(frame).split("\n"));
        for (const line of frame.split("\n")) {
          expect(cellWidth(line), `${columns} cols: ${strip(line)}`).toBeLessThanOrEqual(columns);
        }
      }
    });

    // The two boards that must fail it: one naming no version at all, one naming it inline.
    expect(() => lockedUp([" tickmarkr   run-brand  1/3 done", "  rows in graph order"])).toThrow();
    expect(() => lockedUp([` tickmarkr ${stamp}  run-brand`, "  rows in graph order"])).toThrow();

    // …and the version the lockup names is the RUNNING binary's or nothing at all. A manifest that
    // cannot be read, and one that parses but names no version, both reach the operator as the
    // failure they are — never as a board rendering a placeholder version nobody can check.
    await stubVersion(async () => { throw new Error("ENOENT: no such file, open package.json"); }, async () => {
      await expect(status([], repo)).rejects.toThrow(/package\.json/u);
    });
    await stubVersion(async () => undefined as unknown as string, async () => {
      await expect(status([], repo)).rejects.toThrow(/names no version/u);
    });
  });

  test("the watch footer renders as a single dim legend line on a tty", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(true, async () => {
      const out = await watchFrame(repo);
      const footer = out.split("\n").at(-1)!;
      // one chrome-role line, nothing after it — and it names the 500ms frame cadence it keeps
      expect(footer).toBe(LIVE.chrome(" watching · refresh 0.5s · ^C to quit"));
    });
  });
});
