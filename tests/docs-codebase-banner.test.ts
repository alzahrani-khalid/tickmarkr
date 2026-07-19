import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const codebaseDocs = join(repoRoot, "docs", "codebase");
const EXPORT_SCRIPT = join(repoRoot, "scripts", "export-public.sh");

// docs/codebase ships in the public export minus CONCERNS.md (T3) — runs in both trees (OBS-65)
describe.skipIf(!existsSync(codebaseDocs))("codebase-doc stopgap", () => {
  test("every codebase documentation page carries no stopgap banner", () => {
    const docFiles = readdirSync(codebaseDocs).filter((f) => f.endsWith(".md"));
    expect(docFiles.length).toBeGreaterThan(0);
    for (const file of docFiles) {
      const content = readFileSync(join(codebaseDocs, file), "utf8");
      expect(content).not.toMatch(/^> \*\*STOPGAP:/m, `${file} should not carry stopgap banner`);
    }
  });
});

// ---- T3 export docs allowlist -----------------------------------------------------------------
// Dual-context like the manifest test, no skip in either direction: private tree (export script
// present) → generate the candidate from a pristine clone and inspect its docs tree; exported
// tree (script deliberately absent) → inspect the checkout's own docs tree directly.
const PUBLIC_DOC_PAGES = [
  "ARCHITECTURE.md",
  "CLI-DESIGN.md",
  "CONVENTIONS.md",
  "INTEGRATIONS.md",
  "STACK.md",
  "STRUCTURE.md",
  "TESTING.md",
];

function exportFromCleanClone(): { root: string; cleanup: () => void } {
  const cloneDir = mkdtempSync(join(tmpdir(), "tickmarkr-docs-allowlist-"));
  let exportDir: string | undefined;
  try {
    execSync(`git clone --local --quiet "${repoRoot}" "${cloneDir}"`, { stdio: "pipe" });
    const out = execSync("bash scripts/export-public.sh", { cwd: cloneDir, encoding: "utf8" });
    exportDir = /^export path: (.+)$/m.exec(out)?.[1].trim();
    if (!exportDir) throw new Error(`export path not found in:\n${out}`);
    const dir = exportDir;
    return {
      root: dir,
      cleanup: () => {
        rmSync(dir, { recursive: true, force: true });
        rmSync(cloneDir, { recursive: true, force: true });
      },
    };
  } catch (e) {
    if (exportDir) rmSync(exportDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
    throw e;
  }
}

function listFilesUnder(root: string, rel: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFilesUnder(root, path));
    else files.push(path);
  }
  return files;
}

describe("export docs allowlist", () => {
  test(
    "the exported docs directory contains only the codebase documentation pages and excludes the concerns page",
    { timeout: 180_000 },
    () => {
      const candidate = existsSync(EXPORT_SCRIPT) ? exportFromCleanClone() : { root: repoRoot, cleanup: () => {} };
      try {
        const shipped = listFilesUnder(candidate.root, "docs").sort();
        expect(shipped).toEqual(PUBLIC_DOC_PAGES.map((page) => `docs/codebase/${page}`).sort());
        expect(shipped).not.toContain("docs/codebase/CONCERNS.md");
      } finally {
        candidate.cleanup();
      }
    },
  );

  // reads the exporter itself, so it has no subject in the exported tree (script never ships)
  test(
    "the export leak scan still runs against the complete exported tree with no docs directory exclusion added to it",
    { skip: !existsSync(EXPORT_SCRIPT) },
    () => {
      const script = readFileSync(EXPORT_SCRIPT, "utf8");
      // both sweeps grep the full "$EXPORT_DIR" tree, shipped docs pages included
      // (retired-brand needle assembled from pieces — this file ships and must not trip the scan itself)
      const retired = ["dro", "vr|", "dro", "ver"].join("");
      expect(script).toContain(`grep -riE '${retired}' "$EXPORT_DIR"`);
      expect(script).toContain('grep -rciE "$pat" "$EXPORT_DIR"');
      // the only permitted dir exclusions are the intentional legacy-corpus carve-outs — never docs
      const excludeDirs = [...script.matchAll(/--exclude-dir=(\S+)/g)].map((m) => m[1]);
      expect(excludeDirs.length).toBeGreaterThan(0);
      for (const dir of excludeDirs) expect(["fixtures", ".planning"], `--exclude-dir=${dir}`).toContain(dir);
    },
  );
});

// ---- T3 structure-page truth -------------------------------------------------------------------
// The narrowed export ships STRUCTURE.md; every directory it lists as an entry must be one the
// export (or a fresh checkout) can actually contain. An entry is the path token a tree-diagram
// branch names or a **`dir/`:** prose heading — feature descriptions in trailing comments (the GSD
// front-end reads a *user's* .planning/ tree) are not entries.
describe.skipIf(!existsSync(codebaseDocs))("structure-page truth", () => {
  const structure = () => readFileSync(join(codebaseDocs, "STRUCTURE.md"), "utf8");
  const treeEntries = (content: string): string[] =>
    [...content.matchAll(/^[│ ]*(?:├──|└──) +(\S+)/gm)].map((m) => m[1]);
  const proseEntries = (content: string): string[] =>
    [...content.matchAll(/\*\*`([^`]+)`\*\*:/g)].map((m) => m[1]);
  const allEntries = (content: string): string[] => [...treeEntries(content), ...proseEntries(content)];

  test("the structure page's tree diagram and prose contain no entry for the private planning directory", () => {
    const content = structure();
    const entries = allEntries(content);
    expect(entries.length).toBeGreaterThan(20); // parser sanity — a regex drift must not pass vacuously
    for (const entry of entries) expect(entry, `entry ${entry}`).not.toMatch(/\.planning/);
    expect(content).not.toMatch(/^[│ ]*(?:├──|└──) +\.planning/m);
    expect(content).not.toMatch(/GSD planning tree/);
  });

  test("the structure page's tree diagram and prose contain no entry for the superpowers design record directory", () => {
    const content = structure();
    for (const entry of allEntries(content)) expect(entry, `entry ${entry}`).not.toMatch(/superpowers/i);
    // the design record stays out of the shipped page entirely — comments and prose included
    expect(content).not.toMatch(/superpowers/i);
  });
});
