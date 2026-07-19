import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunGraph } from "../graph/schema.js";
import { CompileError } from "./common.js";
import { compileGsd, isGsdPhaseDir } from "./gsd.js";
import { compileNative, TICKMARKR_NATIVE_MARKER } from "./native.js";
import { compilePrd } from "./prd.js";
import { compileSpecKit } from "./speckit.js";

type SourceType = "speckit" | "gsd" | "prd" | "native";

function detect(src: string): SourceType | null {
  if (existsSync(src) && statSync(src).isDirectory()) {
    if (existsSync(join(src, "tasks.md"))) return "speckit";
    if (isGsdPhaseDir(src)) return "gsd"; // gsd.ts owns the *-PLAN.md rule; unreadable dirs fall to null
    return null;
  }
  if (src.endsWith("-PLAN.md")) return "gsd"; // before the generic .md → prd rule
  if (src.endsWith(".md")) {
    if (!existsSync(src)) return "prd";
    const content = readFileSync(src, "utf8");
    if (TICKMARKR_NATIVE_MARKER.test(content)) return "native";
    return "prd";
  }
  return null;
}

export function compileSource(src: string, type?: SourceType, root?: string): RunGraph {
  const kind = type ?? detect(src);
  if (kind === "speckit") return compileSpecKit(src);
  if (kind === "gsd") return compileGsd(src, root);
  if (kind === "native") return compileNative(src);
  if (kind === "prd") return compilePrd(src);
  throw new CompileError(
    `cannot detect spec type for ${src} — pass a Spec Kit feature dir (with tasks.md), a GSD phase dir (with *-PLAN.md), or a marked native/generic PRD .md file, or use --type speckit|prd|gsd|native`,
  );
}
