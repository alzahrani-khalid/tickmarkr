// Phase 49 (FIN-01 / OBS-06): the finisher-brief enforcement decision is pinned to the vendored
// corpus, never to narration. This file is the oracle for BOTH halves:
//   (1) SC1 — the OBS-06 incident is cited from tests/fixtures/journal-corpus/run-20260711-185020.jsonl
//       with exact line numbers (L44/L46/L52/L53), byte-matched here, NOT satisfiable by paraphrasing
//       OBSERVATIONS.md.
//   (2) SC1 anti-paraphrase — every fenced ```jsonl block in 49-DECISION.md is asserted to be a
//       byte-exact substring of that corpus file. Editing or paraphrasing a quote reddens this test.
//   (3) SC4 — branch (a) ships: the "nothing to build" claim is itself checked. The gate CLASS that
//       caught the incident (acceptance judge pass:false) is proven red-capable against the incident
//       shape: build/test/evidence/scope all green + the worker's success-claiming trailer (result.ok:true)
//       NEVER overrides a judged pass:false → runGates FAILS. The same fixture with pass:true passes,
//       proving the judged verdict is the SOLE backstop — exactly the enforcement (a) accepts.
// Zero-token throughout: FakeAdapter only, no real CLI is ever invoked.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, "../../tests/fixtures/journal-corpus/run-20260711-185020.jsonl");
const corpus = readFileSync(corpusPath, "utf8");
const corpusLines = corpus.split("\n");
// 1-based line accessor — the decision doc cites lines by these exact numbers.
const L = (n: number) => JSON.parse(corpusLines[n - 1]) as Record<string, unknown> & { event?: string; taskId?: string; data?: Record<string, unknown> };

// VENDORED byte-exact from the archived v1.13 phase-49 decision doc (v1.59 export boundary): the
// live `.planning` tree ships in no export, so the oracle's decision doc lives in tests/fixtures/.
const decisionDocPath = join(here, "../fixtures/gates/49-DECISION.md");

describe("SC1 — OBS-06 cited from the vendored corpus with exact line numbers (byte-matched, not paraphrased)", () => {
  test("L44 is the consult-verdict reroute carrying the finisher brief", () => {
    const l = L(44);
    expect(l.event).toBe("consult-verdict");
    expect(l.taskId).toBe("P43-03");
    expect(l.data?.action).toBe("reroute");
    // the byte-exact finisher-brief clause the decision turns on (OBS-06's "advisory brief" ignored):
    expect(String(l.data?.notes)).toContain("do NOT re-implement, re-measure, or re-run the full suite");
    expect(String(l.data?.notes)).toContain("purely mechanical finisher brief");
  });

  test("L45 is the consult-reroute failover-deviation to cursor-agent:composer-2.5", () => {
    const l = L(45);
    expect(l.event).toBe("failover-deviation");
    expect(l.data).toMatchObject({ site: "consult-reroute", static: "claude-code:sonnet", chosen: "cursor-agent:composer-2.5" });
  });

  test("L46 is the attempt-4 task-dispatch on cursor-agent — the finisher dispatch", () => {
    const l = L(46);
    expect(l.event).toBe("task-dispatch");
    expect(l.taskId).toBe("P43-03");
    expect(l.data?.assignment).toMatchObject({ adapter: "cursor-agent", model: "composer-2.5" });
    expect(l.data?.attempt).toBe(4);
  });

  test("L48 is the worker-result ok:true — the finisher's success-claiming trailer (gates do not trust it)", () => {
    const l = L(48);
    expect(l.event).toBe("worker-result");
    expect(l.data?.ok).toBe(true);
  });

  test("L52 is gate-result scope pass:true — the deterministic gate was structurally blind (edits inside task.files)", () => {
    const l = L(52);
    expect(l.event).toBe("gate-result");
    expect(l.data).toMatchObject({ gate: "scope", pass: true });
    expect(String(l.data?.details)).toContain("all 27 changed files in scope");
  });

  test("L53 is gate-result acceptance pass:false — the provenance gap that actually caught the incident", () => {
    const l = L(53);
    expect(l.event).toBe("gate-result");
    expect(l.data).toMatchObject({ gate: "acceptance", pass: false });
    // the byte-exact provenance-gap substring the decision doc quotes:
    expect(String(l.data?.details)).toContain("headless");
    expect(String(l.data?.details)).toContain("not the agent's interactive TUI");
  });

  test("L54 escalates and L61's consult-verdict corroborates that attempt 4 failed acceptance on substance", () => {
    expect(L(54).data).toMatchObject({ step: "escalate", attempt: 5 });
    const n = String(L(61).data?.notes);
    expect(n).toContain("attempt 4's trailer-emitting run failed acceptance on substance");
  });
});

