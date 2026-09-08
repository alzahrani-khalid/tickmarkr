import { execFileSync } from "node:child_process";
import { copyFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeTestTempDir } from "../../helpers/tmprepo.js";

let compiled: string | undefined;
/** Compile into a test-owned tree; root dist may be rebuilt by the serialized CLI tests. */
export function isolatedBuild(): string {
  if (compiled) return compiled;
  const root = resolve(import.meta.dirname, "../../..");
  const destination = makeTestTempDir("c6-production-build-");
  copyFileSync(join(root, "package.json"), join(destination, "package.json"));
  symlinkSync(join(root, "node_modules"), join(destination, "node_modules"), "dir");
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--project", join(root, "tsconfig.json"), "--outDir", join(destination, "dist"), "--declaration", "false"], { cwd: root, stdio: "pipe" });
  compiled = destination;
  return destination;
}
