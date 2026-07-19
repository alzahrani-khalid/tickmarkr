import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { pi } from "../../src/adapters/pi.js";
import type { SessionRef } from "../../src/adapters/types.js";

// v1.23 T1: zero-token — synthetic session JSONL under a temp HOME. NEVER invokes a real agent CLI.

let HOME: string;
let ORIG_HOME: string | undefined;

beforeEach(() => {
  ORIG_HOME = process.env.HOME;
  HOME = mkdtempSync(join(tmpdir(), "ctx-usage-"));
  process.env.HOME = HOME;
});
afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
});

const scratch = () => mkdtempSync(join(tmpdir(), "cwd-"));

// slug formulas independent of the impl under test (anti-tautology, D36-F)
const claudeSlugDir = (cwd: string) =>
  join(HOME, ".claude", "projects", realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"));
const piSlugDir = (cwd: string) =>
  join(HOME, ".pi", "agent", "sessions", "-" + realpathSync(cwd).replaceAll("/", "-") + "--");

function plantClaude(cwd: string, sessionId: string, records: unknown[]) {
  const dir = claudeSlugDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n"));
}

function plantPi(cwd: string, sessionId: string, records: unknown[]) {
  const dir = piSlugDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n"));
}

const claudeUsage = (input: number, cacheCreation: number, cacheRead: number, output = 10) => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheCreation,
  cache_read_input_tokens: cacheRead,
  output_tokens: output,
});

const claudeRec = (usage: ReturnType<typeof claudeUsage>, id = "msg_1") => ({
  type: "assistant",
  message: { role: "assistant", id, usage },
  timestamp: "2026-07-13T12:00:00.000Z",
});

const piAssistant = (usage: { input: number; cacheWrite: number; cacheRead: number; output?: number }) => ({
  type: "message",
  message: {
    role: "assistant",
    usage: {
      input: usage.input,
      output: usage.output ?? 5,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      reasoning: 0,
      totalTokens: usage.input + (usage.output ?? 5) + usage.cacheRead + usage.cacheWrite,
    },
  },
  timestamp: "2026-07-13T12:00:00.000Z",
});

describe("claudeCode.contextUsage — last turn, disk only", () => {
  test("LAST turn tokens = input + cache_creation + cache_read (not a sum over turns)", () => {
    const cwd = scratch();
    const id = "sess-last-turn";
    // turn 1: huge context; turn 2: smaller — must return turn 2 only, never 1000+200+50 + 10+5+200
    plantClaude(cwd, id, [
      claudeRec(claudeUsage(1000, 200, 50), "msg_a"),
      claudeRec(claudeUsage(10, 5, 200), "msg_b"),
    ]);
    const got = claudeCode.contextUsage!({ cwd, id });
    expect(got).toEqual({ tokens: 10 + 5 + 200 }); // 215 — not 1465
    expect(got!.tokens).not.toBe(1000 + 200 + 50 + 10 + 5 + 200);
  });

  test("missing session file ⇒ null (unknown, not zero)", () => {
    const cwd = scratch();
    expect(claudeCode.contextUsage!({ cwd, id: "no-such-session" })).toBeNull();
  });

  test("empty jsonl / no usage lines ⇒ null", () => {
    const cwd = scratch();
    plantClaude(cwd, "empty", [{ type: "user", message: { role: "user", content: "hi" } }]);
    expect(claudeCode.contextUsage!({ cwd, id: "empty" })).toBeNull();
  });

  test("path traversal in session id ⇒ null", () => {
    const cwd = scratch();
    expect(claudeCode.contextUsage!({ cwd, id: "../evil" })).toBeNull();
    expect(claudeCode.contextUsage!({ cwd, id: "a/b" })).toBeNull();
  });
});

describe("pi.contextUsage — last turn, disk only", () => {
  test("LAST assistant turn: input + cacheWrite + cacheRead", () => {
    const cwd = scratch();
    const id = "019f-pi-session";
    plantPi(cwd, id, [
      { type: "session", version: 3, id, cwd: realpathSync(cwd) },
      piAssistant({ input: 5000, cacheWrite: 100, cacheRead: 50 }),
      piAssistant({ input: 100, cacheWrite: 0, cacheRead: 2048 }),
    ]);
    expect(pi.contextUsage!({ cwd, id })).toEqual({ tokens: 100 + 0 + 2048 });
  });

  test("missing store ⇒ null", () => {
    const cwd = scratch();
    expect(pi.contextUsage!({ cwd, id: "gone" })).toBeNull();
  });
});

describe("adapters without a knowable store — null is unknown", () => {
  test("fake.contextUsage always returns null", () => {
    const script = join(HOME, "fake-script.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    const session: SessionRef = { cwd: scratch(), id: "any" };
    const u = fake.contextUsage(session);
    expect(u).toBeNull();
    // pin the caller contract: null is unknown — never coerce to 0 for threshold math
    const known = u !== null;
    expect(known).toBe(false);
    const overThreshold = known && u!.tokens >= 170_000;
    expect(overThreshold).toBe(false);
  });
});

describe("contextUsage is disk-only (no agent CLI spawn)", () => {
  test("claude-code and pi contextUsage sources never spawn or network", async () => {
    // static pin: strip comments, then the method body must not call spawn/fetch/pane/driver.read
    const { readFileSync } = await import("node:fs");
    for (const rel of ["src/adapters/claude-code.ts", "src/adapters/pi.ts"]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const body = (src.split("contextUsage(session")[1]?.split(/\n  [a-zA-Z]/)[0] ?? "")
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(body.length).toBeGreaterThan(50);
      expect(body).not.toMatch(/\bspawn(?:Sync)?\s*\(/);
      expect(body).not.toMatch(/\bfetch\s*\(/);
      expect(body).not.toMatch(/driver\.read/);
      expect(body).not.toMatch(/\bpane\b/);
      expect(body).toMatch(/readFileSync/);
    }
  });
});
