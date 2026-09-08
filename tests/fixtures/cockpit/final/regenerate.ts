import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureShellOutput } from "../../../../src/tui/cockpit/capture.js";
import { shellFixture } from "./capture-fixture.js";
const fixture = shellFixture();
try {
  for (const view of ["home", "run", "evidence"] as const) for (const [columns, rows] of [[120, 40], [80, 24]]) {
    const frame = await captureShellOutput({ ...fixture, view, columns, rows });
    writeFileSync(join(import.meta.dirname, `${view}.${columns}x${rows}.txt`), frame + "\n");
  }
} finally { fixture.close(); }
