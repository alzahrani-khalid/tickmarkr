import { describe, expect, test } from "vitest";
import type { GateResult } from "../../src/gates/types.js";
import { classifyRepairDisposition, resolveScopeHints } from "../../src/run/repair-disposition.js";

const red = (gate: string, details: string, meta?: Record<string, unknown>): GateResult => ({ gate, pass: false, details, meta });
const files = ["src/run/widget.ts", "tests/run/widget.test.ts"];
const inventory = ["src/run/widget.ts", "tests/run/widget.test.ts", "tests/run/other.test.ts", "src/run/other.ts",
  "src/a/index.ts", "src/b/index.ts", "src/run/deleted.ts"];

describe("repair disposition", () => {
  test("a lone test gate red whose only named path is an unowned failing suite classifies as fund repair, so a classifier that parks it as an authoring defect fails", () => {
    const d = classifyRepairDisposition({ results: [red("test", "FAIL tests/run/other.test.ts > widget renders")], files, inventory });
    expect(d.kind).toBe("fund-repair");
    expect(d.paths).toEqual(["tests/run/other.test.ts"]);
    expect(d.source).toBe("test");
    // the same path named by a non-test gate is still the authoring defect it always was
    expect(classifyRepairDisposition({ results: [red("lint", "src/run/other.ts: unused import")], files, inventory }).kind).toBe("authoring");
  });

  test("a lone lint red naming no resolvable path classifies as the ordinary chargeable disposition, so a classifier that demands a known defect file before funding fails", () => {
    const d = classifyRepairDisposition({ results: [red("lint", "error in src/run/ghost.ts: 3 problems")], files, inventory });
    expect(d.kind).toBe("none");
    expect(d.paths).toEqual([]);
    expect(d.diagnostics.map((x) => x.candidate)).toEqual(["src/run/ghost.ts"]);
    expect(classifyRepairDisposition({ results: [red("lint", "3 problems")], files, inventory }).kind).toBe("none");
  });

  test("a scope gate collateral verdict or an infra red present beside an owned diagnostic path keeps its own classification, so an owned path that erases an independent blocker fails", () => {
    const owned = red("lint", "src/run/widget.ts: unused import");
    const collateral = { authoring: true, predicted: ["src/run/other.ts"], missed: [], repair: "add src/run/other.ts to T1.files[]" };
    const scope = classifyRepairDisposition({ results: [owned, red("scope", "out of scope: src/run/other.ts", { collateral })], files, inventory });
    expect(scope).toMatchObject({ kind: "authoring", blocker: "scope-collateral", source: "scope", paths: ["src/run/other.ts"] });
    const missed = classifyRepairDisposition({ results: [owned, red("scope", "out of scope", { collateral: { ...collateral, authoring: false } })], files, inventory });
    expect(missed).toMatchObject({ kind: "none", blocker: "scope-collateral" });
    const infra = classifyRepairDisposition({ results: [owned, red("test", "runner died in tests/run/other.test.ts", { infra: true })], files, inventory });
    expect(infra).toMatchObject({ kind: "none", blocker: "infra", source: "test" });
  });

  test("hint resolution over a supplied inventory resolves a deleted tracked path whereas a path present only in the main checkout stays unresolved, so a resolver reading outside the inventory fails", () => {
    // src/run/deleted.ts is in the diff as a deletion; package.json exists on disk in the checkout
    // running this test but is not in the supplied inventory.
    const r = resolveScopeHints(["src/run/deleted.ts", "package.json"], inventory);
    expect(r.resolved).toEqual(["src/run/deleted.ts"]);
    expect(r.diagnostics).toMatchObject([{ candidate: "package.json", kind: "unresolved", matches: [] }]);
  });

  test("an unresolved candidate or one matching two inventory paths is returned as a diagnostic carrying no approve command, so an executable command naming an unvalidated path fails", () => {
    const r = resolveScopeHints(["index.ts", "src/run/ghost.ts", "other.ts"], inventory);
    expect(r.resolved).toEqual(["src/run/other.ts"]);
    expect(r.diagnostics.map((d) => [d.candidate, d.kind])).toEqual([["index.ts", "ambiguous"], ["src/run/ghost.ts", "unresolved"]]);
    expect(r.diagnostics[0]!.matches).toEqual(["src/a/index.ts", "src/b/index.ts"]);
    for (const d of r.diagnostics) {
      expect(d).not.toHaveProperty("approveCommand");
      expect(JSON.stringify(d)).not.toContain("tickmarkr approve");
    }
    // the classifier's executable paths carry only validated inventory entries
    const d = classifyRepairDisposition({ files, inventory,
      refusalSummary: "cannot finish: src/run/ghost.ts and index.ts and src/run/other.ts are outside my allowlist", results: [] });
    expect(d).toMatchObject({ kind: "scope-request", source: "worker", paths: ["src/run/other.ts"] });
    expect(d.diagnostics.map((x) => x.candidate).sort()).toEqual(["index.ts", "src/run/ghost.ts"]);
  });
});
