// Queue rows 331 and 332: src/board/summarize.ts against the frozen reference's goldens (tests/fixtures/board, read-only).
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import * as ts from "typescript";
import { afterEach, describe, expect, test } from "vitest";
import { roundHalfEven, summarize } from "../../src/board/summarize.js";

const fixtures = join(import.meta.dirname, "../fixtures/board");
const sourcePath = join(import.meta.dirname, "../../src/board/summarize.ts");

type Golden = {
  name: string; run: string; cut: number; tz: string; now: number; pid: number | null; alive: boolean | null;
  hist: Record<string, number>; suites: Record<string, { done: number; total: number; failing: string[] }> | null;
  expected: ReturnType<typeof summarize>;
};
const cases: Golden[] = JSON.parse(readFileSync(join(fixtures, "goldens.json"), "utf8")).cases;
const ZONES = ["Asia/Riyadh", "America/New_York"];

const runFile = (run: string, file: string): string => readFileSync(join(fixtures, "runs", run, file), "utf8");
/** Journal lines split on LF only, as the reference's file iteration does (U+2028 stays inside a line). */
const journalLines = (run: string): string[] => {
  const text = runFile(run, "journal.jsonl");
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
};
const eventsOf = (lines: string[]) =>
  lines.flatMap((l, i) => (l.trim().startsWith("{") ? [{ ...JSON.parse(l), _line: i + 1 }] : []));
const telemetryOf = (run: string) => runFile(run, "telemetry.jsonl").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));

const savedTz = process.env.TZ;
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

test("for every golden case, with the process time zone set to the case's tz, summarize over the first cut lines of the run's journal split on LF only, its graph and every telemetry row, at the case's now, pid, alive, hist and suites, deep-equals the case's expected object", () => {
  let compared = 0;
  for (const c of cases) {
    process.env.TZ = c.tz;
    const got = summarize(eventsOf(journalLines(c.run).slice(0, c.cut)), JSON.parse(runFile(c.run, "graph.json")), c.pid, c.alive, c.now,
      c.hist, telemetryOf(c.run), c.suites);
    expect(got, c.name).toStrictEqual(c.expected);
    compared++;
  }
  expect(compared).toBe(cases.length);
});

test("the golden cases run in full with none skipped and include both time zones, the synthetic run, a suite waiting on a named holder, a failed cheap check, a park and an open approval window, so a trimmed golden file fails", () => {
  expect(cases).toHaveLength(174); // README: 174 journal cuts
  for (const c of cases) expect(journalLines(c.run).length, c.name).toBeGreaterThanOrEqual(c.cut);
  expect([...new Set(cases.map((c) => c.tz))].sort()).toEqual([...ZONES].sort());
  expect(cases.some((c) => c.run === "synthetic-edges")).toBe(true);
  const expected = cases.map((c) => c.expected);
  expect(expected.some((e) => e.tasks.some((t) => /\(held by \S+.* full suite\)$/.test(t.now)))).toBe(true);
  expect(expected.some((e) => e.tasks.some((t) => t.history.some((h) => h.parts.some((p) =>
    /^(build|lint|evidence|scope) ✖$/.test(p.text) && p.reason))))).toBe(true);
  expect(expected.some((e) => e.needsYou.length > 0)).toBe(true);
  expect(expected.some((e) => e.approvalWindow !== null)).toBe(true);
});

test("roundHalfEven rounds 2.5 to 2, 3.5 to 4, 0.5 and negative 0.5 to positive zero, negative 1.5 to negative 2 and 2.6 to 3, so a port using Math.round fails", () => {
  expect(roundHalfEven(2.5)).toBe(2);
  expect(roundHalfEven(3.5)).toBe(4);
  expect(roundHalfEven(0.5)).toBe(0); // toBe is Object.is: -0 fails
  expect(roundHalfEven(-0.5)).toBe(0);
  expect(roundHalfEven(-1.5)).toBe(-2);
  expect(roundHalfEven(2.6)).toBe(3);
});

/** Node built-in imports and clock reads in a source text, found on its syntax tree (comments and strings never match). */
function impurities(source: string): string[] {
  const found: string[] = [];
  const builtin = (spec: string) => spec.startsWith("node:") || builtinModules.includes(spec);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && builtin(node.moduleSpecifier.text)) found.push(`import ${node.moduleSpecifier.text}`);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteralLike(arg) || builtin(arg.text)) found.push(`dynamic import ${arg?.getText() ?? ""}`);
    }
    if (ts.isIdentifier(node) && node.text === "getBuiltinModule") found.push("getBuiltinModule");
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date" && node.name.text === "now") {
      found.push("Date.now");
    }
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === "Date"
      && !node.arguments?.length) found.push(ts.isNewExpression(node) ? "new Date()" : "Date()");
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("summarize.ts", source, ts.ScriptTarget.Latest, true));
  return found;
}

