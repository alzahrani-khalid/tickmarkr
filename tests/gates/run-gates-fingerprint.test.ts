import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import { renderMarkdownRecord } from "../../src/cli/commands/report.js";
import { resetCalmWindowForTests, setCalmWindowForTests } from "../../src/gates/baseline.js";
import { runDaemon } from "../../src/run/daemon.js";
import * as git from "../../src/run/git.js";
import { GATE_FINGERPRINT_CAP, identicalGateFailures, Journal, normalizeGateFailure } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

afterEach(() => { vi.restoreAllMocks(); resetCalmWindowForTests(); });

test("a host-starved timeout remeasurement and the next fresh timeout reach the fingerprint cap after one forced repair execution, while the operator report and the repair brief name the rerun and its wait (D-2174)", async () => {
  const command = "[ ! -f t1.txt ] || { echo 'FAIL t1.test.ts > slow'; echo 'Error: Test timed out in 5000ms.'; exit 1; }";
  // Control only the shell's timing observation: the daemon, commands, receipts, bounded retry,
  // no-commit repair and fingerprint accounting all run through their production paths.
  const sh = git.sh;
  let testRuns = 0;
  vi.spyOn(git, "sh").mockImplementation(async (...args) => {
    const result = await sh(...args);
    return args[0] === command ? { ...result, durationMs: ++testRuns === 2 ? 10 : 1 } : result;
  });
  setCalmWindowForTests({ loadProvider: () => 0 });
  const { repo, fake } = setupRepo(
    [T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] })],
    { consult: { action: "human", notes: "operator decides" }, tasks: { T1: [
      { shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } },
      ...Array.from({ length: 4 }, () => ({ shell: "true", result: { ok: true, summary: "unchanged" } })),
    ] } },
    stringify({ gates: { build: "true", test: command, lint: "true" } }),
  );
  const runId = "run-timeout-rerun-fingerprint";
  await runDaemon(repo, { adapters: [fake], runId });
  const rows = Journal.open(repo, runId).read().filter(row => row.taskId === "T1");
  expect(rows.filter(row => row.event === "gate-fresh-forced")).toHaveLength(1);
  const reds = rows.filter(row => row.event === "gate-result" && row.data.gate === "test" && row.data.pass === false);
  expect(reds).toHaveLength(2);
  expect(reds[0]!.data.hostStarvedRerun).toMatchObject({ referenceMs: 1, durationMs: 10 });
  expect(reds[0]!.data.evidenceReceipts).toHaveLength(2);
  expect(reds[1]!.data.hostStarvedRerun).toBeUndefined();
  expect(reds[1]!.data.evidenceReceipts).toHaveLength(1);
  expect(reds[0]!.data.details).toBe(reds[1]!.data.details);
  expect(identicalGateFailures(rows, "T1", "test", normalizeGateFailure(String(reds[1]!.data.details))))
    .toBe(GATE_FINGERPRINT_CAP);
  expect(rows.find(row => row.event === "gate-fingerprint-cap")?.data).toMatchObject({ attempt: 2, occurrences: 2 });
  // Queue row 291: provenance is rendered from the metadata for people, never folded back into the fingerprinted details.
  const note = `host-starved rerun after waiting ${(reds[0]!.data.hostStarvedRerun as { waitedMs: number }).waitedMs}ms for a calm load window`;
  const detail = String(reds[1]!.data.details).split("\n")[0];
  expect(String(reds[0]!.data.details)).not.toContain("host-starved");
  const tickmarks = renderMarkdownRecord(runId, Journal.open(repo, runId).read()).split("\n").filter(line => line.startsWith("  - test: fail"));
  expect(tickmarks).toEqual([`  - test: fail — ${note}: ${detail}`, `  - test: fail — ${detail}`]);
  const brief = readFileSync(join(Journal.open(repo, runId).dir, "prompts", "T1-a1.md"), "utf8");
  expect(brief).toContain(`test: ${note}: ${detail}`);
}, 60_000);
