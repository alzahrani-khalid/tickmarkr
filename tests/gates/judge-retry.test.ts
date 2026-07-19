// Phase 47 (GATE-09): judge-flake attribution — run-gates-level oracles.
// An unparseable acceptance-judge verdict retries the JUDGE exactly once on a failover channel inside
// runGates, before any failing result reaches the daemon. The flaked first verdict NEVER enters results.
// Detection is meta-only (acceptance.ts:42 extractJson→null shape-check failure → meta.unparseable:true),
// never string-matching details (D-03). Fix lives in src/gates/run-gates.ts (straight-line, exactly-once).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { type GateEvent, runGates } from "../../src/gates/run-gates.js";
import { extractVerdictJson, runHeadless, verdictNonceLine } from "../../src/gates/llm.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

const mkTask = (over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], ...over }],
  }).tasks[0];

function fakeWith(extra: object): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-judge-retry-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, ...extra }));
  return new FakeAdapter(p);
}

const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
// the two-channel fake fleet: fake-1 (fake-a, sub) + fake-2 (fake-b, api) — a failover judge exists by construction
const CH_BOTH: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
  { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
];
const CH_ONE: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
];
const noResult = { ok: true, summary: "", deviations: [] as string[], raw: "" };
const JUDGE_GATES = ["build", "test", "lint", "evidence", "scope", "acceptance"];

function repoWithCommit() {
  const repo = makeRepo({ "a.txt": "x\n" });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "a.txt"), "y\n");
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

async function ctxFor(
  repo: string, base: string, fake: FakeAdapter,
  opts: { channels?: BillingChannel[]; judgeModel?: string } = {},
) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge.adapter = "fake";
  cfg.judge.model = opts.judgeModel ?? "fake-1";
  return {
    worktree: repo, baseRef: base, author,
    result: noResult,
    commands: {} as Record<string, string>,
    baseline: await captureBaseline(repo, {}),
    channels: opts.channels ?? CH_BOTH, adapters: [fake], cfg,
  };
}

function traceOf(onGate?: (e: GateEvent) => void | Promise<void>) {
  const trace: GateEvent[] = [];
  const hook = async (e: GateEvent) => { trace.push(e); await onGate?.(e); };
  return { trace, hook };
}

const PASS = { pass: true, criteria: [{ criterion: "c1", met: true, reason: "r" }] };
const FAIL = { pass: false, criteria: [{ criterion: "c1", met: false, reason: "nope" }] };

describe("GATE-09 judge-flake retry (run-gates level)", () => {
  test("flake-then-good: judge retried once on failover, final verdict is the parsed pass", async () => {
    const { repo, base } = repoWithCommit();
    // SC-1 shape (vendored run-20260711-185020 P43-03 L70-72): garbage first verdict, then a good one.
    const fake = fakeWith({ judge: ["judge output garbage — not a verdict", PASS] });
    const { trace, hook } = traceOf();
    const { results } = await runGates(
      mkTask({ gates: JUDGE_GATES, files: [] }),
      { ...(await ctxFor(repo, base, fake)), onGate: hook },
    );
    // exactly ONE acceptance result recorded — the flaked first verdict never enters results (Pitfall 5)
    const acc = results.filter((r) => r.gate === "acceptance");
    expect(acc).toHaveLength(1);
    expect(acc[0].pass).toBe(true);
    // failover attribution: flaked on fake-1, retried on fake-2 (pickReviewer sort over channels minus flaked)
    expect(acc[0].meta).toMatchObject({ judgeRetry: { flaked: "fake:fake-1", retried: "fake:fake-2" } });
    // single-recorded-result pin: exactly one onGate end for acceptance (no false journal event)
    expect(trace.filter((e) => e.phase === "end" && e.gate === "acceptance")).toHaveLength(1);
  });

  test("same-channel fallback: single-channel fleet retries on the flaked channel (D-03)", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ judge: ["judge output garbage", PASS] });
    const { results } = await runGates(
      mkTask({ gates: JUDGE_GATES, files: [] }),
      { ...(await ctxFor(repo, base, fake, { channels: CH_ONE })) }, // empty candidate set → same channel
    );
    const acc = results.filter((r) => r.gate === "acceptance");
    expect(acc).toHaveLength(1);
    expect(acc[0].pass).toBe(true);
    // equal keys = honest attribution: retried on the same channel — no alternative (documented fallback)
    expect(acc[0].meta).toMatchObject({ judgeRetry: { flaked: "fake:fake-1", retried: "fake:fake-1" } });
  });

  test("double-garbage fails closed exactly as today (SC-2)", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ judge: ["garbage one", "garbage two"] });
    const { results } = await runGates(
      mkTask({ gates: JUDGE_GATES, files: [] }),
      { ...(await ctxFor(repo, base, fake)) },
    );
    const acc = results.filter((r) => r.gate === "acceptance");
    expect(acc).toHaveLength(1);
    expect(acc[0].pass).toBe(false); // fail-closed intact: two garbage verdicts never become a pass
    expect(acc[0].details).toMatch(/unparseable — failing closed/); // today's fail-closed message unchanged
    // the final result carries both channels + the unparseable flag (the retry also flaked)
    expect(acc[0].meta).toMatchObject({
      unparseable: true,
      judgeRetry: { flaked: "fake:fake-1", retried: "fake:fake-2" },
    });
  });

  test("parseable pass:false is NEVER retried (SC-3 fence — the REQUIREMENTS.md out-of-scope line)", async () => {
    // Fixture shape = the vendored run-20260712-010826 P45-01 attempt-0 parseable pass:false (byte-match
    // miss) — a REAL acceptance failure. The flake signal is extractJson→null (acceptance.ts:42); a parsed
    // verdict is never one. A would-be pass served as element 1 must NEVER be consumed.
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ judge: [FAIL, PASS] }); // parseable fail first; the pass must never be served
    const { results } = await runGates(
      mkTask({ gates: JUDGE_GATES, files: [] }),
      { ...(await ctxFor(repo, base, fake)) },
    );
    const acc = results.filter((r) => r.gate === "acceptance");
    expect(acc).toHaveLength(1);
    expect(acc[0].pass).toBe(false); // parseable fail → worker escalates exactly as today
    expect(acc[0].meta?.judgeRetry).toBeUndefined(); // no retry — the change is confined to the unparseable branch
    expect(acc[0].meta?.unparseable).toBeUndefined();
  });

  test("parsed inconsistent verdict fails without judge failover", async () => {
    const { repo, base } = repoWithCommit();
    const inconsistent = { pass: true, criteria: [{ criterion: "c1", met: false, reason: "contradiction" }] };
    const fake = fakeWith({ judge: [inconsistent, PASS] });
    const { results } = await runGates(
      mkTask({ gates: JUDGE_GATES, files: [] }),
      { ...(await ctxFor(repo, base, fake)) },
    );
    const acc = results.filter((r) => r.gate === "acceptance");
    expect(acc).toHaveLength(1);
    expect(acc[0].pass).toBe(false);
    expect(acc[0].details).toMatch(/pass=true contradicts unmet criterion c1/i);
    expect(acc[0].meta?.judgeRetry).toBeUndefined();
    expect(acc[0].meta?.unparseable).toBeUndefined();
  });

  test("review runs after flake-then-pass (research Open Question 2, resolved YES)", async () => {
    // Previously an acceptance fail short-circuited before review. After a successful retry the work gets
    // its review — pinned explicitly so nobody optimizes review away on the retry path.
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ judge: ["garbage", PASS], review: { approve: true, issues: [] } });
    const { results } = await runGates(
      mkTask({ gates: [...JUDGE_GATES, "review"], files: [], complexity: 8 }),
      { ...(await ctxFor(repo, base, fake)) },
    );
    const acc = results.filter((r) => r.gate === "acceptance");
    expect(acc).toHaveLength(1);
    expect(acc[0].pass).toBe(true); // flake-then-pass
    // review result is recorded after the retried acceptance pass (complexity 8 ≥ threshold 7)
    const rev = results.filter((r) => r.gate === "review");
    expect(rev).toHaveLength(1);
    expect(rev[0].pass).toBe(true);
  });
});

