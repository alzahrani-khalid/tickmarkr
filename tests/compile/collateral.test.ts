import { describe, expect, test } from "vitest";
import {
  classifyScopeOffenders, collateralHits, collateralLints, newDirectoryLints, sourceScopeLints,
} from "../../src/compile/collateral.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

// OBS-21 T2 signature: task touches src/adapters/codex.ts; real-adapters.test.ts pins the command line.
const FIXTURE = {
  "src/adapters/codex.ts": "export const codex = {};\n",
  "src/adapters/other.ts": "export const other = {};\n",
  "tests/adapters/real-adapters.test.ts":
    'import { codex } from "../../src/adapters/codex.js";\nexpect(codex);\n',
  "tests/adapters/unrelated.test.ts": 'import { other } from "../../src/adapters/other.js";\n',
  "docs/readme.md": "# docs only\n",
};

const task = (id: string, files: string[]) => ({ id, files });

describe("collateralLints (plan-time OBS-12/21 scan)", () => {
  test("src/adapters/codex.ts with referencing test not in files[] → lint names task + test", () => {
    const repo = makeRepo(FIXTURE);
    const lints = collateralLints(
      [task("T2", ["src/adapters/codex.ts"])],
      repo,
    );
    expect(lints).toHaveLength(1);
    expect(lints[0]).toContain("T2");
    expect(lints[0]).toContain("tests/adapters/real-adapters.test.ts");
    expect(lints[0]).toMatch(/collateral/i);
  });

  test("same graph with the referencing test already in files[] → zero scope lints", () => {
    const repo = makeRepo(FIXTURE);
    const lints = collateralLints(
      [task("T2", ["src/adapters/codex.ts", "tests/adapters/real-adapters.test.ts"])],
      repo,
    );
    expect(lints).toEqual([]);
  });

  test("collateralLints accepts a glob in the files list that the scope gate would accept", () => {
    const repo = makeRepo(FIXTURE);
    expect(collateralLints([task("T2", ["src/adapters/codex.ts", "tests/adapters/*.test.ts"])], repo)).toEqual([]);
  });

  test("docs-only task (no src/ files) → zero scope lints", () => {
    const repo = makeRepo(FIXTURE);
    const lints = collateralLints([task("T1", ["docs/readme.md"])], repo);
    expect(lints).toEqual([]);
  });

  test("does not expand files[] — pure function, input arrays unchanged", () => {
    const repo = makeRepo(FIXTURE);
    const files = ["src/adapters/codex.ts"];
    const t = task("T2", files);
    collateralLints([t], repo);
    expect(t.files).toEqual(["src/adapters/codex.ts"]);
    expect(files).toEqual(["src/adapters/codex.ts"]);
  });

  test("import of ../../src/adapters/codex.js is still flagged for task touching codex.ts", () => {
    const repo = makeRepo({
      "src/adapters/codex.ts": "export const codex = {};\n",
      "tests/adapters/import-codex.test.ts":
        'import { codex } from "../../src/adapters/codex.js";\nexpect(codex);\n',
    });
    const lints = collateralLints([task("T2", ["src/adapters/codex.ts"])], repo);
    expect(lints).toHaveLength(1);
    expect(lints[0]).toContain("tests/adapters/import-codex.test.ts");
  });

  test("bare word 'codex' without src-path reference is NOT flagged", () => {
    const repo = makeRepo({
      "src/adapters/codex.ts": "export const codex = {};\n",
      "tests/adapters/prose.test.ts":
        '// the codex adapter is great\nconst codex = 1;\nexpect(codex).toBe(1);\n',
    });
    const lints = collateralLints([task("T2", ["src/adapters/codex.ts"])], repo);
    expect(lints).toEqual([]);
  });
});


