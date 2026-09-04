import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CompileError } from "../../src/compile/common.js";
import { compileSource } from "../../src/compile/index.js";
import { classifyContextPath, compileNative, TICKMARKR_NATIVE_MARKER, specTemplate } from "../../src/compile/native.js";
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

describe("native spec scaffold guard", () => {
  function writeScaffold(body = specTemplate()) {
    const file = join(mkdtempSync(join(tmpdir(), "tickmarkr-template-")), "tickmarkr.spec.md");
    writeFileSync(file, body);
    return file;
  }

  test("compiling the unedited scaffold template fails with an error naming the spec path", () => {
    const file = writeScaffold();
    expect(specTemplate()).toMatch(/^<!-- tickmarkr:spec -->/);

    expect(() => compileSource(file)).toThrow(CompileError);
    expect(() => compileSource(file)).toThrow(file);
  });

  test("the pristine template error tells the operator to edit the spec before compiling", () => {
    const file = writeScaffold();

    expect(() => compileSource(file)).toThrow(/edit .* before compiling/i);
  });

  test("a spec edited away from the template compiles as before", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = writeScaffold(specTemplate().replace("# tickmarkr native spec", "# edited tickmarkr native spec"));

    try {
      const graph = compileSource(file);

      expect(graph.spec.source).toBe("native");
      expect(graph.tasks.map((task) => task.id)).toEqual(["T1", "T2"]);
      expect(graph.tasks[0]).toMatchObject({ title: "Scaffold the feature", files: ["src/feature.ts"] });
      expect(graph.tasks[1]).toMatchObject({ title: "Cover it with tests", deps: ["T1"], files: ["tests/feature.test.ts"] });
    } finally {
      warn.mockRestore();
    }
  });

  test("every existing compile fixture still compiles unchanged", () => {
    expect(compileSource("fixtures/sample.native.md", "native").spec.source).toBe("native");
    expect(compileSource("fixtures/sample.prd.md").spec.source).toBe("prd");
    expect(compileSource("fixtures/sample-pin.prd.md").spec.source).toBe("prd");
    expect(compileSource("fixtures/speckit-sample").spec.source).toBe("speckit");
    expect(compileSource("fixtures/gsd-sample/07-live-check").spec.source).toBe("gsd");
  });
});

