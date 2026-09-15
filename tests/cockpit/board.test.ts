import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { JournalEvent } from "../../src/run/journal.js";
import { readOperatorState } from "../../src/run/operator-state.js";
import { validateGraph } from "../../src/graph/schema.js";
import { graphDefinitionHash } from "../../src/graph/graph.js";
import { BOARD_EFFORT_BAR_MAX, BOARD_PALETTE, clipBoard, renderBoard, renderBoardLines, stripBoardAnsi, wrapNote } from "../../src/tui/cockpit/board.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import { planShell } from "../../src/tui/cockpit/layout.js";
import { BOARD_ASSIGNMENT, boardEndedEvents, boardEvents, boardFixture, boardGraph, BOARD_NOW, BOARD_RUN_ID } from "../fixtures/cockpit/board/board-fixture.js";
import { mountBoard, stripAnsi } from "../fixtures/cockpit/board/mount.js";

const fixtures = join(import.meta.dirname, "../fixtures/cockpit/board");
const pinned = (name: string): string[] => readFileSync(join(fixtures, name), "utf8").replace(/\n$/, "").split("\n");
/** The design prototype's own footer hints — the golden is its frame, footer included. */
const PROTOTYPE_KEYS = ["↑↓ move", "↵ task detail", "g gate detail", "j journal", "f fleet", "/ filter", "r refresh 5s", "q quit"];
const sgr = (n: number) => `\x1b[38;5;${n}m`;

