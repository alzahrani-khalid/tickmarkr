import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CompileError } from "../../src/compile/common.js";
import { compileSource } from "../../src/compile/index.js";
import { compilePrd } from "../../src/compile/prd.js";

describe("compilePrd", () => {
  test("matches the unfixed-HEAD PRD goldens byte-for-byte", () => {
    const current = {
      sample: compileSource("fixtures/sample.prd.md"),
      pin: compileSource("fixtures/sample-pin.prd.md"),
    };
    const golden = JSON.parse(readFileSync("tests/fixtures/prd-golden.json", "utf8"));
    expect(current).toEqual(golden);
  });

  test("parses the fixture: fields, deps, humanGate, inferred shape", () => {
    const g = compilePrd("fixtures/sample.prd.md");
    expect(g.spec.source).toBe("prd");
    expect(g.tasks.map((t) => t.id)).toEqual(["T1", "T2", "T3"]);
    const [t1, t2, t3] = g.tasks;
    expect(t1).toMatchObject({ shape: "implement", complexity: 3, files: ["src/**"] });
    expect(t1.acceptance).toHaveLength(2);
    expect(t2.deps).toEqual(["T1"]);
    expect(t2.shape).toBe("tests"); // inferred from "Cover greet with tests"
    expect(t3.humanGate).toBe(true);
    expect(t3.shape).toBe("docs"); // inferred from "Document usage in README"? → "docs" via /\bdocs?\b|documentation/
  });

  test("pin maps to routingHints", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-prd-"));
    const f = join(dir, "p.md");
    writeFileSync(f, "## T1: A pinned migration task\n- shape: migration\n- pin: claude-code fable\n- acceptance:\n  - schema updated\n");
    expect(compilePrd(f).tasks[0].routingHints?.pin).toEqual({ via: "claude-code", model: "fable" });
  });

  test("missing acceptance / unknown dep fail loudly with task ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-prd-"));
    const f = join(dir, "bad.md");
    writeFileSync(f, "## T1: No acceptance here\n- shape: chore\n");
    expect(() => compilePrd(f)).toThrow(CompileError);
    expect(() => compilePrd(f)).toThrow(/T1/);
    writeFileSync(f, "## T1: Fine\n- deps: T9\n- acceptance:\n  - ok\n");
    expect(() => compilePrd(f)).toThrow(/unknown task T9/);
  });
});

describe("compileSource detection", () => {
  test("dir with tasks.md → speckit; marked .md → native; marker-less .md → prd; else error", () => {
    expect(compileSource("fixtures/speckit-sample").spec.source).toBe("speckit");
    const nativeFile = join(mkdtempSync(join(tmpdir(), "tickmarkr-prd-detect-")), "native.md");
    writeFileSync(nativeFile, "<!-- tickmarkr:spec -->\n## T1: Native\n- acceptance:\n  - ok\n");
    expect(compileSource(nativeFile).spec.source).toBe("native");
    expect(compileSource("fixtures/sample.prd.md").spec.source).toBe("prd");
    expect(() => compileSource("package.json")).toThrow(CompileError);
    expect(compileSource("fixtures/sample.prd.md", "prd").spec.source).toBe("prd"); // explicit type respected
  });
});
