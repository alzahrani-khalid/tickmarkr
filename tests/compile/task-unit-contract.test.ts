// OBS-212 / OBS-214: the Task Unit Contract. These are compile ERRORS because the failures they
// prevent are invisible until they have already cost hours — run-20260728-110135 lost 32 verified
// commits to two unordered tasks that wrote the same files, and spent 28 dispatches on one task
// carrying 8 acceptance items without ever passing review.
import { describe, expect, test } from "vitest";
import {
  MAX_ACCEPTANCE_ITEMS, MAX_FILES_PATTERNS,
  separabilityErrors, taskBudgetErrors,
} from "../../src/compile/collateral.js";

const item = (t: string) => ({ kind: "test" as const, text: t });
const task = (id: string, files: string[], deps: string[] = [], items = 1) => ({
  id, files, deps, acceptance: Array.from({ length: items }, (_, i) => item(`${id} criterion ${i}`)),
});

describe("separability (OBS-212)", () => {
  test("unordered tasks writing the same file are an error naming both and the path", () => {
    const errs = separabilityErrors([
      task("T1", ["src/a.ts", "src/b.ts"]),
      task("T2", ["src/b.ts", "src/c.ts"]),
    ]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("T1 and T2");
    expect(errs[0]).toContain("src/b.ts");
    expect(errs[0]).not.toContain("src/a.ts"); // only the shared path is named
  });

  test("a dependency edge makes the overlap legal — ordered tasks cannot race", () => {
    expect(separabilityErrors([
      task("T1", ["src/b.ts"]),
      task("T2", ["src/b.ts"], ["T1"]),
    ])).toEqual([]);
  });

  test("ordering is TRANSITIVE — an indirect edge is still an ordering", () => {
    // T3 -> T2 -> T1, so T1 and T3 can never run concurrently
    expect(separabilityErrors([
      task("T1", ["src/b.ts"]),
      task("T2", [], ["T1"]),
      task("T3", ["src/b.ts"], ["T2"]),
    ])).toEqual([]);
  });

  test("a glob that swallows another task's literal path is an overlap", () => {
    const errs = separabilityErrors([
      task("T1", ["tests/fixtures/frames/**"]),
      task("T2", ["tests/fixtures/frames/run.80x24.txt"]),
    ]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("tests/fixtures/frames/run.80x24.txt");
  });

  test("disjoint writers are silent — the rule never invents an error", () => {
    expect(separabilityErrors([
      task("T1", ["src/a.ts"]),
      task("T2", ["src/b.ts"]),
      task("T3", ["docs/x.md"]),
    ])).toEqual([]);
  });

  test("the v1.83 collision shape reproduces: two unordered siblings sharing six paths", () => {
    // the real pair — T1 and T2 of run-20260728-110135, whose overlap destroyed 15 commits at 21:37
    const shared = ["src/tui/cockpit/live.ts", "src/tui/cockpit/run-cockpit.tsx",
      "tests/cockpit/frames.test.ts", "tests/cockpit/live.test.ts"];
    const errs = separabilityErrors([
      task("T1", [...shared, "src/tui/cockpit/layout.ts"]),
      task("T2", [...shared, "src/tui/cockpit/keys.ts"]),
    ]);
    expect(errs).toHaveLength(1);
    for (const p of shared) expect(errs[0]).toContain(p);
  });
});

describe("task budget (OBS-214)", () => {
  test("more acceptance items than the cap is an error naming the count", () => {
    const errs = taskBudgetErrors([task("T1", ["src/a.ts"], [], MAX_ACCEPTANCE_ITEMS + 2)]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(`${MAX_ACCEPTANCE_ITEMS + 2} acceptance items`);
  });

  test("exactly at the cap is legal — the bound is inclusive", () => {
    expect(taskBudgetErrors([
      task("T1", Array.from({ length: MAX_FILES_PATTERNS }, (_, i) => `src/f${i}.ts`), [], MAX_ACCEPTANCE_ITEMS),
    ])).toEqual([]);
  });

  test("too wide a write surface is an error, independently of criteria count", () => {
    const errs = taskBudgetErrors([
      task("T1", Array.from({ length: MAX_FILES_PATTERNS + 1 }, (_, i) => `src/f${i}.ts`), [], 1),
    ]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("files[] patterns");
  });
});
