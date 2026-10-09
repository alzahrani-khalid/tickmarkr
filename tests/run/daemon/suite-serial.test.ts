import * as os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { codex } from "../../../src/adapters/codex.js";
import { batchedProcessProbes } from "../../../src/run/suite-census.js";
import { countLiveSuites, liveSuiteCount, resetLiveSuiteCountForTests, resetSuiteWaitCeilingForTests, runDaemon, setLiveSuiteCountForTests, setSuiteWaitCeilingForTests, SUITE_POLL_MS } from "../../../src/run/daemon.js";
import { FORK_CAP_ENV, resetSpawnForTests, setSpawnForTests, shell, SUITE_PARENT_ENV } from "../../../src/run/git.js";
import { COMMAND_LEASE_TOKEN_ENV, CommandLeases, runWithCommandLease } from "../../../src/run/lease.js";
import { shq } from "../../../src/adapters/types.js";
import { Journal } from "../../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

// Each daemon fixture models a separate root suite. The nested runner fixture inherits its own token.
beforeEach(() => { vi.stubEnv(COMMAND_LEASE_TOKEN_ENV, undefined); });
afterEach(() => { vi.unstubAllEnvs(); });

// Exercise the auto-detected npm command with a tiny script, without a nested suite.
const runner = (body = 'console.log("Tests  1 passed (1)")') => {
  const dir = makeTestTempDir("tickmarkr-lease-runner-");
  writeFileSync(join(dir, "test.cjs"), body);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node test.cjs" } }));
  return `cd ${dir} && npm run -s test`;
};

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
}));

test("test: a full-suite verdict round waits while another suite is live under the run's worktrees or the repo root counting a vitest child by parentage through TICKMARKR_SUITE_PARENT as well as by cwd and journals suite-wait with the count whereas a daemon that starts the round beside a live suite or counts only suite mains fails", async () => {
  const { repo, fake } = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `echo suite > suite.txt && ${COMMIT} suite`, result: { ok: true, summary: "suite" } }] } },
    `gates: { test: '${runner(`if (process.env.${SUITE_PARENT_ENV} !== "${process.pid}") process.exit(1); console.log("Tests  1 passed (1)")`) }' }\n`,
  );

  const daemonPid = 7000;
  const byCwdPid = 7001;
  const nestedPid = 7002;
  const snapshot = [
    `${byCwdPid} 1 S node node_modules/vitest/vitest.mjs run`,
    `${nestedPid} 1 S node node_modules/vitest/vitest.mjs run`,
  ].join("\n");
  const cwds = new Map([[byCwdPid, realpathSync(repo)], [nestedPid, tmpdir()], [daemonPid, realpathSync(repo)]]);
  const count = (rows: string) => countLiveSuites(
    rows, repo, daemonPid, (pid) => cwds.get(pid),
    (pid) => pid === nestedPid ? daemonPid : undefined,
  );
  expect(count(snapshot.split("\n")[0]!)).toBe(1); // repository cwd
  expect(count(snapshot.split("\n")[1]!)).toBe(1); // inherited parent marker outside the repository

  // Keep one externally attributed suite live for two polls, then release it. The real test gate
  // also proves every gate shell receives the marker used by the process-parentage probe above.
  const counts = [1, 1, 0];
  setLiveSuiteCountForTests(async () => counts.shift() ?? 0);
  const started = Date.now();
  let summary: Awaited<ReturnType<typeof runDaemon>>;
  try {
    summary = await runDaemon(repo, { adapters: [fake], runId: "run-suite-serial" });
  } finally {
    resetLiveSuiteCountForTests();
  }
  const elapsed = Date.now() - started;

  expect(summary.done).toEqual(["T1"]);
  expect(elapsed).toBeGreaterThanOrEqual(SUITE_POLL_MS * 2);
  const waits = Journal.open(repo, "run-suite-serial").read().filter((e) => e.event === "suite-wait");
  expect(waits.length).toBeGreaterThan(0);
  expect(waits.some((e) => typeof e.data.count === "number" && e.data.count >= 1)).toBe(true);
}, 30_000);

