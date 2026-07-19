import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { report } from "../../src/cli/commands/report.js";
import { Journal } from "../../src/run/journal.js";
import type { TelemetryRow } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

// SPEND-04/06: two orthogonal axes. TOKENS — tokens present ⇒ measured (FLOOR if meteredAttempts <
// attempts), absent ⇒ unmetered (NEVER 0). MONEY — channel "sub" ⇒ subscription (no $ ever), "api" ⇒
// operator price × tokens, no price configured ⇒ `price unset` (never $0.00). The load-bearing case is
// (b): a `sub` row WITH tokens — the ONLY metering adapter is claude (sub), so bucketing on channel
// alone would empty the measured bucket and hide every count Phase 17 collects.
const core = (over: Partial<TelemetryRow> & Pick<TelemetryRow, "adapter" | "model" | "channel" | "attempts">): TelemetryRow =>
  ({ taskId: "T", shape: "implement", outcome: "done", durationMs: 5, ...over });

function repoWithSpendRun(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  const j = Journal.create(repo, "run-spend");
  j.append("run-start", undefined, {}); // open() requires journal.jsonl
  // (a) legacy v1.5 — no tokens ⇒ unmetered
  j.telemetry(core({ adapter: "codex", model: "gpt-5.5-codex", channel: "sub", attempts: 1 }));
  // (b) sub WITH tokens — the claude case the old mapping dropped ⇒ measured + subscription
  j.telemetry(core({ adapter: "claude-code", model: "fable", channel: "sub", attempts: 1, meteredAttempts: 1,
    tokens: { input: 63020, output: 36, cacheRead: 30808, cacheWrite: 41240 } }));
  // (c) FLOOR — 2 of 3 attempts metered
  j.telemetry(core({ adapter: "claude-code", model: "haiku", channel: "sub", attempts: 3, meteredAttempts: 2,
    tokens: { input: 12004, output: 88 } }));
  // (d) absent on a metered-CAPABLE adapter ⇒ unmetered, never 0
  j.telemetry(core({ adapter: "claude-code", model: "sonnet-mini", channel: "sub", attempts: 2 }));
  // (e) api WITH tokens, NO pricing ⇒ measured tokens + `price unset`, never $0.00
  j.telemetry(core({ adapter: "someapi", model: "gpt-x", channel: "api", attempts: 1, meteredAttempts: 1,
    tokens: { input: 10000, output: 2345 } }));
  // (f) api WITHOUT tokens ⇒ unmetered
  j.telemetry(core({ adapter: "someapi", model: "gpt-y", channel: "api", attempts: 1 }));
  return repo;
}

// SC-3 / GROK-03 end-to-end (W2): a grok telemetry row with NO tokens (collectUsage deliberately
// absent) must render `unmetered (adapter reports no usage)` — by construction, never an implicit 0
// (the SPEND-11 scar made concrete). Separate repo so it cannot perturb the two-axis pin above.
function repoWithGrokUnmeteredRun(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  const j = Journal.create(repo, "run-grok-unmetered");
  j.append("run-start", undefined, {});
  j.telemetry(core({ adapter: "grok", model: "grok-4.5", channel: "sub", attempts: 1 }));
  return repo;
}

describe("tickmarkr report — two-axis spend (SPEND-04/06)", () => {
  test("tokens axis measured/unmetered · money axis subscription/api — no fabricated $ or 0", async () => {
    const out = await report(["run-spend"], repoWithSpendRun());

    // POSITIVE (vacuity twins — a report that prints nothing FAILS these)
    expect(out).toMatch(/measured/);
    expect(out).toMatch(/unmetered/);
    expect(out).toMatch(/subscription/);
    // measured section non-empty — a `sub` row's tokens MUST reach the measured axis (the bucketing bug)
    expect(out).toContain("63,020");
    // floor rendered as a floor, not an exact figure
    expect(out).toContain("2/3 attempts metered");
    expect(out).toMatch(/≥[^\n]*12,004/);
    // api tokens surface on the tokens axis (per-field + group total)
    expect(out).toContain("12,345"); // 10,000 + 2,345 group total
    expect(out).toContain("10,000");
    expect(out).toContain("2,345");
    // api money line renders price unset, not a dollar figure
    expect(out).toContain("price unset");
    // unmetered rows named on the tokens axis
    expect(out).toMatch(/codex:gpt-5\.5-codex[^\n]*unmetered/);
    expect(out).toMatch(/claude-code:sonnet-mini[^\n]*unmetered/);
    expect(out).toMatch(/someapi:gpt-y[^\n]*unmetered/);

    // NEGATIVE (each has a positive twin above ⇒ can't pass vacuously)
    expect(out).not.toMatch(/\$/); // zero operator prices ⇒ no $ anywhere (SPEND-06 sub-never-dollars)
    expect(out).not.toMatch(/NaN/);
    expect(out).not.toMatch(/undefined/);
    expect(out).not.toMatch(/\b0 tokens/);
    // no mixed grand total: the `?? 0` bug sums absent-as-0 (135104 + 12092 + 12345 = 159,541)
    expect(out).not.toContain("159,541");
    expect(out).not.toContain("159541");
  });
});

describe("SC-3 / GROK-03 — grok telemetry with no tokens renders unmetered, never 0 (W2)", () => {
  test("a grok row with NO tokens ⇒ `unmetered (adapter reports no usage)`, never a `0 tokens`", async () => {
    const out = await report(["run-grok-unmetered"], repoWithGrokUnmeteredRun());
    expect(out).toMatch(/grok:grok-4\.5[^\n]*unmetered/);
    expect(out).toMatch(/adapter reports no usage/);
    // the SPEND-11 scar: absent must NEVER materialize as a fabricated zero
    expect(out).not.toMatch(/grok:grok-4\.5[^\n]*0 tokens/);
    expect(out).not.toMatch(/\b0 tokens/);
  });
});

describe("report.ts source pins — the `?? 0` and estimate-basis rules", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/cli/commands/report.ts", import.meta.url)), "utf8");

  test("no `?? 0`; rendered estimates retain a basis", () => {
    expect(src).not.toMatch(/\?\?\s*0/); // absent ⇒ unmetered, never 0
    expect(src).toMatch(/estimateCosts/);
    expect(src).toMatch(/basis:/);
    expect(src).toMatch(/not measurable/);
    // vacuity guards: a moved/empty file reddens rather than greens the pins above
    expect(src).toMatch(/readTelemetry/);
    expect(src.length).toBeGreaterThan(500);
  });
});
