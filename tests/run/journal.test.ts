import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { channelKey } from "../../src/adapters/types.js";
import { ATTEMPT_CAP_RELEASE, appendProfileDiscount, engagementComparable, formatJournalNarration, gateResultJournalData, Journal, newRunId, parseRunId, readAllTelemetry, readProfileDiscounts, recordedGraphDefinitionHash, TelemetryRowSchema } from "../../src/run/journal.js";

// Phase 46 (RES-01/RES-02 derivation half): the verbatim vendored incident fixture — a line subset of
// run-20260711-185020 quoted at plan time, never regenerated from the live .tickmarkr tree.
const INCIDENT_FIX = join(import.meta.dirname, "..", "fixtures", "resume-replay", "incident-P43-03.jsonl");
const midA = (adapter: string, model: string) => ({ adapter, model, channel: "sub" as const, tier: "mid" as const });

const v15row = { taskId: "T1", shape: "implement", adapter: "fake", model: "fake-1", channel: "sub", attempts: 1, outcome: "done", durationMs: 12 };

describe("journal", () => {
  test("newRunId shape", () => {
    expect(newRunId()).toMatch(/^run-\d{8}-\d{6}$/);
  });

  describe("parseRunId (Sol #4: strict journal path component)", () => {
    test("a run id containing a path separator is rejected", () => {
      expect(() => parseRunId("run-foo/bar")).toThrow(/invalid run id/i);
      expect(() => parseRunId("run-foo\\bar")).toThrow(/invalid run id/i);
      expect(() => Journal.create(mkdtempSync(join(tmpdir(), "tickmarkr-j-")), "../escape")).toThrow(/invalid run id/i);
    });

    test("a run id containing a dot-segment is rejected", () => {
      expect(() => parseRunId("..")).toThrow(/invalid run id/i);
      expect(() => parseRunId(".")).toThrow(/invalid run id/i);
      expect(() => parseRunId("run-foo/..")).toThrow(/invalid run id/i);
    });

    test("an empty run id is rejected", () => {
      expect(() => parseRunId("")).toThrow(/invalid run id/i);
      expect(() => parseRunId("   ")).toThrow(/invalid run id/i);
    });

    test("fresh create refuses a run id whose journal already exists", () => {
      const dir = mkdtempSync(join(tmpdir(), "tickmarkr-j-"));
      const j = Journal.create(dir, "run-20260717-120000");
      j.append("run-start");
      expect(() => Journal.create(dir, "run-20260717-120000")).toThrow(/journal already exists/i);
    });

    test("a well-formed run id opens and creates exactly as today", () => {
      const dir = mkdtempSync(join(tmpdir(), "tickmarkr-j-"));
      const created = Journal.create(dir, "run-20260707-010101");
      created.append("run-start", undefined, { baseRef: "abc" });
      const opened = Journal.open(dir, "run-20260707-010101");
      expect(opened.runId).toBe("run-20260707-010101");
      expect(opened.read()).toEqual(created.read());
      // mkdir-only dir (no journal yet) still accepts a fresh create
      Journal.create(dir, "run-20260707-030303");
      expect(() => Journal.open(dir, "run-20260707-030303")).toThrow(/no journal/i);
    });
  });

  test("recordedGraphDefinitionHash and engagementComparable (T3 engagement identity)", () => {
    const withHash = [{ ts: "t", event: "run-start", data: { graphDefinitionHash: "abc" } }];
    const without = [{ ts: "t", event: "run-start", data: { baseRef: "x" } }];
    expect(recordedGraphDefinitionHash(withHash)).toBe("abc");
    expect(recordedGraphDefinitionHash(without)).toBeUndefined();
    expect(engagementComparable(withHash, "abc")).toEqual({ comparable: true, recorded: "abc" });
    expect(engagementComparable(withHash, "other")).toEqual({ comparable: false, reason: "mismatch", recorded: "abc" });
    expect(engagementComparable(without, "abc")).toEqual({ comparable: false, reason: "unbound" });
  });

  test("append/read round-trip with ts and data", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-j-"));
    const j = Journal.create(dir, "run-1");
    j.append("run-start", undefined, { baseRef: "abc" });
    j.append("task-dispatch", "T1", { adapter: "fake" });
    const evs = j.read();
    expect(evs).toHaveLength(2);
    expect(evs[0].event).toBe("run-start");
    expect(evs[0].data.baseRef).toBe("abc");
    expect(evs[1].taskId).toBe("T1");
    expect(Date.parse(evs[0].ts)).toBeGreaterThan(0);
  });

  test("optional narration receives persisted rows without changing bytes or replay, and cannot break append", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-12T00:00:00.000Z"));
      const root = mkdtempSync(join(tmpdir(), "tickmarkr-j-"));
      const silent = Journal.create(root, "run-silent");
      const narrated: ReturnType<typeof silent.read> = [];
      const spoken = Journal.create(root, "run-spoken", (event) => narrated.push(event));
      const assignment = midA("fake", "fake-1");

      silent.append("task-dispatch", "T1", { assignment, attempt: 0 });
      spoken.append("task-dispatch", "T1", { assignment, attempt: 0 });

      expect(readFileSync(join(silent.dir, "journal.jsonl"), "utf8")).toBe(readFileSync(join(spoken.dir, "journal.jsonl"), "utf8"));
      expect(narrated).toEqual(spoken.read());
      expect([...spoken.replayStatuses()]).toEqual([...silent.replayStatuses()]);
      expect([...spoken.replayResumeState()]).toEqual([...silent.replayResumeState()]);

      let calls = 0;
      const broken = Journal.create(root, "run-broken", () => {
        calls++;
        throw new Error("narration failed");
      });
      expect(() => broken.append("run-start")).not.toThrow();
      expect(calls).toBe(1);
      expect(broken.read()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("narration format is concise and includes event, task, and detail", () => {
    expect(formatJournalNarration({
      ts: "2026-07-12T00:00:00.000Z", event: "gate-result", taskId: "T1",
      data: { gate: "test", pass: true, details: "verbose output omitted" },
    })).toBe("gate-result — T1 — test passed");
    expect(formatJournalNarration({
      ts: "2026-07-12T00:00:00.000Z", event: "run-resume", data: { pid: 42 },
    })).toBe("run-resume — pid 42");
  });

  test("replayStatuses: interrupted running task returns to pending", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-j-"));
    const j = Journal.create(dir, "run-1");
    j.append("task-dispatch", "T1");
    j.append("task-done", "T1");
    j.append("task-dispatch", "T2"); // interrupted — no terminal event
    j.append("task-dispatch", "T3");
    j.append("task-human", "T3");
    const s = j.replayStatuses();
    expect(s.get("T1")).toBe("done");
    expect(s.get("T2")).toBe("pending");
    expect(s.get("T3")).toBe("human");
  });

  test("read tolerates corrupt trailing line", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-j-"));
    const j = Journal.create(dir, "run-1");
    j.append("run-start");
    appendFileSync(join(j.dir, "journal.jsonl"), '{"ts":"2026-'); // torn write
    expect(j.read()).toHaveLength(1);
  });

  test("open throws on missing run; latestRunId picks newest", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-j-"));
    expect(() => Journal.open(dir, "run-nope")).toThrow(/no journal/i);
    Journal.create(dir, "run-20260707-010101").append("run-start");
    Journal.create(dir, "run-20260707-020202").append("run-start");
    expect(Journal.latestRunId(dir)).toBe("run-20260707-020202");
    // a run dir mkdir'd by Journal.create but not yet appended to has no journal.jsonl — withJournal
    // callers (status, report) fall back to the newest readable run instead of a runId Journal.open
    // rejects; the raw default still sees it (profile's telemetry cursor semantics)
    Journal.create(dir, "run-20260707-030303");
    expect(Journal.latestRunId(dir)).toBe("run-20260707-030303");
    expect(Journal.latestRunId(dir, { withJournal: true })).toBe("run-20260707-020202");
  });

  // GATE-08 (v1.12): task-approved is a journal EVENT. Events replay in order, so task-human →
  // task-approved lands on pending (last write wins). RED on HEAD: unknown event ignored → stays "human".
  test("replayStatuses: task-approved after task-human replays to pending (GATE-08)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-j-"));
    const j = Journal.create(dir, "run-1");
    j.append("task-human", "T1");
    j.append("task-approved", "T1", { by: "test" });
    expect(j.replayStatuses().get("T1")).toBe("pending");
  });

  // D-04 compat pin: an approval-free journal replays byte-identically to today; an unknown event type
  // is ignored, not crashed on. Green on both sides by design — reddens only if the new branch is
  // implemented by restructuring the mapping instead of appending one additive else-if.
  test("replayStatuses (D-04): an approval-free journal replays identically; unknown events never crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-j-"));
    const j = Journal.create(dir, "run-1");
    j.append("task-dispatch", "T1");
    j.append("task-done", "T1");
    j.append("task-dispatch", "T2");
    j.append("task-human", "T2");
    j.append("some-future-event", "T2", { whatever: 1 }); // unknown event type — ignored, never crashes
    const s = j.replayStatuses();
    expect(s.get("T1")).toBe("done");
    expect(s.get("T2")).toBe("human"); // last write is task-human (no task-approved) ⇒ unchanged
  });

  // GATE-09 (ROADMAP SC-4 second half): the judge-retry event is INERT to BOTH replay readers — a journal
  // containing it produces output identical to the same journal without it, through replayStatuses() AND
  // replayResumeState() (attempts uninflated). Extends the unknown-event pin above, not the corpus oracle.
  // GREEN by construction on HEAD — pins the event against ever becoming dispatch-shaped (research
  // anti-pattern: a judge retry must never bill the worker an attempt on resume — Phase 46 non-interaction).
  test("replay inertness (SC-4): judge-retry is invisible to replayStatuses AND replayResumeState", () => {
    const mk = (withEvent: boolean) => {
      const j = Journal.create(mkdtempSync(join(tmpdir(), "tickmarkr-j-")), "run-1");
      j.append("run-start", undefined, { baseRef: "abc" });
      j.append("task-dispatch", "T1", { assignment: midA("fake", "fake-1"), attempt: 0 });
      if (withEvent) j.append("judge-retry", "T1", { gate: "acceptance", flaked: "a:b", retried: "c:d" });
      j.append("task-done", "T1", { attempts: 1, assignment: midA("fake", "fake-1") });
      return j;
    };
    const withEvt = mk(true);
    const without = mk(false);
    // replayStatuses: identical (judge-retry falls through the switch — not dispatch/done/failed/human/approved)
    expect([...withEvt.replayStatuses()]).toEqual([...without.replayStatuses()]);
    // replayResumeState: identical, including attempts (judge-retry is NOT task-dispatch — attempts uninflated)
    const rw = withEvt.replayResumeState().get("T1")!;
    const ro = without.replayResumeState().get("T1")!;
    expect(rw.attempts).toBe(ro.attempts);
    expect(rw.attempts).toBe(1); // Phase 46 non-interaction: one dispatch ⇒ one attempt; the retry adds nothing
    expect(rw.tried).toEqual(ro.tried);
    expect(channelKey(rw.lastAssignment!)).toBe(channelKey(ro.lastAssignment!));
  });

  test("telemetry rows round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-j-"));
    const j = Journal.create(dir, "run-1");
    j.telemetry({ taskId: "T1", shape: "implement", adapter: "fake", model: "fake-1", channel: "sub", attempts: 1, outcome: "done", durationMs: 12 });
    expect(j.readTelemetry()[0].shape).toBe("implement");
    appendFileSync(join(j.dir, "telemetry.jsonl"), '{"taskId":"T2"');
    expect(j.readTelemetry()).toHaveLength(1);
  });
});

