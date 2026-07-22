import { StudioApp, type StudioOptions } from "../../tui/app.js";

const NON_TTY_MSG =
  "tickmarkr ui: studio requires a TTY — use `tickmarkr fleet --print` or `tickmarkr status --watch` for line-mode output";

export async function ui(
  _argv: string[],
  io: Partial<StudioOptions> = {},
): Promise<string | { out: string; code: number }> {
  const input = io.input ?? (process.stdin as StudioOptions["input"]);
  const output = io.output ?? (process.stdout as StudioOptions["output"]);

  if (input.isTTY !== true || output.isTTY !== true) {
    return { out: NON_TTY_MSG, code: 1 };
  }

  const app = new StudioApp({ input, output });
  app.start();
  await app.exited;
  return "ui: closed";
}
