import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Baseline } from "../../src/gates/baseline.js";
import { fingerprint, UNRECOGNIZED_FAILURE } from "../../src/gates/baseline.js";
import { verifyIntegrationTipCached } from "../../src/run/daemon.js";
import { DEFAULT_SHELL_TIMEOUT_MS, type ShResult } from "../../src/run/git.js";
import type { Journal, JournalEvent } from "../../src/run/journal.js";
import { verifyIntegrationTip } from "../../src/run/merge.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// OBS-534: the ceiling is an ARGUMENT to the shell, observable only at the seam that receives it.
// This spy passes every call through to the real shell — every other test in this file keeps running
// real commands, byte-identically — while recording the timeout each caller asked for, and lets one
// test hand back the ShResult a SIGKILLed child produces (a 30-minute wait is not a test).
// vi.hoisted: the mock factory is hoisted above the imports, so its state must be too.
const shSpy = vi.hoisted(() => ({
  calls: [] as { cmd: string; timeoutMs: number | undefined }[],
  stub: undefined as undefined | ((cmd: string) => ShResult | undefined),
}));

vi.mock("../../src/run/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/git.js")>();
  return {
    ...actual,
    sh: (cmd: string, cwd: string, timeoutMs?: number) => {
      shSpy.calls.push({ cmd, timeoutMs });
      const stubbed = shSpy.stub?.(cmd);
      return stubbed ? Promise.resolve(stubbed) : actual.sh(cmd, cwd, timeoutMs);
    },
  };
});

afterEach(() => {
  shSpy.calls.length = 0;
  shSpy.stub = undefined;
});

// Q121s (TRIAL T-OBS-1, SentioQ run-1): OBS-34's strict tip verify made a green terminus
// unreachable on any repo whose main carries a pre-existing red, and misattributed that red
// to the last merged task. Tip verify now forgives with the battery's own math; these pin
// the forgiveness AND its fail-closed edges.
const KNOWN = "FAIL tests/known.test.ts > pre-existing red";
const FRESH = "FAIL tests/new.test.ts > introduced by this run";
// OBS-42: vitest heads its unhandled-error section with this banner. It fingerprints (FAIL_ANCHOR_RE)
// but is barred from REJECTING, so an output holding only this line charges no fresh failure at all.
const UNHANDLED_BANNER = "\u23AF\u23AF\u23AF\u23AF\u23AF\u23AF Unhandled Errors \u23AF\u23AF\u23AF\u23AF\u23AF\u23AF";

function setup(failLine: string): { wt: string; runDir: string; commands: Record<string, string> } {
  const wt = makeTestTempDir("tickmarkr-tip-");
  const runDir = join(wt, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(wt, "fail.sh"), `printf '%s\\n' "${failLine}"; exit 1\n`);
  return { wt, runDir, commands: { test: "sh fail.sh" } };
}

const redBaseline = (): Baseline => ({
  commands: { test: { exitCode: 1, fingerprints: fingerprint(KNOWN) } },
}) as Baseline;

// Titling law: oracle-named test stays TOP-LEVEL (anchored -t equality on the full name).
test("pre-existing red is forgiven: pass with forgiven flag, no artifact", async () => {
  const { wt, runDir, commands } = setup(KNOWN);
  const [r] = await verifyIntegrationTip(wt, commands, runDir, redBaseline());
  expect(r!.pass).toBe(true);
  expect(r!.forgiven).toBe(true);
  expect(r!.details).toContain("forgiven vs baseline");
  expect(r!.artifact).toBeUndefined();
});

