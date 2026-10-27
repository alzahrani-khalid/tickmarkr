// Queue row 225 (D-2111): a resume whose graph statuses were reset restores a task parked undecided at
// its review round cap and re-parks it at the same cap with nothing between. failedGateBeforePark lets
// that re-park inherit its predecessor's failed gate (so every surface offers, and approve binds, the
// same verbs), and a restore names upheld feedback only when an effective approval funded it.
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { approve, newestPark, parkToken, permittedDecisionVerbs, readJournalEvents } from "../../src/cli/commands/approve.js";
import { status } from "../../src/cli/commands/status.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { graphDefinitionHash, loadGraph, saveGraph, setStatus } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { foldDecisions, GATE_SATISFIED_RELEASE, Journal, RECHECK_RELEASE, REVIEW_UPHELD_RELEASE, reviewRoundsSinceApproval, type JournalEvent } from "../../src/run/journal.js";
import { deriveRunDecisions } from "../../src/tui/cockpit/decision-actions.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const VERBS = { uphold: REVIEW_UPHELD_RELEASE, waive: GATE_SATISFIED_RELEASE, recheck: RECHECK_RELEASE } as const;
type Verb = keyof typeof VERBS;

interface RePark { repo: string; scriptPath: string; runId: string; journalPath: string; bytes: string }

async function reParkScenario(): Promise<RePark> {
  const runId = "run-repark-cap";
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })],
    {
      review: { approve: false, issues: ["stat tile mislabeled"] },
      tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
    },
    "visibility: { keepPanes: forever }\n",
  );
  expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
  // The status reset: a pending graph.json edit beats the replayed park, so the resume restores T1 undecided.
  saveGraph(repo, setStatus(loadGraph(repo), "T1", "pending"));
  expect((await runDaemon(repo, { adapters: [new FakeAdapter(scriptPath)], runId, resume: true })).human).toEqual(["T1"]);
  const journalPath = join(Journal.open(repo, runId).dir, "journal.jsonl");
  return { repo, scriptPath, runId, journalPath, bytes: readFileSync(journalPath, "utf8") };
}

const parkIndexes = (events: readonly JournalEvent[], taskId = "T1"): number[] =>
  events.flatMap((e, i) => e.event === "task-human" && e.taskId === taskId ? [i] : []);

const approvalRows = (events: readonly JournalEvent[]): number[] =>
  events.flatMap((e, i) => e.event === "task-approved" ? [i] : []);

/** Run one decision on a journal reset to `bytes`; the appended row, or the refusal message. */
async function decide(repo: string, runId: string, journalPath: string, bytes: string, flags: string[]): Promise<{ row?: JournalEvent; line?: number; events: JournalEvent[]; refused?: string }> {
  writeFileSync(journalPath, bytes);
  const before = approvalRows(Journal.open(repo, runId).read()).length;
  try {
    await approve([runId, "T1", ...flags, "--by", "operator"], repo);
  } catch (error) {
    const events = Journal.open(repo, runId).read();
    expect(approvalRows(events).length).toBe(before); // a refusal appends nothing
    return { events, refused: error instanceof Error ? error.message : String(error) };
  }
  const { events, lines } = Journal.open(repo, runId).readSourced();
  const at = approvalRows(events);
  expect(at.length).toBe(before + 1);
  return { row: events[at.at(-1)!], line: lines[at.at(-1)!], events };
}

