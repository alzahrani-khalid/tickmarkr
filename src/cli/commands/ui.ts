const NON_TTY_MSG =
  "tickmarkr ui: studio requires a TTY — use `tickmarkr fleet --print` or `tickmarkr status --watch` for line-mode output";

type StudioIO = {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
};

export async function ui(
  _argv: string[],
  io: Partial<StudioIO> = {},
): Promise<string | { out: string; code: number }> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;

  if (input.isTTY !== true || output.isTTY !== true) {
    return { out: NON_TTY_MSG, code: 1 };
  }

  const { runStudioInk } = await import("../../tui/ink/studio-app.js");
  await runStudioInk({ input, output });
  return "ui: closed";
}
