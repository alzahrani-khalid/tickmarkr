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

function skillFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(relative(root, path));
    }
  };
  visit(root);
  return files.sort();
}

/**
 * OBS-35: every file in a skill present in BOTH skills/ and .claude/skills/ must resolve to or
 * contain the same bytes as its canonical counterpart. Installed-only names and files are findings
 * until the live-tree assertion below records the deliberate .claude-only decisions.
 */
export function checkSkillsSingleSource(canonicalDir: string, installedDir: string): Violation[] {
  const canonicalNames = new Set(skillNames(canonicalDir));
  const installedNames = skillNames(installedDir);
  const violations: Violation[] = [];

  for (const name of installedNames) {
    if (!canonicalNames.has(name)) {
      violations.push({ name, reason: "installed-only skill requires an explicit decision" });
      continue;
    }

    const canonicalRoot = join(canonicalDir, name);
    const installedRoot = join(installedDir, name);
    const canonicalFiles = new Set(skillFiles(canonicalRoot));
    const installedFiles = new Set(skillFiles(installedRoot));

    for (const file of [...new Set([...canonicalFiles, ...installedFiles])].sort()) {
      const prefix = file === "SKILL.md" ? "" : `${file}: `;
      if (!canonicalFiles.has(file)) {
        violations.push({ name, reason: `${prefix}installed-only file requires an explicit decision` });
        continue;
      }
      if (!installedFiles.has(file)) {
        violations.push({ name, reason: `${prefix}missing from installed tree` });
        continue;
      }

      const installedPath = join(installedRoot, file);
      const canonicalPath = join(canonicalRoot, file);
      const stat = lstatSync(installedPath);

      if (file === "SKILL.md" && !stat.isSymbolicLink()) {
        violations.push({ name, reason: "not a symlink — real file shadows canonical skill" });
      }

      if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(installedPath);
        const expectedRel = relative(dirname(installedPath), canonicalPath);
        if (linkTarget !== expectedRel) {
          violations.push({ name, reason: `${prefix}symlink target ${linkTarget} !== ${expectedRel}` });
        }
        if (realpathSync(installedPath) !== realpathSync(canonicalPath)) {
          violations.push({ name, reason: `${prefix}symlink does not resolve to canonical file` });
        }
      }

      if (!readFileSync(installedPath).equals(readFileSync(canonicalPath))) {
        violations.push({ name, reason: `${prefix}content drift vs skills/` });
      }
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

  test("test: a shared skill directory whose script differs between the canonical and installed trees fails the guard, so editing one copy of a duplicated script can no longer pass", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-ss-script-drift-"));
    try {
      const canonicalDir = join(root, "skills");
      const installedDir = join(root, ".claude/skills");
      const name = "duplicated-script";
      const canonicalRoot = join(canonicalDir, name);
      const installedRoot = join(installedDir, name);
      mkdirSync(join(canonicalRoot, "scripts"), { recursive: true });
      mkdirSync(join(installedRoot, "scripts"), { recursive: true });
      writeFileSync(join(canonicalRoot, "SKILL.md"), "canonical\n");
      symlinkSync(relative(installedRoot, join(canonicalRoot, "SKILL.md")), join(installedRoot, "SKILL.md"));
      writeFileSync(join(canonicalRoot, "scripts/watch.sh"), "same\n");
      writeFileSync(join(installedRoot, "scripts/watch.sh"), "same\n");
      expect(checkSkillsSingleSource(canonicalDir, installedDir)).toEqual([]);

      writeFileSync(join(canonicalRoot, "scripts/watch.sh"), "canonical changed\n");
      expect(checkSkillsSingleSource(canonicalDir, installedDir)).toContainEqual({
        name,
        reason: "scripts/watch.sh: content drift vs skills/",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("test: a skill name present only in the installed tree is reported as an explicit decision rather than skipped, so an orphan is visible instead of invisible", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-ss-orphan-"));
    try {
      const canonicalDir = join(root, "skills");
      const installedDir = join(root, ".claude/skills");
      mkdirSync(canonicalDir, { recursive: true });
      mkdirSync(join(installedDir, "installed-only"), { recursive: true });
      writeFileSync(join(installedDir, "installed-only", "SKILL.md"), "local\n");

      expect(checkSkillsSingleSource(canonicalDir, installedDir)).toEqual([{
        name: "installed-only",
        reason: "installed-only skill requires an explicit decision",
      }]);
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

  test("live tree: shared files match and every .claude-only orphan has an explicit decision", () => {
    const explicitInstalledOnly: Violation[] = [
      {
        name: "tickmarkr-overseer",
        reason: "scripts/check-admission-records.sh: installed-only file requires an explicit decision",
      },
      {
        name: "tickmarkr-overseer",
        reason: "scripts/journal-pretty.sh: installed-only file requires an explicit decision",
      },
      ...["tkr", "tkr-doctor", "tkr-help", "tkr-init", "tkr-loop"].map((name) => ({
        name,
        reason: "installed-only skill requires an explicit decision",
      })),
    ];
    expect(checkSkillsSingleSource(CANONICAL, INSTALLED)).toEqual(explicitInstalledOnly);
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