// A review-only third seat, as in review-uphold.test.ts: the funded attempt may author on either fake
// vendor, so the cross-vendor review needs a seat that never authored.
function reviewOnlySeat(repo: string, scriptPath: string): FakeAdapter {
  const configPath = join(repo, ".tickmarkr", "config.yaml");
  const config = parseYaml(readFileSync(configPath, "utf8"));
  config.routing ??= {};
  config.routing.deny ??= {};
  config.routing.deny.workers ??= {};
  config.routing.deny.workers.adapters = [...new Set([...(config.routing.deny.workers.adapters ?? []), "third-review"])];
  writeFileSync(configPath, stringifyYaml(config));
  const seat = new FakeAdapter(scriptPath);
  seat.id = "third-review";
  seat.vendor = "third-vendor";
  seat.probe = async () => ({ installed: true, authed: true, version: "fake", models: [seat.id],
    modelAuth: { [seat.id]: { authed: true, probedAt: "2026-07-16T00:00:00.000Z" } } });
  seat.channels = () => [{ adapter: seat.id, model: seat.id, vendor: seat.vendor, channel: "api", tier: "frontier" }];
  seat.headlessCommand = (file) => {
    const prompt = readFileSync(file, "utf8");
    const prior = [...prompt.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]);
    const { review } = JSON.parse(readFileSync(scriptPath, "utf8"));
    return `printf '%s\\n' ${shq(JSON.stringify({ ...review, nonce: extractPromptNonce(prompt),
      resolved: review.approve ? prior : [], reraised: review.approve ? [] : prior }))}`;
  };
  return seat;
}

