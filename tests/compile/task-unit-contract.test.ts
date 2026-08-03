// OBS-212 / OBS-214: the Task Unit Contract. These are compile ERRORS because the failures they
// prevent are invisible until they have already cost hours — run-20260728-110135 lost 32 verified
// commits to two unordered tasks that wrote the same files, and spent 28 dispatches on one task
// carrying 8 acceptance items without ever passing review.
import { describe, expect, test } from "vitest";
import {
  MAX_ACCEPTANCE_ITEMS, MAX_FILES_PATTERNS,
  separabilityErrors, taskBudgetErrors,
} from "../../src/compile/collateral.js";
import {
  MAX_GOAL_WORDS_PER_CRITERION, MAX_TASK_SURFACE,
  goalDensityErrors, surfaceErrors, symbolOwnershipErrors, taskUnitContractErrors,
} from "../../src/compile/collateral.js";
import { compileNative } from "../../src/compile/native.js";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

// ── R2 velocity lints (OVERSEER-RULING-20260731-velocity) ───────────────────────────────────
// The lints below refuse at compile time the task shapes that cost v1.84's T1 nine review rounds.

const oracle = (kind: "test" | "judge", text: string) =>
  kind === "test" ? { oracle: "test" as const, test: text } : { oracle: "judge" as const, text };

const unit = (id: string, files: string[], acceptance: ReturnType<typeof oracle>[], goal = "do it") => ({
  id, files, deps: [], goal, acceptance,
});

/** A throwaway repo root with the given source files (path → body). */
function fakeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-r2-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe("R2 surface bound", () => {
  test("a task with acceptance-times-files surface above twenty-four fails compile naming the task and the product", () => {
    // mixed oracles on purpose: judge criteria count toward the surface exactly like test criteria
    const t = unit("T9", ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"], [
      oracle("test", "criterion 0 holds"), oracle("judge", "criterion 1 holds"),
      oracle("test", "criterion 2 holds"), oracle("judge", "criterion 3 holds"),
      oracle("test", "criterion 4 holds"),
    ]);
    const errs = taskUnitContractErrors([t]);
    expect(errs.some((e) => e.includes("T9") && e.includes("25"))).toBe(true); // 5 × 5 = 25
    const surf = surfaceErrors([t]);
    expect(surf).toHaveLength(1);
    expect(surf[0]).toContain("T9");
    expect(surf[0]).toContain(`${MAX_TASK_SURFACE}`);
  });

  test("exactly twenty-four is legal, and judge criteria count toward the surface", () => {
    // 4 criteria (2 test + 2 judge) × 6 files = 24 — the bound is inclusive
    expect(surfaceErrors([
      unit("T1", ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"], [
        oracle("test", "criterion 0"), oracle("judge", "criterion 1"),
        oracle("test", "criterion 2"), oracle("judge", "criterion 3"),
      ]),
    ])).toEqual([]);
    // nine judge criteria across three files = 27 — judge-heavy tasks get the same bound
    const judgeHeavy = unit("T2", ["src/a.ts", "src/b.ts", "src/c.ts"],
      Array.from({ length: 9 }, (_, i) => oracle("judge", `judgement ${i}`)));
    const surf = surfaceErrors([judgeHeavy]);
    expect(surf).toHaveLength(1);
    expect(surf[0]).toContain("T2");
    expect(surf[0]).toContain("27");
  });

  test("a recorded contract exception matches exactly one historical task shape and no other", () => {
    // v1.79 T5's exact shape (id + acceptance count + full files[]) rides the recorded amendment…
    const v179t5 = unit("T5", [
      "src/gates/llm.ts", "src/gates/acceptance.ts", "src/gates/review.ts", "src/adapters/prompt.ts",
      "tests/gates/acceptance.test.ts", "tests/gates/review.test.ts", "tests/gates/judge-retry.test.ts",
    ], Array.from({ length: 4 }, (_, i) => oracle("test", `criterion ${i}`)));
    expect(surfaceErrors([v179t5])).toEqual([]);
    // …and the exception is load-bearing: strip it and the same task measures 4×7=28 over the bound
    const stripped = surfaceErrors([v179t5], []);
    expect(stripped).toHaveLength(1);
    expect(stripped[0]).toContain("28");
    // one file different and it is no longer the recorded task — the exception cannot be ridden
    const ridden = { ...v179t5, files: v179t5.files.map((f) => (f === "src/adapters/prompt.ts" ? "src/adapters/other.ts" : f)) };
    expect(surfaceErrors([ridden])).toHaveLength(1);
    // same id and files but a different criterion count is not the recorded task either
    const fatter = { ...v179t5, acceptance: [...v179t5.acceptance, oracle("judge", "one more")] };
    expect(surfaceErrors([fatter])).toHaveLength(1); // 5×7=35 — acceptance count blocks the match
  });
});

