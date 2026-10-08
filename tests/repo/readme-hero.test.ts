import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import * as brandModule from "../../src/brand.js";
import { BANNER, PLAIN_BANNER } from "../../src/brand.js";
import { makeRepo } from "../helpers/tmprepo.js";

const REPO = join(import.meta.dirname, "../..");
const README = join(REPO, "README.md");
const BRAND = join(REPO, "src/brand.ts");
const PLAIN_MARK = (brandModule as { readonly PLAIN_MARK?: string }).PLAIN_MARK;

/** First fenced ``` block in README (the hero). */
function readmeHeroBlock(md: string): string {
  const open = md.indexOf("```\n");
  if (open < 0) throw new Error("README hero fence missing");
  const start = open + 4;
  const close = md.indexOf("\n```", start);
  if (close < 0) throw new Error("README hero fence unclosed");
  return md.slice(start, close + 1);
}

// The scan guards against the logo being DUPLICATED as a second source of truth. Captured evidence
// that merely contains a rendered banner is not duplication: `.overseer/` holds run journals and
// `tests/fixtures/` holds verbatim pane captures, both of which record whatever the terminal showed
// — and a capture must never be hand-edited to satisfy a scan (docs/codebase/TESTING.md). Same
// reasoning as the pre-existing `.planning` exemption.
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".tickmarkr", ".planning", ".overseer", "fixtures"]);

// Only what git carries — tracked, or untracked and not ignored (D-1522 add.1): a git-ignored cache such as
// graft/'s session store can hold a copy of the art without being a home for it.
function listFiles(dir: string): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: dir, encoding: "utf8" })
    .split("\0")
    .filter((path) => path && !path.split("/").some((segment) => SKIP_DIRS.has(segment)))
    .map((path) => join(dir, path))
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isFile());
}

function markHomes(planted: Readonly<Record<string, string>> = {}): string[] {
  const permittedHomes = [BRAND, README].map((path) => relative(REPO, path));
  const needle = PLAIN_MARK!.split("\n").toSorted((left, right) =>
    right.replaceAll(" ", "").length - left.replaceAll(" ", "").length
  )[0]!.trimEnd();
  const candidates = [
    ...listFiles(REPO).map((path) => [relative(REPO, path), readFileSync(path, "utf8")] as const),
    ...Object.entries(planted),
  ];
  const unexpected = candidates.flatMap(([path, text]) =>
    !permittedHomes.includes(path) && text.includes(needle) ? [path] : []
  );
  return [...permittedHomes, ...unexpected].sort();
}

function assertPermittedMarkHomes(planted: Readonly<Record<string, string>> = {}): void {
  expect(markHomes(planted), "mark art duplicated outside brand.ts/README.md").toEqual([
    "README.md",
    "src/brand.ts",
  ]);
}

describe("T4 README hero is the ASCII-identical logo", () => {
  test("README's hero code block equals PLAIN_BANNER exactly (the drift pin)", () => {
    const readme = readFileSync(README, "utf8");
    expect(readmeHeroBlock(readme)).toBe(PLAIN_BANNER);
  });

  test("PLAIN_BANNER is the ANSI-stripped twin of BANNER (derived, not duplicated)", () => {
    const stripped = BANNER.replace(/\x1b\[[0-9;]*m/g, "").replace(/[ \t]+$/gm, "");
    expect(PLAIN_BANNER).toBe(stripped);
    const brandSrc = readFileSync(BRAND, "utf8");
    expect(brandSrc).toMatch(/export const PLAIN_BANNER = BANNER\.replace/);
  });

  test("README does not reference wordmark-dark.png", () => {
    expect(() => {
      execSync('! grep -q "wordmark-dark.png" README.md', { cwd: REPO, stdio: "pipe" });
    }).not.toThrow();
  });

  test("test: the duplication scan still reports exactly the two permitted homes for the mark, and it fails when the art is planted in a third file", () => {
    expect(PLAIN_MARK).toBeTypeOf("string");
    assertPermittedMarkHomes();
    expect(() => assertPermittedMarkHomes({ "planted-third-file.txt": PLAIN_MARK! })).toThrowError(
      /mark art duplicated outside brand\.ts\/README\.md/,
    );
  });

  test("the mark scan lists only files git carries, so a copy in a git-ignored cache is never a third home while an untracked unignored copy still is", () => {
    // D-1522 add.1: graft's ignored session cache held copies of the art and redded the scan in the operator's tree
    const repo = makeRepo({ ".gitignore": "/cache/\n", "tracked.txt": "x" });
    mkdirSync(join(repo, "cache"), { recursive: true });
    writeFileSync(join(repo, "cache", "session.json"), PLAIN_MARK!);
    writeFileSync(join(repo, "loose.txt"), PLAIN_MARK!);
    expect(listFiles(repo).map((path) => relative(repo, path)).sort()).toEqual([".gitignore", "loose.txt", "tracked.txt"]);
  });
});
