const NON_TTY_MSG =
  "tickmarkr ui: the cockpit requires a TTY — use `tickmarkr fleet --print` or `tickmarkr status --watch` for line-mode output";

/**
 * The setup surface's own flag. `tickmarkr ui --setup [run-id]` opens the one
 * surface that writes — parked human decisions, approved or upheld through the
 * production command path behind an explicit confirm.
 */
const SETUP_FLAG = "--setup";

type StudioIO = {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
};

export async function ui(
  argv: string[],
  io: Partial<StudioIO> = {},
  cwd = process.cwd(),
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

  const setup = argv.includes(SETUP_FLAG);
  const unknownFlag = argv.find((arg) => arg.startsWith("-") && arg !== SETUP_FLAG);
  if (unknownFlag) {
    return { out: `tickmarkr ui: unknown flag ${unknownFlag}`, code: 1 };
  }

  const live = await import("../../tui/cockpit/live.js");
  const { version } = await import("./version.js");
  const binaryVersion = await version();
  const explicit = argv.find((arg) => !arg.startsWith("-"));

  let runId: string | null;
  try {
    runId = live.selectEngagementRunId(cwd, explicit);
  } catch (error) {
    return { out: `tickmarkr ui: ${(error as Error).message}`, code: 1 };
  }
  if (runId === null) {
    return {
      out: "tickmarkr ui: no engagement found — start one with `tickmarkr run` first",
      code: 1,
    };
  }

  // Refuse before drawing anything: unreadable journal bytes must never
  // become a plausible surface derived from nothing.
  try {
    live.deriveLiveRunCockpitData(live.loadEngagementSource(cwd, runId), binaryVersion);
  } catch (error) {
    return {
      out: `tickmarkr ui: cannot read engagement ${runId}: ${(error as Error).message}`,
      code: 1,
    };
  }

  if (setup) {
    const { runSetupDecisionsCockpit } = await import("../../tui/cockpit/setup-cockpit.js");
    await runSetupDecisionsCockpit({ input, output, cwd, runId });
    return "ui: closed";
  }

  await live.runLiveCockpit({ input, output, cwd, runId, binaryVersion });
  return "ui: closed";
}
