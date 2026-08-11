import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { CompileError } from "../../src/compile/common.js";
import { compileSource } from "../../src/compile/index.js";
import type { AcceptanceItem } from "../../src/graph/schema.js";

function compileNativeText(body: string) {
  const file = join(mkdtempSync(join(tmpdir(), "tickmarkr-obs488-")), "spec.md");
  writeFileSync(file, `<!-- tickmarkr:spec -->\n${body}`);
  return compileSource(file, "native");
}

// OBS-488: 1.87.0 silently dropped wrapped acceptance lines — 53/78 of run-551's criteria
// compiled to first-line stubs and every falsifier tail was invisible to the judge.
describe("acceptance list-item continuations (OBS-488)", () => {
  test("a lone one-word continuation tail joins its criterion (run-551 T61 c3 shape)", () => {
    const g = compileNativeText(
      "## T1: Tail\n- acceptance:\n  - judge: every worktree and CPU input in the suite arrives from the launch observation or the T60\n    seam\n",
    );
    expect(g.tasks[0].acceptance).toEqual([
      { oracle: "judge", text: "every worktree and CPU input in the suite arrives from the launch observation or the T60 seam" },
    ]);
  });

  test("a criterion wrapped across five physical lines compiles to its full joined text", () => {
    const g = compileNativeText([
      "## T1: Wrapped",
      "- acceptance:",
      "  - test: with unchanged worktree and flat classification a delivered nudge",
      "    holds its whole grace through a blocked status flip",
      "    and concludes at expiry, while the no-nudge control concludes at the base deadline,",
      "    so a recomputed",
      "    or erased grace fails",
      "",
    ].join("\n"));
    expect(g.tasks[0].acceptance).toEqual([{
      oracle: "test",
      test: "with unchanged worktree and flat classification a delivered nudge holds its whole grace through a blocked status flip and concludes at expiry, while the no-nudge control concludes at the base deadline, so a recomputed or erased grace fails",
    }]);
  });

  test("typed-oracle parsing runs on the complete joined text, not line 1", () => {
    // an empty-bodied prefix on line 1 whose value arrives on the continuation line is a
    // complete oracle; the same prefix with no continuation still fails loudly (native.test.ts)
    const g = compileNativeText("## T1: Order\n- acceptance:\n  - command:\n    npm test\n");
    expect(g.tasks[0].acceptance).toEqual([{ oracle: "command", command: "npm test" }]);
  });

  test("gates list items join wrapped continuations and validation sees the joined name", () => {
    expect(() => compileNativeText("## T1: G\n- gates:\n  - build\n  - te\n    st\n- acceptance:\n  - ok\n"))
      .toThrow(/invalid gate "te st"/);
  });

  test("a blank line ends an item's continuation region", () => {
    // the resumed indented line reaches no rule and must fail closed, not join silently
    expect(() => compileNativeText("## T1: Gap\n- acceptance:\n  - judge: first half\n\n    orphaned tail\n"))
      .toThrow(CompileError);
  });
});

// Survival check per RULING-CRITERIA-TRUNCATION amendment 10: compiled acceptance content ==
// source acceptance content, both directions, zero tolerance. The expected side is DERIVED from
// the fixture's bytes, never pinned — a survival check that compares source to source is not a
// survival check, and a pinned count is a hand-derived exclusion waiting to bite.
describe("wrapped-fixture survival (compiled criteria == source criteria)", () => {
  const FIXTURE = "fixtures/wrapped-acceptance.native.md";

  function deriveAcceptance(source: string): { items: string[]; wrapped: number } {
    const items: string[] = [];
    let inList = false;
    let wrapped = 0;
    let lastWrapped = false;
    for (const line of source.split("\n")) {
      if (/^## T\d+:/.test(line)) { inList = false; continue; }
      if (/^- acceptance:/.test(line)) { inList = true; continue; }
      if (/^- \w+:/.test(line)) { inList = false; continue; }
      if (!inList) continue;
      const item = line.match(/^\s+- (.+)$/);
      if (item) { items.push(item[1].trim()); lastWrapped = false; continue; }
      if ((line.startsWith(" ") || line.startsWith("\t")) && line.trim() && items.length) {
        items[items.length - 1] += ` ${line.trim()}`;
        if (!lastWrapped) { wrapped++; lastWrapped = true; }
      }
    }
    return { items, wrapped };
  }

  const asText = (item: AcceptanceItem): string =>
    typeof item === "string" ? item
      : item.oracle === "command" ? `command: ${item.command}`
      : item.oracle === "test" ? `test: ${item.test}`
      : `judge: ${item.text}`;

  test("every compiled criterion carries its complete source content, zero tolerance", () => {
    const source = readFileSync(FIXTURE, "utf8");
    const derived = deriveAcceptance(source);
    // the control must be an instance of what it catches: the fixture must actually wrap,
    // and its recorded lone-tail counterexample must be present, or this test proves nothing
    expect(derived.wrapped).toBeGreaterThan(0);
    expect(derived.items.some((item) => item.endsWith("or the T60 seam"))).toBe(true);

    const g = compileSource(FIXTURE, "native");
    const compiled = g.tasks.flatMap((task) => task.acceptance.map(asText));
    // strict equality is both directions: no source criterion missing from the graph, no graph
    // criterion absent from (or truncated relative to) the source
    expect(compiled).toEqual(derived.items);
  });
});

// OBS-488 fail-closed invariant, positive control (spec-authoring rule 11: a guard that has
// never fired is not a guard): the unconsumed-line error must actually fire, naming task, line
// number, and the dropped bytes.
describe("unconsumed-line fail-closed error (OBS-488)", () => {
  test("a dangling indented line no rule consumes fails compile naming task, line, and bytes", () => {
    const src = "## T4: Dangling\n- shape: chore\n    stray indented prose\n- acceptance:\n  - ok\n";
    expect(() => compileNativeText(src)).toThrow(CompileError);
    expect(() => compileNativeText(src)).toThrow(/Task T4 line 4/);
    expect(() => compileNativeText(src)).toThrow(/stray indented prose/);
  });

  test("column-zero prose inside a task block fails compile instead of silently dropping (corpus shape)", () => {
    // the recorded instances: "AMENDMENT USE: ..." (v1.86 T25), "DRAFT-END ..." (v1.90 T68)
    const src = "## T5: Marker\n- acceptance:\n  - ok\n\nDRAFT-END authoring\n";
    expect(() => compileNativeText(src)).toThrow(/Task T5 line 6/);
    expect(() => compileNativeText(src)).toThrow(/DRAFT-END authoring/);
  });

  test("legitimate forms still compile: front-matter prose, blank lines, field continuations", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const g = compileNativeText([
        "# heading and prose before the first task are front matter",
        "",
        "## T1: Clean",
        "- goal: a goal that wraps",
        "  onto a second line",
        "- files: src/a.ts,",
        "  src/b.ts",
        "",
        "- acceptance:",
        "  - ok",
        "",
        "## T2: Second",
        "- acceptance:",
        "  - also ok",
        "",
      ].join("\n"));
      expect(g.tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
      expect(g.tasks[0].goal).toBe("a goal that wraps\nonto a second line");
      expect(g.tasks[0].files).toEqual(["src/a.ts", "src/b.ts"]);
    } finally {
      warn.mockRestore();
    }
  });
});
