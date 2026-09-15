import { Writable } from "node:stream";
import { setImmediate as yieldFrame, setTimeout as wait } from "node:timers/promises";
import { runLiveCockpit } from "../../../../src/tui/cockpit/live.js";
import type { ShellDelivery } from "../../../../src/tui/cockpit/live-runtime.js";
import { reserveWatchBoard, WATCH_OWNER_ENV } from "../../../../src/run/supervision.js";
import { ttyInput } from "../../../helpers/tty-input.js";
import { BOARD_NOW } from "./board-fixture.js";

export const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

/**
 * Mount the cockpit on the Run view over a board fixture the daemon's way (BD-1): `owner: true`
 * reserves the watch-board record and puts its token in the mount's environment, which is what the
 * daemon-placed board carries. The clock is the fixture's, so a pinned frame does not drift.
 */
export async function mountBoard(cwd: string, runId: string, options: { columns?: number; rows?: number; owner?: boolean; environment?: NodeJS.ProcessEnv } = {}) {
  const { columns = 150, rows = 40 } = options;
  let lastFrame = "", writes = 0;
  const input = ttyInput();
  const output = new Writable({ write(chunk, _encoding, next) {
    writes++;
    const text = String(chunk);
    if (text.includes("q Quit")) lastFrame = text.slice(-40000);
    next();
  } }) as NodeJS.WriteStream;
  Object.assign(output, { isTTY: true, columns, rows });
  const owner = options.owner ? reserveWatchBoard({ repo: cwd, runId, driver: "fixture", workspace: "fixture", pane: "fixture:p1", name: "fixture-board" }) : undefined;
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1", ...(owner ? { [WATCH_OWNER_ENV]: owner.token } : {}), ...options.environment };
  let delivery!: ShellDelivery;
  const mounted = runLiveCockpit({ cwd, runId, input, output, environment, binaryVersion: "fixture", debug: true, refreshMs: 2 ** 30, now: () => BOARD_NOW, initialView: "run", onShellDelivery: d => { delivery = d; } });
  const result = mounted.then(() => undefined, error => error as Error);
  const deadline = Date.now() + 5000;
  while (lastFrame === "" && delivery === undefined) { if (Date.now() > deadline) throw new Error("no first frame"); await yieldFrame(); }
  await wait(30);
  return {
    input, delivery, result, owner,
    frame: () => lastFrame, writes: () => writes,
    send: async (bytes: string) => { input.write(bytes); await wait(30); },
    /** Frame-acknowledged wait on an observable. */
    until: async (pred: () => boolean, ms = 3000): Promise<boolean> => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) return false; await yieldFrame(); } return true; },
    close: async () => { delivery.key({ input: "q", key: {} }); delivery.key({ input: "c", key: { ctrl: true } }); await result; input.destroy(); output.destroy(); },
  };
}