describe("the daemon-written re-park at the review round cap (queue row 225)", () => {
  let s: RePark;
  beforeAll(async () => { s = await reParkScenario(); }, 240_000);

  test("test: a review-cap park the daemon wrote, resumed undecided after a status reset, is re-parked with only run-end, run-resume and resume-restore between, and on that newest park approve with uphold, waive and recheck each binds one release to its line that the journal's decision fold counts effective, so a re-park refusing every verb or binding the older park fails", async () => {
    const { events, lines } = Journal.open(s.repo, s.runId).readSourced();
    const [older, newer, ...more] = parkIndexes(events);
    expect(more).toEqual([]);
    // the older park's own approval window closes it out; past that, only the run's end, resume and restore
    const between = events.slice(older! + 1, newer).map((e) => e.event);
    expect(between.slice(0, 2)).toEqual(["approval-window-start", "approval-window-expired"]);
    expect(between.slice(2)).toEqual(["run-end", "run-resume", "resume-restore"]);
    expect(events[newer!]!.data.kind).toBe("gate-fail");
    const park = newestPark(events, "T1")!;
    expect(park.index).toBe(newer);
    expect(park.failedGate).toBe("review");
    expect(permittedDecisionVerbs(park)).toEqual(["waive", "uphold", "recheck"]);
    const newest = { line: lines[newer!]!, ts: events[newer!]!.ts };
    const oldest = { line: lines[older!]!, ts: events[older!]!.ts };
    for (const verb of Object.keys(VERBS) as Verb[]) {
      const { row, line, events: after } = await decide(s.repo, s.runId, s.journalPath, s.bytes, [`--${verb}`]);
      expect(row?.data.release, verb).toBe(VERBS[verb]);
      expect(row!.data.park, verb).toEqual(newest);
      expect(row!.data.park, verb).not.toEqual(oldest);
      expect(foldDecisions(after).effective.has(line!), verb).toBe(true);
    }
    // the older park's token is stale: nothing binds to it
    const stale = await decide(s.repo, s.runId, s.journalPath, s.bytes, ["--uphold", "--park", `${oldest.line}@${oldest.ts}`]);
    expect(stale.refused).toMatch(/stale decision/);
  });

  test("test: status for the daemon-written re-park prints a decision line offering waive, uphold and recheck with the newest park's token and human-decision yes, and the cockpit's run decisions offer the same verbs, so a surface disagreeing with approve on the re-park fails", async () => {
    writeFileSync(s.journalPath, s.bytes);
    const journal = Journal.open(s.repo, s.runId);
    const { events, sourceIndexes } = readJournalEvents(journal);
    const park = newestPark(events, "T1", sourceIndexes)!;
    const token = parkToken(park)!;
    expect(park.index).toBe(parkIndexes(events).at(-1));
    const out = await status([s.runId], s.repo);
    expect(out).toContain(`next action Choose a decision: ${["waive", "uphold", "recheck"].map(verb => `${verb}: tickmarkr approve ${s.runId} T1 --${verb} --gate review --park ${token}`).join("; ")} · human-decision yes`);
    const [decision, ...others] = deriveRunDecisions(journal, loadGraph(s.repo));
    expect(others).toEqual([]);
    expect(decision!.taskId).toBe("T1");
    expect(decision!.verbs).toEqual(["waive", "uphold", "recheck"]);
    expect(decision!.diagnostic).toBeUndefined();
    expect(parkToken(decision!.park)).toBe(token);
  });

  test("test: a restore of the undecided cap park draws no review round and is re-parked at the same cap instead of dispatching an unfunded attempt, while an uphold on that re-park makes the next resume dispatch the funded attempt carrying the upheld findings, so a restore opening a fresh engagement fails", async () => {
    writeFileSync(s.journalPath, s.bytes);
    const events = Journal.open(s.repo, s.runId).read();
    const [older, newer] = parkIndexes(events);
    const reason = (i: number) => String(events[i]!.data.reason).match(/review round cap \(\d+\) reached this engagement/)?.[0];
    expect(reason(older!)).toBe("review round cap (2) reached this engagement");
    expect(reason(newer!)).toBe(reason(older!));
    expect(reviewRoundsSinceApproval(events.slice(0, newer! + 1), "T1")).toBe(reviewRoundsSinceApproval(events.slice(0, older! + 1), "T1"));
    expect(events.slice(older!).filter((e) => e.event === "task-dispatch" || e.event === "gate-result")).toEqual([]);
    const restore = events.slice(older!).find((e) => e.event === "resume-restore")!;
    expect(restore.data).not.toHaveProperty("upheldFeedbackRestoredFor");

    await approve([s.runId, "T1", "--uphold", "--by", "operator"], s.repo);
    const script = JSON.parse(readFileSync(s.scriptPath, "utf8")) as Record<string, unknown>;
    writeFileSync(s.scriptPath, JSON.stringify({ ...script, review: { approve: true, issues: [] } }));
    const start = Journal.open(s.repo, s.runId).read().length;
    const resumed = await runDaemon(s.repo, { adapters: [new FakeAdapter(s.scriptPath), reviewOnlySeat(s.repo, s.scriptPath)], runId: s.runId, resume: true });
    expect(resumed.done).toEqual(["T1"]);
    const funded = Journal.open(s.repo, s.runId).read().slice(start);
    expect(funded.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
    expect(funded.find((e) => e.event === "resume-restore")?.data.upheldFeedbackRestoredFor).toBe("T1");
    const prompt = readFileSync(join(Journal.open(s.repo, s.runId).dir, "prompts", "T1-a0.md"), "utf8");
    expect(prompt).toMatch(/UPHELD/);
    expect(prompt).toMatch(/stat tile mislabeled/);
  }, 240_000);
});

// The closed case table: previous park × what lies between it and the newer gate-fail park × verb.
type Between = "restore" | "refused" | "dispatch" | "passing" | "failing-other" | "approved";
const BETWEEN: readonly Between[] = ["restore", "refused", "dispatch", "passing", "failing-other", "approved"];
const PREVIOUS = ["review", "test", "acceptance"] as const;

async function caseJournal(previous: string, between: Between): Promise<{ repo: string; runId: string; journalPath: string; bytes: string }> {
  const runId = `run-case-${previous}-${between}`;
  const { repo } = setupRepo([T("T1")], { tasks: {} });
  const j = Journal.create(repo, runId);
  j.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0 });
  j.append("gate-result", "T1", { gate: previous, pass: false, details: `${previous} failed` });
  j.append("task-human", "T1", { kind: "gate-fail", reason: `${previous} failed` });
  const older = j.newestBinding("T1");
  if (between === "restore") {
    j.append("run-end", undefined, { done: [], failed: [] });
    j.append("run-resume");
    j.append("resume-restore", "T1", { attempts: 1 });
  } else if (between === "refused" || between === "approved") {
    j.append("task-approved", "T1", { by: "op", via: "cli", release: RECHECK_RELEASE, park: older });
    const line = j.readSourced().lines.at(-1)!;
    if (between === "refused") j.append("approval-refused", "T1", { lines: [line], reason: "refused" });
    else j.append("resume-restore", "T1", { attempts: 1 });
    expect(foldDecisions(j.read()).effective.has(line)).toBe(between === "approved");
  } else if (between === "dispatch") {
    j.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 1 });
  } else {
    j.append("gate-result", "T1", { gate: "build", pass: between === "passing", details: "build" });
  }
  j.append("task-human", "T1", { kind: "gate-fail", reason: "parked again" });
  const journalPath = join(j.dir, "journal.jsonl");
  return { repo, runId, journalPath, bytes: readFileSync(journalPath, "utf8") };
}