test("the summarize source imports no node built-in module and calls neither Date.now nor an argument-less Date constructor", () => {
  expect(impurities(readFileSync(sourcePath, "utf8"))).toEqual([]);
  // the control: the probe finds each planted instance of what it guards against
  const planted = `import { readFileSync } from "node:fs";\nimport os from "os";\nconst a = Date.now();\nconst b = new Date();\n`
    + `const c = new Date;\nconst d = Date();\nconst e = await import("path");\nconst f = new Date(0);\n`;
  expect(impurities(planted)).toEqual(["import node:fs", "import os", "Date.now", "new Date()", "new Date()", "Date()", 'dynamic import "path"']);
});

// ---- S2 numbers through summarize: integers stay exact, and int() parses as CPython's (the repair findings) ----

const MAX = Number.MAX_SAFE_INTEGER;
const UNSAFE = /integer outside ±\(2\^53−1\)/;
const TS = "2026-11-02T10:00:00.000Z";
const T0 = Date.parse(TS) / 1000;
const ev = (event: string, data: object = {}, taskId?: string) => ({ ts: TS, event, ...(taskId ? { taskId } : {}), data });
const graphOf = (...ids: string[]) => ({ tasks: ids.map((id) => ({ id, title: id })) });
const dispatched = (attempt: unknown) =>
  summarize([ev("run-start", { runId: "r" }), ev("task-dispatch", { attempt }, "T1"), ev("phase-start", { phase: "worker" }, "T1")],
    graphOf("T1"), null, null, T0);

/** The golden sweeps' input: the last synthetic case with a lock pid, phase times and suites, cut as given. */
const sweep = cases.filter((g) => g.run === "synthetic-edges" && Object.keys(g.hist).length && g.suites && g.pid !== null).at(-1) as Golden;
const goldenInput = (c: Golden, cut = c.cut) => ({ events: eventsOf(journalLines(c.run).slice(0, cut)), graph: JSON.parse(runFile(c.run, "graph.json")),
  pid: c.pid, now: c.now, hist: { ...c.hist }, telemetry: telemetryOf(c.run), suites: structuredClone(c.suites) });
type Input = ReturnType<typeof goldenInput>;
const runInput = (c: Golden, i: Input) => summarize(i.events, i.graph, i.pid, c.alive, i.now, i.hist, i.telemetry, i.suites);
/** Every path to a leaf (anything but a nonnull object) that `keep` accepts. */
function leafPaths(x: unknown, keep: (leaf: unknown) => boolean, path: (string | number)[] = []): (string | number)[][] {
  if (x && typeof x === "object") return Object.entries(x).flatMap(([k, v]) => leafPaths(v, keep, [...path, Array.isArray(x) ? Number(k) : k]));
  return keep(x) ? [path] : [];
}
/** A fresh input with one leaf replaced (the input is built for this call alone). */
function setLeaf(i: Input, path: (string | number)[], v: unknown): Input {
  path.slice(0, -1).reduce((o: any, k) => o[k], i)[path[path.length - 1]] = v;
  return i;
}

