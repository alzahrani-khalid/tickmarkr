import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type Baseline, captureBaseline, compareToBaseline, fingerprint } from "../../src/gates/baseline.js";
import type { ShResult } from "../../src/run/git.js";
import { makeRepo } from "../helpers/tmprepo.js";

// OBS-534 (T2): a capture killed at its ceiling is only reachable through the shell seam — waiting
// out a 10-minute ceiling is not a test. This spy passes every call through to the real shell (every
// other test in this file keeps running real commands, byte-identically) and lets one test hand back
// the ShResult git.ts produces for a SIGKILLed child. vi.hoisted: the factory is hoisted above the
// imports, so its state must be too.
const shSpy = vi.hoisted(() => ({ stub: undefined as undefined | ((cmd: string) => ShResult | undefined) }));

vi.mock("../../src/run/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/git.js")>();
  return {
    ...actual,
    sh: (cmd: string, cwd: string, timeoutMs?: number) => {
      const stubbed = shSpy.stub?.(cmd);
      return stubbed ? Promise.resolve(stubbed) : actual.sh(cmd, cwd, timeoutMs);
    },
  };
});

afterEach(() => { shSpy.stub = undefined; });

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

// OBS-534 second half (v1.95 T2): run 1501's capture for `test` was itself SIGKILLed at the 600s
// default and stored as `{durationMs: 600007, exitCode: 1}` — a kill written down as a red baseline.
// There the accident helped (ceiling 1800021ms is why every task gate passed); the same accident can
// mark a green command permanently red-at-baseline and hand every later gate free forgiveness.
describe("a killed baseline capture is infra, not a red baseline (OBS-534)", () => {
  const FRESH = "FAIL tests/new.test.ts > introduced by this run";
  const KNOWN = "FAIL tests/known.test.ts > pre-existing red";
  /** What the run-1501 entry becomes: a cause, a measurement, and no verdict to forgive. */
  const killedCapture = (fingerprints: string[] = []): Baseline => ({
    commands: { test: { infra: true, fingerprints, durationMs: 600_007, ceilingMs: 1_800_021 } },
  });

  test("a baseline capture whose command is killed at its ceiling records an infra cause and no exit-code verdict, so a kill stored as a nonzero red-at-baseline entry fails", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    writeFileSync(join(repo, "red.sh"), `printf '%s\\n' ${JSON.stringify(KNOWN)}\nexit 1\n`);
    // exactly what git.ts hands back for a SIGKILLed child: timedOut, the kill's exit code, and only
    // the partial output the runner had flushed (run 1501's had no vitest summary at all)
    shSpy.stub = (cmd) => cmd.includes("slow.sh")
      ? { code: 1, stdout: "RUN v3.2.4\n\n  ✓ tests/a.test.ts (12)\n", stderr: "", timedOut: true, durationMs: 600_007 }
      : undefined;

    const base = await captureBaseline(repo, { test: "bash slow.sh", lint: "bash red.sh" });

    const killed = base.commands.test!;
    expect(killed.infra).toBe(true);
    expect(killed.exitCode).toBeUndefined(); // the kill is not a verdict about the command
    expect(killed.fingerprints).toEqual([]); // nothing flushed before a kill is "pre-existing"
    expect(killed.durationMs).toBe(600_007); // the one thing the kill did measure, kept
    expect(killed.ceilingMs).toBe(1_800_021); // …and still scaling the next ceiling up

    // control, through the REAL shell: a command that genuinely exited nonzero still records its
    // verdict and its fingerprints, so the discriminator is the kill and not a blanket rule.
    const red = base.commands.lint!;
    expect(red.exitCode).toBe(1);
    expect(red.infra).toBeUndefined();
    expect(red.fingerprints).toEqual(fingerprint(KNOWN));
  });

  test("a later gate whose baseline entry is infra-recorded forgives nothing and charges its own fresh failures, so free forgiveness inherited from a killed capture fails", async () => {
    // the failure the diff really caused, against a capture that never returned a verdict
    const charged = await gateOver([FRESH], killedCapture());
    expect(charged.pass).toBe(false);
    expect(charged.details).toContain("tests/new.test.ts");

    // even a fingerprint the killed capture happened to flush before the kill forgives nothing:
    // the suite behind it never finished, so no line of it is evidence of a pre-existing red
    const laundered = await gateOver([FRESH], killedCapture(fingerprint(FRESH)));
    expect(laundered.pass).toBe(false);
    expect(laundered.details).toContain("tests/new.test.ts");

    // and an unreadable red fails CLOSED against a killed capture instead of reading as
    // "only pre-existing failures (forgiven)" — the free-forgiveness route the kill opened
    const unreadable = await gateOver(["the runner said something no shape here names"], killedCapture());
    expect(unreadable.pass).toBe(false);
    expect(unreadable.details).toContain("failing closed");

    // control: a genuinely red baseline still forgives its own recorded failure
    const forgiven = await gateOver([KNOWN], { commands: { test: { exitCode: 1, fingerprints: fingerprint(KNOWN) } } });
    expect(forgiven.pass).toBe(true);
    expect(forgiven.details).toContain("forgiven");
  });
});
