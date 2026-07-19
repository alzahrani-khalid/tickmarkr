import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { codex } from "../../src/adapters/codex.js";
import { addUsage } from "../../src/adapters/types.js";

// SPEND-07: zero-token test — synthetic ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl under a temp HOME.
// homedir() honors HOME on posix; CODEX_HOME cleared so the store lands under HOME/.codex.
// NEVER invokes the real codex binary.

const collect = codex.collectUsage!;
let HOME: string;
let ORIG_HOME: string | undefined;
let ORIG_CODEX_HOME: string | undefined;

beforeEach(() => {
  ORIG_HOME = process.env.HOME;
  ORIG_CODEX_HOME = process.env.CODEX_HOME;
  HOME = mkdtempSync(join(tmpdir(), "codex-usage-"));
  process.env.HOME = HOME;
  delete process.env.CODEX_HOME;
});
afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = ORIG_CODEX_HOME;
});

const scratch = () => mkdtempSync(join(tmpdir(), "cwd-"));

// plant rollout JSONL under $HOME/.codex/sessions/YYYY/MM/DD/
function plantRollout(dateDir: string, file: string, records: unknown[], raw: string[] = []) {
  const dir = join(HOME, ".codex", "sessions", dateDir);
  mkdirSync(dir, { recursive: true });
  const lines = [...records.map((r) => JSON.stringify(r)), ...raw];
  writeFileSync(join(dir, file), lines.join("\n"));
}

const sessionMeta = (cwd: string, ts = "2026-07-10T18:24:41.610Z") => ({
  timestamp: "2026-07-10T18:24:42.116Z",
  type: "session_meta",
  payload: { session_id: "019f4d46-5089-7f01-83f3-aba1fff4d8fa", timestamp: ts, cwd: realpathSync(cwd), originator: "codex_exec", cli_version: "0.144.1" },
});

const tokenCount = (ts: string, last: Record<string, number>, total?: Record<string, number>) => ({
  timestamp: ts,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      last_token_usage: last,
      total_token_usage: total ?? last,
      model_context_window: 353400,
    },
    rate_limits: { plan_type: "pro" },
  },
});

// REAL fixture from 29-RESEARCH.md (cwd rewritten at plant time)
const REAL_LAST = { input_tokens: 25404, cached_input_tokens: 9984, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 25409 };
const REAL_TOTAL = { input_tokens: 25404, cached_input_tokens: 9984, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 25409 };

const T1 = "2026-07-10T12:00:00.000Z";
const T2 = "2026-07-10T12:05:00.000Z";
const T3 = "2026-07-10T12:10:00.000Z";
const DAY = "2026/07/10";
const NEXT_DAY = "2026/07/11";
const OLD_DAY = "2026/07/08";

