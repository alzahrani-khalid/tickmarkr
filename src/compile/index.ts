import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunGraph } from "../graph/schema.js";
import { taskUnitContractErrors } from "./collateral.js";
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

// OBS-212/214: the Task Unit Contract is enforced for EVERY front-end here, at the one seam they all
// pass through, so no spec dialect can author a graph whose independence claim is false or whose
// tasks are too large to converge. A violation is a compile error, never a warning — the failures it
// prevents (silently dropped commits, a 28-dispatch task) are invisible until they have already cost
// hours, which is exactly the class of thing that has to fail at authoring time.
function enforceTaskUnitContract(g: RunGraph, src: string): RunGraph {
  const errors = taskUnitContractErrors(g.tasks);
  if (errors.length > 0) {
    throw new CompileError(
      `${src} violates the task unit contract (${errors.length} error${errors.length > 1 ? "s" : ""}):\n`
      + errors.map((e) => `  - ${e}`).join("\n"),
    );
  }
  return g;
}

export function compileSource(src: string, type?: SourceType, root?: string): RunGraph {
  const kind = type ?? detect(src);
  if (kind === "speckit") return enforceTaskUnitContract(compileSpecKit(src), src);
  if (kind === "gsd") return enforceTaskUnitContract(compileGsd(src, root), src);
  if (kind === "native") return enforceTaskUnitContract(compileNative(src), src);
  if (kind === "prd") return enforceTaskUnitContract(compilePrd(src), src);
  throw new CompileError(
    `cannot detect spec type for ${src} — pass a Spec Kit feature dir (with tasks.md), a GSD phase dir (with *-PLAN.md), or a marked native/generic PRD .md file, or use --type speckit|prd|gsd|native`,
  );
}