// OBS-889 (run 3372): a bare-codex worker's argv carries its whole prompt, and the prompt names the
// runner, so a FINISHED interactive worker in a task's worktree counted as a live suite and the census
// never reached zero — T5's gates waited 9 min 46 s with no row. A runner is named in a command's head.
test("test: a process whose command names the runner only deep inside a prompt-sized argv counts zero while sh -c npm test and node <bin>/vitest.mjs count one whereas a census that reads the whole command line counts the worker", () => {
  const repo = realpathSync(tmpdir());
  const prose = `codex -a never -s workspace-write --prompt ${"lorem ipsum ".repeat(4000)}Each test: acceptance criterion must exist as a vitest test whose OWN title names it`;
  const rows = [
    `8001 1 S ${prose}`,
    `8002 1 S sh -c npm test`,
    `8003 1 S node /repo/node_modules/vitest/vitest.mjs run --reporter=default`,
  ];
  const count = (row: string) => countLiveSuites(row, repo, 7000, () => repo, () => undefined);
  expect(count(rows[0]!)).toBe(0);
  expect(count(rows[1]!)).toBe(1);
  expect(count(rows[2]!)).toBe(1);
  // OBS-930: the SHIPPED codex TUI launch, as `ps` would show it once the pane shell has expanded
  // "$(cat promptFile)" — the whole prompt inline, naming vitest and npm test — counts zero too.
  const promptBytes = `${"lorem ipsum ".repeat(4000)}Run npm test; each criterion must exist as a vitest test whose OWN title names it`;
  const shipped = codex.interactiveCommand("/tmp/T5-a0.md", "gpt-5.6-sol")!
    .replace(/"\$\(cat '\/tmp\/T5-a0\.md'\)"$/, promptBytes)
    .replace(/'/g, "");
  expect(shipped.startsWith("codex -a never -s workspace-write ")).toBe(true);
  expect(shipped).toContain("vitest");
  expect(count(`8004 1 S ${shipped}`)).toBe(0);
  expect(count(`8004 1 S ${shipped}\n8005 8004 S sh -c npm test`)).toBe(1);
});

test.each([
  "npm run test:unit", "pnpm exec vitest run", "yarn vitest run", "pnpm vitest", "npx --yes vitest run", "npm exec vitest",
])("D1: the live-suite census counts package-manager command %s once with its runner descendants", command => {
  const repo = realpathSync(tmpdir());
  const parent = `8101 1 S ${command}`;
  const count = (snapshot: string) => countLiveSuites(snapshot, repo, 7000, () => repo, () => undefined);
  expect(count(parent)).toBe(1);
  expect(count(`${parent}\n8102 8101 S sh -c vitest run\n8103 8102 S node /repo/node_modules/vitest/vitest.mjs run`)).toBe(1);
  expect(count(`${parent}\n8104 1 S pnpm exec vitest run`)).toBe(2);
});

test("R87: a leased npm test whose child spawns npx vitest completes without waiting and is counted once with its descendants", async () => {
  const repo = realpathSync(makeTestTempDir("tickmarkr-reentrant-runner-"));
  const loader = createRequire(import.meta.url).resolve("tsx");
  symlinkSync(new URL("../../../node_modules", import.meta.url), join(repo, "node_modules"), "dir");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: `node --import ${shq(loader)} parent.mjs` } }));
  writeFileSync(join(repo, "vitest.config.mjs"), "export default { test: { include: ['child.test.js'], poolOptions: { forks: { singleFork: true } } } };\n");
  writeFileSync(join(repo, "child.test.js"), `import { test, expect } from 'vitest';
    import { writeFileSync } from 'node:fs';
    test('nested runner executed', () => { writeFileSync('child-ran', 'yes'); expect(1 + 1).toBe(2); });`);
  writeFileSync(join(repo, "parent.mjs"), `
    import { runWithCommandLease } from ${JSON.stringify(new URL("../../../src/run/lease.ts", import.meta.url).href)};
    import { shell } from ${JSON.stringify(new URL("../../../src/run/git.ts", import.meta.url).href)};
    const result = await runWithCommandLease(async () => {
      throw new Error('nested runner attempted a second lease instead of joining its parent');
    }, () => shell('npx vitest run --config vitest.config.mjs', process.cwd(), 10000));
    console.log('LEASE_CHILD_RESULT=' + JSON.stringify({ token: process.env.TICKMARKR_LEASE_TOKEN, code: result.code, stderr: result.stderr }));
    process.exitCode = result.code;
  `);
  const leases = new CommandLeases(), acquisitions: string[] = [], waits: number[] = [];
  const tokens: Array<string | undefined> = [];
  const parentToken = process.env.TICKMARKR_LEASE_TOKEN;
  setSpawnForTests(((binary: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    tokens.push(options.env?.TICKMARKR_LEASE_TOKEN);
    return spawn(binary, args, options);
  }) as Parameters<typeof setSpawnForTests>[0]);
  try {
    const result = await runWithCommandLease((command, execute) => {
      acquisitions.push(command);
      return leases.run(execute, count => waits.push(count), SUITE_POLL_MS);
    }, () => shell("npm test", repo, 20000));
    expect(result.code, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find(row => row.startsWith("LEASE_CHILD_RESULT="));
    expect(line, result.stdout).toBeDefined();
    const child = JSON.parse(line!.slice("LEASE_CHILD_RESULT=".length));
    expect(child).toMatchObject({ token: tokens[0], code: 0 });
    expect(tokens[0]).toEqual(expect.any(String));
    expect(tokens[0]).not.toBe("");
    expect(acquisitions).toEqual(["npm test"]);
    expect(waits).toEqual([]);
    expect(readFileSync(join(repo, "child-ran"), "utf8")).toBe("yes");
    expect(process.env.TICKMARKR_LEASE_TOKEN).toBe(parentToken);

    const snapshot = "8101 1 S npm test\n8102 8101 S node parent.mjs\n8103 8102 S npx vitest run\n8104 8103 S node /bin/vitest.mjs run";
    const count = (rows: string) => countLiveSuites(rows, repo, 7000, () => repo, () => undefined);
    expect(count(snapshot)).toBe(1);
    expect(count(snapshot + "\n8105 1 S npm test")).toBe(2);
  } finally {
    resetSpawnForTests();
  }
}, 30000);

