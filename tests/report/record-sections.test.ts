import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { report } from "../../src/cli/commands/report.js";
import { stats } from "../../src/cli/commands/stats.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import type { ChannelCost } from "../../src/report/cost.js";
import { buildOperatorRecord, channelRoleCounts, labelChannelUsage } from "../../src/report/operator-record.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

type FixtureEvent = { event?: string; taskId?: string; data?: Record<string, unknown> };

function installRun(repo: string, fixture: string, runId: string, telemetryFixture = fixture): void {
  const dest = join(tickmarkrDir(repo), "runs", runId);
  mkdirSync(dest, { recursive: true });
  cpSync(join(fixtures, fixture, "journal.jsonl"), join(dest, "journal.jsonl"));
  cpSync(join(fixtures, telemetryFixture, "telemetry.jsonl"), join(dest, "telemetry.jsonl"));
}

function readJournal(fixture: string): FixtureEvent[] {
  return readFileSync(join(fixtures, fixture, "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FixtureEvent);
}

function provenanceFor(fixture: string, taskId: string): string {
  const provenance = readJournal(fixture)
    .filter((event) => event.event === "task-dispatch" && event.taskId === taskId)
    .map((event) => event.data?.provenance)
    .filter((value): value is string => typeof value === "string")
    .join(" | ");
  if (!provenance) throw new Error(`fixture ${fixture} has no provenance for ${taskId}`);
  return provenance;
}

beforeEach(() => vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "tickmarkr-report-global-"))));
afterEach(() => vi.unstubAllEnvs());

describe("tickmarkr report --md against v1.17–v1.19 run fixtures", () => {
  test("an old v1.19 run without pricing renders not-measurable rows and efficiency counts", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const runId = "run-20260713-093803";
    installRun(repo, "old-run", runId);

    const out = await report([runId, "--md"], repo);

    expect(out).toContain("## Usage & efficiency");
    expect(out).toMatch(/\*\*pi:zai\/glm-5\.2\*\*[^\n]*price: not measurable/);
    expect(out).toMatch(/\*\*codex:gpt-5\.6-sol\*\*[^\n]*price: not measurable/);
    expect(out).toMatch(/\*\*claude-code:haiku\*\*[^\n]*price: not measurable/);
    expect(out).toContain("**done:** 5");
    expect(out).toContain("**first-attempt rate:** 3/5 (60%)");
    expect(out).toContain("**gate failures:** build: 1");
    expect(out).toContain("**consults:** 0");
    expect(out).toContain("**escalations:** 2");
    expect(out).toContain("**wall-clock:** 107m 18s");
  });

  test("v1.17 and v1.18 pre-report journals still render their usage sections", async () => {
    for (const fixture of ["run-20260712-190438", "run-20260712-193151"]) {
      const repo = makeRepo({ "keep.txt": "x\n" });
      installRun(repo, fixture, fixture);

      const out = await report([fixture, "--md"], repo);

      expect(out).toContain("## Usage & efficiency");
      expect(out).toContain("price: not measurable");
    }
  });

  test("a pricing fixture renders API math, sub amortization, and the API counterfactual", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const runId = "run-20260713-093803-priced";
    installRun(repo, "old-run", runId, "pricing");
    cpSync(join(fixtures, "pricing", "config.yaml"), join(tickmarkrDir(repo), "config.yaml"));

    const out = await report([runId, "--md"], repo);

    expect(out).toMatch(/\*\*opencode:opencode\/kimi-k2\*\*[^\n]*tokens: in 1,000,000  out 500,000[^\n]*price: \$6\.000000[^\n]*basis: in\/out \$2\/\$8\/Mtok; rate date 2026-07-13/);
    expect(out).toMatch(/\*\*pi:zai\/glm-5\.2\*\*[^\n]*windows: 3[^\n]*price: \$0\.250000–\$0\.750000 amortized[^\n]*API-equivalent: \$30\.000000/);
  });

  // T11: this fixture predates the `skipped` field — its four below-threshold reviews carry the
  // decline only in the details prefix, and pass:true. A reader counting passes in the record must
  // not count them. T3's review genuinely ran and its body happens to mention skipping, so the
  // prefix anchor is what keeps that one a pass; an unanchored match would misreport it.
  test("a reader counting passes in the record cannot count a legacy gate that never ran", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const runId = "run-20260713-093803-declined";
    installRun(repo, "old-run", runId);

    const isDecline = (e: FixtureEvent): boolean => /^skipped\b/.test(String(e.data?.details ?? ""));
    const reviews = readJournal("old-run").filter((e) => e.event === "gate-result" && e.data?.gate === "review");
    const declined = reviews.filter(isDecline);
    const ran = reviews.filter((e) => !isDecline(e));
    expect(declined.length).toBe(4);
    expect(declined.every((e) => e.data?.skipped === undefined && e.data?.pass === true)).toBe(true);
    expect(ran.length).toBe(1);
    expect(String(ran[0].data?.details)).toContain("skipped"); // mid-body mention, not a decline

    const out = await report([runId, "--md"], repo);
    const tickmarks = out.split("\n").filter((line) => line.startsWith("  - review: "));
    expect(tickmarks.filter((line) => line.startsWith("  - review: declined")).length).toBe(declined.length);
    expect(tickmarks.filter((line) => line.startsWith("  - review: pass")).length).toBe(ran.length);
    expect(out).toMatch(/review: declined — skipped — complexity \d+ < threshold 7/);

    // the text surface agrees: declines out of the rate base, counted separately
    const gates = readJournal("old-run").filter((e) => e.event === "gate-result");
    const ranGates = gates.filter((e) => !isDecline(e));
    const passed = ranGates.filter((e) => e.data?.pass === true);
    const text = await report([runId], repo);
    expect(text).toContain(`(${passed.length}/${ranGates.length}) · declined: ${declined.length}`);
  });

  test("the task routing line preserves the fixture journal provenance exactly", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const runId = "run-20260713-093803-routing";
    installRun(repo, "old-run", runId);

    const out = await report([runId, "--md"], repo);
    const t1 = out.slice(out.indexOf("## T1"), out.indexOf("\n## T2"));
    const routing = t1.split("\n").find((line) => line.startsWith("- **routing:** "));

    expect(routing).toBe(`- **routing:** ${provenanceFor("old-run", "T1")}`);
  });
});

