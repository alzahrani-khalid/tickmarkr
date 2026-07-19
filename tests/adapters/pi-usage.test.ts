import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { pi } from "../../src/adapters/pi.js";
import { addUsage } from "../../src/adapters/types.js";

// SPEND-10: zero-token test — synthetic ~/.pi/agent/sessions/<slug>/*.jsonl under a temp HOME.
// homedir() honors HOME on posix. NEVER invokes the real pi binary.
// Fixture pinned from pi 0.80.6 live probe (29-RESEARCH.md, 2026-07-11).

const collect = pi.collectUsage!;
let HOME: string;
let ORIG_HOME: string | undefined;

beforeEach(() => {
  ORIG_HOME = process.env.HOME;
  HOME = mkdtempSync(join(tmpdir(), "pi-usage-"));
  process.env.HOME = HOME;
});
afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
});

const scratch = () => mkdtempSync(join(tmpdir(), "cwd-"));

const slugDir = (cwd: string) =>
  join(HOME, ".pi", "agent", "sessions", "-" + realpathSync(cwd).replaceAll("/", "-") + "--");

// session header + message records; `raw` lines appended verbatim (torn-line fixtures)
function plantSession(cwd: string, records: unknown[], raw: string[] = [], file = "x.jsonl") {
  const dir = slugDir(cwd);
  mkdirSync(dir, { recursive: true });
  const lines = [...records.map((r) => JSON.stringify(r)), ...raw];
  writeFileSync(join(dir, file), lines.join("\n"));
}

const sessionHeader = (cwd: string, tsISO = "2026-07-10T22:44:50.185Z") => ({
  type: "session",
  version: 3,
  id: "019f4e34-7b89-7725-ae8a-dfe3f9aa6109",
  timestamp: tsISO,
  cwd: realpathSync(cwd),
});

const assistantMsg = (cwd: string, tsISO: string, usage: unknown, role = "assistant") => ({
  type: "message",
  id: "msg-test",
  timestamp: tsISO,
  message: { role, content: [{ type: "text", text: "ok" }], usage },
});