describe("TelemetryRowSchema (TEL-03: absent ≠ false)", () => {
  test("v1.5 row parses; new fields are undefined, provably not false/0", () => {
    const r = TelemetryRowSchema.safeParse(v15row);
    expect(r.success).toBe(true);
    const row = r.data!;
    expect(row.firstAttemptOk).toBeUndefined();
    expect(row.firstAttemptOk).not.toBe(false);
    expect(row.gateFails).toBeUndefined();
    expect(row.gateFails).not.toBe(0);
    expect(row.consults).toBeUndefined();
    expect(row.consults).not.toBe(0);
    expect(row.parkKind).toBeUndefined();
    expect(row.tokens).toBeUndefined(); // v1.7 SPEND-02: absent = unmetered, never {input:0,...}
  });

  test("v1.7 SPEND-02: malformed tokens degrades to undefined (.catch fail-open), row survives", () => {
    // a metering bug must never safeParse-drop a row from profile derivation — the .catch keeps the row.
    const r = TelemetryRowSchema.safeParse({ ...v15row, tokens: { input: "garbage" } });
    expect(r.success).toBe(true);
    expect(r.data!.tokens).toBeUndefined();
  });

  test("forward-additivity (A1): a row with an unknown extra field still parses", () => {
    const r = TelemetryRowSchema.safeParse({ ...v15row, futureField: 1 });
    expect(r.success).toBe(true);
  });

  test("missing core field fails (core required)", () => {
    const { outcome: _outcome, ...noOutcome } = v15row;
    expect(TelemetryRowSchema.safeParse(noOutcome).success).toBe(false);
  });

  test("bad parkKind rejected (closed enum)", () => {
    expect(TelemetryRowSchema.safeParse({ ...v15row, parkKind: "made-up-kind" }).success).toBe(false);
  });

  test("TEL-05 absent≠false: a row without quotaFailover parses with the field undefined, never false", () => {
    const r = TelemetryRowSchema.safeParse(v15row);
    expect(r.success).toBe(true);
    expect(r.data!.quotaFailover).toBeUndefined();
    expect(r.data!.quotaFailover).not.toBe(false); // guards a schema-level ?? false poisoning (DECISIONS #92)
  });

  test("TEL-05 literal(true): true accepted, false rejected (false is unrepresentable)", () => {
    expect(TelemetryRowSchema.safeParse({ ...v15row, quotaFailover: true }).success).toBe(true);
    expect(TelemetryRowSchema.safeParse({ ...v15row, quotaFailover: false }).success).toBe(false);
  });
});

