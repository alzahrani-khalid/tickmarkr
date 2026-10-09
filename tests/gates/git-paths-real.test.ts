import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { changedLinesByFile } from "../../src/gates/acceptance.js";
import { measureArtifactDiff, reviewableLogicDiff } from "../../src/gates/artifact-manifest.js";
import { makeRepo } from "../helpers/tmprepo.js";

// Queue row 71b: a real repository (core.quotePath true, git's default) and the real `git diff` through both
// production patch parsers. Names: accented + space, a trailing space, Arabic (binary, deleted), a mode-only change on a
// spaced name, and a new accented file.
function realDiff(): string {
  const repo = makeRepo({ "seed.md": "x\n", "café x.md": "a\n", "trail.md ": "a\n", "mode me.sh": "a\n", "ملف.bin": "\0\u0001bin" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("config", "core.quotePath", "true");
  writeFileSync(join(repo, "café x.md"), "a\nb\n");
  writeFileSync(join(repo, "trail.md "), "a\nb\n");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs/café.md"), "new\n");
  chmodSync(join(repo, "mode me.sh"), 0o755);
  rmSync(join(repo, "ملف.bin"));
  git("add", "-A");
  git("commit", "-qm", "change", "--no-gpg-sign");
  return git("diff", "HEAD~1..HEAD");
}

test("the acceptance judge's citable changed lines name non-ASCII and space-holding files verbatim", () => {
  const files = [...changedLinesByFile(realDiff()).keys()].sort();
  expect(files).toEqual(["café x.md", "docs/café.md", "trail.md "].sort());
});

test("the artifact manifest names every real diff section's path verbatim, mode-only and deleted binary included", () => {
  const paths = measureArtifactDiff(realDiff()).sections.flatMap((section) => section.paths).sort();
  expect(paths).toEqual(["café x.md", "docs/café.md", "mode me.sh", "trail.md ", "ملف.bin"].sort());
});

test("a deleted non-ASCII binary is reported by its name on disk", () => {
  expect(reviewableLogicDiff(realDiff())).toContain("deleted file: ملف.bin\n");
});

// D-1604: names that END in a space (and one that IS a space), in sections whose only path source is the diff --git
// header — mode-only, binary modification, empty-file addition, binary deletion. A whitespace split drops the space.
function headerOnlyDiff(): string {
  const repo = makeRepo({ "seed.md": "x\n", "mode.sh ": "a\n", " ": "a\n", "blob.bin ": "\0old", "gone.bin ": "\0gone" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("config", "core.quotePath", "true");
  chmodSync(join(repo, "mode.sh "), 0o755);
  chmodSync(join(repo, " "), 0o755);
  writeFileSync(join(repo, "blob.bin "), "\0new");
  writeFileSync(join(repo, "empty "), "");
  rmSync(join(repo, "gone.bin "));
  git("add", "-A");
  git("commit", "-qm", "change", "--no-gpg-sign");
  return git("diff", "HEAD~1..HEAD");
}

test("the artifact manifest keeps a trailing or lone space in every header-only section's path", () => {
  const paths = measureArtifactDiff(headerOnlyDiff()).sections.flatMap((section) => section.paths).sort();
  expect(paths).toEqual([" ", "blob.bin ", "empty ", "gone.bin ", "mode.sh "].sort());
});

test("a deleted binary whose name ends in a space is reported by its full name", () => {
  expect(reviewableLogicDiff(headerOnlyDiff())).toContain("deleted file: gone.bin \n");
});

