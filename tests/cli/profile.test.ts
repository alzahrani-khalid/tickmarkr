import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { profile } from "../../src/cli/commands/profile.js";
import { loadConfig } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { Journal, loadRoutingProfile } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

// A telemetry row for a warm/cold cell; all fields v1.6-complete so classify() reads CLEAN.
const row = (o: Record<string, unknown>) =>
  JSON.stringify({
    taskId: "T", shape: "implement", adapter: "claude-code", model: "sonnet", channel: "sub",
    attempts: 1, outcome: "done", durationMs: 1000, gateFails: 0, consults: 0, ...o,
  });

const seedRun = (repo: string, runId: string, lines: string[]) => {
  const dir = join(tickmarkrDir(repo), "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "telemetry.jsonl"), lines.join("\n") + "\n");
};

// warm one cell (implement|claude-code:sonnet) to n=6, leave another (chore|codex:gpt) at n=2
const seedWarmAndCold = (repo: string) => {
  seedRun(repo, "run-20200101-000000", Array(6).fill(row({})));
  seedRun(repo, "run-20200102-000000", Array(2).fill(row({ shape: "chore", adapter: "codex", model: "gpt" })));
};

// VIS-06 golden fixture: ≥3 cells, ≥2 shapes, ":" and "/" chKeys, warm + cold — captured PRE-refactor.
const seedGolden = (repo: string) => {
  seedRun(repo, "run-20200101-000000", Array(6).fill(row({})));
  seedRun(repo, "run-20200102-000000", Array(2).fill(row({ shape: "chore", adapter: "codex", model: "gpt" })));
  seedRun(repo, "run-20200103-000000", Array(6).fill(row({ shape: "explore", adapter: "zai-coding-plan", model: "glm-5.2" })));
};

describe("VIS-06 tickmarkr profile show — golden output (captured PRE-refactor)", () => {
  test("byte-identical render with no learnedTuning override", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    seedGolden(repo);
    const out = await profile([], repo);
    expect(out).toBe([
      "tickmarkr profile",
      "  routing.learned: on",
      "  runs window: 50",
      "",
      "  shape      channel                      class obs   quality  median    dispatch  score",
      "  chore      codex:gpt                    sub  n=2   q=1.00  1000ms    disp=2   score=0.000  cold (n<5)",
      "  explore    zai-coding-plan:glm-5.2      sub  n=6   q=1.00  1000ms    disp=6   score=0.275",
      "  implement  claude-code:sonnet           sub  n=6   q=1.00  1000ms    disp=6   score=0.275",
    ].join("\n"));
  });
});

describe("VIS-03 tickmarkr profile show", () => {
  test("Test 1/1b: warm telemetry renders cells under the DEFAULT on (ROUTE-14, 2026-07-11) — header names on, cold marker on n=2", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    seedWarmAndCold(repo);
    const out = await profile([], repo);
    // header: inspection command shows profile; learned now defaults ON
    expect(out).toMatch(/routing\.learned:\s*on/);
    expect(out).toContain("runs window: 50");
    expect(out).not.toMatch(/reset cursor:/); // no cursor yet
    // warm cell row
    expect(out).toContain("implement");
    expect(out).toContain("claude-code:sonnet");
    expect(out).toMatch(/-?\d\.\d{3}/); // a score column
    // cold cell (n=2) marked
    expect(out).toContain("chore");
    expect(out).toContain("cold (n<5)");
    // deterministic order: chore|codex:gpt sorts before implement|claude-code:sonnet
    expect(out.indexOf("chore")).toBeLessThan(out.indexOf("implement"));
  });

  test("Test 2: no telemetry ⇒ empty-profile message, no throw", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const out = await profile([], repo);
    expect(out).toMatch(/no telemetry|empty/i);
  });
});

describe("VIS-06 profile.ts source pins — cellsOf migration", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/cli/commands/profile.ts", import.meta.url)), "utf8");

  test("no cellKey hand-split in cli/commands/profile.ts", () => {
    expect(src).not.toMatch(/lastIndexOf\("\|"\)/);
    expect(src).not.toMatch(/\.split\("\|"\)/);
    expect(src).toMatch(/cellsOf/);
  });

  test("preview honors routing.learnedTuning.availWeight override", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const quota = () => row({ outcome: "human", parkKind: "quota", durationMs: 0 });
    seedRun(repo, "run-20200101-000000", Array(6).fill(quota()));
    const defOut = await profile([], repo);
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "routing:\n  learnedTuning:\n    availWeight: 0.5\n");
    const tunedOut = await profile([], repo);
    const score = (out: string) => out.match(/claude-code:sonnet[^\n]*score=([-\d.]+)/)?.[1];
    expect(score(defOut)).toBeDefined();
    expect(score(tunedOut)).toBeDefined();
    expect(score(tunedOut)).not.toBe(score(defOut));
  });
});

describe("VIS-03 tickmarkr profile reset (non-destructive cursor)", () => {
  test("Test 3: reset writes .tickmarkr/profile-since = latest runId and explains the undo", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    seedWarmAndCold(repo);
    const out = await profile(["reset"], repo);
    const cursorPath = join(tickmarkrDir(repo), "profile-since");
    expect(existsSync(cursorPath)).toBe(true);
    expect(readFileSync(cursorPath, "utf8").trim()).toBe(Journal.latestRunId(repo));
    expect(out).toContain("profile-since");
    expect(out).toMatch(/delete/i); // undo path documented
  });

  test("Test 4 (T-13-06): reset leaves every telemetry file byte-unchanged and removes no run dir", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    seedWarmAndCold(repo);
    const runsDir = join(tickmarkrDir(repo), "runs");
    const before = readdirSync(runsDir).map((id) => [id, readFileSync(join(runsDir, id, "telemetry.jsonl"))] as const);
    await profile(["reset"], repo);
    const afterDirs = readdirSync(runsDir);
    expect(afterDirs.sort()).toEqual(before.map(([id]) => id).sort());
    for (const [id, bytes] of before) {
      expect(readFileSync(join(runsDir, id, "telemetry.jsonl"))).toEqual(bytes);
    }
  });

  test("Test 5: cursor excludes pre-cursor runs; a new post-cursor run is all the profile sees; show names the cursor", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    seedWarmAndCold(repo);
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "routing: { learned: on }\n");
    const cfg = loadConfig(repo);
    await profile(["reset"], repo);
    // all runs ≤ cursor ⇒ nothing left
    expect(loadRoutingProfile(repo, cfg)).toBeUndefined();
    // a new post-cursor run warms a fresh cell ⇒ ONLY it survives
    seedRun(repo, "run-20200103-000000", Array(6).fill(row({ shape: "explore", adapter: "opencode", model: "grok" })));
    const p = loadRoutingProfile(repo, cfg);
    expect(p).toBeDefined();
    expect([...p!.cells.keys()]).toEqual(["explore|opencode:grok|sub"]);
    const out = await profile([], repo);
    expect(out).toMatch(/reset cursor:\s*run-20200102-000000/);
  });

  test("Test 6: reset in an empty repo does not throw; cursor is empty (latestRunId ?? \"\")", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const out = await profile(["reset"], repo);
    const cursorPath = join(tickmarkrDir(repo), "profile-since");
    expect(existsSync(cursorPath)).toBe(true);
    expect(readFileSync(cursorPath, "utf8").trim()).toBe("");
    expect(out).toBeTypeOf("string");
  });
});
