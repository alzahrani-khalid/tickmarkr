import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { renderSourceScopeFinding, sourceScopeFindings } from "../../src/compile/collateral.js";
import { compileSource } from "../../src/compile/index.js";
import { compile, nativeSourceScopeErrors } from "../../src/cli/commands/compile.js";
import { graphPath, loadGraph } from "../../src/graph/graph.js";
import { acquireRunLock, isRunLockLive, releaseRunLock } from "../../src/run/lock.js";
import { makeRepo } from "../helpers/tmprepo.js";

const VALID_SPEC = `# Dry compile fixture

## T1: Update widget behavior
- goal: Keep the widget behavior observable.
- shape: implement
- complexity: 3
- files: src/widget.ts
- acceptance:
  - widgetValue remains observable through sharedHelper
  - tests cover the widget behavior
`;

const INVALID_SPEC = `# Invalid dry compile fixture

## T1: One task beyond several compile bounds
- goal: Split this task before a worker receives it.
- shape: implement
- complexity: 3
- files: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts, src/g.ts, src/h.ts, src/i.ts
- acceptance:
  - criterion one
  - criterion two
  - criterion three
  - criterion four
  - criterion five
  - criterion six
  - criterion seven
`;

function compileRepo(spec = VALID_SPEC): string {
  return makeRepo({
    "feature.prd.md": spec,
    "src/widget.ts": "export const widgetValue = () => sharedHelper();\n",
    "src/helper-a.ts": "export const sharedHelper = () => 'a';\n",
    "src/helper-b.ts": "export const sharedHelper = () => 'b';\n",
    "tests/widget.test.ts": "import { widgetValue } from '../src/widget.js';\nvoid widgetValue;\n",
  });
}