describe("R2 goal-density bound", () => {
  test("a task whose goal exceeds sixty words per acceptance criterion fails compile naming the ratio", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
    const t = unit("T8", ["src/a.ts"], [oracle("test", "it works"), oracle("judge", "it is honest")], words(130));
    const errs = taskUnitContractErrors([t]);
    expect(errs.some((e) => e.includes("T8") && e.includes("65"))).toBe(true); // 130 ÷ 2 = 65
    const dens = goalDensityErrors([t]);
    expect(dens).toHaveLength(1);
    expect(dens[0]).toContain("65");
    expect(dens[0]).toContain(`${MAX_GOAL_WORDS_PER_CRITERION}`);
  });

  test("a tight goal over few criteria stays silent, and bare dashes are not words", () => {
    expect(goalDensityErrors([
      unit("T1", ["src/a.ts"], [oracle("test", "x"), oracle("judge", "y")], "ship the thing — cleanly — today"),
    ])).toEqual([]);
  });

  test("sixty-one non-Latin words per criterion fails — the word count is not ASCII-only", () => {
    // 61 Arabic words over 1 criterion = 61 > 60; an ASCII-only counter reads this as zero words
    const arabic = (n: number) => Array.from({ length: n }, () => "كلمة").join(" ");
    const over = unit("T7", ["src/a.ts"], [oracle("test", "it works")], arabic(61));
    const dens = goalDensityErrors([over]);
    expect(dens).toHaveLength(1);
    expect(dens[0]).toContain("T7");
    expect(dens[0]).toContain("61");
    // the same sixty-word goal is exactly at the bound and stays legal
    expect(goalDensityErrors([
      unit("T7", ["src/a.ts"], [oracle("test", "it works")], arabic(60)),
    ])).toEqual([]);
  });
});

