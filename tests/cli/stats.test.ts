import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { collectChannelStats, stats } from "../../src/cli/commands/stats.js";
import { dispatch } from "../../src/cli/index.js";
import { narrationRow } from "../../src/cli/commands/run.js";
import { decisionEventsFromJournal, gateStates } from "../../src/cli/commands/status.js";
import { classifyFailureOutput } from "../../src/gates/baseline.js";
import type { Task } from "../../src/graph/schema.js";
import { formatJournalNarration, Journal, type JournalEvent } from "../../src/run/journal.js";
import { GATE_OUTCOME_KINDS, normalizeGateOutcome } from "../../src/run/outcome.js";
import { makeRepo } from "../helpers/tmprepo.js";

const assignment = (adapter: string, model: string) => ({ adapter, model, channel: "sub", tier: "mid" });

const rowFor = (repo: string, author: string) =>
  collectChannelStats(repo).channels.find((channel) => channel.author === author);

const TEST_TASK: Task = {
  id: "T1",
  title: "reader agreement",
  goal: "classify one gate row once",
  shape: "tests",
  complexity: 1,
  deps: [],
  files: [],
  context: [],
  acceptance: ["all readers agree"],
  gates: ["test"],
  humanGate: false,
  status: "pending",
  evidence: { commits: [], artifacts: [], gateResults: [] },
};

const gateState = (events: JournalEvent[]): string => gateStates(TEST_TASK, events)[1]!;

const gateVerdict = (event: JournalEvent): string => {
  const projected = decisionEventsFromJournal([event], "run-reader-agreement")[0];
  return projected?.type === "gate-verdict" ? projected.verdict : "missing";
};

const gateResultAsDaemonJournals = (evidence: string, details: string): Record<string, unknown> => ({
  gate: "test",
  pass: false,
  details,
  ...(classifyFailureOutput(evidence) === "infra" ? { infra: true } : {}),
});

