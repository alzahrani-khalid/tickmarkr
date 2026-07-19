import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import picomatch from "picomatch";
import { describe, expect, test } from "vitest";
import { CompileError } from "../../src/compile/common.js";
import { compileGsd } from "../../src/compile/gsd.js";
import { compileSource } from "../../src/compile/index.js";

const PHASE = "fixtures/gsd-sample/07-live-check";

function scratchPhase(name: string, files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "tickmarkr-gsd-")), name);
  mkdirSync(dir);
  for (const [f, content] of Object.entries(files)) writeFileSync(join(dir, f), content);
  return dir;
}

const plan = (fm: string, body: string) => `---\n${fm}\n---\n\n${body}\n`;
const doneTask = (done: string) => `<tasks>\n<task type="auto">\n  <name>Task 1</name>\n  <done>${done}</done>\n</task>\n</tasks>`;

describe("compileGsd (committed fixture phase)", () => {
  test("phase dir → one task per plan: ids, deps, scope, acceptance, humanGate, done-detection", () => {
    const g = compileGsd(PHASE);
    expect(g.spec.source).toBe("gsd");
    expect(g.spec.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(g.tasks.map((t) => t.id)).toEqual(["P07-01", "P07-02", "P07-03"]);

    const [p1, p2, p3] = g.tasks;
    expect(p1.deps).toEqual([]);
    expect(p2.deps).toEqual(["P07-01"]);
    expect(p1.files).toEqual(["src/**"]);
    // every <done> line + must_haves.truths land verbatim
    expect(p1.acceptance).toEqual([
      "widget builds green",
      "widget is wired and demoed",
      "truth A holds in the shipped artifact",
    ]);
    expect(p1.title).toBe("Implement the first objective sentence.");
    expect(p1.complexity).toBe(5); // 2·tasks + truths
    expect(p1.humanGate).toBe(false);
    expect(p2.humanGate).toBe(true); // checkpoint task → humanGate
    expect(p3.status).toBe("done"); // sibling SUMMARY.md = GSD's completion marker
    expect(p1.status).toBe("pending");
  });

  test("context keeps the plan file first; only repo-relative @-refs from the <context> block", () => {
    const ctx = compileGsd(PHASE).tasks[0].context;
    expect(ctx[0].endsWith("07-01-PLAN.md")).toBe(true);
    expect(ctx).toContain(".planning/PROJECT.md");
    expect(ctx.some((c) => c.includes("$HOME") || c.includes("~/"))).toBe(false);
  });

  test("absolute src + root → context[0] stored repo-relative (worktree isolation)", () => {
    const abs = resolve(PHASE);
    const g = compileGsd(abs, resolve("."));
    expect(g.tasks[0].context[0]).toBe(join(PHASE, "07-01-PLAN.md"));
    expect(g.tasks[0].context[0].startsWith("/")).toBe(false);
  });

  test("single PLAN.md path compiles just that plan; external deps dropped", () => {
    const g = compileGsd(join(PHASE, "07-02-PLAN.md"));
    expect(g.tasks.map((t) => t.id)).toEqual(["P07-02"]);
    expect(g.tasks[0].deps).toEqual([]); // 07-01 is outside this graph
  });
});

describe("compileGsd fail-closed + hardening", () => {
  test("no <done> lines and no truths → CompileError naming the file", () => {
    const dir = scratchPhase("08-bad", {
      "08-01-PLAN.md": plan('phase: 08-bad\nplan: "01"\ntype: execute', "<objective>\nVague.\n</objective>\n\n<tasks>\n<task type=\"auto\">\n  <name>T</name>\n</task>\n</tasks>"),
    });
    expect(() => compileGsd(dir)).toThrow(CompileError);
    expect(() => compileGsd(dir)).toThrow(/08-01-PLAN\.md/);
  });

  test("malformed YAML frontmatter fails closed (a typo must not drop autonomous:false)", () => {
    const dir = scratchPhase("09-yaml", {
      "09-01-PLAN.md": plan("autonomous: false\n  bad_indent: [unclosed", doneTask("d")),
    });
    expect(() => compileGsd(dir)).toThrow(CompileError);
    expect(() => compileGsd(dir)).toThrow(/malformed YAML/);
  });

  test("autonomous: false alone gates the task; CRLF frontmatter still parses", () => {
    const crlf = plan("autonomous: false", `<objective>\nGated work. Rest.\n</objective>\n\n${doneTask("gated done")}`).replaceAll("\n", "\r\n");
    const dir = scratchPhase("10-gate", { "10-01-PLAN.md": crlf });
    const g = compileGsd(dir);
    expect(g.tasks[0].humanGate).toBe(true);
    expect(g.tasks[0].acceptance).toEqual(["gated done"]);
  });

  test("numeric depends_on (YAML strips zero-padding) still resolves to the padded sibling", () => {
    const dir = scratchPhase("11-pad", {
      "06-PLAN.md": plan("plan: 06", `<objective>\nSix. x\n</objective>\n\n${doneTask("six done")}`),
      "07-PLAN.md": plan("plan: 07\ndepends_on:\n  - 6", `<objective>\nSeven. x\n</objective>\n\n${doneTask("seven done")}`),
    });
    const g = compileGsd(dir);
    expect(g.tasks.map((t) => t.id)).toEqual(["P06", "P07"]);
    expect(g.tasks[1].deps).toEqual(["P06"]);
  });

  test("bare numeric depends_on resolves to the matching plan number within a phase", () => {
    const dir = scratchPhase("11-bare-int", {
      "21-01-PLAN.md": plan("plan: 01", `<objective>\nOne. x\n</objective>\n\n${doneTask("one done")}`),
      "21-05-PLAN.md": plan("plan: 05\ndepends_on: [01]", `<objective>\nFive. x\n</objective>\n\n${doneTask("five done")}`),
    });
    const g = compileGsd(dir);
    expect(g.tasks.map((t) => t.id)).toEqual(["P21-01", "P21-05"]);
    expect(g.tasks[1].deps).toEqual(["P21-01"]);
  });

  test("bare zero-padded string depends_on resolves to the matching plan number within a phase", () => {
    const dir = scratchPhase("11-bare-string", {
      "21-01-PLAN.md": plan("plan: 01", `<objective>\nOne. x\n</objective>\n\n${doneTask("one done")}`),
      "21-05-PLAN.md": plan('plan: 05\ndepends_on: ["01"]', `<objective>\nFive. x\n</objective>\n\n${doneTask("five done")}`),
    });
    const g = compileGsd(dir);
    expect(g.tasks.map((t) => t.id)).toEqual(["P21-01", "P21-05"]);
    expect(g.tasks[1].deps).toEqual(["P21-01"]);
  });

  test("ambiguous bare plan aliases fail closed instead of picking an arbitrary dependency", () => {
    const dir = scratchPhase("11-bare-ambiguous", {
      "21-01-PLAN.md": plan("plan: 01", `<objective>\nOne. x\n</objective>\n\n${doneTask("one done")}`),
      "22-01-PLAN.md": plan("plan: 01", `<objective>\nOther one. x\n</objective>\n\n${doneTask("other one done")}`),
      "22-05-PLAN.md": plan("plan: 05\ndepends_on: [01]", `<objective>\nFive. x\n</objective>\n\n${doneTask("five done")}`),
    });
    expect(() => compileGsd(dir)).toThrow(/depends on "1"/);
  });

  test("phase compile with an unresolvable dep fails loudly instead of dropping the edge", () => {
    const dir = scratchPhase("12-lost", {
      "12-01-PLAN.md": plan('depends_on: ["99-99"]', `<objective>\nOrphan. x\n</objective>\n\n${doneTask("d")}`),
    });
    expect(() => compileGsd(dir)).toThrow(/depends on "99-99"/);
  });

  test("dotted/odd filenames sanitize into schema-legal ids; files lose './' prefixes", () => {
    const dir = scratchPhase("13-san", {
      "1.2-PLAN.md": plan("files_modified:\n  - ./src/a.ts", `<objective>\nDotty. x\n</objective>\n\n${doneTask("d")}`),
    });
    const g = compileGsd(dir);
    expect(g.tasks[0].id).toBe("P1-2");
    expect(g.tasks[0].files).toEqual(["src/a.ts"]);
  });

  test("..-traversal refs and @-lines outside <context> never reach context[]", () => {
    const body = `<objective>\nSafe. x\n</objective>\n\n<context>\n@.planning/ok.md\n@../../outside.md\n</context>\n\n@not-context-ref\n\n${doneTask("d")}`;
    const dir = scratchPhase("14-refs", { "14-01-PLAN.md": plan("plan: 1", body) });
    const ctx = compileGsd(dir).tasks[0].context;
    expect(ctx).toContain(".planning/ok.md");
    expect(ctx.some((c) => c.includes("..") || c.includes("not-context-ref"))).toBe(false);
  });

  test("unpadded plan numbers order numerically, not lexically", () => {
    const mk = (n: string) => plan(`plan: ${n}`, `<objective>\nP${n}. x\n</objective>\n\n${doneTask("d")}`);
    const dir = scratchPhase("15-sort", { "1-PLAN.md": mk("1"), "2-PLAN.md": mk("2"), "10-PLAN.md": mk("10") });
    expect(compileGsd(dir).tasks.map((t) => t.id)).toEqual(["P1", "P2", "P10"]);
  });

  test("missing src → CompileError, not raw ENOENT (--type gsd bypasses detection)", () => {
    expect(() => compileGsd("/nope/does-not-exist")).toThrow(CompileError);
  });

  test("abbreviations don't truncate the title", () => {
    const dir = scratchPhase("16-title", {
      "16-01-PLAN.md": plan("plan: 1", `<objective>\nSupport configs (e.g. JSON) end to end. Later prose.\n</objective>\n\n${doneTask("d")}`),
    });
    expect(compileGsd(dir).tasks[0].title).toBe("Support configs (e.g. JSON) end to end.");
  });

  test("routing.floor frontmatter compiles to routingHints.floor + plan-basename source stamp", () => {
    const dir = scratchPhase("17-floor", {
      "17-01-PLAN.md": plan("plan: 1\nrouting:\n  floor: mid", doneTask("d")),
    });
    const g = compileGsd(dir);
    expect(g.tasks[0].routingHints).toEqual({ floor: "mid", source: "17-01-PLAN.md" });
  });

  test("routing.pin frontmatter compiles to routingHints.pin + source stamp", () => {
    const dir = scratchPhase("18-pin", {
      "18-01-PLAN.md": plan("plan: 1\nrouting:\n  pin:\n    via: claude-code\n    model: fable", doneTask("d")),
    });
    const g = compileGsd(dir);
    expect(g.tasks[0].routingHints).toEqual({ pin: { via: "claude-code", model: "fable" }, source: "18-01-PLAN.md" });
  });

  test("routing.floor and routing.pin together land on one routingHints object with one source stamp", () => {
    const dir = scratchPhase("19-both", {
      "19-01-PLAN.md": plan("plan: 1\nrouting:\n  floor: cheap\n  pin:\n    via: codex\n    model: gpt", doneTask("d")),
    });
    const g = compileGsd(dir);
    expect(g.tasks[0].routingHints).toEqual({ floor: "cheap", pin: { via: "codex", model: "gpt" }, source: "19-01-PLAN.md" });
  });

  test("routing.floor with a non-tier value fails closed naming the file and valid tiers", () => {
    const dir = scratchPhase("20-badtier", {
      "20-01-PLAN.md": plan("plan: 1\nrouting:\n  floor: ultra", doneTask("d")),
    });
    expect(() => compileGsd(dir)).toThrow(CompileError);
    expect(() => compileGsd(dir)).toThrow(/20-01-PLAN\.md/);
    expect(() => compileGsd(dir)).toThrow(/cheap, mid, frontier/);
  });

  test("routing.pin missing via or model fails closed naming the file", () => {
    const dir = scratchPhase("21-partialpin", {
      "21-01-PLAN.md": plan("plan: 1\nrouting:\n  pin:\n    via: claude-code", doneTask("d")),
    });
    expect(() => compileGsd(dir)).toThrow(CompileError);
    expect(() => compileGsd(dir)).toThrow(/21-01-PLAN\.md/);
  });

  test("routing frontmatter that isn't an object fails closed naming the file", () => {
    const dir = scratchPhase("22-nonobj", {
      "22-01-PLAN.md": plan("plan: 1\nrouting: oops", doneTask("d")),
    });
    expect(() => compileGsd(dir)).toThrow(CompileError);
    expect(() => compileGsd(dir)).toThrow(/22-01-PLAN\.md/);
  });

  test("plan with no routing frontmatter has no routingHints key at all", () => {
    const dir = scratchPhase("23-none", {
      "23-01-PLAN.md": plan("plan: 1", doneTask("d")),
    });
    const g = compileGsd(dir);
    expect("routingHints" in g.tasks[0]).toBe(false);
  });
});

describe("compileSource auto-detect", () => {
  test("a dir of *-PLAN.md files routes to the gsd front-end without --type", () => {
    expect(compileSource(PHASE).spec.source).toBe("gsd");
  });

  test("--type gsd forces the front-end; a *-PLAN.md file auto-detects too", () => {
    expect(compileSource(PHASE, "gsd").spec.source).toBe("gsd");
    expect(compileSource(join(PHASE, "07-01-PLAN.md")).spec.source).toBe("gsd");
  });

  test("a *-PLAN.md file wins GSD detection even when it contains the native marker", () => {
    const dir = scratchPhase("24-marker", {
      "24-01-PLAN.md": plan("plan: 1", `<!-- tickmarkr:spec -->\n<objective>Marked plan.</objective>\n${doneTask("done")}`),
    });
    expect(compileSource(join(dir, "24-01-PLAN.md")).spec.source).toBe("gsd");
  });
});

describe("HARD-07 write-directive scope seam", () => {
  const objective = "<objective>\nDo the thing.\n</objective>\n\n";
  const tasks = (done: string) => `<tasks>\n<task type="auto">\n  <name>Task 1</name>\n  <done>${done}</done>\n</task>\n</tasks>`;

  // RED on unfixed HEAD: compileOne never reads write directives
  test("HARD-07: rejects a write directive naming a path outside files[]", () => {
    const dir = scratchPhase("h07-reject", {
      "20-01-PLAN.md": plan(
        "files_modified:\n  - src/a.ts",
        `${objective}${tasks("done line")}\n\nCreate \`.planning/out/20-01-SUMMARY.md\` when done.\n`,
      ),
    });
    expect(() => compileGsd(dir, dir)).toThrow();
    try {
      compileGsd(dir, dir);
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError);
      const msg = (e as CompileError).message;
      expect(msg).toMatch(/P20-01/);
      expect(msg).toMatch(/20-01-SUMMARY\.md/);
      expect(msg).toMatch(/Create/);
    }
  });

  test("HARD-07: accepts a write directive whose path IS in files[]", () => {
    const dir = scratchPhase("h07-accept", {
      "20-01-PLAN.md": plan(
        "files_modified:\n  - .planning/out/20-01-SUMMARY.md",
        `${objective}${tasks("done line")}\n\nCreate \`.planning/out/20-01-SUMMARY.md\` when done.\n`,
      ),
    });
    expect(() => compileGsd(dir, dir)).not.toThrow();
  });

  // green-by-accident on unfixed HEAD — guard for D-03; red from mutation drill
  test("HARD-07: a read-only assertion is not a write (D-03)", () => {
    const dir = scratchPhase("h07-read", {
      "20-01-PLAN.md": plan(
        "files_modified:\n  - src/a.ts",
        `${objective}${tasks("git hash-object src/route/router.ts equals ed12 on HEAD")}\n`,
      ),
    });
    expect(() => compileGsd(dir, dir)).not.toThrow();
  });

  // green-by-accident on unfixed HEAD — landmine 1; red from mutation drill
  test("HARD-07: empty files[] is unrestricted (landmine 1)", () => {
    const dir = scratchPhase("h07-empty", {
      "20-01-PLAN.md": plan("", `${objective}${tasks("done line")}\n\nCreate \`.planning/out/20-01-SUMMARY.md\` when done.\n`),
    });
    expect(() => compileGsd(dir, dir)).not.toThrow();
  });

  // green-by-accident on unfixed HEAD — landmine 2; red from mutation drill
  test("HARD-07: a bare basename resolves against the plan's own phase dir (landmine 2)", () => {
    const dir = scratchPhase("h07-basename", {
      "20-01-PLAN.md": plan(
        "files_modified:\n  - 20-01-SUMMARY.md",
        `${objective}${tasks("done line")}\n\nCreate \`20-01-SUMMARY.md\` when done.\n`,
      ),
    });
    expect(() => compileGsd(dir, dir)).not.toThrow();
  });

  // green-by-accident on unfixed HEAD — forward-looking self-trip guard; red from mutation drill
  test("HARD-07: a directive inside a fenced code block is ignored (self-trip guard)", () => {
    const dir = scratchPhase("h07-fence", {
      "20-01-PLAN.md": plan(
        "files_modified:\n  - src/a.ts",
        `${objective}${tasks("done line")}\n\n\`\`\`ts\nCreate \`.planning/out/20-01-SUMMARY.md\` when done.\n\`\`\`\n`,
      ),
    });
    expect(() => compileGsd(dir, dir)).not.toThrow();
  });

  // RED on unfixed HEAD: no compile-time check exists yet; picomatch half is the reference
  test("HARD-07: compile rejection agrees with the scope gate (matcher parity)", () => {
    const files = ["src/a.ts"];
    const path = ".planning/out/20-01-SUMMARY.md";
    expect(picomatch(files, { dot: true })(path)).toBe(false);
    const dir = scratchPhase("h07-parity", {
      "20-01-PLAN.md": plan(
        "files_modified:\n  - src/a.ts",
        `${objective}${tasks("done line")}\n\nCreate \`${path}\` when done.\n`,
      ),
    });
    expect(() => compileGsd(dir, dir)).toThrow();
  });
});
