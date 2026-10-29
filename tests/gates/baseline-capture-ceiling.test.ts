import { afterEach, expect, test, vi } from "vitest";
import { CAPTURE_CEILING_MS, CAPTURE_HARD_MAX_MS, captureBaseline, captureCeilingMs } from "../../src/gates/baseline.js";
import * as git from "../../src/run/git.js";
import { makeRepo } from "../helpers/tmprepo.js";

afterEach(() => vi.restoreAllMocks());

const minute = 60_000;

test("test: a baseline capture runs each command under the ceiling its own prior scales to by every row of the closed ceiling table, never below thirty minutes or above four hours, its kill line naming that ceiling, so a fixed or unbounded ceiling fails", async () => {
  expect(CAPTURE_CEILING_MS).toBe(30 * minute);
  expect(CAPTURE_HARD_MAX_MS).toBe(240 * minute);
  const repo = makeRepo({ "base.txt": "base\n" });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const armed: number[] = [];
  vi.spyOn(git, "sh").mockImplementation(async (_cmd, _cwd, timeout) => {
    armed.push(timeout!);
    return { code: 137, stdout: "partial output", stderr: "", timedOut: true, durationMs: timeout };
  });
  const rows: Array<[unknown, number]> = [
    [undefined, 30 * minute],
    [{ durationMs: 30 * minute, ceilingMs: 90 * minute }, 90 * minute],
    [{ exitCode: 0, durationMs: 28 * minute, ceilingMs: 84 * minute }, 84 * minute],
    [{ durationMs: 2_000_000 }, 6_000_000],
    [{ durationMs: 5 * minute }, 30 * minute],
    [{ durationMs: 10 * 60 * minute }, 240 * minute],
    [{ ceilingMs: "9000000" }, 30 * minute],
    [{ ceilingMs: NaN }, 30 * minute],
    [{ ceilingMs: Infinity }, 30 * minute],
    [{ ceilingMs: -1 }, 30 * minute],
    [{ durationMs: "2000000" }, 30 * minute],
    [null, 30 * minute],
    ["prior", 30 * minute],
    [42, 30 * minute],
    [{ durationMs: Number.MAX_VALUE }, 240 * minute],
    [{ ceilingMs: 10 * 60 * minute }, 240 * minute],
    [{ durationMs: 0 }, 30 * minute],
  ];
  for (const [prior, expected] of rows) {
    armed.length = 0; errors.mockClear();
    const captured = await captureBaseline(repo, { build: "probe build", test: "probe test" }, { priors: { build: prior } });
    expect(armed).toEqual([expected, 30 * minute]);
    expect(errors.mock.calls[0]?.[0]).toContain(`"build" was killed at its ${expected}ms ceiling`);
    expect(errors.mock.calls[1]?.[0]).toContain(`"test" was killed at its ${30 * minute}ms ceiling`);
    expect(captured.commands.build).toMatchObject({ infra: true, invalidCause: "ceiling-kill", durationMs: expected, ceilingMs: expected * 3, fingerprints: [] });
    expect(captured.commands.build?.exitCode).toBeUndefined();
  }
});

test("test: a persisted prior that is null, not an object or not a finite number counts as no measurement without a throw, so a prior dereferenced or coerced before validation fails", async () => {
  const repo = makeRepo({ "base.txt": "base\n" });
  const armed: number[] = [];
  vi.spyOn(git, "sh").mockImplementation(async (_cmd, _cwd, timeout) => {
    armed.push(timeout!);
    return { code: 0, stdout: "", stderr: "", durationMs: 1 };
  });
  const persisted = ['null', 'false', '17', '"2000000"', '[]', '{}', '{"durationMs":null}',
    '{"durationMs":"2000000"}', '{"durationMs":-1}', '{"ceilingMs":"9000000","durationMs":2000000}'];
  const invalid = [...persisted.map(bytes => JSON.parse(bytes)), { durationMs: NaN }, { durationMs: Infinity },
    { ceilingMs: NaN, durationMs: 2_000_000 }, { ceilingMs: Infinity, durationMs: 2_000_000 },
    { ceilingMs: -1, durationMs: 2_000_000 },
    { durationMs: { valueOf: () => { throw new Error("must never coerce a prior"); } } }];
  for (const prior of invalid) {
    expect(captureCeilingMs(prior)).toBe(30 * minute);
    await expect(captureBaseline(repo, { test: "probe test" }, { priors: { test: prior } })).resolves.toMatchObject({ commands: { test: { exitCode: 0 } } });
  }
  expect(armed).toEqual(invalid.map(() => 30 * minute));
  // Only the field the gate helper reads is validated: a real ceiling takes precedence.
  expect(captureCeilingMs({ ceilingMs: 90 * minute, durationMs: "invalid but unused" })).toBe(90 * minute);
});
