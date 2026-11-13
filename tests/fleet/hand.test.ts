// The lines a hand can change and the edits a choice becomes, called directly on the team model:
// no screen, no key. The same rules are driven through the screen in screen-hand.test.ts.
import { describe, expect, test } from "vitest";
import type { Tier } from "../../src/config/config.js";
import { applyEdits } from "../../src/fleet/edits.js";
import { buildFleetModel } from "../../src/fleet/model.js";
import { handEdits, handLines, liftReach, type HandChoice } from "../../src/fleet/hand.js";
import { POOL, source } from "./world.js";

/** A floor choice run through handEdits and applyEdits, then read back from the saved layers. */
function savedFloor(shape: string, mode: string, user: Tier | null | undefined, repo: Tier | null | undefined, floor: Tier | "mode" = "mode") {
  const yaml = (tier: Tier | null | undefined) => (tier === undefined ? "" : `  floors:\n    ${shape}: ${tier === null ? "null" : tier}\n`);
  const userText = user === undefined ? "" : `routing:\n${yaml(user)}`;
  const repoText = `routing:\n  mode: ${mode}\n${yaml(repo)}`;
  const M = buildFleetModel(source({ userText, repoText }).inputs);
  const edits = handEdits(M, [{ line: shape, chosen: [], floor }]);
  const texts = applyEdits({ userText, repoText }, edits);
  const after = buildFleetModel(source({ userText: texts.userText, repoText: texts.repoText }).inputs);
  return { edits, after, floor: handLines(after).find((l) => l.id === shape)!.floor };
}

/** Batch choices through the same edit, save and reload path as the review. */
function savedBatch(userText: string, repoText: string, choices: HandChoice[]) {
  const M = buildFleetModel(source({ userText, repoText }).inputs);
  const edits = handEdits(M, choices);
  const texts = applyEdits({ userText, repoText }, edits);
  const after = buildFleetModel(source(texts).inputs);
  return { edits, after, floor: handLines(after).find((l) => l.id === "chore")!.floor };
}

