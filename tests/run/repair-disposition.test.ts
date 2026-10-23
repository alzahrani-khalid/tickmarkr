import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { Slot } from "../../src/drivers/types.js";
import type { GateResult } from "../../src/gates/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { classifyRepairDisposition, namedPaths, resolveScopeHints } from "../../src/run/repair-disposition.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const red = (gate: string, details: string, meta?: Record<string, unknown>): GateResult => ({ gate, pass: false, details, meta });
const files = ["src/run/widget.ts", "tests/run/widget.test.ts"];
const inventory = ["src/run/widget.ts", "tests/run/widget.test.ts", "tests/run/other.test.ts", "src/run/other.ts",
  "src/a/index.ts", "src/b/index.ts", "src/run/deleted.ts"];

const of = (evs: JournalEvent[], event: string) => evs.filter((e) => e.event === event && e.taskId === "T1");

describe("repair disposition", () => {
  test("Queue row 230: numeric parenthesized positions and colon positions name the same complete path while non-position parentheses stay in the name", () => {
    for (const path of ["src/run/other.ts", "tests/run/other.test.ts", "other.test.ts", "src/(group)/other(draft).test.ts", "other(draft).test.ts", "other(draft)copy.test.ts"]) {
      expect(namedPaths(`${path}(12,3): error TS2322`)).toEqual([path]);
      expect(namedPaths(`${path}(#,#): error TS2322`)).toEqual([path]);
      expect(namedPaths(`${path}:12:3: error TS2322`)).toEqual([path]);
      expect(namedPaths(`'${path}'`)).toEqual([path]);
    }
    expect(namedPaths("src/run/other.ts(draft): note")).toEqual(["src/run/other.ts(draft)"]);
    expect(namedPaths("src/run/other.ts(12, 3): error TS2322")).toEqual(["src/run/other.ts"]);
    expect(namedPaths("./src/run/other.test.ts(123,45): error TS2322")).toEqual(["src/run/other.test.ts"]);
    expect(namedPaths("../src/run/other.ts(12,3): error TS2322")).toEqual([]);
    const tsc = classifyRepairDisposition({ files, inventory, results: [red("lint", "src/run/other.ts(12,3): error TS2322")] });
    const colon = classifyRepairDisposition({ files, inventory, results: [red("lint", "src/run/other.ts:12:3: error TS2322")] });
    expect(tsc).toEqual(colon);
    expect(tsc).toMatchObject({ kind: "authoring", paths: ["src/run/other.ts"], diagnostics: [] });
  });

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

  test("a gate red naming an unowned file in tsc's parenthesized line and column form parks as the colon form does, its hint naming the file with no unresolved scope-hint row, and a tsc-form refusal names it in a scope request and in a park without an approve command, so a lexer cutting paths at the last dot fails", async () => {
    const path = "elsewhere/other.test.ts";
    const run = async (kind: "colon" | "tsc" | "refusal" | "cleanup") => {
      const location = kind === "colon" ? `${path}:12:3` : `${path}(12,3)`;
      const { repo, fake } = setupRepo([T("T1", { files: ["owned.txt"], acceptance: [{ oracle: "command", command: "true" }] })], {
        tasks: { T1: [{ shell: `echo change > owned.txt && ${COMMIT} change`,
          result: { ok: kind === "colon" || kind === "tsc", summary: `Cannot edit ${location} outside files[] allowlist` } }] },
      }, `visibility: { keepPanes: attempt }\ngates: { lint: 'if test -f owned.txt; then echo "${location}: error TS2322: incompatible type"; exit 1; fi' }\n`);
      mkdirSync(join(repo, "elsewhere"));
      writeFileSync(join(repo, path), "export {};\n");
      execFileSync("git", ["add", path], { cwd: repo });
      execFileSync("git", ["commit", "--no-gpg-sign", "-qm", "unowned-file"], { cwd: repo });
      const driver = new SubprocessDriver();
      if (kind === "cleanup") {
        const close = driver.close.bind(driver);
        let failed = false;
        driver.close = async (slot: Slot) => {
          await close(slot);
          if (!failed && slot.name.includes("-worker-")) {
            failed = true;
            throw new Error("cleanup census unavailable");
          }
        };
      }
      const runId = `run-tsc-hint-${kind}`;
      expect((await runDaemon(repo, { adapters: [fake], driver, runId })).human).toEqual(["T1"]);
      const rows = Journal.open(repo, runId).read();
      expect(of(rows, "scope-hint-unresolved")).toHaveLength(0);
      expect(of(rows, "task-human")).toHaveLength(1);
      const park = of(rows, "task-human")[0]!;
      expect(park.data.reason).toContain(`files[] repair hint: ${path}`);
      expect(park.data.reason).not.toContain(`files[] repair hint: ${path}(`);
      return { park, rows, runId };
    };
    const colon = await run("colon");
    const tsc = await run("tsc");
    expect(tsc.park.data.kind).toBe(colon.park.data.kind);
    expect(tsc.park.data.kind).toBe("authoring");
    expect(of(tsc.rows, "scope-authoring")[0]!.data.paths).toEqual([path]);
    const refusal = await run("refusal");
    expect(refusal.park.data).toMatchObject({ kind: "scope-request", paths: [path],
      approveCommand: `tickmarkr approve ${refusal.runId} T1 --files ${path}` });
    const cleanup = await run("cleanup");
    expect(cleanup.park.data.kind).toBe("stall");
    expect(cleanup.park.data).not.toHaveProperty("approveCommand");
    expect(of(cleanup.rows, "scope-request")).toHaveLength(0);
  }, 180_000);
});
