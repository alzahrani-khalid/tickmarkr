import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, test, expect } from "vitest";

const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const RELEASING_MD = join(ROOT, "RELEASING.md");
const CHANGELOG_MD = join(ROOT, "CHANGELOG.md");
const TESTING_MD = join(ROOT, "docs/codebase/TESTING.md");
const PACKAGE_JSON = join(ROOT, "package.json");

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

function getCurrentVersion(): string {
  const pkg = JSON.parse(readFile(PACKAGE_JSON));
  return pkg.version;
}

function countTestFilesInDir(dir: string): number {
  const fullPath = join(ROOT, dir);
  if (!existsSync(fullPath)) return 0;
  return readdirSync(fullPath, { recursive: false })
    .filter((f) => typeof f === "string" && f.endsWith(".test.ts")).length;
}

describe("release documentation", () => {
  describe("RELEASING.md", () => {
    test("the releasing documentation describes committing each export on top of a persistent clone of the public repository instead of a recurring force push", () => {
      const content = readFile(RELEASING_MD);
      expect(content).toContain("append-only");
      expect(content).toContain("persistent clone");
      expect(content).toContain("Do not force-push");
      expect(content).toMatch(
        /commit.*on top.*main.*normal fast-forward.*never force-push/is
      );
    });

    test("the releasing documentation states the public history is append only with one commit per release", () => {
      const content = readFile(RELEASING_MD);
      expect(content).toContain("append-only");
      expect(content).toContain("one commit per release");
      expect(content).toMatch(/append-only.*history.*one commit per release/is);
    });

    test("the releasing documentation accurately describes the export script generating a public ignore file", () => {
      const content = readFile(RELEASING_MD);
      expect(content).toContain(".gitignore");
      expect(content).toContain("Generates a `.gitignore`");
      expect(content).toContain("node_modules/");
      expect(content).toContain("dist/");
      expect(content).toContain("coverage/");
      expect(content).toContain(".tickmarkr/");
    });

    test("the releasing documentation accurately describes which documentation pages the export now ships", () => {
      const content = readFile(RELEASING_MD);
      expect(content).toContain("Public documentation included");
      const expectedPages = [
        "ARCHITECTURE.md",
        "CLI-DESIGN.md",
        "CONVENTIONS.md",
        "INTEGRATIONS.md",
        "STACK.md",
        "STRUCTURE.md",
        "TESTING.md",
      ];
      for (const page of expectedPages) {
        expect(content).toContain(page);
      }
      expect(content).toContain("Private documentation pages");
      expect(content).toContain("CONCERNS.md");
    });
  });

  describe("CHANGELOG.md", () => {
    test("the changelog contains a curated summary of every release from the last documented entry through the current package version", () => {
      const content = readFile(CHANGELOG_MD);
      // Extract major.minor from the full version (e.g., "1.58" from "1.58.0")
      const currentVersion = getCurrentVersion();
      const majorMinor = currentVersion.split(".").slice(0, 2).join(".");
      expect(content).toContain(`v${majorMinor}`);
      // Should have entry for v1.38 (the previous documented entry) and v1.58+
      expect(content).toContain("v1.38");
      expect(content).toContain("v1.58");
      expect(content).toMatch(/v1\.\d+.*breaking changes/is);
    });

    test("the changelog points readers to github releases for per release detail", () => {
      const content = readFile(CHANGELOG_MD);
      expect(content).toContain("GitHub Releases");
      expect(content).toContain("github.com/alzahrani-khalid/tickmarkr/releases");
    });

    test("the changelog breaking change entries remain true against the current source tree", () => {
      const content = readFile(CHANGELOG_MD);
      // v1.38 breaking changes: state directory, global config, native spec marker, resume
      expect(content).toMatch(/\.tickmarkr/);
      expect(content).toMatch(/XDG_CONFIG_HOME/);
      expect(content).toMatch(/tickmarkr:spec/);
      // Verify breaking changes are documented in detail
      expect(content).toContain("State directory");
      expect(content).toContain("Global config");
      expect(content).toContain("Native spec marker");
      expect(content).toContain("Resume");
    });
  });

  describe("TESTING.md test file count accuracy", () => {
    test("the testing page's stated repository test file count for its directory listing matches the actual number of test files present in that directory", () => {
      const content = readFile(TESTING_MD);
      const actualCount = countTestFilesInDir("tests/repo");

      // Extract the stated count from TESTING.md for the repo/ directory
      // Pattern: "├── repo/           N *.test.ts files"
      const match = content.match(/├──\s+repo\/\s+(\d+)\s+\*\.test\.ts\s+files/);
      expect(match, "repo test file count not found in TESTING.md").toBeTruthy();

      const statedCount = parseInt(match![1], 10);
      expect(statedCount).toBe(
        actualCount,
        `TESTING.md states ${statedCount} files but found ${actualCount} in tests/repo/`
      );
    });
  });
});
