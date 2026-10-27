import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, test, vi } from "vitest";
import { approve, newestPark, parkToken, readJournalEvents } from "../../src/cli/commands/approve.js";
import { decisionEventsFromJournal, status } from "../../src/cli/commands/status.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { DecisionEvent } from "../../src/drivers/types.js";
import { GATE_NAMES } from "../../src/graph/schema.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { resetLiveSuiteCountForTests, resetSuiteWaitCeilingForTests, runDaemon,
  setLiveSuiteCountForTests, setSuiteWaitCeilingForTests, SUITE_POLL_MS } from "../../src/run/daemon.js";
import { decisionCommands, type DecisionPark, type DecisionVerb } from "../../src/run/decision-verbs.js";
import { HOST_PROBE_SAMPLE_MS, resetHostLatencySampleForTests, setHostLatencySampleForTests } from "../../src/run/host-health.js";
import { foldDecisions, Journal, PARK_KINDS, type JournalEvent, withPhysicalLine } from "../../src/run/journal.js";
import { COMMAND_LEASE_TOKEN_ENV } from "../../src/run/lease.js";
import { readOperatorState } from "../../src/run/operator-state.js";
import { deriveRunDecisions } from "../../src/tui/cockpit/decision-actions.js";
import { deriveRunCockpitData } from "../../src/tui/cockpit/derive.js";
import { projectRunTasks } from "../../src/tui/cockpit/run-view.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const ts = "2026-10-26T12:00:00.000Z";
const facts = (kind: string, failedGate?: string): DecisionPark & { line: number; ts: string } => ({
  kind, failedGate, tombstone: false, line: 17, ts,
});
// Independent closed expectations: the oracle must catch a wrong cell in the production table.
const plainKinds = ["human-gate", "ladder-exhausted", "attempt-cap", "quota", "reroute-exhausted",
  "setup", "merge-conflict", "tip-moved", "dispatch", "stall"];
const cells: { park: ReturnType<typeof facts>; verbs: DecisionVerb[]; gate?: string }[] = [
  ...plainKinds.map(kind => ({ park: facts(kind), verbs: ["approve"] as DecisionVerb[] })),
  { park: facts("infra"), verbs: ["approve", "recheck"] },
  { park: { ...facts("stall"), reapFailure: "census unreadable" }, verbs: ["approve", "recheck"] },
  { park: facts("diff-cap"), verbs: ["recheck"] },
  { park: facts("authoring"), verbs: ["approve"] },
  ...GATE_NAMES.map(gate => ({ park: facts("gate-fail", gate),
    verbs: (gate === "review" ? ["waive", "uphold", "recheck"] : ["waive", "recheck"]) as DecisionVerb[], gate })),
  ...GATE_NAMES.map(gate => ({ park: facts("authoring", gate),
    verbs: (["build", "test", "lint"].includes(gate) ? ["approve", "recheck"] : ["approve"]) as DecisionVerb[],
    ...(["build", "test", "lint"].includes(gate) ? { gate } : {}),
  })),
];
const argvAsPrinted = (command: string): string[] => execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
  { encoding: "utf8" }).split("\0").slice(0, -1);

test("test: for every park kind the journal closes, the release-command helper returns the admitted verbs as approve commands with the park token, plus the failed gate on gate-fail and red tool-gate authoring parks, and a reason for a tombstone, a scope request, an untimed park and a gate-fail park naming no gate, so any other cell fails", () => {
  expect(new Set([...cells.map(cell => cell.park.kind), "scope-request"])).toEqual(new Set(PARK_KINDS));
  for (const { park, verbs, gate } of cells) {
    expect(decisionCommands("run-table", "T1", park), `${park.kind}/${park.failedGate}`).toEqual({
      commands: verbs.map(verb => ({ verb, command: `tickmarkr approve run-table T1${verb === "approve" ? "" : ` --${verb}`}${gate ? ` --gate ${gate}` : ""} --park 17@${ts}` })),
      noDecision: null,
    });
    // No journal row or gate binding is needed to retain the historical park-reason bytes.
    const { line: _line, ts: _ts, ...unbound } = park;
    expect(decisionCommands("run-table", "T1", unbound, { bound: false })).toEqual({
      commands: verbs.map(verb => ({ verb, command: `tickmarkr approve run-table T1${verb === "approve" ? "" : ` --${verb}`}` })), noDecision: null,
    });
  }
  for (const [park, why] of [
    [{ ...facts("human-gate"), tombstone: true }, /tombstone/],
    [facts("scope-request"), /scope-request.*--files.*--reason/],
    [{ ...facts("human-gate"), ts: undefined }, /untimed/],
    [{ ...facts("human-gate"), line: undefined }, /park token/],
    [facts("gate-fail"), /no failed gate/],
    [facts("gate-fail", ""), /no failed gate/],
    [undefined, /no recorded park/],
  ] as const) {
    const result = decisionCommands("run-table", "T1", park);
    expect(result.commands).toEqual([]);
    expect(result.noDecision).toMatch(why);
  }
  const unsafe = { ...facts("gate-fail", "lint's $(false)"), ts: "time with 'quotes'" };
  const command = decisionCommands("run 'quoted'", "T; false", unsafe).commands[0]!.command;
  expect(command).toContain("'run '\\''quoted'\\''' ");
  expect(argvAsPrinted(command)).toEqual(["tickmarkr", "approve", "run 'quoted'", "T; false", "--waive", "--gate", "lint's $(false)", "--park", "17@time with 'quotes'"]);
  expect(decisionCommands("azAZ09_@%+=:,./-", "T1", facts("human-gate")).commands[0]!.command)
    .toBe(`tickmarkr approve azAZ09_@%+=:,./- T1 --park 17@${ts}`);
});

