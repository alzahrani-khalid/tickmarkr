const NON_TTY_MSG =
  "tickmarkr ui: studio requires a TTY — use `tickmarkr fleet --print` or `tickmarkr status --watch` for line-mode output";

type StudioIO = {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
};

export async function ui(
  argv: string[],
  io: Partial<StudioIO> = {},
): Promise<string | { out: string; code: number }> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;

  if (input.isTTY !== true || output.isTTY !== true) {
    return { out: NON_TTY_MSG, code: 1 };
  }

  if (argv.includes("--demo")) {
    const { runCockpitDemo } = await import("../../tui/cockpit/demo.js");
    const { version } = await import("./version.js");
    await runCockpitDemo({
      input,
      output,
      binaryVersion: await version(),
    });
    return "ui: closed";
  }

  const { runStudioInk } = await import("../../tui/ink/studio-app.js");
  await runStudioInk({ input, output });
  return "ui: closed";
}
