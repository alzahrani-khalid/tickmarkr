import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerAdapter } from "../../src/adapters/types.js";
import { plan } from "../../src/cli/commands/plan.js";
import { saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { describe, expect, test } from "vitest";
import { validateGraph } from "../../src/graph/schema.js";
import { authedModels, makeRepo } from "../helpers/tmprepo.js";

// Queue row 311 (a): claudeGatewayHost returns undefined under VITEST, so the injected gateway
// parameter is the only way a test can present a gateway — exactly the seam the lint reads.
const GATEWAY_LINE_PREFIX = "claude-code via gateway gw.corp.internal:";

const claudeAdapter = (models: string[], vendor: string): WorkerAdapter => ({
  id: "claude-code",
  channels: () => models.map((model) => ({ adapter: "claude-code", model, vendor, channel: "sub" as const, tier: "frontier" as const })),
  async probe() {
    return { installed: true, authed: true, version: "fake", models, modelAuth: authedModels(models) };
  },
  async runWorker() { return { ok: true, summary: "ok" }; },
});

const codexAdapter: WorkerAdapter = {
  id: "codex",
  channels: () => [{ adapter: "codex", model: "gpt-6-astra", vendor: "openai", channel: "sub", tier: "frontier" }],
  async probe() {
    return { installed: true, authed: true, version: "fake", models: ["gpt-6-astra"], modelAuth: authedModels(["gpt-6-astra"]) };
  },
  async runWorker() { return { ok: true, summary: "ok" }; },
};

async function gatewayRepo(adapters: WorkerAdapter[], overlay?: string): Promise<string> {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
  }));
  if (overlay) writeFileSync(join(tickmarkrDir(repo), "config.yaml"), overlay);
  return repo;
}

describe("plan gateway bench lints", () => {
  test("test: plan prints one gateway line naming the host, each vendor-unknown claude-code model and the modelOverrides vendor declaration, and prints none without a gateway or without an unknown vendor, so a silent bench fails", async () => {
    const unknown = claudeAdapter(["gateway-proxied-a", "gateway-proxied-b"], "unknown");
    const repo = await gatewayRepo([unknown, codexAdapter]);

    const out = await plan([], repo, [unknown, codexAdapter], undefined, {}, "gw.corp.internal");
    const gatewayLines = out.split("\n").filter((l) => l.includes(GATEWAY_LINE_PREFIX));
    expect(gatewayLines).toHaveLength(1);
    expect(gatewayLines[0]).toContain("gateway-proxied-a");
    expect(gatewayLines[0]).toContain("gateway-proxied-b");
    expect(gatewayLines[0]).toContain("declare tiers.claude-code.modelOverrides.<model>.vendor to seat one");

    // no gateway injected → the same vendor-unknown fleet prints nothing
    const noGatewayOut = await plan([], repo, [unknown, codexAdapter], undefined, {});
    expect(noGatewayOut).not.toContain("via gateway");

    // a gateway with only vendor-declared claude-code channels prints nothing
    const seated = claudeAdapter(["claude-declared"], "anthropic");
    const seatedRepo = await gatewayRepo([seated, codexAdapter]);
    const seatedOut = await plan([], seatedRepo, [seated, codexAdapter], undefined, {}, "gw.corp.internal");
    expect(seatedOut).not.toContain("via gateway");
  });

  test("test: a fleet of one real vendor plus vendor-unknown gateway channels has no cross-vendor reviewer pair, so an unknown vendor counted as a second vendor fails", async () => {
    const unknown = claudeAdapter(["gateway-proxied-a", "gateway-proxied-b"], "unknown");
    const repo = await gatewayRepo([unknown, codexAdapter]);

    const out = await plan([], repo, [unknown, codexAdapter], undefined, {}, "gw.corp.internal");
    expect(out).toContain("review: no cross-vendor reviewer pair in fleet — set review.required: false to waive");
  });

  // Repair (review finding): routing.deny.workers.models benches a channel for dispatch only — the
  // review and judge pools keep it — so the gateway lint must collect benched models across every
  // role pool; a worker-only exclusion must not silently hide a benched review or judge seat.
  test("a claude-code model removed from the worker pool by routing.deny.workers.models still appears in the gateway bench line with its undenied sibling, so a bench list drawn from the worker pool alone fails", async () => {
    const unknown = claudeAdapter(["gateway-proxied-a", "gateway-proxied-b"], "unknown");
    const repo = await gatewayRepo(
      [unknown, codexAdapter],
      "routing:\n  deny:\n    workers:\n      models: [claude-code:gateway-proxied-a]\n",
    );

    const out = await plan([], repo, [unknown, codexAdapter], undefined, {}, "gw.corp.internal");
    const gatewayLines = out.split("\n").filter((l) => l.includes(GATEWAY_LINE_PREFIX));
    expect(gatewayLines).toHaveLength(1);
    expect(gatewayLines[0]).toContain("gateway-proxied-a");
    expect(gatewayLines[0]).toContain("gateway-proxied-b");
  });
});
