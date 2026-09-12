import { Writable } from "node:stream";
import { setImmediate as yieldFrame, setTimeout as wait } from "node:timers/promises";
import { runLiveCockpit } from "../../../../src/tui/cockpit/live.js";
import type { ShellDelivery } from "../../../../src/tui/cockpit/live-runtime.js";
import { ttyInput } from "../../../helpers/tty-input.js";
export async function mountShell(cwd: string, runId: string, columns = 120, rows = 40, environment?: NodeJS.ProcessEnv) {
  let lastFrame = "", controls = "", writes = 0;
  const raw: boolean[] = [];
  const input = ttyInput({ onRawMode: v => { raw.push(v); } });
  const output = new Writable({ write(chunk, _encoding, next) {
    writes++;
    const text = String(chunk);
    if (text.includes("q Quit")) lastFrame = text.slice(-20000);
    else controls = (controls + text).slice(-4000);
    next();
  } }) as NodeJS.WriteStream;
  Object.assign(output, { isTTY: true, columns, rows });
  let delivery!: ShellDelivery;
  const mounted = runLiveCockpit({ cwd, runId, input, output, environment, binaryVersion: "fixture", debug: true, refreshMs: 2 ** 30, onShellDelivery: d => { delivery = d; } });
  // Attach rejection handling immediately, including an induced stream failure.
  const result = mounted.then(() => undefined, error => error as Error);
  await wait(30);
  return { input, output, delivery, raw, result, frame: () => lastFrame, controls: () => controls, writes: () => writes,
    send: async (bytes: string) => { input.write(bytes); await wait(20); },
    resizeAndPaint: async (w: number, h: number) => {
      const before = writes;
      output.columns = w; output.rows = h; output.emit("resize");
      const deadline = Date.now() + 2000;
      while (writes === before || lastFrame.split("\n").length !== h || delivery.geometry()?.columns !== w) {
        if (Date.now() > deadline) throw new Error(`No ${w}x${h} painted frame`);
        await yieldFrame();
      }
    },
    resize: async (w: number, h: number) => { output.columns = w; output.rows = h; output.emit("resize"); await wait(20); },
    close: async () => { delivery.key({ input: "q", key: {} }); delivery.key({ input: "c", key: { ctrl: true } }); await result; input.destroy(); output.destroy(); },
  };
}
