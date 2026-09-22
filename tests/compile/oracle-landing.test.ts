import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CompileError } from "../../src/compile/common.js";
import { compileNative } from "../../src/compile/native.js";
import { graphPath, loadGraph, saveGraph } from "../../src/graph/graph.js";

const TITLE = "the parser keeps the leaf | suite: is not part of me";

function compileSpec(landing: string) {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-landing-"));
  const file = join(dir, "spec.md");
  writeFileSync(
    file,
    `<!-- tickmarkr:spec -->\n## T1: Landing task\n- goal: land a test\n- files: src/x.ts, tests/x.test.ts\n- acceptance:\n  - test: ${TITLE} | suite: ${landing}\n`,
  );
  return { dir, graph: compileNative(file) };
}

describe("test criterion landing suite (OBS-1064, T8)", () => {
  test("a native test criterion declaring its landing suite compiles into a graph item that keeps the landing after a save then a reload whose title equals the authored leaf byte for byte, so landing syntax absorbed into the title fails", () => {
    const { dir, graph } = compileSpec("tests/x.test.ts");
    const item = graph.tasks[0].acceptance[0];
    expect(item).toEqual({ oracle: "test", test: TITLE, landing: "tests/x.test.ts" });
    saveGraph(dir, graph);
    const reloaded = loadGraph(dir).tasks[0].acceptance[0];
    expect(reloaded).toEqual({ oracle: "test", test: TITLE, landing: "tests/x.test.ts" });
    expect(graphPath(dir)).toContain(dir);
  });

  test("a landing naming a path outside the collectable test glob refuses the compile naming the task plus the item, so a landing no runner could collect compiled as valid fails", () => {
    expect(() => compileSpec("src/x.spec.ts")).toThrow(CompileError);
    expect(() => compileSpec("src/x.spec.ts")).toThrow(/T1.*item 1.*src\/x\.spec\.ts.*tests\/\*\*\/\*\.test\.ts/s);
  });
});