describe("the lines a hand can change", () => {
  test("every shape, then the judge, review and consult, then the routing mode, then one line for each deny list", () => {
    const lines = handLines(buildFleetModel(source({ repoText: POOL }).inputs));
    expect(lines.map((l) => l.id)).toEqual(["plan", "spec", "implement", "tests", "docs", "migration", "ui", "refactor", "chore", "judge", "review", "consult", "mode",
      "deny.adapters", "deny.models", "deny.workers.adapters", "deny.workers.models"]);
    // a shape has a pool mode and a floor; a pinned shape names its model; the mode is a setting; a deny list is a deny list
    expect(lines.find((l) => l.id === "implement")).toMatchObject({ mode: "any", floor: { tier: "frontier", own: false }, current: ["codex:gpt-6-astra", "codex:gpt-5.6-terra"], layer: "repo" });
    expect(lines.find((l) => l.id === "plan")).toMatchObject({ pinned: true, current: ["claude-code:fable"] });
    expect(lines.find((l) => l.id === "mode")).toMatchObject({ setting: true, one: true, current: ["partner-led"] });
    expect(lines.filter((l) => l.deny).every((l) => l.current.length === 0)).toBe(true);
  });
  test("a choice becomes edits: the line's own, the rule of a model it adds lifted and no other, a deny list set to what is ticked", () => {
    const M = buildFleetModel(source({ repoText: "routing:\n  deny:\n    models:\n      - claude-code:opus\n    workers:\n      models:\n        - claude-code:fable\n  map:\n    plan:\n      pool:\n        mode: any\n        channels: [codex:gpt-6-astra]\n" }).inputs);
    const plan = handLines(M).find((l) => l.id === "plan")!;
    expect(plan.barred["claude-code:fable"]).toEqual({ why: "the deny rule claude-code:fable for all work (every shape, plan and spec too)", liftable: true });
    expect(liftReach(M, plan, "claude-code:opus").seats).toEqual(["judge", "review", "consult"]);
    const edits = handEdits(M, [{ line: "plan", chosen: ["codex:gpt-6-astra", "claude-code:fable"], mode: "ordered" }, { line: "deny.models", chosen: ["claude-code:opus", "claude-code:sonnet"] }]);
    expect(edits.map((e) => [e.path.join("."), e.value])).toEqual([
      ["routing.map.plan", { pool: { mode: "ordered", channels: ["codex:gpt-6-astra", "claude-code:fable"] } }],
      ["routing.deny.models", ["claude-code:opus", "claude-code:sonnet"]],
      ["routing.deny.workers.models", []],
    ]);
    expect(edits.map((e) => e.label)).toEqual(["plan: add fable; mode ordered", "claude-code:sonnet: denied for every seat", "claude-code:fable: no longer denied for all work (every shape, plan and spec too)"]);
    // a floor alone writes the floor and leaves the pool as it is
    expect(handEdits(M, [{ line: "plan", chosen: [], floor: "mid" }]).map((e) => [e.path.join("."), e.value])).toEqual([["routing.floors.plan", "mid"]]);
  });
  test("user cheap and repository frontier: choosing the mode leaves the user config's cheap floor, and the label names that floor", () => {
    const userText = "routing:\n  floors:\n    chore: cheap\n";
    const repoText = "routing:\n  mode: partner-led\n  floors:\n    chore: frontier\n";
    const M = buildFleetModel(source({ userText, repoText }).inputs);
    const edits = handEdits(M, [{ line: "chore", chosen: [], floor: "mode" }]);
    // one removal: the repository's floor. The user config's cheap is what the save then holds.
    expect(edits).toEqual([{ layer: "repo", path: ["routing", "floors", "chore"], value: undefined, label: "chore: floor cheap, the user config's, was frontier for this shape" }]);
    const texts = applyEdits({ userText, repoText }, edits);
    const after = buildFleetModel(source({ userText: texts.userText, repoText: texts.repoText }).inputs);
    expect(handLines(after).find((l) => l.id === "chore")!.floor).toEqual({ tier: "cheap", own: true });
    expect(after.mode.provenance.chore).toBe("config floors");
    expect(after.lowered.chore).toEqual({ own: "cheap", mode: "frontier" });
  });
  test("user frontier and repository mid: choosing the mode leaves the user config's frontier floor, and the label names that floor", () => {
    const userText = "routing:\n  floors:\n    chore: frontier\n";
    const repoText = "routing:\n  mode: partner-led\n  floors:\n    chore: mid\n";
    const M = buildFleetModel(source({ userText, repoText }).inputs);
    const edits = handEdits(M, [{ line: "chore", chosen: [], floor: "mode" }]);
    // frontier is what partner-led would say, and it is still the user config's own floor
    expect(edits).toEqual([{ layer: "repo", path: ["routing", "floors", "chore"], value: undefined, label: "chore: floor frontier, the user config's, was mid for this shape" }]);
    const texts = applyEdits({ userText, repoText }, edits);
    const after = buildFleetModel(source({ userText: texts.userText, repoText: texts.repoText }).inputs);
    expect(handLines(after).find((l) => l.id === "chore")!.floor).toEqual({ tier: "frontier", own: true });
    expect(after.mode.provenance.chore).toBe("config floors");
    expect(after.lowered.chore).toBeUndefined();
  });
  test("when both layers hold a shape's floor, a mode choice names the floor the user config leaves, and one layer still names the mode", () => {
    // Closed set: other shapes, other modes, other tier pairs, a tombstone, then the single-layer labels unchanged.
    const both = [
      { shape: "plan", mode: "partner-led", user: "mid", repo: "frontier" },
      { shape: "implement", mode: "staff-led", user: "cheap", repo: "mid" },
      { shape: "ui", mode: "risk-based", user: "cheap", repo: "frontier" },
      { shape: "chore", mode: "partner-led", user: "cheap", repo: "cheap" },
      { shape: "tests", mode: "staff-led", user: "frontier", repo: "mid" },
    ] as const;
    for (const row of both) {
      const got = savedFloor(row.shape, row.mode, row.user, row.repo);
      expect(got.edits).toEqual([{ layer: "repo", path: ["routing", "floors", row.shape], value: undefined, label: `${row.shape}: floor ${row.user}, the user config's, was ${row.repo} for this shape` }]);
      expect(got.floor).toEqual({ tier: row.user, own: true });
      expect(got.after.mode.provenance[row.shape]).toBe("config floors");
    }
    const tomb = savedFloor("docs", "partner-led", null, "frontier");
    expect(tomb.edits).toEqual([{ layer: "repo", path: ["routing", "floors", "docs"], value: undefined, label: "docs: floor removed, the user config's, was frontier for this shape" }]);
    expect(tomb.floor).toEqual({ tier: undefined, own: false });
    expect(tomb.after.mode.provenance.docs).toBeUndefined();
    const repoOnly = savedFloor("chore", "partner-led", undefined, "frontier");
    expect(repoOnly.edits).toEqual([{ layer: "repo", path: ["routing", "floors", "chore"], value: undefined, label: "chore: floor as mode partner-led says, was frontier for this shape" }]);
    expect(repoOnly.floor).toEqual({ tier: "frontier", own: false });
    expect(repoOnly.after.mode.provenance.chore).toBe("mode partner-led");
    const userOnly = savedFloor("refactor", "partner-led", "mid", undefined);
    expect(userOnly.edits).toEqual([{ layer: "user", path: ["routing", "floors", "refactor"], value: undefined, label: "refactor: floor as mode partner-led says, was mid for this shape" }]);
    expect(userOnly.floor).toEqual({ tier: "frontier", own: false });
    expect(userOnly.after.mode.provenance.refactor).toBe("mode partner-led");
    const set = savedFloor("spec", "partner-led", "cheap", "frontier", "mid");
    expect(set.edits).toEqual([{ layer: "repo", path: ["routing", "floors", "spec"], value: "mid", label: "spec: floor mid, was frontier for this shape" }]);
    expect(set.floor).toEqual({ tier: "mid", own: true });
    expect(set.after.mode.provenance.spec).toBe("config floors");
  });
  test("a repository-held floor removed with a mode change names the saved mode in either choice order", () => {
    const repoText = "routing:\n  mode: partner-led\n  floors:\n    chore: frontier\n";
    const mode: HandChoice = { line: "mode", chosen: ["staff-led"] };
    const floor: HandChoice = { line: "chore", chosen: [], floor: "mode" };
    for (const choices of [[mode, floor], [floor, mode]]) {
      const got = savedBatch("", repoText, choices);
      expect(got.edits.find((e) => e.path.join(".") === "routing.floors.chore")?.label).toBe("chore: floor as mode staff-led says, was frontier for this shape");
      expect(got.after.mode.mode).toBe("staff-led");
      expect(got.floor).toEqual({ tier: "cheap", own: false });
      expect(got.after.mode.provenance.chore).toBe("mode staff-led");
    }
  });
  test("a user-held floor removed with a mode change names the saved mode in either choice order", () => {
    const userText = "routing:\n  floors:\n    chore: frontier\n";
    const repoText = "routing:\n  mode: partner-led\n";
    const mode: HandChoice = { line: "mode", chosen: ["staff-led"] };
    const floor: HandChoice = { line: "chore", chosen: [], floor: "mode" };
    for (const choices of [[mode, floor], [floor, mode]]) {
      const got = savedBatch(userText, repoText, choices);
      expect(got.edits.find((e) => e.path.join(".") === "routing.floors.chore")).toMatchObject({ layer: "user", label: "chore: floor as mode staff-led says, was frontier for this shape" });
      expect(got.after.mode.mode).toBe("staff-led");
      expect(got.floor).toEqual({ tier: "cheap", own: false });
      expect(got.after.mode.provenance.chore).toBe("mode staff-led");
    }
  });
  test("a floor removal label describes the whole saved batch across layers, modes and choice order", () => {
    const modeChoice = (chosen: string): HandChoice => ({ line: "mode", chosen: [chosen] });
    const floor: HandChoice = { line: "chore", chosen: [], floor: "mode" };
    for (const held of ["repo", "user", "both"] as const) {
      const userText = held === "repo" ? "" : `routing:\n  floors:\n    chore: ${held === "both" ? "cheap" : "frontier"}\n`;
      const repoText = `routing:\n  mode: partner-led\n${held === "user" ? "" : "  floors:\n    chore: frontier\n"}`;
      for (const selected of ["partner-led", "staff-led"] as const) {
        const batches = selected === "partner-led" ? [[floor], [modeChoice(selected), floor], [floor, modeChoice(selected)]] : [[modeChoice(selected), floor], [floor, modeChoice(selected)]];
        for (const choices of batches) {
          const got = savedBatch(userText, repoText, choices);
          const label = held === "both" ? "chore: floor cheap, the user config's, was frontier for this shape" : `chore: floor as mode ${selected} says, was frontier for this shape`;
          expect(got.edits.find((e) => e.path.join(".") === "routing.floors.chore")?.label).toBe(label);
          expect(got.after.mode.mode).toBe(selected);
          expect(got.floor).toEqual(held === "both" ? { tier: "cheap", own: true } : { tier: selected === "staff-led" ? "cheap" : "frontier", own: false });
          expect(got.after.mode.provenance.chore).toBe(held === "both" ? "config floors" : `mode ${selected}`);
        }
      }
    }
  });
});
