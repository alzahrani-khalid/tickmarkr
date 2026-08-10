import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Baseline, compareToBaseline } from "../../src/gates/baseline.js";
import { makeRepo } from "../helpers/tmprepo.js";

// T9: infra must never mask a regression. The discriminator lives in compareToBaseline, so this
// suite drives the REAL gate — a shell script emitting the output, the gate running it, and the
// classification read off the recorded GateResult. A regex kept in the test file, or a discriminator
// wired to nothing, cannot make these pass.

const RED_BASELINE: Baseline = { commands: { test: { exitCode: 1, fingerprints: [] } } };

/** Run the test gate over a script that prints `lines` and exits 1, and return its GateResult. */
async function gateOver(lines: string[], baseline: Baseline = RED_BASELINE) {
  const repo = makeRepo({ "base.txt": "base\n" });
  writeFileSync(join(repo, "run.sh"), `${lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join("\n")}\nexit 1\n`);
  const results = await compareToBaseline(repo, { test: "bash run.sh" }, baseline, ["test"]);
  return results[0];
}

describe("baseline failure classification (real gate, zero tokens)", () => {
  test('test: compareToBaseline classifies "AssertionError after spawn EAGAIN" as regression and "spawn EAGAIN" as infra, then repeats with AssertionError and EAGAIN on separate lines; assert the recorded gate result classification so a test-only regex or disabled discriminator fails', async () => {
    // One line carrying BOTH tokens. The errno is present, but the line names a test-level failure,
    // so the output is a regression — laundering it into "infra" is how a real defect gets forgiven.
    const together = await gateOver(["AssertionError after spawn EAGAIN"]);
    expect(together.meta?.classification).toBe("regression");
    expect(together.meta?.infra).toBeUndefined();

    // The same errno with nothing naming a test failure: the runner died on the machine.
    const infraOnly = await gateOver(["spawn EAGAIN"]);
    expect(infraOnly.meta?.classification).toBe("infra");

    // Repeat with the two tokens on SEPARATE lines, in both orders — the classification is a
    // property of the whole output, not of one line's word order.
    const split = await gateOver(["Error: spawn EAGAIN", "AssertionError: expected 1 to be 2"]);
    expect(split.meta?.classification).toBe("regression");
    const splitReversed = await gateOver(["AssertionError: expected 1 to be 2", "Error: spawn EAGAIN"]);
    expect(splitReversed.meta?.classification).toBe("regression");

    // And the errno alone on its own lines stays infra, so the discriminator is not simply
    // answering "regression" to everything.
    const infraLines = await gateOver(["Error: spawn EAGAIN", "    at ChildProcess.spawn (node:internal/child_process:421:11)"]);
    expect(infraLines.meta?.classification).toBe("infra");
  });

  test("a regression is never forgiven by a red baseline just because an errno shares the output", async () => {
    // The forgiveness path is the one at risk: the baseline is red, so a fingerprint that matches it
    // is pre-existing. A fresh AssertionError beside an EAGAIN is not pre-existing and must reject.
    const preExisting: Baseline = { commands: { test: { exitCode: 1, fingerprints: ["Error: spawn EAGAIN"] } } };
    const g = await gateOver(["Error: spawn EAGAIN", "AssertionError: expected 1 to be 2"], preExisting);
    expect(g.pass).toBe(false);
    expect(g.meta?.classification).toBe("regression");
  });

  test("a completed suite that exits zero is never classified at all", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    writeFileSync(join(repo, "run.sh"), "printf '%s\\n' ' Tests  0 failed | 3 passed (3)'\nexit 0\n");
    const [g] = await compareToBaseline(repo, { test: "bash run.sh" }, RED_BASELINE, ["test"]);
    expect(g.pass).toBe(true);
    expect(g.meta?.classification).toBeUndefined();
    expect(g.meta?.infra).toBeUndefined();
  });
});