describe("GATE-09 fake judge array — counter advances ONLY on TICKMARKR-JUDGE prompts (Pitfall 3)", () => {
  test("a review prompt between two judge prompts does NOT advance the judge counter", async () => {
    // judge: [v0, v1, v2-never-served-early]. judge prompt → v0; review prompt → review verdict;
    // judge prompt → v1 (NOT v2). If review bumped the counter, the third call would skip to v2.
    const fake = fakeWith({
      judge: [{ pass: true, criteria: [{ criterion: "v0", met: true, reason: "zero" }] },
              { pass: true, criteria: [{ criterion: "v1", met: true, reason: "one" }] },
              { pass: true, criteria: [{ criterion: "v2", met: true, reason: "two" }] }],
      review: { approve: true, issues: [] },
    });
    const first = await runHeadless(fake, "fake-1", "TICKMARKR-JUDGE\njudge this", "/tmp");
    expect(first).toContain('"v0"');
    const rev = await runHeadless(fake, "fake-1", "TICKMARKR-REVIEW\nreview this", "/tmp");
    expect(rev).toContain('"approve"'); // review verdict, not a judge verdict
    const second = await runHeadless(fake, "fake-1", "TICKMARKR-JUDGE\njudge again", "/tmp");
    expect(second).toContain('"v1"'); // counter at 1 — review did NOT advance it
    expect(second).not.toContain('"v2"');
  });

  test("empty scripted passes synthesize prompt criteria; non-empty verdicts stay verbatim", async () => {
    const prompt = `TICKMARKR-JUDGE
## Acceptance criteria (judge)
- first
- second

## Diff (vs base)
`;
    const empty = fakeWith({ judge: { pass: true, criteria: [] } });
    const testNonce = "ab12cd34";
    const synthesized = extractVerdictJson<{ criteria: unknown[]; nonce?: string }>(
      await runHeadless(empty, "fake-1", `${prompt}\n${verdictNonceLine(testNonce)}`, "/tmp"),
      testNonce,
    );
    expect(synthesized?.criteria).toEqual([
      { criterion: "first", met: true, reason: "scripted fake pass" },
      { criterion: "second", met: true, reason: "scripted fake pass" },
    ]);

    const inconsistent = { pass: true, criteria: [{ criterion: "first", met: false, reason: "explicit" }] };
    const nonEmpty = fakeWith({ judge: inconsistent });
    const got = extractVerdictJson<typeof inconsistent & { nonce?: string }>(
      await runHeadless(nonEmpty, "fake-1", `${prompt}\nVERDICT_NONCE: cafebabe`, "/tmp"),
      "cafebabe",
    );
    expect(got).toEqual(inconsistent);
  });
});
