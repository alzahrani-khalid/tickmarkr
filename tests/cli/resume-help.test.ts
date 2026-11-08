// Queue row 372 (D-2186 add.4): each sentence of the resume help entry is cited to the split release
// src/run/split-release.ts ships. Help that promises a release of an unparked task, or of an unproved
// change, fails the same citation.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { narrationRow } from "../../src/cli/commands/run.js";
import { COMMAND_HELP, commandHelp } from "../../src/cli/help.js";
import { dispatch } from "../../src/cli/index.js";
import { validateGraph, type Task } from "../../src/graph/schema.js";
import {
  pendingApprovalActions, pendingRechecks, repairReachSinceApproval, reviewRoundsSinceApproval, type JournalEvent,
} from "../../src/run/journal.js";
import {
  decideSplitRelease, ENDED_PATH, PARK_KEPT_EVENT, parkDefinition, RELEASED_BY, splitReleaseReads, STOPPED_PATH,
  type SplitDecision, type TaskWorkRead,
} from "../../src/run/split-release.js";
import { T } from "../helpers/tmprepo.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SPEC = { source: "prd", paths: ["p"], hash: "h" };
const loaded = (over: Record<string, unknown>): Task =>
  validateGraph({ version: 1, spec: SPEC, tasks: [T("T1", over)] }).tasks[0]!;
const BEFORE = loaded({ files: ["a.ts"] });
const AFTER = loaded({ goal: "T1 split", files: ["b.ts"] });
const KEPT_GATE = loaded({ goal: "T1 split", files: ["b.ts"], humanGate: true });
const REHASH = { from: "a".repeat(16), to: "b".repeat(16) };
const HEAD = "c".repeat(40);
const RUN = "run-resume-help";
const COMMITS: TaskWorkRead = { head: HEAD, commits: 2 };
const NONE: TaskWorkRead = { head: "b".repeat(40), commits: 0 };

let clock = 0;
const row = (event: string, taskId?: string, data: Record<string, unknown> = {}): JournalEvent =>
  ({ ts: new Date(Date.UTC(2026, 10, 8, 0, 0, clock++)).toISOString(), event, ...(taskId ? { taskId } : {}), data });

/** An open review-cap park. `stop` "ended" places a run-end after the park; "stopped" does not. */
function parked(kind = "gate-fail", stop: "ended" | "stopped" = "ended", definition: unknown = parkDefinition(BEFORE)): JournalEvent[] {
  return [
    row("run-start", undefined, { baseRef: "b".repeat(40) }),
    row("task-dispatch", "T1", { attempt: 0 }),
    row("gate-result", "T1", { gate: "review", pass: false, details: "red" }),
    row("repair-attempt", "T1", { repair: 1, gates: ["review"] }),
    row("task-dispatch", "T1", { attempt: 1 }),
    row("gate-result", "T1", { gate: "review", pass: false, details: "red again" }),
    row("task-human", "T1", { kind, reason: `${kind} park`, ...(definition === null ? {} : { definition }) }),
    ...(stop === "ended" ? [row("run-end", undefined, { human: ["T1"] })] : []),
  ];
}

const decide = (
  events: JournalEvent[],
  work: TaskWorkRead | undefined,
  tasks: Task[] = [AFTER],
  rehash: typeof REHASH | null = REHASH,
): SplitDecision[] => decideSplitRelease(
  { runId: RUN, events, tasks, rehash: rehash ?? undefined },
  new Map(work ? [["T1", work]] : []),
);