describe("readAllTelemetry (TEL-04: cross-run reader)", () => {
  const writeRun = (root: string, runId: string, lines: string[]) => {
    const dir = join(root, ".tickmarkr", "runs", runId);
    mkdirSync(dir, { recursive: true });
    for (const l of lines) appendFileSync(join(dir, "telemetry.jsonl"), l + "\n");
    return dir;
  };

  test("window + runId tagging: last K runs only, each row tagged", () => {
    const root = mkdtempSync(join(tmpdir(), "tickmarkr-rat-"));
    writeRun(root, "run-20260101-000000", [JSON.stringify({ ...v15row, taskId: "old" })]);
    writeRun(root, "run-20260102-000000", [JSON.stringify({ ...v15row, taskId: "mid" })]);
    writeRun(root, "run-20260103-000000", [JSON.stringify({ ...v15row, taskId: "new" })]);
    const rows = readAllTelemetry(root, 2);
    expect(rows.map((r) => r.taskId).sort()).toEqual(["mid", "new"]);
    expect(rows.find((r) => r.taskId === "mid")!.runId).toBe("run-20260102-000000");
    expect(rows.find((r) => r.taskId === "old")).toBeUndefined();
  });

  test("torn line + garbage row dropped, valid rows kept, no throw", () => {
    const root = mkdtempSync(join(tmpdir(), "tickmarkr-rat-"));
    const dir = writeRun(root, "run-20260101-000000", [
      JSON.stringify(v15row),
      JSON.stringify({ ...v15row, taskId: "t2", firstAttemptOk: true, parkKind: "stall" }),
      JSON.stringify({ nope: 1 }),
    ]);
    appendFileSync(join(dir, "telemetry.jsonl"), '{"taskId":"t3","sh');
    const rows = readAllTelemetry(root, 5);
    expect(rows.map((r) => r.taskId).sort()).toEqual(["T1", "t2"]);
    expect(rows.find((r) => r.taskId === "t2")!.firstAttemptOk).toBe(true);
  });

  test("TEL-05 fixture-compat: a pre-v1.8 row (no quotaFailover key) parses with the field undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "tickmarkr-rat-"));
    writeRun(root, "run-20260101-000000", [JSON.stringify(v15row)]); // pre-v1.8 shape, no quotaFailover key
    const rows = readAllTelemetry(root, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].quotaFailover).toBeUndefined();
  });

  test("run dir with no telemetry.jsonl contributes zero rows; no runs → []", () => {
    const root = mkdtempSync(join(tmpdir(), "tickmarkr-rat-"));
    mkdirSync(join(root, ".tickmarkr", "runs", "run-20260101-000000"), { recursive: true });
    expect(readAllTelemetry(root, 5)).toEqual([]);
    const bare = mkdtempSync(join(tmpdir(), "tickmarkr-rat-"));
    expect(readAllTelemetry(bare, 5)).toEqual([]);
  });
});

