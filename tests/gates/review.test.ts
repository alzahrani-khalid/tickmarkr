import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { pickReviewer, type ReviewVerdict, reviewGate } from "../../src/gates/review.js";
import { extractJson } from "../../src/gates/llm.js";
import { runGates } from "../../src/gates/run-gates.js";
import { gitHead } from "../../src/run/git.js";
import { GATE_NAMES, validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

const mkTask = (over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], gates: [...GATE_NAMES], ...over }],
  }).tasks[0];

function fakeWith(extra: object): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-rev-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, ...extra }));
  return new FakeAdapter(p);
}

const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const CH: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
  { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
];

function repoWithCommit() {
  const repo = makeRepo({ "a.txt": "x\n" });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "a.txt"), "y\n");
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

describe("pickReviewer", () => {
  test("picks a different vendor; null when none exists", () => {
    expect(pickReviewer(author, CH)?.vendor).toBe("fake-b");
    expect(pickReviewer(author, [CH[0]])).toBeNull();
  });
});

// FLEET-05: same base model behind two harnesses (opencode zen vs ZAI Coding Plan) must not
// review each other. Model STRINGS differ (zai-coding-plan/glm-5.2 vs zai/glm-5.2) so vendor-only
// exclusion (mixed vs zhipu) admits the sibling — the diversity hole this plan closes.
const opencodeGlm: BillingChannel = { adapter: "opencode", vendor: "mixed", model: "zai-coding-plan/glm-5.2", channel: "sub", tier: "mid" };
const piGlm: BillingChannel = { adapter: "pi", vendor: "zhipu", model: "zai/glm-5.2", channel: "sub", tier: "mid" };
const codexSol: BillingChannel = { adapter: "codex", vendor: "openai", model: "gpt-5.6-sol", channel: "sub", tier: "frontier" };
const FLEET: BillingChannel[] = [opencodeGlm, piGlm, codexSol];
const asAuthor = (c: BillingChannel): Assignment => ({ adapter: c.adapter, model: c.model, channel: c.channel, tier: c.tier });

describe("pickReviewer model-identity diversity (FLEET-05)", () => {
  test("A: opencode zai-coding-plan/glm-5.2 author never draws its pi glm-5.2 sibling", () => {
    expect(pickReviewer(asAuthor(opencodeGlm), FLEET)?.adapter).toBe("codex");
    // only the two glm-5.2 siblings → same base model both harnesses → no diverse reviewer
    expect(pickReviewer(asAuthor(opencodeGlm), [opencodeGlm, piGlm])).toBeNull();
  });

  test("B: symmetry — pi glm-5.2 author never draws opencode glm-5.2", () => {
    expect(pickReviewer(asAuthor(piGlm), FLEET)?.adapter).toBe("codex");
    // bites the identity clause: only the two siblings, no frontier codex to mask it → null
    expect(pickReviewer(asAuthor(piGlm), [piGlm, opencodeGlm])).toBeNull();
  });

  test("C: author not resolvable in channel list ⇒ null (fail-closed, never admits-all)", () => {
    const ghost: Assignment = { adapter: "ghost", model: "ghost-1", channel: "sub", tier: "mid" };
    expect(pickReviewer(ghost, FLEET)).toBeNull();
  });

  test("E: vendor rule NOT weakened — same vendor excludes even with different models", () => {
    const a: BillingChannel = { adapter: "x", vendor: "same-vendor", model: "model-a", channel: "sub", tier: "mid" };
    const b: BillingChannel = { adapter: "x", vendor: "same-vendor", model: "model-b", channel: "sub", tier: "mid" };
    expect(pickReviewer(asAuthor(a), [a, b])).toBeNull();
  });
});

