import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { opencode } from "../../src/adapters/opencode.js";
import { addUsage } from "../../src/adapters/types.js";

// SPEND-09: zero-token test — synthetic opencode.db under temp XDG_DATA_HOME.
// NEVER invokes the real opencode binary; sqlite3 is a local file tool only.

const sqlite3Ok = (() => {
  const r = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
})();

const collect = opencode.collectUsage!;

let XDG: string;
let ORIG_XDG: string | undefined;
let ORIG_HOME: string | undefined;

const dbPath = () => join(XDG, "opencode", "opencode.db");

// REAL message.data fixture from 29-RESEARCH.md (live probe 2026-07-11)
const REAL_FIXTURE = {
  parentID: "msg_f4e3135b200168WyQCT17zTGm9",
  role: "assistant",
  mode: "build",
  agent: "build",
  path: { cwd: "", root: "/" },
  cost: 0,
  tokens: { total: 35306, input: 35175, output: 3, reasoning: 0, cache: { write: 0, read: 128 } },
  modelID: "glm-5.2",
  providerID: "zai-coding-plan",
  time: { created: 1783723275872, completed: 1783723283822 },
  finish: "stop",
};

type MsgRow = { id: string; session_id: string; time_created: number; time_updated: number; data: object };

function sqlLit(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function plantDb(rows: MsgRow[], sessionCumulative?: { tokens_input: number; tokens_output: number }) {
  mkdirSync(join(XDG, "opencode"), { recursive: true });
  const db = dbPath();
  spawnSync("sqlite3", [db, "CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);"], { encoding: "utf8" });
  if (sessionCumulative) {
    spawnSync("sqlite3", [db, "CREATE TABLE session(id TEXT, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL);"], { encoding: "utf8" });
    spawnSync("sqlite3", [db, `INSERT INTO session VALUES('ses_trap', ${sessionCumulative.tokens_input}, ${sessionCumulative.tokens_output}, 0, 0, 0, 0);`], { encoding: "utf8" });
  }
  for (const row of rows) {
    const data = JSON.stringify(row.data);
    spawnSync("sqlite3", [db, `INSERT INTO message VALUES(${sqlLit(row.id)}, ${sqlLit(row.session_id)}, ${row.time_created}, ${row.time_updated}, ${sqlLit(data)});`], { encoding: "utf8" });
  }
}

function insertRow(row: MsgRow) {
  const data = JSON.stringify(row.data);
  spawnSync("sqlite3", [dbPath(), `INSERT INTO message VALUES(${sqlLit(row.id)}, ${sqlLit(row.session_id)}, ${row.time_created}, ${row.time_updated}, ${sqlLit(data)});`], { encoding: "utf8" });
}

function msgData(cwd: string, created: number, tokens: { input: number; output: number; reasoning?: number; cache?: { read?: number; write?: number } }, extra: Record<string, unknown> = {}) {
  const tok: Record<string, unknown> = {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning ?? 0,
  };
  if (tokens.cache) tok.cache = { read: tokens.cache.read ?? 0, write: tokens.cache.write ?? 0 };
  return {
    role: "assistant",
    path: { cwd: realpathSync(cwd), root: "/" },
    cost: 0,
    tokens: tok,
    time: { created, completed: created + 1000 },
    ...extra,
  };
}

const scratch = () => mkdtempSync(join(tmpdir(), "oc-cwd-"));

beforeEach(() => {
  ORIG_XDG = process.env.XDG_DATA_HOME;
  ORIG_HOME = process.env.HOME;
  XDG = mkdtempSync(join(tmpdir(), "oc-usage-"));
  process.env.XDG_DATA_HOME = XDG;
  process.env.HOME = XDG;
});

afterEach(() => {
  if (ORIG_XDG === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = ORIG_XDG;
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
});

describe.skipIf(!sqlite3Ok)("opencode.collectUsage — fail-open matrix + happy path", () => {
  test("happy path: real fixture sums disjoint token fields", () => {
    const cwd = scratch();
    const data = { ...REAL_FIXTURE, path: { ...REAL_FIXTURE.path, cwd: realpathSync(cwd) } };
    plantDb([{ id: "m1", session_id: "s1", time_created: data.time.created, time_updated: data.time.created, data }]);
    expect(collect(cwd, 0)).toEqual({ input: 35175, output: 3, cacheRead: 128, cacheWrite: 0 });
    expect(collect(cwd, 0)!.reasoning).toBeUndefined();
  });

  test("DRILL epoch-ms cursor: sinceMs between two rows keeps only the later row", () => {
    const cwd = scratch();
    const t1 = 1_700_000_000_000;
    const t2 = t1 + 60_000;
    const since = t1 + 30_000;
    plantDb([
      { id: "a", session_id: "s", time_created: t1, time_updated: t1, data: msgData(cwd, t1, { input: 100, output: 1 }) },
      { id: "b", session_id: "s", time_created: t2, time_updated: t2, data: msgData(cwd, t2, { input: 200, output: 2 }) },
    ]);
    expect(collect(cwd, since)).toEqual({ input: 200, output: 2 });
  });

  test("cwd mismatch: row for a different realpath is undefined", () => {
    const cwd = scratch();
    const other = scratch();
    plantDb([{ id: "m", session_id: "s", time_created: 1000, time_updated: 1000, data: msgData(other, 1000, { input: 100, output: 10 }) }]);
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("fail-open: no opencode.db at all ⇒ undefined", () => {
    const cwd = scratch();
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("fail-open: malformed JSON row skipped, sibling sums", () => {
    const cwd = scratch();
    const t = 1_700_000_000_000;
    plantDb([
      { id: "bad", session_id: "s", time_created: t, time_updated: t, data: { not: "valid usage shape" } as object },
      { id: "good", session_id: "s", time_created: t + 1, time_updated: t + 1, data: msgData(cwd, t + 1, { input: 200, output: 20 }) },
    ]);
    // malformed row lacks tokens/path/time — should not count
    spawnSync("sqlite3", [dbPath(), `UPDATE message SET data='not-json' WHERE id='bad';`], { encoding: "utf8" });
    expect(collect(cwd, 0)).toEqual({ input: 200, output: 20 });
  });

  test("fail-open: nothing matched ⇒ undefined, never {input:0}", () => {
    const cwd = scratch();
    const other = scratch();
    plantDb([{ id: "m", session_id: "s", time_created: 1000, time_updated: 1000, data: msgData(other, 1000, { input: 100, output: 10 }) }]);
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("DRILL reasoning: tokens.reasoning present ⇒ result.reasoning undefined", () => {
    const cwd = scratch();
    const t = 1_700_000_000_000;
    plantDb([{ id: "m", session_id: "s", time_created: t, time_updated: t, data: msgData(cwd, t, { input: 10, output: 5, reasoning: 5 }) }]);
    const u = collect(cwd, 0)!;
    expect(u.output).toBe(5);
    expect(u.reasoning).toBeUndefined();
  });

  test("DRILL cost:0 fixture — no cost/usd/price key in result", () => {
    const cwd = scratch();
    const data = { ...REAL_FIXTURE, path: { ...REAL_FIXTURE.path, cwd: realpathSync(cwd) } };
    plantDb([{ id: "m1", session_id: "s1", time_created: data.time.created, time_updated: data.time.created, data }]);
    const u = collect(cwd, 0)!;
    for (const k of Object.keys(u)) expect(k).not.toMatch(/cost|usd|price/i);
  });

  test("legacy-store immunity: storage/message JSON with zeros + empty db dir ⇒ undefined", () => {
    const cwd = scratch();
    const legacy = join(XDG, "opencode", "storage", "message", "x", "y.json");
    mkdirSync(join(XDG, "opencode", "storage", "message", "x"), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ tokens: { input: 0, output: 0 }, path: { cwd: realpathSync(cwd) } }));
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("source pin: sqlite3 args array, Math.floor(sinceMs), no banned reads", () => {
    const src = readFileSync(new URL("../../src/adapters/opencode.ts", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(code).not.toMatch(/\.cost\b|costUSD|tokens_input|FROM session\b/);
    expect(code).toMatch(/spawnSync\("sqlite3"/);
    expect(code).toMatch(/time_created >=/);
    expect(code).toMatch(/Math\.floor\(sinceMs\)/);
    expect(code).not.toMatch(/cwd.*SELECT|SELECT.*\$\{(?!Math)/);
  });

  test("injection posture pin: cwd never interpolated into SQL", () => {
    const src = readFileSync(new URL("../../src/adapters/opencode.ts", import.meta.url), "utf8");
    expect(src).toMatch(/realpathSync\(cwd\)/);
    expect(src).not.toMatch(/SELECT.*cwd/);
  });
});

describe.skipIf(!sqlite3Ok)("opencode.collectUsage — growing store fold A+B+C, not session cumulative", () => {
  const A = { input: 10, output: 1 };
  const B = { input: 100, output: 2 };
  const C = { input: 1000, output: 3 };
  const T1 = 1_700_000_000_000;
  const T2 = T1 + 60_000;
  const T3 = T2 + 60_000;

  test("growing message table folds to A+B+C via per-attempt cursor, not session.tokens_*", () => {
    const cwd = scratch();
    mkdirSync(join(XDG, "opencode"), { recursive: true });
    const db = dbPath();
    spawnSync("sqlite3", [db, "CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);"], { encoding: "utf8" });
    spawnSync("sqlite3", [db, "CREATE TABLE session(id TEXT, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL);"], { encoding: "utf8" });
    spawnSync("sqlite3", [db, "INSERT INTO session VALUES('ses_trap', 99999, 88888, 0, 0, 0, 0);"], { encoding: "utf8" });

    insertRow({ id: "a", session_id: "ses_trap", time_created: T1, time_updated: T1, data: msgData(cwd, T1, A) });
    const r1 = collect(cwd, T1);

    insertRow({ id: "b", session_id: "ses_trap", time_created: T2, time_updated: T2, data: msgData(cwd, T2, B) });
    const r2 = collect(cwd, T2);

    insertRow({ id: "c", session_id: "ses_trap", time_created: T3, time_updated: T3, data: msgData(cwd, T3, C) });
    const r3 = collect(cwd, T3);

    const total = addUsage(addUsage(r1!, r2!)!, r3!);
    expect(total).toEqual({ input: 1110, output: 6, cacheRead: undefined, cacheWrite: undefined, reasoning: undefined });
    expect(total.input).not.toBe(99999);
    expect(total.output).not.toBe(88888);
    expect(total.input).not.toBe(1230);
  });
});
