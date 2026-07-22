import { describe, expect, test } from "vitest";
import { collateralLints, newDirectoryLints, sourceScopeLints } from "../../src/compile/collateral.js";
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
