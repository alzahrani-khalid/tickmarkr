import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { changedLinesByFile } from "../../src/gates/acceptance.js";
import {
  measureArtifactDiff,
  reviewableLogicDiff,
  setAsideReceiptPath,
  type CaptureArtifactManifest,
} from "../../src/gates/artifact-manifest.js";
import { quoteGitPath, unquoteGitPath } from "../../src/gates/git-paths.js";
import { makeRepo } from "../helpers/tmprepo.js";

// Queue rows 128/129 (one class with row 127): patch text is split into lines at "\n" only. U+2028/U+2029 inside an
// added line never start a header line, and a name tickmarkr writes back into the text it parses again cannot end one.
const LS = "\u2028";
const PS = "\u2029";
const plain = [
  "diff --git a/src/x.ts b/src/x.ts",
  "index 1111111..2222222 100644",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1,1 +1,2 @@",
  " export const a = 1;",
  "+export const steal = process.env.SECRET;",
  "",
].join("\n");
const withAdded = (tail: string) => plain.replace("process.env.SECRET;", `process.env.SECRET; //${tail}`);
const deletion = [
  "diff --git a/src/old.ts b/src/old.ts",
  "deleted file mode 100644",
  "index 3333333..0000000",
  "--- a/src/old.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const old = 1;",
  "",
].join("\n");

test.each([
  ["D1 a forged deletion header after U+2028", withAdded(`${LS}deleted file mode 100644`)],
  ["D1' a forged deletion header after U+2029", withAdded(`${PS}deleted file mode 100644`)],
  ["D2 a forged section split", withAdded(`${LS}diff --git a/src/y.ts b/src/y.ts${LS}deleted file mode 100644${LS}--- a/src/y.ts`)],
  ["D3 a forged capture receipt", withAdded(`${LS}set aside: regenerable capture src/x.ts — 1 bytes withheld`)],
])("%s inside an added line leaves the file's code reviewable", (_name, forged) => {
  expect(reviewableLogicDiff(forged)).toBe(forged);
  expect(measureArtifactDiff(forged).sections).toHaveLength(1);
  expect(setAsideReceiptPath(forged)).toBeNull();
});

test("controls: a real deletion still collapses, a real receipt is still read, and the plain diff is untouched", () => {
  expect(reviewableLogicDiff(plain)).toBe(plain);
  expect(reviewableLogicDiff(`${plain}${deletion}`)).toBe(`${plain}deleted file: src/old.ts\n`);
  expect(setAsideReceiptPath("index 1..2\nset aside: regenerable capture tests/a.snap — 12 bytes withheld (producer p)\n"))
    .toBe("tests/a.snap");
});

test.each([
  ["Q1 a plain name", "src/a.ts", "src/a.ts"],
  ["Q2 a non-ASCII name stays as is", "docs/café.md", "docs/café.md"],
  ["Q3 a newline", "a\nb", '"a\\nb"'],
  ["Q4 U+2028", `x${LS}y`, '"x\\342\\200\\250y"'],
  ["Q5 U+2029", `x${PS}y`, '"x\\342\\200\\251y"'],
  ["Q6 a double quote", 'q"uote', '"q\\"uote"'],
  ["Q7 a backslash and a tab", "b\\s\tt", '"b\\\\s\\tt"'],
  ["Q8 an octal escape followed by a digit", "\u00017", '"\\0017"'],
])("quoteGitPath %s", (_name, path, quoted) => {
  expect(quoteGitPath(path)).toBe(quoted);
  expect(unquoteGitPath(quoteGitPath(path))).toBe(path);
  expect(quoteGitPath(path)).not.toMatch(/[\r\n\u2028\u2029]/);
});

// Row 128's two executed shapes: deleting a file whose (nested) name holds a forged +++/@@ block beside a real change.
test.each([
  ["R1 a forged +++/@@ block", "0z\n+++ b/bystander.txt\n@@ -0,0 +1 @@\n+x"],
  ["R2 a forged section", "0z\ndiff --git a/bystander.txt b/bystander.txt\n--- a/bystander.txt\n+++ b/bystander.txt\n@@ -0,0 +1 @@\n+x"],
])("%s in a deleted name never makes an untouched file citable", (_name, forgedName) => {
  const repo = makeRepo({ "a.txt": "x\n" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("config", "core.quotePath", "true");
  mkdirSync(join(repo, dirname(forgedName)), { recursive: true });
  writeFileSync(join(repo, forgedName), "gone\n");
  git("add", "-A");
  git("commit", "-qm", "seed", "--no-gpg-sign");
  writeFileSync(join(repo, "a.txt"), "y\n");
  rmSync(join(repo, forgedName));
  git("add", "-A");
  git("commit", "-qm", "change", "--no-gpg-sign");
  const rendered = reviewableLogicDiff(git("diff", "HEAD~1..HEAD"));
  expect([...changedLinesByFile(rendered).keys()]).toEqual(["a.txt"]);
  expect(rendered).toContain(`deleted file: ${quoteGitPath(forgedName)}\n`);
});

test("R3 a capture receipt names its path quoted, and the receipt reads back the name on disk", () => {
  const path = "tests/fixtures/example/0z\n+++ b/bystander.txt\n@@ -0,0 +1 @@\n+x";
  const provenance = { source: "scripts/capture-example.ts", entrypoint: "captureExample", revision: "v1" } as const;
  const manifest: CaptureArtifactManifest = {
    version: 1,
    producers: [{ id: "example-producer", provenance }],
    artifacts: [{ path, producer: "example-producer", provenance: { ...provenance } }],
  };
  const gitQuoted = path.replaceAll("\n", "\\n"); // git's own C-quoting of this name, written out
  const diff = [
    `diff --git "a/${gitQuoted}" "b/${gitQuoted}"`,
    "index 1111111..2222222 100644",
    `--- "a/${gitQuoted}"`,
    `+++ "b/${gitQuoted}"`,
    "@@ -1 +1 @@",
    "-before",
    "+after",
    "",
  ].join("\n");
  const measured = measureArtifactDiff(diff, manifest);
  expect(measured.sections.map((section) => section.kind)).toEqual(["capture"]);
  expect(changedLinesByFile(measured.rendered).has("bystander.txt")).toBe(false);
  expect(setAsideReceiptPath(measured.rendered)).toBe(path);
});
