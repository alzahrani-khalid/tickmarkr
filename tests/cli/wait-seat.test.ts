import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { wait, type WaitOpts } from "../../src/cli/commands/wait.js";
import { commandHelp } from "../../src/cli/help.js";
import { dispatch } from "../../src/cli/index.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { SEAT_MARKER_ENV } from "../../src/drivers/host-env.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { scopeIntent } from "../../src/plan/scope.js";
import { makeRepo, makeTestTempDir, reapTestTempDirs, T } from "../helpers/tmprepo.js";

// Queue row 371 (D-2186): the seat wait CASE table of specs/v2.23.0-seats-and-splits-contract.md, through the
// production wait function, the shipped SessionStart hook command and the production scope drafting launch.

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), readFileSync: vi.fn(actual.readFileSync),
    statSync: vi.fn(actual.statSync), lstatSync: vi.fn(actual.lstatSync), existsSync: vi.fn(actual.existsSync) };
});

// No result here may depend on the seat that launched the suite.
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
afterAll(() => reapTestTempDirs());

const ROOT = resolve(import.meta.dirname, "../..");
const ts = "2026-11-08T00:00:00.000Z";
const SEAT_LINE = (value: string) => `tickmarkr wait: this process is a tickmarkr seat (TICKMARKR_SEAT=${value}); a seat never waits on a run`;

/** A repository whose graph lock a live run holds (this process's pid), with that run's journal begun. */
function liveRepo(runId = "run-live") {
  const cwd = makeRepo({ "base.txt": "base\n" });
  const graph = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "seat" }, tasks: [T("T1")] });
  saveGraph(cwd, graph);
  const journal = join(cwd, ".tickmarkr", "runs", runId, "journal.jsonl");
  fs.mkdirSync(join(cwd, ".tickmarkr", "runs", runId), { recursive: true });
  fs.writeFileSync(journal, JSON.stringify({ ts, event: "run-start", data: { graphDefinitionHash: graphDefinitionHash(graph), pid: process.pid } }) + "\n");
  fs.writeFileSync(join(cwd, ".tickmarkr", "graph.lock"), JSON.stringify({ pid: process.pid, runId, startedAt: Date.now() }));
  const park = () => fs.appendFileSync(journal, JSON.stringify({ ts, event: "task-human", taskId: "T1", data: { kind: "human-gate", reason: "needs a decision" } }) + "\n");
  return { cwd, runId, journal, park };
}

/** An injected clock: `onSleep` runs at each one-second tick. */
function clock(onSleep: (tick: number) => void = () => {}, step = 1000) {
  let time = 0;
  let tick = 0;
  const now = vi.fn(() => time);
  const sleep = vi.fn(async () => { time += step; onSleep(++tick); });
  return { now, sleep } satisfies WaitOpts;
}

/** Every fs read wait could make of the repository's state directory (the lock and the journal live there). */
function stateReads(cwd: string): unknown[][] {
  const state = join(cwd, ".tickmarkr");
  const calls = [fs.openSync, fs.readFileSync, fs.statSync, fs.lstatSync, fs.existsSync]
    .flatMap(fn => vi.mocked(fn as (...args: unknown[]) => unknown).mock.calls);
  return calls.filter(args => typeof args[0] === "string" && args[0].startsWith(state));
}

/** Run `wait` under a seat environment and prove it returned at once: no clock read, no sleep, no state read. */
async function seatWait(cwd: string, argv: string[], env: NodeJS.ProcessEnv) {
  const time = clock(() => { throw new Error("a seat wait slept"); });
  vi.clearAllMocks();
  const result = await wait(argv, cwd, { ...time, env });
  expect(time.sleep, argv.join(" ")).not.toHaveBeenCalled();
  expect(time.now, argv.join(" ")).not.toHaveBeenCalled();
  expect(stateReads(cwd), argv.join(" ")).toEqual([]);
  return result;
}

