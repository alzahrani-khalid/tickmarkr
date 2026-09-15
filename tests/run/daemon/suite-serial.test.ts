import * as os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { codex } from "../../../src/adapters/codex.js";
import { countLiveSuites, resetLiveSuiteCountForTests, resetSuiteWaitCeilingForTests, runDaemon, setLiveSuiteCountForTests, setSuiteWaitCeilingForTests, SUITE_POLL_MS } from "../../../src/run/daemon.js";
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
      const aResult = rows.findIndex(row => row.taskId === "A" && row.event === "gate-result" && row.data.gate === (phase === "review" ? "review" : phase === "oracle" ? "acceptance" : "test"));
      expect(bTest).toBeGreaterThan(-1); expect(aResult).toBeGreaterThan(-1);
      const waits = rows.filter(row => row.taskId === "B" && row.event === "suite-wait");
      if (phase === "review") { expect(bTest).toBeLessThan(aResult); expect(waits).toEqual([]); }
      else { expect(bTest).toBeGreaterThan(aResult); expect(waits[0]?.data.count).toBeGreaterThan(0); }
      if (phase === "full") expect(rows[aResult]!.data.fullSuite).toBe(true);
    } finally { writeFileSync(release, "go"); startB(); resetSpawnForTests(); resetLiveSuiteCountForTests(); }
  }
}, 60_000);
