import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { expect, test } from "vitest";
import { countLiveSuites, resetLiveSuiteCountForTests, resetSuiteWaitCeilingForTests, runDaemon, setLiveSuiteCountForTests, setSuiteWaitCeilingForTests, SUITE_POLL_MS } from "../../../src/run/daemon.js";
import { SUITE_PARENT_ENV } from "../../../src/run/git.js";
import { Journal } from "../../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

test("test: a full-suite verdict round waits while another suite is live under the run's worktrees or the repo root counting a vitest child by parentage through TICKMARKR_SUITE_PARENT as well as by cwd and journals suite-wait with the count whereas a daemon that starts the round beside a live suite or counts only suite mains fails", async () => {
  const { repo, fake } = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `echo suite > suite.txt && ${COMMIT} suite`, result: { ok: true, summary: "suite" } }] } },
    `gates: { test: 'test "$${SUITE_PARENT_ENV}" = "${process.pid}"' }\n`,
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
});

test("test: a live-suite census that never reaches zero releases the verdict round at the ceiling and journals suite-wait-ceiling with the count and the wait whereas a window with no ceiling holds the run forever", async () => {
  const { repo, fake } = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `echo suite > suite.txt && ${COMMIT} suite`, result: { ok: true, summary: "suite" } }] } },
    "gates: { test: 'true' }\n",
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