describe("S2: an unsafe integer in the input or in an accumulated result throws", () => {
  test("a lock pid of 2^53 throws instead of being returned", () => {
    expect(() => summarize([], graphOf("T1"), 2 ** 53, false, T0)).toThrow(UNSAFE);
  });
  test("a now of 2^53 throws instead of becoming atEpoch", () => {
    expect(() => summarize([], graphOf("T1"), 1, true, 2 ** 53)).toThrow(UNSAFE);
  });
  test("a run-start concurrency of 2^53 throws even with an empty graph", () => {
    expect(() => summarize([ev("run-start", { runId: "r", effectivePolicy: { concurrency: 2 ** 53 } })], { tasks: [] }, null, null, T0))
      .toThrow(UNSAFE);
  });
  test("one pending task whose worker and semantics times are each 2^52 throws instead of returning an ETA", () => {
    expect(() => summarize([], graphOf("T1"), null, null, 0, { worker: 2 ** 52, semantics: 2 ** 52, test: 0 })).toThrow(UNSAFE);
  });
  test("a worker time of 2^53−1 plus a semantics time of 1 throws", () => {
    expect(() => summarize([], graphOf("T1"), null, null, 0, { worker: MAX, semantics: 1, test: 0 })).toThrow(UNSAFE);
  });

  test("every integer leaf of a golden input set to ±2^53 throws, so no echoed or unread field escapes", () => {
    const paths = leafPaths(goldenInput(sweep), (x) => typeof x === "number" && Number.isInteger(x));
    expect(paths.length).toBeGreaterThan(50);
    for (const path of paths) {
      for (const bad of [2 ** 53, -(2 ** 53)]) {
        const i = setLeaf(goldenInput(sweep), path, bad);
        expect(() => runInput(sweep, i), path.join(".")).toThrow(UNSAFE);
      }
    }
  });

  test("phase times and a clock that are each exact but whose eta sums pass 2^53−1 throw in every scheduling branch, and the largest exact ones do not", () => {
    const gates = [ev("task-dispatch", { attempt: 0 }, "T1"), ev("phase-start", { phase: "worker" }, "T1"), ev("worker-result", { ok: true }, "T1"),
      ev("phase-start", { phase: "gates" }, "T1")];
    const branches: Record<string, object[]> = {
      pending: [],
      worker: gates.slice(0, 2),
      semantics: [...gates, ev("phase-start", { phase: "judge" }, "T1")],
      test: [...gates, ev("phase-start", { phase: "gate:test", index: 0 }, "T1")],
      suiteQueue: [...gates, ev("phase-start", { phase: "gate:test", index: 0 }, "T1"), ev("suite-wait", { gate: "test" }, "T1")],
    };
    const keys = ["worker", "semantics", "test"] as const;
    for (const [name, events] of Object.entries(branches)) {
      const at = (now: number, hist: object) => () => summarize(events, graphOf("T1"), null, null, now, hist);
      for (const a of keys) for (const b of keys) {
        if (a !== b) expect(at(T0, { worker: 0, semantics: 0, test: 0, [a]: MAX, [b]: 1 }), `${name} ${a}+${b}`).toThrow(UNSAFE);
      }
      expect(at(T0, { worker: 2 ** 50, semantics: 2 ** 50, test: 2 ** 50 })().eta, name).not.toBeNull();
      expect(at(MAX - 100, { worker: 60, semantics: 60, test: 60 }), `${name} finish time`).toThrow(UNSAFE);
      expect(at(MAX - 10_000, { worker: 60, semantics: 60, test: 60 })().eta, name).not.toBeNull();
    }
    // the boundary itself: a pending task's repair round doubles its phase sum, which may reach 2^53−1 but not 2^53
    expect(summarize([], graphOf("T1"), null, null, 0, { worker: 2 ** 52 - 2, semantics: 1, test: 0 }).eta?.oneRepairMin)
      .toBe(roundHalfEven((2 ** 53 - 2) / 60));
    expect(() => summarize([], graphOf("T1"), null, null, 0, { worker: 2 ** 52 - 1, semantics: 1, test: 0 })).toThrow(UNSAFE);
  });
});

describe("S2: int() parses a string as CPython does", () => {
  test("a dispatch attempt of ' +٢ ' is attempt 2, and of fullwidth '１' attempt 1", () => {
    const arabic = dispatched(" +٢ ");
    expect(arabic.tasks[0].attempt).toBe(2);
    expect(arabic.tasks[0].history[0].att).toBe(3);
    expect(dispatched("１").tasks[0].attempt).toBe(1);
  });
  test("a dispatch attempt led by U+001C or U+001F throws: str.isspace() takes them, int() does not", () => {
    expect(() => dispatched("\u001c1")).toThrow(/invalid literal for int\(\)/);
    expect(() => dispatched("\u001f1")).toThrow(/invalid literal for int\(\)/);
  });

  test("every whitespace int() skips, every Unicode decimal digit block and Python's underscore and sign rules parse, and every other form throws", () => {
    // Python's int() whitespace: ASCII tab, LF, VT, FF, CR, space; plus each non-ASCII str.isspace() character
    const space = [9, 10, 11, 12, 13, 32, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
      0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000].map((cp) => String.fromCodePoint(cp));
    // the zero of decimal digit blocks (Unicode Nd, each ten ascending code points), in Python's tables since Unicode 7
    const zeros = [0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6, 0xe50, 0xed0, 0xf20, 0x1040,
      0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50,
      0xabf0, 0xff10, 0x104a0, 0x11066, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6];
    const digits = (zero: number, ds: string) => [...ds].map((d) => String.fromCodePoint(zero + Number(d))).join("");
    const good: [string, number][] = [
      ...space.flatMap((s): [string, number][] => [[`${s}+7${s}`, 7], [`${s}${s}-7`, -7], [`7${s}`, 7]]),
      ...zeros.flatMap((z): [string, number][] => [[digits(z, "0123456789"), 123456789], [digits(z, "9876543210"), 9876543210],
        [`-${digits(z, "1")}_${digits(z, "05")}`, -105]]),
      ["00", 0], ["-0", 0], ["007", 7], ["1_000", 1000], ["\u3000+١_٢\u0085", 12],
    ];
    const ids = good.map((_, n) => `T${n + 1}`);
    const got = summarize([ev("run-start", { runId: "r" }), ...good.map(([s], n) => ev("task-dispatch", { attempt: s }, ids[n]))],
      graphOf(...ids), null, null, T0);
    got.tasks.forEach((r, n) => expect(r.attempt, JSON.stringify(good[n][0])).toBe(good[n][1]));
    for (const bad of ["\u001c1", "\u001d1", "\u001e1", "\u001f1", "1\u001c", "\u007f1", "\u200b7", "\u22127", "\uff0b7", "\u180e7", "7\u0000",
      "1__2", "_1", "1_", "+_1", "+ 1", "- 1", "1 2", "1\u00a02", "++1", "", " ", "0x1", "1.0", "1e3", "\ud8007"]) {
      expect(() => dispatched(bad), JSON.stringify(bad)).toThrow(/invalid literal for int\(\)/);
    }
  });
});

