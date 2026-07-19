import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { kimi } from "../../src/adapters/kimi.js";

// v1.58 T5: zero-token test — synthetic ~/.kimi-code store under a temp HOME (homedir() honors
// HOME on posix; same seam as claude-usage.test.ts). NEVER invokes the real kimi binary.
// Fixture shapes are byte-faithful to the LIVE kimi 0.27.0 store probed 2026-07-18: a top-level
// {"type":"usage.record","usage":{inputOther,output,inputCacheRead,inputCacheCreation},
// "usageScope":"turn","time":<epoch ms>} row per turn, with the SAME usage echoed inside the
// step.end loop event — the echo is the double-count trap these tests pin against.

const collect = kimi.collectUsage!;
let HOME: string;
let ORIG_HOME: string | undefined;

beforeEach(() => {
  ORIG_HOME = process.env.HOME;
  HOME = mkdtempSync(join(tmpdir(), "kimi-usage-"));
  process.env.HOME = HOME;
});
afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
});

const T1 = 1_784_399_000_000;
const T2 = 1_784_399_100_000;
const T3 = 1_784_399_200_000;

// rows exactly as kimi 0.27.0 writes them (live probe 2026-07-18)
const usageRec = (time: number, usage: unknown, usageScope = "turn") => ({
  type: "usage.record", model: "kimi-code/kimi-for-coding-highspeed", usage, usageScope, time,
});
const stepEndEcho = (time: number, usage: unknown) => ({
  type: "context.append_loop_event",
  event: { type: "step.end", uuid: "u-1", turnId: "0", step: 1, usage, finishReason: "end_turn" },
  time,
});

// plant workspaces.json + one wire.jsonl exactly at the live store layout:
// ~/.kimi-code/sessions/<wd>/session_<id>/agents/main/wire.jsonl
function plantStore(cwd: string, records: unknown[], raw: string[] = [], wd = "wd_x_0000", session = "session_1") {
  const home = join(HOME, ".kimi-code");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "workspaces.json"),
    JSON.stringify({ version: 1, workspaces: { [wd]: { root: realpathSync(cwd), name: "x" } } }),
  );
  const dir = join(home, "sessions", wd, session, "agents", "main");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "wire.jsonl"), [...records.map((r) => JSON.stringify(r)), ...raw].join("\n"));
}

// a real dir on disk so realpathSync resolves (symlink-safe on darwin)
const scratch = () => mkdtempSync(join(tmpdir(), "cwd-"));