// OBS-542: the authoring law has to name the SIDE, not just the subject. A template that talks about
// credentials without saying that oracles inherit the daemon's environment while a herdr worker pane is
// seeded fresh leaves the author unable to tell a satisfiable criterion from an impossible one.
describe("spec template — environment asymmetry law (OBS-542)", () => {
  // The side has to be IN the pattern: "X inherits the daemon's environment" is true of the wrong X too.
  const SAYS_WHICH_SIDE_INHERITS = /gate commands[^.]{0,120}oracles[^.]{0,40}inherit the daemon's environment/i;
  const NAMES_THE_SEALED_SIDE = /herdr[^.]{0,120}worker pane[^.]{0,120}fresh ambient environment/i;

  test("the spec template states which side of a run inherits environment and names the herdr worker pane as the side seeded fresh, so a template that mentions credentials without saying which side inherits fails", () => {
    const template = specTemplate();

    expect(template).toMatch(SAYS_WHICH_SIDE_INHERITS);
    expect(template).toMatch(NAMES_THE_SEALED_SIDE);
    // ...and the author is told what to DO with the asymmetry, not just that it exists.
    expect(template).toMatch(/never in a worker's prose report/i);

    // False-clean control 1, cut from the real template: strip the law, keep a credentials mention. Both
    // checks must go false, or they are asserting on prose the law does not own.
    const lawStart = template.indexOf("  WHICH SIDE OF A RUN INHERITS ENVIRONMENT");
    const lawEnd = template.indexOf("  ORDERING AND OWNERSHIP:");
    expect(lawStart).toBeGreaterThan(-1);
    expect(lawEnd).toBeGreaterThan(lawStart);
    const credentialsWithoutSides = template.slice(0, lawStart) + template.slice(lawEnd)
      + "\n  A criterion may require credentials, a bound port, or the network.\n";

    expect(credentialsWithoutSides).toMatch(/credentials/);
    expect(credentialsWithoutSides).not.toMatch(SAYS_WHICH_SIDE_INHERITS);
    expect(credentialsWithoutSides).not.toMatch(NAMES_THE_SEALED_SIDE);

    // False-clean control 2: keep the law's shape and every other phrase — the herdr/fresh sentence, the
    // consequence — but let the inheriting sentence name no side ("Credentials inherit ..."). That is the
    // prose an author cannot act on, so the side check must go false while the rest stays true.
    const sidelessInheritance = template.replace(
      /    - Gate commands and[^]*?every one of them\./,
      "    - Credentials inherit the daemon's environment.",
    );
    expect(sidelessInheritance).not.toBe(template);
    expect(sidelessInheritance).toMatch(/inherit the daemon's environment/i);
    expect(sidelessInheritance).toMatch(NAMES_THE_SEALED_SIDE);
    expect(sidelessInheritance).not.toMatch(SAYS_WHICH_SIDE_INHERITS);
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
    expect(t1.context).toEqual(["docs/codebase/ARCHITECTURE.md", "src/graph/schema.ts"]);
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
      // OBS-212/214: the task unit contract is a NEWER bar than most of these archives, which were
      // authored when unordered tasks could share files and a task could carry any number of
      // criteria. Same tolerance, same reason — these specs are history and are never re-run.
      // OBS-170 (RULING 2026-08-03): dead `context:` paths are the third such bar. The ruling
      // declined a retroactive sweep — measured, 11 archived specs carry 24 dead entries and none
      // will be recompiled. The assertion this test actually makes is "no spec fails for an
      // UNKNOWN reason"; it has never asserted that every archive compiles (65 already do not).
      // Frame-v2 criterion-scope is the same class: the checked-in corpus guards current authoring,
      // while immutable pre-lint specs remain useful historical inputs rather than migration work.
      // OBS-604 fence-symbol-absent is likewise a current authoring bar, not an archive sweep.
      // OBS-488: the unconsumed-line invariant is the fourth bar. Measured over the corpus:
      // 3 column-zero prose lines across v1.86 (2) and v1.90 (1) were silently DROPPED by every
      // prior compiler — the error now names them instead.
      try {
        expect(compileSource(join("specs", file)).spec.source).toBe("native");
      } catch (error) {
        expect(error).toBeInstanceOf(CompileError);
        expect((error as Error).message).toMatch(/OBS-97|OBS-604|task unit contract|context: paths that do not exist|criterion-scope authoring lint|no parse rule consumes/);
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

test("criterion-scope lint errors when a criterion names a file or a `52/64`-form rendered", () => {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-criterion-scope-"));
  mkdirSync(join(repo, "tests"));
  writeFileSync(
    join(repo, "tests", "render.test.ts"),
    'test("rendered numerator", () => expect("52/64").toBe("52/64"));\n',
  );
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t", { cwd: repo });
  execSync("git config user.name t", { cwd: repo });
  execSync("git add tests/render.test.ts", { cwd: repo });
  execSync("git -c commit.gpgsign=false commit -qm base", { cwd: repo });

  const spec = join(repo, "scope.spec.md");
  const source = (criterion: string, includeTest: boolean) => `<!-- tickmarkr:spec -->
## T1: Criterion scope
- goal: Render the normalized result
- files: src/render.ts${includeTest ? ", tests/render.test.ts" : ""}
- acceptance:
  - judge: ${criterion}
`;

  for (const criterion of [
    "the oracle in `tests/render.test.ts` renders the normalized result",
    "the rendered summary is `52/64`",
  ]) {
    writeFileSync(spec, source(criterion, false));
    expect(() => compileSource(spec, "native"), criterion).toThrow(CompileError);
    expect(() => compileSource(spec, "native"), criterion).toThrow(/authoring-lint\[criterion-scope\]/);
    expect(() => compileSource(spec, "native"), criterion).toThrow(/tests\/render\.test\.ts/);

    writeFileSync(spec, source(criterion, true));
    expect(compileSource(spec, "native").tasks[0].files, criterion).toContain("tests/render.test.ts");
  }
});

// T4: the criterion-scope lint consulted files[] only, so a criterion naming a producer the task
// declared as a READ dependency was refused as if the task had to mutate it — and the refusal told
// the author to add that producer to files[], i.e. the product itself emitting the unsafe workaround.
// This lint's failure mode is silence, so every test here carries its own red control.
describe("criterion-scope reads the declared read dependencies (T4)", () => {
  const spec = (context: string | null, criterion: string) => {
    const file = join(mkdtempSync(join(tmpdir(), "tickmarkr-read-dep-")), "read-dep.spec.md");
    writeFileSync(file, `<!-- tickmarkr:spec -->
## T1: Consume the producer
- goal: consume what the producer already emits
- files: src/consumer.ts
${context === null ? "" : `- context: ${context}\n`}- acceptance:
  - judge: ${criterion}
`);
    return file;
  };

  test("a spec whose criterion names a path declared only as a read dependency compiles, and the identical spec with that path struck from the read declaration throws the criterion-scope compile error naming it, so the control goes red before the change and green after; a check verified by a clean run alone proves nothing and: it fails", () => {
    const criterion = "the consumer resolves every row through the table that src/producer.ts already publishes";

    // the control FIRST: with no read declaration the path is in neither surface and the lint throws
    const control = spec(null, criterion);
    expect(() => compileNative(control)).toThrow(CompileError);
    expect(() => compileNative(control)).toThrow(/authoring-lint\[criterion-scope\]/);
    expect(() => compileNative(control)).toThrow(/src\/producer\.ts/);

    // …and the same spec with the path declared as a read dependency compiles
    const declared = compileNative(spec("src/producer.ts", criterion));
    expect(declared.tasks[0].files).toEqual(["src/consumer.ts"]);
    expect(declared.tasks[0].context).toEqual(["src/producer.ts"]);
  });

  test("the criterion-scope refusal names context[] for a reading criterion and files[] for a changing one", () => {
    const reads = spec(null, "the consumer resolves every row through the table that src/producer.ts already publishes");
    expect(() => compileNative(reads)).toThrow(/add it to context\[\]/);
    expect(() => compileNative(reads)).toThrow(/never asks for/);

    const changes = spec(null, "src/producer.ts emits the normalized row and the consumer replays it");
    expect(() => compileNative(changes)).toThrow(/add it to files\[\]/);
    expect(() => compileNative(changes)).not.toThrow(/add it to context\[\]/);

    // A read followed by a same-target write is still a write criterion, including when the target
    // is referred to anaphorically after its sole literal mention.
    for (const mixed of [
      "src/producer.ts is read and then rewritten by the consumer",
      "the consumer reads src/producer.ts and updates it",
      "reading src/producer.ts and rewriting it",
    ]) {
      expect(() => compileNative(spec(null, mixed)), mixed).toThrow(/add it to files\[\]/);
      expect(() => compileNative(spec(null, mixed)), mixed).not.toThrow(/add it to context\[\]/);
    }
  });

  // A path-only criterion has no enabling symbol, so symbol ownership can never back this site up:
  // if criterion-scope honoured `context:` unconditionally, a criterion demanding the producer CHANGE
  // would compile off a read declaration and nothing downstream would catch it. The declaration is
  // therefore honoured per path and only for a criterion that reads it.
  test("a context-only path is refused when the criterion says to change it, and the refusal names files[]", () => {
    const declared = spec("src/producer.ts", "src/producer.ts emits the normalized row and the consumer replays it");
    expect(() => compileNative(declared)).toThrow(/authoring-lint\[criterion-scope\]/);
    expect(() => compileNative(declared)).toThrow(/src\/producer\.ts/);
    expect(() => compileNative(declared)).toThrow(/add it to files\[\]/);

    // fail-closed, not verb-listed: a change demand carrying no listed write verb is refused too…
    const unlisted = spec("src/producer.ts", "src/producer.ts must now return two rows instead of one");
    expect(() => compileNative(unlisted)).toThrow(/authoring-lint\[criterion-scope\]/);
    // Declarative and unlisted mutations fail closed: neither is evidence of a read relation.
    const declarative = spec("src/producer.ts", "src/producer.ts returns two normalized rows");
    expect(() => compileNative(declarative)).toThrow(/authoring-lint\[criterion-scope\]/);
    const unlistedVerb = spec(
      "src/producer.ts",
      "src/producer.ts sorts the rows it already publishes",
    );
    expect(() => compileNative(unlistedVerb)).toThrow(/authoring-lint\[criterion-scope\]/);
    for (const mixed of [
      "src/producer.ts is read and then rewritten by the consumer",
      "the consumer reads src/producer.ts and updates it",
      "reading src/producer.ts and rewriting it",
    ]) {
      expect(() => compileNative(spec("src/producer.ts", mixed)), mixed)
        .toThrow(/authoring-lint\[criterion-scope\]/);
      expect(() => compileNative(spec("src/producer.ts", mixed)), mixed).toThrow(/add it to files\[\]/);
    }
    // A write elsewhere does not revoke the named producer's explicit read relation.
    const elsewhere = spec("src/producer.ts", "the consumer adds a cache while reading src/producer.ts");
    expect(compileNative(elsewhere).tasks[0].context).toEqual(["src/producer.ts"]);
    const elsewhereControl = spec(null, "the consumer adds a cache while reading src/producer.ts");
    expect(() => compileNative(elsewhereControl)).toThrow(/add it to context\[\]/);
    // …and so is a bare mention with no read relation at all: silence is not permission.
    const silent = spec("src/producer.ts", "the consumer and src/producer.ts agree on the row shape");
    expect(() => compileNative(silent)).toThrow(/authoring-lint\[criterion-scope\]/);

    // the control that keeps the refusals above from being vacuous: the reading criterion compiles
    expect(compileNative(spec(
      "src/producer.ts",
      "the consumer resolves every row through the table that src/producer.ts already publishes",
    )).tasks[0].context).toEqual(["src/producer.ts"]);
  });

  // One criterion naming two declared producers, one changed: only the changed target loses the
  // exemption. This is the per-path boundary; sentence-wide write detection emits an unsafe remedy
  // for the producer that is merely read.
  test("a change demand costs only its target the read exemption", () => {
    const file = join(mkdtempSync(join(tmpdir(), "tickmarkr-read-dep-pair-")), "pair.spec.md");
    writeFileSync(file, `<!-- tickmarkr:spec -->
## T1: Consume the producers
- goal: consume what the producers publish
- files: src/consumer.ts
- context: src/reader.ts, src/writer.ts
- acceptance:
  - judge: src/writer.ts emits the normalized row that src/reader.ts already publishes
`);
    let message = "";
    try {
      compileNative(file);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/authoring-lint\[criterion-scope\]/);
    expect(message).toContain("src/writer.ts");
    expect(message).not.toMatch(/outside expanded[^\n]*src\/reader\.ts/);
    expect(message).toMatch(/add it to files\[\]/);

    // the control: strike the change demand and the same two declarations carry the criterion
    writeFileSync(file, `<!-- tickmarkr:spec -->
## T1: Consume the producers
- goal: consume what the producers publish
- files: src/consumer.ts
- context: src/reader.ts, src/writer.ts
- acceptance:
  - judge: the consumer replays the row src/writer.ts already publishes beside the one src/reader.ts already publishes
`);
    expect(compileNative(file).tasks[0].context).toEqual(["src/reader.ts", "src/writer.ts"]);
  });
});

// OBS-170/OBS-184: `context:` entries reached workers split at annotation commas and unvalidated.
// Measured on specs/v1.85-speed-truth.spec.md before the fix: 37 entries, 24 unresolvable, and
// workers were dispatched context bullets reading `OBS-263)`.
describe("context: pointer integrity", () => {
  test("a citation annotation is one entry, not two, and the annotation is stripped", () => {
    const g = compileNativeText(
      "## T1: Cited\n- context: .planning/OBSERVATIONS.md (OBS-262, OBS-263), src/run/journal.ts\n- acceptance:\n  - ok\n",
    );
    // before: [".planning/OBSERVATIONS.md (OBS-262", "OBS-263)", "src/run/journal.ts"]
    expect(g.tasks[0].context).toEqual([".planning/OBSERVATIONS.md", "src/run/journal.ts"]);
  });

  test("brace globs still survive the comma split (OBS-97 must not regress)", () => {
    const g = compileNativeText(
      "## T1: Globbed\n- files: src/{graph,route}/**/*.ts, docs/x.md\n- acceptance:\n  - ok\n",
    );
    expect(g.tasks[0].files).toEqual(["src/{graph,route}/**/*.ts", "docs/x.md"]);
  });

  test("classifyContextPath separates the three author actions", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-ctx-"));
    writeFileSync(join(dir, "scratch.md"), "present but untracked");
    const tracked = new Set([".overseer/V185-SEEDS.md", "src/run/journal.ts", "docs/a/deep.md"]);

    // reachable — in the tree the worker's worktree is built from
    expect(classifyContextPath("src/run/journal.ts", tracked, dir).kind).toBe("ok");
    // a directory counts as reachable when it has tracked children
    expect(classifyContextPath("docs/a", tracked, dir).kind).toBe("ok");
    // globs are not a promise about one file
    expect(classifyContextPath("src/**/*.ts", tracked, dir).kind).toBe("ok");

    // subclass A: in the author's checkout, invisible to every worker
    expect(classifyContextPath("scratch.md", tracked, dir).kind).toBe("untracked");

    // subclass B: absent everywhere, but the basename names a tracked file → one-line fix
    expect(classifyContextPath("V185-SEEDS.md", tracked, dir)).toEqual({
      kind: "missing",
      suggestion: ".overseer/V185-SEEDS.md",
    });
    // subclass B with nothing to suggest — prose, not a path
    expect(classifyContextPath("the run-20260731-192921 journal as fixture", tracked, dir)).toEqual({ kind: "missing" });
  });

  test("an ambiguous basename suggests nothing rather than guessing", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-ctx-"));
    const tracked = new Set(["a/notes.md", "b/notes.md"]);
    expect(classifyContextPath("notes.md", tracked, dir)).toEqual({ kind: "missing" });
  });

  test("existsSync is NOT the oracle — an untracked file present on disk is still unreachable", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-ctx-"));
    writeFileSync(join(dir, "ORCH-REPORT.md"), "x");
    // the whole defect class: the author sees it, the worker never does
    expect(existsSync(join(dir, "ORCH-REPORT.md"))).toBe(true);
    expect(classifyContextPath("ORCH-REPORT.md", new Set(["src/a.ts"]), dir).kind).toBe("untracked");
  });
});

// RULING 2026-08-03 rider. `git add -f` writes the INDEX; createWorktree materialises the base TREE.
// A resolver reading `git ls-files` would call a staged-uncommitted file present and certify exactly
// the failure the lint exists to catch. This test fails if anyone swaps the oracle back to the index.
describe("context: oracle is the tree, not the index", () => {
  const git = (repo: string, cmd: string) => execSync(`git -C ${repo} ${cmd}`, { stdio: "pipe" });

  test("a staged-but-uncommitted context file is still unreachable", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-tree-"));
    git(repo, "init -q");
    git(repo, "config user.email t@t.t");
    git(repo, "config user.name t");
    writeFileSync(join(repo, "seed.md"), "committed");
    git(repo, "add seed.md");
    git(repo, "commit -qm base");

    writeFileSync(join(repo, "staged.md"), "staged only");
    git(repo, "add -f staged.md");

    // the trap: the index says present, the worktree the worker gets does not have it
    expect(execSync(`git -C ${repo} ls-files staged.md`, { encoding: "utf8" }).trim()).toBe("staged.md");
    expect(execSync(`git -C ${repo} ls-tree -r --name-only HEAD`, { encoding: "utf8" }).split("\n").filter(Boolean)).toEqual(["seed.md"]);

    const spec = join(repo, "spec.md");
    writeFileSync(spec, "<!-- tickmarkr:spec -->\n## T1: Staged\n- context: staged.md\n- acceptance:\n  - ok\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compileSource(spec, "native");
    const msgs = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("OBS-170"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/git add -f staged\.md && git commit/);
    expect(msgs[0]).toMatch(/Staging alone is not enough/);
  });

  test("a committed context file is reachable and silent", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-tree-"));
    git(repo, "init -q");
    git(repo, "config user.email t@t.t");
    git(repo, "config user.name t");
    writeFileSync(join(repo, "seed.md"), "committed");
    git(repo, "add seed.md");
    git(repo, "commit -qm base");

    const spec = join(repo, "spec.md");
    writeFileSync(spec, "<!-- tickmarkr:spec -->\n## T1: Committed\n- context: seed.md\n- acceptance:\n  - ok\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compileSource(spec, "native");
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("OBS-170"))).toHaveLength(0);
  });

  test("an absent context path fails compile and names the repair", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-tree-"));
    git(repo, "init -q");
    git(repo, "config user.email t@t.t");
    git(repo, "config user.name t");
    writeFileSync(join(repo, "SEEDS.md"), "the real one");
    execSync(`mkdir -p ${join(repo, "notes")}`);
    writeFileSync(join(repo, "notes", "DEEP.md"), "x");
    git(repo, "add -A");
    git(repo, "commit -qm base");

    const spec = join(repo, "spec.md");
    // written bare, the way 5 of v1.85's 6 subclass-B occurrences were
    writeFileSync(spec, "<!-- tickmarkr:spec -->\n## T1: Bare\n- context: DEEP.md\n- acceptance:\n  - ok\n");
    expect(() => compileSource(spec, "native")).toThrow(/did you mean notes\/DEEP\.md/);
  });
});

// The bug my own fixtures missed: every test above puts the spec at the repo ROOT, where
// `git -C <dir> ls-tree -r HEAD` happens to list the whole tree. From a subdirectory it scopes to
// that subtree and prints paths relative to it — so a spec in specs/ judged every path outside
// specs/ unreachable. Same fixture-blindness as the doctor guard (OBS-304): the fixture agreed with
// the code because both were built from the same wrong assumption. This spec lives in a subdir.
describe("context: resolution from a spec that is not at the repo root", () => {
  test("paths are judged against the full tree, not the spec directory's subtree", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-sub-"));
    const git = (cmd: string) => execSync(`git -C ${repo} ${cmd}`, { stdio: "pipe" });
    git("init -q");
    git("config user.email t@t.t");
    git("config user.name t");
    execSync(`mkdir -p ${join(repo, "specs")} ${join(repo, "src/run")} ${join(repo, "notes")}`);
    writeFileSync(join(repo, "src/run/journal.ts"), "export {};");
    writeFileSync(join(repo, "notes", "SEEDS.md"), "seeds");
    git("add -A");
    git("commit -qm base");

    const spec = join(repo, "specs", "v1.md");
    writeFileSync(spec, "<!-- tickmarkr:spec -->\n## T1: Sub\n- context: src/run/journal.ts\n- acceptance:\n  - ok\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // a tracked file outside specs/ must be reachable — silent, not warned, not thrown
    const g = compileSource(spec, "native");
    expect(g.tasks[0].context).toEqual(["src/run/journal.ts"]);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("OBS-170"))).toHaveLength(0);

    // and the basename suggestion must reach outside specs/ too
    writeFileSync(spec, "<!-- tickmarkr:spec -->\n## T1: Bare\n- context: SEEDS.md\n- acceptance:\n  - ok\n");
    expect(() => compileSource(spec, "native")).toThrow(/did you mean notes\/SEEDS\.md/);
  });
});
