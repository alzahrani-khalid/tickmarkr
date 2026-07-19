import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { BANNER, PLAIN_BANNER } from "../../src/brand.js";

const REPO = join(import.meta.dirname, "../..");
const README = join(REPO, "README.md");
const BRAND = join(REPO, "src/brand.ts");

/** First fenced ``` block in README (the hero). */
function readmeHeroBlock(md: string): string {
  const open = md.indexOf("```\n");
  if (open < 0) throw new Error("README hero fence missing");
  const start = open + 4;
  const close = md.indexOf("\n```", start);
  if (close < 0) throw new Error("README hero fence unclosed");
  return md.slice(start, close + 1);
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".tickmarkr", ".planning"]);

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

  test("the block art duplication scan ignores files under the planning tree", () => {
    const needle = PLAIN_BANNER.split("\n").find((l) => l.includes("\u2584\u2584"))!;
    const allowed = new Set([BRAND, README].map((p) => relative(REPO, p)));
    const dupes: string[] = [];
    for (const abs of listFiles(REPO)) {
      const rel = relative(REPO, abs).split("\\").join("/");
      if (allowed.has(rel) || !existsSync(abs)) continue;
      const text = readFileSync(abs, "utf8");
      if (text.includes(needle)) dupes.push(rel);
    }
    expect(dupes, `block art duplicated outside brand.ts/README.md:\n${dupes.join("\n")}`).toEqual([]);
  });
});