/** Run the shipped hook command through the system shell against a stand-in tickmarkr exiting `code`. */
function runHook(code: number) {
  const hooks = JSON.parse(fs.readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"));
  const dir = makeTestTempDir("seat-hook-");
  const calls = join(dir, "calls");
  fs.writeFileSync(join(dir, "tickmarkr"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TICKMARKR_CALLS"\nexit "$TICKMARKR_WAIT_EXIT"\n', { mode: 0o755 });
  const result = spawnSync("/bin/sh", ["-c", hooks.hooks.SessionStart[0].hooks[0].command], {
    cwd: dir, encoding: "utf8", timeout: 5_000,
    env: { ...process.env, PATH: dir, TICKMARKR_CALLS: calls, TICKMARKR_WAIT_EXIT: String(code) },
  });
  return { status: result.status, signal: result.signal, calls: fs.readFileSync(calls, "utf8").trim().split("\n") };
}

test("the seat wait CASE table returns at once with exit code eight for consult judge review and any nonblank marker without opening the lock or the journal", async () => {
  vi.stubEnv(SEAT_MARKER_ENV, undefined);
  const live = liveRepo();
  // The captured consult shape, the judge and review seats, the scope draft and any other nonblank value.
  const markers: [string, string][] = [
    ["consult", "consult"], ["judge", "judge"], ["review", "review"], ["scope", "scope"],
    ["  review\t", " review "], ["custom-seat", "custom-seat"], ["evil\x1b[31m\x07", "evil\\x1b[31m\\x07"],
  ];
  for (const [marker, shown] of markers) {
    const plain = await seatWait(live.cwd, [], { [SEAT_MARKER_ENV]: marker });
    expect(plain, JSON.stringify(marker)).toEqual({ code: 8, out: SEAT_LINE(shown) });
    expect(plain.out.split("\n")).toHaveLength(1);
    expect(plain.out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/u);
    // An explicit run id, --after, --timeout or --json: no journal read; --json prints the seat object.
    for (const argv of [[live.runId], ["--after", "1"], ["--timeout", "23h"], [live.runId, "--after", "0", "--timeout", "1s"]]) {
      expect(await seatWait(live.cwd, argv, { [SEAT_MARKER_ENV]: marker }), argv.join(" ")).toEqual({ code: 8, out: SEAT_LINE(shown) });
    }
    for (const argv of [["--json"], [live.runId, "--json", "--timeout", "1h"], ["--after", "3", "--json"]]) {
      const json = await seatWait(live.cwd, argv, { [SEAT_MARKER_ENV]: marker });
      expect(json.code, argv.join(" ")).toBe(8);
      expect(json.out.split("\n")).toHaveLength(1);
      expect(JSON.parse(json.out)).toEqual({ cause: "seat", seat: marker });
    }
    // A malformed flag is never parsed.
    for (const argv of [["--after", "soon"], ["--timeout", "forever"], ["--bogus"], ["--timeout"], ["run-a", "run-b"], ["--json=yes"]]) {
      expect(await seatWait(live.cwd, argv, { [SEAT_MARKER_ENV]: marker }), argv.join(" ")).toEqual({ code: 8, out: SEAT_LINE(shown) });
    }
    // --help still wins: the help text, exit 0.
    for (const argv of [["--help"], ["-h", "--json"], ["--bogus", "--help"]]) {
      expect(await seatWait(live.cwd, argv, { [SEAT_MARKER_ENV]: marker })).toEqual({ code: 0, out: commandHelp("wait") });
    }
  }
  // The default environment is process.env: the consult seat's own launch, through the production dispatcher.
  vi.stubEnv(SEAT_MARKER_ENV, "consult");
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(live.cwd);
  try {
    vi.clearAllMocks();
    expect(await dispatch("wait", ["--timeout", "23h"])).toEqual({ code: 8, out: SEAT_LINE("consult") });
    expect(stateReads(live.cwd)).toEqual([]);
  } finally { cwd.mockRestore(); }
  // The captured consult shape maps through the shipped hook to exit 0 with no rewake.
  const consult = await seatWait(live.cwd, ["--timeout", "23h"], { [SEAT_MARKER_ENV]: "consult" });
  expect(runHook(consult.code)).toEqual({ status: 0, signal: null, calls: ["wait --timeout 23h"] });
  // The lock and the journal are untouched and still live.
  expect(JSON.parse(fs.readFileSync(join(live.cwd, ".tickmarkr", "graph.lock"), "utf8")).runId).toBe(live.runId);
  expect(fs.readFileSync(live.journal, "utf8").trim().split("\n")).toHaveLength(1);
});

test("an operator session with no marker or a blank marker still waits on the live run and wakes on the next park while a worker in its task worktree still gets exit seven", async () => {
  vi.stubEnv(SEAT_MARKER_ENV, undefined);
  for (const env of [{}, { [SEAT_MARKER_ENV]: "" }, { [SEAT_MARKER_ENV]: "   " }, { [SEAT_MARKER_ENV]: " \t\n " }] as NodeJS.ProcessEnv[]) {
    const live = liveRepo();
    // Two quiet ticks, then the daemon parks a task: the operator session sleeps through both and wakes on the park.
    const time = clock(tick => { if (tick === 2) live.park(); });
    vi.clearAllMocks();
    const result = await wait(["--timeout", "23h"], live.cwd, { ...time, env });
    expect(result.code, JSON.stringify(env)).toBe(3);
    expect(result.out.split("\n")[0]).toBe(`tickmarkr wait ${live.runId}: park at journal line 2`);
    expect(time.sleep).toHaveBeenCalledTimes(2);
    expect(stateReads(live.cwd).length).toBeGreaterThan(0);
    // The shipped hook rewakes that operator session.
    expect(runHook(result.code).status).toBe(2);
  }
  // A worker (unmarked) in its task worktree: the worktree holds no graph lock, so exit 7 at once, unchanged.
  const live = liveRepo();
  const worktree = join(makeTestTempDir("seat-worker-"), "T1");
  execFileSync("git", ["-C", live.cwd, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "-b", "tickmarkr/run-live--T1", worktree], { stdio: "ignore" });
  expect(fs.existsSync(join(worktree, ".tickmarkr", "graph.lock"))).toBe(false);
  for (const env of [{}, { [SEAT_MARKER_ENV]: "" }] as NodeJS.ProcessEnv[]) {
    const time = clock(() => { throw new Error("a worker wait slept"); });
    expect(await wait([], worktree, { ...time, env })).toEqual({ code: 7, out: "tickmarkr wait: no live run holds the graph lock" });
    expect(time.sleep).not.toHaveBeenCalled();
  }
  expect(runHook(7).status).toBe(0);
});

test("the shipped session start hook maps the seat exit to a zero exit with no rewake and the hook command bytes are unchanged", () => {
  // hooks/hooks.json is byte-identical to the base: the seat exit needs no hook edit.
  expect(fs.readFileSync(join(ROOT, "hooks/hooks.json"), "utf8")).toBe(`{
  "modules": ["./board/register.tsx"],
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "tickmarkr wait --timeout 23h 2>&1; c=$?; case $c in 0|3|4|5) exit 2;; esac; exit 0",
            "asyncRewake": true,
            "timeout": 86400
          }
        ]
      }
    ]
  }
}
`);
  // The seat exit is outside the rewake set: exit 0, no rewake (hook exit 2), and the hook ran exactly that wait.
  expect(runHook(8)).toEqual({ status: 0, signal: null, calls: ["wait --timeout 23h"] });
  // Control: the stand-in is live — a park still rewakes and the no-live-run exit still does not.
  expect(runHook(3).status).toBe(2);
  expect(runHook(7).status).toBe(0);
});

test("wait help lists the seat exit code beside the existing exit codes", async () => {
  const help = commandHelp("wait");
  const codes = /Exit codes: ([^.]*)\./u.exec(help)?.[1];
  expect(codes).toBeDefined();
  for (const entry of ["run-end 0", "park 3", "task-failed 4", "daemon-death 5", "timeout 6", "no live lock unnamed 7", "seat 8", "bad flag 1"]) {
    expect(codes, entry).toContain(entry);
  }
  expect(codes).toMatch(/no live lock unnamed 7, seat 8 \(a nonblank TICKMARKR_SEAT returns at once: a seat never waits\);/u);
  expect((await dispatch("wait", ["--help"])).out).toBe(help);
});

test("the scope drafting launch on its headless and pane paths carries the scope seat marker so a wait under its environment exits at once where the unmarked base launch blocked", async () => {
  // The suite's own seat never leaks in: the only marker a draft can carry is the one its launch sets.
  vi.stubEnv(SEAT_MARKER_ENV, undefined);
  const live = liveRepo();
  const draft = `<!-- tickmarkr:spec -->
# Export reports

## Requirements
- REQ-01: Export reports as JSON

## Assumptions
- Existing authorization rules apply

## Traceability
| Requirement | Tasks |
| --- | --- |
| REQ-01 | T1 |

## T1: Export reports [REQ-01]
- goal: Export reports as JSON
- shape: implement
- files: src/reports.ts
- acceptance:
  - command: npm test
`;
  const intentFile = join(live.cwd, "reports.intent.md");
  fs.writeFileSync(intentFile, "# Export reports\n\n## Blocking questions\n1. Which format?\n\n## Answers\n1. JSON\n");
  const script = join(makeTestTempDir("seat-scope-fake-"), "fake.json");
  fs.writeFileSync(script, JSON.stringify({ tasks: {}, judge: { spec: draft } }));
  const fake = new FakeAdapter(script);
  // The drafting agent's shell records its own environment before the fake CLI answers.
  const envFile = join(makeTestTempDir("seat-scope-env-"), "env.json");
  const command = fake.headlessCommand.bind(fake);
  fake.headlessCommand = (promptFile, model) =>
    `${shq(process.execPath)} -e ${shq("require('fs').writeFileSync(process.argv[1], JSON.stringify(process.env))")} ${shq(envFile)} && ${command(promptFile, model)}`;

  for (const transport of ["headless", "pane"] as const) {
    fs.rmSync(envFile, { force: true });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.routing.map.spec = { pin: { via: "fake", model: "fake-1" } };
    cfg.visibility.llm = transport;
    const result = await scopeIntent(intentFile, live.cwd, { cfg, adapters: [fake], force: true,
      ...(transport === "pane" ? { driver: new SubprocessDriver() } : {}) });
    expect(result.attempts, transport).toBe(1);
    const env = JSON.parse(fs.readFileSync(envFile, "utf8")) as NodeJS.ProcessEnv;
    // The launch carries the scope marker (RED at the base, which launched the draft unmarked).
    expect(env[SEAT_MARKER_ENV], transport).toBe("scope");
    expect(process.env[SEAT_MARKER_ENV]).toBeUndefined();
    // A wait under that environment, at the repository root a live run holds, exits 8 at once.
    expect(await seatWait(live.cwd, ["--timeout", "23h"], env), transport).toEqual({ code: 8, out: SEAT_LINE("scope") });
    // The unmarked base launch's environment blocks on the live run until its deadline instead.
    const base: NodeJS.ProcessEnv = { ...env };
    delete base[SEAT_MARKER_ENV];
    const time = clock();
    expect((await wait(["--timeout", "3s"], live.cwd, { ...time, env: base })).code, transport).toBe(6);
    expect(time.sleep, transport).toHaveBeenCalledTimes(3);
  }
}, 60_000);