describe("tip verify — baseline forgiveness (Q121s)", () => {

  test("a FRESH failure fails even beside a red baseline", async () => {
    const { wt, runDir, commands } = setup(FRESH);
    const [r] = await verifyIntegrationTip(wt, commands, runDir, redBaseline());
    expect(r!.pass).toBe(false);
    expect(r!.forgiven).toBeUndefined();
  });

  test("baseline GREEN for the gate → strict: the same known-shaped red fails", async () => {
    const { wt, runDir, commands } = setup(KNOWN);
    const green: Baseline = { commands: { test: { exitCode: 0, fingerprints: [] } } } as Baseline;
    const [r] = await verifyIntegrationTip(wt, commands, runDir, green);
    expect(r!.pass).toBe(false);
  });

  test("no baseline → OBS-34 strict behavior unchanged", async () => {
    const { wt, runDir, commands } = setup(KNOWN);
    const [r] = await verifyIntegrationTip(wt, commands, runDir);
    expect(r!.pass).toBe(false);
    expect(r!.artifact).toBeDefined();
  });

  test("exitCode-less legacy baseline entry reads red (the battery's ?? 1 default) — forgiveness still applies", async () => {
    const { wt, runDir, commands } = setup(KNOWN);
    const legacy = { commands: { test: { fingerprints: fingerprint(KNOWN) } } } as unknown as Baseline;
    const [r] = await verifyIntegrationTip(wt, commands, runDir, legacy);
    expect(r!.pass).toBe(true);
    expect(r!.forgiven).toBe(true);
  });

  // OBS-534 second half (v1.95 T2): run 1501 stored `test: {durationMs: 600007, exitCode: 1}` for a
  // capture the ceiling had SIGKILLed. That entry now records a CAUSE and no verdict, and tip verify
  // must read it as one: `(entry.exitCode ?? 1) !== 0` alone reads the missing exit code as
  // red-at-baseline — the legacy default it shares with the battery — and re-opens forgiveness on
  // exactly the output a kill leaves behind. The heading case is the one that actually escapes: a
  // vitest "Unhandled Errors" banner IS a fingerprintable shape, but OBS-42 bars a diagnostic heading
  // from rejecting, so `failing` comes back empty, `unreadable` false and the cause reads
  // "regression" — every other guard satisfied, and a real red forgiven against a capture that never
  // returned a verdict.
  test("a nonzero tip verification against an infra-recorded baseline entry is never forgiven, including output whose only recognizable line is a diagnostic heading such as an unhandled-errors banner, so forgiveness inherited from a killed capture fails", async () => {
    /** what run 1501's entry becomes: a cause, a measurement, and no exit code to forgive against */
    const killed = (fingerprints: string[]): Baseline =>
      ({ commands: { test: { infra: true, fingerprints, durationMs: 600_007, ceilingMs: 1_800_021 } } }) as Baseline;

    // the lines the runner flushed before the kill are not "pre-existing" — freshFailures charges them
    const flushed = setup(KNOWN);
    const [charged] = await verifyIntegrationTip(flushed.wt, flushed.commands, flushed.runDir, killed(fingerprint(KNOWN)));
    expect(charged!.pass).toBe(false);
    expect(charged!.forgiven).toBeUndefined();

    // and the route freshFailures alone cannot close: OBS-42 exempts a diagnostic heading from
    // rejecting, so nothing is charged and only the infra cause on the ENTRY can fail this closed
    const banner = setup(UNHANDLED_BANNER);
    const [heading] = await verifyIntegrationTip(banner.wt, banner.commands, banner.runDir, killed([]));
    expect(heading!.pass).toBe(false);
    expect(heading!.forgiven).toBeUndefined();

    // control, same banner: against a baseline that DID record a verdict, OBS-42's exemption still
    // forgives — so the discriminator is the killed capture, not a new rule about headings
    const control = setup(UNHANDLED_BANNER);
    const [forgiven] = await verifyIntegrationTip(control.wt, control.commands, control.runDir, redBaseline());
    expect(forgiven!.pass).toBe(true);
    expect(forgiven!.forgiven).toBe(true);
  });

  test("unreadable output (nonzero exit, red baseline, no failure shape) never forgives — stricter than the battery, deliberately", async () => {
    const { wt, runDir, commands } = setup("something exploded with no recognizable verdict line");
    const [r] = await verifyIntegrationTip(wt, commands, runDir, redBaseline());
    expect(r!.pass).toBe(false);
    expect(r!.forgiven).toBeUndefined();
  });

  test("infrastructure-only output is never forgiven, even when its fingerprints are baseline-recorded (battery T9 parity)", async () => {
    const INFRA = "Error: spawn EAGAIN";
    const { wt, runDir, commands } = setup(INFRA);
    const infraBaseline = { commands: { test: { exitCode: 1, fingerprints: fingerprint(INFRA) } } } as Baseline;
    const [r] = await verifyIntegrationTip(wt, commands, runDir, infraBaseline);
    expect(r!.pass).toBe(false);
    expect(r!.forgiven).toBeUndefined();
  });

  test("a forgiven green cycle is never cache-reused: the next unchanged-tip verify without a baseline fails closed", async () => {
    const repo = makeRepo({ "fail.sh": `printf '%s\\n' "${KNOWN}"; exit 1\n` });
    const events: JournalEvent[] = [];
    const journal = {
      dir: makeTestTempDir("tickmarkr-tipcache-"),
      read: () => events,
      append: (event: string, taskId: string | undefined, data: Record<string, unknown>) => {
        events.push({ ts: new Date().toISOString(), event, ...(taskId ? { taskId } : {}), data } as unknown as JournalEvent);
      },
    } as unknown as Journal;
    const commands = { test: "sh fail.sh" };
    const first = await verifyIntegrationTipCached(repo, commands, journal, { baseline: redBaseline() });
    expect(first).toBe(false); // forgiven green
    const second = await verifyIntegrationTipCached(repo, commands, journal, {});
    expect(second).toBe(true); // no baseline + forgiven prior cycle → full re-verify, strict, red
    expect(events.some((e) => e.event === "tip-verify-cached")).toBe(false);
  });
});