test("test: a live-suite census that never reaches zero releases the verdict round at the ceiling and journals suite-wait-ceiling with the count and the wait whereas a window with no ceiling holds the run forever", async () => {
  const { repo, fake } = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `echo suite > suite.txt && ${COMMIT} suite`, result: { ok: true, summary: "suite" } }] } },
    `gates: { test: '${runner()}' }\n`,
  );
  setLiveSuiteCountForTests(async () => 1);
  setSuiteWaitCeilingForTests(SUITE_POLL_MS * 2);
  let summary: Awaited<ReturnType<typeof runDaemon>>;
  try {
    summary = await runDaemon(repo, { adapters: [fake], runId: "run-suite-ceiling" });
  } finally {
    resetLiveSuiteCountForTests();
    resetSuiteWaitCeilingForTests();
  }
  expect(summary.done).toEqual(["T1"]);
  const rows = Journal.open(repo, "run-suite-ceiling").read();
  const ceiling = rows.filter((e) => e.event === "suite-wait-ceiling");
  expect(ceiling.length).toBeGreaterThan(0);
  expect(ceiling[0]!.data.count).toBe(1);
  expect(typeof ceiling[0]!.data.waitedMs).toBe("number");
}, 30_000);


test("test: a verdict round released at the suite-wait ceiling while the census still counts a foreign suite runs under the conservative budget with a suite-budget row naming the count and both caps, while a round entering on an empty census runs under the occupancy budget and journals no such row, so a ceiling release that grants the occupancy budget beside a foreign suite fails", async () => {
  const priorCap = process.env[FORK_CAP_ENV];
  delete process.env[FORK_CAP_ENV];
  const cores = vi.spyOn(os, "availableParallelism").mockReturnValue(18);
  setSuiteWaitCeilingForTests(0);
  try {
    for (const census of [[1, 1, 1], [0, 0, 0], [0, 1, 0]]) {
      const samples = [...census];
      setLiveSuiteCountForTests(async () => samples.shift() ?? 0);
      const caps = census.map((count) => count ? 3 : 6);
      const allowedCaps = census.every((count) => count === census[0]) ? [caps[0]] : [3, 6];
      const gate = runner(`if (!${JSON.stringify(allowedCaps)}.includes(Number(process.env.VITEST_MAX_FORKS))) process.exit(1); console.log("Tests  1 passed (1)")`);
      const { repo, fake } = setupRepo(
        [T("T1")],
        { tasks: { T1: [{ shell: `echo suite > suite.txt && ${COMMIT} suite`, result: { ok: true, summary: "suite" } }] } },
        `concurrency: 2\ngates: { test: '${gate}' }\n`,
      );
      const runId = `run-suite-budget-${census.join("")}`;
      const summary = await runDaemon(repo, { adapters: [fake], runId });
      expect(summary.done).toEqual(["T1"]);
      const journal = Journal.open(repo, runId);
      const rows = journal.read();
      const budgets = rows.filter((e) => e.event === "suite-budget");
      expect(budgets).toHaveLength(census.filter(Boolean).length); // baseline, task battery, tip
      for (const row of budgets) expect(row.data).toEqual({ count: 1, occupancyCap: 6, conservativeCap: 3 });
      const baseline = JSON.parse(readFileSync(join(journal.dir, "baseline.json"), "utf8"));
      expect(baseline.commands.test.capacity).toEqual({ forkCap: caps[0], cores: 18 });
      const verdicts = rows.filter((e) => ["gate-result", "tip-verify"].includes(e.event) && e.data.gate === "test");
      expect(verdicts).toHaveLength(2);
      for (const [i, row] of verdicts.entries()) {
        expect(row.data).toMatchObject({ pass: true, capacity: { forkCap: caps[i + 1], cores: 18 } });
      }
    }
  } finally {
    if (priorCap === undefined) delete process.env[FORK_CAP_ENV];
    else process.env[FORK_CAP_ENV] = priorCap;
    cores.mockRestore();
    resetLiveSuiteCountForTests();
    resetSuiteWaitCeilingForTests();
  }
}, 60_000);

