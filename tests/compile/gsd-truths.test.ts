import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildTaskPrompt } from "../../src/adapters/prompt.js";
import { CompileError } from "../../src/compile/common.js";
import { compileGsd, parseTruths } from "../../src/compile/gsd.js";
import { graphPath, loadGraph, saveGraph } from "../../src/graph/graph.js";
import { renderAcceptanceItem, type AcceptanceItem } from "../../src/graph/schema.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

const FIXTURE_PHASE = "fixtures/gsd-sample/07-live-check";

// makeTestTempDir, not a bare mkdtempSync: it is the reaped seam (tests/setup.ts afterAll), so these
// scratch phases do not join the $TMPDIR leak.
function scratchPhase(name: string, content: string): string {
  const dir = join(makeTestTempDir("tickmarkr-truths-"), name);
  mkdirSync(dir);
  writeFileSync(join(dir, "09-01-PLAN.md"), content);
  return dir;
}

const BODY = `<objective>Do the thing. And more.</objective>

<tasks>
<task type="auto">
  <name>Task 1</name>
  <done>the done line holds</done>
</task>
</tasks>`;

const planWith = (mustHaves: string) => `---\ndepends_on: []\nfiles_modified:\n  - src/app.ts\n${mustHaves}---\n\n${BODY}\n`;
// YAML is a superset of JSON, so a flow value expresses every truth shape (typed, scalar, null) exactly.
const truthsPlan = (truths: unknown) => planWith(`must_haves:\n  truths: ${JSON.stringify(truths)}\n`);

