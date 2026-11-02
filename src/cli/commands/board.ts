import { parseArgs } from "node:util";
import { readRunBoard } from "../../board/read.js";

/** The run board as one JSON line for the Claude Code pane. Strict parsing: no positionals, no unknown flags, a string
 *  flag without its value refuses. Help is the dispatcher's; a throw becomes its one-line exit 1. */
export async function board(argv: string[]): Promise<string> {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    json: { type: "boolean" }, root: { type: "string", multiple: true }, release: { type: "string", multiple: true },
  } });
  if (!values.json) throw new Error("--json is required: board prints one JSON line for the board pane");
  return JSON.stringify(readRunBoard(process.cwd(), values.root ?? [], values.release ?? [], Date.now() / 1000));
}
