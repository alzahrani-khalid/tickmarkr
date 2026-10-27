import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { approve } from "../../src/cli/commands/approve.js";
import { SubprocessDriver, type NotificationPoster } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, NotificationPost } from "../../src/drivers/types.js";
import { loadGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { resetHostLatencySampleForTests, setHostLatencySampleForTests } from "../../src/run/host-health.js";
import { foldOwedChecks, Journal, type JournalEvent } from "../../src/run/journal.js";
import * as operatorState from "../../src/run/operator-state.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

beforeEach(() => { setHostLatencySampleForTests(async () => 20); });
afterEach(() => {
  resetHostLatencySampleForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const clean = { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } };
const greenGates = "gates:\n  test: sh -c 'exit 0'\n";
const success = () => ({ status: 0, signal: null });

function tool(body: string) {
  const dir = makeTestTempDir("os-notify-");
  writeFileSync(join(dir, "osascript"), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return dir;
}

function capture(repo: string, runId: string, platform: NodeJS.Platform = "darwin", poster?: NotificationPoster) {
  const posts: Array<{ text: string; events: JournalEvent[] }> = [];
  const notices: Array<{ text: string; tier?: string }> = [];
  const driver: ExecutorDriver = new SubprocessDriver({ platform, poster: (command, args, options) => {
    // This snapshot is taken INSIDE the synchronous poster, before it returns to the daemon.
    posts.push({ text: args.at(-2)!, events: Journal.open(repo, runId).read() });
    return poster?.(command, args, options) ?? success();
  } });
  driver.notify = async (text, opts) => { notices.push({ text, tier: opts?.tier }); };
  return { driver, posts, notices };
}

function stateAtPost(repo: string, events: JournalEvent[]) {
  const basis = String(events.length);
  return operatorState.readOperatorState({ events, graph: loadGraph(repo), basis,
    owed: { basis, fold: foldOwedChecks(events, repo) } });
}

function expectEndVerdict(repo: string, post: { text: string; events: JournalEvent[] }) {
  expect(post.events.at(-1)?.event).toBe("run-end");
  const snapshot = stateAtPost(repo, post.events);
  expect(post.text.endsWith("run ended GREEN")).toBe(snapshot.green);
  if (!snapshot.green) {
    expect(post.text).toContain("run ended NOT GREEN");
    expect(post.text).toContain(`owed ${snapshot.debt}`);
  }
}

test("test: on darwin the subprocess driver posts synchronously through the notification tool with the fixed script and the post's text as its own argument, byte-equal when it holds double quotes, backslashes and an AppleScript shell-command phrase, and posts nothing for a notice without a post or on another platform, so a spliced or asynchronous post fails", async () => {
  const dir = makeTestTempDir("notification-argv-");
  const output = join(dir, "argv.json");
  const bin = tool(`require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const poster = vi.fn<NotificationPoster>(spawnSync);
  const driver = new SubprocessDriver({ poster, platform: "darwin" });
  const text = 'quote " \\ backslash\n" & do shell script "touch /tmp/never-execute-this" & "';
  expect(driver.postSync({ kind: "park", text })).toBeUndefined();
  expect(existsSync(output)).toBe(true); // a deferred/asynchronous post has not finished here
  const argv = ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run", text, "tickmarkr"];
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(argv);
  expect(poster).toHaveBeenCalledExactlyOnceWith("osascript", argv, { timeout: 10000, killSignal: "SIGKILL", stdio: "ignore" });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await driver.notify("routine", { tier: "routine" });
  await driver.notify("needs attention", { tier: "attention" });
  expect(log).toHaveBeenCalledExactlyOnceWith("[tickmarkr] needs attention");
  new SubprocessDriver({ poster, platform: "linux" }).postSync({ kind: "run-end", text });
  expect(poster).toHaveBeenCalledTimes(1);
  // The Vitest switch guards only the production poster: the injected poster above really ran.
  new SubprocessDriver({ platform: "darwin" }).postSync({ kind: "park", text: "default suppressed" });
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(argv);
});

test("test: the production daemon posts exactly one notification for a park and exactly one for each run-end row its invocation appends, ordinary or fatal, while its escalation, consult verdict and failover notices post nothing, so a run posting routine progress or ending silent fails", async () => {
  const cases = [
    { tag: "green", tasks: [T("T1")], script: clean, extra: greenGates },
    { tag: "partial", tasks: [T("T1", { humanGate: true }), T("T2", { deps: ["T1"] })], script: { tasks: {} }, extra: "" },
    { tag: "ladder", tasks: [T("T1")], script: { ...clean,
      judge: { pass: false, criteria: [{ criterion: "c1", met: false, reason: "needs fixing" }] },
      consult: { action: "human", notes: "operator must decide" } }, extra: "" },
    { tag: "ban", tasks: [T("T1", { acceptance: [{ oracle: "command", command: "true" }] })],
      script: { consult: { action: "retry", notes: "try again" }, tasks: { T1: [{ shell: "true", result: { ok: true, summary: "no commits" } }] } }, extra: "" },
    { tag: "failover", tasks: [T("T1")], script: { tasks: { T1: [
      { shell: "echo 'usage limit reached for this model'; exit 1" }, ...clean.tasks.T1,
    ] } }, extra: "" },
    { tag: "tip-red", tasks: [T("T1")], script: { tasks: { T1: [{
      shell: `echo one > t1.txt && echo fail > tip.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" },
    }] } }, extra: "gates:\n  test: sh -c 'exit 0'\n  tipTest: sh -c 'test -f tip.txt && grep -q fail tip.txt && exit 1 || exit 0'\n" },
    { tag: "fatal", tasks: [T("T1")], script: clean, extra: "" },
    { tag: "linux", tasks: [T("T1", { humanGate: true })], script: { tasks: {} }, extra: "" },
  ];
  for (const row of cases) {
    const { repo, fake } = setupRepo(row.tasks, row.script, row.extra);
    const runId = `run-post-${row.tag}`;
    const { driver, posts, notices } = capture(repo, runId, row.tag === "linux" ? "linux" : "darwin");
    if (row.tag === "fatal") execFileSync("git", ["branch", "tickmarkr"], { cwd: repo });
    const running = runDaemon(repo, { adapters: [fake], driver, runId });
    if (row.tag === "fatal") await expect(running).rejects.toThrow();
    else await running;
    const events = Journal.open(repo, runId).read();
    if (row.tag === "green") expect(events.find(e => e.event === "task-failed")).toBeUndefined();
    expect(events.filter(e => e.event === "run-end")).toHaveLength(1);
    if (row.tag === "linux") { expect(posts).toEqual([]); continue; }
    const parks = notices.filter(n => n.text.includes("needs a human"));
    expect(posts.map(p => p.text)).toEqual([...parks.map(n => n.text), expect.stringContaining(`tickmarkr ${runId}: run ended`)]);
    expect(posts).toHaveLength(events.filter(e => e.event === "task-human" || e.event === "run-end").length);
    expect(parks.every(n => n.tier === "attention")).toBe(true);
    expectEndVerdict(repo, posts.at(-1)!);
    if (row.tag === "green") expect(posts.at(-1)!.text).toBe(`tickmarkr ${runId}: run ended GREEN`);
    if (row.tag === "partial") expect(posts.at(-1)!.text).toContain("done 0, failed 0, parked 1, blocked 1, pending 0");
    if (row.tag === "tip-red") expect(posts.at(-1)!.text).toContain("tip failed");
    if (row.tag === "fatal") expect(posts.at(-1)!.text).toContain(", crashed in setup");
    if (row.tag === "ladder") {
      expect(notices.some(n => n.text.includes("escalation:"))).toBe(true);
      expect(notices.some(n => n.text.includes("consult verdict:"))).toBe(true);
    }
    if (row.tag === "ban") expect(notices.some(n => n.text.includes("identical retry banned"))).toBe(true);
    if (row.tag === "failover") expect(notices.some(n => n.text.includes("quota failover"))).toBe(true);
    for (const notice of notices.filter(n => !n.text.includes("needs a human")
      && /escalation:|consult verdict:|quota failover|identical retry banned/.test(n.text))) {
      expect(posts.map(p => p.text)).not.toContain(notice.text);
    }
  }
}, 180_000);

