import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { allAdapters, writeDoctor } from "../../src/adapters/registry.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { plan } from "../../src/cli/commands/plan.js";
import { report } from "../../src/cli/commands/report.js";
import { narrationLine as railLine, narrationRow as railRow, RAIL_ROWS, TTY_NOISE_EVENTS } from "../../src/cli/commands/run.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { HARVESTED_RESULT_SUMMARY } from "../../src/run/daemon.js";
import { formatJournalNarration, Journal, type JournalEvent } from "../../src/run/journal.js";
import { authedModels, makeRepo } from "../helpers/tmprepo.js";

// T4 (v1.50): plan, run narration, and report join the doctor/status visual system through the
// src/brand.ts helpers. Golden files in tests/fixtures/brand-surfaces/ were generated from the
// pre-change code — the non-TTY/markdown surfaces must stay byte-identical to them.

const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const noColor0 = process.env.NO_COLOR;
const setTTY = (v: boolean) => Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
const onTTY = () => { setTTY(true); delete process.env.NO_COLOR; };

// v1.51 T4: goldens now carry the plan mode header — isolate XDG so an operator's global
// routing.mode declaration can never shift the pinned source layer ("default") at the gate.
let xdg0: string | undefined;
beforeEach(() => {
  xdg0 = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "tickmarkr-brand-xdg-"));
});

afterEach(() => {
  if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  if (noColor0 === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = noColor0;
  if (xdg0 === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = xdg0;
});

const golden = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures/brand-surfaces", name), "utf8");

// v1.89 T4: plan names the harness that produced the table. An absolute path off THIS machine cannot enter
// a byte-pinned golden, so the goldens supply the resolver's location instead of letting it read the
// invoked entrypoint. The supplied path exists on no machine, so it resolves nowhere and the goldens pin
// the fail-closed rendering — the label a location with nothing to derive from earns. The provenance
// labels themselves are pinned against real trees in harness.test.ts; what these fix is the surface:
// where the line sits, what it is prefixed with, and that plan never invents a claim from raw text.
const PINNED_HARNESS = "/opt/tickmarkr/lib/node_modules/tickmarkr/dist/cli/index.js";
const goldenPlan = (repo: string, argv: string[] = []) => plan(argv, repo, allAdapters(), PINNED_HARNESS);

const verifiedDefaultModels = (id: string) => authedModels(Object.keys(DEFAULT_CONFIG.tiers[id]?.models ?? {}));

const DOCTOR5 = Object.fromEntries(
  ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map((id) => [id, { installed: true, authed: true, models: [], modelAuth: verifiedDefaultModels(id) }]),
);

function mkBasicRepo(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
  }));
  writeDoctor(repo, DOCTOR5);
  return repo;
}

// only claude-code installed, both frontier models unauthed, migration floor frontier ⇒ the plan
// output carries an unroutable `!!` row AND a `  ! T1: unroutable` routing lint (the golden pins both)
const DOCTOR_FABLE_UNAUTHED = {
  "claude-code": {
    installed: true, authed: true, models: ["fable", "opus", "sonnet", "haiku"],
    modelAuth: {
      fable: { authed: false, reason: "HTTP 403: forbidden", probedAt: "2026-07-13T09:12:00Z" },
      opus: { authed: false, reason: "insufficient credit", probedAt: "2026-07-13T09:12:00Z" },
      sonnet: { authed: true, probedAt: "2026-07-13T09:12:00Z" },
      haiku: { authed: true, probedAt: "2026-07-13T09:12:00Z" },
    },
  },
};

function mkLintRepo(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "migration", complexity: 2, acceptance: ["a"] }],
  }));
  writeDoctor(repo, DOCTOR_FABLE_UNAUTHED);
  return repo;
}