describe("GSD must_haves.truths fail closed (v1.86 T11, spec items 20 + 21)", () => {
  test("a non-string truth raises CompileError naming its index, proven member by member over the closed set of non-string shapes — a typed-object fixture, a bare-number fixture, a nested-array fixture and a null fixture", () => {
    // Index 1 throughout: a message that hardcoded [0] would pass a one-item probe and still lie.
    const shapes: Array<[string, unknown]> = [
      ["typed-object", { command: "npm test", severity: "high" }], // the shape that became "[object Object]"
      ["bare-number", 2.0],
      ["nested-array", ["truth two holds"]],
      ["null", null],
      // A schema-ACCEPTED object is the fifth non-string shape: valid oracle, one undeclared key.
      // Zod strips it and safeParse still succeeds, so without a drop check this compiles minus
      // `severity` — coercion that no rejected-shape fixture above can reach, because they all fail.
      ["accepted-with-unknown-key", { oracle: "command", command: "npm test", text: "runs", severity: "high" }],
      // …and the undeclared key is prototype-OWNED for each of these: the parser hands them back as own
      // keys, so a `k in parsed.data` drop check found all four on Object.prototype and stripped them
      // silently. Computed keys, so `__proto__` is an own property here rather than a prototype setter.
      ...["constructor", "toString", "hasOwnProperty", "__proto__"].map(
        (k) => [`prototype-key-${k}`, { oracle: "command", command: "npm test", [k]: "boom" }] as [string, unknown],
      ),
    ];
    // A recursive alias has no JSON form, so it is written as YAML text: it is the shape whose mere
    // RENDERING threw a native TypeError out of JSON.stringify, losing the indexed CompileError.
    const plans: Array<[string, string]> = [
      ...shapes.map(([name, bad]) => [name, truthsPlan(["truth one holds", bad])] as [string, string]),
      ["recursive-alias", planWith("must_haves:\n  truths:\n    - truth one holds\n    - &a [*a]\n")],
    ];
    for (const [name, plan] of plans) {
      const dir = scratchPhase(`09-${name}`, plan);
      let thrown: unknown;
      try {
        compileGsd(dir);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `${name} truth must fail the compile, never be coerced`).toBeInstanceOf(CompileError);
      expect((thrown as CompileError).message, name).toContain("must_haves.truths[1]");
      // The corruption this replaces must not appear in its place.
      expect((thrown as CompileError).message, name).not.toContain("[object Object]");
    }
  });

  test("a dual-key truth carrying text beside command compiles to a typed oracle whose text survives being persisted and reloaded through the shared graph store, asserted on the value read back from the written graph file rather than on the object the compiler returned", () => {
    const dual = { oracle: "command", command: "npm test", text: "npm test exits 0 on the widget suite" };
    const dir = scratchPhase("09-dual-key", truthsPlan([dual]));
    const compiled = compileGsd(dir);
    expect(compiled.tasks[0].acceptance[1]).toEqual(dual); // [0] is the <done> line

    const store = makeTestTempDir("tickmarkr-truths-store-");
    saveGraph(store, compiled);
    // Proof from the written file, not the returned object: the bytes on disk carry text…
    const onDisk = JSON.parse(readFileSync(graphPath(store), "utf8"));
    expect(onDisk.tasks[0].acceptance[1]).toEqual(dual);
    // …and it survives loadGraph's revalidation, which strips any key the schema does not declare.
    expect(loadGraph(store).tasks[0].acceptance[1]).toEqual(dual);
  });

  test("an all-string truths list compiles byte-identically to the pre-change graph", () => {
    // Both pins were recorded by running the PRE-change compiler; neither was derived from the new one.
    const preChangeScratch =
      '{"version":1,"spec":{"source":"gsd","paths":["<DIR>/09-01-PLAN.md"],"hash":"fd7f5455de9bebcc9dbbbae98a51176866bdb841c78bd145894f6c646ed353b8"},"tasks":[{"id":"P09-01","title":"Do the thing.","goal":"Do the thing.","shape":"implement","complexity":5,"deps":[],"files":["src/app.ts"],"context":["<DIR>/09-01-PLAN.md"],"acceptance":["the done line holds","truth one holds","truth two holds","truth three holds"],"gates":["build","test","lint","evidence","scope","acceptance","review"],"humanGate":false,"status":"pending","evidence":{"commits":[],"artifacts":[],"gateResults":[]}}]}';
    const dir = scratchPhase(
      "09-strings",
      planWith("must_haves:\n  truths:\n    - truth one holds\n    - truth two holds\n    - truth three holds\n"),
    );
    expect(JSON.stringify(compileGsd(dir)).split(dir).join("<DIR>")).toBe(preChangeScratch);

    const preChangeFixture =
      '{"version":1,"spec":{"source":"gsd","paths":["fixtures/gsd-sample/07-live-check/07-01-PLAN.md","fixtures/gsd-sample/07-live-check/07-02-PLAN.md","fixtures/gsd-sample/07-live-check/07-03-PLAN.md"],"hash":"2219173826286592bb55a73026cf50fcb7013ef11cb2f9916a427995e9973705"},"tasks":[{"id":"P07-01","title":"Implement the first objective sentence.","goal":"Implement the first objective sentence.","shape":"implement","complexity":5,"deps":[],"files":["src/**"],"context":["fixtures/gsd-sample/07-live-check/07-01-PLAN.md",".planning/PROJECT.md"],"acceptance":["widget builds green","widget is wired and demoed","truth A holds in the shipped artifact"],"gates":["build","test","lint","evidence","scope","acceptance","review"],"humanGate":false,"status":"pending","evidence":{"commits":[],"artifacts":[],"gateResults":[]}},{"id":"P07-02","title":"Document the widget.","goal":"Document the widget.","shape":"docs","complexity":2,"deps":["P07-01"],"files":["docs/**"],"context":["fixtures/gsd-sample/07-live-check/07-02-PLAN.md"],"acceptance":["operator approved the docs page"],"gates":["build","test","lint","evidence","scope","acceptance","review"],"humanGate":true,"status":"pending","evidence":{"commits":[],"artifacts":[],"gateResults":[]}},{"id":"P07-03","title":"Already-finished work.","goal":"Already-finished work.","shape":"implement","complexity":2,"deps":["P07-02"],"files":[],"context":["fixtures/gsd-sample/07-live-check/07-03-PLAN.md"],"acceptance":["previously completed"],"gates":["build","test","lint","evidence","scope","acceptance","review"],"humanGate":false,"status":"done","evidence":{"commits":[],"artifacts":[],"gateResults":[]}}]}';
    expect(JSON.stringify(compileGsd(FIXTURE_PHASE))).toBe(preChangeFixture);
  });

  test("an absent truths key and an empty truths list are distinguished rather than both yielding the empty list, proven over the closed set of truth-container states — a missing-key fixture, an empty-list fixture and a non-array fixture", () => {
    // Missing key: nothing was declared, so the <done> lines alone are the acceptance — compiles.
    const missing = compileGsd(scratchPhase("09-missing", planWith("must_haves:\n  other: value\n")));
    expect(missing.tasks[0].acceptance).toEqual(["the done line holds"]);

    // Empty list: `truths: []` is real producer output, so it compiles on its <done> lines too…
    const empty = compileGsd(scratchPhase("09-empty", truthsPlan([])));
    expect(empty.tasks[0].acceptance).toEqual(["the done line holds"]);
    // …but the two states are REPORTED apart rather than collapsed: absent is undefined, present-empty
    // is []. Reading that off the graph is impossible — both contribute nothing — so read it off the
    // parser, which is the only place the distinction exists.
    expect(parseTruths("09-missing", undefined)).toBeUndefined();
    expect(parseTruths("09-empty", [])).toEqual([]);

    // Non-array: the silent-[] hole that stays closed — a promise of criteria with no list to hold them.
    const notArray = () => compileGsd(scratchPhase("09-scalar", truthsPlan("truth one holds")));
    expect(notArray).toThrow(CompileError);
    expect(notArray).toThrow(/must_haves\.truths that is not a list/);
    // The container branch renders the offending value too, so a recursive-alias container must reach
    // the same CompileError rather than a TypeError out of the renderer.
    const recursive = () => compileGsd(scratchPhase("09-recursive-map", planWith("must_haves:\n  truths: &m {k: *m}\n")));
    expect(recursive).toThrow(CompileError);
    expect(recursive).toThrow(/must_haves\.truths that is not a list/);
  });

  test("every truth reaches a worker prompt as its rendered typed value, proven by compiling the closed set above and asserting each prompt carries that value rather than the literal object placeholder, so the criterion fails on an empty render instead of passing on one", () => {
    const forms: Array<[string, AcceptanceItem]> = [
      ["plain string", "truth one holds"],
      ["dual-key command", { oracle: "command", command: "npm test", text: "npm test exits 0" }],
      ["dual-key test", { oracle: "test", test: "gsd truths", text: "the gsd truths suite goes green" }],
      ["bare command", { oracle: "command", command: "npm run lint" }],
      ["bare test", { oracle: "test", test: "compileGsd fail-closed" }],
      ["judge", { oracle: "judge", text: "the widget behaves under load" }],
    ];
    for (const [name, item] of forms) {
      const dir = scratchPhase(`09-prompt-${name.replace(/\s+/g, "-")}`, truthsPlan([item]));
      const task = compileGsd(dir).tasks[0];
      const rendered = renderAcceptanceItem(task.acceptance[1]);
      // Without this, an empty render would make the includes() below vacuously true.
      expect(rendered.length, `${name} must render to something`).toBeGreaterThan(0);
      const prompt = buildTaskPrompt(task);
      expect(prompt, name).toContain(`- ${rendered}`);
      expect(prompt, name).not.toContain("[object Object]");
    }
  });
});