test("test: with task A held in review by a stalled reviewer and task B entering gates the journal carries B's test gate result before A's review result with no suite-wait row for B, while with A inside its acceptance named-test oracle or its merge-candidate full suite B journals suite-wait and its test result follows A's, so a window that wraps the review phase or a lease that skips the oracle and full-suite commands fails", async () => {
  const { spawn } = await import("node:child_process");
  const { setSpawnForTests, resetSpawnForTests } = await import("../../../src/run/git.js");
  const { SubprocessDriver } = await import("../../../src/drivers/subprocess.js");
  const { shq } = await import("../../../src/adapters/types.js");
  for (const phase of ["review", "oracle", "full"] as const) {
    const dir = makeTestTempDir("tickmarkr-contention-");
    const release = join(dir, "release");
    const runnerFile = join(dir, "test-runner.cjs");
    const testCommand = "npm run -s test";
    const waitFile = join(dir, "review.cjs");
    const wait = `const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log('Tests  1 passed (1)'); } }, 10);`;
    writeFileSync(waitFile, wait);
    writeFileSync(runnerFile, `
      const held = process.cwd().endsWith('--A') && ${phase === "oracle" ? "process.argv.includes('-t')" : phase === "full" ? "process.argv.length === 2" : "false"};
      if (held) { ${wait} } else console.log('Tests  1 passed (1)');
    `);
    let startB!: () => void;
    const mayStartB = new Promise<void>(resolve => { startB = resolve; });
    let held = false;
    const fixture = setupRepo([
      T("A", { files: ["a.test.ts"], acceptance: phase === "oracle" ? [{ oracle: "test", test: "oracle A" }] : ["done"] }),
      T("B", { files: ["b.txt"] }),
    ], { tasks: {
      A: [{ shell: `echo '// test fixture' > a.test.ts && ${COMMIT} A`, result: { ok: true, summary: "A" } }],
      B: [{ shell: `echo B > b.txt && ${COMMIT} B`, result: { ok: true, summary: "B" } }],
    } }, "concurrency: 2\n");
    // Let production detection choose the command, including baseline and tip verification.
    writeFileSync(join(fixture.repo, "package.json"), JSON.stringify({ scripts: { test: `node ${shq(runnerFile)}` } }));
    execFileSync("git", ["add", "package.json"], { cwd: fixture.repo });
    execFileSync("git", ["commit", "--no-gpg-sign", "-m", "test script"], { cwd: fixture.repo });
    const original = fixture.fake.headlessCommand.bind(fixture.fake);
    fixture.fake.headlessCommand = (prompt, model) => {
      const command = original(prompt, model);
      if (phase === "review" && !held && readFileSync(prompt, "utf8").includes("TICKMARKR-REVIEW")) {
        held = true; startB();
        return `node ${shq(waitFile)} && ${command}`;
      }
      return command;
    };
    setSpawnForTests(((binary: string, args: string[], options: { cwd?: string }) => {
      const command = args[1] ?? "";
      if (!held && phase !== "review" && options.cwd?.endsWith("--A") && command.startsWith(testCommand)
        && (phase === "oracle" ? command.includes(" -t ") : command === testCommand)) {
        held = true; startB();
      }
      return spawn(binary, args, options);
    }) as Parameters<typeof setSpawnForTests>[0]);
    class Ordered extends SubprocessDriver {
      override async run(slot: Parameters<SubprocessDriver["run"]>[0], command: string) {
        if (slot.name.startsWith("B-worker-")) await mayStartB;
        return super.run(slot, command);
      }
    }
    const runId = `run-contention-${phase}`;
    setLiveSuiteCountForTests(async () => 0);
    try {
      const summary = await runDaemon(fixture.repo, { adapters: [fixture.fake], driver: new Ordered(), runId,
        narrate: row => {
          if (row.taskId === "B" && (phase === "review"
            ? row.event === "gate-result" && row.data.gate === "test"
            : row.event === "suite-wait")) writeFileSync(release, "go");
        },
      });
      expect(summary.done.sort()).toEqual(["A", "B"]);
      expect(held).toBe(true);
      const rows = Journal.open(fixture.repo, runId).read();
      const bTest = rows.findIndex(row => row.taskId === "B" && row.event === "gate-result" && row.data.gate === "test");
      // v2.6.7 T1: A is a fresh candidate, so its one test row is the full job's — no selected screen precedes it.
      const aResult = rows.findIndex(row => row.taskId === "A" && row.event === "gate-result" && row.data.gate === (phase === "review" ? "review" : phase === "oracle" ? "acceptance" : "test"));
      expect(bTest).toBeGreaterThan(-1); expect(aResult).toBeGreaterThan(-1);
      const waits = rows.filter(row => row.taskId === "B" && row.event === "suite-wait");
      if (phase === "review") { expect(bTest).toBeLessThan(aResult); expect(waits).toEqual([]); }
      else { expect(bTest).toBeGreaterThan(aResult); expect(waits[0]?.data.count).toBeGreaterThan(0); }
    } finally { writeFileSync(release, "go"); startB(); resetSpawnForTests(); resetLiveSuiteCountForTests(); }
  }
}, 180_000); // C-15: three daemon runs; a loaded coverage run missed 60 s

