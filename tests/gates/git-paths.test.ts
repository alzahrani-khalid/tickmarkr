import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { diffSidePath, gitHeaderPaths, unquoteGitPath } from "../../src/gates/git-paths.js";
import { judgeContradictions } from "../../src/gates/run-gates.js";
import { makeRepo } from "../helpers/tmprepo.js";

// Queue row 71b's closed table (D-1594): every input is a string git 2.54 printed with core.quotePath true.
test.each([
  ["U1 an accented name", '"b/docs/caf\\303\\251.md"', "b/docs/café.md"],
  ["U2 an Arabic name", '"a/\\331\\205\\331\\204\\331\\201.bin"', "a/ملف.bin"],
  ["U3 a tab", '"b/tab\\tname.md"', "b/tab\tname.md"],
  ["U4 a double quote", '"b/q\\"uote.md"', 'b/q"uote.md'],
  ["U5 a backslash", '"b/back\\\\slash.md"', "b/back\\slash.md"],
  ["U6 a bell", '"b/bell\\a.md"', "b/bell\u0007.md"],
  ["U7 an unquoted path", "b/plain.md", "b/plain.md"],
] as const)("git's path quoting decodes %s", (_row, raw, expected) => {
  expect(unquoteGitPath(raw)).toBe(expected);
});

// git ends a ---/+++ side holding a space with one tab, quoted or not; exactly that tab goes, never a trim.
test.each([
  ["D1 a space-holding side keeps its leading space", "b/ lead.md\t", " lead.md"],
  ["D2 a space-holding side keeps its trailing space", "a/trail.md \t", "trail.md "],
  ["D3 a quoted space-holding side drops its tab", '"a/caf\\303\\251 x.md"\t', "café x.md"],
  ["D4 /dev/null names no path", "/dev/null", null],
  ["D5 a plain side loses its prefix", "b/x.md", "x.md"],
] as const)("a diff side line reads %s", (_row, raw, expected) => {
  expect(diffSidePath(raw)).toBe(expected);
});

// A section with no ---/+++ or rename lines is never a rename, so an unquoted header names one path twice: it is read
// ONLY by the exact both-halves rule (whitespace kept); a whitespace split is for QUOTED tokens alone (D-1604).
test.each([
  ["H1 a mode-only header holding a space splits where both halves match", "a/mode me.sh b/mode me.sh", ["mode me.sh"]],
  ["H2 a leading-space header splits where both halves match", "a/ lead.md b/ lead.md", [" lead.md"]],
  ["H3 a quoted header", '"a/caf\\303\\251.md" "b/caf\\303\\251.md"', ["café.md"]],
  ["H4 a plain header", "a/x b/x", ["x"]],
  ["H5 halves that differ are unresolvable", "a/one two b/three four", []],
  ["H6 a name ending in a space keeps it", "a/x  b/x ", ["x "]],
  ["H7 an unquoted header with unequal halves is unresolvable", "a/one  b/two ", []],
  ["H8 a name that is one space", "a/  b/ ", [" "]],
  ["H9 an unquoted two-path header is unresolvable, never split at whitespace", "a/one b/two", []],
  ["H10 an unterminated second quoted side is unresolvable", '"a/x" "b/x', []],
  ["H11 an unterminated quoted path is unresolvable", '"a/x" "b/unterminated', []],
  ["H12 a lone opening quote is unresolvable", '"a/x" "', []],
  ["H13 an escaped closing quote is unresolvable", '"a/x" "b/x\\"', []],
  ["H14 two quoted sides with no separator are unresolvable", '"a/x""b/x"', []],
  ["H15 one quoted side and one bare side are unresolvable", '"a/x" b/x', []],
  ["H16 two quoted sides joined by two spaces are unresolvable", '"a/x"  "b/x"', []],
  ["H17 two quoted paths without a/ and b/ are unresolvable", '"x" "y"', []],
  ["H18 a quoted header whose second side is not b/ is unresolvable", '"a/x" "a/x"', []],
  ["H19 a quoted header naming two different non-ASCII paths is unresolvable", '"a/caf\\303\\251" "b/caf\\303\\274"', []],
] as const)("a diff --git header reads %s", (_row, header, expected) => {
  expect(gitHeaderPaths(header)).toEqual(expected);
});

// D-1594 rider 3: the one persisted path a patch parser fed is an OBS-1151 judgment citation. A prior ruling that cited
// git's old quoted form names no blob at either commit, and a missing blob is unknown, never identical.
test("J1 a prior ruling citing a path in git's old quoted form is never a contradiction", async () => {
  const repo = makeRepo({ "docs/café.md": "A\n" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const prior = [{ commit: head, criteria: [{ id: "c1", key: "k1", met: true, paths: ['"b/docs/caf\\303\\251.md"'] }] }];
  const fresh = [{ id: "c1", key: "k1", met: false, paths: ["docs/café.md"] }];
  expect(await judgeContradictions(repo, head, fresh, prior)).toEqual([]);
});
