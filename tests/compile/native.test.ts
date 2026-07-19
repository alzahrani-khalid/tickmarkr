import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CompileError } from "../../src/compile/common.js";
import { compileSource } from "../../src/compile/index.js";
import { TICKMARKR_NATIVE_MARKER, specTemplate } from "../../src/compile/native.js";
import { GraphValidationError, validateGraph } from "../../src/graph/schema.js";

function compileNativeText(body: string, marker = "tickmarkr") {
  const file = join(mkdtempSync(join(tmpdir(), "tickmarkr-native-")), "spec.md");
  writeFileSync(file, `<!-- ${marker}:spec -->\n${body}`);
  return compileSource(file, "native");
}

function expectFieldError(field: string, source: string) {
  try {
    compileNativeText(`## T7: Broken task\n${source}\n- acceptance:\n  - still required\n`);
    expect.unreachable("should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(CompileError);
    expect((error as Error).message).toMatch(/T7/);
    expect((error as Error).message).toMatch(new RegExp(field, "i"));
  }
}

describe("native spec template round-trip", () => {
  test("specTemplate() compiles via auto-detection as native with ≥2 tasks, all acceptance non-empty", () => {
    const file = join(mkdtempSync(join(tmpdir(), "tickmarkr-template-")), "tickmarkr.spec.md");
    writeFileSync(file, specTemplate());
    expect(specTemplate()).toMatch(/^<!-- tickmarkr:spec -->/);
    const graph = compileSource(file); // no type → auto-detect must pick native via the marker
    expect(graph.spec.source).toBe("native");
    expect(graph.tasks.length).toBeGreaterThanOrEqual(2);
    for (const t of graph.tasks) expect(t.acceptance.length).toBeGreaterThan(0);
  });
});

describe("native spec marker (v1.38)", () => {
  test("a spec bearing only the legacy marker is not auto-detected as native", () => {
    const legacyMarker = `<!-- ${["dro", "vr"].join("")}:spec -->`;
    const file = join(mkdtempSync(join(tmpdir(), "tickmarkr-legacy-marker-")), "spec.md");
    writeFileSync(file, `${legacyMarker}\n## T1: Legacy\n- acceptance:\n  - x\n`);
    expect(compileSource(file).spec.source).toBe("prd");
  });

  test("<!-- tickmarkr:spec --> compiles via auto-detection", () => {
    const file = join(mkdtempSync(join(tmpdir(), "tickmarkr-marker-")), "spec.md");
    writeFileSync(file, "<!-- tickmarkr:spec -->\n## T1: Current\n- acceptance:\n  - detected\n");
    expect(compileSource(file).spec.source).toBe("native");
  });
});

describe("native spec compiler", () => {
  test("compiles every Task field and validates as a native RunGraph", () => {
    const graph = compileSource("fixtures/sample.native.md", "native");
    expect(graph.spec.source).toBe("native");
    expect(validateGraph(graph)).toEqual(graph);

    const [t1, t2] = graph.tasks;
    expect(t1.goal).toBe("Compile the complete native task surface");
    expect(t1.shape).toBe("implement");
    expect(t1.deps).toEqual([]);
    expect(t1.files).toEqual(["src/compile/native.ts", "src/compile/index.ts"]);
    expect(t1.context).toEqual(["docs/native.md", "src/graph/schema.ts"]);
    expect(t1.acceptance).toEqual(["every native field reaches the graph", "malformed fields fail loudly"]);
    expect(t1.complexity).toBe(8);
    expect(t1.humanGate).toBe(true);
    expect(t1.routingHints?.pin).toEqual({ via: "claude-code", model: "opus" });
    expect(t1.routingHints?.floor).toBe("frontier");
    expect(t1.gates).toEqual(["build", "test", "lint", "evidence", "scope", "acceptance"]);

    expect(t2.goal).toBe("Keep native and generic markdown routing distinct");
    expect(t2.shape).toBe("tests");
    expect(t2.deps).toEqual(["T1"]);
    expect(t2.files).toEqual(["tests/compile/native.test.ts"]);
    expect(t2.context).toEqual(["fixtures/sample.native.md"]);
    expect(t2.acceptance).toEqual(["marked markdown selects native", "marker-less markdown stays PRD"]);
    expect(t2.complexity).toBe(3);
    expect(t2.humanGate).toBe(false);
  });

  test("unknown fields fail loudly", () => {
    expectFieldError("mystery", "- mystery: discarded");
  });

  test("blank goal fails loudly", () => {
    expectFieldError("goal", "- goal:   ");
  });

  test("malformed top-level bullets fail loudly and quote the line", () => {
    expectFieldError("field", "- shape implement");
    expect(() => compileNativeText("## T7: Broken task\n- shape implement\n- acceptance:\n  - still required\n")).toThrow(/"- shape implement"/);
  });

  test("invalid shape fails loudly", () => {
    expectFieldError("shape", "- shape: backend");
  });

  test.each(["2.5", "0", "11"])("invalid complexity %s fails loudly", (value) => {
    expectFieldError("complexity", `- complexity: ${value}`);
  });

  test("invalid humanGate fails loudly", () => {
    expectFieldError("humanGate", "- humanGate: yes");
  });

  test("malformed pin fails loudly", () => {
    expectFieldError("pin", "- pin: claude-code");
  });

  test("invalid floor fails loudly", () => {
    expectFieldError("floor", "- floor: premium");
  });

  test("invalid gate fails loudly", () => {
    expectFieldError("gates", "- gates:\n  - deploy");
    expectFieldError("gates", "- gates:\n  -  ");
  });

  test("timeout compiles to timeoutMinutes; absent stays absent", () => {
    const withTimeout = compileNativeText("## T1: Timed\n- timeout: 45\n- acceptance:\n  - ok\n");
    expect(withTimeout.tasks[0].timeoutMinutes).toBe(45);
    const without = compileNativeText("## T1: Default\n- acceptance:\n  - ok\n");
    expect(without.tasks[0].timeoutMinutes).toBeUndefined();
  });

  test.each(["0", "-1", "abc"])("invalid timeout %s fails loudly", (value) => {
    expectFieldError("timeout", `- timeout: ${value}`);
  });

  test("a valid-name gate subset missing a mandatory gate fails compile loudly", () => {
    expect(() => compileSource("fixtures/missing-mandatory-gate.native.md", "native")).toThrow(GraphValidationError);
    expect(() => compileSource("fixtures/missing-mandatory-gate.native.md", "native")).toThrow(
      /build is a mandatory fail-closed gate invariant/,
    );
  });

  test("missing acceptance fails loudly naming every task", () => {
    expect(() => compileNativeText("## T1: First\n- shape: chore\n## T2: Second\n- shape: docs\n")).toThrow(CompileError);
    expect(() => compileNativeText("## T1: First\n- shape: chore\n## T2: Second\n- shape: docs\n")).toThrow(/T1.*T2/);
  });

  test("blank acceptance is missing acceptance and fails as CompileError", () => {
    try {
      compileNativeText("## T1: Blank acceptance\n- acceptance:\n  -  \n");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CompileError);
      expect((error as Error).message).toMatch(/T1/);
      expect((error as Error).message).toMatch(/acceptance/i);
    }
  });

  test("detects tickmarkr marker while explicit native forces marker-less markdown", () => {
    const tickmarkrFile = join(mkdtempSync(join(tmpdir(), "tickmarkr-native-detect-")), "spec.md");
    writeFileSync(tickmarkrFile, "<!-- tickmarkr:spec -->\n## T1: Versioned\n- acceptance:\n  - detected\n");
    expect(compileSource(tickmarkrFile).spec.source).toBe("native");
    expect(compileSource("fixtures/sample.prd.md").spec.source).toBe("prd");
    expect(compileSource("fixtures/sample.prd.md", "native").spec.source).toBe("native");
    expect(compileNativeText("## T1: Versioned\n- acceptance:\n  - detected\n").spec.source).toBe("native");

    const v1File = join(mkdtempSync(join(tmpdir(), "tickmarkr-native-v1-")), "spec.md");
    writeFileSync(v1File, "<!-- tickmarkr:spec v1 -->\n## T1: Versioned\n- acceptance:\n  - detected\n");
    expect(compileSource(v1File).spec.source).toBe("native");
  });

  test("compiles every committed tickmarkr-marked native spec", () => {
    const specs = readdirSync("specs").filter((file) => file.endsWith(".spec.md"));
    const marked = specs.filter((file) => TICKMARKR_NATIVE_MARKER.test(readFileSync(join("specs", file), "utf8")));
    expect(marked.length).toBeGreaterThan(0);
    for (const file of marked) expect(compileSource(join("specs", file)).spec.source).toBe("native");
  });

  test("a compiled task keeps every line of a multiline goal", () => {
    const g = compileNativeText(
      "## T1: Multi\n- goal: First line of goal\n  second line of goal\n  third line of goal\n- acceptance:\n  - ok\n",
    );
    expect(g.tasks[0].goal).toBe("First line of goal\nsecond line of goal\nthird line of goal");
  });

  test("a single line goal compiles byte-identically to before this change", () => {
    const g = compileNativeText("## T1: Single\n- goal: Compile the complete native task surface\n- acceptance:\n  - ok\n");
    expect(g.tasks[0].goal).toBe("Compile the complete native task surface");
  });

});

