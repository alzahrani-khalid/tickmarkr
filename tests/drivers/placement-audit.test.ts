// v1.22b T1: VIS-10 ("no pane placed by focus heuristic") is a comment today — nothing fails the
// build if a new pane/tab creation call site forgets placement. This is a source-level regression
// oracle: it greps every `tab create`/`agent start`/`pane split` call site in the herdr driver and
// pins that each carries an explicit workspace — a pinned `--workspace` on tab create, or a
// HERDR_WORKSPACE_ID seed on the pane before it's handed back. A new creation site that omits
// placement fails this test, not just a code-review comment.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../../src/drivers/herdr.ts", import.meta.url)), "utf8");

describe("driver placement audit (VIS-10 guarantee as a regression oracle)", () => {
  it("every `tab create` call site pins an explicit --workspace", () => {
    const calls = src.match(/herdr\(`tab create[^`]*`/g) ?? [];
    expect(calls.length).toBeGreaterThan(0); // the audit itself must exercise at least one real site
    for (const call of calls) expect(call).toMatch(/--workspace\b/);
  });

  it("every `agent start` call site seeds HERDR_WORKSPACE_ID before the pane is handed to the caller", () => {
    const calls = [...src.matchAll(/herdr\(`agent start[^`]*`\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const after = src.slice(call.index!, call.index! + 2500);
      expect(after).toMatch(/HERDR_WORKSPACE_ID/);
    }
  });

  it("every `pane split` call site seeds HERDR_WORKSPACE_ID on the new pane before it's returned", () => {
    const calls = [...src.matchAll(/herdr\(`pane split[^`]*`\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const after = src.slice(call.index!, call.index! + 2500);
      expect(after).toMatch(/HERDR_WORKSPACE_ID/);
    }
  });
});
