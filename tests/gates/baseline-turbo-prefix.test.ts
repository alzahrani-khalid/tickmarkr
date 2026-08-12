import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { captureBaseline, classifyFailureOutput, compareToBaseline, fingerprint, freshFailures, UNRECOGNIZED_FAILURE } from "../../src/gates/baseline.js";
import { makeRepo } from "../helpers/tmprepo.js";

// GATE-FIX-4 DEFECT 4 (dossier drill, control 3, verbatim gate stdout): turbo prefixes every child
// line with `<pkg>:<task>:  `, and the per-test recognizers anchor at line START, so inner FAIL/×
// lines never fingerprinted — forgiveness compared only the package-level turbo lines, and a
// deliberate new failing test inside an already-red package produced fingerprints byte-identical
// to baseline and came back green. The counts route is no rescue: normalizeLine masks digits, so
// `Tests 3 failed` and `Tests 2 failed` are the same fingerprint. Per-test lines carry file paths
// and test names that survive normalization — that discriminator is what these tests pin.

// The tolerated pre-existing red: "2 pre-existing TZ flake" (GATE-FIX-4 §4).
const PRE_EXISTING = [
  "intake-backend:test:  × tz offset flake (pre-existing)",
  "intake-backend:test:  FAIL tests/unit/tz.service.test.ts > tz offset flake (pre-existing)",
  "intake-backend:test:  × tz boundary flake (pre-existing)",
  "intake-backend:test:  FAIL tests/unit/tz.service.test.ts > tz boundary flake (pre-existing)",
];
// Verbatim bytes from the drill's gate stdout (GATE-FIX-4 §4, control 3 injection).
const GF4BE = [
  "intake-backend:test:  × GF4BE deliberate failure — probe only",
  "intake-backend:test:  FAIL tests/unit/auth.service.test.ts > GF4BE deliberate failure",
];
// The package-level lines — before the fix, the ONLY lines forgiveness compared.
const PACKAGE_LINES = [
  "Failed:    intake-backend#test",
  " ERROR  intake-backend#test: command (/backend) /Users/x/v1.2.3/bin/pnpm run test exited (1)",
  " ERROR  run failed: command exited (1)",
];
const BASELINE_OUT = [...PRE_EXISTING, "intake-backend:test:  Tests  2 failed | 254 passed (256)", ...PACKAGE_LINES].join("\n") + "\n";
const HEAD_OUT = [...PRE_EXISTING, ...GF4BE, "intake-backend:test:  Tests  3 failed | 253 passed (256)", ...PACKAGE_LINES].join("\n") + "\n";

describe("GATE-FIX-4 DEFECT 4 — turbo-prefixed per-test failures fingerprint", () => {
  test("a NEW failing test inside an already-red package reds the gate, named per-test", async () => {
    const repo = makeRepo({ "out.txt": BASELINE_OUT, "run.sh": "cat out.txt; exit 1\n" });
    const commands = { test: "bash run.sh" };
    const base = await captureBaseline(repo, commands);
    expect(base.commands.test.exitCode).toBe(1);

    writeFileSync(join(repo, "out.txt"), HEAD_OUT);
    const [r] = await compareToBaseline(repo, commands, base, ["test"]);
    expect(r!.pass).toBe(false);
    // the red NAMES the injected test — the runner's own raw FAIL line in the headline (HYG-08:
    // the × glyph twin is a fingerprintable shape but never headline material — the FAIL line is)…
    expect(r!.details).toContain("intake-backend:test:  FAIL tests/unit/auth.service.test.ts > GF4BE deliberate failure");
    // …its normalized per-test fingerprint in the diff section…
    expect(r!.details).toContain("FAIL tests/unit/auth.service.test.ts > GF#BE deliberate failure");
    // …and the × glyph line as a second per-test discriminator among the fresh fingerprints
    expect(r!.details).toContain("× GF#BE deliberate failure — probe only");

    // The fresh set is exactly the injected test's lines: the moved counts (2→3 failed) normalize
    // identically under digit masking, and the package-level + pre-existing lines stay forgiven.
    const { failing } = freshFailures(base.commands.test, HEAD_OUT);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.every((f) => f.includes("GF#BE"))).toBe(true);
    expect(failing).toContain("FAIL tests/unit/auth.service.test.ts > GF#BE deliberate failure");
  });

  test("recurrence stays forgiven: head byte-identical to baseline is green", async () => {
    const repo = makeRepo({ "out.txt": BASELINE_OUT, "run.sh": "cat out.txt; exit 1\n" });
    const commands = { test: "bash run.sh" };
    const base = await captureBaseline(repo, commands);
    const [r] = await compareToBaseline(repo, commands, base, ["test"]);
    expect(r!).toMatchObject({ gate: "test", pass: true });
    expect(r!.details).toMatch(/pre-existing/i);
  });

  test("a bare vitest FAIL line and its turbo-prefixed twin produce the SAME fingerprint", () => {
    const bare = "FAIL tests/unit/auth.service.test.ts > GF4BE deliberate failure";
    expect(fingerprint(`intake-backend:test:  ${bare}`)).toEqual(fingerprint(bare));
    // glyph twin: the prefixed line also keeps its prefixed fingerprint (baseline-recorded reds
    // stay forgivable), so containment of the bare runner's fingerprint is the identity that matters
    const glyph = "× GF4BE deliberate failure — probe only";
    expect(fingerprint(`intake-backend:test:  ${glyph}`)).toContain(fingerprint(glyph)[0]!);
  });

  test("the prefix pass is conservative: Error:-anchored and file:line prefixes are never stripped", () => {
    // spawn/ENOENT infra-classification path unchanged: `Error:` is ONE colon segment, not a
    // `<pkg>:<task>:` prefix, so these lines read exactly as before the prefix pass existed
    expect(classifyFailureOutput("Error: spawnSync pnpm ENOENT")).toBe("regression");
    expect(classifyFailureOutput("Error: spawn EAGAIN")).toBe("infra");
    expect(fingerprint("Error: spawnSync pnpm ENOENT")).toEqual(["Error: spawnSync pnpm ENOENT"]);
    // a file:line prefix (digit segment) is not a turbo prefix — stripping it would launder the
    // embedded `Error:` into a shape this line never had at line start
    expect(fingerprint("src/x.ts:12: Error: boom")).toEqual([UNRECOGNIZED_FAILURE]);
  });
});
