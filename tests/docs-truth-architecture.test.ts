import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseWorkerResult } from "../src/adapters/prompt.js";
import { GATE_NAMES, validateGraph } from "../src/graph/schema.js";
import { readOperatorState } from "../src/run/operator-state.js";
import { ev, graph, partial } from "./fixtures/operator-state/fixture.js";

const repoRoot = join(import.meta.dirname, "..");
const codebaseDocs = join(repoRoot, "docs", "codebase");

const srcFilePattern = /\bsrc\/[a-zA-Z0-9/_-]+\.tsx?\b/g;

/** Parse directory paths from the STRUCTURE.md ascii tree block. */
function parseStructureTreeDirs(content: string): string[] {
  const treeMatch = content.match(/```\ntickmarkr\/\n([\s\S]*?)```/);
  if (!treeMatch) return [];
  const dirs: string[] = [];
  const stack = ["tickmarkr"];

  for (const line of treeMatch[1].split("\n")) {
    const branch = line.match(/^((?:│   )*)(?:├──|└──)\s+((?:[\w.-]+\/)+)(?:\s|#|$)/);
    if (!branch) continue;
    const depth = branch[1].length / 4;
    const relPath = branch[2].replace(/\/$/, "");
    stack.length = depth + 1;
    for (const part of relPath.split("/")) stack.push(part);
    dirs.push(stack.join("/"));
  }
  return dirs;
}

/** Parse **`path/`:** headings from STRUCTURE.md prose sections. */
function parseStructureProseDirs(content: string): string[] {
  return [...content.matchAll(/\*\*`([^`]+)`\*\*:/g)]
    .map((m) => m[1].replace(/\/$/, ""))
    .filter((d) => !d.includes(" and "));
}

function toRepoPath(named: string): string {
  return named.replace(/^tickmarkr\//, "");
}

describe.skipIf(!existsSync(codebaseDocs))("docs-truth: architecture and structure", () => {
  const architecturePath = join(codebaseDocs, "ARCHITECTURE.md");
  const structurePath = join(codebaseDocs, "STRUCTURE.md");

  test("every source file cited on the architecture and structure pages exists in the tree", () => {
    const archContent = readFileSync(architecturePath, "utf8");
    const structContent = readFileSync(structurePath, "utf8");
    const allCitedFiles = new Set([
      ...(archContent.match(srcFilePattern) ?? []),
      ...(structContent.match(srcFilePattern) ?? []),
    ]);

    const missing: string[] = [];
    for (const file of allCitedFiles) {
      if (!existsSync(join(repoRoot, file))) missing.push(file);
    }
    expect(missing).toEqual([], `These files are cited but don't exist: ${missing.join(", ")}`);
  });

  test("no codebase documentation page carries the stopgap banner", () => {
    const docFiles = readdirSync(codebaseDocs).filter((f) => f.endsWith(".md"));
    for (const file of docFiles) {
      const content = readFileSync(join(codebaseDocs, file), "utf8");
      expect(content).not.toMatch(/^> \*\*STOPGAP:/m, `${file} should not carry stopgap banner`);
    }
  });

  test("the architecture page does not contradict the source tree module boundaries", () => {
    const arch = readFileSync(architecturePath, "utf8");
    const srcRoot = join(repoRoot, "src");
    const topLevel = readdirSync(srcRoot)
      .filter((n) => statSync(join(srcRoot, n)).isDirectory())
      .sort();

    // Every top-level src module must be documented in the Layers section.
    for (const dir of topLevel) {
      expect(arch, `missing Layers coverage for src/${dir}/`).toMatch(new RegExp(`src/${dir}/`));
    }

    // Compile layer: native is primary; collateral is advisory-only.
    expect(arch).toContain("src/compile/native.ts");
    expect(arch).toContain("src/compile/collateral.ts");
    expect(arch).toMatch(/native.*primary|primary.*native/i);

    // Route is a multi-file module, not router.ts alone.
    for (const f of ["router.ts", "profile.ts", "preference.ts", "candidates.ts"]) {
      expect(arch).toContain(`src/route/${f}`);
    }
    expect(arch).not.toMatch(/\*\*Route \(`src\/route\/router\.ts`\):\*\*/);

    // Run module includes lock, reconcile, stall beyond the original five files.
    for (const f of ["lock.ts", "reconcile.ts", "stall.ts"]) {
      expect(arch).toContain(`src/run/${f}`);
    }

    // Side modules plan/ and report/ belong in the dependency map.
    expect(arch).toMatch(/src\/plan\//);
    expect(arch).toMatch(/src\/report\//);
    expect(arch).toMatch(/cli → run\/compile\/plan\/report\/route/);

    // Disproven stale routing claim from the prior refresh.
    expect(arch).not.toMatch(/not a learned or dynamic system in the current version/);
    expect(arch).toContain("src/route/profile.ts");
  });

  test("the structure page names only directories that exist in the tree", () => {
    const struct = readFileSync(structurePath, "utf8");
    const named = [
      ...new Set([
        ...parseStructureTreeDirs(struct),
        ...parseStructureProseDirs(struct),
      ]),
    ];

    const missing: string[] = [];
    for (const dir of named) {
      const repoPath = toRepoPath(dir);
      if (!existsSync(join(repoRoot, repoPath))) missing.push(repoPath);
    }

    expect(missing).toEqual([], `These directories named in structure don't exist: ${missing.join(", ")}`);

    // Every current src/ subdirectory must appear in the tree diagram.
    const srcRoot = join(repoRoot, "src");
    const srcDirs = readdirSync(srcRoot).filter((n) => statSync(join(srcRoot, n)).isDirectory());
    for (const dir of srcDirs) {
      expect(struct, `structure tree missing src/${dir}/`).toContain(`src/${dir}/`);
    }

    // Retired paths from the prior failed refresh must not reappear.
    expect(struct).not.toContain(".superpowers/sdd/");
    expect(struct).not.toMatch(/\.planning\/codebase\/.*this document's home/);
  });
});

test("Changed Architecture names the actual current Ink/frame/store/print paths and explains mandatory build/test/lint/evidence/scope followed by concurrent optional acceptance/review, while canonical skill links preserve one source. Review resolves those named paths and replays a missing-result versus passed-gate case against the prose. A nonexistent tkr-help path, obsolete engine claim or declared/not-run gate described as passed fails.", () => {
  const architecture = readFileSync(join(codebaseDocs, "ARCHITECTURE.md"), "utf8");
  const prose = architecture.replace(/\s+/g, " ");
  const paths = [
    "src/cli/commands/ui.ts", "src/tui/cockpit/live.ts", "src/tui/cockpit/live-runtime.tsx",
    "src/tui/cockpit/shell.tsx", "src/tui/cockpit/layout.ts", "src/tui/cockpit/width.ts",
    "src/tui/cockpit/home-view.tsx", "src/tui/cockpit/run-view.tsx", "src/tui/cockpit/evidence-view.tsx",
    "src/tui/cockpit/live-store.ts", "src/run/operator-state.ts", "src/tui/cockpit/derive.ts",
    "src/tui/ink/fleet-app.tsx", "src/tui/ink/init-app.tsx", "src/tui/ink/frame.tsx",
    "src/cli/commands/status.ts", "src/cli/commands/report.ts", "src/cli/commands/stats.ts",
    "src/cli/help.ts", "src/gates/run-gates.ts", "src/graph/schema.ts",
  ];
  for (const file of paths) {
    expect(architecture, file).toContain(file);
    expect(statSync(join(repoRoot, file)).isFile(), file).toBe(true);
  }
  // Resolve ALL fully qualified source citations, including .tsx (the old regex truncated those).
  for (const file of new Set(architecture.match(srcFilePattern))) expect(existsSync(join(repoRoot, file)), file).toBe(true);
  for (const phrase of ["Ink 6 / React 19", "first five are mandatory", "acceptance and review start concurrently",
    "each completion is journaled when it arrives", "full suite runs on the same merge-candidate commit",
    "A declared gate is not a passed gate", "**not-run**, not pass", "**unknown**",
    "Missing or unparseable worker/judge/review results fail closed", "Fleet/Bootstrap and Plan/Health remain follow-ons",
    "do not transitively import Ink"]) expect(prose).toContain(phrase);
  expect(architecture).not.toMatch(/dependency-free.*(?:engine|presentation)|src\/tui\/ink\/studio-app|skills\/tkr-help/);

  // The graph enforces exactly the distinction the prose calls mandatory versus optional.
  expect(GATE_NAMES).toEqual(["build", "test", "lint", "evidence", "scope", "acceptance", "review"]);
  for (const missing of GATE_NAMES.slice(0, 5)) {
    expect(() => validateGraph({ ...graph, tasks: [{ ...graph.tasks[0], gates: GATE_NAMES.filter(g => g !== missing) }] }), missing).toThrow();
  }
  expect(validateGraph({ ...graph, tasks: [{ ...graph.tasks[0], gates: GATE_NAMES.slice(0, 5) }] }).tasks[0]!.gates)
    .toEqual(GATE_NAMES.slice(0, 5));

  // One current attempt, five discriminating gate histories: declaration never manufactures pass.
  const start = [partial[0]!, ev("task-dispatch", { attempt: 0 }, "T1")];
  const read = (events = start) => readOperatorState({ graph, events });
  expect(read().tasks[0]!.gates.build).toEqual({ state: "not-run" });
  expect(read().gatesRan).toEqual({ passed: 0, total: 0 });
  const running = [...start, ev("gate-start", { gate: "build" }, "T1")];
  expect(read(running).tasks[0]!.gates.build.state).toBe("running");
  expect(read([...running, ev("gate-result", { gate: "build", details: "zero findings" }, "T1")]).tasks[0]!.gates.build.state).toBe("unknown");
  const passed = [...running, ev("gate-result", { gate: "build", pass: true, details: "exit 0" }, "T1")];
  expect(read(passed).tasks[0]!.gates.build.state).toBe("passed");
  expect(read(passed).gatesRan).toEqual({ passed: 1, total: 1 });
  const retry = [...passed, ev("task-dispatch", { attempt: 1 }, "T1")];
  expect(read(retry).tasks[0]!.gates.build.state).toBe("not-run");
  const optional = [...start,
    ev("gate-result", { gate: "review", pass: true, skipped: true }, "T1"),
    ev("gate-result", { gate: "acceptance", disabled: true }, "T1")];
  expect(read(optional).tasks[0]!.gates).toMatchObject({ review: { state: "not-run" }, acceptance: { state: "disabled" } });
  expect(read(optional).gatesRan).toEqual({ passed: 0, total: 0 });
  expect(parseWorkerResult("zero findings; everything passed", "docs").ok).toBe(false);
  expect(parseWorkerResult('TICKMARKR_RESULT_docs {broken}', "docs").ok).toBe(false);
  expect(parseWorkerResult('TICKMARKR_RESULT_docs {"ok":true,"summary":"recorded","deviations":[]}', "docs").ok).toBe(true);

  // Stable canonical identity and resolvable relative walkthrough links, in private and export trees.
  for (const name of ["tickmarkr-loop", "tickmarkr-auto", "tickmarkr-overseer"]) {
    const canonical = join(repoRoot, "skills", name, "SKILL.md");
    const content = readFileSync(canonical, "utf8");
    expect(content).toContain(`name: ${name}`);
    if (name !== "tickmarkr-loop") {
      const link = /\]\((\.\.\/tickmarkr-loop\/SKILL\.md)#([^)]*)\)/.exec(content);
      expect(link).not.toBeNull();
      const target = resolve(dirname(canonical), link![1]!);
      expect(realpathSync(target)).toBe(realpathSync(join(repoRoot, "skills/tickmarkr-loop/SKILL.md")));
      expect(link![2]).toBe("cockpit-parked-decisions-and-printed-twins");
      expect(readFileSync(target, "utf8")).toContain("## Cockpit, parked decisions and printed twins");
    }
    const installed = join(repoRoot, ".claude/skills", name, "SKILL.md");
    // Skip installed-link checks on the exported tree, where .claude/skills is absent.
    if (existsSync(installed)) {
      expect(lstatSync(installed).isSymbolicLink()).toBe(true);
      expect(realpathSync(installed)).toBe(realpathSync(canonical));
      expect(readFileSync(installed)).toEqual(readFileSync(canonical));
    }
  }
});