// v1.53 T2: review.prefer — reorders diversity-eligible channels only; the diversity filter runs first
// and preference can never widen or narrow the eligible set.
describe("pickReviewer review.prefer ranking (v1.53 T2)", () => {
  const chAuthor: BillingChannel = { adapter: "claude-code", vendor: "anthropic", model: "fable", channel: "sub", tier: "frontier" };
  const chOpus: BillingChannel = { adapter: "claude-code", vendor: "anthropic", model: "opus", channel: "sub", tier: "frontier" };
  const chCodexSol: BillingChannel = { adapter: "codex", vendor: "openai", model: "gpt-5.6-sol", channel: "sub", tier: "frontier" };
  const chCodexLuna: BillingChannel = { adapter: "codex", vendor: "openai", model: "gpt-5.6-luna", channel: "sub", tier: "cheap" };
  const chGrok: BillingChannel = { adapter: "grok", vendor: "xai", model: "grok-4.5", channel: "sub", tier: "mid" };
  const chKimi: BillingChannel = { adapter: "kimi", vendor: "moonshot", model: "kimi-code/k3", channel: "sub", tier: "frontier" };
  const chFrontierApi: BillingChannel = { adapter: "api-house", vendor: "houseapi", model: "big-1", channel: "api", tier: "frontier" };
  const me = asAuthor(chAuthor);

  test("a preferred channel outranks a higher tier unpreferred channel", () => {
    expect(pickReviewer(me, [chAuthor, chCodexSol, chGrok], [], ["grok"])).toBe(chGrok);
  });

  test("a preferred same vendor channel remains ineligible", () => {
    // opus shares the author's vendor (different model) — prefer cannot resurrect it
    expect(pickReviewer(me, [chAuthor, chOpus, chGrok], [], ["claude-code:opus"])).toBe(chGrok);
  });

  test("a preferred same base model channel remains ineligible", () => {
    // FLEET-05 glm-5.2 siblings: the pi channel is the author's base model behind another harness
    expect(pickReviewer(asAuthor(opencodeGlm), FLEET, [], ["pi:zai/glm-5.2"])).toBe(codexSol);
    // preference never widens eligibility: siblings-only pool still yields no reviewer
    expect(pickReviewer(asAuthor(opencodeGlm), [opencodeGlm, piGlm], [], ["pi:zai/glm-5.2"])).toBeNull();
  });

  test("earlier prefer entries outrank later prefer entries", () => {
    expect(pickReviewer(me, [chAuthor, chCodexSol, chGrok], [], ["grok", "codex"])).toBe(chGrok);
    expect(pickReviewer(me, [chAuthor, chCodexSol, chGrok], [], ["codex", "grok"])).toBe(chCodexSol);
  });

  test("an adapter only entry matches every channel of that adapter", () => {
    // both codex channels rank ahead of unpreferred frontier kimi; tier sort still orders within codex
    expect(pickReviewer(me, [chAuthor, chKimi, chCodexSol, chCodexLuna], [], ["codex"])).toBe(chCodexSol);
    // with sol excluded, cheap luna was matched by the same entry — still beats frontier kimi
    expect(pickReviewer(me, [chAuthor, chKimi, chCodexSol, chCodexLuna], ["codex:gpt-5.6-sol"], ["codex"])).toBe(chCodexLuna);
  });

  test("an entry matching no eligible channel leaves the pick unchanged", () => {
    const pool = [chAuthor, chCodexSol, chCodexLuna, chGrok, chKimi];
    const noPref = pickReviewer(me, pool);
    expect(noPref).not.toBeNull();
    expect(pickReviewer(me, pool, [], ["ghost-adapter", "codex:no-such-model"])).toBe(noPref);
  });

  test("an absent prefer list preserves the existing tier and cost order", () => {
    // tier dominates cost: frontier api beats mid sub
    expect(pickReviewer(me, [chAuthor, chGrok, chFrontierApi])).toBe(chFrontierApi);
    // equal tier: sub (zero marginal cost) beats api
    expect(pickReviewer(me, [chAuthor, chFrontierApi, chKimi])).toBe(chKimi);
  });
});

describe("reviewGate fail-closed on unreachable/empty reviewer pool (FLEET-05)", () => {
  // Gate-level fleet routes every channel through the `fake` adapter so a WRONGLY-picked reviewer
  // (shipped bug) actually RUNS and returns approve → pass:true — making the `pass:false` assertion
  // bite for the real reason, not a throw on an unregistered adapter id (falsification discipline).
  const gOpencode: BillingChannel = { adapter: "fake", vendor: "mixed", model: "zai-coding-plan/glm-5.2", channel: "sub", tier: "mid" };
  const gPi: BillingChannel = { adapter: "fake", vendor: "zhipu", model: "zai/glm-5.2", channel: "sub", tier: "mid" };
  const gCodex: BillingChannel = { adapter: "fake", vendor: "openai", model: "gpt-5.6-sol", channel: "sub", tier: "frontier" };
  const gFleet = [gOpencode, gPi, gCodex];

  test("C-gate: ghost author fails review closed under DEFAULT_CONFIG (review.required)", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, issues: [] } });
    const ghost: Assignment = { adapter: "ghost", model: "ghost-1", channel: "sub", tier: "mid" };
    const r = await reviewGate(mkTask(), repo, base, ghost, gFleet, [fake], DEFAULT_CONFIG);
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/no.*reviewer/i);
  });

  test("D: model-identity-emptied pool → fail-closed by default, waivable by config", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, issues: [] } });
    const siblings = [gOpencode, gPi];
    const r1 = await reviewGate(mkTask(), repo, base, asAuthor(gOpencode), siblings, [fake], DEFAULT_CONFIG);
    expect(r1.pass).toBe(false);
    expect(r1.details).toMatch(/no.*reviewer/i);
    const lax = structuredClone(DEFAULT_CONFIG);
    lax.review.required = false;
    const r2 = await reviewGate(mkTask(), repo, base, asAuthor(gOpencode), siblings, [fake], lax);
    expect(r2.pass).toBe(true);
    expect(r2.details).toMatch(/no cross-vendor/i);
  });
});

