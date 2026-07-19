// HARD-06 regression pins — these properties hold on HEAD by construction; their red-capability
// is proven by the mutation drills in Task 2, whose transcripts live in 38-DIAGNOSIS.md.
// The scratch repo deliberately has NO package.json so detectGateCommands auto-detects nothing;
// without that vacuity trap the overlay-only test gate could never redden.

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config/config.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { WORKTREES_DIR } from "../../src/run/git.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const SRC = join(import.meta.dirname, "../../src");

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { recursive: true })) {
    const p = join(dir, String(ent));
    if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function loadConfigCallSites(dir: string): string[] {
  // v1.51 T2: the daemon's single config entry became loadConfigWithMode (mode resolution) —
  // the pin covers both spellings so the one-call-site invariant keeps guarding HARD-06.
  return tsFilesUnder(dir)
    .filter((f) => /\bloadConfig(WithMode)?\s*\(/.test(readFileSync(f, "utf8")))
    .map((f) => relative(SRC, f));
}

describe("HARD-06 overlay worktree regression", () => {
  test("Oracle 1 (behavioral): overlay-only gate command executes with the task worktree as cwd", async () => {
    const probe = join(mkdtempSync(join(tmpdir(), "tickmarkr-probe-")), "cwds.txt");
    const { repo, fake } = setupRepo(
      [T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "acceptance"], files: ["**"] })],
      { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
      `gates: { test: "pwd >> ${probe}" }\n`,
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-overlay-wt" });
    expect(s.done).toEqual(["T1"]);
    expect(s.failed).toEqual([]);

    const cwds = readFileSync(probe, "utf8").trim().split("\n");
    expect(cwds.some((l) => l.includes(join(".tickmarkr", WORKTREES_DIR)))).toBe(true);

    const gates = Journal.open(repo, "run-overlay-wt").read()
      .filter((e) => e.event === "gate-result")
      .map((e) => e.data.gate as string);
    expect(gates).toContain("test");
  });

  test("Oracle 2 (structural): loadConfig has exactly one engine call site in src/run", () => {
    for (const sub of ["gates", "route", "adapters", "drivers"] as const) {
      expect(loadConfigCallSites(join(SRC, sub))).toEqual([]);
    }
    expect(loadConfigCallSites(join(SRC, "run"))).toEqual(["run/daemon.ts"]);
  });

  test("D-06 identity pin: no repo-local overlay ⇒ DEFAULT_CONFIG", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-repo-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
    expect(loadConfig(repo, { globalDir })).toEqual(DEFAULT_CONFIG);
  });
});