test("test: a newer gate-fail park inherits the older park's failed gate, verbs and approve bindings only across a restore or refused approval, while a passing or failing gate-result, dispatch or effective approval between keeps its own span, test and acceptance gates included, uphold only after review and a waive naming the older gate refused, so over-broad inheritance fails", async () => {
  for (const previous of PREVIOUS) {
    for (const between of BETWEEN) {
      const cell = `${previous} × ${between}`;
      const c = await caseJournal(previous, between);
      const { events, lines } = Journal.open(c.repo, c.runId).readSourced();
      const [older, newer] = parkIndexes(events);
      const inherits = between === "restore" || between === "refused";
      const gate = inherits ? previous : between === "failing-other" ? "build" : undefined;
      const park = newestPark(events, "T1")!;
      expect(park.index, cell).toBe(newer);
      expect(park.failedGate, cell).toBe(gate);
      const verbs = gate === undefined ? [] : gate === "review" ? ["waive", "uphold", "recheck"] : ["waive", "recheck"];
      expect(permittedDecisionVerbs(park), cell).toEqual(verbs);
      expect(deriveRunDecisions(Journal.open(c.repo, c.runId)).map((d) => d.verbs), cell).toEqual([verbs]);
      const newest = { line: lines[newer!]!, ts: events[newer!]!.ts };
      for (const verb of Object.keys(VERBS) as Verb[]) {
        const { row, line, events: after, refused } = await decide(c.repo, c.runId, c.journalPath, c.bytes, [`--${verb}`]);
        if (!verbs.includes(verb)) {
          expect(refused, `${cell} ${verb}`).toBeDefined();
          continue;
        }
        expect(row?.data.release, `${cell} ${verb}`).toBe(VERBS[verb]);
        expect(row!.data.park, `${cell} ${verb}`).toEqual(newest);
        if (verb === "waive") expect(row!.data.gate, cell).toBe(gate);
        expect(foldDecisions(after).effective.has(line!), `${cell} ${verb}`).toBe(true);
      }
      // A waive naming a gate the newest park did not fail is refused, by approve and by the decision fold.
      const wrong = gate === previous ? "lint" : previous;
      expect((await decide(c.repo, c.runId, c.journalPath, c.bytes, ["--waive", "--gate", wrong])).refused, cell).toBeDefined();
      writeFileSync(c.journalPath, c.bytes);
      const forged = Journal.open(c.repo, c.runId);
      forged.append("task-approved", "T1", { by: "op", via: "cli", release: GATE_SATISFIED_RELEASE, gate: wrong, park: newest });
      expect(foldDecisions(forged.read()).effective.has(forged.readSourced().lines.at(-1)!), cell).toBe(false);
      expect(older, cell).toBeLessThan(newer!);
    }
  }
}, 240_000);

test("a refusal naming no lines voids every approval before the newer park, so the re-park still inherits", async () => {
  const c = await caseJournal("test", "refused");
  const rows = c.bytes.trimEnd().split("\n").map((line) => JSON.parse(line) as JournalEvent);
  const refusal = rows.findIndex((e) => e.event === "approval-refused");
  rows[refusal] = { ...rows[refusal]!, data: { reason: "refused" } };
  writeFileSync(c.journalPath, rows.map((e) => JSON.stringify(e)).join("\n") + "\n");
  expect(newestPark(Journal.open(c.repo, c.runId).read(), "T1")?.failedGate).toBe("test");
});

