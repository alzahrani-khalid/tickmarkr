import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * HYG-06 / D-03: tests must not fixture against live, operator-mutable repo state.
 *
 * R1 — live phase dirs under the planning tree (archive-fragile; v1.11 class).
 * R2 — cwd-rooted operator config-dir reads without an explicit allowlist
 *       (operator-config class; fixed at bae863b for config.test.ts; class remains guarded).
 *
 * Provenance for R2 red-capability fixture:
 *   git show 'bae863b^:tests/config/config.test.ts'  (commit bae863b parent)
 *
 * Forbidden path/state literals in THIS file are built by string concatenation so the scanner
 * cannot match its own source. Historical snippets live under tests/fixtures/hygiene/*.txt
 * (data, not scanned as source).
 */

// Concatenated so this file never self-matches under scanSource.
const DOT_PLANNING = "." + "planning/";
const PHASES_SEG = "phases/";
const LIVE_PHASES = DOT_PLANNING + PHASES_SEG;
const PROCESS_CWD = "process" + "." + "cwd()";
const DOT_TICKMARKR = "." + "tickmarkr";

const REPO = join(import.meta.dirname, "../..");
const TESTS_ROOT = join(REPO, "tests");
const HYGIENE_FIX = join(import.meta.dirname, "../fixtures/hygiene");

/** Allowlist is R2-only. Every entry needs a reason; freshness check asserts the excused pattern remains. */
const ALLOWLIST: Record<string, string> = {
  "tests/config/config.test.ts":
    "post-bae863b MODEL-10 overlay-dedup pins; asserts only source-guaranteed types/absence-of-dupes and skips when the file is absent",
};

interface Violation {
  file: string;
  line: number;
  rule: "live-phases" | "operator-state";
}

/** Strip // line comments so prose mentions of live paths do not false-positive R1. */
function stripLineComment(line: string): string {
  const idx = line.indexOf("//");
  if (idx === -1) return line;
  return line.slice(0, idx);
}

/**
 * Pure scanner over one test source. R1 is per-line (comment-stripped).
 * R2 is file-level co-occurrence of PROCESS_CWD + DOT_TICKMARKR, excused only via ALLOWLIST.
 */
function scanSource(path: string, text: string, allowlist: Record<string, string> = {}): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const code = stripLineComment(lines[i]!);
    if (code.includes(LIVE_PHASES)) {
      violations.push({ file: path, line: i + 1, rule: "live-phases" });
    }
  }

  if (text.includes(PROCESS_CWD) && text.includes(DOT_TICKMARKR) && !allowlist[path]) {
    let any = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(PROCESS_CWD)) {
        violations.push({ file: path, line: i + 1, rule: "operator-state" });
        any = true;
      }
    }
    if (!any) {
      violations.push({ file: path, line: 1, rule: "operator-state" });
    }
  }

  return violations;
}

function listTestSources(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name.endsWith(".test.ts")) out.push(p);
    }
  }
  return out.sort();
}

function formatViolations(vs: Violation[]): string {
  return vs.map((v) => `${v.file}:${v.line} [${v.rule}]`).join("\n");
}

describe("HYG-06 live-fixture guard (D-03)", () => {
  test("guard catches the v1.11 archive-time class (R1)", () => {
    // Pre-fix trailer-width path construction (this repo HEAD at plan start).
    const snippet = readFileSync(join(HYGIENE_FIX, "live-phases-snippet.txt"), "utf8");
    const vs = scanSource("snippet.ts", snippet);
    expect(vs.some((v) => v.rule === "live-phases"), formatViolations(vs)).toBe(true);
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  test("guard catches the pre-bae863b operator-state class (R2)", () => {
    // Provenance: git show bae863b^ (parent of bae863b) for the config.test.ts operator pins.
    const snippet = readFileSync(join(HYGIENE_FIX, "operator-config-snippet.txt"), "utf8");
    expect(snippet.includes(PROCESS_CWD)).toBe(true);
    expect(snippet.includes(DOT_TICKMARKR)).toBe(true);
    const vs = scanSource("snippet.ts", snippet);
    expect(vs.some((v) => v.rule === "operator-state"), formatViolations(vs)).toBe(true);
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  test("live tree is clean", () => {
    const files = listTestSources(TESTS_ROOT);
    const all: Violation[] = [];
    for (const abs of files) {
      const rel = relative(REPO, abs).split("\\").join("/");
      const text = readFileSync(abs, "utf8");
      all.push(...scanSource(rel, text, ALLOWLIST));
    }
    expect(all, formatViolations(all)).toEqual([]);
  });

  test("allowlist entries are live", () => {
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `allowlist entry for ${file} needs a reason`).toBeGreaterThan(0);
      const abs = join(REPO, file);
      expect(existsSync(abs), `allowlisted file missing: ${file}`).toBe(true);
      const text = readFileSync(abs, "utf8");
      // Stale allowlist entry (excused pattern gone) reddens.
      expect(text.includes(PROCESS_CWD), `stale allowlist: ${file} no longer contains ${PROCESS_CWD}`).toBe(true);
      expect(text.includes(DOT_TICKMARKR), `stale allowlist: ${file} no longer contains ${DOT_TICKMARKR}`).toBe(true);
    }
  });
});