function terminationHandler(before: NodeJS.SignalsListener[]) {
  const handler = process.listeners("SIGTERM").find(l => !before.includes(l));
  expect(handler).toBeDefined();
  handler!("SIGTERM"); // only the daemon's handler; never signal the Vitest runner
}

test("test: a resumed engagement terminated before its own run-end and a run stopped before any run-end post nothing, though the journal holds an earlier run-end row, so a post keyed on any run-end row in the journal fails", async () => {
  for (const resume of [false, true]) {
    const { repo, fake } = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
    const runId = `run-stop-${resume}`;
    const { driver, posts } = capture(repo, runId);
    if (resume) { await runDaemon(repo, { adapters: [fake], driver, runId }); posts.length = 0; }
    const before = process.listeners("SIGTERM");
    let exitCode: number | undefined;
    await expect(runDaemon(repo, { adapters: [fake], driver, runId, resume,
      narrate: e => { if (e.event === (resume ? "run-resume" : "run-start")) queueMicrotask(() => terminationHandler(before)); },
      exit: code => { exitCode = code; },
    })).rejects.toThrow(/terminated by SIGTERM/);
    await new Promise(resolve => setImmediate(resolve));
    expect(exitCode).toBe(143);
    expect(posts).toEqual([]);
    expect(Journal.open(repo, runId).read().filter(e => e.event === "run-end")).toHaveLength(resume ? 1 : 0);
  }
}, 120_000);

