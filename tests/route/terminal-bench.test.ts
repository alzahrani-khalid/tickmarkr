// Queue row 367 Phase 2 (D-2187 add.17 (1), add.19, add.20): the Terminal-Bench evidence reader. Every
// cell reads the committed fixture copy (never the live evidence file) through readTerminalBench, or a
// variant of it written to a disposable directory, then asks terminalBenchScore / terminalBenchLine.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { readTerminalBench, terminalBenchLine, terminalBenchScore } from "../../src/route/terminal-bench.js";

const CELLS = join(import.meta.dirname, "../fixtures/benchmarks/terminal-bench-cells.json");
const NOW = new Date("2026-11-08T12:00:00Z");
const doc = () => JSON.parse(readFileSync(CELLS, "utf8")) as { rows: Record<string, unknown>[] } & Record<string, unknown>;
const MODELS = [...new Set(doc().rows.map((r) => r.model as string))];

const tmp = mkdtempSync(join(tmpdir(), "tkr-tbench-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const variant = (text: string) => {
  const p = join(tmp, `cells-${n++}.json`);
  writeFileSync(p, text);
  return p;
};
const score = (path: string, model: string, effort?: string, now = NOW) => terminalBenchScore(readTerminalBench(path), model, effort, now);

test("a terminal bench row with no agent or an empty agent is invalid and leaves that model's score missing", () => {
  // The fixture's agentless row: the model is missing at every effort, its other valid row included.
  const ev = readTerminalBench(CELLS);
  expect(ev.ok).toBe(true);
  for (const effort of ["high", "low", undefined]) {
    const s = terminalBenchScore(ev, "tb-agentless", effort, NOW);
    expect(s.status).toBe("missing");
    expect(s.status === "missing" && s.reason).toMatch(/tb-agentless is invalid: agent missing or empty/);
  }
  // Control: the rest of the file still scores.
  expect(terminalBenchScore(ev, "tb-top", "high", NOW).status).toBe("fresh");
  // Empty, blank and non-string agents on the same row are invalid the same way, never a throw.
  for (const agent of ["", "   ", null, 7]) {
    const d = doc();
    const rows = d.rows.map((r) => (r.model === "tb-agentless" && r.effort === "high" ? { ...r, agent } : r));
    const path = variant(JSON.stringify({ ...d, rows }));
    expect(() => readTerminalBench(path)).not.toThrow();
    expect(score(path, "tb-agentless", "high").status).toBe("missing");
    expect(score(path, "tb-agentless", "low").status).toBe("missing");
    expect(score(path, "tb-top", "high").status).toBe("fresh");
  }
  // Control: giving that row an agent makes it count again.
  const d = doc();
  const fixed = d.rows.map((r) => (r.model === "tb-agentless" && r.effort === "high" ? { ...r, agent: "Codex" } : r));
  const s = score(variant(JSON.stringify({ ...d, rows: fixed })), "tb-agentless", "high");
  expect(s.status === "fresh" && s.row.score).toBe(58);
});

test("one model and effort published under two different agents leaves that model's score missing", () => {
  const ev = readTerminalBench(CELLS);
  const high = terminalBenchScore(ev, "tb-twin", "high", NOW);
  expect(high.status).toBe("missing");
  expect(high.status === "missing" && high.reason).toBe("Terminal-Bench ambiguous for tb-twin effort high: 2 rows (Claude Code, mini-SWE-agent)");
  // Never pick one: the model's single-agent effort and the effortless lookup are missing too.
  expect(terminalBenchScore(ev, "tb-twin", "low", NOW).status).toBe("missing");
  expect(terminalBenchScore(ev, "tb-twin", undefined, NOW).status).toBe("missing");
  // The agent is not part of the key: the same pair under ONE agent twice is just as missing.
  const d = doc();
  const same = d.rows.map((r) => (r.model === "tb-twin" ? { ...r, agent: "Claude Code" } : r));
  expect(score(variant(JSON.stringify({ ...d, rows: same })), "tb-twin", "high").status).toBe("missing");
  // Control: drop one of the two rows and the other scores, whichever agent measured it.
  const one = d.rows.filter((r) => !(r.model === "tb-twin" && r.agent === "mini-SWE-agent"));
  const s = score(variant(JSON.stringify({ ...d, rows: one })), "tb-twin", "high");
  expect(s.status === "fresh" && [s.row.agent, s.row.score]).toEqual(["Claude Code", 52]);
});

test("a row older than the file's maximum age reads as stale", () => {
  // Stale is missing: the stale row's score never reaches a caller, and the reason names the stale leg.
  const stale = score(CELLS, "tb-stale", "high");
  expect(stale).toEqual({
    status: "missing",
    stale: true,
    reason: "Terminal-Bench row for tb-stale effort high is stale: retrieved 2026-09-01, older than maxAgeDays 30",
  });
  expect(score(CELLS, "tb-top", "high").status).toBe("fresh");
  // Boundary: retrievedAt 2026-11-01 plus maxAgeDays 30 is 2026-12-01T00:00Z; stale once that is past.
  const edge = Date.parse("2026-12-01T00:00:00Z");
  expect(score(CELLS, "tb-top", "high", new Date(edge)).status).toBe("fresh");
  expect(score(CELLS, "tb-top", "high", new Date(edge + 1))).toMatchObject({ status: "missing", stale: true });
  // An unreadable clock cannot prove a row fresh.
  expect(score(CELLS, "tb-top", "high", new Date(Number.NaN))).toMatchObject({ status: "missing", stale: true });
  // The file's maxAgeDays drives it: a 100-day window makes the September row fresh.
  const wide = score(variant(JSON.stringify({ ...doc(), maxAgeDays: 100 })), "tb-stale", "high");
  expect(wide.status === "fresh" && wide.row.score).toBe(70);
});

test("an absent or unreadable evidence file leaves every terminal bench score missing without a throw", () => {
  const dir = join(tmp, "a-directory.json");
  mkdirSync(dir);
  const d = doc();
  const broken = [
    join(tmp, "absent.json"),
    dir,
    variant("{ not json"),
    variant(""),
    variant("null"),
    variant(JSON.stringify({ ...d, source: "Other-Bench" })),
    variant(JSON.stringify({ ...d, version: "" })),
    variant(JSON.stringify({ ...d, maxAgeDays: "30" })),
    variant(JSON.stringify({ ...d, maxAgeDays: 1.5 })),
    variant(JSON.stringify({ ...d, rows: {} })),
    variant(JSON.stringify({ ...d, rows: [...d.rows, { agent: "Codex", score: 1 }] })),
    variant(JSON.stringify({ ...d, rows: [...d.rows, null] })),
  ];
  for (const path of broken) {
    expect(() => readTerminalBench(path)).not.toThrow();
    const ev = readTerminalBench(path);
    expect(ev.ok).toBe(false);
    for (const model of MODELS) {
      for (const effort of ["high", "low", undefined]) {
        const s = terminalBenchScore(ev, model, effort, NOW);
        expect(s.status).toBe("missing");
        expect(s.status === "missing" && s.reason).toMatch(/^Terminal-Bench evidence unavailable: /);
      }
    }
  }
  expect(readTerminalBench(join(tmp, "absent.json"))).toEqual({ ok: false, error: "evidence file unreadable (ENOENT)" });
});

test("the evidence line prints the score with its measuring agent effort and retrieval date", () => {
  const line = (model: string, effort?: string) => {
    const s = score(CELLS, model, effort);
    if (s.status === "missing") throw new Error(s.reason);
    return terminalBenchLine(s.row);
  };
  expect(line("tb-effort", "high")).toBe("Terminal-Bench 50.25% (Codex, effort high, retrieved 2026-11-01)");
  expect(line("tb-top", "high")).toBe("Terminal-Bench 60% (Claude Code, effort high, retrieved 2026-11-01)");
  // A row published with no effort omits the effort clause.
  expect(line("tb-effort")).toBe("Terminal-Bench 45% (Codex, retrieved 2026-11-01)");
});

test("a row at the launch effort is preferred over one with no effort and another effort never stands in", () => {
  expect(score(CELLS, "tb-effort", "high")).toMatchObject({ status: "fresh", row: { score: 50.25 } });
  expect(score(CELLS, "tb-effort", "max")).toMatchObject({ status: "fresh", row: { score: 45 } });
  expect(score(CELLS, "tb-top", "max")).toEqual({ status: "missing", reason: "no Terminal-Bench row for tb-top at effort max" });
  expect(score(CELLS, "tb-absent", "high").status).toBe("missing");
});

test("a malformed calendar date on a row is invalid and leaves that model's score missing without a throw", () => {
  for (const retrievedAt of ["2026-13-01", "2026-00-01", "2026-11-00", "2026-11-32", "2026-02-30", "2026-02-29", "2026-04-31", "9999-99-99"]) {
    const d = doc();
    const rows = d.rows.map((r) => (r.model === "tb-top" ? { ...r, retrievedAt } : r));
    const path = variant(JSON.stringify({ ...d, rows }));
    expect(() => readTerminalBench(path), retrievedAt).not.toThrow();
    expect(score(path, "tb-top", "high"), retrievedAt).toEqual({
      status: "missing", reason: "Terminal-Bench row for tb-top is invalid: retrievedAt not a YYYY-MM-DD date",
    });
    expect(score(path, "tb-54", "high").status, retrievedAt).toBe("fresh");
  }
  // Control: a real calendar date, a leap day included, still reads.
  for (const [retrievedAt, now] of [["2026-10-31", NOW], ["2028-02-29", new Date("2028-03-01T00:00:00Z")]] as const) {
    const d = doc();
    const rows = d.rows.map((r) => (r.model === "tb-top" ? { ...r, retrievedAt } : r));
    expect(score(variant(JSON.stringify({ ...d, rows })), "tb-top", "high", now).status, retrievedAt).toBe("fresh");
  }
});

test("any malformed field on a row leaves only that model's score missing and never throws", () => {
  // Bounded sweep: every row field the reader checks × a closed list of bad JSON values.
  const bad: unknown[] = [null, "", "   ", 7, -1.5, true, {}, [], "2026-13-01", "not a date"];
  const fields = { agent: [null, "", "   ", 7, true, {}, []], effort: [null, "", "   ", 7, true, {}, []], score: [null, "", "60", true, {}, []], sourceUrl: [null, "", "   ", 7, true, {}, []], retrievedAt: bad };
  for (const [field, values] of Object.entries(fields)) {
    for (const value of values) {
      const d = doc();
      const rows = d.rows.map((r) => (r.model === "tb-top" ? { ...r, [field]: value } : r));
      const path = variant(JSON.stringify({ ...d, rows }));
      const label = `${field}=${JSON.stringify(value)}`;
      expect(() => readTerminalBench(path), label).not.toThrow();
      const s = score(path, "tb-top", "high");
      expect(s.status === "missing" && s.reason, label).toMatch(/^Terminal-Bench row for tb-top is invalid: /);
      expect(score(path, "tb-54", "high").status, label).toBe("fresh");
    }
  }
});