describe("kimi.collectUsage — wire journal fold (KIMI-03 lifted, v1.58 T5)", () => {
  test("kimi usage folds wire journal usage rows into normalized token counts", () => {
    const cwd = scratch();
    const u1 = { inputOther: 10012, output: 37, inputCacheRead: 17920, inputCacheCreation: 0 };
    const u2 = { inputOther: 2678, output: 446, inputCacheRead: 41472, inputCacheCreation: 0 };
    // each turn also ECHOES its usage in the step.end loop event — folding echoes doubles every count
    plantStore(cwd, [stepEndEcho(T1, u1), usageRec(T1, u1), stepEndEcho(T2, u2), usageRec(T2, u2)]);
    expect(collect(cwd, 0)).toEqual({ input: 12690, output: 483, cacheRead: 59392, cacheWrite: 0 });
  });

  test("cache read and cache creation fields map to the normalized cache fields", () => {
    const cwd = scratch();
    plantStore(cwd, [usageRec(T1, { inputOther: 100, output: 10, inputCacheRead: 17920, inputCacheCreation: 256 })]);
    expect(collect(cwd, 0)).toEqual({ input: 100, output: 10, cacheRead: 17920, cacheWrite: 256 });
  });

  test("kimi usage returns undefined when no session matches the workspace window", () => {
    const cwd = scratch();
    const other = scratch();
    // (a) workspace map points at a DIFFERENT root — nothing matches this cwd
    plantStore(other, [usageRec(T1, { inputOther: 100, output: 10, inputCacheRead: 0, inputCacheCreation: 0 })]);
    expect(collect(cwd, 0)).toBeUndefined();
    // (b) workspace matches but every row predates the attempt window — cursor admits nothing
    plantStore(cwd, [usageRec(T1, { inputOther: 100, output: 10, inputCacheRead: 0, inputCacheCreation: 0 })]);
    expect(collect(cwd, T2)).toBeUndefined();
    // (c) no ~/.kimi-code at all
    process.env.HOME = mkdtempSync(join(tmpdir(), "kimi-empty-"));
    expect(collect(cwd, 0)).toBeUndefined();
  });

  test("cursor slice: only rows at/after sinceMs count", () => {
    const cwd = scratch();
    plantStore(cwd, [
      usageRec(T1, { inputOther: 100, output: 10, inputCacheRead: 5, inputCacheCreation: 0 }),
      usageRec(T2, { inputOther: 200, output: 20, inputCacheRead: 7, inputCacheCreation: 0 }),
    ]);
    expect(collect(cwd, T2)).toEqual({ input: 200, output: 20, cacheRead: 7, cacheWrite: 0 });
  });

  test("ambiguity resolves to unmetered: unknown scope, garbage usage, torn line — never an invented count", () => {
    const cwd = scratch();
    plantStore(
      cwd,
      [
        usageRec(T1, { inputOther: 999, output: 99, inputCacheRead: 1, inputCacheCreation: 0 }, "cumulative"), // unknown scope: skip
        usageRec(T1, "not-a-usage-object"), // garbage usage: skip
        usageRec(T1, { inputOther: "9", output: 9 }), // non-numeric core field: skip
        { type: "usage.record", usage: { inputOther: 5, output: 5 }, usageScope: "turn" }, // no time: skip
      ],
      [`{"type":"usage.record","usage":{"inputOther"`], // torn line: dropped
    );
    // only ambiguous rows exist ⇒ unmetered, never {input:0,…} or a folded guess
    expect(collect(cwd, 0)).toBeUndefined();
    // a valid sibling row still sums alone
    plantStore(cwd, [
      usageRec(T1, { inputOther: 999, output: 99, inputCacheRead: 1, inputCacheCreation: 0 }, "cumulative"),
      usageRec(T2, { inputOther: 300, output: 30, inputCacheRead: 4, inputCacheCreation: 0 }),
    ]);
    expect(collect(cwd, 0)).toEqual({ input: 300, output: 30, cacheRead: 4, cacheWrite: 0 });
  });

  test("multiple wd dirs for one root fold together; other agents' wire journals count", () => {
    const cwd = scratch();
    const home = join(HOME, ".kimi-code");
    mkdirSync(home, { recursive: true });
    const root = realpathSync(cwd);
    // a recreated workspace gets a fresh wd_* hash for the SAME root — both must fold
    writeFileSync(join(home, "workspaces.json"), JSON.stringify({
      version: 1,
      workspaces: { wd_a_1: { root, name: "a" }, wd_b_2: { root, name: "b" }, wd_c_3: { root: "/elsewhere", name: "c" } },
    }));
    const plant = (wd: string, agent: string, rec: unknown) => {
      const dir = join(home, "sessions", wd, "session_1", "agents", agent);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "wire.jsonl"), JSON.stringify(rec));
    };
    plant("wd_a_1", "main", usageRec(T1, { inputOther: 100, output: 10, inputCacheRead: 0, inputCacheCreation: 0 }));
    plant("wd_b_2", "sub", usageRec(T2, { inputOther: 200, output: 20, inputCacheRead: 0, inputCacheCreation: 0 }));
    plant("wd_c_3", "main", usageRec(T3, { inputOther: 999, output: 99, inputCacheRead: 0, inputCacheCreation: 0 }));
    expect(collect(cwd, 0)).toEqual({ input: 300, output: 30, cacheRead: 0, cacheWrite: 0 });
  });

  test("text pin: the field mapping is live-verified, bounded, cursored, and never coalesces absent usage to zero", () => {
    const src = readFileSync(join(import.meta.dirname, "../../src/adapters/kimi.ts"), "utf8");
    // the mapping was pinned only after live verification of the real session store's usage rows
    expect(src).toMatch(/live verification/i);
    expect(src).toMatch(/usage\.record/);
    expect(src).toMatch(/inputOther/);
    expect(src).toMatch(/MAX_SESSION_FILES/);
    expect(src).toMatch(/MAX_SESSION_BYTES/);
    const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    // the "?? 0" poisoning class stays banned on the core fields (only observed counts fold)
    expect(code).not.toMatch(/inputOther\s*\?\?\s*0/);
    expect(code).not.toMatch(/output\s*\?\?\s*0/);
    expect(code).not.toMatch(/costUSD|\.cost\b/);
  });
});