// Queue row 103 (D-1553): the production census answers every runner-looking pid in one batched async probe. Pids
// above any pid_max, so /proc never answers and every probe reaches the batched exec on every host.
const censusPid = (n: number) => 900_000_000 + n;

test("the live-suite census answers every candidate with one lsof and one ps per snapshot and one more lsof for unseen suite parents versus one probe per process", async () => {
  const pids = Array.from({ length: 30 }, (_, i) => censusPid(i + 1));
  const parent = censusPid(99);
  const calls: string[] = [];
  const probes = await batchedProcessProbes(pids, async (file, args) => {
    calls.push(`${file} ${args.join(" ")}`);
    if (file === "lsof") return args[2] === pids.join(",") ? `p${pids[0]}\nfcwd\nn${tmpdir()}\n` : "";
    return `${pids[1]} node node_modules/vitest/vitest.mjs run ${SUITE_PARENT_ENV}=${parent}\n`;
  });
  expect(calls).toEqual([
    `lsof -a -p ${pids.join(",")} -d cwd -Fn`,
    `ps eww -p ${pids.join(",")} -o pid=,command=`,
    `lsof -a -p ${parent} -d cwd -Fn`,
  ]);
  expect(probes.cwd(pids[0]!)).toBe(realpathSync(tmpdir()));
  expect(probes.suiteParent(pids[1]!)).toBe(parent);
  expect(probes.cwd(pids[2]!)).toBeUndefined();
  expect(probes.suiteParent(pids[2]!)).toBeUndefined();
});

