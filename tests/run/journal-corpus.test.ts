import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Journal } from "../../src/run/journal.js";
import expected from "../fixtures/journal-corpus/expected-statuses.json";

// Phase 46 (RES-01/RES-02, D-04 obligation 2): the corpus compat oracle. All 31 vendored
// pre-v1.13 journals (tests/fixtures/journal-corpus/, frozen at plan time) must replay
// byte-identically under TODAY's replayStatuses — a machine diff per run, never narration.
// An emptied fixture dir reddenes via the count assertion, never goes vacuously green.

const CORPUS_DIR = join(import.meta.dirname, "..", "fixtures", "journal-corpus");
const RUN_GLOB = /^run-.*\.jsonl$/;

function loadFixture(runId: string): Journal {
  const j = Journal.create(mkdtempSync(join(tmpdir(), "corpus-")), runId);
  writeFileSync(join(j.dir, "journal.jsonl"), readFileSync(join(CORPUS_DIR, `${runId}.jsonl`), "utf8"));
  return j;
}

const fixtureRuns: string[] = readdirSync(CORPUS_DIR)
  .filter((f) => RUN_GLOB.test(f))
  .map((f) => f.replace(/\.jsonl$/, ""))
  .sort();

describe("journal corpus compat (Phase 46, criterion 3)", () => {
  test("fixture count is exactly 31 — an emptied dir cannot go vacuously green", () => {
    expect(fixtureRuns).toHaveLength(31);
  });

  test("every vendored run's expected-statuses entry exists (no fixture without an oracle, no oracle without a fixture)", () => {
    expect(Object.keys(expected).sort()).toEqual(fixtureRuns);
  });

  test("test: historical journals holding a gate-satisfied release with no later approval replay task statuses byte-identical against the frozen corpus while a replay that rejects or reorders the legacy rows fails", () => {
    for (const runId of fixtureRuns) {
      const actualBytes = JSON.stringify(Object.fromEntries([...loadFixture(runId).replayStatuses()].sort()));
      const expectedBytes = JSON.stringify(Object.fromEntries(
        Object.entries((expected as Record<string, Record<string, unknown>>)[runId]!).sort(),
      ));
      expect(actualBytes).toBe(expectedBytes);
    }

    const legacy = Journal.create(mkdtempSync(join(tmpdir(), "gate-satisfied-legacy-")), "run-gate-satisfied-legacy");
    const rows = [
      { ts: "2026-01-01T00:00:00.000Z", event: "task-dispatch", taskId: "T-legacy", data: {} },
      { ts: "2026-01-01T00:00:01.000Z", event: "task-human", taskId: "T-legacy", data: { reason: "gate failed" } },
      { ts: "2026-01-01T00:00:02.000Z", event: "task-approved", taskId: "T-legacy", data: { release: "gate-satisfied", gate: "build" } },
      { ts: "2026-01-01T00:00:03.000Z", event: "run-resume", data: {} },
    ];
    writeFileSync(join(legacy.dir, "journal.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    expect(JSON.stringify(Object.fromEntries(legacy.replayStatuses()))).toBe('{"T-legacy":"pending"}');
    expect(legacy.replaySatisfiedGates()).toEqual(new Map([["T-legacy", "build"]]));
  });

  for (const runId of fixtureRuns) {
    test(`replayStatuses over ${runId} matches the frozen expected-statuses snapshot (machine diff)`, () => {
      const j = loadFixture(runId);
      expect(Object.fromEntries(j.replayStatuses())).toEqual((expected as Record<string, unknown>)[runId]);
    });
  }

  // Real-data smoke for the Phase 46 derivation: replayResumeState must run over every vendored
  // journal without throwing (fail-closed parsing holds across the whole corpus). run-20260711-185020
  // is the incident run — its full journal has 9 P43-03 dispatches over 3 channels (the post-resume
  // restart at attempt 0 is visible in the data, the very bug this derivation corrects).
  test("replayResumeState runs over all 31 vendored journals without throwing", () => {
    for (const runId of fixtureRuns) expect(loadFixture(runId).replayResumeState()).toBeInstanceOf(Map);
  });

  test("replayResumeState (run-20260711-185020 P43-03): attempts=9, tried spans all 3 channels", () => {
    const st = loadFixture("run-20260711-185020").replayResumeState().get("P43-03")!;
    expect(st.attempts).toBe(9);
    expect(st.tried).toHaveLength(3);
    expect(st.tried).toEqual(expect.arrayContaining(["pi:zai/glm-5.2", "cursor-agent:composer-2.5", "claude-code:sonnet"]));
  });
});
