import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../../src/cli/commands/compile.js";
import { collateralHits, sourceScopeFindings, sourceScopeLints } from "../../src/compile/collateral.js";
import { CompileError } from "../../src/compile/common.js";
import { graphPath } from "../../src/graph/graph.js";
import { makeRepo, makeTestTempDir, quietGitInit } from "../helpers/tmprepo.js";

const task = { id: "T1", files: ["src/widget.ts"] };
const mention = '// src/widget.ts\n';

function write(repo: string, path: string, body: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}

function spec(criterion: string, goal = "Update the widget behavior."): string {
  return `<!-- tickmarkr:spec -->
## T1: Update widget
- goal: ${goal}
- shape: implement
- complexity: 2
- files: src/widget.ts
- acceptance:
  - judge: ${criterion}
`;
}

async function refusal(repo: string): Promise<Error> {
  try {
    await compile(["feature.spec.md", "--dry-run"], repo);
  } catch (error) {
    expect(error).toBeInstanceOf(CompileError);
    return error as Error;
  }
  throw new Error("compile unexpectedly succeeded");
}

test("test: the collateral prediction over a repository holding more than four hundred test files predicts a test that mentions the task's source and sorts after the four hundredth, while none of the many files that never mention it is predicted, so a capped walk or one that predicts every walked file fails", () => {
  const repo = makeRepo({ "src/widget.ts": "export const widget = true;\n", "tests/a-early.test.ts": mention });
  expect(collateralHits([task], repo).get("T1")).toEqual(["tests/a-early.test.ts"]);
  for (let i = 0; i < 483; i++) {
    write(repo, `tests/f${String(i).padStart(3, "0")}.test.ts`, "export const unrelated = true;\n");
  }
  write(repo, "tests/zz-late.test.ts", mention);
  expect(collateralHits([task], repo).get("T1")).toEqual(["tests/a-early.test.ts", "tests/zz-late.test.ts"]);
  write(repo, "tests/a-early.test.ts", "// unrelated\n");
  expect(collateralHits([task], repo).get("T1")).toEqual(["tests/zz-late.test.ts"]);
  write(repo, "tests/zz-late.test.ts", "// unrelated\n");
  expect(collateralHits([task], repo).size).toBe(0);
});

test("test: the compile command over a native spec whose criterion names a symbol found only in the source file sorting after the four hundredth refuses naming that file unless the goal waives it, while the same tree without that symbol compiles, so a source-scope walk that stops early fails", async () => {
  const criterion = "lateScopeToken remains observable";
  const path = "src/zz-late.ts";
  const repo = makeRepo({ "src/widget.ts": "export const widget = true;\n", "feature.spec.md": spec(criterion) });
  for (let i = 0; i < 401; i++) {
    write(repo, `src/f${String(i).padStart(3, "0")}.ts`, "export const unrelated = true;\n");
  }
  write(repo, path, '// lateScopeToken\n');
  const error = await refusal(repo);
  expect(error.message).toContain("unwaived native source-scope");
  expect(error.message).toContain(`${path} requires scope-waiver: ${path}`);
  expect(existsSync(graphPath(repo))).toBe(false);

  write(repo, "feature.spec.md", spec(criterion, `Update the widget. scope-waiver: ${path}`));
  await expect(compile(["feature.spec.md"], repo)).resolves.toContain("compiled feature.spec.md");
  write(repo, "feature.spec.md", spec(criterion));
  write(repo, path, "// unrelated\n");
  await expect(compile(["feature.spec.md", "--dry-run"], repo)).resolves.toContain("validated feature.spec.md");
});

test("test: a test larger than half a mebibyte that mentions the task's source is predicted, and the compile command refuses a criterion symbol found only in a source file larger than half a mebibyte unless the goal waives it, so a walk that skips large files fails", async () => {
  const padding = `// ${"x".repeat(512 * 1024)}\n`;
  const criterion = "largeScopeToken remains observable";
  const path = "src/large.ts";
  const repo = makeRepo({
    "src/widget.ts": "export const widget = true;\n",
    [path]: `${padding}// largeScopeToken\n`,
    "tests/large.test.ts": `${padding}${mention}`,
    "tests/unrelated.test.ts": padding,
    "feature.spec.md": spec(criterion),
  });
  expect(collateralHits([task], repo).get("T1")).toEqual(["tests/large.test.ts"]);
  expect((await refusal(repo)).message).toContain(`${path} requires scope-waiver: ${path}`);
  write(repo, "feature.spec.md", spec(criterion, `Update the widget. scope-waiver: ${path}`));
  await expect(compile(["feature.spec.md", "--dry-run"], repo)).resolves.toContain("validated feature.spec.md");
  write(repo, path, padding);
  write(repo, "feature.spec.md", spec(criterion));
  await expect(compile(["feature.spec.md", "--dry-run"], repo)).resolves.toContain("validated feature.spec.md");
});

