// KEPT OUT as data (rows 500, 501; D-2187 add.363, contract K3): every deny entry in force, in the lists'
// order, with the comment above it in the layer that holds it as its reason.
import { describe, expect, test } from "vitest";
import { keptOut } from "../../src/fleet/kept.js";
import { buildFleetModel } from "../../src/fleet/model.js";
import { needs } from "../../src/fleet/needs.js";
import { source } from "./world.js";

describe("KEPT OUT", () => {
  test("kept out lists every deny entry in force; the comment above it is its reason; no comment gives no reason", () => {
    // the row 500 world: guard rules that keep nothing out today under a dated comment, in the user config;
    // a rule with no comment and a workers' list in the repository's
    const userText = "routing:\n  deny:\n    # 2026-11-15 guard: Antigravity stays out the day it lands\n    models: [\"omp:google-antigravity/*\", nosuch:model]\n";
    const repoText = "routing:\n  deny:\n    adapters: [agy]\n    workers:\n      models:\n        # never writes code\n        - codex:gpt-6-luna\n        - claude-code:haiku\nconsult:\n  prefer: [claude-code:fable]\n";
    const M = buildFleetModel(source({ userText, repoText }).inputs);
    expect(keptOut(M).map((r) => [r.rule, r.list, r.reason, r.says])).toEqual([
      ["agy", "routing.deny.adapters", null, null],
      ["omp:google-antigravity/*", "routing.deny.models", "# 2026-11-15 guard: Antigravity stays out the day it lands", "# 2026-11-15 guard: Antigravity stays out the day it lands"],
      ["nosuch:model", "routing.deny.models", "# 2026-11-15 guard: Antigravity stays out the day it lands", "# 2026-11-15 guard: Antigravity stays out the day it lands"],
      ["codex:gpt-6-luna", "routing.deny.workers.models", "# never writes code", "# never writes code · workers only"],
      ["claude-code:haiku", "routing.deny.workers.models", null, "kept out for workers"],
    ]);
    expect(keptOut(M).filter((r) => r.workersOnly).map((r) => r.rule)).toEqual(["codex:gpt-6-luna", "claude-code:haiku"]);
    // the guards keep nothing out today, and still no item touches them
    expect(needs(M).flatMap((n) => n.edits ?? []).filter((e) => e.path[1] === "deny")).toEqual([]);
    // no rule: nothing is listed
    expect(keptOut(buildFleetModel(source({ repoText: "consult:\n  prefer: [claude-code:fable]\n" }).inputs))).toEqual([]);
  });
});
