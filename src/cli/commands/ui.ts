import { join } from "node:path";
import { Journal, parseRunId } from "../../run/journal.js";
import { stateDirName } from "../../graph/graph.js";
import { JournalTail } from "../../tui/cockpit/live-store.js";

const NON_TTY_MSG = "tickmarkr ui: the cockpit requires a TTY — use `tickmarkr fleet --print` or `tickmarkr status --watch` for line-mode output";
type StudioIO = { input: NodeJS.ReadStream; output: NodeJS.WriteStream };

export async function ui(argv: string[], io: Partial<StudioIO> = {}, cwd = process.cwd()): Promise<string | { out: string; code: number }> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  if (input.isTTY !== true || output.isTTY !== true) return { out: NON_TTY_MSG, code: 1 };
  let explicit: string | undefined;
  let view: "home" | "run" | "evidence" = "home";
  let setup = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--setup") setup = true;
    else if (arg === "--view") {
      const value = argv[++i];
      if (value !== "home" && value !== "run" && value !== "evidence") return { out: "tickmarkr ui: --view must be home, run or evidence", code: 1 };
      view = value;
    } else if (arg.startsWith("-")) return { out: `tickmarkr ui: unknown flag ${arg}`, code: 1 };
    else if (explicit !== undefined) return { out: "tickmarkr ui: expected at most one run ID", code: 1 };
    else explicit = arg;
  }
  let runId: string | null = null;
  try {
    runId = explicit === undefined ? Journal.latestRunId(cwd, { withJournal: true }) : parseRunId(explicit);
    // Refuse an invalid explicit target before importing or borrowing the terminal.
    if (runId) {
      const initial = new JournalTail(join(cwd, stateDirName(cwd), "runs", runId, "journal.jsonl")).poll();
      if (initial.status === "unreadable" || initial.status === "corrupt") throw new Error(initial.error?.error ?? initial.errors[0]?.error ?? "journal corrupt");
    }
  } catch (error) { return { out: `tickmarkr ui: cannot read engagement ${runId ?? explicit ?? "latest"}: ${(error as Error).message}`, code: 1 }; }
  const { runLiveCockpit } = await import("../../tui/cockpit/live.js");
  const { version } = await import("./version.js");
  const options = {
    input, output, cwd, runId: runId ?? "run-no-run", binaryVersion: await version(),
    observeRun: runId !== null, initialView: runId === null ? "home" as const : setup ? "run" as const : view,
    initialParks: setup,
  };
  await runLiveCockpit(options);
  return "ui: closed";
}