// Phase 46 (RES-01/RES-02 derivation half): replayResumeState derives per-task resume state
// {attempts, tried, lastAssignment} from events the journal ALREADY records (task-dispatch +
// consult-verdict). RED on HEAD — the method does not exist yet; the tests below pin the contract.
describe("replayResumeState (Phase 46 derivation)", () => {
  const loadIncident = () => {
    const j = Journal.create(mkdtempSync(join(tmpdir(), "tickmarkr-j-")), "run-1");
    writeFileSync(join(j.dir, "journal.jsonl"), readFileSync(INCIDENT_FIX, "utf8"));
    return j;
  };

  test("verbatim incident fixture (run-20260711-185020 P43-03): attempts=5, ordered tried, cursor-agent lastAssignment", () => {
    const st = loadIncident().replayResumeState().get("P43-03")!;
    expect(st.attempts).toBe(5);
    expect(st.tried).toEqual(["pi:zai/glm-5.2", "cursor-agent:composer-2.5"]); // ORDER asserted
    expect(st.lastAssignment).toBeDefined();
    expect(channelKey(st.lastAssignment!)).toBe("cursor-agent:composer-2.5");
    expect(st.lastAssignment!.tier).toBe("mid");
  });

  // Pitfall 2: attempts is a COUNT of task-dispatch events, never max(data.attempt)+1. Existing
  // journals' post-resume dispatches restart at 0 (the bug corrupted its own evidence, incident L58).
  test("attempts is a COUNT of dispatches, never max(data.attempt)+1", () => {
    const j = Journal.create(mkdtempSync(join(tmpdir(), "tickmarkr-j-")), "run-1");
    const a = midA("pi", "glm");
    j.append("task-dispatch", "T1", { assignment: a, attempt: 0 });
    j.append("task-dispatch", "T1", { assignment: a, attempt: 1 });
    j.append("task-dispatch", "T1", { assignment: a, attempt: 0 }); // post-resume restart at 0
    expect(j.replayResumeState().get("T1")!.attempts).toBe(3); // max+1 would yield 2
  });

  test("tried dedups consecutive retries on the same channel", () => {
    const j = Journal.create(mkdtempSync(join(tmpdir(), "tickmarkr-j-")), "run-1");
    const a = midA("pi", "glm");
    for (let i = 0; i < 4; i++) j.append("task-dispatch", "T1", { assignment: a, attempt: i });
    const st = j.replayResumeState().get("T1")!;
    expect(st.tried).toHaveLength(1);
    expect(st.attempts).toBe(4);
  });

  // Trailing-reroute edge (D-01 kill between verdict and dispatch): a reroute verdict as the task's
  // last event bans the last-dispatched channel and clears lastAssignment (no dispatch acted on it).
  test("trailing reroute bans the last-dispatched channel and clears lastAssignment", () => {
    const j = Journal.create(mkdtempSync(join(tmpdir(), "tickmarkr-j-")), "run-1");
    const B = midA("claude-code", "sonnet");
    j.append("task-dispatch", "T1", { assignment: midA("codex", "gpt-5"), attempt: 0 });
    j.append("task-dispatch", "T1", { assignment: B, attempt: 1 });
    j.append("consult-verdict", "T1", { action: "reroute", notes: "ban B" });
    const st = j.replayResumeState().get("T1")!;
    expect(st.tried).toContain(channelKey(B));
    expect(st.lastAssignment).toBeUndefined();
  });

  // A retry verdict in the trailing position bans nothing and clears nothing (reroute-only rule, D-03).
  test("trailing retry bans nothing and clears nothing", () => {
    const j = Journal.create(mkdtempSync(join(tmpdir(), "tickmarkr-j-")), "run-1");
    const A = midA("codex", "gpt-5");
    const B = midA("claude-code", "sonnet");
    j.append("task-dispatch", "T1", { assignment: A, attempt: 0 });
    j.append("task-dispatch", "T1", { assignment: B, attempt: 1 });
    j.append("consult-verdict", "T1", { action: "retry", notes: "same channel" });
    const st = j.replayResumeState().get("T1")!;
    expect(channelKey(st.lastAssignment!)).toBe(channelKey(B));
    expect(st.tried).toEqual([channelKey(A), channelKey(B)]); // retry adds nothing
  });

  // Fail-closed parsing (repo invariant): a malformed assignment still COUNTS toward attempts but
  // contributes nothing to tried; a malformed LAST dispatch makes lastAssignment undefined. Never throws.
  test("malformed assignment fails closed: counts toward attempts, absent from tried, poisons only lastAssignment", () => {
    const j = Journal.create(mkdtempSync(join(tmpdir(), "tickmarkr-j-")), "run-1");
    const A = midA("codex", "gpt-5");
    j.append("task-dispatch", "T1", { assignment: A, attempt: 0 });
    j.append("task-dispatch", "T1", { assignment: "garbage", attempt: 1 }); // malformed
    const st = j.replayResumeState().get("T1")!;
    expect(st.attempts).toBe(2);
    expect(st.tried).toEqual([channelKey(A)]);
    expect(st.lastAssignment).toBeUndefined();
  });

  test("a task with no dispatch events has no resume-state entry", () => {
    const j = Journal.create(mkdtempSync(join(tmpdir(), "tickmarkr-j-")), "run-1");
    j.append("run-start");
    j.append("task-human", "T1");
    expect(j.replayResumeState().has("T1")).toBe(false);
  });

  // v1.24 OBS-18: task-approved{release:attempt-cap} grants a fresh attempt budget on resume.
  // attempts zeroed; tried survives (consult bans / burned channels); lastAssignment cleared so the
  // daemon's nextChannel-over-tried path skips burned channels first. Pre-v1.24 task-approved (no
  // release key) is inert — status still pending, resume attempts unchanged.
  test("v1.24: task-approved release:attempt-cap zeros attempts, keeps tried, clears lastAssignment", () => {
    const j = Journal.create(mkdtempSync(join(tmpdir(), "tickmarkr-j-")), "run-1");
    const A = midA("fake", "fake-1");
    const B = midA("fake", "fake-2");
    for (let i = 0; i < 10; i++) j.append("task-dispatch", "T1", { assignment: A, attempt: i });
    j.append("consult-verdict", "T1", { action: "reroute", notes: "ban A" });
    j.append("task-dispatch", "T1", { assignment: B, attempt: 10 });
    j.append("task-human", "T1", { reason: "attempt cap (10) reached" });
    // without release: attempts === 11 (count of dispatches), lastAssignment = B
    const before = j.replayResumeState().get("T1")!;
    expect(before.attempts).toBe(11);
    expect(before.tried).toEqual([channelKey(A), channelKey(B)]);
    expect(channelKey(before.lastAssignment!)).toBe(channelKey(B));

    j.append("task-approved", "T1", { by: "op", release: ATTEMPT_CAP_RELEASE });
    const st = j.replayResumeState().get("T1")!;
    expect(st.attempts).toBe(0); // fresh budget — daemon will not re-park at the cap
    expect(st.tried).toEqual([channelKey(A), channelKey(B)]); // burned channels remembered
    expect(st.lastAssignment).toBeUndefined(); // force nextChannel over tried
    // status replay still maps task-approved → pending (GATE-08, unchanged)
    expect(j.replayStatuses().get("T1")).toBe("pending");
  });

  test("v1.24: pre-v1.24 task-approved (no release key) is inert to resume attempts", () => {
    const j = Journal.create(mkdtempSync(join(tmpdir(), "tickmarkr-j-")), "run-1");
    const A = midA("fake", "fake-1");
    for (let i = 0; i < 10; i++) j.append("task-dispatch", "T1", { assignment: A, attempt: i });
    j.append("task-human", "T1", { reason: "attempt cap (10) reached" });
    j.append("task-approved", "T1", { by: "op", via: "cli" }); // GATE-08 shape, no release
    const st = j.replayResumeState().get("T1")!;
    expect(st.attempts).toBe(10); // NOT zeroed — pre-v1.24 corpus outcome-identical
    expect(st.tried).toEqual([channelKey(A)]);
    expect(channelKey(st.lastAssignment!)).toBe(channelKey(A));
    expect(j.replayStatuses().get("T1")).toBe("pending"); // status mapping still works
  });
});

