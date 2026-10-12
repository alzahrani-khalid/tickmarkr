import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type Baseline,
  type BaselineCommand,
  captureBaseline,
  compareToBaseline,
  fingerprint,
  freshFailures,
  resetCalmWindowForTests,
  setCalmWindowForTests,
  UNRECOGNIZED_FAILURE,
} from "../../src/gates/baseline.js";
import { verifyIntegrationTip } from "../../src/run/merge.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// S22 (queue row 22, ANL-021 §7): every case is a REAL captureBaseline capture of a throwaway directory
// whose gate command prints fixed bytes, read back through BOTH production readers — the battery
// (compareToBaseline → freshFailures) and tip verify (verifyIntegrationTip → freshFailures).
// `<cwd>` in a fixture stands for the directory the command runs in, exactly as the runner prints it.

const SCRIPT = 'echo run >> calls.txt; cat out.txt; sleep "$(cat delay.txt)"; exit "$(cat code.txt)"\n';

function stage(dir: string, out: string, code: number, delay: string): void {
  writeFileSync(join(dir, "run.sh"), SCRIPT);
  writeFileSync(join(dir, "out.txt"), out.split("<cwd>").join(dir));
  writeFileSync(join(dir, "code.txt"), String(code));
  writeFileSync(join(dir, "delay.txt"), delay);
}

async function capture(out: string, gate = "lint", code = 1): Promise<Baseline> {
  const repo = makeRepo({ "README.md": "capture\n" });
  stage(repo, out, code, "0");
  return captureBaseline(repo, { [gate]: "bash run.sh" });
}

interface ReadOpts { gate?: string; code?: number; delay?: string }

async function battery(baseline: Baseline, out: string, opts: ReadOpts = {}) {
  const gate = opts.gate ?? "lint";
  const repo = makeRepo({ "README.md": "candidate\n" });
  stage(repo, out, opts.code ?? 1, opts.delay ?? "0");
  const [result] = await compareToBaseline(repo, { [gate]: "bash run.sh" }, baseline, [gate]);
  return { result: result!, calls: readFileSync(join(repo, "calls.txt"), "utf8").trim().split("\n").length };
}

async function tip(baseline: Baseline, out: string, opts: ReadOpts = {}) {
  const gate = opts.gate ?? "lint";
  const wt = makeTestTempDir("tickmarkr-s22-tip-");
  const runDir = join(wt, "run");
  mkdirSync(runDir, { recursive: true });
  stage(wt, out, opts.code ?? 1, opts.delay ?? "0");
  const [result] = await verifyIntegrationTip(wt, { [gate]: "bash run.sh" }, runDir, baseline);
  return result!;
}

async function bothReaders(baseline: Baseline, out: string, opts: ReadOpts = {}) {
  return { battery: (await battery(baseline, out, opts)).result, tip: await tip(baseline, out, opts) };
}

async function expectForgiven(baseline: Baseline, out: string, opts: ReadOpts = {}): Promise<void> {
  const r = await bothReaders(baseline, out, opts);
  expect(r.battery).toMatchObject({ pass: true });
  expect(r.battery.details).toContain("only pre-existing failures (forgiven)");
  expect(r.tip).toMatchObject({ pass: true, forgiven: true });
}

/** Both readers red, and the shared decision names exactly `fresh` as the fresh identities. */
async function expectFresh(baseline: Baseline, out: string, fresh: string[], opts: ReadOpts = {}) {
  const gate = opts.gate ?? "lint";
  expect(freshFailures(baseline.commands[gate], out.split("<cwd>").join("")).failing).toEqual(fresh);
  const r = await bothReaders(baseline, out, opts);
  expect(r.battery.pass).toBe(false);
  for (const f of fresh) expect(r.battery.details).toContain(f);
  expect(r.tip.pass).toBe(false);
  expect(r.tip.forgiven).toBeUndefined();
  return r;
}

