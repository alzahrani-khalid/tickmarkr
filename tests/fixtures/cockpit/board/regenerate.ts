import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardFixture, BOARD_NOW } from "./board-fixture.js";
import { mountBoard, stripAnsi } from "./mount.js";

/**
 * Produces the committed board frames, each written independently of the render under test:
 *   frame.150.txt      — the FIXTURE COPY of the design prototype over the board fixture at 150 columns
 *   railless.113x40.txt — the cockpit mounted the daemon's way (owner token) at 113×40: note wraps
 *   compact.80x24.txt   — the same mount at 80×24: gate cells stack under the row
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
for (const [name, columns, rows] of [["railless.113x40.txt", 113, 40], ["compact.80x24.txt", 80, 24]] as const) {
  const g = boardFixture();
  const m = await mountBoard(g.cwd, g.runId, { columns, rows, owner: true });
  try { writeFileSync(join(import.meta.dirname, name), stripAnsi(m.frame()) + "\n"); } finally { await m.close(); g.close(); }
}