test.each([
  ["a runner whose cwd is in the repository", 1, 1],
  ["a runner elsewhere whose suite-parent marker names this daemon", 2, 1],
  ["a runner elsewhere whose suite parent's cwd is in the repository", 3, 1],
  ["a runner elsewhere with no suite-parent marker", 4, 0],
  ["a runner that exited before the probe answered", 5, 0],
  ["a runner below this daemon", 6, 1],
] as const)("the batched live-suite census counts %s as the per-process probes did", async (_row, n, expected) => {
  const repo = realpathSync(makeTestTempDir("tickmarkr-census-repo-"));
  const elsewhere = realpathSync(makeTestTempDir("tickmarkr-census-elsewhere-"));
  const daemonPid = 7000;
  const pid = censusPid(n);
  const parent = censusPid(199);
  const snapshot = `${pid} ${n === 6 ? daemonPid : 1} S node node_modules/vitest/vitest.mjs run`;
  const cwd: Record<number, string> = { [censusPid(1)]: repo, [censusPid(2)]: elsewhere, [censusPid(3)]: elsewhere, [censusPid(4)]: elsewhere, [censusPid(6)]: elsewhere, [parent]: repo };
  const marker: Record<number, number> = { [censusPid(2)]: daemonPid, [censusPid(3)]: parent };
  const probes = await batchedProcessProbes([pid], async (file, args) => {
    const asked = args[2]!.split(",").map(Number);
    return file === "lsof"
      ? asked.filter((p) => cwd[p]).map((p) => `p${p}\nfcwd\nn${cwd[p]}`).join("\n")
      : asked.filter((p) => marker[p]).map((p) => `${p} node vitest.mjs run ${SUITE_PARENT_ENV}=${marker[p]}`).join("\n");
  });
  const perProcess = countLiveSuites(snapshot, repo, daemonPid, (p) => cwd[p], (p) => marker[p]);
  expect(countLiveSuites(snapshot, repo, daemonPid, probes.cwd, probes.suiteParent)).toBe(expected);
  expect(perProcess).toBe(expected);
});