test("a suite-wait ceiling shorter than a latency batch preserves a full initial host observation before the occupied-suite fallback", async () => {
  const runner = makeTestTempDir("decision-suite-ceiling-");
  writeFileSync(join(runner, "package.json"), JSON.stringify({ scripts: { test: "node test.cjs" } }));
  writeFileSync(join(runner, "test.cjs"), 'console.log("Tests  1 passed (1)");');
  const { repo, fake } = setupRepo([T("T1")], { tasks: {
    T1: [{ shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "done" } }],
  } }, `gates: { test: 'cd ${runner} && npm run -s test' }\n`);
  vi.stubEnv(COMMAND_LEASE_TOKEN_ENV, undefined);
  setLiveSuiteCountForTests(async () => 1);
  setSuiteWaitCeilingForTests(SUITE_POLL_MS * 2);
  // A clipped batch is unreadable even though three samples fit their normal bounds.
  setHostLatencySampleForTests(async (_signal, bound) => bound < HOST_PROBE_SAMPLE_MS ? null : 20);
  const runId = "run-decision-suite-ceiling";
  try {
    expect((await runDaemon(repo, { adapters: [fake], runId })).done).toEqual(["T1"]);
    const rows = Journal.open(repo, runId).read();
    const ceilings = rows.filter(row => row.event === "suite-wait-ceiling");
    expect(ceilings.length).toBeGreaterThan(0);
    for (const row of ceilings) expect(row.data).toMatchObject({ count: 1, waitedMs: expect.any(Number) });
    expect(rows.some(row => row.event === "host-degraded")).toBe(false);
  } finally {
    resetHostLatencySampleForTests();
    resetLiveSuiteCountForTests();
    resetSuiteWaitCeilingForTests();
    vi.unstubAllEnvs();
  }
});

let review: { repo: string; runId: string; notices: string[] };
beforeAll(async () => {
  const { repo, fake } = setupRepo([T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })], {
    review: { approve: false, issues: ["stat tile mislabeled"] },
    tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
  });
  const notices: string[] = [];
  const driver = new SubprocessDriver();
  driver.notify = async message => { notices.push(message); };
  const runId = "run-command-review";
  expect((await runDaemon(repo, { adapters: [fake], driver, runId, approvalWindowMs: 1 })).human).toEqual(["T1"]);
  review = { repo, runId, notices };
}, 120_000);

test("test: each command the status event stream prints for a review gate-fail park, run exactly as printed through the approve command in a copy of that run, appends its verb's release bound to that park, while the plain approve the stream printed before is refused there, so a stream printing a refused command fails", async () => {
  const printed = await status([review.runId, "--watch", "--events"], review.repo, { iterations: 1, sleep: async () => {} });
  const event = printed.trim().split("\n").map(line => JSON.parse(line) as DecisionEvent)
    .filter(row => row.type === "human-decision-required").at(-1)!;
  expect(event.decisionCommands?.map(entry => entry.verb)).toEqual(["waive", "uphold", "recheck"]);
  const releases = { waive: "gate-satisfied", uphold: "review-upheld", recheck: "recheck" };
  for (const { verb, command } of event.decisionCommands!) {
    const copy = join(makeTestTempDir("decision-copy-"), "repo");
    cpSync(review.repo, copy, { recursive: true });
    const journal = Journal.open(copy, review.runId);
    const { events, sourceIndexes } = readJournalEvents(journal);
    const park = newestPark(events, "T1", sourceIndexes)!;
    const token = parkToken(park)!;
    const before = events.length;
    await expect(approve([review.runId, "T1", "--park", token], copy)).rejects.toThrow(/plain approve/);
    expect(journal.read()).toHaveLength(before);
    const argv = argvAsPrinted(command);
    expect(argv.slice(0, 2)).toEqual(["tickmarkr", "approve"]);
    await approve(argv.slice(2), copy);
    const after = journal.readSourced();
    expect(after.events).toHaveLength(before + 1);
    expect(after.events.at(-1)).toMatchObject({ event: "task-approved", taskId: "T1", data: {
      release: releases[verb as keyof typeof releases], park: { line: park.line, ts: park.ts },
    } });
    expect(foldDecisions(after.events).effective.has(after.lines.at(-1)!)).toBe(true);
  }
});

