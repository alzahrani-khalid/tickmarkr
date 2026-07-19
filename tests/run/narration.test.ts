import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { formatJournalNarration, Journal, type JournalEvent } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// Narration regression: the `narrate` callback is an OBSERVATIONAL side-channel. Journal.append writes
// to disk FIRST, then calls narrate inside a try/catch (src/run/journal.ts), so on-disk content is
// independent of the sink by construction. These tests pin that contract so a future refactor cannot
// quietly invert the write/narrate order or drop the catch — either would let narration leak into the
// journal or let a broken sink kill a run.
describe("narration side-channel (fake adapter, zero tokens)", () => {
  test("emits narration lines for run-start, task-dispatch, and run-end", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const lines: string[] = [];
    await runDaemon(repo, { adapters: [fake], runId: "run-narr-events", narrate: (e) => lines.push(formatJournalNarration(e)) });
    // each load-bearing event is the leading token of at least one formatted narration line
    for (const required of ["run-start", "task-dispatch", "run-end"]) {
      expect(lines.some((l) => l.startsWith(required))).toBe(true);
    }
    // the stream is complete: narration saw exactly as many events as hit disk
    expect(lines.length).toBe(Journal.open(repo, "run-narr-events").read().length);
  });

  test("journal with narration enabled is byte-identical to one without it (modulo wall-clock ts)", async () => {
    // Narration is a pure side-channel: enabling it must not add, drop, reorder, or alter events.
    // The one field that genuinely cannot be held constant is `ts` — the daemon's worker-wait loop
    // polls on Date.now() (src/run/daemon.ts), so the clock can't be pinned without stalling the run.
    // Everything else is held deterministic: the SAME scripted run, the SAME runId (→ identical branch
    // refs recorded in the journal), and git author/committer dates pinned so commit SHAs (baseRef,
    // merge commit) are byte-exact too. Any remaining divergence would be narration perturbing the run,
    // not the clock.
    const prevAuthor = process.env.GIT_AUTHOR_DATE;
    const prevCommitter = process.env.GIT_COMMITTER_DATE;
    const restore = () => {
      // delete (not assign undefined) — `process.env.k = undefined` sets the literal string "undefined",
      // which git rejects as an invalid date and poisons later tests in this file.
      if (prevAuthor === undefined) delete process.env.GIT_AUTHOR_DATE; else process.env.GIT_AUTHOR_DATE = prevAuthor;
      if (prevCommitter === undefined) delete process.env.GIT_COMMITTER_DATE; else process.env.GIT_COMMITTER_DATE = prevCommitter;
    };
    process.env.GIT_AUTHOR_DATE = "2026-07-12T00:00:00Z";
    process.env.GIT_COMMITTER_DATE = "2026-07-12T00:00:00Z";
    try {
      const scripted = () => setupRepo(
        [T("T1")],
        { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
      );

      const narrated: JournalEvent[] = [];
      const on = scripted();
      await runDaemon(on.repo, { adapters: [on.fake], runId: "run-byte", narrate: (e) => narrated.push(e) });

      const off = scripted();
      await runDaemon(off.repo, { adapters: [off.fake], runId: "run-byte" });

      const maskTs = (s: string) => s.replace(/"ts":"[^"]*"/g, '"ts":"X"');
      const onFile = maskTs(readFileSync(join(tickmarkrDir(on.repo), "runs", "run-byte", "journal.jsonl"), "utf8"));
      const offFile = maskTs(readFileSync(join(tickmarkrDir(off.repo), "runs", "run-byte", "journal.jsonl"), "utf8"));
      expect(onFile).toBe(offFile); // byte-identical except the unavoidable clock
      // count parity: the narration stream saw exactly as many events as were written
      expect(narrated.length).toBe(Journal.open(on.repo, "run-byte").read().length);
    } finally {
      restore();
    }
  });

  test("a narration callback that throws does not fail the run; every event still lands in the journal", async () => {
    // reference run with NO narration captures the full, in-order event sequence for this scripted run
    const ref = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    await runDaemon(ref.repo, { adapters: [ref.fake], runId: "run-throw-ref" });
    const refEvents = Journal.open(ref.repo, "run-throw-ref").read().map((e) => e.event);

    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const s = await runDaemon(repo, {
      adapters: [fake], runId: "run-throw",
      narrate: () => { throw new Error("narration sink is broken"); },
    });
    expect(s.done).toEqual(["T1"]); // the run completed despite the throwing sink
    expect(s.failed).toEqual([]);
    // identical, in-order event sequence — nothing dropped or reordered to the throw
    expect(Journal.open(repo, "run-throw").read().map((e) => e.event)).toEqual(refEvents);
  });
}, 120000);