function taskCount(output: string): string {
  return output.match(/\((\d+) tasks,/)?.[1] ?? "missing task count";
}

function diagnostics(output: string): string[] {
  const marker = "\nscope lints:\n";
  const start = output.indexOf(marker);
  return start === -1 ? [] : output.slice(start + marker.length).split("\n");
}

async function failure(argv: string[], repo: string): Promise<string> {
  try {
    await compile(argv, repo);
    return "compile unexpectedly succeeded";
  } catch (error) {
    return (error as Error).message;
  }
}

function nativeSpec(mode = "", goal = "Compile one native task."): string {
  return `<!-- tickmarkr:spec -->\n${mode}## T1: Native task\n- goal: ${goal}\n- shape: implement\n- complexity: 2\n- files: src/owned.ts\n- acceptance:\n  - judge: Native task holds\n`;
}

describe("compile --dry-run", () => {
  test("a dry compile of a valid spec reports the same task count and the same diagnostics as a real compile of that spec, with the graph file byte-identical before and after", async () => {
    const repo = compileRepo();
    const real = await compile(["feature.prd.md"], repo);
    const before = readFileSync(graphPath(repo));

    const dry = await compile(["feature.prd.md", "--dry-run"], repo);
    const after = readFileSync(graphPath(repo));

    expect(taskCount(dry)).toBe(taskCount(real));
    expect(diagnostics(dry)).toEqual(diagnostics(real));
    expect(diagnostics(dry)).toEqual(expect.arrayContaining([
      expect.stringContaining("likely collateral tests not in files[]: tests/widget.test.ts"),
      expect.stringContaining("criteria implicate out-of-scope source not in files[]: src/helper-a.ts, src/helper-b.ts"),
    ]));
    expect(after.equals(before)).toBe(true);
  });

  test("a dry compile of a spec that violates a compile bound reports the same violations a real compile reports, and still writes nothing", async () => {
    const repo = compileRepo();
    await compile(["feature.prd.md"], repo);
    const before = readFileSync(graphPath(repo));
    writeFileSync(join(repo, "invalid.prd.md"), INVALID_SPEC);

    const dryError = await failure(["invalid.prd.md", "--dry-run"], repo);
    const afterDry = readFileSync(graphPath(repo));
    const realError = await failure(["invalid.prd.md"], repo);

    expect(dryError).toBe(realError);
    expect(dryError).toContain("violates the task unit contract (3 errors)");
    expect(dryError).toContain("declares 7 acceptance items (max 6)");
    expect(dryError).toContain("declares 9 files[] patterns (max 8)");
    expect(dryError).toContain("acceptance×files surface of 63");
    expect(afterDry.equals(before)).toBe(true);
  });

  test("a dry compile completes while the run lock is held, proving a live run no longer makes spec validation impossible", async () => {
    const repo = compileRepo();
    acquireRunLock(repo, "run-live");
    try {
      expect(isRunLockLive(repo)).toBe(true);
      const output = await compile(["feature.prd.md", "--dry-run"], repo);
      expect(output).toContain("(1 tasks,");
      expect(isRunLockLive(repo)).toBe(true);
      expect(existsSync(graphPath(repo))).toBe(false);
    } finally {
      releaseRunLock(repo);
    }
  });

  test("a held run lock cannot replace an authoring refusal with lock diagnostics", async () => {
    const repo = compileRepo(INVALID_SPEC);
    acquireRunLock(repo, "run-live");
    try {
      const message = await failure(["feature.prd.md"], repo);
      expect(message).toContain("violates the task unit contract (3 errors)");
      expect(message).not.toContain("graph.lock held by pid");
      expect(isRunLockLive(repo)).toBe(true);
      expect(existsSync(graphPath(repo))).toBe(false);
    } finally {
      releaseRunLock(repo);
    }
  });

  test("test: a spec front-matter mode that differs from the routing.mode written in the repository's config overlay fails compile naming both modes and the mode-override line while the same spec with mode-override true or a repository whose overlay writes no mode compiles whereas a compiler that accepts the disagreement silently fails", async () => {
    const repo = makeRepo({ "src/owned.ts": "export const owned = true;\n", "feature.spec.md": nativeSpec("mode: staff-led\n") });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "routing:\n  mode: partner-led\n");

    await expect(compile(["feature.spec.md"], repo)).rejects.toThrow(/staff-led[\s\S]*partner-led[\s\S]*mode-override: true/);

    writeFileSync(join(repo, "feature.spec.md"), nativeSpec("mode: staff-led\nmode-override: true\n"));
    await expect(compile(["feature.spec.md", "--dry-run"], repo)).resolves.toContain("validated feature.spec.md");

    const noMode = makeRepo({ "src/owned.ts": "export const owned = true;\n", "feature.spec.md": nativeSpec("mode: staff-led\n") });
    mkdirSync(join(noMode, ".tickmarkr"), { recursive: true });
    writeFileSync(join(noMode, ".tickmarkr", "config.yaml"), "routing:\n  learned: off\n");
    await expect(compile(["feature.spec.md", "--dry-run"], noMode)).resolves.toContain("validated feature.spec.md");
  });

  test("test: a config.yaml that does not parse refuses compile naming the parse error while a config with no routing mode compiles whereas a compiler that treats the unreadable overlay as absent fails", async () => {
    const repo = makeRepo({
      "src/owned.ts": "export const owned = true;\n",
      "feature.spec.md": nativeSpec(),
    });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "routing: [\n");

    await expect(compile(["feature.spec.md", "--dry-run"], repo))
      .rejects.toThrow(/config\.yaml does not parse[\s\S]*Flow sequence[\s\S]*line \d+/);
    expect(existsSync(graphPath(repo))).toBe(false);

    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "review:\n  required: false\n");
    await expect(compile(["feature.spec.md", "--dry-run"], repo)).resolves.toContain("validated feature.spec.md");
  });

  test("test: a native task whose criteria implicate a source file outside its files patterns fails compile naming the path unless the task's goal carries scope-waiver naming that path in which case the advisory line still prints and the compile succeeds while a PRD source keeps the advisory line and compiles whereas a compiler that prints the implication for a native task and writes the graph fails", async () => {
    const repo = makeRepo({
      "src/owned.ts": "export const owned = true;\n",
      "src/other.ts": "export const other = 'RiskySymbol mention only';\n",
      "feature.spec.md": nativeSpec("", "Compile one native task."),
      "feature.prd.md": nativeSpec("", "Compile one PRD task.").replace("<!-- tickmarkr:spec -->\n", ""),
    });
    const criterion = "  - judge: RiskySymbol remains observable\n";
    const spec = (goal: string) => `<!-- tickmarkr:spec -->\n## T1: Native task\n- goal: ${goal}\n- shape: implement\n- complexity: 2\n- files: src/owned.ts\n- acceptance:\n${criterion}`;
    writeFileSync(join(repo, "feature.spec.md"), spec("Compile one native task."));
    writeFileSync(join(repo, "feature.prd.md"), spec("Compile one PRD task.").replace("<!-- tickmarkr:spec -->\n", ""));

    await expect(compile(["feature.spec.md", "--dry-run"], repo)).rejects.toThrow(/src\/other\.ts[\s\S]*scope-waiver: src\/other\.ts/);
    expect(existsSync(graphPath(repo))).toBe(false);

    writeFileSync(join(repo, "feature.spec.md"), spec("Compile one native task. scope-waiver: src/other.ts"));
    const native = await compile(["feature.spec.md", "--dry-run"], repo);
    expect(native).toContain("criteria implicate out-of-scope source not in files[]: src/other.ts");

    const prd = await compile(["feature.prd.md", "--dry-run"], repo);
    expect(prd).toContain("criteria implicate out-of-scope source not in files[]: src/other.ts");
  });

  test("test: the native source-scope errors are derived from structured lint results so a lint whose rendered string changes shape still refuses the unwaived native task whereas an error path that reverse-parses the rendered string passes the drifted shape", async () => {
    const repo = makeRepo({
      "src/owned.ts": "export const owned = true;\n",
      "src/other.ts": "export const note = 'RiskySymbol is observed here';\n",
      "feature.spec.md": nativeSpec("", "Compile one unwaived native task.")
        .replace("Native task holds", "RiskySymbol remains observable"),
    });
    const graph = compileSource(join(repo, "feature.spec.md"), "native", repo);
    const findings = sourceScopeFindings(graph.tasks, repo);
    expect(findings).toEqual([{ taskId: "T1", paths: ["src/other.ts"] }]);

    const drifted = renderSourceScopeFinding(findings[0]!)
      .replace("criteria implicate out-of-scope source not in files[]:", "source-scope format v2 =>");
    const legacyReverseParse = (line: string) =>
      line.match(/^(\S+): criteria implicate out-of-scope source not in files\[\]: (.*)$/);
    expect(legacyReverseParse(drifted)).toBeNull();
    expect(nativeSourceScopeErrors(graph, findings)).toEqual([
      "T1: src/other.ts requires scope-waiver: src/other.ts in the task goal",
    ]);
    await expect(compile(["feature.spec.md", "--dry-run"], repo))
      .rejects.toThrow(/unwaived native source-scope[\s\S]*src\/other\.ts/);
  });

  test("test: compile --strict turns every authoring-lint finding into a compile error naming its code while the same spec without the flag warns and writes the graph whereas a strict compile that still writes the graph over a finding fails", async () => {
    const repo = makeRepo({
      "src/owned.ts": "export const owned = true;\n",
      "strict.spec.md": "<!-- tickmarkr:spec -->\n## T1: Strict lint\n- goal: Compile one linted native task.\n- shape: implement\n- complexity: 2\n- files: src/owned.ts\n- acceptance:\n  - judge: behavior holds per the audit\n",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(compile(["strict.spec.md"], repo)).resolves.toContain("compiled strict.spec.md");
      expect(warn.mock.calls.flat().join("\n")).toContain("authoring-lint[external-referent]");
    } finally {
      warn.mockRestore();
    }
    const before = readFileSync(graphPath(repo));

    await expect(compile(["strict.spec.md", "--strict"], repo)).rejects.toThrow(/authoring-lint\[external-referent]/);
    expect(readFileSync(graphPath(repo)).equals(before)).toBe(true);
  });

  test("a compile without the flag still writes the graph and still takes the lock, so the default path is unweakened", async () => {
    const repo = compileRepo();
    acquireRunLock(repo, "run-live");
    try {
      await expect(compile(["feature.prd.md"], repo)).rejects.toThrow(/graph\.lock held by pid/);
      expect(existsSync(graphPath(repo))).toBe(false);
    } finally {
      releaseRunLock(repo);
    }

    await compile(["feature.prd.md"], repo);
    expect(loadGraph(repo).tasks).toHaveLength(1);
  });
});
