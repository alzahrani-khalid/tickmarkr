import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CompileError } from "../../src/compile/common.js";
import { compileNative, specTemplate } from "../../src/compile/native.js";
import { loadGraph, saveGraph } from "../../src/graph/graph.js";
import { RunGraphSchema, validateGraph } from "../../src/graph/schema.js";
import { z } from "zod";

const compile = (pins: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "tickmarkr-pins-")), "spec.md");
  writeFileSync(file, `<!-- tickmarkr:spec -->\n## T3: Retire a name\n- files: src/a.ts\n- pins:\n${pins}- acceptance:\n  - judge: the name is retired\n`);
  return compileNative(file);
};
const LITERAL = { kind: "literal", text: "old | name", glob: "tests/**/*.test.ts" };
const FIXTURE = { kind: "fixture", paths: ["fixtures/golden/**", "tests/snap/out.txt"] };
const BOTH = "  - literal: old | name | glob: tests/**/*.test.ts\n  - fixture: fixtures/golden/**, tests/snap/out.txt\n";

describe("pin declarations (v2.5.8 T7, input path)", () => {
  test("a native spec declaring one retired literal plus one fixture pin compiles into a graph whose task keeps both declarations after a save then a reload, so a declaration stripped at validation fails", () => {
    const graph = compile(BOTH);
    expect(graph.tasks[0].pins).toEqual([LITERAL, FIXTURE]);
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-pins-repo-"));
    saveGraph(repo, graph);
    expect(loadGraph(repo).tasks[0].pins).toEqual([LITERAL, FIXTURE]);
  });

  test("a literal pin missing its text or its search glob and a fixture pin missing its path set each refuse the compile naming the item whereas a fixture pin carrying no literal text compiles, so rejecting a valid fixture only declaration fails", () => {
    const refusals: Array<[string, RegExp]> = [
      ["  - literal: | glob: src/**\n", /item 1 .*missing its text/],
      ["  - fixture: fixtures/a.txt\n  - literal: oldName\n", /item 2 .*oldName.*missing its search glob/],
      ["  - fixture:\n", /item 1 .*missing its path set/],
    ];
    for (const [pins, message] of refusals) {
      let error: unknown;
      try { compile(pins); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(CompileError);
      expect((error as Error).message).toMatch(/T3/);
      expect((error as Error).message).toMatch(message);
    }
    expect(compile("  - fixture: fixtures/a.txt\n").tasks[0].pins).toEqual([{ kind: "fixture", paths: ["fixtures/a.txt"] }]);
  });

  test("the generated graph schema file admits the declared pins field exactly as the validator does, so a shipped schema that rejects a graph the validator accepts fails", () => {
    const shipped = JSON.parse(readFileSync("schema/rungraph.schema.json", "utf8"));
    const { $comment: _c, ...shippedBody } = shipped;
    // the shipped file is byte-for-byte what the validator's own zod schema emits today…
    expect(shippedBody).toEqual(z.toJSONSchema(RunGraphSchema, { io: "input", unrepresentable: "any" }));
    // …and it admits/refuses the same pins the validator does.
    const fromShipped = z.fromJSONSchema(shipped);
    const graphWith = (pins: unknown) => ({
      version: 1,
      spec: { source: "native", paths: ["s.md"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 1, acceptance: ["x"], pins }],
    });
    const accepts = (pins: unknown) => { try { validateGraph(graphWith(pins)); return true; } catch { return false; } };
    for (const pins of [[LITERAL, FIXTURE], [FIXTURE], [{ kind: "literal", text: "x" }], [{ kind: "fixture", paths: [] }], [{ kind: "other" }]]) {
      expect(fromShipped.safeParse(graphWith(pins)).success, JSON.stringify(pins)).toBe(accepts(pins));
    }
    expect(accepts([LITERAL, FIXTURE])).toBe(true);
    expect(accepts([{ kind: "literal", text: "x" }])).toBe(false);
  });

  test("a fixture path ending in a parenthesised segment survives compile and reload unchanged", () => {
    const graph = compile("  - fixture: fixtures/output (old), tests/snap/none\n");
    const pins = [{ kind: "fixture", paths: ["fixtures/output (old)", "tests/snap/none"] }];
    expect(graph.tasks[0].pins).toEqual(pins);
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-pins-repo-"));
    saveGraph(repo, graph);
    expect(loadGraph(repo).tasks[0].pins).toEqual(pins);
  });

  test("the spec template documents the pins field beside the limited-authoring-contract law", () => {
    expect(specTemplate()).toMatch(/pins:[\s\S]*LIMITED AUTHORING CONTRACT, not an assertion analyzer/);
  });
});