describe("S2: a zero result is positive zero", () => {
  const negativeZeros = (x: unknown) => leafPaths(x, (v) => Object.is(v, -0)).map((p) => p.join("."));

  test("a lock pid and a now of negative zero are returned as positive zero", () => {
    const got = summarize([], { tasks: [] }, -0, false, -0);
    expect(got.pid).toBe(0); // toBe is Object.is: -0 fails
    expect(got.atEpoch).toBe(0);
  });

  test("every leaf of a golden input, live or ended, set to negative zero either throws or leaves no negative zero in the summary", () => {
    expect(negativeZeros({ a: [1, { b: -0 }] })).toEqual(["a.1.b"]); // the control: the probe finds a planted negative zero
    let returned = 0;
    for (const cut of [sweep.cut, journalLines(sweep.run).length]) {
      const paths = leafPaths(goldenInput(sweep, cut), () => true);
      expect(paths.length).toBeGreaterThan(200);
      for (const path of paths) {
        let got: ReturnType<typeof summarize>;
        try {
          got = runInput(sweep, setLeaf(goldenInput(sweep, cut), path, -0));
        } catch {
          continue; // a leaf whose type the reference rejects throws; only a returned summary must hold positive zeros
        }
        returned++;
        expect(negativeZeros(got), `${cut}:${path.join(".")}`).toEqual([]);
      }
    }
    expect(returned).toBeGreaterThan(200);
  });
});

// S1 names its timestamp forms (D-2178 add.210): `Z` or a `±HH`, `±HHMM` or `±HH:MM` offset, each as the Python 3.14 that
// generated the goldens reads it through fromisoformat; a seconds-bearing offset is a stated difference and throws.
describe("S1: a timestamp is Z, ±HH, ±HHMM or ±HH:MM with at most millisecond precision", () => {
  const startAt = (ts: string) => summarize([{ ts, event: "run-start", data: { runId: "r" } }], { tasks: [] }, null, null, T0).startEpoch;
  test("Z, +03:00, -05:00, +0300, -0430 and +03 name the instants Python 3.14's fromisoformat gives", () => {
    const table: [string, number][] = [
      ["2026-11-02T10:00:00.000Z", 1793613600], ["2026-11-02T10:00:00.000+03:00", 1793602800], ["2026-11-02T10:00:00.000-05:00", 1793631600],
      ["2026-11-02T10:00:00.000+0300", 1793602800], ["2026-11-02T10:00:00.000-0430", 1793629800], ["2026-11-02T10:00:00.000+03", 1793602800],
      ["2026-11-02T10:00:00.250+0300", 1793602800.25],
    ];
    for (const [ts, epoch] of table) expect(startAt(ts), ts).toBe(epoch);
  });
  test("a missing offset, microseconds, a seconds-bearing offset and a cut offset throw", () => {
    for (const ts of ["2026-11-02T10:00:00.000", "2026-11-02T10:00:00.000001Z", "2026-11-02T10:00:00.000+03:00:00", "2026-11-02T10:00:00.000+03:",
      "2026-11-02T10:00:00.000+030", "2026-11-02T10:00:00.000+2400"]) {
      expect(() => startAt(ts), ts).toThrow(/offset-bearing ISO timestamp/);
    }
  });
});
