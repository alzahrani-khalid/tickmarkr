import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { captureBaseline, classifyRunnerOutput, compareToBaseline, hostStarved, resetCalmWindowForTests, setCalmWindowForTests, type Baseline } from "../../src/gates/baseline.js";

// Run 3372's host-starved shape: every failed case ended at a child-process timeout.
const RED_TIMEOUTS = ` RUN  v3.2.7 /repo

 ❯ tests/a.test.ts (2 tests | 2 failed) 40000ms
   × suite one > case one 20001ms
   × suite one > case two 20002ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |suite| tests/a.test.ts > suite one > case one
Error: Test timed out in 20000ms.
 ❯ tests/a.test.ts:10:3

 FAIL  |suite| tests/a.test.ts > suite one > case two
Error: named test exceeded 60 seconds
 ❯ tests/a.test.ts:20:3

 Test Files  1 failed (1)
      Tests  2 failed (2)
   Duration  40.10s
`;
const RED_MIXED = RED_TIMEOUTS.replace("Error: named test exceeded 60 seconds", "AssertionError: expected 1 to be 2 // Object.is equality");
const RED_EMPTY_ASSERTION = RED_TIMEOUTS.replace("Error: named test exceeded 60 seconds", "AssertionError: expected '' to be 'hello'");
const RED_GOT_EMPTY_ASSERTION = RED_TIMEOUTS.replace("Error: named test exceeded 60 seconds", "AssertionError: expected output to match, got '' instead");
const GREEN_TEARDOWN = ` ✓ config > bad tier value throws ConfigError 412ms
tickmarkr: diagnostic mentions RoutingError

 Test Files  0 failed | 1 passed (1)
      Tests  1 passed (1)
   Duration  1.00s

⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
`;
const INFRA_NO_SUMMARY = `Error: [vitest-worker]: Timeout calling "onTaskUpdate"\n`;

function scriptRepo(steps: Array<{ out: string; code: number; sleep?: number }>): { repo: string; counter: string } {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-starved-"));
  const counter = join(repo, "calls");
  writeFileSync(counter, "0");
  const cases = steps.map((s, i) => `${i + 1}) cat ${JSON.stringify(join(repo, `out${i + 1}.txt`))}; sleep ${s.sleep ?? 0}; exit ${s.code};;`).join("\n");
  steps.forEach((s, i) => writeFileSync(join(repo, `out${i + 1}.txt`), s.out));
  writeFileSync(join(repo, "run.sh"), `#!/bin/bash\nn=$(cat ${JSON.stringify(counter)}); n=$((n+1)); echo $n > ${JSON.stringify(counter)}\ncase $n in\n${cases}\n*) cat ${JSON.stringify(join(repo, `out${steps.length}.txt`))}; exit ${steps.at(-1)!.code};;\nesac\n`);
  chmodSync(join(repo, "run.sh"), 0o755);
  return { repo, counter };
}
const calls = (counter: string) => Number(readFileSync(counter, "utf8"));
const base = (durationMs: number): Baseline => ({ commands: { test: { exitCode: 0, fingerprints: [], durationMs } } });

describe("host-starved classification (OBS-896)", () => {
  afterEach(() => resetCalmWindowForTests());

  test("test: a test gate whose fresh failures are every one timeout-class and whose duration is at least twice the baseline's own classifies host-starved while the same output with one assertion failure among them or the same failures at an ordinary duration classifies a plain red whereas a classifier that forgives the assertion or the ordinary duration fails", () => {
    expect(hostStarved(RED_TIMEOUTS, 1_286_000, 400_000)).toBe(true);
    expect(hostStarved(RED_MIXED, 1_286_000, 400_000)).toBe(false);
    expect(hostStarved(RED_EMPTY_ASSERTION, 1_286_000, 400_000)).toBe(false);
    expect(hostStarved(RED_GOT_EMPTY_ASSERTION, 1_286_000, 400_000)).toBe(false);
    expect(hostStarved(RED_TIMEOUTS, 430_000, 400_000)).toBe(false);
    expect(hostStarved(RED_TIMEOUTS, 1_286_000, undefined)).toBe(false);
  });

  test("test: a host-starved test verdict makes the gate runner wait for a calm load window and rerun that gate once with the row naming the rerun and the wait and a green rerun leaves no repair attempt while a rerun still red is the verdict whereas a runner that charges a repair on the first read fails", async () => {
    const waitForCalm = () => {
      let samples = 0;
      setCalmWindowForTests({ loadProvider: () => samples++ === 0 ? 10 : 0, calmLoad: () => 1, pollMs: 5 });
      return () => samples;
    };
    const samples = waitForCalm();
    const green = scriptRepo([{ out: RED_TIMEOUTS, code: 1, sleep: 0.3 }, { out: " Test Files  1 passed (1)\n      Tests  2 passed (2)\n", code: 0 }]);
    const [g] = await compareToBaseline(green.repo, { test: "bash run.sh" }, base(100), ["test"]);
    expect(calls(green.counter)).toBe(2);
    expect(g).toMatchObject({ gate: "test", pass: true, meta: { hostStarvedRerun: { referenceMs: 100 } } });
    const provenance = (g!.meta as { hostStarvedRerun: { durationMs: number; waitedMs: number } }).hostStarvedRerun;
    expect(provenance.durationMs).toBeGreaterThanOrEqual(200);
    // OBS-966 add.3: timers may wake below their requested 5ms; assert the calm observation,
    // which admits the rerun, rather than treating timer precision as the policy.
    expect(samples()).toBe(2);
    expect(provenance.waitedMs).toBeGreaterThanOrEqual(0);
    expect(g!.details).toMatch(/host-starved rerun after waiting \d+ms for a calm load window/);

    waitForCalm();
    const stillRed = scriptRepo([{ out: RED_TIMEOUTS, code: 1, sleep: 0.3 }, { out: RED_MIXED, code: 1 }]);
    const [r] = await compareToBaseline(stillRed.repo, { test: "bash run.sh" }, base(100), ["test"]);
    expect(calls(stillRed.counter)).toBe(2);
    expect(r).toMatchObject({ pass: false, meta: { hostStarvedRerun: { referenceMs: 100, waitedMs: expect.any(Number) } } });

    const mixed = scriptRepo([{ out: RED_MIXED, code: 1, sleep: 0.3 }]);
    const [m] = await compareToBaseline(mixed.repo, { test: "bash run.sh" }, base(100), ["test"]);
    expect(calls(mixed.counter)).toBe(1); // a real assertion among the timeouts: no rerun, a plain red
    expect(m!.pass).toBe(false);
    expect(m!.meta?.hostStarvedRerun).toBeUndefined();

    const quick = scriptRepo([{ out: RED_TIMEOUTS, code: 1 }]);
    const [q] = await compareToBaseline(quick.repo, { test: "bash run.sh" }, base(100_000), ["test"]);
    expect(calls(quick.counter)).toBe(1); // timeouts at an ordinary duration: a plain red
    expect(q!.pass).toBe(false);
  }, 30_000);
});