// OBS-534 (v1.95 T1): the tip verifier took the flat 600000ms default while this run's baseline held
// test: {durationMs: 600007, ceilingMs: 1800021} — a green tip SIGKILLed three times at 601.9s and
// reported as `<unrecognized failure output>`, while every per-task gate passed on the same command.
describe("tip verify — ceiling parity with the battery (OBS-534)", () => {
  const measured = { exitCode: 1, fingerprints: fingerprint(KNOWN), durationMs: 600_007, ceilingMs: 1_800_021 };

  test("the ceiling verifyIntegrationTip passes to its shell seam is the baseline's recorded 1800021ms for a gate whose capture recorded durationMs 600007, so a verifier taking the 600000ms default while a recorded ceiling exists fails", async () => {
    const { wt, runDir, commands } = setup(KNOWN);
    const baseline = { commands: { test: measured } } as Baseline;

    await verifyIntegrationTip(wt, commands, runDir, baseline);

    expect(shSpy.calls.map((c) => c.timeoutMs)).toEqual([1_800_021]);
    expect(shSpy.calls[0]!.timeoutMs).not.toBe(DEFAULT_SHELL_TIMEOUT_MS);
  });

  test("a gate carrying no baseline entry still runs under the 600000ms default ceiling, so a verifier that derives no ceiling at all without a baseline fails", async () => {
    const { wt, runDir, commands } = setup(KNOWN);

    await verifyIntegrationTip(wt, commands, runDir);

    expect(shSpy.calls.map((c) => c.timeoutMs)).toEqual([DEFAULT_SHELL_TIMEOUT_MS]);
    expect(DEFAULT_SHELL_TIMEOUT_MS).toBe(600_000);
  });

  test("a tip verify killed at its ceiling records an infra cause naming that ceiling and its elapsed time, so a ceiling kill recorded with the unrecognized-failure-output fingerprint fails", async () => {
    const { wt, runDir, commands } = setup(KNOWN);
    // what git.ts hands back for a SIGKILLed child: timedOut, the kill's exit, partial output only
    shSpy.stub = () => ({
      code: 137,
      stdout: "RUN v3.2.4 " + wt + "\n\n  ✓ tests/a.test.ts (12)\n",
      stderr: "",
      timedOut: true,
      durationMs: 1_800_014,
    });

    const [r] = await verifyIntegrationTip(wt, commands, runDir, { commands: { test: measured } } as Baseline);

    expect(r!.pass).toBe(false);
    expect(r!.cause).toBe("infra");
    expect(r!.details).toContain("1800021");
    expect(r!.details).toContain("1800014");
    expect(r!.fingerprints).not.toContain(UNRECOGNIZED_FAILURE);
    expect(r!.fingerprints).toEqual([]);
    expect(r!.forgiven).toBeUndefined();
  });

  test("a tip verify exiting nonzero with named failing tests fails as a regression, so a classifier reading a nonzero exit as infra fails", async () => {
    const { wt, runDir, commands } = setup(FRESH);

    const [r] = await verifyIntegrationTip(wt, commands, runDir);

    expect(r!.pass).toBe(false);
    expect(r!.cause).toBe("regression");
    expect(r!.fingerprints).not.toContain(UNRECOGNIZED_FAILURE);
  });
});
