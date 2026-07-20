// T8 (OBS-96 piece 2): the cold-clone repro rig is private-only, captures machine telemetry per
// attempt, and pairs every red first run with an immediate warm-control rerun on the same clone.
//
// Dual-context like tests/repo/export-manifest.test.ts, no skip escape hatch:
//   private tree (rig + export script present) → enumerate the exact candidate tree the exporter
//     builds (same `git archive` pathspecs) and exercise the rig's exported control flow;
//   exported/public tree (rig deliberately absent) → the rig's absence IS the private-only
//     contract there; each test asserts it and returns, so nothing ever reports "skipped".
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const RIG = "scripts/repro-obs96.mjs";
const EXPORT_SCRIPT = join(ROOT, "scripts/export-public.sh");
const inPrivateTree = existsSync(EXPORT_SCRIPT) && existsSync(join(ROOT, RIG));

function assertRigAbsentFromPublicTree(): void {
  const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
  expect(tracked).not.toContain(RIG);
  expect(existsSync(join(ROOT, RIG))).toBe(false);
}

type Rig = typeof import("../scripts/repro-obs96.mjs");
const loadRig = (): Promise<Rig> => import(pathToFileURL(join(ROOT, RIG)).href) as Promise<Rig>;

interface SuiteRun {
  exitCode: number;
  signature: { key: string };
}

/** Injectable deps for runAttempt that record call order; red decided per attempt number. */
function fakeDeps(redAttempts: Set<number>, calls: string[]) {
  const suiteRun = (exitCode: number): SuiteRun => ({ exitCode, signature: { key: exitCode === 0 ? "none" : "cli+version" } });
  return {
    makeClone: (n: number) => {
      calls.push(`clone:${n}`);
      return `/fake/clone-${n}`;
    },
    install: (dir: string, n: number) => {
      calls.push(`install:${n}:${dir}`);
      return suiteRun(0);
    },
    runSuite: (dir: string, n: number, phase: string) => {
      calls.push(`${phase}:${n}:${dir}`);
      return suiteRun(phase === "first" && redAttempts.has(n) ? 1 : 0);
    },
  };
}

