import { setImmediate as yieldFrame } from "node:timers/promises";
import { expect, test } from "vitest";
import { shellFixture } from "../fixtures/cockpit/final/capture-fixture.js";
import { mountShell } from "../fixtures/cockpit/final/mount.js";

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const selected = (frame: string) => stripAnsi(frame).split("\n").find(line => line.includes("❯ ")) ?? "";
// Frame-acknowledged, not clock-paced: poll the observable until it holds or the deadline passes.
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) return false; await yieldFrame(); }
  return true;
}

/**
 * OBS-965 / RULING-231-19 §1 — the deaf board. On a real tty (highWaterMark 0) the handle is
 * `readStop`ped after every chunk and only a `read()` that finds the buffer EMPTY restarts it. The
 * cockpit's stdin Proxy read ONE chunk and returned null when that chunk was pointer-only, so Ink's
 * drain loop stopped before that empty read: every later key queued in the kernel forever. The fake
 * here is a tty instance, not a pipe — see tests/helpers/tty-input.ts.
 */
test("OBS-965: a pointer-only chunk leaves the tty handle re-armed and the next key still moves the selection", async () => {
  const f = shellFixture();
  const m = await mountShell(f.cwd, f.runId);
  try {
    expect(await until(() => m.frame() !== "", 2000), "first frame painted").toBe(true);
    const writes = m.writes();
    m.input.write("4");
    expect(await until(() => m.writes() > writes && selected(m.frame()) !== "", 2000), "run view painted a selection").toBe(true);
    const before = selected(m.frame());
    // One SGR motion report, alone in its chunk: the hover that deafened the live board.
    m.input.write("\x1b[<35;56;3M");
    await until(() => m.input.armed(), 500);
    expect(m.input.armed(), "the tty handle is re-armed after a pointer-only chunk").toBe(true);
    m.input.write("\x1b[B");
    expect(await until(() => selected(m.frame()) !== before, 2000), "Down moved the selection").toBe(true);
    expect(m.input.kernel()).toBe("");
    expect(selected(m.frame())).toContain("❯ ");
  } finally { await m.close(); f.close(); }
});
