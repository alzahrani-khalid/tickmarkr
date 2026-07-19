// One-off capture harness for the OBS-82 spinner fixture (v1.57 T2). Reads a live wedged codex
// pane through the PRODUCTION driver read path — HerdrDriver.read, the exact call whose snapshots
// the daemon's stall compare consumes (src/run/daemon.ts interactive loop, lines=1000) — so the
// frames carry the rendered form herdr actually returns, not a raw-pty transcript (spec ruling 7).
// Usage: npx tsx tests/fixtures/codex-mcp-spinner/capture.ts <paneId> <frames> <intervalMs>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HerdrDriver } from "../../../src/drivers/herdr.js";

const [paneId, framesArg = "8", intervalArg = "2000"] = process.argv.slice(2);
if (!paneId) throw new Error("usage: capture.ts <paneId> [frames] [intervalMs]");
const frames = Number(framesArg);
const intervalMs = Number(intervalArg);

const driver = new HerdrDriver();
// the slot name is deliberately unregistered — paneId() falls back to the literal pane id
const slot = { id: paneId, name: "codex-mcp-spinner-capture", cwd: process.cwd() };
const outDir = import.meta.dirname;
mkdirSync(outDir, { recursive: true });

for (let i = 1; i <= frames; i++) {
  const text = await driver.read(slot, 1000); // the daemon's interactive read: driver.read(slot, 1000)
  writeFileSync(join(outDir, `frame-${String(i).padStart(2, "0")}.txt`), text);
  console.log(`frame-${String(i).padStart(2, "0")}.txt ${text.length} bytes @ ${new Date().toISOString()}`);
  if (i < frames) await new Promise((r) => setTimeout(r, intervalMs));
}
