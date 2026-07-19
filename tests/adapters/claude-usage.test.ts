import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { claudeCode, claudeSlug } from "../../src/adapters/claude-code.js";
import { addUsage } from "../../src/adapters/types.js";

// SPEND-01/06: zero-token test — synthetic ~/.claude/projects/<slug>/*.jsonl under a temp HOME.
// homedir() honors HOME on posix, so we redirect the whole store and restore in afterEach.
// NEVER invokes the real claude binary.

const collect = claudeCode.collectUsage!;
let HOME: string;
let ORIG_HOME: string | undefined;

beforeEach(() => {
  ORIG_HOME = process.env.HOME;
  HOME = mkdtempSync(join(tmpdir(), "claude-usage-"));
  process.env.HOME = HOME;
});
afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
});

// build a session record exactly as claude writes it (realpath'd cwd + ISO timestamp + message.usage)
const rec = (cwd: string, tsISO: string | undefined, usage: unknown) => ({
  cwd: realpathSync(cwd),
  ...(tsISO === undefined ? {} : { timestamp: tsISO }),
  message: { usage },
});

// true slug from 36-DIAGNOSIS.md — NOT derived from the impl under test (D36-F anti-tautology)
const slugDir = (cwd: string) => join(HOME, ".claude", "projects", realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"));

// write one JSON object per line; `raw` lines are appended verbatim (torn-line fixtures)
function plantSession(cwd: string, records: unknown[], raw: string[] = [], file = "x.jsonl") {
  const dir = slugDir(cwd);
  mkdirSync(dir, { recursive: true });
  const lines = [...records.map((r) => JSON.stringify(r)), ...raw];
  writeFileSync(join(dir, file), lines.join("\n"));
}

// a real dir on disk so realpathSync resolves (symlink-safe on darwin)
const scratch = () => mkdtempSync(join(tmpdir(), "cwd-"));

// worktree-shaped cwd — the ONLY shape tickmarkr dispatches into (git.ts:33); the "." is the bug
const worktreeScratch = () => {
  const root = mkdtempSync(join(tmpdir(), "wt-"));
  const wt = join(root, ".tickmarkr", "worktrees", "tickmarkr-task_1");
  mkdirSync(wt, { recursive: true });
  return wt;
};

// claude splits ONE response across N records, each repeating the FULL usage (36-DIAGNOSIS.md A6)
const assistantRec = (cwd: string, ts: string, id: string, usage: unknown) => ({
  type: "assistant",
  cwd: realpathSync(cwd),
  timestamp: ts,
  message: { role: "assistant", id, content: [], usage },
});

const T1 = "2026-07-10T12:00:00.000Z";
const T2 = "2026-07-10T12:05:00.000Z";
const T3 = "2026-07-10T12:10:00.000Z";

describe("claudeCode.collectUsage — fail-open matrix + happy path", () => {
  test("happy path: sums the four token counts across records", () => {
    const cwd = scratch();
    plantSession(cwd, [
      rec(cwd, T1, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }),
      rec(cwd, T2, { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
    expect(collect(cwd, 0)).toEqual({ input: 300, output: 30, cacheRead: 5, cacheWrite: 2 });
  });

  test("cursor slice: only records at/after sinceMs count", () => {
    const cwd = scratch();
    plantSession(cwd, [
      rec(cwd, T1, { input_tokens: 100, output_tokens: 10 }),
      rec(cwd, T2, { input_tokens: 200, output_tokens: 20 }),
    ]);
    expect(collect(cwd, Date.parse(T2))).toEqual({ input: 200, output: 20 });
  });

  test("cwd mismatch: a record for a different cwd is undefined", () => {
    const cwd = scratch();
    const other = scratch();
    plantSession(cwd, [{ cwd: realpathSync(other), timestamp: T1, message: { usage: { input_tokens: 100, output_tokens: 10 } } }]);
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("no projects/slug dir: undefined", () => {
    const cwd = scratch();
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("torn last line: valid record still sums, truncated line dropped", () => {
    const cwd = scratch();
    plantSession(
      cwd,
      [rec(cwd, T1, { input_tokens: 100, output_tokens: 10 })],
      [`{"cwd":"${realpathSync(cwd)}","timestamp":"${T2}","message":{"usage"`],
    );
    expect(collect(cwd, 0)).toEqual({ input: 100, output: 10 });
  });

  test("malformed usage: bad record contributes nothing, sibling sums", () => {
    const cwd = scratch();
    plantSession(cwd, [
      rec(cwd, T1, "not-a-usage-object"),
      rec(cwd, T2, { input_tokens: 200, output_tokens: 20 }),
    ]);
    expect(collect(cwd, 0)).toEqual({ input: 200, output: 20 });
  });

  test("malformed usage only: undefined", () => {
    const cwd = scratch();
    plantSession(cwd, [rec(cwd, T1, "not-a-usage-object")]);
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("absent/unparseable timestamp: SKIPPED even at cursor 0, sibling sums", () => {
    const cwd = scratch();
    plantSession(cwd, [
      rec(cwd, undefined, { input_tokens: 999, output_tokens: 99 }),
      rec(cwd, "not-a-date", { input_tokens: 888, output_tokens: 88 }),
      rec(cwd, T1, { input_tokens: 100, output_tokens: 10 }),
    ]);
    expect(collect(cwd, 0)).toEqual({ input: 100, output: 10 });
  });

  test("all timestamps unparseable: undefined", () => {
    const cwd = scratch();
    plantSession(cwd, [rec(cwd, "not-a-date", { input_tokens: 100, output_tokens: 10 })]);
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("SPEND-06: costUSD present is ignored, no cost/usd/price key returned", () => {
    const cwd = scratch();
    plantSession(cwd, [rec(cwd, T1, { input_tokens: 100, output_tokens: 10, costUSD: 0.743394 })]);
    const u = collect(cwd, 0)!;
    expect(u).toEqual({ input: 100, output: 10 });
    for (const k of Object.keys(u)) expect(k).not.toMatch(/cost|usd|price/i);
  });

  test("symlink cwd (darwin): impl slug matches the realpath-based slug plantSession used", () => {
    const cwd = scratch();
    plantSession(cwd, [rec(cwd, T1, { input_tokens: 100, output_tokens: 10 })]);
    // realpath resolution: plantSession keyed by realpathSync(cwd); collect must find it via the same realpath
    expect(collect(cwd, 0)).toEqual({ input: 100, output: 10 });
  });

  test("bound sanity: many session files, newest sums without error", () => {
    const cwd = scratch();
    // newest file (highest mtime) carries the usage we assert on
    for (let i = 0; i < 25; i++) {
      plantSession(cwd, [rec(cwd, T1, { input_tokens: 1, output_tokens: 0 })], [], `s${i}.jsonl`);
    }
    plantSession(cwd, [rec(cwd, T3, { input_tokens: 500, output_tokens: 50 })], [], "zz-newest.jsonl");
    const u = collect(cwd, Date.parse(T3))!;
    expect(u.input).toBeGreaterThanOrEqual(500);
  });

  test("text pin: no cost read; bounds + timestamp cursor present in source", () => {
    const src = readFileSync(new URL("../../src/adapters/claude-code.ts", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(code).not.toMatch(/costUSD|\.cost\b/);
    expect(src).toMatch(/MAX_SESSION_FILES/);
    expect(src).toMatch(/MAX_SESSION_BYTES/);
    expect(src).toMatch(/Date\.parse/);
  });
});

describe("claudeCode.collectUsage — THE BITING TEST: multi-attempt cursor fold is A+B+C, not 3A+2B+C", () => {
  const A = { input_tokens: 10, output_tokens: 1 };
  const B = { input_tokens: 100, output_tokens: 2 };
  const C = { input_tokens: 1000, output_tokens: 3 };

  test("growing the fixture between cursored reads folds to A+B+C (1110), never 3A+2B+C (1230)", () => {
    const cwd = scratch();

    // Attempt 1: store holds [A]; cursor at T1 admits A only.
    plantSession(cwd, [rec(cwd, T1, A)]);
    const r1 = collect(cwd, Date.parse(T1));

    // Attempt 2: store ACCUMULATED to [A, B] (claude never wipes $HOME); cursor at T2 admits B only.
    plantSession(cwd, [rec(cwd, T1, A), rec(cwd, T2, B)]);
    const r2 = collect(cwd, Date.parse(T2));

    // Attempt 3: store = [A, B, C]; cursor at T3 admits C only.
    plantSession(cwd, [rec(cwd, T1, A), rec(cwd, T2, B), rec(cwd, T3, C)]);
    const r3 = collect(cwd, Date.parse(T3));

    // the daemon's per-attempt fold (r1 is the base)
    const total = addUsage(addUsage(r1!, r2!)!, r3!);

    // correct: A+B+C
    expect(total).toEqual({ input: 1110, output: 6, cacheRead: undefined, cacheWrite: undefined, reasoning: undefined });
    // the clause that reddens if the cursor is dropped: a cursor-less reader folds to 3A+2B+C
    expect(total.input).not.toBe(1230); // 3*10 + 2*100 + 1000
    expect(total.output).not.toBe(12); // 3*1 + 2*2 + 3
  });

  test("resume drill: re-dispatch past the last record does not re-count the pre-crash slice", () => {
    const cwd = scratch();
    plantSession(cwd, [rec(cwd, T1, A), rec(cwd, T2, B), rec(cwd, T3, C)]);

    // resume re-dispatch cursor sits AFTER the last record; no new record yet ⇒ undefined (no re-count).
    const Tr = Date.parse(T3) + 1000;
    expect(collect(cwd, Tr)).toBeUndefined();

    // the resumed attempt writes its OWN record D at Tr+500ms.
    const D = { input_tokens: 7, output_tokens: 4 };
    const TrISO = new Date(Tr + 500).toISOString();
    plantSession(cwd, [rec(cwd, T1, A), rec(cwd, T2, B), rec(cwd, T3, C), rec(cwd, TrISO, D)]);

    // resume bills the redo (D) only, NOT C+D.
    expect(collect(cwd, Tr)).toEqual({ input: 7, output: 4 });
  });
});

describe("SPEND-11: headless worktree-shaped metering + per-message dedup", () => {
  test("S1 — headless store in a WORKTREE-shaped cwd is found", () => {
    const wt = worktreeScratch();
    plantSession(wt, [
      assistantRec(wt, T1, "msg_spend11_a", { input_tokens: 10, output_tokens: 106 }),
    ]);
    expect(collect(wt, 0)).toEqual({ input: 10, output: 106 });
  });

  test("S2 — dedup: same message.id counted once", () => {
    const wt = worktreeScratch();
    const usage = { input_tokens: 10, output_tokens: 106 };
    plantSession(wt, [
      assistantRec(wt, T1, "msg_011CcufwiZQWXVjTNE8Ab7bX", usage),
      assistantRec(wt, T1, "msg_011CcufwiZQWXVjTNE8Ab7bX", usage),
    ]);
    expect(collect(wt, 0)).toEqual({ input: 10, output: 106 });
  });

  test("S3 — distinct message.id values still sum", () => {
    const wt = worktreeScratch();
    const usage = { input_tokens: 10, output_tokens: 106 };
    plantSession(wt, [
      assistantRec(wt, T1, "msg_a", usage),
      assistantRec(wt, T2, "msg_b", usage),
    ]);
    expect(collect(wt, 0)).toEqual({ input: 20, output: 212 });
  });

  test("S4 — dedup respects the cursor: pre-sinceMs twin does not suppress post-cursor record", () => {
    const wt = worktreeScratch();
    const usage = { input_tokens: 10, output_tokens: 106 };
    plantSession(wt, [
      assistantRec(wt, T1, "msg_shared", usage),
      assistantRec(wt, T2, "msg_shared", usage),
    ]);
    expect(collect(wt, Date.parse(T2))).toEqual({ input: 10, output: 106 });
  });

  test("S5 — slug charset pin: cwd with . _ - and digit is found", () => {
    const root = mkdtempSync(join(tmpdir(), "slug-"));
    const cwd = join(root, "a.b_c-d0");
    mkdirSync(cwd, { recursive: true });
    plantSession(cwd, [
      assistantRec(cwd, T1, "msg_slug", { input_tokens: 5, output_tokens: 3 }),
    ]);
    expect(collect(cwd, 0)).toEqual({ input: 5, output: 3 });
  });

  test("S7 — claudeSlug pinned against hand-written literal pairs", () => {
    const pairs: [string, string][] = [
      ["/private/tmp/s11b/.tickmarkr/worktrees/tickmarkr-task_1", "-private-tmp-s11b--tickmarkr-worktrees-tickmarkr-task-1"],
      ["/foo.bar_baz-qux0", "-foo-bar-baz-qux0"],
    ];
    for (const [input, expected] of pairs) expect(claudeSlug(input)).toBe(expected);
  });
});
