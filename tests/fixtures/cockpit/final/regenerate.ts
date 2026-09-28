import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureShellOutput } from "../../../../src/tui/cockpit/capture.js";
import { REPLAYED_SOAK_RECORDS, replayFramePath, replaySoakRecord } from "../../screen-soak/test-support.js";
import { shellFixture } from "./capture-fixture.js";
const fixture = shellFixture();
try {
  for (const view of ["home", "run", "evidence"] as const) for (const [columns, rows] of [[120, 40], [80, 24]]) {
    const frame = await captureShellOutput({ ...fixture, view, columns, rows });
    writeFileSync(join(import.meta.dirname, `${view}.${columns}x${rows}.txt`), frame + "\n");
  }
} finally { fixture.close(); }
// Frame replay of each sealed soak record: new replay-run frames; its measured evidence stays untouched.
for (const record of REPLAYED_SOAK_RECORDS) {
  const replay = replaySoakRecord(record);
  try {
    for (const [columns, rows] of [[120, 40], [80, 24]]) {
      const frame = await captureShellOutput({ cwd: replay.cwd, runId: replay.runId, view: "run", columns, rows });
      writeFileSync(replayFramePath(record, columns, rows), frame + "\n");
    }
  } finally { replay.close(); }
}