const plain = (text: string | null): string => (text ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const railOf = (decision: SplitDecision): string =>
  plain(narrationRow({ ...row(decision.event, decision.taskId, decision.data) }, RUN, 4000));

const sentencesOf = (text: string): string[] => text.split(/(?<=\.)\s+/u).filter((sentence) => sentence.length > 0);

/**
 * A release sentence must name a parked task and a proved change. An unparked task, or an unproved
 * change, promised as released is the overclaim this help is written against.
 */
function releaseOverclaim(sentences: readonly string[]): string[] {
  const reasons: string[] = [];
  for (const sentence of sentences) {
    if (!/\bis released\b/u.test(sentence)) continue;
    if (/\bunparked\b/u.test(sentence)) reasons.push(`promises a release of an unparked task: ${sentence}`);
    if (!/\bparked task\b/u.test(sentence)) reasons.push(`release does not require a parked task: ${sentence}`);
    if (/\bunproved\b/u.test(sentence)) reasons.push(`promises a release of an unproved change: ${sentence}`);
    if (!/\bproved\b/u.test(sentence)) reasons.push(`release does not require a proved change: ${sentence}`);
    if (!/\bnot a human-gate or an attempt-cap park\b/u.test(sentence)) reasons.push(`release does not exclude the exempt parks: ${sentence}`);
  }
  return reasons;
}

test("resume help describes the graph changed release of a parked task whose definition changed with its reset round counters re-gate or fresh worker kept park and stop path wording", async () => {
  const entry = COMMAND_HELP.resume;
  // The rest of the resume entry is not this release. Leaving it untouched keeps every help
  // assertion that does not read the --graph-changed sentences.
  expect(entry.usage).toBe("resume <run-id> [options]");
  expect(entry.description).toBe("Continue a run from its journal through production preflight and gates.");
  expect(entry.options["--retry-failed"]).toBe("Retry failed tasks.");
  expect(entry.options["--driver <auto|herdr|subprocess|orca|herdr-app>"]).toBe(
    "Choose the execution driver; auto picks herdr, then herdr-app, then orca from host markers, else subprocess.",
  );
  expect(entry.examples).toEqual(["resume run-example --driver subprocess", "resume run-example --retry-failed"]);

  const flag = entry.options["--graph-changed"];
  const sentences = sentencesOf(flag!);
  const [identity, release, enact, kept, path] = sentences;
  expect(sentences).toEqual([
    "Accept and journal a changed graph identity for this run.",
    "A parked task whose definition changed is released at that resume as a new engagement with reset round counters when the change is proved, the read of its work proves a committed head or no commits, and the park is not a human-gate or an attempt-cap park.",
    "Its committed head is re-gated with no worker or, with no commits, a fresh worker is dispatched.",
    "A human-gate park whose definition keeps the gate, an attempt-cap park and an unproved change (a definition unrecorded at the park, or a task-work read that proves neither a committed head nor that there are no commits) keep their park and say so.",
    "The release output names the stop path: the run had ended, or the run was stopped before it ended.",
  ]);

  const rendered = commandHelp("resume");
  expect(rendered).toContain(`--graph-changed  ${flag}`);
  expect((await dispatch("resume", ["--help"])).out).toBe(rendered);
  const wholeEntry = [entry.description, ...Object.values(entry.options)].flatMap(sentencesOf);
  expect(releaseOverclaim(wholeEntry)).toEqual([]);
  expect(releaseOverclaim([
    "An unparked task whose definition changed is released at that resume as a new engagement.",
  ])).toEqual([
    "promises a release of an unparked task: An unparked task whose definition changed is released at that resume as a new engagement.",
    "release does not require a parked task: An unparked task whose definition changed is released at that resume as a new engagement.",
    "release does not require a proved change: An unparked task whose definition changed is released at that resume as a new engagement.",
    "release does not exclude the exempt parks: An unparked task whose definition changed is released at that resume as a new engagement.",
  ]);
  expect(releaseOverclaim([
    "A parked task whose unproved change is released at that resume as a new engagement.",
  ]).some((reason) => reason.startsWith("promises a release of an unproved change"))).toBe(true);

  // Sentence 1 cites the audited identity: resume passes the flag, and only then does a mismatched
  // graph journal a graph-rehash naming both hashes. The sentence promises no park release.
  const resumeSrc = readFileSync(join(ROOT, "src/cli/commands/resume.ts"), "utf8");
  const daemonSrc = readFileSync(join(ROOT, "src/run/daemon.ts"), "utf8");
  expect(identity).toBe("Accept and journal a changed graph identity for this run.");
  expect(identity).not.toMatch(/releas|park|worker|stop path/u);
  expect(resumeSrc).toContain('const graphChanged = values["graph-changed"] ?? false;');
  expect(resumeSrc).toContain("graphChanged,");
  const refusal = daemonSrc.indexOf("pass --graph-changed to override");
  const rehashAt = daemonSrc.indexOf('journal.append("graph-rehash", undefined, { from: cmp.reason === "mismatch" ? cmp.recorded : null, to: loadedHash });');
  expect(refusal).toBeGreaterThan(0);
  expect(rehashAt).toBeGreaterThan(refusal);
  expect(daemonSrc).toContain("const launchRehash = opts.graphChanged ?");

  // Sentence 2 cites the decider. A proved change of a non-exempt open park, with a work read that
  // proves commits, is one task-approved new engagement and the round counters restart at it.
  const ended = parked();
  expect(reviewRoundsSinceApproval(ended, "T1")).toBe(2);
  expect(repairReachSinceApproval(ended, "T1")).toHaveLength(1);
  const released = decide(ended, COMMITS);
  expect(released).toHaveLength(1);
  expect(released[0]).toMatchObject({
    taskId: "T1", event: "task-approved",
    data: { by: RELEASED_BY, via: "resume", release: "recheck", engagement: { cause: "graph-changed", rehash: REHASH, path: ENDED_PATH, head: HEAD } },
  });
  expect(released[0]!.data).not.toHaveProperty("reviewRoundCeiling");
  const engaged = [...ended, row("task-approved", "T1", released[0]!.data)];
  expect(reviewRoundsSinceApproval(engaged, "T1")).toBe(0);
  expect(repairReachSinceApproval(engaged, "T1")).toEqual([]);
  // The same sentence's limits, against a release of an unparked task or of an unproved change.
  const neverParked = validateGraph({ version: 1, spec: SPEC, tasks: [T("T2", { goal: "never parked", files: ["c.ts"] })] }).tasks[0]!;
  expect(decide(ended, COMMITS, [AFTER, neverParked]).map((d) => d.taskId)).toEqual(["T1"]);
  expect(decide(parked("gate-fail", "ended", parkDefinition(AFTER)), COMMITS, [AFTER])).toEqual([]);
  expect(decide(ended, COMMITS, [AFTER], null)).toEqual([]);
  expect(release).toMatch(/parked task/);
  expect(release).toMatch(/change is proved/);
  expect(release).toMatch(/reset round counters/);

  // Sentence 3 cites the two enactments: a proved head is a recheck battery (no worker); no commits
  // is a fresh worker. The rail names which one.
  expect(enact).toMatch(/re-gated with no worker/);
  expect(enact).toMatch(/with no commits, a fresh worker is dispatched/);
  expect(pendingApprovalActions(engaged).get("T1")).toMatchObject({ authority: "battery", release: "recheck" });
  expect(pendingRechecks(engaged).has("T1")).toBe(true);
  expect(railOf(released[0]!)).toContain(`re-gating its head ${HEAD.slice(0, 12)}`);
  expect(railOf(released[0]!)).not.toContain("dispatching a fresh worker");
  const plainRelease = decide(ended, NONE);
  expect(plainRelease[0]!.data).not.toHaveProperty("release");
  expect((plainRelease[0]!.data.engagement as { head?: string }).head).toBeUndefined();
  const plainJournal = [...ended, row("task-approved", "T1", plainRelease[0]!.data)];
  expect(pendingApprovalActions(plainJournal).get("T1")).toMatchObject({ authority: "worker", release: "plain" });
  expect(pendingRechecks(plainJournal).has("T1")).toBe(false);
  expect(railOf(plainRelease[0]!)).toContain("dispatching a fresh worker");

  // Sentence 4 cites the parks the decider keeps, and says so through the reason the rail prints.
  // A human-gate whose loaded definition drops the gate is neither released nor kept.
  expect(kept).toMatch(/human-gate park whose definition keeps the gate/);
  expect(kept).toMatch(/attempt-cap park/);
  expect(kept).toMatch(/unproved change/);
  expect(kept).toMatch(/keep their park and say so/);
  const gate = parked("human-gate");
  const keptGate = decide(gate, COMMITS, [KEPT_GATE]);
  expect(splitReleaseReads({ runId: RUN, events: gate, tasks: [KEPT_GATE], rehash: REHASH })).toEqual([]);
  expect(keptGate[0]).toMatchObject({ event: PARK_KEPT_EVENT, hold: true });
  expect(String(keptGate[0]!.data.reason)).toContain("human-gate park");
  expect(railOf(keptGate[0]!)).toContain("human-gate park");
  expect(decide(gate, COMMITS, [AFTER])).toEqual([]);
  const cap = parked("attempt-cap");
  const keptCap = decide(cap, COMMITS);
  expect(splitReleaseReads({ runId: RUN, events: cap, tasks: [AFTER], rehash: REHASH })).toEqual([]);
  expect(String(keptCap[0]!.data.reason)).toContain("attempt-cap park");
  expect(String(keptCap[0]!.data.reason)).toContain("fresh-budget approve decision");
  expect(railOf(keptCap[0]!)).toContain("attempt-cap park");
  const unrecorded = parked("gate-fail", "ended", null);
  const keptUnrecorded = decide(unrecorded, COMMITS);
  expect(String(keptUnrecorded[0]!.data.reason)).toContain("the definition at park is unrecorded");
  expect(String(keptUnrecorded[0]!.data.reason)).toContain("no change is proved");
  expect(keptUnrecorded[0]!.event).toBe(PARK_KEPT_EVENT);
  const unread = decide(ended, { error: "cannot rebuild task branch" });
  expect(String(unread[0]!.data.reason)).toContain("reading the task work failed");
  expect(String(unread[0]!.data.reason)).toContain("neither a committed head nor its absence is proved");
  expect(railOf(unread[0]!)).toContain("neither a committed head nor its absence is proved");
  const headless = decide(ended, { commits: 2 });
  expect(String(headless[0]!.data.reason)).toContain("named no head");
  expect(headless[0]!.event).toBe(PARK_KEPT_EVENT);

  // Sentence 5 cites the two stop-path sentences the release rail prints, and no other wording.
  expect(path).toContain(ENDED_PATH);
  expect(path).toContain(STOPPED_PATH);
  expect(path).toMatch(/^The release output names the stop path: /u);
  expect(railOf(released[0]!)).toContain(ENDED_PATH);
  expect(railOf(released[0]!)).not.toContain(STOPPED_PATH);
  const stopped = decide(parked("gate-fail", "stopped"), COMMITS);
  expect((stopped[0]!.data.engagement as { path: string }).path).toBe(STOPPED_PATH);
  expect(railOf(stopped[0]!)).toContain(STOPPED_PATH);
  expect(railOf(stopped[0]!)).not.toContain(ENDED_PATH);
  expect(railOf(keptGate[0]!)).not.toContain(ENDED_PATH);
  expect(railOf(keptGate[0]!)).not.toContain(STOPPED_PATH);
});