// REAL 0.80.6 fixture usage block (29-RESEARCH.md lines 166-169)
const FIXTURE_USAGE = {
  input: 14143,
  output: 14,
  cacheRead: 1024,
  cacheWrite: 0,
  reasoning: 10,
  totalTokens: 15181,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const T1 = "2026-07-10T12:00:00.000Z";
const T2 = "2026-07-10T12:05:00.000Z";
const T3 = "2026-07-10T12:10:00.000Z";

describe("pi.collectUsage — fail-open matrix + happy path", () => {
  test("happy path: real 0.80.6 fixture sums token fields; reasoning omitted", () => {
    const cwd = scratch();
    plantSession(cwd, [
      sessionHeader(cwd),
      assistantMsg(cwd, "2026-07-10T22:44:52.456Z", FIXTURE_USAGE),
    ]);
    const u = collect(cwd, 0)!;
    expect(u).toEqual({ input: 14143, output: 14, cacheRead: 1024, cacheWrite: 0 });
    expect(u.reasoning).toBeUndefined();
    expect("reasoning" in u).toBe(false);
  });

  test("cursor slice: only assistant records at/after sinceMs count", () => {
    const cwd = scratch();
    plantSession(cwd, [
      sessionHeader(cwd),
      assistantMsg(cwd, T1, { input: 100, output: 10 }),
      assistantMsg(cwd, T2, { input: 200, output: 20 }),
    ]);
    expect(collect(cwd, Date.parse(T2))).toEqual({ input: 200, output: 20 });
  });

  test("header-cwd guard: correct slug but header cwd mismatch ⇒ undefined (fail-safe)", () => {
    const cwd = scratch();
    const other = scratch();
    plantSession(cwd, [
      { ...sessionHeader(cwd), cwd: realpathSync(other) },
      assistantMsg(cwd, T1, { input: 100, output: 10 }),
    ]);
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("role filter: user-role usage-shaped record contributes nothing", () => {
    const cwd = scratch();
    plantSession(cwd, [
      sessionHeader(cwd),
      assistantMsg(cwd, T1, { input: 100, output: 10 }, "user"),
      assistantMsg(cwd, T2, { input: 200, output: 20 }),
    ]);
    expect(collect(cwd, 0)).toEqual({ input: 200, output: 20 });
  });

  test("no sessions/slug dir: undefined", () => {
    const cwd = scratch();
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("torn last line: valid record still sums, truncated line dropped", () => {
    const cwd = scratch();
    plantSession(
      cwd,
      [sessionHeader(cwd), assistantMsg(cwd, T1, { input: 100, output: 10 })],
      [`{"type":"message","timestamp":"${T2}","message":{"role":"assistant","usage"`],
    );
    expect(collect(cwd, 0)).toEqual({ input: 100, output: 10 });
  });

  test("unparseable timestamp: skipped, sibling sums", () => {
    const cwd = scratch();
    plantSession(cwd, [
      sessionHeader(cwd),
      assistantMsg(cwd, "not-a-date", { input: 888, output: 88 }),
      assistantMsg(cwd, T1, { input: 100, output: 10 }),
    ]);
    expect(collect(cwd, 0)).toEqual({ input: 100, output: 10 });
  });

  test("nothing matched: undefined, never {input:0}", () => {
    const cwd = scratch();
    plantSession(cwd, [sessionHeader(cwd)]);
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("DRILL reasoning double-count: reasoning present in fixture but omitted from result", () => {
    const cwd = scratch();
    plantSession(cwd, [
      sessionHeader(cwd),
      assistantMsg(cwd, T1, { input: 100, output: 14, reasoning: 10 }),
    ]);
    const u = collect(cwd, 0)!;
    expect(u.reasoning).toBeUndefined();
    expect("reasoning" in u).toBe(false);
    expect(u).toEqual({ input: 100, output: 14 });
  });

  test("DRILL cost: usage.cost present but no cost/usd/price key in result", () => {
    const cwd = scratch();
    plantSession(cwd, [
      sessionHeader(cwd),
      assistantMsg(cwd, T1, { input: 100, output: 10, cost: { input: 0, output: 0, total: 0 } }),
    ]);
    const u = collect(cwd, 0)!;
    expect(u).toEqual({ input: 100, output: 10 });
    for (const k of Object.keys(u)) expect(k).not.toMatch(/cost|usd|price/i);
  });

  test("text pin: no cost read; bounds + timestamp cursor present in source", () => {
    const src = readFileSync(new URL("../../src/adapters/pi.ts", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(code).not.toMatch(/\.cost\b|costUSD/);
    expect(src).toMatch(/MAX_SESSION_FILES/);
    expect(src).toMatch(/MAX_SESSION_BYTES/);
    expect(src).toMatch(/Date\.parse/);
  });
});

describe("pi.collectUsage — THE BITING TEST: multi-attempt cursor fold is A+B+C, not 3A+2B+C", () => {
  const A = { input: 10, output: 1 };
  const B = { input: 100, output: 2 };
  const C = { input: 1000, output: 3 };

  test("growing the fixture between cursored reads folds to A+B+C (1110), never 3A+2B+C (1230)", () => {
    const cwd = scratch();

    plantSession(cwd, [sessionHeader(cwd), assistantMsg(cwd, T1, A)]);
    const r1 = collect(cwd, Date.parse(T1));

    plantSession(cwd, [sessionHeader(cwd), assistantMsg(cwd, T1, A), assistantMsg(cwd, T2, B)]);
    const r2 = collect(cwd, Date.parse(T2));

    plantSession(cwd, [
      sessionHeader(cwd),
      assistantMsg(cwd, T1, A),
      assistantMsg(cwd, T2, B),
      assistantMsg(cwd, T3, C),
    ]);
    const r3 = collect(cwd, Date.parse(T3));

    const total = addUsage(addUsage(r1!, r2!)!, r3!);
    expect(total).toEqual({ input: 1110, output: 6, cacheRead: undefined, cacheWrite: undefined, reasoning: undefined });
    expect(total.input).not.toBe(1230);
    expect(total.output).not.toBe(12);
  });

  test("resume drill: re-dispatch past the last record does not re-count the pre-crash slice", () => {
    const cwd = scratch();
    plantSession(cwd, [
      sessionHeader(cwd),
      assistantMsg(cwd, T1, A),
      assistantMsg(cwd, T2, B),
      assistantMsg(cwd, T3, C),
    ]);

    const Tr = Date.parse(T3) + 1000;
    expect(collect(cwd, Tr)).toBeUndefined();

    const D = { input: 7, output: 4 };
    const TrISO = new Date(Tr + 500).toISOString();
    plantSession(cwd, [
      sessionHeader(cwd),
      assistantMsg(cwd, T1, A),
      assistantMsg(cwd, T2, B),
      assistantMsg(cwd, T3, C),
      assistantMsg(cwd, TrISO, D),
    ]);

    expect(collect(cwd, Tr)).toEqual({ input: 7, output: 4 });
  });
});
