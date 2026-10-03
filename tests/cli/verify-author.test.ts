import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { verify } from "../../src/cli/commands/verify.js";
import type { GateResult } from "../../src/gates/types.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, T, authedModels, makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

afterEach(() => {
  delete process.env.TICKMARKR_FAKE_SCRIPT;
  vi.restoreAllMocks();
});

// G (D-874): the review pool is fake-1 (vendor fake-a) and fake-2 (fake-b). Doctor also lists fake-3 —
// installed, never seeded, never model-authed, so never routable — and codex's unseeded gpt-6.1-sol,
// whose adapter has no model-authed channel at all. Neither identity is a review channel.
function authorRepo(): string {
  const repo = makeRepo({ "src.txt": "base\n" });
  execSync("git checkout -q -b feature", { cwd: repo });
  writeFileSync(join(repo, "src.txt"), "base\nfeature\n");
  execSync(`${COMMIT} feature`, { cwd: repo });
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", { files: ["src.txt"] })] }));
  writeDoctor(repo, {
    fake: { installed: true, authed: true, models: ["fake-1", "fake-2", "fake-3"], modelAuth: authedModels(["fake-1", "fake-2"]) },
    codex: { installed: true, authed: true, models: ["gpt-6.1-sol"], modelsDetectedAt: "2026-10-02T00:00:00.000Z" },
  });
  const script = join(makeTestTempDir("tickmarkr-author-"), "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
  process.env.TICKMARKR_FAKE_SCRIPT = script;
  vi.spyOn(console, "error").mockImplementation(() => {});
  return repo;
}

const reviewRow = (out: string): GateResult => (JSON.parse(out) as { results: GateResult[] }).results.find((r) => r.gate === "review")!;

test("test: production verify resolves an installed unseeded author outside the review pool for exclusion while undiscoverable authors refuse and an exhausted configured review policy remains unreadable", async () => {
  const repo = authorRepo();
  const run = (author: string, extra: string[] = []) => verify(["--task", "T1", "--no-acceptance", "--json", "--author", author, ...extra], repo);

  // Control: an author that excludes neither fake vendor is reviewed by fake-1.
  const human = await run("human");
  expect(human.code, human.out).toBe(0);
  expect(reviewRow(human.out).meta?.reviewer).toBe("fake:fake-1");

  // fake-3 resolves outside the pool to the adapter's declared vendor fake-a, so it excludes fake-1's provider.
  const unseeded = await run("fake:fake-3");
  expect(unseeded.code, unseeded.out).toBe(0);
  expect(reviewRow(unseeded.out).meta?.reviewer).toBe("fake:fake-2");

  // codex:gpt-6.1-sol resolves through codex's configured vendor (openai) and is recorded as the author.
  const journal = Journal.create(repo, "run-author-claim");
  journal.append("run-start", undefined, {});
  const sol = await run("codex:gpt-6.1-sol", ["--record", "run-author-claim"]);
  expect(sol.code, sol.out).toBe(0);
  expect(journal.read().find((e) => e.event === "review-leg2")?.data).toMatchObject({ author: "codex:gpt-6.1-sol", pass: true });

  // Undiscoverable: an unlisted model, an unconfigured unlisted model, a seeded model of an adapter
  // doctor never recorded, and an unknown adapter — each refused by name.
  for (const claim of ["fake:fake-9", "codex:gpt-9-nova", "kimi:kimi-code/k3", "ghost:model"]) {
    await expect(run(claim)).rejects.toThrow(`--author ${claim} does not name a discoverable author identity`);
  }

  // Configured policy denies fake-2; the outside-pool author excludes fake-1. Nothing remains, and the
  // author identity neither seats itself nor resurrects the denied seat: review stays unreadable.
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "routing:\n  deny:\n    models: [fake:fake-2]\n");
  const exhausted = await run("fake:fake-3");
  expect(exhausted.code, exhausted.out).toBe(2);
  const row = reviewRow(exhausted.out);
  expect(row).toMatchObject({ pass: false, meta: { noEligibleReviewer: true, unreadable: true, reviewerFloor: "frontier" } });
  expect(row.details).toContain("no cross-vendor reviewer available");
}, 120_000);