function mkReportRepo(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  const j = Journal.create(repo, "run-brand-pin");
  writeFileSync(join(j.dir, "journal.jsonl"), [
    { ts: "2026-07-18T10:00:00.000Z", event: "run-start", data: { baseRef: "abc123def456" } },
    { ts: "2026-07-18T10:00:01.000Z", event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" }, attempt: 0, provenance: "floor cheap" } },
    { ts: "2026-07-18T10:00:02.000Z", event: "gate-result", taskId: "T1", data: { gate: "build", pass: true, details: "exit 0" } },
    { ts: "2026-07-18T10:00:03.000Z", event: "gate-result", taskId: "T1", data: { gate: "test", pass: false, details: "1 failed" } },
    { ts: "2026-07-18T10:00:04.000Z", event: "consult-verdict", taskId: "T1", data: { action: "retry", notes: "fix the test" } },
    { ts: "2026-07-18T10:00:05.000Z", event: "task-done", taskId: "T1", data: { attempts: 2 } },
    { ts: "2026-07-18T10:00:06.000Z", event: "merge", taskId: "T1", data: { branch: "tickmarkr/run-brand-pin--T1", commit: "deadbeef" } },
    { ts: "2026-07-18T10:01:30.000Z", event: "run-end", data: { runId: "run-brand-pin", branch: "tickmarkr/run-brand-pin", done: ["T1"], failed: [], human: [], blocked: [], pending: [] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return repo;
}

// a representative slice of the lifecycle stream — prefixed events and untouched bystanders
const NARRATION_EVENTS: JournalEvent[] = [
  { ts: "t", event: "run-start", data: { pid: 1, baseRef: "abc123def456" } },
  { ts: "t", event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "fake", model: "fake-1" }, attempt: 0 } },
  { ts: "t", event: "gate-result", taskId: "T1", data: { gate: "test", pass: false } },
  { ts: "t", event: "task-done", taskId: "T1", data: { summary: "ok" } },
  { ts: "t", event: "task-failed", taskId: "T2", data: { error: "boom" } },
  { ts: "t", event: "task-human", taskId: "T3", data: { reason: "quota exhausted on every eligible channel" } },
  { ts: "t", event: "run-end", data: { done: ["T1"], failed: ["T2"] } },
];

// ── v1.99 T2: the TTY event rail ───────────────────────────────────────────────────────────────
// The rail's two closed sets are SPECIFIED here — hand-written literals, never read off the shipped
// tables. Production is then COMPARED against this specification, so dropping an event from
// TTY_NOISE_EVENTS or RAIL_ROWS shrinks the behaviour without shrinking its oracle and the
// comparison fails. Every fixture carries the data the daemon really journals for that event (the
// `journal.append` sites in src/run/daemon.ts), so a detail the rail clips is a real detail.
//
// Membership is written down here for the same reason: an event belongs on the rail when it changes
// what the run will DO next or reports an OUTCOME of it — so the daemon's decisions (a recycled or
// banned channel, a reset session, a dispatch-mode fallback), its worker outcomes (a harvest, lost
// commits) and its lifecycle steps (a reclaimed lock, a restored resume, a moved tip) are all listed
// below whether or not production remembers them, while the mechanics and poll-time observations the
// daemon also journals stay on the pipe.

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// The narration sink is BOUND TO A RUN (src/cli/commands/run.ts `narrationSink`): `run` mints this
// id and hands it to the daemon, `resume` carries the one the operator named. Every call below goes
// through that binding, so a run-scoped row's identity is a real run id and never a generic word.
const RUN_ID = "run-20260821-070000-0000000000001734";
const narrationLine = (event: JournalEvent) => railLine(event, RUN_ID);
const narrationRow = (event: JournalEvent, columns?: number) => railRow(event, RUN_ID, columns);

/** The repetitive polls a TTY must never show — the whole suppressed set, written out. */
const NOISE_SPEC = ["worker-contact", "worker-status"] as const;

/** The quiet hierarchy as the operator must SEE it: one glyph shape and one live-palette colour per
 *  tone, spelled out here rather than imported, so a swapped mapping in production is a diff here.
 *  fail and attention share amethyst deliberately — the SHAPE is what separates them. */
type ToneName = "pass" | "fail" | "attention" | "active" | "neutral";
const TONE_SIGNAL: Record<ToneName, { glyph: string; hex: string }> = {
  pass: { glyph: "✓", hex: "#90C4A4" },
  fail: { glyph: "✗", hex: "#B07BAC" },
  attention: { glyph: "!", hex: "#B07BAC" },
  active: { glyph: "❯", hex: "#5A76AE" },
  neutral: { glyph: "-", hex: "#D9D7DD" },
};
const paint = (hex: string, text: string) =>
  `\x1b[38;2;${hex.slice(1).match(/.{2}/gu)!.map((c) => Number.parseInt(c, 16)).join(";")}m${text}\x1b[0m`;

interface RailSpec {
  event: string;
  /** the short operator label RAIL_ROWS must declare for this event */
  label: string;
  /** the DEFAULT tone RAIL_ROWS must declare */
  tone: ToneName;
  /** the tone THIS fixture must actually render, when its own verdict datum overrides the default */
  renders?: ToneName;
  /** the salient datum the TTY projection must put on this row — the fact the event exists to report
   *  and the raw formatter's one-detail ladder cannot reach. Absent ⇒ this fixture carries none. */
  salient?: string;
  data: Record<string, unknown>;
  /** run-scoped events carry no taskId */
  run?: true;
}

/** The closed salient vocabulary — the fields the raw formatter's one-detail ladder cannot reach,
 *  written out here so a field quietly dropped from the shipped projection loses its fixture too. */
const SALIENT_KEYS = ["conflict", "gates", "channel", "status", "cause", "silentMs", "tokens", "lost", "transcript"] as const;

const RAIL_SPEC: RailSpec[] = [
  // run lifecycle
  { event: "run-start", label: "started", tone: "active", run: true, data: { pid: 4321, baseRef: "abc123def4567890" } },
  { event: "run-resume", label: "resumed", tone: "active", run: true, data: { pid: 4321, from: "run-rail" } },
  // the operator's audited `--graph-changed` release (src/run/daemon.ts): the resumed run appends it
  // through the SAME journal this sink narrates, so it reaches the rail like any other lifecycle row.
  { event: "graph-rehash", label: "graph rehashed", tone: "attention", salient: "to 5f5f5f5f5f5f", run: true, data: { from: "a1a1a1a1a1a1a1a1", to: "5f5f5f5f5f5f5f5f" } },
  { event: "resume-restore", label: "restored", tone: "neutral", data: { attempts: 2, tried: ["claude-code:sonnet"], assignment: { adapter: "codex", model: "gpt-5.6-sol" } } },
  { event: "lock-reclaimed", label: "lock reclaimed", tone: "neutral", run: true, data: { pid: 4321, mtimeMs: 1787294382459 } },
  { event: "run-end", label: "finished", tone: "neutral", renders: "pass", run: true, data: { runId: "run-rail", done: ["T1"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" } },
  { event: "tip-verify", label: "tip verify", tone: "pass", run: true, data: { gate: "test" } },
  { event: "tip-verify-failed", label: "tip verify", tone: "fail", run: true, data: { gate: "test", lastMergedTask: "T1" } },
  { event: "tip-verify-start", label: "tip verify", tone: "active", run: true, data: { tip: "deadbeefcafe", cmdHash: "c0ffee", gates: ["build", "test"], cached: false } },
  { event: "tip-verify-cached", label: "tip verify", tone: "pass", run: true, data: { tip: "deadbeefcafe", cmdHash: "c0ffee", gates: ["build", "test"] } },
  { event: "exit-cause", label: "exit cause", tone: "neutral", salient: "cause unclean", run: true, data: { cause: "unclean", priorPid: 4321, evidence: "reclaimed-lock-with-open-journal" } },
  // decisions — every routing decision the daemon takes on the operator's behalf
  { event: "task-dispatch", label: "dispatch", tone: "active", data: { assignment: { adapter: "claude-code", model: "sonnet" }, attempt: 1 } },
  { event: "dispatch-retry", label: "redispatch", tone: "attention", data: { wedgedPane: "w1:p7", reason: "the delivery read-back never landed" } },
  { event: "route-deviation", label: "reroute", tone: "attention", data: { reason: "preferred channel quota-banned this run" } },
  { event: "failover-deviation", label: "reroute", tone: "attention", salient: "to codex:gpt-5.6-sol over claude-code:sonnet", data: { site: "quota-failover", static: "claude-code:sonnet", chosen: "codex:gpt-5.6-sol" } },
  { event: "quota-failover", label: "failover", tone: "attention", data: { from: "claude-code:sonnet", to: "codex:gpt-5.6-sol" } },
  { event: "dead-channel-failover", label: "failover", tone: "attention", data: { reason: "channel produced no output twice", from: "claude-code:sonnet", to: "codex:gpt-5.6-sol" } },
  { event: "provider-death-requeue", label: "requeue", tone: "attention", data: { attempt: 2, requeue: 1, assignment: { adapter: "claude-code", model: "sonnet" } } },
  { event: "channel-demotion", label: "channel demoted", tone: "attention", salient: "channel claude-code:sonnet", data: { channel: "claude-code:sonnet", streak: 3 } },
  { event: "channel-exclusion", label: "channel excluded", tone: "attention", salient: "channel claude-code:sonnet", data: { channel: "claude-code:sonnet", reason: "no output twice", kind: "dead-channel" } },
  { event: "consult-verdict", label: "consult", tone: "attention", data: { action: "retry", notes: "the failing assertion is the fixture, not the code" } },
  // the daemon accepted a trust dialog FOR the operator (src/run/daemon.ts): a decision, automatic,
  // and the one an operator is least likely to expect — it names the adapter it answered for.
  { event: "trust-auto-answer", label: "trust accepted", tone: "attention", salient: "claude-code seed", data: { slot: "tickmarkr:worker:T1:0:run-rail", adapter: "claude-code", phase: "seed" } },
  { event: "channel-recycle", label: "channel recycled", tone: "attention", salient: "channel claude-code:sonnet", data: { site: "gate-fail", channel: "claude-code:sonnet" } },
  { event: "retry-same-banned", label: "retry banned", tone: "attention", data: { gate: "review", from: "claude-code:sonnet", to: "codex:gpt-5.6-sol" } },
  { event: "gate-fingerprint-cap", label: "repeat capped", tone: "attention", salient: "channel claude-code:sonnet", data: { gate: "test", occurrences: 2, fingerprint: "expected 7 to be 6", retrySameBanned: true, channel: "claude-code:sonnet", attempt: 3 } },
  { event: "scope-authoring", label: "authoring defect", tone: "attention", salient: "channel claude-code:sonnet", data: { gate: "scope", predicted: ["src/run/daemon.ts"], repair: "declare src/run/daemon.ts in files[]", attempt: 1, chargeable: false, channel: "claude-code:sonnet" } },
  { event: "session-reset", label: "session reset", tone: "attention", salient: "tokens 174000", data: { tokens: 174000, threshold: 160000, attempt: 2 } },
  { event: "worker-mode-fallback", label: "dispatch mode", tone: "attention", data: { reason: "adapter" } },
  { event: "delivery-readiness-failed", label: "delivery failed", tone: "fail", salient: "the input box never took the dispatch", data: { attempt: 1, waitedMs: 120000, transcript: "the input box never took the dispatch" } },
  // worker results
  { event: "worker-result", label: "worker", tone: "active", renders: "pass", data: { ok: true, summary: "narration became a rail", finished: true } },
  // the producer's own record (src/run/daemon.ts): a harvest carries NO `ok` — the daemon synthesized
  // the result from committed work — so this row's glyph is its declared tone and nothing else.
  { event: "worker-result-harvested", label: "worker", tone: "attention", data: { attempt: 1, commits: ["c1", "c2"], summary: HARVESTED_RESULT_SUMMARY, source: "harvest" } },
  // the nudge DECISION and its three outcomes (src/run/daemon.ts): the daemon contacted a silent
  // worker and armed a grace deadline, and answered/failed/expired is what that contact bought.
  { event: "worker-nudge", label: "nudged", tone: "attention", salient: "attempt 2", data: { slot: "tickmarkr:worker:T1:0:run-rail", attempt: 2 } },
  { event: "worker-nudge-answered", label: "nudge answered", tone: "pass", salient: "attempt 2", data: { slot: "tickmarkr:worker:T1:0:run-rail", attempt: 2 } },
  { event: "worker-nudge-failed", label: "nudge undelivered", tone: "attention", salient: "attempt 2", data: { slot: "tickmarkr:worker:T1:0:run-rail", attempt: 2 } },
  { event: "worker-nudge-expired", label: "nudge expired", tone: "attention", salient: "attempt 2, grace 240s", data: { slot: "tickmarkr:worker:T1:0:run-rail", attempt: 2, graceMs: 240000 } },
  { event: "worker-dead", label: "worker dead", tone: "fail", salient: "silent 900s", data: { slot: "s", attempt: 1, silentMs: 900000, cpuMs: 12, cpuResolutionMs: 10 } },
  { event: "worker-harvest", label: "harvested", tone: "attention", salient: "silent 900s", data: { slot: "s", attempt: 1, commits: 3, silentMs: 900000, cpuMs: 12, cpuResolutionMs: 10 } },
  { event: "work-loss", label: "work lost", tone: "fail", salient: "lost 1", data: { site: "dispatch", base: "deadbeefcafe", attempted: ["c1", "c2"], carried: ["c1"], lost: ["c2"] } },
  { event: "task-done", label: "done", tone: "pass", data: { attempts: 2, summary: "green" } },
  { event: "task-failed", label: "failed", tone: "fail", data: { error: "gate battery red after three attempts" } },
  { event: "task-human", label: "parked", tone: "attention", data: { reason: "attempt cap reached" } },
  // gate starts and verdicts
  { event: "phase-start", label: "gate start", tone: "active", data: { phase: "gate:test", gate: "test", index: 2, total: 7 } },
  { event: "gate-result", label: "gate", tone: "pass", renders: "fail", data: { gate: "test", pass: false, details: "1 failed" } },
  { event: "gate-reused", label: "gate reused", tone: "neutral", data: { gate: "lint", commit: "deadbeefcafe" } },
  { event: "judge-retry", label: "judge retry", tone: "attention", data: { gate: "acceptance", flaked: "codex:gpt-5.6-sol", retried: "claude-code:opus" } },
  { event: "review-retry", label: "review retry", tone: "attention", data: { gate: "review", flaked: "codex:gpt-5.6-sol", retried: "claude-code:opus" } },
  // repairs and escalations
  { event: "repair-dispatch", label: "repair", tone: "attention", salient: "diff 4096B", data: { diffBytes: 4096, capped: false } },
  { event: "repair-attempt", label: "repair", tone: "attention", salient: "gates test, lint", data: { repair: 1, of: 2, gates: ["test", "lint"], commits: 3, findings: "expected 7 to be 6" } },
  { event: "repair-cancelled", label: "repair off", tone: "attention", salient: "lost 1", data: { reason: "carry incomplete", attempted: ["c1", "c2"], lost: ["c2"] } },
  { event: "repair-exhausted", label: "repair spent", tone: "fail", salient: "gates review", data: { repairs: 2, of: 2, gates: ["review"] } },
  { event: "escalation", label: "escalated", tone: "attention", data: { step: "retry", attempt: 2 } },
  { event: "operator-page", label: "page", tone: "attention", salient: "status blocked", data: { slot: "s", attempt: 2, status: "blocked" } },
  { event: "tip-moved", label: "tip moved", tone: "attention", salient: "gated deadbeefcafe, tip c0ffeebabe11", data: { gatedCommit: "deadbeefcafe", branchTip: "c0ffeebabe11" } },
  // merges
  { event: "merge", label: "integrated", tone: "pass", data: { branch: "tickmarkr/run-rail--T1", commit: "deadbeefcafe" } },
  // `{conflict}` is the whole payload the daemon writes, and the raw formatter's ladder reaches none
  // of it — the paths that collided are projected onto the row or the operator never sees them.
  { event: "merge-conflict", label: "conflict", tone: "fail", salient: "src/cli/commands/run.ts", data: { conflict: "CONFLICT (content): Merge conflict in src/cli/commands/run.ts" } },
];

/** The repetitive polls and the ungated phase counters: the whole of what a TTY must not show. */
const NOISE_EVENTS: JournalEvent[] = [
  ...NOISE_SPEC.map((event) => ({ ts: "t", event, taskId: "T1", data: { slot: "s", attempt: 0, evidence: "worktree" } })),
  { ts: "t", event: "phase-start", taskId: "T1", data: { phase: "worker", attempt: 0 } },
  { ts: "t", event: "phase-start", taskId: "T1", data: { phase: "gates" } },
  { ts: "t", event: "phase-start", taskId: "T1", data: { phase: "merge" } },
];

const specEvent = (spec: RailSpec): JournalEvent => ({
  ts: "t", event: spec.event, ...(spec.run ? {} : { taskId: "T1" }), data: spec.data,
});
// A task row is its task; a run row is the run the sink was bound to, unless the event names one
// itself. There is no generic identity here on purpose — the lifecycle events the daemon writes
// (`run-start`, `run-resume`, `lock-reclaimed`, every tip-verification row) carry no run id, and a
// constant standing in for one made every run's rail read identically.
const specIdentity = (spec: RailSpec) =>
  spec.run ? (typeof spec.data.runId === "string" ? spec.data.runId : RUN_ID) : "T1";
const RETAINED_EVENTS = RAIL_SPEC.map(specEvent);

/**
 * The ONE rejection oracle every rail row is judged by — the shipped rows and every control alike.
 * Names each way a row can betray the rail: the wrong semantic glyph or colour, a width that wraps,
 * the raw journal event name the rail exists to replace, a missing label or identity, a second line.
 */
const railViolations = (row: string, spec: RailSpec, columns: number): string[] => {
  const signal = TONE_SIGNAL[spec.renders ?? spec.tone];
  const plain = stripAnsi(row);
  const bad: string[] = [];
  if (!row.startsWith(`${paint(signal.hex, signal.glyph)} `)) bad.push("glyph"); // shape AND live colour
  if (cellWidth(row) > columns) bad.push("width");
  if (plain.includes(spec.event)) bad.push("raw-label");
  if (!plain.includes(spec.label)) bad.push("label");
  // A run id is long, so a narrow terminal clips it — but a CLIPPED identity is still a real one.
  // What the row may never do is substitute something that is not this run's id for it.
  const identity = specIdentity(spec);
  if (!plain.includes(identity) && !(plain.includes("…") && plain.includes(identity.slice(0, 12)))) bad.push("identity");
  if (row.includes("\n")) bad.push("multi-line");
  // every escape on a rail row must be the palette's own: what stripAnsi leaves is what a
  // terminal PRINTS, and a control byte in there is a row moving the cursor, erasing the board
  // above it or repainting the palette from inside itself while measuring as zero cells.
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(plain)) bad.push("control");
  return bad;
};

describe("T4 v1.50 brand pass — plan, run narration, report", () => {
  test("the seed-prefer lint emitted for a dead adapter states the absence of a DECLARED preference, asserted on the string the shipped lint path actually emits and on the regenerated brand-surface golden it feeds, so the corrected text is pinned by production output rather than by any search over source", async () => {
    setTTY(false);
    const expected = "routing seed names dead adapter 'cursor-agent' for shape 'implement' — no declared preference overrides it";
    const output = await goldenPlan(mkLintRepo());
    const fixture = golden("plan-lints.txt");

    expect(output).toContain(expected);
    expect(fixture).toContain(expected);
    expect(output).not.toContain("auto-prefer is routing around it");
    expect(fixture).not.toContain("auto-prefer is routing around it");
    expect(output).toBe(fixture);
  });

  test("plan non-tty output is byte-identical to the golden fixture (regenerated for the v1.51 T4 mode header + derivation lines)", async () => {
    setTTY(false);
    expect(await goldenPlan(mkBasicRepo())).toBe(golden("plan-basic.txt"));
    expect(await goldenPlan(mkLintRepo())).toBe(golden("plan-lints.txt"));
  });

  test("a plan lint renders the attention glyph on a tty", async () => {
    onTTY();
    const out = await goldenPlan(mkLintRepo());
    expect(out.startsWith("\x1b[1mtickmarkr plan — dry run")).toBe(true); // title frame
    expect(out).toContain("\x1b[2m─"); // rule under the title
    expect(out).toContain("\x1b[33m!\x1b[0m T1: unroutable"); // attention glyph, amber, on the lint
    expect(out).toContain("\x1b[33m!!\x1b[0m "); // unroutable row marker shares the semantics
    expect(out).toContain("\x1b[2mrouting lints:\x1b[0m"); // section label is chrome
  });

  test("test: narration events written to a pipe remain byte-identical to the raw journal formatter while a styled or filtered pipe fails", () => {
    setTTY(false);
    // every event of BOTH sets, not a lifecycle sample: what the TTY rail suppresses is exactly what
    // a machine reading the pipe would silently lose if the filter reached this surface.
    for (const e of [...NARRATION_EVENTS, ...NOISE_EVENTS, ...RETAINED_EVENTS]) {
      expect(narrationLine(e), e.event).toBe(formatJournalNarration(e));
    }
    // literal pin — the exact pre-change bytes of a lifecycle line
    expect(narrationLine({ ts: "t", event: "task-failed", taskId: "T2", data: { error: "boom" } }))
      .toBe("task-failed — T2 — boom");

    // the two ways a pipe could stop being byte-identical, each a control this surface must fail:
    const contact = NOISE_EVENTS[0]!;
    const styledPipe = (e: JournalEvent) => `\x1b[31m✗\x1b[0m ${formatJournalNarration(e)}`;
    const filteredPipe = (e: JournalEvent) =>
      (NOISE_SPEC as readonly string[]).includes(e.event) ? null : formatJournalNarration(e);
    expect(styledPipe(contact)).not.toBe(formatJournalNarration(contact));
    expect(filteredPipe(contact)).not.toBe(formatJournalNarration(contact));
    expect(narrationLine(contact)).toBe(formatJournalNarration(contact)); // the shipped pipe is neither
  });

  test("test: every event in the closed TTY noise set produces no narration row while an unfiltered contact control produces one", () => {
    onTTY();
    // the shipped suppression list is COMPARED against the specification above, so an event dropped
    // from production cannot quietly drop out of this test's expectation with it.
    expect([...TTY_NOISE_EVENTS]).toEqual([...NOISE_SPEC]);
    for (const e of NOISE_EVENTS) {
      expect(narrationLine(e), `${e.event} ${String(e.data.phase ?? "")}`).toBeNull();
    }
    // the control: the SAME contact event through the unfiltered surface renders a row, so the
    // silence above is this rail's filter and not an event that happens to format to nothing.
    const contact = NOISE_EVENTS[0]!;
    expect(formatJournalNarration(contact)).toBe("worker-contact — T1");
    expect(formatJournalNarration(contact).length).toBeGreaterThan(0);
    expect(narrationLine(contact)).toBeNull();
  });

  test("test: every event in the closed retained set produces exactly one TTY narration row while an over-filtered gate verdict control produces none", () => {
    onTTY();
    // the shipped table is COMPARED against the hand-written specification — same events, same
    // labels, same default tones. Deleting a row from RAIL_ROWS (worker-status's sibling decisions,
    // a failover, a tip-verify step) now fails here instead of shrinking the oracle along with it.
    expect(RAIL_ROWS).toEqual(Object.fromEntries(RAIL_SPEC.map((r) => [r.event, { label: r.label, tone: r.tone }])));
    for (const spec of RAIL_SPEC) {
      const row = narrationLine(specEvent(spec));
      expect(row, spec.event).not.toBeNull();
      expect(row!.split("\n"), spec.event).toHaveLength(1); // one compact line per event, never a block
      expect(stripAnsi(row!), spec.event).toContain(spec.label);
      expect(stripAnsi(row!), spec.event).toContain(specIdentity(spec));
    }
    // the control: a filter that also swallowed gate verdicts would take the operator's most
    // consequential row with it — it produces none exactly where the shipped rail produces one.
    const verdict = specEvent(RAIL_SPEC.find((r) => r.event === "gate-result")!);
    const overFiltered = (e: JournalEvent) => (e.event === "gate-result" ? null : narrationLine(e));
    expect(overFiltered(verdict)).toBeNull();
    expect(narrationLine(verdict)).not.toBeNull();
  });

  // The retained set is only as real as its PRODUCERS. `task-approved` was on this rail and could
  // never render on it: `tickmarkr approve` is a separate CLI process appending through its own
  // Journal (src/cli/commands/approve.ts) and the daemon reads that event back without re-appending
  // it, so no `narrate` callback in the running process ever sees it — a synthetic event fed to
  // `narrationLine` was the only thing that made it look retained. Every remaining row is written
  // by the daemon itself or by the driver whose journal `bindNarration` binds to this sink.
  test("every retained event has a producer that appends through the run's own journal, so a row nothing in this process can ever emit fails", () => {
    const RUN_OWNED = ["src/run/daemon.ts", "src/run/journal.ts", "src/drivers/herdr.ts"];
    const src = (path: string) => readFileSync(join(import.meta.dirname, "../..", path), "utf8");
    const appends = (files: string[], event: string) => files.some((f) => src(f).includes(`append("${event}"`));

    for (const event of Object.keys(RAIL_ROWS)) {
      expect(appends(RUN_OWNED, event), `${event} has no run-owned producer`).toBe(true);
    }
    // the recorded instance this guard exists for: an event whose ONLY producer is a separate CLI
    // command. It appends, it is a real journal event — and it is not on the rail.
    expect(appends(["src/cli/commands/approve.ts"], "task-approved")).toBe(true);
    expect(appends(RUN_OWNED, "task-approved")).toBe(false);
    expect(RAIL_ROWS["task-approved"]).toBeUndefined();
  });

  test("test: every retained TTY narration row uses the quiet semantic glyph hierarchy and fits the current terminal width without wrapping; a raw event label or over-width worker summary fails", () => {
    onTTY();
    // every shipped row, judged by railViolations: the glyph its tone demands, painted the live
    // colour that tone demands, inside the terminal, carrying the rail's label and not the journal's.
    for (const columns of [48, 80, 200]) {
      for (const spec of RAIL_SPEC) {
        expect(railViolations(narrationRow(specEvent(spec), columns)!, spec, columns), `${spec.event} @${columns}`).toEqual([]);
      }
    }
    // the same verdict event both ways: a datum that flips the outcome flips the SHAPE, so a failed
    // gate can never wear the pass tickmark (and a passing one can never wear the cross).
    const gate = RAIL_SPEC.find((r) => r.event === "gate-result")!;
    const passing = { ...gate, renders: "pass" as const, data: { gate: "test", pass: true, details: "7 passed" } };
    expect(railViolations(narrationRow(specEvent(passing), 80)!, passing, 80)).toEqual([]);
    expect(stripAnsi(narrationRow(specEvent(gate), 80)!).slice(0, 1)).toBe(TONE_SIGNAL.fail.glyph);
    expect(stripAnsi(narrationRow(specEvent(passing), 80)!).slice(0, 1)).toBe(TONE_SIGNAL.pass.glyph);

    // control 1 — a SEMANTICALLY SWAPPED glyph: the failing gate row rebuilt with the pass signal in
    // front of it. Nothing else about the row changes, so the oracle's only complaint is the glyph —
    // which is exactly the substitution a membership-in-the-vocabulary check would wave through.
    const failing = narrationRow(specEvent(gate), 80)!;
    const swapped = paint(TONE_SIGNAL.pass.hex, TONE_SIGNAL.pass.glyph) + failing.slice(paint(TONE_SIGNAL.fail.hex, TONE_SIGNAL.fail.glyph).length);
    expect(railViolations(swapped, gate, 80)).toEqual(["glyph"]);
    // …and so is a right glyph in the wrong colour: the shape survives NO_COLOR, the colour carries
    // the same verdict, and the oracle rejects a row that keeps one and drops the other.
    const miscoloured = paint(TONE_SIGNAL.active.hex, TONE_SIGNAL.fail.glyph) + failing.slice(paint(TONE_SIGNAL.fail.hex, TONE_SIGNAL.fail.glyph).length);
    expect(railViolations(miscoloured, gate, 80)).toEqual(["glyph"]);

    // control 2 — a row that kept the RAW journal event label: what the rail replaced, judged by the
    // same oracle, rejected for the one thing that is wrong with it.
    const dispatch = RAIL_SPEC.find((r) => r.event === "task-dispatch")!;
    const rawLabelRow = `${paint(TONE_SIGNAL.active.hex, TONE_SIGNAL.active.glyph)} T1 ${dispatch.event} — claude-code:sonnet`;
    expect(railViolations(rawLabelRow, dispatch, 80)).toEqual(["raw-label"]);

    // control 3 — an over-width worker summary: 400 cells of it. The shipped row clips through the
    // width authority and is marked as cut; the unclipped journal line the rail replaced is rejected
    // for width by the same oracle at the same terminal.
    const worker = RAIL_SPEC.find((r) => r.event === "worker-result")!;
    const flood = { ...worker, data: { ok: true, summary: "x".repeat(400) } };
    const unclipped = `${paint(TONE_SIGNAL.pass.hex, TONE_SIGNAL.pass.glyph)} T1 worker — ${"x".repeat(400)}`;
    expect(railViolations(unclipped, flood, 48)).toContain("width");
    const clipped = narrationRow(specEvent(flood), 48)!;
    expect(railViolations(clipped, flood, 48)).toEqual([]);
    expect(stripAnsi(clipped)).toContain("…"); // clipped, and the operator can see it was

    // control 4 - a LEGAL LONG TASK ID at the narrowest terminal. The rail's contract is identity
    // AND a short label, so clipping the two as ONE head is the defect: the id runs off the end of
    // the budget and takes the row's whole meaning with it. Here the label survives intact and the
    // identity is what gets cut.
    const longId = `T${"9".repeat(62)}`; // 64 chars: a legal id, and wider than a 48-column rail
    const longRow = narrationRow({ ts: "t", event: "task-dispatch", taskId: longId, data: dispatch.data }, 48)!;
    expect(cellWidth(longRow)).toBeLessThanOrEqual(48);
    expect(stripAnsi(longRow)).toContain(dispatch.label); // the label is NOT what a long id eats
    expect(stripAnsi(longRow)).toContain(longId.slice(0, 24)); // and the identity is still readable
    // the control: clipping identity and label together drops the label off the end of the budget.
    expect(`${longId} ${dispatch.label}`.slice(0, 46)).not.toContain(dispatch.label);

    // control 5 - a worker summary carrying TERMINAL CONTROLS rather than printable flood: cursor
    // forward, erase screen, an OSC title string and a raw SGR. cellWidth charges every one of them
    // zero cells, so the unsanitized row MEASURES AS FITTING while it walks the cursor across the
    // board the rail sits under and repaints the quiet palette from inside the line.
    const hostile = { ...worker, data: { ok: true, summary: "\u001b[100Cwedge\u001b[2J\u001b]0;pwn\u0007\u001b[31mred" } };
    const injected = `${paint(TONE_SIGNAL.pass.hex, TONE_SIGNAL.pass.glyph)} T1 worker \u2014 ${String(hostile.data.summary)}`;
    expect(cellWidth(injected)).toBeLessThanOrEqual(48); // it measures as fitting...
    expect(railViolations(injected, hostile, 48)).toEqual(["control"]); // ...and is rejected anyway
    const sanitized = narrationRow(specEvent(hostile), 48)!;
    expect(railViolations(sanitized, hostile, 48)).toEqual([]);
    expect(stripAnsi(sanitized)).toContain("wedge"); // the operator still reads the worker's words

    // control 6 - a UNICODE boundary at a WIDE terminal, where the rail clips nothing at all. The
    // raw formatter ends its line with a UTF-16 `.slice(0, 120)`, so a summary of 119 ASCII
    // characters followed by an emoji comes back cut BETWEEN THE SURROGATES - and a rail that read
    // its detail off that line painted the unpaired half at a terminal with 80 free cells to spare.
    // The row's only cut must come from the width authority, which cuts whole grapheme clusters.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const emojiTail = { ...worker, data: { ok: true, summary: `${"x".repeat(119)}\u{1F680}` } };
    expect(formatJournalNarration(specEvent(emojiTail))).toMatch(loneSurrogate); // the pipe's legacy cut
    const wide = narrationRow(specEvent(emojiTail), 200)!;
    expect(wide).not.toMatch(loneSurrogate);
    expect(stripAnsi(wide)).toContain("\u{1F680}"); // whole cluster, not half of one
    expect(railViolations(wide, emojiTail, 200)).toEqual([]);
    // …and where the terminal DOES force a cut, it lands on a cluster boundary: a run of ZWJ family
    // emoji clipped at 48 columns never ends mid-sequence on a joiner or a half pair.
    const zwj = { ...worker, data: { ok: true, summary: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}".repeat(20) } };
    const clippedZwj = stripAnsi(narrationRow(specEvent(zwj), 48)!);
    expect(clippedZwj).not.toMatch(loneSurrogate);
    expect(clippedZwj.replace(/…$/u, "")).not.toMatch(/\u200D$/u);
    expect(railViolations(narrationRow(specEvent(zwj), 48)!, zwj, 48)).toEqual([]);
  });

  test("the rail's TTY detail carries the raw formatter's own selected datum WHOLE, past the 120-code-unit slice the pipe still applies, so a ladder that drifts or a projection cut by code units fails", () => {
    onTTY();
    // The TTY projection cannot re-read the formatter's line — that line is already cut by UTF-16
    // code units — so the ladder is stated twice (src/cli/commands/run.ts `formatterDetail`). It is
    // pinned against the shipped formatter over the WHOLE corpus here: for every fixture the rail's
    // detail must BEGIN with the exact datum the formatter selected, so a field reordered, dropped or
    // differently rendered on either side fails on some fixture rather than in an operator's tab.
    const pipeDetail = (e: JournalEvent) => {
      const line = formatJournalNarration(e);
      return line.split(" — ").slice(e.taskId ? 2 : 1).join(" — ");
    };
    const ttyDetail = (e: JournalEvent) => {
      const row = stripAnsi(narrationRow(e, 4000) ?? "");
      return row.includes(" — ") ? row.slice(row.indexOf(" — ") + 3) : "";
    };
    for (const spec of RAIL_SPEC) {
      const e = specEvent(spec);
      expect(pipeDetail(e).length, spec.event).toBeLessThan(120); // no fixture is truncated…
      expect(ttyDetail(e), spec.event).toContain(pipeDetail(e)); // …so the two ladders agree exactly
      // …and `toContain("")` cannot fail, so the rows the formatter's ladder reaches NONE of —
      // a reroute, a repair dispatch, a moved tip, an auto-answered trust dialog —
      // are pinned by their own assertion: every fixture carries a meaningful payload and every
      // one of them must put SOMETHING on the row past its identity and label.
      expect(ttyDetail(e), `${spec.event} renders no detail at unlimited width`).not.toBe("");
    }
    // …and the control the corpus cannot supply: a datum LONGER than the legacy slice. The pipe
    // still cuts it at 120 code units (that surface is byte-frozen); the rail must not inherit that
    // cut — its only cut comes from the width authority, and at 4000 columns there is none.
    const long = { ts: "t", event: "task-done", taskId: "T1", data: { summary: "y".repeat(400) } } as JournalEvent;
    expect(pipeDetail(long)).toHaveLength(120);
    expect(ttyDetail(long)).toBe("y".repeat(400));

    // …and the PRECEDENCE control the corpus also cannot supply: no journaled event carries two
    // ladder fields at once, so a reordered ladder would agree with the pipe on every fixture above.
    // Walk the ladder down, dropping its winner each time — at every step the rail must name exactly
    // what the formatter named, which is what a swapped pair fails.
    const LADDER = ["summary", "reason", "error", "step", "action", "lint", "branch", "from"];
    for (const [i, field] of LADDER.entries()) {
      const data = Object.fromEntries(LADDER.slice(i).map((key) => [key, `${key}-datum`]));
      const e = { ts: "t", event: "task-done", taskId: "T1", data } as JournalEvent;
      expect(pipeDetail(e), field).toBe(`${field}-datum`);
      expect(ttyDetail(e), field).toBe(`${field}-datum`);
    }
  });

  test("run-scoped rows name the run the sink is bound to, so two runs' lifecycle rails are distinguishable and a generic identity fails", () => {
    onTTY();
    // The daemon hands `narrate` one event and nothing else, and NONE of the run-scoped lifecycle
    // events carries a run id of its own — so the identity can only come from the binding. A
    // constant standing in for it renders every run's rail identically, which is the defect here.
    const OTHER = "run-20260821-090000-0000000000001735";
    const lifecycle = RAIL_SPEC.filter((spec) => spec.run && typeof spec.data.runId !== "string");
    expect(lifecycle.map((s0) => s0.event)).toContain("run-start"); // run-start, run-resume, lock, tip…
    expect(lifecycle.map((s0) => s0.event)).toContain("run-resume");
    expect(lifecycle.map((s0) => s0.event)).toContain("lock-reclaimed");
    expect(lifecycle.some((s0) => s0.event.startsWith("tip-verify"))).toBe(true);
    for (const spec of lifecycle) {
      const mine = stripAnsi(railRow(specEvent(spec), RUN_ID, 200)!);
      const theirs = stripAnsi(railRow(specEvent(spec), OTHER, 200)!);
      expect(mine, spec.event).toContain(RUN_ID);
      expect(theirs, spec.event).toContain(OTHER);
      expect(mine, spec.event).not.toBe(theirs); // the control: a constant identity makes these equal
    }
    // an event that DOES name its run keeps naming it — the binding is the fallback, not an override.
    const ended = RAIL_SPEC.find((s0) => s0.event === "run-end")!;
    expect(stripAnsi(railRow(specEvent(ended), OTHER, 200)!)).toContain(String(ended.data.runId));
  });

  test("the run-end row's tone comes from the terminal record — fatal, a failed task and a red tip are failures and an incomplete run is attention — not from the pass/ok datum it never carries", () => {
    onTTY();
    // run-end states its outcome in buckets, `fatal` and `tipVerify`; it states neither `pass` nor
    // `ok`, so the generic verdict read finds NOTHING and the last row of every run — the one the
    // operator acts on — rendered the same neutral dash over a green, a crash and a park alike.
    const glyphOf = (data: Record<string, unknown>) =>
      stripAnsi(narrationRow({ ts: "t", event: "run-end", data: { runId: "run-rail", ...data } }, 120)!).slice(0, 1);
    const clean = { done: ["T1"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" };
    expect(glyphOf(clean)).toBe(TONE_SIGNAL.pass.glyph);

    // control 1 — a FAILED task, everything else identical to the green above.
    expect(glyphOf({ ...clean, done: [], failed: ["T1"] })).toBe(TONE_SIGNAL.fail.glyph);
    // control 2 — a FATAL crash: the record recordFatalRunEnd writes (src/run/daemon.ts) has every
    // bucket empty, so buckets alone read it as clean; `fatal` is the only thing that says otherwise.
    const fatal = { done: [], failed: [], human: [], blocked: [], pending: [], phase: "setup", fatal: true, error: "boom" };
    expect(glyphOf(fatal)).toBe(TONE_SIGNAL.fail.glyph);
    expect(fatal.failed).toHaveLength(0); // the control's premise: no bucket carries this failure
    // a red integration tip is a failure too — it is why the run exits 2 with every bucket clean.
    expect(glyphOf({ ...clean, tipVerify: "failed", lastMergedTask: "T1" })).toBe(TONE_SIGNAL.fail.glyph);
    // incomplete is not failed: parked, blocked and still-pending work want attention, not a cross.
    for (const bucket of ["human", "blocked", "pending"]) {
      expect(glyphOf({ ...clean, [bucket]: ["T2"] }), bucket).toBe(TONE_SIGNAL.attention.glyph);
    }
  });

  test("every retained event's salient datum reaches the TTY row at a permitting width, and none of it reaches the pipe", () => {
    onTTY();
    const projected = RAIL_SPEC.filter((s) => s.salient !== undefined);
    // the whole closed vocabulary is exercised, by fixtures carrying the data the daemon really
    // journals — a field dropped from the shipped projection has no fixture left to hide behind.
    for (const key of SALIENT_KEYS) {
      expect(projected.some((s) => Object.prototype.hasOwnProperty.call(s.data, key)), key).toBe(true);
    }
    for (const spec of projected) {
      expect(stripAnsi(narrationRow(specEvent(spec), 200)!), spec.event).toContain(spec.salient!);
    }
    // the control that makes the projection load-bearing: the raw formatter picks ONE detail off a
    // fixed ladder and reaches NONE of these fields — which is why the row needed projecting at all.
    expect(projected.filter((s) => !formatJournalNarration(specEvent(s)).includes(s.salient!)).map((s) => s.event))
      .toEqual(projected.map((s) => s.event));
    // and the projection is TTY-only: the pipe stays the raw formatter's bytes, salient fields and all.
    setTTY(false);
    for (const spec of projected) {
      expect(narrationLine(specEvent(spec)), spec.event).toBe(formatJournalNarration(specEvent(spec)));
    }
  });

  test("report markdown output is byte-identical to before this change", async () => {
    setTTY(false);
    expect(await report(["run-brand-pin", "--md"], mkReportRepo())).toBe(golden("report-md.md"));
    onTTY(); // --md is a document surface — byte-identical even on a tty
    expect(await report(["run-brand-pin", "--md"], mkReportRepo())).toBe(golden("report-md.md"));
  });

  test("report tty text summary gains the title frame without altering message content", async () => {
    const repo = mkReportRepo();
    setTTY(false);
    const plain = await report(["run-brand-pin"], repo);
    onTTY();
    const tty = await report(["run-brand-pin"], repo);
    expect(tty.startsWith("\x1b[1mtickmarkr engagement — run-brand-pin\x1b[0m\n\x1b[2m─")).toBe(true);
    expect(tty.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => !/^─+$/.test(l)).join("\n")).toBe(plain);
  });
});
