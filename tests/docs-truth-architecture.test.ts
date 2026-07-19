import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const codebaseDocs = join(repoRoot, "docs", "codebase");

const srcFilePattern = /\bsrc\/[a-zA-Z0-9/_-]+\.ts\b/g;

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
