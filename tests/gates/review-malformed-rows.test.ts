import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type Assignment, type BillingChannel } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { reviewGate } from "../../src/gates/review.js";
import { runGates, type GateEvent } from "../../src/gates/run-gates.js";
import type { GateResult } from "../../src/gates/types.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal, structuredFindings, type StructuredFinding } from "../../src/run/journal.js";
import { authedModels, COMMIT, makeRepo, setupRepo, T } from "../helpers/tmprepo.js";

const material = { note: "src/work.ts:7 drops the last row", severity: "material" };
const malformed = { note: 42, severity: "material" };
const approved = { approve: true, findings: [] };
const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const authorChannel: BillingChannel = { ...author, vendor: "fake-a" };
const task = () => validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [T("T1", { acceptance: [{ oracle: "command", command: "true" }] })] }).tasks[0]!;
type Reply = Record<string, unknown> | "broken-json";

// Only the reviewer transport is scripted: production reviewGate parses, classifies, carries and
// journals the returned nonce-bound bytes. The daemon and its repair/retirement paths are real.
class Seat extends FakeAdapter {
  calls: Array<{ task: string; nonce: string; diff: string }> = [];
  constructor(path: string, public override id: string, private reply: (task: string, turn: number) => Reply) {
    super(path);
    this.vendor = id;
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
  override headlessCommand(file: string): string {
    const prompt = readFileSync(file, "utf8");
    expect(prompt.startsWith("TICKMARKR-REVIEW")).toBe(true);
    const nonce = extractPromptNonce(prompt)!;
    const id = /^## Task (\S+):/m.exec(prompt)![1]!;
    const reply = this.reply(id, this.calls.length);
    this.calls.push({ task: id, nonce, diff: /## Diff\n```diff\n([\s\S]*?)\n```/.exec(prompt)?.[1] ?? "" });
    const carried = [...prompt.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]!);
    const body = reply === "broken-json" ? `{"nonce":"${nonce}","approve":true,"findings":[] "resolved":[]}`
      : JSON.stringify({ nonce, resolved: carried, reraised: [], ...reply });
    return `printf '%s' ${shq(body)}`;
  }
}

function fixture() {
  const repo = makeRepo({ "a.txt": "before\n" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "a.txt"), "after\n");
  git("add", "a.txt");
  git("commit", "--no-gpg-sign", "-m", "work");
  const script = join(repo, ".git", "review-script.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  const review = (reply: Record<string, unknown>, prior: StructuredFinding[] = []) => {
    const seat = new Seat(script, "seat-a", () => reply);
    return reviewGate(task(), repo, base, author, [authorChannel, ...seat.channels()], [seat], DEFAULT_CONFIG,
      undefined, undefined, undefined, undefined, undefined, prior);
  };
  const round = async (reply: (task: string, turn: number) => Reply, prior: StructuredFinding[] = []) => {
    const seat = new Seat(script, "seat-a", reply);
    const strikes = new Map<string, string[]>();
    const notes: GateEvent[] = [];
    const result = await runGates(task(), { worktree: repo, baseRef: base, author,
      result: { ok: true, summary: "work", deviations: [], raw: "" }, commands: {},
      baseline: await captureBaseline(repo, {}), channels: [authorChannel, ...seat.channels()], adapters: [new FakeAdapter(script), seat],
      cfg: { ...DEFAULT_CONFIG, judge: { ...DEFAULT_CONFIG.judge, adapter: "fake", model: "fake-1" } },
      carriedFindings: prior, reviewNoVerdicts: strikes,
      onGate: (event) => { notes.push(event); } });
    return { result: result.results.find((g) => g.gate === "review")!, strikes, notes, seat };
  };
  return { review, round };
}

function protocol(result: GateResult, count: number, lines: string[]) {
  expect(result.pass).toBe(false);
  expect(result.meta).toMatchObject({ unparseable: true, cause: "malformed-verdict", malformedRows: count });
  expect(result.meta?.findings).toBeUndefined();
  expect(result.meta?.closureInvalid).toBeUndefined();
  expect(result.details).not.toMatch(/unparseable/i);
  for (const line of lines) expect(result.details).toContain(line);
}
function red(result: GateResult) {
  expect(result.pass).toBe(false);
  expect(result.meta?.unparseable).toBeUndefined();
  expect(result.meta?.noVerdict).toBeUndefined();
  expect(result.meta?.infra).toBeUndefined();
}

class Author extends FakeAdapter {
  override channels(): BillingChannel[] { return [super.channels()[0]!, { ...super.channels()[1]!, tier: "cheap" }]; }
}
const work = (id: string) => ({ shell: `echo work >> ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } });
const cfg = "concurrency: 1\nreview: { required: true, prefer: [seat-a, seat-b], timeoutMs: 5000 }\n";
const daemonTask = (id: string, extra = {}) => T(id, { acceptance: [{ oracle: "command", command: "true" }], ...extra });

describe("malformed review deliveries (D-1085, D-2158)", () => {
  test("test: a review verdict whose only rows are malformed, an unknown severity, a rationale-less deferral or a legacy rejection without an issue, is a reviewer protocol failure keeping each inconsistency line and no unparseable wording, while one valid material stays an ordinary red and a clean approval passes, so a gate charging a malformed-only verdict as requested changes fails", async () => {
    const { review } = fixture();
    protocol(await review({ findings: [{ note: 42, severity: "unknown", defer: "yes" }] }), 1, [
      'review finding inconsistent: findings[0].note must be a string',
      'review finding inconsistent: findings[0].severity must be "material" or "minor"',
      'review finding inconsistent: findings[0].defer must be a boolean',
    ]);
    protocol(await review({ findings: [{ note: "unknown", severity: "critical" }] }), 1, ['findings[0].severity must be "material" or "minor"']);
    protocol(await review({ findings: [{ note: "deferred", severity: "minor", defer: true }] }), 1, ["deferred findings[0] requires a rationale"]);
    protocol(await review({ approve: false, issues: [] }), 0, ["approve=false requires at least one issue"]);
    protocol(await review({ approve: true, findings: [malformed] }), 1, ["findings[0].note must be a string"]);
    const valid = await review({ findings: [material] });
    red(valid);
    expect(valid.details).toContain("requested changes (1 material)");
    expect((await review(approved)).pass).toBe(true);
  });

  test("test: a review verdict holding one valid material and one malformed material row stays red counting one material, records one malformed row and files only the valid material as a finding, so a gate that counts the malformed row or mints it into a finding fails", async () => {
    const { review } = fixture();
    for (const findings of [[material, malformed], [malformed, material]]) {
      const result = await review({ approve: true, findings });
      red(result);
      expect(result.details).toContain("requested changes (1 material)");
      expect(result.meta?.malformedRows).toBe(1);
      expect(result.meta?.findings).toEqual(structuredFindings("review", `- [material] ${material.note}`));
      expect(result.details).toContain(`findings[${findings.indexOf(malformed)}].note must be a string`);
    }
  });

  test("test: the production daemon whose only review seat answers every round with malformed rows asks that seat once more on the same subject, funds no repair, launches no second worker and parks infrastructure, while the same seat answering one valid material funds a repair, so a malformed verdict that spends a review round or a repair fails", async () => {
    for (const bad of [true, false]) {
      const { repo, scriptPath } = setupRepo([daemonTask("T1")], { tasks: { T1: [work("T1"), work("T1-repair")] } }, cfg);
      const seat = new Seat(scriptPath, "seat-a", (_id, turn) => bad ? { findings: [malformed] }
        : turn === 0 ? { findings: [material] } : approved);
      const runId = `run-malformed-${bad}`;
      const result = await runDaemon(repo, { runId, adapters: [new Author(scriptPath), seat] });
      const rows = Journal.open(repo, runId).read();
      const reviews = rows.filter((r) => r.event === "gate-result" && r.data.gate === "review");
      if (bad) {
        expect(result.human).toEqual(["T1"]);
        expect(rows.filter((r) => r.event === "task-dispatch")).toHaveLength(1);
        expect(rows.filter((r) => ["repair-attempt", "escalation", "consult", "consult-verdict"].includes(r.event))).toEqual([]);
        expect(rows.find((r) => r.event === "task-human")?.data.kind).toBe("infra");
        expect(reviews).toHaveLength(1);
        expect(reviews[0]!.data).toMatchObject({ infra: true, skipped: true, noVerdict: true });
        expect(reviews[0]!.data.pass).toBeUndefined();
        expect(reviews[0]!.data.findings).toBeUndefined();
        expect(rows.filter((r) => r.event === "review-reemission").map((r) => r.data))
          .toEqual([{ reviewer: "seat-a:seat-a", cause: "malformed-verdict", delivered: false }]);
        expect(rows.filter((r) => r.event === "review-infra-retry")).toEqual([]);
        const telemetry = readFileSync(join(Journal.open(repo, runId).dir, "telemetry.jsonl"), "utf8")
          .trim().split("\n").map((s) => JSON.parse(s));
        expect(telemetry.find((r) => r.outcome === "human")).toMatchObject({ gateFails: 0, consults: 0 });
      } else {
        expect(result.done).toEqual(["T1"]);
        expect(rows.filter((r) => r.event === "task-dispatch")).toHaveLength(2);
        expect(rows.filter((r) => r.event === "repair-attempt")).toHaveLength(1);
        expect(reviews.map((r) => r.data.pass)).toEqual([false, true]);
      }
      expect(seat.calls.map((c) => c.task)).toEqual(["T1", "T1"]);
      expect(seat.calls[0]!.nonce).not.toBe(seat.calls[1]!.nonce);
      expect(seat.calls[0]!.diff).not.toBe("");
      if (bad) expect(seat.calls[0]!.diff).toBe(seat.calls[1]!.diff);
    }
  });

  test("test: each findings-shape cell decides as ruled, a non-object row, a non-string note, an unknown severity, a non-boolean defer and a rationale-less deferral each making a verdict without valid blocking content a protocol failure and each being ignored beside a valid material, so any such cell decided otherwise fails", async () => {
    const { review } = fixture();
    const cells: Array<[unknown, string]> = [
      [null, "findings[0] must be an object"], [7, "findings[0] must be an object"],
      [{ note: {}, severity: "material" }, "findings[0].note must be a string"],
      [{ note: "unknown", severity: "blocking" }, 'findings[0].severity must be "material" or "minor"'],
      [{ note: "bad defer", severity: "material", defer: "false" }, "findings[0].defer must be a boolean"],
      ...[undefined, "", "  ", 7].map((rationale): [unknown, string] => [
        { note: "bad rationale", severity: "material", defer: true, rationale }, "deferred findings[0] requires a rationale",
      ]),
    ];
    for (const [row, inconsistency] of cells) {
      protocol(await review({ findings: [row] }), 1, [inconsistency]);
      protocol(await review({ approve: true, findings: [row, { note: "minor", severity: "minor" }] }), 1, [inconsistency]);
      const beside = await review({ findings: [row, material] });
      red(beside);
      expect(beside.details).toContain("requested changes (1 material)");
      expect(beside.details).toContain(inconsistency);
      expect(beside.meta?.malformedRows).toBe(1);
      expect(beside.meta?.findings).toEqual(structuredFindings("review", `- [material] ${material.note}`));
    }
    const several = await review({ findings: [null, malformed, { note: "unknown", severity: "unknown" }] });
    protocol(several, 3, ["findings[0] must be an object", "findings[1].note must be a string", 'findings[2].severity must be "material" or "minor"']);
  });

  test("test: each legacy and closure cell decides as ruled, a carried prior re-raised beside a malformed row staying red, a legacy approval with a string issue staying red and a legacy non-string issue alone being a protocol failure, so any such cell decided otherwise fails", async () => {
    const { review, round } = fixture();
    const prior = structuredFindings("review", "- [material] src/prior.ts:4 still drops an item");
    const id = prior[0]!.fingerprint;
    const carried = await review({ findings: [malformed], resolved: [], reraised: [id] }, prior);
    red(carried);
    expect(carried.meta?.malformedRows).toBe(1);
    expect(carried.meta?.findings).toEqual(prior);
    expect(carried.details).toContain(prior[0]!.note);
    expect(carried.details).toContain("findings[0].note must be a string");
    protocol(await review({ findings: [malformed], resolved: [id], reraised: [] }, prior), 1, ["findings[0].note must be a string"]);
    for (const approve of [false, true]) {
      const legacy = await review({ approve, issues: ["src/legacy.ts:3 still wrong", 42] });
      red(legacy);
      expect(legacy.meta?.malformedRows).toBe(1);
      expect(legacy.details).toContain("issues[1] must be a string");
      expect(legacy.details).not.toContain("- 42");
      protocol(await review({ approve, issues: [42] }), 1, ["issues[0] must be a string"]);
    }
    const legacyApproval = await review({ approve: true, issues: ["still broken"] });
    red(legacyApproval);
    expect(legacyApproval.details).toContain("approve=true requires issues to be empty");
    const invalidClosure = await round(() => ({ findings: [], resolved: [], reraised: [] }), prior);
    expect(invalidClosure.result.meta?.closureInvalid).toBe(true);
    expect(invalidClosure.strikes.size).toBe(0);
    expect(invalidClosure.seat.calls).toHaveLength(1);
    const mismatchedClosure = await round(() => ({ findings: [], resolved: ["unknown"], reraised: [] }), prior);
    expect(mismatchedClosure.result.meta).toMatchObject({ noVerdict: true, closureInvalid: true, cause: "closure-mismatch" });
    expect(mismatchedClosure.strikes.get("seat-a:seat-a")).toEqual(["closure-mismatch"]);
    expect(mismatchedClosure.seat.calls).toHaveLength(1);
  });

  test("test: a review seat whose verdict and same-subject re-emission are both malformed is retired for the run and stays retired after a resume, so no later task dispatches it, while a seat whose re-emission delivers keeps reviewing later tasks, so a double-malformed seat that keeps its run seat fails", async () => {
    // Inspect the live tally for both parsed-row and whole-verdict protocol failures. A valid
    // re-emission preserves the first strike; two malformed deliveries reach the retirement threshold.
    for (const shape of [{ findings: [malformed] }, "broken-json"] as const) {
      const { round } = fixture();
      const twice = await round(() => shape);
      expect(twice.strikes.get("seat-a:seat-a")).toEqual(["malformed-verdict", "malformed-verdict"]);
      expect(twice.seat.calls).toHaveLength(2);
      const once = await round((_id, turn) => turn === 0 ? shape : approved);
      expect(once.result.pass).toBe(true);
      expect(once.strikes.get("seat-a:seat-a")).toEqual(["malformed-verdict"]);
    }
    for (const delivers of [false, true]) {
      const tasks = [daemonTask("T1"), daemonTask("T2", { deps: ["T1"] }),
        daemonTask("T3", { deps: ["T2"], humanGate: true })];
      const { repo, scriptPath } = setupRepo(tasks, { tasks: { T1: [work("T1")], T2: [work("T2")], T3: [work("T3")] } }, cfg);
      const a = new Seat(scriptPath, "seat-a", (id, turn) => id === "T1" && (!delivers || turn === 0) ? { findings: [malformed] } : approved);
      const b = new Seat(scriptPath, "seat-b", () => approved);
      const adapters = [new Author(scriptPath), a, ...(delivers ? [] : [b])];
      const runId = `run-retire-malformed-${delivers}`;
      const first = await runDaemon(repo, { adapters, runId });
      expect(first.done).toEqual(["T1", "T2"]);
      expect(first.human).toEqual(["T3"]);
      expect(a.calls.map((c) => c.task)).toEqual(delivers ? ["T1", "T1", "T2"] : ["T1", "T1"]);
      let rows = Journal.open(repo, runId).read();
      const notes = rows.filter((r) => r.event === "review-no-verdict" && r.data.reviewer === "seat-a:seat-a");
      expect(notes).toHaveLength(delivers ? 1 : 2);
      expect(notes.every((r) => r.data.unparseable === true && r.data.cause === "malformed-verdict" && r.data.noVerdict !== true)).toBe(true);
      const demotions = rows.filter((r) => r.event === "review-pool-demotion");
      expect(demotions).toHaveLength(delivers ? 0 : 1);
      if (!delivers) expect(demotions[0]!.data.causes).toEqual(["malformed-verdict", "malformed-verdict"]);
      await approve([runId, "T3", "--by", "operator"], repo);
      // With only A available, a soft demotion would still dispatch it. Only replayed retirement
      // can prevent that dispatch and park T3 as infrastructure after the resume.
      const resumed = await runDaemon(repo, { adapters: [new Author(scriptPath), a], runId, resume: true });
      expect(resumed.done).toEqual(delivers ? ["T1", "T2", "T3"] : ["T1", "T2"]);
      expect(resumed.human).toEqual(delivers ? [] : ["T3"]);
      expect(a.calls.map((c) => c.task)).toEqual(delivers ? ["T1", "T1", "T2", "T3"] : ["T1", "T1"]);
      if (!delivers) expect(b.calls.map((c) => c.task)).toEqual(["T1", "T2"]);
      rows = Journal.open(repo, runId).read();
      const resumedReview = rows.filter((r) => r.event === "gate-result" && r.data.gate === "review" && r.taskId === "T3").at(-1)!;
      if (delivers) expect(resumedReview.data.reviewer).toBe("seat-a:seat-a");
      else {
        expect(resumedReview.data).toMatchObject({ infra: true, skipped: true });
        expect(resumedReview.data.pass).toBeUndefined();
        expect(rows.filter((r) => r.event === "task-human" && r.taskId === "T3").at(-1)?.data.kind).toBe("infra");
        expect(rows.find((r) => r.event === "review-infra-retry" && r.taskId === "T3")?.data)
          .toMatchObject({ reviewer: "seat-a:seat-a", cause: "retired", cannotSeat: true, causes: ["malformed-verdict", "malformed-verdict"] });
      }
    }
  }, 120_000);
});