test("compile on a task whose files patterns add a new path under the top-level scripts directory names tests repo export-manifest as likely collateral while a task adding a path under tests or src does not whereas a sweep that matches names and symbols alone fails", () => {
  const manifest = 'test("the export set is exact", () => expect(true).toBe(true));\n';
  const repo = makeRepo({ "tests/repo/export-manifest.test.ts": manifest });

  const scripts = collateralLints([task("T1", ["scripts/new-tool.ts"])], repo);
  const controls = collateralLints([
    task("T2", ["tests/new-test.test.ts"]),
    task("T3", ["src/new-module.ts"]),
  ], repo);

  expect(manifest).not.toMatch(/new-tool|scripts\//);
  expect(scripts).toEqual([
    "T1: likely collateral tests not in files[]: tests/repo/export-manifest.test.ts",
  ]);
  expect(controls).toEqual([]);
});

describe("OBS-547 — the map the scope gate classifies on", () => {
  // 25 collateral hits: the display shows 20, so hits 21-25 are exactly the case that went unread.
  const capBitingRepo = () => makeRepo({
    "src/adapters/codex.ts": "export const codex = {};\n",
    ...Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `tests/adapters/codex-${String(i).padStart(2, "0")}.test.ts`,
        'import "../../src/adapters/codex.js";\n',
      ]),
    ),
    "tests/adapters/unrelated.test.ts": 'import "../../src/adapters/other.js";\n',
  });

  test("test: the full collateral map classifies its hidden 21st hit as authoring while a path absent from that map records a miss; a classifier bounded by the display cap fails", () => {
    const repo = capBitingRepo();
    const hits = collateralHits([task("T2", ["src/adapters/codex.ts"])], repo).get("T2") ?? [];
    expect(hits).toHaveLength(25);

    const hidden = hits[20]!; // the 21st

    const onFullMap = classifyScopeOffenders("T2", [hidden], hits);
    expect(onFullMap.authoring).toBe(true);
    expect(onFullMap.predicted).toEqual([hidden]);
    expect(onFullMap.missed).toEqual([]);
    expect(onFullMap.repair).toBe(`add ${hidden} to T2.files[]`);

    // the same red against the DISPLAYED subset: the prediction is thrown away and the worker charged
    const onDisplayedSubset = classifyScopeOffenders("T2", [hidden], hits.slice(0, 20));
    expect(onDisplayedSubset.authoring).toBe(false);
    expect(onDisplayedSubset.missed).toEqual([hidden]);

    // a path the map never named is a MISS, recorded — not an authoring park
    const unpredicted = classifyScopeOffenders("T2", ["tests/cockpit/demo.test.ts"], hits);
    expect(unpredicted.authoring).toBe(false);
    expect(unpredicted.missed).toEqual(["tests/cockpit/demo.test.ts"]);
    expect(unpredicted.predicted).toEqual([]);

    // one predicted + one missed is still not authoring: the mixed red keeps the quality accounting
    expect(classifyScopeOffenders("T2", [hidden, "tests/cockpit/demo.test.ts"], hits).authoring).toBe(false);
  });

  test("test: plan for a task with more predicted collateral paths than twenty prints every path with the direct importers of an owned source first and the total count, while the scope gate's own map for that task is unchanged, so a list that hides the twenty-first path fails", async () => {
    // 10 direct importers (named with z- prefix so alphabetical sort would put them last)
    const directFiles = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `tests/adapters/z-direct-${String(i).padStart(2, "0")}.test.ts`,
        'import "../../src/adapters/codex.js";\n',
      ]),
    );
    // 15 indirect mention files (named with a- prefix so alphabetical sort puts them first)
    const indirectFiles = Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [
        `tests/adapters/a-mention-${String(i).padStart(2, "0")}.test.ts`,
        '// mentions src/adapters/codex in a comment without importing it\n',
      ]),
    );
    const repo = makeRepo({
      "src/adapters/codex.ts": "export const codex = {};\n",
      ...directFiles,
      ...indirectFiles,
      "tests/adapters/unrelated.test.ts": 'import "../../src/adapters/other.js";\n',
    });

    const t = task("T2", ["src/adapters/codex.ts"]);
    const gateMap = collateralHits([t], repo).get("T2") ?? [];
    // Scope gate's own map is unchanged: 25 total, sorted alphabetically (a-mention-00 is first)
    expect(gateMap).toHaveLength(25);
    expect(gateMap[0]).toBe("tests/adapters/a-mention-00.test.ts");

    const [lint] = collateralLints([t], repo);
    expect(lint).toBeDefined();
    expect(lint).toContain("25 total");

    // All 25 paths are printed (including the 21st, 22nd, 23rd, 24th, 25th path)
    for (const p of Object.keys(directFiles)) expect(lint).toContain(p);
    for (const p of Object.keys(indirectFiles)) expect(lint).toContain(p);

    // Direct importers of an owned source are printed FIRST, before indirect mention paths
    const firstDirectIdx = lint.indexOf("tests/adapters/z-direct-00.test.ts");
    const firstIndirectIdx = lint.indexOf("tests/adapters/a-mention-00.test.ts");
    expect(firstDirectIdx).toBeGreaterThan(-1);
    expect(firstIndirectIdx).toBeGreaterThan(-1);
    expect(firstDirectIdx).toBeLessThan(firstIndirectIdx);
  });
});

// v1.53 T4 (OBS-76 signature): T5 files[] held the definition site (config) but not the reader
// (router.ts) its criterion policed — the sweep names the out-of-scope reader before dispatch.
const SRC_FIXTURE = {
  "src/config/config.ts": "export function modeFloor(s: string): string { return s; }\n",
  "src/route/router.ts":
    'import { modeFloor } from "../config/config.js";\nexport const floor = modeFloor("implement");\n',
  "src/adapters/only_here.ts": "export const onlyHere = 1;\n",
  "src/adapters/other.ts": "export const other = 1;\n",
};

