import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { graphDefinitionHash } from "../../../../src/graph/graph.js";
import { readOperatorState } from "../../../../src/run/operator-state.js";
import { renderBoardLines } from "../../../../src/tui/cockpit/board.js";
import { boardEvents, boardFixture, boardGraph, BOARD_NOW, BOARD_RUN_ID } from "./board-fixture.js";
import { mountBoard, stripAnsi } from "./mount.js";

/**
 * Regenerates the live/prototype pins and checks the frozen pre-leg pins in board.test.ts:
 *   frame.150.txt      — the FIXTURE COPY of the design prototype over the board fixture at 150 columns
 *   rails.113x40.txt   — the daemon-owned production mount at 113×40, with its rails
 *   compact.80x24.txt  — the same mount at 80×24: gate cells stack under the row
 *   unchanged.*.txt   — FROZEN full/wrap oracles captured from pre-leg board.ts at cff74234; never regenerated
 * Run: `npx tsx tests/fixtures/cockpit/board/regenerate.ts`. The tests never call this.
 */
const f = boardFixture();
try {
  const frame = execFileSync(process.execPath, [join(import.meta.dirname, "tasks-redesign.mjs")], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, TKR_ROOT: f.cwd, TKR_RUN: f.runId, TKR_NOW: String(BOARD_NOW), COLS: "150" },
  });
  writeFileSync(join(import.meta.dirname, "frame.150.txt"), frame);
} finally { f.close(); }
// One fresh repository per mount: a watch-board record and supervision beat outlive a mount.
for (const [name, columns, rows] of [["rails.113x40.txt", 113, 40], ["compact.80x24.txt", 80, 24]] as const) {
  const g = boardFixture();
  const m = await mountBoard(g.cwd, g.runId, { columns, rows, owner: true });
  try { writeFileSync(join(import.meta.dirname, name), stripAnsi(m.frame()) + "\n"); } finally { await m.close(); g.close(); }
}
// Frozen pre-leg oracles captured from src/tui/cockpit/board.ts at cff74234.
// Never write or regenerate unchanged.*: compare current output, including Unicode and ANSI bytes.
const title = "A long task title reaches the pane edge 界 👩‍💻 without an artificial label cap";
const graph = { ...boardGraph, tasks: boardGraph.tasks.map(task => ({ ...task, title })) };
const events = boardEvents.map(event => event.event === "run-start" ? { ...event, data: { ...event.data, graphDefinitionHash: graphDefinitionHash(graph) } } : event);
const input = { runId: BOARD_RUN_ID, snapshot: readOperatorState({ events, graph }), graph, now: BOARD_NOW, colour: true };
for (const width of [110, 113, 149, 150, 180]) {
  const name = `unchanged.${width}.txt`;
  const current = Buffer.from(renderBoardLines(input, width).join("\n") + "\n");
  if (!current.equals(readFileSync(join(import.meta.dirname, name)))) {
    throw new Error(`${name}: current board output differs from frozen pre-leg oracle (cff74234)`);
  }
}
