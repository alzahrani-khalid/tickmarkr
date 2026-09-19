// v2.5.6 T4 (OBS-1013 add.3, OBS-1039, OBS-1025 add.2, OBS-1033, OBS-1020): a review round that
// produced nothing spends no worker. Every seat here is a fake; every wait is injected clock time.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type Assignment, type BillingChannel } from "../../src/adapters/types.js";
import { PLAIN_BANNER } from "../../src/brand.js";
import { DEFAULT_CONFIG, type TickmarkrConfig } from "../../src/config/config.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import {
  type GateVia, REVIEW_FIRST_LIVENESS_MS, REVIEW_SILENT_BYTE_FLOOR,
  resetGateCpuAccountantFactoryForTests, setGateCpuAccountantFactoryForTests,
} from "../../src/gates/llm.js";
import { reviewGate } from "../../src/gates/review.js";
import { type GateContext, type GateEvent, runGates } from "../../src/gates/run-gates.js";
import type { GateResult } from "../../src/gates/types.js";
import { validateGraph } from "../../src/graph/schema.js";
import { structuredFindings, type StructuredFinding, UNIDENTIFIED } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

const GOAL = "the compiled goal: a review round that produced nothing spends no worker";
const mkTask = (over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: GOAL, shape: "implement", complexity: 8, acceptance: [{ oracle: "command", command: "true" }], ...over }],
  }).tasks[0];

function scriptPath(): string {
  const p = join(mkdtempSync(join(tmpdir(), "tickmarkr-review-liveness-")), "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {} }));
  return p;
}

function repoWithCommit(files: Record<string, string> = { "a.txt": "x\n" }) {
  const repo = makeRepo(files);
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "a.txt"), "y\n");
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

type Mode = "approve" | "reject" | "closure-mismatch" | "no-verdict";

/** The fingerprints the brief carries: every id sits once inside the fenced block. */
export function briefFingerprints(prompt: string): string[] {
  const block = /```text\n([\s\S]*?)```/.exec(prompt)?.[1] ?? "";
  return [...block.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]!);
}

// A scripted reviewer seat with its own adapter id and vendor. Nonce-bound where a verdict is served.
class Seat extends FakeAdapter {
  calls = 0;
  briefs: string[] = [];
  constructor(public override id: string, public mode: Mode) {
    super(scriptPath());
    this.vendor = `${id}-vendor`;
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
  override headlessCommand(file: string): string {
    const prompt = readFileSync(file, "utf8");
    if (!/TICKMARKR-REVIEW/.test(prompt)) return "true";
    this.calls++;
    this.briefs.push(prompt);
    const nonce = /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)![1];
    const carried = briefFingerprints(prompt);
    const verdict = this.mode === "approve" ? { nonce, approve: true, resolved: carried, reraised: [], findings: [] }
      : this.mode === "reject" ? { nonce, approve: false, resolved: [], reraised: carried, findings: [{ note: "src/work.ts:1 drops the last row", severity: "material" }] }
      : this.mode === "closure-mismatch" ? { nonce, approve: true, resolved: ["review:material|src/other.ts|nothingCarried"], reraised: [], findings: [] }
      : { approve: true, findings: [] }; // nonce-less: no verdict at all
    return `printf '%s' ${shq(JSON.stringify(verdict))}`;
  }
}