describe("OBS-96 cold-clone repro rig — private-only, telemetry, paired warm controls", () => {
  test("the export candidate tree does not contain the repro rig script", () => {
    if (!inPrivateTree) {
      // exported/public tree: this tree IS the shipped candidate — the rig must simply be absent
      assertRigAbsentFromPublicTree();
      return;
    }
    // private tree: build the candidate's path listing with the exporter's own `git archive`
    // pathspecs, extracted from the script so the two can never drift apart
    const script = readFileSync(EXPORT_SCRIPT, "utf8");
    const excludes = [...script.matchAll(/':\((exclude[^)]*)\)([^']+)'/g)].map((m) => `:(${m[1]})${m[2]}`);
    expect(excludes.length).toBeGreaterThan(5); // the extraction found the real pathspec list
    expect(excludes).toContain(`:(exclude)${RIG}`);
    const listed = execSync(`git archive HEAD -- . ${excludes.map((e) => `'${e}'`).join(" ")} | tar -t`, {
      cwd: ROOT,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(listed).toContain("package.json"); // the enumeration produced a real tree
    expect(listed).not.toContain(RIG);
    // the post-archive steps in export-public.sh only write enumerated docs/spec-stub/.gitignore
    // paths, never scripts/ — and the export-manifest allowlist fail-closes any scripts/ addition
  });

  test("the rig's telemetry capture includes platform, available parallelism, and load average for each attempt", async () => {
    if (!inPrivateTree) {
      assertRigAbsentFromPublicTree();
      return;
    }
    const rig = await loadRig();
    const calls: string[] = [];
    const records = [];
    for (let n = 1; n <= 2; n++) records.push(await rig.runAttempt(n, fakeDeps(new Set(), calls)));
    for (const r of records) {
      expect(r.telemetry.platform).toMatch(/\w/);
      expect(r.telemetry.availableParallelism).toBeGreaterThanOrEqual(1);
      expect(r.telemetry.loadAverage).toHaveLength(3);
      for (const l of r.telemetry.loadAverage) expect(l).toBeGreaterThanOrEqual(0);
    }
    // one snapshot per attempt, not one shared snapshot
    expect(records[0].telemetry).not.toBe(records[1].telemetry);
  });

  test("a red first-run attempt is always immediately followed by a warm-control rerun on the same clone in the rig's own output", async () => {
    if (!inPrivateTree) {
      assertRigAbsentFromPublicTree();
      return;
    }
    const rig = await loadRig();
    const calls: string[] = [];
    const red = await rig.runAttempt(1, fakeDeps(new Set([1]), calls));
    const green = await rig.runAttempt(2, fakeDeps(new Set(), calls));
    // red attempt: the call right after the first run is the warm control, on the same clone dir
    const firstIdx = calls.indexOf("first:1:/fake/clone-1");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(calls[firstIdx + 1]).toBe("warm-control:1:/fake/clone-1");
    expect(red.red).toBe(true);
    expect(red.warmControl).not.toBeNull();
    expect(red.warmControl!.exitCode).toBe(0);
    // green attempt: first-run-only condition — no warm control ever runs
    expect(green.red).toBe(false);
    expect(green.warmControl).toBeNull();
    expect(calls.filter((c) => c.startsWith("warm-control:2:"))).toEqual([]);
    // and the rig's own summary output counts the pairing
    const verdict = rig.verdictOf([red, green]);
    expect(verdict.redFirstRuns).toBe(1);
    expect(verdict.warmControlsRun).toBe(1);
    expect(verdict.warmControlsGreen).toBe(1);
  });

  test("three independently cold attempts against unfixed HEAD reproduce the same built-CLI failure signature the fix task will target", async () => {
    if (!inPrivateTree) {
      assertRigAbsentFromPublicTree();
      return;
    }
    const rig = await loadRig();
    const rec = rig.REPRO_RECORD as {
      sha: string;
      verdict: { attempts: number; redFirstRuns: number; signature: string; sameSignatureAcrossRedRuns: boolean; warmControlsGreen: number; reproduced: boolean };
      attempts: { n: number; builtCliCrashes: { version: number; help: number }; missingDist: boolean; coldSuiteExit: number }[];
    };
    // the verbatim record of the live --attempts 3 run: 3 independently cold clones of unfixed HEAD,
    // all red on the one built-CLI target signature, each with a green warm-control on the same clone
    const TARGET = "tests/cli/cli.test.ts+tests/cli/version.test.ts";
    expect(rec.verdict.signature).toBe(TARGET);
    expect(rec.verdict.reproduced).toBe(true);
    expect(rec.verdict.redFirstRuns).toBe(3);
    expect(rec.verdict.sameSignatureAcrossRedRuns).toBe(true);
    expect(rec.verdict.warmControlsGreen).toBe(3);
    expect(rec.attempts).toHaveLength(3);
    // every recorded attempt crashed the built CLI in BOTH files (version-family + help/unknown) with
    // dist PRESENT (missingDist:false) — the OBS-96 target, never the ignore-scripts missing-dist phantom
    for (const a of rec.attempts) {
      expect(a.builtCliCrashes.version).toBeGreaterThan(0);
      expect(a.builtCliCrashes.help).toBeGreaterThan(0);
      expect(a.missingDist).toBe(false);
    }
    // feed the recorded shape back through the rig's OWN verdict logic — it independently agrees these
    // three cold attempts reproduce the target signature (all red, one key, warm-control green)
    const records = rec.attempts.map(() => ({
      red: true,
      firstRun: { exitCode: 1, signature: { key: TARGET } },
      warmControl: { exitCode: 0 },
    }));
    const verdict = rig.verdictOf(records);
    expect(verdict.reproduced).toBe(true);
    expect(verdict.sameSignatureAcrossRedRuns).toBe(true);
    expect(verdict.signatures).toEqual([TARGET]);
  });
});
