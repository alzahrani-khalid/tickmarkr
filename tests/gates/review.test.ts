import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import {
  goalDensityErrors, reviewParticipationErrors, surfaceErrors, symbolOwnershipErrors, taskUnitContractErrors,
} from "../../src/compile/collateral.js";
import { CompileError } from "../../src/compile/common.js";
import { compileSource } from "../../src/compile/index.js";
import { compileNative } from "../../src/compile/native.js";
import { criticalPathHits, declaredReviewPolicy, DEFAULT_CONFIG, effectiveReviewPolicy, isReviewLeafPath, repoOverlayPath } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { pickReviewer, type ReviewVerdict, reviewGate } from "../../src/gates/review.js";
import { extractJson } from "../../src/gates/llm.js";
import { runGates } from "../../src/gates/run-gates.js";
import { gitHead } from "../../src/run/git.js";
import { deriveSignalBasis } from "../../src/run/journal.js";
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

// ── R3 review participation (OVERSEER-RULING-20260731-velocity; OBS-186) ───────────────────────
// Participation is keyed on PATHS at both ends: what the task DECLARES (the compiler's assignment)
// and what its diff ACTUALLY touched (the gate's promotion). complexityThreshold is retired — it
// capped participation at a number the authoring law forbade tasks from reaching, so the gate was
// unreachable by construction while `required: true` claimed the opposite.

/**
 * A repo whose HEAD commit touches exactly `files`, so the gate's promotion test has real evidence.
 * `seed` lands in the BASE commit, which is what lets a fixture prove a version MIRROR: a manifest
 * that already exists and whose diff moves only the version line, versus one that moves more.
 */