test("an infra park after a gate-fail park reads its failed gate as before — no inheritance", () => {
  const events = [
    { ts: "2026-10-22T00:00:00.000Z", event: "gate-result", taskId: "T1", data: { gate: "review", pass: false } },
    { ts: "2026-10-22T00:00:01.000Z", event: "task-human", taskId: "T1", data: { kind: "gate-fail" } },
    { ts: "2026-10-22T00:00:02.000Z", event: "resume-restore", taskId: "T1", data: {} },
    { ts: "2026-10-22T00:00:03.000Z", event: "task-human", taskId: "T1", data: { kind: "infra" } },
  ] as JournalEvent[];
  expect(newestPark(events, "T1")?.failedGate).toBeUndefined();
});

// The restore rows: a funded uphold, none at all, and an uphold already spent on an earlier engagement.
function restoreJournal(repo: string, runId: string, shape: "funded" | "none" | "spent"): Journal {
  const j = Journal.create(repo, runId);
  j.append("run-start", undefined, { pid: process.pid, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  j.append("gate-result", "T1", { gate: "review", pass: false, details: "stat tile mislabeled" });
  j.append("task-human", "T1", { kind: "gate-fail", reason: "review round cap (2) reached this engagement" });
  if (shape !== "none") j.append("task-approved", "T1", { by: "op", via: "cli", release: REVIEW_UPHELD_RELEASE, gate: "review", park: j.newestBinding("T1") });
  j.append("resume-restore", "T1", { attempts: 0 });
  if (shape === "spent") {
    j.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0 });
    j.append("gate-result", "T1", { gate: "review", pass: false, details: "still mislabeled" });
    j.append("task-human", "T1", { kind: "gate-fail", reason: "review round cap (2) reached this engagement" });
    j.append("run-end", undefined, { done: [], failed: [] });
    j.append("run-resume");
    j.append("resume-restore", "T1", { attempts: 1 });
  }
  return j;
}

test("test: a resume-restore row announces upheld feedback only when an effective uphold is newer than the task's newest park, never with no approval or a spent uphold, and status names restored feedback only while the task's newest restore was funded, silent after funded restore, cap and undecided restore, so a re-announced spent uphold fails", async () => {
  const restores = (j: Journal) => j.read().filter((e) => e.event === "resume-restore");
  for (const [shape, announced] of [["funded", ["T1"]], ["none", [undefined]], ["spent", ["T1", undefined]]] as const) {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const runId = `run-restore-${shape}`;
    const j = restoreJournal(repo, runId, shape);
    expect(restores(j).map((e) => e.data.upheldFeedbackRestoredFor), shape).toEqual(announced);
    expect(restores(j).map((e) => e.data.summary), shape).toEqual(announced.map((t) => t && `upheld feedback restored for ${t}`));
    const out = await status([runId], repo);
    if (shape === "funded") expect(out, shape).toContain("upheld feedback restored for T1");
    else expect(out, shape).not.toContain("upheld feedback restored");
  }
  // An unrefused uphold that is no longer effective (bound to a superseded park) funds no restore either.
  const { repo } = setupRepo([T("T1")], { tasks: {} });
  const j = restoreJournal(repo, "run-restore-stale", "none");
  const stale = j.read().length;
  j.append("task-approved", "T1", { by: "op", via: "cli", release: REVIEW_UPHELD_RELEASE, gate: "review", park: { line: 1, ts: "2026-01-01T00:00:00.000Z" } });
  j.append("resume-restore", "T1", { attempts: 0 });
  expect(j.read().slice(stale).find((e) => e.event === "resume-restore")?.data).not.toHaveProperty("upheldFeedbackRestoredFor");
});
