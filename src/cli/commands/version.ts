import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../../package.json");

export async function version(_argv: string[] = []): Promise<string> {
  const { version: v } = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return v;
}
