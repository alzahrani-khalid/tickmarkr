import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { approve } from "../../../src/cli/commands/approve.js";
import { loadGraph } from "../../../src/graph/graph.js";
import { runDaemon, setLiveSuiteCountForTests, resetLiveSuiteCountForTests } from "../../../src/run/daemon.js";
import { setHostLatencySampleForTests, resetHostLatencySampleForTests } from "../../../src/run/host-health.js";
import { Journal } from "../../../src/run/journal.js";
import { COMMAND_LEASE_TOKEN_ENV } from "../../../src/run/lease.js";
import { readOperatorState } from "../../../src/run/operator-state.js";
import { boardFrame } from "../../../src/tui/cockpit/board.js";
import { evidenceLookup, runGateCells } from "../../../src/tui/cockpit/run-view.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

afterEach(() => { resetLiveSuiteCountForTests(); resetHostLatencySampleForTests(); vi.unstubAllEnvs(); });

test("test: the production daemon recheck projects old-red→reset→queued→running→passed identically through board/run view from actual suite-wait/phase-start evidence, so a gate-start-only fold retaining stale failure labels fails", async () => {
  vi.stubEnv(COMMAND_LEASE_TOKEN_ENV, undefined);
  setHostLatencySampleForTests(async () => 20);
  setLiveSuiteCountForTests(async () => 0);
  const runner = makeTestTempDir("board-gates-");
  const green = join(runner, "green");
  writeFileSync(join(runner, "package.json"), JSON.stringify({ scripts: { test: "node test.cjs" } }));
  writeFileSync(join(runner, "test.cjs"), `const fs = require('fs'); const path = require('path');
if (fs.existsSync(path.join(process.env.INIT_CWD, 't1.txt')) && !fs.existsSync(${JSON.stringify(green)})) {
  console.error('Error: spawn EAGAIN'); process.exit(1);
}
console.log('Tests  1 passed (1)');`);
  const { repo, fake } = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] })], {
    tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] },
  }, stringify({ gates: { build: "true", test: `npm run -s test --prefix '${runner}'`, lint: "true" } }));
  const runId = "run-board-gates";
  expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
  const before = Journal.open(repo, runId).read();
  expect(before.findLast(e => e.event === "gate-result" && e.data.gate === "test")?.data.pass).toBe(false);
  await approve([runId, "T1", "--recheck"], repo);
  writeFileSync(green, "yes");
  let waited = false;
  setLiveSuiteCountForTests(async () => {
    const rows = Journal.open(repo, runId).read();
    const phase = rows.findLast(e => e.event === "phase-start" && e.taskId === "T1");
    if (!waited && phase?.data.gate === "test" && rows.indexOf(phase) > rows.findLastIndex(e => e.event === "run-resume")) {
      waited = true; return 1;
    }
    return 0;
  });
  expect((await runDaemon(repo, { adapters: [fake], runId, resume: true })).done).toEqual(["T1"]);
  const events = Journal.open(repo, runId).read();
  expect(events.some(e => e.event === "gate-start")).toBe(false);
  expect(waited).toBe(true);
  const approval = events.findIndex(e => e.event === "task-approved" && e.data.release === "recheck");
  const queued = events.findIndex((e, i) => i > approval && e.event === "suite-wait" && e.taskId === "T1");
  const running = events.findIndex((e, i) => i > queued && e.event === "phase-start" && e.data.gate === "test" && e.data.admitted === true);
  const passed = events.findIndex((e, i) => i > running && e.event === "gate-result" && e.data.gate === "test" && e.data.pass === true);
  expect(queued).toBeGreaterThan(approval); expect(running).toBeGreaterThan(queued); expect(passed).toBeGreaterThan(running);
  expect(events.slice(approval).some(e => e.event === "task-dispatch")).toBe(false);
  const graph = loadGraph(repo);
  for (const [end, state, letter, glyph] of [[before.length - 1, "failed", "F", "✖"], [approval, "not-run", "-", "·"], [queued, "queued", "Q", "Q"], [running, "running", "R", "R"], [passed, "passed", "P", "✔"]] as const) {
    const prefix = events.slice(0, end + 1);
    const snapshot = readOperatorState({ events: prefix, graph });
    const task = snapshot.tasks.find(t => t.id === "T1")!;
    const rows = prefix.map((event, i) => ({ event, line: i + 1 }));
    const cell = runGateCells(task, evidenceLookup(rows), rows).find(c => c.gate === "test")!;
    expect(cell.state).toBe(state); expect(cell.letter).toBe(letter);
    const board = boardFrame({ runId, snapshot, graph, now: Date.now(), colour: false }, 180);
    expect(board.rows[0]!.strip.slice(3, 6).trim()).toBe(glyph);
    if (state !== "failed") {
      expect(cell.labels.join(" ")).not.toContain("failed");
      expect(cell.verdict.join(" ")).not.toContain("EAGAIN");
      expect(board.rows[0]!.note).not.toContain("✖ test");
    }
    if (state === "queued") expect(cell.labels.join(" ")).toContain("suite-wait (1 suites)");
  }
}, 120_000);