describe("codex.collectUsage — fail-open matrix + happy path", () => {
  test("happy path: real fixture yields disjoint input (input_tokens − cached), cacheRead, output; no reasoning", () => {
    const cwd = scratch();
    plantRollout(DAY, "rollout-test.jsonl", [
      sessionMeta(cwd),
      tokenCount("2026-07-10T18:24:51.662Z", REAL_LAST, REAL_TOTAL),
    ]);
    expect(collect(cwd, 0)).toEqual({ input: 15420, output: 5, cacheRead: 9984 });
  });

  test("info:null guard: first token_count with info:null skipped, sibling still sums", () => {
    const cwd = scratch();
    plantRollout(DAY, "rollout-null.jsonl", [
      sessionMeta(cwd),
      { timestamp: T1, type: "event_msg", payload: { type: "token_count", info: null } },
      tokenCount(T2, { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 }),
    ]);
    expect(collect(cwd, 0)).toEqual({ input: 100, output: 10 });
  });

  test("whole-file cwd skip: session_meta cwd mismatch ⇒ undefined for entire file", () => {
    const cwd = scratch();
    const other = scratch();
    plantRollout(DAY, "rollout-wrong-cwd.jsonl", [
      sessionMeta(other),
      tokenCount(T1, { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 }),
    ]);
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("cursor slice: only records at/after sinceMs count (per-record ISO timestamp)", () => {
    const cwd = scratch();
    plantRollout(DAY, "rollout-cursor.jsonl", [
      sessionMeta(cwd),
      tokenCount(T1, { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 }),
      tokenCount(T2, { input_tokens: 200, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 220 }),
    ]);
    expect(collect(cwd, Date.parse(T2))).toEqual({ input: 200, output: 20 });
  });

  test("date-partition walk: records in sinceMs day and next day both found; old day ignored", () => {
    const cwd = scratch();
    const since = Date.parse("2026-07-10T23:00:00.000Z");
    plantRollout(DAY, "rollout-day1.jsonl", [
      sessionMeta(cwd),
      tokenCount("2026-07-10T23:30:00.000Z", { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 55 }),
    ]);
    plantRollout(NEXT_DAY, "rollout-day2.jsonl", [
      sessionMeta(cwd),
      tokenCount("2026-07-11T01:00:00.000Z", { input_tokens: 60, cached_input_tokens: 0, output_tokens: 6, reasoning_output_tokens: 0, total_tokens: 66 }),
    ]);
    // syntactically broken file in a day far before sinceMs — must not break the read
    plantRollout(OLD_DAY, "rollout-broken.jsonl", [], ["{not valid json at all"]);
    expect(collect(cwd, since)).toEqual({ input: 110, output: 11 });
  });

  test("missing ~/.codex/sessions dir: undefined", () => {
    const cwd = scratch();
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("torn trailing line: valid record still sums", () => {
    const cwd = scratch();
    plantRollout(DAY, "rollout-torn.jsonl", [
      sessionMeta(cwd),
      tokenCount(T1, { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 }),
    ], ['{"timestamp":"' + T2 + '","type":"event_msg","payload":{"type":"token_count"']);
    expect(collect(cwd, 0)).toEqual({ input: 100, output: 10 });
  });

  test("unparseable timestamp: skipped, sibling sums", () => {
    const cwd = scratch();
    plantRollout(DAY, "rollout-bad-ts.jsonl", [
      sessionMeta(cwd),
      tokenCount("not-a-date", { input_tokens: 999, cached_input_tokens: 0, output_tokens: 99, reasoning_output_tokens: 0, total_tokens: 1098 }),
      tokenCount(T1, { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 }),
    ]);
    expect(collect(cwd, 0)).toEqual({ input: 100, output: 10 });
  });

  test("nothing matched: undefined, never {input:0,...}", () => {
    const cwd = scratch();
    plantRollout(DAY, "rollout-empty.jsonl", [sessionMeta(cwd)]);
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("clamp: cached_input_tokens > input_tokens ⇒ input clamps to 0", () => {
    const cwd = scratch();
    plantRollout(DAY, "rollout-clamp.jsonl", [
      sessionMeta(cwd),
      tokenCount(T1, { input_tokens: 10, cached_input_tokens: 50, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15 }),
    ]);
    expect(collect(cwd, 0)).toEqual({ input: 0, output: 5, cacheRead: 50 });
  });
});

describe("codex.collectUsage — THE BITING TEST: escalation fold is A+B+C, not 3A+2B+C", () => {
  const A = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 11 };
  const B = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 102 };
  const C = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 1003 };
  const totalA = { ...A };
  const totalB = { input_tokens: 110, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 113 };
  const totalC = { input_tokens: 1110, cached_input_tokens: 0, output_tokens: 6, reasoning_output_tokens: 0, total_tokens: 1116 };

  test("growing store between cursored reads folds to A+B+C (1110), never 3A+2B+C (1230)", () => {
    const cwd = scratch();

    plantRollout(DAY, "rollout-grow.jsonl", [
      sessionMeta(cwd),
      tokenCount(T1, A, totalA),
    ]);
    const r1 = collect(cwd, Date.parse(T1));

    plantRollout(DAY, "rollout-grow.jsonl", [
      sessionMeta(cwd),
      tokenCount(T1, A, totalA),
      tokenCount(T2, B, totalB),
    ]);
    const r2 = collect(cwd, Date.parse(T2));

    plantRollout(DAY, "rollout-grow.jsonl", [
      sessionMeta(cwd),
      tokenCount(T1, A, totalA),
      tokenCount(T2, B, totalB),
      tokenCount(T3, C, totalC),
    ]);
    const r3 = collect(cwd, Date.parse(T3));

    const total = addUsage(addUsage(r1!, r2!)!, r3!);
    expect(total).toEqual({ input: 1110, output: 6 });
    expect(total.input).not.toBe(1230);
    expect(total.output).not.toBe(12);
  });
});

describe("codex.collectUsage — falsification drills", () => {
  test("reasoning double-count: reasoning_output_tokens present ⇒ result.reasoning undefined, key absent", () => {
    const cwd = scratch();
    plantRollout(DAY, "rollout-reason.jsonl", [
      sessionMeta(cwd),
      tokenCount(T1, { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 120 }),
    ]);
    const u = collect(cwd, 0)!;
    expect(u.reasoning).toBeUndefined();
    expect(Object.keys(u)).not.toContain("reasoning");
    expect(u).toEqual({ input: 100, output: 20 });
  });

  test("source pin: no total_token_usage or cost in code; bounds + Date.parse present", () => {
    const src = readFileSync(new URL("../../src/adapters/codex.ts", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(code).not.toMatch(/total_token_usage/);
    expect(code).not.toMatch(/costUSD|\.cost\b/);
    expect(src).toMatch(/MAX_SESSION_FILES/);
    expect(src).toMatch(/MAX_SESSION_BYTES/);
    expect(src).toMatch(/Date\.parse/);
  });
});