test("test: the event stream's park event keeps its approval command only for a park that admits plain approve, equal to that command, and omits it for a gate-fail park whose command list names waive, uphold or recheck instead, so an approval command the park refuses fails", () => {
  for (const { park, verbs } of cells) {
    const events: JournalEvent[] = [];
    if (park.failedGate) events.push({ event: "gate-result", ts, taskId: "T1", data: { gate: park.failedGate, pass: false } });
    events.push(withPhysicalLine({ event: "task-human", ts, taskId: "T1", data: { kind: park.kind, reason: "parked", reapFailure: park.reapFailure } }, 71));
    // A future failed gate must never change a historical park's command list.
    events.push({ event: "gate-result", ts, taskId: "T1", data: { gate: "review", pass: false } });
    const event = decisionEventsFromJournal(events, "run-stream").find(row => row.type === "human-decision-required")!;
    expect(event.decisionCommands?.map(entry => entry.verb)).toEqual(verbs);
    expect(event.decisionCommands!.every(entry => entry.command.endsWith(`--park 71@${ts}`))).toBe(true);
    if (verbs.includes("approve")) expect(event.approvalCommand).toBe(event.decisionCommands!.find(entry => entry.verb === "approve")!.command);
    else expect(event).not.toHaveProperty("approvalCommand");
  }
  for (const [kind, reason] of [["human-gate", "Retired — tombstone"], ["scope-request", "Scope expansion"], ["gate-fail", "No gate"]]) {
    const [event] = decisionEventsFromJournal([{ event: "task-human", ts, taskId: "T1", data: { kind, reason } }], "run-stream");
    expect(event).not.toHaveProperty("approvalCommand");
    expect(event!.decisionCommands).toEqual([]);
    expect(event!.noDecision).toEqual(expect.any(String));
  }
});

test("test: the production daemon's notice for a review gate-fail park lists every admitted release command on its own line with the park token and the failed gate, so a notice naming only the token fails", () => {
  const park = newestPark(Journal.open(review.repo, review.runId).read(), "T1")!;
  expect(park.failedGate).toBe("review");
  const notices = review.notices.filter(message => message.includes("T1 needs a human"));
  expect(notices).toHaveLength(1);
  const lines = notices[0]!.split("\n");
  const expected = ["waive", "uphold", "recheck"].map(verb => `${verb}: tickmarkr approve ${review.runId} T1 --${verb} --gate review --park ${parkToken(park)}`);
  expect(lines.slice(1)).toEqual(expected);
  for (const line of expected) expect(lines.filter(actual => actual === line)).toHaveLength(1);
  expect(lines[0]).not.toContain("tickmarkr approve");
  expect(park.reason).toBe(`review round cap (2) reached this engagement — release with \`tickmarkr approve ${review.runId} T1 --waive\` or \`tickmarkr approve ${review.runId} T1 --uphold\` or \`tickmarkr approve ${review.runId} T1 --recheck\``);
});

test("test: the next action status and the cockpit print for a parked task names each admitted verb with its full command, and for a park with no verb its reason, so a next action naming verbs without commands fails", async () => {
  const cases = [...cells.map(({ park }) => ({ kind: park.kind!, gate: park.failedGate, reason: "parked", reapFailure: park.reapFailure })),
    { kind: "human-gate", reason: "Retired — tombstone" }, { kind: "scope-request", reason: "scope expansion" }, { kind: "gate-fail", reason: "no gate" }];
  const { repo } = setupRepo(cases.map((_, i) => T(`T${i + 1}`)), { tasks: {} });
  const graph = loadGraph(repo);
  const runId = "run-command-summaries";
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph) });
  cases.forEach((cell, i) => {
    const taskId = `T${i + 1}`;
    if ("gate" in cell && cell.gate) journal.append("gate-result", taskId, { gate: cell.gate, pass: false });
    journal.append("task-human", taskId, { kind: cell.kind, reason: cell.reason, ...("reapFailure" in cell && cell.reapFailure ? { reapFailure: cell.reapFailure } : {}) });
  });
  const { events, lines } = journal.readSourced();
  const output = (await status([runId], repo)).replace(/\s+/g, " ");
  const raw = readFileSync(join(journal.dir, "journal.jsonl"), "utf8");
  const cockpit = deriveRunCockpitData({ fileName: `${runId}.journal.jsonl`, raw }, "test", { graph: { tasks: graph.tasks } });
  const decisions = deriveRunDecisions(journal, graph);
  const run = projectRunTasks(readOperatorState({ events, graph }), events.map((event, i) => ({ event, line: lines[i]! })), graph, decisions, runId);
  for (const decision of decisions) {
    const { commands, noDecision } = decisionCommands(runId, decision.taskId, decision.park);
    const expected = commands.length ? `Choose a decision: ${commands.map(({ verb, command }) => `${verb}: ${command}`).join("; ")}` : noDecision!;
    expect(output, decision.taskId).toContain(`next action ${expected}`);
    expect(cockpit.taskRows.find(row => row.taskId === decision.taskId)!.summary!.blocker!.nextAction).toBe(expected);
    expect(run.find(row => row.taskId === decision.taskId)!.nextAction.label).toBe(`next ${expected}`);
  }
});
