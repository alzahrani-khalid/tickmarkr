import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const REPO = join(import.meta.dirname, "../..");
const CANONICAL = join(REPO, "skills");
const INSTALLED = join(REPO, ".claude/skills");
const EXPORTED_TREE_SKIP_REASON = "exported-tree context: .claude/skills is absent";

interface Violation {
  name: string;
  reason: string;
}

export function skillsSingleSourceSkipReason(installedDir: string): string | undefined {
  return existsSync(installedDir) ? undefined : EXPORTED_TREE_SKIP_REASON;
}

/** Skill dirs under root that contain SKILL.md. */
function skillNames(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(root, name, "SKILL.md")))
    .sort();
}

/**
 * OBS-35: every name present in BOTH skills/ and .claude/skills/ must be a symlink
 * in .claude/skills resolving into skills/ with byte-identical content.
 */
export function checkSkillsSingleSource(canonicalDir: string, installedDir: string): Violation[] {
  const canonical = new Set(skillNames(canonicalDir));
  const violations: Violation[] = [];

  for (const name of skillNames(installedDir)) {
    if (!canonical.has(name)) continue;
    const installedPath = join(installedDir, name, "SKILL.md");
    const canonicalPath = join(canonicalDir, name, "SKILL.md");
    const stat = lstatSync(installedPath);

    if (!stat.isSymbolicLink()) {
      violations.push({ name, reason: "not a symlink — real file shadows canonical skill" });
      continue;
    }

    const linkTarget = readlinkSync(installedPath);
    // From .claude/skills/<name>/SKILL.md up to repo root, then into skills/.
    const expectedRel = join("..", "..", "..", "skills", name, "SKILL.md");
    if (linkTarget !== expectedRel) {
      violations.push({ name, reason: `symlink target ${linkTarget!} !== ${expectedRel}` });
    }

    if (realpathSync(installedPath) !== realpathSync(canonicalPath)) {
      violations.push({ name, reason: "symlink does not resolve to canonical SKILL.md" });
    }

    if (!readFileSync(installedPath).equals(readFileSync(canonicalPath))) {
      violations.push({ name, reason: "content drift vs skills/" });
    }
  }

  return violations;
}

describe("OBS-44 exported-tree guard", () => {
  test("skips the repo-hygiene suite when a fixture lacks .claude/skills", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-ss-export-"));
    try {
      const installedDir = join(root, ".claude/skills");
      expect(skillsSingleSourceSkipReason(installedDir)).toBe(EXPORTED_TREE_SKIP_REASON);

      mkdirSync(installedDir, { recursive: true });
      expect(skillsSingleSourceSkipReason(installedDir)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports the drifted SKILL.md when both roots exist", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-ss-drift-"));
    try {
      const canonicalDir = join(root, "skills");
      const installedDir = join(root, ".claude/skills");
      const name = "drifted-skill";
      const canonicalPath = join(canonicalDir, name, "SKILL.md");
      const driftedPath = join(root, "drifted", "SKILL.md");
      const installedPath = join(installedDir, name, "SKILL.md");
      mkdirSync(join(canonicalDir, name), { recursive: true });
      mkdirSync(join(installedDir, name), { recursive: true });
      mkdirSync(join(root, "drifted"), { recursive: true });
      writeFileSync(canonicalPath, "canonical\n");
      writeFileSync(driftedPath, "canonical!\n");
      symlinkSync(driftedPath, installedPath);

      expect(checkSkillsSingleSource(canonicalDir, installedDir)).toContainEqual({
        name,
        reason: "content drift vs skills/",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const skipReason = skillsSingleSourceSkipReason(INSTALLED);
const suiteName = skipReason
  ? `OBS-35 skills single-source (skills/ canonical) — ${skipReason}`
  : "OBS-35 skills single-source (skills/ canonical)";

const OVERSEER_FILES = ["SKILL.md", join("scripts", "watch-panes.sh")];

describe("T9 overseer skill packaging (canonical tree)", () => {
  test("the canonical overseer skill carries its pane watcher script beside its instructions", () => {
    const dir = join(CANONICAL, "tickmarkr-overseer");
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("name: tickmarkr-overseer");
    const watcher = join(dir, "scripts", "watch-panes.sh");
    expect(readFileSync(watcher, "utf8").startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(lstatSync(watcher).mode & 0o111, "watcher must stay executable").not.toBe(0);
  });
});

describe.skipIf(skipReason !== undefined)(suiteName, () => {
  test("tickmarkr-loop and tickmarkr-auto installed copies are symlinks with byte-identical content", () => {
    for (const name of ["tickmarkr-loop", "tickmarkr-auto"]) {
      const installed = join(INSTALLED, name, "SKILL.md");
      const canonical = join(CANONICAL, name, "SKILL.md");
      expect(lstatSync(installed).isSymbolicLink(), `${name} must be a symlink`).toBe(true);
      expect(readlinkSync(installed)).toBe(join("..", "..", "..", "skills", name, "SKILL.md"));
      expect(readFileSync(installed)).toEqual(readFileSync(canonical));
    }
  });

  test("the private overseer skill copy resolves through a symlink to its canonical packaged source, matching the existing driving skills", () => {
    for (const file of OVERSEER_FILES) {
      const installed = join(INSTALLED, "tickmarkr-overseer", file);
      const canonical = join(CANONICAL, "tickmarkr-overseer", file);
      expect(lstatSync(installed).isSymbolicLink(), `${file} must be a symlink`).toBe(true);
      expect(readlinkSync(installed)).toBe(relative(dirname(installed), canonical));
      expect(realpathSync(installed)).toBe(realpathSync(canonical));
      expect(readFileSync(installed)).toEqual(readFileSync(canonical));
    }
  });

  test("live tree: shared skill names in .claude/skills are symlinks into skills/", () => {
    expect(checkSkillsSingleSource(CANONICAL, INSTALLED)).toEqual([]);
  });

  test("drift guard fails when a real file shadows a canonical skill", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-ss-"));
    try {
      const canonicalDir = join(root, "skills");
      const installedDir = join(root, ".claude/skills");
      mkdirSync(join(canonicalDir, "shadow-me"), { recursive: true });
      mkdirSync(join(installedDir, "shadow-me"), { recursive: true });
      writeFileSync(join(canonicalDir, "shadow-me", "SKILL.md"), "canonical\n");
      writeFileSync(join(installedDir, "shadow-me", "SKILL.md"), "canonical\n");

      const vs = checkSkillsSingleSource(canonicalDir, installedDir);
      expect(vs.some((v) => v.name === "shadow-me" && v.reason.includes("not a symlink"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