describe("the shared operator-record (src/report/operator-record.ts)", () => {
  const evt = (event: string, taskId: string | undefined, data: Record<string, unknown>): JournalEvent =>
    ({ ts: "2026-09-05T00:00:00.000Z", event, data, ...(taskId ? { taskId } : {}) });

  const events: JournalEvent[] = [
    evt("task-dispatch", "T1", { assignment: { adapter: "codex", model: "gpt-5" }, attempt: 0 }),
    // The consultant is its OWN channel identity — daemon.ts always stamps adapter/model/vendor on
    // a consult-verdict, distinct from the worker channel (codex:gpt-5) the consult ran against.
    evt("consult-verdict", "T1", { action: "retry", notes: "fix the test", adapter: "claude-code", model: "opus", vendor: "anthropic" }),
    evt("task-dispatch", "T2", { assignment: { adapter: "claude-code", model: "sonnet" }, attempt: 0 }),
    evt("gate-result", "T2", { gate: "review", pass: true, details: "reviewer codex:gpt-5 (vendor: openai): approved" }),
    evt("task-dispatch", "T3", { assignment: { adapter: "pi", model: "glm-5" }, attempt: 0 }),
  ];

  const codexCost: ChannelCost = {
    adapter: "codex", model: "gpt-5", channel: "api", attempts: 1, tasks: 1,
    tokens: { input: 1_000_000, output: 500_000 }, partialMetering: false,
    apiUsd: 6, rate: { inPerMtok: 2, outPerMtok: 8 }, measurable: true,
  };
  const sonnetCost: ChannelCost = {
    adapter: "claude-code", model: "sonnet", channel: "sub", attempts: 2, tasks: 1,
    tokens: { input: 100, output: 50 }, partialMetering: true, measurable: false,
    reason: "no sub plan for adapter \"claude-code\" and unmetered",
  };
  // pi:glm-5 carries no ChannelCost row at all — journal evidence names it (a worker dispatch) but
  // no telemetry was ever recorded for it, as a pre-telemetry run would leave it.

  test("The shared operator-record consumed by report, Stats and Evidence labels worker token floors, coverage, absent telemetry, nonmeasurable money and recorded worker/review/consult channel counts from journal evidence. Complete metered fixtures retain their supported totals while subscription-only partial-worker telemetry says not measurable and missing metadata says unknown. Extrapolating a total all-role invoice, dropping learning preview or changing unrelated print defaults/Plan goldens fails.", async () => {
    // recorded worker/review/consult channel counts from journal evidence alone — the consultant
    // (claude-code:opus) gets its OWN consult credit; the task's worker (codex:gpt-5) it consulted
    // on does not inherit that credit just because it was the last channel dispatched on T1.
    const roles = channelRoleCounts(events);
    expect(roles).toEqual([
      { channel: "claude-code:opus", worker: 0, review: 0, consult: 1 },
      { channel: "claude-code:sonnet", worker: 1, review: 0, consult: 0 },
      { channel: "codex:gpt-5", worker: 1, review: 1, consult: 0 },
      { channel: "pi:glm-5", worker: 1, review: 0, consult: 0 },
    ]);

    // complete metered fixture: real token totals and a real, unrounded-off dollar figure
    const record = buildOperatorRecord(events, [codexCost, sonnetCost]);
    const codexRow = record.find((r) => r.channel === "codex:gpt-5")!;
    expect(codexRow).toMatchObject({ worker: 1, review: 1, consult: 0 });
    const consultRow = record.find((r) => r.channel === "claude-code:opus")!;
    expect(consultRow).toMatchObject({ worker: 0, review: 0, consult: 1 });
    expect(codexRow.tokens).toBe("in 1,000,000  out 500,000 (1,500,000 tokens)");
    expect(codexRow.money).toBe("price: $6.000000");

    // subscription-only partial-worker telemetry: a token FLOOR ("≥"), never a fabricated price
    const sonnetRow = record.find((r) => r.channel === "claude-code:sonnet")!;
    expect(sonnetRow.tokens).toBe("≥ in 100  out 50 (150 tokens)");
    expect(sonnetRow.money).toBe("price: not measurable");

    // missing metadata: journal evidence names the channel, no telemetry row exists for it at all —
    // "unknown", never coalesced with "not measurable" or a silent $0
    const piRow = record.find((r) => r.channel === "pi:glm-5")!;
    expect(labelChannelUsage("pi:glm-5", undefined)).toEqual({ channel: "pi:glm-5", tokens: "unknown", money: "unknown" });
    expect(piRow.tokens).toBe("unknown");
    expect(piRow.money).toBe("unknown");

    // no extrapolated all-role invoice: each channel's money stands alone — nothing sums codex's
    // measured $6 with sonnet's unmeasurable or pi's unknown row into one combined total field.
    expect(record.map((r) => r.channel).sort()).toEqual(["claude-code:opus", "claude-code:sonnet", "codex:gpt-5", "pi:glm-5"]);
    expect(record).not.toContainEqual(expect.objectContaining({ channel: "total" }));
    expect(codexRow.money).toBe("price: $6.000000"); // unaffected by the other two rows' absence of price

    // report/Stats print defaults are unchanged by the refactor into this shared module, and the
    // learning preview subsection is never dropped from the CLI's text surface.
    const repo = makeRepo({ "keep.txt": "x\n" });
    const runId = "run-20260713-093803-operator-record";
    installRun(repo, "old-run", runId);
    const md = await report([runId, "--md"], repo);
    expect(md).toMatch(/\*\*codex:gpt-5\.6-sol\*\*[^\n]*price: not measurable/);
    const text = await report([runId], repo);
    expect(text).toMatch(/learning \(routing\.learned: /);
  });

  test("report --md and stats render per-channel worker, review and consult counts from buildOperatorRecord, so a journal whose only review is a standalone review-leg2 row shows review 1 for its author channel in both rendered outputs and 0 when that row is absent", async () => {
    const repoWithLeg2 = makeRepo({ "keep.txt": "x\n" });
    const j1 = Journal.create(repoWithLeg2, "run-leg2");
    j1.append("run-start", undefined, { baseRef: "abc" });
    j1.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "worker-1" }, attempt: 0 });
    j1.append("review-leg2", "T1", {
      author: "fake:worker-1",
      meta: { reviewer: "kimi:k3" },
      reviewer: "kimi:k3",
      pass: true,
      artifactPath: "/artifacts/verify.json",
      details: "reviewer kimi:k3 approved",
    });
    j1.append("task-done", "T1", { attempts: 1 });
    j1.append("run-end", undefined, { done: ["T1"], failed: [], human: [], blocked: [], pending: [] });

    const mdWith = await report(["run-leg2", "--md"], repoWithLeg2);
    const statsWith = await stats([], repoWithLeg2);
    expect(mdWith).toMatch(/kimi:k3[^\n]*review: 1/);
    expect(statsWith).toMatch(/kimi:k3[^\n]*review: 1/);
    expect(statsWith).toMatch(/fake:worker-1\s*\|\s*kimi:k3/);

    const repoWithoutLeg2 = makeRepo({ "keep.txt": "x\n" });
    const j2 = Journal.create(repoWithoutLeg2, "run-no-leg2");
    j2.append("run-start", undefined, { baseRef: "abc" });
    j2.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "worker-1" }, attempt: 0 });
    j2.append("task-done", "T1", { attempts: 1 });
    j2.append("run-end", undefined, { done: ["T1"], failed: [], human: [], blocked: [], pending: [] });

    const mdWithout = await report(["run-no-leg2", "--md"], repoWithoutLeg2);
    const statsWithout = await stats([], repoWithoutLeg2);
    expect(mdWithout).not.toMatch(/kimi:k3[^\n]*review: 1/);
    expect(statsWithout).not.toMatch(/kimi:k3[^\n]*review: 1/);
    expect(mdWithout).toMatch(/worker-1[^\n]*review: 0/);
    expect(statsWithout).toMatch(/worker-1[^\n]*review: 0/);
  });

  test("review-leg2 correctly attributes review to reviewer in meta and details, not the diff author", () => {
    const events: JournalEvent[] = [
      { ts: "2026-09-07T00:00:00.000Z", event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "kimi", model: "k3" } } },
      {
        ts: "2026-09-07T00:00:01.000Z",
        event: "review-leg2",
        taskId: "T1",
        data: {
          author: "kimi:k3",
          meta: { reviewer: "codex:gpt-5" },
          details: "reviewer codex:gpt-5 approved",
          pass: true,
          artifactPath: "/artifacts/verify.json",
        },
      },
    ];
    const records = channelRoleCounts(events);
    expect(records).toEqual([
      { channel: "codex:gpt-5", worker: 0, review: 1, consult: 0 },
      { channel: "kimi:k3", worker: 1, review: 0, consult: 0 },
    ]);
  });
});
