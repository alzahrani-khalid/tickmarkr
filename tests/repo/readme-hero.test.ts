import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import * as brandModule from "../../src/brand.js";
import { BANNER, PLAIN_BANNER } from "../../src/brand.js";

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

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      out.push(...listFiles(join(dir, ent.name)));
    } else if (ent.isFile()) {
      out.push(join(dir, ent.name));
    }
  }
  return out;
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
});