describe("tickmarkr stats", () => {
  test("test: a channel dispatched twice and delivered once over a two-run fixture reports the dispatch and delivery counts its task-dispatch and task-done rows carry", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const first = Journal.create(repo, "run-first");
    first.append("task-dispatch", "T1", { assignment: assignment("codex", "gpt-5"), attempt: 0 });
    first.append("task-done", "T1", { assignment: assignment("codex", "gpt-5"), attempts: 1 });
    const second = Journal.create(repo, "run-second");
    second.append("task-dispatch", "T2", { assignment: assignment("codex", "gpt-5"), attempt: 0 });

    expect(rowFor(repo, "codex:gpt-5")).toMatchObject({ dispatches: 2, deliveries: 1, deliveryRate: 0.5 });
    expect(await stats([], repo)).toContain("codex:gpt-5 | — | 2 | 1 | 50%");
  });

  test("test: a channel dispatched but never delivered is reported at a zero delivery rate, so a channel that only ever failed is never omitted from the table", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const journal = Journal.create(repo, "run-red");
    journal.append("task-dispatch", "T1", { assignment: assignment("pi", "glm-5"), attempt: 0 });
    journal.append("gate-result", "T1", { gate: "test", pass: false, details: "FAIL tests/one.test.ts" });

    expect(rowFor(repo, "pi:glm-5")).toMatchObject({ dispatches: 1, deliveries: 0, deliveryRate: 0 });
    expect(await stats([], repo)).toContain("pi:glm-5 | — | 1 | 0 | 0% | —");
  });

  test("test: a task failed on one channel and delivered on another is reported as a within-task rescue naming both channels, so difficulty is controlled where a raw rate cannot", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const journal = Journal.create(repo, "run-rescue");
    journal.append("task-dispatch", "T1", { assignment: assignment("pi", "glm-5"), attempt: 0 });
    journal.append("gate-result", "T1", { gate: "test", pass: false, attempt: 0, details: "FAIL tests/one.test.ts" });
    journal.append("task-dispatch", "T1", { assignment: assignment("codex", "gpt-5"), attempt: 1 });
    journal.append("gate-result", "T1", { gate: "review", pass: true, attempt: 1, details: "reviewer claude-code:sonnet (anthropic): approved" });
    journal.append("task-done", "T1", { assignment: assignment("codex", "gpt-5"), attempts: 2 });

    const delivered = rowFor(repo, "codex:gpt-5");
    expect(delivered?.reviewers).toEqual(["claude-code:sonnet"]);
    expect(delivered?.rescues).toEqual(["pi:glm-5 → codex:gpt-5 (run-rescue/T1)"]);
    expect(await stats([], repo)).toContain("pi:glm-5 → codex:gpt-5");
  });

  test("test: a run whose only red carried an infra fingerprint reports zero real reds against one infra red, using the classifier the gate itself applies", () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const journal = Journal.create(repo, "run-infra");
    const fingerprint = "Error: spawn EAGAIN";
    journal.append("task-dispatch", "T1", { assignment: assignment("codex", "gpt-5"), attempt: 0 });
    journal.append("gate-result", "T1", {
      ...gateResultAsDaemonJournals(fingerprint, `exit 1; the runner never completed a suite:\n${fingerprint}`),
      attempt: 0,
    });

    expect(rowFor(repo, "codex:gpt-5")).toMatchObject({ realReds: 0, infraReds: 1 });
  });

  test("test: a held selected-test screen is classified identically by the journal and statistics surfaces and by the rendering surfaces, so one row yields one kind everywhere", () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const journal = Journal.create(repo, "run-held-reader-agreement");
    journal.append("task-dispatch", "T1", { assignment: assignment("codex", "gpt-5"), attempt: 0 });
    journal.append("gate-result", "T1", {
      gate: "test",
      pass: true,
      selectedTests: ["tests/cli/stats.test.ts"],
      details: "exit 0 on the selected subset",
    });
    const events = journal.read();
    const gate = events.find((event) => event.event === "gate-result")!;

    expect(normalizeGateOutcome(gate.data).kind).toBe("held");
    expect(formatJournalNarration(gate)).toBe("gate-result — T1 — test selected-test screen");
    expect(narrationRow(gate, journal.runId, 160)).toContain("test selected-test screen");
    expect(gateVerdict(gate)).toBe("unknown");
    expect(gateState(events)).toBe("open");
    expect(rowFor(repo, "codex:gpt-5")).toMatchObject({ realReds: 0, infraReds: 0 });
  });

  test("test: the literal vitest worker onTaskUpdate timeout fingerprint classifies identically under every shipped reader, so the fingerprint forgiven at the release gate is not one the product charges", () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const journal = Journal.create(repo, "run-timeout-reader-agreement");
    const fingerprint = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"';
    expect(classifyFailureOutput(fingerprint)).toBe("infra");
    journal.append("task-dispatch", "T1", { assignment: assignment("codex", "gpt-5"), attempt: 0 });
    journal.append("gate-result", "T1", {
      ...gateResultAsDaemonJournals(
        fingerprint,
        `exit 1; the fresh failures carry infrastructure evidence alone — the runner never completed a suite, so this gate verified nothing:\n${fingerprint}`,
      ),
    });
    const events = journal.read();
    const gate = events.find((event) => event.event === "gate-result")!;
    const channel = rowFor(repo, "codex:gpt-5");

    expect(normalizeGateOutcome(gate.data).kind).toBe("infra");
    expect(gate.data).not.toHaveProperty("fingerprints");
    expect(gate.data).not.toHaveProperty("retryable");
    expect(formatJournalNarration(gate)).toBe("gate-result — T1 — test");
    expect(narrationRow(gate, journal.runId, 160)).not.toContain("test failed");
    expect(gateVerdict(gate)).toBe("unknown");
    expect(gateState(events)).toBe("open");
    expect(channel).toMatchObject({ realReds: 0, infraReds: 1 });
  });

  test("the diff adds no second discriminator and leaves the accessor's exported kind list unchanged", () => {
    expect([...GATE_OUTCOME_KINDS]).toEqual([
      "passed", "failed", "skipped", "declined", "held", "unavailable", "infra",
    ]);

    const journalSource = readFileSync(join(import.meta.dirname, "..", "..", "src", "run", "journal.ts"), "utf8");
    const journalProjection = journalSource.slice(
      journalSource.indexOf("const journalGateDetail"),
      journalSource.indexOf("export function formatJournalNarration"),
    );
    const statsSource = readFileSync(join(import.meta.dirname, "..", "..", "src", "cli", "commands", "stats.ts"), "utf8");

    expect(journalProjection).toContain("normalizeGateOutcome(data).kind");
    expect(statsSource).toContain("normalizeGateOutcome(event.data)");
    expect(statsSource).not.toContain("classifyFailureOutput");
  });

  test("test: stats over an empty state directory exits zero reporting no channels, so an absent directory is a lawful zero rather than a failure", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const stateDir = join(repo, ".tickmarkr");
    expect(existsSync(stateDir)).toBe(false);

    const result = await dispatch("stats", [], { stats: (argv) => stats(argv, repo) });
    expect(result).toEqual({ out: "tickmarkr stats — 0 runs\nno channels", code: 0 });
    expect(existsSync(stateDir)).toBe(false);
  });
});