const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const chAuthor: BillingChannel = { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" };
const prefer = ["seat-b", "seat-c", "seat-d"];
const cfgWith = (over: Partial<TickmarkrConfig> = {}): TickmarkrConfig => ({
  ...DEFAULT_CONFIG, judge: { ...DEFAULT_CONFIG.judge, adapter: "fake", model: "fake-1" },
  review: { ...DEFAULT_CONFIG.review, prefer }, ...over,
});

const carriedMaterials: StructuredFinding[] = [
  { class: "review:material", path: "src/work.ts", symbol: "work", note: "src/work.ts `work` drops the last row", fingerprint: "review:material|src/work.ts|work" },
  ...structuredFindings("review", "- [material] The retry loop re-dispatches a worker after a review round that produced nothing. Nobody asked for one and the judge had passed."),
];

async function ctxFor(repo: string, base: string, seats: Seat[], over: Partial<GateContext> = {}, events?: GateEvent[]): Promise<GateContext> {
  return {
    worktree: repo, baseRef: base, result: { ok: true, summary: "s", deviations: [], raw: "" }, author, commands: {},
    baseline: await captureBaseline(repo, {}), channels: [chAuthor, ...seats.flatMap((s) => s.channels())],
    adapters: [new FakeAdapter(scriptPath()), ...seats], cfg: cfgWith(), carriedFindings: carriedMaterials,
    ...(events ? { onGate: (e: GateEvent) => { events.push(e); } } : {}), ...over,
  };
}

// Measured telemetry (durations, load samples, per-seat spans) is the only thing allowed to differ.
const stripTiming = (g: GateResult) => JSON.stringify({ ...g, meta: {
  ...g.meta, invocations: undefined, durationMs: undefined, load1Start: undefined, load1End: undefined, load1Max: undefined, load1Mean: undefined,
} });

describe("a review round that produced nothing spends no worker", () => {
  test("test: through runGates with fake reviewers a verdict whose closure ids match no carried fingerprint is classified closure-mismatch with no-verdict and infra meta rather than unparseable and the recovery loop re-routes it to a third eligible seat of another vendor, a round whose every eligible seat returned no verdict ends as a terminal review result with meta infra true and classification infra that keeps the carried material findings and the sibling judge result byte-identically with the execution policy absent and present, while a parseable rejection on the second seat fails the review as on the base, so a closure mismatch counted as unparseable, an exhausted round without infra meta, or a policy-dependent result fails", async () => {
    // closure mismatch → no-verdict → a third seat of a third vendor approves
    const { repo, base } = repoWithCommit();
    const seats = [new Seat("seat-b", "closure-mismatch"), new Seat("seat-c", "no-verdict"), new Seat("seat-d", "approve")];
    const events: GateEvent[] = [];
    const { results } = await runGates(mkTask(), await ctxFor(repo, base, seats, {}, events));
    const notes = events.filter((e) => e.phase === "note" && e.name === "review-no-verdict") as Extract<GateEvent, { phase: "note" }>[];
    expect(notes.map((n) => [n.payload.reviewer, n.payload.cause])).toEqual([["seat-b:seat-b", "closure-mismatch"], ["seat-c:seat-c", "no-verdict"]]);
    expect(notes[0]!.payload).toMatchObject({ noVerdict: true, infra: true, classification: "infra" });
    expect(notes[0]!.payload.unparseable).toBeUndefined();
    const review = results.find((g) => g.gate === "review")!;
    expect(review.pass).toBe(true);
    expect(review.meta).toMatchObject({ reviewer: "seat-d:seat-d", vendor: "seat-d-vendor" });
    expect(seats.map((s) => s.calls)).toEqual([1, 1, 1]);
    expect(new Set(seats.map((s) => s.vendor)).size).toBe(3);
    expect(results.filter((g) => g.gate === "review")).toHaveLength(1);

    // every eligible seat returned no verdict: terminal infra result, carried materials and judge kept,
    // byte-identical whether or not an execution policy is configured
    const terminal = async (executionPolicy?: TickmarkrConfig["executionPolicy"]) => {
      const r = repoWithCommit();
      const exhausted = [new Seat("seat-b", "closure-mismatch"), new Seat("seat-c", "no-verdict"), new Seat("seat-d", "no-verdict")];
      const ctx = await ctxFor(r.repo, r.base, exhausted, { cfg: cfgWith(executionPolicy ? { executionPolicy } : {}) });
      const out = await runGates(mkTask(), ctx);
      expect(exhausted.map((s) => s.calls)).toEqual([1, 1, 1]);
      return out.results;
    };
    const absent = await terminal();
    const present = await terminal({ boundedInfrastructure: true, repairSelection: true, taskExecutionLimitMs: 60_000 });
    for (const rs of [absent, present]) {
      const rv = rs.find((g) => g.gate === "review")!;
      expect(rv.pass).toBe(false);
      expect(rv.meta).toMatchObject({ infra: true, classification: "infra", noVerdict: true });
      expect(rv.meta?.unparseable).toBeUndefined();
      expect(rv.meta?.carriedFindings).toEqual(carriedMaterials.map((f) => f.fingerprint));
      const judge = rs.find((g) => g.gate === "acceptance")!;
      expect(judge.pass).toBe(true);
    }
    expect(absent.map(stripTiming)).toEqual(present.map(stripTiming));

    // a parseable rejection on the second seat is a real red, exactly as on the base
    const r3 = repoWithCommit();
    const rejected = [new Seat("seat-b", "closure-mismatch"), new Seat("seat-c", "reject"), new Seat("seat-d", "approve")];
    const red = (await runGates(mkTask(), await ctxFor(r3.repo, r3.base, rejected))).results.find((g) => g.gate === "review")!;
    expect(red.pass).toBe(false);
    expect(red.meta?.infra).toBeUndefined();
    expect(red.meta?.classification).not.toBe("infra");
    expect(red.details).toContain("drops the last row");
    expect(rejected.map((s) => s.calls)).toEqual([1, 1, 0]);
  });

  test("test: a finding without a symbol carries a fingerprint bounded to its first sentence or a short hash and a verdict echoing that bounded id closes it, and the brief prints each carried id exactly once inside a fenced block, so a whole-note fingerprint or a brief that omits or repeats an id fails", async () => {
    const first = "The retry loop re-dispatches a worker after a review round that produced nothing.";
    const rest = " Nobody asked for one and the judge had passed. The diff was green under every gate.";
    const [sentence] = structuredFindings("review", `- [material] ${first}${rest}`);
    expect(sentence!.symbol).toBe(first);
    expect(sentence!.fingerprint).toBe(`review:material|${UNIDENTIFIED}|${first}`);
    expect(sentence!.fingerprint).not.toContain(rest.trim());
    const wall = "a ".repeat(200).trim() + " never ends";
    const [hashed] = structuredFindings("review", `- [material] ${wall}`);
    expect(hashed!.symbol).toMatch(/^[0-9a-f]{12}$/);
    expect(hashed!.fingerprint.length).toBeLessThan(80);
    expect(hashed!.note).toBe(wall);

    // an approval echoing the bounded id closes it
    const { repo, base } = repoWithCommit();
    const artifactDir = mkdtempSync(join(tmpdir(), "tickmarkr-review-brief-"));
    const approving = new Seat("seat-b", "approve");
    const carried = [carriedMaterials[0]!, sentence!];
    const { results } = await runGates({ ...mkTask(), gates: ["review"] }, await ctxFor(repo, base, [approving], { carriedFindings: carried, artifactDir }));
    expect(results[0]).toMatchObject({ pass: true, meta: { resolvedMatches: carried.map((f) => f.fingerprint) } });

    // the brief prints each carried id exactly once, inside a fenced block
    const brief = readFileSync(join(artifactDir, readdirSync(artifactDir).find((f) => f.startsWith("review-brief-"))!), "utf8");
    expect(approving.briefs[0]).toBe(brief.replace(/\r/g, ""));
    for (const f of carried) expect(brief.split(f.fingerprint)).toHaveLength(2);
    expect(briefFingerprints(brief)).toEqual(carried.map((f) => f.fingerprint));
    expect(brief).toContain(sentence!.note);
  });

  test("test: a pane review seat that authors ten bytes and nothing more by the first liveness beat is classified silent, demoted and re-routed at that beat, one that authors two hundred bytes of its own by then keeps its seat to the ceiling, and a headless seat keeps its full ceiling, so a byte floor of zero or a beat on the headless path fails", async () => {
    expect(REVIEW_SILENT_BYTE_FLOOR).toBeGreaterThan(10);
    expect(REVIEW_SILENT_BYTE_FLOOR).toBeLessThanOrEqual(200);
    const PREAMBLE = `export HERDR_WORKSPACE_ID='wZ'; export TICKMARKR_PANE_IDENTITY='review · T1 · attempt 0 · run-test'; bash /tmp/tickmarkr-llm-test/dispatch.sh\nTICKMARKR_START_1234\n${PLAIN_BANNER}\nreview · T1 · attempt 0 · run-test\n`;
    class ClockedPane implements ExecutorDriver {
      id = "clocked"; interactive = false; elapsed = 0; closed = 0; seats = 0;
      private replacementNonce = "";
      constructor(private text: string) {}
      async slot(cwd: string, name: string): Promise<Slot> { this.seats++; return { id: name, name, cwd }; }
      async run(): Promise<void> {}
      async waitOutput(_s: Slot, pattern: string, timeoutMs = 0): Promise<boolean> {
        if (this.seats > 1) { this.replacementNonce = /TICKMARKR_EXIT_([0-9a-f]+):/.exec(pattern)![1]!; return true; }
        this.elapsed += timeoutMs; return false;
      }
      async waitAgentStatus(): Promise<boolean> { return true; }
      async status(): Promise<"unknown"> { return "unknown"; }
      async read(): Promise<string> {
        return this.seats > 1 ? JSON.stringify({ nonce: this.replacementNonce, approve: true, findings: [] }) : this.text;
      }
      async notify(): Promise<void> {}
      async close(): Promise<void> { this.closed++; }
      async worktree(): Promise<string> { return ""; }
    }
    const via = (driver: ExecutorDriver): GateVia => ({ driver, nameFor: () => "review-liveness", labelFor: () => "REVIEW T1" });
    const paneSeat = new Seat("seat-b", "approve");
    const clocked = async (text: string, replacement?: Seat) => {
      const { repo, base } = repoWithCommit();
      const pane = new ClockedPane(text);
      const clock = vi.spyOn(Date, "now").mockImplementation(() => 1_800_000_000_000 + pane.elapsed);
      setGateCpuAccountantFactoryForTests(() => ({ async start() {}, async stop() {}, read: () => ({ cpu: { ms: 40, resolutionMs: 10 }, gaps: 0 }) }));
      try {
        const seats = replacement ? [paneSeat, replacement] : [paneSeat];
        const events: GateEvent[] = [];
        const demotedReviewers = new Set<string>();
        const round = await runGates({ ...mkTask(), gates: ["review"] }, await ctxFor(repo, base, seats, { via: via(pane), carriedFindings: [], demotedReviewers }, events));
        return { row: round.results[0]!, pane, events, demotedReviewers };
      } finally { clock.mockRestore(); resetGateCpuAccountantFactoryForTests(); }
    };
    // ten bytes by the beat: silent, demoted, re-routed at the beat
    const ten = await clocked(PREAMBLE + "ten bytes!", new Seat("seat-c", "approve"));
    expect(ten.pane.elapsed).toBe(REVIEW_FIRST_LIVENESS_MS);
    expect(ten.pane.seats).toBe(2);
    const note = ten.events.find((e) => e.phase === "note" && e.name === "review-no-verdict") as Extract<GateEvent, { phase: "note" }>;
    expect(note.payload).toMatchObject({ reviewer: "seat-b:seat-b", cause: "silent", seatAuthoredBytes: 10, infra: true });
    expect(ten.demotedReviewers.has("seat-b:seat-b")).toBe(true);
    expect(ten.events.find((e) => e.phase === "note" && e.name === "review-pool-demotion")).toMatchObject({ payload: { reviewer: "seat-b:seat-b", cause: "silent" } });
    expect(ten.row).toMatchObject({ pass: true, meta: { reviewRetry: { flaked: "seat-b:seat-b", retried: "seat-c:seat-c" } } });
    // two hundred bytes of its own by the beat: keeps its seat to the ceiling
    const producing = await clocked(PREAMBLE + "I am inspecting the diff. ".repeat(8).slice(0, 200));
    expect(producing.pane.elapsed).toBe(DEFAULT_CONFIG.review.timeoutMs);
    expect(producing.row.meta).toMatchObject({ cause: "truncated", seatAuthoredBytes: 200 });
    expect(producing.demotedReviewers.size).toBe(0);
    // headless: no beat — ten bytes then silence runs to the configured ceiling as truncated
    class TenByteHeadless extends FakeAdapter {
      override headlessCommand(): string { return "printf 'ten bytes!'; sleep 2"; }
    }
    const { repo, base } = repoWithCommit();
    const cfg = cfgWith(); cfg.review.timeoutMs = 300;
    const startedAt = Date.now();
    const headless = await reviewGate(mkTask(), repo, base, author, [chAuthor, { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" }], [new TenByteHeadless(scriptPath())], cfg);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    expect(headless.meta).toMatchObject({ cause: "truncated", seatAuthoredBytes: 10, timeoutMs: 300 });
  });

  test("test: a seat with two no-verdicts in one run leaves the rotation for the rest of that run with a review-pool-demotion note naming both causes, a seat whose vendor authored a carried commit inside the accumulated diff is excluded for that round while a seat of another vendor stays eligible, and the brief carries the task goal from the compiled graph under an authoritative heading and names the daemon's repository root path for specs and planning records when the worktree's spec text differs, so a rotation that re-seats a twice-silent seat, seats a vendor over its own commits, or briefs from the stale spec without the root fails", async () => {
    // run-scoped state, as the daemon holds it across tasks
    const demotedReviewers = new Set<string>();
    const reviewNoVerdicts = new Map<string, string[]>();
    const flaky = new Seat("seat-b", "no-verdict");
    const steady = new Seat("seat-c", "approve");
    const round = async (taskId: string, events: GateEvent[]) => {
      const { repo, base } = repoWithCommit();
      return runGates({ ...mkTask({ id: taskId }), gates: ["review"] }, await ctxFor(repo, base, [flaky, steady], { carriedFindings: [], demotedReviewers, reviewNoVerdicts }, events));
    };
    const first: GateEvent[] = [];
    await round("T1", first);
    expect(first.filter((e) => e.phase === "note" && e.name === "review-pool-demotion")).toEqual([]);
    const second: GateEvent[] = [];
    await round("T2", second);
    expect([flaky.calls, steady.calls]).toEqual([2, 2]);
    expect(second.filter((e) => e.phase === "note" && e.name === "review-pool-demotion"))
      .toMatchObject([{ payload: { reviewer: "seat-b:seat-b", causes: ["no-verdict", "no-verdict"] } }]);
    expect(demotedReviewers.has("seat-b:seat-b")).toBe(true);
    const third: GateEvent[] = [];
    const { results } = await round("T3", third);
    expect([flaky.calls, steady.calls]).toEqual([2, 3]);
    expect(results[0]).toMatchObject({ pass: true, meta: { reviewer: "seat-c:seat-c" } });
    expect(results[0]!.meta?.reviewRetry).toBeUndefined();

    // a seat whose vendor authored a carried commit is excluded for the round; another vendor stays eligible
    const own = new Seat("seat-b", "approve");
    const other = new Seat("seat-c", "approve");
    const r1 = repoWithCommit();
    const excluded = (await runGates({ ...mkTask(), gates: ["review"] }, await ctxFor(r1.repo, r1.base, [own, other], { carriedFindings: [], carriedAuthors: ["seat-b:seat-b"] }))).results[0]!;
    expect(excluded).toMatchObject({ pass: true, meta: { reviewer: "seat-c:seat-c" } });
    expect([own.calls, other.calls]).toEqual([0, 1]);
    const r2 = repoWithCommit();
    const seated = (await runGates({ ...mkTask(), gates: ["review"] }, await ctxFor(r2.repo, r2.base, [own, other], { carriedFindings: [], carriedAuthors: [] }))).results[0]!;
    expect(seated).toMatchObject({ pass: true, meta: { reviewer: "seat-b:seat-b" } });

    // the brief carries the compiled goal, authoritative, and names the daemon's repo root for specs
    const stale = "STALE goal text the integration branch still carries";
    const { repo, base } = repoWithCommit({ "a.txt": "x\n", "specs/v1-t.spec.md": `## T1\n- goal: ${stale}\n` });
    const root = mkdtempSync(join(tmpdir(), "tickmarkr-daemon-root-"));
    const artifactDir = join(root, ".tickmarkr", "runs", "run-x");
    mkdirSync(artifactDir, { recursive: true });
    const briefed = new Seat("seat-b", "approve");
    await runGates({ ...mkTask(), gates: ["review"] }, await ctxFor(repo, base, [briefed], { carriedFindings: [], artifactDir }));
    const brief = briefed.briefs[0]!;
    const heading = /^## Goal[^\n]*authoritative[^\n]*\n([^\n]+)/m.exec(brief);
    expect(heading?.[1]).toBe(GOAL);
    expect(brief).not.toContain(stale);
    const rootLine = brief.split("\n").find((l) => l.includes(root))!;
    expect(rootLine).toMatch(/specs\//);
    expect(rootLine).toMatch(/\.planning\//);
  });
});