const stylish = (label: string, header: string | null, row: string) => JSON.stringify(["stylish", label, header, row]);
const NO_CONSOLE_ROW = "#:# error Unexpected console statement no-console";

/** ESLint 9 stylish bytes: a leading blank line, each absolute file path alone, its indented rows, a blank line. */
function eslint(files: Record<string, string[]>): string {
  const total = Object.values(files).flat().length;
  const blocks = Object.entries(files).map(([file, positions]) =>
    `<cwd>/${file}\n${positions.map((p) => `  ${p.padStart(5)}  error  Unexpected console statement  no-console\n`).join("")}`);
  return `\n${blocks.join("\n")}\n✖ ${total} problem${total === 1 ? "" : "s"} (${total} error${total === 1 ? "" : "s"}, 0 warnings)\n`;
}

beforeEach(() => setCalmWindowForTests({ loadProvider: () => 0 }));
afterEach(() => resetCalmWindowForTests());

describe("S22 · baseline forgiveness keeps counts and identity by closed tables", () => {
  test("the battery and tip verify forgive a v2 fingerprint at most as many times as the capture recorded it so a third identical failure beside two recorded is fresh versus two identical no-console errors in one file rerun at moved lines staying forgiven (S22-F1 P2)", async () => {
    const baseline = await capture(eslint({ "src/a.js": ["1:1", "5:1"] }));
    const tuple = stylish("", "/src/a.js", NO_CONSOLE_ROW);
    // one string per OCCURRENCE: the two identical tuples are both recorded
    expect(baseline.commands.lint).toMatchObject({ exitCode: 1, fingerprintVersion: 2 });
    expect(baseline.commands.lint!.fingerprints.filter((f) => f === tuple)).toHaveLength(2);

    // S22-P2: the same two errors at moved lines stay forgiven in both readers
    await expectForgiven(baseline, eslint({ "src/a.js": ["2:1", "9:1"] }));
    // S22-F1: a third identical error is fresh in both readers (2.7.8's set forgave it)
    const third = await expectFresh(baseline, eslint({ "src/a.js": ["2:1", "9:1", "12:1"] }), [tuple]);
    // the diagnostic keeps the ORIGINAL rows (positions included); the tuple is the secondary key
    expect(third.battery.details).toContain("   12:1  error  Unexpected console statement  no-console");

    // the same multiset rule for a v2 line, not only a stylish tuple
    const lines = await capture("Error: boom in worker\nError: boom in worker\n");
    await expectForgiven(lines, "Error: boom in worker\nError: boom in worker\n");
    await expectFresh(lines, "Error: boom in worker\nError: boom in worker\nError: boom in worker\n", ["Error: boom in worker"]);
  });

  test("a v2 capture keeps every digit outside table T so TestParse2 beside TestParse1 or TS2305 beside TS2304 or a renumbered file or rule id reads fresh in both readers versus changed durations or pids or positions staying forgiven and a fresh timeout-only red at twice the capture's duration buying its one host-starved rerun (S22-F3 F4 F5 F6 P3 P4 P5)", async () => {
    // S22-F3..F6: every token outside table T keeps its digits, so each renumbered identity is fresh
    const before = [
      "--- FAIL: TestParse1 (0.00s)",
      "--- FAIL: Test解析1 (0.00s)",
      "src/a.ts(3,7): error TS2304: Cannot find name 'x'.",
      "FAIL 1ms.js > case",
      "FAIL test-1.js > case",
      "FAIL lib/2026/x.ts > case",
      "lib/a.ts:3:1: error my/no-1ms-timeout",
    ];
    const after = [
      "--- FAIL: TestParse2 (0.00s)",
      "--- FAIL: Test解析2 (0.00s)",
      "src/a.ts(3,7): error TS2305: Cannot find name 'x'.",
      "FAIL 2ms.js > case",
      "FAIL test-2.js > case",
      "FAIL lib/2027/x.ts > case",
      "lib/a.ts:3:1: error my/no-2ms-timeout",
    ];
    const renumbered = await capture(`${before.join("\n")}\n`);
    const renumberedRead = await expectFresh(renumbered, `${after.join("\n")}\n`, [
      "--- FAIL: TestParse2 (<dur>)",
      "--- FAIL: Test解析2 (<dur>)",
      "src/a.ts(#,#): error TS2305: Cannot find name 'x'.",
      "FAIL 2ms.js > case",
      "FAIL test-2.js > case",
      "FAIL lib/2027/x.ts > case",
      "lib/a.ts:#:#: error my/no-2ms-timeout",
    ]);
    for (const line of after) expect(renumberedRead.battery.details).toContain(line);

    // S22-P3..P5: durations, pids, keyed numbers and positions are table T's — changed values stay forgiven
    const volatile = await capture([
      "--- FAIL: TestA (1ms)",
      "--- FAIL: TestB (0.01s)",
      "--- FAIL: TestC took .5 ms",
      "--- FAIL: TestD after 1m0s",
      "--- FAIL: TestE in 3μs",
      "Error: worker pid 12345 exited",
      "Error: child exited pid=1",
      "src/a.ts(12,5): error TS2304: Cannot find name 'x'.",
      "lib/a.ts:12:5: error no-thing",
    ].join("\n") + "\n");
    await expectForgiven(volatile, [
      "--- FAIL: TestA (1.25ms)",
      "--- FAIL: TestB (1s)",
      "--- FAIL: TestC took 1 ms",
      "--- FAIL: TestD after 1h2m3s",
      "--- FAIL: TestE in 4.5µs",
      "Error: worker pid 23456 exited",
      "Error: child exited pid=2",
      "src/a.ts(14,5): error TS2304: Cannot find name 'x'.",
      "lib/a.ts:14:5: error no-thing",
    ].join("\n") + "\n");

    // OBS-896 on a v2 baseline: the comparison key of a fresh timeout reads `<dur>`, but host-starved reads
    // the ORIGINAL line kept beside it, so a timeout-only red at twice the capture's duration buys one rerun…
    const known = "FAIL tests/old.test.ts > known\n";
    const starved = await capture(known, "test");
    expect(starved.commands.test!.durationMs).toBeGreaterThan(0);
    const timeoutOnly = await battery(starved, `${known}Error: Test timed out in 5000ms.\n`, { gate: "test", delay: "1.5" });
    expect(timeoutOnly.result.pass).toBe(false);
    expect(timeoutOnly.result.meta?.hostStarvedRerun).toBeDefined();
    expect(timeoutOnly.result.details).toContain("host-starved rerun");
    expect(timeoutOnly.calls).toBe(2);
    expect(timeoutOnly.result.details).toContain("Error: Test timed out in 5000ms.");
    // …and a timeout beside a fresh assertion stays charged with no rerun
    const mixed = await battery(starved, `${known}Error: Test timed out in 5000ms.\nAssertionError: expected 1 to be 2\n`, { gate: "test", delay: "1.5" });
    expect(mixed.result.pass).toBe(false);
    expect(mixed.result.meta?.hostStarvedRerun).toBeUndefined();
    expect(mixed.calls).toBe(1);
  });

  test("in both readers a stylish row fingerprints with its proven block header so the same rule in a new file is fresh and a row under a glued banner or blank or help line or beside an unlabelled header is never forgiven versus moved eslint oxlint or interleaved turbo rows staying forgiven (S22-F7 F8 F9 F10 F11 P6 P7 P13)", async () => {
    // S22-F7: the same rule in a NEW file beside a two-problem baseline, plural totals equal
    const owned = await capture(eslint({ "src/a.js": ["1:1", "3:1"] }));
    await expectFresh(owned, eslint({ "src/a.js": ["1:1"], "src/c.js": ["1:1"] }), [stylish("", "/src/c.js", NO_CONSOLE_ROW)]);

    // S22-F8..F11: rows outside every proven block are written with a null header and never forgiven,
    // even rerun byte-identically against their own capture
    const ROW = (p: string) => `  ${p}  error  Unexpected console statement  no-console\n`;
    const unattributed = stylish("", null, NO_CONSOLE_ROW);
    const unproven = {
      F8_glued_banner: `Linting project\n<cwd>/src/a.js\n${ROW("1:1")}`,
      F9_blank_after_header: `\n<cwd>/src/a.js\n\n${ROW("1:1")}`,
      F10_help_line_in_block: `\n<cwd>/src/a.js\n${ROW("1:1")}  help: Delete this console statement\n${ROW("4:1")}`,
      F11_unlabelled_headers: `\n<cwd>/src/a.js\n<cwd>/src/b.js\n${ROW("1:1")}${ROW("2:1")}`,
    };
    for (const out of Object.values(unproven)) {
      const baseline = await capture(out);
      expect(baseline.commands.lint!.fingerprints).toContain(unattributed);
      await expectFresh(baseline, out, [unattributed]);
    }

    // S22-P6: ESLint stylish, two files, the same rule in each, moved lines
    const two = await capture(eslint({ "src/a.js": ["1:1"], "src/b.js": ["2:5"] }));
    expect(two.commands.lint!.fingerprints).toEqual(expect.arrayContaining([stylish("", "/src/a.js", NO_CONSOLE_ROW), stylish("", "/src/b.js", NO_CONSOLE_ROW)]));
    await expectForgiven(two, eslint({ "src/a.js": ["3:1"], "src/b.js": ["7:5"] }));

    // S22-P7: the labelled, interleaved turbo bytes, rerun with moved and re-aligned positions
    const turbo = (a1: string, a2: string) => [
      "alpha:lint:",
      "alpha:lint: <cwd>/packages/alpha/a.js",
      "beta:lint:",
      `alpha:lint: ${a1}   error  Unexpected console statement  no-console`,
      "beta:lint: <cwd>/packages/beta/b.js",
      `alpha:lint: ${a2}   error  Unexpected console statement  no-console`,
      "beta:lint:    2:5   error  Unexpected console statement  no-console",
      "alpha:lint:",
      "beta:lint:",
      "alpha:lint: ✖ 2 problems (2 errors, 0 warnings)",
      "beta:lint: ✖ 1 problem (1 error, 0 warnings)",
    ].join("\n") + "\n";
    const interleaved = await capture(turbo("   1:1", "  12:3"));
    const alpha = stylish("alpha:lint", "/packages/alpha/a.js", NO_CONSOLE_ROW);
    const beta = stylish("beta:lint", "/packages/beta/b.js", NO_CONSOLE_ROW);
    expect(interleaved.commands.lint!.fingerprints.filter((f) => f === alpha)).toHaveLength(2);
    expect(interleaved.commands.lint!.fingerprints.filter((f) => f === beta)).toHaveLength(1);
    await expectForgiven(interleaved, turbo("   3:1", "  14:3"));

    // S22-P13: oxlint 1.74 `--format stylish` bytes as captured (forced ANSI, a blank line before every
    // absolute header path under the cwd), rerun with moved lines
    const ox = (a: string[], b: string[]) => {
      const row = (p: string) => `  \x1b[2m${p}\x1b[0m  \x1b[31merror\x1b[0m  Unexpected console statement.  \x1b[2meslint(no-console)\x1b[0m\n`;
      return `\n\x1b[4m<cwd>/src/a.js\x1b[0m\n${a.map(row).join("")}\n\x1b[4m<cwd>/src/b.js\x1b[0m\n${b.map(row).join("")}\n\x1b[31m✖ 3 problems (3 errors, 0 warnings)\x1b[0m\n`;
    };
    const oxlint = await capture(ox(["1:1", "3:1"], ["2:1"]));
    expect(oxlint.commands.lint!.fingerprints).toContain(stylish("", "/src/b.js", "#:# error Unexpected console statement. eslint(no-console)"));
    expect(oxlint.commands.lint!.fingerprints).not.toContain(stylish("", null, "#:# error Unexpected console statement. eslint(no-console)"));
    await expectForgiven(oxlint, ox(["2:1", "5:1"], ["4:1"]));
  });

  test("a missing entry forgives nothing so unrecognized exit 1 output reads red naming no baseline entry in the battery and at the tip and a fingerprintVersion 3 or non-string fingerprint reads red naming the entry unreadable even beside heading-only output without throwing or inventing a fresh fingerprint versus a missing entry exiting 0 staying green (S22-F2 F13 F12 P8)", async () => {
    // S22-F2 / F13: a resume added the `check` command, so the captured baseline holds no entry for it
    const baseline = await capture("FAIL tests/a.test.ts > known\n");
    expect(baseline.commands.check).toBeUndefined();
    const prose = "something went wrong while checking\n";
    expect(freshFailures(undefined, prose)).toMatchObject({ state: "missing", failing: [], forgiven: [], baselineRed: false });
    const missing = await bothReaders(baseline, prose, { gate: "check" });
    expect(missing.battery.pass).toBe(false);
    expect(missing.battery.details).toContain("no baseline entry for check");
    expect(missing.battery.meta?.freshFingerprints).toBeUndefined();
    expect(missing.tip.pass).toBe(false);
    expect(missing.tip.details).toContain("no baseline entry for check");
    // …and beside an infra classification, the reason still renders in both readers
    const eagain = await bothReaders(baseline, "Error: spawn EAGAIN\n", { gate: "check" });
    expect(eagain.battery).toMatchObject({ pass: false, meta: { classification: "infra" } });
    expect(eagain.battery.details).toContain("no baseline entry for check");
    expect(eagain.tip).toMatchObject({ pass: false, cause: "infra" });
    expect(eagain.tip.details).toContain("no baseline entry for check");

    // S22-P8: a missing entry exiting 0 stays green in both readers
    const green = await bothReaders(baseline, "all good\n", { gate: "check", code: 0 });
    expect(green.battery).toMatchObject({ pass: true, details: "exit 0" });
    expect(green.tip).toMatchObject({ pass: true, details: "exit 0" });

    // S22-F12: a fingerprintVersion 3 entry or a non-string fingerprint is unreadable — red with the reason,
    // never thrown, and beside heading-only output (OBS-42: no fresh fingerprint at all) still red
    const heading = "⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯\n";
    const captured = await capture(heading);
    const entry = captured.commands.lint!;
    expect(entry).toMatchObject({ exitCode: 1, fingerprintVersion: 2 });
    await expectForgiven(captured, heading);
    const unreadable: Array<[BaselineCommand, string]> = [
      [{ ...entry, fingerprintVersion: 3 }, "baseline entry for lint is unreadable (fingerprintVersion 3 is not 2)"],
      [{ ...entry, fingerprints: [...entry.fingerprints, 42 as unknown as string] }, "baseline entry for lint is unreadable (fingerprints is not an array of strings)"],
    ];
    for (const [bad, reason] of unreadable) {
      expect(() => freshFailures(bad, heading)).not.toThrow();
      expect(freshFailures(bad, heading)).toMatchObject({ state: "unreadable", failing: [], baselineRed: false });
      const r = await bothReaders({ commands: { lint: bad } }, heading);
      expect(r.battery.pass).toBe(false);
      expect(r.battery.details).toContain(reason);
      expect(r.battery.meta?.freshFingerprints).toBeUndefined();
      expect(r.tip.pass).toBe(false);
      expect(r.tip.details).toContain(reason);
      // beside a file-count deficit or an infra classification, both readers still name the unreadable entry
      for (const [out, entryOf] of [[" Test Files  1 passed (1)\n", { ...bad, fileCount: 4 }], ["Error: spawn EAGAIN\n", bad]] as const) {
        const other = await bothReaders({ commands: { lint: entryOf } }, out);
        expect(other.battery.pass).toBe(false);
        expect(other.battery.details).toContain(reason);
        expect(other.tip.pass).toBe(false);
        expect(other.tip.details).toContain(reason);
      }
    }
  });

  test("a legacy entry without a version or exit code or an identical rerun or a recognized line holding the cwd stays forgiven in both readers while unrecognized cwd-stripped prose is forgiven by the battery alone and stays red at the tip versus a v2 capture reading TestParse2 fresh beside TestParse1 (S22-P9 P10 P1 P12 P11)", async () => {
    // A legacy entry is what 2.7.8 wrote for the same real capture: no fingerprintVersion, the
    // deduplicated all-digit-masked set (`fingerprint`).
    const legacyOf = (captured: Baseline, out: string, dropExitCode = false): Baseline => {
      const entry: BaselineCommand = { ...captured.commands.lint!, fingerprints: fingerprint(out.split("<cwd>").join("")) };
      delete entry.fingerprintVersion;
      if (dropExitCode) delete entry.exitCode;
      return { commands: { lint: entry } };
    };

    // S22-P9: a legacy entry holding `FAIL … > TestParse#`, rerun identically — set semantics and the
    // all-digit mask, unchanged (TestParse2 still collides there)…
    const parse1 = "FAIL tests/parse.test.ts > TestParse1\n";
    const parse2 = "FAIL tests/parse.test.ts > TestParse2\n";
    const v2 = await capture(parse1);
    const legacy = legacyOf(v2, parse1);
    expect(legacy.commands.lint!.fingerprints).toEqual(["FAIL tests/parse.test.ts > TestParse#"]);
    expect(freshFailures(legacy.commands.lint, parse1).state).toBe("legacy");
    await expectForgiven(legacy, parse1);
    await expectForgiven(legacy, parse2);
    // …versus the v2 capture of the same bytes, which reads TestParse2 fresh
    await expectFresh(v2, parse2, ["FAIL tests/parse.test.ts > TestParse2"]);

    // S22-P10: a legacy entry with no exitCode keeps the `?? 1` red default beside its own failures
    const noExit = legacyOf(v2, parse1, true);
    expect(noExit.commands.lint).not.toHaveProperty("exitCode");
    await expectForgiven(noExit, parse1);

    // S22-P1: a v2 red whose every failure line is shaped and every stylish row attributed, rerun byte-identically
    const p1 = `${eslint({ "src/a.js": ["1:1"] })}FAIL tests/a.test.ts > known 2\n`;
    await expectForgiven(await capture(p1), p1);

    // S22-P12: a recognized line holding the cwd is stripped identically in capture and candidate (v2 and legacy)
    const cwdLine = "FAIL <cwd>/t/x.test.ts > a\n";
    const p12 = await capture(cwdLine);
    expect(p12.commands.lint!.fingerprints).toEqual(["FAIL /t/x.test.ts > a"]);
    await expectForgiven(p12, cwdLine);
    await expectForgiven(legacyOf(p12, cwdLine), cwdLine);

    // S22-P11: unrecognized cwd-stripped prose is forgiven by the battery alone; the tip's unreadable
    // rule keeps it red (v2 and legacy alike)
    const prose = "error at <cwd>/src/app-error-boundary.tsx\n";
    const p11 = await capture(prose);
    expect(p11.commands.lint!.fingerprints).toEqual([UNRECOGNIZED_FAILURE]);
    for (const baseline of [p11, legacyOf(p11, prose)]) {
      const r = await bothReaders(baseline, prose);
      expect(r.battery.pass).toBe(true);
      expect(r.battery.details).toContain("no failure shape recognized");
      expect(r.tip.pass).toBe(false);
      expect(r.tip.forgiven).toBeUndefined();
    }
  });
});