describe("one runner classifier on both sides (OBS-966)", () => {
  afterEach(() => resetCalmWindowForTests());

  test("test: a baseline capture whose runner output carries the vitest-worker RPC timeout under the unhandled-errors banner with every test green and exit 1 records the infra cause and no forgivable fingerprints, while a capture naming one failing test beside the same lines records that failure as a fingerprint, so a capture that records the runner timeout as a pre-existing failure fails", async () => {
    const captureSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const output of [
        GREEN_TEARDOWN,
        GREEN_TEARDOWN.replace(' Test Files  0 failed | 1 passed (1)', ''),
        GREEN_TEARDOWN.split("\n").map((line) => `\x1b[?25h${line}\x1b[0m`).join("\n"),
        GREEN_TEARDOWN.split("\n").map((line) => `pkg:test: ${line}`).join("\n"),
      ]) {
        expect(classifyRunnerOutput(output, 1)).toBe("infra");
        const infra = scriptRepo([{ out: output, code: 1 }]);
        const captured = await captureBaseline(infra.repo, { test: "bash run.sh" });
        expect(captured.commands.test).toMatchObject({ infra: true, invalidCause: "infra", fingerprints: [], invalidatingLines: [expect.stringContaining('[vitest-worker]')] });
        expect(captured.commands.test).not.toHaveProperty("exitCode");
        expect(captured.commands.test!.teardownFingerprint).toBeUndefined();
      }
      const mixed = `${GREEN_TEARDOWN}\n FAIL tests/a.test.ts > real failure\nAssertionError: expected true to be false\n`;
      expect(classifyRunnerOutput(mixed, 1)).toBe("regression");
      const red = scriptRepo([{ out: mixed, code: 1 }]);
      const captured = await captureBaseline(red.repo, { test: "bash run.sh" });
      expect(captured.commands.test!.infra).toBeUndefined();
      expect(captured.commands.test!.exitCode).toBe(1);
      expect(captured.commands.test!.fingerprints).toContain("FAIL tests/a.test.ts > real failure");
      expect(classifyRunnerOutput(INFRA_NO_SUMMARY, 1)).toBe("infra");
      expect(classifyRunnerOutput(RED_TIMEOUTS, 1)).toBe("regression");
    } finally { captureSpy.mockRestore(); }
  });

  test("test: a test gate whose fresh output is runner infrastructure alone reruns once after the calm window with the row naming the rerun, a green rerun charges no repair, and a second infra read fails with the infra class first on its details line, while a fresh assertion failure never reruns on this path, so a gate that charges the first infra read as a red fails", async () => {
    const green = " Test Files  1 passed (1)\n Tests 1 passed (1)\n";
    for (const second of [{ out: green, code: 0 }, { out: GREEN_TEARDOWN, code: 1 }]) {
      let samples = 0;
      setCalmWindowForTests({ loadProvider: () => samples++ === 0 ? 10 : 0, calmLoad: () => 1, pollMs: 5 });
      const run = scriptRepo([{ out: GREEN_TEARDOWN, code: 1 }, second]);
      const rows = await compareToBaseline(run.repo, { test: "bash run.sh" }, base(100), ["test"]);
      expect(calls(run.counter)).toBe(2);
      expect(samples).toBe(2); // rerun was admitted only after the calm observation
      expect(rows).toHaveLength(1); // no first-read red to charge to a repair
      expect(rows[0]!.pass).toBe(second.code === 0);
      expect(rows[0]!.details).toMatch(/runner-infra rerun after waiting \d+ms for a calm load window/);
      expect(rows[0]!.meta?.runnerInfraRerun).toBeDefined();
      if (second.code) {
        expect(rows[0]!.details).toMatch(/^infra;/);
        expect(rows[0]!.meta).toMatchObject({ classification: "infra", infra: true });
      }
    }
    const mixed = scriptRepo([{ out: `${GREEN_TEARDOWN}\n FAIL tests/a.test.ts > assertion\nAssertionError: expected 1 to be 2`, code: 1 }]);
    const [red] = await compareToBaseline(mixed.repo, { test: "bash run.sh" }, base(100), ["test"]);
    expect(calls(mixed.counter)).toBe(1);
    expect(red).toMatchObject({ pass: false, meta: { classification: "regression" } });
    expect(red!.meta?.runnerInfraRerun).toBeUndefined();
  });
});