test("test: a SIGTERM or a throw during the cleanup after the run-end row finds exactly one completed run-end post, made before that cleanup began, and no further post after the run settles, so a post deferred to cleanup or repeated on exit fails", async () => {
  for (const mode of ["throw", "SIGTERM"] as const) {
    const { repo, fake } = setupRepo([T("T1")], clean);
    const runId = `run-cleanup-${mode}`;
    const { driver, posts } = capture(repo, runId);
    const before = process.listeners("SIGTERM");
    let cleaned = false;
    let exitCode: number | undefined;
    // Reconcile is the FIRST awaited post-end cleanup. It observes an already completed post.
    driver.reconcile = async () => {
      if (cleaned || !Journal.open(repo, runId).read().some(e => e.event === "run-end")) return;
      cleaned = true;
      expect(posts).toHaveLength(1);
      expect(posts[0]!.events.at(-1)?.event).toBe("run-end");
      if (mode === "SIGTERM") terminationHandler(before);
      else throw new Error("cleanup exploded");
    };
    // Reconcile normally journals a cosmetic failure; make that cleanup throw reach the outer catch.
    const append = Journal.prototype.append;
    if (mode === "throw") vi.spyOn(Journal.prototype, "append").mockImplementation(function (this: Journal, ...args: Parameters<Journal["append"]>) {
      if (args[0] === "watch-cleanup-failed") throw new Error("cleanup exploded");
      return append.apply(this, args);
    });
    const running = runDaemon(repo, { adapters: [fake], driver, runId, exit: code => { exitCode = code; } });
    if (mode === "throw") await expect(running).rejects.toThrow("cleanup exploded");
    else await running.catch(e => { expect(String(e)).toMatch(/terminated by SIGTERM/); });
    await new Promise(resolve => setImmediate(resolve));
    expect(cleaned).toBe(true);
    expect(posts).toHaveLength(1);
    expect(Journal.open(repo, runId).read().filter(e => e.event === "run-end")).toHaveLength(1);
    if (mode === "SIGTERM") expect(exitCode).toBe(143);
    vi.restoreAllMocks();
  }
}, 120_000);

test("test: the run-end post reads green exactly when the status fold over the journal ending at that row reads green, so a clean run whose waived review still owes a check posts not green, and a fold that throws posts the unknown verdict, never green", async () => {
  const { repo, fake } = setupRepo([T("T1", { complexity: 8 })], { ...clean,
    review: { approve: false, findings: [{ note: "blocking bug", severity: "material" }] },
    consult: { action: "human", notes: "operator must decide" },
  }, greenGates);
  const runId = "run-owed-review-post";
  const { driver, posts } = capture(repo, runId);
  expect((await runDaemon(repo, { adapters: [fake], driver, runId })).human).toEqual(["T1"]);
  await approve([runId, "T1", "--waive", "--by", "operator", "--reason", "accept review risk"], repo);
  posts.length = 0;
  expect((await runDaemon(repo, { adapters: [fake], driver, runId, resume: true })).done).toEqual(["T1"]);
  expect(posts).toHaveLength(1);
  expectEndVerdict(repo, posts[0]!);
  expect(posts[0]!.text).toContain("run ended NOT GREEN — done 1, failed 0, parked 0, blocked 0, pending 0");
  expect(posts[0]!.text).toContain("owed 1");
  expect(stateAtPost(repo, posts[0]!.events).currentTip).toBe("passed");
  const frozen = posts[0]!.text;
  Journal.open(repo, runId).append("later-observation", undefined, { debt: 0 });
  expect(posts.map(p => p.text)).toEqual([frozen]);

  for (const fault of ["throws", "overruns"] as const) {
    const next = setupRepo([T("T1")], clean, greenGates);
    const nextId = `run-fold-${fault}`;
    const captured = capture(next.repo, nextId);
    const read = operatorState.readOperatorState;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    const fold = vi.spyOn(operatorState, "readOperatorState").mockImplementation(options => {
      if (fault === "throws") throw new Error("status fold failed");
      const snapshot = read(options);
      expect(snapshot.green).toBe(true);
      clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 10_001);
      return snapshot;
    });
    await runDaemon(next.repo, { adapters: [next.fake], driver: captured.driver, runId: nextId });
    clock?.mockRestore();
    fold.mockRestore();
    expect(captured.posts.map(p => p.text)).toEqual([`tickmarkr ${nextId}: run ended — verdict unknown — run tickmarkr status`]);
  }
}, 180_000);