describe("FLEET-06 parsing half — synthetic pi-shaped extractJson (no pi invoked)", () => {
  // pi wraps output in an update banner + ANSI-colored prose, then the trailing verdict, then more
  // brace-bearing chrome. This fixture pins banner/ANSI tolerance; pi inference is DOWN, so this is
  // the ONLY FLEET-06 coverage available now — the live half is gated plan 20-02.
  const ESC = "";
  test("recovers the verdict past banner, ANSI prose, and trailing brace-bearing chrome", () => {
    const raw = [
      "pi v0.80.3 — a newer version (0.81.0) is available, run `pi upgrade`",
      `${ESC}[1mAnalyzing diff...${ESC}[0m`,
      "diff --git a/x.ts b/x.ts\n".repeat(80),
      `${ESC}[33msome colored prose about the change${ESC}[0m`,
      '{"approve": false, "issues": ["x"]}',
      "Done. Session state saved to {~/.pi/sessions/abc}. Thank you {user}!",
    ].join("\n");
    const v = extractJson<ReviewVerdict>(raw);
    expect(v).toEqual({ approve: false, issues: ["x"] });
  });

  test("ANSI escapes INSIDE the JSON object → null (known limit, fail-closed not crash)", () => {
    const raw = `prose\n{"approve": ${ESC}[1mfalse${ESC}[0m, "issues": []}\nbye`;
    expect(extractJson<ReviewVerdict>(raw)).toBeNull();
  });
});

describe("FLEET-07 judge default pin", () => {
  test("DEFAULT_CONFIG.judge is claude-code:fable, frontier tier, never pi", () => {
    // pi is selectable via the config-generic `judge:` overlay surface, never auto-promoted:
    // GLM-5.2's judge evidence is thin and the unbounded risk is leniency, not malformed JSON.
    expect(DEFAULT_CONFIG.judge).toEqual({ adapter: "claude-code", model: "fable" });
    const { adapter, model } = DEFAULT_CONFIG.judge;
    expect(DEFAULT_CONFIG.tiers[adapter].models[model]).toBe("frontier");
    expect(adapter).not.toBe("pi");
  });
});

