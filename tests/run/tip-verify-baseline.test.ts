import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Baseline } from "../../src/gates/baseline.js";
import { fingerprint } from "../../src/gates/baseline.js";
import { verifyIntegrationTipCached } from "../../src/run/daemon.js";
import type { Journal, JournalEvent } from "../../src/run/journal.js";
import { verifyIntegrationTip } from "../../src/run/merge.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// Q121s (TRIAL T-OBS-1, SentioQ run-1): OBS-34's strict tip verify made a green terminus
// unreachable on any repo whose main carries a pre-existing red, and misattributed that red
// to the last merged task. Tip verify now forgives with the battery's own math; these pin
// the forgiveness AND its fail-closed edges.
const KNOWN = "FAIL tests/known.test.ts > pre-existing red";
const FRESH = "FAIL tests/new.test.ts > introduced by this run";

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
