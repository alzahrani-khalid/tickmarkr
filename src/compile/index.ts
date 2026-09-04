import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { type RunGraph, type SpecSource, validateGraph } from "../graph/schema.js";
import { taskUnitContractErrors } from "./collateral.js";
import { blocksCompile, ownershipFindings, renderOwnershipFinding } from "./ownership.js";
import { CompileError } from "./common.js";
import { compileGsd, isGsdPhaseDir } from "./gsd.js";
import { compileNative, TICKMARKR_NATIVE_MARKER } from "./native.js";
import { compilePrd } from "./prd.js";
import { compileSpecKit } from "./speckit.js";

type SourceType = SpecSource;

// Dialects stop at translation. Every downstream compile-time consumer receives this one flat
// shape, and finalizePlan is the only seam that turns it back into the durable RunGraph.
export type PlanIR = {
  version: RunGraph["version"];
  source: RunGraph["spec"]["source"];
  paths: RunGraph["spec"]["paths"];
  hash: RunGraph["spec"]["hash"];
  base?: RunGraph["spec"]["base"];
  mode?: RunGraph["mode"];
  tasks: RunGraph["tasks"];
};

export type PlanFinalizationHook = (plan: PlanIR) => PlanIR;

export type CompileOptions = { strict?: boolean };

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
function repoOverlayMode(repoRoot?: string): string | undefined {
  if (!repoRoot) return undefined;
  try {
    const cfg = parse(readFileSync(join(repoRoot, ".tickmarkr", "config.yaml"), "utf8")) as { routing?: { mode?: unknown } } | null;
    return typeof cfg?.routing?.mode === "string" ? cfg.routing.mode : undefined;
  } catch {
    return undefined;
  }
}

function hasModeOverride(src: string): boolean {
  try {
    for (const line of readFileSync(src, "utf8").split("\n")) {
      if (/^##\s+T\d+:/i.test(line)) return false;
      if (/^mode-override:\s*true\s*(?:#.*)?$/.test(line)) return true;
    }
  } catch { /* unreadable specs fail elsewhere */ }
  return false;
}

function enforceModeOverlay(graph: RunGraph, src: string, repoRoot?: string): void {
  if (graph.spec.source !== "native" || graph.mode === undefined) return;
  const overlayMode = repoOverlayMode(repoRoot);
  if (overlayMode === undefined || overlayMode === graph.mode || hasModeOverride(src)) return;
  throw new CompileError(
    `${src} front-matter mode ${graph.mode} disagrees with repository routing.mode ${overlayMode}; `
    + `write mode-override: true beside the mode line to make the override explicit.`,
  );
}

function enforceTaskUnitContract(g: RunGraph, src: string, repoRoot?: string): RunGraph {
  const errors = taskUnitContractErrors(g.tasks, repoRoot);
  if (errors.length > 0) {
    throw new CompileError(
      `${src} violates the task unit contract (${errors.length} error${errors.length > 1 ? "s" : ""}):\n`
      + errors.map((e) => `  - ${e}`).join("\n"),
    );
  }
  return g;
}

export function finalizePlan(plan: PlanIR, src: string, repoRoot?: string): RunGraph {
  const graph = enforceTaskUnitContract(validateGraph({
    version: plan.version,
    ...(plan.mode !== undefined ? { mode: plan.mode } : {}),
    spec: {
      source: plan.source,
      paths: plan.paths,
      hash: plan.hash,
      ...(plan.base !== undefined ? { base: plan.base } : {}),
    },
    tasks: plan.tasks,
  }), src, repoRoot);
  enforceModeOverlay(graph, src, repoRoot);
  // overseer-217 removal condition, now paid: on this milestone's authored graph the conventional
  // name map emitted 21 raw unowned-test findings; review found 1 real and 20 false, while intersecting
  // with a direct import or command-entry spawn retained the real one and left 0 false positives. That
  // is a precision measurement, NOT a recall claim. The prior halted semantic-contract class has no
  // name/import/ownership relation (one of its three members has no matching literal anywhere), so this
  // rule could not have caught it and does not claim to. The promoted rule already earned a true positive
  // during authoring: assigning the plan command to oracle-preflight left two dedicated plan tests unowned.
  if (repoRoot) {
    const findings = ownershipFindings(graph.tasks, repoRoot);
    const blocking = findings.filter(blocksCompile);
    for (const finding of findings.filter((item) => !blocksCompile(item))) {
      console.warn(renderOwnershipFinding(finding));
    }
    if (blocking.length > 0) {
      throw new CompileError(
        `${src} violates cross-task test ownership (${blocking.length} error${blocking.length === 1 ? "" : "s"}):\n`
          + blocking.map((finding) => `  - ${renderOwnershipFinding(finding)}`).join("\n"),
      );
    }
  }
  return graph;
}

function compilePlan(src: string, type?: SourceType, root?: string, options: CompileOptions = {}): PlanIR {
  const kind = type ?? detect(src);
  const graph = kind === "speckit" ? compileSpecKit(src)
    : kind === "gsd" ? compileGsd(src, root)
    : kind === "native" ? compileNative(src, { strict: options.strict })
    : kind === "prd" ? compilePrd(src)
    : null;
  if (!graph) {
    throw new CompileError(
      `cannot detect spec type for ${src} — pass a Spec Kit feature dir (with tasks.md), a GSD phase dir (with *-PLAN.md), or a marked native/generic PRD .md file, or use --type speckit|prd|gsd|native`,
    );
  }
  return {
    version: graph.version,
    source: graph.spec.source,
    paths: graph.spec.paths,
    hash: graph.spec.hash,
    ...(graph.spec.base !== undefined ? { base: graph.spec.base } : {}),
    ...(graph.mode !== undefined ? { mode: graph.mode } : {}),
    tasks: graph.tasks,
  };
}

export function compileSource(
  src: string,
  type?: SourceType,
  root?: string,
  beforeFinalize: PlanFinalizationHook = (plan) => plan,
  options: CompileOptions = {},
): RunGraph {
  return finalizePlan(beforeFinalize(compilePlan(src, type, root, options)), src, root);
}
