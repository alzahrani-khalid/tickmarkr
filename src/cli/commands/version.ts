import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../../package.json");
const distDir = join(dirname(pkgPath), "dist");

export function distFingerprint(dir = distDir): string {
  if (!existsSync(dir)) return "missing";
  const files: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  visit(dir);
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(relative(dir, file)).update("\0").update(readFileSync(file)).update("\0");
  return hash.digest("hex");
}

export async function version(argv: string[] = [], dir = distDir): Promise<string> {
  const { version: v } = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return argv.includes("--dist") ? `${v} dist:${resolve(dir)} fingerprint:${distFingerprint(dir)}` : v;
}
