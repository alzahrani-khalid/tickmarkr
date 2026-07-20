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
    for (const file of marked) {
      // OBS-97: pre-lint archives (read-only history, never amended) may trip the collectable-home
      // lint; that exact rejection is tolerated here — any other failure still fails this test.
      try {
        expect(compileSource(join("specs", file)).spec.source).toBe("native");
      } catch (error) {
        expect(error).toBeInstanceOf(CompileError);
        expect((error as Error).message).toMatch(/OBS-97/);
      }
    }
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

// OBS-97: a typed test: oracle on a task whose non-empty files[] cannot host a vitest-collectable
// tests/**/*.test.ts path makes scope-green and acceptance-green mutually exclusive — compile rejects it.
describe("native spec test-oracle collectable-home lint (OBS-97)", () => {
  const homeless = "## T3: Homeless\n- files: scripts/rig.mjs, package.json\n- acceptance:\n  - test: rig proves the race\n";

  test("a task carrying a typed test oracle with a non-empty file scope hosting no collectable test path fails compilation with a message naming the task", () => {
    expect(() => compileNativeText(homeless)).toThrow(CompileError);
    expect(() => compileNativeText(homeless)).toThrow(/T3/);
  });

  test("the compile failure message names the missing path class", () => {
    expect(() => compileNativeText(homeless)).toThrow(/tests\/\*\*\/\*\.test\.ts/);
  });

  test("a task carrying a typed test oracle and a collectable test path in its file scope compiles", () => {
    const literal = compileNativeText("## T1: Housed\n- files: src/a.ts, tests/a.test.ts\n- acceptance:\n  - test: covered\n");
    expect(literal.tasks[0].files).toEqual(["src/a.ts", "tests/a.test.ts"]);
    // a directory glob that can host a collectable path is a home too
    const glob = compileNativeText("## T1: Globbed\n- files: tests/gates/**\n- acceptance:\n  - test: covered\n");
    expect(glob.tasks[0].files).toEqual(["tests/gates/**"]);
  });

  test("wide globs that can host a collectable test are not falsely rejected", () => {
    // each of these CAN match a tests/**/*.test.ts path, so the lint must accept them
    for (const scope of ["tests/**/*.ts", "**", "tests/*/unit.test.ts"]) {
      const g = compileNativeText(`## T1: Wide\n- files: ${scope}\n- acceptance:\n  - test: covered\n`);
      expect(g.tasks[0].files, scope).toEqual([scope]);
    }
    // while globs that genuinely cannot host one still fail
    expect(() => compileNativeText("## T1: SrcOnly\n- files: src/**\n- acceptance:\n  - test: covered\n")).toThrow(/OBS-97/);
  });

  // v1.62: the probe expands {a,b} alternatives and substitutes ? wildcards before probing.
  test("a brace glob entry naming collectable test paths passes the collectable home lint", () => {
    // brace + star (falsely rejected before v1.62)
    const braced = compileNativeText("## T1: Braced\n- files: tests/{compile,gates}/*.test.ts\n- acceptance:\n  - test: covered\n");
    expect(braced.tasks[0].files).toEqual(["tests/{compile,gates}/*.test.ts"]);
    // the brace comma is part of the entry, not a files[] separator; suffix braces expand too
    const suffix = compileNativeText("## T1: Suffix\n- files: src/a.ts, tests/foo.{test,spec}.ts\n- acceptance:\n  - test: covered\n");
    expect(suffix.tasks[0].files).toEqual(["src/a.ts", "tests/foo.{test,spec}.ts"]);
    const filenames = compileNativeText("## T1: Names\n- files: tests/{a,b}.test.ts\n- acceptance:\n  - test: covered\n");
    expect(filenames.tasks[0].files).toEqual(["tests/{a,b}.test.ts"]);
  });

  test("a single-character wildcard entry naming a collectable test path passes the collectable home lint", () => {
    // ? standing in for filename chars, the tests/ prefix, and the .test.ts suffix
    for (const scope of ["tests/route?.test.ts", "test?/unit.test.ts", "tests/unit.test.t?"]) {
      const g = compileNativeText(`## T1: Qmark\n- files: ${scope}\n- acceptance:\n  - test: covered\n`);
      expect(g.tasks[0].files, scope).toEqual([scope]);
    }
    // mixed ?s needing DIFFERENT chars per position (per-position search, falsely rejected before)
    const mixed = compileNativeText("## T1: MixedQ\n- files: test?/unit.tes?.ts\n- acceptance:\n  - test: covered\n");
    expect(mixed.tasks[0].files).toEqual(["test?/unit.tes?.ts"]);
  });

  test("pathological brace entries stay bounded and fail closed instead of ballooning compile", () => {
    // 12 groups would be 4096 branches unbounded — the cap keeps compile instant and the
    // scope still fails the lint (no branch is collectable)
    const bomb = "{a,b}".repeat(12) + ".md";
    expect(() => compileNativeText(`## T1: Bomb\n- files: ${bomb}\n- acceptance:\n  - test: covered\n`)).toThrow(/OBS-97/);
    // more ?s than the search cap: fail-closed, never a hang
    expect(() => compileNativeText("## T1: ManyQ\n- files: ?????/????.????.??\n- acceptance:\n  - test: covered\n")).toThrow(/OBS-97/);
  });

  test("a brace glob entry that cannot host a collectable test path still fails compilation", () => {
    for (const scope of ["tests/{a,b}.spec.ts", "src/{gates,run}/**", "scripts/{rig,repro}.mjs"]) {
      expect(() => compileNativeText(`## T1: BracedHomeless\n- files: ${scope}\n- acceptance:\n  - test: covered\n`), scope).toThrow(/OBS-97/);
    }
  });

  test("star glob and literal path probes behave as before the extension", () => {
    for (const scope of ["tests/**/*.ts", "**", "tests/*/unit.test.ts", "tests/a.test.ts", "tests/gates/**"]) {
      const g = compileNativeText(`## T1: Prior\n- files: ${scope}\n- acceptance:\n  - test: covered\n`);
      expect(g.tasks[0].files, scope).toEqual([scope]);
    }
    for (const scope of ["src/**", "scripts/rig.mjs"]) {
      expect(() => compileNativeText(`## T1: PriorHomeless\n- files: ${scope}\n- acceptance:\n  - test: covered\n`), scope).toThrow(/OBS-97/);
    }
  });

  test("a task carrying a typed test oracle and an empty file scope compiles because an empty scope is unrestricted", () => {
    const omitted = compileNativeText("## T1: Unrestricted\n- acceptance:\n  - test: covered\n");
    expect(omitted.tasks[0].files).toEqual([]);
    const none = compileNativeText("## T1: None\n- files: none\n- acceptance:\n  - test: covered\n");
    expect(none.tasks[0].files).toEqual([]);
  });

  test("a task whose acceptance carries only command and judge oracles compiles regardless of file scope shape", () => {
    const g = compileNativeText("## T1: NoTestOracle\n- files: scripts/rig.mjs\n- acceptance:\n  - command: npm test\n  - judge: behaves under load\n  - plain criterion\n");
    expect(g.tasks[0].acceptance).toHaveLength(3);
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