function repoWithDiff(files: Record<string, string>, seed: Record<string, string> = {}) {
  const repo = makeRepo({ "seed.txt": "x\n", ...seed });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

/** Counts reviewer dispatches so "no cross-vendor review ran" is proven, never inferred. */
function countingFake(extra: object): { fake: FakeAdapter; calls: () => number } {
  const fake = fakeWith(extra);
  let calls = 0;
  const command = fake.headlessCommand.bind(fake);
  fake.headlessCommand = (...args) => { calls++; return command(...args); };
  return { fake, calls: () => calls };
}

describe("R3 review participation is path-keyed", () => {
  test("test: a docs-leaf task is judge-only until its diff touches a source path at which point the gate promotes it to full, and config can promote a judge-only task but never demote a full one, where docs-leaf is the closed class enumerated in the compiler, proven member by member — a markdown fixture, a CHANGELOG fixture, a RELEASING fixture, a version-mirror fixture — plus one adversarial non-member, a source fixture under docs/, that must promote", async () => {
    // ── the class is CLOSED and enumerated (config.ts REVIEW_LEAF_GLOBS) — walk it member by member,
    // each as a real committed diff, so membership is proven by the gate and not by reading the list.
    const MANIFEST = '{\n  "name": "x",\n  "version": "1.0.0",\n  "scripts": { "test": "vitest run" }\n}\n';
    const BUMPED = MANIFEST.replace("1.0.0", "1.85.0");
    const MEMBERS: Array<[string, Record<string, string>, Record<string, string>?]> = [
      ["a markdown page", { "docs/guide.md": "# guide\n" }],
      ["the changelog", { "CHANGELOG.md": "## next\n" }],
      ["the release runbook", { "RELEASING.md": "1. tag\n" }],
      // A MIRROR is a manifest that already existed and whose diff moved only the version line. A
      // brand-new manifest is not a bump, and neither is one that also moved `scripts`.
      ["a version mirror", { "package.json": BUMPED }, { "package.json": MANIFEST }],
    ];
    for (const [what, diff, seed] of MEMBERS) {
      const declared = Object.keys(diff);
      expect([what, declaredReviewPolicy(declared)]).toEqual([what, "judge-only"]);
      const { repo, base } = repoWithDiff(diff, seed);
      const { fake, calls } = countingFake({ review: { approve: true, issues: [] } });
      const r = await reviewGate(mkTask({ files: declared, complexity: 9 }), repo, base, author, CH, [fake], DEFAULT_CONFIG);
      expect([what, calls()]).toEqual([what, 0]);
      expect([what, r.meta?.verdict]).toEqual([what, "skipped"]);
    }

    // ── the adversarial non-members. The leaf class is decided POSITIVELY: under docs/ only a
    // documentation FORMAT is leaf work. A blacklist of source extensions is a list of the formats
    // someone thought of, and everything else — a component, a build file, a nested manifest, a
    // shebang script with no extension at all — inherits the skip. Each of these is a real committed
    // diff under a `docs/**` declaration, and every one of them must draw a reviewer.
    const NON_MEMBERS: Array<[string, string]> = [
      ["typescript under docs/", "docs/scripts/build.ts"],
      ["a vue component under docs/", "docs/widget.vue"],
      ["a svelte component under docs/", "docs/site.svelte"],
      ["an extensionless build file under docs/", "docs/Makefile"],
      ["a nested manifest under docs/", "docs/package.json"],
    ];
    for (const [what, path] of NON_MEMBERS) {
      expect([what, isReviewLeafPath(path)]).toEqual([what, false]);
      const adversarial = repoWithDiff({ [path]: "export const build = () => 1;\n" });
      const adv = countingFake({ review: { approve: true, issues: [] } });
      const advTask = mkTask({ files: ["docs/**"], complexity: 3 });
      expect([what, declaredReviewPolicy(advTask.files)]).toEqual([what, "judge-only"]); // the CLAIM is still leaf-shaped
      const promotedFromDocs = await reviewGate(advTask, adversarial.repo, adversarial.base, author, CH, [adv.fake], DEFAULT_CONFIG);
      expect([what, adv.calls()]).toEqual([what, 1]); // …and the EVIDENCE overrides it
      expect([what, promotedFromDocs.meta?.policy]).toEqual([what, "full"]);
      expect([what, promotedFromDocs.meta?.promotedBy]).toEqual([what, [path]]);
    }

    // ── the adversarial member: a root manifest IS in the class, but only as a version mirror. A
    // package.json diff that moves `scripts` is the gate command the whole battery runs — executable
    // configuration wearing a leaf-class path, which no path predicate can see for itself.
    const scripted = repoWithDiff(
      { "package.json": MANIFEST.replace("vitest run", "vitest run || true") },
      { "package.json": MANIFEST },
    );
    const s = countingFake({ review: { approve: true, issues: [] } });
    const scriptTask = mkTask({ files: ["package.json"], complexity: 3 });
    expect(declaredReviewPolicy(scriptTask.files)).toBe("judge-only"); // the CLAIM is leaf-shaped
    const promotedFromScripts = await reviewGate(scriptTask, scripted.repo, scripted.base, author, CH, [s.fake], DEFAULT_CONFIG);
    expect(s.calls()).toBe(1);
    expect(promotedFromScripts.meta?.policy).toBe("full");
    expect(promotedFromScripts.meta?.promotedBy).toEqual(["package.json"]);

    // ── the same task, leaf diff vs escaped diff: the claim never outranks what actually happened
    const task = mkTask({ files: ["docs/**", "CHANGELOG.md"], complexity: 3 });
    const leaf = repoWithDiff({ "docs/guide.md": "# guide\n", "CHANGELOG.md": "## next\n" });
    const a = countingFake({ review: { approve: true, issues: [] } });
    const declined = await reviewGate(task, leaf.repo, leaf.base, author, CH, [a.fake], DEFAULT_CONFIG);
    expect(a.calls()).toBe(0);
    expect(declined.meta?.verdict).toBe("skipped");

    const escaped = repoWithDiff({ "docs/guide.md": "# guide\n", "src/run/daemon.ts": "export const x = 1;\n" });
    const b = countingFake({ review: { approve: true, issues: [] } });
    const promoted = await reviewGate(task, escaped.repo, escaped.base, author, CH, [b.fake], DEFAULT_CONFIG);
    expect(b.calls()).toBe(1); // a real cross-vendor reviewer ran
    expect(promoted.pass).toBe(true);
    expect(promoted.meta?.verdict).toBeUndefined();
    expect(promoted.meta?.policy).toBe("full");
    expect(promoted.meta?.promotedFrom).toBe("judge-only");
    expect(promoted.meta?.promotedBy).toEqual(["src/run/daemon.ts"]);
    expect(promoted.meta?.reviewer).toBe("fake:fake-2");

    // ── the operator's floor: monotone. It may RAISE a judge-only task and can never lower a full one.
    const sourceTask = mkTask({ files: ["src/gates/review.ts", "tests/gates/review.test.ts"] });
    expect(declaredReviewPolicy(sourceTask.files)).toBe("full");
    const raised = structuredClone(DEFAULT_CONFIG);
    raised.review.policy = "full";
    const lowered = structuredClone(DEFAULT_CONFIG);
    lowered.review.policy = "judge-only";
    expect(effectiveReviewPolicy(task.files, raised.review)).toBe("full"); // raised
    expect(effectiveReviewPolicy(sourceTask.files, lowered.review)).toBe("full"); // never lowered
    expect(effectiveReviewPolicy(task.files, lowered.review)).toBe("judge-only"); // the floor is neutral

    // …and the raise reaches the GATE: the same leaf-only diff now draws a real cross-vendor reviewer
    const c = countingFake({ review: { approve: true, issues: [] } });
    const raisedRun = await reviewGate(task, leaf.repo, leaf.base, author, CH, [c.fake], raised);
    expect(c.calls()).toBe(1);
    expect(raisedRun.pass).toBe(true);
    expect(raisedRun.meta?.policy).toBe("full");
    expect(raisedRun.meta?.verdict).toBeUndefined();

    // …and the demotion attempt cannot silence the review of a source task
    const d = countingFake({ review: { approve: true, issues: [] } });
    const stillFull = await reviewGate(sourceTask, leaf.repo, leaf.base, author, CH, [d.fake], lowered);
    expect(d.calls()).toBe(1);
    expect(stillFull.meta?.policy).toBe("full");
    expect(stillFull.meta?.verdict).toBeUndefined();
  }, 30_000);

  test("test: a task intersecting criticalPaths that would skip review under the active config fails compile, and the merged compile lints still reject their calibration corpus unchanged", async () => {
    // A version-bump task: every declared path is version-mirror leaf work, so the compiler assigns
    // judge-only — and package.json carries the gate commands, so this operator made it critical.
    const bump = [{ id: "T1", files: ["package.json", "package-lock.json"] }];
    const active = { ...DEFAULT_CONFIG.review, criticalPaths: ["package.json"] };

    const errors = reviewParticipationErrors(bump, active);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/T1/);
    expect(errors[0]).toMatch(/package\.json/);
    expect(errors[0]).toMatch(/judge-only/);
    expect(errors[0]).toMatch(/review\.criticalPaths/);
    // the same task is silent when the critical path does not reach it, and when review is full
    expect(reviewParticipationErrors(bump, { ...DEFAULT_CONFIG.review, criticalPaths: ["src/run/**"] })).toEqual([]);
    expect(reviewParticipationErrors(bump, { ...active, policy: "full" as const })).toEqual([]);

    // ── INTERSECTION, not containment. Two globs can overlap without either matching the other as a
    // literal string: `docs/security/README.md` satisfies both of these, and a directional test sees
    // neither side contain the other — so the task compiled clean and skipped the review of a path the
    // operator declared critical. The non-containment fixture is the whole point of the pair.
    const nested = [{ id: "T2", files: ["docs/**/README.md"] }];
    const overlapping = { ...DEFAULT_CONFIG.review, criticalPaths: ["docs/security/*.md"] };
    expect(criticalPathHits(["docs/**/README.md"], ["docs/security/*.md"])).toEqual(["docs/**/README.md"]);
    expect(reviewParticipationErrors(nested, overlapping)).toHaveLength(1);
    // …and it does not flag a pair whose literal tails prove they cannot meet — over-flagging is the
    // safe direction, but a lint that flags everything is one an author learns to ignore.
    expect(criticalPathHits(["docs/**/*.md"], ["src/**/*.ts"])).toEqual([]);
    expect(criticalPathHits(["docs/**/*.md"], ["docs/**/*.png"])).toEqual([]);

    // ── the SECOND participation switch. `review.policy` is monotone by construction, but
    // `gates.byShape.<shape>.review: false` omits the review gate outright (src/gates/run-gates.ts
    // `enabled`) — a demotion arriving through a door the policy join never saw. A source task cannot
    // be demoted by it, and a judge-only task cannot use it to silence a critical path.
    const sourceTask = [{ id: "T3", shape: "implement" as const, files: ["src/gates/review.ts"] }];
    const shapeOff = { ...DEFAULT_CONFIG.review, byShape: { implement: { review: false } } };
    const demotion = reviewParticipationErrors(sourceTask, shapeOff);
    expect(demotion).toHaveLength(1);
    expect(demotion[0]).toMatch(/gates\.byShape\.implement\.review: false/);
    expect(demotion[0]).toMatch(/never lower one/);
    expect(reviewParticipationErrors(sourceTask, DEFAULT_CONFIG.review)).toEqual([]); // …without it, silent
    // a LEAF task under the same override still fails when it reaches a critical path
    const leafOff = { ...active, byShape: { docs: { review: false } } };
    expect(reviewParticipationErrors([{ id: "T4", shape: "docs" as const, files: ["package.json"] }], leafOff))
      .toHaveLength(1);

    // ── the shipped criticalPaths are a FLOOR, not a default a config replaces: this lint resolves its
    // config from a root the compile seam cannot always name, so a config naming its own critical paths
    // may never lower enforcement below what tickmarkr ships.
    expect(reviewParticipationErrors(sourceTask, { ...shapeOff, criticalPaths: ["docs/**"] })).toHaveLength(1);

    // …and it is a COMPILE failure, not a warning: compiled from a repo whose own config declares it.
    // (The overlay path comes from the product's own resolver — HYG-06 forbids a test naming the
    // operator state directory beside a live working directory.)
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-crit-"));
    const overlay = repoOverlayPath(repo);
    mkdirSync(dirname(overlay), { recursive: true });
    writeFileSync(overlay, "review:\n  criticalPaths: [package.json]\n");
    // The root-bearing seam itself, named explicitly — not `process.chdir`. `taskUnitContractErrors`
    // takes the repo root as an argument, and THAT is what has to resolve the repo's own config.
    expect(taskUnitContractErrors(bump, repo)).toContain(errors[0]);
    // …and a root that is NOT this repo does not see this repo's critical paths. KNOWN GAP: the seam
    // in src/compile/index.ts drops compileSource's `root`, so a programmatic compile from a foreign
    // cwd lands here. It is bounded, not open: the shipped floor still bites (above), and the review
    // GATE — handed the run's real config — refuses to skip a critical path itself (below).
    const foreign = mkdtempSync(join(tmpdir(), "tickmarkr-foreign-"));
    expect(taskUnitContractErrors(bump, foreign)).toEqual([]);

    // …the backstop that makes that gap bounded. The GATE is handed the run's real config, so a
    // critical path that reached dispatch is reviewed whatever the compile lint resolved: the same
    // leaf-class version bump the lint above missed still promotes to a full cross-vendor review here.
    const MANIFEST = '{\n  "name": "x",\n  "version": "1.0.0"\n}\n';
    const mirror = repoWithDiff({ "package.json": MANIFEST.replace("1.0.0", "1.85.0") }, { "package.json": MANIFEST });
    const criticalCfg = structuredClone(DEFAULT_CONFIG);
    criticalCfg.review.criticalPaths = ["package.json"];
    const backstop = countingFake({ review: { approve: true, issues: [] } });
    const gated = await reviewGate(
      mkTask({ files: ["package.json"] }), mirror.repo, mirror.base, author, CH, [backstop.fake], criticalCfg);
    expect(backstop.calls()).toBe(1);
    expect(gated.meta?.policy).toBe("full");
    expect(gated.meta?.verdict).toBeUndefined();
    // …and the SHIPPED floor needs no config at all: a diff landing src/run/** never skips
    const shipped = repoWithDiff({ "docs/guide.md": "# guide\n", "src/run/x.ts": "export const x = 1;\n" });
    const floor = countingFake({ review: { approve: true, issues: [] } });
    const onFloor = await reviewGate(
      mkTask({ files: ["docs/**"] }), shipped.repo, shipped.base, author, CH, [floor.fake], DEFAULT_CONFIG);
    expect(floor.calls()).toBe(1);
    expect(onFloor.meta?.policy).toBe("full");

    const spec = join(repo, "bump.spec.md");
    writeFileSync(
      spec,
      "<!-- tickmarkr:spec -->\n## T1: bump the shipped version\n- files: package.json, package-lock.json\n"
      + "- acceptance:\n  - judge: the shipped version matches the tag\n",
    );
    const cwd = process.cwd();
    try {
      process.chdir(repo);
      expect(() => compileSource(spec, "native")).toThrow(CompileError);
      expect(() => compileSource(spec, "native")).toThrow(/would skip cross-vendor review/);
    } finally {
      process.chdir(cwd);
    }

    // …and MERGING this lint into taskUnitContractErrors left the other lints' verdicts on the R2
    // calibration corpus byte-identical. A new lint that quietly changed what the pinned corpus
    // reports would be indistinguishable from a regression in the lints it joined.
    const root = process.cwd();
    const v184 = compileNative("specs/v1.84-pointer.spec.md");
    const t1 = v184.tasks.find((t) => t.id === "T1")!;
    const originalT1 = { ...t1, files: t1.files.filter((f) => f !== "src/tui/cockpit/layout.ts" && f !== "tests/cockpit/layout.test.ts") };
    const withParticipation = taskUnitContractErrors([originalT1], root, active);
    const lintsOnly = [
      ...surfaceErrors([originalT1]),
      ...goalDensityErrors([originalT1]),
      ...symbolOwnershipErrors([originalT1], root),
    ];
    expect(lintsOnly).toHaveLength(2); // the corpus's pinned rejections: surface + symbol ownership
    expect(withParticipation).toEqual(lintsOnly); // …and participation adds nothing to them
    // the corpus's PASSING half stays passing under the merged lints, participation included
    const v179 = compileNative("specs/v1.79-signal-truth.spec.md");
    expect(v179.tasks.length).toBeGreaterThan(0);
    expect(taskUnitContractErrors(v179.tasks, root, active)).toEqual([]);
    expect(reviewParticipationErrors(v179.tasks, active)).toEqual([]);
  }, 30_000);

  test("review participation is decided by declared and actual paths, never by complexity, and skip visibility is journal truth end to end", async () => {
    const { repo, base } = repoWithDiff({ "docs/guide.md": "# guide\n" });
    // The retired switch: the two complexities that used to sit either side of the default threshold
    // now decide nothing — the declared paths do, and they decide the same way for both.
    for (const complexity of [1, 9]) {
      const { fake, calls } = countingFake({ review: { approve: true, issues: [] } });
      const leaf = await reviewGate(mkTask({ files: ["docs/**"], complexity }), repo, base, author, CH, [fake], DEFAULT_CONFIG);
      expect(leaf.meta?.verdict).toBe("skipped");
      expect(calls()).toBe(0);

      const src = countingFake({ review: { approve: true, issues: [] } });
      const full = await reviewGate(mkTask({ files: ["src/run/daemon.ts"], complexity }), repo, base, author, CH, [src.fake], DEFAULT_CONFIG);
      expect(full.meta?.verdict).toBeUndefined();
      expect(full.meta?.policy).toBe("full");
      expect(src.calls()).toBe(1);
    }
    // and the retired knob cannot resurrect the skip: below OR above, participation is unchanged
    const pinned = structuredClone(DEFAULT_CONFIG);
    pinned.review.complexityThreshold = 99;
    const { fake, calls } = countingFake({ review: { approve: true, issues: [] } });
    const r = await reviewGate(mkTask({ files: ["src/run/daemon.ts"], complexity: 1 }), repo, base, author, CH, [fake], pinned);
    expect(calls()).toBe(1);
    expect(r.meta?.policy).toBe("full");

    // ── skip VISIBILITY starts at the GATE's own verdict: `pass` is not true and the decline says so
    // about itself. The retired branch returned pass:true, so a review that never ran read exactly
    // like one that ran and approved. Journal truth — the row the daemon writes, the review-round
    // budget, the retry brief and the engagement record — is asserted end to end against a REAL run
    // in tests/run/daemon.test.ts ("R3 declined review — journal truth and merge"); rebuilding the
    // ledger row by hand here would only prove this file can copy daemon.ts.
    const declined = await reviewGate(mkTask({ files: ["docs/**"], complexity: 9 }), repo, base, author, CH,
      [countingFake({ review: { approve: true, issues: [] } }).fake], DEFAULT_CONFIG);
    expect(declined.pass).toBe(false); // never a forged green
    expect(declined.meta).toMatchObject({ skipped: true, verdict: "skipped", policy: "judge-only" });
    expect(deriveSignalBasis(declined.gate, declined.pass, declined.details, declined.meta ?? {})).toBe("skipped");
  }, 30_000);
});