describe("T5 signalQuality telemetry", () => {
  test("new gate rows carry signalQuality telemetry", () => {
    const testRow = gateResultJournalData("test", true, "exit 0");
    expect(testRow.signalQuality).toBe(1);
    expect(testRow.signalBasis).toBe("proved");
    const acceptRow = gateResultJournalData("acceptance", true, "judge ok");
    expect(acceptRow.signalQuality).toBe(0.5);
    expect(acceptRow.signalBasis).toBe("judge-only");
    const reviewRow = gateResultJournalData("review", true, "ok", { reviewer: "claude-code:fable" });
    expect(reviewRow.signalQuality).toBe(0.75);
    expect(reviewRow.signalBasis).toBe("review-agree");
    const skipped = gateResultJournalData("review", true, "skipped", { skipped: true });
    expect(skipped.signalQuality).toBe(0);
    expect(skipped.signalBasis).toBe("skipped");
  });

  test("TelemetryRowSchema accepts optional signalQuality", () => {
    const parsed = TelemetryRowSchema.safeParse({
      ...v15row, signalQuality: 0.5, signalBasis: "judge-only",
    });
    expect(parsed.success).toBe(true);
    expect(TelemetryRowSchema.safeParse(v15row).success).toBe(true); // legacy rows unchanged
  });
});

describe("T5 profile-discounts state file", () => {
  test("readProfileDiscounts returns [] when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-j-"));
    expect(readProfileDiscounts(dir)).toEqual([]);
  });

  test("appendProfileDiscount round-trips run and task marks", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-j-"));
    appendProfileDiscount(dir, { runId: "run-20200101-000000", weight: 0, reason: "vacuous" });
    appendProfileDiscount(dir, { runId: "run-20200102-000000", taskId: "T2", weight: 0.5, reason: "OBS-51" });
    expect(readProfileDiscounts(dir)).toEqual([
      { runId: "run-20200101-000000", weight: 0, reason: "vacuous" },
      { runId: "run-20200102-000000", taskId: "T2", weight: 0.5, reason: "OBS-51" },
    ]);
  });
});
