import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { allAdapters, discoverChannels, probeAll } from "../../src/adapters/registry.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { tickmarkrDir, graphPath, saveGraph } from "../../src/graph/graph.js";
import { compilePrd } from "../../src/compile/prd.js";
import { runDaemon } from "../../src/run/daemon.js";
import { marginalCostRank } from "../../src/route/router.js";
import { shOk } from "../../src/run/git.js";
import { makeRepo } from "../helpers/tmprepo.js";

// Spends real tokens. Run with: TICKMARKR_E2E=1 npm run e2e
describe.skipIf(process.env.TICKMARKR_E2E !== "1")("e2e: real CLI end-to-end", () => {
  test("compile → run → merged integration branch with evidence", async () => {
    const adapters = allAdapters();
    const health = await probeAll(adapters);
    const channels = discoverChannels(DEFAULT_CONFIG, adapters, health);
    if (!channels.length) {
      console.warn("no agent CLIs installed — e2e skipped");
      return;
    }
    const cheapest = [...channels].sort((a, b) => marginalCostRank(a) - marginalCostRank(b))[0];

    const repo = makeRepo({
      "package.json": JSON.stringify({ name: "e2e-target", version: "0.0.0" }),
      "src/greet.js": "module.exports = function greet(name) { throw new Error('not implemented'); };\n",
    });
    writeFileSync(
      join(repo, "feature.prd.md"),
      `## T1: Implement greet(name) in src/greet.js
- shape: implement
- complexity: 2
- files: src/**
- pin: ${cheapest.adapter} ${cheapest.model}
- acceptance:
  - greet("tickmarkr") returns a string containing "tickmarkr"
  - greet no longer throws
`,
    );
    // route judge/review/consult through the same cheapest CLI; skip review (complexity 2 < 7)
    saveGraph(repo, compilePrd(join(repo, "feature.prd.md")));
    writeFileSync(
      join(tickmarkrDir(repo), "config.yaml"),
      `judge: { adapter: ${cheapest.adapter}, model: ${cheapest.model} }\nconsult: { adapter: ${cheapest.adapter}, model: ${cheapest.model} }\ntaskTimeoutMinutes: 10\n`,
    );

    const s = await runDaemon(repo, { driver: new SubprocessDriver(), runId: "run-e2e" });
    expect(s.done).toContain("T1");
    const show = await shOk(`git show ${s.branch}:src/greet.js`, repo);
    expect(show).not.toContain("not implemented");
    const graph = JSON.parse(readFileSync(graphPath(repo), "utf8"));
    const t1 = graph.tasks.find((t: { id: string }) => t.id === "T1");
    expect(t1.evidence.commits.length).toBeGreaterThan(0);
    expect(t1.evidence.gateResults.some((g: { gate: string }) => g.gate === "acceptance")).toBe(true);
  }, 900000);
});