test("the production census keeps the daemon's event loop turning while lsof and ps answer slowly versus a synchronous probe per process that holds it", async () => {
  resetLiveSuiteCountForTests();
  const bin = makeTestTempDir("tickmarkr-census-bin-");
  const log = join(bin, "calls.log");
  const runners = [1, 2, 3, 4, 5].map((n) => censusPid(200 + n));
  // the snapshot lists five runners outside the repository; every probe answers nothing after 400 ms
  writeFileSync(join(bin, "ps"), `#!/bin/sh\necho "ps $*" >> ${shq(log)}\nif [ "$1" = "-Aww" ]; then\n${runners.map((p) => `  echo "${p} 1 S node node_modules/vitest/vitest.mjs run"`).join("\n")}\n  exit 0\nfi\nsleep 0.4\n`, { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), `#!/bin/sh\necho "lsof $*" >> ${shq(log)}\nsleep 0.4\n`, { mode: 0o755 });
  const repo = realpathSync(makeTestTempDir("tickmarkr-census-repo-"));
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  const started = Date.now();
  try {
    expect(await liveSuiteCount(repo)).toBe(0);
  } finally {
    clearInterval(timer);
    vi.unstubAllEnvs();
  }
  const elapsed = Date.now() - started;
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls.filter((call) => call.startsWith("lsof "))).toHaveLength(1);
  expect(calls.filter((call) => call.startsWith("ps eww "))).toHaveLength(1);
  // a synchronous lsof + ps per process holds the loop ~4 s with no tick; the batched async probe lets it turn
  expect(ticks).toBeGreaterThanOrEqual(Math.floor(elapsed / 40));
});

// D-1558: the /proc branch reads ONE NUL-delimited environment entry and requires its WHOLE value to be digits — the
// base's rule (7c8009772 daemon.ts:1418-1423); the ps-eww branch keeps the base's whitespace rule. Injected readers.
test.each([
  ["E1 a DESCRIPTION value that merely contains the marker text", [`DESCRIPTION=run ${SUITE_PARENT_ENV}=7000 now`], 0],
  ["E2 a DESCRIPTION holding another marker ahead of the real entry", [`DESCRIPTION=x ${SUITE_PARENT_ENV}=8000`, `${SUITE_PARENT_ENV}=7000`], 1],
  ["E3 a real marker whose value is not wholly digits", [`${SUITE_PARENT_ENV}=7000 junk`], 0],
] as const)("the census reads a /proc environment %s as the base's per-process probe did", async (_row, entries, expected) => {
  const repo = realpathSync(makeTestTempDir("tickmarkr-census-env-"));
  const elsewhere = realpathSync(makeTestTempDir("tickmarkr-census-env-elsewhere-"));
  const pid = censusPid(300);
  const probes = await batchedProcessProbes([pid], async (file) => file === "lsof" ? `p${pid}\nfcwd\nn${elsewhere}\n` : "", {
    cwd: () => { throw new Error("no /proc cwd"); },
    environ: () => [...entries, "PATH=/usr/bin"].join("\0"),
  });
  expect(countLiveSuites(`${pid} 1 S node node_modules/vitest/vitest.mjs run`, repo, 7000, probes.cwd, probes.suiteParent)).toBe(expected);
});

test("the census reads a ps eww environment line with the base's whitespace rule unchanged", async () => {
  const pid = censusPid(301);
  const probes = await batchedProcessProbes([pid], async (file) =>
    file === "ps" ? `${pid} node node_modules/vitest/vitest.mjs run DESCRIPTION=x ${SUITE_PARENT_ENV}=7000 HOME=/h\n` : "", {
    cwd: () => { throw new Error("no /proc"); },
    environ: () => { throw new Error("no /proc"); },
  });
  expect(probes.suiteParent(pid)).toBe(7000);
});

