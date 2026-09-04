import { describe, expect, test } from "vitest";
import { classifyFailureOutput, fingerprint } from "../../src/gates/baseline.js";

// OBS-891 / OBS-888 (run 3372, 2026-09-04): seven "infra" parks whose only fresh line was a vitest
// echo-block header — or that block's content — glued to a cursor-show escape the ANSI stripper did not
// know. The bytes below are the journal's own (digits masked to `#` by the fingerprint normaliser in the
// stored row; raw `25` here). A test-owned block can never be runner evidence about the work.

const T9_HEADER = "stderr | tests/cli/doctor.test.ts > model status table (T9) > test: a channel whose doctor record carries the probe-error errno EMFILE renders probe error (EMFILE) on its doctor row and never the unauthed wording";
const SUMMARY = " Test Files  1 passed (1)\n      Tests  1 passed (1)\n";
// fingerprint() reports unshaped non-empty output as the constant UNRECOGNIZED_FAILURE marker, which can
// never be a fresh fingerprint; the claim under test is that NO errno-bearing line becomes one.
const errnoFingerprints = (out: string) => fingerprint(out).filter((l) => /\bE(?:AGAIN|MFILE)\b/.test(l));

describe("OBS-891 — an echo-block header glued to a private-mode escape is still a header", () => {
  test("test: the exact row that parked T9 — a cursor-show sequence before `stderr |` — yields no fingerprint and no infra verdict whereas the old stripper read the test's own title as host evidence", () => {
    const out = `\x1b[?25h${T9_HEADER}\nprobe error (EMFILE)\n\n${SUMMARY}`;
    expect(errnoFingerprints(out)).toEqual([]);
    expect(classifyFailureOutput(out)).toBeUndefined();
  });

  test("test: the digit-normalized form a stored baseline carries (`\\x1b[?#h`) is stripped the same way", () => {
    const out = `\x1b[?#h${T9_HEADER}\nError: spawn EAGAIN\n\n${SUMMARY}`;
    expect(errnoFingerprints(out)).toEqual([]);
    expect(classifyFailureOutput(out)).toBeUndefined();
  });

  test("test: cursor-hide, erase-line and SGR sequences on the same header are all stripped", () => {
    for (const esc of ["\x1b[?25l", "\x1b[2K", "\x1b[1;32m", "\x1b[0m\x1b[?25h"]) {
      const out = `${esc}${T9_HEADER}\nError: spawn EAGAIN\n\n${SUMMARY}`;
      expect(errnoFingerprints(out), esc).toEqual([]);
      expect(classifyFailureOutput(out), esc).toBeUndefined();
    }
  });

  test("test: a bare errno line OUTSIDE any block still classifies infra — the fix narrows nothing about real host evidence", () => {
    expect(classifyFailureOutput(`\x1b[?25h${T9_HEADER}\nfine\n\nError: spawn EAGAIN\n`)).toBe("infra");
  });
});

describe("OBS-888 row 1 — every header form vitest writes closes a block", () => {
  test.each([
    ["unattributed", "stderr | unknown test"],
    ["file-level", "stderr | tests/gates/baseline-turbo-prefix.test.ts"],
    ["raw task id", "stdout | 1757021160000_3_1"],
    ["attributed", "stderr | tests/gates/baseline-turbo-prefix.test.ts > turbo-prefixed vitest echo blocks do not invalidate baseline capture"],
  ])("test: a %s header hides its block's errno line from fingerprints and from the infra classifier whereas an unrecognised header leaks it", (_form, header) => {
    const out = `${header}\nintake-backend:test: Error: spawn EAGAIN\n\n${SUMMARY}`;
    expect(errnoFingerprints(out)).toEqual([]);
    expect(classifyFailureOutput(out)).toBeUndefined();
  });
});

describe("OBS-888 — tickmarkr's own operator line is never a verdict about the work", () => {
  const OPERATOR = 'tickmarkr: baseline capture for "lint" completed with process/resource-exhaustion evidence — it recorded NO exit-code verdict and NO fingerprints, so nothing is forgiven for this command; the measurement cannot distinguish a pre-existing failure from one caused by exhaustion. First invalidating line: intake-backend:test: Error: spawn EAGAIN';

  test("test: the sentence that parked T5 four times, standing alone outside any block, is neither a fingerprint nor infra evidence whereas the same errno token on a runner line is", () => {
    expect(errnoFingerprints(`${OPERATOR}\n${SUMMARY}`)).toEqual([]);
    expect(classifyFailureOutput(OPERATOR)).toBeUndefined();
    expect(classifyFailureOutput("Error: spawn EAGAIN")).toBe("infra");
  });

  test("test: a turbo-prefixed operator line is excluded in its stripped form too", () => {
    expect(errnoFingerprints(`intake-backend:test:  ${OPERATOR}\n${SUMMARY}`)).toEqual([]);
  });
});
