import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { compile } from "../../src/cli/commands/compile.js";
import { graphPath } from "../../src/graph/graph.js";
import { makeRepo } from "../helpers/tmprepo.js";

const task = (id: string, files: string, pins = "") =>
  `## ${id}: Task ${id}\n- goal: Retire a name.\n- shape: implement\n- complexity: 2\n- files: ${files}\n${pins}- acceptance:\n  - judge: ${id} holds\n`;

const spec = (t1Files: string, t2Files: string, pins: string) =>
  `<!-- tickmarkr:spec -->\n${task("T1", t1Files)}${task("T2", t2Files, pins)}`;

const repoWith = (body: string) => makeRepo({
  "feature.spec.md": body,
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "export const b = 1;\n",
  "fixtures/golden/out.txt": "line one\nprints oldName\n",
});

async function refusal(argv: string[], repo: string): Promise<string> {
  try {
    await compile(argv, repo);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

describe("compile seal over declared pins (v2.5.8 T14)", () => {
  test("compile refuses the seal when a declared literal still appears in a file outside the changing task's files whereas the same spec compiles once that task owns the file, so ownership by a sibling task that merely precedes it fails", async () => {
    const pins = "- pins:\n  - literal: oldName | glob: fixtures/**\n";
    // T1 precedes T2 and owns the fixture; T2 is the changing task and does not.
    const repo = repoWith(spec("src/a.ts, fixtures/golden/out.txt", "src/b.ts", pins));
    const message = await refusal(["feature.spec.md"], repo);
    expect(message).toContain("uncovered declared pin obligations");
    expect(message).toContain('"oldName"');
    expect(message).toContain("fixtures/golden/out.txt:2");
    expect(message).toContain("owned by T1");
    expect(existsSync(graphPath(repo))).toBe(false);
    expect(await refusal(["feature.spec.md", "--dry-run"], repo)).toBe(message);

    const owned = repoWith(spec("src/a.ts", "src/b.ts, fixtures/golden/out.txt", pins));
    expect(await compile(["feature.spec.md"], owned)).toContain("compiled feature.spec.md");
    expect(existsSync(graphPath(owned))).toBe(true);
  });

  test("compile refuses the seal when a fixture pin matches a file outside the changing task's files whereas the same spec compiles once that task owns it, so a scanner that ignores fixture only declarations fails", async () => {
    const pins = "- pins:\n  - fixture: fixtures/golden/**\n";
    const repo = repoWith(spec("src/a.ts", "src/b.ts", pins));
    const message = await refusal(["feature.spec.md"], repo);
    expect(message).toContain("fixture pin fixtures/golden/**");
    expect(message).toContain("fixtures/golden/out.txt");
    expect(message).toContain("owned by no task");
    expect(existsSync(graphPath(repo))).toBe(false);

    const owned = repoWith(spec("src/a.ts", "src/b.ts, fixtures/golden/**", pins));
    expect(await compile(["feature.spec.md"], owned)).toContain("compiled feature.spec.md");
  });
});
