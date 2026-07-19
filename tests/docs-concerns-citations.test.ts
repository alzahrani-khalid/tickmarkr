import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// OBS-73 → T3: the public export ships docs/codebase WITHOUT the private CONCERNS.md, so the
// guard keys off the concerns page itself, not the directory — skip (never throw) whenever the
// page is absent from the tree
const DOCS_DIR = join(import.meta.dirname, "..", "docs", "codebase");
const CONCERNS_PAGE = join(DOCS_DIR, "CONCERNS.md");
const skipIfNoConcerns = (page = CONCERNS_PAGE) => {
  try {
    return !statSync(page).isFile();
  } catch {
    return true;
  }
};

// the exported-tree shape: the docs tree is present, the concerns page deliberately is not —
// the guarded suite below must skip cleanly instead of throwing on the missing read
test("the concerns citation test does not throw when the concerns page is absent from the tree", () => {
  const docsTree = mkdtempSync(join(tmpdir(), "tickmarkr-docs-no-concerns-"));
  try {
    writeFileSync(join(docsTree, "STRUCTURE.md"), "# a shipped page\n");
    let skip: boolean | undefined;
    expect(() => {
      skip = skipIfNoConcerns(join(docsTree, "CONCERNS.md"));
    }).not.toThrow();
    expect(skip).toBe(true);
  } finally {
    rmSync(docsTree, { recursive: true, force: true });
  }
});

describe("concerns-citations", { skip: skipIfNoConcerns() }, () => {
  const concerns = () => readFileSync(join(DOCS_DIR, "CONCERNS.md"), "utf8");
  const filePattern = /\b(?:src|tests)\/[a-zA-Z0-9/_.-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml)\b/g;

  test("test: every concerns entry cites source files that exist in the tree", () => {
    const content = concerns();
    const entries = content.split(/\n\s*\n/).filter((block) => block.startsWith("**") && !block.startsWith("**Analysis Date"));
    const repoRoot = join(import.meta.dirname, "..");
    expect(entries.length).toBeGreaterThan(0);
    const files = [...new Set(entries.flatMap((entry) => [...entry.matchAll(filePattern)].map((match) => match[0])))];
    expect(files.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.match(filePattern)).not.toBeNull();
    for (const file of files) expect(statSync(join(repoRoot, file)).isFile()).toBe(true);
  });

  test("test: the concerns doc carries no stopgap staleness banner", () => {
    expect(concerns()).not.toMatch(/^> \*\*STOPGAP:/m);
  });

  test("test: the concerns doc analysis date is 2026-07-18", () => {
    expect(concerns()).toContain("**Analysis Date:** 2026-07-18");
  });

  test("test: the concerns doc records the source scope lint advisory ruling", () => {
    expect(concerns()).toMatch(/Source scope lint is advisory only/);
    expect(concerns()).toMatch(/advisory warning in `tickmarkr plan` output only/);
    expect(concerns()).toMatch(/will not promote to compile failure/);
  });

  test("no concern entry describes a defect the current source already fixes", () => {
    const content = concerns();
    for (const staleHeading of [
      "Run-end reporting omits tasks starved behind human parks",
      "TickmarkrConfig has no runtime schema validation",
      "Dead config: `consult.stallMinutes` is never read",
      "`DIFF_CAP` magic number",
      "Shell interpolation without escaping",
      "SubprocessDriver output buffer grows unbounded",
      "`pickReviewer`'s vendor fallback can silently no-op",
      "No file locking around `.tickmarkr/graph.json`",
      "No real spend/cost metering, only pre-run estimates",
      "Coverage thresholds are scoped to 4 of 9",
    ]) expect(content).not.toContain(staleHeading);
  });

  test("every operator accepted residual entry survives with its accepted marking", () => {
    const content = concerns();
    for (const title of [
      'Compile-time "done" detection trusts the filesystem',
      "List-coercion helpers duplicated per compile front-end",
      "Wrap-join eats spaces at TUI hard-wrap points",
      "`pickReviewer` rejects an author absent from channel discovery",
      "Blocked-pane paging depends on herdr's screen-scraped agent status",
    ]) {
      const heading = content.split("\n").find((line) => line.startsWith("**") && line.includes(title));
      expect(heading).toContain("[accepted");
    }
  });

  test("the source scope lint entry keeps the advisory verdict grounded in the v154 plan false flag evidence", () => {
    const content = concerns();
    expect(content).toContain(".planning/missions/v154-plan-output.txt:40");
    expect(content).toContain("T5");
    expect(content).toContain("src/compile/collateral.ts");
    expect(content).toContain("src/run/daemon.ts");
    expect(content).toContain("src/run/git.ts");
    expect(content).toMatch(/false positives/);
    expect(content).toMatch(/Ruling: keep advisory, never promote to compile gate failure/);
  });

  test("the concerns citations test skips when the docs tree is absent", () => {
    expect(skipIfNoConcerns(join(DOCS_DIR, "__absent__", "CONCERNS.md"))).toBe(true);
  });
});