describe("R2 symbol ownership (OBS-248)", () => {
  test("a criterion naming an identifier defined uniquely outside the task's files fails compile naming the definition site", () => {
    const root = fakeRepo({
      "src/tui/cockpit/layout.ts": "export function plannedThing(width: number) { return width; }\n",
      "src/tui/cockpit/pointer.ts": "import { plannedThing } from './layout.js';\n",
    });
    const t = unit("T1", ["src/tui/cockpit/pointer.ts", "tests/cockpit/pointer.test.ts"],
      [oracle("judge", "every hit resolves through plannedThing's regions")]);
    const errs = taskUnitContractErrors([t], root);
    expect(errs.some((e) => e.includes("T1") && e.includes("plannedThing") && e.includes("src/tui/cockpit/layout.ts"))).toBe(true);
  });

  test("ambiguous or unknown tokens stay silent — only a unique out-of-scope definition fails", () => {
    const root = fakeRepo({
      "src/a/one.ts": "export const sharedHelper = 1;\nexport const lonelyHelper = 1;\n",
      "src/b/two.ts": "export function sharedHelper() { return 2; }\n",
    });
    expect(symbolOwnershipErrors([
      unit("T1", ["src/c/x.ts"], [oracle("judge", "sharedHelper drives it"), oracle("test", "ghostSymbol never defined")]),
    ], root)).toEqual([]);
  });

  test("a definition inside files[] — literal or glob — is ownership, not a violation", () => {
    const root = fakeRepo({ "src/tui/layout.ts": "export function plannedThing() {}\n" });
    expect(symbolOwnershipErrors([
      unit("T1", ["src/tui/layout.ts"], [oracle("judge", "plannedThing owns geometry")]),
      unit("T2", ["src/tui/**"], [oracle("judge", "plannedThing owns geometry")]),
    ], root)).toEqual([]);
  });

  test("plain-language criteria carry no code identifiers and stay silent", () => {
    const root = fakeRepo({ "src/a.ts": "export const anything = 1;\n" });
    expect(symbolOwnershipErrors([
      unit("T1", ["src/b.ts"], [oracle("test", "the wheel scrolls the panel under the pointer")]),
    ], root)).toEqual([]);
  });

  test("a compiled mirror under dist/ is not a definition site — the src/ original stays unique", () => {
    // the test gate's pretest rebuilds dist/; indexing it would double every src/ definition
    // into false ambiguity and silence the lint exactly when the suite runs for real
    const root = fakeRepo({
      "src/a.ts": "export function builtThing() { return 1; }\n",
      "dist/a.js": "export function builtThing() { return 1; }\n",
    });
    const errs = symbolOwnershipErrors([
      unit("T1", ["src/b.ts"], [oracle("judge", "builtThing owns the flow")]),
    ], root);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("src/a.ts");
  });

  test("a unique definition in a code root outside src/ still fails compile naming the site", () => {
    // the advisory scanner only walks src/; the blocking lint indexes every code root
    const root = fakeRepo({
      "scripts/tooling.ts": "export function deployScriptHelper() { return 1; }\n",
      "src/a.ts": "export const unrelated = 1;\n",
    });
    const errs = symbolOwnershipErrors([
      unit("T1", ["src/a.ts"], [oracle("judge", "deploys flow through deployScriptHelper")]),
    ], root);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("T1");
    expect(errs[0]).toContain("deployScriptHelper");
    expect(errs[0]).toContain("scripts/tooling.ts");
  });

  test("a unique definition beyond the advisory scanner's four-hundred-file cap still fails compile", () => {
    // 400 fillers sort ahead of the definition site — the capped advisory walk never reaches it
    const files = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`src/mod/f${String(i).padStart(3, "0")}.ts`, "export const x = 1;\n"]),
    );
    files["src/mod/f400.ts"] = "export function deepBuriedHelper() { return 1; }\n";
    const root = fakeRepo(files);
    const errs = symbolOwnershipErrors([
      unit("T1", ["src/other.ts"], [oracle("test", "deepBuriedHelper returns one")]),
    ], root);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("src/mod/f400.ts");
  });

  test("a unique definition in a file over the advisory size cap still fails compile", () => {
    const root = fakeRepo({
      "src/big/huge.ts": `// ${"x".repeat(600 * 1024)}\nexport function hugeFileThing() { return 1; }\n`,
    });
    const errs = symbolOwnershipErrors([
      unit("T1", ["src/other.ts"], [oracle("judge", "hugeFileThing owns the flow")]),
    ], root);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("src/big/huge.ts");
  });

  test("an unreadable code file fails the lint closed naming the path — a partial index is never trusted", () => {
    const root = fakeRepo({
      "src/locked.ts": "export function lockedAwayThing() { return 1; }\n",
      "src/open.ts": "export const openThing = 1;\n",
    });
    chmodSync(join(root, "src/locked.ts"), 0o000);
    try {
      const errs = symbolOwnershipErrors([
        unit("T1", ["src/open.ts"], [oracle("judge", "lockedAwayThing owns the flow")]),
      ], root);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toContain("T1");
      expect(errs[0]).toContain("src/locked.ts");
      expect(errs[0]).toContain("unreadable");
      expect(errs[0]).toMatch(/—\s+\S/); // a corrective instruction, not just a complaint
    } finally {
      chmodSync(join(root, "src/locked.ts"), 0o644);
    }
  });
});

