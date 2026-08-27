import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { pi, readPiServedModels, type ServedModelDrift, servedModelNote } from "../../src/adapters/pi.js";
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


// v2.1.3 T7 — pi states the model it was SERVED in message.responseModel, and writes that field only
// where it differs from the pinned message.model. Zero-token: the probe's two spawns (`pi --version`,
// `pi --list-models`) are answered by a stub `pi` first on PATH — the real binary is never invoked and
// no model turn happens — while HOME points at the same synthetic session store the rig above plants.
type Rec = { model: string; responseModel?: string };

// VERBATIM capture (pi 0.80.x, ~/.pi/agent/sessions, record b292aa13 of 2026-08-19T11:34:50.797Z):
// the drifting record as pi actually writes it — pinned glm-5.2, served glm-5.3.
const DRIFTED: Rec = { model: "glm-5.2", responseModel: "glm-5.3" };
// An ordinary turn from the same store: the two agree, so pi writes no responseModel at all.
const ORDINARY: Rec = { model: "glm-5.2" };

const servedMsg = (tsISO: string, rec: Rec) => ({
  type: "message",
  id: "msg-served",
  parentId: "parent",
  timestamp: tsISO,
  message: {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "zai",
    model: rec.model,
    usage: { input: 1354, output: 3, cacheRead: 2624, cacheWrite: 0 },
    stopReason: "stop",
    ...(rec.responseModel !== undefined ? { responseModel: rec.responseModel } : {}),
  },
});