describe("reviewGate", () => {
  test("skips below complexity threshold", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({});
    const r = await reviewGate(mkTask({ complexity: 3 }), repo, base, author, CH, [fake], DEFAULT_CONFIG);
    expect(r.pass).toBe(true);
    expect(r.details).toMatch(/skipped/i);
    expect(r.meta).toEqual({ skipped: true });
  });

  // v1.64 gate-integrity: the cross-vendor review prompt carries the same completion-faking checklist
  // as the acceptance judge, so reviewers hunt the concrete shortcuts by name.
  test("the review prompt names the completion faking shortcuts as an explicit checklist", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, issues: [] } });
    let capturedPrompt = "";
    const orig = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (promptFile, model) => {
      capturedPrompt = readFileSync(promptFile, "utf8");
      return orig(promptFile, model);
    };
    await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG);
    expect(capturedPrompt).toContain("Completion-faking checklist");
    for (const shortcut of ["hardcoded-result", "test-weakening", "vacuous-assertion", "fixture-overfit", "self-mocking", "check-bypass"]) {
      expect(capturedPrompt).toContain(shortcut);
    }
    expect(capturedPrompt).toMatch(/criterion fails.*name which shortcut/i);
  });

  test("approve → pass; request-changes → fail with issues", async () => {
    const { repo, base } = repoWithCommit();
    const ok = fakeWith({ review: { approve: true, issues: [] } });
    expect((await reviewGate(mkTask(), repo, base, author, CH, [ok], DEFAULT_CONFIG)).pass).toBe(true);
    const bad = fakeWith({ review: { approve: false, issues: ["off-by-one in retry loop"] } });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [bad], DEFAULT_CONFIG);
    expect(r.pass).toBe(false);
    expect(r.details).toContain("off-by-one");
  });

  test("approve:true with issues fails as a parsed verdict inconsistency", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, issues: ["still broken"] } });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG);
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/review verdict inconsistent: approve=true requires issues to be empty/i);
    expect(r.details).not.toMatch(/unparseable/i);
  });

  test("approve:true without an issues array is unparseable and fails closed", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true } });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG);
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/unparseable/i);
  });

  test("approve:false without any issue fails naming the parsed inconsistency", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: false, issues: [] } });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG);
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/review verdict inconsistent: approve=false requires at least one issue/i);
    expect(r.details).not.toMatch(/unparseable/i);
  });

  test("a non-string issue fails as a parsed verdict inconsistency", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, issues: [42] } });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG);
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/issues\[0\] must be a string/i);
    expect(r.details).not.toMatch(/unparseable/i);
  });

  test("diff over gates.diffCap fails closed before any reviewer call", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, issues: [] } });
    const command = fake.headlessCommand.bind(fake);
    let calls = 0;
    fake.headlessCommand = (...args) => { calls++; return command(...args); };
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.gates.diffCap = 1;
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], cfg);
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/diff exceeds verifiable cap/i);
    expect(r.details).toMatch(/split the task/i);
    expect(r.details).toMatch(/raise gates\.diffCap/i);
    expect(r.meta).toEqual({ park: "human" });
    expect(calls).toBe(0);
  });

  test("cfg.review.prefer steers the reviewer pick through the config seam", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, issues: [] } });
    // all channels route through the fake adapter so the preferred pick actually RUNS
    const pool: BillingChannel[] = [
      { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
      { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "sub", tier: "frontier" },
      { adapter: "fake", vendor: "fake-c", model: "fake-3", channel: "sub", tier: "mid" },
    ];
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.review.prefer = ["fake:fake-3"];
    const r = await reviewGate(mkTask(), repo, base, author, pool, [fake], cfg);
    expect(r.pass).toBe(true);
    expect(r.meta).toEqual({ reviewer: "fake:fake-3" });
  });

  test("no cross-vendor channel: required → fail; not required → pass-with-warning", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({});
    const r1 = await reviewGate(mkTask(), repo, base, author, [CH[0]], [fake], DEFAULT_CONFIG);
    expect(r1.pass).toBe(false);
    const lax = structuredClone(DEFAULT_CONFIG);
    lax.review.required = false;
    const r2 = await reviewGate(mkTask(), repo, base, author, [CH[0]], [fake], lax);
    expect(r2.pass).toBe(true);
    expect(r2.details).toMatch(/no cross-vendor/i);
  });
});

describe("runGates ordering + short-circuit", () => {
  test("evidence failure stops before acceptance/review (no LLM spend on empty work)", async () => {
    const repo = makeRepo({ "a.txt": "x\n" }); // no commits after base
    const base = await gitHead(repo);
    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] } });
    const { results } = await runGates(mkTask(), {
      worktree: repo, baseRef: base, author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: {}, baseline: await captureBaseline(repo, {}),
      channels: CH, adapters: [fake], cfg: DEFAULT_CONFIG,
    });
    expect(results.at(-1)).toMatchObject({ gate: "evidence", pass: false });
    expect(results.map((r) => r.gate)).not.toContain("acceptance");
  });

  test("full pass runs all enabled gates in spec order", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] } });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const { results, commits } = await runGates(mkTask({ files: [] }), {
      worktree: repo, baseRef: base, author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: {}, baseline: await captureBaseline(repo, {}),
      channels: CH, adapters: [fake], cfg,
    });
    expect(results.every((r) => r.pass)).toBe(true);
    // build/test/lint are explicit skips (commands: {}), then the real gates in spec order
    expect(results.map((r) => r.gate)).toEqual(["build", "test", "lint", "evidence", "scope", "acceptance", "review"]);
    expect(commits).toHaveLength(1);
  });
});

describe("v1.1 reviewer failover", () => {
  test("pickReviewer skips excluded channels; exhausted exclusions → null", () => {
    expect(pickReviewer(author, CH)?.model).toBe("fake-2");
    expect(pickReviewer(author, CH, ["fake:fake-2"])).toBeNull();
  });

  test("unparseable review carries the reviewer channel in meta (failover signal)", async () => {
    const { repo, base } = repoWithCommit();
    const bad = fakeWith({ review: "gibberish — not a verdict" });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [bad], DEFAULT_CONFIG);
    expect(r.pass).toBe(false);
    expect(r.meta).toEqual({ reviewer: "fake:fake-2" });
  });

  test("excludeReviewers reaches reviewGate: excluded vendor → no-reviewer path", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, issues: [] } });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG, undefined, ["fake:fake-2"]);
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/no cross-vendor reviewer available/);
  });
});
