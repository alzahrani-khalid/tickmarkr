import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { expect, test } from "vitest";
import { countLiveSuites, resetLiveSuiteCountForTests, runDaemon, setLiveSuiteCountForTests, SUITE_POLL_MS } from "../../../src/run/daemon.js";
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