// Both neighbours below read the SAME planted store the shipped reader reads, off the same bytes on
// disk. The only thing that differs between them and the shipped reader is one expression: which
// field each takes as "the model that was served". That keeps the falsification honest — a neighbour
// built out of an in-memory array would be a strawman, green because it never met the records.
function readWith(servedOf: (m: Record<string, unknown>) => unknown): ServedModelDrift[] {
  const root = join(HOME, ".pi", "agent", "sessions");
  const out: ServedModelDrift[] = [];
  for (const slug of readdirSync(root)) {
    for (const f of readdirSync(join(root, slug))) {
      for (const line of readFileSync(join(root, slug, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        let recRaw: unknown;
        try {
          recRaw = JSON.parse(line);
        } catch {
          continue;
        }
        const rec = recRaw as { type?: unknown; message?: Record<string, unknown> };
        if (rec.type !== "message" || rec.message?.role !== "assistant") continue;
        const pinned = rec.message.model;
        const served = servedOf(rec.message);
        if (typeof pinned !== "string" || served === pinned) continue;
        out.push({ pinned, served: typeof served === "string" ? served : "unknown" });
      }
    }
  }
  return out;
}

// The neighbouring wrong answer: read the served model off message.model. It agrees with the honest
// reader on every ordinary record — and on the drifting one too, which is exactly the defect.
const pinnedAsServed = () => readWith((m) => m.model);

// The other neighbour: treat an absent responseModel as a mismatch (undefined ⇒ never equal ⇒ alarm).
const absentIsMismatch = () => readWith((m) => m.responseModel);

describe("pi.probe — the model pi was served (v2.1.3 T7)", () => {
  let ORIG_PATH: string | undefined;
  let ORIG_LIST_MODELS_FAIL: string | undefined;

  beforeEach(() => {
    ORIG_PATH = process.env.PATH;
    ORIG_LIST_MODELS_FAIL = process.env.TICKMARKR_TEST_PI_LIST_MODELS_FAIL;
    delete process.env.TICKMARKR_TEST_PI_LIST_MODELS_FAIL;
    const bin = join(HOME, "bin");
    mkdirSync(bin, { recursive: true });
    const stub = join(bin, "pi");
    writeFileSync(stub, [
      "#!/bin/sh",
      `case "$1" in`,
      `  --version) echo "0.80.6 (stub)"; exit 0;;`,
      `  --list-models) if [ "$TICKMARKR_TEST_PI_LIST_MODELS_FAIL" = "1" ]; then echo "auth failed" >&2; exit 7; fi; printf 'provider model\\nzai glm-5.2\\n'; exit 0;;`,
      "esac",
      "exit 1",
      "",
    ].join("\n"));
    chmodSync(stub, 0o755);
    process.env.PATH = `${bin}:${ORIG_PATH ?? ""}`;
  });
  afterEach(() => {
    if (ORIG_PATH === undefined) delete process.env.PATH;
    else process.env.PATH = ORIG_PATH;
    if (ORIG_LIST_MODELS_FAIL === undefined) delete process.env.TICKMARKR_TEST_PI_LIST_MODELS_FAIL;
    else process.env.TICKMARKR_TEST_PI_LIST_MODELS_FAIL = ORIG_LIST_MODELS_FAIL;
  });

  test("test: a session record whose served model differs from the pinned model makes the capability probe report both names; a probe reporting the pinned model as the served one is green on that record and on every ordinary one and fails", async () => {
    const cwd = scratch();
    plantSession(cwd, [sessionHeader(cwd), servedMsg(T1, ORDINARY), servedMsg(T2, DRIFTED)]);

    expect(readPiServedModels()).toEqual([{ pinned: "glm-5.2", served: "glm-5.3" }]);
    const health = await pi.probe();
    expect(health.installed).toBe(true);
    // BOTH names, or the report says nothing an operator could act on
    expect(health.note).toContain("glm-5.2");
    expect(health.note).toContain("glm-5.3");

    // the neighbour: green on the drifting record and on every ordinary one — it raises no false
    // alarm anywhere, and it never names the model that was actually served, so it fails the above.
    expect(pinnedAsServed()).toEqual([]);
    expect(servedModelNote(pinnedAsServed())).not.toContain("glm-5.3");
    expect(servedModelNote(pinnedAsServed())).toBe("");
  });

  test("a failed model-list capability call still reports locally recorded served-model drift", async () => {
    const cwd = scratch();
    plantSession(cwd, [sessionHeader(cwd), servedMsg(T1, DRIFTED)]);
    process.env.TICKMARKR_TEST_PI_LIST_MODELS_FAIL = "1";

    const health = await pi.probe();
    expect(health.installed).toBe(true);
    expect(health.note).toContain("glm-5.2");
    expect(health.note).toContain("glm-5.3");
  });

  test("valid JSON primitives in a session file are ignored without aborting the capability probe", async () => {
    const cwd = scratch();
    plantSession(cwd, [sessionHeader(cwd), null, servedMsg(T1, DRIFTED)]);

    expect(readPiServedModels()).toEqual([{ pinned: "glm-5.2", served: "glm-5.3" }]);
    const health = await pi.probe();
    expect(health.note).toContain("glm-5.2");
    expect(health.note).toContain("glm-5.3");
  });

  test("test: session records carrying no served-model field report no discrepancy at all; a reader treating an absent field as a mismatch alarms on every ordinary turn and fails", async () => {
    const cwd = scratch();
    plantSession(cwd, [sessionHeader(cwd), servedMsg(T1, ORDINARY), servedMsg(T2, ORDINARY), servedMsg(T3, ORDINARY)]);

    expect(readPiServedModels()).toEqual([]);
    const health = await pi.probe();
    expect(health.note).toBe("auth verified via pi --list-models (free; auth-filtered by pi)");
    expect(health.note).not.toMatch(/served-model drift/);

    // the neighbour, reading those same three ordinary records off the same files: an absent field
    // taken as a mismatch fires on EVERY one of them, and the note it builds is indistinguishable
    // from a real discrepancy.
    expect(absentIsMismatch()).toHaveLength(3);
    expect(servedModelNote(absentIsMismatch())).toContain("served-model drift");

    // and it is not merely noisy. Add one genuinely drifting record to the same store: the shipped
    // reader reports that one pair and nothing else, while the neighbour buries it among three false
    // alarms — so an operator reading its note cannot tell the real substitution from the ordinary turns.
    plantSession(cwd, [sessionHeader(cwd), servedMsg(T3, DRIFTED)], [], "drift.jsonl");
    expect(readPiServedModels()).toEqual([{ pinned: "glm-5.2", served: "glm-5.3" }]);
    expect(absentIsMismatch()).toHaveLength(4);
  });

  test("the scan is bounded like the usage reader beside it, and fails open with no store at all", async () => {
    // no ~/.pi at all under this temp HOME
    expect(readPiServedModels()).toEqual([]);
    const cwd = scratch();
    plantSession(cwd, [sessionHeader(cwd), servedMsg(T1, DRIFTED)], [`{"type":"message","message":{"role":"assistant","model":"glm-5.2","responseModel"`]);
    // torn line dropped, valid record still read
    expect(readPiServedModels()).toEqual([{ pinned: "glm-5.2", served: "glm-5.3" }]);
    // an id that could reach operator-facing text is refused by the shared charset gate
    plantSession(cwd, [sessionHeader(cwd), servedMsg(T1, { model: "glm-5.2", responseModel: "glm-5.3; rm -rf /" })], [], "y.jsonl");
    expect(readPiServedModels().some((d) => d.served.includes("rm -rf"))).toBe(false);
  });

  // The bound is the point of the task, so prove it the only way that varies with the question:
  // hold the BYTES fixed and move the one input the bound reads — the file's mtime. A test that only
  // planted one drifting file would be green whether the window were 20 files or unbounded.
  test("the scan reads only the newest MAX_SESSION_FILES, exactly like the usage reader beside it", () => {
    const cwd = scratch();
    const dir = slugDir(cwd);
    const stamp = (f: string, secs: number) => utimesSync(join(dir, f), secs, secs);

    // one drifting session, then MAX_SESSION_FILES (20) ordinary ones all newer than it
    plantSession(cwd, [sessionHeader(cwd), servedMsg(T1, DRIFTED)], [], "drift.jsonl");
    stamp("drift.jsonl", 1_000_000);
    for (let i = 0; i < 20; i++) {
      plantSession(cwd, [sessionHeader(cwd), servedMsg(T1, ORDINARY)], [], `n${i}.jsonl`);
      stamp(`n${i}.jsonl`, 2_000_000 + i);
    }
    // pushed out of the newest-20 window ⇒ never opened ⇒ nothing to report
    expect(readPiServedModels()).toEqual([]);

    // the very same file, byte-for-byte unchanged, now the newest: it is read and the drift is named.
    stamp("drift.jsonl", 3_000_000);
    expect(readPiServedModels()).toEqual([{ pinned: "glm-5.2", served: "glm-5.3" }]);
  });
});
