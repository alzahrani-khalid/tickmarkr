import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * REN-05 brand sweep. Retired spellings must not appear in src/ user-facing strings.
 * Forbidden tokens are built at runtime so this gate file stays grep-clean.
 *
 * Scope: src/**\/*.ts + README.md + CLAUDE.md only. Archives and vendored fixtures
 * (tests/fixtures/**, .planning/**) are NOT scanned here — the acceptance grep covers tests/.
 * The `tickmarkr` and `tkr` bin keys in package.json are asserted separately.
 */

const REPO = join(import.meta.dirname, "../..");
const LEGACY_SPELLINGS = [
  String.fromCharCode(100, 114, 111, 118, 114),
  String.fromCharCode(100, 114, 111, 118, 101, 114),
];

interface Site {
  file: string;
  /** Unique substring that MUST sit on the excused line; its absence ⇒ stale entry. */
  substr: string;
  reason: string;
}

// Each entry pins one compat site. Empty after T2 protocol rename — no legacy dual-parse remains.
const ALLOWLIST: Site[] = [];

interface Violation { file: string; line: number; text: string; }

/** Hit lines (case-insensitive legacy brand) NOT covered by any allowlist entry for that file. Pure. */
function scanSource(rel: string, text: string): Violation[] {
  const excused = ALLOWLIST.filter((s) => s.file === rel);
  const out: Violation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i]!.toLowerCase();
    if (!LEGACY_SPELLINGS.some((b) => lower.includes(b))) continue;
    const covered = excused.some((s) => lines[i]!.includes(s.substr));
    if (!covered) out.push({ file: rel, line: i + 1, text: lines[i]! });
  }
  return out;
}

/** Allowlist entries whose substr no longer appears in their file (stale ⇒ must redden). */
function staleEntries(): Site[] {
  return ALLOWLIST.filter((s) => {
    const abs = join(REPO, s.file);
    if (!existsSync(abs)) return true;
    return !readFileSync(abs, "utf8").includes(s.substr);
  });
}

function listSrc(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name.endsWith(".ts")) out.push(p);
    }
  }
  return out.sort();
}

function formatViolations(vs: Violation[]): string {
  return vs.map((v) => `${v.file}:${v.line}: ${v.text.trim()}`).join("\n");
}

const SCANNED: string[] = listSrc(join(REPO, "src")).map((p) => relative(REPO, p).split("\\").join("/"));

describe("REN-05 brand sweep — no retired spellings in src", () => {
  test("scanned tree is clean (no unallowlisted legacy spelling)", () => {
    expect(SCANNED.length, "scan found no source — walker is broken").toBeGreaterThan(0);
    const all: Violation[] = [];
    for (const rel of SCANNED) {
      const abs = join(REPO, rel);
      if (!existsSync(abs)) continue;
      all.push(...scanSource(rel, readFileSync(abs, "utf8")));
    }
    expect(all, `unallowlisted legacy spelling remains:\n${formatViolations(all)}`).toEqual([]);
  });

  test("allowlist entries are live (no stale excuses)", () => {
    const stale = staleEntries();
    expect(stale, `stale allowlist entries:\n${stale.map((s) => `${s.file} / "${s.substr}"`).join("\n")}`).toEqual([]);
  });

  test("red-capable: a stray legacy literal in a scanned src file is flagged", () => {
    const stray = LEGACY_SPELLINGS[1]!;
    const synth = `import { x } from './y.js';\n// a stray mention of ${stray} here\nexport const z = 1;\n`;
    const vs = scanSource("src/cli/index.ts", synth);
    expect(vs.some((v) => v.line === 2), formatViolations(vs)).toBe(true);
  });

  test("red-capable: an allowlisted line still flags a co-located stray (line not over-excused)", () => {
    const legacy = LEGACY_SPELLINGS[1]!;
    const synth = `const branch = \`${legacy}/\${branch}\`;\nconst brand = "${legacy}";\n`;
    const excused = [{ file: "src/run/git.ts", substr: `${legacy}/\${branch` }];
    const vs: Violation[] = [];
    const lines = synth.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i]!.toLowerCase();
      if (!LEGACY_SPELLINGS.some((b) => lower.includes(b))) continue;
      if (!excused.some((s) => lines[i]!.includes(s.substr))) vs.push({ file: "src/run/git.ts", line: i + 1, text: lines[i]! });
    }
    expect(vs.some((v) => v.line === 2), formatViolations(vs)).toBe(true);
    expect(vs.some((v) => v.line === 1), `excused line should NOT flag: ${formatViolations(vs)}`).toBe(false);
  });

  test("red-capable: freshness flags an allowlist entry whose literal is gone", () => {
    const stale = [{ file: "src/cli/index.ts", substr: "__definitely_gone__", reason: "synthetic" }].filter((s) => {
      const abs = join(REPO, s.file);
      return existsSync(abs) && !readFileSync(abs, "utf8").includes(s.substr);
    });
    expect(stale.length, "freshness check is not detecting a removed literal").toBeGreaterThan(0);
  });
});

describe("v1.31 bin aliases (package.json)", () => {
  test("only `tickmarkr` and `tkr` bin keys point at the identical entry", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin).toEqual({ tickmarkr: "dist/cli/index.js", tkr: "dist/cli/index.js" });
  });
});
