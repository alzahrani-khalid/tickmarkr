import { parseArgs } from "node:util";
import { createAcpAgent } from "../../acp/server.js";

export async function acp(argv: string[]): Promise<string> {
  parseArgs({ args: argv, options: {}, allowPositionals: false });
  // Keep the original writer private to the peer. Console and direct stream writes from
  // every other caller go to stderr for the rest of this protocol process's lifetime.
  const protocolWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  await createAcpAgent({ input: process.stdin, write: (line) => { protocolWrite(line); } }).done;
  return "";
}