describe("R2 calibration corpus", () => {
  test("v1.84's original T1 fails all applicable lints and v1.79's tasks pass them — the calibration corpus is pinned", () => {
    const root = process.cwd();
    // The corpus pins the pre-amendment T1: commits 5b00ec54 (OBS-248) and b4274d6f later added
    // layout.ts and its test to T1's files[] — removing them reproduces the original task exactly.
    const v184 = compileNative("specs/v1.84-pointer.spec.md");
    const t1 = v184.tasks.find((t) => t.id === "T1")!;
    const original = {
      ...t1,
      files: t1.files.filter((f) => f !== "src/tui/cockpit/layout.ts" && f !== "tests/cockpit/layout.test.ts"),
    };
    expect(original.files).toHaveLength(5); // the amendment really did add exactly those two
    // the pin itself: the planFrame law and its definition site both still exist
    expect(t1.acceptance.some((a) => typeof a === "object" && a.oracle === "judge" && a.text.includes("planFrame"))).toBe(true);
    expect(readFileSync("src/tui/cockpit/layout.ts", "utf8")).toMatch(/export function planFrame\b/);

    const surf = surfaceErrors([original]); // 6 criteria × 5 files = 30 — EVERY criterion counts
    expect(surf).toHaveLength(1);
    expect(surf[0]).toContain("T1");
    expect(surf[0]).toContain("30");
    const own = symbolOwnershipErrors([original], root); // planFrame lives outside the original files[]
    expect(own).toHaveLength(1);
    expect(own[0]).toContain("planFrame");
    expect(own[0]).toContain("src/tui/cockpit/layout.ts");
    // Goal-density is the one R2 lint NOT applicable to the committed corpus: the velocity consult
    // estimated ~450 goal words (75 per criterion) at ruling time, but the goal as ever committed or
    // dispatched measures 287 ÷ 6 ≈ 48 — under the 60 bound. Pin that measurement: a rewrite that
    // re-bloats the goal past the bound turns this pin red instead of silently passing.
    const goalWords = original.goal.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    expect(goalWords).toBe(287);
    expect(goalDensityErrors([original])).toEqual([]);

    const v179 = compileNative("specs/v1.79-signal-truth.spec.md");
    expect(v179.tasks.length).toBeGreaterThan(0);
    expect(surfaceErrors(v179.tasks)).toEqual([]);
    expect(goalDensityErrors(v179.tasks)).toEqual([]);
    expect(symbolOwnershipErrors(v179.tasks, root)).toEqual([]);
    // …and the pass is honest: v1.79's T5 measures 4×7=28, over the bound, and rides the RECORDED
    // contract exception (SURFACE_CONTRACT_EXCEPTIONS — the explicit amendment the R2 review
    // demanded), not a narrowed metric. Strip the exceptions and the pin turns red.
    const v179t5 = v179.tasks.find((t) => t.id === "T5")!;
    const stripped = surfaceErrors([v179t5], []);
    expect(stripped).toHaveLength(1);
    expect(stripped[0]).toContain("T5");
    expect(stripped[0]).toContain("28");
  });
});

describe("R2 error actionability", () => {
  test("every lint error is actionable from its message alone", () => {
    const root = fakeRepo({ "src/owned/defs.ts": "export function soleOwner() {}\n" });
    const offenders = [
      unit("T1", ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
        Array.from({ length: 5 }, (_, i) => oracle("test", `criterion ${i}`))),
      unit("T2", ["src/z.ts"], [oracle("test", "x")], Array.from({ length: 61 }, (_, i) => `w${i}`).join(" ")),
      unit("T3", ["src/other.ts"], [oracle("judge", "geometry flows through soleOwner")]),
    ];
    const errs = taskUnitContractErrors(offenders, root);
    expect(errs).toHaveLength(3);
    for (const [i, id] of ["T1", "T2", "T3"].entries()) {
      expect(errs[i]).toContain(id); // the offending task
      expect(errs[i]).toMatch(/—\s+\S/); // a corrective instruction, not just a complaint
    }
    // each names its measured value AND its bound (or the definition site, which IS the bound)
    expect(errs[0]).toContain("25");
    expect(errs[0]).toContain(`${MAX_TASK_SURFACE}`);
    expect(errs[1]).toContain("61");
    expect(errs[1]).toContain(`${MAX_GOAL_WORDS_PER_CRITERION}`);
    expect(errs[2]).toContain("soleOwner");
    expect(errs[2]).toContain("src/owned/defs.ts");
    expect(errs[2]).toContain("files[]");
  });
});