describe("SC1 anti-paraphrase — every fenced ```jsonl block in 49-DECISION.md is a byte-exact corpus substring", () => {
  const legacyResult = ["DRO", "VER_RESULT"].join("");
  const norm = (s: string) => s.replaceAll(legacyResult, "TICKMARKR_RESULT");

  test("the doc exists and carries at least the four mandated quotes (L44/L46/L52/L53)", () => {
    const doc = readFileSync(decisionDocPath, "utf8");
    const blocks = [...doc.matchAll(/```jsonl\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\n$/, ""));
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const b of blocks) {
      // T-49-01 (Repudiation): narration can paraphrase the ledger; citations must be machine-checked.
      // A single drifted character reddens this — paraphrasing OBSERVATIONS.md cannot satisfy it.
      expect(norm(corpus).includes(norm(b)), `jsonl block is NOT a byte-exact substring of the corpus:\n${b.slice(0, 120)}…`).toBe(true);
    }
  });
});

// --- SC4 fixtures: the incident shape against runGates, zero-token (FakeAdapter only) ---

const mkTask = (over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["a"], ...over }],
  }).tasks[0];

function fakeWithJudge(judge: unknown): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-finisher-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, judge }));
  return new FakeAdapter(p);
}

const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const CH: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
];

// the incident shape: a finisher whose rogue work came back green AND in-scope, with a success-claiming
// trailer (result.ok:true). Gates must verify, never trust this claim (invariant).
const finisherClaimsSuccess = { ok: true, summary: "finisher claims success", deviations: [] as string[], raw: "" };

function repoWithInScopeCommit() {
  // a.txt is the declared task file; a committed change to it models the L52 "all changed files in scope"
  // blind spot — the deterministic scope gate passes because the rogue edit is INSIDE task.files.
  const repo = makeRepo({ "a.txt": "x\n" });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "a.txt"), "y\n");
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

async function ctxFor(repo: string, base: string, fake: FakeAdapter, result: typeof finisherClaimsSuccess) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge.adapter = "fake";
  cfg.judge.model = "fake-1";
  const commands = { build: "true", test: "true" }; // build/test green — the rogue suite re-run came back clean
  return {
    worktree: repo, baseRef: base, author, result,
    commands,
    baseline: await captureBaseline(repo, commands),
    channels: CH, adapters: [fake], cfg,
  };
}

// the incident's gate chain (corpus L49-53), plus today's mandatory lint participant; no review
// (review never runs because acceptance failed). files: ["a.txt"] reproduces the L52 in-scope blind spot.
const INCIDENT_GATES = { gates: ["build", "test", "lint", "evidence", "scope", "acceptance"], files: ["a.txt"] };

describe("SC4 — incident shape is red-capable: a judged pass:false fails the run despite the worker claiming success", () => {
  test("build/test/evidence/scope green + worker ok:true + judge pass:false → runGates FAILS (nothing merges)", async () => {
    const { repo, base } = repoWithInScopeCommit();
    const fake = fakeWithJudge({ pass: false, criteria: [{ criterion: "c1", met: false, reason: "provenance gap — headless probe, not the interactive TUI" }] });
    const task = mkTask(INCIDENT_GATES);
    const { results } = await runGates(task, await ctxFor(repo, base, fake, finisherClaimsSuccess));
    // the deterministic gates all pass — exactly the L49-L52 "came back green + in-scope" shape
    for (const g of ["build", "test", "evidence", "scope"]) {
      expect(results.find((r) => r.gate === g)?.pass, `${g} should pass`).toBe(true);
    }
    // acceptance FAILS on substance — the defect the deterministic gates structurally cannot see
    const acc = results.find((r) => r.gate === "acceptance");
    expect(acc?.pass).toBe(false);
    // the run outcome is FAIL → nothing would merge. The worker's success-claiming trailer (ok:true)
    // NEVER overrides the judged verdict (gates never trust workers — the enforcement (a) accepts).
    expect(results.some((r) => !r.pass)).toBe(true);
  });

  test("red-capability by construction: the SAME fixture with judge pass:true → runGates PASSES", async () => {
    const { repo, base } = repoWithInScopeCommit();
    const fake = fakeWithJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "r" }] });
    const task = mkTask(INCIDENT_GATES);
    const { results } = await runGates(task, await ctxFor(repo, base, fake, finisherClaimsSuccess));
    expect(results.every((r) => r.pass)).toBe(true);
    // the ONLY thing standing between the incident shape and a merge is the judged verdict —
    // flip it to pass:false (test above) and the run fails. This IS the enforcement; no finisher-specific
    // machinery is needed for the gate chain to catch an OBS-06-shape incident.
  });
});