const stask = (id: string, files: string[], acceptance: string[]) => ({ id, files, acceptance });

describe("sourceScopeLints (plan-time OBS-76 source sweep)", () => {
  test("a fixture task whose criteria name a symbol read by an out of scope source file yields a lint naming that file", () => {
    const repo = makeRepo(SRC_FIXTURE);
    const lints = sourceScopeLints(
      [stask("T5", ["src/config/config.ts"], ["drop every remaining modeFloor read"])],
      repo,
    );
    expect(lints).toHaveLength(1);
    expect(lints[0]).toContain("T5");
    expect(lints[0]).toContain("src/route/router.ts");
    expect(lints[0]).not.toContain("src/adapters/other.ts");
  });

  test("a task whose criteria implicate no out of scope source yields no source lint", () => {
    const repo = makeRepo(SRC_FIXTURE);
    // prose-only criteria: no code-shaped token, nothing to sweep
    expect(sourceScopeLints([stask("T1", ["src/config/config.ts"], ["the daemon retries once"])], repo)).toEqual([]);
    // symbol referenced only inside the task's own files[]: in-scope reads never lint
    expect(sourceScopeLints([stask("T2", ["src/adapters/only_here.ts"], ["delete the onlyHere flag"])], repo)).toEqual([]);
  });

  test("source lints are capped and sorted deterministically", () => {
    const files = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `src/mod/f${String(i).padStart(2, "0")}.ts`,
        "export const x = () => superWidget();\n",
      ]),
    );
    const repo = makeRepo(files);
    const sweep = () => sourceScopeLints([stask("T9", ["docs/notes.md"], ["remove every superWidget call"])], repo);
    const lints = sweep();
    expect(lints).toHaveLength(1);
    expect(lints[0]).toContain("(capped)");
    expect(lints[0]).toContain("src/mod/f00.ts");
    expect(lints[0]).toContain("src/mod/f19.ts");
    expect(lints[0]).not.toContain("src/mod/f20.ts");
    const listed = lints[0].match(/src\/mod\/f\d+\.ts/g)!;
    expect(listed).toEqual([...listed].sort());
    expect(sweep()).toEqual(lints);
  });

  test("a lint bearing graph still compiles successfully", () => {
    const repo = makeRepo(SRC_FIXTURE);
    const g = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{
        id: "T5", title: "t", goal: "g", shape: "implement", complexity: 3,
        acceptance: ["drop every remaining modeFloor read"], files: ["src/config/config.ts"],
      }],
    });
    // the lint exists AND the graph compiled — advisory output never gates compilation
    expect(sourceScopeLints(g.tasks, repo)).toHaveLength(1);
  });

  test("does not expand files[] — pure sweep, input arrays unchanged", () => {
    const repo = makeRepo(SRC_FIXTURE);
    const files = ["src/config/config.ts"];
    const t = stask("T5", files, ["drop every remaining modeFloor read"]);
    sourceScopeLints([t], repo);
    expect(t.files).toEqual(["src/config/config.ts"]);
  });
});

// v1.67 T5 (OBS-108): a task whose files[] introduces a new top-level src/ directory must also
// include the architecture pages the docs-truth suite pins.
const ARCH_PAGES = ["docs/codebase/ARCHITECTURE.md", "docs/codebase/STRUCTURE.md"];
const EXISTING_DIR_FIXTURE = {
  "src/existing/file.ts": "export const a = 1;\n",
  ...Object.fromEntries(ARCH_PAGES.map((p) => [p, `# ${p}\n`])),
};