describe("reviewGate", () => {

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
    expect(r.meta).toEqual({ policy: "full", reviewer: "fake:fake-3" });
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

// v1.70 T5 (review-convergence): the gate classifies findings by severity — only material findings
// block approval — and carries a deferred concern's rationale into the recorded details.
describe("reviewGate material/minor classification (v1.70 T5)", () => {
  test("test: anchored comments never alter the verdict outcome the gate records", async () => {
    const { repo, base } = repoWithCommit();
    const comments = [
      { path: "src/retry.ts", line: 41, body: "Keep the final retry inside the bounded loop." },
    ];
    const blocking = await reviewGate(
      mkTask(),
      repo,
      base,
      author,
      CH,
      [fakeWith({ review: {
        approve: true,
        findings: [{ note: "the last retry is dropped", severity: "material" }],
        comments,
      } })],
      DEFAULT_CONFIG,
    );
    const approving = await reviewGate(
      mkTask(),
      repo,
      base,
      author,
      CH,
      [fakeWith({ review: {
        approve: false,
        findings: [{ note: "rename the helper", severity: "minor" }],
        comments,
      } })],
      DEFAULT_CONFIG,
    );

    expect(blocking.pass).toBe(false);
    expect(approving.pass).toBe(true);
    expect(blocking.details).toContain("## Anchored review");
    expect(blocking.details).toContain("src/retry.ts:41");
  });

  test("malformed review comments are ignored without changing legacy issue parsing", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: {
      approve: false,
      issues: ["off-by-one in retry loop"],
      comments: [{ path: "", line: 0, body: "" }],
    } });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG);

    expect(r.pass).toBe(false);
    expect(r.details).toContain("off-by-one in retry loop");
    expect(r.details).not.toContain("Anchored review");
  });

  test("a review verdict with only minor findings and no material ones approves the task rather than blocking it", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, findings: [
      { note: "style nit in the loop", severity: "minor" },
      { note: "prefer a clearer name", severity: "minor" },
    ] } });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG);
    expect(r.pass).toBe(true);
    expect(r.details).toMatch(/approved/i);
    // the minor findings are still recorded, they simply do not block
    expect(r.details).toContain("style nit in the loop");
  });

  test("a review verdict with at least one material finding still blocks approval exactly as today", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: false, findings: [
      { note: "off-by-one drops the last row", severity: "material" },
      { note: "minor spacing", severity: "minor" },
    ] } });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG);
    expect(r.pass).toBe(false);
    expect(r.details).toContain("off-by-one drops the last row");
    // fails closed the same way a legacy request-changes verdict does: pass:false + the reviewer channel
    expect(r.meta).toEqual({ policy: "full", reviewer: "fake:fake-2" });
  });

  test("a deferred finding is carried into the gate's recorded details with its rationale rather than silently dropped", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, findings: [
      { note: "helper could be memoized", severity: "minor", defer: true, rationale: "not hot on this path; out of scope" },
    ] } });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG);
    // a deferred minor concern does not block
    expect(r.pass).toBe(true);
    // …but its note AND its rationale survive into the recorded details
    expect(r.details).toContain("helper could be memoized");
    expect(r.details).toContain("not hot on this path; out of scope");
    expect(r.details).toMatch(/defer/i);
  });

  test("a deferred finding without a rationale fails closed as a shape inconsistency", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, findings: [
      { note: "silently swallowed", severity: "minor", defer: true },
    ] } });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG);
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/deferred findings\[0\] requires a rationale/i);
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
    // OBS-193/196: meta additionally marks unparseable (typed retry detection) and names the cause
    expect(r.meta).toEqual({ policy: "full", reviewer: "fake:fake-2", unparseable: true, cause: "no-verdict" });
  });

  test("excludeReviewers reaches reviewGate: excluded vendor → no-reviewer path", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, issues: [] } });
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG, undefined, ["fake:fake-2"]);
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/no cross-vendor reviewer available/);
  });
});