test("test: a run whose journal gains a malformed line, with every other clause green, posts exactly one run-end notification reading the unknown verdict, never GREEN, while the same run without the bad line posts GREEN, so a post folding only the lines that parse fails", async () => {
  for (const torn of [false, true]) {
    const runId = torn ? "run-post-torn" : "run-post-whole";
    const { repo, scriptPath } = setupRepo([T("T1")], clean, greenGates);
    const path = join(tickmarkrDir(repo), "runs", runId, "journal.jsonl");
    // The worker appends a malformed line to its own run's journal; every row after it parses.
    const shell = `${clean.tasks.T1[0]!.shell}${torn ? ` && printf '{"torn\\n' >> '${path}'` : ""}`;
    writeFileSync(scriptPath, JSON.stringify({ ...JSON.parse(readFileSync(scriptPath, "utf8")), tasks: { T1: [{ ...clean.tasks.T1[0], shell }] } }));
    const { driver, posts } = capture(repo, runId);
    expect((await runDaemon(repo, { adapters: [new FakeAdapter(scriptPath)], driver, runId })).done).toEqual(["T1"]);
    expect(readFileSync(path, "utf8").split("\n").includes('{"torn'), runId).toBe(torn);
    expect(posts.map(p => p.text), runId).toEqual([torn ? `tickmarkr ${runId}: run ended — verdict unknown — run tickmarkr status` : `tickmarkr ${runId}: run ended GREEN`]);
    // Every other clause is green: the fold over the rows that parse reads green.
    expect(stateAtPost(repo, posts[0]!.events).green, runId).toBe(true);
  }
}, 120_000);

test("test: a notification tool that ignores the termination signal and never exits is killed at ten seconds, so the post returns within that bound, exactly one failure row is journaled and the post-end cleanup continues, while a tool that cannot start or exits non-zero likewise leaves the run going with one failure row, so an unbounded or fatal post fails", async () => {
  for (const failure of ["hang", "missing", "nonzero"] as const) {
    const { repo, fake } = setupRepo([T("T1")], clean);
    const runId = `run-post-failure-${failure}`;
    const dir = makeTestTempDir("notification-process-");
    const pidPath = join(dir, "pid");
    const bin = failure === "missing" ? dir : tool(failure === "hang"
      ? `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`
      : "process.exit(7);");
    let elapsed = 0;
    const poster: NotificationPoster = (command, args, options) => {
      const started = performance.now();
      const result = spawnSync(command, args, { ...options, env: { ...process.env, PATH: bin } });
      elapsed = performance.now() - started;
      return result;
    };
    const { driver, posts } = capture(repo, runId, "darwin", poster);
    let cleanupContinued = false;
    driver.reconcile = async () => {
      const rows = Journal.open(repo, runId).read();
      if (!rows.some(e => e.event === "run-end")) return;
      expect(rows.at(-1)?.event).toBe("os-notify-failed");
      cleanupContinued = true;
    };
    expect((await runDaemon(repo, { adapters: [fake], driver, runId })).done).toEqual(["T1"]);
    const rows = Journal.open(repo, runId).read();
    expect(rows.filter(e => e.event === "os-notify-failed")).toEqual([
      expect.objectContaining({ data: { kind: "run-end", error: expect.any(String) } }),
    ]);
    expect(cleanupContinued).toBe(true);
    expect(posts).toHaveLength(1);
    if (failure === "hang") {
      expect(elapsed).toBeGreaterThanOrEqual(9900);
      expect(elapsed).toBeLessThan(12_000);
      expect(rows.find(e => e.event === "os-notify-failed")!.data.error).toMatch(/ETIMEDOUT/);
      const pid = Number(readFileSync(pidPath, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } else if (failure === "missing") expect(rows.find(e => e.event === "os-notify-failed")!.data.error).toMatch(/ENOENT/);
    else expect(rows.find(e => e.event === "os-notify-failed")!.data.error).toContain("7");
  }
  // A throwing injected poster and an unwritable journal are also nonfatal for either kind.
  const failed: NotificationPost["kind"][] = [];
  const driver = new SubprocessDriver({ platform: "darwin", poster: () => { throw new Error("poster failed"); } });
  driver.journalWith((_event, _taskId, data) => { failed.push(data!.kind as NotificationPost["kind"]); throw new Error("sink failed"); });
  for (const kind of ["park", "run-end"] as const) expect(() => driver.postSync({ kind, text: "notice" })).not.toThrow();
  expect(failed).toEqual(["park", "run-end"]);
}, 120_000);