describe("BD-1 — the approved task board", () => {
  test("the board renderer over the committed board fixture run at width 150 equals the committed frame the fixture copy of the prototype produced row for row after ANSI stripping, where that fixture run holds a task parked three times, a task with three review rounds, a task with a failed gate, a task waiting on an unmerged dependency, a dispatched task with no gate result, a task omitting review, a files entry outside the area map and a journal task id absent from the graph, and the same renderer over a run-ended fixture with every one of the failed, human, blocked and pending buckets empty draws the green header while four variants each parking one task in one of those buckets draw the non-green header, and the unstripped production frame paints passed cells in xterm 71, failed cells in 174, warnings in 179, parks in 140, the focus marker in 75 and the chrome in 238, 243, 252 and 240 as the SGR 38;5 sequences on those cells and rows themselves, so a renderer that drops a note, an UNMAPPED row, a ─ cell or the effort fold, or that reads a passed tip alone as green, fails", () => {
    // The fixture run holds every named condition — asserted on the fold, so the golden proves them all.
    const snapshot = readOperatorState({ events: boardEvents, graph: boardGraph });
    const task = (id: string) => snapshot.tasks.find((t) => t.id === id)!;
    expect(task("T1").parks).toBe(3);
    expect(task("T2").reviewRounds).toBe(3);
    expect(task("T3").gates.test!.state).toBe("failed");
    expect(boardGraph.tasks.find((t) => t.id === "T4")!.deps).toEqual(["T3"]); expect(task("T3").merged).toBe(false);
    expect(task("T5").dispatches).toBe(1); expect(Object.values(task("T5").gates).every((g) => g.state === "not-run")).toBe(true);
    expect(boardGraph.tasks.find((t) => t.id === "T6")!.gates).not.toContain("review");
    expect(boardGraph.tasks.find((t) => t.id === "T7")!.files).toContain("assets/board.png");
    expect(snapshot.tasks.some((t) => t.id === "T9")).toBe(true); expect(boardGraph.tasks.some((t) => t.id === "T9")).toBe(false);

    // Row for row against the frame the fixture copy of the prototype produced (frame.150.txt).
    const golden = pinned("frame.150.txt").map(stripBoardAnsi);
    const input = { runId: BOARD_RUN_ID, snapshot, graph: boardGraph, now: BOARD_NOW, keys: PROTOTYPE_KEYS };
    const rendered = renderBoard(input, 150);
    expect(rendered.map(stripBoardAnsi)).toEqual(golden);
    const plain = rendered.map(stripBoardAnsi).join("\n");
    for (const must of ["◍ parked ×3", "↻ 3 review rounds", "✖ test", "waiting on T3", "in flight", "UNMAPPED tests/cockpit/board.test.ts  assets/board.png", "T9  — not in this graph (retired at compile)", "WHERE THE EFFORT WENT", "gates left→right in declaration order"]) expect(plain).toContain(must);
    expect(plain).toMatch(/T6 .*✔ {2}✔ {2}✔ {2}· {2}· {2}· {2}─ /u);

    // Green needs the FOUR buckets empty; a passed tip alone is not green.
    const header = (events: readonly (typeof boardEvents)[number][]) => renderBoard({ ...input, snapshot: readOperatorState({ events, graph: boardGraph }) }, 150).find((line) => stripBoardAnsi(line).includes("RUN ENDED"))!;
    const green = header(boardEndedEvents());
    expect(stripBoardAnsi(green)).toContain("RUN ENDED — GREEN");
    expect(green).toContain(`${sgr(BOARD_PALETTE.pass)}RUN ENDED — GREEN`);
    for (const bucket of ["failed", "human", "blocked", "pending"] as const) {
      const parked = header(boardEndedEvents(bucket));
      expect(stripBoardAnsi(parked), bucket).toContain(`RUN ENDED — NOT GREEN  ${bucket} T8`);
      expect(parked, bucket).toContain(`${sgr(BOARD_PALETTE.fail)}RUN ENDED — NOT GREEN`);
      expect(parked, bucket).not.toContain(sgr(BOARD_PALETTE.pass));
    }
    expect(renderBoard(input, 150).some((line) => stripBoardAnsi(line).includes("RUN ENDED"))).toBe(false);

    // The production frame's colour: the SGR 38;5 sequences sit on the cells and rows themselves.
    const painted = renderBoard({ ...input, selection: "T1" }, 150);
    const row = (id: string) => painted.find((line) => stripBoardAnsi(line).slice(4).startsWith(`${id} `))!;
    expect(row("T1")).toMatch(/^ {2}\x1b\[38;5;75m❯\x1b\[39m /u);
    expect(row("T1")).toContain(`${sgr(BOARD_PALETTE.park)}◍ parked ×3`);
    expect(row("T2")).toContain(`${sgr(BOARD_PALETTE.warn)}↻ 3 review rounds`);
    expect(row("T2")).toContain(`${sgr(BOARD_PALETTE.pass)}✔`);
    expect(row("T3")).toContain(`${sgr(BOARD_PALETTE.fail)}✖`);
    expect(row("T3")).toContain(`${sgr(BOARD_PALETTE.fail)}✖ test`);
    expect(row("T6")).toContain(`${sgr(BOARD_PALETTE.faint)}─`);
    expect(row("T4")).toContain(`${sgr(BOARD_PALETTE.faint)}waiting on T3`);
    expect(row("T2")).toContain(`${sgr(BOARD_PALETTE.mute)}claude-code:opus`);
    expect(row("T3")).toContain(`${sgr(BOARD_PALETTE.body)}UI`);
    expect(painted.find((line) => stripBoardAnsi(line).startsWith("    ─"))).toContain(`${sgr(BOARD_PALETTE.chrome)}─`);
    expect(painted.at(-1)).toBe(`${sgr(BOARD_PALETTE.chrome)} ${PROTOTYPE_KEYS.join(" · ")}\x1b[39m`);
    for (const n of [238, 243, 252, 240, 75, 71, 174, 179, 140]) expect(painted.join("\n")).toContain(sgr(n));
    // Colour off draws the same rows with no SGR at all.
    expect(renderBoard({ ...input, selection: "T1", colour: false }, 150).join("\n")).not.toContain("\x1b[");
    // The three bands: full keeps the prototype rows; wrap moves a long note under its row; stacked puts the cells under the row.
    expect(renderBoardLines({ ...input, colour: false }, 150)).toEqual(renderBoard({ ...input, colour: false }, 150));
    const wrap = renderBoardLines({ ...input, colour: false }, 113);
    expect(wrap[wrap.indexOf(wrap.find((l) => l.startsWith("    T1 "))!) + 1]).toBe("         ◍ parked ×3 · 3/7 gates run");
    expect(wrap.every((l) => [...l].length <= 113)).toBe(true);
    const stacked = renderBoardLines({ ...input, colour: false }, 80);
    const t1 = stacked.indexOf(stacked.find((l) => l.startsWith("    T1 "))!);
    expect(stacked[t1 + 1]).toMatch(/^ {9}✔ {2}✔ {2}✔ {2}· {2}· {2}· {2}· {4}claude-cod +3/u);
    expect(stacked.every((l) => [...l].length <= 80)).toBe(true);
  });

  test("the cockpit mounted with the watch owner token at 150 columns plans zero rail columns and draws the board at the body width, the same mount at 113 columns equals the pinned rail-less frame whose note wraps onto a second row, the mount at 80 by 24 equals the pinned compact frame whose gate cells stack under the row, and the mount without the token at 150 columns keeps its rail, so a rail forced by width or a band that truncates instead of wrapping fails", async () => {
    // 150 with the token: no rail, no shortcuts, the board's rule spans the body.
    let f = boardFixture();
    let m = await mountBoard(f.cwd, f.runId, { columns: 150, rows: 40, owner: true });
    try {
      const geometry = m.delivery.geometry()!;
      expect(geometry).toMatchObject({ rail: 0, shortcuts: 0, bodyColumns: 148, focus: ["content"] });
      expect(planShell(150, 40, 0)).toMatchObject({ rail: 0, shortcuts: 0, bodyColumns: 148 });
      expect(planShell(220, 50, 0)).toMatchObject({ rail: 0, shortcuts: 0 });
      const lines = stripAnsi(m.frame()).split("\n");
      expect(lines[3]).toMatch(/^│RUN \/ RUNNING/u);
      expect(lines.find((l) => /^│─+│$/u.test(l))).toBe(`│${"─".repeat(148)}│`);
      expect(lines.some((l) => l.includes("│1 Home") || l.includes("Tab Focus   "))).toBe(false);
      expect(lines.some((l) => l.includes("❯ T1   SPEC+GATE"))).toBe(true);
    } finally { await m.close(); f.close(); }
    // 113 with the token: the pinned rail-less frame, note wrapped onto its own row.
    f = boardFixture();
    m = await mountBoard(f.cwd, f.runId, { columns: 113, rows: 40, owner: true });
    try {
      const lines = stripAnsi(m.frame()).split("\n");
      expect(lines).toEqual(pinned("railless.113x40.txt"));
      const t1 = lines.findIndex((l) => l.includes("❯ T1   SPEC+GATE"));
      expect(lines[t1]).not.toContain("parked");
      expect(lines[t1 + 1]).toBe(`│         ◍ parked ×3 · 3/7 gates run${" ".repeat(111 - 36)}│`);
      expect(lines.some((l) => l.includes("waiting on T3│"))).toBe(true);
    } finally { await m.close(); f.close(); }
    // 80×24 with the token: the pinned compact frame, gate cells stacked under the row.
    f = boardFixture();
    m = await mountBoard(f.cwd, f.runId, { columns: 80, rows: 24, owner: true });
    try {
      const lines = stripAnsi(m.frame()).split("\n");
      expect(lines).toEqual(pinned("compact.80x24.txt"));
      const t1 = lines.findIndex((l) => l.includes("❯ T1   SPEC+GATE"));
      expect(lines[t1]).not.toContain("✔");
      expect(lines[t1 + 1]).toMatch(/^│ {9}✔ {2}✔ {2}✔ {2}· {2}· {2}· {2}· {4}claude-cod +3 +│$/u);
      expect(lines[t1 + 2]).toContain("◍ parked ×3 · 3/7 gates run");
      expect(m.delivery.geometry()).toMatchObject({ rail: 0, shortcuts: 0, bodyColumns: 78 });
    } finally { await m.close(); f.close(); }
    // 150 without the token: the manual cockpit keeps its rail and its shortcuts.
    f = boardFixture();
    m = await mountBoard(f.cwd, f.runId, { columns: 150, rows: 40, owner: false });
    try {
      expect(m.delivery.geometry()).toMatchObject({ rail: 15, shortcuts: 22, bodyColumns: 109 });
      const lines = stripAnsi(m.frame()).split("\n");
      expect(lines.some((l) => l.startsWith("│1 Home"))).toBe(true);
      expect(lines.some((l) => l.includes("❯ T1   SPEC+GATE"))).toBe(true);
    } finally { await m.close(); f.close(); }
  });

  test("a parked task's Actions flow opened by the bytes a and carriage return written as one chunk on the tty fake shows the confirm preview, and the bytes n a carriage return written as one chunk while a confirm is open cancel it and show a fresh preview, so a cockpit that reads a multi-key chunk as one unknown key fails", async () => {
    const f = boardFixture();
    const m = await mountBoard(f.cwd, f.runId, { columns: 150, rows: 40 });
    try {
      const overlay = () => m.delivery.snapshot().state.overlay;
      const preview = () => overlay()?.join("\n") ?? "";
      expect(m.delivery.snapshot().store.operator.tasks[0]).toMatchObject({ id: "T1", state: "human" });
      // "a\r" as ONE chunk: a opens Actions on the parked T1, Enter picks approve — the confirm preview.
      m.input.write("a\r");
      expect(await m.until(() => preview().includes("y approve"))).toBe(true);
      const first = overlay();
      expect(preview()).toContain(`tickmarkr approve ${f.runId} T1 --by operator`);
      expect(stripAnsi(m.frame())).toContain("y approve");
      // "na\r" as ONE chunk while the confirm is open: n cancels it, a reopens Actions, Enter previews afresh.
      m.input.write("na\r");
      expect(await m.until(() => overlay() !== first && preview().includes("y approve"))).toBe(true);
      expect(overlay()).not.toBe(first);
      expect(preview()).toContain(`tickmarkr approve ${f.runId} T1 --by operator`);
      expect(m.input.kernel()).toBe("");
      // Nothing was appended: two previews, no confirmation — the journal keeps the fixture's two approvals only.
      expect(readFileSync(join(f.cwd, ".tickmarkr", "runs", f.runId, "journal.jsonl"), "utf8").split('"event":"task-approved"').length - 1).toBe(2);
      // n alone cancels; an escape sequence stays one key.
      m.input.write("n");
      expect(await m.until(() => overlay() === undefined)).toBe(true);
      m.input.write("\x1b[B");
      expect(await m.until(() => stripAnsi(m.frame()).includes("❯ T2 "))).toBe(true);
    } finally { await m.close(); f.close(); }
  });

  test("a plain chunk that begins with a bracket is split like any other — the bytes [ a carriage return written as one chunk open the parked task's confirm preview — while an unnamed escape sequence whose tail holds a bound key (the device-attributes reply ESC [ ? 1 ; 2 c) stays one key and opens no help, so a cockpit that exempts bracket-led text from splitting, or that splits escape sequences, fails (LEG2-T1 finding 2)", async () => {
    const f = boardFixture();
    const m = await mountBoard(f.cwd, f.runId, { columns: 150, rows: 40 });
    try {
      const preview = () => m.delivery.snapshot().state.overlay?.join("\n") ?? "";
      // Positive control first: an escape sequence Ink leaves unnamed arrives without its ESC and without flags.
      m.input.write("\x1b[?1;2c");
      m.input.write("[a\r");
      expect(await m.until(() => preview().includes("y approve"))).toBe(true);
      expect(preview()).toContain(`tickmarkr approve ${f.runId} T1 --by operator`);
      expect(m.delivery.snapshot().state.help).toBe(false);
      expect(m.input.kernel()).toBe("");
    } finally { await m.close(); f.close(); }
  });

  test("the effort bar never exceeds its 46-cell maximum for any apportionment: four dispatches, one review round and one park at 150 draw exactly 46 cells, and every split of up to six per segment at 80, 113, 150 and 200 columns stays within the maximum, so a bar that rounds its three segments independently fails (LEG2-T1 finding 1)", () => {
    const base = readOperatorState({ events: boardEvents, graph: boardGraph });
    const cells = (a: number, r: number, p: number, width: number): number => {
      const snapshot = { ...base, tasks: base.tasks.map((t) => (t.id === "T1" ? { ...t, dispatches: a, reviewRounds: r, parks: p } : { ...t, dispatches: 0, reviewRounds: 0, parks: 0 })) };
      const row = renderBoard({ runId: BOARD_RUN_ID, snapshot, graph: boardGraph, now: BOARD_NOW }, width).map(stripBoardAnsi).find((l) => /^ {4}T1 .* dispatch · /u.test(l))!;
      return [...row].filter((ch) => ch === "█").length;
    };
    // 4/6·46 = 30.67 and 1/6·46 = 7.67: independent rounding draws 31 + 8 + 8 = 47.
    expect(cells(4, 1, 1, 150)).toBe(BOARD_EFFORT_BAR_MAX);
    for (const width of [80, 113, 150, 200]) for (let a = 0; a <= 6; a++) for (let r = 0; r <= 6; r++) for (let p = 0; p <= 6; p++) {
      expect(cells(a, r, p, width), `${a}/${r}/${p} at ${width}`).toBeLessThanOrEqual(BOARD_EFFORT_BAR_MAX);
    }
  });

  test("a graph the journal did not record lends nothing: the rows are the journal's tasks alone, every gate reads as declared and the header says the graph is not comparable", () => {
    // Same task ids, different definition: a recompile the run never journaled.
    const recompiled = validateGraph({ ...boardGraph, tasks: boardGraph.tasks.map((t) => ({ ...t, title: `${t.title} (recompiled)`, deps: [], gates: undefined })) });
    const snapshot = readOperatorState({ events: boardEvents, graph: recompiled });
    expect(snapshot.comparable).toBe(false);
    const input = { runId: BOARD_RUN_ID, snapshot, graph: recompiled, now: BOARD_NOW, colour: false };
    const plain = renderBoard(input, 150).map(stripBoardAnsi);
    const text = plain.join("\n");
    expect(text).toContain("graph not comparable");
    expect(text).not.toContain("recompiled");
    expect(text).not.toContain("retired at compile");
    // Journal ids only, in journal order — T4 and T8 were never dispatched, so they are not rows.
    const ids = plain.map((l) => /^ {4}(T\d+) /u.exec(l)?.[1]).filter((id): id is string => id !== undefined && !/^T\d+ {2}—/u.test(id));
    expect(ids.slice(0, 7)).toEqual(snapshot.tasks.map((t) => t.id));
    expect(ids).not.toContain("T4"); expect(ids).not.toContain("T8");
    // T6 omitted review in the graph; without the graph the cell is pending, never "not declared".
    expect(plain.find((l) => l.startsWith("    T6 "))).toMatch(/✔ {2}✔ {2}✔ {2}· {2}· {2}· {2}· /u);
    // A comparable graph keeps the ─ cell — the boundary, not the renderer, decides.
    expect(renderBoard({ ...input, snapshot: readOperatorState({ events: boardEvents, graph: boardGraph }), graph: boardGraph }, 150).map(stripBoardAnsi).find((l) => l.startsWith("    T6 "))).toMatch(/─ /u);
  });

  test("a note that does not fit beside its row continues on indented rows in every band — a task parked three times with three review rounds and two failed gates loses nothing at 150 or 80", () => {
    let clock = Date.parse("2026-09-12T10:00:00.000Z");
    const ev = (event: string, data: Record<string, unknown> = {}, taskId?: string): JournalEvent => ({ ts: new Date((clock += 60_000)).toISOString(), event, data, ...(taskId ? { taskId } : {}) });
    const dispatch = (attempt: number) => ev("task-dispatch", { assignment: BOARD_ASSIGNMENT, attempt }, "T1");
    const park = () => [ev("task-human", { kind: "human-gate", reason: "asks" }, "T1"), ev("task-approved", { by: "operator", via: "cli" }, "T1")];
    const events: JournalEvent[] = [
      boardEvents[0]!,
      dispatch(0), ...park(), dispatch(1), ...park(), dispatch(2),
      ...["build", "test", "lint", "evidence", "scope", "acceptance"].map((g) => ev("gate-result", { gate: g, pass: true }, "T1")),
      ev("gate-result", { gate: "review", pass: false }, "T1"), ev("gate-result", { gate: "review", pass: false }, "T1"), ev("gate-result", { gate: "review", pass: false }, "T1"),
      ev("task-human", { kind: "gate-fail", reason: "review red" }, "T1"),
    ];
    const snapshot = readOperatorState({ events, graph: boardGraph });
    expect(snapshot.tasks[0]).toMatchObject({ id: "T1", parks: 3, reviewRounds: 3 });
    const input = { runId: BOARD_RUN_ID, snapshot, graph: boardGraph, now: BOARD_NOW, colour: false };
    const full = renderBoard(input, 150).map(stripBoardAnsi).find((l) => l.startsWith("    T1 "))!;
    expect(full).toContain("◍ parked ×3 · ↻ 3 review rounds · ✖ review");
    expect([...full].length).toBeGreaterThan(150);
    for (const width of [150, 113, 80]) {
      const lines = renderBoardLines(input, width);
      expect(lines.every((l) => [...l].length <= width), String(width)).toBe(true);
      const t1 = lines.findIndex((l) => l.startsWith("    T1 "));
      const block = lines.slice(t1, lines.findIndex((l, i) => i > t1 && l.startsWith("    T2 ")));
      const note = block.map((l) => l.trim()).join(" ");
      for (const part of ["◍ parked ×3", "↻ 3 review rounds", "✖ review"]) expect(note, String(width)).toContain(part);
      expect(block.slice(1).every((l) => l.startsWith(" ".repeat(9))), String(width)).toBe(true);
    }
    // The colour frame wraps the same way and keeps its SGR codes closed on every row.
    const painted = renderBoardLines({ ...input, colour: true }, 150);
    expect(painted.map(stripBoardAnsi)).toEqual(renderBoardLines(input, 150));
    // A single segment wider than a row splits at the cell and continues; nothing is dropped.
    expect(wrapNote(["◍ parked ×3", "waiting on T3, T4, T5, T6, T7"], " · ", 12, 10)).toEqual(["◍ parked ×3", "waiting on", " T3, T4, T", "5, T6, T7"]);
  });

  test("titles and channels of double-cell and emoji glyphs never widen a row past the body: a CJK title with a flag emoji at 150 stays within 150 cells in every band, no cluster is split and every row is well-formed UTF-16", () => {
    const wide = validateGraph({ ...boardGraph, tasks: boardGraph.tasks.map((t) => ({ ...t, title: `${"漢字".repeat(30)}🇸🇦👩‍💻 ${t.title}` })) });
    const events = [{ ...boardEvents[0]!, data: { ...boardEvents[0]!.data, graphDefinitionHash: graphDefinitionHash(wide) } }, ...boardEvents.slice(1)];
    const snapshot = readOperatorState({ events, graph: wide });
    expect(snapshot.comparable).toBe(true);
    const input = { runId: BOARD_RUN_ID, snapshot, graph: wide, now: BOARD_NOW, colour: false, selection: "T1" };
    for (const width of [150, 113, 80]) {
      for (const l of renderBoardLines(input, width)) {
        expect(cellWidth(l), `${width}: ${l}`).toBeLessThanOrEqual(width);
        expect(l.isWellFormed(), `${width}: ${l}`).toBe(true);
      }
    }
    // The wide title is cut on a cluster boundary and padded to the same column the ASCII rows use.
    const frame = renderBoard(input, 150);
    const t1 = frame.find((l) => l.startsWith("  ❯ T1 "))!, t8 = frame.find((l) => l.startsWith("    T8 "))!;
    expect(cellWidth(t1.slice(0, t1.indexOf("✔")))).toBe(cellWidth(t8.slice(0, t8.indexOf("·"))));
    expect(t1).not.toContain("🇸🇦👩‍💻");
    expect(clipBoard("ab漢字", 3)).toBe("ab");
    expect(clipBoard("\x1b[38;5;71m😀😀\x1b[39m", 3)).toBe("\x1b[38;5;71m😀\x1b[0m");
    expect(wrapNote(["漢字漢字漢"], " · ", 4, 4)).toEqual(["漢字", "漢字", "漢"]);
  });

  test("a journal task the graph retired is selectable and painted: the selection moved onto T9 carries the focus marker on its retired row and the viewport scrolls to it", async () => {
    const f = boardFixture();
    const m = await mountBoard(f.cwd, f.runId, { columns: 80, rows: 24, owner: true });
    try {
      const index = readOperatorState({ events: boardEvents, graph: boardGraph }).tasks.findIndex((t) => t.id === "T9");
      expect(index).toBeGreaterThan(0);
      for (let i = 0; i < index; i++) await m.send("\x1b[B");
      const lines = stripAnsi(m.frame()).split("\n");
      expect(lines.some((l) => l.includes("❯ T9  — not in this graph (retired at compile)"))).toBe(true);
      expect(m.delivery.snapshot().state.scroll).toBeGreaterThan(0);
    } finally { await m.close(); f.close(); }
  });

  test("a body too short for the board scrolls to keep the selected row in view: four Down keys at 80 by 24 show the T5 row, and Up after PageDown brings the selected row back", async () => {
    const f = boardFixture();
    const m = await mountBoard(f.cwd, f.runId, { columns: 80, rows: 24, owner: true });
    try {
      for (let i = 0; i < 4; i++) await m.send("\x1b[B");
      let lines = stripAnsi(m.frame()).split("\n");
      const t5 = lines.findIndex((l) => l.includes("❯ T5   UI"));
      expect(t5).toBeGreaterThan(0);
      expect(lines[t5 + 1]).toContain("·  ·  ·  ·  ·  ·  ·    claude-cod");
      expect(lines[t5 + 2]).toContain("in flight");
      expect(m.delivery.snapshot().state.scroll).toBeGreaterThan(0);
      await m.send("\x1b[6~");
      expect(stripAnsi(m.frame())).toContain("VERDICT /");
      await m.send("\x1b[A");
      lines = stripAnsi(m.frame()).split("\n");
      expect(lines.some((l) => l.includes("❯ T4   DOCS"))).toBe(true);
      expect(lines.some((l) => l.includes("VERDICT /"))).toBe(false);
    } finally { await m.close(); f.close(); }
  });
});

describe("BD-1 — the fixture copy of the prototype", () => {
  // The design prototype lives under .overseer, which the exporter drops; the byte-diff is skipped
  // on the exported tree because .overseer is absent there (the fixture copy still ships).
  const designPrototype = join(import.meta.dirname, "../../.overseer/design-prototypes/tasks-redesign.mjs");
  test.skipIf(!existsSync(designPrototype))("the fixture copy of the prototype differs from the design prototype only in reading its root, run and clock from the environment and in the two contract corrections — the declaration-order subtitle and the four-bucket green header — cited to the added fixture file in the diff", () => {
    const design = readFileSync(designPrototype, "utf8");
    const copy = readFileSync(join(fixtures, "tasks-redesign.mjs"), "utf8");
    // Undo exactly the permitted edits; anything else left over fails the byte comparison below.
    const permitted: Array<[string | RegExp, string]> = [
      // root and clock from the environment
      [/\/\/ FIXTURE COPY \(BD-1\)[^\n]*\n(\/\/[^\n]*\n){3}/u, ""],
      ['const ROOT = process.env.TKR_ROOT ?? "', 'const ROOT = "'],
      ["const NOW = () => Number(process.env.TKR_NOW ?? Date.now());\n", ""],
      [/\bNOW\(\)/gu, "Date.now()"],
      // contract correction: four-bucket green header
      [/ {4}\/\/ contract correction \(RULING-231-19 §2\): green needs[^\n]*\n(?:[^\n]*\n){4}/u, ""],
      [/ {6}: parkedIn\.length \|\| unknownIn\.length\n[^\n]*\n/u, ""],
      ['`${pass("RUN ENDED — GREEN")}  ${mute(`tip passed · ${tally}`)}`', '`${pass("RUN ENDED — TIP VERIFIED")}  ${mute(tally)}`'],
      // contract correction: declaration-order subtitle
      [/ {2}\/\/ contract correction \(RULING-231-19 §2\): declaration order[^\n]*\n/u, ""],
      ["gates left→right in declaration order", "gates left→right in pipeline order"],
    ];
    const reverted = permitted.reduce<string>((s, [from, to]) => {
      expect(s, `permitted edit missing from the copy: ${String(from)}`).toMatch(from instanceof RegExp ? from : new RegExp(from.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      return s.replace(from, to);
    }, copy);
    expect(reverted).toBe(design);
    // The copy reads run id from the environment exactly as the design prototype already does.
    expect(copy).toContain('const RUN_ID = process.env.TKR_RUN ?? "run-20260801-122155";');
    expect(design).toContain('const RUN_ID = process.env.TKR_RUN ?? "run-20260801-122155";');
  });
});