// v1.19: typed acceptance oracles compile from command:/test:/judge: prefixes; plain strings stay
// strings (compat) and anything typed-but-malformed fails loudly.
describe("native spec typed acceptance oracles (v1.19)", () => {
  test("command:/test:/judge: prefixes compile to typed oracle objects", () => {
    const g = compileNativeText("## T1: Typed\n- acceptance:\n  - command: npm test\n  - test: auth suite\n  - judge: behaves under load\n");
    expect(g.tasks[0].acceptance).toEqual([
      { oracle: "command", command: "npm test" },
      { oracle: "test", test: "auth suite" },
      { oracle: "judge", text: "behaves under load" },
    ]);
  });

  test("plain-string acceptance stays a plain string (compat path)", () => {
    const g = compileNativeText("## T1: Plain\n- acceptance:\n  - observable outcome\n");
    expect(g.tasks[0].acceptance).toEqual(["observable outcome"]);
  });

  test("mixed typed + plain compiles to a mixed array", () => {
    const g = compileNativeText("## T1: Mixed\n- acceptance:\n  - command: npm run build\n  - a free-text criterion\n");
    expect(g.tasks[0].acceptance).toEqual([{ oracle: "command", command: "npm run build" }, "a free-text criterion"]);
  });

  test("a criterion starting with 'test' but no colon stays plain (no false positive)", () => {
    const g = compileNativeText("## T1: Words\n- acceptance:\n  - test the thing thoroughly\n");
    expect(g.tasks[0].acceptance).toEqual(["test the thing thoroughly"]);
  });

  test("an empty typed oracle value fails loudly", () => {
    expect(() => compileNativeText("## T1: Empty\n- acceptance:\n  - command:\n")).toThrow(/command oracle must carry a value/);
    expect(() => compileNativeText("## T1: Empty\n- acceptance:\n  - judge:   \n")).toThrow(/judge oracle must carry a value/);
  });
});

// OBS-51: semicolon-joined judge criteria invite intermittent clause-split verdicts — compile warns per item.
describe("native spec semicolon-joined judge lint (OBS-51)", () => {
  afterEach(() => vi.restoreAllMocks());

  test("compile emits a warning naming task and item for a semicolon-joined judge criterion", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compileNativeText("## T5: Split\n- acceptance:\n  - judge: first clause; second clause\n");
    const obs51 = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("OBS-51"));
    expect(obs51).toHaveLength(1);
    expect(obs51[0]).toMatch(/task T5/);
    expect(obs51[0]).toMatch(/first clause; second clause/);
  });

  test("compile emits no OBS-51 warning for single-clause judge items", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compileNativeText("## T1: Single\n- acceptance:\n  - judge: one clause only\n");
    const obs51 = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("OBS-51"));
    expect(obs51).toHaveLength(0);
  });

  test("plain-string judge criterion with semicolons also warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compileNativeText("## T2: Plain\n- acceptance:\n  - looks good; smells good\n");
    const obs51 = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("OBS-51"));
    expect(obs51).toHaveLength(1);
    expect(obs51[0]).toMatch(/task T2/);
    expect(obs51[0]).toMatch(/looks good; smells good/);
  });
});
