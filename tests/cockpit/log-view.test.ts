import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { narrationSink } from "../../src/cli/commands/run.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { renderLogLines } from "../../src/tui/cockpit/log-view.js";
import { SHELL_BINDINGS } from "../../src/tui/cockpit/keys.js";
import { boardEvents, boardFixture, BOARD_RUN_ID } from "../fixtures/cockpit/board/board-fixture.js";
import { mountBoard, stripAnsi } from "../fixtures/cockpit/board/mount.js";

const wait = (count: number): JournalEvent => ({ ts: "2026-09-12T10:00:00.000Z", event: "suite-wait", data: { count } });

test("D-843 PARITY: Log lines equal the daemon narrationSink for the same TTY events, width, suppression and hostile detail", () => {
  const events = [...boardEvents, wait(37), { ...wait(38), event: "phase-start", data: {} },
    { ...wait(39), event: "task-failed", taskId: "T1", data: { error: "bad\u001b[2J\ntext 界 👩‍💻" } },
    { ...wait(40), event: "unrecognized-event" }, { ...wait(41), event: "worker-contact" }];
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  try {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    for (const width of [40, 78, 109, 150]) {
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: width });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        events.forEach(narrationSink(BOARD_RUN_ID));
        expect(renderLogLines(events, BOARD_RUN_ID, width)).toEqual(log.mock.calls.map(call => call[0]));
        expect(log.mock.calls.length).toBeLessThan(events.length);
      } finally { log.mockRestore(); }
    }
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty); else Reflect.deleteProperty(process.stdout, "isTTY");
    if (columns) Object.defineProperty(process.stdout, "columns", columns); else Reflect.deleteProperty(process.stdout, "columns");
  }
});

test("D-843: the daemon-owned board opens Log by key and rail, follows appends, pages beyond retained history, pauses scrolling and resumes follow with f", async () => {
  const events = [...boardEvents, ...Array.from({ length: 600 }, (_, i) => wait(i + 1)),
    ...Array.from({ length: 300 }, () => ({ ...wait(0), event: "worker-contact" }))];
  const f = boardFixture(events);
  const m = await mountBoard(f.cwd, f.runId, { columns: 150, rows: 24, owner: true });
  try {
    expect(new Set(SHELL_BINDINGS.map(binding => binding.key)).size).toBe(SHELL_BINDINGS.length);
    await m.send("7");
    expect(m.delivery.snapshot().state.view).toBe("log");
    const visible = () => {
      const g = m.delivery.geometry()!;
      return g.paintedRows.filter(row => row.column === g.bodyColumn && row.row >= g.bodyRow && row.row < g.bodyRow + g.bodyRows).map(row => stripAnsi(row.text));
    };
    const expected = () => renderLogLines(events, f.runId, m.delivery.geometry()!.bodyColumns).slice(-m.delivery.geometry()!.bodyRows).map(stripAnsi);
    expect(visible()).toEqual(expected());
    expect(stripAnsi(m.frame())).toContain("FOLLOW");
    const append = wait(601);
    appendFileSync(join(f.cwd, ".tickmarkr/runs", f.runId, "journal.jsonl"), JSON.stringify(append) + "\n");
    events.push(append);
    m.delivery.refresh();
    expect(await m.until(() => visible().at(-1) === expected().at(-1))).toBe(true);
    await m.send("\x1b[5~");
    expect(m.delivery.snapshot().state.logEnd).toBeDefined();
    const paused = visible();
    const next = wait(602);
    appendFileSync(join(f.cwd, ".tickmarkr/runs", f.runId, "journal.jsonl"), JSON.stringify(next) + "\n");
    events.push(next); m.delivery.refresh();
    expect(await m.until(() => stripAnsi(m.frame()).includes("PAUSED"))).toBe(true);
    expect(visible()).toEqual(paused);
    for (let i = 0; i < 20; i++) await m.send("\x1b[5~");
    const firstRetained = m.delivery.snapshot().store.journal.history[0]!.line;
    expect(m.delivery.snapshot().state.logEnd).toBeLessThan(firstRetained);
    const older = m.delivery.snapshot().state.logEnd!;
    await m.send("\x1b[6~");
    expect(m.delivery.snapshot().state.logEnd).toBeGreaterThan(older);
    const pageEnd = m.delivery.snapshot().state.logEnd!;
    await m.send("\x1b[A");
    expect(m.delivery.snapshot().state.logEnd).toBe(pageEnd - 1);
    await m.send("\x1b[B");
    expect(m.delivery.snapshot().state.logEnd).toBe(pageEnd);
    await m.send("f");
    expect(m.delivery.snapshot().state.logEnd).toBeUndefined();
    expect(visible()).toEqual(expected());
    await m.send("4");
    const rail = m.delivery.geometry()!.paintedRows.find(row => row.text.trim() === "7 Log")!;
    expect(m.delivery.pointer({ action: "press", column: rail.column, row: rail.row, button: 0 })).toBe(true);
    expect(await m.until(() => m.delivery.snapshot().state.view === "log")).toBe(true);
    expect(visible()).toEqual(expected());
  } finally { await m.close(); f.close(); }
});


test("LEG B REPAIR: paused Log survives Down and PageDown after an unrefreshed append, keeps its position, and pages normally after refresh", async () => {
  const f = boardFixture([...boardEvents, ...Array.from({ length: 600 }, (_, i) => wait(i + 1))]);
  const m = await mountBoard(f.cwd, f.runId, { columns: 150, rows: 24, owner: true });
  let stopped = false;
  void m.result.then(() => { stopped = true; });
  try {
    await m.send("7");
    await m.send("\x1b[5~");
    await m.send("\x1b[5~");
    const end = m.delivery.snapshot().state.logEnd!;
    expect(end).toBeDefined();
    const observedLines = m.delivery.snapshot().store.journal.lines;
    appendFileSync(join(f.cwd, ".tickmarkr/runs", f.runId, "journal.jsonl"), JSON.stringify(wait(601)) + "\n");
    for (const bytes of ["\x1b[B", "\x1b[6~"]) {
      const inputs = m.delivery.snapshot().store.inputSequence;
      await m.send(bytes);
      expect(stopped).toBe(false);
      expect(m.delivery.snapshot().store.inputSequence).toBeGreaterThan(inputs);
      expect(m.delivery.snapshot().store.journal.lines).toBe(observedLines);
      expect(m.delivery.snapshot().state.logEnd).toBe(end);
      expect(stripAnsi(m.frame())).toContain("| LOG |");
    }
    m.delivery.refresh();
    expect(m.delivery.snapshot().store.journal.lines).toBe(observedLines + 1);
    await m.send("\x1b[B");
    expect(m.delivery.snapshot().state.logEnd).toBe(end + 1);
    await m.send("\x1b[6~");
    expect(m.delivery.snapshot().state.logEnd).toBe(end + 1 + m.delivery.geometry()!.bodyRows);
    expect(stopped).toBe(false);
  } finally { await m.close(); f.close(); }
});
