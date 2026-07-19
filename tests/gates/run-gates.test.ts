import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const channels: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
  { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
];

function fake() {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-gates-"));
  const script = join(dir, "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] } }));
  return new FakeAdapter(script);
}

function task(shape: "docs" | "implement", complexity = 8) {
  return validateGraph({
    version: 1,
    spec: { source: "native", paths: ["spec.md"], hash: "hash" },
    tasks: [{ id: "T1", title: "gate depth", goal: "verify gates", shape, complexity, acceptance: ["passes"] }],
  }).tasks[0];
}

function repoWithCommit() {
  const repo = makeRepo({ "a.txt": "before\n" });
  const baseRef = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "a.txt"), "after\n");
  execSync("git add -A && git commit --no-gpg-sign -m work", { cwd: repo });
  return { repo, baseRef };
}

async function gatesFor(t: ReturnType<typeof task>, cfg: typeof DEFAULT_CONFIG, adapter: FakeAdapter) {
  const { repo, baseRef } = repoWithCommit();
  return runGates(t, {
    worktree: repo,
    baseRef,
    author,
    result: { ok: true, summary: "", deviations: [], raw: "" },
    commands: {},
    baseline: await captureBaseline(repo, {}),
    channels,
    adapters: [adapter],
    cfg,
  });
}

describe("per-shape gate participation", () => {
  test("docs can skip acceptance while other shapes still run it", async () => {
    const adapter = fake();
    const cfg = structuredClone(DEFAULT_CONFIG) as typeof DEFAULT_CONFIG & { gates: { byShape?: Record<string, { acceptance?: boolean }> } };
    cfg.judge.adapter = "fake";
    cfg.gates.byShape = { docs: { acceptance: false } };

    // build/test/lint have no detected command here (commands: {}) — they surface as explicit skips
    const docs = await gatesFor(task("docs", 3), cfg, adapter);
    expect(docs.results.map((r) => r.gate)).toEqual(["build", "test", "lint", "evidence", "scope", "review"]);
    expect(docs.results.slice(0, 3).every((r) => r.pass && r.meta?.skipped === true)).toBe(true);
    expect(docs.results.at(-1)?.details).toMatch(/complexity 3 < threshold 7/);

    const implement = await gatesFor(task("implement"), cfg, adapter);
    expect(implement.results.map((r) => r.gate)).toEqual(["build", "test", "lint", "evidence", "scope", "acceptance", "review"]);
  });

  test("no byShape preserves acceptance and review threshold behavior", async () => {
    const adapter = fake();
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";

    const { results } = await gatesFor(task("docs", 3), cfg, adapter);
    expect(results.map((r) => r.gate)).toEqual(["build", "test", "lint", "evidence", "scope", "acceptance", "review"]);
    expect(results.at(-1)?.details).toMatch(/complexity 3 < threshold 7/);
  });
});