describe("newDirectoryLints (plan-time OBS-108 source directory sweep)", () => {
  test("test: the new-top-level-directory lint expands brace groups before deriving directories so a files pattern spanning two existing directories inside one brace group warns for neither while the shipped prefix split reporting a brace fragment as a directory fails", () => {
    const repo = makeRepo({
      ...EXISTING_DIR_FIXTURE,
      "src/another/file.ts": "export const another = 1;\n",
    });

    expect(newDirectoryLints(
      [{ id: "T1", files: ["src/{existing/one.ts,another/two.ts}"] }],
      repo,
    )).toEqual([]);
  });

  test("test: a brace group spanning an existing and a genuinely new top-level directory warns only for the new one named without brace characters while a lint that misses the new directory once braces are involved fails", () => {
    const repo = makeRepo(EXISTING_DIR_FIXTURE);

    const lints = newDirectoryLints(
      [{ id: "T2", files: ["src/{existing/one.ts,newmodule/two.ts}"] }],
      repo,
    );

    expect(lints).toHaveLength(1);
    expect(lints[0]).toContain("new top-level source directory src/newmodule/");
    expect(lints[0]).not.toMatch(/[{}]/);
    expect(lints[0]).not.toContain("src/existing/");
  });

  test("test: a nested brace group and a brace range expand through the same matcher the files scope uses so their warnings name real directories while a one-level comma splitter printing nonsense for nested or range shapes fails", () => {
    const repo = makeRepo(EXISTING_DIR_FIXTURE);

    const lints = newDirectoryLints(
      [{
        id: "T3",
        files: [
          "src/{existing/file.ts,{nested-a/one.ts,nested-b/two.ts}}",
          "src/range{1..3}/file.ts",
        ],
      }],
      repo,
    );

    expect(lints).toHaveLength(1);
    expect(lints[0]).toContain(
      "new top-level source directories src/nested-a/, src/nested-b/, src/range1/, src/range2/, src/range3/",
    );
    expect(lints[0]).not.toMatch(/[{}]/);
    expect(lints[0]).not.toContain("..");
    expect(lints[0]).not.toContain("src/existing/");
  });

  test("test: a punctuation range inside a brace group expands through the same matcher the files scope uses so the pattern src/range{!..#}/file.ts warns for the three expanded directories named without brace characters while a range grammar narrower than that matcher which leaves the group unexpanded and prints the brace fragment as a directory fails", () => {
    const repo = makeRepo(EXISTING_DIR_FIXTURE);

    const lints = newDirectoryLints(
      [{ id: "T4", files: ["src/range{!..#}/file.ts"] }],
      repo,
    );

    expect(lints).toHaveLength(1);
    expect(lints[0]).toContain("new top-level source directories src/range!/, src/range\"/, src/range#/");
    expect(lints[0]).not.toMatch(/[{}]/);
    expect(lints[0]).not.toContain("!..#");
  });

  test("test: an escaped comma inside a brace group binds its member so a two-member group whose first member is foo then an escaped comma then bar and whose second member is baz warns for src/foo,bar/ and src/baz/ and nothing else while a splitter that drops the escaped member or rejects it with its backslash retained fails", () => {
    const repo = makeRepo(EXISTING_DIR_FIXTURE);

    const lints = newDirectoryLints(
      [{ id: "T5", files: ["src/{foo\\,bar,baz}/x.ts"] }],
      repo,
    );

    expect(lints).toHaveLength(1);
    expect(lints[0]).toContain("new top-level source directories src/baz/, src/foo,bar/");
    expect(lints[0]).not.toMatch(/[{}\\]/);
    expect(lints[0]).not.toContain("src/foo/");
    expect(lints[0]).not.toContain("src/bar/");
  });

  test("test: the plan lint flags a task whose file scope introduces a new top-level source directory without the architecture pages", () => {
    const repo = makeRepo(EXISTING_DIR_FIXTURE);
    const lints = newDirectoryLints(
      [{ id: "T1", files: ["src/newmodule/foo.ts"] }],
      repo,
    );
    expect(lints).toHaveLength(1);
    expect(lints[0]).toContain("T1");
    expect(lints[0]).toContain("src/newmodule/");
    expect(lints[0]).toContain("docs/codebase/ARCHITECTURE.md");
    expect(lints[0]).toContain("docs/codebase/STRUCTURE.md");
  });

  test("test: a task touching only existing source directories draws no new-directory lint", () => {
    const repo = makeRepo(EXISTING_DIR_FIXTURE);
    const lints = newDirectoryLints(
      [{ id: "T1", files: ["src/existing/foo.ts"] }],
      repo,
    );
    expect(lints).toEqual([]);
  });

  test("a task introducing a new directory that includes both architecture pages draws no lint", () => {
    const repo = makeRepo(EXISTING_DIR_FIXTURE);
    const lints = newDirectoryLints(
      [{ id: "T1", files: ["src/newmodule/foo.ts", "docs/codebase/ARCHITECTURE.md", "docs/codebase/STRUCTURE.md"] }],
      repo,
    );
    expect(lints).toEqual([]);
  });

  test("a glob covering the architecture pages satisfies the lint", () => {
    const repo = makeRepo(EXISTING_DIR_FIXTURE);
    const lints = newDirectoryLints(
      [{ id: "T1", files: ["src/newmodule/foo.ts", "docs/codebase/*.md"] }],
      repo,
    );
    expect(lints).toEqual([]);
  });

  test("both additions are advisory surfaces that change no dispatch gate or task state", () => {
    const repo = makeRepo(EXISTING_DIR_FIXTURE);
    const files = ["src/newmodule/foo.ts"];
    const t = { id: "T1", files };
    newDirectoryLints([t], repo);
    expect(t.files).toEqual(["src/newmodule/foo.ts"]);
    expect(files).toEqual(["src/newmodule/foo.ts"]);
  });
});