async function withGit(body: string, run: (bin: string) => Promise<void>): Promise<void> {
  const bin = makeTestTempDir("corpus-git-");
  const git = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const standIn = join(bin, "git");
  writeFileSync(standIn, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "grep") {
  ${body}
} else {
  const result = spawnSync(${JSON.stringify(git)}, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`);
  chmodSync(standIn, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${saved ?? ""}`;
  try { await run(bin); }
  finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

test("test: the compile command over a native spec that needs the test corpus refuses naming the corpus read when git is killed by a signal or overflows its output, while a repository with no test files at its head compiles, so an empty corpus cached in silence fails", async () => {
  for (const [body, reason] of [
    ['process.kill(process.pid, "SIGKILL");', "SIGKILL"],
    ['const chunk = Buffer.alloc(1024 * 1024, "x"); for (;;) require("node:fs").writeSync(1, chunk);', "ENOBUFS"],
  ]) {
    const repo = makeRepo({
      "src/widget.ts": "export const widget = true;\n",
      "tests/corpus.test.ts": '// corpus is present\n',
      "feature.spec.md": spec("the output displays `27%`"),
    });
    await withGit(body, async () => {
      const error = await refusal(repo);
      expect(error.message).toContain("test corpus read");
      expect(error.message).toContain("git grep HEAD tests");
      expect(error.message).toContain(reason);
      expect(existsSync(graphPath(repo))).toBe(false);
      if (reason === "SIGKILL") expect((await refusal(repo)).message).toContain(reason);
    });
    await expect(compile(["feature.spec.md", "--dry-run"], repo)).resolves.toContain("validated feature.spec.md");
  }
  const empty = makeRepo({ "src/widget.ts": "export const widget = true;\n", "feature.spec.md": spec("the output displays `27%`") });
  await expect(compile(["feature.spec.md", "--dry-run"], empty)).resolves.toContain("validated feature.spec.md");
});

test("test: the collateral prediction never walks files under the installed packages folder, the git directory or a hidden directory, and a repository with no tests directory yields an empty prediction without an error, so a walker that follows those trees or throws on a missing root fails", () => {
  const repo = makeRepo({ "src/widget.ts": "export const widget = true;\n", "tests/visible.test.ts": mention });
  for (const directory of ["node_modules", ".git", ".hidden", "nested/node_modules", "nested/.git", "nested/.hidden"]) {
    write(repo, `tests/${directory}/excluded.test.ts`, mention);
    write(repo, `src/${directory}/excluded.ts`, "// excludedToken\n");
  }
  write(repo, "tests/.hidden.test.ts", mention);
  expect(collateralHits([task], repo).get("T1")).toEqual(["tests/visible.test.ts"]);
  expect(sourceScopeFindings([{ ...task, acceptance: ["excludedToken remains observable"] }], repo)).toEqual([]);
  const missing = makeRepo({ "src/widget.ts": "export const widget = true;\n" });
  expect(collateralHits([task], missing)).toEqual(new Map());
});

test("queue row 27 D-2134: unreadable source stays unwaivable while advisory scans skip it", async () => {
  const criterion = "lockedScopeToken remains observable";
  const repo = makeRepo({
    "src/widget.ts": "export const widget = true;\n",
    "src/locked.ts": "// lockedScopeToken\n",
    "tests/locked.test.ts": mention,
    "feature.spec.md": spec(criterion, "Update the widget. scope-waiver: src/locked.ts"),
  });
  const scoped = [{ ...task, files: [...task.files, "docs/codebase/ARCHITECTURE.md", "docs/codebase/STRUCTURE.md"], acceptance: [criterion] }];
  chmodSync(join(repo, "src/locked.ts"), 0o000);
  chmodSync(join(repo, "tests/locked.test.ts"), 0o000);
  try {
    expect(sourceScopeLints(scoped, repo)).toEqual([]);
    expect(collateralHits([task], repo).size).toBe(0);
    expect(() => sourceScopeFindings(scoped, repo, { failClosed: true })).toThrow(/src\/locked\.ts is unreadable/);
    const error = await refusal(repo);
    expect(error.message).toContain("src/locked.ts");
    expect(error.message).toContain("unreadable");
    expect(error.message).toContain("symbol-ownership");
  } finally {
    chmodSync(join(repo, "src/locked.ts"), 0o644);
    chmodSync(join(repo, "tests/locked.test.ts"), 0o644);
  }
});

test("queue row 27 D-2134: an unfinished spawn refuses the corpus read and completed git errors keep the empty corpus", async () => {
  const fixture = { "src/widget.ts": "export const widget = true;\n", "feature.spec.md": spec("the output displays `27%`") };
  const failed = makeRepo(fixture);
  await withGit("process.exit(2);", async (bin) => {
    chmodSync(join(bin, "git"), 0o644);
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      const error = await refusal(failed);
      expect(error.message).toContain("test corpus read");
      expect(error.message).toMatch(/EACCES|ENOENT/);
    } finally {
      process.env.PATH = saved;
      chmodSync(join(bin, "git"), 0o755);
    }
  });
  const completed = makeRepo(fixture);
  await withGit("process.exit(2);", async () => {
    await expect(compile(["feature.spec.md", "--dry-run"], completed)).resolves.toContain("validated feature.spec.md");
  });
  const unborn = makeTestTempDir("corpus-unborn-");
  quietGitInit(unborn);
  for (const [path, body] of Object.entries(fixture)) write(unborn, path, body);
  await expect(compile(["feature.spec.md", "--dry-run"], unborn)).resolves.toContain("validated feature.spec.md");
});
